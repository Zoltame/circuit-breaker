// Trips the vault kill-switch with the agent's function-call key, as the agent would on a drawdown.
// Usage: pnpm vault:trip ["reason"]
import { buildBreaker } from "@circuit-breaker/executor";

const { vault } = buildBreaker({ onchain: true });
if (!vault) throw new Error("Vault not configured in .env");
const r = await vault.tripKillSwitch(process.argv[2] ?? "Agent tripped the kill-switch");
console.log(r.status, r.txHash ? vault.explorerUrl(r.txHash) : "", r.error ?? "");
