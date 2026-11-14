import { describe, expect, it } from 'vitest';
import { escapeHtml, renderAppIoMarkdown } from '../src/lib/html';

describe('escapeHtml', () => {
  it('escapa & < > "', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
  it('non tocca testo semplice', () => {
    expect(escapeHtml('Avviso TARI 2026')).toBe('Avviso TARI 2026');
  });
});

describe('renderAppIoMarkdown', () => {
  it('grassetto, corsivo e link http(s)', () => {
    expect(renderAppIoMarkdown('**ciao** *mondo* [sito](https://example.org/a)')).toBe(
      '<p><strong>ciao</strong> <em>mondo</em> <a href="https://example.org/a" target="_blank" rel="noopener">sito</a></p>',
    );
  });
  it('ammette mailto', () => {
    expect(renderAppIoMarkdown('[scrivi](mailto:a@example.org)')).toContain('href="mailto:a@example.org"');
  });
  it('non rende cliccabili schemi javascript:', () => {
    expect(renderAppIoMarkdown('[x](javascript:alert(1))')).not.toContain('<a ');
  });
  it('escapa markup grezzo prima delle trasformazioni', () => {
    const out = renderAppIoMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });
  it('virgolette nell URL restano entita, nessun attributo extra iniettabile', () => {
    const out = renderAppIoMarkdown('[x](https://example.org/a"onmouseover="alert(1))');
    expect(out).toContain('href="https://example.org/a&quot;onmouseover=&quot;alert(1"');
    expect(out).not.toMatch(/<a [^>]*\sonmouseover=/);
  });
  it('& nell URL diventa &amp; (query string valida in HTML)', () => {
    expect(renderAppIoMarkdown('[x](https://example.org/p?a=1&b=2)')).toContain('href="https://example.org/p?a=1&amp;b=2"');
  });
  it('schema in maiuscolo non ammesso come link (solo http/https/mailto minuscoli)', () => {
    expect(renderAppIoMarkdown('[x](HTTPS://example.org)')).not.toContain('<a ');
    expect(renderAppIoMarkdown('[x](JavaScript:alert(1))')).not.toContain('<a ');
  });
  it('data: non diventa un link', () => {
    expect(renderAppIoMarkdown('[x](data:text/html,<script>alert(1)</script>)')).not.toContain('<a ');
  });
  it('lista "- item" e paragrafi separati da riga vuota', () => {
    expect(renderAppIoMarkdown('- uno\n- due\n\nfine')).toBe('<ul><li>uno</li><li>due</li></ul><p>fine</p>');
  });
  it('righe singole nel paragrafo diventano <br />', () => {
    expect(renderAppIoMarkdown('a\nb')).toBe('<p>a<br />b</p>');
  });
  it('lista mista resta paragrafo', () => {
    expect(renderAppIoMarkdown('- uno\ntesto')).toBe('<p>- uno<br />testo</p>');
  });
});
