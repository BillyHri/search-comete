/**
 * search-comete — galaxy.js
 *
 * Clean rewrite. Key design decisions:
 *  - Camera is ONLY driven by (pivot, camTheta, camPhi, camR) lerping to targets.
 *    Nothing else touches camera.position — no snapping, no teleporting.
 *  - flyTo (star click): sets pivotTarget + tgtR, keeps current angle.
 *  - flyToCluster (search): sets pivotTarget + tgtR + tgtTheta/tgtPhi.
 *  - Click vs drag: tracked with a mouseMoved flag so drags don't fire clicks.
 *  - Glow: single subtle Points layer (opacity 0.28), not stacked halos.
 *  - Instanced meshes + one LineSegments for edges (perf).
 */

import * as THREE from 'three';
import { showDetail } from './panel.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Preferred colors for known cluster names (any naming style)
const PREFERRED_COLORS = {
  // Short codes
  ml: 0x7c6dfa, bio: 0x3dd9a4, phys: 0xfa8c4f, cs: 0x5ab4f5,
  math: 0xf06ba8, chem: 0xf9c74f, econ: 0x90e0ef, env: 0x52b788, med: 0xe63946,
  // Full names
  machine_learning: 0x7c6dfa, 'machine learning': 0x7c6dfa, machinelearning: 0x7c6dfa,
  deep_learning: 0x7c6dfa, nlp: 0x7c6dfa, ai: 0x7c6dfa,
  biology: 0x3dd9a4, bioinformatics: 0x3dd9a4, genomics: 0x3dd9a4,
  physics: 0xfa8c4f, astrophysics: 0xfa8c4f, quantum: 0xfa8c4f,
  computer_science: 0x5ab4f5, 'computer science': 0x5ab4f5, systems: 0x5ab4f5,
  mathematics: 0xf06ba8, math: 0xf06ba8, statistics: 0xf06ba8,
  chemistry: 0xf9c74f, materials: 0xf9c74f,
  economics: 0x90e0ef, finance: 0x90e0ef,
  environment: 0x52b788, environmental: 0x52b788, ecology: 0x52b788,
  medicine: 0xe63946, medical: 0xe63946, healthcare: 0xe63946, clinical: 0xe63946,
};

// Fallback palette for unknown cluster names
const AUTO_PALETTE = [
  0x7c6dfa, 0x3dd9a4, 0xfa8c4f, 0x5ab4f5, 0xf06ba8,
  0xf9c74f, 0x90e0ef, 0x52b788, 0xe63946, 0xc084fc,
  0x34d399, 0xfb923c, 0x60a5fa, 0xf472b6, 0xa3e635,
];
const DEFAULT_COLOR = 0x8888aa;

// These are populated dynamically in initGalaxy() from the actual data
export let CLUSTER_COLORS  = {};
let CLUSTER_ANCHORS = {};

// Evenly distribute n points on a sphere (Fibonacci lattice)
function _spherePositions(n, radius = 22) {
  const positions = [], golden = (1 + Math.sqrt(5)) / 2;
  for (let i = 0; i < n; i++) {
    const theta = Math.acos(1 - 2*(i+0.5)/n);
    const phi   = 2 * Math.PI * i / golden;
    positions.push(new THREE.Vector3(
      radius * Math.sin(theta) * Math.cos(phi),
      radius * Math.sin(theta) * Math.sin(phi),
      radius * Math.cos(theta),
    ));
  }
  return positions;
}

// Build CLUSTER_COLORS and CLUSTER_ANCHORS from whatever clusters exist in the data
function _discoverClusters(stars) {
  const names = [...new Set(stars.map(s => s.cluster).filter(Boolean))].sort();
  const positions = _spherePositions(names.length);
  CLUSTER_COLORS  = {};
  CLUSTER_ANCHORS = {};
  names.forEach((name, i) => {
    const key = String(name).toLowerCase().trim();
    CLUSTER_COLORS[name]  = PREFERRED_COLORS[key] ?? AUTO_PALETTE[i % AUTO_PALETTE.length];
    CLUSTER_ANCHORS[name] = positions[i];
  });
  console.log('[galaxy] Discovered clusters:', names);
}

// ── Module state ──────────────────────────────────────────────────────────────

let renderer, scene, camera;
let instancedSmall, instancedMed, instancedLarge;
let instanceMapSmall = [], instanceMapMed = [], instanceMapLarge = [];
let starDataArray = [];
let basePosArray;
let edgeSegments;
let ringMesh, ringMat;
let animFrame;

// Camera — spherical coords orbiting a pivot point.
// RULE: tgtTheta/tgtPhi/tgtR/pivotTarget are the only things external code sets.
// _animate() lerps actual values toward targets every frame.
const pivot       = new THREE.Vector3(0, 0, 0);
const pivotTarget = new THREE.Vector3(0, 0, 0);
let camTheta = 0, camPhi = 1.3,  camR = 85;
let tgtTheta = 0, tgtPhi = 1.3, tgtR = 85;

let isDragging = false, lastMX = 0, lastMY = 0, mouseMoved = false;
let autoRotate = true;
const mouse2D = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let hoveredStarIdx = -1;
let lastRaycast = 0;

const dummy       = new THREE.Object3D();
const _col        = new THREE.Color();
const _floatDummy = new THREE.Object3D();

const _remappedPos = {};
export function getRemappedPos(id) { return _remappedPos[String(id)]; }

// ── Loader ────────────────────────────────────────────────────────────────────

function showLoader() {
  const el = document.getElementById('galaxy-loader');
  if (el) el.style.display = 'flex';
}
function hideLoader() {
  const el = document.getElementById('galaxy-loader');
  if (!el) return;
  el.style.transition = 'opacity 0.8s ease';
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; }, 800);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initGalaxy(canvas, stars) {
  showLoader();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x06060f, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06060f, 0.002);

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 600);

  scene.add(new THREE.AmbientLight(0x111133, 2));
  _buildBackground();

  _discoverClusters(stars);

  const remapped = _remapStars(stars);

  // Debug: log star counts per cluster so missing clusters are obvious
  const clusterCounts = {};
  remapped.forEach(s => { clusterCounts[s.cluster] = (clusterCounts[s.cluster] || 0) + 1; });
  console.log('[galaxy] Star counts per cluster:', clusterCounts);
  const emptyClusters = Object.entries(clusterCounts).filter(([,n]) => n === 0).map(([c]) => c);
  const KNOWN_CLUSTERS = ['ml','bio','phys','cs','math','chem','econ','env','med'];
  const missingClusters = KNOWN_CLUSTERS.filter(c => !clusterCounts[c]);
  if (missingClusters.length) {
    console.warn('[galaxy] These clusters have NO stars in the data:', missingClusters);
    console.warn('[galaxy] Check your FALLBACK_PAPERS in data.js — are there entries with cluster:', missingClusters, '?');
  }

  _buildNebulae(remapped);

  requestAnimationFrame(() => {
    _buildStars(remapped);
    _buildEdges(remapped);
    _buildInterClusterLines(remapped);
    _buildRing();
    _bindControls(canvas);
    cancelAnimationFrame(animFrame);
    _animate();
    hideLoader();
  });
}

// ── Remap ─────────────────────────────────────────────────────────────────────

function _remapStars(stars) {
  const groups = {};
  stars.forEach(s => {
    if (!groups[s.cluster]) groups[s.cluster] = [];
    groups[s.cluster].push(s);
  });

  const out = [];
  Object.entries(groups).forEach(([cluster, members]) => {
    const anchor = CLUSTER_ANCHORS[cluster] || new THREE.Vector3(0, 0, 0);
    let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity,z0=Infinity,z1=-Infinity;
    members.forEach(s => {
      x0=Math.min(x0,s.x||0); x1=Math.max(x1,s.x||0);
      y0=Math.min(y0,s.y||0); y1=Math.max(y1,s.y||0);
      z0=Math.min(z0,s.z||0); z1=Math.max(z1,s.z||0);
    });
    const rx=(x1-x0)||1, ry=(y1-y0)||1, rz=(z1-z0)||1, R=4;
    members.forEach(s => {
      out.push({
        ...s,
        x: anchor.x + (((s.x||0)-x0)/rx - 0.5) * R*2,
        y: anchor.y + (((s.y||0)-y0)/ry - 0.5) * R*2,
        z: anchor.z + (((s.z||0)-z0)/rz - 0.5) * R*2,
      });
    });
  });
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function highlightStars(ids) {
  const set = new Set(ids.map(String));
  starDataArray.forEach(({ star, tierMesh, localId, globalIdx }) => {
    const hit = set.has(String(star.id));
    _col.setHex(hit ? 0xffffff : (CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR));
    tierMesh.setColorAt(localId, _col);
    const b = basePosArray;
    dummy.position.set(b[globalIdx*3], b[globalIdx*3+1], b[globalIdx*3+2]);
    dummy.quaternion.identity();
    dummy.scale.setScalar(hit ? 2.2 : 0.01);
    dummy.updateMatrix();
    tierMesh.setMatrixAt(localId, dummy.matrix);
  });
  _flushAll();
  if (edgeSegments) edgeSegments.material.opacity = 0.02;
}

export function clearHighlights() {
  starDataArray.forEach(({ star, tierMesh, localId, globalIdx }) => {
    _col.setHex(CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR);
    tierMesh.setColorAt(localId, _col);
    const b = basePosArray;
    dummy.position.set(b[globalIdx*3], b[globalIdx*3+1], b[globalIdx*3+2]);
    dummy.quaternion.identity();
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    tierMesh.setMatrixAt(localId, dummy.matrix);
  });
  _flushAll();
  if (edgeSegments) edgeSegments.material.opacity = 0.45;
}

export function filterCluster(clusterId) {
  clearHighlights();
  if (clusterId === 'all') {
    pivotTarget.set(0, 0, 0);
    tgtR = 85;
    return;
  }

  starDataArray.forEach(({ star, tierMesh, localId, globalIdx }) => {
    const match = star.cluster === clusterId;
    const b = basePosArray;
    dummy.position.set(b[globalIdx*3], b[globalIdx*3+1], b[globalIdx*3+2]);
    dummy.quaternion.identity();
    dummy.scale.setScalar(match ? 1.2 : 0.01);
    dummy.updateMatrix();
    tierMesh.setMatrixAt(localId, dummy.matrix);
  });
  _flushAll(true);
  if (edgeSegments) edgeSegments.material.opacity = 0.01;

  const anchor = CLUSTER_ANCHORS[clusterId];
  if (anchor) {
    pivotTarget.copy(anchor);
    const dir = anchor.clone().normalize();
    tgtTheta = Math.atan2(dir.x, dir.z) + 0.3;
    tgtPhi   = Math.acos(Math.max(-1, Math.min(1, dir.y))) * 0.8 + 0.3;
    tgtR = 12;
    _warp();
  }
}

/** Fly to a specific star world position (from clicking a star in the scene). */
export function flyTo({ x, y, z }) {
  pivotTarget.set(x, y, z);
  tgtR = 4;
  // Preserve current viewing angle — just pull in close
  _warp();
}

/** Fly to a cluster area from search results — wider view with angled approach. */
export function flyToCluster({ x, y, z }) {
  pivotTarget.set(x, y, z);
  tgtR = 10;
  const dir = new THREE.Vector3(x, y, z).normalize();
  tgtTheta = Math.atan2(dir.x, dir.z) + 0.4;
  tgtPhi   = Math.acos(Math.max(-1, Math.min(1, dir.y))) * 0.8 + 0.35;
  _warp();
}

function _warp() {
  const el = document.getElementById('warp-overlay');
  if (el) { el.classList.add('active'); setTimeout(() => el.classList.remove('active'), 450); }
}

// ── Scene builders ────────────────────────────────────────────────────────────

function _buildBackground() {
  const count = 8000;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i*3]   = (Math.random()-0.5)*400;
    pos[i*3+1] = (Math.random()-0.5)*400;
    pos[i*3+2] = (Math.random()-0.5)*400;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.07, transparent: true, opacity: 0.14, sizeAttenuation: true,
  })));
}

function _buildNebulae(stars) {
  const seen = new Set();
  stars.forEach(s => {
    if (seen.has(s.cluster)) return;
    seen.add(s.cluster);
    const anchor = CLUSTER_ANCHORS[s.cluster];
    if (!anchor) return;
    const color = CLUSTER_COLORS[s.cluster] || DEFAULT_COLOR;
    [10, 5].forEach(sz => scene.add(_makeNebula(color, sz, anchor)));
  });
}

function _makeNebula(color, size, anchor) {
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 256;
  const ctx = cvs.getContext('2d');
  const r=(color>>16)&255, g=(color>>8)&255, b=color&255;
  const gr = ctx.createRadialGradient(128,128,0,128,128,128);
  gr.addColorStop(0,   `rgba(${r},${g},${b},0.20)`);
  gr.addColorStop(0.4, `rgba(${r},${g},${b},0.07)`);
  gr.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = gr; ctx.fillRect(0,0,256,256);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cvs), transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  sp.scale.setScalar(size);
  sp.position.copy(anchor);
  return sp;
}

function _makeStarTex() {
  const sz = 64, c = document.createElement('canvas');
  c.width = c.height = sz;
  const ctx = c.getContext('2d'), h = sz/2;
  const g = ctx.createRadialGradient(h,h,0,h,h,h);
  g.addColorStop(0,   'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.15)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0,0,sz,sz);
  return new THREE.CanvasTexture(c);
}

function _buildStars(stars) {
  starDataArray = [];

  const cntS = stars.filter(s=>(s.cite||0)<=200).length;
  const cntM = stars.filter(s=>(s.cite||0)>200&&(s.cite||0)<=5000).length;
  const cntL = stars.filter(s=>(s.cite||0)>5000).length;

  const mat = () => new THREE.MeshBasicMaterial({ color: 0xffffff });
  instancedSmall = cntS > 0 ? new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 7, 7), mat(), cntS) : null;
  instancedMed   = cntM > 0 ? new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 8, 8), mat(), cntM) : null;
  instancedLarge = cntL > 0 ? new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 9, 9), mat(), cntL) : null;
  [instancedSmall, instancedMed, instancedLarge].forEach(im => {
    if (im) im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  });

  let iS=0, iM=0, iL=0;
  basePosArray = new Float32Array(stars.length * 3);

  const glowByCluster = {};

  stars.forEach((star, gi) => {
    const cite = star.cite || 0;
    _col.setHex(CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR);
    dummy.position.set(star.x, star.y, star.z);
    dummy.quaternion.identity();
    dummy.scale.setScalar(1);
    dummy.updateMatrix();

    basePosArray[gi*3]   = star.x;
    basePosArray[gi*3+1] = star.y;
    basePosArray[gi*3+2] = star.z;

    let tierMesh, localId;
    if (cite > 5000)     { tierMesh = instancedLarge; localId = iL++; }
    else if (cite > 200) { tierMesh = instancedMed;   localId = iM++; }
    else                 { tierMesh = instancedSmall;  localId = iS++; }

    tierMesh.setMatrixAt(localId, dummy.matrix);
    tierMesh.setColorAt(localId, _col);
    starDataArray.push({ star, tierMesh, localId, globalIdx: gi });
    _remappedPos[String(star.id)] = { x: star.x, y: star.y, z: star.z };

    if (!glowByCluster[star.cluster]) glowByCluster[star.cluster] = [];
    glowByCluster[star.cluster].push(star.x, star.y, star.z);
  });

  _flushAll();
  instanceMapSmall = starDataArray.filter(e => e.tierMesh === instancedSmall);
  instanceMapMed   = starDataArray.filter(e => e.tierMesh === instancedMed);
  instanceMapLarge = starDataArray.filter(e => e.tierMesh === instancedLarge);
  [instancedSmall, instancedMed, instancedLarge].forEach(im => { if (im) scene.add(im); });

  // Single glow layer per cluster — subtle soft points
  const starTex = _makeStarTex();
  Object.entries(glowByCluster).forEach(([cluster, pts]) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
      map: starTex,
      color: new THREE.Color(CLUSTER_COLORS[cluster] || DEFAULT_COLOR),
      size: 0.5,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      alphaTest: 0.01,
    })));
  });
}

function _buildEdges(stars) {
  const groups = {};
  stars.forEach(s => {
    if (!groups[s.cluster]) groups[s.cluster] = [];
    groups[s.cluster].push(s);
  });

  const positions = [], colors = [];
  const K = 6; // k-nearest neighbours per star

  Object.entries(groups).forEach(([cluster, members]) => {
    if (members.length < 2) return;
    const col = new THREE.Color(CLUSTER_COLORS[cluster] || DEFAULT_COLOR);
    const added = new Set(); // deduplicate edges

    members.forEach((sa, a) => {
      // Compute distance to all other members, sort, take K nearest
      const dists = [];
      for (let b = 0; b < members.length; b++) {
        if (b === a) continue;
        const sb = members[b];
        const dx=sa.x-sb.x, dy=sa.y-sb.y, dz=sa.z-sb.z;
        dists.push({ b, d: Math.sqrt(dx*dx+dy*dy+dz*dz) });
      }
      dists.sort((x,y) => x.d - y.d);

      // Max distance among this star's k-nearest (used for brightness scaling)
      const maxD = dists[Math.min(K-1, dists.length-1)].d;

      for (let k = 0; k < Math.min(K, dists.length); k++) {
        const { b, d } = dists[k];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (added.has(key)) continue;
        added.add(key);
        const sb = members[b];
        const br = Math.max(0.1, 1 - d / (maxD * 2));
        positions.push(sa.x,sa.y,sa.z, sb.x,sb.y,sb.z);
        colors.push(col.r*br,col.g*br,col.b*br, col.r*br,col.g*br,col.b*br);
      }
    });
  });

  if (!positions.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  edgeSegments = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(edgeSegments);
}

function _buildInterClusterLines(stars) {
  const c = {};
  stars.forEach(s => {
    if (!c[s.cluster]) c[s.cluster] = {x:0,y:0,z:0,n:0};
    c[s.cluster].x+=s.x; c[s.cluster].y+=s.y; c[s.cluster].z+=s.z; c[s.cluster].n++;
  });
  const ids = Object.keys(c);
  const pts = {};
  ids.forEach(id => { pts[id] = new THREE.Vector3(c[id].x/c[id].n, c[id].y/c[id].n, c[id].z/c[id].n); });
  const pos = [];
  for (let a=0; a<ids.length; a++)
    for (let b=a+1; b<ids.length; b++) {
      const pa=pts[ids[a]], pb=pts[ids[b]];
      pos.push(pa.x,pa.y,pa.z, pb.x,pb.y,pb.z);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: 0x334466, transparent: true, opacity: 0.05, depthWrite: false,
  })));
}

function _buildRing() {
  ringMat = new THREE.MeshBasicMaterial({
    color: 0xc9a84c, side: THREE.DoubleSide, transparent: true, opacity: 0,
  });
  ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.32, 32), ringMat);
  ringMesh.visible = false;
  scene.add(ringMesh);
}

// ── Controls ──────────────────────────────────────────────────────────────────

function _bindControls(canvas) {
  canvas.addEventListener('mousedown', e => {
    isDragging = true; mouseMoved = false;
    lastMX = e.clientX; lastMY = e.clientY;
    autoRotate = false;
    setTimeout(() => { autoRotate = true; }, 10000);
  });

  window.addEventListener('mouseup', () => { isDragging = false; });

  window.addEventListener('mousemove', e => {
    if (isDragging) {
      const dx = e.clientX - lastMX, dy = e.clientY - lastMY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) mouseMoved = true;
      tgtTheta -= dx * 0.005;
      tgtPhi    = Math.max(0.15, Math.min(Math.PI-0.15, tgtPhi - dy * 0.004));
      lastMX = e.clientX; lastMY = e.clientY;
    }
    mouse2D.x =  (e.clientX / innerWidth)  * 2 - 1;
    mouse2D.y = -(e.clientY / innerHeight) * 2 + 1;
  });

  window.addEventListener('wheel', e => {
    tgtR = Math.max(2, Math.min(150, tgtR + e.deltaY * 0.06));
    autoRotate = false;
    setTimeout(() => { autoRotate = true; }, 5000);
  }, { passive: true });

  // Only fire click if mouse didn't move (i.e. wasn't a drag)
  canvas.addEventListener('click', () => { if (!mouseMoved) _handleClick(); });

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

function _handleClick() {
  raycaster.setFromCamera(mouse2D, camera);
  const hit = _castAgainstInstances();
  if (hit) {
    showDetail(hit.star);
    flyTo(hit.worldPos);
  }
}

// ── Animation ─────────────────────────────────────────────────────────────────

let t = 0;
const clock = new THREE.Clock();

function _animate() {
  animFrame = requestAnimationFrame(_animate);
  t += clock.getDelta();

  if (autoRotate && !isDragging) tgtTheta += 0.0006;

  // Lerp pivot
  pivot.lerp(pivotTarget, 0.06);

  // Lerp spherical coords — normalise theta delta to avoid spinning the long way
  let dTheta = tgtTheta - camTheta;
  while (dTheta >  Math.PI) dTheta -= Math.PI*2;
  while (dTheta < -Math.PI) dTheta += Math.PI*2;
  camTheta += dTheta * 0.05;
  camPhi   += (tgtPhi - camPhi) * 0.05;
  camR     += (tgtR   - camR)   * 0.05;

  // Compute camera world position from spherical coords + pivot
  const sinPhi = Math.sin(camPhi);
  camera.position.set(
    pivot.x + camR * sinPhi * Math.sin(camTheta),
    pivot.y + camR * Math.cos(camPhi),
    pivot.z + camR * sinPhi * Math.cos(camTheta),
  );
  camera.lookAt(pivot);

  _animateFloats();
  if (performance.now() - lastRaycast > 80) { lastRaycast = performance.now(); _updateHover(); }

  renderer.render(scene, camera);
}

function _animateFloats() {
  let nS=false, nM=false, nL=false;
  starDataArray.forEach(({ tierMesh, localId, globalIdx }) => {
    tierMesh.getMatrixAt(localId, _floatDummy.matrix);
    _floatDummy.matrix.decompose(_floatDummy.position, _floatDummy.quaternion, _floatDummy.scale);
    if (_floatDummy.scale.x < 0.1) return;
    const b = basePosArray;
    _floatDummy.position.set(
      b[globalIdx*3]   + Math.sin(t*0.25 + globalIdx)     * 0.04,
      b[globalIdx*3+1] + Math.cos(t*0.2  + globalIdx*1.3) * 0.04,
      b[globalIdx*3+2] + Math.sin(t*0.18 + globalIdx*0.7) * 0.04,
    );
    _floatDummy.updateMatrix();
    tierMesh.setMatrixAt(localId, _floatDummy.matrix);
    if (tierMesh === instancedSmall) nS=true;
    else if (tierMesh === instancedMed) nM=true;
    else nL=true;
  });
  if (nS) instancedSmall.instanceMatrix.needsUpdate = true;
  if (nM) instancedMed.instanceMatrix.needsUpdate   = true;
  if (nL) instancedLarge.instanceMatrix.needsUpdate = true;
}

// ── Raycast ───────────────────────────────────────────────────────────────────

function _castAgainstInstances() {
  raycaster.setFromCamera(mouse2D, camera);
  let best = null, bestDist = Infinity;

  for (const [im, map] of [
    [instancedSmall, instanceMapSmall],
    [instancedMed,   instanceMapMed],
    [instancedLarge, instanceMapLarge],
  ]) {
    if (!im) continue;
    const hits = raycaster.intersectObject(im);
    if (!hits.length || hits[0].distance >= bestDist) continue;
    bestDist = hits[0].distance;
    const entry = map.find(e => e.localId === hits[0].instanceId);
    if (!entry) continue;
    im.getMatrixAt(hits[0].instanceId, dummy.matrix);
    const worldPos = new THREE.Vector3().setFromMatrixPosition(dummy.matrix);
    best = { star: entry.star, worldPos };
  }
  return best;
}

// ── Hover ─────────────────────────────────────────────────────────────────────

function _updateHover() {
  const result = _castAgainstInstances();
  const tooltip = document.getElementById('tooltip');

  if (result) {
    document.body.style.cursor = 'pointer';
    const newIdx = starDataArray.findIndex(e => e.star === result.star);
    if (hoveredStarIdx !== newIdx) {
      hoveredStarIdx = newIdx;
      tooltip.style.display = 'block';
      document.getElementById('tt-title').textContent = result.star.title || '';
      document.getElementById('tt-meta').textContent =
        `${(result.star.authors||'').split(',')[0]} · ${result.star.year||''} · ${(result.star.cite||0).toLocaleString()} citations`;
    }
    const proj = result.worldPos.clone().project(camera);
    tooltip.style.left = ((proj.x*0.5+0.5)*innerWidth  + 16) + 'px';
    tooltip.style.top  = ((-proj.y*0.5+0.5)*innerHeight - 10) + 'px';
    ringMesh.position.copy(result.worldPos);
    ringMesh.lookAt(camera.position);
    ringMesh.visible = true;
    ringMat.opacity  = 0.9;
  } else {
    if (hoveredStarIdx !== -1) {
      document.body.style.cursor = 'crosshair';
      hoveredStarIdx = -1;
      tooltip.style.display = 'none';
      ringMesh.visible = false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _flushAll(matrixOnly = false) {
  for (const im of [instancedSmall, instancedMed, instancedLarge]) {
    if (!im) continue;
    im.instanceMatrix.needsUpdate = true;
    if (!matrixOnly && im.instanceColor) im.instanceColor.needsUpdate = true;
  }
}