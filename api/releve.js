// Relevé — collecte des 30 derniers jours + résumé IA (Pro uniquement)
import { licenceValide } from './licence.js';

const JOUR = 86400, NB = 30;
const UA = 'web:releve:2.0 (par Relevé)';

async function jetonReddit() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
               'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) return null;
  return (await r.json()).access_token;
}

async function reddit(q) {
  const jeton = await jetonReddit();
  const base = jeton ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const headers = { 'user-agent': UA };
  if (jeton) headers.Authorization = 'Bearer ' + jeton;
  const r = await fetch(`${base}/search${jeton ? '' : '.json'}?q=${encodeURIComponent(q)}&sort=top&t=month&limit=60&raw_json=1`, { headers });
  if (!r.ok) throw new Error('reddit ' + r.status);
  const j = await r.json();
  return j.data.children.map(c => c.data).map(d => ({ titre: d.title, lien: 'https://www.reddit.com' + d.permalink,
    score: d.score || 0, com: d.num_comments || 0, t: d.created_utc, src: 'r/' + d.subreddit }));
}

async function hackerNews(q, depuis) {
  const r = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${depuis}&hitsPerPage=80`);
  if (!r.ok) throw new Error('hn ' + r.status);
  const j = await r.json();
  return j.hits.map(h => ({ titre: h.title, lien: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    score: h.points || 0, com: h.num_comments || 0, t: h.created_at_i, src: 'Hacker News' }));
}

async function github(q, depuis) {
  const d = new Date(depuis * 1000).toISOString().slice(0, 10);
  const headers = { 'user-agent': UA, accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+created:>${d}&sort=stars&order=desc&per_page=30`, { headers });
  if (!r.ok) throw new Error('github ' + r.status);
  const j = await r.json();
  return j.items.map(x => ({ titre: x.full_name + (x.description ? ' : ' + x.description : ''), lien: x.html_url,
    score: x.stargazers_count || 0, com: x.forks_count || 0, t: Date.parse(x.created_at) / 1000, src: 'GitHub' }));
}

async function resumeIA(q, items) {
  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) throw new Error('clé IA absente sur le serveur');
  const jour = t => new Date(t * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const liste = items.slice(0, 40).map(i => `- [${i.src}] ${i.titre} (${i.score} pts, ${i.com} réactions, ${jour(i.t)})`).join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.MODELE_IA || 'claude-sonnet-5-5', max_tokens: 700,
      system: 'Analyste de tendances. Français simple, phrases courtes. Réponds en JSON strict : {"resume":string,"tendances":[string],"a_surveiller":[string]}. 3 éléments max par liste.',
      messages: [{ role: 'user', content: `Sujet : ${q}\nPublications des 30 derniers jours :\n${liste}` }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'IA ' + r.status);
  const txt = j.content.map(c => c.text || '').join('');
  return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.status(400).json({ erreur: 'Sujet manquant' });

  const now = Math.floor(Date.now() / 1000), depuis = now - NB * JOUR;
  const noms = ['Reddit', 'Hacker News', 'GitHub'];
  const res3 = await Promise.allSettled([reddit(q), hackerNews(q, depuis), github(q, depuis)]);
  const sources = {};
  let items = [];
  res3.forEach((r, i) => {
    if (r.status === 'fulfilled') { sources[noms[i]] = r.value.length; items = items.concat(r.value.filter(x => x.t >= depuis)); }
    else sources[noms[i]] = null;
  });

  // Classement : réactions relatives à la source + petit bonus de volume
  const max = {};
  items.forEach(i => max[i.src] = Math.max(max[i.src] || 1, i.score + i.com));
  items = items.map(i => ({ ...i, poids: (i.score + i.com) / max[i.src] + Math.log10(1 + i.score + i.com) / 10 }))
               .sort((a, b) => b.poids - a.poids);

  let pro = false, synthese = null, erreurIA = null;
  const licence = String(req.headers['x-licence'] || '').trim();
  if (licence && items.length) {
    pro = await licenceValide(licence);
    if (pro) { try { synthese = await resumeIA(q, items); } catch (e) { erreurIA = e.message; } }
  }
  res.status(200).json({ q, sources, items: items.slice(0, 150), pro, synthese, erreurIA });
}
