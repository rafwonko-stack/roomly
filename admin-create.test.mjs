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
const change={action:'set_password',user_id:'11111111-2222-3333-4444-555555555555',password:'110322'};
test('admin changes password only, retaining role and ban; digits and letters accepted',async()=>{
 for(const password of ['110322','admins']){
 const {handler,calls}=setup([{body:identity},{body:actor},{body:{id:change.user_id}},{body:{id:change.user_id}}]);
 assert.equal((await handler(request({...change,password}))).status,200);
 assert.deepEqual(calls[3].body,{password});assert.equal(calls[3].method,'PUT');assert.equal(calls.length,4);
 }
});
test('employee cannot reset another password; invalid target and short password rejected',async()=>{
 const denied=setup([{body:identity},{body:{user:{id:identity.id,role:'employee'}}}]);assert.equal((await denied.handler(request(change))).status,403);assert.equal(denied.calls.length,2);
 for(const payload of [{...change,password:'12345'},{...change,user_id:'../admin'},{...change,role:'admin'}]){const {handler,calls}=setup([{body:identity},{body:actor}]);assert.equal((await handler(request(payload))).status,400);assert.equal(calls.length,2);}
});
test('new employee accepts six characters',async()=>{
 const {handler}=setup([{body:identity},{body:actor},{body:[]},{body:{id:'new'}},{body:{success:true}},{body:{id:'new'}}]);assert.equal((await handler(request({...input,password:'110322'}))).status,201);
});
const removal={action:'delete_user',user_id:'11111111-2222-3333-4444-555555555555'};
const target={id:removal.user_id,email:'Old@Example.com'};
test('admin deletes Auth user, then clears members by id and email',async()=>{
 const {handler,calls}=setup([{body:identity},{body:actor},{body:target},{status:200,body:{}},{body:[]},{body:[]}]);
 const res=await handler(request(removal));assert.equal(res.status,200);const data=await res.json();assert.equal(data.success,true);assert.equal(data.warning,undefined);
 assert.equal(calls[2].method,'GET');assert.equal(calls[3].method,'DELETE');assert.match(calls[3].url,/\/auth\/v1\/admin\/users\/11111111-2222-3333-4444-555555555555$/);assert.equal(calls[3].headers.Authorization,'Bearer server-secret');
 assert.equal(calls[4].method,'DELETE');assert.match(calls[4].url,/\/rest\/v1\/members\?user_id=eq\./);assert.equal(calls[5].method,'DELETE');assert.match(calls[5].url,/members\?email=eq\.old%40example\.com$/);assert.equal(calls.length,6);
});
test('delete is refused for anonymous, employee, self, bad id and extra fields; nothing is removed',async()=>{
 const denied=setup([{body:identity},{body:{user:{id:identity.id,role:'employee'}}}]);assert.equal((await denied.handler(request(removal))).status,403);assert.ok(denied.calls.every(c=>c.method!=='DELETE'));
 for(const payload of [{...removal,user_id:identity.id},{...removal,user_id:'admin-id'},{...removal,user_id:'../x'},{...removal,role:'admin'}]){const {handler,calls}=setup([{body:identity},{body:actor}]);assert.equal((await handler(request(payload))).status,400);assert.equal(calls.length,2);}
 const anon=setup([]);assert.equal((await anon.handler(request(removal,null))).status,401);assert.equal(anon.calls.length,0);
});
test('own account (matching UUID) cannot be deleted',async()=>{
 const me={id:removal.user_id};const {handler,calls}=setup([{body:me},{body:{user:{id:me.id,role:'admin'}}}]);
 assert.equal((await handler(request(removal))).status,400);assert.ok(calls.every(c=>c.method!=='DELETE'));
});
test('unknown target gives 404 and failed Auth delete leaves members untouched',async()=>{
 const missing=setup([{body:identity},{body:actor},{status:404,body:{}}]);assert.equal((await missing.handler(request(removal))).status,404);assert.equal(missing.calls.length,3);
 const failed=setup([{body:identity},{body:actor},{body:target},{status:500,body:{}}]);assert.equal((await failed.handler(request(removal))).status,400);assert.equal(failed.calls.length,4);
});
test('members cleanup failure after Auth delete is reported as a warning',async()=>{
 const {handler}=setup([{body:identity},{body:actor},{body:target},{body:{}},{status:500,body:{}},{status:500,body:{}}]);
 const res=await handler(request(removal));assert.equal(res.status,200);assert.match((await res.json()).warning,/members/);
});
test('network failure during delete does not leak secrets',async()=>{
 const {handler}=setup([{body:identity},{body:actor},{body:target},new Error('server-secret')]);
 const res=await handler(request(removal));assert.equal(res.status,503);assert.doesNotMatch(await res.text(),/server-secret/);
});
test('session check uses the caller public key; admin operations use the service key',async()=>{
 const {handler,calls}=setup([{body:identity},{body:actor},{body:[]},{body:{id:'n'}},{body:{success:true}},{body:{id:'n'}}]);
 const req=new Request('https://edge.example/create-employee',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer caller',apikey:'public-key'},body:JSON.stringify(input)});
 assert.equal((await handler(req)).status,201);assert.equal(calls[0].headers.apikey,'public-key');assert.equal(calls[1].headers.apikey,'public-key');assert.equal(calls[3].headers.apikey,'server-secret');
});
test('rejected session reports a diagnostic code',async()=>{
 const {handler}=setup([{status:401,body:{error_code:'bad_jwt'}}]);const res=await handler(request(input));assert.equal(res.status,401);assert.match((await res.json()).message,/bad_jwt/);
});
const gone={status:403,body:{error_code:'session_not_found'}};
test('missing Auth session record is tolerated only with a verified admin token',async()=>{
 const ok=setup([gone,{body:{user:{id:'admin-id',role:'admin'}}},{body:target},{body:{}},{body:[]},{body:[]}]);
 assert.equal((await ok.handler(request(removal))).status,200);assert.ok(ok.calls.some(c=>c.method==='DELETE'&&c.url.includes('/admin/users/')));
 const employee=setup([gone,{body:{user:{id:'e',role:'employee'}}}]);assert.equal((await employee.handler(request(removal))).status,403);assert.ok(employee.calls.every(c=>c.method!=='DELETE'));
 const anon=setup([gone,{status:401,body:{}}]);assert.equal((await anon.handler(request(removal))).status,403);assert.ok(anon.calls.every(c=>c.method!=='DELETE'));
 const self=setup([gone,{body:{user:{id:removal.user_id,role:'admin'}}}]);assert.equal((await self.handler(request(removal))).status,400);assert.ok(self.calls.every(c=>c.method!=='DELETE'));
});
