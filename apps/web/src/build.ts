/**
 * Builds the marketing site into public/.
 *
 * The network table and the counts are generated from the registry rather than
 * typed into the HTML, so the site cannot claim support for something that was
 * removed. The screenshots are real frames rendered through hqtui's HTML
 * renderer, not mockups.
 */
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToHtml } from "@profullstack/hqtui";
import { NETWORKS, authSummary } from "@profullstack/myna-core";
import { composeScreenshot, loginScreenshot } from "./screens.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = join(root, "public");
mkdirSync(out, { recursive: true });

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const byCategory = (category: string) => NETWORKS.filter((network) => network.category === category);

const passwordNetworks = NETWORKS.filter((network) => network.auth.kind === "password");
const oauthNetworks = NETWORKS.filter((network) => network.auth.kind === "oauth2");
const deviceNetworks = NETWORKS.filter((network) => network.auth.kind === "device");

const networkRows = NETWORKS.map(
  (network) => `<tr>
    <td><code>${network.id}</code></td>
    <td>${escape(network.name)}</td>
    <td>${escape(authSummary(network))}</td>
    <td class="num">${network.caps.charLimit || "&mdash;"}</td>
  </tr>`,
).join("\n");

const shot = (view: Parameters<typeof renderToHtml>[0], width: number, height: number) =>
  renderToHtml(view, { width, height, fontSize: 13, padding: 14, theme: "dark" });

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>myna &mdash; post to every social network from your terminal</title>
<meta name="description" content="A terminal social media manager. Log in, write, schedule and post to ${NETWORKS.length} networks from one TUI, one CLI or a desktop app.">
<link rel="stylesheet" href="/site.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" type="image/png" sizes="512x512">
<link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/icons/favicon-16.png" type="image/png" sizes="16x16">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180x180.png">
<link rel="apple-touch-icon" sizes="152x152" href="/icons/apple-touch-icon-152x152.png">
<link rel="apple-touch-icon" sizes="144x144" href="/icons/apple-touch-icon-144x144.png">
<link rel="apple-touch-icon" sizes="120x120" href="/icons/apple-touch-icon-120x120.png">
<link rel="apple-touch-icon" sizes="76x76" href="/icons/apple-touch-icon-76x76.png">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#080d1a">
<meta name="apple-mobile-web-app-title" content="myna">
<meta name="msapplication-TileColor" content="#080d1a">
<meta name="msapplication-config" content="/browserconfig.xml">
<meta name="msapplication-TileImage" content="/icons/apple-touch-icon-144x144.png">
<meta property="og:title" content="myna">
<meta property="og:description" content="Post to ${NETWORKS.length} social networks from your terminal.">
<meta property="og:url" content="https://mynaposter.com">
<meta property="og:type" content="website">
<meta property="og:image" content="https://mynaposter.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
</head>
<body>

<header class="top">
  <a class="wordmark" href="/"><img src="/brand/myna-mark.svg" alt="" width="28" height="28">myna</a>
  <nav>
    <a href="#networks">Networks</a>
    <a href="#cli">CLI</a>
    <a href="#writer">Writer</a>
    <a href="https://github.com/profullstack/mynaposter">GitHub</a>
  </nav>
</header>

<main>

<section class="hero">
  <h1>Post to every network<br>from your terminal.</h1>
  <p class="lede">
    myna is a social media manager that lives where you already work. Connect an account,
    write once, and it goes everywhere &mdash; tailored to each network's limits, not truncated
    to the smallest one.
  </p>
  <div class="install">
    <code id="install">curl -fsSL https://mynaposter.com/install.sh | sh</code>
    <button id="copy" type="button" aria-label="Copy install command">Copy</button>
  </div>
  <p class="fineprint">
    A single binary with its runtime built in &mdash; no Bun, Node or npm needed.
    Linux, macOS and Windows. Already have a package manager?
    <code>bun add -g @profullstack/myna</code>.
    <a href="/install.sh">Read the script</a> before you pipe it, as you should with any of these.
  </p>
  <p class="fineprint">${NETWORKS.length} networks. Credentials encrypted on your own machine. MIT.</p>
</section>

<section class="shot-wrap">
  ${shot(composeScreenshot, 108, 22)}
  <p class="caption">
    The right pane counts the way each network counts. X reads one character higher than the
    others here because it bills every URL at 23 characters regardless of length.
  </p>
</section>

<section class="grid-3">
  <div>
    <h3>One post, every network</h3>
    <p>
      Character limits, URL weighting, threads where they exist and truncation where they do not.
      A 900-character post becomes a four-part thread on Bluesky, one post on Mastodon, and an
      article on your blog.
    </p>
  </div>
  <div>
    <h3>Schedule and forget</h3>
    <p>
      <code>myna schedule "tomorrow 9am"</code> queues it. The scheduler sends it while the TUI is
      open, or run <code>myna run</code> as a daemon and close the terminal.
    </p>
  </div>
  <div>
    <h3>Read back</h3>
    <p>
      Home timelines, mentions, per-post engagement, and a history of exactly what landed and what
      failed &mdash; with the error, not a shrug.
    </p>
  </div>
</section>

<section id="login">
  <h2>Logging in, honestly</h2>
  <p class="lede narrow">
    Most tools are vague about this, so here it is plainly. <code>myna login &lt;network&gt;</code>
    asks for whatever that network actually accepts.
  </p>

  <div class="split-2">
    <div class="card good">
      <h3>${passwordNetworks.length} take a real password</h3>
      <p>${passwordNetworks.map((network) => escape(network.name)).join(", ")}.</p>
      <p class="small">
        You type a username and a password and you are in. Use an app password where the network
        offers one.
      </p>
    </div>
    <div class="card good">
      <h3>${deviceNetworks.length} show you a code to approve</h3>
      <p>${deviceNetworks.map((network) => escape(network.name)).join(", ")}.</p>
      <p class="small">
        The board prints a short code, you approve it in a browser, and it hands myna a token.
        No password crosses the terminal and no local port has to be free.
      </p>
    </div>
    <div class="card">
      <h3>${oauthNetworks.length} need a browser sign-in</h3>
      <p>${oauthNetworks.map((network) => escape(network.name)).join(", ")}.</p>
      <p class="small">
        Not a limitation of myna. These removed password APIs years ago, and scraping a login
        session breaks without warning and violates their terms. myna does a normal OAuth round
        trip through your browser instead.
      </p>
    </div>
  </div>

  <div class="shot-wrap tight">
    ${shot(loginScreenshot, 92, 17)}
  </div>

  <div class="notice">
    <strong>Two things worth knowing before you plan a workflow.</strong>
    Facebook and Instagram cannot post to a personal profile at all &mdash; Facebook needs a Page you
    administer, Instagram a Business or Creator account linked to one. And Reddit script apps and
    Mastodon's password grant are both refused on accounts with two-factor enabled; those fall back
    to a token.
  </div>
</section>

<section id="cli">
  <h2>A TUI and a CLI, same commands</h2>
  <p class="lede narrow">
    Every slash command in the TUI is also a subcommand, so anything you can do by hand you can put
    in a script or a cron job.
  </p>
  <pre class="code"><code>myna                                  <span class="c"># the TUI</span>
myna login bluesky                    <span class="c"># connect an account</span>
myna post all "the release notes are up"
echo "shipping today" | myna post bluesky,mastodon
myna link https://example.com/post --to all
myna schedule "tomorrow 9am" "good morning" --to mastodon
myna accounts --json | jq '.[].id'</code></pre>
</section>

<section id="writer">
  <h2>An optional writer</h2>
  <div class="split-2">
    <div>
      <p>
        Paste a link and myna reads the page and drafts a post about it, with hashtags that suit
        each network and none where they would look out of place. It drafts; you edit; you post.
        It never posts on its own.
      </p>
      <p class="small">
        Anthropic by default, or OpenAI, or a local model through Ollama. Turned off entirely
        unless you configure a provider &mdash; myna is a perfectly good poster without it.
      </p>
    </div>
    <div>
      <h3>Infographics with real text</h3>
      <p>
        The model picks the copy; myna renders the graphic. The words on the image are exactly the
        words in the copy.
      </p>
      <p class="small">
        This is not a stylistic choice. Ask an image model to draw a chart with labels and it
        rewrites the labels: invented figures, misspelled names, quotes nobody said. Separating the
        two removes that failure rather than hoping against it.
      </p>
    </div>
  </div>
</section>

<section id="networks">
  <h2>${NETWORKS.length} networks</h2>
  <div class="cats">
    <span><strong>Major</strong> ${byCategory("major").length}</span>
    <span><strong>Fediverse</strong> ${byCategory("fediverse").length + byCategory("minor").length}</span>
    <span><strong>Forums</strong> ${byCategory("forum").length}</span>
    <span><strong>Chat</strong> ${byCategory("chat").length}</span>
    <span><strong>Long-form</strong> ${byCategory("blog").length}</span>
  </div>
  <table class="networks">
    <thead><tr><th>Command</th><th>Network</th><th>Login</th><th class="num">Chars</th></tr></thead>
    <tbody>
${networkRows}
    </tbody>
  </table>
</section>

<section class="closing">
  <h2>Where your credentials live</h2>
  <p class="lede narrow">
    In <code>~/.config/myna/vault.json</code>, encrypted with AES-256-GCM, on your machine. There is
    no myna account and no server in the path. The only thing that leaves your computer is the post
    you asked to send.
  </p>
  <div class="install">
    <code>curl -fsSL https://mynaposter.com/install.sh | sh</code>
  </div>
</section>

</main>

<footer>
  <p>
    <a href="https://github.com/profullstack/mynaposter">Source</a> &middot;
    <a href="https://hqtui.com">Built with HQTUI</a> &middot;
    MIT &middot; <a href="https://profullstack.com">Profullstack</a>
  </p>
</footer>

<script src="/site.js"></script>
</body>
</html>
`;

writeFileSync(join(out, "index.html"), page);

writeFileSync(
  join(out, "404.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found &mdash; myna</title><link rel="stylesheet" href="/site.css"></head>
<body><header class="top"><a class="wordmark" href="/"><img src="/brand/myna-mark.svg" alt="" width="28" height="28">myna</a></header>
<main><section class="hero"><h1>Not here.</h1>
<p class="lede">That page does not exist. <a href="/">Back to the start</a>.</p></section></main></body></html>`,
);

// Served at /oauth/callback, for authorizing from a browser that is not on the
// same machine as myna. Loopback redirects cannot reach a myna running over SSH.
mkdirSync(join(out, "oauth"), { recursive: true });
copyFileSync(join(root, "assets", "oauth-callback.html"), join(out, "oauth", "callback.html"));

writeFileSync(
  join(out, "robots.txt"),
  "User-agent: *\nAllow: /\nDisallow: /oauth/\n\nSitemap: https://mynaposter.com/sitemap.xml\n",
);

writeFileSync(
  join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://mynaposter.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`,
);

// A machine-readable description of the product, for the agents that read these.
writeFileSync(
  join(out, "llms.txt"),
  `# myna

> A terminal social media manager. Connect accounts, write once, and post to ${NETWORKS.length}
> networks from a TUI, a scriptable CLI, a desktop app, an HTTP API or MCP.

Install: bun add -g @profullstack/myna
Source: https://github.com/profullstack/mynaposter
Licence: MIT

## Networks

${NETWORKS.map((network) => `- ${network.id} (${network.name}): ${authSummary(network)}, ${network.caps.charLimit || "no"} character limit`).join("\n")}

## How logging in works

${passwordNetworks.length} networks accept a real username and password: ${passwordNetworks.map((n) => n.id).join(", ")}.
${deviceNetworks.length} use a device flow, where you approve a short code in a browser: ${deviceNetworks.map((n) => n.id).join(", ")}.
${oauthNetworks.length} require a browser OAuth flow because they removed password APIs: ${oauthNetworks.map((n) => n.id).join(", ")}.
The rest take a token or app keys you paste in.

## Commands

myna login <network>       connect an account
myna post [target] [text]  post now; target is "all", a network, or an account id
myna schedule <when> [text]  queue for later
myna link <url>            read a link and draft a post about it
myna infographic <input>   build a graphic to attach
myna run                   run the scheduler as a daemon

## MCP

The package @profullstack/myna-mcp exposes myna_accounts, myna_networks, myna_preview,
myna_post, myna_schedule, myna_queue, myna_cancel, myna_history, myna_draft and
myna_timeline. There is deliberately no login tool: connecting an account needs a
password or a browser flow and belongs to a person.
`,
);

mkdirSync(join(out, "brand"), { recursive: true });
mkdirSync(join(out, "icons"), { recursive: true });
for (const asset of [
  "manifest.json", "browserconfig.xml",
  // The icon set for every platform, generated from favicon.png with
  // @profullstack/favicon-generator.
  ...readdirSync(join(root, "assets", "icons")).map((name) => `icons/${name}`),
  "site.css", "site.js", "favicon.svg", "favicon.png", "apple-touch-icon.png", "og.png", "install.sh", "oauth-callback.js",
  // The logo in every form someone might need to reuse it: the bare mark,
  // and the mark with the wordmark for dark and light backgrounds.
  "brand/myna-mark.svg", "brand/myna-mark-1024.png", "brand/myna-mark-512.png", "brand/myna-mark-256.png",
  "brand/myna-logo-dark.svg", "brand/myna-logo-dark-1424.png", "brand/myna-logo-light.svg", "brand/myna-logo-light-1424.png",
]) {
  const source = join(root, "assets", asset);
  if (existsSync(source)) copyFileSync(source, join(out, asset));
}

console.log(`Built ${out} — ${NETWORKS.length} networks, ${passwordNetworks.length} password, ${oauthNetworks.length} oauth`);
