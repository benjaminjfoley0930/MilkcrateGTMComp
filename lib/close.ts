import { db } from "./db";
import {
  calculate,
  lastDayOf,
  planSchema,
  quarterOf,
  addBusinessDays,
  type AdjustmentInput,
  type CalcInput,
  type DealInput,
  type Month,
  type PayeeInput,
  type PlanConfig,
} from "./engine";

export const CLOSED_STATUSES = ["APPROVED", "EXPORTED"] as const;

export async function activePlan(companyId: string, month: Month) {
  const pv = await db.planVersion.findFirst({
    where: { companyId, effectiveFrom: { lte: lastDayOf(month) } },
    orderBy: { version: "desc" },
  });
  if (!pv) throw new Error("No plan in effect for this month");
  return { version: pv, config: planSchema.parse(pv.config) as PlanConfig };
}

export function slaDueDate(month: Month): string {
  return addBusinessDays(lastDayOf(month), 5);
}

export async function buildCalcInput(companyId: string, month: Month): Promise<CalcInput & { planVersionId: string }> {
  const { version, config } = await activePlan(companyId, month);
  const [payees, deals, adjustments] = await Promise.all([
    db.payee.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
    db.deal.findMany({ where: { companyId, stage: "closed_won" } }),
    db.adjustment.findMany({ where: { companyId, approved: true, month } }),
  ]);
  const q = quarterOf(month);
  const prior = q.months.filter((m) => m < month);
  let previouslyPaidQtd: Record<string, number> | undefined;
  if (prior.length > 0) {
    const closed = await db.period.findMany({
      where: { companyId, month: { in: prior }, status: { in: [...CLOSED_STATUSES] } },
      select: { id: true },
    });
    if (closed.length === prior.length) {
      previouslyPaidQtd = Object.fromEntries(payees.map((p) => [p.id, 0]));
      const lines = await db.payoutLine.groupBy({
        by: ["payeeId"],
        where: { periodId: { in: closed.map((c) => c.id) }, type: { not: "ADJUSTMENT" } },
        _sum: { amount: true },
      });
      for (const l of lines) previouslyPaidQtd[l.payeeId] = l._sum.amount ?? 0;
    }
  }
  return {
    planVersionId: version.id,
    plan: config,
    month,
    payees: payees.map(
      (p): PayeeInput => ({
        id: p.id,
        name: p.name,
        role: p.role,
        managerId: p.managerId,
        startDate: p.startDate,
        endDate: p.endDate,
        targetVariableAnnual: p.targetVariableAnnual,
        quarterlyQuota: p.quarterlyQuota,
      }),
    ),
    deals: deals.map(
      (d): DealInput => ({
        id: d.id,
        externalId: d.externalId,
        name: d.name,
        account: d.account,
        ownerId: d.ownerId,
        ownerLabel: d.ownerLabel,
        amount: d.amount,
        closeDate: d.closeDate,
        termMonths: d.termMonths,
        excluded: d.excluded,
      }),
    ),
    adjustments: adjustments.map(
      (a): AdjustmentInput => ({ id: a.id, payeeId: a.payeeId, month: a.month, amount: a.amount, type: a.type, reason: a.reason }),
    ),
    previouslyPaidQtd,
  };
}

export type ForecastRow = { payeeId: string; name: string; role: string; quota: number; closed: number; commit: number; best: number; attClosed: number; attCommit: number; attBest: number };

/** Quarter-end payout scenarios: closed deals only, plus commit, plus best case. */
export async function forecastQuarter(companyId: string, month: Month) {
  const q = quarterOf(month);
  const end = q.months[2];
  const input = await buildCalcInput(companyId, end);
  const pipeline = await db.deal.findMany({
    where: { companyId, stage: { in: ["commit", "best_case"] }, excluded: false, closeDate: { gte: `${q.months[0]}-01`, lte: lastDayOf(end) } },
  });
  const toInput = (d: (typeof pipeline)[number]): DealInput => ({ id: d.id, externalId: d.externalId, name: d.name, account: d.account, ownerId: d.ownerId, ownerLabel: d.ownerLabel, amount: d.amount, closeDate: d.closeDate, termMonths: d.termMonths });
  const commit = pipeline.filter((d) => d.stage === "commit").map(toInput);
  const best = pipeline.filter((d) => d.stage === "best_case").map(toInput);
  const run = (deals: DealInput[]) => calculate({ ...input, month: end, previouslyPaidQtd: undefined, deals: [...input.deals, ...deals] });
  const [a, b, c] = [run([]), run(commit), run([...commit, ...best])];
  const rows: ForecastRow[] = a.summaries.map((s) => {
    const p = input.payees.find((x) => x.id === s.payeeId)!;
    const sb = b.summaries.find((x) => x.payeeId === s.payeeId)!;
    const sc = c.summaries.find((x) => x.payeeId === s.payeeId)!;
    return { payeeId: s.payeeId, name: p.name, role: p.role, quota: s.quota, closed: s.earnedQtd, commit: sb.earnedQtd, best: sc.earnedQtd, attClosed: s.attainment, attCommit: sb.attainment, attBest: sc.attainment };
  });
  const budget = input.payees.filter((p) => !p.endDate).reduce((t, p) => t + p.targetVariableAnnual / 4, 0);
  const sum = (k: "closed" | "commit" | "best") => rows.reduce((t, r) => t + r[k], 0);
  return {
    quarter: q.label,
    rows,
    totals: { closed: sum("closed"), commit: sum("commit"), best: sum("best") },
    pipeline: { commit: commit.reduce((t, d) => t + d.amount, 0), best: best.reduce((t, d) => t + d.amount, 0), count: pipeline.length },
    budget,
  };
}

export async function liveCalc(companyId: string, month: Month) {
  const input = await buildCalcInput(companyId, month);
  return { input, result: calculate(input) };
}

export async function audit(companyId: string, actor: string, action: string, detail: string, data?: object) {
  await db.auditEvent.create({ data: { companyId, actor, action, detail, data: data ?? undefined } });
}

/** Recalculates a period and stores its lines and exceptions. Exceptions already resolved stay resolved. */
export async function runClose(periodId: string, actor: string) {
  const period = await db.period.findUniqueOrThrow({ where: { id: periodId } });
  if (CLOSED_STATUSES.includes(period.status as (typeof CLOSED_STATUSES)[number])) {
    throw new Error("This period is approved and locked");
  }
  const input = await buildCalcInput(period.companyId, period.month);
  const result = calculate(input);
  const resolved = await db.closeException.findMany({ where: { periodId, status: "RESOLVED" } });
  const key = (e: { kind: string; dealId: string | null; payeeId: string | null }) => `${e.kind}|${e.dealId}|${e.payeeId}`;
  const resolvedKeys = new Set(resolved.map(key));
  await db.$transaction([
    db.payoutLine.deleteMany({ where: { periodId } }),
    db.closeException.deleteMany({ where: { periodId, status: "OPEN" } }),
    db.payoutLine.createMany({
      data: result.lines.map((l) => ({
        periodId,
        payeeId: l.payeeId,
        dealId: l.dealId,
        type: l.type,
        amount: l.amount,
        description: l.description,
        trace: l.trace as object,
      })),
    }),
    db.closeException.createMany({
      data: result.exceptions
        .filter((e) => !resolvedKeys.has(key(e)))
        .map((e) => ({ periodId, kind: e.kind, severity: e.severity, message: e.message, dealId: e.dealId, payeeId: e.payeeId })),
    }),
    db.period.update({
      where: { id: periodId },
      data: {
        status: "IN_REVIEW",
        planVersionId: input.planVersionId,
        calculatedAt: new Date(),
        totalPayout: result.totals.payout,
        signedOffAt: null,
        signedOffBy: null,
      },
    }),
  ]);
  await audit(period.companyId, actor, "close.calculated", `Calculated ${period.month}: ${result.lines.length} payout lines, ${result.exceptions.length} checks flagged`, {
    month: period.month,
    total: result.totals.payout,
  });
  return result;
}
