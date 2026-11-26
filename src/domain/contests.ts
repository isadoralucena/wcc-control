/**
 * Vários contests acompanhados ao mesmo tempo.
 *
 * Cada contest tem as próprias questões, acesso e estado de sincronização.
 * As questões têm uma chave global ("<contest>:<índice>") usada em `results`,
 * de modo que balões, fila e mapa tratam todas as questões de forma uniforme.
 */
import type { AppState, Contest, Problem, Unit } from './types';
import { cellStatus } from './balloons';
import { uid } from './ids';

export const problemKey = (contest: string, index: number) => `${contest}:${index}`;

export function newContest(existing: Pick<Contest, 'tag'>[]): Contest {
  const used = new Set(existing.map((c) => c.tag.toUpperCase()));
  let n = existing.length + 1;
  while (used.has(`C${n}`)) n++;
  return {
    key: uid('c'),
    tag: `C${n}`,
    contestInput: '',
    contestId: '',
    contestAccess: null,
    warning: null,
    contestTitle: '',
    begin: null,
    length: null,
    lastSyncAt: null,
    lastSyncOk: null,
    lastError: null,
    failures: 0,
    seenAccounts: [],
    problems: [],
  };
}

/** Metadados zerados quando o link do contest muda. */
export const RESET_CONTEST_META: Partial<Contest> = {
  contestTitle: '',
  begin: null,
  length: null,
  lastSyncAt: null,
  lastSyncOk: null,
  lastError: null,
  warning: null,
  failures: 0,
  contestAccess: null,
  seenAccounts: [],
};

export function allProblems(state: Pick<AppState, 'contests'>): Problem[] {
  return state.contests.flatMap((c) => c.problems);
}

export function findProblem(state: Pick<AppState, 'contests'>, key: string): Problem | undefined {
  for (const c of state.contests) {
    const p = c.problems.find((x) => x.key === key);
    if (p) return p;
  }
  return undefined;
}

export function findContest(state: Pick<AppState, 'contests'>, key: string): Contest | undefined {
  return state.contests.find((c) => c.key === key);
}

/** Rótulo curto da questão: "A" com um contest; "INI·A" com vários. */
export function problemLabel(state: Pick<AppState, 'contests'>, p: Pick<Problem, 'contest' | 'letter'>): string {
  if (state.contests.length < 2) return p.letter;
  const tag = findContest(state, p.contest)?.tag;
  return tag ? `${tag}·${p.letter}` : p.letter;
}

export function contestName(c: Contest): string {
  return c.contestTitle || (c.contestId ? `Contest #${c.contestId}` : 'Contest sem link');
}

export function updateContest(state: AppState, key: string, fn: (c: Contest) => Contest): AppState {
  let changed = false;
  const contests = state.contests.map((c) => {
    if (c.key !== key) return c;
    const next = fn(c);
    changed = next !== c;
    return next;
  });
  return changed ? { ...state, contests } : state;
}

/**
 * Unidades que participam do contest. O VJudge só lista uma conta no ranking
 * depois da primeira submissão; por isso entram as unidades com conta vista no
 * ranking ou com algum resultado registrado. Antes da primeira leitura, todas.
 */
export function unitsInContest(state: Pick<AppState, 'results'>, contest: Contest, units: Unit[]): Unit[] {
  if (contest.lastSyncAt === null || contest.seenAccounts.length === 0) {
    const anyResult = units.some((u) => contest.problems.some((p) => state.results[u.id]?.[p.key]?.solvedAt !== undefined));
    if (!anyResult) return units;
  }
  const seen = new Set(contest.seenAccounts);
  return units.filter(
    (u) => u.accounts.some((a) => seen.has(a)) || contest.problems.some((p) => state.results[u.id]?.[p.key]?.solvedAt !== undefined),
  );
}

export interface Standing {
  solved: number;
  /** Soma dos minutos (desde o início do contest) dos Accepted. Não inclui penalidade por tentativas erradas. */
  minutes: number;
  /** Posição (empates dividem a posição). */
  position: number;
}

/**
 * Classificação: mais questões resolvidas e, no empate, menor soma de tempos
 * dos Accepted. O WCC Control guarda só o primeiro Accepted de cada questão,
 * então a penalidade por submissões rejeitadas do VJudge não entra na conta.
 */
export function standings(state: Pick<AppState, 'results' | 'contests'>, units: Unit[], problems: Problem[]): Map<string, Standing> {
  const begin = new Map(state.contests.map((c) => [c.key, c.begin]));
  const rows = units.map((u) => {
    let solved = 0;
    let minutes = 0;
    for (const p of problems) {
      const cell = state.results[u.id]?.[p.key];
      if (cellStatus(cell) === 'idle') continue;
      solved++;
      const b = begin.get(p.contest);
      if (b && cell!.solvedAt! >= b) minutes += Math.floor((cell!.solvedAt! - b) / 60000);
    }
    return { id: u.id, solved, minutes };
  });
  rows.sort((a, b) => b.solved - a.solved || a.minutes - b.minutes);
  const out = new Map<string, Standing>();
  rows.forEach((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const position = prev && prev.solved === r.solved && prev.minutes === r.minutes ? out.get(prev.id)!.position : i + 1;
    out.set(r.id, { solved: r.solved, minutes: r.minutes, position });
  });
  return out;
}

/** O contest tem Accepted ou entregas registrados? */
export function contestHasData(state: Pick<AppState, 'results'>, contest: Contest): boolean {
  return Object.values(state.results).some((row) => contest.problems.some((p) => row?.[p.key]?.solvedAt !== undefined));
}

/** Apaga os resultados (Accepted, entregas e notificações) das questões de um contest. */
export function clearContestResults(state: AppState, contest: Contest): AppState {
  const prefix = `${contest.key}:`;
  const results = Object.fromEntries(
    Object.entries(state.results).map(([u, row]) => [u, Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => !k.startsWith(prefix)))]),
  );
  return { ...state, results, notified: state.notified.filter((n) => !n.includes(`:${prefix}`)) };
}

/**
 * Troca o link de um contest. Se ele passar a apontar para OUTRO contest do
 * VJudge, os metadados, as questões e os resultados do anterior são descartados
 * (a interface pede confirmação antes quando há resultados).
 */
export function setContestLink(state: AppState, key: string, input: string, id: string): AppState {
  const c = findContest(state, key);
  if (!c) return state;
  const switched = !!id && id !== c.contestId;
  const base = switched && c.contestId ? clearContestResults(state, c) : state;
  return updateContest(base, key, (x) => ({
    ...x,
    contestInput: input,
    contestId: id,
    ...(switched ? RESET_CONTEST_META : {}),
    ...(switched && c.contestId ? { problems: [] } : {}),
  }));
}

export function removeContest(state: AppState, key: string): AppState {
  const c = findContest(state, key);
  if (!c) return state;
  const rest = clearContestResults(state, c);
  const contests = state.contests.filter((x) => x.key !== key);
  return { ...rest, contests: contests.length ? contests : [newContest([])] };
}
