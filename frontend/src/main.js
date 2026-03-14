/**
 * search-comete — main.js
 * Entry point. Injects the UI shell then initialises galaxy, search, and panel.
 */

import { initGalaxy, highlightStars, clearHighlights, flyTo, flyToCluster, getRemappedPos } from './galaxy.js';
import { doSearch }                                             from './search.js';
import { showDetail, closeDetail }                             from './panel.js';
import { FALLBACK_PAPERS }                                     from './data.js';

// ── Inject UI HTML ────────────────────────────────────────────────────────────
document.getElementById('app').innerHTML = `
<canvas id="canvas"></canvas>

<div id="hud-top">
  <div class="wordmark">search<em>·comète</em></div>
  <div class="tagline">Semantic search · Elasticsearch ELSER · Vector space exploration</div>
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

<div id="legend">
  <div class="legend-row active" data-cluster="all">
    <div class="legend-dot" style="background:rgba(245,242,235,0.4)"></div>ALL FIELDS
  </div>
  <div class="legend-row" data-cluster="ml">
    <div class="legend-dot" style="background:#7c6dfa"></div>MACHINE LEARNING
  </div>
  <div class="legend-row" data-cluster="bio">
    <div class="legend-dot" style="background:#3dd9a4"></div>BIOLOGY
  </div>
  <div class="legend-row" data-cluster="phys">
    <div class="legend-dot" style="background:#fa8c4f"></div>PHYSICS
  </div>
  <div class="legend-row" data-cluster="cs">
    <div class="legend-dot" style="background:#5ab4f5"></div>COMPUTER SCIENCE
  </div>
  <div class="legend-row" data-cluster="math">
    <div class="legend-dot" style="background:#f06ba8"></div>MATHEMATICS
  </div>
  <div class="legend-row" data-cluster="chem">
    <div class="legend-dot" style="background:#f9c74f"></div>CHEMISTRY
  </div>
  <div class="legend-row" data-cluster="econ">
    <div class="legend-dot" style="background:#90e0ef"></div>ECONOMICS
  </div>
  <div class="legend-row" data-cluster="env">
    <div class="legend-dot" style="background:#52b788"></div>ENVIRONMENT
  </div>
  <div class="legend-row" data-cluster="med">
    <div class="legend-dot" style="background:#e63946"></div>MEDICINE
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

// Inject global styles
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
#search-area { position:fixed; top:68px; left:50%; transform:translateX(-50%); z-index:10; width:520px; }
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
#results-label { position:fixed; top:140px; left:50%; transform:translateX(-50%); font-family:var(--mono); font-size:10px; letter-spacing:0.12em; color:var(--gold); z-index:10; opacity:0; transition:opacity 0.4s; pointer-events:none; }
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
`;
document.head.appendChild(style);

// ── Wire up interactions ──────────────────────────────────────────────────────

// Search button + enter key
document.getElementById('search-btn').addEventListener('click', triggerSearch);
document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') triggerSearch(); });

// Quick-search chips
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('search-input').value = chip.dataset.q;
    triggerSearch();
  });
});

// Legend cluster filter
document.querySelectorAll('.legend-row').forEach(row => {
  row.addEventListener('click', () => {
    document.querySelectorAll('.legend-row').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
    const cluster = row.dataset.cluster;
    import('./galaxy.js').then(({ filterCluster }) => filterCluster(cluster));
  });
});

// Detail panel close
document.getElementById('detail-close').addEventListener('click', closeDetail);

async function triggerSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) {
    clearHighlights();
    document.getElementById('results-label').classList.remove('show');
    return;
  }
  const results = await doSearch(q);
  if (!results.length) return;

  const label = document.getElementById('results-label');
  label.textContent = `${results.length} PAPERS FOUND — FLYING TO CLUSTER`;
  label.classList.add('show');
  setTimeout(() => label.classList.remove('show'), 2500);

  highlightStars(results.map(r => r.id));

  // Fly toward top result — use remapped 3D position at cluster zoom level
  const top = results[0];
  const remapped = getRemappedPos(top.id);
  if (remapped) {
    flyToCluster(remapped);
  } else if (top.x !== undefined) {
    flyToCluster({ x: top.x, y: top.y, z: top.z });
  }

  // Show detail panel for top result after camera settles
  setTimeout(() => showDetail(top), 600);
}

// ── Init galaxy ───────────────────────────────────────────────────────────────
async function loadStars() {
  // 1. Try the live /api/stars endpoint — always reflects current ES index
  try {
    const res = await fetch('/api/stars', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      // /api/stars returns a plain array (fixed in main.py)
      const stars = Array.isArray(data) ? data : data.stars;
      if (stars && stars.length > 0) {
        console.info(`[search-comete] Loaded ${stars.length} stars from API`);
        return stars;
      }
    }
  } catch (e) {
    console.info('[search-comete] /api/stars unavailable:', e.message);
  }

  // 2. Fall back to the static stars.json (pre-built by pipeline)
  try {
    const res = await fetch('/stars.json', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const stars = Array.isArray(data) ? data : data.stars;
      if (stars && stars.length > 0) {
        console.info(`[search-comete] Loaded ${stars.length} stars from stars.json`);
        return stars;
      }
    }
  } catch (e) {
    console.info('[search-comete] stars.json unavailable:', e.message);
  }

  // 3. Last resort — bundled fallback data (always has all clusters)
  console.info('[search-comete] Using bundled fallback data');
  return FALLBACK_PAPERS;
}

loadStars().then(stars => {
  initGalaxy(document.getElementById('canvas'), stars);
  document.getElementById('star-count').textContent = `${stars.length} PAPERS INDEXED`;

  // Rebuild the legend dynamically from whatever clusters exist in the data
  // so it works regardless of how the pipeline named the clusters
  import('./galaxy.js').then(({ CLUSTER_COLORS }) => {
    const clusterNames = [...new Set(stars.map(s => s.cluster).filter(Boolean))].sort();
    const LABELS = {
      ml:'MACHINE LEARNING', bio:'BIOLOGY', phys:'PHYSICS', cs:'COMPUTER SCIENCE',
      math:'MATHEMATICS', chem:'CHEMISTRY', econ:'ECONOMICS', env:'ENVIRONMENT', med:'MEDICINE',
      machine_learning:'MACHINE LEARNING', biology:'BIOLOGY', physics:'PHYSICS',
      computer_science:'COMPUTER SCIENCE', mathematics:'MATHEMATICS', chemistry:'CHEMISTRY',
      economics:'ECONOMICS', environment:'ENVIRONMENT', medicine:'MEDICINE',
    };
    const legend = document.getElementById('legend');
    // Keep the ALL row, rebuild the rest
    const allRow = legend.querySelector('[data-cluster="all"]');
    legend.innerHTML = '';
    if (allRow) legend.appendChild(allRow);

    clusterNames.forEach(name => {
      const color = CLUSTER_COLORS[name];
      const hex = color ? '#' + color.toString(16).padStart(6,'0') : '#888888';
      const label = LABELS[name.toLowerCase()] || name.toUpperCase().replace(/_/g,' ');
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.dataset.cluster = name;
      row.innerHTML = `<div class="legend-dot" style="background:${hex}"></div>${label}`;
      row.addEventListener('click', () => {
        document.querySelectorAll('.legend-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        import('./galaxy.js').then(({ filterCluster }) => filterCluster(name));
      });
      legend.appendChild(row);
    });
  });
});