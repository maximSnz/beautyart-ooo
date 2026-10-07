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

const WH={
 '1020000115166000':['Москва','ЖУКОВСКИЙ_РФЦ'],'23843917228000':['Москва','ПУШКИНО_1_РФЦ'],'15431806189000':['Москва','ХОРУГВИНО_РФЦ'],'23902289166000':['Москва','ПУШКИНО_2_РФЦ'],'1020001853819000':['Москва','ПЕТРОВСКОЕ_РФЦ'],'1020000759116000':['Москва','НОГИНСК_РФЦ'],'1020001853757000':['Москва','ДОМОДЕДОВО_РФЦ'],'1020000435290000':['Москва','ГРИВНО_РФЦ'],'1020000241710000':['Москва','СОФЬИНО_РФЦ'],
 '1020002006967000':['Ярославль','ЯРОСЛАВЛЬ_РФЦ'],
 '1020000267736000':['Краснодар','АДЫГЕЙСК_РФЦ'],'23601604393000':['Краснодар','НОВОРОССИЙСК_РФЦ'],'1020003111522000':['Краснодар','КРАСНОДАР_2_РФЦ'],
 '18044341087000':['Новосибирск','НОВОСИБИРСК_РФЦ_НОВЫЙ'],'1020005006583540':['Новосибирск','НОВОСИБИРСК_3_РФЦ'],'1020005006580020':['Новосибирск','КЕМЕРОВО_РФЦ'],
 '23599177351000':['Казань','НИЖНИЙ_НОВГОРОД_РФЦ'],'1020003105329000':['Казань','НИЖНИЙ_НОВГОРОД_2_РФЦ'],'18044494830000':['Казань','КАЗАНЬ_РФЦ_НОВЫЙ'],
 '1020002690706000':['Красноярск','КРАСНОЯРСК_СТАРЦЕВО_РФЦ'],'22296628035000':['Красноярск','КРАСНОЯРСК_МРФЦ'],
 '1020000310035000':['Саратов','ВОЛГОГРАД_РФЦ'],'1020001853897000':['Саратов','САРАТОВ_РФЦ'],
 '1020003110535000':['Ростов','РОСТОВ_НА_ДОНУ_2_РФЦ'],'17717042026000':['Ростов','РОСТОВ-НА-ДОНУ_РФЦ'],
 '23021125185000':['Тверь','ТВЕРЬ_РФЦ'],
 '1020000367015000':['Астана','АСТАНА_РФЦ'],
 '1020001351243000':['Невинномысск','НЕВИННОМЫССК_РФЦ'],
 '23402539267000':['Беларусь','МИНСК_МПСЦ'],
 '1020001835468000':['Омск','ОМСК_РФЦ'],
 '1020000890160000':['Дальний Восток','ХАБАРОВСК_2_РФЦ'],
 '22294782253000':['Калининград','КАЛИНИНГРАД_МРФЦ'],
 '1020001649180000':['Санкт-Петербург','СПБ_КОЛПИНО_РФЦ'],'1020002417800000':['Санкт-Петербург','СПБ_ПОРОШКИНО_РФЦ'],'18044249781000':['Санкт-Петербург','САНКТ-ПЕТЕРБУРГ_РФЦ'],'23903599483000':['Санкт-Петербург','СПБ_БУГРЫ_РФЦ'],'1020000613861000':['Санкт-Петербург','СПБ_ШУШАРЫ_РФЦ'],
 '23684735180000':['Воронеж','ВОРОНЕЖ_РФЦ'],'1020001007805000':['Воронеж','ВОРОНЕЖ_2_РФЦ'],
 '1020002007530000':['Тюмень','ТЮМЕНЬ_РФЦ'],
 '18044570445000':['Екатеринбург','ЕКАТЕРИНБУРГ_РФЦ_НОВЫЙ'],
 '23948599159000':['Пермь','ПЕРМЬ_РФЦ'],
 '1020001836298000':['Уфа','УФА_РФЦ'],
 '23128509046000':['Самара','САМАРА_РФЦ'],
 '1020001836200000':['Оренбург','ОРЕНБУРГ_РФЦ'],
 '1020000407473000':['Армения','ЕРЕВАН_МРФЦ'],
 '1020001854016000':['Алматы','АЛМАТЫ_2_РФЦ'],
};

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
