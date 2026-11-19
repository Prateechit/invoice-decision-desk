// Server-side AI reader. The API key never reaches the browser, and the server builds
// the extraction prompt itself, so this endpoint can only be used to read invoices.
const Engine = require("../engine.js");
const ref = require("../reference.json");

const MAX_TEXT = 12000;
const MAX_IMAGE_B64 = 4 * 1024 * 1024; // ~3 MB image
const WINDOW_MS = 10 * 60 * 1000, MAX_CALLS = 40; // per IP, per server instance
const calls = new Map();

function provider() {
  if (process.env.ANTHROPIC_API_KEY) return { provider: "anthropic", label: "Claude", model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5" };
  if (process.env.GEMINI_API_KEY) return { provider: "gemini", label: "Gemini", model: process.env.GEMINI_MODEL || "gemini-flash-latest" };
  return { provider: "none", label: "none", model: null };
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (calls.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now); calls.set(ip, list);
  return list.length > MAX_CALLS;
}

async function callAnthropic(p, prompt, image) {
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } });
  content.push({ type: "text", text: prompt });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: p.model, max_tokens: 2500, messages: [{ role: "user", content }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Anthropic API " + r.status + ": " + ((j.error && j.error.message) || "error"));
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

async function callGemini(p, prompt, image) {
  const parts = [{ text: prompt }];
  if (image) parts.push({ inline_data: { mime_type: image.media_type, data: image.data } });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json" } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gemini API " + r.status + ": " + ((j.error && j.error.message) || "error"));
  const c = j.candidates && j.candidates[0];
  return c && c.content && c.content.parts ? c.content.parts.map((x) => x.text || "").join("") : "";
}

/** Returns { status, json } so it works under Vercel and the local server alike. */
async function handleExtract(body, ip) {
  const p = provider();
  if (p.provider === "none") return { status: 503, json: { error: "No AI key configured on the server" } };
  if (rateLimited(ip || "local")) return { status: 429, json: { error: "Too many reads. Wait a few minutes." } };
  body = body || {};
  const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : "";
  let image = null;
  if (body.image && typeof body.image.data === "string") {
    if (!/^image\/(png|jpeg|webp)$/.test(body.image.media_type || "")) return { status: 400, json: { error: "Image must be PNG, JPEG or WebP" } };
    if (body.image.data.length > MAX_IMAGE_B64) return { status: 413, json: { error: "Image too large" } };
    image = { media_type: body.image.media_type, data: body.image.data };
  }
  if (!text && !image) return { status: 400, json: { error: "Send invoice text or an image" } };
  const prompt = Engine.buildPrompt(ref.buyer, text, !!image);
  try {
    if (process.env.IDD_MOCK_RESPONSE_FILE) return { status: 200, json: { text: require("fs").readFileSync(process.env.IDD_MOCK_RESPONSE_FILE, "utf8"), provider: "mock" } };
    const out = p.provider === "anthropic" ? await callAnthropic(p, prompt, image) : await callGemini(p, prompt, image);
    return { status: 200, json: { text: out, provider: p.provider, model: p.model } };
  } catch (e) {
    return { status: 502, json: { error: String(e.message || e) } };
  }
}

function handleHealth() { const p = provider(); return { status: 200, json: { ok: true, provider: p.provider, label: p.label, model: p.model } }; }

module.exports = { handleExtract, handleHealth, provider };
