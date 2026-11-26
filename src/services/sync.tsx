/**
 * Integrações automáticas via WCC Gateway.
 *
 * VJudge (um ou mais contests)
 * - Cada contest é lido em sequência, com estado de sincronização próprio.
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
import { applyRank, buildProblems, parseContestInfo, parseRank, rankWarning, type RankData } from '../domain/vjudge';
import { findContest, updateContest } from '../domain/contests';
import { overview } from '../domain/balloons';
import { buildUnits } from '../domain/teams';
import type { AppEvent, AppState, Contest, LccLab } from '../domain/types';
import { gateway, gatewayUrl } from './gateway';
import { uid } from '../domain/ids';

const LAB_REFRESH_MS = 10 * 60 * 1000;
const CONTEST_REFRESH_MS = 5 * 60 * 1000;

interface SyncApi {
  busy: boolean;
  labsBusy: boolean;
  /** Atualiza todos os contests (ou só `contestKey`). */
  syncNow: (opts?: { auto?: boolean; contestKey?: string }) => Promise<boolean>;
  /** Processa um ranking colado; o contest é identificado pelo ID do JSON. Devolve os Accepted novos. */
  applyPasted: (text: string, contestKey?: string) => number;
  refreshLabs: (opts?: { auto?: boolean }) => Promise<boolean>;
}

const SyncContext = createContext<SyncApi | null>(null);

function withRank(state: AppState, contestKey: string, rank: RankData) {
  const now = Date.now();
  const r = applyRank(state, contestKey, rank, now);
  const next = updateContest(r.state, contestKey, (c) => ({
    ...c,
    lastSyncAt: now,
    lastSyncOk: true,
    lastError: null,
    failures: 0,
    warning: rankWarning(r.state, c, rank),
  }));
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
  return { state: next, events, newAccepted: r.newAccepted };
}

/** Contest que corresponde a um ranking colado (pelo ID do JSON). */
export function contestForRank(state: AppState, rank: RankData, preferred?: string): Contest {
  const byId = rank.id ? state.contests.find((c) => c.contestId === String(rank.id)) : undefined;
  if (byId) return byId;
  const pref = preferred ? findContest(state, preferred) : undefined;
  if (pref && (!pref.contestId || !rank.id)) return pref;
  if (state.contests.length === 1 && (!state.contests[0].contestId || !rank.id)) return state.contests[0];
  throw new Error(
    rank.id
      ? `Esse ranking é do contest ${rank.id}, que não está entre os contests acompanhados. Adicione-o na tela VJudge.`
      : 'Não foi possível identificar o contest desse ranking.',
  );
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
  const lastContestCheck = useRef(new Map<string, number>());

  /* ---------------- VJudge ---------------- */

  /** Lê metadados (quando preciso) e o ranking de um contest. Lança erro em falha. */
  const syncContest = useCallback(
    async (base: string, key: string) => {
      const c = findContest(getState(), key);
      if (!c?.contestId) return;
      const id = c.contestId;
      const last = lastContestCheck.current.get(key) ?? 0;
      // Metadados do contest (acesso, título, horários, questões): no início e a cada 5 min.
      if (c.contestAccess === null || Date.now() - last > CONTEST_REFRESH_MS || !c.problems.length) {
        const info = parseContestInfo(await gateway.contest(base, id));
        lastContestCheck.current.set(key, Date.now());
        commit((cur) =>
          updateContest(cur, key, (x) => {
            if (x.contestId !== id) return x;
            const offset = cur.contests.filter((o) => o.key !== key).reduce((a, o) => a + o.problems.length, 0);
            return {
              ...x,
              // Grade vazia + questões visíveis: importa automaticamente (preserva cores já escolhidas).
              problems: !x.problems.length && info.problems?.length ? buildProblems(key, x.problems, info.problems, offset) : x.problems,
              contestAccess: info.access ?? (info.openness === 0 ? 'public' : info.problems ? 'authorized' : 'restricted'),
              contestTitle: info.title || x.contestTitle,
              begin: info.begin ?? x.begin,
              length: info.begin && info.end ? info.end - info.begin : x.length,
            };
          }),
        );
      }
      const rank = parseRank(await gateway.rank(base, id));
      if (rank.id && String(rank.id) !== id) throw new Error(`O gateway devolveu o ranking do contest ${rank.id}, diferente do configurado (${id}).`);
      commit((cur) => {
        if (findContest(cur, key)?.contestId !== id) return cur; // link trocado durante a leitura
        const r = withRank(cur, key, rank);
        return { state: r.state, events: r.events };
      });
    },
    [commit, getState],
  );

  const syncNow = useCallback(
    async (opts?: { auto?: boolean; contestKey?: string }) => {
      const s = getState();
      const base = gatewayUrl(s);
      const targets = s.contests.filter((c) => c.contestId && (!opts?.contestKey || c.key === opts.contestKey));
      if (!targets.length || !base) {
        if (!opts?.auto) notify({ kind: 'error', title: 'Configure o contest e o gateway na tela VJudge.' });
        return false;
      }
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      let allOk = true;
      try {
        // Um contest por vez: requisições curtas e sem sobreposição.
        for (const c of targets) {
          try {
            await syncContest(base, c.key);
          } catch (err) {
            allOk = false;
            const msg = err instanceof Error ? err.message : 'Falha desconhecida';
            const cur = findContest(getState(), c.key);
            const wasOk = cur?.lastSyncOk !== false;
            commit((st) => updateContest(st, c.key, (x) => ({ ...x, lastSyncOk: false, lastError: msg, failures: x.failures + 1 })));
            const label = getState().contests.length > 1 ? ` (${cur?.tag ?? c.tag})` : '';
            if (!opts?.auto || wasOk) notify({ kind: 'error', title: `Falha ao atualizar do VJudge${label}`, detail: `${msg} Tentando novamente automaticamente.` });
          }
        }
        if (!opts?.auto && allOk) notify({ kind: 'success', title: targets.length > 1 ? `${targets.length} rankings atualizados` : 'Ranking atualizado', ttl: 2500 });
        return allOk;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [commit, getState, notify, syncContest],
  );

  const applyPasted = useCallback(
    (text: string, contestKey?: string) => {
      const rank = parseRank(text); // lança erro de parse antes de alterar o estado
      const target = contestForRank(getState(), rank, contestKey);
      let added = 0;
      commit((cur) => {
        const r = withRank(cur, target.key, rank);
        added = r.newAccepted;
        return { state: r.state, events: r.events };
      });
      return added;
    },
    [commit, getState],
  );

  const v = state.vjudge;
  const base = gatewayUrl(state);
  const pollOn = v.autoPoll && v.source === 'gateway' && !!base && state.contests.some((c) => c.contestId);
  const interval = Math.max(10, v.pollSeconds || 15);
  const failures = Math.max(0, ...state.contests.map((c) => c.failures));
  const syncTick = state.contests.map((c) => c.lastSyncAt ?? 0).join(',');

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
  }, [pollOn, interval, failures, syncTick, syncNow]);

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
