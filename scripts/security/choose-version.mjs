// Scelta della versione corretta di un pacchetto npm vulnerabile (funzione pura, niente I/O).
// Regole (docs/superpowers/specs/2026-11-02-security-autofix-design.md):
//  - la più bassa versione > current che non cade in nessun range vulnerabile, prima nella
//    stessa major poi nelle successive; mai prerelease;
//  - età minima 48h dalla pubblicazione (forceVersion la salta, mai la provenienza);
//  - provenienza "mai un downgrade di fiducia": firma registry sempre; se una versione
//    precedente aveva provenance, la scelta deve averla dallo stesso repository.
import { compare, satisfies, isPrerelease, major } from './semver-lite.mjs';

export const MIN_AGE_HOURS = 48;

/** @typedef {{ version: string, publishedAt: Date|null, provenanceRepo: string|null, registrySigned: boolean }} Candidate */

const normRepo = (r) => String(r).trim().toLowerCase().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');

function trusted(cand, previous, candidates = []) {
  if (!cand.registrySigned) return false;
  // Precedenti = versioni fino a quella installata + candidate più basse della scelta (anche
  // vulnerabili): una provenance comparsa in mezzo vincola tutte le successive.
  const before = [...previous, ...candidates.filter((c) => compare(c.version, cand.version) < 0)];
  const prevRepos = before.map((p) => p.provenanceRepo).filter(Boolean).map(normRepo);
  if (prevRepos.length === 0) return true;
  return cand.provenanceRepo != null && prevRepos.includes(normRepo(cand.provenanceRepo));
}

/**
 * @param {{ current: string, vulnerableRanges: string[], candidates: Candidate[], previous: Candidate[],
 *   now: Date, minAgeHours?: number, forceVersion?: string }} p
 * @returns {{action:'fix',version:string}|{action:'pending',version:string,eta:Date}|{action:'unfixable',reason:string}}
 */
export function chooseVersion({ current, vulnerableRanges, fixedRanges = [], skipVersions = [], candidates, previous, now,
  minAgeHours = MIN_AGE_HOURS, forceVersion }) {
  const curMajor = major(current);
  const correct = candidates
    .filter((c) => !isPrerelease(c.version) && compare(c.version, current) > 0)
    .filter((c) => !vulnerableRanges.some((r) => satisfies(c.version, r)))
    // patched_versions dell'advisory, quando c'è: deve valere per tutte.
    .filter((c) => fixedRanges.every((r) => satisfies(c.version, r)));
  // Versioni fallite in un giro precedente: si prova la successiva corretta.
  const skipped = correct.filter((c) => skipVersions.includes(c.version)).map((c) => c.version);
  const fixing = correct
    .filter((c) => !skipVersions.includes(c.version))
    .sort((a, b) => {
      const sa = major(a.version) === curMajor ? 0 : 1, sb = major(b.version) === curMajor ? 0 : 1;
      return sa - sb || compare(a.version, b.version);
    });

  if (forceVersion) {
    const f = correct.find((c) => c.version === forceVersion);
    if (!f) return { action: 'unfixable', reason: `versione forzata ${forceVersion} non corregge` };
    return trusted(f, previous, candidates) ? { action: 'fix', version: f.version } : { action: 'unfixable', reason: 'provenienza assente o diversa' };
  }

  if (fixing.length === 0) {
    return { action: 'unfixable', reason: skipped.length ? `nessuna versione corretta (escluse: ${skipped.join(', ')})` : 'nessuna versione corretta' };
  }

  const minAgeMs = minAgeHours * 3600e3;
  let firstYoung = null, sawUntrusted = false, sawUndated = false;
  for (const c of fixing) {
    if (!trusted(c, previous, candidates)) { sawUntrusted = true; continue; }
    if (!c.publishedAt) { sawUndated = true; continue; }
    if (now.getTime() - c.publishedAt.getTime() >= minAgeMs) return { action: 'fix', version: c.version };
    firstYoung ??= c;
  }
  if (firstYoung) return { action: 'pending', version: firstYoung.version, eta: new Date(firstYoung.publishedAt.getTime() + minAgeMs) };
  if (sawUndated) return { action: 'unfixable', reason: 'data di pubblicazione sconosciuta' };
  if (sawUntrusted) return { action: 'unfixable', reason: 'provenienza assente o diversa' };
  return { action: 'unfixable', reason: 'nessuna versione corretta' };
}
