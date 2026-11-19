/* Invoice Decision Desk — decision engine.
 * Pure functions only: no DOM, no network. AI reads the document; these rules decide.
 * Runs in the browser (window.Engine) and in Node (module.exports) for testing. */
(function (root) {
  "use strict";

  const DEFAULT_RULES = {
    priceTolPct: 2,          // unit price may exceed PO price by at most this %
    poOverbillTolPct: 1,     // cumulative billing may exceed PO value by at most this %
    autoApproveLimit: 25000, // invoices above this always get a human
    inferMinConf: 0.85,      // inferred PO match needs at least this score
    inferMinMargin: 0.2,     // ...and must beat the runner-up by this much
    dupWindowDays: 120,      // look-back for "same vendor, same amount" soft duplicates
    maxAgeDays: 180,         // older invoices get a warning
    mathTolAbs: 0.05,        // rounding tolerance for arithmetic checks ($)
    minFieldConf: 0.6        // AI confidence below this on a critical field forces review
  };

  // ------------------------------------------------------------------ utils
  const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  const fmt = (x) => (x == null || isNaN(x)) ? "—" : "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (x) => (x >= 0 ? "+" : "") + x.toFixed(2) + "%";

  function num(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const s = String(v).replace(/[$,\s]|USD/gi, "");
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const DATE_RES = [
    /(\d{4})-(\d{1,2})-(\d{1,2})/,                                   // 2026-11-12
    /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/,                    // Nov 11, 2026
    /(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]+(\d{4})/,                 // 14 Nov 2026 / 12-Nov-2026
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/                                  // 11/10/2026 (US)
  ];
  function iso(y, m, d) {
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  function parseDate(s) {
    if (!s) return null;
    s = String(s);
    let m;
    if ((m = s.match(DATE_RES[0]))) return iso(+m[1], +m[2], +m[3]);
    if ((m = s.match(DATE_RES[1])) && MONTHS[m[1].toLowerCase().slice(0, 3)]) return iso(+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2]);
    if ((m = s.match(DATE_RES[2])) && MONTHS[m[2].toLowerCase().slice(0, 3)]) return iso(+m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1]);
    if ((m = s.match(DATE_RES[3]))) return iso(+m[3], +m[1], +m[2]);
    return null;
  }
  function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
  function addDays(isoDate, n) { const d = new Date(isoDate + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  /** "KL-2026-0917", "KL/2026/917", "kl 2026 917" -> "KL-2026-917" */
  function normInvNo(s) {
    if (!s) return null;
    const groups = String(s).toUpperCase().match(/[A-Z]+|\d+/g);
    if (!groups) return null;
    return groups.map((g) => (/^\d+$/.test(g) ? String(parseInt(g, 10)) : g)).join("-");
  }
  function normPO(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{6,10})/);
    return m ? "PO-" + m[1] : null;
  }

  const STOP = new Set(["of", "the", "and", "x", "with", "for", "a", "an", "to", "in", "on", "per", "ea", "each", "incl", "inc"]);
  function tokens(s) {
    if (!s) return [];
    const out = [];
    String(s).toLowerCase()
      .replace(/(\d+)\s*-?\s*(pk|pck|pack)\b/g, "$1 pack")
      .replace(/(\d+)\s*-\s*(ream|pair|pairs)/g, "$1 $2")
      .split(/[^a-z0-9.]+/)
      .forEach((t) => {
        t = t.replace(/^\.+|\.+$/g, "");
        if (!t || STOP.has(t)) return;
        if (t === "pk") t = "pack";
        if (t.length > 3 && t.endsWith("s") && !/\d/.test(t)) t = t.slice(0, -1);
        out.push(t);
      });
    return out;
  }
  function dice(a, b) {
    const A = new Set(tokens(a)), B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0; A.forEach((t) => { if (B.has(t)) inter++; });
    return (2 * inter) / (A.size + B.size);
  }
  function lev(a, b) {
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  const CORP = /\b(inc|llc|co|corp|corporation|company|ltd|limited|the)\b\.?/gi;
  const normName = (s) => String(s || "").toLowerCase().replace(CORP, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const digits = (s) => (s == null ? null : String(s).replace(/\D/g, "") || null);

  // ------------------------------------------------------- rules reader
  const MONEY_RE = /\$?\d{1,3}(?:,\d{3})+\.\d{2}|\$?\d+\.\d{2}/g;
  const lastMoney = (line) => { const m = line.match(MONEY_RE); return m ? num(m[m.length - 1]) : null; };

  /** Deterministic reader over the document's text layer. Independent of the AI
   * reader, so the two can cross-check each other on the fields that move money. */
  function rulesRead(text) {
    const lines = String(text || "").split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const f = { invoice_number: null, invoice_date: null, po_reference: null, subtotal: null, tax_amount: null, tax_rate_pct: null,
      total: null, remit_routing: null, remit_account: null, vendor_emails: [], line_items: [], unusual_instructions: [] };
    const totalLabels = [/total due/i, /amount due/i, /balance due/i, /invoice total/i, /grand total/i, /(^|\s)total\b/i];
    let totalRank = 99;
    for (const line of lines) {
      let m;
      if (!f.invoice_number && (m = line.match(/(?:invoice\s*(?:#|no\.?|number|num)|inv\.?\s*#)\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]*\d[A-Z0-9\-\/]*)/i))) f.invoice_number = m[1];
      if (!f.invoice_date && (m = line.match(/(?:invoice\s*date|date\s*of\s*issue|issue\s*date|\bdate)\s*:?\s*(.{6,20})/i))) f.invoice_date = parseDate(m[1]);
      if (!f.po_reference && (m = line.match(/(?:p\.?o\.?\s*(?:number|no\.?|#|ref\w*)?|customer\s*po|purchase\s*order(?:\s*no\.?)?|your\s*reference)\s*[:#]?\s*((?:PO[-\s]?)?\d{6,10})\b/i))) f.po_reference = m[1];
      if (/sub\s*-?\s*total/i.test(line)) { if (f.subtotal == null) f.subtotal = lastMoney(line); continue; }
      if (/\btax\b/i.test(line) && lastMoney(line) != null && f.tax_amount == null) {
        f.tax_amount = lastMoney(line);
        const r = line.match(/(\d+(?:\.\d+)?)\s*%/); if (r) f.tax_rate_pct = +r[1];
        continue;
      }
      totalLabels.forEach((re, i) => { if (i < totalRank && re.test(line) && lastMoney(line) != null) { f.total = lastMoney(line); totalRank = i; } });
      if (!f.remit_routing && (m = line.match(/(?:routing|aba)\D{0,20}(\d{9})\b/i))) f.remit_routing = m[1];
      if (!f.remit_account && (m = line.match(/(?:account|acct)\.?\s*(?:no\.?|number|#)?\s*:?\s*(\d{6,17})\b/i))) f.remit_account = m[1];
      (line.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).forEach((e) => { if (!f.vendor_emails.includes(e.toLowerCase())) f.vendor_emails.push(e.toLowerCase()); });
      if (/(new|updated|changed?)\s+(bank|banking|account)|moved our accounts|remit .* new account/i.test(line)) f.unusual_instructions.push(line);
      if ((m = line.match(/^(.*[A-Za-z].*?)\s+(\d{1,3}(?:,\d{3})+|\d+)\s+\$?(\d[\d,]*\.\d{2,4})\s+\$?(\d[\d,]*\.\d{2})$/))) {
        f.line_items.push({ description: m[1], quantity: num(m[2]), unit_price: num(m[3]), amount: num(m[4]) });
      }
    }
    if (f.tax_amount == null && f.subtotal != null && f.total != null && Math.abs(f.subtotal - f.total) < 0.01) f.tax_amount = 0;
    return f;
  }

  /** Compare AI and rules readings on the fields that move money. */
  function crossCheck(ai, rules) {
    const out = [];
    const pairs = [
      ["invoice_number", (v) => normInvNo(v)],
      ["po_reference", (v) => normPO(v)],
      ["total", (v) => (v == null ? null : r2(v))],
      ["subtotal", (v) => (v == null ? null : r2(v))],
      ["remit_account", (v) => digits(v)],
      ["remit_routing", (v) => digits(v)]
    ];
    for (const [k, n] of pairs) {
      const a = n(ai && ai[k]), b = n(rules && rules[k]);
      let state = "agree";
      if (a == null && b == null) state = "both-empty";
      else if (a == null) state = "ai-missing";
      else if (b == null) state = "rules-missing";
      else if (String(a) !== String(b)) state = "disagree";
      out.push({ field: k, ai: ai ? ai[k] : null, rules: rules ? rules[k] : null, state });
    }
    return out;
  }

  /** AI fields win; rules fill any gap the AI left. Records where each value came from. */
  function mergeFields(ai, rules) {
    if (!ai) return { fields: Object.assign({}, rules, { vendor_name: null }), provenance: {} };
    const f = JSON.parse(JSON.stringify(ai));
    const prov = {};
    ["invoice_number", "invoice_date", "po_reference", "subtotal", "tax_amount", "total", "remit_routing", "remit_account"].forEach((k) => {
      if ((f[k] == null || f[k] === "") && rules && rules[k] != null) { f[k] = rules[k]; prov[k] = "rules"; }
    });
    f.vendor_emails = Array.from(new Set([...(f.vendor_emails || []), ...((rules && rules.vendor_emails) || [])].map((e) => String(e).toLowerCase())));
    f.unusual_instructions = Array.from(new Set([...(f.unusual_instructions || []), ...((rules && rules.unusual_instructions) || [])]));
    if ((!f.line_items || !f.line_items.length) && rules && rules.line_items.length) { f.line_items = rules.line_items; prov.line_items = "rules"; }
    return { fields: f, provenance: prov };
  }

  function sanitizeAI(raw) {
    if (!raw || typeof raw !== "object") return null;
    const f = {};
    const str = (v) => (v == null || v === "" || /^(null|n\/a|none|unknown)$/i.test(String(v).trim())) ? null : String(v).trim();
    ["vendor_name", "vendor_tax_id", "invoice_number", "payment_terms", "po_reference", "currency", "remit_bank_name", "document_type"].forEach((k) => (f[k] = str(raw[k])));
    f.invoice_date = parseDate(str(raw.invoice_date));
    f.remit_routing = digits(str(raw.remit_routing));
    f.remit_account = digits(str(raw.remit_account));
    ["subtotal", "tax_amount", "tax_rate_pct", "total"].forEach((k) => (f[k] = num(raw[k])));
    f.vendor_emails = (Array.isArray(raw.vendor_emails) ? raw.vendor_emails : []).map(String).filter((e) => e.includes("@")).map((e) => e.toLowerCase());
    f.unusual_instructions = (Array.isArray(raw.unusual_instructions) ? raw.unusual_instructions : []).map(String).filter(Boolean);
    f.line_items = (Array.isArray(raw.line_items) ? raw.line_items : []).map((l) => ({
      description: str(l.description) || "", quantity: num(l.quantity), unit_price: num(l.unit_price), amount: num(l.amount)
    })).filter((l) => l.description || l.amount != null);
    f.field_confidence = raw.field_confidence && typeof raw.field_confidence === "object" ? raw.field_confidence : {};
    return f;
  }

  // -------------------------------------------------------------- stages
  const check = (id, label, status, detail, extra) => Object.assign({ id, label, status, detail }, extra || {});
  const rollup = (checks) => checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";

  function validateInvoice(f, rules, today) {
    const c = [];
    const missing = [];
    if (!f.invoice_number) missing.push("invoice number");
    if (!f.invoice_date) missing.push("invoice date");
    if (f.total == null) missing.push("total amount");
    c.push(missing.length
      ? check("required", "Mandatory fields present", "fail", "Missing: " + missing.join(", "), { code: "MISSING_FIELDS", missing })
      : check("required", "Mandatory fields present", "pass", "Invoice number, date and total all found"));

    const items = f.line_items || [];
    const badLines = items.filter((l) => l.quantity != null && l.unit_price != null && l.amount != null && Math.abs(r2(l.quantity * l.unit_price) - l.amount) > Math.max(rules.mathTolAbs, l.amount * 0.0005));
    if (!items.length) c.push(check("lines", "Line items itemised", "warn", "No line items found, so it can only be matched at header level", { code: "NO_LINES" }));
    else if (badLines.length) c.push(check("lines", "Line arithmetic (qty × price)", "fail", badLines.map((l) => `${l.description}: ${l.quantity} × ${l.unit_price} ≠ ${l.amount}`).join("; "), { code: "LINE_MATH" }));
    else c.push(check("lines", "Line arithmetic (qty × price)", "pass", `${items.length} line${items.length > 1 ? "s" : ""}, each qty × price = amount`));

    const lineSum = r2(items.reduce((s, l) => s + (l.amount || 0), 0));
    const sub = f.subtotal != null ? f.subtotal : (items.length ? lineSum : null);
    if (items.length && f.subtotal != null && Math.abs(lineSum - f.subtotal) > rules.mathTolAbs)
      c.push(check("subtotal", "Lines add up to subtotal", "fail", `Lines sum to ${fmt(lineSum)}, invoice says ${fmt(f.subtotal)}`, { code: "SUBTOTAL_MATH" }));
    else if (items.length && f.subtotal != null) c.push(check("subtotal", "Lines add up to subtotal", "pass", `${fmt(lineSum)}`));

    const tax = f.tax_amount || 0;
    if (sub != null && f.total != null) {
      const diff = r2(sub + tax - f.total);
      if (Math.abs(diff) > rules.mathTolAbs) c.push(check("total", "Subtotal + tax = total", "fail", `${fmt(sub)} + ${fmt(tax)} = ${fmt(sub + tax)}, invoice total is ${fmt(f.total)}`, { code: "TOTAL_MATH" }));
      else c.push(check("total", "Subtotal + tax = total", "pass", `${fmt(sub)} + ${fmt(tax)} tax = ${fmt(f.total)}`));
      if (tax > 0 && sub > 0) {
        const rate = (tax / sub) * 100;
        const known = [8.25, 6.25, 7, 7.5, 8, 8.875, 9.5, 10];
        if (!known.some((k) => Math.abs(k - rate) < 0.06)) c.push(check("taxrate", "Tax rate plausible", "warn", `Effective rate ${rate.toFixed(2)}% is not a known jurisdiction rate`, { code: "TAX_RATE" }));
        else c.push(check("taxrate", "Tax rate plausible", "pass", `${rate.toFixed(2)}% effective`));
      } else if (tax === 0) c.push(check("taxrate", "Tax treatment", "pass", "No tax charged (exempt or service)"));
    }

    if (f.invoice_date) {
      const age = daysBetween(f.invoice_date, today);
      if (age < -1) c.push(check("date", "Invoice date sane", "fail", `Dated ${f.invoice_date}, which is in the future`, { code: "FUTURE_DATE" }));
      else if (age > rules.maxAgeDays) c.push(check("date", "Invoice date sane", "warn", `${age} days old`, { code: "STALE" }));
      else c.push(check("date", "Invoice date sane", "pass", `${f.invoice_date} (${age} day${age === 1 ? "" : "s"} ago)`));
    }
    if (f.currency && !/usd|\$|us dollar/i.test(f.currency)) c.push(check("ccy", "Currency", "fail", `Billed in ${f.currency}, entity pays in USD`, { code: "CURRENCY" }));

    const conf = f.field_confidence || {};
    const low = ["invoice_number", "total", "po_reference", "remit_account"].filter((k) => f[k] != null && conf[k] != null && Number(conf[k]) < rules.minFieldConf);
    if (low.length) c.push(check("conf", "Read confidence", "warn", "Low confidence on: " + low.join(", "), { code: "LOW_CONFIDENCE", low }));
    return { status: rollup(c), checks: c, subtotal: sub };
  }

  function emailDomain(e) { return String(e).split("@")[1] || ""; }
  function lookalike(a, b) {
    const core = (d) => d.toLowerCase().replace(/\.(com|co|net|org|io|us|biz|info)$/, "").replace(/[^a-z0-9]/g, "");
    return a !== b && (core(a) === core(b) || lev(core(a), core(b)) <= 2);
  }

  function identifyVendor(f, text, ref) {
    const hay = String(text || "").toLowerCase();
    let best = null;
    for (const v of ref.vendors) {
      const ev = [];
      let score = 0;
      const names = [v.name].concat(v.aliases || []);
      const nameSim = f.vendor_name ? Math.max(...names.map((n) => dice(normName(n), normName(f.vendor_name)))) : 0;
      if (nameSim >= 0.75) { score = Math.max(score, 0.6 + 0.3 * nameSim); ev.push(`name "${f.vendor_name}" ≈ "${v.name}"`); }
      if (!f.vendor_name && names.some((n) => hay.includes(normName(n)) || hay.includes(n.toLowerCase()))) { score = Math.max(score, 0.8); ev.push("name found in document"); }
      const tid = digits(v.tax_id);
      if ((f.vendor_tax_id && digits(f.vendor_tax_id) === tid) || hay.includes(v.tax_id)) { score = score ? Math.min(1, score + 0.25) : 0.9; ev.push("tax ID matches " + v.tax_id); }
      if ((f.vendor_emails || []).some((e) => emailDomain(e) === v.email_domain)) { score = Math.max(score, 0.85); ev.push("email domain " + v.email_domain); }
      if (score && (!best || score > best.score)) best = { vendor: v, score: Math.min(1, score), evidence: ev };
    }
    return best;
  }

  function verifyVendor(f, text, ref) {
    const c = [];
    const id = identifyVendor(f, text, ref);
    if (!id || id.score < 0.6) {
      c.push(check("master", "Vendor in approved master", "fail", `"${f.vendor_name || "unknown"}" not found in vendor master`, { code: "UNKNOWN_VENDOR" }));
      return { status: "fail", checks: c, vendor: null };
    }
    const v = id.vendor;
    c.push(check("master", "Vendor identified", "pass", `${v.name} (${v.id}) via ${id.evidence.join(", ")}`, { confidence: id.score }));
    if (v.status !== "approved") c.push(check("status", "Vendor status", "fail", `${v.name} is ${v.status.toUpperCase()}: ${v.blocked_reason || ""}`, { code: "VENDOR_BLOCKED" }));
    else c.push(check("status", "Vendor status", "pass", "Approved, " + v.payment_terms));

    const acct = digits(f.remit_account), rout = digits(f.remit_routing);
    if (!acct && !rout) c.push(check("bank", "Remit-to bank matches master", "pass", `No bank details on invoice; will pay master account ••${v.bank.account.slice(-4)}`));
    else {
      const acctOk = !acct || acct === digits(v.bank.account);
      const routOk = !rout || rout === digits(v.bank.routing);
      if (acctOk && routOk) c.push(check("bank", "Remit-to bank matches master", "pass", `${v.bank.name} ••${v.bank.account.slice(-4)} matches vendor master`));
      else c.push(check("bank", "Remit-to bank matches master", "fail",
        `Invoice asks for payment to ${f.remit_bank_name || "a different bank"} (routing ${rout || "?"}, acct ••${(acct || "????").slice(-4)}). Master has ${v.bank.name} ••${v.bank.account.slice(-4)}.`,
        { code: "BANK_CHANGE", severity: "fraud" }));
    }
    const doms = Array.from(new Set((f.vendor_emails || []).map(emailDomain).filter(Boolean)));
    const look = doms.filter((d) => lookalike(d, v.email_domain));
    const foreign = doms.filter((d) => d !== v.email_domain && !look.includes(d) && !/haldenrobotics/.test(d));
    if (look.length) c.push(check("domain", "Sender domain", "fail", `${look.join(", ")} imitates the real domain ${v.email_domain}`, { code: "LOOKALIKE_DOMAIN", severity: "fraud" }));
    else if (foreign.length) c.push(check("domain", "Sender domain", "warn", `Unrecognised domain ${foreign.join(", ")} (master: ${v.email_domain})`, { code: "OTHER_DOMAIN" }));
    else if (doms.length) c.push(check("domain", "Sender domain", "pass", doms.join(", ")));
    const bankTalk = (f.unusual_instructions || []).filter((s) => /bank|account|remit|wire|ach|payment/i.test(s));
    if (bankTalk.length) c.push(check("instr", "Payment instructions", "fail", "Invoice tells AP to change payment details: “" + bankTalk[0].slice(0, 140) + "”", { code: "PAYMENT_INSTRUCTION", severity: "fraud" }));
    return { status: rollup(c), checks: c, vendor: v };
  }

  /** history rows: {invoice_no, vendor_id, po, invoice_date, total, subtotal, status, lines:[{po_line, qty, amount}], source, ref, file_hash} */
  function checkDuplicates(f, vendor, fileHash, history, rules) {
    const c = [];
    const live = history.filter((h) => !/rejected|returned/.test(h.status || ""));
    const sameFile = fileHash ? live.find((h) => h.file_hash && h.file_hash === fileHash) : null;
    if (sameFile) c.push(check("hash", "Exact file seen before", "fail", `Identical file was processed in ${sameFile.ref} (${sameFile.status})`, { code: "DUP_FILE", match: sameFile.ref }));
    else c.push(check("hash", "Exact file seen before", "pass", "New file fingerprint"));

    const n = normInvNo(f.invoice_number);
    let hard = null;
    if (n && vendor) hard = live.find((h) => h.vendor_id === vendor.id && normInvNo(h.invoice_no) === n);
    if (hard) {
      const same = hard.invoice_no === f.invoice_number;
      c.push(check("number", "Invoice number already on file", "fail",
        `${f.invoice_number} ${same ? "is" : "normalises to the same number as"} ${hard.invoice_no}, ${hard.status}${hard.paid_on ? " on " + hard.paid_on : ""} (${fmt(hard.total)})`,
        { code: "DUP_NUMBER", match: hard.ref || hard.invoice_no }));
    } else if (n) c.push(check("number", "Invoice number already on file", "pass", `${n} not seen for this vendor`));

    if (vendor && f.total != null) {
      const soft = live.filter((h) => h !== hard && h.vendor_id === vendor.id && Math.abs((h.total || 0) - f.total) < 0.01 &&
        (!f.invoice_date || !h.invoice_date || Math.abs(daysBetween(h.invoice_date, f.invoice_date)) <= rules.dupWindowDays));
      if (soft.length) c.push(check("amount", "Same vendor + same amount", hard ? "fail" : "warn",
        `${fmt(f.total)} matches ${soft.map((s) => s.invoice_no).join(", ")} within ${rules.dupWindowDays} days`, { code: "DUP_AMOUNT", match: soft[0].invoice_no }));
      else c.push(check("amount", "Same vendor + same amount", "pass", `No other ${fmt(f.total)} invoice from this vendor in ${rules.dupWindowDays} days`));
    }
    return { status: rollup(c), checks: c, duplicateOf: hard || sameFile || null };
  }

  function poTotals(po) { return r2(po.lines.reduce((s, l) => s + l.qty * l.unit_price, 0)); }
  function billedOnPO(po, history) {
    const rows = history.filter((h) => h.po === po.po && /paid|approved/.test(h.status || ""));
    const amount = r2(rows.reduce((s, h) => s + (h.subtotal || 0), 0));
    const byLine = {};
    rows.forEach((h) => (h.lines || []).forEach((l) => { byLine[l.po_line] = (byLine[l.po_line] || 0) + (l.qty || 0); }));
    return { amount, byLine, invoices: rows.map((h) => h.invoice_no) };
  }

  function matchLines(items, po) {
    const used = new Set();
    return items.map((it) => {
      let best = null;
      po.lines.forEach((pl) => {
        if (used.has(pl.line)) return;
        const d = dice(it.description, pl.desc);
        const p = it.unit_price != null ? Math.max(0, 1 - Math.abs(it.unit_price - pl.unit_price) / pl.unit_price * 4) : 0.5;
        const s = 0.75 * d + 0.25 * p;
        if (!best || s > best.score) best = { pl, score: s, desc: d };
      });
      if (best && best.score >= 0.35) { used.add(best.pl.line); return { item: it, poLine: best.pl, score: best.score }; }
      return { item: it, poLine: null, score: best ? best.score : 0 };
    });
  }

  function inferPO(f, vendor, ref, history, subtotal) {
    const cands = ref.purchase_orders.filter((p) => p.vendor_id === vendor.id && p.status === "open").map((po) => {
      const total = poTotals(po), billed = billedOnPO(po, history), remaining = r2(total - billed.amount);
      const items = f.line_items || [];
      const ml = matchLines(items, po);
      const lineScore = items.length ? ml.reduce((s, m) => s + (m.poLine ? dice(m.item.description, m.poLine.desc) : 0), 0) / items.length : 0;
      const priceFit = items.length ? ml.reduce((s, m) => s + (m.poLine && m.item.unit_price != null ? Math.max(0, 1 - Math.abs(m.item.unit_price - m.poLine.unit_price) / m.poLine.unit_price * 10) : 0), 0) / items.length : 0;
      const ratio = remaining > 0 && subtotal != null ? subtotal / remaining : 9;
      const amtFit = ratio <= 1.01 ? 0.6 + 0.4 * Math.min(1, ratio) : Math.max(0, 0.6 - (ratio - 1) * 3);
      const score = r2(0.5 * lineScore + 0.3 * amtFit + 0.2 * priceFit);
      return { po: po.po, score, lineScore: r2(lineScore), amtFit: r2(amtFit), priceFit: r2(priceFit), remaining };
    }).sort((a, b) => b.score - a.score);
    return cands;
  }

  function matchPO(f, vendor, ref, history, rules, subtotal) {
    const c = [];
    if (!vendor) return { status: "skip", checks: [check("po", "PO match", "skip", "Skipped: vendor not identified")], po: null };
    let po = null, inferred = null;
    const poRef = normPO(f.po_reference);
    if (poRef) {
      po = ref.purchase_orders.find((p) => p.po === poRef);
      if (!po) { c.push(check("po", "PO reference valid", "fail", `${f.po_reference} does not exist in the PO register`, { code: "PO_NOT_FOUND" })); return { status: "fail", checks: c, po: null }; }
      if (po.vendor_id !== vendor.id) { c.push(check("po", "PO belongs to vendor", "fail", `${po.po} was issued to ${po.vendor_id}, not ${vendor.id}`, { code: "PO_VENDOR_MISMATCH" })); return { status: "fail", checks: c, po: null }; }
      c.push(check("po", "PO reference valid", "pass", `${po.po} found${f.po_reference !== po.po ? ` (printed as "${f.po_reference}")` : ""}, issued ${po.issued}`));
    } else {
      const cands = inferPO(f, vendor, ref, history, subtotal);
      const best = cands[0], second = cands[1];
      const margin = best ? r2(best.score - (second ? second.score : 0)) : 0;
      inferred = { candidates: cands, margin };
      if (best && best.score >= rules.inferMinConf && margin >= rules.inferMinMargin) {
        po = ref.purchase_orders.find((p) => p.po === best.po);
        c.push(check("po", "PO inferred (none printed)", "warn",
          `No PO on invoice. Best match ${best.po}: score ${Math.round(best.score * 100)}% (lines ${Math.round(best.lineScore * 100)}%, amount fit ${Math.round(best.amtFit * 100)}%, price fit ${Math.round(best.priceFit * 100)}%), ahead of the next candidate by ${Math.round(margin * 100)} pts`,
          { code: "PO_INFERRED", confidence: best.score }));
      } else {
        c.push(check("po", "PO inferred (none printed)", "fail",
          best ? `No PO on invoice and no confident match. Best ${best.po} at ${Math.round(best.score * 100)}%, margin ${Math.round(margin * 100)} pts` : "No PO on invoice and no open POs for this vendor",
          { code: "PO_AMBIGUOUS" }));
        return { status: "fail", checks: c, po: null, inferred };
      }
    }

    const total = poTotals(po);
    const billed = billedOnPO(po, history);
    const items = f.line_items || [];
    const ml = matchLines(items, po);
    const lineResults = [];
    let approvable = 0, disputed = 0;
    ml.forEach((m) => {
      const it = m.item;
      if (!m.poLine) {
        lineResults.push({ desc: it.description, status: "fail", note: "No matching PO line" });
        c.push(check("line", `Line: ${it.description}`, "fail", "Not on the PO", { code: "LINE_NOT_ON_PO" }));
        disputed += it.amount || 0; return;
      }
      const pl = m.poLine;
      const prior = billed.byLine[pl.line] || 0;
      const qty = it.quantity || 0;
      const rcvAvail = Math.max(0, pl.received - prior);
      const ordAvail = Math.max(0, pl.qty - prior);
      const pv = it.unit_price != null ? ((it.unit_price - pl.unit_price) / pl.unit_price) * 100 : 0;
      const problems = [];
      if (pv > rules.priceTolPct) problems.push({ code: "PRICE_VARIANCE", text: `price ${fmt(it.unit_price)} vs PO ${fmt(pl.unit_price)} (${pct(pv)}, tolerance ${rules.priceTolPct}%)` });
      if (qty > ordAvail) problems.push({ code: "QTY_OVER_PO", text: `${qty} billed, only ${ordAvail} left unbilled on the PO (${pl.qty} ordered, ${prior} already billed)` });
      else if (qty > rcvAvail) problems.push({ code: "QTY_OVER_RECEIPT", text: `${qty} billed, only ${rcvAvail} received and unbilled (GRN ${pl.received}, ${prior} already billed)` });
      const okQty = Math.min(qty, rcvAvail, ordAvail);
      const okPrice = pv > rules.priceTolPct ? pl.unit_price : (it.unit_price != null ? it.unit_price : pl.unit_price);
      const lineOk = r2(okQty * okPrice);
      approvable += lineOk; disputed += Math.max(0, (it.amount || 0) - lineOk);
      lineResults.push({ desc: it.description, poLine: pl.line, poDesc: pl.desc, qty, unit: it.unit_price, poUnit: pl.unit_price, ordered: pl.qty, received: pl.received, prior, pv: r2(pv), status: problems.length ? "fail" : "pass", problems, approvable: lineOk, okQty });
      if (problems.length) problems.forEach((p) => c.push(check("line", `Line ${pl.line}: ${pl.desc}`, "fail", p.text, { code: p.code })));
      else c.push(check("line", `Line ${pl.line}: ${pl.desc}`, "pass", `${qty} × ${fmt(it.unit_price)} matches PO price${Math.abs(pv) > 0.001 ? ` (${pct(pv)})` : ""}, within received qty (${pl.received})`));
    });

    if (!items.length && subtotal != null) approvable = Math.min(subtotal, Math.max(0, total - billed.amount));
    const cum = r2(billed.amount + (subtotal || 0));
    const cap = r2(total * (1 + rules.poOverbillTolPct / 100));
    if (cum > cap) c.push(check("cum", "Cumulative billing within PO", "fail",
      `${billed.invoices.length ? billed.invoices.join(", ") + " already billed " + fmt(billed.amount) + "; " : ""}with this invoice ${fmt(cum)} against PO value ${fmt(total)} (${pct(((cum - total) / total) * 100)}, tolerance ${rules.poOverbillTolPct}%)`,
      { code: "PO_OVERBILLED" }));
    else c.push(check("cum", "Cumulative billing within PO", "pass", `${fmt(cum)} of ${fmt(total)} billed${billed.invoices.length ? " incl. " + billed.invoices.join(", ") : ""}`));

    return { status: rollup(c), checks: c, po: po.po, poTotal: total, billedBefore: billed, lines: lineResults, inferred, approvable: r2(approvable), disputed: r2(disputed), matchType: poRef ? (items.length ? "3-way (PO + receipt + invoice)" : "2-way header") : "inferred" };
  }

  // -------------------------------------------------------------- decision
  const OUTCOMES = {
    APPROVED: { label: "Approved for payment", tone: "ok" },
    NEEDS_REVIEW: { label: "Needs review", tone: "warn" },
    RETURNED: { label: "Returned to vendor", tone: "info" },
    REJECTED: { label: "Rejected", tone: "bad" }
  };

  function termsDays(t) { const m = String(t || "").match(/(\d+)/); return m ? +m[1] : 30; }

  function decide(ctx) {
    const { fields: f, read, validation, vendorRes, dupRes, poRes, rules, buyer } = ctx;
    const all = [].concat(validation.checks, vendorRes.checks, dupRes.checks, poRes.checks, read.checks || []);
    const has = (...codes) => all.filter((c) => c.status !== "pass" && codes.includes(c.code));
    const v = vendorRes.vendor;
    const reasons = [];
    const add = (arr, sev) => arr.forEach((c) => reasons.push({ code: c.code, severity: sev, text: c.detail, label: c.label }));
    let outcome, headline, route, next = [], message = null;
    const amount = f.total;
    const contactEmail = v ? `ap@${v.email_domain}` : null;

    const dup = has("DUP_FILE", "DUP_NUMBER");
    const blocked = has("VENDOR_BLOCKED");
    const fraud = all.filter((c) => c.status === "fail" && c.severity === "fraud");
    const unreadable = has("UNREADABLE");
    const missing = has("MISSING_FIELDS");
    const math = has("LINE_MATH", "SUBTOTAL_MATH", "TOTAL_MATH", "FUTURE_DATE", "CURRENCY");
    const poFails = has("PO_NOT_FOUND", "PO_VENDOR_MISMATCH", "PO_AMBIGUOUS", "PRICE_VARIANCE", "QTY_OVER_RECEIPT", "QTY_OVER_PO", "PO_OVERBILLED", "LINE_NOT_ON_PO");
    const unknown = has("UNKNOWN_VENDOR");
    const softs = has("DUP_AMOUNT", "LOW_CONFIDENCE", "EXTRACTION_CONFLICT", "OTHER_DOMAIN");

    if (dup.length) {
      outcome = "REJECTED"; add(dup, "critical"); add(has("DUP_AMOUNT"), "supporting");
      const d = dupRes.duplicateOf;
      headline = `Duplicate of ${d.invoice_no || d.ref}. Already ${d.status}${d.paid_on ? " on " + d.paid_on : ""}. Do not pay again.`;
      route = "Closed: duplicate. Vendor notified.";
      next = ["No payment created", `Original: ${d.invoice_no || d.ref}${d.paid_on ? `, paid ${d.paid_on}` : ""}`, "Reply to vendor with the remittance reference"];
      message = { audience: "Vendor", to: contactEmail, subject: `Re: invoice ${f.invoice_number}, already paid as ${d.invoice_no}`,
        body: `Hello ${v ? v.name : ""} team,\n\nWe received invoice ${f.invoice_number} for ${fmt(f.total)}. It matches invoice ${d.invoice_no} (dated ${d.invoice_date}, same amount and PO ${d.po || ""}), which was ${d.status}${d.paid_on ? " on " + d.paid_on : ""}.\n\nWe have closed the new copy so it is not paid twice. If you believe this is a separate charge, please send a new invoice with its own number and the delivery references it covers.\n\nThanks,\nAccounts Payable, ${buyer.name}` };
    } else if (blocked.length) {
      outcome = "REJECTED"; add(blocked, "critical");
      headline = `${v.name} is blocked in the vendor master. No payment until re-verification is complete.`;
      route = "Closed: vendor blocked. Sent to vendor management.";
      next = ["Vendor management to complete re-verification", "Resubmit once the vendor is reinstated"];
    } else if (fraud.length) {
      outcome = "NEEDS_REVIEW"; add(fraud, "critical");
      headline = `Payment-fraud risk. The invoice asks us to pay a bank account that is not on file${has("LOOKALIKE_DOMAIN").length ? ", from a look-alike email domain" : ""}. Payment is blocked until the change is verified by phone.`;
      route = "Treasury / fraud desk. Payment hold placed.";
      next = [`Call ${v.name} on the number in the vendor master (${v.phone}), not any number or email on the invoice`,
        "If they confirm a real bank change, update the master through the vendor-change workflow (dual approval)",
        "If they do not, report it as attempted business email compromise and alert the vendor",
        `Everything else checks out: once verified, release ${fmt(amount)} to the account on file`];
      message = { audience: "Internal: Treasury", to: "treasury@haldenrobotics.com", subject: `HOLD: bank-change request on ${v.name} invoice ${f.invoice_number}`,
        body: `Invoice ${f.invoice_number} from ${v.name} (${fmt(amount)}, ${poRes.po || "no PO"}) asks us to remit to ${f.remit_bank_name || "a new bank"} acct ••${String(f.remit_account || "").slice(-4)}.\n\nVendor master has ${v.bank.name} ••${v.bank.account.slice(-4)}.\n${has("LOOKALIKE_DOMAIN").map((c) => "Sender domain: " + c.detail).join("\n")}\n\nPO, receipt and amounts all match, which is typical of invoice-redirection fraud: the invoice looks right so that only the bank details change.\n\nAction: verify by calling ${v.phone} (number on file). Do not reply to the email on the invoice.` };
    } else if (unreadable.length) {
      outcome = "NEEDS_REVIEW"; add(unreadable, "critical");
      headline = "The document could not be read automatically. It needs manual keying.";
      route = "AP exceptions: manual keying";
      next = ["Key the invoice fields by hand, or enable AI reading and re-run"];
    } else if (missing.length || math.length) {
      outcome = "RETURNED"; add(missing, "critical"); add(math, "critical");
      const miss = (missing[0] && missing[0].missing) || [];
      headline = `Can't be booked as received: ${[miss.length ? "missing " + miss.join(" and ") : null, math.length ? "the amounts don't add up" : null].filter(Boolean).join(", and ")}. Sent back to the vendor for a corrected invoice.`;
      route = "Returned to vendor. Awaiting corrected invoice.";
      next = ["Vendor to reissue a compliant invoice", poRes.po ? `${poRes.po} stays open; nothing is booked` : "Nothing is booked"];
      message = { audience: "Vendor", to: contactEmail, subject: `Action needed: invoice for ${fmt(amount)}${poRes.po ? " on " + poRes.po : ""} can't be processed`,
        body: `Hello ${v ? v.name : ""} team,\n\nThanks for your invoice${poRes.po ? " against " + poRes.po : ""} for ${fmt(amount)}. We can't process it yet because:\n\n${missing.concat(math).map((c) => "  • " + c.detail).join("\n")}\n\nPlease send a corrected invoice with a unique invoice number and an invoice date${(f.line_items || []).length <= 1 ? ", and an itemised breakdown of the services billed" : ""}. Your payment terms will start from the date we receive it.\n\nThanks,\nAccounts Payable, ${buyer.name}` };
    } else if (unknown.length) {
      outcome = "NEEDS_REVIEW"; add(unknown, "critical");
      headline = "The sender is not an approved vendor. Route to vendor onboarding before anything is paid.";
      route = "Procurement: vendor onboarding";
      next = ["Confirm someone at Halden ordered this", "Onboard the vendor (W-9, bank verification) or reject"];
    } else if (poFails.length) {
      outcome = "NEEDS_REVIEW"; add(poFails, "critical");
      const partial = poRes.approvable > 0 && poRes.disputed > 0;
      headline = partial
        ? `Partly matches. ${fmt(poRes.approvable)} is backed by the PO and goods received, and ${fmt(poRes.disputed)} is not. Recommend paying the matched part and asking the vendor for a credit note for the rest.`
        : `Doesn't match the purchase order. Needs a buyer's decision.`;
      route = "Procurement buyer: PO exception";
      next = partial ? [`Approve ${fmt(poRes.approvable)} now (the received quantity at the PO price)`, `Ask the vendor for a credit note of ${fmt(poRes.disputed)}`, "Or get the buyer to raise a PO change if the extra quantity or price was agreed"]
        : ["The buyer confirms the correct PO, or raises a change order"];
      if (partial) message = { audience: "Vendor", to: contactEmail, subject: `Invoice ${f.invoice_number}: ${fmt(poRes.approvable)} approved, ${fmt(poRes.disputed)} queried`,
        body: `Hello ${v.name} team,\n\nWe've matched invoice ${f.invoice_number} (${fmt(f.total)}) against ${poRes.po} and our goods receipts.\n\n${poRes.lines.filter((l) => l.problems && l.problems.length).map((l) => `  • ${l.poDesc}: ${l.problems.map((p) => p.text).join("; ")}`).join("\n")}\n\nWe are releasing ${fmt(poRes.approvable)} for the quantities received at PO prices. For the balance of ${fmt(poRes.disputed)}, please send a credit note, or invoice the remaining units once they've been delivered, at the agreed PO price.\n\nThanks,\nAccounts Payable, ${buyer.name}` };
    } else if (amount != null && amount > rules.autoApproveLimit) {
      outcome = "NEEDS_REVIEW"; reasons.push({ code: "OVER_LIMIT", severity: "policy", text: `${fmt(amount)} is above the auto-approval limit of ${fmt(rules.autoApproveLimit)}` });
      headline = "Everything matches, but the amount is above the auto-approval limit. It needs a manager's sign-off.";
      route = "AP manager: approval";
      next = ["One-click approval: all checks passed"];
    } else if (has("DUP_AMOUNT", "EXTRACTION_CONFLICT").length) {
      outcome = "NEEDS_REVIEW"; add(has("DUP_AMOUNT", "EXTRACTION_CONFLICT"), "warning");
      headline = "Passed every hard check, but one signal needs a quick human look before payment.";
      route = "AP exceptions";
      next = ["Review the flagged signal and approve or reject"];
    } else {
      outcome = "APPROVED";
      const due = f.invoice_date && v ? addDays(f.invoice_date, termsDays(v.payment_terms)) : null;
      headline = `Matches ${poRes.po}${poRes.matchType === "inferred" ? " (inferred)" : ""}, the goods were received, the vendor and bank are verified, and it isn't a duplicate. Scheduled for payment${due ? " on " + due : ""}.`;
      route = `Payment run${due ? " · due " + due : ""} (${v.payment_terms})`;
      add(all.filter((c) => c.status === "warn" && !["SCANNED", "AI_FALLBACK"].includes(c.code)), "note");
      next = [`Post to the GL against ${poRes.po}`, `Pay ${fmt(amount)} to ${v.bank.name} ••${v.bank.account.slice(-4)}${due ? " on " + due : ""}`];
      if (poRes.matchType === "inferred") next.push("PO was inferred, so it's logged for a monthly sample audit");
    }
    return Object.assign({ outcome, label: OUTCOMES[outcome].label, tone: OUTCOMES[outcome].tone, headline, reasons, route, next, message, amount,
      approvable: poRes.approvable, disputed: poRes.disputed }, {});
  }

  /** Normalise the ledger + prior runs into one history list. */
  function buildHistory(ref, runs) {
    const h = ref.ledger.map((l) => Object.assign({ source: "ledger", ref: l.invoice_no }, l));
    (runs || []).forEach((r) => {
      if (!r || !r.summary || !r.summary.vendor_id) return;
      const s = r.summary;
      const status = r.review && r.review.action ? ({ approve: "approved", partial: "approved", reject: "rejected" }[r.review.action] || s.status) : s.status;
      h.push({ source: "run", ref: r.id, invoice_no: s.invoice_no, vendor_id: s.vendor_id, po: s.po, invoice_date: s.invoice_date,
        total: s.total, subtotal: r.review && r.review.action === "partial" ? s.approvable : s.subtotal, status, paid_on: null, file_hash: r.file_hash,
        lines: r.review && r.review.action === "partial" ? (s.lines_ok || []) : (s.lines || []) });
    });
    return h;
  }

  function statusFromOutcome(o) { return { APPROVED: "approved", NEEDS_REVIEW: "in review", RETURNED: "returned", REJECTED: "rejected" }[o]; }

  const SCHEMA = `{
  "vendor_name": string|null,
  "vendor_tax_id": string|null,
  "vendor_emails": string[],
  "invoice_number": string|null,
  "invoice_date": "YYYY-MM-DD"|null,
  "payment_terms": string|null,
  "po_reference": string|null,
  "currency": string|null,
  "line_items": [{"description": string, "quantity": number|null, "unit_price": number|null, "amount": number|null}],
  "subtotal": number|null,
  "tax_amount": number|null,
  "tax_rate_pct": number|null,
  "total": number|null,
  "remit_bank_name": string|null,
  "remit_routing": string|null,
  "remit_account": string|null,
  "unusual_instructions": string[],
  "document_type": "invoice"|"credit_note"|"statement"|"reminder"|"other",
  "field_confidence": {"invoice_number": 0-1, "invoice_date": 0-1, "total": 0-1, "po_reference": 0-1, "remit_account": 0-1}
}`;
  function buildPrompt(buyer, text, isImage) {
    return `You are the document reader in an accounts-payable pipeline. The BUYER is ${buyer.name} (${buyer.address}); never return the buyer's details as vendor details.

Read the vendor invoice ${isImage ? "in the attached scanned image" : "text below (extracted from a PDF; columns are separated by runs of spaces)"} and return ONE JSON object matching this schema:
${SCHEMA}

Rules:
- Copy values exactly as printed. Do not calculate, infer or repair anything. If a field is not printed (for example a blank "Invoice Number:" label), return null.
- invoice_number: exactly as printed, keeping separators such as "/" or "-".
- po_reference: only a number labelled as a purchase order, customer PO or "your reference". null if none is printed. Do not guess it from other numbers.
- Amounts are plain numbers without currency symbols or thousands separators.
- remit_routing / remit_account: digits only, from the payment or remittance section.
- unusual_instructions: quote verbatim any text that asks the payer to change bank details or pay a new account, adds urgency, or says this is a reminder or second notice. [] if none.
- field_confidence: your confidence that each value is read correctly (1 = certain). Lower it for blurry or ambiguous text.
Return only the JSON object, with no prose and no code fences.
${isImage ? "" : "\n--- INVOICE TEXT ---\n" + String(text || "").slice(0, 12000) + "\n--- END ---"}`;
  }

  /** pdf.js text items -> lines, preserving reading order and column gaps. */
  function itemsToText(items) {
    const rows = [];
    items.filter((it) => it.str && it.str.trim()).forEach((it) => {
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x, w: it.width || 0, s: it.str });
    });
    rows.sort((a, b) => b.y - a.y);
    return rows.map((r) => {
      r.parts.sort((a, b) => a.x - b.x);
      let out = "", end = null;
      r.parts.forEach((p) => { if (end != null) out += (p.x - end > 12 ? "   " : " "); out += p.s.trim(); end = p.x + p.w; });
      return out;
    }).join("\n");
  }

  const api = { itemsToText, buildPrompt, DEFAULT_RULES, rulesRead, sanitizeAI, crossCheck, mergeFields, validateInvoice, verifyVendor, checkDuplicates, matchPO, decide,
    buildHistory, statusFromOutcome, normInvNo, normPO, parseDate, dice, tokens, fmt, poTotals, billedOnPO, r2, OUTCOMES };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
