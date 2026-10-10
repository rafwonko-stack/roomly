import {officeParts,addDays,validateBooking,mayEdit} from './core.js';
const cfg=window.ROOMLY_CONFIG;
export const live=Boolean(cfg.supabaseUrl&&cfg.supabaseKey);
let session=null,refreshPromise=null,lastRevision=null;
try {session=JSON.parse(sessionStorage.getItem('roomly.session')||'null');} catch {}
const saveSession=s=>{session=s; s?sessionStorage.setItem('roomly.session',JSON.stringify(s)):sessionStorage.removeItem('roomly.session');};
async function request(path,body,method='POST',auth=true,retry=true) {
  if(auth&&session&&session.expires_at*1000<Date.now()+60000) await refresh();
  let res;
  try {res=await fetch(cfg.supabaseUrl.replace(/\/$/,'')+path,{method,headers:{apikey:cfg.supabaseKey,'Content-Type':'application/json',...(auth&&session?{Authorization:`Bearer ${session.access_token}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});} catch {throw Error('Не удалось связаться с сервером. Проверьте интернет и повторите попытку.');}
  let data;try {data=await res.json();}catch{data=null;}
  if(res.status===401&&auth&&session&&retry){await refresh();return request(path,body,method,auth,false);}
  if(!res.ok) {
    const message=data?.msg||data?.message||data?.error_description||'Ошибка сервера';
    if(/invalid login/i.test(message)) throw Error('Неверный email или пароль.');
    if(/email not confirmed/i.test(message)) throw Error('Подтвердите email по ссылке в письме.');
    if(/rate limit/i.test(message)) throw Error('Слишком много попыток. Попробуйте немного позже.');
    if(/JWT|refresh token/i.test(message)){saveSession(null);throw Error('Сессия истекла. Войдите снова.');}
    throw Error(message);
  }
  if(data?.error) throw Error(data.error);
  return data;
}
async function refresh(){
 if(!refreshPromise)refreshPromise=(async()=>{try{const s=await request('/auth/v1/token?grant_type=refresh_token',{refresh_token:session?.refresh_token},'POST',false);saveSession({...s,expires_at:s.expires_at||Math.floor(Date.now()/1000)+s.expires_in});}catch(e){saveSession(null);throw e;}finally{refreshPromise=null;}})();
 return refreshPromise;
}
const rpc=(name,body={})=>request('/rest/v1/rpc/'+name,body);
const demoKey='roomly.demo.v1';let memory=null;
function seed(){
 const today=officeParts(new Date(),cfg.timeZone).date;
 const rooms=Array.from({length:10},(_,i)=>({id:`room-${i+1}`,name:(i%2?'Малый':'Большой')+' зал · '+(Math.floor(i/2)+1),floor:Math.floor(i/2)+1,capacity:i%2?8:24,description:i%2?'Для рабочих обсуждений и небольших команд.':'Просторный зал для презентаций и встреч всей команды.',equipment:i%2?['ТВ-панель','Маркерная доска']:['Проектор','Видеосвязь','Маркерная доска'],active:true}));
 const names=['Планирование команды','Обсуждение проекта','Встреча с партнёрами','Дизайн-ревью','Рабочая группа'];
 const bookings=[0,1,2,3,4,5,6,7].map((i)=>({id:crypto.randomUUID(),room_id:rooms[i%5].id,owner_id:i===1?'demo-user':'demo-other',title:names[i%5],date:today,start_time:['09:00','10:00','11:00','14:00','15:30','13:00','16:00','17:00'][i],end_time:['10:00','11:30','12:30','15:00','17:00','14:30','17:00','18:00'][i],full_name:i===1?'Алексей Смирнов':'Демо сотрудник',email:i===1?'alex@example.com':'colleague@example.com',phone:'',attendees:6,status:'active',created_at:new Date().toISOString()}));
 return {rooms,bookings,audit:[],members:[{email:'alex@example.com',role:'employee',active:true},{email:'admin@example.com',role:'admin',active:true}],settings:{time_zone:cfg.timeZone},seedDate:today};
}
function read(){try{const raw=localStorage.getItem(demoKey);return raw?JSON.parse(raw):(memory||seed());}catch{return memory||seed();}}
function write(d){memory=d;try{localStorage.setItem(demoKey,JSON.stringify(d));}catch{throw Error('Браузер запретил сохранение. Разрешите локальное хранилище для деморежима.');}}
const demoUser=()=>{let role='employee';try{role=sessionStorage.getItem('roomly.demo.role')||role;}catch{}return {id:role==='admin'?'demo-admin':'demo-user',email:role==='admin'?'admin@example.com':'alex@example.com',full_name:role==='admin'?'Мария Волкова':'Алексей Смирнов',role};};
function log(d,action,id,result='success'){d.audit.unshift({id:crypto.randomUUID(),actor_email:demoUser().email,action,object_id:id,result,created_at:new Date().toISOString()});d.audit=d.audit.slice(0,500);}
async function mutate(fn){const run=()=>{const d=read();const result=fn(d);write(d);return result;};return navigator.locks?navigator.locks.request('roomly-demo-write',run):run();}
export const api={
 async init(){
   if(Boolean(cfg.supabaseUrl)!==Boolean(cfg.supabaseKey))throw Error('Настройка не завершена: укажите и supabaseUrl, и публичный supabaseKey в config.js.');
   if(!live){const d=read();write(d);return {...d,user:demoUser()};}
   const hash=new URLSearchParams(location.hash.slice(1));
   if(hash.get('access_token')) {saveSession({access_token:hash.get('access_token'),refresh_token:hash.get('refresh_token'),expires_at:Math.floor(Date.now()/1000)+Number(hash.get('expires_in')||3600)});history.replaceState(null,'',location.pathname+location.search);}
   if(!session)return null;
   return this.load();
 },
 async login(email,password){const s=await request('/auth/v1/token?grant_type=password',{email,password},'POST',false);saveSession({...s,expires_at:s.expires_at||Math.floor(Date.now()/1000)+s.expires_in});return this.load();},
 async signup(email,password,full_name){return request('/auth/v1/signup',{email,password,data:{full_name}},'POST',false);},
 async recover(email){return request('/auth/v1/recover?redirect_to='+encodeURIComponent(location.origin+location.pathname),{email},'POST',false);},
 async password(password){return request('/auth/v1/user',{password},'PUT');},
 async logout(){try{if(live&&session)await request('/auth/v1/logout',{});}finally{saveSession(null);}},
 async load(){
   if(!live)return {...read(),user:demoUser()};
   const snapshot=await rpc('app_snapshot');lastRevision=snapshot.revision;return snapshot;
 },
 async hasChanges(){if(!live)return true;return (await rpc('app_revision'))!==lastRevision;},
 async saveBooking(b){
   if(live)return rpc('save_booking',{p_booking:b});
   return mutate(d=>{const user=demoUser(),old=d.bookings.find(x=>x.id===b.id),now=officeParts(new Date(),cfg.timeZone);if(old&&!mayEdit(old,user,now))throw Error('У вас нет права изменять эту бронь.');
    const next={...b,owner_id:old?.owner_id||user.id,email:old?.email||user.email,status:'active',created_at:old?.created_at||new Date().toISOString()};
    const error=validateBooking(next,d.rooms.find(r=>r.id===b.room_id),d.bookings,now);if(error)throw Error(error);
    next.id=old?.id||crypto.randomUUID();d.bookings=old?d.bookings.map(x=>x.id===next.id?next:x):[...d.bookings,next];log(d,old?'booking.update':'booking.create',next.id);return next;
   });
 },
 async cancelBooking(id){if(live)return rpc('cancel_booking',{p_id:id});return mutate(d=>{const b=d.bookings.find(x=>x.id===id);if(!b||!mayEdit(b,demoUser(),officeParts(new Date(),cfg.timeZone)))throw Error('Нельзя отменить эту бронь.');b.status='cancelled';log(d,'booking.cancel',id);return b;});},
 async saveRoom(room,policy){if(live)return rpc('save_room',{p_room:room,p_policy:policy||'keep'});return mutate(d=>{
   if(demoUser().role!=='admin')throw Error('Требуются права администратора.');
   if(!room.name.trim()||room.name.length>80||!Number.isInteger(room.floor)||room.floor<1||room.floor>5||!Number.isInteger(room.capacity)||room.capacity<1||room.capacity>500)throw Error('Проверьте название, этаж и вместимость.');
   const old=d.rooms.find(x=>x.id===room.id),now=officeParts(new Date(),cfg.timeZone),future=d.bookings.filter(b=>b.room_id===room.id&&b.status==='active'&&(b.date>now.date||b.date===now.date&&b.end_time>now.time));
   if(future.some(b=>b.attendees>room.capacity))throw Error('Вместимость меньше числа участников существующей встречи. Сначала измените её бронь.');
   room.id=old?.id||crypto.randomUUID();if(!room.active&&policy==='cancel')future.forEach(b=>{b.status='cancelled';log(d,'booking.cancel',b.id);});
   d.rooms=old?d.rooms.map(x=>x.id===room.id?room:x):[...d.rooms,room];log(d,old?'room.update':'room.create',room.id);return room;
 });},
 async saveMember(member){if(live)return rpc('save_member',{p_email:member.email,p_role:member.role,p_active:member.active});return mutate(d=>{if(demoUser().role!=='admin')throw Error('Требуются права администратора.');if(member.email===demoUser().email)throw Error('Свою роль и доступ изменить нельзя.');d.members=d.members.filter(x=>x.email!==member.email);d.members.push(member);log(d,'member.update',member.email);});},
 setDemoRole(role){sessionStorage.setItem('roomly.demo.role',role);},
 resetDemo(){write(seed());},
};
