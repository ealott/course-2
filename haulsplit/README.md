# HaulSplit

Split a Costco (or any bulk-store) haul between friends and family.

The organizer adds what they bought. Everyone else picks the portions they want, like 2 lb of the 8 lb of chicken or half the paper towels. Each person then gets their exact total and the organizer's Zelle details. The organizer sees who has paid and who hasn't.

## What it does

- **Easy login.** Friends open an invite link and type their name; that's it. Their phone stays logged in. Adding an email and password is optional, for logging in on other devices. The group owner can also send a one-time login link (by text) to anyone who has no password.
- **People who won't use the app.** Add "Grandma" as a member with no login, and the organizer picks portions for her.
- **Portions.** Each item is split into equal portions (8 lb → 8 × 1 lb, 24 eggs → 24 × 1, a big jar → whole). People tap + / −. The server stops two people from grabbing the last portion at once.
- **Fair math.** Price per portion = item price (+ sales tax if the item was taxed) ÷ portions. Each line is rounded to the cent once, so totals always add up. Unclaimed portions stay with the organizer.
- **Paying back.** "That's everything" → "Send $19.17 with Zelle to Erin", with copy buttons for the Zelle address, amount and memo → "I sent it". The organizer taps "Got $19.17" to confirm. If someone changes their picks after paying, they're shown the difference (or that the organizer owes them).
- **Use-by dates.** Optional per item, shown as "Use within 3 days" badges. Members can add reminders to their calendar (.ics).
- **Receipt scanning.**
  - *Photo:* take one or more photos of the receipt, or a screenshot of the digital receipt in the Costco app. Claude reads it: it merges instant-savings lines into their items, folds bottle deposits in, works out which items were taxed and the tax rate, and expands abbreviations ("KS ORG BNLS CHKN BRST" → "Kirkland Signature Organic Boneless Chicken Breast"). Needs an Anthropic API key (see below).
  - *Text:* paste the receipt's text. On iPhone, Live Text can copy it straight out of a photo. A built-in Costco receipt parser handles the rest, with no API key needed.
  - Either way, you review and edit the list before anything is added.
- **Barcode scanning.** Uses the phone camera. It works on iPhone too, through a WebAssembly decoder that only loads when the scanner opens. Scanned products are looked up first in your group's history (name, size, last price), then in Open Food Facts and UPCitemdb.
- Drafts (only the organizer sees them until shared), closing picks, live updates while people pick, dark mode, and installable to the home screen.

## Stack

- **Cloudflare Workers** (the [Hono](https://hono.dev) API in `worker/`), **D1** (SQLite) for data, and static assets for the web app.
- **React + Vite** web app in `src/`, designed for phones first.
- `shared/` holds the split math, receipt parser and units, used by both sides and unit-tested.

The free Cloudflare plan is plenty for a family or friend group.

## Run it locally

```bash
cd haulsplit
npm install
npm run db:migrate:local   # creates the local SQLite database
npm run dev                # web app on http://localhost:5173 (API on :8787)
```

To try photo receipt scanning locally, copy `.dev.vars.example` to `.dev.vars` and add your key.

Tests:

```bash
npm test           # unit tests and end-to-end API tests against a throwaway local D1
npm run typecheck
```

## Deploy to Cloudflare

```bash
cd haulsplit
npx wrangler login                    # or set CLOUDFLARE_API_TOKEN
npx wrangler d1 create haulsplit      # paste the printed database_id into wrangler.jsonc
npm run deploy                        # builds, applies migrations, deploys
```

Wrangler prints your URL (`https://haulsplit.<you>.workers.dev`). Open it, create a group, and share the invite link.

### Turn on photo receipt scanning (optional)

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Get a key at <https://console.anthropic.com>. A receipt costs a few cents to read. The model and effort level are the `CLAUDE_MODEL` and `CLAUDE_EFFORT` vars in `wrangler.jsonc`. Requests ask for Anthropic's server-side fallback, so if the model declines a request, another model can finish it. Without a key, the app still works and offers "Paste text" instead.

### Notes

- **Passwords** are hashed with PBKDF2-SHA256 (100,000 rounds, the most Workers allows). Workers' free plan has a 10 ms CPU limit per request, and hashing may go over it. If password logins fail with a CPU-limit error, set the `PASSWORD_ITERATIONS` var to something lower (e.g. `"20000"`) or use the $5 paid plan. Name-only joins and login links never hash anything.
- **Who can see what:** only group members see a group's hauls, and drafts are visible only to their organizer. Only the organizer can edit items, pick for other people, or confirm payments. The group owner can make login links only for members who have no password and who aren't in anyone else's group. That way an owner can't take over someone else's account.
- **Zelle** has no universal "pay this person" link, so the app gives copy buttons for the Zelle address, amount and memo to paste into your bank's app.

## Project layout

```
haulsplit/
  migrations/      D1 schema
  shared/          split math, Costco receipt text parser, units, API types
  worker/          API: auth, groups, hauls/items/claims/payments, receipt AI, barcode lookup
  src/             React app (pages/, components/)
  tests/           vitest: shared logic + API end-to-end
```
