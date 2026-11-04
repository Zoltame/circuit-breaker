// Circuit Breaker dashboard client. Live data from /api/snapshot + /api/events (SSE).

const $ = (sel) => document.querySelector(sel);
const fmtUsd = (n) =>
  `${n < 0 ? "−" : ""}$${Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n) => `${Number(n).toFixed(2)}%`;
const yoctoToNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = { snapshot: null, events: [], account: null, vault: null };

// ---------------------------------------------------------------- rendering

function renderChips() {
  const { mode } = state.snapshot;
  const chip = (on, label) => `<span class="chip ${on ? "on" : ""}"><span class="dot"></span>${label}</span>`;
  $("#chips").innerHTML = [
    chip(true, "1Click live quotes"),
    chip(mode.onchain, mode.onchain ? "Vault on testnet" : "Vault off"),
    chip(mode.agent, mode.agent ? "Agent running" : "Agent idle"),
  ].join("");
}

function setGauge(id, value, limit, text) {
  const el = $(id);
  const ratio = limit > 0 ? Math.min(1, Math.max(0, value / limit)) : 0;
  el.querySelector(".bar span").style.width = `${ratio * 100}%`;
  el.classList.toggle("warn", ratio >= 0.6 && ratio < 1);
  el.classList.toggle("hot", ratio >= 1);
  el.querySelector(".big").textContent = text;
  el.querySelector(".lim").textContent = `limit ${limit}${id === "#g-freq" ? " / hour" : "%"}`;
}

function renderAccount() {
  const a = state.account;
  if (!a) return;
  const pnl = a.equityUsd - a.startUsd;
  $("#equity").textContent = fmtUsd(a.equityUsd);
  $("#pnl").innerHTML = `<span style="color:var(${pnl >= 0 ? "--allow" : "--block"})">${pnl >= 0 ? "+" : ""}${fmtUsd(pnl)}</span> since start · cash ${fmtUsd(a.cashUsd)}`;
  setGauge("#g-dd", a.drawdownPct, a.limits.maxDrawdownPct, fmtPct(a.drawdownPct));
  setGauge("#g-daily", a.dailyLossPct, a.limits.maxDailyLossPct, fmtPct(a.dailyLossPct));
  setGauge("#g-freq", a.ordersLastHour, a.limits.maxOrdersPerHour, String(a.ordersLastHour));

  const rows = Object.entries(a.exposurePct).filter(([, v]) => v > 0.005);
  $("#exposure").innerHTML = rows.length
    ? rows
        .map(([asset, v]) => {
          const r = Math.min(1, v / a.limits.maxExposurePct);
          const color = r >= 1 ? "var(--block)" : r >= 0.6 ? "var(--warn)" : "var(--allow)";
          return `<div class="exp-row"><span>${esc(asset)}</span><div class="bar"><span style="width:${r * 100}%;background:${color}"></span><i></i></div><b>${fmtPct(v)}</b></div>`;
        })
        .join("")
    : `<div class="muted">All in USDC</div>`;
  $("#g-exp .lim").textContent = `limit ${a.limits.maxExposurePct}% each`;

  const tripped = a.killSwitch;
  const vaultFrozen = Boolean(state.vault?.kill_switch);
  const pill = $("#status-pill");
  pill.textContent = tripped ? "KILL-SWITCH · REDUCE-ONLY" : a.reduceOnly ? "DAILY LOSS · REDUCE-ONLY" : vaultFrozen ? "VAULT FROZEN" : "ARMED";
  pill.className = `pill ${tripped || a.reduceOnly ? "tripped" : vaultFrozen ? "frozen" : "armed"}`;
  const btn = $("#kill-btn");
  btn.textContent = tripped ? "Release (off-chain)" : "Trip kill-switch";
  btn.classList.toggle("release", tripped);
  renderSpark();
  renderSwarm();
}

function renderSwarm() {
  const agents = state.account?.agents;
  $("#swarm-card").hidden = !agents;
  if (!agents) return;
  $("#swarm").innerHTML = agents
    .map((a) => {
      const exp = a.budgetPct > 0 ? Math.min(100, (a.exposurePct / a.budgetPct) * 100) : 0;
      const dd = a.maxDrawdownPct > 0 ? Math.min(100, (a.drawdownPct / a.maxDrawdownPct) * 100) : 0;
      const hot = (r) => (r >= 100 ? "var(--block)" : r >= 60 ? "var(--warn)" : "var(--allow)");
      const status = a.quarantined
        ? `<span class="badge block">QUARANTINED</span> <button type="button" class="btn-ghost" data-release="${esc(a.id)}">Release</button>`
        : `<span class="badge allow">ACTIVE</span>`;
      return `<div class="agent-row">
        <div class="agent-head"><b>${esc(a.id)}</b>${status}</div>
        <div class="exp-row"><span>Budget</span><div class="bar"><span style="width:${exp}%;background:${hot(exp)}"></span><i></i></div><b>${fmtPct(a.exposurePct)} / ${a.budgetPct}%</b></div>
        <div class="exp-row"><span>Own drawdown</span><div class="bar"><span style="width:${dd}%;background:${hot(dd)}"></span><i></i></div><b>${fmtPct(a.drawdownPct)} / ${a.maxDrawdownPct}%</b></div>
      </div>`;
    })
    .join("");
}

function renderSpark() {
  const pts = state.events.filter((e) => e.type === "decision").map((e) => e.equityUsd);
  if (state.account) pts.push(state.account.equityUsd);
  if (pts.length < 2) return ($("#spark").innerHTML = "");
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${(i / (pts.length - 1)) * 200},${38 - ((v - min) / span) * 36}`).join(" ");
  $("#spark").innerHTML = `<path d="${d}"/>`;
}

function onchainCell(link) {
  if (!link) return `<span class="muted">—</span>`;
  const label = link.status === "settled" ? "settled" : link.status;
  const cls = link.status === "settled" ? "tx" : "tx fail";
  const short = link.txHash ? `${link.txHash.slice(0, 6)}…` : "";
  const a = link.explorerUrl ? `<a class="${cls}" href="${esc(link.explorerUrl)}" target="_blank" rel="noopener">${label} ${short} ↗</a>` : `<span class="${cls}">${label}</span>`;
  // Contract messages carry yoctoNEAR amounts: show them in NEAR.
  const msg = (link.error ?? "").replace(/\d{19,}/g, (y) => `${yoctoToNear(y)} NEAR`);
  return link.status === "settled" ? a : `${a}<div class="reason">${esc(msg)}</div>`;
}

function row(e) {
  const t = new Date(e.timestamp).toLocaleTimeString("en-GB", { hour12: false });
  if (e.type === "kill_switch") {
    return `<tr><td class="time">${t}</td><td class="agent">${esc(e.by)}</td><td>Kill-switch ${e.on ? "ON" : "OFF"}</td>
      <td><span class="badge warn">${e.on ? "TRIP" : "RELEASE"}</span></td>
      <td><div class="reason">${esc(e.reason)}</div></td><td></td><td>${onchainCell(e.onchain)}</td></tr>`;
  }
  if (e.type === "agent_quarantine") {
    return `<tr><td class="time">${t}</td><td class="agent">${esc(e.agentId)}</td><td>Agent ${e.on ? "quarantined" : "released"}</td>
      <td><span class="badge ${e.on ? "block" : "allow"}">${e.on ? "QUARANTINE" : "RELEASE"}</span></td>
      <td><div class="reason">${esc(e.reason)}</div></td><td></td><td></td></tr>`;
  }
  if (e.type === "flatten") {
    return `<tr><td class="time">${t}</td><td class="agent">${esc(e.by)}</td><td>Flatten ${e.positions.map(esc).join(", ")}</td>
      <td><span class="badge warn">FLATTEN</span></td>
      <td><div class="reason">${esc(e.reason)}</div></td><td></td><td></td></tr>`;
  }
  if (e.type === "vault_direct") {
    return `<tr><td class="time">${t}</td><td class="agent">agent key</td><td>vault.execute_order ${fmtUsd(e.amountUsd)}</td>
      <td><span class="badge ${e.onchain.status === "settled" ? "allow" : "block"}">${e.onchain.status === "settled" ? "SETTLED" : "VAULT BLOCK"}</span></td>
      <td><span class="rule">engine bypassed</span><div class="reason">${esc(e.label)}</div></td><td></td><td>${onchainCell(e.onchain)}</td></tr>`;
  }
  const o = e.order;
  const lev = o.leverage > 1 ? ` ${o.leverage}x` : "";
  const cost = o.quote ? `${(((o.quote.amountInUsd - o.quote.amountOutUsd) / o.quote.amountInUsd) * 10000).toFixed(1)} bps` : "—";
  const failed = e.execution && e.execution.status === "failed";
  const exit = e.verdict === "allow" && e.waived?.length > 0;
  const verdict = e.verdict === "allow"
    ? failed ? `<span class="badge block">VAULT BLOCK</span>` : `<span class="badge allow">${exit ? "ALLOW · EXIT" : "ALLOW"}</span>`
    : `<span class="badge block">BLOCK</span>`;
  const rule = e.verdict === "block"
    ? `<span class="rule">${esc(e.triggeredRule)}</span><div class="reason">${esc(e.reason)}</div>`
    : failed ? `<div class="reason">${esc(e.execution.error)}</div>`
    : exit ? `<span class="rule">reduce-only</span><div class="reason">waived: ${e.waived.map(esc).join(", ")} · sold ${e.execution?.units?.toFixed(3) ?? ""} ${esc(o.asset)}</div>`
    : `<div class="reason">filled ${e.execution?.units?.toFixed(3) ?? ""} ${esc(o.asset)}</div>`;
  return `<tr><td class="time">${t}</td><td class="agent">${esc(o.agentId)}</td><td>${o.side} ${fmtUsd(o.notionalUsd)} ${esc(o.asset)}${lev}</td>
    <td>${verdict}</td><td>${rule}</td><td class="num">${cost}</td><td>${onchainCell(e.execution?.onchain)}</td></tr>`;
}

function renderFeed(fresh = false) {
  const evs = state.events.slice(-200).reverse();
  $("#feed").innerHTML = evs.map(row).join("");
  $("#feed-empty").hidden = evs.length > 0;
  if (fresh && $("#feed").firstElementChild) $("#feed").firstElementChild.classList.add("fresh");

  const decisions = state.events.filter((e) => e.type === "decision");
  const allow = decisions.filter((e) => e.verdict === "allow" && e.execution?.status !== "failed").length;
  const byRule = {};
  for (const e of decisions) if (e.verdict === "block") byRule[e.triggeredRule] = (byRule[e.triggeredRule] ?? 0) + 1;
  const vaultBlocks = state.events.filter((e) => (e.type === "decision" && e.execution?.status === "failed") || (e.type === "vault_direct" && e.onchain.status !== "settled")).length;
  $("#counts").innerHTML =
    `<span class="count allow">${allow} allowed</span>` +
    Object.entries(byRule).map(([r, n]) => `<span class="count block">${n} ${esc(r)}</span>`).join("") +
    (vaultBlocks ? `<span class="count block">${vaultBlocks} vault</span>` : "");
}

function renderVault() {
  const v = state.vault;
  const id = state.snapshot.mode.vaultId;
  const link = $("#vault-link");
  if (!state.snapshot.mode.onchain || !v) {
    link.textContent = "";
    $("#vault").innerHTML = `<p class="muted">Start with <code>pnpm dashboard --onchain</code> to settle allowed buys through the NEAR testnet vault.</p>`;
    $("#vault-banner").hidden = true;
    return;
  }
  link.textContent = "explorer ↗";
  link.href = `https://testnet.nearblocks.io/address/${id}`;
  const t = v.tokens.find((x) => x.token === "near");
  const spent = t ? yoctoToNear(t.spent_today) : 0;
  const perDay = t ? yoctoToNear(t.limits.max_per_day) : 0;
  const perOrder = t ? yoctoToNear(t.limits.max_per_order) : 0;
  $("#vault").innerHTML = `
    <dl class="kv">
      <dt>Contract</dt><dd><code>${esc(id)}</code></dd>
      <dt>Kill-switch</dt><dd><span class="badge ${v.kill_switch ? "block" : "allow"}">${v.kill_switch ? "FROZEN" : "OPEN"}</span></dd>
      <dt>Cap per order</dt><dd>${perOrder} NEAR</dd>
      <dt>Spent today</dt><dd>${spent} / ${perDay} NEAR</dd>
      <dt>Venues</dt><dd>${v.venues.map((x) => `<code>${esc(x)}</code>`).join("<br>")}</dd>
      <dt>Agent key</dt><dd><code>${esc(v.agent_id)}</code><br><span class="muted">function-call only: execute_order, trip_kill_switch</span></dd>
      <dt>Orders settled</dt><dd>${v.orders_executed}</dd>
    </dl>
    <div class="bar" style="margin-top:12px"><span style="width:${perDay ? Math.min(100, (spent / perDay) * 100) : 0}%"></span><i></i></div>`;
  renderAccount();
  const banner = $("#vault-banner");
  banner.hidden = !v.kill_switch;
  banner.innerHTML = `The on-chain vault is <b>frozen</b>. The agent can trip it but never release it. Only the owner can, with their own key:<br>
    <code>near contract call-function as-transaction ${esc(id)} set_kill_switch json-args '{"on":false,"reason":"reviewed"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${esc(v.owner_id)} network-config testnet sign-with-keychain send</code>`;
}

function renderPolicy() {
  const p = state.snapshot.policy;
  const windows = p.tradingWindowsUtc.length ? p.tradingWindowsUtc.map((w) => `${w.start}-${w.end}`).join(", ") : "always";
  const rules = [
    ["Kill-switch", p.killSwitch ? "on" : "off"],
    ["Asset whitelist", p.allowedAssets.join(", ")],
    ["Max order size", `${p.maxOrderPct}%`],
    ["Max exposure / asset", `${p.maxExposurePct}%`],
    ["Max leverage", `${p.maxLeverage}x`],
    ["Daily loss limit", `${p.maxDailyLossPct}%`],
    ["Max drawdown → kill", `${p.maxDrawdownPct}%`],
    ["Orders per hour", p.maxOrdersPerHour],
    ["Max quote cost", `${p.maxSlippageBps} bps`],
    ["Trading hours (UTC)", windows],
    ["Auto-flatten on drawdown", p.autoFlatten ? "on" : "off"],
    ...(p.swarm ? [["Swarm agents", Object.entries(p.swarm.agents).map(([id, l]) => `${id} ${l.budgetPct}%/${l.maxDrawdownPct}%dd`).join(", ")]] : []),
  ];
  $("#rules").innerHTML = rules.map(([k, v]) => `<li>${k}<span class="v">${esc(v)}</span></li>`).join("");
}

function renderRedTeam() {
  const tags = { oversize: "max_order_size", unlisted: "asset_whitelist", leverage: "max_leverage", loop: "order_frequency", rogue: "agent_budget", overbudget: "agent_budget", bypass: "vault" };
  $("#redteam").innerHTML = Object.entries(state.snapshot.redTeam)
    .map(([k, label]) => `<button type="button" data-attack="${k}" ${k === "bypass" && !state.snapshot.mode.onchain ? "disabled title='needs --onchain'" : ""}>${esc(label)}<span class="tag">${tags[k] ?? ""}</span></button>`)
    .join("");
}

function renderAll() {
  renderChips();
  renderAccount();
  renderFeed();
  renderVault();
  renderPolicy();
  renderRedTeam();
}

// ---------------------------------------------------------------- data

async function loadSnapshot() {
  const s = await (await fetch("/api/snapshot")).json();
  state.snapshot = s;
  state.events = s.events;
  state.account = s.account;
  state.vault = s.vault;
  renderAll();
}

async function refreshVault() {
  if (!state.snapshot?.mode.onchain) return;
  state.vault = await (await fetch("/api/vault")).json();
  renderVault();
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("journal", (m) => {
    const { event, account } = JSON.parse(m.data);
    state.events.push(event);
    state.account = account;
    renderAccount();
    renderFeed(true);
    if (event.type !== "decision" || event.execution?.onchain) void refreshVault();
  });
  es.addEventListener("account", (m) => {
    state.account = JSON.parse(m.data);
    renderAccount();
  });
  es.addEventListener("reset", () => void loadSnapshot());
}

async function post(path, payload) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload ?? {}) });
  const out = await res.json();
  if (!res.ok) alert(out.error ?? "Request failed");
  return out;
}

$("#kill-btn").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await post("/api/kill-switch", { on: !state.account?.killSwitch });
    await refreshVault();
  } finally {
    btn.disabled = false;
  }
});

$("#swarm").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-release]");
  if (!btn) return;
  btn.disabled = true;
  try {
    await post("/api/release-agent", { agentId: btn.dataset.release });
  } finally {
    btn.disabled = false;
  }
});

$("#flatten-btn").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  if (!confirm("Sell every position with reduce-only exits?")) return;
  btn.disabled = true;
  try {
    await post("/api/flatten");
  } finally {
    btn.disabled = false;
  }
});

$("#redteam").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-attack]");
  if (!btn) return;
  btn.disabled = true;
  try {
    await post(`/api/red-team/${btn.dataset.attack}`);
  } finally {
    btn.disabled = false;
  }
});

$("#reset-btn").addEventListener("click", async () => {
  if (confirm("Reset the paper account to $10,000 and clear the journal? The on-chain vault is not touched.")) await post("/api/reset");
});

await loadSnapshot();
connect();
setInterval(() => void refreshVault(), 15_000);
