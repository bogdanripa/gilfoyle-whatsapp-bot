// WhatsApp ↔ Claude Code routine bridge — GCP Cloud Function (gen2).
//
// Two public routes on one entry point:
//   GET  /       Meta webhook verification handshake
//   POST /       inbound WhatsApp messages (HMAC-signed by Meta)
//   POST /send   the routine's reply, forwarded to Meta (auth: SEND_SECRET header)
//
// The routine /fire endpoint is fire-and-forget — it returns once the session is
// created, never the assistant's output. So the reply can't ride back on the HTTP
// response; the routine posts it to /send, which logs it and forwards to Meta. That
// makes this function the single writer of conversation memory and the only holder
// of the WhatsApp token.
//
// Modes: each user (wa_id) maps to a mode; each mode is its own routine (own
// connectors). Strangers default to a sandboxed "eugene" routine with no access to
// anything sensitive — a real isolation boundary, not a prompt suggestion. Mode
// config (fireUrl, token, rate limit, persona) lives in Firestore so adding or
// repointing a mode is a pure data change, no redeploy.

import functions from "@google-cloud/functions-framework";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import crypto from "crypto";

const {
  VERIFY_TOKEN,             // you choose this; entered in Meta webhook config
  APP_SECRET,               // Meta App secret — signs every inbound POST
  SEND_SECRET,              // shared secret the routine presents to POST /send
  WHATSAPP_TOKEN,           // Meta Cloud API token — used here to forward replies
  WHATSAPP_PHONE_NUMBER_ID, // Cloud API phone number id (NOT the display number)
  GRAPH_API_VERSION = "v22.0",
  GRAPH_API_BASE = "https://graph.facebook.com", // overridable for local testing
  DEFAULT_MODE = "eugene",  // mode for any wa_id without an explicit users/{wa_id}.mode
} = process.env;

const MAX_HISTORY = 100;                 // messages kept per conversation (self-pruning)
const CONV_TTL_MS = 90 * 86_400_000;     // dead conversations expire after 90 days
const CLAIM_LEASE_MS = 120_000;          // > fire timeout (15s) + margin
const DEDUPE_TTL_MS = 7 * 86_400_000;

const db = new Firestore();
const dedupe = db.collection("wa_dedupe");
const conversations = db.collection("conversations");
const modes = db.collection("modes");
const users = db.collection("users");
const ratelimit = db.collection("ratelimit");

// --- Dedupe -----------------------------------------------------------------
// Meta has NO idempotency key and delivers at-least-once. We dedupe on a doc per
// message.id: atomic create-if-not-exists claim → fire → mark done. A stale
// "processing" claim past the lease is reclaimable (survives a crash mid-fire).
async function claimMessage(id) {
  const ref = dedupe.doc(id);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      const d = snap.data();
      if (d.status === "done") return false;
      const claimedAt = d.at?.toMillis?.() ?? 0;
      if (Date.now() - claimedAt < CLAIM_LEASE_MS) return false; // active claim
      // else: stale claim — fall through and reclaim it
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
async function appendMessage(convId, role, text) {
  const ref = conversations.doc(convId);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const messages = snap.exists ? snap.data().messages || [] : [];
    messages.push({ role, text, ts: Date.now() });
    txn.set(
      ref,
      { messages: messages.slice(-MAX_HISTORY), expireAt: new Date(Date.now() + CONV_TTL_MS) },
      { merge: true }
    );
  });
}

// --- Modes ------------------------------------------------------------------
// Resolve the mode for a wa_id: users/{wa_id}.mode (or DEFAULT_MODE) → modes/{id}.
async function resolveMode(convId) {
  const u = await users.doc(convId).get();
  const modeId = (u.exists && u.data().mode) || DEFAULT_MODE;
  let snap = await modes.doc(modeId).get();
  if ((!snap.exists || snap.data().enabled === false) && modeId !== DEFAULT_MODE) {
    snap = await modes.doc(DEFAULT_MODE).get(); // fall back to default if misconfigured
  }
  if (!snap.exists || snap.data().enabled === false) return null;
  return { id: snap.id, ...snap.data() };
}

// --- Rate limit (per wa_id per UTC day; 0/absent = unlimited) ---------------
// Returns "allowed" | "blocked-first" (notify once) | "blocked-silent".
async function rateLimit(convId, perDay) {
  if (!perDay || perDay <= 0) return "allowed";
  const ref = ratelimit.doc(convId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const today = new Date().toISOString().slice(0, 10);
    let { day, count = 0, notified } = snap.exists ? snap.data() : {};
    if (day !== today) { count = 0; notified = null; }
    if (count >= perDay) {
      if (notified === today) return "blocked-silent";
      txn.set(ref, { day: today, count, notified: today }, { merge: true });
      return "blocked-first";
    }
    txn.set(ref, { day: today, count: count + 1, notified: notified ?? null }, { merge: true });
    return "allowed";
  });
}

// --- Outbound calls ---------------------------------------------------------
function timedFetch(url, opts, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function fireRoutine(mode, text) {
  const r = await timedFetch(mode.fireUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mode.token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`fire ${mode.id} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sendToMeta(to, text) {
  const r = await timedFetch(
    `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text, preview_url: true },
      }),
    }
  );
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(`meta send ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

// --- Fire payload -----------------------------------------------------------
// Everything the (historyless) routine session needs: persona, prior turns, the
// new message, and how to reply.
function buildPayload(mode, history, profileName, from, body) {
  const transcript = history.length
    ? history.map((m) => `[${m.role === "assistant" ? "you" : "them"}] ${m.text}`).join("\n")
    : "(no earlier messages)";
  return (
    (mode.persona ? `${mode.persona}\n\n` : "") +
    `Conversation so far (oldest first):\n${transcript}\n\n` +
    `New incoming WhatsApp message:\n` +
    `from_name: ${profileName}\n` +
    `reply_to_wa_id: ${from}\n` +
    `body: ${body}\n\n` +
    `Reply with exactly one message using the whatsapp-send skill ` +
    `(it posts to the send endpoint): ./whatsapp-send.sh ${from} "<your reply>"`
  );
}

// --- HTTP entry point -------------------------------------------------------
function validSignature(req) {
  const sig = req.get("x-hub-signature-256") || "";
  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

functions.http("whatsapp", async (req, res) => {
  // --- POST /send : the routine's reply → log + forward to Meta ---
  if (req.method === "POST" && req.path === "/send") {
    if (!SEND_SECRET || req.get("x-send-secret") !== SEND_SECRET) return res.sendStatus(401);
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "to and text required" });
    try {
      await appendMessage(String(to), "assistant", String(text));
      const result = await sendToMeta(String(to), String(text));
      return res.status(200).json(result);
    } catch (err) {
      console.error(err);
      return res.status(502).json({ error: String(err.message || err) });
    }
  }

  // --- GET / : webhook verification handshake ---
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  }

  if (req.method !== "POST") return res.sendStatus(405);

  // --- POST / : inbound messages ---
  if (!validSignature(req)) return res.sendStatus(401);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  if (!messages?.length) return res.sendStatus(200); // delivery/read status callbacks etc.
  const profileName = value?.contacts?.[0]?.profile?.name || "unknown";

  try {
    for (const msg of messages) {
      const from = msg.from;
      if (!(await claimMessage(msg.id))) continue; // already handled / in-flight

      const mode = await resolveMode(from);
      if (!mode) {
        console.error(`no mode resolved for ${from} (default "${DEFAULT_MODE}" missing?)`);
        await markProcessed(msg.id);
        continue;
      }

      const limit = await rateLimit(from, mode.rateLimitPerDay);
      if (limit !== "allowed") {
        if (limit === "blocked-first") {
          await sendToMeta(
            from,
            mode.rateLimitMessage ||
              "I've got to run for now — let's pick this up tomorrow!"
          ).catch((e) => console.error(e));
        }
        await markProcessed(msg.id);
        continue;
      }

      const body =
        msg.type === "text"
          ? msg.text.body
          : `[unsupported ${msg.type} message — tell them you only handle text right now]`;

      const history = await readHistory(from);
      const payload = buildPayload(mode, history, profileName, from, body);

      try {
        await fireRoutine(mode, payload);
        await appendMessage(from, "user", body); // log inbound only after a successful fire
        await markProcessed(msg.id);
      } catch (err) {
        await releaseClaim(msg.id); // let Meta's retry re-fire
        throw err;
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.sendStatus(500);
  }
});
