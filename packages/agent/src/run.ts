// Agent loop. The agent never touches the broker: it can only propose intents to the CircuitBreaker.

import type { CircuitBreaker, DecisionEvent, PaperBroker } from "@circuit-breaker/executor";
import type { Strategy } from "./strategy.ts";

export interface RunOptions {
  agentId: string;
  asset: string;
  strategy: Strategy;
  breaker: CircuitBreaker;
  /** Read-only view of balances, used to build the market view. */
  broker: PaperBroker;
  ticks: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onDecision?: (ev: DecisionEvent) => void;
  /** Stops early, e.g. on SIGINT. */
  signal?: AbortSignal;
}

export async function runAgent(o: RunOptions): Promise<DecisionEvent[]> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const history: number[] = [];
  const out: DecisionEvent[] = [];

  for (let i = 0; i < o.ticks && !o.signal?.aborted; i++) {
    const { prices } = await o.breaker.prices();
    const price = prices[o.asset];
    if (price !== undefined) {
      const units = o.broker.state.holdings[o.asset] ?? 0;
      const intent = o.strategy({
        now: now(),
        asset: o.asset,
        price,
        history: [...history],
        cashUsd: o.broker.state.cashUsd,
        units,
        equityUsd: o.broker.equityUsd(prices),
      });
      history.push(price);
      if (intent) {
        const ev = await o.breaker.submit({ agentId: o.agentId, ...intent });
        out.push(ev);
        o.onDecision?.(ev);
      }
    }
    if (i < o.ticks - 1) await sleep(o.intervalMs);
  }
  return out;
}
