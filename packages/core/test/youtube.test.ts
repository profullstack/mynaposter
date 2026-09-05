import { test, expect } from "bun:test";
import { videoIdFrom, youtube } from "../src/net/adapters/youtube.ts";

test("a bare video id is accepted as-is", () => {
  expect(videoIdFrom("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(videoIdFrom("  dQw4w9WgXcQ\n")).toBe("dQw4w9WgXcQ");
});

test("every way YouTube writes a video link resolves to the id", () => {
  const forms = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLx",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=share",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "youtube.com/watch?v=dQw4w9WgXcQ",
  ];
  for (const form of forms) expect(videoIdFrom(form), form).toBe("dQw4w9WgXcQ");
});

test("things that are not a video are refused rather than guessed", () => {
  expect(videoIdFrom("")).toBeUndefined();
  expect(videoIdFrom("not a video")).toBeUndefined();
  expect(videoIdFrom("https://example.com/watch?v=dQw4w9WgXcQ")).toBeUndefined();
  expect(videoIdFrom("https://www.youtube.com/@somechannel")).toBeUndefined();
  // A comment id is longer than eleven characters and must not pass as a video.
  expect(videoIdFrom("UgzQK7s8m1Xf3kR9pL54AaABAg")).toBeUndefined();
});

test("youtube declares what it implements", () => {
  expect(youtube.caps.search).toBe(true);
  expect(typeof youtube.search).toBe("function");
  expect(youtube.caps.delete).toBe(true);
  expect(youtube.caps.stats).toBe(true);
  // Comments are the unit of posting, and a YouTube comment can be long.
  expect(youtube.caps.charLimit).toBe(10_000);
});

test("a youtube post with nothing to comment on explains the flags instead of guessing", async () => {
  const account = {
    id: "youtube:@me",
    network: "youtube",
    handle: "@me",
    addedAt: "",
    // A fresh, unexpired token so no refresh is attempted.
    creds: { accessToken: "t", refreshToken: "", clientId: "c", clientSecret: "s" },
    meta: { expiresAt: String(Date.now() + 3_600_000), channelId: "UC1" },
  };
  await expect(youtube.post(account, { text: "hello" })).rejects.toThrow(/--video/);
  await expect(youtube.post(account, { text: "hello", extra: { video: "nonsense" } })).rejects.toThrow(/not a YouTube video/);
});
