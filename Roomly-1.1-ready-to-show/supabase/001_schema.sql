-- Run once in a NEW Supabase project, SQL Editor, as postgres.
begin;
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
set local search_path = public, extensions;

create table public.office_settings (
 id boolean primary key default true check(id),
 time_zone text not null default 'Asia/Bishkek'
);
insert into public.office_settings values(true,'Asia/Bishkek');
create table public.members (
 email text primary key check(email=lower(trim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 role text not null default 'employee' check(role in ('employee','admin')),
 active boolean not null default true
);
create table public.rooms (
 id uuid primary key default gen_random_uuid(),
 name text not null check(char_length(trim(name)) between 1 and 80),
 floor integer not null check(floor between 1 and 5),
 capacity integer not null check(capacity between 1 and 500),
 description text not null default '' check(char_length(description)<=500),
 equipment text[] not null default '{}',
 active boolean not null default true,
 created_at timestamptz not null default now(),
 check(cardinality(equipment)<=20)
);
create table public.bookings (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.rooms(id),
 owner_id uuid not null, -- retain history even if an auth account is deleted
 title text not null check(char_length(trim(title)) between 1 and 100),
 full_name text not null check(char_length(trim(full_name)) between 3 and 120),
 email text not null,
 phone text not null default '' check(phone='' or (phone ~ '^\+?[0-9 ()-]{7,24}$' and char_length(regexp_replace(phone,'[^0-9]','','g')) between 7 and 15)),
 attendees integer not null check(attendees between 1 and 500),
 date date not null,
 start_time time not null,
 end_time time not null,
 status text not null default 'active' check(status in ('active','cancelled')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(start_time>=time '08:00' and end_time<=time '20:00'),
 check(end_time-start_time between interval '15 minutes' and interval '8 hours'),
 check(extract(minute from start_time)::integer % 30=0 and extract(second from start_time)=0),
 check(extract(minute from end_time)::integer % 30=0 and extract(second from end_time)=0),
 exclude using gist (room_id with =, tsrange(date+start_time,date+end_time,'[)') with &&) where (status='active')
);
create index bookings_date on public.bookings(date);
create index bookings_owner on public.bookings(owner_id,date);
create table public.audit_log (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid,
 actor_email text not null,
 action text not null,
 object_id text,
 result text not null default 'success',
 created_at timestamptz not null default now()
);
create index audit_created on public.audit_log(created_at desc);

-- Data is not exposed to anonymous visitors. Writes ONLY through checked RPCs.
alter table public.office_settings enable row level security;
alter table public.members enable row level security;
alter table public.rooms enable row level security;
alter table public.bookings enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.office_settings,public.members,public.rooms,public.bookings,public.audit_log from anon,authenticated;

create function public.actor() returns public.members
language plpgsql stable security definer set search_path='' as $$
declare m public.members;
begin
 select x.* into m from public.members x join auth.users u on lower(u.email)=x.email
 where u.id=auth.uid() and u.email_confirmed_at is not null and x.active;
 if m.email is null then raise exception 'Доступ не разрешён. Подтвердите email и обратитесь к администратору.'; end if;
 return m;
end $$;

create function public.booking_json(b public.bookings) returns jsonb
language sql immutable set search_path='' as $$
 select to_jsonb(b)||jsonb_build_object('start_time',to_char(b.start_time,'HH24:MI'),'end_time',to_char(b.end_time,'HH24:MI'))
$$;

create function public.audit(p_action text,p_id text,p_result text default 'success') returns void
language sql security definer set search_path='' as $$
 insert into public.audit_log(actor_id,actor_email,action,object_id,result)
 values(auth.uid(),coalesce((select email from auth.users where id=auth.uid()),'unknown'),p_action,p_id,p_result)
$$;

create function public.app_revision() returns text
language plpgsql stable security definer set search_path='' as $$
declare m public.members;
begin
 m:=public.actor();
 return coalesce((select created_at::text||id::text from public.audit_log where result='success' order by created_at desc,id desc limit 1),'initial')
 ||m.role||(select time_zone from public.office_settings where id);
end $$;

create function public.app_snapshot() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.members; tz text; today date; uname text;
begin
 m:=public.actor();
 select time_zone into tz from public.office_settings where id;
 today:=(now() at time zone tz)::date;
 select coalesce(raw_user_meta_data->>'full_name','') into uname from auth.users where id=auth.uid();
 return jsonb_build_object(
 'revision',public.app_revision(),
 'user',jsonb_build_object('id',auth.uid(),'email',m.email,'role',m.role,'full_name',uname),
 'settings',jsonb_build_object('time_zone',tz),
 'window',jsonb_build_object('from',today-7,'to',today+30),
 'rooms',coalesce((select jsonb_agg(to_jsonb(r) order by floor,name) from public.rooms r),'[]'::jsonb),
 'bookings',coalesce((select jsonb_agg(public.booking_json(b) order by date,start_time) from public.bookings b where date between today-7 and today+30 or owner_id=auth.uid() and date>=today-365),'[]'::jsonb),
 'members',case when m.role='admin' then coalesce((select jsonb_agg(to_jsonb(x) order by email) from public.members x),'[]'::jsonb) else '[]'::jsonb end,
 'audit',case when m.role='admin' then coalesce((select jsonb_agg(to_jsonb(a) order by created_at desc) from (select * from public.audit_log where created_at>=now()-interval '1 year' order by created_at desc limit 500) a),'[]'::jsonb) else '[]'::jsonb end);
end $$;

create function public.save_booking(p_booking jsonb) returns jsonb
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
  b.owner_id:=coalesce(previous.owner_id,auth.uid());b.email:=coalesce(previous.email,m.email);
  b.title:=trim(p_booking->>'title'); b.full_name:=trim(p_booking->>'full_name');
  b.phone:=coalesce(trim(p_booking->>'phone'),''); b.attendees:=(p_booking->>'attendees')::integer;
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

create function public.cancel_booking(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.members; b public.bookings; local_now timestamp; err text;
begin
 m:=public.actor();perform pg_advisory_xact_lock(71024001);
 begin
  select clock_timestamp() at time zone time_zone into local_now from public.office_settings where id;
  select * into b from public.bookings where id=p_id for update;
  if not found then raise exception 'Бронирование не найдено.'; end if;
  if m.role<>'admin' and (b.owner_id<>auth.uid() or b.date+b.start_time<=local_now) then raise exception 'Отменять можно только свои брони до начала встречи.'; end if;
  if b.status='cancelled' then return public.booking_json(b); end if;
  update public.bookings set status='cancelled',updated_at=now() where id=p_id returning * into b;
  perform public.audit('booking.cancel',p_id::text);return public.booking_json(b);
 exception when check_violation or not_null_violation or invalid_text_representation then err:='Проверьте введённые данные: название, этаж, вместимость, email и роль.'; when others then err:=sqlerrm;end;
 perform public.audit('booking.cancel',p_id::text,'error: '||err);return jsonb_build_object('error',err);
end $$;

create function public.save_room(p_room jsonb,p_policy text default 'keep') returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.members; r public.rooms; rid uuid; b public.bookings; local_now timestamp; err text; equipment_value text[];
begin
 m:=public.actor();if m.role<>'admin' then raise exception 'Требуются права администратора.';end if;
 perform pg_advisory_xact_lock(71024001);
 begin
  if p_policy not in ('keep','cancel') then raise exception 'Неизвестная политика отключения.';end if;
  rid:=nullif(p_room->>'id','')::uuid;
  if rid is not null and not exists(select 1 from public.rooms where id=rid) then raise exception 'Зал не найден.';end if;
  select clock_timestamp() at time zone time_zone into local_now from public.office_settings where id;
  if exists(select 1 from public.bookings where room_id=rid and status='active' and date+end_time>local_now and attendees>(p_room->>'capacity')::integer) then
   raise exception 'Вместимость меньше числа участников существующей встречи. Сначала измените её бронь.';
  end if;
  select coalesce(array_agg(trim(value)),'{}') into equipment_value from jsonb_array_elements_text(coalesce(p_room->'equipment','[]'::jsonb));
  if exists(select 1 from unnest(equipment_value) x where char_length(x)>80) then raise exception 'Название оборудования: до 80 символов.';end if;
  insert into public.rooms(id,name,floor,capacity,description,equipment,active)
  values(coalesce(rid,gen_random_uuid()),trim(p_room->>'name'),(p_room->>'floor')::integer,(p_room->>'capacity')::integer,
   coalesce(p_room->>'description',''),equipment_value,(p_room->>'active')::boolean)
  on conflict(id) do update set name=excluded.name,floor=excluded.floor,capacity=excluded.capacity,description=excluded.description,equipment=excluded.equipment,active=excluded.active
  returning * into r;
  if not r.active and p_policy='cancel' then
   if coalesce(p_room->'expected_bookings','null'::jsonb) is distinct from coalesce((select jsonb_agg(public.booking_json(x) order by id) from public.bookings x where room_id=r.id and status='active' and date+end_time>local_now),'[]'::jsonb) then
    raise exception 'Список встреч изменился. Закройте окно и откройте настройки зала снова, чтобы проверить отменяемые брони.';
   end if;
   for b in update public.bookings set status='cancelled',updated_at=now() where room_id=r.id and status='active' and date+end_time>local_now returning * loop
    perform public.audit('booking.cancel',b.id::text);
   end loop;
  end if;
  perform public.audit(case when rid is null then 'room.create' else 'room.update' end,r.id::text);
  return to_jsonb(r);
 exception when check_violation or not_null_violation or invalid_text_representation then err:='Проверьте введённые данные: название, этаж, вместимость, email и роль.'; when others then err:=sqlerrm;end;
 perform public.audit('room.update',coalesce(p_room->>'id','new'),'error: '||err);return jsonb_build_object('error',err);
end $$;

create function public.save_member(p_email text,p_role text,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.members; target text; err text;
begin
 m:=public.actor();if m.role<>'admin' then raise exception 'Требуются права администратора.';end if;
 perform pg_advisory_xact_lock(71024001);
 target:=lower(trim(p_email));
 begin
  if target=m.email then raise exception 'Свою роль и доступ изменить нельзя.';end if;
  insert into public.members(email,role,active) values(target,p_role,p_active)
  on conflict(email) do update set role=excluded.role,active=excluded.active;
  perform public.audit('member.update',target);return jsonb_build_object('success',true);
 exception when check_violation or not_null_violation or invalid_text_representation then err:='Проверьте введённые данные: название, этаж, вместимость, email и роль.'; when others then err:=sqlerrm;end;
 perform public.audit('member.update',target,'error: '||err);return jsonb_build_object('error',err);
end $$;


create function public.app_bookings_range(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.members; today date;
begin
 m:=public.actor();
 select (now() at time zone time_zone)::date into today from public.office_settings where id;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>31 or p_from<today-365 or p_to>today+36 then
  raise exception 'Выберите период в пределах года истории и ближайших 30 дней.';
 end if;
 return coalesce((select jsonb_agg(public.booking_json(b) order by date,start_time) from public.bookings b where date between p_from and p_to),'[]'::jsonb);
end $$;
revoke execute on function public.app_bookings_range(date,date) from public,anon,authenticated;
grant execute on function public.app_bookings_range(date,date) to authenticated;

-- Default EXECUTE for PUBLIC must be removed even on internal helper functions.
revoke execute on function public.actor(),public.booking_json(public.bookings),public.audit(text,text,text),public.app_revision(),public.app_snapshot(),public.save_booking(jsonb),public.cancel_booking(uuid),public.save_room(jsonb,text),public.save_member(text,text,boolean) from public,anon,authenticated;
grant execute on function public.app_revision(),public.app_snapshot(),public.save_booking(jsonb),public.cancel_booking(uuid),public.save_room(jsonb,text),public.save_member(text,text,boolean) to authenticated;
-- Deliberately no direct table policies/grants. The five RPCs above are the API.

insert into public.rooms(name,floor,capacity,description,equipment)
select case when size=0 then 'Большой зал · ' else 'Малый зал · ' end||floor,
 floor,case when size=0 then 24 else 8 end,
 case when size=0 then 'Просторный зал для презентаций и встреч всей команды.' else 'Для рабочих обсуждений и небольших команд.' end,
 case when size=0 then array['Проектор','Видеосвязь','Маркерная доска'] else array['ТВ-панель','Маркерная доска'] end
from generate_series(1,5) floor cross join generate_series(0,1) size;
commit;
