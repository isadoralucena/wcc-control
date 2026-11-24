/**
 * Estado global da aplicação.
 *
 * Todas as mudanças passam por `commit(fn)`, que recebe o estado atual e
 * devolve o próximo (ou { state, events }). O estado mais recente fica em uma
 * ref atualizada de forma síncrona, de modo que operações assíncronas (como a
 * sincronização com o VJudge) sempre partem do estado mais novo e não
 * sobrescrevem ações manuais do organizador feitas durante a requisição.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppEvent, AppState, Unit } from '../domain/types';
import { buildUnits } from '../domain/teams';
import { defaultState } from './defaults';
import { localStorageAdapter } from './persistence';
import { useToasts } from '../components/Toasts';

type CommitResult = AppState | { state: AppState; events: AppEvent[] };

interface StoreValue {
  state: AppState;
  units: Unit[];
  commit: (fn: (s: AppState) => CommitResult) => void;
  replace: (s: AppState) => void;
  getState: () => AppState;
  saveStatus: { at: number | null; error: string | null };
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { notifyEvent } = useToasts();
  const [state, setState] = useState<AppState>(() => localStorageAdapter.load() ?? defaultState());
  const ref = useRef(state);
  const [saveStatus, setSaveStatus] = useState<{ at: number | null; error: string | null }>({ at: null, error: null });

  const commit = useCallback(
    (fn: (s: AppState) => CommitResult) => {
      const r = fn(ref.current);
      const { state: next, events } = 'events' in r ? r : { state: r, events: [] as AppEvent[] };
      if (next === ref.current) return;
      const stamped = { ...next, updatedAt: Date.now() };
      ref.current = stamped;
      setState(stamped);
      events.forEach(notifyEvent);
    },
    [notifyEvent],
  );

  const replace = useCallback((s: AppState) => {
    ref.current = s;
    setState(s);
  }, []);

  const getState = useCallback(() => ref.current, []);

  // Salvamento automático (com pequeno atraso para agrupar digitação).
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorageAdapter.save(state);
        setSaveStatus({ at: Date.now(), error: null });
      } catch (err) {
        setSaveStatus({ at: null, error: err instanceof Error ? err.message : 'Falha ao salvar' });
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [state]);

  const units = useMemo(() => buildUnits(state), [state.mode, state.participants, state.teams, state.teamSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(
    () => ({ state, units, commit, replace, getState, saveStatus }),
    [state, units, commit, replace, getState, saveStatus],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore fora do StoreProvider');
  return v;
}
