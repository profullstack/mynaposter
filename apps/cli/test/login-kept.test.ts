/**
 * What a second login keeps from the account already connected.
 *
 * What would be embarrassing: asking for a Google client secret again a week
 * after it was typed, guessing a client when two accounts of one network are
 * connected, or keeping a value the command line just replaced.
 */
import { describe, expect, test } from "bun:test";
import type { Network } from "@profullstack/myna-core";
import { keptLoginValues, type KeptSource } from "../src/login-args.ts";

const gcal = {
  id: "gcal",
  name: "Google Calendar",
  auth: {
    kind: "oauth2",
    fields: [
      { key: "clientId", label: "Client id", reuse: true },
      { key: "clientSecret", label: "Client secret", secret: true, reuse: true },
      { key: "calendar", label: "Calendar id", optional: true },
      { key: "paste", label: "Paste a code?", optional: true },
    ],
  },
} as unknown as Network;

const bluesky = {
  id: "bluesky",
  name: "Bluesky",
  auth: {
    kind: "password",
    fields: [
      { key: "handle", label: "Handle" },
      { key: "password", label: "App password", secret: true },
    ],
  },
} as unknown as Network;

const connected: KeptSource = {
  id: "gcal:me@example.com",
  network: "gcal",
  creds: { clientId: "123.apps.googleusercontent.com", clientSecret: "s3cret", refreshToken: "dead" },
  meta: { calendar: "me@example.com" },
} as unknown as KeptSource;

describe("keptLoginValues", () => {
  test("the fields marked reuse come from the one connected account, and say where from", () => {
    expect(keptLoginValues(gcal, [connected])).toEqual({
      values: { clientId: "123.apps.googleusercontent.com", clientSecret: "s3cret" },
      from: "gcal:me@example.com",
    });
  });

  test("a value on the command line wins over the kept one", () => {
    const kept = keptLoginValues(gcal, [connected], { clientId: "456.apps.googleusercontent.com" });
    expect(kept.values).toEqual({ clientSecret: "s3cret" });
  });

  test("fields not marked reuse are never kept, even when the account holds them", () => {
    expect(keptLoginValues(gcal, [connected]).values.calendar).toBeUndefined();
    const bsky = { ...connected, id: "bluesky:me", network: "bluesky", creds: { handle: "me", password: "x" } } as unknown as KeptSource;
    expect(keptLoginValues(bluesky, [bsky])).toEqual({ values: {}, from: null });
  });

  test("with no account, or two, nothing is guessed", () => {
    expect(keptLoginValues(gcal, [])).toEqual({ values: {}, from: null });
    const second = { ...connected, id: "gcal:other@example.com" } as unknown as KeptSource;
    expect(keptLoginValues(gcal, [connected, second])).toEqual({ values: {}, from: null });
  });

  test("an account of another network is not a source", () => {
    const other = { ...connected, id: "youtube:me", network: "youtube" } as unknown as KeptSource;
    expect(keptLoginValues(gcal, [other])).toEqual({ values: {}, from: null });
  });
});
