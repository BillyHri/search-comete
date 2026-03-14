/**
 * search-comete — panel.js
 * Manages the right-hand detail panel: show, close, similar papers.
 *
 * Fixes applied:
 *  1. _getCite(): papers from the API use `citations`; fallback papers use
 *     `cite`. We unify here so the year/citations line always shows correctly.
 *  2. Similar-item click: uses getRemappedPos() for the correct world position
 *     (not the raw UMAP coords from FALLBACK_PAPERS).
 *  3. CLUSTER_CSS / CLUSTER_LABELS extended to cover all known cluster names
 *     including full-name variants returned by the pipeline.
 */

import { FALLBACK_PAPERS } from './data.js';
import { flyTo, getRemappedPos } from './galaxy.js';

const CLUSTER_CSS = {
  // Short codes
  ml:   'var(--glow-ml)',
  bio:  'var(--glow-bio)',
  phys: 'var(--glow-phys)',
  cs:   'var(--glow-cs)',
  math: 'var(--glow-math)',
  chem: '#f9c74f',
  econ: '#90e0ef',
  env:  '#52b788',
  med:  '#e63946',
  // Full-name variants (from pipeline)
  machine_learning: 'var(--glow-ml)',
  'machine learning': 'var(--glow-ml)',
  biology:          'var(--glow-bio)',
  bioinformatics:   'var(--glow-bio)',
  physics:          'var(--glow-phys)',
  astrophysics:     'var(--glow-phys)',
  computer_science: 'var(--glow-cs)',
  'computer science':'var(--glow-cs)',
  mathematics:      'var(--glow-math)',
  statistics:       'var(--glow-math)',
  chemistry:        '#f9c74f',
  materials:        '#f9c74f',
  economics:        '#90e0ef',
  finance:          '#90e0ef',
  environment:      '#52b788',
  environmental:    '#52b788',
  medicine:         '#e63946',
  medical:          '#e63946',
  healthcare:       '#e63946',
  clinical:         '#e63946',
};

const CLUSTER_LABELS = {
  ml:    'Machine Learning',  cs:    'Computer Science',
  math:  'Mathematics',       phys:  'Physics',
  astro: 'Astronomy',         chem:  'Chemistry',
  bio:   'Biology',           neuro: 'Neuroscience',
  med:   'Medicine',          mat:   'Materials Science',
  eng:   'Engineering',       env:   'Environment',
  econ:  'Economics',         psych: 'Psychology',
  edu:   'Education',
  // full-name variants from pipeline
  machine_learning:  'Machine Learning',  computer_science:  'Computer Science',
  mathematics:       'Mathematics',       physics:           'Physics',
  astronomy:         'Astronomy',         chemistry:         'Chemistry',
  biology:           'Biology',           neuroscience:      'Neuroscience',
  medicine:          'Medicine',          materials_science: 'Materials Science',
  engineering:       'Engineering',       environment:       'Environment',
  economics:         'Economics',         psychology:        'Psychology',
  education:         'Education',
  // legacy / alternate names
  'machine learning': 'Machine Learning',  'computer science': 'Computer Science',
  bioinformatics:    'Bioinformatics',     astrophysics:       'Astrophysics',
  statistics:        'Statistics',         materials:          'Materials Science',
  finance:           'Finance',            environmental:      'Environmental Science',
  medical:           'Medicine',           healthcare:         'Healthcare',
  clinical:          'Clinical Research',
};

// FIX 1: unified cite getter — handles both `cite` and `citations` field names
function _getCite(paper) {
  const v = paper.cite ?? paper.citations ?? 0;
  return typeof v === 'number' ? v : 0;
}

export function showDetail(paper) {
  const clusterKey = (paper.cluster || '').toLowerCase().trim();
  const css   = CLUSTER_CSS[clusterKey]   || CLUSTER_CSS[paper.cluster]   || '#ffffff';
  const label = CLUSTER_LABELS[clusterKey] || CLUSTER_LABELS[paper.cluster] || paper.cluster || 'Unknown';

  const badge = document.getElementById('detail-category');
  badge.textContent  = label.toUpperCase();
  badge.style.background = _hexToRgba(paper.color || '#888888', 0.15);
  badge.style.color  = css;

  document.getElementById('detail-title').textContent    = paper.title   || '—';
  document.getElementById('detail-authors').textContent  = paper.authors  || '—';
  document.getElementById('detail-year').textContent     =
    `${paper.year || ''}  ·  ${_getCite(paper).toLocaleString()} citations`;
  document.getElementById('detail-abstract').textContent = paper.abstract || '—';

  const score = paper.score !== undefined ? paper.score : 0.5 + Math.random() * 0.4;
  document.getElementById('score-bar').style.width      = Math.round(score * 100) + '%';
  document.getElementById('score-bar').style.background = css;
  document.getElementById('score-val').textContent      = score.toFixed(3);
  document.getElementById('score-val').style.color      = css;

  _loadSimilar(paper);

  const kw = (paper.keywords || [])[0] || (paper.title || '').split(' ')[0] || '';
  document.getElementById('elastic-query').textContent =
`GET /knowledge_galaxy/_search
{
  "knn": {
    "field": "embedding",
    "query_vector": [...],
    "k": 10,
    "num_candidates": 100
  },
  "query": {
    "match": {
      "abstract": "${kw}"
    }
  }
}`;

  document.getElementById('detail-panel').classList.add('open');
}

export function closeDetail() {
  document.getElementById('detail-panel').classList.remove('open');
}

async function _loadSimilar(paper) {
  const container = document.getElementById('detail-similar');
  container.innerHTML = '<div style="font-family:var(--mono);font-size:9px;color:rgba(245,242,235,0.3);padding:4px 0;">Loading…</div>';

  let similar = [];

  // Try live API first
  try {
    const res = await fetch(`/api/paper/${encodeURIComponent(paper.id)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      similar = (data.similar || []).slice(0, 5);
    }
  } catch {
    // Fall through to local similar
  }

  // FIX 2: local fallback — find papers in same cluster, shuffled
  if (!similar.length) {
    similar = FALLBACK_PAPERS
      .filter(p => p.cluster === paper.cluster && String(p.id) !== String(paper.id))
      .sort(() => Math.random() - 0.5)
      .slice(0, 5)
      .map(p => ({ id: p.id, title: p.title, authors: p.authors, year: p.year }));
  }

  if (!similar.length) {
    container.innerHTML = '<div style="font-family:var(--mono);font-size:9px;color:rgba(245,242,235,0.3);padding:4px 0;">No similar papers found.</div>';
    return;
  }

  container.innerHTML = similar.map(s => `
    <div class="similar-item" data-id="${s.id}">
      <div class="similar-title">${s.title || '—'}</div>
      <div class="similar-meta">${(s.authors||'').split(',')[0]} · ${s.year || ''}</div>
    </div>
  `).join('');

  container.querySelectorAll('.similar-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const found = FALLBACK_PAPERS.find(p => String(p.id) === String(id));
      if (!found) return;
      showDetail(found);
      // FIX 2: use remapped scene position, not raw UMAP coords
      const pos = getRemappedPos(found.id);
      if (pos) flyTo(pos);
    });
  });
}

function _hexToRgba(hex, alpha) {
  // Handle both '#rrggbb' strings and numeric hex values
  let clean = typeof hex === 'number'
    ? hex.toString(16).padStart(6, '0')
    : hex.replace('#', '');
  // Ensure 6 chars
  if (clean.length === 3) clean = clean.split('').map(c => c+c).join('');
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}