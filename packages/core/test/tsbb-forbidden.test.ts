import { test, expect, describe } from "bun:test";
import { isForbidden } from "../src/net/adapters/tsbb.ts";

describe("isForbidden", () => {
  test("a 403 is the board saying no, whichever shape it arrives in", () => {
    // HttpError carries a status; some paths only have the message.
    expect(isForbidden({ status: 403 })).toBe(true);
    expect(isForbidden(new Error("403 bbs.hqtui.com/api/v1/forums/news/topics — forbidden"))).toBe(true);
  });

  test("anything else must still fail loudly", () => {
    // The danger of a loose check: a flaky board would quietly empty the
    // account's forum list one post at a time.
    expect(isForbidden({ status: 500 })).toBe(false);
    expect(isForbidden({ status: 401 })).toBe(false);
    expect(isForbidden(new Error("fetch failed"))).toBe(false);
    expect(isForbidden(new Error("Topic 4034 not found"))).toBe(false);
    expect(isForbidden(undefined)).toBe(false);
  });
});
