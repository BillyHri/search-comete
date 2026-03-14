/**
 * search-comete — galaxy.js
 * Three.js scene: stars, nebulae, orbit controls, raycaster, animations.
 * Receives star data from main.js and exposes highlight / flyTo / filter.
 */

import * as THREE from 'three';
import { showDetail } from './panel.js';

// ── Cluster colour map ────────────────────────────────────────────────────────
export const CLUSTER_COLORS = {
  ml:   0x7c6dfa,
  bio:  0x3dd9a4,
  phys: 0xfa8c4f,
  cs:   0x5ab4f5,
  math: 0xf06ba8,
};

const DEFAULT_COLOR = 0x8888aa;

let renderer, scene, camera;
let starMeshes = [];      // { mesh, star }
let ringMesh, ringMat;
let bgPoints;
let camTheta = 0, camPhi = Math.PI / 2, camR = 11;
let targetTheta = 0, targetPhi = Math.PI / 2, targetR = 11;
let isDragging = false, lastMX = 0, lastMY = 0;
let autoRotate = true;
const mouse2D = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let hoveredMesh = null;
let animFrame;

// ── Public: initialise ────────────────────────────────────────────────────────
export function initGalaxy(canvas, stars) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x0a0a12, 1);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 200);
  camera.position.set(0, 0, 11);

  scene.add(new THREE.AmbientLight(0x111122, 2));

  _buildBackground();
  _buildNebulae(stars);
  _buildStars(stars);
  _buildRing();
  _bindControls(canvas);

  // Fly-in on load
  targetR = 18;
  setTimeout(() => { targetR = 11; }, 800);

  cancelAnimationFrame(animFrame);
  _animate();
}

// ── Public: highlight a set of paper IDs (search results) ────────────────────
export function highlightStars(ids) {
  const idSet = new Set(ids);
  starMeshes.forEach(({ mesh, star }) => {
    const hit = idSet.has(star.id);
    mesh.material.color.setHex(hit ? 0xffffff : CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR);
    mesh.material.transparent = !hit;
    mesh.material.opacity = hit ? 1 : 0.1;
    mesh.scale.setScalar(hit ? 1.8 : 1);
    mesh.children[0].material.opacity = hit ? 0.35 : 0;
  });
}

// ── Public: clear all highlights ─────────────────────────────────────────────
export function clearHighlights() {
  starMeshes.forEach(({ mesh, star }) => {
    mesh.material.color.setHex(CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR);
    mesh.material.transparent = false;
    mesh.material.opacity = 1;
    mesh.scale.setScalar(1);
    mesh.children[0].material.opacity = 0.08;
  });
}

// ── Public: filter by cluster ─────────────────────────────────────────────────
export function filterCluster(clusterId) {
  clearHighlights();
  if (clusterId === 'all') return;

  starMeshes.forEach(({ mesh, star }) => {
    const match = star.cluster === clusterId;
    mesh.material.transparent = !match;
    mesh.material.opacity = match ? 1 : 0.06;
    mesh.scale.setScalar(match ? 1.15 : 1);
  });

  // Find centroid of cluster and fly there
  const members = starMeshes.filter(({ star }) => star.cluster === clusterId);
  if (members.length) {
    const avg = members.reduce((acc, { star }) => ({
      x: acc.x + (star.x || 0),
      y: acc.y + (star.y || 0),
      z: acc.z + (star.z || 0),
    }), { x: 0, y: 0, z: 0 });
    flyTo({ x: avg.x / members.length, y: avg.y / members.length, z: avg.z / members.length });
  }
}

// ── Public: warp camera toward a 3D position ─────────────────────────────────
export function flyTo({ x, y, z }) {
  const dir = new THREE.Vector3(x, y, z).normalize();
  targetTheta = Math.atan2(dir.x, dir.z);
  targetPhi   = Math.acos(Math.max(-1, Math.min(1, dir.y))) + 0.4;
  targetR     = 5;
  document.getElementById('warp-overlay').classList.add('active');
  setTimeout(() => {
    document.getElementById('warp-overlay').classList.remove('active');
    targetR = 9;
  }, 450);
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _buildBackground() {
  const count = 3000;
  const pos   = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3]     = (Math.random() - 0.5) * 120;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 120;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  bgPoints = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.04, transparent: true, opacity: 0.28,
  }));
  scene.add(bgPoints);
}

function _buildNebulae(stars) {
  // Group stars by cluster to find centroids
  const centroids = {};
  stars.forEach(s => {
    if (!centroids[s.cluster]) centroids[s.cluster] = { x: 0, y: 0, z: 0, n: 0 };
    centroids[s.cluster].x += (s.x || 0);
    centroids[s.cluster].y += (s.y || 0);
    centroids[s.cluster].z += (s.z || 0);
    centroids[s.cluster].n++;
  });

  Object.entries(centroids).forEach(([cluster, c]) => {
    const cx = c.x / c.n, cy = c.y / c.n, cz = c.z / c.n;
    const color = CLUSTER_COLORS[cluster] || DEFAULT_COLOR;
    const sprite = _makeNebulaSprite(color, 10);
    sprite.position.set(cx, cy, cz);
    scene.add(sprite);
  });
}

function _makeNebulaSprite(color, size) {
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 256;
  const ctx = cvs.getContext('2d');
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0,   `rgba(${r},${g},${b},0.18)`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.06)`);
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

function _buildStars(stars) {
  starMeshes = [];
  stars.forEach(star => {
    const col  = CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR;
    // Size by citation count (log scale)
    const size = 0.04 + Math.log10((star.cite || 10) + 10) * 0.012;

    const geo  = new THREE.SphereGeometry(size, 8, 8);
    const mat  = new THREE.MeshBasicMaterial({ color: col });
    const mesh = new THREE.Mesh(geo, mat);

    const x = star.x || 0, y = star.y || 0, z = star.z || 0;
    mesh.position.set(x, y, z);
    mesh.userData = { star, basePos: new THREE.Vector3(x, y, z) };

    // Glow halo
    const haloMat = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.08,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mesh.add(new THREE.Mesh(new THREE.SphereGeometry(size * 2.8, 8, 8), haloMat));

    scene.add(mesh);
    starMeshes.push({ mesh, star });
  });

  _buildEdges();
}

function _buildEdges() {
  // Light connecting lines between nearby stars in the same cluster
  starMeshes.forEach((a, i) => {
    starMeshes.forEach((b, j) => {
      if (j <= i || a.star.cluster !== b.star.cluster) return;
      const dist = a.mesh.userData.basePos.distanceTo(b.mesh.userData.basePos);
      if (dist > 2.5) return;
      const alpha = (1 - dist / 2.5) * 0.1;
      const geo = new THREE.BufferGeometry().setFromPoints([
        a.mesh.userData.basePos, b.mesh.userData.basePos,
      ]);
      scene.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: CLUSTER_COLORS[a.star.cluster] || DEFAULT_COLOR,
        transparent: true, opacity: alpha,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })));
    });
  });
}

function _buildRing() {
  ringMat  = new THREE.MeshBasicMaterial({ color: 0xc9a84c, side: THREE.DoubleSide, transparent: true, opacity: 0 });
  ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.14, 32), ringMat);
  ringMesh.visible = false;
  scene.add(ringMesh);
}

function _bindControls(canvas) {
  canvas.addEventListener('mousedown', e => {
    isDragging = true; lastMX = e.clientX; lastMY = e.clientY;
    autoRotate = false;
    setTimeout(() => { autoRotate = true; }, 8000);
  });
  window.addEventListener('mouseup', () => { isDragging = false; });
  window.addEventListener('mousemove', e => {
    if (isDragging) {
      targetTheta -= (e.clientX - lastMX) * 0.008;
      targetPhi   -= (e.clientY - lastMY) * 0.006;
      targetPhi    = Math.max(0.3, Math.min(Math.PI - 0.3, targetPhi));
      lastMX = e.clientX; lastMY = e.clientY;
    }
    mouse2D.x =  (e.clientX / innerWidth)  * 2 - 1;
    mouse2D.y = -(e.clientY / innerHeight) * 2 + 1;
  });
  window.addEventListener('wheel', e => {
    targetR = Math.max(3, Math.min(22, targetR + e.deltaY * 0.01));
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

let t = 0;
const clock = new THREE.Clock();

function _animate() {
  animFrame = requestAnimationFrame(_animate);
  const dt = clock.getDelta();
  t += dt;

  if (autoRotate && !isDragging) targetTheta += 0.0015;

  camTheta += (targetTheta - camTheta) * 0.05;
  camPhi   += (targetPhi   - camPhi)   * 0.05;
  camR     += (targetR     - camR)     * 0.05;

  camera.position.x = camR * Math.sin(camPhi) * Math.sin(camTheta);
  camera.position.y = camR * Math.cos(camPhi);
  camera.position.z = camR * Math.sin(camPhi) * Math.cos(camTheta);
  camera.lookAt(0, 0, 0);

  // Gentle float
  starMeshes.forEach(({ mesh }, i) => {
    const { basePos } = mesh.userData;
    mesh.position.x = basePos.x + Math.sin(t * 0.3 + i)       * 0.04;
    mesh.position.y = basePos.y + Math.cos(t * 0.25 + i * 1.3) * 0.04;
    mesh.position.z = basePos.z + Math.sin(t * 0.2 + i * 0.7)  * 0.04;
  });

  _updateRaycaster();
  renderer.render(scene, camera);
}

function _updateRaycaster() {
  raycaster.setFromCamera(mouse2D, camera);
  const hits = raycaster.intersectObjects(starMeshes.map(s => s.mesh), false);
  const tooltip = document.getElementById('tooltip');

  if (hits.length) {
    document.body.style.cursor = 'pointer';
    const { star } = hits[0].object.userData;
    if (hoveredMesh !== hits[0].object) {
      hoveredMesh = hits[0].object;
      tooltip.style.display = 'block';
      document.getElementById('tt-title').textContent = star.title;
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
