import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Armchair, DoorOpen, Monitor, Printer, RefreshCw, Search, X } from 'lucide-react';
import type { Route } from '../App';
import { useStore } from '../state/store';
import { allocate } from '../state/actions';
import { roomsOf } from '../state/selectors';
import { useConfirm } from '../components/Confirm';
import { useToasts } from '../components/Toasts';
import { EmptyState, Notice, Segmented } from '../components/ui';
import { BalloonMap } from './arena/BalloonMap';
import { allProblems } from '../domain/contests';
import { availableMachines, checkAllocation, moveUnit } from '../domain/allocation';
import { normalizeName } from '../domain/participants';
import { pad } from '../domain/ids';
import type { Placement, Room, Unit } from '../domain/types';

/** Cores de grupo para distinguir equipes vizinhas no mapa. */
const GROUP_TINTS = ['#7B68E5', '#1E88FD', '#1b9e63', '#d9822b', '#c2459a', '#2a9d9a'];

export function MapScreen({ go }: { go: (r: Route) => void }) {
  const { state, commit, units } = useStore();
  const confirm = useConfirm();
  const { notify } = useToasts();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'edit' | 'balloons'>('edit');
  const [focusProblem, setFocusProblem] = useState<string | null>(null);
  const alloc = state.allocation;
  const rooms = useMemo(() => roomsOf(state), [state.labCatalog, state.labSelection, state.customLabs]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedRooms = rooms.filter((r) => r.selected);
  const placements = alloc?.placements ?? {};
  const health = useMemo(() => checkAllocation(rooms, units, placements), [rooms, units, placements]);
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const unitIndex = useMemo(() => new Map(units.map((u, i) => [u.id, i])), [units]);
  const team = state.mode === 'team';
  const word = team ? ['equipe', 'equipes'] : ['participante', 'participantes'];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const recompute = async () => {
    if (alloc?.edited) {
      const ok = await confirm({
        title: 'Recalcular a alocação?',
        body: 'Os ajustes manuais feitos no mapa serão substituídos pela distribuição automática.',
        confirmLabel: 'Recalcular',
      });
      if (!ok) return;
    }
    commit(allocate);
    setSelected(null);
  };

  const live = useMemo(() => {
    const ps = Object.values(placements).filter((p) => unitById.has(p.unitId));
    const machines = selectedRooms.reduce((a, r) => a + availableMachines(r), 0);
    const seats = ps.reduce((a, p) => a + p.seats.length, 0);
    return { placed: ps.length, machines, computers: ps.length, seats, free: machines - seats };
  }, [placements, unitById, selectedRooms]);

  const clickMachine = (labId: string, machine: string, occupantId?: string) => {
    if (!selected) {
      if (occupantId) setSelected(occupantId);
      return;
    }
    if (selected === occupantId) return setSelected(null);
    const valid = Object.fromEntries(Object.entries(placements).filter(([id]) => (unitById.has(id) && !health.invalid.includes(id)) || id === selected));
    const r = moveUnit(rooms, units, valid, selected, labId, machine);
    if (!r.ok) {
      notify({ kind: 'error', title: 'Movimento não permitido', detail: r.error });
      return;
    }
    commit((s) => ({
      ...s,
      allocation: s.allocation ? { ...s.allocation, placements: r.placements, edited: true } : s.allocation,
    }));
    setSelected(null);
  };

  const unplace = (id: string) =>
    commit((s) => {
      if (!s.allocation) return s;
      const p = { ...s.allocation.placements };
      delete p[id];
      return { ...s, allocation: { ...s.allocation, placements: p, edited: true } };
    });

  const match = (u: Unit | undefined) =>
    !!u && !!query.trim() && normalizeName([u.name, ...u.members.map((m) => m.name), ...u.accounts].join(' ')).includes(normalizeName(query));

  if (!selectedRooms.length || !units.length) {
    return (
      <div className="screen">
        <ScreenTitle />
        <EmptyState title="Nada para mapear ainda" action={<button className="btn btn--primary" onClick={() => go('setup')}>Ir para a configuração</button>}>
          Selecione laboratórios e cadastre {word[1]} na etapa 01.
        </EmptyState>
      </div>
    );
  }

  if (!alloc) {
    return (
      <div className="screen">
        <ScreenTitle />
        <EmptyState title="Mapa ainda não gerado" action={<button className="btn btn--primary" onClick={() => commit(allocate)}>Calcular alocação</button>}>
          {units.length} {word[1]} em {selectedRooms.map((l) => l.name).join(', ')}.
        </EmptyState>
      </div>
    );
  }

  const rep = alloc.report;
  const selectedUnit = selected ? unitById.get(selected) : undefined;

  return (
    <div className="screen map">
      <ScreenTitle>
        <div className="row-gap noprint">
          <Segmented<'edit' | 'balloons'>
            label="Modo do mapa"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setSelected(null);
            }}
            options={[
              { value: 'edit', label: 'Alocação', hint: 'Quem senta onde; clique para mover ou trocar' },
              { value: 'balloons', label: 'Balões', hint: 'Balões pendentes e entregues em cada computador' },
            ]}
          />
          <label className="search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Localizar ${word[0]}`} />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Limpar busca">
                <X size={12} />
              </button>
            )}
          </label>
          <button className="btn btn--ghost" onClick={() => window.print()}>
            <Printer size={16} /> Imprimir
          </button>
          {mode === 'edit' && (
            <button className="btn btn--ghost" onClick={() => void recompute()}>
              <RefreshCw size={16} /> {state.allocationSettings.order === 'random' ? 'Novo sorteio' : 'Recalcular'}
            </button>
          )}
        </div>
      </ScreenTitle>

      {mode === 'balloons' ? (
        allProblems(state).length ? (
          <BalloonMap rooms={selectedRooms} units={units} problems={allProblems(state)} focusProblem={focusProblem} onFocusProblem={setFocusProblem} query={query} />
        ) : (
          <EmptyState title="Nenhuma questão definida" action={<button className="btn btn--primary" onClick={() => go('vjudge')}>Configurar VJudge</button>}>
            Os balões aparecem no mapa depois que as questões do contest forem definidas.
          </EmptyState>
        )
      ) : (
        <>

      {rep.error ? (
        <Notice tone="error">{rep.error}</Notice>
      ) : (
        <div className="report">
          <div className="report__nums">
            <Num v={live.machines} label="computadores = cadeiras disponíveis" />
            <Num v={live.computers} label="computadores em uso" accent="blue" />
            <Num v={live.seats} label="cadeiras ocupadas" accent="purple" />
            <Num v={live.free} label="posições livres" />
            <Num v={rep.gap} label="cadeiras vazias entre unidades" accent="green" />
          </div>
          <div className="report__text">
            <p>
              <b>Como foi calculado:</b> {live.placed} {word[1]} distribuídas proporcionalmente à capacidade de cada laboratório, seguindo as
              bancadas da planta de cada sala.{' '}
              {team &&
                `Cada equipe ocupa uma cadeira por integrante, vizinhas na mesma bancada, e usa só o computador do meio — por isso ${live.seats} cadeiras ocupadas e ${live.computers} computadores em uso. `}
              Tentou-se primeiro {rep.maxGap} cadeira(s) vazia(s) entre {word[1]}; foi adotado <b>{rep.gap}</b>.
            </p>
            {rep.reason && <p className="report__reason">{rep.reason}</p>}
            <div className="report__labs">
              {rep.perLab.map((l) => {
                const room = rooms.find((x) => x.id === l.labId);
                const ps = Object.values(placements).filter((p) => p.labId === l.labId && unitById.has(p.unitId));
                return (
                  <span key={l.labId} className="mono">
                    {room?.name}: {ps.length} {word[1]} · {ps.reduce((a, p) => a + p.seats.length, 0)}/{room ? availableMachines(room) : l.machines} cadeiras
                  </span>
                );
              })}
            </div>
            {alloc.edited && <span className="tag tag--purple">ajustado manualmente</span>}
          </div>
        </div>
      )}

      {(health.invalid.length > 0 || health.unplaced.length > 0) && (
        <div className="tray noprint">
          {health.invalid.length > 0 && (
            <Notice tone="warn">
              <AlertTriangle size={14} /> {health.invalid.length} {health.invalid.length > 1 ? word[1] : word[0]} com lugar inválido após mudanças (laboratório
              desmarcado, computador indisponível, planta do LCC alterada ou equipe modificada). Mova manualmente ou recalcule.
            </Notice>
          )}
          {health.unplaced.length > 0 && (
            <>
              <span className="label">Sem lugar — clique para selecionar e depois clique no computador de destino</span>
              <div className="tray__chips">
                {health.unplaced.map((id) => (
                  <button key={id} className={`chip ${selected === id ? 'is-on' : ''}`} onClick={() => setSelected(selected === id ? null : id)}>
                    {unitById.get(id)?.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {selectedUnit && (
        <div className="movebar noprint" role="status">
          Movendo <b>{selectedUnit.name}</b> — clique em um computador livre para mover ou em outra {word[0]} para trocar.
          {placements[selectedUnit.id] && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                unplace(selectedUnit.id);
                setSelected(null);
              }}
            >
              Retirar do mapa
            </button>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => setSelected(null)}>
            Cancelar (Esc)
          </button>
        </div>
      )}

      <div className="legend-map noprint">
        <span>
          <Monitor size={13} /> computador em uso
        </span>
        <span>
          <Armchair size={13} /> cadeira ocupada (computador desligado/sem uso)
        </span>
        <span className="legend-map__free">livre</span>
        <span className="legend-map__off">indisponível</span>
      </div>

      <div className="rooms">
        {selectedRooms.map((room) => (
          <Plan
            key={room.id}
            room={room}
            placements={Object.values(placements).filter((p) => p.labId === room.id && unitById.has(p.unitId))}
            unitById={unitById}
            unitIndex={unitIndex}
            selected={selected}
            invalid={health.invalid}
            isMatch={match}
            team={team}
            onClick={clickMachine}
          />
        ))}
      </div>

        </>
      )}

      <div className="cta noprint">
        <span className="mono muted">Próximo passo: conectar o contest do VJudge.</span>
        <button className="btn btn--primary btn--lg" onClick={() => go('vjudge')}>
          Configurar VJudge <ArrowRight size={18} />
        </button>
      </div>
    </div>
  );
}

function ScreenTitle({ children }: { children?: ReactNode }) {
  return (
    <div className="screen-title">
      <div>
        <span className="eyebrow mono">// 02 — mapa de sala</span>
        <h1>Quem senta onde</h1>
      </div>
      {children}
    </div>
  );
}

function Num({ v, label, accent }: { v: number; label: string; accent?: 'blue' | 'purple' | 'green' }) {
  return (
    <div className={`num ${accent ? `num--${accent}` : ''}`}>
      <span className="num__v mono">{pad(v)}</span>
      <span className="num__l">{label}</span>
    </div>
  );
}

function Plan({
  room,
  placements,
  unitById,
  unitIndex,
  selected,
  invalid,
  isMatch,
  team,
  onClick,
}: {
  room: Room;
  placements: Placement[];
  unitById: Map<string, Unit>;
  unitIndex: Map<string, number>;
  selected: string | null;
  invalid: string[];
  isMatch: (u: Unit | undefined) => boolean;
  team: boolean;
  onClick: (labId: string, machine: string, occupant?: string) => void;
}) {
  const excluded = new Set(room.excluded);
  const bySeat = new Map<string, { p: Placement; i: number }>();
  placements.forEach((p) => p.seats.forEach((s, i) => bySeat.set(s, { p, i })));
  const seats = placements.reduce((a, p) => a + p.seats.length, 0);
  const avail = availableMachines(room);

  return (
    <section className="room">
      <header className="room__head">
        <h2 className="room__name">{room.name}</h2>
        <span className="mono muted">
          {placements.length} {team ? 'equipes' : 'participantes'} · {placements.length} PCs em uso · {seats}/{avail} cadeiras ocupadas · {avail - seats} livres
        </span>
      </header>
      <div className="plan-wrap">
        <div className="plan" style={{ ['--cols' as string]: room.cols }}>
          {room.cells.map((row, r) => {
            if (row.every((c) => c === null)) return <div key={r} className="plan__aisle" />;
            return (
              <div key={r} className="plan__row">
                {row.map((cell, c) => {
                  if (cell === null) return <span key={c} className="plan__gap" />;
                  if (cell === 'door')
                    return (
                      <span key={c} className="plan__door" title="Porta de acesso">
                        <DoorOpen size={16} />
                        <span className="mono">porta</span>
                      </span>
                    );
                  const id = cell.id;
                  if (excluded.has(id))
                    return (
                      <span key={c} className="pc pc--off" title={`${id} — indisponível nesta competição`}>
                        <span className="pc__id mono">{id}</span>
                      </span>
                    );
                  const occ = bySeat.get(id);
                  if (!occ)
                    return (
                      <button key={c} className={`pc pc--free ${selected ? 'is-target' : ''}`} onClick={() => onClick(room.id, id)} title={`${id} — livre`}>
                        <span className="pc__id mono">{id}</span>
                      </button>
                    );
                  const u = unitById.get(occ.p.unitId);
                  const isPc = occ.p.computer === id;
                  const tint = GROUP_TINTS[(unitIndex.get(occ.p.unitId) ?? 0) % GROUP_TINTS.length];
                  const label = team ? u?.members[occ.i]?.name.split(' ')[0] : u?.name;
                  return (
                    <button
                      key={c}
                      className={`pc pc--taken ${isPc ? 'is-pc' : 'is-chair'} ${selected === occ.p.unitId ? 'is-selected' : ''} ${
                        invalid.includes(occ.p.unitId) ? 'is-invalid' : ''
                      } ${isMatch(u) ? 'is-match' : ''}`}
                      style={{ ['--g' as string]: tint }}
                      onClick={() => onClick(room.id, id, occ.p.unitId)}
                      title={`${id} — ${u?.name}${team ? ` (${u?.members[occ.i]?.name ?? ''})` : ''}${isPc ? ' · computador em uso' : ' · cadeira ocupada'}`}
                    >
                      <span className="pc__id mono">
                        {isPc ? <Monitor size={10} /> : <Armchair size={10} />} {id}
                      </span>
                      <span className="pc__who">{label}</span>
                      {team && isPc && u && <span className="pc__team mono">{u.name} · {u.members.length} pessoas</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
