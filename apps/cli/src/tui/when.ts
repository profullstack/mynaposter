/**
 * Parsing the time half of `/schedule <when> [text]`.
 *
 * People type "in 2h" and "tomorrow 9am", not ISO timestamps, and the command
 * has to work out where the time ends and the post begins.
 */
const UNITS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/** "9am", "9:30pm", "17:00" -> minutes past midnight, or null. */
function timeOfDay(token: string): number | null {
  const match = token.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  // A bare number with no meridiem and no colon is ambiguous; treat 1-23 as the hour.
  if (!meridiem && !match[2] && hour > 23) return null;
  return hour * 60 + minute;
}

function atTime(base: Date, minutes: number): Date {
  const date = new Date(base);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date;
}

export function parseWhen(input: string, now = new Date()): { at: Date; rest: string } {
  const tokens = input.trim().split(/\s+/);
  const take = (count: number) => ({ rest: tokens.slice(count).join(" ") });

  const first = tokens[0]?.toLowerCase() ?? "";

  // in 2h / in 30 minutes
  if (first === "in") {
    const compact = tokens[1]?.match(/^(\d+)([a-z]+)$/i);
    if (compact && UNITS[compact[2].toLowerCase()]) {
      return { at: new Date(now.getTime() + Number(compact[1]) * UNITS[compact[2].toLowerCase()]), ...take(2) };
    }
    const amount = Number(tokens[1]);
    const unit = tokens[2]?.toLowerCase();
    if (Number.isFinite(amount) && unit && UNITS[unit]) {
      return { at: new Date(now.getTime() + amount * UNITS[unit]), ...take(3) };
    }
    throw new Error('Could not read that delay. Try "in 2h" or "in 30 minutes".');
  }

  // 2h (bare compact delay)
  const bare = first.match(/^(\d+)([a-z]+)$/i);
  if (bare && UNITS[bare[2].toLowerCase()]) {
    return { at: new Date(now.getTime() + Number(bare[1]) * UNITS[bare[2].toLowerCase()]), ...take(1) };
  }

  // tomorrow [9am] / today [17:00]
  if (first === "tomorrow" || first === "today" || first === "tonight") {
    const base = new Date(now);
    if (first === "tomorrow") base.setDate(base.getDate() + 1);
    const minutes = timeOfDay(tokens[1] ?? "");
    if (minutes !== null) return { at: atTime(base, minutes), ...take(2) };
    return { at: atTime(base, first === "tonight" ? 19 * 60 : 9 * 60), ...take(1) };
  }

  // 2026-09-05 [14:00]
  const isoDate = first.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    const base = new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
    const minutes = timeOfDay(tokens[1] ?? "");
    if (minutes !== null) return { at: atTime(base, minutes), ...take(2) };
    return { at: atTime(base, 9 * 60), ...take(1) };
  }

  // A full ISO timestamp.
  if (/^\d{4}-\d{2}-\d{2}T/.test(tokens[0] ?? "")) {
    const at = new Date(tokens[0]);
    if (!Number.isNaN(at.getTime())) return { at, ...take(1) };
  }

  // A bare time means the next time it comes round.
  const minutes = timeOfDay(first);
  if (minutes !== null) {
    let at = atTime(now, minutes);
    if (at <= now) at = new Date(at.getTime() + 86_400_000);
    return { at, ...take(1) };
  }

  throw new Error('Could not read that time. Try "in 2h", "tomorrow 9am" or "2026-09-05 14:00".');
}

export function describeWhen(at: Date, now = new Date()): string {
  const delta = at.getTime() - now.getTime();
  if (delta < 0) return "now (it is already due)";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 48) return `in ${hours}h (${at.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })})`;
  return at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
