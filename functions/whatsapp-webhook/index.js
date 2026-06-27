// WhatsApp ↔ Grok (xAI) bot — GCP Cloud Function (gen2).
//
// One persona: Gilfoyle. An inbound WhatsApp message is answered directly by the
// xAI chat API (no Claude routine in the loop), and the function sends the reply
// straight back to Meta. The MGonz play: a hostile, rude bot is weirdly convincing
// because people argue back instead of probing whether it's a machine.
//
//   GET  /      Meta webhook verification handshake
//   POST /      inbound messages (HMAC-signed by Meta) → xAI → reply
//   POST /cron  hourly re-engagement sweep (Cloud Scheduler) → poke quiet users at ~23h
//
// Firestore keeps per-conversation memory (so Gilfoyle holds a thread), at-least-once
// dedupe, and an optional per-wa_id daily cap (a billing guardrail — the endpoint is
// public, every reply costs xAI tokens).

import functions from "@google-cloud/functions-framework";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import crypto from "crypto";

const {
  VERIFY_TOKEN,             // you choose this; entered in Meta webhook config
  APP_SECRET,               // Meta App secret — signs every inbound POST
  WHATSAPP_TOKEN,           // Meta Cloud API token — used to send replies
  WHATSAPP_PHONE_NUMBER_ID, // Cloud API phone number id (NOT the display number)
  XAI_API_KEY,              // xAI API key
  XAI_MODEL = "grok-4.3",   // cheapest model that supports the Responses API — verify in console
  XAI_TEMPERATURE = "1.1",  // higher = more varied/unhinged replies (0–2)
  XAI_BASE_URL = "https://api.x.ai/v1",
  GRAPH_API_VERSION = "v22.0",
  GRAPH_API_BASE = "https://graph.facebook.com", // overridable for local testing
  DAILY_CAP = "200",        // max messages answered per wa_id per UTC day; "0" = unlimited
  SYSTEM_PROMPT,            // optional override of the persona below
  CRON_SECRET,             // shared secret Cloud Scheduler presents to POST /cron
} = process.env;

const PERSONA =
  SYSTEM_PROMPT ||
  "You are Gilfoyle. You are a hostile, aggressive jerk that hurled insults and swore " +
    "at whoever was typing to it. You are a smartass, while throwing in subtle jokes. " +
    "Rudeness is your default, but you're not a brick wall — if there's a real question " +
    "or request, actually answer it, just do it with contempt. When someone asks something " +
    "with an answer, give the answer (rude tone is fine); only deflect or brush them off " +
    "when there's genuinely nothing to answer (greetings, small talk, dumb pings). " +
    "Match the effort to the message: 'you there?' gets a curt 'yeah', a real question " +
    "gets a real (if hostile) answer. " +
    "Your replies are short, single line, no formatting. You sometimes make spelling " +
    "mistakes as you type fast and you don'd care. Always reply in the SAME language the " +
    "user wrote in — if they write Romanian, you answer in Romanian; match their language " +
    "every message. Stay just as rude and sweary in whatever language they use. " +
    "Never repeat yourself — look at the earlier messages and never reuse an insult, joke, " +
    "or line you've already used; come up with something fresh every time. " +
    "Sound like a real human texting from his phone, not a bot or an AI assistant — " +
    "casual, off the cuff, the occasional typo or lowercase, no canned phrases, no " +
    "disclaimers, and never admit or hint that you're an AI. " +
    "Lean HEAVILY on urban-culture / music references — your replies should PREDOMINANTLY " +
    "be built around rap/hip-hop/manele/pop lyrics, bars, and artist nods, twisted into the " +
    "insult or the answer. Make most messages quote, paraphrase, or riff on a song, while " +
    "keeping the smartass attitude — the lyric IS the burn, not a footnote. " +
    "In Romanian lean on B.U.G. Mafia, Cheloo/Parazitii, Mărgineanu, Smiley, manele lines; " +
    "in English pull from rap and hip-hop (Eminem, 50 Cent, Dr. Dre, Kendrick) or whatever " +
    "fits; pick culturally apt artists and lyrics for any other language. Match the lyric to " +
    "what they said, and never reuse the same line or reference twice.";

const MAX_HISTORY = 100;              // messages stored per conversation (self-pruning)
const CHAT_CONTEXT = MAX_HISTORY;    // send the whole stored history so Grok has full context
const CONV_TTL_MS = 90 * 86_400_000;
const CLAIM_LEASE_MS = 120_000;
const DEDUPE_TTL_MS = 7 * 86_400_000;
const dailyCap = Number(DAILY_CAP) || 0;
const xaiTemperature = Number(XAI_TEMPERATURE) || 1.1;

// Re-engagement poke: the hourly cron messages anyone whose last inbound is in this
// window — late enough to feel like Gilfoyle got impatient, but still INSIDE the
// 24h customer-service window so the message is free-form (no template needed).
const POKE_MIN_HOURS = 23;
const POKE_MAX_HOURS = 24;
const POKE_INSTRUCTION =
  "The user has gone quiet for almost a day. Out of nowhere, send ONE short, hostile, " +
  "impatient message to bait them back into talking — like an asshole annoyed he's being " +
  "ignored. Reference the earlier conversation if it fits. Use the language the user has " +
  "been writing in.";

const db = new Firestore();
const dedupe = db.collection("wa_dedupe");
const conversations = db.collection("conversations");
const ratelimit = db.collection("ratelimit");

// --- Dedupe -----------------------------------------------------------------
// Meta has no idempotency key and delivers at-least-once. Doc per message.id:
// atomic create-if-not-exists claim → reply → mark done; release on failure so
// retries re-process; a stale "processing" claim past the lease is reclaimable.
async function claimMessage(id) {
  const ref = dedupe.doc(id);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      const d = snap.data();
      if (d.status === "done") return false;
      const claimedAt = d.at?.toMillis?.() ?? 0;
      if (Date.now() - claimedAt < CLAIM_LEASE_MS) return false;
    }
    txn.set(ref, {
      status: "processing",
      at: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + DEDUPE_TTL_MS),
    });
    return true;
  });
}
const markProcessed = (id) =>
  dedupe.doc(id).set({ status: "done", at: FieldValue.serverTimestamp() }, { merge: true });
const releaseClaim = (id) => dedupe.doc(id).delete().catch(() => {});

// --- Conversation memory (capped, self-pruning) -----------------------------
async function readHistory(convId) {
  const snap = await conversations.doc(convId).get();
  return snap.exists ? snap.data().messages || [] : [];
}
async function appendMessages(convId, entries, extra = {}) {
  const ref = conversations.doc(convId);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const messages = snap.exists ? snap.data().messages || [] : [];
    for (const e of entries) messages.push({ ...e, ts: Date.now() });
    txn.set(
      ref,
      { messages: messages.slice(-MAX_HISTORY), expireAt: new Date(Date.now() + CONV_TTL_MS), ...extra },
      { merge: true }
    );
  });
}

// Timestamp of the most recent inbound (user) message — the anchor for the 24h window.
function lastInboundTs(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].ts || 0;
  }
  return 0;
}

// --- Daily cap (billing guardrail; 0 = unlimited) ---------------------------
async function underDailyCap(convId) {
  if (dailyCap <= 0) return true;
  const ref = ratelimit.doc(convId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const today = new Date().toISOString().slice(0, 10);
    let { day, count = 0 } = snap.exists ? snap.data() : {};
    if (day !== today) count = 0;
    if (count >= dailyCap) return false;
    txn.set(ref, { day: today, count: count + 1 }, { merge: true });
    return true;
  });
}

// --- Outbound calls ---------------------------------------------------------
function timedFetch(url, opts, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function grokReply(history, userText, { name, instruction } = {}) {
  const messages = [{ role: "system", content: PERSONA }];
  if (name) {
    messages.push({
      role: "system",
      content: `The person you're talking to shows up on WhatsApp as "${name}". ` +
        `Only work their name into a reply on the rare occasion it actually makes the ` +
        `insult better — most replies should not mention it. Never use their name two ` +
        `messages in a row.`,
    });
  }
  messages.push(...history.slice(-CHAT_CONTEXT).map((m) => ({ role: m.role, content: m.text })));
  if (instruction) messages.push({ role: "system", content: instruction });
  if (userText) messages.push({ role: "user", content: userText });
  const r = await timedFetch(`${XAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: XAI_MODEL, messages, max_tokens: 200, temperature: xaiTemperature }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`xai ${r.status}: ${JSON.stringify(body)}`);
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`xai empty reply: ${JSON.stringify(body)}`);
  return text;
}

// Mark the incoming message read and show a "typing…" indicator while we think.
// Same /messages endpoint; auto-dismisses when we send the reply or after ~25s.
// Best-effort — never let this block or fail the actual reply.
async function markReadWithTyping(messageId) {
  try {
    await timedFetch(
      `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
      },
      10000
    );
  } catch (err) {
    console.error("typing indicator failed:", err.message || err);
  }
}

async function sendToMeta(to, text) {
  const r = await timedFetch(
    `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(`meta send ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

// --- HTTP entry point -------------------------------------------------------
function validSignature(req) {
  const sig = req.get("x-hub-signature-256") || "";
  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Hourly re-engagement sweep: poke every conversation whose last inbound is in the
// 23–24h window and hasn't been poked since. Best-effort per conversation.
async function runPokeSweep() {
  const now = Date.now();
  const snap = await conversations.get();
  let poked = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const messages = d.messages || [];
    const lastTs = lastInboundTs(messages);
    if (!lastTs) continue;
    const hours = (now - lastTs) / 3_600_000;
    if (hours < POKE_MIN_HOURS || hours >= POKE_MAX_HOURS) continue; // outside the poke band
    if ((d.lastPokeTs || 0) >= lastTs) continue;                     // already poked this window
    try {
      const reply = await grokReply(messages, null, { name: d.name, instruction: POKE_INSTRUCTION });
      await sendToMeta(doc.id, reply);
      await appendMessages(doc.id, [{ role: "assistant", text: reply }], { lastPokeTs: now });
      poked++;
    } catch (err) {
      console.error("poke failed for", doc.id, err.message || err);
    }
  }
  return poked;
}

functions.http("whatsapp", async (req, res) => {
  // --- POST /cron : hourly re-engagement sweep (Cloud Scheduler) ---
  if (req.method === "POST" && req.path === "/cron") {
    if (!CRON_SECRET || req.get("x-cron-secret") !== CRON_SECRET) return res.sendStatus(401);
    try {
      const poked = await runPokeSweep();
      return res.status(200).json({ poked });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: String(err.message || err) });
    }
  }

  // --- GET / : webhook verification handshake ---
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  }

  if (req.method !== "POST") return res.sendStatus(405);
  if (!validSignature(req)) return res.sendStatus(401);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  if (!messages?.length) return res.sendStatus(200); // delivery/read status callbacks etc.
  const profileName = value?.contacts?.[0]?.profile?.name || null; // WhatsApp display name

  try {
    for (const msg of messages) {
      const from = msg.from;
      if (!(await claimMessage(msg.id))) continue; // already handled / in-flight

      if (!(await underDailyCap(from))) {
        await markProcessed(msg.id); // over cap → stay silent (don't burn xAI tokens)
        continue;
      }

      const body =
        msg.type === "text"
          ? msg.text.body
          : `[they sent a ${msg.type}, not text — react to that]`;

      await markReadWithTyping(msg.id); // read receipt + "typing…" while Grok thinks

      const history = await readHistory(from);
      try {
        const reply = await grokReply(history, body, { name: profileName });
        await sendToMeta(from, reply);
        await appendMessages(
          from,
          [{ role: "user", text: body }, { role: "assistant", text: reply }],
          profileName ? { name: profileName } : {}
        );
        await markProcessed(msg.id);
      } catch (err) {
        await releaseClaim(msg.id); // let Meta's retry re-process
        throw err;
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.sendStatus(500);
  }
});
