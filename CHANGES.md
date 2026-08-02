# Result Generation System — Changes Summary

## 1. Role rename
"Admin" is now displayed as **"Admin/School Owner/School Proprietor"** everywhere in the UI
(login, register, dashboard sidebar/topbar, pricing page, landing page). The underlying
`role` value in the database/JWT stays `"admin"` — only display text changed, so nothing
else in the codebase (routing, permissions) had to change.

## 2. Admin registration: email-verified auth code (backend: `Backend-Resultgen`)
- New table `admin_signup_codes` (see `src/db/schema.sql`).
- New routes `src/routes/adminSignup.js`:
  - `POST /api/admin-signup/request-code` `{ email }` — generates a 6-digit code,
    emails it via Gmail SMTP, enforces a 30s resend cooldown server-side
    (`ADMIN_CODE_RESEND_COOLDOWN_SECONDS` env var).
  - `POST /api/admin-signup/verify-code` `{ email, code }` — marks the email verified.
- `src/utils/email.js` — Gmail SMTP sender (needs `GMAIL_USER` + `GMAIL_APP_PASSWORD`,
  a 16-char **App Password**, not the account password — see env.example for how to
  generate one). If unset, codes are logged to the server console instead (dev mode).
- `src/routes/auth.js` `/register`: the Admin path no longer accepts a pre-issued
  `authCode` — it now requires (a) a verified `admin_signup_codes` row for that email,
  (b) a valid `plan`, and (c) a successful `payments` row (see below). Teacher/Parent
  registration is unchanged — they still use Admin-issued `auth_codes`.

## 3. Pricing & plans
`src/utils/pricing.js` (backend) is the single source of truth:

| Plan     | Base rate      | Free trial       | Volume discount |
|----------|-----------------|------------------|------------------|
| Starter  | ₦2,000 flat/mo | up to 10 students | none (flat)      |
| Standard | ₦3,000/student/mo | up to 5 students | −10% per 10 students, capped at −50% |
| Premium  | ₦4,000/student/mo | up to 8 students | −10% per 10 students, capped at −50% |

The exact discount schedule (10%/band, 50% cap) wasn't specified in the brief — it's
clearly isolated in `BAND_SIZE` / `DISCOUNT_PER_BAND` / `MAX_DISCOUNT` in
`src/utils/pricing.js` if you want different numbers.

Frontend `pricing/page.tsx` CTAs now deep-link into registration with the plan
pre-selected: `/auth/register?role=admin&plan=starter|standard|premium`. Features not
yet built (CBT, lesson plans, expenses, payroll, inventory, AI) are marked
"(coming soon)" on the Standard/Premium cards rather than removed, since you said
they're on the pricing page but not implemented yet.

## 4. Paystack integration
- `src/utils/paystack.js` (backend) — thin wrapper around Paystack's REST API
  (initialize / verify / charge_authorization).
- `src/routes/payments.js`:
  - `POST /api/payments/initialize` — starts a transaction for a **small card-verification
    charge** (`PAYSTACK_CARD_VERIFICATION_KOBO`, defaults to ₦50), NOT the plan price.
    This is the standard pattern for "free trial, card required": a nominal charge just
    captures a reusable `authorization_code` for billing once the trial ends — the plan
    price itself is never charged during registration. **This was a design decision I
    made to satisfy "payment details must be inputted" + "free trial" together — flag it
    if you actually want the full plan amount charged immediately instead.**
  - `GET /api/payments/verify/:reference` — frontend calls this right after the Paystack
    popup closes.
  - `POST /api/payments/webhook` — signature-verified server-to-server event handler
    (mount this URL in your Paystack dashboard once deployed).
- Frontend `lib/paystack.ts` loads Paystack Inline JS v2 on demand and opens the card
  popup; `auth/register/page.tsx` wires it into the Admin signup flow: verify email →
  pick plan + student count → fill school info → add payment details (Paystack popup) →
  create account.
- On successful registration, a `subscriptions` row is created with `status='trialing'`,
  the plan's trial limit, and a 30-day `trial_ends_at`. You'll need a scheduled job
  (cron / Paystack recurring charge) to actually bill `chargeAuthorization()` when trials
  end — that job isn't included since no scheduler exists in this codebase yet.

## Required environment variables (backend `.env`, see `env.example`)
```
GMAIL_USER=
GMAIL_APP_PASSWORD=
ADMIN_CODE_RESEND_COOLDOWN_SECONDS=30
PAYSTACK_PUBLIC_KEY=
PAYSTACK_SECRET_KEY=
PAYSTACK_CARD_VERIFICATION_KOBO=5000
```
Run `npm run migrate` after pulling these changes to create the new tables
(`admin_signup_codes`, `subscriptions`, `payments`) — it's additive, safe to run
against your existing database.

## What I could NOT do in this sandbox
- Could not test against a real Postgres database, real Gmail SMTP, or real Paystack
  test keys (no credentials, no DB in this environment).
- Did not push anything to GitHub — you'll need to review the diff and push yourself
  (or hand this zip to Claude Code, which can `git push` directly).
- `next build` fails here only because Google Fonts is blocked in this sandbox — that
  will work fine in your normal dev/deploy environment.

## Recommended next steps
1. Review the diffs (unzip and `git diff` against your existing clones).
2. Fill in real Gmail App Password + Paystack test keys in `.env`.
3. `npm run migrate` on the backend.
4. Test the full Admin signup flow end-to-end with Paystack test cards
   (https://paystack.com/docs/payments/test-payments/).
5. Decide if you want the card-verification-charge approach (current) or full
   upfront charge, and adjust `PAYSTACK_CARD_VERIFICATION_KOBO` / registration
   logic accordingly.

---

# Round 2 — Branding, font, and payment/email fixes

## Branding
- "TunzSoft" → "TD Soft" everywhere it appeared (landing page footer tagline,
  copyright line, mail links) in `page.tsx` and `pricing/page.tsx`.
- `Tunzsoft@gmail.com` → `tdsoft01@gmail.com` (footer link + floating mail button,
  both files).

## Font: Gilroy Bold / Extra Bold
Gilroy is a **commercial font** — its files can't be redistributed in this repo, so
I wired up the infrastructure and you need to drop in your licensed files:
- `src/app/globals.css` now declares `@font-face` for Gilroy at weight 700 (Bold)
  and 800 (Extra Bold), applied globally: body text uses Bold, all headings
  (`h1`–`h6`) use Extra Bold.
- Both landing-page inline `<style>` blocks (`page.tsx`, `pricing/page.tsx`) updated
  to reference the same font stack instead of their old hardcoded 'Segoe UI'.
- Until you add the files, everything gracefully falls back to Inter (still loaded
  via `next/font/google`) — nothing breaks or looks unstyled in the meantime.
- **Action needed:** see `public/fonts/README.md` — drop `Gilroy-Bold.woff2` and
  `Gilroy-ExtraBold.woff2` into `public/fonts/` and the whole app switches over
  automatically, no further code changes.

## Bug fix: admin verification email wasn't sending
Two real issues found and fixed in `src/utils/email.js` / `src/routes/adminSignup.js`:
1. **Silent success on misconfiguration.** If `GMAIL_USER`/`GMAIL_APP_PASSWORD`
   weren't set, the backend fell back to logging the code to the console but the
   API still returned a plain "sent" success — so the admin saw "check your email"
   with nothing ever arriving, and no error to go on. Fixed: the response now
   includes `devMode: true`, and the frontend shows an explicit warning
   ("Email is not configured on the server — check the backend logs for your
   code") instead of a false "sent" toast.
2. **App Password whitespace.** Google's UI displays App Passwords with spaces
   for readability (`abcd efgh ijkl mnop`) — copy-pasting them as-is into
   `GMAIL_APP_PASSWORD` is a very common cause of silent auth failures.
   `email.js` now strips whitespace defensively before authenticating.
3. Switched from the `service: "gmail"` shorthand to an explicit
   `smtp.gmail.com:465` (SSL) config, which is more reliable across hosting
   environments, and send failures now throw a clear, actionable error
   (mentions checking 2-Step Verification / App Passwords) instead of a bare
   "Invalid login" — logged server-side and returned to the caller.

**Most likely root cause of "the email isn't being sent" in your deployment:**
`GMAIL_USER` / `GMAIL_APP_PASSWORD` simply aren't set in your backend's `.env` yet
(or a plain account password was used instead of an App Password). Check your
backend logs on boot — it now prints `📧 Gmail (admin auth-code emails): configured`
or `NOT configured` on startup, and again whenever a code is requested.

## Bug fix: payment gateway — registration crashed after a successful charge
Found a real bug in `src/routes/auth.js`: `payments.paystack_raw` is a `JSONB`
column, and `pg` (node-postgres) already parses `JSONB` columns into plain JS
objects automatically. The code was calling `JSON.parse()` on that
already-parsed object, which throws (`Unexpected token o in JSON`) — meaning
**every Admin registration would fail right after a successful Paystack charge**,
even though the card had already been charged. Fixed by using the object
directly instead of re-parsing it.

## Payment gateway hardening
- `POST /api/payments/initialize` now fails fast with a clear message if
  `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` aren't set, instead of a
  confusing downstream error.
- Backend now logs Paystack configuration status on boot alongside the Gmail
  status (see above).
