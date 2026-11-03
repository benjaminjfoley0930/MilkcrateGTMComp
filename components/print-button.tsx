"use client";

export function PrintButton() {
  return (
    <button onClick={() => window.print()} className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-50">
      Print or save as PDF
    </button>
  );
}
