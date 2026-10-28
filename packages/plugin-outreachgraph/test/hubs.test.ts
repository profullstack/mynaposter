/**
 * `myna outreachgraph hubs`: OutreachGraph's campaign hub ranking, as `myna
 * hubs` imports it. Rows without a handle are dropped; nulls never become
 * fields.
 */
import { test, expect } from "bun:test";
import { hubInputs } from "../src/index.ts";

test("a campaign's ranked hubs become hub inputs", () => {
  expect(
    hubInputs({
      campaign: { id: "cmp_1", name: "ugig pay-per-PR" },
      leads: 44,
      handles: 15,
      hubs: [
        { network: "bluesky", handle: "simonwillison.net", displayName: "Simon Willison", url: null, score: 7.5, followedBy: 6, repliedBy: 1, why: "followed by 6 of 9 leads" },
        { network: "linkedin", handle: "kiran-a-n", score: 1, leadHub: true, why: null },
        { network: "bluesky", handle: "", score: 4 },
      ],
    }),
  ).toEqual([
    { network: "bluesky", handle: "simonwillison.net", displayName: "Simon Willison", score: 7.5, followedBy: 6, repliedBy: 1, why: "followed by 6 of 9 leads" },
    { network: "linkedin", handle: "kiran-a-n", score: 1 },
  ]);
});
