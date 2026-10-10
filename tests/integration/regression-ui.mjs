import {Window} from 'happy-dom';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=new URL('../../',import.meta.url),bundle=await readFile(new URL('assets/app.bundle.js',base),'utf8');
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,10));};
const out={},tomorrow=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
const room={id:'room-1',name:'Тестовый зал',floor:1,capacity:8,active:true,description:'',equipment:[]};
const b={id:'other',room_id:room.id,owner_id:'someone-else',title:'Чужая бронь',full_name:'Другой Сотрудник',email:'other@example.com',phone:'',attendees:2,date:tomorrow,start_time:'10:00',end_time:'11:00',status:'active',created_at:new Date().toISOString()};
const seed={rooms:[room],bookings:[b],members:[],audit:[],settings:{time_zone:'Asia/Bishkek'}};
function prepare(){const w=new Window({url:'https://roomly.example',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});w.document.body.innerHTML='<div id="app"></div><dialog id="modal"></dialog><div id="toast"></div>';return w;}
function fill(w){w.document.querySelector('[data-action="new"]').click();const f=w.document.querySelector('#booking-form');f.elements.title.value='Новая встреча';f.elements.date.value=tomorrow;f.elements.start_time.value='10:00';f.elements.end_time.value='11:00';f.elements.full_name.value='Тестовый Пользователь';return f;}
const w=prepare();w.eval(await readFile(new URL('config.js',base),'utf8'));w.localStorage.setItem('roomly.demo.v1',JSON.stringify(seed));w.eval(bundle);await settle();
const f=fill(w);const changed=JSON.parse(w.localStorage.getItem('roomly.demo.v1'));changed.bookings[0].status='cancelled';w.localStorage.setItem('roomly.demo.v1',JSON.stringify(changed));
f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();out.staleConflict={actualStatus:JSON.parse(w.localStorage.getItem('roomly.demo.v1')).bookings[0].status,modalTitle:w.document.querySelector('#modal-title').textContent,created:JSON.parse(w.localStorage.getItem('roomly.demo.v1')).bookings.some(x=>x.title==='Новая встреча')};assert.equal(out.staleConflict.created,true);assert.equal(out.staleConflict.modalTitle,'Встреча запланирована');await w.happyDOM.close();
const x=prepare();x.eval("window.ROOMLY_CONFIG={supabaseUrl:'https://example.supabase.co',supabaseKey:'test-public',officeName:'Тест',timeZone:'Asia/Bishkek'}");
x.sessionStorage.setItem('roomly.session',JSON.stringify({access_token:'test',refresh_token:'refresh',expires_at:Math.floor(Date.now()/1000)+3600}));
let calls=0,saved=false;x.fetch=async(url,options)=>{calls++;if(calls===1)return new x.Response(JSON.stringify({...seed,bookings:[],revision:'1',user:{id:'user',email:'test@example.com',full_name:'Тестовый Пользователь',role:'employee'}}));if(url.endsWith('/save_booking')){saved=true;const booking=JSON.parse(options.body).p_booking;return new x.Response(JSON.stringify({...booking,id:'saved',owner_id:'user',status:'active'}));}throw Error('simulated network failure after successful save');};
x.eval(bundle);await settle();const xf=fill(x);xf.dispatchEvent(new x.Event('submit',{bubbles:true,cancelable:true}));await settle();out.savedButReportedError={serverSaveSucceeded:saved,modalTitle:x.document.querySelector('#modal-title').textContent,visibleMessage:x.document.querySelector('#toast').textContent};assert.equal(saved,true);assert.equal(out.savedButReportedError.modalTitle,'Встреча запланирована');assert.match(out.savedButReportedError.visibleMessage,/Бронь сохранена/);await x.happyDOM.close();
console.log('PASS stale local conflict revalidated; successful save confirmed despite reload failure');
