// Upload a chunk: un reverse proxy esterno davanti al backend in produzione
// ha un limite di dimensione del body (osservato: 1MB) che spezzava in
// un'unica richiesta l'upload di CSV/ZIP di migliaia di destinatari/
// allegati. Chunk da 800KB per restare sotto quel limite con margine.
export const UPLOAD_CHUNK_SIZE = 800 * 1024;

/** Upload di un singolo chunk via XHR (fetch non espone eventi di progresso in upload). */
function uploadChunkXhr(url: string, token: string, chunk: Blob, onProgress: (loadedBytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(chunk.size);
        resolve();
      } else {
        reject(new Error(`Upload chunk fallito (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Errore di rete durante upload chunk'));
    const fd = new FormData();
    fd.append('chunk', chunk, 'chunk.part');
    xhr.send(fd);
  });
}

/**
 * Carica `file` a chunk verso `<baseUrl>/init`, `/chunk/:uploadId/:index`,
 * `/complete/:uploadId`. `onProgress` riceve i byte effettivamente caricati
 * per QUESTO file (il chiamante somma l'offset se sta caricando più file
 * con una barra di progresso aggregata).
 */
export async function uploadFileInChunks(
  baseUrl: string,
  token: string,
  file: Blob,
  filename: string,
  onProgress: (loadedBytes: number) => void,
  onCompleteStart?: () => void,
  completeBody?: Record<string, unknown>,
): Promise<any> {
  const totalChunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE));

  const initRes = await fetch(`${baseUrl}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename, totalChunks }),
  });
  if (!initRes.ok) {
    const errBody = await initRes.json().catch(() => null);
    throw new Error(errBody?.message || `Errore inizializzazione upload (HTTP ${initRes.status}).`);
  }
  const { uploadId } = await initRes.json() as { uploadId: string };

  let uploadedBefore = 0;
  for (let i = 0; i < totalChunks; i++) {
    const start = i * UPLOAD_CHUNK_SIZE;
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const base = uploadedBefore;
    await uploadChunkXhr(`${baseUrl}/chunk/${uploadId}/${i}`, token, chunk, (loadedInChunk) => onProgress(base + loadedInChunk));
    uploadedBefore += chunk.size;
  }

  if (onCompleteStart) {
    onCompleteStart();
  }

  const completeRes = await fetch(`${baseUrl}/complete/${uploadId}`, {
    method: 'POST',
    headers: completeBody
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      : { Authorization: `Bearer ${token}` },
    body: completeBody ? JSON.stringify(completeBody) : undefined,
  });
  if (!completeRes.ok) {
    const errBody = await completeRes.json().catch(() => null);
    throw new Error(errBody?.message || `Errore completamento upload (HTTP ${completeRes.status}).`);
  }
  return completeRes.json();
}
