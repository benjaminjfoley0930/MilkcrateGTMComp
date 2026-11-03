import { z } from "zod";

export const tierSchema = z.object({
  upTo: z.number().positive().nullable(),
  multiplier: z.number().min(0),
});

export const kickerSchema = z.object({
  id: z.string(),
  label: z.string(),
  minTermMonths: z.number().int().positive(),
  bonusPct: z.number().min(0).max(1),
});

export const planSchema = z
  .object({
    name: z.string().min(1),
    measure: z.literal("new_arr"),
    quotaPeriod: z.literal("quarter"),
    payoutFrequency: z.literal("month"),
    tiers: z.array(tierSchema).min(1),
    capAttainment: z.number().positive().nullable(),
    kickers: z.array(kickerSchema),
    ramp: z.array(z.number().min(0).max(1)),
    managerOverride: z.object({ enabled: z.boolean() }),
    clawbackDays: z.number().int().min(0),
    checks: z.object({
      largeDealMultiple: z.number().positive(),
      payoutSpikeMultiple: z.number().positive(),
    }),
  })
  .superRefine((plan, ctx) => {
    const last = plan.tiers[plan.tiers.length - 1];
    if (last.upTo !== null) ctx.addIssue({ code: "custom", message: "The last tier must have upTo: null" });
    for (let i = 1; i < plan.tiers.length; i++) {
      const prev = plan.tiers[i - 1].upTo;
      const cur = plan.tiers[i].upTo;
      if (prev === null || (cur !== null && cur <= prev)) {
        ctx.addIssue({ code: "custom", message: "Tier upTo values must increase" });
      }
    }
  });

export type PlanConfig = z.infer<typeof planSchema>;

const baseChecks = { largeDealMultiple: 4, payoutSpikeMultiple: 2.5 };

export const PLAN_TEMPLATES: Record<string, { label: string; summary: string; config: PlanConfig }> = {
  standard: {
    label: "Standard AE",
    summary: "1x to quota, 1.5x to 125%, 2x above. Uncapped. 3-month ramp. Multi-year kicker.",
    config: {
      name: "Standard AE plan",
      measure: "new_arr",
      quotaPeriod: "quarter",
      payoutFrequency: "month",
      tiers: [
        { upTo: 1, multiplier: 1 },
        { upTo: 1.25, multiplier: 1.5 },
        { upTo: null, multiplier: 2 },
      ],
      capAttainment: null,
      kickers: [{ id: "multi_year", label: "Multi-year kicker", minTermMonths: 24, bonusPct: 0.1 }],
      ramp: [0.33, 0.66],
      managerOverride: { enabled: true },
      clawbackDays: 90,
      checks: baseChecks,
    },
  },
  steep: {
    label: "Steep accelerators",
    summary: "0.8x to 50%, 1x to quota, 2x above. Rewards top performers, pays less below quota.",
    config: {
      name: "Steep accelerator AE plan",
      measure: "new_arr",
      quotaPeriod: "quarter",
      payoutFrequency: "month",
      tiers: [
        { upTo: 0.5, multiplier: 0.8 },
        { upTo: 1, multiplier: 1.2 },
        { upTo: null, multiplier: 2 },
      ],
      capAttainment: null,
      kickers: [],
      ramp: [0.33, 0.66],
      managerOverride: { enabled: true },
      clawbackDays: 90,
      checks: baseChecks,
    },
  },
  capped: {
    label: "Flat and capped",
    summary: "1x to quota, 1.25x above, capped at 200%. Most predictable cost.",
    config: {
      name: "Flat capped AE plan",
      measure: "new_arr",
      quotaPeriod: "quarter",
      payoutFrequency: "month",
      tiers: [
        { upTo: 1, multiplier: 1 },
        { upTo: null, multiplier: 1.25 },
      ],
      capAttainment: 2,
      kickers: [],
      ramp: [0.33, 0.66],
      managerOverride: { enabled: true },
      clawbackDays: 90,
      checks: baseChecks,
    },
  },
};

export function describeTiers(plan: PlanConfig): string[] {
  let from = 0;
  return plan.tiers.map((t) => {
    const label =
      t.upTo === null
        ? `Above ${Math.round(from * 100)}% of quota: ${t.multiplier}x`
        : `${Math.round(from * 100)}% to ${Math.round(t.upTo * 100)}% of quota: ${t.multiplier}x`;
    from = t.upTo ?? from;
    return label;
  });
}
