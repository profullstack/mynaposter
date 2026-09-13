/**
 * The hand-off card page at mynaposter.com/handoff/<id>.
 *
 * One static shell for every card: the id is in the path, the card is read
 * from the API by `handoff.js` once the page is open. Kept as a function
 * returning a string so the build writes it and a test can read it, and
 * because the site's CSP (`script-src 'self'`, `style-src 'self'`) rules out
 * anything inline, which is why the script and the stylesheet are files.
 */

/** `/handoff/<id>`, with the id the API accepts and nothing else. */
const PATH = /^\/handoff\/([A-Za-z0-9_-]{16,64})\/?$/;

/** The card id in a site path, or null when the path is not a card. */
export function handoffPath(pathname: string): string | null {
  return PATH.exec(pathname)?.[1] ?? null;
}

export function renderHandoffPage(apiBase: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hand-off &mdash; myna</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/handoff.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body><header class="top"><a class="wordmark" href="/"><img src="/brand/myna-mark.svg" alt="" width="28" height="28">myna</a></header>
<main class="handoff" data-api="${apiBase}">
<p id="status" class="fineprint">Reading the card&hellip;</p>
<article id="card" hidden>
  <p class="eyebrow"><span id="place"></span><span id="account-wrap" hidden> &middot; from <span id="account"></span></span></p>
  <h1 id="title"></h1>
  <div class="block">
    <div class="block-head"><span>Text to paste</span><span id="count"></span></div>
    <textarea id="text" aria-label="Text to paste" spellcheck="false"></textarea>
  </div>
  <div class="actions">
    <button id="copy" type="button">Copy</button>
    <a id="open" class="link" target="_blank" rel="noopener" hidden>Open</a>
    <button id="done" type="button" class="quiet">Mark done</button>
    <span id="note" class="status" role="status" aria-live="polite"></span>
  </div>
  <ol id="steps" class="steps"></ol>
  <p id="meta" class="fineprint"></p>
</article>
<noscript><p class="fineprint">This page reads the card with JavaScript. Without it, the card is at the API as JSON: the address in the bar with <code>/api/v1</code> in front of the path.</p></noscript>
</main>
<script src="/handoff.js"></script></body></html>`;
}
