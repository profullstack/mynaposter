/**
 * OpenProfile.md: every rule degrades, the Markdown is canonical, and what
 * myna writes it can read back.
 */
import { test, expect } from "bun:test";
import {
  accountUrlFor,
  networkFromUrl,
  parseLimit,
  parseOpenProfile,
  parseRate,
  parseTopics,
  renderOpenProfile,
  topicKey,
  topicsMatch,
} from "../src/core/openprofile.ts";

const ADA = `# Ada Lovelace

- **Kind**: person
- **Handle**: @ada
- **Web**: https://ada.example
- **Pay**: eip155:8453:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
- **PGP**: 0xDEADBEEF

Writes about machines that do not exist yet.

## Accounts

- [Bluesky](https://bsky.app/profile/ada.example)
- [Mastodon](https://mathstodon.xyz/@ada)
- https://github.com/ada
- nostr: npub1abc

## Topics

- computing, mathematics, #babbage
- Analytical Engines

## Reshare

- **Networks**: bluesky, mastodon
- **Topics**: computing, mathematics
- **Rate**: $0.05/reshare
- **Limit**: 3/day
- **Not**: gambling, politics

## Something Else

Kept as written.
`;

test("parses the head: name, kind, handle, web, pay, unknown keys, headline", () => {
  const profile = parseOpenProfile(ADA);
  expect(profile.name).toBe("Ada Lovelace");
  expect(profile.kind).toBe("person");
  expect(profile.handle).toBe("ada");
  expect(profile.web).toBe("https://ada.example");
  expect(profile.pay).toBe("eip155:8453:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  expect(profile.identity.find((pair) => pair.key === "PGP")?.value).toBe("0xDEADBEEF");
  expect(profile.headline).toBe("Writes about machines that do not exist yet.");
});

test("accounts: the URL is the identity and the network comes from the host", () => {
  const profile = parseOpenProfile(ADA);
  expect(profile.accounts.map((account) => account.network)).toEqual(["bluesky", "mastodon", "github", "nostr"]);
  expect(profile.accounts[1]?.url).toBe("https://mathstodon.xyz/@ada");
  expect(profile.accounts[2]?.label).toBe("github.com");
  expect(profile.accounts[3]?.url).toBe("https://njump.me/npub1abc");
});

test("topics: comma lists and bullets, hashes stripped, duplicates folded", () => {
  const profile = parseOpenProfile(ADA);
  expect(profile.topics).toEqual(["computing", "mathematics", "babbage", "Analytical Engines"]);
});

test("reshare terms and unknown sections", () => {
  const profile = parseOpenProfile(ADA);
  expect(profile.reshare).toEqual({
    networks: ["bluesky", "mastodon"],
    topics: ["computing", "mathematics"],
    not: ["gambling", "politics"],
    rateUsd: 0.05,
    perNetwork: false,
    limitPerDay: 3,
  });
  expect(profile.sections.find((section) => section.title === "Something Else")?.markdown).toContain("Kept as written.");
});

test("an agent names its operator; a person has none", () => {
  const agent = parseOpenProfile(`# Athena

- **Kind**: bot

## Operator

- **Name**: Ada Lovelace
- **Profile**: https://ada.example/.well-known/openprofile.md
`);
  expect(agent.kind).toBe("agent");
  expect(agent.operator).toEqual({ name: "Ada Lovelace", profile: "https://ada.example/.well-known/openprofile.md" });
  expect(parseOpenProfile(ADA).operator).toBeNull();
});

test("a name alone is a profile, and no name still parses", () => {
  expect(parseOpenProfile("# Ada\n")).toMatchObject({ name: "Ada", kind: null, headline: null, accounts: [], topics: [], reshare: null });
  expect(parseOpenProfile("just prose\n").name).toBeNull();
  expect(parseOpenProfile("").markdown).toBe("");
});

test("topics match loosely: case, hyphens, plurals, prefixes of four or more", () => {
  expect(topicKey("#Machine-Learning")).toBe("machine learning");
  expect(topicsMatch("Machine Learning", "machine-learnings")).toBe(true);
  expect(topicsMatch("rust", "rustlang")).toBe(true);
  expect(topicsMatch("go", "golang")).toBe(false);
  expect(topicsMatch("devtools", "developer tools")).toBe(false);
  expect(topicsMatch("", "anything")).toBe(false);
});

test("rates and limits in the ways people write them", () => {
  expect(parseRate("free")).toEqual({ usd: 0, perNetwork: false });
  expect(parseRate("$0.05/reshare")).toEqual({ usd: 0.05, perNetwork: false });
  expect(parseRate("$0.10 per reshare per network")).toEqual({ usd: 0.1, perNetwork: true });
  expect(parseRate("5 cents")).toEqual({ usd: 0.05, perNetwork: false });
  expect(parseLimit("3/day")).toBe(3);
  expect(parseLimit("14 per week")).toBe(2);
  expect(parseLimit("lots")).toBeNull();
});

test("hosts myna knows, and a label for the rest", () => {
  expect(networkFromUrl("https://bsky.app/profile/x")).toBe("bluesky");
  expect(networkFromUrl("https://twitter.com/x")).toBe("x");
  expect(networkFromUrl("https://mastodon.social/@x")).toBe("mastodon");
  expect(networkFromUrl("https://example.org/me", "Blog")).toBe("blog");
  expect(networkFromUrl("not a url", "Blog")).toBe("blog");
  expect(accountUrlFor("mastodon", "ada", { instance: "https://mathstodon.xyz" })).toBe("https://mathstodon.xyz/@ada");
  expect(accountUrlFor("mastodon", "ada", {})).toBeNull();
  expect(accountUrlFor("slack", "ada", {})).toBeNull();
});

test("render then parse round-trips what myna writes", () => {
  const markdown = renderOpenProfile({
    name: "Ada",
    kind: "agent",
    handle: "ada",
    web: "https://ada.example",
    pay: "eip155:8453:0xabc",
    headline: "First line only\nsecond line dropped",
    accounts: [
      { network: "bluesky", handle: "ada.example", meta: {} },
      { network: "mastodon", handle: "ada", meta: { instance: "https://mathstodon.xyz" } },
      { network: "tsbb", handle: "ada", meta: {} },
    ],
    topics: ["computing", "mathematics"],
    reshare: { networks: ["bluesky"], topics: [], not: ["politics"], rateUsd: 0.05, limitPerDay: 3 },
    operator: { name: "Ada Lovelace", email: "ada@example.com" },
  });
  expect(markdown).toContain("- **Handle**: @ada");
  expect(markdown).toContain("- [Bluesky](https://bsky.app/profile/ada.example)");
  expect(markdown).toContain("- tsbb: ada");
  expect(markdown).toContain("- **Rate**: $0.05/reshare");

  const back = parseOpenProfile(markdown);
  expect(back.name).toBe("Ada");
  expect(back.kind).toBe("agent");
  expect(back.headline).toBe("First line only");
  expect(back.topics).toEqual(["computing", "mathematics"]);
  expect(back.reshare?.networks).toEqual(["bluesky"]);
  expect(back.reshare?.not).toEqual(["politics"]);
  expect(back.reshare?.rateUsd).toBe(0.05);
  expect(back.reshare?.limitPerDay).toBe(3);
  expect(back.operator).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  expect(back.accounts.map((account) => account.network)).toEqual(["bluesky", "mastodon", "tsbb"]);
});

test("parseTopics ignores headings and empty lines", () => {
  expect(parseTopics("## Topics\n\n- a, b\n\n- #c\n")).toEqual(["a", "b", "c"]);
});
