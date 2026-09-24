/**
 * Cut a release, end to end.
 *
 * Tagging is the whole release (see .github/workflows/release.yml), but a tag
 * on its own leaves four things undone that a person then has to remember: the
 * version literal a test guards, the binary on this box that the daemon
 * actually runs, the announcement, and the ad. Every one of those has been
 * forgotten at least once. This does the lot in order and stops at the first
 * thing that does not look right.
 *
 *   bun scripts/ship.ts minor --announce "myna 0.34.0 tags the links you post."
 *   bun scripts/ship.ts 0.34.1 --dry-run
 *
 * Two things are deliberately read rather than restated. The packages to bump
 * are every workspace package.json already sitting on the current version,
 * which is what keeps a package that joined the release set from being missed
 * and a package deliberately left behind from being dragged forward. And the
 * test command is parsed out of the release workflow, so this script can never
 * test less than CI does.
 *
 * The announcement copy is never written for you. An announcement in a voice
 * nobody chose is worse than none, so without --announce the send is skipped
 * and the exact command to run is printed instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const VERSION_FILE = join(ROOT, "packages/core/src/version.ts");
const WORKFLOW = join(ROOT, ".github/workflows/release.yml");
const BINARY = join(process.env.HOME ?? "", ".local/bin/myna");
const DAEMON = "myna-daemon";
/** The workflow uploads this many files; fewer means a half-attached release. */
const EXPECTED_ASSETS = 7;

interface Options {
  level: "patch" | "minor" | "major" | string;
  announce?: string;
  dryRun: boolean;
  skipInstall: boolean;
  skipAd: boolean;
}

/* ------------------------------------------------------------------ shell */

let dryRun = false;

/** Run a command and return its output. Throws with the command's own stderr. */
function run(command: string, args: string[], { cwd = ROOT, quiet = false } = {}): string {
  try {
    const out = execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.trim();
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string };
    const detail = (failure.stderr || failure.stdout || failure.message).trim();
    if (!quiet) throw new Error(`${command} ${args.join(" ")}\n${detail}`);
    return "";
  }
}

/** A command that changes something outside this process. Skipped on a dry run. */
function change(label: string, command: string, args: string[], opts?: { cwd?: string }): string {
  if (dryRun) {
    say(`would  ${label}`);
    return "";
  }
  return run(command, args, opts);
}

const say = (line: string) => console.log(line);
const step = (line: string) => console.log(`\n${line}`);

/* ---------------------------------------------------------------- version */

function currentVersion(): string {
  const match = readFileSync(VERSION_FILE, "utf8").match(/export const VERSION = "([^"]+)"/);
  if (!match) throw new Error(`No VERSION literal in ${VERSION_FILE}.`);
  return match[1]!;
}

export function nextVersion(current: string, level: string): string {
  if (/^\d+\.\d+\.\d+$/.test(level)) return level;
  const [major, minor, patch] = current.split(".").map(Number) as [number, number, number];
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Version wants patch, minor, major or an exact number like 0.34.1, not "${level}".`);
}

/**
 * Every workspace package.json already on `version`. A package that is
 * deliberately behind stays behind, and a package that joined the release set
 * is found without this script having to be edited.
 */
export function packagesOn(version: string, root = ROOT): string[] {
  const found: string[] = [];
  for (const dir of ["apps", "packages"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const file = join(base, entry, "package.json");
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
      if (parsed.version === version) found.push(file);
    }
  }
  return found.sort();
}

/** Replace the first version string in a package.json, leaving its formatting alone. */
function bumpPackage(file: string, from: string, to: string): void {
  const text = readFileSync(file, "utf8");
  const updated = text.replace(`"version": "${from}"`, `"version": "${to}"`);
  if (updated === text) throw new Error(`${file} does not carry "version": "${from}".`);
  if (!dryRun) writeFileSync(file, updated);
}

/* --------------------------------------------------------------- workflow */

/**
 * The test command the release workflow runs. Parsed rather than repeated: the
 * workflow's list has grown twice, and a script carrying its own stale copy
 * would pass while CI failed.
 */
export function workflowTestCommand(workflow = readFileSync(WORKFLOW, "utf8")): string[] {
  const match = workflow.match(/- name: Test\n\s+run: (.+)\n/);
  if (!match) throw new Error("No Test step found in the release workflow.");
  return match[1]!.trim().split(/\s+/);
}

/* ----------------------------------------------------------------- backup */

/** The next free `<path>.bak-NNN`, so a rebuild never lands on an unkept binary. */
export function nextBackup(path: string, exists = existsSync): string {
  for (let index = 1; index < 1000; index++) {
    const candidate = `${path}.bak-${String(index).padStart(3, "0")}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`No free backup name beside ${path}.`);
}

/* ------------------------------------------------------------------ steps */

function preflight(): void {
  step("preflight");
  const dirty = run("git", ["status", "--porcelain"]);
  if (dirty) throw new Error(`The tree has uncommitted changes:\n${dirty}\nCommit or stash them before shipping.`);
  run("gh", ["auth", "status"]);
  say("  clean tree, gh authenticated");
}

function waitForChecks(pr: string): void {
  // A PR with no checks yet reads the same as a PR whose checks all passed, so
  // the wait is for checks to appear and then to settle, in that order.
  for (let attempt = 0; attempt < 60; attempt++) {
    const out = run("gh", ["pr", "checks", pr], { quiet: true });
    if (out && !out.includes("pending")) {
      say(`  checks settled\n${out.split("\n").map((line) => `    ${line}`).join("\n")}`);
      if (/\bfail\b/.test(out)) throw new Error(`A check failed on PR ${pr}. Nothing has been tagged.`);
      return;
    }
    Bun.sleepSync(10_000);
  }
  throw new Error(`Checks on PR ${pr} never settled.`);
}

function waitForRelease(tag: string): number {
  for (let attempt = 0; attempt < 60; attempt++) {
    const assets = run("gh", ["release", "view", tag, "--json", "assets", "--jq", "[.assets[].name] | length"], { quiet: true });
    const count = Number(assets || 0);
    if (count >= EXPECTED_ASSETS) return count;
    Bun.sleepSync(10_000);
  }
  return Number(run("gh", ["release", "view", tag, "--json", "assets", "--jq", "[.assets[].name] | length"], { quiet: true }) || 0);
}

function installLocally(): void {
  step("install on this box");
  // The release does not touch this machine and the daemon runs the compiled
  // binary, so a release nobody rebuilds is a release this box never gets.
  if (existsSync(BINARY)) {
    const backup = nextBackup(BINARY);
    if (!dryRun) copyFileSync(BINARY, backup);
    say(`  backup   ${backup}`);
  }
  change("build ~/.local/bin/myna", "bun", [
    "build",
    "--compile",
    "--target=bun-linux-x64",
    "--minify",
    "--sourcemap=none",
    "apps/cli/src/main.ts",
    `--outfile=${BINARY}`,
  ]);
  if (!dryRun) say(`  installed ${run(BINARY, ["--version"], { quiet: true })}`);

  const active = run("systemctl", ["--user", "is-enabled", DAEMON], { quiet: true });
  if (!active) {
    say(`  daemon   ${DAEMON} not installed, nothing to restart`);
    return;
  }
  change(`restart ${DAEMON}`, "systemctl", ["--user", "restart", DAEMON]);
  if (!dryRun) say(`  daemon   ${run("systemctl", ["--user", "is-active", DAEMON], { quiet: true })}`);
}

function promote(version: string, url: string, options: Options): void {
  step("promote");
  if (!options.announce) {
    say("  announce skipped: no --announce text given. To send it by hand:");
    say(`    myna post --to all --front "myna ${version} ..." `);
  } else {
    const text = options.announce.startsWith("@") ? readFileSync(options.announce.slice(1), "utf8").trim() : options.announce;
    if (!text) throw new Error("The announcement text is empty.");
    say(`  text     ${text.length} chars`);
    const out = change("queue the announcement", BINARY, ["post", "--to", "all", "--front", text]);
    if (out) say(out.split("\n").map((line) => `    ${line}`).join("\n"));
  }

  if (options.skipAd) {
    say("  ad       skipped");
    return;
  }
  // A release with no blog post still wants an ad.
  const ad = change("file the crawlproof ad", BINARY, ["crawlproof", "ad", url]);
  if (ad) say(ad.split("\n").map((line) => `    ${line}`).join("\n"));
}

/* ------------------------------------------------------------------- main */

function parse(argv: string[]): Options {
  const positional: string[] = [];
  const options: Options = { level: "patch", announce: undefined, dryRun: false, skipInstall: false, skipAd: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-install") options.skipInstall = true;
    else if (arg === "--no-ad") options.skipAd = true;
    else if (arg === "--announce") options.announce = argv[++index];
    else if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}.`);
    else positional.push(arg);
  }
  if (positional[0]) options.level = positional[0];
  return options;
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  dryRun = options.dryRun;

  const from = currentVersion();
  const to = nextVersion(from, options.level);
  const tag = `v${to}`;
  say(`ship ${from} -> ${to}${dryRun ? "   (dry run: nothing is pushed, sent or installed)" : ""}`);

  preflight();

  step("bump");
  const targets = packagesOn(from);
  if (!targets.length) throw new Error(`No package.json is on ${from}. Is the tree mid-release?`);
  for (const file of targets) {
    bumpPackage(file, from, to);
    say(`  ${file.replace(`${ROOT}/`, "")}`);
  }
  if (!dryRun) writeFileSync(VERSION_FILE, readFileSync(VERSION_FILE, "utf8").replace(`"${from}"`, `"${to}"`));
  say(`  packages/core/src/version.ts`);
  say(`  ${targets.length + 1} files`);

  step("check");
  run("bun", ["install"]);
  run("bun", ["x", "tsc", "--noEmit", "-p", "tsconfig.json"]);
  say("  typecheck clean");
  const test = workflowTestCommand();
  const result = run(test[0]!, test.slice(1));
  say(`  ${result.split("\n").filter((line) => /pass|fail/.test(line)).join(" ").trim() || "tests passed"}`);

  step("merge");
  const branch = `release-${to}`;
  change(`branch ${branch}`, "git", ["checkout", "-b", branch]);
  change("commit", "git", ["commit", "-aqm", `chore: ${tag}`]);
  change("push", "git", ["push", "-u", "origin", branch]);
  const pr = change("open the PR", "gh", ["pr", "create", "--title", `chore: ${tag}`, "--body", `Version bump to ${to}.`]);
  if (pr) say(`  ${pr}`);
  if (!dryRun) {
    waitForChecks(pr);
    run("gh", ["pr", "merge", pr, "--squash", "--delete-branch=false"]);
    say("  merged");
  }

  step("tag");
  change("fetch main", "git", ["fetch", "origin", "main"]);
  change("check out main", "git", ["checkout", "-B", "main", "origin/main"]);
  change(`tag ${tag}`, "git", ["tag", tag]);
  change("push the tag", "git", ["push", "origin", tag]);

  let url = `https://github.com/profullstack/mynaposter/releases/tag/${tag}`;
  if (!dryRun) {
    const count = waitForRelease(tag);
    say(`  ${count} assets attached`);
    if (count < EXPECTED_ASSETS) {
      say(`  WARNING: expected ${EXPECTED_ASSETS}. See github-release-500-publish-by-hand before promoting.`);
    }
    url = run("gh", ["release", "view", tag, "--json", "url", "--jq", ".url"], { quiet: true }) || url;
    say(`  ${url}`);
  }

  if (!options.skipInstall) installLocally();
  promote(to, url, options);

  step(`shipped ${tag}`);
  return 0;
}

// Only when run as a command. The pure helpers above are imported by the
// tests, and an import that cut a release would be a memorable bug.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      console.error(`\nstopped: ${error.message}`);
      process.exit(1);
    });
}
