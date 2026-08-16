// startmap.js — écran d'accueil / téléportation via Leaflet + liste des circuits
import { getAllCircuits } from './firebase.js';

let map = null, marker = null, chosen = null;
let onStartCb = null, getCurrentCb = null, onCircuitCb = null;
let overlay = null, goBtn = null, circuitsListEl = null;

export function initStartMap({ onStart, getCurrent, onCircuit }) {
    onStartCb = onStart;
    getCurrentCb = getCurrent;
    onCircuitCb = onCircuit;
    buildDOM();

    map = window.L.map('start-map', { zoomControl: true }).setView([48.8566, 2.3522], 13);

    // --- 3 fonds de carte au choix ---
    const plan = window.L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap © CARTO', maxZoom: 20
    });
    const osm = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 19
    });
    const sat = window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri', maxZoom: 19
    });

    plan.addTo(map);

    window.L.control.layers(
        { 'Plan (Google-like)': plan, 'OSM détaillé': osm, 'Satellite': sat },
        null,
        { collapsed: false }
    ).addTo(map);

    map.on('click', e => setPoint(e.latlng.lat, e.latlng.lng));

    document.getElementById('start-search-btn').addEventListener('click', doSearch);
    document.getElementById('start-search-input').addEventListener('keypress', e => { if (e.key === 'Enter') doSearch(); });

    goBtn = document.getElementById('start-go');
    goBtn.addEventListener('click', () => {
        if (chosen) { hideStartMap(); onStartCb(chosen.lat, chosen.lon); }
    });

    document.getElementById('open-map-btn').addEventListener('click', () => {
        const cur = getCurrentCb ? getCurrentCb() : null;
        if (cur) openStartMap(cur[0], cur[1]); else openStartMap();
    });

    // N'ouvre PAS l'écran de sélection si on arrive via un lien de défi
    const hasCircuit = new URLSearchParams(window.location.search).get('circuit');
    if (!hasCircuit) openStartMap();
}

function buildDOM() {
    const style = document.createElement('style');
    style.textContent = `
        #start-overlay{position:fixed;inset:0;background:rgba(10,8,20,.92);z-index:10000;display:none;align-items:center;justify-content:center;}
        #start-panel{width:min(1100px,95vw);height:min(680px,92vh);display:grid;grid-template-columns:280px 1fr;grid-template-rows:auto 1fr auto;gap:10px;background:#171325;border:2px solid #f2a65a;border-radius:10px;padding:14px;}
        #start-panel h1{grid-column:1 / -1;color:#ffd9a0;font:700 20px monospace;margin:0;text-align:center;letter-spacing:2px;}
        #start-circuits{display:flex;flex-direction:column;gap:6px;border:1px solid #3a2f4d;border-radius:8px;padding:10px;background:#1f1a2e;overflow-y:auto;}
        #start-circuits h2{color:#f2a65a;font:700 13px monospace;margin:0 0 6px 0;letter-spacing:1px;}
        #start-circuits-list{display:flex;flex-direction:column;gap:6px;}
        .circuit-item{padding:8px 10px;border:1px solid #3a2f4d;border-radius:6px;background:#241d38;cursor:pointer;transition:all .15s;}
        .circuit-item:hover{background:#302842;border-color:#f2a65a;}
        .circuit-name{color:#ffd9a0;font:700 13px monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .circuit-meta{color:#b8a080;font:11px monospace;margin-top:2px;}
        .circuit-empty{color:#8a7a60;font:12px monospace;font-style:italic;padding:10px 0;}
        #start-right{display:flex;flex-direction:column;gap:10px;min-width:0;}
        #start-searchbar{display:flex;gap:8px;}
        #start-search-input{flex:1;padding:8px;border-radius:6px;border:1px solid #f2a65a;background:#241d38;color:#fff;font:14px monospace;}
        #start-search-btn{padding:8px 16px;border:none;border-radius:6px;background:#f2a65a;color:#241d38;font:700 14px monospace;cursor:pointer;}
        #start-map{flex:1;border-radius:8px;min-height:300px;}
        #start-bottom{grid-column:1 / -1;display:flex;justify-content:space-between;align-items:center;gap:10px;}
        #start-attribution{color:#6a5a48;font:10px monospace;}
        #start-attribution a{color:#8a7a60;text-decoration:none;}
        #start-go{padding:10px 20px;border:none;border-radius:6px;background:#7ee081;color:#123;font:700 16px monospace;cursor:pointer;}
        #start-go:disabled{opacity:.4;cursor:not-allowed;}
        #open-map-btn{position:fixed;top:10px;right:10px;z-index:9990;padding:8px 14px;border:none;border-radius:6px;background:#f2a65a;color:#241d38;font:700 13px monospace;cursor:pointer;}
    `;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'start-overlay';
    overlay.innerHTML = `
        <div id="start-panel">
            <h1>🗺 CHOISIS TA DESTINATION</h1>
            <div id="start-circuits">
                <h2>🏁 CIRCUITS</h2>
                <div id="start-circuits-list">
                    <div class="circuit-empty">Chargement...</div>
                </div>
            </div>
            <div id="start-right">
                <div id="start-searchbar">
                    <input id="start-search-input" type="text" placeholder="Rechercher une adresse puis Go..." />
                    <button id="start-search-btn">Go</button>
                </div>
                <div id="start-map"></div>
            </div>
            <div id="start-bottom">
                <div id="start-attribution">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors</div>
                <button id="start-go" disabled>▶ JOUER ICI</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    circuitsListEl = document.getElementById('start-circuits-list');

    const openBtn = document.createElement('button');
    openBtn.id = 'open-map-btn';
    openBtn.textContent = '🗺 Carte';
    document.body.appendChild(openBtn);
}

function setPoint(lat, lon) {
    chosen = { lat, lon };
    if (!marker) {
        marker = window.L.marker([lat, lon], { draggable: true }).addTo(map);
        marker.on('dragend', () => { const p = marker.getLatLng(); chosen = { lat: p.lat, lon: p.lng }; });
    } else marker.setLatLng([lat, lon]);
    goBtn.disabled = false;
}

async function doSearch() {
    const q = document.getElementById('start-search-input').value.trim();
    if (!q) return;
    try {
        const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        const r = await fetch(`${API_URL}/api/geocode?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        if (r.ok) { map.setView([d.lat, d.lon], 16); setPoint(d.lat, d.lon); }
        else alert('Adresse introuvable');
    } catch (e) { alert('Erreur backend'); }
}

/**
 * Charge la liste des circuits depuis Firestore et les affiche dans le panneau.
 */
async function loadCircuits() {
    if (!circuitsListEl) return;
    circuitsListEl.innerHTML = '<div class="circuit-empty">Chargement...</div>';
    try {
        const circuits = await getAllCircuits(30);
        if (!circuits.length) {
            circuitsListEl.innerHTML = '<div class="circuit-empty">Aucun circuit publié.<br>Crée-en un en jeu !</div>';
            return;
        }

        // Récupère les meilleurs temps pour les circuits qui n'ont pas le champ denormalisé
        const { getBestTime } = await import('./firebase.js');
        await Promise.all(circuits.map(async (c) => {
            if (c.best_temps_ms == null) {
                const best = await getBestTime(c.id);
                if (best) {
                    c.best_temps_ms = best.temps_ms;
                    c.best_pseudo = best.pseudo;
                }
            }
        }));

        circuitsListEl.innerHTML = '';
        circuits.forEach(c => {
            const item = document.createElement('div');
            item.className = 'circuit-item';
            const hasBest = c.best_temps_ms != null;
            const bestTxt = hasBest
                ? `🏆 ${(c.best_temps_ms / 1000).toFixed(2)}s · ${c.best_pseudo || '?'}`
                : 'Pas encore de record';
            const checkpoints = (c.data && c.data.checkpoints) ? c.data.checkpoints.length : 0;
            item.innerHTML = `
                <div class="circuit-name">${c.nom || 'Circuit sans nom'}</div>
                <div class="circuit-meta">${checkpoints} CP · ${bestTxt}</div>
            `;
            item.onclick = () => {
                if (onCircuitCb) {
                    hideStartMap();
                    onCircuitCb(c.id);
                }
            };
            circuitsListEl.appendChild(item);
        });
    } catch (e) {
        console.error('Erreur chargement circuits', e);
        circuitsListEl.innerHTML = '<div class="circuit-empty">Erreur de chargement.</div>';
    }
}

export function openStartMap(lat, lon) {
    const hasCircuit = new URLSearchParams(window.location.search).get('circuit');
    if (hasCircuit) {
        console.log('openStartMap bloqué : lien de défi actif');
        return;
    }
    
    overlay.style.display = 'flex';
    if (lat != null) { map.setView([lat, lon], 16); setPoint(lat, lon); }
    setTimeout(() => map.invalidateSize(), 50);
    loadCircuits();  // recharge la liste à chaque ouverture
}
export function hideStartMap() { overlay.style.display = 'none'; }