// Ночная загрузка из API Ozon вместо CSV (этап 3, решения 22.10.2026 — ROADMAP). Запускается после ozon-products-sync.
// Делает за вчерашний день (по Москве) то же, что кнопки CSV:
//   weekly.html «Заказы»: product_sales, снимок stock_history, deviation_history (computeDay), недельные факты qty/rev;
//   plan.html «Начисления»: ozon_charges и пересчёт CF (syncPnl → sales_plan_weeks, cf_daily);
//   plan.html «Аналитика продвижения»: расход рекламы по SKU → ozon_ad_spend (Ozon Performance API, с 30.10.2026).
//   plan.html fixHypotheses: фиксация факта SMART-гипотез после дедлайна (product_protocol) — с 22.10.2026 только здесь.
// Режимы: WRITE=1 — запись в базу; иначе ПРОВЕРКА: всё считается и сверяется с базой, в базу ничего не пишется.
// Репозиторий публичный — в лог только счётчики и расхождения в процентах; рублей, штук и артикулов в логе нет.
import fs from 'node:fs';
const M1=/^(CAP|INS|FW|MS|ML|SE)-/;       // matrixOf ООО (как в weekly.html / plan.html этого репозитория)
const OZON='https://api-seller.ozon.ru';
const H={'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json'};
const SB=process.env.SUPABASE_URL, SR={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
const WRITE=process.env.WRITE==='1';
const TAX_RATE=0.03, SMOOTH_DAYS=7, DOW_TARGET={0:7,1:13,2:12,3:11,4:10,5:9,6:8};
const matrixOf=o=>M1.test(o)?'m1':'m2';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const r2=x=>Math.round(x*100)/100;
const num=v=>Number(v?.amount??v??0);

// ===== даты: ISO-строки дней по Москве, арифметика через UTC (раннер — в UTC) =====
// день заказа для product_sales — по UTC, как в выгрузке «Заказы» кабинета и во всей истории из CSV (решение 26.10.2026: время там = UTC
// до секунды); дата заказа в начислениях (event_date, справочник ozon_postings) — по Москве, как в отчёте «Начисления» кабинета
const orderDay=iso=>new Date(iso).toISOString().slice(0,10);
const mskDay=iso=>new Date(new Date(iso).getTime()+3*3600e3).toISOString().slice(0,10);
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const dow=iso=>new Date(iso+'T00:00:00Z').getUTCDay();
const weekStartOf=iso=>addDays(iso,-((dow(iso)+6)%7));
const monthOfWeek=w=>addDays(w,3).slice(0,7);                      // месяц недели — по её четвергу
function isoWeeksOfMonth(ym){const [y,m]=ym.split('-').map(Number);const out=[];let w=weekStartOf(`${ym}-01`);
  for(let i=0;i<6;i++){if(monthOfWeek(w)===ym)out.push(w);w=addDays(w,7);}return out;}
const TODAY=mskDay(new Date().toISOString());
const T0=Date.now(), el=()=>`[${Math.round((Date.now()-T0)/1000)} с]`;
// итоги шагов для Telegram-сводки (scripts/admin_notify.mjs читает load_summary.txt; в публичный лог не печатается)
const SUM=[], note=t=>{SUM.push(t);try{fs.writeFileSync('load_summary.txt',SUM.join('\n')+'\n');}catch(e){}};
const nf=n=>Math.round(n).toLocaleString('ru-RU');
const D=process.env.DAY||addDays(TODAY,-1);
const SNAPSHOT=D===addDays(TODAY,-1);                                              // остатки «на сейчас» верны только для вчера
console.log(`Ночная загрузка: день ${D}, режим ${WRITE?'ЗАПИСЬ':'ПРОВЕРКА (в базу ничего не пишется)'}${SNAPSHOT?'':' — день не вчерашний: снимок остатков и отклонения пропускаются'}`);

// ===== Ozon и Supabase =====
async function ozon(path,body){
  for(let a=0;a<5;a++){
    let r,t;
    try{r=await fetch(OZON+path,{method:'POST',headers:H,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});t=await r.text();}
    catch(e){await sleep(1500*(a+1));continue;}                                     // таймаут 30 с или обрыв — повтор
    let j=null; try{j=JSON.parse(t);}catch(e){}
    if(r.status===429||r.status>=500){await sleep(1500*(a+1));continue;}
    if(r.status!==200)throw new Error(`Ozon ${path}: HTTP ${r.status} ${j?.message||t.slice(0,150)}`);
    return j;
  }
  throw new Error(`Ozon ${path}: нет ответа`);
}
async function sbAll(path){ // постранично, с сортировкой (PostgREST отдаёт не больше 1000 строк)
  let out=[],off=0;
  for(;;){let r=null;for(let a=0;a<4;a++){try{r=await fetch(`${SB}/rest/v1/${path}&limit=1000&offset=${off}`,{headers:SR,signal:AbortSignal.timeout(60000)});if(r.ok)break;}catch(e){r=null;}await sleep(700*(a+1));}
    if(!r||!r.ok)throw new Error('Supabase HTTP '+(r?r.status:'таймаут')+' '+path.split('?')[0]);
    const j=await r.json(); out=out.concat(j); if(j.length<1000)break; off+=1000;}
  return out;
}
const PLANNED=[];                                                   // что было бы записано в режиме проверки
async function sbPatch(path,obj){
  if(!WRITE){PLANNED.push(`PATCH ${path.split('?')[0]} — 1 строка`);return;}
  const r=await fetch(`${SB}/rest/v1/${path}`,{method:'PATCH',headers:{...SR,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(obj)});
  if(!r.ok)throw new Error(`Supabase PATCH ${path.split('?')[0]}: HTTP ${r.status} ${(await r.text()).slice(0,200)}`);
}
async function sbWrite(method,path,rows){
  if(!WRITE){PLANNED.push(`${method} ${path.split('?')[0]}${rows?` — строк ${rows.length}`:''}`);return;}
  const chunks=rows?Array.from({length:Math.ceil(rows.length/500)},(_,i)=>rows.slice(i*500,i*500+500)):[null];
  for(const part of chunks){
    const r=await fetch(`${SB}/rest/v1/${path}`,{method,headers:{...SR,'Content-Type':'application/json',Prefer:method==='POST'?'resolution=merge-duplicates,return=minimal':'return=minimal'},body:part?JSON.stringify(part):undefined});
    if(!r.ok)throw new Error(`Supabase ${method} ${path.split('?')[0]}: HTTP ${r.status} ${(await r.text()).slice(0,200)}`);
  }
}
const pct=(a,b)=>b===0?(a===0?'0%':'∞'):((a-b)/Math.abs(b)*100).toFixed(3)+'%';
// сравнение двух наборов «ключ → число»: совпало (до копейки) / другое / только в одном
function cmp(title,A,B,eps=0.011){let same=0,diff=0,onlyA=0,onlyB=0,sa=0,sb=0;
  new Set([...A.keys(),...B.keys()]).forEach(k=>{const a=A.get(k),b=B.get(k);sa+=a||0;sb+=b||0;
    if(a==null)onlyB++;else if(b==null)onlyA++;else if(Math.abs(a-b)>eps)diff++;else same++;});
  console.log(`  ${title}: итог ${pct(sa,sb)}; совпало ${same}, другое значение ${diff}, только в API ${onlyA}, только в базе ${onlyB}`);
  return {same,diff,onlyA,onlyB};}
const sumBy=(rows,key,val)=>{const m=new Map();rows.forEach(r=>{const k=key(r);m.set(k,(m.get(k)||0)+val(r));});return m;};

// ===== 0. Справочники из базы =====
const products=await sbAll('products?select=product_id,offer_id,archived,sku:raw->sku&order=product_id');
const active=products.filter(p=>!p.archived);
const OFFER_PID_ALL=new Map(products.map(p=>[p.offer_id,p.product_id]));         // weekly.html: все товары
const PID_OFFER=new Map(products.map(p=>[p.product_id,p.offer_id]));
const OFFER_PID=new Map(active.map(p=>[p.offer_id,p.product_id]));                // plan.html: только неархивные
const SKU_PID=new Map(active.filter(p=>p.sku!=null).map(p=>[String(p.sku),p.product_id]));
const SKU_OFFER=new Map(products.filter(p=>p.sku!=null).map(p=>[String(p.sku),p.offer_id]));
const prices=await sbAll('product_prices?select=product_id,cost,created_at&order=created_at.asc,product_id.asc');
const COST={},COST_HIST={};                                                       // COST — последняя цена (как loadCosts)
prices.forEach(p=>{COST[p.product_id]=Number(p.cost||0);(COST_HIST[p.product_id]=COST_HIST[p.product_id]||[]).push({t:String(p.created_at||'').slice(0,10),c:Number(p.cost||0)});});
function costAt(pid,dISO){const arr=COST_HIST[pid];if(!arr||!arr.length)return {cost:COST[pid]||0,prov:true};
  let best=null;for(const rec of arr){if(rec.t<=dISO)best=rec;else break;}return best?{cost:best.c,prov:false}:{cost:arr[0].c,prov:true};}
const stocks=await sbAll('product_stocks?select=product_id,warehouse_id,warehouse_name,cluster,present&order=product_id,warehouse_id');

// ===== 1. Заказы за D: /v3/posting/fbo/list → product_sales (снимок: без уже отменённых) =====
console.log('\n1. Заказы',el());
let posts=[],cursor='';
for(let pg=0;pg<3000;pg++){
  const j=await ozon('/v3/posting/fbo/list',{dir:'ASC',filter:{since:addDays(D,-1)+'T00:00:00.000Z',to:D+'T23:59:59.999Z'},limit:100,cursor,with:{analytics_data:true,financial_data:false}});
  posts=posts.concat(j.postings||[]); cursor=j.cursor||''; if(!j.has_next||!cursor)break;
}
const POSTING_DAY=new Map(), ORDER_DAY=new Map();                                 // для event_date начислений
posts.forEach(p=>{const t=p.in_process_at||p.created_at;if(!t)return;const d=mskDay(t);POSTING_DAY.set(p.posting_number,d);if(p.order_number)ORDER_DAY.set(p.order_number,d);});
const salesAgg=new Map();
posts.forEach(p=>{ if(/cancel/i.test(p.status||''))return; if(orderDay(p.in_process_at||p.created_at)!==D)return;
  const wh=(p.analytics_data?.warehouse_name||'').trim();
  (p.products||[]).forEach(pr=>{const o=(pr.offer_id||'').trim(),q=Number(pr.quantity||0);if(!o||!wh||!Number.isFinite(q))return;
    const k=o+'|'+wh,c=salesAgg.get(k)||{q:0,r:0};c.q+=q;c.r+=q*num(pr.price);salesAgg.set(k,c);});});
const salesRows=[...salesAgg].map(([k,v])=>{const [offer_id,warehouse_name]=k.split('|');return {sale_date:D,offer_id,warehouse_name,qty:v.q,revenue:r2(v.r)};});
console.log(`  отправлений в окне ${posts.length}, строк артикул+склад за день ${salesRows.length}`);
note(`Заказы: ${nf(salesRows.reduce((a,r)=>a+r.qty,0))} шт, выручка ${nf(salesRows.reduce((a,r)=>a+r.revenue,0))} ₽ (${salesRows.length} строк артикул+склад)`);
const dbSales=await sbAll(`product_sales?sale_date=eq.${D}&select=offer_id,warehouse_name,qty,revenue&order=offer_id,warehouse_name`);
if(dbSales.length){cmp('штуки (сверка с CSV)',sumBy(salesRows,r=>r.offer_id+'|'+r.warehouse_name,r=>r.qty),sumBy(dbSales,r=>r.offer_id+'|'+r.warehouse_name,r=>Number(r.qty)));
  cmp('выручка (сверка с CSV)',sumBy(salesRows,r=>r.offer_id+'|'+r.warehouse_name,r=>r.revenue),sumBy(dbSales,r=>r.offer_id+'|'+r.warehouse_name,r=>Number(r.revenue)));}
else console.log('  в базе за день данных нет — сверять не с чем');
if(salesRows.length){await sbWrite('DELETE',`product_sales?sale_date=eq.${D}`);await sbWrite('POST','product_sales?on_conflict=sale_date,offer_id,warehouse_name',salesRows);}

// ===== 2. Снимок остатков → stock_history (как saveStockDay в weekly.html) =====
console.log('\n2. Снимок остатков',el());
const STOCK_NOW={},WHCLUSTER={};
stocks.forEach(s=>{const o=PID_OFFER.get(s.product_id);if(!o)return;(STOCK_NOW[o]=STOCK_NOW[o]||{});STOCK_NOW[o][s.warehouse_name]=(STOCK_NOW[o][s.warehouse_name]||0)+(s.present||0);
  if(!WHCLUSTER[s.warehouse_name])WHCLUSTER[s.warehouse_name]=s.cluster||'Прочее';});
const stockRows=[];
for(const o in STOCK_NOW)for(const wh in STOCK_NOW[o]){const v=STOCK_NOW[o][wh];if(v!=null)stockRows.push({report_date:D,offer_id:o,warehouse_name:wh,stock:v});}
const seen=new Set(Object.keys(STOCK_NOW));
active.forEach(p=>{if(!seen.has(p.offer_id))stockRows.push({report_date:D,offer_id:p.offer_id,warehouse_name:'НЕТ_В_ОТЧЁТЕ',stock:0});});
const dbStock=await sbAll(`stock_history?report_date=eq.${D}&select=offer_id,warehouse_name,stock&order=offer_id,warehouse_name`);
if(dbStock.length)cmp('остатки (сверка со снимком CSV-дня; он снят позже — утром)',sumBy(stockRows,r=>r.offer_id+'|'+r.warehouse_name,r=>r.stock),sumBy(dbStock,r=>r.offer_id+'|'+r.warehouse_name,r=>Number(r.stock)),0.5);
else console.log('  снимка за день в базе нет');
note(SNAPSHOT?`Остатки: снимок ${stockRows.length} строк, ${nf(stockRows.reduce((a,r)=>a+Number(r.stock||0),0))} шт`:'Остатки и отклонения: пропущены (день не вчерашний)');
if(SNAPSHOT){await sbWrite('DELETE',`stock_history?report_date=eq.${D}`);await sbWrite('POST','stock_history?on_conflict=report_date,offer_id,warehouse_name',stockRows);}

// ===== 3. Отклонения остатков → deviation_history (computeDay из weekly.html, 1:1) =====
console.log('\n3. Отклонения остатков',el());
const SALES={};salesRows.forEach(x=>{((SALES[x.offer_id]=SALES[x.offer_id]||{})[x.warehouse_name]=SALES[x.offer_id][x.warehouse_name]||{});SALES[x.offer_id][x.warehouse_name][D]=(SALES[x.offer_id][x.warehouse_name][D]||0)+x.qty;});
const COST_LAST={};[...prices].reverse().forEach(p=>{if(COST_LAST[p.product_id]==null)COST_LAST[p.product_id]=Number(p.cost||0);});
function computeDay(tISO,stockMap){
  const T=DOW_TARGET[dow(tISO)];
  const pAgg=new Map();
  for(const r of active){
    const o=r.offer_id;
    const whs=new Set([...Object.keys(stockMap[o]||{}),...Object.keys(SALES[o]||{})]);
    whs.forEach(wh=>{
      const stock=stockMap[o]?.[wh]||0;
      const s1=SALES[o]?.[wh]?.[tISO]||0;
      if(stock===0&&s1===0)return;
      const cost=COST_LAST[r.product_id]||0;
      let p=pAgg.get(o);
      if(!p){p={o,pid:r.product_id,matrix:matrixOf(o),stock:0,sum:0,clusters:new Map()};pAgg.set(o,p);}
      p.stock+=stock; p.sum+=stock*cost;
      const cl=WHCLUSTER[wh]||'Прочее';
      if(!p.clusters.has(cl))p.clusters.set(cl,{cs:0,c1:0});
      const g=p.clusters.get(cl); g.cs+=stock; g.c1+=s1;
    });
  }
  const rows=[];
  const tMkt={m1:{sup:0,def:0},m2:{sup:0,def:0}};
  const cov={m1:{lt20:0,b2050:0,gt50:0,ns:0},m2:{lt20:0,b2050:0,gt50:0,ns:0}};
  const clAgg=new Map();
  pAgg.forEach(p=>{
    let up=0,down=0,total=0,s1total=0;
    const upClusters=[],downClusters=[];
    p.clusters.forEach((g,c)=>{
      const dev=(g.cs/T - g.c1)/SMOOTH_DAYS;
      total+=dev; s1total+=g.c1;
      const dir=dev>0.01?'up':(dev<-0.01?'down':0);
      const chg=Math.abs(dev);
      if(dir==='up'){up+=chg; tMkt[p.matrix].sup+=dev; upClusters.push(c);}
      else if(dir==='down'){down+=chg; tMkt[p.matrix].def+=dev; downClusters.push(c);}
      const k=p.matrix+'|'+c;
      if(!clAgg.has(k))clAgg.set(k,{matrix:p.matrix,cluster:c,dev:0,up:0,down:0});
      const o=clAgg.get(k); o.dev+=dev;
      if(dir==='up')o.up+=chg; else if(dir==='down')o.down+=chg;
    });
    if(p.stock>0){const days=s1total>0?p.stock/s1total:Infinity;const b=days<20?'lt20':(days<=50?'b2050':'gt50');cov[p.matrix][b]++;}
    else cov[p.matrix].ns++;
    rows.push({entity_type:'product',entity_key:p.o,report_date:tISO,deviation:total,dev_up:up,dev_down:down,clusters_up:upClusters.join('|'),clusters_down:downClusters.join('|'),fire:false});
  });
  clAgg.forEach(v=>rows.push({entity_type:'cluster',entity_key:v.matrix+':'+v.cluster,report_date:tISO,deviation:v.dev,dev_up:v.up,dev_down:v.down,clusters_up:null,clusters_down:null,fire:false}));
  ['m1','m2'].forEach(mk=>{
    rows.push({entity_type:'market',entity_key:mk+':sup',report_date:tISO,deviation:tMkt[mk].sup,dev_up:null,dev_down:null,clusters_up:null,clusters_down:null,fire:false});
    rows.push({entity_type:'market',entity_key:mk+':def',report_date:tISO,deviation:tMkt[mk].def,dev_up:null,dev_down:null,clusters_up:null,clusters_down:null,fire:false});
    ['lt20','b2050','gt50','ns'].forEach(b=>rows.push({entity_type:'coverage',entity_key:mk+':'+b,report_date:tISO,deviation:cov[mk][b],dev_up:null,dev_down:null,clusters_up:null,clusters_down:null,fire:false}));
  });
  return rows;
}
const devRows=computeDay(D,STOCK_NOW);
const dbDev=await sbAll(`deviation_history?report_date=eq.${D}&fire=eq.false&select=entity_type,entity_key,deviation&order=entity_type,entity_key`);
if(dbDev.length)cmp('отклонения (сверка с CSV-днём)',sumBy(devRows,r=>r.entity_type+'|'+r.entity_key,r=>r.deviation),sumBy(dbDev,r=>r.entity_type+'|'+r.entity_key,r=>Number(r.deviation)),0.001);
else console.log('  отклонений за день в базе нет');
if(SNAPSHOT)await sbWrite('POST','deviation_history?on_conflict=entity_type,entity_key,report_date,fire',devRows);

// ===== 4. Недельные факты заказов → sales_plan_weeks qty/rev (syncWeekFacts из weekly.html) =====
console.log('\n4. Недельные факты заказов',el());
const W0=weekStartOf(D),W1=addDays(W0,6);
const weekSales=(await sbAll(`product_sales?sale_date=gte.${W0}&sale_date=lte.${W1}&select=sale_date,offer_id,warehouse_name,qty,revenue&order=sale_date,offer_id,warehouse_name`))
  .filter(x=>x.sale_date!==D).concat(salesRows);                                  // день D — из API
const per=new Map();weekSales.forEach(r=>{const pid=OFFER_PID_ALL.get(r.offer_id);if(!pid)return;const c=per.get(pid)||{q:0,r:0};c.q+=Number(r.qty||0);c.r+=Number(r.revenue||0);per.set(pid,c);});
const factRows=[];per.forEach((v,pid)=>{factRows.push({product_id:pid,week:W0,metric:'qty',fact:v.q});factRows.push({product_id:pid,week:W0,metric:'rev',fact:Math.round(v.r)});});
const dbFacts=await sbAll(`sales_plan_weeks?week=eq.${W0}&metric=in.(qty,rev)&select=product_id,metric,fact&order=product_id,metric`);
cmp(`факты недели ${W0} qty+rev`,sumBy(factRows,r=>r.product_id+'|'+r.metric,r=>Number(r.fact)),sumBy(dbFacts.filter(r=>r.fact!=null),r=>r.product_id+'|'+r.metric,r=>Number(r.fact)),0.5);
await sbWrite('POST','sales_plan_weeks?on_conflict=product_id,week,metric',factRows);

// ===== 5. Начисления за D: /v1/finance/accrual/by-day → ozon_charges (как импорт отчёта «Начисления») =====
console.log('\n5. Начисления',el());
const types=await ozon('/v1/finance/accrual/types',{});
const TYPES=new Map((types.accrual_types||[]).map(x=>[x.id,{code:x.name,ru:x.description}]));
const GROUP={Logistic:'Услуги доставки',DeliveryToHandoverPlaceByOzon:'Услуги доставки',ReturnFlowLogistic:'Услуги доставки',
  LastMileCourier:'Услуги партнёров',Acquiring:'Услуги партнёров',PickUpPointReturnAcceptance:'Услуги партнёров',PackingFee:'Услуги партнёров',TemporaryPlacementsAgent:'Услуги партнёров',
  PackageCost:'Другие услуги и штрафы',Disposal:'Другие услуги и штрафы',BrandCommission:'Продвижение и реклама',Promotion:'Продвижение и реклама',PayPerClick:'Продвижение и реклама',LabelBrandVerified:'Продвижение и реклама'};
let acc=[],last_id='';
for(let pg=0;pg<500;pg++){const j=await ozon('/v1/finance/accrual/by-day',last_id?{date:D,last_id}:{date:D});acc=acc.concat(j.accruals||[]);last_id=j.last_id||'';if(!last_id)break;}
// SKU, которых нет в products (архив и т. п.) — артикул из API товаров
const unknownSku=new Set();
acc.forEach(a=>{(a.posting?.products||[]).forEach(p=>{if(!SKU_OFFER.has(String(p.sku)))unknownSku.add(String(p.sku));});(a.item_fees?.fees||[]).forEach(f=>{if(!SKU_OFFER.has(String(f.sku)))unknownSku.add(String(f.sku));});});
const us=[...unknownSku];
for(let i=0;i<us.length;i+=100){try{const j=await ozon('/v3/product/info/list',{sku:us.slice(i,i+100).map(Number)});(j.items||[]).forEach(it=>{if(it.offer_id&&it.sku)SKU_OFFER.set(String(it.sku),it.offer_id);(it.sources||[]).forEach(s=>{if(s.sku&&it.offer_id)SKU_OFFER.set(String(s.sku),it.offer_id);});});}catch(e){console.log('  product/info/list:',e.message);}}
// дата заказа (event_date): отправление → «принят в обработку»; кэш — отправления окна и таблица ozon_postings (если есть)
const units=[...new Set(acc.filter(a=>a.accrued_category!=='NON_ITEM').map(a=>String(a.unit_number||'')))].filter(Boolean);
let cacheTable=true;
const need=units.filter(u=>!POSTING_DAY.has(u)&&!ORDER_DAY.has(u));
for(let i=0;i<need.length&&cacheTable;i+=150){
  const r=await fetch(`${SB}/rest/v1/ozon_postings?posting_number=in.(${need.slice(i,i+150).map(encodeURIComponent).join(',')})&select=posting_number,order_number,order_day`,{headers:SR});
  if(!r.ok){cacheTable=false;break;}
  (await r.json()).forEach(x=>{POSTING_DAY.set(x.posting_number,x.order_day);if(x.order_number)ORDER_DAY.set(x.order_number,x.order_day);});
}
const miss=units.filter(u=>!POSTING_DAY.has(u)&&!ORDER_DAY.has(u));
const fetched=[];let t0=Date.now();
for(let i=0;i<miss.length;i+=8){
  if(i&&i%800===0)console.log(`    …запрошено ${i} из ${miss.length}`,el());
  await Promise.all(miss.slice(i,i+8).map(async u=>{const pn=/^\d+-\d+$/.test(u)?u+'-1':u;
    try{const j=await ozon('/v2/posting/fbo/get',{posting_number:pn});const p=j.result;const t=p?.in_process_at||p?.created_at;
      if(t){const d=mskDay(t);POSTING_DAY.set(pn,d);if(p.order_number)ORDER_DAY.set(p.order_number,d);if(pn!==u)POSTING_DAY.set(u,d);fetched.push({posting_number:p.posting_number,order_number:p.order_number||null,order_day:d});}}catch(e){}}));
}
console.log(`  отправлений в начислениях ${units.length}: из окна заказов ${units.length-need.length}, из ozon_postings ${need.length-miss.length}${cacheTable?'':' (таблицы нет)'}, запрошено по одному ${miss.length} за ${Math.round((Date.now()-t0)/1000)} с, найдено ${fetched.length}`);
const eventOf=u=>POSTING_DAY.get(u)||ORDER_DAY.get(u)||null;
const chRows=[];let noOffer=0,nonItem=0;
const push=(a,sku,tag,grp,type,amt,qty,price)=>{const o=SKU_OFFER.get(String(sku));if(!o){noOffer++;return;}
  chRows.push({row_key:`api|${a.accrual_id}|${sku}|${tag}|${chRows.length}`,source_id:String(a.accrual_id),charge_date:D,event_date:eventOf(String(a.unit_number||'')),offer_id:o,group_name:grp,charge_type:type,amount:r2(amt),qty,price:r2(price)});};
acc.forEach(a=>{
  if(a.accrued_category==='POSTING')(a.posting?.products||[]).forEach(pr=>{
    const c=pr.commission,q=Number(pr.quantity||0);
    if(c){const sp=num(c.sale_price),ret=sp<0;
      push(a,pr.sku,'sale',ret?'Возвраты':'Продажи',ret?'Возврат выручки':'Выручка',sp,q,q?num(c.seller_price)/q:0);
      if(num(c.bonus))push(a,pr.sku,'bonus',ret?'Возвраты':'Продажи','Баллы за скидки',num(c.bonus),q,0);
      if(num(c.coinvestment))push(a,pr.sku,'coinv',ret?'Возвраты':'Продажи','Программы партнёров',num(c.coinvestment),q,0);
      const sc=num(c.sale_commission);if(sc)push(a,pr.sku,'comm','Вознаграждение Ozon',sc>0?'Возврат вознаграждения':'Вознаграждение за продажу',sc,q,0);}
    (pr.delivery?.services||[]).forEach(s=>{const t=TYPES.get(s.type_id)||{code:String(s.type_id),ru:String(s.type_id)};const v=num(s.accrued);
      push(a,pr.sku,'t'+s.type_id,GROUP[t.code]||'',t.ru+(v>0&&/Logistic|LastMile|Delivery/.test(t.code)?' - отмена начисления':''),v,q,0);});
  });
  else if(a.accrued_category==='ITEM')(a.item_fees?.fees||[]).forEach(f=>(f.fees||[]).forEach(s=>{const t=TYPES.get(s.type_id)||{code:String(s.type_id),ru:String(s.type_id)};
      push(a,f.sku,'t'+s.type_id,GROUP[t.code]||'',t.ru,num(s.accrued),Number(f.quantity||0),0);}));
  else nonItem++;                                                                   // без товара (хранение, клики) — как CSV: не берём
});
console.log(`  начислений ${acc.length}, строк для базы ${chRows.length}; без товара пропущено ${nonItem}, SKU без артикула ${noOffer}, без даты заказа ${chRows.filter(r=>!r.event_date).length}`);
{const noEv=chRows.filter(r=>!r.event_date).length;note(`Начисления: ${chRows.length} строк, итог ${nf(chRows.reduce((a,r)=>a+r.amount,0))} ₽; без товара (не в марже) ${nonItem}${noOffer?`; ⚠️ SKU без артикула ${noOffer}`:''}${noEv?`; без даты заказа ${noEv}`:''}`);}
const dbCh=await sbAll(`ozon_charges?charge_date=eq.${D}&select=offer_id,group_name,charge_type,amount,qty,price,event_date&order=row_key`);
if(dbCh.length){
  cmp('суммы артикул×тип (сверка с CSV)',sumBy(chRows,r=>r.offer_id+'|'+r.charge_type,r=>r.amount),sumBy(dbCh,r=>r.offer_id+'|'+r.charge_type,r=>Number(r.amount)));
  cmp('суммы артикул×дата заказа (сверка с CSV)',sumBy(chRows,r=>r.offer_id+'|'+r.event_date,r=>r.amount),sumBy(dbCh,r=>r.offer_id+'|'+r.event_date,r=>Number(r.amount)));
  const gmv=rows=>sumBy(rows.filter(r=>r.charge_type==='Выручка'||r.charge_type==='Возврат выручки'),r=>r.offer_id,r=>Number(r.price)*Number(r.qty));
  cmp('GMV (цена × штуки) по артикулам',gmv(chRows),gmv(dbCh),0.05);
}else console.log('  начислений за день в базе нет — сверять не с чем');
if(chRows.length){await sbWrite('DELETE',`ozon_charges?charge_date=eq.${D}`);await sbWrite('POST','ozon_charges?on_conflict=row_key',chRows);}
const postRows=[...new Map(posts.map(p=>[p.posting_number,{posting_number:p.posting_number,order_number:p.order_number||null,order_day:mskDay(p.in_process_at||p.created_at)}])).values()].concat(fetched);
if(cacheTable&&postRows.length)await sbWrite('POST','ozon_postings?on_conflict=posting_number',postRows);

// ===== 5б. Реклама: Ozon Performance API → ozon_ad_spend (как импорт CSV «Аналитика продвижения») =====
// Расход по SKU за D и D−1 (статистика за день досчитывается — позавчера каждую ночь перезаписывается окончательными цифрами).
// Отчёты по SKU Ozon формирует в очереди — заказываем только по кампаниям с расходом (быстрый statistics/expense), по 10 за запрос.
// Сверка 30.10.2026: ООО 27.10 — 24 из 24 SKU, ИП 25.10 — итог 0,000% (в CSV ещё строки с расходом 0 — API их не отдаёт).
console.log('\n5б. Реклама',el());
const ADS_DAYS=[addDays(D,-1),D], apiAds=[];
if(!process.env.OZON_PERF_CLIENT_ID){note('Реклама: ключей Performance API нет — пропущено');console.log('  ключей Performance API нет — шаг пропущен');}
else{
  const PERF='https://api-performance.ozon.ru';let PT='';
  const perf=async(path,{method='GET',body,raw}={})=>{for(let a=0;a<5;a++){let r,t;
      try{r=await fetch(PERF+path,{method,headers:{Authorization:'Bearer '+PT,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
        t=raw?Buffer.from(await r.arrayBuffer()):await r.text();}catch(e){await sleep(2000*(a+1));continue;}
      if(r.status===429||r.status>=500){await sleep(3000*(a+1));continue;}
      if(r.status!==200)throw new Error(`Performance ${path.split('?')[0]}: HTTP ${r.status} ${raw?'':String(t).slice(0,150)}`);
      return raw?t:(()=>{try{return JSON.parse(t);}catch(e){return t;}})();}
    throw new Error(`Performance ${path.split('?')[0]}: нет ответа`);};
  const tk=await (await fetch(PERF+'/api/client/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.OZON_PERF_CLIENT_ID,client_secret:process.env.OZON_PERF_CLIENT_SECRET,grant_type:'client_credentials'})})).json();
  if(!tk.access_token)throw new Error('Performance: токен не получен');
  PT=tk.access_token;
  const ex=await perf(`/api/client/statistics/expense?dateFrom=${ADS_DAYS[0]}&dateTo=${ADS_DAYS[1]}`);
  const spent=new Set();String(ex).split('\n').slice(1).forEach(l=>{const c=l.split(';');if(c.length>3&&Number(String(c[3]).replace(',','.'))>0)spent.add(String(c[0]).trim());});
  const ids=[...spent];const sum=new Map();let reports=0;
  const isoOf=v=>{v=String(v).trim();let m=v.match(/^(\d{2})\.(\d{2})\.(\d{4})/);if(m)return `${m[3]}-${m[2]}-${m[1]}`;m=v.match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[0]:null;};
  for(let i=0;i<ids.length;i+=10){
    const r=await perf('/api/client/statistics',{method:'POST',body:{campaigns:ids.slice(i,i+10),dateFrom:ADS_DAYS[0],dateTo:ADS_DAYS[1],groupBy:'DATE'}});
    const uuid=r.UUID||r.uuid;if(!uuid)throw new Error('Performance: отчёт не заказан');
    let st='';for(let k=0;k<100&&st!=='OK';k++){await sleep(3000);st=(await perf(`/api/client/statistics/${uuid}`)).state;if(st==='ERROR')throw new Error('Performance: отчёт с ошибкой');}
    if(st!=='OK')throw new Error('Performance: отчёт не готов за 5 минут');
    const buf=await perf(`/api/client/statistics/report?UUID=${uuid}`,{raw:true});reports++;
    let txt=buf.toString('utf8');
    if(buf[0]===0x50&&buf[1]===0x4b){const {execSync}=await import('node:child_process');fs.writeFileSync('/tmp/ads.zip',buf);
      execSync('rm -rf /tmp/ads && mkdir -p /tmp/ads && cd /tmp/ads && unzip -o -q ../ads.zip');txt=fs.readdirSync('/tmp/ads').map(f=>fs.readFileSync('/tmp/ads/'+f,'utf8')).join('\n');}
    let hdr=null;
    txt.split('\n').forEach(line=>{const c=line.split(';').map(x=>x.replace(/^"|"$/g,'').trim());
      if(c.some(x=>/^sku$/i.test(x))&&c.some(x=>/^расход/i.test(x))){hdr=c;return;}
      if(!hdr||c.length!==hdr.length)return;
      const sku=c[hdr.findIndex(x=>/^sku$/i.test(x))],day=isoOf(c[hdr.findIndex(x=>/^(день|дата)$/i.test(x))]),amt=Number(String(c[hdr.findIndex(x=>/^расход/i.test(x))]).replace(/\s/g,'').replace(',','.'));
      if(/^\d+$/.test(sku)&&ADS_DAYS.includes(day)&&Number.isFinite(amt)){const k=sku+'|'+day;sum.set(k,(sum.get(k)||0)+amt);}});
  }
  sum.forEach((v,k)=>{const [offer_id,spend_date]=k.split('|');if(Math.abs(v)>=0.005)apiAds.push({offer_id,spend_date,amount:r2(v),updated_at:new Date().toISOString()});});
  for(const d of ADS_DAYS){
    const dbA=await sbAll(`ozon_ad_spend?spend_date=eq.${d}&select=offer_id,amount&order=offer_id`);
    if(dbA.length)cmp(`реклама ${d} по SKU (сверка с базой)`,sumBy(apiAds.filter(r=>r.spend_date===d),r=>r.offer_id,r=>r.amount),sumBy(dbA.filter(r=>Number(r.amount)!==0),r=>r.offer_id,r=>Number(r.amount)),0.05);
  }
  const unk=apiAds.filter(r=>!SKU_PID.has(String(r.offer_id))).length;
  console.log(`  кампаний с расходом ${ids.length}, отчётов ${reports}, строк SKU×день ${apiAds.length}${unk?`, SKU не из активных товаров ${unk}`:''}`);
  note(`Реклама: ${ADS_DAYS.map(d=>`${d.slice(8,10)}.${d.slice(5,7)} — ${nf(apiAds.filter(r=>r.spend_date===d).reduce((a,r)=>a+r.amount,0))} ₽`).join(', ')} (кампаний с расходом ${ids.length})`);
  for(const d of ADS_DAYS){await sbWrite('DELETE',`ozon_ad_spend?spend_date=eq.${d}`);const rows=apiAds.filter(r=>r.spend_date===d);if(rows.length)await sbWrite('POST','ozon_ad_spend?on_conflict=offer_id,spend_date',rows);}
}

// ===== 6. Пересчёт CF (syncPnl из plan.html) → sales_plan_weeks, cf_daily =====
console.log('\n6. Пересчёт CF',el());
const prov=[...new Set((await sbAll('sales_plan_weeks?cost_provisional=eq.true&select=week&order=week')).map(x=>x.week))];
const weeks=[...new Set([...isoWeeksOfMonth(monthOfWeek(weekStartOf(TODAY))),...isoWeeksOfMonth(monthOfWeek(W0)),W0,...prov])].sort();
const first=weeks[0],last=addDays(weeks[weeks.length-1],6);
// начисления периода — по дням, 8 дней параллельно (одним запросом на ~1 млн строк ИП база отдаёт страницы слишком медленно)
const chDays=[];for(let d=first;d<=last;d=addDays(d,1))chDays.push(d);
const chByDay=new Map();
for(let i=0;i<chDays.length;i+=8)await Promise.all(chDays.slice(i,i+8).map(async d=>chByDay.set(d,await sbAll(`ozon_charges?charge_date=eq.${d}&select=offer_id,charge_date,charge_type,amount,qty,price&order=row_key`))));
const dbCharges=chDays.flatMap(d=>chByDay.get(d)||[]);
console.log('  начисления периода прочитаны',el());
const ads=(await sbAll(`ozon_ad_spend?spend_date=gte.${first}&spend_date=lte.${last}&select=offer_id,spend_date,amount&order=spend_date,offer_id`))
  .filter(x=>!(apiAds.length&&ADS_DAYS.includes(x.spend_date))).concat(apiAds.length?apiAds:[]);                 // дни рекламы из API — из API
const adsMap=new Map();ads.forEach(x=>{const pid=SKU_PID.get(String(x.offer_id))||OFFER_PID.get(x.offer_id);if(!pid)return;let m=adsMap.get(pid);if(!m){m=new Map();adsMap.set(pid,m);}m.set(x.spend_date,(m.get(x.spend_date)||0)+Number(x.amount||0));});
function syncPnl(rows){
  const day=new Map();
  rows.forEach(c=>{
    const pid=OFFER_PID.get(c.offer_id); if(!pid)return;
    const d=c.charge_date; if(!d)return;
    let m=day.get(pid); if(!m){m=new Map();day.set(pid,m);}
    let g=m.get(d); if(!g){g={pnl:0,sales:0,gmv:0,revg:0,ug:0,revP:0};m.set(d,g);}
    const amt=Number(c.amount||0), qty=Number(c.qty||0), price=Number(c.price||0);
    g.pnl+=amt;
    if(c.charge_type==='Выручка'){ g.gmv+=price*qty; g.revg+=price*qty; g.ug+=qty; g.sales+=qty; g.revP+=amt; }
    else if(c.charge_type==='Возврат выручки'){ g.gmv+=price*qty; g.sales-=qty; g.revP+=amt; }
  });
  const body=[],dayBody=[];
  weeks.forEach(w=>{
    const wDays=[0,1,2,3,4,5,6].map(i=>addDays(w,i));
    day.forEach((m,pid)=>{
      let pnl=0,sales=0,gmv=0,revg=0,ug=0,revP=0,cogs=0,adsW=0,prov=false,any=false;
      const am=adsMap.get(pid);
      wDays.forEach(d=>{const g=m.get(d); if(!g)return; any=true;
        pnl+=g.pnl; sales+=g.sales; gmv+=g.gmv; revg+=g.revg; ug+=g.ug; revP+=g.revP;
        adsW+=am?(am.get(d)||0):0; const ci=costAt(pid,d); cogs+=ci.cost*g.sales; if(ci.prov)prov=true;});
      if(!any)return;
      const tax=TAX_RATE*revP, mar=pnl-cogs-adsW-tax, retn=gmv;
      const row=(metric,fact)=>({product_id:pid,week:w,metric,fact,cogs:r2(cogs),cost_provisional:prov});
      body.push(row('sales',sales)); body.push(row('revn',r2(retn))); body.push(row('mar',r2(mar)));
      body.push(row('revg',r2(revg))); body.push(row('ug',ug));
      if(ug>0)body.push(row('price',r2(revg/ug)));
      if(retn!==0)body.push(row('pct',Math.round(mar/retn*10000)/100));
    });
  });
  day.forEach((m,pid)=>{const am=adsMap.get(pid);m.forEach((g,d)=>{if(d<first||d>last)return;
    const ci=costAt(pid,d),a=am?(am.get(d)||0):0,cogs=ci.cost*g.sales,mar=g.pnl-cogs-a-TAX_RATE*g.revP;
    dayBody.push({product_id:pid,day:d,mar:r2(mar),revn:r2(g.gmv),sales:g.sales,cogs:r2(cogs),cost_provisional:!!ci.prov,updated_at:new Date().toISOString()});});});
  return {body,dayBody};
}
const dbWeeks=await sbAll(`sales_plan_weeks?week=gte.${first}&week=lte.${weeks[weeks.length-1]}&metric=in.(sales,revn,mar,revg,ug,price,pct)&select=product_id,week,metric,fact&order=product_id,week,metric`);
const dbDays=await sbAll(`cf_daily?day=gte.${first}&day=lte.${last}&select=product_id,day,mar,revn,sales&order=product_id,day`);
const wk=b=>sumBy(b.filter(r=>weeks.includes(r.week)&&r.fact!=null),r=>r.product_id+'|'+r.week+'|'+r.metric,r=>Number(r.fact));
const dy=b=>sumBy(b,r=>r.product_id+'|'+r.day,r=>Number(r.mar));
console.log(`  недели ${weeks.join(', ')}; начислений в базе за период ${dbCharges.length}`);
const port=syncPnl(dbCharges);                                                     // те же начисления, что в базе — проверка переноса формул
cmp('ПЕРЕНОС ФОРМУЛ: недели по начислениям базы',wk(port.body),wk(dbWeeks));
cmp('ПЕРЕНОС ФОРМУЛ: cf_daily mar по начислениям базы',dy(port.dayBody),dy(dbDays));
{const A=wk(port.body),B=wk(dbWeeks),by={};A.forEach((v,k)=>{const b=B.get(k);if(b!=null&&Math.abs(v-b)>0.011){const [,w,m]=k.split('|');by[w+' '+m]=(by[w+' '+m]||0)+1;}});
 if(Object.keys(by).length)console.log('    расхождения недель (неделя метрика: ячеек):',JSON.stringify(by));
 const A2=dy(port.dayBody),B2=dy(dbDays),byD={};A2.forEach((v,k)=>{const b=B2.get(k);if(b!=null&&Math.abs(v-b)>0.011){const d=k.split('|')[1];byD[d]=(byD[d]||0)+1;}});
 if(Object.keys(byD).length)console.log('    расхождения cf_daily (день: ячеек):',JSON.stringify(byD));
 const pd=new Set();A.forEach((v,k)=>{const b=B.get(k);if(b!=null&&Math.abs(v-b)>0.011)pd.add(k.split('|')[0]);});
 console.log(`    товаров с расхождением ${pd.size}; себестоимость менялась с начала периода у ${[...pd].filter(p=>(COST_HIST[p]||[]).some(x=>x.t>=first)).length}`);}
const withApi=dbCharges.filter(c=>c.charge_date!==D).concat(chRows);              // день D — из API
const res=syncPnl(withApi);
cmp(`маржа CF дня ${D}: API против CSV`,dy(res.dayBody.filter(r=>r.day===D)),dy(dbDays.filter(r=>r.day===D)));
await sbWrite('POST','sales_plan_weeks?on_conflict=product_id,week,metric',res.body);
await sbWrite('POST','cf_daily?on_conflict=product_id,day',res.dayBody);
note(`Маржа CF за день: ${nf(res.dayBody.filter(r=>r.day===D).reduce((a,r)=>a+r.mar,0))} ₽; пересчитаны недели ${weeks.map(w=>w.slice(8,10)+'.'+w.slice(5,7)).join(', ')}`);

// ===== 7. Фиксация SMART-гипотез (fixHypotheses из plan.html, 1:1) =====
// Отличие одно: гипотеза по марже ждёт, пока в базе появится реклама за день дедлайна (её CSV грузят утром, после ночной загрузки).
console.log('\n7. Фиксация гипотез',el());
const isWeekend=iso=>{const w=dow(iso);return w===0||w===6;};
const proto=await sbAll('product_protocol?parent_id=is.null&deadline=not.is.null&fact_ctx=is.null&fact_dev=is.null&select=id,product_id,deadline,metric,baseline_ctx,created_at&order=id');
async function salesMap(pid,from,to){const m=new Map();const o=PID_OFFER.get(pid);if(!o)return m;
  (await sbAll(`product_sales?offer_id=eq.${encodeURIComponent(o)}&sale_date=gte.${from}&sale_date=lte.${to}&select=sale_date,qty&order=sale_date,warehouse_name`)).forEach(x=>m.set(x.sale_date,(m.get(x.sale_date)||0)+Number(x.qty||0)));return m;}
async function ordersAvgWeekdays(pid,from,to){const m=await salesMap(pid,from,to);let sum=0,cnt=0,d=from;
  while(d<=to){if(!isWeekend(d)){sum+=(m.get(d)||0);cnt++;}d=addDays(d,1);}return cnt?Math.round(sum/cnt*100)/100:null;}
async function marginAggPeriod(pid,from,to){
  const o=PID_OFFER.get(pid);const map=new Map();
  if(o)(await sbAll(`ozon_charges?offer_id=eq.${encodeURIComponent(o)}&event_date=gte.${from}&event_date=lte.${to}&select=event_date,charge_type,amount,qty,price&order=row_key`)).forEach(c=>{
    const d=c.event_date;if(!d)return;let g=map.get(d);if(!g){g={pnl:0,gmv:0,sales:0,revP:0};map.set(d,g);}
    const amt=Number(c.amount||0),qty=Number(c.qty||0),price=Number(c.price||0);g.pnl+=amt;
    if(c.charge_type==='Выручка'){g.gmv+=price*qty;g.sales+=qty;g.revP+=amt;}else if(c.charge_type==='Возврат выручки'){g.gmv+=price*qty;g.sales-=qty;g.revP+=amt;}});
  const ad=new Map();(await sbAll(`ozon_ad_spend?spend_date=gte.${from}&spend_date=lte.${to}&select=offer_id,spend_date,amount&order=spend_date,offer_id`)).forEach(x=>{
    if((SKU_PID.get(String(x.offer_id))||OFFER_PID.get(x.offer_id))===pid)ad.set(x.spend_date,(ad.get(x.spend_date)||0)+Number(x.amount||0));});
  let pnl=0,gmv=0,sales=0,revP=0,cogs=0,cnt=0,ads=0,d=from;
  while(d<=to){const g=map.get(d);if(g&&g.gmv>0){pnl+=g.pnl;gmv+=g.gmv;sales+=g.sales;revP+=g.revP||0;cogs+=costAt(pid,d).cost*g.sales;cnt++;}ads+=ad.get(d)||0;d=addDays(d,1);}
  if(!cnt||gmv<=0)return null;
  const tax=TAX_RATE*revP;                                                        // себестоимость — на дату (costAt), как syncPnl (с 30.10.2026)
  return {pct:Math.round(((pnl-cogs-ads-tax)/gmv*100)*100)/100,from,to,days:cnt};
}
const adsDay=new Map();
const hasAds=async d=>{if(!adsDay.has(d))adsDay.set(d,(await sbAll(`ozon_ad_spend?spend_date=eq.${d}&select=spend_date&order=offer_id`)).length>0);return adsDay.get(d);};
const hyp={всего:proto.length,заказы:0,маржа:0,'ждут дедлайна':0,'ждут рекламу':0,'нет данных':0,ошибки:0};
for(const it of proto){
  try{
    const base=it.baseline_ctx?JSON.parse(it.baseline_ctx):null;
    if(!base||!('orders' in base))continue;
    const metric=it.metric||'orders', created=mskDay(it.created_at);
    let payload=null;
    if(metric==='orders'){
      if(TODAY<=it.deadline){hyp['ждут дедлайна']++;continue;}
      const f=await ordersAvgWeekdays(it.product_id,addDays(created,1),it.deadline);
      if(f==null){hyp['нет данных']++;continue;}
      payload={fact_ctx:JSON.stringify({orders:f,orders_from:addDays(created,1),orders_to:it.deadline,pct:null,pct_date:null,fix_date:TODAY}),fact_dev:1,fact_date:TODAY};hyp.заказы++;
    }else{
      if(TODAY<addDays(it.deadline,1)){hyp['ждут дедлайна']++;continue;}
      if(!await hasAds(it.deadline)){hyp['ждут рекламу']++;continue;}
      const f=await marginAggPeriod(it.product_id,addDays(it.deadline,-2),it.deadline);
      if(f==null){hyp['нет данных']++;continue;}
      payload={fact_ctx:JSON.stringify({orders:null,orders_from:null,orders_to:null,pct:f.pct,pct_from:f.from,pct_to:f.to,pct_days:f.days,fix_date:TODAY}),fact_dev:1,fact_date:TODAY};hyp.маржа++;
    }
    await sbPatch(`product_protocol?id=eq.${it.id}`,payload);
  }catch(e){hyp.ошибки++;console.log('  гипотеза: ошибка',e.message.slice(0,120));}
}
console.log('  гипотезы без зафиксированного факта:',JSON.stringify(hyp));
note(`Гипотезы: зафиксировано ${hyp.заказы+hyp.маржа} (заказы ${hyp.заказы}, маржа ${hyp.маржа}); ждут рекламу ${hyp['ждут рекламу']}${hyp.ошибки?`; ⚠️ ошибки ${hyp.ошибки}`:''}`);
if(!WRITE){ // проверка переноса: пересчитать уже зафиксированные браузером гипотезы и сравнить с записанным фактом
  const done=await sbAll('product_protocol?parent_id=is.null&deadline=not.is.null&fact_ctx=not.is.null&select=id,product_id,deadline,metric,baseline_ctx,created_at,fact_ctx&order=id');
  const chk={заказы:{совпало:0,другое:0},маржа:{совпало:0,другое:0},пропущено:0};
  const why={};const tag=(m,ok,fc,it,nw,old)=>{if(ok)return;const lag=fc.fix_date?Math.round((new Date(fc.fix_date)-new Date(it.deadline))/864e5):'?';const k=`${m}: фиксация через ${lag} дн, новое ${nw==null?'нет данных':nw>old?'больше':'меньше'}`;why[k]=(why[k]||0)+1;};
  for(const it of done.slice(-80)){
    try{const fc=JSON.parse(it.fact_ctx),base=it.baseline_ctx?JSON.parse(it.baseline_ctx):null;if(!base||!('orders' in base)){chk.пропущено++;continue;}
      if((it.metric||'orders')==='orders'){if(fc.orders==null){chk.пропущено++;continue;}
        const f=await ordersAvgWeekdays(it.product_id,addDays(mskDay(it.created_at),1),it.deadline);
        const ok=f!=null&&Math.abs(f-Number(fc.orders))<0.005;chk.заказы[ok?'совпало':'другое']++;tag('заказы',ok,fc,it,f,Number(fc.orders));}
      else{if(fc.pct==null){chk.пропущено++;continue;}
        const f=await marginAggPeriod(it.product_id,addDays(it.deadline,-2),it.deadline);
        const ok=f&&Math.abs(f.pct-Number(fc.pct))<0.015;chk.маржа[ok?'совпало':'другое']++;tag('маржа',ok,fc,it,f?f.pct:null,Number(fc.pct));}
    }catch(e){chk.пропущено++;}
  }
  console.log(`  ПЕРЕНОС ФОРМУЛ гипотез (последние ${Math.min(80,done.length)} из ${done.length} зафиксированных браузером):`,JSON.stringify(chk));
  Object.entries(why).sort().forEach(([k,v])=>console.log(`    расхождение — ${k}: ${v}`));
}

// ===== 8. Лимиты ДРР от цены → product_drr_limits (pulseCal / unitPct из plan.html, «Рука на пульсе», 1:1) =====
// Для вкладки «Протокол работ» на главной (31.10.2026): цена — средняя за 7 дней до сегодня, план маржинальности — месяц дня D.
// Нет таблицы (SQL не запущен) — предупреждение, загрузка не падает.
console.log('\n8. Лимиты ДРР',el());
if(!SNAPSHOT){console.log('  день ≠ вчера — пропущено');}
else try{
  const NET_FLOOR=5, OZON_COMM_EDGE=300, OZON_COMM={low:23,high:51};
  const PULSE_PROP=new Set(['Выручка','Баллы за скидки','Возврат выручки','Вознаграждение за продажу','Возврат вознаграждения','Эквайринг','Программы партнёров','Продвижение бренда']);
  const med=a=>{const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2;};
  const calTo=addDays(TODAY,-8), calFrom=addDays(calTo,-27), p7From=addDays(TODAY,-7), p7To=addDays(TODAY,-1);
  const sl=await sbAll(`product_sales?sale_date=gte.${calFrom}&sale_date=lte.${p7To}&select=sale_date,offer_id,qty,revenue&order=sale_date,offer_id,warehouse_name`);
  const SQ=new Map(),SR_=new Map();sl.forEach(x=>{const k=x.offer_id+'|'+x.sale_date;SQ.set(k,(SQ.get(k)||0)+Number(x.qty||0));SR_.set(k,(SR_.get(k)||0)+Number(x.revenue||0));});
  const planM=new Map((await sbAll(`sales_plan?month=eq.${D.slice(0,7)}&select=product_id,plan_qty,margin_pct&order=product_id`)).map(x=>[x.product_id,x]));
  const sumQR=(o,f,t)=>{let q=0,r=0;for(let d=f;d<=t;d=addDays(d,1)){q+=SQ.get(o+'|'+d)||0;r+=SR_.get(o+'|'+d)||0;}return {q,r};};
  // начисления по дате заказа из представления ozon_charges_by_event — по неделям (как pulseCharges), не больше 3 товаров одновременно
  const todo=active.filter(p=>sumQR(p.offer_id,calFrom,calTo).q>0);
  const limRows=[];let noCal=0,qi=0;
  await Promise.all([0,1,2].map(async()=>{ while(qi<todo.length){ const p=todo[qi++],pid=p.product_id,o=p.offer_id;
    const ch=[];for(let w=0;w<4;w++){const f=addDays(calFrom,w*7);ch.push(...await sbAll(`ozon_charges_by_event?offer_id=eq.${encodeURIComponent(o)}&event_date=gte.${f}&event_date=lte.${addDays(f,6)}&select=event_date,charge_type,amount,qty,gmv&order=event_date,charge_type`));}
    // pulseByDay
    const byDay=new Map();ch.forEach(c=>{const d=c.event_date;if(!d)return;let g=byDay.get(d);if(!g){g={gmv:0,sales:0,pnl:0,revP:0,prop:0,unit:0,comm:0};byDay.set(d,g);}
      const amt=Number(c.amount||0),qty=Number(c.qty||0),gv=Number(c.gmv||0);g.pnl+=amt;if(PULSE_PROP.has(c.charge_type))g.prop+=amt;else g.unit+=amt;
      if(c.charge_type==='Вознаграждение за продажу'||c.charge_type==='Возврат вознаграждения')g.comm+=amt;
      if(c.charge_type==='Выручка'){g.gmv+=gv;g.sales+=qty;g.revP+=amt;}else if(c.charge_type==='Возврат выручки'){g.gmv+=gv;g.sales-=qty;g.revP+=amt;}});
    // pulseCal
    const W=[];let oqAll=0,orAll=0;
    for(let i=0;i<4;i++){const f=addDays(calFrom,i*7);let gmv=0,prop=0,unit=0,revP=0,cogs=0,oq=0,orev=0,comm=0;
      for(let k=0;k<7;k++){const d=addDays(f,k),g=byDay.get(d);if(g){gmv+=g.gmv;prop+=g.prop;unit+=g.unit;revP+=g.revP;comm+=g.comm;cogs+=costAt(pid,d).cost*g.sales;}
        oq+=SQ.get(o+'|'+d)||0;orev+=SR_.get(o+'|'+d)||0;}
      oqAll+=oq;orAll+=orev;
      if(gmv>0&&oq>0&&orev>0)W.push({b:gmv/orev,r:prop/gmv,t:TAX_RATE*revP/gmv,u:(cogs-unit)/oq,c:-comm/gmv});}
    if(!W.length){noCal++;continue;}
    const C={b:med(W.map(w=>w.b)),r:med(W.map(w=>w.r)),t:med(W.map(w=>w.t)),u:med(W.map(w=>w.u))},p0=oqAll>0?orAll/oqAll:null;
    const c=med(W.map(w=>w.c)),own=p0!=null&&p0>OZON_COMM_EDGE?'high':'low';
    C.r0=C.r+c;C.comm={low:own==='low'?c:OZON_COMM.low/100,high:own==='high'?c:OZON_COMM.high/100};
    // цена — средняя за 7 дней (как priceNow в pulseHtml); unitPct при ДРР 0 = маржинальность до рекламы
    const s7=sumQR(o,p7From,p7To),P=s7.q>0?s7.r/s7.q:p0;
    const pre=((C.r0-(P<=OZON_COMM_EDGE?C.comm.low:C.comm.high))-C.t-C.u/(P*C.b))*100;
    const pl=planM.get(pid),planPct=pl&&pl.margin_pct!=null&&Number(pl.plan_qty)>0?Number(pl.margin_pct):null;
    const r4=x=>x==null?null:Math.round(x*1e4)/1e4;
    limRows.push({product_id:pid,day:TODAY,price:r2(P),pre_pct:r4(pre),plan_pct:planPct,drr_plan:planPct==null?null:r4(Math.max(0,(pre-planPct)*C.b)),
      drr_be:r4(Math.max(0,(pre-NET_FLOOR)*C.b)),b:r4(C.b),r0:r4(C.r0),comm_low:r4(C.comm.low),comm_high:r4(C.comm.high),t:r4(C.t),u:r4(C.u),cal_from:calFrom,cal_to:calTo});
  }}));
  console.log(`  товаров с продажами в ${calFrom}…${calTo}: ${todo.length}, лимиты: ${limRows.length}, без начислений: ${noCal}`);
  await sbWrite('POST','product_drr_limits?on_conflict=product_id,day',limRows);
  note(`Лимиты ДРР: ${limRows.length} товаров`);
}catch(e){console.log('  ⚠️ лимиты ДРР:',e.message.slice(0,160));note(`⚠️ Лимиты ДРР не посчитаны: ${e.message.slice(0,100)}`);}

if(!WRITE){console.log('\nРежим проверки — в базу НЕ записано. Было бы выполнено:');PLANNED.forEach(x=>console.log('  '+x));}
note(`Время: ${Math.round((Date.now()-T0)/60000)} мин`);
console.log('\nГотово.');
