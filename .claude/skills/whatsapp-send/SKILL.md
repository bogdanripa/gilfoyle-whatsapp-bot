---
name: whatsapp-send
description: >
  Send WhatsApp messages via the Meta Cloud API. Use this skill whenever you need to reply to a
  WhatsApp user or push a notification to WhatsApp. Triggers include: "reply on WhatsApp",
  "send a WhatsApp message", "text them back", or any time a routine processes an incoming
  WhatsApp message and needs to respond. The reply address is the wa_id passed in the incoming
  message context (reply_to_wa_id).
---

# WhatsApp Send Skill

Sends a WhatsApp message through the Meta Cloud API `/messages` endpoint. Used by the WhatsApp
assistant routine to reply to the user who messaged in.

## Configuration

Credentials come from the routine's environment variables — **do not** commit them to the repo:

- `WHATSAPP_TOKEN` — permanent System User access token
- `WHATSAPP_PHONE_NUMBER_ID` — the Cloud API phone number ID (NOT the display number)

Set both under the routine's cloud environment (Edit routine → environment variables).

## Network allowlist (important)

Routines run with **Trusted network access** by default, and `graph.facebook.com` is not on the
default allowlist — outbound calls to it fail with `403 host_not_allowed`. Add `graph.facebook.com`
to the routine's **Allowed domains** (Edit routine → environment → Allowed domains), or this skill
silently can't send.

## Sending a message

```bash
./whatsapp-send.sh <reply_to_wa_id> "Your message text here"
```

Example, replying to the wa_id from the incoming context:

```bash
./whatsapp-send.sh 40712345678 "Done — the audit found 2 issues, both in scenarios."
```

## The 24-hour window (read this)

Free-form text only delivers inside the **24-hour customer service window** — i.e. within 24h of
the user's last inbound message. Since this skill almost always runs as a *reply* to an inbound
message, you're inside the window and plain text works.

If you ever send **unprompted** (e.g. a scheduled morning digest pushed to WhatsApp with no recent
inbound message), the window is closed and Meta rejects text with error **131026**. Outside the
window you must send a **pre-approved template message** instead. Watch for `131026` in the
response and, if you hit it, fall back to a template or note that the push couldn't be delivered.

## Error handling

The script prints the raw API response. Check for an `error` object. Common codes:
- `131026` — outside the 24-hour window (use a template)
- `131047` — recipient number not registered on WhatsApp
- `190` — access token expired or invalid
