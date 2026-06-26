---
name: whatsapp-send
description: >
  Send WhatsApp messages via the bridge function. Use this skill whenever you need to reply to a
  WhatsApp user or push a notification to WhatsApp. Triggers include: "reply on WhatsApp",
  "send a WhatsApp message", "text them back", or any time a routine processes an incoming
  WhatsApp message and needs to respond. The reply address is the wa_id passed in the incoming
  message context (reply_to_wa_id).
---

# WhatsApp Send Skill

Sends a WhatsApp reply by POSTing to the bridge Cloud Function's `/send` route. The function
logs the reply into the conversation history and forwards it to the Meta Cloud API. The WhatsApp
token lives in the function only — this skill (and the routine) never handle it.

## Configuration

Credentials come from the routine's environment variables — **do not** commit them to the repo:

- `WHATSAPP_SEND_URL` — the function's `/send` endpoint, e.g.
  `https://europe-central2-whatsapp-asst-bripa.cloudfunctions.net/whatsapp-webhook/send`
- `WHATSAPP_SEND_SECRET` — the shared secret the function checks (sent as the `x-send-secret` header)

Set both under the routine's cloud environment (Edit routine → environment variables).

## Network allowlist (important)

Routines run with **Trusted network access** by default. Add the function's host (the
`*.cloudfunctions.net` / `*.run.app` domain from `WHATSAPP_SEND_URL`) to the routine's
**Allowed domains**, or this skill can't reach the endpoint. (You no longer need
`graph.facebook.com` on the allowlist — the function talks to Meta, not the routine.)

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

If you ever send **unprompted** (e.g. a scheduled morning digest with no recent inbound message),
the window is closed and Meta rejects text with error **131026**. Outside the window you must send
a **pre-approved template message** instead.

## Error handling

The script prints the function's JSON response. A non-zero exit means the send failed; the response
contains an `error` field. The function surfaces Meta's errors, e.g.:
- `131026` — outside the 24-hour window (use a template)
- `131047` — recipient number not registered on WhatsApp
- `190` — access token expired or invalid
