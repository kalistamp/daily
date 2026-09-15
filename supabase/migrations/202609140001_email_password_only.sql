-- Follow-up migration for the existing journal schema.
-- Access remains restricted to the allowlisted authenticated owner, but does
-- not require a TOTP/MFA assurance claim.
begin;

create or replace function daily.journal_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists (
      select 1 from daily.journal_owners where user_id = auth.uid()
    );
$$;

revoke all on function daily.journal_access() from public, anon;
grant execute on function daily.journal_access() to authenticated, service_role;

commit;
