# Architecture

Two-way WhatsApp assistant. You (and anyone else) message a WhatsApp Business number;
a Claude Code **routine** generates the reply. A GCP Cloud Function is the bridge.

## The constraint that shapes everything

The routine `/fire` endpoint is **fire-and-forget** — it returns once the session is
created, never the assistant's output, and every fire is a **fresh session with no
history**. Consequences:

1. The reply can't ride back on the HTTP response → the routine sends it out itself,
   by POSTing to the function's `/send` route.
2. The routine remembers nothing between messages → the function injects prior turns
   into each fire, from a transcript it keeps in Firestore.

## Flow

```
INBOUND   WhatsApp → Meta → Function POST /:
  verify HMAC → dedupe (wa_dedupe) → resolve mode (users → modes)
  → rate-limit check (capped modes) → read history (conversations)
  → fire mode.fireUrl with (persona + history + new message)
  → on success: log inbound + mark done | on failure: release claim (Meta retries)

OUTBOUND  Routine → Function POST /send  {to, text}  (x-send-secret header):
  → log assistant reply (conversations) → forward to Meta Graph API
```

The function is the single writer of memory and the only holder of the WhatsApp token.

## Modes (per-user behaviour + the isolation boundary)

Each `wa_id` maps to a **mode**; each mode is **its own routine**. This is a real
security boundary, not a prompt switch: a stranger's message can only reach the
`eugene` routine, which has **no connectors** — nothing of yours to access even if the
prompt is fully hijacked. Your number maps to `work` (Gmail, Drive, brokerage, …).

Mode config lives in Firestore so adding/repointing a mode is a data change, no redeploy:

```
modes/{id}
  fireUrl          routine /fire endpoint
  token            routine bearer token (inline — see trade-off note)
  rateLimitPerDay  0 = unlimited (work); N = cap per wa_id per UTC day (eugene)
  persona          text prepended to every fire (e.g. Eugene's character)
  rateLimitMessage one-a-day brush-off sent when a capped user is over limit
  enabled
users/{wa_id}      → { mode }            absent ⇒ config/app.defaultMode (env DEFAULT_MODE)
```

**Token trade-off (chosen):** the routine bearer token is stored inline in the mode doc
for full data-driven simplicity. Firestore is IAM-protected but not an encrypted secret
store, so the token is plaintext at rest. Accepted deliberately for this personal setup.

## Memory

```
conversations/{wa_id}
  messages: [ {role:"user"|"assistant", text, ts}, … ]   sliced to last 100 on every write
  expireAt:  now + 90d                                    TTL drops dead conversations
```

One doc per conversation, capped array. The cap *is* the cleanup — no cron, no batch
deletes. A round-trip is ~2 reads + 2 writes, against Firestore's free 50k reads / 20k
writes **per day**. Free forever for a personal assistant.

## Dedupe

Meta has no idempotency key and delivers at-least-once. `wa_dedupe/{message.id}`:
atomic create-if-not-exists claim → fire → mark done; release on failure so retries
re-fire; a stale `processing` claim past the lease is reclaimable (survives a crash
mid-fire). 7-day TTL.

## Rate limiting

`ratelimit/{wa_id}` `{ day, count, notified }`, reset per UTC day. Over the cap →
one brush-off message that day, then silent. Protects your routine run-quota from
strangers/spam (each fire is a full cloud session).

## Components

- `functions/whatsapp-webhook/index.js` — the bridge (verify / inbound / `/send`).
- `functions/whatsapp-webhook/scripts/seed.mjs` — seed mode + user docs.
- `functions/whatsapp-webhook/test/run.mjs` — 20-check integration test (live Firestore,
  mocked routine + Meta). `npm test`.
- `.claude/skills/whatsapp-send/` — skill the routine uses to POST `/send`.

## Known follow-ups
- **Media** — handle image/audio/document (fetch via `GET /{media-id}`).
- **Hybrid for chattiness** — answer trivial Eugene turns straight from the function via
  the Messages API instead of spinning a routine, to save quota.
- **Outbound templates** — for scheduled pushes outside the 24h window.
