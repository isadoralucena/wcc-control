import type { AppState, Room } from '../domain/types';

/** Laboratórios do catálogo (site do LCC) combinados com as escolhas do organizador. */
export function roomsOf(state: Pick<AppState, 'labCatalog' | 'labSelection'>): Room[] {
  return state.labCatalog.labs.map((lab) => ({
    ...lab,
    selected: state.labSelection[lab.id]?.selected ?? false,
    excluded: state.labSelection[lab.id]?.excluded ?? [],
  }));
}
