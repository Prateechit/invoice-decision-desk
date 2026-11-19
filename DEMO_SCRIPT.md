# Invoice Decision Desk: 5-minute demo script (PS-1)

**Before you hit record:** open the app → Dashboard → *Reset demo history* (click twice). Go to *Live run*. Check that the top-right chip says **AI reader: Claude (text + vision)**. The first Claude call asks for consent, so do one throwaway run before recording, then reset again.

| Time | On screen | What to say |
|---|---|---|
| 0:00–0:30 | *How it works* tab, the 8-stage flow | "AP clerks open a PDF, find the PO, check the numbers, and decide. I split that work: **AI reads, rules decide.** Claude handles the part that needs eyes, which is messy layouts and scans. Every money decision is a plain rule you can audit and tune." |
| 0:30–1:15 | Run **Happy path · Brightline** | Narrate the stages as they light up: fingerprint → text layer → Claude extracts to a strict schema **while a regex parser reads the same text independently**, so the two readers cross-check the money fields (point at the cross-check table). Then validation, vendor and bank against the master, duplicates, and a line-level 3-way match. "Approved, scheduled on Net 30 to the account on file. No human touched it." |
| 1:15–2:05 | Run **Edge 1 · Meridian split PO** | "Second invoice on a PO. On its own it looks fine. It only fails once you count what invoice MPP-7781 already billed and what the dock actually received: 120 shafts, not 200, and $33.50 instead of $32." Scroll to the PO match table. "It doesn't just say no. It works out the **$7,590 it can safely pay**, drafts the credit-note request for $2,860, and the reviewer approves the matched part in one click." Click it. |
| 2:05–2:40 | Run **Edge 2 · Kestrel duplicate** | "A '2nd notice' numbered KL/2026/917. We paid KL-2026-0917 in October. An exact-match check misses this. Normalising the number, plus the same amount and PO, catches it. Rejected, with the payment date in the reply to the vendor." |
| 2:40–3:25 | Run **Edge 3 · Orchid scan** | "No text layer, so it switches to Claude vision (watch the stream). No PO is printed either, so it scores each of Orchid's open POs on line text, amount fit and price fit. PO-4500152 wins by 77 points, so it auto-approves and flags it as inferred for audit. **Not every anomaly should create human work.**" |
| 3:25–4:20 | Run **Edge 4 · Brightline bank change** | "This is the expensive one. Right PO, right quantities, right prices. Every 3-way match passes. But the remit-to account isn't the one on file, the email comes from **brightline-supply.co**, and the invoice tells us to update our records. That's business email compromise. Fraud beats every other signal: payment is held and Treasury gets a note to **call the number in the vendor master, never the one on the invoice**." |
| 4:20–4:45 | *Dashboard* | Straight-through rate, value stopped before payment, the review queue with reasons, and the reasons chart. "This is how an AP lead sees where the work and the risk sit." |
| 4:45–5:00 | *Rules* tab | "Tolerances are policy, not code. Finance tunes them here, and every run records the rules it was decided under." |

## Live interview: extra runs to have ready
- **Bonus · incomplete Kestrel**: returned to vendor with a drafted email listing exactly what's missing.
- **Re-run the happy path**: caught as an exact-file duplicate (SHA-256), which shows run history feeds back into the checks.
- **Upload `04_…OOC-55210.jpg`** through the drop zone: the image path goes straight to vision.
- **Rules tab**: set price tolerance to 5%, reset history (otherwise the re-run is caught as a duplicate file), and re-run Meridian. The price exception disappears, but the quantity-over-receipt exception remains. This shows the rules are independent.
- **AI off**: if Claude is unavailable, text PDFs still run through the rules parser, and the scan routes to *manual keying* rather than guessing.

## Likely questions, short answers
- **Why not let the LLM decide?** Auditability and determinism. The model's job is the one thing rules can't do, which is reading varied documents. Its output is constrained to a schema, cross-checked by an independent parser, and verified by arithmetic.
- **Hallucinated fields?** The prompt forbids inference ("blank label → null"). The rules parser disagrees loudly, and line maths must reconcile to the total.
- **Precedence?** Duplicate > fraud > defective invoice > PO exception > amount limit > approve. Fraud outranks "return to vendor" so we never email a possible fraudster.
- **Production next?** AP mailbox intake, ERP write-back, credit-note matching to auto-close disputes, per-vendor tolerance learning.
