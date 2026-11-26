/**
 * Laboratórios personalizados (outras instituições ou locais).
 *
 * O organizador informa quantidade de computadores, quantidade de bancadas,
 * direção dos corredores e posição da porta; daqui sai uma planta no mesmo
 * formato da planta do LCC (grade de células). Assim o mapa, a alocação, as
 * exclusões de máquinas e os balões funcionam sem nenhum caso especial.
 *
 * Numeração: bancada por bancada, a partir da frente (onde fica o topo da planta)
 * e da esquerda — SALA1-01, SALA1-02, ...
 */
import type { CustomLabSpec, DoorPosition, LccCell, LccLab } from './types';

export const MAX_CUSTOM_MACHINES = 400;

export const DOOR_LABELS: Record<DoorPosition, string> = {
  'front-left': 'frente, à esquerda',
  'front-right': 'frente, à direita',
  'back-left': 'fundo, à esquerda',
  'back-right': 'fundo, à direita',
  none: 'não indicar',
};

/** Sigla normalizada: maiúsculas, letras e números, até 10 caracteres. */
export function normalizeLabId(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}

export function defaultCustomLab(taken: string[]): CustomLabSpec {
  const used = new Set(taken.map((t) => t.toUpperCase()));
  let n = 1;
  while (used.has(`SALA${n}`)) n++;
  return { id: `SALA${n}`, name: `Sala ${n}`, machines: 30, benches: 5, orientation: 'h', paired: false, door: 'front-left' };
}

/** Problemas na especificação (lista vazia = válida). `taken` = siglas já usadas por outros laboratórios. */
export function validateCustomLab(spec: CustomLabSpec, taken: string[]): string[] {
  const errors: string[] = [];
  if (!spec.id) errors.push('Informe a sigla do laboratório.');
  else if (taken.some((t) => t.toUpperCase() === spec.id.toUpperCase())) errors.push(`Já existe um laboratório com a sigla ${spec.id}.`);
  if (!spec.name.trim()) errors.push('Informe o nome do laboratório.');
  if (!Number.isInteger(spec.machines) || spec.machines < 1 || spec.machines > MAX_CUSTOM_MACHINES)
    errors.push(`A quantidade de computadores deve estar entre 1 e ${MAX_CUSTOM_MACHINES}.`);
  if (!Number.isInteger(spec.benches) || spec.benches < 1 || spec.benches > spec.machines)
    errors.push('A quantidade de bancadas deve estar entre 1 e a quantidade de computadores.');
  return errors;
}

/** Computadores por bancada (a última pode ficar menor). */
export function perBench(spec: Pick<CustomLabSpec, 'machines' | 'benches'>): number {
  return Math.ceil(spec.machines / Math.max(1, spec.benches));
}

/** Gera a planta a partir da especificação. */
export function buildCustomLab(spec: CustomLabSpec): LccLab {
  const benches = Math.max(1, Math.min(spec.benches, spec.machines));
  const per = perBench({ machines: spec.machines, benches });
  const digits = Math.max(2, String(spec.machines).length);
  const idOf = (n: number) => `${spec.id}-${String(n).padStart(digits, '0')}`;

  // Bancadas com as máquinas em ordem.
  const lines: LccCell[][] = [];
  let n = 0;
  for (let b = 0; b < benches; b++) {
    const line: LccCell[] = [];
    for (let k = 0; k < per; k++) line.push(n < spec.machines ? { id: idOf(++n), status: 'unknown' } : null);
    lines.push(line);
  }

  // Bancadas + corredores (um corredor entre bancadas, ou entre pares de bancadas).
  const withAisles: LccCell[][] = [];
  lines.forEach((line, i) => {
    withAisles.push(line);
    const last = i === lines.length - 1;
    if (!last && (!spec.paired || i % 2 === 1)) withAisles.push(Array<LccCell>(per).fill(null));
  });

  // 'h': cada bancada é uma linha da planta; 'v': cada bancada é uma coluna.
  let cells: LccCell[][] =
    spec.orientation === 'h' ? withAisles : Array.from({ length: per }, (_, r) => withAisles.map((line) => line[r]));

  if (spec.door !== 'none') {
    const cols = cells[0]?.length ?? 1;
    const doorRow = Array<LccCell>(cols).fill(null);
    doorRow[spec.door.endsWith('left') ? 0 : cols - 1] = 'door';
    cells = spec.door.startsWith('front') ? [doorRow, ...cells] : [...cells, doorRow];
  }

  return {
    id: spec.id,
    name: spec.name.trim() || spec.id,
    origin: 'custom',
    benchAxis: spec.orientation,
    rows: cells.length,
    cols: cells[0]?.length ?? 0,
    machines: spec.machines,
    cells,
  };
}
