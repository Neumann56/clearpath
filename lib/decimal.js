/**
 * 精确十进制运算（BigInt 分数实现）
 * 铁律 BR-04：禁止逐步舍入，只在输出时 round2(HALF_UP)。
 * 用分数而非定点数，是因为 gross-up 的 base/(1-rate)*rate 无法用定点精确表示。
 */
const gcd = (a, b) => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1n;
};

export class D {
  constructor(n, d = 1n) {
    if (d === 0n) throw new Error('E_DIV_ZERO');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }

  static of(v) {
    if (v instanceof D) return v;
    if (v === null || v === undefined || v === '') return new D(0n);
    if (typeof v === 'bigint') return new D(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('E_DECIMAL_INVALID');
      return D.fromString(v.toFixed(10).replace(/0+$/, '').replace(/\.$/, ''));
    }
    if (typeof v === 'string') return D.fromString(v);
    if (typeof v === 'object' && v.n !== undefined) return new D(BigInt(v.n), BigInt(v.d));
    throw new Error('E_DECIMAL_INVALID');
  }

  static fromString(s) {
    const raw = String(s).trim();
    const m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(raw);
    if (!m || (m[2] === '' && m[3] === undefined)) throw new Error('E_DECIMAL_INVALID ' + s);
    const sign = m[1] === '-' ? -1n : 1n;
    const int = m[2] || '0';
    const frac = m[3] || '';
    const den = 10n ** BigInt(frac.length);
    return new D(sign * BigInt(int + frac), den);
  }

  static zero() {
    return ZERO;
  }

  add(o) {
    o = D.of(o);
    return new D(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o) {
    o = D.of(o);
    return new D(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o) {
    o = D.of(o);
    return new D(this.n * o.n, this.d * o.d);
  }
  div(o) {
    o = D.of(o);
    if (o.n === 0n) throw new Error('E_DIV_ZERO');
    return new D(this.n * o.d, this.d * o.n);
  }
  neg() {
    return new D(-this.n, this.d);
  }
  abs() {
    return this.n < 0n ? this.neg() : this;
  }
  cmp(o) {
    o = D.of(o);
    const a = this.n * o.d;
    const b = o.n * this.d;
    return a > b ? 1 : a < b ? -1 : 0;
  }
  eq(o) {
    return this.cmp(o) === 0;
  }
  gt(o) {
    return this.cmp(o) > 0;
  }
  gte(o) {
    return this.cmp(o) >= 0;
  }
  lt(o) {
    return this.cmp(o) < 0;
  }
  lte(o) {
    return this.cmp(o) <= 0;
  }
  isZero() {
    return this.n === 0n;
  }
  isNeg() {
    return this.n < 0n;
  }
  max(o) {
    return this.gte(o) ? this : D.of(o);
  }
  min(o) {
    return this.lte(o) ? this : D.of(o);
  }

  /**
   * 精确 HALF_UP 保留 k 位小数，返回不带千分位的字符串。
   * 注意：这不能和"金额到分"混用——税率 0.125 若按 2 位舍入会变成 0.13，
   * 显示成 13.00%，与真实税率 12.50% 不符（税率不是钱，不该按分处理）。
   */
  toFixedDigits(k = 2) {
    const scale = 10n ** BigInt(k);
    const scaled = this.n * scale;
    const q = scaled / this.d;
    const r = scaled % this.d;
    const absR = r < 0n ? -r : r;
    let v = q;
    if (absR * 2n >= this.d) v += scaled < 0n ? -1n : 1n;
    const neg = v < 0n;
    const abs = (neg ? -v : v).toString().padStart(k + 1, '0');
    const int = abs.slice(0, abs.length - k) || '0';
    const frac = k > 0 ? '.' + abs.slice(abs.length - k) : '';
    return (neg ? '-' : '') + int + frac;
  }

  /** HALF_UP 到分，返回 BigInt（分） */
  toCents() {
    const scaled = this.n * 100n;
    const q = scaled / this.d;
    const r = scaled % this.d;
    const absR = r < 0n ? -r : r;
    if (absR * 2n >= this.d) return q + (scaled < 0n ? -1n : 1n);
    return q;
  }

  /**
   * 输出用数字。保留 10 位小数即可覆盖税率/比率（12.5%、4.45%、1/3 的比值），
   * 又不引入 0.30000000000000004 这类浮点噪声。金额在入库前已由 money() 收敛到分。
   */
  toNumber() {
    return Number(this.toFixedDigits(10));
  }

  toFixed2() {
    return fmt(this);
  }

  toString() {
    return this.toFixed2();
  }

  toJSON() {
    return this.toNumber();
  }
}

export const ZERO = new D(0n);
export const ONE = new D(1n);

export const d = (v) => D.of(v);

/** 把金额四舍五入到"分"后仍以 D 表示（用于生成可复现的中间金额，如保险默认值） */
export function money(v) {
  return new D(D.of(v).toCents(), 100n);
}

export function fmt(v) {
  const s = D.of(v).toFixedDigits(2);
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f;
}

export function pct(v, digits = 2) {
  return D.of(v).mul(100).toFixedDigits(digits) + '%';
}
