# Skills: the rules for every place myna posts to

A skill is a Markdown file with YAML frontmatter, the shape an agent loads as a
skill. myna keeps one per network and one or more per account, under the config
dir, and reads them itself: the frontmatter carries limits the scheduler
enforces, and the body is what a person or an agent reads before posting.

This exists because a blog went spammy. The same release was announced three
times, every bug fix became a post, and 29 pages went up in one day. The blog
skill says four a day and major features only, and myna holds the fifth post
to the next day rather than sending it.

## Where the files are

```
~/.config/myna/skills/
  htmlblog/
    skill.md                                  the network's rules
    dev.profullstack.com-~anthony-blog/
      skill.md                                this account's rules (the default)
      launch-week.md                          another skill to pin or rotate to
  bluesky/
    skill.md
    chovyfu.bsky.social/
      skill.md
```

The account directory is the handle as one path segment: `/`, `\`, `:` and
spaces become `-`, and a leading `@` is dropped. `myna skill path <account>`
prints the exact path, and `myna skill list` prints the segment.

## Three layers

1. **The built-in template**, one per kind of network, in
   `packages/core/src/core/skills.ts`. Never on disk; it is what the files are
   generated from.
2. **The network skill**, `skills/<network>/skill.md`. One per network however
   many accounts are on it. Materialised from the template the first time the
   network is seen and yours to edit from then on.
3. **The account skills**, `skills/<network>/<account>/*.md`. `skill.md` is
   the generated default; anything else beside it was added with
   `myna skill add`.

A post to an account resolves the account's selected skill, which inherits
from the network skill, which inherits from the template. The body an agent
reads is the account skill followed by the network skill. Limits merge with
the stricter value winning.

myna writes a file only when it is absent. A file you have edited is never
overwritten; `myna skill init --force` is the one way to regenerate from the
templates, and it says so.

## The frontmatter

```yaml
---
name: myna-htmlblog
description: "How myna posts to HTML blog: what belongs there, how often, and the house style."
kind: blog
network: htmlblog
maxPerDay: 4
minGapMinutes: 60
requiresCanonical: false
contentPolicy: major-features-only
generatedFrom: blog@1
---
```

| Key | Type | What myna does with it |
|---|---|---|
| `name`, `description` | string | The skill's identity, for an agent's skill loader. |
| `kind` | `blog`, `social`, `forum`, `longform`, `directory`, `youtube`, `other` | Which template it came from. |
| `network`, `account` | string | Which network and account the file belongs to. Account files also carry `profileUrl` and `connectedAt` when known. |
| `maxPerDay` | number | Posts to this account in any rolling 24 hours. The scheduler holds a post past the cap to the moment the day's oldest post drops out of the window. |
| `minGapMinutes` | number | Least minutes between two posts to this account. Widens the global `myna pace --gap` when larger; never narrows it. Omitted where the global gap should rule. |
| `maxChars` | number | Characters in one post. Informational for the network's own limit; the social templates name it so an agent sees 300 for Bluesky, 500 for Mastodon, 3000 for LinkedIn, 280 for X. |
| `requiresCanonical` | boolean | True on the longform mirrors (dev.to, Hashnode, Ghost, WordPress, Tumblr): an agent must pass `--canonical-url` pointing at our own page. |
| `contentPolicy` | string | `major-features-only` on a blog. Free text elsewhere. The most specific layer that names one wins. |
| `generatedFrom` | string | The template and version the file was written from. |

Anything else you add to the frontmatter is kept as written.

### How limits merge

For each key, the layers that name a value are compared and the stricter one
wins: the lower `maxPerDay`, the larger `minGapMinutes`, the lower `maxChars`,
`requiresCanonical` true if any layer says so. A value in any file beats the
template, so a blog file that says `maxPerDay: 6` means 6; between files the
tighter one holds, so a network skill at 2 caps an account skill at 6 to 2.

`blog.maxPerDay` in `settings.json` stands in for the blog template's default
when no file names a value. A value in a skill file always wins over it.

A rotated skill is merged on top of the account's default skill the same way,
so it can tighten the cap and never loosen it.

## The templates

**blog** (`gitblog`, `htmlblog`): `maxPerDay: 4`, `contentPolicy:
major-features-only`. Major feature announcements and launches only; no
bug-fix stories, no small updates, no re-sends; one post may bundle several
related features; the blog is the canonical original and every mirror points
at it; house style (no em dashes, no LLM tells, concrete details, a real
title); what belongs on the blog versus the socials.

**social** (Bluesky, Mastodon, LinkedIn, X, Facebook, Threads, the chat
networks): the network's character cap, URL last, one post per launch, reposts
spaced by the pacing settings, no hashtag spam. `maxPerDay: 12`, which is what
a two-hour gap already allows, so nothing already queued moves.

**forum** (tsbb, Reddit, Lemmy): forum cycling, a real headline in the first
sentence, reply etiquette, one topic per release. `maxPerDay: 8`.

**longform** (dev.to, Hashnode, Ghost, WordPress, Micro.blog, Tumblr): a mirror
of a blog post, never an original; always `--canonical-url`. `maxPerDay: 4`,
`requiresCanonical: true`.

**directory** (SaaSRow and any MCP directory): one listing per product,
updated rather than resubmitted. `maxPerDay: 1`.

**youtube**: a post is a comment on a video found with `myna search`; short,
on topic, never the same comment on several videos. `maxChars: 500`.

## More than one skill per account, and rotation

```bash
myna skill add bluesky:chovyfu.bsky.social launch-week --from launch-week.md
echo "Say less." | myna skill add bluesky:chovyfu.bsky.social quiet
myna skill default bluesky:chovyfu.bsky.social quiet      # pin one
myna skill rotate bluesky:chovyfu.bsky.social on          # or take turns
myna skill remove bluesky:chovyfu.bsky.social quiet
```

With rotation on, each send takes the next skill in order after the one used
last (the default first, then the rest alphabetically). The cursor lives in
`settings.json` under `skills.cursor`, not in the files, so editing a skill
never moves it and moving it never rewrites a skill. Pins live under
`skills.defaults` and rotation flags under `skills.rotate`. With rotation off
the pinned skill is used, and without a pin the generated `skill.md`.

Reading a skill (the CLI, the dashboard, MCP) never moves the cursor; only a
send does. Each history entry records the skill it used, and `myna history`
and the dashboard show it.

## What the scheduler enforces

- **`maxPerDay`** at queue time and again at send time. The count is the
  account's successful sends in the last 24 hours plus its pending queue
  entries earlier in that window. A post over the cap goes to the next free
  slot after the day rolls over, then clears the network gap from there.
  `--now` and `--front` open the network gates, not the day's budget.
- **`minGapMinutes`** widens the network gap for that account when larger.
- **Duplicate titles.** A post to a blog or a longform mirror whose title (the
  `--title`, else the first line) is already in that account's history is
  refused with an error, not queued. `--allow-duplicate` overrides it, and
  rides on the queue entry so the daemon honours it. The daemon also drops a
  queued blog post whose title went out after it was queued.

## Surfaces

**CLI**

```bash
myna skill list                              # every network and account, which skill is on
myna skill show htmlblog                     # the network skill
myna skill show htmlblog:dev.profullstack.com/~anthony/blog
myna skill init [--force]                    # write the missing files
myna skill path <network[:account]> [slug]
```

`myna login` writes the network and account skill when it connects an
account. `myna skill init` does the same for every account already connected.

**Dashboard** (`myna dashboard`, 127.0.0.1:7777)

```
GET /skills                                index, Markdown (/skills.json for data)
GET /:network/skill.md                     the network skill
GET /:network/:account/skill.md            the account's selected skill
GET /:network/:account/skills/             its skills, as a list
GET /:network/:account/skills/:slug.md     one of them
```

`:account` is the handle as a path segment. Everything is served as
`text/markdown`. The page itself has a Skills section with each account's
skill, how many of today's posts are used, and its limits.

**MCP**: `myna_skills` lists them; `myna_skill` returns one account's skill,
its network's skill, and the merged limits, so an agent can read the rules
before `myna_post`. The `allow_duplicate` argument on `myna_post` mirrors the
flag.

## For agents

Before posting to an account, read its skill: `myna skill show <account>`,
`GET /<network>/<account>/skill.md` on the dashboard, or the `myna_skill` tool.
Follow the body and stay inside the frontmatter limits. myna enforces the
limits either way, but a post that was written to the rules does not end up
queued for tomorrow or refused as a repeat.
