import { parsePolicy } from "@circuit-breaker/policy-engine";
import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  MemoryJournal,
  PaperBroker,
  toBaseUnits,
  type DryQuote,
  type DryQuoteRequest,
  type OnchainResult,
  type Quoter,
  type TokenInfo,
  type VaultGateway,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const quoter: Quoter = {
  async tokens(): Promise<TokenInfo[]> {
    return [
      { assetId: "w", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 4 },
      { assetId: "u", decimals: 6, blockchain: "near", symbol: "USDC", price: 1 },
    ];
  },
  async dryQuote(req: DryQuoteRequest): Promise<DryQuote> {
    const usd = req.originAssetId === "u" ? Number(req.amount) / 1e6 : (Number(req.amount) / 1e24) * 4;
    const out = req.originAssetId === "u" ? toBaseUnits(usd / 4, 24) : toBaseUnits(usd, 6);
    return { amountIn: req.amount, amountInUsd: usd, amountOut: out, amountOutUsd: usd, minAmountOut: out };
  },
};

class FakeVault implements VaultGateway {
  orders: Array<[string, number]> = [];
  trips: string[] = [];
  reject: string | null = null;
  async executeOrder(orderId: string, amountUsd: number): Promise<OnchainResult> {
    this.orders.push([orderId, amountUsd]);
    return this.reject ? { status: "rejected", txHash: "tx-bad", error: this.reject } : { status: "settled", txHash: "tx-ok" };
  }
  async tripKillSwitch(reason: string): Promise<OnchainResult> {
    this.trips.push(reason);
    return { status: "settled", txHash: "tx-trip" };
  }
  explorerUrl(h: string): string {
    return `https://explorer/${h}`;
  }
}

function setup() {
  const vault = new FakeVault();
  const broker = PaperBroker.fresh(10_000, NOW);
  const journal = new MemoryJournal();
  const cb = new CircuitBreaker({
    policy: parsePolicy({
      version: 1,
      allowedAssets: ["wNEAR", "USDC"],
      maxOrderPct: 10,
      maxExposurePct: 30,
      maxLeverage: 1,
      maxDailyLossPct: 5,
      maxDrawdownPct: 15,
      maxOrdersPerHour: 10,
      maxSlippageBps: 100,
    }),
    broker,
    quoter,
    journal,
    vault,
    now: () => NOW,
  });
  return { cb, vault, broker, journal };
}

describe("CircuitBreaker with an on-chain vault", () => {
  it("settles an allowed buy on-chain before the paper fill", async () => {
    const { cb, vault, broker } = setup();
    const ev = await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 500 });
    expect(vault.orders).toEqual([[ev.order.id, 500]]);
    expect(ev.execution).toMatchObject({
      status: "filled",
      onchain: { status: "settled", txHash: "tx-ok", explorerUrl: "https://explorer/tx-ok" },
    });
    expect(broker.state.cashUsd).toBe(9_500);
  });

  it("does not fill when the vault rejects, even though the engine allowed", async () => {
    const { cb, vault, broker } = setup();
    vault.reject = "CB_BLOCKED:max_per_day: 3 + 1 > 3";
    const ev = await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 500 });
    expect(ev.verdict).toBe("allow");
    expect(ev.execution).toMatchObject({ status: "failed", error: "vault rejected: CB_BLOCKED:max_per_day: 3 + 1 > 3" });
    expect(broker.state.cashUsd).toBe(10_000);
  });

  it("never calls the vault for blocked orders or sells", async () => {
    const { cb, vault } = setup();
    await cb.submit({ agentId: "a", side: "buy", asset: "SCAM", notionalUsd: 100 });
    await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 500 });
    await cb.submit({ agentId: "a", side: "sell", asset: "wNEAR", notionalUsd: 100 });
    expect(vault.orders).toHaveLength(1);
  });

  it("freezes the vault on a manual kill-switch, but releasing it stays off-chain", async () => {
    const { cb, vault, journal } = setup();
    await cb.setKillSwitch(true, "operator", "manual stop");
    await cb.setKillSwitch(false, "operator", "resume");
    expect(vault.trips).toEqual(["manual stop"]);
    const events = journal.events.filter((e) => e.type === "kill_switch");
    expect(events[0]).toMatchObject({ on: true, onchain: { txHash: "tx-trip" } });
    expect(events[1]).not.toHaveProperty("onchain");
  });
});

describe("nearToYoctoRounded", () => {
  it("drops float noise", async () => {
    const { nearToYoctoRounded } = await import("../src/vault.ts");
    expect(nearToYoctoRounded(500 * 0.0002)).toBe(10n ** 23n);
    expect(nearToYoctoRounded(300 * 0.0002)).toBe(6n * 10n ** 22n);
  });
});
