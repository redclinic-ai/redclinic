# Website decisions

Why the site is built the way it is. Written 23 November 2026.

## Starting point

The repository holds the clinic application's database layer and specs. There are no app screens, no
telephony and no live integrations yet (BUILD_STATUS.md). That set the main constraint: the site has to
sell a product that is still being built without claiming anything that isn't true.

## Positioning

- **Lead with the moment a dentist recognises, not with "AI".** Headline: "When you're at the chair, NEPA
  answers the phone." Every dentist has lost a call mid-procedure. It names the product (NEPA), the buyer's
  situation and the benefit in nine words.
- **Three verbs carry the product: Answers, Follows up, Remembers.** NEPA, the dental workflows and the
  patient record. This keeps NEPA tied to the platform instead of looking like a separate chatbot.
- **Dental specifics everywhere** (RCT sittings, braces adjustments, six-month recall, swelling after an
  extraction). They signal "built for you" more than any adjective, and they come from the Dental Pack.
- **Control is a selling point.** The fear with AI is losing control, so "NEPA does what you allow" has its own
  section, using the product's real modes (Suggest, Ask first, Automatic).
- **Honesty as a differentiator.** A "Where RedClinic is today" block on the home page and a "What's ready"
  block on the NEPA page. Skeptical owners trust a company that tells them what isn't ready.

Rejected directions: a stats-led hero (no real numbers exist and fabricating them was ruled out); a dashboard
screenshot hero (generic and the app doesn't exist yet); a pure "AI receptionist" product site (undersells the
platform and makes NEPA look like a bolt-on).

## Architecture

Six pages, each with a job:

| Page | Job |
|---|---|
| Home | Understand, believe, book. Contains the demo form so most visitors never leave the page |
| NEPA | The acquisition differentiator, and the page for "AI receptionist for dental clinics" searches |
| Platform | For owners comparing practice software; targets "dental clinic software India" |
| Security | Objection handling for records, access and AI limits. Says what isn't certified |
| Demo | The conversion page for ads and every CTA |
| Privacy | Required because the form collects personal data |

Not built: separate Patient/Appointment/Workflow pages (they'd be thin until real screens exist), About
(no founder story or team details have been supplied; worth adding once they are), Pricing (pricing isn't final).

## Brand

- Logo traced to SVG from the supplied PNG: crisp at any size, 6 KB instead of 56 KB.
- Colour: white ground, charcoal ink (#15181D, from the logo), brand red (#DE0A12) used only for actions and
  for "needs attention". One charcoal band for the sample calls, one full red band for the closing form.
- Type: Instrument Sans only, self-hosted (one 57 KB variable file). Condensed width for headlines gives a
  distinctive, editorial feel without a second typeface; normal width for reading.
- Product UI drawn in HTML, not images: sharp on every screen, tiny, and easy to update. Every mockup is
  labelled illustrative with made-up patients.
- Motion: one moment only. The hero call plays its transcript once and the booking slides into the day list.
  Off for users who prefer reduced motion.

## Conversion system

- "Book a demo" in the header on every page, in the hero, after each inner page, and as a sticky bar on phones
  that hides when the form or footer is on screen.
- Form: name, mobile, clinic, city, number of doctors (tap chips), optional call time. Five required fields is
  the minimum to qualify and call back. Current software is asked on the call, not on the form.
- `+91` is fixed and the number is normalised (spaces, 0, +91 all accepted), validated as an Indian mobile.
- Confirmation shows a reference number from the server and three next steps, so the visitor knows the request
  really was saved and what happens next. It's never shown unless storage succeeded.
- Works without JavaScript (plain form post with a server-rendered confirmation).
- Spam: hidden field, minimum fill time, per-IP rate limit. No CAPTCHA, which hurts mobile completion.

## Technical

- Plain HTML/CSS/JS with a 150-line build script. No framework, no runtime dependencies. Any web developer can
  edit it, and nothing breaks on upgrades.
- Total homepage transfer about 80 KB. Lighthouse (mobile): 100 performance, accessibility, best practices
  and SEO on every main page.
- Strict Content Security Policy: no third-party scripts, fonts or trackers.
- Lead storage behind an adapter: a local file for development, Supabase/PostgREST for production. Leads are
  kept apart from the clinic database's patient data.
