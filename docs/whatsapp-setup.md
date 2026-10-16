# WhatsApp Cloud API — Legacy Integration Reference

**WhatsApp ordering is not available in the current hosted POS release.** Both hosted release modes block the legacy onboarding, tenant WhatsApp configuration and webhook routes. The webhook is also disabled by default. This document describes the existing legacy code; it is not an activation or production-readiness checklist.

## What the existing Connect button does

The legacy onboarding component has a **Connect** button, not **Save & Test**. It submits a Phone Number ID and access token to `/api/tenant/whatsapp`, which attempts to store them on the signed-in tenant. It does not validate the credentials with Meta or send a test message.

The component advances without checking the HTTP response status, and the endpoint does not check the database update error. Reaching the next onboarding step or receiving an `ok` response therefore does not establish that credentials were saved, that WhatsApp is connected, or that a message was delivered. Its automatic-reply promise must not be used as evidence of availability.

## Configuration consumed by the code

| Setting | Purpose and current behavior |
|---|---|
| Tenant `whatsapp_phone_number_id` | The webhook uses this stored value to match incoming messages to a tenant. The outbound sender also uses the tenant's stored value. |
| Tenant `whatsapp_access_token` | The outbound sender reads this tenant credential from the database. Keep real tokens out of documentation, source control and public assets. |
| `ENABLE_LEGACY_WHATSAPP_WEBHOOK` | The webhook handlers return 404 unless this server environment variable is exactly `true`. This setting alone does not open the routes blocked by the hosted release allowlist. |
| `META_WEBHOOK_VERIFY_TOKEN` | A separately chosen server secret used for the GET subscription challenge. An enabled handler returns 503 when it is absent. A matching `hub.verify_token` and `hub.mode=subscribe` are required. |
| `META_APP_SECRET` | Server secret used to authenticate incoming POST requests. An enabled handler returns 503 when it is absent. |

Setting `META_WHATSAPP_PHONE_NUMBER_ID` or `META_WHATSAPP_TOKEN` alone does not configure this tenant flow: the current inbound handler and outbound sender consume the database fields listed above.

## Webhook authentication

The legacy callback path is `/api/whatsapp/webhook`. GET verification and POST authentication serve different purposes: passing the subscription challenge does not authenticate later messages.

For POST requests, the handler requires an `x-hub-signature-256` header in the form `sha256=` followed by 64 lowercase hexadecimal characters. It computes HMAC-SHA256 over the raw request body using `META_APP_SECRET` and compares signatures with a timing-safe comparison before parsing or processing the payload. Missing, malformed or incorrect signatures return 403. The handler also limits the body to 1,000,000 bytes.

Do not disable these checks to make a test request succeed. A future activation needs a separately reviewed release change, appropriate tenant credentials, and controlled end-to-end verification of configuration persistence, signed inbound messages and outbound delivery. None of those outcomes is established by clicking **Connect**.

## Sources and provider reference

This document reflects the repository behavior in:

- `lib/pos/public-release.ts` — hosted route allowlist.
- `components/onboarding/WhatsAppLinkStep.tsx` — legacy Connect interface.
- `app/api/tenant/whatsapp/route.ts` — tenant credential update.
- `app/api/whatsapp/webhook/route.ts` — default-off gate, GET verification and POST HMAC validation.
- `lib/whatsapp/handler.ts` and `lib/whatsapp/client.ts` — tenant configuration and outbound request.

Before any future activation, check Meta's current requirements and grant only the permissions needed for the intended workflow. Provider setup screens, token lifetimes and production eligibility have not been verified as part of this repository documentation update.

- [Meta WhatsApp Cloud API documentation](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Meta System Users documentation](https://developers.facebook.com/docs/marketing-api/system-users)
