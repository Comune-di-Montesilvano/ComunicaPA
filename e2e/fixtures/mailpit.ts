import { MAILPIT_URL } from './env';

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Name: string; Address: string }>;
}

/** Ricerca Mailpit (stessa sintassi della UI): `GET /api/v1/search?query=`. */
export async function searchMessages(query: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(query)}&limit=200`);
  if (!res.ok) throw new Error(`Mailpit search: HTTP ${res.status}`);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

/** Svuota la casella (`DELETE /api/v1/messages`). */
export async function deleteAllMessages(): Promise<void> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Mailpit delete: HTTP ${res.status}`);
}
