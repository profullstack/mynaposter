/**
 * Cross-compile myna into standalone binaries.
 *
 * `curl | sh` should not require the person running it to already have Bun or
 * Node, so the shipped artifact embeds the runtime. That costs about 80 MB per
 * platform, which is the trade every compiled-runtime CLI makes and the right
 * one here: the alternative is asking someone to install a package manager
 * before they can try a social media client.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "bin");

interface Target {
  /** What Bun calls it. */
  bun: string;
  /** What install.sh asks for: `myna-<os>-<arch>`. */
  asset: string;
}

const TARGETS: Target[] = [
  { bun: "bun-linux-x64", asset: "myna-linux-x86_64" },
  // Bun's default x64 build needs AVX2. The baseline build does not, and the
  // installer falls back to it on older CPUs rather than dying on SIGILL.
  { bun: "bun-linux-x64-baseline", asset: "myna-linux-x86_64-baseline" },
  { bun: "bun-linux-arm64", asset: "myna-linux-aarch64" },
  { bun: "bun-darwin-x64", asset: "myna-darwin-x86_64" },
  { bun: "bun-darwin-arm64", asset: "myna-darwin-arm64" },
  { bun: "bun-windows-x64", asset: "myna-windows-x86_64.exe" },
];

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const targets = only.length ? TARGETS.filter((target) => only.some((name) => target.asset.includes(name))) : TARGETS;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const checksums: string[] = [];

for (const target of targets) {
  const file = join(out, target.asset);
  process.stdout.write(`${target.asset.padEnd(32)}`);

  const result = spawnSync(
    "bun",
    ["build", "--compile", `--target=${target.bun}`, "--minify", "--sourcemap=none", join(here, "src", "main.ts"), "--outfile", file],
    { encoding: "utf8", cwd: here },
  );

  if (result.status !== 0 || !existsSync(file)) {
    console.log("FAILED");
    console.error(result.stderr?.slice(0, 600) || result.stdout?.slice(0, 600));
    process.exitCode = 1;
    continue;
  }

  const bytes = readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  checksums.push(`${digest}  ${target.asset}`);
  console.log(`${(bytes.length / 1e6).toFixed(1)} MB`);
}

writeFileSync(join(out, "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(`\n${checksums.length} binaries in ${out}`);
console.log("SHA256SUMS written. install.sh verifies against it before installing.");
