import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPolicyYaml, parsePolicy, policyJsonSchema } from "../src/policy.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("policy config", () => {
  it("loads and validates policies/default.yaml", () => {
    const policy = loadPolicyYaml(readFileSync(`${root}policies/default.yaml`, "utf8"));
    expect(policy.version).toBe(1);
    expect(policy.allowedAssets.length).toBeGreaterThan(0);
  });

  it("loads and validates policies/swarm.yaml with its per-agent budgets", () => {
    const policy = loadPolicyYaml(readFileSync(`${root}policies/swarm.yaml`, "utf8"));
    expect(Object.keys(policy.swarm?.agents ?? {})).toEqual(["momentum-1", "meanrev-1"]);
    // The sum of the budgets must fit the per-asset exposure cap used by the demo agents (both trade wNEAR).
    const total = Object.values(policy.swarm?.agents ?? {}).reduce((a, b) => a + b.budgetPct, 0);
    expect(total).toBeLessThanOrEqual(policy.maxExposurePct);
  });

  it("rejects a swarm section with no agents or an out-of-range budget", () => {
    const base = {
      version: 1, allowedAssets: ["wNEAR"], maxOrderPct: 10, maxExposurePct: 30, maxLeverage: 1,
      maxDailyLossPct: 5, maxDrawdownPct: 15, maxOrdersPerHour: 5, maxSlippageBps: 100,
    };
    expect(() => parsePolicy({ ...base, swarm: { agents: {} } })).toThrow(/at least one agent/);
    expect(() => parsePolicy({ ...base, swarm: { agents: { a: { budgetPct: 150, maxDrawdownPct: 5 } } } })).toThrow();
  });

  it("rejects an invalid policy with a readable error", () => {
    expect(() => parsePolicy({ version: 1, allowedAssets: [], maxOrderPct: -1 })).toThrow(/allowedAssets|maxOrderPct/);
  });

  it("rejects a malformed trading window", () => {
    const bad = {
      version: 1,
      allowedAssets: ["wNEAR"],
      maxOrderPct: 10,
      maxExposurePct: 30,
      maxLeverage: 1,
      maxDailyLossPct: 5,
      maxDrawdownPct: 15,
      maxOrdersPerHour: 5,
      maxSlippageBps: 100,
      tradingWindowsUtc: [{ start: "25:00", end: "26:00" }],
    };
    expect(() => parsePolicy(bad)).toThrow(/HH:MM/);
  });

  it("keeps policies/schema.json in sync with the zod schema", () => {
    const onDisk = JSON.parse(readFileSync(`${root}policies/schema.json`, "utf8"));
    expect(onDisk).toEqual(policyJsonSchema());
  });
});
