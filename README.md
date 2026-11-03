# Milkcrate comp prototype

Milkcrate runs a customer's sales comp end to end: it designs the plan, calculates every payout, answers rep questions, and hands the customer an approved payroll file each month. The customer's only job is to enter that file into payroll.

This prototype is meant for testing with lighthouse customers. It ships with three fictional customers. The main one, Northwind Analytics, has 14 AEs and 2 managers, 12 months of deals, and an October close waiting in review with real-looking data problems.

## What's in it

| View | Who | What it does |
|---|---|---|
| `/ops` | Milkcrate comp specialist | Operator console across customers: close status, SLA, open exceptions, rep questions, monthly fee |
| `/ops/[slug]` | Specialist | Monthly close: lock and calculate, resolve exceptions (reassign, exclude, accept), sign off, payouts by rep, statements, adjustments, audit trail |
| `/ops/[slug]/plan` | Specialist | Active plan as code, version history, and 3 plan templates modeled against the customer's last 12 months of deals |
| `/ops/[slug]/data` | Specialist | Roster, recent deals, CSV deal import |
| `/ops/[slug]/questions` | Specialist | Review queue for Plan Explainer drafts and escalations; auto-send toggle |
| `/leader` | Customer approver or sales manager | Team attainment and pace, live payout against budget, one-click close approval, payroll file download, SPIFF requests and approvals |
| `/rep` | Rep | Attainment, current rate, deals credited this month with what each pays, exact what-if calculator, Q&A, statements |
| `/statements/[period]/[payee]` | Rep, leader, specialist | Printable statement with a line for every deal, rate and adjustment |

## How it's built

- **Plan as code.** `lib/engine/plan.ts` defines one typed plan format (Zod). Every customer's plan is a config in that format, never custom code.
- **Deterministic engine.** `lib/engine/calc.ts` is pure TypeScript with no I/O and no AI. It covers quarterly quotas, tiered accelerators, caps, multi-year kickers, new-hire ramps, manager overrides, adjustments, and true-ups for backdated deals. It also runs data checks: unknown owners, duplicates, deals after termination, large deals, payout spikes. Tests are in `tests/engine.test.ts`.
- **One ledger.** Each close stores payout lines with a trace (deal, tier segments, rate, plan version). Statements, the portal, the payroll file and the Plan Explainer all read from those lines.
- **Plan Explainer.** `lib/explainer.ts` sorts each question (explain, what-if, missing credit, policy). The engine computes any what-if number, and the LLM only writes the reply from those facts. Without `ANTHROPIC_API_KEY`, a rules-based fallback writes the answer instead.
- **Human sign-off.** A specialist signs off every close, and the customer's named approver approves it before the payroll file can be downloaded. Payout adjustments also need the approver.

Stack: Next.js 16 (App Router, server actions), Prisma 7 + Postgres, Tailwind, Anthropic SDK.

## Run it locally

```bash
npm install
cp .env.example .env          # set DATABASE_URL and SESSION_SECRET; ANTHROPIC_API_KEY is optional
npx prisma migrate deploy
npx prisma db seed            # resets and loads the fictional customers
npm run dev                   # http://localhost:3000
npm test                      # engine tests
```

`DEMO_TODAY` pins "today" to the seeded data (2026-11-03). To make the sign-in page require a shared code, set `DEMO_ACCESS_CODE`.

## Demo script (10 minutes)

1. **Specialist** → `/ops`: three customers, the October close status for each, and the SLA.
2. Open Northwind's close. It has five exceptions:
   - Reassign the Keystone deal owned by "Jordan Lee" to a rep.
   - Exclude the duplicate.
   - Exclude the deal booked after Ryan's termination.
   - Accept the large deal and the payout spike.
   - Sign off the close.
3. **Dana (CFO, approver)** → `/leader`: approve October and download the Gusto file.
4. **Ava (rep)** → `/rep`: run a what-if for $40K, ask "Why was my October check higher than September?", and open her statement.
5. **Specialist** → Rep questions: approve the drafted answer. Ava now sees it.
6. **Specialist** → Plan: compare the three templates on Northwind's history (cost of sales, how many reps reach target pay).

## Not built yet

- Real auth (the sign-in page is a demo user picker)
- Live Salesforce and HubSpot sync (use CSV import for now)
- Slack app for rep questions
- E-sign for plan documents
- ASC 340-40 schedules
- Multi-segment plans

## Deploy

The app runs on Vercel with a Postgres database such as Neon. Set `DATABASE_URL`, `SESSION_SECRET`, `DEMO_ACCESS_CODE`, `DEMO_TODAY` and optionally `ANTHROPIC_API_KEY`. Then run `npx prisma migrate deploy && npx prisma db seed` once against that database.
