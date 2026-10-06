#!/usr/bin/env node
// SAVI indicator METADATA harvester.
//
// Values are captured by harvest.js; this script captures the per-indicator
// metadata ("About the Data": source, description, methodology, units, vintage).
//
// How it works (no headed browser, minimal server load):
//   1. Every results-table popup we already saved (output/raw, output/shallow_raw)
//      embeds each indicator's stable class-column id (IMS_CLS_COLUMNID) inside the
//      Print button onclick, e.g. PrintVulnTable('1673096,1657671,...'). We mine
//      those files for the full set of unique ids.
//   2. Metadata is served as a standalone, self-describing document over a plain
//      stateless GET:
//        /savi/Print/PrintMetadata.aspx?DataFormat=VulnMeta&IMS_CLS_COLUMNID=<id>&Type=Simple|FGDC&Title=
//      Metadata is per-indicator (independent of geography/display/year), so this
//      is a small one-time pull — one Simple + one FGDC doc per unique id.
//   3. Output (resumable): raw HTML under output/metadata/raw/<id>_{simple,fgdc}.html,
//      a parsed per-id record output/metadata/<id>.json, and a rolled-up
//      output/metadata/index.json. Re-running skips ids already saved.
//
// Run:  node harvest_metadata.js            (uses defaults below)
//   optional flags: --delay=900 --limit=0 --raw=output/raw,output/shallow_raw

const fs = require('fs');
const path = require('path');
const https = require('https');
const { BASE } = require('./lib/flow.js');

// ---- config / flags ----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const DELAY_MS = Number(args.delay || 900);          // polite pause between requests
const LIMIT = Number(args.limit || 0);               // 0 = no cap (process every id)
const RAW_DIRS = String(args.raw || 'output/raw,output/shallow_raw')
  .split(',').map(s => s.trim()).filter(Boolean);
const OUT_DIR = 'output/metadata';
const OUT_RAW = path.join(OUT_DIR, 'raw');
const INDEX_PATH = path.join(OUT_DIR, 'index.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (...a) => console.log(`[${now().slice(11, 19)}]`, ...a);

fs.mkdirSync(OUT_RAW, { recursive: true });

// ---- 1. mine unique IMS_CLS_COLUMNID ids from captured table HTML ----
function collectIds() {
  const ids = new Set();
  const re = /PrintVuln(?:Table|Metadata)\('([\d,]+)'/g;
  for (const dir of RAW_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.html')); } catch { continue; }
    for (const f of files) {
      let html;
      try { html = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      let m;
      while ((m = re.exec(html)) !== null) {
        m[1].split(',').forEach(x => { const id = x.trim(); if (/^\d+$/.test(id)) ids.add(id); });
      }
    }
  }
  return [...ids];
}

// ---- fetch helper (plain GET, follows nothing; PrintMetadata is a direct 200) ----
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (SAVI-modernization metadata harvester; contact Polis Center)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 30000
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function metaUrl(id, type) {
  return `${BASE}/Print/PrintMetadata.aspx?DataFormat=VulnMeta`
    + `&IMS_CLS_COLUMNID=${encodeURIComponent(id)}&Type=${type}&Title=`;
}

// ---- crude HTML -> text + title extraction (store raw too, for exact re-parse) ----
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
function extractTitle(text) {
  // The Simple doc says "About the Data Item: <indicator title> ..." — grab a
  // reasonable slice after that marker; fall back to the first descriptive chunk.
  let m = /About the Data Item:\s*(.+?)(?:\s+About the Source Data|\s+DESCRIPTION|\s+Source|$)/i.exec(text);
  let t = m ? m[1] : text;
  return t.slice(0, 200).trim();
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await get(url); }
    catch (e) { lastErr = e; await sleep(DELAY_MS * (i + 1)); }
  }
  throw lastErr;
}

async function main() {
  const ids = collectIds();
  log(`found ${ids.length} unique IMS_CLS_COLUMNID(s) across ${RAW_DIRS.join(', ')}`);
  if (!ids.length) { log('nothing to do (no captured table HTML yet).'); return; }

  const index = fs.existsSync(INDEX_PATH) ? JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) : [];
  const byId = new Map(index.map(e => [e.id, e]));

  let done = 0, fetched = 0, skipped = 0, errors = 0;
  for (const id of ids) {
    if (LIMIT && fetched >= LIMIT) { log(`hit --limit=${LIMIT}, stopping.`); break; }
    const perIdPath = path.join(OUT_DIR, `${id}.json`);
    if (fs.existsSync(perIdPath)) { skipped++; done++; continue; }
    try {
      const simple = await fetchWithRetry(metaUrl(id, 'Simple'));
      await sleep(DELAY_MS);
      let fgdc = '';
      try { fgdc = await fetchWithRetry(metaUrl(id, 'FGDC')); } catch { /* FGDC optional */ }

      fs.writeFileSync(path.join(OUT_RAW, `${id}_simple.html`), simple);
      if (fgdc) fs.writeFileSync(path.join(OUT_RAW, `${id}_fgdc.html`), fgdc);

      const text = htmlToText(simple);
      const rec = {
        id,
        title: extractTitle(text),
        summaryText: text,
        hasFgdc: !!fgdc,
        fetchedAt: now()
      };
      fs.writeFileSync(perIdPath, JSON.stringify(rec, null, 2));

      const idxEntry = { id, title: rec.title, hasFgdc: rec.hasFgdc, fetchedAt: rec.fetchedAt };
      byId.set(id, idxEntry);
      fetched++; done++;
      if (fetched % 10 === 0 || fetched <= 3) log(`  [${done}/${ids.length}] ${id} -> ${rec.title.slice(0, 70)}`);
    } catch (e) {
      errors++; done++;
      log(`  [${done}/${ids.length}] ${id} ERROR: ${e.message}`);
    }
    // persist the rolled-up index incrementally so it's resumable + inspectable.
    if (fetched % 10 === 0) fs.writeFileSync(INDEX_PATH, JSON.stringify([...byId.values()], null, 2));
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(INDEX_PATH, JSON.stringify([...byId.values()], null, 2));
  log(`METADATA DONE. unique=${ids.length} fetched=${fetched} skipped(existing)=${skipped} errors=${errors}`);
  log(`  output: ${OUT_DIR}/<id>.json + ${OUT_RAW}/<id>_{simple,fgdc}.html + ${INDEX_PATH}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
