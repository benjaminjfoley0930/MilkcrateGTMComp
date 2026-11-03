import Link from "next/link";
import type { ReactNode } from "react";

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-stone-200 bg-white ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  const toneClass = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-stone-900";
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-4 py-3">
      <div className="text-xs font-medium text-stone-600">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-stone-600">{sub}</div>}
    </div>
  );
}

const badgeTones = {
  gray: "bg-stone-100 text-stone-700",
  green: "bg-emerald-50 text-emerald-700",
  red: "bg-red-50 text-red-700",
  amber: "bg-amber-50 text-amber-800",
  blue: "bg-sky-50 text-sky-700",
};

export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: keyof typeof badgeTones }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${badgeTones[tone]}`}>{children}</span>;
}

export const STATUS_TONE: Record<string, keyof typeof badgeTones> = {
  OPEN: "gray",
  IN_REVIEW: "amber",
  SIGNED_OFF: "blue",
  APPROVED: "green",
  EXPORTED: "green",
  DRAFT: "amber",
  SENT: "green",
  ESCALATED: "red",
  RESOLVED: "gray",
};

export const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  IN_REVIEW: "In review",
  SIGNED_OFF: "Awaiting customer approval",
  APPROVED: "Approved",
  EXPORTED: "File delivered",
  DRAFT: "Draft, awaiting review",
  SENT: "Answered",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "gray"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export { Button } from "./button";

export function Th({ children, right }: { children?: ReactNode; right?: boolean }) {
  return <th className={`border-b border-stone-200 px-3 py-2 text-xs font-medium text-stone-600 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

export function Td({ children, right, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <td className={`border-b border-stone-100 px-3 py-2 align-top ${right ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>;
}

export function Bar({ value, max = 1.5 }: { value: number; max?: number }) {
  const w = Math.min(100, (value / max) * 100);
  const quotaMark = (1 / max) * 100;
  const color = value >= 1 ? "bg-emerald-600" : value >= 0.7 ? "bg-sky-600" : "bg-amber-500";
  return (
    <div className="relative h-2 w-full min-w-24 rounded bg-stone-100">
      <div className={`h-2 rounded ${color}`} style={{ width: `${w}%` }} />
      <div className="absolute top-[-2px] h-3 w-px bg-stone-500" style={{ left: `${quotaMark}%` }} />
    </div>
  );
}

export function SubNav({ items, active }: { items: { href: string; label: string }[]; active: string }) {
  return (
    <nav className="flex gap-1 border-b border-stone-200">
      {items.map((i) => (
        <Link key={i.href} href={i.href} className={`-mb-px border-b-2 px-3 py-2 text-sm ${i.href === active ? "border-stone-900 font-medium text-stone-900" : "border-transparent text-stone-600 hover:text-stone-800"}`}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function PageTitle({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">{title}</h1>
        {sub && <p className="mt-1 text-sm text-stone-600">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
