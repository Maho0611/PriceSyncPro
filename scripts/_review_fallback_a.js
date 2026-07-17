// Review probe (a): rule1/rule2 ordering + first-pick logic
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
const { buildFallbackCandidates, buildMatchResults, matchOfficialPrice } = require('../content.js');
const prices = require('../official_prices.json');
const bare = prices.bare;

function show(name) {
  const m = matchOfficialPrice(name, prices);
  if (m) { console.log(`\n### ${name}  -> ALREADY MATCHED (${m.source}: ${m.matchedName}), fallback not reached`); return; }
  const cands = buildFallbackCandidates(name, bare);
  console.log(`\n### ${name}  (${cands.length} candidates)`);
  for (const c of cands.slice(0, 12)) {
    const e = c.entry;
    const price = e.billingMode === 'flat' ? `flat=${e.flatPrice}` : `p=${e.prompt} c=${e.completion}`;
    console.log(`  rule${c.rule} len=${c.key.length}  ${c.key}  ${price}`);
  }
}

// Rule ordering checks with realistic channel names
[
  'gemini-3',            // expect rule1: probe substring of longer keys
  'grok-4.20-fast',      // ?
  'claude-5',            // rule1 candidates?
  'gpt-5-ultra',         // rule2: gpt-5 substring of probe
  'deepseek-v9',
  'gemini-4-flash',
  'llama-4-70b-instruct-turbo',
  'qwen3-9000b',
  'kimi-k3',
  'glm-5',
].forEach(show);

// Verify invariants programmatically over the same set
console.log('\n--- invariant checks ---');
const probes = ['gemini-3','gpt-5-ultra','deepseek-v9','gemini-4-flash','llama-4-70b-instruct-turbo','claude-5','kimi-k3'];
let ok = true;
for (const p of probes) {
  const cands = buildFallbackCandidates(p, bare);
  // rule1 group before rule2 group
  let seen2 = false;
  let prev1 = -1, prev2 = Infinity;
  for (const c of cands) {
    if (c.rule === 2) seen2 = true;
    if (c.rule === 1 && seen2) { console.log(`VIOLATION: rule1 after rule2 in ${p}`); ok = false; }
    if (c.rule === 1) { if (c.key.length < prev1) { console.log(`VIOLATION: rule1 not ascending in ${p}`); ok = false; } prev1 = c.key.length; }
    if (c.rule === 2) { if (c.key.length > prev2) { console.log(`VIOLATION: rule2 not descending in ${p}`); ok = false; } prev2 = c.key.length; }
  }
  // cap of 10 per rule
  const r1 = cands.filter(c=>c.rule===1).length, r2 = cands.filter(c=>c.rule===2).length;
  if (r1 > 10 || r2 > 10) { console.log(`VIOLATION: cap exceeded in ${p}: r1=${r1} r2=${r2}`); ok = false; }
}
console.log(ok ? 'ordering invariants: PASS' : 'ordering invariants: FAIL');

// autoFallback picks first candidate
const results = buildMatchResults(['gpt-5-ultra','gemini-4-flash'], prices, { autoFallback: true });
for (const r of results) {
  console.log(`\nautoFallback pick for ${r.modelName}: matched=${r.matched} source=${r.source} matchedName=${r.matchedName} rule=${r.rule} p=${r.promptPrice} c=${r.completionPrice}`);
  if (r.fallbackCandidates) console.log('  first candidate:', r.fallbackCandidates[0].matchedName, 'rule', r.fallbackCandidates[0].rule);
}

// short-probe guard
console.log('\nshort probe "o1":', buildFallbackCandidates('o1', bare).length, '(expect 0)');
console.log('short probe "ai":', buildFallbackCandidates('ai', bare).length, '(expect 0)');
console.log('probe "o1 " len check via buildMatchResults:', JSON.stringify(buildMatchResults(['o1'], prices).map(r=>({m:r.matched,s:r.source}))));
