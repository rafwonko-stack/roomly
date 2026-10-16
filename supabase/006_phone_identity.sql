-- Roomly 1.4. Apply on a backup/staging database first, after 001 + 004 + 005.
-- Transactional, additive identity migration: no accounts, bookings or history are deleted.
begin;
lock table auth.users in share row exclusive mode;
lock table public.members in share row exclusive mode;
alter table public.members add column if not exists member_id uuid not null default gen_random_uuid();
alter table public.members add column if not exists user_id uuid;
alter table public.members add column if not exists identity_verified boolean not null default false;
do $$ begin
 if exists(select 1 from auth.users where email is not null and email<>'' group by lower(email) having count(*)>1) then
  raise exception 'Duplicate Auth email: resolve ambiguous identities before migration';
 end if;
end $$;
-- Preserve role and active exactly; bind existing identities without trusting metadata.
update public.members m set user_id=u.id from auth.users u
where m.user_id is null and m.email=lower(u.email);
update public.members m set identity_verified=true from auth.users u where m.user_id=u.id and m.email=lower(u.email) and u.email_confirmed_at is not null;
alter table public.members drop constraint if exists members_pkey;
alter table public.members alter column email drop not null;
alter table public.members add constraint members_pkey primary key(member_id);
create unique index if not exists members_email_unique on public.members(email);
create unique index if not exists members_user_unique on public.members(user_id);
-- IDs are intentionally retained if Auth accounts are removed: no reassignment of old privileges.
create or replace function public.register_employee() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.members where user_id=new.id) then
  update public.members set identity_verified=true where user_id=new.id and email=lower(new.email) and new.email_confirmed_at is not null;
  return new;
 end if;
 if TG_OP='UPDATE' then return new;end if;
 if nullif(new.email,'') is not null then
  update public.members set user_id=new.id where email=lower(new.email) and user_id is null;
  if found then return new; end if;
 end if;
 insert into public.members(user_id,email,role,active,identity_verified)
 values(new.id,nullif(lower(new.email),''),'employee',true,true);
 return new;
end $$;
revoke all on function public.register_employee() from public,anon,authenticated;
drop trigger if exists roomly_register_employee on auth.users;
create trigger roomly_register_employee after insert or update of email_confirmed_at on auth.users for each row execute function public.register_employee();
-- Do not grant access to previously unlisted users during migration. Existing denials remain denials.
create or replace function public.actor() returns public.members
language plpgsql stable security definer set search_path='' as $$
declare m public.members;
begin
 select x.* into m from public.members x join auth.users u on u.id=x.user_id
 where u.id=auth.uid() and x.active and (x.identity_verified or (x.email=lower(u.email) and u.email_confirmed_at is not null)) and
 ((u.email_confirmed_at is not null and nullif(u.email,'') is not null)
 or (u.phone_confirmed_at is not null and u.phone ~ '^\+?996[1-9][0-9]{8}$'));
 if m.user_id is null then raise exception 'Доступ не разрешён. Подтвердите контакт или обратитесь к администратору.';end if;
 return m;
end $$;
create or replace function public.audit(p_action text,p_id text,p_result text default 'success') returns void
language sql security definer set search_path='' as $$
 insert into public.audit_log(actor_id,actor_email,action,object_id,result)
 values(auth.uid(),coalesce((select coalesce(nullif(email,''),nullif(phone,'')) from auth.users where id=auth.uid()),'unknown'),p_action,p_id,p_result)
$$;
-- Allow real phone-only accounts without fabricated email addresses. Existing rows remain unchanged.
alter table public.bookings alter column email drop not null;
create or replace function public.save_registered_member(p_user_id uuid,p_role text,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.members;
begin
 m:=public.actor();if m.role<>'admin' then raise exception 'Требуются права администратора.';end if;
 perform pg_advisory_xact_lock(71024001);
 if p_user_id=auth.uid() then raise exception 'Свою роль и доступ изменить нельзя.';end if;
 if p_role is null or p_role not in ('employee','admin') or p_active is null then raise exception 'Проверьте роль и доступ.';end if;
 if not exists(select 1 from auth.users where id=p_user_id) then raise exception 'Аккаунт не найден.';end if;
 insert into public.members(user_id,email,role,active,identity_verified)
 select id,nullif(lower(email),''),p_role,p_active,true from auth.users where id=p_user_id
 on conflict(user_id) do update set role=excluded.role,active=excluded.active,identity_verified=true;
 perform public.audit('member.update',p_user_id::text);
 return jsonb_build_object('success',true);
end $$;
revoke all on function public.save_registered_member(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.save_registered_member(uuid,text,boolean) to authenticated;

create or replace function public.app_snapshot() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.members; tz text; today date; uname text;
begin
 m:=public.actor();
 select time_zone into tz from public.office_settings where id;
 today:=(now() at time zone tz)::date;
 select coalesce(raw_user_meta_data->>'full_name','') into uname from auth.users where id=auth.uid();
 return jsonb_build_object(
 'revision',public.app_revision(),
 'user',jsonb_build_object('id',auth.uid(),'email',(select nullif(email,'') from auth.users where id=auth.uid()),'phone',(select case when nullif(phone,'') is null then null else '+'||ltrim(phone,'+') end from auth.users where id=auth.uid()),'role',m.role,'full_name',uname),
 'settings',jsonb_build_object('time_zone',tz),
 'window',jsonb_build_object('from',today-7,'to',today+30),
 'rooms',coalesce((select jsonb_agg(to_jsonb(r) order by floor,name) from public.rooms r),'[]'::jsonb),
 'bookings',coalesce((select jsonb_agg(public.booking_json(b) order by date,start_time) from public.bookings b where date between today-7 and today+30 or owner_id=auth.uid() and date>=today-365),'[]'::jsonb),
 'members',case when m.role='admin' then coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('phone',(select '+'||ltrim(u.phone,'+') from auth.users u where u.id=x.user_id)) order by email) from public.members x),'[]'::jsonb) else '[]'::jsonb end,
 'audit',case when m.role='admin' then coalesce((select jsonb_agg(to_jsonb(a) order by created_at desc) from (select * from public.audit_log where created_at>=now()-interval '1 year' order by created_at desc limit 500) a),'[]'::jsonb) else '[]'::jsonb end);
end $$;
create or replace function public.save_booking(p_booking jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.members; r public.rooms; b public.bookings; previous public.bookings;
 tz text; local_now timestamp; bid uuid; action_name text; err text;
begin
 m:=public.actor(); -- denied outsiders cannot flood the audit log
 perform pg_advisory_xact_lock(71024001);
 action_name:=case when nullif(p_booking->>'id','') is null then 'booking.create' else 'booking.update' end;
 begin
  select time_zone into tz from public.office_settings where id;
  local_now:=clock_timestamp() at time zone tz;
  bid:=nullif(p_booking->>'id','')::uuid;
  if bid is not null then
   select * into previous from public.bookings where id=bid for update;
   if not found then raise exception 'Бронирование не найдено.'; end if;
   if nullif(p_booking->>'expected_updated_at','') is not null and (p_booking->>'expected_updated_at')::timestamptz<>previous.updated_at then raise exception 'Бронь изменена другим пользователем. Откройте её заново.';end if;
   if previous.status<>'active' then raise exception 'Отменённую бронь нельзя изменить.'; end if;
   if m.role<>'admin' and (previous.owner_id<>auth.uid() or previous.date+previous.start_time<=local_now) then
    raise exception 'Менять можно только свои брони до начала встречи.';
   end if;
  end if;
  select * into r from public.rooms where id=(p_booking->>'room_id')::uuid for update;
  if not found or not r.active then raise exception 'Зал отключён или не найден.'; end if;
  b.id:=coalesce(bid,gen_random_uuid());b.room_id:=r.id;
  b.owner_id:=coalesce(previous.owner_id,auth.uid());b.email:=case when bid is not null then previous.email else (select nullif(email,'') from auth.users where id=auth.uid()) end;
  b.title:=trim(p_booking->>'title'); b.full_name:=trim(p_booking->>'full_name');
  b.phone:=coalesce(trim(p_booking->>'phone'),'');
  if bid is null and b.email is null and b.phone='' then select '+'||ltrim(phone,'+') into b.phone from auth.users where id=auth.uid();end if; b.attendees:=(p_booking->>'attendees')::integer;
  b.date:=(p_booking->>'date')::date;b.start_time:=(p_booking->>'start_time')::time;b.end_time:=(p_booking->>'end_time')::time;
  b.status:='active'; b.created_at:=coalesce(previous.created_at,now());b.updated_at:=now();
  if b.date+b.start_time<=local_now and not (m.role='admin' and bid is not null and b.date=previous.date and b.start_time=previous.start_time and b.end_time=previous.end_time and b.room_id=previous.room_id) then raise exception 'Нельзя забронировать прошедшее время.'; end if;
  if b.date>local_now::date+30 then raise exception 'Бронирование доступно на ближайшие 30 дней.'; end if;
  if b.attendees>r.capacity then raise exception 'Количество участников превышает вместимость зала.'; end if;
  if bid is null then
   insert into public.bookings select b.*;
  else
   update public.bookings set room_id=b.room_id,title=b.title,full_name=b.full_name,phone=b.phone,
    attendees=b.attendees,date=b.date,start_time=b.start_time,end_time=b.end_time,updated_at=b.updated_at where id=bid;
  end if;
  perform public.audit(action_name,b.id::text);
  return public.booking_json(b);
 exception
  when exclusion_violation then err:='Зал уже занят в это время. Обновите расписание и выберите другой интервал.';
  when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow then err:='Проверьте поля: ФИО, тему, дату, телефон, участников и время 08:00–20:00 с шагом 30 минут, до 8 часов.';
  when others then err:=sqlerrm;
 end;
 -- Return a business error (not RAISE), so the failed-attempt audit commits.
 perform public.audit(action_name,coalesce(p_booking->>'id','new'),'error: '||err);
 return jsonb_build_object('error',err);
end $$;
create or replace function public.list_registered_members(p_query text default '',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.members; result jsonb; total_count bigint; search_value text;
begin
 m:=public.actor();
 if m.role<>'admin' then raise exception 'Требуются права администратора.';end if;
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception 'Некорректная страница списка.';end if;
 search_value:=lower(trim(coalesce(p_query,'')));
 if char_length(search_value)>120 then raise exception 'Поиск: не более 120 символов.';end if;
 select count(*) into total_count from auth.users u where (nullif(u.email,'') is not null or nullif(u.phone,'') is not null)
 and position(search_value in lower(coalesce(u.raw_user_meta_data->>'full_name','')||' '||coalesce(u.email,'')||' '||coalesce(u.phone,'')))>0;
 select coalesce(jsonb_agg(x.item order by x.email,x.uid),'[]'::jsonb) into result from (
  select u.id as uid,u.email,jsonb_build_object(
   'id',u.id,'user_id',u.id,'email',nullif(lower(u.email),''),'phone',case when nullif(u.phone,'') is null then null else '+'||ltrim(u.phone,'+') end,'phone_confirmed',u.phone_confirmed_at is not null,'full_name',coalesce(u.raw_user_meta_data->>'full_name',''),
   'created_at',u.created_at,'email_confirmed',u.email_confirmed_at is not null,
   'registered',true,'allowed',a.user_id is not null,'role',coalesce(a.role,'employee'),
   'active',coalesce(a.active,false)) as item
  from auth.users u left join public.members a on a.user_id=u.id
  where (nullif(u.email,'') is not null or nullif(u.phone,'') is not null) and position(search_value in lower(coalesce(u.raw_user_meta_data->>'full_name','')||' '||coalesce(u.email,'')||' '||coalesce(u.phone,'')))>0
  order by u.email,u.id limit 50 offset p_offset
 ) x;
 return jsonb_build_object('items',result,'total',total_count,'offset',p_offset);
end $$;
revoke execute on function public.list_registered_members(text,integer) from public,anon,authenticated;
grant execute on function public.list_registered_members(text,integer) to authenticated;

create or replace function public.save_member(p_email text,p_role text,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.members; target text; target_uid uuid; err text;
begin
 m:=public.actor();if m.role<>'admin' then raise exception 'Требуются права администратора.';end if;
 perform pg_advisory_xact_lock(71024001);
 target:=lower(trim(p_email));
 select id into target_uid from auth.users where lower(email)=target;
 begin
  if target=m.email or target_uid=auth.uid() then raise exception 'Свою роль и доступ изменить нельзя.';end if;
  insert into public.members(email,role,active,user_id) values(target,p_role,p_active,target_uid)
  on conflict(email) do update set role=excluded.role,active=excluded.active,user_id=coalesce(public.members.user_id,excluded.user_id);
  perform public.audit('member.update',target);return jsonb_build_object('success',true);
 exception when check_violation or not_null_violation or invalid_text_representation then err:='Проверьте введённые данные: название, этаж, вместимость, email и роль.'; when others then err:=sqlerrm;end;
 perform public.audit('member.update',target,'error: '||err);return jsonb_build_object('error',err);
end $$;
commit;
