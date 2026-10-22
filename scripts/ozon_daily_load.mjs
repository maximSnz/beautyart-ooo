// Ночная загрузка из API Ozon вместо CSV (этап 3, решения 22.10.2026 — ROADMAP). Запускается после ozon-products-sync.
// Делает за вчерашний день (по Москве) то же, что кнопки CSV:
//   weekly.html «Заказы»: product_sales, снимок stock_history, deviation_history (computeDay), недельные факты qty/rev;
//   plan.html «Начисления»: ozon_charges и пересчёт CF (syncPnl → sales_plan_weeks, cf_daily).
// fixHypotheses пока остаётся в plan.html (срабатывает при открытии страницы).
// Режимы: WRITE=1 — запись в базу; иначе ПРОВЕРКА: всё считается и сверяется с базой, в базу ничего не пишется.
// Репозиторий публичный — в лог только счётчики и расхождения в процентах; рублей, штук и артикулов в логе нет.
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
const mskDay=iso=>new Date(new Date(iso).getTime()+3*3600e3).toISOString().slice(0,10);
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const dow=iso=>new Date(iso+'T00:00:00Z').getUTCDay();
const weekStartOf=iso=>addDays(iso,-((dow(iso)+6)%7));
const monthOfWeek=w=>addDays(w,3).slice(0,7);                      // месяц недели — по её четвергу
function isoWeeksOfMonth(ym){const [y,m]=ym.split('-').map(Number);const out=[];let w=weekStartOf(`${ym}-01`);
  for(let i=0;i<6;i++){if(monthOfWeek(w)===ym)out.push(w);w=addDays(w,7);}return out;}
const TODAY=mskDay(new Date().toISOString());
const T0=Date.now(), el=()=>`[${Math.round((Date.now()-T0)/1000)} с]`;
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
  const j=await ozon('/v3/posting/fbo/list',{dir:'ASC',filter:{since:addDays(D,-2)+'T21:00:00.000Z',to:D+'T20:59:59.999Z'},limit:100,cursor,with:{analytics_data:true,financial_data:false}});
  posts=posts.concat(j.postings||[]); cursor=j.cursor||''; if(!j.has_next||!cursor)break;
}
const POSTING_DAY=new Map(), ORDER_DAY=new Map();                                 // для event_date начислений
posts.forEach(p=>{const t=p.in_process_at||p.created_at;if(!t)return;const d=mskDay(t);POSTING_DAY.set(p.posting_number,d);if(p.order_number)ORDER_DAY.set(p.order_number,d);});
const salesAgg=new Map();
posts.forEach(p=>{ if(/cancel/i.test(p.status||''))return; if(mskDay(p.in_process_at||p.created_at)!==D)return;
  const wh=(p.analytics_data?.warehouse_name||'').trim();
  (p.products||[]).forEach(pr=>{const o=(pr.offer_id||'').trim(),q=Number(pr.quantity||0);if(!o||!wh||!Number.isFinite(q))return;
    const k=o+'|'+wh,c=salesAgg.get(k)||{q:0,r:0};c.q+=q;c.r+=q*num(pr.price);salesAgg.set(k,c);});});
const salesRows=[...salesAgg].map(([k,v])=>{const [offer_id,warehouse_name]=k.split('|');return {sale_date:D,offer_id,warehouse_name,qty:v.q,revenue:r2(v.r)};});
console.log(`  отправлений в окне ${posts.length}, строк артикул+склад за день ${salesRows.length}`);
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
const ads=await sbAll(`ozon_ad_spend?spend_date=gte.${first}&spend_date=lte.${last}&select=offer_id,spend_date,amount&order=spend_date,offer_id`);
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

if(!WRITE){console.log('\nРежим проверки — в базу НЕ записано. Было бы выполнено:');PLANNED.forEach(x=>console.log('  '+x));}
console.log('\nГотово.');
