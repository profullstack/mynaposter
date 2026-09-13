/**
 * An AT Protocol account from an OpenProfile, against a fake PDS.
 *
 * What has to hold: the handle comes from the OpenProfile's local part under
 * the server's domain unless a full one is given; a relay, an invite-only
 * server without a code, and a profile with no email each refuse with the
 * reason; the account that comes back is what `myna login bluesky` would
 * have stored; the profile record is the name, the headline, the home page
 * and the topics within Bluesky's limits, keeping fields the OpenProfile
 * does not describe; the avatar is uploaded when it is an image.
 */
import { test, expect } from "bun:test";
import { parseOpenProfile } from "../src/core/openprofile.ts";
import { createAccount, generatePassword, handleFor, identityValue, profileRecordFrom, pushProfile } from "../src/core/atproto-account.ts";

const ADA = parseOpenProfile(`# Ada Lovelace

- **Kind**: person
- **Handle**: @ada.bsky.social
- **Web**: https://ada.example
- **Email**: ada@example.com
- **Avatar**: https://ada.example/ada.png

Writes about machines that do not exist yet.

## Accounts

- [Bluesky](https://bsky.app/profile/ada.bsky.social)

## Topics

- computing, mathematics, poetry
`);

function fakePds(options: { kind?: "pds" | "relay"; invite?: boolean; domains?: string[]; calls?: { url: string; body?: unknown }[] } = {}): typeof fetch {
  const calls = options.calls ?? [];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/_health")) return json({ version: "0.4.0" });
    if (url.endsWith("/xrpc/com.atproto.server.describeServer")) {
      if (options.kind === "relay") return json({ error: "MethodNotImplemented" }, 501);
      return json({ did: "did:web:pds.example", availableUserDomains: options.domains ?? [".pds.example"], inviteCodeRequired: options.invite ?? false });
    }
    if (url.endsWith("/xrpc/com.atproto.server.createAccount")) {
      return json({ did: "did:plc:newada", handle: body.handle, accessJwt: "a", refreshJwt: "r" });
    }
    if (url.endsWith("/xrpc/com.atproto.server.createSession")) return json({ did: "did:plc:newada", handle: body.identifier, accessJwt: "jwt" });
    if (url.includes("/xrpc/com.atproto.repo.getRecord")) return json({ cid: "bafyold", value: { $type: "app.bsky.actor.profile", displayName: "old", banner: { ref: "b" } } });
    if (url.endsWith("/xrpc/com.atproto.repo.uploadBlob")) return json({ blob: { $type: "blob", ref: { $link: "bafyblob" }, mimeType: init?.headers && (init.headers as Record<string, string>)["content-type"], size: 3 } });
    if (url.endsWith("/xrpc/com.atproto.repo.putRecord")) return json({ uri: "at://did:plc:newada/app.bsky.actor.profile/self", cid: "bafynew" });
    if (url === "https://ada.example/ada.png") return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    if (url === "https://ada.example/not-an-image") return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    return json({ error: "NotFound" }, 404);
  }) as unknown as typeof fetch;
}

test("the handle is the OpenProfile local part under the server's domain, unless a full one is given", () => {
  expect(handleFor(ADA, [".pds.example"])).toBe("ada.pds.example");
  expect(handleFor(ADA, [".pds.example"], "lovelace")).toBe("lovelace.pds.example");
  expect(handleFor(ADA, [".pds.example"], "ada.my-domain.example")).toBe("ada.my-domain.example");
  expect(handleFor(ADA, ["pds.example"], "@Ada_Lovelace")).toBe("ada-lovelace.pds.example");
  expect(() => handleFor(ADA, [])).toThrow(/full handle/);
  expect(() => handleFor(parseOpenProfile("# \n"), [".pds.example"])).toThrow(/No handle/);
  expect(identityValue(ADA, "EMAIL")).toBe("ada@example.com");
  expect(identityValue(ADA, "pay")).toBeUndefined();
  expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
});

test("an account is created from the profile and comes back the way login would store it", async () => {
  const calls: { url: string; body?: unknown }[] = [];
  const result = await createAccount({ service: "pds.example", profile: ADA, fetch: fakePds({ calls }) });
  expect(result.did).toBe("did:plc:newada");
  expect(result.service).toBe("https://pds.example");
  expect(result.password).toHaveLength(24);
  expect(result.account).toMatchObject({ id: "bluesky:ada.pds.example", network: "bluesky", handle: "ada.pds.example", displayName: "Ada Lovelace", creds: { password: result.password }, meta: { service: "https://pds.example", did: "did:plc:newada" } });
  const create = calls.find((entry) => entry.url.endsWith("createAccount"));
  expect(create?.body).toEqual({ handle: "ada.pds.example", email: "ada@example.com", password: result.password });
});

test("a relay, an invite-only server without a code, and a profile without an email are refused with the reason", async () => {
  await expect(createAccount({ service: "https://relay.example", profile: ADA, fetch: fakePds({ kind: "relay" }) })).rejects.toThrow(/not a PDS/);
  await expect(createAccount({ service: "https://pds.example", profile: ADA, fetch: fakePds({ invite: true }) })).rejects.toThrow(/invite code/);
  const noEmail = parseOpenProfile("# Bob\n\n- **Handle**: @bob\n");
  await expect(createAccount({ service: "https://pds.example", profile: noEmail, fetch: fakePds() })).rejects.toThrow(/needs an email/);
  const withInvite = await createAccount({ service: "https://pds.example", profile: ADA, inviteCode: "pds-example-abc", email: "other@example.com", fetch: fakePds({ invite: true }) });
  expect(withInvite.account.handle).toBe("ada.pds.example");
});

test("the profile record is the name, headline, web and topics within Bluesky's limits, keeping the rest", () => {
  const record = profileRecordFrom(ADA, { banner: { ref: "b" }, displayName: "old", labels: [] });
  expect(record).toEqual({
    $type: "app.bsky.actor.profile",
    banner: { ref: "b" },
    labels: [],
    displayName: "Ada Lovelace",
    description: "Writes about machines that do not exist yet.\n\nhttps://ada.example\n\ncomputing, mathematics, poetry",
  });
  const long = parseOpenProfile(`# ${"N".repeat(80)}\n\n${"x".repeat(300)}\n`);
  const clipped = profileRecordFrom(long);
  expect(clipped.displayName).toHaveLength(64);
  expect(clipped.description).toHaveLength(256);
  expect(profileRecordFrom(parseOpenProfile("# Only a name\n")).description).toBeUndefined();
});

test("pushing writes the record with the old cid as the swap, and uploads the avatar when it is an image", async () => {
  const calls: { url: string; body?: unknown }[] = [];
  const account = { id: "bluesky:ada.pds.example", network: "bluesky", handle: "ada.pds.example", addedAt: "", creds: { password: "p" }, meta: { service: "https://pds.example", did: "did:plc:newada" } };
  const result = await pushProfile(account, ADA, { fetch: fakePds({ calls }) });
  expect(result.avatar).toBe(true);
  expect(result.record.banner).toEqual({ ref: "b" });
  expect(result.record.displayName).toBe("Ada Lovelace");
  const put = calls.find((entry) => entry.url.endsWith("putRecord"))?.body as Record<string, unknown>;
  expect(put).toMatchObject({ repo: "did:plc:newada", collection: "app.bsky.actor.profile", rkey: "self", swapRecord: "bafyold" });
  expect((put.record as ProfileLike).avatar).toMatchObject({ $type: "blob", mimeType: "image/png" });

  // A dry run reads, builds, and writes nothing.
  const quiet: { url: string; body?: unknown }[] = [];
  const dry = await pushProfile(account, ADA, { fetch: fakePds({ calls: quiet }), dryRun: true });
  expect(dry.avatar).toBe(false);
  expect(quiet.some((entry) => entry.url.endsWith("putRecord") || entry.url.endsWith("uploadBlob"))).toBe(false);

  // An avatar that is not an image is left alone and said so.
  const notImage = parseOpenProfile("# Ada\n\n- **Avatar**: https://ada.example/not-an-image\n");
  const kept = await pushProfile(account, notImage, { fetch: fakePds() });
  expect(kept.avatar).toBe(false);
  expect(kept.avatarNote).toMatch(/not an image/);
});

interface ProfileLike {
  avatar?: unknown;
}
