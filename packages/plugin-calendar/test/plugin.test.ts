import { test, expect } from "bun:test";
import plugin, {
  eventBody,
  eventForScheduled,
  specFromExtra,
  firstLine,
  asTimeline,
  calendarOf,
  QUEUE_KEY,
  SCHEDULED_POST_EVENT_MS,
  DEFAULT_EVENT_MS,
} from "../src/index.ts";
import type { Account, PluginContext, ScheduledEvent } from "@profullstack/myna-core";

const NOW = new Date("2026-09-05T12:00:00Z");

const account: Account = {
  id: "gcal:me@example.com",
  network: "gcal",
  handle: "me@example.com",
  displayName: "Me",
  addedAt: "",
  creds: { clientId: "c", clientSecret: "s", accessToken: "tok", refreshToken: "r" },
  meta: { calendar: "primary", expiresAt: String(Date.now() + 3_600_000) },
};

function context(accounts: Account[], secrets: Record<string, string> = {}, flags: Record<string, unknown> = {}): { ctx: PluginContext; lines: string[] } {
  const lines: string[] = [];
  let store = { ...secrets };
  const ctx: PluginContext = {
    out: (line = "") => lines.push(line),
    log: (line) => lines.push(line),
    accounts: () => accounts,
    settings: () => ({}) as never,
    secrets: { get: () => store, set: (values) => (store = { ...values }), clear: () => (store = {}) },
    graph: { addSeeds: () => ({ added: 0, updated: 0 }) },
    configDir: "/tmp",
    flags,
  };
  return { ctx, lines };
}

async function withFetch<T>(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("a timed event has a start, an end and a trimmed summary; an all-day one has dates", () => {
  const start = new Date("2027-04-01T16:00:00Z");
  const timed = eventBody({ summary: "  Launch   day ", description: "go", start, durationMs: 60_000 });
  expect(timed).toEqual({
    summary: "Launch day",
    description: "go",
    start: { dateTime: "2027-04-01T16:00:00.000Z" },
    end: { dateTime: "2027-04-01T16:01:00.000Z" },
  });
  expect(eventBody({ summary: "x", start }).end).toEqual({ dateTime: new Date(start.getTime() + DEFAULT_EVENT_MS).toISOString() });

  const allDay = eventBody({ summary: "Off", start, allDay: true, tags: { a: "b" } });
  expect(allDay.start).toEqual({ date: "2027-04-01" });
  expect(allDay.end).toEqual({ date: "2027-04-02" });
  expect(allDay.extendedProperties).toEqual({ private: { a: "b" } });
});

test("a scheduled post becomes a short event that remembers its queue id", () => {
  const scheduled: ScheduledEvent = {
    id: "abcd1234",
    scheduledFor: "2027-04-01T16:00:00.000Z",
    targets: ["bluesky:me", "x:@me"],
    text: "April 1: Profullstack has agreed to be acquired.\nDetails inside.",
  };
  const spec = eventForScheduled(scheduled);
  expect(spec.summary).toBe("myna: April 1: Profullstack has agreed to be acquired.");
  expect(spec.start.toISOString()).toBe("2027-04-01T16:00:00.000Z");
  expect(spec.durationMs).toBe(SCHEDULED_POST_EVENT_MS);
  expect(spec.tags).toEqual({ [QUEUE_KEY]: "abcd1234" });
  expect(spec.description).toContain("Targets: bluesky:me, x:@me");
  expect(spec.description).toContain("Queue id: abcd1234");
  // A title wins over the first line.
  expect(eventForScheduled({ ...scheduled, title: "Big news" }).summary).toBe("myna: Big news");
});

test("--at, --duration, --location and --all-day become an event; a missing --at is refused", () => {
  const spec = specFromExtra("Standup\nDaily sync", undefined, { at: "tomorrow 9am", duration: "45m", location: "Room 1" }, NOW);
  expect(spec.summary).toBe("Standup");
  expect(spec.description).toBe("Daily sync");
  expect(spec.location).toBe("Room 1");
  expect(spec.durationMs).toBe(45 * 60_000);
  expect(spec.start.getHours()).toBe(9);
  expect(spec.allDay).toBe(false);

  const titled = specFromExtra("All the details", "Launch", { at: "2027-04-01", allDay: "true" }, NOW);
  expect(titled.summary).toBe("Launch");
  expect(titled.description).toBe("All the details");
  expect(titled.allDay).toBe(true);

  expect(() => specFromExtra("x", undefined, {}, NOW)).toThrow(/--at/);
  expect(() => specFromExtra("x", undefined, { at: "tomorrow", duration: "soon" }, NOW)).toThrow(/not a duration/);
});

test("the first line, and the calendar an account writes to", () => {
  expect(firstLine("\n\n  Hello \nworld")).toBe("Hello");
  expect(firstLine("")).toBe("");
  expect(calendarOf(account)).toBe("primary");
  expect(calendarOf(account, "work@group.calendar.google.com")).toBe("work@group.calendar.google.com");
  expect(calendarOf({ ...account, meta: {} })).toBe("primary");
});

test("an event reads as a timeline item", () => {
  const item = asTimeline({ id: "e1", summary: "Launch", description: "go", location: "here", htmlLink: "https://cal/e1", start: { dateTime: "2027-04-01T16:00:00Z" } }, account);
  expect(item).toEqual({ id: "e1", author: "Me", handle: "me@example.com", text: "Launch\nhere\ngo", createdAt: "2027-04-01T16:00:00Z", url: "https://cal/e1" });
});

test("the network is explicit-only and the plugin registers it", () => {
  const gcal = plugin.networks?.find((network) => network.id === "gcal");
  expect(gcal?.caps.explicitTarget).toBe(true);
  expect(gcal?.auth.kind).toBe("oauth2");
  expect(plugin.commands?.map((command) => command.name)).toEqual(["calendar"]);
});

test("afterSchedule is silent without a calendar, when turned off, and for a post that is itself a calendar entry", async () => {
  const scheduled: ScheduledEvent = { id: "q1", scheduledFor: "2027-04-01T16:00:00.000Z", targets: ["bluesky:me"], text: "hi" };
  expect(await plugin.afterSchedule!(scheduled, context([]).ctx)).toBeUndefined();
  expect(await plugin.afterSchedule!(scheduled, context([account], { auto: "off" }).ctx)).toBeUndefined();
  expect(await plugin.afterSchedule!({ ...scheduled, targets: ["gcal:me@example.com"] }, context([account]).ctx)).toBeUndefined();
});

test("afterSchedule posts the event to the account's calendar and reports the link", async () => {
  const scheduled: ScheduledEvent = { id: "q1", scheduledFor: "2027-04-01T16:00:00.000Z", targets: ["bluesky:me"], text: "Big day" };
  let sent: { url: string; body: Record<string, unknown> } | undefined;
  const line = await withFetch(
    async (url, init) => {
      sent = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ id: "e9", htmlLink: "https://cal/e9" }), { status: 200, headers: { "content-type": "application/json" } });
    },
    () => plugin.afterSchedule!(scheduled, context([account]).ctx),
  );
  expect(line).toBe("event https://cal/e9");
  expect(sent?.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  expect(sent?.body.summary).toBe("myna: Big day");
  expect(sent?.body.extendedProperties).toEqual({ private: { [QUEUE_KEY]: "q1" } });
});

test("afterCancel finds the entry by its queue id and deletes it", async () => {
  const calls: string[] = [];
  const line = await withFetch(
    async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ items: [{ id: "e9" }, { id: "gone", status: "cancelled" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 204 });
    },
    () => plugin.afterCancel!({ id: "q1" }, context([account]).ctx),
  );
  expect(line).toBe("removed 1 calendar event");
  expect(calls[0]).toContain(`privateExtendedProperty=${QUEUE_KEY}%3Dq1`);
  expect(calls[1]).toBe("DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/e9");
});

test("calendar add needs a connected calendar, a time and a title", async () => {
  const command = plugin.commands![0];
  await expect(command.run(["add", "tomorrow", "Standup"], context([]).ctx)).rejects.toThrow(/myna login gcal/);
  await expect(command.run(["add"], context([account]).ctx)).rejects.toThrow(/Usage/);
  await expect(command.run(["add", "tomorrow"], context([account]).ctx)).rejects.toThrow(/title/);
  await expect(command.run(["remove", "e1"], context([account]).ctx)).rejects.toThrow(/--yes/);
  await expect(command.run(["auto", "maybe"], context([account]).ctx)).rejects.toThrow(/on\|off/);
});

test("calendar status says what is connected", async () => {
  const command = plugin.commands![0];
  const none = context([]);
  expect(await command.run(["status"], none.ctx)).toBe(1);
  expect(none.lines[0]).toContain("myna login gcal");
  const some = context([account]);
  expect(await command.run([], some.ctx)).toBe(0);
  expect(some.lines).toEqual(["gcal:me@example.com  writes to primary", "scheduled posts on the calendar: on"]);
});
