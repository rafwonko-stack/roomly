import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite({extensions:{btree_gist}});
await db.exec(`create role anon;create role authenticated;create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
await db.exec(await readFile(new URL('../../supabase/001_schema.sql',import.meta.url),'utf8'));
console.log('PASS migration executed in PostgreSQL/PGlite');
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
for(let i=0;i<3;i++){await db.query("insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),'{\"full_name\":\"Test User\"}')",[ids[i],`u${i}@example.com`]);await db.query('insert into public.members values($1,$2,true)',[`u${i}@example.com`,i===2?'admin':'employee']);}
const asUser=async i=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[i]]);await db.exec('set role authenticated');};
const rpc=async(name,params,casts)=>{const r=await db.query(`select public.${name}(${params.map((_,i)=>`$${i+1}::${casts[i]}`).join(',')}) as value`,params);return r.rows[0].value;};
await asUser(0);
let snap=await rpc('app_snapshot',[],[]);assert.equal(snap.rooms.length,10);assert.equal(snap.members.length,0);console.log('PASS snapshot employee privacy');
const tomorrow=(await db.query("select ((now() at time zone 'Asia/Bishkek')::date+1)::text as d")).rows[0].d;
const base={room_id:snap.rooms[0].id,title:'SQL test',full_name:'Test User',attendees:2,date:tomorrow,start_time:'10:00',end_time:'11:00',phone:''};
const save=b=>rpc('save_booking',[JSON.stringify(b)],['jsonb']);
const b=await save({...base,email:'spoof@example.com',owner_id:ids[1]});assert.equal(b.email,'u0@example.com');assert.equal(b.owner_id,ids[0]);assert.equal(b.start_time,'10:00');console.log('PASS create + owner/email spoof rejected');
for(const [s,e] of [['09:30','10:30'],['10:30','11:30'],['10:00','10:30'],['09:30','11:30']])assert.match((await save({...base,start_time:s,end_time:e})).error,/занят/);
console.log('PASS all four overlap cases (database exclusion)');
assert.ok((await save({...base,start_time:'11:00',end_time:'12:00'})).id);console.log('PASS adjacent booking');
assert.match((await save({...base,start_time:'12:15',end_time:'13:00'})).error,/Проверьте/);assert.match((await save({...base,start_time:'08:00',end_time:'17:00'})).error,/Проверьте/);assert.match((await save({...base,attendees:501})).error,/вместимость/);console.log('PASS server time and capacity checks');
await asUser(1);assert.match((await save({...base,id:b.id})).error,/свои/);assert.match((await rpc('cancel_booking',[b.id],['uuid'])).error,/свои/);console.log('PASS other employee mutation denied');
await assert.rejects(db.query('select * from public.bookings'),/permission denied/);await assert.rejects(db.query("update public.members set role='admin'"),/permission denied/);await assert.rejects(rpc('audit',['forged','id','success'],['text','text','text']),/permission denied/);console.log('PASS direct table writes/reads and audit forgery denied');
await asUser(2);const room=snap.rooms[0];assert.match((await rpc('save_member',['u2@example.com','employee',true],['text','text','boolean'])).error,/Свою/);console.log('PASS self-demotion denied');
assert.equal((await save({...base,id:b.id,title:'Admin edit'})).title,'Admin edit');
await rpc('save_room',[JSON.stringify({...room,active:false}),'keep'],['jsonb','text']);assert.match((await save({...base,start_time:'13:00',end_time:'14:00'})).error,/отключён/);snap=await rpc('app_snapshot',[],[]);assert.equal(snap.bookings.filter(x=>x.status==='active').length,2);console.log('PASS deactivate/keep');

// A concurrent booking must not be cancelled without appearing in the preview.
await rpc('save_room',[JSON.stringify({...room,active:true}),'keep'],['jsonb','text']);
const preview=snap.bookings.filter(b=>b.room_id===room.id&&b.status==='active').sort((a,b)=>a.id.localeCompare(b.id));
const unseen=await save({...base,start_time:'13:00',end_time:'14:00'});assert.ok(unseen.id);
const refused=await rpc('save_room',[JSON.stringify({...room,active:false,expected_bookings:preview}),'cancel'],['jsonb','text']);
assert.match(refused.error,/Список встреч изменился/);
snap=await rpc('app_snapshot',[],[]);assert.equal(snap.rooms.find(r=>r.id===room.id).active,true);assert.equal(snap.bookings.find(b=>b.id===unseen.id).status,'active');
console.log('PASS stale cancellation preview rejected atomically, unseen booking retained');
const latest=snap.bookings.find(x=>x.id===b.id);
assert.ok((await save({...latest,title:'Concurrent edit',expected_updated_at:latest.updated_at})).id);
assert.match((await save({...latest,title:'Stale edit',expected_updated_at:latest.updated_at})).error,/изменена другим/);
assert.match((await rpc('save_room',[JSON.stringify({...snap.rooms.find(r=>r.id!==room.id),capacity:0}),'keep'],['jsonb','text'])).error,/Проверьте/);
assert.ok(Array.isArray(await rpc('app_bookings_range',[tomorrow,tomorrow],['date','date'])));
await assert.rejects(rpc('app_bookings_range',[tomorrow,'2099-01-01'],['date','date']),/Выберите период/);
snap=await rpc('app_snapshot',[],[]);
console.log('PASS stale booking version rejected, Russian errors, bounded range query');

await rpc('save_room',[JSON.stringify({...room,active:false,expected_bookings:snap.bookings.filter(b=>b.room_id===room.id&&b.status==='active').sort((a,b)=>a.id.localeCompare(b.id))}),'cancel'],['jsonb','text']);snap=await rpc('app_snapshot',[],[]);assert.equal(snap.bookings.filter(x=>x.status==='active').length,0);assert.ok(snap.audit.some(x=>x.result.startsWith('error:')));console.log('PASS deactivate/cancel atomically + failed audit persisted');
await rpc('save_member',['u0@example.com','employee',false],['text','text','boolean']);await asUser(0);await assert.rejects(rpc('app_snapshot',[],[]),/Доступ/);console.log('PASS access revocation applies immediately');
await db.exec('reset role;set role anon');await assert.rejects(rpc('app_snapshot',[],[]),/permission denied/);console.log('PASS anonymous denied');
await db.exec('reset role');
await db.exec(await readFile(new URL('../../supabase/003_release_1_1.sql',import.meta.url),'utf8'));
await asUser(2);assert.ok((await rpc('app_snapshot',[],[])).rooms.length===10);
console.log('PASS upgrade migration can be reapplied without losing data');
await db.close();console.log('SQL TESTS COMPLETE');

