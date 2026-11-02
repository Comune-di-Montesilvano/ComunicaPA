// Semver minimo per i range delle advisory npm: comparatori <, <=, >, >=, = (o versione
// nuda), spazio = AND, `||` = OR. Niente ^/~/x-range: le advisory non li usano.

const parse = (v) => {
  const [core, pre] = String(v).trim().replace(/^v/, '').split('-', 2);
  const [a = 0, b = 0, c = 0] = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return { nums: [a, b, c], pre: pre ?? null };
};

export const isPrerelease = (v) => parse(v).pre !== null;
export const major = (v) => parse(v).nums[0];

/** @returns {-1|0|1} */
export function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const OPS = {
  '<': (c) => c < 0, '<=': (c) => c <= 0, '>': (c) => c > 0, '>=': (c) => c >= 0, '=': (c) => c === 0,
};

// Un token → lista di comparatori [op, versione]; null = specifier non semver (workspace:,
// npm:, url, tag): non soddisfatto da nessuna versione.
function expand(t) {
  if (t === '*' || /^[xX]$/.test(t)) return [];
  const m = t.match(/^(\^|~|<=|>=|<|>|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  const [, op, M, mi, pa, pre] = m;
  const wild = (s) => s === undefined || /^[xX*]$/.test(s);
  const nM = Number(M), nmi = Number(mi), npa = Number(pa);
  if (wild(M)) return [];
  if (!op || op === '=') {
    if (wild(mi)) return [['>=', `${nM}.0.0`], ['<', `${nM + 1}.0.0`]];
    if (wild(pa)) return [['>=', `${nM}.${nmi}.0`], ['<', `${nM}.${nmi + 1}.0`]];
    return [['=', `${nM}.${nmi}.${npa}${pre ?? ''}`]];
  }
  const base = `${nM}.${wild(mi) ? 0 : nmi}.${wild(pa) ? 0 : npa}${pre ?? ''}`;
  if (op === '^') {
    if (nM > 0 || wild(mi)) return [['>=', base], ['<', `${nM + 1}.0.0`]];
    if (nmi > 0 || wild(pa)) return [['>=', base], ['<', `0.${nmi + 1}.0`]];
    return [['>=', base], ['<', `0.0.${npa + 1}`]];
  }
  if (op === '~') return [['>=', base], ['<', wild(mi) ? `${nM + 1}.0.0` : `${nM}.${nmi + 1}.0`]];
  return [[op, base]];
}

export function satisfies(version, range) {
  return String(range).split('||').some((set) => {
    const tokens = set.trim().replace(/(\^|~|<=|>=|<|>|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const comps = [];
    for (const t of tokens) {
      const c = expand(t);
      if (c === null) return false;
      comps.push(...c);
    }
    return comps.every(([op, v]) => OPS[op](compare(version, v)));
  });
}
