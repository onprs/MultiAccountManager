alter table managed_accounts
  drop constraint managed_accounts_platform_check,
  add constraint managed_accounts_platform_check
    check (platform in ('openai', 'opencode_go', 'antigravity', 'clinepass'));

update system_metadata
set value = '{"version":7}'::jsonb, updated_at = now()
where key = 'schema_version';
