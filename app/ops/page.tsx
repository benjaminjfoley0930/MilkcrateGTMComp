import Link from "next/link";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { closeMonth, monthlyFee, slaState } from "@/lib/queries";
import { monthLabel } from "@/lib/engine";
import { dateLabel, usd } from "@/lib/format";
import { Badge, Card, PageTitle, Stat, StatusBadge, Td, Th } from "@/components/ui";

export default async function OpsHome() {
  await requireRole("operator");
  const month = closeMonth();
  const companies = await db.company.findMany({ orderBy: { name: "asc" }, include: { payees: { where: { endDate: null } } } });
  const rows = await Promise.all(
    companies.map(async (c) => {
      const period = await db.period.findUnique({ where: { companyId_month: { companyId: c.id, month } } });
      const [openEx, openQ, pendingAdj, fee, history] = await Promise.all([
        period ? db.closeException.count({ where: { periodId: period.id, status: "OPEN" } }) : 0,
        db.question.count({ where: { companyId: c.id, status: { in: ["DRAFT", "ESCALATED"] } } }),
        db.adjustment.count({ where: { companyId: c.id, approved: false } }),
        monthlyFee(c.id),
        db.period.findMany({ where: { companyId: c.id, status: { in: ["APPROVED", "EXPORTED"] } }, select: { month: true, approvedAt: true, signedOffAt: true } }),
      ]);
      const onTime = history.filter((p) => !slaState(p, p.month).late).length;
      return { c, period, openEx, openQ, pendingAdj, fee, sla: slaState(period, month), onTime, closes: history.length };
    }),
  );
  const totalFee = rows.reduce((s, r) => s + r.fee.monthly, 0);
  const payees = companies.reduce((s, c) => s + c.payees.length, 0);
  return (
    <div className="space-y-6">
      <PageTitle title="Operator console" sub={`${monthLabel(month)} close across all customers. Statements are due 5 business days after month end.`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Customers" value={companies.length} sub={`${payees} payees`} />
        <Stat label="Monthly fees" value={usd(totalFee)} sub="2.5% of annual target variable / 12" />
        <Stat label="Open exceptions" value={rows.reduce((s, r) => s + r.openEx, 0)} tone={rows.some((r) => r.openEx) ? "warn" : "good"} sub={`${monthLabel(month)} close`} />
        <Stat label="Rep questions waiting" value={rows.reduce((s, r) => s + r.openQ, 0)} tone={rows.some((r) => r.openQ) ? "warn" : "good"} sub="Drafts and escalations" />
      </div>
      <Card title={`${monthLabel(month)} close`}>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>Customer</Th>
              <Th>Status</Th>
              <Th>SLA</Th>
              <Th right>Payout</Th>
              <Th right>Exceptions</Th>
              <Th right>Questions</Th>
              <Th right>Fee / month</Th>
              <Th>Track record</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.c.id} className="hover:bg-stone-50">
                <Td>
                  <Link href={`/ops/${r.c.slug}`} className="font-medium underline-offset-2 hover:underline">{r.c.name}</Link>
                  <div className="text-xs text-stone-500">{r.c.payees.length} payees · {r.c.crm} · {r.c.payrollProvider}</div>
                </Td>
                <Td>{r.period ? <StatusBadge status={r.period.status} /> : <Badge>Not started</Badge>}</Td>
                <Td>
                  <Badge tone={r.sla.late ? "red" : r.sla.delivered ? "green" : "gray"}>{r.sla.label}</Badge>
                  <div className="mt-0.5 text-xs text-stone-500">{r.sla.delivered ? `Delivered ${dateLabel(r.sla.delivered)}` : `Due ${dateLabel(r.sla.due)}`}</div>
                </Td>
                <Td right>{r.period ? usd(r.period.totalPayout) : "–"}</Td>
                <Td right>{r.openEx ? <Badge tone="amber">{r.openEx} open</Badge> : <span className="text-stone-400">0</span>}</Td>
                <Td right>{r.openQ ? <Badge tone="amber">{r.openQ}</Badge> : <span className="text-stone-400">0</span>}{r.pendingAdj ? <div className="mt-0.5 text-xs text-stone-500">{r.pendingAdj} adj. pending</div> : null}</Td>
                <Td right>{usd(r.fee.monthly)}</Td>
                <Td><span className="text-xs text-stone-600">{r.onTime}/{r.closes} closes on time</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-stone-500">Accuracy guarantee: if Milkcrate is late or misses an agreed plan rule, that month&apos;s fee is credited back. Source-data errors, late approvals and changes sent after cutoff are excluded.</p>
    </div>
  );
}
