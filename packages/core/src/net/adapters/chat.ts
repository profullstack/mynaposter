/**
 * Chat platforms: Telegram, Discord, Slack, Matrix, Mattermost.
 *
 * These are not social networks, but posting an announcement to a channel is
 * the same job, and a release note usually wants to land in all of them.
 */
import type { Network, TimelineItem } from "../types.ts";
import { getJson, normalizeInstance, postJson, request } from "../../util/http.ts";

export const telegram: Network = {
  id: "telegram",
  name: "Telegram",
  category: "chat",
  blurb: "Bot posting to a channel or chat. Create the bot with @BotFather.",
  auth: {
    kind: "token",
    note: "Message @BotFather to create a bot and copy its token. Add the bot to your channel as an admin, then use @channelname or the numeric chat id.",
    fields: [
      { key: "token", label: "Bot token", secret: true, placeholder: "123456:ABC-DEF…" },
      { key: "chatId", label: "Chat or channel", placeholder: "@mychannel" },
    ],
  },
  caps: { charLimit: 4096, mediaLimit: 10, threads: false, delete: true, timeline: false, notifications: false, stats: false },

  async login(input) {
    const me = await getJson<{ result: { username: string; first_name: string } }>(
      `https://api.telegram.org/bot${input.token}/getMe`,
    );
    return {
      handle: `@${me.result.username} → ${input.chatId}`,
      displayName: me.result.first_name,
      creds: { token: input.token },
      meta: { chatId: input.chatId },
    };
  },

  async post(account, input) {
    const chatId = input.extra?.chatId || account.meta.chatId;
    if (input.media?.length) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", input.text.slice(0, 1024));
      const item = input.media[0];
      form.append("photo", new Blob([item.data as unknown as ArrayBuffer], { type: item.mime }), item.path.split("/").pop() ?? "image");
      const response = await request(`https://api.telegram.org/bot${account.creds.token}/sendPhoto`, {
        method: "POST",
        body: form as never,
      });
      const sent = (await response.json()) as { result: { message_id: number } };
      return { id: String(sent.result.message_id) };
    }
    const sent = await postJson<{ result: { message_id: number } }>(
      `https://api.telegram.org/bot${account.creds.token}/sendMessage`,
      { chat_id: chatId, text: input.text, disable_web_page_preview: false },
    );
    return { id: String(sent.result.message_id) };
  },

  async remove(account, id) {
    await postJson(`https://api.telegram.org/bot${account.creds.token}/deleteMessage`, {
      chat_id: account.meta.chatId,
      message_id: Number(id),
    });
  },
};

export const discord: Network = {
  id: "discord",
  name: "Discord",
  category: "chat",
  blurb: "Posts through a channel webhook. No bot or scopes needed.",
  auth: {
    kind: "token",
    note: "Channel → Edit Channel → Integrations → Webhooks → New Webhook, then copy the URL.",
    fields: [
      { key: "webhook", label: "Webhook URL", secret: true, placeholder: "https://discord.com/api/webhooks/…" },
      { key: "name", label: "Post as", optional: true, placeholder: "myna" },
    ],
  },
  caps: { charLimit: 2000, mediaLimit: 10, threads: false, delete: true, timeline: false, notifications: false, stats: false },

  async login(input) {
    const hook = await getJson<{ id: string; name: string; channel_id: string; guild_id?: string }>(input.webhook);
    return {
      handle: `${hook.name}#${hook.channel_id}`,
      displayName: hook.name,
      creds: { webhook: input.webhook },
      meta: { channelId: hook.channel_id, name: input.name ?? "" },
    };
  },

  async post(account, input) {
    // ?wait=true makes Discord return the created message instead of a 204.
    const url = `${account.creds.webhook}?wait=true`;
    if (input.media?.length) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ content: input.text, username: account.meta.name || undefined }));
      input.media.slice(0, 10).forEach((item, index) => {
        form.append(`files[${index}]`, new Blob([item.data as unknown as ArrayBuffer], { type: item.mime }), item.path.split("/").pop() ?? `file${index}`);
      });
      const response = await request(url, { method: "POST", body: form as never });
      const sent = (await response.json()) as { id: string };
      return { id: sent.id };
    }
    const sent = await postJson<{ id: string }>(url, {
      content: input.text,
      username: account.meta.name || undefined,
    });
    return { id: sent.id };
  },

  async remove(account, id) {
    await request(`${account.creds.webhook}/messages/${id}`, { method: "DELETE" });
  },
};

export const slack: Network = {
  id: "slack",
  name: "Slack",
  category: "chat",
  blurb: "Bot token posting to a channel.",
  auth: {
    kind: "token",
    note: "Create an app at api.slack.com/apps, add the chat:write scope, install it to the workspace and copy the Bot User OAuth Token (xoxb-…).",
    fields: [
      { key: "token", label: "Bot token", secret: true, placeholder: "xoxb-…" },
      { key: "channel", label: "Channel", placeholder: "#general" },
    ],
  },
  caps: { charLimit: 40000, mediaLimit: 0, threads: true, delete: true, timeline: false, notifications: false, stats: false },

  async login(input) {
    const me = await getJson<{ ok: boolean; team: string; user: string; error?: string }>("https://slack.com/api/auth.test", {
      headers: { authorization: `Bearer ${input.token}` },
    });
    if (!me.ok) throw new Error(`Slack rejected the token: ${me.error ?? "unknown error"}`);
    return {
      handle: `${me.team}/${input.channel}`,
      displayName: me.user,
      creds: { token: input.token },
      meta: { channel: input.channel },
    };
  },

  async post(account, input) {
    // Slack answers 200 with ok:false, so the body decides success, not the status.
    const sent = await postJson<{ ok: boolean; ts: string; error?: string }>(
      "https://slack.com/api/chat.postMessage",
      {
        channel: input.extra?.channel || account.meta.channel,
        text: input.text,
        ...(input.replyTo ? { thread_ts: input.replyTo } : {}),
      },
      { headers: { authorization: `Bearer ${account.creds.token}` } },
    );
    if (!sent.ok) throw new Error(`Slack refused the message: ${sent.error ?? "unknown error"}`);
    return { id: sent.ts };
  },

  async remove(account, id) {
    await postJson(
      "https://slack.com/api/chat.delete",
      { channel: account.meta.channel, ts: id },
      { headers: { authorization: `Bearer ${account.creds.token}` } },
    );
  },
};

export const matrix: Network = {
  id: "matrix",
  name: "Matrix",
  category: "chat",
  blurb: "Real password login against any homeserver. Posts to a room.",
  auth: {
    kind: "password",
    note: "Your normal Matrix account. The room can be an alias (#room:server) or an internal id (!abc:server).",
    fields: [
      { key: "homeserver", label: "Homeserver", placeholder: "matrix.org" },
      { key: "username", label: "Username", placeholder: "alice" },
      { key: "password", label: "Password", secret: true },
      { key: "room", label: "Room", placeholder: "#myroom:matrix.org" },
    ],
  },
  // Reading a room means /sync and pagination tokens, which myna does not do
  // yet, so it does not advertise a timeline it cannot show.
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: true, timeline: false, notifications: false, stats: false },

  async login(input) {
    const homeserver = normalizeInstance(input.homeserver);
    const session = await postJson<{ access_token: string; user_id: string }>(`${homeserver}/_matrix/client/v3/login`, {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: input.username },
      password: input.password,
      initial_device_display_name: "myna",
    });
    return {
      handle: session.user_id,
      displayName: input.username,
      creds: { token: session.access_token },
      meta: { homeserver, room: input.room },
    };
  },

  async post(account, input) {
    const room = input.extra?.room || account.meta.room;
    const roomId = room.startsWith("!") ? room : await resolveAlias(account.meta.homeserver, room, account.creds.token);
    const txn = `myna-${Date.now()}`;
    const sent = await request(
      `${account.meta.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${account.creds.token}`, "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "m.text", body: input.text }),
      },
    );
    const result = (await sent.json()) as { event_id: string };
    return { id: `${roomId}|${result.event_id}` };
  },

  async remove(account, id) {
    const [roomId, eventId] = id.split("|");
    await request(
      `${account.meta.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${eventId}/myna-${Date.now()}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${account.creds.token}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "deleted via myna" }),
      },
    );
  },
};

async function resolveAlias(homeserver: string, alias: string, token: string): Promise<string> {
  const result = await getJson<{ room_id: string }>(
    `${homeserver}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return result.room_id;
}

export const mattermost: Network = {
  id: "mattermost",
  name: "Mattermost",
  category: "chat",
  blurb: "Self-hosted team chat. Password or personal access token.",
  auth: {
    kind: "password",
    fields: [
      { key: "server", label: "Server URL", placeholder: "https://chat.example.com" },
      { key: "username", label: "Username or email", optional: true },
      { key: "password", label: "Password", secret: true, optional: true },
      { key: "token", label: "Access token", secret: true, optional: true, help: "Use instead of a password." },
      { key: "channelId", label: "Channel id", help: "View Info on a channel shows its id." },
    ],
  },
  caps: { charLimit: 16383, mediaLimit: 0, threads: true, delete: true, timeline: false, notifications: false, stats: false },

  async login(input) {
    const server = normalizeInstance(input.server);
    let token = input.token?.trim();
    let displayName = input.username ?? "";

    if (!token) {
      if (!input.username || !input.password) throw new Error("Enter a username and password, or paste an access token.");
      const response = await request(`${server}/api/v4/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login_id: input.username, password: input.password }),
      });
      // Mattermost returns the session token in a header, not the body.
      token = response.headers.get("token") ?? "";
      if (!token) throw new Error("Mattermost logged in but returned no session token.");
      displayName = ((await response.json()) as { username: string }).username;
    }

    const me = await getJson<{ username: string; id: string }>(`${server}/api/v4/users/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return {
      handle: `${me.username}@${new URL(server).host}`,
      displayName: displayName || me.username,
      creds: { token },
      meta: { server, channelId: input.channelId },
    };
  },

  async post(account, input) {
    const sent = await postJson<{ id: string }>(
      `${account.meta.server}/api/v4/posts`,
      {
        channel_id: input.extra?.channelId || account.meta.channelId,
        message: input.text,
        ...(input.replyTo ? { root_id: input.replyTo } : {}),
      },
      { headers: { authorization: `Bearer ${account.creds.token}` } },
    );
    return { id: sent.id };
  },

  async remove(account, id) {
    await request(`${account.meta.server}/api/v4/posts/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${account.creds.token}` },
    });
  },
};
