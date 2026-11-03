import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { companyBySlug } from "@/lib/queries";
import { dateLabel, usd } from "@/lib/format";
import { Badge, Button, Card, PageTitle, Td, Th } from "@/components/ui";
import { importDealsCsv } from "@/app/actions";
import { CompanyNav } from "../nav";

export default async function DataPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ imported?: string; unmatched?: string }> }) {
  await requireRole("operator");
  const { slug } = await params;
  const sp = await searchParams;
  const company = await companyBySlug(slug);
  const [payees, deals, dealCount] = await Promise.all([
    db.payee.findMany({ where: { companyId: company.id }, include: { manager: true }, orderBy: [{ role: "asc" }, { name: "asc" }] }),
    db.deal.findMany({ where: { companyId: company.id }, include: { owner: true }, orderBy: { closeDate: "desc" }, take: 25 }),
    db.deal.count({ where: { companyId: company.id } }),
  ]);
  return (
    <div className="space-y-6">
      <PageTitle title={company.name} sub={`Read-only sync from ${company.crm}, plus CSV upload for anything else`} />
      <CompanyNav slug={slug} active="data" />
      {sp.imported && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm">Imported {sp.imported} deals. {Number(sp.unmatched) > 0 ? `${sp.unmatched} had owners not on the roster; they'll show up as exceptions in the next close.` : "All owners matched the roster."}</div>}
      <Card title="Import deals from CSV">
        <form action={importDealsCsv} className="flex flex-wrap items-center gap-3 text-sm">
          <input type="hidden" name="companyId" value={company.id} />
          <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
          <Button>Import</Button>
          <span className="text-xs text-stone-500">Columns: Opportunity ID, Name, Account, Owner (name or email), Amount, Close Date (YYYY-MM-DD), Term Months. Existing IDs are updated.</span>
        </form>
      </Card>
      <Card title={`Roster (${payees.filter((p) => !p.endDate).length} active)`}>
        <table className="w-full text-sm">
          <thead><tr><Th>Name</Th><Th>Role</Th><Th>Manager</Th><Th>Start</Th><Th>End</Th><Th right>Base</Th><Th right>Target variable</Th><Th right>Quarterly quota</Th></tr></thead>
          <tbody>
            {payees.map((p) => (
              <tr key={p.id} className={p.endDate ? "text-stone-400" : ""}>
                <Td><div className="font-medium">{p.name}</div><div className="text-xs text-stone-500">{p.email}</div></Td>
                <Td>{p.title}</Td>
                <Td>{p.manager?.name ?? "–"}</Td>
                <Td>{dateLabel(p.startDate)}{p.startDate > "2026-08-01" && <div><Badge tone="blue">Ramping</Badge></div>}</Td>
                <Td>{p.endDate ? dateLabel(p.endDate) : "–"}</Td>
                <Td right>{usd(p.baseSalary)}</Td>
                <Td right>{usd(p.targetVariableAnnual)}</Td>
                <Td right>{p.quarterlyQuota ? usd(p.quarterlyQuota) : "Team"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={`Most recent deals (${dealCount} total)`}>
        <table className="w-full text-sm">
          <thead><tr><Th>Opportunity</Th><Th>Owner</Th><Th>Close date</Th><Th right>New ARR</Th><Th right>Term</Th><Th>Source</Th></tr></thead>
          <tbody>
            {deals.map((d) => (
              <tr key={d.id} className={d.excluded ? "text-stone-400 line-through" : ""}>
                <Td><div className="font-medium">{d.name}</div><div className="text-xs text-stone-500">{d.externalId}</div></Td>
                <Td>{d.owner?.name ?? <Badge tone="red">{d.ownerLabel ?? "Unknown"}</Badge>}</Td>
                <Td>{dateLabel(d.closeDate)}</Td>
                <Td right>{usd(d.amount)}</Td>
                <Td right>{d.termMonths ? `${d.termMonths} mo` : "–"}</Td>
                <Td>{d.source === "csv" ? "CSV" : company.crm}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
