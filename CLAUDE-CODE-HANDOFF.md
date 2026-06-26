# Handoff

The original handoff has been superseded. Current docs:

- **[DESIGN.md](DESIGN.md)** — architecture (modes, memory, dedupe, rate limiting, `/send`).
- **[DEPLOY.md](DEPLOY.md)** — operational deploy sequence (GCP + Firestore + routines + Meta).

Key shifts from the original plan:
- Memory is a Firestore transcript (last 100/conversation), **not** Graphiti.
- Per-user **modes**, each its own routine — `work` (your connectors) vs sandboxed
  `eugene` (default for strangers). Real isolation boundary.
- The routine replies via the function's `/send` route; the WhatsApp token lives
  only in the function. `graph.facebook.com` is no longer on the routine allowlist.
- `ALLOWED_WA_ID` is gone — access is open, with mode + per-wa_id rate limiting.
