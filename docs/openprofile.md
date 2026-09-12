# OpenProfile.md

OpenProfile.md is one Markdown file that says who you are and where you are, for people and agents alike. It is the profile equivalent of meta tags: a small, plain document any site can serve, any platform can link to, and any reader (a person, a crawler, an agent, a job board, a resharing network) can read without being taught a schema first. It is maintained by Profullstack, Inc. as part of the LogicSRC open-standards surface.

Status: **0.1**. This is a description of a convention already in use by [myna](https://mynaposter.com) and [agenticjobs](https://agenticjobs.work), published so others can serve and read the same file.

Slug: `openprofile`

## The problem

Every platform has a profile page, and every profile page is a dead end. Your Bluesky bio cannot tell a job board what you write about. Your GitHub page cannot tell a resharing network which topics you will boost and what that costs. An agent has it worse: it has a handle on six networks, an operator somewhere behind it, and no place where all of that is written down together.

The pieces already exist. `rel="me"` proves two pages belong to the same person. OpenGraph tells a link unfurler what a page is about. A resume says what you have done. What is missing is the one file that ties a name to its accounts, its topics, its terms, and (for an agent) the person answerable for it, in a form that survives being copied between tools.

## The shape

```markdown
# Ada Lovelace

- **Kind**: person
- **Handle**: @ada
- **Web**: https://ada.example
- **Email**: ada@example.com
- **Avatar**: https://ada.example/ada.png
- **Pay**: eip155:8453:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
- **Resume**: https://agenticjobs.work/candidates/ada/resume.md

Writes about machines that do not exist yet.

## Accounts

- [Bluesky](https://bsky.app/profile/ada.example)
- [Mastodon](https://mathstodon.xyz/@ada)
- [GitHub](https://github.com/ada)
- [Blog](https://ada.example/blog)

## Topics

- computing, mathematics, poetry, analytical engines, #babbage

## Reshare

- **Networks**: bluesky, mastodon
- **Topics**: computing, mathematics
- **Rate**: $0.05/reshare
- **Limit**: 3/day
- **Not**: gambling, politics
```

An agent's file adds one section:

```markdown
# Athena

- **Kind**: agent
- **Handle**: @athena
- **Web**: https://athena.example

Ships small fixes to open source projects, nightly.

## Operator

- **Name**: Ada Lovelace
- **Profile**: https://ada.example/.well-known/openprofile.md
- **Email**: ada@example.com
```

## The rules

There are eight, and every one of them degrades rather than fails.

**1. One `#` heading, and it is the name.** A document with more than one is read using the first; a document with none still parses, and a reader that wants a name can say it does not have one.

**2. The bullet list directly under the name is the identity block.** Each item is `Key: value`, with or without `**bold**` on the key, or a bare `[label](url)`. The keys a reader should understand are:

- `Kind`: `person`, `agent` or `organization`. Absent means unstated, which a reader should say rather than assume. `bot` is accepted as an alias for `agent`; `org` and `company` for `organization`.
- `Handle`: the name you go by, with or without a leading `@`. One handle, the one you would write on a slide. Per-network handles belong in Accounts.
- `Web`: your home page. Where the file itself lives is a separate question, answered under Discovery.
- `Email`, `Location`, `Pronouns`, `Timezone`, `Languages`: kept as written.
- `Avatar`: an image URL.
- `Pay`: where money for you goes. A [CAIP-10](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md) account (`eip155:8453:0x...`), a bare address, a Lightning address, or a payment page URL. Readers that move money must show it and ask; readers that do not can ignore it.
- `Resume`: the URL of an [OpenResume.md](https://agenticjobs.work/docs/openresume) file. The resume says what you have done; this file says who and where you are. Each may link to the other.

Values that look like an email address or a URL become links; anything else stays text. Unknown keys are kept as written, so `Discord`, `PGP` and `Calendar` all work without anyone having to add them to a list.

**3. A single prose line between the identity block and the first `##` is the headline.** One line. It is the bio a directory shows next to your name. More than one line, and only the first is treated that way; the rest is kept as prose.

**4. `##` opens a section.** The text is kept verbatim, and separately normalised for matching, so `Accounts`, `Profiles`, `Elsewhere` and `Find me` are one thing to a reader and four different words on the page. The normalised names in common use are `accounts`, `topics`, `reshare`, `operator`, `links`, `about`, `projects`, `services` and `contact`. A section whose name matches none of them keeps its own name and is not dropped.

**5. Every bullet under Accounts is one account, and the URL is the identity.** `[Bluesky](https://bsky.app/profile/ada.example)` names a platform and a page; the page is what matters, and the label is only what to call it. `bluesky: ada.example` and `https://bsky.app/profile/ada.example` on a line of their own are accepted too. A reader derives the network from the host when it knows the host, and from the label when it does not. An account is a **claim** until it is verified (see Verification), and a reader should show the difference.

**6. Topics are the words you would use to find yourself.** Comma-separated on one line or one per bullet, with or without a leading `#`. Readers lowercase them, strip the `#`, trim, and match loosely: a prefix, a plural, a hyphen for a space. `machine-learning` and `Machine Learning` are the same topic. Mapping topics onto a controlled vocabulary is the reader's job, and doing it at write time destroys the information.

**7. Reshare states what you will amplify for other people, and what it costs.** It is how a resharing network knows you exist. The keys:

- `Networks`: which of your accounts will reshare, by network name (`bluesky`, `mastodon`, `x`, `nostr`, `linkedin`, ...). Absent means every account under Accounts on a network that supports resharing.
- `Topics`: what you will reshare. Absent means your profile Topics.
- `Not`: topics you refuse, matched the same loose way. A hit here wins over a hit in Topics.
- `Rate`: what one reshare costs the author. `free` (the default when the section exists and the key does not), or an amount with a unit: `$0.05/reshare`, `$0.10/reshare/network`. A rate without `Pay` in the identity block is a request that cannot be honoured, and a reader should say so rather than treat it as free.
- `Limit`: the most reshares you will do, `3/day` or `20/week`. Absent means the reader's own default, which should be small.

No Reshare section means you are not offering to reshare. Nothing here obliges anyone to send you anything; it is an offer, and the matching, the sending and the paying are all the reader's business.

**8. Operator names the person answerable for an agent.** An agent's profile carries it; a person's does not. `Name` and either `Profile` (the operator's own OpenProfile.md, which is the strong form) or `Email`. A reader that meets an agent without an Operator section should say the operator is unstated. Operators can chain: an agent run by an agent names that agent, whose profile names a person. A reader following the chain stops after a few hops and reports what it found.

## Discovery

The file is served, not registered. There are three ways to find it, and a reader should try all three.

**1. Well-known.** A domain that is a person or an agent serves the file at `/.well-known/openprofile.md`. This is the canonical location for a personal site.

**2. A link element.** Any HTML page can point at the file:

```html
<link rel="openprofile" href="https://ada.example/.well-known/openprofile.md">
```

A home page points at its owner. A platform that hosts many people points each profile page at that person's file, wherever it is served. The same relation works as an HTTP header for responses that are not HTML:

```http
Link: <https://ada.example/.well-known/openprofile.md>; rel="openprofile"
```

**3. A conventional path on a platform.** A platform serving profiles for its users serves `openprofile.md` next to the profile page: `https://agenticjobs.work/candidates/ada/openprofile.md`. The `<link>` on the profile page should point at it, so a reader that only knows the page still finds the file.

Serve it as `text/markdown; charset=utf-8`. A `Content-Disposition: attachment` header is fine for a download link and wrong for the well-known location, where a reader is fetching rather than saving.

## Verification

An account under Accounts is a claim that a page belongs to the person named at the top of the file. The claim is verified when the page points back.

- The platform profile page carries `<link rel="openprofile">` or `<a rel="me">` to the OpenProfile.md URL, or to a page that carries `<link rel="openprofile">` to it.
- Or the platform bio, website field or pinned post contains the OpenProfile.md URL in plain text, for platforms with no way to set a link relation.

A reader shows a verified account as verified and an unverified one as claimed. It never hides an unverified one, because most accounts will be unverified for a while, and a claim is still information.

Two profiles that link to each other through Operator and through an account are the same trust chain: the agent says who runs it, and the person's file lists the agent under Accounts. Either link alone is a claim; both together are a verification.

## What is deliberately absent

**No required fields.** A document consisting of a name and one line of prose is a valid OpenProfile.md.

**No schema version.** Readers ignore what they do not recognise. A profile written today has to be readable in five years by software nobody has written yet.

**No signatures.** A signed profile is a good idea and a different specification. Verification here is bidirectional linking, which every platform already supports in some form, and which is what `rel="me"` has used for twenty years.

**No structured topic taxonomy.** Topics are the words people wrote.

**No JSON.** A reader may compute a structured view (name, kind, identity pairs, accounts with derived networks, topics, reshare terms, operator) and use it for matching and search. That view is derived, and it is regenerated from the Markdown on every read. **The Markdown is the canonical copy.** A product that stores the parse and treats the Markdown as an export has implemented a form with a Markdown skin, and the person no longer owns their profile.

## Reading one

A conforming reader:

1. Fetches the file from any of the three discovery locations and parses it under the eight rules.
2. Keeps every line it does not understand.
3. Reports absence as absence: an unstated `Kind`, an unstated operator, an unverified account.
4. Matches topics loosely and lets `Not` win.
5. Never moves money on the strength of `Rate` alone. `Pay` says where; the reader's own agreement with the person says whether.

## Writing one

By hand, in any editor, in five minutes. Or:

- `myna profile write` builds one from the accounts myna is logged into and the topics in its settings, and `myna profile show` prints it. `myna reshare join` publishes the Reshare section to the myna reshare network.
- agenticjobs serves one for every public candidate at `/candidates/<slug>/openprofile.md`, derived from the candidate's OpenResume.md, and links it from the profile page.

## Related standards

- [OpenResume.md](https://logicsrc.com/docs/openresume): what you have done, in the same spirit. A profile links to a resume through `Resume`; a resume links to a profile through `Profile` in its contact block.
- [OpenJob](https://logicsrc.com/docs/openjob): what the work is.
- [OpenCreds](https://logicsrc.com/opencreds): where the tokens behind the accounts are kept. A profile never contains a credential.
- [ASDLC](https://logicsrc.com/asdlc): how the tools that serve and read these files get built.

## Version history

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-09-12 | First publication: eight rules, three discovery locations, bidirectional verification, Reshare and Operator sections. |

## License

The specification text is CC BY 4.0. Serve it, copy it, extend it.
