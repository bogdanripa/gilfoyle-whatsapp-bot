// Integration test: runs the REAL function (functions-framework) against the REAL
// Firestore (via ADC), with a mock server standing in for both the routine /fire
// endpoint and the Meta Graph API. Verifies modes, memory injection, dedupe,
// rate limiting, and the /send route. Uses test-only doc ids and cleans them up.
//
//   node test/run.mjs   (needs gcloud ADC + the wa-assistant project)
import { Firestore } from "@google-cloud/firestore";
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "whatsapp-asst-bripa";
const APP_SECRET = "test-app-secret";
const SEND_SECRET = "test-send-secret";
const VERIFY_TOKEN = "test-verify-token";
const FN_PORT = 8088;
const MOCK_PORT = 9099;
const FN = `http://127.0.0.1:${FN_PORT}`;

const WORK_WA = "10000000001"; // seeded → test-work
const EUG_WA = "10000000002";  // no users doc → default test-eugene (rate limit 2/day)

const db = new Firestore({ projectId: PROJECT });
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const eq = (m, a, b) => (a === b ? ok(m) : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

const sign = (raw) =>
  "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");

async function post(path, raw, headers = {}) {
  const r = await fetch(FN + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  return { code: r.status, body: await r.text() };
}
const inbound = (id, from, body) =>
  JSON.stringify({ entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: "Tester" } }],
    messages: [{ id, from, type: "text", text: { body } }],
  } }] }] });

// --- mock server: /fire (routines) + Graph API (Meta) -----------------------
let fireHits = 0, metaHits = 0, lastFireBody = null, lastMetaBody = null;
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.url === "/stats") { res.end(JSON.stringify({ fireHits, metaHits, lastFireBody, lastMetaBody })); return; }
    if (req.url.includes("/fire")) { fireHits++; lastFireBody = JSON.parse(data || "{}"); res.end(JSON.stringify({ type: "session_created", claude_code_session_id: "sess_test" })); return; }
    if (req.url.includes("/messages")) { metaHits++; lastMetaBody = JSON.parse(data || "{}"); res.end(JSON.stringify({ messages: [{ id: "wamid.test" }] })); return; }
    res.writeHead(404); res.end("{}");
  });
});

async function seed() {
  await db.collection("modes").doc("test-work").set({ enabled: true, fireUrl: `http://127.0.0.1:${MOCK_PORT}/fire`, token: "tok-work", rateLimitPerDay: 0, persona: "" });
  await db.collection("modes").doc("test-eugene").set({ enabled: true, fireUrl: `http://127.0.0.1:${MOCK_PORT}/fire`, token: "tok-eug", rateLimitPerDay: 2, persona: "You are Eugene.", rateLimitMessage: "ttyl" });
  await db.collection("users").doc(WORK_WA).set({ mode: "test-work" });
}
const DEDUPE_IDS = ["itest.w1", "itest.w2", "itest.e1", "itest.e2", "itest.e3", "itest.e4"];
async function cleanup() {
  const dels = [
    db.collection("modes").doc("test-work"), db.collection("modes").doc("test-eugene"),
    db.collection("users").doc(WORK_WA),
    db.collection("conversations").doc(WORK_WA), db.collection("conversations").doc(EUG_WA),
    db.collection("ratelimit").doc(EUG_WA),
    ...DEDUPE_IDS.map((id) => db.collection("wa_dedupe").doc(id)),
  ];
  for (const d of dels) await d.delete().catch(() => {});
}
const stats = async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`)).json();

async function main() {
  await cleanup();
  await seed();
  await new Promise((r) => mock.listen(MOCK_PORT, r));

  const ff = spawn("npx", ["--no-install", "functions-framework", "--target=whatsapp", `--port=${FN_PORT}`], {
    cwd: process.cwd(),
    env: { ...process.env,
      GOOGLE_CLOUD_PROJECT: PROJECT, VERIFY_TOKEN, APP_SECRET, SEND_SECRET,
      WHATSAPP_TOKEN: "test-wa-token", WHATSAPP_PHONE_NUMBER_ID: "PHONE123",
      GRAPH_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, DEFAULT_MODE: "test-eugene" },
    stdio: "ignore",
  });

  try {
    // wait for boot
    for (let i = 0; i < 40; i++) {
      try { await fetch(`${FN}/?hub.mode=subscribe`); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }

    // 1. verify handshake
    let r = await fetch(`${FN}/?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHX`);
    eq("verify: correct token echoes challenge", await r.text(), "CHX");
    r = await fetch(`${FN}/?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CHX`);
    eq("verify: wrong token → 403", r.status, 403);

    // 2. signature
    const empty = JSON.stringify({ entry: [{ changes: [{ value: { messages: [] } }] }] });
    eq("bad signature → 401", (await post("/", empty, { "x-hub-signature-256": "sha256=bad" })).code, 401);
    eq("valid sig, no messages → 200", (await post("/", empty, { "x-hub-signature-256": sign(empty) })).code, 200);

    // 3. work mode: fires test-work, logs inbound
    let before = (await stats()).fireHits;
    const m1 = inbound("itest.w1", WORK_WA, "first work message");
    eq("work msg → 200", (await post("/", m1, { "x-hub-signature-256": sign(m1) })).code, 200);
    let s = await stats();
    eq("work msg fired once", s.fireHits - before, 1);
    ok(`fired test-work (token tok-work): ${s.lastFireBody ? "payload sent" : "MISSING"}`);

    // 4. dedupe replay
    before = (await stats()).fireHits;
    await post("/", m1, { "x-hub-signature-256": sign(m1) });
    eq("replay deduped (no second fire)", (await stats()).fireHits - before, 0);

    // 5. memory injection: 2nd work message should carry the 1st in its payload
    const m2 = inbound("itest.w2", WORK_WA, "second work message");
    await post("/", m2, { "x-hub-signature-256": sign(m2) });
    const payload = (await stats()).lastFireBody?.text || "";
    eq("history injected: prior message present", payload.includes("first work message"), true);
    eq("persona NOT applied to work mode", payload.startsWith("Conversation so far"), true);

    // 6. /send route logs assistant reply + forwards to Meta
    before = (await stats()).metaHits;
    r = await post("/send", JSON.stringify({ to: WORK_WA, text: "hello from routine" }), { "x-send-secret": SEND_SECRET });
    eq("/send correct secret → 200", r.code, 200);
    eq("/send forwarded to Meta", (await stats()).metaHits - before, 1);
    eq("/send wrong secret → 401", (await post("/send", JSON.stringify({ to: WORK_WA, text: "x" }), { "x-send-secret": "nope" })).code, 401);
    const conv = (await db.collection("conversations").doc(WORK_WA).get()).data();
    eq("conversation has assistant reply logged", conv.messages.some((x) => x.role === "assistant" && x.text === "hello from routine"), true);

    // 7. eugene default mode + rate limit (2/day)
    let fb = (await stats()).fireHits, mb = (await stats()).metaHits;
    for (const [i, txt] of [["e1", "hi 1"], ["e2", "hi 2"]]) {
      const e = inbound(`itest.${i}`, EUG_WA, txt);
      await post("/", e, { "x-hub-signature-256": sign(e) });
    }
    eq("eugene: 2 allowed messages fired", (await stats()).fireHits - fb, 2);
    const ep = (await stats()).lastFireBody?.text || "";
    eq("eugene persona applied", ep.startsWith("You are Eugene."), true);

    // 3rd over limit → brush-off via Meta, no fire
    fb = (await stats()).fireHits; mb = (await stats()).metaHits;
    const e3 = inbound("itest.e3", EUG_WA, "hi 3");
    await post("/", e3, { "x-hub-signature-256": sign(e3) });
    s = await stats();
    eq("eugene over limit → not fired", s.fireHits - fb, 0);
    eq("eugene over limit → brush-off sent", s.metaHits - mb, 1);

    // 4th over limit → silent (already notified today)
    fb = (await stats()).fireHits; mb = (await stats()).metaHits;
    const e4 = inbound("itest.e4", EUG_WA, "hi 4");
    await post("/", e4, { "x-hub-signature-256": sign(e4) });
    s = await stats();
    eq("eugene still over limit → not fired", s.fireHits - fb, 0);
    eq("eugene over limit again → silent (no 2nd brush-off)", s.metaHits - mb, 0);
  } finally {
    ff.kill();
    mock.close();
    await cleanup();
  }

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
