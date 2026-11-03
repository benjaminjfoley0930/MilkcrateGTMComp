import Link from "next/link";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { forecastQuarter, liveCalc } from "@/lib/close";
import { benchmark } from "@/lib/benchmarks";
import { currentMonth, today } from "@/lib/clock";
import { closeMonth, slaState } from "@/lib/queries";
import { monthLabel, quarterOf, lastDayOf } from "@/lib/engine";
import { dateLabel, pct, usd } from "@/lib/format";
import { Badge, Bar, Button, Card, PageTitle, Stat, StatusBadge, Td, Th } from "@/components/ui";
import { approveAdjustment, approveClose, createAdjustment } from "@/app/actions";

export default async function LeaderDashboard() {
  const s = await requireRole("leader");
  const company = await db.company.findUniqueOrThrow({ where: { id: s.companyId } });
  const month = currentMonth();
  const { input, result } = await liveCalc(company.id, month);
  const payees = await db.payee.findMany({ where: { companyId: company.id } });
  const scope = s.payeeId ? payees.filter((p) => p.managerId === s.payeeId) : payees.filter((p) => p.role === "REP");
  const scopeIds = new Set(scope.map((p) => p.id));
  const summaries = result.summaries.filter((x) => scopeIds.has(x.payeeId));
  const quota = summaries.reduce((a, x) => a + x.quota, 0);
  const booked = summaries.reduce((a, x) => a + x.bookingsQtd, 0);
  const visible = s.payeeId ? new Set([...scopeIds, s.payeeId]) : new Set(payees.map((p) => p.id));
  const forecast = result.lines.filter((l) => visible.has(l.payeeId)).reduce((a, l) => a + l.amount, 0);
  const budget = payees.filter((p) => visible.has(p.id) && !p.endDate).reduce((a, p) => a + p.targetVariableAnnual / 12, 0);
  const q = quarterOf(month);
  const qStart = new Date(`${q.months[0]}-01T00:00:00Z`).getTime();
  const qEnd = new Date(`${lastDayOf(q.months[2])}T23:59:59Z`).getTime();
  const pace = (new Date(`${today()}T12:00:00Z`).getTime() - qStart) / (qEnd - qStart);
  const cm = closeMonth();
  const period = await db.period.findUnique({ where: { companyId_month: { companyId: company.id, month: cm } }, include: { lines: true, exceptions: true } });
  const prev = await db.period.findFirst({ where: { companyId: company.id, month: { lt: cm } }, orderBy: { month: "desc" } });
  const pendingAdj = await db.adjustment.findMany({ where: { companyId: company.id, approved: false }, include: { payee: true } });
  const sla = slaState(period, cm);
  const fc = await forecastQuarter(company.id, month);
  const fcRows = fc.rows.filter((r) => visible.has(r.payeeId));
  const fcTot = { closed: fcRows.reduce((a, r) => a + r.closed, 0), commit: fcRows.reduce((a, r) => a + r.commit, 0), best: fcRows.reduce((a, r) => a + r.best, 0) };
  const fcBudget = payees.filter((p) => visible.has(p.id) && !p.endDate).reduce((a, p) => a + p.targetVariableAnnual / 4, 0);
  const bm = await benchmark(company.id);
  const fmt = (f: string, v: number) => (f === "usd" ? usd(v) : f === "pct" ? pct(v) : f === "pct1" ? pct(v, 1) : `${v.toFixed(1)}x`);
  const largest = period ? [...period.lines.reduce((m, l) => m.set(l.payeeId, (m.get(l.payeeId) ?? 0) + l.amount), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 3) : [];

  return (
    <div className="space-y-6">
      <PageTitle title={s.payeeId ? `${s.name}'s team` : company.name} sub={`${result.quarter} · ${input.plan.name} · live from ${company.crm}`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Team attainment" value={pct(quota ? booked / quota : 0)} sub={`${usd(booked)} of ${usd(quota)} · pace ${pct(pace)}`} tone={booked / quota >= pace ? "good" : "warn"} />
        <Stat label={`${monthLabel(month)} payout so far`} value={usd(forecast)} sub={`Monthly budget ${usd(budget)}`} />
        <Stat label="Reps behind pace" value={summaries.filter((x) => x.attainment < pace * 0.7).length} sub="Under 70% of expected attainment" tone={summaries.some((x) => x.attainment < pace * 0.7) ? "warn" : "good"} />
        <Stat label={`${monthLabel(cm)} close`} value={period ? <StatusBadge status={period.status} /> : <Badge>Not started</Badge>} sub={sla.delivered ? `Delivered ${dateLabel(sla.delivered)}` : `Due ${dateLabel(sla.due)}`} />
      </div>

      {s.approver && period && (
        <Card title={`${monthLabel(cm)} payouts`} action={
          period.status === "SIGNED_OFF" ? (
            <form action={approveClose.bind(null, period.id)}><Button>Approve {usd(period.totalPayout)}</Button></form>
          ) : period.status === "APPROVED" || period.status === "EXPORTED" ? (
            <a href={`/api/periods/${period.id}/payroll`}><Button variant="secondary">Download {company.payrollProvider} file</Button></a>
          ) : null
        }>
          {period.status === "IN_REVIEW" || period.status === "OPEN" ? (
            <p className="text-sm text-stone-700">Milkcrate is reviewing this close ({period.exceptions.filter((e) => e.status === "OPEN").length} items open). You&apos;ll get it for approval by {dateLabel(sla.due)}.</p>
          ) : (
            <div className="grid gap-4 text-sm md:grid-cols-3">
              <div><div className="text-xs text-stone-600">Total</div><div className="text-lg font-semibold">{usd(period.totalPayout, true)}</div><div className="text-xs text-stone-600">{prev ? `${usd(prev.totalPayout)} in ${monthLabel(prev.month)}` : ""}</div></div>
              <div><div className="text-xs text-stone-600">Reviewed by Milkcrate</div><div>{period.exceptions.length} items checked and resolved</div><div className="text-xs text-stone-600">Signed off {dateLabel(period.signedOffAt)}</div></div>
              <div><div className="text-xs text-stone-600">Largest payouts</div>{largest.map(([id, amt]) => <div key={id}>{payees.find((p) => p.id === id)?.name}: {usd(amt)}</div>)}</div>
            </div>
          )}
          {period.status === "APPROVED" && <p className="mt-3 text-xs text-stone-600">Approved by {period.approvedBy}. Download the file and enter it in {company.payrollProvider}; that&apos;s the only step on your side.</p>}
        </Card>
      )}

      <Card title="Reps">
        <table className="w-full text-sm">
          <thead><tr><Th>Rep</Th><Th right>Quota</Th><Th right>Booked</Th><Th>Attainment</Th><Th right>Earned this month</Th><Th /></tr></thead>
          <tbody>
            {summaries.sort((a, b) => b.attainment - a.attainment).map((x) => {
              const p = payees.find((pp) => pp.id === x.payeeId)!;
              const behind = x.attainment < pace * 0.7;
              return (
                <tr key={x.payeeId}>
                  <Td><div className="font-medium">{p.name}</div>{p.startDate > "2026-08-01" && <Badge tone="blue">Ramping</Badge>}</Td>
                  <Td right>{usd(x.quota)}</Td>
                  <Td right>{usd(x.bookingsQtd)}</Td>
                  <Td><div className="flex items-center gap-2"><Bar value={x.attainment} /><span className="w-12 text-right text-xs tabular-nums">{pct(x.attainment)}</span></div></Td>
                  <Td right>{usd(x.monthTotal, true)}</Td>
                  <Td>{behind && <Badge tone="amber">Behind pace</Badge>}{x.currentMultiplier > 1 && <Badge tone="green">{x.currentMultiplier}x</Badge>}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title={`${fc.quarter} payout forecast from open pipeline`}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Stat label="Earned on closed deals" value={usd(fcTot.closed)} sub={`Quarter budget ${usd(fcBudget)}`} />
          <Stat label="If commit closes" value={usd(fcTot.commit)} sub={`+${usd(fcTot.commit - fcTot.closed)} · ${pct(fcTot.commit / fcBudget)} of budget`} tone={fcTot.commit > fcBudget * 1.15 ? "warn" : undefined} />
          <Stat label="If best case closes too" value={usd(fcTot.best)} sub={`+${usd(fcTot.best - fcTot.closed)} · ${pct(fcTot.best / fcBudget)} of budget`} tone={fcTot.best > fcBudget * 1.15 ? "warn" : undefined} />
          <Stat label="Open pipeline this quarter" value={usd(fc.pipeline.commit + fc.pipeline.best)} sub={`${usd(fc.pipeline.commit)} commit · ${usd(fc.pipeline.best)} best case`} />
        </div>
        <table className="mt-4 w-full text-sm">
          <thead><tr><Th>Payee</Th><Th right>Closed: earned (attainment)</Th><Th right>+ Commit</Th><Th right>+ Best case</Th></tr></thead>
          <tbody>
            {fcRows.sort((a, b) => b.best - a.best).map((r) => (
              <tr key={r.payeeId}>
                <Td>{r.name}{r.role === "MANAGER" && <span className="ml-1 text-xs text-stone-600">(override)</span>}</Td>
                <Td right>{usd(r.closed)} <span className="text-xs text-stone-600">({pct(r.attClosed)})</span></Td>
                <Td right>{usd(r.commit)} <span className="text-xs text-stone-600">({pct(r.attCommit)})</span></Td>
                <Td right>{usd(r.best)} <span className="text-xs text-stone-600">({pct(r.attBest)})</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-600">Runs the signed plan on {company.crm} pipeline (commit and best-case stages) as if every deal closes on its expected date. Accelerators and kickers included.</p>
      </Card>

      <Card title={`How your comp compares · anonymous cohort of ${bm.cohortSize} Milkcrate customers`}>
        <table className="w-full text-sm">
          <thead><tr><Th>Metric</Th><Th right>{company.name}</Th><Th right>Cohort median</Th><Th right>Cohort middle 50%</Th><Th /></tr></thead>
          <tbody>
            {bm.rows.map((r) => {
              const flag = r.you > r.p75 ? "Above cohort" : r.you < r.p25 ? "Below cohort" : null;
              return (
                <tr key={r.key}>
                  <Td>{r.label}</Td>
                  <Td right className="font-medium">{fmt(r.format, r.you)}</Td>
                  <Td right>{fmt(r.format, r.median)}</Td>
                  <Td right>{fmt(r.format, r.p25)} to {fmt(r.format, r.p75)}</Td>
                  <Td>{flag && <Badge tone={flag === "Above cohort" ? "amber" : "blue"}>{flag}</Badge>}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-600">Trailing 12 months, refreshed with every close. Cohort companies are never named. In this prototype the cohort is the other fictional customers.</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Adjustments awaiting approval">
          {pendingAdj.length === 0 ? <p className="text-sm text-stone-600">Nothing waiting.</p> : (
            <ul className="space-y-2 text-sm">
              {pendingAdj.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span>{a.type} {usd(a.amount)} for {a.payee.name} ({monthLabel(a.month)}): {a.reason} <span className="text-xs text-stone-600">· requested by {a.createdBy}</span></span>
                  {s.approver ? <form action={approveAdjustment.bind(null, a.id)}><Button variant="secondary">Approve</Button></form> : <Badge tone="amber">Awaiting {company.approverName}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Request a SPIFF or correction">
          <form action={createAdjustment} className="grid grid-cols-2 gap-2 text-sm">
            <select name="payeeId" className="rounded-md border border-stone-300 px-2 py-1.5">{scope.filter((p) => !p.endDate).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select name="type" className="rounded-md border border-stone-300 px-2 py-1.5"><option>SPIFF</option><option>CORRECTION</option><option>CLAWBACK</option></select>
            <input name="amount" type="number" step="0.01" placeholder="Amount" required className="rounded-md border border-stone-300 px-2 py-1.5" />
            <input name="month" defaultValue={month} className="rounded-md border border-stone-300 px-2 py-1.5" />
            <input name="reason" placeholder="Reason" required className="col-span-2 rounded-md border border-stone-300 px-2 py-1.5" />
            <div className="col-span-2"><Button variant="secondary">Submit</Button></div>
          </form>
          <p className="mt-2 text-xs text-stone-600">Milkcrate applies it in the next close; {company.approverName} approves every payout change.</p>
        </Card>
      </div>
      <p className="text-xs text-stone-600"><Link className="underline" href="/">Switch user</Link> to see the rep or Milkcrate view.</p>
    </div>
  );
}
