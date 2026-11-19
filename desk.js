/* Invoice Decision Desk — orchestration, live run view, dashboard. Decisions live in engine.js. */
(function () {
  "use strict";
  const E = window.Engine;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = E.fmt;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PACE = 260; // minimum ms per stage so a live viewer can follow along

  const SAMPLES = [
    { file: "samples/01_happy_brightline_BL-24871.pdf", title: "Brightline · BL-24871", tag: "Happy path", kind: "happy", blurb: "Clean PDF with an explicit PO. Goods received in full, tax shown separately." },
    { file: "samples/02_split_overbill_meridian_MPP-7802.pdf", title: "Meridian · MPP-7802", tag: "Edge 1 · split PO", kind: "edge", blurb: "Second invoice on a split PO. Bills more shafts than were received, at a higher price." },
    { file: "samples/03_disguised_duplicate_kestrel.pdf", title: "Kestrel · KL/2026/917", tag: "Edge 2 · duplicate", kind: "edge", blurb: "A “2nd notice” for an invoice already paid, with the number formatted differently." },
    { file: "samples/04_scanned_no_po_orchid_OOC-55210.pdf", title: "Orchid · scanned", tag: "Edge 3 · scan, no PO", kind: "edge", blurb: "Photocopied invoice with no text layer and no PO number printed." },
    { file: "samples/05_bank_change_brightline_BL-24903.pdf", title: "Brightline · BL-24903", tag: "Edge 4 · bank change", kind: "edge", blurb: "Matches the PO perfectly, but asks for payment to a new bank account." },
    { file: "samples/06_incomplete_kestrel_no_number.pdf", title: "Kestrel · no number", tag: "Bonus · incomplete", kind: "edge", blurb: "Bundled freight bill with no invoice number or date." }
  ];

  const STAGES = [
    { key: "intake", name: "Intake", who: "sys" },
    { key: "read", name: "Read document", who: "sys" },
    { key: "extract", name: "Extract fields", who: "ai" },
    { key: "validate", name: "Validate invoice", who: "rule" },
    { key: "vendor", name: "Verify vendor & bank", who: "rule" },
    { key: "dup", name: "Duplicate check", who: "rule" },
    { key: "po", name: "Match PO & receipt", who: "rule" },
    { key: "decide", name: "Decide & route", who: "rule" }
  ];

  const S = {
    ref: null, rules: Object.assign({}, E.DEFAULT_RULES), runs: [], db: null, dbMode: "connecting", sample: null, sampleImages: false,
    current: null, running: false, docs: {} /* run id -> preview element (this session only) */
  };

  // ---------------------------------------------------------------- storage
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  async function connectDb() {
    let db = null;
    try { db = window.claude && window.claude.use ? await window.claude.use("db") : null; } catch (e) { db = null; }
    if (!db) { S.dbMode = "local"; S.runs = LS.get("idd.runs", []); chip("db", false, "History: this browser only"); renderAll(); return; }
    S.db = db;
    const timer = setTimeout(() => { if (S.dbMode === "connecting") { chip("db", false, "History: store not reachable yet"); } }, 10000);
    db.collection("runs").orderBy("created_at", "desc").limit(300).onSnapshot((snap) => {
      clearTimeout(timer);
      S.dbMode = "shared";
      chip("db", true, "History: saved to shared store");
      const remote = snap.docs.map((d) => d.data());
      // keep any local-only runs (writes refused for view-only viewers)
      const localOnly = S.runs.filter((r) => r._local && !remote.find((x) => x.id === r.id));
      S.runs = localOnly.concat(remote).sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
      renderAll();
    }, (err) => {
      clearTimeout(timer);
      S.db = null; S.dbMode = "local"; S.runs = LS.get("idd.runs", []);
      chip("db", false, "History: this browser only"); renderAll();
    });
  }

  async function saveRun(run) {
    const i = S.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) S.runs[i] = run; else S.runs.unshift(run);
    if (S.db && !run._local) {
      try { const clean = JSON.parse(JSON.stringify(run)); await S.db.collection("runs").doc(run.id).set(clean); return; }
      catch (e) { run._local = true; toast(e && e.code === "quota_exceeded" ? "History store is full. This run is kept in this browser only." : "You can view but not write the shared history. Kept in this browser."); }
    }
    LS.set("idd.runs", S.runs.filter((r) => S.dbMode !== "shared" || r._local).slice(0, 80));
  }

  async function connectAI() {
    let sample = null;
    try { sample = window.claude && window.claude.use ? await window.claude.use("sample") : null; } catch (e) { sample = null; }
    if (!sample) {
      try {
        const r = await fetch("api/health", { cache: "no-store" });
        const h = r.ok ? await r.json() : null;
        if (h && h.provider && h.provider !== "none") { S.server = h; chip("ai", true, `AI reader: ${h.label} (text + vision)`); return; }
      } catch (e) { /* no server: static hosting */ }
      chip("ai", false, "AI reader: off · rules only"); return;
    }
    S.sample = sample;
    try { const lim = await sample.limits(); S.sampleImages = !!(lim && lim.images); } catch (e) { S.sampleImages = false; }
    chip("ai", true, "AI reader: Claude" + (S.sampleImages ? " (text + vision)" : " (text)"));
  }

  function chip(which, on, text) {
    const el = $("#chip-" + which);
    el.classList.toggle("on", !!on); el.classList.toggle("off", !on);
    el.querySelector("span").textContent = text;
  }
  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    $("#toast-slot").appendChild(t); setTimeout(() => t.remove(), 3800);
  }

  // ---------------------------------------------------------------- reading
  async function sha256(buf) {
    try { const h = await crypto.subtle.digest("SHA-256", buf); return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join(""); }
    catch (e) { let h = 0; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) h = (h * 31 + a[i]) >>> 0; return "fnv" + h.toString(16); }
  }
  function sniff(bytes, name) {
    const b = new Uint8Array(bytes.slice(0, 8));
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
    if (b[0] === 0x89 && b[1] === 0x50) return "png";
    if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
    return /\.pdf$/i.test(name) ? "pdf" : "unknown";
  }
  function canvasToBlob(canvas, type, q) { return new Promise((res) => canvas.toBlob(res, type || "image/png", q)); }
  async function loadImage(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image(); img.src = url; await img.decode();
    return img;
  }
  function thumbOf(canvas) {
    const w = 560, h = Math.round(canvas.height * (w / canvas.width));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(canvas, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.62);
  }

  // ---------------------------------------------------------------- AI reader
  function parseJSON(t) {
    if (!t) return null;
    const s = String(t).replace(/```(?:json)?/g, "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }
  function blobToBase64(blob) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  }
  async function serverRead(text, imageBlob, onDelta) {
    const t0 = Date.now();
    const tick = setInterval(() => onDelta && onDelta(`${S.server.label} is reading${imageBlob ? " the scanned image" : ""}… ${Math.round((Date.now() - t0) / 1000)} s`), 500);
    try {
      const body = { text: imageBlob ? "" : text };
      if (imageBlob) body.image = { media_type: imageBlob.type || "image/jpeg", data: await blobToBase64(imageBlob) };
      const r = await fetch("api/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw { code: r.status === 429 ? "rate_limited" : "server_error", message: j.error || "HTTP " + r.status };
      onDelta && onDelta(j.text || "");
      return { raw: parseJSON(j.text), text: j.text };
    } finally { clearInterval(tick); }
  }
  async function aiRead(text, imageBlob, onDelta) {
    if (!S.sample && S.server) return serverRead(text, imageBlob, onDelta);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const opts = { modelTier: "default", signal: ctrl.signal, onText: (p) => onDelta && onDelta(p.text) };
      if (imageBlob) opts.images = [imageBlob];
      const res = await S.sample(E.buildPrompt(S.ref.buyer, text, !!imageBlob), opts);
      return { raw: parseJSON(res && res.text), text: res && res.text };
    } finally { clearTimeout(timer); }
  }

  // ---------------------------------------------------------------- pipeline
  function newRun(name) {
    const id = "R" + new Date().toISOString().replace(/\D/g, "").slice(2, 14) + Math.random().toString(36).slice(2, 5).toUpperCase();
    return { id, file_name: name, created_at: new Date().toISOString(), stages: {}, fields: null, decision: null, summary: null, rules_used: Object.assign({}, S.rules) };
  }

  async function stage(run, key, fn) {
    const t0 = performance.now();
    run.stages[key] = { state: "running" };
    renderStages(run);
    let out;
    try { out = await fn(); }
    catch (e) { out = { state: "fail", summary: "Error: " + (e && e.message || e), checks: [{ id: "err", label: "Stage error", status: "fail", detail: String(e && e.message || e), code: "STAGE_ERROR" }] }; }
    const elapsed = performance.now() - t0;
    if (elapsed < PACE) await sleep(PACE - elapsed);
    run.stages[key] = Object.assign({ ms: Math.round(performance.now() - t0) }, out);
    renderStages(run);
    return out;
  }

  async function runPipeline(blob, name, opts) {
    if (S.running) { toast("A run is in progress. Wait for it to finish."); return null; }
    S.running = true; setBusy(true);
    const run = newRun(name);
    S.current = run;
    const T0 = performance.now();
    if (location.hash !== "#run") location.hash = "run";
    renderRun(run);
    $("#doc-frame").innerHTML = '<span class="faint">Loading…</span>';
    $("#fields").innerHTML = '<span class="faint">Waiting for the reader…</span>';
    $("#xcheck").innerHTML = '<div class="card-b faint">Waiting…</div>';
    $("#decision-slot").innerHTML = ""; $("#match-slot").innerHTML = "";
    const ctx = { text: "", imageBlob: null, mode: null };

    // 1 intake
    await stage(run, "intake", async () => {
      const buf = await blob.arrayBuffer();
      ctx.buf = buf; ctx.kind = sniff(buf, name);
      run.file_hash = await sha256(buf);
      run.file_size = buf.byteLength;
      if (ctx.kind === "unknown") throw new Error("Not a PDF or image. Supported: PDF, PNG, JPG.");
      return { state: "pass", summary: `${ctx.kind.toUpperCase()}, ${(buf.byteLength / 1024).toFixed(1)} KB · fingerprint ${run.file_hash.slice(0, 12)}…`,
        checks: [{ status: "pass", label: "File type", detail: ctx.kind.toUpperCase() + " (from the file's bytes, not its name)" }] };
    });

    // 2 read
    const readRes = await stage(run, "read", async () => {
      const checks = [];
      let canvas;
      if (ctx.kind === "pdf") {
        if (!window.pdfjsLib) throw new Error("PDF engine failed to load. Check your connection and reload.");
        const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(ctx.buf) }).promise;
        run.pages = doc.numPages;
        let text = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const pg = await doc.getPage(i);
          text += E.itemsToText((await pg.getTextContent()).items) + "\n";
        }
        ctx.text = text;
        const pg1 = await doc.getPage(1);
        const vp = pg1.getViewport({ scale: 2 });
        canvas = document.createElement("canvas"); canvas.width = vp.width; canvas.height = vp.height;
        await pg1.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        const chars = text.replace(/\s/g, "").length;
        if (chars < 40) {
          ctx.mode = "scan";
          ctx.imageBlob = await canvasToBlob(canvas, "image/jpeg", 0.88);
          checks.push({ status: "warn", label: "Text layer", detail: `Only ${chars} characters. This is a scanned image, so it goes to vision reading`, code: "SCANNED" });
        } else {
          ctx.mode = "text";
          checks.push({ status: "pass", label: "Text layer", detail: `${chars.toLocaleString()} characters across ${doc.numPages} page${doc.numPages > 1 ? "s" : ""}` });
        }
      } else {
        ctx.mode = "image";
        const img = await loadImage(blob);
        canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        let c2 = canvas;
        if (canvas.width > 1800) { c2 = document.createElement("canvas"); c2.width = 1800; c2.height = Math.round(canvas.height * 1800 / canvas.width); c2.getContext("2d").drawImage(canvas, 0, 0, c2.width, c2.height); }
        ctx.imageBlob = await canvasToBlob(c2, "image/jpeg", 0.88);
        checks.push({ status: "warn", label: "Text layer", detail: "Image upload, so it goes to vision reading", code: "SCANNED" });
      }
      run.thumb = thumbOf(canvas);
      showDoc(run.thumb, ctx.mode);
      if (ctx.mode !== "text" && !(S.sample && S.sampleImages) && !S.server) {
        checks.push({ status: "fail", label: "Vision reader", detail: "No text to parse and AI vision is not available in this view", code: "UNREADABLE" });
        return { state: "fail", summary: "Scanned document, and no reader can see it", checks };
      }
      return { state: ctx.mode === "text" ? "pass" : "warn", summary: ctx.mode === "text" ? "Native PDF text layer extracted" : "Scanned page rendered for Claude vision", checks };
    });
    run.read_mode = ctx.mode;

    // 3 extract
    const extractChecks = [];
    await stage(run, "extract", async () => {
      const rules = ctx.text && ctx.mode === "text" ? E.rulesRead(ctx.text) : null;
      let ai = null, aiNote = "";
      const canAI = (S.server || (S.sample && (ctx.mode === "text" || S.sampleImages))) && !(readRes.checks || []).some((c) => c.code === "UNREADABLE");
      if (canAI) {
        const streamEl = document.createElement("div"); streamEl.className = "stream"; streamEl.textContent = "Claude is reading…";
        const host = document.querySelector('[data-stage="extract"] .st-body'); if (host) host.appendChild(streamEl);
        try {
          const res = await aiRead(ctx.text, ctx.mode === "text" ? null : ctx.imageBlob, (t) => { streamEl.textContent = t; streamEl.scrollTop = streamEl.scrollHeight; });
          ai = E.sanitizeAI(res.raw);
          if (!ai) aiNote = "Claude's answer wasn't valid JSON. Fell back to the rules reader";
        } catch (e) {
          const code = e && e.code;
          if (code === "not_granted" && S.sample) { S.sample = null; chip("ai", false, "AI reader: not allowed · rules only"); }
          aiNote = code === "rate_limited" ? "The AI reader is rate limited. Used the rules reader" : code === "not_granted" ? "AI reading was declined. Used the rules reader" : "The AI reader was unavailable (" + (e && (e.message || code) || "error") + "). Used the rules reader";
        }
      } else if (ctx.mode === "text") aiNote = "AI reader off. Used the deterministic rules reader";
      run.reader = ai ? (rules ? "claude+rules" : "claude-vision") : (rules ? "rules" : "none");
      const merged = E.mergeFields(ai, rules || E.rulesRead(""));
      const fields = merged.fields;
      run.fields = fields; run.provenance = merged.provenance;
      run.crosscheck = ai && rules ? E.crossCheck(ai, rules) : null;
      if (aiNote) extractChecks.push({ status: "warn", label: "Reader", detail: aiNote, code: "AI_FALLBACK" });
      if (ai) extractChecks.push({ status: "pass", label: (S.server && !S.sample ? S.server.label : "Claude") + " reader", detail: `${(fields.line_items || []).length} line items, ${Object.keys(fields).filter((k) => fields[k] != null && fields[k] !== "" && !(Array.isArray(fields[k]) && !fields[k].length)).length} fields populated${ai.document_type && ai.document_type !== "invoice" ? " · document type: " + ai.document_type : ""}` });
      if (run.crosscheck) {
        const dis = run.crosscheck.filter((x) => x.state === "disagree");
        const agreed = run.crosscheck.filter((x) => x.state === "agree").length;
        if (dis.length) extractChecks.push({ status: "warn", label: "Cross-check", detail: "Readers disagree on " + dis.map((d) => d.field).join(", "), code: "EXTRACTION_CONFLICT" });
        else extractChecks.push({ status: "pass", label: "Cross-check", detail: `Claude and the rules parser agree on ${agreed} money fields` });
      } else if (ai && ctx.mode !== "text") extractChecks.push({ status: "pass", label: "Cross-check", detail: "No text layer to cross-check against. Arithmetic checks in the next stage act as the second reader" });
      if (Object.keys(merged.provenance).length) extractChecks.push({ status: "pass", label: "Gap fill", detail: "Rules reader supplied: " + Object.keys(merged.provenance).join(", ") });
      renderFields(run);
      const st = extractChecks.some((c) => c.status === "fail") ? "fail" : extractChecks.some((c) => c.status === "warn") ? "warn" : "pass";
      return { state: st, summary: `${fields.invoice_number || "no number"} · ${fields.total != null ? fmt(fields.total) : "no total"} · read by ${({ "claude+rules": "Claude + rules parser", "claude-vision": "AI vision", rules: "rules parser", none: "nobody" })[run.reader]}`, checks: extractChecks };
    });

    // 4–7 deterministic checks
    const f = run.fields || {};
    const today = new Date().toISOString().slice(0, 10);
    const history = E.buildHistory(S.ref, S.runs.filter((r) => r.id !== run.id));
    let validation, vendorRes, dupRes, poRes;
    await stage(run, "validate", async () => { validation = E.validateInvoice(f, S.rules, today); return pack(validation, (v) => v.status === "pass" ? "Complete and arithmetically consistent" : null); });
    await stage(run, "vendor", async () => { vendorRes = E.verifyVendor(f, ctx.text, S.ref); return pack(vendorRes, (v) => v.vendor ? `${v.vendor.name} (${v.vendor.id})` : "Vendor not identified"); });
    await stage(run, "dup", async () => { dupRes = E.checkDuplicates(f, vendorRes.vendor, run.file_hash, history, S.rules); return pack(dupRes, (v) => v.duplicateOf ? "Matches " + (v.duplicateOf.invoice_no || v.duplicateOf.ref) : "No prior copy found"); });
    await stage(run, "po", async () => { poRes = E.matchPO(f, vendorRes.vendor, S.ref, history, S.rules, validation.subtotal); return pack(poRes, (v) => v.po ? `${v.po} · ${v.matchType}` : null); });

    // 8 decide
    await stage(run, "decide", async () => {
      const d = E.decide({ fields: f, read: { checks: (readRes.checks || []).concat(extractChecks) }, validation, vendorRes, dupRes, poRes, rules: S.rules, buyer: S.ref.buyer });
      run.decision = d; run.po_result = { po: poRes.po, lines: poRes.lines, matchType: poRes.matchType, inferred: poRes.inferred, poTotal: poRes.poTotal, approvable: poRes.approvable, disputed: poRes.disputed, billedBefore: poRes.billedBefore };
      const v = vendorRes.vendor;
      run.summary = { invoice_no: f.invoice_number || null, vendor_id: v ? v.id : null, vendor_name: v ? v.name : (f.vendor_name || "Unknown"), po: poRes.po || null,
        invoice_date: f.invoice_date || null, total: f.total, subtotal: validation.subtotal, outcome: d.outcome, status: E.statusFromOutcome(d.outcome),
        approvable: poRes.approvable, top_reason: d.reasons[0] ? d.reasons[0].code : null, codes: d.reasons.map((r) => r.code),
        lines: (poRes.lines || []).filter((l) => l.poLine).map((l) => ({ po_line: l.poLine, qty: l.qty, amount: E.r2(l.qty * (l.unit || 0)) })),
        lines_ok: (poRes.lines || []).filter((l) => l.poLine).map((l) => ({ po_line: l.poLine, qty: l.okQty || 0, amount: l.approvable || 0 })) };
      return { state: { APPROVED: "pass", NEEDS_REVIEW: "warn", RETURNED: "warn", REJECTED: "fail" }[d.outcome], summary: d.label + " · " + d.route, checks: [] };
    });
    run.duration_ms = Math.round(performance.now() - T0);
    run.sample = opts && opts.sample ? true : false;
    await saveRun(run);
    renderRun(run);
    S.running = false; setBusy(false);
    renderDashboard(); renderReference();
    return run;
  }
  function pack(res, okSummary) {
    const fails = res.checks.filter((c) => c.status === "fail"), warns = res.checks.filter((c) => c.status === "warn");
    const summary = fails.length ? fails.length + " issue" + (fails.length > 1 ? "s" : "") + ": " + fails[0].label : warns.length ? (okSummary(res) || "Passed") + " · " + warns.length + " note" + (warns.length > 1 ? "s" : "") : (okSummary(res) || "All checks passed");
    return { state: res.status, summary, checks: res.checks };
  }
  function setBusy(b) { document.querySelectorAll("[data-run], #run-all, #file").forEach((el) => (el.disabled = b)); $("#drop").style.pointerEvents = b ? "none" : ""; }

  // ---------------------------------------------------------------- rendering: run
  function renderRun(run) {
    const h = $("#run-head");
    if (!run) {
      h.innerHTML = `<div class="empty"><h3>Pick an invoice to process</h3><p style="margin:0">Drop a PDF or image, or run one from the sample inbox. Each stage appears here as it runs: what was read, every check, and the decision with its reasons.</p></div>`;
      $("#stages").innerHTML = ""; $("#decision-slot").innerHTML = ""; $("#match-slot").innerHTML = ""; return;
    }
    const d = run.decision;
    h.innerHTML = `<div class="run-head"><h2>${esc(run.file_name)}</h2>
      <div class="meta"><span class="mono">${esc(run.id)}</span><span>${new Date(run.created_at).toLocaleString()}</span>${run.duration_ms ? `<span class="mono">${(run.duration_ms / 1000).toFixed(1)} s</span>` : `<span>running…</span>`}${run.reader ? `<span>reader: ${esc(run.reader)}</span>` : ""}</div>
      ${d ? `<span class="pill ${d.tone}" style="margin-left:auto">${esc(d.label)}</span>` : ""}</div>`;
    renderStages(run);
    renderDecision(run);
    renderMatch(run);
    if (run.fields) renderFields(run);
    if (run.thumb && !S.running) showDoc(run.thumb, run.read_mode);
  }
  function renderStages(run) {
    const ol = $("#stages");
    ol.innerHTML = STAGES.map((s, i) => {
      const st = run.stages[s.key] || { state: "pending" };
      const checks = (st.checks || []).filter((c) => c.label);
      return `<li class="stage" data-stage="${s.key}" data-state="${st.state}">
        <span class="dot">${st.state === "pass" ? "✓" : st.state === "fail" ? "!" : st.state === "warn" ? "•" : i + 1}</span>
        <div class="st-body"><div class="st-head"><span class="st-name">${s.name} <span class="src">${{ ai: "AI", rule: "RULES", sys: "SYSTEM" }[s.who]}</span></span><span class="st-ms">${st.ms != null ? st.ms + " ms" : st.state === "running" ? "running" : ""}</span></div>
        ${st.summary ? `<div class="st-sum">${esc(st.summary)}</div>` : ""}
        ${checks.length ? `<ul class="checks">${checks.map((c) => `<li><span class="ic ${c.status}">${{ pass: "✓", warn: "!", fail: "✕", skip: "–" }[c.status] || "·"}</span><span><b>${esc(c.label)}</b> · ${esc(c.detail)}</span></li>`).join("")}</ul>` : ""}
        </div></li>`;
    }).join("");
  }
  function renderDecision(run) {
    const slot = $("#decision-slot");
    const d = run.decision;
    if (!d) { slot.innerHTML = ""; return; }
    const reviewHtml = run.review ? `<div class="review"><div class="reviewed"><b>${esc({ approve: "Approved by reviewer", partial: "Partially approved by reviewer", reject: "Rejected by reviewer" }[run.review.action])}</b>${run.review.action === "partial" ? " · " + fmt(run.summary.approvable) : ""} · ${new Date(run.review.at).toLocaleString()}${run.review.note ? `<br><span class="muted">“${esc(run.review.note)}”</span>` : ""}</div></div>`
      : d.outcome === "NEEDS_REVIEW" ? `<div class="review"><div class="lbl">Reviewer decision</div>
        <textarea id="rv-note" placeholder="Note for the audit trail, e.g. 'Called vendor on file, change not confirmed'"></textarea>
        <div class="row">${d.approvable > 0 && d.disputed > 0 ? `<button class="btn ok" data-review="partial">Approve ${fmt(d.approvable)} (matched part)</button>` : ""}
        <button class="btn" data-review="approve">Approve in full</button><button class="btn bad" data-review="reject">Reject</button></div></div>` : "";
    slot.innerHTML = `<div class="card decision" data-tone="${d.tone}">
      <div class="dec-top"><span class="pill ${d.tone}">${esc(d.label)}</span><span class="muted">${esc(d.route)}</span><span class="dec-amt">${d.amount != null ? fmt(d.amount) : ""}</span></div>
      <div class="dec-head">${esc(d.headline)}</div>
      <div class="dec-grid">
        <div><div class="lbl">Why</div>${d.reasons.length ? `<ul class="reasons">${d.reasons.map((r) => `<li class="${r.severity}"><code>${esc(r.code)}</code>${esc(r.text)}</li>`).join("")}</ul>` : `<span class="muted">All ${countChecks(run)} checks passed.</span>`}</div>
        <div><div class="lbl">Next steps</div><ol class="next">${d.next.map((n) => `<li>${esc(n)}</li>`).join("")}</ol></div>
      </div>
      ${d.message ? `<div class="msg"><div class="msg-h"><div><div class="lbl" style="margin:0">Drafted message · ${esc(d.message.audience)}</div><div class="muted" style="font-size:12.5px">To ${esc(d.message.to)} · ${esc(d.message.subject)}</div></div><button class="btn small" id="copy-msg">Copy</button></div><pre>${esc(d.message.body)}</pre><div class="faint" style="font-size:12px;margin-top:6px">Drafted for a person to send. Nothing is emailed automatically.</div></div>` : ""}
      ${reviewHtml}
    </div>`;
    const cp = $("#copy-msg");
    if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(`Subject: ${d.message.subject}\n\n${d.message.body}`); toast("Message copied"); } catch (e) { toast("Copy was blocked. Select the text instead."); } };
    slot.querySelectorAll("[data-review]").forEach((b) => (b.onclick = () => review(run, b.dataset.review, ($("#rv-note") || {}).value || "")));
  }
  function countChecks(run) { return Object.values(run.stages).reduce((s, st) => s + (st.checks || []).length, 0); }
  async function review(run, action, note) {
    run.review = { action, note, at: new Date().toISOString() };
    run.summary.status = action === "reject" ? "rejected" : "approved";
    if (action === "partial") run.summary.subtotal_paid = run.summary.approvable;
    await saveRun(run);
    renderRun(run); renderDashboard(); renderReference();
    toast(action === "reject" ? "Rejected and logged" : "Approval logged to the audit trail");
  }
  function renderMatch(run) {
    const slot = $("#match-slot");
    const p = run.po_result;
    if (!p || (!p.lines && !p.inferred)) { slot.innerHTML = ""; return; }
    const inf = p.inferred && p.inferred.candidates ? `<div class="card-b" style="border-bottom:1px solid var(--line)"><div class="lbl">No PO printed. Candidates scored</div>
      <table><thead><tr><th>PO</th><th class="r">Line text</th><th class="r">Amount fit</th><th class="r">Price fit</th><th class="r">Score</th></tr></thead><tbody>
      ${p.inferred.candidates.map((c, i) => `<tr><td class="mono">${esc(c.po)}${i === 0 && p.po ? " ✓" : ""}</td><td class="r num">${Math.round(c.lineScore * 100)}%</td><td class="r num">${Math.round(c.amtFit * 100)}%</td><td class="r num">${Math.round(c.priceFit * 100)}%</td><td class="r num"><b>${Math.round(c.score * 100)}%</b></td></tr>`).join("")}
      </tbody></table></div>` : "";
    const lines = (p.lines || []).length ? `<table><thead><tr><th>Invoice line → PO line</th><th class="r">Billed</th><th class="r">Received</th><th class="r">Prior billed</th><th class="r">Price vs PO</th><th class="r">OK to pay</th></tr></thead><tbody>
      ${p.lines.map((l) => `<tr><td>${esc(l.desc)}${l.poLine ? `<div class="faint" style="font-size:12px">→ L${l.poLine} ${esc(l.poDesc)}</div>` : `<div class="bad-t" style="font-size:12px">no PO line</div>`}</td>
      <td class="r num ${l.qty > (l.received - (l.prior || 0)) ? "bad-t" : ""}">${l.qty ?? "—"}</td><td class="r num">${l.received ?? "—"}</td><td class="r num">${l.prior ?? "—"}</td>
      <td class="r num ${l.pv > (run.rules_used || S.rules).priceTolPct ? "bad-t" : ""}">${l.unit != null ? fmt(l.unit) : "—"}${l.poUnit != null ? `<div class="faint" style="font-size:11.5px">PO ${fmt(l.poUnit)}${l.pv ? ` · ${l.pv > 0 ? "+" : ""}${l.pv}%` : ""}</div>` : ""}</td>
      <td class="r num">${l.approvable != null ? fmt(l.approvable) : "—"}</td></tr>`).join("")}
      </tbody></table>` : "";
    slot.innerHTML = `<div class="card"><div class="card-h"><h2>PO match detail${p.po ? " · " + esc(p.po) : ""}</h2><span class="faint">${p.poTotal ? "PO value " + fmt(p.poTotal) : ""}</span></div>${inf}<div class="tbl-wrap">${lines}</div></div>`;
  }
  function showDoc(src, mode) {
    const f = $("#doc-frame");
    f.innerHTML = `<img alt="First page of the invoice" src="${src}">`;
    $("#doc-mode").textContent = { text: "native PDF · text layer", scan: "scanned PDF · no text layer", image: "image upload" }[mode] || "";
  }
  function renderFields(run) {
    const f = run.fields; if (!f) return;
    const pv = run.provenance || {};
    const row = (k, label, v) => `<dt>${label}</dt><dd>${v == null || v === "" ? '<span class="faint">not printed</span>' : esc(v)}${pv[k] ? '<span class="src">rules</span>' : ""}</dd>`;
    const aiName = S.server && !S.sample ? S.server.label : "Claude";
    $("#reader-label").textContent = ({ "claude+rules": aiName + " + rules parser", "claude-vision": aiName + " vision", rules: "rules parser only", none: "—" })[run.reader] || "";
    const items = f.line_items || [];
    $("#fields").innerHTML = `<dl class="kv">
      ${row("vendor_name", "Vendor", f.vendor_name || (run.summary && run.summary.vendor_name))}
      ${row("invoice_number", "Invoice no.", f.invoice_number)}
      ${row("invoice_date", "Invoice date", f.invoice_date)}
      ${row("po_reference", "PO reference", f.po_reference)}
      ${row("subtotal", "Subtotal", f.subtotal != null ? fmt(f.subtotal) : null)}
      ${row("tax_amount", "Tax", f.tax_amount != null ? fmt(f.tax_amount) : null)}
      ${row("total", "Total", f.total != null ? fmt(f.total) : null)}
      ${row("remit_account", "Remit to", f.remit_account ? `${f.remit_bank_name || "Bank"} · ${f.remit_routing || "?"} / ${f.remit_account}` : null)}
      ${row("vendor_emails", "Emails", (f.vendor_emails || []).join(", "))}
      </dl>
      ${items.length ? `<div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Line</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr></thead><tbody>${items.map((l) => `<tr><td>${esc(l.description)}</td><td class="r num">${l.quantity ?? "—"}</td><td class="r num">${l.unit_price != null ? l.unit_price.toFixed(2) : "—"}</td><td class="r num">${l.amount != null ? fmt(l.amount) : "—"}</td></tr>`).join("")}</tbody></table></div>` : ""}
      ${(f.unusual_instructions || []).length ? `<div class="notice" style="margin-top:10px"><b>Unusual instructions on the document:</b> ${esc(f.unusual_instructions.join(" / "))}</div>` : ""}`;
    const xc = run.crosscheck;
    $("#xcheck").innerHTML = xc ? `<table class="xc"><thead><tr><th>Field</th><th>Claude</th><th>Rules parser</th><th></th></tr></thead><tbody>${xc.map((x) => `<tr><td>${esc(x.field)}</td><td>${esc(x.ai ?? "—")}</td><td>${esc(x.rules ?? "—")}</td><td class="${x.state === "agree" ? "agree" : x.state === "disagree" ? "disagree" : "partial"}">${{ agree: "✓ agree", disagree: "✕ differ", "ai-missing": "AI blank", "rules-missing": "rules blank", "both-empty": "both blank" }[x.state]}</td></tr>`).join("")}</tbody></table>`
      : `<div class="card-b faint">${run.reader === "claude-vision" ? "Scanned page: there's no text layer for the rules parser. The arithmetic checks (lines → subtotal → tax → total) act as the independent check." : run.reader === "rules" ? "AI reader off, so only the rules parser read this one." : "No cross-check for this run."}</div>`;
  }

  // ---------------------------------------------------------------- dashboard
  const TONE = { APPROVED: "var(--ok)", NEEDS_REVIEW: "var(--warn)", RETURNED: "var(--info)", REJECTED: "var(--bad)" };
  function effOutcome(r) { if (r.review) return r.review.action === "reject" ? "REJECTED" : "APPROVED"; return r.summary ? r.summary.outcome : null; }
  function renderDashboard() {
    const runs = S.runs.filter((r) => r.summary);
    const n = runs.length;
    const auto = runs.filter((r) => r.summary.outcome === "APPROVED").length;
    const open = runs.filter((r) => r.summary.outcome === "NEEDS_REVIEW" && !r.review);
    const valApproved = runs.reduce((s, r) => { const o = effOutcome(r); if (o !== "APPROVED") return s; return s + (r.review && r.review.action === "partial" ? r.summary.approvable : (r.summary.total || 0)); }, 0);
    const prevented = runs.filter((r) => effOutcome(r) === "REJECTED" || (r.summary.codes || []).some((c) => ["BANK_CHANGE", "DUP_NUMBER", "DUP_FILE"].includes(c))).reduce((s, r) => s + (r.summary.total || 0), 0);
    const avg = n ? runs.reduce((s, r) => s + (r.duration_ms || 0), 0) / n / 1000 : 0;
    const kpi = (l, v, s) => `<div class="card kpi"><div class="lbl">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
    $("#kpis").innerHTML = [
      kpi("Invoices processed", n, `${runs.filter((r) => r.reader && r.reader.startsWith("claude")).length} read by Claude`),
      kpi("Straight-through", n ? Math.round((auto / n) * 100) + "%" : "—", `${auto} auto-approved, no human touch`),
      kpi("Approved value", fmt(valApproved).replace(".00", ""), "incl. reviewer approvals"),
      kpi("Open exceptions", open.length, open.length ? "waiting on a reviewer" : "queue is clear"),
      kpi("Stopped before payment", fmt(prevented).replace(".00", ""), `avg ${avg.toFixed(1)} s per invoice`)
    ].join("");

    $("#queue-count").textContent = open.length ? open.length + " open" : "";
    $("#queue").innerHTML = open.length ? `<table><thead><tr><th>Invoice</th><th>Vendor</th><th class="r">Amount</th><th>Why it stopped</th><th></th></tr></thead><tbody>${open.map((r) => `<tr class="click" data-open="${r.id}"><td class="mono">${esc(r.summary.invoice_no || "—")}</td><td>${esc(r.summary.vendor_name)}</td><td class="r num">${fmt(r.summary.total)}</td><td>${esc(reasonLabel(r.summary.top_reason))}</td><td><button class="btn small" data-open="${r.id}">Open</button></td></tr>`).join("")}</tbody></table>`
      : `<div class="card-b faint">Nothing waiting. Exceptions land here with a recommendation attached.</div>`;

    $("#runs-table").innerHTML = n ? `<table><thead><tr><th>When</th><th>Invoice</th><th>Vendor</th><th class="r">Amount</th><th>Outcome</th><th>Reader</th><th class="r">Time</th></tr></thead><tbody>${runs.map((r) => {
      const o = effOutcome(r);
      return `<tr class="click" data-open="${r.id}"><td class="faint" style="white-space:nowrap">${new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td class="mono">${esc(r.summary.invoice_no || "—")}</td><td>${esc(r.summary.vendor_name)}</td><td class="r num">${fmt(r.summary.total)}</td>
      <td><span class="st-cell"><i style="background:${TONE[o]}"></i>${esc(E.OUTCOMES[o].label)}${r.review ? " (reviewed)" : ""}</span><div class="faint" style="font-size:11.5px">${esc(reasonLabel(r.summary.top_reason) || "")}</div></td><td class="faint">${esc(r.reader || "")}</td><td class="r num faint">${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : ""}</td></tr>`;
    }).join("")}</tbody></table>` : `<div class="empty"><h3>No runs yet</h3><p>Process the sample inbox to fill the dashboard.</p><button class="btn primary" data-runall>Run all 6 samples</button></div>`;

    const counts = { APPROVED: 0, NEEDS_REVIEW: 0, RETURNED: 0, REJECTED: 0 };
    runs.forEach((r) => counts[r.summary.outcome]++);
    $("#mix").innerHTML = n ? `<div class="mixbar">${Object.keys(counts).filter((k) => counts[k]).map((k) => `<span style="width:${(counts[k] / n) * 100}%;background:${TONE[k]}" title="${E.OUTCOMES[k].label}: ${counts[k]}"></span>`).join("")}</div>
      <div class="legend">${Object.keys(counts).map((k) => `<span><i style="background:${TONE[k]}"></i>${E.OUTCOMES[k].label} <b class="num">${counts[k]}</b></span>`).join("")}</div><div class="faint" style="font-size:12px;margin-top:8px">System decision at intake, before any reviewer action.</div>`
      : `<span class="faint">Appears after the first run.</span>`;

    const rc = {};
    runs.filter((r) => r.summary.outcome !== "APPROVED").forEach((r) => (r.summary.codes || []).forEach((c) => { if (c && !["PO_INFERRED", "SCANNED", "AI_FALLBACK"].includes(c)) rc[c] = (rc[c] || 0) + 1; }));
    const top = Object.entries(rc).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = top.length ? top[0][1] : 1;
    $("#reasons").innerHTML = top.length ? `<div class="bars">${top.map(([c, k]) => `<div class="bar-row"><span>${esc(reasonLabel(c))}</span><span class="num r" style="text-align:right">${k}</span><div class="track"><span style="width:${(k / max) * 100}%"></span></div></div>`).join("")}</div>` : `<span class="faint">Exception reasons are counted here so you can see which vendors or rules create the most work.</span>`;

    $("#ledger-mini").innerHTML = `<table><thead><tr><th>Invoice</th><th>Vendor</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>${S.ref.ledger.map((l) => `<tr><td class="mono">${esc(l.invoice_no)}</td><td>${esc(vendorName(l.vendor_id))}</td><td class="r num">${fmt(l.total)}</td><td>${esc(l.status)}${l.paid_on ? " " + l.paid_on : ""}</td></tr>`).join("")}</tbody></table>`;
  }
  const REASONS = { DUP_NUMBER: "Duplicate invoice number", DUP_FILE: "Same file resubmitted", DUP_AMOUNT: "Same vendor + amount", BANK_CHANGE: "Bank details differ from master", LOOKALIKE_DOMAIN: "Look-alike sender domain",
    PAYMENT_INSTRUCTION: "Asks to change payment details", MISSING_FIELDS: "Missing mandatory fields", PRICE_VARIANCE: "Price above PO tolerance", QTY_OVER_RECEIPT: "Billed more than received", QTY_OVER_PO: "Billed more than ordered",
    PO_OVERBILLED: "PO value exceeded", PO_NOT_FOUND: "PO not found", PO_AMBIGUOUS: "No confident PO match", PO_VENDOR_MISMATCH: "PO belongs to another vendor", UNKNOWN_VENDOR: "Unknown vendor", VENDOR_BLOCKED: "Vendor blocked",
    LINE_MATH: "Line arithmetic wrong", SUBTOTAL_MATH: "Lines ≠ subtotal", TOTAL_MATH: "Subtotal + tax ≠ total", UNREADABLE: "Unreadable document", EXTRACTION_CONFLICT: "Readers disagree", OVER_LIMIT: "Above auto-approve limit",
    LINE_NOT_ON_PO: "Line not on PO", PO_INFERRED: "PO inferred", STALE: "Old invoice", TAX_RATE: "Unusual tax rate", FUTURE_DATE: "Future-dated", CURRENCY: "Wrong currency", LOW_CONFIDENCE: "Low read confidence" };
  const reasonLabel = (c) => (c ? REASONS[c] || c : "");
  const vendorName = (id) => { const v = S.ref.vendors.find((x) => x.id === id); return v ? v.name : id; };

  // ---------------------------------------------------------------- reference + rules + how
  function renderReference() {
    const history = E.buildHistory(S.ref, S.runs);
    $("#po-table").innerHTML = `<table><thead><tr><th>PO</th><th>Vendor</th><th>Line</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Unit price</th><th class="r">Billed qty</th><th class="r">PO value</th><th class="r">Billed</th></tr></thead><tbody>${S.ref.purchase_orders.map((po) => {
      const b = E.billedOnPO(po, history), tot = E.poTotals(po);
      return po.lines.map((l, i) => `<tr><td class="mono">${i === 0 ? esc(po.po) : ""}</td><td>${i === 0 ? esc(vendorName(po.vendor_id)) : ""}</td><td>${esc(l.desc)}</td><td class="r num">${l.qty}</td><td class="r num ${l.received < l.qty ? "warn-t" : ""}">${l.received}</td><td class="r num">${fmt(l.unit_price)}</td><td class="r num">${b.byLine[l.line] || 0}</td><td class="r num">${i === 0 ? fmt(tot) : ""}</td><td class="r num">${i === 0 ? fmt(b.amount) : ""}</td></tr>`).join("");
    }).join("")}</tbody></table>`;
    $("#vendor-table").innerHTML = `<table><thead><tr><th>ID</th><th>Vendor</th><th>Status</th><th>Tax ID</th><th>Email domain</th><th>Phone on file</th><th>Bank on file</th><th>Terms</th></tr></thead><tbody>${S.ref.vendors.map((v) => `<tr><td class="mono">${v.id}</td><td>${esc(v.name)}<div class="faint" style="font-size:12px">${esc((v.aliases || []).join(" · "))}</div></td><td><span class="pill ${v.status === "approved" ? "ok" : "bad"}">${v.status}</span></td><td class="mono">${v.tax_id}</td><td class="mono">${v.email_domain}</td><td class="mono" style="white-space:nowrap">${v.phone}</td><td>${esc(v.bank.name)}<div class="mono faint" style="font-size:12px">${v.bank.routing} / ••${v.bank.account.slice(-4)}</div></td><td>${v.payment_terms}</td></tr>`).join("")}</tbody></table>`;
    $("#ledger-table").innerHTML = `<table><thead><tr><th>Invoice</th><th>Vendor</th><th>PO</th><th>Date</th><th class="r">Subtotal</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>${S.ref.ledger.map((l) => `<tr><td class="mono">${esc(l.invoice_no)}</td><td>${esc(vendorName(l.vendor_id))}</td><td class="mono">${l.po}</td><td>${l.invoice_date}</td><td class="r num">${fmt(l.subtotal)}</td><td class="r num">${fmt(l.total)}</td><td>${l.status}${l.paid_on ? " · " + l.paid_on : ""}</td></tr>`).join("")}</tbody></table>`;
  }

  const RULE_META = [
    ["priceTolPct", "Unit price tolerance (%)", "How far above the PO unit price a line may be before it stops. Below the PO price always passes."],
    ["poOverbillTolPct", "PO over-billing tolerance (%)", "Cumulative billing across all invoices on a PO may exceed its value by this much (freight and rounding)."],
    ["autoApproveLimit", "Auto-approve limit ($)", "Clean invoices above this still go to an AP manager."],
    ["inferMinConf", "Inferred PO: minimum score (0–1)", "When no PO is printed, the best candidate must score at least this."],
    ["inferMinMargin", "Inferred PO: lead over runner-up (0–1)", "…and must beat the next candidate by this much, so near-ties go to a human."],
    ["dupWindowDays", "Soft-duplicate window (days)", "Same vendor and same amount within this window gets flagged."],
    ["maxAgeDays", "Stale invoice warning (days)", "Older invoices get a warning (possible re-send of an old bill)."],
    ["minFieldConf", "Minimum AI read confidence (0–1)", "Below this on a money field, the read is flagged."]
  ];
  function renderRules() {
    $("#rules-form").innerHTML = RULE_META.map(([k, l, h]) => `<div class="field"><label for="rule-${k}">${l}</label><input id="rule-${k}" type="number" step="any" value="${S.rules[k]}"><small>${h}</small></div>`).join("");
  }
  function renderHow() {
    const desc = {
      intake: "Fingerprints the file (SHA-256) and checks its real type from the bytes.",
      read: "Pulls the PDF text layer. If there is none (a scan), renders the page for vision.",
      extract: "Claude reads the invoice into a strict schema. A separate regex parser reads the same text, and the fields that move money must agree.",
      validate: "Mandatory fields, qty × price, lines → subtotal → tax → total, date sanity.",
      vendor: "Vendor master lookup by name, tax ID or domain. Remit-to bank against the account on file, look-alike domains, bank-change language.",
      dup: "Exact file hash, normalised invoice number (KL/2026/917 = KL-2026-0917), and same-amount near matches.",
      po: "Explicit or inferred PO. Line-level 3-way match against goods receipts, counting what earlier invoices already billed.",
      decide: "Fixed precedence: duplicate > fraud > defective invoice > PO exception > limit > approve. Drafts the follow-up message."
    };
    $("#flow").innerHTML = STAGES.map((s, i) => `<div class="node"><div class="who ${s.who}">${i + 1} · ${{ ai: "AI", rule: "Rules", sys: "System" }[s.who]}</div><b>${s.name}</b>${desc[s.key]}</div>`).join("");
    $("#how-prose").innerHTML = `
      <h3 style="margin-top:0">Design principle: AI reads, rules decide</h3>
      <p>Claude does the part that used to need a person's eyes: reading invoices that look different from every vendor, including scans. Every decision about money is made by plain rules you can read and adjust on the Rules tab. When an auditor asks why something was paid, the answer is a list of checks, not a model's opinion.</p>
      <h3>Why these edge cases</h3>
      <ul>
        <li><b>Split PO, over-billed (Meridian).</b> The common, expensive one. The second invoice on a PO is only wrong once you count what the first invoice already billed and what the dock actually received. The process recommends paying the matched $7,590 and asking for a credit note for the $2,860, rather than holding all $10,450.</li>
        <li><b>Disguised duplicate (Kestrel).</b> A "2nd notice" with the number reformatted, KL/2026/917 against the paid KL-2026-0917. An exact-match check misses it. Normalising the number, plus the matching amount and PO, catches it.</li>
        <li><b>Scanned, no PO (Orchid).</b> There's no text layer, so Claude reads the image. With no PO printed, each of the vendor's open POs is scored on line text, amount fit and price fit. It's auto-approved only if one candidate clearly wins. Not every anomaly should create human work.</li>
        <li><b>Bank-change fraud (Brightline).</b> The invoice is perfect: right PO, right amounts, goods received. Only the remit-to account and a look-alike domain are different. This is how business-email-compromise losses actually happen, so it beats every other signal and routes to a phone call to the number on file.</li>
        <li><b>Bonus: incomplete (Kestrel).</b> No invoice number or date, one bundled line. It goes back to the vendor with a drafted request, because the defect is theirs to fix.</li>
      </ul>
      <h3>Assumptions</h3>
      <ul>
        <li>The buyer is a single US entity paying in USD. PO amounts are pre-tax and invoice tax is checked for plausibility, not recomputed per jurisdiction.</li>
        <li>Goods-receipt quantities live on the PO lines (received column). In production they'd come from the warehouse system.</li>
        <li>"Approved" in the ledger means booked but not yet paid, and it counts toward PO consumption just like "paid".</li>
        <li>Vendor contact for follow-ups always comes from the vendor master, never from the invoice, so a fraudster can't route the conversation.</li>
        <li>Nothing is sent or paid automatically in this demo. Messages are drafted for a person, and approvals are logged.</li>
      </ul>
      <h3>What I'd build next</h3>
      <ul>
        <li>Email intake (AP mailbox → this pipeline) and an ERP write-back for approved invoices.</li>
        <li>Per-vendor learning: remember each vendor's layout quirks and tolerance history to cut false exceptions.</li>
        <li>Credit-note matching, so the Meridian dispute closes itself when the credit arrives.</li>
        <li>Sampling audit of auto-approved inferred-PO invoices, feeding back into the inference thresholds.</li>
      </ul>`;
  }

  function renderInbox() {
    const done = {};
    S.runs.forEach((r) => { if (r.sample_file && !done[r.sample_file]) done[r.sample_file] = r; });
    $("#inbox").innerHTML = SAMPLES.map((s, i) => {
      const r = done[s.file];
      const o = r ? effOutcome(r) : null;
      return `<li class="${S.current && S.current.sample_file === s.file ? "active" : ""}"><div><span class="tag ${s.kind}">${esc(s.tag)}</span><div class="t">${esc(s.title)}</div></div>
        <button class="btn small ${i === 0 && !r ? "primary" : ""}" data-run="${i}">Run</button>
        <div class="d">${esc(s.blurb)}${o ? `<div style="margin-top:4px"><span class="st-cell"><i style="background:${TONE[o]}"></i>Last run: ${esc(E.OUTCOMES[o].label)}</span></div>` : ""}</div></li>`;
    }).join("");
  }

  function renderAll() {
    renderInbox(); renderDashboard(); renderReference();
    if (!S.current) {
      const last = S.runs[0];
      if (last && last.summary) { S.current = last; renderRun(last); } else renderRun(null);
    }
  }

  // ---------------------------------------------------------------- actions
  async function runSample(i) {
    const s = SAMPLES[i];
    let blob;
    try { const res = await fetch(s.file); if (!res.ok) throw new Error(res.status); blob = await res.blob(); }
    catch (e) { toast("Couldn't load the sample file (" + e.message + ")."); return; }
    const run = await runPipeline(blob, s.file.split("/").pop(), { sample: true });
    if (run) { run.sample_file = s.file; await saveRun(run); renderInbox(); }
  }
  async function runAll() {
    for (let i = 0; i < SAMPLES.length; i++) { await runSample(i); await sleep(400); }
    toast("Inbox processed. See the Dashboard.");
  }
  async function resetHistory() {
    const ids = S.runs.map((r) => r.id);
    if (S.db) { for (const id of ids) { try { await S.db.collection("runs").doc(id).delete(); } catch (e) { /* view-only */ } } }
    S.runs = []; LS.set("idd.runs", []); S.current = null;
    renderAll(); toast("Demo history cleared. The pre-existing ledger is kept.");
  }
  function openRun(id) {
    const r = S.runs.find((x) => x.id === id); if (!r) return;
    S.current = r; location.hash = "run"; renderRun(r); renderInbox();
    if (r.thumb) showDoc(r.thumb, r.read_mode); else $("#doc-frame").innerHTML = '<span class="faint">Preview not stored for this run</span>';
    window.scrollTo({ top: 0 });
  }

  function route() {
    const v = (location.hash || "#run").slice(1);
    const view = ["run", "dashboard", "reference", "rules", "how"].includes(v) ? v : "run";
    document.querySelectorAll(".view").forEach((el) => (el.hidden = el.id !== "view-" + view));
    document.querySelectorAll("nav.tabs a").forEach((a) => { if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  }

  function bind() {
    window.addEventListener("hashchange", route);
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-run],[data-open],[data-runall]");
      if (!t) return;
      if (t.dataset.run != null) runSample(+t.dataset.run);
      else if (t.dataset.open) openRun(t.dataset.open);
      else if (t.hasAttribute("data-runall")) { location.hash = "run"; runAll(); }
    });
    $("#run-all").onclick = runAll;
    $("#reset").onclick = () => {
      const b = $("#reset");
      if (b.dataset.armed) { delete b.dataset.armed; b.textContent = "Reset demo history"; resetHistory(); }
      else { b.dataset.armed = "1"; b.textContent = "Click again to confirm"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Reset demo history"; }, 4000); }
    };
    const file = $("#file"), drop = $("#drop");
    file.onchange = () => { if (file.files[0]) runPipeline(file.files[0], file.files[0].name); file.value = ""; };
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) runPipeline(f, f.name); });
    $("#rules-save").onclick = () => {
      RULE_META.forEach(([k]) => { const v = parseFloat($("#rule-" + k).value); if (isFinite(v)) S.rules[k] = v; });
      LS.set("idd.rules", S.rules); toast("Rules saved. They apply to the next run.");
    };
    $("#rules-reset").onclick = () => { S.rules = Object.assign({}, E.DEFAULT_RULES); LS.set("idd.rules", S.rules); renderRules(); toast("Defaults restored"); };
  }

  async function boot() {
    route(); bind();
    try { S.ref = await (await fetch("reference.json")).json(); }
    catch (e) { $("main").insertAdjacentHTML("afterbegin", '<div class="notice">Reference data failed to load. Reload the page.</div>'); return; }
    S.rules = Object.assign({}, E.DEFAULT_RULES, LS.get("idd.rules", {}));
    renderRules(); renderHow(); renderAll();
    connectAI();
    connectDb();
  }
  boot();
})();
