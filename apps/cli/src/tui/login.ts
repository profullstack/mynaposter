/**
 * The login dialog.
 *
 * `/login facebook` opens this. What it asks for comes from the adapter, so a
 * password network shows a password box and an OAuth network shows the app
 * fields and then hands off to the browser — same command either way.
 */
import { listAccounts, openBrowser, saveAccount, type Account, type Network } from "@profullstack/myna-core";
import { Field } from "./field.ts";
import { toast, type State } from "./state.ts";

export function startLogin(state: State, network: Network, redraw: () => void): void {
  state.login = {
    network,
    fields: network.auth.fields.map(
      (field) =>
        new Field(field.key, field.label, {
          secret: field.secret,
          placeholder: field.placeholder,
          help: field.help,
          optional: field.optional,
        }, field.default ?? ""),
    ),
    active: 0,
    log: [],
    busy: false,
  };
  state.previousMode = state.mode;
  state.mode = "login";
  redraw();
}

export function cancelLogin(state: State): void {
  state.login = undefined;
  state.mode = "command";
}

export async function submitLogin(state: State, redraw: () => void): Promise<void> {
  const flow = state.login;
  if (!flow || flow.busy) return;

  const values: Record<string, string> = {};
  for (const field of flow.fields) {
    const spec = flow.network.auth.fields.find((entry) => entry.key === field.key);
    if (!field.value.trim() && !spec?.optional) {
      flow.error = `${field.label} is required.`;
      flow.active = flow.fields.indexOf(field);
      redraw();
      return;
    }
    values[field.key] = field.value;
  }

  flow.busy = true;
  flow.error = undefined;
  flow.log = [];
  redraw();

  try {
    const partial = await flow.network.login(values, {
      report(message) {
        flow.log.push(message);
        redraw();
      },
      async openUrl(url) {
        flow.log.push(url);
        redraw();
        await openBrowser(url);
      },
    });

    const account: Account = {
      ...partial,
      id: `${flow.network.id}:${partial.handle}`,
      network: flow.network.id,
      addedAt: new Date().toISOString(),
    };
    saveAccount(account);

    state.accounts = listAccounts();
    state.login = undefined;
    state.mode = "command";
    state.screen = "accounts";
    toast(state, `Connected ${account.id}`, "success");
  } catch (error) {
    flow.busy = false;
    flow.error = (error as Error).message;
  } finally {
    redraw();
  }
}
