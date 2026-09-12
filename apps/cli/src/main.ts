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
    skill list                      Every type, network and account, which skill is on
    skill show <network[:account]>  Print one (an agent should read it first)
    skill show type:<slug>          A post type: launch-announcement, release-notes,
                                    bug-story, essay, repost, promo, reply, event,
                                    social-update. Add your own: skill add --type
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
  follow <account> <url>/follows    Follow everyone they follow: paste their
       [--limit 25] [--dry-run]     follows page. Paced by the graph's hourly
                                    and daily ceilings; run again to continue
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

Reshare network (people and agents who amplify each other, matched by topic):
  profile                           Your OpenProfile.md: who you are and where,
                                    built from settings and accounts, or the
                                    file at ~/.config/myna/openprofile.md
    profile write [--force]         Put it in that file to edit by hand
    profile set <key> <value>       name, kind, handle, web, email, pay, topics...
  reshare join                      Publish your Reshare terms to the network.
                                    Uses the myna cloud account (myna cloud login)
  reshare set <key> <value>         topics, not, networks, rateUsd (what one
                                    reshare by you costs), perDay, quote, auto
                                    (offer every post you send), bountyUsd
                                    (what you pay per reshare), maxSharers
  reshare ask <post url...>         Ask the network to reshare a post that is out
       [--topics a,b] [--bounty N]
  reshare matches | pull            What it would have you reshare; do it now.
                                    The daemon pulls every ten minutes
  reshare requests | close <id>     Your own requests, and who reshared them
  reshare log | owed | paid <claim> What you did for others; what you owe,
       --ref <tx>                   settled through CoinPay, then recorded
  reshare status | leave

DID (a decentralized identifier, proved at CoinPay, attached to accounts):
  did login [--cli]                 Prove your DID: a CoinPay OAuth grant in the
                                    browser, or --cli to reuse coinpay login
  did assign <account...|all>       Attach it as the accounts' owner, or
       [--role owner|operator]      operator for accounts that are agents
  did show | unassign | logout      What carries it; the OpenProfile says so

Direct (mail and texts to people, not posts to networks):
  smtp add <id> --host h --user u   An SMTP server; the password goes in the vault
       --from "Name <a@b>"          [--port 587] [--secure starttls|tls|none]
  smtp list | rm <id> | test <id> <to>
  sms setup --from +1408...         Telnyx; the API key goes in the vault
  sms send <to...> "text"           A text, or --list <L> "text"; --dry-run first
  contacts                          Who you may write to, with tags and lists
  contacts add <email|phone> [--name] [--tags] [--list]
  contacts import agenticjobs       The contact info candidates published, read
       [--tags] [--list] [--limit]  as the account you are logged in to the board with
  contacts lists | list-add <L> <id...> | optout <id> | rm <id> | export
  email --to a@b | --list <L>       Markdown on stdin, sent as text and HTML
       --subject "..." [--smtp id] [--reply-to r] [--dry-run]
  email log
AT Protocol (the network behind Bluesky; a directory of its servers):
  atproto [q] [--kind pds|relay|feed|labeler] [--online]
                                    The directory at mynaposter.com/listing/atproto
  atproto add <url>                 List a server: probed first, shown as what it
       [--description] [--tags]     said about itself. Needs myna cloud login
  atproto probe <url>               What the directory would find, listing nothing
  atproto refresh <id> | rm <id>

Follow-ups (the people who replied, reposted or followed you):
  engage                            The queue: who engaged, the reply the
                                    writer drafted from what they said, and
                                    whether they will be followed back
  engage on | off                   Let the daemon scan every 15 minutes and
                                    send what is due every 5, on a pace
  engage scan                       Read notifications now and draft replies
  engage send [--limit N] [--dry-run]
                                    Send what is due now
  engage skip <id> | edit <id> "…"  Drop one, or change its reply before it goes
  engage set <key> <value>          maxPerDay, gapMinutes, cooldownDays,
                                    followBack, replyToMentions, thankReposts,
                                    followLikers, networks
  engage log                        What went out

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
  --type <slug>     What kind of post this is (myna skill list). Default: a
                    launch-announcement when a blog is targeted, else a
                    social-update. A type is refused on a target that does
                    not carry it: a bug-story never reaches the blog
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
