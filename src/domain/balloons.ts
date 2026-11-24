/**
 * Regras da grade de questões e da entrega de balões.
 *
 * Estado visual de uma célula, derivado dos campos guardados separadamente:
 *   - 'idle'      (cinza)  nenhum Accepted registrado
 *   - 'solved'    (verde)  Accepted registrado, balão ainda não entregue
 *   - 'delivered' (preto)  balão entregue (o Accepted continua registrado)
 */
import type { AppEvent, AppState, Cell, LogEntry, Placement, Problem, Unit } from './types';
import { buildUnits } from './teams';
import { uid } from './ids';

export type CellStatus = 'idle' | 'solved' | 'delivered';

export function cellStatus(cell: Cell | undefined): CellStatus {
  if (!cell || cell.solvedAt === undefined) return 'idle';
  return cell.deliveredAt !== undefined ? 'delivered' : 'solved';
}

export function getCell(state: AppState, unitId: string, problem: number): Cell | undefined {
  return state.results[unitId]?.[problem];
}

function setCell(state: AppState, unitId: string, problem: number, cell: Cell): AppState {
  return {
    ...state,
    results: { ...state.results, [unitId]: { ...(state.results[unitId] ?? {}), [problem]: cell } },
  };
}

function addLog(state: AppState, kind: LogEntry['kind'], text: string, now: number): AppState {
  return { ...state, log: [{ id: uid('log'), at: now, kind, text }, ...state.log].slice(0, 300) };
}

const letterOf = (state: AppState, problem: number) => state.problems.find((p) => p.index === problem)?.letter ?? `#${problem + 1}`;
const unitName = (state: AppState, unitId: string) => buildUnits(state).find((u) => u.id === unitId)?.name ?? 'Unidade';

/** Marca o balão como entregue. Só é permitido se a questão estiver resolvida. */
export function deliverBalloon(state: AppState, unitId: string, problem: number, now: number): { state: AppState; events: AppEvent[] } {
  const cell = getCell(state, unitId, problem);
  if (cellStatus(cell) !== 'solved') return { state, events: [] };
  let next = setCell(state, unitId, problem, { ...cell!, deliveredAt: now });
  next = addLog(next, 'delivered', `Balão ${letterOf(state, problem)} entregue para ${unitName(state, unitId)}`, now);
  const events: AppEvent[] = [];
  const stats = problemStats(next, buildUnits(next)).find((s) => s.index === problem);
  if (stats && stats.solved > 0 && stats.pending === 0) {
    const p = next.problems.find((x) => x.index === problem);
    events.push({
      id: uid('ev'),
      kind: 'column-done',
      title: `Todos os balões da questão ${letterOf(state, problem)} foram entregues!`,
      detail: `${stats.delivered} ${stats.delivered === 1 ? 'balão entregue' : 'balões entregues'}`,
      color: p?.color,
    });
  }
  return { state: next, events };
}

/** Desfaz a entrega. O registro do Accepted permanece intacto. */
export function undoDelivery(state: AppState, unitId: string, problem: number, now: number): AppState {
  const cell = getCell(state, unitId, problem);
  if (!cell || cell.deliveredAt === undefined) return state;
  const { deliveredAt: _drop, ...rest } = cell;
  void _drop;
  return addLog(setCell(state, unitId, problem, rest), 'undo', `Entrega do balão ${letterOf(state, problem)} desfeita (${unitName(state, unitId)})`, now);
}

/** Registro manual de Accepted — útil quando a integração com o VJudge não está disponível. */
export function markManualSolved(state: AppState, unitId: string, problem: number, now: number): AppState {
  const cell = getCell(state, unitId, problem);
  if (cell?.solvedAt !== undefined) return state;
  let next = setCell(state, unitId, problem, { ...(cell ?? {}), solvedAt: now, detectedAt: now, solvedSource: 'manual' });
  next = { ...next, notified: [...new Set([...next.notified, `${unitId}:${problem}`])] };
  return addLog(next, 'manual', `${unitName(state, unitId)}: ${letterOf(state, problem)} marcada como resolvida manualmente`, now);
}

/** Remove um Accepted manual (nunca remove um Accepted vindo do VJudge nem um balão já entregue). */
export function removeManualSolved(state: AppState, unitId: string, problem: number, now: number): AppState {
  const cell = getCell(state, unitId, problem);
  if (!cell || cell.solvedSource !== 'manual' || cell.deliveredAt !== undefined) return state;
  const next = setCell(state, unitId, problem, {});
  return addLog(
    { ...next, notified: next.notified.filter((k) => k !== `${unitId}:${problem}`) },
    'undo',
    `${unitName(state, unitId)}: marcação manual de ${letterOf(state, problem)} removida`,
    now,
  );
}

export interface ProblemStats {
  index: number;
  solved: number;
  delivered: number;
  pending: number;
  /** Unidade que resolveu primeiro. */
  firstUnitId?: string;
}

export function problemStats(state: AppState, units: Unit[]): ProblemStats[] {
  return state.problems.map((p) => {
    let solved = 0;
    let delivered = 0;
    let first: { id: string; at: number } | undefined;
    for (const u of units) {
      const c = state.results[u.id]?.[p.index];
      const st = cellStatus(c);
      if (st === 'idle') continue;
      solved++;
      if (st === 'delivered') delivered++;
      if (c!.solvedSource === 'vjudge' && (!first || c!.solvedAt! < first.at)) first = { id: u.id, at: c!.solvedAt! };
    }
    return { index: p.index, solved, delivered, pending: solved - delivered, firstUnitId: first?.id };
  });
}

export interface QueueItem {
  unit: Unit;
  problem: Problem;
  cell: Cell;
  placement?: Placement;
}

/** Fila de balões pendentes, do Accepted mais antigo para o mais recente. */
export function balloonQueue(state: AppState, units: Unit[]): QueueItem[] {
  const out: QueueItem[] = [];
  for (const u of units) {
    for (const p of state.problems) {
      const c = state.results[u.id]?.[p.index];
      if (cellStatus(c) === 'solved') out.push({ unit: u, problem: p, cell: c!, placement: state.allocation?.placements[u.id] });
    }
  }
  return out.sort((a, b) => (a.cell.solvedAt ?? 0) - (b.cell.solvedAt ?? 0));
}

export interface Overview {
  participants: number;
  teams: number;
  problems: number;
  accepted: number;
  delivered: number;
  pending: number;
  waitingUnits: number;
}

export function overview(state: AppState, units: Unit[]): Overview {
  const stats = problemStats(state, units);
  const queue = balloonQueue(state, units);
  return {
    participants: state.participants.length,
    teams: state.mode === 'team' ? units.length : 0,
    problems: state.problems.length,
    accepted: stats.reduce((a, s) => a + s.solved, 0),
    delivered: stats.reduce((a, s) => a + s.delivered, 0),
    pending: queue.length,
    waitingUnits: new Set(queue.map((q) => q.unit.id)).size,
  };
}
