-- Run after schema 001 (new installations) or release migration 003 (existing).
-- Returns an explicit projection of Auth accounts, only to an admitted admin.
begin;
create or replace function public.list_registered_members(p_query text default '',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.members; result jsonb; total_count bigint; search_value text;
begin
 m:=public.actor();
 if m.role<>'admin' then raise exception 'Требуются права администратора.';end if;
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception 'Некорректная страница списка.';end if;
 search_value:=lower(trim(coalesce(p_query,'')));
 if char_length(search_value)>120 then raise exception 'Поиск: не более 120 символов.';end if;
 select count(*) into total_count from auth.users u where u.email is not null
 and position(search_value in lower(coalesce(u.raw_user_meta_data->>'full_name','')||' '||u.email))>0;
 select coalesce(jsonb_agg(x.item order by x.email,x.uid),'[]'::jsonb) into result from (
  select u.id as uid,u.email,jsonb_build_object(
   'id',u.id,'email',lower(u.email),'full_name',coalesce(u.raw_user_meta_data->>'full_name',''),
   'created_at',u.created_at,'email_confirmed',u.email_confirmed_at is not null,
   'registered',true,'allowed',a.email is not null,'role',coalesce(a.role,'employee'),
   'active',coalesce(a.active,false)) as item
  from auth.users u left join public.members a on a.email=lower(u.email)
  where u.email is not null and position(search_value in lower(coalesce(u.raw_user_meta_data->>'full_name','')||' '||u.email))>0
  order by u.email,u.id limit 50 offset p_offset
 ) x;
 return jsonb_build_object('items',result,'total',total_count,'offset',p_offset);
end $$;
revoke execute on function public.list_registered_members(text,integer) from public,anon,authenticated;
grant execute on function public.list_registered_members(text,integer) to authenticated;
commit;
