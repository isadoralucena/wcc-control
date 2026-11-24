import { describe, expect, it } from 'vitest';
import { pairLists, parseNameList } from './participants';
import { buildUnits, formTeams, teamSizes } from './teams';
import { benchesOf, checkAllocation, computeAllocation, distribute, moveUnit, orientationOf } from './allocation';
import snapshot from '../data/lcc-snapshot.json';
// @ts-expect-error módulo JS do gateway, sem declaração de tipos
import { parseLcc } from '../../gateway/core.js';
import { applyRank, parseContestId, parseRank } from './vjudge';
import { cellStatus, deliverBalloon, markManualSolved, undoDelivery, balloonQueue } from './balloons';
import { defaultState } from '../state/defaults';
import { createParticipants } from './participants';
import type { AppState, LccLab, Room, Unit } from './types';

const real = (id: string, extra: Partial<Room> = {}): Room => ({
  ...(snapshot.labs.find((l) => l.id === id) as unknown as LccLab),
  selected: true,
  excluded: [],
  ...extra,
});
/** Laboratório sintético: `rows` bancadas horizontais de `cols` computadores, separadas por corredores. */
const grid = (id: string, rows: number, cols: number, extra: Partial<Room> = {}): Room => {
  const cells: LccLab['cells'] = [];
  for (let r = 0; r < rows; r++) {
    cells.push(Array.from({ length: cols }, (_, c) => ({ id: `${id}-${String(r * cols + c + 1).padStart(2, '0')}`, status: 'ok' as const })));
    if (r < rows - 1) cells.push(Array(cols).fill(null));
  }
  return { id, name: id, rows: cells.length, cols, machines: rows * cols, cells, selected: true, excluded: [], ...extra };
};
const units = (n: number, seats = 1): Unit[] => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, name: `U${i}`, members: [], accounts: [], seats }));
const idx = (id: string) => Number(id.split('-').pop());

describe('participantes', () => {
  it('remove vazias e duplicadas (sem acento/caixa)', () => {
    const r = parseNameList('Ana Clara\n\n  ana clara \nBeatriz Souza\nBEATRIZ  SOUZA\n1. Camila', ['Camila']);
    expect(r.names).toEqual(['Ana Clara', 'Beatriz Souza']);
    expect(r.duplicates).toHaveLength(3);
  });
  it('associa usernames pela ordem e avisa diferença de tamanho', () => {
    const r = pairLists('Ana\nBia\nCamila', 'ana123\nbia456');
    expect(r.mismatch).toBe(true);
    expect(r.pairs).toEqual([
      { name: 'Ana', username: 'ana123' },
      { name: 'Bia', username: 'bia456' },
      { name: 'Camila', username: '' },
    ]);
  });
});

describe('equipes', () => {
  it('nunca descarta participantes', () => {
    for (let n = 1; n <= 20; n++)
      for (const s of [2, 3] as const)
        for (const st of ['balance', 'smaller'] as const) expect(teamSizes(n, s, st).reduce((a, b) => a + b, 0)).toBe(n);
  });
  it('equilibra o resto', () => {
    expect(teamSizes(7, 3, 'balance')).toEqual([3, 2, 2]);
    expect(teamSizes(8, 3, 'balance')).toEqual([3, 3, 2]);
    expect(teamSizes(5, 2, 'balance')).toEqual([2, 3]);
    expect(teamSizes(7, 3, 'smaller')).toEqual([3, 3, 1]);
  });
  it('equipe usa 1 computador mesmo com 3 cadeiras', () => {
    const participants = createParticipants(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name })));
    const teams = formTeams(participants, { size: 3, remainder: 'balance' });
    const us = buildUnits({ mode: 'team', participants, teams });
    expect(us.map((u) => u.seats)).toEqual([3, 3]);
  });
});

describe('planta do LCC', () => {
  it('interpreta o HTML no formato do site (máquinas, corredores, porta, status) sem ler usuários', () => {
    const pc = (id: string, img: string, st: string, user = '') =>
      `<div class="coluna"><span class="destaque">${id}</span><img src="images/${img}.png" class="imgStatus"><div class="popup"><b>${id} - ${st}</b><br> <b> Usuário(s) logado(s):</b><br>${user}<br></div></div>`;
    const html =
      `<div class="panel-heading pointer" title="Clique para exibir ou ocultar o status do laboratório." onclick="x"> <div class="panel-title" id="lab9-titulo">LAB9</div></div>` +
      `<div class="panel-body" id="lab9-dados"><div class="linha">${pc('LAB9-02', 'on', 'OK', 'fulano.silva')}<div class="coluna-vazia"></div>${pc('LAB9-03', 'off', 'DOWN')}</div>` +
      `<div class="linha">${pc('LAB9-01', 'onMint', 'OK')}<div class="coluna-vazia"></div>${pc('LAB9-04', 'on', 'OK')}</div>` +
      `<div class="linha"><div class="coluna-vazia"><img src="images/porta.png" class="imgStatusPorta1" title="Porta de acesso"></div><div class="coluna-vazia"></div><div class="coluna-vazia"></div></div></div>` +
      `<div class="panel-heading pointer" title="Clique para exibir ou ocultar o status dos servidores." onclick="y"> <div class="panel-title" id="server-titulo">Servidores</div></div>`;
    const labs = parseLcc(html);
    expect(labs).toHaveLength(1);
    expect(labs[0]).toMatchObject({ id: 'LAB9', machines: 4, rows: 3, cols: 3 });
    expect(labs[0].cells[0][2]).toEqual({ id: 'LAB9-03', status: 'down' });
    expect(labs[0].cells[2][0]).toBe('door');
    expect(JSON.stringify(labs)).not.toContain('fulano');
  });

  it('snapshot gerado do site real é consistente (siglas únicas, contagem = computadores da planta)', () => {
    expect(snapshot.labs.length).toBeGreaterThan(0);
    for (const lab of snapshot.labs) {
      const ids = lab.cells.flat().flatMap((c) => (c && typeof c === 'object' ? [(c as { id: string }).id] : []));
      expect(ids.length).toBe(lab.machines);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id.startsWith(`${lab.id}-`))).toBe(true);
    }
  });

  it('detecta a direção das bancadas pela planta (LCC1 vertical, LCC3 horizontal)', () => {
    expect(orientationOf(real('LCC1'))).toBe('v');
    expect(orientationOf(real('LCC3'))).toBe('h');
    const b1 = benchesOf(real('LCC1'));
    expect(b1.reduce((a, b) => a + b.length, 0)).toBe(56);
    expect(b1[0].slice(0, 3)).toEqual(['LCC1-01', 'LCC1-02', 'LCC1-03']);
    expect(benchesOf(real('LCC3')).every((b) => b.length === 6)).toBe(true);
  });
});

describe('alocação', () => {
  it('distribui proporcionalmente sem ultrapassar', () => {
    expect(distribute(10, [10, 10])).toEqual([5, 5]);
    expect(distribute(5, [2, 10])).toEqual([1, 4]);
    expect(distribute(11, [5, 5])).toBeNull();
  });
  it('usa 2 cadeiras vazias quando cabe', () => {
    const r = computeAllocation([grid('L', 1, 7)], units(3), { maxGap: 2, order: 'list' });
    expect(r.report.gap).toBe(2);
    expect(Object.values(r.placements).map((p) => p.computer)).toEqual(['L-01', 'L-04', 'L-07']);
  });
  it('reduz o espaçamento quando necessário e explica', () => {
    const r = computeAllocation([grid('L', 1, 7)], units(4), { maxGap: 2, order: 'list' });
    expect(r.report.gap).toBe(1);
    expect(r.report.reason).toBeTruthy();
    expect(computeAllocation([grid('L', 1, 7)], units(7), { maxGap: 2, order: 'list' }).report.gap).toBe(0);
  });
  it('nunca ultrapassa a capacidade (1 computador = 1 cadeira)', () => {
    const r = computeAllocation([grid('L', 1, 7)], units(8), { maxGap: 2, order: 'list' });
    expect(r.report.ok).toBe(false);
    expect(Object.keys(r.placements)).toHaveLength(0);
    // 3 trios = 9 cadeiras > 7 computadores, mesmo usando só 3 computadores
    expect(computeAllocation([grid('L', 1, 7)], units(3, 3), { maxGap: 0, order: 'list' }).report.ok).toBe(false);
  });
  it('equipe de 3 ocupa 3 cadeiras vizinhas e usa só o computador do meio', () => {
    const r = computeAllocation([grid('L', 1, 12)], units(2, 3), { maxGap: 2, order: 'list' });
    expect(r.report).toMatchObject({ ok: true, computersUsed: 2, seatsOccupied: 6, machinesAvailable: 12, free: 6, gap: 2 });
    const [a, b] = Object.values(r.placements);
    expect(a.seats).toEqual(['L-01', 'L-02', 'L-03']);
    expect(a.computer).toBe('L-02');
    expect(idx(b.seats[0]) - idx(a.seats[2]) - 1).toBe(2);
  });
  it('dupla usa 1 computador e 2 cadeiras', () => {
    const r = computeAllocation([grid('L', 1, 6)], units(2, 2), { maxGap: 2, order: 'list' });
    expect(r.report).toMatchObject({ computersUsed: 2, seatsOccupied: 4 });
  });
  it('equipes não atravessam corredores nem computadores indisponíveis', () => {
    const room = grid('L', 3, 5, { excluded: ['L-03'] }); // bancada 1 vira 2+2: nenhum trio cabe nela
    const r = computeAllocation([room], units(2, 3), { maxGap: 0, order: 'list' });
    expect(r.report.ok).toBe(true);
    for (const p of Object.values(r.placements)) {
      expect(p.seats).not.toContain('L-03');
      const rows = new Set(p.seats.map((s) => Math.floor((idx(s) - 1) / 5)));
      expect(rows.size).toBe(1);
    }
    expect(checkAllocation([room], units(2, 3), r.placements).invalid).toEqual([]);
  });
  it('equilibra entre LCC1 e LCC2 reais e respeita o espaçamento na bancada', () => {
    const r = computeAllocation([real('LCC1'), real('LCC2')], units(30), { maxGap: 2, order: 'list' });
    expect(r.report.perLab.map((l) => l.units)).toEqual([15, 15]);
    expect(r.report.gap).toBe(2);
    expect(r.report.machinesAvailable).toBe(112);
  });
  it('trios no LCC3 real ficam dentro de uma bancada de 6', () => {
    const lab = real('LCC3');
    const r = computeAllocation([lab], units(20, 3), { maxGap: 2, order: 'list' });
    expect(r.report.ok).toBe(true);
    const benches = benchesOf(lab);
    for (const p of Object.values(r.placements)) expect(benches.some((b) => p.seats.every((s) => b.includes(s)))).toBe(true);
  });
  it('troca e move manualmente com validação', () => {
    const room = grid('L', 1, 5);
    const us = units(2);
    const r = computeAllocation([room], us, { maxGap: 2, order: 'list' });
    const swapped = moveUnit([room], us, r.placements, 'u0', 'L', r.placements.u1.computer);
    expect(swapped.ok && swapped.placements.u0.computer).toBe(r.placements.u1.computer);
    expect(moveUnit([{ ...room, excluded: ['L-02'] }], us, r.placements, 'u0', 'L', 'L-02').ok).toBe(false);
  });
});

describe('vjudge', () => {
  it('extrai o ID do contest', () => {
    expect(parseContestId('https://vjudge.net/contest/870665#problem')).toBe('870665');
    expect(parseContestId('870665')).toBe('870665');
    expect(parseContestId('abc')).toBeNull();
  });
  it('lê os dois formatos de participantes', () => {
    const a = parseRank({ id: 1, title: 't', begin: 0, length: 10, participants: { '7': { name: 'ana123' } }, submissions: [[7, 0, 1, 60]] });
    const b = parseRank(JSON.stringify({ id: 1, begin: 0, participants: { '7': ['ana123', 'Ana', ''] }, submissions: [[7, 0, 1, 60]] }));
    expect(a.accounts.get('7')).toBe('ana123');
    expect(b.accounts.get('7')).toBe('ana123');
    expect(() => parseRank('<html>')).toThrow();
  });
});

function contestState(): AppState {
  const s = defaultState();
  const participants = createParticipants([
    { name: 'Ana', username: 'ana123' },
    { name: 'Bia', username: 'Bia456' },
  ]);
  return {
    ...s,
    participants,
    problems: [
      { index: 0, letter: 'A', title: '', color: '#61D295' },
      { index: 1, letter: 'B', title: '', color: '#1E88FD' },
    ],
  };
}

describe('balões e sincronização', () => {
  const rank = parseRank({
    id: 1,
    title: 'C',
    begin: 1_000_000,
    length: 1,
    participants: { '1': { name: 'ana123' }, '2': { name: 'bia456' } },
    submissions: [
      [1, 0, 0, 30],
      [1, 0, 1, 90],
      [1, 0, 1, 50],
      [2, 1, 1, 10],
    ],
  });

  it('marca o primeiro Accepted, notifica uma vez e casa username sem diferenciar caixa', () => {
    const s = contestState();
    const r = applyRank(s, rank, 5);
    const [ana, bia] = s.participants;
    expect(r.state.results[ana.id][0].solvedAt).toBe(1_000_000 + 50_000);
    expect(r.state.results[bia.id][1].solvedSource).toBe('vjudge');
    expect(r.events).toHaveLength(2);
    const again = applyRank(r.state, rank, 6);
    expect(again.events).toHaveLength(0);
  });

  it('entrega não apaga o Accepted e a sincronização não sobrescreve a entrega', () => {
    const s0 = contestState();
    const [ana] = s0.participants;
    let s = applyRank(s0, rank, 5).state;
    s = deliverBalloon(s, ana.id, 0, 100).state;
    expect(cellStatus(s.results[ana.id][0])).toBe('delivered');
    expect(s.results[ana.id][0].solvedAt).toBeDefined();
    s = applyRank(s, rank, 200).state;
    expect(s.results[ana.id][0].deliveredAt).toBe(100);
    s = undoDelivery(s, ana.id, 0, 300);
    expect(cellStatus(s.results[ana.id][0])).toBe('solved');
    expect(balloonQueue(s, buildUnits(s)).length).toBe(2);
  });

  it('não permite entregar balão de questão não resolvida; AC manual vira vjudge depois', () => {
    const s0 = contestState();
    const [ana] = s0.participants;
    expect(deliverBalloon(s0, ana.id, 0, 1).state).toBe(s0);
    let s = markManualSolved(s0, ana.id, 0, 1);
    expect(s.results[ana.id][0].solvedSource).toBe('manual');
    s = applyRank(s, rank, 2).state;
    expect(s.results[ana.id][0].solvedSource).toBe('vjudge');
  });
});
