import type { AppState, LccLab, Room } from '../domain/types';
import { buildCustomLab } from '../domain/customLabs';

/** Todos os laboratórios: os do site do LCC/UFCG e os personalizados. */
export function labsOf(state: Pick<AppState, 'labCatalog' | 'customLabs'>): LccLab[] {
  return [...state.labCatalog.labs.map((l) => ({ ...l, origin: 'lcc' as const })), ...state.customLabs.map(buildCustomLab)];
}

/** Laboratórios combinados com as escolhas do organizador (seleção e computadores indisponíveis). */
export function roomsOf(state: Pick<AppState, 'labCatalog' | 'labSelection' | 'customLabs'>): Room[] {
  return labsOf(state).map((lab) => ({
    ...lab,
    selected: state.labSelection[lab.id]?.selected ?? false,
    excluded: state.labSelection[lab.id]?.excluded ?? [],
  }));
}
