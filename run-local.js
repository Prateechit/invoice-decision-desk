// Run locally with no dependencies:  node run-local.js   then open http://localhost:3000
// Put ANTHROPIC_API_KEY=... (or GEMINI_API_KEY=...) in a .env file next to this one.
const http = require("http"), fs = require("fs"), path = require("path");

const ROOT = __dirname;
const PUB = __dirname;
try {
  fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch (e) { /* no .env file */ }

const { handleExtract, handleHealth, provider } = require("./lib/ai.js");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".pdf": "application/pdf", ".jpg": "image/jpeg", ".png": "image/png" };
const PUBLIC = new Set(["index.html", "desk.js", "engine.js", "reference.json"]);

function send(res, status, json) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); }

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/api/health") { const o = handleHealth(); return send(res, o.status, o.json); }
  if (url === "/api/extract") {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 6e6) req.destroy(); });
    req.on("end", async () => {
      let body; try { body = JSON.parse(raw || "{}"); } catch (e) { return send(res, 400, { error: "Bad JSON" }); }
      const o = await handleExtract(body, req.socket.remoteAddress);
      send(res, o.status, o.json);
    });
    return;
  }
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const allowed = PUBLIC.has(rel) || /^samples\/[\w.\-]+\.(pdf|jpg|png)$/.test(rel);
  const file = path.join(PUB, rel);
  if (!allowed || !fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 3000, () => {
  const p = provider();
  console.log(`Invoice Decision Desk running at http://localhost:${process.env.PORT || 3000}`);
  console.log(p.provider === "none" ? "AI reader: OFF (add ANTHROPIC_API_KEY or GEMINI_API_KEY to .env). Text PDFs still work via the rules parser." : `AI reader: ${p.label} (${p.model})`);
});
