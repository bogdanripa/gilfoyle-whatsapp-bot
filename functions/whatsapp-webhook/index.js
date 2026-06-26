// WhatsApp ↔ Claude Code routine bridge — GCP Cloud Function (gen2).
//
// One HTTP entry point handles both Meta's GET verification handshake and the
// POST message webhooks. The /fire call is fire-and-forget (it returns once the
// session is created, never the assistant's output), so the ROUTINE sends the
// reply itself via the whatsapp-send skill — not this function.
//
// Functions Framework populates req.rawBody (a Buffer) for us, which we need to
// verify Meta's HMAC signature.

import functions from "@google-cloud/functions-framework";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import crypto from "crypto";

const {
  VERIFY_TOKEN,        // you choose this; entered in Meta webhook config
  APP_SECRET,          // Meta App secret — signs every POST
  ROUTINE_FIRE_URL,    // https://api.anthropic.com/v1/claude_code/routines/trig_016Sm3.../fire
  ROUTINE_TOKEN,       // bearer token shown once when you created the API trigger
  ALLOWED_WA_ID,       // optional: your own wa_id (e.g. 40712345678) to lock it to you
  DEDUPE_COLLECTION,   // optional: Firestore collection name (default "wa_dedupe")
} = process.env;

// --- Dedupe (Firestore) -----------------------------------------------------
// Meta has NO idempotency key and delivers at-least-once, so the same message.id
// can arrive twice — across cold starts or across concurrent instances. We dedupe
// on a Firestore doc keyed by message.id:
//
//   claimMessage(id): atomic create-if-not-exists. Returns true iff THIS instance
//     won the claim. A doc with status "done" → already handled, skip. A doc with
//     status "processing" → another instance is mid-fire, skip — UNLESS the claim
//     is older than CLAIM_LEASE_MS, in which case the prior instance likely crashed
//     before finishing, so we reclaim it (otherwise a crash mid-fire would wedge the
//     message forever, since Meta's retry would see "processing" and skip).
//   markProcessed(id): flip to "done" only AFTER a successful fire.
//   releaseClaim(id): delete the claim if the fire failed, so Meta's retry re-fires.
//
// expireAt lets a Firestore TTL policy on this field garbage-collect old docs.
const db = new Firestore();
const dedupe = db.collection(DEDUPE_COLLECTION || "wa_dedupe");
const CLAIM_LEASE_MS = 120_000; // > fire timeout (15s) + margin
const TTL_DAYS = 7;

async function claimMessage(id) {
  const ref = dedupe.doc(id);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      const d = snap.data();
      if (d.status === "done") return false;
      const claimedAt = d.at?.toMillis?.() ?? 0;
      if (Date.now() - claimedAt < CLAIM_LEASE_MS) return false; // active claim
      // else: stale "processing" claim — fall through and reclaim it
    }
    txn.set(ref, {
      status: "processing",
      at: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + TTL_DAYS * 86_400_000),
    });
    return true;
  });
}

async function markProcessed(id) {
  await dedupe.doc(id).set(
    { status: "done", at: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function releaseClaim(id) {
  await dedupe.doc(id).delete().catch(() => {}); // best-effort; Meta will retry
}

function validSignature(req) {
  const sig = req.get("x-hub-signature-256") || "";
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function fireRoutine(text) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(ROUTINE_FIRE_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${ROUTINE_TOKEN}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`fire ${r.status}: ${await r.text()}`);
    return r.json(); // { type, claude_code_session_id, claude_code_session_url }
  } finally {
    clearTimeout(t);
  }
}

functions.http("whatsapp", async (req, res) => {
  // --- GET: webhook verification handshake ---
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge); // echo verbatim
    }
    return res.sendStatus(403);
  }

  if (req.method !== "POST") return res.sendStatus(405);

  // --- POST: inbound messages ---
  if (!validSignature(req)) return res.sendStatus(401);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  if (!messages?.length) return res.sendStatus(200); // status callbacks etc.

  const profileName = value?.contacts?.[0]?.profile?.name || "unknown";

  try {
    for (const msg of messages) {
      if (ALLOWED_WA_ID && msg.from !== ALLOWED_WA_ID) continue;

      // Claim before doing any work — skip if already handled / in-flight.
      if (!(await claimMessage(msg.id))) continue;

      // text is freeform and NOT parsed by the routine — give it everything:
      // who wrote, the reply address, and the body. Media arrives as an id you'd
      // fetch via GET /{media-id}; until then, tell the sender it's text-only.
      const body =
        msg.type === "text"
          ? msg.text.body
          : `[unsupported ${msg.type} message — tell them you only handle text right now]`;

      const payload =
        `Incoming WhatsApp message.\n` +
        `from_name: ${profileName}\n` +
        `reply_to_wa_id: ${msg.from}\n` +
        `body: ${body}`;

      try {
        await fireRoutine(payload);
        await markProcessed(msg.id); // mark done only after a successful fire
      } catch (err) {
        await releaseClaim(msg.id); // let Meta's retry re-fire this message
        throw err;
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.sendStatus(500); // don't 200 a failed fire
  }
});
