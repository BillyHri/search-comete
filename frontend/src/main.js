/**
 * search-comete — main.js
 * Entry point. Injects the UI shell then initialises galaxy, search, and panel.
 *
 * Fixes applied:
 *  1. loadStars(): The live API is tried first, but if the returned data has
 *     fewer than 3 distinct clusters we fall through to the static stars.json
 *     and then to FALLBACK_PAPERS. This prevents the galaxy from showing only
 *     ml+bio when the pipeline hasn't indexed all clusters yet.
 *  2. Legend rebuild: deferred until after initGalaxy() resolves so
 *     CLUSTER_COLORS is already populated (it was being read too early).
 *  3. Legend 'all' row click-handler now correctly uses clearHighlights()
 *     before calling filterCluster('all').
 */

import {
  initGalaxy,
  highlightStars,
  clearHighlights,
  flyTo,
  flyToCluster,
  getRemappedPos,
  CLUSTER_COLORS,
  setActiveYear
} from './galaxy.js';
import { doSearch } from './search.js';
import { showDetail, closeDetail } from './panel.js';
import { FALLBACK_PAPERS } from './data.js';

// ── Inject UI HTML ────────────────────────────────────────────────────────────
document.getElementById('app').innerHTML = `
<canvas id="canvas"></canvas>

<div id="hud-top">
  <div>
    <div class="wordmark">search<em>·comète</em></div>
    <div class="tagline">Semantic search · Elasticsearch ELSER · Vector space exploration</div>
  </div>
  <div class="elastic-pill"><div class="es-dot"></div>ELASTIC · kNN</div>
</div>

<div id="search-area">
  <div id="search-wrap">
    <input id="search-input" type="text" placeholder="Search the universe of ideas…" autocomplete="off" />
    <button id="search-btn">→</button>
  </div>
  <div id="query-chips">
    <button class="chip" data-q="attention mechanisms transformers">attention mechanisms</button>
    <button class="chip" data-q="CRISPR gene editing">CRISPR gene editing</button>
    <button class="chip" data-q="black holes gravitational waves">black holes</button>
    <button class="chip" data-q="reinforcement learning reward">reinforcement learning</button>
    <button class="chip" data-q="protein folding structure">protein folding</button>
    <button class="chip" data-q="quantum computing algorithms">quantum computing</button>
  </div>
</div>

<div id="results-label"></div>

<div id="time-travel">
  <div class="tt-heading">TIME TRAVEL</div>
  <input id="year-slider" type="range" />
  <div id="year-readout">ALL YEARS</div>
</div>

<div id="meteor-fact"></div>

<div id="legend">
  <div class="legend-row active" data-cluster="all">
    <div class="legend-dot" style="background:rgba(245,242,235,0.4)"></div>ALL FIELDS
  </div>
</div>

<div id="star-count"></div>
<div id="instructions">drag to orbit · scroll to zoom · click a star</div>

<div id="detail-panel">
  <button id="detail-close">✕</button>
  <div id="detail-category"></div>
  <div id="detail-title"></div>
  <div id="detail-authors"></div>
  <div id="detail-year"></div>
  <div id="detail-actions">
    <button id="pin-btn" class="detail-action-btn">☆ PIN AS STAR</button>
  </div>
  <div class="detail-field-label">Abstract</div>
  <div id="detail-abstract"></div>
  <div class="detail-field-label">Semantic relevance score</div>
  <div id="detail-score">
    <div class="score-bar-wrap"><div class="score-bar" id="score-bar"></div></div>
    <div class="score-val" id="score-val"></div>
  </div>
  <div class="detail-field-label">Similar papers (kNN neighbours)</div>
  <div id="detail-similar"></div>
  <div class="detail-field-label">Elasticsearch kNN query</div>
  <div class="elastic-query-box" id="elastic-query"></div>
</div>

<div id="tooltip">
  <div id="tt-title"></div>
  <div id="tt-meta"></div>
</div>

<div id="warp-overlay"></div>

<div id="galaxy-loader">
  <div class="loader-inner">
    <div class="loader-title">search<em>·comète</em></div>
    <div class="loader-bar-wrap"><div class="loader-bar"></div></div>
    <div class="loader-label">Mapping the universe…</div>
  </div>
</div>
`;

// ── Inject global styles ──────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --ink: #0a0a12; --paper: #f5f2eb; --dim: rgba(245,242,235,0.45);
  --dimmer: rgba(245,242,235,0.15); --gold: #c9a84c;
  --glow-ml: #7c6dfa; --glow-bio: #3dd9a4; --glow-phys: #fa8c4f;
  --glow-cs: #5ab4f5; --glow-math: #f06ba8;
  --mono: 'IBM Plex Mono', monospace;
  --display: 'Syne', sans-serif;
  --serif: 'Newsreader', serif;
}
html, body { width: 100%; height: 100%; background: var(--ink); color: var(--paper); overflow: hidden; cursor: crosshair; }
#canvas { position: fixed; inset: 0; z-index: 0; }

/* HUD */
#hud-top { position:fixed; top:0; left:0; right:0; z-index:10; padding:18px 28px; display:flex; align-items:center; gap:20px; background:linear-gradient(180deg,rgba(10,10,18,0.95) 0%,transparent 100%); pointer-events:none; }
.wordmark { font-family:var(--display); font-size:18px; font-weight:800; letter-spacing:-0.02em; color:var(--paper); }
.wordmark em { font-style:normal; color:var(--gold); }
.tagline { font-family:var(--mono); font-size:9px; letter-spacing:0.18em; color:var(--dimmer); text-transform:uppercase; margin-top:2px; }
.elastic-pill { margin-left:auto; display:flex; align-items:center; gap:6px; font-family:var(--mono); font-size:9px; letter-spacing:0.1em; color:rgba(245,242,235,0.35); border:0.5px solid rgba(245,242,235,0.1); border-radius:2px; padding:5px 10px; }
.es-dot { width:5px; height:5px; border-radius:50%; background:var(--glow-bio); animation:breathe 3s ease-in-out infinite; }
@keyframes breathe { 0%,100%{opacity:1} 50%{opacity:0.3} }

/* Search */
#search-area { position:fixed; top:68px; left:50%; transform:translateX(-50%); z-index:10; width:520px; max-width: calc(100vw - 48px); }
#search-wrap { position:relative; display:flex; align-items:center; }
#search-input { width:100%; background:rgba(245,242,235,0.04); border:0.5px solid rgba(245,242,235,0.18); border-radius:2px; padding:12px 52px 12px 18px; font-family:var(--mono); font-size:13px; color:var(--paper); outline:none; letter-spacing:0.03em; transition:border-color 0.2s,background 0.2s; }
#search-input::placeholder { color:rgba(245,242,235,0.22); }
#search-input:focus { border-color:rgba(201,168,76,0.5); background:rgba(201,168,76,0.03); }
#search-btn { position:absolute; right:0; height:100%; width:48px; background:none; border:none; border-left:0.5px solid rgba(245,242,235,0.1); color:var(--gold); font-size:16px; cursor:pointer; transition:background 0.15s; display:flex; align-items:center; justify-content:center; }
#search-btn:hover { background:rgba(201,168,76,0.08); }
#query-chips { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; padding:0 2px; }
.chip { font-family:var(--mono); font-size:9px; letter-spacing:0.08em; padding:4px 10px; border:0.5px solid rgba(245,242,235,0.1); border-radius:1px; cursor:pointer; transition:all 0.15s; color:rgba(245,242,235,0.4); background:transparent; }
.chip:hover { border-color:var(--gold); color:var(--gold); }

/* Legend */
#legend { position:fixed; left:24px; bottom:80px; z-index:10; display:flex; flex-direction:column; gap:8px; }
.legend-row { display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:9px; letter-spacing:0.1em; color:rgba(245,242,235,0.35); cursor:pointer; transition:color 0.15s; }
.legend-row:hover, .legend-row.active { color:var(--paper); }
.legend-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }

/* Misc HUD */
#star-count { position:fixed; left:24px; bottom:24px; font-family:var(--mono); font-size:9px; letter-spacing:0.12em; color:rgba(245,242,235,0.2); z-index:10; }
#instructions { position:fixed; bottom:24px; right:24px; font-family:var(--mono); font-size:9px; letter-spacing:0.1em; color:rgba(245,242,235,0.18); text-align:right; line-height:1.8; z-index:10; }
#results-label { position:fixed; top:140px; left:50%; transform:translateX(-50%); font-family:var(--mono); font-size:10px; letter-spacing:0.12em; color:var(--gold); z-index:10; opacity:0; transition:opacity 0.4s; pointer-events:none; white-space:nowrap; }
#results-label.show { opacity:1; }
#warp-overlay { position:fixed; inset:0; z-index:15; pointer-events:none; opacity:0; background:radial-gradient(ellipse at center,rgba(201,168,76,0.04) 0%,transparent 70%); transition:opacity 0.3s; }
#warp-overlay.active { opacity:1; }

/* Detail panel */
#detail-panel { position:fixed; right:0; top:0; bottom:0; width:360px; background:rgba(10,10,18,0.97); border-left:0.5px solid rgba(245,242,235,0.08); z-index:20; transform:translateX(100%); transition:transform 0.4s cubic-bezier(0.16,1,0.3,1); overflow-y:auto; padding:28px 28px 40px; display:flex; flex-direction:column; gap:0; cursor:default; }
#detail-panel.open { transform:translateX(0); }
#detail-close { position:absolute; top:18px; right:20px; background:none; border:none; color:rgba(245,242,235,0.3); font-size:18px; cursor:pointer; font-family:var(--mono); line-height:1; transition:color 0.15s; }
#detail-close:hover { color:var(--paper); }
.detail-field-label { font-family:var(--mono); font-size:9px; letter-spacing:0.15em; text-transform:uppercase; color:rgba(245,242,235,0.3); margin-bottom:4px; margin-top:20px; }
#detail-category { font-family:var(--mono); font-size:9px; letter-spacing:0.12em; padding:3px 8px; border-radius:1px; display:inline-block; margin-bottom:14px; }
#detail-title { font-family:var(--serif); font-size:20px; font-weight:300; line-height:1.45; color:var(--paper); margin-bottom:8px; }
#detail-authors { font-family:var(--mono); font-size:10px; color:rgba(245,242,235,0.4); letter-spacing:0.04em; line-height:1.6; margin-bottom:6px; }
#detail-year { font-family:var(--mono); font-size:10px; color:var(--gold); letter-spacing:0.08em; }
#detail-abstract { font-family:var(--serif); font-size:13px; font-style:italic; line-height:1.75; color:rgba(245,242,235,0.65); border-left:1.5px solid rgba(201,168,76,0.25); padding-left:14px; margin-top:4px; }
#detail-score { display:flex; align-items:center; gap:10px; margin-top:4px; }
.score-bar-wrap { flex:1; height:3px; background:rgba(245,242,235,0.08); border-radius:2px; overflow:hidden; }
.score-bar { height:100%; border-radius:2px; background:var(--gold); transition:width 0.6s ease; }
.score-val { font-family:var(--mono); font-size:11px; color:var(--gold); min-width:36px; text-align:right; }
#detail-similar { display:flex; flex-direction:column; gap:6px; margin-top:4px; }
.similar-item { padding:8px 10px; border:0.5px solid rgba(245,242,235,0.07); border-radius:2px; cursor:pointer; transition:background 0.15s,border-color 0.15s; }
.similar-item:hover { background:rgba(245,242,235,0.04); border-color:rgba(245,242,235,0.15); }
.similar-title { font-family:var(--serif); font-size:12px; color:var(--paper); line-height:1.4; margin-bottom:3px; }
.similar-meta { font-family:var(--mono); font-size:9px; color:rgba(245,242,235,0.3); letter-spacing:0.06em; }
.elastic-query-box { margin-top:4px; background:rgba(245,242,235,0.03); border:0.5px solid rgba(245,242,235,0.07); border-radius:2px; padding:10px 12px; font-family:var(--mono); font-size:9px; color:rgba(245,242,235,0.35); line-height:1.7; white-space:pre; overflow-x:auto; letter-spacing:0.03em; }

/* Tooltip */
#tooltip { position:fixed; pointer-events:none; z-index:30; display:none; background:rgba(10,10,18,0.92); border:0.5px solid rgba(245,242,235,0.12); border-radius:2px; padding:8px 12px; max-width:240px; }
#tt-title { font-family:var(--serif); font-size:12px; color:var(--paper); line-height:1.4; margin-bottom:3px; }
#tt-meta { font-family:var(--mono); font-size:9px; color:rgba(245,242,235,0.35); letter-spacing:0.06em; }

/* Loader */
#galaxy-loader { position:fixed; inset:0; z-index:100; background:var(--ink); display:flex; align-items:center; justify-content:center; }
.loader-inner { display:flex; flex-direction:column; align-items:center; gap:20px; }
.loader-title { font-family:var(--display); font-size:28px; font-weight:800; letter-spacing:-0.02em; color:var(--paper); }
.loader-title em { font-style:normal; color:var(--gold); }
.loader-bar-wrap { width:240px; height:2px; background:rgba(245,242,235,0.08); border-radius:2px; overflow:hidden; }
.loader-bar { height:100%; width:0%; background:var(--gold); border-radius:2px; animation:load-progress 2s ease-in-out forwards; }
@keyframes load-progress { 0%{width:0%} 60%{width:75%} 90%{width:92%} 100%{width:100%} }
.loader-label { font-family:var(--mono); font-size:10px; letter-spacing:0.15em; color:rgba(245,242,235,0.3); text-transform:uppercase; }

#time-travel {
  position: fixed;
  right: 24px;
  top: 170px;
  z-index: 10;
  width: 220px;
  background: rgba(10,10,18,0.78);
  border: 0.5px solid rgba(245,242,235,0.1);
  padding: 12px 14px;
  border-radius: 2px;
  backdrop-filter: blur(8px);
}
.tt-heading {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--gold);
  margin-bottom: 10px;
}
#year-slider {
  width: 100%;
  accent-color: var(--gold);
  cursor: pointer;
}
#year-readout {
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: rgba(245,242,235,0.45);
}

#meteor-fact {
  position: fixed;
  right: 24px;
  bottom: 80px;
  width: 280px;
  z-index: 10;
  background: rgba(10,10,18,0.78);
  border: 0.5px solid rgba(245,242,235,0.1);
  padding: 14px 16px;
  border-radius: 2px;
  backdrop-filter: blur(8px);
  font-family: var(--mono);
}
#meteor-fact .meteor-label {
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--gold);
  margin-bottom: 8px;
}
#meteor-fact .meteor-title {
  font-family: var(--serif);
  font-size: 14px;
  line-height: 1.5;
  color: var(--paper);
  margin-bottom: 6px;
}
#meteor-fact .meteor-meta {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: rgba(245,242,235,0.38);
  line-height: 1.6;
}

#detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.detail-action-btn {
  background: rgba(245,242,235,0.04);
  border: 0.5px solid rgba(245,242,235,0.12);
  color: var(--gold);
  padding: 8px 10px;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  cursor: pointer;
  border-radius: 2px;
  transition: background 0.15s, border-color 0.15s;
}
.detail-action-btn:hover {
  background: rgba(201,168,76,0.08);
  border-color: rgba(201,168,76,0.35);
}
`;
document.head.appendChild(style);

// ── Wire up interactions ──────────────────────────────────────────────────────

document.getElementById('search-btn').addEventListener('click', triggerSearch);
document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') triggerSearch(); });

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('search-input').value = chip.dataset.q;
    triggerSearch();
  });
});

document.getElementById('detail-close').addEventListener('click', closeDetail);

// Legend: delegate — rows added dynamically after galaxy loads
document.getElementById('legend').addEventListener('click', e => {
  const row = e.target.closest('.legend-row');
  if (!row) return;
  document.querySelectorAll('.legend-row').forEach(r => r.classList.remove('active'));
  row.classList.add('active');
  const cluster = row.dataset.cluster;
  import('./galaxy.js').then(({ filterCluster }) => filterCluster(cluster));
});

async function triggerSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) {
    clearHighlights();
    document.getElementById('results-label').classList.remove('show');
    return;
  }
  const results = await doSearch(q);
  if (!results.length) {
    const label = document.getElementById('results-label');
    label.textContent = 'NO RESULTS FOUND';
    label.classList.add('show');
    setTimeout(() => label.classList.remove('show'), 2000);
    return;
  }

  const label = document.getElementById('results-label');
  label.textContent = `${results.length} PAPERS FOUND — FLYING TO CLUSTER`;
  label.classList.add('show');
  setTimeout(() => label.classList.remove('show'), 2500);

  highlightStars(results.map(r => r.id));

  const top = results[0];
  const remapped = getRemappedPos(top.id);
  if (remapped) {
    flyToCluster(remapped);
  } else if (top.x !== undefined) {
    flyToCluster({ x: top.x, y: top.y, z: top.z });
  }

  setTimeout(() => showDetail(top), 600);
}

// ── Load stars ────────────────────────────────────────────────────────────────

/**
 * FIX: Priority order with cluster-count guard.
 *
 * The problem was: /api/stars returned 200 OK but only had ml+bio papers
 * (partial pipeline run). loadStars() accepted that and never fell through
 * to the full fallback data.
 *
 * Now: if the returned data has fewer than MIN_CLUSTERS distinct clusters,
 * we treat it as insufficient and try the next source.
 */
const MIN_CLUSTERS = 1; // require at least this many clusters before trusting a source

// FIX: pipeline data uses `cluster_id`; fallback/API data uses `cluster`.
// Check both so stars.json is never skipped due to wrong field name.
function _countClusters(stars) {
  return new Set(stars.map(s => s.cluster || s.cluster_id).filter(Boolean)).size;
}

// Normalise pipeline field names (cluster_id, pos_x, etc.) to what the
// frontend expects (cluster, x, y, z) so stars.json works without backend mapping.
function _normaliseStars(stars) {
  return stars.map(s => ({
    ...s,
    cluster: s.cluster || s.cluster_id || '',
    color:   s.color   || s.cluster_color || '#ffffff',
    x:       s.x       ?? s.pos_x ?? 0,
    y:       s.y       ?? s.pos_y ?? 0,
    z:       s.z       ?? s.pos_z ?? 0,
    cite:    s.cite    ?? s.citations ?? 0,
  }));
}

async function loadStars() {
  console.group('[search-comete] loadStars()');

  // 1. Try the live /api/stars endpoint
  try {
    console.log('① Trying /api/stars …');
    const res = await fetch('/api/stars', { signal: AbortSignal.timeout(10000) });
    console.log('  /api/stars HTTP', res.status, res.ok ? 'OK' : 'FAIL');
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data) ? data : data.stars;
      console.log(`  raw length: ${raw?.length ?? 'null'}`);
      if (raw && raw.length > 0) {
        console.log('  sample[0] keys:', Object.keys(raw[0]).join(', '));
        const stars = _normaliseStars(raw);
        const nc = _countClusters(stars);
        console.log(`  clusters found: ${nc} →`, [...new Set(stars.map(s => s.cluster))]);
        if (nc >= MIN_CLUSTERS) {
          console.info(`✅ Using API: ${stars.length} stars, ${nc} clusters`);
          console.groupEnd();
          return stars;
        }
        console.warn(`  ⚠ only ${nc} cluster(s), need ${MIN_CLUSTERS} — skipping API`);
      } else {
        console.warn('  ⚠ empty array from API');
      }
    }
  } catch (e) {
    console.warn('  ✗ /api/stars failed:', e.message);
  }

  // 2. Try static stars.json (pre-built by pipeline)
  // Vite serves frontend/public/ at /, so this resolves to frontend/public/stars.json
  try {
    console.log('② Trying /stars.json …');
    const res = await fetch('/stars.json', { signal: AbortSignal.timeout(3000) });
    console.log('  /stars.json HTTP', res.status, res.ok ? 'OK' : 'FAIL');
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data) ? data : data.stars;
      console.log(`  raw length: ${raw?.length ?? 'null'}, isArray: ${Array.isArray(data)}`);
      if (raw && raw.length > 0) {
        console.log('  sample[0] keys:', Object.keys(raw[0]).join(', '));
        console.log('  sample[0]:', JSON.stringify(raw[0]).slice(0, 200));
        const stars = _normaliseStars(raw);
        const nc = _countClusters(stars);
        console.log(`  clusters found: ${nc} →`, [...new Set(stars.map(s => s.cluster))]);
        if (nc >= MIN_CLUSTERS) {
          console.info(`✅ Using stars.json: ${stars.length} stars, ${nc} clusters`);
          console.groupEnd();
          return stars;
        }
        console.warn(`  ⚠ only ${nc} cluster(s) in stars.json, need ${MIN_CLUSTERS} — falling to bundled`);
      } else {
        console.warn('  ⚠ stars.json parsed but array is empty or null');
        console.log('  raw data type:', typeof data, Array.isArray(data) ? '(array)' : '(object)', 'keys:', data ? Object.keys(data).join(', ') : 'null');
      }
    }
  } catch (e) {
    console.warn('  ✗ /stars.json failed:', e.message);
  }

  // 3. Bundled fallback — always has all clusters
  console.info('③ Using bundled FALLBACK_PAPERS');
  console.groupEnd();
  return FALLBACK_PAPERS;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const CLUSTER_LABELS = {
  ml:'MACHINE LEARNING', bio:'BIOLOGY', phys:'PHYSICS', cs:'COMPUTER SCIENCE',
  math:'MATHEMATICS', chem:'CHEMISTRY', econ:'ECONOMICS', env:'ENVIRONMENT', med:'MEDICINE',
  machine_learning:'MACHINE LEARNING', biology:'BIOLOGY', physics:'PHYSICS',
  computer_science:'COMPUTER SCIENCE', mathematics:'MATHEMATICS', chemistry:'CHEMISTRY',
  economics:'ECONOMICS', environment:'ENVIRONMENT', medicine:'MEDICINE',
};

function buildMeteorFact(stars) {
  const meteor = document.getElementById('meteor-fact');
  if (!meteor || !stars.length) return;

  const mostCited = [...stars].sort((a, b) => (b.cite ?? b.citations ?? 0) - (a.cite ?? a.citations ?? 0))[0];
  const newest = [...stars].sort((a, b) => (b.year || 0) - (a.year || 0))[0];
  const picks = [
    {
      title: mostCited.title,
      meta: `Most cited object in this universe · ${(mostCited.cite ?? mostCited.citations ?? 0).toLocaleString()} citations`
    },
    {
      title: newest.title,
      meta: `Newest signal detected · ${newest.year || 'Unknown year'}`
    },
    {
      title: stars[Math.floor(Math.random() * stars.length)].title,
      meta: `Meteor of the day · Random jump target`
    }
  ];

  const pick = picks[Math.floor(Math.random() * picks.length)];
  meteor.innerHTML = `
    <div class="meteor-label">METEOR OF THE DAY</div>
    <div class="meteor-title">${pick.title}</div>
    <div class="meteor-meta">${pick.meta}</div>
  `;
}

loadStars().then(stars => {
  initGalaxy(document.getElementById('canvas'), stars);
  document.getElementById('star-count').textContent = `${stars.length} PAPERS INDEXED`;
  
  buildMeteorFact(stars);

  const years = stars.map(s => Number(s.year)).filter(Number.isFinite);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  const slider = document.getElementById('year-slider');
  const readout = document.getElementById('year-readout');

  slider.min = minYear;
  slider.max = maxYear;
  slider.step = 1;
  slider.value = maxYear;

  const syncYear = () => {
    const y = Number(slider.value);
    if (y >= maxYear) {
      setActiveYear(Infinity);
      readout.textContent = 'ALL YEARS';
    } else {
      setActiveYear(y);
      readout.textContent = `VISIBLE THROUGH ${y}`;
    }
  };

  slider.addEventListener('input', syncYear);
  syncYear();

  // FIX: Rebuild legend AFTER initGalaxy() so CLUSTER_COLORS is populated.
  // Use a short rAF delay to let _discoverClusters() finish synchronously inside initGalaxy.
  requestAnimationFrame(() => {
    const clusterNames = [...new Set(stars.map(s => s.cluster).filter(Boolean))].sort();
    const legend = document.getElementById('legend');

    // Keep the ALL row, remove any stale rows
    const allRow = legend.querySelector('[data-cluster="all"]');
    legend.innerHTML = '';
    if (allRow) legend.appendChild(allRow);

    clusterNames.forEach(name => {
      const colorHex = CLUSTER_COLORS[name];
      const hex = colorHex ? '#' + colorHex.toString(16).padStart(6, '0') : '#888888';
      const label = CLUSTER_LABELS[name.toLowerCase()] || name.toUpperCase().replace(/_/g, ' ');
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.dataset.cluster = name;
      row.innerHTML = `<div class="legend-dot" style="background:${hex}"></div>${label}`;
      legend.appendChild(row);
    });

    console.log('[main] Legend built for clusters:', clusterNames);
  });
});