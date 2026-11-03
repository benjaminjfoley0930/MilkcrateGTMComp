import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { companyBySlug } from "@/lib/queries";
import { PLAN_TEMPLATES, addMonths, backtest, describeTiers, monthLabel, planSchema, type DealInput, type PayeeInput } from "@/lib/engine";
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
    db.deal.findMany({ where: { companyId: company.id } }),
  ]);
  const payees: PayeeInput[] = payeeRows.map((p) => ({ id: p.id, name: p.name, role: p.role, managerId: p.managerId, startDate: p.startDate, endDate: p.endDate, targetVariableAnnual: p.targetVariableAnnual, quarterlyQuota: p.quarterlyQuota }));
  const deals: DealInput[] = dealRows.map((d) => ({ id: d.id, externalId: d.externalId, name: d.name, account: d.account, ownerId: d.ownerId, amount: d.amount, closeDate: d.closeDate, termMonths: d.termMonths, excluded: d.excluded }));
  const end = addMonths(currentMonth(), -1);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(end, i - 11));
  const target = payees.reduce((s, p) => s + p.targetVariableAnnual, 0);
  const models = Object.entries(PLAN_TEMPLATES).map(([key, t]) => {
    const b = backtest(t.config, months, payees, deals);
    const reps = b.byPayee.filter((x) => payees.find((p) => p.id === x.payeeId)?.role === "REP" && x.target > 0);
    const ratios = reps.map((r) => r.total / r.target).sort((a, b) => a - b);
    return { key, t, b, atTarget: reps.filter((r) => r.total >= r.target).length, reps: reps.length, min: ratios[0] ?? 0, max: ratios[ratios.length - 1] ?? 0 };
  });
  const maxMonth = Math.max(...models.flatMap((m) => m.b.months.map((x) => x.payout)));
  const active = versions[0];
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
              <div><div className="text-xs font-medium text-stone-500">Measure</div>New ARR, credited on closed-won, quarterly quota, paid monthly</div>
              <div><div className="text-xs font-medium text-stone-500">Rate</div>Base rate = quarterly target variable / quarterly quota</div>
              <div><div className="text-xs font-medium text-stone-500">Tiers</div><ul className="list-disc pl-5">{describeTiers(activeConfig).map((t) => <li key={t}>{t}</li>)}</ul></div>
              <div><div className="text-xs font-medium text-stone-500">Cap</div>{activeConfig.capAttainment ? `${pct(activeConfig.capAttainment)} of quota` : "Uncapped"}</div>
              <div><div className="text-xs font-medium text-stone-500">Kickers</div>{activeConfig.kickers.length ? activeConfig.kickers.map((k) => `${k.label}: +${pct(k.bonusPct)} on ${k.minTermMonths}+ month terms`).join("; ") : "None"}</div>
              <div><div className="text-xs font-medium text-stone-500">New-hire ramp</div>{activeConfig.ramp.map((r, i) => `Month ${i + 1}: ${pct(r)}`).join(", ")} of quota, then full</div>
              <div><div className="text-xs font-medium text-stone-500">Managers</div>{activeConfig.managerOverride.enabled ? "Override on team bookings, same tiers on team attainment" : "Not on plan"}</div>
              <div><div className="text-xs font-medium text-stone-500">Effective</div>{dateLabel(active.effectiveFrom)}</div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-stone-500">Plan as code (the engine runs exactly this)</div>
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
                <Td><div className="flex items-center gap-2"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${colors[i]}`} /><span className="font-medium">{m.t.label}</span>{active?.template === m.key && <Badge tone="green">Active</Badge>}</div><div className="text-xs text-stone-500">{m.t.summary}</div></Td>
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
          <div className="mb-2 text-xs font-medium text-stone-500">Modeled monthly payout</div>
          <div className="flex h-40 items-end gap-2">
            {months.map((mo, mi) => (
              <div key={mo} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-32 w-full items-end justify-center gap-0.5">
                  {models.map((m, i) => (
                    <div key={m.key} title={`${m.t.label}: ${usd(m.b.months[mi].payout)}`} className={`w-1/4 rounded-t-sm ${colors[i]}`} style={{ height: `${(m.b.months[mi].payout / maxMonth) * 100}%` }} />
                  ))}
                </div>
                <div className="text-[10px] text-stone-500">{monthLabel(mo).split(" ")[0]}</div>
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

      <Card title="Version history">
        <table className="w-full text-sm">
          <thead><tr><Th>Version</Th><Th>Template</Th><Th>Effective</Th><Th>Rep sign-off</Th></tr></thead>
          <tbody>{versions.map((v) => <tr key={v.id}><Td>v{v.version}</Td><Td>{PLAN_TEMPLATES[v.template]?.label ?? v.template}</Td><Td>{dateLabel(v.effectiveFrom)}</Td><Td>{v.signedAt ? dateLabel(v.signedAt) : <Badge tone="amber">Pending</Badge>}</Td></tr>)}</tbody>
        </table>
      </Card>
    </div>
  );
}
