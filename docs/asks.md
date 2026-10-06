# Asks

People post "is there a site that does X, Y and Z?" every day. Each post is
somebody to answer, and a lot of posts asking for the same thing is a product
worth building. `myna asks` finds those posts, adds up how many different people
want the same thing, drafts the answer onto a card you paste, and tracks what
the thread and your reply did.

```bash
myna asks on                     # the daemon reads the subs every 30 min, stats every 6 h
myna asks scan                   # read them now
myna asks                        # what is new, and the ideas most asked for
myna asks ideas                  # what people keep asking for; BUILD at 5+ askers
myna asks reply <id>             # the answer, on a hand-off card to paste
myna asks stats --refresh        # thread score and comments, our reply's score and answers
```

## Where the posts come from

Reddit blocks this box and every datacenter address, so nothing here talks to
reddit.com.

- **Posts** come from RSS Amplifier's subreddit mirrors,
  `https://rssamplifier.com/r/<sub>.json`, which its crawler fills.
- **A sub RSS Amplifier has not read yet**, or does not list, falls back to the
  newest posts in the [Arctic Shift](https://arctic-shift.photon-reddit.com)
  archive. `myna asks scan` says which source each sub used. Turn the fallback
  off with `myna asks set fallback false`.
- **Full text and numbers** come from the archive. A feed item carries a short
  summary, so the posts that look like asks are read again in one batch.

The archive is free and says "slow down" when two requests arrive back to back,
so requests to it are spaced 2.5 s apart and retried once when it complains.

The default subs are where these posts actually appear: the r/Ask* tech subs
(AskProgramming, AskProgrammers, AskTechnology, AskNetsec, AskElectronics,
AskEngineers), then SomebodyMakeThis,
AppIdeas, Lightbulb, software, webapps, macapps, androidapps, iosapps,
selfhosted, productivity, SaaS, SideProject, Entrepreneur, smallbusiness,
nocode and webdev. `myna asks subs add <sub>` and `myna asks subs rm <sub>`
change the list.

## What counts as an ask

Two passes.

1. **Patterns.** A post qualifies on shapes like "is there a…", "looking for a
   tool…", "someone should build…", "alternatives to…", "best app for…" and
   "how do you keep track of…". A match in the title counts for more than one
   in the body.

   These cost points: the poster pitching their own tool ("I built…", "my
   app"), hiring, "would you pay for…", "what app do you wish existed",
   "startup ideas", and "sharing in case anyone needs it".

   The wants are the clause after the ask, split on its commas and "and"s. The
   body adds any bullet list, plus phrases like "I want it to…" and "it
   should…".
2. **The writer** takes a second look when one is configured and
   `asks.useWriter` is on. It throws out what is not really an ask, such as a
   vendor search or advice dressed as a question. For what it keeps, it writes
   the wants in the asker's words and gives a short label ("link organizer
   app"). A post it says nothing about waits for the next scan rather than
   getting in on the patterns alone.

Every post is judged once, ask or not.

## Ideas

Asks are grouped by the words they share, with the words of asking left out. A
new ask joins the idea it shares at least two terms with, provided those
shared terms make up a third of the smaller set.

When the writer has labelled both the ask and the idea, the labels must also
share a word. "Playlist video downloader" and "digital signage software" share
"video" and "playlist" in their wants and are still not one thing.

- `myna asks ideas` ranks ideas by how many different people asked inside
  `asks.windowDays` (60 days by default), then by the attention their threads
  got.
- An idea is flagged **BUILD** once `asks.buildAt` (5) different people have
  asked. The daemon's log line and `myna asks scan` both say so.
- After that, the status is yours to move:

```bash
myna asks idea <id> --status building
myna asks idea <id> --status shipped --product <your product id>
myna asks idea <id> --status ignored
myna asks idea <id> --merge <other id>     # the grouping split one thing in two
myna asks idea <id> --label "better name"
```

## Replying

```bash
myna asks product add PairUX https://pairux.com --keywords "screen sharing, remote control" --about "Screen sharing with remote control"
myna asks reply <id>
```

A reply is never posted. It is a [hand-off card](../README.md#hand-offs) with:

- the text
- the thread to open
- three steps

When this machine is signed in to myna cloud, the card is also published to
mynaposter.com/handoff/<id> so it can be pasted from a phone. The recap lists
it until it is marked done.

- **When one of your products answers the ask**, matched on its keywords, the
  reply names it and says plainly that you work on it. Its link carries
  `utm_source=reddit&utm_medium=comment&utm_campaign=asks-<idea id>`, so the
  site's own analytics show which idea sent the visit.
- **When nothing of yours fits**, the reply says so and asks the one question
  a builder needs answered: which of the things they listed they would drop,
  and what they use today.
- **When the writer judges a reply would not help**, it declines and nothing is
  made. `--text "…"` writes your own reply instead.

Mark the card done once it is pasted (`myna handoff done <id>`). The ask is
then `replied`.

## Stats

`myna asks set redditUser <name>` tells stats who you are on Reddit. Each run
then re-reads every thread still inside `asks.trackDays` (30 days), oldest
first and `asks.statsPerRun` (40) at a time. It records:

- the thread's score, comment count and upvote ratio
- for threads you replied in, your comment's score and how many people
  answered it

A reply found in a thread also marks a card you forgot to close as pasted.
`myna asks show <id>` prints the history of these numbers, and `myna asks stats`
totals them.

## Leads

Each asker is handed to the plugins that collect people through
`afterDiscover`:

- `source: "asks"`
- `network: "reddit"`
- `via: "ask:<idea label>"`

OutreachGraph files them as Reddit people, so the person who asked becomes
someone to tell when the idea ships. `myna asks set leads false` turns this
off.

## Surfaces

| CLI | REST | MCP |
| --- | --- | --- |
| `myna asks` | `GET /v1/asks/overview` | `myna_asks` |
| `myna asks list` | `GET /v1/asks?status=&sub=&idea=` | `myna_asks` with `status` |
| `myna asks show <id>` | `GET /v1/asks/:id` | `myna_asks` with `id` |
| `myna asks scan` | `POST /v1/asks/scan` | `myna_asks_scan` |
| `myna asks reply <id>` | `POST /v1/asks/:id/reply` | `myna_asks_reply` |
| `myna asks skip/replied <id>` | `PATCH /v1/asks/:id` | `myna_asks_set` |
| `myna asks ideas` / `idea <id>` | `GET /v1/asks/ideas[/:id]` | `myna_asks_ideas` |
| `myna asks idea <id> --status …` | `PATCH /v1/asks/ideas/:id` | `myna_asks_set` |
| `myna asks stats` | `GET /v1/asks/stats?refresh=1` | `myna_asks_stats` |
| `myna asks on/off` | `POST /v1/asks/enabled` | `myna_asks_set` |

State lives in `asks.json` in the myna config directory, and settings live
under `asks` in `settings.json`.
