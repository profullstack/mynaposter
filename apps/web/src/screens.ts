/**
 * The screenshots on the marketing site.
 *
 * These are real hqtui views rendered through the HTML renderer, not images of
 * a terminal, so what the site shows is what the program draws.
 */
import type { Container, Theme } from "@profullstack/hqtui";

/** renderToHtml passes a narrower argument set than a live app does. */
type ShotArgs = { ui: Container; theme: Theme; width: number; height: number };
import { charsFor, requireNetwork, tailor } from "@profullstack/myna-core";

const ACCOUNTS = [
  { id: "bluesky:alice.bsky.social", network: "bluesky" },
  { id: "mastodon:@alice@hachyderm.io", network: "mastodon" },
  { id: "x:@alicechen", network: "x" },
  { id: "reddit:u/alicechen", network: "reddit" },
  { id: "nostr:npub1a4k…", network: "nostr" },
];

const POST = [
  "myna posts to every network I use from one terminal window.",
  "",
  "One command, tailored per network. It reads a link and drafts the post too.",
  "",
  "https://mynaposter.com",
].join("\n");

const SCREENS = ["compose", "accounts", "queue", "history", "feed", "networks", "help"];

export function composeScreenshot({ ui, theme }: ShotArgs): void {
  ui.column({ size: "1fr" }, (root) => {
    root.row({ size: 1 }, (header) => {
      header.tabs({ tabs: SCREENS, active: 0, size: "fill" });
      header.badge({ text: `all ${ACCOUNTS.length}`, color: theme.success, size: 12 });
    });
    root.spacer(1);

    root.row({ size: "1fr", gap: 1 }, (row) => {
      row.panel({ title: "Compose", size: "2fr" }, (panel) => {
        for (const line of POST.split("\n")) {
          panel.text(line || " ", { size: 1, fg: theme.foreground });
        }
        panel.spacer("fill");
        panel.label("written from the link, edit before posting", { size: 1, fg: theme.accent });
      });

      row.panel({ title: "Goes to", size: "1fr" }, (panel) => {
        for (const account of ACCOUNTS) {
          const network = requireNetwork(account.network);
          const parts = tailor(account.network, { text: POST, thread: true });
          const used = charsFor(account.network, parts[0]);
          const limit = network.caps.charLimit;
          panel.keyValues([
            {
              label: account.id.length > 21 ? `${account.id.slice(0, 20)}…` : account.id,
              value: parts.length > 1 ? `thread of ${parts.length}` : limit ? `${used}/${limit}` : `${used}`,
              color: parts.length > 1 ? theme.warning : theme.success,
            },
          ]);
        }
      });
    });

    root.spacer(1);
    root.panel({ size: 3, title: "Command" }, (box) => {
      box.textInput({
        value: "/link https://example.com/blog/shipping-myna",
        cursor: 44,
        focused: true,
        size: 1,
      });
    });
    root.statusBar({
      size: 1,
      items: [
        { label: "myna", color: theme.primary },
        { label: "/ for commands    Enter to edit the post    Ctrl+S to send", color: theme.muted },
        { key: "accounts", label: String(ACCOUNTS.length) },
      ],
    });
  });
}

export function loginScreenshot({ ui, theme }: ShotArgs): void {
  ui.panel({ title: "myna", size: "1fr" }, (panel) => {
    panel.label("  Connecting an account asks for whatever that network accepts.", { size: 1 });
  });

  ui.modal({ title: "Connect Bluesky", width: 74, height: 14 }, (panel) => {
    panel.label("Create an App Password at Settings, Privacy and Security, App", { size: 1 });
    panel.label("Passwords. Your main password works but is a bad idea.", { size: 1 });
    panel.spacer(1);
    panel.textInput({ value: "alice.bsky.social", cursor: 17, label: "Handle *", size: 1 });
    panel.textInput({
      value: "xxxxxxxxxxxxxxxxxxx",
      cursor: 19,
      label: "App password *",
      password: true,
      focused: true,
      size: 1,
    });
    panel.textInput({ value: "https://bsky.social", cursor: 19, label: "PDS", size: 1 });
    panel.spacer(1);
    panel.label("Tab next field    Enter connect    Esc cancel", { size: 1, fg: theme.muted });
  });
}
