import { db } from "./db";
import { addMonths } from "./engine";
import { currentMonth } from "./clock";

export type CompanyMetrics = {
  companyId: string;
  reps: number;
  avgOte: number;
  variableShare: number;
  avgQuotaAnnual: number;
  costOfSales: number;
  medianAttainment: number;
  pctAtQuota: number;
  avgPayoutVsTarget: number;
  topToMedianPay: number;
};

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

/** Trailing-12-month comp metrics for one company, from closed periods and closed-won deals. */
export async function companyMetrics(companyId: string): Promise<CompanyMetrics> {
  const end = addMonths(currentMonth(), -1);
  const start = addMonths(end, -11);
  const [reps, periods, deals] = await Promise.all([
    db.payee.findMany({ where: { companyId, role: "REP", endDate: null } }),
    db.period.findMany({ where: { companyId, month: { gte: start, lte: end }, status: { in: ["APPROVED", "EXPORTED", "SIGNED_OFF", "IN_REVIEW"] } }, include: { lines: true } }),
    db.deal.findMany({ where: { companyId, stage: "closed_won", excluded: false, closeDate: { gte: `${start}-01`, lte: `${end}-31` } } }),
  ]);
  const repIds = new Set(reps.map((r) => r.id));
  const paid = new Map<string, number>();
  let totalPaid = 0;
  for (const p of periods) for (const l of p.lines) {
    totalPaid += l.amount;
    if (repIds.has(l.payeeId)) paid.set(l.payeeId, (paid.get(l.payeeId) ?? 0) + l.amount);
  }
  const bookings = new Map<string, number>();
  let totalBookings = 0;
  for (const d of deals) {
    totalBookings += d.amount;
    if (d.ownerId && repIds.has(d.ownerId)) bookings.set(d.ownerId, (bookings.get(d.ownerId) ?? 0) + d.amount);
  }
  const tenured = reps.filter((r) => r.startDate <= `${start}-01`);
  const attain = tenured.map((r) => (bookings.get(r.id) ?? 0) / (r.quarterlyQuota * 4));
  const payVsTarget = tenured.map((r) => (paid.get(r.id) ?? 0) / r.targetVariableAnnual);
  const pays = tenured.map((r) => paid.get(r.id) ?? 0);
  return {
    companyId,
    reps: reps.length,
    avgOte: reps.reduce((s, r) => s + r.baseSalary + r.targetVariableAnnual, 0) / Math.max(1, reps.length),
    variableShare: reps.reduce((s, r) => s + r.targetVariableAnnual / (r.baseSalary + r.targetVariableAnnual), 0) / Math.max(1, reps.length),
    avgQuotaAnnual: reps.reduce((s, r) => s + r.quarterlyQuota * 4, 0) / Math.max(1, reps.length),
    costOfSales: totalBookings ? totalPaid / totalBookings : 0,
    medianAttainment: median(attain),
    pctAtQuota: attain.length ? attain.filter((a) => a >= 1).length / attain.length : 0,
    avgPayoutVsTarget: payVsTarget.length ? payVsTarget.reduce((a, b) => a + b, 0) / payVsTarget.length : 0,
    topToMedianPay: median(pays) ? quantile(pays, 0.9) / median(pays) : 0,
  };
}

export type BenchmarkRow = { key: keyof CompanyMetrics; label: string; format: "usd" | "pct" | "pct1" | "x"; you: number; median: number; p25: number; p75: number };

const ROWS: { key: keyof CompanyMetrics; label: string; format: "usd" | "pct" | "pct1" | "x" }[] = [
  { key: "avgOte", label: "Average AE OTE", format: "usd" },
  { key: "variableShare", label: "Variable share of OTE", format: "pct" },
  { key: "avgQuotaAnnual", label: "Average annual quota", format: "usd" },
  { key: "medianAttainment", label: "Median attainment (trailing 12 months)", format: "pct" },
  { key: "pctAtQuota", label: "Reps at or above quota", format: "pct" },
  { key: "avgPayoutVsTarget", label: "Average payout vs target variable", format: "pct" },
  { key: "costOfSales", label: "Commission cost of sales", format: "pct1" },
  { key: "topToMedianPay", label: "Top-10% rep pay vs median rep", format: "x" },
];

/** Compares a company with every other Milkcrate customer. Cohort members are never named. */
export async function benchmark(companyId: string) {
  const companies = await db.company.findMany({ select: { id: true } });
  const all = await Promise.all(companies.map((c) => companyMetrics(c.id)));
  const you = all.find((m) => m.companyId === companyId)!;
  const cohort = all.filter((m) => m.companyId !== companyId);
  const rows: BenchmarkRow[] = ROWS.map((r) => {
    const vals = cohort.map((m) => m[r.key] as number);
    return { ...r, you: you[r.key] as number, median: median(vals), p25: quantile(vals, 0.25), p75: quantile(vals, 0.75) };
  });
  return { rows, cohortSize: cohort.length, you };
}
