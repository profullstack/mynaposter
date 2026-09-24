/**
 * /privacy and /terms for mynaposter.com.
 *
 * Google's OAuth verification reads these: the home page must link the privacy
 * policy, the policy must say exactly what myna does with Google user data, and
 * it must carry the Limited Use statement word for word. Keep the Google
 * section in step with SCOPES in packages/plugin-calendar/src/index.ts.
 */

const UPDATED = "September 24, 2026";

function shell(title: string, description: string, canonical: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} &middot; myna</title>
<meta name="description" content="${description}">
<link rel="canonical" href="https://mynaposter.com${canonical}">
<link rel="stylesheet" href="/site.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<header class="top">
  <a class="wordmark" href="/"><img src="/brand/myna-mark.svg" alt="" width="28" height="28">myna</a>
  <nav><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</header>
<main class="legal">
<section class="hero"><h1>${title}</h1><p class="fineprint">myna, by Profullstack, Inc. Last updated ${UPDATED}.</p></section>
${body}
</main>
<footer><p><a href="/">myna</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a> &middot; <a href="https://profullstack.com">Profullstack</a> &middot; <a href="mailto:hello@profullstack.com">hello@profullstack.com</a></p></footer>
</body>
</html>
`;
}

export function renderPrivacyPage(): string {
  return shell(
    "Privacy Policy",
    "What myna collects, where it is kept, what it does with Google user data, and how to delete it.",
    "/privacy",
    `
<h2>What myna is</h2>
<p>myna is a social media manager that runs on your own computer: a terminal app, a command line tool and a desktop app. You connect your social accounts, write a post once, and myna publishes it to the networks you choose, now or on a schedule. mynaposter.com hosts the website, the installer, the sign-in pages that hand a login back to myna on your machine, and the optional myna cloud service.</p>

<h2>What stays on your computer</h2>
<p>Almost everything. The accounts you connect, and the access tokens and keys for them, are kept in an encrypted vault in myna's configuration folder on your machine (<code>~/.config/myna</code>). Your drafts, your post queue, your posting history and your contacts are stored there too. We do not receive them.</p>

<h2>What reaches us</h2>
<ul>
<li><strong>Visiting the website.</strong> Our hosting provider records standard request logs (IP address, time, the page asked for, browser) for security and troubleshooting, and keeps them for a short time.</li>
<li><strong>Sign-in pages.</strong> When you connect an account, the network sends your browser back to a page on mynaposter.com with a one-time authorization code. The page runs in your browser and hands the code straight to myna on your computer, which exchanges it for a token. The code is single use, expires within minutes, and cannot be used without credentials that stay on your machine. We do not store it.</li>
<li><strong>myna cloud, only if you sign up.</strong> Your email address and a session. If you turn on settings sync, your myna settings, profile and skills (plain text you wrote; never your vault or tokens). If you run <code>myna cloud push</code>, a copy of your connected accounts sealed with a passphrase only you know; we cannot open it. Features you choose to use, such as hand-off cards, directory listings or newsletter subscriber lists, store what they need to work.</li>
<li><strong>Email from us.</strong> Sign-in links and messages you ask for, sent through an email delivery provider.</li>
</ul>

<h2>Third-party services and integrations</h2>
<p>When you post, myna sends your content to the networks you picked, under their own terms and privacy policies. Some integrations work through another provider (for example an advertising, analytics, directory or outreach service you connect or turn on). In those cases myna may need to share certain information with that provider so the feature works, such as your public handle, the link to a post, the text of a listing, or the email address you gave it. myna only shares what that integration needs, only when you have connected or enabled it, and tells you in the app what it sends. We use hosting, database and email delivery providers to run mynaposter.com and myna cloud; they process data only on our behalf.</p>

<h2 id="google">Google user data</h2>
<p>myna can connect to Google Calendar, only if you choose to. When you run <code>myna login gcal</code> and approve access, myna asks for:</p>
<ul>
<li><code>https://www.googleapis.com/auth/calendar.events</code>: to create events you ask for (<code>myna calendar add</code>, or a post to the <code>gcal</code> target), to add an event for each post you schedule and remove it if you cancel the post (<code>myna calendar auto</code>, which you can turn off), to delete an event you name (<code>myna calendar remove</code>), and to show your upcoming events in your terminal when you run <code>myna calendar list</code>.</li>
<li><code>https://www.googleapis.com/auth/calendar.calendarlist.readonly</code>: to find your primary calendar when you sign in, and to list your calendars (<code>myna calendar calendars</code>) so you can pick which one myna writes to.</li>
</ul>
<p>myna reads your events only when you run <code>myna calendar list</code>, and then only the upcoming ones, printed on your own screen; it never changes or deletes an event it did not create unless you name that event in <code>myna calendar remove</code>. Event data goes directly between your computer and Google: it is not sent to mynaposter.com or myna cloud and is not stored by us. The Google access and refresh tokens are stored only in the encrypted vault on your computer; they are not sent to mynaposter.com or myna cloud (unless you run <code>myna cloud push</code>, which uploads them sealed with a passphrase we never see). Google user data is not sold, not used for advertising, not used to train AI or machine learning models, and not shared with anyone except as needed to provide the calendar feature you turned on or as required by law.</p>
<p><strong>myna's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</strong></p>
<p>To disconnect, run <code>myna logout gcal:&lt;your address&gt;</code>, which deletes the tokens from your computer, and remove myna at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Events myna already created stay in your calendar until you delete them.</p>

<h2>How long we keep things</h2>
<p>Data on your computer stays until you delete it or uninstall myna. myna cloud data stays while your account exists; delete your account (or email us) and we delete it within 30 days, apart from what we must keep by law. Request logs are kept for a short time and then discarded.</p>

<h2>Your choices and rights</h2>
<p>You can use myna without a myna cloud account. You can see, export or delete your myna cloud data, or ask us to, by emailing <a href="mailto:hello@profullstack.com">hello@profullstack.com</a>. Depending on where you live you may have further rights (for example under the GDPR or CCPA); we honour them. We do not sell personal information.</p>

<h2>Security</h2>
<p>Credentials are encrypted at rest on your machine, connections to us use HTTPS, and sign-ins use OAuth with PKCE so no password passes through myna. No system is perfectly secure; tell us about a problem at <a href="mailto:hello@profullstack.com">hello@profullstack.com</a>.</p>

<h2>Children</h2>
<p>myna is not meant for children under 13, and we do not knowingly collect their data.</p>

<h2>Changes</h2>
<p>We will update this page when what myna does changes, and change the date at the top. Significant changes will be announced on this site.</p>

<h2>Contact</h2>
<p>Profullstack, Inc. &middot; <a href="mailto:hello@profullstack.com">hello@profullstack.com</a>. This policy sits alongside the <a href="https://profullstack.com/privacy">Profullstack privacy policy</a>; where they differ for myna, this page applies.</p>
`,
  );
}

export function renderTermsPage(): string {
  return shell(
    "Terms of Service",
    "The terms for using myna, mynaposter.com and myna cloud.",
    "/terms",
    `
<h2>The software</h2>
<p>myna is open source under the MIT License (<a href="https://github.com/profullstack/mynaposter">source</a>). You may use, copy and modify it under that license. These terms cover mynaposter.com and the optional myna cloud service that Profullstack, Inc. ("we") runs.</p>

<h2>Your accounts and your content</h2>
<p>You connect your own social and calendar accounts and you are responsible for what you post through them. You keep all rights to your content. You must follow the terms of each network and service you connect; myna publishes on your behalf, not ours.</p>

<h2>Acceptable use</h2>
<p>Do not use myna or myna cloud to send spam, to harass anyone, to break the law or a network's rules, to get around rate limits or bans, or to attack or overload our service or anyone else's. We may suspend a myna cloud account that does.</p>

<h2>Third-party services</h2>
<p>myna works with networks and services we do not control. Some integrations may require sharing certain information with that provider for the feature to work, as described in the <a href="/privacy">privacy policy</a>. Their availability, rules and fees are theirs; if a network changes its API or blocks access, a myna feature may stop working.</p>

<h2>myna cloud</h2>
<p>myna cloud is optional. You are responsible for keeping your sign-in and any passphrase safe; we cannot recover a sealed backup whose passphrase is lost. Paid features, if you buy any, are billed as described when you buy them.</p>

<h2>No warranty</h2>
<p>myna and mynaposter.com are provided "as is", without warranties of any kind. We do not promise that posts will always be delivered, on time or at all, because delivery depends on networks we do not control.</p>

<h2>Limitation of liability</h2>
<p>To the extent the law allows, we are not liable for indirect or consequential losses, lost posts, lost reach or lost data, and our total liability for myna cloud is limited to what you paid us for it in the previous 12 months.</p>

<h2>Changes and ending</h2>
<p>We may update these terms and will change the date at the top when we do. You can stop using myna at any time; we may stop offering a hosted feature with reasonable notice.</p>

<h2>Contact</h2>
<p>Profullstack, Inc. &middot; <a href="mailto:hello@profullstack.com">hello@profullstack.com</a>. See also the <a href="https://profullstack.com/terms">Profullstack terms</a>.</p>
`,
  );
}
