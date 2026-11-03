import { describe, expect, it } from "vitest";
import { PLAN_TEMPLATES, backtest, calculate, planSchema, quarterQuota, whatIf, type DealInput, type PayeeInput } from "@/lib/engine";

const plan = PLAN_TEMPLATES.standard.config;
const rep = (over: Partial<PayeeInput> = {}): PayeeInput => ({
  id: "r1", name: "Ava Rep", role: "REP", managerId: "m1", startDate: "2025-01-01", endDate: null,
  targetVariableAnnual: 100_000, quarterlyQuota: 300_000, ...over,
});
const mgr: PayeeInput = { id: "m1", name: "Max Manager", role: "MANAGER", managerId: null, startDate: "2025-01-01", endDate: null, targetVariableAnnual: 60_000, quarterlyQuota: 0 };
let n = 0;
const deal = (over: Partial<DealInput>): DealInput => ({
  id: `d${++n}`, externalId: `OPP-${n}`, name: `Deal ${n}`, account: `Acct ${n}`, ownerId: "r1", amount: 10_000, closeDate: "2026-01-15", termMonths: 12, ...over,
});
const sumType = (lines: { type: string; amount: number }[], t: string) => lines.filter((l) => l.type === t).reduce((s, l) => s + l.amount, 0);

describe("calculate", () => {
  it("pays base rate below quota and splits a deal across accelerator tiers", () => {
    const deals = [deal({ amount: 200_000, closeDate: "2026-01-10" }), deal({ amount: 150_000, closeDate: "2026-02-10" })];
    const jan = calculate({ plan, month: "2026-01", payees: [rep()], deals, adjustments: [] });
    expect(jan.totals.payout).toBeCloseTo(16_666.67, 2);
    const feb = calculate({ plan, month: "2026-02", payees: [rep()], deals, adjustments: [], previouslyPaidQtd: { r1: 16_666.67 } });
    // 100k at 1x up to quota (300k), 50k at 1.5x
    expect(feb.totals.payout).toBeCloseTo(8_333.33 + 6_250, 1);
    expect(feb.lines.some((l) => l.type === "TRUE_UP")).toBe(false);
    expect(feb.summaries[0].attainment).toBeCloseTo(350 / 300, 5);
    expect(feb.summaries[0].currentMultiplier).toBe(1.5);
  });

  it("resets tiers each quarter", () => {
    const deals = [deal({ amount: 400_000, closeDate: "2026-03-10" }), deal({ amount: 30_000, closeDate: "2026-04-02" })];
    const apr = calculate({ plan, month: "2026-04", payees: [rep()], deals, adjustments: [] });
    expect(apr.totals.payout).toBeCloseTo(2_500, 2);
  });

  it("adds the multi-year kicker", () => {
    const r = calculate({ plan, month: "2026-01", payees: [rep()], deals: [deal({ amount: 60_000, termMonths: 36 })], adjustments: [] });
    expect(sumType(r.lines, "COMMISSION")).toBeCloseTo(5_000, 2);
    expect(sumType(r.lines, "KICKER")).toBeCloseTo(500, 2);
  });

  it("ramps quota for new hires by month of tenure", () => {
    expect(quarterQuota(plan, rep({ startDate: "2026-02-10" }), "2026-01")).toBeCloseTo(100_000 * (0.33 + 0.66), 2);
    expect(quarterQuota(plan, rep({ startDate: "2025-06-01" }), "2026-01")).toBe(300_000);
  });

  it("trues up deals backdated into an already-paid month", () => {
    const deals = [deal({ amount: 60_000, closeDate: "2026-01-20" }), deal({ amount: 30_000, closeDate: "2026-02-05" })];
    const r = calculate({ plan, month: "2026-02", payees: [rep()], deals, adjustments: [], previouslyPaidQtd: { r1: 0 } });
    expect(sumType(r.lines, "TRUE_UP")).toBeCloseTo(5_000, 2);
    expect(sumType(r.lines, "COMMISSION")).toBeCloseTo(2_500, 2);
  });

  it("stops paying above the cap", () => {
    const capped = PLAN_TEMPLATES.capped.config;
    const r = calculate({ plan: capped, month: "2026-01", payees: [rep()], deals: [deal({ amount: 900_000 })], adjustments: [] });
    // 300k at 1x + 300k at 1.25x, nothing above 200%
    expect(r.totals.payout).toBeCloseTo(25_000 + 31_250, 1);
  });

  it("pays managers an override on team bookings", () => {
    const payees = [rep(), rep({ id: "r2", name: "Ben Rep" }), mgr];
    const deals = [deal({ amount: 120_000 }), deal({ amount: 60_000, ownerId: "r2" })];
    const r = calculate({ plan, month: "2026-01", payees, deals, adjustments: [] });
    // rate = 15k / 600k = 0.025
    expect(sumType(r.lines.filter((l) => l.payeeId === "m1"), "OVERRIDE")).toBeCloseTo(4_500, 2);
  });

  it("applies adjustments in their month", () => {
    const r = calculate({ plan, month: "2026-01", payees: [rep()], deals: [], adjustments: [{ id: "a1", payeeId: "r1", month: "2026-01", amount: 1_000, type: "SPIFF", reason: "Q1 multi-product SPIFF" }] });
    expect(r.totals.byType.ADJUSTMENT).toBe(1_000);
  });

  it("flags data problems and does not credit invalid deals", () => {
    const payees = [rep({ endDate: "2026-01-10" })];
    const deals = [
      deal({ amount: 10_000, closeDate: "2026-01-05", account: "Acme" }),
      deal({ amount: 10_000, closeDate: "2026-01-05", account: "acme" }),
      deal({ amount: 20_000, closeDate: "2026-01-20" }),
      deal({ amount: 15_000, ownerId: null, ownerLabel: "Jordan Lee" }),
    ];
    const r = calculate({ plan, month: "2026-01", payees, deals, adjustments: [] });
    const kinds = r.exceptions.map((e) => e.kind);
    expect(kinds).toContain("DUPLICATE");
    expect(kinds).toContain("AFTER_TERMINATION");
    expect(kinds).toContain("UNKNOWN_OWNER");
    expect(r.lines.filter((l) => l.type === "COMMISSION")).toHaveLength(2);
  });

  it("skips excluded deals", () => {
    const r = calculate({ plan, month: "2026-01", payees: [rep()], deals: [deal({ amount: 30_000, excluded: true })], adjustments: [] });
    expect(r.totals.payout).toBe(0);
  });
});

describe("whatIf", () => {
  it("returns the exact extra payout for a hypothetical deal, including accelerators", () => {
    const input = { plan, month: "2026-01", payees: [rep()], deals: [deal({ amount: 280_000 })], adjustments: [] };
    const w = whatIf(input, "r1", 40_000);
    // 20k at 1x + 20k at 1.5x
    expect(w.extraPayout).toBeCloseTo(1_666.67 + 2_500, 1);
    expect(w.attainmentAfter).toBeCloseTo(320 / 300, 5);
  });
});

describe("backtest", () => {
  it("pays each deal once across a quarter", () => {
    const deals = [deal({ amount: 200_000, closeDate: "2026-01-10" }), deal({ amount: 150_000, closeDate: "2026-02-10" }), deal({ amount: 100_000, closeDate: "2026-03-10" })];
    const months = ["2026-01", "2026-02", "2026-03"];
    const b = backtest(plan, months, [rep()], deals);
    const direct = calculate({ plan, month: "2026-03", payees: [rep()], deals, adjustments: [] }).summaries[0].earnedQtd;
    expect(b.totalPayout).toBeCloseTo(direct, 1);
    expect(b.costOfSales).toBeCloseTo(direct / 450_000, 5);
  });
});

describe("planSchema", () => {
  it("accepts the templates and rejects bad tiers", () => {
    for (const t of Object.values(PLAN_TEMPLATES)) expect(planSchema.safeParse(t.config).success).toBe(true);
    const bad = { ...plan, tiers: [{ upTo: 1.2, multiplier: 1 }, { upTo: 1, multiplier: 2 }] };
    expect(planSchema.safeParse(bad).success).toBe(false);
  });
});
