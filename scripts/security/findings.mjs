// Normalizzazione dei risultati di `pnpm audit --json` e Trivy (JSON) in un formato unico,
// e diff testa ↔ base per i gate differenziali (security.yml, release.yml) e l'autofix.
// Solo HIGH/CRITICAL. Nessuna dipendenza: gira con il solo Node.

/**
 * @typedef {{ tool: 'pnpm'|'trivy', ecosystem: 'npm'|'pip'|'os'|'image-lang', pkg: string,
 *   version: string, id: string, aliases: string[], severity: 'HIGH'|'CRITICAL',
 *   vulnerableRange: string|null, fixedRange: string|null, fixedVersions: string[],
 *   target: string }} Finding
 */

const SEVERE = new Set(['HIGH', 'CRITICAL']);

/** Struttura minima attesa, altrimenti errore (mai "nessun finding" su un output rotto). */
export class InvalidReportError extends Error {}

/** @returns {Finding[]} */
export function parsePnpmAudit(json, { ignoreGhsas = [] } = {}) {
  if (!json || typeof json !== 'object' || typeof json.advisories !== 'object' || json.advisories === null) {
    throw new InvalidReportError('pnpm audit: manca "advisories"');
  }
  const ignored = new Set(ignoreGhsas);
  const out = [];
  for (const adv of Object.values(json.advisories)) {
    const severity = String(adv.severity ?? '').toUpperCase();
    if (!SEVERE.has(severity)) continue;
    const id = adv.github_advisory_id ?? String(adv.id);
    if (ignored.has(id)) continue;
    const aliases = Array.isArray(adv.cves) ? adv.cves.filter((c) => c !== id) : [];
    const versions = new Set((adv.findings ?? []).map((f) => f.version));
    for (const version of versions) {
      out.push({
        tool: 'pnpm', ecosystem: 'npm', pkg: adv.module_name, version, id, aliases, severity,
        vulnerableRange: adv.vulnerable_versions ?? null,
        fixedRange: adv.patched_versions ?? null,
        fixedVersions: [],
        target: 'pnpm-lock.yaml',
      });
    }
  }
  return out;
}

// Tipi Trivy dei lockfile del repo; il resto di lang-pkgs è roba dentro l'immagine.
const NPM_LOCK_TYPES = new Set(['pnpm', 'npm', 'yarn']);
const PIP_LOCK_TYPES = new Set(['pip', 'pipenv', 'poetry', 'uv']);

function ecosystemOf(result) {
  if (result.Class === 'os-pkgs') return 'os';
  if (NPM_LOCK_TYPES.has(result.Type)) return 'npm';
  if (PIP_LOCK_TYPES.has(result.Type)) return 'pip';
  return 'image-lang';
}

/** @returns {Finding[]} */
export function parseTrivy(json) {
  if (!json || typeof json !== 'object' || !('SchemaVersion' in json)) {
    throw new InvalidReportError('trivy: manca "SchemaVersion"');
  }
  const out = [];
  for (const r of json.Results ?? []) {
    const ecosystem = ecosystemOf(r);
    for (const v of r.Vulnerabilities ?? []) {
      if (!SEVERE.has(v.Severity) || !v.FixedVersion) continue;
      const fixedVersions = String(v.FixedVersion).split(',').map((s) => s.trim()).filter(Boolean);
      // Trivy non dà il range vulnerabile: approssimato con "< della più bassa versione corretta".
      const lowest = [...fixedVersions].sort(naturalCompare)[0];
      out.push({
        tool: 'trivy', ecosystem, pkg: v.PkgName, version: v.InstalledVersion, id: v.VulnerabilityID,
        aliases: (v.VendorIDs ?? []).filter((a) => a !== v.VulnerabilityID), severity: v.Severity,
        vulnerableRange: lowest ? vulnerableFromFixed(fixedVersions) : null, fixedRange: null, fixedVersions, target: r.Target,
      });
    }
  }
  return out;
}

// Trivy dà solo le versioni corrette, una per linea di release (es. "4.2.17, 5.0.10, 5.1.4").
// Vulnerabile: sotto la prima; su ogni linea corretta, sotto la sua correzione; tra una linea e
// la successiva (linee senza correzione nota) vulnerabile in via conservativa.
export function vulnerableFromFixed(fixedVersions) {
  const sorted = [...fixedVersions].sort(naturalCompare);
  const parts = [`<${sorted[0]}`];
  for (let i = 1; i < sorted.length; i++) {
    const [pM, pm] = sorted[i - 1].split('.').map((n) => Number.parseInt(n, 10) || 0);
    const [M, m] = sorted[i].split('.').map((n) => Number.parseInt(n, 10) || 0);
    const nextLine = `${pM}.${pm + 1}.0`;
    const lineStart = `${M}.${m}.0`;
    parts.push(naturalCompare(nextLine, lineStart) < 0
      ? `>=${nextLine} <${sorted[i]}`
      : `>=${lineStart} <${sorted[i]}`);
  }
  // Linee adiacenti producono intervalli contigui: si uniscono per leggibilità solo se identici.
  return [...new Set(parts)].join(' || ');
}

// Confronto "numerico a pezzi" sufficiente a scegliere la più bassa tra versioni Trivy.
function naturalCompare(a, b) {
  const pa = a.split(/[.\-+]/), pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = Number(x), ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '' ? nx - ny : x.localeCompare(y);
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}

export function findingKey(f) {
  return `${f.ecosystem}:${f.pkg}:${f.id}`;
}

const ids = (f) => new Set([f.id, ...f.aliases]);

/** Finding di `head` senza corrispondente in `base` (stesso ecosystem+pkg, id/alias in comune). */
export function diffFindings(head, base) {
  return head.filter((h) => {
    const hi = ids(h);
    return !base.some((b) => b.ecosystem === h.ecosystem && b.pkg === h.pkg && [...ids(b)].some((i) => hi.has(i)));
  });
}

/** Lista sotto `auditConfig.ignoreGhsas` di pnpm-workspace.yaml (parsing a righe). */
export function readIgnoreGhsas(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const out = [];
  let inAudit = false, inList = false, listIndent = -1;
  for (const line of lines) {
    if (/^\S/.test(line) && !line.startsWith('#')) { inAudit = /^auditConfig:\s*$/.test(line); inList = false; continue; }
    if (!inAudit) continue;
    const key = line.match(/^(\s+)ignoreGhsas:\s*$/);
    if (key) { inList = true; listIndent = key[1].length; continue; }
    if (!inList || /^\s*(#.*)?$/.test(line)) continue;
    const item = line.match(/^(\s+)-\s*['"]?([^'"\s#]+)/);
    if (item && item[1].length >= listIndent) out.push(item[2]);
    else if (/^\s+\S/.test(line)) inList = false;
  }
  return out;
}
