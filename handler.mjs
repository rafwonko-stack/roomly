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
    // Session checks use the caller's own public key (as the browser does); only admin operations use the service key.
    const userKey=req.headers.get('apikey')||serviceKey;
    const call=async(path,body,admin=false,method='POST')=>{
      const res=await fetcher(url.replace(/\/$/,'')+path,{method,headers:{apikey:admin?serviceKey:userKey,
        Authorization:admin?'Bearer '+serviceKey:authorization,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
      const data=await res.json().catch(()=>null);return {ok:res.ok,status:res.status,data};
    };
    let created=null,passwordChange=false,deletion=false;
    try{
      // Verify the token AND current database permissions. User metadata is not authority.
      const identity=await call('/auth/v1/user',undefined,false,'GET');
      // A session record can disappear on the Auth side while the signed token is still valid. Only that case is tolerated:
      // the token is then verified by PostgREST itself (app_snapshot) and the admin role is re-read from the database.
      const sessionGone=!identity.ok&&identity.data?.error_code==='session_not_found';
      if(!sessionGone&&(!identity.ok||!identity.data?.id)){const why=identity.data?.error_code||identity.data?.code||identity.status;console.error('Auth /user rejected the session:',identity.status,why);return reply(401,{message:'Сессия истекла. Выйдите, войдите снова и повторите. (код: '+why+')'});}
      if(sessionGone)console.warn('Auth session record not found; relying on verified token and database role.');
      const actor=await call('/rest/v1/rpc/app_snapshot',{});
      const callerId=identity.ok?identity.data.id:actor.data?.user?.id;
      if(!actor.ok||!callerId||actor.data?.user?.id!==callerId||actor.data.user.role!=='admin')
        return reply(403,{message:'Создавать аккаунты может только действующий администратор.'});
      // Read a bounded body, without buffering arbitrary input in memory.
      const reader=req.body?.getReader();let size=0,parts=[];
      if(reader)while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return reply(413,{message:'Слишком большой запрос.'});}parts.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
      let input;try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply(400,{message:'Некорректные данные.'});}
      if(input?.action==='delete_user'){
        deletion=true;
        if(Object.keys(input).some(k=>!['action','user_id'].includes(k))||typeof input.user_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.user_id))
          return reply(400,{message:'Укажите аккаунт для удаления.'});
        if(input.user_id.toLowerCase()===String(callerId).toLowerCase())return reply(400,{message:'Свой аккаунт удалить нельзя.'});
        const target=await call('/auth/v1/admin/users/'+input.user_id,undefined,true,'GET');
        if(!target.ok)return reply(404,{message:'Аккаунт не найден.'});
        const email=typeof target.data?.email==='string'?target.data.email.trim().toLowerCase():'';
        // Remove the Auth identity first: once it is gone nobody can sign in with it.
        const removed=await call('/auth/v1/admin/users/'+input.user_id,undefined,true,'DELETE');
        if(!removed.ok)return reply(removed.status===429?429:400,{message:'Аккаунт не удалён. Попробуйте ещё раз или удалите его в Supabase → Authentication → Users.'});
        // Then drop the role/access row so a later account with the same email cannot inherit it. Bookings and audit history are kept.
        let cleaned=false;
        try{
          const byId=await call('/rest/v1/members?user_id=eq.'+input.user_id,undefined,true,'DELETE');
          const byEmail=email?await call('/rest/v1/members?email=eq.'+encodeURIComponent(email),undefined,true,'DELETE'):{ok:true};
          cleaned=byEmail.ok&&(byId.ok||(Boolean(email)&&byId.status===400));
        }catch{cleaned=false;}
        return reply(200,{success:true,...(cleaned?{}:{warning:'Аккаунт удалён из Supabase Authentication, но запись о правах доступа не очищена. Проверьте таблицу members в Supabase.'})});
      }
      if(input?.action==='set_password'){
        passwordChange=true;
        if(Object.keys(input).some(k=>!['action','user_id','password'].includes(k))||typeof input.user_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.user_id)||typeof input.password!=='string'||input.password.length<6||input.password.length>128)
          return reply(400,{message:'Укажите аккаунт и пароль от 6 до 128 символов.'});
        const target=await call('/auth/v1/admin/users/'+input.user_id,undefined,true,'GET');
        if(!target.ok)return reply(404,{message:'Аккаунт не найден.'});
        const updated=await call('/auth/v1/admin/users/'+input.user_id,{password:input.password},true,'PUT');
        if(!updated.ok)return reply(updated.status===429?429:400,{message:'Пароль не изменён. Проверьте требования к паролям в настройках Supabase.'});
        return reply(200,{success:true});
      }
      if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['email','password','full_name'].includes(k)))return reply(400,{message:'Допустимы только ФИО, email и пароль.'});
      const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
      const full_name=typeof input.full_name==='string'?input.full_name.trim():'';
      if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||full_name.length<2||full_name.length>120||typeof input.password!=='string'||input.password.length<6||input.password.length>128)
        return reply(400,{message:'Укажите ФИО, корректный email и пароль длиной от 6 до 128 символов.'});
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
      if(deletion)return reply(503,{message:'Не удалось подтвердить удаление. Обновите список сотрудников: аккаунт мог быть удалён.'});
      if(passwordChange)return reply(503,{message:'Не удалось подтвердить смену пароля. Проверьте вход с новым паролем перед повтором.'});
      // Do not retry identity creation, delete users or leak upstream details/passwords.
      if(created)return reply(202,{id:created,warning:'Аккаунт создан, но завершение активации не подтверждено. Проверьте его блокировку и роль employee в Supabase перед передачей доступа. Не создавайте его повторно.'});
      return reply(503,{message:'Не удалось завершить запрос. Перед повтором проверьте Authentication → Users в Supabase: аккаунт мог быть создан.'});
    }
  };
}
