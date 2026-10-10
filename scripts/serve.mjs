import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const port=Number(process.env.PORT||4173);
const server=http.createServer(async(req,res)=>{try{
 const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname); const target=resolve(root,'.'+(path==='/'?'/index.html':path));
 if(!target.startsWith(root+sep)||!['.html','.js','.css','.svg','.json'].includes(extname(target))) {res.writeHead(403);res.end();return;}
 const body=await readFile(target);res.writeHead(200,{'Content-Type':types[extname(target)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);
}catch{res.writeHead(404);res.end('Not found');}}).listen(port,'127.0.0.1',()=>console.log(`Roomly: http://127.0.0.1:${server.address().port}`));
