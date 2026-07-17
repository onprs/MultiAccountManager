create table managed_accounts (
  id text primary key,
  owner_user_id text not null references users(id) on delete cascade,
  platform text not null check (platform in ('openai', 'opencode_go', 'antigravity')),
  display_name text not null check (char_length(display_name) between 1 and 120),
  private_payload jsonb not null,
  email_blind_index text,
  email_domain_blind_index text,
  has_totp boolean not null default false,
  local_status text not null default 'active' check (local_status in ('active', 'archived')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index managed_accounts_owner_list_idx
  on managed_accounts (owner_user_id, local_status, created_at desc, id desc)
  where deleted_at is null;
create index managed_accounts_owner_platform_idx
  on managed_accounts (owner_user_id, platform)
  where deleted_at is null;
create index managed_accounts_owner_email_idx
  on managed_accounts (owner_user_id, email_blind_index)
  where deleted_at is null and email_blind_index is not null;
create index managed_accounts_owner_email_domain_idx
  on managed_accounts (owner_user_id, email_domain_blind_index)
  where deleted_at is null and email_domain_blind_index is not null;
create index managed_accounts_owner_display_name_idx
  on managed_accounts (owner_user_id, lower(display_name) text_pattern_ops)
  where deleted_at is null;

create table managed_account_recovery_codes (
  id text primary key,
  managed_account_id text not null references managed_accounts(id) on delete cascade,
  code_ciphertext jsonb not null,
  code_blind_index text not null,
  batch_label_ciphertext jsonb,
  used_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (managed_account_id, code_blind_index)
);

create index managed_account_recovery_codes_account_used_idx
  on managed_account_recovery_codes (managed_account_id, used_at, created_at desc);

update system_metadata
set value = '{"version":5}'::jsonb, updated_at = now()
where key = 'schema_version';
