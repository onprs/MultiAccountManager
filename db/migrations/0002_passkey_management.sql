create table auth_step_ups (
  session_id text primary key references sessions(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  method text not null check (method = 'passkey'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index auth_step_ups_user_expires_idx on auth_step_ups (user_id, expires_at desc);
