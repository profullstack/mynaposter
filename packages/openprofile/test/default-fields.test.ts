import { describe, expect, test } from "bun:test";
import {
  applyOverrides,
  emoji,
  identityKeys,
  identityMap,
  makeOpenProfile,
  mergeProfiles,
  parseOpenProfile,
  pronouns,
  renderOpenProfile,
  web,
} from "../src/index.ts";

const ADA = `# Ada Lovelace

- **Kind**: person
- **Handle**: @ada
- **Emoji**: 🔭
- **Pronouns**: she/her
- **Website**: https://ada.example

Writes about machines that do not exist yet.
`;

describe("OpenProfile 0.4 default fields: Emoji, Pronouns, Web", () => {
  test("reads all three, Website as Web", () => {
    const doc = parseOpenProfile(ADA);
    expect(emoji(doc)).toBe("🔭");
    expect(pronouns(doc)).toBe("she/her");
    expect(web(doc)).toBe("https://ada.example");
    expect(identityMap(doc).web).toBe("https://ada.example");
  });

  test("Homepage and Site are Web too, and Web wins when both are written first", () => {
    expect(web(parseOpenProfile("# A\n\n- **Homepage**: https://a.example\n"))).toBe("https://a.example");
    expect(web(parseOpenProfile("# A\n\n- Site: a.example\n"))).toBe("a.example");
    expect(web(parseOpenProfile("# A\n\n- **Web**: https://one.example\n- **Website**: https://two.example\n"))).toBe("https://one.example");
  });

  test("Emoji is one grapheme, and shortcodes go through a resolver", () => {
    expect(emoji(parseOpenProfile("# A\n\n- **Emoji**: 👩🏽‍💻 and more\n"))).toBe("👩🏽‍💻");
    expect(emoji(parseOpenProfile("# A\n\n- **Emoji**: 🏳️‍🌈\n"))).toBe("🏳️‍🌈");
    const coded = parseOpenProfile("# A\n\n- **Emoji**: :telescope:\n");
    expect(emoji(coded, (c) => (c === "telescope" ? "🔭" : null))).toBe("🔭");
    expect(emoji(coded)).toBe(":telescope:");
  });

  test("absent means unstated: null, never a guess", () => {
    const doc = parseOpenProfile("# Ada\n\n- **Gender**: woman\n");
    expect(pronouns(doc)).toBeNull();
    expect(emoji(doc)).toBeNull();
    expect(web(doc)).toBeNull();
  });

  test("a Website page de-duplicates against a Web page", () => {
    const a = parseOpenProfile("# Ada\n\n- **Website**: https://ada.example/\n");
    const b = parseOpenProfile("# Ada L\n\n- **Web**: ada.example\n");
    expect(identityKeys(a)).toEqual(identityKeys(b));
  });

  test("an overlay or merge of Web replaces Website instead of adding a second home page", () => {
    const generated = parseOpenProfile(ADA);
    const fixed = applyOverrides(generated, { identity: { Web: "https://new.example" } });
    expect(fixed.identity.filter((e) => /^(web|website)$/i.test(e.key))).toHaveLength(1);
    expect(web(fixed)).toBe("https://new.example");

    const merged = mergeProfiles([parseOpenProfile("# Ada\n\n- **Web**: https://ada.example\n"), parseOpenProfile(ADA)]);
    expect(merged.identity.filter((e) => /^(web|website)$/i.test(e.key))).toHaveLength(1);
    expect(pronouns(merged)).toBe("she/her");
    expect(emoji(merged)).toBe("🔭");
  });

  test("writers emit Web, Emoji and Pronouns", () => {
    const md = renderOpenProfile(makeOpenProfile({ name: "Ada", identity: { Emoji: "🔭", Pronouns: "she/her", Website: "https://ada.example" } }));
    expect(md).toContain("- **Emoji**: 🔭");
    expect(md).toContain("- **Pronouns**: she/her");
    expect(md).toContain("- **Web**: https://ada.example");
    expect(md).not.toContain("Website");
  });
});
