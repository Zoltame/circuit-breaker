// Static replay of a recorded demo run (session.json, made with `pnpm demo --record ...`).
// Loaded before app.js on the hosted site: it stands in for the dashboard server by answering /api/* from
// the recording and by playing its live updates through a fake EventSource, on the recorded timeline.
// Every transaction link points to the real transaction on NEAR testnet.

(() => {
  const listeners = {};
  const cur = { events: [], account: null, vault: null, journal: null };
  let session = null;
  let next = 0; // index of the next frame to play
  let clock = 0; // replay time, ms since the recording started
  let speed = 1;
  let playing = false;

  const ready = fetch("session.json")
    .then((r) => r.json())
    .then((s) => {
      session = s;
      cur.vault = s.vault;
      const reset = s.frames.find((f) => f.kind === "reset");
      cur.account = reset ? reset.data.account : null;
    });

  const realFetch = window.fetch.bind(window);
  const reply = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    await ready;
    if ((init?.method ?? "GET") !== "GET") {
      return reply(403, { error: "This is a replay of a recorded testnet run. Clone the repo and run `pnpm demo` to drive it yourself." });
    }
    if (url.startsWith("/api/snapshot")) {
      return reply(200, {
        mode: session.mode,
        policy: session.policy,
        redTeam: session.redTeam,
        account: cur.account,
        vault: cur.vault,
        journal: cur.journal,
        events: cur.events.slice(-200),
      });
    }
    if (url.startsWith("/api/vault")) return reply(200, cur.vault);
    if (url.startsWith("/api/journal/verify")) return reply(200, cur.journal);
    return reply(404, { error: "not found" });
  };

  window.EventSource = class {
    constructor() {
      setTimeout(() => this.onopen?.(), 0);
    }
    addEventListener(kind, fn) {
      (listeners[kind] ??= []).push(fn);
    }
    close() {}
  };

  function apply(frame) {
    const d = frame.data;
    if (frame.kind === "journal") {
      cur.events.push(d.event);
      cur.account = d.account;
    } else if (frame.kind === "account") cur.account = d;
    else if (frame.kind === "reset") {
      cur.events = [];
      cur.account = d.account;
      cur.journal = null;
    } else if (frame.kind === "vault") cur.vault = d;
    else if (frame.kind === "journal_check") cur.journal = d;
    for (const fn of listeners[frame.kind] ?? []) fn({ data: JSON.stringify(d) });
  }

  // ---------------------------------------------------------------- player bar

  const bar = document.createElement("div");
  bar.className = "replay-bar";
  bar.innerHTML = `
    <span class="replay-tag">REPLAY</span>
    <span class="replay-text">Recorded run on NEAR testnet<span id="replay-date"></span>. Transaction links are real.</span>
    <span class="replay-controls">
      <button type="button" id="replay-play">Pause</button>
      <button type="button" data-speed="1" class="on">1×</button>
      <button type="button" data-speed="2">2×</button>
      <button type="button" data-speed="4">4×</button>
      <button type="button" id="replay-restart">Restart</button>
    </span>
    <span class="replay-progress"><span id="replay-fill"></span></span>`;
  document.addEventListener("DOMContentLoaded", () => document.body.prepend(bar));

  function updateBar() {
    const total = session.frames.at(-1)?.t ?? 1;
    document.getElementById("replay-fill").style.width = `${Math.min(100, (clock / total) * 100)}%`;
    document.getElementById("replay-play").textContent = next >= session.frames.length ? "Ended" : playing ? "Pause" : "Play";
  }

  bar.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.id === "replay-restart") return location.reload();
    if (b.id === "replay-play") {
      if (next >= session.frames.length) return location.reload();
      playing = !playing;
    }
    if (b.dataset.speed) {
      speed = Number(b.dataset.speed);
      bar.querySelectorAll("[data-speed]").forEach((x) => x.classList.toggle("on", x === b));
    }
    updateBar();
  });

  const TICK = 100;
  ready.then(() => {
    document.getElementById("replay-date").textContent = `, ${new Date(session.recordedAt).toUTCString().slice(5, 16)}`;
    // Start after the page has loaded its (empty) snapshot.
    setTimeout(() => {
      playing = true;
      setInterval(() => {
        if (!playing) return;
        clock += TICK * speed;
        while (next < session.frames.length && session.frames[next].t <= clock) apply(session.frames[next++]);
        if (next >= session.frames.length) playing = false;
        updateBar();
      }, TICK);
    }, 1_500);
  });
})();
