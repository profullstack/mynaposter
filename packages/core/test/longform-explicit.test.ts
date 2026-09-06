/**
 * Long-form networks are publications, like the blogs you host: an article on
 * dev.to or a Ghost post must be named in --to, never reached by `all`.
 */
import { test, expect } from "bun:test";
import { devto, hashnode, ghost, wordpress, microblog, tumblr } from "../src/net/adapters/blogs.ts";

test("every long-form network is an explicit target", () => {
  for (const network of [devto, hashnode, ghost, wordpress, microblog, tumblr]) {
    expect(network.caps.explicitTarget, network.id).toBe(true);
  }
  // The crawlproof plugin runs an ad for every "blog" target; dev.to counts.
  expect(devto.category).toBe("blog");
});
