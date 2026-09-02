/** Misskey, Sharkey, Firefish and Calckey. Token auth; every call is a POST. */
import type { Network, TimelineItem } from "../types.ts";
import { normalizeInstance, postJson } from "../../util/http.ts";

interface Note {
  id: string;
  text: string | null;
  createdAt: string;
  user: { username: string; name: string | null; host: string | null };
  renoteCount?: number;
  repliesCount?: number;
}

export const misskey: Network = {
  id: "misskey",
  name: "Misskey",
  category: "fediverse",
  blurb: "Misskey, Sharkey, Firefish. Token auth from Settings → API.",
  auth: {
    kind: "token",
    note: "Settings → API → Generate access token. Tick 'Compose or delete notes' and 'View your account information'.",
    fields: [
      { key: "instance", label: "Instance", placeholder: "misskey.io" },
      { key: "token", label: "Access token", secret: true },
    ],
  },
  caps: { charLimit: 3000, mediaLimit: 16, threads: true, delete: true, timeline: true, notifications: true, stats: true },

  async login(input) {
    const instance = normalizeInstance(input.instance);
    const me = await postJson<{ id: string; username: string; name: string | null }>(`${instance}/api/i`, { i: input.token });
    return {
      handle: `@${me.username}@${new URL(instance).host}`,
      displayName: me.name || me.username,
      creds: { token: input.token },
      meta: { instance, accountId: me.id },
    };
  },

  async post(account, input) {
    const body: Record<string, unknown> = { i: account.creds.token, text: input.text };
    if (input.replyTo) body.replyId = input.replyTo;
    if (input.extra?.visibility) body.visibility = input.extra.visibility;
    const created = await postJson<{ createdNote: Note }>(`${account.meta.instance}/api/notes/create`, body);
    return {
      id: created.createdNote.id,
      url: `${account.meta.instance}/notes/${created.createdNote.id}`,
    };
  },

  async remove(account, id) {
    await postJson(`${account.meta.instance}/api/notes/delete`, { i: account.creds.token, noteId: id });
  },

  async timeline(account, limit) {
    const notes = await postJson<Note[]>(`${account.meta.instance}/api/notes/timeline`, { i: account.creds.token, limit });
    return notes.map((note): TimelineItem => ({
      id: note.id,
      author: note.user.name || note.user.username,
      handle: `@${note.user.username}${note.user.host ? `@${note.user.host}` : ""}`,
      text: note.text ?? "",
      createdAt: note.createdAt,
      url: `${account.meta.instance}/notes/${note.id}`,
      reposts: note.renoteCount,
      replies: note.repliesCount,
    }));
  },

  async notifications(account, limit) {
    const items = await postJson<Record<string, any>[]>(`${account.meta.instance}/api/i/notifications`, {
      i: account.creds.token,
      limit,
    });
    return items.map((item): TimelineItem => ({
      id: item.id,
      author: item.user?.name || item.user?.username || "",
      handle: `@${item.user?.username ?? ""}`,
      text: `${item.type}${item.note?.text ? `: ${item.note.text}` : ""}`,
      createdAt: item.createdAt,
    }));
  },

  async stats(account, id) {
    const note = await postJson<Note & { reactionCount?: number }>(`${account.meta.instance}/api/notes/show`, {
      i: account.creds.token,
      noteId: id,
    });
    return { likes: note.reactionCount, reposts: note.renoteCount, replies: note.repliesCount };
  },
};
