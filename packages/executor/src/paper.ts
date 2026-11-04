// Paper broker: holds a simulated USDC balance and token holdings, fills at real 1Click quote amounts.
// Tracks the account figures the policy engine needs (equity, peak, UTC day start).

import type { AccountState, AgentState } from "@circuit-breaker/policy-engine";

export const QUOTE_ASSET = "USDC";

/** What one agent of the swarm owns and has earned. Only kept when the policy has a `swarm` section. */
export interface AgentBook {
  /** Capital the agent was given when its book was opened: budgetPct of the account equity at that time. */
  allocationUsd: number;
  realizedUsd: number;
  /** Highest agent equity seen (for the agent's own drawdown). */
  peakEquityUsd: number;
  quarantined: boolean;
  /** Units held and what they cost in USD (average cost), per asset. */
  positions: Record<string, { units: number; costUsd: number }>;
}

/** The part of the swarm policy the broker needs to size an agent's allocation. */
export type SwarmBudgets = { agents: Record<string, { budgetPct: number }> };

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
  /** Per-agent books (swarm mode). Absent for a pooled account. */
  agents?: Record<string, AgentBook>;
}

export interface Fill {
  side: "buy" | "sell";
  asset: string;
  /** Units of the asset bought or sold. */
  units: number;
  /** USDC spent (buy) or received (sell). */
  cashDelta: number;
}

const DUST_UNITS = 1e-9;

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

  /**
   * Marks to market: rolls the UTC day and raises the peak. Returns the engine's view of the account.
   * With `swarm`, it also opens a book for each configured agent that has none and reports every agent's own
   * exposure, equity and drawdown base.
   */
  mark(prices: Record<string, number>, now: number, swarm?: SwarmBudgets): AccountState {
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
      ...(swarm ? { agents: this.markAgents(prices, equity, swarm) } : {}),
    };
  }

  private markAgents(prices: Record<string, number>, accountEquity: number, swarm: SwarmBudgets): Record<string, AgentState> {
    const books = (this.state.agents ??= {});
    const out: Record<string, AgentState> = {};
    for (const [id, limit] of Object.entries(swarm.agents)) {
      const allocationUsd = (limit.budgetPct / 100) * accountEquity;
      const book = (books[id] ??= { allocationUsd, realizedUsd: 0, peakEquityUsd: allocationUsd, quarantined: false, positions: {} });
      const positionsUsd: Record<string, number> = {};
      let unrealized = 0;
      for (const [asset, pos] of Object.entries(book.positions)) {
        if (pos.units <= 0) continue;
        const value = pos.units * (prices[asset] ?? 0);
        positionsUsd[asset] = value;
        unrealized += value - pos.costUsd;
      }
      const equityUsd = book.allocationUsd + book.realizedUsd + unrealized;
      if (equityUsd > book.peakEquityUsd) book.peakEquityUsd = equityUsd;
      out[id] = {
        exposureUsd: Object.values(positionsUsd).reduce((a, b) => a + b, 0),
        equityUsd,
        peakEquityUsd: book.peakEquityUsd,
        quarantined: book.quarantined,
        positionsUsd,
      };
    }
    return out;
  }

  /** `agentId` attributes the fill to that agent's book (swarm mode); without a book it is just pooled. */
  apply(fill: Fill, now: number, agentId?: string): void {
    const held = this.state.holdings[fill.asset] ?? 0;
    const book = agentId ? this.state.agents?.[agentId] : undefined;
    if (book && fill.side === "sell" && fill.units > (book.positions[fill.asset]?.units ?? 0) + 1e-12) {
      throw new Error(`Agent ${agentId} does not hold enough ${fill.asset}`);
    }
    if (fill.side === "buy") {
      if (fill.cashDelta > this.state.cashUsd + 1e-9) throw new Error("Insufficient paper USDC balance");
      this.state.cashUsd -= fill.cashDelta;
      this.state.holdings[fill.asset] = held + fill.units;
    } else {
      if (fill.units > held + 1e-12) throw new Error(`Insufficient paper ${fill.asset} balance`);
      this.state.cashUsd += fill.cashDelta;
      const left = held - fill.units;
      // A full exit must leave exactly zero, not 1e-14 units of float dust that still count as a position.
      this.state.holdings[fill.asset] = Math.abs(left) < DUST_UNITS ? 0 : left;
    }
    this.state.recentOrderTimes = [...this.state.recentOrderTimes.filter((t) => t > now - 3_600_000), now];
    if (book) this.bookFill(book, fill);
  }

  /** Average-cost accounting: a sale realises PnL on the cost of the units sold. */
  private bookFill(book: AgentBook, fill: Fill): void {
    const pos = (book.positions[fill.asset] ??= { units: 0, costUsd: 0 });
    if (fill.side === "buy") {
      pos.units += fill.units;
      pos.costUsd += fill.cashDelta;
      return;
    }
    const sold = pos.units > 0 ? Math.min(1, fill.units / pos.units) : 0;
    const costRemoved = pos.costUsd * sold;
    book.realizedUsd += fill.cashDelta - costRemoved;
    pos.units -= fill.units;
    pos.costUsd -= costRemoved;
    if (Math.abs(pos.units) < DUST_UNITS) delete book.positions[fill.asset];
  }

  setQuarantine(agentId: string, on: boolean): void {
    const book = this.state.agents?.[agentId];
    if (book) book.quarantined = on;
  }

  setKillSwitch(on: boolean): void {
    this.state.killSwitch = on;
  }
}
