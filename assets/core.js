export const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function officeParts(date = new Date(), timeZone = 'Asia/Bishkek') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`, time:`${p.hour}:${p.minute}`};
}
export function addDays(date, n) { return new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10); }
export const minutes = t => Number(t.slice(0,2))*60+Number(t.slice(3,5));
export const timeString = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
export const times = Array.from({length:25},(_,i)=>timeString(480+i*30));
export const overlap = (a,b) => a.start_time < b.end_time && b.start_time < a.end_time;
export function validateBooking(b, room, bookings, now=officeParts()) {
  if (!room?.active) return 'Этот зал отключён. Выберите другой.';
  if (!b.full_name?.trim() || b.full_name.trim().length<3 || b.full_name.length>120) return 'Укажите ФИО: от 3 до 120 символов.';
  if (!b.title?.trim() || b.title.length>100) return 'Укажите тему встречи: до 100 символов.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return 'Проверьте email.';
  if (b.phone && (!/^\+?[\d ()-]{7,24}$/.test(b.phone) || b.phone.replace(/\D/g,'').length<7 || b.phone.replace(/\D/g,'').length>15)) return 'Проверьте телефон: 7–15 цифр; допустимы +, пробелы, скобки и дефисы.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date+'T12:00:00Z')) || addDays(b.date,0)!==b.date) return 'Выберите корректную дату.';
  if (b.date < now.date || b.date > addDays(now.date,30)) return 'Бронирование доступно на ближайшие 30 дней.';
  if (!times.includes(b.start_time) || !times.includes(b.end_time)) return 'Рабочее время: 08:00–20:00, шаг 30 минут.';
  const duration=minutes(b.end_time)-minutes(b.start_time);
  if (duration<15 || duration>480) return 'Продолжительность должна быть от 30 минут до 8 часов.';
  if (b.date===now.date && b.start_time<=now.time) return 'Нельзя забронировать прошедшее время.';
  if (!Number.isInteger(+b.attendees) || +b.attendees<1 || +b.attendees>room.capacity) return `Укажите от 1 до ${room.capacity} участников.`;
  if (bookings.some(x=>x.id!==b.id && x.status==='active' && x.room_id===b.room_id && x.date===b.date && overlap(x,b))) return 'Зал занят в это время. Выберите другой интервал или зал.';
  return '';
}
export function mayEdit(b,user,now) { return b.status==='active' && (user.role==='admin' || (b.owner_id===user.id && (b.date>now.date || b.date===now.date&&b.start_time>now.time))); }
export function roomArt(floor=1,large=false) {
  return `<svg viewBox="0 0 360 170" aria-hidden="true" class="room-art"><defs><pattern id="grid${floor}${large}" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0V22" fill="none" stroke="currentColor" opacity=".08"/></pattern></defs><rect width="360" height="170" fill="url(#grid${floor}${large})"/><g transform="translate(100 15) rotate(-12 80 70)"><path d="M0 15Q0 0 15 0H150Q165 0 165 15V125Q165 140 150 140H15Q0 140 0 125Z" fill="#fff" opacity=".3" stroke="currentColor"/><rect x="44" y="28" width="78" height="86" rx="${large?12:35}" fill="currentColor" opacity=".18" stroke="currentColor" stroke-width="2"/>${[35,68,101].map(y=>`<rect x="27" y="${y}" width="12" height="18" rx="4" fill="currentColor" opacity=".4"/><rect x="127" y="${y}" width="12" height="18" rx="4" fill="currentColor" opacity=".4"/>`).join('')}<rect x="63" y="10" width="40" height="5" rx="2" fill="currentColor"/><circle cx="146" cy="121" r="9" fill="currentColor" opacity=".4"/></g><text x="18" y="145" font-size="11" fill="currentColor" opacity=".5">ЭТАЖ 0${floor}</text></svg>`;
}

export function validationClock(b,previous,user,now){return user.role==='admin'&&previous&&b.date===previous.date&&b.room_id===previous.room_id&&b.start_time===previous.start_time&&b.end_time===previous.end_time&&b.date<=now.date?{date:b.date,time:'00:00'}:now;}
