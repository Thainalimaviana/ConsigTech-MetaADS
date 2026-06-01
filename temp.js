
// ── Estado global ─────────────────────────────────────────────
let allCampaigns=[],currentFilter='active',_sortCol='spend',_sortAsc=false;
window._loaded=false;
let _settingsDirty=false;

// ── Startup ───────────────────────────────────────────────────
// Aplica tema salvo
(function(){
  const saved = localStorage.getItem('ct_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

async function initApp(){
  // Corrige ícone de tema
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const ti = document.getElementById('themeIcon');
  if(ti) ti.textContent = dark ? 'light_mode' : 'dark_mode';

  try{
    const r = await fetch('/api/settings');
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const s = await r.json();
    const ai = document.getElementById('accountId');
    const at = document.getElementById('accessToken');
    if(ai && s.account_id) ai.value = s.account_id;
    if(at){
      if(s.has_token) at.value = '••••••••••••••••';
      at.placeholder = s.has_token ? `Token salvo (${s.token_preview})` : 'Cole seu Access Token';
    }
    // Só carrega dados se tiver credenciais configuradas
    if(s.account_id && s.has_token) loadData();
    else {
      // Exibe dica para ir às configurações
      console.info('Sem credenciais. Configure em Configurações ou via env vars no Render.');
    }
  }catch(e){
    console.warn('initApp error:', e.message);
  }
}
initApp();

function markDirty(){
  _settingsDirty=true;
  document.getElementById('saveBtn').style.display='';
}

async function saveSettings(){
  const acct=document.getElementById('accountId').value.trim();
  const tok=document.getElementById('accessToken').value.trim();
  if(!acct){ showErr('Informe o ID da conta.'); return; }
  const body={account_id:acct};
  if(tok && tok!=='••••••••••••••••') body.access_token=tok;
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  _settingsDirty=false;
  document.getElementById('saveBtn').style.display='none';
  document.getElementById('accessToken').value='••••••••••••••••';
  showErr('');
  loadData();
}

// ── Tema ─────────────────────────────────────────────────────
function toggleTheme(){
  const h=document.documentElement,dark=h.getAttribute('data-theme')==='dark';
  const next=dark?'light':'dark';
  h.setAttribute('data-theme',next);
  localStorage.setItem('ct_theme',next);
  document.getElementById('themeIcon').textContent=dark?'dark_mode':'light_mode';
  // Atualiza cor dos charts
  if(window._loaded) renderCharts();
}

// ── Navigation ────────────────────────────────────────────────
const titles={dashboard:'Visão Geral',campanhas:'Campanhas',analytics:'Analytics',diagnostico:'Diagnóstico',ia:'Análise com IA',config:'Configurações'};
function navTo(page,btn){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  if(btn)btn.classList.add('active');
  document.getElementById('topTitle').textContent=titles[page]||page;
  closeSidebar();
  if(page==='analytics'&&window._loaded)renderCharts();
}
function openSidebar(){document.getElementById('sidebar').classList.add('open');document.getElementById('sideOverlay').classList.add('show');}
function closeSidebar(){document.getElementById('sidebar').classList.remove('open');document.getElementById('sideOverlay').classList.remove('show');}

// ── Formatters ────────────────────────────────────────────────
const R=(n,s='R$')=>{if(n===null||n===undefined||isNaN(n))return'—';return s+parseFloat(n).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});};
const N=(n)=>{if(!n&&n!==0)return'—';return parseFloat(n).toLocaleString('pt-BR');};
const K=(n)=>{if(!n&&n!==0)return'—';const v=parseFloat(n);if(v>=1e6)return(v/1e6).toFixed(1)+'M';if(v>=1e3)return(v/1e3).toFixed(1)+'k';return v.toLocaleString('pt-BR');};
const dpLbl=(d)=>({today:'Hoje',last_7d:'Últimos 7 dias',last_30d:'Últimos 30 dias',last_90d:'Últimos 90 dias',this_month:'Este mês',last_month:'Mês passado'}[d]||d);

// ── Lead helpers ──────────────────────────────────────────────
const LEAD_TYPES=['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead','onsite_conversion.messaging_first_reply','contact_total','offsite_conversion.custom.lead','onsite_web_lead'];
const getLeads=(ins)=>{
  if(!ins?.actions)return 0;
  return ins.actions.filter(a=>LEAD_TYPES.some(t=>a.action_type===t||a.action_type.includes('lead'))).reduce((s,a)=>s+parseFloat(a.value||0),0);
};

// ── Score de performance ──────────────────────────────────────
function calcScore(c){
  const ins=c.ins;
  if(!ins)return{grade:'—',cls:'score'};
  const spend=parseFloat(ins.spend||0);
  const leads=getLeads(ins);
  const ctr=parseFloat(ins.ctr||0);
  const freq=parseFloat(ins.frequency||0);
  const cpl=leads>0?spend/leads:null;
  let pts=0;
  // CPL
  if(cpl&&cpl<50)pts+=30;
  else if(cpl&&cpl<80)pts+=20;
  else if(cpl&&cpl<150)pts+=10;
  // CTR
  if(ctr>=2)pts+=25;
  else if(ctr>=1)pts+=15;
  else if(ctr>=0.5)pts+=5;
  // Leads
  if(leads>=10)pts+=25;
  else if(leads>=5)pts+=15;
  else if(leads>=1)pts+=5;
  // Frequência
  if(freq>0&&freq<=3)pts+=20;
  else if(freq>3&&freq<=5)pts+=10;
  else if(freq>7)pts-=10;

  if(pts>=70)return{grade:'A',cls:'score-a'};
  if(pts>=45)return{grade:'B',cls:'score-b'};
  if(pts>=20)return{grade:'C',cls:'score-c'};
  return{grade:'D',cls:'score-d'};
}

// ── API ───────────────────────────────────────────────────────
async function apiFetch(url,retries=2){
  for(let i=0;i<=retries;i++){
    try{
      const r=await fetch(url);
      const d=await r.json();
      if(d.error)throw new Error(d.error.message||d.error.type||JSON.stringify(d.error));
      return d;
    }catch(e){
      if(i===retries)throw e;
      await new Promise(res=>setTimeout(res,1000*(i+1)));
    }
  }
}

async function loadData(){
  const dateParam=getDateParam();
  clearErr();window._loaded=false;
  ['fetchBtn','fetchBtn2'].forEach(id=>{const e=document.getElementById(id);if(e)e.disabled=true;});
  document.getElementById('loadMain').classList.add('show');

  try{
    let dateQS='';
    if(dateParam.type==='range') dateQS=`since=${dateParam.since}&until=${dateParam.until}`;
    else dateQS=`date_preset=${dateParam.value}`;

    setTxt('loadTxt','Buscando campanhas...');
    const campRes=await apiFetch('/api/campaigns');
    const camps=campRes.data||[];

    setTxt('loadTxt','Buscando métricas...');
    let insMap={};
    try{
      const insRes=await apiFetch(`/api/insights?${dateQS}`);
      (insRes.data||[]).forEach(r=>{insMap[r.campaign_id]=r;});
    }catch(e){console.warn('Insights error:',e.message);}

    const s=await fetch('/api/settings').then(r=>r.json());
    const acct='act_'+(s.account_id||'').replace(/^act_?/,'');
    allCampaigns=camps.map(c=>({...c,ins:insMap[c.id]||null}));
    window._loaded=true;
    window._dp=dateParam.type==='preset'?dateParam.value:'custom';
    window._acct=acct;
    window._dateParam=dateParam;

    setTxt('sideAcct',acct);
    document.getElementById('acctDot').style.display='inline-block';
    renderStats();renderDash();renderCamp();updateAiBadge();
    renderTodayBar();

    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('statsWrap').classList.remove('hidden');
    setTxt('sideCount',allCampaigns.filter(isActive).length);

    // Renderiza charts se estiver na aba analytics
    if(document.getElementById('page-analytics').classList.contains('active')) renderCharts();

  }catch(err){showErr(err.message);document.getElementById('emptyState').classList.remove('hidden');}
  finally{
    ['fetchBtn','fetchBtn2'].forEach(id=>{const e=document.getElementById(id);if(e)e.disabled=false;});
    document.getElementById('loadMain').classList.remove('show');
  }
}

function setTxt(id,t){const e=document.getElementById(id);if(e)e.textContent=t;}
function showErr(m){const b=document.getElementById('errorBar');document.getElementById('errorMsg').textContent=m;if(m)b.classList.remove('hidden');else b.classList.add('hidden');}
function clearErr(){document.getElementById('errorBar').classList.add('hidden');}
const isActive=c=>(c.effective_status||c.status)==='ACTIVE';

// ── Today bar ─────────────────────────────────────────────────
function renderTodayBar(){
  const bar=document.getElementById('todayBar');
  const dp=window._dateParam;
  if(!dp||!(dp.type==='range'&&dp.since===dp.until)){bar.classList.add('hidden');return;}
  bar.classList.remove('hidden');
  // Data em pt-BR
  const d=new Date(dp.since+'T12:00:00');
  document.getElementById('todayDate').textContent=d.toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  let spend=0,leads=0,imps=0,clicks=0;
  allCampaigns.forEach(c=>{if(!c.ins)return;spend+=parseFloat(c.ins.spend||0);leads+=getLeads(c.ins);imps+=parseFloat(c.ins.impressions||0);clicks+=parseFloat(c.ins.clicks||0);});
  document.getElementById('todayStats').innerHTML=`
    <div class="today-stat"><div class="today-stat-val">${R(spend)}</div><div class="today-stat-lbl">Gasto</div></div>
    <div class="today-stat"><div class="today-stat-val">${leads>0?N(leads):'0'}</div><div class="today-stat-lbl">Leads</div></div>
    <div class="today-stat"><div class="today-stat-val">${K(imps)}</div><div class="today-stat-lbl">Impressões</div></div>
    <div class="today-stat"><div class="today-stat-val">${leads>0?R(spend/leads):'—'}</div><div class="today-stat-lbl">CPL</div></div>`;
}

// ── Stats ──────────────────────────────────────────────────────
function renderStats(){
  const active=allCampaigns.filter(isActive);
  let spend=0,leads=0,imps=0,clicks=0,reach=0,cpmSum=0,cpmN=0,ctrSum=0,ctrN=0,freqSum=0,freqN=0;
  allCampaigns.forEach(c=>{if(!c.ins)return;
    spend+=parseFloat(c.ins.spend||0);leads+=getLeads(c.ins);
    imps+=parseFloat(c.ins.impressions||0);clicks+=parseFloat(c.ins.clicks||0);
    reach+=parseFloat(c.ins.reach||0);
    if(c.ins.cpm){cpmSum+=parseFloat(c.ins.cpm);cpmN++;}
    if(c.ins.ctr){ctrSum+=parseFloat(c.ins.ctr);ctrN++;}
    if(c.ins.frequency){freqSum+=parseFloat(c.ins.frequency);freqN++;}
  });
  const cpl=leads>0?spend/leads:0,avgCtr=ctrN>0?ctrSum/ctrN:0,avgCpm=cpmN>0?cpmSum/cpmN:0,avgFreq=freqN>0?freqSum/freqN:0;

  // CPL classification
  let cplSub='por lead gerado';
  if(cpl>0&&cpl<50)cplSub='🟢 Excelente (meta: R$30-80)';
  else if(cpl>=50&&cpl<=80)cplSub='🟡 Dentro da meta';
  else if(cpl>80&&cpl<=150)cplSub='🟠 Acima da meta ideal';
  else if(cpl>150)cplSub='🔴 CPL alto — otimizar';

  setTxt('sActive',active.length);setTxt('sTotal',`de ${allCampaigns.length} total`);
  setTxt('sSpend',R(spend));setTxt('sPeriod',getDateLabel());
  setTxt('sLeads',leads>0?N(leads):'0');
  setTxt('sCpl',cpl>0?R(cpl):'—');setTxt('sCplSub',cplSub);
  setTxt('sImps',K(imps));setTxt('sCpm',avgCpm>0?`CPM médio: ${R(avgCpm)}`:'');
  setTxt('sCtr',avgCtr>0?avgCtr.toFixed(2)+'%':'—');setTxt('sClicks',K(clicks)+' cliques');
  setTxt('sFreq',avgFreq>0?avgFreq.toFixed(1)+'x':'—');
  setTxt('sReach',reach>0?K(reach):'—');

  // Delta indicator (ativas vs total)
  const pct=allCampaigns.length>0?Math.round(active.length/allCampaigns.length*100):0;
  const deltaEl=document.getElementById('sDeltaActive');
  deltaEl.className=`stat-delta ${pct>=50?'up':'neutral'}`;
  deltaEl.textContent=`${pct}%`;
}

// ── Dashboard ─────────────────────────────────────────────────
function renderDash(){
  const active=allCampaigns.filter(isActive);
  setTxt('dashPill',active.length);
  const body=document.getElementById('dashBody');
  if(!active.length){body.innerHTML=`<tr class="empty-row"><td colspan="8">Nenhuma campanha ativa</td></tr>`;return;}
  const sorted=[...active].sort((a,b)=>{
    const sa=parseFloat(a.ins?.spend||0),sb=parseFloat(b.ins?.spend||0);
    return sb-sa;
  });
  body.innerHTML=sorted.map((c,i)=>{
    const ins=c.ins,spend=ins?parseFloat(ins.spend||0):0,leads=ins?getLeads(ins):0;
    const cpl=leads>0?spend/leads:0,ctr=ins?parseFloat(ins.ctr||0):0,freq=ins?.frequency?parseFloat(ins.frequency).toFixed(1):'—';
    const sc=calcScore(c);
    const ri=allCampaigns.indexOf(c);
    return`<tr onclick="openDrawer(${ri})">
      <td><div class="c-name">${esc(c.name.length>34?c.name.slice(0,34)+'…':c.name)}</div><div class="c-obj">${(c.objective||'').replace(/_/g,' ')}</div></td>
      <td class="metric">${spend>0?R(spend):'<span class="nd">—</span>'}</td>
      <td class="metric">${leads>0?N(leads):'<span class="nd">0</span>'}</td>
      <td class="metric ${cpl>0?(cpl<50?'cpl-good':cpl<150?'cpl-mid':'cpl-bad'):''}">${cpl>0?R(cpl):'<span class="nd">—</span>'}</td>
      <td class="metric">${ctr>0?ctr.toFixed(2)+'%':'<span class="nd">—</span>'}</td>
      <td class="metric">${freq}</td>
      <td><span class="score ${sc.cls}">${sc.grade}</span></td>
      <td><span class="icon row-arrow icon-sm">chevron_right</span></td>
    </tr>`;
  }).join('');
}

// ── Campaigns table with sort ──────────────────────────────────
function sortTable(col){
  if(_sortCol===col)_sortAsc=!_sortAsc;
  else{_sortCol=col;_sortAsc=false;}
  // Update header icons
  document.querySelectorAll('#campTable th').forEach(th=>{
    th.classList.remove('sorted');
    const ic=th.querySelector('.sort-icon');
    if(ic)ic.textContent='unfold_more';
  });
  const thMap={name:0,spend:3,imps:4,clicks:5,ctr:6,leads:7,cpl:8,freq:9};
  const idx=thMap[col];
  if(idx!==undefined){
    const th=document.querySelectorAll('#campTable th')[idx];
    if(th){th.classList.add('sorted');const ic=th.querySelector('.sort-icon');if(ic)ic.textContent=_sortAsc?'arrow_upward':'arrow_downward';}
  }
  renderCamp();
}

function renderCamp(){
  const list=currentFilter==='active'?allCampaigns.filter(isActive):allCampaigns;
  setTxt('campPill',list.length);
  const body=document.getElementById('campBody');
  if(!list.length){body.innerHTML=`<tr class="empty-row"><td colspan="12">Nenhuma campanha encontrada</td></tr>`;return;}

  const sorted=[...list].sort((a,b)=>{
    const getV=(c)=>{
      const ins=c.ins;
      if(_sortCol==='name')return(c.name||'').toLowerCase();
      if(_sortCol==='spend')return parseFloat(ins?.spend||0);
      if(_sortCol==='imps')return parseFloat(ins?.impressions||0);
      if(_sortCol==='clicks')return parseFloat(ins?.clicks||0);
      if(_sortCol==='ctr')return parseFloat(ins?.ctr||0);
      if(_sortCol==='leads'){const l=ins?getLeads(ins):0;return l;}
      if(_sortCol==='cpl'){const l=ins?getLeads(ins):0,s=parseFloat(ins?.spend||0);return l>0?s/l:9999;}
      if(_sortCol==='freq')return parseFloat(ins?.frequency||0);
      return 0;
    };
    const va=getV(a),vb=getV(b);
    if(typeof va==='string')return _sortAsc?va.localeCompare(vb):vb.localeCompare(va);
    return _sortAsc?va-vb:vb-va;
  });

  body.innerHTML=sorted.map(c=>{
    const ins=c.ins,spend=ins?parseFloat(ins.spend||0):null;
    const imps=ins?parseFloat(ins.impressions||0):null,clicks=ins?parseFloat(ins.clicks||0):null;
    const ctr=ins?parseFloat(ins.ctr||0):null,freq=ins?.frequency?parseFloat(ins.frequency).toFixed(1):'—';
    const leads=ins?getLeads(ins):null,cpl=leads&&leads>0&&spend?spend/leads:null;
    const st=c.effective_status||c.status||'OTHER';
    const stC=st==='ACTIVE'?'badge-active':st==='PAUSED'?'badge-paused':'badge-other';
    const stL={ACTIVE:'Ativa',PAUSED:'Pausada',ARCHIVED:'Arquivada',DELETED:'Excluída'}[st]||st;
    let bgt='<span class="nd">—</span>';
    if(c.daily_budget)bgt=R(c.daily_budget/100)+'<div class="metric-sub">diário</div>';
    else if(c.lifetime_budget)bgt=R(c.lifetime_budget/100)+'<div class="metric-sub">vitalício</div>';
    const cplC=cpl?(cpl<50?'cpl-good':cpl<150?'cpl-mid':'cpl-bad'):'';
    const sc=calcScore(c);
    const ri=allCampaigns.indexOf(c);
    return`<tr onclick="openDrawer(${ri})">
      <td><div class="c-name">${esc(c.name.length>26?c.name.slice(0,26)+'…':c.name)}</div><div class="c-obj">${(c.objective||'').replace(/_/g,' ')}</div></td>
      <td><span class="badge ${stC}"><span class="badge-dot"></span>${stL}</span></td>
      <td>${bgt}</td>
      <td class="metric">${spend!==null&&spend>0?R(spend):'<span class="nd">—</span>'}</td>
      <td class="metric">${imps!==null&&imps>0?K(imps):'<span class="nd">—</span>'}</td>
      <td class="metric">${clicks!==null&&clicks>0?K(clicks):'<span class="nd">—</span>'}</td>
      <td class="metric">${ctr!==null&&ctr>0?ctr.toFixed(2)+'%':'<span class="nd">—</span>'}</td>
      <td class="metric">${leads!==null&&leads>0?N(leads):'<span class="nd">0</span>'}</td>
      <td class="metric ${cplC}">${cpl?R(cpl):'<span class="nd">—</span>'}</td>
      <td class="metric">${freq}</td>
      <td><span class="score ${sc.cls}">${sc.grade}</span></td>
      <td><span class="icon row-arrow icon-sm">chevron_right</span></td>
    </tr>`;
  }).join('');
}

function setFilter(f){
  currentFilter=f;
  document.getElementById('fActive').classList.toggle('active',f==='active');
  document.getElementById('fAll').classList.toggle('active',f==='all');
  renderCamp();
}

// ── Charts ────────────────────────────────────────────────────
let _charts={};
function renderCharts(){
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const gridC=isDark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)';
  const textC=isDark?'#9ca3b8':'#6b7280';

  // Destrói charts antigos
  Object.values(_charts).forEach(ch=>{try{ch.destroy();}catch(e){}});
  _charts={};

  const active=allCampaigns.filter(c=>c.ins);
  if(!active.length)return;

  // Sort by spend for spend chart
  const bySpend=[...active].sort((a,b)=>parseFloat(b.ins.spend||0)-parseFloat(a.ins.spend||0)).slice(0,8);
  const byLeads=[...active].sort((a,b)=>getLeads(b.ins)-getLeads(a.ins)).slice(0,8).filter(c=>getLeads(c.ins)>0);
  const byCtr=[...active].sort((a,b)=>parseFloat(b.ins.ctr||0)-parseFloat(a.ins.ctr||0)).slice(0,8);
  const byCpl=[...active].filter(c=>getLeads(c.ins)>0).sort((a,b)=>{const la=getLeads(a.ins),lb=getLeads(b.ins),sa=parseFloat(a.ins.spend||0),sb=parseFloat(b.ins.spend||0);return (sa/la)-(sb/lb);}).slice(0,8);

  const shortName=n=>n.length>20?n.slice(0,20)+'…':n;
  const COLORS=['#00c853','#34d399','#a78bfa','#fbbf24','#fb923c','#f87171','#60a5fa','#e879f9'];

  const defaults={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:isDark?'#1e2230':'#fff',titleColor:isDark?'#eaedf5':'#1a1f30',bodyColor:isDark?'#9ca3b8':'#6b7280',borderColor:isDark?'#242738':'#e5e8f0',borderWidth:1,padding:10,cornerRadius:8}},scales:{x:{ticks:{color:textC,font:{size:10,family:'Poppins'}},grid:{color:gridC}},y:{ticks:{color:textC,font:{size:10,family:'Poppins'}},grid:{color:gridC}}}};

  // Spend
  _charts.spend=new Chart(document.getElementById('chartSpend'),{type:'bar',data:{labels:bySpend.map(c=>shortName(c.name)),datasets:[{data:bySpend.map(c=>parseFloat(c.ins.spend||0).toFixed(2)),backgroundColor:COLORS,borderRadius:6,borderSkipped:false}]},options:{...defaults,plugins:{...defaults.plugins,tooltip:{...defaults.plugins.tooltip,callbacks:{label:v=>`R$ ${parseFloat(v.raw).toLocaleString('pt-BR',{minimumFractionDigits:2})}`}}}}});

  // Leads — doughnut
  if(byLeads.length){
    _charts.leads=new Chart(document.getElementById('chartLeads'),{type:'doughnut',data:{labels:byLeads.map(c=>shortName(c.name)),datasets:[{data:byLeads.map(c=>getLeads(c.ins)),backgroundColor:COLORS,borderWidth:2,borderColor:isDark?'#181b25':'#ffffff'}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{display:true,position:'bottom',labels:{color:textC,font:{size:10,family:'Poppins'},padding:10,boxWidth:10,boxHeight:10}},tooltip:{...defaults.plugins.tooltip,callbacks:{label:v=>`${v.label}: ${v.raw} leads`}}}}});
  }

  // CTR — bar horizontal
  _charts.ctr=new Chart(document.getElementById('chartCtr'),{type:'bar',data:{labels:byCtr.map(c=>shortName(c.name)),datasets:[{data:byCtr.map(c=>parseFloat(c.ins.ctr||0).toFixed(2)),backgroundColor:byCtr.map(c=>parseFloat(c.ins.ctr||0)>=1?'#00c853':'#fbbf24'),borderRadius:6,borderSkipped:false}]},options:{...defaults,plugins:{...defaults.plugins,tooltip:{...defaults.plugins.tooltip,callbacks:{label:v=>`${parseFloat(v.raw).toFixed(2)}%`}}},scales:{...defaults.scales,y:{...defaults.scales.y,ticks:{...defaults.scales.y.ticks,callback:v=>`${v}%`}}}}});

  // CPL — bar
  if(byCpl.length){
    _charts.cpl=new Chart(document.getElementById('chartCpl'),{type:'bar',data:{labels:byCpl.map(c=>shortName(c.name)),datasets:[{data:byCpl.map(c=>{const l=getLeads(c.ins),s=parseFloat(c.ins.spend||0);return l>0?(s/l).toFixed(2):0;}),backgroundColor:byCpl.map(c=>{const l=getLeads(c.ins),s=parseFloat(c.ins.spend||0),cpl=l>0?s/l:999;return cpl<50?'#34d399':cpl<80?'#00c853':cpl<150?'#fbbf24':'#f87171';}),borderRadius:6,borderSkipped:false}]},options:{...defaults,plugins:{...defaults.plugins,tooltip:{...defaults.plugins.tooltip,callbacks:{label:v=>`R$ ${parseFloat(v.raw).toLocaleString('pt-BR',{minimumFractionDigits:2})}`}}},scales:{...defaults.scales,y:{...defaults.scales.y,ticks:{...defaults.scales.y.ticks,callback:v=>`R$${v}`}}}}});
  }
}

// ── Drawer ────────────────────────────────────────────────────
function openDrawer(idx){
  const c=allCampaigns[idx];if(!c)return;
  const ins=c.ins;
  const spend=ins?parseFloat(ins.spend||0):0;
  const leads=ins?getLeads(ins):0;
  const cpl=leads>0?spend/leads:0;
  const ctr=ins?parseFloat(ins.ctr||0):0;
  const cpm=ins?parseFloat(ins.cpm||0):0;
  const cpc=ins?parseFloat(ins.cpc||0):0;
  const freq=ins?parseFloat(ins.frequency||0):0;
  const imps=ins?parseFloat(ins.impressions||0):0;
  const clicks=ins?parseFloat(ins.clicks||0):0;
  const reach=ins?parseFloat(ins.reach||0):0;
  const st=c.effective_status||c.status||'OTHER';
  const stC=st==='ACTIVE'?'badge-active':st==='PAUSED'?'badge-paused':'badge-other';
  const stL={ACTIVE:'Ativa',PAUSED:'Pausada',ARCHIVED:'Arquivada',DELETED:'Excluída'}[st]||st;
  const obj=(c.objective||'N/A').replace(/_/g,' ');
  const sc=calcScore(c);

  document.getElementById('drName').textContent=c.name;
  document.getElementById('drBadge').innerHTML=`<span class="badge ${stC}"><span class="badge-dot"></span>${stL}</span> <span class="score ${sc.cls}" style="margin-left:6px">${sc.grade}</span>`;

  let insight='';
  if(st==='ACTIVE'){
    if(leads===0&&spend>20)insight=`<p>Esta campanha gastou <strong>${R(spend)}</strong> sem registrar leads. Verifique se o objetivo está como <strong>LEADS</strong> e se o formulário está publicado e ativo.</p>`;
    else if(leads>0&&cpl<50)insight=`<p>CPL de <strong>${R(cpl)}</strong> está excelente para consignado CLT (meta: R$30–80). Considere aumentar o orçamento para escalar.</p>`;
    else if(leads>0&&cpl>150)insight=`<p>CPL de <strong>${R(cpl)}</strong> está alto. Teste novos criativos, refine o público ou revise o formulário para aumentar a taxa de conversão.</p>`;
    else if(freq>5)insight=`<p>Frequência <strong>${freq.toFixed(1)}x</strong> está elevada — o público está saturando. Renove o criativo ou expanda a audiência.</p>`;
    else if(ctr<1&&imps>1000)insight=`<p>CTR de <strong>${ctr.toFixed(2)}%</strong> está baixo. Teste um novo criativo com hook mais forte nos primeiros 3 segundos do vídeo.</p>`;
    else if(leads>0)insight=`<p>Campanha gerando resultados. Monitore a frequência (atual: <strong>${freq.toFixed(1)}x</strong>) e o custo por lead semanalmente.</p>`;
  }else{
    insight=`<p>Campanha pausada. ${spend>0?`Gastou <strong>${R(spend)}</strong> durante o período ativo com ${leads} lead(s) registrado(s).`:'Sem gasto no período selecionado.'}`;
  }

  // Performance bars
  const maxPossibleCTR=3;
  const ctrPct=Math.min(ctr/maxPossibleCTR*100,100);
  const freqPct=Math.min(freq/10*100,100);
  const freqColor=freq<=3?'#34d399':freq<=5?'#fbbf24':'#f87171';

  document.getElementById('drawerBody').innerHTML=`
    <div class="drawer-section">
      <div class="drawer-section-title"><span class="icon">analytics</span>Performance — ${getDateLabel()}</div>
      <div class="meta-grid">
        <div class="meta-item"><div class="meta-item-lbl">Investimento</div><div class="meta-item-val">${spend>0?R(spend):'—'}</div><div class="meta-item-sub">total gasto</div></div>
        <div class="meta-item"><div class="meta-item-lbl">Leads</div><div class="meta-item-val green">${leads>0?N(leads):'0'}</div><div class="meta-item-sub">conversões</div></div>
        <div class="meta-item"><div class="meta-item-lbl">CPL</div><div class="meta-item-val purple">${cpl>0?R(cpl):'—'}</div><div class="meta-item-sub">custo por lead</div></div>
        <div class="meta-item"><div class="meta-item-lbl">CTR</div><div class="meta-item-val ${ctr>=2?'green':ctr>=1?'yellow':'blue'}">${ctr>0?ctr.toFixed(2)+'%':'—'}</div><div class="meta-item-sub">taxa de cliques</div></div>
      </div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title"><span class="icon">equalizer</span>Indicadores Visuais</div>
      <div style="background:var(--card);border-radius:var(--radius-sm);border:1px solid var(--border);padding:14px;">
        <div class="perf-bar-wrap">
          <div class="perf-bar-label"><span>CTR</span><span>${ctr>0?ctr.toFixed(2)+'%':'—'}</span></div>
          <div class="perf-bar-bg"><div class="perf-bar-fill" style="width:${ctrPct}%;background:${ctr>=2?'#34d399':ctr>=1?'#00c853':'#fbbf24'}"></div></div>
        </div>
        <div class="perf-bar-wrap" style="margin-top:10px">
          <div class="perf-bar-label"><span>Frequência</span><span>${freq>0?freq.toFixed(1)+'x':'—'}</span></div>
          <div class="perf-bar-bg"><div class="perf-bar-fill" style="width:${freqPct}%;background:${freqColor}"></div></div>
        </div>
      </div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title"><span class="icon">equalizer</span>Métricas Detalhadas</div>
      <div style="background:var(--card);border-radius:var(--radius-sm);border:1px solid var(--border);padding:4px 14px;">
        ${detRow('visibility','Impressões',K(imps))}
        ${detRow('touch_app','Cliques',K(clicks))}
        ${detRow('people','Alcance',reach>0?K(reach):'—')}
        ${detRow('repeat','Frequência',freq>0?freq.toFixed(1)+'x':'—')}
        ${detRow('receipt','CPM',cpm>0?R(cpm):'—')}
        ${detRow('mouse','CPC',cpc>0?R(cpc):'—')}
      </div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title"><span class="icon">info</span>Informações da Campanha</div>
      <div style="background:var(--card);border-radius:var(--radius-sm);border:1px solid var(--border);padding:4px 14px;">
        ${detRow('track_changes','Objetivo',obj)}
        ${detRow('account_balance_wallet','Orçamento',c.daily_budget?R(c.daily_budget/100)+'/dia':c.lifetime_budget?R(c.lifetime_budget/100)+' vitalício':'—')}
        ${detRow('calendar_today','Criado em',c.created_time?new Date(c.created_time).toLocaleDateString('pt-BR'):'—')}
        ${detRow('fingerprint','ID',c.id)}
      </div>
    </div>

    ${insight?`<div class="drawer-section">
      <div class="insight-box">
        <div class="insight-title"><span class="icon">lightbulb</span>Insight Automático</div>
        ${insight}
      </div>
    </div>`:''}
  `;

  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('open');
}

function detRow(icon,label,val){
  return`<div class="detail-row"><span class="detail-lbl"><span class="icon icon-sm">${icon}</span>${label}</span><span class="detail-val">${val}</span></div>`;
}
function closeDrawer(){
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
}

// ── Date Picker ────────────────────────────────────────────────
const MESES=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const DIAS_SEMANA=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

let _dpState={
  open:false,preset:'last_30d',rangeStart:null,rangeEnd:null,picking:false,
  viewYear:new Date().getFullYear(),viewMonth:new Date().getMonth()
};

function dpFmt(iso){if(!iso)return'';const[y,m,d]=iso.split('-');return`${d}/${m}/${y}`;}
function dpToday(){return new Date().toISOString().slice(0,10);}

function dpUpdateLabel(){
  const lbl=document.getElementById('dpLabel');
  const btn=document.getElementById('dpTrigger');
  if(_dpState.preset){lbl.textContent=dpLbl(_dpState.preset);btn.classList.remove('has-range');}
  else if(_dpState.rangeStart&&_dpState.rangeEnd){lbl.textContent=`${dpFmt(_dpState.rangeStart)} → ${dpFmt(_dpState.rangeEnd)}`;btn.classList.add('has-range');}
  else if(_dpState.rangeStart){lbl.textContent=`${dpFmt(_dpState.rangeStart)} → ...`;btn.classList.add('has-range');}
  else{lbl.textContent='Selecione o período';btn.classList.remove('has-range');}
}

function dpToggle(){
  _dpState.open=!_dpState.open;
  document.getElementById('dpDropdown').classList.toggle('open',_dpState.open);
  if(_dpState.open){dpRenderMonth();dpPopulateSelects();}
}
function dpClose(){_dpState.open=false;document.getElementById('dpDropdown').classList.remove('open');}

document.addEventListener('click',e=>{
  const wrap=document.getElementById('dpWrap');
  if(wrap&&!wrap.contains(e.target))dpClose();
});

function dpSelectPreset(btn){
  const preset=btn.dataset.preset;
  _dpState.preset=preset;_dpState.rangeStart=null;_dpState.rangeEnd=null;_dpState.picking=false;
  document.querySelectorAll('.dp-opt').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  dpUpdateLabel();dpRenderMonth();dpClose();
  if(window._loaded)loadData();
}
function dpSelectToday(){
  _dpState.preset='today';_dpState.rangeStart=null;_dpState.rangeEnd=null;
  document.querySelectorAll('.dp-opt').forEach(b=>b.classList.remove('active'));
  document.querySelector('.dp-opt[data-preset="today"]')?.classList.add('active');
  dpUpdateLabel();dpClose();
  if(window._loaded)loadData();
}
function dpClear(){
  _dpState.preset='last_30d';_dpState.rangeStart=null;_dpState.rangeEnd=null;_dpState.picking=false;
  document.querySelectorAll('.dp-opt').forEach(b=>b.classList.remove('active'));
  document.querySelector('.dp-opt[data-preset="last_30d"]')?.classList.add('active');
  dpUpdateLabel();dpRenderMonth();
}
function dpNavMonth(dir){
  _dpState.viewMonth+=dir;
  if(_dpState.viewMonth>11){_dpState.viewMonth=0;_dpState.viewYear++;}
  if(_dpState.viewMonth<0){_dpState.viewMonth=11;_dpState.viewYear--;}
  dpRenderMonth();dpPopulateSelects();
}
function dpPopulateSelects(){
  const ms=document.getElementById('dpMonthSel'),ys=document.getElementById('dpYearSel');
  if(!ms||!ys)return;
  ms.innerHTML=MESES.map((m,i)=>`<option value="${i}"${i===_dpState.viewMonth?' selected':''}>${m}</option>`).join('');
  const curY=new Date().getFullYear();ys.innerHTML='';
  for(let y=curY-5;y<=curY+1;y++)ys.innerHTML+=`<option value="${y}"${y===_dpState.viewYear?' selected':''}>${y}</option>`;
}
function dpGoToMonth(){
  _dpState.viewMonth=parseInt(document.getElementById('dpMonthSel').value);
  _dpState.viewYear=parseInt(document.getElementById('dpYearSel').value);
  dpRenderMonth();
}
function dpClickDay(ev,iso,other){
  ev.stopPropagation();
  if(other)return;
  if(!_dpState.picking||!_dpState.rangeStart){
    _dpState.rangeStart=iso;_dpState.rangeEnd=null;_dpState.picking=true;_dpState.preset=null;
    document.querySelectorAll('.dp-opt').forEach(b=>b.classList.remove('active'));
    document.getElementById('dpHint').textContent='Selecione a data final';
  }else{
    let s=_dpState.rangeStart,e=iso;
    if(e<s){[s,e]=[e,s];}
    _dpState.rangeStart=s;_dpState.rangeEnd=e;_dpState.picking=false;
    document.getElementById('dpHint').textContent='Selecione a data inicial';
    dpUpdateLabel();dpRenderMonth();dpClose();
    if(window._loaded)loadData();
    return;
  }
  dpUpdateLabel();dpRenderMonth();
}
function dpRenderMonth(){
  const grid=document.getElementById('dpGrid');if(!grid)return;
  const today=dpToday();
  const y=_dpState.viewYear,m=_dpState.viewMonth;
  const first=new Date(y,m,1),last=new Date(y,m+1,0);
  const startDow=first.getDay();
  let html=DIAS_SEMANA.map(d=>`<div class="dp-dow">${d}</div>`).join('');
  for(let i=0;i<startDow;i++){const pd=new Date(y,m,-(startDow-1-i));const iso=pd.toISOString().slice(0,10);html+=`<button class="dp-day dp-day-other" onclick="dpClickDay(event,'${iso}',true)">${pd.getDate()}</button>`;}
  for(let d=1;d<=last.getDate();d++){
    const iso=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    let cls='dp-day';
    if(iso===today)cls+=' dp-day-today';
    const s=_dpState.rangeStart,e=_dpState.rangeEnd;
    if(s&&iso===s&&e&&iso===e)cls+=' dp-day-start dp-day-end';
    else if(s&&iso===s){cls+=' dp-day-start';if(e)cls+=' dp-has-end';}
    else if(e&&iso===e)cls+=' dp-day-end';
    else if(s&&e&&iso>s&&iso<e)cls+=' dp-day-in-range';
    html+=`<button class="${cls}" onclick="dpClickDay(event,'${iso}',false)">${d}</button>`;
  }
  const totalCells=startDow+last.getDate();const remaining=(7-totalCells%7)%7;
  for(let d=1;d<=remaining;d++){const nd=new Date(y,m+1,d);const iso=nd.toISOString().slice(0,10);html+=`<button class="dp-day dp-day-other" onclick="dpClickDay(event,'${iso}',true)">${d}</button>`;}
  grid.innerHTML=html;
}

function getDateParam(){
  if(_dpState.preset==='today'){const t=dpToday();return{type:'range',since:t,until:t};}
  if(!_dpState.preset&&_dpState.rangeStart&&_dpState.rangeEnd)return{type:'range',since:_dpState.rangeStart,until:_dpState.rangeEnd};
  return{type:'preset',value:_dpState.preset||'last_30d'};
}
function getDateLabel(){
  const p=getDateParam();
  if(p.type==='range'&&p.since===p.until)return`Hoje (${dpFmt(p.since)})`;
  if(p.type==='range')return`${dpFmt(p.since)} → ${dpFmt(p.until)}`;
  return dpLbl(p.value);
}

// ── Diagnostic ────────────────────────────────────────────────
async function gerarDiag(){
  document.getElementById('diagBtn').disabled=true;
  document.getElementById('diagLoad').classList.add('show');
  document.getElementById('diagOut').classList.remove('show');
  try{
    const dp=getDateParam();
    let dateQS=dp.type==='range'?`since=${dp.since}&until=${dp.until}`:`date_preset=${dp.value}`;
    const campRes=await apiFetch('/api/campaigns');
    const camps=campRes.data||[];
    let insMap={};
    try{const insRes=await apiFetch(`/api/insights?${dateQS}`);(insRes.data||[]).forEach(r=>{insMap[r.campaign_id]=r;});}catch(e){}
    const s=await fetch('/api/settings').then(r=>r.json());
    const acct='act_'+(s.account_id||'').replace(/^act_?/,'');
    const ativas=camps.map(c=>({...c,ins:insMap[c.id]||null})).filter(c=>(c.effective_status||c.status)==='ACTIVE');
    document.getElementById('diagTxt').value=montarRelatorio(ativas,getDateLabel(),acct);
    document.getElementById('diagOut').classList.add('show');
  }catch(e){alert('Erro: '+e.message);}
  finally{document.getElementById('diagBtn').disabled=false;document.getElementById('diagLoad').classList.remove('show');}
}

function montarRelatorio(camps,dp,acct){
  let spend=0,leads=0,imps=0,clicks=0;
  camps.forEach(c=>{if(!c.ins)return;spend+=parseFloat(c.ins.spend||0);leads+=getLeads(c.ins);imps+=parseFloat(c.ins.impressions||0);clicks+=parseFloat(c.ins.clicks||0);});
  const cpl=leads>0?(spend/leads).toFixed(2):'N/A';
  const ctr=imps>0?((clicks/imps)*100).toFixed(2):'N/A';
  const linhas=camps.map(c=>{
    const ins=c.ins,s=ins?parseFloat(ins.spend||0).toFixed(2):'0.00';
    const l=ins?getLeads(ins):0,cplC=l>0?(parseFloat(s)/l).toFixed(2):'N/A';
    const ctrC=ins?parseFloat(ins.ctr||0).toFixed(2):'0.00',freq=ins?.frequency?parseFloat(ins.frequency).toFixed(1):'N/A';
    const sc=calcScore(c);
    return`  - ${c.name} [Score: ${sc.grade}]
    Objetivo: ${(c.objective||'N/A').replace(/_/g,' ')} | Orçamento: ${c.daily_budget?'R$'+(c.daily_budget/100).toFixed(2)+'/dia':c.lifetime_budget?'R$'+(c.lifetime_budget/100).toFixed(2)+' vitalício':'N/A'}
    Investimento: R$${s} | Impressões: ${parseInt(ins?.impressions||0).toLocaleString('pt-BR')} | Cliques: ${parseInt(ins?.clicks||0).toLocaleString('pt-BR')} | CTR: ${ctrC}%
    Leads: ${l} | CPL: R$${cplC} | Frequência: ${freq}`;
  }).join('\n\n');
  return`=== DIAGNÓSTICO META ADS — CAMPANHAS ATIVAS — ${dp.toUpperCase()} ===
Empresa: Consig Tech (Crédito Consignado CLT)
Conta: ${acct} | Gerado: ${new Date().toLocaleString('pt-BR')}

--- RESUMO ---
Campanhas ativas: ${camps.length} | Investimento: R$${spend.toFixed(2)} | Leads: ${leads} | CPL: R$${cpl} | CTR: ${ctr}%

--- CAMPANHAS ---
${camps.length?linhas:'  Nenhuma campanha ativa no período.'}

=== FIM ===
Analise essas campanhas de crédito consignado CLT e me dê:
1. Diagnóstico honesto focado em CPL e volume de leads
2. O que está indo bem e por quê
3. O que melhorar em cada campanha
4. Recomendações para reduzir CPL e aumentar leads
5. O que escalar, ajustar ou pausar`;
}

function copiarDiag(){
  navigator.clipboard.writeText(document.getElementById('diagTxt').value).then(()=>{
    const b=document.getElementById('copiedBadge');b.classList.add('show');setTimeout(()=>b.classList.remove('show'),2500);
  }).catch(()=>{document.getElementById('diagTxt').select();document.execCommand('copy');});
}

// ── AI ────────────────────────────────────────────────────────
function updateAiBadge(){
  const key=document.getElementById('claudeKey').value.trim();
  const badge=document.getElementById('aiBadge'),txt=document.getElementById('aiBadgeTxt');
  if(window.cowork?.askClaude||key){badge.className='ai-badge on';txt.textContent='Análise com Claude ativa';}
  else{badge.className='ai-badge local';txt.textContent='Análise local ativa';}
}
function showChips(){
  const chips=document.getElementById('chips');
  chips.style.display='flex';
  chips.style.animation='fadeUp .2s var(--ease)';
}
function askChip(el){document.getElementById('chatIn').value=el.textContent;sendMsg();}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}

async function sendMsg(){
  const inp=document.getElementById('chatIn'),q=inp.value.trim();
  if(!q)return;
  if(!window._loaded){alert('Carregue as campanhas em Configurações primeiro.');return;}
  const hist=document.getElementById('chatHist');
  hist.innerHTML+=`<div class="cmsg user"><div class="cmsg-lbl">Você</div>${esc(q)}</div>`;
  inp.value='';inp.style.height='auto';hist.scrollTop=hist.scrollHeight;
  document.getElementById('thinking').classList.add('show');
  document.getElementById('chips').style.display='none';
  inp.blur();
  const ctx=buildCtx();
  try{
    let ans;
    const key=document.getElementById('claudeKey').value.trim();
    if(window.cowork?.askClaude)ans=await window.cowork.askClaude(buildPrompt(q,ctx),[]);
    else if(key)ans=await callClaude(key,buildPrompt(q,ctx));
    else ans=localAnalysis(q,ctx);
    hist.innerHTML+=`<div class="cmsg bot"><div class="cmsg-lbl">Análise</div>${fmtAns(ans)}</div>`;
  }catch(e){hist.innerHTML+=`<div class="cmsg bot"><div class="cmsg-lbl">Erro</div>${esc(e.message)}</div>`;}
  finally{
    document.getElementById('thinking').classList.remove('show');
    hist.scrollTop=hist.scrollHeight;
    showChips();
  }
}

function buildCtx(){
  return allCampaigns.map(c=>{
    const ins=c.ins,spend=ins?parseFloat(ins.spend||0):0,leads=ins?getLeads(ins):0;
    return{nome:c.name,status:c.effective_status||c.status,objetivo:c.objective,
      orcamento_dia:c.daily_budget?(c.daily_budget/100).toFixed(2):null,
      investimento:spend.toFixed(2),impressoes:ins?parseInt(ins.impressions||0):0,
      cliques:ins?parseInt(ins.clicks||0):0,ctr:ins?parseFloat(ins.ctr||0).toFixed(2):0,
      leads,cpl:leads>0?(spend/leads).toFixed(2):null,
      frequencia:ins?.frequency?parseFloat(ins.frequency).toFixed(1):null,
      score:calcScore(c).grade};
  });
}
function buildPrompt(q,ctx){
  return`Especialista em Meta Ads para crédito consignado CLT no Brasil. Responda de forma direta e acionável em português. Métrica principal: CPL (custo por lead).\n\nPERÍODO: ${getDateLabel()} | DADOS: ${JSON.stringify(ctx)}\n\nPERGUNTA: ${q}`;
}
async function callClaude(key,prompt){
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json','anthropic-dangerous-allow-browser':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1024,messages:[{role:'user',content:prompt}]})});
  const d=await r.json();if(d.error)throw new Error(d.error.message);
  return d.content?.[0]?.text||'Sem resposta.';
}

function localAnalysis(q,ctx){
  const ql=q.toLowerCase(),ativas=ctx.filter(c=>c.status==='ACTIVE');
  const comLeads=ctx.filter(c=>c.leads>0).sort((a,b)=>b.leads-a.leads);
  const comCPL=ctx.filter(c=>c.cpl).sort((a,b)=>parseFloat(a.cpl)-parseFloat(b.cpl));
  const totalSpend=ctx.reduce((s,c)=>s+parseFloat(c.investimento||0),0);
  const totalLeads=ctx.reduce((s,c)=>s+(c.leads||0),0);
  const cplG=totalLeads>0?(totalSpend/totalLeads).toFixed(2):'N/A';
  if(ql.includes('lead')&&(ql.includes('mais')||ql.includes('melhor')))return comLeads.length?`**Campanhas com mais leads:**\n\n`+comLeads.slice(0,5).map((c,i)=>`${i+1}. **${c.nome}** [${c.score}]: ${c.leads} leads | CPL: R$${c.cpl||'—'} | Gasto: R$${c.investimento}`).join('\n'):`Nenhum lead rastreado ainda.`;
  if(ql.includes('cpl')||ql.includes('custo por lead'))return comCPL.length?`**CPL por campanha:**\n\n`+comCPL.map((c,i)=>`${i+1}. **${c.nome}**: R$${c.cpl} (${c.leads} leads)`).join('\n'):`Nenhuma campanha com leads rastreados.`;
  if(ql.includes('gast')||ql.includes('orçamento'))return`**Por investimento:**\n\n`+ctx.filter(c=>parseFloat(c.investimento)>0).sort((a,b)=>parseFloat(b.investimento)-parseFloat(a.investimento)).slice(0,5).map((c,i)=>`${i+1}. **${c.nome}** [${c.score}]: R$${c.investimento} | ${c.leads} leads | CPL: R$${c.cpl||'—'}`).join('\n');
  if(ql.includes('pausar'))return ativas.filter(c=>parseFloat(c.investimento)>30&&!c.leads).length?`**Candidatas a revisar (gasto sem leads):**\n\n`+ativas.filter(c=>parseFloat(c.investimento)>30&&!c.leads).map(c=>`• **${c.nome}** [${c.score}]: R$${c.investimento} gastos | 0 leads | CTR: ${c.ctr}%`).join('\n')+`\n\n_Verifique se o formulário está funcionando antes de pausar._`:`✅ Todas as campanhas ativas com gasto expressivo têm leads registrados.`;
  if(ql.includes('score'))return ctx.length?`**Score de performance:**\n\n`+[...ctx].sort((a,b)=>({'A':4,'B':3,'C':2,'D':1}[b.score]||0)-({'A':4,'B':3,'C':2,'D':1}[a.score]||0)).map(c=>`${c.score==='A'?'🟢':c.score==='B'?'🔵':c.score==='C'?'🟡':'🔴'} **[${c.score}] ${c.nome}** — ${c.leads} leads | CPL: R$${c.cpl||'—'} | CTR: ${c.ctr}%`).join('\n'):`Sem dados.`;
  if(ql.includes('melhor')||ql.includes('melhorar'))return`**Recomendações para consignado CLT:**\n\n• Objetivo: use **LEADS** com formulário "intenção elevada"\n• Orçamento mínimo: R$50/dia por campanha\n• Frequência ideal: 3–5x (acima de 7, troque o criativo)\n• CPL alvo: R$30–80 por lead qualificado\n• Público: homens 30–55 anos, CLT, renda R$1.500–5.000\n• Criativo: vídeo com apresentador humano converte melhor`;
  return`**Resumo — ${getDateLabel()}**\n\nCampanhas ativas: **${ativas.length}** de ${ctx.length}\nInvestimento: **R$${totalSpend.toFixed(2)}**\nLeads: **${totalLeads}** | CPL: **R$${cplG}**\n\n`+(comLeads.length?`Melhor: **${comLeads[0].nome}** [${comLeads[0].score}] (${comLeads[0].leads} leads)`:`ℹ️ Nenhum lead rastreado. Verifique o objetivo das campanhas.`);
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtAns(s){return esc(s).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');}
