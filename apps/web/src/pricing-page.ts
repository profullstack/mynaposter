/**
 * /pricing: the hosted MCP's plans (free every month, then pay as you go with
 * CoinPay) and how to connect it from Claude, ChatGPT or any MCP client.
 * Static; assets/pricing.js adds the signed-in balance and the buy buttons.
 */
import { shell } from "./legal-pages.ts";

export const MCP_URL = "https://mynaposter.com/api/mcp";

export function renderPricingPage(free = 100): string {
  const body = `
<h2>myna in Claude, ChatGPT and any MCP client</h2>
<p>Connect myna to your AI assistant and ask it to read your product's site, write posts shaped for each network, suggest where to post, and save the one you pick as a hand-off card: a private link you open on any device to copy the text, open the network and mark it done. Nothing is posted for you from the cloud: your social accounts never reach our servers. To post automatically, run <a href="/">myna</a> on your own computer.</p>

<h2>Plans</h2>
<table class="plans">
<thead><tr><th></th><th>Free</th><th>Pay as you go</th></tr></thead>
<tbody>
<tr><th>Price</th><td>$0</td><td>$0.01 per credit, packs from $5</td></tr>
<tr><th>Credits</th><td>${free} every month (UTC, no rollover)</td><td>Bought credits never expire; used after the monthly ones</td></tr>
<tr><th>Read a website (<code>myna_analyze_site</code>)</th><td colspan="2">1 credit</td></tr>
<tr><th>Write posts (<code>myna_write_posts</code>, up to 10 variations)</th><td colspan="2">1 credit</td></tr>
<tr><th>Suggest where to post (<code>myna_suggest_places</code>)</th><td colspan="2">1 credit</td></tr>
<tr><th>Hand-off cards, account, buying credits</th><td colspan="2">Free</td></tr>
<tr><th>Payment</th><td>None</td><td>CoinPay: crypto or PayPal. No subscription, no card on file.</td></tr>
</tbody>
</table>

<section id="credits" class="credits" hidden>
<h2>Your credits</h2>
<p id="credits-status">Checking your account...</p>
<p id="credits-buy" hidden>Buy:
  <button type="button" data-usd="5">$5 (500 credits)</button>
  <button type="button" data-usd="20">$20 (2,000 credits)</button>
  <button type="button" data-usd="50">$50 (5,000 credits)</button>
</p>
<p id="credits-note" class="fineprint"></p>
</section>
<p id="credits-signin" class="fineprint">Signed in to myna? Your balance and the buy buttons show here. <a href="/dashboard">Sign in</a>. You can also ask your assistant: "how many myna credits do I have?" or "buy $5 of myna credits".</p>

<h2>Connect</h2>
<p>Server URL: <code>${MCP_URL}</code>. Sign in with your myna account when asked (OAuth); there is no key to paste.</p>
<ul>
<li><strong>Claude</strong> (claude.ai, Desktop, mobile): Settings, Connectors, Add custom connector, paste the URL. Claude Code: <code>claude mcp add --transport http myna ${MCP_URL}</code></li>
<li><strong>ChatGPT</strong>: Settings, Apps and connectors, Add (developer mode), paste the URL.</li>
<li><strong>Anything else</strong> that speaks MCP over Streamable HTTP with OAuth 2.1: point it at the URL.</li>
</ul>

<h2>Fine print</h2>
<p>A credit is spent when a metered tool runs; if it fails on our side, the credit is refunded automatically. Unused monthly credits do not carry over; bought credits do not expire. Purchases are final once the payment confirms, except where the law says otherwise; write to <a href="mailto:hello@profullstack.com">hello@profullstack.com</a> if something went wrong. See the <a href="/terms">terms</a> and the <a href="/privacy">privacy policy</a>.</p>
<script src="/pricing.js" defer></script>
`;
  return shell(
    "Pricing",
    `myna's hosted MCP for Claude, ChatGPT and any MCP client: ${free} free credits every month, then pay as you go with CoinPay.`,
    "/pricing",
    body,
  );
}
