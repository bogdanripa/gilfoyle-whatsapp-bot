#!/usr/bin/env bash
# Local integration test for the WhatsApp webhook function.
# Runs the REAL function (functions-framework) against the REAL Firestore (via ADC),
# with a mock "fire" endpoint so we can assert dedupe without hitting the routine.
#
# Usage: ./local-test.sh   (needs gcloud ADC + the wa-assistant project active)
set -uo pipefail
cd "$(dirname "$0")"

PROJECT="${GOOGLE_CLOUD_PROJECT:-whatsapp-asst-bripa}"
export GOOGLE_CLOUD_PROJECT="$PROJECT"
export VERIFY_TOKEN="test-verify-token"
export APP_SECRET="test-app-secret"
export ALLOWED_WA_ID="40712345678"
export ROUTINE_FIRE_URL="http://127.0.0.1:9099/fire"
export ROUTINE_TOKEN="test-routine-token"
export DEDUPE_COLLECTION="wa_dedupe_test"

FN_PORT=8088
pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }

# --- mock fire server: counts hits, always 200 -----------------------------
node -e '
  const http=require("http"); let hits=0;
  http.createServer((req,res)=>{
    if(req.url==="/count"){res.end(String(hits));return;}
    hits++; res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({type:"session_created",claude_code_session_id:"sess_test"}));
  }).listen(9099);
' &
MOCK_PID=$!

npx --no-install functions-framework --target=whatsapp --port=$FN_PORT >/tmp/ff.log 2>&1 &
FF_PID=$!

cleanup(){ kill $MOCK_PID $FF_PID 2>/dev/null; }
trap cleanup EXIT

# wait for the function to come up
for i in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$FN_PORT/?hub.mode=subscribe" && break
  sleep 0.5
done

base="http://127.0.0.1:$FN_PORT"
sign(){ printf '%s' "$1" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.* /sha256=/'; }
hits(){ curl -s http://127.0.0.1:9099/count; }

echo "== GET verify handshake =="
out=$(curl -s "$base/?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=CHALLENGE123")
[ "$out" = "CHALLENGE123" ] && ok "correct token echoes challenge" || bad "expected CHALLENGE123, got '$out'"
code=$(curl -s -o /dev/null -w '%{http_code}' "$base/?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=X")
[ "$code" = "403" ] && ok "wrong token → 403" || bad "wrong token expected 403, got $code"

echo "== POST signature check =="
body='{"entry":[{"changes":[{"value":{"messages":[]}}]}]}'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/" -H 'content-type: application/json' -H 'x-hub-signature-256: sha256=deadbeef' -d "$body")
[ "$code" = "401" ] && ok "bad signature → 401" || bad "bad signature expected 401, got $code"

echo "== POST valid sig, no messages (status callback) =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/" -H 'content-type: application/json' -H "x-hub-signature-256: $(sign "$body")" -d "$body")
[ "$code" = "200" ] && ok "empty messages → 200" || bad "expected 200, got $code"

echo "== POST real message → fires once, dedupes on replay =="
MSGID="wamid.localtest.$(date +%s)"
msg=$(cat <<EOF
{"entry":[{"changes":[{"value":{"contacts":[{"profile":{"name":"Bogdan"}}],"messages":[{"id":"$MSGID","from":"$ALLOWED_WA_ID","type":"text","text":{"body":"hello local test"}}]}}]}]}
EOF
)
before=$(hits)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/" -H 'content-type: application/json' -H "x-hub-signature-256: $(sign "$msg")" -d "$msg")
after1=$(hits)
[ "$code" = "200" ] && ok "first delivery → 200" || bad "first delivery expected 200, got $code"
[ "$((after1-before))" = "1" ] && ok "fired exactly once" || bad "expected 1 fire, got $((after1-before))"

# replay the identical message id
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/" -H 'content-type: application/json' -H "x-hub-signature-256: $(sign "$msg")" -d "$msg")
after2=$(hits)
[ "$code" = "200" ] && ok "replay → 200" || bad "replay expected 200, got $code"
[ "$after2" = "$after1" ] && ok "replay deduped (no second fire)" || bad "replay fired again: $after1 → $after2"

echo "== POST from disallowed wa_id is ignored =="
other=$(echo "$msg" | sed "s/$ALLOWED_WA_ID/49999999999/; s/$MSGID/${MSGID}.other/")
before3=$(hits)
curl -s -o /dev/null -X POST "$base/" -H 'content-type: application/json' -H "x-hub-signature-256: $(sign "$other")" -d "$other"
[ "$(hits)" = "$before3" ] && ok "disallowed wa_id → not fired" || bad "disallowed wa_id fired"

echo
echo "PASS=$pass FAIL=$fail"
[ "$fail" = "0" ]
