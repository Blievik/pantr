# PantR

Track the food you have, scan grocery receipts, and use things up before they go bad.

**Runs free.** With no API key, receipts are read right on the user's phone and meal ideas come from PantR's built-in recipe engine. Add an Anthropic API key whenever you want sharper AI scanning and custom recipes.

## Features

- **Receipt scanning, two ways**
  - *Free, on device:* open-source OCR (Tesseract) reads the photo in the browser. Store codes are expanded ("CHKN BRST BNLS" becomes "Boneless chicken breast"), weighed items get their line price, totals and coupons are skipped, and non-food is flagged. Photos never leave the phone, and it works offline after the first scan.
  - *AI (optional):* Claude reads up to 3 photos of a long receipt at once. If AI is ever unavailable, PantR falls back to on-device reading automatically.
- **A shelf-life engine** covering about 50 food types, with how long each keeps, where it belongs, how much faster it goes once opened, and a storage tip for each. It reads names the way people say them, so "chicken broth" is pantry food and "blueberry muffins" is bakery, not fruit.
- **Quick add:** type `milk, eggs, 2 avocados, leftover chili` and each item gets its own date.
- **One-tap tracking:** Used 1 (of several), Used it, Opened (shortens the date and moves jars to the fridge), Freeze, Thaw, Tossed. Everything has undo.
- **Cook before it goes bad:** meal ideas built around whatever expires first. Tap **I made this** to mark the ingredients used.
- **Shopping list** sorted by store aisle. Check items off as you shop, then add them all to your pantry in one tap. PantR also suggests restocking what you finish.
- **Waste tracker:** food eaten, rescued (used or frozen just in time), and tossed, with dollars and a 6-month waste-rate chart.
- **Installable app (PWA):** home screen icon, full screen, offline, expiration reminders, and an app badge.
- **Example pantry** so first-time visitors can try everything before adding their own food.

## How it's built

```
public/                 the app (plain HTML/CSS/JS, no build step)
  index.html            the whole UI
  sw.js                 service worker: offline support, OCR caching, reminder taps
  manifest.webmanifest  install info
  icons/
  vendor/tesseract/     on-device OCR (tesseract.js 5.1.1, Apache-2.0), served from your own site
worker/index.js         Cloudflare Worker: serves /public and the optional /api routes
wrangler.jsonc          Cloudflare config (assets, rate limits, model)
```

One Cloudflare Worker serves the site and the API at one address. The free plan covers it.

### Security and privacy design

- No accounts and no database. Each person's pantry lives in their own browser (localStorage), with backup and restore in Settings.
- The OCR library is served from your own domain, not a third-party CDN, so nobody else sees who uses the app.
- The Anthropic API key is a Cloudflare **secret**. It never reaches the browser.
- **Prompts are built on the server.** The browser only sends receipt images or ingredient names, so the endpoint can't be used as a free general-purpose Claude proxy.
- Every input is size-capped and cleaned, and Claude's answers are shape-checked before they reach the browser.
- Requests must come from the site's own origin.
- Per-IP rate limits: 6 receipt scans and 10 recipe requests a minute.
- Optional **access code** (checked in constant time) for when only friends should use the AI features. Everyone else still gets free on-device scanning.
- A monthly **spend limit** in the Claude Console is the hard backstop.

---

## Deploy it for free

You need a GitHub account and a free Cloudflare account. No credit card.

### 1. Put the code on GitHub

1. Create a new repository on GitHub named `pantr`.
2. Upload everything in this folder **except** `node_modules`, `.wrangler` and `.dev.vars` (`.gitignore` already handles this if you use git):
   ```bash
   git init
   git add .
   git commit -m "PantR"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/pantr.git
   git push -u origin main
   ```

### 2. Deploy on Cloudflare (no terminal needed)

1. Sign in at **dash.cloudflare.com**, then go to **Workers & Pages → Create → Import a repository**.
2. Connect GitHub and pick your `pantr` repo. Cloudflare reads `wrangler.jsonc` automatically. Keep the defaults and click **Deploy**.
3. Your app is live at `https://pantr.YOUR-SUBDOMAIN.workers.dev`, with free scanning working.

From now on, every push to GitHub redeploys automatically.

**Or from a terminal** (needs Node.js 20+):
```bash
npm install
npx wrangler login
npm run deploy
```

### 3. Optional: turn on AI scanning and custom recipes

1. At **console.anthropic.com**, add a little credit under **Billing** (API usage is pay as you go and separate from a Claude.ai subscription).
2. Under **Limits**, set a **monthly spend limit**, for example $5.
3. Under **API Keys**, create a key (starts with `sk-ant-`).
4. In Cloudflare, open your Worker → **Settings → Variables and Secrets → Add**:
   - Type **Secret**, name `ANTHROPIC_API_KEY`, value: your key.
   - Optional: Type **Secret**, name `ACCESS_CODE`, value: a code you give to friends.
5. Click **Deploy** so the secrets take effect.

Remove the key any time and the site goes back to free mode on its own.

### 4. Optional: custom domain

Buy a domain (Cloudflare Registrar sells at cost, usually $10 to $15 a year), then in your Worker go to **Settings → Domains & Routes → Add → Custom domain**.

---

## Run it on your computer

```bash
npm install
npm run dev                      # opens at http://localhost:8787 in free mode
cp .dev.vars.example .dev.vars   # optional: paste a key in to test AI mode
```

## Making changes

- Edit files in `public/`, then **bump `VERSION` in `public/sw.js`** (for example `pantr-v3`) so installed copies pick up the update.
- Shelf-life rules live in `PRIORITY` and `GUIDE` in `index.html`: a pattern, days it keeps, where it goes, a category, days once opened, and a storage tip.
- Receipt shorthand lives in `ABBR`. Add your store's codes there to sharpen free scanning.
- Built-in recipes live in `RECIPES`.
- To switch AI models, change `MODEL` in `wrangler.jsonc`. Haiku is cheapest; use `claude-sonnet-5-5` if AI scans come back with mistakes.
- Logs: Cloudflare dashboard → your Worker → **Logs**.

## Good to know

- The first free scan on a device downloads the reader (about 7 MB, cached after that). Scans after that take a second or two and work offline.
- On-device reading is good with clear, flat photos and makes more mistakes on crumpled or faded receipts. The review screen lets people fix names before anything is added.
- **Reminders** appear when PantR is opened or brought back on screen, at most once a day, because the web can't wake an app on a schedule without a push server. On iPhone, notifications only work after adding PantR to the Home Screen.
- **Costs:** Cloudflare's free plan covers hosting. With no API key, PantR costs nothing to run.
