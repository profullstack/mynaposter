/**
 * `myna asks`: people on Reddit asking for a site or app that does X, Y and Z.
 *
 *   myna asks                          on or off, what is new, and the ideas most asked for
 *   myna asks on | off                 let the daemon scan every 30 minutes and re-read stats every 6 hours
 *   myna asks scan [--sub a,b]         read the subreddits now
 *   myna asks list [--status new|drafted|replied|skipped|all] [--sub x] [--idea <id>] [--limit N]
 *   myna asks show <id>                the post, what they want, our reply and its numbers
 *   myna asks reply <id> [--text "…"] [--local] [--force]
 *                                      draft the answer onto a hand-off card to paste
 *   myna asks skip <id> | replied <id> drop one, or say it was answered outside myna
 *   myna asks ideas [--all]            what people keep asking for, most wanted first
 *   myna asks idea <id> [--status building|shipped|ignored|watching] [--label "…"]
 *                       [--note "…"] [--product <id>] [--merge <other id>]
 *   myna asks stats [--refresh] [<id>…] what our replies did: score, answers, the threads
 *   myna asks product add <name> <url> [--keywords "a, b"] [--about "…"] | list | rm <id>
 *   myna asks subs [add <sub>… | rm <sub>…]
 *   myna asks set <key> <value>
 *
 * Nothing is posted from here. A reply is a hand-off card: the text, the
 * thread, the steps, on mynaposter.com when signed in to myna cloud.
 */
import {
  DEFAULT_ASKS,
  findIn,
  listProducts,
  loadSettings,
  mergeIdeas,
  rankIdeas,
  readAsks,
  refreshAskStats,
  removeProduct,
  replyToAsk,
  replyTotals,
  saveProduct,
  saveSettings,
  scanAsks,
  setAskStatus,
  setIdea,
  subsOf,
  summarizeIdea,
  syncReplies,
  writeAsks,
  writerAvailable,
  type Ask,
  type AsksSettings,
  type AskStatus,
  type IdeaStatus,
  type IdeaSummary,
} from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const day = (iso: string): string => iso.slice(0, 10);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const num = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const newest = (ask: Ask) => ask.stats[ask.stats.length - 1];
const ours = (ask: Ask) => [...ask.stats].reverse().find((stats) => stats.ours)?.ours;

/** One ask on two lines: what and where, then what they want. */
function line(ask: Ask): void {
  const stats = newest(ask);
  const numbers = stats ? `  score ${stats.score ?? "?"} comments ${stats.comments ?? "?"}` : "";
  const mine = ours(ask);
  const reply = mine ? `  ours score ${mine.score ?? "?"} answers ${mine.replies}` : "";
  out(`  ${ask.id}  ${day(ask.postedAt)}  ${ask.status.padEnd(7)}  r/${ask.sub}${numbers}${reply}`);
  out(`      ${ask.title.replace(/\s+/g, " ").slice(0, 110)}`);
  out(`      wants: ${ask.wants.slice(0, 5).join("; ")}${ask.product ? `   → ours: ${ask.product.name}` : ""}`);
}

function ideaLine(summary: IdeaSummary, settings: AsksSettings): void {
  const { idea } = summary;
  const flag = idea.status === "build" ? "BUILD" : idea.status;
  out(
    `  ${idea.id}  ${flag.padEnd(8)}  ${String(summary.askers).padStart(2)}/${settings.buildAt} askers  score ${summary.score} comments ${summary.comments}  ${idea.label}`,
  );
  out(`      ${summary.subs.map((sub) => `r/${sub}`).join(", ")}  ·  ${idea.terms.slice(0, 6).join(", ")}${idea.product ? `  ·  became ${idea.product}` : ""}`);
}

function show(ask: Ask, settings: AsksSettings): void {
  const file = readAsks();
  const idea = file.ideas.find((entry) => entry.id === ask.ideaId);
  out(`r/${ask.sub}  u/${ask.author}  ${ask.postedAt.slice(0, 16).replace("T", " ")}  (${ask.kind}, ${ask.score}${ask.judged ? ", confirmed by the writer" : ""})`);
  out(ask.title);
  out(ask.url);
  out("");
  if (ask.text) out(ask.text.slice(0, 1500));
  out("");
  out(`wants:  ${ask.wants.join("; ")}`);
  if (idea) {
    const summary = summarizeIdea(file, idea, settings);
    out(`idea:   ${idea.id} ${idea.label} (${summary.askers}/${settings.buildAt} askers, ${idea.status})`);
  }
  if (ask.product) out(`ours:   ${ask.product.name} ${ask.product.url}`);
  out(`status: ${ask.status}${ask.repliedAt ? ` ${day(ask.repliedAt)}` : ""}${ask.reason ? ` (${ask.reason})` : ""}`);
  if (ask.reply) {
    out("");
    out("reply:");
    out(ask.reply);
    if (ask.handoffUrl) out(`card:   ${ask.handoffUrl}`);
    else if (ask.handoffId) out(`card:   myna handoff show ${ask.handoffId}`);
  }
  if (ask.stats.length) {
    out("");
    out("stats:");
    for (const stats of ask.stats.slice(-8)) {
      const mine = stats.ours ? `   ours score ${stats.ours.score ?? "?"} answers ${stats.ours.replies} ${stats.ours.url}` : "";
      out(`  ${stats.at.slice(0, 16).replace("T", " ")}  score ${stats.score ?? "?"}  comments ${stats.comments ?? "?"}${mine}`);
    }
  }
}

const statuses: AskStatus[] = ["new", "drafted", "replied", "skipped"];
const ideaStatuses: IdeaStatus[] = ["watching", "build", "building", "shipped", "ignored"];

export async function runAsks(positional: string[], flags: Flags): Promise<number> {
  const [sub = "status", ...rest] = positional;
  const settings = loadSettings();
  const asks = settings.asks;
  const json = flags.json === true;

  switch (sub) {
    case "status": {
      const file = readAsks();
      if (syncReplies(file)) writeAsks(file);
      const writer = writerAvailable();
      out(
        `Asks is ${asks.enabled ? "on: the daemon reads the subreddits every 30 minutes and re-reads stats every 6 hours" : "off (myna asks on)"}.`,
      );
      out(`  subs: ${subsOf(asks).map((name) => `r/${name}`).join(", ")}`);
      out(`  from: ${asks.feedBase}/r/<sub>.json${asks.fallback ? `, else the archive at ${asks.statsBase}` : ""}`);
      out(`  writer: ${writer.ok && asks.useWriter ? "confirms each ask and drafts replies" : `off (${asks.useWriter ? writer.reason : "asks.useWriter is false"}); patterns and the template only`}`);
      out(`  reddit user: ${asks.redditUser ? `u/${asks.redditUser}` : "not set (myna asks set redditUser <name>), so stats cannot find our replies"}`);
      out(`  products: ${file.products.map((product) => product.name).join(", ") || "none (myna asks product add)"}`);
      const fresh = file.asks.filter((ask) => ask.status === "new").sort((a, b) => b.postedAt.localeCompare(a.postedAt));
      const totals = replyTotals(file.asks);
      out(`  ${file.asks.length} asks, ${fresh.length} new; ${totals.drafted} cards waiting, ${totals.replied} replied (score ${totals.score} answers ${totals.replies} on the ${totals.found} found)`);
      const ranked = rankIdeas(file, asks).filter((summary) => summary.idea.status !== "ignored");
      if (ranked.length) {
        out("");
        out("Most asked for:");
        for (const summary of ranked.slice(0, 5)) ideaLine(summary, asks);
      }
      if (fresh.length) {
        out("");
        out("Newest:");
        for (const ask of fresh.slice(0, 5)) line(ask);
        out("");
        out("myna asks reply <id> drafts the answer onto a card to paste.");
      }
      return 0;
    }

    case "on":
    case "off": {
      settings.asks.enabled = sub === "on";
      saveSettings(settings);
      out(sub === "on" ? "Asks is on. The daemon reads the subreddits every 30 minutes; myna asks scan does it now." : "Asks is off.");
      return 0;
    }

    case "scan": {
      const only = str(flags.sub)?.split(",").map((name) => name.trim().replace(/^r\//, "")).filter(Boolean);
      out(`Reading ${only?.length ?? subsOf(asks).length} subreddits…`);
      const result = await scanAsks({ ...(only?.length ? { subs: only } : {}) });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const source of result.sources) out(`  r/${source.sub.padEnd(20)} ${String(source.posts).padStart(3)} via ${source.via}${source.note ? `  (${source.note})` : ""}`);
      for (const skipped of result.skipped) out(`  ! ${skipped}`);
      out(
        `Read ${result.read}, ${result.found.length} new ask${result.found.length === 1 ? "" : "s"}` +
          (result.judged ? `, ${result.rejected} thrown out by the writer` : ", patterns only") +
          (result.deferred ? `, ${result.deferred} left for the next scan` : "") +
          ".",
      );
      for (const ask of result.found) line(ask);
      for (const idea of result.flagged) out(`\nWorth building: ${idea.label} (${idea.id}), ${asks.buildAt}+ people asked. myna asks ideas`);
      return 0;
    }

    case "list":
    case "ls": {
      const file = readAsks();
      if (syncReplies(file)) writeAsks(file);
      const status = str(flags.status) ?? "new";
      if (status !== "all" && !statuses.includes(status as AskStatus)) throw new Error(`--status is one of ${statuses.join(", ")} or all.`);
      const wantSub = str(flags.sub)?.replace(/^r\//, "").toLowerCase();
      const idea = str(flags.idea);
      const limit = num(flags.limit, 30);
      const list = file.asks
        .filter((ask) => status === "all" || ask.status === status)
        .filter((ask) => !wantSub || ask.sub.toLowerCase() === wantSub)
        .filter((ask) => !idea || ask.ideaId === idea || ask.ideaId.startsWith(idea))
        .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
        .slice(0, limit);
      if (json) {
        out(JSON.stringify(list, null, 2));
        return 0;
      }
      if (!list.length) {
        out(`No ${status === "all" ? "" : `${status} `}asks. myna asks scan reads the subreddits now.`);
        return 0;
      }
      for (const ask of list) line(ask);
      return 0;
    }

    case "show": {
      const ask = rest[0] ? findIn(readAsks().asks, rest[0]) : undefined;
      if (!ask) throw new Error(rest[0] ? `No ask ${rest[0]}.` : "Usage: myna asks show <id>");
      if (json) out(JSON.stringify(ask, null, 2));
      else show(ask, asks);
      return 0;
    }

    case "reply": {
      if (!rest[0]) throw new Error('Usage: myna asks reply <id> [--text "…"] [--local] [--force]');
      const result = await replyToAsk(rest[0], {
        ...(str(flags.text) ? { text: str(flags.text) } : {}),
        publish: flags.local !== true,
        force: flags.force === true,
      });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      out(`${result.drafted === "writer" ? "Drafted by the writer" : result.drafted === "template" ? "From the template (no writer)" : "Your text"}, on hand-off ${result.card.id}:`);
      out("");
      out(result.card.text);
      out("");
      out(`open   ${result.ask.url}`);
      if (result.card.cloudUrl) out(`card   ${result.card.cloudUrl}`);
      else if (flags.local !== true) out("Not signed in to myna cloud, so the card is only here: myna handoff show " + result.card.id);
      out(`Pasted it? myna handoff done ${result.card.id}. myna asks stats then tracks it.`);
      return 0;
    }

    case "skip":
    case "replied":
    case "unskip": {
      const status: AskStatus = sub === "skip" ? "skipped" : sub === "replied" ? "replied" : "new";
      const ask = rest[0] ? setAskStatus(rest[0], status, str(flags.reason)) : undefined;
      if (!ask) throw new Error(rest[0] ? `No ask ${rest[0]}.` : `Usage: myna asks ${sub} <id>`);
      out(`${ask.id} is ${ask.status}.`);
      return 0;
    }

    case "ideas": {
      const file = readAsks();
      const ranked = rankIdeas(file, asks).filter((summary) => flags.all === true || (summary.idea.status !== "ignored" && summary.idea.status !== "shipped"));
      if (json) {
        out(JSON.stringify(ranked, null, 2));
        return 0;
      }
      if (!ranked.length) {
        out("No ideas yet. myna asks scan reads the subreddits now.");
        return 0;
      }
      out(`Most asked for in the last ${asks.windowDays} days. BUILD means ${asks.buildAt}+ different people asked.`);
      for (const summary of ranked.slice(0, num(flags.limit, 25))) ideaLine(summary, asks);
      return 0;
    }

    case "idea": {
      const ref = rest[0];
      if (!ref) throw new Error("Usage: myna asks idea <id> [--status …] [--label …] [--note …] [--product …] [--merge <other>]");
      if (str(flags.merge)) {
        const merged = mergeIdeas(ref, str(flags.merge) as string);
        if (!merged) throw new Error(`Could not merge ${flags.merge} into ${ref}.`);
        out(`Merged into ${merged.id} ${merged.label}: ${merged.askIds.length} asks.`);
        return 0;
      }
      const status = str(flags.status);
      if (status && !ideaStatuses.includes(status as IdeaStatus)) throw new Error(`--status is one of ${ideaStatuses.join(", ")}.`);
      const changed =
        status || str(flags.label) || flags.note !== undefined || flags.product !== undefined
          ? setIdea(ref, {
              ...(status ? { status: status as IdeaStatus } : {}),
              ...(str(flags.label) ? { label: str(flags.label) } : {}),
              ...(typeof flags.note === "string" ? { note: flags.note } : {}),
              ...(typeof flags.product === "string" ? { product: flags.product } : {}),
            })
          : undefined;
      const file = readAsks();
      const idea = changed ?? findIn(file.ideas, ref);
      if (!idea) throw new Error(`No idea ${ref}. myna asks ideas lists them.`);
      const summary = summarizeIdea(file, idea, asks);
      if (json) {
        out(JSON.stringify({ ...summary, asks: file.asks.filter((ask) => idea.askIds.includes(ask.id)) }, null, 2));
        return 0;
      }
      ideaLine(summary, asks);
      if (idea.note) out(`      note: ${idea.note}`);
      out("");
      for (const ask of file.asks.filter((entry) => idea.askIds.includes(entry.id)).sort((a, b) => b.postedAt.localeCompare(a.postedAt))) line(ask);
      return 0;
    }

    case "stats": {
      const result = flags.refresh === true || rest.length ? await refreshAskStats(rest.length ? { ids: rest } : {}) : undefined;
      const file = readAsks();
      if (!result && syncReplies(file)) writeAsks(file);
      const answered = file.asks.filter((ask) => ask.status === "replied" || ask.status === "drafted").sort((a, b) => (b.repliedAt ?? b.foundAt).localeCompare(a.repliedAt ?? a.foundAt));
      const totals = replyTotals(file.asks);
      if (json) {
        out(JSON.stringify({ result, totals, asks: answered }, null, 2));
        return 0;
      }
      if (result) {
        out(`Re-read ${result.refreshed} thread${result.refreshed === 1 ? "" : "s"}${result.foundOurs.length ? `, found ${result.foundOurs.length} of our replies` : ""}${result.synced ? `, ${result.synced} cards marked done` : ""}.`);
        for (const error of result.errors) out(`  ! ${error}`);
      }
      out(`${totals.replied} replied, ${totals.drafted} cards waiting. Our replies found: ${totals.found}, score ${totals.score} total, ${totals.replies} answers to them.`);
      if (!asks.redditUser) out("Set myna asks set redditUser <name> so stats can find our replies in the threads.");
      for (const ask of answered.slice(0, num(flags.limit, 30))) line(ask);
      if (!result) out("\nmyna asks stats --refresh re-reads the threads now.");
      return 0;
    }

    case "product":
    case "products": {
      const [action = "list", ...args] = rest;
      if (action === "list" || action === "ls") {
        const products = listProducts();
        if (json) out(JSON.stringify(products, null, 2));
        else if (!products.length) out('No products. myna asks product add <name> <url> --keywords "a, b" --about "…"');
        else for (const product of products) out(`  ${product.id}  ${product.name}  ${product.url}\n      ${product.keywords.join(", ")}${product.about ? `\n      ${product.about}` : ""}`);
        return 0;
      }
      if (action === "add") {
        const [name, url] = args;
        if (!name || !url) throw new Error('Usage: myna asks product add <name> <url> [--keywords "a, b"] [--about "…"]');
        const product = saveProduct({
          name,
          url,
          keywords: (str(flags.keywords) ?? "").split(",").map((word) => word.trim()).filter(Boolean),
          ...(str(flags.about) ? { about: str(flags.about) } : {}),
        });
        out(`${product.id}: ${product.name} ${product.url}, matched on ${product.keywords.join(", ")}`);
        out("New asks it answers get a reply pointing at it. Asks already found keep what they had.");
        return 0;
      }
      if (action === "rm" || action === "remove") {
        if (!args[0] || !removeProduct(args[0])) throw new Error(args[0] ? `No product ${args[0]}.` : "Usage: myna asks product rm <id>");
        out(`Removed ${args[0]}.`);
        return 0;
      }
      throw new Error("myna asks product add | list | rm");
    }

    case "subs": {
      const [action, ...names] = rest;
      const current = subsOf(asks);
      const clean = names.flatMap((name) => name.split(",")).map((name) => name.trim().replace(/^\/?r\//i, "")).filter(Boolean);
      if (action === "add" || action === "rm") {
        const lower = new Set(clean.map((name) => name.toLowerCase()));
        const next = action === "add" ? [...current, ...clean.filter((name) => !current.some((have) => have.toLowerCase() === name.toLowerCase()))] : current.filter((name) => !lower.has(name.toLowerCase()));
        settings.asks.subs = next.join(",");
        saveSettings(settings);
      } else if (action) {
        throw new Error("myna asks subs [add <sub>… | rm <sub>…]");
      }
      out(subsOf(settings.asks).map((name) => `r/${name}`).join("\n"));
      return 0;
    }

    case "set": {
      const [key, ...values] = rest;
      const value = values.join(" ").trim();
      const keys = Object.keys(DEFAULT_ASKS).join(", ");
      if (!key || !value) {
        out(`myna asks set <key> <value>. Keys: ${keys}`);
        return 1;
      }
      if (!(key in DEFAULT_ASKS)) {
        out(`No such setting: ${key}. Keys: ${keys}`);
        return 1;
      }
      const current = DEFAULT_ASKS[key as keyof AsksSettings];
      const parsed =
        typeof current === "number"
          ? num(value, Number.NaN)
          : typeof current === "boolean"
            ? value === "true" || value === "on" || value === "yes"
            : key === "redditUser"
              ? value.replace(/^\/?u\//i, "")
              : value;
      if (typeof current === "number" && !Number.isFinite(parsed as number)) {
        out(`${key} is a number.`);
        return 1;
      }
      (settings.asks as unknown as Record<string, unknown>)[key] = parsed;
      saveSettings(settings);
      out(`${key} is now ${String(parsed)}.`);
      return 0;
    }

    default: {
      out(`No such thing as myna asks ${sub}. Try: status, on, off, scan, list, show, reply, skip, replied, ideas, idea, stats, product, subs, set`);
      return 1;
    }
  }
}
