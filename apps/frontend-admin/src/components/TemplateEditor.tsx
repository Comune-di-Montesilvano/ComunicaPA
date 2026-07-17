import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { useState, useEffect } from 'react';

interface TemplateEditorProps {
  value: string;
  onChange: (html: string) => void;
  systemPlaceholders: { label: string; token: string }[];
  csvPlaceholders: { label: string; token: string }[];
  wizLastFocusedField?: 'subject' | 'body';
  onInsertSubjectToken?: (token: string) => void;
  onFocusEditor?: () => void;
}

export function TemplateEditor({
  value,
  onChange,
  systemPlaceholders,
  csvPlaceholders,
  wizLastFocusedField = 'body',
  onInsertSubjectToken,
  onFocusEditor,
}: TemplateEditorProps) {
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');

  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false })],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    onFocus: () => onFocusEditor?.(),
  });

  // Sincronizza il valore esterno con il contenuto di Tiptap (es. quando si carica un template nel wizard)
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value);
    }
  }, [value, editor]);

  if (!editor) return null;

  const handlePlaceholderClick = (token: string) => {
    if (wizLastFocusedField === 'subject') {
      onInsertSubjectToken?.(token);
    } else {
      editor.chain().focus().insertContent(` ${token} `).run();
    }
  };

  return (
    <div>
      <div className="p-3 border rounded bg-light mb-3" style={{ borderLeft: '4px solid var(--bo-accent, #0066cc)' }}>
        <strong className="small text-dark d-block mb-3">
          <i className="fas fa-keyboard me-1 text-primary"></i>Clicca per inserire il parametro nel campo attivo ({wizLastFocusedField === 'subject' ? 'Oggetto' : 'Corpo'}):
        </strong>

        {/* Parametri di Sistema */}
        <div className="mb-2">
          <span className="small text-muted d-block mb-2 fw-bold text-uppercase" style={{ fontSize: '0.68rem', letterSpacing: '0.04em' }}>
            Parametri di Sistema
          </span>
          <div className="d-flex flex-wrap gap-1">
            {systemPlaceholders.map((p) => (
              <button
                key={p.token}
                type="button"
                className="btn btn-xs btn-outline-primary fw-semibold"
                style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                onClick={() => handlePlaceholderClick(p.token)}
              >
                {p.label}
              </button>
            ))}
            {systemPlaceholders.length === 0 && (
              <span className="text-muted small italic">Nessun parametro di sistema</span>
            )}
          </div>
        </div>

        {/* Colonne CSV (Expandable) */}
        {csvPlaceholders.length > 0 && (
          <details className="mt-3 border-top pt-2" style={{ outline: 'none' }}>
            <summary className="small text-dark fw-bold cursor-pointer select-none" style={{ fontSize: '0.74rem', outline: 'none' }}>
              <i className="fas fa-file-csv me-1 text-success"></i> Colonne del File CSV ({csvPlaceholders.length})
            </summary>
            <div className="d-flex flex-wrap gap-1 mt-2">
              {csvPlaceholders.map((p) => (
                <button
                  key={p.token}
                  type="button"
                  className="btn btn-xs btn-outline-secondary"
                  style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                  onClick={() => handlePlaceholderClick(p.token)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="btn-toolbar mb-2 gap-1" role="toolbar">
        <button type="button" className={`btn btn-sm btn-outline-secondary ${editor.isActive('bold') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBold().run()}>
          <i className="fas fa-bold"></i>
        </button>
        <button type="button" className={`btn btn-sm btn-outline-secondary ${editor.isActive('italic') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <i className="fas fa-italic"></i>
        </button>
        <button type="button" className={`btn btn-sm btn-outline-secondary ${editor.isActive('bulletList') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <i className="fas fa-list-ul"></i>
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => {
            const url = window.prompt('URL del link:');
            if (url) editor.chain().focus().setLink({ href: url }).run();
          }}
        >
          <i className="fas fa-link"></i>
        </button>
      </div>

      <div className="border rounded" style={{ minHeight: '220px', padding: '12px' }}>
        <EditorContent editor={editor} />
      </div>

      <div className="d-flex align-items-center gap-2 mt-3 mb-2">
        <span className="small fw-bold">Anteprima responsive:</span>
        <button type="button" className={`btn btn-sm ${viewport === 'desktop' ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setViewport('desktop')}>
          <i className="fas fa-desktop"></i> Desktop
        </button>
        <button type="button" className={`btn btn-sm ${viewport === 'mobile' ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setViewport('mobile')}>
          <i className="fas fa-mobile-alt"></i> Mobile
        </button>
      </div>
      <div
        className="border rounded mx-auto bg-white"
        style={{ maxWidth: viewport === 'mobile' ? '375px' : '100%', transition: 'max-width 0.2s' }}
        dangerouslySetInnerHTML={{ __html: editor.getHTML() }}
      />
    </div>
  );
}
