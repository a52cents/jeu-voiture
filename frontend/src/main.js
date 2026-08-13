import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer, RenderPass, BloomEffect, SMAAEffect, EffectPass } from 'postprocessing';

let scene, camera, renderer, composer;
let physicsWorld;
let sky;
let minimap; 
let minimapContainer; 

// Variables pour la voiture
let vehicleController;
let chassisBody;
let chassisMesh;
let wheelMeshes = [];

const EARTH_RADIUS = 6378137;
const CHUNK_SIZE = 500; 
const RENDER_DISTANCE = 2; 
const CHUNK_CLIP_PADDING = 12;
let hasStarted = false;
let baseLat = 0;
let baseLon = 0;
const loadedChunks = new Map();
const chunksLoading = new Set();
const chunkQueue = [];

// Contrôles voiture
const keys = { up: false, down: false, left: false, right: false, brake: false };

// --- Fonctions utilitaires ---
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
    left.y = 0.25; 
    right.y = 0.25;

    pos.push(left.x, left.y, left.z, right.x, right.y, right.z);
  }

  const vertexPairs = pos.length / 6;
  if (vertexPairs < 2) return null;

  for (let i = 0; i < vertexPairs - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
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

// --- Création de la Skybox ---
function createSky() {
  const skyGeo = new THREE.SphereGeometry(1500, 32, 15);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x7B6FA8) },
      bottomColor: { value: new THREE.Color(0xF2A65A) },
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

// --- Initialisation Minimap (Leaflet) ---
function initMinimap() {
  if (!window.L || !document.getElementById('minimap')) return;
  
  minimapContainer = document.getElementById('minimap-rotator');

  minimap = window.L.map('minimap', {
    zoomControl: false,
    attributionControl: false, 
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false
  }).setView([0, 0], 16);

  window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri'
  }).addTo(minimap);

  setTimeout(() => { minimap.invalidateSize(); }, 100);
}

// --- Initialisation Physique Rapier + Voiture ---
async function initPhysics() {
  await RAPIER.init();
  physicsWorld = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
  
  // Sol physique
  const groundCollider = RAPIER.ColliderDesc.cuboid(10000, 0.1, 10000);
  physicsWorld.createCollider(groundCollider);

  // --- Création du véhicule ---
  const chassisHalfExtents = { x: 1.0, y: 0.5, z: 2.0 };
  const chassisDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 2.0, 0)
    .setLinearDamping(0.5)
    .setAngularDamping(0.5);
  
  chassisBody = physicsWorld.createRigidBody(chassisDesc);
  
  const colliderDesc = RAPIER.ColliderDesc.cuboid(chassisHalfExtents.x, chassisHalfExtents.y, chassisHalfExtents.z)
    .setDensity(1.5)
    .setFriction(0.5);
  physicsWorld.createCollider(colliderDesc, chassisBody);

  vehicleController = new RAPIER.DynamicRayCastVehicleController(chassisBody);

  // Roues
  const wheelPositions = [
    { x: -1.1, y: -0.4, z: 1.5 },
    { x: 1.1, y: -0.4, z: 1.5 },
    { x: -1.1, y: -0.4, z: -1.5 },
    { x: 1.1, y: -0.4, z: -1.5 }
  ];

  wheelPositions.forEach(pos => {
    vehicleController.addWheel(
      { x: pos.x, y: pos.y, z: pos.z }, // Point de fixation sur le châssis
      { x: 0, y: -1, z: 0 },            // Direction de la suspension (vers le bas)
      { x: 1, y: 0, z: 0 },             // Axe de la roue (X)
      30.0,                              // Suspension Stiffness
      0.6,                               // Suspension Rest Length
      0.5,                               // Suspension Max Travel
      2.0,                               // Suspension Damping
      4.0,                               // Suspension Compression
      0.5,                               // Rayon de la roue
      1.5,                               // Friction Slip
      0.1,                               // Rolling Resistance
      0.7                                // Max Steering Angle
    );

    // Mesh de la roue
    const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 16);
    wheelGeo.rotateZ(Math.PI / 2); 
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const wheelMesh = new THREE.Mesh(wheelGeo, wheelMat);
    scene.add(wheelMesh);
    wheelMeshes.push(wheelMesh);
  });

  // Mesh du châssis
  const carGeo = new THREE.BoxGeometry(chassisHalfExtents.x * 2, chassisHalfExtents.y * 2, chassisHalfExtents.z * 2);
  const carMat = new THREE.MeshStandardMaterial({ color: 0xF2A65A });
  chassisMesh = new THREE.Mesh(carGeo, carMat);
  scene.add(chassisMesh);
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
  
  const carPos = chassisBody ? chassisBody.translation() : { x: 0, z: 0 };
  const camX = Math.floor(carPos.x / CHUNK_SIZE);
  const camZ = Math.floor(carPos.z / CHUNK_SIZE);

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

  for (let x = camX - RENDER_DISTANCE; x <= camX + RENDER_DISTANCE; x++) {
    for (let z = camZ - RENDER_DISTANCE; z <= camZ + RENDER_DISTANCE; z++) {
      const key = `${x}_${z}`;
      if (!loadedChunks.has(key) && !chunksLoading.has(key) && !chunkQueue.some(c => c.key === key)) {
        chunkQueue.push({ key, gridX: x, gridZ: z });
      }
    }
  }

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
    
    const terrainGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, 1, 1);
    terrainGeo.rotateX(-Math.PI / 2);
    const terrainMesh = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ color: 0x7A8C4E }));
    group.add(terrainMesh);

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
        v.y = 0;
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

      if (chassisBody) {
        chassisBody.setTranslation({ x: 0, y: 2.0, z: 0 }, true);
        chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        chassisBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      }
      
      if (minimap) {
        minimap.setView([baseLat, baseLon], 16, { animate: false });
      }
      
      updateChunks();
    } else {
      alert("Adresse introuvable.");
    }
  } catch (error) {
    alert("Erreur de connexion au backend.");
  }
}

// --- Contrôles Voiture ---
function setupControls() {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.up = true;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.down = true;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = true;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = true;
    if (e.code === 'Space') keys.brake = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.up = false;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.down = false;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
    if (e.code === 'Space') keys.brake = false;
  });

  document.getElementById('search-btn').addEventListener('click', searchAddress);
  document.getElementById('address-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchAddress();
  });
}

function updateVehicleAndCamera() {
  if (!vehicleController || !chassisBody) return;

  const maxForce = 20.0;
  const maxSteer = 0.5;

  let engineForce = 0;
  let brakeForce = 0;
  let steerAngle = 0;

  if (keys.up) engineForce = maxForce;
  if (keys.down) engineForce = -maxForce * 0.5; 
  if (keys.left) steerAngle = maxSteer;
  if (keys.right) steerAngle = -maxSteer;
  if (keys.brake) {
    engineForce = 0;
    brakeForce = 10.0;
  }

  // CORRECTION API RAPIER : On applique les forces roue par roue
  // Moteur (4 roues motrices pour la simplicité)
  for (let i = 0; i < 4; i++) {
    vehicleController.setWheelEngineForce(i, engineForce);
    vehicleController.setWheelBrake(i, brakeForce);
  }

  // Direction (Roues avant uniquement)
  vehicleController.setWheelSteering(0, steerAngle);
  vehicleController.setWheelSteering(1, steerAngle);

  vehicleController.updateVehicle(1 / 60); 

  // Synchroniser les meshes Three.js
  const pos = chassisBody.translation();
  const rot = chassisBody.rotation();
  chassisMesh.position.set(pos.x, pos.y, pos.z);
  chassisMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);

  for (let i = 0; i < 4; i++) {
    const wheel = vehicleController.wheel(i);
    const wPos = wheel.worldSpacePosition();
    const wRot = wheel.worldSpaceRotation();
    wheelMeshes[i].position.set(wPos.x, wPos.y, wPos.z);
    wheelMeshes[i].quaternion.set(wRot.x, wRot.y, wRot.z, wRot.w);
  }

  // --- Caméra 3ème personne ---
  const idealOffset = new THREE.Vector3(0, 5, -12);
  idealOffset.applyQuaternion(chassisMesh.quaternion);
  idealOffset.add(chassisMesh.position);

  camera.position.lerp(idealOffset, 0.1);

  const lookAtTarget = chassisMesh.position.clone();
  lookAtTarget.y += 1.0;
  camera.lookAt(lookAtTarget);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  updateVehicleAndCamera();
  if (sky) sky.position.copy(camera.position);
  updateChunks();
  
  if (minimap && hasStarted && minimapContainer && chassisBody) {
    const pos = chassisBody.translation();
    const { lat, lon } = vector3ToLatLon(pos.x, pos.z);
    minimap.setView([lat, lon], minimap.getZoom(), { animate: false });
    
    const forward = new THREE.Vector3(0, 0, 1);
    forward.applyQuaternion(chassisMesh.quaternion);
    const carYaw = Math.atan2(forward.x, forward.z);
    
    const mapDegrees = -carYaw * (180 / Math.PI) + 180;
    minimapContainer.style.transform = `translate(-50%, -50%) rotate(${mapDegrees}deg)`;
  }
  
  if (physicsWorld) physicsWorld.step();
  composer.render();
}

async function main() {
  initThree();
  initMinimap();
  await initPhysics();
  setupControls();
  animate();
}

main();