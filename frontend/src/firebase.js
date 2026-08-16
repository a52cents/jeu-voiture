// src/firebase.js — client Firebase Firestore pour ghosts, circuits, scores
import { initializeApp } from 'firebase/app';
import {
    getFirestore, collection, addDoc, getDoc, getDocs, doc, query,
    orderBy, limit, where, serverTimestamp, updateDoc
} from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyCgZKwN3ZF8SFiBbxAY5HVJ1KVwDBLuTmc",
    authDomain: "earthcarysk.firebaseapp.com",
    projectId: "earthcarysk",
    storageBucket: "earthcarysk.firebasestorage.app",
    messagingSenderId: "261372819914",
    appId: "1:261372819914:web:8f11f77acb7d7bbd59b733",
    measurementId: "G-14GBBD95E7"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ============ CIRCUITS ============

/**
 * Sauvegarde un circuit (baseLat, baseLon, start, checkpoints, finish).
 * Retourne l'ID du document créé (pour construire le lien de défi).
 */
export async function saveCircuit({ nom = 'Circuit sans nom', data }) {
    const ref = await addDoc(collection(db, 'circuits'), {
        nom,
        data,           // { baseLat, baseLon, start, checkpoints, finish }
        best_temps_ms: null,   // denormalisé : meilleur temps (mis à jour par saveGhost)
        best_pseudo: null,
        created_at: serverTimestamp()
    });
    return ref.id;
}

/**
 * Récupère un circuit par ID. Retourne { id, nom, data } ou null.
 */
export async function getCircuit(id) {
    if (!id) return null;
    try {
        const snap = await getDoc(doc(db, 'circuits', id));
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() };
    } catch (e) {
        console.error('getCircuit erreur', e);
        return null;
    }
}

/**
 * Liste des circuits (écran d'accueil), du plus récent au plus ancien.
 * Retourne [{ id, nom, data, best_temps_ms, best_pseudo, created_at }, ...]
 */
export async function getAllCircuits(n = 50) {
    try {
        const q = query(
            collection(db, 'circuits'),
            orderBy('created_at', 'desc'),
            limit(n)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('getAllCircuits erreur', e);
        return [];
    }
}

// ============ GHOSTS ============

/**
 * Sauvegarde un ghost (trajectoire) pour un circuit.
 * trajectoire = [{t, x, y, z, qx, qy, qz, qw}, ...]  (t en ms)
 * Met aussi à jour le meilleur temps denormalisé sur le circuit.
 */
export async function saveGhost({ circuitId, pseudo, tempsMs, trajectoire }) {
    if (!circuitId || !pseudo || !Number.isFinite(tempsMs) || !Array.isArray(trajectoire)) {
        throw new Error('saveGhost : arguments invalides');
    }
    const ref = await addDoc(collection(db, 'ghosts'), {
        circuit_id: circuitId,
        pseudo: pseudo.slice(0, 20),
        temps_ms: Math.round(tempsMs),
        trajectoire,
        created_at: serverTimestamp()
    });

    // Denormalisation : meilleur temps sur le circuit (pour la liste d'accueil)
    try {
        const circuitRef = doc(db, 'circuits', circuitId);
        const circuitSnap = await getDoc(circuitRef);
        if (circuitSnap.exists()) {
            const cur = circuitSnap.data().best_temps_ms;
            if (cur == null || Math.round(tempsMs) < cur) {
                await updateDoc(circuitRef, {
                    best_temps_ms: Math.round(tempsMs),
                    best_pseudo: pseudo.slice(0, 20)
                });
            }
        }
    } catch (e) {
        console.warn('Mise à jour best_temps_ms ignorée', e);
    }

    return ref.id;
}

/**
 * Récupère le meilleur ghost (temps le plus court) pour un circuit.
 * Retourne { id, pseudo, temps_ms, trajectoire } ou null.
 */
export async function getBestGhost(circuitId) {
    if (!circuitId) return null;
    try {
        const q = query(
            collection(db, 'ghosts'),
            where('circuit_id', '==', circuitId),
            orderBy('temps_ms', 'asc'),
            limit(1)
        );
        const snap = await getDocs(q);
        if (snap.empty) return null;
        const d = snap.docs[0];
        return { id: d.id, ...d.data() };
    } catch (e) {
        console.error('getBestGhost erreur', e);
        return null;
    }
}

/**
 * Meilleur temps d'un circuit SANS la trajectoire (léger, pour la liste).
 * Retourne { pseudo, temps_ms } ou null.
 */
export async function getBestTime(circuitId) {
    if (!circuitId) return null;
    try {
        const q = query(
            collection(db, 'ghosts'),
            where('circuit_id', '==', circuitId),
            orderBy('temps_ms', 'asc'),
            limit(1)
        );
        const snap = await getDocs(q);
        if (snap.empty) return null;
        const d = snap.data ? snap.data() : snap.docs[0].data();
        return { pseudo: d.pseudo, temps_ms: d.temps_ms };
    } catch (e) {
        console.error('getBestTime erreur', e);
        return null;
    }
}

/**
 * Top N des meilleurs ghosts d'un circuit (pour afficher le classement du circuit).
 */
export async function getTopGhosts(circuitId, n = 10) {
    if (!circuitId) return [];
    try {
        const q = query(
            collection(db, 'ghosts'),
            where('circuit_id', '==', circuitId),
            orderBy('temps_ms', 'asc'),
            limit(n)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('getTopGhosts erreur', e);
        return [];
    }
}

// ============ DAILY SCORES (Phase 3) ============

/**
 * Enregistre un score du défi du jour.
 * date = 'YYYY-MM-DD'
 */
export async function saveDailyScore({ date, circuitId, pseudo, tempsMs, ghostId }) {
    const ref = await addDoc(collection(db, 'daily_scores'), {
        date,
        circuit_id: circuitId,
        pseudo: pseudo.slice(0, 20),
        temps_ms: Math.round(tempsMs),
        ghost_id: ghostId || null,
        created_at: serverTimestamp()
    });
    return ref.id;
}

/**
 * Classement du jour (top N) pour un circuit donné.
 */
export async function getDailyLeaderboard({ date, circuitId, n = 50 }) {
    try {
        const q = query(
            collection(db, 'daily_scores'),
            where('date', '==', date),
            where('circuit_id', '==', circuitId),
            orderBy('temps_ms', 'asc'),
            limit(n)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('getDailyLeaderboard erreur', e);
        return [];
    }
}