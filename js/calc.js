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
  const burned = bmrKcal + stepsKcal + sportKcal;
  return {
    weightKg,
    bmrKcal,
    netSteps,
    workoutSteps,
    km: stepsToKm(netSteps, person.heightCm, person.sex),
    stepsKcal,
    sportKcal,
    burned,
    eaten,
    mealTotals,
    mealMacros,
    macros,
    balance: eaten - burned, // négatif = déficit
    logged: eaten > 0,
  };
}
