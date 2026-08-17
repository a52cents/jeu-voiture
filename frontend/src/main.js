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
import { initStartMap, openStartMap } from './startmap.js';
import { initRace } from './race.js';
import { initEngineAudio, updateEngineAudio } from './engine.js';
import { initSettings, getEngineVolume, setEngineVolume } from './settings.js';
import { initAmbiance, setAmbiance } from './ambiance.js';

let scene, camera, renderer, composer;
let physicsWorld;
let sky;
let minimap;
let minimapContainer;
let dirLight = null;

let vehicleController;
let chassisBody;
let carGroup;
let wheelsVis = [];
let masterRoot = null;
let masterWheel = null;

let roadInfo = null;
let roadGeo = null;
let roadMats = [];
let grassTexture = null;

let rearMatShared = null;
let headMatShared = null;
let dashTex = null, dashMat = null, whiteMat = null;

let ambientLight = null, skyMatRef = null;
let lampHeadMats = [], lampGlowMats = [];
let bloomEffectRef = null;

let minimapCarArrow = null;

const CAR_MODEL_URL = '/models/car_01.glb';
const CAR_WHEEL_URL = '/models/wheel.glb';
const CAR_FALLBACK_URL = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMilkTruck/glTF-Binary/CesiumMilkTruck.glb';
const ROAD_MODEL_URL = '/models/psx_road.glb';

const GRASS_URLS = [
    '/src/grass.jpg',
    'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/terrain/grasslight-big.jpg'
];
const GRASS_TILE_SIZE = 4;

const WORLD_SCALE = 2;
const ROAD_STYLE = 'hop';

const STREETLIGHT_ENABLED = true;
const STREETLIGHT_SPACING = 60;
const STREETLIGHT_MIN_WIDTH = 14;
const HEADLIGHT_INTENSITY = 200;

// Relief fractal : grille fine + value noise multi-octaves + zones montagneuses
const TERRAIN_SEG = 256;
const TERRAIN_AMP = 4.0;          // base : collines de ~4m
const TERRAIN_MOUNTAIN_AMP = 20.0; // zones montagneuses jusqu'à ~20m
const TERRAIN_MASK_S = 2048;

const PSX_FX = {
    toneMapping: false, pixelation: 1, colorBits: 8,
    grain: 0.025, scanlines: 0.05, vignette: 0.4,
    chroma: 0.0006, bloom: 0.3
};

const MIRROR_CAR = true;
let MIRROR_MODE = 'auto';
const FLIP_CAR = true;
const CAR_UPSIDE_DOWN = false;

const CAR_LENGTH = 4.8;
const WHEEL_RADIUS = 0.33;
const WHEEL_WIDTH = 0.42;
const SUSPENSION_REST = 0.6;
const WHEEL_TRACK_X = 0.95;
const WHEEL_BASE_Z = 1.4;

const CAR_MASS = 900;
const REF_MASS = 12;
const MS = CAR_MASS / REF_MASS;

const SUSPENSION_STIFFNESS = 45;
const SUSPENSION_COMPRESSION = 0.83;
const SUSPENSION_RELAXATION = 0.88;
const SUSPENSION_MAX_TRAVEL = 0.3;

const ENGINE_FORCE = 55;
const REVERSE_FORCE = 30;
const MAX_SPEED = 50;
const MAX_REVERSE_SPEED = 10;
const BRAKE_FORCE = 8;
const THROTTLE_SMOOTH = 2.5;
const BRAKE_SMOOTH = 2.5;
const STEER_MAX_LOW = 0.38;
const STEER_MAX_HIGH = 0.07;
const STEER_FADE_SPEED = 20;
const STEER_SMOOTH = 2.2;
const STEER_CENTER = 4;
const GRIP = 2.2;

let dragging = false, lastPX = 0, lastPY = 0;
let camYawOffset = 0, camPitch = 0.35, camDist = 10;

let currentEngine = 0;
let currentBrake = 0;
let currentSteer = 0;
const _fwd = new THREE.Vector3();

const EARTH_RADIUS = 6378137;
const CHUNK_SIZE = 1000;
const WORLD_CHUNK_SIZE = CHUNK_SIZE * WORLD_SCALE;
const WORLD_CLIP_PADDING = 12 * WORLD_SCALE;
const RENDER_DISTANCE = 1;
const ROAD_CANVAS_SIZE = 2048;
let hasStarted = false;
let baseLat = 0;
let baseLon = 0;
const loadedChunks = new Map();
const chunksLoading = new Set();
const chunkQueue = [];

const keys = { up: false, down: false, left: false, right: false, brake: false };

let lampPostGeo = null, lampHeadGeo = null, lampPoolGeo = null, glowTexture = null;

const DEFAULT_CAR_CONFIG = {
    bodyY: 0.236, bodyScale: 1.04, bodyRotY: 0,
    wheelY: 0, wheelTrack: 0, wheelBase: 0, wheelScale: 1.06,
    lightX: 0.65, lightY: -0.2, lightFrontZ: -2.1, lightRearZ: 2.3,
};
let CAR_CONFIG = { ...DEFAULT_CAR_CONFIG };
try { Object.assign(CAR_CONFIG, JSON.parse(localStorage.getItem('psx_car_config') || '{}')); } catch (e) {}

const EDITOR_PARAMS = [
    { key: 'bodyY', label: 'Caisse haut/bas', step: 0.05 },
    { key: 'bodyScale', label: 'Caisse taille', step: 0.02 },
    { key: 'bodyRotY', label: 'Caisse rotation', step: 0.02 },
    { key: 'wheelY', label: 'Roues haut/bas', step: 0.05 },
    { key: 'wheelTrack', label: 'Roues ecart X', step: 0.05 },
    { key: 'wheelBase', label: 'Roues ecart Z', step: 0.05 },
    { key: 'wheelScale', label: 'Roues taille', step: 0.02 },
    { key: 'lightX', label: 'Phares ecart X', step: 0.05 },
    { key: 'lightY', label: 'Phares hauteur', step: 0.05 },
    { key: 'lightFrontZ', label: 'Phares avant Z', step: 0.1 },
    { key: 'lightRearZ', label: 'Feux arriere Z', step: 0.1 },
];
let editorActive = false, editorSel = 0, editorHUD = null, editorMsg = '';

function initEditorHUD() {
    editorHUD = document.createElement('div');
    editorHUD.style.cssText = 'position:fixed;top:10px;right:10px;z-index:9999;background:rgba(20,15,10,.88);color:#ffd9a0;font:12px monospace;padding:10px 12px;border:1px solid #f2a65a;border-radius:6px;white-space:pre;display:none;';
    document.body.appendChild(editorHUD);
}
function renderEditorHUD() {
    if (!editorHUD) return;
    let txt = 'EDITEUR (E = quitter)\nhaut/bas = regler | g/d = choisir\nShift = precis | S = sauver | R = reset\n-------------------------------\n';
    EDITOR_PARAMS.forEach((p, i) => { txt += (i === editorSel ? '> ' : '  ') + p.label + ' : ' + CAR_CONFIG[p.key].toFixed(2) + '\n'; });
    if (editorMsg) txt += '\n>> ' + editorMsg;
    editorHUD.textContent = txt;
}
function saveCarConfig() {
    localStorage.setItem('psx_car_config', JSON.stringify(CAR_CONFIG));
    console.log('CONFIG VOITURE (copie-colle) :', JSON.stringify(CAR_CONFIG));
    editorMsg = 'SAUVEGARDE OK';
    setTimeout(() => { editorMsg = ''; renderEditorHUD(); }, 1500);
}
function handleEditorKey(e) {
    if (e.code === 'KeyE') {
        editorActive = !editorActive;
        if (editorHUD) editorHUD.style.display = editorActive ? 'block' : 'none';
        keys.up = keys.down = keys.left = keys.right = keys.brake = false;
        renderEditorHUD(); e.preventDefault(); return true;
    }
    if (!editorActive) return false;
    const p = EDITOR_PARAMS[editorSel];
    const s = p.step * (e.shiftKey ? 0.25 : 1);
    switch (e.code) {
        case 'ArrowUp': CAR_CONFIG[p.key] = Math.round((CAR_CONFIG[p.key] + s) * 1000) / 1000; rebuildCar(); break;
        case 'ArrowDown': CAR_CONFIG[p.key] = Math.round((CAR_CONFIG[p.key] - s) * 1000) / 1000; rebuildCar(); break;
        case 'ArrowRight': editorSel = (editorSel + 1) % EDITOR_PARAMS.length; break;
        case 'ArrowLeft': editorSel = (editorSel - 1 + EDITOR_PARAMS.length) % EDITOR_PARAMS.length; break;
        case 'KeyS': saveCarConfig(); break;
        case 'KeyR': CAR_CONFIG = { ...DEFAULT_CAR_CONFIG }; rebuildCar(); editorMsg = 'RESET'; setTimeout(() => { editorMsg = ''; renderEditorHUD(); }, 1200); break;
        default: { const d = /^Digit(\d)$/.exec(e.code); if (d) { const idx = (parseInt(d[1], 10) + 9) % 10; if (idx < EDITOR_PARAMS.length) editorSel = idx; } }
    }
    renderEditorHUD(); e.preventDefault(); return true;
}

function clampRoadWidth(width) { if (!Number.isFinite(width)) return 4; return Math.min(Math.max(width, 2.5), 16); }
function getRoadWidth(tags) {
    let w;
    if (tags.width) w = clampRoadWidth(parseFloat(tags.width));
    else if (tags.lanes) w = clampRoadWidth(parseInt(tags.lanes, 10) * 3.5);
    else if (tags.highway === 'motorway' || tags.highway === 'trunk') w = 10;
    else if (tags.highway === 'primary' || tags.highway === 'secondary') w = 7;
    else w = 4;
    return w * WORLD_SCALE;
}
function isPointInChunk(point, padding = WORLD_CLIP_PADDING) {
    const limit = WORLD_CHUNK_SIZE / 2 + padding;
    return point.x >= -limit && point.x <= limit && point.z >= -limit && point.z <= limit;
}
function interpolatePoint(a, b, t) { return new THREE.Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
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
    if (clip(-dx, a.x - minX) && clip(dx, maxX - a.x) && clip(-dz, a.z - minZ) && clip(dz, maxZ - a.z)) return [interpolatePoint(a, b, t0), interpolatePoint(a, b, t1)];
    return null;
}
function pushPointIfDistinct(points, point) { const last = points[points.length - 1]; if (!last || last.distanceTo(point) > 0.05) points.push(point); }
function splitRoadIntoChunkPolylines(points, padding = WORLD_CLIP_PADDING) {
    const polylines = []; let current = [];
    for (let i = 0; i < points.length - 1; i++) {
        const clipped = clipSegmentToChunk(points[i], points[i + 1], padding);
        if (!clipped) { if (current.length > 1) polylines.push(current); current = []; continue; }
        const startsInside = isPointInChunk(points[i], padding);
        if (!startsInside && current.length > 1) { polylines.push(current); current = []; }
        pushPointIfDistinct(current, clipped[0]); pushPointIfDistinct(current, clipped[1]);
    }
    if (current.length > 1) polylines.push(current);
    return polylines;
}
function decimatePolyline(points, minDist = 6) {
    if (points.length < 3) return points;
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) { const last = out[out.length - 1]; if (Math.hypot(points[i].x - last.x, points[i].z - last.z) >= minDist) out.push(points[i]); }
    out.push(points[points.length - 1]);
    return out;
}
function polylineLength(points) { let L = 0; for (let i = 0; i < points.length - 1; i++) L += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z); return L; }
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

function roadIdentity(tags) {
    const t = tags || {};
    if (t.junction === 'roundabout') return 'ROUNDABOUT';
    if (t.name) return 'n:' + t.name;
    if (t.ref) return 'r:' + t.ref;
    return null;
}
function endDir(it, end) {
    const pl = it.polyline; let v;
    if (end === 1) { const a = pl[pl.length - 2], b = pl[pl.length - 1]; v = new THREE.Vector3(b.x - a.x, 0, b.z - a.z); }
    else { const a = pl[0], b = pl[1]; v = new THREE.Vector3(b.x - a.x, 0, b.z - a.z); }
    if (v.lengthSq() < 1e-8) v.set(0, 0, 1);
    return v.normalize();
}
function mergeRoadsSmart(entries) {
    const items = entries.map(e => ({ polyline: e.polyline.slice(), width: e.width, isHighway: e.isHighway, tags: e.tags, identity: roadIdentity(e.tags), alive: true }));
    const keyOf = (p) => Math.round(p.x) + '_' + Math.round(p.z);
    const degree = new Map();
    items.forEach(it => { for (const p of [it.polyline[0], it.polyline[it.polyline.length - 1]]) { const k = keyOf(p); degree.set(k, (degree.get(k) || 0) + 1); } });
    let changed = true, guard = 0;
    while (changed && guard < 12) {
        changed = false; guard++;
        const map = new Map();
        items.forEach((it, i) => {
            if (!it.alive) return;
            [[it.polyline[0], 0], [it.polyline[it.polyline.length - 1], 1]].forEach(([p, end]) => {
                const k = keyOf(p); let arr = map.get(k); if (!arr) { arr = []; map.set(k, arr); } arr.push({ i, end, k });
            });
        });
        for (const arr of map.values()) {
            for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
                const A = items[arr[x].i], B = items[arr[y].i];
                if (!A.alive || !B.alive || A === B) continue;
                const simple = (degree.get(arr[x].k) || 0) === 2;
                const dA = endDir(A, arr[x].end), dB = endDir(B, arr[y].end);
                const collinear = dA.dot(dB) < -0.75;
                const sameId = A.identity && A.identity === B.identity;
                if (!simple && !collinear && !sameId) continue;
                const rev = (pl) => pl.slice().reverse();
                let merged;
                if (arr[x].end === 1 && arr[y].end === 0) merged = A.polyline.concat(B.polyline.slice(1));
                else if (arr[x].end === 1 && arr[y].end === 1) merged = A.polyline.concat(rev(B.polyline).slice(1));
                else if (arr[x].end === 0 && arr[y].end === 0) merged = rev(A.polyline).concat(B.polyline.slice(1));
                else merged = B.polyline.concat(A.polyline.slice(1));
                A.polyline = merged; A.width = Math.max(A.width, B.width); A.isHighway = A.isHighway || B.isHighway;
                B.alive = false; changed = true;
            }
        }
    }
    return items.filter(it => it.alive && it.polyline.length >= 2);
}
function trimRoadsAtIntersections(entries) {
    const n = entries.length;
    if (n < 2) return entries.slice();
    const order = entries.map((_, i) => i).sort((a, b) => entries[b].width - entries[a].width || a - b);
    const rank = new Array(n); order.forEach((idx, r) => { rank[idx] = r; });
    const CELL = 8;
    const hashes = entries.map(e => {
        const map = new Map(); const L = polylineLength(e.polyline);
        for (let s = 0; s <= L; s += 4) { const sp = samplePolyline(e.polyline, s); if (!sp) continue; const k = Math.floor(sp.p.x / CELL) + '_' + Math.floor(sp.p.z / CELL); let arr = map.get(k); if (!arr) { arr = []; map.set(k, arr); } arr.push(sp.p); }
        return map;
    });
    const distTo = (j, x, z) => {
        const map = hashes[j]; const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL); let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const arr = map.get((cx + dx) + '_' + (cz + dz)); if (!arr) continue; for (const p of arr) { const d = Math.hypot(p.x - x, p.z - z); if (d < best) best = d; } }
        return best;
    };
    const out = [];
    for (let i = 0; i < n; i++) {
        const e = entries[i];
        if ((e.tags || {}).junction === 'roundabout') { out.push(e); continue; }
        const zones = []; for (let j = 0; j < n; j++) if (rank[j] < rank[i]) zones.push({ j, r: entries[j].width / 2 + 2.2 });
        if (!zones.length) { out.push(e); continue; }
        const L = polylineLength(e.polyline);
        const runs = []; let current = []; let insideStart = null;
        for (let s = 0; s <= L; s += 2) {
            const sp = samplePolyline(e.polyline, s); if (!sp) continue;
            let inside = false; for (const z of zones) { if (distTo(z.j, sp.p.x, sp.p.z) < z.r) { inside = true; break; } }
            if (inside) {
                if (current.length) { const last = current[current.length - 1]; const dir = sp.p.clone().sub(last); if (dir.length() > 0.01) { dir.normalize(); current.push(last.clone().addScaledVector(dir, 0.8)); } runs.push(current); current = []; insideStart = null; }
                if (insideStart === null) insideStart = sp.p.clone();
            } else {
                if (current.length === 0 && insideStart) current.push(insideStart);
                current.push(sp.p);
            }
        }
        if (current.length) runs.push(current);
        runs.filter(r => r.length >= 2).forEach(r => out.push({ ...e, polyline: r }));
    }
    return out;
}

function makeLineMats() {
    const c = document.createElement('canvas'); c.width = 8; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#26262c'; ctx.fillRect(0, 0, 8, 64);
    ctx.fillStyle = '#d8b84a'; ctx.fillRect(0, 0, 8, 32);
    dashTex = new THREE.CanvasTexture(c);
    dashTex.wrapS = THREE.RepeatWrapping; dashTex.wrapT = THREE.RepeatWrapping;
    dashTex.magFilter = THREE.NearestFilter; dashTex.minFilter = THREE.NearestFilter;
    if ('colorSpace' in dashTex) dashTex.colorSpace = THREE.SRGBColorSpace;
    dashMat = new THREE.MeshBasicMaterial({ map: dashTex, side: THREE.DoubleSide });
    whiteMat = new THREE.MeshBasicMaterial({ color: 0xb9b9b9, side: THREE.DoubleSide });
}

function addRibbon(points, lateral, width, mat, y, dash) {
    if (points.length < 2) return null;
    const pos = [], uv = [], idx = [];
    let cum = 0;
    for (let i = 0; i < points.length; i++) {
        if (i > 0) cum += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
        const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
        let tx = next.x - prev.x, tz = next.z - prev.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
        const nx = -tz, nz = tx;
        const cx = points[i].x + nx * lateral, cz = points[i].z + nz * lateral;
        pos.push(cx + nx * width / 2, y, cz + nz * width / 2, cx - nx * width / 2, y, cz - nz * width / 2);
        const v = cum / (dash ? 4 : 1);
        uv.push(0, v, 1, v);
    }
    for (let i = 0; i < points.length - 1; i++) { const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1; idx.push(a, b, c, c, b, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
}

function createBaseCanvas(entries) {
    const S = ROAD_CANVAS_SIZE;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, S, S);
    const half = WORLD_CHUNK_SIZE / 2;
    const toP = (p) => ({ x: (p.x + half) / WORLD_CHUNK_SIZE * S, y: (p.z + half) / WORLD_CHUNK_SIZE * S });
    const m2px = S / WORLD_CHUNK_SIZE;
    const stroke = (pls, widthPx, color) => {
        ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = widthPx;
        for (const pl of pls) { if (pl.length < 2) continue; ctx.beginPath(); const p0 = toP(pl[0]); ctx.moveTo(p0.x, p0.y); for (let i = 1; i < pl.length; i++) { const p = toP(pl[i]); ctx.lineTo(p.x, p.y); } ctx.stroke(); }
    };
    for (const e of entries) { const w = Math.max(e.width, 4); stroke([e.polyline], (w + 2.4) * m2px, '#8f8f93'); }
    for (const e of entries) { const w = Math.max(e.width, 4); stroke([e.polyline], w * m2px, '#26262c'); }
    return c;
}

// ============================================================
// TERRAIN FRACTAL : value noise multi-octaves + zones montagneuses
// ============================================================

// Hash pseudo-aléatoire déterministe par coordonnée
function hash2(x, y) {
    const n = Math.sin(x * 374.123 + y * 781.456 + 137.89) * 43758.5453;
    return n - Math.floor(n);
}
// Value noise interpolé (smoothstep) entre 0 et 1
function valueNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
// Fractal Brownian Motion : 4 octaves de value noise (relief naturel irrégulier)
function fbm(x, y) {
    let n = 0, amp = 1, freq = 1, sum = 0;
    for (let i = 0; i < 4; i++) {
        n += (valueNoise(x * freq, y * freq) * 2 - 1) * amp;
        sum += amp;
        amp *= 0.5;
        freq *= 2.1;
    }
    return n / sum;
}
// Masque macro : régions montagneuses localisées (bruit très basse fréquence)
// retourne 0..1 (0 = plaine, 1 = zone montagneuse)
function mountainMask(x, y) {
    const m = valueNoise(x * 0.0015 + 47.3, y * 0.0015 - 11.7);
    // on pousse les valeurs vers 0 ou 1 pour des zones bien délimitées
    const t = (m - 0.45) * 3.5;
    return Math.max(0, Math.min(1, t));
}
function terrainNoise(x, z) {
    // échelle ~40m entre collines
    return fbm(x * 0.025 + 12.7, z * 0.025 + 5.3);
}

function makeTerrainMask(entries) {
    const S = TERRAIN_MASK_S;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    const half = WORLD_CHUNK_SIZE / 2;
    const toP = (p) => ({ x: (p.x + half) / WORLD_CHUNK_SIZE * S, y: (p.z + half) / WORLD_CHUNK_SIZE * S });
    const m2px = S / WORLD_CHUNK_SIZE;
    ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const e of entries) {
        const w = Math.max(e.width, 4);
        ctx.lineWidth = (w + 2.4 + 18.0) * m2px;   // zone plate plus large que la maille du terrain
        ctx.beginPath(); const p0 = toP(e.polyline[0]); ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < e.polyline.length; i++) { const p = toP(e.polyline[i]); ctx.lineTo(p.x, p.y); }
        ctx.stroke();
    }
    return ctx.getImageData(0, 0, S, S);
}

function terrainElevAt(mask, S, x, z, worldX, worldZ) {
    const half = WORLD_CHUNK_SIZE / 2;
    const mx = Math.min(S - 1, Math.max(0, Math.floor((x + half) / WORLD_CHUNK_SIZE * S)));
    const my = Math.min(S - 1, Math.max(0, Math.floor((z + half) / WORLD_CHUNK_SIZE * S)));
    let m = mask.data[(my * S + mx) * 4] / 255;
    m = m * m * (3 - 2 * m);
    if (m > 0.3) m = 1; // route : strictement plat

    const wx = worldX + x, wz = worldZ + z;
    const n = terrainNoise(wx, wz);         // -1..1
    const mm = mountainMask(wx, wz);        // 0..1

    // amplitude variable : collines (4m) + montagnes (20m) dans les zones mm élevées
    const amp = TERRAIN_AMP + mm * (TERRAIN_MOUNTAIN_AMP - TERRAIN_AMP);
    let e = n * amp * (1 - m);
    if (e < -0.05) e = -0.05;
    return e;
}
// Hauteur max du terrain autour d'un point monde (pour spawn au-dessus du sol)
function spawnGroundHeight(wx, wz) {
    let maxH = -Infinity;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const n = terrainNoise(wx + dx, wz + dz);
        const mm = mountainMask(wx + dx, wz + dz);
        const amp = TERRAIN_AMP + mm * (TERRAIN_MOUNTAIN_AMP - TERRAIN_AMP);
        let e = n * amp;
        if (e < -0.05) e = -0.05;
        if (e > maxH) maxH = e;
    }
    return maxH;
}
function buildTerrain(group, entries, worldX, worldZ) {
    const S = TERRAIN_MASK_S;
    const mask = makeTerrainMask(entries);
    const geo = new THREE.PlaneGeometry(WORLD_CHUNK_SIZE, WORLD_CHUNK_SIZE, TERRAIN_SEG, TERRAIN_SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.setY(i, terrainElevAt(mask, S, pos.getX(i), pos.getZ(i), worldX, worldZ));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const mat = grassTexture ? new THREE.MeshStandardMaterial({ map: grassTexture }) : new THREE.MeshStandardMaterial({ color: 0x7A8C4E });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);

    let body = null;
    try {
        const verts = new Float32Array(geo.attributes.position.array);
        const srcIdx = geo.index.array;
        const indices = new Uint32Array(srcIdx.length);
        for (let i = 0; i < srcIdx.length; i++) indices[i] = srcIdx[i];
        body = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(worldX, 0, worldZ));
        physicsWorld.createCollider(RAPIER.ColliderDesc.trimesh(verts, indices), body);
    } catch (e) { console.warn('trimesh terrain echec', e); body = null; }
    return body;
}

function placeStreetlights(entries, lampData) {
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), PV = new THREE.Vector3(), SV = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), HV = new THREE.Vector3();
    for (const { polyline, width, isHighway } of entries) {
        if (!(STREETLIGHT_ENABLED && (isHighway || width >= STREETLIGHT_MIN_WIDTH))) continue;
        const w = Math.max(width, 4);
        const sw = 1.2;
        const total = polylineLength(polyline);
        let side = 1;
        for (let s = STREETLIGHT_SPACING / 2; s < total; s += STREETLIGHT_SPACING) {
            const sample = samplePolyline(polyline, s); if (!sample) continue;
            const nx2 = -sample.dir.z, nz2 = sample.dir.x;
            const off = (w / 2 + sw + 0.4) * side;
            const lx = sample.p.x + nx2 * off, lz = sample.p.z + nz2 * off;
            const dirX = -side * nx2, dirZ = -side * nz2;
            const yaw = Math.atan2(-dirZ, dirX);
            Q.setFromAxisAngle(Y, yaw); PV.set(lx, 0, lz); SV.set(1, 1, 1);
            M4.compose(PV, Q, SV);
            lampData.matrices.push(M4.clone());
            HV.set(1.55, 5.9, 0).applyQuaternion(Q).add(PV);
            lampData.heads.push({ x: HV.x, y: HV.y, z: HV.z });
            side *= -1;
        }
    }
}
function buildLampTemplates() {
    const pole = new THREE.CylinderGeometry(0.07, 0.1, 6, 6); pole.translate(0, 3, 0);
    const arm = new THREE.BoxGeometry(1.6, 0.09, 0.09); arm.translate(0.8, 5.95, 0);
    const mergeFn = BufferGeometryUtils.mergeGeometries || BufferGeometryUtils.mergeBufferGeometries;
    lampPostGeo = mergeFn ? mergeFn([pole, arm]) : pole;
    lampHeadGeo = new THREE.BoxGeometry(0.55, 0.14, 0.24); lampHeadGeo.translate(1.55, 5.9, 0);
    lampPoolGeo = new THREE.PlaneGeometry(1, 1); lampPoolGeo.rotateX(-Math.PI / 2);
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,200,130,0.5)'); g.addColorStop(0.5, 'rgba(255,180,100,0.16)'); g.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    glowTexture = new THREE.CanvasTexture(c);
}
function addStreetlights(group, lampData) {
    if (!lampData.matrices.length) return;
    if (!lampPostGeo) buildLampTemplates();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x26262a, roughness: 0.6 });
    const posts = new THREE.InstancedMesh(lampPostGeo, postMat, lampData.matrices.length);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffd9a0, emissiveIntensity: 2.5 });
    const heads = new THREE.InstancedMesh(lampHeadGeo, headMat, lampData.matrices.length);
    lampData.matrices.forEach((m, i) => { posts.setMatrixAt(i, m); heads.setMatrixAt(i, m); });
    posts.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
    group.add(posts); group.add(heads);
    const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
        lampHeadMats.push(headMat);
    lampGlowMats.push(glowMat);
    const pools = new THREE.InstancedMesh(lampPoolGeo, glowMat, lampData.heads.length);
    const M = new THREE.Matrix4(), QQ = new THREE.Quaternion(), PP = new THREE.Vector3(), SS = new THREE.Vector3(10, 1, 10);
    lampData.heads.forEach((h, i) => { PP.set(h.x, 0.3, h.z); M.compose(PP, QQ, SS); pools.setMatrixAt(i, M); });
    pools.instanceMatrix.needsUpdate = true; pools.renderOrder = 2;
    group.add(pools);
}

function collectRoadInstances(polyline, width, out) {
    const step = roadInfo.segLen * 0.95;
    const total = polylineLength(polyline);
    const scaleX = THREE.MathUtils.clamp(width / roadInfo.segWidth, 0.7, 1.8);
    for (let s = step / 2; s < total; s += step) { const sample = samplePolyline(polyline, s); if (!sample) continue; out.push({ x: sample.p.x, z: sample.p.z, yaw: Math.atan2(sample.dir.x, sample.dir.z), scaleX }); }
}
function createRoadMesh(points, width, material) {
    if (points.length < 2) return null;
    const pos = [], indices = [];
    const roadY = 0.25 * WORLD_SCALE;
    for (let i = 0; i < points.length; i++) {
        const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
        const tangent = next.clone().sub(prev); tangent.y = 0;
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
    for (let i = 0; i < vertexPairs - 1; i++) { const a = i * 2; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, material);
}

function initThree() {
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xE8B98A, 200 * WORLD_SCALE, 1200 * WORLD_SCALE);
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000 * WORLD_SCALE);
    camera.position.set(0, 5, 12);
    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    ambientLight = new THREE.AmbientLight(0x2E3A5C, 0.5);
    scene.add(ambientLight);
    dirLight = new THREE.DirectionalLight(0xFFB870, 1.5);
    dirLight.position.set(-60, 120, -40);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left = -150; dirLight.shadow.camera.right = 150;
    dirLight.shadow.camera.top = 150; dirLight.shadow.camera.bottom = -150;
    dirLight.shadow.camera.near = 10; dirLight.shadow.camera.far = 400;
    scene.add(dirLight);
    scene.add(dirLight.target);
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomEffectRef = new BloomEffect({ intensity: PSX_FX.bloom, luminanceThreshold: 0.9, mipmapBlur: true, radius: 0.7 });
    const baseEffects = [new SMAAEffect(), bloomEffectRef];if (PSX_FX.toneMapping) baseEffects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    if (PSX_FX.vignette > 0) baseEffects.push(new VignetteEffect({ offset: 0.28, darkness: PSX_FX.vignette }));
    composer.addPass(new EffectPass(camera, ...baseEffects));
    if (PSX_FX.chroma > 0) composer.addPass(new EffectPass(camera, new ChromaticAberrationEffect({ offset: new THREE.Vector2(PSX_FX.chroma, PSX_FX.chroma), radialModulation: true, modulationOffset: 0.45 })));
    if (PSX_FX.pixelation > 1) composer.addPass(new EffectPass(camera, new PixelationEffect(PSX_FX.pixelation)));
    const overlayEffects = [];
    if (PSX_FX.grain > 0) { const n = new NoiseEffect({ blendFunction: BlendFunction.ADD }); n.blendMode.opacity.value = PSX_FX.grain; overlayEffects.push(n); }
    if (PSX_FX.scanlines > 0) { const s = new ScanlineEffect({ density: 1.1 }); s.blendMode.opacity.value = PSX_FX.scanlines; overlayEffects.push(s); }
    if (PSX_FX.colorBits < 8) overlayEffects.push(new ColorDepthEffect({ bits: PSX_FX.colorBits }));
    if (overlayEffects.length) composer.addPass(new EffectPass(camera, ...overlayEffects));
    createSky();
        initAmbiance({
        scene, skyMatRef, ambientLight, dirLight,
        lampHeadMats, lampGlowMats, bloomEffect: bloomEffectRef, renderer
    });
    window.addEventListener('resize', onWindowResize);
}
function createSky() {
    const skyGeo = new THREE.SphereGeometry(1500 * WORLD_SCALE, 32, 15);
    const skyMat = new THREE.ShaderMaterial({
        uniforms: { topColor: { value: new THREE.Color(0x7B6FA8) }, bottomColor: { value: new THREE.Color(0xF2A65A) }, offset: { value: 33 }, exponent: { value: 0.6 } },
        vertexShader: `varying vec3 vWorldPosition; void main(){ vWorldPosition=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 topColor; uniform vec3 bottomColor; uniform float offset; uniform float exponent; varying vec3 vWorldPosition; void main(){ float h=normalize(vWorldPosition+offset).y; gl_FragColor=vec4(mix(bottomColor,topColor,max(pow(max(h,0.0),exponent),0.0)),1.0); }`,
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false
    });
    sky = new THREE.Mesh(skyGeo, skyMat);
        skyMatRef = skyMat;
    sky.frustumCulled = false; sky.renderOrder = -1000;
    scene.add(sky);
}
let minimapBaseLayers = [];
let minimapBaseIdx = 0;
let minimapLayerBtn = null;

function initMinimap() {
    if (!window.L || !document.getElementById('minimap')) return;
    minimapContainer = document.getElementById('minimap-rotator');
    minimap = window.L.map('minimap', {
        zoomControl: false, attributionControl: false, dragging: false,
        scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
        keyboard: false, touchZoom: false
    }).setView([0, 0], 16);

    minimapBaseLayers = [
        { name: 'Satellite', layer: window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri', maxZoom: 19 }) },
        { name: 'Plan', layer: window.L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap © CARTO', maxZoom: 20 }) },
        { name: 'OSM', layer: window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }) },
    ];
    minimapBaseLayers[0].layer.addTo(minimap);

    const style = document.createElement('style');
    style.textContent = `
        #minimap-layer-btn{position:fixed;left:10px;bottom:236px;z-index:9990;padding:4px 10px;border:none;border-radius:6px;
            background:#f2a65a;color:#241d38;font:700 11px monospace;cursor:pointer;}
    `;
    document.head.appendChild(style);

    minimapLayerBtn = document.createElement('button');
    minimapLayerBtn.id = 'minimap-layer-btn';
    minimapLayerBtn.textContent = '🗺 ' + minimapBaseLayers[0].name;
    minimapLayerBtn.onclick = () => {
        minimap.removeLayer(minimapBaseLayers[minimapBaseIdx].layer);
        minimapBaseIdx = (minimapBaseIdx + 1) % minimapBaseLayers.length;
        minimapBaseLayers[minimapBaseIdx].layer.addTo(minimap);
        minimapLayerBtn.textContent = '🗺 ' + minimapBaseLayers[minimapBaseIdx].name;
    };
    document.body.appendChild(minimapLayerBtn);
    const mm = document.getElementById('minimap');
    if (mm) {
        minimapCarArrow = document.createElement('div');
        minimapCarArrow.style.cssText = 'position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;z-index:1200;pointer-events:none;';
        minimapCarArrow.innerHTML = `<svg viewBox="0 0 24 24" width="34" height="34"><path d="M12 1.5 L20 22 L12 17.5 L4 22 Z" fill="#f2a65a" stroke="#000" stroke-width="1"/></svg>`;
        mm.appendChild(minimapCarArrow);
    }
    setTimeout(() => { minimap.invalidateSize(); }, 100);
}
async function loadModel(url, fallbackUrl) {
    const doLoad = async (u) => {
        const ext = u.split('.').pop().split('?')[0].toLowerCase();
        if (ext === 'fbx') return await new FBXLoader().loadAsync(u);
        if (ext === 'obj') return await new OBJLoader().loadAsync(u);
        return (await new GLTFLoader().loadAsync(u)).scene;
    };
    try { return await doLoad(url); }
    catch (e) { if (fallbackUrl) { console.warn('Modèle introuvable : ' + url, e); try { return await doLoad(fallbackUrl); } catch (e2) { return null; } } return null; }
}
async function loadRoadTemplate() {
    if (ROAD_STYLE !== 'segments') { console.log('Route style =', ROAD_STYLE); return; }
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
        root.position.x -= center.x; root.position.z -= center.z; root.position.y -= box.min.y;
        holder.updateWorldMatrix(true, true);
        const geos = [], mats = [];
        holder.traverse(o => { if (o.isMesh) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); geos.push(g); mats.push(o.material); } });
        if (!geos.length) throw new Error('aucun mesh');
        const mergeFn = BufferGeometryUtils.mergeGeometries || BufferGeometryUtils.mergeBufferGeometries;
        let merged = geos.length === 1 ? geos[0] : null;
        if (geos.length > 1 && mergeFn) { try { merged = mergeFn(geos, true); } catch (e) { merged = null; } }
        if (!merged) { merged = geos[0]; mats.length = 1; }
        merged.scale(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);
        roadGeo = merged; roadMats = mats;
        roadInfo = { segLen: segLenRaw * WORLD_SCALE, segWidth: segWidthRaw * WORLD_SCALE };
    } catch (e) { console.warn('Modèle route introuvable → ruban.', e); roadInfo = null; roadGeo = null; roadMats = []; }
}
async function makeGrassTexture() {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    for (const url of GRASS_URLS) {
        try {
            const tex = await loader.loadAsync(url);
            const c = document.createElement('canvas'); c.width = 128; c.height = 128;
            const ctx = c.getContext('2d');
            ctx.drawImage(tex.image, 0, 0, 128, 128);
            const t = new THREE.CanvasTexture(c);
            t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.repeat.set(CHUNK_SIZE / GRASS_TILE_SIZE, CHUNK_SIZE / GRASS_TILE_SIZE);
            if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
            console.log('Herbe PSX chargée :', url);
            return t;
        } catch (e) { console.warn('Échec herbe :', url); }
    }
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    const shades = ['#5a7a3a', '#618243', '#557336', '#6a8c4a', '#4e6a30', '#527034'];
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { ctx.fillStyle = shades[(Math.random() * shades.length) | 0]; ctx.fillRect(x, y, 1, 1); }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(CHUNK_SIZE / GRASS_TILE_SIZE, CHUNK_SIZE / GRASS_TILE_SIZE);
    return t;
}

async function initPhysics() {
    await RAPIER.init();
    physicsWorld = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
    const groundHalfSize = 10000 * WORLD_SCALE;
    physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(groundHalfSize, 0.1, groundHalfSize).setTranslation(0, -0.1, 0));
    const chassisDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1.2, 0).setLinearDamping(0.05).setAngularDamping(1.0);
    chassisBody = physicsWorld.createRigidBody(chassisDesc);
    physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(0.95, 0.6, CAR_LENGTH / 2 * 0.95).setMass(CAR_MASS * 0.55).setFriction(0.5), chassisBody);
    physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(0.8, 0.2, CAR_LENGTH / 2 * 0.8).setMass(CAR_MASS * 0.45).setTranslation(0, -0.4, 0), chassisBody);
    vehicleController = physicsWorld.createVehicleController(chassisBody);
    const wheelPositions = [
        { x: -WHEEL_TRACK_X, y: 0, z: -WHEEL_BASE_Z }, { x: WHEEL_TRACK_X, y: 0, z: -WHEEL_BASE_Z },
        { x: -WHEEL_TRACK_X, y: 0, z: WHEEL_BASE_Z }, { x: WHEEL_TRACK_X, y: 0, z: WHEEL_BASE_Z }
    ];
    wheelPositions.forEach(pos => {
        vehicleController.addWheel(pos, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION_REST, WHEEL_RADIUS);
        const idx = vehicleController.numWheels() - 1;
        vehicleController.setWheelSuspensionStiffness(idx, SUSPENSION_STIFFNESS);
        vehicleController.setWheelSuspensionCompression(idx, SUSPENSION_COMPRESSION);
        vehicleController.setWheelSuspensionRelaxation(idx, SUSPENSION_RELAXATION);
        vehicleController.setWheelMaxSuspensionTravel(idx, SUSPENSION_MAX_TRAVEL);
        vehicleController.setWheelFrictionSlip(idx, GRIP * MS);
    });
    masterRoot = await loadModel(CAR_MODEL_URL, CAR_FALLBACK_URL);
    masterWheel = await loadModel(CAR_WHEEL_URL, null);
    if (masterRoot) {
        dedupeCoincident(masterRoot);
        masterRoot.traverse(o => { if (o.isMesh && o.material) { if (Array.isArray(o.material)) o.material.forEach(m => m.side = THREE.DoubleSide); else o.material.side = THREE.DoubleSide; } });
    }
    buildCarVisual();
}
function dedupeCoincident(root) {
    const seen = [];
    const maxDim = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).length();
    const eps = Math.max(maxDim * 0.001, 1e-4);
    for (const child of [...root.children]) {
        let hasMesh = false; child.traverse(o => { if (o.isMesh) hasMesh = true; });
        if (!hasMesh) continue;
        const b = new THREE.Box3().setFromObject(child); const c = b.getCenter(new THREE.Vector3()); const s = b.getSize(new THREE.Vector3());
        const dup = seen.find(e => Math.abs(e.c.x - c.x) < eps && Math.abs(e.c.y - c.y) < eps && Math.abs(e.c.z - c.z) < eps && Math.abs(e.s.x - s.x) < eps && Math.abs(e.s.y - s.y) < eps && Math.abs(e.s.z - s.z) < eps);
        if (dup) root.remove(child); else seen.push({ c, s });
    }
}
function detectSeam(object, axis, box) {
    const size = box.getSize(new THREE.Vector3());
    const eps = Math.max(size[axis] * 0.02, 1e-4);
    const stats = { min: { bound: 0, plane: 0, ymin: Infinity, ymax: -Infinity }, max: { bound: 0, plane: 0, ymin: Infinity, ymax: -Infinity } };
    const v = new THREE.Vector3();
    const record = (side, isBound, y) => { const s = stats[side]; if (isBound) s.bound++; else s.plane++; if (y < s.ymin) s.ymin = y; if (y > s.ymax) s.ymax = y; };
    object.traverse(o => {
        if (!o.isMesh || !o.geometry) return;
        const geo = o.geometry; const posAttr = geo.attributes.position;
        if (!posAttr) return;
        o.updateWorldMatrix(true, false);
        for (let i = 0; i < posAttr.count; i++) { v.fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld); if (Math.abs(v[axis] - box.min[axis]) < eps) record('min', false, v.y); else if (Math.abs(v[axis] - box.max[axis]) < eps) record('max', false, v.y); }
        const edgeCount = new Map();
        const addEdge = (a, b) => { const k = a < b ? a * 100000 + b : b * 100000 + a; edgeCount.set(k, (edgeCount.get(k) || 0) + 1); };
        const idx = geo.index;
        if (idx) { for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2); addEdge(a, b); addEdge(b, c); addEdge(c, a); } }
        else { for (let i = 0; i < posAttr.count; i += 3) { addEdge(i, i + 1); addEdge(i + 1, i + 2); addEdge(i + 2, i); } }
        const boundary = new Set();
        edgeCount.forEach((c, k) => { if (c === 1) { boundary.add(Math.floor(k / 100000)); boundary.add(k % 100000); } });
        boundary.forEach(vi => { v.fromBufferAttribute(posAttr, vi).applyMatrix4(o.matrixWorld); if (Math.abs(v[axis] - box.min[axis]) < eps) record('min', true, v.y); else if (Math.abs(v[axis] - box.max[axis]) < eps) record('max', true, v.y); });
    });
    const span = s => (s.ymax > s.ymin ? s.ymax - s.ymin : 0);
    if (stats.min.bound + stats.max.bound > 0) return span(stats.min) >= span(stats.max) ? box.min[axis] : box.max[axis];
    if (stats.min.plane + stats.max.plane > 0) return span(stats.min) >= span(stats.max) ? box.min[axis] : box.max[axis];
    return box.max[axis];
}
function flipWinding(geo) {
    if (geo.index) { const arr = geo.index.array; for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t; } geo.index.needsUpdate = true; }
    else { for (const name in geo.attributes) { const attr = geo.attributes[name]; const arr = attr.array; const n = attr.itemSize; for (let i = 0; i < arr.length; i += n * 3) { for (let c = 0; c < n; c++) { const t = arr[i + n + c]; arr[i + n + c] = arr[i + 2 * n + c]; arr[i + 2 * n + c] = t; } } attr.needsUpdate = true; } }
}
function prepareWheelClone(wheelRoot) {
    const w = wheelRoot.clone(true);
    let box = new THREE.Box3().setFromObject(w); let size = box.getSize(new THREE.Vector3());
    if (size.y <= size.x && size.y <= size.z) w.rotation.z = Math.PI / 2;
    else if (size.z <= size.x && size.z <= size.y) w.rotation.y = Math.PI / 2;
    w.updateWorldMatrix(true, true);
    box = new THREE.Box3().setFromObject(w); size = box.getSize(new THREE.Vector3());
    const s = (WHEEL_RADIUS * 2) / Math.max(size.y, size.z, 0.001);
    w.scale.multiplyScalar(s);
    w.updateWorldMatrix(true, true);
    box = new THREE.Box3().setFromObject(w);
    const c = box.getCenter(new THREE.Vector3());
    w.position.sub(c);
    return w;
}

function buildCarVisual() {
    carGroup = new THREE.Group(); scene.add(carGroup); wheelsVis = [];
    let bodyOk = false;
    if (masterRoot) {
        masterRoot.updateWorldMatrix(true, true);
        const allMeshes = []; masterRoot.traverse(o => { if (o.isMesh) allMeshes.push(o); });
        const wheelMeshes = allMeshes.filter(m => /wheel|tire|tyre|roue/i.test(m.name));
        const hasOwnWheels = wheelMeshes.length >= 4;
        const bodyMeshes = hasOwnWheels ? allMeshes.filter(m => !wheelMeshes.includes(m)) : allMeshes;
        const box0 = new THREE.Box3().setFromObject(masterRoot);
        const size0 = box0.getSize(new THREE.Vector3());
        const widthAxis = size0.x > size0.z ? 'z' : 'x';
        const a = box0.min[widthAxis], b = box0.max[widthAxis];
        let seam;
        if (MIRROR_MODE === 'min') seam = a; else if (MIRROR_MODE === 'max') seam = b; else seam = detectSeam(masterRoot, widthAxis, box0);
        if (MIRROR_CAR) { const m0 = 2 * seam - b, m1 = 2 * seam - a; const overlap = Math.min(b, m1) - Math.max(a, m0); if (overlap > (b - a) * 0.5) seam = (seam === a) ? b : a; }
        const mirrorPlane = new THREE.Matrix4();
        if (MIRROR_CAR) {
            const T1 = new THREE.Matrix4(), S = new THREE.Matrix4(), T2 = new THREE.Matrix4();
            if (widthAxis === 'x') { T1.makeTranslation(seam, 0, 0); S.makeScale(-1, 1, 1); T2.makeTranslation(-seam, 0, 0); }
            else { T1.makeTranslation(0, 0, seam); S.makeScale(1, 1, -1); T2.makeTranslation(0, 0, -seam); }
            mirrorPlane.multiplyMatrices(T1, S).multiply(T2);
        }
        const body = new THREE.Group();
        bodyMeshes.forEach(m => {
            const gA = m.geometry.clone(); gA.applyMatrix4(m.matrixWorld);
            const mA = new THREE.Mesh(gA, m.material); mA.castShadow = true; body.add(mA);
            if (MIRROR_CAR) { const gB = m.geometry.clone(); gB.applyMatrix4(new THREE.Matrix4().multiplyMatrices(mirrorPlane, m.matrixWorld)); flipWinding(gB); const mB = new THREE.Mesh(gB, m.material); mB.castShadow = true; body.add(mB); }
        });
        const flip = new THREE.Group(); flip.add(body);
        if (CAR_UPSIDE_DOWN) flip.rotation.z = Math.PI;
        const orient = new THREE.Group(); orient.add(flip);
        flip.updateWorldMatrix(true, true);
        let box = new THREE.Box3().setFromObject(flip); let size = box.getSize(new THREE.Vector3());
        if (size.x > size.z) orient.rotation.y = Math.PI / 2;
        if (FLIP_CAR) orient.rotation.y += Math.PI;
        orient.updateWorldMatrix(true, true);
        box = new THREE.Box3().setFromObject(orient); size = box.getSize(new THREE.Vector3());
        orient.scale.setScalar(CAR_LENGTH / Math.max(size.z, 0.001));
        orient.updateWorldMatrix(true, true);
        box = new THREE.Box3().setFromObject(orient);
        const center = box.getCenter(new THREE.Vector3());
        orient.position.x -= center.x; orient.position.z -= center.z; orient.position.y += (-1.05 - box.min.y);
        orient.position.y += CAR_CONFIG.bodyY; orient.rotation.y += CAR_CONFIG.bodyRotY; orient.scale.multiplyScalar(CAR_CONFIG.bodyScale);
        carGroup.add(orient); carGroup.updateWorldMatrix(true, true);
        bodyOk = true;
        if (hasOwnWheels) {
            wheelMeshes.sort((m1, m2) => { const ca = new THREE.Vector3(), cb = new THREE.Vector3(); new THREE.Box3().setFromObject(m1).getCenter(ca); new THREE.Box3().setFromObject(m2).getCenter(cb); if (Math.sign(ca.z) !== Math.sign(cb.z)) return ca.z - cb.z; return ca.x - cb.x; });
            for (let i = 0; i < 4; i++) {
                const c = new THREE.Vector3(); new THREE.Box3().setFromObject(wheelMeshes[i]).getCenter(c); c.applyMatrix4(orient.matrixWorld);
                const pivot = new THREE.Group(); pivot.position.set(c.x, 0, c.z); carGroup.add(pivot);
                const g = wheelMeshes[i].geometry.clone(); g.applyMatrix4(wheelMeshes[i].matrixWorld);
                const wm = new THREE.Mesh(g, wheelMeshes[i].material); wm.castShadow = true;
                const rel = new THREE.Vector3(); new THREE.Box3().setFromObject(wheelMeshes[i]).getCenter(rel); rel.applyMatrix4(orient.matrixWorld);
                wm.position.set(-rel.x + c.x, -rel.y, -rel.z + c.z);
                pivot.add(wm);
                wheelsVis.push({ node: pivot, baseX: c.x, baseZ: c.z, designY: 0, rest0: null });
            }
        }
    }
    if (!bodyOk) carGroup.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshStandardMaterial({ color: 0xF2A65A })));
    if (wheelsVis.length === 0) {
        const corners = [
            { x: -WHEEL_TRACK_X, z: -WHEEL_BASE_Z }, { x: WHEEL_TRACK_X, z: -WHEEL_BASE_Z },
            { x: -WHEEL_TRACK_X, z: WHEEL_BASE_Z }, { x: WHEEL_TRACK_X, z: WHEEL_BASE_Z }
        ];
        if (masterWheel) {
            corners.forEach(p => {
                const px = p.x + Math.sign(p.x) * CAR_CONFIG.wheelTrack, pz = p.z + Math.sign(p.z) * CAR_CONFIG.wheelBase;
                const pivot = new THREE.Group();
                pivot.position.set(px, -SUSPENSION_REST + CAR_CONFIG.wheelY, pz);
                pivot.scale.setScalar(CAR_CONFIG.wheelScale);
                pivot.add(prepareWheelClone(masterWheel));
                carGroup.add(pivot);
                wheelsVis.push({ node: pivot, baseX: px, baseZ: pz, designY: -SUSPENSION_REST + CAR_CONFIG.wheelY, rest0: null });
            });
        } else {
            const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 16); wheelGeo.rotateZ(Math.PI / 2);
            const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
            corners.forEach(p => {
                const px = p.x + Math.sign(p.x) * CAR_CONFIG.wheelTrack, pz = p.z + Math.sign(p.z) * CAR_CONFIG.wheelBase;
                const w = new THREE.Mesh(wheelGeo, wheelMat); w.castShadow = true;
                w.position.set(px, -SUSPENSION_REST + CAR_CONFIG.wheelY, pz);
                w.scale.setScalar(CAR_CONFIG.wheelScale);
                carGroup.add(w);
                wheelsVis.push({ node: w, baseX: px, baseZ: pz, designY: -SUSPENSION_REST + CAR_CONFIG.wheelY, rest0: null });
            });
        }
    }
    headMatShared = new THREE.MeshStandardMaterial({ color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 3 });
    rearMatShared = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2222, emissiveIntensity: 0.7 });
    const hlGeo = new THREE.SphereGeometry(0.09, 8, 8);
    const rlGeo = new THREE.BoxGeometry(0.3, 0.12, 0.08);
    for (const s of [-1, 1]) {
        const hl = new THREE.Mesh(hlGeo, headMatShared);
        hl.position.set(s * CAR_CONFIG.lightX, CAR_CONFIG.lightY, CAR_CONFIG.lightFrontZ);
        carGroup.add(hl);
        const spot = new THREE.SpotLight(0xfff6d0, HEADLIGHT_INTENSITY, 60, 0.5, 0.4, 1.2);
        spot.position.copy(hl.position);
        const tgt = new THREE.Object3D();
        tgt.position.set(s * CAR_CONFIG.lightX * 0.7, CAR_CONFIG.lightY - 0.8, CAR_CONFIG.lightFrontZ - 18);
        carGroup.add(tgt);
        spot.target = tgt;
        carGroup.add(spot);
        const rl = new THREE.Mesh(rlGeo, rearMatShared);
        rl.position.set(s * CAR_CONFIG.lightX, CAR_CONFIG.lightY, CAR_CONFIG.lightRearZ);
        carGroup.add(rl);
    }
}
function rebuildCar() { if (carGroup) scene.remove(carGroup); wheelsVis = []; buildCarVisual(); }
// Copie rouge translucide exacte de la voiture pour le fantôme
let ghostMatShared = null;

// Voiture rouge OPAQUE (physique) pour le replay du ghost
function createGhostCar() {
    if (!carGroup) return null;
    if (!ghostMatShared) {
        ghostMatShared = new THREE.MeshStandardMaterial({
            color: 0xd02020,      // rouge opaque
            roughness: 0.35,
            metalness: 0.4,
        });
    }
    const clone = carGroup.clone(true);
    const toRemove = [];
    clone.traverse(o => {
        if (o.isLight) toRemove.push(o);              // pas de phares sur l'adversaire
        else if (o.isMesh) { o.material = ghostMatShared; o.castShadow = true; }  // ombres = look physique
    });
    toRemove.forEach(o => o.parent && o.parent.remove(o));
    return clone;
}
function latLonToVector3(lat, lon) {
    const x = (lon - baseLon) * (Math.PI / 180) * EARTH_RADIUS * Math.cos(baseLat * Math.PI / 180);
    const z = -(lat - baseLat) * (Math.PI / 180) * EARTH_RADIUS;
    return new THREE.Vector3(x * WORLD_SCALE, 0, z * WORLD_SCALE);
}
function vector3ToLatLon(x, z) {
    const lat = baseLat + (-(z / WORLD_SCALE) / EARTH_RADIUS) * (180 / Math.PI);
    const lon = baseLon + ((x / WORLD_SCALE) / (EARTH_RADIUS * Math.cos(baseLat * Math.PI / 180))) * (180 / Math.PI);
    return { lat, lon };
}

function updateChunks() {
    if (!hasStarted) return;
    const carPos = chassisBody ? chassisBody.translation() : { x: 0, z: 0 };
    const camX = Math.floor(carPos.x / WORLD_CHUNK_SIZE);
    const camZ = Math.floor(carPos.z / WORLD_CHUNK_SIZE);
    for (const [key, chunk] of loadedChunks) {
        const dx = Math.abs(chunk.gridX - camX), dz = Math.abs(chunk.gridZ - camZ);
        if (dx > RENDER_DISTANCE + 1 || dz > RENDER_DISTANCE + 1) {
            scene.remove(chunk.group);
            chunk.group.traverse(obj => {
                if (obj.isInstancedMesh) obj.dispose();
                else if (obj.geometry && !obj.userData.shared) obj.geometry.dispose();
                if (obj.material?.map?.dispose && obj.material.map !== grassTexture && obj.material.map !== dashTex) obj.material.map.dispose();
                if (obj.material?.dispose && obj.material !== dashMat && obj.material !== whiteMat) obj.material.dispose();
            });
            if (chunk.physicsBody) physicsWorld.removeRigidBody(chunk.physicsBody);
            loadedChunks.delete(key);
        }
    }
    for (let x = camX - RENDER_DISTANCE; x <= camX + RENDER_DISTANCE; x++)
        for (let z = camZ - RENDER_DISTANCE; z <= camZ + RENDER_DISTANCE; z++) {
            const key = `${x}_${z}`;
            if (!loadedChunks.has(key) && !chunksLoading.has(key) && !chunkQueue.some(c => c.key === key)) chunkQueue.push({ key, gridX: x, gridZ: z });
        }
    chunkQueue.sort((a, b) => Math.max(Math.abs(a.gridX - camX), Math.abs(a.gridZ - camZ)) - Math.max(Math.abs(b.gridX - camX), Math.abs(b.gridZ - camZ)));
    while (chunkQueue.length > 0 && chunksLoading.size < 3) loadChunk(chunkQueue.shift());
}

async function loadChunk(chunkInfo) {
    const { key, gridX, gridZ } = chunkInfo;
    chunksLoading.add(key);
    const worldX = gridX * WORLD_CHUNK_SIZE, worldZ = gridZ * WORLD_CHUNK_SIZE;
    const center = vector3ToLatLon(worldX, worldZ);
    try {
       const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        const response = await fetch(`${API_URL}/api/chunk?lat=${center.lat}&lon=${center.lon}&size=${CHUNK_SIZE}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        const group = new THREE.Group();
        group.position.set(worldX, 0, worldZ);
        const offsetVec = latLonToVector3(center.lat, center.lon);

        const roadEntries = [];
        const instances = [];
        const roadMat = new THREE.MeshStandardMaterial({ color: 0x2C2C34, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });

        data.roads.forEach(r => {
            if (r.geometry.length < 2) return;
            const points3D = r.geometry.map(p => { const v = latLonToVector3(p.lat, p.lon); v.y = 0; return v; });
            const localPts = points3D.map(p => new THREE.Vector3(p.x - offsetVec.x, p.y, p.z - offsetVec.z));
            const width = getRoadWidth(r.tags);
            const tags = r.tags || {};
            const isHighway = tags.highway === 'motorway' || tags.highway === 'trunk' || tags.highway === 'primary';
            splitRoadIntoChunkPolylines(localPts, ROAD_STYLE === 'hop' ? 0 : WORLD_CLIP_PADDING).forEach(polyline => {
                if (ROAD_STYLE === 'hop' || ROAD_STYLE === 'flat') roadEntries.push({ polyline, width, isHighway, tags });
                else { if (roadInfo && roadGeo) collectRoadInstances(polyline, width, instances); else { const m = createRoadMesh(polyline, width, roadMat); if (m) group.add(m); } }
            });
        });

        const physicsBody = buildTerrain(group, roadEntries, worldX, worldZ);

        if (ROAD_STYLE === 'hop') {
            if (!dashTex) makeLineMats();
            const mergedEntries = mergeRoadsSmart(roadEntries);
            const trimmedEntries = trimRoadsAtIntersections(mergedEntries);
            const trimmed = trimmedEntries.map(e => ({ ...e, polyline: decimatePolyline(e.polyline, 6) }));

            const baseCanvas = createBaseCanvas(mergedEntries);
            const bt = new THREE.CanvasTexture(baseCanvas);
            bt.magFilter = THREE.LinearFilter; bt.minFilter = THREE.LinearFilter;
            if ('colorSpace' in bt) bt.colorSpace = THREE.SRGBColorSpace;
            const bg = new THREE.PlaneGeometry(WORLD_CHUNK_SIZE, WORLD_CHUNK_SIZE, 1, 1); bg.rotateX(-Math.PI / 2);
            const bm = new THREE.MeshStandardMaterial({ map: bt, transparent: true, roughness: 0.9 });
            const baseMesh = new THREE.Mesh(bg, bm);
            baseMesh.position.y = 0.1; baseMesh.renderOrder = 1; baseMesh.receiveShadow = true;
            group.add(baseMesh);

            for (const e of trimmed) {
                const w = Math.max(e.width, 4);
                const cR = addRibbon(e.polyline, 0, 0.35, dashMat, 0.16, true); if (cR) group.add(cR);
                const e1 = addRibbon(e.polyline, -(w / 2 - 0.5), 0.22, whiteMat, 0.16, false); if (e1) group.add(e1);
                const e2 = addRibbon(e.polyline, (w / 2 - 0.5), 0.22, whiteMat, 0.16, false); if (e2) group.add(e2);
            }

            const lampData = { matrices: [], heads: [] };
            placeStreetlights(trimmed, lampData);
            addStreetlights(group, lampData);
            group.userData.lampHeads = lampData.heads;
        } else if (ROAD_STYLE === 'flat') {
            if (roadEntries.length) {
                const baseCanvas = createBaseCanvas(roadEntries);
                const bt = new THREE.CanvasTexture(baseCanvas);
                bt.magFilter = THREE.LinearFilter; bt.minFilter = THREE.LinearFilter;
                if ('colorSpace' in bt) bt.colorSpace = THREE.SRGBColorSpace;
                const bg = new THREE.PlaneGeometry(WORLD_CHUNK_SIZE, WORLD_CHUNK_SIZE, 1, 1); bg.rotateX(-Math.PI / 2);
                const bm = new THREE.MeshStandardMaterial({ map: bt, transparent: true, roughness: 0.9 });
                const baseMesh = new THREE.Mesh(bg, bm);
                baseMesh.position.y = 0.1; baseMesh.renderOrder = 1; baseMesh.receiveShadow = true;
                group.add(baseMesh);
            }
        } else if (instances.length) {
            const mat = roadMats.length === 1 ? roadMats[0] : roadMats;
            const im = new THREE.InstancedMesh(roadGeo, mat, instances.length);
            const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
            const roadY = 0.15 * WORLD_SCALE;
            instances.forEach((inst, i) => { Q.setFromAxisAngle(UP, inst.yaw); P.set(inst.x, roadY, inst.z); S.set(inst.scaleX, 1, 1); M.compose(P, Q, S); im.setMatrixAt(i, M); });
            im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
            group.add(im);
        }

        scene.add(group);
        loadedChunks.set(key, { gridX, gridZ, group, physicsBody });
    } catch (error) {
        console.error("Erreur chunk", key, error);
        if (!chunkQueue.some(c => c.key === key)) chunkQueue.push(chunkInfo);
    } finally { chunksLoading.delete(key); }
}

async function startGameAt(lat, lon) {
    baseLat = lat; baseLon = lon;
    loadedChunks.forEach(c => { scene.remove(c.group); if (c.physicsBody) physicsWorld.removeRigidBody(c.physicsBody); });
    loadedChunks.clear(); chunkQueue.length = 0;
    showLoadingOverlay();
    // Charge le chunk central en priorite et attend qu'il soit pret AVANT de
    // positionner la voiture et d'activer le streaming : evite que des chunks
    // plus loins (mais en cache) s'affichent avant celui sous la voiture.
    try { await loadChunk({ key: '0_0', gridX: 0, gridZ: 0 }); } catch (e) { console.error('Chargement chunk central echoue', e); }
    if (chassisBody) {
        const h = spawnGroundHeight(0, 0);
        chassisBody.setTranslation({ x: 0, y: h + 1.0, z: 0 }, true);
        chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        chassisBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    }
    hasStarted = true;
    if (minimap) minimap.setView([baseLat, baseLon], 16, { animate: false });
    hideLoadingOverlay();
    updateChunks();
}
let loadingOverlay = null;
function initLoadingOverlay() {
    loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'chunk-loading-overlay';
    loadingOverlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(13,10,20,0.92);display:none;align-items:center;justify-content:center;flex-direction:column;color:#ffd9a0;font:600 15px monospace;';
    loadingOverlay.innerHTML = `
        <div style="width:44px;height:44px;border:4px solid #f2a65a3a;border-top-color:#f2a65a;border-radius:50%;animation:chunkspin .8s linear infinite;"></div>
        <div style="margin-top:14px;">Chargement du terrain...</div>
        <style>@keyframes chunkspin{to{transform:rotate(360deg)}}</style>
    `;
    document.body.appendChild(loadingOverlay);
}
function showLoadingOverlay() { if (loadingOverlay) loadingOverlay.style.display = 'flex'; }
function hideLoadingOverlay() { if (loadingOverlay) loadingOverlay.style.display = 'none'; }

function resetCarUpright() {
    if (!chassisBody) return;
    const p = chassisBody.translation();
    const h = spawnGroundHeight(p.x, p.z);
    chassisBody.setTranslation({ x: p.x, y: h + 1.0, z: p.z }, true);
    chassisBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
function setupControls() {
    window.addEventListener('keydown', (e) => {
        if (e.target && e.target.tagName === 'INPUT') return;
        if (handleEditorKey(e)) return;
        if (e.code === 'KeyX') { resetCarUpright(); }
        if (e.code === 'Space') { e.preventDefault(); if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur(); }
        if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.up = true;
        if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.down = true;
        if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = true;
        if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = true;
        if (e.code === 'Space') keys.brake = true;
        if (e.code === 'KeyM' && masterRoot) { MIRROR_MODE = MIRROR_MODE === 'auto' ? 'min' : (MIRROR_MODE === 'min' ? 'max' : 'auto'); console.log('Mode miroir :', MIRROR_MODE); rebuildCar(); }
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
    canvas.addEventListener('pointerdown', (e) => { dragging = true; lastPX = e.clientX; lastPY = e.clientY; });
    window.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastPX, dy = e.clientY - lastPY;
        lastPX = e.clientX; lastPY = e.clientY;
        camYawOffset -= dx * 0.005;
        camPitch = THREE.MathUtils.clamp(camPitch + dy * 0.005, 0.05, 1.3);
    });
    window.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('wheel', (e) => { camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.01, 5, 25 * WORLD_SCALE); }, { passive: true });

        const startAudioOnce = () => {
        initEngineAudio();
        window.removeEventListener('keydown', startAudioOnce);
        window.removeEventListener('pointerdown', startAudioOnce);
    };
    window.addEventListener('keydown', startAudioOnce);
    window.addEventListener('pointerdown', startAudioOnce);
}

function updateCarControl(dt) {
    const vel = chassisBody.linvel();
    _fwd.set(0, 0, -1).applyQuaternion(carGroup.quaternion);
    const speed = vel.x * _fwd.x + vel.y * _fwd.y + vel.z * _fwd.z;
    const absSpeed = Math.abs(speed);
    let targetEngine = 0;
    if (keys.up) targetEngine = -ENGINE_FORCE * Math.max(0, 1 - Math.max(speed, 0) / MAX_SPEED);
    else if (keys.down) targetEngine = REVERSE_FORCE * Math.max(0, 1 - Math.max(-speed, 0) / MAX_REVERSE_SPEED);
    currentEngine = THREE.MathUtils.damp(currentEngine, targetEngine, THROTTLE_SMOOTH, dt);
    const targetBrake = keys.brake ? BRAKE_FORCE : 0;
    currentBrake = THREE.MathUtils.damp(currentBrake, targetBrake, BRAKE_SMOOTH, dt);
    const speedFactor = THREE.MathUtils.clamp(absSpeed / STEER_FADE_SPEED, 0, 1);
    let maxSteer = THREE.MathUtils.lerp(STEER_MAX_LOW, STEER_MAX_HIGH, speedFactor);
    maxSteer *= THREE.MathUtils.clamp(absSpeed / 0.5, 0, 1);
    let targetSteer = 0;
    if (keys.left) targetSteer = maxSteer; else if (keys.right) targetSteer = -maxSteer;
    const lambda = targetSteer !== 0 ? STEER_SMOOTH : STEER_CENTER;
    currentSteer = THREE.MathUtils.damp(currentSteer, targetSteer, lambda, dt);
    const motorForce = currentEngine * MS * 0.7;
    for (let i = 0; i < 4; i++) {
        vehicleController.setWheelEngineForce(i, motorForce);
        vehicleController.setWheelBrake(i, i >= 2 ? currentBrake * MS : 0);
    }
    vehicleController.setWheelSteering(0, currentSteer);
    vehicleController.setWheelSteering(1, currentSteer);
}

const _steerQuat = new THREE.Quaternion(), _rollQuat = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
function updateWheelsVisual() {
    for (let i = 0; i < 4; i++) {
        const w = wheelsVis[i]; if (!w) continue;
        const suspension = vehicleController.wheelSuspensionLength(i) || 0;
        const steering = vehicleController.wheelSteering(i) || 0;
        const rotationRad = vehicleController.wheelRotation(i) || 0;
        const axleCs = vehicleController.wheelAxleCs(i);
        if (w.rest0 === null && suspension > 0.01) w.rest0 = suspension;
        const rest0 = w.rest0 !== null ? w.rest0 : SUSPENSION_REST;
        w.node.position.x = w.baseX; w.node.position.z = w.baseZ;
        w.node.position.y = w.designY + (rest0 - suspension);
        _steerQuat.setFromAxisAngle(_up, steering);
        _rollQuat.setFromAxisAngle(new THREE.Vector3(axleCs.x, axleCs.y, axleCs.z), rotationRad);
        w.node.quaternion.multiplyQuaternions(_steerQuat, _rollQuat);
    }
}

const _behind = new THREE.Vector3(), _camTarget = new THREE.Vector3(), _camOffset = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
function updateVehicleAndCamera() {
    if (!vehicleController || !chassisBody || !carGroup) return;
    const dt = 1 / 60;
    updateCarControl(dt);
    vehicleController.updateVehicle(dt);
    const pos = chassisBody.translation(), rot = chassisBody.rotation();
    carGroup.position.set(pos.x, pos.y, pos.z);
    carGroup.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    updateWheelsVisual();
    if (rearMatShared) rearMatShared.emissiveIntensity = (keys.brake || currentBrake > 0.05) ? 5 : 0.7;

    if (dirLight) {
        dirLight.position.set(pos.x - 60, 120, pos.z - 40);
        dirLight.target.position.set(pos.x, 0, pos.z);
        dirLight.target.updateMatrixWorld();
    }

    _behind.set(0, 0, 1).applyQuaternion(carGroup.quaternion); _behind.y = 0;
    if (_behind.lengthSq() < 0.0001) _behind.set(0, 0, 1);
    _behind.normalize(); _behind.applyAxisAngle(_Y, camYawOffset);
    _camTarget.copy(carGroup.position); _camTarget.y += 1.0;
    _camOffset.copy(_behind).multiplyScalar(Math.cos(camPitch) * camDist);
    _camOffset.y = Math.sin(camPitch) * camDist;
    camera.position.lerp(_camTarget.clone().add(_camOffset), 0.25);
    camera.lookAt(_camTarget);
    const velA = chassisBody.linvel();
    updateEngineAudio(Math.min(1, Math.hypot(velA.x, velA.z) / MAX_SPEED), keys.up ? 1 : 0);
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
        const { lat, lon } = vector3ToLatLon(pos.x, pos.z);
        minimap.setView([lat, lon], minimap.getZoom(), { animate: false });
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(carGroup.quaternion);
        const headingDeg = Math.atan2(forward.x, -forward.z) * (180 / Math.PI);
               minimapContainer.style.transform = 'translate(-50%,-50%)';   // carte nord fixe
        if (minimapCarArrow) minimapCarArrow.style.transform = `rotate(${headingDeg}deg)`;
    }
    if (chassisBody) {
        const vel = chassisBody.linvel();
        const kmh = Math.hypot(vel.x, vel.z) * 3.6;
        drawSpeedo(kmh);
    }
    composer.render();
}
let speedoCanvas = null, speedoCtx = null;

function initSpeedo() {
    document.querySelectorAll('#speed, .speed, #speedo-old').forEach(e => e.remove());

    speedoCanvas = document.createElement('canvas');
    speedoCanvas.width = 260; speedoCanvas.height = 260;
    speedoCanvas.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:9990;pointer-events:none;';
    document.body.appendChild(speedoCanvas);
    speedoCtx = speedoCanvas.getContext('2d');
}

function drawSpeedo(kmh) {
    if (!speedoCtx) return;
    const c = speedoCtx, W = speedoCanvas.width, H = speedoCanvas.height;
    const cx = W / 2, cy = H / 2, R = W / 2 - 8;
    c.clearRect(0, 0, W, H);

    const g = c.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
    g.addColorStop(0, '#1a1626'); g.addColorStop(1, '#0d0a14');
    c.fillStyle = g;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
    c.lineWidth = 4; c.strokeStyle = '#f2a65a';
    c.beginPath(); c.arc(cx, cy, R - 2, 0, Math.PI * 2); c.stroke();

    const maxS = 220;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;

    c.strokeStyle = '#e8e0d0'; c.fillStyle = '#e8e0d0';
    c.font = 'bold 15px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let s = 0; s <= maxS; s += 20) {
        const a = a0 + (a1 - a0) * (s / maxS);
        const ca = Math.cos(a), sa = Math.sin(a);
        c.lineWidth = (s % 40 === 0) ? 4 : 2;
        c.beginPath();
        c.moveTo(cx + ca * (R - 8), cy + sa * (R - 8));
        c.lineTo(cx + ca * (R - 20), cy + sa * (R - 20));
        c.stroke();
        if (s % 40 === 0) c.fillText(s, cx + ca * (R - 34), cy + sa * (R - 34));
    }

    c.strokeStyle = '#ff4040'; c.lineWidth = 6;
    c.beginPath(); c.arc(cx, cy, R - 10, a0 + (a1 - a0) * (180 / maxS), a1); c.stroke();

    const t = Math.min(kmh, maxS) / maxS;
    const a = a0 + (a1 - a0) * t;
    c.strokeStyle = '#ff9a3d'; c.lineWidth = 5; c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - Math.cos(a) * 18, cy - Math.sin(a) * 18);
    c.lineTo(cx + Math.cos(a) * (R - 26), cy + Math.sin(a) * (R - 26));
    c.stroke();

    c.fillStyle = '#f2a65a'; c.beginPath(); c.arc(cx, cy, 10, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#0d0a14'; c.beginPath(); c.arc(cx, cy, 5, 0, Math.PI * 2); c.fill();

    c.fillStyle = '#ffd9a0'; c.font = 'bold 26px monospace'; c.textAlign = 'center';
    c.fillText(Math.round(kmh), cx, cy + R * 0.45);
    c.font = 'bold 12px monospace';
    c.fillText('km/h', cx, cy + R * 0.45 + 18);
}
async function main() {
    initThree();
    initMinimap();
    grassTexture = await makeGrassTexture();
    await loadRoadTemplate();
    await initPhysics();
    initEditorHUD();
    initLoadingOverlay();
    setupControls();
    initSpeedo();
           initSettings({ setAmbiance });  // on passe setAmbiance aux settings pour que le select fonctionne
    setEngineVolume(getEngineVolume());  // applique le volume sauvegardé
    initStartMap({
        onStart: (lat, lon) => startGameAt(lat, lon),
        getCurrent: () => {
            const p = chassisBody.translation();
            const { lat, lon } = vector3ToLatLon(p.x, p.z);
            return [lat, lon];
        },
        onCircuit: async (circuitId) => {
            // Lance le circuit directement via race.js
            const { loadCircuitById } = await import('./race.js');
            await loadCircuitById(circuitId);
        }
    });
    initRace({
        spawnAt: async (lat, lon, x, z, qy) => {
    baseLat = lat; baseLon = lon;
    loadedChunks.forEach(c => { scene.remove(c.group); if (c.physicsBody) physicsWorld.removeRigidBody(c.physicsBody); });
    loadedChunks.clear(); chunkQueue.length = 0;
    showLoadingOverlay();
    // Le point de depart d'un circuit n'est pas forcement en (0,0) local : on calcule
    // le bon chunk a partir de x,z (et non 0_0 comme pour startGameAt).
    const centerGX = Math.floor(x / WORLD_CHUNK_SIZE), centerGZ = Math.floor(z / WORLD_CHUNK_SIZE);
    try { await loadChunk({ key: `${centerGX}_${centerGZ}`, gridX: centerGX, gridZ: centerGZ }); } catch (e) { console.error('Chargement chunk central echoue', e); }

    const h = spawnGroundHeight(x, z);
    chassisBody.setTranslation({ x, y: h + 1.0, z }, true);
    const yaw = qy || 0;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    chassisBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

    hasStarted = true;
    if (minimap) minimap.setView([baseLat, baseLon], 16, { animate: false });
    hideLoadingOverlay();
    updateChunks();
},
        getCarPose: () => {
            const p = chassisBody.translation();
            const r = chassisBody.rotation();
            return { x: p.x, y: p.y, z: p.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w };
        },
        getBaseLat: () => baseLat,
        getBaseLon: () => baseLon,
        startAt: (lat, lon) => startGameAt(lat, lon),
        addObj: (o) => scene.add(o),
        removeObj: (o) => scene.remove(o),
        createGhostCar: () => createGhostCar(),
        teleportCar: (x, z, qy = 0) => {
            const h = spawnGroundHeight(x, z);
            chassisBody.setTranslation({ x, y: h + 1.0, z }, true);
            const yaw = qy || 0;
            const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
            chassisBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
            chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        },
    });
    animate();
}
main();