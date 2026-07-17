// Review probe (b2): leave-one-out simulation — ground-truth error profile of autoFallback
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
const { buildMatchResults, matchOfficialPrice, buildFallbackCandidates } = require('../content.js');
const prices = require('../official_prices.json');
const bare = prices.bare;
const keys = Object.keys(bare);

function priceOf(e) { return e.billingMode === 'flat' ? e.flatPrice : e.prompt; }

// zero-price keys in table?
const zeroKeys = keys.filter(k => priceOf(bare[k]) === 0 || priceOf(bare[k]) == null);
console.log('zero/undefined-price bare keys:', zeroKeys.length, zeroKeys.slice(0, 10));
const freeKeys = keys.filter(k => /free/i.test(k));
console.log('keys containing "free":', freeKeys.length, freeKeys.slice(0, 5));

// Leave-one-out: remove key K, feed K as channel name, see what autoFallback picks
const ratios = [];
const worst = [];
let unmatchedNoCand = 0, stillMatched = 0, fellBack = 0, typeMismatch = 0, billingMismatch = 0;
for (const k of keys) {
  const truth = bare[k];
  const truthP = priceOf(truth);
  const clone = { bare: { ...bare }, full: prices.full }; // full removed? full may re-match same model — keep, it's legit pre-existing layer... but full entries for k would prematch. Remove full entries matching too, to force fallback path more often:
  delete clone.bare[k];
  const m = matchOfficialPrice(k, clone);
  if (m) { stillMatched++; continue; } // recovered by normal layers (variants etc.) — pre-existing behavior, out of scope
  const r = buildMatchResults([k], clone, { autoFallback: true })[0];
  if (!r.matched) { unmatchedNoCand++; continue; }
  fellBack++;
  const pick = r;
  const pickP = pick.billingMode === 'flat' ? pick.flatPrice : pick.promptPrice;
  if ((truth.billingMode === 'flat') !== (pick.billingMode === 'flat')) billingMismatch++;
  if ((truth.type || 'chat') !== (pick.modelType || 'chat')) typeMismatch++;
  if (truthP > 0 && pickP > 0) {
    const ratio = pickP / truthP;
    ratios.push(ratio);
    const sev = Math.max(ratio, 1 / ratio);
    worst.push({ k, pick: pick.matchedName, rule: pick.rule, truthP, pickP, sev, ratio });
  }
}
worst.sort((a, b) => b.sev - a.sev);
ratios.sort((a, b) => a - b);
const q = f => ratios[Math.floor(f * (ratios.length - 1))];
console.log(`\nleave-one-out over ${keys.length} keys: stillMatched=${stillMatched} fellBack=${fellBack} noCand=${unmatchedNoCand}`);
console.log(`price-ratio (pick/truth) quantiles: p5=${q(0.05).toFixed(2)} p25=${q(0.25).toFixed(2)} median=${q(0.5).toFixed(2)} p75=${q(0.75).toFixed(2)} p95=${q(0.95).toFixed(2)}`);
const off5 = worst.filter(w => w.sev >= 5).length, off10 = worst.filter(w => w.sev >= 10).length;
console.log(`picks off by >=5x: ${off5}/${ratios.length}, >=10x: ${off10}/${ratios.length}`);
console.log(`billingMode mismatches (flat vs ratio): ${billingMismatch}, type mismatches: ${typeMismatch}`);
console.log('\nworst 25:');
for (const w of worst.slice(0, 25)) {
  console.log(`  ${w.k} -> ${w.pick} (rule${w.rule})  truth=${w.truthP} pick=${w.pickP}  x${w.ratio >= 1 ? w.ratio.toFixed(1) : ('1/' + (1 / w.ratio).toFixed(1))}`);
}
