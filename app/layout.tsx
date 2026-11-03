import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getSession } from "@/lib/session";
import { signOut } from "./actions";

export const metadata: Metadata = {
  title: "Milkcrate",
  description: "Sales comp, run for you.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const s = await getSession();
  const home = !s ? "/" : s.role === "operator" ? "/ops" : s.role === "leader" ? "/leader" : "/rep";
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
            <Link href={home} className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="inline-block h-5 w-5 rounded-sm border-2 border-stone-900" />
              Milkcrate
            </Link>
            {s && (
              <div className="flex items-center gap-3 text-sm text-stone-600">
                <span>
                  {s.name}
                  <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
                    {s.role === "operator" ? "Milkcrate specialist" : s.role === "leader" ? (s.approver ? "Approver" : "Sales leader") : "Rep"}
                  </span>
                </span>
                <form action={signOut}>
                  <button className="text-stone-500 hover:text-stone-900">Switch user</button>
                </form>
              </div>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
