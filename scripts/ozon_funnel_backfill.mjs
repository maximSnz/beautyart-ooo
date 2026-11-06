// Догрузка воронки наших товаров за N дней → product_funnel_daily (06.11.2026, стол 2 окна товара: график воронки за 30 дней).
// Ночная загрузка (шаг 11) берёт только D−2…D — без догрузки история накапливалась бы месяц. Только ручной запуск.
// /v1/analytics/data — не чаще 1 раза в минуту, ответ — не больше 1000 строк: дни пачками по STEP (по умолчанию 3;
// ИП 06.11.2026 — ~690 строк на пачку), пачка с 1000 строк — заново по одному дню. Запись — после каждой пачки (обрыв не теряет загруженное).
// WRITE=1 — запись; иначе проверка (в базу ничего не пишется). Репозиторий публичный — в лог только счётчики.
const OZON='https://api-seller.ozon.ru';
const H={'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json'};
const SB=process.env.SUPABASE_URL,SR={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
const WRITE=process.env.WRITE==='1',N=Math.max(1,Math.min(90,Number(process.env.DAYS||40))),STEP=Math.max(1,Math.min(3,Number(process.env.STEP||3)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const TODAY=new Date(Date.now()+3*3600e3).toISOString().slice(0,10),TO=addDays(TODAY,-1),FROM=addDays(TO,-(N-1));
const FM=['hits_view','hits_view_search','hits_view_pdp','hits_tocart','hits_tocart_search','hits_tocart_pdp','session_view','session_view_search','session_view_pdp','ordered_units','revenue','delivered_units','returns','cancellations'];
let calls=0;
async function ana(from,to){
  for(let a=0;a<5;a++){if(calls++)await sleep(62000);
    const r=await fetch(OZON+'/v1/analytics/data',{method:'POST',headers:H,body:JSON.stringify({date_from:from,date_to:to,metrics:FM,dimension:['sku','day'],filters:[],sort:[{key:'hits_view',order:'DESC'}],limit:1000,offset:0})});
    const j=await r.json().catch(()=>null);if(r.status===200)return j?.result?.data||[];
    console.log(`  ${from}…${to}: HTTP ${r.status} ${String(j?.message||'').slice(0,120)} — повтор`);}
  throw new Error(`analytics/data ${from}…${to}: нет ответа`);}
async function sbAll(path){let out=[],off=0;for(;;){const r=await fetch(`${SB}/rest/v1/${path}&limit=1000&offset=${off}`,{headers:SR});if(!r.ok)throw new Error('Supabase HTTP '+r.status);const j=await r.json();out=out.concat(j);if(j.length<1000)break;off+=1000;}return out;}
console.log(`Догрузка воронки: ${FROM} … ${TO} (${N} дн), режим ${WRITE?'ЗАПИСЬ':'ПРОВЕРКА (в базу ничего не пишется)'}`);
const products=await sbAll('products?select=product_id,sku:raw->sku&order=product_id');
const SKU_PID=new Map(products.filter(p=>p.sku!=null).map(p=>[String(p.sku),p.product_id]));
async function put(rows){if(!WRITE||!rows.length)return;for(let i=0;i<rows.length;i+=500){const r=await fetch(`${SB}/rest/v1/product_funnel_daily?on_conflict=sku,day`,{method:'POST',headers:{...SR,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows.slice(i,i+500))});
  if(!r.ok)throw new Error('Supabase POST product_funnel_daily: HTTP '+r.status+' '+(await r.text()).slice(0,200));}}
const rows=[];
for(let f=FROM;f<=TO;f=addDays(f,STEP)){const t=addDays(f,STEP-1)>TO?TO:addDays(f,STEP-1);
  let d=await ana(f,t);
  if(d.length>=1000){d=[];for(let x=f;x<=t;x=addDays(x,1)){const one=await ana(x,x);if(one.length>=1000)console.log(`  ⚠️ ${x}: 1000 строк — возможна потеря`);d.push(...one);}}
  const now=new Date().toISOString(),part=[];
  d.forEach(x=>{const r={sku:String(x.dimensions[0].id),day:x.dimensions[1].id,product_id:SKU_PID.get(String(x.dimensions[0].id))??null,updated_at:now};FM.forEach((m,i)=>{r[m]=Number(x.metrics?.[i]??0);});part.push(r);});
  await put(part);rows.push(...part);console.log(`  ${f}…${t}: строк ${d.length}${WRITE?' — записано':''}`);}
console.log(`Итого строк: ${rows.length}, дней ${new Set(rows.map(r=>r.day)).size}, SKU ${new Set(rows.map(r=>r.sku)).size}, без товара в products ${rows.filter(r=>r.product_id==null).length}`);
if(WRITE)console.log('Записано. position_category не догружается — его пишет только ночная загрузка.');
else console.log('Режим проверки — в базу НЕ записано.');
