/**
 * A calendar for what myna is going to say.
 *
 * Two things, in one plugin. First, Google Calendar as a network: log in
 * once with `myna login gcal`, and an event is a post to it.
 *
 *   myna post --to gcal --at "tomorrow 9am" --duration 30m "Standup"
 *   myna feed gcal                          what is coming up
 *
 * Second, a hook: every post that goes through `myna schedule` gets an entry
 * on that calendar for the moment it is due, with the text and the targets in
 * the description, and `myna cancel` takes the entry away again. So the
 * calendar you already look at shows what myna will publish, without anyone
 * copying dates around.
 *
 *   myna calendar add "2027-04-01 9am" "Launch day" [--description …] [--duration 1h]
 *   myna calendar list [--days 14]
 *   myna calendar calendars
 *   myna calendar remove <event id> --yes
 *   myna calendar auto on|off               an event for every scheduled post (on)
 *   myna calendar status
 *
 * Google is first because it is what most people already have open. The
 * network is `gcal`; another provider would be another network in this
 * plugin, and the hook would not change.
 *
 * `gcal` is never part of `all`: a calendar entry is not a social post, so
 * it only gets one when named in `--to`.
 *
 * A word on the hook. It is right for a handful of posts a week and wrong
 * for a drip queue: at forty entries the calendar stops being a list of
 * appointments and becomes a log. `myna recap` says the same thing once a
 * morning instead, and `myna calendar auto off` is how you choose it.
 */
import type {
  Account,
  CancelledEvent,
  MynaPlugin,
  Network,
  OAuth2Config,
  PluginContext,
  PostInput,
  PostResult,
  ScheduledEvent,
  TimelineItem,
} from "@profullstack/myna-core";
import {
  authorize,
  callbackFrom,
  refresh,
  PASTE_FIELD,
  getJson,
  postJson,
  request,
  saveAccount,
  parseWhen,
  parseDuration,
} from "@profullstack/myna-core";

const API = "https://www.googleapis.com/calendar/v3";

/** Write events, and read the list of calendars so one can be picked. Nothing wider. */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

/** How long an event is when nobody said: a post takes a moment, a meeting takes longer. */
export const DEFAULT_EVENT_MS = 30 * 60_000;
export const SCHEDULED_POST_EVENT_MS = 15 * 60_000;
/** Google caps a summary at 1024 characters; a calendar is unreadable long before that. */
const SUMMARY_LIMIT = 120;
/** The private extended property that ties an event to a queue entry. */
export const QUEUE_KEY = "mynaQueue";
/** Where Google sends the code when the browser is not on this machine; register it on the OAuth client. */
export const GOOGLE_HOSTED_REDIRECT = "https://mynaposter.com/api/v1/google/oauth/callback";
/** The loopback redirect for a browser on the same machine. */
export const GOOGLE_LOCAL_REDIRECT = "http://127.0.0.1:8765/callback";

const config = (clientId: string, clientSecret?: string): OAuth2Config => ({
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId,
  clientSecret,
  scopes: SCOPES,
  pkce: true,
  // Offline plus a consent screen, or Google hands out no refresh token and
  // the login is worth an hour.
  authParams: { access_type: "offline", prompt: "consent" },
});

async function accessToken(account: Account): Promise<string> {
  const expiresAt = Number(account.meta.expiresAt || 0);
  if (account.creds.accessToken && Date.now() < expiresAt - 60_000) return account.creds.accessToken;
  if (!account.creds.refreshToken) return account.creds.accessToken;

  const tokens = await refresh(config(account.creds.clientId, account.creds.clientSecret), account.creds.refreshToken);
  account.creds.accessToken = tokens.access_token;
  if (tokens.refresh_token) account.creds.refreshToken = tokens.refresh_token;
  account.meta.expiresAt = String(Date.now() + (tokens.expires_in ?? 3600) * 1000);
  saveAccount(account);
  return tokens.access_token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Which calendar an account writes to: the one chosen at login, else the primary. */
export const calendarOf = (account: Account, override?: string): string => override?.trim() || account.meta.calendar || "primary";

const eventsUrl = (calendar: string) => `${API}/calendars/${encodeURIComponent(calendar)}/events`;

export interface CalendarEvent {
  id: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
}

export interface EventSpec {
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  /** Ignored for an all-day event. */
  durationMs?: number;
  allDay?: boolean;
  /** Private properties, invisible in the calendar UI; how a queue entry finds its event again. */
  tags?: Record<string, string>;
}

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/** The JSON Google's events.insert takes, from a spec. Pure, so it can be tested without a token. */
export function eventBody(spec: EventSpec): Record<string, unknown> {
  const summary = spec.summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT) || "(untitled)";
  const body: Record<string, unknown> = { summary };
  if (spec.description) body.description = spec.description;
  if (spec.location) body.location = spec.location;
  if (spec.allDay) {
    const end = new Date(spec.start.getTime() + 86_400_000);
    body.start = { date: dayOf(spec.start) };
    body.end = { date: dayOf(end) };
  } else {
    body.start = { dateTime: spec.start.toISOString() };
    body.end = { dateTime: new Date(spec.start.getTime() + (spec.durationMs ?? DEFAULT_EVENT_MS)).toISOString() };
  }
  if (spec.tags && Object.keys(spec.tags).length) body.extendedProperties = { private: spec.tags };
  return body;
}

export async function createEvent(account: Account, spec: EventSpec, calendar?: string): Promise<CalendarEvent> {
  const token = await accessToken(account);
  return postJson<CalendarEvent>(eventsUrl(calendarOf(account, calendar)), eventBody(spec), { headers: auth(token) });
}

export async function deleteEvent(account: Account, id: string, calendar?: string): Promise<void> {
  const token = await accessToken(account);
  await request(`${eventsUrl(calendarOf(account, calendar))}/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(token) });
}

export interface ListOptions {
  from?: Date;
  to?: Date;
  limit?: number;
  /** Only events carrying this private property, `key=value`. */
  tag?: [string, string];
  calendar?: string;
}

export async function listEvents(account: Account, options: ListOptions = {}): Promise<CalendarEvent[]> {
  const token = await accessToken(account);
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.max(1, Math.min(options.limit ?? 20, 250))),
    timeMin: (options.from ?? new Date()).toISOString(),
  });
  if (options.to) params.set("timeMax", options.to.toISOString());
  if (options.tag) params.set("privateExtendedProperty", `${options.tag[0]}=${options.tag[1]}`);
  const result = await getJson<{ items?: CalendarEvent[] }>(`${eventsUrl(calendarOf(account, options.calendar))}?${params}`, { headers: auth(token) });
  return (result.items ?? []).filter((event) => event.status !== "cancelled");
}

export async function listCalendars(account: Account): Promise<CalendarListEntry[]> {
  const token = await accessToken(account);
  const result = await getJson<{ items?: CalendarListEntry[] }>(`${API}/users/me/calendarList`, { headers: auth(token) });
  return result.items ?? [];
}

const startOf = (event: CalendarEvent): string => event.start?.dateTime ?? event.start?.date ?? "";

/** One line per event, the way `myna feed` shows a timeline. */
export function asTimeline(event: CalendarEvent, account: Account): TimelineItem {
  return {
    id: event.id,
    author: account.displayName ?? account.handle,
    handle: account.handle,
    text: [event.summary ?? "(untitled)", event.location, event.description].filter(Boolean).join("\n"),
    createdAt: startOf(event),
    url: event.htmlLink,
  };
}

/** The first non-empty line of a post, for an event title. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** The event a scheduled post becomes. Pure, so the hook's shape is testable. */
export function eventForScheduled(event: ScheduledEvent): EventSpec {
  const title = event.title?.trim() || firstLine(event.text);
  return {
    summary: `myna: ${title}`,
    description: `${event.text.trim()}\n\nTargets: ${event.targets.join(", ")}\nQueue id: ${event.id}`,
    start: new Date(event.scheduledFor),
    durationMs: SCHEDULED_POST_EVENT_MS,
    tags: { [QUEUE_KEY]: event.id },
  };
}

/** Turn `--at`, `--duration`, `--all-day` and friends into an event spec. */
export function specFromExtra(text: string, title: string | undefined, extra: Record<string, string> = {}, now = new Date()): EventSpec {
  const when = extra.at ?? extra.when ?? extra.start;
  if (!when) throw new Error('When is it? Pass --at "tomorrow 9am" (or --at 2027-04-01 for an all-day event with --all-day true).');
  const { at } = parseWhen(when, now);
  const summary = title?.trim() || firstLine(text);
  const description = title?.trim() ? text.trim() : text.trim().split(/\r?\n/).slice(1).join("\n").trim();
  let durationMs: number | undefined;
  if (extra.duration) {
    durationMs = parseDuration(extra.duration);
    if (!durationMs) throw new Error(`"${extra.duration}" is not a duration. Try --duration 45m or --duration 1h.`);
  }
  return {
    summary,
    description: description || undefined,
    location: extra.location,
    start: at,
    durationMs,
    allDay: /^(true|yes|1)$/i.test(extra.allDay ?? extra["all-day"] ?? ""),
  };
}

const gcal: Network = {
  id: "gcal",
  name: "Google Calendar",
  category: "minor",
  blurb: "An event on your calendar. --at says when; never part of `all`.",
  auth: {
    kind: "oauth2",
    note:
      "Create a project at console.cloud.google.com, enable the Google Calendar API, and add an OAuth client id of " +
      "type 'Web application'. While the app's consent screen is still in testing, Google expires the sign-in after " +
      `seven days; publishing it makes the sign-in permanent. Add ${GOOGLE_LOCAL_REDIRECT} as an authorized redirect ` +
      `URI, and ${GOOGLE_HOSTED_REDIRECT} too if you will authorize from a browser on another machine (answer "yes" to pasting a code).`,
    fields: [
      { key: "clientId", label: "Client id", placeholder: "….apps.googleusercontent.com" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "calendar", label: "Calendar id", optional: true, help: "Leave empty for your primary calendar; `myna calendar calendars` lists the rest." },
      PASTE_FIELD,
    ],
  },
  caps: {
    charLimit: 0,
    mediaLimit: 0,
    threads: false,
    delete: true,
    timeline: true,
    notifications: false,
    stats: false,
    explicitTarget: true,
  },

  async login(input, ctx) {
    const callback = callbackFrom(input, ctx);
    const tokens = await authorize(
      {
        ...config(input.clientId.trim(), input.clientSecret.trim()),
        ...callback,
        // Google's redirect list is per client, so the hosted page is the one named for it.
        ...(callback.mode === "paste" ? { redirectUri: GOOGLE_HOSTED_REDIRECT } : {}),
      },
      ctx,
    );
    const primary = await getJson<CalendarListEntry>(`${API}/users/me/calendarList/primary`, { headers: auth(tokens.access_token) });
    const chosen = input.calendar?.trim() || primary.id;
    return {
      handle: primary.id,
      displayName: primary.summary,
      creds: {
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret.trim(),
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
      },
      meta: {
        calendar: chosen,
        timeZone: primary.timeZone ?? "",
        expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      },
    };
  },

  async post(account: Account, input: PostInput): Promise<PostResult> {
    const spec = specFromExtra(input.text, input.title, input.extra);
    const event = await createEvent(account, spec, input.extra?.calendar);
    return { id: event.id, url: event.htmlLink };
  },

  async remove(account, id) {
    await deleteEvent(account, id);
  },

  async timeline(account, limit) {
    const events = await listEvents(account, { limit });
    return events.map((event) => asTimeline(event, account));
  },
};

const calendarAccounts = (ctx: PluginContext): Account[] => ctx.accounts().filter((account) => account.network === gcal.id);

function pickAccount(ctx: PluginContext): Account {
  const accounts = calendarAccounts(ctx);
  if (!accounts.length) throw new Error("No calendar connected. Run: myna login gcal");
  const wanted = typeof ctx.flags.account === "string" ? ctx.flags.account : undefined;
  if (!wanted) return accounts[0];
  const found = accounts.find((account) => account.id === wanted || account.handle === wanted || account.id === `gcal:${wanted}`);
  if (!found) throw new Error(`No calendar account "${wanted}". Connected: ${accounts.map((account) => account.id).join(", ")}`);
  return found;
}

const autoOn = (ctx: PluginContext): boolean => ctx.secrets.get().auto !== "off";

const flag = (ctx: PluginContext, key: string): string | undefined => (typeof ctx.flags[key] === "string" ? (ctx.flags[key] as string) : undefined);

const when = (event: CalendarEvent): string => {
  const start = startOf(event);
  if (!start) return "";
  return event.start?.date ? start : new Date(start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const plugin: MynaPlugin = {
  id: "calendar",
  name: "Calendar",
  version: "0.8.4",
  description: "Google Calendar as a network, and a calendar entry for every post myna schedules.",

  networks: [gcal],

  commands: [
    {
      name: "calendar",
      summary: "Your calendar: add events, see what is coming, and mirror scheduled posts",
      usage: [
        "calendar add <when> <title…> [--description TEXT] [--duration 45m] [--location L] [--all-day true] [--calendar ID]",
        "calendar list [--days N] [--limit N]       Upcoming events",
        "calendar calendars                         The calendars this account can write to",
        "calendar remove <event id> --yes",
        "calendar auto on|off                       An event for every scheduled post (on by default)",
        "calendar status",
        "login gcal                                 Connect a Google account (a calendar is a network)",
      ],
      async run(args, ctx) {
        const [sub = "status", ...rest] = args;
        switch (sub) {
          case "login":
            ctx.out("A calendar is a network here. Run: myna login gcal");
            return 0;
          case "status": {
            const accounts = calendarAccounts(ctx);
            if (!accounts.length) {
              ctx.out("No calendar connected. Run: myna login gcal");
              return 1;
            }
            for (const account of accounts) ctx.out(`${account.id}  writes to ${calendarOf(account)}${account.meta.timeZone ? `  (${account.meta.timeZone})` : ""}`);
            ctx.out(`scheduled posts on the calendar: ${autoOn(ctx) ? "on" : "off"}`);
            return 0;
          }
          case "auto": {
            const value = rest[0];
            if (value !== "on" && value !== "off") throw new Error("Usage: myna calendar auto on|off");
            ctx.secrets.set({ ...ctx.secrets.get(), auto: value });
            ctx.out(value === "on" ? "Every post myna schedules gets a calendar event." : "Scheduled posts no longer get an event; `myna calendar add` still works.");
            return 0;
          }
          case "add": {
            const account = pickAccount(ctx);
            if (!rest.length) throw new Error('Usage: myna calendar add "<when>" "<title>"');
            const { at, rest: title } = parseWhen(rest.join(" "));
            if (!title.trim()) throw new Error("What is it? Give the event a title after the time.");
            let durationMs: number | undefined;
            const duration = flag(ctx, "duration");
            if (duration) {
              durationMs = parseDuration(duration);
              if (!durationMs) throw new Error(`"${duration}" is not a duration. Try --duration 45m.`);
            }
            const event = await createEvent(
              account,
              {
                summary: title,
                description: flag(ctx, "description"),
                location: flag(ctx, "location"),
                start: at,
                durationMs,
                allDay: /^(true|yes|1)$/i.test(flag(ctx, "allDay") ?? ""),
              },
              flag(ctx, "calendar"),
            );
            if (ctx.flags.json) ctx.out(JSON.stringify(event, null, 2));
            else ctx.out(`${event.id}  ${when(event)}  ${event.summary}${event.htmlLink ? `\n${event.htmlLink}` : ""}`);
            return 0;
          }
          case "list": {
            const account = pickAccount(ctx);
            const days = Number(flag(ctx, "days") ?? 14) || 14;
            const limit = Number(flag(ctx, "limit") ?? 20) || 20;
            const events = await listEvents(account, { to: new Date(Date.now() + days * 86_400_000), limit, calendar: flag(ctx, "calendar") });
            if (ctx.flags.json) {
              ctx.out(JSON.stringify(events, null, 2));
              return 0;
            }
            if (!events.length) ctx.out(`Nothing in the next ${days} day${days === 1 ? "" : "s"}.`);
            for (const event of events) ctx.out(`${event.id.padEnd(28)} ${when(event).padEnd(20)} ${event.summary ?? "(untitled)"}`);
            return 0;
          }
          case "calendars": {
            const account = pickAccount(ctx);
            const calendars = await listCalendars(account);
            if (ctx.flags.json) {
              ctx.out(JSON.stringify(calendars, null, 2));
              return 0;
            }
            const writing = calendarOf(account);
            for (const calendar of calendars) {
              const mark = calendar.id === writing || (writing === "primary" && calendar.primary) ? "*" : " ";
              ctx.out(`${mark} ${calendar.id}  ${calendar.summary}${calendar.accessRole ? `  (${calendar.accessRole})` : ""}`);
            }
            return 0;
          }
          case "remove": {
            const account = pickAccount(ctx);
            const id = rest[0];
            if (!id) throw new Error("Usage: myna calendar remove <event id> --yes");
            if (!ctx.flags.yes) throw new Error("remove deletes the event; pass --yes.");
            await deleteEvent(account, id, flag(ctx, "calendar"));
            ctx.out(`removed ${id}`);
            return 0;
          }
          default:
            throw new Error(`Unknown: myna calendar ${sub}. Try add, list, calendars, remove, auto or status.`);
        }
      },
    },
  ],

  async afterSchedule(event: ScheduledEvent, ctx) {
    if (!autoOn(ctx)) return;
    const accounts = calendarAccounts(ctx);
    if (!accounts.length) return;
    // Scheduling a calendar entry *to* the calendar would make an event about an event.
    if (event.targets.every((target) => target.startsWith(`${gcal.id}:`))) return;
    const created = await createEvent(accounts[0], eventForScheduled(event));
    return `event ${created.htmlLink ?? created.id}`;
  },

  async afterCancel(event: CancelledEvent, ctx) {
    const accounts = calendarAccounts(ctx);
    if (!accounts.length) return;
    let removed = 0;
    for (const account of accounts) {
      const events = await listEvents(account, { from: new Date(0), tag: [QUEUE_KEY, event.id], limit: 10 });
      for (const found of events) {
        await deleteEvent(account, found.id);
        removed += 1;
      }
    }
    return removed ? `removed ${removed} calendar event${removed === 1 ? "" : "s"}` : undefined;
  },
};

export default plugin;
