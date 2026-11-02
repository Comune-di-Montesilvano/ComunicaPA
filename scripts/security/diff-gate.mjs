#!/usr/bin/env node
// Gate differenziale: fallisce solo per vulnerabilità HIGH/CRITICAL presenti nella testa e
// assenti nella base (stesso run, stesso DB vulnerabilità).
//
//   node scripts/security/diff-gate.mjs --format pnpm|trivy --head h.json (--base b.json | --base-empty)
//        [--workspace pnpm-workspace.yaml]
//
// Exit: 0 nessun nuovo · 1 nuovi (tabella su stdout) · 2 input mancante/non valido.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parsePnpmAudit, parseTrivy, diffFindings, readIgnoreGhsas } from './findings.mjs';

function fail(msg) {
  console.error(`::error::diff-gate: ${msg}`);
  process.exit(2);
}

let args;
try {
  ({ values: args } = parseArgs({ options: {
    format: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' },
    'base-empty': { type: 'boolean', default: false }, workspace: { type: 'string' },
  } }));
} catch (e) { fail(e.message); }

if (!['pnpm', 'trivy'].includes(args.format)) fail('--format pnpm|trivy obbligatorio');
if (!args.head) fail('--head obbligatorio');
if (!args.base && !args['base-empty']) fail('--base o --base-empty obbligatorio');

let ignoreGhsas = [];
if (args.workspace) {
  try { ignoreGhsas = readIgnoreGhsas(readFileSync(args.workspace, 'utf8')); } catch (e) { fail(`workspace: ${e.message}`); }
}

function load(path, label) {
  let json;
  try { json = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail(`${label} (${path}): ${e.message}`); }
  try {
    return args.format === 'pnpm' ? parsePnpmAudit(json, { ignoreGhsas }) : parseTrivy(json);
  } catch (e) { fail(`${label} (${path}): ${e.message}`); }
}

const head = load(args.head, 'testa');
const base = args['base-empty'] ? [] : load(args.base, 'base');
const nuovi = diffFindings(head, base);

console.log(`diff-gate (${args.format}): testa ${head.length}, base ${base.length}, nuovi ${nuovi.length}`);
if (nuovi.length === 0) process.exit(0);

console.log('| severità | ecosistema | pacchetto | versione | id | corretta in | target |');
console.log('|---|---|---|---|---|---|---|');
for (const f of nuovi) {
  const fix = f.fixedRange ?? f.fixedVersions.join(', ');
  console.log(`| ${f.severity} | ${f.ecosystem} | ${f.pkg} | ${f.version} | ${[f.id, ...f.aliases].join(' ')} | ${fix} | ${f.target} |`);
}
console.error(`::error::${nuovi.length} vulnerabilità HIGH/CRITICAL nuove rispetto alla base`);
process.exit(1);
