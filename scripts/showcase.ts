/**
 * Frames for the hqtui.com apps showcase.
 *
 * hqtui.com/apps captures screenshots of applications built on the library. The
 * capture script takes an application directory and imports this file, because
 * only the application knows what a good state looks like.
 *
 * A fixture, and the accounts are invented. This is a posting client: a
 * screenshot from a real session would put somebody's connected handles on a
 * public web page, and the vault holds credentials for every one of them.
 * Nothing here touches the vault.
 */
import type { Account } from "@profullstack/myna-core";
import { drawApp } from "../apps/cli/src/tui/app.ts";
import { createState, type State } from "../apps/cli/src/tui/state.ts";

const account = (network: string, handle: string, displayName: string): Account => ({
  id: `${network}:${handle}`,
  network,
  handle,
  displayName,
  addedAt: "2026-06-01T00:00:00.000Z",
  creds: {},
  meta: {},
});

const ACCOUNTS: Account[] = [
  account("bluesky", "myna.bsky.social", "Myna"),
  account("mastodon", "@myna@fosstodon.org", "Myna"),
  account("linkedin", "myna-poster", "Myna"),
  account("reddit", "u/mynaposter", "Myna"),
  account("devto", "mynaposter", "Myna"),
  account("hashnode", "myna", "Myna"),
];

const POST = [
  "hqtui 0.3.0 is out: styled text spans, so a line can carry more than one colour.",
  "",
  "Syntax highlighting, inline log levels and word-level diffs were all off the",
  "table before this. Every widget that took a string takes spans now, and a bare",
  "string is still the one-span case — nothing that worked had to change.",
  "",
  "https://hqtui.com/blog/0-3-0-styled-text-spans",
].join("\n");

function composeState(): State {
  const state = createState(ACCOUNTS);
  state.screen = "compose";
  state.mode = "compose";
  state.compose.value = POST;
  state.compose.cursor = POST.length;
  // Three of six selected, so the header badge shows a count rather than "all".
  state.targets = new Set([ACCOUNTS[0]!.id, ACCOUNTS[1]!.id, ACCOUNTS[4]!.id]);
  state.command.value = "/post";
  state.command.cursor = 5;
  return state;
}

const STATE = composeState();

export const frames = [
  {
    name: "myna",
    width: 124,
    height: 32,
    draw: (args: Parameters<typeof drawApp>[0]) => {
      // No invalidate: a headless render has nothing to redraw.
      drawApp(args, STATE);
    },
  },
];
