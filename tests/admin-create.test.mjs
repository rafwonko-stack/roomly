import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../supabase/functions/create-employee/handler.mjs';
const input={email:' New@Example.com ',password:'Long-Test-Password',full_name:'New Employee'};
const identity={id:'admin-id'};
const actor={user:{id:'admin-id',role:'admin'}};
function setup(responses){const calls=[];const handler=createHandler({url:'https://example.supabase.co',serviceKey:'server-secret',origin:'https://rafwonko-stack.github.io'},async(url,options)=>{calls.push({url,...options,body:options.body&&JSON.parse(options.body)});assert.ok(responses.length,'Unexpected fetch');const response=responses.shift();if(response instanceof Error)throw response;return new Response(JSON.stringify(response.body),{status:response.status||200});});return {handler,calls};}
function request(body=input,token='caller'){return new Request('https://edge.example/create-employee',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});}
test('anonymous, invalid session, employee and disabled admin cannot create users',async()=>{
 for(const [responses,token,status] of [[[],null,401],[[{status:401,body:{}}],'bad',401],[[{body:identity},{body:{user:{id:'admin-id',role:'employee'}}}],'caller',403],[[{body:identity},{status:403,body:{error:'disabled'}}],'caller',403]]){
 const {handler,calls}=setup(responses);assert.equal((await handler(request(input,token))).status,status);assert.ok(calls.every(c=>!c.url.includes('/admin/users')));
 }
});
test('admin creates confirmed Auth user, assigns employee and only then activates',async()=>{
 const {handler,calls}=setup([{body:identity},{body:actor},{body:[]},{body:{id:'new-id'}},{body:{success:true}},{body:{id:'new-id'}}]);
 const response=await handler(request());assert.equal(response.status,201);const data=await response.json();assert.equal(data.role,'employee');assert.equal(data.password,undefined);
 assert.equal(calls[0].headers.Authorization,'Bearer caller');assert.equal(calls[1].headers.Authorization,'Bearer caller');
 assert.equal(calls[3].headers.Authorization,'Bearer server-secret');assert.equal(calls[3].body.ban_duration,'876000h');assert.equal(calls[3].body.email_confirm,true);assert.equal(calls[3].body.email,'new@example.com');
 assert.deepEqual(calls[4].body,{p_email:'new@example.com',p_role:'employee',p_active:true});assert.equal(calls[4].headers.Authorization,'Bearer caller');assert.equal(calls[5].body.ban_duration,'none');
});
test('client cannot request admin role; weak passwords rejected before mutations',async()=>{
 for(const body of [{...input,role:'admin'},{...input,password:'short'}]){const {handler,calls}=setup([{body:identity},{body:actor}]);assert.equal((await handler(request(body))).status,400);assert.equal(calls.length,2);}
});
test('reserved admin and blocked account remain untouched',async()=>{
 for(const member of [{role:'admin',active:true},{role:'employee',active:false}]){const {handler,calls}=setup([{body:identity},{body:actor},{body:[member]}]);assert.equal((await handler(request())).status,409);assert.equal(calls.length,3);}
});
test('duplicate user never updates existing password or privileges',async()=>{
 const {handler,calls}=setup([{body:identity},{body:actor},{body:[]},{status:422,body:{code:'email_exists'}}]);assert.equal((await handler(request())).status,409);assert.equal(calls.length,4);
});
test('failed permission assignment keeps new account banned and reports partial completion',async()=>{
 const {handler,calls}=setup([{body:identity},{body:actor},{body:[]},{body:{id:'new-id'}},{body:{error:'denied'}}]);const res=await handler(request());assert.equal(res.status,202);assert.match((await res.json()).warning,/активации/);assert.equal(calls.length,5);
});
test('network failure does not retry create or expose secrets',async()=>{
 const {handler,calls}=setup([{body:identity},{body:actor},{body:[]},new Error('server-secret')]);const res=await handler(request());assert.equal(res.status,503);assert.doesNotMatch(await res.text(),/server-secret|Long-Test-Password/);assert.equal(calls.length,4);
});
