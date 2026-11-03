import Link from "next/link";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { closeMonth, companyBySlug, slaState } from "@/lib/queries";
import { liveCalc } from "@/lib/close";
import { addMonths, monthLabel } from "@/lib/engine";
import { currentMonth } from "@/lib/clock";
import { dateLabel, pct, usd } from "@/lib/format";
import { Badge, Bar, Button, Card, PageTitle, Stat, StatusBadge, Td, Th } from "@/components/ui";
import { recalculate, resolveException, signOff, startClose, createAdjustment } from "@/app/actions";
import { CompanyNav } from "./nav";

const SEV: Record<string, "red" | "amber" | "gray"> = { high: "red", medium: "amber", low: "gray" };

export default async function ClosePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ month?: string }> }) {
  await requireRole("operator");
  const { slug } = await params;
  const company = await companyBySlug(slug);
  const month = (await searchParams).month ?? closeMonth();
  const period = await db.period.findUnique({
    where: { companyId_month: { companyId: company.id, month } },
    include: { exceptions: { orderBy: [{ status: "asc" }, { severity: "asc" }] }, lines: true, planVersion: true },
  });
  const payees = await db.payee.findMany({ where: { companyId: company.id }, orderBy: [{ role: "asc" }, { name: "asc" }] });
  const activeReps = payees.filter((p) => p.role === "REP" && !p.endDate);
  const { result } = await liveCalc(company.id, month);
  const prev = await db.period.findUnique({ where: { companyId_month: { companyId: company.id, month: addMonths(month, -1) } } });
  const pendingAdj = await db.adjustment.findMany({ where: { companyId: company.id, approved: false }, include: { payee: true } });
  const auditLog = await db.auditEvent.findMany({ where: { companyId: company.id }, orderBy: { at: "desc" }, take: 8 });
  const openEx = period?.exceptions.filter((e) => e.status === "OPEN") ?? [];
  const locked = period && (period.status === "APPROVED" || period.status === "EXPORTED");
  const sla = slaState(period, month);
  const months = Array.from({ length: 6 }, (_, i) => addMonths(currentMonth(), -i));
  const byPayee = new Map<string, number>();
  for (const l of period?.lines ?? []) byPayee.set(l.payeeId, (byPayee.get(l.payeeId) ?? 0) + l.amount);
  const steps = [
    { label: "Calculated", done: Boolean(period?.calculatedAt), when: period?.calculatedAt },
    { label: "Exceptions cleared", done: Boolean(period) && openEx.length === 0, when: null },
    { label: "Specialist sign-off", done: Boolean(period?.signedOffAt), when: period?.signedOffAt },
    { label: `Customer approval (${company.approverName})`, done: Boolean(period?.approvedAt), when: period?.approvedAt },
    { label: "Payroll file delivered", done: Boolean(period?.exportedAt), when: period?.exportedAt },
  ];

  return (
    <div className="space-y-6">
      <PageTitle
        title={company.name}
        sub={`${monthLabel(month)} close · Plan v${period?.planVersion?.version ?? "–"} · ${company.crm} → ${company.payrollProvider}`}
        action={
          <div className="flex gap-1">
            {months.map((m) => (
              <Link key={m} href={`/ops/${slug}?month=${m}`} className={`rounded px-2 py-1 text-xs ${m === month ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-200"}`}>
                {monthLabel(m)}
              </Link>
            ))}
          </div>
        }
      />
      <CompanyNav slug={slug} active="close" />

      {!period ? (
        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm text-stone-600">
              {month >= currentMonth() ? `${monthLabel(month)} is still in progress. Live estimate: ${usd(result.totals.payout)} across ${result.lines.length} payout lines.` : `The ${monthLabel(month)} close hasn't started.`}
            </p>
            <form action={startClose.bind(null, company.id, month)}>
              <Button>Lock data and calculate</Button>
            </form>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Total payout" value={usd(period.totalPayout)} sub={prev ? `${usd(prev.totalPayout)} last month` : undefined} />
            <Stat label="Status" value={<StatusBadge status={period.status} />} sub={period.calculatedAt ? `Calculated ${dateLabel(period.calculatedAt)}` : undefined} />
            <Stat label="Open exceptions" value={openEx.length} tone={openEx.length ? "warn" : "good"} sub={`${period.exceptions.length - openEx.length} resolved`} />
            <Stat label="SLA" value={sla.label} tone={sla.late ? "bad" : sla.delivered ? "good" : undefined} sub={sla.delivered ? `Delivered ${dateLabel(sla.delivered)}, due ${dateLabel(sla.due)}` : `Due ${dateLabel(sla.due)}`} />
          </div>

          <Card title="Close checklist" action={
            <div className="flex gap-2">
              {!locked && <form action={recalculate.bind(null, period.id)}><Button variant="secondary">Recalculate</Button></form>}
              {period.status === "IN_REVIEW" && <form action={signOff.bind(null, period.id)}><Button disabled={openEx.length > 0}>Sign off close</Button></form>}
              {locked && <a href={`/api/periods/${period.id}/payroll`}><Button>Download {company.payrollProvider} file</Button></a>}
            </div>
          }>
            <ol className="grid gap-2 md:grid-cols-5">
              {steps.map((s, i) => (
                <li key={s.label} className={`rounded-md border px-3 py-2 text-sm ${s.done ? "border-emerald-200 bg-emerald-50" : "border-stone-200"}`}>
                  <div className="text-xs text-stone-500">Step {i + 1}</div>
                  <div className="font-medium">{s.label}</div>
                  <div className="text-xs text-stone-500">{s.done ? (s.when ? dateLabel(s.when) : "Done") : "Pending"}</div>
                </li>
              ))}
            </ol>
          </Card>

          {period.exceptions.length > 0 && (
            <Card title="Exceptions flagged by the Data Reconciler and Calculator">
              <ul className="divide-y divide-stone-100">
                {period.exceptions.map((e) => (
                  <li key={e.id} className="py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge tone={e.status === "OPEN" ? SEV[e.severity] : "green"}>{e.status === "OPEN" ? e.severity : "resolved"}</Badge>
                          <span className="text-xs font-medium text-stone-500">{e.kind.replaceAll("_", " ").toLowerCase()}</span>
                        </div>
                        <p className="mt-1 text-sm">{e.message}</p>
                        {e.resolution && <p className="mt-1 text-xs text-stone-500">{e.resolution} · {e.resolvedBy}</p>}
                      </div>
                      {e.status === "OPEN" && !locked && (
                        <form action={resolveException} className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          <input type="hidden" name="id" value={e.id} />
                          <input name="note" placeholder="Note (optional)" className="w-40 rounded-md border border-stone-300 px-2 py-1 text-xs" />
                          {e.dealId && (e.kind === "UNKNOWN_OWNER" || e.kind === "AFTER_TERMINATION") && (
                            <>
                              <select name="ownerId" className="rounded-md border border-stone-300 px-2 py-1 text-xs">
                                {activeReps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </select>
                              <Button variant="secondary" name="action" value="reassign" className="text-xs">Reassign</Button>
                            </>
                          )}
                          {e.dealId && <Button variant="secondary" name="action" value="exclude" className="text-xs">Exclude deal</Button>}
                          <Button variant="secondary" name="action" value="accept" className="text-xs">Accept</Button>
                        </form>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title={`Payees · ${result.quarter}`}>
            <table className="w-full text-sm">
              <thead><tr><Th>Payee</Th><Th right>Quota (QTD)</Th><Th right>Booked (QTD)</Th><Th>Attainment</Th><Th right>{monthLabel(month)} payout</Th><Th /></tr></thead>
              <tbody>
                {result.summaries.map((s) => {
                  const p = payees.find((x) => x.id === s.payeeId)!;
                  return (
                    <tr key={s.payeeId}>
                      <Td><div className="font-medium">{p.name}</div><div className="text-xs text-stone-500">{p.role === "MANAGER" ? "Manager (team override)" : p.endDate ? `Left ${dateLabel(p.endDate)}` : p.title}</div></Td>
                      <Td right>{usd(s.quota)}</Td>
                      <Td right>{usd(s.bookingsQtd)}</Td>
                      <Td><div className="flex items-center gap-2"><Bar value={s.attainment} /><span className="w-12 text-right text-xs tabular-nums">{pct(s.attainment)}</span></div></Td>
                      <Td right className="font-medium">{usd(byPayee.get(s.payeeId) ?? 0, true)}</Td>
                      <Td right><Link className="text-xs text-stone-600 underline" href={`/statements/${period.id}/${s.payeeId}`}>Statement</Link></Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Adjustments">
          {pendingAdj.length > 0 ? (
            <ul className="mb-4 space-y-1 text-sm">
              {pendingAdj.map((a) => <li key={a.id}><Badge tone="amber">Awaiting {company.approverName}</Badge> {a.type} {usd(a.amount)} for {a.payee.name}, {monthLabel(a.month)}: {a.reason}</li>)}
            </ul>
          ) : <p className="mb-4 text-sm text-stone-500">No adjustments waiting for approval.</p>}
          <form action={createAdjustment} className="grid grid-cols-2 gap-2 text-sm">
            <select name="payeeId" className="rounded-md border border-stone-300 px-2 py-1.5">{payees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select name="type" className="rounded-md border border-stone-300 px-2 py-1.5"><option>SPIFF</option><option>CLAWBACK</option><option>CORRECTION</option></select>
            <input name="amount" type="number" step="0.01" placeholder="Amount (negative for clawback)" className="rounded-md border border-stone-300 px-2 py-1.5" required />
            <input name="month" defaultValue={month} pattern="\d{4}-\d{2}" className="rounded-md border border-stone-300 px-2 py-1.5" />
            <input name="reason" placeholder="Reason (shown on the statement)" className="col-span-2 rounded-md border border-stone-300 px-2 py-1.5" required />
            <div className="col-span-2"><Button variant="secondary">Request adjustment (customer approves)</Button></div>
          </form>
        </Card>
        <Card title="Audit trail">
          <ul className="space-y-2 text-sm">
            {auditLog.map((a) => (
              <li key={a.id}><span className="text-xs text-stone-500">{dateLabel(a.at)} · {a.actor}</span><div>{a.detail}</div></li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
