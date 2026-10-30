// Пробная сверка Ozon Performance API (реклама) с ozon_ad_spend из CSV «Продвижение». ТОЛЬКО ЧТЕНИЕ: в базу ничего не пишет.
// Репозиторий публичный — в лог только счётчики, названия полей/колонок и расхождения в процентах; рублей и SKU нет.
// Запуск: workflow ozon-ads-probe (вручную), вход DAY — день сверки (пусто — последний день с рекламой в базе).
const PERF='https://api-performance.ozon.ru';
const SB=process.env.SUPABASE_URL, SR={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pct=(a,b)=>b===0?(a===0?'0%':'∞'):((a-b)/Math.abs(b)*100).toFixed(3)+'%';
let TOKEN='';
async function perf(path,{method='GET',body,raw}={}){
  for(let a=0;a<5;a++){
    let r,t;
    try{r=await fetch(PERF+path,{method,headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',Accept:'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
      t=raw?Buffer.from(await r.arrayBuffer()):await r.text();}catch(e){await sleep(2000*(a+1));continue;}
    if(r.status===429||r.status>=500){await sleep(3000*(a+1));continue;}
    let j=null;if(!raw)try{j=JSON.parse(t);}catch(e){}
    return {status:r.status,json:j,text:raw?null:t,buf:raw?t:null,type:r.headers.get('content-type')||''};
  }
  return {status:0,json:null,text:'нет ответа'};
}
const shape=(o,p='',acc=new Map())=>{if(Array.isArray(o)){acc.set(p+'[]','array');o.slice(0,50).forEach(x=>shape(x,p+'[]',acc));}else if(o&&typeof o==='object')for(const k of Object.keys(o))shape(o[k],p?p+'.'+k:k,acc);else if(!acc.has(p))acc.set(p,o===null?'null':typeof o);return acc;};
const printShape=(t,o)=>{console.log(t);[...shape(o).entries()].forEach(([k,v])=>console.log('  '+k+': '+v));};

// 1. Токен
const tk=await fetch(PERF+'/api/client/token',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
  body:JSON.stringify({client_id:process.env.OZON_PERF_CLIENT_ID,client_secret:process.env.OZON_PERF_CLIENT_SECRET,grant_type:'client_credentials'})});
const tj=await tk.json().catch(()=>({}));
console.log('Токен: HTTP',tk.status,tj.access_token?`получен, действует ${tj.expires_in} с`:(tj.error_description||tj.error||tj.message||''));
if(!tj.access_token)process.exit(1);
TOKEN=tj.access_token;

// 2. День сверки — последний день с рекламой в базе (CSV)
let D=process.env.DAY||'';
if(!D){const r=await fetch(`${SB}/rest/v1/ozon_ad_spend?select=spend_date&order=spend_date.desc&limit=1`,{headers:SR});D=(await r.json())[0]?.spend_date;}
console.log('День сверки:',D);

// 3. Кампании
const cr=await perf('/api/client/campaign');
console.log('\n/api/client/campaign: HTTP',cr.status,cr.json?'':String(cr.text).slice(0,150));
const camps=cr.json?.list||[];
if(camps.length){printShape('Устройство кампании:',camps[0]);
  const by={};camps.forEach(c=>{const k=`${c.advObjectType||'?'} / ${c.state||'?'} / ${c.paymentType||c.placement||'?'}`;by[k]=(by[k]||0)+1;});
  console.log('Кампаний',camps.length,'— тип / состояние / оплата:');Object.entries(by).forEach(([k,v])=>console.log('  '+k+': '+v));}

// 4. Расходы за день по кампаниям
for(const path of [`/api/client/statistics/expense?dateFrom=${D}&dateTo=${D}`,`/api/client/statistics/daily?dateFrom=${D}&dateTo=${D}`]){
  const r=await perf(path);console.log(`\n${path.split('?')[0]}: HTTP ${r.status}, ${r.type}`);
  if(r.status===200){const t=r.json?JSON.stringify(r.json):r.text;const lines=String(t).split('\n');console.log('  первая строка (заголовок):',lines[0].slice(0,300));console.log('  строк:',lines.length);}
  else console.log('  ',String(r.text||'').slice(0,200));
}

// 5. Статистика по товарам (SKU) — отчёт по кампаниям за день (асинхронно, до 10 кампаний за запрос)
const db=await (await fetch(`${SB}/rest/v1/ozon_ad_spend?spend_date=eq.${D}&select=offer_id,amount&order=offer_id&limit=5000`,{headers:SR})).json();
const dbSku={};let dbSum=0;db.forEach(x=>{dbSku[x.offer_id]=(dbSku[x.offer_id]||0)+Number(x.amount);dbSum+=Number(x.amount);});
console.log(`\nВ базе (CSV) за день: SKU ${Object.keys(dbSku).length}`);
// только кампании с расходом за день (быстрый метод statistics/expense) — отчёты по SKU Ozon формирует в очереди, все подряд — слишком долго
const ex=await perf(`/api/client/statistics/expense?dateFrom=${D}&dateTo=${D}`);
const spent=new Set();String(ex.text||'').split('\n').slice(1).forEach(l=>{const c=l.split(';');if(c.length>3&&Number(String(c[3]).replace(',','.'))>0)spent.add(String(c[0]).trim());});
const ids=camps.map(c=>String(c.id)).filter(id=>spent.has(id));
console.log(`Кампаний с расходом за день: ${ids.length} из ${camps.length}`);
const apiSku={};let reports=0,fails=0,heads=new Set(),typesSeen={};
for(let i=0;i<ids.length;i+=10){
  const part=ids.slice(i,i+10);
  const r=await perf('/api/client/statistics',{method:'POST',body:{campaigns:part,dateFrom:D,dateTo:D,groupBy:'DATE'}});
  const uuid=r.json?.UUID||r.json?.uuid;
  if(!uuid){fails++;if(fails<3)console.log('  statistics: HTTP',r.status,String(r.text).slice(0,200));continue;}
  let st='';for(let k=0;k<40;k++){await sleep(3000);const s=await perf(`/api/client/statistics/${uuid}`);st=s.json?.state;if(st==='OK'||st==='ERROR')break;}
  if(st!=='OK'){fails++;console.log('  отчёт не готов:',st);continue;}
  const rep=await perf(`/api/client/statistics/report?UUID=${uuid}`,{raw:true});reports++;
  let txt=rep.buf.toString('utf8');
  if(rep.buf[0]===0x50&&rep.buf[1]===0x4b){console.log('  отчёт — ZIP (несколько кампаний), разбираю');
    const {execSync}=await import('node:child_process');const fs=await import('node:fs');fs.writeFileSync('/tmp/rep.zip',rep.buf);execSync('rm -rf /tmp/rep && mkdir -p /tmp/rep && cd /tmp/rep && unzip -o -q ../rep.zip');
    txt=fs.readdirSync('/tmp/rep').map(f=>fs.readFileSync('/tmp/rep/'+f,'utf8')).join('\n');}
  // CSV: строки «;», заголовок содержит «SKU» и «Расход»
  txt.split('\n').forEach(line=>{
    const c=line.split(';');if(c.length<3)return;
    if(c.some(x=>/sku/i.test(x))&&c.some(x=>/расход/i.test(x))){heads.add(c.join(' | ').slice(0,400));return;}
  });
  let hdr=null;
  txt.split('\n').forEach(line=>{const c=line.split(';').map(s=>s.replace(/^"|"$/g,'').trim());
    if(c.some(x=>/^sku$/i.test(x))&&c.some(x=>/расход/i.test(x))){hdr=c;return;}
    if(!hdr||c.length!==hdr.length)return;
    const sku=c[hdr.findIndex(x=>/^sku$/i.test(x))];const amt=Number(String(c[hdr.findIndex(x=>/^расход/i.test(x))]).replace(/\s/g,'').replace(',','.'));
    if(/^\d+$/.test(sku)&&Number.isFinite(amt))apiSku[sku]=(apiSku[sku]||0)+amt;});
}
console.log(`\nОтчётов по кампаниям: ${reports}, не получено: ${fails}`);
console.log('Заголовки отчётов:');[...heads].slice(0,3).forEach(h=>console.log('  '+h));
let same=0,diff=0,onlyA=0,onlyB=0,sa=0;
new Set([...Object.keys(apiSku),...Object.keys(dbSku)]).forEach(k=>{const a=apiSku[k],b=dbSku[k];sa+=a||0;
  if(a==null)onlyB++;else if(b==null)onlyA++;else if(Math.abs(a-b)>0.05)diff++;else same++;});
console.log(`Сверка по SKU за ${D}: итог API ${pct(sa,dbSum)} к CSV; SKU совпало ${same}, другая сумма ${diff}, только в API ${onlyA}, только в CSV ${onlyB}`);
console.log('Готово. В базу ничего не записано.');
