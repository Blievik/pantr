/**
 * PantR backend (Cloudflare Worker)
 *
 * Serves the site from /public and answers three API routes:
 *   GET  /api/health    is AI scanning set up? does it need an access code?
 *   POST /api/receipt   { images: [{data: base64, mediaType}] (1 to 3) } or { text }  -> parsed receipt
 *   POST /api/recipes   { use: [{name, left}], rest: [name], gear: [name] } -> 3 recipes
 *
 * The site works without this backend's AI features: with no API key set, receipts are read
 * on the user's own device (free) and meal ideas come from PantR's built-in recipe list.
 *
 * Security choices:
 *   - The Anthropic API key lives only in the ANTHROPIC_API_KEY secret. The browser never sees it.
 *   - Prompts are built here, not in the browser, so nobody can use this endpoint as a free
 *     general-purpose Claude proxy. The browser only sends receipt data or ingredient names.
 *   - Every input is size-capped and cleaned, and Claude's answers are shape-checked before they go back.
 *   - Requests must come from this site's own origin (stops other websites from using it).
 *   - Per-IP rate limits (the RECEIPT_LIMIT and RECIPE_LIMIT bindings in wrangler.jsonc).
 *   - Optional ACCESS_CODE secret: when set, AI features need the code (share it with friends only).
 *   - Set a monthly spend limit in the Claude Console as the final backstop.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-5-5";
const MAX_IMAGE_B64 = 4_800_000; // ~3.5 MB per image, under the API's 5 MB per-image cap
const MAX_IMAGES = 3;
const MAX_TEXT = 12_000;
const CATS = ["produce", "dairy", "meat", "seafood", "bakery", "deli", "frozen", "pantry", "snacks", "drinks", "leftovers", "other"];
const GEAR = ["Stove", "Oven", "Microwave", "Slow cooker", "Air fryer"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, ready: Boolean(env.ANTHROPIC_API_KEY), needsCode: Boolean(env.ACCESS_CODE) });
      }
      if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
      if (!sameOrigin(request, url)) return fail(403, "bad_origin", "Requests must come from the PantR site.");
      if (!env.ANTHROPIC_API_KEY) return fail(503, "not_configured", "AI scanning isn't set up on this site.");
      if (env.ACCESS_CODE) {
        const code = request.headers.get("X-Access-Code") || "";
        if (!code) return fail(401, "code_required", "Enter the access code to use AI scanning.");
        if (!(await safeEqual(code, env.ACCESS_CODE))) return fail(401, "bad_code", "That access code isn't right.");
      }

      const ip = request.headers.get("CF-Connecting-IP") || "local";
      if (url.pathname === "/api/receipt") {
        if (!(await allowed(env.RECEIPT_LIMIT, ip))) return fail(429, "rate_limited", "Too many scans. Wait a minute and try again.");
        return await receipt(request, env);
      }
      if (url.pathname === "/api/recipes") {
        if (!(await allowed(env.RECIPE_LIMIT, ip))) return fail(429, "rate_limited", "Too many requests. Wait a minute and try again.");
        return await recipes(request, env);
      }
      return fail(404, "not_found", "No such route.");
    } catch (err) {
      if (err && err.busy) return fail(503, "busy", "Claude is busy right now. Try again in a minute.");
      if (err && err.keyProblem) return fail(503, "not_configured", "AI scanning is temporarily down. The site owner needs to check the API key.");
      console.error(err);
      return fail(500, "server_error", "Something went wrong on the server. Try again.");
    }
  },
};

/* ---------------- routes ---------------- */

async function receipt(request, env) {
  const body = await readJson(request, MAX_IMAGE_B64 * MAX_IMAGES + 4000);
  if (!body) return fail(400, "bad_request", "Send JSON with photos or text.");
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || "") ? body.today : new Date().toISOString().slice(0, 10);

  // Accept { images: [...] } or the older single { image, mediaType }
  let images = Array.isArray(body.images) ? body.images : (typeof body.image === "string" ? [{ data: body.image, mediaType: body.mediaType }] : []);
  if (images.length > MAX_IMAGES) return fail(400, "too_many", `Send at most ${MAX_IMAGES} photos at a time.`);

  const content = [];
  let intro;
  if (images.length) {
    for (const img of images) {
      const data = typeof img?.data === "string" ? img.data : "";
      if (!data) return fail(400, "bad_image", "A photo didn't upload correctly. Try again.");
      if (data.length > MAX_IMAGE_B64) return fail(413, "too_large", "That photo is too large. Try again with a smaller image.");
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) return fail(400, "bad_image", "A photo didn't upload correctly. Try again.");
      const mediaType = IMAGE_TYPES.includes(img.mediaType) ? img.mediaType : "image/jpeg";
      content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
    }
    intro = images.length > 1
      ? `The ${images.length} attached images are photos of one receipt, in order from top to bottom. Where the photos overlap, list each purchased line only once.`
      : "The attached image is a photo of a store receipt.";
  } else if (typeof body.text === "string" && body.text.trim()) {
    intro = "Here is the receipt text:\n" + body.text.slice(0, MAX_TEXT);
  } else {
    return fail(400, "bad_request", "Send a receipt photo or receipt text.");
  }

  content.push({
    type: "text",
    text: `You read grocery receipts for PantR, a food expiration tracker. Today is ${today}.
${intro}
Return JSON only, no prose, in exactly this shape:
{"store": string|null, "purchaseDate": "YYYY-MM-DD"|null, "items": [{"raw": the line as printed, "name": a plain readable product name with store abbreviations and brand codes expanded (e.g. "GV 2% MLK GAL" -> "2% milk, gallon"), "qty": number, "price": number|null (the line total), "category": one of ${CATS.join(", ")}, "location": "fridge"|"freezer"|"pantry" (where it is normally kept once home), "shelfLifeDays": integer, typical days it stays good stored that way after purchase, "food": boolean (false for paper goods, cleaning, health and beauty, bags, deposits)}]}
Leave out subtotal, tax, totals, payment, savings and coupon lines. If a weighed item lists price per pound, use the line total. If this is not a receipt, return {"items": [], "error": "a short reason"}.`,
  });

  const data = await askClaude(env, content, 4000);
  if (!data) return fail(502, "unreadable", "Couldn't make sense of that receipt. Try a sharper, flatter photo.");
  const items = Array.isArray(data.items) ? data.items.slice(0, 150).map((x) => ({
    raw: clean(x?.raw, 60),
    name: clean(x?.name, 80),
    qty: clampInt(x?.qty, 1, 99, 1),
    price: typeof x?.price === "number" && isFinite(x.price) ? Math.max(0, Math.round(x.price * 100) / 100) : null,
    category: CATS.includes(x?.category) ? x.category : "other",
    location: ["fridge", "freezer", "pantry"].includes(x?.location) ? x.location : "fridge",
    shelfLifeDays: clampInt(x?.shelfLifeDays, 1, 730, 7),
    food: x?.food !== false,
  })).filter((x) => x.name || x.raw) : [];
  return json({
    ok: true,
    store: clean(data.store, 60) || null,
    purchaseDate: /^\d{4}-\d{2}-\d{2}$/.test(data.purchaseDate || "") ? data.purchaseDate : null,
    items,
    error: clean(data.error, 140) || undefined,
  });
}

async function recipes(request, env) {
  const body = await readJson(request, 20_000);
  if (!body) return fail(400, "bad_request", "Send JSON.");
  const use = (Array.isArray(body.use) ? body.use : []).slice(0, 12)
    .map((u) => ({ name: clean(u?.name, 60), left: clampInt(u?.left, 0, 999, 3) }))
    .filter((u) => u.name);
  if (!use.length) return fail(400, "bad_request", "Pick at least one ingredient.");
  const rest = (Array.isArray(body.rest) ? body.rest : []).slice(0, 40).map((n) => clean(n, 60)).filter(Boolean);
  const gear = (Array.isArray(body.gear) ? body.gear : []).filter((g) => GEAR.includes(g));

  const prompt = `You suggest simple home recipes for PantR, a food waste app. Build 3 different recipes that use up these items first: ${use.map((u) => `${u.name} (${u.left} days left)`).join("; ")}.
Other food on hand that you may use: ${rest.join(", ") || "nothing listed"}. Assume salt, pepper, oil and common spices are on hand.
Available equipment: ${gear.join(", ") || "microwave only"}. Keep each under 45 minutes and realistic for a college student.
Return JSON only: {"recipes":[{"title": string, "minutes": integer, "uses": [names exactly as written in the use-first list], "alsoNeed": [ingredients not on hand, empty if none], "steps": [4 to 6 short steps]}]}`;

  const data = await askClaude(env, [{ type: "text", text: prompt }], 2000);
  const list = Array.isArray(data?.recipes) ? data.recipes.slice(0, 3).map((r) => ({
    title: clean(r?.title, 80) || "Recipe",
    minutes: clampInt(r?.minutes, 1, 600, 20),
    uses: (Array.isArray(r?.uses) ? r.uses : []).slice(0, 8).map((x) => clean(x, 60)).filter(Boolean),
    alsoNeed: (Array.isArray(r?.alsoNeed) ? r.alsoNeed : []).slice(0, 8).map((x) => clean(x, 60)).filter(Boolean),
    steps: (Array.isArray(r?.steps) ? r.steps : []).slice(0, 8).map((x) => clean(x, 300)).filter(Boolean),
  })) : [];
  if (!list.length) return fail(502, "no_recipes", "No recipes came back. Try different ingredients.");
  return json({ ok: true, recipes: list });
}

/* ---------------- Claude call ---------------- */

async function askClaude(env, content, maxTokens) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.MODEL || DEFAULT_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    }),
  });
  if (res.status === 429 || res.status === 529) throw Object.assign(new Error("busy"), { busy: true });
  if (res.status === 401 || res.status === 403) {
    console.error("Anthropic API rejected the key. Check the ANTHROPIC_API_KEY secret and your Console billing.");
    throw Object.assign(new Error("key"), { keyProblem: true });
  }
  if (!res.ok) {
    console.error("Anthropic API error", res.status, (await res.text()).slice(0, 500));
    return null;
  }
  const out = await res.json();
  const text = (out.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return parseJson(text);
}

function parseJson(text) {
  const s = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

/* ---------------- helpers ---------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
function fail(status, code, message) { return json({ ok: false, code, message }, status); }

function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin) return request.headers.get("Sec-Fetch-Site") === "same-origin";
  try { return new URL(origin).host === url.host; } catch { return false; }
}

async function allowed(limiter, key) {
  if (!limiter) return true; // binding missing (e.g. older local tooling): rely on the spend limit
  try { const { success } = await limiter.limit({ key }); return success; } catch { return true; }
}

async function readJson(request, maxBytes) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
}

function clean(v, max) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// Constant-time comparison so the access code can't be guessed by timing
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
