# @profullstack/openprofile

One reader and writer for [OpenProfile.md](https://logicsrc.com/openprofile), the Markdown profile
file for people and agents, with its [Broadcast](https://logicsrc.com/openbroadcast) and
[Guest](https://logicsrc.com/openguest) sections. Every house app that serves a profile reads,
renders, corrects and de-duplicates it through this package, so a profile means the same thing on
p0dcasters, OutreachGraph, rssamplifier, nichedb and myna.

```sh
npm i @profullstack/openprofile
```

## Read

```ts
import { parseOpenProfile, accounts, topics, kindOf, broadcasts, guest } from "@profullstack/openprofile";

const doc = parseOpenProfile(markdown);
doc.name;                 // the `#` heading, or null
doc.identity;             // [{ key: "Kind", value: "person" }, ...] as written
doc.headline;             // the one prose line after the identity block
doc.sections;             // [{ title: "Find me", name: "accounts", body: "- ..." }]
accounts(doc);            // [{ url, label }] the URL is the identity
topics(doc);              // ["computing history", "mathematics"]
kindOf(doc);              // "person" | "agent" | "organization" | null
broadcasts(doc);          // one keyed object per show, `###` groups split apart
guest(doc);               // the Guest keys, or null
```

Nothing is required and nothing is dropped. An unknown identity key, an unknown section and a
second prose paragraph all survive a parse and a render. Section titles are kept verbatim and
normalised separately (`Find me` is `accounts`), as rule 4 says.

## Write

```ts
import { makeOpenProfile, keyedSection, listSection, renderOpenProfile } from "@profullstack/openprofile";

const md = renderOpenProfile(makeOpenProfile({
  name: "Ada Lovelace",
  identity: { Kind: "person", Web: "https://ada.example", Avatar: image },
  headline: "Host of The Analytical Engine.",
  sections: [
    listSection("Accounts", ["https://bsky.app/profile/ada.example"]),
    listSection("Topics", categories),
    keyedSection("Broadcast", { Show: title, Kind: "podcast", Feed: feedUrl, Listen: page, Topics: categories.join(", ") }),
  ],
}));
```

Absence is unstated: a null or empty value is not written, an empty section is not written.
Known sections come out in the spec's order.

## Let the person correct it

A generated profile is the app's claim. The person it is about corrects it with an overlay, and the
overlay is the same shape over the API, the CLI, the MCP tool and the web form:

```ts
import { applyOverrides, overridesFromDocument, mergeOverrides } from "@profullstack/openprofile";

const shown = applyOverrides(generated, overrides);
// overrides = { name?, headline?, prose?, identity?: { Email: null, Location: "London" },
//               sections?: { guest: "- **Available**: yes", colophon: "none" } }
```

The owner's identity keys, headline and sections win; a section the owner did not touch is still
generated; a section written as the single word `none` is removed. A whole edited file becomes an
overlay with `overridesFromDocument(markdown, generated)`, so `PUT` of Markdown and `PUT` of JSON
store the same thing. `mergeOverrides(base, patch)` is the partial update.

## De-duplicate and merge

```ts
import { identityKeys, samePerson, mergeProfiles, normaliseUrl } from "@profullstack/openprofile";

identityKeys(doc);        // ["web:ada.example", "account:github.com/ada", "email:ada@example.com"]
samePerson(a, b);         // true when they share one key; a shared name never counts
mergeProfiles([a, b]);    // first document's identity wins, Accounts and Topics unioned,
                          // Broadcast sections kept apart as `### <show>` groups
```

`normaliseUrl` lowercases the host, drops `www.`, the scheme, tracking keys, the fragment and the
trailing slash, so `HTTPS://www.GitHub.com/Ada/?utm_source=x` and `github.com/ada` are one key.

## Constants

`MEDIA_TYPE` (`text/markdown; charset=utf-8`), `LINK_REL` (`openprofile`), `WELL_KNOWN_PATH`
(`/.well-known/openprofile.md`), `EDIT_SCOPE` (`openprofile:edit`, the OpenAccess scope an app asks
for to edit a profile on the person's behalf).

## License

MIT.
