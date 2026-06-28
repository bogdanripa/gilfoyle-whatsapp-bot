# Architecture

A WhatsApp bot with one persona: **Gilfoyle** (the MGonz play — a rude, hostile bot is
oddly convincing because people argue back instead of probing whether it's a machine).
A single GCP Cloud Function receives the message, asks **xAI (Grok)** for a reply, and
sends it straight back to Meta. No Claude routine, no LLM-side quota to worry about —
just an API call billed per token.

## Flow

```
WhatsApp → Meta → Function POST /:
  verify HMAC → dedupe (wa_dedupe) → daily-cap check (ratelimit)
  → read history (conversations) → xAI chat/completions (system=Gilfoyle + last 20 turns + new msg)
  → send reply to Meta Graph API → log the turn (user + assistant)
  → mark done | on failure: release claim so Meta's retry re-processes
```

Everything is synchronous within the one request (Grok is fast; well inside Meta's
webhook timeout). The function is the only thing holding the WhatsApp + xAI keys.

## LLM

xAI is OpenAI-compatible: `POST {XAI_BASE_URL}/chat/completions` with
`Authorization: Bearer {XAI_API_KEY}`, body `{ model, messages:[{role,content}], … }`,
reply at `choices[0].message.content`. Grok is used (over Claude) because it's far less
likely to refuse the hostile persona. Model id is env-configurable (`XAI_MODEL`,
default `grok-4-1-fast`) — verify against https://docs.x.ai/docs/models.

The persona is the system message (env `SYSTEM_PROMPT`, else the built-in Gilfoyle text).

## Memory

```
conversations/{wa_id}
  messages: [ {role:"user"|"assistant", text, ts}, … ]   sliced to last 100 on every write
  expireAt:  now + 90d                                    TTL drops dead conversations
```

Stored verbatim so Gilfoyle holds a thread; the last 20 turns are sent to the model
(`CHAT_CONTEXT`) to bound token cost. One doc per conversation, capped array — the cap
*is* the cleanup. Comfortably inside Firestore's free tier.

## Dedupe

Meta delivers at-least-once with no idempotency key. `wa_dedupe/{message.id}`: atomic
create-if-not-exists claim → reply → mark done; release on failure so retries
re-process; stale `processing` claims past the lease are reclaimable. 7-day TTL.

## Daily cap (billing guardrail)

The endpoint is public by design (anyone can argue with Gilfoyle), and every reply
costs xAI tokens. `ratelimit/{wa_id}` `{day,count}` caps answers per wa_id per UTC day
(`DAILY_CAP`, default 200; set `0` to disable). Over the cap → silent (no model call,
no send). This bounds runaway spend without a hard product ceiling.

## Re-engagement poke (hourly cron)

Cloud Scheduler (free tier) POSTs `/cron` every hour. The function pokes every
conversation whose last inbound message is **23–24 hours** old and hasn't been poked
this window (`lastPokeTs < lastInboundTs`): Grok writes an unprompted, impatient,
hostile re-engagement line and sends it. The 23h timing is deliberate — it's still
**inside the 24h customer-service window**, so the message is free-form (no template),
and if the user bites, their reply resets the window for another round. Idempotent per
window; guarded by `CRON_SECRET`. (Heads-up: poking people who went quiet can draw
blocks/reports, which lower the number's WhatsApp quality rating.)

## Components

- `functions/whatsapp-webhook/index.js` — the whole bot (verify / inbound / xAI / send).
- `functions/whatsapp-webhook/test/run.mjs` — 17-check integration test (live Firestore,
  mocked xAI + Meta). `npm test`.

## Known follow-ups
- **Media** — currently non-text messages get a placeholder; could fetch + transcribe.
- **Outbound templates** — only needed if we ever push unprompted outside the 24h window.
