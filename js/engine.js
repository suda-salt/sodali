/* ============================================================
 *  bill-analyzer · 文件读取引擎
 *  纯浏览器端实现：编码识别 / ZIP 解压 / CSV 状态机解析
 *  无任何第三方依赖
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 1. 文本解码：自动判定 UTF-8 / GBK ---------- */

  function decodeBuffer(buf) {
    // 优先按 UTF-8 解；若出现替换字符则回退 GBK
    let text = null;
    try {
      text = new TextDecoder('utf-8').decode(buf);
    } catch (e) {
      text = null;
    }
    let bad = 0;
    if (text) {
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 0xfffd) bad++;
      }
    }
    if (!text || bad > 0) {
      try {
        const gbk = new TextDecoder('gbk').decode(buf);
        if (gbk && gbk.length) {
          const gbkBad = countBad(gbk);
          if (!text || gbkBad < bad) return gbk;
        }
      } catch (e) {
        /* 浏览器不支持 gbk 时忽略 */
      }
    }
    return text || '';
  }

  function countBad(str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 0xfffd) n++;
    return n;
  }

  /* ---------- 2. ZIP 解析（仅读取，不解压到磁盘） ---------- */

  function isZip(buf) {
    return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
      (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 ZIP 解压，请解压后再上传 CSV 文件');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function listZip(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const files = [];
    // 定位 End Of Central Directory
    let eocd = -1;
    const min = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('无法识别的 ZIP 文件结构');
    const total = dv.getUint16(eocd + 10, true);
    let ptr = dv.getUint32(eocd + 16, true);

    for (let n = 0; n < total; n++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) break;
      const flags = dv.getUint16(ptr + 8, true);
      const method = dv.getUint16(ptr + 10, true);
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true);
      const extraLen = dv.getUint16(ptr + 30, true);
      const commentLen = dv.getUint16(ptr + 32, true);
      const localOff = dv.getUint32(ptr + 42, true);
      const nameBytes = buf.subarray(ptr + 46, ptr + 46 + nameLen);

      const name = (flags & 0x800)
        ? new TextDecoder('utf-8').decode(nameBytes)
        : decodeBuffer(nameBytes) || new TextDecoder('utf-8').decode(nameBytes);

      // 定位 local file header 的数据起点
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);

      if (!name.endsWith('/')) {
        files.push({ name, method, raw });
      }
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  async function unpack(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (!isZip(buf)) {
      return [{ name: file.name, text: decodeBuffer(buf) }];
    }
    const entries = await listZip(buf);
    const out = [];
    for (const e of entries) {
      if (!/\.(csv|txt|xls)$/i.test(e.name)) continue;
      let raw;
      if (e.method === 0) raw = e.raw;
      else if (e.method === 8) raw = await inflateRaw(e.raw);
      else continue;
      out.push({ name: e.name, text: decodeBuffer(raw) });
    }
    if (!out.length) throw new Error('压缩包内未找到 CSV 账单文件');
    return out;
  }

  /* ---------- 3. CSV 状态机解析 ---------- */

  function parseCSV(text, delimiter) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], field = '', inQuote = false, i = 0;
    const len = text.length;
    while (i < len) {
      const ch = text[i];
      if (inQuote) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuote = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuote = true; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      const d = delimiter || ',';
      if (ch === d || (ch === '\t' && d === '\t')) {
        row.push(field); field = ''; i++; continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  /* ---------- 4. 从原始行中定位表头 ---------- */

  const HEADER_HINTS = ['交易号', '交易时间', '交易类型', '交易对方', '交易单号', '付款时间', '收/支', '金额'];

  function locateHeader(rows) {
    const limit = Math.min(rows.length, 40);
    for (let i = 0; i < limit; i++) {
      const cells = rows[i].map(c => String(c).trim());
      if (cells.length < 4) continue;
      const joined = cells.join('|');
      let hit = 0;
      for (const h of HEADER_HINTS) if (joined.includes(h)) hit++;
      if (hit >= 2) return { index: i, cells };
    }
    return null;
  }

  global.FileEngine = { decodeBuffer, unpack, parseCSV, locateHeader, isZip };
})(window);
