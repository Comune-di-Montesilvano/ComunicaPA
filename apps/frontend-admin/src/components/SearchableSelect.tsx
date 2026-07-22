import { useEffect, useMemo, useRef, useState } from 'react';

export interface SearchableSelectOption {
  value: string;
  label: string;
  isDefault?: boolean;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = '-- Seleziona --',
  disabled = false,
  className = 'form-select',
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    return [...options].sort((a, b) => {
      if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1;
      return a.label.localeCompare(b.label, 'it');
    });
  }, [options]);

  const filtered = useMemo(() => {
    if (!query) return sorted;
    const q = query.toLowerCase();
    return sorted.filter(o => o.label.toLowerCase().includes(q));
  }, [sorted, query]);

  const selected = options.find(o => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, open]);

  const commit = (opt: SearchableSelectOption) => {
    onChange(opt.value);
    setOpen(false);
    setQuery('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlightIndex]) commit(filtered[highlightIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div style={{ position: 'relative' }} ref={containerRef}>
      <input
        type="text"
        className={className}
        disabled={disabled}
        placeholder={placeholder}
        style={value && !open ? { paddingRight: 28 } : undefined}
        value={open ? query : (selected?.label ?? '')}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {value && !open && (
        <button
          type="button"
          className="btn btn-sm btn-link text-secondary p-1"
          style={{ textDecoration: 'none', position: 'absolute', top: 0, right: 0 }}
          tabIndex={-1}
          onClick={() => onChange('')}
          title="Pulisci selezione"
        >
          ×
        </button>
      )}
      {open && (
        <div
          className="bg-white border rounded shadow-sm mt-1"
          style={{ position: 'absolute', left: 0, right: 0, zIndex: 1050, maxHeight: 260, overflowY: 'auto' }}
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-muted small">Nessun risultato</div>
          ) : (
            filtered.map((opt, idx) => (
              <div
                key={opt.value}
                className={`px-3 py-2 small ${idx === highlightIndex ? 'bg-primary text-white' : ''}`}
                style={{ cursor: 'pointer' }}
                onMouseDown={(e) => { e.preventDefault(); commit(opt); }}
                onMouseEnter={() => setHighlightIndex(idx)}
              >
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
