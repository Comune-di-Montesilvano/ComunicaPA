export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  const withLinks = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  const withBold = withLinks.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const withItalic = withBold.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  const paragraphs = withItalic.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*-\s+/.test(l) && l.trim() !== '')) {
      const items = lines.map((l) => `<li>${l.replace(/^\s*-\s+/, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${lines.join('<br />')}</p>`;
  });

  return paragraphs.join('');
}
