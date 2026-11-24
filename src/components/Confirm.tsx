import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type Ask = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Ask | null>(null);

/** Diálogo de confirmação acessível, usado para ações destrutivas. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  const ask = useCallback<Ask>((o) => new Promise((resolve) => setOpen({ ...o, resolve })), []);
  const close = (v: boolean) => {
    open?.resolve(v);
    setOpen(null);
  };

  useEffect(() => {
    if (!open) return;
    confirmBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {open && (
        <div className="modal-backdrop" onMouseDown={() => close(false)}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}>
            <h3 id="confirm-title" className="modal__title">{open.title}</h3>
            {open.body && <div className="modal__body">{open.body}</div>}
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={() => close(false)}>
                {open.cancelLabel ?? 'Cancelar'}
              </button>
              <button ref={confirmBtn} className={`btn ${open.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => close(true)}>
                {open.confirmLabel ?? 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Ask {
  const v = useContext(ConfirmContext);
  if (!v) throw new Error('useConfirm fora do ConfirmProvider');
  return v;
}
