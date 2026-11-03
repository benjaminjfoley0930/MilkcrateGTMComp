import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { companyBySlug } from "@/lib/queries";
import { MEASURE_LABEL, PLAN_TEMPLATES, addMonths, backtest, describeTiers, monthLabel, planSchema, type DealInput, type PayeeInput } from "@/lib/engine";
import { currentMonth } from "@/lib/clock";
import { dateLabel, pct, usd } from "@/lib/format";
import { Badge, Button, Card, PageTitle, Td, Th } from "@/components/ui";
import { adoptTemplate } from "@/app/actions";
import { CompanyNav } from "../nav";

export default async function PlanPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireRole("operator");
  const { slug } = await params;
  const company = await companyBySlug(slug);
  const [versions, payeeRows, dealRows] = await Promise.all([
    db.planVersion.findMany({ where: { companyId: company.id }, orderBy: { version: "desc" } }),
    db.payee.findMany({ where: { companyId: company.id } }),
    db.deal.findMany({ where: { companyId: company.id, stage: "closed_won" } }),
  ]);
  const payees: PayeeInput[] = payeeRows.map((p) => ({ id: p.id, name: p.name, role: p.role, managerId: p.managerId, startDate: p.startDate, endDate: p.endDate, targetVariableAnnual: p.targetVariableAnnual, quarterlyQuota: p.quarterlyQuota }));
  const deals: DealInput[] = dealRows.map((d) => ({ id: d.id, externalId: d.externalId, name: d.name, account: d.account, ownerId: d.ownerId, amount: d.amount, closeDate: d.closeDate, termMonths: d.termMonths, excluded: d.excluded }));
  const end = addMonths(currentMonth(), -1);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(end, i - 11));
  const target = payees.reduce((s, p) => s + p.targetVariableAnnual, 0);
  const models = Object.entries(PLAN_TEMPLATES).filter(([key]) => key !== "usage").map(([key, t]) => {
    const b = backtest(t.config, months, payees, deals);
    const reps = b.byPayee.filter((x) => payees.find((p) => p.id === x.payeeId)?.role === "REP" && x.target > 0);
    const ratios = reps.map((r) => r.total / r.target).sort((a, b) => a - b);
    const mean = b.totalPayout / b.months.length;
    const volatility = Math.sqrt(b.months.reduce((a, m) => a + (m.payout - mean) ** 2, 0) / b.months.length) / mean;
    return { key, t, b, atTarget: reps.filter((r) => r.total >= r.target).length, reps: reps.length, min: ratios[0] ?? 0, max: ratios[ratios.length - 1] ?? 0, volatility };
  });
  const current = models.find((m) => m.key === active?.template) ?? models[0];
  const pickBy = (score: (m: (typeof models)[number]) => number) => [...models].sort((a, b) => score(a) - score(b))[0];
  const recs = [
    { goal: "Manage cash", m: pickBy((m) => (m.atTarget < current.atTarget - 1 ? Infinity : m.b.totalPayout)), why: (m: (typeof models)[number]) => `Lowest modeled cost that keeps ${m.atTarget} of ${m.reps} reps at or above target pay.` },
    { goal: "Reward top performers", m: pickBy((m) => -m.max), why: (m: (typeof models)[number]) => `Best rep earns ${pct(m.max)} of target; steeper pay for overperformance.` },
    { goal: "Predictable monthly cost", m: pickBy((m) => m.volatility), why: (m: (typeof models)[number]) => `Smallest month-to-month swing in payouts (${pct(m.volatility)} variation).` },
  ];
  const maxMonth = Math.max(...models.flatMap((m) => m.b.months.map((x) => x.payout)));
  const inEffect = versions.filter((v) => v.effectiveFrom <= `${currentMonth()}-31`).sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? b.version - a.version : b.effectiveFrom.localeCompare(a.effectiveFrom)));
  const active = inEffect[0];
  const activeConfig = active ? planSchema.parse(active.config) : null;
  const colors = ["bg-stone-800", "bg-sky-600", "bg-amber-500"];

  return (
    <div className="space-y-6">
      <PageTitle title={company.name} sub="Plan design, versions and cost modeling" />
      <CompanyNav slug={slug} active="plan" />

      {active && activeConfig && (
        <Card title={<span>Active plan: v{active.version} · {PLAN_TEMPLATES[active.template]?.label ?? active.template}</span>} action={<Badge tone={active.signedAt ? "green" : "amber"}>{active.signedAt ? `Signed ${dateLabel(active.signedAt)}` : "Awaiting rep sign-off"}</Badge>}>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-3 text-sm">
              <div><div className="text-xs font-medium text-stone-600">Measure</div>{MEASURE_LABEL[activeConfig.measure]}; quarterly quota, paid monthly</div>
              <div><div className="text-xs font-medium text-stone-600">Rate</div>Base rate = quarterly target variable / quarterly quota</div>
              <div><div className="text-xs font-medium text-stone-600">Tiers</div><ul className="list-disc pl-5">{describeTiers(activeConfig).map((t) => <li key={t}>{t}</li>)}</ul></div>
              <div><div className="text-xs font-medium text-stone-600">Cap</div>{activeConfig.capAttainment ? `${pct(activeConfig.capAttainment)} of quota` : "Uncapped"}</div>
              <div><div className="text-xs font-medium text-stone-600">Kickers</div>{activeConfig.kickers.length ? activeConfig.kickers.map((k) => `${k.label}: +${pct(k.bonusPct)} on ${k.minTermMonths}+ month terms`).join("; ") : "None"}</div>
              <div><div className="text-xs font-medium text-stone-600">New-hire ramp</div>{activeConfig.ramp.map((r, i) => `Month ${i + 1}: ${pct(r)}`).join(", ")} of quota, then full</div>
              <div><div className="text-xs font-medium text-stone-600">Managers</div>{activeConfig.managerOverride.enabled ? "Override on team bookings, same tiers on team attainment" : "Not on plan"}</div>
              <div><div className="text-xs font-medium text-stone-600">Effective</div>{dateLabel(active.effectiveFrom)}</div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-stone-600">Plan as code (the engine runs exactly this)</div>
              <pre className="max-h-96 overflow-auto rounded-md bg-stone-900 p-3 text-xs text-stone-100">{JSON.stringify(activeConfig, null, 2)}</pre>
            </div>
          </div>
        </Card>
      )}

      <Card title={`Plan options modeled on ${company.name}'s last 12 months of deals (${monthLabel(months[0])} to ${monthLabel(end)})`}>
        <table className="w-full text-sm">
          <thead><tr><Th>Template</Th><Th right>Modeled payout</Th><Th right>vs target variable</Th><Th right>Cost of sales</Th><Th right>Reps at or above target pay</Th><Th right>Rep pay range (% of target)</Th></tr></thead>
          <tbody>
            {models.map((m, i) => (
              <tr key={m.key}>
                <Td><div className="flex items-center gap-2"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${colors[i]}`} /><span className="font-medium">{m.t.label}</span>{active?.template === m.key && <Badge tone="green">Active</Badge>}</div><div className="text-xs text-stone-600">{m.t.summary}</div></Td>
                <Td right>{usd(m.b.totalPayout)}</Td>
                <Td right>{pct(m.b.totalPayout / target)}</Td>
                <Td right>{pct(m.b.costOfSales, 1)}</Td>
                <Td right>{m.atTarget} of {m.reps}</Td>
                <Td right>{pct(m.min)} to {pct(m.max)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-6">
          <div className="mb-2 text-xs font-medium text-stone-600">Modeled monthly payout</div>
          <div className="flex h-40 items-end gap-2">
            {months.map((mo, mi) => (
              <div key={mo} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-32 w-full items-end justify-center gap-0.5">
                  {models.map((m, i) => (
                    <div key={m.key} title={`${m.t.label}: ${usd(m.b.months[mi].payout)}`} className={`w-1/4 rounded-t-sm ${colors[i]}`} style={{ height: `${(m.b.months[mi].payout / maxMonth) * 100}%` }} />
                  ))}
                </div>
                <div className="text-[10px] text-stone-600">{monthLabel(mo).split(" ")[0]}</div>
              </div>
            ))}
          </div>
        </div>
        <form action={adoptTemplate} className="mt-6 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-4 text-sm">
          <input type="hidden" name="companyId" value={company.id} />
          <span>Create a new plan version from</span>
          <select name="template" className="rounded-md border border-stone-300 px-2 py-1.5">{Object.entries(PLAN_TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</select>
          <span>effective</span>
          <input name="effectiveFrom" defaultValue={`${addMonths(currentMonth(), 1)}-01`} className="w-32 rounded-md border border-stone-300 px-2 py-1.5" />
          <Button variant="secondary">Create version</Button>
        </form>
      </Card>

      <Card title="Recommended for next year's plan">
        <table className="w-full text-sm">
          <thead><tr><Th>If your goal is</Th><Th>Recommend</Th><Th right>Cost vs current</Th><Th>Why</Th></tr></thead>
          <tbody>
            {recs.map((r) => {
              const delta = r.m.b.totalPayout - current.b.totalPayout;
              return (
                <tr key={r.goal}>
                  <Td className="font-medium">{r.goal}</Td>
                  <Td>{r.m.t.label}{r.m.key === current.key && <span className="ml-1"><Badge tone="green">Current plan</Badge></span>}</Td>
                  <Td right>{Math.abs(delta) < 1 ? "No change" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))} (${delta > 0 ? "+" : "−"}${pct(Math.abs(delta) / current.b.totalPayout, 1)})`}</Td>
                  <Td className="text-stone-700">{r.why(r.m)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-600">Each option is back-tested on the same 12 months of deals in seconds. Selling on usage? The {PLAN_TEMPLATES.usage.label} template credits consumption as it&apos;s retired, once usage data is connected.</p>
      </Card>

      <Card title="Version history">
        <table className="w-full text-sm">
          <thead><tr><Th>Version</Th><Th>Template</Th><Th>Effective</Th><Th>Rep sign-off</Th></tr></thead>
          <tbody>{versions.map((v) => <tr key={v.id}><Td>v{v.version}</Td><Td>{PLAN_TEMPLATES[v.template]?.label ?? v.template}</Td><Td>{dateLabel(v.effectiveFrom)} {v.id === active?.id ? <Badge tone="green">In effect</Badge> : v.effectiveFrom > `${currentMonth()}-31` ? <Badge tone="blue">Scheduled</Badge> : null}</Td><Td>{v.signedAt ? dateLabel(v.signedAt) : <Badge tone="amber">Pending</Badge>}</Td></tr>)}</tbody>
        </table>
      </Card>
    </div>
  );
}
