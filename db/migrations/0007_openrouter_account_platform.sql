alter table managed_accounts
  drop constraint managed_accounts_platform_check,
  add constraint managed_accounts_platform_check
    check (platform in ('openai', 'opencode_go', 'antigravity', 'clinepass', 'openrouter'));

update system_metadata
set value = '{"version":8}'::jsonb, updated_at = now()
where key = 'schema_version';
