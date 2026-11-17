// Agent configs (other accounts / model APIs) and usage-limit detection. Pure: no db, no I/O.
export const ACCOUNT_VAR = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

/* The variable set every OpenAI/Anthropic-style agent reads for one endpoint. */
export function endpointEnv({ base_url, api_key, model }) {
  const env = {};
  if (base_url) env.LLM_BASE_URL = env.OPENAI_BASE_URL = env.ANTHROPIC_BASE_URL = base_url;
  if (api_key) { env.LLM_API_KEY = env.OPENAI_API_KEY = env.ANTHROPIC_AUTH_TOKEN = api_key; }
  if (model) env.LLM_MODEL = env.OPENAI_MODEL = env.ANTHROPIC_MODEL = model;
  return env;
}

export function configEnv(cfg, agent) {
  if (cfg.kind === 'account') {
    const v = ACCOUNT_VAR[agent];
    if (!v) throw new Error(`${agent} cannot use account configs (only ${Object.keys(ACCOUNT_VAR).join(', ')})`);
    return { [v]: cfg.config_dir };
  }
  return endpointEnv(cfg);
}

/* Throws a clear message for a config that could not work; returns the cleaned fields. */
export function validateConfig(c) {
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const out = { agent: s(c.agent, 40), name: s(c.name, 60), kind: c.kind, base_url: s(c.base_url, 400), model: s(c.model, 200), api_key: s(c.api_key, 2000), config_dir: s(c.config_dir, 400) };
  if (!/^[\w-]+$/.test(out.agent)) throw new Error('agent is required');
  if (!/^[\w .-]+$/.test(out.name)) throw new Error('name: letters, digits, space . _ - only');
  if (out.kind !== 'api' && out.kind !== 'account') throw new Error("kind must be 'api' or 'account'");
  if (out.kind === 'account') {
    if (!ACCOUNT_VAR[out.agent]) throw new Error(`${out.agent} cannot use account configs (only ${Object.keys(ACCOUNT_VAR).join(', ')}); use an api config`);
    if (!out.config_dir) throw new Error('an account config needs config_dir');
  } else if (!out.base_url && !out.api_key) throw new Error('an api config needs a base URL or a key');
  if (out.base_url && !/^https?:\/\//i.test(out.base_url)) throw new Error('base URL must start with http:// or https://');
  return out;
}

/* What the API returns: never the key. */
export const publicConfig = ({ api_key, ...c }) => ({ ...c, has_key: !!api_key });

const NEXT_CLOCK = /(?:resets?|try again|retry)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i;
const REL = /(?:try again|retry|resets?)\s+in\s+(?:(\d+)\s*h(?:ou)?(?:r|rs|rs?)?\b)?[\s,and]*(?:(\d+)\s*m(?:in(?:ute)?s?)?\b)?/i;
/* A limit phrase that also names usage/rate/quota, so "limit the output" or "--limit 5" never match. */
const LIMIT = [
  /\b(?:you'?ve|you have|youve)\s+(?:hit|reached|exceeded)\s+your\s+[\w -]{0,30}?limit/i,
  /\b(?:usage|rate|message|token|daily|weekly|monthly|5-hour|session)\s+limit\s+(?:reached|exceeded|hit)/i,
  /\b(?:reached|hit|exceeded)\s+(?:the|your|a)\s+(?:usage|rate|message|token|daily|weekly)\s+limit/i,
  /\brate[- ]limit(?:ed|\s+(?:exceeded|reached|error))/i,
  /\b(?:error|status|http|code)\s*:?\s*429\b|\b429\s+too many requests|\btoo many requests\b/i,
  /\bquota\s+(?:exceeded|exhausted)|exceeded\s+your\s+(?:current\s+)?quota|\bRESOURCE_EXHAUSTED\b/i,
  /\blimit reached\s*\|\s*(?:try|resets?)/i,
];

export function detectLimit(text, now = Date.now()) {
  const t = String(text ?? '');
  if (!LIMIT.some((r) => r.test(t))) return null;
  const c = t.match(NEXT_CLOCK);
  if (c) {
    let h = +c[1] % 12 + (c[3].toLowerCase() === 'p' ? 12 : 0);
    const d = new Date(now); d.setHours(h, +(c[2] || 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return { until: d.getTime() };
  }
  const r = t.match(REL);
  if (r && (r[1] || r[2])) return { until: now + ((+r[1] || 0) * 60 + (+r[2] || 0)) * 60000 };
  return { until: now + 60 * 60000 };
}

const usable = (c, now) => c && c.enabled !== 0 && c.enabled !== false && !(c.limited_until > now);
/* configs: this agent's rows, plus optionally { id: '' , limited_until } for the official account. */
export function pickConfig(configs, agent, now, preferId) {
  const mine = configs.filter((c) => c.agent === undefined || c.agent === agent);
  const official = mine.find((c) => c.id === '') || { id: '', agent, enabled: 1, limited_until: 0 };
  if (preferId != null) {
    const p = preferId === '' ? official : mine.find((c) => c.id === preferId);
    if (usable(p, now)) return p;
  }
  if (usable(official, now)) return official;
  return mine.filter((c) => c.id !== '' && usable(c, now)).sort((a, b) => (a.priority - b.priority) || (a.created_at - b.created_at))[0] ?? null;
}

/* Switching keeps the agent's conversation only when both sides read the same storage. */
const sameStore = (c) => !c || c.id === '' || (c.kind === 'api' && !c.config_dir);
export const sharesConversation = (from, to) => sameStore(from) && sameStore(to);
