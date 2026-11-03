"use client";

import { useActionState } from "react";
import { runWhatIf, type WhatIfState } from "@/app/actions";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function WhatIf() {
  const [state, action, pending] = useActionState<WhatIfState, FormData>(runWhatIf, {});
  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-stone-600">Deal size (new ARR)</span>
          <input name="amount" inputMode="decimal" placeholder="40,000" defaultValue={state.amount ?? ""} className="w-32 rounded-md border border-stone-300 px-2 py-1.5" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-stone-600">Term</span>
          <select name="term" defaultValue={String(state.term ?? 12)} className="rounded-md border border-stone-300 px-2 py-1.5">
            <option value="12">12 months</option>
            <option value="24">24 months</option>
            <option value="36">36 months</option>
          </select>
        </label>
        <button disabled={pending} className="rounded-md bg-stone-900 px-3 py-1.5 font-medium text-white hover:bg-stone-700 disabled:bg-stone-400">
          {pending ? "Calculating" : "Calculate"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      {state.extra !== undefined && (
        <div className="rounded-md bg-stone-50 p-3 text-sm">
          <div>
            Closing a {usd(state.amount!)} deal this month pays you <span className="font-semibold">{usd(state.extra)}</span> more, taking you from {(state.before! * 100).toFixed(0)}% to {(state.after! * 100).toFixed(0)}% of quota.
          </div>
          <ul className="mt-2 list-disc pl-5 text-xs text-stone-700">
            {state.lines?.map((l, i) => <li key={i}>{l.description}: {usd(l.amount)}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
