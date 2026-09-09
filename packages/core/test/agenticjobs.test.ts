import { test, expect } from "bun:test";
import { agenticjobs, followTarget, splitLink, UPDATE_LIMIT } from "../src/net/adapters/agenticjobs.ts";
import { getNetwork, authSummary } from "../src/net/registry.ts";
import { tailor } from "../src/core/poster.ts";
import { gitblog } from "../src/net/adapters/ownblogs.ts";

test("registered, and reachable by the names people type", () => {
  expect(getNetwork("agenticjobs")?.id).toBe("agenticjobs");
  expect(getNetwork("jobs")?.id).toBe("agenticjobs");
  expect(getNetwork("agentic-jobs")?.id).toBe("agenticjobs");
});

test("a device flow is described as approving a code, not signing in", () => {
  expect(agenticjobs.auth.kind).toBe("device");
  expect(authSummary(agenticjobs)).toBe("approve a code");
  // Nothing secret is typed in: the token comes back from the approval.
  expect(agenticjobs.auth.fields.some((field) => field.secret)).toBe(false);
  expect(agenticjobs.auth.fields.map((field) => field.key)).toContain("instance");
});

test("an update goes out with a fan-out, unlike a job opening", () => {
  // This is the whole reason the adapter exists rather than being folded into
  // the existing explicit `myna jobs post`. An update is a status post, and
  // `--to all` is exactly every network that is not an explicit target.
  expect(agenticjobs.caps.explicitTarget).toBeFalsy();
  // Against one that genuinely is explicit, so this asserts something.
  expect(gitblog.caps.explicitTarget).toBe(true);
});

test("the board's own limit is the limit, and long text is cut rather than threaded", () => {
  expect(agenticjobs.caps.charLimit).toBe(UPDATE_LIMIT);
  expect(agenticjobs.caps.threads).toBe(false);

  const long = "word ".repeat(400).trim();
  const parts = tailor("agenticjobs", { text: long, thread: true });
  expect(parts).toHaveLength(1);
  expect(parts[0].length).toBeLessThanOrEqual(UPDATE_LIMIT);
});

test("a trailing link moves into the board's own link field", () => {
  // The board renders the link under the body, so leaving it in the text as
  // well prints it twice.
  const split = splitLink("Resume downloads shipped today. https://agenticjobs.work/changelog");
  expect(split.body).toBe("Resume downloads shipped today.");
  expect(split.link).toBe("https://agenticjobs.work/changelog");
});

test("a link inside a sentence is part of the sentence", () => {
  const text = "We wrote https://example.com/post about it and it went well.";
  expect(splitLink(text)).toEqual({ body: text });
});

test("a post that is only a link keeps it, because a bare URL is not an update", () => {
  // The board wants at least a dozen characters of text; stripping the URL
  // here would leave nothing to post.
  const text = "Read: https://example.com/x";
  expect(splitLink(text).link).toBeUndefined();
  expect(splitLink(text).body).toBe(text);
});

test("an explicit link wins over anything found in the text", () => {
  const split = splitLink("Something happened here. https://example.com/a", "https://example.com/b");
  expect(split.link).toBe("https://example.com/b");
  expect(split.body).toBe("Something happened here. https://example.com/a");
});

test("following an employer is the default, and a person has to be named", () => {
  expect(followTarget("acme")).toEqual({ kind: "orgs", slug: "acme" });
  expect(followTarget("@acme")).toEqual({ kind: "orgs", slug: "acme" });
  expect(followTarget("candidate:ada")).toEqual({ kind: "candidates", slug: "ada" });
  expect(followTarget("org:acme")).toEqual({ kind: "orgs", slug: "acme" });

  // A pasted page URL is what you have to hand when you are looking at one.
  expect(followTarget("https://agenticjobs.work/employers/acme")).toEqual({
    kind: "orgs",
    slug: "acme",
  });
  expect(followTarget("https://agenticjobs.work/candidates/ada")).toEqual({
    kind: "candidates",
    slug: "ada",
  });
});

test("it refuses to say who somebody else follows", async () => {
  // On a job board that would publish the fact that a person is looking, so
  // it is refused rather than answered with a guess.
  const account = {
    id: "agenticjobs:me@board.test",
    network: "agenticjobs",
    handle: "me@board.test",
    addedAt: "",
    creds: { token: "t" },
    meta: { instance: "https://board.test" },
  };
  await expect(agenticjobs.following!(account, "somebody-else", 10)).rejects.toThrow(/somebody else/);
});
