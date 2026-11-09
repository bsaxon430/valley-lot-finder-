/* Valley Lot Finder — simple edition.
   Shows only confirmed candidate lots: for lease / vacant / abandoned / closed.
   Pins come from lots.json (human-confirmed) and, optionally, OpenStreetMap vacant/disused tags.
   Tap a pin → photo (Google Street View if a key is set, else aerial), address, NAVIGATE. */
'use strict';
const C = Object.assign({ googleKey:'', includeOsm:true }, window.VLF_CONFIG || {});
const METRO = { s:33.20, w:-112.65, n:33.80, e:-111.50 };
const PIN = '#ff8a00';
const LABEL = { forlease:'FOR LEASE', vacant:'VACANT', abandoned:'ABANDONED', closed:'CLOSED', spot:'TEAM SPOT' };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let map, lots = [], userPos = null, userMarker = null, selected = null, view = 'all', clusterer = null, src = 'ours'; const markers = new Map();
const MARKCOLOR = { great:'#22c55e', revisit:'#facc15', skip:'#8b8f99' };
let toastT; const toast = (m, ms=2800) => { const t=$('toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add('hidden'), ms); };
const status = m => $('status').textContent = m;
const mi = (a,b) => { const R=3958.8,r=Math.PI/180,dLat=(b[1]-a[1])*r,dLng=(b[0]-a[0])*r,h=Math.sin(dLat/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); };
const fmtMi = m => m==null?'':(m<0.1?`${Math.round(m*5280)} ft`:`${m.toFixed(m<10?1:0)} mi`);
const dist = l => userPos ? mi(userPos,[l.lng,l.lat]) : null;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
const isAndroid = () => /Android/i.test(navigator.userAgent);

function loadGoogle(){
  return new Promise((res, rej) => {
    if (window.google && google.maps) return res();
    window.__vlfReady = res;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(C.googleKey)}&callback=__vlfReady&loading=async&v=weekly`;
    s.onerror = rej; document.head.appendChild(s);
  });
}
async function init(){
  await loadGoogle();
  map = new google.maps.Map($('map'), { center:{ lat:33.47, lng:-112.02 }, zoom:11, mapTypeId:'hybrid', disableDefaultUI:true, gestureHandling:'greedy', clickableIcons:false, maxZoom:20, minZoom:8, backgroundColor:'#0b0d12',
    mapId: C.mapId || 'DEMO_MAP_ID', renderingType: google.maps.RenderingType.VECTOR, headingInteractionEnabled: true, tiltInteractionEnabled: false });
  clusterer = new markerClusterer.MarkerClusterer({ map, markers:[], renderer:{ render({ count, position }){
    const r = count >= 50 ? 26 : count >= 10 ? 20 : 16;
    return new google.maps.Marker({ position, zIndex: 1000 + count, icon:{ path:google.maps.SymbolPath.CIRCLE, scale:r, fillColor: view==='all' ? PINCOLOR.none : PINCOLOR[view], fillOpacity:1, strokeColor:'#ffffff', strokeWeight:3 }, label:{ text:String(count), color: view==='revisit' ? '#3b2a00' : '#ffffff', fontSize:'13px', fontWeight:'700', fontFamily:'system-ui' } });
  } }, onClusterClick:(e, cluster, m) => { const b = cluster.bounds; m.fitBounds(b, 60); } });
  $('btnLocate').onclick = async () => {
    startCompass();
    // second tap: back to normal — stop following, north up
    if (follow) { follow = false; $('btnLocate').classList.remove('following'); if (map.getHeading()) map.setHeading(0); return; }
    follow = true; $('btnLocate').classList.add('following');
    await locate(false);
    if (userPos){ map.panTo({ lat:userPos[1], lng:userPos[0] }); if (map.getZoom() < 15) map.setZoom(16); }
  };
  map.addListener('dragstart', () => { if (follow){ follow = false; $('btnLocate').classList.remove('following'); } });
  $('btnCompass').onclick = () => map.setHeading(0);
  map.addListener('heading_changed', () => { const h = map.getHeading()||0; $('btnCompass').classList.toggle('hidden', Math.abs(((h+180)%360)-180) < 1); $('btnCompass').firstElementChild.style.transform = `rotate(${-h}deg)`; drawBeam(); });
  $('btnLayers').onclick = () => {
    const opening = $('layers').classList.contains('hidden');
    if (opening){ $('notesList').classList.add('hidden'); $('notesHead').setAttribute('aria-expanded', false); $('layers').scrollTop = 0; }
    $('layers').classList.toggle('hidden'); syncLayersUI(); renderAllNotes(); if (opening) $('layers').scrollTop = 0;
  };
  $('notesHead').onclick = () => { const open = $('notesList').classList.toggle('hidden') === false; $('notesHead').setAttribute('aria-expanded', open); if (open) $('notesHead').scrollIntoView({ block:'start', behavior:'smooth' }); else $('layers').scrollTo({ top:0, behavior:'smooth' }); };
  map.addListener('click', () => $('layers').classList.add('hidden'));
  document.querySelectorAll('#layers [data-mt]').forEach(b => b.onclick = () => { map.setMapTypeId(b.dataset.mt); try { localStorage.setItem('vlf-maptype', b.dataset.mt); } catch(e){} syncLayersUI(); });
  document.querySelectorAll('#layers [data-src]').forEach(b => b.onclick = () => { src = b.dataset.src; try { localStorage.setItem('vlf-src', src); } catch(e){} closeCard(); refresh(); updateStatus(); fitVisible(); syncLayersUI(); });
  try { const mt = localStorage.getItem('vlf-maptype'); if (mt) map.setMapTypeId(mt); const s = localStorage.getItem('vlf-src'); if (s) src = s; } catch(e){}
  $('btnNearest').onclick = nearest;
  document.querySelectorAll('.view').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('cClose').onclick = closeCard; $('listClose').onclick = () => $('list').classList.add('hidden'); $('navClose').onclick = () => $('nav').classList.add('hidden');
  window.addEventListener('hashchange', openFromHash);
  $('cDelSpot').onclick = () => { if (selected && confirm('Remove this spot for everyone?')) spots.remove(selected); };
  setupLongPress();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
  await loadLots(); await syncShared(); setInterval(syncShared, 30000); locate(true); openFromHash();
  // coming back from the home screen / background: pull the latest team data + any app update right away
  const resume = () => { if (document.hidden) return; syncShared(); if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(()=>{}); };
  document.addEventListener('visibilitychange', resume); window.addEventListener('pageshow', resume); window.addEventListener('focus', resume);
}
const GLYPH = { great:'<path d="M13 19.5l-3.6-3.6 1.6-1.6 2 2 4.9-4.9 1.6 1.6z" fill="#fff"/>', revisit:'<text x="16" y="21" text-anchor="middle" font-family="system-ui,Arial" font-weight="700" font-size="15" fill="#3b2a00">?</text>', skip:'<path d="M11.5 11.5l9 9m0-9l-9 9" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>', none:'<circle cx="16" cy="16" r="4.5" fill="#fff"/>' };
const PINCOLOR = { great:'#34a853', revisit:'#fbc02d', skip:'#3c4043', none:'#a142f4' };
// how a note reads: "Skipped:" always follows the lot's CURRENT mark, never what was typed
const noteText = (id, text) => { const t = String(text||'').replace(/^skipped:\s*/i, ''); return marks.get(id)==='skip' ? 'Skipped: ' + t : t; };
const markBadge = id => { const m = marks.get(id); if (!m) return ''; const ch = { great:'✓', revisit:'?', skip:'✕' }[m]; return `<i class="mb mb-${m}">${ch}</i>`; };
const SRCHINT = { ours:'Our researched lots, including spots added on the map.', whole:'Whole building empty and the parking lot isn\'t shared with other businesses.', osm:'Buildings the public has tagged vacant / abandoned on OpenStreetMap.', all:'Everything: ours plus OpenStreetMap.' };
const iconCache = {};
function pinIcon(mark, sel){
  const key = (mark||'none') + (sel?'!':'');
  if (!iconCache[key]){
    const c = PINCOLOR[mark||'none'];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40"><path d="M16 39c-1 0-9.5-11-12.4-16.3A14 14 0 1 1 28.4 22.7C25.5 28 17 39 16 39z" fill="#fff"/><circle cx="16" cy="16" r="11.5" fill="${c}"/>${GLYPH[mark||'none']}</svg>`;
    const sz = sel ? 46 : 36;
    iconCache[key] = { url:'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), scaledSize:new google.maps.Size(sz, sz*1.25), anchor:new google.maps.Point(sz/2, sz*1.25) };
  }
  return iconCache[key];
}
function refresh(){
  if (!clusterer) return;
  const list = [];
  for (const l of visible()){
    let m = markers.get(l.id);
    if (!m){ m = new google.maps.Marker({ position:{ lat:l.lat, lng:l.lng }, title:l.name }); m.addListener('click', () => openCard(l.id)); markers.set(l.id, m); }
    m.setIcon(pinIcon(marks.get(l.id), selected===l.id)); m.setZIndex(selected===l.id ? 999 : 1);
    list.push(m);
  }
  clusterer.clearMarkers(true); clusterer.addMarkers(list);
}

// ---------- data ----------
async function loadLots(){
  status('Loading confirmed lots…');
  try { const r = await fetch('lots.json?v=' + Date.now()); const j = await r.json(); lots = (j.lots||[]).map(l => Object.assign({ kind:'confirmed' }, l)); }
  catch(e){ toast('Could not load lots.json'); }
  refresh(); updateStatus();
  if (C.includeOsm) loadOsm();
}
async function loadOsm(){
  // pre-fetched nightly by GitHub (scripts/fetch-osm.mjs) so this is instant
  try {
    const r = await fetch('osm.json', { cache:'no-cache' }); if (!r.ok) return;
    const j = await r.json();
    j.lots.forEach(l => lots.push(Object.assign({ kind:'osm', added:null }, l)));
    refresh(); updateStatus();
  } catch(e){}
}

// ---------- location ----------
// ---------- live location (follows you while driving) ----------
let watchId = null, follow = false, devHeading = null, gpsHeading = null, beamMarker = null, firstFix = [], panned = false, compassOn = false, beamRaf = 0;
function onFix(p){
  userPos = [p.coords.longitude, p.coords.latitude];
  const pos = { lat:userPos[1], lng:userPos[0] };
  const spd = p.coords.speed, hd = p.coords.heading;
  if (spd != null && spd > 2 && hd != null && !isNaN(hd)) gpsHeading = hd; else if (spd != null && spd < 0.8) gpsHeading = null;
  if (!userMarker){ userMarker = new google.maps.Marker({ map, position:pos, zIndex:2001, clickable:false, icon:{ path:google.maps.SymbolPath.CIRCLE, scale:9, fillColor:'#1a73e8', fillOpacity:1, strokeColor:'#ffffff', strokeWeight:3 } }); }
  else userMarker.setPosition(pos);
  if (beamMarker) beamMarker.setPosition(pos);
  drawBeam();
  $('btnLocate').classList.add('active');
  if (follow) map.panTo(pos);
  else if (!panned && !location.hash){ panned = true; map.panTo(pos); if (map.getZoom() < 12.5) map.setZoom(13); }
  panned = true;
  const waiting = firstFix; firstFix = []; waiting.forEach(f => f());
}
function startWatch(silent){
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onFix, err => {
    if (err.code === 1){ navigator.geolocation.clearWatch(watchId); watchId = null; if (!silent) toast('Location permission denied'); }
    const waiting = firstFix; firstFix = []; waiting.forEach(f => f());
  }, { enableHighAccuracy:true, maximumAge:0, timeout:20000 });
}
function locate(silent){
  return new Promise(res => {
    if (!navigator.geolocation){ if(!silent) toast('Location not supported'); return res(); }
    if (userPos && watchId !== null) return res();
    firstFix.push(res); startWatch(silent);
    setTimeout(() => { const i = firstFix.indexOf(res); if (i >= 0){ firstFix.splice(i, 1); if (!silent && !userPos) toast('Could not get location'); res(); } }, 15000);
  });
}
// heading: GPS course while moving (best in a car), phone compass when standing still
function startCompass(){
  if (compassOn) return; compassOn = true;
  const h = e => {
    let hd = (e.webkitCompassHeading != null) ? e.webkitCompassHeading : (e.absolute && e.alpha != null ? 360 - e.alpha : null);
    if (hd == null) return;
    hd = (hd + ((screen.orientation && screen.orientation.angle) || window.orientation || 0) + 360) % 360;
    devHeading = hd; drawBeam();
  };
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'){
      DeviceOrientationEvent.requestPermission().then(s => { if (s === 'granted') window.addEventListener('deviceorientation', h); }).catch(() => {});
    } else { window.addEventListener('deviceorientationabsolute', h); window.addEventListener('deviceorientation', h); }
  } catch(e){}
}
const BEAM = 'M0 0 L-15 -40 A43 43 0 0 1 15 -40 Z';
function drawBeam(){
  if (beamRaf) return;
  beamRaf = requestAnimationFrame(() => { beamRaf = 0;
    if (!userPos) return;
    const hd = gpsHeading != null ? gpsHeading : devHeading;
    if (hd == null){ if (beamMarker) beamMarker.setVisible(false); return; }
    const rot = (hd - (map.getHeading()||0) + 360) % 360;
    const icon = { path:BEAM, fillColor:'#1a73e8', fillOpacity:0.28, strokeWeight:0, scale:1, rotation:rot, anchor:new google.maps.Point(0,0) };
    if (!beamMarker) beamMarker = new google.maps.Marker({ map, position:{ lat:userPos[1], lng:userPos[0] }, zIndex:2000, clickable:false, icon });
    else { beamMarker.setIcon(icon); beamMarker.setVisible(true); }
  });
}

// ---------- card ----------
function lot(id){ return lots.find(l => l.id===id); }
function openCard(id){
  const l = lot(id); if (!l) return; selected = id; refresh();
  $('list').classList.add('hidden'); $('nav').classList.add('hidden');
  $('cBadge').textContent = LABEL[l.status] || (l.status||'').toUpperCase(); $('cBadge').style.background = PIN; $('cBadge').style.visibility = (l.kind==='spot' && !l.status) ? 'hidden' : '';
  $('cStatus').classList.toggle('hidden', l.kind!=='spot'); renderStatus(l);
  $('cName').textContent = l.name; $('cAddr').textContent = l.address;
  const d = dist(l); $('cMeta').textContent = [d!=null ? `${fmtMi(d)} away` : null, l.note].filter(Boolean).join(' · ');
  const hasSrc = !!(l.source && l.source.url); $('cSrc').style.display = hasSrc ? '' : 'none'; if (hasSrc){ $('cSrc').textContent = (l.source.label || 'Source') + ' ↗'; $('cSrc').href = l.source.url; }
  $('cNav').onclick = () => openNav(l);
  $('cStreet').href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${l.lat.toFixed(6)},${l.lng.toFixed(6)}`;
  renderMarks(l);
  $('skipWhy').classList.add('hidden');
  const applyMark = next => { marks.set(l.id, next); renderMarks(l); refresh(); updateStatus();
    if (next==='skip' && view==='all') { closeCard(); toast('Removed from the map — find it under SKIPPED'); }
    else if (next===null && view!=='all') { closeCard(); toast('Put back on the main map'); }
    else if (next==='great') toast('Marked great');
  };
  document.querySelectorAll('.marks button').forEach(b => b.onclick = () => {
    const v = b.dataset.mark; const cur = marks.get(l.id); const next = cur===v ? null : v;
    // skipping asks why first (shared, chained, fenced...), and the reason is saved as a note everyone sees
    // a pin someone added by long-press that gets skipped was probably a mistake: delete it outright, no reason/notes kept
    if (next==='skip' && l.kind==='spot'){ spots.remove(l.id); toast('Spot deleted'); return; }
    if (next==='skip'){ $('skipWhy').classList.toggle('hidden'); return; }
    $('skipWhy').classList.add('hidden'); applyMark(next);
  });
  document.querySelectorAll('#skipWhy button').forEach(b => b.onclick = () => {
    $('skipWhy').classList.add('hidden');
    if (b.dataset.why) {
      // don't stack a second identical reason — the existing note just picks up the Skipped label from the mark
      const plain = s => String(s||'').replace(/^skipped:\s*/i, '').trim().toLowerCase();
      if (!notes.get(l.id).some(n => plain(n.text) === plain(b.dataset.why))) notes.add(l.id, 'Skipped: ' + b.dataset.why);
      renderNotes(l);
    }
    applyMark('skip');
  });
  renderNotes(l); $('noteForm').onsubmit = e => { e.preventDefault(); const t = $('noteText').value.trim(); if (!t) return; notes.add(l.id, t); $('noteText').value=''; renderNotes(l); };
  setPhoto(l);
  $('card').classList.remove('hidden');
  if (l.kind!=='osm') history.replaceState(null, '', '#' + l.id);
  $('cDelSpot').classList.toggle('hidden', l.kind!=='spot');
  if (map.getZoom() < 16) map.setZoom(16); map.panTo({ lat:l.lat, lng:l.lng }); map.panBy(0, 180);
}
// Marks (great / revisit / skip) and notes. Local cache always; shared Supabase table when configured.
const sb = (C.supabaseUrl && C.supabaseKey && window.supabase) ? window.supabase.createClient(C.supabaseUrl, C.supabaseKey) : null;
const cache = { marks: {}, notes: {} };
try { cache.marks = JSON.parse(localStorage.getItem('vlf-marks') || '{}'); cache.notes = JSON.parse(localStorage.getItem('vlf-notes') || '{}'); } catch(e){}
function persist(){ try { localStorage.setItem('vlf-marks', JSON.stringify(cache.marks)); localStorage.setItem('vlf-notes', JSON.stringify(cache.notes)); } catch(e){} }
const marks = {
  get(id){ return cache.marks[id] || null; },
  set(id, v){ if (v) cache.marks[id]=v; else delete cache.marks[id]; persist();
    if (sb) (v ? sb.from('marks').upsert({ lot_id:id, mark:v, updated_at:new Date().toISOString() }) : sb.from('marks').delete().eq('lot_id', id)).then(({error}) => { if (error) toast('Shared save failed — kept on this phone'); }); },
  count(v){ return Object.values(cache.marks).filter(x=>x===v).length; }
};
async function syncShared(){
  if (!sb) return;
  try {
    const [{ data: m }, { data: n }, { data: s }] = await Promise.all([ sb.from('marks').select('lot_id,mark'), sb.from('notes').select('id,lot_id,text,created_at').order('created_at'), sb.from('spots').select('id,name,address,lat,lng,status,created_at') ]);
    if (s) spots.applyRemote(s);
    if (m) { cache.marks = {}; m.forEach(r => { if (r.mark) cache.marks[r.lot_id] = r.mark; }); }
    if (n) { cache.notes = {}; n.forEach(r => (cache.notes[r.lot_id] = cache.notes[r.lot_id] || []).push({ t: Date.parse(r.created_at), text: r.text, sid: r.id })); }
    persist(); refresh(); updateStatus(); if (selected) renderMarksAndNotes(selected);
  } catch(e){}
}
function renderMarksAndNotes(id){ const l = lot(id); if (!l) return; renderMarks(l); renderNotes(l); }
function inSrc(l){ return src==='all' || (src==='whole' ? !!l.whole : src==='osm' ? l.kind==='osm' : l.kind!=='osm'); }
function visible(){ return lots.filter(l => { if (!inSrc(l)) return false; const m = marks.get(l.id); return view==='all' ? m!=='skip' : m===view; }); }
// every note on every lot, newest first; tap one to jump to that lot
function renderAllNotes(){
  const rows = [];
  for (const [id, list] of Object.entries(cache.notes)) { const l = lot(id); if (!l) continue; (list||[]).forEach(n => rows.push({ id, name: l.name, text: n.text, t: n.t })); }
  rows.sort((a, b) => b.t - a.t);
  $('notesHead').textContent = rows.length ? `Notes (${rows.length})` : 'Notes';
  $('notesList').innerHTML = rows.length ? rows.map(r => `<button data-id="${esc(r.id)}"><span class="nt">${markBadge(r.id)}${esc(noteText(r.id, r.text))}</span><span class="nw">${esc(r.name)} · ${new Date(r.t).toLocaleDateString([], {month:'short', day:'numeric'})}</span></button>`).join('') : '<div class="empty">No notes yet</div>';
  $('notesList').querySelectorAll('button').forEach(b => b.onclick = () => {
    $('layers').classList.add('hidden'); const id = b.dataset.id, l = lot(id);
    // make sure the pin is actually on the map (right tab + pin set) before opening it
    if (l && !visible().some(x => x.id === id)) {
      if (!inSrc(l)) { src = 'all'; try { localStorage.setItem('vlf-src', src); } catch(e){} }
      const m = marks.get(id); view = m || 'all';
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.dataset.view === view));
      refresh(); updateStatus();
    }
    openCard(id);
  });
}
function syncLayersUI(){ $('srcHint').textContent = SRCHINT[src] || ''; const mt = map.getMapTypeId()==='roadmap' ? 'roadmap' : 'hybrid'; document.querySelectorAll('#layers [data-mt]').forEach(b => b.classList.toggle('on', b.dataset.mt===mt)); document.querySelectorAll('#layers [data-src]').forEach(b => b.classList.toggle('on', b.dataset.src===src)); }
function colorOf(l){ return PINCOLOR[marks.get(l.id)||'none']; }
function renderStatus(l){ const need = l.kind==='spot' && !l.status; $('cChoose').classList.toggle('hidden', !need); $('cStatus').classList.toggle('attn', need); document.querySelectorAll('#cStatus button').forEach(b => { b.classList.toggle('on', b.dataset.status===l.status); b.onclick = () => { const st = l.status===b.dataset.status ? null : b.dataset.status; spots.setStatus(l.id, st); $('cBadge').textContent = LABEL[st] || ''; $('cBadge').style.visibility = st ? '' : 'hidden'; renderStatus(l); }; }); }
function renderMarks(l){ const m = marks.get(l.id); document.querySelectorAll('.marks button').forEach(b => b.classList.toggle('on', b.dataset.mark===m)); }
function setView(v){ view=v; document.querySelectorAll('.view').forEach(b=>b.classList.toggle('on', b.dataset.view===v)); closeCard(); refresh(); updateStatus(); fitVisible(); }
function fitVisible(){
  const pts = visible().map(l=>({ lat:l.lat, lng:l.lng })); if (userPos) pts.push({ lat:userPos[1], lng:userPos[0] });
  if (!pts.length) return;
  const b = new google.maps.LatLngBounds(); pts.forEach(p => b.extend(p));
  map.fitBounds(b, { top:90, bottom:200, left:40, right:40 });
  google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 14) map.setZoom(14); });
}
function updateStatus(){ const n=visible().length; status(view==='all' ? `${n} lots on the map` : `${n} ${ {great:'great', revisit:'to revisit', skip:'skipped'}[view] } lot${n===1?'':'s'}`); document.querySelectorAll('.view').forEach(b=>{ const v=b.dataset.view; const c = v==='all' ? lots.filter(l=>inSrc(l)&&marks.get(l.id)!=='skip').length : lots.filter(l=>inSrc(l)&&marks.get(l.id)===v).length; b.textContent = `${ {all:'ALL',great:'GREAT',revisit:'REVISIT',skip:'SKIPPED'}[v] } ${c}`; }); }
const notes = {
  get(id){ return cache.notes[id] || []; },
  add(id, text){ const n = { t: Date.now(), text }; (cache.notes[id] = cache.notes[id] || []).push(n); persist();
    if (sb) sb.from('notes').insert({ lot_id:id, text }).select('id').single().then(({data, error}) => { if (error) toast('Shared save failed — kept on this phone'); else if (data) n.sid = data.id; }); },
  remove(id, t){ const list = cache.notes[id] || []; const i = list.findIndex(n => n.t === t); if (i < 0) return; const [n] = list.splice(i, 1); persist();
    if (sb) { const q = n.sid ? sb.from('notes').delete().eq('id', n.sid) : sb.from('notes').delete().eq('lot_id', id).eq('text', n.text); q.then(({error}) => { if (error) toast('Shared delete failed'); }); } }
};
function renderNotes(l){
  const list = notes.get(l.id);
  $('cNotes').innerHTML = list.slice().reverse().map(n => `<div><span>${esc(noteText(l.id, n.text))}<small>${new Date(n.t).toLocaleDateString()} ${new Date(n.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</small></span><button class="nx" data-t="${n.t}" aria-label="Delete note">✕</button></div>`).join('');
  $('cNotes').querySelectorAll('.nx').forEach(b => b.onclick = () => { notes.remove(l.id, Number(b.dataset.t)); renderNotes(l); });
}
// ---------- team spots (long-press on the map) ----------
const spots = {
  mk(r){ return { id:r.id, kind:'spot', name:r.name, address:r.address || `${(+r.lat).toFixed(5)}, ${(+r.lng).toFixed(5)}`, lat:+r.lat, lng:+r.lng, status:r.status||null, note:null, source:{ label:'Search Google for this address', url:'https://www.google.com/search?q=' + encodeURIComponent((r.address||'') + ' for lease') }, added:r.created_at||null }; },
  local(){ try { return JSON.parse(localStorage.getItem('vlf-spots')||'[]'); } catch(e){ return []; } },
  saveLocal(arr){ try { localStorage.setItem('vlf-spots', JSON.stringify(arr)); } catch(e){} },
  applyRemote(rows){
    const keep = lots.filter(l => l.kind!=='spot'); const ids = new Set(rows.map(r=>r.id));
    lots = keep.concat(rows.map(spots.mk)); spots.saveLocal(rows);
    for (const [id, m] of markers) if (id.startsWith('spot-') && !ids.has(id)) { m.setMap(null); markers.delete(id); }
    refresh(); updateStatus();
  },
  add(r){
    lots.push(spots.mk(r)); spots.saveLocal(spots.local().concat([r])); refresh(); updateStatus();
    if (sb) sb.from('spots').insert(r).then(({error}) => { if (error) toast(error.code==='42P01' ? 'Spot saved on this phone — shared table not set up yet' : 'Shared save failed — kept on this phone', 4000); else toast('Spot added for the whole team'); });
    else toast('Spot saved on this phone');
  },
  setStatus(id, st){
    const l = lot(id); if (!l) return; l.status = st; spots.saveLocal(spots.local().map(r => r.id===id ? Object.assign(r, { status: st }) : r));
    if (sb) sb.from('spots').update({ status: st }).eq('id', id).then(({error}) => { if (error) toast('Shared save failed'); });
  },
  remove(id){
    lots = lots.filter(l => l.id!==id); spots.saveLocal(spots.local().filter(r=>r.id!==id));
    delete cache.marks[id]; delete cache.notes[id]; persist();
    if (sb) { sb.from('marks').delete().eq('lot_id', id).then(()=>{}); sb.from('notes').delete().eq('lot_id', id).then(()=>{}); }
    const m = markers.get(id); if (m){ clusterer.removeMarker(m, true); m.setMap(null); markers.delete(id); }
    closeCard(); refresh(); updateStatus();
    if (sb) sb.from('spots').delete().eq('id', id).then(({error}) => { if (error) toast('Shared delete failed'); });
  }
};
function setupLongPress(){
  spots.local().forEach(r => lots.push(spots.mk(r)));
  let t = null, start = null;
  const cancel = () => { clearTimeout(t); t = null; };
  // pixel → lat/lng done by hand (Web Mercator) so it stays right when the map is rotated
  const el = $('map');
  const toLatLng = (x, y) => {
    const r = el.getBoundingClientRect(), c = map.getCenter(); if (!c) return null;
    const scale = 256 * Math.pow(2, map.getZoom()), h = (map.getHeading() || 0) * Math.PI / 180;
    const dx = x - r.left - r.width / 2, dy = y - r.top - r.height / 2;
    const wx = dx * Math.cos(h) - dy * Math.sin(h), wy = dx * Math.sin(h) + dy * Math.cos(h);
    const s = Math.sin(c.lat() * Math.PI / 180);
    const cx = (c.lng() + 180) / 360 * scale, cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
    const px = cx + wx, py = cy + wy;
    const lng = px / scale * 360 - 180, n = Math.PI - 2 * Math.PI * py / scale;
    return new google.maps.LatLng(180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng);
  };
  const arm = (x, y) => { cancel(); start = [x, y]; t = setTimeout(() => { t = null; const ll = toLatLng(x, y); if (ll) beginAdd(ll); }, 600); };
  el.addEventListener('touchstart', e => { if (e.touches.length===1) arm(e.touches[0].clientX, e.touches[0].clientY); else cancel(); }, { passive:true });
  el.addEventListener('touchmove', e => { if (!t || !start) return; const dx = e.touches[0].clientX-start[0], dy = e.touches[0].clientY-start[1]; if (dx*dx+dy*dy > 100) cancel(); }, { passive:true });
  el.addEventListener('touchend', cancel, { passive:true }); el.addEventListener('touchcancel', cancel, { passive:true });
  el.addEventListener('mousedown', e => { if (e.button===0 && !('ontouchstart' in window)) arm(e.clientX, e.clientY); });
  el.addEventListener('mouseup', cancel); el.addEventListener('mousemove', e => { if (t && start && Math.hypot(e.clientX-start[0], e.clientY-start[1]) > 10) cancel(); });
  ['dragstart','zoom_changed'].forEach(ev => map.addListener(ev, cancel));
}
function beginAdd(latLng){
  if (navigator.vibrate) navigator.vibrate(30);
  const pos = { lat: latLng.lat(), lng: latLng.lng() };
  const id = 'spot-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const coords = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
  const finish = (name, address) => {
    const r = { id, name, address, lat: pos.lat, lng: pos.lng, created_at: new Date().toISOString() };
    if (view!=='all'){ view='all'; document.querySelectorAll('.view').forEach(b=>b.classList.toggle('on', b.dataset.view==='all')); }
    spots.add(r); openCard(id);
  };
  let done = false; const fallback = setTimeout(() => { if (!done){ done = true; finish('Team spot', coords); } }, 2500);
  try { new google.maps.Geocoder().geocode({ location: pos }, (res, st) => {
    if (done) return; done = true; clearTimeout(fallback);
    const hit = st==='OK' && res && res.find(x => x.types.includes('street_address') || x.types.includes('premise')) || (res && res[0]);
    if (hit){ const full = hit.formatted_address.replace(/, USA$/,''); finish(full.split(',')[0].trim(), full); }
    else finish('Team spot', coords);
  }); } catch(e){ if (!done){ done = true; clearTimeout(fallback); finish('Team spot', coords); } }
}
function closeCard(){ $('card').classList.add('hidden'); selected=null; refresh(); history.replaceState(null,'',' '); }
function setPhoto(l){
  const box = $('photo'); box.innerHTML = '<div class="photo-empty">Loading photo…</div>';
  const show = (img, tag) => { box.innerHTML=''; box.appendChild(img); box.insertAdjacentHTML('beforeend', `<div class="tag">${tag}</div>`); };
  const load = (src, tag, onfail) => { const img = new Image(); img.alt = tag; img.onload = () => show(img, tag); img.onerror = onfail; img.src = src; if (img.complete && img.naturalWidth) show(img, tag); };
  const aerial = () => load(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${l.lng-0.0012},${l.lat-0.0007},${l.lng+0.0012},${l.lat+0.0007}&bboxSR=4326&size=720,420&format=jpg&f=image`, 'Aerial · © Esri', () => box.innerHTML = '<div class="photo-empty">No photo available</div>');
  if (!C.googleKey) return aerial();
  const legacy = () => fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${l.lat},${l.lng}&source=outdoor&key=${encodeURIComponent(C.googleKey)}`).then(r=>r.json()).then(m => {
    if (m.status !== 'OK') return aerial();
    load(`https://maps.googleapis.com/maps/api/streetview?size=720x420&location=${l.lat},${l.lng}&fov=90&source=outdoor&key=${encodeURIComponent(C.googleKey)}`, `Street View${m.date?' · '+m.date:''} · may be outdated`, aerial);
  }).catch(aerial);
  try {
    const svs = new google.maps.StreetViewService();
    const want = { location:{ lat:l.lat, lng:l.lng }, radius:120, preference:google.maps.StreetViewPreference.NEAREST, sources:[google.maps.StreetViewSource.GOOGLE] };
    svs.getPanorama(want, (data, st) => {
      if (st !== google.maps.StreetViewStatus.OK || !data || !data.location) return legacy();
      const p = data.location.latLng, pano = data.location.pano;
      const heading = google.maps.geometry ? google.maps.geometry.spherical.computeHeading(p, new google.maps.LatLng(l.lat, l.lng)) : bearing(p.lat(), p.lng(), l.lat, l.lng);
      const date = data.imageDate || '';
      $('cStreet').href = `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(pano)}&heading=${Math.round(heading)}&pitch=0&fov=90`;
      load(`https://maps.googleapis.com/maps/api/streetview?size=720x420&pano=${encodeURIComponent(pano)}&heading=${heading.toFixed(1)}&pitch=0&fov=90&key=${encodeURIComponent(C.googleKey)}`, `Street View${date?' · '+date:''}`, legacy);
    });
  } catch(e){ legacy(); }
}
function bearing(a1,o1,a2,o2){ const r=Math.PI/180, y=Math.sin((o2-o1)*r)*Math.cos(a2*r), x=Math.cos(a1*r)*Math.sin(a2*r)-Math.sin(a1*r)*Math.cos(a2*r)*Math.cos((o2-o1)*r); return (Math.atan2(y,x)/r+360)%360; }
function openNav(l){
  const lat=l.lat.toFixed(6), lng=l.lng.toFixed(6), q=encodeURIComponent(l.name);
  const apple=`https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d&q=${q}`, g=`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`, waze=`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  const items = isIOS() ? [[apple,'Apple Maps'],[g,'Google Maps'],[waze,'Waze']] : isAndroid() ? [[g,'Google Maps'],[`geo:${lat},${lng}?q=${lat},${lng}(${q})`,'Other navigation app'],[waze,'Waze']] : [[g,'Google Maps'],[apple,'Apple Maps']];
  $('navBody').innerHTML = items.map(([u,t]) => `<a class="navlink" href="${u}" target="_blank" rel="noopener">${t}<small>${esc(l.address)}</small></a>`).join('');
  $('nav').classList.remove('hidden');
}
async function nearest(){
  if (!userPos){ await locate(false); if (!userPos) return; }
  const arr = visible().map(l => ({ l, d:dist(l) })).sort((a,b) => a.d-b.d).slice(0, 25);
  $('listBody').innerHTML = arr.length ? arr.map(({l,d}) => `<div class="item" data-id="${esc(l.id)}"><div class="dot" style="background:${colorOf(l)}"></div><div class="t"><b>${esc(l.name)}</b><small>${esc(l.address)} · ${fmtMi(d)}${l.kind==='osm'?' · OSM':''}</small></div><button class="go">GO</button></div>`).join('') : '<div class="item">No lots yet.</div>';
  $('listBody').querySelectorAll('.item[data-id]').forEach(el => { el.onclick = e => { if (e.target.classList.contains('go')) openNav(lot(el.dataset.id)); else openCard(el.dataset.id); }; });
  $('card').classList.add('hidden'); $('list').classList.remove('hidden');
}
function openFromHash(){ const id = decodeURIComponent(location.hash.slice(1)); if (id && lot(id)) openCard(id); }

// swipe down on a sheet to close it
document.querySelectorAll('.sheet').forEach(sheet => {
  let y0=null, dy=0;
  sheet.addEventListener('touchstart', e => { const body = e.target.closest('.card-body,.listbody'); if (body && body.scrollTop > 0) return; y0 = e.touches[0].clientY; dy = 0; sheet.style.transition='none'; }, {passive:true});
  sheet.addEventListener('touchmove', e => { if (y0==null) return; dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = `translateY(${dy}px)`; }, {passive:true});
  sheet.addEventListener('touchend', () => { if (y0==null) return; sheet.style.transition=''; sheet.style.transform='';
    if (dy > 90) { if (sheet.id==='card') closeCard(); else sheet.classList.add('hidden'); } y0=null; });
});
document.addEventListener('DOMContentLoaded', init);
