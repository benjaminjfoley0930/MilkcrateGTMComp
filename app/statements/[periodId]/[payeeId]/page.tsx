import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { monthLabel } from "@/lib/engine";
import { dateLabel, usd } from "@/lib/format";
import { Badge, Td, Th } from "@/components/ui";
import { PrintButton } from "@/components/print-button";

const TYPE_LABEL: Record<string, string> = { COMMISSION: "Commission", KICKER: "Kicker", OVERRIDE: "Team override", TRUE_UP: "True-up", ADJUSTMENT: "Adjustment" };

export default async function Statement({ params }: { params: Promise<{ periodId: string; payeeId: string }> }) {
  const { periodId, payeeId } = await params;
  const s = await getSession();
  if (!s) notFound();
  const period = await db.period.findUnique({ where: { id: periodId }, include: { company: true, planVersion: true } });
  const payee = await db.payee.findUnique({ where: { id: payeeId } });
  if (!period || !payee || payee.companyId !== period.companyId) notFound();
  if (s.role === "rep" && s.payeeId !== payeeId) notFound();
  if (s.role === "leader" && s.companyId !== period.companyId) notFound();
  if (s.role === "leader" && !s.approver && payee.id !== s.payeeId && payee.managerId !== s.payeeId) notFound();
  const lines = await db.payoutLine.findMany({ where: { periodId, payeeId }, include: { deal: true }, orderBy: [{ type: "asc" }] });
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const final = period.status === "APPROVED" || period.status === "EXPORTED";
  return (
    <div className="mx-auto max-w-3xl rounded-lg border border-stone-200 bg-white p-8 print:border-0 print:p-0">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-stone-600">Commission statement</div>
          <h1 className="mt-1 text-2xl font-semibold">{payee.name}</h1>
          <div className="text-sm text-stone-700">{period.company.name} · {monthLabel(period.month)} · Plan v{period.planVersion?.version}</div>
        </div>
        <div className="text-right">
          {final ? <Badge tone="green">Approved {dateLabel(period.approvedAt)}</Badge> : <Badge tone="amber">Preliminary, not yet approved</Badge>}
          <div className="mt-2 text-3xl font-semibold tabular-nums">{usd(total, true)}</div>
          <div className="text-xs text-stone-600">Total this period</div>
        </div>
      </div>
      <table className="mt-8 w-full text-sm">
        <thead>
          <tr><Th>Type</Th><Th>Detail</Th><Th right>Amount</Th></tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <Td className="whitespace-nowrap">{TYPE_LABEL[l.type] ?? l.type}</Td>
              <Td>
                {l.description}
                {l.deal && <div className="text-xs text-stone-600">{l.deal.externalId} · closed {dateLabel(l.deal.closeDate)} · {usd(l.deal.amount)} ARR · {l.deal.termMonths ?? 12}-month term</div>}
              </Td>
              <Td right>{usd(l.amount, true)}</Td>
            </tr>
          ))}
          {lines.length === 0 && <tr><Td className="text-stone-600">No payouts this period.</Td><Td /><Td /></tr>}
          <tr><Td /><Td className="font-medium">Total</Td><Td right className="font-semibold">{usd(total, true)}</Td></tr>
        </tbody>
      </table>
      <p className="mt-6 text-xs text-stone-600">
        Calculated by Milkcrate from {period.company.crm} data under your signed plan, reviewed by a Milkcrate comp specialist{final ? ` and approved by ${period.approvedBy}` : ""}. Paid through {period.company.payrollProvider} in your regular payroll. Questions? Ask in the portal or in Slack.
      </p>
      <div className="mt-6 print:hidden"><PrintButton /></div>
    </div>
  );
}
