/**
 * Algoritmo de alocação sobre a planta real dos laboratórios do LCC.
 *
 * Regras físicas (fixas):
 * - Cada computador tem exatamente uma cadeira: a capacidade de um laboratório
 *   é a quantidade de computadores identificados no site do LCC.
 * - Individual: 1 pessoa ocupa 1 cadeira e usa 1 computador.
 * - Equipe de N pessoas: ocupa N cadeiras vizinhas na mesma bancada e usa
 *   apenas 1 computador (o central do trecho). As outras N−1 máquinas do
 *   trecho ficam sem uso, mas suas cadeiras estão ocupadas.
 *
 * Bancadas: sequências contínuas de computadores na planta. A direção
 * (linhas ou colunas) é detectada automaticamente pela que forma sequências
 * mais longas — no LCC1/LCC2 as bancadas são verticais, no LCC3 horizontais.
 * Computadores excluídos pelo organizador interrompem a bancada.
 *
 * Prioridade:
 * 1. Espaçamento máximo configurado (até 2 cadeiras vazias entre unidades na mesma bancada).
 * 2. Reduz para 1 e depois 0 enquanto não couber.
 * 3. Nunca ultrapassa a capacidade.
 * 4. Divide proporcionalmente à capacidade de cada laboratório e, dentro dele, entre as bancadas.
 */
import type { AllocationReport, AllocationSettings, LabReport, Placement, Room, SeatOrder, Unit } from './types';
import { normalizeName } from './participants';
import { shuffle } from './teams';

/* ------------------------------------------------------------------ */
/* Planta → bancadas                                                   */
/* ------------------------------------------------------------------ */

const machineAt = (lab: Room, r: number, c: number): string | null => {
  const cell = lab.cells[r]?.[c];
  return cell && typeof cell === 'object' ? cell.id : null;
};

const natural = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true });

function runs(lab: Room, dir: 'h' | 'v'): string[][] {
  const out: string[][] = [];
  const outer = dir === 'h' ? lab.rows : lab.cols;
  const inner = dir === 'h' ? lab.cols : lab.rows;
  for (let i = 0; i < outer; i++) {
    let cur: string[] = [];
    for (let j = 0; j <= inner; j++) {
      const id = j < inner ? (dir === 'h' ? machineAt(lab, i, j) : machineAt(lab, j, i)) : null;
      if (id) cur.push(id);
      else if (cur.length) {
        out.push(cur);
        cur = [];
      }
    }
  }
  return out;
}

/** Direção das bancadas: a que gera sequências contínuas mais longas. */
export function orientationOf(lab: Room): 'h' | 'v' {
  const avg = (rs: string[][]) => (rs.length ? rs.reduce((a, r) => a + r.length, 0) / rs.length : 0);
  return avg(runs(lab, 'v')) > avg(runs(lab, 'h')) ? 'v' : 'h';
}

/** Bancadas do laboratório, com as cadeiras em ordem crescente de identificação. */
export function benchesOf(lab: Room): string[][] {
  return runs(lab, orientationOf(lab))
    .map((r) => (natural(r[0], r[r.length - 1]) > 0 ? [...r].reverse() : r))
    .sort((a, b) => natural(a[0], b[0]));
}

interface Segment {
  labId: string;
  seats: string[];
}

/** Trechos utilizáveis: bancadas interrompidas pelos computadores excluídos. */
function segmentsOf(lab: Room): Segment[] {
  const excluded = new Set(lab.excluded);
  const segs: Segment[] = [];
  for (const bench of benchesOf(lab)) {
    let cur: string[] = [];
    for (const id of [...bench, null]) {
      if (id && !excluded.has(id)) cur.push(id);
      else if (cur.length) {
        segs.push({ labId: lab.id, seats: cur });
        cur = [];
      }
    }
  }
  return segs;
}

export function machineIds(lab: Room): string[] {
  return lab.cells.flat().flatMap((c) => (c && typeof c === 'object' ? [c.id] : []));
}

/** Computadores (= cadeiras) disponíveis: identificados no site menos os excluídos. */
export function availableMachines(lab: Room): number {
  const ex = new Set(lab.excluded);
  return machineIds(lab).filter((id) => !ex.has(id)).length;
}

/* ------------------------------------------------------------------ */
/* Empacotamento                                                       */
/* ------------------------------------------------------------------ */

/** Computador usado por uma unidade: o do meio do trecho (o 1º para duplas). */
export function computerFor(seats: string[]): string {
  return seats[Math.floor((seats.length - 1) / 2)];
}

function place(unit: Unit, seg: Segment, start: number): Placement {
  const seats = seg.seats.slice(start, start + unit.seats);
  return { unitId: unit.id, labId: seg.labId, seats, computer: computerFor(seats) };
}

function packSegment(seg: Segment, units: Unit[], gap: number): Placement[] | null {
  const out: Placement[] = [];
  let s = 0;
  for (const u of units) {
    if (s + u.seats > seg.seats.length) return null;
    out.push(place(u, seg, s));
    s += u.seats + gap;
  }
  return out;
}

function segmentCapacity(len: number, width: number, gap: number): number {
  return len >= width ? Math.floor((len + gap) / (width + gap)) : 0;
}

/** Divide `total` proporcionalmente às capacidades, sem ultrapassar nenhuma delas. */
export function distribute(total: number, caps: number[]): number[] | null {
  const C = caps.reduce((a, b) => a + b, 0);
  if (C < total) return null;
  if (total === 0) return caps.map(() => 0);
  const exact = caps.map((c) => (total * c) / C);
  const base = exact.map(Math.floor);
  let remaining = total - base.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  while (remaining > 0) {
    let progressed = false;
    for (const { i } of order) {
      if (remaining === 0) break;
      if (base[i] < caps[i]) {
        base[i]++;
        remaining--;
        progressed = true;
      }
    }
    if (!progressed) return null;
  }
  return base;
}

function packSequential(segs: Segment[], units: Unit[], gap: number): Placement[] | null {
  const out: Placement[] = [];
  let i = 0;
  for (const seg of segs) {
    let s = 0;
    while (i < units.length && s + units[i].seats <= seg.seats.length) {
      out.push(place(units[i], seg, s));
      s += units[i].seats + gap;
      i++;
    }
    if (i === units.length) break;
  }
  return i === units.length ? out : null;
}

function capacities(rooms: Room[], units: Unit[], gap: number) {
  const w = Math.max(1, ...units.map((u) => u.seats));
  return rooms.map((room) => {
    const segs = segmentsOf(room);
    const segCaps = segs.map((s) => segmentCapacity(s.seats.length, w, gap));
    return { room, segs, segCaps, cap: segCaps.reduce((a, b) => a + b, 0) };
  });
}

function tryGap(rooms: Room[], units: Unit[], gap: number): { placements: Placement[]; perLab: LabReport[] } | null {
  const labs = capacities(rooms, units, gap);
  const targets = distribute(units.length, labs.map((l) => l.cap));
  if (!targets) return null;
  const placements: Placement[] = [];
  const perLab: LabReport[] = [];
  let cursor = 0;
  for (let i = 0; i < labs.length; i++) {
    const { room, segs, segCaps, cap } = labs[i];
    const labUnits = units.slice(cursor, cursor + targets[i]);
    cursor += targets[i];
    perLab.push({ labId: room.id, units: labUnits.length, capacity: cap, machines: availableMachines(room) });
    const segTargets = distribute(labUnits.length, segCaps);
    let labPlacements: Placement[] | null = segTargets ? [] : null;
    if (segTargets) {
      let c = 0;
      for (let k = 0; k < segs.length && labPlacements; k++) {
        const packed = packSegment(segs[k], labUnits.slice(c, c + segTargets[k]), gap);
        c += segTargets[k];
        labPlacements = packed ? [...labPlacements, ...packed] : null;
      }
    }
    labPlacements ??= packSequential(segs, labUnits, gap);
    if (!labPlacements) return null;
    placements.push(...labPlacements);
  }
  return { placements, perLab };
}

export function orderUnits(units: Unit[], order: SeatOrder, random: () => number = Math.random): Unit[] {
  if (order === 'alpha') return [...units].sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)));
  if (order === 'random') return shuffle(units, random);
  return units;
}

export interface AllocationResult {
  placements: Record<string, Placement>;
  report: AllocationReport;
}

/** Calcula a melhor alocação possível segundo as prioridades descritas no topo do arquivo. */
export function computeAllocation(
  allRooms: Room[],
  unitsIn: Unit[],
  settings: AllocationSettings,
  random: () => number = Math.random,
  word: [string, string] = ['participante', 'participantes'],
): AllocationResult {
  const rooms = allRooms.filter((l) => l.selected);
  const units = orderUnits(unitsIn, settings.order, random);
  const machinesAvailable = rooms.reduce((a, l) => a + availableMachines(l), 0);
  const seatsNeeded = units.reduce((a, u) => a + u.seats, 0);
  const base: AllocationReport = {
    ok: false,
    units: units.length,
    gap: 0,
    maxGap: settings.maxGap,
    machinesAvailable,
    computersUsed: 0,
    seatsOccupied: 0,
    free: machinesAvailable,
    perLab: rooms.map((l) => ({ labId: l.id, units: 0, capacity: 0, machines: availableMachines(l) })),
  };
  if (!rooms.length) return { placements: {}, report: { ...base, error: 'Selecione ao menos um laboratório.' } };
  if (!units.length) return { placements: {}, report: { ...base, error: `Não há ${word[1]} para alocar.` } };

  let attempt: ReturnType<typeof tryGap> = null;
  let gap = settings.maxGap;
  for (; gap >= 0; gap--) {
    attempt = tryGap(rooms, units, gap);
    if (attempt) break;
  }
  if (!attempt) {
    // Último recurso para equipes de tamanhos diferentes: preenchimento sequencial sem espaço.
    const seq = packSequential(rooms.flatMap(segmentsOf), units, 0);
    if (seq) {
      gap = 0;
      attempt = {
        placements: seq,
        perLab: capacities(rooms, units, 0).map((l) => ({
          labId: l.room.id,
          units: seq.filter((p) => p.labId === l.room.id).length,
          capacity: l.cap,
          machines: availableMachines(l.room),
        })),
      };
    }
  }
  if (!attempt) {
    const cap0 = capacities(rooms, units, 0).reduce((a, l) => a + l.cap, 0);
    return {
      placements: {},
      report: {
        ...base,
        error:
          `Capacidade insuficiente: são necessárias ${seatsNeeded} cadeiras para ${units.length} ${word[1]}, ` +
          `e os laboratórios selecionados têm ${machinesAvailable} computadores/cadeiras` +
          (cap0 < units.length && seatsNeeded <= machinesAvailable ? ` (equipes precisam de cadeiras vizinhas na mesma bancada; cabem ${cap0})` : '') +
          '. Selecione mais laboratórios ou reduza as exclusões.',
      },
    };
  }

  const placements: Record<string, Placement> = {};
  attempt.placements.forEach((p) => (placements[p.unitId] = p));
  const seatsOccupied = attempt.placements.reduce((a, p) => a + p.seats.length, 0);
  let reason: string | undefined;
  if (gap < settings.maxGap) {
    const capAbove = capacities(rooms, units, gap + 1).reduce((a, l) => a + l.cap, 0);
    reason =
      `Com ${gap + 1} cadeira${gap + 1 > 1 ? 's' : ''} vazia${gap + 1 > 1 ? 's' : ''} entre ${word[1]}, as bancadas comportariam ` +
      `${capAbove} ${word[1]}; são ${units.length}. ` +
      (gap === 0 ? 'Por isso foram usadas cadeiras consecutivas.' : `O espaçamento foi reduzido para ${gap}.`);
  }
  return {
    placements,
    report: {
      ...base,
      ok: true,
      gap,
      computersUsed: attempt.placements.length,
      seatsOccupied,
      free: machinesAvailable - seatsOccupied,
      perLab: attempt.perLab,
      reason,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ajustes manuais e validação                                         */
/* ------------------------------------------------------------------ */

type Check = { ok: true; placement: Placement } | { ok: false; error: string };

/** Valida se a unidade pode ocupar `seats` (sequência) sem conflitos. */
function checkSeats(room: Room, placements: Record<string, Placement>, unit: Unit, seg: Segment, start: number, ignore: Set<string>): Check {
  if (start < 0 || start + unit.seats > seg.seats.length)
    return { ok: false, error: `Não há ${unit.seats} cadeiras vizinhas livres nesse trecho da bancada.` };
  const p = place(unit, seg, start);
  const want = new Set(p.seats);
  for (const other of Object.values(placements)) {
    if (ignore.has(other.unitId) || other.labId !== room.id) continue;
    if (other.seats.some((s) => want.has(s))) return { ok: false, error: 'O trecho inclui cadeiras já ocupadas.' };
  }
  return { ok: true, placement: p };
}

function locate(room: Room, machine: string): { seg: Segment; index: number } | null {
  for (const seg of segmentsOf(room)) {
    const index = seg.seats.indexOf(machine);
    if (index >= 0) return { seg, index };
  }
  return null;
}

/** Tenta colocar a unidade em um trecho que contenha `machine`. */
function fitAt(room: Room, placements: Record<string, Placement>, unit: Unit, machine: string, ignore: Set<string>): Check {
  if (!room.selected) return { ok: false, error: `${room.name} não está selecionado.` };
  const loc = locate(room, machine);
  if (!loc) return { ok: false, error: `${machine} está indisponível nesta competição.` };
  let last: Check = { ok: false, error: 'Não foi possível posicionar aqui.' };
  for (let start = loc.index; start >= Math.max(0, loc.index - unit.seats + 1); start--) {
    last = checkSeats(room, placements, unit, loc.seg, start, ignore);
    if (last.ok) return last;
  }
  return last;
}

export type MoveResult = { ok: true; placements: Record<string, Placement> } | { ok: false; error: string };

const occupantOf = (placements: Record<string, Placement>, labId: string, machine: string) =>
  Object.values(placements).find((p) => p.labId === labId && p.seats.includes(machine));

/**
 * Move uma unidade para o computador clicado. Se ele estiver ocupado,
 * troca as duas unidades de lugar (validando ambas).
 */
export function moveUnit(
  rooms: Room[],
  units: Unit[],
  placements: Record<string, Placement>,
  unitId: string,
  labId: string,
  machine: string,
): MoveResult {
  const unit = units.find((u) => u.id === unitId);
  const room = rooms.find((l) => l.id === labId);
  if (!unit || !room) return { ok: false, error: 'Unidade ou laboratório não encontrado.' };
  const occupant = occupantOf(placements, labId, machine);

  if (occupant && occupant.unitId !== unitId) {
    const mine = placements[unitId];
    const other = units.find((u) => u.id === occupant.unitId);
    if (!other) return { ok: false, error: 'Lugar ocupado por uma unidade desconhecida.' };
    if (!mine) return { ok: false, error: 'Lugar ocupado. Para trocar, as duas precisam estar no mapa.' };
    const ignore = new Set([unitId, other.id]);
    const myRoom = rooms.find((l) => l.id === mine.labId)!;
    const a = fitAt(room, placements, unit, occupant.seats[0], ignore);
    if (!a.ok) return a;
    const b = fitAt(myRoom, placements, other, mine.seats[0], ignore);
    if (!b.ok) return { ok: false, error: `${other.name}: ${b.error}` };
    if (a.placement.labId === b.placement.labId && a.placement.seats.some((s) => b.placement.seats.includes(s)))
      return { ok: false, error: 'As unidades têm tamanhos diferentes e se sobreporiam após a troca.' };
    return { ok: true, placements: { ...placements, [unitId]: a.placement, [other.id]: b.placement } };
  }
  const r = fitAt(room, placements, unit, machine, new Set([unitId]));
  return r.ok ? { ok: true, placements: { ...placements, [unitId]: r.placement } } : r;
}

export interface AllocationHealth {
  /** Unidades com lugar inválido (lab desmarcado, máquina excluída/inexistente, sobreposição, tamanho mudou). */
  invalid: string[];
  unplaced: string[];
  orphans: string[];
}

export function checkAllocation(rooms: Room[], units: Unit[], placements: Record<string, Placement>): AllocationHealth {
  const unitById = new Map(units.map((u) => [u.id, u]));
  const roomById = new Map(rooms.map((l) => [l.id, l]));
  const invalid: string[] = [];
  const orphans: string[] = [];
  const used = new Map<string, number>();
  for (const p of Object.values(placements)) if (unitById.has(p.unitId)) p.seats.forEach((s) => used.set(`${p.labId}:${s}`, (used.get(`${p.labId}:${s}`) ?? 0) + 1));
  for (const p of Object.values(placements)) {
    const u = unitById.get(p.unitId);
    if (!u) {
      orphans.push(p.unitId);
      continue;
    }
    const room = roomById.get(p.labId);
    const contiguous = room?.selected && segmentsOf(room).some((seg) => {
      const i = seg.seats.indexOf(p.seats[0]);
      return i >= 0 && p.seats.every((s, k) => seg.seats[i + k] === s);
    });
    if (!contiguous || p.seats.length !== u.seats || !p.seats.includes(p.computer) || p.seats.some((s) => (used.get(`${p.labId}:${s}`) ?? 0) > 1))
      invalid.push(p.unitId);
  }
  return { invalid, unplaced: units.filter((u) => !placements[u.id]).map((u) => u.id), orphans };
}
