import { expect, test, describe } from "bun:test";
import {
  DEFAULT_UTM,
  hostMatches,
  hostOf,
  ownedHosts,
  slugifyTag,
  stampLinks,
  stampUrl,
  utmParams,
  type UtmPlan,
} from "../src/core/utm.ts";
import { tailor } from "../src/core/poster.ts";

const plan = (overrides: Partial<UtmPlan> = {}): UtmPlan => ({
  settings: { ...DEFAULT_UTM, ...overrides.settings },
  hosts: overrides.hosts ?? ["example.com"],
  date: overrides.date ?? "2026-09-24",
});

const context = { network: "bluesky", kind: "social", type: "launch-announcement" };

describe("host matching", () => {
  test("reads a host from a URL or a bare domain", () => {
    expect(hostOf("https://Example.com/blog/post?a=1")).toBe("example.com");
    expect(hostOf("example.com")).toBe("example.com");
    expect(hostOf("EXAMPLE.com:8443")).toBe("example.com");
    expect(hostOf("")).toBe("");
    expect(hostOf("not a host at all")).toBe("");
  });

  test("a bare domain covers its subdomains but not a lookalike", () => {
    expect(hostMatches("blog.example.com", "example.com")).toBe(true);
    expect(hostMatches("example.com", "example.com")).toBe(true);
    // The tell of a naive endsWith: a different domain that ends the same way.
    expect(hostMatches("notexample.com", "example.com")).toBe(false);
    expect(hostMatches("example.com.evil.net", "example.com")).toBe(false);
  });

  test("owned hosts come off the accounts that say where they publish", () => {
    expect(
      ownedHosts([
        { meta: { url: "https://blog.example.com" } },
        { meta: { siteUrl: "https://notes.example.org/blog" } },
        { meta: { instance: "https://mastodon.social" } },
        { meta: {} },
        {},
      ]),
    ).toEqual(["blog.example.com", "notes.example.org"]);
  });
});

describe("tag values", () => {
  test("templates fill from the send and slugify", () => {
    expect(utmParams(DEFAULT_UTM, context)).toEqual({
      utm_source: "bluesky",
      utm_medium: "social",
      utm_campaign: "launch-announcement",
    });
  });

  test("a blog and a longform target report the same medium", () => {
    expect(utmParams(DEFAULT_UTM, { ...context, kind: "longform" }).utm_medium).toBe("blog");
    expect(utmParams(DEFAULT_UTM, { ...context, kind: "blog" }).utm_medium).toBe("blog");
  });

  test("an empty value is dropped rather than sent blank", () => {
    expect(utmParams(DEFAULT_UTM, { network: "bluesky", kind: "social" })).toEqual({
      utm_source: "bluesky",
      utm_medium: "social",
    });
  });

  test("slugs are url-safe and bounded", () => {
    expect(slugifyTag("Launch: the Résumé thing!")).toBe("launch-the-resume-thing");
    expect(slugifyTag("a".repeat(80))).toHaveLength(40);
    expect(slugifyTag("///")).toBe("");
  });
});

describe("stamping one url", () => {
  const params = { utm_source: "bluesky", utm_medium: "social" };

  test("tags a host we own", () => {
    const out = stampUrl("https://example.com/post", params, plan());
    expect(out).toBe("https://example.com/post?utm_source=bluesky&utm_medium=social");
  });

  test("leaves a host we do not own alone", () => {
    expect(stampUrl("https://github.com/x/y", params, plan())).toBe("https://github.com/x/y");
  });

  test("keeps an existing query and fragment", () => {
    const out = stampUrl("https://example.com/p?ref=1#section", params, plan());
    expect(out).toContain("ref=1");
    expect(out).toContain("utm_source=bluesky");
    expect(out.endsWith("#section")).toBe(true);
  });

  test("a link already carrying a campaign is left exactly as written", () => {
    const written = "https://example.com/p?utm_source=newsletter";
    expect(stampUrl(written, params, plan())).toBe(written);
  });

  test("an explicit domain widens the list, an exclude narrows it", () => {
    const widened = plan({ settings: { ...DEFAULT_UTM, domains: ["partner.dev"] } });
    expect(stampUrl("https://partner.dev/x", params, widened)).toContain("utm_source");

    const narrowed = plan({ settings: { ...DEFAULT_UTM, exclude: ["example.com"] } });
    expect(stampUrl("https://example.com/x", params, narrowed)).toBe("https://example.com/x");
  });

  test("non-http schemes and unparseable addresses are never rewritten", () => {
    expect(stampUrl("mailto:someone@example.com", params, plan())).toBe("mailto:someone@example.com");
    expect(stampUrl("https://", params, plan())).toBe("https://");
  });
});

describe("stamping the links in a post", () => {
  test("tags ours and skips theirs in one piece of text", () => {
    const text = "Shipped: https://example.com/blog/thing — built on https://github.com/x/y";
    const out = stampLinks(text, plan(), context);
    expect(out).toContain("https://example.com/blog/thing?utm_source=bluesky&utm_medium=social&utm_campaign=launch-announcement");
    expect(out).toContain("https://github.com/x/y");
    expect(out).not.toContain("github.com/x/y?utm");
  });

  test("a full stop after a link stays a full stop", () => {
    const out = stampLinks("Read https://example.com/p.", plan(), context);
    expect(out.endsWith(".")).toBe(true);
    expect(out).toContain("https://example.com/p?utm_source=bluesky");
    // The sentence's full stop must not have been swallowed into the path.
    expect(out).not.toContain("/p.?");
  });

  test("a link inside brackets keeps the closing bracket out of the url", () => {
    const out = stampLinks("(see https://example.com/p)", plan(), context);
    expect(out.endsWith(")")).toBe(true);
    expect(out).not.toContain("p)?utm");
  });

  test("turned off, every link goes out as typed", () => {
    const off = plan({ settings: { ...DEFAULT_UTM, enabled: false } });
    const text = "https://example.com/p";
    expect(stampLinks(text, off, context)).toBe(text);
  });

  test("text with no links is returned untouched", () => {
    expect(stampLinks("no links here", plan(), context)).toBe("no links here");
  });
});

describe("the poster's seam", () => {
  test("tailor tags the links it is given a plan for", () => {
    const [part] = tailor("bluesky", { text: "out now https://example.com/p", type: "launch-announcement" }, plan());
    expect(part).toContain("utm_source=bluesky");
    expect(part).toContain("utm_campaign=launch-announcement");
  });

  test("tailor with no plan sends the text exactly as written", () => {
    const [part] = tailor("bluesky", { text: "out now https://example.com/p" });
    expect(part).toBe("out now https://example.com/p");
  });

  test("a link in the signature is tagged too", () => {
    const [part] = tailor("bluesky", { text: "hello", signature: "— https://example.com/me" }, plan());
    expect(part).toContain("https://example.com/me?utm_source=bluesky");
  });

  test("the tag is counted against the limit, not added after the cut", () => {
    // Bluesky's limit is 300 and a tagged link is longer than a bare one, so a
    // post that only fits untagged must come back cut rather than over-limit.
    const text = `${"x".repeat(250)} https://example.com/a-fairly-long-path-here`;
    const [tagged] = tailor("bluesky", { text, type: "launch-announcement" }, plan());
    expect(tagged!.length).toBeLessThanOrEqual(300);
  });
});
