// Minimal MCP stdio server: one tool, `xb`, running the same commands as the CLI.
// JSON-RPC 2.0, one message per line. Start with `xb mcp`.
import { createInterface } from 'node:readline';
import { run } from './xb.mjs';

const TOOL = {
  name: 'xb',
  description: 'Control XBLabs sessions. args = xb CLI arguments, e.g. ["ls"], ["spawn","--agent","claude","do X"], ["send","<session>","text"], ["read","<session>"], ["wait","<session>"], ["answer","<session>","1"], ["stop","<session>"], ["rename","<session>","name"], ["close","<session>","--yes"]. ["help"] lists all.',
  inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] },
};

/* One request → its response object, or null for notifications. */
export async function handle(msg) {
  if (msg.id === undefined) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.method === 'initialize') return ok({ protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'xb', version: '1.0.0' } });
  if (msg.method === 'ping') return ok({});
  if (msg.method === 'tools/list') return ok({ tools: [TOOL] });
  if (msg.method === 'tools/call') {
    const { name, arguments: a } = msg.params || {};
    if (name !== 'xb') return fail(-32602, `unknown tool ${name}`);
    if (!Array.isArray(a?.args) || a.args.some((x) => typeof x !== 'string')) return fail(-32602, 'args must be string[]');
    try {
      const { text, code } = await run(a.args);
      return ok({ content: [{ type: 'text', text: `${text}${code ? `\n(exit ${code})` : ''}` }], isError: code === 1 });
    } catch (err) { return ok({ content: [{ type: 'text', text: `xb: ${err.message}` }], isError: true }); }
  }
  return fail(-32601, `method not found: ${msg.method}`);
}

export async function serve() {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); continue; }
    const res = await handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
}
