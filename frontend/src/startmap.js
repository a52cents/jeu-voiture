// startmap.js — écran d'accueil / téléportation via Leaflet
let map = null, marker = null, chosen = null;
let onStartCb = null, getCurrentCb = null;
let overlay = null, goBtn = null;

export function initStartMap({ onStart, getCurrent }) {
    onStartCb = onStart;
    getCurrentCb = getCurrent;
    buildDOM();

       map = window.L.map('start-map', { zoomControl: true }).setView([48.8566, 2.3522], 13);

    // --- 3 fonds de carte au choix ---
    const plan = window.L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap © CARTO', maxZoom: 20
    }); // style Google Maps : couleurs propres + noms de rues/villes
    const osm = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 19
    }); // OSM standard : le plus détaillé (toutes les rues + noms)
    const sat = window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri', maxZoom: 19
    }); // satellite

    plan.addTo(map); // fond par défaut = style Google Maps

    // Sélecteur de calques (en haut à droite)
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
        #start-panel{width:min(900px,92vw);height:min(640px,90vh);display:flex;flex-direction:column;gap:10px;background:#171325;border:2px solid #f2a65a;border-radius:10px;padding:14px;}
        #start-panel h1{color:#ffd9a0;font:700 20px monospace;margin:0;text-align:center;letter-spacing:2px;}
        #start-searchbar{display:flex;gap:8px;}
        #start-search-input{flex:1;padding:8px;border-radius:6px;border:1px solid #f2a65a;background:#241d38;color:#fff;font:14px monospace;}
        #start-search-btn{padding:8px 16px;border:none;border-radius:6px;background:#f2a65a;color:#241d38;font:700 14px monospace;cursor:pointer;}
        #start-map{flex:1;border-radius:8px;}
        #start-go{padding:10px;border:none;border-radius:6px;background:#7ee081;color:#123;font:700 16px monospace;cursor:pointer;}
        #start-go:disabled{opacity:.4;cursor:not-allowed;}
        #open-map-btn{position:fixed;top:10px;right:10px;z-index:9990;padding:8px 14px;border:none;border-radius:6px;background:#f2a65a;color:#241d38;font:700 13px monospace;cursor:pointer;}
    `;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'start-overlay';
    overlay.innerHTML = `
        <div id="start-panel">
            <h1>🗺 CHOISIS TA DESTINATION</h1>
            <div id="start-searchbar">
                <input id="start-search-input" type="text" placeholder="Rechercher une adresse puis Go..." />
                <button id="start-search-btn">Go</button>
            </div>
            <div id="start-map"></div>
            <button id="start-go" disabled>▶ JOUER ICI</button>
        </div>`;
    document.body.appendChild(overlay);

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

export function openStartMap(lat, lon) {
    // Sécurité : ne jamais ouvrir si on est sur un lien de défi
    const hasCircuit = new URLSearchParams(window.location.search).get('circuit');
    if (hasCircuit) {
        console.log('openStartMap bloqué : lien de défi actif');
        return;
    }
    
    overlay.style.display = 'flex';
    if (lat != null) { map.setView([lat, lon], 16); setPoint(lat, lon); }
    setTimeout(() => map.invalidateSize(), 50);
}
export function hideStartMap() { overlay.style.display = 'none'; }