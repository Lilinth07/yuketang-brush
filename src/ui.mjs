/**
 * 终端实时进度条。
 * - TTY：单行原地刷新，日志行插到上方
 * - 非 TTY（重定向到文件 / CI）：退化为逐行输出
 * - 无第三方依赖
 */

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = {
  green: paint(32),
  yellow: paint(33),
  red: paint(31),
  cyan: paint(36),
  gray: paint(90),
  bold: paint(1),
  dim: paint(2),
};

/** 终端显示宽度：CJK / 全角算 2 */
export function visualWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** 按显示宽度截断，超出加省略号 */
export function truncate(str, maxWidth) {
  const s = String(str);
  if (visualWidth(s) <= maxWidth) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = visualWidth(ch);
    if (w + cw > maxWidth - 1) {
      out += '…';
      break;
    }
    out += ch;
    w += cw;
  }
  return out;
}

const fmtSec = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

export function createProgress({ total, label = '', stream = process.stdout } = {}) {
  const tty = Boolean(stream.isTTY);
  const t0 = Date.now();
  let lastLine = '';
  let i = 0;
  let stopped = false;

  const barWidth = () => {
    const cols = stream.columns || 80;
    return Math.max(12, Math.min(36, cols - 52));
  };

  function draw() {
    if (stopped || !tty) return;
    const cols = stream.columns || 80;
    const w = barWidth();
    const pct = total ? Math.min(1, i / total) : 0;
    const filled = Math.round(w * pct);
    const bar = color.green('█'.repeat(filled)) + color.gray('░'.repeat(w - filled));

    const elapsed = (Date.now() - t0) / 1000;
    const eta = i > 0 && total ? (elapsed / i) * (total - i) : NaN;

    const head = `${color.bold(String(i).padStart(String(total).length))}/${total} ${color.cyan(pct >= 1 ? '100%' : (pct * 100).toFixed(0) + '%')}`;
    const tail = `${color.gray(fmtSec(elapsed))}${Number.isFinite(eta) ? color.gray(` · ETA ${fmtSec(eta)}`) : ''}`;
    const used = visualWidth(`${i}/${total} 100% `) + w + visualWidth(` ${fmtSec(elapsed)} · ETA ${fmtSec(eta)}`) + 4;
    const nameW = Math.max(12, cols - used);

    const line = `${head} ${bar} ${truncate(lastLine, nameW)} ${tail}`;
    stream.write('\r\x1b[K' + line);
  }

  return {
    /** 更新状态并重绘 */
    update({ index, name, extra }) {
      if (Number.isFinite(index)) i = index;
      if (name !== undefined) lastLine = name;
      if (extra) lastLine = `${lastLine} ${extra}`;
      draw();
    },
    /** 在进度条上方打印一行（进度条会重绘到下一行） */
    log(text) {
      if (tty) {
        stream.write('\r\x1b[K');
        stream.write(String(text) + '\n');
        draw();
      } else {
        stream.write(String(text) + '\n');
      }
    },
    /** 结束，可选留一行最终状态 */
    finish(text) {
      if (tty) stream.write('\r\x1b[K');
      if (text) stream.write(String(text) + '\n');
      stopped = true;
    },
    get elapsed() {
      return (Date.now() - t0) / 1000;
    },
  };
}

/** 简单表格 */
export function table(rows, { indent = '  ' } = {}) {
  if (!rows.length) return '';
  const w1 = Math.max(...rows.map((r) => visualWidth(r[0])));
  return rows
    .map(([k, v]) => `${indent}${k}${' '.repeat(Math.max(0, w1 - visualWidth(k)))}  ${v}`)
    .join('\n');
}

/** 步骤提示 */
export function step(n, total, text) {
  return `${color.gray(`[${n}/${total}]`)} ${text}`;
}

export function ok(text) {
  return `${color.green('✓')} ${text}`;
}
export function fail(text) {
  return `${color.red('✗')} ${text}`;
}
export function warn(text) {
  return `${color.yellow('!')} ${text}`;
}
export function info(text) {
  return `${color.cyan('›')} ${text}`;
}
