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
