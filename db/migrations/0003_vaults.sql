create table vaults (
  id text primary key,
  owner_user_id text not null unique references users(id) on delete cascade,
  crypto_version integer not null check (crypto_version = 1),
  kdf_algorithm text not null check (kdf_algorithm = 'argon2id'),
  kdf_salt text not null,
  kdf_params jsonb not null,
  password_envelope jsonb not null,
  recovery_envelope jsonb not null,
  recovery_key_checksum text not null,
  recovery_confirmed_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index vaults_owner_user_unique on vaults (owner_user_id);

update system_metadata
set value = '{"version":4}'::jsonb, updated_at = now()
where key = 'schema_version';
