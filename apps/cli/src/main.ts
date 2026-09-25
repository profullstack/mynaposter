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
                                    at once, past the daily cap: it is for a
                                    post you asked for by hand. Automated
                                    promotion never passes it
  schedule <when> [text]            Queue a post: "in 2h", "tomorrow 9am"
  pace [--gap 2h] [--drip 48h]      The pacing rules: one post per network
       [--repost 7d]                per gap, several accounts spread over
                                    the drip, a repeat waits out the repost gap
  utm [--add example.com]           Campaign tags on the links you post, so
      [--exclude host] [--off]      the site can see which network sent the
                                    visit. Sites your accounts publish to are
                                    tagged already; --add covers the rest
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
       [--html out.html]            what failed, what is booked, as a report
  recap on|off|status               The nightly summary email, ON by default:
       [--to you@example.com]       the daemon mails it at --at (08:00) to your
       [--at 08:00]                 profile email unless --to says otherwise
  delete <account> <post id>        Delete a post you made
  repost <account> <post url>       Share a post from one account.
       [--at "in 2h"]               With --at it is queued instead of sent now
  feed [network]                    Read a home timeline
  search [network] <query>          Find posts to reply to. On YouTube this
                                    lists videos; comment with post --video
  run                               The daemon: sends due posts, runs the
                                    follow graph and every plugin's tasks

Brand, plan and autopilot (the parts that run without you):
  brand                             What myna thinks you sound like: audience,
                                    positioning, voice, the subjects you return
                                    to, and what never goes out. One Markdown
                                    file that everything which writes reads first
    brand learn [--url u]           Write it from the posts you have already
       [--limit 120]                sent. Asks nothing: it reads your history,
                                    your OpenProfile and your site
    brand edit | path | show
    brand set <key> <value>         name, audience, positioning, voice
    brand pillar add|rm ["a: why"]  The subjects you keep returning to
    brand avoid add|rm "<text>"     What never goes out
  plan                              Planned angles: a subject and an argument on
                                    a date, with no copy written yet. --all
                                    includes the ones already booked
    plan generate [--days 30]       Angles from the brand's pillars, spread
       [--per-week 5] [--to all]    evenly over the window
    plan draft <id> [--force]       Write the copy for one angle
    plan queue <id> [--at when]     Book a drafted one into the pacing queue
    plan drop <id> | clear
  atomize <url or file>             One long thing becomes many dated angles:
       [--angles 12] [--over 30d]   a post, a whitepaper, a transcript. The
       [--dry-run] [--to all]       angles go on the plan, not into the queue,
                                    so nothing is written until you ask
  autopilot                         Hold a cadence, and do nothing at all while
                                    you are holding it yourself. It counts what
                                    you posted in the last week and what is
                                    booked for the next, and only fills the gap
    autopilot on | off              The daemon takes one turn an hour
    autopilot now [--dry-run]       Take a turn right now
    autopilot set <key> <value>     perWeek (5), holdHours (24: nothing is ever
                                    booked sooner, so you can always cancel),
                                    to, refillPlan, planAheadDays

Following (Bluesky, Mastodon, Misskey, X, Nostr):
  follow <account> <handle>         Follow someone from one account
  follow <account> <url>/follows    Follow everyone they follow: paste their
       [--limit 25] [--dry-run]     follows page. Paced by the graph's hourly
                                    and daily ceilings; run again to continue
  follow <account> <url>/followers  Follow everyone who follows them, same pace
       [--outreachgraph]             Also hand each person followed to
                                    OutreachGraph for assessment (any follow)
  following <account> [handle]      Who an account follows. Yours by default
  followers <account> [handle]      Who follows an account. Yours by default
  graph                             The follow graph: seed it with people
                                    worth learning from, read who they follow,
                                    follow the ones they agree on
    graph seed <network> <handle>   Add a seed (--weight N to count it more)
    graph expand [--followers|--both]  Read who the seeds follow, or who
                                    follows them (graph.expand sets the default)
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
       --subject "..." [--via id] [--reply-to r] [--dry-run]   (--smtp id still works)
  email log
  mail provider add <id> --type t   A mail provider; t is resend, mailgun, mandrill,
       [--from "Name <a@b>"]        sendgrid, postmark, ses, brevo, sparkpost,
       [--domain d] [--region r]    mailjet, smtp2go, smtp or myna-cloud. The key
       [--stream s] [--key-id k]    comes from stdin, --key, or a prompt, and goes
                                    in the vault. myna-cloud sends for you through
                                    myna cloud (myna cloud login), capped per day
  mail provider list | rm <id> | test <id> --to addr
  mail provider default <id|none>   What email and newsletters use without --via

Newsletter (issues to a contacts list; one-click unsubscribe and your postal
address on every one, paced by outreach.maxEmailsPerDay):
  newsletter create --subject "..." --list <L> [--at when] [--via id] [--reply-to r] < issue.md
       [--subject-b "..."]          A/B: variants are the subjects x the CTA set,
       [--cta-set default|none]     one per person; {{cta}} marks the button
       [--service moshcode] [--id slug]   footer: "an account at moshcode" not "subscribed"
  newsletter list | show <id> [--body] | rm <id> [--force]
  newsletter edit <id> [--subject] [--subject-b] [--list] [--cta-set] [--at when | --draft] [--via id] [< issue.md]
  newsletter send <id> [--dry-run] [--to addr] [--yes] [--via id] [--limit N] [--max-per-day N]
       [--retry-failed] [--retry-uncertain]   --yes sends the list; --to one test copy (variant A)
                                    Resumes from its ledger; nobody gets it twice
       [--background]               with --yes: detached, like blast --go
  newsletter blast <issue.md> --list <L> --id <slug> --subject "..." [--csv users.csv]
       [--subject-b "..."] [--service s] [--cta-set name] [--via id] [--reply-to r]
       [--tags a,b] [--test-to addr] [--max-per-day N] [--clean]
                                    One command for step one: imports the CSV (--clean
                                    runs it through email-cleaner first), creates the
                                    issue or updates its draft, sends ONE test copy
                                    (to --test-to, else the reply-to, else the From),
                                    prints who gets it and the variant split, and stops
  newsletter blast --go <id> [--max-per-day N]
                                    Step two: the list send in the background, so the
                                    terminal comes back at once. Logs under
                                    ~/.local/state/myna; one send per issue at a time
  newsletter status <id> [--watch]  Sent, failed, remaining, rate a minute, ETA, per
                                    variant, and whether a background send is running
  newsletter stats <id>             Per variant: sent, opens, clicks, CTR, unsubscribes
  newsletter subscribe <email...> --list <L> [--name] [--tags]
  newsletter unsubscribe <email|token> [--list L]   Without --list: opted out for good
  newsletter subscribers --list <L> | import <file.csv|.json> --list <L>
  newsletter sync | sync-optouts    Pull unsubscribes from myna cloud and crawlproof
  newsletter track connect <site>   Tracking from your CrawlProof project, on and saved
                                    in one step (needs myna crawlproof login)
  newsletter track set <id> [--secret hex] | track status [--check] | track off
                                    crawlproof tracking: signed links, open pixel,
                                    its unsubscribe link; the secret goes in the vault
  newsletter cta list | add "<label>" <url> | rm "<label>"   [--set default]
       myna config newsletter.address "..."        required (CAN-SPAM)
       myna config newsletter.unsubscribeUrl https://you/u/{token}   else myna cloud hosts it
       myna config newsletter.brand.name|logoUrl|url|accent|tagline  a name or logo (https PNG) turns on the branded layout
AT Protocol (the network behind Bluesky; a directory of its servers):
  atproto [q] [--kind pds|relay|feed|labeler] [--online]
                                    The directory at mynaposter.com/listing/atproto
  atproto add <url>                 List a server: probed first, shown as what it
       [--description] [--tags]     said about itself. Needs myna cloud login
  atproto probe <url>               What the directory would find, listing nothing
  atproto refresh <id> | rm <id>
  atproto signup <pds url>          Make an account there from your OpenProfile:
       [--handle x] [--email e]     the handle under the server's domain, your
       [--invite code] [--no-profile] email, a generated password in the vault,
                                    then the profile itself (name, headline, web, avatar)
  atproto profile [account]         Push your OpenProfile to a Bluesky profile
       [--dry-run]                   (any PDS), keeping what it does not describe
Hand-offs (the steps only a person can do: a Reddit comment, an HN submission):
  handoff add <place> --title "..."  A card: the text to paste (stdin or --from
       [--open <url>] [--step "..."]  <file>), the page to open, the steps.
       [--account x] [--local]       Published to mynaposter.com/handoff/<id> when
                                    signed in to myna cloud; the recap lists it
  handoff [list] [--all] | show <id> | done <id> | undo <id> | rm <id>

OpenConnection (an app you paste a token into, such as DefPromo, acts through myna):
  connect token [--scopes a,b]      A setup token to paste into the app: single
       [--minutes 15]               use, expires; the app claims it once
  connect apps [--all] [--json]     The apps holding a connection, and their scopes
  connect revoke <id>               Cut one off; its next call is refused

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

  upvote                            The queue: whose post, why it matched, and
                                    what myna will do about it
  upvote on | off                   Let the daemon search every 30 minutes and
                                    cast what is due
  upvote scan                       Search now for people posting about what
                                    you post about
  upvote send [--limit N] [--dry-run] [--network reddit]
                                    Cast what is due. --network names one that
                                    is manual only
  upvote topics                     What myna thinks you are about, and what it
                                    searches for
  upvote skip <id> | edit <id> "…"  Drop one, or change its reply before it goes
  upvote set <key> <value>          maxPerDay, gapMinutes, minScore, linkRatio,
                                    linkPerDay, repostRatio, networks, manualOnly
  upvote log                        What was cast

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
  outreachgraph push <account>      Hand who you follow (or --followers) to
       [--followers] [--limit N]     OutreachGraph for assessment + OpenProfile
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
  synconfig | syncfg                Your settings on every machine, through the
                                    cloud account: status here vs there
  synconfig save [--force]          Push settings.json, OpenProfile and skills
  synconfig load [--force|--dry-run] Pull them; a local edit stops it unless forced
  synconfig revisions | on | off    The last ten; let the daemon do it (default on)
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
  myna brand learn                   # the brand, from what you have already posted
  myna atomize https://example.com/blog/post --angles 12 --over 30d
  myna plan                          # the angles, dated, no copy yet
  myna autopilot on && myna run      # fill the gaps, never inside 24h

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
