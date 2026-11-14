// Compte et synchronisation en ligne (Supabase).
// L'app reste « locale d'abord » : tout est lu et écrit sur l'appareil,
// puis recopié en ligne. En cas de conflit, la version la plus récente gagne.

import * as store from './store.js';

// La clé « publishable » est faite pour être publique : l'accès aux données
// est protégé côté serveur (chaque compte ne voit que sa propre ligne).
const SUPABASE_URL = 'https://srbfrwoptmjlhrvbjvfc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_BXVYVBObjQC_Td9mWeyfag_1saBaWrh';
const TABLE = 'equilibre_data';

let sb = null;
let user = null;
let pushTimer = null;
let busy = null;
let dirty = false; // des modifications locales attendent d'être envoyées
export const hasPending = () => dirty;

// state : 'idle' | 'syncing' | 'ok' | 'offline'
export const status = { state: 'idle', at: null };
let onStatus = () => {};
export function setStatusListener(fn) {
  onStatus = fn;
}
function setStatus(state) {
  status.state = state;
  if (state === 'ok') status.at = new Date();
  onStatus(status);
}

export const currentUser = () => user;

function client() {
  if (!sb) {
    if (!window.supabase) throw new Error('Le module de connexion ne s\'est pas chargé.');
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    sb.auth.onAuthStateChange((_event, session) => {
      user = session?.user ?? null;
    });
  }
  return sb;
}

// Renvoie l'utilisateur déjà connecté sur cet appareil, ou null.
export async function init() {
  const { data } = await client().auth.getSession();
  user = data.session?.user ?? null;
  return user;
}

function translate(error) {
  const m = String(error?.message || error || '');
  if (/invalid login credentials/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/already registered|already been registered/i.test(m)) return 'Un compte existe déjà avec cet e-mail. Connecte-toi.';
  if (/email not confirmed/i.test(m)) return "Confirme d'abord ton adresse grâce à l'e-mail reçu, puis connecte-toi.";
  if (/password should be|weak password/i.test(m)) return 'Mot de passe trop faible : choisis-en un plus long.';
  if (/signups? not allowed|signup is disabled/i.test(m)) return 'La création de compte est désactivée sur le serveur.';
  if (/rate limit|too many/i.test(m)) return 'Trop de tentatives. Réessaie dans quelques minutes.';
  if (/failed to fetch|network|load failed/i.test(m)) return 'Pas de connexion à internet.';
  if (/invalid.*email|email.*invalid/i.test(m)) return "Cette adresse e-mail n'est pas valide.";
  return m || 'Une erreur est survenue.';
}

export async function signIn(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw new Error(translate(error));
  user = data.user;
  return user;
}

// Renvoie l'utilisateur, ou null si une confirmation par e-mail est requise.
export async function signUp(email, password) {
  const { data, error } = await client().auth.signUp({ email, password });
  if (error) throw new Error(translate(error));
  // Sans session, Supabase attend la confirmation de l'adresse e-mail.
  if (!data.session) return null;
  user = data.user;
  return user;
}

export async function signOut() {
  clearTimeout(pushTimer);
  try {
    await client().auth.signOut();
  } catch (e) {
    console.warn(e);
  }
  user = null;
  dirty = false;
  setStatus('idle');
}

const hasContent = (s) => Boolean(s.profile) || Object.keys(s.days || {}).length > 0 || (s.weights || []).length > 0;

async function pushNow() {
  const state = store.getState();
  const sentAt = state.updatedAt || 0;
  const { error } = await client()
    .from(TABLE)
    .upsert({ user_id: user.id, data: state, updated_at: new Date().toISOString() });
  if (error) throw error;
  // Si une modification est arrivée pendant l'envoi, elle reste à envoyer.
  if (store.getState() === state && (state.updatedAt || 0) === sentAt) dirty = false;
}

// Compare la version locale et la version en ligne, garde la plus récente.
// Renvoie 'pulled' (données locales remplacées), 'pushed', 'same' ou 'error'.
export async function sync() {
  if (!user) return 'error';
  if (busy) return busy;
  busy = (async () => {
    setStatus('syncing');
    try {
      const { data: row, error } = await client().from(TABLE).select('data').eq('user_id', user.id).maybeSingle();
      if (error) throw error;
      const local = store.getState();
      const remoteTs = row?.data?.updatedAt || 0;
      const localTs = local.updatedAt || 0;
      let result = 'same';
      if (row && remoteTs > localTs) {
        store.adoptRemote(row.data, user.id);
        dirty = false;
        result = 'pulled';
      } else if ((row && localTs > remoteTs) || (!row && hasContent(local))) {
        await pushNow();
        result = 'pushed';
      }
      setStatus('ok');
      return result;
    } catch (e) {
      console.warn('Synchronisation impossible', e);
      setStatus('offline');
      return 'error';
    } finally {
      busy = null;
    }
  })();
  return busy;
}

// Envoi différé après une modification locale.
export function schedulePush() {
  dirty = true;
  if (!user) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(flush, 1200);
}

// Envoi immédiat des modifications en attente (ne fait rien s'il n'y en a pas,
// pour ne jamais écraser une version en ligne plus récente avec une copie ancienne).
export async function flush() {
  clearTimeout(pushTimer);
  if (!user) return;
  if (busy) await busy;
  if (!dirty) return;
  setStatus('syncing');
  try {
    await pushNow();
    setStatus('ok');
  } catch (e) {
    console.warn('Envoi impossible', e);
    setStatus('offline');
  }
}
