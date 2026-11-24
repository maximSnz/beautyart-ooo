// Расчёт потребности месяца — общий для need.html и purchase.html (в каждом репозитории своя копия; WB — wb-need.html, wb-purchase.html).
// С 20.11.2026 (решения владельца) потребность считается по правилам недельной заявки — это ожидаемая сумма недельных заявок
// за ISO-недели месяца (неделя относится к месяцу своего четверга; ноябрь 2026 — 02.11–29.11):
//   по каждому кластеру: ВВЕРХ((продажи + запас на конец − запас на начало) ÷ в коробе), не меньше 0; потребность = Σ кластеров;
//   продажи      — план ISO-месяца × доля кластера; план дня = план своего календарного месяца ÷ его эфф. дни (выходной × 0,7);
//   доля         — спрос кластера за 28 дней (ads_cluster) ÷ спрос товара по разрешённым кластерам;
//   запас на конец — план следующих D дней × доля, D = срок поставки + страховой запас кластера (как цель недельной заявки);
//   запас на начало — max(сейчас − продажи до начала ISO-месяца, цель на начало: план первых D дней × доля);
//                  сейчас = остаток + в пути на Ozon + две последние недельные заявки (распределено, иначе заявлено).
// Повышение спроса (группа / товар, 0…100%) умножает план. Сроки, запреты кластеров, повышение и исключённые товары —
// настройки месяца (purchase_need_months: lead_times, demand_boost, excluded_products), фиксируются вместе с потребностью.
// «Заказ» в черновике идёт за расчётом, ручная правка сохраняется. После отправки закупщику — сохранённые строки purchase_needs.
// До 20.11.2026: план календарного месяца + план ÷ дней × дни оборачиваемости − остаток и в пути − две заявки + продажи до конца
// месяца — такие снимки показываются в тех же столбцах (запас на начало = остаток + заявки − продажи до конца месяца).
const NEED_DEFAULT_TURNOVER=9;
const NEED_LT_F=['force_majeure_days','approval_days','supplier_to_ff_days','ff_assembly_days','ff_to_ozon_days','acceptance_days'];
const needCov=c=>NEED_LT_F.reduce((s,f)=>s+(Number(c?.[f])||0),0);
const needDays=c=>needCov(c)+(Number(c?.target_days)||0);
const needDaysIn=ym=>{const[y,m]=ym.split('-').map(Number);return new Date(y,m,0).getDate();};
const nIso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const nDate=s=>{const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);};
const nAdd=(s,n)=>{const d=nDate(s);d.setDate(d.getDate()+n);return nIso(d);};
const nAddM=(ym,n)=>{const[y,m]=ym.split('-').map(Number);const d=new Date(y,m-1+n,1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;};
const nDdmm=s=>s.slice(8,10)+'.'+s.slice(5,7);
// ISO-недели месяца: понедельники, у которых четверг в этом месяце
function needIso(month){
  const [y,m]=month.split('-').map(Number), d1=new Date(y,m-1,1);
  let w=nIso(new Date(y,m-1,1-((d1.getDay()+6)%7)));
  if(nAdd(w,3).slice(0,7)!==month) w=nAdd(w,7);
  const weeks=[]; while(nAdd(w,3).slice(0,7)===month){ weeks.push(w); w=nAdd(w,7); }
  return {weeks,from:weeks[0],to:nAdd(weeks[weeks.length-1],6)};
}
// дней от даты данных Ozon до дня start (сам день данных и день start не считаются)
function needDaysTo(demAt,start){
  if(!demAt) return 0;
  const d=new Date(demAt), d0=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  return Math.max(0,Math.round((nDate(start)-d0)/864e5)-1);
}
const needEff=m=>{let e=0;for(let d=m+'-01';d.slice(0,7)===m;d=nAdd(d,1)){const w=nDate(d).getDay();e+=w===0||w===6?0.7:1;}return e;};
// план дня товара: план своего месяца ÷ эфф. дни × вес дня; месяц, на который план ещё не поставлен ни одному товару, — план последнего
// месяца с планом (иначе цель запаса на конец обнулялась бы до постановки плана следующего месяца)
function needPlanFn(plans){
  const eff={}, months=Object.keys(plans).filter(m=>Object.keys(plans[m]).length).sort();
  const src=m=>plans[m]&&Object.keys(plans[m]).length?m:months.filter(x=>x<m).pop()||null;
  const day=(id,d)=>{ const m=src(d.slice(0,7)); if(!m) return 0; const q=plans[m][id]||0; if(!q) return 0; const w=nDate(d).getDay(); return q/(eff[m]??=needEff(m))*(w===0||w===6?0.7:1); };
  return {day,sum:(id,a,n)=>{let s=0;for(let i=0,d=a;i<n;i++,d=nAdd(d,1)) s+=day(id,d);return s;},carried:m=>src(m)!==m&&!!src(m)};
}
// настройки месяца: свои, иначе сроки и исключения — последнего месяца с ними, иначе справочник кластеров заявки; повышение — только своё
function needSettings(monthsDb,month,seedLt){
  const own=monthsDb[month]||{}, prev=Object.keys(monthsDb).filter(x=>x<month).sort().reverse();
  const pick=f=>own[f]!=null?{v:own[f],src:'month'}:(()=>{const p=prev.find(x=>monthsDb[x][f]!=null);return p?{v:monthsDb[p][f],src:'copy:'+p}:null;})();
  const lt=pick('lead_times'), ex=pick('excluded_products');
  const seed={}; (seedLt||[]).forEach(c=>{ seed[c.cluster]={...Object.fromEntries(NEED_LT_F.map(f=>[f,Number(c[f])||0])),target_days:Number(c.target_days)||0,blocked:!!c.blocked}; });
  return {lt:lt?JSON.parse(JSON.stringify(lt.v)):seed, ltSrc:lt?lt.src:'seed', boost:{...(own.demand_boost||{})}, excl:new Set((ex?.v||[]).map(Number))};
}
// prod — товары (с grp); dem[pid] = {кластер: {ads, av, tr}}; req[pid] = {кластер: короба двух последних заявок}; plans = {месяц: {pid: план}};
// needs[pid] — строка purchase_needs; set — needSettings; live — потребность в черновике (или не создана)
function needBuild({prod,dem,demAt,plans,needs,req,set,cost,month,live}){
  const iso=needIso(month), nDays=Math.round((nDate(iso.to)-nDate(iso.from))/864e5)+1, dts=needDaysTo(demAt,iso.from), P=needPlanFn(plans);
  const lt=set.lt, ok=c=>!lt[c]?.blocked, ds=Object.keys(lt).filter(c=>ok(c)).map(c=>needDays(lt[c])).filter(x=>x>0), Davg=ds.length?Math.round(ds.reduce((a,b)=>a+b,0)/ds.length):0;
  const boostOf=p=>{const v=set.boost['p:'+p.product_id];return Number(v!=null?v:set.boost[p.grp])||0;};
  return prod.filter(p=>!(live&&set.excl.has(p.product_id))).map(p=>{
    const id=p.product_id, n=needs[id], base={iso,ag:n?.agreed_boxes??null,comment:n?.comment||'',cost:cost?.[id]??null};
    if(!(p.box_qty>0)) return {...p,...base,nobox:true,plan:live?(plans[month]?.[id]??null):(n?.plan_qty??null),planIso:null,tEnd:null,start:null,calc:null,manual:false,need:0,rows:[]};
    if(!live){
      const legacy=n?.plan_iso==null, pl=n?.plan_qty??null;
      if(legacy){ const turn=pl==null?null:pl/needDaysIn(month)*(set.turn??NEED_DEFAULT_TURNOVER), sell=(Number(n?.ads)||0)*(n?.days_to_eom||0);
        return {...p,...base,legacy:true,plan:pl,planIso:pl,tEnd:turn,stock:n?.stock_qty??null,reqQty:n?.requests_qty??null,sell,dts:n?.days_to_eom??null,start:n?(Number(n.stock_qty)||0)+(Number(n.requests_qty)||0)-sell:null,tStart:null,calc:n?.calc_boxes==null?null:Number(n.calc_boxes),need:n?.need_boxes??0,boost:0,rows:[],cost:n?.unit_cost==null?base.cost:Number(n.unit_cost)}; }
      return {...p,...base,plan:pl,planIso:Number(n.plan_iso),tEnd:Number(n.target_end),tStart:n.target_start==null?null:Number(n.target_start),stock:n.stock_qty,reqQty:n.requests_qty,sell:Number(n.sell_to_start)||0,dts:n.days_to_eom,start:Number(n.start_qty),calc:n.calc_boxes==null?null:Number(n.calc_boxes),need:n.need_boxes??0,boost:Number(n.boost)||0,rows:[],cost:n.unit_cost==null?base.cost:Number(n.unit_cost)};
    }
    const b=boostOf(p), k=1+b/100, dm=dem[id]||{}, rq=req[id]||{};
    const cls=[...new Set([...Object.keys(dm),...Object.keys(rq)])].filter(ok);
    const adsT=cls.reduce((s,c)=>s+(Number(dm[c]?.ads)||0),0);
    const planIso=P.sum(id,iso.from,nDays)*k, nod=!(adsT>0);
    const parts=nod?[{c:null,sh:1,ads:0,now:cls.reduce((s,c)=>s+(dm[c]?.av||0)+(dm[c]?.tr||0)+(rq[c]||0)*p.box_qty,0),D:Davg}]
      :cls.map(c=>({c,sh:(Number(dm[c]?.ads)||0)/adsT,ads:Number(dm[c]?.ads)||0,now:(dm[c]?.av||0)+(dm[c]?.tr||0)+(rq[c]||0)*p.box_qty,D:lt[c]?needDays(lt[c]):Davg}));
    const rows=parts.map(x=>{ const S=planIso*x.sh, tEnd=P.sum(id,nAdd(iso.to,1),x.D)*k*x.sh, tSt=P.sum(id,iso.from,x.D)*k*x.sh, sell=x.ads*dts;
      const start=dts>0?Math.max(x.now-sell,tSt):x.now, raw=S+tEnd-start; return {...x,S,tEnd,tSt,sell,start,raw,box:Math.max(0,Math.ceil(raw/p.box_qty-1e-9))}; });
    const T=f=>rows.reduce((s,r)=>s+r[f],0), calc=T('box');
    const stock=cls.reduce((s,c)=>s+(dm[c]?.av||0)+(dm[c]?.tr||0),0), reqQty=cls.reduce((s,c)=>s+(rq[c]||0),0)*p.box_qty;
    // ручная правка: сохранённый заказ не равен сохранённому расчёту (старые черновики — и не равен ему, округлённому вверх / до ближайшего)
    const scb=n?.calc_boxes==null?null:Number(n.calc_boxes), manual=n?.need_boxes!=null&&!(scb!=null&&(n.need_boxes===Math.ceil(scb-1e-9)||n.need_boxes===Math.round(scb)));
    return {...p,...base,plan:plans[month]?.[id]??null,planIso,tEnd:T('tEnd'),tStart:T('tSt'),stock,reqQty,sell:T('sell'),dts,start:T('start'),calc,manual,need:manual?n.need_boxes:calc,boost:b,nodem:nod,carried:P.carried(nAddM(month,1)),rows,ads:adsT};
  });
}
// группы товаров для повышения спроса — как в заявке и «Сводном отчёте»: свои группы по артикулу, иначе категория Ozon
const NEED_GRP_BY_OFFER=[[/^WIPE-/,'Салфетки хлопковые'],[/^GLV-NIT-/,'Перчатки нитриловые'],[/^GLV-VIN-/,'Перчатки виниловые'],[/^GLV-ELM-/,'Перчатки эластомерные'],[/^GLV-LAT-/,'Перчатки латексные']];
const NEED_GRP_MERGE={'Маска косметическая':'Маски косметические и медицинские','Маска медицинская':'Маски косметические и медицинские'};
function needGrpOf(p,CAT){ const r=NEED_GRP_BY_OFFER.find(([re])=>re.test(p.offer_id||'')); if(r) return r[1]; const c=p.type_id?(CAT[p.type_id]||'Категория '+p.type_id):'Без категории'; return NEED_GRP_MERGE[c]||c; }
// загрузка всех данных потребности месяца из базы (url, hd — база и заголовки со входом); возвращает контекст для needBuild
async function needLoad(url,hd,month){
  const get=async path=>{ let out=[],off=0; for(;;){ const r=await fetch(url+path+(path.includes('?')?'&':'?')+`limit=1000&offset=${off}`,{headers:hd}); if(!r.ok) throw new Error(path.split('?')[0].replace('/rest/v1/','')+' HTTP '+r.status); const j=await r.json(); out=out.concat(j); if(j.length<1000) break; off+=1000; } return out; };
  const pm=[...new Set([needIso(month).from.slice(0,7),month,nAddM(month,1),nAddM(month,2),nAddM(month,3)])];
  const [pr,dm,ms,wk,lt,pl,nd]=await Promise.all([
    get('/rest/v1/products?select=product_id,offer_id,name,supplier,box_qty,archived,type_id:raw->>type_id,sku:raw->>sku&order=product_id'),
    get('/rest/v1/cluster_demand?select=product_id,cluster,ads_cluster,available,transit,updated_at&order=product_id,cluster'),
    get('/rest/v1/purchase_need_months?select=*&order=month'),
    get('/rest/v1/purchase_weeks?select=week,status&order=week.desc'),
    get('/rest/v1/cluster_lead_times?select=*&order=cluster'),
    get(`/rest/v1/sales_plan?select=month,product_id,plan_qty&month=in.(${pm.map(m=>'"'+m+'"').join(',')})&order=month,product_id`),
    get(`/rest/v1/purchase_needs?select=*&month=eq.${month}&order=product_id`)
  ]);
  const dem={}; let demAt='';
  dm.forEach(d=>{ if(d.updated_at>demAt) demAt=d.updated_at; (dem[d.product_id]=dem[d.product_id]||{})[d.cluster]={ads:Number(d.ads_cluster)||0,av:d.available||0,tr:d.transit||0}; });
  const monthsDb={}; ms.forEach(m=>monthsDb[m.month]=m);
  const reqWeeks=wk.slice(0,2).map(w=>w.week), req={};
  if(reqWeeks.length) (await get(`/rest/v1/purchase_lines?select=week,product_id,cluster,requested_boxes,distributed_boxes&week=in.(${reqWeeks.join(',')})&order=week,product_id,cluster`)).forEach(l=>{ const o=req[l.product_id]=req[l.product_id]||{}; o[l.cluster]=(o[l.cluster]||0)+((l.distributed_boxes??l.requested_boxes)||0); });
  const plans={}; pm.forEach(m=>plans[m]={}); pl.forEach(x=>{ if(x.plan_qty>0) plans[x.month][x.product_id]=Number(x.plan_qty); });
  const needs={}; nd.forEach(n=>needs[n.product_id]=n);
  const prod=pr.filter(p=>!p.archived);
  try{
    const CAT={}; (await get('/rest/v1/market_category_daily?select=category_id,category&order=category_id,day')).forEach(x=>{ if(x.category) CAT[String(x.category_id)]=x.category; });
    const skus=[...new Set(prod.filter(p=>p.type_id&&!CAT[p.type_id]&&p.sku).map(p=>p.sku))];
    if(skus.length) (await get(`/rest/v1/market_report?select=sku,category&sku=in.(${skus.join(',')})&order=report_date,category,sku`)).forEach(x=>{ const p=prod.find(q=>String(q.sku)===String(x.sku)); if(p&&!CAT[p.type_id]) CAT[p.type_id]=x.category; });
    prod.forEach(p=>p.grp=needGrpOf(p,CAT));
  }catch(e){ prod.forEach(p=>p.grp=needGrpOf(p,{})); }
  const status=monthsDb[month]?.status||null;
  return {prod,dem,demAt,plans,needs,req,reqWeeks,monthsDb,seedLt:lt,month,status,live:!status||status==='draft'};
}
// потребность месяца любой базы (заявка — черновик потребности; перенос ИП + ООО в Excel): {model, status}
async function needFetch(url,hd,month){
  const ctx=await needLoad(url,hd,month), set=needSettings(ctx.monthsDb,month,ctx.seedLt);
  set.turn=ctx.monthsDb[month]?.turnover_days;
  return {model:needBuild({...ctx,set,cost:{}}),status:ctx.status};
}
// ===== WB (только ИП; 20.11.2026): та же формула по WB в целом — одна «строка кластера» «Россия», строка — размер (chrt_id; в модели — product_id).
// Спрос = заказы «Ленты заказов» за 28 дн (с отменами и заграницей) ÷ 28; остаток = склады WB (последний снимок, без «В пути…») + в поставках
// (не принято); заявки — две последние недели WB (распределено по СЦ, иначе заявлено); план — wb_sales_plan (карты Шухарта WB);
// сроки — справочник wb_lead_times (как у недельной заявки WB); группы — по артикулу продавца, иначе предмет WB.
const NEED_WB='Россия';
async function needLoadWB(url,hd,month){
  const get=async path=>{ let out=[],off=0; for(;;){ const r=await fetch(url+path+(path.includes('?')?'&':'?')+`limit=1000&offset=${off}`,{headers:hd}); if(!r.ok) throw new Error(path.split('?')[0].replace('/rest/v1/','')+' HTTP '+r.status); const j=await r.json(); out=out.concat(j); if(j.length<1000) break; off+=1000; } return out; };
  const msk=n=>new Date(Date.now()+3*36e5+n*864e5).toISOString().slice(0,10), DD=28, TRANSIT=new Set([2,3,4,6]), PSEUDO=/^В пути/;
  const last=await get('/rest/v1/wb_stock_history?select=report_date&order=report_date.desc&limit=1'), snap=last[0]?.report_date||null;
  const pm=[...new Set([needIso(month).from.slice(0,7),month,nAddM(month,1),nAddM(month,2),nAddM(month,3)])];
  const [pr,st,od,sp,sg,ms,wk,lt,pl,nd]=await Promise.all([
    get('/rest/v1/wb_products?select=chrt_id,vendor_code,tech_size,title,subject,supplier,box_qty,archived,wb_archived,wb_trash&order=chrt_id'),
    snap?get(`/rest/v1/wb_stock_history?select=barcode,warehouse_name,chrt_id,qty&report_date=eq.${snap}&order=barcode,warehouse_name`):[],
    get(`/rest/v1/wb_orders?select=srid,chrt_id&source=eq.feed&order_day=gte.${msk(-DD)}&order_day=lte.${msk(-1)}&order=srid`),
    get('/rest/v1/wb_supplies?select=supply_id,status_id&order=supply_id'),
    get('/rest/v1/wb_supply_goods?select=supply_id,barcode,chrt_id,quantity,accepted_quantity&order=supply_id,barcode'),
    get('/rest/v1/wb_purchase_need_months?select=*&order=month'),
    get('/rest/v1/wb_purchase_weeks?select=week,status&order=week.desc'),
    get(`/rest/v1/wb_lead_times?select=*&region=eq.${encodeURIComponent(NEED_WB)}`),
    get(`/rest/v1/wb_sales_plan?select=month,chrt_id,plan_qty&month=in.(${pm.map(m=>'"'+m+'"').join(',')})&order=month,chrt_id`),
    get(`/rest/v1/wb_purchase_needs?select=*&month=eq.${month}&order=chrt_id`)
  ]);
  const offerOf=p=>{const sz=String(p.tech_size||'').trim();return String(p.vendor_code||p.chrt_id)+(sz&&sz!=='0'?' · '+sz:'');};
  const grp=p=>{ const r=NEED_GRP_BY_OFFER.find(([re])=>re.test(p.vendor_code||'')); if(r) return r[1]; const c=p.subject||'Без категории'; return NEED_GRP_MERGE[c]||c; };
  const prod=pr.filter(p=>!p.archived&&!p.wb_archived&&!p.wb_trash).map(p=>({product_id:p.chrt_id,offer_id:offerOf(p),name:p.title||'',supplier:p.supplier,box_qty:p.box_qty,grp:grp(p),m:'m1'}));
  const dem={}, D=id=>(dem[id]=dem[id]||{[NEED_WB]:{ads:0,av:0,tr:0}})[NEED_WB];
  st.forEach(x=>{ if(x.chrt_id==null||PSEUDO.test(x.warehouse_name)) return; D(x.chrt_id).av+=x.qty; });
  od.forEach(x=>{ if(x.chrt_id!=null) D(x.chrt_id).ads+=1/DD; });
  const live=new Set(sp.filter(x=>TRANSIT.has(x.status_id)).map(x=>x.supply_id));
  sg.forEach(g=>{ if(!live.has(g.supply_id)||g.chrt_id==null) return; D(g.chrt_id).tr+=Math.max(0,(g.quantity||0)-(g.accepted_quantity||0)); });
  // дата данных — день снимка остатков + 1 (снимок за вчера снимается ночью сегодня)
  const demAt=snap?new Date(new Date(snap+'T00:00').getTime()+864e5).toISOString():'';
  const reqWeeks=wk.slice(0,2).map(w=>w.week), req={};
  if(reqWeeks.length){
    const [ln,ds]=await Promise.all([get(`/rest/v1/wb_purchase_lines?select=week,chrt_id,requested_boxes&week=in.(${reqWeeks.join(',')})&order=week,chrt_id`),
      get(`/rest/v1/wb_purchase_dist?select=week,chrt_id,sc,boxes&week=in.(${reqWeeks.join(',')})&order=week,chrt_id,sc`)]);
    const dist={}; ds.forEach(d=>{ const k=d.week+'|'+d.chrt_id; dist[k]=(dist[k]||0)+(d.boxes||0); });
    const add=(id,v)=>{ const o=req[id]=req[id]||{}; o[NEED_WB]=(o[NEED_WB]||0)+v; }, seen=new Set();
    ln.forEach(l=>{ const k=l.week+'|'+l.chrt_id; seen.add(k); add(l.chrt_id,k in dist?dist[k]:(l.requested_boxes||0)); });
    Object.entries(dist).forEach(([k,v])=>{ if(!seen.has(k)) add(Number(k.split('|')[1]),v); });
  }
  const plans={}; pm.forEach(m=>plans[m]={}); pl.forEach(x=>{ if(x.plan_qty>0) plans[x.month][x.chrt_id]=Number(x.plan_qty); });
  const needs={}; nd.forEach(n=>needs[n.chrt_id]=n);
  const monthsDb={}; ms.forEach(m=>monthsDb[m.month]=m);
  const seedLt=lt.map(r=>({...r,cluster:NEED_WB,blocked:false}));
  const status=monthsDb[month]?.status||null;
  return {prod,dem,demAt,plans,needs,req,reqWeeks,monthsDb,seedLt,month,status,live:!status||status==='draft'};
}
async function needFetchWB(url,hd,month){
  const ctx=await needLoadWB(url,hd,month), set=needSettings(ctx.monthsDb,month,ctx.seedLt);
  set.turn=ctx.monthsDb[month]?.turnover_days;
  return {model:needBuild({...ctx,set,cost:{}}),status:ctx.status};
}
