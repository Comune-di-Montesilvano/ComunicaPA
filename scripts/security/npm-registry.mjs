// Dati dal registry npm per chooseVersion: data di pubblicazione, firma del registry e
// repository sorgente dell'attestazione di provenance (SLSA v1).
//
// Firma: ECDSA P-256 del registry su `${name}@${version}:${integrity}`, verificata con le
// chiavi pubbliche di /-/npm/v1/keys (stesso controllo di `npm audit signatures`).
// Provenance: si legge il repository dal predicato SLSA e si controlla che il subject
// corrisponda all'integrity del tarball. La verifica crittografica completa del bundle
// Sigstore la fa il registry alla pubblicazione (rifiuta attestazioni non valide); qui
// interessa il "mai un downgrade di fiducia": stessa sorgente delle versioni precedenti.
import { createPublicKey, verify } from 'node:crypto';
import { compare } from './semver-lite.mjs';

const REGISTRY = 'https://registry.npmjs.org';

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

let keysPromise;
const registryKeys = () => (keysPromise ??= getJson(`${REGISTRY}/-/npm/v1/keys`).then((d) => d.keys));

export function verifyRegistrySignature(name, version, dist, keys, publishedAt) {
  if (!dist?.integrity || !Array.isArray(dist.signatures)) return false;
  const data = Buffer.from(`${name}@${version}:${dist.integrity}`);
  return dist.signatures.some((s) => {
    const k = keys.find((x) => x.keyid === s.keyid);
    if (!k) return false;
    if (k.expires && publishedAt && new Date(k.expires) < publishedAt) return false;
    try {
      const key = createPublicKey({ key: Buffer.from(k.key, 'base64'), format: 'der', type: 'spki' });
      return verify('sha256', data, key, Buffer.from(s.sig, 'base64'));
    } catch { return false; }
  });
}

/** Repository dell'attestazione SLSA, solo se il subject corrisponde all'integrity. */
async function provenanceRepo(name, version, dist) {
  if (!dist?.attestations?.url) return null;
  try {
    const d = await getJson(dist.attestations.url);
    const expected = dist.integrity?.startsWith('sha512-')
      ? Buffer.from(dist.integrity.slice(7), 'base64').toString('hex') : null;
    for (const a of d.attestations ?? []) {
      if (a.predicateType !== 'https://slsa.dev/provenance/v1') continue;
      const st = JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
      const okSubject = st.subject?.some((s) => s.name === `pkg:npm/${name}@${version}` && s.digest?.sha512 === expected);
      const repo = st.predicate?.buildDefinition?.externalParameters?.workflow?.repository;
      if (okSubject && repo) return repo;
    }
  } catch { /* attestazione illeggibile = assente */ }
  return null;
}

// Nome npm: `nome` o `@scope/nome`, minuscolo, senza `..` né caratteri da URL. Arriva
// dall'output di audit: validato prima di comporre l'URL del registry.
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

export function registryPath(name) {
  if (!NPM_NAME.test(String(name)) || String(name).includes('..')) throw new Error(`nome pacchetto npm non valido: ${name}`);
  return name.replaceAll('/', '%2f');
}

/**
 * Candidate = versioni > current; previous = versioni <= current con l'ultima attestata
 * (basta una per stabilire che il pacchetto ha provenance e da quale repository).
 */
export async function fetchCandidates(name, current) {
  const doc = await getJson(`${REGISTRY}/${registryPath(name)}`);
  const keys = await registryKeys();
  const time = doc.time ?? {};
  const toCand = async (v, withProvenance) => {
    const dist = doc.versions[v]?.dist;
    const publishedAt = time[v] ? new Date(time[v]) : null;
    return {
      version: v, publishedAt,
      registrySigned: verifyRegistrySignature(name, v, dist, keys, publishedAt),
      provenanceRepo: withProvenance ? await provenanceRepo(name, v, dist) : null,
    };
  };
  const versions = Object.keys(doc.versions ?? {});
  const newer = versions.filter((v) => compare(v, current) > 0);
  const older = versions.filter((v) => compare(v, current) <= 0).sort(compare);
  const lastAttested = [...older].reverse().find((v) => doc.versions[v]?.dist?.attestations?.url);
  const previous = lastAttested ? [await toCand(lastAttested, true)] : [];
  // Attestata ma illeggibile: repository fittizio, così nessuna candidata combacia (mai
  // trattare un errore di rete come "pacchetto senza provenance").
  if (previous[0] && !previous[0].provenanceRepo) previous[0].provenanceRepo = `unverifiable:${lastAttested}`;
  // Provenance delle candidate solo se serve, e solo per le prime 20 in ordine crescente
  // (chooseVersion sceglie la più bassa): pacchetti con centinaia di release restano veloci.
  const sorted = newer.sort(compare);
  const candidates = await Promise.all(sorted.map((v, i) => toCand(v, previous.length > 0 && i < 20)));
  return { candidates, previous };
}
