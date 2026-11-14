// Scan de code-barres : aperçu de la caméra arrière et lecture automatique
// (décodeur ZXing-C++ en WebAssembly, chargé à la demande), puis recherche
// du produit dans Open Food Facts.

const FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE'];
const MAX_SIDE = 1600; // taille maximale de l'image analysée
const BOX_RATIO = 4 / 3; // proportions de l'aperçu affiché (voir #reader dans le CSS)
const INTERVAL = 120; // pause entre deux analyses (ms)

let libPromise = null;
let session = null; // { stream, timer, host }

function loadLib() {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/zxing-reader.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Chargement du lecteur impossible'));
      document.head.appendChild(s);
    })
      .then(() =>
        window.ZXingWASM.prepareZXingModule({
          overrides: {
            locateFile: (path, prefix) =>
              path.endsWith('.wasm') ? new URL('vendor/zxing_reader.wasm', document.baseURI).href : prefix + path,
          },
          fireImmediately: true,
        })
      )
      .catch((e) => {
        libPromise = null;
        throw e;
      });
  }
  return libPromise;
}

// Cherche un code-barres produit dans une image (ImageData). Renvoie le code ou null.
export async function decode(imageData) {
  await loadLib();
  const results = await window.ZXingWASM.readBarcodes(imageData, { formats: FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
  const hit = results.find((r) => /^\d{8,14}$/.test(r.text || ''));
  return hit ? hit.text : null;
}

export async function startScanner(elementId, onCode) {
  await stopScanner();
  const host = document.getElementById(elementId);
  const lib = loadLib(); // en parallèle de l'ouverture de la caméra
  lib.catch(() => {});
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  const me = (session = { stream, timer: null, host });
  // Mise au point continue et léger zoom quand l'appareil le permet (ignoré sinon).
  // Le zoom incite à tenir le produit plus loin, là où la caméra fait le point.
  const track = stream.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() || {};
  const advanced = [];
  if (caps.focusMode?.includes?.('continuous')) advanced.push({ focusMode: 'continuous' });
  if (caps.zoom?.max >= 2) advanced.push({ zoom: 2 });
  if (advanced.length) track.applyConstraints({ advanced }).catch(() => {});

  host.innerHTML = '<video playsinline muted autoplay></video><div class="scan-frame" aria-hidden="true"></div>';
  const video = host.querySelector('video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  await lib;
  if (session !== me) return; // fermé entre-temps

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = async () => {
    if (session !== me) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      // On n'analyse que la partie de l'image visible dans l'aperçu (recadrage
      // centré, comme object-fit: cover) : plus rapide, et conforme à ce qu'on voit.
      const sw = vw / vh > BOX_RATIO ? vh * BOX_RATIO : vw;
      const sh = vw / vh > BOX_RATIO ? vh : vw / BOX_RATIO;
      const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
      canvas.width = Math.round(sw * k);
      canvas.height = Math.round(sh * k);
      ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
      try {
        const code = await decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if (code && session === me) {
          navigator.vibrate?.(60);
          onCode(code);
          return;
        }
      } catch (e) {
        console.warn(e);
      }
    }
    if (session === me) me.timer = setTimeout(tick, INTERVAL);
  };
  tick();
}

export async function stopScanner() {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timer);
  s.stream.getTracks().forEach((t) => t.stop());
  s.host.innerHTML = '';
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
