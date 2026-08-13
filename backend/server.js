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
const CHUNK_CACHE_VERSION = 'v3'; // CORRECTION POINT 3 : Passage à v3 pour invalider le cache
const USER_AGENT = 'JeuVoitureNavigateur/1.0 (prototype real-road driving)';

// Dossiers de cache
const CACHE_DIR = path.join(__dirname, 'cache');
const CHUNK_CACHE_DIR = path.join(CACHE_DIR, 'chunks');
const DEM_CACHE_DIR = path.join(CACHE_DIR, 'dem');

if (!fs.existsSync(CHUNK_CACHE_DIR)) fs.mkdirSync(CHUNK_CACHE_DIR, { recursive: true });
if (!fs.existsSync(DEM_CACHE_DIR)) fs.mkdirSync(DEM_CACHE_DIR, { recursive: true });

app.use(cors());

// --- LOGIQUE DEM COPTERNICUS ---
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

  // Si la tuile est déjà en mémoire, on l'utilise
  if (demCache.has(flatName)) return demCache.get(flatName);

  let buffer;
  try {
    if (fs.existsSync(tilePath)) {
      console.log(`[DEM] Lecture disque: ${flatName}`);
      buffer = fs.readFileSync(tilePath);
    } else {
      console.log(`[DEM] Téléchargement S3: ${flatName} (~50Mo)`);
      const url = `https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/${tileName}`;
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      buffer = Buffer.from(response.data);
      fs.writeFileSync(tilePath, buffer); // Sauvegarde sur disque pour les prochains démarrages
    }

    // Conversion du Buffer en ArrayBuffer pour geotiff
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const rasters = await image.readRasters();
    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] -> [minLon, minLat, maxLon, maxLat]

    const tileData = {
      width: image.getWidth(),
      height: image.getHeight(),
      data: rasters[0], // Bande 1 (Float32)
      minLon: bbox[0],
      maxLon: bbox[2],
      minLat: bbox[1],
      maxLat: bbox[3]
    };

    demCache.set(flatName, tileData);
    return tileData;
  } catch (err) {
    console.error(`[DEM] Erreur de chargement pour ${flatName}:`, err.message);
    demCache.set(flatName, null);
    return null;
  }
}

function sampleElevation(tile, lat, lon) {
  if (!tile) return 0;
  if (lon < tile.minLon || lon > tile.maxLon || lat < tile.minLat || lat > tile.maxLat) return 0;

  const x = Math.min(tile.width - 1, Math.max(0, Math.floor((lon - tile.minLon) / (tile.maxLon - tile.minLon) * tile.width)));
  const y = Math.min(tile.height - 1, Math.max(0, Math.floor((tile.maxLat - lat) / (tile.maxLat - tile.minLat) * tile.height)));
  
  const idx = y * tile.width + x;
  const elevation = tile.data[idx];
  
  return isNaN(elevation) ? 0 : elevation;
}

async function getElevation(lat, lon) {
  const tile = await getDemTile(lat, lon);
  return sampleElevation(tile, lat, lon);
}

async function addElevationsToGeometry(geometry) {
  const sampleCache = new Map();

  for (const point of geometry) {
    const key = `${point.lat.toFixed(6)}_${point.lon.toFixed(6)}`;
    if (!sampleCache.has(key)) {
      sampleCache.set(key, await getElevation(point.lat, point.lon));
    }
    point.elevation = sampleCache.get(key);
  }
}

function isDrivableRoad(tags = {}) {
  const excludedHighways = new Set([
    'bridleway',
    'bus_stop',
    'construction',
    'corridor',
    'cycleway',
    'elevator',
    'footway',
    'path',
    'pedestrian',
    'platform',
    'proposed',
    'raceway',
    'steps'
  ]);

  if (!tags.highway || excludedHighways.has(tags.highway)) return false;
  if (tags.area === 'yes') return false;
  if (tags.access === 'no' || tags.motor_vehicle === 'no' || tags.vehicle === 'no') return false;
  return true;
}

function shouldIncludeBuilding(tags = {}) {
  if (!tags.building) return false;
  if (tags.location === 'underground') return false;
  if (tags.level && parseFloat(tags.level) < 0) return false;
  return true;
}

// --- LOGIQUE OVERPASS AVEC RETRIES ET THROTTLING ---
let lastOverpassCall = 0;
const OVERPASS_DELAY = 1000; // 1 seconde minimum entre les requêtes

async function fetchOverpassWithRetries(query) {
  let attempts = 0;
  const maxAttempts = 3;
  
  while (attempts < maxAttempts) {
    const now = Date.now();
    const timeSinceLast = now - lastOverpassCall;
    if (timeSinceLast < OVERPASS_DELAY) {
      await new Promise(r => setTimeout(r, OVERPASS_DELAY - timeSinceLast));
    }
    
    try {
      lastOverpassCall = Date.now();
      console.log(`[Overpass] Requête envoyée (Tentative ${attempts + 1}/${maxAttempts})...`);
      
      const response = await axios.post('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT }
      });
      
      return response.data;
    } catch (error) {
      console.error(`[Overpass] Erreur (Tentative ${attempts + 1}):`, error.message);
      const isRateLimited = error.response && error.response.status === 429;
      const retryAfterHeader = error.response && error.response.headers['retry-after'];
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader) * 1000 : 1000 * Math.pow(2, attempts);
      
      if (isRateLimited) console.warn(`[Overpass] Rate limited. Attente de ${retryAfter}ms.`);
      if (attempts === maxAttempts - 1) throw new Error("Échec Overpass après nombre maximum de tentatives");
      
      await new Promise(r => setTimeout(r, retryAfter));
      attempts++;
    }
  }
}

// --- ENDPOINTS ---

// Proxy pour Nominatim (Géocodage)
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query manquante' });

  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { format: 'json', q: q, limit: 1 },
      headers: { 'User-Agent': USER_AGENT }
    });

    if (response.data && response.data.length > 0) {
      const result = response.data[0];
      res.json({ lat: parseFloat(result.lat), lon: parseFloat(result.lon), display_name: result.display_name });
    } else {
      res.status(404).json({ error: 'Adresse introuvable' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erreur Nominatim' });
  }
});

// Endpoint pour générer un chunk (Overpass API + DEM)
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
  const bbox = `${latNum - deltaLat},${lonNum - deltaLon},${latNum + deltaLat},${lonNum + deltaLon}`;

  const query = `
    [out:json][timeout:25];
    (
      way["highway"](${bbox});
      way["building"](${bbox});
    );
    out geom;
  `;

  try {
    const overpassData = await fetchOverpassWithRetries(query);

    const roads = [];
    const buildings = [];
    let rawWaysCount = 0;

    for (const el of overpassData.elements) {
      if (el.type === 'way' && el.geometry) {
        rawWaysCount++;
        for (const point of el.geometry) {
          point.elevation = await getElevation(point.lat, point.lon);
        }

        // CORRECTION POINT 3 : Utilisation des fonctions de filtrage dédiées
        if (shouldIncludeBuilding(el.tags)) {
          buildings.push({ id: el.id, tags: el.tags, geometry: el.geometry });
        } else if (isDrivableRoad(el.tags)) {
          roads.push({ id: el.id, tags: el.tags, geometry: el.geometry });
        }
      }
    }

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
      buildings,
      terrain: { heights: terrainHeights, segments: segments }
    };

    fs.writeFileSync(cacheFilePath, JSON.stringify(result));
    console.log(`[Chunk] Généré: ${roads.length} routes, ${buildings.length} bâtiments (filtrés parmi ${rawWaysCount} ways OSM bruts)`);
    res.json(result);
  } catch (error) {
    console.error("[Chunk] Erreur finale:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend démarré sur http://localhost:${PORT}`);
});