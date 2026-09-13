/**
 * `myna atproto`: the directory of AT Protocol servers at mynaposter.com/listing/atproto.
 *
 *   myna atproto                       the list (PDSes, relays, feed generators, labelers)
 *   myna atproto list [q] [--kind pds] [--online] [--json]
 *   myna atproto add <url> [--description "..."] [--tags a,b]    needs myna cloud login
 *   myna atproto refresh <id> | rm <id>
 *   myna atproto probe <url>           what the directory would find, without listing it
 *   myna atproto signup <pds> [--handle x] [--email e] [--invite code] [--no-profile]
 *                                      make an account there from your OpenProfile
 *   myna atproto profile [account] [--dry-run]
 *                                      push your OpenProfile to a Bluesky profile
 *
 * A PDS listed here is a place to make an account; myna atproto signup makes
 * one from your OpenProfile, and myna login bluesky takes its URL as the
 * service for one that already exists.
 */
import { atproto, cloud, probeAtproto, createAtprotoAccount, pushAtprotoProfile, currentProfile, listAccounts, saveAccount, type AtprotoKind } from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const KINDS: AtprotoKind[] = ["pds", "relay", "feed", "labeler", "unknown"];

function line(server: { url: string; kind: string; online: boolean; did: string | null; userDomains: string[]; inviteCodeRequired: boolean | null; version: string | null; name: string | null }): string {
  const extra = server.kind === "pds" ? `${server.userDomains.join(" ") || "no handle domains"}${server.inviteCodeRequired === false ? ", open signup" : server.inviteCodeRequired === true ? ", invite code" : ""}` : (server.name ?? server.did ?? "");
  return `${server.online ? "on " : "off"}  ${server.kind.padEnd(7)}  ${server.url.padEnd(40)}  ${extra}`;
}

export async function runAtproto(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const json = flags.json === true;

  switch (sub ?? "list") {
    case "list": {
      const kind = typeof flags.kind === "string" ? (flags.kind as AtprotoKind) : undefined;
      if (kind && !KINDS.includes(kind)) throw new Error(`--kind is one of ${KINDS.join(", ")}.`);
      const servers = await atproto.listServers({ kind, online: flags.online === true, q: rest.join(" ") || undefined });
      if (json) {
        out(JSON.stringify(servers, null, 2));
        return 0;
      }
      if (!servers.length) {
        out("Nothing listed yet. myna atproto add <url> lists a server (after myna cloud login).");
        return 0;
      }
      for (const server of servers) out(line(server));
      out("");
      out("The same list, on the web: https://mynaposter.com/listing/atproto");
      return 0;
    }
    case "probe": {
      if (!rest[0]) throw new Error("Usage: myna atproto probe <url>");
      const probe = await probeAtproto(rest[0]);
      if (json) out(JSON.stringify(probe, null, 2));
      else {
        out(line(probe));
        if (probe.did) out(`  did: ${probe.did}`);
        if (probe.version) out(`  version: ${probe.version}`);
        if (probe.error) out(`  ${probe.error}`);
      }
      return probe.online ? 0 : 1;
    }
    case "add": {
      if (!rest[0]) throw new Error("Usage: myna atproto add <url> [--description \"...\"] [--tags a,b]");
      if (!cloud.session()?.token) throw new Error("Listing a server uses your myna cloud account:  myna cloud login <email>");
      const server = await atproto.addServer(rest[0], {
        ...(typeof flags.description === "string" ? { description: flags.description } : {}),
        ...(typeof flags.tags === "string" ? { tags: flags.tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
      });
      if (json) out(JSON.stringify(server, null, 2));
      else {
        out(`Listed ${server.url} as ${server.kind}${server.did ? ` (${server.did})` : ""}.`);
        out(`https://mynaposter.com/listing/atproto`);
      }
      return 0;
    }
    case "refresh": {
      if (!rest[0]) throw new Error("Usage: myna atproto refresh <id>");
      const server = await atproto.refreshServer(rest[0]);
      out(line(server));
      return 0;
    }
    case "rm":
    case "remove": {
      if (!rest[0]) throw new Error("Usage: myna atproto rm <id>");
      out((await atproto.removeServer(rest[0])) ? `Removed ${rest[0]}.` : "Nothing removed.");
      return 0;
    }
    case "signup": {
      // myna atproto signup <pds> [--handle x] [--email e] [--invite code] [--password p] [--no-profile]
      if (!rest[0]) throw new Error("Usage: myna atproto signup <pds url> [--handle name] [--email you@example.com] [--invite code] [--no-profile]");
      const profile = currentProfile();
      const result = await createAtprotoAccount({
        service: rest[0],
        profile,
        ...(typeof flags.handle === "string" ? { handle: flags.handle } : {}),
        ...(typeof flags.email === "string" ? { email: flags.email } : {}),
        ...(typeof flags.invite === "string" ? { inviteCode: flags.invite } : {}),
        ...(typeof flags.password === "string" ? { password: flags.password } : {}),
      });
      saveAccount(result.account);
      if (json) {
        out(JSON.stringify({ id: result.account.id, handle: result.account.handle, did: result.did, service: result.service }, null, 2));
      } else {
        out(`Made ${result.account.handle} at ${result.service} (${result.did}).`);
        out(`Connected as ${result.account.id}; the password is in the vault${typeof flags.password === "string" ? "" : ", generated, 144 bits"}.`);
      }
      if (flags.noProfile) return 0;
      const pushed = await pushAtprotoProfile(result.account, profile);
      if (!json) {
        out(`Profile set from your OpenProfile: ${pushed.record.displayName ?? result.account.handle}${pushed.record.description ? `, "${pushed.record.description.split("\n")[0]}"` : ""}${pushed.avatar ? ", avatar uploaded" : ""}.`);
        if (pushed.avatarNote) out(`  ${pushed.avatarNote}`);
        out("myna profile now lists the new account. myna atproto profile pushes changes again later.");
      }
      return 0;
    }
    case "profile": {
      // myna atproto profile [account] [--dry-run]
      const profile = currentProfile();
      const spec = rest[0];
      const accounts = listAccounts().filter((account) => account.network === "bluesky" && (!spec || account.id === spec || account.handle === spec || `bluesky:${spec}` === account.id));
      if (!accounts.length) throw new Error(spec ? `No connected Bluesky account matching "${spec}".` : "No Bluesky account connected. myna login bluesky, or myna atproto signup <pds>.");
      for (const account of accounts) {
        const pushed = await pushAtprotoProfile(account, profile, { dryRun: flags.dryRun === true });
        if (json) {
          out(JSON.stringify({ account: account.id, record: pushed.record, avatar: pushed.avatar, avatarNote: pushed.avatarNote }, null, 2));
          continue;
        }
        out(`${account.id}  ${flags.dryRun ? "would set" : "set"}: ${pushed.record.displayName ?? account.handle}${pushed.record.description ? ` / ${pushed.record.description.replace(/\n+/g, " · ")}` : ""}${pushed.avatar ? "  (avatar uploaded)" : ""}`);
        if (pushed.avatarNote) out(`  ${pushed.avatarNote}`);
      }
      return 0;
    }
    default:
      throw new Error(`Unknown: myna atproto ${sub}. Try list, add, probe, signup, profile, refresh or rm.`);
  }
}
