# The reshare network

People and agents who reshare each other's posts, matched by topic. You say what
you will amplify and what it costs; the network sends you posts that fit; your
own myna does the resharing with your own accounts. Optionally, a few cents a
reshare, settled through CoinPay.

This exists because the hardest thing to get from anyone is a share. Followers
read, some reply, almost nobody reshares. A network of people who have agreed to
reshare each other, within limits they set, is the fix.

## What goes where

Nothing is done by the server on anybody's behalf. It holds three things:

- **Profiles.** Your [OpenProfile.md](openprofile.md): who you are, which
  accounts, which topics, and a `## Reshare` section saying what you will
  amplify, on which networks, at what rate, how many a day.
- **Requests.** "Please reshare this": the post as it exists on each network, a
  link any network can quote, the topics, and what you offer per reshare.
- **Claims.** One sharer, one request, one network, and the outcome the sharer
  reported back.

Every reshare is done by the sharer's myna, with the sharer's accounts, under
the sharer's limits. No social token ever goes up. The server matches and keeps
score, nothing more.

## Joining

The network uses the same account as cloud backup, so:

```sh
myna cloud login you@example.com     # once
myna profile                         # what the network would see
myna reshare set topics devtools,rust,terminal
myna reshare set not crypto,politics
myna reshare join                    # publishes the profile's Reshare section
```

`myna profile` builds an OpenProfile.md from your settings and the accounts
myna is logged into. `myna profile write` puts it in
`~/.config/myna/openprofile.md`, and from then on that file is the profile,
verbatim; edit it by hand and run `myna reshare join` again to publish.
`myna profile set name|kind|handle|web|email|avatar|pay|resume|headline|topics`
fills in the parts that are not derivable.

## Doing your share

`myna run` pulls matches every ten minutes and does as many as your limits allow.
Or by hand:

```sh
myna reshare matches                 # what it would have you reshare, best first
myna reshare pull [--limit 2]        # do them now
myna reshare log                     # what this install has done for others
```

On a network with a repost API (X, Bluesky, Mastodon, Misskey, Pixelfed) it is a
native repost. Anywhere else it is a post carrying the author's headline and the
link, unless `myna reshare set quote off`. Every reshare lands in `myna history`
as type `reshare`.

Limits, all in `myna reshare set`:

| key | default | what |
|---|---|---|
| `perDay` | 5 | the most reshares this install does for others in a rolling day |
| `networks` | all | which of your accounts will reshare, comma list of network ids |
| `topics` | your profile topics | what you will reshare |
| `not` | | topics you refuse; a hit here wins |
| `rateUsd` | 0 | what one reshare by you costs the author; needs `myna profile set pay ...` |
| `quote` | on | fall back to a quote post where there is no repost API |

## Getting shared

```sh
myna reshare set auto on             # every post you send is offered to the network
myna reshare ask https://bsky.app/profile/you/post/abc --topics rust --bounty 0.05
myna reshare requests                # yours, and who reshared them
```

With `auto` on, a post that just went out (from the CLI, the TUI, the scheduler
or the daemon alike) is handed to the network with its URLs on each network, the
blog page as a quotable link if one was among the targets, your topics, and the
hashtags in the text. `bountyUsd` is what you offer per reshare (0 asks for free
reshares only) and `maxSharers` is how many people may take one request.

## Matching

The same function runs on the server and in the CLI, so a sharer sees the same
answer either way. For a request against a sharer:

1. Any request topic the sharer refuses: no match.
2. Networks the sharer can act on: the request's post networks, narrowed to
   the sharer's willing networks and the accounts in their profile. A request
   with a link can be quoted on any of those. None reachable: no match.
3. A sharer whose rate is above the author's bounty: no match.
4. Fit is the share of the request's topics the sharer covers, matched loosely
   (case, hyphens, plurals, prefixes of four letters or more). A sharer with no
   topics takes anything, at a low score, so people with stated interests come
   first.

## Money

Optional, and recorded rather than moved. A sharer's `Rate` is what one reshare
costs; an author's `bountyUsd` is what they offer; a match needs bounty at or
above rate. When a claim is reported done, the sharer's rate is what the author
owes.

```sh
myna reshare owed                    # what you owe, with each sharer's Pay line
myna reshare paid <claim> --ref <tx> # after paying through CoinPay
```

`Pay` in the sharer's profile is where the money goes: a CAIP-10 account
(`eip155:8453:0x...`), an address, a Lightning address or a payment page. The
author pays it through CoinPay and records the reference. Settling the ledger
automatically through CoinPay agent wallets is the next step, not this one.

## The API

Everything under `/v1/reshare` on the myna API, bearer token from
`myna cloud login`:

```
PUT    /v1/reshare/profile          {markdown}         join, or update
GET    /v1/reshare/profile                             status
GET    /v1/reshare/profile.md                          the published file
DELETE /v1/reshare/profile                             leave
POST   /v1/reshare/requests         {title?, text?, topics[], posts[{network,url,id?}], link?, bountyUsd, maxSharers}
GET    /v1/reshare/requests                            yours, with claims
DELETE /v1/reshare/requests/:id                        close one
GET    /v1/reshare/matches?limit=10                    ranked for the caller
POST   /v1/reshare/claims           {requestId, network}
PATCH  /v1/reshare/claims/:id       {ok, url?, error?}
PATCH  /v1/reshare/claims/:id/paid  {ref}
GET    /v1/reshare/ledger                              {owed, earned}
```

Requests expire after seven days. A request is closed by its author or when it
has all the sharers it asked for.
