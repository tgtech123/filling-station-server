# Accounting Suite — Integration & Usage Guide

> Last updated: 2026-06. Covers the `/api/accounting` module: chart of accounts,
> journals, AP, AR, bank reconciliation, tax, FX, fixed-asset depreciation,
> per-product sales posting, perpetual inventory costing (AVCO), period close,
> and financial reports. This is separate from the legacy `/api/accountant`
> reporting endpoints documented in `ACCOUNTANT_ENDPOINTS.md`.

---

## 1. Access & roles

- **Base URL:** `/api/accounting`
- **Auth:** `Authorization: Bearer <token>` on every request.
- **Role:** the suite is **accountant-only** for everything that creates or edits
  a document. Two deliberate exceptions:
  - the executive overview `GET /reports/dashboard`, which `manager` and `admin`
    may also read (no document access);
  - the **approver set** described below, which may read and authorise — but
    never originate — journals and payment batches.

  Managers see *only* the overview card in the UI; every working screen is the
  accountant's.

### Who may approve (maker-checker)

Journals above the approval threshold and every supplier payment batch are held
until a **second person** authorises them. The maker can never approve their own
work — that rule is absolute and applies to everyone below.

The problem this solves: the approver set used to be `accountant`, the same role
as the maker. A station with **one** accountant therefore had a checker rule with
no possible checker — large journals sat pending forever and no supplier batch
could ever be released. The control did not merely fail to protect anything, it
deadlocked the books.

Three kinds of person may now approve:

| Approver | When it applies |
|---|---|
| Another **accountant** at the same station | A finance team of two or more — the textbook arrangement |
| The **station owner** | The one-accountant station. They approve only; they still cannot create entries, so maker and checker remain different people |
| A **group accountant** (chain CFO) | Multi-branch chains. An accountant at the head-office station, flagged `isGroupAccountant`, may authorise for any branch beneath it |

Appointing a group accountant is the **owner's** decision alone, made in the staff
editor, and only on an accountant. It grants approval rights across the chain —
never the ability to originate entries inside a branch.

Approvers can also **read** journals and payment batches. An approver who cannot
open the document they are authorising can only rubber-stamp it, which defeats
the purpose of having a checker.
- **Same-origin proxy:** the web app calls its own `/api/accounting/[...path]`
  Next.js route, which forwards to the backend. This avoids the cross-origin
  "Load failed" errors mobile browsers throw on direct API calls.

---

## 2. First-time setup (nothing is seeded)

No accounting data is ever auto-created. A new station starts empty and the
accountant builds it up:

1. **Chart of Accounts** — create your GL accounts. Open "System Codes" to see
   the well-known codes the system posts to automatically and create them with
   those exact codes. Recommended hierarchy:
   - Revenue: `4000` Fuel Sales (parent) → `4010` PMS, `4020` AGO/Diesel,
     `4030` Kerosene; `4100` Lubricant; `4200` Gas; `4900` Other Income.
   - COGS: `5000` Cost of Goods Sold (parent) → `5010` PMS, `5020` AGO,
     `5030` Kerosene, `5100` Lubricant, `5200` Gas.
   - Plus `1000` Cash, `1100` Bank, `1200` AR (control), `1300` Inventory
     (control), `1500`/`1510` Fixed Assets/Accum. Dep., `2100` AP (control),
     `2200`/`2210`/`2220` VAT/WHT/Sales-Tax payable, `3000`/`3900` Owner's
     Capital/Retained Earnings, `6300` Depreciation, `7000`–`8100` FX & disposal
     gains/losses.
2. **Tax codes** — define VAT/Sales-Tax/WHT under Tax Engine (none exist by
   default).
3. **Opening inventory** — if you adopt the system with fuel already in tanks,
   record current stock + cost once (Period Close → Inventory Valuation →
   "Opening / Adjust Stock") so the first cost of sales is accurate, not
   estimated.

Resolution is forgiving: a product posts to its specific account if it exists,
otherwise the generic parent (`4000`/`5000`). If neither exists the error names
the exact account to create.

---

## 3. Per-product revenue & cost of sales

Every product sold is accounted for separately.

- **AR invoices**: each line carries a product; revenue credits that product's
  account (mixed invoices split across `4010`/`4020`/`4100`… automatically).
- **Monthly sales posting** (Period Close → "Post Product Sales"): aggregates
  the month's fuel shifts, lubricant POS and gas POS, then posts one balanced
  journal: `Dr Cash` / `Cr` each product revenue account, **and** the matching
  cost leg `Dr` each product COGS account / `Cr Inventory`. The Income Statement
  then shows gross margin per product with no extra work.

### Perpetual inventory costing (AVCO)
Stock is valued at **weighted-average cost** (the petroleum-industry norm; fuel
commingles in tanks so FIFO layers are meaningless). Purchases blend into the
average; sales consume at the average and become COGS. Idempotent — a delivery
or procurement is costed once, ever. See `docs/perpetual-inventory-costing.md`
for the full design. Oversell (sale exceeds recorded stock) still posts at the
best-known cost and is flagged so it can be corrected with opening stock.

---

## 4. Monthly close workflow (recommended order)

1. **Post Product Sales** for the month (revenue + COGS).
2. **Run Depreciation** (Dr Depreciation Expense / Cr Accumulated Depreciation).
3. **Run FX Revaluation** if you hold foreign-currency accounts.
4. **Reconcile bank** statements (import → auto-match → complete).
5. **Close sub-ledgers** (AP, AR, Inventory) — soft (reopenable review lock) or
   hard (final).
6. **Close the GL** last. Hard-closing December's GL runs the **year-end close**:
   revenue/expense/gain/loss accounts zero into Retained Earnings.

Each month-end run is once-per-period (blocked from double-posting) and audited.

---

## 5. Endpoint reference

`A` = accountant, `A+` = accountant (senior actions), `M` = manager/admin also allowed.

### Chart of Accounts
| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/accounts` | A | List accounts (`?withBalances=true` for balances) |
| POST | `/accounts` | A | Create account |
| PATCH | `/accounts/:id` | A | Update account |
| DELETE | `/accounts/:id` | A+ | Delete (blocked if it has postings/children) |
| GET | `/accounts/export` | A | CSV export |
| POST | `/accounts/import` | A+ | Bulk CSV import |

### Journals
| GET | `/journals` · `/journals/:id` | A | List / detail |
| POST | `/journals` | A | Create (≥₦500k → pending approval) |
| PATCH | `/journals/:id/approve` · `/reject` | A+ | Maker-checker (can't approve own) |
| POST | `/journals/:id/reverse` | A+ | Reverse a posted entry |

### Periods & Budgets
| GET | `/periods` | A | List periods + ledger statuses |
| POST | `/periods/:period/close` | A+ | `{ ledger, mode: soft\|hard }` |
| POST | `/periods/:period/reopen` | A+ | Reopen a soft-closed ledger |
| PUT | `/budgets` · GET `/budgets/:period` | A | Set / get budget |
| GET | `/audit` | A | Audit trail |

### Accounts Payable
| GET | `/ap/invoices` · `/ap/open-pos` | A | Invoices / billable POs |
| POST | `/ap/invoices` | A | Register supplier invoice (3-way match) |
| POST | `/ap/invoices/:id/rematch` · `/book` | A | Re-match / book to Payables |
| POST | `/ap/invoices/:id/void` | A+ | Void |
| GET/POST | `/ap/batches` | A | List / create payment batch |
| PATCH | `/ap/batches/:id/approve` | A+ | Approve (maker-checker) |
| POST | `/ap/batches/:id/execute` | A+ | Execute + post payment |
| GET | `/ap/batches/:id/eft-file` · `/checks` | A | EFT/ACH CSV · check print data |

### Accounts Receivable
| GET/POST | `/ar/customers` · PATCH `/ar/customers/:id` | A | Customers |
| GET | `/ar/customers/:id/open-invoices` | A | Open invoices for cash application |
| GET/POST | `/ar/invoices` | A | List / create (per-product lines, recurring) |
| POST | `/ar/invoices/:id/void` | A+ | Void |
| POST | `/ar/invoices/:id/send` | A | Email the invoice to the customer (`{ reminder?, email? }`) |
| POST | `/ar/recurring/run` | A | Generate due recurring invoices |
| GET/POST | `/ar/credit-notes` | A | Credit notes |
| GET/POST | `/ar/receipts` | A | Receipts + cash application |

### Bank Reconciliation
| GET/POST | `/bank/statements` · GET `/bank/statements/:id` | A | Import (CSV/MT940) / view |
| POST | `/bank/statements/:id/automatch` · `/match` · `/complete` | A | Match / finish |
| GET/POST/DELETE | `/bank/rules` … | A | Auto-match narration rules |

### Tax · FX · Inventory · Fixed Assets · Sales posting
| GET/PUT | `/tax/config` | A / A+ | Tax codes |
| GET | `/tax/calculate` · `/tax/liability` | A | Calc preview · filing report |
| POST | `/tax/mark-filed` | A+ | Mark a period filed |
| GET/POST | `/fx/rates` · POST `/fx/rates/fetch` | A | Rates (manual / daily API) |
| POST | `/fx/revaluation` · GET `/fx/revaluations` | A+ / A | Month-end revaluation |
| GET | `/sales-postings` · `/sales-postings/preview` | A | History · preview (qty/cost/margin) |
| POST | `/sales-postings/run` | A+ | Post month's sales + COGS |
| GET | `/inventory/valuation` · `/inventory/movements` | A | On-hand value · ledger |
| POST | `/inventory/opening` | A+ | Opening / adjustment stock |
| GET | `/assets/:id/schedule` · `/depreciation/runs` | A | Schedule · run history |
| POST | `/assets/:id/dispose` · `/depreciation/run` | A+ | Dispose · monthly run |

### Reports
`/reports/trial-balance`, `/balance-sheet` (`?asOf=`, `?compareTo=`),
`/income-statement` (`?from=&to=`), `/general-ledger` (`?accountId=`),
`/cash-flow`, `/aging`, `/budget-vs-actual` (`?period=`) — all `A`.
`/reports/dashboard` — `A` + `M` (executive overview).

---

## 6. Plan limits & staff gating

Each subscription plan caps staff per role and branch count. Limits are stored
on the station (`staffLimits`) and enforced wherever staff are added or changed:

| Plan | Attendants | Cashiers | Accountants | Supervisors | Managers | Branches |
|------|-----------|----------|-------------|-------------|----------|----------|
| Free | 3 | 1 | 1 | 1 | 1 | 1 |
| Pro | 10 | 3 | 2 | 2 | 2 | 1 |
| Pro Max | ∞ | ∞ | 6 | 6 | 3 | 1 |
| Enterprise | ∞ | ∞ | ∞ | ∞ | ∞ | 3 |
| Enterprise Pro | ∞ | ∞ | ∞ | ∞ | ∞ | 5 |
| Enterprise Max | ∞ | ∞ | ∞ | ∞ | ∞ | ∞ |

- **Manager count includes the station owner.** "Free: 1 Manager" = the owner
  alone; "Pro: 2 Managers" = owner + 1. This is enforced identically in
  `createStaff`, `bulkImportStaff`, role changes (`updateStaff`), and downgrade
  conflict detection — the owner is never the one a downgrade asks you to remove
  (every plan allows ≥1 manager).
- Only the **station owner (super manager)** can create/assign the manager role.
- Branches require an Enterprise plan and are capped by `maxBranches`.

### How staff removal during a downgrade works
The downgrade wizard (System Settings → pick a lower plan) calls
`GET /api/payments/downgrade/check?targetPlan=<slug>`. If you have more staff in
a role than the target plan allows, it returns `conflicts[]`
(`{ role, current, allowed, excess }`) and the wizard shows a **"Cannot
downgrade yet"** screen listing each over-limit role with a **"Remove N" badge**.

> The "Remove N" badge is **guidance, not a button.** To actually remove staff,
> go to **Staff Management**, terminate/remove the excess staff in that role,
> then return to the wizard and re-run the check. Once `conflicts` is empty the
> wizard proceeds to schedule the downgrade. Existing over-limit staff are
> *grandfathered* if a downgrade is applied — they keep working, but you cannot
> add more in that role until you are under the new limit.

The downgrade is **scheduled**, not immediate: it takes effect at the end of the
current paid period (`POST /api/payments/downgrade/schedule`), and can be
cancelled before then (`POST /api/payments/downgrade/cancel`).

---

## 7. Controls & guarantees

- **Double-entry**: every journal must balance (debits = credits).
- **Control accounts** (AP/AR/Inventory): no manual journal lines — only system
  documents post to them, so sub-ledgers never drift from the GL.
- **Maker-checker**: large journals and all payment batches need a second
  person; you cannot approve your own. The checker may be another accountant,
  the station owner, or the chain's group accountant — see Section 1, "Who may
  approve". The set is deliberately wider than `accountant` so a station with a
  single accountant is not deadlocked.
- **Invoices are sent deliberately, never automatically**: creating an AR
  invoice does not email it. An accountant raises the invoice, checks it against
  the delivery note, then presses **Send**. Sending records who it went to and
  when, moves a `draft` to `sent`, and can be repeated to chase payment
  (**Remind**), which rewords the email as a reminder. Unlike most background
  email, a failure here is reported to the accountant rather than swallowed —
  showing "Sent" over an email that never left would stop them chasing.
- **Immutability**: posted entries are corrected by reversal, never edited.
- **Period locks**: soft (reopenable) and hard (final) close; closed periods
  reject new postings.
- **Idempotency**: monthly runs (sales, depreciation, FX, inventory receipts)
  are once-per-period and safe to retry.
- **Audit trail**: every account, journal, period, tax, asset and inventory
  action is logged with the user and a summary.

---

## 8. Verification scripts (read-only)

- `scripts/smoke-accounting.js` — every endpoint responds; role gates hold.
- `scripts/test-avco.js` — proves the weighted-average costing math.
- `scripts/check-gas-procurement.js` — gas procurement → costing consistency.
- `scripts/check-plan-gating.js` — staff-limit counting consistency.
