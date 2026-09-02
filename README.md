# myna

A terminal social media manager. One place to log in, write, schedule and post
to every network you use.

```bash
myna                                  # the TUI
myna login bluesky                    # connect an account
myna post all "the release notes are up"
echo "shipping today" | myna post bluesky,mastodon
```

Built on [HQTUI](https://hqtui.com). Credentials are encrypted on your own
machine and nothing is sent anywhere except the posts you make.

---

## What it does

- **Post once, everywhere.** Text is tailored per network: character limits,
  URL weighting, threads where they exist, truncation where they do not.
- **Schedule.** `myna schedule "tomorrow 9am"` queues a post; the scheduler
  sends it while the TUI is open, or run `myna run` as a daemon.
- **Read back.** Home timelines, mentions, per-post engagement, and a history of
  what landed and what failed.
- **Write, optionally.** Paste a link and get a drafted post with hashtags that
  suit each network. The writer never posts on its own; drafts land in the
  compose box for you to edit.
- **Infographics.** The model picks the copy, myna renders the graphic. Text on
  the image is exactly the text in the copy.

## Install

```bash
curl -fsSL https://mynaposter.com/install.sh | sh
```

A single binary with the runtime compiled in, for Linux, macOS and Windows.
Nothing else needs to be installed first.

The script checks the download against the published `SHA256SUMS` before it
writes anything, stages the binary beside the target and renames over it so a
running `myna` is never half-replaced, and picks the AVX2-free build on older
CPUs. `MYNA_BIN` chooses the directory, `MYNA_VERSION` pins a version. Read it
first if you would rather not pipe a script — it is at
[mynaposter.com/install.sh](https://mynaposter.com/install.sh), and the binaries
are on the [releases page](https://github.com/profullstack/mynaposter/releases)
if you want to verify them yourself.

Already have a package manager:

```bash
bun add -g @profullstack/myna     # or: npm i -g @profullstack/myna
```

That route needs Bun 1.1+ or Node 22.6+.

## Logging in

`/login <network>` asks for whatever that network actually accepts. This is the
part most tools are vague about, so to be plain:

| How you log in | Networks |
|---|---|
| **Real username and password** | Bluesky (app password), Mastodon, Pleroma, Akkoma, GoToSocial, Lemmy, Matrix, Mattermost, WordPress (application password), Reddit (script app) |
| **A token you paste** | Telegram, Discord, Slack, Misskey, Nostr, dev.to, Hashnode, Ghost, Micro.blog |
| **Approving a short code** | tsbb (device flow: the board shows a code, you approve it in a browser) |
| **App keys** | Tumblr |
| **Browser sign-in (OAuth)** | X, Facebook, Instagram, Threads, LinkedIn, Pinterest, TikTok |

The last row is not a limitation of myna. X, Meta and LinkedIn removed password
APIs years ago, and scraping a login session is both against their terms and
fragile enough to break without warning. For those, myna registers your own app
and does a normal OAuth round trip through your browser.

Two more things worth knowing before you plan a posting workflow:

- **Facebook and Instagram cannot post to a personal profile at all.** Facebook
  needs a Page you administer; Instagram needs a Business or Creator account
  linked to one, and its API will only fetch images from a public URL.
- **Reddit script apps do not work on accounts with 2FA**, and Mastodon's
  password grant is refused by instances with 2FA. Both fall back to a token.

## Supported networks

26 in total.

**Major** X, Facebook, Instagram, Threads, Bluesky, Reddit, LinkedIn, Pinterest,
TikTok
**Fediverse and self-hosted** Mastodon (and Pleroma, Akkoma, GoToSocial),
Misskey (and Sharkey, Firefish), Pixelfed, Lemmy, Nostr, tsbb
**Chat** Telegram, Discord, Slack, Matrix, Mattermost
**Long-form** dev.to, Hashnode, Ghost, WordPress, Micro.blog, Tumblr

`myna networks` prints the current list with each one's login method and limit.

## The TUI

```
  compose    accounts    queue    history    feed    networks    help      all 4

╭─ Compose ─────────────────────────────────────────╮ ╭─ Goes to ──────────────╮
│ myna is a terminal social media manager. One      │ │ bluesky:alice   139/300│
│ command posts to every account you own.           │ │ mastodon:@alice 139/500│
│                                                   │ │ x:@alice        140/280│
│ https://mynaposter.com                            │ │ reddit:u/alice 139/4000│
╰───────────────────────────────────────────────────╯ ╰────────────────────────╯

╭─ Command ──────────────────────────────────────────────────────────────────────╮
│  /link https://example.com/post                                                │
╰────────────────────────────────────────────────────────────────────────────────╯
 myna  / for commands    Enter to edit the post    Ctrl+S to send      accounts 4
```

The right pane counts each network as that network counts, so `x` reads 140 while
the others read 139: X bills every URL at 23 characters regardless of length.

**Keys.** `/` command bar, `Enter` edit the post, `Ctrl+S` send, `Ctrl+T` pick
targets, `Esc` back, `Tab` complete, `1`–`7` switch screen, `Ctrl+C` quit.

## Commands

Every slash command in the TUI is also a subcommand, so anything you can do by
hand you can put in a script.

```bash
myna login <network>              myna post [target] [text]
myna logout <account>             myna schedule "in 2h" "text"
myna accounts                     myna queue / cancel <id>
myna networks                     myna history
myna feed [network]               myna delete <account> <id>
myna draft "<topic>"              myna link <url>
myna infographic <url|topic>      myna run
myna config [key] [value]         myna doctor
```

Flags: `--to`, `--title`, `--media`, `--style`, `--json`, `--dry-run`,
`--no-thread`.

`--json` on any read command gives machine output, so `myna accounts --json | jq`
works the way you would expect.

## The writer

Off unless you configure it. It drafts; you decide.

```bash
myna config ai.provider anthropic          # or openai, or ollama
myna config ai.voice "Plain, specific, no hype."
myna link https://example.com/post --to all
```

Anthropic is the default and uses `ANTHROPIC_API_KEY`. OpenAI uses
`OPENAI_API_KEY`. Ollama needs no key and talks to `OLLAMA_HOST`.

## Infographics

```bash
myna infographic https://example.com/report --style html
myna post all --media /tmp/.../infographic.png "the numbers are in"
```

Three backends:

- `svg` renders a built-in template. Offline, no AI, exact text.
- `html` has the model write HTML and CSS, then screenshots it. Real text,
  better design.
- `image` hands the whole thing to an image model. Good for illustration, and
  the only one where the text can come out wrong.

The first two exist because image models rewrite words on the way through:
invented figures, misspelled names, quotes nobody said. Letting the model choose
the copy and rendering it ourselves removes that failure entirely.

Rendering to PNG needs one of Chrome/Chromium, `rsvg-convert`, ImageMagick or
Inkscape. myna finds browsers that Playwright or Puppeteer already downloaded.
`myna doctor` reports what it found.


## Moving between machines

```bash
myna save ~/myna.myna        # on the laptop
scp ~/myna.myna server:      # however you like
myna load ~/myna.myna        # on the server
```

A bundle holds the connected accounts, the pending queue and the settings. It is
**always encrypted with a passphrase you type**, never with the local keyfile:
the keyfile is machine-specific so a bundle sealed with it could not be opened
anywhere else, and the file holds a live token for every account you have. There
is no plaintext option for that reason.

`load` is additive and shows you the effect before causing it. An account that
already exists here is **kept, not replaced**, unless you pass `--overwrite` —
tokens get refreshed in place, so a bundle taken last week can carry one that has
since been rotated, and silently clobbering a working account with a stale token
is the failure that would be hardest to notice.

## Beyond the terminal

myna is one core with four faces. An account connected in any of them works in
all of them, because they read the same vault.

| | |
|---|---|
| `apps/cli` | The TUI and the scriptable CLI |
| `apps/desktop` | An Electron app, same core |
| `apps/api` | An HTTP API for scripts and cron |
| `packages/mcp` | An MCP server, so an agent can post for you |

### HTTP API

```bash
export MYNA_API_TOKEN=$(openssl rand -hex 32)
bun apps/api/src/server.ts

curl localhost:8787/v1/networks
curl -X POST localhost:8787/v1/post \
  -H "authorization: Bearer $MYNA_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"text":"shipping today","to":"all"}'
```

Reads are open when no token is set; writes are refused outright rather than
left unauthenticated. `DATABASE_URL` decides the shape: unset means single-user
against `~/.config/myna`, set means the hosted Postgres schema in
`apps/api/src/db/schema.sql`.

Postgres runs in a container you control, not a managed add-on:

```bash
docker compose up -d postgres
export DATABASE_URL=postgres://myna:myna@127.0.0.1:5432/myna
bun run db:migrate
```

### MCP

```json
{ "mcpServers": { "myna": { "command": "bunx", "args": ["@profullstack/myna-mcp"] } } }
```

Ten tools: `myna_accounts`, `myna_networks`, `myna_preview`, `myna_post`,
`myna_schedule`, `myna_queue`, `myna_cancel`, `myna_history`, `myna_draft`,
`myna_timeline`.

There is deliberately no login tool. Connecting an account means typing a
password or completing a browser flow, and that belongs to a person. `myna_post`
publishes immediately and cannot be undone on every network, which its
description says plainly; `myna_preview` is there to check the targets and the
per-network tailoring first.

### Deploying

`.railway/railway.ts` defines the two deployable services. One thing to know
before editing it: the file is declarative for the **whole** Railway project, so
without `export const partial` it plans to delete every service it does not
mention. Run `railway config plan` and read the destroy count before applying.

## Where things are kept

```
~/.config/myna/
  vault.json      accounts and credentials, AES-256-GCM
  vault.key       the key, when not using a passphrase (0600)
  queue.json      scheduled posts
  history.json    what was sent
  settings.json   preferences
```

The vault is encrypted with a local keyfile by default, so myna does not ask for
a master password on every launch. To use a passphrase instead:

```bash
MYNA_PASSPHRASE="…" myna doctor
```

Set `MYNA_HOME` to keep everything somewhere else.

## Development

```bash
bun install
bun run cli          # the TUI from source
bun test             # 50 tests
bun run typecheck
```

The Nostr signing is BIP340 Schnorr implemented over BigInt, because `node:crypto`
exposes no Schnorr primitive. It is checked against the BIP340 reference vectors
in `packages/core/test/schnorr.test.ts`.

```
packages/core     adapters, vault, scheduling, the writer, infographics
apps/cli          the TUI and the scriptable CLI
```

## Licence

MIT
