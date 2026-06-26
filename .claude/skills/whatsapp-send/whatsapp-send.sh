#!/usr/bin/env bash
# Usage: ./whatsapp-send.sh <reply_to_wa_id> "message text"
# Reads WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID from the environment.
set -euo pipefail

TO="${1:?usage: whatsapp-send.sh <wa_id> <text>}"
TEXT="${2:?usage: whatsapp-send.sh <wa_id> <text>}"

: "${WHATSAPP_TOKEN:?WHATSAPP_TOKEN not set}"
: "${WHATSAPP_PHONE_NUMBER_ID:?WHATSAPP_PHONE_NUMBER_ID not set}"

# Build the JSON body safely (handles quotes/newlines in TEXT) via a heredoc + jq.
BODY="$(jq -n --arg to "$TO" --arg text "$TEXT" '{
  messaging_product: "whatsapp",
  recipient_type: "individual",
  to: $to,
  type: "text",
  text: { body: $text, preview_url: true }
}')"

RESP="$(curl -s -X POST \
  "https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages" \
  -H "Authorization: Bearer ${WHATSAPP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$BODY")"

echo "$RESP"

# Surface API errors with a non-zero exit so the routine notices.
if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
  echo "WhatsApp send failed" >&2
  exit 1
fi
