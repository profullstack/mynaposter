/**
 * Infographic rendering.
 *
 * Three backends, and the default is deliberate. An image model asked to draw
 * a chart with labels will rewrite the labels — invented figures, misspelled
 * names, quotes nobody said. So the model picks the words and myna draws them:
 * the text on the graphic is byte-for-byte the text in the copy.
 *
 *   svg    built-in template. Offline, exact, no AI.
 *   html   the model writes HTML/CSS, Chrome renders it. Real text, better design.
 *   image  a generation model draws the whole thing. For illustration only.
 */
import type { InfographicCopy } from "../ai/writer.ts";
import { loadSettings } from "../store/settings.ts";
import { rasterize } from "./raster.ts";
import { generateImage } from "../ai/openai.ts";

export type InfographicStyle = "svg" | "html" | "image";

export interface RenderOptions {
  width?: number;
  height?: number;
  accent?: string;
  background?: string;
  scale?: number;
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Break text into lines that fit a pixel width.
 * SVG has no text wrapping, so this estimates advance width from the character
 * mix — wide glyphs and caps cost more than an i or an l.
 */
function wrap(text: string, maxWidth: number, fontSize: number): string[] {
  const estimate = (value: string): number => {
    let width = 0;
    for (const char of value) {
      if (/[iIl.,:;'`|!]/.test(char)) width += fontSize * 0.28;
      else if (/[mwMW@]/.test(char)) width += fontSize * 0.92;
      else if (/[A-Z0-9]/.test(char)) width += fontSize * 0.62;
      else width += fontSize * 0.53;
    }
    return width;
  };

  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimate(candidate) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** The built-in template: title, optional subtitle, a column of points, a footer rule. */
export function renderSvg(copy: InfographicCopy, options: RenderOptions = {}): string {
  const settings = loadSettings();
  const width = options.width ?? 1200;
  const height = options.height ?? 1200;
  const accent = options.accent ?? settings.infographic.accent;
  const background = options.background ?? settings.infographic.background;

  const pad = Math.round(width * 0.075);
  const inner = width - pad * 2;
  const font = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

  const titleSize = Math.round(width * 0.062);
  const titleLines = wrap(copy.title, inner, titleSize);
  const subtitleSize = Math.round(width * 0.029);
  const subtitleLines = copy.subtitle ? wrap(copy.subtitle, inner, subtitleSize) : [];

  let y = pad + titleSize;
  const parts: string[] = [];

  parts.push(`<rect width="${width}" height="${height}" fill="${escapeXml(background)}"/>`);
  parts.push(
    `<rect x="0" y="0" width="${width}" height="${Math.round(height * 0.008)}" fill="url(#accentBar)"/>`,
  );

  for (const line of titleLines) {
    parts.push(
      `<text x="${pad}" y="${y}" font-family="${font}" font-size="${titleSize}" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`,
    );
    y += Math.round(titleSize * 1.16);
  }

  if (subtitleLines.length) {
    y += Math.round(titleSize * 0.18);
    for (const line of subtitleLines) {
      parts.push(
        `<text x="${pad}" y="${y}" font-family="${font}" font-size="${subtitleSize}" fill="#93a4bd">${escapeXml(line)}</text>`,
      );
      y += Math.round(subtitleSize * 1.35);
    }
  }

  y += Math.round(height * 0.045);

  // Points share the remaining vertical space evenly, so 3 and 6 both look right.
  const footerY = height - pad;
  const available = footerY - y - Math.round(height * 0.06);
  const count = Math.max(copy.points.length, 1);
  const rowHeight = Math.min(Math.round(available / count), Math.round(height * 0.16));
  const labelSize = Math.round(width * 0.03);
  const valueSize = Math.round(width * 0.044);

  copy.points.forEach((point, index) => {
    const top = y + index * rowHeight;
    const centre = top + Math.round(rowHeight * 0.42);

    parts.push(
      `<rect x="${pad}" y="${top + Math.round(rowHeight * 0.12)}" width="${Math.round(width * 0.006)}" ` +
        `height="${Math.round(rowHeight * 0.56)}" rx="${Math.round(width * 0.003)}" fill="${escapeXml(accent)}"/>`,
    );

    const textX = pad + Math.round(width * 0.032);
    if (point.value) {
      parts.push(
        `<text x="${textX}" y="${centre}" font-family="${font}" font-size="${valueSize}" font-weight="700" ` +
          `fill="${escapeXml(accent)}">${escapeXml(point.value)}</text>`,
      );
      const labelLines = wrap(point.label, inner - Math.round(width * 0.04), labelSize).slice(0, 2);
      labelLines.forEach((line, lineIndex) => {
        parts.push(
          `<text x="${textX}" y="${centre + Math.round(valueSize * 0.85) + lineIndex * Math.round(labelSize * 1.3)}" ` +
            `font-family="${font}" font-size="${labelSize}" fill="#c7d3e3">${escapeXml(line)}</text>`,
        );
      });
    } else {
      const labelLines = wrap(point.label, inner - Math.round(width * 0.04), labelSize).slice(0, 3);
      labelLines.forEach((line, lineIndex) => {
        parts.push(
          `<text x="${textX}" y="${centre + lineIndex * Math.round(labelSize * 1.35)}" font-family="${font}" ` +
            `font-size="${labelSize}" fill="#e6edf3">${escapeXml(line)}</text>`,
        );
      });
    }
  });

  const footer = copy.footer || settings.infographic.footer;
  if (footer) {
    parts.push(
      `<line x1="${pad}" y1="${footerY - Math.round(height * 0.032)}" x2="${width - pad}" ` +
        `y2="${footerY - Math.round(height * 0.032)}" stroke="#1e2a3d" stroke-width="2"/>`,
    );
    parts.push(
      `<text x="${pad}" y="${footerY}" font-family="${font}" font-size="${Math.round(width * 0.021)}" ` +
        `fill="#6b7c93">${escapeXml(footer)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="accentBar" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0%" stop-color="${escapeXml(accent)}"/>`,
    `<stop offset="100%" stop-color="${escapeXml(accent)}" stop-opacity="0.15"/>`,
    `</linearGradient></defs>`,
    ...parts,
    `</svg>`,
  ].join("");
}

/** Wrap AI-authored HTML in a fixed-size document so the screenshot is deterministic. */
export function wrapHtml(body: string, options: RenderOptions = {}): string {
  const width = options.width ?? 1200;
  const height = options.height ?? 1200;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{width:${width}px;height:${height}px;overflow:hidden;background:${options.background ?? "#0b1020"}}
    body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
  </style></head><body>${body}</body></html>`;
}

export interface InfographicResult {
  png: Uint8Array;
  /** The vector source, when the backend produced one. */
  svg?: string;
  html?: string;
}

export async function renderInfographic(
  copy: InfographicCopy,
  style: InfographicStyle,
  options: RenderOptions = {},
  htmlBody?: string,
): Promise<InfographicResult> {
  const width = options.width ?? 1200;
  const height = options.height ?? 1200;

  if (style === "image") {
    const prompt = [
      `A clean, modern infographic poster titled "${copy.title}".`,
      copy.subtitle && `Subtitle: ${copy.subtitle}.`,
      `Points: ${copy.points.map((point) => `${point.value ? `${point.value} — ` : ""}${point.label}`).join("; ")}.`,
      `Dark background, one accent colour, generous whitespace, flat vector style, no photographs.`,
      `Render all text exactly as written above, spelled correctly.`,
    ]
      .filter(Boolean)
      .join(" ");
    return { png: await generateImage(prompt, width === height ? "1024x1024" : "1536x1024") };
  }

  const background = options.background ?? loadSettings().infographic.background;

  if (style === "html") {
    if (!htmlBody) throw new Error("The html backend needs markup — call the writer for it first.");
    const html = wrapHtml(htmlBody, { width, height, background });
    return { png: rasterize(html, { width, height, scale: options.scale ?? 2, background }, true), html };
  }

  const svg = renderSvg(copy, options);
  return { png: rasterize(svg, { width, height, scale: options.scale ?? 2, background }), svg };
}
