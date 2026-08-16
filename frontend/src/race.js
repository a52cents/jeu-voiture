// src/race.js — Mode course avec ghost, partage de lien, et liaison Firestore
import * as THREE from 'three';
import { saveCircuit, getCircuit, saveGhost, getBestGhost, getTopGhosts } from './firebase.js';
import { getCheckpointVolume } from './settings.js';

let api = null;
let mode = 'idle';
let start = null;
let checkpoints = [];
let finish = null;
let markers = [];
let racing = false;
let nextIdx = 0;
let startTime = 0;
let panel = null;
let dirEl = null;
let raceAudioCtx = null;
// Ghost recording & replay
let ghostTrajectory = [];
let ghostMesh = null;
let ghostData = null;
let ghostTimeOffset = 0;
let currentCircuitId = null;

let arrowHud = null, arrowEl = null, distEl = null;

export function initRace(raceApi) {
    api = raceApi;
    buildUI();
    requestAnimationFrame(tick);
    checkURLParams();
    window.addEventListener('keydown', unlockRaceAudio);
    window.addEventListener('pointerdown', unlockRaceAudio);
}

function q(s) { return panel ? panel.querySelector(s) : null; }

function unlockRaceAudio() {
    if (!raceAudioCtx) raceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    raceAudioCtx.resume();
}
function beep(freq, dur, type = 'sine', baseGain = 0.25, when = 0) {
    const gain = baseGain * getCheckpointVolume();
    if (!raceAudioCtx) return;
    const t = raceAudioCtx.currentTime + when;
    const o = raceAudioCtx.createOscillator(), g = raceAudioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(raceAudioCtx.destination);
    o.start(t); o.stop(t + dur + 0.05);
}
function playCheckpointSound() { beep(880, 0.15); beep(1320, 0.2, 'sine', 0.2, 0.09); }
function playFinishSound() { beep(660, 0.15); beep(880, 0.15, 'sine', 0.25, 0.12); beep(1100, 0.3, 'sine', 0.25, 0.24); }

function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
        #race-panel{position:fixed;left:10px;top:60px;z-index:9990;display:flex;flex-direction:column;gap:6px;
            background:rgba(20,15,10,.85);border:1px solid #f2a65a;border-radius:8px;padding:10px;}
        #race-panel button{padding:6px 10px;border:none;border-radius:6px;background:#f2a65a;color:#241d38;font:700 12px monospace;cursor:pointer;}
        #race-panel button:disabled{opacity:.35;cursor:not-allowed;}
        #race-status{color:#ffd9a0;font:12px monospace;max-width:230px;}
        #race-leaderboard{color:#ffd9a0;font:11px monospace;max-width:230px;white-space:pre;}
    `;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'race-panel';
    panel.innerHTML = `
        <button id="race-create">🏁 Départ ici</button>
        <button id="race-cp" disabled>➕ Checkpoint ici</button>
        <button id="race-finish" disabled>🏁 Arrivée ici</button>
        <button id="race-go" disabled>▶ Lancer la course</button>
        <button id="race-publish" disabled style="display:none;">📤 Publier le circuit</button>
        <button id="race-copy-link" disabled style="display:none;">🔗 Copier le lien</button>
        <button id="race-clear">✖ Effacer</button>
        <div id="race-status">Mode course : place un départ.</div>
        <div id="race-leaderboard"></div>
    `;
    document.body.appendChild(panel);

    q('#race-create').onclick = () => {
        clearMarkers();
        removeGhostMesh();
        currentCircuitId = null;
        ghostData = null;
        start = api.getCarPose();
        addMarker(start, 0x44dd66);
        checkpoints = []; finish = null; racing = false; mode = 'placing';
        q('#race-publish').style.display = 'none';
        q('#race-copy-link').style.display = 'none';
        q('#race-leaderboard').textContent = '';
        setButtons(); setStatus('Départ placé. Place des checkpoints puis l\'arrivée.');
    };
    q('#race-cp').onclick = () => {
        const p = api.getCarPose();
        checkpoints.push(p);
        addMarker(p, 0xffa500);
        setStatus(`Checkpoint ${checkpoints.length} placé.`);
        setButtons();
    };
    q('#race-finish').onclick = () => {
        finish = api.getCarPose();
        addMarker(finish, 0xff4040);
        mode = 'ready'; setButtons();
        setStatus('Arrivée placée. Lance la course !');
    };
    q('#race-go').onclick = async () => {
        // Créer le ghost mesh seulement maintenant (au lancement de la course)
        if (ghostData && !ghostMesh) {
            createGhostMesh();
        }
        
        if (start) api.teleportCar(start.x, start.z, start.qy);
        
        ghostTrajectory = [];
        racing = true; nextIdx = 0; startTime = performance.now();
        ghostTimeOffset = performance.now();
        mode = 'racing'; setButtons();
        
        if (ghostData) {
            setStatus('GO ! Le fantôme est devant toi !');
        } else {
            setStatus('GO ! Pas de ghost à battre — cours pour en créer un !');
        }
    };
    q('#race-publish').onclick = async () => {
        try {
            setStatus('Publication en cours...');
            const circuitId = await saveCircuit({
                nom: 'Circuit personnalisé',
                data: { baseLat: api.getBaseLat(), baseLon: api.getBaseLon(), start, checkpoints, finish }
            });
            currentCircuitId = circuitId;
            const url = new URL(window.location.href);
            url.searchParams.set('circuit', circuitId);
            url.searchParams.delete('ghost');
            window.history.pushState({}, '', url);
            q('#race-copy-link').style.display = 'block';
            q('#race-copy-link').disabled = false;
            setStatus(`✅ Circuit publié ! ID : ${circuitId.slice(0, 8)}...`);
            
            // Charger le best ghost (si existe) pour la prochaine course
            await loadBestGhost(circuitId);
            await loadLeaderboard(circuitId);
        } catch (e) {
            console.error('Erreur publication', e);
            setStatus('❌ Erreur de publication');
        }
    };
    q('#race-copy-link').onclick = () => {
        navigator.clipboard.writeText(window.location.href);
        setStatus('📋 Lien copié !');
    };
    q('#race-clear').onclick = () => {
        clearMarkers();
        removeGhostMesh();
        start = null; checkpoints = []; finish = null; racing = false; mode = 'idle';
        ghostData = null; currentCircuitId = null;
        q('#race-publish').style.display = 'none';
        q('#race-copy-link').style.display = 'none';
        q('#race-leaderboard').textContent = '';
        setButtons(); setStatus('Mode course : place un départ.');
    };
    setButtons();
    arrowHud = document.createElement('div');
    arrowHud.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9990;text-align:center;pointer-events:none;';
    arrowHud.innerHTML = `
        <svg id="race-arrow" viewBox="0 0 24 24" width="56" height="56" style="display:block;margin:0 auto;filter:drop-shadow(0 0 4px #000);">
            <path d="M12 1.5 L20 22 L12 17.5 L4 22 Z" fill="#ffd9a0"/>
        </svg>
        <div id="race-dir" style="color:#ffd9a0;font:700 13px monospace;text-shadow:0 0 6px #000;"></div>
        <div id="race-dist" style="color:#ffd9a0;font:700 15px monospace;text-shadow:0 0 6px #000;"></div>`;
    document.body.appendChild(arrowHud);
    arrowEl = arrowHud.querySelector('#race-arrow');
    dirEl = arrowHud.querySelector('#race-dir');
    distEl = arrowHud.querySelector('#race-dist');
}

function updateArrow() {
    if (!arrowHud) return;
    let target = null;
    if (racing) target = (nextIdx < checkpoints.length) ? checkpoints[nextIdx] : finish;
    else if (mode === 'ready') target = start;
    if (!target) { arrowHud.style.display = 'none'; return; }
    arrowHud.style.display = 'block';

    const p = api.getCarPose();
    const dx = target.x - p.x, dz = target.z - p.z;
    const dist = Math.hypot(dx, dz);
    const q = new THREE.Quaternion(p.qx, p.qy, p.qz, p.qw);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const carH = Math.atan2(fwd.x, -fwd.z);
    const tH = Math.atan2(dx, -dz);
    let rel = tH - carH;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    const deg = rel * 180 / Math.PI;

    arrowEl.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    const ad = Math.abs(deg);
    dirEl.textContent = ad < 35 ? 'TOUT DROIT' : ad > 145 ? 'DEMI-TOUR' : (deg > 0 ? 'À DROITE' : 'À GAUCHE');
    distEl.textContent = `${Math.round(dist / 2)} m`;
}

function setButtons() {
    if (!panel) return;
    q('#race-create').disabled = false;
    q('#race-cp').disabled = !(mode === 'placing');
    q('#race-finish').disabled = !(mode === 'placing' && !!start);
    q('#race-go').disabled = !(mode === 'ready');
    q('#race-clear').disabled = false;
    q('#race-publish').disabled = !(mode === 'ready');
    if (mode === 'ready') q('#race-publish').style.display = 'block';
}
function setStatus(t) { const el = q('#race-status'); if (el) el.textContent = t; }

function addMarker(p, color) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(5.2, 6, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    );
    ring.position.y = 0.3;
    const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 6, 8),
        new THREE.MeshBasicMaterial({ color })
    );
    beacon.position.y = 3;
    g.add(ring); g.add(beacon);
    g.position.set(p.x, 0, p.z);
    api.addObj(g);
    markers.push(g);
}
function clearMarkers() {
    markers.forEach(m => {
        m.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        api.removeObj(m);
    });
    markers = [];
}

function createGhostMesh() {
    removeGhostMesh();
    if (api.createGhostCar) {
        ghostMesh = api.createGhostCar();
        ghostMesh.userData.isGhostCar = true;
    } else {
        const geo = new THREE.BoxGeometry(2, 1, 4);
        const mat = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.5 });
        ghostMesh = new THREE.Mesh(geo, mat);
    }
    api.addObj(ghostMesh);
}
function removeGhostMesh() {
    if (ghostMesh) {
        api.removeObj(ghostMesh);
        if (!ghostMesh.userData.isGhostCar) {
            ghostMesh.geometry.dispose();
            ghostMesh.material.dispose();
        }
        ghostMesh = null;
    }
}

function interpolateGhost(t) {
    if (!ghostData || ghostData.length < 2) return null;
    let i = 0;
    while (i < ghostData.length - 1 && ghostData[i + 1].t < t) i++;
    if (i >= ghostData.length - 1) return ghostData[ghostData.length - 1];
    const a = ghostData[i], b = ghostData[i + 1];
    const f = (t - a.t) / (b.t - a.t);
    return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        qx: a.qx + (b.qx - a.qx) * f,
        qy: a.qy + (b.qy - a.qy) * f,
        qz: a.qz + (b.qz - a.qz) * f,
        qw: a.qw + (b.qw - a.qw) * f
    };
}

async function loadBestGhost(circuitId) {
    try {
        const best = await getBestGhost(circuitId);
        if (best && best.trajectoire && best.trajectoire.length > 2) {
            ghostData = best.trajectoire;
            // NE PAS créer le mesh ici — juste stocker les données
            setStatus(`👻 Ghost à battre : ${best.pseudo} — ${(best.temps_ms / 1000).toFixed(2)}s`);
            return true;
        } else {
            ghostData = null;
            removeGhostMesh();
            return false;
        }
    } catch (e) {
        console.error('Erreur loadBestGhost', e);
        return false;
    }
}

const RACE_RADIUS = 8;
function tick() {
    requestAnimationFrame(tick);
    updateArrow();
    if (racing) {
        const now = performance.now();
        const t = now - startTime;
        if (ghostTrajectory.length === 0 || t - ghostTrajectory[ghostTrajectory.length - 1].t > 100) {
            const pose = api.getCarPose();
            ghostTrajectory.push({
                t, x: pose.x, y: pose.y, z: pose.z,
                qx: pose.qx, qy: pose.qy, qz: pose.qz, qw: pose.qw
            });
        }
    }
    
    if (ghostData && ghostMesh && racing) {
        const t = performance.now() - ghostTimeOffset;
        const pos = interpolateGhost(t);
        if (pos) {
            ghostMesh.position.set(pos.x, pos.y, pos.z);
            ghostMesh.quaternion.set(pos.qx, pos.qy, pos.qz, pos.qw);
        }
    }
    
    if (!racing) return;
    const p = api.getCarPose();
    const target = (nextIdx < checkpoints.length) ? checkpoints[nextIdx] : finish;
    const d = Math.hypot(p.x - target.x, p.z - target.z);
    const elapsed = (performance.now() - startTime) / 1000;
    if (d < RACE_RADIUS) {
        if (nextIdx < checkpoints.length) {
            playCheckpointSound();
            nextIdx++;
            setStatus(`Checkpoint ${nextIdx}/${checkpoints.length} ✓  ${elapsed.toFixed(1)}s`);
        } else {
            racing = false; mode = 'ready';
            const tempsMs = Math.round(elapsed * 1000);
            removeGhostMesh();
            playFinishSound();
            setButtons();
            
            if (currentCircuitId && ghostTrajectory.length > 10) {
                const pseudo = prompt(`🏁 ARRIVÉE ! Temps : ${elapsed.toFixed(2)}s\n\nTon pseudo (max 20 caractères) :`) || 'Anonyme';
                setStatus('💾 Sauvegarde du ghost...');
                saveGhost({ circuitId: currentCircuitId, pseudo, tempsMs, trajectoire: ghostTrajectory })
                    .then(async () => {
                        setStatus(`🏁 ${elapsed.toFixed(2)}s ✅ Ghost sauvegardé !`);
                        await loadLeaderboard(currentCircuitId);
                        await loadBestGhost(currentCircuitId);
                    })
                    .catch(e => {
                        console.error('Erreur sauvegarde ghost', e);
                        setStatus('❌ Erreur sauvegarde ghost');
                    });
            } else {
                setStatus(`🏁 ARRIVÉE ! Temps : ${elapsed.toFixed(2)}s`);
            }
        }
    } else {
        const label = (nextIdx < checkpoints.length) ? `CP ${nextIdx + 1}/${checkpoints.length}` : 'ARRIVÉE';
        const ghostTxt = ghostData ? ' 👻' : '';
        setStatus(`${label} → ${d.toFixed(0)}m   ⏱ ${elapsed.toFixed(1)}s${ghostTxt}`);
    }
}

async function loadLeaderboard(circuitId) {
    try {
        const top = await getTopGhosts(circuitId, 5);
        const el = q('#race-leaderboard');
        if (!el) return;
        if (top.length > 0) {
            let txt = '🏆 Top 5 :\n';
            top.forEach((g, i) => {
                txt += `${i + 1}. ${g.pseudo} — ${(g.temps_ms / 1000).toFixed(2)}s\n`;
            });
            el.textContent = txt;
        } else {
            el.textContent = 'Aucun ghost enregistré.';
        }
    } catch (e) {
        console.error('Erreur leaderboard', e);
    }
}

/**
 * Charge et lance un circuit depuis son ID Firestore.
 * Utilisé à la fois par l'URL (?circuit=xxx) et par la liste d'accueil.
 * Retourne true si succès, false sinon.
 */
export async function loadCircuitById(circuitId) {
    if (!circuitId) return false;
    if (!api) {
        console.error('loadCircuitById : race non initialisé');
        return false;
    }
    
    try {
        setStatus('Chargement du circuit...');
        const circuit = await getCircuit(circuitId);
        if (!circuit) {
            setStatus('❌ Circuit introuvable');
            return false;
        }
        
        const { baseLat, baseLon, start: s, checkpoints: cp, finish: f } = circuit.data;
        
        // Un seul spawn direct à la position de départ (pas de double téléport)
        const qy = (s && s.qy !== undefined) ? s.qy : 0;
        if (api.spawnAt) {
            api.spawnAt(baseLat, baseLon, s.x, s.z, qy);
        } else {
            // Fallback si spawnAt n'existe pas
            api.startAt(baseLat, baseLon);
            setTimeout(() => api.teleportCar(s.x, s.z, qy), 100);
        }
        
        clearMarkers();
        removeGhostMesh();
        
        start = s;
        checkpoints = cp || [];
        finish = f;
        currentCircuitId = circuitId;
        
        addMarker(start, 0x44dd66);
        checkpoints.forEach(p => addMarker(p, 0xffa500));
        if (finish) addMarker(finish, 0xff4040);
        
        mode = 'ready';
        setButtons();
        setStatus(`✅ Circuit chargé ! ID : ${circuitId.slice(0, 8)}...`);
        
        // Charger ghost + leaderboard en arrière-plan (sans bloquer)
        loadBestGhost(circuitId).then(() => loadLeaderboard(circuitId));
        
        return true;
    } catch (e) {
        console.error('Erreur chargement circuit', e);
        setStatus('❌ Erreur de chargement');
        return false;
    }
}

async function loadCircuitFromURL() {
    const params = new URLSearchParams(window.location.search);
    const circuitId = params.get('circuit');
    if (!circuitId) return;
    await loadCircuitById(circuitId);
}

function checkURLParams() {
    setTimeout(loadCircuitFromURL, 1000);
}