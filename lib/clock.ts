import { monthOf } from "./engine";

/** The prototype's "today". Set DEMO_TODAY to pin the demo to the seeded data. */
export function today(): string {
  return process.env.DEMO_TODAY || new Date().toISOString().slice(0, 10);
}

export function currentMonth() {
  return monthOf(today());
}
