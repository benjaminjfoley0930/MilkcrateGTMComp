import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { redirect } from "next/navigation";

export type Session =
  | { role: "operator"; name: string }
  | { role: "leader"; name: string; companyId: string; payeeId: string | null; approver: boolean }
  | { role: "rep"; name: string; companyId: string; payeeId: string };

const COOKIE = "mc_session";

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export async function setSession(s: Session) {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
}

export async function clearSession() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
  } catch {
    return null;
  }
}

export async function requireRole<R extends Session["role"]>(...roles: R[]): Promise<Extract<Session, { role: R }>> {
  const s = await getSession();
  if (!s || !roles.includes(s.role as R)) redirect("/");
  if (s.role !== "operator") {
    const { db } = await import("./db");
    const exists = s.payeeId
      ? await db.payee.count({ where: { id: s.payeeId, companyId: s.companyId } })
      : await db.company.count({ where: { id: s.companyId } });
    if (!exists) redirect("/?expired=1");
  }
  return s as Extract<Session, { role: R }>;
}

export function actorName(s: Session) {
  return s.role === "operator" ? `${s.name} (Milkcrate)` : s.name;
}
