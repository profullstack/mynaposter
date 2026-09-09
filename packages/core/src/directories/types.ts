/**
 * The contract a software directory implements.
 *
 * A directory is not a network, and trying to make it one was the wrong shape:
 * a post is text with optional media, and a listing is a product — a name, a
 * website, a description, a category. Feeding one through `post()` would mean
 * every network adapter grew fields it has no use for, and, worse, a directory
 * would land in `--to all` and get a stray thought submitted to it as a
 * product. So directories are their own small subsystem, with their own
 * credentials and their own command.
 */
import type { CredentialField, LoginContext } from "../net/types.ts";

/** What a directory needs to know about a product. */
export interface ListingInput {
  name: string;
  website: string;
  description: string;
  category?: string;
  tags?: string[];
  /** Controlled-vocabulary terms. A directory drops what it does not know. */
  useCases?: string[];
  audiences?: string[];
  platforms?: string[];
  pricingModel?: string;
  /** Products this one is positioned against. */
  alternatives?: string[];
}

/** A listing as the directory holds it. */
export interface Listing {
  id: string;
  name: string;
  website: string;
  description?: string;
  category?: string;
  tags?: string[];
  /** Where a person can read it, once it is public. */
  url?: string;
  /** The directory's own word: pending, approved, rejected. */
  status?: string;
  submittedAt?: string;
  /** A management link the directory hands back, where it issues one. */
  manageUrl?: string;
}

/** Credentials for one directory, as stored. Not an `Account`: see above. */
export interface DirectoryAccount {
  directory: string;
  /** Who this is, for display: usually the email the account is under. */
  handle: string;
  addedAt: string;
  /** Secrets. Only ever written to the encrypted vault. */
  creds: Record<string, string>;
  /** Non-secret context: the site URL, a key prefix worth showing. */
  meta: Record<string, string>;
}

export interface DirectoryCapabilities {
  /** Listings can be edited after they are submitted. */
  update: boolean;
  /** Listings can be withdrawn. */
  delete: boolean;
  /** The directory publishes the categories it accepts. */
  categories: boolean;
  /** The directory publishes a controlled vocabulary. */
  vocabulary: boolean;
  /** A submission is reviewed before it appears. */
  review: boolean;
}

export interface Vocabulary {
  useCases: string[];
  audiences: string[];
  platforms: string[];
  pricingModels: string[];
}

export interface Directory {
  id: string;
  name: string;
  /** One line for `myna directory list`. */
  blurb: string;
  homepage: string;
  /**
   * The MCP endpoint, where the directory speaks MCP. Declared so that
   * `myna directory tools <id>` can read the tool table without knowing which
   * kind of directory it is holding.
   */
  endpoint?: string;
  auth: {
    fields: CredentialField[];
    /** Shown in the login prompt — where the credential comes from. */
    note?: string;
    docsUrl?: string;
  };
  caps: DirectoryCapabilities;

  /**
   * Verify what was entered and return the account to store. Throws with a
   * message a person can act on when the credential is refused.
   */
  login(
    input: Record<string, string>,
    ctx: LoginContext,
  ): Promise<Omit<DirectoryAccount, "directory" | "addedAt">>;

  submit(account: DirectoryAccount, listing: ListingInput): Promise<Listing>;
  listings(account: DirectoryAccount): Promise<Listing[]>;
  update?(account: DirectoryAccount, id: string, patch: Partial<ListingInput>): Promise<Listing>;
  remove?(account: DirectoryAccount, id: string): Promise<void>;
  categories?(account?: DirectoryAccount): Promise<Array<{ name: string; count?: number }>>;
  vocabulary?(account?: DirectoryAccount): Promise<Vocabulary>;
}
