'use strict';

/**
 * `node scripts/websearch-live-probe.js` - live probe of the agent's web-search broker.
 *
 * Exercises the same surfaces the brains use:
 *   - behavior brain `lookup_mod_content`  -> WebSearch.search(..., preferred:true)
 *   - language brain `web_search`          -> ctx.languageSearch(...) (preferred:false)
 * and the privacy filter that must stop coordinates / IPs leaving the machine.
 *
 * Usage: node scripts/websearch-live-probe.js [--query "..."] [--count 3]
 * Evidence is written to runtime/evidence/websearch-live-probe.json.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const { loadConfig } = require('../src/util/config');
const { WebSearch } = require('../src/llm/knowledge/webSearch');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const COUNT = Number(argValue('--count', 3));
const CUSTOM = argValue('--query', null);

const cfg = loadConfig();
const llmCfg = cfg.llm || {};
const searchCfg = ((cfg.agent && cfg.agent.codeSkills && cfg.agent.codeSkills.search) || {});
const apiKey = llmCfg.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

const broker = new WebSearch({
  baseUrl: llmCfg.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  apiKey,
  enabled: true,
  cacheFile: searchCfg.cacheFile || 'runtime/search-cache.json',
  timeoutMs: searchCfg.timeoutMs || 8000,
  log: { info() {}, warn: (m) => console.log('[warn]', m), debug() {} }
});

function compact(result) {
  return (result.results || []).slice(0, COUNT).map((r) => ({
    title: r.title,
    url: r.url,
    preferredSource: r.preferredSource || null,
    summary: (r.summary || '').replace(/\s+/g, ' ').slice(0, 160)
  }));
}

const CASES = CUSTOM
  ? [{ id: 'custom', surface: 'language', query: CUSTOM, preferred: false }]
  : [
      { id: 'vanilla-diamond', surface: 'language', query: 'Minecraft 钻石矿一般在哪一层生成', preferred: false },
      { id: 'mod-create-arm', surface: 'behavior', query: 'Create 机械手 怎么连接 动力', preferred: true },
      { id: 'mod-create-arm-language', surface: 'language', query: 'Create 机械手 怎么连接 动力', preferred: false },
      { id: 'privacy-coordinates', surface: 'behavior', query: '去 100 64 200 挖矿', preferred: true },
      { id: 'empty-query', surface: 'behavior', query: '   ', preferred: true }
    ];

async function main() {
  const evidence = {
    startedAt: new Date().toISOString(),
    endpoint: broker.status().endpoint,
    configured: broker.configured,
    cases: {}
  };
  console.log(`endpoint : ${evidence.endpoint}`);
  console.log(`configured: ${evidence.configured}`);
  console.log('');

  for (const testCase of CASES) {
    const started = Date.now();
    const result = await broker.search(testCase.query, {
      count: COUNT,
      preferred: testCase.preferred
    });
    const elapsed = Date.now() - started;
    const entry = {
      surface: testCase.surface,
      query: testCase.query,
      preferred: testCase.preferred,
      ok: !!result.ok,
      reason: result.reason || null,
      detail: result.detail || null,
      cached: !!result.cached,
      elapsedMs: elapsed,
      count: (result.results || []).length,
      results: compact(result)
    };
    evidence.cases[testCase.id] = entry;

    console.log(`[${testCase.id}] ${testCase.surface} preferred=${testCase.preferred}`);
    console.log(`  query   : ${JSON.stringify(testCase.query)}`);
    if (result.ok) {
      console.log(`  ok      : ${entry.count} result(s)${entry.cached ? ' (cached)' : ''} in ${elapsed}ms`);
      for (const [index, item] of entry.results.entries()) {
        console.log(`    ${index + 1}. ${item.title}`);
        console.log(`       ${item.url}${item.preferredSource ? `  [${item.preferredSource}]` : ''}`);
        console.log(`       ${item.summary}`);
      }
    } else {
      console.log(`  FAIL    : ${result.reason}${result.detail ? ` - ${String(result.detail).slice(0, 200)}` : ''} (${elapsed}ms)`);
    }
    console.log('');
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.stats = broker.status().stats;
  const outFile = path.join(ROOT, 'runtime', 'evidence', 'websearch-live-probe.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`stats: ${JSON.stringify(evidence.stats)}`);
  console.log(`evidence: ${outFile}`);

  const failures = Object.values(evidence.cases).filter((c) => !c.ok && c.reason !== 'privacy-filtered' && c.reason !== 'query-required');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
