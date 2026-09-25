/**
 * `myna brand`: the one Markdown file everything that writes reads first.
 *
 *   myna brand                    what it says now
 *   myna brand learn [--url u]    write it from your own posts. Asks nothing
 *   myna brand path | edit        where it is; open it in $EDITOR
 *   myna brand set <key> <value>  name, audience, positioning, voice
 *   myna brand pillar add|rm      the subjects you keep returning to
 *   myna brand avoid add|rm       what never goes out
 *
 * `learn` is the whole point: a brand you have to sit an interview for is a
 * brand that never gets written, so it reads what you have already published
 * and writes the file without a single question.
 */
import { spawnSync } from "node:child_process";
import {
  brandPath,
  EMPTY_BRAND,
  learnBrand,
  loadBrand,
  saveBrand,
  type Brand,
} from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const missing = (): number => {
  out("No brand yet.");
  out("");
  out("  myna brand learn      write it from the posts you have already sent");
  out(`  ${brandPath()}   or write it by hand`);
  return 1;
};

function show(brand: Brand): void {
  out(`# ${brand.name || "(no name)"}`);
  out("");
  if (brand.audience) out(`Audience:    ${brand.audience}`);
  if (brand.positioning) out(`Positioning: ${brand.positioning}`);
  if (brand.voice) out(`Voice:       ${brand.voice}`);
  if (brand.pillars.length) {
    out("");
    out("Pillars:");
    for (const pillar of brand.pillars) out(`  - ${pillar.name}${pillar.note ? `: ${pillar.note}` : ""}`);
  }
  if (brand.avoid.length) {
    out("");
    out("Never:");
    for (const item of brand.avoid) out(`  - ${item}`);
  }
  if (brand.links.length) {
    out("");
    out("Links:");
    for (const link of brand.links) out(`  - ${link}`);
  }
  out("");
  out(brandPath());
}

export async function runBrand(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;

  switch (sub ?? "status") {
    case "status":
    case "show": {
      const brand = loadBrand();
      if (!brand) return missing();
      if (flags.json) {
        out(JSON.stringify(brand, null, 2));
        return 0;
      }
      show(brand);
      return 0;
    }

    case "learn": {
      const result = await learnBrand({
        url: typeof flags.url === "string" ? flags.url : undefined,
        limit: flags.limit ? Number(flags.limit) : undefined,
        log: (line) => out(line),
      });
      out("");
      show(result.brand);
      out("");
      out(`Read ${result.read} of your own posts${result.sources.length ? ` and ${result.sources.join(", ")}` : ""}.`);
      out("Edit it by hand any time: myna brand edit");
      return 0;
    }

    case "path": {
      out(brandPath());
      return 0;
    }

    case "edit": {
      const editor = process.env.VISUAL || process.env.EDITOR;
      if (!editor) {
        out(`No $EDITOR set. The file is at ${brandPath()}`);
        return 1;
      }
      // Make sure there is something to open: an editor on a missing file is
      // a blank buffer nobody knows the shape of.
      if (!loadBrand()) saveBrand({ ...EMPTY_BRAND, name: "Brand" });
      const run = spawnSync(editor, [brandPath()], { stdio: "inherit" });
      return run.status ?? 0;
    }

    case "set": {
      const [key, ...value] = rest;
      const text = value.join(" ").trim();
      if (!key || !text) throw new Error('Which one? Try: myna brand set voice "plain, specific, no hype"');
      const brand = loadBrand() ?? { ...EMPTY_BRAND };
      switch (key) {
        case "name":
          brand.name = text;
          break;
        case "audience":
          brand.audience = text;
          break;
        case "positioning":
          brand.positioning = text;
          break;
        case "voice":
          brand.voice = text;
          break;
        default:
          throw new Error(`Unknown key "${key}". One of: name, audience, positioning, voice`);
      }
      saveBrand(brand);
      out(`${key}: ${text}`);
      return 0;
    }

    case "pillar": {
      const brand = loadBrand();
      if (!brand) return missing();
      const [action, ...value] = rest;
      const text = value.join(" ").trim();
      if (action === "add") {
        if (!text) throw new Error('What subject? Try: myna brand pillar add "licensing: who it actually protects"');
        const split = /^(.+?)\s*:\s*(.+)$/.exec(text);
        brand.pillars.push(split ? { name: split[1].trim(), note: split[2].trim() } : { name: text, note: "" });
        saveBrand(brand);
        out(`Added: ${text}`);
        return 0;
      }
      if (action === "rm" || action === "remove") {
        const before = brand.pillars.length;
        brand.pillars = brand.pillars.filter((pillar) => pillar.name.toLowerCase() !== text.toLowerCase());
        if (brand.pillars.length === before) {
          out(`No pillar called "${text}".`);
          return 1;
        }
        saveBrand(brand);
        out(`Removed: ${text}`);
        return 0;
      }
      for (const pillar of brand.pillars) out(`- ${pillar.name}${pillar.note ? `: ${pillar.note}` : ""}`);
      if (!brand.pillars.length) out("No pillars. myna brand learn writes them from your posts.");
      return 0;
    }

    case "avoid": {
      const brand = loadBrand();
      if (!brand) return missing();
      const [action, ...value] = rest;
      const text = value.join(" ").trim();
      if (action === "add") {
        if (!text) throw new Error('What? Try: myna brand avoid add "excited to announce"');
        brand.avoid.push(text);
        saveBrand(brand);
        out(`Never: ${text}`);
        return 0;
      }
      if (action === "rm" || action === "remove") {
        const before = brand.avoid.length;
        brand.avoid = brand.avoid.filter((item) => item.toLowerCase() !== text.toLowerCase());
        if (brand.avoid.length === before) {
          out(`Not in the list: "${text}"`);
          return 1;
        }
        saveBrand(brand);
        out(`Removed: ${text}`);
        return 0;
      }
      for (const item of brand.avoid) out(`- ${item}`);
      if (!brand.avoid.length) out("Nothing listed.");
      return 0;
    }

    default:
      throw new Error(`Unknown: myna brand ${sub}. Try: status, learn, edit, path, set, pillar, avoid`);
  }
}
