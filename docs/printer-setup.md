# Legacy PrintNode setup reference — not a verified POS printing path

This guide describes a legacy cloud-print integration in `lib/printing/printnode.ts`, not the released `/counter` or native offline printer workflow. Those legacy routes are outside the POS release allowlist. The online pilot uses browser Print/save PDF; physical receipt/kitchen delivery remains unverified. Native Android printer adapters and a durable print/reprint queue are pending. Do not enable legacy routes or buy hardware on the strength of this guide. See [launch readiness](plans/2026-10-16-launch-readiness.md).

The historical setup steps below require fresh provider/documentation review before reuse; their menu names and platform procedures are not current acceptance evidence.

---

## Hardware acceptance required

No printer model is certified or recorded as physically tested by this project audit. Previous Epson/Sunmi/Xprinter examples were unverified and have been removed. ESC/POS support alone does not establish Android transport, built-in printer SDK, paper-width, Arabic glyph, cutter or drawer compatibility.

Select the actual connection/model and verify receipt layout, paper-out/disconnect, restart, retry/reprint labeling, kitchen additions/withdrawals and actual paper delivery. A provider accepting a job or a browser opening its print dialog is not proof that paper printed.

---

## Step 1 — Create a PrintNode Account

1. Go to [printnode.com](https://www.printnode.com) and click **Sign Up**.
2. Enter your email and a password, then confirm your email.
3. Review current provider pricing and terms before any purchase; no current price or plan is verified here.

---

## Step 2 — Install the PrintNode Client

The PrintNode Client runs as a background service on the machine connected to the printer.

1. After logging in, go to **Downloads** in the PrintNode dashboard.
2. Download the installer for your OS:
   - **Windows**: `.exe` installer — run it, sign in with your PrintNode credentials when prompted.
   - **macOS**: `.dmg` — drag to Applications, open, sign in.
   - **Linux**: `.deb` / `.rpm` — install and run `printnode-client`, sign in.
3. The client starts automatically on login and stays running in the system tray.

---

## Step 3 — Connect the Thermal Printer

1. Plug the printer into the machine via **USB** (recommended) or connect it to the same LAN segment and note its IP address.
2. Turn the printer on.
3. Check whether the selected printer is detected; no discovery time or compatibility is guaranteed here.

---

## Step 4 — Verify the Printer in the Dashboard

1. In the PrintNode web dashboard, navigate to **Printers**.
2. Your printer should appear with a green status dot and its model name.
3. Optionally send a **test print** from the dashboard (Printers → Actions → Test Print) to confirm end-to-end connectivity before proceeding.

---

## Step 5 — Generate an API Key

> Only account admins can create API keys.

1. In the PrintNode dashboard, go to **Account → API Keys**.
2. Click **Create API Key**, give it a label (e.g. `smartpos-production`), and click **Create**.
3. Copy the API key immediately — it is only shown once.

---

## Step 6 — Add the API Key to SmartPOS.ai

Add the key to your environment:

```
PRINTNODE_API_KEY=<your-api-key>
```

This repository’s current deployment uses direct SSH, not the former Vercel instructions. Any future integration must keep secrets in private server configuration and pass the POS authorization/release review first. Setting a key alone does not enable a supported printing workflow.

---

## Step 7 — Select the Printer in Onboarding

1. Log in as the restaurant **Owner** in SmartPOS.ai.
2. Go to **Onboarding → Pick Printer** (or Settings → Integrations → Printer).
3. The app queries PrintNode with your API key and lists all printers on the account.
4. Select the correct printer and click **Save**.

---

## Step 8 — Test Print via API

Historical API example only: `/api/print` is not an enabled live POS route. Do not run this against a restaurant order as an acceptance test:

```bash
curl -X POST https://<your-domain>/api/print \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session-token>" \
  -d '{"orderId": "<order-uuid>"}'
```

For a future authorized synthetic integration test, inspect both provider status and the physical paper. Neither timing nor delivery is established by this historical example.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Printer not listed in app | Confirm PrintNode client is running and printer shows green in dashboard |
| Print job queued but nothing prints | Verify printer is online and has paper; check Print Jobs → status in dashboard |
| Wrong paper width | Ensure printer paper size is set to 80mm in the printer driver (Windows: Devices → Printer Properties → Paper) |
| API key error | Confirm `PRINTNODE_API_KEY` is set in the correct environment (production vs. preview) |

---

## Reference

- PrintNode API docs: https://www.printnode.com/en/docs/api/curl
- PrintNode client downloads: https://www.printnode.com/en/download
