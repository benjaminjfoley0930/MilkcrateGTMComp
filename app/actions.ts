"use server";

import Papa from "papaparse";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit, liveCalc, runClose, CLOSED_STATUSES } from "@/lib/close";
import { PLAN_TEMPLATES, addMonths, whatIf as engineWhatIf, type Month } from "@/lib/engine";
import { answerQuestion } from "@/lib/explainer";
import { actorName, clearSession, getSession, requireRole, setSession } from "@/lib/session";
import { currentMonth } from "@/lib/clock";

export async function signIn(formData: FormData) {
  const code = process.env.DEMO_ACCESS_CODE;
  if (code && formData.get("code") !== code) redirect("/?error=code");
  const kind = String(formData.get("kind"));
  const id = String(formData.get("id") ?? "");
  if (kind === "operator") {
    await setSession({ role: "operator", name: "Comp specialist" });
    redirect("/ops");
  }
  if (kind === "approver") {
    const c = await db.company.findUniqueOrThrow({ where: { id } });
    await setSession({ role: "leader", name: c.approverName, companyId: c.id, payeeId: null, approver: true });
    redirect("/leader");
  }
  const p = await db.payee.findUniqueOrThrow({ where: { id } });
  if (p.role === "MANAGER") {
    await setSession({ role: "leader", name: p.name, companyId: p.companyId, payeeId: p.id, approver: false });
    redirect("/leader");
  }
  await setSession({ role: "rep", name: p.name, companyId: p.companyId, payeeId: p.id });
  redirect("/rep");
}

export async function signOut() {
  await clearSession();
  redirect("/");
}

async function operatorPeriod(periodId: string) {
  const s = await requireRole("operator");
  const period = await db.period.findUniqueOrThrow({ where: { id: periodId }, include: { company: true } });
  return { s, period };
}

export async function startClose(companyId: string, month: Month) {
  const s = await requireRole("operator");
  const period = await db.period.upsert({ where: { companyId_month: { companyId, month } }, create: { companyId, month }, update: {} });
  await runClose(period.id, actorName(s));
  revalidatePath("/ops", "layout");
}

export async function recalculate(periodId: string) {
  const { s, period } = await operatorPeriod(periodId);
  const result = await runClose(periodId, actorName(s));
  const delta = Math.round((result.totals.payout - period.totalPayout) * 100) / 100;
  revalidatePath("/ops", "layout");
  redirect(`/ops/${period.company.slug}?month=${period.month}&recalc=${delta}&at=${Date.now()}`);
}

export async function resolveException(formData: FormData) {
  const s = await requireRole("operator");
  const id = String(formData.get("id"));
  const action = z.enum(["accept", "exclude", "reassign"]).parse(formData.get("action"));
  const note = String(formData.get("note") ?? "").trim();
  const ex = await db.closeException.findUniqueOrThrow({ where: { id }, include: { period: true } });
  if (CLOSED_STATUSES.includes(ex.period.status as never)) throw new Error("Period is locked");
  let resolution = note || "Accepted after review";
  if (action === "exclude" && ex.dealId) {
    await db.deal.update({ where: { id: ex.dealId }, data: { excluded: true } });
    resolution = `Deal excluded from comp${note ? `: ${note}` : ""}`;
  }
  if (action === "reassign" && ex.dealId) {
    const ownerId = String(formData.get("ownerId"));
    const owner = await db.payee.findFirstOrThrow({ where: { id: ownerId, companyId: ex.period.companyId } });
    await db.deal.update({ where: { id: ex.dealId }, data: { ownerId: owner.id } });
    resolution = `Reassigned to ${owner.name}${note ? `: ${note}` : ""}`;
  }
  await db.closeException.update({ where: { id }, data: { status: "RESOLVED", resolution, resolvedBy: actorName(s), resolvedAt: new Date() } });
  await audit(ex.period.companyId, actorName(s), "exception.resolved", `${ex.kind}: ${resolution}`, { exceptionId: id });
  if (action !== "accept") await runClose(ex.periodId, actorName(s));
  revalidatePath("/ops", "layout");
}

export async function signOff(periodId: string) {
  const { s, period } = await operatorPeriod(periodId);
  const open = await db.closeException.count({ where: { periodId, status: "OPEN" } });
  if (open > 0 || period.status !== "IN_REVIEW") throw new Error("Resolve all exceptions before signing off");
  await db.period.update({ where: { id: periodId }, data: { status: "SIGNED_OFF", signedOffBy: actorName(s), signedOffAt: new Date() } });
  await audit(period.companyId, actorName(s), "close.signed_off", `Specialist signed off ${period.month}`);
  revalidatePath("/ops", "layout");
}

export async function approveClose(periodId: string) {
  const s = await requireRole("leader");
  if (!s.approver) throw new Error("Only the named approver can approve a close");
  const period = await db.period.findUniqueOrThrow({ where: { id: periodId } });
  if (period.companyId !== s.companyId || period.status !== "SIGNED_OFF") throw new Error("Not ready for approval");
  await db.period.update({ where: { id: periodId }, data: { status: "APPROVED", approvedBy: s.name, approvedAt: new Date() } });
  await audit(period.companyId, s.name, "close.approved", `Approved ${period.month} payouts`);
  revalidatePath("/", "layout");
}

const adjustmentSchema = z.object({
  payeeId: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.coerce.number().refine((n) => n !== 0),
  type: z.enum(["SPIFF", "CLAWBACK", "CORRECTION"]),
  reason: z.string().min(3),
});

export async function createAdjustment(formData: FormData) {
  const s = await requireRole("operator", "leader");
  const data = adjustmentSchema.parse(Object.fromEntries(formData));
  const payee = await db.payee.findUniqueOrThrow({ where: { id: data.payeeId } });
  if (s.role === "leader" && payee.companyId !== s.companyId) throw new Error("Forbidden");
  if (s.role === "leader" && !s.approver && payee.managerId !== s.payeeId) throw new Error("Managers can only request adjustments for their own team");
  await db.adjustment.create({ data: { ...data, companyId: payee.companyId, approved: false, createdBy: actorName(s) } });
  await audit(payee.companyId, actorName(s), "adjustment.requested", `${data.type} ${data.amount} for ${payee.name}: ${data.reason}`);
  revalidatePath("/", "layout");
}

export async function approveAdjustment(id: string) {
  const s = await requireRole("leader");
  if (!s.approver) throw new Error("Only the named approver can approve adjustments");
  const adj = await db.adjustment.findUniqueOrThrow({ where: { id }, include: { payee: true } });
  if (adj.companyId !== s.companyId) throw new Error("Forbidden");
  // A month that's already approved is locked, so the adjustment moves to the first open close.
  let month = adj.month;
  for (;;) {
    const p = await db.period.findUnique({ where: { companyId_month: { companyId: adj.companyId, month } } });
    if (!p || !CLOSED_STATUSES.includes(p.status as never)) break;
    month = addMonths(month, 1);
  }
  await db.adjustment.update({ where: { id }, data: { approved: true, month } });
  await audit(adj.companyId, s.name, "adjustment.approved", `${adj.type} ${adj.amount} for ${adj.payee.name}${month !== adj.month ? ` (moved from ${adj.month} to ${month}, which is still open)` : ""}`);
  const period = await db.period.findUnique({ where: { companyId_month: { companyId: adj.companyId, month } } });
  if (period && !CLOSED_STATUSES.includes(period.status as never) && period.status !== "OPEN") await runClose(period.id, "Calculator agent");
  revalidatePath("/", "layout");
}

export type AskState = { status?: "SENT" | "DRAFT" | "ESCALATED"; error?: string; at?: number };

export async function askQuestion(_prev: AskState, formData: FormData): Promise<AskState> {
  const s = await requireRole("rep");
  const text = String(formData.get("text") ?? "").trim();
  if (text.length < 3) return { error: "Type a question first" };
  const company = await db.company.findUniqueOrThrow({ where: { id: s.companyId } });
  const { category, answer, model } = await answerQuestion(s.payeeId, text, currentMonth());
  const escalate = category === "missing_credit" || category === "policy";
  const status = escalate ? "ESCALATED" : company.autoSendAnswers ? "SENT" : "DRAFT";
  await db.question.create({
    data: { companyId: s.companyId, payeeId: s.payeeId, text, category, draft: answer, answer: status === "SENT" || escalate ? answer : null, status, model, answeredAt: status === "SENT" ? new Date() : null, answeredBy: status === "SENT" ? "Plan Explainer (auto-sent)" : null },
  });
  revalidatePath("/", "layout");
  return { status, at: Date.now() };
}

export async function sendAnswer(formData: FormData) {
  const s = await requireRole("operator");
  const id = String(formData.get("id"));
  const answer = String(formData.get("answer") ?? "").trim();
  const final = formData.get("final") === "1";
  const q = await db.question.findUniqueOrThrow({ where: { id } });
  await db.question.update({ where: { id }, data: { answer, status: final ? "RESOLVED" : "SENT", answeredAt: new Date(), answeredBy: actorName(s) } });
  await audit(q.companyId, actorName(s), final ? "question.resolved" : "question.answered", q.text.slice(0, 120));
  revalidatePath("/", "layout");
}

export async function toggleAutoSend(companyId: string) {
  const s = await requireRole("operator");
  const c = await db.company.findUniqueOrThrow({ where: { id: companyId } });
  await db.company.update({ where: { id: companyId }, data: { autoSendAnswers: !c.autoSendAnswers } });
  await audit(companyId, actorName(s), "settings.auto_send", `Auto-send explain and what-if answers: ${!c.autoSendAnswers ? "on" : "off"}`);
  revalidatePath("/ops", "layout");
}

export async function adoptTemplate(formData: FormData) {
  const s = await requireRole("operator");
  const companyId = String(formData.get("companyId"));
  const template = z.enum(Object.keys(PLAN_TEMPLATES) as [string, ...string[]]).parse(formData.get("template"));
  const effectiveFrom = z.string().regex(/^\d{4}-\d{2}-01$/).parse(formData.get("effectiveFrom"));
  const last = await db.planVersion.findFirst({ where: { companyId }, orderBy: { version: "desc" } });
  const version = (last?.version ?? 0) + 1;
  await db.planVersion.create({ data: { companyId, version, template, effectiveFrom, config: PLAN_TEMPLATES[template].config } });
  await audit(companyId, actorName(s), "plan.version_created", `Plan v${version} (${PLAN_TEMPLATES[template].label}) effective ${effectiveFrom}`);
  revalidatePath("/ops", "layout");
}

export async function importDealsCsv(formData: FormData) {
  const s = await requireRole("operator");
  const companyId = String(formData.get("companyId"));
  const file = formData.get("file");
  const text = file instanceof File ? await file.text() : String(formData.get("csv") ?? "");
  const parsed = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase() });
  const payees = await db.payee.findMany({ where: { companyId } });
  const findOwner = (label: string) => {
    const l = label.trim().toLowerCase();
    return payees.find((p) => p.name.toLowerCase() === l || p.email.toLowerCase() === l || p.externalId.toLowerCase() === l);
  };
  const col = (r: Record<string, string>, ...names: string[]) => names.map((n) => r[n]).find((v) => v !== undefined && v !== "") ?? "";
  let imported = 0;
  let unmatched = 0;
  for (const r of parsed.data) {
    const externalId = col(r, "opportunity id", "id", "deal id", "record id");
    const amount = Number(col(r, "amount", "arr", "new arr").replace(/[$,]/g, ""));
    const closeDate = col(r, "close date", "closedate", "closed date");
    if (!externalId || !Number.isFinite(amount) || !/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) continue;
    const ownerLabel = col(r, "owner", "opportunity owner", "deal owner", "owner email");
    const owner = findOwner(ownerLabel);
    if (!owner) unmatched++;
    const term = Number(col(r, "term months", "term", "contract term")) || null;
    const stageRaw = col(r, "stage", "forecast category").toLowerCase();
    const stage = stageRaw.includes("commit") ? "commit" : stageRaw.includes("best") ? "best_case" : "closed_won";
    const measure = col(r, "measure", "type").toLowerCase().includes("usage") ? "usage_revenue" : "new_arr";
    const data = { stage, measure, name: col(r, "name", "opportunity name", "deal name") || externalId, account: col(r, "account", "account name", "company") || "Unknown", ownerId: owner?.id ?? null, ownerLabel, amount, closeDate, termMonths: term, source: "csv" };
    const existing = await db.deal.findFirst({ where: { companyId, externalId } });
    if (existing) await db.deal.update({ where: { id: existing.id }, data });
    else await db.deal.create({ data: { ...data, companyId, externalId } });
    imported++;
  }
  await audit(companyId, actorName(s), "data.csv_import", `Imported ${imported} deals from CSV (${unmatched} with unmatched owners)`);
  // Closes in progress must reflect the new data before anyone can sign off or approve.
  const inProgress = await db.period.findMany({ where: { companyId, status: { in: ["IN_REVIEW", "SIGNED_OFF"] } } });
  for (const p of inProgress) await runClose(p.id, "Calculator agent");
  revalidatePath("/ops", "layout");
  redirect(`/ops/${(await db.company.findUniqueOrThrow({ where: { id: companyId } })).slug}/data?imported=${imported}&unmatched=${unmatched}`);
}

export type WhatIfState = { amount?: number; term?: number; extra?: number; before?: number; after?: number; lines?: { description: string; amount: number }[]; error?: string };

export async function runWhatIf(_prev: WhatIfState, formData: FormData): Promise<WhatIfState> {
  const s = await getSession();
  if (!s || s.role !== "rep") return { error: "Sign in as a rep" };
  const amount = Number(String(formData.get("amount")).replace(/[$,]/g, ""));
  const term = Number(formData.get("term") || 12);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter a deal amount" };
  const { input } = await liveCalc(s.companyId, currentMonth());
  const r = engineWhatIf(input, s.payeeId, amount, term);
  return { amount, term, extra: r.extraPayout, before: r.attainmentBefore, after: r.attainmentAfter, lines: r.lines.map((l) => ({ description: l.description, amount: l.amount })) };
}
