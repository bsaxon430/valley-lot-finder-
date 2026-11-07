/* Valley Lot Finder — Phoenix metro parking-lot discovery (Phase 1–2 build)
   Data: Maricopa County Assessor parcels (live ArcGIS REST), OpenStreetMap parking areas (live Overpass),
   Nominatim geocoding, OpenFreeMap vector tiles, Esri World Imagery. Employee pins/reports are stored
   on-device (localStorage) until a shared database is connected. Nothing here is fabricated:
   unknown fields display UNKNOWN. */
'use strict';

// ---------- config ----------
const CFG = {
  parcels: 'https://gis.mcassessor.maricopa.gov/arcgis/rest/services/Parcels/MapServer/0/query',
  parcelPage: apn => `https://mcassessor.maricopa.gov/mcs/?q=${encodeURIComponent(apn)}`,
  overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'],
  nominatim: 'https://nominatim.openstreetmap.org/search',
  styles: {
    dark: 'https://tiles.openfreemap.org/styles/dark',
    street: 'https://tiles.openfreemap.org/styles/liberty',
    satellite: rasterStyle(false),
    hybrid: rasterStyle(true)
  },
  phoenix: { center: [-112.02, 33.47], zoom: 10.2 },
  // Phoenix metro bounding box (search bias + sanity)
  metroBbox: [-113.0, 32.9, -111.2, 34.0],
  minQueryZoom: 13,
  polyZoom: 15,
  osmZoom: 14,
  outFields: 'APN,APN_DASH,OWNER_NAME,PHYSICAL_ADDRESS,PHYSICAL_CITY,PHYSICAL_ZIP,LAND_SIZE,LIVING_SPACE,PUC,LC_CUR,CITY_ZONING,JURISDICTION,CONST_YEAR,SUBNAME,LATITUDE,LONGITUDE,SALE_DATE,TAX_YR_CUR'
};
const COLORS = { forlease:'#ff8a00', vacant:'#a855f7', abandoned:'#8b8f99', closed:'#ef4444', lowactivity:'#22d3ee', verified:'#22c55e', candidate:'#f5c542', pin:'#60a5fa' };
const STATUS_LABEL = { forlease:'FOR LEASE', vacant:'VACANT', abandoned:'ABANDONED', closed:'CLOSED', lowactivity:'LOW ACTIVITY', verified:'VERIFIED', candidate:'CANDIDATE', pin:'EMPLOYEE PIN' };
const STATUS_PRIORITY = ['verified','forlease','vacant','closed','abandoned','lowactivity'];
const EXEMPT_RE = /\b(CITY OF|TOWN OF|COUNTY|STATE OF ARIZONA|UNITED STATES|USA\b|SCHOOL DIST|UNIFIED|COMMUNITY COLLEGE|ARIZONA STATE UNIV|UNIVERSITY|SALT RIVER PROJECT|SRP\b|FLOOD CONTROL|TRANSPORTATION DEPT|ADOT|MARICOPA COUNTY)/i;

function rasterStyle(withLabels){
  const s = { version:8, glyphs:'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources:{ esri:{ type:'raster', tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize:256, maxzoom:19,
      attribution:'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community' } },
    layers:[{ id:'esri', type:'raster', source:'esri' }] };
  if (withLabels){
    s.sources.ref = { type:'raster', tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize:256, maxzoom:19 };
    s.sources.roads = { type:'raster', tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'], tileSize:256, maxzoom:19 };
    s.layers.push({ id:'roads', type:'raster', source:'roads' }, { id:'ref', type:'raster', source:'ref' });
  }
  return s;
}

// ---------- state ----------
const S = {
  map:null, styleName:'dark', userPos:null, parcels:new Map(), // apn -> property
  osmOn:false, osm:[], selected:null, filter:{ chips:new Set(['all']), minAcres:1, radius:3, useFam:'any', hideExempt:true, showPolys:true },
  local: loadLocal(), lastQueryKey:'', abort:null, legend:false, three:false
};
function loadLocal(){
  try { return Object.assign({ pins:[], obs:{}, fav:[], visited:[] }, JSON.parse(localStorage.getItem('vlf') || '{}')); }
  catch(e){ return { pins:[], obs:{}, fav:[], visited:[] }; }
}
function saveLocal(){ try { localStorage.setItem('vlf', JSON.stringify(S.local)); } catch(e){ toast('Could not save on this device'); } }

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtMi = m => m == null ? '—' : (m < 0.1 ? `${Math.round(m*5280)} ft` : `${m.toFixed(m<10?1:0)} mi`);
const fmtAc = sq => sq ? `${(sq/43560).toFixed(sq/43560 < 10 ? 2 : 1)} ac` : 'UNKNOWN';
const fmtDate = t => t ? new Date(t).toLocaleDateString() : '—';
function haversineMi(a, b){ const R=3958.8, d2r=Math.PI/180; const dLat=(b[1]-a[1])*d2r, dLng=(b[0]-a[0])*d2r; const h=Math.sin(dLat/2)**2+Math.cos(a[1]*d2r)*Math.cos(b[1]*d2r)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
function distTo(p){ return S.userPos ? haversineMi(S.userPos, [p.lng, p.lat]) : null; }
let toastT; function toast(msg, ms=2600){ const t=$('toast'); t.textContent=msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add('hidden'), ms); }
function setStatus(msg){ $('status').textContent = msg; }
function titleCase(s){ return String(s||'').toLowerCase().replace(/\b\w/g, c=>c.toUpperCase()); }
function cleanAddr(a){ return titleCase(String(a||'').replace(/\s{2,}/g,', ').trim()); }
function isIOS(){ return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1); }
function isAndroid(){ return /Android/i.test(navigator.userAgent); }
function pucFamily(puc){ const c=String(puc||''); if(!c) return 'UNKNOWN'; const m={ '0':'Vacant land','1':'Commercial','2':'Residential','3':'Industrial','4':'Agricultural','5':'Rural','6':'Res. / misc','7':'Utility','8':'Mining / other','9':'Government / exempt' }; return `${m[c[0]]||'Other'} (county code ${c})`; }
function legalClass(lc){ const c=String(lc||''); if(!c) return 'UNKNOWN'; const m={ '1':'Class 1 — commercial/industrial','2':'Class 2 — vacant land / agricultural','3':'Class 3 — primary residence','4':'Class 4 — rental residential','6':'Class 6','7':'Class 7','8':'Class 8','9':'Class 9 — government leased' }; return (m[c[0]]||'Class')+` (${c})`; }
function pointInPoly(pt, poly){ // poly: [[ [lng,lat],... ], holes...]
  let inside=false; const ring=poly[0]; for(let i=0,j=ring.length-1;i<ring.length;j=i++){ const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1]; if(((yi>pt[1])!==(yj>pt[1]))&&(pt[0]<(xj-xi)*(pt[1]-yi)/(yj-yi)+xi)) inside=!inside; } return inside; }

// ---------- property model ----------
function parcelToProperty(f){
  const a=f.properties, apn=a.APN;
  const existing=S.parcels.get(apn);
  const p = existing || { id:'apn:'+apn, kind:'parcel', apn, firstSeen:Date.now() };
  Object.assign(p, {
    name: cleanAddr(a.PHYSICAL_ADDRESS) || `Parcel ${a.APN_DASH||apn}`,
    address: cleanAddr(a.PHYSICAL_ADDRESS) || 'UNKNOWN', city: titleCase(a.PHYSICAL_CITY||a.JURISDICTION||'') || 'UNKNOWN', zip:a.PHYSICAL_ZIP||'',
    lat:a.LATITUDE, lng:a.LONGITUDE, sqft:a.LAND_SIZE||null, owner:a.OWNER_NAME||'UNKNOWN', puc:a.PUC, lc:a.LC_CUR, zoning:a.CITY_ZONING, jurisdiction:a.JURISDICTION,
    constYear:a.CONST_YEAR||null, subname:a.SUBNAME||null, apnDash:a.APN_DASH||apn, saleDate:a.SALE_DATE||null, taxYear:a.TAX_YR_CUR||null,
    geometry:f.geometry, exempt: EXEMPT_RE.test(a.OWNER_NAME||'') || String(a.LC_CUR||'').startsWith('9'),
    sources:[{ label:'Maricopa County Assessor — parcel record', url:CFG.parcelPage(apn) }, { label:'Maricopa County Assessor GIS (live query)', url:'https://gis.mcassessor.maricopa.gov/arcgis/rest/services/Parcels/MapServer/0' }],
    updated: Date.now()
  });
  if (p.lat==null || p.lng==null) { const c=centroid(f.geometry); p.lng=c[0]; p.lat=c[1]; }
  S.parcels.set(apn, p); return p;
}
function centroid(g){ const ring=(g.type==='Polygon'?g.coordinates[0]:g.coordinates[0][0])||[]; let x=0,y=0; ring.forEach(c=>{x+=c[0];y+=c[1];}); return ring.length?[x/ring.length,y/ring.length]:[0,0]; }
function obsFor(p){ return S.local.obs[p.id] || []; }
function statusesOf(p){
  const set=new Set(); if(p.kind==='pin') p.statuses.forEach(s=>set.add(s));
  obsFor(p).forEach(o=>(o.statuses||[]).forEach(s=>set.add(s)));
  return [...set];
}
function primaryStatus(p){ const st=statusesOf(p); for(const s of STATUS_PRIORITY) if(st.includes(s)) return s; return p.kind==='pin'?'pin':'candidate'; }
function capacityOf(p){ const o=obsFor(p).slice().reverse().find(o=>o.capacity!=null); if(o) return {v:o.capacity, src:'employee report'}; if(p.kind==='pin'&&p.capacity!=null) return {v:p.capacity, src:'employee pin'}; const osm=osmOnParcel(p).find(x=>x.tags.capacity); if(osm) return {v:+osm.tags.capacity, src:'OpenStreetMap'}; return null; }
function lastUpdated(p){ const o=obsFor(p); const t=o.length?o[o.length-1].t:p.updated; return t; }
function authOf(p){ const o=obsFor(p).slice().reverse().find(o=>o.auth&&o.auth!=='UNKNOWN'); return o?o.auth:(p.auth||'UNKNOWN'); }
function osmOnParcel(p){ if(!p.geometry||p.kind!=='parcel') return []; const poly=p.geometry.type==='Polygon'?p.geometry.coordinates:p.geometry.coordinates[0]; return S.osm.filter(o=>o.center&&pointInPoly([o.center.lon,o.center.lat],poly)); }
function score(p){ // 0–100 discovery score from documented attributes only. Never implies permission.
  let s=0, why=[];
  const ac=(p.sqft||0)/43560; if(ac>=0.5){ const v=Math.min(30, Math.round(ac*6)); s+=v; why.push(`lot size ${fmtAc(p.sqft)} (+${v})`); }
  const st=statusesOf(p); const bonus={ verified:25, forlease:15, vacant:15, closed:12, abandoned:8, lowactivity:10 }; st.forEach(k=>{ if(bonus[k]){ s+=bonus[k]; why.push(`${STATUS_LABEL[k].toLowerCase()} (+${bonus[k]})`); } });
  const cap=capacityOf(p); if(cap){ const v=Math.min(15, Math.round(cap.v/10)); s+=v; why.push(`${cap.v} spaces via ${cap.src} (+${v})`); }
  const osm=osmOnParcel(p).length; if(osm){ s+=10; why.push(`${osm} mapped parking area${osm>1?'s':''} (+10)`); }
  const o=obsFor(p); const last=o[o.length-1]; if(last){ if(last.access==='Yes'){s+=10;why.push('reported accessible (+10)');} if(last.shared==='No'){s+=5;why.push('not shared (+5)');} if(last.cars!=null&&last.cars<=5){s+=5;why.push('few cars observed (+5)');} }
  if(p.exempt){ s-=20; why.push('government/exempt owner (−20)'); }
  return { v:Math.max(0,Math.min(100,s)), why };
}

// ---------- map ----------
function init(){
  S.map = new maplibregl.Map({ container:'map', style:CFG.styles.dark, center:CFG.phoenix.center, zoom:CFG.phoenix.zoom, attributionControl:{compact:true}, maxZoom:19, pitchWithRotate:true });
  const map=S.map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch:true }), 'top-right');
  map.on('style.load', ()=>{ if(!map.getSource('parcels')) addDataLayers(); refreshSources(); });
  map.on('load', ()=>{ setStatus('Zoom in or tap FIND NEAREST LOT'); queryViewport(); });
  map.on('moveend', ()=>{ queryViewport(); if(S.osmOn) loadOsm(); });
  map.on('click', 'pts', e=>openPreview(e.features[0].properties.id));
  map.on('click', 'parcel-fill', e=>{ if(map.queryRenderedFeatures(e.point,{layers:['pts']}).length) return; openPreview(e.features[0].properties.id); });
  map.on('click', 'osm-fill', e=>{ if(map.queryRenderedFeatures(e.point,{layers:['pts','parcel-fill']}).length) return; const t=JSON.parse(e.features[0].properties.tags||'{}'); toast(`OSM parking: ${t.name||'(unnamed)'} · capacity ${t.capacity||'UNKNOWN'} · access ${t.access||'UNKNOWN'}`, 4000); });
  ['pts','parcel-fill'].forEach(l=>{ map.on('mouseenter', l, ()=>map.getCanvas().style.cursor='pointer'); map.on('mouseleave', l, ()=>map.getCanvas().style.cursor=''); });
  let pressT; map.on('touchstart', e=>{ if(e.originalEvent.touches.length>1) return; pressT=setTimeout(()=>{ openPinForm(e.lngLat.lat, e.lngLat.lng); }, 700); }); map.on('touchend', ()=>clearTimeout(pressT)); map.on('touchmove', ()=>clearTimeout(pressT));
  map.on('contextmenu', e=>openPinForm(e.lngLat.lat, e.lngLat.lng));
  wireUI(); locate(true); handleHash();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
}
function addDataLayers(){
  const map=S.map;
  map.addSource('parcels', { type:'geojson', data:emptyFC() });
  map.addSource('pts', { type:'geojson', data:emptyFC(), cluster:true, clusterRadius:46, clusterMaxZoom:15 });
  map.addSource('osm', { type:'geojson', data:emptyFC() });
  map.addLayer({ id:'osm-fill', type:'fill', source:'osm', minzoom:CFG.osmZoom, paint:{ 'fill-color':'#22d3ee', 'fill-opacity':0.12 } });
  map.addLayer({ id:'osm-line', type:'line', source:'osm', minzoom:CFG.osmZoom, paint:{ 'line-color':'#22d3ee', 'line-width':1.5, 'line-dasharray':[2,1.5] } });
  map.addLayer({ id:'parcel-fill', type:'fill', source:'parcels', minzoom:CFG.polyZoom, paint:{ 'fill-color':['get','color'], 'fill-opacity':['case',['boolean',['get','sel'],false],0.35,0.14] } });
  map.addLayer({ id:'parcel-line', type:'line', source:'parcels', minzoom:CFG.polyZoom, paint:{ 'line-color':['get','color'], 'line-width':['case',['boolean',['get','sel'],false],3,1.2] } });
  map.addLayer({ id:'clusters', type:'circle', source:'pts', filter:['has','point_count'], paint:{ 'circle-color':'#f5c542', 'circle-opacity':0.9, 'circle-radius':['step',['get','point_count'],16,25,20,100,26], 'circle-stroke-width':2, 'circle-stroke-color':'#0f1117' } });
  map.addLayer({ id:'cluster-count', type:'symbol', source:'pts', filter:['has','point_count'], layout:{ 'text-field':'{point_count_abbreviated}', 'text-size':12, 'text-font':['Noto Sans Bold'] }, paint:{ 'text-color':'#1a1200' } });
  map.addLayer({ id:'pts', type:'circle', source:'pts', filter:['!',['has','point_count']], paint:{ 'circle-color':['get','color'], 'circle-radius':['interpolate',['linear'],['zoom'],12,5,16,9], 'circle-stroke-width':2, 'circle-stroke-color':'#0f1117', 'circle-opacity':0.95 } });
  // clusters need to be clickable too
  map.on('click','clusters', e=>{ const f=e.features[0]; map.getSource('pts').getClusterExpansionZoom(f.properties.cluster_id).then(z=>map.easeTo({center:f.geometry.coordinates, zoom:z})); });
  if(S.three) add3d();
}
function add3d(){ const map=S.map; if(map.getLayer('3d')||!map.getSource('openmaptiles')) return; map.addLayer({ id:'3d', type:'fill-extrusion', source:'openmaptiles', 'source-layer':'building', minzoom:14, paint:{ 'fill-extrusion-color':'#3a4150', 'fill-extrusion-height':['coalesce',['get','render_height'],8], 'fill-extrusion-base':['coalesce',['get','render_min_height'],0], 'fill-extrusion-opacity':0.7 } }, 'osm-fill'); }
const emptyFC = ()=>({ type:'FeatureCollection', features:[] });

function visibleProperties(){
  const f=S.filter; const chips=f.chips; const all=chips.has('all');
  const out=[];
  for(const p of S.parcels.values()){
    if(f.hideExempt && p.exempt) continue;
    if((p.sqft||0) < f.minAcres*43560 && p.kind==='parcel') continue;
    if(!all){ const st=statusesOf(p); if(!st.some(s=>chips.has(s))) continue; }
    out.push(p);
  }
  for(const pin of S.local.pins){ if(!all){ if(!statusesOf(pin).some(s=>chips.has(s))) continue; } out.push(pin); }
  return out;
}
function refreshSources(){
  const map=S.map; if(!map.getSource('pts')) return;
  const props=visibleProperties();
  const pts={ type:'FeatureCollection', features:props.map(p=>({ type:'Feature', geometry:{type:'Point',coordinates:[p.lng,p.lat]}, properties:{ id:p.id, color:COLORS[primaryStatus(p)] } })) };
  const polys={ type:'FeatureCollection', features: S.filter.showPolys ? props.filter(p=>p.geometry).map(p=>({ type:'Feature', geometry:p.geometry, properties:{ id:p.id, color:COLORS[primaryStatus(p)], sel: S.selected===p.id } })) : [] };
  map.getSource('pts').setData(pts); map.getSource('parcels').setData(polys);
  map.getSource('osm').setData({ type:'FeatureCollection', features:S.osm.filter(o=>o.geometry).map(o=>({ type:'Feature', geometry:o.geometry, properties:{ tags:JSON.stringify(o.tags||{}) } })) });
}

// ---------- county parcel queries ----------
function whereClause(){
  const f=S.filter; const parts=[`LAND_SIZE >= ${Math.round(f.minAcres*43560)}`];
  if(f.useFam==='any') parts.push(`LC_CUR LIKE '1%'`);
  else if(f.useFam==='1') parts.push(`LC_CUR LIKE '1%' AND PUC LIKE '1%'`);
  else if(f.useFam==='3') parts.push(`LC_CUR LIKE '1%' AND PUC LIKE '3%'`);
  else if(f.useFam==='0') parts.push(`LC_CUR LIKE '2%'`);
  return parts.join(' AND ');
}
async function fetchParcels(params){
  if(S.abort) S.abort.abort(); const ac=new AbortController(); S.abort=ac;
  const body=new URLSearchParams(Object.assign({ f:'geojson', outFields:CFG.outFields, returnGeometry:'true', geometryPrecision:'6', outSR:'4326', inSR:'4326', where:whereClause() }, params));
  const r=await fetch(CFG.parcels, { method:'POST', body, signal:ac.signal });
  if(!r.ok) throw new Error('County GIS HTTP '+r.status);
  const j=await r.json(); if(j.error) throw new Error(j.error.message||'County GIS error');
  return j;
}
let qT;
function queryViewport(){
  clearTimeout(qT); qT=setTimeout(async ()=>{
    const map=S.map, z=map.getZoom();
    if(z < CFG.minQueryZoom){ setStatus(`Zoom in to load county parcels (zoom ${z.toFixed(0)}/${CFG.minQueryZoom}) or tap FIND NEAREST LOT`); refreshSources(); return; }
    const b=map.getBounds(); const key=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>v.toFixed(4)).join(',')+whereClause();
    if(key===S.lastQueryKey) return; S.lastQueryKey=key;
    setStatus('Loading county parcels…');
    try{
      const j=await fetchParcels({ geometry:`${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`, geometryType:'esriGeometryEnvelope' });
      j.features.forEach(parcelToProperty); refreshSources();
      const n=visibleProperties().filter(p=>p.kind==='parcel'&&b.contains([p.lng,p.lat])).length;
      setStatus(`${n} county candidate${n===1?'':'s'} in view` + (j.exceededTransferLimit||j.properties?.exceededTransferLimit ? ' · limit hit, zoom in for more' : '') + (S.osmOn?' · OSM parking on':''));
    }catch(e){ if(e.name!=='AbortError'){ setStatus('County GIS unavailable right now — showing cached results'); refreshSources(); } }
  }, 250);
}
async function findNearest(){
  if(!S.userPos){ toast('Getting your location…'); await locate(false); if(!S.userPos){ toast('Location unavailable. Allow location access or search an address.'); return; } }
  setStatus('Searching nearby…'); $('btnNearest').disabled=true;
  try{
    const miles=S.filter.radius; const j=await fetchParcels({ geometry:`${S.userPos[0]},${S.userPos[1]}`, geometryType:'esriGeometryPoint', distance:String(Math.round(miles*1609.34)), units:'esriSRUnit_Meter' });
    j.features.forEach(parcelToProperty); refreshSources();
    const list=visibleProperties().map(p=>({p,d:distTo(p)})).filter(x=>x.d!=null&&x.d<=miles);
    openList(`Within ${miles} mi of you`, list.map(x=>x.p), 'nearest');
    if(!list.length) toast('No candidates in range with current filters. Widen the radius in FILTERS.');
  }catch(e){ toast('County GIS unavailable: '+e.message); }
  finally{ $('btnNearest').disabled=false; }
}
async function loadByApn(apn){
  try{ const j=await fetchParcels({ where:`APN='${apn.replace(/[^0-9A-Za-z]/g,'')}'` }); if(!j.features.length){ toast('Parcel not found'); return null; } const p=parcelToProperty(j.features[0]); refreshSources(); return p; }catch(e){ toast('Could not load parcel'); return null; }
}

// ---------- OSM parking (Overpass) ----------
let osmT;
function loadOsm(){
  clearTimeout(osmT); osmT=setTimeout(async ()=>{
    const map=S.map; if(map.getZoom()<CFG.osmZoom){ setStatus('Zoom in closer for OSM parking areas'); return; }
    const b=map.getBounds(); const bbox=`${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
    const q=`[out:json][timeout:25];(way["amenity"="parking"](${bbox});relation["amenity"="parking"](${bbox}););out tags center geom;`;
    for(const url of CFG.overpass){
      try{ const r=await fetch(url,{ method:'POST', body:q }); if(!r.ok) continue; const j=await r.json();
        S.osm=j.elements.map(el=>({ id:el.id, tags:el.tags||{}, center:el.center, geometry: el.type==='way'&&el.geometry ? { type:'Polygon', coordinates:[el.geometry.map(g=>[g.lon,g.lat])] } : null }));
        refreshSources(); toast(`${S.osm.length} OSM parking areas loaded`); return; }catch(e){}
    }
    toast('OpenStreetMap (Overpass) unavailable right now');
  }, 300);
}

// ---------- geolocation ----------
let geoCtrlMarker;
function locate(silent){
  return new Promise(res=>{
    if(!navigator.geolocation){ if(!silent) toast('Geolocation not supported'); return res(); }
    navigator.geolocation.getCurrentPosition(pos=>{
      S.userPos=[pos.coords.longitude, pos.coords.latitude];
      if(!geoCtrlMarker){ const el=document.createElement('div'); el.className='maplibregl-user-location-dot'; geoCtrlMarker=new maplibregl.Marker({element:el}).setLngLat(S.userPos).addTo(S.map); } else geoCtrlMarker.setLngLat(S.userPos);
      if(!silent || S.map.getZoom()<12) S.map.flyTo({ center:S.userPos, zoom:Math.max(S.map.getZoom(),14), speed:1.4 });
      $('btnLocate').classList.add('active'); res();
    }, err=>{ if(!silent) toast(err.code===1?'Location permission denied — use search instead.':'Could not get location.'); res(); }, { enableHighAccuracy:true, timeout:12000, maximumAge:30000 });
  });
}

// ---------- search ----------
let searchT, searchMarker;
async function doSearch(q){
  const box=$('searchResults'); if(!q.trim()){ box.classList.add('hidden'); return; }
  const [w,s,e,n]=CFG.metroBbox; const results=[];
  try{
    const r=await fetch(`${CFG.nominatim}?format=jsonv2&limit=6&countrycodes=us&viewbox=${w},${n},${e},${s}&bounded=1&q=${encodeURIComponent(q+' Arizona')}`, { headers:{ 'Accept':'application/json' } });
    if(r.ok){ (await r.json()).forEach(x=>{ const parts=x.display_name.split(',').map(s=>s.trim()); results.push({ name:parts.slice(0,2).join(', '), sub:parts.slice(2,5).join(', '), lat:+x.lat, lng:+x.lon, bbox:x.boundingbox }); }); }
  }catch(e){}
  if(/^\d+\s+\w/.test(q.trim())){ // looks like a street address: also try county parcels
    try{ const j=await fetchParcels({ where:`UPPER(PHYSICAL_ADDRESS) LIKE '${q.trim().toUpperCase().replace(/'/g,"''")}%'`, resultRecordCount:'5' }); j.features.forEach(f=>{ const p=parcelToProperty(f); results.unshift({ name:p.name, sub:`County parcel ${p.apnDash} · ${p.city}`, lat:p.lat, lng:p.lng, id:p.id }); }); refreshSources(); }catch(e){}
  }
  const seen=new Set(); for(let i=results.length-1;i>=0;i--){ const k=results[i].name+'|'+results[i].sub; if(seen.has(k)) results.splice(i,1); else seen.add(k); }
  box.innerHTML = results.length ? results.map((r,i)=>`<div data-i="${i}">${esc(r.name)}<small>${esc(r.sub)}</small></div>`).join('') : '<div>No results in the Phoenix area<small>Try a street address, business name, or city</small></div>';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-i]').forEach(el=>el.onclick=()=>{ const r=results[+el.dataset.i]; box.classList.add('hidden'); $('search').blur();
    if(r.id){ S.map.flyTo({center:[r.lng,r.lat],zoom:17}); setTimeout(()=>openPreview(r.id),600); return; }
    if(searchMarker) searchMarker.remove(); searchMarker=new maplibregl.Marker({color:'#ff8a00'}).setLngLat([r.lng,r.lat]).addTo(S.map);
    if(r.bbox){ const [s1,n1,w1,e1]=r.bbox.map(Number); const big=Math.abs(n1-s1)>0.02; S.map.fitBounds([[w1,s1],[e1,n1]],{padding:60,maxZoom:big?13:16}); } else S.map.flyTo({center:[r.lng,r.lat],zoom:16}); });
}

// ---------- preview / details ----------
function getProp(id){ return id.startsWith('pin:') ? S.local.pins.find(p=>p.id===id) : S.parcels.get(id.slice(4)); }
function badges(p){ const st=statusesOf(p); const list=st.length?st:[p.kind==='pin'?'pin':'candidate']; return list.map(s=>`<span class="badge" style="background:${COLORS[s]}">${STATUS_LABEL[s]}</span>`).join('') + (p.kind==='parcel'&&!st.length?'<span class="badge" style="background:#2a2f3d;color:#9aa0b0">UNVERIFIED</span>':''); }
function openPreview(id){
  const p=getProp(id); if(!p) return; S.selected=id; refreshSources(); closeSheets(['preview']);
  $('pvTitle').textContent=p.name; $('pvSub').textContent=p.kind==='pin'?`Employee pin · ${p.city||''}`:`${p.city} · APN ${p.apnDash}`;
  $('pvBadges').innerHTML=badges(p); const cap=capacityOf(p); $('pvCap').textContent=cap?`~${cap.v}`:'UNKNOWN'; $('pvDist').textContent=fmtMi(distTo(p)); $('pvAcres').textContent=fmtAc(p.sqft); $('pvUpd').textContent=fmtDate(lastUpdated(p));
  $('pvDetails').onclick=()=>openDetails(id); $('pvNav').onclick=()=>openNav(p);
  $('preview').classList.remove('hidden');
  if(location.hash!==`#apn-${p.apn||''}` && p.kind==='parcel') history.replaceState(null,'',`#apn-${p.apn}`);
}
function openDetails(id){
  const p=getProp(id); if(!p) return; const sc=score(p); const cap=capacityOf(p); const obs=obsFor(p); const osm=osmOnParcel(p); const d=distTo(p);
  const fav=S.local.fav.includes(id), vis=S.local.visited.includes(id); const auth=authOf(p);
  const roughCeil = p.sqft ? Math.round(p.sqft*0.4/325) : null;
  $('detBody').innerHTML=`
    <div class="det-title">${esc(p.name)}</div>
    <div class="det-sub">${p.kind==='pin'?'Employee pin':'County parcel'} · ${esc(p.city)}${p.jurisdiction&&p.jurisdiction!==p.city.toUpperCase()?' · jurisdiction '+esc(titleCase(p.jurisdiction)):''}</div>
    <div class="badges">${badges(p)} <span class="badge" style="background:${auth==='APPROVED'?COLORS.verified:auth==='DENIED'?COLORS.closed:'#2a2f3d'};color:${auth==='APPROVED'||auth==='DENIED'?'#0b0d12':'#e8eaf0'}">ACCESS: ${auth}</span></div>
    <div class="warn">Discovery tool only. A high score never implies permission to enter. Owner authorization: <b>${auth}</b>.</div>
    <div class="det-actions">
      <button class="wide" id="dNav">➤ NAVIGATE ${d!=null?'· '+fmtMi(d):''}</button>
      <button id="dFav" class="${fav?'on':''}"><span>${fav?'★':'☆'}</span>FAVORITE</button>
      <button id="dReport"><span>✎</span>REPORT</button>
      <button id="dPhoto"><span>📷</span>ADD PHOTO</button>
      <button id="dCopy"><span>⧉</span>COPY</button>
      <button id="dShare"><span>⇪</span>SHARE</button>
      <button id="dVisited" class="${vis?'on':''}"><span>${vis?'✓':'○'}</span>VISITED</button>
      <button id="dReview"><span>⚑</span>REQUEST REVIEW</button>
      <button id="dSat"><span>🛰</span>AERIAL</button>
    </div>
    <div class="sec">Suitability (discovery score)</div>
    <div class="score"><b>${sc.v}</b><div class="bar"><i style="width:${sc.v}%"></i></div></div>
    <div class="note" style="font-size:12px;color:var(--muted)">${sc.why.length?esc(sc.why.join(' · ')):'No documented attributes yet'}</div>
    <div class="sec">Parking</div>
    <div class="kv">
      <div><span>Est. capacity</span><b>${cap?`~${cap.v} <small>(${esc(cap.src)})</small>`:'UNKNOWN'}</b></div>
      <div><span>Rough ceiling from lot size</span><b>${roughCeil!=null?`≈${roughCeil} <small>if 40% paved — estimate, not observed</small>`:'UNKNOWN'}</b></div>
      <div><span>OSM parking areas on parcel</span><b>${osm.length?osm.map(o=>`${o.tags.name||'parking'}${o.tags.capacity?' ('+o.tags.capacity+' spaces)':''}${o.tags.access?' · access='+o.tags.access:''}`).map(esc).join('<br>'):(S.osmOn?'none mapped':'turn on P overlay to check')}</b></div>
      <div><span>Driving time</span><b>UNKNOWN <small>(no routing service configured)</small></b></div>
    </div>
    <div class="sec">Property</div>
    <div class="kv">
      <div><span>Parcel (APN)</span><b>${esc(p.apnDash||'—')}</b></div>
      <div><span>GPS</span><b>${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</b></div>
      <div><span>Lot size</span><b>${fmtAc(p.sqft)}${p.sqft?` <small>(${p.sqft.toLocaleString()} sq ft)</small>`:''}</b></div>
      <div><span>County use</span><b>${esc(pucFamily(p.puc))}</b></div>
      <div><span>Legal class</span><b>${esc(legalClass(p.lc))}</b></div>
      <div><span>Built</span><b>${esc(p.constYear||'UNKNOWN')}</b></div>
      <div><span>Owner (county record)</span><b>${esc(p.owner||'UNKNOWN')}</b></div>
      <div><span>Zoning</span><b>${esc(p.zoning&&p.zoning!=='CONTACT LOCAL JURISDICTION'?p.zoning:'UNKNOWN — check '+(p.jurisdiction||'city'))}</b></div>
      <div><span>Building sq ft</span><b>UNKNOWN <small>(not in county GIS feed)</small></b></div>
      <div><span>Subdivision</span><b>${esc(p.subname||'—')}</b></div>
    </div>
    <div class="sec">Vacancy / closure evidence</div>
    ${obs.length? obs.slice().reverse().map(o=>`<div class="note"><b>${(o.statuses||[]).map(s=>STATUS_LABEL[s]).join(', ')||'Observation'}</b> — ${esc(o.notes||'')}
      <small>${fmtDate(o.t)} ${new Date(o.t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · occupied: ${esc(o.occupied||'?')} · cars: ${o.cars??'?'} · accessible: ${esc(o.access||'?')} · shared: ${esc(o.shared||'?')} · permission: ${esc(o.auth||'UNKNOWN')} · ${esc(o.reporter||'this device')} · UNVERIFIED</small>
      ${o.url?`<a href="${esc(o.url)}" target="_blank" rel="noopener" style="color:var(--accent2);font-size:12px">Listing link</a>`:''}${o.photo?`<img src="${o.photo}" alt="field photo">`:''}</div>`).join('')
      : '<div class="note">No evidence recorded. County parcel records show ownership and land use only — they do <b>not</b> indicate whether a building is vacant.</div>'}
    <div class="sec">Street-level preview</div>
    <div class="note">Street View API not configured (needs a Google Maps Platform key with billing). Open externally instead:<br>
      <a href="https://www.google.com/maps?q=&layer=c&cbll=${p.lat},${p.lng}" target="_blank" rel="noopener" style="color:var(--accent2)">Google Street View at this point ↗</a><br>
      <a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener" style="color:var(--accent2)">Google Maps satellite ↗</a><br>
      <small>Street View imagery is historical and may be outdated.</small></div>
    <div class="sec">Data sources</div>
    <div class="src">${(p.sources||[]).map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>`).join('')}
      ${osm.length?`<a href="https://www.openstreetmap.org/#map=18/${p.lat}/${p.lng}" target="_blank" rel="noopener">OpenStreetMap (© OSM contributors, ODbL) ↗</a>`:''}</div>
    <div class="kv"><div><span>First discovered</span><b>${fmtDate(p.firstSeen)}</b></div><div><span>Last updated</span><b>${fmtDate(lastUpdated(p))}</b></div></div>`;
  $('dNav').onclick=()=>openNav(p);
  $('dFav').onclick=()=>{ toggleIn(S.local.fav,id); saveLocal(); openDetails(id); };
  $('dVisited').onclick=()=>{ toggleIn(S.local.visited,id); saveLocal(); openDetails(id); };
  $('dReport').onclick=()=>openPinForm(p.lat,p.lng,p);
  $('dPhoto').onclick=()=>openPinForm(p.lat,p.lng,p,true);
  $('dCopy').onclick=()=>copy(`${p.address}, ${p.city}\n${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`,'Address + coordinates copied');
  $('dShare').onclick=()=>share(p); $('detShare').onclick=()=>share(p);
  $('dReview').onclick=()=>{ addObs(p,{ statuses:[], notes:'REVIEW REQUESTED', reviewRequested:true }); toast('Review request saved (admin review comes with the team database)'); openDetails(id); };
  $('dSat').onclick=()=>{ closeDetails(); setStyle('hybrid'); S.map.flyTo({center:[p.lng,p.lat],zoom:18}); };
  $('details').classList.remove('hidden'); $('detBody').scrollTop=0;
}
function closeDetails(){ $('details').classList.add('hidden'); }
function toggleIn(arr,v){ const i=arr.indexOf(v); i>=0?arr.splice(i,1):arr.push(v); }
function addObs(p,o){ const list=S.local.obs[p.id]||(S.local.obs[p.id]=[]); list.push(Object.assign({ t:Date.now(), reporter:'this device' },o)); saveLocal(); refreshSources(); }
async function copy(text,msg){ try{ await navigator.clipboard.writeText(text); toast(msg||'Copied'); }catch(e){ toast('Copy not allowed here — long-press to select: '+text, 5000); } }
function shareUrl(p){ const u=new URL(location.href); u.hash = p.kind==='parcel' ? `apn-${p.apn}` : `pin-${p.id.slice(4)}`; return u.toString(); }
async function share(p){ const url=shareUrl(p); const data={ title:'Valley Lot Finder', text:`${p.name} — ${p.city}`, url }; if(navigator.share){ try{ await navigator.share(data); return; }catch(e){ if(e.name==='AbortError') return; } } copy(url,'Link copied — send it to a coworker'); }
function openNav(p){
  const lat=p.lat.toFixed(6), lng=p.lng.toFixed(6), label=encodeURIComponent(p.name);
  const apple=`https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d&q=${label}`;
  const gmaps=`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  const waze=`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  const geo=`geo:${lat},${lng}?q=${lat},${lng}(${label})`;
  let items=[];
  if(isIOS()) items=[[apple,'Apple Maps','Turn-by-turn'],[gmaps,'Google Maps','Opens app if installed'],[waze,'Waze','']];
  else if(isAndroid()) items=[[gmaps,'Google Maps','Turn-by-turn'],[geo,'Other navigation app','Any app that handles geo: links'],[waze,'Waze','']];
  else items=[[gmaps,'Google Maps directions','Opens in browser'],[apple,'Apple Maps (web)',''],[`https://www.openstreetmap.org/directions?route=;${lat},${lng}`,'OpenStreetMap directions','']];
  $('navBody').innerHTML = items.map(([u,t,s])=>`<a href="${u}" target="_blank" rel="noopener">${t}<small>${s}</small></a>`).join('') +
    `<button id="navCopy">Copy coordinates<small>${lat}, ${lng}</small></button><button id="navCopyAddr">Copy address<small>${esc(p.address)}, ${esc(p.city)}</small></button>` +
    `<div class="hint">Distance from you: <b>${fmtMi(distTo(p))}</b> (straight line). Driving time UNKNOWN — no routing service configured.</div>`;
  $('navCopy').onclick=()=>copy(`${lat}, ${lng}`,'Coordinates copied'); $('navCopyAddr').onclick=()=>copy(`${p.address}, ${p.city}`,'Address copied');
  $('navSheet').classList.remove('hidden'); $('backdrop').classList.remove('hidden');
}

// ---------- list sheet ----------
let listItems=[];
function openList(title, props, sort){ listItems=props; $('listTitle').textContent=title; if(sort) $('sortSel').value=sort; renderList(); closeSheets(['listSheet']); $('listSheet').classList.remove('hidden'); }
function renderList(){
  const sort=$('sortSel').value; const arr=listItems.slice();
  const key={ nearest:p=>distTo(p)??1e9, largest:p=>-(p.sqft||0), score:p=>-score(p).v, verified:p=>-(obsFor(p).filter(o=>(o.statuses||[]).includes('verified')).map(o=>o.t).pop()||0), added:p=>-(p.firstSeen||0) }[sort];
  arr.sort((a,b)=>key(a)-key(b));
  $('listBody').innerHTML = arr.length ? arr.map(p=>`<div class="card" data-id="${esc(p.id)}"><div class="dot" style="background:${COLORS[primaryStatus(p)]}"></div><div class="ct"><b>${esc(p.name)}</b><small>${esc(p.city)} · ${fmtAc(p.sqft)} · ${fmtMi(distTo(p))} · score ${score(p).v}${p.exempt?' · gov/exempt':''}</small></div><button class="go" data-nav="${esc(p.id)}">GO</button></div>`).join('') : '<div class="hint">Nothing to list. Zoom in to load county parcels, or tap FIND NEAREST LOT.</div>';
  $('listBody').querySelectorAll('.card').forEach(el=>el.onclick=e=>{ const id=el.dataset.id; if(e.target.dataset.nav){ openNav(getProp(id)); return; } const p=getProp(id); S.map.flyTo({center:[p.lng,p.lat],zoom:Math.max(S.map.getZoom(),16)}); openPreview(id); });
}

// ---------- pins & reports ----------
let pinTarget=null;
function openPinForm(lat,lng,prop,photoFocus){
  pinTarget=prop||null; $('pinForm').reset(); $('pinLat').value=lat; $('pinLng').value=lng; $('pinApn').value=prop?.apn||'';
  $('pinTitle').textContent = prop ? 'Field report' : 'Add candidate pin';
  $('pinWhere').textContent = prop ? `${prop.name} · ${prop.city}` : `Location: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  $('pinName').value = prop ? prop.name : ''; $('pinName').required = !prop;
  closeSheets(['pinSheet']); $('pinSheet').classList.remove('hidden'); $('backdrop').classList.remove('hidden');
  if(photoFocus) setTimeout(()=>$('pinPhoto').click(),300);
}
async function submitPin(e){
  e.preventDefault();
  const statuses=[...$('pinStatus').selectedOptions].map(o=>o.value);
  const cap=$('pinCap').value===''?null:+$('pinCap').value, cars=$('pinCars').value===''?null:+$('pinCars').value;
  let photo=null; const file=$('pinPhoto').files[0]; if(file){ try{ photo=await shrinkImage(file); }catch(err){ toast('Photo could not be processed'); } }
  const obs={ statuses, capacity:cap, cars, access:$('pinAccess').value, shared:$('pinShared').value, auth:$('pinAuth').value, url:$('pinUrl').value||null, notes:$('pinNotes').value, photo, occupied: statuses.includes('vacant')||statuses.includes('closed')?'no':'?' };
  if(pinTarget){ addObs(pinTarget,obs); toast('Report saved on this device (unverified)'); closeSheets(); openDetails(pinTarget.id); }
  else{
    const pin={ id:'pin:'+Date.now().toString(36), kind:'pin', name:$('pinName').value.trim(), address:'UNKNOWN', city:'', lat:+$('pinLat').value, lng:+$('pinLng').value, statuses, capacity:cap, auth:$('pinAuth').value, firstSeen:Date.now(), updated:Date.now(), sources:[{label:'Employee field submission (this device)',url:location.href.split('#')[0]}] };
    S.local.pins.push(pin); S.local.obs[pin.id]=[Object.assign({t:Date.now(),reporter:'this device'},obs)]; saveLocal(); refreshSources(); toast('Pin saved on this device (unverified)'); closeSheets(); openPreview(pin.id);
  }
}
function shrinkImage(file){ return new Promise((res,rej)=>{ const img=new Image(); const url=URL.createObjectURL(file); img.onload=()=>{ const max=1024; const sc=Math.min(1,max/Math.max(img.width,img.height)); const c=document.createElement('canvas'); c.width=img.width*sc; c.height=img.height*sc; c.getContext('2d').drawImage(img,0,0,c.width,c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg',0.7)); }; img.onerror=rej; img.src=url; }); }
function exportData(){ const blob=new Blob([JSON.stringify(S.local,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`valley-lot-finder-${new Date().toISOString().slice(0,10)}.json`; document.body.appendChild(a); a.click(); a.remove(); }

// ---------- styles ----------
function setStyle(name){
  if(name===S.styleName) return; S.styleName=name; S.lastQueryKey='';
  document.querySelectorAll('#stylePick [data-style]').forEach(b=>b.classList.toggle('on',b.dataset.style===name));
  S.map.setStyle(CFG.styles[name], { diff:false });
}

// ---------- UI wiring ----------
function closeSheets(keep=[]){ ['preview','listSheet','filters','pinSheet','navSheet'].forEach(id=>{ if(!keep.includes(id)) $(id).classList.add('hidden'); }); $('stylePick').classList.add('hidden'); if(!keep.some(k=>['pinSheet','navSheet'].includes(k))) $('backdrop').classList.add('hidden'); }
function wireUI(){
  $('search').addEventListener('input', e=>{ clearTimeout(searchT); $('searchClear').classList.toggle('hidden',!e.target.value); searchT=setTimeout(()=>doSearch(e.target.value),450); });
  $('search').addEventListener('keydown', e=>{ if(e.key==='Enter'){ clearTimeout(searchT); doSearch(e.target.value); } });
  $('searchClear').onclick=()=>{ $('search').value=''; $('searchResults').classList.add('hidden'); $('searchClear').classList.add('hidden'); if(searchMarker){searchMarker.remove();searchMarker=null;} };
  document.querySelectorAll('#chips .chip[data-f]').forEach(b=>b.onclick=()=>{ const f=b.dataset.f; const c=S.filter.chips; if(f==='all'){ c.clear(); c.add('all'); } else { c.delete('all'); c.has(f)?c.delete(f):c.add(f); if(!c.size) c.add('all'); } document.querySelectorAll('#chips .chip[data-f]').forEach(x=>x.classList.toggle('on',c.has(x.dataset.f))); refreshSources(); if(!c.has('all')) toast('Status filters show only properties with employee-reported status'); });
  $('moreFilters').onclick=()=>{ closeSheets(['filters']); $('filters').classList.remove('hidden'); };
  $('filtClose').onclick=()=>closeSheets(); $('minAcres').oninput=e=>$('minAcresLbl').textContent=`${(+e.target.value).toFixed(2)} ac`; $('radius').oninput=e=>$('radiusLbl').textContent=`${e.target.value} mi`;
  $('filtApply').onclick=()=>{ Object.assign(S.filter,{ minAcres:+$('minAcres').value, radius:+$('radius').value, useFam:$('useFam').value, hideExempt:$('hideExempt').checked, showPolys:$('showPolys').checked }); S.lastQueryKey=''; closeSheets(); refreshSources(); queryViewport(); };
  $('btnLocate').onclick=()=>locate(false); $('btnNearest').onclick=findNearest;
  $('btnList').onclick=()=>{ const b=S.map.getBounds(); openList('Candidates in view', visibleProperties().filter(p=>b.contains([p.lng,p.lat])), S.userPos?'nearest':'largest'); };
  $('btnAddPin').onclick=()=>{ if(S.userPos) openPinForm(S.userPos[1],S.userPos[0]); else { const c=S.map.getCenter(); openPinForm(c.lat,c.lng); toast('Pin placed at map center (no GPS). Long-press the map to place precisely.'); } };
  $('btnOsm').onclick=()=>{ S.osmOn=!S.osmOn; $('btnOsm').classList.toggle('active',S.osmOn); if(S.osmOn) loadOsm(); else { S.osm=[]; refreshSources(); } };
  $('btnStyle').onclick=()=>$('stylePick').classList.toggle('hidden');
  document.querySelectorAll('#stylePick [data-style]').forEach(b=>b.onclick=()=>{ setStyle(b.dataset.style); $('stylePick').classList.add('hidden'); });
  $('toggleLegend').onclick=()=>{ S.legend=!S.legend; $('legend').classList.toggle('hidden',!S.legend); $('stylePick').classList.add('hidden'); };
  $('toggle3d').onclick=()=>{ S.three=!S.three; if(S.three){ if(S.styleName==='satellite'||S.styleName==='hybrid') toast('3D buildings need Dark or Street style'); add3d(); } else if(S.map.getLayer('3d')) S.map.removeLayer('3d'); $('stylePick').classList.add('hidden'); };
  $('exportData').onclick=()=>{ exportData(); $('stylePick').classList.add('hidden'); };
  $('pvClose').onclick=()=>{ $('preview').classList.add('hidden'); S.selected=null; refreshSources(); };
  $('listClose').onclick=()=>closeSheets(); $('sortSel').onchange=renderList;
  $('detClose').onclick=closeDetails; $('pinClose').onclick=()=>closeSheets(); $('navClose').onclick=()=>closeSheets(); $('backdrop').onclick=()=>closeSheets();
  $('pinForm').onsubmit=submitPin;
  window.addEventListener('hashchange', handleHash);
}
async function handleHash(){
  const h=location.hash; let m;
  if((m=h.match(/^#apn-([0-9A-Za-z]+)$/))){ const p=S.parcels.get(m[1])||await loadByApn(m[1]); if(p){ S.map.flyTo({center:[p.lng,p.lat],zoom:17}); openPreview(p.id); } }
  else if((m=h.match(/^#pin-(\w+)$/))){ const p=getProp('pin:'+m[1]); if(p){ S.map.flyTo({center:[p.lng,p.lat],zoom:17}); openPreview(p.id); } else toast('That pin lives on another device — pins sync once the team database is connected.'); }
}

document.addEventListener('DOMContentLoaded', init);
