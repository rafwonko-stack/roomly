-- Apply after 001_schema.sql and 004_registered_members.sql.
-- Existing roles and disabled accounts are preserved.
begin;
create or replace function public.register_employee() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.email is not null then
  insert into public.members(email,role,active)
  values(lower(trim(new.email)),'employee',true)
  on conflict(email) do nothing;
 end if;
 return new;
end $$;
revoke all on function public.register_employee() from public,anon,authenticated;
drop trigger if exists roomly_register_employee on auth.users;
create trigger roomly_register_employee after insert or update of email on auth.users
for each row execute function public.register_employee();
insert into public.members(email,role,active)
select lower(trim(email)),'employee',true from auth.users where email is not null
on conflict(email) do nothing;
commit;
