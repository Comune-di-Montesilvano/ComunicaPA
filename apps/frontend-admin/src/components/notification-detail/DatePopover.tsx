import React from 'react';

/**
 * Data di una tappa con pannello esplicativo (popover non modale).
 * Lo stato aperto/chiuso vive nel genitore: un solo popover aperto alla volta.
 */
export function DatePopover({ id, label, text, open, onOpen, onToggle, onClose, children }: {
  id: string;
  label: string;
  text: string;
  open: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  React.useEffect(() => cancelClose, []);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
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
    <span
      className="nd-perf-pop-wrap"
      ref={wrapRef}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        cancelClose();
        onOpen();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        cancelClose();
        timer.current = setTimeout(onClose, 150);
      }}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      <button
        type="button"
        ref={btnRef}
        className="nd-perf-pop-btn"
        aria-expanded={open}
        aria-controls={id}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) onOpen();
        }}
        onClick={(e) => {
          // Mouse: l'apertura è già avvenuta al passaggio. Tastiera (detail 0) e touch: alterna.
          if (e.detail === 0 || (e.nativeEvent as PointerEvent).pointerType === 'touch') onToggle();
          else onOpen();
        }}
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
