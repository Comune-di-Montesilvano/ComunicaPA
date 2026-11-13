// Configurazione dell'autofix per repo (scripts/security/autofix.config.json): gli script sono
// uguali tra i repo del Comune, cambiano solo directory pnpm, Dockerfile, file che il bot può
// committare e la parte pip.
//
// {
//   "pnpmDirs": ["."],                         progetti pnpm (ognuno con il suo lockfile)
//   "dockerfiles": { "<app>": "<Dockerfile>" }, Dockerfile di produzione per immagine pubblicata
//   "extraDockerfiles": ["..."],               altri Dockerfile con le stesse basi (facoltativo)
//   "allowedFiles": ["apps/*/package.json"],   file committabili dal bot (`*` = un segmento)
//   "pip": { "dir": "services/x" } | null      progetto pip-compile, null = nessuno
// }
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'autofix.config.json');

const KEYS = ['pnpmDirs', 'dockerfiles', 'extraDockerfiles', 'allowedFiles', 'pip'];
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);

export function parseConfig(raw) {
  const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw new Error(`autofix.config.json: chiavi sconosciute ${unknown.join(', ')}`);
  if (!isStrings(raw.pnpmDirs) || !raw.pnpmDirs.length) throw new Error('autofix.config.json: pnpmDirs obbligatorio (array di directory)');
  if (typeof raw.dockerfiles !== 'object' || raw.dockerfiles === null || Array.isArray(raw.dockerfiles)) {
    throw new Error('autofix.config.json: dockerfiles = { app: Dockerfile }');
  }
  if (!isStrings(raw.allowedFiles)) throw new Error('autofix.config.json: allowedFiles obbligatorio (array di percorsi)');
  if (raw.extraDockerfiles !== undefined && !isStrings(raw.extraDockerfiles)) throw new Error('autofix.config.json: extraDockerfiles = array');
  if (raw.pip !== null && (typeof raw.pip !== 'object' || typeof raw.pip?.dir !== 'string')) {
    throw new Error('autofix.config.json: pip = { dir } oppure null');
  }
  return { pnpmDirs: raw.pnpmDirs, dockerfiles: raw.dockerfiles, extraDockerfiles: raw.extraDockerfiles ?? [],
    allowedFiles: raw.allowedFiles, pip: raw.pip };
}

export const loadConfig = (path = CONFIG_PATH) => parseConfig(JSON.parse(readFileSync(path, 'utf8')));

/** Percorsi con `*` (un solo segmento, senza `/`) → funzione che dice se un file è committabile. */
export function allowedMatcher(patterns) {
  const res = patterns.map((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`));
  return (path) => res.some((re) => re.test(path));
}

/** Chiave di un finding/gruppo: la directory pnpm entra solo fuori dalla radice. */
export function findingKey(f) {
  const dir = f.dir && f.dir !== '.' ? `${f.dir}/` : '';
  return `${f.ecosystem}:${dir}${f.pkg}@${f.version ?? f.current}`;
}

/** Tutti i Dockerfile da aggiornare quando cambia il digest di una base. */
export const allDockerfiles = (c) => [...new Set([...Object.values(c.dockerfiles), ...c.extraDockerfiles])];
