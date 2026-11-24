import { WccLogo } from './WccLogo';
import type { ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';

/** Seletor segmentado (opções mutuamente exclusivas). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; hint?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          className={`segmented__opt ${o.value === value ? 'is-on' : ''}`}
          onClick={() => onChange(o.value)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Campo numérico com botões − / +. */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const set = (v: number) => onChange(Math.max(min, Math.min(max, Math.round(v) || min)));
  return (
    <div className="stepper">
      <button type="button" onClick={() => set(value - 1)} disabled={value <= min} aria-label={`Diminuir ${label}`}>
        <Minus size={14} />
      </button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        aria-label={label}
        onChange={(e) => set(Number(e.target.value))}
      />
      <button type="button" onClick={() => set(value + 1)} disabled={value >= max} aria-label={`Aumentar ${label}`}>
        <Plus size={14} />
      </button>
    </div>
  );
}

/** Cabeçalho editorial de seção: número em mono + título + descrição. */
export function SectionHead({ index, title, children }: { index: string; title: string; children?: ReactNode }) {
  return (
    <header className="section-head">
      <span className="section-head__index">{index}</span>
      <div>
        <h2 className="section-head__title">{title}</h2>
        {children && <p className="section-head__desc">{children}</p>}
      </div>
    </header>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <WccLogo size={44} className="empty__mark is-muted" />
      <div className="empty__title">{title}</div>
      {children && <div className="empty__text">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`notice notice--${tone}`}>{children}</div>;
}

export function formatTime(ts: number | null | undefined, withSeconds = true): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined });
}

/** Duração desde `ts` em formato curto: "3 min", "1 h 05". */
export function since(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** Tempo de prova (hh:mm) a partir do início do contest, limitado à duração. */
export function contestClock(ts: number, begin: number | null, length?: number | null): string | null {
  if (!begin) return null;
  const elapsed = length ? Math.min(ts - begin, length) : ts - begin;
  const m = Math.floor(elapsed / 60000);
  if (m < 0) return null;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
