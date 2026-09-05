# Writing a myna plugin

A plugin is an ES module whose default export is a plugin object. myna loads
it at startup, registers whatever it brings, and from then on it is
indistinguishable from something built in.

```js
// index.mjs
export default {
  id: "example",                // lower-case, digits and dashes
  name: "Example",
  version: "1.0.0",
  description: "One line for `myna plugins`.",

  networks: [ /* Network adapters, see below */ ],

  commands: [
    {
      name: "example",          // becomes `myna example ...`
      summary: "One line for `myna help`",
      usage: ["example hello [--name N]   Say hello"],
      async run(args, ctx) {
        ctx.out(`hello ${ctx.flags.name ?? "world"}: ${args.join(" ")}`);
        return 0;               // the exit code; undefined means 0
      },
    },
  ],

  tasks: [
    {
      id: "poll",               // logged as `example.poll` by `myna run`
      everyMs: 15 * 60_000,
      async run(ctx) {
        return "checked";       // a line to log, or nothing to stay quiet
      },
    },
  ],

  seeds: [
    {
      id: "people",
      everyMs: 6 * 3_600_000,   // optional; six hours by default
      async fetch(ctx) {
        return [{ network: "bluesky", handle: "alice.bsky.social", weight: 1.5 }];
      },
    },
  ],
};
```

The default export may also be a function (sync or async) that returns the
object, for a plugin that has to read something before it can describe itself.

## Where plugins come from

| How | What happens |
|---|---|
| `myna plugins add @scope/pkg` | Installs into `~/.config/myna/plugins/node_modules` with npm (or bun), records the name in `settings.plugins` |
| `myna plugins add ./dir` | Records the absolute path. The directory needs a `package.json` `main`, or an `index.ts` / `index.js` / `index.mjs` |
| A package already under `~/.config/myna/plugins/node_modules` | Loads without being configured |
| Bundled | Imported statically by the CLI so it compiles into the binary. `outreachgraph` is one |

A plugin that throws while loading is listed by `myna plugins` with its error
rather than silently missing. `myna plugins remove <id>` forgets a configured
one.

## The context

Every `run` and `fetch` receives a `PluginContext`:

| Member | What it is |
|---|---|
| `out(line)` | Print a line for the person running the command |
| `log(line)` | Log a timestamped line, the way the daemon does |
| `ask(prompt, { secret })` | Ask the person for a value. **Absent** when no one is at a keyboard (the daemon), so check before using it |
| `accounts()` | Every connected account, credentials included. Throws if the vault is locked |
| `settings()` | The current settings |
| `secrets.get() / set(values) / clear()` | This plugin's own secrets, stored in the encrypted vault beside the accounts. Strings only |
| `graph.addSeeds(seeds)` | Feed the follow graph directly |
| `configDir` | `~/.config/myna`. Keep any file of your own under `plugins/<id>/` |
| `flags` | The `--flags` as the CLI parsed them: `--limit 5` is `{ limit: "5" }`, `--json` is `{ json: true }` |

Nothing else reaches a plugin, and a plugin needs to import nothing from myna
at runtime. Add `@profullstack/myna-core` as a dev dependency for the types:

```ts
import type { MynaPlugin, PluginContext, SeedInput } from "@profullstack/myna-core";
```

## Networks

A plugin's `networks` are `Network` objects, the same contract every built-in
adapter implements: `id`, `name`, `category`, `blurb`, `auth` (how to log in
and which fields to ask for), `caps` (what it can do), and the methods those
capabilities promise. `login` and `post` are required; `remove`, `timeline`,
`notifications`, `stats`, `repost`, `search`, `following` and `follow` are
optional and each is gated by a `caps` flag. Read
`packages/core/src/net/types.ts` for the full contract and any adapter under
`packages/core/src/net/adapters/` for a worked example. Registering an id that
already exists replaces the built-in, on purpose.

## Seeds and the daemon

A `SeedProvider` is the simplest useful plugin: return people worth learning
from, and myna does the rest. `myna run` calls `fetch` on its schedule, upserts
the result into the graph (a person already present keeps their expansion
state and takes the new weight), reads who those people follow, and follows
the accounts they agree on within the configured limits. `weight` is how much
a seed's opinion counts; 1 is normal, 2 is twice as much.

A `DaemonTask` is for anything else periodic. Tasks run one at a time, in
order, on the daemon's tick (30 s by default), each when its `everyMs` has
elapsed. Throwing is logged as `<plugin>.<task>  failed: …` and the task runs
again next time; it never stops the loop.

## Secrets

Use `ctx.secrets`, never a file of your own, for anything a person would not
want in plain text. The vault is AES-256-GCM under a local keyfile or a
passphrase; `myna save` and `myna load` do **not** carry plugin secrets between
machines yet, so a plugin should be able to ask for them again.

## Publishing

Name the package `myna-plugin-<something>` or `@scope/myna-plugin-<something>`
and add `myna-plugin` to its keywords so it can be found. `main` should point
at plain JavaScript (or TypeScript: myna runs on Bun, which loads `.ts`
directly). Keep `@profullstack/myna-core` out of `dependencies`; it is a type
dependency only.

The bundled `packages/plugin-outreachgraph` is the reference: a login command
that stores credentials in the vault, a read command, a sync command, and a
seed provider the daemon runs every six hours.
