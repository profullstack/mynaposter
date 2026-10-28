# Engage the hubs

On X, Bluesky or LinkedIn there is no subreddit for your buyers. The
community is conversational: it gathers in the replies under a handful of
accounts everybody in it follows and answers. Media buyers on LinkedIn, for
one, are in the comments under ad-account screenshots, not in a group with a
nice name. So the work is to find those few accounts, watch what they post,
and say something worth reading under it.

`myna hubs` does that from an OutreachGraph campaign's leads.

```
myna outreachgraph hubs cmp_4bfx2dpkyc2t9n1yhvyqz5cvx0 --refresh   rank and import
myna hubs --campaign cmp_4bfx2dpkyc2t9n1yhvyqz5cvx0                 the hubs, best first
myna hubs scan --campaign cmp_4bfx2dpkyc2t9n1yhvyqz5cvx0            read posts, draft replies
myna hubs drafts                                                    what is waiting
myna hubs approve <id> [--text "…"] [--account bluesky:…]           queue it under their post
myna hubs skip <id> | edit <id> "…"
```

## Ranking (OutreachGraph)

`POST /api/v1/campaigns/:id/hubs` in OutreachGraph reads every lead's social
handles and, where the network allows it without an account:

- **Bluesky:** who each lead follows (`app.bsky.graph.getFollows`) and whose
  posts each lead replied to in its recent feed.
- **Mastodon:** who each lead follows, through the lead's own instance.
- **X and LinkedIn:** nothing can be read. The leads' own handles are listed
  as hubs to watch by hand (`leadHub`), so they are not forgotten.

A hub's score is the share of the campaign's leads that follow it plus
double weight for leads that replied to it (a reply is the stronger signal),
and it needs at least two leads, so one lead's favourite account is not a
hub. `GET` returns the last ranking. `myna outreachgraph hubs <campaign>`
imports it into `hubs.json`, with the campaign's product, and `--refresh`
recomputes first.

Add one by hand with `myna hubs add bluesky <handle>`.

## Drafting

`myna hubs scan` reads the newest top-level posts of the top `hubs.watch`
hubs (default 8; Bluesky through the public AppView `hubs.bskyBase`, Mastodon
through the hub's instance), skips reposts, posts older than
`hubs.maxAgeHours` (72) and anything shorter than 20 characters, and asks the
writer for a reply under each, at most `hubs.draftsPerScan` (10) per scan.

The writer is told the readers are the audience: add something (an answer,
an experience, a number, a sharp question), one to three sentences, mention
the product only when the post is about the exact problem it fixes and say
you work on it, and decline when there is nothing to add. A declined post is
marked seen and never drafted again. With no writer configured nothing is
drafted: a reply to a stranger is never a template.

## Approval and pacing

Nothing posts on its own.

- **Bluesky, Mastodon:** `approve` adds a queue entry with `replyTo` set to
  their post (a Bluesky `uri|cid`, a Mastodon status URL that the replying
  account's instance resolves), from the first connected account on that
  network or `--account`. The scheduler then applies the usual pacing: the
  reply waits its turn like any post.
- **X, LinkedIn, or no account on the network:** `approve` makes a hand-off
  card with the reply, the post link and the steps.

## Surfaces

| CLI | REST | MCP |
| --- | --- | --- |
| `myna hubs` | `GET /v1/hubs?campaign=` | `myna_hubs` |
| `myna hubs add <net> <handle>` | `POST /v1/hubs` `{network, handle}` | `myna_hubs_import` |
| `myna outreachgraph hubs <campaign>` | `POST /v1/hubs` `{hubs[], campaignId, product}` | `myna_hubs_import` with `hubs` |
| `myna hubs rm <hub>` | `DELETE /v1/hubs/:ref` | |
| `myna hubs scan` | `POST /v1/hubs/scan` | `myna_hubs_scan` |
| `myna hubs drafts` | `GET /v1/hubs/drafts?status=` | `myna_hubs` with `drafts` |
| `myna hubs approve/skip/edit <id>` | `PATCH /v1/hubs/drafts/:id` `{action}` | `myna_hubs_decide` |

State lives in `hubs.json` in the myna config directory; settings under
`hubs` in `settings.json` (`myna config hubs.watch 12`).
