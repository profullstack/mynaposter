/**
 * The dashboard shell, and that the build emits it.
 *
 * The site's CSP forbids inline script and style, so the shell references
 * files for both and carries the API base as data. The build test runs the
 * real build script (into public/, which git ignores) and checks /dashboard is
 * there with its script and stylesheet, and linked from the home page nav.
 */
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDashboardPage } from "../src/dashboard-page.ts";
import { renderHandoffPage } from "../src/handoff-page.ts";

const web = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("the shell is CSP-clean, not indexed, and has every piece the script drives", () => {
  const html = renderDashboardPage("https://mynaposter.com/api");
  expect(html).toContain('<script src="/dashboard.js"></script>');
  expect(html).toContain('<link rel="stylesheet" href="/dashboard.css">');
  expect(html).toContain('data-api="https://mynaposter.com/api"');
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(html).not.toMatch(/<script>|<style>|\son[a-z]+=/);
  for (const id of ["status", "signin", "signin-form", "email", "password", "signin-note", "board", "board-title", "cards", "empty", "show-done", "refresh", "who", "signout"]) {
    expect(html).toContain(`id="${id}"`);
  }
});

test("the script keeps the token out of reach: no web storage, cookie sent same-origin", () => {
  const script = readFileSync(join(web, "assets", "dashboard.js"), "utf8");
  expect(script).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  expect(script).toContain('credentials: "same-origin"');
  expect(script).toContain("/v1/cloud/session");
  expect(script).not.toMatch(/innerHTML/);
});

test("the card page links to the dashboard", () => {
  expect(renderHandoffPage("/api")).toContain('href="/dashboard"');
});

test("the build emits /dashboard with its script and stylesheet", () => {
  const built = Bun.spawnSync(["bun", join(web, "src", "build.ts")], { cwd: web, stdout: "pipe", stderr: "pipe" });
  expect(built.exitCode).toBe(0);
  const out = join(web, "public");
  expect(existsSync(join(out, "dashboard.html"))).toBe(true);
  expect(existsSync(join(out, "dashboard.js"))).toBe(true);
  expect(existsSync(join(out, "dashboard.css"))).toBe(true);
  const page = readFileSync(join(out, "dashboard.html"), "utf8");
  expect(page).toContain('id="signin-form"');
  // Versioned, because the site serves scripts as immutable.
  expect(page).toMatch(/<script src="\/dashboard\.js\?v=[0-9a-f]{10}"><\/script>/);
  expect(page).toContain('data-api="/api"');
  expect(readFileSync(join(out, "index.html"), "utf8")).toContain('<a href="/dashboard">Dashboard</a>');
  expect(readFileSync(join(out, "robots.txt"), "utf8")).toContain("Disallow: /dashboard");
}, 60_000);
