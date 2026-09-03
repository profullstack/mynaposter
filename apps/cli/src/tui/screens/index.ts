/** The seven screens. Each one draws into a container and reads only state. */
import type { Container, Theme } from "@profullstack/hqtui";
import {
  charsFor,
  listHistory,
  listQueue,
  requireNetwork,
  tailor,
  loadSettings,
  type Account,
} from "@profullstack/myna-core";
import {
  byNetwork,
  listEngagement,
  postsPerDay,
  postsPerHour,
  topPosts,
  totals,
} from "@profullstack/myna-core";
import { selectedAccounts, type State } from "../state.ts";
import { COMMANDS, networkRows } from "../commands.ts";
import { describeWhen } from "../when.ts";

const ago = (iso: string): string => {
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return "";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const oneLine = (text: string, width = 60): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
};

/**
 * Compose: the post on the left, and on the right what each target will
 * actually receive — truncated, split into a thread, or over the limit.
 */
export function composeScreen(ui: Container, state: State, theme: Theme): void {
  ui.row({ size: "1fr", gap: 1 }, (row) => {
    row.panel({ title: state.mode === "compose" ? "Compose — editing" : "Compose", size: "2fr" }, (panel) => {
      if (state.title.value) {
        panel.keyValues([{ label: "Title", value: state.title.value, color: theme.accent }]);
        panel.spacer(1);
      }

      const text = state.compose.value;
      if (!text) {
        panel.label("Type here, or use a command:", { size: 1 });
        panel.spacer(1);
        panel.label("  /draft a release note for myna 0.1", { size: 1 });
        panel.label("  /link https://example.com/blog/post", { size: 1 });
        panel.label("  /infographic https://example.com/report", { size: 1 });
        panel.spacer(1);
        panel.label("  Enter edits the box. Ctrl+S posts.", { size: 1 });
      } else {
        const { line } = state.compose.position();
        const lines = state.compose.lines;
        // Keep the caret line on screen in a long draft.
        const visible = Math.max(1, (panel.height ?? 20) - 6);
        const start = Math.max(0, Math.min(line - Math.floor(visible / 2), lines.length - visible));
        lines.slice(start, start + visible).forEach((content, index) => {
          const isCaret = start + index === line && state.mode === "compose";
          panel.text(content || " ", {
            size: 1,
            fg: isCaret ? theme.foreground : theme.muted,
            bg: isCaret ? theme.selection : undefined,
          });
        });
      }

      panel.spacer("fill");
      if (state.draftSource) panel.label(state.draftSource, { size: 1, fg: theme.accent });
      if (state.media.length) {
        panel.label(`${state.media.length} attachment${state.media.length === 1 ? "" : "s"}: ${state.media.map((path) => path.split("/").pop()).join(", ")}`, {
          size: 1,
          fg: theme.success,
        });
      }
    });

    row.panel({ title: "Goes to", size: "1fr" }, (panel) => {
      const accounts = selectedAccounts(state);
      if (!accounts.length) {
        panel.label("No accounts connected.", { size: 1 });
        panel.spacer(1);
        panel.label("/login bluesky", { size: 1, fg: theme.accent });
        panel.label("/login mastodon", { size: 1, fg: theme.accent });
        panel.label("/networks to see all 25", { size: 1 });
        return;
      }

      const text = state.compose.value;
      const settings = loadSettings();
      for (const account of accounts.slice(0, 14)) {
        const network = requireNetwork(account.network);
        const parts = text ? tailor(account.network, { text, thread: settings.threadByDefault }) : [];
        const used = text ? charsFor(account.network, parts[0] ?? "") : 0;
        const limit = network.caps.charLimit;

        const detail = !text
          ? limit
            ? `${limit} max`
            : "no limit"
          : parts.length > 1
            ? `thread of ${parts.length}`
            : limit
              ? `${used}/${limit}`
              : `${used}`;

        const overLimit = Boolean(limit) && used > limit;
        panel.keyValues([
          {
            label: oneLine(account.id, 22),
            value: detail,
            color: overLimit ? theme.danger : parts.length > 1 ? theme.warning : theme.success,
          },
        ]);
      }
      if (accounts.length > 14) panel.label(`…and ${accounts.length - 14} more`, { size: 1 });
    });
  });
}

export function accountsScreen(ui: Container, state: State, theme: Theme): void {
  ui.panel({ title: `Accounts (${state.accounts.length})`, size: "1fr" }, (panel) => {
    if (!state.accounts.length) {
      panel.label("Nothing connected yet.", { size: 1 });
      panel.spacer(1);
      panel.label("/login <network> connects one. myna asks for whatever that", { size: 1 });
      panel.label("network actually accepts — a password where one works, an", { size: 1 });
      panel.label("app token where it does not, a browser sign-in for the rest.", { size: 1 });
      return;
    }

    panel.table({
      rows: state.accounts.map((account: Account) => ({
        target: state.targets.size === 0 || state.targets.has(account.id) ? "●" : " ",
        id: account.id,
        name: account.displayName ?? "",
        network: requireNetwork(account.network).name,
        added: ago(account.addedAt),
      })),
      columns: [
        { key: "target", title: "", width: 2 },
        { key: "id", title: "Account" },
        { key: "name", title: "Name", width: 22 },
        { key: "network", title: "Network", width: 14 },
        { key: "added", title: "Added", width: 10, align: "right" },
      ],
    });
    panel.spacer(1);
    panel.label("● marks a post target. /targets to change, /logout <id> to disconnect.", { size: 1, fg: theme.muted });
  });
}

export function queueScreen(ui: Container, state: State, theme: Theme): void {
  const posts = listQueue();
  ui.panel({ title: `Queue (${posts.filter((post) => post.status === "pending").length} pending)`, size: "1fr" }, (panel) => {
    if (!posts.length) {
      panel.label("Nothing scheduled.", { size: 1 });
      panel.spacer(1);
      panel.label("/schedule tomorrow 9am", { size: 1, fg: theme.accent });
      panel.label("/schedule in 2h Release notes are up", { size: 1, fg: theme.accent });
      return;
    }
    panel.table({
      rows: posts.map((post) => ({
        id: post.id,
        when: post.status === "pending" ? describeWhen(new Date(post.scheduledFor)) : new Date(post.scheduledFor).toLocaleString(),
        status: post.status,
        to: post.targets.length === 1 ? post.targets[0] : `${post.targets.length} accounts`,
        text: oneLine(post.text, 44),
      })),
      columns: [
        { key: "id", title: "Id", width: 9 },
        { key: "when", title: "When", width: 24 },
        { key: "status", title: "Status", width: 9 },
        { key: "to", title: "To", width: 20 },
        { key: "text", title: "Post" },
      ],
    });
    panel.spacer(1);
    panel.label("/cancel <id> removes one. The scheduler runs while myna is open.", { size: 1, fg: theme.muted });
  });
}

export function historyScreen(ui: Container, state: State, theme: Theme): void {
  const entries = listHistory().slice(0, 200);
  ui.panel({ title: `History (${entries.length})`, size: "1fr" }, (panel) => {
    if (!entries.length) {
      panel.label("Nothing posted yet.", { size: 1 });
      return;
    }
    panel.table({
      rows: entries.map((entry) => ({
        ok: entry.ok ? "ok" : "fail",
        when: ago(entry.at),
        account: entry.accountId,
        text: oneLine(entry.error ? entry.error : entry.text, 52),
      })),
      columns: [
        { key: "ok", title: "", width: 5 },
        { key: "when", title: "When", width: 10 },
        { key: "account", title: "Account", width: 26 },
        { key: "text", title: "Post or error" },
      ],
    });
    panel.spacer(1);
    const failed = entries.filter((entry) => !entry.ok).length;
    panel.label(
      failed ? `${failed} failed — the error is shown in place of the post text.` : "Every post landed.",
      { size: 1, fg: failed ? theme.danger : theme.success },
    );
  });
}

export function feedScreen(ui: Container, state: State, theme: Theme): void {
  ui.panel({ title: state.feedSource ? `Feed — ${state.feedSource}` : "Feed", size: "1fr" }, (panel) => {
    if (!state.feed.length) {
      panel.label("Nothing loaded.", { size: 1 });
      panel.spacer(1);
      panel.label("/feed bluesky", { size: 1, fg: theme.accent });
      panel.label("/notifications mastodon", { size: 1, fg: theme.accent });
      return;
    }
    for (const item of state.feed.slice(0, 40)) {
      panel.keyValues([{ label: oneLine(item.handle || item.author, 24), value: ago(item.createdAt), color: theme.accent }]);
      for (const line of oneLine(item.text, 200).match(/.{1,110}(\s|$)/g)?.slice(0, 3) ?? []) {
        panel.text(line.trim(), { size: 1, fg: theme.foreground });
      }
      const stats = [
        item.likes !== undefined && `${item.likes} likes`,
        item.reposts !== undefined && `${item.reposts} reposts`,
        item.replies !== undefined && `${item.replies} replies`,
      ].filter(Boolean);
      if (stats.length) panel.label(stats.join("  "), { size: 1 });
      panel.spacer(1);
    }
  });
}

export function networksScreen(ui: Container, state: State, theme: Theme): void {
  const rows = networkRows();
  ui.panel({ title: `Networks (${rows.length})`, size: "1fr" }, (panel) => {
    panel.table({
      rows,
      columns: [
        { key: "id", title: "Command", width: 13 },
        { key: "name", title: "Network", width: 14 },
        { key: "auth", title: "Login", width: 20 },
        { key: "limit", title: "Chars", width: 7, align: "right" },
        { key: "blurb", title: "Notes" },
      ],
    });
    panel.spacer(1);
    panel.label("/login <command> connects one. 'username + password' means a real password works.", {
      size: 1,
      fg: theme.muted,
    });
  });
}

export function helpScreen(ui: Container, state: State, theme: Theme): void {
  ui.row({ size: "1fr", gap: 1 }, (row) => {
    row.panel({ title: "Commands", size: "2fr" }, (panel) => {
      for (const command of COMMANDS) {
        panel.keyValues([
          {
            label: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
            value: command.help,
            color: theme.accent,
          },
        ]);
      }
    });
    row.panel({ title: "Keys", size: "1fr" }, (panel) => {
      panel.keyValues([
        { label: "/", value: "command bar" },
        { label: "Enter", value: "edit the post" },
        { label: "Ctrl+S", value: "post now" },
        { label: "Esc", value: "back to the command bar" },
        { label: "Tab", value: "next tab, or complete a half-typed command" },
        { label: "Shift+Tab", value: "previous tab" },
        { label: "↑ ↓", value: "command history" },
        { label: "1-8", value: "switch screen" },
        { label: "Ctrl+C", value: "quit" },
      ]);
      panel.spacer(1);
      panel.divider({ label: "where things live" });
      panel.label("Credentials are encrypted in", { size: 1 });
      panel.label("~/.config/myna/vault.json", { size: 1, fg: theme.accent });
      panel.spacer(1);
      panel.label("Nothing leaves this machine except", { size: 1 });
      panel.label("the posts you send.", { size: 1 });
    });
  });
}


/**
 * Performance.
 *
 * Volume, success rate and timing come from the local history and are always
 * there. Engagement needs an API call per post, so it comes from the cache that
 * `/stats` fills, and the screen says so rather than showing zeros as if they
 * were measurements.
 */
export function performanceScreen(ui: Container, state: State, theme: Theme): void {
  const history = listHistory();
  const engagement = listEngagement();
  const summary = totals(history, engagement);

  if (!history.length) {
    ui.panel({ title: "Performance", size: "1fr" }, (panel) => {
      panel.label("Nothing posted yet, so there is nothing to measure.", { size: 1 });
      panel.spacer(1);
      panel.label("Post something, then come back. /stats fetches engagement", { size: 1 });
      panel.label("from the networks that report it.", { size: 1 });
    });
    return;
  }

  ui.column({ size: "1fr", gap: 1 }, (root) => {
    // Headline numbers.
    root.row({ size: 5, gap: 1 }, (row) => {
      row.panel({ title: "Posts" }, (panel) => {
        panel.keyValues([
          { label: "sent", value: String(summary.sent), color: theme.success },
          { label: "failed", value: String(summary.failed), color: summary.failed ? theme.danger : theme.muted },
          { label: "networks", value: String(summary.networks) },
        ]);
      });
      row.panel({ title: "Delivered" }, (panel) => {
        panel.gauge({
          value: summary.rate ?? 0,
          label: summary.rate === null ? "-" : `${Math.round(summary.rate * 100)}%`,
          color: (summary.rate ?? 1) > 0.95 ? theme.success : theme.warning,
        });
      });
      row.panel({ title: "Engagement" }, (panel) => {
        if (!summary.measured) {
          panel.label("not measured yet", { size: 1, fg: theme.muted });
          panel.label("/stats to fetch", { size: 1, fg: theme.accent });
          return;
        }
        panel.keyValues([
          { label: "likes", value: String(summary.likes), color: theme.accent },
          { label: "reposts", value: String(summary.reposts), color: theme.primary },
          { label: "replies", value: String(summary.replies) },
        ]);
      });
      row.panel({ title: "Per post" }, (panel) => {
        panel.text(summary.perPost === null ? "-" : summary.perPost.toFixed(1), { size: 1, fg: theme.accent });
        panel.label(summary.measured ? `over ${summary.measured} measured` : "nothing measured", { size: 1 });
      });
    });

    // Volume over the last month.
    root.panel({ title: "Posts per day, last 30 days", size: 10 }, (panel) => {
      const days = postsPerDay(history, 30);
      // A histogram, not an area graph: these are 30 discrete daily counts, and
      // interpolating between them draws values on days that never happened.
      panel.histogram({ values: days.map((day) => day.sent), color: theme.success });
      const failed = days.reduce((sum, day) => sum + day.failed, 0);
      panel.label(
        failed
          ? `${days.reduce((sum, day) => sum + day.sent, 0)} sent, ${failed} failed in this window`
          : `${days.reduce((sum, day) => sum + day.sent, 0)} sent, none failed`,
        { size: 1, fg: failed ? theme.danger : theme.muted },
      );
    });

    root.row({ size: "1fr", gap: 1 }, (row) => {
      // Where it went, and how it did.
      row.panel({ title: "By network", size: "3fr" }, (panel) => {
        const rows = byNetwork(history, engagement);
        panel.table({
          rows: rows.map((entry) => ({
            network: entry.network,
            sent: String(entry.sent),
            failed: entry.failed ? String(entry.failed) : "",
            rate: entry.rate === null ? "-" : `${Math.round(entry.rate * 100)}%`,
            likes: entry.likes || "",
            reposts: entry.reposts || "",
            replies: entry.replies || "",
          })),
          columns: [
            { key: "network", title: "Network", width: 14 },
            { key: "sent", title: "Sent", width: 6, align: "right" },
            { key: "failed", title: "Failed", width: 7, align: "right" },
            { key: "rate", title: "Rate", width: 6, align: "right" },
            { key: "likes", title: "Likes", width: 7, align: "right" },
            { key: "reposts", title: "Reposts", width: 8, align: "right" },
            { key: "replies", title: "Replies", width: 8, align: "right" },
          ],
        });
      });

      // When you post, by hour.
      row.panel({ title: "By hour", size: "2fr" }, (panel) => {
        const hours = postsPerHour(history);
        panel.histogram({ values: hours, color: theme.primary });
        const busiest = hours.indexOf(Math.max(...hours));
        panel.label(
          Math.max(...hours) > 0 ? `busiest at ${String(busiest).padStart(2, "0")}:00` : "no successful posts yet",
          { size: 1, fg: theme.muted },
        );
      });
    });

    // What actually landed.
    root.panel({ title: "Best posts", size: 10 }, (panel) => {
      const best = topPosts(history, engagement, 6);
      if (!best.length) {
        panel.label("No engagement measured yet. /stats fetches it for recent posts", { size: 1 });
        panel.label("from the networks that report it: X, Bluesky, Mastodon, Reddit,", { size: 1 });
        panel.label("Facebook, Instagram, Threads, Misskey, Lemmy and dev.to.", { size: 1 });
        return;
      }
      panel.table({
        rows: best.map((post) => ({
          total: String(post.total),
          account: post.accountId.length > 22 ? `${post.accountId.slice(0, 21)}\u2026` : post.accountId,
          likes: String(post.likes),
          reposts: String(post.reposts),
          text: post.text.replace(/\s+/g, " ").slice(0, 52),
        })),
        columns: [
          { key: "total", title: "Total", width: 6, align: "right" },
          { key: "likes", title: "Likes", width: 6, align: "right" },
          { key: "reposts", title: "Rep", width: 5, align: "right" },
          { key: "account", title: "Account", width: 23 },
          { key: "text", title: "Post" },
        ],
      });
    });
  });
}
