// Review probe (c): case handling — lowerKey === probe skip; underscore; :free suffix
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
const { buildFallbackCandidates, buildMatchResults, matchOfficialPrice, MANUAL_ALIAS_TABLE } = require('../content.js');
const prices = require('../official_prices.json');
const bare = prices.bare;
const keys = Object.keys(bare);
const keyset = new Set(keys);

// --- (c1) mixed-case-only keys: does a lowercase channel spelling skip the exact candidate? ---
console.log('=== c1: lowercase spelling of mixed-case-only keys ===');
const mixedOnly = keys.filter(k => k !== k.toLowerCase() && !keyset.has(k.toLowerCase()));
let skippedExact = 0, prematched = 0, noCand = 0, pickedOther = 0;
const examples = [];
for (const k of mixedOnly) {
  const channelName = k.toLowerCase(); // very natural channel spelling
  const m = matchOfficialPrice(channelName, prices);
  if (m) { prematched++; continue; }
  const cands = buildFallbackCandidates(channelName, bare);
  const hasExact = cands.some(c => c.key === k);
  if (!hasExact) {
    skippedExact++;
    if (cands.length === 0) noCand++;
    else {
      pickedOther++;
      const first = cands[0];
      const trueE = bare[k], pickE = first.entry;
      const truP = trueE.billingMode==='flat'?trueE.flatPrice:trueE.prompt;
      const pikP = pickE.billingMode==='flat'?pickE.flatPrice:pickE.prompt;
      examples.push(`  ${channelName}: exact key "${k}" (p=${truP}) SKIPPED; auto-pick -> ${first.key} (p=${pikP}, rule${first.rule}) ratio=${truP&&pikP?(pikP/truP).toFixed(2):'?'}`);
    }
  }
}
console.log(`mixed-only keys: ${mixedOnly.length}, prematched by normal layers: ${prematched}, exact-candidate-missing: ${skippedExact} (noCand=${noCand}, picked-other=${pickedOther})`);
console.log(examples.slice(0, 25).join('\n'));

// --- (c2) underscore channel names ---
console.log('\n=== c2: underscore spellings ===');
for (const name of ['deepseek_v9_ultra', 'gpt_5_ultra', 'qwen3_max_ultra']) {
  const m = matchOfficialPrice(name, prices);
  const cands = m ? null : buildFallbackCandidates(name, bare);
  console.log(`${name}: prematched=${!!m} candidates=${cands ? cands.length : '-'}`);
}
// dash version for comparison
console.log('(dash versions produce candidates: gpt-5-ultra=%d)', buildFallbackCandidates('gpt-5-ultra', bare).length);

// --- (c3) :free suffix — OpenRouter mirror channels ---
console.log('\n=== c3: :free / -free suffixed models ===');
for (const name of ['deepseek/deepseek-r1:free', 'deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free', 'gemini-2.0-flash-exp:free', 'qwen/qwen3-235b-a22b:free']) {
  const m = matchOfficialPrice(name, prices);
  if (m) { console.log(`${name}: PRE-MATCHED ${m.matchedName} (${m.source})`); continue; }
  const r = buildMatchResults([name], prices, { autoFallback: true })[0];
  console.log(`${name}: matched=${r.matched} source=${r.source} pick=${r.matchedName} p=${r.promptPrice} c=${r.completionPrice}`);
}

// --- (c4) does alias table cover :free? ---
const freeAliases = Object.keys(MANUAL_ALIAS_TABLE).filter(k => /free/i.test(k));
console.log('alias table :free entries:', freeAliases.length);
