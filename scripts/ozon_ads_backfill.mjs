// Разовая догрузка рекламы из Ozon Performance API в ozon_ad_spend — дни, которых нет в базе (после последнего дня с рекламой)
// по вчера включительно, или дни из DAYS (через запятую). Пишет ТОЛЬКО в ozon_ad_spend; маржу CF пересчитает ночная загрузка.
// Логика выборки — как шаг 5б scripts/ozon_daily_load.mjs (отчёты по SKU только по кампаниям с расходом, по 10 за запрос).
import fs from 'node:fs';
const PERF='https://api-performance.ozon.ru';
const SB=process.env.SUPABASE_URL, SR={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mskDay=iso=>new Date(new Date(iso).getTime()+3*3600e3).toISOString().slice(0,10);
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const YEST=addDays(mskDay(new Date().toISOString()),-1);
let PT='';
async function perf(path,{method='GET',body,raw}={}){for(let a=0;a<5;a++){let r,t;
    try{r=await fetch(PERF+path,{method,headers:{Authorization:'Bearer '+PT,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
      t=raw?Buffer.from(await r.arrayBuffer()):await r.text();}catch(e){await sleep(2000*(a+1));continue;}
    if(r.status===429||r.status>=500){await sleep(3000*(a+1));continue;}
    if(r.status!==200)throw new Error(`Performance ${path.split('?')[0]}: HTTP ${r.status}`);
    return raw?t:(()=>{try{return JSON.parse(t);}catch(e){return t;}})();}
  throw new Error(`Performance ${path.split('?')[0]}: нет ответа`);}
async function sbWrite(method,path,rows){
  const r=await fetch(`${SB}/rest/v1/${path}`,{method,headers:{...SR,'Content-Type':'application/json',Prefer:method==='POST'?'resolution=merge-duplicates,return=minimal':'return=minimal'},body:rows?JSON.stringify(rows):undefined});
  if(!r.ok)throw new Error(`Supabase ${method} ${path.split('?')[0]}: HTTP ${r.status} ${(await r.text()).slice(0,200)}`);
}
let days=(process.env.DAYS||'').split(',').map(s=>s.trim()).filter(Boolean);
if(!days.length){
  const last=(await (await fetch(`${SB}/rest/v1/ozon_ad_spend?select=spend_date&order=spend_date.desc&limit=1`,{headers:SR})).json())[0]?.spend_date;
  for(let d=last?addDays(last,1):YEST;d<=YEST;d=addDays(d,1))days.push(d);
}
console.log('Дни для догрузки:',days.length?days.join(', '):'нет — реклама в базе уже по вчера');
if(!days.length)process.exit(0);
const tk=await (await fetch(PERF+'/api/client/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.OZON_PERF_CLIENT_ID,client_secret:process.env.OZON_PERF_CLIENT_SECRET,grant_type:'client_credentials'})})).json();
if(!tk.access_token)throw new Error('Performance: токен не получен');
PT=tk.access_token;
const isoOf=v=>{v=String(v).trim();let m=v.match(/^(\d{2})\.(\d{2})\.(\d{4})/);if(m)return `${m[3]}-${m[2]}-${m[1]}`;m=v.match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[0]:null;};
const from=days[0],to=days[days.length-1];
const ex=await perf(`/api/client/statistics/expense?dateFrom=${from}&dateTo=${to}`);
const spent=new Set();String(ex).split('\n').slice(1).forEach(l=>{const c=l.split(';');if(c.length>3&&Number(String(c[3]).replace(',','.'))>0)spent.add(String(c[0]).trim());});
const ids=[...spent],sum=new Map();
for(let i=0;i<ids.length;i+=10){
  const r=await perf('/api/client/statistics',{method:'POST',body:{campaigns:ids.slice(i,i+10),dateFrom:from,dateTo:to,groupBy:'DATE'}});
  const uuid=r.UUID||r.uuid;if(!uuid)throw new Error('Performance: отчёт не заказан');
  let st='';for(let k=0;k<100&&st!=='OK';k++){await sleep(3000);st=(await perf(`/api/client/statistics/${uuid}`)).state;if(st==='ERROR')throw new Error('Performance: отчёт с ошибкой');}
  if(st!=='OK')throw new Error('Performance: отчёт не готов за 5 минут');
  const buf=await perf(`/api/client/statistics/report?UUID=${uuid}`,{raw:true});
  let txt=buf.toString('utf8');
  if(buf[0]===0x50&&buf[1]===0x4b){const {execSync}=await import('node:child_process');fs.writeFileSync('/tmp/ads.zip',buf);
    execSync('rm -rf /tmp/ads && mkdir -p /tmp/ads && cd /tmp/ads && unzip -o -q ../ads.zip');txt=fs.readdirSync('/tmp/ads').map(f=>fs.readFileSync('/tmp/ads/'+f,'utf8')).join('\n');}
  let hdr=null;
  txt.split('\n').forEach(line=>{const c=line.split(';').map(x=>x.replace(/^"|"$/g,'').trim());
    if(c.some(x=>/^sku$/i.test(x))&&c.some(x=>/^расход/i.test(x))){hdr=c;return;}
    if(!hdr||c.length!==hdr.length)return;
    const sku=c[hdr.findIndex(x=>/^sku$/i.test(x))],day=isoOf(c[hdr.findIndex(x=>/^(день|дата)$/i.test(x))]),amt=Number(String(c[hdr.findIndex(x=>/^расход/i.test(x))]).replace(/\s/g,'').replace(',','.'));
    if(/^\d+$/.test(sku)&&days.includes(day)&&Number.isFinite(amt)){const k=sku+'|'+day;sum.set(k,(sum.get(k)||0)+amt);}});
  console.log(`  отчёт ${i/10+1} из ${Math.ceil(ids.length/10)}`);
}
for(const d of days){
  const rows=[];sum.forEach((v,k)=>{const [offer_id,spend_date]=k.split('|');if(spend_date===d&&Math.abs(v)>=0.005)rows.push({offer_id,spend_date,amount:Math.round(v*100)/100,updated_at:new Date().toISOString()});});
  await sbWrite('DELETE',`ozon_ad_spend?spend_date=eq.${d}`);if(rows.length)await sbWrite('POST','ozon_ad_spend?on_conflict=offer_id,spend_date',rows);
  console.log(`${d}: записано SKU ${rows.length}`);
}
console.log('Готово. Маржу CF с этой рекламой пересчитает ночная загрузка.');
