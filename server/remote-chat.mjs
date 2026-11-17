// Child-process-shaped streams over the existing worker WebSocket.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';

export function remoteChat(sendTo, available) {
  const runs = new Map();
  return {
    available,
    spawn(row, argv, env, { setup = false } = {}) {
      if (!available(row.device)) throw new Error(`${row.device}: worker needs remote chat support`);
      const args = [...argv];
      if (row.agent === 'omp' && env.LLM_BASE_URL) {
        if (!/^https?:$/.test(new URL(env.LLM_BASE_URL).protocol) || !env.LLM_MODEL?.trim()) throw new Error('OMP shared endpoint requires HTTP(S) URL and model');
        args.push('--extension', 'xblabs:omp', '--model', `xblabs/${env.LLM_MODEL}`);
      }
      const run = randomUUID();
      const proc = new EventEmitter();
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      proc.kill = () => sendTo(row.device, { type: 'kill', id: row.id, run });
      proc.stdin = { end(input = '') {
        if (!sendTo(row.device, { type: 'chat-start', id: row.id, run, cwd: row.cwd, argv: args, env, input, setup })) {
          runs.delete(row.id);
          queueMicrotask(() => proc.emit('error', new Error(`${row.device}: disconnected before dispatch`)));
        }
      } };
      runs.set(row.id, { proc, run, device: row.device });
      return proc;
    },
    receive(device, m) {
      const r = runs.get(m.id);
      if (!r || r.device !== device || r.run !== m.run) return;
      if (m.type === 'chat-data' && typeof m.data === 'string' && ['stdout', 'stderr'].includes(m.stream)) r.proc[m.stream].write(m.data);
      if (m.type === 'chat-exit') {
        runs.delete(m.id);
        if (m.error) r.proc.stderr.write(String(m.error));
        r.proc.emit('close', m.code ?? 1);
      }
    },
    disconnect(device) {
      for (const [id, r] of runs) if (r.device === device) {
        runs.delete(id); r.proc.stderr.write(`${device}: worker disconnected`); r.proc.emit('close', 1);
      }
    },
  };
}
