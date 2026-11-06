import React from 'react';

/**
 * Data di una tappa con pannello esplicativo (popover non modale).
 * Lo stato aperto/chiuso vive nel genitore: un solo popover aperto alla volta.
 */
export function DatePopover({ id, label, text, open, onToggle, onClose, children }: {
  id: string;
  label: string;
  text: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <span className="nd-perf-pop-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="nd-perf-pop-btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        {text}
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={label} className="nd-perf-pop">
          {children}
        </div>
      )}
    </span>
  );
}
