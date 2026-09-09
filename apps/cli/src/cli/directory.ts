/**
 * `myna directory` — submit a product to a software directory.
 *
 *   myna directory saasrow https://example.com
 *   myna directory login saasrow
 *   myna directory listings saasrow
 *
 * The headline form is deliberately short, because it is the one people type:
 * a directory id and a URL, and myna works out the rest by reading the page.
 * Everything derived can be overridden with a flag, and `--dry-run` prints the
 * listing without sending it — a submission is public and reviewed by someone,
 * so it is worth being able to look before it goes.
 */
import {
  DIRECTORIES,
  buildListing,
  directoryStatus,
  getDirectory,
  getDirectoryAccount,
  loginDirectory,
  logoutDirectory,
  openBrowser,
  requireDirectory,
  requireDirectoryAccount,
  submitListing,
  writerAvailable,
  type Directory,
  type Listing,
  type ListingInput,
} from "@profullstack/myna-core";
import { ask, askSecret, confirm } from "./prompt.ts";
import { out, table } from "./io.ts";
import type { Flags } from "./headless.ts";

const USAGE = `Usage:
  myna directory                              List directories and what is connected
  myna directory login <id>                   Connect a directory
  myna directory logout <id>                  Forget its credentials
  myna directory <id> <url> [flags]           Submit a product, read from its page
  myna directory listings [id]                Your listings there
  myna directory update <id> <listing> [flags]
  myna directory remove <id> <listing>
  myna directory categories [id]              What the directory accepts
  myna directory vocabulary [id]`;

/** `--tags a,b` and `--tags a --tags b` both mean the same list. */
function listFlag(value: unknown): string[] | undefined {
  const parts = (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === "string")
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The listing fields a person can set by hand, on submit or on update. */
export function listingFromFlags(flags: Flags): Partial<ListingInput> {
  return {
    name: text(flags.name),
    website: text(flags.website),
    description: text(flags.description),
    category: text(flags.category),
    tags: listFlag(flags.tags),
    useCases: listFlag(flags.useCases ?? flags.useCase),
    audiences: listFlag(flags.audiences ?? flags.audience),
    platforms: listFlag(flags.platforms ?? flags.platform),
    pricingModel: text(flags.pricing ?? flags.pricingModel),
    alternatives: listFlag(flags.alternatives ?? flags.alternativeTo),
  };
}

function printListingInput(listing: ListingInput): void {
  const row = (label: string, value?: string | string[]) => {
    if (!value || (Array.isArray(value) && !value.length)) return;
    out(`  ${label.padEnd(13)}${Array.isArray(value) ? value.join(", ") : value}`);
  };
  row("name", listing.name);
  row("website", listing.website);
  row("category", listing.category);
  row("tags", listing.tags);
  row("use cases", listing.useCases);
  row("audiences", listing.audiences);
  row("platforms", listing.platforms);
  row("pricing", listing.pricingModel);
  row("alternative", listing.alternatives);
  out(`  ${"description".padEnd(13)}${listing.description}`);
}

function printListing(listing: Listing): void {
  out(`${listing.name}${listing.status ? `  [${listing.status}]` : ""}`);
  if (listing.id) out(`  id           ${listing.id}`);
  if (listing.website) out(`  website      ${listing.website}`);
  if (listing.category) out(`  category     ${listing.category}`);
  if (listing.url) out(`  page         ${listing.url}`);
  if (listing.manageUrl) out(`  manage       ${listing.manageUrl}`);
}

/**
 * Ask for whatever the directory needs, the way `myna login` does: a value
 * given on the command line is never asked for again, so a login can be
 * scripted, and a non-interactive run says which flag would have filled a
 * field rather than hanging on a prompt nobody can see.
 */
async function collectAuthValues(directory: Directory, flags: Flags): Promise<Record<string, string>> {
  const interactive = Boolean(process.stdin.isTTY);
  const values: Record<string, string> = {};

  for (const field of directory.auth.fields) {
    const supplied = text(flags[field.key]);
    if (supplied) {
      values[field.key] = supplied;
      out(`  ${field.label}: ${field.secret ? "•".repeat(8) : supplied}`);
      continue;
    }
    if (!interactive) {
      if (!field.optional) {
        throw new Error(
          `${directory.id} needs ${field.label} and stdin is not a terminal. ` +
            `Pass it: myna directory login ${directory.id} --${field.key} <value>`,
        );
      }
      values[field.key] = field.default ?? "";
      continue;
    }
    const label = field.optional ? `${field.label} (optional)` : field.label;
    if (field.help) out(`  ${field.help}`);
    values[field.key] = field.secret ? await askSecret(label) : await ask(label, field.default ?? "");
  }
  return values;
}

async function login(id: string, flags: Flags): Promise<number> {
  const directory = requireDirectory(id);
  const interactive = Boolean(process.stdin.isTTY);

  out(`Connecting ${directory.name}.`);
  if (directory.auth.note) out(`\n${directory.auth.note}`);
  if (directory.auth.docsUrl) out(`More: ${directory.auth.docsUrl}`);
  out("");

  const values = await collectAuthValues(directory, flags);
  const account = await loginDirectory(directory.id, values, {
    report: (message) => out(`  ${message}`),
    openUrl: async (url) => {
      out(`  ${url}`);
      await openBrowser(url);
    },
    // Only offer to ask when somebody is there to answer: the emailed code is
    // a question, and a scripted login must fail rather than stall on it.
    ask: interactive ? (prompt) => ask(`  ${prompt}`) : undefined,
  });

  out(`\nConnected ${directory.id} as ${account.handle}`);
  return 0;
}

async function submit(id: string, url: string, flags: Flags): Promise<number> {
  const directory = requireDirectory(id);
  // Check the credential before reading the page or spending a model call —
  // but not on a dry run, where seeing the listing is the whole point and
  // there is nothing to authenticate.
  if (!flags.dryRun) requireDirectoryAccount(directory.id);

  const overrides = listingFromFlags(flags);
  const useAi = flags.noAi ? false : undefined;
  const writer = writerAvailable();
  if (useAi !== false && !writer.ok && !flags.json) {
    out("No writing model configured, so the listing comes from the page's own metadata.");
    out(`  ${writer.reason}`);
    out("");
  }

  const built = await buildListing(directory, url, { overrides, ai: useAi });

  if (!flags.json) {
    out(`Submitting to ${directory.name}:`);
    printListingInput(built.listing);
    out("");
  }

  if (flags.dryRun) {
    if (flags.json) out(JSON.stringify(built.listing, null, 2));
    else out("Dry run: nothing was sent.");
    return 0;
  }

  // A listing is public and goes to a person to review, so confirm it unless
  // told not to. A scripted run has no terminal and proceeds.
  if (!flags.yes && !flags.json && process.stdin.isTTY) {
    if (!(await confirm(`Submit this to ${directory.name}?`))) {
      out("Cancelled.");
      return 1;
    }
  }

  const result = await submitListing(directory.id, built.listing);
  if (flags.json) {
    out(JSON.stringify({ directory: result.directory, listing: result.listing, sent: result.input }, null, 2));
    return 0;
  }

  printListing(result.listing);
  if (directory.caps.review) out(`\nSubmitted for review. It appears once ${directory.name} approves it.`);
  return 0;
}

async function listings(id: string | undefined, flags: Flags): Promise<number> {
  const ids = id ? [requireDirectory(id).id] : directoryStatus().filter((row) => row.account).map((row) => row.directory.id);
  if (!ids.length) throw new Error("No directory is connected. Run: myna directory login saasrow");

  const all: Array<Listing & { directory: string }> = [];
  for (const directoryId of ids) {
    const directory = requireDirectory(directoryId);
    const account = requireDirectoryAccount(directoryId);
    for (const listing of await directory.listings(account)) all.push({ ...listing, directory: directoryId });
  }

  if (flags.json) {
    out(JSON.stringify(all, null, 2));
    return 0;
  }
  if (!all.length) {
    out("No listings yet.");
    return 0;
  }
  table(
    all.map((listing) => ({
      directory: listing.directory,
      status: listing.status ?? "",
      name: listing.name,
      website: listing.website,
      id: listing.id,
    })),
    [
      { key: "directory", title: "DIRECTORY" },
      { key: "status", title: "STATUS" },
      { key: "name", title: "NAME" },
      { key: "website", title: "WEBSITE" },
      { key: "id", title: "ID" },
    ],
  );
  return 0;
}

function overview(flags: Flags): number {
  const rows = directoryStatus();
  if (flags.json) {
    out(
      JSON.stringify(
        rows.map(({ directory, account }) => ({
          id: directory.id,
          name: directory.name,
          homepage: directory.homepage,
          connected: Boolean(account),
          handle: account?.handle,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  table(
    rows.map(({ directory, account }) => ({
      id: directory.id,
      name: directory.name,
      connected: account ? account.handle : "-",
      notes: directory.blurb,
    })),
    [
      { key: "id", title: "COMMAND" },
      { key: "name", title: "DIRECTORY" },
      { key: "connected", title: "CONNECTED" },
      { key: "notes", title: "NOTES" },
    ],
  );
  out(`\n${USAGE}`);
  return 0;
}

export async function runDirectory(positional: string[], flags: Flags): Promise<number> {
  const [first, ...rest] = positional;

  if (!first || first === "list") return overview(flags);
  if (first === "help") {
    out(USAGE);
    return 0;
  }

  switch (first) {
    case "login": {
      const id = rest[0];
      if (!id) throw new Error(`Which directory? Known: ${DIRECTORIES.map((entry) => entry.id).join(", ")}`);
      return await login(id, flags);
    }

    case "logout": {
      const id = rest[0];
      if (!id) throw new Error("Which directory?");
      out(logoutDirectory(id) ? `Forgot ${id}.` : `Not signed in to ${id}.`);
      return 0;
    }

    case "listings":
      return await listings(rest[0], flags);

    case "submit": {
      const [id, url] = rest;
      if (!id || !url) throw new Error("Usage: myna directory submit <id> <url>");
      return await submit(id, url, flags);
    }

    case "update": {
      const [id, listingId] = rest;
      if (!id || !listingId) throw new Error("Usage: myna directory update <id> <listing id> [flags]");
      const directory = requireDirectory(id);
      if (!directory.update) throw new Error(`${directory.name} does not allow editing a listing.`);
      const patch = listingFromFlags(flags);
      const updated = await directory.update(requireDirectoryAccount(directory.id), listingId, patch);
      if (flags.json) out(JSON.stringify(updated, null, 2));
      else printListing(updated);
      return 0;
    }

    case "remove":
    case "delete": {
      const [id, listingId] = rest;
      if (!id || !listingId) throw new Error("Usage: myna directory remove <id> <listing id>");
      const directory = requireDirectory(id);
      if (!directory.remove) throw new Error(`${directory.name} does not allow withdrawing a listing.`);
      if (!flags.yes && process.stdin.isTTY) {
        if (!(await confirm(`Permanently remove ${listingId} from ${directory.name}?`))) {
          out("Cancelled.");
          return 1;
        }
      }
      await directory.remove(requireDirectoryAccount(directory.id), listingId);
      out(`Removed ${listingId} from ${directory.name}.`);
      return 0;
    }

    case "categories": {
      const directory = requireDirectory(rest[0] ?? DIRECTORIES[0]?.id ?? "");
      if (!directory.categories) throw new Error(`${directory.name} publishes no category list.`);
      const rows = await directory.categories(getDirectoryAccount(directory.id));
      if (flags.json) out(JSON.stringify(rows, null, 2));
      else
        table(
          rows.map((row) => ({ name: row.name, count: row.count === undefined ? "" : String(row.count) })),
          [
            { key: "name", title: "CATEGORY" },
            { key: "count", title: "LISTINGS" },
          ],
        );
      return 0;
    }

    case "vocabulary":
    case "vocab": {
      const directory = requireDirectory(rest[0] ?? DIRECTORIES[0]?.id ?? "");
      if (!directory.vocabulary) throw new Error(`${directory.name} publishes no vocabulary.`);
      const vocabulary = await directory.vocabulary(getDirectoryAccount(directory.id));
      if (flags.json) {
        out(JSON.stringify(vocabulary, null, 2));
        return 0;
      }
      out(`use cases:      ${vocabulary.useCases.join(", ")}`);
      out(`audiences:      ${vocabulary.audiences.join(", ")}`);
      out(`platforms:      ${vocabulary.platforms.join(", ")}`);
      out(`pricing models: ${vocabulary.pricingModels.join(", ")}`);
      return 0;
    }

    default: {
      // `myna directory saasrow <url>` — the form people actually type.
      if (getDirectory(first)) {
        const url = rest[0];
        if (!url) throw new Error(`Usage: myna directory ${first} <url>`);
        return await submit(first, url, flags);
      }
      throw new Error(
        `Unknown directory or subcommand "${first}". Known directories: ${DIRECTORIES.map((entry) => entry.id).join(", ")}\n\n${USAGE}`,
      );
    }
  }
}
