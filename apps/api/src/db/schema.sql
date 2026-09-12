-- myna hosted schema.
--
-- The local CLI keeps everything in ~/.config/myna; this is the shape when
-- myna runs as a service for more than one person. Credentials arrive already
-- encrypted by the same AES-256-GCM envelope the local vault uses, so the
-- database never holds a usable token.

create table if not exists users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique,
  created_at   timestamptz not null default now()
);

create table if not exists api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  -- sha256 of the token. The token itself is shown once, at creation.
  token_hash   text not null unique,
  name         text not null default 'default',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists api_tokens_user_idx on api_tokens(user_id);

create table if not exists accounts (
  id           text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  network      text not null,
  handle       text not null,
  display_name text,
  -- The encrypted envelope: {iv, tag, data}. Never plaintext.
  creds        jsonb not null,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (user_id, network, handle)
);

create index if not exists accounts_user_idx on accounts(user_id);

create table if not exists queued_posts (
  id            text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  scheduled_for timestamptz not null,
  targets       text[] not null,
  text          text not null,
  title         text,
  media_paths   text[],
  extra         jsonb not null default '{}'::jsonb,
  thread        boolean not null default true,
  status        text not null default 'pending',
  attempts      integer not null default 0,
  last_error    text,
  results       jsonb,
  created_at    timestamptz not null default now()
);

-- The scheduler's hot query is "pending and due", so index exactly that.
create index if not exists queued_posts_due_idx
  on queued_posts (scheduled_for)
  where status = 'pending';

create index if not exists queued_posts_user_idx on queued_posts(user_id, created_at desc);

create table if not exists post_history (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  account_id  text not null,
  network     text not null,
  handle      text not null,
  text        text not null,
  ok          boolean not null,
  post_id     text,
  url         text,
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists post_history_user_idx on post_history(user_id, created_at desc);

-- Cloud backup.
--
-- The blob is a myna bundle, already sealed on the client with a passphrase
-- that never leaves that machine. The server stores ciphertext it cannot read,
-- so a full compromise here leaks no social token. That is the whole design:
-- "cloud backup" must not mean "trust the server with every account you have".
create table if not exists backups (
  user_id     uuid primary key references users(id) on delete cascade,
  -- The sealed bundle, verbatim. Opaque to this side.
  blob        text not null,
  -- Readable header the client also stores in the clear, so `cloud status`
  -- can say what is up there without the passphrase.
  meta        jsonb not null default '{}'::jsonb,
  bytes       integer not null,
  updated_at  timestamptz not null default now()
);

-- Passwords, for the devices magic links and passkeys cannot reach.
-- scrypt with a per-user salt; the parameters travel with the row so they can
-- be raised later without invalidating every existing password.
alter table users add column if not exists password_hash text;
alter table users add column if not exists password_salt text;
alter table users add column if not exists password_params jsonb;

-- The reshare network.
--
-- A profile is the person's OpenProfile.md, verbatim, plus the fields the
-- matcher reads out of it so a query can narrow before the scorer runs. The
-- Markdown is canonical; the columns are regenerated from it on every PUT.
create table if not exists reshare_profiles (
  user_id      uuid primary key references users(id) on delete cascade,
  markdown     text not null,
  name         text,
  handle       text,
  topics       text[] not null default '{}',
  refused      text[] not null default '{}',
  networks     text[] not null default '{}',
  accounts     text[] not null default '{}',
  rate_usd     numeric(10, 4) not null default 0,
  per_day      integer not null default 3,
  pay          text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- "Please reshare this": the post as it exists on each network, a link any
-- network can quote, the topics, and what the author offers per reshare.
create table if not exists reshare_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  title        text,
  text         text,
  topics       text[] not null default '{}',
  posts        jsonb not null default '[]'::jsonb,
  link         text,
  bounty_usd   numeric(10, 4) not null default 0,
  max_sharers  integer not null default 10,
  status       text not null default 'open',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days'
);

create index if not exists reshare_requests_open_idx
  on reshare_requests (created_at desc)
  where status = 'open';

create index if not exists reshare_requests_user_idx on reshare_requests(user_id, created_at desc);

-- One sharer, one request, one network. Claimed when the sharer's myna picks
-- it up, done or failed when it reports back, paid when the author says so.
create table if not exists reshare_claims (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references reshare_requests(id) on delete cascade,
  sharer_id    uuid not null references users(id) on delete cascade,
  network      text not null,
  status       text not null default 'claimed',
  result_url   text,
  error        text,
  bounty_usd   numeric(10, 4) not null default 0,
  created_at   timestamptz not null default now(),
  done_at      timestamptz,
  paid_at      timestamptz,
  pay_ref      text,
  unique (request_id, sharer_id, network)
);

create index if not exists reshare_claims_request_idx on reshare_claims(request_id);
create index if not exists reshare_claims_sharer_idx on reshare_claims(sharer_id, created_at desc);
