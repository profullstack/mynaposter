/**
 * The HTML shell a newsletter issue is sent in: a 600px table layout with the
 * brand's logo and name in a dark header, the rendered Markdown on a white
 * card, and the footer in small grey type.
 *
 * Mail clients are the constraint, not taste. Gmail and Outlook drop or
 * rewrite much of a <style> block, so every element the Markdown renderer
 * emits gets its style inline; layout is tables, not flex or grid; and the
 * logo must be a PNG or JPEG at an https URL, because most clients will not
 * show an SVG.
 */
import { escapeHtml } from "../util/markdown.ts";

export interface NewsletterBrand {
  /** Shown beside the logo, and as the logo's alt text. Empty: no header text. */
  name: string;
  /** Where the header links to. */
  url: string;
  /** An https PNG or JPEG. Empty: the header shows the name alone. */
  logoUrl: string;
  /** Links, the rule under headings, and the call to action button. */
  accent: string;
  /** One short line under the name. */
  tagline: string;
}

export const DEFAULT_BRAND: NewsletterBrand = { name: "", url: "", logoUrl: "", accent: "#e5383b", tagline: "" };

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const INK = "#1f2328";
const MUTED = "#6b7280";
const DARK = "#16181d";

/** The accent as a hex colour, or the default: it lands inside style attributes. */
export const safeAccent = (accent: string | undefined): string => (accent && /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : DEFAULT_BRAND.accent);

/** A brand is in use once it has a name or a logo; otherwise the plain layout is kept. */
export const hasBrand = (brand: Partial<NewsletterBrand> | undefined): boolean => Boolean(brand?.name || brand?.logoUrl);

/** Inline styles for the tags renderMarkdown emits, since clients strip <style>. */
export function styleBody(html: string, accent: string): string {
  const styles: Record<string, string> = {
    h1: `margin:32px 0 12px;font-size:26px;line-height:1.25;font-weight:700;color:${INK}`,
    h2: `margin:32px 0 12px;padding-bottom:8px;border-bottom:2px solid ${accent};font-size:21px;line-height:1.3;font-weight:700;color:${INK}`,
    h3: `margin:32px 0 12px;padding-bottom:8px;border-bottom:2px solid ${accent};font-size:19px;line-height:1.3;font-weight:700;color:${INK}`,
    h4: `margin:24px 0 8px;font-size:16px;font-weight:700;color:${INK}`,
    p: `margin:0 0 16px;font-size:16px;line-height:1.6;color:${INK}`,
    ul: "margin:0 0 16px;padding-left:22px",
    ol: "margin:0 0 16px;padding-left:22px",
    li: `margin:0 0 8px;font-size:16px;line-height:1.6;color:${INK}`,
    a: `color:${accent};text-decoration:underline`,
    strong: `font-weight:700;color:${INK}`,
    code: `font-family:${MONO};font-size:14px;background:#f3f4f6;border-radius:4px;padding:1px 5px;color:${INK}`,
    pre: `margin:0 0 16px;padding:14px 16px;background:#f3f4f6;border-radius:6px;overflow:auto;font-family:${MONO};font-size:13px;line-height:1.5`,
    blockquote: `margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid ${accent};color:${MUTED}`,
    hr: "border:0;border-top:1px solid #e5e7eb;margin:28px 0",
    img: "max-width:100%;height:auto;border:0",
  };
  // Only tags with no style yet: the CTA button and the pixel carry their own.
  return html.replace(/<(h[1-4]|p|ul|ol|li|a|strong|code|pre|blockquote|hr|img)(\s[^>]*)?(\/?)>/g, (whole, tag: string, attrs = "", slash: string) => {
    if (/\sstyle=/.test(attrs)) return whole;
    return `<${tag}${attrs} style="${styles[tag]}"${slash}>`;
  });
}

/** Hidden text most clients show beside the subject in the inbox list. */
function preheader(text: string): string {
  if (!text) return "";
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(text)}${"&nbsp;&zwnj;".repeat(40)}</div>`;
}

export interface LayoutParts {
  subject: string;
  /** The rendered, not yet styled, issue body including the CTA button. */
  body: string;
  /** Footer paragraphs as HTML: the reason, the unsubscribe link, the address. */
  footer: string;
  /** First line of the issue, for the inbox preview. */
  preview: string;
  brand: NewsletterBrand;
  /** The open pixel, when tracking is on. */
  pixel?: string;
}

/** The whole document: header, card, footer. */
export function layoutNewsletter(parts: LayoutParts): string {
  const { brand } = parts;
  const accent = safeAccent(brand.accent);
  const link = (inner: string): string => (brand.url ? `<a href="${escapeHtml(brand.url)}" style="color:#ffffff;text-decoration:none">${inner}</a>` : inner);
  const logo = brand.logoUrl
    ? `<td style="padding-right:12px;vertical-align:middle">${link(`<img src="${escapeHtml(brand.logoUrl)}" width="40" height="40" alt="${escapeHtml(brand.name || "logo")}" style="display:block;border:0;border-radius:8px;width:40px;height:40px">`)}</td>`
    : "";
  const name = brand.name
    ? `<td style="vertical-align:middle;font-family:${FONT}">${link(`<span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:.2px">${escapeHtml(brand.name)}</span>`)}${
        brand.tagline ? `<div style="font-size:13px;color:#9ca3af;margin-top:2px">${escapeHtml(brand.tagline)}</div>` : ""
      }</td>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(parts.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#eef0f3">
${preheader(parts.preview)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef0f3">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td style="background:${DARK};border-radius:10px 10px 0 0;padding:20px 28px;border-bottom:3px solid ${accent}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${logo}${name}</tr></table>
</td></tr>
<tr><td style="background:#ffffff;padding:32px 28px 12px;font-family:${FONT}">
${styleBody(parts.body, accent)}
</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 10px 10px;padding:0 28px 28px;font-family:${FONT}">
<div style="border-top:1px solid #e5e7eb;padding-top:18px">${parts.footer}</div>
</td></tr>
</table>
</td></tr>
</table>
${parts.pixel ?? ""}</body>
</html>
`;
}
