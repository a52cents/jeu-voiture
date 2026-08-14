import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import {
    EffectComposer, RenderPass, BloomEffect, SMAAEffect, EffectPass,
    ToneMappingEffect, ToneMappingMode, VignetteEffect, NoiseEffect,
    ScanlineEffect, ColorDepthEffect, ChromaticAberrationEffect,
    PixelationEffect, BlendFunction
} from 'postprocessing';

let scene, camera, renderer, composer;
let physicsWorld;
let sky;
let minimap;
let minimapContainer;

// --- Voiture ---
let vehicleController;
let chassisBody;
let carGroup;
let wheelsVis = [];
let masterRoot = null;
let masterWheel = null;

// --- Routes & terrain ---
let roadInfo = null;
let roadGeo = null;
let roadMats = [];
let grassTexture = null;

// ====== RÉGLAGES MODÈLE 3D (pack PSX GGBot) ======
const CAR_MODEL_URL = '/models/car_01.glb';
const CAR_WHEEL_URL = '/models/wheel.glb';
const CAR_FALLBACK_URL = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMilkTruck/glTF-Binary/CesiumMilkTruck.glb';

// ====== ROUTE 3D PSX (Sketchfab "Psx road" by BUBUK, CC-BY) ======
const ROAD_MODEL_URL = '/models/psx_road.glb';

// ====== HERBE PSX ======
const GRASS_URLS = [
    '/src/grass.jpg',
    'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/terrain/grasslight-big.jpg'
];
const GRASS_TILE_SIZE = 6;

// ============================================================
// ÉCHELLE DU MONDE
// WORLD_SCALE > 1 agrandit terrain + routes proportionnellement.
// La voiture et la caméra ne changent PAS (effet arcade : monde
// plus grand, routes plus larges, voiture relativement plus petite).
// ============================================================
const WORLD_SCALE = 2;

// ============================================================
// POST-PROCESSING "PSX SUBTIL" — couleurs d'origine préservées
// ============================================================
const PSX_FX = {
    toneMapping: false,
    pixelation: 1,
    colorBits: 8,
    grain: 0.025,
    scanlines: 0.05,
    vignette: 0.4,
    chroma: 0.0006,
    bloom: 0.3
};

const MIRROR_CAR = true;
let MIRROR_MODE = 'auto'; // touche M en jeu
const FLIP_CAR = true;
const CAR_UPSIDE_DOWN = false;

// ====== DIMENSIONS ======
const CAR_LENGTH = 4.4;
const WHEEL_RADIUS = 0.3;
const WHEEL_WIDTH = 0.4;
const SUSPENSION_REST = 0.8;
const WHEEL_TRACK_X = 0.8;
const WHEEL_BASE_Z = 1.3;

// ====== POIDS ======
const CAR_MASS = 900;
const REF_MASS = 12;
const MS = CAR_MASS / REF_MASS;

// ====== SUSPENSION ======
const SUSPENSION_STIFFNESS = 50;
const SUSPENSION_COMPRESSION = 4.0;
const SUSPENSION_RELAXATION = 2.0;
const SUSPENSION_MAX_TRAVEL = 0.4;

// ====== CONDUITE TYPE "NEED FOR SPEED" ======
const ENGINE_FORCE = 90;
const REVERSE_FORCE = 40;
const MAX_SPEED = 55;
const MAX_REVERSE_SPEED = 12;
const BRAKE_FORCE = 3;
const THROTTLE_SMOOTH = 3.5;
const BRAKE_SMOOTH = 4;
const STEER_MAX_LOW = 0.55;
const STEER_MAX_HIGH = 0.10;
const STEER_FADE_SPEED = 30;
const STEER_SMOOTH = 3;
const STEER_CENTER = 5;
const GRIP = 4;

// ====== CAMÉRA ORBITALE ======
let dragging = false, lastPX = 0, lastPY = 0;
let camYawOffset = 0, camPitch = 0.35, camDist = 10;

let currentEngine = 0;
let currentBrake = 0;
let currentSteer = 0;
const _fwd = new THREE.Vector3();

const EARTH_RADIUS = 6378137;
const CHUNK_SIZE = 500;                              // taille logique (pour la grille et les requêtes backend)
const WORLD_CHUNK_SIZE = CHUNK_SIZE * WORLD_SCALE;   // taille effective d'un chunk en espace 3D
const WORLD_CLIP_PADDING = 12 * WORLD_SCALE;         // marge de clip en coordonnées scalées
const RENDER_DISTANCE = 2;
let hasStarted = false;
let baseLat = 0;
let baseLon = 0;
const loadedChunks = new Map();
const chunksLoading = new Set();
const chunkQueue = [];

const keys = { up: false, down: false, left: false, right: false, brake: false };

// --- Utilitaires routes/chunks ---
function clampRoadWidth(width) {
    if (!Number.isFinite(width)) return 4;
    return Math.min(Math.max(width, 2.5), 16);
}

function getRoadWidth(tags) {
    let w;
    if (tags.width) w = clampRoadWidth(parseFloat(tags.width));
    else if (tags.lanes) w = clampRoadWidth(parseInt(tags.lanes, 10) * 3.5);
    else if (tags.highway === 'motorway' || tags.highway === 'trunk') w = 10;
    else if (tags.highway === 'primary' || tags.highway === 'secondary') w = 7;
    else w = 4;
    return w * WORLD_SCALE; // <<< routes plus larges
}

function isPointInChunk(point, padding = WORLD_CLIP_PADDING) {
    const limit = WORLD_CHUNK_SIZE / 2 + padding;
    return point.x >= -limit && point.x <= limit && point.z >= -limit && point.z <= limit;
}

function interpolatePoint(a, b, t) {
    return new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t
    );
}

function clipSegmentToChunk(a, b, padding = WORLD_CLIP_PADDING) {
    const limit = WORLD_CHUNK_SIZE / 2 + padding;
    const minX = -limit, maxX = limit, minZ = -limit, maxZ = limit;
    const dx = b.x - a.x, dz = b.z - a.z;
    let t0 = 0, t1 = 1;

    const clip = (p, q) => {
        if (p === 0) return q >= 0;
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
        return true;
    };

    if (clip(-dx, a.x - minX) && clip(dx, maxX - a.x) &&
        clip(-dz, a.z - minZ) && clip(dz, maxZ - a.z)) {
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
        if (!clipped) { if (current.length > 1) polylines.push(current); current = []; continue; }
        const startsInside = isPointInChunk(points[i]);
        if (!startsInside && current.length > 1) { polylines.push(current); current = []; }
        pushPointIfDistinct(current, clipped[0]);
        pushPointIfDistinct(current, clipped[1]);
    }
    if (current.length > 1) polylines.push(current);
    return polylines;
}

function polylineLength(points) {
    let L = 0;
    for (let i = 0; i < points.length - 1; i++) {
        L += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
    }
    return L;
}

function samplePolyline(points, s) {
    let acc = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        if (acc + l >= s || i === points.length - 2) {
            const t = THREE.MathUtils.clamp((s - acc) / Math.max(l, 1e-6), 0, 1);
            const p = new THREE.Vector3(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t);
            const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
            if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
            dir.normalize();
            return { p, dir };
        }
        acc += l;
    }
    return null;
}

function createRoadMesh(points, width, material) {
    if (points.length < 2) return null;
    const pos = [], indices = [];
    const roadY = 0.25 * WORLD_SCALE; // <<< hauteur des routes scalée
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
        left.y = roadY; right.y = roadY;
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

// --- Three.js ---
function initThree() {
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xE8B98A, 200 * WORLD_SCALE, 1200 * WORLD_SCALE);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000 * WORLD_SCALE);
    camera.position.set(0, 5, 12);

    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    scene.add(new THREE.AmbientLight(0x7B6FA8, 0.4));
    const dirLight = new THREE.DirectionalLight(0xFFB870, 1.5);
    dirLight.position.set(-50 * WORLD_SCALE, 80, -20 * WORLD_SCALE);
    scene.add(dirLight);

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const baseEffects = [
        new SMAAEffect(),
        new BloomEffect({
            intensity: PSX_FX.bloom,
            luminanceThreshold: 0.9,
            mipmapBlur: true,
            radius: 0.7
        })
    ];
    if (PSX_FX.toneMapping) {
        baseEffects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    }
    if (PSX_FX.vignette > 0) {
        baseEffects.push(new VignetteEffect({ offset: 0.28, darkness: PSX_FX.vignette }));
    }
    composer.addPass(new EffectPass(camera, ...baseEffects));

    if (PSX_FX.chroma > 0) {
        composer.addPass(new EffectPass(camera, new ChromaticAberrationEffect({
            offset: new THREE.Vector2(PSX_FX.chroma, PSX_FX.chroma),
            radialModulation: true,
            modulationOffset: 0.45
        })));
    }

    if (PSX_FX.pixelation > 1) {
        composer.addPass(new EffectPass(camera, new PixelationEffect(PSX_FX.pixelation)));
    }

    const overlayEffects = [];
    if (PSX_FX.grain > 0) {
        const noise = new NoiseEffect({ blendFunction: BlendFunction.ADD });
        noise.blendMode.opacity.value = PSX_FX.grain;
        overlayEffects.push(noise);
    }
    if (PSX_FX.scanlines > 0) {
        const scan = new ScanlineEffect({ density: 1.1 });
        scan.blendMode.opacity.value = PSX_FX.scanlines;
        overlayEffects.push(scan);
    }
    if (PSX_FX.colorBits < 8) {
        overlayEffects.push(new ColorDepthEffect({ bits: PSX_FX.colorBits }));
    }
    if (overlayEffects.length > 0) {
        composer.addPass(new EffectPass(camera, ...overlayEffects));
    }

    createSky();
    window.addEventListener('resize', onWindowResize);
}

function createSky() {
    const skyGeo = new THREE.SphereGeometry(1500 * WORLD_SCALE, 32, 15);
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

// --- Minimap ---
function initMinimap() {
    if (!window.L || !document.getElementById('minimap')) return;
    minimapContainer = document.getElementById('minimap-rotator');
    minimap = window.L.map('minimap', {
        zoomControl: false, attributionControl: false, dragging: false,
        scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
        keyboard: false, touchZoom: false
    }).setView([0, 0], 16);
    window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri'
    }).addTo(minimap);
    setTimeout(() => { minimap.invalidateSize(); }, 100);
}

// --- Chargement modèles ---
async function loadModel(url, fallbackUrl) {
    const doLoad = async (u) => {
        const ext = u.split('.').pop().split('?')[0].toLowerCase();
        if (ext === 'fbx') return await new FBXLoader().loadAsync(u);
        if (ext === 'obj') return await new OBJLoader().loadAsync(u);
        return (await new GLTFLoader().loadAsync(u)).scene;
    };
    try {
        return await doLoad(url);
    } catch (e) {
        if (fallbackUrl) {
            console.warn('Modèle introuvable : ' + url + ' → fallback en ligne.', e);
            try { return await doLoad(fallbackUrl); } catch (e2) { return null; }
        }
        return null;
    }
}

// --- Route PSX : mesure + fusion + scale par WORLD_SCALE ---
async function loadRoadTemplate() {
    try {
        const gltf = await new GLTFLoader().loadAsync(ROAD_MODEL_URL);
        const root = gltf.scene;
        root.updateWorldMatrix(true, true);
        let box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const lenAxis = size.z >= size.x ? 'z' : 'x';
        const segLenRaw = Math.max(lenAxis === 'z' ? size.z : size.x, 0.5);
        const segWidthRaw = Math.max(lenAxis === 'z' ? size.x : size.z, 0.5);

        const holder = new THREE.Group();
        if (lenAxis === 'x') root.rotation.y = Math.PI / 2;
        holder.add(root);

        holder.updateWorldMatrix(true, true);
        box = new THREE.Box3().setFromObject(holder);
        const center = box.getCenter(new THREE.Vector3());
        root.position.x -= center.x;
        root.position.z -= center.z;
        root.position.y -= box.min.y;
        holder.updateWorldMatrix(true, true);

        const geos = [];
        const mats = [];
        holder.traverse(o => {
            if (o.isMesh) {
                const g = o.geometry.clone();
                g.applyMatrix4(o.matrixWorld);
                geos.push(g);
                mats.push(o.material);
            }
        });
        if (geos.length === 0) throw new Error('aucun mesh dans le modèle de route');

        const mergeFn = BufferGeometryUtils.mergeGeometries || BufferGeometryUtils.mergeBufferGeometries;
        let merged = null;
        if (geos.length === 1) merged = geos[0];
        else if (mergeFn) { try { merged = mergeFn(geos, true); } catch (e) { merged = null; } }
        if (!merged) { merged = geos[0]; mats.length = 1; }

        // <<< Scale la géométrie pour qu'elle couvre bien la distance entre instances
        merged.scale(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);

        roadGeo = merged;
        roadMats = mats;
        // segLen et segWidth reflètent la taille EFFECTIVE en coordonnées 3D
        roadInfo = { segLen: segLenRaw * WORLD_SCALE, segWidth: segWidthRaw * WORLD_SCALE };

        console.log('Route PSX prête (instanciée) : segment', roadInfo.segLen.toFixed(1), 'm x', roadInfo.segWidth.toFixed(1), 'm (WORLD_SCALE=' + WORLD_SCALE + ')');
    } catch (e) {
        console.warn('Modèle de route introuvable (' + ROAD_MODEL_URL + ') → routes en ruban.', e);
        roadInfo = null;
        roadGeo = null;
        roadMats = [];
    }
}

// --- Herbe PSX ---
async function makeGrassTexture() {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    for (const url of GRASS_URLS) {
        try {
            const tex = await loader.loadAsync(url);
            const c = document.createElement('canvas');
            c.width = 64; c.height = 64;
            const ctx = c.getContext('2d');
            ctx.drawImage(tex.image, 0, 0, 64, 64);
            const t = new THREE.CanvasTexture(c);
            t.magFilter = THREE.NearestFilter;
            t.minFilter = THREE.NearestFilter;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            // Même nombre de tuiles, mais réparties sur WORLD_CHUNK_SIZE
            // → tuiles 2× plus grandes visuellement (cohérent avec l'agrandissement)
            t.repeat.set(CHUNK_SIZE / GRASS_TILE_SIZE, CHUNK_SIZE / GRASS_TILE_SIZE);
            if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
            console.log('Herbe PSX chargée :', url);
            return t;
        } catch (e) {
            console.warn('Échec texture herbe :', url);
        }
    }

    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const shades = ['#5a7a3a', '#618243', '#557336', '#6a8c4a', '#4e6a30', '#527034'];
    for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
            ctx.fillStyle = shades[(Math.random() * shades.length) | 0];
            ctx.fillRect(x, y, 1, 1);
        }
    }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(CHUNK_SIZE / GRASS_TILE_SIZE, CHUNK_SIZE / GRASS_TILE_SIZE);
    console.log('Herbe PSX procédurale générée.');
    return t;
}

// --- Physique + véhicule ---
async function initPhysics() {
    await RAPIER.init();
    physicsWorld = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });

    // Sol suffisamment grand pour le monde agrandi
    const groundHalfSize = 10000 * WORLD_SCALE;
    physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(groundHalfSize, 0.1, groundHalfSize));

    const chassisDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 2.0, 0)
        .setLinearDamping(0.05)
        .setAngularDamping(1.0);
    chassisBody = physicsWorld.createRigidBody(chassisDesc);

    physicsWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(0.85, 0.5, CAR_LENGTH / 2 * 0.95)
            .setMass(CAR_MASS)
            .setFriction(0.5),
        chassisBody
    );

    vehicleController = physicsWorld.createVehicleController(chassisBody);

    const wheelPositions = [
        { x: -WHEEL_TRACK_X, y: 0, z: -WHEEL_BASE_Z },
        { x: WHEEL_TRACK_X, y: 0, z: -WHEEL_BASE_Z },
        { x: -WHEEL_TRACK_X, y: 0, z: WHEEL_BASE_Z },
        { x: WHEEL_TRACK_X, y: 0, z: WHEEL_BASE_Z }
    ];
    wheelPositions.forEach(pos => {
        vehicleController.addWheel(pos, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION_REST, WHEEL_RADIUS);
        const idx = vehicleController.numWheels() - 1;
        vehicleController.setWheelSuspensionStiffness(idx, SUSPENSION_STIFFNESS * MS);
        vehicleController.setWheelSuspensionCompression(idx, SUSPENSION_COMPRESSION * MS);
        vehicleController.setWheelSuspensionRelaxation(idx, SUSPENSION_RELAXATION * MS);
        vehicleController.setWheelMaxSuspensionTravel(idx, SUSPENSION_MAX_TRAVEL);
        vehicleController.setWheelFrictionSlip(idx, GRIP * MS);
    });

    masterRoot = await loadModel(CAR_MODEL_URL, CAR_FALLBACK_URL);
    masterWheel = await loadModel(CAR_WHEEL_URL, null);

    if (masterRoot) {
        dedupeCoincident(masterRoot);
        masterRoot.traverse(o => {
            if (o.isMesh && o.material) {
                if (Array.isArray(o.material)) o.material.forEach(m => m.side = THREE.DoubleSide);
                else o.material.side = THREE.DoubleSide;
            }
        });
    }

    buildCarVisual();
}

// --- Supprime les copies superposées ---
function dedupeCoincident(root) {
    const seen = [];
    const maxDim = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).length();
    const eps = Math.max(maxDim * 0.001, 1e-4);

    for (const child of [...root.children]) {
        let hasMesh = false;
        child.traverse(o => { if (o.isMesh) hasMesh = true; });
        if (!hasMesh) continue;

        const b = new THREE.Box3().setFromObject(child);
        const c = b.getCenter(new THREE.Vector3());
        const s = b.getSize(new THREE.Vector3());

        const dup = seen.find(e =>
            Math.abs(e.c.x - c.x) < eps && Math.abs(e.c.y - c.y) < eps && Math.abs(e.c.z - c.z) < eps &&
            Math.abs(e.s.x - s.x) < eps && Math.abs(e.s.y - s.y) < eps && Math.abs(e.s.z - s.z) < eps);

        if (dup) {
            console.warn('Doublon superposé détecté et supprimé :', child.name || child.uuid);
            root.remove(child);
        } else {
            seen.push({ c, s });
        }
    }
}

// --- Détection du plan de symétrie ---
function detectSeam(object, axis, box) {
    const size = box.getSize(new THREE.Vector3());
    const eps = Math.max(size[axis] * 0.02, 1e-4);
    const stats = {
        min: { bound: 0, plane: 0, ymin: Infinity, ymax: -Infinity },
        max: { bound: 0, plane: 0, ymin: Infinity, ymax: -Infinity }
    };
    const v = new THREE.Vector3();

    const record = (side, isBound, y) => {
        const s = stats[side];
        if (isBound) s.bound++; else s.plane++;
        if (y < s.ymin) s.ymin = y;
        if (y > s.ymax) s.ymax = y;
    };

    object.traverse(o => {
        if (!o.isMesh || !o.geometry) return;
        const geo = o.geometry;
        const posAttr = geo.attributes.position;
        if (!posAttr) return;
        o.updateWorldMatrix(true, false);

        for (let i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
            if (Math.abs(v[axis] - box.min[axis]) < eps) record('min', false, v.y);
            else if (Math.abs(v[axis] - box.max[axis]) < eps) record('max', false, v.y);
        }

        const edgeCount = new Map();
        const addEdge = (a, b) => {
            const k = a < b ? a * 100000 + b : b * 100000 + a;
            edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
        };
        const idx = geo.index;
        if (idx) {
            for (let i = 0; i < idx.count; i += 3) {
                const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
                addEdge(a, b); addEdge(b, c); addEdge(c, a);
            }
        } else {
            for (let i = 0; i < posAttr.count; i += 3) {
                addEdge(i, i + 1); addEdge(i + 1, i + 2); addEdge(i + 2, i);
            }
        }
        const boundary = new Set();
        edgeCount.forEach((c, k) => {
            if (c === 1) {
                boundary.add(Math.floor(k / 100000));
                boundary.add(k % 100000);
            }
        });
        boundary.forEach(vi => {
            v.fromBufferAttribute(posAttr, vi).applyMatrix4(o.matrixWorld);
            if (Math.abs(v[axis] - box.min[axis]) < eps) record('min', true, v.y);
            else if (Math.abs(v[axis] - box.max[axis]) < eps) record('max', true, v.y);
        });
    });

    const span = s => (s.ymax > s.ymin ? s.ymax - s.ymin : 0);
    if (stats.min.bound + stats.max.bound > 0) {
        return span(stats.min) >= span(stats.max) ? box.min[axis] : box.max[axis];
    }
    if (stats.min.plane + stats.max.plane > 0) {
        return span(stats.min) >= span(stats.max) ? box.min[axis] : box.max[axis];
    }
    return box.max[axis];
}

// --- Inverse le sens des triangles ---
function flipWinding(geo) {
    if (geo.index) {
        const arr = geo.index.array;
        for (let i = 0; i < arr.length; i += 3) {
            const t = arr[i + 1];
            arr[i + 1] = arr[i + 2];
            arr[i + 2] = t;
        }
        geo.index.needsUpdate = true;
    } else {
        for (const name in geo.attributes) {
            const attr = geo.attributes[name];
            const arr = attr.array;
            const n = attr.itemSize;
            for (let i = 0; i < arr.length; i += n * 3) {
                for (let c = 0; c < n; c++) {
                    const t = arr[i + n + c];
                    arr[i + n + c] = arr[i + 2 * n + c];
                    arr[i + 2 * n + c] = t;
                }
            }
            attr.needsUpdate = true;
        }
    }
}

// --- Copie de wheel.glb ---
function prepareWheelClone(wheelRoot) {
    const w = wheelRoot.clone(true);

    let box = new THREE.Box3().setFromObject(w);
    let size = box.getSize(new THREE.Vector3());
    if (size.y <= size.x && size.y <= size.z) w.rotation.z = Math.PI / 2;
    else if (size.z <= size.x && size.z <= size.y) w.rotation.y = Math.PI / 2;

    w.updateWorldMatrix(true, true);
    box = new THREE.Box3().setFromObject(w);
    size = box.getSize(new THREE.Vector3());
    const s = (WHEEL_RADIUS * 2) / Math.max(size.y, size.z, 0.001);
    w.scale.multiplyScalar(s);

    w.updateWorldMatrix(true, true);
    box = new THREE.Box3().setFromObject(w);
    const c = box.getCenter(new THREE.Vector3());
    w.position.sub(c);
    return w;
}

// --- Construction du visuel voiture ---
function buildCarVisual() {
    carGroup = new THREE.Group();
    scene.add(carGroup);
    wheelsVis = [];

    let bodyOk = false;

    if (masterRoot) {
        masterRoot.updateWorldMatrix(true, true);

        const allMeshes = [];
        masterRoot.traverse(o => { if (o.isMesh) allMeshes.push(o); });
        const wheelMeshes = allMeshes.filter(m => /wheel|tire|tyre|roue/i.test(m.name));
        const hasOwnWheels = wheelMeshes.length >= 4;
        const bodyMeshes = hasOwnWheels ? allMeshes.filter(m => !wheelMeshes.includes(m)) : allMeshes;

        const box0 = new THREE.Box3().setFromObject(masterRoot);
        const size0 = box0.getSize(new THREE.Vector3());
        const widthAxis = size0.x > size0.z ? 'z' : 'x';
        const a = box0.min[widthAxis], b = box0.max[widthAxis];

        let seam;
        if (MIRROR_MODE === 'min') seam = a;
        else if (MIRROR_MODE === 'max') seam = b;
        else seam = detectSeam(masterRoot, widthAxis, box0);

        if (MIRROR_CAR) {
            const m0 = 2 * seam - b, m1 = 2 * seam - a;
            const overlap = Math.min(b, m1) - Math.max(a, m0);
            if (overlap > (b - a) * 0.5) {
                seam = (seam === a) ? b : a;
                console.warn('Miroir superposé détecté → bascule sur l\'autre bord.');
            }
        }

        const mirrorPlane = new THREE.Matrix4();
        if (MIRROR_CAR) {
            const T1 = new THREE.Matrix4(), S = new THREE.Matrix4(), T2 = new THREE.Matrix4();
            if (widthAxis === 'x') {
                T1.makeTranslation(seam, 0, 0); S.makeScale(-1, 1, 1); T2.makeTranslation(-seam, 0, 0);
            } else {
                T1.makeTranslation(0, 0, seam); S.makeScale(1, 1, -1); T2.makeTranslation(0, 0, -seam);
            }
            mirrorPlane.multiplyMatrices(T1, S).multiply(T2);
        }

        const body = new THREE.Group();
        let bakedCount = 0;
        bodyMeshes.forEach(m => {
            const gA = m.geometry.clone();
            gA.applyMatrix4(m.matrixWorld);
            body.add(new THREE.Mesh(gA, m.material));
            bakedCount++;

            if (MIRROR_CAR) {
                const gB = m.geometry.clone();
                gB.applyMatrix4(new THREE.Matrix4().multiplyMatrices(mirrorPlane, m.matrixWorld));
                flipWinding(gB);
                body.add(new THREE.Mesh(gB, m.material));
                bakedCount++;
            }
        });

        console.log(`Voiture construite : ${bakedCount} meshes cuits | mode=${MIRROR_MODE} | masse=${CAR_MASS}kg`);

        const flip = new THREE.Group();
        flip.add(body);
        if (CAR_UPSIDE_DOWN) flip.rotation.z = Math.PI;

        const orient = new THREE.Group();
        orient.add(flip);

        flip.updateWorldMatrix(true, true);
        let box = new THREE.Box3().setFromObject(flip);
        let size = box.getSize(new THREE.Vector3());
        if (size.x > size.z) orient.rotation.y = Math.PI / 2;
        if (FLIP_CAR) orient.rotation.y += Math.PI;

        orient.updateWorldMatrix(true, true);
        box = new THREE.Box3().setFromObject(orient);
        size = box.getSize(new THREE.Vector3());
        orient.scale.setScalar(CAR_LENGTH / Math.max(size.z, 0.001));

        orient.updateWorldMatrix(true, true);
        box = new THREE.Box3().setFromObject(orient);
        const center = box.getCenter(new THREE.Vector3());
        orient.position.x -= center.x;
        orient.position.z -= center.z;
        orient.position.y += (-1.05 - box.min.y);

        carGroup.add(orient);
        carGroup.updateWorldMatrix(true, true);
        bodyOk = true;

        if (hasOwnWheels) {
            wheelMeshes.sort((m1, m2) => {
                const ca = new THREE.Vector3(), cb = new THREE.Vector3();
                new THREE.Box3().setFromObject(m1).getCenter(ca);
                new THREE.Box3().setFromObject(m2).getCenter(cb);
                if (Math.sign(ca.z) !== Math.sign(cb.z)) return ca.z - cb.z;
                return ca.x - cb.x;
            });
            for (let i = 0; i < 4; i++) {
                const c = new THREE.Vector3();
                new THREE.Box3().setFromObject(wheelMeshes[i]).getCenter(c);
                c.applyMatrix4(orient.matrixWorld);
                const pivot = new THREE.Group();
                pivot.position.set(c.x, 0, c.z);
                carGroup.add(pivot);

                const g = wheelMeshes[i].geometry.clone();
                g.applyMatrix4(wheelMeshes[i].matrixWorld);
                const wm = new THREE.Mesh(g, wheelMeshes[i].material);
                const rel = new THREE.Vector3();
                new THREE.Box3().setFromObject(wheelMeshes[i]).getCenter(rel);
                rel.applyMatrix4(orient.matrixWorld);
                wm.position.set(-rel.x + c.x, -rel.y, -rel.z + c.z);
                pivot.add(wm);

                wheelsVis.push({ node: pivot, baseX: c.x, baseZ: c.z, designY: 0, rest0: null });
            }
        }
    }

    if (!bodyOk) {
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(2, 1, 4),
            new THREE.MeshStandardMaterial({ color: 0xF2A65A })
        );
        carGroup.add(body);
    }

    if (wheelsVis.length === 0) {
        const corners = [
            { x: -WHEEL_TRACK_X, z: -WHEEL_BASE_Z }, { x: WHEEL_TRACK_X, z: -WHEEL_BASE_Z },
            { x: -WHEEL_TRACK_X, z: WHEEL_BASE_Z }, { x: WHEEL_TRACK_X, z: WHEEL_BASE_Z }
        ];
        if (masterWheel) {
            corners.forEach(p => {
                const pivot = new THREE.Group();
                pivot.position.set(p.x, -SUSPENSION_REST, p.z);
                pivot.add(prepareWheelClone(masterWheel));
                carGroup.add(pivot);
                wheelsVis.push({ node: pivot, baseX: p.x, baseZ: p.z, designY: -SUSPENSION_REST, rest0: null });
            });
        } else {
            const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 16);
            wheelGeo.rotateZ(Math.PI / 2);
            const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
            corners.forEach(p => {
                const w = new THREE.Mesh(wheelGeo, wheelMat);
                w.position.set(p.x, -SUSPENSION_REST, p.z);
                carGroup.add(w);
                wheelsVis.push({ node: w, baseX: p.x, baseZ: p.z, designY: -SUSPENSION_REST, rest0: null });
            });
        }
    }
}

function rebuildCar() {
    if (carGroup) scene.remove(carGroup);
    wheelsVis = [];
    buildCarVisual();
}

// --- Conversions GPS <-> 3D (nord = -Z, scalées par WORLD_SCALE) ---
function latLonToVector3(lat, lon) {
    const x = (lon - baseLon) * (Math.PI / 180) * EARTH_RADIUS * Math.cos(baseLat * Math.PI / 180);
    const z = -(lat - baseLat) * (Math.PI / 180) * EARTH_RADIUS;
    return new THREE.Vector3(x * WORLD_SCALE, 0, z * WORLD_SCALE);
}

function vector3ToLatLon(x, z) {
    // Inverse : on divise par WORLD_SCALE pour retrouver les vraies coordonnées GPS
    const lat = baseLat + (-(z / WORLD_SCALE) / EARTH_RADIUS) * (180 / Math.PI);
    const lon = baseLon + ((x / WORLD_SCALE) / (EARTH_RADIUS * Math.cos(baseLat * Math.PI / 180))) * (180 / Math.PI);
    return { lat, lon };
}

// --- Collecte des transforms de segments ---
function collectRoadInstances(polyline, width, out) {
    const step = roadInfo.segLen * 0.95;
    const total = polylineLength(polyline);
    const scaleX = THREE.MathUtils.clamp(width / roadInfo.segWidth, 0.7, 1.8);

    for (let s = step / 2; s < total; s += step) {
        const sample = samplePolyline(polyline, s);
        if (!sample) continue;
        out.push({
            x: sample.p.x,
            z: sample.p.z,
            yaw: Math.atan2(sample.dir.x, sample.dir.z),
            scaleX
        });
    }
}

// --- Chunks ---
function updateChunks() {
    if (!hasStarted) return;

    const carPos = chassisBody ? chassisBody.translation() : { x: 0, z: 0 };
    // Grille en coordonnées 3D scalées
    const camX = Math.floor(carPos.x / WORLD_CHUNK_SIZE);
    const camZ = Math.floor(carPos.z / WORLD_CHUNK_SIZE);

    for (const [key, chunk] of loadedChunks) {
        const dx = Math.abs(chunk.gridX - camX);
        const dz = Math.abs(chunk.gridZ - camZ);
        if (dx > RENDER_DISTANCE + 1 || dz > RENDER_DISTANCE + 1) {
            scene.remove(chunk.group);
            chunk.group.traverse(obj => {
                if (obj.isInstancedMesh) {
                    obj.dispose();
                } else if (obj.geometry && !obj.userData.shared) {
                    obj.geometry.dispose();
                }
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

    // Position 3D du centre du chunk (scalée)
    const worldX = gridX * WORLD_CHUNK_SIZE;
    const worldZ = gridZ * WORLD_CHUNK_SIZE;
    // vector3ToLatLon divise par WORLD_SCALE → retrouve la vraie position GPS
    const center = vector3ToLatLon(worldX, worldZ);

    try {
        // On demande toujours size=CHUNK_SIZE au backend (en mètres réels)
        const response = await fetch(`http://localhost:3001/api/chunk?lat=${center.lat}&lon=${center.lon}&size=${CHUNK_SIZE}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);

        const group = new THREE.Group();
        group.position.set(worldX, 0, worldZ);
        const offsetVec = latLonToVector3(center.lat, center.lon);

        // Terrain : couvre WORLD_CHUNK_SIZE en 3D
        const terrainGeo = new THREE.PlaneGeometry(WORLD_CHUNK_SIZE, WORLD_CHUNK_SIZE, 1, 1);
        terrainGeo.rotateX(-Math.PI / 2);
        const terrainMat = grassTexture
            ? new THREE.MeshStandardMaterial({ map: grassTexture })
            : new THREE.MeshStandardMaterial({ color: 0x7A8C4E });
        group.add(new THREE.Mesh(terrainGeo, terrainMat));

        const roadMat = new THREE.MeshStandardMaterial({
            color: 0x2C2C34, roughness: 0.8,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
        });

        const instances = [];
        data.roads.forEach(r => {
            if (r.geometry.length < 2) return;
            // Les points GPS sont convertis en coordonnées 3D scalées
            const points3D = r.geometry.map(p => {
                const v = latLonToVector3(p.lat, p.lon);
                v.y = 0;
                return v;
            });
            // Passage en coordonnées locales du chunk (toujours scalées, donc cohérentes)
            const localPts = points3D.map(p => new THREE.Vector3(p.x - offsetVec.x, p.y, p.z - offsetVec.z));
            // getRoadWidth retourne déjà ×WORLD_SCALE
            const width = getRoadWidth(r.tags);

            splitRoadIntoChunkPolylines(localPts).forEach(polyline => {
                if (roadInfo && roadGeo) {
                    collectRoadInstances(polyline, width, instances);
                } else {
                    const mesh = createRoadMesh(polyline, width, roadMat);
                    if (mesh) group.add(mesh);
                }
            });
        });

        if (instances.length > 0) {
            const mat = roadMats.length === 1 ? roadMats[0] : roadMats;
            const im = new THREE.InstancedMesh(roadGeo, mat, instances.length);
            const M = new THREE.Matrix4();
            const Q = new THREE.Quaternion();
            const P = new THREE.Vector3();
            const S = new THREE.Vector3();
            const UP = new THREE.Vector3(0, 1, 0);

            // Hauteur des routes scalée pour rester au-dessus du terrain
            const roadY = 0.15 * WORLD_SCALE;

            instances.forEach((inst, i) => {
                Q.setFromAxisAngle(UP, inst.yaw);
                P.set(inst.x, roadY, inst.z);
                S.set(inst.scaleX, 1, 1);
                M.compose(P, Q, S);
                im.setMatrixAt(i, M);
            });
            im.instanceMatrix.needsUpdate = true;
            im.frustumCulled = false;
            group.add(im);
        }

        scene.add(group);
        loadedChunks.set(key, { gridX, gridZ, group });
    } catch (error) {
        console.error("Erreur chunk", key, error);
        if (!chunkQueue.some(c => c.key === key)) chunkQueue.push(chunkInfo);
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
            if (minimap) minimap.setView([baseLat, baseLon], 16, { animate: false });
            updateChunks();
        } else {
            alert("Adresse introuvable.");
        }
    } catch (error) {
        alert("Erreur de connexion au backend.");
    }
}

// --- Contrôles ---
function setupControls() {
    window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.up = true;
        if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.down = true;
        if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = true;
        if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = true;
        if (e.code === 'Space') keys.brake = true;

        if (e.code === 'KeyM' && masterRoot) {
            const isInput = document.activeElement && document.activeElement.tagName === 'INPUT';
            if (!isInput) {
                MIRROR_MODE = MIRROR_MODE === 'auto' ? 'min' : (MIRROR_MODE === 'min' ? 'max' : 'auto');
                console.log('Mode miroir :', MIRROR_MODE);
                rebuildCar();
            }
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.up = false;
        if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.down = false;
        if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
        if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
        if (e.code === 'Space') keys.brake = false;
    });

    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastPX = e.clientX; lastPY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastPX;
        const dy = e.clientY - lastPY;
        lastPX = e.clientX; lastPY = e.clientY;
        camYawOffset -= dx * 0.005;
        camPitch = THREE.MathUtils.clamp(camPitch + dy * 0.005, 0.05, 1.3);
    });
    window.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('wheel', (e) => {
        camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.01, 5, 25 * WORLD_SCALE);
    }, { passive: true });

    document.getElementById('search-btn').addEventListener('click', searchAddress);
    document.getElementById('address-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchAddress();
    });
}

// --- Conduite type Need for Speed ---
function updateCarControl(dt) {
    const vel = chassisBody.linvel();
    _fwd.set(0, 0, -1).applyQuaternion(carGroup.quaternion);
    const speed = vel.x * _fwd.x + vel.y * _fwd.y + vel.z * _fwd.z;
    const absSpeed = Math.abs(speed);

    let targetEngine = 0;
    if (keys.up) {
        targetEngine = -ENGINE_FORCE * Math.max(0, 1 - Math.max(speed, 0) / MAX_SPEED);
    } else if (keys.down) {
        targetEngine = REVERSE_FORCE * Math.max(0, 1 - Math.max(-speed, 0) / MAX_REVERSE_SPEED);
    }
    currentEngine = THREE.MathUtils.damp(currentEngine, targetEngine, THROTTLE_SMOOTH, dt);

    const targetBrake = keys.brake ? BRAKE_FORCE : 0;
    currentBrake = THREE.MathUtils.damp(currentBrake, targetBrake, BRAKE_SMOOTH, dt);

    const speedFactor = THREE.MathUtils.clamp(absSpeed / STEER_FADE_SPEED, 0, 1);
    const maxSteer = THREE.MathUtils.lerp(STEER_MAX_LOW, STEER_MAX_HIGH, speedFactor);
    let targetSteer = 0;
    if (keys.left) targetSteer = maxSteer;
    else if (keys.right) targetSteer = -maxSteer;
    const lambda = targetSteer !== 0 ? STEER_SMOOTH : STEER_CENTER;
    currentSteer = THREE.MathUtils.damp(currentSteer, targetSteer, lambda, dt);

    for (let i = 0; i < 4; i++) {
        vehicleController.setWheelEngineForce(i, i >= 2 ? currentEngine * MS : 0);
        vehicleController.setWheelBrake(i, currentBrake * MS);
    }
    vehicleController.setWheelSteering(0, currentSteer);
    vehicleController.setWheelSteering(1, currentSteer);
}

// --- Sync roues ---
const _steerQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

function updateWheelsVisual() {
    for (let i = 0; i < 4; i++) {
        const w = wheelsVis[i];
        if (!w) continue;

        const suspension = vehicleController.wheelSuspensionLength(i) || 0;
        const steering = vehicleController.wheelSteering(i) || 0;
        const rotationRad = vehicleController.wheelRotation(i) || 0;
        const axleCs = vehicleController.wheelAxleCs(i);

        if (w.rest0 === null && suspension > 0.01) w.rest0 = suspension;
        const rest0 = w.rest0 !== null ? w.rest0 : SUSPENSION_REST;

        w.node.position.x = w.baseX;
        w.node.position.z = w.baseZ;
        w.node.position.y = w.designY + (rest0 - suspension);

        _steerQuat.setFromAxisAngle(_up, steering);
        _rollQuat.setFromAxisAngle(new THREE.Vector3(axleCs.x, axleCs.y, axleCs.z), rotationRad);
        w.node.quaternion.multiplyQuaternions(_steerQuat, _rollQuat);
    }
}

// --- Caméra orbitale ---
const _behind = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _camOffset = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);

function updateVehicleAndCamera() {
    if (!vehicleController || !chassisBody || !carGroup) return;

    const dt = 1 / 60;
    updateCarControl(dt);
    vehicleController.updateVehicle(dt);

    const pos = chassisBody.translation();
    const rot = chassisBody.rotation();
    carGroup.position.set(pos.x, pos.y, pos.z);
    carGroup.quaternion.set(rot.x, rot.y, rot.z, rot.w);

    updateWheelsVisual();

    _behind.set(0, 0, 1).applyQuaternion(carGroup.quaternion);
    _behind.y = 0;
    if (_behind.lengthSq() < 0.0001) _behind.set(0, 0, 1);
    _behind.normalize();
    _behind.applyAxisAngle(_Y, camYawOffset);

    _camTarget.copy(carGroup.position);
    _camTarget.y += 1.0;

    _camOffset.copy(_behind).multiplyScalar(Math.cos(camPitch) * camDist);
    _camOffset.y = Math.sin(camPitch) * camDist;

    camera.position.lerp(_camTarget.clone().add(_camOffset), 0.25);
    camera.lookAt(_camTarget);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    if (physicsWorld) physicsWorld.step();
    updateVehicleAndCamera();
    if (sky) sky.position.copy(camera.position);
    updateChunks();

    if (minimap && hasStarted && minimapContainer && chassisBody) {
        const pos = chassisBody.translation();
        // vector3ToLatLon divise par WORLD_SCALE → vraie position GPS
        const { lat, lon } = vector3ToLatLon(pos.x, pos.z);
        minimap.setView([lat, lon], minimap.getZoom(), { animate: false });

        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(carGroup.quaternion);
        const headingDeg = Math.atan2(forward.x, -forward.z) * (180 / Math.PI);
        minimapContainer.style.transform = `translate(-50%, -50%) rotate(${-headingDeg}deg)`;
    }

    composer.render();
}

async function main() {
    initThree();
    initMinimap();

    grassTexture = await makeGrassTexture();
    await loadRoadTemplate();

    await initPhysics();
    setupControls();
    animate();
}

main();