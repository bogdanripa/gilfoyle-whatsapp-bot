#!/usr/bin/env bash
# Usage: ./whatsapp-send.sh <reply_to_wa_id> "message text"
#
# Posts the reply to the bridge function's /send route, which logs it to the
# conversation history and forwards it to the Meta Cloud API. This keeps the
# WhatsApp token in the function only — the routine never touches it.
#
# Reads from the routine environment:
#   WHATSAPP_SEND_URL — the function's /send endpoint (…/whatsapp-webhook/send)
#   WHATSAPP_SEND_SECRET — shared secret the function checks (x-send-secret header)
set -euo pipefail

TO="${1:?usage: whatsapp-send.sh <wa_id> <text>}"
TEXT="${2:?usage: whatsapp-send.sh <wa_id> <text>}"

: "${WHATSAPP_SEND_URL:?WHATSAPP_SEND_URL not set}"
: "${WHATSAPP_SEND_SECRET:?WHATSAPP_SEND_SECRET not set}"

# Build the JSON body safely (handles quotes/newlines in TEXT) via jq.
BODY="$(jq -n --arg to "$TO" --arg text "$TEXT" '{to: $to, text: $text}')"

RESP="$(curl -s -X POST "$WHATSAPP_SEND_URL" \
  -H "x-send-secret: ${WHATSAPP_SEND_SECRET}" \
  -H "Content-Type: application/json" \
  -d "$BODY")"

echo "$RESP"

# Surface API errors with a non-zero exit so the routine notices.
if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
  echo "WhatsApp send failed" >&2
  exit 1
fi
