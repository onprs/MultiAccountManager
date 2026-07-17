create table system_metadata (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into system_metadata (key, value)
values ('schema_version', '{"version":1}'::jsonb)
on conflict (key) do update
set value = excluded.value, updated_at = now();
