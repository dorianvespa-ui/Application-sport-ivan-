# Équilibre

Application web (PWA) de suivi calorique : calories dépensées (métabolisme de base, pas, séances de sport) et calories ingérées (petit-déjeuner, déjeuner, en-cas, dîner), avec bilan par jour et par semaine.

## Fonctionnalités

- Profil et métabolisme de base (formule de Mifflin-St Jeor)
- Conversion des pas en calories, séances de sport saisies depuis la montre
- Repas : saisie libre, aliments courants intégrés, aliments récents, scan de code-barres (Open Food Facts)
- Bilan : déficit ou surplus par jour, totaux et moyennes par semaine, calendrier, suivi du poids
- Données enregistrées sur l'appareil (localStorage), export / import en JSON
- À venir : estimation des calories à partir d'une photo du plat

## Lancer en local

Aucune compilation, ce sont des fichiers statiques :

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Mettre en ligne

N'importe quel hébergement statique en HTTPS convient (GitHub Pages, Netlify, Vercel…). Le HTTPS est nécessaire pour la caméra (scan) et l'installation sur l'écran d'accueil.
