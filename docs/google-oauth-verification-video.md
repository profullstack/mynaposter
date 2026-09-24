# Google OAuth verification: the demo video (gcal)

Google's review asks for a YouTube video that shows the OAuth grant and, in detail,
how each sensitive or restricted scope is used, for every OAuth client in the
project, with the app's details (name, client id) visible. This is the script for
the **myna** project's one client, the Google Calendar sign-in (`myna login gcal`).

| | |
| --- | --- |
| App name | myna |
| Home page | https://mynaposter.com |
| Privacy policy | https://mynaposter.com/privacy (section "Google user data") |
| OAuth client | `330436882816-3pdvgdvi69usdjlfk56op72f81m76dft.apps.googleusercontent.com` (Web application) |
| Redirect URI | `https://mynaposter.com/api/v1/google/oauth/callback` |
| Scopes (both sensitive) | `calendar.events`, `calendar.calendarlist.readonly` |
| Code | `packages/plugin-calendar/src/index.ts` (`SCOPES`) |

If the project has any other OAuth client (a YouTube one, say), each needs its own
section like part 3, or should be deleted before resubmitting.

## Before recording

- One continuous take, or cuts only between parts. Screen at 1080p, terminal font large
  enough to read on YouTube, browser zoomed to 125%.
- Sign out of the gcal account first so the grant is shown from scratch:
  `myna logout gcal:<address>`, and remove myna at
  https://myaccount.google.com/permissions.
- Have Google Calendar open in a second tab on the same account.
- Upload as **Unlisted** and paste the link into the verification form.
- Narration can be spoken or on-screen captions. English.

## Part 1. The app and the client (about 30 s)

1. Google Cloud console → the myna project → **Google Auth Platform → Branding**.
   Show the app name "myna", the logo, support email, home page and privacy links.
   *"This is myna, a command-line social media manager from Profullstack."*
2. **Clients** → open the Web client. Hold on the client id long enough to read it,
   and the authorized redirect URI.
   *"This is the only OAuth client in the project. myna uses it to connect a Google
   Calendar."*
3. **Data access**. Show the two scopes.
   *"It asks for two sensitive scopes: calendar.events and
   calendar.calendarlist.readonly."*
4. Open https://mynaposter.com/privacy#google and scroll through the Google user data
   section. *"The privacy policy says what each scope is for and that myna follows the
   Limited Use requirements."*

## Part 2. The grant (about 45 s)

1. Terminal: `myna login gcal`. Paste the client id and secret when asked (or it says
   "kept from…" if they are saved). The browser opens Google's consent screen.
2. **Zoom in on the consent screen**: the app name "myna", the account being signed
   in, and both permissions listed. *"The user sees exactly these two permissions."*
3. Click **Continue / Allow**. The browser lands on mynaposter.com, which hands the code
   back to myna on this machine; the terminal prints the connected account.
   *"The code goes back to myna on the user's own computer, which exchanges it for a
   token. The tokens are stored only in myna's encrypted vault on this machine; our
   servers never see them."*
4. `myna accounts` to show `gcal:<address>` connected.

## Part 3. Each scope in use (about 2 min)

### `calendar.calendarlist.readonly`

1. `myna calendar calendars`. The user's calendars are listed.
   *"This scope lets myna find the primary calendar at sign-in and list the calendars
   so the user can choose which one myna writes to. It is read-only and only reads the
   list of calendars."*

### `calendar.events`

Show each use, with the Google Calendar tab next to the terminal:

1. **Create an event the user asks for.**
   `myna calendar add "tomorrow 3pm" "Demo: record the release video" --duration 30m`
   Switch to Google Calendar: the event is there.
2. **An event for a scheduled post (the default mirror).**
   `myna calendar auto on`, then
   `myna schedule "tomorrow 10am" "Demo post for the review" --to bluesky:<handle>`
   (any connected network; step 3 cancels it, so it never goes out).
   Google Calendar shows the post at 10:00. *"When the user schedules a post, myna puts
   it on their calendar so they can see it coming."*
3. **Remove it when the post is cancelled.** `myna cancel <id from the schedule output>`.
   Refresh Google Calendar: the event is gone. *"Cancel the post and myna deletes the
   event it made. It only ever deletes events it created, which it recognises by a
   private tag on the event, or one the user names."*
4. **Show upcoming events.** `myna calendar list --days 7`.
   *"This prints the user's upcoming events in their own terminal. It is the only time
   myna reads events, and the data goes straight from Google to this screen. Nothing is
   sent to our servers or stored."*
5. **Delete an event the user names.** `myna calendar remove <id of the demo event> --yes`,
   refresh Google Calendar. *"And the user can delete an event by id."*
6. `myna calendar auto off`. *"The mirror can be turned off at any time."*

## Part 4. Disconnect (about 20 s)

1. `myna logout gcal:<address>`. *"This deletes the tokens from the computer."*
2. https://myaccount.google.com/permissions → myna → **Remove access**.
   *"And access can be revoked from the Google account at any time."*

## What to write in the form's scope justification

> myna is a command-line tool that runs on the user's own computer. It uses
> `calendar.events` to create events the user asks for, to put each post the user
> schedules on their calendar and remove it when the post is cancelled, to delete an
> event the user names, and to show the user's upcoming events in their own terminal on
> request. It uses `calendar.calendarlist.readonly` to find the primary calendar at
> sign-in and let the user pick which calendar to write to. Narrower scopes do not cover
> this: `calendar.events.owned` would not show the user's own upcoming events, and
> `calendar.app.created` would force a separate calendar instead of the user's own.
> Tokens and event data stay on the user's computer and are never sent to our servers.
