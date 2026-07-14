export function splitFullName(fullName: string | null | undefined): { nome: string; cognome: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { nome: '', cognome: '' };
  if (parts.length === 1) return { nome: parts[0], cognome: '' };
  return { nome: parts.slice(0, -1).join(' '), cognome: parts[parts.length - 1] };
}
