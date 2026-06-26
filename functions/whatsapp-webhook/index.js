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
import crypto from "crypto";

const {
  VERIFY_TOKEN,        // you choose this; entered in Meta webhook config
  APP_SECRET,          // Meta App secret — signs every POST
  ROUTINE_FIRE_URL,    // https://api.anthropic.com/v1/claude_code/routines/trig_016Sm3.../fire
  ROUTINE_TOKEN,       // bearer token shown once when you created the API trigger
  ALLOWED_WA_ID,       // optional: your own wa_id (e.g. 40712345678) to lock it to you
} = process.env;

// --- Dedupe -----------------------------------------------------------------
// Meta has NO idempotency key and delivers at-least-once. In-memory is best-
// effort only: a Cloud Function scales to zero and each cold start wipes this.
// For correctness, swap this for a Firestore doc keyed on message.id (see the
// TODO in CLAUDE-CODE-HANDOFF.md). Only mark processed AFTER a successful fire.
const seen = new Set();
const SEEN_CAP = 5000;
function remember(id) {
  seen.add(id);
  if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
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
      if (seen.has(msg.id)) continue;
      if (ALLOWED_WA_ID && msg.from !== ALLOWED_WA_ID) continue;

      // Text only for now. Media arrives as an id you'd fetch via GET /{media-id}.
      if (msg.type !== "text") {
        await fireRoutine(
          `Incoming WhatsApp message.\n` +
          `from_name: ${profileName}\n` +
          `reply_to_wa_id: ${msg.from}\n` +
          `body: [unsupported ${msg.type} message — tell them you only handle text right now]`
        );
        remember(msg.id);
        continue;
      }

      // text is freeform and NOT parsed by the routine — give it everything:
      // who wrote, the reply address, and the body.
      const payload =
        `Incoming WhatsApp message.\n` +
        `from_name: ${profileName}\n` +
        `reply_to_wa_id: ${msg.from}\n` +
        `body: ${msg.text.body}`;

      await fireRoutine(payload); // throws on failure → 500 → Meta retries
      remember(msg.id);
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.sendStatus(500); // don't 200 a failed fire
  }
});
