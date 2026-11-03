import { PlanConfig } from "./plan";
import { Month, lastDayOf, monthOf, monthsBetween, quarterOf } from "./dates";

export type PayeeInput = {
  id: string;
  name: string;
  role: "REP" | "MANAGER";
  managerId: string | null;
  startDate: string;
  endDate: string | null;
  targetVariableAnnual: number;
  quarterlyQuota: number;
};

export type DealInput = {
  id: string;
  externalId: string;
  name: string;
  account: string;
  ownerId: string | null;
  ownerLabel?: string | null;
  amount: number;
  closeDate: string;
  termMonths: number | null;
  excluded?: boolean;
};

export type AdjustmentInput = {
  id: string;
  payeeId: string;
  month: Month;
  amount: number;
  type: string;
  reason: string;
};

export type LineType = "COMMISSION" | "KICKER" | "OVERRIDE" | "TRUE_UP" | "ADJUSTMENT";

export type Segment = { portion: number; multiplier: number; rate: number; amount: number; fromAttainment: number; toAttainment: number };

export type PayoutLine = {
  payeeId: string;
  type: LineType;
  dealId: string | null;
  amount: number;
  description: string;
  trace: Record<string, unknown>;
};

export type ExceptionKind =
  | "UNKNOWN_OWNER"
  | "DUPLICATE"
  | "AFTER_TERMINATION"
  | "BEFORE_START"
  | "LARGE_DEAL"
  | "NON_POSITIVE_AMOUNT"
  | "PAYOUT_SPIKE"
  | "MISSING_TERM";

export type CalcException = {
  kind: ExceptionKind;
  severity: "high" | "medium" | "low";
  message: string;
  dealId: string | null;
  payeeId: string | null;
};

export type PayeeSummary = {
  payeeId: string;
  quarter: string;
  quota: number;
  bookingsQtd: number;
  attainment: number;
  rate: number;
  currentMultiplier: number;
  earnedQtd: number;
  monthTotal: number;
};

export type CalcInput = {
  plan: PlanConfig;
  month: Month;
  payees: PayeeInput[];
  deals: DealInput[];
  adjustments: AdjustmentInput[];
  /** Commission, kicker, override and true-up already paid in earlier closes of this quarter, by payee. */
  previouslyPaidQtd?: Record<string, number>;
};

export type CalcResult = {
  month: Month;
  quarter: string;
  lines: PayoutLine[];
  summaries: PayeeSummary[];
  exceptions: CalcException[];
  totals: { payout: number; byType: Record<LineType, number> };
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const usd = (n: number) => `$${round2(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

function employedInMonth(p: PayeeInput, m: Month): boolean {
  if (monthOf(p.startDate) > m) return false;
  if (p.endDate && monthOf(p.endDate) < m) return false;
  return true;
}

export function rampFactor(plan: PlanConfig, p: PayeeInput, m: Month): number {
  if (!employedInMonth(p, m)) return 0;
  const idx = monthsBetween(monthOf(p.startDate), m);
  return plan.ramp[idx] ?? 1;
}

export function quarterQuota(plan: PlanConfig, p: PayeeInput, month: Month): number {
  const { months } = quarterOf(month);
  return months.reduce((s, m) => s + (p.quarterlyQuota / 3) * rampFactor(plan, p, m), 0);
}

export function baseRate(p: PayeeInput): number {
  return p.quarterlyQuota > 0 ? p.targetVariableAnnual / 4 / p.quarterlyQuota : 0;
}

function creditable(d: DealInput, p: PayeeInput): boolean {
  if (d.excluded || d.amount <= 0) return false;
  if (d.closeDate < p.startDate) return false;
  if (p.endDate && d.closeDate > p.endDate) return false;
  return true;
}

function sortDeals(deals: DealInput[]): DealInput[] {
  return [...deals].sort((a, b) => (a.closeDate === b.closeDate ? a.externalId.localeCompare(b.externalId) : a.closeDate.localeCompare(b.closeDate)));
}

/** Splits a deal across attainment tiers, given bookings already credited this quarter. */
export function allocate(plan: PlanConfig, quota: number, rate: number, cumBefore: number, amount: number): Segment[] {
  const segments: Segment[] = [];
  if (quota <= 0) {
    return [{ portion: amount, multiplier: plan.tiers[0].multiplier, rate, amount: amount * rate * plan.tiers[0].multiplier, fromAttainment: 0, toAttainment: 0 }];
  }
  const capDollars = plan.capAttainment === null ? Infinity : plan.capAttainment * quota;
  let cursor = cumBefore;
  let remaining = amount;
  let tierFrom = 0;
  for (const tier of plan.tiers) {
    const tierTo = tier.upTo === null ? Infinity : tier.upTo * quota;
    if (remaining <= 0) break;
    if (cursor < tierTo) {
      const end = Math.min(tierTo, cursor + remaining);
      const portion = end - cursor;
      const paidPortion = Math.max(0, Math.min(end, capDollars) - Math.min(cursor, capDollars));
      segments.push({
        portion,
        multiplier: tier.multiplier,
        rate,
        amount: paidPortion * rate * tier.multiplier,
        fromAttainment: cursor / quota,
        toAttainment: end / quota,
      });
      remaining -= portion;
      cursor = end;
    }
    tierFrom = tierTo;
  }
  void tierFrom;
  return segments;
}

function multiplierAt(plan: PlanConfig, attainment: number): number {
  for (const t of plan.tiers) if (t.upTo === null || attainment < t.upTo) return t.multiplier;
  return plan.tiers[plan.tiers.length - 1].multiplier;
}

function describeSegments(segs: Segment[]): string {
  return segs
    .map((s) => `${usd(s.portion)} at ${s.multiplier}x (${pct(s.fromAttainment)} to ${pct(s.toAttainment)} of quota)`)
    .join(", ");
}

type Walk = { lines: PayoutLine[]; cum: number };

function walkDeals(
  plan: PlanConfig,
  payeeId: string,
  type: "COMMISSION" | "OVERRIDE",
  deals: DealInput[],
  quota: number,
  rate: number,
  repNames: Record<string, string>,
): Walk {
  let cum = 0;
  const lines: PayoutLine[] = [];
  for (const d of sortDeals(deals)) {
    const segs = allocate(plan, quota, rate, cum, d.amount);
    cum += d.amount;
    const amount = round2(segs.reduce((s, x) => s + x.amount, 0));
    const who = type === "OVERRIDE" ? ` (${repNames[d.ownerId ?? ""] ?? "rep"})` : "";
    lines.push({
      payeeId,
      type,
      dealId: d.id,
      amount,
      description: `${d.name}${who}: ${describeSegments(segs)}`,
      trace: { dealExternalId: d.externalId, dealAmount: d.amount, closeDate: d.closeDate, rate, quota, segments: segs },
    });
    if (type === "COMMISSION") {
      for (const k of plan.kickers) {
        if ((d.termMonths ?? 12) >= k.minTermMonths) {
          lines.push({
            payeeId,
            type: "KICKER",
            dealId: d.id,
            amount: round2(amount * k.bonusPct),
            description: `${k.label} on ${d.name}: ${Math.round(k.bonusPct * 100)}% of ${usd(amount)} (${d.termMonths}-month term)`,
            trace: { kicker: k.id, base: amount, bonusPct: k.bonusPct, termMonths: d.termMonths },
          });
        }
      }
    }
  }
  return { lines, cum };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function findDataExceptions(plan: PlanConfig, month: Month, payees: PayeeInput[], deals: DealInput[]): CalcException[] {
  const out: CalcException[] = [];
  const byId = new Map(payees.map((p) => [p.id, p]));
  const med = median(deals.filter((d) => d.amount > 0).map((d) => d.amount));
  const monthDeals = deals.filter((d) => monthOf(d.closeDate) === month && !d.excluded);
  const seenExt = new Map<string, DealInput>();
  const seenKey = new Map<string, DealInput>();
  for (const d of sortDeals(monthDeals)) {
    const owner = d.ownerId ? byId.get(d.ownerId) : undefined;
    if (!owner) {
      out.push({ kind: "UNKNOWN_OWNER", severity: "high", dealId: d.id, payeeId: null, message: `${d.name} (${usd(d.amount)}) is owned by "${d.ownerLabel ?? "unknown"}", who isn't on the roster. Not credited until reassigned.` });
    } else {
      if (owner.endDate && d.closeDate > owner.endDate) {
        out.push({ kind: "AFTER_TERMINATION", severity: "high", dealId: d.id, payeeId: owner.id, message: `${d.name} closed ${d.closeDate}, after ${owner.name}'s last day (${owner.endDate}). Not credited; reassign or confirm.` });
      }
      if (d.closeDate < owner.startDate) {
        out.push({ kind: "BEFORE_START", severity: "medium", dealId: d.id, payeeId: owner.id, message: `${d.name} closed before ${owner.name}'s start date (${owner.startDate}).` });
      }
    }
    if (d.amount <= 0) {
      out.push({ kind: "NON_POSITIVE_AMOUNT", severity: "high", dealId: d.id, payeeId: d.ownerId, message: `${d.name} has a non-positive amount (${usd(d.amount)}).` });
    }
    const key = `${d.account.toLowerCase()}|${d.amount}|${d.closeDate}`;
    const dup = seenExt.get(d.externalId) ?? seenKey.get(key);
    if (dup) {
      out.push({ kind: "DUPLICATE", severity: "medium", dealId: d.id, payeeId: d.ownerId, message: `${d.name} looks like a duplicate of ${dup.name} (${dup.externalId}): same account, amount and close date.` });
    }
    seenExt.set(d.externalId, d);
    seenKey.set(key, d);
    if (med > 0 && d.amount > plan.checks.largeDealMultiple * med) {
      out.push({ kind: "LARGE_DEAL", severity: "low", dealId: d.id, payeeId: d.ownerId, message: `${d.name} is ${usd(d.amount)}, more than ${plan.checks.largeDealMultiple}x the median deal (${usd(med)}). Confirm the amount.` });
    }
    if (!d.termMonths) {
      out.push({ kind: "MISSING_TERM", severity: "low", dealId: d.id, payeeId: d.ownerId, message: `${d.name} has no contract term; assumed 12 months.` });
    }
  }
  return out;
}

export function calculate(input: CalcInput): CalcResult {
  const { plan, month, payees, adjustments } = input;
  const q = quarterOf(month);
  const monthEnd = lastDayOf(month);
  const deals = input.deals.filter((d) => !d.excluded);
  const qDeals = deals.filter((d) => q.months.includes(monthOf(d.closeDate)) && d.closeDate <= monthEnd);
  const repNames = Object.fromEntries(payees.map((p) => [p.id, p.name]));
  const lines: PayoutLine[] = [];
  const summaries: PayeeSummary[] = [];

  for (const p of payees) {
    if (!employedInMonth(p, month)) continue;
    let walk: Walk;
    let quota: number;
    let rate: number;
    if (p.role === "REP") {
      quota = quarterQuota(plan, p, month);
      rate = baseRate(p);
      const mine = qDeals.filter((d) => d.ownerId === p.id && creditable(d, p));
      walk = walkDeals(plan, p.id, "COMMISSION", mine, quota, rate, repNames);
    } else {
      if (!plan.managerOverride.enabled) continue;
      const team = payees.filter((r) => r.managerId === p.id && r.role === "REP");
      quota = team.reduce((s, r) => s + quarterQuota(plan, r, month), 0);
      const fullQuota = team.filter((r) => q.months.some((m) => employedInMonth(r, m))).reduce((s, r) => s + r.quarterlyQuota, 0);
      rate = fullQuota > 0 ? p.targetVariableAnnual / 4 / fullQuota : 0;
      const teamDeals = qDeals.filter((d) => team.some((r) => r.id === d.ownerId && creditable(d, r)));
      walk = walkDeals(plan, p.id, "OVERRIDE", teamDeals, quota, rate, repNames);
    }

    const earnedQtd = round2(walk.lines.reduce((s, l) => s + l.amount, 0));
    const thisMonth = walk.lines.filter((l) => {
      const d = l.dealId ? qDeals.find((x) => x.id === l.dealId) : undefined;
      return d ? monthOf(d.closeDate) === month : false;
    });
    const earnedBefore = round2(earnedQtd - thisMonth.reduce((s, l) => s + l.amount, 0));
    const paidBefore = round2(input.previouslyPaidQtd?.[p.id] ?? earnedBefore);
    const trueUp = round2(earnedBefore - paidBefore);
    lines.push(...thisMonth);
    if (Math.abs(trueUp) >= 0.01) {
      lines.push({
        payeeId: p.id,
        type: "TRUE_UP",
        dealId: null,
        amount: trueUp,
        description: `Prior-month true-up for ${q.label}: earned ${usd(earnedBefore)} on deals from earlier months, paid ${usd(paidBefore)} in earlier closes`,
        trace: { earnedBefore, paidBefore },
      });
    }
    for (const a of adjustments.filter((x) => x.payeeId === p.id && x.month === month)) {
      lines.push({ payeeId: p.id, type: "ADJUSTMENT", dealId: null, amount: round2(a.amount), description: `${a.type}: ${a.reason}`, trace: { adjustmentId: a.id } });
    }
    const attainment = quota > 0 ? walk.cum / quota : 0;
    summaries.push({
      payeeId: p.id,
      quarter: q.label,
      quota: round2(quota),
      bookingsQtd: walk.cum,
      attainment,
      rate,
      currentMultiplier: multiplierAt(plan, attainment),
      earnedQtd,
      monthTotal: round2(lines.filter((l) => l.payeeId === p.id).reduce((s, l) => s + l.amount, 0)),
    });
  }

  const exceptions = findDataExceptions(plan, month, payees, input.deals);
  for (const s of summaries) {
    const p = payees.find((x) => x.id === s.payeeId)!;
    const monthlyTarget = p.targetVariableAnnual / 12;
    if (monthlyTarget > 0 && s.monthTotal > plan.checks.payoutSpikeMultiple * monthlyTarget) {
      exceptions.push({ kind: "PAYOUT_SPIKE", severity: "medium", dealId: null, payeeId: p.id, message: `${p.name}'s payout this month (${usd(s.monthTotal)}) is ${round2(s.monthTotal / monthlyTarget)}x their monthly target variable (${usd(monthlyTarget)}).` });
    }
  }

  const byType = { COMMISSION: 0, KICKER: 0, OVERRIDE: 0, TRUE_UP: 0, ADJUSTMENT: 0 } as Record<LineType, number>;
  for (const l of lines) byType[l.type] = round2(byType[l.type] + l.amount);
  return { month, quarter: q.label, lines, summaries, exceptions, totals: { payout: round2(lines.reduce((s, l) => s + l.amount, 0)), byType } };
}

/** Exact extra payout if the rep closed one more deal this month. */
export function whatIf(input: CalcInput, payeeId: string, amount: number, termMonths = 12) {
  const base = calculate(input);
  const extra: DealInput = { id: "__whatif__", externalId: "__whatif__", name: "Hypothetical deal", account: "Hypothetical", ownerId: payeeId, amount, closeDate: lastDayOf(input.month), termMonths };
  const next = calculate({ ...input, deals: [...input.deals, extra] });
  const before = base.summaries.find((s) => s.payeeId === payeeId);
  const after = next.summaries.find((s) => s.payeeId === payeeId);
  const extraLines = next.lines.filter((l) => l.payeeId === payeeId && l.dealId === "__whatif__");
  return {
    extraPayout: round2((after?.monthTotal ?? 0) - (before?.monthTotal ?? 0)),
    attainmentBefore: before?.attainment ?? 0,
    attainmentAfter: after?.attainment ?? 0,
    lines: extraLines,
  };
}

export type BacktestResult = {
  months: { month: Month; payout: number; bookings: number }[];
  byPayee: { payeeId: string; total: number; target: number }[];
  totalPayout: number;
  totalBookings: number;
  costOfSales: number;
};

/** Runs a plan across a range of months as if each close were paid on time. */
export function backtest(plan: PlanConfig, months: Month[], payees: PayeeInput[], deals: DealInput[], adjustments: AdjustmentInput[] = []): BacktestResult {
  const paid: Record<string, Record<string, number>> = {};
  const byPayee: Record<string, number> = {};
  const out: BacktestResult["months"] = [];
  for (const m of months) {
    const q = quarterOf(m).label;
    const prev = paid[q] ?? (paid[q] = {});
    const r = calculate({ plan, month: m, payees, deals, adjustments, previouslyPaidQtd: { ...prev } });
    for (const l of r.lines) {
      if (l.type !== "ADJUSTMENT") prev[l.payeeId] = round2((prev[l.payeeId] ?? 0) + l.amount);
      byPayee[l.payeeId] = round2((byPayee[l.payeeId] ?? 0) + l.amount);
    }
    const bookings = deals.filter((d) => !d.excluded && monthOf(d.closeDate) === m && d.amount > 0).reduce((s, d) => s + d.amount, 0);
    out.push({ month: m, payout: r.totals.payout, bookings });
  }
  const totalPayout = round2(out.reduce((s, x) => s + x.payout, 0));
  const totalBookings = out.reduce((s, x) => s + x.bookings, 0);
  return {
    months: out,
    byPayee: payees.map((p) => ({ payeeId: p.id, total: byPayee[p.id] ?? 0, target: round2((p.targetVariableAnnual / 12) * months.filter((m) => employedInMonth(p, m)).length) })),
    totalPayout,
    totalBookings,
    costOfSales: totalBookings > 0 ? totalPayout / totalBookings : 0,
  };
}
