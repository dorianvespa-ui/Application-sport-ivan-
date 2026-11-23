// Calculs et utilitaires de dates (aucune dépendance à l'interface).

export const MEALS = [
  { id: 'breakfast', label: 'Petit-déjeuner', icon: '🌅' },
  { id: 'lunch', label: 'Déjeuner', icon: '🥗' },
  { id: 'snack', label: 'En-cas', icon: '🍎' },
  { id: 'dinner', label: 'Dîner', icon: '🌙' },
];

// Nutriments suivis, en grammes.
export const MACROS = [
  { id: 'protein', label: 'Protéines', short: 'P' },
  { id: 'carbs', label: 'Glucides', short: 'G' },
  { id: 'fiber', label: 'Fibres', short: 'F' },
];

export const KCAL_PER_KG_FAT = 7700;

// Effet thermique des aliments : la digestion consomme environ 10 % des
// calories mangées (plus pour les protéines, moins pour les graisses).
export const TEF_RATE = 0.1;

// Additionne les nutriments d'une liste d'aliments. `missing` compte les
// aliments saisis sans aucun nutriment (le total est alors sous-estimé).
export function sumMacros(items) {
  const total = { protein: 0, carbs: 0, fiber: 0, missing: 0 };
  for (const it of items) {
    const m = it.macros || {};
    let any = false;
    for (const { id } of MACROS) {
      if (m[id] != null) {
        total[id] += Number(m[id]) || 0;
        any = true;
      }
    }
    if (!any) total.missing++;
  }
  return total;
}

// ---------- Dates (clés locales AAAA-MM-JJ) ----------

export function toKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey() {
  return toKey(new Date());
}

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

// Lundi de la semaine contenant `key`.
export function weekStart(key) {
  const d = fromKey(key);
  const offset = (d.getDay() + 6) % 7;
  return addDays(key, -offset);
}

// ---------- Formules ----------

export function ageAt(birthDate, key) {
  const b = fromKey(birthDate);
  const d = fromKey(key);
  let age = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) age--;
  return age;
}

// Métabolisme de base, formule de Mifflin-St Jeor (kcal/jour).
export function bmr({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return base + (sex === 'f' ? -161 : 5);
}

// Calories nettes dépensées par la marche : distance estimée par la foulée
// (≈ 0,415 × taille), puis ≈ 0,5 kcal par kg et par km.
export function stepsToKm(steps, heightCm, sex) {
  const stride = (heightCm / 100) * (sex === 'f' ? 0.413 : 0.415);
  return (steps * stride) / 1000;
}

export function stepsToKcal(steps, { heightCm, weightKg, sex }) {
  return stepsToKm(steps, heightCm, sex) * weightKg * 0.5;
}

export function itemKcal(item) {
  return Number(item.kcal) || 0;
}

// Bilan complet d'une journée.
// `day` : { steps, workouts: [{kcal, steps}], meals: {breakfast: [...], ...} }
export function dayStats(day, profile, weightKg, key) {
  const person = {
    sex: profile.sex,
    heightCm: profile.heightCm,
    weightKg,
    age: ageAt(profile.birthDate, key),
  };
  const bmrKcal = bmr(person);
  const workoutSteps = day.workouts.reduce((s, w) => s + (Number(w.steps) || 0), 0);
  // Les pas faits pendant une séance sont déjà comptés dans la séance.
  const netSteps = Math.max(0, (Number(day.steps) || 0) - workoutSteps);
  const stepsKcal = stepsToKcal(netSteps, person);
  const sportKcal = day.workouts.reduce((s, w) => s + (Number(w.kcal) || 0), 0);
  const mealTotals = {};
  const mealMacros = {};
  let eaten = 0;
  for (const m of MEALS) {
    mealTotals[m.id] = (day.meals[m.id] || []).reduce((s, it) => s + itemKcal(it), 0);
    mealMacros[m.id] = sumMacros(day.meals[m.id] || []);
    eaten += mealTotals[m.id];
  }
  const macros = sumMacros(MEALS.flatMap((m) => day.meals[m.id] || []));
  // Estimation brute, puis correction personnelle issue du calibrage (1 = aucune).
  const tefKcal = eaten * TEF_RATE;
  const rawBurned = bmrKcal + stepsKcal + sportKcal + tefKcal;
  const factor = Number(profile.calibration) || 1;
  const burned = rawBurned * factor;
  return {
    weightKg,
    bmrKcal,
    netSteps,
    workoutSteps,
    km: stepsToKm(netSteps, person.heightCm, person.sex),
    stepsKcal,
    sportKcal,
    tefKcal,
    rawBurned,
    calibrationKcal: burned - rawBurned,
    burned,
    eaten,
    mealTotals,
    mealMacros,
    macros,
    balance: eaten - burned, // négatif = déficit
    logged: eaten > 0,
  };
}

// ---------- Calibrage sur les pesées ----------

export const CALIBRATION = { windowDays: 42, minSpanDays: 14, minCoverage: 0.8, maxCorrection: 0.25 };

export function daysBetween(a, b) {
  return Math.round((fromKey(b) - fromKey(a)) / 86400000);
}

// Compare, entre la première et la dernière pesée de la période, les calories
// mangées et l'évolution réelle du poids, pour en déduire la dépense réelle.
// `weights` : [{date, kg}] triées ; `statsFor(key)` : bilan d'un jour.
export function calibrate(weights, statsFor, today) {
  const from = addDays(today, -CALIBRATION.windowDays);
  const ws = weights.filter((w) => w.date >= from && w.date <= today);
  const out = { ready: false, weighIns: ws.length, span: 0, logged: 0, days: 0 };
  if (ws.length < 2) return out;
  const first = ws[0], last = ws[ws.length - 1];
  out.span = daysBetween(first.date, last.date);
  out.days = out.span;
  let eaten = 0, estimated = 0;
  for (let i = 0; i < out.span; i++) {
    const s = statsFor(addDays(first.date, i));
    if (!s.logged) continue;
    out.logged++;
    eaten += s.eaten;
    estimated += s.rawBurned;
  }
  if (out.span < CALIBRATION.minSpanDays || out.logged < CALIBRATION.minCoverage * out.span) return out;

  // Pente du poids en kg par jour : droite des moindres carrés à partir de
  // 3 pesées (moins sensible à une pesée isolée), simple différence sinon.
  let slope = (last.kg - first.kg) / out.span;
  if (ws.length >= 3) {
    const xs = ws.map((w) => daysBetween(first.date, w.date));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ws.reduce((a, w) => a + w.kg, 0) / ws.length;
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (den > 0) slope = xs.reduce((a, x, i) => a + (x - mx) * (ws[i].kg - my), 0) / den;
  }
  const intake = eaten / out.logged;
  const est = estimated / out.logged;
  const observed = intake - slope * KCAL_PER_KG_FAT;
  return { ...out, ready: true, intake, estimated: est, observed, factor: observed / est, deltaKg: slope * out.span, from: first.date, to: last.date };
}
