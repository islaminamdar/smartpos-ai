# Thermal Printer Setup via PrintNode

SmartPOS.ai uses [PrintNode](https://www.printnode.com) to send ESC/POS print jobs to an 80mm thermal receipt printer from the cloud. This guide covers the full setup.

---

## Compatible Printers

Any 80mm ESC/POS thermal printer works. Tested models:

- **Epson TM-T20III** (USB/LAN, widely available)
- **Sunmi T2** (Android POS with built-in printer — use PrintNode on the host PC if attached externally)
- **Xprinter XP-58 series** (budget USB option, broadly compatible)

Any printer that speaks the ESC/POS command set over USB or LAN will work.

---

## Step 1 — Create a PrintNode Account

1. Go to [printnode.com](https://www.printnode.com) and click **Sign Up**.
2. Enter your email and a password, then confirm your email.
3. PrintNode offers a **free trial** (500 prints). After that, plans start at approximately **$5 / month** for unlimited prints on up to 5 printers.

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
3. The PrintNode client detects new printers automatically within ~30 seconds.

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

For production on Vercel, add it as an **Environment Variable** in the Vercel project settings (Settings → Environment Variables → Add). For local dev, add it to `.env.local`.

---

## Step 7 — Select the Printer in Onboarding

1. Log in as the restaurant **Owner** in SmartPOS.ai.
2. Go to **Onboarding → Pick Printer** (or Settings → Integrations → Printer).
3. The app queries PrintNode with your API key and lists all printers on the account.
4. Select the correct printer and click **Save**.

---

## Step 8 — Test Print via API

After an order is created you can trigger a manual test print:

```bash
curl -X POST https://<your-domain>/api/print \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session-token>" \
  -d '{"orderId": "<order-uuid>"}'
```

A receipt should print within a few seconds. Check the PrintNode dashboard under **Print Jobs** for status and any error messages.

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
