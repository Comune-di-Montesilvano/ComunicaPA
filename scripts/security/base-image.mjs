#!/usr/bin/env node
// Bump del digest delle immagini base fissate nei Dockerfile, stesso tag (mai cambio di tag):
// età minima 48h del nuovo digest e provenienza "mai un downgrade di fiducia" (repository
// sorgente dell'attestazione SLSA uguale a quello del digest in uso).
//
//   node scripts/security/base-image.mjs --images node:26-alpine,python:3.14-slim --out result.json
//        [--force] [--dry-run]
// Risultato per immagine: { image, tag, action: fix|pending|unfixable, digest?, eta?, reason?, files? }
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { MIN_AGE_HOURS } from './choose-version.mjs';
import { loadConfig, allDockerfiles } from './config.mjs';

const FROM_RE = /^(\s*FROM\s+(?:--\S+\s+)*)(\S+?):([^\s@:/]+)@(sha256:[a-f0-9]{64})(.*)$/i;

export function parseFromLines(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(FROM_RE);
    if (m) out.push({ line: i + 1, image: m[2], tag: m[3], digest: m[4] });
  });
  return out;
}

export function replaceDigest(text, image, tag, newDigest) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.split(/\r?\n/).map((l) => {
    const m = l.match(FROM_RE);
    return m && m[2] === image && m[3] === tag ? `${m[1]}${image}:${tag}@${newDigest}${m[5]}` : l;
  }).join(eol);
}

export function sourceRepo(uri) {
  if (!uri) return null;
  return String(uri).split('#')[0].replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

export function decideDigest({ current, latest, now, force = false, minAgeHours = MIN_AGE_HOURS, skipDigests = [] }) {
  if (!latest?.digest || latest.digest === current.digest) return { action: 'unfixable', reason: 'nessun digest più recente' };
  if (skipDigests.includes(latest.digest) && !force) {
    return { action: 'unfixable', reason: `digest ${latest.digest} escluso: fallito in un giro precedente` };
  }
  if (current.repo && latest.repo !== current.repo) return { action: 'unfixable', reason: 'provenienza assente o diversa' };
  if (force) return { action: 'fix', digest: latest.digest };
  if (!latest.created) return { action: 'unfixable', reason: 'data di pubblicazione sconosciuta' };
  const eta = new Date(latest.created.getTime() + minAgeHours * 3600e3);
  return eta <= now ? { action: 'fix', digest: latest.digest } : { action: 'pending', digest: latest.digest, eta };
}

// ── registry (docker buildx imagetools) ───────────────────────────────────────────────────
function inspect(ref, field) {
  return JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', `{{json .${field}}}`], { encoding: 'utf8' }));
}

/**
 * Repository sorgente dall'attestazione SLSA. Output `null` = immagine senza attestazioni;
 * un errore di lettura (rete, 429) NON è "senza attestazioni": repository fittizio, così il
 * controllo di provenienza fallisce invece di essere saltato.
 */
export function provenanceOf(read, ref) {
  let prov;
  try { prov = read(); } catch { return `unverifiable:${ref}`; }
  const slsa = prov?.['linux/amd64']?.SLSA ?? prov?.SLSA;
  return sourceRepo(slsa?.invocation?.configSource?.uri);
}

/**
 * Data da cui contare le 48h: `created` dell'immagine può essere l'ora del commit sorgente
 * (build riproducibili con SOURCE_DATE_EPOCH), più vecchia del push. Su Docker Hub, se il tag
 * punta ancora a quel digest, si usa il più recente tra `created` e `tag_last_pushed`.
 */
export function publishedAt(created, hubTag, digest) {
  const pushed = hubTag?.digest === digest && hubTag.tag_last_pushed ? new Date(hubTag.tag_last_pushed) : null;
  if (!pushed) return created;
  if (!created) return pushed;
  return pushed > created ? pushed : created;
}

function hubTag(ref) {
  const m = ref.match(/^([^/:@]+(?:\/[^/:@]+)?):([^@]+)$/);
  if (!m || m[1].split('/')[0].includes('.')) return null; // non Docker Hub
  const repo = m[1].includes('/') ? m[1] : `library/${m[1]}`;
  try {
    return JSON.parse(execFileSync('curl', ['-fsS', '--max-time', '20', `https://hub.docker.com/v2/repositories/${repo}/tags/${m[2]}`], { encoding: 'utf8' }));
  } catch { return null; }
}

function describe(ref) {
  const manifest = inspect(ref, 'Manifest');
  const img = inspect(ref, 'Image');
  const amd = img?.['linux/amd64'] ?? img;
  const created = amd?.created ? new Date(amd.created) : null;
  return {
    digest: manifest.digest,
    created: ref.includes('@') ? created : publishedAt(created, hubTag(ref), manifest.digest),
    repo: provenanceOf(() => inspect(ref, 'Provenance'), ref),
  };
}

/** Dockerfile della config (produzione + extraDockerfiles) presenti sotto `root`. */
export function dockerfiles(root = '.', config = loadConfig()) {
  return allDockerfiles(config).map((p) => join(root, p)).filter((p) => existsSync(p));
}

/** image:tag dell'ultimo stage (immagine di runtime) del Dockerfile di produzione di un'app. */
export function runtimeImage(dockerfileText) {
  const f = parseFromLines(dockerfileText).at(-1);
  return f ? `${f.image}:${f.tag}` : null;
}

/** Controlla (e se fix e non dryRun applica) il digest più recente di ogni image:tag. */
export function checkImages(refs, { root = '.', config, force = false, dryRun = false, now = new Date(), skip = {} } = {}) {
  const files = dockerfiles(root, config);
  const results = [];
  for (const ref of refs) {
    const i = ref.lastIndexOf(':');
    const image = ref.slice(0, i), tag = ref.slice(i + 1);
    const using = files.filter((p) => parseFromLines(readFileSync(p, 'utf8')).some((f) => f.image === image && f.tag === tag));
    const pinned = using.length ? parseFromLines(readFileSync(using[0], 'utf8')).find((f) => f.image === image && f.tag === tag).digest : null;
    let r;
    try {
      if (!pinned) throw new Error(`${ref} non trovato nei Dockerfile`);
      r = decideDigest({ current: describe(`${image}:${tag}@${pinned}`), latest: describe(ref), now, force, skipDigests: skip[ref] ?? [] });
    } catch (e) {
      r = { action: 'unfixable', reason: `registry: ${e.message.split('\n')[0]}` };
    }
    if (r.action === 'fix' && !dryRun) {
      for (const p of using) writeFileSync(p, replaceDigest(readFileSync(p, 'utf8'), image, tag, r.digest));
      r.files = using;
    }
    results.push({ image, tag, from: pinned, ...r });
  }
  return results;
}

function main() {
  const { values } = parseArgs({ options: {
    images: { type: 'string' }, out: { type: 'string' }, root: { type: 'string', default: '.' },
    force: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  } });
  const results = checkImages((values.images ?? '').split(',').filter(Boolean),
    { root: values.root, force: values.force, dryRun: values['dry-run'] });
  if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
