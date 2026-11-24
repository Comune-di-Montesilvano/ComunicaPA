import type { SignatureJobStatus } from './types';
import { invalidFileLabel } from './invalidSignature';

/** Quali allegati non passano la verifica firma, con il motivo. */
export function InvalidFilesList({ status, className = '' }: { status: SignatureJobStatus; className?: string }) {
  const files = status.invalidFiles ?? [];
  if (files.length === 0) return null;
  const more = (status.invalidFilesTotal ?? files.length) - files.length;
  return (
    <ul className={`small mb-0 ${className}`}>
      {files.map((f, i) => (
        <li key={`${f.filename ?? ''}|${f.reason}|${i}`} className="text-break">{invalidFileLabel(f, status.totalRows)}</li>
      ))}
      {more > 0 && <li className="text-muted">… e altri {more}</li>}
    </ul>
  );
}
