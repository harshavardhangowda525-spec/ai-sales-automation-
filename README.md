# Infinity Web & Apps — Sales Automation Pipeline

End-to-end automation for Infinity Web & Apps' AI cold-calling:

```
Sarvam AI call ──► POST /webhook/sarvam
                     │
                     ├─ save client + transcript (Neon Postgres)
                     ├─ GPT-4o extracts name / plan / requirements / preferred time
                     └─ if BOOKED:
                          ├─ Google Calendar event + Meet link (10 AM / 3 PM / 6 PM IST, next working day)
                          ├─ 2-page PDF proposal (IWA-YYYY-NNNN), stored in Neon, public link
                          └─ WhatsApp template message with the PDF + Meet details
                     └─ campaign stats updated → when every call is in, Sarvam phones Harsha with a summary
Dashboard (React) ── live overview, clients, client portal, campaigns
```

| Folder | What |
|---|---|
| `backend/` | Node 22 + Express + Prisma (PostgreSQL / Neon) |
| `frontend/` | React + Vite + Tailwind + Recharts dashboard |
| `render.yaml` | One-click Render Blueprint for both services |

**Test mode.** Every integration is optional. If a credential is missing, that step is skipped and logged as `*_MOCK` (shown as a "test mode" tag in the dashboard), so you can run the whole flow before connecting anything live.

---

## 1. Run locally

Requirements: Node 20+ and a Postgres database (the Neon one, or local).

```bash
cd backend
cp .env.example .env        # fill in DATABASE_URL at minimum; set NODE_ENV=development, PUBLIC_BASE_URL=http://localhost:3000
npm install
npx prisma migrate deploy   # creates tables
npm run dev                 # http://localhost:3000
```

```bash
cd frontend
cp .env.example .env        # VITE_API_URL=http://localhost:3000
npm install
npm run dev                 # http://localhost:5173
```

### Test the webhook with mock Sarvam calls

With the backend running:

```bash
cd backend
npm run test:webhook                 # or: node src/scripts/mockWebhook.js https://your-api.onrender.com
```

This creates a campaign and sends 5 calls (2 booked, 1 rejected, 1 no answer, 1 callback). It then prints each client's Meet link, proposal number and WhatsApp status, and confirms the campaign completed and triggered the summary call. Open the dashboard to see everything.

Single manual call:

```bash
curl -X POST "http://localhost:3000/webhook/sarvam?sync=1" -H "Content-Type: application/json" -d '{
  "call_id": "test-1", "phone_number": "+919845012345", "business_name": "Sri Lakshmi Sweets",
  "outcome": "BOOKED", "duration_seconds": 180, "campaign_id": "",
  "transcript": "Agent: Hi!\nCustomer: My name is Ramesh. Premium plan, evening works."
}'
```

`?sync=1` waits for the whole pipeline and returns the result. Without it, the endpoint replies `202` right away and processes in the background (this is what Sarvam uses).

---

## 2. Webhook URL for the Sarvam dashboard

```
https://<your-backend>.onrender.com/webhook/sarvam?secret=<SARVAM_WEBHOOK_SECRET>
```

Paste this into your Sarvam agent / campaign **Webhook URL** field. Sarvam does not sign webhooks, so the `secret` query parameter is what stops strangers posting fake calls. Render generates `SARVAM_WEBHOOK_SECRET` for you; copy it from the service's Environment tab. Campaigns started from the dashboard (`/api/campaign/start`) set this webhook on the campaign automatically.

The endpoint accepts **both** payload formats:

* The format in the original spec: `call_id, phone_number, business_name, outcome, transcript, duration_seconds, campaign_id`.
* Sarvam's native campaign/outbound payload: `attempt_id, user_phone_number, user_identifier, connectivity_status, duration, interaction_transcript[], output_agent_variables{...}`.

**Recommended Sarvam agent setup:** have your sales agent set these output variables at the end of each call: `outcome` (`booked` / `rejected` / `callback_later`), `business_name`, and optionally `contact_name` and `plan_interest`. If `outcome` is missing, the outcome is inferred from the transcript (needs OpenAI). Unreachable calls are marked `NO_ANSWER` automatically.

**Repeat deliveries are safe.** The same `call_id`, or a retry to the same number in the same campaign, updates the existing client instead of creating a duplicate. A client who has already booked is never downgraded, and a proposal is never sent twice automatically.

### Assistant agent: calls to Harsha (Sarvam)

One Sarvam agent makes every call to you. The backend passes `call_type` so the agent knows which script to use:

| `call_type` | When | What happens after the call |
|---|---|---|
| `summary` | Every call in a campaign is done | Nothing to decide. The report is also on the dashboard |
| `quotation` | A booked client's proposal is generated | You say **yes**: the proposal and Meet link go to the client on WhatsApp. **No**: nothing is sent |
| `website` | You click **Website ready** on a client's page | **Yes**: the client gets the live link on WhatsApp. **No**: nothing is sent |

Calls are placed **one at a time**, only between 9 AM and 9 PM IST (`OWNER_CALL_START_HOUR` / `OWNER_CALL_END_HOUR`). Missed calls are retried once after 15 minutes. If you still miss it, or don't give a clear yes or no, the item waits under **Waiting for your approval** on the dashboard, with **Approve & send**, **Reject** and **Call me again** buttons. **Resend proposal** in the dashboard is your own action, so it sends straight away without a call.

**Setup in Sarvam:**

1. Create an agent named "Infinity Assistant".
2. In its Instructions, create these input variables with `@`: `call_type`, `business_name`, `contact_name`, `plan_name`, `plan_price`, `meeting_time`, `requirements`, `website_url`, `booked_count`, `booked_names`, `callback_count`, `rejected_count`, `no_answer_count`, `meets_scheduled`.
3. On the **Variables** tab, add **output variables**:
   * `decision`: Enum with `approved`, `rejected`, `unclear`. Extraction prompt: "Did Harsha approve sending it to the client?"
   * `note`: String. Extraction prompt: "Any instruction Harsha gave, e.g. change the price".
4. Commit the agent and copy its ID into `SARVAM_ASSISTANT_AGENT_ID` (and the version into `SARVAM_ASSISTANT_AGENT_VERSION`).
5. Set `HARSHAVARDHAN_PHONE` to the number that should receive these calls.

Set `REQUIRE_QUOTATION_APPROVAL=false` if you ever want quotations sent automatically without a call.

### Second WhatsApp template: website ready

Create a second template in WhatsApp Manager. Category Utility, name `infinity_website_ready`, language English, no header. Body:

```
Hey {{1}}! 🎉

Great news — your website for *{{2}}* is live:
🌐 {{3}}

Take a look and tell us what you think. If you'd like any changes, just reply here and we'll take care of it.

*Infinity Web & Apps* — Building Bengaluru's Digital Future
```

Sample values: `Ramesh`, `Sri Lakshmi Sweets`, `https://srilakshmisweets.in`.

---

## 3. Google OAuth setup (Calendar + Meet)

1. Go to <https://console.cloud.google.com> → create a project (e.g. "Infinity Automation").
2. **APIs & Services → Library** → enable **Google Calendar API**. Meet links are created through Calendar, so no separate Meet API is needed.
3. **OAuth consent screen** → User type *External* → fill in the app name and your email → add the scopes `.../auth/calendar.events` and `.../auth/calendar.readonly` → add your Gmail as a **Test user**. Then **Publish app** (to "In production"); otherwise refresh tokens expire after 7 days. Google may show an "unverified app" warning when you approve. That's fine because it's only you.
4. **Credentials → Create credentials → OAuth client ID** → type *Web application* → under **Authorized redirect URIs** add `http://localhost:3005/oauth2callback`.
5. Copy the Client ID and Client Secret into `backend/.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=http://localhost:3005/oauth2callback`).
6. Run `cd backend && npm run google:token`, open the printed URL, sign in **with the Google account whose calendar should receive the meetings**, and approve.
7. Copy the printed `GOOGLE_REFRESH_TOKEN` into your `.env` and into Render.

Meetings are 30 minutes:

* Times are 10:00 AM for morning, 3:00 PM for afternoon and 6:00 PM for evening (IST), on the client's preferred day if one was given, otherwise the next working day (Mon–Sat by default, see `WORKING_DAYS`).
* If that slot is already busy, the event shifts by 30 minutes until it finds a free one.
* The client's requirements go in the event description.

---

## 4. Meta WhatsApp Cloud API setup

1. Go to <https://developers.facebook.com> → **My Apps → Create app** → type *Business* → add the **WhatsApp** product.
2. In **WhatsApp → API Setup**, add and verify your business phone number. That gives you `WHATSAPP_PHONE_NUMBER_ID`.
3. Create a **permanent token**: Business Settings → Users → **System users** → Add (Admin) → *Assign assets* → your app (full control) → **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management` permissions. That's `WHATSAPP_API_TOKEN`. The temporary token on the API Setup page expires after 24 hours.
4. Add a payment method in WhatsApp Manager. Business-initiated conversations are billed per message.
5. **Create the message template.** Business-initiated messages *must* use an approved template. Go to WhatsApp Manager → Message templates → Create:
   * Category: **Utility**. Marketing also works, but costs more and is more restricted.
   * Name: `infinity_proposal`, Language: **English** (`en`).
   * Header: **Document** (upload any sample PDF).
   * Body (paste exactly as below; the `{{n}}` variables are filled automatically):

```
Hey {{1}}! 👋

Thanks for your time today — really great speaking with you!

Here's your personalised website proposal for *{{2}}*:
📄 {{3}}

We've also scheduled your *FREE 30-minute consultation*:
📅 {{4}}
🔗 {{5}}

We'll walk you through exactly what your website will look like, answer all your questions, and get things moving fast! 🚀

*Infinity Web & Apps* — Building Bengaluru's Digital Future
Any questions? Just reply here! 😊
```

   Sample values for review: `Ramesh`, `Sri Lakshmi Sweets`, `https://example.com/proposal.pdf`, `Monday, 16 Nov 2026 at 6:00 PM IST`, `https://meet.google.com/abc-defg-hij`.

6. Once it's approved (usually minutes to hours), set `WHATSAPP_TEMPLATE_NAME=infinity_proposal`. If your template has no document header, set `WHATSAPP_TEMPLATE_HAS_DOCUMENT=false`.

WhatsApp downloads the PDF from `PUBLIC_BASE_URL/proposals/<id>.pdf`, so `PUBLIC_BASE_URL` must be your public Render URL.

---

## 5. Deploy to Render

The Neon database `infinity-sales-automation` (Singapore region) already exists, and its tables have been created by the migrations.

1. Push this repo to GitHub (done if you're reading this on GitHub).
2. Render → **New → Blueprint** → choose this repo → Render reads `render.yaml` and creates two services: `infinity-automation-api` (Node web service) and `infinity-automation-dashboard` (static site).
3. Fill in the prompted environment variables:
   * `DATABASE_URL`: from the Neon console → project *infinity-sales-automation* → **Connect** → copy the connection string (use the **pooled** one).
   * `PUBLIC_BASE_URL`: the API's URL, e.g. `https://infinity-automation-api.onrender.com`.
   * `FRONTEND_URL`: the dashboard's URL, e.g. `https://infinity-automation-dashboard.onrender.com`.
   * `VITE_API_URL` (on the dashboard service): the API URL again.
   * Sarvam, Google, WhatsApp and OpenAI keys, as described above.
4. Deploy. Render runs `prisma migrate deploy` before each release.
5. Open the API service → **Environment** → copy `ADMIN_TOKEN`. That's the password for the dashboard login.
6. Check `https://<api>/health`. It shows which integrations are configured.
7. Paste the webhook URL (section 2) into Sarvam.

> Use at least the Starter plan for the API. Free instances sleep after 15 minutes of inactivity, and a cold start can make Sarvam's webhook time out.

---

## API reference

All `/api/*` routes need `Authorization: Bearer <ADMIN_TOKEN>` when `ADMIN_TOKEN` is set.

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhook/sarvam` | Call outcome from Sarvam (`?secret=`, optional `?sync=1`) |
| GET | `/api/dashboard` | Totals, conversion rate, campaigns, recent clients, recent activity |
| GET | `/api/clients` | Filters: `status`, `outcome`, `campaign_id`, `plan`, `q`, `from`, `to` (YYYY-MM-DD, IST) |
| GET | `/api/clients/:id` | Full client incl. transcript, proposals, all logs |
| PATCH | `/api/clients/:id` | Update `notes`, `portal_status`, `plan_interest`, `contact_name` |
| POST | `/api/clients/:id/resend-proposal` | Regenerate PDF + resend on WhatsApp |
| POST | `/api/clients/:id/reschedule` | `{ start_time?: ISO, preferred_slot?, notify?: true }` |
| GET | `/api/campaigns` | All campaigns with stats |
| POST | `/api/campaign/start` | `{ campaign_name, agent_id?, cohort_id?, contacts?: [{phone_number, business_name}], total_calls? }` |
| PATCH | `/api/campaign/:id` | Set `total_calls` / `name` |
| POST | `/api/campaign/:id/complete` | Mark complete now + place summary call |
| POST | `/api/clients/:id/website-ready` | `{ website_url }`: queues a confirmation call to Harsha |
| GET | `/api/approvals` | Open approvals (`?status=all` for history) |
| POST | `/api/approvals/:id/approve` · `/reject` · `/call-again` | Decide from the dashboard |
| POST | `/webhook/sarvam/owner` | Result of calls to Harsha (`?secret=`) |
| GET | `/proposals/:id.pdf` | Public proposal PDF (`?download=1` to download) |
| GET | `/health` | DB + integration status |

**Starting campaigns from the dashboard.** This uses Sarvam's scheduling API:

1. Create a campaign that starts now, calls between 10:00 and 19:00 IST Mon–Sat, and runs for 7 days.
2. Stream the leads you pasted in as the campaign's cohort.

You can also create campaigns in the Sarvam dashboard directly. Just point their webhook at the URL above. Calls for an unknown Sarvam `campaign_id` automatically create a matching campaign here.

## Notes

* **Timestamps** are stored as UTC (`timestamptz`) and always displayed and scheduled in **IST (Asia/Kolkata)**.
* **Errors** from every step are written to the `call_logs` table (`*_ERROR` actions) and shown on the client page and in the activity feed. One step failing (e.g. WhatsApp) doesn't stop the others.
* **Proposal PDFs** use a 420×760pt phone-friendly page size and are stored in the `proposals` table in Neon. Each regeneration keeps the previous versions.
