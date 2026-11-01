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
