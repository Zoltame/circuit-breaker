// Paper broker: holds a simulated USDC balance and token holdings, fills at real 1Click quote amounts.
// Tracks the account figures the policy engine needs (equity, peak, UTC day start).

import type { AccountState } from "@circuit-breaker/policy-engine";

export const QUOTE_ASSET = "USDC";

export interface PaperState {
  cashUsd: number;
  /** Units held per asset symbol (not USD). */
  holdings: Record<string, number>;
  peakEquityUsd: number;
  dayStartEquityUsd: number;
  /** UTC date (YYYY-MM-DD) of dayStartEquityUsd. */
  day: string;
  recentOrderTimes: number[];
  killSwitch: boolean;
}

export interface Fill {
  side: "buy" | "sell";
  asset: string;
  /** Units of the asset bought or sold. */
  units: number;
  /** USDC spent (buy) or received (sell). */
  cashDelta: number;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class PaperBroker {
  constructor(public state: PaperState) {}

  static fresh(startingCashUsd: number, now: number): PaperBroker {
    return new PaperBroker({
      cashUsd: startingCashUsd,
      holdings: {},
      peakEquityUsd: startingCashUsd,
      dayStartEquityUsd: startingCashUsd,
      day: utcDay(now),
      recentOrderTimes: [],
      killSwitch: false,
    });
  }

  positionsUsd(prices: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [asset, units] of Object.entries(this.state.holdings)) {
      if (units !== 0) out[asset] = units * (prices[asset] ?? 0);
    }
    return out;
  }

  equityUsd(prices: Record<string, number>): number {
    return this.state.cashUsd + Object.values(this.positionsUsd(prices)).reduce((a, b) => a + b, 0);
  }

  /** Marks to market: rolls the UTC day and raises the peak. Returns the engine's view of the account. */
  mark(prices: Record<string, number>, now: number): AccountState {
    const equity = this.equityUsd(prices);
    const today = utcDay(now);
    if (today !== this.state.day) {
      this.state.day = today;
      this.state.dayStartEquityUsd = equity;
    }
    if (equity > this.state.peakEquityUsd) this.state.peakEquityUsd = equity;
    return {
      equityUsd: equity,
      peakEquityUsd: this.state.peakEquityUsd,
      dayStartEquityUsd: this.state.dayStartEquityUsd,
      positionsUsd: this.positionsUsd(prices),
      recentOrderTimes: this.state.recentOrderTimes.filter((t) => t > now - 3_600_000),
      killSwitch: this.state.killSwitch,
    };
  }

  apply(fill: Fill, now: number): void {
    const held = this.state.holdings[fill.asset] ?? 0;
    if (fill.side === "buy") {
      if (fill.cashDelta > this.state.cashUsd + 1e-9) throw new Error("Insufficient paper USDC balance");
      this.state.cashUsd -= fill.cashDelta;
      this.state.holdings[fill.asset] = held + fill.units;
    } else {
      if (fill.units > held + 1e-12) throw new Error(`Insufficient paper ${fill.asset} balance`);
      this.state.cashUsd += fill.cashDelta;
      this.state.holdings[fill.asset] = held - fill.units;
    }
    this.state.recentOrderTimes = [...this.state.recentOrderTimes.filter((t) => t > now - 3_600_000), now];
  }

  setKillSwitch(on: boolean): void {
    this.state.killSwitch = on;
  }
}
