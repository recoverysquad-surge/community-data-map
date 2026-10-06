#!/usr/bin/env node
// build_featured.js — one-off generator for data/featured.json.
//
// Picks a small, hand-curated set of "known-good" indicators (confirmed Counties
// coverage in the harvested shards) and bakes a ready-to-apply Featured Maps
// catalog. Each entry names an indicator + a concrete selection (level/display/
// year) so the in-app gallery can apply it with the existing dynamic-layer code.
//
// Run from the repo root:  node scraper/build_featured.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'data', 'savi_index.json');
const VALUES_DIR = path.join(ROOT, 'data', 'values');
const OUT = path.join(ROOT, 'data', 'featured.json');

const VIEW = { center: [-86.21, 39.75], zoom: 8.5 };   // Indianapolis / Central Indiana

// Curated seed set: { id, label, description, match } — match picks the indicator
// by category + a label substring. ramp is a MapLibre-friendly ramp name used by
// the app's dynamic layers.
const SEED = [
  {
    id: 'calls-mental-health',
    category: '211 Helpline Calls',
    match: 'calls for the year where caller has mental health',
    label: '211 Mental-Health Calls',
    description: 'Yearly 211 help-line calls where the caller has mental-health issues, by county.',
    ramp: 'warm'
  },
  {
    id: 'calls-substance',
    category: '211 Helpline Calls',
    match: 'calls for the year where caller is dealing with substance',
    label: '211 Substance-Abuse Calls',
    description: 'Yearly 211 calls where the caller is dealing with substance abuse or addiction, by county.',
    ramp: 'warm'
  },
  {
    id: 'calls-suicide',
    category: '211 Helpline Calls',
    match: 'calls for the year where caller is dealing with suicide',
    label: '211 Suicide / Crisis Calls',
    description: 'Yearly 211 calls where the caller is dealing with suicide or homicide, by county.',
    ramp: 'warm'
  },
  {
    id: 'calls-homeless',
    category: '211 Helpline Calls',
    match: 'calls for the year where caller is homeless',
    label: '211 Homelessness Calls',
    description: 'Yearly 211 calls where the caller is homeless or doubled up, by county.',
    ramp: 'warm'
  },
  {
    id: 'median-age',
    category: 'Demographics',
    match: 'median age',
    label: 'Median Age',
    description: 'Median age of residents, by county.',
    ramp: 'blues'
  },
  {
    id: 'total-population',
    indicatorId: 'total_population',
    label: 'Total Population',
    description: 'Total number of residents, by county.',
    ramp: 'blues'
  },
  {
    id: 'labor-force',
    indicatorId: 'population_16_to_64_years_in_the_labor_force',
    label: 'Working-Age Labor Force',
    description: 'Share of working-age residents (16\u201364) in the labor force, by county.',
    ramp: 'teal'
  },
  {
    id: 'bachelors-degree',
    indicatorId: 'population_18_64_years_old_with_a_bachelor_s_degree_or_highe',
    label: "Bachelor's Degree or Higher",
    description: 'Share of adults 18\u201364 with a bachelor\u2019s degree or higher, by county.',
    ramp: 'purples'
  },
  {
    id: 'park-acreage',
    indicatorId: 'total_park_acreage',
    label: 'Total Park Acreage',
    description: 'Total acres of parkland, by county.',
    ramp: 'greens'
  }
];

// Prefer a percentage/rate display over a raw count when both are available.
function pickDisplay(displays) {
  const pct = displays.find(d => /%|percent|rate|ratio|per\b/i.test(d));
  return pct || displays[0];
}

function loadValues(id) {
  const p = path.join(VALUES_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function main() {
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const inds = index.indicators;
  const entries = [];

  for (const seed of SEED) {
    const ind = seed.indicatorId
      ? inds.find(i => i.id === seed.indicatorId)
      : inds.find(i => i.category === seed.category && i.label.toLowerCase().includes(seed.match.toLowerCase()));
    if (!ind) { console.warn(`! no indicator for ${seed.indicatorId || `"${seed.match}" in ${seed.category}`}`); continue; }

    const byDisp = (ind.availability && ind.availability.Counties) || null;
    if (!byDisp) { console.warn(`! ${ind.id} has no Counties availability`); continue; }

    const display = pickDisplay(Object.keys(byDisp));
    const years = byDisp[display] || [];
    const year = years[years.length - 1];
    if (!year) { console.warn(`! ${ind.id} / ${display} has no years`); continue; }

    // Verify real coverage in the value shard (all counties present for this combo).
    const V = loadValues(ind.id);
    const vm = V && V.Counties && V.Counties[display] && V.Counties[display][year];
    const coverage = vm ? Object.keys(vm).length : 0;
    if (coverage < 11) {
      console.warn(`! ${ind.id} / ${display} / ${year} coverage=${coverage} (<11) — skipping`);
      continue;
    }

    entries.push({
      id: seed.id,
      label: seed.label,
      description: seed.description,
      category: ind.category,
      dynamic: [{
        indicatorId: ind.id,
        sel: { level: 'Counties', display, year },
        ramp: seed.ramp
      }],
      view: VIEW
    });
    console.log(`\u2713 ${seed.id}: ${ind.label} [Counties \u00b7 ${display} \u00b7 ${year}] coverage=${coverage}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ featured: entries }, null, 2) + '\n');
  console.log(`\nWrote ${entries.length} featured entries \u2192 ${path.relative(ROOT, OUT)}`);
}

main();
