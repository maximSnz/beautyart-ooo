// Расчёт потребности месяца — общий для need.html и purchase.html (вынесен из need.html 27.10.2026, формула без изменений).
// Потребность = план (в заказах) + план ÷ дней месяца × дни оборачиваемости − остаток и в пути на Ozon − две последние
// недельные заявки + продажи до конца текущего месяца; ÷ в коробе; «Заказ» в черновике — расчёт, округлённый вверх,
// ручная правка сохраняется. После отправки закупщику — сохранённые строки purchase_needs.
const NEED_DEFAULT_TURNOVER=9;
const needDaysIn=ym=>{const[y,m]=ym.split('-').map(Number);return new Date(y,m,0).getDate();};
// дни оборачиваемости месяца: свои, иначе — последнего предыдущего месяца, иначе по умолчанию
function needTurnover(monthsDb,month){
  const m=monthsDb[month]; if(m) return {turn:m.turnover_days,src:'month'};
  const prev=Object.keys(monthsDb).filter(x=>x<month).sort().pop();
  return prev?{turn:monthsDb[prev].turnover_days,src:'copy:'+prev}:{turn:NEED_DEFAULT_TURNOVER,src:'default'};
}
// дней до конца месяца, предшествующего плановому: от даты данных Ozon (сам день не считается)
function needDaysToEom(demAt,month){
  if(!demAt) return 0;
  const d=new Date(demAt), d0=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const [y,m]=month.split('-').map(Number), start=new Date(y,m-1,1);
  return Math.max(0,Math.round((start-d0)/864e5)-1);
}
// prod — неархивные товары (без «в коробе» — без расчёта); dem[pid] = {ads, stock}; plan[pid] = plan_qty; needs[pid] — строка purchase_needs;
// req[pid] — короба двух последних недельных заявок; cost[pid] — себестоимость; live — потребность в черновике (или не создана)
// Показываются все товары (27.10.2026): без плана — «нет плана», заказ 0; без «в коробе» (nobox) — без расчёта, заказ 0.
function needBuild({prod,dem,demAt,plan,needs,turn,req,cost,month,live}){
  const dte=needDaysToEom(demAt,month);
  return prod.map(p=>{
    const n=needs[p.product_id];
    if(!(p.box_qty>0)) return {...p,nobox:true,plan:live?(plan[p.product_id]??null):(n?.plan_qty??null),turnover:null,stock:null,reqQty:null,ads:null,dte,sell:null,calc:null,manual:false,need:0,cost:cost[p.product_id]??null,ag:n?.agreed_boxes??null,comment:n?.comment||''};
    let r;
    if(live){
      const pl=plan[p.product_id]??null, dm=dem[p.product_id]||{ads:0,stock:0};
      const reqQty=(req[p.product_id]||0)*p.box_qty, sell=dm.ads*dte;
      const turnover=pl==null?null:pl/needDaysIn(month)*turn;
      const D=pl==null?null:pl+turnover-dm.stock-reqQty+sell;
      const calc=D==null?null:Math.round(Math.max(D,0)/p.box_qty*100)/100;
      // заказ в черновике идёт за расчётом, округлённым ВВЕРХ (решение 21.10.2026); ручная правка — сохранённый заказ
      // не равен расчёту на момент сохранения ни вверх, ни по прежнему правилу (до ближайшего)
      const up=x=>Math.ceil(x-1e-9), auto=calc==null?0:Math.max(0,up(calc)), scb=n?.calc_boxes==null?null:Number(n.calc_boxes);
      const manual=n?.need_boxes!=null&&!(scb!=null&&(n.need_boxes===up(scb)||n.need_boxes===Math.round(scb)));
      r={plan:pl,turnover,stock:dm.stock,reqQty,ads:dm.ads,dte,sell,calc,manual,need:manual?n.need_boxes:auto,cost:cost[p.product_id]??null};
    }else{
      const pl=n?.plan_qty??null, turnover=pl==null?null:pl/needDaysIn(month)*turn, sell=(Number(n?.ads)||0)*(n?.days_to_eom||0);
      r={plan:pl,turnover,stock:n?.stock_qty??null,reqQty:n?.requests_qty??null,ads:n?.ads??null,dte:n?.days_to_eom??null,sell,calc:n?.calc_boxes==null?null:Number(n.calc_boxes),need:n?.need_boxes??0,cost:n?.unit_cost==null?(cost[p.product_id]??null):Number(n.unit_cost)};
    }
    return {...p,...r,ag:n?.agreed_boxes??null,comment:n?.comment||''};
  });
}
// Потребность месяца любой базы (27.10.2026; для переноса ИП + ООО в Excel «Потребность на месяц»): те же данные, что
// загружает need.html (без себестоимости), и needBuild. Возвращает {model, status}. url/hd — база и заголовки со входом.
async function needFetch(url,hd,month){
  const get=async path=>{ let out=[],off=0; for(;;){ const r=await fetch(url+path+(path.includes('?')?'&':'?')+`limit=1000&offset=${off}`,{headers:hd}); if(!r.ok) throw new Error(path.split('?')[0].replace('/rest/v1/','')+' HTTP '+r.status); const j=await r.json(); out=out.concat(j); if(j.length<1000) break; off+=1000; } return out; };
  const [pr,dm,ms,wk,lt,pl,nd]=await Promise.all([
    get('/rest/v1/products?select=product_id,offer_id,name,supplier,box_qty,archived&order=product_id'),
    get('/rest/v1/cluster_demand?select=product_id,cluster,ads_cluster,available,transit,updated_at&order=product_id,cluster'),
    get('/rest/v1/purchase_need_months?select=*&order=month'),
    get('/rest/v1/purchase_weeks?select=week,status&order=week.desc'),
    get('/rest/v1/cluster_lead_times?select=*&order=cluster'),
    get(`/rest/v1/sales_plan?select=product_id,plan_qty&month=eq.${month}&order=product_id`),
    get(`/rest/v1/purchase_needs?select=*&month=eq.${month}&order=product_id`)
  ]);
  const blocked=new Set(lt.filter(c=>c.blocked).map(c=>c.cluster));
  const dem={}; let demAt='';
  dm.forEach(d=>{ if(d.updated_at>demAt) demAt=d.updated_at; if(blocked.has(d.cluster)) return; const o=dem[d.product_id]||(dem[d.product_id]={ads:0,stock:0}); o.ads+=Number(d.ads_cluster)||0; o.stock+=(d.available||0)+(d.transit||0); });
  const mdb={}; ms.forEach(m=>mdb[m.month]=m);
  const rw=wk.slice(0,2).map(w=>w.week), req={};
  if(rw.length) (await get(`/rest/v1/purchase_lines?select=week,product_id,cluster,requested_boxes,distributed_boxes&week=in.(${rw.join(',')})&order=week,product_id,cluster`)).forEach(l=>{ if(blocked.has(l.cluster)) return; req[l.product_id]=(req[l.product_id]||0)+((l.distributed_boxes??l.requested_boxes)||0); });
  const plan={}; pl.forEach(x=>{ if(x.plan_qty>0) plan[x.product_id]=x.plan_qty; });
  const needs={}; nd.forEach(n=>needs[n.product_id]=n);
  const status=mdb[month]?.status||null;
  const model=needBuild({prod:pr.filter(p=>!p.archived),dem,demAt,plan,needs,turn:needTurnover(mdb,month).turn,req,cost:{},month,live:!status||status==='draft'});
  return {model,status};
}
