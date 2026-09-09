/**
 * Directories myna knows the address of.
 *
 * Two kinds of entry. One has an adapter compiled in, because it needed one:
 * SaaSRow's sign-in is an emailed code, which no tool call can carry. The rest
 * are just an MCP endpoint and a note about where its key comes from — myna
 * reads the tool table and works the field names out, so there is no adapter
 * to write and nothing to release when the directory changes.
 *
 * Everything here is optional. Nothing is contacted until somebody connects it,
 * and a directory that is not in this list is `myna directory add <id> <url>`,
 * which is the same code path with the URL typed instead of looked up.
 */

export interface CatalogEntry {
  id: string;
  name: string;
  /** The MCP endpoint. */
  url: string;
  homepage: string;
  blurb: string;
  /** Where a person gets the API key. */
  keysAt?: string;
  /**
   * True when myna ships a written adapter for it. False means it is reached
   * generically, by reading its tool table.
   */
  builtIn: boolean;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "saasrow",
    name: "SaaSRow",
    url: "https://saasrow.com/api/mcp",
    homepage: "https://saasrow.com",
    blurb: "A software directory that publishes each listing to search, AI assistants, an API and MCP",
    keysAt: "https://saasrow.com/developers",
    builtIn: true,
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  const wanted = id.trim().toLowerCase();
  return CATALOG.find((entry) => entry.id === wanted);
}
