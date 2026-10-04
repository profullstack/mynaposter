/**
 * The signed-in dashboard at mynaposter.com/dashboard.
 *
 * What it shows today is the hand-off queue: the cards myna made for the
 * steps only a person can do (a Hacker News submit, a subreddit post), open
 * ones first, each with its text, a copy button, the page to paste it into
 * and a done button. The post queue is not here because it is not on the
 * server: queue.json stays on the machine that sends it, and cloud sync
 * deliberately leaves it out.
 *
 * Sign-in is the existing myna cloud email and password, through
 * POST /api/v1/cloud/session, which answers with an HttpOnly cookie the
 * script never sees. One static shell, `dashboard.js` does the rest; the
 * site's CSP rules out anything inline, so script and style are files.
 */

/**
 * `version` goes on the script and stylesheet URLs: the site serves every
 * non-HTML file as immutable for a year, so a changed dashboard.js must have
 * a new URL or a returning browser keeps the old one.
 */
export function renderDashboardPage(apiBase: string, version = ""): string {
  const v = version ? `?v=${encodeURIComponent(version)}` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard &mdash; myna</title>
<meta name="description" content="Your myna hand-off queue: the posts only you can make, ready to copy, paste and mark done.">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<link rel="canonical" href="https://mynaposter.com/dashboard">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/dashboard.css${v}"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body><header class="top"><a class="wordmark" href="/"><img src="/brand/myna-mark.svg" alt="" width="28" height="28">myna</a>
<nav aria-label="Account"><span id="who" class="who" hidden></span><button id="signout" type="button" class="linkish" hidden>Sign out</button></nav></header>
<main class="dash" data-api="${apiBase}">
<p id="status" class="fineprint" role="status" aria-live="polite">Checking your session&hellip;</p>

<section id="signin" class="panel" hidden aria-labelledby="signin-title">
  <h1 id="signin-title">Sign in</h1>
  <p class="fineprint">The same account as <code>myna cloud login</code>. No account yet? Run <code>myna cloud signup</code> in a terminal.</p>
  <form id="signin-form" novalidate>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="actions"><button id="signin-button" type="submit">Sign in</button><button id="forgot-link" type="button" class="linkish">Forgot password?</button></div>
    <p id="signin-note" class="note" role="alert"></p>
  </form>
</section>

<section id="forgot" class="panel" hidden aria-labelledby="forgot-title">
  <h1 id="forgot-title">Reset your password</h1>
  <p class="fineprint">Enter the email on your myna cloud account and we will mail you a link to set a new password. The link works once, for an hour.</p>
  <form id="forgot-form" novalidate>
    <label for="forgot-email">Email</label>
    <input id="forgot-email" name="email" type="email" autocomplete="username" required>
    <div class="actions"><button id="forgot-button" type="submit">Mail me a link</button><button id="forgot-back" type="button" class="linkish">Back to sign in</button></div>
    <p id="forgot-note" class="note" role="status" aria-live="polite"></p>
  </form>
</section>

<section id="reset" class="panel" hidden aria-labelledby="reset-title">
  <h1 id="reset-title">Set a new password</h1>
  <p class="fineprint">At least 10 characters. Every other session and CLI token on the account is signed out, so run <code>myna cloud login</code> again on your machines.</p>
  <form id="reset-form" novalidate>
    <label for="new-password">New password</label>
    <input id="new-password" name="password" type="password" autocomplete="new-password" minlength="10" required>
    <label for="new-password-again">New password, again</label>
    <input id="new-password-again" name="password-again" type="password" autocomplete="new-password" minlength="10" required>
    <div class="actions"><button id="reset-button" type="submit">Set password and sign in</button></div>
    <p id="reset-note" class="note" role="alert"></p>
  </form>
</section>

<section id="board" hidden aria-labelledby="board-title">
  <div class="board-head">
    <h1 id="board-title">Waiting on you</h1>
    <div class="board-tools">
      <label class="toggle"><input id="show-done" type="checkbox"> Show done</label>
      <button id="refresh" type="button" class="quiet">Refresh</button>
    </div>
  </div>
  <p class="fineprint">Steps only you can do: copy the text, open the place, paste it, mark it done. myna makes these with <code>myna handoff add</code>.</p>
  <p id="board-note" class="note" role="status" aria-live="polite"></p>
  <ol id="cards" class="cards"></ol>
  <div id="empty" class="empty" hidden>
    <h2>Nothing waiting on you.</h2>
    <p class="fineprint">When myna needs a person (a Hacker News submit, a subreddit post), the card shows up here.</p>
  </div>

  <h2 class="later">Scheduled</h2>
  <p class="fineprint">Your post queue lives on the machine that sends it, not here. <code>myna queue</code> shows it.</p>
</section>

<noscript><p class="fineprint">The dashboard needs JavaScript. In a terminal, <code>myna handoff list</code> shows the same cards.</p></noscript>
</main>
<script src="/dashboard.js${v}"></script></body></html>`;
}
