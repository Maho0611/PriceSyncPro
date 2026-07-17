// Review probe (d): performance + a few vendor-dupe realistic checks
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
const { buildFallbackCandidates, buildMatchResults, matchOfficialPrice } = require('../content.js');
const prices = require('../official_prices.json');
const bare = prices.bare;

// realistic vendor-dupe checks
for (const name of ['grok-4-fast', 'mistral-nemo-12b', 'command-a-2025', 'gpt-5-nano-high-2025']) {
  const m = matchOfficialPrice(name, prices);
  if (m) { console.log(`${name}: PRE-MATCHED ${m.matchedName}`); continue; }
  const c = buildFallbackCandidates(name, bare);
  console.log(`${name}: ${c.slice(0,4).map(x=>`rule${x.rule} ${x.key} p=${x.entry.prompt??x.entry.flatPrice}`).join(' | ') || 'none'}`);
}

// --- performance: simulate global mode with many unmatched names ---
// build 600 synthetic unmatched names (realistic length/shape)
const fams = ['gpt','claude','gemini','deepseek','qwen','llama','grok','mistral','kimi','glm','yi','phi','nova','command','jamba','granite','step','ernie','hunyuan','doubao'];
const tiers = ['ultra','giga','hyper','prime','apex','omega','zen','neo','ace','vortex'];
const names = [];
for (let i = 0; i < 600; i++) {
  const f = fams[i % fams.length], t = tiers[(i / fams.length | 0) % tiers.length];
  names.push(`${f}-${(i % 9) + 1}.${i % 10}-${t}-${i}b-instruct`);
}
// warmup
buildMatchResults(names.slice(0, 50), prices, { autoFallback: true });

let t0 = performance.now();
const res = buildMatchResults(names, prices, { autoFallback: true });
let t1 = performance.now();
const matched = res.filter(r => r.matched).length;
console.log(`\n600 unmatched-shape names, autoFallback: ${(t1 - t0).toFixed(1)} ms total (${((t1 - t0) / 600).toFixed(3)} ms/name), matched=${matched}`);

// worst case: names that never prematch and have long probes
const longNames = names.map(n => 'vendor/' + n + '-preview-20260101');
t0 = performance.now();
buildMatchResults(longNames, prices, { autoFallback: true });
t1 = performance.now();
console.log(`600 long prefixed names: ${(t1 - t0).toFixed(1)} ms total`);

// isolate the fallback scan itself
t0 = performance.now();
for (const n of names) buildFallbackCandidates(n, bare);
t1 = performance.now();
console.log(`600 x buildFallbackCandidates alone: ${(t1 - t0).toFixed(1)} ms`);

// 2000 names stress
const many = [];
for (let i = 0; i < 2000; i++) many.push(names[i % names.length] + '-' + i);
t0 = performance.now();
buildMatchResults(many, prices, { autoFallback: true });
t1 = performance.now();
console.log(`2000 names: ${(t1 - t0).toFixed(1)} ms`);
