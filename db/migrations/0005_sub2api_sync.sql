create table sub2api_connections (
  id text primary key,
  owner_user_id text not null references users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  base_url text not null check (char_length(base_url) between 8 and 2048),
  remote_instance_id text,
  token_ciphertext jsonb not null,
  token_key_id text not null,
  token_hint text not null check (char_length(token_hint) between 6 and 32),
  sync_interval_seconds integer not null default 300 check (sync_interval_seconds between 60 and 86400),
  enabled boolean not null default true,
  etag text,
  cursor text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error_code text,
  last_error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, name)
);

create index sub2api_connections_due_idx
  on sub2api_connections (enabled, last_attempt_at, sync_interval_seconds)
  where enabled = true;

create table remote_account_catalog (
  id text primary key,
  connection_id text not null references sub2api_connections(id) on delete cascade,
  external_account_id text not null,
  external_name text not null,
  external_platform text not null,
  external_type text not null,
  remote_status text not null,
  availability text not null,
  available boolean not null,
  quota jsonb,
  quota_error_code text,
  sanitized_error_code text,
  rate_limit_reset_at timestamptz,
  overload_until timestamptz,
  temp_unschedulable_until timestamptz,
  remote_updated_at timestamptz not null,
  last_seen_at timestamptz not null,
  missing_full_syncs integer not null default 0 check (missing_full_syncs >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_account_id)
);

create index remote_account_catalog_connection_seen_idx
  on remote_account_catalog (connection_id, last_seen_at desc, external_account_id);

create table sub2api_account_links (
  id text primary key,
  owner_user_id text not null references users(id) on delete cascade,
  managed_account_id text not null references managed_accounts(id) on delete cascade,
  connection_id text not null references sub2api_connections(id) on delete cascade,
  external_account_id text not null,
  external_platform text not null,
  link_status text not null default 'linked' check (link_status in ('linked', 'missing', 'platform_mismatch', 'disabled')),
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_account_id),
  unique (managed_account_id, connection_id)
);

create index sub2api_account_links_owner_idx
  on sub2api_account_links (owner_user_id, managed_account_id);

create table sub2api_account_states (
  link_id text primary key references sub2api_account_links(id) on delete cascade,
  health_code text not null default 'unknown',
  sync_health text not null default 'never_synced',
  remote_status text,
  availability text,
  available boolean,
  quota jsonb,
  quota_error_code text,
  sanitized_error_code text,
  observed_at timestamptz,
  source_updated_at timestamptz,
  unhealthy_streak integer not null default 0 check (unhealthy_streak >= 0),
  updated_at timestamptz not null default now()
);

create table account_state_events (
  id text primary key,
  owner_user_id text not null references users(id) on delete cascade,
  link_id text not null references sub2api_account_links(id) on delete cascade,
  event_type text not null,
  previous_health_code text,
  health_code text not null,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index account_state_events_owner_created_idx
  on account_state_events (owner_user_id, created_at desc);

create table account_alerts (
  id text primary key,
  owner_user_id text not null references users(id) on delete cascade,
  link_id text not null references sub2api_account_links(id) on delete cascade,
  dedupe_key text not null,
  status text not null check (status in ('firing', 'acknowledged', 'resolved')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  health_code text not null,
  summary text not null,
  first_fired_at timestamptz not null,
  last_fired_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by text references users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index account_alerts_active_dedupe_idx
  on account_alerts (link_id, dedupe_key)
  where status in ('firing', 'acknowledged');
create index account_alerts_owner_status_idx
  on account_alerts (owner_user_id, status, last_fired_at desc);

create table sync_runs (
  id text primary key,
  connection_id text not null references sub2api_connections(id) on delete cascade,
  trigger_type text not null check (trigger_type in ('scheduled', 'manual', 'test')),
  status text not null check (status in ('running', 'succeeded', 'failed', 'not_modified')),
  started_at timestamptz not null,
  finished_at timestamptz,
  pages integer not null default 0,
  accounts_seen integer not null default 0,
  items_failed integer not null default 0,
  error_code text,
  error_summary text,
  created_at timestamptz not null default now()
);

create index sync_runs_connection_started_idx
  on sync_runs (connection_id, started_at desc);

create table worker_heartbeats (
  component text primary key,
  release_id text not null,
  process_id integer not null,
  status text not null,
  details jsonb not null default '{}'::jsonb,
  heartbeat_at timestamptz not null,
  started_at timestamptz not null
);

update system_metadata
set value = '{"version":6}'::jsonb, updated_at = now()
where key = 'schema_version';
