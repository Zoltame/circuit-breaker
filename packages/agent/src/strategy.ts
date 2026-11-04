// Deliberately simple strategies. The point of the project is the risk layer, not the alpha.

import type { OrderIntent } from "@circuit-breaker/executor";

export interface MarketView {
  now: number;
  asset: string;
  price: number;
  /** Prices seen on previous ticks, oldest first. */
  history: number[];
  cashUsd: number;
  /** Units of `asset` held. */
  units: number;
  equityUsd: number;
}

export type Strategy = (view: MarketView) => Omit<OrderIntent, "agentId"> | null;

/**
 * Mean reversion: buy a slice when the price is below its recent average, sell a slice when it is above.
 * The opposite bet to momentum, so two agents running side by side do not simply copy each other.
 */
export function meanReversion(opts: { lookback?: number; thresholdBps?: number; stepPct?: number } = {}): Strategy {
  const lookback = opts.lookback ?? 6;
  const threshold = (opts.thresholdBps ?? 10) / 10_000;
  const step = (opts.stepPct ?? 5) / 100;
  return (v) => {
    const window = v.history.slice(-lookback);
    if (window.length < lookback) return null;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    if (mean <= 0) return null;
    const deviation = (v.price - mean) / mean;
    const notionalUsd = Math.round(v.equityUsd * step * 100) / 100;
    if (deviation < -threshold && v.cashUsd >= notionalUsd) return { side: "buy", asset: v.asset, notionalUsd };
    if (deviation > threshold && v.units * v.price >= notionalUsd) return { side: "sell", asset: v.asset, notionalUsd };
    return null;
  };
}

/**
 * Momentum: buy a slice when the price rose over the lookback, sell a slice when it fell.
 * `stepPct` is the order size as % of equity.
 */
export function momentum(opts: { lookback?: number; thresholdBps?: number; stepPct?: number } = {}): Strategy {
  const lookback = opts.lookback ?? 3;
  const threshold = (opts.thresholdBps ?? 10) / 10_000;
  const step = (opts.stepPct ?? 5) / 100;
  return (v) => {
    const ref = v.history.at(-lookback);
    if (ref === undefined || ref <= 0) return null;
    const change = (v.price - ref) / ref;
    const notionalUsd = Math.round(v.equityUsd * step * 100) / 100;
    if (change > threshold && v.cashUsd >= notionalUsd) {
      return { side: "buy", asset: v.asset, notionalUsd };
    }
    if (change < -threshold && v.units * v.price >= notionalUsd) {
      return { side: "sell", asset: v.asset, notionalUsd };
    }
    return null;
  };
}
