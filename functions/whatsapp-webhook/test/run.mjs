// Integration test: runs the REAL function (functions-framework) against the REAL
// Firestore (via ADC), with a mock server standing in for both the xAI chat API and
// the Meta Graph API. Verifies the verify handshake, signature check, dedupe,
// conversation memory (history sent to the model), the Gilfoyle system prompt, and
// the per-wa_id daily cap. Uses test-only doc ids and cleans them up.
//
//   node test/run.mjs   (needs gcloud ADC + the wa-assistant project)
import { Firestore } from "@google-cloud/firestore";
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "whatsapp-asst-bripa";
const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const CRON_SECRET = "test-cron-secret";
const FN_PORT = 8088;
const MOCK_PORT = 9099;
const FN = `http://127.0.0.1:${FN_PORT}`;
const CAP = 2;
const HOUR = 3_600_000;

const WA_A = "10000000001"; // main flow
const WA_C = "10000000003"; // cap flow
const WA_P1 = "10000000011"; // poke: in 23-24h band, not yet poked → should poke
const WA_P2 = "10000000012"; // poke: in band but already poked → skip
const WA_P3 = "10000000013"; // poke: only 10h quiet → skip
const POKE_WAS = [WA_P1, WA_P2, WA_P3];
const DEDUPE_IDS = ["itest.a1", "itest.a2", "itest.c1", "itest.c2", "itest.c3"];

const db = new Firestore({ projectId: PROJECT });
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const eq = (m, a, b) => (a === b ? ok(m) : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

const sign = (raw) => "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
async function post(path, raw, headers = {}) {
  const r = await fetch(FN + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  return { code: r.status, body: await r.text() };
}
const inbound = (id, from, body) =>
  JSON.stringify({ entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: "Tester" } }],
    messages: [{ id, from, type: "text", text: { body } }],
  } }] }] });

// --- mock server: xAI /chat/completions + Graph /messages -------------------
let chatHits = 0, metaHits = 0, typingHits = 0, lastChat = null, lastMeta = null, lastTyping = null, n = 0;
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.url === "/stats") { res.end(JSON.stringify({ chatHits, metaHits, typingHits, lastChat, lastMeta, lastTyping })); return; }
    if (req.url.includes("/chat/completions")) {
      chatHits++; lastChat = JSON.parse(data || "{}");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `grok reply ${++n}` } }] }));
      return;
    }
    if (req.url.includes("/messages")) {
      const b = JSON.parse(data || "{}");
      if (b.status === "read") { typingHits++; lastTyping = b; } // read receipt + typing indicator
      else { metaHits++; lastMeta = b; }                         // actual reply
      res.end(JSON.stringify({ messages: [{ id: "wamid.test" }] }));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
});
const stats = async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`)).json();

async function cleanup() {
  const dels = [
    db.collection("conversations").doc(WA_A), db.collection("conversations").doc(WA_C),
    db.collection("ratelimit").doc(WA_A), db.collection("ratelimit").doc(WA_C),
    ...POKE_WAS.map((id) => db.collection("conversations").doc(id)),
    ...DEDUPE_IDS.map((id) => db.collection("wa_dedupe").doc(id)),
  ];
  for (const d of dels) await d.delete().catch(() => {});
}

// Seed conversations with crafted timestamps to exercise the poke sweep.
async function seedPokeConvs() {
  const now = Date.now();
  const turn = (userAgoH) => [
    { role: "user", text: "earlier msg", ts: now - userAgoH * HOUR },
    { role: "assistant", text: "earlier reply", ts: now - userAgoH * HOUR },
  ];
  await db.collection("conversations").doc(WA_P1).set({ messages: turn(23.5) });                       // in band, not poked
  await db.collection("conversations").doc(WA_P2).set({ messages: turn(23.5), lastPokeTs: now });      // in band, already poked
  await db.collection("conversations").doc(WA_P3).set({ messages: turn(10) });                         // too recent
}

async function main() {
  await cleanup();
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  const ff = spawn("npx", ["--no-install", "functions-framework", "--target=whatsapp", `--port=${FN_PORT}`], {
    cwd: process.cwd(),
    env: { ...process.env,
      GOOGLE_CLOUD_PROJECT: PROJECT, VERIFY_TOKEN, APP_SECRET, CRON_SECRET,
      WHATSAPP_TOKEN: "test-wa-token", WHATSAPP_PHONE_NUMBER_ID: "PHONE123",
      XAI_API_KEY: "test-xai", XAI_MODEL: "test-grok", XAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      GRAPH_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, DAILY_CAP: String(CAP) },
    stdio: "ignore",
  });

  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(`${FN}/?hub.mode=subscribe`); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }

    // verify handshake
    let r = await fetch(`${FN}/?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHX`);
    eq("verify: correct token echoes challenge", await r.text(), "CHX");
    eq("verify: wrong token → 403", (await fetch(`${FN}/?hub.mode=subscribe&hub.verify_token=no&hub.challenge=X`)).status, 403);

    // signature
    const empty = JSON.stringify({ entry: [{ changes: [{ value: { messages: [] } }] }] });
    eq("bad signature → 401", (await post("/", empty, { "x-hub-signature-256": "sha256=bad" })).code, 401);
    eq("valid sig, no messages → 200", (await post("/", empty, { "x-hub-signature-256": sign(empty) })).code, 200);

    // inbound message → xAI + Meta
    let s0 = await stats();
    const a1 = inbound("itest.a1", WA_A, "sup");
    eq("inbound → 200", (await post("/", a1, { "x-hub-signature-256": sign(a1) })).code, 200);
    let s = await stats();
    eq("xAI called once", s.chatHits - s0.chatHits, 1);
    eq("reply sent to Meta once", s.metaHits - s0.metaHits, 1);
    eq("typing indicator + read receipt sent", s.typingHits - s0.typingHits, 1);
    eq("typing references the incoming message id", s.lastTyping.message_id, "itest.a1");
    eq("Gilfoyle system prompt sent", s.lastChat.messages[0].role === "system" && /Gilfoyle/.test(s.lastChat.messages[0].content), true);
    eq("model from env used", s.lastChat.model, "test-grok");
    eq("WhatsApp name passed into context", s.lastChat.messages.some((m) => m.role === "system" && /"Tester"/.test(m.content)), true);
    eq("full-context temperature applied (>1)", s.lastChat.temperature > 1, true);
    eq("Meta got grok's reply text", /grok reply/.test(s.lastMeta.text.body), true);

    // dedupe replay
    s0 = await stats();
    await post("/", a1, { "x-hub-signature-256": sign(a1) });
    eq("replay deduped (no second xAI call)", (await stats()).chatHits - s0.chatHits, 0);

    // memory: 2nd message carries prior turn(s) in the model context
    const a2 = inbound("itest.a2", WA_A, "still here");
    await post("/", a2, { "x-hub-signature-256": sign(a2) });
    const ctx = (await stats()).lastChat.messages.map((m) => `${m.role}:${m.content}`).join(" | ");
    eq("history: prior user msg in context", ctx.includes("user:sup"), true);
    eq("history: prior assistant reply in context", /assistant:grok reply/.test(ctx), true);
    const conv = (await db.collection("conversations").doc(WA_A).get()).data();
    eq("conversation logged user+assistant per turn", conv.messages.length, 4);

    // daily cap (CAP=2): WA_C gets 2 answers then silence
    let cb = await stats();
    for (const id of ["c1", "c2"]) {
      const m = inbound(`itest.${id}`, WA_C, `msg ${id}`);
      await post("/", m, { "x-hub-signature-256": sign(m) });
    }
    eq("cap: first 2 answered", (await stats()).chatHits - cb.chatHits, 2);
    cb = await stats();
    const c3 = inbound("itest.c3", WA_C, "msg c3");
    await post("/", c3, { "x-hub-signature-256": sign(c3) });
    s = await stats();
    eq("cap: 3rd over limit → no xAI call", s.chatHits - cb.chatHits, 0);
    eq("cap: 3rd over limit → no Meta send (silent)", s.metaHits - cb.metaHits, 0);

    // re-engagement cron: poke only conversations in the 23-24h band, once per window
    await seedPokeConvs();
    eq("cron: wrong secret → 401", (await post("/cron", "{}", { "x-cron-secret": "nope" })).code, 401);
    let pb = await stats();
    const cron = await post("/cron", "{}", { "x-cron-secret": CRON_SECRET });
    eq("cron: → 200", cron.code, 200);
    eq("cron: poked exactly one conversation", JSON.parse(cron.body).poked, 1);
    eq("cron: that poke went to Meta", (await stats()).metaHits - pb.metaHits, 1);
    const p1 = (await db.collection("conversations").doc(WA_P1).get()).data();
    eq("cron: poked conv got an assistant message appended", p1.messages.length, 3);
    eq("cron: poked conv has lastPokeTs set", typeof p1.lastPokeTs === "number", true);
    const p3 = (await db.collection("conversations").doc(WA_P3).get()).data();
    eq("cron: too-recent conv left untouched", p3.messages.length, 2);

    // second run in the same window must not re-poke
    pb = await stats();
    const cron2 = await post("/cron", "{}", { "x-cron-secret": CRON_SECRET });
    eq("cron: re-run does not re-poke (idempotent per window)", JSON.parse(cron2.body).poked, 0);
    eq("cron: re-run sends nothing to Meta", (await stats()).metaHits - pb.metaHits, 0);
  } finally {
    ff.kill();
    mock.close();
    await cleanup();
  }

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
