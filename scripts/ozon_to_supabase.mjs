const OZON='https://api-seller.ozon.ru';
const H={ 'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json' };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ozon(path,body){
  for(let attempt=1;attempt<=6;attempt++){
    const r=await fetch(OZON+path,{method:'POST',headers:H,body:JSON.stringify(body)});
    if(r.status===429){ await sleep(1000*attempt); continue; }
    if(!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
    return r.json();
  }
  throw new Error(`${path} -> 429 after retries`);
}
const asArr=r=>Array.isArray(r?.result)?r.result:(r?.result?.items||[]);

// === 0) Склады → кластеры из Ozon (/v1/cluster/list), вместо ручного справочника ===
const WH={}, OZON_CLUSTERS=new Set();
for(const cluster_type of ['CLUSTER_TYPE_OZON','CLUSTER_TYPE_CIS']){
  const r=await ozon('/v1/cluster/list',{cluster_type,cluster_ids:[]});
  (r.clusters||[]).forEach(c=>{ OZON_CLUSTERS.add(c.name); (c.logistic_clusters||[]).forEach(l=>(l.warehouses||[]).forEach(w=>{ WH[String(w.warehouse_id)]=[c.name,w.name]; })); });
}
console.log('ozon clusters:',OZON_CLUSTERS.size,'| warehouses:',Object.keys(WH).length);
if(!OZON_CLUSTERS.size) throw new Error('cluster/list пуст — прерываю, чтобы не затереть кластеры');

// === 1) Все товары ===
let items=[],last_id='';
do{ const r=await ozon('/v3/product/list',{filter:{},limit:1000,last_id}); items=items.concat(r.result?.items||[]); last_id=r.result?.last_id||''; }while(last_id);
console.log('total products:',items.length);

// === 2) Атрибуты (название, offer_id, видимость) ===
const attrs={};
async function tryBatch(paths,chunk,fill){
  for(const path of paths){
    try{ const r=await ozon(path,{filter:{product_id:chunk,offer_id:[],visibility:'ALL'},last_id:'',limit:1000}); const arr=asArr(r); if(arr.length){arr.forEach(fill);return path;} }catch(e){}
  }
  return null;
}
for(let i=0;i<items.length;i+=100){
  const chunk=items.slice(i,i+100).map(x=>x.product_id);
  const used=await tryBatch(['/v4/product/info/attributes'],chunk,it=>{attrs[it.id??it.product_id]=it;});
  if(!used) console.log('WARN: attributes batch failed at', i);
  await sleep(300);
}

// === 3) Остатки FBO по складам (пагинация через cursor) ===
const offersAll=items.map(x=>x.offer_id).filter(Boolean);
const byProduct=new Map(); const unmapped={};
for(let i=0;i<offersAll.length;i+=20){
  const of=offersAll.slice(i,i+20);
  let cur='';
  do{
    const r=await ozon('/v1/product/info/stocks-by-warehouse/fbo',{offer_ids:of,cursor:cur,limit:1000});
    (r.products||[]).forEach(it=>{
      const pid=it.product_id; if(pid==null)return;
      const id=String(it.warehouse_id), m=WH[id];
      if(!m) unmapped[id]=(unmapped[id]||0)+(it.present||0);
      if(!byProduct.has(pid))byProduct.set(pid,new Map());
      const wm=byProduct.get(pid);
      const rec=wm.get(id)||{warehouse_id:id,warehouse_name:m?m[1]:('Склад '+id),cluster:m?m[0]:'Прочее',present:0};
      rec.present+=it.present||0;
      wm.set(id,rec);
    });
    cur=(r.has_next&&r.cursor)?r.cursor:'';
  }while(cur);
  await sleep(400);
}
if(Object.keys(unmapped).length)console.log('UNMAPPED WAREHOUSES:',Object.entries(unmapped).map(([id,t])=>`${id}:${t}`).join(', '));

// === 4) Запись products (без price — цена нигде не используется) ===
const rows=items.map(b=>{
  const a=attrs[b.product_id]||{};
  let sum=0; (byProduct.get(b.product_id)||new Map()).forEach(v=>sum+=v.present);
  return { product_id:b.product_id, offer_id:a.offer_id??b.offer_id??'', name:a.name??'', stock:sum, visibility:a.visibility??'', raw:a, updated_at:new Date().toISOString() };
});
if(rows.length){
  const up=await fetch(`${process.env.SUPABASE_URL}/rest/v1/products?on_conflict=product_id`,{
    method:'POST',
    headers:{ apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates' },
    body:JSON.stringify(rows)
  });
  if(!up.ok) throw new Error(`supabase products -> HTTP ${up.status}: ${await up.text()}`);
}

// === 5) Перезапись product_stocks ===
const SR={ apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
for(let i=0;i<items.length;i+=100){
  const pids=items.slice(i,i+100).map(x=>x.product_id).join(',');
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?product_id=in.(${pids})`,{method:'DELETE',headers:SR});
}
const stockRows=[];
byProduct.forEach((wm,pid)=>wm.forEach(v=>stockRows.push({product_id:pid,warehouse_id:v.warehouse_id,warehouse_name:v.warehouse_name,cluster:v.cluster,present:v.present,updated_at:new Date().toISOString()})));
for(let i=0;i<stockRows.length;i+=500){
  const part=stockRows.slice(i,i+500);
  const up=await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?on_conflict=product_id,warehouse_id`,{
    method:'POST',
    headers:{ ...SR, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates' },
    body:JSON.stringify(part)
  });
  if(!up.ok) throw new Error(`supabase stocks -> HTTP ${up.status}: ${await up.text()}`);
}

// === 6) Самопроверка ===
let vsum=0,vcount=0,voff=0;
while(true){
  const vr=await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?select=present&limit=1000&offset=${voff}`,{headers:SR});
  const j=await vr.json(); vcount+=j.length; vsum+=j.reduce((s,x)=>s+(x.present||0),0);
  if(j.length<1000)break; voff+=1000;
}
console.log('DB stocks rows:',vcount,'| DB sum present:',vsum);
console.log('synced products:',rows.length,'| stocks rows:',stockRows.length);

// === 7) Чистка остатков карточек, отсутствующих в выдаче Ozon ===
const itemPids=new Set(items.map(x=>x.product_id));
const stalePids=new Set();
let soff=0;
while(true){
  const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?select=product_id&limit=1000&offset=${soff}`,{headers:SR});
  const j=await r.json();
  j.forEach(x=>{ if(!itemPids.has(x.product_id)) stalePids.add(x.product_id); });
  if(j.length<1000)break; soff+=1000;
}
const stale=[...stalePids];
for(let i=0;i<stale.length;i+=100){
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?product_id=in.(${stale.slice(i,i+100).join(',')})`,{method:'DELETE',headers:SR});
}
console.log('stale stock products removed:', stale.length);

// === 8) Спрос и остатки по кластерам (/v1/analytics/stocks) → cluster_demand ===
// ads_cluster — среднесуточные продажи кластера за 28 дн (сверено с отчётом «Рекомендуемая поставка»);
// ads по складам не суммировать — это не спрос.
const skuPid=new Map();
for(let i=0;i<items.length;i+=100){
  const r=await ozon('/v3/product/info/list',{product_id:items.slice(i,i+100).map(x=>x.product_id)});
  (r.items||[]).forEach(it=>[it.sku,...(it.sources||[]).map(s=>s.sku)].forEach(s=>{ if(s) skuPid.set(s,it.id); }));
  await sleep(300);
}
const dem=new Map();
const skus=[...skuPid.keys()];
for(let i=0;i<skus.length;i+=100){
  const r=await ozon('/v1/analytics/stocks',{skus:skus.slice(i,i+100)});
  (r.items||[]).forEach(x=>{
    const pid=skuPid.get(x.sku); if(pid==null||!x.cluster_name) return;
    const k=pid+'|'+x.cluster_name;
    const d=dem.get(k)||{product_id:pid,cluster:x.cluster_name,ads_cluster:0,available:0,transit:0,requested:0,days_without_sales:null};
    d.ads_cluster=Math.max(d.ads_cluster,x.ads_cluster||0);
    d.available+=x.available_stock_count||0; d.transit+=x.transit_stock_count||0; d.requested+=x.requested_stock_count||0;
    if(x.days_without_sales_cluster!=null) d.days_without_sales=x.days_without_sales_cluster;
    dem.set(k,d);
  });
  await sleep(500);
}
const runAt=new Date().toISOString();
const demRows=[...dem.values()].map(d=>({...d,updated_at:runAt}));
if(!demRows.length) throw new Error('analytics/stocks пуст — cluster_demand не обновлён');
for(let i=0;i<demRows.length;i+=500){
  const up=await fetch(`${process.env.SUPABASE_URL}/rest/v1/cluster_demand?on_conflict=product_id,cluster`,{
    method:'POST', headers:{ ...SR, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates' },
    body:JSON.stringify(demRows.slice(i,i+500))
  });
  if(!up.ok) throw new Error(`supabase cluster_demand -> HTTP ${up.status}: ${await up.text()}`);
}
// пары, которых больше нет в выдаче Ozon
await fetch(`${process.env.SUPABASE_URL}/rest/v1/cluster_demand?updated_at=lt.${encodeURIComponent(runAt)}`,{method:'DELETE',headers:SR});
console.log('cluster_demand rows:',demRows.length,'| skus:',skus.length);

// === 9) Список кластеров Ozon: active в cluster_lead_times (сроки не трогаем) ===
const lt=await (await fetch(`${process.env.SUPABASE_URL}/rest/v1/cluster_lead_times?select=cluster,active`,{headers:SR})).json();
for(const c of lt){
  const act=OZON_CLUSTERS.has(c.cluster);
  if(act!==c.active) await fetch(`${process.env.SUPABASE_URL}/rest/v1/cluster_lead_times?cluster=eq.${encodeURIComponent(c.cluster)}`,{method:'PATCH',headers:{...SR,'Content-Type':'application/json'},body:JSON.stringify({active:act,updated_at:runAt})});
}
const known=new Set(lt.map(c=>c.cluster));
console.log('clusters inactive:',lt.filter(c=>!OZON_CLUSTERS.has(c.cluster)).map(c=>c.cluster).join(', ')||'—',
            '| new in Ozon (сроки не заданы):',[...OZON_CLUSTERS].filter(c=>!known.has(c)).join(', ')||'—');
