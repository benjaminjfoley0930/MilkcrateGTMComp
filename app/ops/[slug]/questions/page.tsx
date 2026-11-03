import { db } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { companyBySlug } from "@/lib/queries";
import { dateLabel } from "@/lib/format";
import { Badge, Button, Card, PageTitle, StatusBadge } from "@/components/ui";
import { sendAnswer, toggleAutoSend } from "@/app/actions";
import { CompanyNav } from "../nav";

const CAT: Record<string, string> = { explain: "Explain", what_if: "What-if", missing_credit: "Missing credit", policy: "Policy exception" };

export default async function QuestionsPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireRole("operator");
  const { slug } = await params;
  const company = await companyBySlug(slug);
  const questions = await db.question.findMany({ where: { companyId: company.id }, include: { payee: true }, orderBy: { createdAt: "desc" } });
  const waiting = questions.filter((q) => q.status === "DRAFT" || q.status === "ESCALATED");
  const done = questions.filter((q) => q.status === "SENT" || q.status === "RESOLVED");
  const auto = done.filter((q) => q.answeredBy?.includes("auto")).length;
  return (
    <div className="space-y-6">
      <PageTitle title={company.name} sub="Questions reps asked the Plan Explainer in the portal and Slack" />
      <CompanyNav slug={slug} active="questions" />
      <Card title="Answer policy" action={
        <form action={toggleAutoSend.bind(null, company.id)}>
          <Button variant="secondary">{company.autoSendAnswers ? "Turn off auto-send" : "Turn on auto-send"}</Button>
        </form>
      }>
        <p className="text-sm text-stone-700">
          {company.autoSendAnswers
            ? "Explain and what-if answers go to reps right away. Missing-credit and policy questions always come to a specialist."
            : "Every answer waits for a specialist to review it before the rep sees it. Turn on auto-send once answers have proven accurate."}{" "}
          {done.length > 0 && `${auto} of ${done.length} answered questions were auto-sent.`}
        </p>
      </Card>
      <Card title={`Waiting on a specialist (${waiting.length})`}>
        {waiting.length === 0 && <p className="text-sm text-stone-600">Nothing waiting.</p>}
        <ul className="space-y-4">
          {waiting.map((q) => (
            <li key={q.id} className="rounded-md border border-stone-200 p-3">
              <div className="flex items-center gap-2 text-xs text-stone-600">
                <StatusBadge status={q.status} /><Badge>{CAT[q.category] ?? q.category}</Badge>
                <span>{q.payee.name} · {dateLabel(q.createdAt)} · drafted by {q.model === "rules" ? "rules engine" : q.model}</span>
              </div>
              <p className="mt-2 text-sm font-medium">&ldquo;{q.text}&rdquo;</p>
              <form action={sendAnswer} className="mt-2 space-y-2">
                <input type="hidden" name="id" value={q.id} />
                <textarea name="answer" defaultValue={q.status === "ESCALATED" ? "" : q.draft} placeholder={q.status === "ESCALATED" ? `Bot's holding reply to the rep: "${q.draft.slice(0, 140)}..." Write the resolution here.` : ""} rows={4} className="w-full rounded-md border border-stone-300 p-2 text-sm" required />
                <div className="flex gap-2">
                  {q.status === "DRAFT" && <Button name="final" value="0">Approve and send</Button>}
                  {q.status === "ESCALATED" && <Button name="final" value="1">Send resolution</Button>}
                </div>
              </form>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={`Answered (${done.length})`}>
        <ul className="divide-y divide-stone-100">
          {done.map((q) => (
            <li key={q.id} className="py-3 text-sm">
              <div className="text-xs text-stone-600">{q.payee.name} · {dateLabel(q.createdAt)} · <Badge>{CAT[q.category] ?? q.category}</Badge> · {q.answeredBy}</div>
              <p className="mt-1 font-medium">&ldquo;{q.text}&rdquo;</p>
              <p className="mt-1 whitespace-pre-line text-stone-700">{q.answer}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
