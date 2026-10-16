import {addDays} from './core.js';
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
    if(/invalid login/i.test(message)) throw Error('Неверный номер, email или пароль.');
    if(/phone not confirmed/i.test(message))throw Error('Подтвердите номер SMS-кодом. Используйте «Подтвердить номер».');
    if(/otp|token.*expired|invalid.*token/i.test(message))throw Error('Код неверен или истёк. Запросите новый SMS-код.');
    if(res.status===429)throw Error('Слишком много запросов. Подождите перед следующей попыткой.');
    if(/email not confirmed/i.test(message)) throw Error('Подтвердите email по ссылке в письме.');
    if(/rate limit/i.test(message)) throw Error('Слишком много попыток. Попробуйте немного позже.');
    if(/JWT|refresh token/i.test(message)){saveSession(null);throw Error('Сессия истекла. Войдите снова.');}
    throw Error(/[А-Яа-яЁё]/.test(message)?message:'Не удалось выполнить запрос. Проверьте данные или попробуйте позже.');
  }
  if(data?.error) throw Error(/[А-Яа-яЁё]/.test(data.error)?data.error:'Не удалось сохранить изменения. Проверьте введённые данные.');
  return data;
}
async function refresh(){
 if(!refreshPromise)refreshPromise=(async()=>{try{const s=await request('/auth/v1/token?grant_type=refresh_token',{refresh_token:session?.refresh_token},'POST',false);saveSession({...s,expires_at:s.expires_at||Math.floor(Date.now()/1000)+s.expires_in});}catch(e){saveSession(null);throw e;}finally{refreshPromise=null;}})();
 return refreshPromise;
}
function normalizePhone(value){
 const raw=String(value||'').trim();if(!/^\+?[\d ()-]+$/.test(raw))throw Error('Введите номер Кыргызстана: +996 и 9 цифр.');
 let digits=raw.replace(/\D/g,'');if(digits.length===10&&digits.startsWith('0'))digits=digits.slice(1);if(digits.length===9)digits='996'+digits;
 if(!/^996[1-9]\d{8}$/.test(digits))throw Error('Введите номер Кыргызстана: +996 и 9 цифр.');return '+'+digits;
}
// UX throttle only. Supabase Auth rate limits remain the authoritative protection.
const attempts={};
function limit(kind,max=5,seconds=60){
 let item=attempts[kind];try{item=JSON.parse(sessionStorage.getItem('roomly.limit.'+kind)||'null')||item;}catch{}
 if(!item||Date.now()-item.start>=seconds*1000)item={start:Date.now(),count:0};
 if(item.count>=max)throw Error('Слишком много попыток. Повторите через '+Math.max(1,Math.ceil((item.start+seconds*1000-Date.now())/1000))+' сек.');
 item.count++;attempts[kind]=item;try{sessionStorage.setItem('roomly.limit.'+kind,JSON.stringify(item));}catch{}
}
function acceptSession(s){if(!s?.access_token||!s?.refresh_token)throw Error('Сессия не получена. Повторите вход.');saveSession({access_token:s.access_token,refresh_token:s.refresh_token,expires_at:Number(s.expires_at)||Math.floor(Date.now()/1000)+Number(s.expires_in||3600)});}
async function loadAuthorized(){try{return await api.load();}catch(e){saveSession(null);throw e;}}
const rpc=(name,body={})=>request('/rest/v1/rpc/'+name,body);
export const api={
 normalizePhone,
 async phoneLogin(phone,password){phone=normalizePhone(phone);limit('login');const s=await request('/auth/v1/token?grant_type=password',{phone,password},'POST',false);acceptSession(s);return loadAuthorized();},
 async phoneSignup(phone,password,full_name){phone=normalizePhone(phone);if(password.length<12||full_name.trim().length<3)throw Error('Укажите ФИО и пароль не короче 12 символов.');limit('sms',1);const s=await request('/auth/v1/signup',{phone,password,data:{full_name:full_name.trim()},channel:'sms'},'POST',false);if(s.access_token){acceptSession(s);return loadAuthorized();}return null;},
 async phoneCode(phone,recovery=false){phone=normalizePhone(phone);limit('sms',1);return recovery?request('/auth/v1/otp',{phone,create_user:false,channel:'sms'},'POST',false):request('/auth/v1/resend',{phone,type:'sms'},'POST',false);},
 async verifyPhone(phone,token){phone=normalizePhone(phone);if(!/^\d{6}$/.test(token))throw Error('Введите 6 цифр из SMS.');limit('verify');const s=await request('/auth/v1/verify',{phone,token,type:'sms'},'POST',false);acceptSession(s);return loadAuthorized();},
 async init(){
   if(!live)throw Error('Подключение базы не настроено. Администратору необходимо заполнить config.js по инструкции START.');
   const hash=new URLSearchParams(location.hash.slice(1));
   if(hash.get('error')){history.replaceState(null,'',location.pathname+location.search);throw Error('Ссылка подтверждения недействительна или истекла. Запросите новое письмо на странице входа.');}
   if(hash.get('access_token')) {saveSession({access_token:hash.get('access_token'),refresh_token:hash.get('refresh_token'),expires_at:Math.floor(Date.now()/1000)+Number(hash.get('expires_in')||3600)});history.replaceState(null,'',location.pathname+location.search);}
   if(!session)return null;
   return this.load();
 },
 async login(email,password){limit('login');const s=await request('/auth/v1/token?grant_type=password',{email,password},'POST',false);saveSession({...s,expires_at:s.expires_at||Math.floor(Date.now()/1000)+s.expires_in});return loadAuthorized();},
 async signup(email,password,full_name){const result=await request('/auth/v1/signup?redirect_to='+encodeURIComponent(location.origin+location.pathname),{email:email.trim().toLowerCase(),password,data:{full_name:full_name.trim()}},'POST',false);if(result.access_token){saveSession({...result,expires_at:result.expires_at||Math.floor(Date.now()/1000)+result.expires_in});return this.load();}return null;},
 async resend(email){return request('/auth/v1/resend',{type:'signup',email,options:{emailRedirectTo:location.origin+location.pathname}},'POST',false);},
 async recover(email){return request('/auth/v1/recover?redirect_to='+encodeURIComponent(location.origin+location.pathname),{email},'POST',false);},
 async linkPhone(phone){phone=normalizePhone(phone);limit('sms',1);return request('/auth/v1/user',{phone},'PUT');},
 async verifyLinkedPhone(phone,token){phone=normalizePhone(phone);if(!/^\d{6}$/.test(token))throw Error('Введите 6 цифр из SMS.');limit('verify');const result=await request('/auth/v1/verify',{phone,token,type:'phone_change'});if(result.access_token)acceptSession(result);return loadAuthorized();},
 async password(password){return request('/auth/v1/user',{password},'PUT');},
 async logout(){try{if(live&&session)await request('/auth/v1/logout',{});}finally{saveSession(null);}},
 async load(selectedDate){
   const snapshot=await rpc('app_snapshot');if(selectedDate&&snapshot.window&&(selectedDate<snapshot.window.from||selectedDate>addDays(snapshot.window.to,-6))){const start=addDays(selectedDate,-6),extra=await rpc('app_bookings_range',{p_from:start,p_to:addDays(selectedDate,6)});const byId=new Map(snapshot.bookings.map(b=>[b.id,b]));extra.forEach(b=>byId.set(b.id,b));snapshot.bookings=[...byId.values()];}lastRevision=snapshot.revision;return snapshot;
 },
 async hasChanges(){return (await rpc('app_revision'))!==lastRevision;},
 async saveBooking(b){return rpc('save_booking',{p_booking:b});},
 async cancelBooking(id){return rpc('cancel_booking',{p_id:id});},
 async saveRoom(room,policy){return rpc('save_room',{p_room:room,p_policy:policy||'keep'});},
 async listRegisteredMembers(query='',offset=0){return rpc('list_registered_members',{p_query:query,p_offset:offset});},
 async saveMember(member){if(member.user_id)return rpc('save_registered_member',{p_user_id:member.user_id,p_role:member.role,p_active:member.active});return rpc('save_member',{p_email:member.email,p_role:member.role,p_active:member.active});},
};
