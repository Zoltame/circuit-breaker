import { parse as parseYaml } from "yaml";
import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (00:00–23:59, UTC)");

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const pct = z.number().positive().max(100);

export const PolicySchema = z
  .object({
    version: z.literal(1),
    killSwitch: z.boolean().default(false).describe("Rule 1: when true, every order is blocked"),
    allowedAssets: z.array(z.string().min(1)).min(1).describe("Rule 2: tradable asset symbols"),
    maxOrderPct: pct.describe("Rule 3: max order notional, % of equity"),
    maxExposurePct: pct.describe("Rule 4: max exposure per asset after the order (incl. leverage), % of equity"),
    maxLeverage: z.number().min(1).describe("Rule 5: max leverage, x"),
    maxDailyLossPct: pct.describe("Rule 6: at this loss since UTC day start, new orders are blocked"),
    maxDrawdownPct: pct.describe("Rule 7: at this drawdown from peak, the kill-switch is activated"),
    maxOrdersPerHour: z.number().int().positive().describe("Rule 8: max allowed orders in any rolling hour"),
    maxSlippageBps: z.number().nonnegative().describe("Rule 9: max quote cost (in vs out USD), basis points"),
    tradingWindowsUtc: z
      .array(
        z
          .object({
            days: z.array(z.enum(DAYS)).min(1).optional(),
            start: hhmm,
            end: hhmm,
          })
          .strict(),
      )
      .default([])
      .describe("Rule 10: allowed UTC windows, start inclusive, end exclusive; empty = always"),
  })
  .strict();

export type Policy = z.output<typeof PolicySchema>;

export function parsePolicy(input: unknown): Policy {
  const res = PolicySchema.safeParse(input);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid policy:\n  ${lines.join("\n  ")}`);
  }
  return res.data;
}

export function loadPolicyYaml(text: string): Policy {
  return parsePolicy(parseYaml(text));
}

export function policyJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PolicySchema, { io: "input" }) as Record<string, unknown>;
}
