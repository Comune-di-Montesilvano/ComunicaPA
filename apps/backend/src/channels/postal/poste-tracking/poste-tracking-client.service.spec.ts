import { describe, it, expect, vi, afterEach } from 'vitest';
import { PosteTrackingClient, POSTE_TRACKING_URL } from './poste-tracking-client.service.js';
import { PosteTrackingError } from './poste-tracking-mapping.util.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('PosteTrackingClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST con il body atteso e risposta normalizzata', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ esitoRicerca: '3', stato: '5', listaMovimenti: [] }));
    const r = await new PosteTrackingClient().track('RN000000000IT');
    expect(r.stato).toBe('5');
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(POSTE_TRACKING_URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ tipoRichiedente: 'WEB', codiceSpedizione: 'RN000000000IT', periodoRicerca: 1 });
    expect(init?.signal).toBeDefined();
  });

  it('errore di rete/timeout → kind network', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The operation was aborted due to timeout'));
    await expect(new PosteTrackingClient().track('X')).rejects.toMatchObject({ kind: 'network' });
  });

  it('HTTP non 2xx → kind http', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    await expect(new PosteTrackingClient().track('X')).rejects.toMatchObject({ kind: 'http' });
  });

  it('body HTML (200) → kind invalid_body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>blocked</html>', { status: 200 }));
    const err = await new PosteTrackingClient().track('X').catch((e) => e);
    expect(err).toBeInstanceOf(PosteTrackingError);
    expect(err.kind).toBe('invalid_body');
  });
});
