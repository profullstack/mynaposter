import { describe, expect, test } from "bun:test";
import {
  accounts,
  applyOverrides,
  broadcasts,
  guest,
  identityKeys,
  identityValue,
  keyedSection,
  kindOf,
  listSection,
  makeOpenProfile,
  mergeOverrides,
  mergeProfiles,
  networkOf,
  normaliseSection,
  normaliseUrl,
  overridesFromDocument,
  parseOpenProfile,
  renderOpenProfile,
  samePerson,
  sectionKeys,
  topics,
} from "../src/index.ts";

const ADA = `# Ada Lovelace

- **Kind**: person
- **Handle**: @ada
- **Web**: https://ada.example
- **Email**: ada@example.com
- **Avatar**: https://ada.example/ada.jpg
- **Pay**: eip155:8453:0xabc

Wrote the first program for a machine that was never built.

## Find me

- [Bluesky](https://bsky.app/profile/ada.example)
- https://github.com/ada
- mastodon: @ada@hachyderm.io

## Topics

- computing history
- #Mathematics, women in science

## Broadcast

- **Show**: The Analytical Engine
- **Kind**: podcast
- **Feed**: https://ada.example/podcast/feed.xml
- **Topics**: computing history

## Guest

- **Available**: yes
- **Expertise**: analytical engines, early computing
- **Not**: crypto

## Colophon

Set in Baskerville.
`;

describe("parse", () => {
  test("the nine rules, on the spec's own example", () => {
    const doc = parseOpenProfile(ADA);
    expect(doc.name).toBe("Ada Lovelace");
    expect(identityValue(doc, "kind")).toBe("person");
    expect(identityValue(doc, "Web")).toBe("https://ada.example");
    expect(kindOf(doc)).toBe("person");
    expect(doc.headline).toBe("Wrote the first program for a machine that was never built.");
    expect(doc.sections.map((s) => s.name)).toEqual(["accounts", "topics", "broadcast", "guest", "colophon"]);
    expect(doc.sections[0]!.title).toBe("Find me");
    expect(doc.sections[4]!.body).toBe("Set in Baskerville.");
  });

  test("accounts: the URL is the identity, the label is only what to call it", () => {
    const a = accounts(parseOpenProfile(ADA));
    expect(a).toEqual([
      { url: "https://bsky.app/profile/ada.example", label: "Bluesky" },
      { url: "https://github.com/ada", label: null },
      { url: "mastodon:@ada@hachyderm.io", label: "mastodon" },
    ]);
  });

  test("topics: lowercased, # stripped, comma lines split", () => {
    expect(topics(parseOpenProfile(ADA))).toEqual(["computing history", "mathematics", "women in science"]);
  });

  test("nothing is required: a name and a line is a profile, and an empty string parses", () => {
    const doc = parseOpenProfile("# Bob\n\nJust Bob.\n");
    expect(doc.name).toBe("Bob");
    expect(doc.identity).toEqual([]);
    expect(doc.headline).toBe("Just Bob.");
    expect(parseOpenProfile("").name).toBeNull();
  });

  test("kind aliases and absence", () => {
    expect(kindOf(parseOpenProfile("# A\n\n- Kind: bot\n"))).toBe("agent");
    expect(kindOf(parseOpenProfile("# A\n\n- Kind: org\n"))).toBe("organization");
    expect(kindOf(parseOpenProfile("# A\n"))).toBeNull();
  });

  test("section names normalise; unknown ones keep their own", () => {
    expect(normaliseSection("Elsewhere")).toBe("accounts");
    expect(normaliseSection("Looking for")).toBe("match");
    expect(normaliseSection("**Shows**")).toBe("broadcast");
    expect(normaliseSection("My Recipes")).toBe("my-recipes");
  });

  test("broadcast and guest keys, and ### show groups", () => {
    const doc = parseOpenProfile(ADA);
    expect(broadcasts(doc)).toEqual([
      { Show: "The Analytical Engine", Kind: "podcast", Feed: "https://ada.example/podcast/feed.xml", Topics: "computing history" },
    ]);
    expect(guest(doc)?.Expertise).toBe("analytical engines, early computing");
    const two = parseOpenProfile("# H\n\n## Broadcast\n\n### One\n\n- **Feed**: https://a/1\n\n### Two\n\n- **Feed**: https://a/2\n");
    expect(broadcasts(two).map((b) => b.Show)).toEqual(["One", "Two"]);
  });
});

describe("render", () => {
  test("parse then render is stable, known sections first in spec order", () => {
    const once = renderOpenProfile(parseOpenProfile(ADA));
    const twice = renderOpenProfile(parseOpenProfile(once));
    expect(twice).toBe(once);
    expect(once.indexOf("## Find me")).toBeLessThan(once.indexOf("## Topics"));
    expect(once.indexOf("## Guest")).toBeLessThan(once.indexOf("## Colophon"));
    expect(once).toContain("- **Pay**: eip155:8453:0xabc");
  });

  test("absence is unstated: empty values and empty sections are not written", () => {
    const doc = makeOpenProfile({
      name: "Show Host",
      identity: { Kind: "person", Web: "", Email: null, Avatar: undefined },
      headline: "",
      sections: [keyedSection("Broadcast", { Show: "X", Seeking: null, Pays: "" }), listSection("Topics", []), listSection("Accounts", ["https://a.example", ""])],
    });
    const md = renderOpenProfile(doc);
    expect(md).toBe("# Show Host\n\n- **Kind**: person\n\n## Accounts\n\n- https://a.example\n\n## Broadcast\n\n- **Show**: X\n");
  });
});

describe("identity", () => {
  test("normaliseUrl: scheme, www, trailing slash, tracking and case fall away", () => {
    expect(normaliseUrl("HTTPS://www.GitHub.com/Ada/?utm_source=x")).toBe("github.com/ada");
    expect(normaliseUrl("http://ada.example/")).toBe("ada.example");
    expect(normaliseUrl("ada.example")).toBe("ada.example");
    expect(normaliseUrl("bluesky:@ada.example")).toBe("bluesky:ada.example");
  });

  test("identity keys and samePerson: a shared account merges, a shared name never does", () => {
    const a = parseOpenProfile(ADA);
    const b = parseOpenProfile("# Ada Lovelace\n\n- Web: https://other.example\n\n## Accounts\n\n- https://GitHub.com/ada/\n");
    const c = parseOpenProfile("# Ada Lovelace\n\n- Web: https://third.example\n");
    expect(identityKeys(a)).toContain("account:github.com/ada");
    expect(identityKeys(a)).toContain("email:ada@example.com");
    expect(samePerson(a, b)).toBe(true);
    expect(samePerson(a, c)).toBe(false);
  });

  test("web and account keys for the same page meet", () => {
    const a = parseOpenProfile("# A\n\n- Web: https://ada.example\n");
    const b = parseOpenProfile("# B\n\n## Accounts\n\n- https://ada.example/\n");
    expect(samePerson(a, b)).toBe(true);
  });

  test("networkOf knows the usual hosts and degrades to null", () => {
    expect(networkOf("https://bsky.app/profile/ada.example")).toBe("bluesky");
    expect(networkOf("https://hachyderm.io/@ada")).toBe("mastodon");
    expect(networkOf("https://ada.example")).toBeNull();
  });
});

describe("overrides", () => {
  const generated = parseOpenProfile(ADA);

  test("the owner's sections win, untouched ones are still generated, `none` removes", () => {
    const doc = applyOverrides(generated, {
      headline: "Countess, programmer.",
      identity: { Email: null, Location: "London" },
      sections: { guest: "- **Available**: selectively\n- **Rate**: free", colophon: "none", Topics: "- engines" },
    });
    expect(doc.headline).toBe("Countess, programmer.");
    expect(identityValue(doc, "Email")).toBeNull();
    expect(identityValue(doc, "Location")).toBe("London");
    expect(doc.sections.map((s) => s.name)).toEqual(["accounts", "topics", "broadcast", "guest"]);
    expect(guest(doc)?.Rate).toBe("free");
    expect(topics(doc)).toEqual(["engines"]);
    // The generated document is untouched.
    expect(generated.sections.length).toBe(5);
  });

  test("a whole edited file is an overlay, and a removed identity key stays removed", () => {
    const edited = renderOpenProfile(applyOverrides(generated, { identity: { Email: null } })).replace("## Colophon\n\nSet in Baskerville.\n", "");
    const o = overridesFromDocument(edited, generated);
    expect(o.identity?.Email).toBeNull();
    expect(o.sections?.colophon).toBeUndefined();
    const dropped = overridesFromDocument(edited, generated, true);
    expect(dropped.sections?.colophon).toBe("none");
    const rendered = renderOpenProfile(applyOverrides(generated, o));
    expect(rendered).toContain("## Colophon");
    expect(rendered).not.toContain("Email");
  });

  test("a section written twice in an edited file keeps both bodies", () => {
    const o = overridesFromDocument("# A\n\n## Broadcast\n\n- **Show**: One\n- **Feed**: https://a/1\n\n## Broadcast\n\n- **Seeking**: guests\n");
    expect(o.sections?.broadcast).toBe("- **Show**: One\n- **Feed**: https://a/1\n\n- **Seeking**: guests");
    const shown = applyOverrides(parseOpenProfile("# A\n\n## Broadcast\n\n- **Show**: Old\n"), o);
    expect(sectionKeys(shown.sections[0]!.body)).toEqual({ Show: "One", Feed: "https://a/1", Seeking: "guests" });
  });

  test("mergeOverrides: the patch wins key by key and section names normalise", () => {
    const m = mergeOverrides({ sections: { "Find me": "- a" }, identity: { Web: "x" } }, { sections: { accounts: "- b" }, identity: { Kind: "person" } });
    expect(m.sections).toEqual({ accounts: "- b" });
    expect(m.identity).toEqual({ Web: "x", Kind: "person" });
  });
});

describe("mergeProfiles", () => {
  test("two apps, one person: union accounts and topics, shows kept apart, first identity wins", () => {
    const fromPodcasts = parseOpenProfile(
      "# Ada\n\n- Kind: person\n- Web: https://ada.example\n\nHost.\n\n## Accounts\n\n- https://github.com/ada\n\n## Topics\n\n- history\n\n## Broadcast\n\n- **Show**: The Analytical Engine\n- **Feed**: https://ada.example/feed.xml\n",
    );
    const fromCrm = parseOpenProfile(
      "# Ada Lovelace\n\n- Web: https://ada.example/\n- Location: London\n\n## Accounts\n\n- https://GitHub.com/ada/\n- https://bsky.app/profile/ada.example\n\n## Topics\n\n- History\n- maths\n\n## Broadcast\n\n- **Show**: Late Night Engines\n- **Feed**: https://ada.example/late.xml\n",
    );
    expect(samePerson(fromPodcasts, fromCrm)).toBe(true);
    const merged = mergeProfiles([fromPodcasts, fromCrm]);
    expect(merged.name).toBe("Ada");
    expect(identityValue(merged, "Location")).toBe("London");
    expect(accounts(merged).map((a) => a.url)).toEqual(["https://github.com/ada", "https://bsky.app/profile/ada.example"]);
    expect(topics(merged)).toEqual(["history", "maths"]);
    expect(broadcasts(merged).map((b) => b.Show)).toEqual(["The Analytical Engine", "Late Night Engines"]);
    const md = renderOpenProfile(merged);
    expect(md).toContain("### The Analytical Engine");
    expect(md).toContain("### Late Night Engines");
  });

  test("the same show from two apps is one group", () => {
    const a = parseOpenProfile("# A\n\n## Broadcast\n\n- **Show**: X\n- **Feed**: https://a.example/feed\n");
    const b = parseOpenProfile("# A\n\n## Broadcast\n\n- **Show**: X (mirror)\n- **Feed**: https://A.example/feed/\n");
    expect(broadcasts(mergeProfiles([a, b])).length).toBe(1);
  });
});
