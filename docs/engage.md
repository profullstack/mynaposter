# Follow-ups: `myna engage`

The people who reply to your posts, repost them, quote them or follow you are
the whole point of posting, and they are the easiest people to ignore. `myna
engage` answers them: a reply drafted by the writer from what they said, with
your original post as context, and a follow-back, sent on a pace from a queue
you can read first.

```sh
myna engage on          # the daemon scans every 15 minutes, sends what is due every 5
myna engage             # the queue: who, what they did, the drafted reply
myna engage scan        # read notifications now
myna engage send        # send what is due now (--dry-run to rehearse)
```

## What the daemon does

**Scan.** For every account on a network that can read notifications (Bluesky,
Mastodon, Misskey, Pixelfed), read the recent ones. Each is considered once and
never again. The ones that are a conversation become follow-ups:

| they | myna queues |
|---|---|
| replied, mentioned you, or quoted you | a drafted reply under their post, and a follow-back |
| reposted | a drafted thank-you under the post they shared, and a follow-back |
| followed you | a follow-back |
| liked | nothing, unless `followLikers` is on; a like is not a conversation |

The reply is drafted by the writer from what they wrote, with your original
post found in history as context, in your saved voice, one or two sentences,
specific to what they said. Told that you followed them, it may say so in
passing. Without a writer (no API key) the reply is a plain `Thanks, @handle,
followed you back.` and the queue marks it as a template so you can see which
ones to edit.

**Send.** Work through what is due, one account at a time: never inside
`gapMinutes` of the last one sent from that account, never past `maxPerDay`. A
follow that fails does not stop the reply; a reply that fails is recorded with
its reason and not retried, because a second attempt is how someone gets two.
Every sent reply lands in `myna history` as type `reply`.

## The queue is the design

Nothing is sent in the same breath it was noticed. `myna engage` shows every
drafted reply before it goes, with an id:

```
a1b2c3  2026-09-12 12:10  bluesky:you  reply from ada.bsky.social  +follow
    they said: Does it work on Windows?
    reply: Not yet, the build is Linux and macOS today. Windows is next on the list. Followed you back.
```

`myna engage skip <id>` drops one, `myna engage edit <id> "..."` changes the
reply, `myna engage log` shows what went out and how. The same person inside
`cooldownDays` gets one follow-up, not one per message: a second reply from them
before the first is sent re-drafts the pending reply to answer what they said
last.

## Settings

`myna engage set <key> <value>`:

| key | default | what |
|---|---|---|
| `maxPerDay` | 20 | follow-ups sent per account in a rolling day |
| `gapMinutes` | 10 | least time between two from the same account |
| `cooldownDays` | 7 | one follow-up per person per account inside this |
| `followBack` | on | follow whoever replied, reposted or followed |
| `replyToMentions` | on | answer a reply, mention or quote |
| `thankReposts` | on | thank a repost under the shared post |
| `followLikers` | off | follow people who only liked |
| `networks` | all | comma list of network ids to engage on |
| `scanLimit` | 40 | notifications read per account per scan |

Off by default. Replying to people is not something to do by accident.

## Where it lives

`~/.config/myna/engage.json`: the notifications already considered per account,
and every follow-up with its draft, its due time and its outcome. Plain JSON,
nothing secret.
