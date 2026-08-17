import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fromArrayBuffer } from 'geotiff';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;
const CHUNK_CACHE_VERSION = 'v5'; // <<< bump pour invalider le cache (version routes-only)
const USER_AGENT = 'JeuVoitureNavigateur/1.0 (prototype real-road driving)';

const CACHE_DIR = path.join(__dirname, 'cache');
const CHUNK_CACHE_DIR = path.join(CACHE_DIR, 'chunks');
const DEM_CACHE_DIR = path.join(CACHE_DIR, 'dem');

if (!fs.existsSync(CHUNK_CACHE_DIR)) fs.mkdirSync(CHUNK_CACHE_DIR, { recursive: true });
if (!fs.existsSync(DEM_CACHE_DIR)) fs.mkdirSync(DEM_CACHE_DIR, { recursive: true });

app.use(cors());

// --- DEM COPERNICUS ---
const demCache = new Map();

function getDemTileName(lat, lon) {
  const latFloor = Math.floor(lat);
  const lonFloor = Math.floor(lon);
  const latStr = (latFloor >= 0 ? 'N' : 'S') + Math.abs(latFloor).toString().padStart(2, '0');
  const lonStr = (lonFloor >= 0 ? 'E' : 'W') + Math.abs(lonFloor).toString().padStart(3, '0');
  const tileId = `Copernicus_DSM_COG_10_${latStr}_00_${lonStr}_00_DEM`;
  return `${tileId}/${tileId}.tif`;
}

async function getDemTile(lat, lon) {
  const tileName = getDemTileName(lat, lon);
  const flatName = tileName.replace(/\//g, '_');
  const tilePath = path.join(DEM_CACHE_DIR, flatName);
  if (demCache.has(flatName)) return demCache.get(flatName);

  let buffer;
  try {
    if (fs.existsSync(tilePath)) {
      buffer = fs.readFileSync(tilePath);
    } else {
      console.log(`[DEM] Téléchargement S3: ${flatName} (~50Mo)`);
      const url = `https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/${tileName}`;
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      buffer = Buffer.from(response.data);
      fs.writeFileSync(tilePath, buffer);
    }

    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const rasters = await image.readRasters();
    const bbox = image.getBoundingBox();

    const tileData = {
      width: image.getWidth(),
      height: image.getHeight(),
      data: rasters[0],
      minLon: bbox[0], maxLon: bbox[2],
      minLat: bbox[1], maxLat: bbox[3]
    };
    demCache.set(flatName, tileData);
    return tileData;
  } catch (err) {
    console.error(`[DEM] Erreur pour ${flatName}:`, err.message);
    demCache.set(flatName, null);
    return null;
  }
}

function sampleElevation(tile, lat, lon) {
  if (!tile) return 0;
  if (lon < tile.minLon || lon > tile.maxLon || lat < tile.minLat || lat > tile.maxLat) return 0;
  const x = Math.min(tile.width - 1, Math.max(0, Math.floor((lon - tile.minLon) / (tile.maxLon - tile.minLon) * tile.width)));
  const y = Math.min(tile.height - 1, Math.max(0, Math.floor((tile.maxLat - lat) / (tile.maxLat - tile.minLat) * tile.height)));
  const elevation = tile.data[y * tile.width + x];
  return isNaN(elevation) ? 0 : elevation;
}

async function getElevation(lat, lon) {
  const tile = await getDemTile(lat, lon);
  return sampleElevation(tile, lat, lon);
}

function isDrivableRoad(tags = {}) {
  const excludedHighways = new Set([
    'bridleway', 'bus_stop', 'construction', 'corridor', 'cycleway', 'elevator',
    'footway', 'path', 'pedestrian', 'platform', 'proposed', 'raceway', 'steps'
  ]);
  if (!tags.highway || excludedHighways.has(tags.highway)) return false;
  if (tags.area === 'yes') return false;
  if (tags.access === 'no' || tags.motor_vehicle === 'no' || tags.vehicle === 'no') return false;
  return true;
}

// ============================================================
// OVERPASS : requêtes routes uniquement + rotation de miroirs
// ============================================================
// --- OVERPASS : miroirs + mémoire du serveur qui marche ---
let lastOverpassCall = 0;
const OVERPASS_DELAY = 800; // 0.8s entre requêtes (était 1.5-2s)

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];
let preferredEndpoint = 0; // <<< mémoire du dernier miroir qui a marché

async function fetchOverpassWithRetries(query) {
  // Commence TOUJOURS par le miroir préféré, puis les autres en secours
  const order = [
    preferredEndpoint,
    ...OVERPASS_ENDPOINTS.map((_, i) => i).filter(i => i !== preferredEndpoint)
  ];

  for (let attempt = 0; attempt < order.length; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[order[attempt]];

    // Reservation atomique du creneau AVANT le premier await : sinon plusieurs
    // requetes concurrentes (nos 3 chunks en parallele) lisent lastOverpassCall
    // en meme temps, calculent le meme "wait", et repartent toutes ensemble.
    const now = Date.now();
    const slot = Math.max(now, lastOverpassCall + OVERPASS_DELAY);
    lastOverpassCall = slot;
    const wait = slot - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    try {
      const t0 = Date.now();
      const response = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000 // <<< 20s max par tentative (était 45s)
      });
      if (!response.data?.elements) throw new Error('Réponse invalide');

      preferredEndpoint = order[attempt]; // <<< mémorise le gagnant
      console.log(`[Overpass] OK ${endpoint} (${Date.now() - t0}ms)`);
      return response.data;
    } catch (e) {
      console.warn(`[Overpass] ${endpoint} échec: ${e.message} → miroir suivant`);
    }
  }
  throw new Error('Échec Overpass sur tous les miroirs');
}

// --- ENDPOINTS ---
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query manquante' });
  console.log('[Geocode] Requête reçue :', q); // <<< log d'entrée

  // 1) Nominatim avec timeout 8s (plus de hang infini)
  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { format: 'json', q, limit: 1 },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 8000
    });
    if (response.data?.length > 0) {
      const r = response.data[0];
      console.log('[Geocode] OK via Nominatim');
      return res.json({ lat: parseFloat(r.lat), lon: parseFloat(r.lon), display_name: r.display_name });
    }
  } catch (e) {
    console.warn('[Geocode] Nominatim échec:', e.message);
  }

  // 2) Fallback Photon (komoot.io) avec timeout 8s
  try {
    const response = await axios.get('https://photon.komoot.io/api/', {
      params: { q, limit: 1 },
      timeout: 8000
    });
    const f = response.data?.features?.[0];
    if (f) {
      const [lon, lat] = f.geometry.coordinates;
      console.log('[Geocode] OK via Photon (fallback)');
      return res.json({ lat, lon, display_name: f.properties?.name || q });
    }
  } catch (e) {
    console.warn('[Geocode] Photon échec:', e.message);
  }

  res.status(404).json({ error: 'Adresse introuvable' });
});

// Endpoint chunk : routes OSM uniquement + DEM terrain
app.get('/api/chunk', async (req, res) => {
  const { lat, lon, size = 500 } = req.query;
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  if (isNaN(latNum) || isNaN(lonNum)) return res.status(400).json({ error: 'Coordonnées invalides' });

  const cacheKey = `${CHUNK_CACHE_VERSION}_${latNum.toFixed(4)}_${lonNum.toFixed(4)}_${size}`;
  const cacheFilePath = path.join(CHUNK_CACHE_DIR, `${cacheKey}.json`);
  if (fs.existsSync(cacheFilePath)) {
    console.log(`[Cache] Hit disque pour ${cacheKey}`);
    return res.json(JSON.parse(fs.readFileSync(cacheFilePath, 'utf8')));
  }

  const deltaLat = (size / 2) / 111320;
  const deltaLon = (size / 2) / (111320 * Math.cos(latNum * Math.PI / 180));
  const latMin = latNum - deltaLat, latMax = latNum + deltaLat;
  const lonMin = lonNum - deltaLon, lonMax = lonNum + deltaLon;
  const bboxOsm = `${latMin},${lonMin},${latMax},${lonMax}`;

  // Requête Overpass SIMPLIFIÉE : uniquement les routes (pas de bâtiments)
  const query = `
    [out:json][timeout:30];
    way["highway"](${bboxOsm});
    out geom;
  `;

  try {
    const overpassData = await fetchOverpassWithRetries(query);

    const roads = [];
    let rawWaysCount = 0;

    for (const el of overpassData.elements) {
      if (el.type === 'way' && el.geometry) {
        rawWaysCount++;
        if (isDrivableRoad(el.tags)) {
          for (const point of el.geometry) {
            point.elevation = await getElevation(point.lat, point.lon);
          }
          roads.push({ id: el.id, tags: el.tags, geometry: el.geometry });
        }
      }
    }

    // Terrain (grille d'élévations)
    const terrainHeights = [];
    const segments = 20;
    for (let iy = 0; iy <= segments; iy++) {
      for (let ix = 0; ix <= segments; ix++) {
        const px = (ix / segments) * size - (size / 2);
        const pz = (iy / segments) * size - (size / 2);
        const gridLat = latNum - (pz / 111320);
        const gridLon = lonNum + (px / (111320 * Math.cos(latNum * Math.PI / 180)));
        terrainHeights.push(await getElevation(gridLat, gridLon));
      }
    }

    const result = {
      center: { lat: latNum, lon: lonNum },
      roads,
      terrain: { heights: terrainHeights, segments }
    };

    fs.writeFileSync(cacheFilePath, JSON.stringify(result));
    console.log(`[Chunk] ${cacheKey} : ${roads.length} routes`);
    res.json(result);
    
  } catch (error) {
    console.error("[Chunk] Erreur finale:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend démarré sur http://localhost:${PORT}`);
  console.log(`Mode: routes uniquement (sans bâtiments)`);
});