// Пробная сверка API Ozon с данными из CSV в базе (этап 3, «загрузка через API вместо CSV»). ТОЛЬКО ЧТЕНИЕ: в базу ничего не пишет.
// Репозиторий публичный — в лог идут только устройство ответов (поля и типы, без значений), названия типов начислений
// и расхождения в процентах; рублей, штук и артикулов в логе нет.
// Запуск: workflow ozon-api-probe (вручную), вход DAYS — дни через запятую (по умолчанию 3 дня, начиная с позавчера).
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
async function sbAll(path){ // постранично, с сортировкой (PostgREST отдаёт не больше 1000 строк)
  let out=[],off=0;
  for(;;){const r=await fetch(`${SB}/rest/v1/${path}&limit=1000&offset=${off}`,{headers:SR}); if(!r.ok)throw new Error('Supabase HTTP '+r.status+' '+path.split('?')[0]);
    const j=await r.json(); out=out.concat(j); if(j.length<1000)break; off+=1000;}
  return out;
}
// устройство объекта: путь → тип (массивы — по первому элементу), значения не печатаются
function shape(o,p='',acc=new Map()){
  if(Array.isArray(o)){acc.set(p+'[]',`array(${o.length})`); if(o.length)shape(o[0],p+'[]',acc);}
  else if(o&&typeof o==='object'){for(const k of Object.keys(o))shape(o[k],p?p+'.'+k:k,acc);}
  else acc.set(p,o===null?'null':typeof o);
  return acc;
}
const pct=(a,b)=>b===0?(a===0?'0%':'∞'):((a-b)/Math.abs(b)*100).toFixed(2)+'%';
const mskDay=iso=>{const d=new Date(new Date(iso).getTime()+3*3600e3);return d.toISOString().slice(0,10);};
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const today=mskDay(new Date().toISOString());
const DAYS=(process.env.DAYS||'').split(',').map(s=>s.trim()).filter(Boolean);
if(!DAYS.length)for(let i=4;i>=2;i--)DAYS.push(addDays(today,-i));
console.log('Дни сверки:',DAYS.join(', '));

// ===== 1. Заказы: /v2/posting/fbo/list против product_sales (импорт CSV «Заказы») =====
console.log('\n===== 1. ЗАКАЗЫ (FBO) =====');
const since=addDays(DAYS[0],-1)+'T21:00:00Z', to=DAYS[DAYS.length-1]+'T21:00:00Z'; // границы суток по Москве
let posts=[],off=0,first=null;
for(;;){
  const r=await ozon('/v2/posting/fbo/list',{dir:'ASC',filter:{since,to,status:''},limit:1000,offset:off,translit:false,with:{analytics_data:true,financial_data:true}});
  if(r.status!==200){console.log('fbo/list HTTP',r.status,r.json?.message||r.text||'');break;}
  const res=Array.isArray(r.json?.result)?r.json.result:(r.json?.result?.postings||[]);
  if(!first&&res.length){first=res[0];console.log('Устройство отправления:');shape(first).forEach((t,k)=>console.log('  '+k+': '+t));}
  posts=posts.concat(res); if(res.length<1000)break; off+=1000;
}
const fbs=await ozon('/v3/posting/fbs/list',{dir:'ASC',filter:{since,to,status:''},limit:1,offset:0});
console.log('FBS за период (есть ли вообще):',fbs.status===200?(fbs.json?.result?.postings?.length?'есть':'нет'):'HTTP '+fbs.status);
if(posts.length){
  const statuses={};posts.forEach(p=>statuses[p.status]=(statuses[p.status]||0)+1);
  console.log('Статусы (доля):',Object.entries(statuses).map(([k,v])=>k+' '+(v/posts.length*100).toFixed(1)+'%').join(', '));
  const db=await sbAll(`product_sales?sale_date=gte.${DAYS[0]}&sale_date=lte.${DAYS[DAYS.length-1]}&select=sale_date,offer_id,warehouse_name,qty,revenue&order=sale_date,offer_id,warehouse_name`);
  const dbDay={};db.forEach(x=>{const d=dbDay[x.sale_date]||(dbDay[x.sale_date]={q:0,r:0,keys:new Set()});d.q+=Number(x.qty||0);d.r+=Number(x.revenue||0);d.keys.add(x.offer_id+'|'+x.warehouse_name);});
  // цены-кандидаты: products[].price и financial_data.products[] (price, old_price, payout …) — по позиции товара
  const cand={'products.price':(p,i)=>Number(p.products[i]?.price)};
  const fp=first?.financial_data?.products?.[0]||{};
  Object.keys(fp).filter(k=>typeof fp[k]==='number'||(typeof fp[k]==='string'&&/^-?\d+(\.\d+)?$/.test(fp[k]))).forEach(k=>{cand['financial_data.products.'+k]=(p,i)=>Number(p.financial_data?.products?.[i]?.[k]);});
  for(const dateField of ['in_process_at','created_at']){
    console.log(`\nДата заказа = ${dateField} (по Москве), без отменённых:`);
    const api={};
    posts.forEach(p=>{
      if(/cancel/i.test(p.status||''))return;
      const d=p[dateField]?mskDay(p[dateField]):null; if(!d||!DAYS.includes(d))return;
      const a=api[d]||(api[d]={q:0,r:{},keys:new Set()});
      (p.products||[]).forEach((pr,i)=>{const q=Number(pr.quantity||0);a.q+=q;a.keys.add(pr.offer_id+'|'+(p.analytics_data?.warehouse_name||''));
        for(const c in cand){const v=cand[c](p,i);if(Number.isFinite(v))a.r[c]=(a.r[c]||0)+q*v;}});
    });
    DAYS.forEach(d=>{const a=api[d],b=dbDay[d];
      if(!b){console.log(`  ${d}: в базе нет данных из CSV`);return;}
      if(!a){console.log(`  ${d}: в API нет отправлений`);return;}
      const kb=[...b.keys],ka=a.keys; const miss=kb.filter(k=>!ka.has(k)).length, extra=[...ka].filter(k=>!b.keys.has(k)).length;
      console.log(`  ${d}: штуки ${pct(a.q,b.q)}; пары артикул+склад: нет в API ${miss}, лишние в API ${extra} (из ${kb.length})`);
      Object.keys(a.r).forEach(c=>console.log(`      выручка по ${c}: ${pct(a.r[c],b.r)}`));
    });
  }
}

// ===== 2. Начисления: /v1/finance/accrual/* против ozon_charges (импорт отчёта «Начисления») =====
console.log('\n===== 2. НАЧИСЛЕНИЯ =====');
const ty=await ozon('/v1/finance/accrual/types',{});
console.log('accrual/types HTTP',ty.status,ty.json?.message||ty.text||'');
const TYPES=new Map();
if(ty.json){
  console.log('Устройство справочника:');shape(ty.json).forEach((t,k)=>console.log('  '+k+': '+t));
  const list=ty.json.types||ty.json.result?.types||ty.json.result||ty.json.accrual_types||[];
  (Array.isArray(list)?list:[]).forEach(x=>{const id=x.type_id??x.id;const name=x.name??x.title??x.type_name;const grp=x.group_name??x.group??x.category??'';TYPES.set(String(id),{name,grp});});
  console.log('Типы начислений (id — группа / название):');TYPES.forEach((v,k)=>console.log(`  ${k} — ${v.grp} / ${v.name}`));
}
const old=await ozon('/v3/finance/transaction/list',{filter:{date:{from:DAYS[0]+'T00:00:00.000Z',to:DAYS[0]+'T23:59:59.000Z'},operation_type:[],posting_number:'',transaction_type:'all'},page:1,page_size:1});
console.log('Старый /v3/finance/transaction/list: HTTP',old.status,old.status===200?'(ещё работает)':(old.json?.message||old.text||''));
for(const d of DAYS){
  let acc=[],last_id='',pages=0,firstShape=null,err=null;
  do{
    const r=await ozon('/v1/finance/accrual/by-day',last_id?{date:d,last_id}:{date:d});
    if(r.status!==200){err='HTTP '+r.status+' '+(r.json?.message||r.text||'');break;}
    const j=r.json; if(!firstShape){firstShape=j;}
    const items=j.accruals||j.result?.accruals||[]; acc=acc.concat(items); last_id=j.last_id||j.result?.last_id||''; pages++;
  }while(last_id&&pages<500);
  console.log(`\n${d}: accrual/by-day — ${err||('страниц '+pages+', начислений '+acc.length)}`);
  if(err)continue;
  if(d===DAYS[0]){
    console.log('Устройство ответа (первая страница):');shape({...firstShape,accruals:undefined}).forEach((t,k)=>console.log('  '+k+': '+t));
    const byCat={};acc.forEach(a=>{const c=a.accrued_category||'?';if(!byCat[c])byCat[c]=a;});
    for(const c in byCat){console.log(`Устройство начисления категории ${c}:`);shape(byCat[c]).forEach((t,k)=>console.log('  '+k+': '+t));}
  }
  // база: ozon_charges за день — суммы по «группа / тип»
  const db=await sbAll(`ozon_charges?charge_date=eq.${d}&select=group_name,charge_type,amount&order=row_key`);
  const dbT={};let dbSum=0;db.forEach(x=>{const k=x.group_name+' / '+x.charge_type;dbT[k]=(dbT[k]||0)+Number(x.amount||0);dbSum+=Number(x.amount||0);});
  const apiSum=acc.reduce((s,a)=>s+Number(a.total_amount?.amount??a.total_amount??a.amount??0),0);
  console.log(`  итого за день (total_amount): ${pct(apiSum,dbSum)} к базе (строк в базе ${db.length})`);
  // суммы по type_id во всех вложенных объектах с type_id и суммой — для сопоставления с «группа / тип» базы
  const apiT={};
  const walk=(o)=>{if(Array.isArray(o)){o.forEach(walk);return;}if(!o||typeof o!=='object')return;
    if(o.type_id!=null){const v=Number(o.accrued?.amount??o.accrued??o.amount?.amount??o.amount??NaN);if(Number.isFinite(v)){const t=TYPES.get(String(o.type_id));const k=t?`${t.grp} / ${t.name}`:'type_id '+o.type_id;apiT[k]=(apiT[k]||0)+v;}}
    for(const k of Object.keys(o))if(k!=='accrued')walk(o[k]);};
  acc.forEach(walk);
  const keys=[...new Set([...Object.keys(dbT),...Object.keys(apiT)])].sort();
  console.log('  по типам (API к базе):');
  keys.forEach(k=>console.log(`    ${k}: ${k in apiT?(k in dbT?pct(apiT[k],dbT[k]):'только в API'):'нет в API'}`));
}
console.log('\nГотово. В базу ничего не записано.');
