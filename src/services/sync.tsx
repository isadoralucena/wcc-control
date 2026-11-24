/**
 * Integrações automáticas via WCC Gateway.
 *
 * VJudge
 * - Atualização periódica (padrão 15 s, mínimo 10 s) enquanto a opção estiver ligada.
 * - Atualiza imediatamente ao voltar para a aba e ao reconectar à internet.
 * - Em falhas, continua tentando com espera progressiva (até 60 s) e mostra o erro;
 *   só notifica quando o estado muda de "ok" para "falha", para não inundar a tela.
 * - Aplica o ranking sobre o estado mais recente (`applyRank` só acrescenta
 *   Accepted e nunca toca nas entregas de balão).
 *
 * LCC
 * - Consulta lcc.ufcg.edu.br ao abrir o app e a cada 10 min (o gateway guarda 2 min de cache).
 * - Sem gateway, ou se a consulta falhar, mantém a última planta conhecida
 *   (consulta anterior ou snapshot gerado no build).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { useToasts } from '../components/Toasts';
import { applyRank, buildProblems, parseContestInfo, parseRank, rankWarning } from '../domain/vjudge';
import { overview } from '../domain/balloons';
import { buildUnits } from '../domain/teams';
import type { AppEvent, AppState, LccLab } from '../domain/types';
import { gateway, gatewayUrl } from './gateway';
import { uid } from '../domain/ids';

const LAB_REFRESH_MS = 10 * 60 * 1000;
const CONTEST_REFRESH_MS = 5 * 60 * 1000;

interface SyncApi {
  busy: boolean;
  labsBusy: boolean;
  syncNow: (opts?: { auto?: boolean }) => Promise<boolean>;
  applyPasted: (text: string) => number;
  refreshLabs: (opts?: { auto?: boolean }) => Promise<boolean>;
}

const SyncContext = createContext<SyncApi | null>(null);

function withRank(state: AppState, raw: unknown) {
  const rank = parseRank(raw);
  const now = Date.now();
  const r = applyRank(state, rank, now);
  const next: AppState = {
    ...r.state,
    vjudge: { ...r.state.vjudge, lastSyncAt: now, lastSyncOk: true, lastError: null, failures: 0, warning: null },
  };
  const events: AppEvent[] = [...r.events];
  if (r.newAccepted > 0) {
    const o = overview(next, buildUnits(next));
    if (o.pending > 1)
      events.push({
        id: uid('ev'),
        kind: 'pending',
        title: `Existem ${o.waitingUnits} ${next.mode === 'team' ? 'equipes' : 'participantes'} aguardando ${o.pending} balões`,
      });
  }
  return { state: next, events, newAccepted: r.newAccepted, rankId: rank.id };
}

/** Descreve mudanças de computadores entre duas leituras do LCC. */
function labChanges(prev: LccLab[], next: LccLab[]): string[] {
  const ids = (l: LccLab) => new Set(l.cells.flat().flatMap((c) => (c && typeof c === 'object' ? [c.id] : [])));
  const out: string[] = [];
  for (const lab of next) {
    const before = prev.find((p) => p.id === lab.id);
    if (!before) {
      if (prev.length) out.push(`${lab.id} apareceu no site do LCC`);
      continue;
    }
    const a = ids(before);
    const b = ids(lab);
    const added = [...b].filter((x) => !a.has(x)).length;
    const removed = [...a].filter((x) => !b.has(x)).length;
    if (added || removed) out.push(`${lab.id}: ${added ? `+${added}` : ''}${added && removed ? ' / ' : ''}${removed ? `−${removed}` : ''} computadores`);
  }
  prev.filter((p) => !next.some((n) => n.id === p.id)).forEach((p) => out.push(`${p.id} não aparece mais no site do LCC`));
  return out;
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const { commit, getState, state } = useStore();
  const { notify } = useToasts();
  const [busy, setBusy] = useState(false);
  const [labsBusy, setLabsBusy] = useState(false);
  const busyRef = useRef(false);
  const labsRef = useRef(false);
  const lastContestCheck = useRef(0);

  /* ---------------- VJudge ---------------- */

  const syncNow = useCallback(
    async (opts?: { auto?: boolean }) => {
      const s = getState();
      const base = gatewayUrl(s);
      if (!s.vjudge.contestId || !base) {
        if (!opts?.auto) notify({ kind: 'error', title: 'Configure o contest e o gateway na tela VJudge.' });
        return false;
      }
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const id = s.vjudge.contestId;
        // Metadados do contest (acesso, título, horários, questões): no início e a cada 5 min.
        if (s.vjudge.contestAccess === null || Date.now() - lastContestCheck.current > CONTEST_REFRESH_MS || !s.problems.length) {
          const info = parseContestInfo(await gateway.contest(base, id));
          lastContestCheck.current = Date.now();
          commit((cur) => ({
            ...cur,
            // Grade vazia + questões visíveis: importa automaticamente (preserva cores já escolhidas).
            problems: !cur.problems.length && info.problems?.length ? buildProblems(cur.problems, info.problems) : cur.problems,
            vjudge: {
              ...cur.vjudge,
              contestAccess: info.access ?? (info.openness === 0 ? 'public' : info.problems ? 'authorized' : 'restricted'),
              contestTitle: info.title || cur.vjudge.contestTitle,
              begin: info.begin ?? cur.vjudge.begin,
              length: info.begin && info.end ? info.end - info.begin : cur.vjudge.length,
            },
          }));
        }
        const raw = await gateway.rank(base, id);
        const rank = parseRank(raw);
        if (rank.id && String(rank.id) !== getState().vjudge.contestId)
          throw new Error(`O gateway devolveu o ranking do contest ${rank.id}, diferente do configurado.`);
        commit((cur) => {
          const r = withRank(cur, raw);
          return { state: { ...r.state, vjudge: { ...r.state.vjudge, warning: rankWarning(r.state, rank) } }, events: r.events };
        });
        if (!opts?.auto) notify({ kind: 'success', title: 'Ranking atualizado', ttl: 2500 });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Falha desconhecida';
        const wasOk = getState().vjudge.lastSyncOk !== false;
        commit((cur) => ({ ...cur, vjudge: { ...cur.vjudge, lastSyncOk: false, lastError: msg, failures: cur.vjudge.failures + 1 } }));
        if (!opts?.auto || wasOk) notify({ kind: 'error', title: 'Falha ao atualizar do VJudge', detail: `${msg} Tentando novamente automaticamente.` });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [commit, getState, notify],
  );

  const applyPasted = useCallback(
    (text: string) => {
      const s = getState();
      const r = withRank(s, text); // lança erro de parse antes de alterar o estado
      if (r.rankId && s.vjudge.contestId && String(r.rankId) !== s.vjudge.contestId)
        throw new Error(`Esse ranking é do contest ${r.rankId}, mas o contest configurado é ${s.vjudge.contestId}.`);
      commit((cur) => {
        const again = withRank(cur, text);
        return { state: again.state, events: again.events };
      });
      return r.newAccepted;
    },
    [commit, getState],
  );

  const v = state.vjudge;
  const base = gatewayUrl(state);
  const pollOn = v.autoPoll && v.source === 'gateway' && !!base && !!v.contestId;
  const interval = Math.max(10, v.pollSeconds || 15);
  const failures = v.failures;

  // Agenda a próxima leitura (setTimeout encadeado: nunca sobrepõe requisições).
  // A primeira leitura da sessão é imediata.
  const syncedThisSession = useRef(false);
  useEffect(() => {
    if (!pollOn) return;
    const delay = failures ? Math.min(60, interval * 2 ** Math.min(failures, 2)) : interval;
    const t = window.setTimeout(
      () => {
        syncedThisSession.current = true;
        void syncNow({ auto: true });
      },
      syncedThisSession.current ? delay * 1000 : 0,
    );
    return () => window.clearTimeout(t);
  }, [pollOn, interval, failures, v.lastSyncAt, syncNow]);

  // Ao voltar para a aba ou reconectar: atualiza na hora.
  useEffect(() => {
    if (!pollOn) return;
    const now = () => document.visibilityState === 'visible' && void syncNow({ auto: true });
    document.addEventListener('visibilitychange', now);
    window.addEventListener('online', now);
    return () => {
      document.removeEventListener('visibilitychange', now);
      window.removeEventListener('online', now);
    };
  }, [pollOn, syncNow]);

  /* ---------------- LCC ---------------- */

  const refreshLabs = useCallback(
    async (opts?: { auto?: boolean }) => {
      const b = gatewayUrl(getState());
      if (!b) {
        if (!opts?.auto) notify({ kind: 'error', title: 'Configure o WCC Gateway para consultar o site do LCC.' });
        return false;
      }
      if (labsRef.current) return false;
      labsRef.current = true;
      setLabsBusy(true);
      try {
        const { labs, fetchedAt } = await gateway.labs(b);
        const changes = getState().labCatalog.origin === 'gateway' ? labChanges(getState().labCatalog.labs, labs) : [];
        commit((cur) => ({ ...cur, labCatalog: { labs, fetchedAt, origin: 'gateway', lastAttemptAt: Date.now(), lastError: null } }));
        if (changes.length) notify({ kind: 'info', title: 'A planta dos laboratórios mudou no site do LCC', detail: changes.join(' · ') });
        else if (!opts?.auto) notify({ kind: 'success', title: 'Laboratórios atualizados do site do LCC', ttl: 2500 });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Falha desconhecida';
        commit((cur) => ({ ...cur, labCatalog: { ...cur.labCatalog, lastAttemptAt: Date.now(), lastError: msg } }));
        if (!opts?.auto) notify({ kind: 'error', title: 'Não foi possível consultar o site do LCC', detail: `${msg} Mantida a última planta conhecida.` });
        return false;
      } finally {
        labsRef.current = false;
        setLabsBusy(false);
      }
    },
    [commit, getState, notify],
  );

  // Consulta automática ao abrir o app, ao trocar de gateway e a cada 10 min.
  useEffect(() => {
    if (!base) return;
    const cat = getState().labCatalog;
    const stale = cat.origin !== 'gateway' || !cat.fetchedAt || Date.now() - cat.fetchedAt > LAB_REFRESH_MS;
    if (stale) void refreshLabs({ auto: true });
    const t = window.setInterval(() => void refreshLabs({ auto: true }), LAB_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [base, refreshLabs, getState]);

  return <SyncContext.Provider value={{ busy, labsBusy, syncNow, applyPasted, refreshLabs }}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncApi {
  const v = useContext(SyncContext);
  if (!v) throw new Error('useSync fora do SyncProvider');
  return v;
}
