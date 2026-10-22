// Пробная сверка API Ozon с данными из CSV в базе (этап 3, «загрузка через API вместо CSV»). ТОЛЬКО ЧТЕНИЕ: в базу ничего не пишет.
// Репозиторий публичный — в лог идут только устройство ответов, счётчики и доли; рублей, штук, артикулов и номеров нет.
// Запуск: workflow ozon-api-probe (вручную), вход DAYS — дни через запятую (по умолчанию позавчера).
// Проход 6 (22.10.2026): откуда брать дату заказа (event_date) для начислений — unit_number, /v1/finance/accrual/postings,
// /v3/posting/fbo/get; сверка с event_date из CSV в ozon_charges. Итоги проходов 1–5 — в ROADMAP (этап 3).
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
async function sbAll(path){
  let out=[],off=0;
  for(;;){const r=await fetch(`${SB}/rest/v1/${path}&limit=1000&offset=${off}`,{headers:SR}); if(!r.ok)throw new Error('Supabase HTTP '+r.status+' '+path.split('?')[0]);
    const j=await r.json(); out=out.concat(j); if(j.length<1000)break; off+=1000;}
  return out;
}
function shape(o,p='',acc=new Map()){
  const add=(k,t)=>{const s=acc.get(k)||new Set();s.add(t);acc.set(k,s);};
  if(Array.isArray(o)){add(p+'[]','array'); o.forEach(x=>shape(x,p+'[]',acc));}
  else if(o&&typeof o==='object'){for(const k of Object.keys(o))shape(o[k],p?p+'.'+k:k,acc);}
  else add(p,o===null?'null':typeof o);
  return acc;
}
const printShape=(title,acc)=>{console.log(title);[...acc.keys()].sort().forEach(k=>console.log('  '+k+': '+[...acc.get(k)].join('|')));};
const mask=s=>String(s).replace(/[0-9]/g,'9').replace(/[A-Za-zА-Яа-я]/g,'A'); // формат без значений
const mskDay=iso=>{const d=new Date(new Date(iso).getTime()+3*3600e3);return d.toISOString().slice(0,10);};
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const today=mskDay(new Date().toISOString());
const DAYS=(process.env.DAYS||'').split(',').map(s=>s.trim()).filter(Boolean);
if(!DAYS.length)DAYS.push(addDays(today,-2));
const d=DAYS[0]; console.log('День:',d);

let acc=[],last_id='',pg=0;
do{const r=await ozon('/v1/finance/accrual/by-day',last_id?{date:d,last_id}:{date:d}); if(r.status!==200){console.log('by-day HTTP',msg(r));break;}
  acc=acc.concat(r.json.accruals||[]); last_id=r.json.last_id||''; pg++;}while(last_id&&pg<500);
console.log('начислений',acc.length);
const fm={};acc.forEach(a=>{const k=a.accrued_category+' '+mask(a.unit_number);fm[k]=(fm[k]||0)+1;});
console.log('Формат unit_number по категориям:');Object.entries(fm).sort((x,y)=>y[1]-x[1]).slice(0,15).forEach(([k,v])=>console.log('  '+k+': '+v));
const posts=[...new Set(acc.filter(a=>a.accrued_category==='POSTING').map(a=>a.unit_number))];
console.log('уникальных unit_number у POSTING:',posts.length);

// /v1/finance/accrual/postings — по номерам отправлений
const sample=posts.slice(0,50);
for(const body of [{posting_numbers:sample},{posting_number:sample},{posting_numbers:sample,page:1,page_size:50}]){
  const r=await ozon('/v1/finance/accrual/postings',body);
  console.log(`\n/v1/finance/accrual/postings ${Object.keys(body).join('+')}: HTTP ${msg(r)}`);
  if(r.status===200&&r.json){printShape('  устройство:',shape(r.json));break;}
}
// /v3/posting/fbo/get — одно отправление
for(const path of ['/v3/posting/fbo/get','/v2/posting/fbo/get']){
  const r=await ozon(path,{posting_number:sample[0],with:{analytics_data:true,financial_data:false}});
  console.log(`\n${path}: HTTP ${msg(r)}`);
  if(r.status===200&&r.json){printShape('  устройство:',shape(r.json));
    // сверка с event_date из CSV: дата «принят в обработку» отправлений против event_date строк базы с тем же source_id-префиксом нельзя —
    // в базе нет номера отправления; сравниваем распределение «сколько дней от заказа до начисления»
    const N=Math.min(posts.length,200);const lag={};let got=0;
    for(let i=0;i<N;i++){const g=await ozon(path,{posting_number:posts[i]});const p=g.json?.result||g.json;const t=p?.in_process_at||p?.created_at;
      if(!t)continue;got++;const days=Math.round((new Date(d+'T12:00:00Z')-new Date(mskDay(t)+'T12:00:00Z'))/864e5);lag[days]=(lag[days]||0)+1;}
    console.log(`  API: дней от «принят в обработку» до начисления (${got} из ${N} отправлений):`,JSON.stringify(lag));
    break;
  }
}
const db=await sbAll(`ozon_charges?charge_date=eq.${d}&charge_type=eq.${encodeURIComponent('Выручка')}&select=event_date&order=row_key`);
const lagB={};db.forEach(x=>{if(!x.event_date)return;const days=Math.round((new Date(d+'T12:00:00Z')-new Date(x.event_date+'T12:00:00Z'))/864e5);lagB[days]=(lagB[days]||0)+1;});
console.log('  база (CSV, «Выручка»): дней от event_date до начисления:',JSON.stringify(lagB));
console.log('\nГотово. В базу ничего не записано.');
