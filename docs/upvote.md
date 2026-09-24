# The upvoter: `myna upvote`

Posting into a feed nobody reads is the slow way to be ignored. The people
already writing about what you write about are the ones worth being seen by,
and they are findable: they are posting, publicly, right now. `myna upvote`
finds them and amplifies them — a vote on what is genuinely on your subject,
a share of the best of it, and once in a while a reply carrying one of your
links, all from a queue you can read before any of it happens.

```sh
myna upvote on          # the daemon searches every 30 minutes, casts what is due every 3
myna upvote             # the queue: whose post, why it matched, what myna will do
myna upvote topics      # what myna thinks you are about, and what it searches for
myna upvote scan        # search now
myna upvote send        # cast what is due now (--dry-run to rehearse)
```

## Where the subject comes from

You. Nothing is configured: the engine reads your own send history from the
last `topicDays` (14 by default), pulls out the terms that keep coming up,
weights them by how often and how recently, and searches for those. Post about
rope data structures for a fortnight and it goes looking for people talking
about rope data structures.

`myna upvote topics` prints exactly what it derived, and the searches that
follow from it. If that list is wrong, what it finds will be wrong, and the fix
is to look at what you have been posting rather than to tune a knob.

It is ranked by **distinctiveness, not frequency**, and that distinction is the
whole thing. An install that posts about a dozen products says "every", "page",
"first" and "live" in most of them, so ranking by count puts its own filler on
top and sends the engine looking for strangers who used the word "first". So a
term is scored by inverse document frequency against your own history: anything
appearing in more than about one post in eight is your vocabulary rather than
your subject, and is dropped outright. A term in only one post is a
coincidence, so two is the floor. An install that has barely posted skips all
of that, because with five posts there is no filler to find.

Two-word phrases outrank single words, both as topics and as queries, because
"open source" finds the right people and "open" does not. A single word is
never sent as a query on its own when anything else exists: two narrow words
find people talking about both, one finds the whole network.

Scoring a stranger's post follows from the same idea. Brushing against one of
your terms is a coincidence and scores zero; it takes a phrase, or two distinct
terms, to count as on-subject at all.

## What it does about it

For every account on a network that can search and cast, each query is run,
each result scored against your topics, and what clears the bar is queued.
Three actions, and they escalate — each includes the one before it, so one post
is one action against its author however loud:

| action | what happens | how often |
|---|---|---|
| `vote` | a like, a favourite, a +1 | the default, almost always all of it |
| `repost` | vote, and share it onward | `repostRatio`, 15% by default |
| `reply` | vote, and comment with one of your links | `linkRatio`, 6% and never more than `linkPerDay` |

A candidate is dropped before it is ever queued if it is yours, if it has been
considered before, if it is older than `maxAgeHours`, if it scores below
`minScore`, or if that author was already acted on inside `cooldownDays`. One
author gets one action per scan however many of their posts match.

## The link drop

This is the part that can make you look like a spammer, so it is the part with
the most brakes on it. A reply only carries a link when all of these hold:

- the post scores at least `linkMinScore` (0.5, twice the bar for a bare vote)
- one of your own recent posts genuinely overlaps with theirs, by shared terms
  and not by vibes — no overlap, no link, and it falls back to a plain vote
- the writer is available, and agrees
- the account is under `linkPerDay` (2)

The writer is asked for a reply that answers something specific in their post
and offers the link last, as "here is the thing I wrote about that", never as a
pitch. It is told to decline outright whenever the link would not genuinely
help the person reading — and declining returns an empty draft, which the
engine treats as a refusal and downgrades to a plain vote. No API key means no
writer, which means no link is ever dropped at all.

## Pacing, and what it will not do

Per account: never inside `gapMinutes` of the last action, never past
`maxPerDay`, never past `linkPerDay` for the ones carrying a link. The queue is
filled by a scan and worked by a run, and nothing is ever cast in the same
breath it was found — `myna upvote` shows you every queued action, including
the drafted replies, and `myna upvote skip <id>` drops one.

**Reddit ships as manual only.** Reddit's API terms forbid casting votes
programmatically, so it is in `manualOnly` out of the box: those accounts are
still searched and still queued, because the finding is useful, but a run
refuses to cast on them until a person says so with `myna upvote send --network
reddit`. Any network can be put in or taken out of that list.

Every reply it sends lands in `myna history` as type `reply`, so the rest of
myna counts it like any other post.

## The people it finds are leads

Somebody posting publicly about the thing you sell, recently enough to still be
in a search result, matching it well enough to clear the bar, is a better lead
than anyone you followed on a hunch. So the upvoter hands every person it finds
to whatever is installed that collects people, through a plugin hook:

```ts
async afterDiscover(event: DiscoveredEvent, ctx: PluginContext) {
  // event: account, network, handle, displayName, postText, postUrl,
  //        score, matched (the topics they hit), action
}
```

The upvoter does not know what a lead is, and nothing in core mentions a CRM.
It fires the hook once per person per scan, as soon as the action is queued
and before anything is cast, because the finding is worth something even if
the vote is later skipped. A hook that throws is reported and never costs the
queue entry.

**OutreachGraph is the one that ships.** It is already a myna plugin with its
own sign-in, so there is nothing new to connect:

```sh
myna outreachgraph login          # email and password, kept in the vault
myna config upvote.leads true     # on by default
```

Each person goes over with `via` set to `upvote:<the topics they matched>`, so
OutreachGraph knows what to reach them about rather than inferring it, and the
post myna actually read travels as their bio. Networks OutreachGraph does not
know are skipped with a line saying so.

Anything else can collect them instead, or as well: implement `afterDiscover`
in your own plugin and it gets the same events, in load order, one at a time.

## Settings

`myna upvote set <key> <value>`:

| key | default | what it does |
|---|---|---|
| `maxPerDay` | 30 | actions per account in a rolling day |
| `gapMinutes` | 4 | least time between two actions from one account |
| `cooldownDays` | 3 | one action per author per account in this window |
| `minScore` | 0.25 | how well a post must match to be worth a vote |
| `linkMinScore` | 0.5 | the higher bar a post must clear to carry a link |
| `repostRatio` | 0.15 | share of votes that are also shared onward |
| `linkRatio` | 0.06 | share of votes that also get a reply with a link |
| `linkPerDay` | 2 | hard cap on replies carrying a link, per account |
| `maxAgeHours` | 48 | older than this and the post is stale |
| `topicDays` | 14 | how far back your own posts are read for topics |
| `queriesPerScan` | 6 | searches built per scan |
| `searchLimit` | 25 | results asked of each network per query |
| `networks` | `all` | which networks to amplify on |
| `manualOnly` | `reddit` | queued, but never cast without a person |
| `leads` | `true` | hand everybody found to the plugins that collect people |

## Everywhere else

The same engine, not a reimplementation of it:

- **CLI** — `myna upvote`
- **Desktop** — the Upvoter view: the queue, Search now, Rehearse, Cast
- **Dashboard** — an Upvoter panel with the caps, what is queued against them,
  and the topics it is working from
- **API** — `GET /v1/upvote`, `GET /v1/upvote/topics`, `POST /v1/upvote/scan`,
  `POST /v1/upvote/send`, `POST /v1/upvote/enabled`, `PATCH /v1/upvote/:id`
- **MCP** — `myna_upvote_queue`, `myna_upvote_topics`, `myna_upvote_scan`,
  `myna_upvote_send`, `myna_upvote_set`

## Which networks can do it

Search and cast both have to exist for a network to take part.

| network | finds | casts |
|---|---|---|
| Bluesky | `searchPosts` | a like record, and a repost |
| Mastodon and friends | full-text where the instance has it, else the hashtag timeline | a favourite, and a boost |
| Misskey and friends | `notes/search` | a reaction |
| Lemmy | `search` | a `+1` on the score |
| Reddit | `search` | a vote, **manual only** |
