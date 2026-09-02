/**
 * Turning SVG or HTML into a PNG, using whatever the machine already has.
 *
 * Networks will not accept an SVG upload, so something has to rasterize. Rather
 * than pull in a native rendering dependency, myna looks for a tool that is
 * already installed and reports honestly when none is.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean) as string[];

function which(command: string): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Plenty of machines have no system browser but do have one downloaded by
 * Playwright or Puppeteer. Those count, and finding them saves an install.
 */
function browserFromCache(): string | null {
  const home = homedir();
  const roots = [
    join(home, ".cache", "ms-playwright"),
    join(home, "Library", "Caches", "ms-playwright"),
    join(home, ".cache", "puppeteer"),
    join(home, ".cache", "puppeteer", "chrome"),
  ];
  const leaves = [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const entry of entries) {
      for (const leaf of leaves) {
        const candidate = join(root, entry, ...leaf);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function findChrome(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    const found = which(candidate);
    if (found) return found;
  }
  return browserFromCache();
}

export interface RasterOptions {
  width: number;
  height: number;
  /** Device scale factor. 2 gives a retina-sharp image. */
  scale?: number;
  /**
   * Page background behind the graphic. Chrome's screenshot viewport does not
   * always match --window-size exactly, and those few pixels of difference
   * show up as a white strip; painting the page in the design's own colour
   * makes any mismatch invisible instead of ugly.
   */
  background?: string;
}

export type Rasterizer = "chrome" | "rsvg" | "magick" | "inkscape";

/** Which backends this machine can actually use, best first. */
export function availableRasterizers(): Rasterizer[] {
  const available: Rasterizer[] = [];
  if (findChrome()) available.push("chrome");
  if (which("rsvg-convert")) available.push("rsvg");
  if (which("magick") || which("convert")) available.push("magick");
  if (which("inkscape")) available.push("inkscape");
  return available;
}

/**
 * Render markup to PNG bytes.
 * `markup` may be SVG or a full HTML document; HTML requires Chrome.
 */
export function rasterize(markup: string, options: RasterOptions, isHtml = false): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "myna-"));
  const source = join(dir, isHtml ? "page.html" : "page.svg");
  const output = join(dir, "out.png");
  writeFileSync(source, markup, "utf8");

  try {
    const chrome = findChrome();
    if (chrome) {
      // Chrome letterboxes a bare .svg to fit the window, which crops the
      // bottom and leaves a white margin. Wrapping it in a zero-margin
      // document pins it to exactly the size we asked for.
      const chromeSource = isHtml ? source : join(dir, "wrapper.html");
      if (!isHtml) {
        writeFileSync(
          chromeSource,
          `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;` +
            `background:${options.background ?? "transparent"}}` +
            `svg{display:block;width:${options.width}px;height:${options.height}px}</style>${markup}`,
          "utf8",
        );
      }
      const scale = options.scale ?? 2;
      const result = spawnSync(
        chrome,
        [
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--hide-scrollbars",
          "--default-background-color=00000000",
          `--force-device-scale-factor=${scale}`,
          `--window-size=${options.width},${options.height}`,
          `--screenshot=${output}`,
          `file://${chromeSource}`,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      if (existsSync(output)) return new Uint8Array(readFileSync(output));
      if (isHtml) {
        throw new Error(`Chrome could not render the page: ${(result.stderr || "no output").slice(0, 300)}`);
      }
    }

    if (isHtml) {
      throw new Error(
        "Rendering HTML needs Chrome or Chromium. Install one, set CHROME_PATH, or use the svg backend (--style svg).",
      );
    }

    const rsvg = which("rsvg-convert");
    if (rsvg) {
      const result = spawnSync(rsvg, ["-w", String(options.width), "-h", String(options.height), "-o", output, source]);
      if (result.status === 0 && existsSync(output)) return new Uint8Array(readFileSync(output));
    }

    const magick = which("magick") ?? which("convert");
    if (magick) {
      const args = magick.endsWith("magick") ? ["convert"] : [];
      const result = spawnSync(magick, [...args, "-background", "none", "-density", "192", source, output]);
      if (result.status === 0 && existsSync(output)) return new Uint8Array(readFileSync(output));
    }

    const inkscape = which("inkscape");
    if (inkscape) {
      const result = spawnSync(inkscape, [source, "--export-type=png", `--export-filename=${output}`, `--export-width=${options.width}`]);
      if (result.status === 0 && existsSync(output)) return new Uint8Array(readFileSync(output));
    }

    throw new Error(
      "No way to turn the graphic into a PNG. Install one of: Chrome/Chromium, rsvg-convert (librsvg2-bin), ImageMagick, or Inkscape. " +
        "You can also pass --keep-svg to save the vector file and attach it yourself.",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
