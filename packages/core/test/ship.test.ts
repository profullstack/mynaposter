/**
 * The decisions `scripts/ship.ts` makes before it touches anything.
 *
 * The script itself pushes, merges and posts, so what is tested here is only
 * the part that chooses: which version comes next, which packages get bumped,
 * what CI actually runs, and where the old binary is kept. Importing the script
 * must not cut a release, which is what `import.meta.main` in it is for.
 */
import { expect, test, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextVersion, packagesOn, workflowTestCommand, nextBackup } from "../../../scripts/ship.ts";

describe("choosing the next version", () => {
  test("counts up by level", () => {
    expect(nextVersion("0.33.0", "patch")).toBe("0.33.1");
    expect(nextVersion("0.33.0", "minor")).toBe("0.34.0");
    expect(nextVersion("0.33.4", "major")).toBe("1.0.0");
  });

  test("a minor or major bump resets what is below it", () => {
    expect(nextVersion("0.33.7", "minor")).toBe("0.34.0");
    expect(nextVersion("1.9.9", "major")).toBe("2.0.0");
  });

  test("an exact version is taken as given", () => {
    expect(nextVersion("0.33.0", "0.40.2")).toBe("0.40.2");
  });

  test("anything else is refused rather than guessed at", () => {
    expect(() => nextVersion("0.33.0", "next")).toThrow(/patch, minor, major/);
    expect(() => nextVersion("0.33.0", "v0.34.0")).toThrow();
  });
});

describe("choosing what to bump", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "ship-"));
    const write = (dir: string, version: string) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir, version }, null, 2));
    };
    write("apps/cli", "0.33.0");
    write("apps/api", "0.33.0");
    write("packages/core", "0.33.0");
    // Deliberately left behind, as several workspaces are.
    write("packages/plugin-calendar", "0.8.4");
    mkdirSync(join(root, "packages/no-manifest"), { recursive: true });
    return root;
  };

  test("takes every package already on the current version", () => {
    const found = packagesOn("0.33.0", fixture()).map((file) => file.split("/").slice(-3, -1).join("/"));
    expect(found).toEqual(["apps/api", "apps/cli", "packages/core"]);
  });

  test("leaves a package that is deliberately behind where it is", () => {
    const found = packagesOn("0.33.0", fixture()).join(" ");
    expect(found).not.toContain("plugin-calendar");
  });

  test("a directory with no package.json is skipped rather than throwing", () => {
    expect(() => packagesOn("0.33.0", fixture())).not.toThrow();
  });

  test("nothing on that version yields nothing, which the script treats as a stop", () => {
    expect(packagesOn("9.9.9", fixture())).toEqual([]);
  });
});

describe("reading the test command out of the workflow", () => {
  test("takes the Test step's run line", () => {
    const workflow = [
      "      - name: Typecheck",
      "        run: bun x tsc --noEmit -p tsconfig.json",
      "",
      "      - name: Test",
      "        run: bun test packages/core/test apps/cli/test",
      "",
      "      - name: Build binaries",
      "        run: bun build-binaries.ts",
      "",
    ].join("\n");
    expect(workflowTestCommand(workflow)).toEqual(["bun", "test", "packages/core/test", "apps/cli/test"]);
  });

  test("the real workflow still has one, and it is a bun test line", () => {
    const parsed = workflowTestCommand();
    expect(parsed[0]).toBe("bun");
    expect(parsed[1]).toBe("test");
    // The list this script must not fall behind.
    expect(parsed.length).toBeGreaterThan(2);
  });

  test("a workflow with no Test step is an error, not an empty command", () => {
    expect(() => workflowTestCommand("jobs:\n  binaries:\n    steps: []\n")).toThrow(/No Test step/);
  });
});

describe("keeping the binary it replaces", () => {
  test("takes the first free slot", () => {
    expect(nextBackup("/bin/myna", () => false)).toBe("/bin/myna.bak-001");
  });

  test("steps past the backups already there", () => {
    const taken = new Set(["/bin/myna.bak-001", "/bin/myna.bak-002"]);
    expect(nextBackup("/bin/myna", (path) => taken.has(String(path)))).toBe("/bin/myna.bak-003");
  });
});
