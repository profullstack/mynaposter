# @profullstack/myna-plugin-outreachgraph

Seeds [myna](https://mynaposter.com)'s follow graph with the people
[OutreachGraph](https://outreachgraph.com) ranks for you.

OutreachGraph finds the people who matter for what you sell and scores them
by opportunity. This plugin pulls that list, keeps the ones with a Bluesky,
Mastodon, X, Nostr or Misskey identity, and hands them to myna as seeds,
weighted by their score. myna then reads who *they* follow and follows the
accounts they agree on, a few an hour, from `myna run`. The people an
influencer chooses to follow are a far better list than the people who follow
the influencer.

Bundled with myna since 0.5.0, so there is nothing to install:

```bash
myna outreachgraph login       # email + password, kept in the encrypted vault
myna outreachgraph people      # the ranked list, with the handles myna can use
myna outreachgraph sync        # pull them in as seeds now
myna graph on && myna run      # the daemon re-syncs every six hours
```

`--url <base>` on `login` points it at a self-hosted OutreachGraph.
`--limit N` on `people` and `sync` bounds how many are read (100 by default).

Identities below 0.6 confidence are left out, so a handle OutreachGraph is not
sure belongs to the person is never followed. A 0–100 opportunity score
becomes a 1–2 seed weight: the best prospect counts twice as much as an
unscored one and never drowns everyone else out.

This package is also the reference for writing a plugin of your own; see
`docs/plugins.md` in the myna repository.
