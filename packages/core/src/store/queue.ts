/** Scheduled posts. Not secret, so this is a plain JSON file. */
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../util/json.ts";
import { QUEUE_FILE } from "../util/paths.ts";

export interface QueuedTargetResult {
  ok: boolean;
  id?: string;
  url?: string;
  error?: string;
}

export interface QueuedPost {
  id: string;
  createdAt: string;
  /** ISO timestamp. A post due in the past is sent on the next tick. */
  scheduledFor: string;
  targets: string[];
  text: string;
  title?: string;
  mediaPaths?: string[];
  /**
   * Share an existing post instead of writing one.
   *
   * A URL or id on the target's own network. When this is set the entry
   * carries no text of its own, so `text` is only what the queue prints —
   * the send calls the network's repost API and nothing is composed.
   */
  repostOf?: string;
  extra?: Record<string, string>;
  /** Split over the character limit into a reply chain where supported. */
  thread?: boolean;
  /** The post type (skills/types/<type>/skill.md), which the send checks against the target's kind. */
  type?: string;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  results?: Record<string, QueuedTargetResult>;
  attempts?: number;
  lastError?: string;
}

interface QueueFile {
  posts: QueuedPost[];
}

const read = (): QueueFile => readJson<QueueFile>(QUEUE_FILE, { posts: [] });
const write = (file: QueueFile): void => writeJson(QUEUE_FILE, file);

export function listQueue(): QueuedPost[] {
  return read().posts.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

export function enqueue(post: Omit<QueuedPost, "id" | "createdAt" | "status">): QueuedPost {
  const file = read();
  const entry: QueuedPost = { ...post, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), status: "pending" };
  file.posts.push(entry);
  write(file);
  return entry;
}

export function updateQueued(id: string, patch: Partial<QueuedPost>): QueuedPost | undefined {
  const file = read();
  const post = file.posts.find((entry) => entry.id === id);
  if (!post) return undefined;
  Object.assign(post, patch);
  write(file);
  return post;
}

export function removeQueued(id: string): boolean {
  const file = read();
  const before = file.posts.length;
  file.posts = file.posts.filter((post) => post.id !== id);
  if (file.posts.length === before) return false;
  write(file);
  return true;
}

/** Everything pending and due, oldest first. */
export function duePosts(now = new Date()): QueuedPost[] {
  return listQueue().filter((post) => post.status === "pending" && new Date(post.scheduledFor) <= now);
}
