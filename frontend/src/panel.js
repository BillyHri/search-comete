/**
 * search-comete — panel.js
 * Manages the right-hand detail panel: show, close, similar papers.
 */

import { FALLBACK_PAPERS } from './data.js';
import { flyTo }           from './galaxy.js';

const CLUSTER_CSS = {
  ml:   'var(--glow-ml)',
  bio:  'var(--glow-bio)',
  phys: 'var(--glow-phys)',
  cs:   'var(--glow-cs)',
  math: 'var(--glow-math)',
};

const CLUSTER_LABELS = {
  ml:   'Machine Learning',
  bio:  'Biology',
  phys: 'Physics',
  cs:   'Computer Science',
  math: 'Mathematics',
};

export function showDetail(paper) {
  const css   = CLUSTER_CSS[paper.cluster]  || '#ffffff';
  const label = CLUSTER_LABELS[paper.cluster] || paper.cluster;

  // Category badge
  const badge = document.getElementById('detail-category');
  badge.textContent  = label.toUpperCase();
  badge.style.background = _hexToRgba(paper.color || '#888888', 0.15);
  badge.style.color  = css;

  document.getElementById('detail-title').textContent   = paper.title   || '—';
  document.getElementById('detail-authors').textContent = paper.authors  || '—';
  document.getElementById('detail-year').textContent    =
    `${paper.year || ''}  ·  ${(paper.cite ?? paper.citations ?? 0).toLocaleString()} citations`;
  document.getElementById('detail-abstract').textContent = paper.abstract || '—';

  // Relevance score bar
  const score = paper.score !== undefined ? paper.score : 0.5 + Math.random() * 0.4;
  document.getElementById('score-bar').style.width      = Math.round(score * 100) + '%';
  document.getElementById('score-bar').style.background = css;
  document.getElementById('score-val').textContent      = score.toFixed(3);
  document.getElementById('score-val').style.color      = css;

  // Similar papers (kNN neighbours from backend, or same-cluster papers locally)
  _loadSimilar(paper);

  // Elasticsearch query preview
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
      "abstract": "${(paper.keywords || [])[0] || paper.title?.split(' ')[0] || ''}"
    }
  }
}`;

  document.getElementById('detail-panel').classList.add('open');
}

export function closeDetail() {
  document.getElementById('detail-panel').classList.remove('open');
}

// ── Similar papers ────────────────────────────────────────────────────────────
async function _loadSimilar(paper) {
  const container = document.getElementById('detail-similar');
  container.innerHTML = '<div style="font-family:var(--mono);font-size:9px;color:rgba(245,242,235,0.3);padding:4px 0;">Loading…</div>';

  let similar = [];

  // Try backend kNN endpoint first
  try {
    const res = await fetch(`/api/paper/${encodeURIComponent(paper.id)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      similar = (data.similar || []).slice(0, 5);
    }
  } catch {
    // Fall back to local same-cluster papers
    similar = FALLBACK_PAPERS
      .filter(p => p.cluster === paper.cluster && p.id !== paper.id)
      .sort(() => Math.random() - 0.5)
      .slice(0, 5)
      .map(p => ({ id: p.id, title: p.title, authors: p.authors, year: p.year, x: p.x, y: p.y, z: p.z }));
  }

  container.innerHTML = similar.map(s => `
    <div class="similar-item" data-id="${s.id}" data-x="${s.x||0}" data-y="${s.y||0}" data-z="${s.z||0}">
      <div class="similar-title">${s.title}</div>
      <div class="similar-meta">${(s.authors||'').split(',')[0]} · ${s.year || ''}</div>
    </div>
  `).join('');

  // Wire click handlers
  container.querySelectorAll('.similar-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const found = FALLBACK_PAPERS.find(p => String(p.id) === String(id));
      if (found) {
        showDetail(found);
        if (found.x !== undefined) flyTo({ x: found.x, y: found.y, z: found.z });
      }
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
