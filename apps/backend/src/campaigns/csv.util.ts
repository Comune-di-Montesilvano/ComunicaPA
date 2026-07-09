/**
 * Previene CSV/formula injection: Excel interpreta come formula un campo il
 * cui contenuto (dopo aver rimosso le virgolette di CSV) inizia con = + - @.
 * Anteponendo un apice si forza Excel a trattarlo come testo.
 */
export function escapeCsvField(value: string): string {
  const sanitized = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${sanitized.replace(/"/g, '""')}"`;
}
