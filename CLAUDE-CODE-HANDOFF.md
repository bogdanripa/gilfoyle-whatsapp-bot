# Handoff

Current docs:
- **[DESIGN.md](DESIGN.md)** — architecture.
- **[DEPLOY.md](DEPLOY.md)** — deploy sequence + what's still needed from you.

This started as a Claude Code routine + WhatsApp bridge with per-user modes and Graphiti
memory. It was deliberately simplified to: **a single Cloud Function that answers WhatsApp
messages directly via the xAI (Grok) API, as one persona — Gilfoyle.** No routines (no run
quota), no skill, no modes. Firestore keeps conversation memory + dedupe + a billing cap.
See git history for the earlier designs.
