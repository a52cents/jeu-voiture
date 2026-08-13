import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer, RenderPass, BloomEffect, SMAAEffect, EffectPass } from 'postprocessing';

let scene, camera, renderer, composer;
let physicsWorld;

const EARTH_RADIUS = 6378137;
const CHUNK_SIZE = 500; // Taille d'un chunk en mètres
const RENDER_DISTANCE = 2; // Rayon autour du joueur (2 = grille 5x5)

let baseLat = 0;
let baseLon = 0;
const loadedChunks = new Map();
const chunksLoading = new Set();
const chunkQueue = [];

// Variables pour la caméra debug
let pitch = -0.5, yaw = 0;
let isDragging = false;
const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };

// Fonction utilitaire pour le bruit du terrain (pour que routes et terrain aient la même hauteur)
function getTerrainHeight(x, z) {
  return Math.sin(x * 0.05) * Math.cos(z * 0.05) * 1.5;
}

// --- Initialisation Three.js ---
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xF2A65A);
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

  window.addEventListener('resize', onWindowResize);
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
    
    // 1. Terrain (CORRIGÉ : ne plus appliquer l'offsetVec, le groupe s'en charge)
    const terrainGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, 20, 20);
    terrainGeo.rotateX(-Math.PI / 2);
    const positions = terrainGeo.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const px = positions.getX(i);
      const pz = positions.getZ(i);
      // Utiliser les coordonnées absolues pour le bruit
      const py = getTerrainHeight(worldX + px, worldZ + pz);
      positions.setY(i, py);
    }
    terrainGeo.computeVertexNormals();
    const terrainMesh = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ color: 0x7A8C4E, flatShading: true }));
    group.add(terrainMesh);

    // 2. Bâtiments
    const buildingMat = new THREE.MeshStandardMaterial({ color: 0xC97B4C, flatShading: true });
    data.buildings.forEach(b => {
      if (b.geometry.length < 3) return;
      const shape = new THREE.Shape();
      const points3D = b.geometry.map(p => latLonToVector3(p.lat, p.lon));
      const localPts = points3D.map(p => new THREE.Vector3(p.x - offsetVec.x, 0, p.z - offsetVec.z));

      shape.moveTo(localPts[0].x, localPts[0].z);
      for (let i = 1; i < localPts.length; i++) shape.lineTo(localPts[i].x, localPts[i].z);
      shape.closePath();

      let height = 10;
      if (b.tags['building:levels']) height = parseInt(b.tags['building:levels']) * 3;
      else if (b.tags['height']) height = parseFloat(b.tags['height']);
      if (isNaN(height) || height > 150) height = 10 + Math.random() * 5;
      else height += Math.random() * 2;

      try {
        const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        // Poser le bâtiment sur la hauteur du terrain à son centre
        const buildingY = getTerrainHeight(worldX + localPts[0].x, worldZ + localPts[0].z);
        geo.translate(0, buildingY + 0.1, 0);
        group.add(new THREE.Mesh(geo, buildingMat));
      } catch (e) {
        const box = new THREE.Box3();
        localPts.forEach(p => box.expandByPoint(p));
        const size = new THREE.Vector3(); box.getSize(size);
        const centerBox = new THREE.Vector3(); box.getCenter(centerBox);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, height, size.z), buildingMat);
        const buildingY = getTerrainHeight(worldX + centerBox.x, worldZ + centerBox.z);
        mesh.position.set(centerBox.x, buildingY + height / 2 + 0.1, centerBox.z);
        group.add(mesh);
      }
    });

    // 3. Routes (CORRIGÉ : Appliquer la hauteur du terrain aux points de la route)
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x2C2C34, roughness: 0.8 });
    data.roads.forEach(r => {
      if (r.geometry.length < 2) return;
      const points3D = r.geometry.map(p => latLonToVector3(p.lat, p.lon));
      const localPts = points3D.map(p => {
        const y = getTerrainHeight(worldX + (p.x - offsetVec.x), worldZ + (p.z - offsetVec.z));
        return new THREE.Vector3(p.x - offsetVec.x, y, p.z - offsetVec.z);
      });

      let width = 4;
      if (r.tags.width) width = parseFloat(r.tags.width);
      else if (r.tags.lanes) width = parseInt(r.tags.lanes) * 3.5;
      else if (r.tags.highway === 'motorway' || r.tags.highway === 'trunk') width = 10;

      const curve = new THREE.CatmullRomCurve3(localPts);
      const divisions = localPts.length * 4;
      const pos = [], indices = [];

      for (let i = 0; i <= divisions; i++) {
        const t = i / divisions;
        const point = curve.getPoint(t);
        const tangent = curve.getTangent(t).normalize();
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
        const left = point.clone().add(normal.clone().multiplyScalar(width / 2));
        const right = point.clone().add(normal.clone().multiplyScalar(-width / 2));
        left.y += 0.2; right.y += 0.2; // Léger offset pour éviter de rentrer dans le terrain

        pos.push(left.x, left.y, left.z, right.x, right.y, right.z);
        if (i < divisions) {
          const a = i * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }

      const roadGeo = new THREE.BufferGeometry();
      roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      roadGeo.setIndex(indices);
      roadGeo.computeVertexNormals();
      group.add(new THREE.Mesh(roadGeo, roadMat));
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