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
    if(/invalid login/i.test(message)) throw Error('Неверный email или пароль.');
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
const rpc=(name,body={})=>request('/rest/v1/rpc/'+name,body);
const googleRedirect='https://rafwonko-stack.github.io/roomly/';
const verifierKey='roomly.oauth.verifier';
const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function acceptTokens(tokens){
 const expires=Number(tokens.expires_at)||Math.floor(Date.now()/1000)+Number(tokens.expires_in||3600);
 if(!tokens.access_token||!tokens.refresh_token||!Number.isFinite(expires))throw Error('Не удалось получить сессию. Повторите вход.');
 // Store Supabase tokens only; Google provider tokens are not needed by Roomly.
 saveSession({access_token:tokens.access_token,refresh_token:tokens.refresh_token,expires_at:expires});
}
function clearAuthUrl(){
 const url=new URL(location.href);
 for(const key of ['code','error','error_code','error_description'])url.searchParams.delete(key);
 history.replaceState(null,'',url.pathname+url.search);
}

export const api={
 async googleLogin(){
   if(!live)throw Error('Подключение базы не настроено. Обратитесь к администратору.');
   if(location.origin!==new URL(googleRedirect).origin)throw Error('Для входа через Google откройте https://rafwonko-stack.github.io/roomly/.');
   const verifier=base64url(crypto.getRandomValues(new Uint8Array(32)));
   const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
   try{sessionStorage.setItem(verifierKey,verifier);}catch{throw Error('Разрешите хранилище браузера для входа через Google.');}
   const url=new URL(cfg.supabaseUrl.replace(/\/$/,'')+'/auth/v1/authorize');
   url.search=new URLSearchParams({provider:'google',redirect_to:googleRedirect,code_challenge:challenge,code_challenge_method:'s256',prompt:'select_account'}).toString();
   location.assign(url.href);
 },
 async init(){
   if(!live)throw Error('Подключение базы не настроено. Администратору необходимо заполнить config.js по инструкции START.');
   const hash=new URLSearchParams(location.hash.slice(1)),query=new URLSearchParams(location.search);
   const error=hash.get('error')||query.get('error')||hash.get('error_code')||query.get('error_code');
   const code=query.get('code');
   const callback=Boolean(error||query.has('code')||hash.has('access_token')||hash.has('refresh_token'));
   if(callback){
     // Remove credentials and one-time codes before any network request or rendering.
     clearAuthUrl();saveSession(null);
     try{
       if(error){
         const expired=(hash.get('error_code')||query.get('error_code'))==='otp_expired';
         throw Error(expired?'Ссылка подтверждения истекла. Запросите новое письмо на странице входа.':error==='access_denied'?'Вход отменён или доступ не разрешён. Повторите вход или обратитесь к администратору.':'Не удалось завершить вход. Попробуйте снова.');
       }
       if(query.has('code')){
         const verifier=sessionStorage.getItem(verifierKey);
         if(!code||!verifier)throw Error('Сессия входа истекла. Нажмите «Продолжить с Google» снова в этой вкладке.');
         const tokens=await request('/auth/v1/token?grant_type=pkce',{auth_code:code,code_verifier:verifier},'POST',false);
         acceptTokens(tokens);
       }else acceptTokens(Object.fromEntries(hash));
       // Permissions always come from the database, never from Google metadata.
       return await this.load();
     }catch(e){saveSession(null);throw e;}finally{sessionStorage.removeItem(verifierKey);}
   }
   if(!session)return null;
   return this.load();
 },
 async login(email,password){const s=await request('/auth/v1/token?grant_type=password',{email,password},'POST',false);saveSession({...s,expires_at:s.expires_at||Math.floor(Date.now()/1000)+s.expires_in});return this.load();},
 async signup(email,password,full_name){const result=await request('/auth/v1/signup?redirect_to='+encodeURIComponent(location.origin+location.pathname),{email:email.trim().toLowerCase(),password,data:{full_name:full_name.trim()}},'POST',false);if(result.access_token){saveSession({...result,expires_at:result.expires_at||Math.floor(Date.now()/1000)+result.expires_in});return this.load();}return null;},
 async resend(email){return request('/auth/v1/resend',{type:'signup',email,options:{emailRedirectTo:location.origin+location.pathname}},'POST',false);},
 async recover(email){return request('/auth/v1/recover?redirect_to='+encodeURIComponent(location.origin+location.pathname),{email},'POST',false);},
 async password(password){return request('/auth/v1/user',{password},'PUT');},
 async logout(){try{if(live&&session)await request('/auth/v1/logout',{});}finally{saveSession(null);sessionStorage.removeItem(verifierKey);}},
 async load(selectedDate){
   const snapshot=await rpc('app_snapshot');if(selectedDate&&snapshot.window&&(selectedDate<snapshot.window.from||selectedDate>addDays(snapshot.window.to,-6))){const start=addDays(selectedDate,-6),extra=await rpc('app_bookings_range',{p_from:start,p_to:addDays(selectedDate,6)});const byId=new Map(snapshot.bookings.map(b=>[b.id,b]));extra.forEach(b=>byId.set(b.id,b));snapshot.bookings=[...byId.values()];}lastRevision=snapshot.revision;return snapshot;
 },
 async hasChanges(){return (await rpc('app_revision'))!==lastRevision;},
 async saveBooking(b){return rpc('save_booking',{p_booking:b});},
 async cancelBooking(id){return rpc('cancel_booking',{p_id:id});},
 async saveRoom(room,policy){return rpc('save_room',{p_room:room,p_policy:policy||'keep'});},
 async listRegisteredMembers(query='',offset=0){return rpc('list_registered_members',{p_query:query,p_offset:offset});},
 async saveMember(member){return rpc('save_member',{p_email:member.email,p_role:member.role,p_active:member.active});},
};
