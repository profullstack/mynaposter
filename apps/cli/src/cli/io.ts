/**
 * Printing, for the scriptable CLI.
 *
 * Its own module so that a command living in its own file prints exactly the
 * way the ones in `headless.ts` do, without importing `headless.ts` back and
 * making the two a cycle.
 */

export const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

/** A plain aligned table. Nothing clever: it has to survive being piped. */
export function table(rows: Record<string, string>[], columns: { key: string; title: string }[]): void {
  if (!rows.length) return;
  const widths = columns.map((column) =>
    Math.max(column.title.length, ...rows.map((row) => String(row[column.key] ?? "").length)),
  );
  out(columns.map((column, i) => column.title.padEnd(widths[i])).join("  "));
  out(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    out(columns.map((column, i) => String(row[column.key] ?? "").padEnd(widths[i])).join("  "));
  }
}
