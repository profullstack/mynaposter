import { describe, expect, test } from "bun:test";
import { requireNetwork } from "@profullstack/myna-core";
import { loginValuesFromArgs } from "../src/login-args.ts";

const tsbb = requireNetwork("tsbb");
const bluesky = requireNetwork("bluesky");

describe("loginValuesFromArgs", () => {
  test("a bare word fills the first field, which for a board is its URL", () => {
    expect(loginValuesFromArgs(tsbb, ["https://bbs.hqtui.com/"])).toEqual({
      instance: "https://bbs.hqtui.com/",
    });
  });

  test("words fill the declared fields in order", () => {
    expect(loginValuesFromArgs(tsbb, ["https://bbs.hqtui.com/", "app-showcase", "myna"])).toEqual({
      instance: "https://bbs.hqtui.com/",
      forum: "app-showcase",
      label: "myna",
    });
  });

  test("a flag answers its field, and the words skip past it", () => {
    expect(
      loginValuesFromArgs(tsbb, ["https://bbs.hqtui.com/", "myna"], { forum: "app-showcase" }),
    ).toEqual({
      instance: "https://bbs.hqtui.com/",
      forum: "app-showcase",
      label: "myna",
    });
  });

  test("an empty or non-string flag is not an answer", () => {
    expect(loginValuesFromArgs(tsbb, [], { forum: "  ", label: true })).toEqual({});
  });

  test("more words than fields is a mistake, not a silent drop", () => {
    expect(() => loginValuesFromArgs(tsbb, ["a", "b", "c", "d"])).toThrow(/at most 3/);
  });

  test("nothing given is nothing filled, so the prompts still run", () => {
    expect(loginValuesFromArgs(bluesky, [])).toEqual({});
  });

  test("works for a password network too, in field order", () => {
    const values = loginValuesFromArgs(bluesky, ["chovy.bsky.social", "app-password"]);
    const keys = bluesky.auth.fields.map((field) => field.key);
    expect(values[keys[0]]).toBe("chovy.bsky.social");
    expect(values[keys[1]]).toBe("app-password");
  });
});
