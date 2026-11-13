// Scan de code-barres (bibliothèque html5-qrcode, chargée à la demande)
// et recherche du produit dans Open Food Facts.

let libPromise = null;
let scanner = null;

function loadLib() {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/html5-qrcode.min.js';
      s.onload = resolve;
      s.onerror = () => {
        libPromise = null;
        reject(new Error('Chargement du scanner impossible'));
      };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

export async function startScanner(elementId, onCode) {
  await loadLib();
  await stopScanner();
  const F = window.Html5QrcodeSupportedFormats;
  scanner = new window.Html5Qrcode(elementId, {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
  let done = false;
  await scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: (w, h) => ({ width: Math.round(w * 0.85), height: Math.round(Math.min(h * 0.6, 160)) }) },
    (code) => {
      if (done) return;
      done = true;
      onCode(code);
    },
    () => {}
  );
}

export async function stopScanner() {
  if (!scanner) return;
  const s = scanner;
  scanner = null;
  try {
    if (s.isScanning) await s.stop();
    s.clear();
  } catch (e) {
    console.warn(e);
  }
}

// Renvoie { name, kcal100, portion } ou lève une erreur lisible.
export async function lookupProduct(code) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_fr,brands,nutriments,serving_quantity`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error('Pas de connexion à la base de produits.');
  }
  if (res.status === 404) throw new Error('Produit introuvable. Saisis-le à la main.');
  if (!res.ok) throw new Error('La base de produits ne répond pas.');
  const data = await res.json();
  const p = data.product;
  if (!p) throw new Error('Produit introuvable. Saisis-le à la main.');
  const n = p.nutriments || {};
  let kcal100 = Number(n['energy-kcal_100g']);
  if (!kcal100 && n['energy_100g']) kcal100 = Number(n['energy_100g']) / 4.184; // kJ → kcal
  const title = p.product_name_fr || p.product_name || 'Produit';
  const brand = (p.brands || '').split(',')[0].trim();
  return {
    name: brand && !title.toLowerCase().includes(brand.toLowerCase()) ? `${title} (${brand})` : title,
    kcal100: kcal100 ? Math.round(kcal100) : null,
    portion: Number(p.serving_quantity) || null,
  };
}
