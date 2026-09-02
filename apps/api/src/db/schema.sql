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
