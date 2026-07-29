export type NotificationChannel = 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';

export interface INotification {
  id: string;
  recipientId: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  createdAt: Date;
  sentAt: Date | null;
}

export interface IChannel {
  type: NotificationChannel;
  enabled: boolean;
  config: Record<string, string>;
}

export type OperatorRole = 'admin' | 'user';

export interface JwtOperatorPayload {
  sub: string;
  username: string;
  displayName?: string;
  role: OperatorRole;
  type: 'operator';
  iat?: number;
  exp?: number;
}

export interface CitizenTokenClaims {
  sub: string;
  codiceFiscale: string;
  email?: string;
  name?: string;
  iat?: number;
  exp?: number;
}

export interface NotificationJobData {
  campaignId: string;
  recipientId: string;
  attemptId: string;
  channel: NotificationChannel;
}

export interface ChannelSendResult {
  messageId?: string;
  responsePayload?: Record<string, unknown>;
}

/**
 * Elenco paesi (denominazione italiana) per la gestione indirizzo estero
 * POSTAL/SEND. "Italia" è il valore di default/domestico — se il paese
 * risolto per un destinatario è "Italia" (o assente), nessun campo estero
 * viene inviato ai provider (vedi payment-config.util.ts / postal.strategy.ts).
 *
 * Definito qui (non in un file separato) perché il "main" del package punta
 * direttamente a questo src/index.ts (nessuna build/dist per il dev in
 * Docker) — un import relativo a runtime tra due file di questo pacchetto
 * viene risolto da Node come ESM stretto (richiede estensione file reale su
 * disco, niente riscrittura .js->.ts): un file unico evita del tutto quella
 * risoluzione. Bug reale riscontrato: backend in crash-loop
 * (ERR_MODULE_NOT_FOUND) con COUNTRIES/matchCountry in countries.ts separato.
 */
export const COUNTRIES: readonly string[] = [
  'Italia',
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua e Barbuda',
  'Arabia Saudita', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaigian',
  'Bahamas', 'Bahrein', 'Bangladesh', 'Barbados', 'Belgio', 'Belize', 'Benin',
  'Bhutan', 'Bielorussia', 'Birmania', 'Bolivia', 'Bosnia ed Erzegovina',
  'Botswana', 'Brasile', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi',
  'Cambogia', 'Camerun', 'Canada', 'Capo Verde', 'Ciad', 'Cile', 'Cina',
  'Cipro', 'Città del Vaticano', 'Colombia', 'Comore', 'Corea del Nord',
  'Corea del Sud', "Costa d'Avorio", 'Costa Rica', 'Croazia', 'Cuba',
  'Danimarca', 'Dominica', 'Ecuador', 'Egitto', 'El Salvador',
  'Emirati Arabi Uniti', 'Eritrea', 'Estonia', 'Eswatini', 'Etiopia', 'Figi',
  'Filippine', 'Finlandia', 'Francia', 'Gabon', 'Gambia', 'Georgia',
  'Germania', 'Ghana', 'Giamaica', 'Giappone', 'Gibuti', 'Giordania',
  'Grecia', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau',
  'Guinea Equatoriale', 'Guyana', 'Haiti', 'Honduras', 'India', 'Indonesia',
  'Iran', 'Iraq', 'Irlanda', 'Islanda', 'Isole Marshall', 'Isole Salomone',
  'Israele', 'Kazakistan', 'Kenya', 'Kirghizistan', 'Kiribati', 'Kosovo',
  'Kuwait', 'Laos', 'Lesotho', 'Lettonia', 'Libano', 'Liberia', 'Libia',
  'Liechtenstein', 'Lituania', 'Lussemburgo', 'Macedonia del Nord',
  'Madagascar', 'Malawi', 'Malaysia', 'Maldive', 'Mali', 'Malta', 'Marocco',
  'Mauritania', 'Mauritius', 'Messico', 'Micronesia', 'Moldavia', 'Monaco',
  'Mongolia', 'Montenegro', 'Mozambico', 'Namibia', 'Nauru', 'Nepal',
  'Nicaragua', 'Niger', 'Nigeria', 'Norvegia', 'Nuova Zelanda', 'Oman',
  'Paesi Bassi', 'Pakistan', 'Palau', 'Panama', 'Papua Nuova Guinea',
  'Paraguay', 'Perù', 'Polonia', 'Portogallo', 'Qatar', 'Regno Unito',
  'Repubblica Ceca', 'Repubblica Centrafricana', 'Repubblica del Congo',
  'Repubblica Democratica del Congo', 'Repubblica Dominicana', 'Romania',
  'Ruanda', 'Russia', 'Saint Kitts e Nevis', 'Saint Vincent e Grenadine',
  'Samoa', 'San Marino', "Sant'Elena", 'Santa Lucia',
  'São Tomé e Príncipe', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone',
  'Singapore', 'Siria', 'Slovacchia', 'Slovenia', 'Somalia', 'Spagna',
  'Sri Lanka', 'Stati Uniti d\'America', 'Sudafrica', 'Sudan',
  'Sudan del Sud', 'Suriname', 'Svezia', 'Svizzera', 'Tagikistan', 'Taiwan',
  'Tanzania', 'Thailandia', 'Timor Est', 'Togo', 'Tonga',
  'Trinidad e Tobago', 'Tunisia', 'Turchia', 'Turkmenistan', 'Tuvalu',
  'Ucraina', 'Uganda', 'Ungheria', 'Uruguay', 'Uzbekistan', 'Vanuatu',
  'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
] as const;

function normalizeCountryName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(new RegExp("[\\u0027\\u2019]", "g"), "’") // normalizza apostrofo tipografico (curly, U+2019) o dritto a un apostrofo dritto
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "") // rimuove diacritici (é->e, ù->u, ...)
    .replace(/’/g, "") // rimuove apostrofi — dato PA comune: vocale accentata
    // sostituita con lettera base + apostrofo finale (es. "PERU’" per "Perù")
    .replace(/\s+/g, ""); // rimuove spazi — es. "SUD AFRICA" vs "Sudafrica"
}

const COUNTRY_NORMALIZED_INDEX: Map<string, string> = new Map(
  COUNTRIES.map((c) => [normalizeCountryName(c), c]),
);

/**
 * Cerca `raw` in COUNTRIES ignorando maiuscole/minuscole, accenti e spazi
 * superflui. Ritorna la denominazione canonica o null se nessun match —
 * usato sia per il matching bulk (wizard/backend) sia per la
 * precompilazione da ANPR (Sezione 4 dello spec).
 */
export function matchCountry(raw: string): string | null {
  const key = normalizeCountryName(raw);
  if (!key) return null;
  return COUNTRY_NORMALIZED_INDEX.get(key) ?? null;
}

/**
 * CAP domestico italiano — 5 cifre. Stessa regola richiesta sia dal wizard
 * campagne sia dalla validazione in Arricchimento Tracciati (vedi
 * docs/superpowers/specs/2026-07-29-arricchimento-validazione-design.md) —
 * unica definizione condivisa invece di una copia locale per consumer.
 */
export function isValidCap(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}
