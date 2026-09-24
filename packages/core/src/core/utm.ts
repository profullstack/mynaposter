/**
 * Campaign tags on the links myna sends.
 *
 * A post that drives a visit is invisible to the site it drove them to unless
 * the link says where it came from. crawlproof's tracker already reads
 * `utm_source`; myna never wrote one, so every send has been unattributable at
 * the far end. This adds the tag at compose time, before the text is measured
 * against a network's character limit, because a tag added after truncation is
 * a tag that can push a post over the limit or get cut in half.
 *
 * Two rules keep it from doing harm. Only hosts you own are stamped — myna
 * reads those off the blog accounts it already has, so the list configures
 * itself — and a URL that already carries any `utm_` parameter is left exactly
 * as written, because a hand-placed campaign tag is a decision, not an
 * oversight.
 *
 * Everything here is a pure function over its arguments: no settings, no
 * vault, no clock. The poster resolves the context once per send and passes it
 * in, which is what makes the compose screen's character counter and the
 * poster's limit check able to agree.
 */

/** How links are tagged. Templates take `{network}`, `{kind}`, `{type}` and `{date}`. */
export interface UtmSettings {
  /** Off means myna sends links exactly as written. */
  enabled: boolean;
  source: string;
  medium: string;
  campaign: string;
  /**
   * Extra hosts to tag, beyond the ones myna can see you own. A bare host
   * matches its subdomains too: "example.com" covers "blog.example.com".
   */
  domains: string[];
  /** Hosts never tagged, whatever else matches. */
  exclude: string[];
}

export const DEFAULT_UTM: UtmSettings = {
  enabled: true,
  source: "{network}",
  medium: "{kind}",
  campaign: "{type}",
  domains: [],
  exclude: [],
};

/** What a template's tokens stand for on one particular send. */
export interface UtmContext {
  /** The network being posted to, e.g. "bluesky". */
  network: string;
  /** The network's skill kind, e.g. "social" or "blog". */
  kind: string;
  /** The post type, e.g. "launch-announcement". */
  type?: string;
  /** YYYY-MM-DD, for a campaign template that wants a date in it. */
  date?: string;
}

/** A resolved tagger: the settings, plus the hosts this send may tag. */
export interface UtmPlan {
  settings: UtmSettings;
  /** Hosts owned by this myna, lower-case, no port. */
  hosts: string[];
  /**
   * YYYY-MM-DD for this send, for a `{date}` in a template. Resolved once by
   * the caller rather than read here, so a tagged post can be tested against a
   * fixed clock.
   */
  date?: string;
}

/**
 * Mediums myna reports, by skill kind. The kinds are myna's own vocabulary and
 * too fine-grained for a report: "longform" and "blog" are one channel to
 * anyone reading a scorecard.
 */
const MEDIUM_BY_KIND: Record<string, string> = {
  blog: "blog",
  longform: "blog",
  youtube: "video",
  forum: "forum",
  social: "social",
  directory: "directory",
};

/** Lower-case host with any port and trailing dot removed. */
function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "").split(":")[0] ?? "";
}

/**
 * The host of a URL, or "" when the value is not one. Accepts a bare host
 * ("example.com") as well as a full URL, so a domain list can be written
 * either way.
 */
export function hostOf(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  // A bare "example.com:8443" parses as a URL whose *scheme* is "example.com",
  // leaving the hostname empty, so an empty hostname is a parse that did not
  // mean what it looked like and falls through to the second attempt.
  try {
    const host = normalizeHost(new URL(raw).hostname);
    if (host) return host;
  } catch {
    // Not a URL on its own; try it as a bare host below.
  }
  try {
    return normalizeHost(new URL(`https://${raw}`).hostname);
  } catch {
    return "";
  }
}

/** Does `host` match `pattern`, counting subdomains as a match? */
export function hostMatches(host: string, pattern: string): boolean {
  const left = normalizeHost(host);
  const right = hostOf(pattern);
  if (!left || !right) return false;
  return left === right || left.endsWith(`.${right}`);
}

/**
 * The hosts this myna can see it owns: every account that told myna where its
 * posts are served. Ghost and WordPress store `meta.url`, gitblog and htmlblog
 * store `meta.siteUrl`. Those are sites you publish to, which is as close to a
 * declaration of ownership as myna has, and it needs no setting up.
 */
export function ownedHosts(accounts: Array<{ meta?: Record<string, string> }>): string[] {
  const hosts = new Set<string>();
  for (const account of accounts) {
    for (const key of ["siteUrl", "url"]) {
      const host = hostOf(account.meta?.[key] ?? "");
      if (host) hosts.add(host);
    }
  }
  return [...hosts].sort();
}

/** Fill `{network}`, `{kind}`, `{type}` and `{date}` in a template. */
export function fillTemplate(template: string, context: UtmContext): string {
  const values: Record<string, string> = {
    network: context.network ?? "",
    kind: MEDIUM_BY_KIND[context.kind ?? ""] ?? context.kind ?? "",
    type: context.type ?? "",
    date: context.date ?? "",
  };
  return template.replace(/\{(\w+)\}/g, (whole, token: string) => values[token] ?? whole);
}

/**
 * A tag value a URL can carry: lower-case, words joined by hyphens, no
 * punctuation that would need escaping and nothing long enough to dominate the
 * link it is attached to.
 */
export function slugifyTag(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** The three tag values for one send, after templates and slugifying. Empty values are dropped. */
export function utmParams(settings: UtmSettings, context: UtmContext): Record<string, string> {
  const params: Record<string, string> = {};
  const source = slugifyTag(fillTemplate(settings.source, context));
  const medium = slugifyTag(fillTemplate(settings.medium, context));
  const campaign = slugifyTag(fillTemplate(settings.campaign, context));
  if (source) params.utm_source = source;
  if (medium) params.utm_medium = medium;
  if (campaign) params.utm_campaign = campaign;
  return params;
}

/**
 * Trailing characters that belong to the sentence rather than to the link.
 * A URL at the end of a line is routinely followed by a full stop, and a URL
 * in brackets by a closing bracket; neither is part of the address.
 */
function trimTrailingPunctuation(url: string): { url: string; trailing: string } {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1]!;
    if (".,;:!?'\"".includes(char)) {
      end--;
      continue;
    }
    // A closing bracket counts only when the URL does not open it itself,
    // which is what keeps a Wikipedia-style URL whole.
    if (char === ")" || char === "]" || char === "}") {
      const open = { ")": "(", "]": "[", "}": "{" }[char]!;
      const opens = url.slice(0, end).split(open).length - 1;
      const closes = url.slice(0, end).split(char).length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return { url: url.slice(0, end), trailing: url.slice(end) };
}

/** Is this a host the plan is allowed to tag? */
export function shouldStamp(host: string, plan: UtmPlan): boolean {
  if (!host) return false;
  if (plan.settings.exclude.some((pattern) => hostMatches(host, pattern))) return false;
  const allowed = [...plan.hosts, ...plan.settings.domains];
  return allowed.some((pattern) => hostMatches(host, pattern));
}

/**
 * Add the tags to one URL. Returns it unchanged when the host is not ours,
 * when the URL already carries a campaign of its own, or when it will not
 * parse — an address myna cannot read is an address it must not rewrite.
 */
export function stampUrl(raw: string, params: Record<string, string>, plan: UtmPlan): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  if (!shouldStamp(url.hostname, plan)) return raw;
  // A link that already says where it came from was tagged on purpose.
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith("utm_")) return raw;
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Every http(s) URL in a piece of text, tagged where it is ours to tag. */
export function stampLinks(text: string, plan: UtmPlan, context: UtmContext): string {
  if (!plan.settings.enabled) return text;
  const params = utmParams(plan.settings, { ...context, date: context.date ?? plan.date });
  if (!Object.keys(params).length) return text;

  return text.replace(/https?:\/\/[^\s<>"'`]+/gi, (match) => {
    const { url, trailing } = trimTrailingPunctuation(match);
    return `${stampUrl(url, params, plan)}${trailing}`;
  });
}
