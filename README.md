<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/assets/brand/myna-logo-dark.svg">
    <img alt="myna" src="apps/web/assets/brand/myna-logo-light.svg" width="356" height="128">
  </picture>
</p>

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
- **See how it did.** A performance screen with volume over time, delivery rate,
  per-network breakdown, the hours you actually post, and your best posts.
- **Write, optionally.** Paste a link and get a drafted post with hashtags that
  suit each network. The writer never posts on its own; drafts land in the
  compose box for you to edit.
- **Infographics.** The model picks the copy, myna renders the graphic. Text on
  the image is exactly the text in the copy.
- **Grow the right audience.** Seed a follow graph with people worth learning
  from, let myna read who *they* follow, and follow the accounts they agree
  on, a few an hour, from `myna run`. See [The follow graph](#the-follow-graph).
- **List the product itself.** `myna directory saasrow <url>` reads the page and
  submits it to a software directory over that directory's MCP server — any MCP
  server, including one myna has never heard of, since it reads the server's own
  tool schemas to work out the fields. A listing is not a post, so it has its own
  command and its own credentials. See [Directories](#directories).
- **Plugins.** A plugin can add a network, a command, a daemon task or a source
  of people to follow. The bundled one pulls seeds from
  [OutreachGraph](https://outreachgraph.com). See [Plugins](#plugins).

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

### Updating

```bash
myna update           # replace this binary with the newest release
myna update --check   # only say whether one is waiting
```

`update` does what the installer does, from inside myna: it picks the asset this
machine can run (including the AVX2-free build on older CPUs), checks it against
the published `SHA256SUMS`, and renames it over the running binary rather than
writing into it, so a failed download leaves the working copy untouched.

`--check` exits 1 when an update is waiting, which is the answer a cron job
wants. `--version <x.y.z>` installs a specific release, up or down, and
`--force` reinstalls the one you already have.

A myna running from a checkout or a global `bun`/`npm` install has no binary to
replace, so `update` says which release is newest and how to update the way it
was installed, instead of overwriting Bun.

## Logging in

`/login <network>` asks for whatever that network actually accepts. This is the
part most tools are vague about, so to be plain:

| How you log in | Networks |
|---|---|
| **Real username and password** | Bluesky (app password), Lemmy, Matrix, Mattermost, WordPress (application password), Reddit (script app) |
| **A token you paste** | Telegram, Discord, Slack, Misskey, Nostr, dev.to, Hashnode, Ghost, Micro.blog |
| **Approving a short code** | tsbb, agenticjobs (device flow: the board shows a code, you approve it in a browser) |
| **Nothing — files on this machine** | Git blog (a repository, committed through GitHub with your token or `gh`), HTML blog (a directory of pages) |
| **One click in a browser, no setup** | Mastodon, Pleroma, Akkoma, GoToSocial, Pixelfed. myna registers itself on the instance and opens an Authorize page. Nothing to type but the instance, and no developer account anywhere |
| **App keys** | Tumblr |
| **Browser sign-in (OAuth)** | X, Facebook, Instagram, Threads, LinkedIn, Pinterest, TikTok, YouTube |

Two of those rows are browser sign-ins for opposite reasons. Mastodon and its
relatives let *any* client register itself, so the browser flow needs no setup
at all: you type the instance and click Authorize. X, Meta, LinkedIn, Pinterest,
TikTok and YouTube require you to register an app on their developer portal first,
because they removed password APIs years ago and scraping a login session is
both against their terms and fragile enough to break without warning.

Anything a login would ask for can be given on the command line instead, in the
order the network declares its fields or as `--<field>`, and what you pass is
never asked for again:

```sh
myna login tsbb https://bbs.hqtui.com/ --forum app-showcase
myna login tsbb https://bbs.hqtui.com/ app-showcase        # same thing, positionally
```

That makes a login scriptable, and outside a terminal a missing required field
is an error naming the flag rather than a prompt nobody can answer. `/login tsbb
https://bbs.hqtui.com/` does the same in the TUI: the dialog opens with the
board filled in and the cursor on the first empty box.

**A board is a set of forums, so tsbb takes several and cycles through them.**
Login reads the board's forum list, and either takes the slugs you name or asks
which ones, checking them against the board before it asks anyone to approve a
code:

```sh
myna login tsbb https://bbs.hqtui.com/ --forum app-showcase,announcements,news
```

Each post then goes to the *next* forum in that list rather than to all of them
at once, which is what a board would read as spam. `myna post --forum <slug>` is
a detour for one post and leaves the rotation where it stands.

**Mastodon no longer accepts a password at all.** `grant_type=password` was
removed; a current server answers `unsupported_grant_type`. myna used to offer
the field and produced a confusing failure, so it does not any more.

Two more things worth knowing before you plan a posting workflow:

- **Facebook and Instagram cannot post to a personal profile at all.** Facebook
  needs a Page you administer; Instagram needs a Business or Creator account
  linked to one, and its API will only fetch images from a public URL.
- **Reddit script apps do not work on accounts with 2FA**, and Mastodon's
  password grant is refused by instances with 2FA. Both fall back to a token.

## Supported networks

30 in total.

**Major** X, Facebook, Instagram, Threads, Bluesky, Reddit, LinkedIn, Pinterest,
TikTok, YouTube
**Fediverse and self-hosted** Mastodon (and Pleroma, Akkoma, GoToSocial),
Misskey (and Sharkey, Firefish), Pixelfed, Lemmy, Nostr, tsbb, agenticjobs
**Chat** Telegram, Discord, Slack, Matrix, Mattermost
**Long-form** dev.to, Hashnode, Ghost, WordPress, Micro.blog, Tumblr (named in `--to`, never part of `all`)
**Your own blogs** Git blog, HTML blog
**Your calendar** Google Calendar (an event is a post; see [Calendar](#calendar-what-myna-is-going-to-say-on-the-calendar-you-already-look-at))

`myna networks` prints the current list with each one's login method and limit.

### The job board

[agenticjobs](https://agenticjobs.work) holds two different things and myna
treats them as two different things.

A **job opening** is a publication, and stays where it was: `myna jobs post
opening.md`, named explicitly, never part of a fan-out. A status update turning
into a job opening at your company is not something you can delete your way out
of.

An **update** is a status post — a role filled, something shipped, who is free
next — and that is what the `agenticjobs` network posts. It goes out with the
rest of them.

```bash
myna login agenticjobs agenticjobs.work --org acme   # device flow; --org is optional
myna post "shipped resume downloads" --to all        # the board is included
myna post --to agenticjobs "we closed the backend role https://acme.dev/blog"
myna follow agenticjobs acme                         # or candidate:ada, or a page URL
```

Leave `--org` off and you post as yourself, which the board only allows if you
have published a resume there, so an update always has a page behind it. A
trailing URL moves into the board's own link field rather than being printed
twice, since the board renders the link under the body. 600 characters, five a
day, and the same text twice is refused.

myna will not tell you who somebody else follows on that board. It is a job
board: that list is which employers a person is looking at.

### Your own blogs

Two networks cover nearly every blog that is not a CMS, and both take the
post as Markdown:

- **Git blog** (`gitblog`) — a repository where a post is one Markdown file
  with frontmatter (`content/blog/<slug>.md`, the Next.js, Astro and Hugo
  shape). myna commits the file through the GitHub API, so no checkout is
  needed and the site's own deploy publishes it. The token is optional:
  `GH_TOKEN` or `gh auth token` is used when none is stored.
- **HTML blog** (`htmlblog`) — a directory of plain pages where writing the
  file is publishing. myna writes the next `NNN-post.html`, lists it in
  `index.html`, runs the blog's `build-feed.mjs`, and pushes a mirror
  repository if you name one. When
  [cli-tools](https://github.com/profullstack/cli-tools)' `blog-post` is on
  the PATH the page is written by it, byline and analytics tags included.

```bash
myna login gitblog                 # repo, posts directory, branch, where posts appear
myna login htmlblog                # directory, public URL, optional mirror checkout
myna post --to gitblog "Release 1.2

The first paragraph is the description.

## What changed
..." --title "Release 1.2" --tags "release, cli"
myna post --to htmlblog --description "One line for the feed" < post.md
```

Both are **never part of `all`**, and neither is any long-form network (dev.to,
Hashnode, Ghost, WordPress, Micro.blog, Tumblr). A social post fanned out by
accident is an embarrassment; an article fanned out by accident is a
publication (and on your own blog, a commit), so those only post when named in
`--to`. One post can name several: `--to htmlblog,devto` writes the page and
the article from the same Markdown. Per-post flags: `--slug`,
`--description`, `--tags`, `--date` (the future is refused), `--draft true`,
`--author`, `--canonical-url`, and `--overwrite true` for a Git blog.

#### Which copy is the original

`--to htmlblog,devto` publishes the same article twice, so one of them has to
be the original or search engines pick for you. `--canonical-url` says which:

```sh
myna post --to devto --title "Release 1.2" \
  --canonical-url https://example.com/blog/042-post.html < post.md
```

It is honored wherever the network has a field for it, and the field is
different every time:

| network | what it sends |
| --- | --- |
| dev.to | `canonical_url` |
| Hashnode | `originalArticleURL` |
| Ghost | `canonical_url` |
| Tumblr | `source_url`, the attribution link it has instead |
| gitblog | `canonical:` in the post's frontmatter, for the site template to render |
| htmlblog | `<link rel="canonical">` in the page head |

WordPress and Micro.blog are left out on purpose. WordPress core has no
canonical field (it belongs to an SEO plugin's post meta) and Micropub defines
no canonical property, so neither pretends to support one.

**htmlblog points at itself** without being asked, using the `siteUrl` you
logged in with, because the original should confirm what the copies claim.
Pass `--canonical-url` only when the original really is elsewhere. When
profullstack/cli-tools' `blog-post` writes the page, it applies its own
`siteUrl` and myna forwards the flag only when you set one — that needs
cli-tools 0.28.0 or newer.

### YouTube: search, then comment

YouTube has no timeline to post into. What it has is videos, and under each
one a comment thread, so on YouTube a "post" is a comment on a video you name.
The useful loop is to search for videos on your subject and comment where the
conversation already is:

```bash
myna search youtube "terminal social media manager"
myna post youtube "If you want this from a terminal, myna does it: https://mynaposter.com" --video dQw4w9WgXcQ
myna post youtube "Thanks, fixed in 0.4" --reply-to UgzQK7s8m1Xf3kR9pL54AaABAg
myna post youtube "Release walkthrough" --media walkthrough.mp4 --privacy unlisted
```

`--video` takes an id or any YouTube link. `myna search` lists the id, channel
and link for each hit, and `--json` gives the same for a script. A plain
`myna post youtube` with no video and no video file is an error, on purpose:
there is nothing on YouTube it could sensibly go to.

Two things to know. Uploads from an app that has not passed Google's
verification are forced to private, which is Google's rule, not myna's. And
YouTube filters repeated identical comments as spam, so write for the video
you are commenting on rather than pasting one line everywhere: a comment that
answers what the video is about, with your link, lands. The same one pasted
under twenty videos disappears.

## The TUI

```
  compose  accounts  directories  queue  history  feed  networks  help    all 4

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

**Keys.** `/` command bar, `Enter` edit the post, `Ctrl+S` or `F2` send, `Ctrl+T` pick
targets, `Esc` back, `Tab` next tab (or complete a half-typed command), `Shift+Tab`
previous tab, `1`–`9` switch screen, `Ctrl+C` quit. Pasting works in every field.

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
myna keys                         myna repost <account> <post url>
myna search [network] <query>     myna follow <account> <handle>
myna following <account> [handle] myna graph <subcommand>
myna plugins [add|remove]         myna outreachgraph <subcommand>
myna crawlproof <subcommand>      myna calendar <subcommand>
myna directory <id> <url>         myna directory listings [id]
```

Flags: `--to`, `--title`, `--media`, `--style`, `--json`, `--dry-run`,
`--no-thread`, `--limit`, `--force`. Any other `--flag value` is handed to the
network as an option: `--video` and `--reply-to` for YouTube, `--subreddit` for
Reddit, `--privacy` for an upload.

`--json` on any read command gives machine output, so `myna accounts --json | jq`
works the way you would expect.

## The follow graph

Following someone's *followers* is noise: anyone can follow an account, and
most who do are bots, fans and the idle. Following who they *follow* is the
opposite. It is a list a person you already trust curates by hand, and when
several of those people follow the same account, that account is the one to
follow first. That is the whole idea:

```
seeds  ──who they follow──▶  candidates  ──ranked, a few an hour──▶  follows
```

```bash
myna graph seed bluesky jay.bsky.team pfrazee.com --weight 2   # people worth learning from
myna graph seed mastodon Gargron@mastodon.social
myna graph expand                       # read who each seed follows
myna graph candidates                   # best first: score, how many seeds, who
myna graph follow --limit 5 --dry-run   # what would go out
myna graph follow --limit 5             # send them
myna graph on && myna run               # or let the daemon do it, 10 an hour
```

A candidate's score is the summed weight of the seeds who follow them, so a
person three seeds all follow outranks a person one seed follows, and a seed
with `--weight 2` counts double. The seeds themselves are candidates too. Your
own accounts never are, and neither is anyone you have already followed, marked
with `myna graph skip`, or failed to follow three times.

The daemon follows at most `graph.followsPerHour` (10) and `graph.followsPerDay`
(80) per account, spread evenly across the hour rather than in a burst, which
is what gets a new account flagged. Every attempt counts against the ceiling,
successful or not. `myna graph status` shows the budget each account has left;
`myna config graph.followsPerHour 5` changes it. `graph.networks` restricts
the daemon to some networks (`bluesky,mastodon`), and `graph.minSeeds 2` means
nobody is followed on one seed's word alone.

Two direct commands sit under the graph: `myna following <account> [handle]`
lists who anyone follows (yours by default), and `myna follow <account> <handle>`
follows one person now.

Works on Bluesky, Mastodon and its relatives, Misskey, X and Nostr. Two
caveats. **X reads following lists only on the Basic tier and above**; on a
free app the request answers 403, and an account signed in before this
release needs `myna login x` again so its token carries the `follows` scopes.
**Nostr refuses to follow from an account with no contact list on its
relays**: a follow is a new kind 3 event that replaces the old one everywhere,
so myna will only extend a list it can find, never publish one that would wipe
what another client wrote. Follow one person from any other Nostr client first.

## Directories

Posting tells people about the product. A directory lists the product itself,
which is a different thing: a name, a website, a description and a category,
reviewed by somebody and then indexed by search engines and assistants. myna
does both, and keeps them apart.

```bash
myna directory                            # what myna can submit to
myna directory login saasrow              # emails you a one-time code
myna directory saasrow https://example.com --dry-run
myna directory saasrow https://example.com
myna directory listings                   # yours, and where each one stands
```

Give it a URL and myna reads the page, works out the name, writes the
description and picks the category and vocabulary terms the directory accepts.
Anything it got wrong is a flag: `--name`, `--description`, `--category`,
`--tags a,b`, `--platforms cli,web`, `--pricing free`. `--dry-run` prints the
listing and sends nothing, which is worth doing first — a submission is public
and a person reads it.

Without a writing model configured, the listing falls back to the page's own
metadata. That is worse than a written one and still usually good enough;
`--no-ai` asks for it deliberately.

**How it talks to the directory.** Listings go over the directory's MCP server:
the tool schemas describe the fields, so a directory that adds one needs no
release here. Signing in is the exception and goes over its REST API, because
the emailed code is a conversation with a person rather than something a tool
call can carry. The API key it hands back is kept in myna's encrypted vault,
apart from your posting accounts — deliberately, so that `--to all` can never
turn a stray thought into a product submission.

**Any MCP server, not just the ones myna ships.** `myna directory catalog` lists
the endpoints myna knows; anything else is a URL:

```bash
myna directory add acme https://acme.example/api/mcp
myna directory login acme          # paste the key that directory issued you
myna directory acme https://example.com
myna directory tools acme          # what that server actually offers
myna directory drop acme
```

Nothing is hard-coded about the second one. myna reads the server's tool table,
picks out the tool that creates a listing whatever it is called, and sends your
fields under whatever names *that tool's schema* uses — a directory whose field
is `product_url` rather than `website` needs no code here. A field the server
marks required and myna could not work out fails before the call rather than
after it. What a custom directory cannot do is sign you in: there is no MCP
method for that, so it takes a key you already have.

[SaaSRow](https://saasrow.com) has a written adapter for one reason: its sign-in
is an emailed code, which is a conversation with a person rather than a tool
call. A plugin can add a directory too, with `directories: [...]`, exactly as it
adds a network.

The same thing is on every surface: `/directory` in the TUI, a Directories
screen in the desktop app, and `myna_directories`, `myna_directory_preview`,
`myna_directory_submit` and `myna_directory_listings` over [MCP](#mcp).

## Plugins

A plugin is an ES module whose default export describes what it adds:
networks, commands, daemon tasks, sources of seeds for the follow graph, and
hooks: `afterPost` hears about every post once it is out, `afterSchedule` and
`afterCancel` about every queue entry as it is made and removed. The bundled
`outreachgraph`, `crawlproof` and `calendar` plugins are the references; read
[docs/plugins.md](docs/plugins.md) to write one.

```bash
myna plugins                                 # what is loaded, and what each adds
myna plugins add @someone/myna-plugin-foo    # from npm, into ~/.config/myna/plugins
myna plugins add ./my-plugin                 # or a directory on disk
myna plugins remove foo
```

Plugin commands run as `myna <command>`; plugin tasks run inside `myna run`;
a plugin's secrets live in the same encrypted vault as your accounts.

### OutreachGraph: influencers as seeds

[OutreachGraph](https://outreachgraph.com) finds the people who matter for
what you sell and ranks them by opportunity. The bundled plugin pulls that
list, keeps the ones with a Bluesky, Mastodon, X, Nostr or Misskey identity,
and hands them to the graph as seeds, weighted by their score. The graph then
does the rest: reads who those people follow, and follows the accounts they
agree on.

```bash
myna outreachgraph login       # email + password, stored in the vault
myna outreachgraph people      # the ranked list, with the handles myna can use
myna outreachgraph sync        # pull them in as seeds now
myna graph on && myna run      # the daemon re-syncs every six hours
```

### CrawlProof: an ad for every blog post

[CrawlProof](https://crawlproof.com) runs an ad network across the sites that
carry its slots. The bundled plugin turns a blog post into a campaign the
moment it is published: after `myna post` lands a page on a Git blog or an
HTML blog, the page's URL goes to CrawlProof, which reads it, writes the
creatives and starts serving. Social posts do not get a campaign of their
own; `--ad true` on any post runs one for the first URL in it.

```bash
myna crawlproof login                 # paste an API token from Social → API tokens
myna post --to htmlblog < post.md     # …and the new page gets a campaign
myna crawlproof ad https://example.com/launch --budget 300
myna crawlproof ads                   # campaigns, newest first
myna crawlproof ads show crawlproof-ad-144      # delivery, and the visits it sent
myna crawlproof ads pause crawlproof-ad-144     # or resume, budget <cents>, delete --yes
myna crawlproof auto off              # stop the automatic ones
```

### Calendar: what myna is going to say, on the calendar you already look at

The bundled `calendar` plugin brings Google Calendar in as a network, `gcal`,
and mirrors the queue onto it. Every post that goes through `myna schedule`
gets an event at the moment it is due, with the text and the targets in the
description; `myna cancel` takes the event away again. An event is also just a
post to `gcal`, which is never part of `all`.

```bash
myna login gcal                       # a Google Cloud OAuth client with the Calendar API enabled
myna schedule "2027-04-01 9am" "…"    # queued, and on the calendar
myna calendar list --days 30          # what is coming up
myna calendar add "tomorrow 9am" "Standup" --duration 30m --location "Room 1"
myna post --to gcal --at "friday 3pm" --title "Release review" "Agenda inside"
myna feed gcal                        # the next events, as a timeline
myna calendar calendars               # which calendars the account can write to
myna calendar auto off                # stop mirroring the queue
```

Google is the first provider; the network is `gcal` so another calendar can be
another network in the same plugin. While the OAuth client's consent screen is
in testing, Google expires the sign-in after seven days; publish the consent
screen and the sign-in is permanent.

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

## Cloud backup, if you want it

Optional. myna never contacts a server unless you run a `cloud` command.

```bash
myna cloud signup you@example.com
myna cloud push        # encrypts here, then uploads
myna cloud pull        # on the other machine
```

What goes up is the same bundle `save` writes: **sealed on your machine with a
passphrase that never leaves it.** The server stores ciphertext it cannot read
and refuses to store anything that is not already sealed. That is the only
arrangement under which keeping tokens for 26 social networks on somebody
else's computer is a reasonable thing to do — a full compromise of the server
yields nothing.

Sign-in is email and password. The house pattern is magic link and passkey, with
an optional password for devices those cannot reach; a terminal has no mail
client to open a link in and no authenticator to hold a passkey, which is that
exception exactly.

Self-host it by pointing `MYNA_SERVER` at your own instance.

## Beyond the terminal

myna is one core with four faces. An account connected in any of them works in
all of them, because they read the same vault.

| | |
|---|---|
| `apps/cli` | The TUI and the scriptable CLI |
| `apps/desktop` | An Electron app, same core |
| `apps/api` | An HTTP API for scripts and cron |
| `packages/mcp` | An MCP server, so an agent can post for you |

myna is also an MCP *client*, in one place: a software directory that accepts
listings over MCP is submitted to that way. See [Directories](#directories).

### Several accounts on one network

Accounts are keyed by `network:handle`, so as many as you like can coexist:

```bash
myna post bluesky "goes to every Bluesky account"
myna post bluesky:work.bsky.social "just the work one"
myna post bluesky,mastodon:@me@example.com "mix and match"
```

Naming a network and one of its accounts together still posts once to each.

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

Fifteen tools: `myna_accounts`, `myna_networks`, `myna_preview`, `myna_post`,
`myna_schedule`, `myna_queue`, `myna_cancel`, `myna_history`, `myna_draft`,
`myna_timeline`, `myna_search`, and for [directories](#directories)
`myna_directories`, `myna_directory_preview`, `myna_directory_submit` and
`myna_directory_listings`.

There is deliberately no login tool, for a network or a directory. Connecting
one means typing a password, completing a browser flow or reading a code out of
an email, and that belongs to a person. `myna_post` publishes immediately and
cannot be undone on every network, which its description says plainly;
`myna_preview` is there to check the targets and the per-network tailoring
first, and `myna_directory_preview` does the same for a listing.

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
  graph.json      follow graph: seeds, candidates, and every follow sent
  settings.json   preferences
  plugins/        plugins installed with `myna plugins add`
```

Plugin secrets (an OutreachGraph login, say) are inside `vault.json` beside the
accounts, not in settings.json.

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
bun test             # unit tests; no database needed
bun run typecheck
```

The cloud tests need a real Postgres and skip themselves without one:

```bash
bun run db:up
export DATABASE_URL=postgres://myna:myna@127.0.0.1:5432/myna?sslmode=disable
bun apps/api/src/db/migrate.ts
bun test apps/api/test
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
