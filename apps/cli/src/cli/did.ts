/**
 * `myna did`: prove a decentralized identifier at CoinPay, attach it to accounts.
 *
 *   myna did login [--cli] [--server url] [--client-id id]
 *   myna did show
 *   myna did assign <account...|all> [--role owner|operator]
 *   myna did unassign <account...|all>
 *   myna did set <server|clientId> <value>
 *   myna did logout
 *
 * `owner` says the DID is the person behind the account. `operator` says the
 * DID is answerable for an account that is itself an agent. The OpenProfile
 * carries it accordingly: identity block for a person, Operator for an agent.
 */
import {
  assignDid,
  clearDidSession,
  didStatus,
  loadSettings,
  loginWithCoinPay,
  loginWithCoinPayCli,
  saveSettings,
  unassignDid,
  type DidRole,
} from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

export interface DidIo {
  openUrl(url: string): Promise<void>;
}

export async function runDid(positional: string[], flags: Flags, io: DidIo): Promise<number> {
  const [sub, ...rest] = positional;
  const settings = loadSettings();

  switch (sub ?? "show") {
    case "login": {
      const server = typeof flags.server === "string" ? flags.server : undefined;
      const session = flags.cli
        ? await loginWithCoinPayCli({ server })
        : await loginWithCoinPay({
            server,
            clientId: typeof flags.clientId === "string" ? flags.clientId : undefined,
            ctx: {
              report: (line) => out(line),
              openUrl: io.openUrl,
            },
          });
      out(`Your DID is ${session.did}${session.label ? ` (${session.label})` : ""}${session.kind ? `, ${session.kind}` : ""}${session.verified ? ", verified" : ""}, proved at ${session.server} via ${session.via === "oauth" ? "an OAuth grant" : "the coinpay CLI login"}.`);
      out("");
      out("Attach it:  myna did assign all              (owner of every account)");
      out("            myna did assign <account> --role operator   (for an account that is an agent)");
      return 0;
    }

    case "show":
    case "status": {
      const status = didStatus();
      if (!status.session) {
        out("No DID yet. Prove one:  myna did login   (or myna did login --cli after coinpay login)");
        return 0;
      }
      const s = status.session;
      out(`${s.did}${s.label ? `  (${s.label})` : ""}${s.kind ? `  ${s.kind}` : ""}${s.verified ? "  verified" : ""}`);
      out(`  proved at ${s.server} via ${s.via}, ${s.since.slice(0, 10)}${s.name ? `, ${s.name}` : ""}${s.email ? ` <${s.email}>` : ""}`);
      out(`  owner of: ${status.owned.map((account) => account.id).join(", ") || "no account yet (myna did assign all)"}`);
      if (status.operated.length) out(`  operator of: ${status.operated.map((account) => account.id).join(", ")}`);
      if (status.foreign.length) out(`  other DIDs on: ${status.foreign.map((account) => `${account.id} (${account.meta.did})`).join(", ")}`);
      return 0;
    }

    case "assign": {
      if (!rest.length) throw new Error("Usage: myna did assign <account...|all> [--role owner|operator]");
      const role = String(flags.role ?? "owner") as DidRole;
      if (role !== "owner" && role !== "operator") throw new Error("--role is owner or operator.");
      const done = assignDid(rest, role);
      out(`${done.length} account${done.length === 1 ? "" : "s"} now carr${done.length === 1 ? "ies" : "y"} the DID as ${role}: ${done.map((account) => account.id).join(", ")}`);
      out("myna profile shows it; myna reshare join publishes it.");
      return 0;
    }

    case "unassign": {
      if (!rest.length) throw new Error("Usage: myna did unassign <account...|all>");
      const done = unassignDid(rest);
      out(done.length ? `Removed from ${done.map((account) => account.id).join(", ")}.` : "No account carried it.");
      return 0;
    }

    case "set": {
      const [key, value] = rest;
      if (!key || !value || !(key === "server" || key === "clientId")) throw new Error("Usage: myna did set <server|clientId> <value>");
      settings.did = { ...settings.did, [key]: value };
      saveSettings(settings);
      out(`did.${key} = ${value}`);
      return 0;
    }

    case "logout":
      clearDidSession();
      out("Forgotten. Accounts keep the DID they carry until myna did unassign.");
      return 0;

    default:
      throw new Error(`Unknown: myna did ${sub}. Try login, show, assign, unassign, set or logout.`);
  }
}
