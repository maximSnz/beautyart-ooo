// Разовая выгрузка: среднесуточные заказы FBO по кластерам за период (для дат, которых нет в базе).
// Только чтение Ozon API. Таблица (CSV) уходит файлом в Telegram администратору; в публичный лог — без цифр продаж.
// Заказы — как ночная загрузка: /v3/posting/fbo/list, день по UTC от in_process_at, без отменённых.
// Кластер — склада отгрузки (analytics_data → product_stocks базы, иначе /v1/cluster/list); база только читается. Среднее = шт за период ÷ календарные дни.
const OZON='https://api-seller.ozon.ru';
const H={'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json'};
const ENT=process.env.ENTITY||'ООО';
const FROM=(process.env.FROM||'').trim(), TO=(process.env.TO||'').trim();
const OFFERS=(process.env.OFFERS||'').split(/[\s,;]+/).map(s=>s.trim().toUpperCase()).filter(Boolean);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
if(!/^\d{4}-\d{2}-\d{2}$/.test(FROM)||!/^\d{4}-\d{2}-\d{2}$/.test(TO)||FROM>TO)throw new Error('FROM/TO — даты ГГГГ-ММ-ДД, FROM ≤ TO');
if(!OFFERS.length)throw new Error('OFFERS — артикулы через запятую');

async function ozon(path,body){
  for(let a=0;a<5;a++){
    let r,t;
    try{r=await fetch(OZON+path,{method:'POST',headers:H,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});t=await r.text();}
    catch(e){await sleep(1500*(a+1));continue;}
    let j=null; try{j=JSON.parse(t);}catch(e){}
    if(r.status===429||r.status>=500){await sleep(1500*(a+1));continue;}
    if(r.status!==200)throw new Error(`Ozon ${path}: HTTP ${r.status} ${j?.message||t.slice(0,150)}`);
    return j;
  }
  throw new Error(`Ozon ${path}: нет ответа`);
}
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const DAYS=[];for(let d=FROM;d<=TO;d=addDays(d,1))DAYS.push(d);

// Склады → кластеры: сначала product_stocks базы (как в заявке; /v1/cluster/list не узнаёт крупные РФЦ по ID заказов —
// июль 2026: 36 складов), затем /v1/cluster/list. Названия сравниваются без различия «-», « » и «_».
const normWh=s=>String(s||'').trim().toUpperCase().replace(/[\s-]+/g,'_');
const SB_ID={}, SB_NAME={}, WH_ID={}, WH_NAME={};
const SH={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY};
for(let off=0;;off+=1000){ // постранично, сортировка по полному ключу
  const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?select=warehouse_id,warehouse_name,cluster&order=product_id,warehouse_id&limit=1000&offset=${off}`,{headers:SH,signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('product_stocks: HTTP '+r.status);
  const j=await r.json(); j.forEach(x=>{if(!x.cluster)return;SB_ID[String(x.warehouse_id)]=x.cluster;SB_NAME[normWh(x.warehouse_name)]=x.cluster;});
  if(j.length<1000)break;
}
for(const cluster_type of ['CLUSTER_TYPE_OZON','CLUSTER_TYPE_CIS']){
  const r=await ozon('/v1/cluster/list',{cluster_type,cluster_ids:[]});
  (r.clusters||[]).forEach(c=>(c.logistic_clusters||[]).forEach(l=>(l.warehouses||[]).forEach(w=>{WH_ID[String(w.warehouse_id)]=c.name;WH_NAME[normWh(w.name)]=c.name;})));
}
if(!Object.keys(SB_NAME).length&&!Object.keys(WH_ID).length)throw new Error('нет справочника складов');
console.log('складов: в базе',Object.keys(SB_NAME).length,'| в cluster/list',Object.keys(WH_ID).length);
const clusterOf=(id,name)=>SB_ID[id]||SB_NAME[normWh(name)]||WH_ID[id]||WH_NAME[normWh(name)];

// Заказы по дням (окно since/to — сутки с запасом, день заказа отбирается по UTC, как в ozon_daily_load)
const QTY=new Map(), seenPost=new Set(); let unknownWh=new Set();
for(const D of DAYS){
  let cursor='';
  for(let pg=0;pg<3000;pg++){
    const j=await ozon('/v3/posting/fbo/list',{dir:'ASC',filter:{since:addDays(D,-1)+'T00:00:00.000Z',to:D+'T23:59:59.999Z'},limit:100,cursor,with:{analytics_data:true,financial_data:false}});
    (j.postings||[]).forEach(p=>{
      const t=p.in_process_at||p.created_at; if(!t||String(t).slice(0,10)!==D)return;
      if(/cancel/i.test(p.status||'')||seenPost.has(p.posting_number))return; seenPost.add(p.posting_number);
      const a=p.analytics_data||{}, wn=(a.warehouse_name||'').trim();
      let cl=clusterOf(String(a.warehouse_id||''),wn);
      if(!cl){cl='Не найден кластер: '+(wn||a.warehouse_id||'?');unknownWh.add(wn||String(a.warehouse_id||'?'));}
      (p.products||[]).forEach(pr=>{const o=(pr.offer_id||'').trim().toUpperCase(),q=Number(pr.quantity||0);
        if(!OFFERS.includes(o)||!Number.isFinite(q))return; const k=o+'|'+cl; QTY.set(k,(QTY.get(k)||0)+q);});
    });
    cursor=j.cursor||''; if(!j.has_next||!cursor)break;
  }
}
console.log('дней обработано:',DAYS.length,'| складов без кластера:',unknownWh.size);

// Таблица: строки — артикулы, столбцы — кластеры (по убыванию спроса), итоги
const N=DAYS.length, clT=new Map(), offT=new Map();
for(const [k,q] of QTY){const [o,c]=k.split('|');clT.set(c,(clT.get(c)||0)+q);offT.set(o,(offT.get(o)||0)+q);}
const CL=[...clT.keys()].sort((a,b)=>clT.get(b)-clT.get(a)||a.localeCompare(b,'ru'));
const missing=OFFERS.filter(o=>!offT.get(o));
console.log('артикулов с заказами:',OFFERS.length-missing.length,'из',OFFERS.length,missing.length?'| без заказов: '+missing.join(', '):'');
const fmt=(v,dp)=>v?v.toFixed(dp).replace('.',','):'';
const esc=s=>/[;"\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
function block(title,val,dp){
  const rows=[[title],['Артикул',...CL,'Итого']];
  OFFERS.forEach(o=>rows.push([o,...CL.map(c=>fmt(val(QTY.get(o+'|'+c)||0),dp)),fmt(val(offT.get(o)||0),dp)]));
  rows.push(['Итого',...CL.map(c=>fmt(val(clT.get(c)||0),dp)),fmt(val([...clT.values()].reduce((s,x)=>s+x,0)),dp)]);
  return rows;
}
const dm=d=>d.slice(8,10)+'.'+d.slice(5,7)+'.'+d.slice(0,4);
const head=[[`${ENT} · заказы FBO ${dm(FROM)}–${dm(TO)} (${N} дн.), без отменённых; кластер склада отгрузки; день заказа по UTC`]];
const rows=[...head,[],...block('Среднесуточные заказы, шт/день (шт за период ÷ '+N+' дн.)',q=>q/N,2),[],...block('Заказов за период, шт',q=>q,0)];
if(unknownWh.size)rows.push([],['Склады без кластера (нет ни в product_stocks, ни в справочнике Ozon): '+[...unknownWh].join(', ')]);
const csv='﻿'+rows.map(r=>r.map(x=>esc(String(x))).join(';')).join('\r\n');

// Отправка файлом в Telegram
const fd=new FormData();
fd.append('chat_id',process.env.TELEGRAM_CHAT_ID);
fd.append('caption',`${ENT}: среднесуточные заказы по кластерам, ${dm(FROM)}–${dm(TO)}, ${OFFERS.length} арт.`);
fd.append('document',new Blob([csv],{type:'text/csv'}),`cluster_ads_${ENT==='ООО'?'ooo':'ip'}_${FROM}_${TO}.csv`);
if(process.env.DRY_FILE){(await import('fs')).writeFileSync(process.env.DRY_FILE,csv);console.log('файл записан локально:',process.env.DRY_FILE);}
else{
  const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`,{method:'POST',body:fd});
  console.log('Telegram:',r.ok?'отправлено':'ошибка HTTP '+r.status);
  if(!r.ok)process.exitCode=1;
}
