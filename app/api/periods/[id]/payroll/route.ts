import { db } from "@/lib/db";
import { getSession, actorName } from "@/lib/session";
import { audit } from "@/lib/close";
import { addBusinessDays, lastDayOf } from "@/lib/engine";
import { today } from "@/lib/clock";

const FORMATS: Record<string, { headers: string[]; row: (p: { externalId: string; name: string; email: string }, amount: number, payDate: string) => (string | number)[] }> = {
  Gusto: { headers: ["employee_id", "employee_name", "email", "earning_type", "amount", "pay_date"], row: (p, a, d) => [p.externalId, p.name, p.email, "Commission", a.toFixed(2), d] },
  Rippling: { headers: ["Employee ID", "Employee Name", "Earning Code", "Amount", "Pay Date"], row: (p, a, d) => [p.externalId, p.name, "COMM", a.toFixed(2), d] },
  ADP: { headers: ["Co Code", "File #", "Name", "Earnings 3 Code", "Earnings 3 Amount"], row: (p, a) => ["MC1", p.externalId, p.name, "C", a.toFixed(2)] },
};

const esc = (v: string | number) => {
  let s = String(v);
  // Stop spreadsheets from evaluating text fields as formulas; plain numbers (including negatives) pass through.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = await getSession();
  if (!s || s.role === "rep") return new Response("Forbidden", { status: 403 });
  const period = await db.period.findUnique({ where: { id }, include: { company: true, lines: { include: { payee: true } } } });
  if (!period) return new Response("Not found", { status: 404 });
  if (s.role === "leader" && (!s.approver || s.companyId !== period.companyId)) return new Response("Forbidden", { status: 403 });
  if (period.status !== "APPROVED" && period.status !== "EXPORTED") return new Response("Close is not approved yet", { status: 409 });
  const totals = new Map<string, { payee: (typeof period.lines)[number]["payee"]; amount: number }>();
  for (const l of period.lines) {
    const t = totals.get(l.payeeId) ?? { payee: l.payee, amount: 0 };
    t.amount += l.amount;
    totals.set(l.payeeId, t);
  }
  const fmt = FORMATS[period.company.payrollProvider] ?? FORMATS.Gusto;
  const periodEnd = lastDayOf(period.month);
  const fileDate = today() > periodEnd ? today() : periodEnd;
  const payDate = addBusinessDays(fileDate, 1);
  const rows = [...totals.values()].filter((t) => Math.abs(t.amount) >= 0.01).sort((a, b) => a.payee.name.localeCompare(b.payee.name));
  const csv = [fmt.headers, ...rows.map((t) => fmt.row(t.payee, Math.round(t.amount * 100) / 100, payDate))].map((r) => r.map(esc).join(",")).join("\n");
  if (period.status === "APPROVED") {
    await db.period.update({ where: { id }, data: { status: "EXPORTED", exportedAt: new Date() } });
    await audit(period.companyId, actorName(s), "close.exported", `Payroll file for ${period.month} delivered (${period.company.payrollProvider} format, ${rows.length} rows)`);
  }
  return new Response(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${period.company.slug}-commissions-${period.month}-${period.company.payrollProvider.toLowerCase()}.csv"` },
  });
}
