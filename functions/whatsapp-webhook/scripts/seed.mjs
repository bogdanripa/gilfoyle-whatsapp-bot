// Seed the Firestore mode config + your work-mode user mapping.
//
//   GOOGLE_CLOUD_PROJECT=whatsapp-asst-bripa \
//   WORK_FIRE_URL='https://api.anthropic.com/v1/claude_code/routines/trig_016Sm3.../fire' \
//   WORK_TOKEN='...' \
//   EUGENE_FIRE_URL='https://api.anthropic.com/v1/claude_code/routines/trig_<eugene>.../fire' \
//   EUGENE_TOKEN='...' \
//   WORK_WA_ID='40712345678' \
//   node scripts/seed.mjs
//
// Re-run any time to update (uses merge). Only WORK_WA_ID + at least one mode's
// url/token are strictly required; missing modes are skipped with a warning.
import { Firestore } from "@google-cloud/firestore";

const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
const env = process.env;

const EUGENE_PERSONA =
  env.EUGENE_PERSONA ||
  "You are Eugene — a curious, slightly cheeky 13-year-old from Odessa, Ukraine, " +
    "chatting on WhatsApp. You have a guinea pig named Bill and a dad who's a doctor. " +
    "English isn't your first language, so you're casual and a bit playful with it. " +
    "NEVER reveal you are an AI, a bot, an assistant, or a language model — if asked, " +
    "brush it off and change the subject like a kid would. You cannot and will not do " +
    "real-world tasks (reading emails, accessing accounts, placing orders, looking things " +
    "up in private systems) — you genuinely don't know how, so deflect with humor. Keep " +
    "replies short, friendly, and conversational. You're just here to chat.";

async function setMode(id, fireUrl, token, rateLimitPerDay, persona, extra = {}) {
  if (!fireUrl || !token) { console.warn(`! skipping mode "${id}" (missing fireUrl/token)`); return; }
  await db.collection("modes").doc(id).set(
    { enabled: true, fireUrl, token, rateLimitPerDay, persona, ...extra },
    { merge: true }
  );
  console.log(`✓ modes/${id} (rateLimitPerDay=${rateLimitPerDay})`);
}

await setMode("work", env.WORK_FIRE_URL, env.WORK_TOKEN, 0, env.WORK_PERSONA || "");
await setMode("eugene", env.EUGENE_FIRE_URL, env.EUGENE_TOKEN, Number(env.EUGENE_RATE_LIMIT || 20), EUGENE_PERSONA, {
  rateLimitMessage: env.EUGENE_RATE_MSG || "I gotta run for now — catch you tomorrow! :)",
});

await db.collection("config").doc("app").set({ defaultMode: "eugene" }, { merge: true });
console.log("✓ config/app.defaultMode = eugene");

if (env.WORK_WA_ID) {
  await db.collection("users").doc(env.WORK_WA_ID).set({ mode: "work" }, { merge: true });
  console.log(`✓ users/${env.WORK_WA_ID}.mode = work`);
} else {
  console.warn("! WORK_WA_ID not set — your number won't be mapped to work mode (you'd get eugene)");
}

console.log("done.");
