/**
 * 雨课堂考试字体解码器
 *
 * 原理：
 *   字体每次请求都会重排 unicode→glyph 的 cmap，但 glyf（字形库）是固定的。
 *   所以把「glyph_id → 真实汉字」比对一次并缓存，之后只需读 cmap 就能翻译。
 *
 * 识别方式：SimHei 渲染 GB2312 全字库 → 与加密字形做包围盒归一化 + IoU 比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CACHE_FILE = (outDir) => path.join(outDir, 'glyph-map.json');

/* ───────── TTF 解析 ───────── */

export function parseTables(buf) {
  const n = buf.readUInt16BE(4);
  const t = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    t[buf.toString('ascii', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) };
  }
  return t;
}

export function parseCmap(buf, tables) {
  const cmapOff = tables.cmap.off;
  const nSub = buf.readUInt16BE(cmapOff + 2);
  let best = null;
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8;
    const pid = buf.readUInt16BE(rec);
    const off = buf.readUInt32BE(rec + 4);
    const fmt = buf.readUInt16BE(cmapOff + off);
    if (fmt === 4 && (!best || pid === 3)) best = cmapOff + off;
  }
  if (!best) throw new Error('字体里没有 format 4 的 cmap');

  const segCount = buf.readUInt16BE(best + 6) / 2;
  const endO = best + 14;
  const startO = endO + segCount * 2 + 2;
  const deltaO = startO + segCount * 2;
  const rangeO = deltaO + segCount * 2;

  const uni2gid = new Map();
  const gid2uni = new Map();
  for (let s = 0; s < segCount; s++) {
    const end = buf.readUInt16BE(endO + s * 2);
    const start = buf.readUInt16BE(startO + s * 2);
    const delta = buf.readInt16BE(deltaO + s * 2);
    const ro = buf.readUInt16BE(rangeO + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let gid;
      if (ro === 0) gid = (c + delta) & 0xffff;
      else {
        gid = buf.readUInt16BE(rangeO + s * 2 + ro + (c - start) * 2);
        if (gid) gid = (gid + delta) & 0xffff;
      }
      if (gid) {
        uni2gid.set(c, gid);
        if (!gid2uni.has(gid)) gid2uni.set(gid, c);
      }
    }
  }
  return { uni2gid, gid2uni };
}

export function fontFingerprint(buf, tables) {
  const g = buf.subarray(tables.glyf.off, tables.glyf.off + tables.glyf.len);
  return crypto.createHash('md5').update(g).digest('hex');
}

/* ───────── 缓存 ───────── */

export function loadCache(outDir) {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE(outDir), 'utf8'));
    if (c && typeof c.map === 'object') return c;
  } catch {}
  return { glyf: null, map: {} };
}

export function saveCache(outDir, cache) {
  fs.writeFileSync(CACHE_FILE(outDir), JSON.stringify(cache), 'utf8');
}

/* ───────── 浏览器端识别 ───────── */

const PAGE_FN = async ({ b64, targets }) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const face = new FontFace('encExam', bin.buffer);
  await face.load();
  document.fonts.add(face);

  const S = 96;
  const N = 32;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const cv2 = document.createElement('canvas');
  cv2.width = N;
  cv2.height = N;
  const g2 = cv2.getContext('2d', { willReadFrequently: true });

  function norm(ch, family) {
    g.clearRect(0, 0, S, S);
    g.fillStyle = '#000';
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.font = `80px "${family}"`;
    g.fillText(ch, 8, 84);
    const d = g.getImageData(0, 0, S, S).data;
    let x0 = S,
      y0 = S,
      x1 = -1,
      y1 = -1,
      ink = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (d[(y * S + x) * 4 + 3] > 96) {
          ink++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return { bmp: null, ink: 0 };
    g2.clearRect(0, 0, N, N);
    g2.drawImage(cv, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, N, N);
    const d2 = g2.getImageData(0, 0, N, N).data;
    const out = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) out[i] = d2[i * 4 + 3] > 96 ? 1 : 0;
    return { bmp: out, ink };
  }

  // GB2312 常用字库
  const dec = new TextDecoder('gbk');
  const pool = [];
  for (let hi = 0xb0; hi <= 0xf7; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      const s = dec.decode(new Uint8Array([hi, lo]));
      if (s.length === 1 && s !== '\uFFFD') {
        const r = norm(s, 'SimHei');
        if (r.bmp && r.ink > 8) pool.push({ ch: s, bmp: r.bmp, ink: r.ink });
      }
    }
  }

  const result = {};
  for (const { gid, ch } of targets) {
    const e = norm(ch, 'encExam');
    if (!e.bmp) {
      result[gid] = '';
      continue;
    }
    let best = { ch: '', s: -1 };
    for (const c of pool) {
      if (Math.abs(c.ink - e.ink) > Math.max(e.ink, c.ink) * 0.5) continue;
      let inter = 0,
        uni = 0;
      for (let i = 0; i < e.bmp.length; i++) {
        const a = e.bmp[i],
          b = c.bmp[i];
        if (a & b) inter++;
        if (a | b) uni++;
      }
      const s = uni ? inter / uni : 0;
      if (s > best.s) best = { ch: c.ch, s };
    }
    result[gid] = best.ch;
  }
  return { result, poolSize: pool.length };
};

/* ───────── 对外接口 ───────── */

/**
 * @param page  Playwright page（复用已启动的浏览器）
 * @param fontBuffer 字体字节
 * @param outDir 缓存目录
 * @param log 日志函数
 */
export async function createDecoder(page, fontBuffer, outDir, log = () => {}) {
  const tables = parseTables(fontBuffer);
  const fp = fontFingerprint(fontBuffer, tables);
  const { uni2gid, gid2uni } = parseCmap(fontBuffer, tables);

  const cache = loadCache(outDir);
  if (cache.glyf !== fp) {
    cache.glyf = fp;
    cache.map = {};
    log('字形库有变化，重建映射');
  }

  const missing = [];
  for (const [gid, uni] of gid2uni) {
    if (!cache.map[gid]) missing.push({ gid, ch: String.fromCodePoint(uni) });
  }

  if (missing.length) {
    log(`需要识别 ${missing.length} 个字形…`);
    const t0 = Date.now();
    const { result, poolSize } = await page.evaluate(PAGE_FN, {
      b64: fontBuffer.toString('base64'),
      targets: missing,
    });
    Object.assign(cache.map, result);
    saveCache(outDir, cache);
    log(`识别完成：${missing.length} 个字形 / 候选池 ${poolSize} / 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    log(`字形映射已缓存（${Object.keys(cache.map).length} 条）`);
  }

  const translate = new Map();
  for (const [uni, gid] of uni2gid) {
    const ch = cache.map[gid];
    if (ch) translate.set(uni, ch);
  }

  return {
    fingerprint: fp,
    glyphCount: gid2uni.size,
    mappedCount: translate.size,
    /** 把密文翻成明文：逐字符查表，表里没有的原样保留 */
    decode(text) {
      return String(text).replace(/[\u4e00-\u9fff]/g, (c) => translate.get(c.codePointAt(0)) ?? c);
    },
    /** 去掉 HTML 标签再解码 */
    decodeHtml(html) {
      const plain = String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      return this.decode(plain).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    },
  };
}
