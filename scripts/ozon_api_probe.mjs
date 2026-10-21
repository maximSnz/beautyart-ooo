// Пробная сверка API Ozon с данными из CSV в базе (этап 3, «загрузка через API вместо CSV»). ТОЛЬКО ЧТЕНИЕ: в базу ничего не пишет.
// Репозиторий публичный — в лог идут только расхождения в процентах, счётчики и названия полей/типов;
// рублей, штук и артикулов в логе нет.
// Запуск: workflow ozon-api-probe (вручную), вход DAYS — дни через запятую (по умолчанию 3 дня, начиная с позавчера).
// Проход 3 (21.10.2026): заказы — /v3/posting/fbo/list (v2 отключён, отчёт postings без склада);
// начисления — /v1/finance/accrual/by-day, строки как у импорта CSV (только привязанные к товару) против ozon_charges.
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
const pct=(a,b)=>b===0?(a===0?'0%':'∞'):((a-b)/Math.abs(b)*100).toFixed(3)+'%';
const mskDay=iso=>{const d=new Date(new Date(iso).getTime()+3*3600e3);return d.toISOString().slice(0,10);};
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const num=v=>Number(v?.amount??v??0);
const today=mskDay(new Date().toISOString());
const DAYS=(process.env.DAYS||'').split(',').map(s=>s.trim()).filter(Boolean);
if(!DAYS.length)for(let i=4;i>=2;i--)DAYS.push(addDays(today,-i));
console.log('Дни сверки:',DAYS.join(', '));
const since=addDays(DAYS[0],-1)+'T21:00:00.000Z', to=DAYS[DAYS.length-1]+'T20:59:59.999Z'; // границы суток по Москве

// ===== 1. Заказы: /v3/posting/fbo/list против product_sales =====
console.log('\n===== 1. ЗАКАЗЫ: /v3/posting/fbo/list против product_sales =====');
let posts=[],cursor='',pages=0;
for(;;){
  const r=await ozon('/v3/posting/fbo/list',{dir:'ASC',filter:{since,to},limit:100,cursor,with:{analytics_data:true,financial_data:true}});
  if(r.status!==200){console.log('  HTTP',msg(r));break;}
  posts=posts.concat(r.json.postings||[]); pages++; cursor=r.json.cursor||'';
  if(!r.json.has_next||!cursor||pages>2000)break;
}
console.log(`  страниц ${pages}, отправлений ${posts.length}`);
const st={};posts.forEach(p=>st[p.status]=(st[p.status]||0)+1);console.log('  статусы:',Object.keys(st).join(', '));
const db=await sbAll(`product_sales?sale_date=gte.${DAYS[0]}&sale_date=lte.${DAYS[DAYS.length-1]}&select=sale_date,offer_id,warehouse_name,qty,revenue&order=sale_date,offer_id,warehouse_name`);
const dbC=new Map();db.forEach(x=>dbC.set(x.sale_date+'|'+x.offer_id+'|'+x.warehouse_name,{q:Number(x.qty||0),r:Number(x.revenue||0)}));
const PRICES={'products.price.amount':(p,i)=>num(p.products[i]?.price),'financial_data.price':(p,i)=>Number(p.financial_data?.products?.[i]?.price),'financial_data.old_price':(p,i)=>Number(p.financial_data?.products?.[i]?.old_price)};
for(const pk in PRICES){
  const apiC=new Map();
  posts.forEach(p=>{ if(/cancel/i.test(p.status||''))return; const d=mskDay(p.in_process_at||p.created_at); if(!DAYS.includes(d))return;
    (p.products||[]).forEach((pr,i)=>{const k=d+'|'+pr.offer_id+'|'+(p.analytics_data?.warehouse_name||'');const c=apiC.get(k)||{q:0,r:0};const q=Number(pr.quantity||0);c.q+=q;c.r+=q*PRICES[pk](p,i);apiC.set(k,c);});});
  console.log(`\n  цена = ${pk}:`);
  DAYS.forEach(d=>{let qa=0,qb=0,ra=0,rb=0,same=0,diffQ=0,diffR=0,onlyA=0,onlyB=0;
    const keys=new Set([...apiC.keys(),...dbC.keys()].filter(k=>k.startsWith(d+'|')));
    keys.forEach(k=>{const a=apiC.get(k),b=dbC.get(k);if(a){qa+=a.q;ra+=a.r;}if(b){qb+=b.q;rb+=b.r;}
      if(!a){onlyB++;return;}if(!b){onlyA++;return;}
      if(a.q!==b.q)diffQ++;else if(Math.abs(Math.round(a.r*100)/100-b.r)>0.01)diffR++;else same++;});
    console.log(`    ${d}: штуки ${pct(qa,qb)}, выручка ${pct(ra,rb)}; ячеек артикул+склад: совпали ${same}, другие штуки ${diffQ}, другая выручка ${diffR}, только в API ${onlyA}, только в базе ${onlyB}`);});
}
// склады: совпадают ли названия
const whA=new Set(posts.map(p=>p.analytics_data?.warehouse_name).filter(Boolean)), whB=new Set(db.map(x=>x.warehouse_name));
console.log(`\n  склады: в API ${whA.size}, в базе ${whB.size}, общих ${[...whA].filter(w=>whB.has(w)).length}`);

// ===== 2. Начисления: строки как у импорта CSV против ozon_charges =====
console.log('\n===== 2. НАЧИСЛЕНИЯ: строки как у импорта против ozon_charges =====');
const ty=await ozon('/v1/finance/accrual/types',{});
const TYPES=new Map((ty.json?.accrual_types||[]).map(x=>[x.id,{code:x.name,ru:x.description}]));
// группа отчёта «Начисления» по коду типа услуги (как в кабинете)
const GROUP={Logistic:'Услуги доставки',DeliveryToHandoverPlaceByOzon:'Услуги доставки',ReturnFlowLogistic:'Услуги доставки',
  LastMileCourier:'Услуги партнёров',Acquiring:'Услуги партнёров',PickUpPointReturnAcceptance:'Услуги партнёров',PackingFee:'Услуги партнёров',TemporaryPlacementsAgent:'Услуги партнёров',
  PackageCost:'Другие услуги и штрафы',Disposal:'Другие услуги и штрафы',BrandCommission:'Продвижение и реклама',Promotion:'Продвижение и реклама',PayPerClick:'Продвижение и реклама',LabelBrandVerified:'Продвижение и реклама'};
const prod=await sbAll('products?select=offer_id,raw->sku&order=product_id');
const SKU_OFFER=new Map(prod.filter(p=>p.sku!=null).map(p=>[String(p.sku),p.offer_id]));
for(const d of DAYS){
  let acc=[],last_id='',pg=0,err=null;
  do{const r=await ozon('/v1/finance/accrual/by-day',last_id?{date:d,last_id}:{date:d});
    if(r.status!==200){err='HTTP '+msg(r);break;}
    acc=acc.concat(r.json.accruals||[]); last_id=r.json.last_id||''; pg++;}while(last_id&&pg<500);
  if(err){console.log(`\n${d}: ${err}`);continue;}
  const rows=[];let noOffer=0,skipped={};
  const push=(sku,grp,type,amt,qty,price)=>{const o=SKU_OFFER.get(String(sku));if(!o){noOffer++;return;}rows.push({o,k:grp+' / '+type,amt,qty,price});};
  let neg=0,pos=0,qtyNeg=0;
  acc.forEach(a=>{
    if(a.accrued_category==='POSTING')(a.posting?.products||[]).forEach(pr=>{
      const c=pr.commission,q=Number(pr.quantity||0);
      if(c){const sp=num(c.sale_price),ret=sp<0; if(ret)neg++;else pos++;
        const unit=q?num(c.seller_price)/q:0;
        push(pr.sku,ret?'Возвраты':'Продажи',ret?'Возврат выручки':'Выручка',sp,q,unit);
        if(num(c.bonus))push(pr.sku,ret?'Возвраты':'Продажи','Баллы за скидки',num(c.bonus),q,0);
        if(num(c.coinvestment))push(pr.sku,ret?'Возвраты':'Продажи','Программы партнёров',num(c.coinvestment),q,0);
        const sc=num(c.sale_commission);if(sc)push(pr.sku,'Вознаграждение Ozon',sc>0?'Возврат вознаграждения':'Вознаграждение за продажу',sc,q,0);}
      (pr.delivery?.services||[]).forEach(s=>{const t=TYPES.get(s.type_id)||{code:'?'+s.type_id,ru:'?'+s.type_id};const v=num(s.accrued);
        push(pr.sku,GROUP[t.code]||'?',t.ru+(v>0&&/Logistic|LastMile|Delivery/.test(t.code)?' - отмена начисления':''),v,q,0);});
    });
    else if(a.accrued_category==='ITEM')(a.item_fees?.fees||[]).forEach(f=>(f.fees||[]).forEach(s=>{const t=TYPES.get(s.type_id)||{code:'?'+s.type_id,ru:'?'+s.type_id};
        push(f.sku,GROUP[t.code]||'?',t.ru,num(s.accrued),Number(f.quantity||0),0);}));
    else skipped[a.accrued_category]=(skipped[a.accrued_category]||0)+1;
  });
  const dbR=await sbAll(`ozon_charges?charge_date=eq.${d}&select=offer_id,group_name,charge_type,amount,qty,price&order=row_key`);
  const cell=(m,o,k,amt)=>{const key=o+'|'+k;m.set(key,(m.get(key)||0)+amt);};
  const A=new Map(),B=new Map();rows.forEach(r=>cell(A,r.o,r.k,r.amt));dbR.forEach(r=>cell(B,r.offer_id,r.group_name+' / '+r.charge_type,Number(r.amount||0)));
  let same=0,diff=0,onlyA=0,onlyB=0;const byType={};
  new Set([...A.keys(),...B.keys()]).forEach(key=>{const a=A.get(key),b=B.get(key),t=key.slice(key.indexOf('|')+1);
    const bt=byType[t]||(byType[t]={a:0,b:0,bad:0});bt.a+=a||0;bt.b+=b||0;
    if(a==null){onlyB++;bt.bad++;}else if(b==null){onlyA++;bt.bad++;}else if(Math.abs(a-b)>0.011){diff++;bt.bad++;}else same++;});
  const sa=rows.reduce((s,r)=>s+r.amt,0),sb=dbR.reduce((s,r)=>s+Number(r.amount||0),0);
  console.log(`\n${d}: начислений API ${acc.length} (пропущены без товара: ${JSON.stringify(skipped)}; SKU без артикула в базе: ${noOffer})`);
  console.log(`  итог по товарам: ${pct(sa,sb)}; ячеек артикул×тип: совпали до копейки ${same}, другая сумма ${diff}, только в API ${onlyA}, только в базе ${onlyB}`);
  console.log(`  возвраты в API (sale_price<0): ${neg} из ${neg+pos} строк выручки`);
  Object.entries(byType).filter(([,v])=>v.bad).sort((x,y)=>Math.abs(y[1].a-y[1].b)-Math.abs(x[1].a-x[1].b)).slice(0,12)
    .forEach(([t,v])=>console.log(`    расходится: ${t} — ${pct(v.a,v.b)}, ячеек ${v.bad}`));
  // разбор расхождений возвратов: что в базе на месте ячеек API «Возврат выручки» (только типы и счётчики)
  const retA=rows.filter(r=>r.k==='Возвраты / Возврат выручки');
  const retInfo={};retA.forEach(r=>{const inB=dbR.filter(x=>x.offer_id===r.o&&/Возврат выручки|Выручка/.test(x.charge_type));
    const k=inB.length?inB.map(x=>x.charge_type+(Number(x.amount)<0?'(−)':'(+)')).sort().join('+'):'нет строк выручки в базе';retInfo[k]=(retInfo[k]||0)+1;});
  if(retA.length)console.log('  возвраты API → в базе у того же артикула:',JSON.stringify(retInfo));
  const negSales=dbR.filter(x=>x.charge_type==='Выручка'&&Number(x.amount)<0).length;
  console.log(`  в базе «Выручка» с минусом: ${negSales}; «Возврат выручки» с плюсом: ${dbR.filter(x=>x.charge_type==='Возврат выручки'&&Number(x.amount)>0).length}`);
  // штуки и цена выручки: syncPnl берёт qty, price×qty (GMV) по «Выручка» и «Возврат выручки»
  for(const t of ['Продажи / Выручка','Возвраты / Возврат выручки']){
    const a=rows.filter(r=>r.k===t),b=dbR.filter(r=>r.group_name+' / '+r.charge_type===t);
    const qa=a.reduce((s,r)=>s+r.qty,0),qb=b.reduce((s,r)=>s+Number(r.qty||0),0);
    const ga=a.reduce((s,r)=>s+r.qty*r.price,0),gb=b.reduce((s,r)=>s+Number(r.qty||0)*Number(r.price||0),0);
    console.log(`  ${t}: строк API ${a.length} / база ${b.length}; штуки ${pct(qa,qb)}; Σ цена×штуки (seller_price) ${pct(ga,gb)}`);
  }
}
console.log('\nГотово. В базу ничего не записано.');
