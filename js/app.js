import { MEALS, MACROS, KCAL_PER_KG_FAT, todayKey, addDays, fromKey, weekStart, dayStats, bmr, ageAt , calibrate, daysBetween, CALIBRATION } from './calc.js';
import * as store from './store.js';
import { FOODS } from './foods.js';
import { startScanner, stopScanner, lookupProduct } from './scanner.js';
import * as sync from './sync.js';

// ---------- Utilitaires ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
const signed = (n) => (Math.round(n) > 0 ? '+' : Math.round(n) < 0 ? '−' : '') + fmt(Math.abs(n));
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const num = (v) => Number(String(v ?? '').replace(',', '.')) || 0;
// Grammes : une décimale sous 10 g, entier au-delà (« 4,5 », « 32 »).
const g1 = (v) => (v < 10 ? String(Math.round(v * 10) / 10).replace('.', ',') : fmt(v));
// « P 32 g · G 60 g · F 8 g » pour les nutriments renseignés.
const macroLine = (m) =>
  MACROS.filter(({ id }) => m && m[id] != null)
    .map(({ id, short }) => `${short} ${g1(m[id])} g`)
    .join(' · ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const dfLong = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const dfShort = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const dfWeekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long' });

// auth : 'loading' (démarrage), 'out' (écran de connexion), 'in' (app utilisable)
const ui = { view: 'day', date: todayKey(), week: weekStart(todayKey()), auth: 'loading', authMode: 'signin', synced: false };

const profile = () => store.getState().profile;
// Objectif : perte de poids (déficit visé) ou prise de masse (surplus visé).
const goalOf = (p) => ({ gain: p?.goal === 'gain', kcal: p?.targetKcal ?? p?.targetDeficit ?? 0 });
// Couleur d'un bilan : vert s'il va dans le sens de l'objectif.
const tone = (balance) => (Math.round(balance) === 0 || balance > 0 === goalOf(profile()).gain ? 'good' : 'bad');
const statsFor = (key) => dayStats(store.getDay(key), profile(), store.weightAt(key), key);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

const ICONS = {
  day: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  stats: '<svg viewBox="0 0 24 24"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>',
  profile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.3 7.5-5.3s6.3 1.7 7.5 5.3"/></svg>',
};

// ---------- Rendu principal ----------

function render() {
  const app = $('#app');
  if (ui.auth !== 'in') {
    app.innerHTML = ui.auth === 'out' ? authView() : `<section class="welcome"><img src="icons/icon.svg" alt="" width="72" height="72"><h1>Équilibre</h1><p>Chargement…</p></section>`;
    return;
  }
  if (!profile() && !ui.synced) {
    // Compte connecté mais données en ligne pas encore lues : ne pas proposer
    // de recréer un profil, qui écraserait la sauvegarde.
    const failed = sync.status.state === 'offline';
    app.innerHTML = `<section class="welcome"><img src="icons/icon.svg" alt="" width="72" height="72"><h1>Équilibre</h1>
      <p>${failed ? 'Impossible de récupérer tes données. Vérifie ta connexion à internet.' : 'Récupération de tes données…'}</p></section>
      ${failed ? '<div class="form"><button class="btn" data-act="retry-sync">Réessayer</button><button class="link" data-act="logout">Se déconnecter</button></div>' : ''}`;
    return;
  }
  if (!profile()) {
    app.innerHTML = onboardingView();
    return;
  }
  const view = ui.view === 'stats' ? statsView() : ui.view === 'profile' ? profileView() : dayView();
  app.innerHTML = view + tabBar();
}

function tabBar() {
  const tab = (id, label) =>
    `<button class="tab ${ui.view === id ? 'active' : ''}" data-act="tab" data-view="${id}" ${ui.view === id ? 'aria-current="page"' : ''}>${ICONS[id]}<span>${label}</span></button>`;
  return `<nav class="tabbar">${tab('day', 'Journée')}${tab('stats', 'Bilan')}${tab('profile', 'Profil')}</nav>`;
}

// ---------- Vue Journée ----------

function dayTitle(key) {
  const today = todayKey();
  if (key === today) return "Aujourd'hui";
  if (key === addDays(today, -1)) return 'Hier';
  return cap(dfWeekday.format(fromKey(key)));
}

function dayView() {
  const key = ui.date;
  const day = store.getDay(key);
  const s = statsFor(key);
  const p = profile();
  const isToday = key === todayKey();

  return `
  <header class="top">
    <button class="icon-btn" data-act="day-shift" data-n="-1" aria-label="Jour précédent">‹</button>
    <div class="top-title">
      <h1>${dayTitle(key)}</h1>
      <p>${dfLong.format(fromKey(key))}</p>
    </div>
    <button class="icon-btn" data-act="day-shift" data-n="1" aria-label="Jour suivant" ${isToday ? 'disabled' : ''}>›</button>
  </header>

  ${heroCard(s, p)}
  ${isToday ? weighInReminder() : ''}
  ${nutritionCard(s.macros, p, s.logged)}

  <section class="card">
    <div class="card-head"><h2>Dépenses</h2><strong>${fmt(s.burned)} kcal</strong></div>
    <div class="row">
      <span class="row-ic">🔥</span>
      <div class="row-main"><b>Métabolisme de base</b><small>Au repos, pour ${kg(s.weightKg)}</small></div>
      <span class="row-val">${fmt(s.bmrKcal)}</span>
    </div>
    ${
      Math.round(s.calibrationKcal)
        ? `<div class="row">
      <span class="row-ic">⚖️</span>
      <div class="row-main"><b>Calibrage personnel</b><small>${signed((p.calibration - 1) * 100)} % d'après tes pesées</small></div>
      <span class="row-val">${signed(s.calibrationKcal)}</span>
    </div>`
        : ''
    }
    <div class="row">
      <span class="row-ic">👟</span>
      <div class="row-main">
        <b><label for="steps">Pas de la journée</label></b>
        <small>${s.netSteps ? `≈ ${s.km.toFixed(1).replace('.', ',')} km` : 'Saisis ton nombre de pas'}${s.workoutSteps ? ` · ${fmt(s.workoutSteps)} pas de séance déduits` : ''}</small>
      </div>
      <input id="steps" class="steps-input" type="number" inputmode="numeric" min="0" step="1" placeholder="0" value="${day.steps || ''}" data-change="steps">
      <span class="row-val">${fmt(s.stepsKcal)}</span>
    </div>
    ${day.workouts
      .map(
        (w) => `
    <div class="swipe"><div class="row swipe-content">
      <span class="row-ic">🏋️</span>
      <div class="row-main"><b>${esc(w.name)}</b><small>${[w.minutes ? `${fmt(w.minutes)} min` : '', w.steps ? `${fmt(w.steps)} pas` : ''].filter(Boolean).join(' · ') || 'Séance'}</small></div>
      <span class="row-val">${fmt(w.kcal)}</span>
    </div><button class="swipe-del" data-act="del-workout" data-id="${w.id}" aria-label="Supprimer ${esc(w.name)}">Supprimer</button></div>`
      )
      .join('')}
    <button class="add" data-act="open-workout">+ Ajouter une séance de sport</button>
  </section>

  <div class="section-title"><h2>Repas</h2><strong>${fmt(s.eaten)} kcal</strong></div>
  ${MEALS.map((m) => mealCard(m, day, s, key)).join('')}
  ${day.workouts.length || s.eaten > 0 ? '<p class="hint">Astuce : glisse une ligne vers la gauche pour la supprimer.</p>' : ''}
  `;
}

function heroCard(s, p) {
  const ratio = s.burned > 0 ? Math.min(s.eaten / s.burned, 1) : 0;
  const C = 2 * Math.PI * 52;
  const surplus = s.balance > 0;
  let status = 'Aucun repas saisi';
  let pill = 'neutral';
  if (s.logged) {
    status = surplus ? 'Surplus calorique' : 'Déficit calorique';
    pill = tone(s.balance);
  }
  let goal = '';
  const g = goalOf(p);
  if (g.kcal > 0) {
    const left = s.burned + (g.gain ? g.kcal : -g.kcal) - s.eaten;
    const label = `Objectif ${g.gain ? '+' : '−'}${fmt(g.kcal)}`;
    if (left > 0) goal = `${label} : encore <b>${fmt(left)} kcal</b> à manger`;
    else if (g.gain) goal = `${label} : atteint${Math.round(left) < 0 ? `, dépassé de <b>${fmt(-left)} kcal</b>` : ''}`;
    else goal = `${label} : dépassé de <b>${fmt(-left)} kcal</b>`;
  }
  return `
  <section class="hero">
    <div class="ring">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="ring-track" cx="60" cy="60" r="52"/>
        <circle class="ring-bar ${s.logged && tone(s.balance) === 'bad' ? 'over' : ''}" cx="60" cy="60" r="52" stroke-dasharray="${(C * ratio).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 60 60)"/>
      </svg>
      <div class="ring-center"><b>${s.logged ? signed(s.balance) : fmt(s.burned)}</b><small>${s.logged ? 'kcal' : 'kcal dépensées'}</small></div>
    </div>
    <div class="hero-info">
      <span class="pill ${pill}">${status}</span>
      <dl>
        <div><dt>Ingérées</dt><dd>${fmt(s.eaten)}</dd></div>
        <div><dt>Dépensées</dt><dd>${fmt(s.burned)}</dd></div>
      </dl>
      ${goal ? `<p class="goal">${goal}</p>` : ''}
    </div>
  </section>`;
}

// Rappel de pesée : affiché quand la dernière pesée a une semaine ou plus.
const WEIGH_IN_EVERY = 7;
function weighInReminder() {
  const ws = store.getState().weights;
  const last = ws.length ? ws[ws.length - 1].date : null;
  const age = last ? daysBetween(last, todayKey()) : null;
  if (age !== null && age < WEIGH_IN_EVERY) return '';
  return `
  <section class="card reminder">
    <span class="row-ic" aria-hidden="true">⚖️</span>
    <div class="row-main"><b>C'est le moment de te peser</b><small>${age === null ? 'Aucune pesée enregistrée.' : `Ta dernière pesée date de ${age} jours.`} Une pesée par semaine permet de calibrer ta dépense réelle.</small></div>
    <button class="btn small" data-act="open-weight">Me peser</button>
  </section>`;
}

// Récapitulatif protéines / glucides / fibres du jour.
function nutritionCard(m, p, logged) {
  const goal = p.proteinGoal || 0;
  const pct = goal ? Math.min(100, (m.protein / goal) * 100) : 0;
  const reached = goal > 0 && m.protein >= goal;
  return `
  <section class="card nutri" aria-label="Nutrition du jour">
    <div class="nutri-main">
      <div class="nutri-head"><small>Protéines</small>${reached ? '<span class="pill good">Objectif atteint</span>' : ''}</div>
      <p class="nutri-big"><b>${g1(m.protein)}</b>${goal ? ` <span>/ ${fmt(goal)} g</span>` : ' <span>g</span>'}</p>
      ${
        goal
          ? `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.round(m.protein)}" aria-label="Protéines"><i style="width:${pct.toFixed(1)}%"></i></div>
             <small class="muted">${reached ? `${g1(m.protein - goal)} g au-delà de l'objectif` : `Encore ${g1(goal - m.protein)} g`}</small>`
          : '<small class="muted">Fixe un objectif de protéines dans l\'onglet Profil.</small>'
      }
    </div>
    <div class="nutri-side">
      <div><small>Glucides</small><b>${g1(m.carbs)} g</b></div>
      <div><small>Fibres</small><b>${g1(m.fiber)} g</b></div>
    </div>
    ${logged && m.missing ? `<small class="nutri-note">${m.missing} aliment${m.missing > 1 ? 's' : ''} sans nutriments renseignés : ces totaux sont sous-estimés.</small>` : ''}
  </section>`;
}

function mealCard(m, day, s, key) {
  const items = day.meals[m.id];
  const prev = store.getDay(addDays(key, -1)).meals[m.id];
  return `
  <section class="card meal">
    <div class="card-head"><h3><span>${m.icon}</span> ${m.label}</h3>${items.length ? `<strong>${fmt(s.mealTotals[m.id])} kcal</strong>` : ''}</div>
    ${items.length > 1 && s.mealMacros[m.id].missing < items.length ? `<p class="meal-macros">${macroLine(s.mealMacros[m.id])}</p>` : ''}
    ${items
      .map(
        (it) => `
    <div class="swipe"><div class="row swipe-content">
      <div class="row-main"><b>${esc(it.name)}</b>${[it.qty ? `${fmt(it.qty)} g` : '', macroLine(it.macros)].filter(Boolean).map((t) => `<small>${t}</small>`).join('')}</div>
      <span class="row-val">${fmt(it.kcal)}<small>kcal</small></span>
    </div><button class="swipe-del" data-act="del-food" data-meal="${m.id}" data-id="${it.id}" aria-label="Supprimer ${esc(it.name)}">Supprimer</button></div>`
      )
      .join('')}
    <div class="meal-actions">
      <button class="add" data-act="open-food" data-meal="${m.id}">+ Ajouter un aliment</button>
      ${!items.length && prev.length ? `<button class="add ghost" data-act="copy-prev" data-meal="${m.id}">Copier la veille</button>` : ''}
    </div>
  </section>`;
}

// ---------- Vue Bilan ----------

function statsView() {
  const today = todayKey();
  const keys = Array.from({ length: 7 }, (_, i) => addDays(ui.week, i));
  const all = keys.map((k) => ({ key: k, future: k > today, ...statsFor(k) }));
  const logged = all.filter((d) => d.logged && !d.future);
  const n = logged.length;
  const sum = (f) => logged.reduce((t, d) => t + f(d), 0);
  const total = sum((d) => d.balance);
  const gain = goalOf(profile()).gain;
  const goalDays = logged.filter((d) => (gain ? d.balance > 0 : d.balance < 0)).length;
  const isCurrent = ui.week === weekStart(today);
  const range = `${dfShort.format(fromKey(keys[0]))} – ${dfShort.format(fromKey(keys[6]))}`;
  const grams = Math.abs(total) / (KCAL_PER_KG_FAT / 1000);

  return `
  <header class="top">
    <button class="icon-btn" data-act="week-shift" data-n="-7" aria-label="Semaine précédente">‹</button>
    <div class="top-title"><h1>${isCurrent ? 'Cette semaine' : 'Semaine'}</h1><p>${range}</p></div>
    <button class="icon-btn" data-act="week-shift" data-n="7" aria-label="Semaine suivante" ${isCurrent ? 'disabled' : ''}>›</button>
  </header>

  <section class="card">
    <div class="card-head"><h2>Bilan par jour</h2><small class="legend"><i class="dot ${gain ? 'bad' : 'good'}"></i>déficit <i class="dot ${gain ? 'good' : 'bad'}"></i>surplus</small></div>
    ${weekChart(all)}
  </section>

  ${
    n === 0
      ? `<section class="card empty"><p>Aucun repas saisi cette semaine.</p><small>Les jours sans repas ne comptent pas dans les moyennes.</small></section>`
      : `
  <section class="tiles">
    <div class="tile ${tone(total)}"><small>Bilan de la semaine</small><b>${signed(total)}</b><span>kcal · ≈ ${fmt(grams)} g de ${gain ? 'poids' : 'graisse'} ${total > 0 ? 'en plus' : 'en moins'}</span></div>
    <div class="tile"><small>Jours en ${gain ? 'surplus' : 'déficit'}</small><b>${goalDays} / ${n}</b><span>${n < 7 ? `${n} jour${n > 1 ? 's' : ''} renseigné${n > 1 ? 's' : ''}` : 'semaine complète'}</span></div>
    <div class="tile"><small>Moyenne par jour</small><b>${signed(total / n)}</b><span>kcal de bilan</span></div>
    <div class="tile"><small>Ingéré / dépensé</small><b>${fmt(sum((d) => d.eaten) / n)}</b><span>pour ${fmt(sum((d) => d.burned) / n)} kcal dépensées / jour</span></div>
  </section>
  ${weekNutrition(logged)}`
  }

  <section class="card">
    <div class="card-head"><h2>5 dernières semaines</h2></div>
    ${calendar()}
  </section>

  <section class="card">
    <div class="card-head"><h2>Poids</h2><button class="link" data-act="open-weight">+ Pesée</button></div>
    ${weightBlock()}
  </section>

  ${calibrationCard()}`;
}

// Moyennes de nutriments sur les jours renseignés de la semaine.
function weekNutrition(days) {
  const n = days.length;
  const avg = (id) => days.reduce((t, d) => t + d.macros[id], 0) / n;
  const goal = profile().proteinGoal || 0;
  const hit = days.filter((d) => goal && d.macros.protein >= goal).length;
  const missing = days.reduce((t, d) => t + d.macros.missing, 0);
  return `
  <section class="card">
    <div class="card-head"><h2>Nutrition</h2><small class="muted">moyenne par jour</small></div>
    <div class="nutri-row">
      ${MACROS.map(({ id, label }) => `<div><small>${label}</small><b>${g1(avg(id))} g</b></div>`).join('')}
    </div>
    ${goal ? `<p class="muted">Objectif de ${fmt(goal)} g de protéines atteint <b>${hit} jour${hit > 1 ? 's' : ''} sur ${n}</b>.</p>` : ''}
    ${missing ? `<small class="nutri-note">${missing} aliment${missing > 1 ? 's' : ''} sans nutriments renseignés cette semaine : moyennes sous-estimées.</small>` : ''}
  </section>`;
}

// Calibrage : dépense réelle déduite des repas saisis et de l'évolution du poids.
function calibrationCard() {
  const p = profile();
  const c = calibrate(store.getState().weights, statsFor, todayKey());
  const applied = p.calibration && p.calibration !== 1;
  const pct = (f) => `${signed((f - 1) * 100)} %`;
  let body;
  if (!c.ready) {
    const need = Math.ceil(CALIBRATION.minCoverage * Math.max(c.span, CALIBRATION.minSpanDays));
    body = `
      <p class="muted">L'app compare ce que tu manges à l'évolution réelle de ton poids pour mesurer ta vraie dépense, au lieu de l'estimer par une formule.</p>
      <ul class="checks">
        <li class="${c.weighIns >= 2 && c.span >= CALIBRATION.minSpanDays ? 'ok' : ''}">Au moins 2 pesées espacées de ${CALIBRATION.minSpanDays} jours <small>(${c.weighIns} pesée${c.weighIns > 1 ? 's' : ''} sur ${c.span} jour${c.span > 1 ? 's' : ''})</small></li>
        <li class="${c.span >= CALIBRATION.minSpanDays && c.logged >= need ? 'ok' : ''}">Repas saisis au moins 8 jours sur 10 entre ces pesées <small>(${c.logged} jour${c.logged > 1 ? 's' : ''} sur ${c.days})</small></li>
      </ul>`;
  } else {
    const capped = Math.min(1 + CALIBRATION.maxCorrection, Math.max(1 - CALIBRATION.maxCorrection, c.factor));
    const small = Math.abs(c.factor - 1) < 0.03;
    const same = applied && Math.abs(capped - p.calibration) < 0.005;
    body = `
      <div class="nutri-row">
        <div><small>Dépense constatée</small><b>${fmt(c.observed)}</b></div>
        <div><small>Estimation</small><b>${fmt(c.estimated)}</b></div>
        <div><small>Écart</small><b>${pct(c.factor)}</b></div>
      </div>
      <p class="muted">Sur ${c.span} jours (${c.logged} saisis) : ${fmt(c.intake)} kcal mangées par jour en moyenne, poids ${c.deltaKg > 0 ? '+' : '−'}${Math.abs(c.deltaKg).toFixed(1).replace('.', ',')} kg d'après ${c.weighIns} pesées.</p>
      <p class="muted">${
        small
          ? "L'estimation de l'app colle à tes pesées : aucune correction nécessaire."
          : capped !== c.factor
            ? `Cet écart est trop grand pour être crédible (au-delà de ${Math.round(CALIBRATION.maxCorrection * 100)} %), donc aucune correction n'est proposée. Vérifie que tous tes repas et tes pesées sont bien saisis.`
            : `Ta dépense réelle semble ${c.factor > 1 ? 'plus élevée' : 'plus basse'} que l'estimation.`
      }</p>
      ${small || same || capped !== c.factor ? '' : `<button class="btn wide" data-act="apply-calibration" data-factor="${capped.toFixed(4)}">Appliquer la correction de ${pct(capped)}</button>`}`;
  }
  return `
  <section class="card">
    <div class="card-head"><h2>Calibrage</h2>${applied ? `<small class="pill-soft">Correction ${pct(p.calibration)}</small>` : ''}</div>
    ${body}
    ${applied ? '<button class="link danger" data-act="clear-calibration">Retirer la correction</button>' : ''}
    <small class="nutri-note">Le poids varie de 1 à 2 kg d'un jour à l'autre (eau, digestion) : pèse-toi le matin à jeun, et fie-toi au calibrage sur plusieurs semaines.</small>
  </section>`;
}

function weekChart(days) {
  const W = 336, zero = 92, maxH = 58, col = W / 7;
  const g = goalOf(profile());
  const target = g.kcal;
  const maxAbs = Math.max(400, target, ...days.filter((d) => d.logged && !d.future).map((d) => Math.abs(d.balance)));
  const letters = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  const today = todayKey();
  const bars = days
    .map((d, i) => {
      const cx = col * i + col / 2;
      const label = `<text class="ch-day ${d.key === today ? 'today' : ''}" x="${cx}" y="184" text-anchor="middle">${letters[i]}</text>`;
      if (!d.logged || d.future) return `<circle class="ch-none" cx="${cx}" cy="${zero}" r="3"/>${label}`;
      const h = Math.max(3, (Math.abs(d.balance) / maxAbs) * maxH);
      const deficit = d.balance < 0;
      const y = deficit ? zero : zero - h;
      const ty = deficit ? zero + h + 13 : zero - h - 5;
      return `<g data-act="go-day" data-key="${d.key}" class="ch-bar-g">
        <rect class="ch-hit" x="${col * i}" y="0" width="${col}" height="190"/>
        <rect class="ch-bar ${tone(d.balance)}" x="${cx - 13}" y="${y}" width="26" height="${h}" rx="6"/>
        <text class="ch-val" x="${cx}" y="${ty}" text-anchor="middle">${signed(d.balance)}</text></g>${label}`;
    })
    .join('');
  const ty = zero + ((g.gain ? -target : target) / maxAbs) * maxH;
  return `<svg class="chart" viewBox="0 0 ${W} 190" role="img" aria-label="Bilan calorique par jour de la semaine">
    <line class="ch-zero" x1="0" x2="${W}" y1="${zero}" y2="${zero}"/>
    ${target ? `<line class="ch-target" x1="0" x2="${W}" y1="${ty}" y2="${ty}"/>` : ''}
    ${bars}
  </svg>${target ? `<small class="chart-note">Pointillés : objectif de ${g.gain ? '+' : '−'}${fmt(target)} kcal / jour</small>` : ''}`;
}

function calendar() {
  const today = todayKey();
  const start = addDays(weekStart(today), -28);
  let cells = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((l) => `<span class="cal-h">${l}</span>`).join('');
  for (let i = 0; i < 35; i++) {
    const k = addDays(start, i);
    const dnum = fromKey(k).getDate();
    if (k > today) {
      cells += `<span class="cal-c future">${dnum}</span>`;
      continue;
    }
    const s = statsFor(k);
    const cls = !s.logged ? '' : tone(s.balance);
    const title = s.logged ? `${signed(s.balance)} kcal` : 'non renseigné';
    cells += `<button class="cal-c ${cls} ${k === today ? 'today' : ''}" data-act="go-day" data-key="${k}" aria-label="${dfLong.format(fromKey(k))} : ${title}">${dnum}</button>`;
  }
  return `<div class="cal">${cells}</div>`;
}

function weightBlock() {
  const ws = store.getState().weights;
  if (!ws.length) return `<p class="muted">Aucune pesée enregistrée.</p>`;
  const pts = ws.slice(-12);
  let chart = '';
  if (pts.length >= 2) {
    const W = 336, H = 110, pad = 18;
    const min = Math.min(...pts.map((p) => p.kg)), max = Math.max(...pts.map((p) => p.kg));
    const span = max - min || 1;
    const xy = pts.map((p, i) => [pad + (i * (W - 2 * pad)) / (pts.length - 1), pad + 8 + (1 - (p.kg - min) / span) * (H - 2 * pad - 14)]);
    chart = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du poids">
      <polyline class="w-line" points="${xy.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}"/>
      ${xy.map((p, i) => `<circle class="w-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === xy.length - 1 ? 4.5 : 3}"/>`).join('')}
      <text class="ch-val" x="${xy[0][0]}" y="${xy[0][1] - 9}" text-anchor="start">${kg(pts[0].kg)}</text>
      <text class="ch-val" x="${xy[xy.length - 1][0]}" y="${xy[xy.length - 1][1] - 9}" text-anchor="end">${kg(pts[pts.length - 1].kg)}</text>
    </svg>`;
  }
  const diff = ws.length >= 2 ? ws[ws.length - 1].kg - ws[0].kg : 0;
  const list = ws
    .slice(-5)
    .reverse()
    .map(
      (w) => `<div class="swipe"><div class="row swipe-content"><div class="row-main"><b>${kg(w.kg)}</b><small>${dfLong.format(fromKey(w.date))}</small></div></div>
      <button class="swipe-del" data-act="del-weight" data-date="${w.date}" aria-label="Supprimer la pesée du ${dfLong.format(fromKey(w.date))}">Supprimer</button></div>`
    )
    .join('');
  return `${chart}${ws.length >= 2 ? `<p class="muted">${diff === 0 ? 'Poids stable' : `${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(1).replace('.', ',')} kg`} depuis le ${dfShort.format(fromKey(ws[0].date))}</p>` : ''}${list}`;
}

const kg = (v) => `${String(Math.round(v * 10) / 10).replace('.', ',')} kg`;

// ---------- Profil ----------

function profileFields(p) {
  p = p || {};
  return `
    <label class="field">Prénom <input name="name" autocomplete="given-name" value="${esc(p.name || '')}" placeholder="Optionnel"></label>
    <fieldset class="seg" aria-label="Sexe">
      <label><input type="radio" name="sex" value="m" ${p.sex !== 'f' ? 'checked' : ''}><span>Homme</span></label>
      <label><input type="radio" name="sex" value="f" ${p.sex === 'f' ? 'checked' : ''}><span>Femme</span></label>
    </fieldset>
    <label class="field">Date de naissance <input name="birthDate" type="date" required max="${todayKey()}" value="${esc(p.birthDate || '')}"></label>
    <div class="grid2">
      <label class="field">Taille (cm) <input name="heightCm" type="number" inputmode="numeric" min="100" max="230" required value="${p.heightCm || ''}"></label>
      <label class="field">Poids (kg) <input name="weightKg" type="number" inputmode="decimal" min="30" max="300" step="0.1" required value="${p.weightKg || ''}"></label>
    </div>
    <fieldset class="seg" aria-label="Objectif">
      <label><input type="radio" name="goal" value="loss" ${p.goal !== 'gain' ? 'checked' : ''}><span>Perte de poids</span></label>
      <label><input type="radio" name="goal" value="gain" ${p.goal === 'gain' ? 'checked' : ''}><span>Prise de masse</span></label>
    </fieldset>
    <label class="field">Déficit ou surplus visé par jour (kcal) <input name="targetKcal" type="number" inputmode="numeric" min="0" max="1500" step="50" value="${goalOf(p).kcal || ''}" placeholder="Optionnel, ex. 300"></label>
    <small class="muted">Perte de poids : calories à manger en moins que ta dépense. Prise de masse : calories à manger en plus.</small>
    <label class="field">Objectif de protéines par jour (g) <input name="proteinGoal" type="number" inputmode="numeric" min="0" max="400" step="5" value="${p.proteinGoal || ''}" placeholder="Optionnel, ex. 120"></label>
    ${p.weightKg ? `<small class="muted">Repère courant chez les sportifs : 1,6 à 2 g par kg de poids, soit ${fmt(p.weightKg * 1.6)} à ${fmt(p.weightKg * 2)} g pour toi.</small>` : '<small class="muted">Repère courant chez les sportifs : 1,6 à 2 g par kg de poids.</small>'}`;
}

function authView() {
  const signup = ui.authMode === 'signup';
  return `
  <section class="welcome">
    <img src="icons/icon.svg" alt="" width="72" height="72">
    <h1>Équilibre</h1>
    <p>${signup ? 'Crée ton compte pour sauvegarder tes données en ligne.' : 'Connecte-toi pour retrouver tes données.'}</p>
  </section>
  <form class="card form" data-form="auth">
    <label class="field">E-mail <input name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="none" required></label>
    <label class="field">Mot de passe <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6" required></label>
    ${signup ? '<small class="muted">6 caractères minimum.</small>' : ''}
    <p id="auth-msg" class="error" role="alert" hidden></p>
    <button class="btn" type="submit">${signup ? 'Créer mon compte' : 'Se connecter'}</button>
    <button class="link" type="button" data-act="auth-mode">${signup ? "J'ai déjà un compte" : 'Créer un compte'}</button>
  </form>`;
}

function syncLabel() {
  const st = sync.status;
  if (!sync.currentUser()) return 'Hors ligne : tes changements seront envoyés au retour de la connexion.';
  if (st.state === 'syncing') return 'Synchronisation…';
  if (st.state === 'offline') return 'Hors ligne : tes changements seront envoyés au retour de la connexion.';
  if (st.state === 'ok') return `Synchronisé à ${st.at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  return 'En attente de synchronisation';
}

function onboardingView() {
  return `
  <section class="welcome">
    <img src="icons/icon.svg" alt="" width="72" height="72">
    <h1>Équilibre</h1>
    <p>Suis tes calories dépensées et ingérées, jour après jour. Commençons par ton profil pour calculer ton métabolisme de base.</p>
  </section>
  <form class="card form" data-form="profile">
    ${profileFields(null)}
    <button class="btn" type="submit">Commencer</button>
    <small class="muted center">Tes données restent sur cet appareil.</small>
  </form>`;
}

function profileView() {
  const p = profile();
  const today = todayKey();
  const b = bmr({ sex: p.sex, weightKg: store.weightAt(today), heightCm: p.heightCm, age: ageAt(p.birthDate, today) });
  return `
  <header class="top solo"><div class="top-title"><h1>${p.name ? esc(p.name) : 'Profil'}</h1><p>Ton métabolisme de base : <b>${fmt(b)} kcal / jour</b></p></div></header>
  <form class="card form" data-form="profile">
    ${profileFields(p)}
    <button class="btn" type="submit">Enregistrer</button>
  </form>
  <section class="card">
    <div class="card-head"><h2>Comment c'est calculé</h2></div>
    <ul class="notes">
      <li><b>Métabolisme de base</b> : formule de Mifflin-St Jeor (sexe, âge, taille, poids).</li>
      <li><b>Pas</b> : distance estimée d'après ta taille, puis environ 0,5 kcal par kg et par km.</li>
      <li><b>Calibrage</b> : dans l'onglet Bilan, ta dépense réelle est déduite de tes repas et de tes pesées, à raison de 7 700 kcal par kg.</li>
      <li><b>Nutriments</b> : repris de la base Open Food Facts au scan, de valeurs moyennes pour les aliments courants, ou de ta saisie.</li>
      <li><b>Séances</b> : saisis les calories <em>actives</em> de ta montre, pas les calories totales.</li>
      <li>Ce sont des estimations : fie-toi à la tendance de la semaine plus qu'à un jour isolé.</li>
    </ul>
  </section>
  <section class="card">
    <div class="card-head"><h2>Compte et données</h2></div>
    <p class="muted">${sync.currentUser() ? `Connecté : <b>${esc(sync.currentUser().email)}</b><br>` : ''}Tes données sont enregistrées sur cet appareil et sauvegardées en ligne sur ton compte.</p>
    <p id="sync-status" class="sync-status" role="status">${syncLabel()}</p>
    <p id="ai-usage" class="muted"></p>
    <div class="btn-row">
      <button class="btn secondary" data-act="export">Exporter</button>
      <label class="btn secondary">Importer<input type="file" accept="application/json,.json" data-change="import" hidden></label>
    </div>
    <button class="btn secondary wide" data-act="logout">Se déconnecter</button>
    <button class="link danger" data-act="reset">Tout effacer</button>
  </section>`;
}

// ---------- Feuilles (fenêtres du bas) ----------

function openSheet(title, body) {
  $('#sheet-root').innerHTML = `
    <div class="backdrop" data-act="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-act="close-sheet" aria-label="Fermer">×</button></div>
      ${body}
    </div>`;
  document.body.classList.add('sheet-open');
}

function closeSheet() {
  stopScanner();
  $('#sheet-root').innerHTML = '';
  document.body.classList.remove('sheet-open');
}

let suggestions = [];

function openFoodSheet(mealId) {
  const meal = MEALS.find((m) => m.id === mealId);
  openSheet(`${meal.icon} ${meal.label}`, `
    <form class="form" data-form="food" data-meal="${mealId}" novalidate>
      <div class="btn-row three">
        <button type="button" class="btn secondary stack" data-act="scan"><span aria-hidden="true">▮▯▮</span>Scanner</button>
        <button type="button" class="btn secondary stack" data-act="history" aria-expanded="false" aria-controls="history"><span aria-hidden="true">↺</span>Historique</button>
        <label class="btn secondary stack"><span aria-hidden="true">📷</span>Photo<input type="file" accept="image/*" data-change="photo" hidden></label>
      </div>
      <div id="history" class="history" hidden></div>
      <div id="photo-zone" class="photo-zone" hidden>
        <img id="photo-preview" alt="Photo du plat à analyser">
        <label class="field">Description du plat <small>(optionnel, mais rend l'estimation bien plus précise)</small>
          <textarea id="photo-desc" rows="3" maxlength="600" placeholder="Ex. 200 g de riz, blanc de poulet cuit à l'huile d'olive, sauce au yaourt"></textarea></label>
        <button type="button" class="btn" data-act="analyze">Analyser la photo</button>
      </div>
      <div id="photo-result" class="photo-result" hidden></div>
      <div id="scan-zone" hidden>
        <div id="reader"></div>
        <div class="inline">
          <input id="barcode" inputmode="numeric" placeholder="Ou tape le code-barres" aria-label="Code-barres">
          <button type="button" class="btn secondary small" data-act="lookup">Chercher</button>
        </div>
      </div>
      <p id="scan-msg" class="scan-msg" hidden></p>
      <label class="field">Aliment <input name="name" autocomplete="off" placeholder="Ex. riz, yaourt, pomme…" required></label>
      <div id="suggest" class="chips"></div>
      <fieldset class="seg" aria-label="Mode de saisie">
        <label><input type="radio" name="mode" value="total" checked><span>Calories totales</span></label>
        <label><input type="radio" name="mode" value="per100"><span>Pour 100 g</span></label>
      </fieldset>
      <div data-mode="total">
        <label class="field">Calories (kcal) <input name="kcal" type="number" inputmode="decimal" min="0" step="1"></label>
      </div>
      <div data-mode="per100" class="grid2" hidden>
        <label class="field">kcal / 100 g <input name="kcal100" type="number" inputmode="decimal" min="0" step="1"></label>
        <label class="field">Quantité (g) <input name="qty" type="number" inputmode="decimal" min="0" step="1"></label>
      </div>
      <fieldset class="macros">
        <legend>Nutriments <span id="macro-unit">au total</span> <small>(optionnel)</small></legend>
        <div class="grid3">
          ${MACROS.map(({ id, label }) => `<label class="field">${label} (g) <input name="m_${id}" type="number" inputmode="decimal" min="0" step="0.1"></label>`).join('')}
        </div>
      </fieldset>
      <p id="food-preview" class="preview" hidden></p>
      <p id="food-error" class="error" hidden></p>
      <button class="btn" type="submit">Ajouter</button>
    </form>`);
  updateSuggestions($('[data-form="food"]'));
}

function foodKcal(form) {
  if (form.mode.value === 'per100') return (num(form.kcal100.value) * num(form.qty.value)) / 100;
  return num(form.kcal.value);
}

// Nutriments du formulaire, en grammes pour la quantité saisie.
// Renvoie { macros, macros100 } (macros100 seulement en mode « pour 100 g »).
function foodMacros(form) {
  const per100 = form.mode.value === 'per100';
  const qty = num(form.qty.value);
  const macros = {}, macros100 = {};
  let any = false;
  for (const { id } of MACROS) {
    const raw = form[`m_${id}`].value.trim();
    if (raw === '') continue;
    any = true;
    const v = Math.max(0, num(raw));
    if (per100) macros100[id] = v;
    macros[id] = Math.round((per100 ? (v * qty) / 100 : v) * 10) / 10;
  }
  if (!any) return {};
  return per100 ? { macros, macros100 } : { macros };
}

function syncFoodForm(form) {
  const per100 = form.mode.value === 'per100';
  $('[data-mode="total"]', form).hidden = per100;
  $('[data-mode="per100"]', form).hidden = !per100;
  const prev = $('#food-preview');
  const k = foodKcal(form);
  $('#macro-unit').textContent = per100 ? 'pour 100 g' : 'au total';
  const line = macroLine(foodMacros(form).macros);
  prev.hidden = !(per100 && k > 0);
  prev.innerHTML = `= ${fmt(k)} kcal${line ? `<small>${line}</small>` : ''}`;
  $('#food-error').hidden = true;
}

function updateSuggestions(form) {
  const q = norm(form.name.value.trim());
  const recents = store.recentFoods().map((it) => ({ ...it, recent: true }));
  let list;
  if (!q) list = []; // rien tant qu'on n'a pas tapé : l'historique a son bouton
  else {
    const inRecents = recents.filter((r) => norm(r.name).includes(q));
    const names = new Set(inRecents.map((r) => norm(r.name)));
    const inDb = FOODS.filter(([n]) => norm(n).includes(q) && !names.has(norm(n)))
      .sort((a, b) => norm(a[0]).indexOf(q) - norm(b[0]).indexOf(q))
      .map(([name, kcal100, qty, protein, carbs, fiber]) => ({ name, kcal100, qty, macros100: { protein, carbs, fiber } }));
    list = [...inRecents, ...inDb].slice(0, 6);
  }
  suggestions = list;
  $('#suggest').innerHTML = list
    .map(
      (s, i) =>
        `<button type="button" class="chip" data-act="pick-food" data-i="${i}">${s.recent ? '↺ ' : ''}${esc(s.name)} <small>${s.kcal100 ? `${fmt(s.kcal100)}/100 g` : `${fmt(s.kcal)} kcal`}</small></button>`
    )
    .join('');
}

// Historique : aliments déjà saisis, du plus récent au plus ancien.
let historyItems = [];

function toggleHistory(force) {
  const panel = $('#history');
  const btn = $('[data-act="history"]');
  const open = force ?? panel.hidden;
  if (open) {
    stopScanner();
    $('#scan-zone').hidden = true;
    $('#photo-zone').hidden = true;
    scanMsg('');
    historyItems = store.recentFoods(40);
    panel.innerHTML = historyItems.length
      ? historyItems
          .map(
            (it, i) => `<button type="button" class="history-item" data-act="pick-history" data-i="${i}">
              <span class="row-main"><b>${esc(it.name)}</b><small>${it.qty ? `${fmt(it.qty)} g · ${fmt(it.kcal100)} kcal/100 g` : 'Calories totales'}</small></span>
              <span class="row-val">${fmt(it.kcal)}</span></button>`
          )
          .join('')
      : '<p class="muted">Aucun aliment enregistré pour l\'instant.</p>';
  }
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

function fillFood(form, s) {
  form.name.value = s.name;
  if (s.kcal100) {
    form.mode.value = 'per100';
    form.kcal100.value = s.kcal100;
    form.qty.value = s.qty || 100;
  } else {
    form.mode.value = s.kcal != null ? 'total' : 'per100';
    form.kcal.value = s.kcal ?? '';
    if (s.kcal == null) form.qty.value = s.qty || 100;
  }
  // Nutriments : pour 100 g si l'aliment est saisi ainsi, sinon au total.
  const src = form.mode.value === 'per100' ? s.macros100 : s.macros;
  for (const { id } of MACROS) form[`m_${id}`].value = src?.[id] ?? '';
  syncFoodForm(form);
  $('#suggest').innerHTML = '';
}

function scanMsg(text, kind = '') {
  const el = $('#scan-msg');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  el.className = `scan-msg ${kind}`;
}

async function handleCode(code) {
  await stopScanner();
  const zone = $('#scan-zone');
  if (!zone) return;
  zone.hidden = true;
  scanMsg(`Recherche du produit ${code}…`);
  try {
    const p = await lookupProduct(code);
    const form = $('[data-form="food"]');
    if (!form) return;
    fillFood(form, { name: p.name, kcal100: p.kcal100, qty: p.portion, kcal: null, macros100: p.macros100 });
    scanMsg(
      p.kcal100 ? `Produit trouvé. Vérifie la quantité mangée.` : `Produit trouvé, mais sans calories dans la base : complète-les.`,
      p.kcal100 ? 'ok' : 'warn'
    );
    (p.kcal100 ? form.qty : form.kcal100).focus();
  } catch (e) {
    scanMsg(e.message, 'warn');
  }
}

// ---------- Analyse d'une photo par IA ----------

const PHOTO_MAX_SIDE = 1568; // au-delà, l'IA réduit l'image de toute façon
let photo = null; // { image (base64), mediaType }

// Réduit la photo et la convertit en JPEG (les photos de téléphone sont lourdes).
async function preparePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { dataUrl, image: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function pickPhoto(file) {
  if (!file || !$('#photo-zone')) return;
  await stopScanner();
  toggleHistory(false);
  $('#scan-zone').hidden = true;
  $('#photo-result').hidden = true;
  try {
    const p = await preparePhoto(file);
    photo = { image: p.image, mediaType: p.mediaType };
    $('#photo-preview').src = p.dataUrl;
    $('#photo-zone').hidden = false;
    scanMsg('Ajoute une description si tu peux, puis lance l\'analyse.');
  } catch (e) {
    console.warn(e);
    photo = null;
    scanMsg("Cette image ne peut pas être lue. Essaie avec une autre photo.", 'warn');
  }
}

const CONFIDENCE = { high: 'Confiance : bonne', medium: 'Confiance : moyenne', low: 'Confiance : faible' };

async function analyzePhoto() {
  if (!photo) return;
  const btn = $('[data-act="analyze"]');
  btn.disabled = true;
  btn.textContent = 'Analyse en cours…';
  scanMsg("L'IA regarde ta photo. Cela prend 10 à 30 secondes.");
  try {
    const r = await sync.analyzePhoto({ ...photo, description: $('#photo-desc').value.trim() });
    const form = $('[data-form="food"]');
    if (!form) return; // fenêtre fermée entre-temps
    if (!r.is_food) {
      scanMsg(r.note || "Aucun aliment reconnu sur cette photo.", 'warn');
      return;
    }
    fillFood(form, { name: r.dish, kcal: r.total.kcal, macros: { protein: r.total.protein, carbs: r.total.carbs, fiber: r.total.fiber } });
    $('#photo-zone').hidden = true;
    const result = $('#photo-result');
    result.innerHTML = `
      <div class="card-head"><h3>Détail de l'estimation</h3><small class="muted">${CONFIDENCE[r.confidence] || ''}</small></div>
      ${r.items.map((it) => `<div class="result-item"><span><b>${esc(it.name)}</b><small>${fmt(it.grams)} g · ${macroLine(it)}</small></span><span class="row-val">${fmt(it.kcal)}<small>kcal</small></span></div>`).join('')}
      ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}
      <small class="muted">Coût de cette analyse : ≈ ${r.cost_usd.toFixed(3).replace('.', ',')} $</small>`;
    result.hidden = false;
    scanMsg('Estimation faite. Vérifie et corrige les valeurs ci-dessous avant d\'ajouter.', 'ok');
  } catch (e) {
    scanMsg(e.message, 'warn');
  } finally {
    const b = $('[data-act="analyze"]');
    if (b) {
      b.disabled = false;
      b.textContent = 'Analyser la photo';
    }
  }
}

async function startScan() {
  const zone = $('#scan-zone');
  toggleHistory(false);
  $('#photo-zone').hidden = true;
  zone.hidden = false;
  scanMsg('Place le code-barres dans le cadre, à 20–30 cm, bien net. La lecture est automatique.');
  try {
    await startScanner('reader', handleCode);
  } catch (e) {
    console.warn(e);
    scanMsg("Caméra indisponible. Tape le code-barres ci-dessus, ou saisis l'aliment à la main.", 'warn');
  }
}

function openWorkoutSheet() {
  openSheet('🏋️ Séance de sport', `
    <form class="form" data-form="workout">
      <label class="field">Activité <input name="name" list="sports" required placeholder="Ex. Musculation" autocomplete="off"></label>
      <datalist id="sports">${['Musculation', 'Course à pied', 'Vélo', 'Natation', 'Marche', 'Randonnée', 'HIIT', 'Football', 'Tennis', 'Yoga', 'Boxe', 'CrossFit'].map((s) => `<option value="${s}">`).join('')}</datalist>
      <div class="grid2">
        <label class="field">Calories actives (kcal) <input name="kcal" type="number" inputmode="numeric" min="1" required></label>
        <label class="field">Durée (min) <input name="minutes" type="number" inputmode="numeric" min="0" placeholder="Optionnel"></label>
      </div>
      <label class="field">Pas faits pendant la séance <input name="steps" type="number" inputmode="numeric" min="0" placeholder="Optionnel (course, marche…)"></label>
      <small class="muted">Ces pas sont retirés du total de la journée pour ne pas compter deux fois la même dépense. Utilise les calories <b>actives</b> de ta montre.</small>
      <button class="btn" type="submit">Ajouter la séance</button>
    </form>`);
  $('[data-form="workout"] [name="name"]').focus();
}

function openWeightSheet() {
  openSheet('⚖️ Nouvelle pesée', `
    <form class="form" data-form="weight">
      <div class="grid2">
        <label class="field">Poids (kg) <input name="kg" type="number" inputmode="decimal" min="30" max="300" step="0.1" required value="${store.weightAt(todayKey()) || ''}"></label>
        <label class="field">Date <input name="date" type="date" required max="${todayKey()}" value="${todayKey()}"></label>
      </div>
      <button class="btn" type="submit">Enregistrer</button>
    </form>`);
}

// ---------- Événements ----------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'tab':
      ui.view = d.view;
      render();
      if (d.view === 'profile') showAiUsage();
      window.scrollTo(0, 0);
      break;
    case 'day-shift': {
      const next = addDays(ui.date, Number(d.n));
      if (next <= todayKey()) ui.date = next;
      render();
      break;
    }
    case 'week-shift': {
      const next = addDays(ui.week, Number(d.n));
      if (next <= todayKey()) ui.week = next;
      render();
      break;
    }
    case 'go-day':
      ui.date = d.key;
      ui.view = 'day';
      render();
      window.scrollTo(0, 0);
      break;
    case 'open-food':
      openFoodSheet(d.meal);
      break;
    case 'open-workout':
      openWorkoutSheet();
      break;
    case 'open-weight':
      openWeightSheet();
      break;
    case 'apply-calibration':
      store.getState().profile.calibration = Number(d.factor);
      store.save();
      render();
      toast('Correction appliquée');
      break;
    case 'clear-calibration':
      delete store.getState().profile.calibration;
      store.save();
      render();
      toast('Correction retirée');
      break;
    case 'close-sheet':
      closeSheet();
      break;
    case 'scan':
      startScan();
      break;
    case 'lookup': {
      const code = $('#barcode').value.replace(/\D/g, '');
      if (code.length < 8) scanMsg('Le code-barres doit contenir au moins 8 chiffres.', 'warn');
      else handleCode(code);
      break;
    }
    case 'pick-food':
      fillFood(el.closest('form'), suggestions[Number(d.i)]);
      break;
    case 'history':
      toggleHistory();
      break;
    case 'analyze':
      analyzePhoto();
      break;
    case 'pick-history':
      fillFood(el.closest('form'), historyItems[Number(d.i)]);
      toggleHistory(false);
      break;
    case 'del-food':
      store.updateDay(ui.date, (day) => {
        day.meals[d.meal] = day.meals[d.meal].filter((it) => it.id !== d.id);
      });
      render();
      break;
    case 'del-workout':
      store.updateDay(ui.date, (day) => {
        day.workouts = day.workouts.filter((w) => w.id !== d.id);
      });
      render();
      break;
    case 'copy-prev': {
      const prev = store.getDay(addDays(ui.date, -1)).meals[d.meal];
      store.updateDay(ui.date, (day) => {
        day.meals[d.meal] = prev.map((it) => ({ ...it, id: store.uid() }));
      });
      render();
      break;
    }
    case 'del-weight':
      store.removeWeight(d.date);
      render();
      break;
    case 'export':
      exportData();
      break;
    case 'auth-mode':
      ui.authMode = ui.authMode === 'signup' ? 'signin' : 'signup';
      render();
      break;
    case 'logout':
      logout();
      break;
    case 'retry-sync':
      sync.status.state = 'syncing';
      render();
      runSync();
      break;
    case 'reset':
      if (confirm('Effacer définitivement toutes tes données, sur cet appareil et en ligne ?')) {
        store.resetState();
        ui.view = 'day';
        render();
      }
      break;
  }
});

document.addEventListener('input', (e) => {
  const form = e.target.closest('[data-form="food"]');
  if (!form) return;
  if (e.target.name === 'name') updateSuggestions(form);
  syncFoodForm(form);
});

document.addEventListener('change', (e) => {
  const kind = e.target.dataset.change;
  if (kind === 'steps') {
    const v = Math.max(0, Math.round(num(e.target.value)));
    store.updateDay(ui.date, (day) => {
      day.steps = v;
    });
    render();
  } else if (kind === 'import') {
    importData(e.target.files[0]);
  } else if (kind === 'photo') {
    pickPhoto(e.target.files[0]);
    e.target.value = ''; // permet de reprendre la même photo
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = form.elements;
  switch (form.dataset.form) {
    case 'auth':
      submitAuth(form);
      break;
    case 'profile': {
      const first = !profile();
      const old = profile();
      const next = {
        name: f.name.value.trim(),
        sex: f.sex.value,
        birthDate: f.birthDate.value,
        heightCm: num(f.heightCm.value),
        weightKg: num(f.weightKg.value),
        goal: f.goal.value === 'gain' ? 'gain' : 'loss',
        targetKcal: Math.max(0, Math.round(num(f.targetKcal.value))),
        proteinGoal: Math.max(0, Math.round(num(f.proteinGoal.value))),
      };
      if (old?.calibration) next.calibration = old.calibration; // la correction survit à la modification du profil
      store.getState().profile = next;
      store.save();
      if (first || old.weightKg !== next.weightKg) store.setWeight(todayKey(), next.weightKg);
      if (first) ui.view = 'day';
      render();
      toast(first ? 'Bienvenue !' : 'Profil enregistré');
      break;
    }
    case 'food': {
      const name = f.name.value.trim();
      const kcal = foodKcal(form);
      const err = $('#food-error');
      if (!name || !(kcal > 0)) {
        err.textContent = !name ? "Indique le nom de l'aliment." : 'Indique les calories (et la quantité).';
        err.hidden = false;
        return;
      }
      const item = { id: store.uid(), name, kcal: Math.round(kcal) };
      if (form.mode.value === 'per100') {
        item.kcal100 = num(f.kcal100.value);
        item.qty = num(f.qty.value);
      }
      Object.assign(item, foodMacros(form));
      store.updateDay(ui.date, (day) => day.meals[form.dataset.meal].push(item));
      closeSheet();
      render();
      toast(`${name} ajouté · ${fmt(item.kcal)} kcal`);
      break;
    }
    case 'workout': {
      const w = {
        id: store.uid(),
        name: f.name.value.trim(),
        kcal: Math.round(num(f.kcal.value)),
        minutes: Math.round(num(f.minutes.value)),
        steps: Math.round(num(f.steps.value)),
      };
      store.updateDay(ui.date, (day) => day.workouts.push(w));
      closeSheet();
      render();
      toast(`Séance ajoutée · ${fmt(w.kcal)} kcal`);
      break;
    }
    case 'weight':
      store.setWeight(f.date.value, num(f.kg.value));
      closeSheet();
      render();
      toast('Pesée enregistrée');
      break;
  }
});

// ---------- Glisser vers la gauche pour supprimer ----------

const SWIPE_W = 104; // largeur du bouton « Supprimer »
let drag = null;
let swallowClick = false;

function closeSwipes(except) {
  document.querySelectorAll('.swipe.open').forEach((el) => {
    if (el !== except) el.classList.remove('open');
  });
}

document.addEventListener('pointerdown', (e) => {
  const content = e.target.closest('.swipe-content');
  const wrap = e.target.closest('.swipe');
  closeSwipes(wrap);
  if (!content || (e.pointerType === 'mouse' && e.button !== 0)) return;
  drag = { wrap, content, x0: e.clientX, y0: e.clientY, base: wrap.classList.contains('open') ? -SWIPE_W : 0, x: 0, active: false };
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  if (!drag.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (drag = null); // défilement vertical
    if (Math.abs(dx) < 8) return;
    drag.active = true;
    drag.content.style.transition = 'none';
  }
  drag.x = Math.max(-SWIPE_W - 24, Math.min(0, drag.base + dx));
  drag.content.style.transform = `translateX(${drag.x}px)`;
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.active) {
    // Simple appui sur une ligne ouverte : on la referme.
    d.wrap.classList.remove('open');
    return;
  }
  d.content.style.transition = '';
  d.content.style.transform = '';
  d.wrap.classList.toggle('open', d.x < -SWIPE_W / 2);
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 50);
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// Le clic qui suit un glissement ne doit rien déclencher.
document.addEventListener('click', (e) => {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

// Au clavier : le bouton « Supprimer » se dévoile quand il reçoit le focus.
document.addEventListener('focusin', (e) => {
  if (e.target.classList?.contains('swipe-del')) {
    closeSwipes();
    e.target.closest('.swipe').classList.add('open');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#sheet-root').innerHTML) closeSheet();
});

// ---------- Sauvegarde ----------

function exportData() {
  const blob = new Blob([JSON.stringify(store.getState(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `equilibre-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm('Remplacer les données actuelles par cette sauvegarde ?')) return;
    store.replaceState(data);
    render();
    toast('Sauvegarde importée');
  } catch (e) {
    toast('Fichier de sauvegarde invalide');
  }
}

// ---------- Compte et synchronisation ----------

// Mémorise qu'une première synchronisation a réussi pour ce compte sur cet appareil.
const SYNCED_KEY = 'equilibre.synced';
const wasSynced = (userId) => {
  try {
    return localStorage.getItem(SYNCED_KEY) === userId;
  } catch (e) {
    return false;
  }
};

// Affiche dans le Profil le nombre d'analyses photo du mois et leur coût estimé.
async function showAiUsage() {
  const u = await sync.aiUsageThisMonth();
  const el = $('#ai-usage');
  if (!el || !u) return;
  el.innerHTML = u.count
    ? `Analyses photo ce mois-ci : <b>${u.count}</b>, soit environ <b>${u.cost.toFixed(2).replace('.', ',')} $</b>.`
    : 'Aucune analyse photo ce mois-ci.';
}

async function runSync() {
  const result = await sync.sync();
  if (result !== 'error' && !ui.synced) {
    ui.synced = true;
    try {
      localStorage.setItem(SYNCED_KEY, sync.currentUser().id);
    } catch (e) {}
    if (!profile()) return render(), result;
  } else if (result === 'error' && !ui.synced && ui.auth === 'in') {
    render();
  }
  // Des données plus récentes sont arrivées : on réaffiche, sauf si une saisie est en cours.
  if (result === 'pulled' && !$('#sheet-root').innerHTML) render();
  return result;
}

async function submitAuth(form) {
  const msg = $('#auth-msg');
  const btn = $('button[type="submit"]', form);
  const email = form.email.value.trim();
  const password = form.password.value;
  msg.hidden = true;
  btn.disabled = true;
  try {
    const user = ui.authMode === 'signup' ? await sync.signUp(email, password) : await sync.signIn(email, password);
    if (!user) {
      // Compte créé, mais l'adresse doit être confirmée par e-mail.
      ui.authMode = 'signin';
      render();
      const m = $('#auth-msg');
      m.textContent = "Compte créé. Ouvre l'e-mail de confirmation que tu viens de recevoir, puis connecte-toi ici.";
      m.className = 'scan-msg ok';
      m.hidden = false;
      return;
    }
    store.setOwner(user.id);
    ui.synced = wasSynced(user.id);
    ui.auth = 'in';
    ui.view = 'day';
    render();
    await runSync(); // récupère les données du compte avant de proposer de créer un profil
  } catch (e) {
    msg.textContent = e.message;
    msg.hidden = false;
    btn.disabled = false;
  }
}

async function logout() {
  if (sync.hasPending() && sync.status.state === 'offline' && !confirm("Tes derniers changements n'ont pas encore été envoyés en ligne et seront perdus. Se déconnecter quand même ?")) return;
  await sync.flush();
  await sync.signOut();
  store.clearLocal();
  try {
    localStorage.removeItem(SYNCED_KEY);
  } catch (e) {}
  ui.synced = false;
  ui.auth = 'out';
  ui.authMode = 'signin';
  render();
}

store.setChangeListener(() => sync.schedulePush());
sync.setStatusListener(() => {
  const el = $('#sync-status');
  if (el) el.textContent = syncLabel();
});

async function boot() {
  let user = null;
  try {
    user = await sync.init();
  } catch (e) {
    console.warn(e);
  }
  if (user) {
    store.setOwner(user.id);
    ui.synced = wasSynced(user.id);
    ui.auth = 'in';
    render();
    runSync();
  } else if (!navigator.onLine && store.getState().owner) {
    // Hors ligne avec un compte déjà utilisé sur cet appareil : l'app reste utilisable.
    ui.synced = wasSynced(store.getState().owner);
    ui.auth = 'in';
    render();
  } else {
    ui.auth = 'out';
    render();
  }
}

window.addEventListener('online', () => {
  if (sync.currentUser()) runSync();
  else if (ui.auth === 'in') boot();
});
document.addEventListener('visibilitychange', () => {
  if (ui.auth !== 'in' || !sync.currentUser()) return;
  if (document.visibilityState === 'visible') runSync();
  else sync.flush();
});

// ---------- Démarrage ----------

render();
boot();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn(e));
}
