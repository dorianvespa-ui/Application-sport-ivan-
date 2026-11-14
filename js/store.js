// Stockage local (localStorage). L'appareil garde toujours une copie complète ;
// js/sync.js la recopie en ligne quand un compte est connecté.

const KEY = 'equilibre.v1';

const empty = () => ({ profile: null, weights: [], days: {} });

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...empty(), ...JSON.parse(raw) };
  } catch (e) {
    console.warn('Lecture des données impossible', e);
  }
  return empty();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Sauvegarde impossible', e);
  }
}

let onChange = () => {};
export function setChangeListener(fn) {
  onChange = fn;
}

// À appeler après toute modification faite par l'utilisateur :
// date la version (pour la synchronisation) et prévient l'écouteur.
export function save() {
  state.updatedAt = Date.now();
  persist();
  onChange();
}

// Rattache les données locales au compte connecté. Si elles appartenaient
// à un autre compte, on repart de zéro.
export function setOwner(userId) {
  if (state.owner && state.owner !== userId) state = empty();
  if (state.owner !== userId) {
    state.owner = userId;
    persist();
  }
}

// Remplace les données locales par la version en ligne (sans la redater).
export function adoptRemote(data, userId) {
  state = { ...empty(), ...data, owner: userId };
  persist();
}

// Vide l'appareil à la déconnexion (la copie en ligne n'est pas touchée).
export function clearLocal() {
  state = empty();
  persist();
}

export const getState = () => state;

export function replaceState(next) {
  if (!next || typeof next !== 'object' || !next.days) throw new Error('Fichier invalide');
  state = { ...empty(), ...next, owner: state.owner };
  save();
}

export function resetState() {
  state = { ...empty(), owner: state.owner };
  save();
}

export const emptyDay = () => ({
  steps: 0,
  workouts: [],
  meals: { breakfast: [], lunch: [], snack: [], dinner: [] },
});

// Lecture seule : ne crée pas la journée.
export function getDay(key) {
  const d = state.days[key];
  if (!d) return emptyDay();
  return { ...emptyDay(), ...d, meals: { ...emptyDay().meals, ...d.meals } };
}

// Modification : crée la journée si besoin, applique `fn`, sauvegarde.
export function updateDay(key, fn) {
  const d = getDay(key);
  fn(d);
  state.days[key] = d;
  save();
}

// Poids connu à une date : dernière pesée ≤ date, sinon poids du profil.
export function weightAt(key) {
  let best = null;
  for (const w of state.weights) {
    if (w.date <= key && (!best || w.date > best.date)) best = w;
  }
  return best ? best.kg : state.profile?.weightKg;
}

export function setWeight(date, kg) {
  state.weights = state.weights.filter((w) => w.date !== date);
  state.weights.push({ date, kg });
  state.weights.sort((a, b) => a.date.localeCompare(b.date));
  const last = state.weights[state.weights.length - 1];
  if (state.profile) state.profile.weightKg = last.kg;
  save();
}

export function removeWeight(date) {
  state.weights = state.weights.filter((w) => w.date !== date);
  save();
}

// Aliments récemment saisis (dédoublonnés par nom, plus récents d'abord).
export function recentFoods(limit = 30) {
  const seen = new Map();
  const keys = Object.keys(state.days).sort().reverse();
  for (const k of keys) {
    for (const items of Object.values(state.days[k].meals || {})) {
      for (const it of items) {
        const id = it.name.trim().toLowerCase();
        if (!seen.has(id)) seen.set(id, it);
        if (seen.size >= limit) return [...seen.values()];
      }
    }
  }
  return [...seen.values()];
}

export const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
