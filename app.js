/* Valley Lot Finder — simple edition.
   Shows only confirmed candidate lots: for lease / vacant / abandoned / closed.
   Pins come from lots.json (human-confirmed) and, optionally, OpenStreetMap vacant/disused tags.
   Tap a pin → photo (Google Street View if a key is set, else aerial), address, NAVIGATE. */
'use strict';
const C = Object.assign({ googleKey:'', includeOsm:true }, window.VLF_CONFIG || {});
const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const METRO = { s:33.20, w:-112.65, n:33.80, e:-111.50 };
const COLOR = { forlease:'#ff8a00', vacant:'#a855f7', abandoned:'#8b8f99', closed:'#ef4444' };
const LABEL = { forlease:'FOR LEASE', vacant:'VACANT', abandoned:'ABANDONED', closed:'CLOSED' };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let map, lots = [], userPos = null, userMarker = null, selected = null;
let toastT; const toast = (m, ms=2800) => { const t=$('toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add('hidden'), ms); };
const status = m => $('status').textContent = m;
const mi = (a,b) => { const R=3958.8,r=Math.PI/180,dLat=(b[1]-a[1])*r,dLng=(b[0]-a[0])*r,h=Math.sin(dLat/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); };
const fmtMi = m => m==null?'':(m<0.1?`${Math.round(m*5280)} ft`:`${m.toFixed(m<10?1:0)} mi`);
const dist = l => userPos ? mi(userPos,[l.lng,l.lat]) : null;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
const isAndroid = () => /Android/i.test(navigator.userAgent);

async function init(){
  map = new maplibregl.Map({ container:'map', style:STYLE, center:[-112.02,33.47], zoom:10.3, attributionControl:{compact:true}, maxZoom:19 });
  map.addControl(new maplibregl.NavigationControl({ showCompass:true }), 'top-right');
  map.on('style.load', addLayers);
  map.on('click', 'pins', e => openCard(e.features[0].properties.id));
  map.on('click', 'clusters', e => { const f=e.features[0]; map.getSource('lots').getClusterExpansionZoom(f.properties.cluster_id).then(z => map.easeTo({ center:f.geometry.coordinates, zoom:z })); });
  ['pins','clusters'].forEach(l => { map.on('mouseenter', l, ()=>map.getCanvas().style.cursor='pointer'); map.on('mouseleave', l, ()=>map.getCanvas().style.cursor=''); });
  $('btnLocate').onclick = () => locate(false);
  $('btnNearest').onclick = nearest;
  $('cClose').onclick = closeCard; $('listClose').onclick = () => $('list').classList.add('hidden'); $('navClose').onclick = () => $('nav').classList.add('hidden');
  window.addEventListener('hashchange', openFromHash);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
  await loadLots(); locate(true); openFromHash();
}
function addLayers(){
  if (map.getSource('lots')) return;
  map.addSource('lots', { type:'geojson', data:fc(), cluster:true, clusterRadius:40, clusterMaxZoom:14 });
  map.addLayer({ id:'clusters', type:'circle', source:'lots', filter:['has','point_count'], paint:{ 'circle-color':'#ff8a00', 'circle-radius':['step',['get','point_count'],16,10,20,50,26], 'circle-stroke-width':2, 'circle-stroke-color':'#0f1117' } });
  map.addLayer({ id:'cluster-count', type:'symbol', source:'lots', filter:['has','point_count'], layout:{ 'text-field':'{point_count_abbreviated}', 'text-size':12, 'text-font':['Noto Sans Bold'] }, paint:{ 'text-color':'#1a1200' } });
  map.addLayer({ id:'pins', type:'circle', source:'lots', filter:['!',['has','point_count']], paint:{ 'circle-color':['get','color'], 'circle-radius':['case',['boolean',['get','sel'],false],12,9], 'circle-stroke-width':2.5, 'circle-stroke-color':'#0f1117' } });
  refresh();
}
const fc = () => ({ type:'FeatureCollection', features:[] });
function refresh(){
  const src = map.getSource('lots'); if (!src) return;
  src.setData({ type:'FeatureCollection', features: lots.map(l => ({ type:'Feature', geometry:{ type:'Point', coordinates:[l.lng,l.lat] }, properties:{ id:l.id, color:COLOR[l.status]||'#8b8f99', sel:selected===l.id } })) });
}

// ---------- data ----------
async function loadLots(){
  status('Loading confirmed lots…');
  try { const r = await fetch('lots.json?v=' + Date.now()); const j = await r.json(); lots = (j.lots||[]).map(l => Object.assign({ kind:'confirmed' }, l)); }
  catch(e){ toast('Could not load lots.json'); }
  refresh(); status(`${lots.length} lots on the map`);
  if (C.includeOsm) loadOsm();
}
async function loadOsm(){
  const b = `${METRO.s},${METRO.w},${METRO.n},${METRO.e}`;
  const q = `[out:json][timeout:60];(nwr["shop"="vacant"](${b});nwr["disused:shop"](${b});nwr["disused:amenity"](${b});nwr["abandoned:shop"](${b});nwr["abandoned:amenity"](${b});nwr["abandoned:building"](${b});nwr["building"]["disused"="yes"](${b});nwr["building"]["abandoned"="yes"](${b});nwr["vacant"="yes"](${b});nwr["disused"="yes"]["shop"](${b}););out tags center;`;
  for (const url of OVERPASS){
    try {
      const r = await fetch(url, { method:'POST', body:q }); if (!r.ok) continue;
      const j = await r.json(); let n = 0;
      j.elements.forEach(el => {
        const t = el.tags || {}; const c = el.center || (el.lat!=null ? { lat:el.lat, lon:el.lon } : null); if (!c) return;
        // only buildings / shops / businesses, not e.g. disused railways
        const kind = t['disused:shop'] || t['abandoned:shop'] || t['disused:amenity'] || t['abandoned:amenity'] || t['abandoned:building'] || t.shop || t.building || t.amenity;
        if (!kind || /railway|pipeline|canal|mine|quarry/.test(kind)) return;
        const abandoned = !!(t['abandoned:shop']||t['abandoned:amenity']||t['abandoned:building']||t.abandoned==='yes');
        const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
        lots.push({ id:'osm-'+el.type+el.id, kind:'osm', name:t.name || (t['old_name'] ? `Former ${t['old_name']}` : `${abandoned?'Abandoned':'Vacant'} ${String(kind).replace(/_/g,' ')}`),
          address: addr ? `${addr}${t['addr:city']?', '+t['addr:city']:''}` : 'Address not mapped', lat:c.lat, lng:c.lon, status: abandoned?'abandoned':'vacant',
          note: `Tagged on OpenStreetMap as ${abandoned?'abandoned':'vacant/disused'}${t['old_name']?' (formerly '+t['old_name']+')':''}. Community-mapped — confirm on site.`,
          source:{ label:'OpenStreetMap (© OSM contributors, ODbL)', url:`https://www.openstreetmap.org/${el.type}/${el.id}` }, added:null });
        n++;
      });
      refresh(); status(`${lots.length} lots on the map`); return;
    } catch(e){}
  }
  status(`${lots.length} lots on the map`);
}

// ---------- location ----------
function locate(silent){
  return new Promise(res => {
    if (!navigator.geolocation){ if(!silent) toast('Location not supported'); return res(); }
    navigator.geolocation.getCurrentPosition(p => {
      userPos = [p.coords.longitude, p.coords.latitude];
      if (!userMarker){ const el=document.createElement('div'); el.className='maplibregl-user-location-dot'; userMarker=new maplibregl.Marker({element:el}).setLngLat(userPos).addTo(map); } else userMarker.setLngLat(userPos);
      $('btnLocate').classList.add('active');
      if (!silent || !location.hash) map.flyTo({ center:userPos, zoom:Math.max(map.getZoom(), 12.5), speed:1.4 });
      res();
    }, err => { if(!silent) toast(err.code===1 ? 'Location permission denied' : 'Could not get location'); res(); }, { enableHighAccuracy:true, timeout:12000, maximumAge:30000 });
  });
}

// ---------- card ----------
function lot(id){ return lots.find(l => l.id===id); }
function openCard(id){
  const l = lot(id); if (!l) return; selected = id; refresh();
  $('list').classList.add('hidden'); $('nav').classList.add('hidden');
  $('cBadge').textContent = LABEL[l.status] || l.status.toUpperCase(); $('cBadge').style.background = COLOR[l.status] || '#8b8f99';
  $('cName').textContent = l.name; $('cAddr').textContent = l.address;
  const d = dist(l); $('cMeta').textContent = [d!=null ? `${fmtMi(d)} away` : null, l.note].filter(Boolean).join(' · ');
  $('cSrc').textContent = (l.source?.label || 'Source') + ' ↗'; $('cSrc').href = l.source?.url || '#';
  $('cSv').href = `https://www.google.com/maps?q=&layer=c&cbll=${l.lat},${l.lng}`;
  $('cNav').onclick = () => openNav(l);
  renderNotes(l); $('noteForm').onsubmit = e => { e.preventDefault(); const t = $('noteText').value.trim(); if (!t) return; notes.add(l.id, t); $('noteText').value=''; renderNotes(l); };
  setPhoto(l);
  $('card').classList.remove('hidden');
  if (l.kind==='confirmed') history.replaceState(null, '', '#' + l.id);
  map.easeTo({ center:[l.lng, l.lat], zoom:Math.max(map.getZoom(), 16), padding:{ bottom:360 } });
}
// Notes store. On-device for now; swap these three functions for a shared database (e.g. Supabase) to sync across phones.
const notes = {
  _all(){ try { return JSON.parse(localStorage.getItem('vlf-notes') || '{}'); } catch(e){ return {}; } },
  get(id){ return this._all()[id] || []; },
  add(id, text){ const a = this._all(); (a[id] = a[id] || []).push({ t: Date.now(), text }); try { localStorage.setItem('vlf-notes', JSON.stringify(a)); } catch(e){ toast('Could not save on this phone'); } }
};
function renderNotes(l){
  const list = notes.get(l.id);
  $('cNotes').innerHTML = list.slice().reverse().map(n => `<div>${esc(n.text)}<small>${new Date(n.t).toLocaleDateString()} ${new Date(n.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</small></div>`).join('');
}
function closeCard(){ $('card').classList.add('hidden'); selected=null; refresh(); history.replaceState(null,'',' '); }
function setPhoto(l){
  const box = $('photo'); box.innerHTML = '<div class="photo-empty">Loading photo…</div>';
  const aerial = () => { const img = new Image(); img.alt='Aerial view';
    img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${l.lng-0.0012},${l.lat-0.0007},${l.lng+0.0012},${l.lat+0.0007}&bboxSR=4326&size=720,420&format=jpg&f=image`;
    img.onload = () => { box.innerHTML=''; box.appendChild(img); box.insertAdjacentHTML('beforeend','<div class="tag">Aerial · © Esri</div>'); };
    img.onerror = () => box.innerHTML = '<div class="photo-empty">No photo available</div>'; };
  if (!C.googleKey) return aerial();
  const img = new Image(); img.alt = 'Street View';
  img.src = `https://maps.googleapis.com/maps/api/streetview?size=720x420&location=${l.lat},${l.lng}&fov=90&source=outdoor&key=${encodeURIComponent(C.googleKey)}`;
  // Google returns a gray placeholder when no imagery exists; check metadata first
  fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${l.lat},${l.lng}&source=outdoor&key=${encodeURIComponent(C.googleKey)}`).then(r=>r.json()).then(m => {
    if (m.status !== 'OK') return aerial();
    img.onload = () => { box.innerHTML=''; box.appendChild(img); box.insertAdjacentHTML('beforeend', `<div class="tag">Street View${m.date?' · '+m.date:''} · may be outdated</div>`); };
    img.onerror = aerial;
  }).catch(aerial);
}
function openNav(l){
  const lat=l.lat.toFixed(6), lng=l.lng.toFixed(6), q=encodeURIComponent(l.name);
  const apple=`https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d&q=${q}`, g=`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`, waze=`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  const items = isIOS() ? [[apple,'Apple Maps'],[g,'Google Maps'],[waze,'Waze']] : isAndroid() ? [[g,'Google Maps'],[`geo:${lat},${lng}?q=${lat},${lng}(${q})`,'Other navigation app'],[waze,'Waze']] : [[g,'Google Maps'],[apple,'Apple Maps']];
  $('navBody').innerHTML = items.map(([u,t]) => `<a class="navlink" href="${u}" target="_blank" rel="noopener">${t}<small>${esc(l.address)}</small></a>`).join('');
  $('nav').classList.remove('hidden');
}
async function nearest(){
  if (!userPos){ await locate(false); if (!userPos) return; }
  const arr = lots.map(l => ({ l, d:dist(l) })).sort((a,b) => a.d-b.d).slice(0, 25);
  $('listBody').innerHTML = arr.length ? arr.map(({l,d}) => `<div class="item" data-id="${esc(l.id)}"><div class="dot" style="background:${COLOR[l.status]}"></div><div class="t"><b>${esc(l.name)}</b><small>${esc(l.address)} · ${fmtMi(d)}${l.kind==='osm'?' · OSM':''}</small></div><button class="go">GO</button></div>`).join('') : '<div class="item">No lots yet.</div>';
  $('listBody').querySelectorAll('.item[data-id]').forEach(el => { el.onclick = e => { if (e.target.classList.contains('go')) openNav(lot(el.dataset.id)); else openCard(el.dataset.id); }; });
  $('card').classList.add('hidden'); $('list').classList.remove('hidden');
}
function openFromHash(){ const id = decodeURIComponent(location.hash.slice(1)); if (id && lot(id)) openCard(id); }

document.addEventListener('DOMContentLoaded', init);
