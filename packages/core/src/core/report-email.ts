/**
 * The house look for a report email: the palette and parts fleet-nightly and
 * gh-pulse are drawn with, so a myna recap sits next to them in an inbox and
 * reads as one family.
 *
 * Email HTML only. Table layout and inline styles throughout, because Gmail,
 * Outlook and Apple Mail agree on almost nothing else: no stylesheet, no
 * script, no flexbox, and every chart is table cells, so a client that blocks
 * images still draws it. Every part is a pure function returning a string.
 */

export const INK = "#0b0b0b";
export const MUTE = "#52514e";
export const FAINT = "#c9c8c2";
export const LINE = "#e6e5e1";
export const PAPER = "#fcfcfb";
export const PAGE = "#f4f4f2";
export const UP = "#1a7f37";
export const DOWN = "#b42318";
export const BLUE = "#2a78d6";
export const BLUE_SOFT = "#9dbfee";
/** Heat strip shades, lightest to darkest. Zero gets PAGE, not the first step. */
export const RAMP = ["#eef3fb", "#c9dbf5", "#9dbfee", "#6ba0e4", "#2a78d6"];

const FONT = "-apple-system,Segoe UI,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const num = (value: number): string => value.toLocaleString("en-US");
export const signed = (value: number): string => (value > 0 ? `+${num(value)}` : value < 0 ? `−${num(-value)}` : "±0");

/** Percent change, or "" when there is no base to divide by. */
export function pct(cur: number, prev: number): string {
  if (!prev) return "";
  const p = Math.round(((cur - prev) / prev) * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : "±"}${Math.abs(p)}%`;
}

/** "+12 (+40%)" in green, red or grey. `invert` for counts where fewer is better. */
export function delta(cur: number, prev: number, opts: { big?: boolean; invert?: boolean } = {}): string {
  const d = cur - prev;
  const good = opts.invert ? d < 0 : d > 0;
  const color = d === 0 ? MUTE : good ? UP : DOWN;
  const p = pct(cur, prev);
  return `<span style="color:${color};font-size:${opts.big ? 12 : 11}px;white-space:nowrap">${signed(d)}${p ? ` (${p})` : ""}</span>`;
}

export interface Tile {
  label: string;
  value: number;
  prev?: number;
  /** "vs Wed", "vs yesterday". Shown after the delta. */
  against?: string;
  sub?: string;
  invert?: boolean;
}

/** One summary tile: label, the number, the delta, a line of context. */
export function tile(t: Tile, width: string): string {
  const change =
    t.prev === undefined
      ? ""
      : `<div>${delta(t.value, t.prev, { big: true, invert: t.invert })}${t.against ? ` <span style="font-size:11px;color:${MUTE}">${esc(t.against)}</span>` : ""}</div>`;
  return (
    `<td style="padding:10px 12px;border:1px solid ${LINE};border-radius:8px;vertical-align:top;width:${width};background:#fff">` +
    `<div style="font-size:11px;color:${MUTE};text-transform:uppercase;letter-spacing:.04em">${esc(t.label)}</div>` +
    `<div style="font-size:24px;font-weight:600;color:${INK};line-height:1.2">${num(t.value)}</div>` +
    change +
    (t.sub ? `<div style="font-size:11px;color:${MUTE};margin-top:2px">${t.sub}</div>` : "") +
    "</td>"
  );
}

export function tiles(list: Tile[]): string {
  const width = `${Math.floor(100 / list.length)}%`;
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:14px -6px 0;border-collapse:separate"><tr>` +
    list.map((t) => tile(t, width)).join("") +
    "</tr></table>"
  );
}

/** Seven small cells, shaded on the row's own scale so a quiet row still shows its shape. */
export function heatStrip(values: { label: string; value: number }[]): string {
  const max = Math.max(1, ...values.map((v) => v.value));
  const cells = values
    .map(({ label, value }) => {
      const shade = value === 0 ? PAGE : RAMP[Math.min(4, Math.ceil((value / max) * 4))];
      return `<td title="${esc(label)}: ${num(value)}" style="width:9px;height:14px;background:${shade};border-right:1px solid ${PAPER};font-size:0;line-height:0">&nbsp;</td>`;
    })
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:3px;overflow:hidden"><tr>${cells}</tr></table>`;
}

export interface Bar {
  label: string;
  value: number;
  /** Muted text after the number: "· 2 failed". Already escaped HTML. */
  note?: string;
  /** The bar for the period the report is about: darker and bold. */
  current?: boolean;
}

/** A horizontal bar per row, scaled to the largest. */
export function bars(list: Bar[], unit: string): string {
  const max = Math.max(1, ...list.map((b) => b.value));
  const rows = list
    .map((b) => {
      const w = Math.max(1, Math.round((b.value / max) * 100));
      return (
        `<tr><td style="padding:2px 10px 2px 0;font-size:12px;color:${b.current ? INK : MUTE};white-space:nowrap;font-weight:${b.current ? 600 : 400}">${esc(b.label)}</td>` +
        `<td style="width:100%;padding:2px 0"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%"><tr>` +
        (b.value
          ? `<td style="width:${w}%;background:${b.current ? BLUE : BLUE_SOFT};height:10px;border-radius:3px;font-size:0;line-height:0">&nbsp;</td>`
          : `<td style="width:1%;background:${LINE};height:10px;border-radius:3px;font-size:0;line-height:0">&nbsp;</td>`) +
        `<td style="font-size:12px;color:${INK};padding-left:8px;white-space:nowrap">${num(b.value)}<span style="color:${MUTE}"> ${esc(unit)}${b.note ?? ""}</span></td><td></td></tr></table></td></tr>`
      );
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>`;
}

export const heading = (text: string, count?: number): string =>
  `<div style="font-size:15px;font-weight:700;margin:22px 0 6px">${esc(text)}${count === undefined ? "" : ` <span style="color:${MUTE};font-weight:400">${num(count)}</span>`}</div>`;

export const th = (label: string, align: "left" | "right" = "right"): string =>
  `<th style="padding:6px 6px;text-align:${align};font-size:11px;color:${MUTE};font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid ${LINE};white-space:nowrap">${esc(label)}</th>`;

export const td = (html: string, opts: { align?: "left" | "right"; style?: string } = {}): string =>
  `<td style="padding:7px 6px;text-align:${opts.align ?? "right"};border-bottom:1px solid ${LINE};vertical-align:top;${opts.style ?? ""}">${html}</td>`;

/** A number with its change under it; a quiet zero on both days fades out. */
export function metric(cur: number, prev?: number, opts: { bold?: boolean; invert?: boolean } = {}): string {
  const dim = cur === 0 && !prev;
  return td(
    `<div style="font-weight:${opts.bold ? 600 : 500};color:${dim ? FAINT : INK}">${num(cur)}</div>` +
      (dim || prev === undefined ? "" : `<div>${delta(cur, prev, { invert: opts.invert })}</div>`),
    { style: "white-space:nowrap" },
  );
}

/** A small rounded label: a network, a place. */
export const chip = (text: string, color = MUTE): string =>
  `<span style="display:inline-block;padding:1px 7px;border:1px solid ${LINE};border-radius:10px;font-size:11px;color:${color};background:#fff;white-space:nowrap">${esc(text)}</span>`;

/**
 * A button that survives Outlook: the colour is on the cell, not the link, so
 * a client that ignores padding on inline elements still draws a block.
 */
export const button = (label: string, href: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr><td style="background:${BLUE};border-radius:6px">` +
  `<a href="${esc(href)}" style="display:inline-block;padding:8px 14px;font-size:13px;font-weight:600;color:#fff;text-decoration:none;white-space:nowrap">${esc(label)}</a>` +
  "</td></tr></table>";

export const code = (text: string): string =>
  `<code style="font-family:${MONO};font-size:12px;background:${PAGE};border:1px solid ${LINE};border-radius:4px;padding:1px 5px;color:${INK}">${esc(text)}</code>`;

export interface Page {
  title: string;
  subtitle?: string;
  body: string;
  /** Small print under a rule at the bottom. Already HTML. */
  footer?: string;
  /** What an inbox list shows next to the subject. Hidden in the body. */
  preheader?: string;
}

/** The frame: grey page, one 760px card, title and subtitle, then the body. */
export function page(p: Page): string {
  const preheader = p.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE}">${esc(p.preheader)}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(p.title)}</title></head>
<body style="margin:0;padding:0;background:${PAGE}">${preheader}
<div style="background:${PAGE};padding:16px 8px;font-family:${FONT};color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;margin:0 auto;background:${PAPER};border-radius:10px"><tr><td style="padding:20px 22px">
<div style="font-size:20px;font-weight:700">${esc(p.title)}</div>
${p.subtitle ? `<div style="font-size:13px;color:${MUTE};margin-top:2px">${p.subtitle}</div>` : ""}
${p.body}
${p.footer ? `<div style="font-size:11px;color:${MUTE};margin-top:22px;border-top:1px solid ${LINE};padding-top:8px">${p.footer}</div>` : ""}
</td></tr></table></div></body></html>`;
}
