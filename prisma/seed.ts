import "dotenv/config";
import { db } from "../lib/db";
import type { Payee, Prisma } from "../lib/generated/prisma/client";
import { runClose, slaDueDate } from "../lib/close";
import { PLAN_TEMPLATES, addBusinessDays, addMonths, lastDayOf, type Month } from "../lib/engine";

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST: Month = "2025-11";
const CURRENT_CLOSE: Month = "2026-10";
const OPEN_MONTH: Month = "2026-11";
const TODAY = "2026-11-03";

const ACCOUNTS = ["Acme Robotics", "Bluefin Labs", "Cedar Health", "Delta Freight", "Evergreen Foods", "Falcon Energy", "Granite Insurance", "Helios Solar", "Ironwood Legal", "Juniper Retail", "Keystone Bank", "Lumen Media", "Maple Logistics", "Nimbus Cloud", "Orchid Pharma", "Pioneer Mfg", "Quarry Mining", "Redwood Realty", "Summit Hotels", "Tidewater Marine", "Umber Analytics", "Vantage Telecom", "Willow Schools", "Xenon Devices", "Yellowstone Outdoors", "Zephyr Air"];
const PRODUCTS = ["Platform", "Expansion", "Analytics add-on", "Enterprise tier", "Starter"];

type CompanySpec = {
  slug: string;
  name: string;
  crm: string;
  payroll: string;
  approver: [string, string];
  seed: number;
  managers: { name: string; title: string }[];
  reps: { name: string; team: number; start: string; end?: string; perf: number }[];
  octStatus: "IN_REVIEW" | "SIGNED_OFF" | "APPROVED";
  injectIssues?: boolean;
};

const companies: CompanySpec[] = [
  {
    slug: "northwind",
    name: "Northwind Analytics",
    crm: "Salesforce",
    payroll: "Gusto",
    approver: ["Dana Whitfield (CFO)", "dana@northwind.example"],
    seed: 7,
    octStatus: "IN_REVIEW",
    injectIssues: true,
    managers: [
      { name: "Priya Shah", title: "Sales Manager, East" },
      { name: "Marcus Cole", title: "Sales Manager, West" },
    ],
    reps: [
      { name: "Ava Thompson", team: 0, start: "2024-03-04", perf: 1.35 },
      { name: "Liam Carter", team: 0, start: "2024-06-10", perf: 1.05 },
      { name: "Sofia Martinez", team: 0, start: "2023-11-13", perf: 1.2 },
      { name: "Noah Kim", team: 0, start: "2025-01-06", perf: 0.8 },
      { name: "Emma Wilson", team: 0, start: "2024-09-16", perf: 0.95 },
      { name: "Ethan Brooks", team: 0, start: "2025-04-07", perf: 0.7 },
      { name: "Grace Lee", team: 0, start: "2026-09-08", perf: 0.9 },
      { name: "Lucas Rivera", team: 1, start: "2023-08-21", perf: 1.15 },
      { name: "Mia Patel", team: 1, start: "2024-02-12", perf: 1.0 },
      { name: "James O'Neil", team: 1, start: "2024-10-07", perf: 0.85 },
      { name: "Chloe Nguyen", team: 1, start: "2025-02-03", perf: 1.1 },
      { name: "Henry Adams", team: 1, start: "2024-05-20", perf: 0.6 },
      { name: "Zoe Bennett", team: 1, start: "2025-06-02", perf: 0.95 },
      { name: "Owen Foster", team: 1, start: "2023-12-04", perf: 1.25 },
      { name: "Ryan Douglas", team: 1, start: "2024-01-08", end: "2026-08-28", perf: 0.75 },
    ],
  },
  {
    slug: "harbor",
    name: "Harbor Health Software",
    crm: "HubSpot",
    payroll: "Rippling",
    approver: ["Sam Ortiz (Controller)", "sam@harbor.example"],
    seed: 21,
    octStatus: "APPROVED",
    managers: [{ name: "Elena Rossi", title: "VP Sales" }],
    reps: ["Aiden Clark", "Bella Hughes", "Caleb Price", "Daisy Ward", "Eli Turner", "Fiona Reed", "Gavin Scott", "Hannah Cruz", "Isaac Long", "Jade Morgan", "Kai Bishop", "Lena Fox", "Milo Grant", "Nora Hale"].map((name, i) => ({ name, team: 0, start: "2024-0" + ((i % 9) + 1) + "-01", perf: 0.7 + ((i * 37) % 60) / 100 })),
  },
  {
    slug: "copperline",
    name: "Copperline Logistics",
    crm: "Salesforce",
    payroll: "ADP",
    approver: ["Jordan Blake (CRO)", "jordan@copperline.example"],
    seed: 42,
    octStatus: "SIGNED_OFF",
    managers: [{ name: "Theo Walsh", title: "Head of Sales" }],
    reps: ["Abby Dunn", "Blake Ford", "Cora Lane", "Dev Mehta", "Eva Stone", "Finn Hart", "Gia Romano", "Hugo Banks", "Ivy Chen", "Jack Rowe", "Kira Wolfe", "Leo Marsh"].map((name, i) => ({ name, team: 0, start: "2024-1" + (i % 3) + "-01", perf: 0.75 + ((i * 53) % 55) / 100 })),
  },
];

function emailOf(name: string, slug: string) {
  return `${name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".")}@${slug}.example`;
}

async function seedCompany(spec: CompanySpec) {
  const rand = rng(spec.seed);
  const company = await db.company.create({
    data: { slug: spec.slug, name: spec.name, crm: spec.crm, payrollProvider: spec.payroll, approverName: spec.approver[0], approverEmail: spec.approver[1], autoSendAnswers: Boolean(spec.injectIssues) },
  });
  const managers: Payee[] = [];
  for (const [i, m] of spec.managers.entries()) {
    managers.push(
      await db.payee.create({
        data: { companyId: company.id, externalId: `MGR-${i + 1}`, name: m.name, email: emailOf(m.name, spec.slug), title: m.title, role: "MANAGER", startDate: "2023-06-01", baseSalary: 160_000, targetVariableAnnual: 60_000, quarterlyQuota: 0 },
      }),
    );
  }
  const reps: { spec: CompanySpec["reps"][number]; row: Payee }[] = [];
  for (const [i, r] of spec.reps.entries()) {
    reps.push({
      spec: r,
      row: await db.payee.create({
        data: { companyId: company.id, externalId: `AE-${String(i + 1).padStart(3, "0")}`, name: r.name, email: emailOf(r.name, spec.slug), title: "Account Executive", role: "REP", managerId: managers[r.team].id, startDate: r.start, endDate: r.end ?? null, baseSalary: 75_000, targetVariableAnnual: 75_000, quarterlyQuota: 250_000 },
      }),
    });
  }
  await db.planVersion.create({
    data: { companyId: company.id, version: 1, template: "standard", effectiveFrom: `${FIRST}-01`, config: PLAN_TEMPLATES.standard.config, signedAt: new Date(`${FIRST}-01T12:00:00Z`) },
  });

  let opp = 1000;
  const deals: Prisma.DealCreateManyInput[] = [];
  for (let m = FIRST; m <= OPEN_MONTH; m = addMonths(m, 1)) {
    const lastDay = m === OPEN_MONTH ? Number(TODAY.slice(8)) : Number(lastDayOf(m).slice(8));
    for (const { spec: r, row } of reps) {
      if (r.start.slice(0, 7) > m || (r.end && r.end.slice(0, 7) < m)) continue;
      const target = (250_000 / 3) * r.perf * (0.6 + rand() * 0.8) * (m === OPEN_MONTH ? 0.1 : 1);
      let booked = 0;
      while (booked < target) {
        const amt = Math.round(Math.min(120_000, Math.max(6_000, Math.exp(Math.log(26_000) + (rand() - 0.5) * 1.4))) / 500) * 500;
        const day = 1 + Math.floor(rand() * lastDay);
        const closeDate = `${m}-${String(day).padStart(2, "0")}`;
        if (closeDate < r.start || (r.end && closeDate > r.end)) break;
        const account = ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)];
        const t = rand();
        deals.push({ companyId: company.id, externalId: `OPP-${opp++}`, name: `${account} - ${PRODUCTS[Math.floor(rand() * PRODUCTS.length)]}`, account, ownerId: row.id, ownerLabel: row.name, amount: amt, closeDate, termMonths: t < 0.7 ? 12 : t < 0.9 ? 24 : 36 });
        booked += amt;
      }
    }
  }
  if (spec.injectIssues) {
    const byName = (n: string) => reps.find((r) => r.spec.name === n)!.row;
    const dupSource = deals.find((d) => d.closeDate.startsWith(CURRENT_CLOSE) && d.ownerId === byName("Liam Carter").id)!;
    deals.push(
      { companyId: company.id, externalId: `OPP-${opp++}`, name: "Keystone Bank - Enterprise tier", account: "Keystone Bank", ownerId: null, ownerLabel: "Jordan Lee", amount: 42_000, closeDate: "2026-10-22", termMonths: 12 },
      { ...dupSource, externalId: `OPP-${opp++}`, name: `${dupSource.name} (copy)` },
      { companyId: company.id, externalId: `OPP-${opp++}`, name: "Tidewater Marine - Platform", account: "Tidewater Marine", ownerId: byName("Ryan Douglas").id, ownerLabel: "Ryan Douglas", amount: 18_500, closeDate: "2026-10-09", termMonths: 12 },
      { companyId: company.id, externalId: `OPP-${opp++}`, name: "Nimbus Cloud - Enterprise tier", account: "Nimbus Cloud", ownerId: byName("Ava Thompson").id, ownerLabel: "Ava Thompson", amount: 185_000, closeDate: "2026-10-28", termMonths: 36 },
    );
  }
  await db.deal.createMany({ data: deals });

  if (spec.injectIssues) {
    const ava = reps.find((r) => r.spec.name === "Ava Thompson")!.row;
    const mia = reps.find((r) => r.spec.name === "Mia Patel")!.row;
    const henry = reps.find((r) => r.spec.name === "Henry Adams")!.row;
    await db.adjustment.createMany({
      data: [
        { companyId: company.id, payeeId: henry.id, month: "2026-09", amount: -1_250, type: "CLAWBACK", reason: "Juniper Retail churned within 90 days (OPP-1187)", approved: true, createdBy: "Milkcrate specialist" },
        { companyId: company.id, payeeId: ava.id, month: "2026-10", amount: 1_000, type: "SPIFF", reason: "Q4 analytics add-on SPIFF", approved: true, createdBy: "Priya Shah" },
        { companyId: company.id, payeeId: mia.id, month: "2026-10", amount: 1_000, type: "SPIFF", reason: "Q4 analytics add-on SPIFF", approved: true, createdBy: "Marcus Cole" },
      ],
    });
  }

  for (let m = FIRST; m <= CURRENT_CLOSE; m = addMonths(m, 1)) {
    const period = await db.period.create({ data: { companyId: company.id, month: m } });
    await runClose(period.id, "Calculator agent");
    const isCurrent = m === CURRENT_CLOSE;
    const status = isCurrent ? spec.octStatus : "EXPORTED";
    if (status === "IN_REVIEW") continue;
    await db.closeException.updateMany({ where: { periodId: period.id, status: "OPEN" }, data: { status: "RESOLVED", resolution: "Accepted after review", resolvedBy: "Milkcrate specialist", resolvedAt: new Date() } });
    const signDay = addBusinessDays(lastDayOf(m), 2);
    const approveDay = isCurrent ? TODAY : addBusinessDays(lastDayOf(m), 3 + Math.floor(rand() * 2));
    const approved = status !== "SIGNED_OFF";
    await db.period.update({
      where: { id: period.id },
      data: {
        status,
        signedOffBy: "Milkcrate specialist",
        signedOffAt: new Date(`${isCurrent ? TODAY : signDay}T16:00:00Z`),
        approvedBy: approved ? spec.approver[0] : null,
        approvedAt: approved ? new Date(`${approveDay}T19:00:00Z`) : null,
        exportedAt: status === "EXPORTED" ? new Date(`${approveDay}T19:30:00Z`) : null,
      },
    });
    if (approved) await db.auditEvent.create({ data: { companyId: company.id, actor: spec.approver[0], action: "close.approved", detail: `Approved ${m} (due ${slaDueDate(m)})`, at: new Date(`${approveDay}T19:00:00Z`) } });
  }

  if (spec.injectIssues) {
    const pick = (n: string) => reps.find((r) => r.spec.name === n)!.row;
    await db.question.createMany({
      data: [
        { companyId: company.id, payeeId: pick("Liam Carter").id, text: "Why was my September check lower than August?", category: "explain", draft: "Your September payout was lower because you booked fewer deals in September than in August; your per-deal rate didn't change. Your statement lists each deal and its rate.", answer: "Your September payout was lower because you booked fewer deals in September than in August; your per-deal rate didn't change. Your statement lists each deal and its rate.", status: "SENT", model: "seed", answeredAt: new Date("2026-10-07T15:10:00Z"), answeredBy: "Plan Explainer (approved by specialist)", createdAt: new Date("2026-10-07T14:52:00Z") },
        { companyId: company.id, payeeId: pick("Chloe Nguyen").id, text: "My Pioneer Mfg renewal from Oct 30 isn't showing up. Can you check?", category: "missing_credit", draft: "I couldn't find a Pioneer Mfg deal owned by you that closed on Oct 30 in Salesforce. I've opened a ticket so a specialist can check with RevOps before the October close is approved.", status: "ESCALATED", model: "seed", createdAt: new Date("2026-11-02T16:20:00Z") },
      ],
    });
  }
}

async function main() {
  await db.auditEvent.deleteMany();
  await db.question.deleteMany();
  await db.payoutLine.deleteMany();
  await db.closeException.deleteMany();
  await db.period.deleteMany();
  await db.adjustment.deleteMany();
  await db.deal.deleteMany();
  await db.planVersion.deleteMany();
  await db.payee.updateMany({ data: { managerId: null } });
  await db.payee.deleteMany();
  await db.company.deleteMany();
  for (const c of companies) {
    await seedCompany(c);
    console.log(`Seeded ${c.name}`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
