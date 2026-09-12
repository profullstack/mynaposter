/**
 * `myna profile` and `myna reshare`.
 *
 *   myna profile                          print this install's OpenProfile.md
 *   myna profile write [--force]          write it to ~/.config/myna/openprofile.md to edit by hand
 *   myna profile path                     where that file is
 *   myna profile set <key> <value>        name, kind, handle, web, email, avatar, pay, resume, headline, topics
 *
 *   myna reshare join                     publish the profile's Reshare section to the network
 *   myna reshare leave                    stop matching (the ledger keeps its names)
 *   myna reshare status                   joined or not, what you offer, what is open
 *   myna reshare set <key> <value>        auto, perDay, quote, networks, topics, not, rateUsd, bountyUsd, maxSharers
 *   myna reshare ask <url...> [--topics a,b] [--bounty 0.05] [--text "..."]
 *                                         ask the network to reshare a post that is already out
 *   myna reshare matches                  what the network would have you reshare, best first
 *   myna reshare pull [--limit N]         do them now, within the daily limit
 *   myna reshare requests                 your own requests and who reshared them
 *   myna reshare close <id>               close one of yours
 *   myna reshare log                      what this install has reshared for others
 *   myna reshare owed                     what you owe sharers, with where to send it
 *   myna reshare paid <claim> --ref <tx>  record that you paid one
 *
 * The network runs on the same account as `myna cloud`, so sign in there
 * first. No social token ever goes up: every reshare is done here, by this
 * install, with its own accounts.
 */
import {
  DEFAULT_PROFILE,
  DEFAULT_RESHARE,
  buildProfile,
  cloud,
  hasWrittenProfile,
  listAccounts,
  loadSettings,
  networkFromUrl,
  ownTopics,
  parseOpenProfile,
  profilePath,
  readProfile,
  reshare,
  runReshare,
  saveSettings,
  writeProfile,
  type ProfileSettings,
  type ReshareSettings,
} from "@profullstack/myna-core";
import { out, table } from "./io.ts";

type Flags = Record<string, unknown>;

const money = (usd: number): string => (usd > 0 ? `$${usd.toFixed(2)}` : "free");

function requireCloud(): void {
  if (!cloud.session()?.token) {
    throw new Error("The reshare network uses your myna cloud account. Sign in first:  myna cloud login <email>");
  }
}

export async function runProfile(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  switch (sub ?? "show") {
    case "show": {
      const current = readProfile();
      process.stdout.write(current.markdown);
      if (current.source === "built" && !flags.quiet) {
        out("");
        out(`(built from settings and ${listAccounts().length} accounts; myna profile write puts it in a file you can edit)`);
      }
      return 0;
    }
    case "write": {
      const result = writeProfile({ force: Boolean(flags.force) });
      out(result.written ? `Wrote ${result.path}` : `${result.path} already exists and is yours. --force replaces it.`);
      return 0;
    }
    case "path":
      out(profilePath());
      return 0;
    case "set": {
      const [key, ...valueParts] = rest;
      const value = valueParts.join(" ");
      if (!key || !(key in DEFAULT_PROFILE)) {
        throw new Error(`Usage: myna profile set <${Object.keys(DEFAULT_PROFILE).join("|")}> <value>`);
      }
      const settings = loadSettings();
      const field = key as keyof ProfileSettings;
      if (field === "kind" && !/^(|person|agent|organization)$/.test(value)) {
        throw new Error("kind is person, agent or organization.");
      }
      settings.profile = { ...settings.profile, [field]: value } as ProfileSettings;
      saveSettings(settings);
      out(`profile.${key} = ${value || "(empty)"}`);
      if (hasWrittenProfile()) out(`Note: ${profilePath()} is hand-written and wins; edit it there too.`);
      return 0;
    }
    default:
      throw new Error(`Unknown: myna profile ${sub}. Try show, write, path or set.`);
  }
}

export async function runReshareCommand(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const settings = loadSettings();

  switch (sub ?? "status") {
    case "join": {
      requireCloud();
      const current = readProfile();
      const parsed = parseOpenProfile(current.markdown);
      if (!parsed.reshare) {
        throw new Error("The profile has no ## Reshare section. Set what you offer first, e.g.  myna reshare set topics devtools,rust");
      }
      const status = await reshare.join(current.markdown);
      out(`Joined as ${status.handle ?? parsed.name ?? "you"} on ${cloud.session()?.server}`);
      out(`  will reshare: ${status.topics.length ? status.topics.join(", ") : "anything (no topics set)"}`);
      out(`  on: ${status.networks.length ? status.networks.join(", ") : "every account that can"}`);
      out(`  rate: ${money(status.rateUsd)}   limit: ${status.perDay}/day`);
      out("");
      out("The daemon (myna run) pulls matches every ten minutes. Or:  myna reshare pull");
      if (!settings.reshare.auto) out("Your own posts are not sent to the network until:  myna reshare set auto on");
      return 0;
    }

    case "leave": {
      requireCloud();
      out((await reshare.leave()) ? "Left the network. Nothing more will be matched to you." : "You were not in it.");
      return 0;
    }

    case "status": {
      const local = reshare.ledger();
      const session = cloud.session();
      if (!session?.token) {
        out("Not signed in. The reshare network uses your myna cloud account:");
        out("  myna cloud login <email>     then     myna reshare join");
        return 0;
      }
      const status = await reshare.status();
      out(status.joined ? `Joined as ${status.handle ?? "you"} on ${session.server}` : `Not joined (signed in as ${session.email}).  myna reshare join`);
      if (status.joined) {
        out(`  offering: ${status.topics.length ? status.topics.join(", ") : "anything"} on ${status.networks.length ? status.networks.join(", ") : "every account that can"}`);
        out(`  rate ${money(status.rateUsd)}, limit ${status.perDay}/day, ${status.done} reshared for others so far`);
      }
      out(`  your open requests: ${status.open}`);
      out(`  auto: ${settings.reshare.auto ? "on (every post is offered to the network)" : "off"}   bounty: ${money(settings.reshare.bountyUsd)}/reshare`);
      out(`  today: ${reshare.doneToday().length}/${settings.reshare.perDay} done locally${local.joinedAt ? `, joined ${local.joinedAt.slice(0, 10)}` : ""}`);
      return 0;
    }

    case "set": {
      const [key, ...valueParts] = rest;
      const raw = valueParts.join(" ");
      if (!key || !(key in DEFAULT_RESHARE)) {
        throw new Error(`Usage: myna reshare set <${Object.keys(DEFAULT_RESHARE).join("|")}> <value>`);
      }
      const field = key as keyof ReshareSettings;
      const current = settings.reshare[field];
      let value: string | number | boolean;
      if (typeof current === "boolean") {
        if (!/^(on|off|true|false|yes|no|1|0)$/i.test(raw)) throw new Error(`${key} is on or off.`);
        value = /^(on|true|yes|1)$/i.test(raw);
      } else if (typeof current === "number") {
        value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new Error(`${key} is a number, 0 or more.`);
      } else value = raw;
      settings.reshare = { ...settings.reshare, [field]: value } as ReshareSettings;
      saveSettings(settings);
      out(`reshare.${key} = ${String(value)}`);
      if (field === "rateUsd" && value !== 0 && !settings.profile.pay && !parseOpenProfile(readProfile().markdown).pay) {
        out("A rate needs somewhere to be paid:  myna profile set pay eip155:8453:0x...");
      }
      if (reshare.joined() && ["topics", "not", "networks", "rateUsd", "perDay"].includes(field)) {
        out("Publish the change:  myna reshare join");
      }
      return 0;
    }

    case "ask": {
      requireCloud();
      if (!reshare.joined()) throw new Error("Join first: myna reshare join. The network is people resharing each other.");
      const urls = rest.filter((arg) => /^https?:\/\//i.test(arg));
      if (!urls.length) throw new Error("Usage: myna reshare ask <post url> [<post url>...] [--topics a,b] [--bounty 0.05] [--text \"...\"]");
      const topics = [
        ...(typeof flags.topics === "string" ? flags.topics.split(",").map((topic) => topic.trim()).filter(Boolean) : []),
        ...ownTopics(settings),
      ];
      const posts = urls.map((url) => ({ network: networkFromUrl(url), url }));
      const known = new Set(listAccounts().map((account) => account.network));
      // A URL on a network myna does not know is still shareable: as a link
      // anyone can quote, rather than as a post to repost natively.
      const link = posts.find((post) => !known.has(post.network) && post.network !== "web")?.url ?? null;
      const sent = await reshare.submit({
        ...(typeof flags.text === "string" ? { text: flags.text } : {}),
        topics,
        posts: posts.filter((post) => known.has(post.network)),
        link,
        bountyUsd: typeof flags.bounty === "string" ? Number(flags.bounty) : settings.reshare.bountyUsd,
        maxSharers: settings.reshare.maxSharers,
      });
      out(`Asked. ${sent.matched} sharer${sent.matched === 1 ? "" : "s"} match right now (request ${sent.id}).`);
      return 0;
    }

    case "matches": {
      requireCloud();
      const found = await reshare.matches(typeof flags.limit === "string" ? Number(flags.limit) : 20);
      if (!found.length) {
        out("Nothing to reshare right now.");
        return 0;
      }
      table(
        found.map((match) => ({
          score: match.score.toFixed(2),
          from: match.author,
          on: match.networks.join(","),
          bounty: money(match.bountyUsd),
          what: (match.title ?? match.text ?? match.posts[0]?.url ?? match.link ?? "").split("\n")[0]?.slice(0, 60) ?? "",
          id: match.id,
        })),
        [
          { key: "score", title: "Fit" },
          { key: "from", title: "From" },
          { key: "on", title: "On" },
          { key: "bounty", title: "Bounty" },
          { key: "what", title: "What" },
          { key: "id", title: "Request" },
        ],
      );
      return 0;
    }

    case "pull": {
      requireCloud();
      const turn = await runReshare({
        log: (line) => out(line),
        ...(typeof flags.limit === "string" ? { limit: Number(flags.limit) } : {}),
      });
      if (turn.skipped && !turn.done.length) out(`Nothing done: ${turn.skipped}.`);
      else out(`Reshared ${turn.done.filter((entry) => entry.ok).length} of ${turn.done.length}.`);
      return 0;
    }

    case "requests": {
      requireCloud();
      const rows = await reshare.requests();
      if (!rows.length) {
        out("No requests yet. Turn auto on, or:  myna reshare ask <post url>");
        return 0;
      }
      for (const row of rows) {
        out(`${row.createdAt.slice(0, 16).replace("T", " ")}  ${row.status.padEnd(7)}  ${money(row.bountyUsd)}  ${row.title ?? row.posts[0]?.url ?? ""}  (${row.id})`);
        for (const claim of row.claims) {
          out(`    ${claim.status.padEnd(7)} ${claim.sharer} on ${claim.network}${claim.url ? `  ${claim.url}` : ""}${claim.paidAt ? "  paid" : ""}`);
        }
      }
      return 0;
    }

    case "close": {
      requireCloud();
      const id = rest[0];
      if (!id) throw new Error("Usage: myna reshare close <request id>");
      out((await reshare.close(id)) ? `Closed ${id}.` : "No open request of yours with that id.");
      return 0;
    }

    case "log": {
      const entries = reshare.ledger().done.slice().reverse().slice(0, typeof flags.limit === "string" ? Number(flags.limit) : 30);
      if (!entries.length) {
        out("Nothing reshared yet.");
        return 0;
      }
      for (const entry of entries) {
        out(`${entry.at.slice(0, 16).replace("T", " ")}  ${entry.ok ? "ok    " : "failed"}  ${entry.how.padEnd(6)}  ${entry.accountId}  for ${entry.author}${entry.url ? `  ${entry.url}` : ""}${entry.error ? `  ${entry.error}` : ""}`);
      }
      return 0;
    }

    case "owed": {
      requireCloud();
      const book = await reshare.ledgerRemote();
      const unpaid = book.owed.filter((row) => !row.paidAt);
      const total = unpaid.reduce((sum, row) => sum + row.bountyUsd, 0);
      if (!unpaid.length) out("You owe nothing.");
      else {
        out(`You owe ${money(total)} across ${unpaid.length} reshare${unpaid.length === 1 ? "" : "s"}:`);
        for (const row of unpaid) {
          out(`  ${money(row.bountyUsd).padStart(7)}  ${row.who} on ${row.network}  ${row.pay ?? "(no Pay line in their profile)"}  claim ${row.id}`);
        }
        out("");
        out("Pay with CoinPay to the address shown, then:  myna reshare paid <claim> --ref <tx or invoice>");
      }
      const earned = book.earned.reduce((sum, row) => sum + row.bountyUsd, 0);
      if (book.earned.length) {
        const paid = book.earned.filter((row) => row.paidAt).reduce((sum, row) => sum + row.bountyUsd, 0);
        out(`Earned ${money(earned)} from ${book.earned.length} reshare${book.earned.length === 1 ? "" : "s"}; ${money(paid)} recorded as paid.`);
      }
      return 0;
    }

    case "paid": {
      requireCloud();
      const id = rest[0];
      const ref = typeof flags.ref === "string" ? flags.ref : "";
      if (!id || !ref) throw new Error("Usage: myna reshare paid <claim id> --ref <transaction or invoice reference>");
      await reshare.markPaid(id, ref);
      out(`Recorded ${id} as paid (${ref}).`);
      return 0;
    }

    case "profile": {
      // What the network would see, without joining.
      process.stdout.write(hasWrittenProfile() ? readProfile().markdown : buildProfile());
      return 0;
    }

    default:
      throw new Error(`Unknown: myna reshare ${sub}. Try join, leave, status, set, ask, matches, pull, requests, close, log, owed or paid.`);
  }
}
