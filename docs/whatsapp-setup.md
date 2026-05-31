# WhatsApp Cloud API — Tenant Setup Guide

This guide walks you (or the restaurant owner) through connecting Meta WhatsApp Cloud API to a SmartPOS.ai tenant.

---

## Prerequisites

- A Meta Business account
- A Facebook developer account linked to that business
- A phone number that can receive SMS/voice calls (for verification)
- Your SmartPOS.ai tenant dashboard access (Owner role)

---

## Step 1 — Create a Meta Business Account

1. Go to [business.facebook.com](https://business.facebook.com).
2. Click **Create account** and follow the prompts.
3. Complete Business Verification if Meta prompts you (required for production send-limits).

---

## Step 2 — Create a Meta Developer App with WhatsApp

1. Go to [developers.facebook.com](https://developers.facebook.com) and log in.
2. Click **My Apps → Create App**.
3. Select **Business** as the app type, then click **Next**.
4. Enter an app name (e.g. `SmartPOS-YourRestaurant`), choose the business account from Step 1, then click **Create app**.
5. From the app dashboard, scroll to **Add products to your app** and click **Set up** next to **WhatsApp**.

---

## Step 3 — Get the Test Phone Number ID and Temporary Access Token (Demo only)

> Use this for sandbox testing only. Tokens expire in 24 hours.

1. In the left sidebar choose **WhatsApp → API Setup**.
2. Under **Send and receive messages**, note:
   - **Phone Number ID** — copy this value (format: `1234567890123456`)
   - **Temporary access token** — click the copy icon next to "Temporary access token"
3. Paste both values into `.env.local`:
   ```
   META_WHATSAPP_PHONE_NUMBER_ID=<Phone Number ID>
   META_WHATSAPP_TOKEN=<Temporary access token>
   ```

---

## Step 4 — Go Live: Add the Restaurant's Real Number

1. In **WhatsApp → API Setup**, click **Add phone number**.
2. Enter the restaurant's WhatsApp-eligible number and complete the OTP verification.
3. Create a **System User** with admin rights in your Business Manager:
   - Business Settings → Users → System Users → Add → Admin
4. Assign the WhatsApp app to the System User with **full control**.
5. Click **Generate New Token** on the System User, select your app, grant `whatsapp_business_messaging` and `whatsapp_business_management` permissions, then copy the token.
6. Replace the temporary token with this permanent token in your env / Supabase secrets:
   ```
   META_WHATSAPP_TOKEN=<permanent System User token>
   META_WHATSAPP_PHONE_NUMBER_ID=<production Phone Number ID>
   ```

---

## Step 5 — Configure the Webhook

1. In **WhatsApp → Configuration**, find the **Webhook** section and click **Edit**.
2. Set **Callback URL** to:
   ```
   https://<your-domain>/api/whatsapp/webhook
   ```
3. Set **Verify token** to the same value as `META_WEBHOOK_VERIFY_TOKEN` in your environment (choose any secret string, e.g. `smartpos_verify_2026`).
4. Click **Verify and Save** — Meta will send a GET request; the SmartPOS.ai webhook handler will echo the challenge.

---

## Step 6 — Subscribe to Messages Events

1. After the webhook is verified, still in **WhatsApp → Configuration**, click **Manage** next to **Webhook fields**.
2. Subscribe to the **messages** field.
3. Click **Done**.

---

## Step 7 — Connect in SmartPOS.ai

1. Log in as the restaurant **Owner**.
2. Go to **Onboarding → Connect WhatsApp** (or Settings → Integrations → WhatsApp).
3. Enter:
   - **Phone Number ID** — from Step 3 or Step 4
   - **Access Token** — your permanent System User token
4. Click **Save & Test**. The app sends a test message to the registered number to confirm connectivity.

---

## Environment Variables Reference

| Variable | Where to find it |
|---|---|
| `META_WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → Phone Number ID |
| `META_WHATSAPP_TOKEN` | System User token (Step 4) |
| `META_WEBHOOK_VERIFY_TOKEN` | Your own secret — set it first, then paste into Meta dashboard |

---

## Reference

- Meta WhatsApp Cloud API docs: https://developers.facebook.com/docs/whatsapp/cloud-api
- System Users guide: https://developers.facebook.com/docs/marketing-api/system-users
