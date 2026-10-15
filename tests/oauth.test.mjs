import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
let iteration=0;
async function fixture(){
 const storage=new Map(),calls=[],queue=[];let current=new URL('https://rafwonko-stack.github.io/roomly/');let redirected;
 globalThis.window={ROOMLY_CONFIG:{supabaseUrl:'https://test.supabase.co',supabaseKey:'public'}};
 globalThis.sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 globalThis.location={get href(){return current.href},get origin(){return current.origin},get pathname(){return current.pathname},get search(){return current.search},get hash(){return current.hash},assign:url=>{redirected=new URL(url)}};
 globalThis.history={replaceState:(_,__,url)=>{current=new URL(url,current)}};
 globalThis.fetch=async(url,options)=>{calls.push({url,...options});const result=queue.shift();assert.ok(result,'Unexpected request');if(result instanceof Error)throw result;return {ok:(result.status||200)<400,status:result.status||200,json:async()=>result.body};};
 const {api}=await import('../assets/api.js?oauth-test='+iteration++);
 return {api,storage,calls,queue,get redirect(){return redirected},get url(){return current},navigate:url=>{current=new URL(url,'https://rafwonko-stack.github.io/roomly/')}};
}
const tokens={access_token:'supabase-access',refresh_token:'supabase-refresh',expires_in:3600,provider_token:'never-store-google-token'};
const snapshot={revision:'r',user:{id:'employee',role:'employee'},bookings:[],rooms:[],settings:{time_zone:'Asia/Bishkek'}};
test('Google PKCE initiation, callback, reload, logout and repeat login',async()=>{
 const f=await fixture();await f.api.googleLogin();const verifier=f.storage.get('roomly.oauth.verifier');
 assert.equal(f.redirect.origin,'https://test.supabase.co');assert.equal(f.redirect.pathname,'/auth/v1/authorize');assert.equal(f.redirect.searchParams.get('provider'),'google');assert.equal(f.redirect.searchParams.get('redirect_to'),'https://rafwonko-stack.github.io/roomly/');assert.equal(f.redirect.searchParams.get('code_challenge_method'),'s256');assert.equal(f.redirect.searchParams.get('code_challenge'),createHash('sha256').update(verifier).digest('base64url'));
 f.navigate('?code=one-time&screen=rooms');f.queue.push({body:tokens},{body:snapshot});assert.deepEqual(await f.api.init(),snapshot);
 assert.equal(f.url.search,'?screen=rooms');assert.equal(f.url.hash,'');assert.equal(f.calls[0].url,'https://test.supabase.co/auth/v1/token?grant_type=pkce');assert.deepEqual(JSON.parse(f.calls[0].body),{auth_code:'one-time',code_verifier:verifier});assert.equal(f.calls[1].headers.Authorization,'Bearer supabase-access');assert.equal(f.storage.has('roomly.oauth.verifier'),false);assert.doesNotMatch(f.storage.get('roomly.session'),/provider|google-token/);
 f.queue.push({body:snapshot});assert.deepEqual(await f.api.init(),snapshot);assert.equal(f.calls.length,3);
 f.queue.push({body:{}});await f.api.logout();assert.equal(f.storage.has('roomly.session'),false);assert.equal(await f.api.init(),null);
 await f.api.googleLogin();assert.notEqual(f.storage.get('roomly.oauth.verifier'),verifier);f.navigate('?code=second');f.queue.push({body:tokens},{body:snapshot});assert.equal((await f.api.init()).user.role,'employee');
});
test('OAuth cancellation/query or fragment errors are cleared and never reflected as raw HTML',async()=>{
 for(const suffix of ['?error=access_denied&error_description=secret','#error=access_denied&error_description=secret']){const f=await fixture();await f.api.googleLogin();f.navigate(suffix);await assert.rejects(f.api.init(),/Вход отменён/);assert.equal(f.url.search,'');assert.equal(f.url.hash,'');assert.equal(f.storage.size,0);assert.equal(f.calls.length,0);}
});
test('missing verifier, expired code, denied snapshot and offline callback fail closed',async()=>{
 let f=await fixture();f.navigate('?code=orphan');await assert.rejects(f.api.init(),/Сессия входа истекла/);assert.equal(f.calls.length,0);
 for(const response of [{status:400,body:{message:'invalid grant'}},{body:tokens}]){f=await fixture();await f.api.googleLogin();f.navigate('?code=bad');f.queue.push(response);if(response.body.access_token)f.queue.push({status:403,body:{message:'Доступ не разрешён.'}});await assert.rejects(f.api.init());assert.equal(f.storage.size,0);assert.equal(f.url.search,'');}
 f=await fixture();await f.api.googleLogin();f.navigate('?code=network');f.queue.push(new Error('offline'));await assert.rejects(f.api.init(),/связаться/);assert.equal(f.storage.size,0);
});
test('existing implicit callbacks and recovery keep working; invalid tokens and expired sessions handled',async()=>{
 let f=await fixture();f.navigate('#access_token=a&refresh_token=r&expires_in=3600&type=recovery&provider_token=secret');f.queue.push({body:snapshot});assert.deepEqual(await f.api.init(),snapshot);assert.equal(f.url.hash,'');assert.doesNotMatch(f.storage.get('roomly.session'),/secret/);
 f=await fixture();f.navigate('#access_token=bad');await assert.rejects(f.api.init(),/сессию/);assert.equal(f.storage.size,0);
 f=await fixture();f.navigate('#access_token=old&refresh_token=refresh&expires_at=1');f.queue.push({body:tokens},{body:snapshot});assert.deepEqual(await f.api.init(),snapshot);assert.match(f.calls[0].url,/grant_type=refresh_token/);
 f.queue.push(new Error('offline'));await assert.rejects(f.api.logout(),/связаться/);assert.equal(f.storage.size,0);
});
