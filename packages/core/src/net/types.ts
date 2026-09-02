/**
 * The adapter contract every network implements.
 *
 * A network declares what it can do and what it needs to log in; the rest of
 * hqsocial is written against this interface and never against a specific API.
 */

/** How a network lets you in. Decides what `/login <network>` prompts for. */
export type AuthKind =
  /** Real account username + password, accepted by the network's own API. */
  | "password"
  /** A long-lived token, app password or API key you paste in. */
  | "token"
  /** OAuth 2.0 authorization code + PKCE, through the browser. */
  | "oauth2"
  /** OAuth 1.0a signed requests (consumer key/secret + token/secret). */
  | "oauth1"
  /**
   * A device flow: the service shows a short code, a person approves it in a
   * browser, and the client polls until it is handed a token. Suits a terminal
   * better than OAuth2 does — no password crosses the process and no loopback
   * port has to be free.
   */
  | "device";

export interface CredentialField {
  key: string;
  label: string;
  /** Mask while typing and never print it back. */
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  /** One line shown under the field in the login dialog. */
  help?: string;
  default?: string;
}

export interface NetworkCapabilities {
  /** Characters allowed in one post. 0 means no practical limit. */
  charLimit: number;
  /** Attachments allowed on one post. 0 means none. */
  mediaLimit: number;
  /** Native reply chaining, so long text can be split into a thread. */
  threads: boolean;
  delete: boolean;
  timeline: boolean;
  notifications: boolean;
  /** Per-post engagement counts. */
  stats: boolean;
  /** A title is required, not optional (link/blog networks). */
  needsTitle?: boolean;
}

export interface Account {
  /** `network:handle` — unique, and what `--to` accepts. */
  id: string;
  network: string;
  handle: string;
  displayName?: string;
  addedAt: string;
  /** Secrets. Only ever written to the encrypted vault. */
  creds: Record<string, string>;
  /** Non-secret context: instance URL, page id, DID, subreddit default. */
  meta: Record<string, string>;
}

export interface MediaItem {
  path: string;
  mime: string;
  data: Uint8Array;
  alt?: string;
}

export interface PostInput {
  text: string;
  media?: MediaItem[];
  /** Network-native id of the post being replied to. */
  replyTo?: string;
  title?: string;
  /** Per-network extras: subreddit, community, tags. */
  extra?: Record<string, string>;
}

export interface PostResult {
  id: string;
  url?: string;
}

export interface TimelineItem {
  id: string;
  author: string;
  handle: string;
  text: string;
  createdAt: string;
  url?: string;
  likes?: number;
  reposts?: number;
  replies?: number;
}

export interface PostStats {
  likes?: number;
  reposts?: number;
  replies?: number;
  views?: number;
}

/** Passed to `login` so an adapter can talk to the user mid-flow. */
export interface LoginContext {
  /** Show a line of progress ("waiting for the browser…"). */
  report(message: string): void;
  /** Open a URL in the user's browser, falling back to printing it. */
  openUrl(url: string): Promise<void>;
  /**
   * Ask the person for a value, showing `prompt`. Supplied by whatever is
   * driving the login, because only it knows whether it has a terminal, a TUI
   * modal or a desktop dialog to ask with.
   *
   * Used by the paste-the-code sign-in, for browsers that are not on this
   * machine and so cannot reach a loopback redirect.
   */
  ask?(prompt: string): Promise<string>;
}

export interface Network {
  id: string;
  name: string;
  category: "major" | "fediverse" | "chat" | "forum" | "blog" | "minor";
  /** One line for `/networks`. */
  blurb: string;
  auth: {
    kind: AuthKind;
    fields: CredentialField[];
    /** Shown in the login dialog — where to get these values. */
    note?: string;
  };
  caps: NetworkCapabilities;

  /**
   * Verify the entered credentials and return the account to store.
   * Throws with a human-readable message when the credentials are rejected.
   */
  login(input: Record<string, string>, ctx: LoginContext): Promise<Omit<Account, "id" | "network" | "addedAt">>;

  post(account: Account, input: PostInput): Promise<PostResult>;
  remove?(account: Account, id: string): Promise<void>;
  timeline?(account: Account, limit: number): Promise<TimelineItem[]>;
  notifications?(account: Account, limit: number): Promise<TimelineItem[]>;
  stats?(account: Account, id: string): Promise<PostStats>;
}

export const NO_CAPS: NetworkCapabilities = {
  charLimit: 0,
  mediaLimit: 0,
  threads: false,
  delete: false,
  timeline: false,
  notifications: false,
  stats: false,
};
