# Invoice Decision Desk (PS-1, invoice processing)

An invoice (PDF, scanned PDF or image) goes in. A reasoned AP decision comes out: **Approved**, **Needs review**, **Returned to vendor** or **Rejected**. Every stage is visible as it runs, and a dashboard shows history across runs.

**Design principle: AI reads, rules decide.** An LLM (Claude or Gemini) reads the invoice into a strict schema. A separate regex parser reads the same text independently to cross-check the money fields. Every decision is a deterministic rule, tunable on the Rules tab.

---

## Option A: get a public link with Vercel (free, about 10 minutes)

You need: a GitHub account, a Vercel account (sign in with GitHub), and **one** AI key:
- **Anthropic (Claude)**: console.anthropic.com → API keys (needs a few dollars of credit), **or**
- **Google Gemini**: aistudio.google.com → Get API key (has a free tier).

1. **Put the code on GitHub.** On github.com click **New repository**, name it `invoice-decision-desk`, set it to Public, and click Create. On the empty repo page click **"uploading an existing file"**. Open this folder and drag in **everything inside it** (not the folder itself): `index.html`, `desk.js`, `engine.js`, `reference.json`, `package.json`, `run-local.js`, `README.md`, `DEMO_SCRIPT.md` and the `api`, `lib` and `samples` folders. Then click **Commit changes**. On the repository's main page, `index.html` must be visible straight away, not inside another folder.
   - Don't upload a `.env` file. Your key goes into Vercel instead (step 3).
2. **Import into Vercel.** On vercel.com click **Add New… → Project**, pick the repo and click **Import**. Leave Framework Preset as **Other** and leave every build setting empty.
3. **Add your key.** Before deploying, open **Environment Variables** and add one of these:
   - Name `ANTHROPIC_API_KEY`, value = your Claude key, **or**
   - Name `GEMINI_API_KEY`, value = your Gemini key.
4. Click **Deploy**. After about a minute you get a link like `https://invoice-decision-desk.vercel.app`. **This is the link you submit.**
5. Open it. The top-right chip should say **AI reader: Claude (text + vision)** or **Gemini**. If it says "off", the key wasn't saved: go to Project → Settings → Environment Variables, fix it, then Deployments → ⋯ → **Redeploy**.

To change the model, add `ANTHROPIC_MODEL` or `GEMINI_MODEL` as another environment variable. The defaults are `claude-sonnet-5-5` and `gemini-flash-latest`.

## Option B: run it on your laptop (backup for the live interview)

Needs Node.js 18 or newer (nodejs.org). There's nothing to install beyond that.

```bash
cd invoice-decision-desk
cp .env.example .env        # then open .env and paste your key after ANTHROPIC_API_KEY=  (or use GEMINI_API_KEY)
node run-local.js
```
Open http://localhost:3000.

## How to test it

1. Check the top-right chip says the AI reader is on.
2. In **Sample inbox**, click **Run** on each sample in order, or **Run all 6**. Expected results:

| Sample | Expected | Why |
|---|---|---|
| Happy path · Brightline BL-24871 | Approved | PO, receipt, vendor and bank all match |
| Edge 1 · Meridian MPP-7802 | Needs review, pay $7,590 / query $2,860 | Bills 200 shafts but only 120 were received, price +4.69% over PO, PO value exceeded |
| Edge 2 · Kestrel KL/2026/917 | Rejected | Same as KL-2026-0917, paid 2026-10-15 |
| Edge 3 · Orchid scan | Approved (PO inferred) | No text layer, so AI vision reads it. No PO printed, so it's matched to PO-4500152 by line text, amount and price |
| Edge 4 · Brightline BL-24903 | Needs review (fraud) | Bank account not on file, look-alike domain `brightline-supply.co` |
| Bonus · Kestrel, no number | Returned to vendor | Missing invoice number and date |

3. Upload your own file through the drop zone. `samples/04_…OOC-55210.jpg` tests the image path; reset history first or it's caught as a duplicate.
4. Before recording: **Dashboard → Reset demo history** (click twice).

Run history is stored in the browser you're using (localStorage), so each interviewer's browser starts with its own history.

## Files

| File | What it does |
|---|---|
| `index.html`, `desk.js` | UI: live run view, dashboard, reference data, rules, process map |
| `engine.js` | Decision engine: rules reader, validation, vendor/bank checks, duplicate detection, PO + receipt matching, decision |
| `reference.json` | Vendor master, POs with goods-receipt quantities, AP ledger |
| `api/extract.js`, `api/health.js`, `lib/ai.js` | Server-side AI reader. The key stays on the server, and the server builds the prompt itself, so the endpoint can only read invoices. Rate-limited per IP |
| `run-local.js` | Local server for Option B |
| `samples/` | The test invoices |

If no AI key is set, text PDFs still run through the rules parser, and scans are routed to manual keying instead of being guessed.
