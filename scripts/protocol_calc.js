// «Протокол работ» — общий расчёт списка позиций (03.11.2026, решение владельца: план дня фиксирует ночная загрузка).
// Один код для главной (beautyart-home/index.html) и ночной загрузки (scripts/ozon_daily_load.mjs, шаг 9 — копии этого файла
// в beautyart/scripts и beautyart-ooo/scripts; правка логики — здесь, затем скопировать в оба репозитория, как need_calc.js).
// Только чтение базы. Даты — локальные (браузер — свой часовой пояс, загрузка передаёт день по Москве строкой).
// Правила — CLAUDE.md, 5.13.
(function(root){
const DROP_PCT=15,DROP_QTY=5;                       // просадка: заказы А ниже Б на ≥ 15% и ≥ 5 шт (% — округлённый до целого)
const DEEP_PCT=15,PRICE_TOL=10,DEEP_DAYS=3,DEEP_LO=0.7,DEEP_HI=1.3;   // глубокая аналитика: окно 3 дня
const DAY_MIN={ip:{wd:3100000,we:2500000},ooo:{wd:100000,we:70000}};  // корпоративный минимум выручки в день, ₽ (будни / выходные)
const UNDER=0.7, NET_FLOOR=5, STOCK_DAYS=4, HRANK={late:0,none:1,moved:2,hyp:3};
const addDays=(d,n)=>{const r=new Date(d);r.setDate(r.getDate()+n);return r;};
const keyOf=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dateOf=k=>{const [y,m,d]=k.split('-').map(Number);return new Date(y,m-1,d);};
const isWe=d=>d.getDay()===0||d.getDay()===6;
function effDays(y,m){const last=new Date(y,m,0).getDate();let B=0,W=0;for(let dd=1;dd<=last;dd++){const wd=new Date(y,m-1,dd).getDay();if(wd===0||wd===6)W++;else B++;}return B+0.7*W;}
// перчатки: группа = артикул до цвета включительно (GLV-NIT-BNV-BLU-50-L → GLV-NIT-BNV-BLU)
const GLV_COLORS=new Set(['BLK','BLU','PNK','GRY','YLW','PUR','CLR','WHT','GRN','RED','ORG','BRN','BEG']);
function gloveFamily(offer){const s=String(offer).split('-');if(s[0]!=='GLV')return null;
  for(let i=2;i<s.length;i++)if(GLV_COLORS.has(s[i]))return i<s.length-1?s.slice(0,i+1).join('-'):null;return null;}
// лимиты ДРР при цене P — копия unitPct из plan.html при ДРР 0: pre(P) = (r0 − комиссия(P)) − t − u ÷ (P × b);
// плановый = max(0, (pre − план) × b), безубыточный = max(0, (pre − 5) × b)
function lim(c,P){if(!c||!(P>0)||!(c.b>0))return null;const pre=((c.r0-(P<=300?c.lo:c.hi))-c.t-c.u/(P*c.b))*100;return {price:P,pre,be:Math.max(0,(pre-NET_FLOOR)*c.b),plan:c.plan==null?null:Math.max(0,(pre-c.plan)*c.b)};}
// просадка: среднее за период А против среднего за период Б (индексы дней; по умолчанию А = вчера)
function dropAt(u,ib,ia){const A=ia==null?[u.ord.length-1]:[].concat(ia),B=[].concat(ib),av=(a,ix)=>ix.reduce((s,i)=>s+(a[i]||0),0)/ix.length;
  u.cur=av(u.ord,A);u.revC=av(u.rev,A);u.prev=av(u.ord,B);u.revP=av(u.rev,B);u.dropQ=u.prev-u.cur;u.dropPct=u.prev>0?u.dropQ/u.prev*100:null;
  u.drop=u.dropQ>=DROP_QTY&&Math.round(u.dropPct)>=DROP_PCT;}
// день сравнения по умолчанию: ближайший день того же типа перед вчера (будний — будний, пн → пт; выходной — выходной)
function defB(yKey){const yD=dateOf(yKey),t=isWe(yD);let d=addDays(yD,-1);while(isWe(d)!==t)d=addDays(d,-1);return keyOf(d);}
// показатели позиции (товар или группа перчаток) — из сумм её рядов
function evalUnit(u,C){
  const sum=(a,ix)=>ix.reduce((s,i)=>s+(a[i]||0),0),I7=C.i7;
  u.q7=sum(u.ord,I7);u.r7=sum(u.rev,I7);u.qPlan7=u.plan7.reduce((s,x)=>s+x,0);
  u.price7=u.q7>0?u.r7/u.q7:null;u.planPrice=u.planQ>0?u.planRev/u.planQ:0;u.planPct=u.planRevPct>0?u.planMarW/u.planRevPct:null;
  u.drr7=u.r7>0?u.a7/u.r7*100:(u.a7>0?Infinity:0);
  u.marCF=u.cfRevn>0?u.cfMar/u.cfRevn*100:null;u.mar=u.marCF!=null?u.marCF:u.planPct;
  u.ordDev7=u.qPlan7>0?(u.q7-u.qPlan7)/u.qPlan7*100:null;
  // просадка заказов; план дня — вчерашний (выходной × 0,7)
  u.yest=u.ord[C.iy]||0;u.planY=u.plan7[u.plan7.length-1]||0;
  u.revY=u.rev[C.iy]||0;u.planRY=u.planR7[u.planR7.length-1]||0;u.planR7s=u.planR7.reduce((s,x)=>s+x,0);
  dropAt(u,C.ip);
  // ДРР вчера = реклама вчера ÷ выручка PNL вчера; лимиты — от цены дня (нет заказов — средняя за 7 дн, нет — плановая)
  u.drrY=u.revY>0?u.aY/u.revY*100:(u.aY>0?Infinity:null);
  if(u.coef)u.limY=lim(u.coef,u.yest>0?u.revY/u.yest:(u.price7||u.planPrice));
  u.drrState=null;u.drrRub=0;
  if(u.lim){const be=u.lim.drr_be,tp=u.lim.drr_plan;
    u.drrState=u.drr7>be?'red':(tp!=null&&u.drr7>tp?'yellow':(tp!=null&&u.drr7<tp*UNDER&&u.q7<u.qPlan7?'under':null));
    u.drrRub=u.drrState==='under'?(tp-u.drr7)/100*u.r7:(u.drrState?(u.drr7-(u.drrState==='red'?be:tp))/100*u.r7:0);}
  // наличие — последний снимок (Σ по складам) ≥ план месяца ÷ дней месяца × STOCK_DAYS
  u.stockNow=C.lastI>=0?(u.stock[C.lastI]||0):null;u.stockNeed=C.lastI>=0?(u.need[C.lastI]||0):null;
  u.oos=u.stockNow!=null&&!(u.stockNow>0&&u.stockNow>=u.stockNeed);
  u.perDay=u.stockNeed!=null?u.stockNeed/STOCK_DAYS:null;u.stockDays=u.perDay>0?u.stockNow/u.perDay:null;
  // глубокая аналитика — окно DEEP_DAYS последних дней
  const W3=C.i7.slice(-DEEP_DAYS),n3=DEEP_DAYS,t3=a=>a.slice(-n3).reduce((s,x)=>s+(x||0),0);
  u.q3=sum(u.ord,W3);u.r3=sum(u.rev,W3);u.a3=t3(u.ad7);u.qPlan3=t3(u.plan7);u.price3=u.q3>0?u.r3/u.q3:null;
  u.drr3=u.r3>0?u.a3/u.r3*100:(u.a3>0?Infinity:0);u.ordDev3=u.qPlan3>0?(u.q3-u.qPlan3)/u.qPlan3*100:null;
  if(u.coef)u.lim3=lim(u.coef,u.price3||u.price7||u.planPrice);
  const stock3=u.stock.every((st,i)=>i<7-n3||!C.hasSnap[i]||(st>0&&st>=u.need[i]));
  u.priceOk=u.price3!=null&&u.planPrice>0&&Math.abs(u.price3/u.planPrice-1)*100<=PRICE_TOL;
  u.adsOk=!!(u.lim3&&u.lim3.plan!=null&&u.drr3>=u.lim3.plan*DEEP_LO&&u.drr3<=u.lim3.plan*DEEP_HI&&u.drr3<=u.lim3.be);
  u.deep=u.priceOk&&u.adsOk&&stock3&&u.ordDev3!=null&&u.ordDev3<=-DEEP_PCT;
  u.deepLost=u.deep&&u.mar!=null?(u.qPlan3-u.q3)*u.price3*u.mar/100*0.95:null;
  return u;
}
// пополнения — правило ▲ plan.html: последний снимок остатков (не позже вчера) против снимка не позже чем за 2 дня до него, рост > 10% плана
async function restockInfo(api,yKey,PLAN,mk,products){
  const map=new Map();
  try{
    const r1=await api.one(`stock_history?report_date=lte.${yKey}&select=report_date&order=report_date.desc&limit=1`);
    const last=(r1[0]||{}).report_date;if(!last)return {ok:true,map};
    const [ly,lm,ld]=last.split('-').map(Number),pd=keyOf(new Date(ly,lm-1,ld-2));
    const r2=await api.one(`stock_history?report_date=lte.${pd}&select=report_date&order=report_date.desc&limit=1`);
    const prev=(r2[0]||{}).report_date;if(!prev)return {ok:true,map};
    const sum=rows=>{const m=new Map();rows.forEach(x=>m.set(x.offer_id,(m.get(x.offer_id)||0)+Number(x.stock||0)));return m;};
    const [a,b]=await Promise.all([api.all(`stock_history?report_date=eq.${last}&select=offer_id,stock&order=id`),api.all(`stock_history?report_date=eq.${prev}&select=offer_id,stock&order=id`)]);
    const now=sum(a),before=sum(b);
    products.forEach(p=>{const pl=PLAN[mk+'|'+p.product_id],q=pl?Number(pl.plan_qty||0):0;const n=now.get(p.offer_id)||0,bf=before.get(p.offer_id)||0,d=n-bf;
      map.set(String(p.product_id),{before:bf,now:n,d,plan:q,up:q>0&&d>0.1*q,last,prev});});
    return {ok:true,map};
  }catch(e){return {ok:false,map,err:e.message};}
}
async function pool(keys,f){const out=new Array(keys.length);let i=0;await Promise.all([0,1,2,3,4,5].map(async()=>{while(i<keys.length){const k=i++;out[k]=await f(keys[k]);}}));return out;}
// загрузка и расчёт позиций. api: {all(path) — все строки постранично, one(path) — один запрос}; today — 'YYYY-MM-DD' (день протокола,
// данные — за вчера); m1 — RegExp менеджера m1 (matrixOf юрлица); bKey — день сравнения Б (нет — по умолчанию defB)
async function load(api,{today,m1,bKey}){
  const tD=dateOf(today),yD=addDays(tD,-1),yKey=keyOf(yD),todayKey=today,mk=yKey.slice(0,7),matrixOf=o=>m1.test(o)?'m1':'m2';
  const days=[];for(let i=34;i>=0;i--)days.push(keyOf(addDays(yD,-i)));   // 35 дней
  const cur7=days.slice(-7);
  const curMon=addDays(tD,-((tD.getDay()+6)%7)),wkKey=keyOf(addDays(curMon,-7));  // последняя закрытая неделя (маржинальность CF)
  const months=[...new Set(cur7.map(k=>k.slice(0,7)).concat(mk))];
  const [prodAll,plans,salesDays,ads,spw,hyp,ppm,stockDays,limDay]=await Promise.all([
    api.one(`products?select=product_id,offer_id,archived,raw&limit=1000`),
    api.one(`sales_plan?month=in.(${months.join(',')})&select=month,product_id,plan_qty,price,margin_pct&limit=5000`),
    pool(days,k=>api.all(`product_sales?sale_date=eq.${k}&select=offer_id,qty,revenue&order=id`)),
    api.all(`ozon_ad_spend?spend_date=gte.${cur7[0]}&spend_date=lte.${yKey}&select=offer_id,spend_date,amount&order=offer_id,spend_date`),
    api.all(`sales_plan_weeks?week=eq.${wkKey}&metric=in.(mar,revn)&select=product_id,metric,fact&order=id`),
    api.all('product_protocol?parent_id=is.null&deadline=not.is.null&select=id,product_id,action,deadline,created_at,metric,target_orders,target_pct,baseline_ctx,fact_ctx,baseline_dev,target_dev,fact_dev&order=id').then(r=>({ok:true,rows:r})).catch(e=>({ok:false,err:e.message,rows:[]})),
    api.all('product_plan_meta?work_date=not.is.null&select=product_id,month,work_date&order=product_id,month').catch(()=>[]),
    pool(cur7,k=>api.all(`stock_history?report_date=eq.${k}&stock=gt.0&select=offer_id,stock&order=id`)),
    api.one(`product_drr_limits?day=lte.${todayKey}&select=day&order=day.desc&limit=1`).catch(()=>null)
  ]);
  // лимиты ДРР — последний день расчёта ночной загрузки (не позже дня протокола)
  const limKey=limDay&&limDay[0]?limDay[0].day:null;
  const LIM=new Map();if(limKey)(await api.all(`product_drr_limits?day=eq.${limKey}&select=product_id,price,pre_pct,plan_pct,drr_plan,drr_be,b,r0,comm_low,comm_high,t,u&order=product_id`)).forEach(x=>LIM.set(String(x.product_id),x));
  const products=prodAll.filter(p=>!p.archived);
  const SKU_PID={},OFFER_PID={};products.forEach(p=>{OFFER_PID[p.offer_id]=p.product_id;const s=p.raw&&p.raw.sku!=null?String(p.raw.sku):'';if(s)SKU_PID[s]=p.product_id;});
  const PLAN={};plans.forEach(r=>{PLAN[r.month+'|'+r.product_id]=r;});
  const restock=await restockInfo(api,yKey,PLAN,mk,products);
  const DI=new Map(days.map((k,i)=>[k,i]));
  const ord=new Map(),rev=new Map(),arr=(m,o)=>{let a=m.get(o);if(!a){a=new Array(days.length).fill(0);m.set(o,a);}return a;};
  salesDays.forEach((rows,i)=>rows.forEach(x=>{arr(ord,x.offer_id)[i]+=Number(x.qty||0);arr(rev,x.offer_id)[i]+=Number(x.revenue||0);}));
  const adv=new Map(),advY=new Map(),advD=new Map();ads.forEach(x=>{const pid=SKU_PID[x.offer_id]||OFFER_PID[x.offer_id];if(!pid)return;{const i=cur7.indexOf(x.spend_date);if(i>=0){let a=advD.get(pid);if(!a){a=new Array(7).fill(0);advD.set(pid,a);}a[i]+=Number(x.amount||0);}}adv.set(pid,(adv.get(pid)||0)+Number(x.amount||0));if(x.spend_date===yKey)advY.set(pid,(advY.get(pid)||0)+Number(x.amount||0));});
  const cf=new Map();spw.forEach(x=>{if(x.fact==null)return;const c=cf.get(x.product_id)||{mar:0,revn:0};c[x.metric]+=Number(x.fact);cf.set(x.product_id,c);});
  const hy=new Map();hyp.rows.forEach(r=>{const k=String(r.product_id),c=hy.get(k);if(!c||r.deadline>c.deadline||(r.deadline===c.deadline&&r.created_at>c.created_at))hy.set(k,r);});
  const WD=new Map();ppm.forEach(x=>{const k=String(x.product_id);if(!WD.has(k)||x.work_date>WD.get(k))WD.set(k,x.work_date);});
  const hasSnap=cur7.map((k,i)=>stockDays[i].length>0),stock=new Map();
  stockDays.forEach((rows,i)=>rows.forEach(x=>{let a=stock.get(x.offer_id);if(!a){a=new Array(7).fill(0);stock.set(x.offer_id,a);}a[i]+=Number(x.stock||0);}));
  const pDef=defB(yKey),pKey=bKey&&DI.has(bKey)&&bKey<yKey?bKey:pDef;
  const C={i7:cur7.map(k=>DI.get(k)),iy:DI.get(yKey),ip:DI.get(pKey),hasSnap,lastI:hasSnap.lastIndexOf(true)};
  const planDay=(pid,k)=>{const pl=PLAN[k.slice(0,7)+'|'+pid];if(!pl||!(Number(pl.plan_qty)>0))return 0;const [y,m,d]=k.split('-').map(Number);const e=effDays(y,m);return e>0?Number(pl.plan_qty)/e*(isWe(new Date(y,m-1,d))?0.7:1):0;};
  const zeros=n=>new Array(n).fill(0);
  const units=[];
  products.forEach(p=>{
    const pid=p.product_id,o=p.offer_id,pl=PLAN[mk+'|'+pid];
    if(!pl||!(Number(pl.plan_qty)>0))return;                                  // товары с планом на месяц вчерашнего дня
    const q=Number(pl.plan_qty),pp=Number(pl.price||0),pct=pl.margin_pct!=null?Number(pl.margin_pct):null,c=cf.get(pid),L=LIM.get(String(pid));
    const st=stock.get(o)||zeros(7);
    const u={pid,offer:o,mgr:matrixOf(o),ord:ord.get(o)||zeros(days.length),rev:rev.get(o)||zeros(days.length),a7:adv.get(pid)||0,
      plan7:cur7.map(k=>planDay(pid,k)),planR7:cur7.map(k=>{const pk=PLAN[k.slice(0,7)+'|'+pid];return planDay(pid,k)*(pk?Number(pk.price||0):0);}),planQ:q,planRev:q*pp,planRevPct:pct!=null?q*pp:0,planMarW:pct!=null?q*pp*pct:0,
      cfMar:c?c.mar:0,cfRevn:c?c.revn:0,lim:L?{drr_plan:L.drr_plan!=null?Number(L.drr_plan):null,drr_be:Number(L.drr_be)}:null,aY:advY.get(pid)||0,ad7:advD.get(pid)||zeros(7),
      coef:L&&L.b!=null?{b:+L.b,r0:+L.r0,lo:+L.comm_low,hi:+L.comm_high,t:+L.t,u:+L.u,plan:L.plan_pct!=null?+L.plan_pct:null}:null,stock:st,
      need:cur7.map(k=>{const pk=PLAN[k.slice(0,7)+'|'+pid]||pl;return Number(pk.plan_qty||0)/new Date(+k.slice(0,4),+k.slice(5,7),0).getDate()*STOCK_DAYS;})};
    // гипотезы: срок товара — позднее из срока контроля последней гипотезы и «даты работы» plan.html
    const h=hy.get(String(pid)),wd=WD.get(String(pid))||null;u.hypo=h||null;u.wd=wd;
    const due=[h&&h.deadline,wd].filter(Boolean).sort().pop()||null;u.due=due;u.dueToday=due===todayKey;
    u.hState=h&&h.deadline>=todayKey?'hyp':(wd&&wd>=todayKey?'moved':(due?'late':'none'));
    // поступления: ▲ (рост > 10% плана месяца) или снова в наличии (остаток дотянул до нормы наличия) после нуля в последние 7 дн
    u.rs=restock.map.get(String(pid))||null;
    const lastI=hasSnap.lastIndexOf(true);let z=-1;for(let i=0;i<lastI;i++)if(hasSnap[i]&&!(st[i]>0))z=i;
    u.afterZero=z>=0&&st[lastI]>0&&st[lastI]>=u.need[lastI]?cur7[z]:null;u.restock=!!(u.rs&&u.rs.up)||!!u.afterZero;
    units.push(evalUnit(u,C));
  });
  // перчатки — одна позиция на производителя и цвет (от 2 товаров с планом): ряды и план — суммы
  const fam=new Map(),out=[];
  units.forEach(u=>{const k=gloveFamily(u.offer);if(!k){out.push(u);return;}if(!fam.has(k))fam.set(k,[]);fam.get(k).push(u);});
  fam.forEach((ms,k)=>{
    if(ms.length<2){out.push(...ms);return;}
    const sA=f=>ms[0][f].map((_,i)=>ms.reduce((s,m)=>s+(m[f][i]||0),0)),sN=f=>ms.reduce((s,m)=>s+(m[f]||0),0);
    const g={fam:k,offer:k,pid:'f:'+k,members:ms,mgr:ms[0].mgr,ord:sA('ord'),rev:sA('rev'),plan7:sA('plan7'),planR7:sA('planR7'),ad7:sA('ad7'),stock:sA('stock'),need:sA('need')};
    ['a7','aY','planQ','planRev','planRevPct','planMarW','cfMar','cfRevn'].forEach(f=>g[f]=sN(f));
    // лимиты вчерашнего дня у группы — по размерам, взвешенные выручкой вчера (нет — планом дня)
    {const wm=ms.filter(m=>m.limY),wv=m=>m.revY>0?m.revY:0,WV=wm.reduce((s,m)=>s+wv(m),0),ww=m=>WV>0?wv(m):m.planRY,WW=wm.reduce((s,m)=>s+ww(m),0),wpm=wm.filter(m=>m.limY.plan!=null),WPM=wpm.reduce((s,m)=>s+ww(m),0);
     g.limY=wm.length&&WW>0?{be:wm.reduce((s,m)=>s+m.limY.be*ww(m),0)/WW,plan:WPM>0?wpm.reduce((s,m)=>s+m.limY.plan*ww(m),0)/WPM:null,price:null}:null;}
    // лимиты группы — средние по размерам с лимитами, взвешенные выручкой 7 дн (нет выручки — плановой)
    const wl=ms.filter(m=>m.lim),w=m=>m.r7>0?m.r7:0,W=wl.reduce((s,m)=>s+w(m),0),wt=m=>W>0?w(m):m.planRev,WT=wl.reduce((s,m)=>s+wt(m),0);
    const wp=wl.filter(m=>m.lim.drr_plan!=null),WP=wp.reduce((s,m)=>s+wt(m),0);
    g.lim=wl.length&&WT>0?{drr_be:wl.reduce((s,m)=>s+m.lim.drr_be*wt(m),0)/WT,drr_plan:WP>0?wp.reduce((s,m)=>s+m.lim.drr_plan*wt(m),0)/WP:null}:null;
    {const wm=ms.filter(m=>m.lim3),wv=m=>m.r3>0?m.r3:0,WV=wm.reduce((s,m)=>s+wv(m),0),ww=m=>WV>0?wv(m):m.planRY,WW=wm.reduce((s,m)=>s+ww(m),0),wpm=wm.filter(m=>m.lim3.plan!=null),WPM=wpm.reduce((s,m)=>s+ww(m),0);
     g.lim3=wm.length&&WW>0?{be:wm.reduce((s,m)=>s+m.lim3.be*ww(m),0)/WW,plan:WPM>0?wpm.reduce((s,m)=>s+m.lim3.plan*ww(m),0)/WPM:null,price:null}:null;}
    // гипотезы — по размерам: у группы худшее состояние; поступления — если есть у любого размера
    g.hState=ms.reduce((a,m)=>HRANK[m.hState]<HRANK[a]?m.hState:a,'hyp');g.dueToday=ms.some(m=>m.dueToday);
    g.due=ms.map(m=>m.due).filter(Boolean).sort()[0]||null;
    g.restock=ms.some(m=>m.restock);g.afterZero=ms.map(m=>m.afterZero).filter(Boolean).sort().pop()||null;
    const rs=ms.map(m=>m.rs).filter(Boolean);g.rs=rs.length?{before:rs.reduce((s,x)=>s+x.before,0),now:rs.reduce((s,x)=>s+x.now,0),d:rs.reduce((s,x)=>s+x.d,0),plan:rs.reduce((s,x)=>s+x.plan,0),up:rs.some(x=>x.up)}:null;
    out.push(evalUnit(g,C));
  });
  // выручка юрлица вчера — все товары (и без плана)
  const revAllY=salesDays[C.iy].reduce((s,x)=>s+Number(x.revenue||0),0);
  const SKU_OF={};Object.entries(SKU_PID).forEach(([sku,pid])=>{SKU_OF[pid]=sku;});
  return {days,cur7,yKey,todayKey,pKey,pDef,yWe:isWe(yD),revAllY,rows:out,limKey,SKU_OF,hypOk:hyp.ok,hypErr:hyp.err,restockOk:restock.ok};
}
const posKey=r=>r.fam?'f:'+r.fam:String(r.pid);
const pot=r=>Math.max(0,r.planRY-r.revY), below=r=>r.revY<r.planRY, redY=r=>!!(r.limY&&r.drrY!=null&&r.drrY>r.limY.be);
// добор до корпоративного минимума: просевшие ниже плана дня засчитываются недобором к плану; дальше — позиции без просадки
// ниже плана дня по потенциалу, пока Σ не закроет разницу «минимум − выручка юрлица вчера» (не в наличии — в сумму не идут)
function gapSel(P,ent){
  const dMin=DAY_MIN[ent]?DAY_MIN[ent][P.yWe?'we':'wd']:null,gap=dMin?dMin-P.revAllY:P.rows.reduce((s,r)=>s+r.planRY-r.revY,0);
  let got=P.rows.filter(r=>r.drop&&below(r)).reduce((s,r)=>s+(r.oos?0:pot(r)),0);
  const sel=[];for(const r of P.rows.filter(r=>!r.drop&&below(r)).sort((a,b)=>pot(b)-pot(a))){if(got>=gap)break;sel.push(r);if(!r.oos)got+=pot(r);}
  return {dMin,gap,sel};
}
// план дня — позиции списка хотя бы по одной причине, в наличии (по всему юрлицу); причины — коды для таблицы плана
function work(P,ent){
  const {gap,dMin,sel}=gapSel(P,ent),selS=new Set(gap>0?sel:[]);
  const why=r=>[r.drop&&'drop',selS.has(r)&&'gap',redY(r)&&'drr',r.deep&&'deep',r.hState!=='hyp'&&'hyp',r.restock&&'restock'].filter(Boolean);
  const list=P.rows.filter(r=>!r.oos&&why(r).length);
  return {list,why,gap,dMin,keys:new Set(list.map(posKey)),counts:{all:list.length,m1:list.filter(r=>r.mgr==='m1').length,m2:list.filter(r=>r.mgr==='m2').length}};
}
// цифры причин на день фиксации (03.11.2026) — для разбора ячейки в «📊 Статистике»: вчера к плану, остаток и по каждой причине
const rd=(x,n)=>x==null||!isFinite(x)?(x===Infinity?'inf':null):Math.round(x*10**n)/10**n;
function info(P,W,r){const o={yest:rd(r.yest,1),planY:rd(r.planY,1),revY:rd(r.revY,0),planRY:rd(r.planRY,0),stock:rd(r.stockNow,0),need:rd(r.stockNeed,0)};
  const w=W.why(r);
  if(w.includes('drop'))o.drop={cur:rd(r.cur,1),prev:rd(r.prev,1),revC:rd(r.revC,0),revP:rd(r.revP,0),pct:rd(r.dropPct,1)};
  if(w.includes('gap'))o.gap={pot:rd(pot(r),0),gap:rd(W.gap,0),min:W.dMin,revAll:rd(P.revAllY,0)};
  if(w.includes('drr')||r.limY)o.drr={drr:rd(r.drrY,1),ads:rd(r.aY,0),price:r.limY&&r.limY.price?rd(r.limY.price,0):null,plan:r.limY?rd(r.limY.plan,1):null,be:r.limY?rd(r.limY.be,1):null};
  if(w.includes('deep'))o.deep={q3:rd(r.q3,1),qPlan3:rd(r.qPlan3,1),dev:rd(r.ordDev3,1),price3:rd(r.price3,0),planPrice:rd(r.planPrice,0),drr3:rd(r.drr3,1),plan:r.lim3?rd(r.lim3.plan,1):null,be:r.lim3?rd(r.lim3.be,1):null,days:DEEP_DAYS};
  if(w.includes('hyp'))o.hyp={state:r.hState,due:r.due||null,deadline:r.hypo?r.hypo.deadline:null,action:r.hypo?String(r.hypo.action||'').slice(0,200):null,wd:r.wd||null,
    sizes:r.members?r.members.filter(m=>m.hState!=='hyp').map(m=>[m.offer,m.hState]):undefined};
  if(w.includes('restock'))o.restock={before:r.rs?rd(r.rs.before,0):null,now:r.rs?rd(r.rs.now,0):null,afterZero:r.afterZero||null,days:rd(r.stockDays,1)};
  return o;}
// строки таблицы product_protocol_plan за день протокола
function planRows(P,W,src){return W.list.map(r=>({day:P.todayKey,pos_key:posKey(r),product_id:r.fam?null:r.pid,offer_id:r.offer,mgr:r.mgr,reasons:W.why(r).join(','),y_day:P.yKey,cmp_day:P.pKey,src,info:info(P,W,r)}));}
// маржа товара за день по дате заказа (03.11.2026, «Позиции по дням» — разница маржи соседних дней) — как окно товара (prItem) и «Рука на
// пульсе»: созревшие дни (≤ сегодня − 8) — факт (pnl − себестоимость на дату − 3% × выручка P − реклама дня) ÷ по начислениям ozon_charges_by_event;
// свежие — оценка модели при цене и ДРР дня (pre(P) − ДРР ÷ b) × выручка × b; нет заказов — минус реклама дня. По товарам с планом,
// размеры перчаток — отдельно (группа = сумма на странице). Дни — P.days (35). Начисления — по неделям, не больше 3 запросов одновременно
const TAX=0.03;
async function marginDays(api,P){
  const units=[];P.rows.forEach(r=>r.members?units.push(...r.members):units.push(r));
  const days=P.days,from=days[0],to=days[days.length-1],matureTo=keyOf(addDays(dateOf(P.todayKey),-8));
  const prices=await api.all(`product_prices?product_id=in.(${units.map(u=>u.pid).join(',')})&select=product_id,cost,created_at&order=created_at.asc,product_id.asc`);
  const CH={};prices.forEach(x=>{(CH[x.product_id]=CH[x.product_id]||[]).push({t:String(x.created_at||'').slice(0,10),c:Number(x.cost||0)});});
  const costAt=(pid,d)=>{const a=CH[pid];if(!a||!a.length)return 0;let b=null;for(const r of a){if(r.t<=d)b=r;else break;}return (b||a[0]).c;};
  const ads=await api.all(`ozon_ad_spend?spend_date=gte.${from}&spend_date=lte.${to}&select=offer_id,spend_date,amount&order=offer_id,spend_date`);
  const KEY=new Map();units.forEach(u=>{if(P.SKU_OF[u.pid])KEY.set(String(P.SKU_OF[u.pid]),u.pid);KEY.set(u.offer,u.pid);});
  const AD=new Map();ads.forEach(x=>{const pid=KEY.get(String(x.offer_id));if(!pid)return;const k=pid+'|'+x.spend_date;AD.set(k,(AD.get(k)||0)+Number(x.amount||0));});
  const wk=[];for(let i=0;i<days.length;i+=7)wk.push([days[i],days[Math.min(i+6,days.length-1)]]);
  const jobs=[];units.forEach(u=>wk.forEach(w=>jobs.push([u,w])));
  const G=new Map();let ji=0;
  const get=async q=>{for(let a=0;;a++){try{return await api.all(q);}catch(e){if(a>=2)throw e;await new Promise(r=>setTimeout(r,800*(a+1)));}}};
  await Promise.all([0,1,2].map(async()=>{while(ji<jobs.length){const [u,[f,t]]=jobs[ji++];
    (await get(`ozon_charges_by_event?offer_id=eq.${encodeURIComponent(u.offer)}&event_date=gte.${f}&event_date=lte.${t}&select=event_date,charge_type,amount,qty,gmv&order=event_date,charge_type`)).forEach(c=>{
      const k=u.pid+'|'+c.event_date;let g=G.get(k);if(!g){g={gmv:0,sales:0,pnl:0,revP:0};G.set(k,g);}
      const amt=Number(c.amount||0),q=Number(c.qty||0),gv=Number(c.gmv||0);g.pnl+=amt;
      if(c.charge_type==='Выручка'){g.gmv+=gv;g.sales+=q;g.revP+=amt;}else if(c.charge_type==='Возврат выручки'){g.gmv+=gv;g.sales-=q;g.revP+=amt;}});}}));
  const r2=x=>x==null?null:Math.round(x*100)/100,out=[];
  units.forEach(u=>days.forEach((d,i)=>{
    const r=u.rev[i]||0,q=u.ord[i]||0,a=AD.get(u.pid+'|'+d)||0,g=G.get(u.pid+'|'+d);let mar=null,gmv=null,est=false;
    const fact=()=>{mar=g.pnl-costAt(u.pid,d)*g.sales-TAX*g.revP-a;gmv=g.gmv;};
    if(d<=matureTo){if(g&&g.gmv>0)fact();else if(q===0){mar=-a;gmv=0;}}
    else{const L=u.coef&&q>0&&r>0?lim(u.coef,r/q):null;
      if(L){const pct=L.pre-(a/r*100)/u.coef.b;mar=pct/100*r*u.coef.b;gmv=r*u.coef.b;est=true;}
      else if(g&&g.gmv>0){fact();est=true;}else if(q===0){mar=-a;gmv=0;est=true;}}
    out.push({product_id:u.pid,day:d,mar:r2(mar),gmv:r2(gmv),rev:r2(r),est});}));
  return out;
}
root.PROTO={load,work,planRows,marginDays,gapSel,evalUnit,dropAt,lim,defB,posKey,pot,below,redY,gloveFamily,
  DROP_PCT,DROP_QTY,DEEP_PCT,PRICE_TOL,DEEP_DAYS,DEEP_LO,DEEP_HI,DAY_MIN,UNDER,NET_FLOOR,STOCK_DAYS,HRANK};
})(typeof window!=='undefined'?window:globalThis);
