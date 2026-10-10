-- Replace the address. This allowlist entry does not itself create an auth account.
-- Register that same address in Roomly, then confirm email.
insert into public.members(email,role,active)
values('REPLACE_WITH_YOUR_EMAIL@example.com','admin',true)
on conflict(email) do update set role='admin',active=true;
-- Email must be lowercase. The placeholder intentionally fails that check.
