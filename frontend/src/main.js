import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer, RenderPass, BloomEffect, SMAAEffect, EffectPass } from 'postprocessing';

let scene, camera, renderer, composer;
let physicsWorld;
let sky;

const EARTH_RADIUS = 6378137;
const CHUNK_SIZE = 500; // Taille d'un chunk en mètres
const RENDER_DISTANCE = 2; // Rayon autour du joueur (2 = grille 5x5)
const CHUNK_CLIP_PADDING = 12;
let hasStarted = false;
let baseLat = 0;
let baseLon = 0;
const loadedChunks = new Map();
const chunksLoading = new Set();
const chunkQueue = [];

// Variables pour la caméra debug
let pitch = -0.5, yaw = 0;
let isDragging = false;
const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };

// --- Fonctions utilitaires de validation de polygones (Point 4) ---
function ccw(A, B, C) {
  return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
}

function segmentsIntersect(p1, p2, p3, p4) {
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

function isValidPolygon(points) {
  if (points.length < 3) return false;
  
  // Vérification de l'aire (on ignore les polygones dégénérés < 1m²)
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  if (Math.abs(area / 2) < 1.0) return false;

  // Vérification des auto-intersections (O(n^2), ok pour des bâtiments)
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    for (let j = i + 2; j < points.length; j++) {
      const k = (j + 1) % points.length;
      if (i === k) continue;
      const p3 = points[j];
      const p4 = points[k];
      if (segmentsIntersect(p1, p2, p3, p4)) return false;
    }
  }
  return true;
}

function clampRoadWidth(width) {
  if (!Number.isFinite(width)) return 4;
  return Math.min(Math.max(width, 2.5), 16);
}

function getRoadWidth(tags) {
  if (tags.width) return clampRoadWidth(parseFloat(tags.width));
  if (tags.lanes) return clampRoadWidth(parseInt(tags.lanes, 10) * 3.5);
  if (tags.highway === 'motorway' || tags.highway === 'trunk') return 10;
  if (tags.highway === 'primary' || tags.highway === 'secondary') return 7;
  return 4;
}

function isPointInChunk(point, padding = CHUNK_CLIP_PADDING) {
  const limit = CHUNK_SIZE / 2 + padding;
  return point.x >= -limit && point.x <= limit && point.z >= -limit && point.z <= limit;
}

function interpolatePoint(a, b, t) {
  return new THREE.Vector3(
    a.x + (b.x - a.x) * t,
    a.y + (b.y - a.y) * t,
    a.z + (b.z - a.z) * t
  );
}

function clipSegmentToChunk(a, b, padding = CHUNK_CLIP_PADDING) {
  const limit = CHUNK_SIZE / 2 + padding;
  const minX = -limit;
  const maxX = limit;
  const minZ = -limit;
  const maxZ = limit;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let t0 = 0;
  let t1 = 1;

  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  if (
    clip(-dx, a.x - minX) &&
    clip(dx, maxX - a.x) &&
    clip(-dz, a.z - minZ) &&
    clip(dz, maxZ - a.z)
  ) {
    return [interpolatePoint(a, b, t0), interpolatePoint(a, b, t1)];
  }

  return null;
}

function pushPointIfDistinct(points, point) {
  const last = points[points.length - 1];
  if (!last || last.distanceTo(point) > 0.05) points.push(point);
}

function splitRoadIntoChunkPolylines(points) {
  const polylines = [];
  let current = [];

  for (let i = 0; i < points.length - 1; i++) {
    const clipped = clipSegmentToChunk(points[i], points[i + 1]);
    if (!clipped) {
      if (current.length > 1) polylines.push(current);
      current = [];
      continue;
    }

    const startsInside = isPointInChunk(points[i]);
    if (!startsInside && current.length > 1) {
      polylines.push(current);
      current = [];
    }

    pushPointIfDistinct(current, clipped[0]);
    pushPointIfDistinct(current, clipped[1]);
  }

  if (current.length > 1) polylines.push(current);
  return polylines;
}

function createRoadMesh(points, width, material) {
  if (points.length < 2) return null;

  const pos = [];
  const indices = [];

  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const tangent = next.clone().sub(prev);
    tangent.y = 0;
    if (tangent.lengthSq() < 0.0001) continue;
    tangent.normalize();

    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const left = points[i].clone().add(normal.clone().multiplyScalar(width / 2));
    const right = points[i].clone().add(normal.clone().multiplyScalar(-width / 2));
    left.y += 0.25;
    right.y += 0.25;

    pos.push(left.x, left.y, left.z, right.x, right.y, right.z);
  }

  const vertexPairs = pos.length / 6;
  if (vertexPairs < 2) return null;

  for (let i = 0; i < vertexPairs - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

// --- Initialisation Three.js ---
function initThree() {
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xE8B98A, 200, 1200);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 50, 50);

  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  const ambientLight = new THREE.AmbientLight(0x7B6FA8, 0.4);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xFFB870, 1.5);
  dirLight.position.set(-50, 80, -20);
  scene.add(dirLight);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new EffectPass(camera, new BloomEffect({ luminanceThreshold: 0.8, intensity: 0.5 }), new SMAAEffect()));

  createSky();

  window.addEventListener('resize', onWindowResize);
}

// --- Création de la Skybox (Point 3) ---
function createSky() {
  const skyGeo = new THREE.SphereGeometry(1500, 32, 15);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x7B6FA8) },    // Zénith
      bottomColor: { value: new THREE.Color(0xF2A65A) }, // Horizon
      offset: { value: 33 },
      exponent: { value: 0.6 }
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vWorldPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + offset).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false
  });
  sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);
}

// --- Initialisation Physique Rapier ---
async function initPhysics() {
  await RAPIER.init();
  physicsWorld = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
  const groundCollider = RAPIER.ColliderDesc.cuboid(10000, 0.1, 10000);
  physicsWorld.createCollider(groundCollider);
}

// --- Conversions GPS <-> 3D ---
function latLonToVector3(lat, lon) {
  const x = (lon - baseLon) * (Math.PI / 180) * EARTH_RADIUS * Math.cos(baseLat * Math.PI / 180);
  const z = (lat - baseLat) * (Math.PI / 180) * EARTH_RADIUS;
  return new THREE.Vector3(x, 0, z);
}

function vector3ToLatLon(x, z) {
  const lat = baseLat + (z / EARTH_RADIUS) * (180 / Math.PI);
  const lon = baseLon + (x / (EARTH_RADIUS * Math.cos(baseLat * Math.PI / 180))) * (180 / Math.PI);
  return { lat, lon };
}

// --- Gestion des Chunks ---
function updateChunks() {
    if (!hasStarted) return;
  const camX = Math.floor(camera.position.x / CHUNK_SIZE);
  const camZ = Math.floor(camera.position.z / CHUNK_SIZE);

  // 1. Décharger les chunks trop loins
  for (const [key, chunk] of loadedChunks) {
    const dx = Math.abs(chunk.gridX - camX);
    const dz = Math.abs(chunk.gridZ - camZ);
    if (dx > RENDER_DISTANCE + 1 || dz > RENDER_DISTANCE + 1) {
      scene.remove(chunk.group);
      chunk.group.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
      });
      loadedChunks.delete(key);
    }
  }

  // 2. Identifier les chunks à charger
  for (let x = camX - RENDER_DISTANCE; x <= camX + RENDER_DISTANCE; x++) {
    for (let z = camZ - RENDER_DISTANCE; z <= camZ + RENDER_DISTANCE; z++) {
      const key = `${x}_${z}`;
      if (!loadedChunks.has(key) && !chunksLoading.has(key) && !chunkQueue.some(c => c.key === key)) {
        chunkQueue.push({ key, gridX: x, gridZ: z });
      }
    }
  }

  // 3. Traiter la file d'attente (1 à la fois pour Overpass)
  if (chunkQueue.length > 0 && chunksLoading.size < 1) {
    loadChunk(chunkQueue.shift());
  }
}

async function loadChunk(chunkInfo) {
  const { key, gridX, gridZ } = chunkInfo;
  chunksLoading.add(key);

  const worldX = gridX * CHUNK_SIZE;
  const worldZ = gridZ * CHUNK_SIZE;
  const center = vector3ToLatLon(worldX, worldZ);

  try {
    const response = await fetch(`http://localhost:3001/api/chunk?lat=${center.lat}&lon=${center.lon}&size=${CHUNK_SIZE}`);
    const data = await response.json();

    if (!response.ok) throw new Error(data.error);

    const group = new THREE.Group();
    group.position.set(worldX, 0, worldZ);

    const offsetVec = latLonToVector3(center.lat, center.lon);
    
    // 1. Terrain (Point 1 : Utilisation de l'élévation réelle du backend)
    const terrainGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, data.terrain.segments, data.terrain.segments);
    terrainGeo.rotateX(-Math.PI / 2);
    const positions = terrainGeo.attributes.position;
    const heights = data.terrain.heights;
    
    for (let i = 0; i < positions.count; i++) {
      positions.setY(i, heights[i]);
    }
    terrainGeo.computeVertexNormals();
    const terrainMesh = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ color: 0x7A8C4E, flatShading: true }));
    group.add(terrainMesh);

    // 2. Bâtiments (Point 4 : Validation des polygones et fallback)
    const buildingMat = new THREE.MeshStandardMaterial({ color: 0xC97B4C, flatShading: true });
    data.buildings.forEach(b => {
      if (b.geometry.length < 3) return;
      
      // On mappe en points locaux, en utilisant l'élévation réelle du backend
      const points3D = b.geometry.map(p => {
        const v = latLonToVector3(p.lat, p.lon);
        v.y = p.elevation || 0;
        return v;
      });
      const localPts = points3D.map(p => new THREE.Vector3(p.x - offsetVec.x, p.y, p.z - offsetVec.z));

      // Nettoyage : suppression des doublons et du point de fermeture redondant
      const cleanPts = [];
      for (let i = 0; i < localPts.length; i++) {
        const last = cleanPts[cleanPts.length - 1];
        if (!last || last.distanceTo(localPts[i]) > 0.1) {
          cleanPts.push(localPts[i]);
        }
      }
      if (cleanPts.length > 2 && cleanPts[0].distanceTo(cleanPts[cleanPts.length - 1]) < 0.1) {
        cleanPts.pop();
      }

      const pts2D = cleanPts.map(p => ({ x: p.x, y: p.z }));

      let height = 10;
      if (b.tags['building:levels']) height = parseInt(b.tags['building:levels']) * 3;
      else if (b.tags['height']) height = parseFloat(b.tags['height']);
      if (isNaN(height) || height > 150) height = 10 + Math.random() * 5;
      else height += Math.random() * 2;

      try {
        if (!isValidPolygon(pts2D)) throw new Error("Polygone invalide ou dégénéré");

        const shape = new THREE.Shape();
        shape.moveTo(pts2D[0].x, pts2D[0].y);
        for (let i = 1; i < pts2D.length; i++) shape.lineTo(pts2D[i].x, pts2D[i].y);
        shape.closePath();

        const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        
        const buildingY = cleanPts[0].y;
        geo.translate(0, buildingY + 0.1, 0);
        group.add(new THREE.Mesh(geo, buildingMat));
      } catch (e) {
        // Fallback boîte englobante si polygone invalide
        const box = new THREE.Box3();
        cleanPts.forEach(p => box.expandByPoint(p));
        if (box.isEmpty()) return; // Ignorer silencieusement si rien à afficher
        
        const size = new THREE.Vector3(); box.getSize(size);
        const centerBox = new THREE.Vector3(); box.getCenter(centerBox);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, height, size.z), buildingMat);
        const buildingY = centerBox.y;
        mesh.position.set(centerBox.x, buildingY + height / 2 + 0.1, centerBox.z);
        group.add(mesh);
      }
    });

    // 3. Routes (Point 1 : Élévation réelle du backend)
    const roadMat = new THREE.MeshStandardMaterial({
      color: 0x2C2C34,
      roughness: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    data.roads.forEach(r => {
      if (r.geometry.length < 2) return;
      const points3D = r.geometry.map(p => {
        const v = latLonToVector3(p.lat, p.lon);
        v.y = p.elevation || 0;
        return v;
      });
      const localPts = points3D.map(p => new THREE.Vector3(p.x - offsetVec.x, p.y, p.z - offsetVec.z));

      const width = getRoadWidth(r.tags);
      splitRoadIntoChunkPolylines(localPts).forEach(polyline => {
        const mesh = createRoadMesh(polyline, width, roadMat);
        if (mesh) group.add(mesh);
      });
    });

    scene.add(group);
    loadedChunks.set(key, { gridX, gridZ, group });

  } catch (error) {
    console.error("Erreur chunk", key, error);
    if (!chunkQueue.some(c => c.key === key)) {
      chunkQueue.push(chunkInfo);
    }
  } finally {
    chunksLoading.delete(key);
  }
}

// --- Géocodage ---
async function searchAddress() {
  const input = document.getElementById('address-input');
  const address = input.value.trim();
  if (!address) return;

  try {
    const response = await fetch(`http://localhost:3001/api/geocode?q=${encodeURIComponent(address)}`);
    const data = await response.json();
    if (response.ok) {
      baseLat = data.lat;
      baseLon = data.lon;
      hasStarted = true;
      loadedChunks.forEach(c => scene.remove(c.group));
      loadedChunks.clear();
      chunkQueue.length = 0;

      camera.position.set(0, 100, 100);
      yaw = 0; pitch = -0.5;
      updateChunks();
    } else {
      alert("Adresse introuvable.");
    }
  } catch (error) {
    alert("Erreur de connexion au backend.");
  }
}

// --- Contrôles Caméra Debug ---
function setupControls() {
  const canvas = document.getElementById('game-canvas');
  
  canvas.addEventListener('mousedown', () => isDragging = true);
  canvas.addEventListener('mouseup', () => isDragging = false);
  canvas.addEventListener('mouseleave', () => isDragging = false);
  canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    yaw -= e.movementX * 0.002;
    pitch -= e.movementY * 0.002;
    pitch = Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, pitch));
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyW') keys.w = true;
    if (e.code === 'KeyA') keys.a = true;
    if (e.code === 'KeyS') keys.s = true;
    if (e.code === 'KeyD') keys.d = true;
    if (e.code === 'Space') keys.space = true;
    if (e.code === 'ShiftLeft') keys.shift = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW') keys.w = false;
    if (e.code === 'KeyA') keys.a = false;
    if (e.code === 'KeyS') keys.s = false;
    if (e.code === 'KeyD') keys.d = false;
    if (e.code === 'Space') keys.space = false;
    if (e.code === 'ShiftLeft') keys.shift = false;
  });

  document.getElementById('search-btn').addEventListener('click', searchAddress);
  document.getElementById('address-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchAddress();
  });
}

function updateCameraMovement() {
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  const speed = keys.shift ? 100 : 40;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y = 0; dir.normalize();

  const right = new THREE.Vector3();
  right.crossVectors(dir, new THREE.Vector3(0, 1, 0));

  if (keys.w) camera.position.add(dir.clone().multiplyScalar(speed));
  if (keys.s) camera.position.add(dir.clone().multiplyScalar(-speed));
  if (keys.a) camera.position.add(right.clone().multiplyScalar(-speed));
  if (keys.d) camera.position.add(right.clone().multiplyScalar(speed));
  if (keys.space) camera.position.y += speed;
  if (keys.shift) camera.position.y -= speed;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  updateCameraMovement();
  if (sky) sky.position.copy(camera.position);
  updateChunks();
  if (physicsWorld) physicsWorld.step();
  composer.render();
}

async function main() {
  initThree();
  await initPhysics();
  setupControls();
  animate();
}

main();
