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
  feed [network]                    Read a home timeline
  run                               Run the scheduler in the foreground

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

Flags:
  --to <spec>       Where to post: all, a network, an account id, comma separated
  --title <text>    Title for Reddit, Lemmy and blogs
  --media <path>    Attach a file. Repeatable
  --style <kind>    Infographic backend: svg, html or image
  --json            Machine-readable output
  --dry-run         Show what would be posted without sending
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
  myna infographic https://example.com/report --style html
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
  if (first === "tui") {
    const { flags } = parseFlags(argv.slice(1));
    await runTui({ theme: flags.theme as string | undefined });
    return;
  }

  process.exitCode = await runHeadless(first, argv.slice(1));
}

main().catch((error: Error) => {
  process.stderr.write(`myna: ${error.message}\n`);
  process.exitCode = 1;
});
