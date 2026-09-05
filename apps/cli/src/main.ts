/**
 * myna, a terminal social media manager.
 *
 *   myna                          the full TUI
 *   myna login facebook           connect an account
 *   myna post all "shipping"      post from a script
 */
import { VERSION } from "@profullstack/myna-core";
import { runTui } from "./tui/app.ts";
import { runHeadless, parseFlags } from "./cli/headless.ts";
import { preparePlugins } from "./plugins.ts";


const HELP = `myna ${VERSION} - post to every social network from your terminal

Usage:
  myna                              Open the TUI
  myna <command> [args] [flags]     Run one command and exit

Accounts:
  login <network>                   Connect an account. Asks for whatever that
                                    network accepts: a password where one works,
                                    a token where it does not, a browser sign-in
                                    for the ones that require it
  logout <account>                  Disconnect and wipe its credentials
  accounts                          List connected accounts
  networks                          List all supported networks

Posting:
  post [target] [text]              Post now. Target is "all", a network, or an
                                    account id. Text can also be piped in
  schedule <when> [text]            Queue a post: "in 2h", "tomorrow 9am"
  queue                             Show scheduled posts
  cancel <id>                       Remove a scheduled post
  history                           What was posted, and what failed
  delete <account> <post id>        Delete a post you made
  repost <account> <post url>       Share someone's post from one account
  feed [network]                    Read a home timeline
  search [network] <query>          Find posts to reply to. On YouTube this
                                    lists videos; comment with post --video
  run                               The daemon: sends due posts, runs the
                                    follow graph and every plugin's tasks

Following (Bluesky, Mastodon, Misskey, X, Nostr):
  follow <account> <handle>         Follow someone from one account
  following <account> [handle]      Who an account follows. Yours by default
  graph                             The follow graph: seed it with people
                                    worth learning from, read who they follow,
                                    follow the ones they agree on
    graph seed <network> <handle>   Add a seed (--weight N to count it more)
    graph expand                    Read who the seeds follow
    graph candidates                Who to follow next, best first
    graph follow [--limit N]        Follow the next few, within the limits
    graph on | off                  Let the daemon do all of this
    graph status | seeds | skip | unseed | clear

Plugins:
  plugins                           What is loaded, and what each one adds
  plugins add <package or path>     Install a plugin
  plugins remove <package or id>    Forget one
  outreachgraph login | sync        Pull OutreachGraph's ranked people in as
                                    seeds (bundled plugin)

Writing (optional, needs an API key):
  draft <what to write about>       Draft a post
  link <url>                        Read a link and write a post about it
  infographic <url or topic>        Build an infographic to attach

Moving between machines:
  save [path]                       Write an encrypted bundle of accounts,
                                    queue and settings. Asks for a passphrase
  load <path>                       Merge a bundle into this install. Shows
                                    what it will change before it changes it

Cloud backup (optional; myna works fully without it):
  cloud signup [email]              Create an account
  cloud login [email]               Sign in on this machine
  cloud push                        Encrypt a bundle here, then upload it
  cloud pull                        Fetch it and merge it in
  cloud status                      What is stored, and when
  cloud forget                      Delete the stored backup
  cloud logout                      Sign out. The local vault is untouched

Other:
  config [key] [value]              Show or change settings
  doctor                            Check what is configured and working
  keys                              Show which keypresses actually reach myna

Flags:
  --to <spec>       Where to post: all, a network, an account id, comma separated
  --title <text>    Title for Reddit, Lemmy and blogs
  --media <path>    Attach a file. Repeatable
  --video <id|url>  YouTube: comment on this video rather than uploading
  --reply-to <id>   YouTube: answer this comment
  --style <kind>    Infographic backend: svg, html or image
  --json            Machine-readable output
  --dry-run         Show what would be posted or followed without doing it
  --limit <n>       How many: following, graph candidates, graph follow
  --force           graph follow: ignore the hourly and daily limits.
                    graph expand: re-read seeds read recently
  --no-thread       Truncate instead of splitting into a thread
  --overwrite       On load, replace accounts that already exist here
  --settings        On load, take the bundle's settings too
  --yes             Skip the confirmation on load

Examples:
  myna login bluesky
  myna post all "the release notes are up"
  echo "shipping today" | myna post bluesky,mastodon
  myna link https://example.com/blog/post --to all
  myna schedule "tomorrow 9am" "good morning" --to mastodon
  myna search youtube "terminal social media manager"
  myna post youtube "myna does this from the terminal" --video dQw4w9WgXcQ
  myna infographic https://example.com/report --style html
  myna graph seed bluesky jay.bsky.team --weight 2
  myna graph expand && myna graph candidates
  myna graph on && myna run          # follow 10/hour from who your seeds follow
  myna save ~/myna.myna              # then scp it to the other machine
  myna load ~/myna.myna
  myna cloud push                    # same bundle, encrypted here, stored there

Credentials are encrypted at rest in ~/.config/myna. Nothing leaves this
machine except the posts you send.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first) {
    await preparePlugins();
    await runTui();
    return;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (first === "keys") {
    // A key echo, for when a binding appears to do nothing. Ctrl+S is the
    // usual suspect: it is XOFF, and a terminal with flow control still on
    // swallows it before any program sees it.
    const { runKeyProbe } = await import("./tui/keys.ts");
    await runKeyProbe();
    return;
  }
  if (first === "tui") {
    const { flags } = parseFlags(argv.slice(1));
    await preparePlugins();
    await runTui({ theme: flags.theme as string | undefined });
    return;
  }

  process.exitCode = await runHeadless(first, argv.slice(1));
}

main().catch((error: Error) => {
  process.stderr.write(`myna: ${error.message}\n`);
  process.exitCode = 1;
});
