import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
const PORT = 3001;

app.use(cors());

// Cache basique en mémoire pour éviter de spammer Overpass pendant les tests
const chunkCache = new Map();

// Proxy pour Nominatim (Géocodage)
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query manquante' });

  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { format: 'json', q: q, limit: 1 },
      headers: { 'User-Agent': 'JeuVoitureNavigateur/1.0 (prototype phase 1)' }
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

// Endpoint pour générer un chunk (Overpass API)
app.get('/api/chunk', async (req, res) => {
  const { lat, lon, size = 500 } = req.query; // size en mètres
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  if (isNaN(latNum) || isNaN(lonNum)) return res.status(400).json({ error: 'Coordonnées invalides' });

  const cacheKey = `${latNum.toFixed(4)}_${lonNum.toFixed(4)}_${size}`;
  if (chunkCache.has(cacheKey)) {
    console.log("Cache hit pour", cacheKey);
    return res.json(chunkCache.get(cacheKey));
  }

  // Calcul de la bounding box (approximation)
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
    console.log("Requête Overpass envoyée...");
    const response = await axios.post('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'JeuVoitureNavigateur/1.0 (prototype phase 1)' }
    });

    const roads = [];
    const buildings = [];

    response.data.elements.forEach(el => {
      if (el.type === 'way' && el.geometry) {
        if (el.tags && el.tags.building) {
          buildings.push({ id: el.id, tags: el.tags, geometry: el.geometry });
        } else if (el.tags && el.tags.highway) {
          // On filtre les routes piétonnes trop petites pour une voiture
          const exclude = ['footway', 'path', 'pedestrian', 'steps'];
          if (!exclude.includes(el.tags.highway)) {
            roads.push({ id: el.id, tags: el.tags, geometry: el.geometry });
          }
        }
      }
    });

    const result = { center: { lat: latNum, lon: lonNum }, roads, buildings };
    chunkCache.set(cacheKey, result);
    
    console.log(`Chunk généré: ${roads.length} routes, ${buildings.length} bâtiments`);
    res.json(result);
  } catch (error) {
    console.error("Erreur Overpass:", error.message);
    res.status(500).json({ error: 'Erreur Overpass API' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend démarré sur http://localhost:${PORT}`);
});