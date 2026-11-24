import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import type { AppEvent } from '../domain/types';
import { uid } from '../domain/ids';
import { Balloon } from './Balloon';
import { WccLogo } from './WccLogo';

export type ToastKind = 'ac' | 'success' | 'info' | 'error' | 'column-done' | 'pending';

export interface ToastInput {
  title: string;
  detail?: string;
  kind?: ToastKind;
  color?: string;
  action?: { label: string; run: () => void };
  ttl?: number;
}

interface Toast extends Required<Pick<ToastInput, 'title' | 'kind' | 'ttl'>> {
  id: string;
  detail?: string;
  color?: string;
  action?: ToastInput['action'];
}

interface ToastApi {
  notify: (t: ToastInput) => void;
  notifyEvent: (e: AppEvent) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const MAX = 6;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const notify = useCallback((t: ToastInput) => {
    const kind = t.kind ?? 'info';
    const toast: Toast = {
      id: uid('toast'),
      title: t.title,
      detail: t.detail,
      color: t.color,
      action: t.action,
      kind,
      ttl: t.ttl ?? (kind === 'ac' ? 9000 : kind === 'error' ? 8000 : 5000),
    };
    setToasts((list) => [...list, toast].slice(-MAX));
  }, []);

  const notifyEvent = useCallback(
    (e: AppEvent) =>
      notify({
        title: e.title,
        detail: e.detail,
        color: e.color,
        kind: e.kind === 'sync-error' ? 'error' : e.kind === 'column-done' ? 'column-done' : e.kind === 'pending' ? 'pending' : e.kind === 'ac' ? 'ac' : 'info',
      }),
    [notify],
  );

  return (
    <ToastContext.Provider value={{ notify, notifyEvent }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.ttl);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const t = window.setTimeout(onClose, remaining.current);
    return () => {
      window.clearTimeout(t);
      remaining.current -= Date.now() - started;
    };
  }, [paused, onClose]);

  const icon =
    toast.kind === 'ac' || toast.kind === 'column-done' ? (
      <Balloon color={toast.color ?? 'var(--green)'} size={30} />
    ) : toast.kind === 'error' ? (
      <AlertTriangle size={18} />
    ) : toast.kind === 'success' ? (
      <Check size={18} />
    ) : toast.kind === 'pending' ? (
      <WccLogo size={20} />
    ) : (
      <Info size={18} />
    );

  return (
    <div className={`toast toast--${toast.kind}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="toast__icon">{icon}</div>
      <div className="toast__body">
        <div className="toast__title">{toast.title}</div>
        {toast.detail && <div className="toast__detail">{toast.detail}</div>}
      </div>
      {toast.action && (
        <button
          className="toast__action"
          onClick={() => {
            toast.action!.run();
            onClose();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast__close" onClick={onClose} aria-label="Fechar notificação">
        <X size={14} />
      </button>
      <div className="toast__timer" style={{ animationDuration: `${toast.ttl}ms`, animationPlayState: paused ? 'paused' : 'running' }} />
    </div>
  );
}

export function useToasts(): ToastApi {
  const v = useContext(ToastContext);
  if (!v) throw new Error('useToasts fora do ToastProvider');
  return v;
}
