/**
 * Updating myna in place.
 *
 * A release is a standalone binary, so updating is: work out which asset this
 * machine wants, download it, check it against the published SHA256SUMS, and
 * rename it over the running one. That is exactly what `install.sh` does, and
 * the two must agree about asset names or an update installs something that
 * cannot run — hence the same baseline check for CPUs without AVX2.
 *
 * The rename is the careful part. Writing into the running binary truncates
 * the file the kernel is executing; staging beside it and renaming swaps the
 * directory entry instead, which is atomic and leaves the running process on
 * the old inode until it exits.
 */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getJson, request } from "../util/http.ts";
import { VERSION } from "../version.ts";

const REPO = "profullstack/mynaposter";

export interface UpdateCheck {
  current: string;
  latest: string;
  /** Semver-newer, not merely different: a downgrade is not an update. */
  newer: boolean;
  url: string;
  notes?: string;
}

export interface UpdateResult extends UpdateCheck {
  /** False when the check ran but nothing was installed. */
  installed: boolean;
  path?: string;
  asset?: string;
  /** Why nothing was installed, when nothing was. */
  reason?: string;
}

/** Numeric compare, so 0.10.0 is newer than 0.9.0 and "v" prefixes do not matter. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (value: string) =>
    value.replace(/^v/, "").split(/[.-]/).map((piece) => Number.parseInt(piece, 10));
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = Number.isFinite(a[i]) ? a[i] : 0;
    const right = Number.isFinite(b[i]) ? b[i] : 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * The release asset this machine can run.
 *
 * `hasAvx2` is passed in rather than read here so the choice is testable: Bun's
 * default x86_64 build uses AVX2 and an older CPU dies on an illegal
 * instruction rather than with a message, which is not something to discover
 * after overwriting a working binary.
 */
export function assetFor(platform: string, arch: string, hasAvx2 = true): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  let cpu: string;
  if (arch === "x64") cpu = "x86_64";
  else if (arch === "arm64") cpu = os === "darwin" ? "arm64" : "aarch64";
  else throw new Error(`No myna build for ${arch}. See https://github.com/${REPO}/releases`);

  if (os === "windows") {
    if (cpu !== "x86_64") throw new Error(`No Windows build for ${arch}.`);
    return "myna-windows-x86_64.exe";
  }
  const base = `myna-${os}-${cpu}`;
  return os === "linux" && cpu === "x86_64" && !hasAvx2 ? `${base}-baseline` : base;
}

/** Whether this x86_64 CPU has AVX2. Anything we cannot read is assumed modern. */
export function cpuHasAvx2(readCpuinfo: () => string = defaultCpuinfo): boolean {
  if (process.platform !== "linux" || process.arch !== "x64") return true;
  try {
    return /\bavx2\b/.test(readCpuinfo());
  } catch {
    return true;
  }
}

function defaultCpuinfo(): string {
  return readFileSync("/proc/cpuinfo", "utf8");
}

interface Release {
  tag_name?: string;
  html_url?: string;
  body?: string;
}

/** What the newest release is, and whether it beats what is running. */
export async function checkForUpdate(current = VERSION): Promise<UpdateCheck> {
  const release = await getJson<Release>(`https://api.github.com/repos/${REPO}/releases/latest`);
  const latest = (release.tag_name ?? "").replace(/^v/, "");
  if (!latest) throw new Error("GitHub did not name a latest release.");
  return {
    current,
    latest,
    newer: isNewer(latest, current),
    url: release.html_url ?? `https://github.com/${REPO}/releases/tag/v${latest}`,
    notes: release.body?.trim() || undefined,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface UpdateOptions {
  /** Install this version instead of the newest. Accepts "0.14.0" or "v0.14.0". */
  version?: string;
  /** Install even when the running version is the same or newer. */
  force?: boolean;
  /** Progress, one line at a time. */
  report?: (line: string) => void;
  /** Overridable so a test does not overwrite the binary running it. */
  target?: string;
}

/**
 * Replace the running binary with a release build.
 *
 * Returns rather than throws for the ordinary "nothing to do" cases, because
 * `myna update` on an up-to-date machine is a success, not an error.
 */
export async function selfUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const report = options.report ?? (() => {});
  const target = options.target ?? process.execPath;

  // Running from source, the binary is Bun itself, and overwriting that would
  // be an extremely rude way to update a social media tool.
  if (!options.target && /(^|[\\/])bun(\.exe)?$/.test(target)) {
    const check = await checkForUpdate();
    return {
      ...check,
      installed: false,
      reason:
        `myna ${check.latest} is the newest release; this one is running under Bun rather than as an ` +
        "installed binary, so there is nothing here to replace. Update it the way it was installed: " +
        "`git pull` in a checkout, `bun add -g @profullstack/myna` for a global install, or " +
        "`curl -fsSL https://mynaposter.com/install.sh | sh` for a standalone binary.",
    };
  }

  const check = await checkForUpdate();
  const wanted = (options.version ?? check.latest).replace(/^v/, "");
  if (!options.force && !options.version && !check.newer) {
    return { ...check, installed: false, reason: `Already on ${check.current}.` };
  }

  const asset = assetFor(process.platform, process.arch, cpuHasAvx2());
  const base = `https://github.com/${REPO}/releases/download/v${wanted}`;

  report(`Downloading ${asset} ${wanted}…`);
  const response = await request(`${base}/${asset}`);
  const binary = new Uint8Array(await response.arrayBuffer());
  if (binary.byteLength < 1024) throw new Error(`The download from ${base}/${asset} was empty.`);

  // A checksum that cannot be fetched is a reason to stop, not to shrug: this
  // writes an executable that then runs unattended from a daemon.
  report("Verifying the checksum…");
  const sums = await request(`${base}/SHA256SUMS`).then((res) => res.text());
  const line = sums.split("\n").find((entry) => entry.trim().endsWith(` ${asset}`) || entry.trim().endsWith(`*${asset}`));
  const expected = line?.trim().split(/\s+/)[0];
  if (!expected) throw new Error(`No checksum published for ${asset} in ${wanted}. Refusing to install.`);
  const actual = await sha256(binary);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Refusing to install.`);
  }

  if (!existsSync(target)) throw new Error(`Cannot find the running binary at ${target}.`);
  const directory = dirname(target);

  // Stage in the destination directory, not in /tmp: a rename across
  // filesystems is not atomic, and on this box /tmp is very often another one.
  const staged = join(directory, `.myna-update-${process.pid}`);
  try {
    writeFileSync(staged, binary, { mode: 0o755 });
    chmodSync(staged, 0o755);
  } catch (error) {
    rmSync(staged, { force: true });
    throw new Error(
      `Cannot write to ${directory}: ${(error as Error).message}. ` +
        `Install somewhere writable with: MYNA_BIN=~/.local/bin curl -fsSL https://mynaposter.com/install.sh | sh`,
    );
  }

  try {
    renameSync(staged, target);
  } catch (error) {
    rmSync(staged, { force: true });
    // Windows refuses to rename over a running image; every other platform
    // swaps the directory entry happily while the old inode keeps executing.
    throw new Error(
      process.platform === "win32"
        ? `Windows will not replace myna while it is running. Close it and run the installer again.`
        : `Could not install into ${directory}: ${(error as Error).message}`,
    );
  }

  report(`Installed ${wanted} at ${target}`);
  return {
    ...check,
    latest: wanted,
    // The release that is now on disk, which is not the newest one when
    // --version asked for an older build.
    url: wanted === check.latest ? check.url : `https://github.com/${REPO}/releases/tag/v${wanted}`,
    installed: true,
    path: target,
    asset,
  };
}

/**
 * A true thing to say about the daemon after an update, or nothing.
 *
 * The daemon runs the binary that was on disk when it started, so it keeps
 * posting from the old one until it is restarted. Worth a line, but only on a
 * machine that actually has the unit installed.
 */
export function daemonHint(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const unit = join(process.env.HOME ?? "", ".config/systemd/user/myna-daemon.service");
  if (!existsSync(unit)) return undefined;
  return "The daemon runs the old binary until it restarts:  systemctl --user restart myna-daemon";
}
