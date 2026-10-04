/**
 * Forgot password, for the myna cloud account.
 *
 *   POST /v1/cloud/password/forgot {email}            mail a reset link
 *   POST /v1/cloud/password/reset  {token, password}  set it, sign in
 *
 * The link is https://mynaposter.com/dashboard#reset=<token>. The token
 * sits in the fragment, so it never reaches a server log, a proxy or a
 * Referer header; the dashboard's script reads it and posts it back.
 *
 * What holds:
 *   - "forgot" answers the same for an address with an account and one
 *     without, so it cannot be used to ask who has an account.
 *   - The token is stored hashed, lives 60 minutes and works once. Asking
 *     again retires the earlier links.
 *   - Setting the password revokes every token the account had, so a
 *     session on a lost laptop or a stolen CLI token dies with the old
 *     password, and the browser that did the reset gets a fresh one.
 *   - At most RESET_HOURLY_CAP mails per address per hour, so the form
 *     cannot be used to flood somebody's inbox.
 *
 * The mail goes through the same Resend account hosted sending uses
 * (RESEND_API_KEY, MYNA_MAIL_FROM). Without the key "forgot" answers 503
 * rather than pretending a mail is on its way.
 */
import { db } from "./db/index.ts";
import { hashPassword, hashToken, newToken, normalizeEmail } from "./credentials.ts";
import { hostedConfig, type HostedConfig } from "./mail.ts";
import { siteUrl } from "./handoff.ts";

export const RESET_TTL_MINUTES = 60;
export const RESET_HOURLY_CAP = 3;

/** The link a reset mail carries. The token goes in the fragment, never the query. */
export function resetLink(token: string, site = siteUrl()): string {
  return `${site}/dashboard#reset=${encodeURIComponent(token)}`;
}

export function resetMail(to: string, link: string): { to: string; subject: string; text: string; html: string } {
  const text = [
    "Somebody asked to reset the password on the myna cloud account for this address.",
    "",
    "Set a new one here (the link works once, for the next hour):",
    link,
    "",
    "If that was not you, ignore this mail. Your password has not changed.",
    "",
    "myna, mynaposter.com",
  ].join("\n");
  const safe = link.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const html = `<p>Somebody asked to reset the password on the myna cloud account for this address.</p>
<p><a href="${safe}">Set a new password</a> (the link works once, for the next hour).</p>
<p>If that was not you, ignore this mail. Your password has not changed.</p>
<p>myna, <a href="https://mynaposter.com">mynaposter.com</a></p>`;
  return { to, subject: "Reset your myna password", text, html };
}

/** Send one mail through Resend. Throws on anything but a 2xx. */
export async function sendResetMail(
  to: string,
  link: string,
  deps: { config?: HostedConfig; fetch?: typeof fetch } = {},
): Promise<void> {
  const config = deps.config ?? hostedConfig();
  const mail = resetMail(to, link);
  const response = await (deps.fetch ?? fetch)(`${config.resendUrl}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: config.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend ${response.status}: ${detail.slice(0, 200)}`);
  }
}

export type ForgotReply = { status: 200; body: { ok: true } } | { status: 400 | 503; body: { ok: false; error: string } };

/**
 * Mint a reset token for the address and mail it. Answers ok whether or
 * not the address has an account; only a malformed address or a server
 * with no mail is an error.
 */
export async function forgotPassword(
  email: string,
  deps: { config?: HostedConfig; send?: (to: string, link: string) => Promise<void> } = {},
): Promise<ForgotReply> {
  const config = deps.config ?? hostedConfig();
  if (!config.apiKey) return { status: 503, body: { ok: false, error: "Password reset mail is off on this instance (no RESEND_API_KEY)." } };

  let address: string;
  try {
    address = normalizeEmail(email);
  } catch (error) {
    return { status: 400, body: { ok: false, error: (error as Error).message } };
  }

  const ok: ForgotReply = { status: 200, body: { ok: true } };
  const user = (await db()`select id, email from users where email = ${address}`)[0] as { id: string; email: string } | undefined;
  if (!user) return ok;

  const recent = (await db()`
    select count(*)::int as n from password_resets
    where user_id = ${user.id} and created_at > now() - interval '1 hour'
  `)[0] as { n: number };
  // Over the cap the answer is still ok: saying otherwise would confirm the account.
  if (recent.n >= RESET_HOURLY_CAP) return ok;

  const token = newToken();
  await db()`update password_resets set used_at = now() where user_id = ${user.id} and used_at is null`;
  await db()`
    insert into password_resets (user_id, token_hash, expires_at)
    values (${user.id}, ${hashToken(token)}, now() + make_interval(mins => ${RESET_TTL_MINUTES}))
  `;
  const send = deps.send ?? ((to: string, link: string) => sendResetMail(to, link, { config }));
  try {
    await send(user.email, resetLink(token));
  } catch (error) {
    // Logged for the operator, never shown: the reply has to look the same.
    console.error(`password reset mail failed: ${(error as Error).message}`);
  }
  return ok;
}

/**
 * Spend a reset token: set the new password, revoke every token the
 * account had, and mint one for the browser that did it.
 */
export async function resetPassword(token: string, password: string): Promise<{ user: { id: string; email: string }; token: string }> {
  const stored = hashPassword(password);
  const dead = new Error("That reset link has expired or was already used. Ask for a new one.");
  if (!token) throw dead;

  return db().begin(async (sql) => {
    const rows = (await sql`
      update password_resets set used_at = now()
      where token_hash = ${hashToken(token)} and used_at is null and expires_at > now()
      returning user_id
    `) as unknown as { user_id: string }[];
    const userId = rows[0]?.user_id;
    if (!userId) throw dead;

    const users = (await sql`
      update users
      set password_hash = ${stored.hash}, password_salt = ${stored.salt}, password_params = ${sql.json(stored.params as never)}
      where id = ${userId}
      returning id, email
    `) as unknown as { id: string; email: string }[];
    await sql`update password_resets set used_at = now() where user_id = ${userId} and used_at is null`;
    await sql`delete from api_tokens where user_id = ${userId}`;

    const session = newToken();
    await sql`insert into api_tokens (user_id, token_hash, name) values (${userId}, ${hashToken(session)}, 'web')`;
    return { user: users[0] as { id: string; email: string }, token: session };
  }) as Promise<{ user: { id: string; email: string }; token: string }>;
}
