# IndiaMART Lead Qualification CRM

A full-stack CRM webapp that connects to IndiaMART's API, qualifies leads with AI, sends emails with PDF + signature, tracks replies and followups, and exports everything as CSV.

---

## Features

- **IndiaMART Pull API sync** — fetches new leads automatically (last 7 days)
- **AI Lead Scoring** — Claude AI scores each lead 0–100, marks Hot / Warm / Cold
- **Email composer** — sends email with your brochure PDF + signature GIF attached
- **Bulk Mail** — pick one or more lead groups (Hot / Warm / Cold / New), preview the recipient list, write one email with `{{name}}` / `{{company}}` / `{{product}}` placeholders, and send to everyone in the group in one click
- **Reply inbox** — log incoming replies; lead status auto-updates to "Replied"
- **Followup scheduler** — set dates per lead, overdue alerts on sidebar, one-click "Mail" button from the followup row
- **Client status** — Prospect → Replied → Negotiating → Client → Lost (manual + auto)
- **CSV export** — download all leads with full data

---

## Setup

### Step 1: Install Node.js
Download from https://nodejs.org (v18 or higher)

### Step 2: Install dependencies
Open a terminal in this folder and run:
```
npm install
```

### Step 3: Start the server
```
npm start
```

You will see: `🚀 IndiaMART CRM running at http://localhost:3000`

### Step 4: Open the app
Go to http://localhost:3000 in your browser.

---

## Configuration (inside the app)

Go to **Settings** tab:

| Setting | Where to get it |
|---|---|
| IndiaMART API Key | seller.indiamart.com → Lead Manager → CRM Integration → Generate API Key (requires Paid Seller account) |
| Anthropic API Key | console.anthropic.com → API Keys |
| SMTP Host/User/Pass | Your email provider (Gmail: use App Password) |
| Signature GIF/PNG | Upload your email signature image |
| Brochure PDF | Upload your company/product brochure |

### Gmail SMTP setup
- Host: `smtp.gmail.com`
- Port: `587`
- User: your Gmail address
- Pass: Create an App Password at myaccount.google.com → Security → 2-Step Verification → App passwords

---

## IndiaMART API Notes

- Requires a **Paid Seller account** on IndiaMART
- Pull API fetches leads from the **last 7 days** (IndiaMART's max window)
- Click **Sync IndiaMART** in the sidebar to fetch new leads
- Duplicate leads are automatically filtered out

---

## Using Bulk Mail

1. Go to **Bulk Mail** in the sidebar.
2. Click one or more group cards (Hot / Warm / Cold / New) — every lead in those groups with a valid email is auto-selected.
3. Click **Show / edit list** if you want to uncheck specific leads before sending.
4. Write your Subject and Body. Use `{{name}}`, `{{company}}`, `{{product}}` — each lead automatically gets their own values substituted in.
5. Choose whether to attach the brochure PDF / signature.
6. Click **Send to group**. Every email is logged against its lead (so the lead's detail view shows "Sent" and the email thread), and if SMTP is configured in Settings it is actually delivered — otherwise it's logged only, with no real email required.
7. Once a customer replies, go to **Email Inbox → Log reply** (or open the lead and check the thread) to mark that lead's client status as "Replied" automatically.

---

## Folder structure

```
indiamart-crm/
├── server/
│   ├── index.js       ← Express backend
│   ├── data.json      ← All leads, emails, followups (auto-created)
│   └── settings.json  ← Your API keys and config (auto-created)
├── public/
│   ├── index.html     ← The full webapp UI
│   └── assets/        ← Uploaded signature + brochure files
├── package.json
└── README.md
```

---

## Running on a server (optional)

If you want this accessible from anywhere (not just your laptop):
1. Deploy to any VPS (DigitalOcean, AWS, etc.)
2. Run `npm start` and keep it running with `pm2 start server/index.js`
3. Add Nginx reverse proxy for HTTPS
