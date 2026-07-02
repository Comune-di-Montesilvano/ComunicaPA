import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { useState } from 'react';

interface TemplateEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholders: { label: string; token: string }[];
}

export function TemplateEditor({ value, onChange, placeholders }: TemplateEditorProps) {
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');

  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false })],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  if (!editor) return null;

  const insertPlaceholder = (token: string) => {
    editor.chain().focus().insertContent(` ${token} `).run();
  };

  return (
    <div>
      <div className="p-3 border rounded bg-light mb-3">
        <strong className="small text-dark d-block mb-2">
          <i className="fas fa-keyboard me-1 text-primary"></i>Clicca per inserire il parametro:
        </strong>
        <div className="d-flex flex-wrap gap-1">
          {placeholders.map((p) => (
            <button
              key={p.token}
              type="button"
              className="btn btn-xs btn-outline-secondary"
              style={{ fontSize: '0.74rem' }}
              onClick={() => insertPlaceholder(p.token)}
            >
              {p.label}
            </button>
          ))}
        </div>
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
