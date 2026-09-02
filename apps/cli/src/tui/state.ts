/** Everything the TUI draws from. One object, mutated in place, read each frame. */
import type { Account, Network, TimelineItem } from "@profullstack/myna-core";
import { Field, TextArea } from "./field.ts";

export type Screen = "compose" | "accounts" | "queue" | "history" | "performance" | "feed" | "networks" | "help";

export const SCREENS: Screen[] = ["compose", "accounts", "queue", "history", "performance", "feed", "networks", "help"];

export type Mode =
  /** Typing a slash command in the bar at the bottom. */
  | "command"
  /** Editing the post itself. */
  | "compose"
  /** Filling in a network's login dialog. */
  | "login"
  /** Choosing which accounts to post to. */
  | "targets"
  /** A yes/no dialog is open. */
  | "confirm"
  /** A generic modal is asking for values. */
  | "prompt";

export interface Toast {
  text: string;
  kind: "info" | "success" | "error";
  at: number;
}

export interface LoginFlow {
  network: Network;
  fields: Field[];
  active: number;
  /** Progress lines from the adapter, e.g. "Opening your browser…". */
  log: string[];
  busy: boolean;
  error?: string;
}

/**
 * A generic modal that asks for a few values and hands them back.
 *
 * The login dialog is network-shaped; this is for everything else that needs
 * typed input, which so far is the bundle passphrase.
 */
export interface PromptFlow {
  title: string;
  /** Shown above the fields, wrapped. */
  note?: string;
  fields: Field[];
  active: number;
  busy: boolean;
  error?: string;
  log: string[];
  submit(values: Record<string, string>): void | Promise<void>;
}

export interface ConfirmFlow {
  title: string;
  message: string;
  onYes: () => void;
}

export interface State {
  screen: Screen;
  mode: Mode;
  /** Where the command bar sends you back to when you press Escape. */
  previousMode: Mode;

  command: Field;
  compose: TextArea;
  title: Field;

  accounts: Account[];
  /** Account ids selected as post targets. Empty means every account. */
  targets: Set<string>;
  targetCursor: number;

  login?: LoginFlow;
  prompt?: PromptFlow;
  confirm?: ConfirmFlow;

  feed: TimelineItem[];
  feedSource: string;
  feedCursor: number;

  listCursor: number;

  toast?: Toast;
  /** A long operation is in flight; the status bar says so. */
  busy: string;

  /** Command history, newest last, walked with Up and Down. */
  history: string[];
  historyIndex: number;

  /** Set when a draft came from the writer, so the UI can say so. */
  draftSource: string;
  /** Attachment paths staged for the next post. */
  media: string[];

  quit: boolean;
}

export function createState(accounts: Account[]): State {
  return {
    screen: "compose",
    mode: "command",
    previousMode: "command",
    command: new Field("command", "", { placeholder: "/help for commands" }),
    compose: new TextArea(),
    title: new Field("title", "Title", { optional: true, placeholder: "for Reddit, Lemmy and blogs" }),
    accounts,
    targets: new Set(),
    targetCursor: 0,
    feed: [],
    feedSource: "",
    feedCursor: 0,
    listCursor: 0,
    busy: "",
    history: [],
    historyIndex: -1,
    draftSource: "",
    media: [],
    quit: false,
  };
}

export function toast(state: State, text: string, kind: Toast["kind"] = "info"): void {
  state.toast = { text, kind, at: Date.now() };
}

/** The accounts a post would go to right now. */
export function selectedAccounts(state: State): Account[] {
  if (!state.targets.size) return state.accounts;
  return state.accounts.filter((account) => state.targets.has(account.id));
}
