# Gilfoyle — a WhatsApp bot whose only skill is being an asshole

A WhatsApp chatbot that answers every message with short, hostile, sweary one-liners —
in whatever language you write to it. It's a modern remake of **MGonz**, the 1989 bot by
Mark Humphrys that "passed" as human by being rude enough that people argued back instead
of testing whether it was a machine (the story is told in Brian Christian's *The Most
Human Human*). Same psychological exploit, except now there's a frontier model behind the
insults.

Inspired by Gilfoyle's chatbot in HBO's *Silicon Valley*.

## How it works

```
WhatsApp → Meta Cloud API ──webhook──► Google Cloud Function:
  verify HMAC → dedupe → daily cap → read history
  → xAI (Grok) chat/completions (system = Gilfoyle persona + last 20 turns)
  → mark read + "typing…" → send reply back to Meta → log the turn
```

One self-contained gen2 Cloud Function. No server, no Claude routine, no quota worries —
just a per-token API call to Grok.

- **Brain:** xAI / Grok (picked because it'll happily swear when prompted).
- **Glue:** a single Google Cloud Function (free tier).
- **Channel:** a WhatsApp Business (Cloud API) number.
- **Memory + dedupe + rate cap:** Firestore (free tier).
- **Built entirely with [Claude Code](https://claude.com/claude-code)** — not a line of code written by hand.

## Notable details

- **Language mirroring** — replies in whatever language you message it in (Romanian in,
  Romanian out), just as rude.
- **Read receipt + typing indicator** — it reads you, then makes you watch it "think"
  before insulting you. Sells the illusion.
- **Conversation memory** — last 100 turns per chat (self-pruning, 90-day TTL in Firestore).
- **`/clear` command** — send `/clear` to wipe the current chat's memory and start fresh
  (costs no Grok tokens; works even when over the daily cap).
- **Dedupe** — Meta delivers webhooks at-least-once; a doc per `message.id` prevents
  double-replies.
- **Daily cap** — `DAILY_CAP` messages/sender/day (default 200) so nobody runs up the
  Grok bill by arguing with it for 75 minutes (looking at you, original MGonz victim).
- **Re-engagement poke** — an hourly Cloud Scheduler cron messages anyone who's gone
  quiet for ~23 hours (still inside the 24h window, so no template needed). Gilfoyle
  doesn't let you ghost him.

## Repo

```
functions/whatsapp-webhook/
  index.js          the whole bot
  test/run.mjs       integration test (live Firestore + mocked Grok/Meta) — `npm test`
DESIGN.md            architecture
DEPLOY.md            deploy steps (GCP + Firestore + Meta)
```

All secrets live in Google Secret Manager — none are committed here.

## Deploy

See [DEPLOY.md](DEPLOY.md). Short version: enable the GCP APIs, create a Firestore DB,
store four secrets (`APP_SECRET`, `WHATSAPP_TOKEN`, `XAI_API_KEY`, plus a `VERIFY_TOKEN`),
deploy the function, register your WhatsApp number, and point the Meta webhook at it.

## License

MIT.
