import { describe, expect, it } from 'vitest';
import { pairLists, parseNameList } from './participants';
import { buildUnits, formTeams, teamSizes } from './teams';
import { benchesOf, checkAllocation, computeAllocation, distribute, moveUnit, orientationOf } from './allocation';
import snapshot from '../data/lcc-snapshot.json';
// @ts-expect-error módulo JS do gateway, sem declaração de tipos
import { parseLcc } from '../../gateway/core.js';
import { applyRank, parseContestId, parseRank } from './vjudge';
import { allProblems, newContest, problemKey, removeContest, setContestLink, standings, unitsInContest } from './contests';
import { buildCustomLab, validateCustomLab } from './customLabs';
import { hydrate } from '../state/persistence';
import { roomsOf } from '../state/selectors';
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
  const k = s.contests[0].key;
  return {
    ...s,
    participants,
    contests: [
      {
        ...s.contests[0],
        contestId: '1',
        problems: [
          { key: problemKey(k, 0), contest: k, index: 0, letter: 'A', title: '', color: '#61D295' },
          { key: problemKey(k, 1), contest: k, index: 1, letter: 'B', title: '', color: '#1E88FD' },
        ],
      },
    ],
  };
}
const K = (s: AppState, i: number) => problemKey(s.contests[0].key, i);

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
    const c = s.contests[0].key;
    const r = applyRank(s, c, rank, 5);
    const [ana, bia] = s.participants;
    expect(r.state.results[ana.id][K(s, 0)].solvedAt).toBe(1_000_000 + 50_000);
    expect(r.state.results[bia.id][K(s, 1)].solvedSource).toBe('vjudge');
    expect(r.events).toHaveLength(2);
    const again = applyRank(r.state, c, rank, 6);
    expect(again.events).toHaveLength(0);
  });

  it('entrega não apaga o Accepted e a sincronização não sobrescreve a entrega', () => {
    const s0 = contestState();
    const c = s0.contests[0].key;
    const a = K(s0, 0);
    const [ana] = s0.participants;
    let s = applyRank(s0, c, rank, 5).state;
    s = deliverBalloon(s, ana.id, a, 100).state;
    expect(cellStatus(s.results[ana.id][a])).toBe('delivered');
    expect(s.results[ana.id][a].solvedAt).toBeDefined();
    s = applyRank(s, c, rank, 200).state;
    expect(s.results[ana.id][a].deliveredAt).toBe(100);
    s = undoDelivery(s, ana.id, a, 300);
    expect(cellStatus(s.results[ana.id][a])).toBe('solved');
    expect(balloonQueue(s, buildUnits(s)).length).toBe(2);
  });

  it('não permite entregar balão de questão não resolvida; AC manual vira vjudge depois', () => {
    const s0 = contestState();
    const a = K(s0, 0);
    const [ana] = s0.participants;
    expect(deliverBalloon(s0, ana.id, a, 1).state).toBe(s0);
    let s = markManualSolved(s0, ana.id, a, 1);
    expect(s.results[ana.id][a].solvedSource).toBe('manual');
    s = applyRank(s, s0.contests[0].key, rank, 2).state;
    expect(s.results[ana.id][a].solvedSource).toBe('vjudge');
  });
});

describe('vários contests', () => {
  /** Dois contests (divisões): Ana no C1, Bia no C2, mesma questão de índice 0 nos dois. */
  function twoContests(): AppState {
    const s = contestState();
    const c2 = { ...newContest(s.contests), contestId: '2' };
    c2.problems = [{ key: problemKey(c2.key, 0), contest: c2.key, index: 0, letter: 'A', title: '', color: '#F2545B' }];
    return { ...s, contests: [...s.contests, c2] };
  }
  const r1 = parseRank({ id: 1, begin: 0, participants: { 1: { name: 'ana123' } }, submissions: [[1, 0, 1, 120]] });
  const r2 = parseRank({ id: 2, begin: 0, participants: { 7: { name: 'bia456' } }, submissions: [[7, 0, 1, 60]] });

  it('mantém resultados separados por contest, mesmo com o mesmo índice de questão', () => {
    const s0 = twoContests();
    const [c1, c2] = s0.contests;
    let s = applyRank(s0, c1.key, r1, 5).state;
    s = applyRank(s, c2.key, r2, 6).state;
    const [ana, bia] = s.participants;
    expect(Object.keys(s.results[ana.id])).toEqual([problemKey(c1.key, 0)]);
    expect(Object.keys(s.results[bia.id])).toEqual([problemKey(c2.key, 0)]);
    expect(allProblems(s)).toHaveLength(3);
    expect(s.contests[1].seenAccounts).toEqual(['bia456']);
  });

  it('identifica quem participa de cada contest pelas contas vistas no ranking', () => {
    const s0 = twoContests();
    const [c1, c2] = s0.contests;
    let s = applyRank(s0, c1.key, r1, 5).state;
    s = applyRank(s, c2.key, r2, 6).state;
    s = { ...s, contests: s.contests.map((c) => ({ ...c, lastSyncAt: 1 })) };
    const us = buildUnits(s);
    expect(unitsInContest(s, s.contests[0], us).map((u) => u.name)).toEqual(['Ana']);
    expect(unitsInContest(s, s.contests[1], us).map((u) => u.name)).toEqual(['Bia']);
    // antes da primeira leitura, todos aparecem
    expect(unitsInContest(s0, s0.contests[1], us)).toHaveLength(2);
  });

  it('notificação mostra a sigla do contest quando há mais de um', () => {
    const s0 = twoContests();
    const r = applyRank(s0, s0.contests[1].key, r2, 5);
    expect(r.events[0].title).toContain('C2·A');
  });

  it('remover ou trocar o link de um contest apaga só os resultados dele', () => {
    const s0 = twoContests();
    const [c1, c2] = s0.contests;
    let s = applyRank(s0, c1.key, r1, 5).state;
    s = applyRank(s, c2.key, r2, 6).state;
    const [ana, bia] = s.participants;
    const removed = removeContest(s, c2.key);
    expect(removed.contests).toHaveLength(1);
    expect(removed.results[bia.id]).toEqual({});
    expect(removed.results[ana.id][problemKey(c1.key, 0)].solvedAt).toBeDefined();
    expect(removed.notified.some((n) => n.includes(c2.key))).toBe(false);
    const switched = setContestLink(s, c1.key, '999', '999');
    expect(switched.results[ana.id]).toEqual({});
    expect(switched.contests[0]).toMatchObject({ contestId: '999', problems: [], lastSyncAt: null });
    expect(switched.results[bia.id][problemKey(c2.key, 0)].solvedAt).toBeDefined();
  });

  it('classificação: mais resolvidas e, no empate, menor soma de tempos', () => {
    const s0 = contestState();
    const c = s0.contests[0].key;
    const rank = parseRank({
      id: 1,
      begin: 60_000,
      participants: { 1: { name: 'ana123' }, 2: { name: 'bia456' } },
      submissions: [
        [1, 0, 1, 600],
        [2, 0, 1, 300],
      ],
    });
    const s = applyRank({ ...s0, contests: [{ ...s0.contests[0], begin: 60_000 }] }, c, rank, 1).state;
    const st = standings(s, buildUnits(s), allProblems(s));
    const [ana, bia] = s.participants;
    expect(st.get(bia.id)).toMatchObject({ position: 1, solved: 1, minutes: 5 });
    expect(st.get(ana.id)).toMatchObject({ position: 2, minutes: 10 });
  });

  it('migra o estado v2 (um contest, resultados por índice) sem perder Accepted nem entregas', () => {
    const v2 = {
      version: 2,
      gatewayUrl: 'https://gw.example',
      participants: [{ id: 'p1', name: 'Ana', vjudge: 'ana123' }],
      vjudge: { contestInput: '870484', contestId: '870484', contestTitle: 'WCC', source: 'gateway', autoPoll: true, pollSeconds: 20, contestAccess: 'public' },
      problems: [{ index: 0, letter: 'A', title: '', color: '#123456' }],
      results: { p1: { 0: { solvedAt: 10, solvedSource: 'vjudge', deliveredAt: 20 } } },
      notified: ['p1:0'],
    };
    const s = hydrate(v2);
    const k = s.contests[0].key;
    expect(s.version).toBe(3);
    expect(s.contests).toHaveLength(1);
    expect(s.contests[0]).toMatchObject({ contestId: '870484', contestTitle: 'WCC', contestAccess: 'public' });
    expect(s.contests[0].problems[0]).toMatchObject({ key: problemKey(k, 0), color: '#123456' });
    expect(s.results.p1[problemKey(k, 0)]).toMatchObject({ solvedAt: 10, deliveredAt: 20 });
    expect(s.notified).toEqual([`p1:${problemKey(k, 0)}`]);
    expect(s.vjudge).toEqual({ source: 'gateway', autoPoll: true, pollSeconds: 20 });
    expect(hydrate(JSON.parse(JSON.stringify(s)))).toMatchObject({ contests: s.contests, results: s.results });
  });
});

describe('laboratórios personalizados', () => {
  const spec = { id: 'SALA1', name: 'Sala 1', machines: 20, benches: 4, orientation: 'h' as const, paired: false, door: 'front-left' as const };

  it('gera a planta com a quantidade exata de computadores, corredores e porta', () => {
    const lab = buildCustomLab(spec);
    const ids = lab.cells.flat().flatMap((c) => (c && typeof c === 'object' ? [c.id] : []));
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(ids[0]).toBe('SALA1-01');
    expect(lab.cells[0][0]).toBe('door');
    expect(lab.rows).toBe(1 + 4 + 3); // porta + 4 bancadas + 3 corredores
    const room = { ...lab, selected: true, excluded: [] };
    expect(benchesOf(room)).toHaveLength(4);
    expect(benchesOf(room).every((b) => b.length === 5)).toBe(true);
  });

  it('corredores verticais viram bancadas em colunas; pares dividem o corredor', () => {
    const lab = buildCustomLab({ ...spec, orientation: 'v', paired: true, door: 'back-right', machines: 22 });
    const room = { ...lab, selected: true, excluded: [] };
    expect(orientationOf(room)).toBe('v');
    expect(benchesOf(room).map((b) => b.length)).toEqual([6, 6, 6, 4]);
    expect(lab.cols).toBe(4 + 1); // 4 bancadas, 1 corredor entre os pares
    expect(lab.cells[lab.rows - 1][lab.cols - 1]).toBe('door');
  });

  it('é alocado junto com os laboratórios do LCC e respeita equipes', () => {
    const s = { ...defaultState(), customLabs: [spec], labSelection: { SALA1: { selected: true, excluded: [] }, LCC1: { selected: true, excluded: [] } } };
    const rooms = roomsOf(s).filter((r) => r.selected);
    expect(rooms.map((r) => r.id).sort()).toEqual(['LCC1', 'SALA1']);
    const r = computeAllocation(rooms, units(10, 3), { maxGap: 1, order: 'list' });
    expect(r.report.ok).toBe(true);
    const sala = Object.values(r.placements).filter((p) => p.labId === 'SALA1');
    expect(sala.length).toBeGreaterThan(0);
    const benches = benchesOf(rooms.find((x) => x.id === 'SALA1')!);
    for (const p of sala) expect(benches.some((b) => p.seats.every((x) => b.includes(x)))).toBe(true);
  });

  it('valida sigla repetida e quantidades', () => {
    expect(validateCustomLab(spec, ['LCC1'])).toEqual([]);
    expect(validateCustomLab(spec, ['sala1']).join()).toMatch(/Já existe/);
    expect(validateCustomLab({ ...spec, benches: 30 }, []).join()).toMatch(/bancadas/);
    expect(validateCustomLab({ ...spec, machines: 0 }, []).length).toBeGreaterThan(0);
  });
});
