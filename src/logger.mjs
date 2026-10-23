import fs from 'node:fs';
import path from 'node:path';

const RANK = { debug: 10, ok: 20, info: 20, warn: 30, error: 40 };

/**
 * 双通道日志器：
 *   - <name>.log   人类可读，带毫秒时间戳、级别、阶段
 *   - <name>.jsonl 一行一条 JSON，便于事后 grep / 统计 / 喂给别的工具
 *
 * 每个"任务节点"都落盘，进程被杀也只丢最后一行。
 */
export function createLogger({ dir, name = 'run', level = 'info', quiet = false, echo = true, onLine = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.join(dir, `${name}-${stamp}`);

  const txt = fs.createWriteStream(`${base}.log`, { flags: 'a' });
  const jsonl = fs.createWriteStream(`${base}.jsonl`, { flags: 'a' });

  const t0 = Date.now();
  const counts = { debug: 0, ok: 0, info: 0, warn: 0, error: 0 };
  let phase = 'init';
  let closed = false;

  const two = (n) => String(n).padStart(2, '0');
  function stampHuman() {
    const d = new Date();
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  function emit(lvl, msg, meta) {
    if (closed) return null;
    if (RANK[lvl] < RANK[level]) return null;
    counts[lvl] = (counts[lvl] || 0) + 1;

    const rec = { ts: new Date().toISOString(), lvl, phase, msg, elapsedMs: Date.now() - t0, ...(meta || {}) };
    jsonl.write(JSON.stringify(rec) + '\n');

    let extra = '';
    if (meta && Object.keys(meta).length) {
      try {
        extra = ' ' + JSON.stringify(meta);
      } catch {
        extra = '';
      }
    }
    const line = `${stampHuman()} ${lvl.toUpperCase().padEnd(5)} [${String(phase).padEnd(10)}] ${msg}${extra}`;
    txt.write(line + '\n');
    if (echo && !quiet) console.log(line);
    if (onLine) {
      try {
        onLine(line, rec);
      } catch {}
    }
    return rec;
  }

  const api = {
    get phaseName() {
      return phase;
    },
    get files() {
      return { log: `${base}.log`, jsonl: `${base}.jsonl` };
    },
    get counts() {
      return { ...counts };
    },
    get elapsedMs() {
      return Date.now() - t0;
    },

    phase(p, meta) {
      phase = p;
      emit('info', `━━ 阶段 ${p} ━━`, meta);
      return api;
    },
    node(msg, meta) {
      emit('info', `· ${msg}`, meta);
      return api;
    },
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    ok: (m, x) => emit('ok', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),

    /** 进度节点：带序号、总量、百分比、ETA */
    progress(i, total, label, meta) {
      const pct = total ? ((i / total) * 100).toFixed(1) : '0.0';
      const per = i ? (Date.now() - t0) / i : 0;
      const etaSec = Math.round((per * (total - i)) / 1000);
      emit('info', `[${i}/${total}] ${pct}% ${label}`, { etaSec, ...(meta || {}) });
      return api;
    },

    /** 汇总块，写文件也打印 */
    summary(title, rows) {
      emit('info', `━━ ${title} ━━`);
      for (const [k, v] of Object.entries(rows)) {
        emit('info', `   ${k}: ${v}`);
      }
      return api;
    },

    flush() {
      return new Promise((res) => {
        txt.end(() => jsonl.end(res));
      });
    },
    close() {
      if (closed) return;
      closed = true;
      txt.end();
      jsonl.end();
    },
  };

  return api;
}
