// Review probe (b): adversarial hunt for severe mispricing under autoFallback
global.chrome = { runtime: { onMessage: { addListener: () => {} } } };
const { buildFallbackCandidates, buildMatchResults, matchOfficialPrice } = require('../content.js');
const prices = require('../official_prices.json');
const bare = prices.bare;

// battery of realistic-but-nonexistent channel names
const battery = [
  'gpt-5-ultra','gpt-6','gpt-5.5-codex','gpt-4o-super','claude-5','claude-5-opus',
  'claude-opus-5','deepseek-v9','deepseek-r3','gemini-4-flash','gemini-4','gemini-3-ultra',
  'llama-4-70b-instruct-turbo','llama-5-8b','qwen4-72b','qwen3-max-ultra','kimi-k4',
  'glm-6','grok-5-fast','grok-4.20-fast','mistral-large-3','o5-mini','o3-pro-max',
  'text-embedding-4-large','sora-3','dall-e-4','veo-4','flux-3-pro','nova-ultra',
  'command-r-ultra','doubao-pro-256k','ernie-5.0','hunyuan-ultra','step-3','yi-ultra',
  'minimax-abab7','moonshot-v2-128k','baichuan5','spark-5.0','qwen-30b','llama-3.31-70b',
  'gpt-oss-360b','phi-5','granite-4','jamba-2-large','mixtral-9x22b','codestral-3',
  'devstral-large','magistral-ultra','pixtral-2',
];

function fmtEntry(e) {
  return e.billingMode === 'flat' ? `FLAT ${e.flatPrice}/${e.flatUnit||'call'}${e.type?' ('+e.type+')':''}` : `p=${e.prompt} c=${e.completion}${e.type?' ('+e.type+')':''}`;
}

let picked = 0, none = 0, prematched = 0;
for (const name of battery) {
  const m = matchOfficialPrice(name, prices);
  if (m) { console.log(`[pre-matched] ${name} -> ${m.matchedName} (${m.source}) ${fmtEntry(m)}`); prematched++; continue; }
  const cands = buildFallbackCandidates(name, bare);
  if (cands.length === 0) { console.log(`[no-cand]     ${name}`); none++; continue; }
  picked++;
  const first = cands[0];
  // price spread across candidates (prompt price or flat price)
  const priceOf = c => c.entry.billingMode === 'flat' ? c.entry.flatPrice : c.entry.prompt;
  const pAll = cands.map(priceOf).filter(v => v > 0);
  const pMin = Math.min(...pAll), pMax = Math.max(...pAll);
  const p0 = priceOf(first);
  const spread = pMin > 0 ? (pMax/pMin).toFixed(1) : 'inf';
  console.log(`[PICK]        ${name} -> rule${first.rule} ${first.key}  ${fmtEntry(first.entry)}   [${cands.length} cands, price spread x${spread}, pick=${p0}, range ${pMin}..${pMax}]`);
  if (pMin > 0 && pMax/pMin >= 8) {
    for (const c of cands.slice(0,10)) console.log(`                 rule${c.rule} ${c.key}  ${fmtEntry(c.entry)}`);
  }
}
console.log(`\nsummary: picked=${picked} none=${none} prematched=${prematched} of ${battery.length}`);
