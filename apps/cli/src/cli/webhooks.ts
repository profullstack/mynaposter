/**
 * `myna webhooks`: your myna cloud account calls your URL, signed, when
 * something happens.
 *
 *   myna webhooks [list] [--json]              endpoints, and the events there are
 *   myna webhooks add <url> [--events a,b] [--description "..."]
 *                                              prints the signing secret once; turns the relay on
 *   myna webhooks show <id>                    one endpoint
 *   myna webhooks edit <id> [--url u] [--events a,b] [--description d]
 *   myna webhooks enable <id> | disable <id>
 *   myna webhooks secret <id> | rotate <id>    show the secret, or replace it
 *   myna webhooks test <id>                    send webhook.test now
 *   myna webhooks deliveries [<id>] [--limit n] [--json]
 *   myna webhooks retry <delivery id>
 *   myna webhooks rm <id>
 *   myna webhooks relay [on|off]               report this machine's posts and sends
 *
 * Deliveries are CloudEvents signed per Standard Webhooks (webhook-id,
 * webhook-timestamp, webhook-signature). Needs `myna cloud login`.
 */
import { webhooks, type WebhookEndpoint } from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const list = (value: unknown): string[] | undefined =>
  typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;

function line(endpoint: WebhookEndpoint): string {
  const state = endpoint.enabled ? "on " : "off";
  const why = endpoint.disabled_reason ? `  (${endpoint.disabled_reason})` : endpoint.failures ? `  (${endpoint.failures} failing)` : "";
  return `${endpoint.id}  ${state}  ${endpoint.url}  [${endpoint.events.join(", ")}]${endpoint.description ? `  ${endpoint.description}` : ""}${why}`;
}

const SECRET_NOTE = "Keep it: verify each delivery's webhook-signature with it (any Standard Webhooks library).";

export async function runWebhooks(positional: string[], flags: Flags): Promise<number> {
  const [sub = "list", ...rest] = positional;
  const json = flags.json === true;
  const id = rest[0];
  const need = (usage: string): string => {
    if (!id) throw new Error(`Usage: myna webhooks ${usage}`);
    return id;
  };

  switch (sub) {
    case "list":
    case "ls": {
      const { endpoints, event_types } = await webhooks.listWebhooks();
      if (json) {
        out(JSON.stringify({ endpoints, event_types, relay: webhooks.relayOn() }, null, 2));
        return 0;
      }
      if (!endpoints.length) out("No webhooks yet. myna webhooks add https://example.com/hook --events post.*");
      for (const endpoint of endpoints) out(line(endpoint));
      out(`\nEvents: ${event_types.join(", ")}`);
      out(`Relay (this machine's posts and sends): ${webhooks.relayOn() ? "on" : "off, myna webhooks relay on"}`);
      return 0;
    }

    case "add":
    case "create": {
      const url = need("add <https url> [--events post.published,post.failed] [--description ...]");
      const created = await webhooks.addWebhook({
        url,
        events: list(flags.events),
        description: typeof flags.description === "string" ? flags.description : undefined,
      });
      // Posts and newsletters start on this machine, so an endpoint is only
      // useful for them with the relay on.
      webhooks.setRelay(true);
      if (json) {
        out(JSON.stringify(created, null, 2));
        return 0;
      }
      out(line(created.endpoint));
      out(`secret  ${created.secret}`);
      out(SECRET_NOTE);
      out("Relay on: this machine now reports its posts and newsletter sends to myna cloud.");
      return 0;
    }

    case "show":
    case "get": {
      const endpoint = await webhooks.getWebhook(need("show <id>"));
      out(json ? JSON.stringify(endpoint, null, 2) : line(endpoint));
      return 0;
    }

    case "edit":
    case "update": {
      const patch: { url?: string; events?: string[]; description?: string } = {};
      if (typeof flags.url === "string") patch.url = flags.url;
      if (list(flags.events)) patch.events = list(flags.events);
      if (typeof flags.description === "string") patch.description = flags.description;
      if (!Object.keys(patch).length) throw new Error("Usage: myna webhooks edit <id> [--url u] [--events a,b] [--description d]");
      const endpoint = await webhooks.updateWebhook(need("edit <id>"), patch);
      out(json ? JSON.stringify(endpoint, null, 2) : line(endpoint));
      return 0;
    }

    case "enable":
    case "disable": {
      const endpoint = await webhooks.updateWebhook(need(`${sub} <id>`), { enabled: sub === "enable" });
      out(json ? JSON.stringify(endpoint, null, 2) : line(endpoint));
      return 0;
    }

    case "secret": {
      const { secret } = await webhooks.webhookSecret(need("secret <id>"));
      out(json ? JSON.stringify({ secret }) : secret);
      return 0;
    }

    case "rotate": {
      const { secret } = await webhooks.rotateWebhook(need("rotate <id>"));
      if (json) out(JSON.stringify({ secret }));
      else {
        out(`secret  ${secret}`);
        out("The old secret stops working now. " + SECRET_NOTE);
      }
      return 0;
    }

    case "test":
    case "ping": {
      const result = await webhooks.testWebhook(need("test <id>"));
      if (json) out(JSON.stringify(result, null, 2));
      else out(result.ok ? `Delivered: ${result.status}` : `Not delivered: ${result.error ?? result.status}`);
      return result.ok ? 0 : 1;
    }

    case "deliveries":
    case "log": {
      const limit = Number(flags.limit ?? 20) || 20;
      const rows = await webhooks.webhookDeliveries(id, limit);
      if (json) {
        out(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (!rows.length) out("No deliveries yet.");
      for (const row of rows) {
        const result = row.last_status ?? row.last_error ?? "";
        out(`${row.id}  ${row.created_at.slice(0, 16).replace("T", " ")}  ${row.status.padEnd(9)}  ${row.event_type.padEnd(24)}  ${row.attempts}x  ${result}`);
      }
      return 0;
    }

    case "retry": {
      const row = await webhooks.retryDelivery(need("retry <delivery id>"));
      out(json ? JSON.stringify(row, null, 2) : `${row.id} queued again (${row.status}).`);
      return 0;
    }

    case "rm":
    case "remove":
    case "delete": {
      await webhooks.removeWebhook(need("rm <id>"));
      out(`Removed ${id}.`);
      return 0;
    }

    case "relay": {
      const want = rest[0];
      if (want === "on" || want === "off") webhooks.setRelay(want === "on");
      else if (want) throw new Error("Usage: myna webhooks relay [on|off]");
      out(`Relay ${webhooks.relayOn() ? "on" : "off"}${want === "on" && !webhooks.relayOn() ? " (sign in first: myna cloud login)" : ""}.`);
      return 0;
    }

    default:
      throw new Error(`Unknown webhooks command "${sub}". Try: list, add, show, edit, enable, disable, secret, rotate, test, deliveries, retry, rm, relay`);
  }
}
