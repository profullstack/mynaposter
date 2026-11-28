# myna in the Claude and ChatGPT directories

Everything both submissions ask for, ready to paste. Server: `https://mynaposter.com/api/mcp`
(Streamable HTTP, OAuth 2.1 with DCR + PKCE S256, RFC 9728 protected-resource metadata,
RFC 9207 `iss` on the authorization response). Every tool carries a title and
readOnly/destructive/idempotent/openWorld annotations (`apps/api/src/hosted-mcp.ts`).

A signed-in account that is not an operator gets the hosted tools for its own account
(9 tools); operators get the posting toolset. Reviewers are ordinary accounts: never add a
reviewer to `MYNA_MCP_OPERATORS` (that lets it post as Profullstack).

## Pricing (both)

Free: 100 credits every calendar month (UTC, no rollover). Pay as you go: $0.01 per credit,
packs of $5 / $20 / $50 (any amount $5 to $500), bought with CoinPay (crypto or PayPal),
never expire. Metered: `myna_analyze_site`, `myna_write_posts`, `myna_suggest_places`
(1 credit each, refunded if the call fails on our side). Everything else is free.
Page: https://mynaposter.com/pricing

## Listing copy (both)

- **Name:** myna
- **Slug:** myna
- **One-liner (200):** Write social posts for any network with AI, then save the one you pick as a hand-off card you open on any device to copy and post. 100 free credits a month.
- **Description (2000):**
  myna writes social media posts for you. Give it your product's website and it reads it into a
  brief; ask for posts and it writes ready-to-post variations shaped for Bluesky, LinkedIn, X,
  Mastodon, Threads, Reddit, Hacker News, dev.to and more, or a reply to a thread you paste. It
  can suggest where a project should be posted. Nothing is posted for you from the cloud: save
  the draft you like as a hand-off card, a private link you open on your phone or laptop to copy
  the text, open the network's composer and mark it done. Your social accounts never reach our
  servers. To post automatically, run myna on your own computer (terminal app, CLI or desktop).
  Pricing: 100 free credits every month; reading a site, writing posts and suggesting places cost
  1 credit each; more credits are $0.01 each with CoinPay (crypto or PayPal). Made by Profullstack, Inc.
- **Categories:** Sales and marketing, Productivity, Communication, Creative
- **Author:** Profullstack, Inc. — https://profullstack.com
- **Icon:** https://mynaposter.com/brand/myna-mark-512.png (server favicon also fine)
- **Documentation:** https://mynaposter.com/pricing (connect + plans); source https://github.com/profullstack/mynaposter
- **Support:** hello@profullstack.com
- **Privacy policy:** https://mynaposter.com/privacy — **Terms:** https://mynaposter.com/terms

## Use cases and example prompts (Claude step 4, ChatGPT test cases)

1. **Launch posts** — "Read https://mynaposter.com and write 3 Bluesky posts announcing it, with the link."
2. **Save and post later** — "Save the second one as a hand-off card for Bluesky so I can post it from my phone."
3. **Where to post** — "Where should I post about a terminal social media manager? Then write a Reddit post for the best subreddit, with a title."
4. **Reply** — "Write a helpful reply to this Hacker News comment about cross-posting tools: <paste>."
5. **Credits** — "How many myna credits do I have left?" / "Give me a link to buy $5 of myna credits."

Prerequisites: a free myna account (create one on the sign-in screen). Read/write: read_write
(it creates and deletes the account's own hand-off cards; it posts nothing anywhere).

## Reviewer access

Test account `riotcoder@profullstack.com`; password in logicsrc vault `mynaposter-test--prod`
(`MYNA_TEST_PASSWORD`). It is a normal account (not an operator) with the free monthly credits;
top it up with `credits.ledger().grant(...)` if a review needs more. Paste the login into the
reviewer field (Claude: step 6 Additional notes; ChatGPT: test credentials).

## Claude Connectors Directory (claude.ai/directory/manage)

1. Source: Add custom connector — Name `myna`, URL `https://mynaposter.com/api/mcp`, auth
   Always required, OAuth, Register automatically (DCR). If the connector already exists,
   DELETE and re-add it so the tool list is fresh (the portal caches it).
2. Content: 9 tools, all annotated. Self-test every tool in a claude.ai chat before ticking "self-tested".
3. Listing / 4. Test & launch: copy above.
5. Data handling: API ownership = we own it (first party); personal health data = No;
   sponsored content = No.
6. Compliance: Profullstack, Inc., https://profullstack.com. Policy notes:
   - **Money:** myna does not transfer money or crypto. `myna_buy_credits` only returns a CoinPay
     checkout link; the person pays on CoinPay's own page.
   - **Media generation:** text only; no image, video or audio generation.
   - **Model instructions:** tool descriptions and server instructions talk only about myna's own
     tools and data.
7. Submit. Approved listings wait under "Ready to publish": open /directory/manage/myna, Publish.

## ChatGPT (platform.openai.com/plugins)

Blocked until Anthony completes the Persona developer identity check (the Profullstack, Inc. org
is verified; the developer identity is separate).

- One MCP server per plugin: `https://mynaposter.com/api/mcp`, OAuth, no custom headers.
- OAuth redirect `https://chatgpt.com/connector_platform_oauth_redirect`: accepted by DCR as is;
  `iss` is returned on the authorization response (`authorization_response_iss_parameter_supported`).
- Domain verification: OpenAI gives a token during upload; serve it at
  `https://mynaposter.com/.well-known/openai-apps-challenge` (add it to `apps/web` assets and deploy).
- Tool annotations: explicit booleans are already on every tool.
- Listing copy, use cases, privacy, terms, support and reviewer access: as above.
