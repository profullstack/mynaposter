# The brain: your marketing team's knowledge in a git repo

myna's writer has always read one file, `~/.config/myna/brand.md`: a short
card with the name, audience, positioning, voice, pillars and what never goes
out. That is one person's card. A team needs more: the full positioning, who
the ideal customer is, the objections prospects raise and how we answer them,
per-product notes, and the skills for every network. And it needs every
teammate's AI reading the same version of all of it.

The brain is that, kept as plain Markdown in a private git repo:

- every change is versioned and reviewable as a pull request;
- a rollback is one `git revert`;
- the files are nobody's proprietary format, so any editor and any AI reads them;
- every teammate who links the repo writes from the same files.

## The format

```
<brain>/
  README.md
  knowledge/
    positioning.md   what it is, who it is for, why it is different
    voice.md         brand voice
    audience.md      the ideal customer
    objections.md    what prospects push back on or ask
    *.md             any other knowledge file
    <product-slug>/*.md   per-product files for a multi-product brain
  skills/            same layout as ~/.config/myna/skills:
                     types/<type>/skill.md, <network>/skill.md,
                     <network>/<account>/skill.md, extra *.md
```

Knowledge files are YAML frontmatter (flat `key: value`, all optional) plus a
Markdown body:

```markdown
---
title: Positioning
owner: growth
updated: 2026-10-26
---

# Positioning

## What we do
...
```

OutreachGraph writes the same layout with `og brain export`, so one repo can be
fed from the CRM side (objections and audience learned from real conversations)
and read by myna on the publishing side. Neither tool owns the repo; both read
and write plain files in it.

## Commands

```
myna brain init <dir> [--product <slug>]          scaffold, git init, commit, link
myna brain link <git-url|path> [--product <slug>] link an existing brain
myna brain unlink                                 forget it (a clone myna made is deleted)
myna brain pull                                   git pull --ff-only, lists changed files
myna brain push [-m "message"]                    git add -A, commit, push
myna brain show [--show-prompt] [--json]          source, last pull, HEAD, files, what is prompted
```

- `init` writes `README.md` and `knowledge/positioning.md`, `voice.md`,
  `audience.md`, `objections.md`. Positioning and voice are seeded from
  `brand.md` when there is one; otherwise they are templates with the
  questions to answer (start with positioning: what you do, who it is for, why
  it is different). Your current `~/.config/myna/skills` is copied into
  `skills/`. Then it links the directory in place. Add a remote and
  `myna brain push` to share it.
- `link` with a git URL clones into `~/.config/myna/brain` (under `$MYNA_HOME`
  when that is set). A local path is used where it is, never copied.
- `--product <slug>` also reads `knowledge/<slug>/*.md`; a product file
  replaces the root file with the same name.
- The daemon pulls at most once an hour. A failed pull is one line in the
  daemon log, never a crash. A brain directory that is not a git repo is
  skipped.

MCP: `myna_brain` (status, files, and the knowledge text) and `myna_brain_pull`.
The dashboard serves the same status read-only at `GET /brain`.

## What the writer reads

Every writing path (drafts, tailoring, replies, link posts, asks, the planner,
atomize) builds its system prompt as: the task's instructions, then the brand
card from `brand.md`, then the brain's knowledge block. With no brain linked
the prompt is exactly what it was before.

The knowledge block is ordered `positioning`, `voice`, `audience`,
`objections`, then every other file alphabetically. Frontmatter is folded into
one short header line per file. The block is capped at 24 KB: the file that
crosses the cap is cut and marked `[truncated]`, and any file after it is named
as not loaded, so a model (and you, via `myna brain show`) can see what was
left out. Keep the high-value files short and first.

## Skills precedence

The brain's `skills/` is an extra layer under your local skills:

1. a local skill file you wrote wins;
2. otherwise the brain's file is used;
3. a local file that is still exactly the template myna generated counts as
   missing, so the team's file is not hidden by the templates every install
   writes; and myna does not materialise a template where the brain already
   has the file.

Local wins because a person tuning one account on one machine (a stricter cap
on a new account, say) should not be overruled by the next pull; the team's
rule is the default everywhere else. Limits from all layers still merge with
the stricter value winning. `myna skill show` says which source each layer
came from.

## Sync between machines

myna cloud sync (`myna sync`) carries `settings.json`, which holds
`settings.brain` (`source`, `dir`, `product`, `lastPull`), and now `brand.md`.
On another machine, `myna brain pull` (or the daemon) clones a git source that
is not there yet. A brain linked by local path only works on machines that have
that path.

## Git workflow

1. `myna brain init ~/src/acme-brain` (or create the repo by hand in the layout above).
2. `git -C ~/src/acme-brain remote add origin git@github.com:acme/brain.git && myna brain push`.
3. Teammates: `myna brain link git@github.com:acme/brain.git`.
4. Change knowledge on a branch, open a PR, review, merge. Every linked install
   picks it up within the hour, or right away with `myna brain pull`.
5. A bad change: `git revert <sha> && git push`. That is the rollback.

Credentials are git's: SSH keys or a credential helper. myna never asks for a
password (it runs git with `GIT_TERMINAL_PROMPT=0`), so a private repo needs a
key that works non-interactively for the daemon to pull it.
