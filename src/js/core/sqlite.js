/**
 * sqlite.js — 只读 SQLite 数据库文件读取器（纯 JS，零依赖）
 *
 * 为什么要自己写
 * ──────────────
 * 本工程有三条硬约定：**零第三方依赖**、**浏览器 / Node 双栈通用**、
 * **单文件可双击直接跑**。引入 sql.js 会同时破坏这三条（WASM 体积 + 需要 fetch
 * 同目录的 .wasm + 需要 Node 侧的 fs）。而我们面对的是 POWER-Z 导出的
 * 小型只读库：两张普通表、无索引、无触发器、无视图、无 WAL，
 * 所以照 SQLite 文件格式规范（https://sqlite.org/fileformat2.html）
 * 实现「读」这一半就够了，代码量完全可控。
 *
 * 覆盖范围
 * ────────
 *   · 数据库头 100 字节：页大小、保留区、文本编码、页数
 *   · sqlite_master（第 1 页）→ 各表的名字、根页号、建表语句
 *   · 表 B-tree：叶子页 + 内部页（多级时递归下钻）
 *   · 记录格式：varint 头 + serial type → int / float / text / blob / NULL
 *   · 溢页：payload 超过一页时按规范公式算出「页内字节数」，再顺着溢页链取完
 *
 * 明确不支持的（读不到，也不影响本工程用途，遇到会显式报错而非静默乱码）
 * ─────────────────────────────────────────────────────────────────────
 *   · 索引页（0x02 / 0x0A）—— 我们只顺序读全表，用不上
 *   · WAL 尚未 checkpoint 的内容（导出文件都是普通回滚日志模式）
 *   · 加密库、UTF-16 文本编码、虚拟表
 */

/** 数据库头 16 字节魔数 */
const MAGIC = 'SQLite format 3\u0000';

/** 页类型 */
const PAGE_INTERIOR_INDEX = 0x02;
const PAGE_INTERIOR_TABLE = 0x05;
const PAGE_LEAF_INDEX = 0x0A;
const PAGE_LEAF_TABLE = 0x0D;

/* ────────────────────────── 基础读取 ────────────────────────── */

/**
 * 读一个 varint。SQLite 用的是「大端、每字节 7bit、最高位为续读标志」的变长编码，
 * 最长 9 字节（第 9 字节整字节有效，共能给到 64bit，够覆盖 rowid 与长度）。
 */
function varint(u8, off) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const b = u8[off + i];
    v = v * 128 + (b & 0x7F);
    if ((b & 0x80) === 0) return { value: v, size: i + 1 };
  }
  return { value: v * 256 + u8[off + 8], size: 9 };
}

const u16be = (u8, o) => (u8[o] << 8) | u8[o + 1];
// 不用 <<24：JavaScript 的位运算只有 32bit 有符号，页号/页数虽远小于 2^31，
// 但保持乘法写法可以在数值变大时也不会突然变成负数。
const u32be = (u8, o) => u8[o] * 0x1000000 + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3];

/** 大端定长整数 → JS number（带符号还原；8 字节走 BigInt 以免丢精度） */
function intBE(u8, o, len) {
  if (len === 8) {
    let b = 0n;
    for (let i = 0; i < 8; i++) b = (b << 8n) | BigInt(u8[o + i]);
    return Number(BigInt.asIntN(64, b));
  }
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + u8[o + i];
  const lim = Math.pow(2, len * 8 - 1);
  return v >= lim ? v - lim * 2 : v;
}

/** 大端 float64（借用 DataView，注意 u8 可能是大 buffer 的 subarray） */
function f64BE(u8, o) {
  const dv = new DataView(u8.buffer, u8.byteOffset + o, 8);
  return dv.getFloat64(0, false);
}

/* ────────────────────────── 主体 ────────────────────────── */

export class SqliteReader {
  /** @param {Uint8Array} u8 整个数据库文件的字节 */
  constructor(u8) {
    if (!u8 || u8.length < 100) throw new Error('文件过小，不是 SQLite 数据库');
    let magic = '';
    for (let i = 0; i < 16; i++) magic += String.fromCharCode(u8[i]);
    if (magic !== MAGIC) throw new Error('不是 SQLite 数据库（文件头魔数不匹配）');

    this.u8 = u8;

    let ps = u16be(u8, 16);
    if (ps === 1) ps = 65536;                    // 规范：写 1 表示 64 KiB
    if (ps < 512 || (ps & (ps - 1)) !== 0) throw new Error(`SQLite 页大小非法：${ps}`);
    this.pageSize = ps;
    this.reservedBytes = u8[20];
    /** 每页真正可用的字节数（页尾可能留给校验/加密） */
    this.usableSize = ps - this.reservedBytes;

    this.writeVersion = u8[18];                  // 1=回滚日志 2=WAL
    this.readVersion = u8[19];
    this.textEncoding = u32be(u8, 56);           // 1=UTF-8 2=UTF-16le 3=UTF-16be
    this.schemaVersion = u32be(u8, 40);
    this.pageCount = u32be(u8, 28) || Math.floor(u8.length / ps);

    this._decoder = null;
    this._tables = null;
  }

  /** 页号（1 起）→ 该页在文件里的字节偏移 */
  _offset(pageNo) {
    const off = (pageNo - 1) * this.pageSize;
    if (pageNo < 1 || off + this.pageSize > this.u8.length) {
      throw new Error(`页号 ${pageNo} 越界（文件共 ${this.pageCount} 页）`);
    }
    return off;
  }

  /**
   * 页内 B-tree 头的偏移。
   * 第 1 页与众不同：它前面 100 字节是数据库头，B-tree 头从 100 开始。
   */
  _headerAt(pageNo) {
    return this._offset(pageNo) + (pageNo === 1 ? 100 : 0);
  }

  /* ── 表结构 ── */

  /** @returns {Map<string, {type:string,name:string,tblName:string,root:number,sql:string|null}>} */
  get tables() {
    if (this._tables) return this._tables;
    const out = new Map();
    for (const r of this._tableRows(1)) {
      const [type, name, tblName, root, sql] = r;
      if (name == null) continue;
      out.set(String(name), {
        type: String(type ?? ''),
        name: String(name),
        tblName: tblName == null ? '' : String(tblName),
        root: typeof root === 'number' ? root : 0,
        sql: sql == null ? null : String(sql),
      });
    }
    this._tables = out;
    return out;
  }

  /** 表名 → 定义（不存在返回 null） */
  table(name) { return this.tables.get(name) ?? null; }
  hasTable(name) { return this.tables.has(name); }

  /* ── 表数据 ── */

  /**
   * 顺序遍历某张表的全部行，每行是一个「按列顺序排列的值数组」。
   * 值类型：number | bigint | string | Uint8Array | null
   */
  *rows(tableName) {
    const t = this.table(tableName);
    if (!t) throw new Error(`表 ${tableName} 不存在`);
    if (!t.root) return;
    yield* this._tableRows(t.root);
  }

  /** 行数（走一遍 B-tree 只数叶子页的 cell，不构造记录；比 rows().length 快得多） */
  count(tableName) {
    const t = this.table(tableName);
    if (!t || !t.root) return 0;
    let n = 0;
    const stack = [t.root];
    while (stack.length) {
      const pg = stack.pop();
      const h = this._headerAt(pg);
      const type = this.u8[h];
      const cells = u16be(this.u8, h + 3);
      if (type === PAGE_INTERIOR_TABLE) {
        // 内部页的 cell 是「分隔键 + 左子页指针」，本身不是一行 —— 不能计入行数
        const ptr = h + 12;
        for (let i = 0; i < cells; i++) stack.push(u32be(this.u8, this._offset(pg) + u16be(this.u8, ptr + 2 * i)));
        stack.push(u32be(this.u8, h + 8));       // 最右子页
      } else if (type === PAGE_LEAF_TABLE) {
        n += cells;
      } else {
        throw new Error(`游走的不是表 B-tree 页（页 ${pg}，类型 0x${type.toString(16)}）`);
      }
    }
    return n;
  }

  /** 遍历一棵表 B-tree 的全部行（按 rowid 升序） */
  *_tableRows(rootPage) {
    const stack = [rootPage];
    while (stack.length) {
      const pg = stack.pop();
      const base = this._offset(pg);
      const h = this._headerAt(pg);
      const type = this.u8[h];

      if (type === PAGE_INTERIOR_TABLE) {
        const cells = u16be(this.u8, h + 3);
        const ptr = h + 12;
        // 子页在页内的排列是 child[0] … child[n-1]、最右子页；按 rowid 升序必须
        // 「先压最右子页、再倒着压 cells」，这样出栈顺序才是从左到右。
        stack.push(u32be(this.u8, h + 8));
        for (let i = cells - 1; i >= 0; i--) {
          stack.push(u32be(this.u8, base + u16be(this.u8, ptr + 2 * i)));
        }
      } else if (type === PAGE_LEAF_TABLE) {
        const cells = u16be(this.u8, h + 3);
        const ptr = h + 8;
        for (let i = 0; i < cells; i++) {
          const cell = base + u16be(this.u8, ptr + 2 * i);
          yield this._decodeRecord(this._cellPayload(cell));
        }
      } else if (type === PAGE_LEAF_INDEX || type === PAGE_INTERIOR_INDEX) {
        throw new Error(`页 ${pg} 是索引 B-tree，本读取器只读表`);
      } else {
        throw new Error(`未知的页类型 0x${type.toString(16)}（页 ${pg}）`);
      }
    }
  }

  /* ── 记录 ── */

  /**
   * 取表叶子页某个 cell 的 payload（自动处理溢页）。
   * cell 布局：payload 长度 varint → rowid varint → payload（可能跨页）
   */
  _cellPayload(cell) {
    const pv = varint(this.u8, cell);
    const rv = varint(this.u8, cell + pv.size);
    const start = cell + pv.size + rv.size;
    const P = pv.value;
    const U = this.usableSize;

    // 规范：先算「最多能留在本页的字节数」X = U - 35
    const maxLocal = U - 35;
    if (P <= maxLocal) return this.u8.subarray(start, start + P);

    // 超了：M = ((U-12)*32/255) - 23；K = M + (P-M) % (U-4)；K ≤ X 则留 K，否则留 M
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((P - M) % (U - 4));
    const local = K <= maxLocal ? K : M;

    const out = new Uint8Array(P);
    out.set(this.u8.subarray(start, start + local), 0);
    let filled = local;
    // 页内 payload 末尾 4 字节是第一个溢页号，之后每页前 4 字节指向下一页
    let next = u32be(this.u8, start + local);
    const capacity = U - 4;
    while (next && filled < P) {
      const o = this._offset(next);
      const take = Math.min(capacity, P - filled);
      out.set(this.u8.subarray(o + 4, o + 4 + take), filled);
      filled += take;
      next = u32be(this.u8, o);
    }
    if (filled < P) throw new Error(`溢页链断裂：记录还需 ${P - filled} 字节`);
    return out;
  }

  /**
   * payload → 值数组。格式：header 长度 varint → serial type varint... → 数据区
   *
   * 注意 header 长度这个值的口径（规范原文：“the number of bytes in the header,
   * **including the bytes in the header size varint**”）—— 它是「从 payload 第 0 字节起、
   * 到数据区开始为止」的**绝对字节数**，本身就含掉那个长度 varint 自己。
   * 所以数据区起点 = `hv.value`，不是 `hv.size + hv.value`（写成后者会整体后移，
   * 然后多读出一个串味的字段 —— 症状是列名/文本被啃掉头两个字符）。
   */
  _decodeRecord(payload) {
    const hv = varint(payload, 0);
    const headerEnd = hv.value;

    const types = [];
    let o = hv.size;
    while (o < headerEnd) {
      const t = varint(payload, o);
      types.push(t.value);
      o += t.size;
    }

    const out = new Array(types.length);
    let b = headerEnd;
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      if (t === 0) { out[i] = null; continue; }
      if (t === 8) { out[i] = 0; continue; }
      if (t === 9) { out[i] = 1; continue; }
      if (t === 10 || t === 11) { out[i] = null; continue; }   // 内部用，规范要求当 NULL
      if (t === 7) { out[i] = f64BE(payload, b); b += 8; continue; }
      if (t >= 1 && t <= 6) {
        const len = [0, 1, 2, 3, 4, 6, 8][t];
        out[i] = intBE(payload, b, len);
        b += len;
        continue;
      }
      if (t >= 12 && (t & 1) === 0) {                          // 偶数且 ≥12 → BLOB
        const len = (t - 12) >> 1;
        out[i] = payload.slice(b, b + len);
        b += len;
        continue;
      }
      if (t >= 13) {                                           // 奇数且 ≥13 → TEXT
        const len = (t - 13) >> 1;
        out[i] = this._text(payload, b, len);
        b += len;
        continue;
      }
      out[i] = null;
    }
    return out;
  }

  _text(u8, o, len) {
    if (!this._decoder) {
      const enc = this.textEncoding === 1 ? 'utf-8'
        : this.textEncoding === 2 ? 'utf-16le'
          : this.textEncoding === 3 ? 'utf-16be' : null;
      if (!enc) throw new Error(`未知的 SQLite 文本编码 ${this.textEncoding}`);
      this._decoder = new TextDecoder(enc);
    }
    if (len <= 0) return '';
    return this._decoder.decode(u8.subarray(o, o + len));
  }

  /** 给界面/日志用的一句话摘要 */
  describe() {
    const t = [...this.tables.values()].filter((x) => x.type === 'table').map((x) => x.name);
    return `${this.pageSize} B/页 · ${this.pageCount} 页 · 文本编码 UTF-8 系(${this.textEncoding}) · 表 [${t.join(', ')}]`;
  }
}

/** 是不是 SQLite 文件（只看魔数，不解析） */
export function isSqlite(u8) {
  if (!u8 || u8.length < 16) return false;
  for (let i = 0; i < 16; i++) if (u8[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}
