// Review probe (b3): generic family names + :free/-free + localeCompare determinism
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
const { buildFallbackCandidates, buildMatchResults, matchOfficialPrice } = require('../content.js');
const prices = require('../official_prices.json');
const bare = prices.bare;

function pick(name) {
  const m = matchOfficialPrice(name, prices);
  if (m) { console.log(`${name.padEnd(30)} PRE-MATCHED -> ${m.matchedName} (${m.source})`); return; }
  const r = buildMatchResults([name], prices, { autoFallback: true })[0];
  if (!r.matched) { console.log(`${name.padEnd(30)} no candidates`); return; }
  const p = r.billingMode === 'flat' ? `FLAT ${r.flatPrice}` : `p=${r.promptPrice} c=${r.completionPrice}`;
  console.log(`${name.padEnd(30)} AUTO -> rule${r.rule} ${r.matchedName}  ${p}  type=${r.modelType || 'chat'}  (${r.fallbackCandidates.length} cands)`);
}

console.log('--- bare family names (plausible channel aliases) ---');
['gpt','claude','gemini','deepseek','qwen','llama','grok','mistral','kimi','glm','nova','sonar','command','titan','flux','sora','veo','embedding','whisper'].forEach(pick);

console.log('\n--- generic tier words (len>=3) ---');
['pro','max','mini','flash','turbo','chat','code','vision','think','fast','lite','plus','opus','sonnet','haiku'].forEach(pick);

console.log('\n--- free-suffixed (OpenRouter style) ---');
['deepseek-r1:free','deepseek-r1-free','qwen3-coder:free','llama-3.3-70b-instruct:free','gemini-2.0-flash-exp:free','gpt-oss-120b:free','kimi-k2:free','glm-4.5-air:free','mistral-small-3.1-24b-instruct:free','qwen3-235b-a22b:free','deepseek-chat-v3-0324:free'].forEach(pick);

console.log('\n--- localeCompare vs codepoint sort divergence check ---');
// case-differing same-length key pairs where prices differ notably
const keys = Object.keys(bare);
const byLen = {};
for (const k of keys) (byLen[k.length] = byLen[k.length] || []).push(k);
let found = 0;
for (const len of Object.keys(byLen)) {
  const group = byLen[len];
  for (let i = 0; i < group.length && found < 8; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      if (a.toLowerCase() === b.toLowerCase() && a !== b) {
        const pa = bare[a].prompt ?? bare[a].flatPrice, pb = bare[b].prompt ?? bare[b].flatPrice;
        const lc = a.localeCompare(b), cp = a < b ? -1 : 1;
        console.log(`  pair ${a} (p=${pa}) / ${b} (p=${pb}): localeCompare=${lc} codepoint=${cp} ${Math.sign(lc)!==Math.sign(cp)?'<-- ORDER DIFFERS BY COMPARATOR':''} priceRatio=${(Math.max(pa,pb)/Math.min(pa,pb)).toFixed(2)}`);
        found++;
      }
    }
  }
}
