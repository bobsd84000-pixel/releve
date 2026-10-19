// Relevé — vérification d'une clé de licence Lemon Squeezy
const cache = new Map(); // clé -> { valide, expire }

export async function licenceValide(cle) {
  const c = cache.get(cle);
  if (c && c.expire > Date.now()) return c.valide;
  let valide = false;
  try {
    const r = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'license_key=' + encodeURIComponent(cle)
    });
    const j = await r.json();
    valide = !!j.valid && ['active', 'inactive'].includes(j.license_key?.status);
    const boutique = process.env.LEMON_STORE_ID, produit = process.env.LEMON_PRODUCT_ID;
    if (boutique && String(j.meta?.store_id) !== String(boutique)) valide = false;
    if (produit && String(j.meta?.product_id) !== String(produit)) valide = false;
  } catch (e) { valide = false; }
  cache.set(cle, { valide, expire: Date.now() + 3600e3 });
  return valide;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST seulement' });
  const cle = String(req.body?.cle || '').trim();
  if (!cle) return res.status(400).json({ valide: false, erreur: 'Clé manquante' });
  res.status(200).json({ valide: await licenceValide(cle) });
}
