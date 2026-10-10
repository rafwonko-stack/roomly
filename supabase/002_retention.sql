-- Required for the agreed 1-year retention. Run after 001_schema.sql.
-- Supabase supports pg_cron. If unavailable, enable it in Database > Extensions.
create extension if not exists pg_cron;
create or replace function public.purge_expired_history() returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(71024001);
 delete from public.bookings where date < (select (now() at time zone time_zone)::date-365 from public.office_settings where id);
 delete from public.audit_log where created_at < now()-interval '1 year';
end $$;
revoke all on function public.purge_expired_history() from public,anon,authenticated;
select cron.schedule('roomly-retention','15 2 * * *','select public.purge_expired_history()');
