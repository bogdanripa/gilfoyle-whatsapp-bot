# Deploy checklist — whatsapp-webhook

Project infra is already set up (done 2026-06-26):
- GCP project **`whatsapp-asst-bripa`** (billing: BofA `01D10F-7A8636-CF2F40`)
- APIs enabled: cloudfunctions, run, cloudbuild, artifactregistry, firestore, secretmanager
- Firestore Native DB in `eur3` + TTL policy on `expireAt` (collection `wa_dedupe`)

What's left is the deploy itself, which needs three secret values.

## 1. Create the secrets

```bash
PID=whatsapp-asst-bripa

# Meta App secret (App Dashboard → Settings → Basic → App Secret)
printf '%s' 'PASTE_META_APP_SECRET' | \
  gcloud secrets create wa-app-secret --data-file=- --project=$PID

# Routine API-trigger bearer token (shown once when the trigger was created)
printf '%s' 'PASTE_ROUTINE_TOKEN' | \
  gcloud secrets create cc-routine-token --data-file=- --project=$PID

# Routine fire URL (known)
printf '%s' 'https://api.anthropic.com/v1/claude_code/routines/trig_016Sm3srSGs8mk73hBVWWVJi/fire' | \
  gcloud secrets create cc-routine-url --data-file=- --project=$PID
```

## 2. Deploy

```bash
cd functions/whatsapp-webhook
gcloud functions deploy whatsapp-webhook \
  --gen2 --runtime=nodejs22 --region=europe-central2 \
  --source=. --entry-point=whatsapp \
  --trigger-http --allow-unauthenticated \
  --project=whatsapp-asst-bripa \
  --set-env-vars VERIFY_TOKEN=860e10b0a439082a3e36df8ea8e6690bf61d236ad26c45c5,ALLOWED_WA_ID=PASTE_YOUR_WA_ID \
  --set-secrets APP_SECRET=wa-app-secret:latest,ROUTINE_TOKEN=cc-routine-token:latest,ROUTINE_FIRE_URL=cc-routine-url:latest
```

VERIFY_TOKEN above was pre-generated. `--allow-unauthenticated` is required (Meta calls
publicly); the HMAC signature check is what secures it.

## 3. Grant the runtime SA Firestore access

Gen2 functions run on Cloud Run with the Compute Engine default SA unless overridden.
Grant it Datastore access so the dedupe writes succeed:

```bash
PID=whatsapp-asst-bripa
PNUM=$(gcloud projects describe $PID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $PID \
  --member="serviceAccount:${PNUM}-compute@developer.gserviceaccount.com" \
  --role=roles/datastore.user
```

(Also confirm that SA has `roles/secretmanager.secretAccessor`, or grant it, so the
`--set-secrets` mounts resolve.)

## 4. Point Meta at the function

Get the URL: `gcloud functions describe whatsapp-webhook --region=europe-central2 --project=whatsapp-asst-bripa --format='value(url)'`

Meta App → WhatsApp → Configuration → Webhook:
- Callback URL = the function URL
- Verify token = `860e10b0a439082a3e36df8ea8e6690bf61d236ad26c45c5`
- Subscribe to the **messages** field

## 5. Routine config (claude.ai/code) — see CLAUDE-CODE-HANDOFF.md step "Routine configuration checklist"
- Point routine at this repo, set `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`
- Add `graph.facebook.com` to Allowed domains
- Add the Graphiti connector

## 6. Confirm the round-trip
Send a text to your WhatsApp Business number → Claude should reply.
Watch logs: `gcloud functions logs read whatsapp-webhook --region=europe-central2 --project=whatsapp-asst-bripa --limit=50`
