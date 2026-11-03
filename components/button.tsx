"use client";

import { useFormStatus } from "react-dom";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger"; pendingText?: string };

export function Button({ children, variant = "primary", pendingText = "Working…", ...rest }: Props) {
  const { pending } = useFormStatus();
  const v =
    variant === "primary"
      ? "bg-stone-900 text-white hover:bg-stone-700 disabled:bg-stone-400"
      : variant === "danger"
        ? "border border-red-200 bg-white text-red-700 hover:bg-red-50"
        : "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 disabled:text-stone-500";
  return (
    <button {...rest} disabled={rest.disabled || pending} className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${v} ${rest.className ?? ""}`}>
      {pending ? pendingText : children}
    </button>
  );
}
