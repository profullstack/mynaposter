/**
 * The listing flags on `myna directory`.
 *
 * `--tags a,b` and `--tags a --tags b` are the same thing to anyone typing
 * them, and a flag nobody passed has to stay absent rather than arriving as an
 * empty string that overwrites what reading the page worked out.
 */
import { test, expect } from "bun:test";
import { parseFlags } from "../src/cli/headless.ts";
import { listingFromFlags } from "../src/cli/directory.ts";

const flagsFor = (line: string) => parseFlags(line.split(" ").filter(Boolean)).flags;

test("a comma list and a repeated flag mean the same list", () => {
  const commas = listingFromFlags(flagsFor("--tags cli,terminal,social"));
  expect(commas.tags).toEqual(["cli", "terminal", "social"]);

  expect(listingFromFlags(flagsFor("--tags cli")).tags).toEqual(["cli"]);
  // One shell argument with a space after the comma, as a person would type it.
  const spaced = parseFlags(["--use-cases", "developer-tools, automation"]).flags;
  expect(listingFromFlags(spaced).useCases).toEqual(["developer-tools", "automation"]);
});

test("flags nobody passed are absent, not empty", () => {
  const listing = listingFromFlags(flagsFor("--name Widget"));
  expect(listing.name).toBe("Widget");
  expect(listing.description).toBeUndefined();
  expect(listing.tags).toBeUndefined();
  expect(listing.category).toBeUndefined();
});

test("--dry-run and --no-ai are switches, and do not eat the next argument", () => {
  const { positional, flags } = parseFlags(["saasrow", "https://widget.test", "--dry-run", "--no-ai", "--name", "Widget"]);
  expect(positional).toEqual(["saasrow", "https://widget.test"]);
  expect(flags.dryRun).toBe(true);
  expect(flags.noAi).toBe(true);
  expect(flags.name).toBe("Widget");
});

test("the singular spellings are accepted too, since both read naturally", () => {
  expect(listingFromFlags(flagsFor("--platform cli")).platforms).toEqual(["cli"]);
  expect(listingFromFlags(flagsFor("--audience developers")).audiences).toEqual(["developers"]);
  expect(listingFromFlags(flagsFor("--pricing free")).pricingModel).toBe("free");
});
