/**
 * The OpenConnection page at mynaposter.com/connect.
 *
 * Where a person signs in, chooses what an app may do, and copies the setup
 * token to paste into it; and where the apps holding a connection are listed
 * with a revoke beside each. One static shell; `connect.js` talks to the API
 * under the same origin. The site's CSP rules out anything inline, so the
 * script and the stylesheet are files, like the hand-off page.
 */

export function renderConnectPage(apiBase: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect an app &mdash; myna</title>
<meta name="description" content="Make a setup token for an app that acts through your myna: DefPromo and anything else that speaks OpenConnection.">
<meta name="robots" content="noindex">
<link rel="canonical" href="https://mynaposter.com/connect">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/connect.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body><header class="top"><a class="wordmark" href="/"><img src="/brand/myna-mark.svg" alt="" width="28" height="28">myna</a></header>
<main class="connect" data-api="${apiBase}">
<section class="hero">
  <p class="eyebrow">OpenConnection</p>
  <h1>Connect an app to your myna.</h1>
  <p class="lede">A setup token you paste. The app claims it once and acts through myna with a bearer you can revoke here. No password leaves this page, no key lives in the app. The protocol is <a href="https://logicsrc.com/openconnection">OpenConnection</a>; the first app is <a href="https://defpromo.com">DefPromo</a>.</p>
</section>

<section id="signin" class="panel">
  <h2>Sign in</h2>
  <p class="fineprint">The same account as <code>myna cloud login</code>. New here? The same form makes one.</p>
  <form id="login-form">
    <label>Email <input id="email" type="email" autocomplete="username" required></label>
    <label>Password <input id="password" type="password" autocomplete="current-password" minlength="12" required></label>
    <div class="actions">
      <button type="submit" id="login">Sign in</button>
      <button type="button" id="signup" class="quiet">Create account</button>
    </div>
  </form>
  <p id="signin-note" class="status" role="status" aria-live="polite"></p>
</section>

<section id="account" class="panel" hidden>
  <p class="fineprint">Signed in as <strong id="who"></strong>. <button type="button" id="logout" class="link-button">Sign out</button></p>

  <h2>Make a setup token</h2>
  <p>Tick what the app may do. The token works once and expires; the app keeps the bearer it claims until you revoke it below.</p>
  <fieldset id="scopes"><legend>Scopes</legend></fieldset>
  <label class="inline">Valid for
    <select id="minutes">
      <option value="15" selected>15 minutes</option>
      <option value="60">1 hour</option>
      <option value="1440">24 hours</option>
    </select>
  </label>
  <div class="actions"><button type="button" id="make">Make a setup token</button></div>
  <div id="token-block" class="block" hidden>
    <div class="block-head"><span>Paste this into the app</span><span id="expires"></span></div>
    <textarea id="token" readonly aria-label="Setup token" spellcheck="false" rows="3"></textarea>
    <div class="actions"><button type="button" id="copy">Copy</button><span id="copy-note" class="status" role="status" aria-live="polite"></span></div>
    <p class="fineprint">In DefPromo: Settings &rarr; Provider &rarr; myna &rarr; paste &rarr; Connect.</p>
  </div>

  <h2>Connected apps</h2>
  <p id="apps-empty" class="fineprint">No app holds a connection yet.</p>
  <ul id="apps" class="apps"></ul>
  <p id="apps-note" class="status" role="status" aria-live="polite"></p>
</section>

<section class="panel">
  <h2>From the terminal</h2>
  <pre><code>myna connect token            # a setup token, to paste
myna connect apps             # who holds a connection
myna connect revoke &lt;id&gt;      # cut one off</code></pre>
  <p class="fineprint">The descriptor is at <a href="/.well-known/openconnection.json"><code>/.well-known/openconnection.json</code></a>.</p>
</section>
</main>
<script src="/connect.js"></script>
</body></html>
`;
}
