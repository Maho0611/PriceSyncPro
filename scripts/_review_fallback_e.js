// Review probe (e): vendor-prefixed shadow keys winning rule1 shortest-first
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
const { buildFallbackCandidates, matchOfficialPrice } = require('../content.js');
const prices = require('../official_prices.json');
const bare = prices.bare;
const keys = Object.keys(bare);

console.log('xai.grok-4-fast entry:', JSON.stringify(bare['xai.grok-4-fast']));
console.log('grok-4-fast-reasoning entry:', JSON.stringify(bare['grok-4-fast-reasoning']));
console.log('grok-4-fast in bare?', 'grok-4-fast' in bare);

// how many keys have a dotted/vendor prefix form 'vendor.rest' or 'vendor-rest' where rest is itself close to other keys
const dotted = keys.filter(k => /^[a-z0-9]+\./i.test(k));
console.log('\ndotted vendor-prefixed keys:', dotted.length, dotted.slice(0,8));

// Systematic scan: for every key K, strip the vendor prefix to get R; if R is NOT a key
// (so channel named R won't prematch), check whether autoFallback rule1 pick is the dotted
// key and price differs from the best non-dotted candidate.
function priceOf(e){return e.billingMode==='flat'?e.flatPrice:e.prompt;}
let cases = 0;
for (const k of dotted) {
  const rest = k.replace(/^[a-z0-9]+\./i, '');
  if (rest.length < 3 || bare[rest]) continue;
  const m = matchOfficialPrice(rest, prices);
  if (m) continue; // normal layers handle (stripDottedVendorPrefix works the other direction)
  const cands = buildFallbackCandidates(rest, bare);
  if (!cands.length) continue;
  const first = cands[0];
  const nonDotted = cands.find(c => !/^[a-z0-9]+\./i.test(c.key));
  if (first.key === k && nonDotted) {
    const pf = priceOf(first.entry), pn = priceOf(nonDotted.entry);
    if (pf > 0 && pn > 0 && Math.max(pf/pn, pn/pf) >= 3) {
      cases++;
      console.log(`  channel "${rest}" -> auto-pick ${first.key} p=${pf}  vs plausible ${nonDotted.key} p=${pn}  (x${(pf/pn).toFixed(1)})`);
    }
  }
}
console.log('dotted-prefix shadow-pick cases with >=3x divergence:', cases);

// Same idea for '@' suffixed keys (mistral-nemo@2407 pattern)
const at = keys.filter(k => k.includes('@'));
console.log('\n@-suffixed keys:', at.length, at.slice(0,6));
