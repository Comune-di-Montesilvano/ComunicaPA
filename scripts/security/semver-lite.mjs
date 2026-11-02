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

export function satisfies(version, range) {
  return String(range).split('||').some((set) => {
    const tokens = set.trim().replace(/(<=|>=|<|>|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((t) => {
      const m = t.match(/^(<=|>=|<|>|=)?(.+)$/);
      return OPS[m[1] ?? '='](compare(version, m[2]));
    });
  });
}
