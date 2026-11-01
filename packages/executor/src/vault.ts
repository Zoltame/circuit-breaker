// On-chain leg: the agent's function-call key calls the Circuit Breaker vault on NEAR.
// The vault is the last gate for funds: if it rejects, the order is not filled.

import { Account, JsonRpcProvider, actions, teraToGas, type KeyPairString } from "near-api-js";
/** NEAR -> yoctoNEAR at nano-NEAR precision, so float noise (0.1000000000000000006) never reaches the chain. */
export function nearToYoctoRounded(near: number): bigint {
  return BigInt(Math.round(near * 1e9)) * 10n ** 15n;
}

export interface OnchainResult {
  status: "settled" | "rejected" | "error";
  txHash?: string;
  /** Contract panic (`CB_BLOCKED:<rule>: ...`) or protocol / network error. */
  error?: string;
  amountYocto?: string;
}

/** `get_config` view of the vault contract (amounts in yoctoNEAR / token base units, as strings). */
export interface VaultConfig {
  owner_id: string;
  agent_id: string;
  kill_switch: boolean;
  venues: string[];
  tokens: Array<{
    token: string;
    limits: { max_per_order: string; max_per_day: string };
    spent_today: string;
    remaining_today: string;
  }>;
  orders_executed: number;
}

export interface VaultGateway {
  /** Sends the order's on-chain settlement leg to the whitelisted venue. */
  executeOrder(orderId: string, amountUsd: number): Promise<OnchainResult>;
  /** Freezes the vault. Only the owner can release it. */
  tripKillSwitch(reason: string): Promise<OnchainResult>;
  explorerUrl(txHash: string): string;
  /** Reads the vault's live configuration (read-only, no key needed). */
  getConfig?(): Promise<VaultConfig>;
  readonly vaultId?: string;
}

export interface NearVaultOptions {
  rpcUrl: string;
  vaultId: string;
  agentId: string;
  /** Agent's function-call key, scoped to the vault. */
  privateKey: KeyPairString;
  venueId: string;
  /** Testnet NEAR moved per paper USD (default 0.0002: a $500 order moves 0.1 NEAR). */
  nearPerUsd?: number;
  explorerBase?: string;
}

export class NearVaultGateway implements VaultGateway {
  private readonly agent: Account;
  private readonly provider: JsonRpcProvider;

  constructor(private readonly o: NearVaultOptions) {
    this.provider = new JsonRpcProvider({ url: o.rpcUrl });
    this.agent = new Account(o.agentId, this.provider, o.privateKey);
  }

  get vaultId(): string {
    return this.o.vaultId;
  }

  async getConfig(): Promise<VaultConfig> {
    return (await this.provider.callFunction({ contractId: this.o.vaultId, method: "get_config", args: {} })) as VaultConfig;
  }

  explorerUrl(txHash: string): string {
    return `${this.o.explorerBase ?? "https://testnet.nearblocks.io/txns/"}${txHash}`;
  }

  executeOrder(orderId: string, amountUsd: number): Promise<OnchainResult> {
    const amountYocto = nearToYoctoRounded(amountUsd * (this.o.nearPerUsd ?? 0.0002)).toString();
    return this.call(
      "execute_order",
      { order_id: orderId, token: "near", amount: amountYocto, venue: this.o.venueId, msg: null },
      amountYocto,
    );
  }

  tripKillSwitch(reason: string): Promise<OnchainResult> {
    return this.call("trip_kill_switch", { reason: reason.slice(0, 200) });
  }

  private async call(method: string, args: object, amountYocto?: string): Promise<OnchainResult> {
    const extra = amountYocto ? { amountYocto } : {};
    try {
      const res = (await this.agent.signAndSendTransaction({
        receiverId: this.o.vaultId,
        actions: [actions.functionCall(method, args, teraToGas("100"), 0n)],
        throwOnFailure: false,
      })) as unknown as { transaction: { hash: string }; status: Record<string, unknown> };
      const txHash = res.transaction.hash;
      if ("Failure" in res.status) {
        const raw = JSON.stringify(res.status.Failure);
        const error = raw.match(/CB_BLOCKED:[^"\\]+/)?.[0] ?? raw.slice(0, 200);
        return { status: "rejected", txHash, error, ...extra };
      }
      return { status: "settled", txHash, ...extra };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", error: msg.split("\n")[0]!.slice(0, 200), ...extra };
    }
  }
}
