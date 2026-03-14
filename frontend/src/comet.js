/**
 * search-comete — comet.js
 *
 * Periodic comets fly across the 3D galaxy scene. Every 2–4 minutes, the
 * Anthropic API picks a semantically interesting paper from the corpus.
 * Clicking the comet flies the camera to that paper and opens its detail panel.
 *
 * Public API:
 *   initComets(scene, camera, corpus, onCometClick)
 *   tickComets(delta, elapsed)   — call every animation frame
 *   raycastComets(raycaster)     — call on mousemove / click; returns hit or null
 *   disposeComets()
 */

import * as THREE from 'three';

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 0.02 * 60 * 1000;   // 2 min
const MAX_INTERVAL_MS = 0.05 * 60 * 1000;   // 4 min
const COMET_DURATION  = 22.0;            // seconds to cross the scene (slow & visible)
const TAIL_SEGMENTS   = 48;
const SPAWN_RADIUS    = 180;             // distance from origin comets spawn at
const MAX_LIVE_COMETS = 2;

// ── State ─────────────────────────────────────────────────────────────────────

let _scene    = null;
let _camera   = null;
let _corpus   = [];
let _onCometClick = null;

// Recently-clicked paper IDs to avoid repeats
const _recentIds = [];
const MAX_RECENT = 12;

// Active comets in flight
const _active = [];

let _nextSpawnAt = null; // epoch ms

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {THREE.Scene}    scene
 * @param {THREE.Camera}   camera
 * @param {Array}          corpus   — full star array from main.js
 * @param {Function}       onCometClick(paper) — called when user clicks a comet
 */
export function initComets(scene, camera, corpus, onCometClick) {
  _scene        = scene;
  _camera       = camera;
  _corpus       = corpus;
  _onCometClick = onCometClick;
  _scheduleNext();
  console.log('[comets] Initialised — first comet in', _msUntilNext().toFixed(0), 'ms');
}

export function updateCorpus(corpus) {
  _corpus = corpus;
}

/**
 * Call this inside the Three.js animation loop.
 * @param {number} delta   seconds since last frame (from THREE.Clock)
 * @param {number} elapsed total seconds elapsed
 */
export function tickComets(delta, elapsed) {
  if (!_scene) return;

  // Spawn check
  if (_nextSpawnAt !== null && Date.now() >= _nextSpawnAt && _active.length < MAX_LIVE_COMETS) {
    _nextSpawnAt = null;
    _spawnComet();
  }

  // Advance each live comet
  for (let i = _active.length - 1; i >= 0; i--) {
    const c = _active[i];
    c.t += delta / COMET_DURATION;
    _updateComet(c);
    if (c.t >= 1.0) {
      _destroyComet(c);
      _active.splice(i, 1);
      _scheduleNext();
    }
  }
}

/**
 * Call on mousemove. Returns the comet object if hit, else null.
 * @param {THREE.Raycaster} raycaster
 */
export function raycastComets(raycaster) {
  for (const c of _active) {
    const hits = raycaster.intersectObject(c.hitSphere, false);
    if (hits.length > 0) return c;
  }
  return null;
}

export function disposeComets() {
  _active.forEach(c => _destroyComet(c));
  _active.length = 0;
}

// ── Scheduling ────────────────────────────────────────────────────────────────

function _msUntilNext() {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

function _scheduleNext() {
  const delay = _msUntilNext();
  _nextSpawnAt = Date.now() + delay;
  console.log(`[comets] Next comet in ${(delay / 1000 / 60).toFixed(1)} min`);
}

// ── Spawn a comet ─────────────────────────────────────────────────────────────

async function _spawnComet() {
  // 1. Pick paper (async — comet visuals launch immediately with a placeholder)
  const paperPromise = _pickPaper();

  // 2. Random trajectory across the scene
  const startDir  = new THREE.Vector3(
    (Math.random() - 0.5),
    (Math.random() - 0.5) * 0.4,
    (Math.random() - 0.5),
  ).normalize();
  const endDir = startDir.clone().negate()
    .applyEuler(new THREE.Euler(
      (Math.random() - 0.5) * 0.5,
      (Math.random() - 0.5) * 0.5,
      0,
    )).normalize();

  const startPos = startDir.clone().multiplyScalar(SPAWN_RADIUS);
  const endPos   = endDir.clone().multiplyScalar(SPAWN_RADIUS);

  // Slight arc midpoint
  const mid = startPos.clone().lerp(endPos, 0.5);
  mid.y += 20 + Math.random() * 30;

  // 3. Build Three.js objects
  const color = _randomCometColor();
  const group = new THREE.Group();
  _scene.add(group);

  // Head — glowing sphere
  const headGeo = new THREE.SphereGeometry(0.55, 10, 10);
  const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
  const head    = new THREE.Mesh(headGeo, headMat);
  group.add(head);

  // Glow sprite around head
  const glowSprite = _makeGlowSprite(color);
  glowSprite.scale.setScalar(4.5);
  group.add(glowSprite);

  // Tail — line with fading opacity via vertex colors
  const tailPositions = new Float32Array(TAIL_SEGMENTS * 3);
  const tailColors    = new Float32Array(TAIL_SEGMENTS * 3);
  const tailGeo = new THREE.BufferGeometry();
  tailGeo.setAttribute('position', new THREE.BufferAttribute(tailPositions, 3).setUsage(THREE.DynamicDrawUsage));
  tailGeo.setAttribute('color',    new THREE.BufferAttribute(tailColors,    3).setUsage(THREE.DynamicDrawUsage));
  const tailMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const tailLine = new THREE.Line(tailGeo, tailMat);
  _scene.add(tailLine); // separate from group so it doesn't rotate

  // Particle puff behind head
  const puffGeo = new THREE.BufferGeometry();
  const puffPos = new Float32Array(24 * 3);
  puffGeo.setAttribute('position', new THREE.BufferAttribute(puffPos, 3).setUsage(THREE.DynamicDrawUsage));
  const puffMat = new THREE.PointsMaterial({
    color, size: 0.35, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const puff = new THREE.Points(puffGeo, puffMat);
  _scene.add(puff);

  // Invisible hit sphere for raycasting
  const hitGeo  = new THREE.SphereGeometry(2.2, 6, 6);
  const hitMat  = new THREE.MeshBasicMaterial({ visible: false });
  const hitSphere = new THREE.Mesh(hitGeo, hitMat);
  _scene.add(hitSphere);

  const comet = {
    t: 0,
    startPos, mid, endPos,
    group, head, headMat, glowSprite, tailLine, tailGeo, puff, puffGeo, hitSphere,
    color,
    paper: null,        // filled when promise resolves
    posHistory: [],
  };

  _active.push(comet);
  _showCometToast(comet);

  // Resolve paper asynchronously
  paperPromise.then(paper => {
    comet.paper = paper;
    console.log(`[comets] Paper assigned: "${paper?.title?.slice(0, 60)}"`);
  }).catch(err => {
    console.warn('[comets] Paper pick failed:', err);
  });
}

// ── Per-frame comet update ────────────────────────────────────────────────────

function _updateComet(c) {
  // Quadratic bezier along start→mid→end
  const t  = c.t;
  const t1 = 1 - t;
  const pos = new THREE.Vector3(
    t1*t1*c.startPos.x + 2*t1*t*c.mid.x + t*t*c.endPos.x,
    t1*t1*c.startPos.y + 2*t1*t*c.mid.y + t*t*c.endPos.y,
    t1*t1*c.startPos.z + 2*t1*t*c.mid.z + t*t*c.endPos.z,
  );

  c.group.position.copy(pos);
  c.hitSphere.position.copy(pos);

  // Store position history for tail
  c.posHistory.unshift(pos.clone());
  if (c.posHistory.length > TAIL_SEGMENTS) c.posHistory.pop();

  // Update tail geometry
  const tailPos = c.tailGeo.attributes.position;
  const tailCol = c.tailGeo.attributes.color;
  const r = ((c.color >> 16) & 255) / 255;
  const g = ((c.color >> 8)  & 255) / 255;
  const b = (c.color & 255) / 255;

  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    const p = c.posHistory[i] || pos;
    tailPos.setXYZ(i, p.x, p.y, p.z);
    const fade = Math.pow(1 - i / TAIL_SEGMENTS, 1.8);
    tailCol.setXYZ(i, r * fade, g * fade, b * fade);
  }
  tailPos.needsUpdate = true;
  tailCol.needsUpdate = true;
  c.tailGeo.setDrawRange(0, c.posHistory.length);

  // Update puff particles — scatter near head with slight trail
  const puffPos = c.puffGeo.attributes.position;
  for (let i = 0; i < 24; i++) {
    const histIdx = Math.floor(i / 24 * Math.min(c.posHistory.length, 8));
    const hp = c.posHistory[histIdx] || pos;
    puffPos.setXYZ(i,
      hp.x + (Math.random() - 0.5) * 1.5,
      hp.y + (Math.random() - 0.5) * 1.5,
      hp.z + (Math.random() - 0.5) * 1.5,
    );
  }
  puffPos.needsUpdate = true;

  // Fade out near end of life
  const fadeIn  = Math.min(1, t * 8);
  const fadeOut = t > 0.85 ? Math.max(0, 1 - (t - 0.85) / 0.15) : 1;
  const alpha   = fadeIn * fadeOut;
  c.headMat.opacity = alpha;
  c.tailLine.material.opacity = alpha * 0.9;
  c.puff.material.opacity     = alpha * 0.55;
  if (c.glowSprite.material) c.glowSprite.material.opacity = alpha * 0.75;
}

// ── Destroy ───────────────────────────────────────────────────────────────────

function _destroyComet(c) {
  _scene.remove(c.group);
  _scene.remove(c.tailLine);
  _scene.remove(c.puff);
  _scene.remove(c.hitSphere);
  c.tailGeo.dispose();
  c.puffGeo.dispose();
  c.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  c.tailLine.material.dispose();
  c.puff.material.dispose();
  c.hitSphere.material.dispose();
  c.hitSphere.geometry.dispose();
}

// ── Paper picking — smart local scoring ──────────────────────────────────────
//
// Scores each paper on several signals to find genuinely interesting picks:
//  1. Citation impact    — landmark papers score higher
//  2. Cross-cluster rarity — papers whose title tokens appear across many
//                            different clusters score higher (interdisciplinary)
//  3. Cluster rotation   — down-weights clusters seen in recent picks so
//                          comets tour the whole galaxy over time
//  4. Recency variety    — slight preference for older AND newer papers
//                          (avoids always picking the same era)
//  5. Randomness jitter  — small noise so every comet feels fresh

async function _pickPaper() {
  if (!_corpus.length) return _localPick();
  return _localPick();
}

function _localPick() {
  const eligible = _corpus.filter(p => !_recentIds.includes(String(p.id)));
  const pool = eligible.length > 0 ? eligible : _corpus;

  // Build a token→clusters map so we can score interdisciplinarity
  // Only built once and cached on the function object
  if (!_localPick._crossMap) {
    _localPick._crossMap = _buildCrossClusterMap(_corpus);
  }
  const crossMap = _localPick._crossMap;

  // Track which clusters appeared in recent picks for rotation
  const recentClusters = new Set(
    _recentIds
      .map(id => _corpus.find(p => String(p.id) === id))
      .filter(Boolean)
      .map(p => p.cluster)
  );

  const scored = pool.map(p => {
    let score = 0;

    // 1. Citation impact — log scale so ultra-cited don't dominate completely
    const cite = p.cite ?? 0;
    score += Math.log10(cite + 1) * 18;

    // 2. Cross-disciplinarity — how many clusters share tokens with this title
    const tokens = _tokeniseTitle(p.title);
    let crossCount = 0;
    tokens.forEach(tok => {
      const clusters = crossMap[tok];
      if (clusters && clusters.size > 1) crossCount += clusters.size;
    });
    score += crossCount * 6;

    // 3. Cluster rotation — penalise recently-seen clusters
    if (recentClusters.has(p.cluster)) score -= 40;

    // 4. Recency variety — mild preference for papers not from the median year
    const medianYear = 2015;
    const yearDist = Math.abs((p.year || medianYear) - medianYear);
    score += yearDist * 0.4;

    // 5. Randomness jitter
    score += Math.random() * 25;

    return { p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const pick = scored[0].p;

  _recentIds.push(String(pick.id));
  if (_recentIds.length > MAX_RECENT) _recentIds.shift();

  return pick;
}

// Build map: token → Set of clusters that contain it
function _buildCrossClusterMap(corpus) {
  const map = {};
  corpus.forEach(p => {
    _tokeniseTitle(p.title).forEach(tok => {
      if (!map[tok]) map[tok] = new Set();
      map[tok].add(p.cluster);
    });
  });
  return map;
}

function _tokeniseTitle(title) {
  const STOP = new Set(['a','an','the','and','or','of','in','to','for','is','are',
    'was','were','with','on','using','based','via','from','by','as','at','its',
    'this','that','we','our','new','novel','deep','large','high','multi']);
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3 && !STOP.has(t));
}

// ── Toast notification ────────────────────────────────────────────────────────

function _showCometToast(comet) {
  let toast = document.getElementById('comet-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'comet-toast';

    const style = document.createElement('style');
    style.textContent = `
      #comet-toast {
        position: fixed;
        bottom: 120px;
        left: 50%;
        transform: translateX(-50%) translateY(10px);
        z-index: 25;
        background: rgba(10,10,18,0.92);
        border: 0.5px solid rgba(201,168,76,0.5);
        border-radius: 2px;
        padding: 9px 20px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px;
        letter-spacing: 0.18em;
        color: #c9a84c;
        opacity: 0;
        transition: opacity 0.4s ease, transform 0.4s ease;
        white-space: nowrap;
        backdrop-filter: blur(8px);
        cursor: pointer;
        user-select: none;
      }
      #comet-toast.show {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      #comet-toast:hover {
        background: rgba(201,168,76,0.12);
        border-color: rgba(201,168,76,0.8);
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(toast);
  }

  // Remove any previous click listener by replacing the node
  const fresh = toast.cloneNode(false);
  toast.parentNode.replaceChild(fresh, toast);
  toast = fresh;
  // Re-apply styles (cloneNode copies the id so the CSS still applies)

  toast.textContent = '✦ COMET DETECTED — CLICK TO INVESTIGATE';
  toast.classList.add('show');

  // Clicking the toast fires the callback directly — no raycasting needed
  toast.addEventListener('click', () => {
    toast.classList.remove('show');
    if (_onCometClick && comet) _onCometClick(comet);
  });

  // Auto-hide after the comet duration
  const hideTimeout = setTimeout(() => toast.classList.remove('show'), (COMET_DURATION - 1) * 1000);
  // Store so we can cancel if needed
  toast._hideTimeout = hideTimeout;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _randomCometColor() {
  const palette = [
    0xc9a84c, // gold
    0x7c6dfa, // violet
    0x3dd9a4, // teal
    0x5ab4f5, // blue
    0xfa8c4f, // amber
    0xf06ba8, // pink
    0xffffff, // white
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

function _makeGlowSprite(color) {
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 128;
  const ctx = cvs.getContext('2d');
  const r = (color >> 16) & 255;
  const g = (color >> 8)  & 255;
  const b = color & 255;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0,   `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(0.3, `rgba(${r},${g},${b},0.4)`);
  grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cvs),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
}