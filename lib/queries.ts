import { db } from "./db";
import { slaDueDate } from "./close";
import { addMonths } from "./engine";
import { currentMonth, today } from "./clock";

export async function companyBySlug(slug: string) {
  return db.company.findUniqueOrThrow({ where: { slug } });
}

export function closeMonth() {
  return addMonths(currentMonth(), -1);
}

export function slaState(period: { month: string; approvedAt: Date | null; signedOffAt: Date | null } | null, month: string) {
  const due = slaDueDate(month);
  const delivered = period?.approvedAt ? period.approvedAt.toISOString().slice(0, 10) : null;
  if (delivered) return { due, delivered, late: delivered > due, label: delivered > due ? "Late" : "On time" };
  const late = today() > due;
  return { due, delivered: null, late, label: late ? "Overdue" : "Due" };
}

export async function monthlyFee(companyId: string) {
  const c = await db.company.findUniqueOrThrow({ where: { id: companyId }, include: { payees: { where: { endDate: null } } } });
  const annualTarget = c.payees.reduce((s, p) => s + p.targetVariableAnnual, 0);
  return { annualTarget, monthly: (annualTarget * c.feeRate) / 12, rate: c.feeRate };
}
