/**
 * `myna atproto`: the directory of AT Protocol servers at mynaposter.com/listing/atproto.
 *
 *   myna atproto                       the list (PDSes, relays, feed generators, labelers)
 *   myna atproto list [q] [--kind pds] [--online] [--json]
 *   myna atproto add <url> [--description "..."] [--tags a,b]    needs myna cloud login
 *   myna atproto refresh <id> | rm <id>
 *   myna atproto probe <url>           what the directory would find, without listing it
 *
 * A PDS listed here is a place to make an account; myna login bluesky takes
 * its URL as the service.
 */
import { atproto, cloud, probeAtproto, type AtprotoKind } from "@profullstack/myna-core";
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
    default:
      throw new Error(`Unknown: myna atproto ${sub}. Try list, add, probe, refresh or rm.`);
  }
}
