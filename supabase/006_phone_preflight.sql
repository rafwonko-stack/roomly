-- Read-only preflight. Run before 006_phone_identity.sql on a staging copy and keep results.
select count(*) as auth_users from auth.users;
select role,active,count(*) as members from public.members group by role,active order by role,active;
select count(*) as bookings,min(date) as first_date,max(date) as last_date from public.bookings;
select count(*) as audit_entries from public.audit_log;
select count(*) as ambiguous_email_groups from (
 select lower(email) from auth.users where nullif(email,'') is not null group by lower(email) having count(*)>1
) x;
select count(*) as pending_members from public.members m
where not exists(select 1 from auth.users u where lower(u.email)=m.email);
-- Unexpected custom foreign keys referencing members need review before its primary key changes.
select conname,conrelid::regclass as referencing_table from pg_constraint
where contype='f' and confrelid='public.members'::regclass;
