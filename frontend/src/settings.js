// settings.js — gestion des paramètres utilisateur avec UI

let settingsPanel = null;
let settingsOpen = false;
let engineVolumeSlider = null;
let checkpointVolumeSlider = null;
let ambianceSelect = null;
let onAmbianceChange = null;

const DEFAULT_SETTINGS = {
    engineVolume: 0.5,
    checkpointVolume: 0.5,
    ambiance: 'golden'
};

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('psx_game_settings') || '{}');
        settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) {
        settings = { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    localStorage.setItem('psx_game_settings', JSON.stringify(settings));
}

export function getEngineVolume() { return settings.engineVolume; }
export function getCheckpointVolume() { return settings.checkpointVolume; }
export function getAmbianceSetting() { return settings.ambiance; }

export function setEngineVolume(v) {
    settings.engineVolume = Math.max(0, Math.min(1, v));
    saveSettings();
    if (engineVolumeSlider) engineVolumeSlider.value = Math.round(settings.engineVolume * 100);
}

export function setCheckpointVolume(v) {
    settings.checkpointVolume = Math.max(0, Math.min(1, v));
    saveSettings();
    if (checkpointVolumeSlider) checkpointVolumeSlider.value = Math.round(settings.checkpointVolume * 100);
}

export function setAmbianceSetting(v) {
    settings.ambiance = v;
    saveSettings();
    if (ambianceSelect) ambianceSelect.value = v;
    if (onAmbianceChange) onAmbianceChange(v);
}

export function initSettings({ setAmbiance }) {
    onAmbianceChange = setAmbiance;
    loadSettings();
    buildSettingsUI();
}

function buildSettingsUI() {
    const style = document.createElement('style');
    style.textContent = `
        #settings-btn{position:fixed;bottom:20px;left:20px;z-index:9990;padding:8px 14px;border:none;border-radius:6px;
            background:#f2a65a;color:#241d38;font:700 13px monospace;cursor:pointer;}
        #settings-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;
            background:rgba(20,15,10,.95);border:2px solid #f2a65a;border-radius:10px;padding:20px;display:none;min-width:340px;}
        #settings-panel h2{color:#ffd9a0;font:700 18px monospace;margin:0 0 15px 0;text-align:center;}
        .settings-row{display:flex;align-items:center;gap:10px;margin:10px 0;}
        .settings-row label{color:#ffd9a0;font:12px monospace;min-width:130px;}
        .settings-row input[type=range]{flex:1;}
        .settings-row select{flex:1;padding:4px;background:#241d38;color:#ffd9a0;border:1px solid #f2a65a;
            border-radius:4px;font:12px monospace;}
        .settings-row span{color:#ffd9a0;font:12px monospace;min-width:40px;text-align:right;}
        #settings-close{margin-top:15px;width:100%;padding:8px;border:none;border-radius:6px;
            background:#f2a65a;color:#241d38;font:700 13px monospace;cursor:pointer;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'settings-btn';
    btn.textContent = '⚙ Paramètres';
    btn.onclick = () => { settingsPanel.style.display = settingsOpen ? 'none' : 'block'; settingsOpen = !settingsOpen; };
    document.body.appendChild(btn);

    settingsPanel = document.createElement('div');
    settingsPanel.id = 'settings-panel';
    settingsPanel.innerHTML = `
        <h2>⚙ Paramètres</h2>
        <div class="settings-row">
            <label>🎨 Ambiance</label>
            <select id="ambiance-sel">
                <option value="golden">🌅 Golden hour</option>
                <option value="overcast">🌫 Overcast nordique</option>
                <option value="coastal">🌊 Coastal dusk</option>
                <option value="night">🌙 Nuit urbaine</option>
            </select>
        </div>
        <div class="settings-row">
            <label>🔊 Volume moteur</label>
            <input type="range" min="0" max="100" value="${Math.round(settings.engineVolume * 100)}" id="engine-vol"/>
            <span id="engine-vol-val">${Math.round(settings.engineVolume * 100)}%</span>
        </div>
        <div class="settings-row">
            <label>🔔 Volume checkpoints</label>
            <input type="range" min="0" max="100" value="${Math.round(settings.checkpointVolume * 100)}" id="cp-vol"/>
            <span id="cp-vol-val">${Math.round(settings.checkpointVolume * 100)}%</span>
        </div>
        <button id="settings-close">Fermer</button>
    `;
    document.body.appendChild(settingsPanel);

    ambianceSelect = settingsPanel.querySelector('#ambiance-sel');
    ambianceSelect.value = settings.ambiance;
    ambianceSelect.onchange = () => setAmbianceSetting(ambianceSelect.value);

    engineVolumeSlider = settingsPanel.querySelector('#engine-vol');
    checkpointVolumeSlider = settingsPanel.querySelector('#cp-vol');
    const engineVal = settingsPanel.querySelector('#engine-vol-val');
    const cpVal = settingsPanel.querySelector('#cp-vol-val');

    engineVolumeSlider.oninput = () => {
        setEngineVolume(engineVolumeSlider.value / 100);
        engineVal.textContent = engineVolumeSlider.value + '%';
    };

    checkpointVolumeSlider.oninput = () => {
        setCheckpointVolume(checkpointVolumeSlider.value / 100);
        cpVal.textContent = checkpointVolumeSlider.value + '%';
    };

    settingsPanel.querySelector('#settings-close').onclick = () => {
        settingsPanel.style.display = 'none';
        settingsOpen = false;
    };
}