// Scrapes everynoise.com: genre index + per-genre artist/related-genre lists.
// Output: data/genre-index.json, data/genres/<slug>.json

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data');
const GENRES_DIR = path.join(OUT_DIR, 'genres');
const CONCURRENCY = 6;
const RETRY_COUNT = 2;

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&raquo;/g, '»');
}

function parseGenrePage(html) {
  const re = /onclick="playx\(&quot;([^"]*?)&quot;,\s*&quot;(.*?)&quot;,\s*this\);"[\s\S]*?>([^<]*)<a class=navlink href="([^"]+)"/g;
  const artists = [];
  const related = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = decodeEntities(m[2]);
    const href = m[4];
    if (href.startsWith('artistprofile')) artists.push(name);
    else if (href.startsWith('engenremap-')) related.push(name);
  }
  return { artists, related };
}

async function fetchWithRetry(url, retries) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (personal genre-dig tool; contact via github)' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.text();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

async function main() {
  fs.mkdirSync(GENRES_DIR, { recursive: true });

  console.log('Fetching homepage genre list...');
  const homeHtml = await fetchWithRetry('https://everynoise.com/', RETRY_COUNT);
  const re = /class="?genre[^>]*>([^<]+)<a class=navlink href="(engenremap-[^"]+\.html)"/g;
  const genres = [];
  const seenSlugs = new Set();
  let m;
  while ((m = re.exec(homeHtml)) !== null) {
    const name = decodeEntities(m[1]).trim();
    const slug = m[2].replace(/^engenremap-/, '').replace(/\.html$/, '');
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    genres.push({ name, slug });
  }
  console.log(`Found ${genres.length} genres.`);

  fs.writeFileSync(path.join(OUT_DIR, 'genre-index.json'), JSON.stringify(genres));

  let done = 0;
  let failed = [];
  const startTime = Date.now();

  async function worker(queue) {
    while (queue.length) {
      const g = queue.pop();
      const outPath = path.join(GENRES_DIR, g.slug + '.json');
      if (fs.existsSync(outPath)) { done++; continue; }
      try {
        const html = await fetchWithRetry(`https://everynoise.com/engenremap-${g.slug}.html`, RETRY_COUNT);
        const { artists, related } = parseGenrePage(html);
        fs.writeFileSync(outPath, JSON.stringify({ name: g.name, slug: g.slug, artists, related }));
      } catch (e) {
        failed.push(g.slug);
      }
      done++;
      if (done % 100 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`Progress: ${done}/${genres.length} (${elapsed}s elapsed)`);
      }
    }
  }

  const queue = [...genres];
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker(queue));
  await Promise.all(workers);

  console.log(`Done. ${done}/${genres.length} processed. ${failed.length} failed.`);
  if (failed.length) {
    fs.writeFileSync(path.join(OUT_DIR, 'failed-slugs.json'), JSON.stringify(failed));
    console.log('Failed slugs written to data/failed-slugs.json');
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
