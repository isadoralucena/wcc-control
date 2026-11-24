import type { AppState } from '../domain/types';
import { buildUnits } from '../domain/teams';
import { computeAllocation } from '../domain/allocation';
import { roomsOf } from './selectors';

/** Recalcula a alocação automática a partir da configuração atual. */
export function allocate(s: AppState): AppState {
  const words: [string, string] = s.mode === 'team' ? ['equipe', 'equipes'] : ['participante', 'participantes'];
  const r = computeAllocation(roomsOf(s), buildUnits(s), s.allocationSettings, Math.random, words);
  return { ...s, allocation: { placements: r.placements, report: r.report, computedAt: Date.now(), edited: false } };
}
