/**
 * The login dialog.
 *
 * `/login facebook` opens this. What it asks for comes from the adapter, so a
 * password network shows a password box and an OAuth network shows the app
 * fields and then hands off to the browser — same command either way.
 */
import {
  listAccounts,
  openBrowser,
  saveAccount,
  saveDirectoryAccount,
  type Account,
  type Directory,
  type DirectoryAccount,
  type Network,
} from "@profullstack/myna-core";
import { Field } from "./field.ts";
import { toast, type State } from "./state.ts";

export function startLogin(
  state: State,
  target: Network | Directory,
  redraw: () => void,
  values: Record<string, string> = {},
  kind: "network" | "directory" = "network",
): void {
  const fields = target.auth.fields.map(
    (field) =>
      new Field(field.key, field.label, {
        secret: field.secret,
        placeholder: field.placeholder,
        help: field.help,
        optional: field.optional,
      }, values[field.key] ?? field.default ?? ""),
  );
  // Start on the first thing still to answer rather than on a box that was
  // filled from the command line, which for a one-field network is the
  // difference between typing nothing and re-reading a URL you just typed.
  const firstEmpty = fields.findIndex((field) => !field.value.trim());
  state.login = {
    target,
    kind,
    fields,
    active: firstEmpty < 0 ? Math.max(0, fields.length - 1) : firstEmpty,
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
    const spec = flow.target.auth.fields.find((entry) => entry.key === field.key);
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
    const partial = await flow.target.login(values, {
      report(message) {
        flow.log.push(message);
        redraw();
      },
      async openUrl(url) {
        flow.log.push(url);
        redraw();
        await openBrowser(url);
      },
      // Paste-the-code sign-in, for a browser that is not on this machine.
      ask: (prompt) =>
        new Promise<string>((resolve) => {
          state.prompt = {
            title: prompt,
            note: flow.log.slice(-2).join("  "),
            fields: [new Field("value", "Code")],
            active: 0,
            busy: false,
            log: [],
            submit(values) {
              state.prompt = undefined;
              state.mode = "login";
              resolve(values.value.trim());
            },
          };
          state.mode = "prompt";
          redraw();
        }),
    });

    if (flow.kind === "directory") {
      const account: DirectoryAccount = {
        ...partial,
        directory: flow.target.id,
        addedAt: new Date().toISOString(),
      };
      saveDirectoryAccount(account);
      state.login = undefined;
      state.mode = "command";
      state.screen = "directories";
      toast(state, `Connected ${account.directory} as ${account.handle}`, "success");
    } else {
      const account: Account = {
        ...partial,
        id: `${flow.target.id}:${partial.handle}`,
        network: flow.target.id,
        addedAt: new Date().toISOString(),
      };
      saveAccount(account);

      state.accounts = listAccounts();
      state.login = undefined;
      state.mode = "command";
      state.screen = "accounts";
      toast(state, `Connected ${account.id}`, "success");
    }
  } catch (error) {
    flow.busy = false;
    flow.error = (error as Error).message;
  } finally {
    redraw();
  }
}
