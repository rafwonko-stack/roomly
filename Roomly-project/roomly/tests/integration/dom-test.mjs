import {Window} from 'happy-dom';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=new URL('../../',import.meta.url);
const w=new Window({url:'https://roomly.example',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
// DOM simulation only. No real browser, networking or layout engine.
w.document.body.innerHTML='<div id="app"></div><dialog id="modal"></dialog><div id="toast"></div>';
w.eval(await readFile(new URL('config.js',base),'utf8'));
w.eval(await readFile(new URL('assets/app.bundle.js',base),'utf8'));
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setTimeout(r,10));};
await settle();
const $=s=>w.document.querySelector(s),all=s=>[...w.document.querySelectorAll(s)];
assert.equal($('h1').textContent,'Расписание');assert.equal(all('.schedule-row').length,10);assert.equal(all('.slot').length,240);console.log('PASS demo boot, 10 rooms, 240 half-hour slots');
$('[data-action="new"]').click();assert.ok($('#booking-form'));const countBefore=JSON.parse(w.localStorage.getItem('roomly.demo.v1')).bookings.length;
$('#booking-form [data-action="close"]').click();await settle();assert.equal(JSON.parse(w.localStorage.getItem('roomly.demo.v1')).bookings.length,countBefore);console.log('PASS cancel form never submits');
$('[data-action="new"]').click();let f=$('#booking-form');f.elements.title.value='<img src=x onerror=alert(1)>';f.elements.date.value=new Date(Date.now()+86400000*2).toISOString().slice(0,10);f.elements.start_time.value='10:00';f.elements.end_time.value='11:00';f.elements.full_name.value='Тестовый Сотрудник';f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();
assert.equal($('#modal-title').textContent,'Встреча запланирована');assert.equal($('#modal img'),null);let bookings=JSON.parse(w.localStorage.getItem('roomly.demo.v1')).bookings;const b=bookings.at(-1);assert.equal(bookings.length,countBefore+1);console.log('PASS create/save/confirmation and HTML escaped');
$('[data-edit]').click();f=$('#booking-form');f.elements.title.value='Обновлённая встреча';f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.match($('.details-title').textContent,/Обновлённая/);console.log('PASS edit booking');
$('[data-cancel]').click();$('[data-confirm-cancel]').click();await settle();assert.equal(JSON.parse(w.localStorage.getItem('roomly.demo.v1')).bookings.find(x=>x.id===b.id).status,'cancelled');console.log('PASS cancellation confirmation and persistence');
$('[data-page="rooms"]').click();assert.equal(all('.room-card').length,10);$('#floor-filter').value='3';$('#floor-filter').dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(all('.room-card').length,2);console.log('PASS floor filter');
$('[data-action="account"]').click();$('[data-role="admin"]').click();await settle();assert.ok($('[data-page="admin"]'));$('[data-page="admin"]').click();assert.equal(all('.room-card').length,10);$('[data-action="new-room"]').click();let rf=$('#room-form');rf.elements.name.value='Новый зал';rf.elements.capacity.value='12';rf.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(all('.room-card').length,11);console.log('PASS admin role and room creation');
$('[data-page="audit"]').click();assert.ok(all('tbody tr').length>=4);$('[data-page="schedule"]').click();$('[data-view="week"]').click();assert.equal(all('.week-day').length,7);$('[data-view="list"]').click();assert.ok($('.table-scroll'));console.log('PASS audit, weekly and list views');
await w.happyDOM.close();console.log('DOM TESTS COMPLETE');

