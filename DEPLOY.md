# Deploy checklist — whatsapp-webhook

Infra already set up (2026-06-26):
- GCP project **`whatsapp-asst-bripa`** (billing: BofA `01D10F-7A8636-CF2F40`)
- APIs enabled: cloudfunctions, run, cloudbuild, artifactregistry, firestore, secretmanager
- Firestore Native DB in `eur3` + TTL on `expireAt` (collection `wa_dedupe`)

See [DESIGN.md](DESIGN.md) for the architecture. Below is the operational sequence.

## What lives where (after the mode refactor)

**Function-side** (this Cloud Function):
- env: `VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `DEFAULT_MODE=eugene` (optional)
- secrets: `APP_SECRET`, `SEND_SECRET`, `WHATSAPP_TOKEN`
- The WhatsApp token now lives ONLY here (the function forwards replies to Meta).

**Firestore** (data-driven, no redeploy to change):
- `modes/{work,eugene}` — fireUrl + inline routine token + rateLimitPerDay + persona
- `users/{wa_id}` — mode mapping; absent ⇒ `DEFAULT_MODE`
- `conversations`, `wa_dedupe`, `ratelimit` — created on first write

**Routine-side** (BOTH the work and eugene routines):
- env: `WHATSAPP_SEND_URL` (function `/send`), `WHATSAPP_SEND_SECRET` (= `SEND_SECRET`)
- Allowed domains: the function host (`*.cloudfunctions.net`) — NOT graph.facebook.com anymore

## 1. Add the TTL policy for conversations (one-time)

```bash
PID=whatsapp-asst-bripa
gcloud firestore fields ttls update expireAt --collection-group=conversations --enable-ttl --project=$PID --async
```

## 2. Create the function secrets

```bash
PID=whatsapp-asst-bripa
printf '%s' 'PASTE_META_APP_SECRET' | gcloud secrets create wa-app-secret  --data-file=- --project=$PID
printf '%s' 'CHOOSE_A_LONG_RANDOM_STRING' | gcloud secrets create wa-send-secret --data-file=- --project=$PID  # = SEND_SECRET, also goes in routine env
printf '%s' 'PASTE_WHATSAPP_TOKEN' | gcloud secrets create wa-token      --data-file=- --project=$PID
```

(Generate the send secret with `openssl rand -hex 24`.)

## 3. Deploy

```bash
cd functions/whatsapp-webhook
gcloud functions deploy whatsapp-webhook \
  --gen2 --runtime=nodejs22 --region=europe-central2 \
  --source=. --entry-point=whatsapp \
  --trigger-http --allow-unauthenticated \
  --project=whatsapp-asst-bripa \
  --set-env-vars VERIFY_TOKEN=860e10b0a439082a3e36df8ea8e6690bf61d236ad26c45c5,WHATSAPP_PHONE_NUMBER_ID=PASTE_PHONE_NUMBER_ID,DEFAULT_MODE=eugene \
  --set-secrets APP_SECRET=wa-app-secret:latest,SEND_SECRET=wa-send-secret:latest,WHATSAPP_TOKEN=wa-token:latest
```

VERIFY_TOKEN above was pre-generated. `--allow-unauthenticated` is required (Meta + the
routine call publicly); HMAC (inbound) and `SEND_SECRET` (`/send`) are what secure it.

## 4. Grant the runtime SA Firestore + Secret access

```bash
PID=whatsapp-asst-bripa
PNUM=$(gcloud projects describe $PID --format='value(projectNumber)')
SA="${PNUM}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PID --member="serviceAccount:$SA" --role=roles/datastore.user
gcloud projects add-iam-policy-binding $PID --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
```

## 5. Get the function URL

```bash
gcloud functions describe whatsapp-webhook --region=europe-central2 --project=whatsapp-asst-bripa --format='value(url)'
```
- Meta callback URL = that URL (the root)
- `WHATSAPP_SEND_URL` (routine env) = that URL + `/send`

## 6. Create the two routines (claude.ai/code)

- **Work routine** = your existing `trig_016Sm3srSGs8mk73hBVWWVJi` (keeps Gmail/Drive/etc.).
- **Eugene routine** = a NEW routine with **no connectors** (the isolation boundary).
- Both: point at this repo (for the whatsapp-send skill); set env `WHATSAPP_SEND_URL`,
  `WHATSAPP_SEND_SECRET`; add the function host to Allowed domains.
- Routine prompt (both can share): *"Read the incoming WhatsApp message (it includes any
  persona, the conversation so far, and the new message). Do what it asks within your
  abilities, then send exactly one reply with the whatsapp-send skill:
  `./whatsapp-send.sh <reply_to_wa_id> "<reply>"`."* The Eugene character comes from the
  mode's `persona` field, injected by the function — no need to bake it into the routine.

## 7. Seed the Firestore mode config

```bash
cd functions/whatsapp-webhook
GOOGLE_CLOUD_PROJECT=whatsapp-asst-bripa \
WORK_FIRE_URL='https://api.anthropic.com/v1/claude_code/routines/trig_016Sm3srSGs8mk73hBVWWVJi/fire' \
WORK_TOKEN='PASTE_WORK_ROUTINE_TOKEN' \
EUGENE_FIRE_URL='https://api.anthropic.com/v1/claude_code/routines/trig_<EUGENE>/fire' \
EUGENE_TOKEN='PASTE_EUGENE_ROUTINE_TOKEN' \
WORK_WA_ID='PASTE_YOUR_WA_ID' \
node scripts/seed.mjs
```

## 8. Point Meta at the function

Meta App → WhatsApp → Configuration → Webhook:
- Callback URL = function URL (root)
- Verify token = `860e10b0a439082a3e36df8ea8e6690bf61d236ad26c45c5`
- Subscribe to the **messages** field

## 9. Confirm
- From your number → routed to **work** mode → Claude (with your connectors) replies.
- From any other number → **eugene** mode → chatty persona, no access to your stuff, capped/day.
- Logs: `gcloud functions logs read whatsapp-webhook --region=europe-central2 --project=whatsapp-asst-bripa --limit=50`
