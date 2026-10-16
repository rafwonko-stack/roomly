import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window={ROOMLY_CONFIG:{supabaseUrl:'https://example.supabase.co/rest/v1/',supabaseKey:'public-test-key'}};
const store=new Map();globalThis.sessionStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
const calls=[],responses=[];globalThis.fetch=async(url,init)=>{calls.push({url,...init});const next=responses.shift();if(next instanceof Error)throw next;assert.ok(next,'Unexpected fetch');return {ok:next.status<400,status:next.status,json:async()=>next.body};};
const {api,live}=await import('../assets/api.js');
const snapshot={revision:'r1',user:{id:'u',role:'employee'},settings:{time_zone:'Asia/Bishkek'},rooms:[],bookings:[],audit:[],members:[]};
const token={access_token:'access',refresh_token:'refresh',expires_at:Math.floor(Date.now()/1000)+3600};
test('production adapter: auth, refresh, requests and errors',async()=>{
 assert.equal(live,true);
 responses.push({status:200,body:token},{status:200,body:snapshot});
 assert.deepEqual(await api.login('a@example.com','test-only-password'),snapshot);
 assert.equal(calls[0].url,'https://example.supabase.co/auth/v1/token?grant_type=password');
 assert.equal(calls[1].headers.Authorization,'Bearer access');
 responses.push({status:200,body:'r1'});assert.equal(await api.hasChanges(),false);
 responses.push({status:200,body:'r2'});assert.equal(await api.hasChanges(),true);
 responses.push({status:401,body:{message:'JWT expired'}},{status:200,body:{...token,access_token:'new-access'}},{status:200,body:snapshot});
 assert.deepEqual(await api.load(),snapshot);assert.equal(calls.at(-1).headers.Authorization,'Bearer new-access');
 responses.push({status:200,body:{error:'Зал уже занят'}});await assert.rejects(api.saveBooking({title:'test'}),/занят/);
 assert.deepEqual(JSON.parse(calls.at(-1).body),{p_booking:{title:'test'}});
 responses.push({status:201,body:{id:'created',role:'employee'}});assert.equal((await api.createEmployee({email:'new@example.com',password:'Long-Test-Password',full_name:'Test User'})).role,'employee');assert.equal(calls.at(-1).url,'https://example.supabase.co/functions/v1/create-employee');
 responses.push(new Error('offline'));await assert.rejects(api.load(),/связаться/);
 responses.push(new Error('offline'));await assert.rejects(api.logout(),/связаться/);assert.equal(store.has('roomly.session'),false);
 assert.equal(responses.length,0);
});

test('only Email login is exposed; no public signup or recovery',()=>{for(const key of ['recover','signup','resend','phoneLogin','phoneSignup','phoneCode','verifyPhone','linkPhone','verifyLinkedPhone','googleLogin'])assert.equal(api[key],undefined);});
