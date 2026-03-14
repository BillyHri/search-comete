/**
 * search-comete — galaxy.js
 * Vast universe with galaxy clusters, constellation lines,
 * and a camera that properly orbits around clicked stars.
 */

import * as THREE from 'three';
import { showDetail } from './panel.js';

export const CLUSTER_COLORS = {
  ml:   0x7c6dfa,
  bio:  0x3dd9a4,
  phys: 0xfa8c4f,
  cs:   0x5ab4f5,
  math: 0xf06ba8,
  chem: 0xf9c74f,
  econ: 0x90e0ef,
  env:  0x52b788,
  med:  0xe63946,
};

const DEFAULT_COLOR = 0x8888aa;

const CLUSTER_ANCHORS = {
  ml:   new THREE.Vector3(-18,   4,  -8),
  bio:  new THREE.Vector3( 16,  -5,  10),
  phys: new THREE.Vector3( -4, -16, -18),
  cs:   new THREE.Vector3( 14,  14,  -6),
  math: new THREE.Vector3( -8,  -8,  18),
  chem: new THREE.Vector3( 18,   2,  14),
  econ: new THREE.Vector3( -2,  18,   8),
  env:  new THREE.Vector3(-16,  -2,  12),
  med:  new THREE.Vector3(  6, -18,   4),
};

let renderer, scene, camera;
let starMeshes = [];
let edgeLines  = [];
let ringMesh, ringMat;

// Camera orbit target — what the camera looks at and orbits around
let orbitTarget    = new THREE.Vector3(0, 0, 0);
let orbitTargetNew = new THREE.Vector3(0, 0, 0);

let camTheta = 0, camPhi = Math.PI / 2, camR = 45;
let targetTheta = 0, targetPhi = Math.PI / 2, targetR = 45;
let isDragging = false, lastMX = 0, lastMY = 0;
let autoRotate = true;
const mouse2D   = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let hoveredMesh = null;
let animFrame;

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

// ── Public: init ──────────────────────────────────────────────────────────────
export function initGalaxy(canvas, stars) {
  showLoader();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x06060f, 1);

  scene  = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06060f, 0.007);

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 500);
  camera.position.set(0, 0, 45);

  scene.add(new THREE.AmbientLight(0x111133, 2));

  _buildBackground();

  const remapped = _remapStars(stars);

  _buildNebulae(remapped);

  requestAnimationFrame(() => {
    _buildStars(remapped);
    _buildEdges(remapped);
    _buildInterClusterLines(remapped);
    _buildRing();
    _bindControls(canvas);

    targetR = 80;
    setTimeout(() => { targetR = 45; }, 200);

    cancelAnimationFrame(animFrame);
    _animate();
    hideLoader();
  });
}

// ── Remap UMAP coords to cluster anchor positions ─────────────────────────────
function _remapStars(stars) {
  const groups = {};
  stars.forEach(s => {
    if (!groups[s.cluster]) groups[s.cluster] = [];
    groups[s.cluster].push(s);
  });

  const remapped = [];
  Object.entries(groups).forEach(([cluster, members]) => {
    const anchor = CLUSTER_ANCHORS[cluster] || new THREE.Vector3(0, 0, 0);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    members.forEach(s => {
      minX = Math.min(minX, s.x||0); maxX = Math.max(maxX, s.x||0);
      minY = Math.min(minY, s.y||0); maxY = Math.max(maxY, s.y||0);
      minZ = Math.min(minZ, s.z||0); maxZ = Math.max(maxZ, s.z||0);
    });
    const rangeX = (maxX - minX) || 1;
    const rangeY = (maxY - minY) || 1;
    const rangeZ = (maxZ - minZ) || 1;
    const R = 5;

    members.forEach(s => {
      const nx = ((s.x||0) - minX) / rangeX - 0.5;
      const ny = ((s.y||0) - minY) / rangeY - 0.5;
      const nz = ((s.z||0) - minZ) / rangeZ - 0.5;
      remapped.push({
        ...s,
        x: anchor.x + nx * R * 2,
        y: anchor.y + ny * R,
        z: anchor.z + nz * R * 2,
        _anchor: anchor,
      });
    });
  });

  return remapped;
}

// ── Public: highlight search results ─────────────────────────────────────────
export function highlightStars(ids) {
  const idSet = new Set(ids.map(String));
  starMeshes.forEach(({ mesh, star }) => {
    const hit = idSet.has(String(star.id));
    mesh.material.color.setHex(hit ? 0xffffff : CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR);
    mesh.material.transparent = !hit;
    mesh.material.opacity     = hit ? 1 : 0.06;
    mesh.scale.setScalar(hit ? 2.2 : 1);
    if (mesh.children[0]) mesh.children[0].material.opacity = hit ? 0.5 : 0;
  });
  edgeLines.forEach(l => { l.material.opacity = 0.02; });
}

// ── Public: clear highlights ──────────────────────────────────────────────────
export function clearHighlights() {
  starMeshes.forEach(({ mesh, star }) => {
    mesh.material.color.setHex(CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR);
    mesh.material.transparent = false;
    mesh.material.opacity     = 1;
    mesh.scale.setScalar(1);
    if (mesh.children[0]) mesh.children[0].material.opacity = 0.08;
  });
  edgeLines.forEach(l => { l.material.opacity = l.userData.baseOpacity; });
}

// ── Public: filter by cluster ─────────────────────────────────────────────────
export function filterCluster(clusterId) {
  clearHighlights();
  if (clusterId === 'all') {
    _setOrbitTarget(new THREE.Vector3(0, 0, 0));
    targetR = 45;
    return;
  }
  starMeshes.forEach(({ mesh, star }) => {
    const match = star.cluster === clusterId;
    mesh.material.transparent = !match;
    mesh.material.opacity     = match ? 1 : 0.04;
    mesh.scale.setScalar(match ? 1.2 : 1);
  });
  edgeLines.forEach(l => {
    const match = l.userData.cluster === clusterId;
    l.material.opacity = match ? l.userData.baseOpacity : 0.0;
  });
  const anchor = CLUSTER_ANCHORS[clusterId];
  if (anchor) {
    _setOrbitTarget(anchor.clone());
    targetR = 16;
    const rel = anchor.clone().normalize();
    targetTheta = Math.atan2(rel.x, rel.z);
    targetPhi   = Math.acos(Math.max(-1, Math.min(1, rel.y))) + 0.3;
  }
}

// ── Public: fly to a position and orbit it ───────────────────────────────────
export function flyTo({ x, y, z }) {
  const pos = new THREE.Vector3(x, y, z);
  _setOrbitTarget(pos);
  targetR = 3;

  // Point camera toward the star from current position
  const camPos = new THREE.Vector3(
    camR * Math.sin(camPhi) * Math.sin(camTheta),
    camR * Math.cos(camPhi),
    camR * Math.sin(camPhi) * Math.cos(camTheta)
  ).add(orbitTarget);

  // Direction from star to camera (so camera ends up offset from star)
  const offset = camPos.clone().sub(pos).normalize();
  const spherical = new THREE.Spherical().setFromVector3(offset);
  targetTheta = spherical.theta;
  targetPhi   = spherical.phi;

  document.getElementById('warp-overlay').classList.add('active');
  setTimeout(() => {
    document.getElementById('warp-overlay').classList.remove('active');
  }, 450);
}

// Smoothly transition the orbit target
function _setOrbitTarget(newTarget) {
  orbitTargetNew.copy(newTarget);
}

// ── Private: background ───────────────────────────────────────────────────────
function _buildBackground() {
  const count = 8000;
  const pos   = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i*3]   = (Math.random() - 0.5) * 400;
    pos[i*3+1] = (Math.random() - 0.5) * 400;
    pos[i*3+2] = (Math.random() - 0.5) * 400;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.08, transparent: true, opacity: 0.18,
    sizeAttenuation: true,
  })));
}

// ── Private: nebulae ──────────────────────────────────────────────────────────
function _buildNebulae(stars) {
  const seen = new Set();
  stars.forEach(s => {
    if (seen.has(s.cluster)) return;
    seen.add(s.cluster);
    const anchor = CLUSTER_ANCHORS[s.cluster];
    if (!anchor) return;
    const color = CLUSTER_COLORS[s.cluster] || DEFAULT_COLOR;
    [22, 10].forEach(size => {
      const sprite = _makeNebulaSprite(color, size);
      sprite.position.copy(anchor);
      scene.add(sprite);
    });
  });
}

function _makeNebulaSprite(color, size) {
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 256;
  const ctx = cvs.getContext('2d');
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0,   `rgba(${r},${g},${b},0.22)`);
  grad.addColorStop(0.4, `rgba(${r},${g},${b},0.08)`);
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const mat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cvs),
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(size);
  return sprite;
}

// ── Private: star spheres ─────────────────────────────────────────────────────
function _buildStars(stars) {
  starMeshes = [];
  const geoS = new THREE.SphereGeometry(0.06, 7, 7);
  const geoM = new THREE.SphereGeometry(0.10, 7, 7);
  const geoL = new THREE.SphereGeometry(0.16, 8, 8);
  const haloS = new THREE.SphereGeometry(0.17, 6, 6);
  const haloM = new THREE.SphereGeometry(0.28, 6, 6);
  const haloL = new THREE.SphereGeometry(0.45, 6, 6);

  stars.forEach(star => {
    const col  = CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR;
    const cite = star.cite || 0;
    let geo, hGeo;
    if (cite > 5000)     { geo = geoL; hGeo = haloL; }
    else if (cite > 200) { geo = geoM; hGeo = haloM; }
    else                 { geo = geoS; hGeo = haloS; }

    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col }));
    const x = star.x, y = star.y, z = star.z;
    mesh.position.set(x, y, z);
    mesh.userData = { star, basePos: new THREE.Vector3(x, y, z) };

    mesh.add(new THREE.Mesh(hGeo, new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.08,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })));

    scene.add(mesh);
    starMeshes.push({ mesh, star, basePos: new THREE.Vector3(x, y, z) });
  });
}

// ── Private: constellation lines within clusters ──────────────────────────────
function _buildEdges(stars) {
  edgeLines = [];
  const groups = {};
  stars.forEach(s => {
    if (!groups[s.cluster]) groups[s.cluster] = [];
    groups[s.cluster].push(s);
  });

  Object.entries(groups).forEach(([cluster, members]) => {
    const col      = new THREE.Color(CLUSTER_COLORS[cluster] || DEFAULT_COLOR);
    const MAX_DIST = 3.5;
    const MAX_EDGES = 300;
    let edgeCount = 0;

    for (let a = 0; a < members.length && edgeCount < MAX_EDGES; a++) {
      for (let b = a + 1; b < members.length && edgeCount < MAX_EDGES; b++) {
        const sa = members[a], sb = members[b];
        const dx = sa.x - sb.x, dy = sa.y - sb.y, dz = sa.z - sb.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist > MAX_DIST) continue;

        const alpha = (1 - dist / MAX_DIST) * 0.35;
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(sa.x, sa.y, sa.z),
          new THREE.Vector3(sb.x, sb.y, sb.z),
        ]);
        const mat = new THREE.LineBasicMaterial({
          color: col, transparent: true, opacity: alpha,
          depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const line = new THREE.Line(geo, mat);
        line.userData = { cluster, baseOpacity: alpha };
        scene.add(line);
        edgeLines.push(line);
        edgeCount++;
      }
    }
  });
}

// ── Private: faint inter-cluster web lines ────────────────────────────────────
function _buildInterClusterLines(stars) {
  const centroids = {};
  stars.forEach(s => {
    if (!centroids[s.cluster]) centroids[s.cluster] = { x:0, y:0, z:0, n:0 };
    centroids[s.cluster].x += s.x;
    centroids[s.cluster].y += s.y;
    centroids[s.cluster].z += s.z;
    centroids[s.cluster].n++;
  });
  const ids = Object.keys(centroids);
  const pts = {};
  ids.forEach(id => {
    const c = centroids[id];
    pts[id] = new THREE.Vector3(c.x/c.n, c.y/c.n, c.z/c.n);
  });
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      const geo = new THREE.BufferGeometry().setFromPoints([pts[ids[a]], pts[ids[b]]]);
      scene.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0x334466, transparent: true, opacity: 0.06, depthWrite: false,
      })));
    }
  }
}

// ── Private: hover ring ───────────────────────────────────────────────────────
function _buildRing() {
  ringMat  = new THREE.MeshBasicMaterial({ color: 0xc9a84c, side: THREE.DoubleSide, transparent: true, opacity: 0 });
  ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.26, 32), ringMat);
  ringMesh.visible = false;
  scene.add(ringMesh);
}

// ── Private: controls ─────────────────────────────────────────────────────────
function _bindControls(canvas) {
  canvas.addEventListener('mousedown', e => {
    isDragging = true; lastMX = e.clientX; lastMY = e.clientY;
    autoRotate = false;
    setTimeout(() => { autoRotate = true; }, 10000);
  });
  window.addEventListener('mouseup', () => { isDragging = false; });
  window.addEventListener('mousemove', e => {
    if (isDragging) {
      targetTheta -= (e.clientX - lastMX) * 0.006;
      targetPhi   -= (e.clientY - lastMY) * 0.005;
      targetPhi    = Math.max(0.2, Math.min(Math.PI - 0.2, targetPhi));
      lastMX = e.clientX; lastMY = e.clientY;
    }
    mouse2D.x =  (e.clientX / innerWidth)  * 2 - 1;
    mouse2D.y = -(e.clientY / innerHeight) * 2 + 1;
  });
  window.addEventListener('wheel', e => {
    targetR = Math.max(1.5, Math.min(120, targetR + e.deltaY * 0.05));
    autoRotate = false;
    setTimeout(() => { autoRotate = true; }, 5000);
  }, { passive: true });
  canvas.addEventListener('click', _handleClick);
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

function _handleClick() {
  raycaster.setFromCamera(mouse2D, camera);
  const hits = raycaster.intersectObjects(starMeshes.map(s => s.mesh), false);
  if (hits.length) {
    const { star } = hits[0].object.userData;
    showDetail(star);
    flyTo(hits[0].object.position);
  }
}

// ── Animation ─────────────────────────────────────────────────────────────────
let t = 0;
const clock = new THREE.Clock();

function _animate() {
  animFrame = requestAnimationFrame(_animate);
  const dt = clock.getDelta();
  t += dt;

  if (autoRotate && !isDragging) targetTheta += 0.0008;

  // Smoothly move orbit target toward the new target
  orbitTarget.lerp(orbitTargetNew, 0.05);

  camTheta += (targetTheta - camTheta) * 0.04;
  camPhi   += (targetPhi   - camPhi)   * 0.04;
  camR     += (targetR     - camR)     * 0.04;

  // Camera orbits around orbitTarget, not the world origin
  camera.position.x = orbitTarget.x + camR * Math.sin(camPhi) * Math.sin(camTheta);
  camera.position.y = orbitTarget.y + camR * Math.cos(camPhi);
  camera.position.z = orbitTarget.z + camR * Math.sin(camPhi) * Math.cos(camTheta);
  camera.lookAt(orbitTarget);

  // Gentle float
  starMeshes.forEach(({ mesh, basePos }, i) => {
    mesh.position.x = basePos.x + Math.sin(t * 0.25 + i)       * 0.04;
    mesh.position.y = basePos.y + Math.cos(t * 0.2  + i * 1.3) * 0.04;
    mesh.position.z = basePos.z + Math.sin(t * 0.18 + i * 0.7) * 0.04;
  });

  _updateHover();
  renderer.render(scene, camera);
}

// ── Hover ─────────────────────────────────────────────────────────────────────
function _updateHover() {
  raycaster.setFromCamera(mouse2D, camera);
  const hits    = raycaster.intersectObjects(starMeshes.map(s => s.mesh), false);
  const tooltip = document.getElementById('tooltip');

  if (hits.length) {
    const { star } = hits[0].object.userData;
    document.body.style.cursor = 'pointer';
    if (hoveredMesh !== hits[0].object) {
      hoveredMesh = hits[0].object;
      tooltip.style.display = 'block';
      document.getElementById('tt-title').textContent = star.title || '';
      document.getElementById('tt-meta').textContent  =
        `${(star.authors || '').split(',')[0]} · ${star.year || ''} · ${(star.cite || 0).toLocaleString()} citations`;
    }
    const proj = hits[0].object.position.clone().project(camera);
    tooltip.style.left = ((proj.x * 0.5 + 0.5) * innerWidth  + 16) + 'px';
    tooltip.style.top  = ((-proj.y * 0.5 + 0.5) * innerHeight - 10) + 'px';
    ringMesh.position.copy(hits[0].object.position);
    ringMesh.lookAt(camera.position);
    ringMesh.visible = true;
    ringMat.opacity  = 0.9;
  } else {
    document.body.style.cursor = 'crosshair';
    hoveredMesh = null;
    tooltip.style.display = 'none';
    ringMesh.visible = false;
  }
}