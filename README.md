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
bun add -g @profullstack/myna     # or: npm i -g @profullstack/myna
```

Needs Bun 1.1+ or Node 22.6+.

## Logging in

`/login <network>` asks for whatever that network actually accepts. This is the
part most tools are vague about, so to be plain:

| How you log in | Networks |
|---|---|
| **Real username and password** | Bluesky (app password), Mastodon, Pleroma, Akkoma, GoToSocial, Lemmy, Matrix, Mattermost, WordPress (application password), Reddit (script app) |
| **A token you paste** | Telegram, Discord, Slack, Misskey, Nostr, dev.to, Hashnode, Ghost, Micro.blog |
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

25 in total.

**Major** X, Facebook, Instagram, Threads, Bluesky, Reddit, LinkedIn, Pinterest,
TikTok
**Fediverse** Mastodon (and Pleroma, Akkoma, GoToSocial), Misskey (and Sharkey,
Firefish), Pixelfed, Lemmy, Nostr
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
