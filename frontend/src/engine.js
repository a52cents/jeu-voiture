// engine.js — moteur synthétisé avec effets de passage de vitesse (v2)
//
// Corrections apportées par rapport à la v1 :
//  1. Hystérésis entre le seuil de montée et le seuil de descente de chaque rapport,
//     pour ne plus redéclencher l'effet de passage de vitesse en boucle si la vitesse
//     oscille près d'une frontière (typiquement pendant un freinage).
//  2. Anti-rebond temporel (MIN_SHIFT_INTERVAL) : l'effet sonore de changement de
//     rapport ne peut pas se redéclencher plus d'une fois toutes les ~180ms, même si
//     plusieurs rapports sont traversés d'un coup lors d'un freinage appuyé — le
//     rapport suivi reste, lui, toujours exact.
//  3. Distinction montée / rétrogradage : une montée de rapport garde la coupure de
//     puissance (débrayage) d'origine ; un rétrogradage (ce qui arrive naturellement
//     en freinant) ne coupe plus le volume — il ajoute juste un petit "blip" de
//     régime, cohérent avec le fait que le régime moteur remonte réellement dans
//     ce cas (frein moteur / rev-matching), au lieu de le contredire.
//  4. Son plus étouffé quand on lève le pied (coasting), pour donner une vraie
//     sensation de frein moteur plutôt qu'un son de moteur toujours "à fond".

let ctx = null, master, osc1, osc2, noise, noiseGain, filter;

let currentGear = 0;
let shiftT = 0;          // 0..1, décroît après un changement de rapport
let shiftDirection = 0;  // -1 = montée de rapport, +1 = rétrogradage
let lastShiftTime = 0;

// Volume général réglable (0..1), modifié par les touches -/+
let masterVolume = 0.5;
import { getEngineVolume as getSettingsEngineVolume } from './settings.js';

const MIN_SHIFT_INTERVAL = 0.18; // secondes, anti-rebond de l'effet sonore

// Seuils de vitesse (0..1) pour monter au rapport suivant.
const GEAR_UP = [0.16, 0.34, 0.55, 0.78, 1.01];
// Seuils de vitesse pour redescendre au rapport précédent — volontairement plus bas
// que le seuil de montée correspondant, pour créer une zone morte (hystérésis).
const GEAR_DOWN = [0.12, 0.28, 0.47, 0.68, 0.92];
const NUM_GEARS = GEAR_UP.length; // 5 rapports (indices 0..4)

export function setEngineVolume(v) { masterVolume = Math.max(0, Math.min(1, v)); }
export function getEngineVolume() { return masterVolume; }

export function initEngineAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);

  osc1 = ctx.createOscillator(); osc1.type = 'sawtooth';
  osc2 = ctx.createOscillator(); osc2.type = 'square';
  filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 400;
  const g1 = ctx.createGain(); g1.gain.value = 0.5;
  const g2 = ctx.createGain(); g2.gain.value = 0.3;
  osc1.connect(g1); g1.connect(filter);
  osc2.connect(g2); g2.connect(filter);
  filter.connect(master);

  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
  const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 200;
  noiseGain = ctx.createGain(); noiseGain.gain.value = 0.04;
  noise.connect(nf); nf.connect(noiseGain); noiseGain.connect(master);

  osc1.start(); osc2.start(); noise.start();
}

// Fait évoluer le rapport courant à partir de la vitesse, avec hystérésis.
// Le rapport suivi (currentGear) est toujours mis à jour immédiatement pour rester
// cohérent avec la vitesse réelle — seul le déclenchement de l'EFFET sonore de
// changement de rapport est soumis à l'anti-rebond temporel.
function updateGear(s, now) {
  let g = currentGear;
  let changed = false;
  let direction = 0;

  // Peut traverser plusieurs seuils d'un coup si la vitesse varie beaucoup entre deux appels.
  while (g < NUM_GEARS - 1 && s >= GEAR_UP[g]) { g++; changed = true; direction = -1; }
  while (g > 0 && s < GEAR_DOWN[g - 1]) { g--; changed = true; direction = 1; }

  if (changed) {
    currentGear = g;
    if (now - lastShiftTime > MIN_SHIFT_INTERVAL) {
      shiftDirection = direction;
      shiftT = 1;
      lastShiftTime = now;
    }
  }
  return currentGear;
}

function gearRange(g) {
  const lo = g === 0 ? 0 : GEAR_UP[g - 1];
  const hi = GEAR_UP[g];
  return { lo, hi };
}

export function updateEngineAudio(speed01, throttle, dt = 1 / 60) {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  const s = Math.max(0, Math.min(1.05, speed01));
  const now = ctx.currentTime;

  const g = updateGear(s, now);
  const { lo, hi } = gearRange(g);
  const frac = Math.max(0, Math.min(1, (s - lo) / (hi - lo)));

  shiftT = Math.max(0, shiftT - dt * 4); // décroît sur ~0.25s, indépendant du framerate

  const rpm = 0.15 + 0.85 * frac;
  const isUpshift = shiftDirection < 0;

  // Montée de rapport : brève coupure de puissance (débrayage) -> fréquence et volume chutent un instant.
  const shiftFreqDrop = isUpshift ? shiftT * 0.35 : 0;
  const shiftGainCut = isUpshift ? shiftT * 0.5 : 0;

  // Rétrogradage : le régime remonte déjà naturellement via `frac` (voir explication en tête de fichier) ;
  // on ajoute juste un petit "blip" de volume au lieu de le couper, cohérent avec un coup de régime réel.
  const shiftBlip = isUpshift ? 0 : shiftT * 0.15;

  const f = (50 + rpm * 260) * (1 - shiftFreqDrop) + throttle * 25;

  osc1.frequency.setTargetAtTime(f, ctx.currentTime, 0.04);
  osc2.frequency.setTargetAtTime(f * 0.5 + 3, ctx.currentTime, 0.04);
  filter.frequency.setTargetAtTime(250 + 1400 * rpm, ctx.currentTime, 0.05);

  // Pied levé (pas d'accélérateur) : son plus étouffé, sensation de frein moteur.
  const coasting = throttle < 0.05 ? 0.6 : 1.0;

      masterVolume = getSettingsEngineVolume();
  const gain = (0.10 + 0.12 * rpm + 0.05 * throttle) * coasting * (1 - shiftGainCut) * (1 + shiftBlip) * masterVolume;
  master.gain.setTargetAtTime(Math.max(0, gain), ctx.currentTime, 0.05);
  noiseGain.gain.setTargetAtTime((0.03 + 0.10 * rpm + shiftT * 0.08) * masterVolume, ctx.currentTime, 0.05);
}