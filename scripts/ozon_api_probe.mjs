// Пробная сверка API Ozon с данными из CSV в базе (этап 3, «загрузка через API вместо CSV»). ТОЛЬКО ЧТЕНИЕ: в базу ничего не пишет.
// Репозиторий публичный — в лог идут только устройство ответов (поля и типы, без значений), названия колонок и типов
// и доли/расхождения в процентах; рублей, штук и артикулов в логе нет.
// Запуск: workflow ozon-api-probe (вручную), вход DAYS — дни через запятую (по умолчанию 3 дня, начиная с позавчера).
// Проход 2 (21.10.2026): /v2/posting/fbo/list и /v3/finance/transaction/list отключены — ищем замену заказам
// (новые списки отправлений, отчёт «Заказы» через /v1/report/postings/create) и полное устройство /v1/finance/accrual/by-day.
const OZON='https://api-seller.ozon.ru';
const H={'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json'};
const SB=process.env.SUPABASE_URL, SR={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ozon(path,body){
  for(let a=0;a<4;a++){
    const r=await fetch(OZON+path,{method:'POST',headers:H,body:JSON.stringify(body)});
    const t=await r.text(); let j=null; try{j=JSON.parse(t);}catch(e){}
    if(r.status===429||r.status>=500){await sleep(1500*(a+1));continue;}
    return {status:r.status,json:j,text:j?null:t.slice(0,200)};
  }
  return {status:0,json:null,text:'нет ответа'};
}
const msg=r=>r.status+' '+(r.json?.message||r.text||'');
async function sbAll(path){ // постранично, с сортировкой (PostgREST отдаёт не больше 1000 строк)
  let out=[],off=0;
  for(;;){const r=await fetch(`${SB}/rest/v1/${path}&limit=1000&offset=${off}`,{headers:SR}); if(!r.ok)throw new Error('Supabase HTTP '+r.status+' '+path.split('?')[0]);
    const j=await r.json(); out=out.concat(j); if(j.length<1000)break; off+=1000;}
  return out;
}
// устройство: путь → типы (объединение по всем элементам массивов), значения не печатаются
function shape(o,p='',acc=new Map()){
  const add=(k,t)=>{const s=acc.get(k)||new Set();s.add(t);acc.set(k,s);};
  if(Array.isArray(o)){add(p+'[]','array'); o.forEach(x=>shape(x,p+'[]',acc));}
  else if(o&&typeof o==='object'){for(const k of Object.keys(o))shape(o[k],p?p+'.'+k:k,acc);}
  else add(p,o===null?'null':typeof o);
  return acc;
}
const printShape=(title,acc)=>{console.log(title);[...acc.keys()].sort().forEach(k=>console.log('  '+k+': '+[...acc.get(k)].join('|')));};
const pct=(a,b)=>b===0?(a===0?'0%':'∞'):((a-b)/Math.abs(b)*100).toFixed(2)+'%';
const share=(a,b)=>b===0?'—':(a/b*100).toFixed(1)+'%';
const mskDay=iso=>{const d=new Date(new Date(iso).getTime()+3*3600e3);return d.toISOString().slice(0,10);};
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const today=mskDay(new Date().toISOString());
const DAYS=(process.env.DAYS||'').split(',').map(s=>s.trim()).filter(Boolean);
if(!DAYS.length)for(let i=4;i>=2;i--)DAYS.push(addDays(today,-i));
console.log('Дни сверки:',DAYS.join(', '));
const since=addDays(DAYS[0],-1)+'T21:00:00.000Z', to=DAYS[DAYS.length-1]+'T20:59:59.999Z'; // границы суток по Москве

// ===== 1. Заказы: какие методы живы =====
console.log('\n===== 1. ЗАКАЗЫ: поиск рабочего метода =====');
const tries=[
  ['/v3/posting/fbo/list',{dir:'ASC',filter:{since,to,status:''},limit:10,offset:0,with:{analytics_data:true,financial_data:true}}],
  ['/v3/posting/fbo/list',{dir:'ASC',filter:{since,to},limit:10,cursor:''}],
  ['/v1/posting/fbo/list',{dir:'ASC',filter:{since,to},limit:10,offset:0}],
  ['/v4/posting/fbo/list',{filter:{since,to},limit:10}],
  ['/v3/posting/fbs/list',{dir:'ASC',filter:{since,to},limit:10,offset:0}],
  ['/v4/posting/fbs/list',{filter:{since,to},limit:10}],
];
for(const [p,b] of tries){const r=await ozon(p,b);console.log(`  ${p}: HTTP ${msg(r)}`);
  if(r.status===200&&r.json)printShape('    устройство:',shape(r.json));}

// Отчёт «Заказы» через API: тот же CSV, что в кабинете (ожидание до ~3 минут)
console.log('\nОтчёт об отправлениях /v1/report/postings/create (FBO):');
const rc=await ozon('/v1/report/postings/create',{filter:{processed_at_from:since,processed_at_to:to,delivery_schema:['fbo'],sku:[],cancel_reason_id:[],offer_id:'',status_alias:[],statuses:[],title:''},language:'DEFAULT'});
console.log('  create: HTTP',msg(rc)); const code=rc.json?.result?.code;
let fileUrl=null;
if(code){for(let i=0;i<36&&!fileUrl;i++){await sleep(5000);const ri=await ozon('/v1/report/info',{code});const st=ri.json?.result?.status;
  if(st==='success')fileUrl=ri.json.result.file; else if(st==='failed'){console.log('  отчёт: failed',ri.json?.result?.error||'');break;}}
  console.log('  отчёт:',fileUrl?'готов':'не готов за 3 минуты');}
if(fileUrl){
  const csv=await (await fetch(fileUrl)).text();
  const sep=(csv.slice(0,3000).match(/;/g)||[]).length>(csv.slice(0,3000).match(/,/g)||[]).length?';':',';
  const parse=t=>{const rows=[];let row=[],cur='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){cur+='"';i++;}else q=false;}else cur+=c;}else{if(c=='"')q=true;else if(c===sep){row.push(cur);cur='';}else if(c=='\n'){row.push(cur);rows.push(row);row=[];cur='';}else if(c!='\r')cur+=c;}}if(cur!==''||row.length){row.push(cur);rows.push(row);}return rows;};
  const rows=parse(csv.replace(/^﻿/,'')); const hdr=rows[0].map(s=>s.trim());
  console.log('  колонки:',hdr.map((h,i)=>i+':'+h).join(' | '));
  const ix=n=>hdr.findIndex(h=>h===n);
  const iD=ix('Принят в обработку'),iS=ix('Статус'),iO=ix('Артикул'),iP=ix('Предельная цена'),iQ=ix('Количество'),iW=ix('Склад отгрузки');
  console.log('  нужные колонки найдены:',[iD,iS,iO,iP,iQ,iW].every(i=>i>=0)?'все':'НЕ ВСЕ ('+[iD,iS,iO,iP,iQ,iW].join(',')+')');
  if([iD,iS,iO,iP,iQ,iW].every(i=>i>=0)){
    const api={};
    rows.slice(1).forEach(r=>{ if(/отмен/i.test(r[iS]||''))return; const d=(r[iD]||'').trim().slice(0,10); if(!DAYS.includes(d))return;
      const o=(r[iO]||'').trim(),w=(r[iW]||'').trim(),q=Number(r[iQ]||0),p=Number(r[iP]||0); if(!o||!w||!isFinite(q))return;
      const a=api[d]||(api[d]={q:0,r:0,keys:new Set()}); a.q+=q;a.r+=q*p;a.keys.add(o+'|'+w);});
    const db=await sbAll(`product_sales?sale_date=gte.${DAYS[0]}&sale_date=lte.${DAYS[DAYS.length-1]}&select=sale_date,offer_id,warehouse_name,qty,revenue&order=sale_date,offer_id,warehouse_name`);
    const dbDay={};db.forEach(x=>{const d=dbDay[x.sale_date]||(dbDay[x.sale_date]={q:0,r:0,keys:new Set()});d.q+=Number(x.qty||0);d.r+=Number(x.revenue||0);d.keys.add(x.offer_id+'|'+x.warehouse_name);});
    DAYS.forEach(d=>{const a=api[d],b=dbDay[d]; if(!a||!b){console.log(`  ${d}: ${!b?'в базе нет данных':'в отчёте нет строк'}`);return;}
      const miss=[...b.keys].filter(k=>!a.keys.has(k)).length, extra=[...a.keys].filter(k=>!b.keys.has(k)).length;
      console.log(`  ${d}: штуки ${pct(a.q,b.q)}, выручка ${pct(a.r,b.r)}; пары артикул+склад: нет в отчёте ${miss}, лишние ${extra} (из ${b.keys.size})`);});
  }
}

// ===== 2. Начисления: полное устройство и раскладка итога =====
console.log('\n===== 2. НАЧИСЛЕНИЯ =====');
const ty=await ozon('/v1/finance/accrual/types',{});
const TYPES=new Map((ty.json?.accrual_types||[]).map(x=>[String(x.id),x.name]));
const DESC=new Map((ty.json?.accrual_types||[]).map(x=>[String(x.id),x.description]));
const num=v=>Number(v?.amount??v??0);
for(const d of DAYS){
  let acc=[],last_id='',pages=0,err=null;
  do{const r=await ozon('/v1/finance/accrual/by-day',last_id?{date:d,last_id}:{date:d});
    if(r.status!==200){err='HTTP '+msg(r);break;}
    acc=acc.concat(r.json.accruals||[]); last_id=r.json.last_id||''; pages++;}while(last_id&&pages<500);
  console.log(`\n${d}: начислений ${acc.length}${err?' — '+err:''}`); if(err)continue;
  if(d===DAYS[0]){
    printShape('Полное устройство начисления (по всем за день):',shape(acc));
    const dates={};acc.forEach(a=>{const k=String(a.date).length>10?'дата со временем':String(a.date)===d?'= запрошенному дню':'другой день';dates[k]=(dates[k]||0)+1;});
    console.log('Поле date:',JSON.stringify(dates));
    const used=new Set();const walkT=o=>{if(Array.isArray(o))return o.forEach(walkT);if(!o||typeof o!=='object')return;if(o.type_id!=null)used.add(String(o.type_id));Object.values(o).forEach(walkT);};acc.forEach(walkT);
    console.log('Встретившиеся типы (id — код — описание):');[...used].sort((a,b)=>a-b).forEach(id=>console.log(`  ${id} — ${TYPES.get(id)} — ${DESC.get(id)||''}`));
  }
  const db=await sbAll(`ozon_charges?charge_date=eq.${d}&select=group_name,charge_type,amount,event_date&order=row_key`);
  const dbSum=db.reduce((s,x)=>s+Number(x.amount||0),0), dbAbs=db.reduce((s,x)=>s+Math.abs(Number(x.amount||0)),0);
  const apiSum=acc.reduce((s,a)=>s+num(a.total_amount),0);
  console.log(`  итог дня: API ${pct(apiSum,dbSum)} к базе`);
  const cat={};acc.forEach(a=>{const c=a.accrued_category;cat[c]=(cat[c]||0)+num(a.total_amount);});
  console.log('  API по категориям (доля от |итого базы|):',Object.entries(cat).map(([k,v])=>k+' '+share(v,dbAbs)).join(', '));
  const grp={};db.forEach(x=>{const k=x.group_name+' / '+x.charge_type;grp[k]=(grp[k]||0)+Number(x.amount||0);});
  console.log('  база по «группа / тип» (доля от |итого базы|):');Object.entries(grp).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).forEach(([k,v])=>console.log(`    ${k}: ${share(v,dbAbs)}`));
  // все суммы API по коду типа и по «прочим» денежным полям (commission, seller_price, …) — доля от |итого базы|
  const sums={};
  const walk=(o,p)=>{if(Array.isArray(o))return o.forEach(x=>walk(x,p+'[]'));if(!o||typeof o!=='object')return;
    if(o.type_id!=null&&o.accrued){const k='тип '+TYPES.get(String(o.type_id));sums[k]=(sums[k]||0)+num(o.accrued);return;}
    for(const [k,v] of Object.entries(o)){const pp=p?p+'.'+k:k;
      if(v&&typeof v==='object'&&!Array.isArray(v)&&'amount' in v&&'currency' in v){if(!/total_amount$|total_accrued$/.test(pp))sums['поле '+pp.replace(/\[\]/g,'')]=(sums['поле '+pp.replace(/\[\]/g,'')]||0)+num(v);}
      else walk(v,pp);}};
  acc.forEach(a=>walk(a,''));
  console.log('  API: суммы по типам и денежным полям (доля от |итого базы|):');Object.entries(sums).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).forEach(([k,v])=>console.log(`    ${k}: ${share(v,dbAbs)}`));
  // события базы: на какие дни заказов приходятся начисления дня (event_date) — сравнение «дата начисления» vs «дата события»
  const ev={};db.forEach(x=>{const k=!x.event_date?'нет':x.event_date===d?'тот же день':x.event_date<d?'раньше':'позже';ev[k]=(ev[k]||0)+1;});
  console.log('  база: event_date относительно дня начисления:',JSON.stringify(ev));
}
console.log('\nГотово. В базу ничего не записано.');
