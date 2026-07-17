create table users (
  id text primary key,
  name text not null,
  email text not null,
  email_verified boolean not null default false,
  image text,
  role text not null default 'viewer' check (role in ('owner', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index users_email_unique on users (lower(email));
create unique index users_single_owner on users (role) where role = 'owner';

create table sessions (
  id text primary key,
  expires_at timestamptz not null,
  token text not null,
  ip_address text,
  user_agent text,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index sessions_token_unique on sessions (token);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table accounts (
  id text primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references users(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accounts_user_id_idx on accounts (user_id);
create unique index accounts_provider_account_unique on accounts (provider_id, account_id);

create table verifications (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index verifications_identifier_idx on verifications (identifier);

create table passkeys (
  id text primary key,
  name text,
  public_key text not null,
  user_id text not null references users(id) on delete cascade,
  credential_id text not null,
  counter bigint not null,
  device_type text not null,
  backed_up boolean not null,
  transports text,
  created_at timestamptz not null default now(),
  aaguid text
);

create index passkeys_user_id_idx on passkeys (user_id);
create unique index passkeys_credential_id_unique on passkeys (credential_id);

create table audit_events (
  id text primary key,
  actor_user_id text references users(id) on delete set null,
  event_type text not null,
  outcome text not null,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_actor_created_idx on audit_events (actor_user_id, created_at desc);
create index audit_events_type_created_idx on audit_events (event_type, created_at desc);
