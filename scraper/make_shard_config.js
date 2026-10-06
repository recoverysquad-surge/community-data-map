// Derive a per-worker shard config from a base harvest config.
//
//   node make_shard_config.js <baseConfig> <index> <total>
//
// Writes harvest.shard<index>.json: same scope/levels/politeness as the base, but with
//   shard  = { index, total }               -> harvest.js keeps only this worker's chunks
//   output = base output paths + ".s<index>" -> each worker has its own NDJSON/CSV/state
// so N workers never touch each other's files. Merge the shard NDJSONs afterwards.

const fs = require('fs');
const path = require('path');

const [, , basePath, indexArg, totalArg] = process.argv;
if (!basePath || indexArg == null || totalArg == null) {
  console.error('usage: node make_shard_config.js <baseConfig> <index> <total>');
  process.exit(2);
}
const index = Number(indexArg), total = Number(totalArg);
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));

const suffix = `.s${index}`;
const withSuffix = (p) => {
  const ext = path.extname(p);
  return p.slice(0, p.length - ext.length) + suffix + ext;
};

const out = { ...base };
out.shard = { index, total };
out.output = {
  ndjson: withSuffix(base.output.ndjson),
  csv: withSuffix(base.output.csv),
  state: withSuffix(base.output.state),
  rawDir: base.output.rawDir + suffix,
};

const outPath = path.join(__dirname, `harvest.shard${index}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(outPath);
