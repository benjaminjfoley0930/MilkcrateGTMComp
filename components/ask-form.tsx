"use client";

import { useActionState } from "react";
import { askQuestion, type AskState } from "@/app/actions";
import { Button } from "./button";

const MESSAGES: Record<string, string> = {
  SENT: "Answered. See your reply below.",
  DRAFT: "Drafted. A Milkcrate specialist checks it before it's sent to you, usually within the hour.",
  ESCALATED: "Ticket opened. A Milkcrate specialist will look into it and reply here before the close is approved.",
};

export function AskForm() {
  const [state, action] = useActionState<AskState, FormData>(askQuestion, {});
  return (
    <form action={action} className="space-y-2">
      <textarea name="text" rows={3} required placeholder='e.g. "Why was my last check lower?" or "What if I close Acme at $40K?"' className="w-full rounded-md border border-stone-300 p-2 text-sm" />
      <div className="flex items-center gap-3">
        <Button pendingText="Looking at your numbers…">Ask</Button>
        {state.error && <span className="text-sm text-red-700">{state.error}</span>}
        {state.status && <span key={state.at} className="text-sm text-stone-700">{MESSAGES[state.status]}</span>}
      </div>
    </form>
  );
}
