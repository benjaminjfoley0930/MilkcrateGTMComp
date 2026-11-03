import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { liveCalc } from "./close";
import { describeTiers, monthLabel, whatIf, type Month } from "./engine";
import { pct, usd } from "./format";

export type Category = "explain" | "what_if" | "missing_credit" | "policy";

export function classify(text: string): Category {
  const t = text.toLowerCase();
  if (/(what if|if i close|would i (get|make|earn)|how much (would|will) i)/.test(t)) return "what_if";
  if (/(missing|not showing|isn't showing|don't see|can't find|wrong|incorrect|dispute|didn't get credit|not credited)/.test(t)) return "missing_credit";
  if (/(exception|split|special approval|can i get paid on|override the|policy)/.test(t)) return "policy";
  return "explain";
}

export function extractAmount(text: string): number | null {
  const m = text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|K)?|(\d[\d,]*(?:\.\d+)?)\s*(k|K)\b/);
  if (!m) return null;
  const num = Number((m[1] ?? m[3]).replace(/,/g, ""));
  const k = m[2] ?? m[4];
  return k ? num * 1000 : num;
}

async function repContext(payeeId: string, month: Month) {
  const payee = await db.payee.findUniqueOrThrow({ where: { id: payeeId }, include: { company: true } });
  const { input, result } = await liveCalc(payee.companyId, month);
  const summary = result.summaries.find((s) => s.payeeId === payeeId);
  const lines = result.lines.filter((l) => l.payeeId === payeeId);
  const lastClosed = await db.period.findFirst({
    where: { companyId: payee.companyId, status: { in: ["APPROVED", "EXPORTED"] } },
    orderBy: { month: "desc" },
    include: { lines: { where: { payeeId } } },
  });
  const previous = lastClosed
    ? await db.period.findFirst({ where: { companyId: payee.companyId, month: { lt: lastClosed.month }, status: { in: ["APPROVED", "EXPORTED"] } }, orderBy: { month: "desc" }, include: { lines: { where: { payeeId } } } })
    : null;
  const pending = await db.period.findFirst({
    where: { companyId: payee.companyId, status: { in: ["IN_REVIEW", "SIGNED_OFF"] } },
    orderBy: { month: "desc" },
    include: { lines: { where: { payeeId } } },
  });
  return { payee, input, summary, lines, lastClosed, previous, pending };
}

function sum(lines: { amount: number }[]) {
  return lines.reduce((s, l) => s + l.amount, 0);
}

export async function answerQuestion(payeeId: string, text: string, month: Month) {
  const ctx = await repContext(payeeId, month);
  let category = classify(text);
  const amount = extractAmount(text);
  const wi = category === "what_if" && amount ? whatIf(ctx.input, payeeId, amount) : null;
  const tiers = describeTiers(ctx.input.plan);
  const s = ctx.summary;
  const facts = {
    rep: ctx.payee.name,
    month: monthLabel(month),
    quarter: s?.quarter,
    quotaThisQuarter: s ? usd(s.quota) : null,
    bookedThisQuarter: s ? usd(s.bookingsQtd) : null,
    attainment: s ? pct(s.attainment) : null,
    currentMultiplier: s?.currentMultiplier,
    earnedThisMonthSoFar: usd(sum(ctx.lines)),
    thisMonthLines: ctx.lines.map((l) => `${l.type}: ${l.description} = ${usd(l.amount, true)}`),
    lastStatement: ctx.lastClosed ? { month: monthLabel(ctx.lastClosed.month), total: usd(sum(ctx.lastClosed.lines), true), lines: ctx.lastClosed.lines.map((l) => `${l.type}: ${l.description} = ${usd(l.amount, true)}`) } : null,
    pendingStatement: ctx.pending ? { month: monthLabel(ctx.pending.month), status: "preliminary, still being reviewed and not yet approved", total: usd(sum(ctx.pending.lines), true), dealCount: ctx.pending.lines.filter((l) => l.type === "COMMISSION").length, lines: ctx.pending.lines.map((l) => `${l.type}: ${l.description} = ${usd(l.amount, true)}`) } : null,
    lastStatementDealCount: ctx.lastClosed ? ctx.lastClosed.lines.filter((l) => l.type === "COMMISSION").length : null,
    statementBefore: ctx.previous ? { month: monthLabel(ctx.previous.month), total: usd(sum(ctx.previous.lines), true), dealCount: ctx.previous.lines.filter((l) => l.type === "COMMISSION").length } : null,
    planTiers: tiers,
    kickers: ctx.input.plan.kickers.map((k) => `${k.label}: +${Math.round(k.bonusPct * 100)}% of commission on deals with ${k.minTermMonths}+ month terms`),
    whatIf: wi ? { dealAmount: usd(amount!), extraPayout: usd(wi.extraPayout, true), earnedThisMonthIncludingDeal: usd(sum(ctx.lines) + wi.extraPayout, true), bookedThisQuarterIncludingDeal: s ? usd(s.bookingsQtd + amount!) : null, attainmentBefore: pct(wi.attainmentBefore), attainmentAfter: pct(wi.attainmentAfter), breakdown: wi.lines.map((l) => `${l.type}: ${l.description} = ${usd(l.amount, true)}`) } : null,
  };

  let answer = fallbackAnswer(category, facts, ctx.payee.company.crm, amount);
  let model = "rules";
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic();
      const res = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: 1500,
        system:
          "You are Milkcrate's Plan Explainer, answering a sales rep's question about their commission. Every dollar amount or percentage you write must appear verbatim in FACTS: never add, subtract, estimate or derive a new number. If the rep asks about a month whose statement is in pendingStatement, say it is preliminary and not yet approved. Never promise a payout change. For a missing deal, wrong number or policy exception, tell the rep a ticket is open and a Milkcrate specialist will reply here before the close is approved; don't ask them to contact anyone. Be brief, warm and specific: under 120 words, plain text with no markdown. Always send your reply by calling the reply tool exactly once. Use category what_if only if FACTS.whatIf is present; if the rep asked a what-if without an amount, ask for the deal size.",
        tools: [
          {
            name: "reply",
            description: "Send the reply to the rep",
            input_schema: {
              type: "object",
              properties: {
                category: { type: "string", enum: ["explain", "what_if", "missing_credit", "policy"] },
                answer: { type: "string", description: "Plain-text reply to the rep" },
              },
              required: ["category", "answer"],
            },
          },
        ],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: `QUESTION: ${text}\n\nFACTS:\n${JSON.stringify(facts, null, 2)}` }],
      });
      const block = res.content.find((c) => c.type === "tool_use");
      let parsed = (block && block.type === "tool_use" ? block.input : {}) as { category?: Category; answer?: string };
      if (!parsed.answer) {
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        const m = text.match(/\{[\s\S]*?"answer"\s*:\s*"(?:[^"\\]|\\.)*"[\s\S]*?\}/);
        if (m) {
          try {
            parsed = JSON.parse(m[0]);
          } catch {
            parsed = {};
          }
        }
      }
      if (parsed.answer && parsed.category) {
        answer = parsed.answer;
        if (["explain", "what_if", "missing_credit", "policy"].includes(parsed.category) && !(parsed.category === "what_if" && !wi)) category = parsed.category;
        model = res.model;
      }
    } catch (e) {
      console.error("Plan Explainer LLM call failed; using rules fallback", e);
    }
  }
  return { category, answer, model };
}

type Facts = Record<string, unknown> & {
  quarter?: string;
  quotaThisQuarter: string | null;
  bookedThisQuarter: string | null;
  attainment: string | null;
  currentMultiplier?: number;
  earnedThisMonthSoFar: string;
  thisMonthLines: string[];
  lastStatement: { month: string; total: string; lines: string[] } | null;
  pendingStatement: { month: string; total: string } | null;
  statementBefore: { month: string; total: string; dealCount: number } | null;
  planTiers: string[];
  whatIf: { dealAmount: string; extraPayout: string; attainmentBefore: string; attainmentAfter: string; breakdown: string[] } | null;
  month: string;
};

function fallbackAnswer(category: Category, f: Facts, crm: string, amount: number | null): string {
  if (category === "what_if") {
    if (!f.whatIf) return "Happy to run that. How big is the deal (for example, $40K) and what's the contract term?";
    return `If you close a ${f.whatIf.dealAmount} deal this month, you'd earn ${f.whatIf.extraPayout} more, taking you from ${f.whatIf.attainmentBefore} to ${f.whatIf.attainmentAfter} of quota for ${f.quarter}.\n\nHow it's calculated: ${f.whatIf.breakdown.join("; ")}.`;
  }
  if (category === "missing_credit") {
    return `Thanks for flagging this. I've opened a ticket, and a comp specialist will check ${crm} and get back to you before the ${f.lastStatement ? "next" : "current"} close is approved. Nothing changes on your payout until a specialist confirms it.\n\nDeals currently credited to you in ${f.month}: ${f.thisMonthLines.length ? f.thisMonthLines.filter((l) => l.startsWith("COMMISSION")).map((l) => l.replace("COMMISSION: ", "").split(":")[0]).join(", ") : "none yet"}.`;
  }
  if (category === "policy") {
    return "That needs a decision from your sales leader, so I've routed it to them and to your Milkcrate specialist. You'll hear back here.";
  }
  const parts = [
    `For ${f.quarter} you've booked ${f.bookedThisQuarter} against a ${f.quotaThisQuarter} quota (${f.attainment}), so new bookings currently pay ${f.currentMultiplier}x your base rate.`,
    `So far in ${f.month} you've earned ${f.earnedThisMonthSoFar}.`,
  ];
  if (f.pendingStatement && f.lastStatement) {
    parts.push(`Your ${f.pendingStatement.month} statement is preliminary (still in review): ${f.pendingStatement.total}, compared with ${f.lastStatement.total} for ${f.lastStatement.month}. Payouts follow the deals closed in each month; open the preview to see every deal and rate.`);
  } else if (f.lastStatement && f.statementBefore) {
    parts.push(`Your ${f.lastStatement.month} statement paid ${f.lastStatement.total}, compared with ${f.statementBefore.total} in ${f.statementBefore.month}. Payouts follow the deals closed in each month, and your statement lists every deal with its rate.`);
  }
  parts.push(`Your plan: ${f.planTiers.join("; ")}.`);
  void amount;
  return parts.join(" ");
}
