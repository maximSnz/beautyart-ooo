// Telegram-бот администратора (этап 3): сводка владельцу о ночной загрузке и свежести данных.
// MODE=load  — шаг после ozon-daily-load (всегда, даже при падении): итоги шагов из load_summary.txt + свежесть.
// MODE=watch — сторож: упала синхронизация товаров / к утру нет успешной загрузки — тревога; при ручном запуске — полный статус.
// Сообщение уходит только в Telegram (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID); в публичный лог цифры не пишутся.
import fs from 'node:fs';
const SB=process.env.SUPABASE_URL, SR={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
const REPO=process.env.GITHUB_REPOSITORY||'', ENT=/-ooo$/.test(REPO)?'ООО':'ИП';
const MODE=process.env.MODE||'watch', EVENT=process.env.EVENT||'';
const mskDay=iso=>new Date(new Date(iso).getTime()+3*3600e3).toISOString().slice(0,10);
const mskTime=iso=>new Date(new Date(iso).getTime()+3*3600e3).toISOString().slice(11,16);
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const dm=iso=>iso?iso.slice(8,10)+'.'+iso.slice(5,7):'—';
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const TODAY=mskDay(new Date().toISOString()), YEST=addDays(TODAY,-1);

async function lastValue(table,col){
  try{const r=await fetch(`${SB}/rest/v1/${table}?select=${col}&order=${col}.desc.nullslast&limit=1`,{headers:SR,signal:AbortSignal.timeout(30000)});
    if(!r.ok)return null;const j=await r.json();return j[0]?.[col]??null;}catch(e){return null;}
}
// свежесть: заказы/начисления/остатки/маржа/реклама — по вчера (реклама из API с 30.10.2026); спрос — не старше суток
async function freshness(){
  const f=[['заказы','product_sales','sale_date',YEST],['начисления','ozon_charges','charge_date',YEST],['остатки','stock_history','report_date',YEST],
           ['маржа CF','cf_daily','day',YEST],['реклама','ozon_ad_spend','spend_date',YEST]];
  const out=[];let bad=0;
  for(const [name,t,c,need] of f){const v=await lastValue(t,c);const ok=v&&String(v).slice(0,10)>=need;if(!ok)bad++;out.push(`${ok?'':'⚠️'}${name} ${dm(v&&String(v).slice(0,10))}`);}
  const cd=await lastValue('cluster_demand','updated_at');const cdOk=cd&&(Date.now()-new Date(cd).getTime())<26*3600e3;if(!cdOk)bad++;
  out.push(`${cdOk?'':'⚠️'}спрос ${cd?dm(mskDay(cd))+' '+mskTime(cd):'—'}`);
  return {text:out.join(' · '),bad};
}
async function gh(path){
  const r=await fetch(`https://api.github.com/repos/${REPO}/${path}`,{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
  return r.ok?r.json():null;
}
async function send(text){
  const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text,parse_mode:'HTML',disable_web_page_preview:true})});
  console.log('Telegram:',r.ok?'отправлено':'ошибка HTTP '+r.status);
  if(!r.ok)process.exitCode=1;
}

const fr=await freshness();
if(MODE==='load'){
  const st=process.env.STATUS||'unknown', ok=st==='success', write=process.env.WRITE==='1';
  let lines=[];try{lines=fs.readFileSync('load_summary.txt','utf8').split('\n').filter(Boolean);}catch(e){}
  const head=`${ok?'✅':'❌'} <b>${ENT}</b> · ночная загрузка за ${dm(process.env.DAY||YEST)} — ${ok?'готово':st==='cancelled'?'остановлена (время вышло?)':'ОШИБКА'}${write?'':' (режим проверки)'}`;
  const body=lines.map(esc).join('\n')||(ok?'':'итогов шагов нет — упала в самом начале');
  await send(`${head}\n${body}\n\n<i>Свежесть:</i> ${fr.text}\n<a href="${process.env.RUN_URL}">лог запуска</a>`);
}else{
  const alerts=[];
  const sync=(await gh('actions/workflows/ozon-products-sync.yml/runs?per_page=1'))?.workflow_runs?.[0];
  const load=(await gh('actions/workflows/ozon-daily-load.yml/runs?per_page=10'))?.workflow_runs||[];
  const okToday=load.find(r=>r.conclusion==='success'&&mskDay(r.created_at)===TODAY&&r.event==='workflow_run');
  if(sync&&sync.status==='completed'&&sync.conclusion!=='success'&&mskDay(sync.created_at)===TODAY)alerts.push(`❌ синхронизация товаров упала (${mskTime(sync.created_at)} Мск) — ночная загрузка не запускалась. <a href="${sync.html_url}">лог</a>`);
  if(!okToday&&EVENT!=='workflow_run')alerts.push(`❌ сегодня нет успешной ночной загрузки${load[0]?` — последняя: ${dm(mskDay(load[0].created_at))} ${mskTime(load[0].created_at)}, ${load[0].conclusion||load[0].status}`:''}`);
  if(fr.bad&&EVENT!=='workflow_run')alerts.push(`⚠️ устаревшие данные: ${fr.text}`);
  if(alerts.length)await send(`<b>${ENT}</b> · сторож\n${alerts.join('\n')}`);
  else if(EVENT==='workflow_dispatch')await send(`🟢 <b>${ENT}</b> · сторож: всё в порядке\nсинхронизация ${sync?dm(mskDay(sync.created_at))+' '+mskTime(sync.created_at)+' '+(sync.conclusion||sync.status):'—'} · загрузка ${okToday?'сегодня ✅':'—'}\n<i>Свежесть:</i> ${fr.text}`);
  else console.log('Сторож: тревог нет, сообщение не отправлено');
}
