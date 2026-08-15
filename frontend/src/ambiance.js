// ambiance.js — gestion des 4 ambiances de la roadmap (LUT-like via paramètres)

let refs = null;
let currentAmbiance = 'night';

// Les 4 palettes exactes de la roadmap
const AMBIENCES = {
    golden: {
        label: '🌅 Golden hour',
        skyTop: 0x7B6FA8,
        skyBottom: 0xF2A65A,
        fog: 0xE8B98A,
        fogNear: 200,
        fogFar: 1200,
        ambient: { color: 0x7B6FA8, intensity: 0.4 },
        sun: { color: 0xFFB870, intensity: 1.5, pos: [-60, 120, -40] },
        shadow: true,
        lampIntensity: 2.5,
        lampColor: 0xffd9a0,
        lampGlowOpacity: 0.6,
        bloom: 0.3,
    },
    overcast: {
        label: '🌫 Overcast nordique',
        skyTop: 0xB8C4C2,
        skyBottom: 0xB8C4C2,   // ciel plat uniforme
        fog: 0xA9B8B5,
        fogNear: 150,
        fogFar: 800,           // brouillard dense
        ambient: { color: 0xC8D2CE, intensity: 0.9 },
        sun: { color: 0xC8D2CE, intensity: 0.6, pos: [-30, 200, -30] },  // lumière diffuse haute
        shadow: false,         // pas d'ombres dures
        lampIntensity: 1.8,
        lampColor: 0xffd9a0,
        lampGlowOpacity: 0.5,
        bloom: 0.1,
    },
    coastal: {
        label: '🌊 Coastal dusk',
        skyTop: 0x2D3A63,
        skyBottom: 0xE8825A,
        fog: 0xD87A5A,
        fogNear: 200,
        fogFar: 1100,
        ambient: { color: 0x6B4A5A, intensity: 0.5 },
        sun: { color: 0xFF9F68, intensity: 1.6, pos: [-100, 60, -40] },  // soleil très bas
        shadow: true,
        lampIntensity: 3.2,
        lampColor: 0xffb870,
        lampGlowOpacity: 0.75,
        bloom: 0.45,
    },
    night: {
        label: '🌙 Nuit urbaine',
        skyTop: 0x0A0C1A,
        skyBottom: 0x1B1F3B,
        fog: 0x0a0e1e,
        fogNear: 120,
        fogFar: 700,
        ambient: { color: 0x2E3A5C, intensity: 0.5 },
        sun: { color: 0x8a94c8, intensity: 0.35, pos: [-60, 120, -40] }, // lune faible
        shadow: true,
        lampIntensity: 4.0,
        lampColor: 0xFFA94D,    // sodium
        lampGlowOpacity: 1.0,
        bloom: 0.85,            // bloom marqué sur les lampadaires
    }
};

export function initAmbiance(apiRefs) {
    refs = apiRefs;
    // charge l'ambiance sauvegardée
    try {
        const saved = JSON.parse(localStorage.getItem('psx_game_settings') || '{}');
        if (saved.ambiance && AMBIENCES[saved.ambiance]) {
            currentAmbiance = saved.ambiance;
        }
    } catch (e) {}
    setAmbiance(currentAmbiance, false);
}

export function getAmbiance() { return currentAmbiance; }
export function getAmbianceList() {
    return Object.entries(AMBIENCES).map(([k, v]) => ({ key: k, label: v.label }));
}

export function setAmbiance(name, persist = true) {
    if (!AMBIENCES[name] || !refs) return;
    currentAmbiance = name;
    const a = AMBIENCES[name];

    // Sauvegarde
    if (persist) {
        try {
            const saved = JSON.parse(localStorage.getItem('psx_game_settings') || '{}');
            saved.ambiance = name;
            localStorage.setItem('psx_game_settings', JSON.stringify(saved));
        } catch (e) {}
    }

    // Ciel
    if (refs.skyMatRef) {
        refs.skyMatRef.uniforms.topColor.value.set(a.skyTop);
        refs.skyMatRef.uniforms.bottomColor.value.set(a.skyBottom);
    }
    // Brouillard
    if (refs.scene) {
        refs.scene.fog.color.set(a.fog);
        refs.scene.fog.near = a.fogNear * 2;   // WORLD_SCALE
        refs.scene.fog.far = a.fogFar * 2;
    }
    // Lumières
    if (refs.ambientLight) {
        refs.ambientLight.color.set(a.ambient.color);
        refs.ambientLight.intensity = a.ambient.intensity;
    }
    if (refs.dirLight) {
        refs.dirLight.color.set(a.sun.color);
        refs.dirLight.intensity = a.sun.intensity;
        refs.dirLight.position.set(...a.sun.pos);
    }
    // Ombres dures ON/OFF (overcast = pas d'ombres dures)
    if (refs.renderer) {
        refs.renderer.shadowMap.enabled = a.shadow;
        if (refs.dirLight) refs.dirLight.castShadow = a.shadow;
    }
    // Lampadaires
    refs.lampHeadMats.forEach(m => {
        m.emissive.set(a.lampColor);
        m.emissiveIntensity = a.lampIntensity;
    });
    refs.lampGlowMats.forEach(m => {
        m.color.set(a.lampColor);
        m.opacity = a.lampGlowOpacity;
    });
    // Bloom
    if (refs.bloomEffect) {
        refs.bloomEffect.intensity = a.bloom;
    }
}