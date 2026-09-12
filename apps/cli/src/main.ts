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
  login <network> [value...]        Connect an account. Asks for whatever that
                                    network accepts: a password where one works,
                                    a token where it does not, a browser sign-in
                                    for the ones that require it. Values given
                                    as arguments, or as --<field>, are not asked
                                    for again, so a login can be scripted
  logout <account>                  Disconnect and wipe its credentials
  accounts                          List connected accounts
  networks                          List all supported networks

Keeping myna current:
  update [--check]                  Replace this binary with the newest release.
                                    --check only reports, and exits 1 when an
                                    update is waiting. --version <x.y.z> installs
                                    a specific one, --force reinstalls

Posting:
  post [target] [text]              Post. Target is "all", a network, or an
                                    account id. Text can also be piped in.
                                    Paced: one account goes now, the rest are
                                    queued along the drip. --front jumps the
                                    queue and keeps the gap; --now sends all
  schedule <when> [text]            Queue a post: "in 2h", "tomorrow 9am"
  pace [--gap 4h] [--drip 48h]      The pacing rules: one post per network
       [--repost 7d]                per gap, several accounts spread over
                                    the drip, a repeat waits out the repost gap
  evergreen <blog account>          Re-post an old page every --every 7d to
       [--to all] [--every 7d]      --to, with a CrawlProof ad. --off stops it
  queue                             Show scheduled posts
  cancel <id>                       Remove a scheduled post
  history                           What was posted, and what failed, and
                                    which skill each post used
  skill                             The rules per network and per account,
                                    as skill.md files myna enforces: a daily
                                    cap, a gap, a content policy
    skill list                      Every network and account, which skill is on
    skill show <network[:account]>  Print one (an agent should read it first)
    skill init [--force]            Write the missing files from the templates
    skill path <network[:account]>  Where the file is
    skill add <account> <slug>      Another skill, from --from <file> or stdin
    skill default <account> <slug>  Pin one; rotate <account> on|off takes turns
    skill remove <account> <slug>
  recap [--days 1] [--send]         The last day and the next: what was sent,
  recap on --to you@example.com     what failed, what is booked. "on" mails it
       [--at 08:00]                 daily from the daemon; "off" stops it
  delete <account> <post id>        Delete a post you made
  repost <account> <post url>       Share a post from one account.
       [--at "in 2h"]               With --at it is queued instead of sent now
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

Directories (submitting the product, not a post):
  directory                         The directories myna can submit to, and
                                    which of them this machine is signed in to
  directory catalog                 The ones myna knows the address of
  directory add <id> <mcp url>      Add any MCP directory by URL. myna reads
  directory drop <id>               its tools to learn what it accepts
  directory tools <id>              What that MCP server actually offers
  directory login <id>              Connect one. SaaSRow emails a one-time code
  directory <id> <url>              Submit a product. myna reads the page and
       [--name] [--description]     fills the listing in; every field can be
       [--category] [--tags a,b]    given instead. --dry-run shows what would
       [--dry-run] [--no-ai]        be sent without sending it
  directory listings [id]           Your listings, and where each one stands
  directory update <id> <listing>   Change a listing you own
  directory remove <id> <listing>   Withdraw one
  directory categories | vocabulary What a directory accepts

Seeing it:
  dashboard                         A local dashboard: the queue, the drip,
                                    what each network is holding, what went out
       [--port 7777] [--no-open]

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
  --allow-duplicate Publish to a blog even though it already carries that title
  --overwrite       On load, replace accounts that already exist here
  --settings        On load, take the bundle's settings too
  --yes             Skip the confirmation on load

Examples:
  myna login bluesky
  myna login tsbb https://bbs.hqtui.com/ --forum app-showcase
  myna update                        # or: myna update --check
  myna post all "the release notes are up"
  myna skill show htmlblog           # the blog's rules: 4 a day, major features only
  echo "shipping today" | myna post bluesky,mastodon
  myna link https://example.com/blog/post --to all
  myna schedule "tomorrow 9am" "good morning" --to mastodon
  myna search youtube "terminal social media manager"
  myna post youtube "myna does this from the terminal" --video dQw4w9WgXcQ
  myna infographic https://example.com/report --style html
  myna directory login saasrow
  myna directory saasrow https://example.com --dry-run
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
