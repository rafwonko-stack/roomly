export function createHandler({url,serviceKey,origin},fetcher=fetch){
  return async function handle(req){
    const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',
      'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods':'POST, OPTIONS'};
    const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    if(req.headers.get('origin')&&req.headers.get('origin')!==origin)return reply(403,{message:'Недопустимый источник запроса.'});
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(req.method!=='POST')return reply(405,{message:'Используйте POST.'});
    const authorization=req.headers.get('authorization');
    if(!authorization?.startsWith('Bearer '))return reply(401,{message:'Войдите в аккаунт администратора.'});
    if(!url||!serviceKey)return reply(503,{message:'Серверная функция не настроена.'});
    const call=async(path,body,admin=false,method='POST')=>{
      const res=await fetcher(url.replace(/\/$/,'')+path,{method,headers:{apikey:serviceKey,
        Authorization:admin?'Bearer '+serviceKey:authorization,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
      const data=await res.json().catch(()=>null);return {ok:res.ok,status:res.status,data};
    };
    let created=null;
    try{
      // Verify the token AND current database permissions. User metadata is not authority.
      const identity=await call('/auth/v1/user',undefined,false,'GET');
      if(!identity.ok||!identity.data?.id)return reply(401,{message:'Сессия истекла. Войдите снова.'});
      const actor=await call('/rest/v1/rpc/app_snapshot',{});
      if(!actor.ok||actor.data?.user?.id!==identity.data.id||actor.data.user.role!=='admin')
        return reply(403,{message:'Создавать аккаунты может только действующий администратор.'});
      // Read a bounded body, without buffering arbitrary input in memory.
      const reader=req.body?.getReader();let size=0,parts=[];
      if(reader)while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return reply(413,{message:'Слишком большой запрос.'});}parts.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
      let input;try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply(400,{message:'Некорректные данные.'});}
      if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['email','password','full_name'].includes(k)))return reply(400,{message:'Допустимы только ФИО, email и пароль.'});
      const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
      const full_name=typeof input.full_name==='string'?input.full_name.trim():'';
      if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||full_name.length<2||full_name.length>120||typeof input.password!=='string'||input.password.length<12||input.password.length>128)
        return reply(400,{message:'Укажите ФИО, корректный email и пароль длиной от 12 до 128 символов.'});
      // Never reactivate a blocked pre-authorized account or inherit a reserved admin role.
      const reserved=await call('/rest/v1/members?select=role,active&email=eq.'+encodeURIComponent(email),undefined,true,'GET');
      if(!reserved.ok||!Array.isArray(reserved.data))return reply(503,{message:'Не удалось проверить права сотрудника.'});
      if(reserved.data.some(m=>m.role!=='employee'||m.active!==true))return reply(409,{message:'Для этого email уже настроены особые права или блокировка. Существующий доступ не изменён.'});
      // Keep the new identity banned until employee permissions have been saved successfully.
      const result=await call('/auth/v1/admin/users',{email,password:input.password,email_confirm:true,
        ban_duration:'876000h',user_metadata:{full_name}},true);
      if(!result.ok){
        if(result.data?.code==='email_exists'||/already|registered|exists/i.test(result.data?.msg||result.data?.message||''))return reply(409,{message:'Аккаунт с этим email уже существует. Его пароль и права не изменены.'});
        return reply(result.status===429?429:400,{message:'Supabase отклонил создание аккаунта. Проверьте требования к паролю и настройки Auth.'});
      }
      created=result.data?.id||result.data?.user?.id;
      if(!created)throw Error('Missing created identity');
      const access=await call('/rest/v1/rpc/save_member',{p_email:email,p_role:'employee',p_active:true});
      if(!access.ok||access.data?.success!==true)throw Error('Permission assignment failed');
      const activate=await call('/auth/v1/admin/users/'+encodeURIComponent(created),{ban_duration:'none'},true,'PUT');
      if(!activate.ok)throw Error('Activation failed');
      return reply(201,{id:created,email,role:'employee'});
    }catch{
      // Do not retry identity creation, delete users or leak upstream details/passwords.
      if(created)return reply(202,{id:created,warning:'Аккаунт создан, но завершение активации не подтверждено. Проверьте его блокировку и роль employee в Supabase перед передачей доступа. Не создавайте его повторно.'});
      return reply(503,{message:'Не удалось завершить запрос. Перед повтором проверьте Authentication → Users в Supabase: аккаунт мог быть создан.'});
    }
  };
}
