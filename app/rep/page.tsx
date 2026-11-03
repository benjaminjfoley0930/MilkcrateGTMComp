import Link from "next/link";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { liveCalc } from "@/lib/close";
import { currentMonth, today } from "@/lib/clock";
import { describeTiers, monthLabel, quarterOf, lastDayOf } from "@/lib/engine";
import { dateLabel, pct, usd } from "@/lib/format";
import { Bar, Card, PageTitle, Stat, StatusBadge, Td, Th } from "@/components/ui";
import { WhatIf } from "@/components/what-if";
import { AskForm } from "@/components/ask-form";

export default async function RepPortal() {
  const s = await requireRole("rep");
  const month = currentMonth();
  const { input, result } = await liveCalc(s.companyId, month);
  const me = result.summaries.find((x) => x.payeeId === s.payeeId);
  const lines = result.lines.filter((l) => l.payeeId === s.payeeId);
  const monthTotal = lines.reduce((a, l) => a + l.amount, 0);
  const year = month.slice(0, 4);
  const periods = await db.period.findMany({
    where: { companyId: s.companyId, month: { gte: `${year}-01` }, status: { in: ["APPROVED", "EXPORTED", "SIGNED_OFF", "IN_REVIEW"] } },
    include: { lines: { where: { payeeId: s.payeeId } } },
    orderBy: { month: "desc" },
  });
  const paid = periods.filter((p) => p.status === "APPROVED" || p.status === "EXPORTED");
  const ytd = paid.reduce((a, p) => a + p.lines.reduce((b, l) => b + l.amount, 0), 0);
  const pending = periods.find((p) => p.status === "IN_REVIEW" || p.status === "SIGNED_OFF");
  const payee = await db.payee.findUniqueOrThrow({ where: { id: s.payeeId }, include: { company: true } });
  const questions = await db.question.findMany({ where: { payeeId: s.payeeId }, orderBy: { createdAt: "desc" }, take: 6 });
  const deals = await db.deal.findMany({ where: { id: { in: lines.map((l) => l.dealId).filter((x): x is string => Boolean(x)) } } });
  const q = quarterOf(month);
  const qStart = new Date(`${q.months[0]}-01T00:00:00Z`).getTime();
  const qEnd = new Date(`${lastDayOf(q.months[2])}T23:59:59Z`).getTime();
  const pace = (new Date(`${today()}T12:00:00Z`).getTime() - qStart) / (qEnd - qStart);

  return (
    <div className="space-y-6">
      <PageTitle title={`Hi, ${s.name.split(" ")[0]}`} sub={`${payee.company.name} · ${input.plan.name} · ${result.quarter}`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={`${result.quarter} attainment`} value={pct(me?.attainment ?? 0)} sub={`${usd(me?.bookingsQtd ?? 0)} of ${usd(me?.quota ?? 0)}${pace > 0 ? ` · on pace = ${pct(pace)}` : ""}`} tone={(me?.attainment ?? 0) >= pace ? "good" : "warn"} />
        <Stat label="Current rate" value={`${me?.currentMultiplier ?? 1}x`} sub={`Base rate ${pct(me?.rate ?? 0, 1)} of new ARR`} />
        <Stat label={`Earned in ${monthLabel(month)} so far`} value={usd(monthTotal)} sub="Paid after the month closes" />
        <Stat label={`Paid in ${year}`} value={usd(ytd)} sub={`${paid.length} approved statements`} />
      </div>
      <Card title={`Quota progress, ${result.quarter}`}>
        <Bar value={me?.attainment ?? 0} />
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-stone-700">{describeTiers(input.plan).map((t) => <li key={t}>{t}</li>)}</ul>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={`Deals credited in ${monthLabel(month)}`}>
          {lines.length === 0 ? <p className="text-sm text-stone-600">No deals credited yet this month.</p> : (
            <table className="w-full text-sm">
              <thead><tr><Th>Deal</Th><Th right>ARR</Th><Th right>You earn</Th></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const d = deals.find((x) => x.id === l.dealId);
                  return (
                    <tr key={i}>
                      <Td><div className="font-medium">{d?.name ?? l.type}</div><div className="text-xs text-stone-600">{l.type === "KICKER" ? "Multi-year kicker" : l.description.split(": ").slice(1).join(": ")}</div></Td>
                      <Td right>{d && l.type !== "KICKER" ? usd(d.amount) : ""}</Td>
                      <Td right className="font-medium">{usd(l.amount, true)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="What if I close another deal?">
          <WhatIf />
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Ask about your pay">
          <AskForm />
          <ul className="mt-4 space-y-3">
            {questions.map((qq) => (
              <li key={qq.id} className="rounded-md bg-stone-50 p-3 text-sm">
                <div className="flex items-center justify-between gap-2"><span className="font-medium">&ldquo;{qq.text}&rdquo;</span><StatusBadge status={qq.status} /></div>
                {qq.answer ? <p className="mt-1 whitespace-pre-line text-stone-700">{qq.answer}</p> : <p className="mt-1 text-xs text-stone-600">A specialist is reviewing the answer. Usually under an hour.</p>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Statements">
          <table className="w-full text-sm">
            <tbody>
              {pending && (
                <tr><Td>{monthLabel(pending.month)}</Td><Td><StatusBadge status={pending.status} /></Td><Td right>{usd(pending.lines.reduce((a, l) => a + l.amount, 0), true)}</Td><Td right><Link className="text-xs underline" href={`/statements/${pending.id}/${s.payeeId}`}>Preview</Link></Td></tr>
              )}
              {paid.map((p) => (
                <tr key={p.id}><Td>{monthLabel(p.month)}</Td><Td><span className="text-xs text-stone-600">Approved {dateLabel(p.approvedAt)}</span></Td><Td right>{usd(p.lines.reduce((a, l) => a + l.amount, 0), true)}</Td><Td right><Link className="text-xs underline" href={`/statements/${p.id}/${s.payeeId}`}>View</Link></Td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
