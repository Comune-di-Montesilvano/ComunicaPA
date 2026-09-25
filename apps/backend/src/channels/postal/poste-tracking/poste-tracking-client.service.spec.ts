import { describe, it, expect, vi, afterEach } from 'vitest';
import { PosteTrackingClient, POSTE_TRACKING_URL, POSTE_VERIFY_URL } from './poste-tracking-client.service.js';
import { PosteTrackingError } from './poste-tracking-mapping.util.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('PosteTrackingClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stesso flusso del sito: prima verifica, poi ricerca con i cookie ricevuti', async () => {
    const verify = new Response(JSON.stringify({ esito: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'SESS=abc; Path=/; HttpOnly' } });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(verify)
      .mockResolvedValueOnce(jsonResponse({ esitoRicerca: '3', stato: '6', flagRitorno: true, listaMovimenti: [] }));
    const r = await new PosteTrackingClient().track('RN000000000IT');
    expect(r.stato).toBe('6');
    const [vUrl, vInit] = spy.mock.calls[0]!;
    expect(vUrl).toBe(POSTE_VERIFY_URL);
    expect(JSON.parse(String(vInit?.body))).toEqual({ codiceSpedizione: 'RN000000000IT', tipoRichiedente: 'WEB' });
    const [url, init] = spy.mock.calls[1]!;
    expect(url).toBe(POSTE_TRACKING_URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ tipoRichiedente: 'WEB', codiceSpedizione: 'RN000000000IT', periodoRicerca: 1 });
    expect((init?.headers as Record<string, string>)['Cookie']).toBe('SESS=abc');
    expect((init?.headers as Record<string, string>)['Referer']).toBe('https://www.poste.it/cerca-spedizioni/index.html');
    expect(init?.signal).toBeDefined();
  });

  it('verifica non superata (4xx) → kind blocked, nessuna ricerca', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('no', { status: 400 }));
    await expect(new PosteTrackingClient().track('X')).rejects.toMatchObject({ kind: 'blocked' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('errore di rete/timeout → kind network', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The operation was aborted due to timeout'));
    await expect(new PosteTrackingClient().track('X')).rejects.toMatchObject({ kind: 'network' });
  });

  it('HTTP 5xx → kind http', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    await expect(new PosteTrackingClient().track('X')).rejects.toMatchObject({ kind: 'http' });
  });

  it('HTTP 4xx (Poste limita le richieste con 400/403/429) → kind blocked', async () => {
    for (const status of [400, 403, 429]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status }));
      await expect(new PosteTrackingClient().track('X')).rejects.toMatchObject({ kind: 'blocked' });
    }
  });

  it('body HTML (200) → kind invalid_body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>blocked</html>', { status: 200 }));
    const err = await new PosteTrackingClient().track('X').catch((e) => e);
    expect(err).toBeInstanceOf(PosteTrackingError);
    expect(err.kind).toBe('invalid_body');
  });
});
