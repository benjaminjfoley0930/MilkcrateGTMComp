import { db } from "@/lib/db";
import { Card } from "@/components/ui";
import { signIn } from "./actions";

function Who({ kind, id, label, sub, needsCode }: { kind: string; id?: string; label: string; sub: string; needsCode: boolean }) {
  return (
    <form action={signIn}>
      <input type="hidden" name="kind" value={kind} />
      {id && <input type="hidden" name="id" value={id} />}
      {needsCode && <input type="hidden" name="code" className="code-sink" />}
      <button className="w-full rounded-md border border-stone-200 px-3 py-2 text-left hover:border-stone-400 hover:bg-stone-50">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-stone-600">{sub}</div>
      </button>
    </form>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const needsCode = Boolean(process.env.DEMO_ACCESS_CODE);
  const company = await db.company.findFirst({ where: { slug: "northwind" }, include: { payees: { orderBy: [{ role: "desc" }, { name: "asc" }] } } });
  return (
    <div className="space-y-8">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight">Sales comp, run for you.</h1>
        <p className="mt-2 text-stone-700">
          Milkcrate designs your comp plan, calculates every payout, answers every rep question, and hands you an approved payroll file each month. This prototype runs on a fictional customer, Northwind Analytics (14 AEs, 2 managers).
        </p>
      </div>
      {needsCode && (
        <div className="max-w-sm">
          <label className="text-sm font-medium" htmlFor="code">Access code</label>
          <input id="code" form="none" className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="Enter the demo access code" />
          {error === "code" && <p className="mt-1 text-sm text-red-700">That code didn&apos;t match.</p>}
          <script dangerouslySetInnerHTML={{ __html: "document.getElementById('code').addEventListener('input',e=>document.querySelectorAll('.code-sink').forEach(i=>i.value=e.target.value))" }} />
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Milkcrate">
          <div className="space-y-2">
            <Who kind="operator" label="Comp specialist" sub="Operator console across all customers" needsCode={needsCode} />
          </div>
        </Card>
        {company && (
          <Card title={`${company.name}: leaders`}>
            <div className="space-y-2">
              <Who kind="approver" id={company.id} label={company.approverName} sub="Approves each close" needsCode={needsCode} />
              {company.payees.filter((p) => p.role === "MANAGER").map((p) => (
                <Who key={p.id} kind="payee" id={p.id} label={p.name} sub={p.title} needsCode={needsCode} />
              ))}
            </div>
          </Card>
        )}
        {company && (
          <Card title={`${company.name}: reps`}>
            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {company.payees.filter((p) => p.role === "REP" && !p.endDate).map((p) => (
                <Who key={p.id} kind="payee" id={p.id} label={p.name} sub={p.startDate > "2026-08-01" ? "New hire, ramping" : p.title} needsCode={needsCode} />
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
