export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyEmphasis(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/**
 * Converte il markdown minimale generato da processTemplate() (App IO: **bold**,
 * *italic*, [testo](url), liste "- item", paragrafi separati da riga vuota) in
 * HTML sicuro da passare a dangerouslySetInnerHTML. Escape del testo grezzo PRIMA
 * di applicare le trasformazioni, cosi eventuali "<script>" nei dati del CSV non
 * vengono mai interpretati come markup; solo URL http(s)/mailto sono ammesse nei
 * link, per non introdurre schemi javascript: cliccabili.
 */
export function renderAppIoMarkdown(markdown: string): string {
  const escaped = escapeHtml(markdown);
  // I link diventano segnaposto prima di grassetto/corsivo: gli asterischi
  // dell'URL non devono essere trasformati dentro href (solo il testo del link).
  const links: string[] = [];
  const withLinks = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_m, label: string, url: string) => {
      links.push(`<a href="${url}" target="_blank" rel="noopener">${applyEmphasis(label)}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    },
  );
  const withEmphasis = applyEmphasis(withLinks).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)]!);

  const paragraphs = withEmphasis.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*-\s+/.test(l) && l.trim() !== '')) {
      const items = lines.map((l) => `<li>${l.replace(/^\s*-\s+/, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${lines.join('<br />')}</p>`;
  });

  return paragraphs.join('');
}
