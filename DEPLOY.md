# Deploy checklist — whatsapp-webhook (Grok / Gilfoyle bot)

Infra already set up (2026-06-26):
- GCP project **`whatsapp-asst-bripa`** (billing: BofA `01D10F-7A8636-CF2F40`)
- APIs enabled: cloudfunctions, run, cloudbuild, artifactregistry, firestore, secretmanager
- Firestore Native DB in `eur3` + TTL on `expireAt` (collection `wa_dedupe`)

See [DESIGN.md](DESIGN.md) for the architecture.

## Config

**Function env:** `VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `XAI_MODEL` (optional,
default `grok-4.3`), `DAILY_CAP` (optional, default 200; `0` = unlimited),
`SYSTEM_PROMPT` (optional override).
**Function secrets:** `APP_SECRET`, `WHATSAPP_TOKEN`, `XAI_API_KEY`.

No routines, no skill, no modes — the function talks to xAI and Meta directly.

## 1. Conversations TTL (one-time)

```bash
PID=whatsapp-asst-bripa
gcloud firestore fields ttls update expireAt --collection-group=conversations --enable-ttl --project=$PID --async
```

## 2. Create the secrets

```bash
PID=whatsapp-asst-bripa
printf '%s' 'PASTE_META_APP_SECRET' | gcloud secrets create wa-app-secret --data-file=- --project=$PID
printf '%s' 'PASTE_WHATSAPP_TOKEN' | gcloud secrets create wa-token      --data-file=- --project=$PID
printf '%s' 'PASTE_XAI_API_KEY'    | gcloud secrets create xai-key       --data-file=- --project=$PID
printf '%s' "$(openssl rand -hex 24)" | gcloud secrets create cron-secret --data-file=- --project=$PID
```

## 3. Deploy

```bash
cd functions/whatsapp-webhook
gcloud functions deploy whatsapp-webhook \
  --gen2 --runtime=nodejs22 --region=europe-central2 \
  --source=. --entry-point=whatsapp \
  --trigger-http --allow-unauthenticated \
  --project=whatsapp-asst-bripa \
  --set-env-vars VERIFY_TOKEN=PICK_A_RANDOM_STRING,WHATSAPP_PHONE_NUMBER_ID=PASTE_PHONE_NUMBER_ID,XAI_MODEL=grok-4.3,DAILY_CAP=200 \
  --set-secrets APP_SECRET=wa-app-secret:latest,WHATSAPP_TOKEN=wa-token:latest,XAI_API_KEY=xai-key:latest,CRON_SECRET=cron-secret:latest
```

`--allow-unauthenticated` is required (Meta calls publicly); the HMAC signature check secures
the webhook and `CRON_SECRET` secures `/cron`.

## 4. Grant the runtime SA Firestore + Secret access

```bash
PID=whatsapp-asst-bripa
PNUM=$(gcloud projects describe $PID --format='value(projectNumber)')
SA="${PNUM}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PID --member="serviceAccount:$SA" --role=roles/datastore.user
gcloud projects add-iam-policy-binding $PID --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
```

## 5. Point Meta at the function

```bash
gcloud functions describe whatsapp-webhook --region=europe-central2 --project=whatsapp-asst-bripa --format='value(url)'
```
Meta App → WhatsApp → Configuration → Webhook:
- Callback URL = that URL
- Verify token = the same string you set for `VERIFY_TOKEN` above (generate one with `openssl rand -hex 24`)
- Subscribe to the **messages** field

## 6. Hourly re-engagement cron (free)

Cloud Scheduler (free tier: 3 jobs/month) hits `/cron` every hour; the function pokes
anyone whose last message is 23–24h old — still inside the 24h window, so it's free-form.

```bash
PID=whatsapp-asst-bripa
gcloud services enable cloudscheduler.googleapis.com --project=$PID
CRON_SECRET=$(gcloud secrets versions access latest --secret=cron-secret --project=$PID)
gcloud scheduler jobs create http gilfoyle-hourly-poke \
  --location=europe-central2 --schedule="0 * * * *" --time-zone="Europe/Bucharest" \
  --uri="$(gcloud functions describe whatsapp-webhook --region=europe-central2 --project=$PID --format='value(url)')/cron" \
  --http-method=POST --headers="x-cron-secret=$CRON_SECRET" --attempt-deadline=120s --project=$PID
```

## 7. Confirm
Message the WhatsApp Business number → Grok-as-Gilfoyle insults you back.
Logs: `gcloud functions logs read whatsapp-webhook --region=europe-central2 --project=whatsapp-asst-bripa --limit=50`

## Values still needed from you
`APP_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (Meta), and `XAI_API_KEY` (xAI console).
`VERIFY_TOKEN` is any string you choose (it must match what you enter in the Meta webhook
config). `XAI_MODEL` defaults to `grok-4.3` — the cheapest model that supports the Responses
API (`previous_response_id`); the absolute-cheapest `grok-build-0.1` does not. Confirm the
exact id in your xAI console.
