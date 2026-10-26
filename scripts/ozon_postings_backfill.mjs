// Разовое заполнение справочника отправлений ozon_postings («номер → день заказа») — для даты заказа (event_date)
// в начислениях ночной загрузки (ozon_daily_load.mjs). Пишет ТОЛЬКО в ozon_postings. Запуск: workflow ozon-postings-backfill.
// День заказа — по Москве, как дата заказа в отчёте «Начисления» кабинета (проверено 26.10.2026; заказы в product_sales — по UTC). Период — с FROM (по умолчанию 2026-08-31, начало работы через сайт) по сегодня; пачками по 100 отправлений, окнами по 7 дней.
const OZON='https://api-seller.ozon.ru';
const H={'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json'};
const SB=process.env.SUPABASE_URL, SR={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mskDay=iso=>new Date(new Date(iso).getTime()+3*3600e3).toISOString().slice(0,10);
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
async function ozon(path,body){
  for(let a=0;a<6;a++){
    let r,t;
    try{r=await fetch(OZON+path,{method:'POST',headers:H,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});t=await r.text();}
    catch(e){await sleep(1500*(a+1));continue;}
    let j=null; try{j=JSON.parse(t);}catch(e){}
    if(r.status===429||r.status>=500){await sleep(2000*(a+1));continue;}
    if(r.status!==200)throw new Error(`Ozon ${path}: HTTP ${r.status} ${j?.message||t.slice(0,150)}`);
    return j;
  }
  throw new Error(`Ozon ${path}: нет ответа`);
}
async function upsert(rows){
  for(let i=0;i<rows.length;i+=500){
    const r=await fetch(`${SB}/rest/v1/ozon_postings?on_conflict=posting_number`,{method:'POST',headers:{...SR,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows.slice(i,i+500))});
    if(!r.ok)throw new Error(`Supabase ozon_postings: HTTP ${r.status} ${(await r.text()).slice(0,200)}`);
  }
}
const FROM=process.env.FROM||'2026-08-31', TODAY=mskDay(new Date().toISOString());
const T0=Date.now();let total=0;
for(let d=FROM;d<=TODAY;d=addDays(d,7)){
  const to=addDays(d,6)<TODAY?addDays(d,6):TODAY;
  const map=new Map();let cursor='',pages=0;
  for(;pages<2000;){
    const j=await ozon('/v3/posting/fbo/list',{dir:'ASC',filter:{since:addDays(d,-1)+'T21:00:00.000Z',to:to+'T23:59:59.999Z'},limit:100,cursor}); // с запасом: сутки по Москве
    (j.postings||[]).forEach(p=>{const t=p.in_process_at||p.created_at;if(p.posting_number&&t)map.set(p.posting_number,{posting_number:p.posting_number,order_number:p.order_number||null,order_day:mskDay(t)});});
    pages++;cursor=j.cursor||'';if(!j.has_next||!cursor)break;
  }
  await upsert([...map.values()]);total+=map.size;
  console.log(`${d}…${to}: отправлений ${map.size}, страниц ${pages} [${Math.round((Date.now()-T0)/1000)} с]`);
}
console.log(`Готово: записано отправлений ${total}.`);
