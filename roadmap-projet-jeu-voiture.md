# Jeu de conduite navigateur — roadmap de référence

## Vision

Un jeu de conduite jouable dans le navigateur, sans téléchargement, construit sur des données géographiques ouvertes (OpenStreetMap + modèles d'élévation open data). Deux piliers : un monde libre où on tape une adresse et on roule autour, et un mode Défi compétitif (circuits sur de vraies routes, chrono, ghost, classement) pensé pour être montrable et partageable — vidéo YouTube, liens de défi, classement mondial.

## Décisions actées

- **Rendu / physique** : three.js pour le rendu, Rapier (WASM) pour la physique — vehicle controller raycast intégré, plus performant que cannon-es pour ce cas d'usage.
- **Données routes** : OpenStreetMap (licence ODbL, gratuite, pas de restriction sur le fait d'en faire un jeu).
- **Données élévation** : DEM ouverts — Copernicus DEM (global, 30m) pour démarrer, IGN RGE ALTI en complément pour la France (résolution plus fine).
- **Géocodage adresse → coordonnées** : Nominatim (OSM), pas l'API Google Geocoding — cohérent avec le reste de la stack, gratuit, pas de CGU restrictives.
- **On n'utilise pas les Google Photorealistic 3D Tiles** : CGU l'interdisent explicitement pour ce cas d'usage (pas d'extraction de géodonnées/collision à partir de leurs tuiles), et le maillage brut est de toute façon mauvais pour la physique.
- **Classement / ghosts** : Supabase (Postgres + Storage + Edge Functions) — rapide à mettre en place, pas besoin de gérer un backend d'auth/DB from scratch.
- **Ordre de build** : monde libre PC d'abord, puis mode Défi, puis Défi du jour + classement, puis mobile.
- **Bâtiments** : extrusion générique des empreintes OSM (standard "Simple 3D Buildings" — footprint + tag `building:levels`/`height`, toit plat par défaut). Même pipeline que les routes, aucune dépendance supplémentaire.
- **Style visuel** : low-poly assumé, couleurs plates, pas de texture photo. Cohérent avec ce que permet l'extrusion OSM, plus rapide à produire solo, et vieillit mieux visuellement qu'un pseudo-réalisme raté.

## Hors scope v1 (pour ne pas dériver)

- Pas de multijoueur live synchronisé (websockets, courses en temps réel façon Hop.Earth) — le "lien de défi" est **asynchrone** : on court contre un ghost enregistré, pas contre quelqu'un en direct. Beaucoup plus simple, et suffisant pour l'effet compétitif.
- Pas de garage / personnalisation de véhicule.
- Pas de monde libre sur mobile (trop coûteux en génération temps réel — voir Phase 4).
- Pas de comptes utilisateurs avec auth complète — juste un pseudo au moment de soumettre un score.
- Pas de modèles 3D faits main pour les monuments (Tour Eiffel, etc.) — extrusion générique OSM uniquement, partout, y compris sur les monuments connus. Assumé et volontaire : évite un travail de modélisation au cas par cas.

---

## Direction artistique & post-processing

**Référence assumée : Art of Rally.** La preuve que le low-poly peut avoir un rendu premium — ce n'est pas la géométrie qui fait le "propre", c'est l'éclairage, la couleur et le post-processing par-dessus.

- **Librairie** : `postprocessing` (pmndrs), pas l'`EffectComposer` de base de three.js — plus performant (fusion automatique des passes en moins d'appels de rendu), compatible WebGL2 large (important vu qu'on vise le mobile en Phase 4). Three.js a bien une nouvelle stack node-based basée WebGPU (`RenderPipeline`, ex-`PostProcessing`, depuis r183), mais le support navigateur WebGPU n'est pas encore assez large sur mobile pour en faire notre base — à garder en veille pour plus tard.
- **Effets prioritaires** :
  - Bloom sélectif (seuil de luminance, pas un bloom global — sinon tout baigne dans le flou)
  - Color grading via LUT (texture de lookup) — permet de changer l'ambiance (aube, golden hour, nuit) juste en changeant de LUT, sans retoucher les shaders
  - Anti-aliasing SMAA/FXAA — **essentiel en low-poly**, des arêtes nettes sont ce qui distingue un style assumé d'un rendu qui a l'air cassé
  - Brouillard de distance — ambiance ET ça masque le pop-in des chunks qui arrivent (risque déjà identifié plus bas)
  - Vignette léger
  - Éclairage dynamique biaisé golden hour (soleil bas, tons chauds) plutôt qu'un midday plat
- **Nice-to-have (si le temps le permet)** : légère aberration chromatique à haute vitesse, pour accentuer la sensation de vitesse
- **UI/HUD** : minimaliste, cohérent avec le style — pas de HUD chargé, quelques éléments propres (vitesse, chrono) plutôt qu'une interface de simulation complète
- **Mobile (Phase 4)** : stack d'effets allégée — on garde bloom + vignette + color grading (peu coûteux), on retire SSAO/effets plus lourds si besoin selon les perfs observées

### Palettes & ambiances de référence

Contrairement à Art of Rally (environnements écrits à la main par pays), notre monde est généré procéduralement n'importe où sur Terre — impossible de designer une biome par région sans exploser le scope. On applique donc des **ambiances lumière/heure du jour universelles**, pilotées par LUT, plutôt que des biomes géographiques. Ajouter une ambiance plus tard ne coûte presque rien (juste une nouvelle LUT) — peut aussi servir à varier visuellement le Défi du jour sans travail de géométrie.

**Golden hour** (ambiance par défaut, celle qui vend le jeu en vidéo)
Ciel horizon `#F2A65A` → zénith `#7B6FA8` · lumière clé `#FFB870` · ombres `#4A5A78` (bleu froid, complémentaire) · végétation `#7A8C4E` / reflets `#C9A961` · brouillard léger `#E8B98A`

**Overcast nordique** (routes en forêt, ambiance calme)
Ciel plat désaturé `#B8C4C2` · lumière diffuse `#C8D2CE`, pas d'ombres dures · pins profonds `#35473C` · brouillard dense au loin `#A9B8B5`

**Coastal dusk / méditerranéen** (routes côtières, golden hour dramatique)
Ciel horizon `#E8825A` → zénith bleu profond `#2D3A63` · lumière clé `#FF9F68` · garrigue `#8B9152` · bâtiments terracotta `#C97B4C`

**Nuit urbaine** (variante pour circuits en ville)
Ciel `#1B1F3B` → `#0A0C1A` · lampadaires sodium `#FFA94D` avec bloom marqué · ambiante bleu-violet froide `#2E3A5C` · silhouettes de bâtiments `#14161F`, fenêtres éclairées ponctuelles

---

## Phase 1 — Monde libre PC (priorité)

**Objectif** : taper une adresse, arriver dessus, rouler sur un rayon qui se charge au fur et à mesure.

- Geocoding via Nominatim → point central (lat/lon)
- Service backend (Node) qui découpe la zone en chunks et sert, par chunk : la géométrie de route (extraite d'un extrait OSM local ou via Overpass API, convertie en ruban 3D avec largeur selon les tags `highway`/`lanes`) + la hauteur de terrain (échantillonnage du DEM) + les bâtiments (empreintes `building=*` extrudées selon `building:levels`/`height`, hauteur par défaut si le tag est absent)
- Chargement initial : rayon ~2-3 km autour du point. Au-delà, streaming des chunks suivants pendant que le joueur roule, déchargement des chunks derrière lui (comme un moteur open-world classique) — évite un temps de chargement énorme sur un "vrai" rayon de 10-15 km d'un coup
- Rendu three.js avec LOD (moins de détail loin de la caméra)
- Physique Rapier : la voiture colle à la route via un test de projection sur la spline (bande de largeur connue), sinon suit la heightmap du terrain
- Contrôleur voiture + caméra 3e personne
- Pipeline de post-processing (bloom sélectif, color grading LUT, SMAA, brouillard, vignette) + éclairage golden hour

**Pas besoin de Supabase à ce stade** — cette phase est 100% génération procédurale, aucune donnée à persister.

## Phase 2 — Mode Défi + ghost + lien de défi

**Objectif** : circuits sur de vraies routes, chronométrés, avec un fantôme à battre et un lien à partager.

- Réutiliser le pipeline de génération de la Phase 1, mais en offline/one-shot : on génère le mesh d'un circuit précis une fois, on l'exporte en asset statique (glTF). Plus de génération à la volée = ça tourne bien même sur des machines modestes.
- Pool de circuits curés à la main au départ (5-10 routes réelles visuellement intéressantes et bien cartographiées dans OSM) plutôt que génération aléatoire pure — garantit la qualité pour la vidéo
- Système de checkpoints + chrono
- Enregistrement du ghost : on stocke la position/rotation de la voiture à intervalle régulier pendant le run, on rejoue cette trajectoire pour le meilleur temps
- Lien de défi : URL avec l'ID du circuit (+ éventuellement l'ID du ghost à battre en priorité)
- **Supabase entre en jeu ici** : table `ghosts` pour stocker les meilleurs temps + la trajectoire enregistrée par circuit

## Phase 3 — Défi du jour + classement mondial

**Objectif** : un circuit qui change chaque jour, classement mondial, pseudo à la fin du run.

- Rotation quotidienne : sélection déterministe dans le pool de circuits curés (basée sur la date, pas besoin de logique serveur complexe)
- Table Supabase `daily_scores` : `date`, `circuit_id`, `pseudo`, `temps`, `ghost_data`
- Écriture des scores **via une Edge Function Supabase**, pas en insertion directe depuis le client — ça permet un garde-fou anti-triche basique côté serveur (rejeter un temps physiquement impossible vu la longueur du circuit et une vitesse plafond plausible). Pas un système anti-cheat robuste, juste un filtre grossier pour éviter un classement pollué dès le lancement.
- UI classement (top 10/50/100 + position du joueur)

## Phase 4 — Mobile

**Objectif** : rendre jouable sur téléphone.

- Uniquement le **mode Défi / Défi du jour** — les circuits pré-bakés de la Phase 2 sont des assets statiques légers, pas de génération temps réel, donc ça passe sur mobile contrairement au monde libre
- Contrôles tactiles : joystick virtuel + option pilotage à l'inclinaison (gyroscope)
- Ajustement qualité selon l'appareil (distance de dessin réduite, textures allégées)

---

## Schéma Supabase (proposition de départ)

```
table ghosts
  id uuid pk
  circuit_id text
  pseudo text
  temps_ms integer
  trajectoire jsonb (ou lien vers Supabase Storage si trop volumineux)
  created_at timestamp

table daily_scores
  id uuid pk
  date date
  circuit_id text
  pseudo text
  temps_ms integer
  ghost_id uuid fk -> ghosts
  created_at timestamp
```

Écritures via Edge Function uniquement (validation du temps avant insert), lecture publique en direct depuis le client pour l'affichage du classement.

## Points de vigilance

- **Attribution obligatoire** : "Map data © OpenStreetMap contributors" doit apparaître quelque part dans l'UI (exigence de la licence ODbL)
- **Qualité OSM variable selon la zone** : certaines régions sont mal cartographiées — d'où le choix d'un pool curé plutôt que 100% aléatoire pour le mode Défi
- **Performance du streaming en Phase 1** : c'est la brique la plus risquée techniquement, à prototyper en premier avant de construire le reste dessus
- **Hauteur des bâtiments souvent absente dans OSM** : beaucoup de bâtiments n'ont ni `height` ni `building:levels` — prévoir une hauteur par défaut raisonnable (avec un peu de variation aléatoire) pour éviter un skyline plat et uniforme
