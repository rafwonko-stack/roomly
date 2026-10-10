import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('preview server serves real files, MIME and blocks traversal',async()=>{
 const child=spawn(process.execPath,['scripts/serve.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
 try {
  const ready=await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Server startup timeout')),7000).unref())]);
  const address=ready[0].toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(address);
  const html=await fetch(address,{signal:AbortSignal.timeout(7000)});assert.equal(html.status,200);assert.match(await html.text(),/app\.bundle\.js/);
  const js=await fetch(address+'/assets/app.bundle.js');assert.match(js.headers.get('content-type'),/javascript/);
  assert.equal((await fetch(address+'/supabase/001_schema.sql')).status,403);
  assert.equal((await fetch(address+'/%2e%2e%2fpackage.json')).status,403);
 }finally{child.kill();}
});
