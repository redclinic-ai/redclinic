# RedClinic founding clinic pilot — application form

Live at **redclinicwaitlist.navapilot.com** (Netlify).

Three questions, one per screen:

1. Doctor / clinic owner / none. "None" shows *This form is not for you* and sends the visitor to navapilot.com after 5 seconds.
2. Name, contact number (+91, 10 digits), clinic name.
3. What RedClinic should do (10 outcomes, choose any; "Select all" available).

Then **Submit Application** → "Application received. If your clinic is selected for the pilot, our team will contact you." The RedClinic logo appears only on this last screen. "11 founding clinic seats remaining" shows on the first and last screens; change `SEATS` at the top of `public/app.js`.

## How applications are saved

Every submission goes to two places at once, and the success screen only appears once at least one confirms:

| Where | What you get |
|---|---|
| **Netlify Function → Netlify Blobs** (`/api/apply`) | One record per mobile number (re-applying updates it, keeps the reference and first date). Reference like `RC-7K2M9Q`. Download all as CSV: `https://redclinicwaitlist.navapilot.com/api/applications?key=YOUR_ADMIN_KEY` (add `&format=json` for JSON). |
| **Netlify Forms** (`pilot-application`) | Each submission in Netlify → Forms, with optional email notifications. |

If both fail (no internet), the answers stay on the phone, the visitor sees a retry message, and the app re-sends automatically on their next visit. UTM tags and fbclid/gclid from ads are saved with each application. A hidden honeypot field and a minimum time on the form filter bots.

## Deploy (first time)

1. **Netlify → Add new site → Import from Git →** `redclinic-ai/redclinic`, branch `waitlist`.
   - Base directory: `waitlist` (build command and publish folder come from `netlify.toml`).
   - Or from a computer: `cd waitlist && npm install && npx netlify-cli deploy --prod`.
2. **Site configuration → Environment variables:** add `ADMIN_KEY` = a long random password (used for the CSV download link).
3. **Forms → Enable form detection**, then redeploy once. Under Forms → Notifications, add an email notification to hello@redclinic.in.
4. **Domain management → Add domain** `redclinicwaitlist.navapilot.com`.
   At GoDaddy (navapilot.com DNS) add: `CNAME  redclinicwaitlist  →  <your-site-name>.netlify.app`. Netlify issues HTTPS automatically.

## Run locally

```bash
cd waitlist
npm install
npm test                                  # 12 unit tests
ADMIN_KEY=test node scripts/local.mjs     # http://localhost:8888, real functions + local Blobs
```

`FAIL_FUNCTION=1` / `FAIL_FORMS=1` simulate either store being down.

## Files

- `public/` — the page (`index.html`, `styles.css`, `app.js`, brand assets reused from `website/`)
- `netlify/functions/apply.mjs` — saves an application
- `netlify/functions/applications.mjs` — CSV/JSON export, protected by `ADMIN_KEY`
- `lib/application.mjs` — validation shared by the function and tests
