// OMP hook, loaded per run with `omp --hook <this file>`: binds endpoint and reports status.
const post = (state) => {
  const { XBLABS_SESSION: id, XBLABS_HUB: hub } = process.env;
  if (!id || !hub) return;
  fetch(`${hub}/api/sessions/${id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }),
  }).catch(() => {});
};
export default function (pi) {
  const { LLM_BASE_URL: baseUrl, LLM_MODEL: model } = process.env;
  if (baseUrl !== undefined) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error('LLM_BASE_URL must be an HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('LLM_BASE_URL must be an HTTP(S) URL');
    if (!model?.trim()) throw new Error('LLM_MODEL must be nonempty when LLM_BASE_URL is set');
    pi.registerProvider('xblabs', {
      baseUrl, apiKey: 'LLM_API_KEY', api: 'openai-completions',
      models: [{
        id: model, name: model, reasoning: false, input: ['text'],
        // Pricing unknown; zero placeholders are not a claim of free usage.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 8192,
      }],
    });
  }
  pi.on('session_start', () => post('idle'));
  pi.on('agent_start', () => post('working'));
  pi.on('agent_end', () => post('idle'));
}
