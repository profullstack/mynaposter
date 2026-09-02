/** Reading attachments off disk, with the MIME sniffing the APIs demand. */
import { readFileSync, statSync } from "node:fs";
import { extname, basename } from "node:path";
import type { MediaItem } from "../net/types.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

const MAX_BYTES = 100 * 1024 * 1024;

export function loadMedia(path: string, alt?: string): MediaItem {
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`${path} is not a file`);
  if (stats.size > MAX_BYTES) throw new Error(`${basename(path)} is ${(stats.size / 1e6).toFixed(1)} MB — over the 100 MB cap.`);

  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Cannot tell what ${basename(path)} is. Supported: ${Object.keys(MIME).join(", ")}`);

  return { path, mime, data: new Uint8Array(readFileSync(path)), alt };
}

export function loadAllMedia(paths: string[], alts: string[] = []): MediaItem[] {
  return paths.map((path, index) => loadMedia(path, alts[index]));
}
