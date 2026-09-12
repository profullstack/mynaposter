/**
 * The dashboard page: one HTML file, no framework, no build step.
 *
 * The page is a shell; every number in it comes from `/api/snapshot`, which it
 * re-reads on a timer and patches in place. Nothing is torn down and rebuilt on
 * a refetch, so the view never flashes empty while it is live.
 *
 * Colour follows the palette in the data-viz reference: eight categorical slots
 * in a fixed order, a status set that is never reused for a series, and both
 * modes selected rather than flipped. Marks are thin, gridlines are hairlines,
 * text wears text tokens and never a series colour.
 */

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>myna dashboard</title>
<style>
:root {
  color-scheme: light;
  --plane: #f9f9f7;
  --surface-1: #fcfcfb;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, 0.10);
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --series-4: #eda100;
  --series-5: #e87ba4;
  --series-6: #008300;
  --series-7: #4a3aa7;
  --series-8: #e34948;
  --series-0: #898781;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --plane: #0d0d0d;
    --surface-1: #1a1a19;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255, 255, 255, 0.10);
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --series-4: #c98500;
    --series-5: #d55181;
    --series-6: #008300;
    --series-7: #9085e9;
    --series-8: #e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane: #0d0d0d;
  --surface-1: #1a1a19;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --border: rgba(255, 255, 255, 0.10);
  --series-1: #3987e5;
  --series-2: #d95926;
  --series-3: #199e70;
  --series-4: #c98500;
  --series-5: #d55181;
  --series-6: #008300;
  --series-7: #9085e9;
  --series-8: #e66767;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--text-primary);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 64px; }

header.top { display: flex; align-items: baseline; gap: 12px; margin-bottom: 20px; }
header.top h1 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
header.top .sub { color: var(--text-muted); font-size: 13px; }
.live { margin-left: auto; display: flex; align-items: center; gap: 7px; color: var(--text-muted); font-size: 12px; }
.live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); }
@media (prefers-reduced-motion: no-preference) { .live .dot { animation: pulse 2.4s ease-in-out infinite; } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

.card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px 18px 16px;
}
.card > h2 {
  font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-muted); margin: 0 0 2px;
}
.card > .note { color: var(--text-muted); font-size: 12px; margin: 0 0 14px; }

.lead { display: grid; grid-template-columns: minmax(280px, 1.4fr) 2fr; gap: 14px; margin-bottom: 14px; }
@media (max-width: 880px) { .lead { grid-template-columns: 1fr; } }

.hero .figure { font-size: 52px; font-weight: 600; line-height: 1.05; letter-spacing: -0.02em; margin: 6px 0 4px; }
.hero .who { color: var(--text-secondary); font-size: 13px; display: flex; align-items: center; gap: 7px; }
.hero .excerpt { color: var(--text-muted); font-size: 12px; margin-top: 8px; overflow-wrap: anywhere; }

.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
@media (max-width: 880px) { .tiles { grid-template-columns: repeat(2, 1fr); } }
.tile .label { color: var(--text-muted); font-size: 12px; }
.tile .value { font-size: 30px; font-weight: 600; letter-spacing: -0.01em; margin-top: 4px; }
.tile .delta { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.tile .delta .up { color: var(--good); }
.tile .delta .down { color: var(--critical); }

.row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
@media (max-width: 880px) { .row { grid-template-columns: 1fr; } }
.full { margin-top: 14px; }

.legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 12px; padding: 0; list-style: none; }
.legend li { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 12px; }
.legend .key { width: 10px; height: 10px; border-radius: 3px; flex: none; }

svg { display: block; width: 100%; overflow: visible; }
.lane-label { fill: var(--text-secondary); font-size: 11px; }
.tick { fill: var(--text-muted); font-size: 11px; }
.grid-line { stroke: var(--grid); stroke-width: 1; }
.axis-line { stroke: var(--axis); stroke-width: 1; }
.now-line { stroke: var(--text-secondary); stroke-width: 1; stroke-dasharray: none; }
.gate { fill: var(--text-muted); opacity: 0.12; }
.dot-mark { stroke: var(--surface-1); stroke-width: 2; cursor: pointer; }
.bar { }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--text-muted); padding: 0 10px 8px 0;
  border-bottom: 1px solid var(--border); white-space: nowrap;
}
td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
td.when { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text-secondary); }
td.text { color: var(--text-secondary); overflow-wrap: anywhere; }
.who-cell { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.who-cell .key { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.reason { color: var(--text-muted); font-size: 12px; }
.empty { color: var(--text-muted); font-size: 13px; padding: 8px 0 2px; }

.status { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.status .glyph { font-size: 11px; line-height: 1; }
.status.ok .glyph { color: var(--good); }
.status.fail .glyph { color: var(--critical); }
.status.hold .glyph { color: var(--warning); }

a { color: inherit; }
.tip {
  position: fixed; pointer-events: none; z-index: 20; opacity: 0;
  background: var(--surface-1); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 7px;
  padding: 8px 10px; font-size: 12px; max-width: 280px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18); transition: opacity 90ms ease;
}
.tip .t-when { color: var(--text-muted); }
.tip .t-text { color: var(--text-secondary); margin-top: 4px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>myna</h1>
    <span class="sub">what went out, what is queued, and which network is holding</span>
    <span class="live"><span class="dot" aria-hidden="true"></span><span id="updated">reading…</span></span>
  </header>

  <section class="lead">
    <div class="card hero">
      <h2>Next post</h2>
      <div class="figure" id="next-in">&mdash;</div>
      <div class="who" id="next-who"></div>
      <div class="excerpt" id="next-text"></div>
    </div>
    <div class="tiles">
      <div class="card tile"><div class="label">Queued</div><div class="value" id="t-queued">0</div><div class="delta" id="t-queued-d"></div></div>
      <div class="card tile"><div class="label">Sent, 30 days</div><div class="value" id="t-sent">0</div><div class="delta" id="t-sent-d"></div></div>
      <div class="card tile"><div class="label">Delivered</div><div class="value" id="t-rate">&mdash;</div><div class="delta" id="t-rate-d"></div></div>
      <div class="card tile"><div class="label">Networks holding</div><div class="value" id="t-gated">0</div><div class="delta" id="t-gated-d"></div></div>
    </div>
  </section>

  <section class="card full">
    <h2>The drip</h2>
    <p class="note" id="drip-note">Every queued post on its network's lane. The shaded band is the gap a network is still waiting out.</p>
    <ul class="legend" id="drip-legend"></ul>
    <svg id="drip" role="img" aria-label="Queued posts over the coming days, one lane per network"></svg>
  </section>

  <section class="row">
    <div class="card">
      <h2>Posts a day</h2>
      <p class="note">Delivered, last 30 days.</p>
      <svg id="perday" role="img" aria-label="Posts delivered per day over the last 30 days"></svg>
    </div>
    <div class="card">
      <h2>Networks</h2>
      <p class="note" id="net-note">Last post, and when each is free again.</p>
      <div id="networks"></div>
    </div>
  </section>

  <section class="card full">
    <h2>Queue</h2>
    <p class="note">In the order they will go out. <code>myna cancel &lt;id&gt;</code> drops one.</p>
    <div id="queue"></div>
  </section>

  <section class="card full">
    <h2>Recent</h2>
    <p class="note">The last posts myna sent, newest first.</p>
    <div id="history"></div>
  </section>

  <section class="card full">
    <h2>Skills</h2>
    <p class="note">The rules each account posts under, as files an agent can read first. <a href="/skills">/skills</a> lists them; <code>myna skill show &lt;account&gt;</code> prints one.</p>
    <div id="skills"></div>
  </section>

  <section class="card full">
    <h2>Pacing</h2>
    <div id="pacing"></div>
  </section>
</div>
<div class="tip" id="tip" role="tooltip" aria-hidden="true"></div>

<script type="module">
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};
const colour = (slot) => \`var(--series-\${slot})\`;

function dur(ms) {
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return \`\${m}m\`;
  const h = Math.floor(abs / 3600000);
  const rest = Math.round((abs % 3600000) / 60000);
  if (h < 24) return rest ? \`\${h}h \${rest}m\` : \`\${h}h\`;
  const d = Math.floor(abs / 86400000);
  const hrs = Math.round((abs % 86400000) / 3600000);
  return hrs ? \`\${d}d \${hrs}h\` : \`\${d}d\`;
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayLabel = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric" });
const compact = (n) => (n >= 10000 ? \`\${(n / 1000).toFixed(1)}K\` : String(n));
const trim = (text, n = 90) => (text.length > n ? \`\${text.slice(0, n - 1)}…\` : text).replace(/\\s+/g, " ");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const tip = $("tip");
function showTip(event, html) {
  tip.innerHTML = html;
  tip.style.opacity = "1";
  tip.setAttribute("aria-hidden", "false");
  const box = tip.getBoundingClientRect();
  const x = Math.min(event.clientX + 14, window.innerWidth - box.width - 10);
  const y = Math.max(10, event.clientY - box.height - 12);
  tip.style.left = \`\${x}px\`;
  tip.style.top = \`\${y}px\`;
}
function hideTip() {
  tip.style.opacity = "0";
  tip.setAttribute("aria-hidden", "true");
}
/** Marks are small, so the hit target is the mark plus its ring and then some. */
function hoverable(node, html) {
  node.addEventListener("mouseenter", (event) => showTip(event, html));
  node.addEventListener("mousemove", (event) => showTip(event, html));
  node.addEventListener("mouseleave", hideTip);
  node.addEventListener("focus", (event) => showTip({ clientX: node.getBoundingClientRect().x, clientY: node.getBoundingClientRect().y }, html));
  node.addEventListener("blur", hideTip);
}

function statusCell(kind, label) {
  const glyph = kind === "ok" ? "●" : kind === "fail" ? "✕" : "◐";
  return \`<span class="status \${kind}"><span class="glyph" aria-hidden="true">\${glyph}</span>\${esc(label)}</span>\`;
}
const whoCell = (slot, label) =>
  \`<span class="who-cell"><span class="key" style="background:\${colour(slot)}"></span>\${esc(label)}</span>\`;

/* ---------------------------------------------------------------- the drip */
function drawDrip(snap) {
  const svg = $("drip");
  svg.replaceChildren();
  const lanes = snap.networks.filter((n) => n.accounts.length > 0);
  if (!lanes.length) {
    $("drip-note").textContent = "No accounts connected yet. Run: myna login bluesky";
    svg.setAttribute("height", "0");
    return;
  }

  const padL = 96, padR = 16, padT = 10, rowH = 34;
  const width = svg.clientWidth || 900;
  const height = padT + lanes.length * rowH + 26;
  const plot = width - padL - padR;
  const start = snap.now;
  const end = snap.now + snap.horizonMs;
  const x = (t) => padL + ((Math.min(Math.max(t, start), end) - start) / (end - start)) * plot;
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", \`0 0 \${width} \${height}\`);

  // Day gridlines, hairline and solid, behind everything.
  const dayMs = 86400000;
  for (let t = Math.ceil(start / dayMs) * dayMs; t <= end; t += dayMs) {
    svg.append(el("line", { class: "grid-line", x1: x(t), x2: x(t), y1: padT, y2: padT + lanes.length * rowH }));
    const label = el("text", { class: "tick", x: x(t), y: height - 8, "text-anchor": "middle" });
    label.textContent = dayLabel(t);
    svg.append(label);
  }
  svg.append(el("line", { class: "axis-line", x1: padL, x2: width - padR, y1: padT + lanes.length * rowH, y2: padT + lanes.length * rowH }));

  lanes.forEach((lane, index) => {
    const y = padT + index * rowH + rowH / 2;
    const label = el("text", { class: "lane-label", x: 0, y: y + 4 });
    label.textContent = lane.network;
    svg.append(label);

    // The gap this network is still waiting out.
    if (lane.gatedForMs > 0) {
      const band = el("rect", { class: "gate", x: padL, y: y - 11, width: Math.max(2, x(lane.freeAt) - padL), height: 22, rx: 4 });
      hoverable(band, \`<strong>\${esc(lane.network)} is holding</strong><div class="t-when">free in \${dur(lane.gatedForMs)}, at \${clock(lane.freeAt)}</div>\`);
      svg.append(band);
    }

    const posts = snap.queue.filter((row) => row.network === lane.network && row.at <= end);
    for (const row of posts) {
      const dot = el("circle", { class: "dot-mark", cx: x(row.at), cy: y, r: 6, fill: colour(row.slot), tabindex: "0", role: "img" });
      dot.setAttribute("aria-label", \`\${row.accountId} in \${dur(row.inMs)}\`);
      hoverable(
        dot,
        \`<strong>\${esc(row.accountId)}</strong><div class="t-when">\${row.inMs <= 0 ? "due now" : \`in \${dur(row.inMs)}\`} · \${clock(row.at)}</div>\` +
          (row.reason ? \`<div class="t-when">\${esc(row.reason)}</div>\` : "") +
          \`<div class="t-text">\${esc(trim(row.text, 120))}</div>\`,
      );
      svg.append(dot);
    }
  });

  // "Now" last, so it sits above the lanes.
  svg.append(el("line", { class: "now-line", x1: padL, x2: padL, y1: padT - 2, y2: padT + lanes.length * rowH + 2 }));
  const nowLabel = el("text", { class: "tick", x: padL, y: height - 8, "text-anchor": "middle" });
  nowLabel.textContent = "now";
  svg.append(nowLabel);

  // A legend is the dependable identity channel; the lane label repeats it.
  $("drip-legend").innerHTML = lanes
    .map((lane) => \`<li><span class="key" style="background:\${colour(lane.slot)}"></span>\${esc(lane.network)}</li>\`)
    .join("");
  $("drip-note").textContent = snap.queuedCount
    ? \`\${snap.queuedCount} post\${snap.queuedCount === 1 ? "" : "s"} queued over the next \${dur(snap.horizonMs)}. The shaded band is the gap a network is still waiting out.\`
    : "Nothing queued. The shaded band is the gap a network is still waiting out.";
}

/* ------------------------------------------------------------ posts a day */
function drawPerDay(snap) {
  const svg = $("perday");
  svg.replaceChildren();
  const data = snap.perDay;
  const width = svg.clientWidth || 520;
  const padL = 28, padR = 6, padT = 8, padB = 22;
  const height = 150;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const peak = Math.max(1, ...data.map((d) => d.sent));
  const band = plotW / data.length;
  const barW = Math.min(24, Math.max(3, band - 2)); // 2px surface gap between neighbours
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", \`0 0 \${width} \${height}\`);

  for (const value of [0, Math.ceil(peak / 2), peak]) {
    const y = padT + plotH - (value / peak) * plotH;
    svg.append(el("line", { class: value === 0 ? "axis-line" : "grid-line", x1: padL, x2: width - padR, y1: y, y2: y }));
    const tick = el("text", { class: "tick", x: padL - 6, y: y + 4, "text-anchor": "end" });
    tick.textContent = String(value);
    svg.append(tick);
  }

  data.forEach((day, index) => {
    if (!day.sent) return;
    const h = Math.max(2, (day.sent / peak) * plotH);
    const x = padL + index * band + (band - barW) / 2;
    // 4px rounded data-end, square at the baseline.
    const bar = el("rect", { class: "bar", x, y: padT + plotH - h, width: barW, height: h, fill: "var(--series-1)", rx: Math.min(4, barW / 2) });
    hoverable(bar, \`<strong>\${day.sent} sent</strong><div class="t-when">\${esc(day.day)}\${day.failed ? \` · \${day.failed} failed\` : ""}</div>\`);
    svg.append(bar);
  });

  const first = el("text", { class: "tick", x: padL, y: height - 6 });
  first.textContent = data[0]?.day.slice(5) ?? "";
  const last = el("text", { class: "tick", x: width - padR, y: height - 6, "text-anchor": "end" });
  last.textContent = "today";
  svg.append(first, last);
}

/* --------------------------------------------------------------- tables */
function drawNetworks(snap) {
  const rows = snap.networks;
  $("networks").innerHTML = !rows.length
    ? '<p class="empty">No accounts connected yet.</p>'
    : \`<table><thead><tr><th>Network</th><th>Last post</th><th>State</th><th class="num">Sent</th><th class="num">Failed</th></tr></thead><tbody>\${rows
        .map(
          (row) => \`<tr>
            <td>\${whoCell(row.slot, row.network)}</td>
            <td class="when">\${row.lastAt ? \`\${dur(snap.now - row.lastAt)} ago\` : "never"}</td>
            <td>\${row.gatedForMs > 0 ? statusCell("hold", \`free in \${dur(row.gatedForMs)}\`) : statusCell("ok", "free now")}</td>
            <td class="num">\${row.sent}</td>
            <td class="num">\${row.failed || ""}</td>
          </tr>\`,
        )
        .join("")}</tbody></table>\`;
}

function drawQueue(snap) {
  $("queue").innerHTML = !snap.queue.length
    ? '<p class="empty">Nothing queued. A post to several accounts fills this automatically.</p>'
    : \`<table><thead><tr><th>Goes out</th><th>Account</th><th>Why</th><th>Post</th><th>ID</th></tr></thead><tbody>\${snap.queue
        .map(
          (row) => \`<tr>
            <td class="when">\${row.inMs <= 0 ? "due now" : \`in \${dur(row.inMs)}\`}<br><span class="reason">\${clock(row.at)}</span></td>
            <td>\${whoCell(row.slot, row.accountId)}</td>
            <td class="reason">\${esc(row.reason ?? (row.evergreen ? "from the archive" : "dripped"))}</td>
            <td class="text">\${esc(trim(row.text))}</td>
            <td class="reason">\${esc(row.id)}</td>
          </tr>\`,
        )
        .join("")}</tbody></table>\`;
}

function drawHistory(snap) {
  $("history").innerHTML = !snap.history.length
    ? '<p class="empty">Nothing sent yet.</p>'
    : \`<table><thead><tr><th>When</th><th>Account</th><th>Skill</th><th>Result</th><th>Post</th></tr></thead><tbody>\${snap.history
        .slice(0, 20)
        .map(
          (row) => \`<tr>
            <td class="when">\${dur(snap.now - row.at)} ago</td>
            <td>\${whoCell(row.slot, row.accountId)}</td>
            <td class="when">\${esc(row.skill ?? "")}</td>
            <td>\${row.ok ? statusCell("ok", "sent") : statusCell("fail", trim(row.error ?? "failed", 40))}</td>
            <td class="text">\${row.url ? \`<a href="\${esc(row.url)}" target="_blank" rel="noreferrer">\${esc(trim(row.text, 70))}</a>\` : esc(trim(row.text, 70))}</td>
          </tr>\`,
        )
        .join("")}</tbody></table>\`;
}

function drawSkills(snap) {
  const rows = snap.skills ?? [];
  $("skills").innerHTML = !rows.length
    ? '<p class="empty">No accounts connected.</p>'
    : \`<table><thead><tr><th>Account</th><th>Kind</th><th>Skill</th><th>Today</th><th>Limits</th></tr></thead><tbody>\${rows
        .map((row) => {
          const cap = row.maxPerDay !== undefined ? \`\${row.sentToday} of \${row.maxPerDay}\` : String(row.sentToday);
          const full = row.maxPerDay !== undefined && row.sentToday >= row.maxPerDay;
          const limits = [
            row.minGapMinutes !== undefined ? \`gap \${row.minGapMinutes}m\` : "",
            row.maxChars !== undefined ? \`\${row.maxChars} chars\` : "",
            row.contentPolicy ?? "",
          ].filter(Boolean).join(", ");
          return \`<tr>
            <td>\${whoCell(row.slot, row.accountId)}</td>
            <td class="when">\${esc(row.kind)}</td>
            <td class="text"><a href="\${esc(row.path)}">\${esc(row.selected)}</a>\${row.rotating ? " (rotating: " + esc(row.skills.join(" > ")) + ")" : row.skills.length > 1 ? " of " + esc(row.skills.join(", ")) : ""}</td>
            <td>\${full ? statusCell("hold", cap) : statusCell("ok", cap)}</td>
            <td class="text">\${esc(limits)}</td>
          </tr>\`;
        })
        .join("")}</tbody></table>\`;
}

function drawPacing(snap) {
  const ever = snap.evergreen;
  $("pacing").innerHTML = \`<table><thead><tr><th>Rule</th><th>Setting</th><th>What it does</th></tr></thead><tbody>
    <tr><td>Network gap</td><td class="when">\${esc(snap.pacing.minGap)}</td><td class="text">The least time between two posts on one network, whatever the account.</td></tr>
    <tr><td>Drip</td><td class="when">\${esc(snap.pacing.drip)}</td><td class="text">A post aimed at several accounts is spread over this window, one at a time.</td></tr>
    <tr><td>Repost gap</td><td class="when">\${esc(snap.pacing.repostGap)}</td><td class="text">The same text to the same account waits this long.</td></tr>
    <tr><td>Archive</td><td class="when">\${ever.enabled ? esc(ever.every) : "off"}</td><td class="text">\${
      ever.enabled
        ? \`Re-posts an old page from \${esc(ever.from)} to \${esc(ever.to)}\${ever.ad ? ", with a CrawlProof ad" : ""}.\`
        : "Off. Turn it on with: myna evergreen &lt;blog account&gt;"
    }</td></tr>
  </tbody></table>\`;
}

/* ----------------------------------------------------------------- render */
function render(snap) {
  $("next-in").textContent = snap.next ? (snap.next.inMs <= 0 ? "due now" : dur(snap.next.inMs)) : "nothing queued";
  $("next-who").innerHTML = snap.next ? \`\${whoCell(snap.next.slot, snap.next.accountId)} · \${clock(snap.next.at)}\` : "";
  $("next-text").textContent = snap.next ? trim(snap.next.text, 120) : "A post to several accounts is paced automatically.";

  $("t-queued").textContent = compact(snap.queuedCount);
  $("t-queued-d").textContent = snap.queuedCount ? \`across \${new Set(snap.queue.map((r) => r.network)).size} network(s)\` : "nothing waiting";

  $("t-sent").textContent = compact(snap.sent30);
  const delta = snap.sent30 - snap.sentPrev30;
  $("t-sent-d").innerHTML = snap.sentPrev30
    ? \`<span class="\${delta >= 0 ? "up" : "down"}">\${delta >= 0 ? "+" : ""}\${delta}</span> vs the 30 before\`
    : "first 30 days";

  const rate = snap.totals.rate;
  $("t-rate").textContent = rate === null ? "—" : \`\${Math.round(rate * 100)}%\`;
  $("t-rate-d").textContent = snap.totals.failed ? \`\${snap.totals.failed} failed, all time\` : "nothing has failed";

  $("t-gated").textContent = String(snap.gatedCount);
  $("t-gated-d").textContent = snap.gatedCount ? "waiting out the gap" : "all networks free";

  drawDrip(snap);
  drawPerDay(snap);
  drawNetworks(snap);
  drawQueue(snap);
  drawHistory(snap);
  drawSkills(snap);
  drawPacing(snap);
  $("updated").textContent = \`updated \${clock(Date.now())}\`;
}

let latest;
async function refresh() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    latest = await response.json();
    render(latest);
  } catch {
    $("updated").textContent = "myna is not answering";
  }
}
refresh();
setInterval(refresh, 5000);

// The SVGs are sized from their container, so a resize redraws from the data
// already in hand rather than refetching.
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (latest) render(latest); }, 120);
});
</script>
</body>
</html>`;
}
