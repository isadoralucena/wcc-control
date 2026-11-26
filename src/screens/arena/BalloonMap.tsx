/**
 * Mapa de sala com os balões de cada computador.
 *
 * Na planta real, o computador usado por cada participante/equipe mostra:
 * - os balões PENDENTES (coloridos; clique para registrar a entrega);
 * - os balões já ENTREGUES (marcas pequenas na cor da questão);
 * - a posição na classificação e o total de questões resolvidas.
 * "Rota de entrega": escolher uma questão destaca só os computadores que
 * esperam aquele balão, para quem está levando os balões de uma cor.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Armchair, Check, DoorOpen, MapPin, Monitor, Undo2, X } from 'lucide-react';
import { useStore } from '../../state/store';
import { Balloon } from '../../components/Balloon';
import { formatTime, since } from '../../components/ui';
import { cellStatus, problemStats } from '../../domain/balloons';
import { standings, type Standing } from '../../domain/contests';
import type { Placement, Problem, Room, Unit } from '../../domain/types';
import { useBalloonActions } from './useBalloonActions';

const GROUP_TINTS = ['#7B68E5', '#1E88FD', '#1b9e63', '#d9822b', '#c2459a', '#2a9d9a'];
const MAX_BALLOONS = 6;

interface UnitBalloons {
  pending: Problem[];
  delivered: Problem[];
  standing?: Standing;
}

export function BalloonMap({
  rooms,
  units,
  problems,
  focusProblem,
  onFocusProblem,
  highlightUnit,
  query = '',
  showFilter = true,
}: {
  rooms: Room[];
  units: Unit[];
  problems: Problem[];
  focusProblem: string | null;
  onFocusProblem: (key: string | null) => void;
  highlightUnit?: string | null;
  query?: string;
  showFilter?: boolean;
}) {
  const { state, units: allUnits } = useStore();
  const { deliver, label } = useBalloonActions();
  const [open, setOpen] = useState<{ unitId: string; x: number; y: number } | null>(null);
  const placements = state.allocation?.placements ?? {};
  const unitById = useMemo(() => new Map(allUnits.map((u) => [u.id, u])), [allUnits]);
  const unitIndex = useMemo(() => new Map(allUnits.map((u, i) => [u.id, i])), [allUnits]);
  const inScope = useMemo(() => new Set(units.map((u) => u.id)), [units]);
  const stand = useMemo(() => standings(state, units, problems), [state, units, problems]);
  const pstats = useMemo(() => problemStats(state, units, problems), [state, units, problems]);

  const balloons = useMemo(() => {
    const m = new Map<string, UnitBalloons>();
    for (const u of units) {
      const row = state.results[u.id] ?? {};
      const pending = problems.filter((p) => cellStatus(row[p.key]) === 'solved').sort((a, b) => (row[a.key]!.solvedAt ?? 0) - (row[b.key]!.solvedAt ?? 0));
      const delivered = problems.filter((p) => cellStatus(row[p.key]) === 'delivered');
      m.set(u.id, { pending, delivered, standing: stand.get(u.id) });
    }
    return m;
  }, [state.results, units, problems, stand]);

  const q = query.trim().toLowerCase();
  const matches = (u: Unit | undefined) => !!u && !!q && [u.name, ...u.members.map((x) => x.name), ...u.accounts].join(' ').toLowerCase().includes(q);
  const placed = Object.values(placements).filter((p) => inScope.has(p.unitId));
  const notPlaced = units.filter((u) => !placements[u.id] && (balloons.get(u.id)?.pending.length ?? 0) > 0);
  const focus = focusProblem ? problems.find((p) => p.key === focusProblem) : undefined;

  return (
    <div className="bmap">
      {showFilter && problems.length > 0 && (
        <div className="bmap__route" role="group" aria-label="Rota de entrega">
          <span className="label">Rota de entrega</span>
          <button className={`chip ${focusProblem === null ? 'is-on' : ''}`} onClick={() => onFocusProblem(null)}>
            todos
          </button>
          {problems.map((p) => {
            const ps = pstats.find((x) => x.key === p.key);
            return (
              <button
                key={p.key}
                className={`chip chip--balloon ${focusProblem === p.key ? 'is-on' : ''}`}
                style={{ ['--c' as string]: p.color }}
                onClick={() => onFocusProblem(focusProblem === p.key ? null : p.key)}
                title={`Destacar os computadores que esperam o balão ${label(p)}`}
              >
                <Balloon color={p.color} size={16} />
                <span className="mono">{label(p)}</span>
                {ps && ps.pending > 0 && <em className="mono">{ps.pending}</em>}
              </button>
            );
          })}
        </div>
      )}

      <div className="legend-map">
        <span>
          <Balloon color="var(--green)" size={14} /> balão pendente — clique para entregar
        </span>
        <span>
          <span className="bdone" style={{ ['--c' as string]: 'var(--ink-2)' }} /> balão entregue
        </span>
        <span>
          <Monitor size={13} /> computador usado
        </span>
        <span>
          <Armchair size={13} /> cadeira da equipe
        </span>
      </div>

      {notPlaced.length > 0 && (
        <div className="notice notice--warn">
          Sem lugar no mapa e com balão pendente: {notPlaced.map((u) => u.name).join(', ')}. Ajuste a alocação na tela Mapa de sala.
        </div>
      )}

      <div className="rooms">
        {rooms.map((room) => {
          const ps = placed.filter((p) => p.labId === room.id && unitById.has(p.unitId));
          const pendingHere = ps.reduce((a, p) => a + (balloons.get(p.unitId)?.pending.filter((x) => !focus || x.key === focus.key).length ?? 0), 0);
          return (
            <section key={room.id} className="room">
              <header className="room__head">
                <h2 className="room__name">{room.name}</h2>
                <span className={`mono ${pendingHere ? 'room__pending' : 'muted'}`}>
                  {pendingHere ? `${pendingHere} ${pendingHere === 1 ? 'balão pendente' : 'balões pendentes'}${focus ? ` (${label(focus)})` : ''}` : 'nenhum balão pendente'}
                </span>
              </header>
              <BalloonPlan
                room={room}
                placements={ps}
                unitById={unitById}
                unitIndex={unitIndex}
                balloons={balloons}
                focus={focus}
                highlightUnit={highlightUnit ?? null}
                isMatch={matches}
                label={label}
                onDeliver={deliver}
                onOpen={(unitId, x, y) => setOpen({ unitId, x, y })}
              />
            </section>
          );
        })}
      </div>

      {open && unitById.get(open.unitId) && (
        <UnitPopover
          unit={unitById.get(open.unitId)!}
          placement={placements[open.unitId]}
          problems={problems}
          standing={stand.get(open.unitId)}
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function BalloonPlan({
  room,
  placements,
  unitById,
  unitIndex,
  balloons,
  focus,
  highlightUnit,
  isMatch,
  label,
  onDeliver,
  onOpen,
}: {
  room: Room;
  placements: Placement[];
  unitById: Map<string, Unit>;
  unitIndex: Map<string, number>;
  balloons: Map<string, UnitBalloons>;
  focus: Problem | undefined;
  highlightUnit: string | null;
  isMatch: (u: Unit | undefined) => boolean;
  label: (p: Problem) => string;
  onDeliver: (u: Unit, p: Problem) => void;
  onOpen: (unitId: string, x: number, y: number) => void;
}) {
  const excluded = new Set(room.excluded);
  const bySeat = new Map<string, { p: Placement; i: number }>();
  placements.forEach((p) => p.seats.forEach((s, i) => bySeat.set(s, { p, i })));

  return (
    <div className="plan-wrap">
      <div className="plan plan--balloons" style={{ ['--cols' as string]: room.cols }}>
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
                const occ = bySeat.get(id);
                if (!occ || excluded.has(id))
                  return (
                    <span key={c} className={`bpc bpc--empty ${excluded.has(id) ? 'is-off' : ''}`} title={`${id} — ${excluded.has(id) ? 'indisponível' : 'livre'}`}>
                      <span className="pc__id mono">{id}</span>
                    </span>
                  );
                const u = unitById.get(occ.p.unitId);
                const tint = GROUP_TINTS[(unitIndex.get(occ.p.unitId) ?? 0) % GROUP_TINTS.length];
                const b = balloons.get(occ.p.unitId);
                const pending = b?.pending ?? [];
                const waitingFocus = focus ? pending.some((p) => p.key === focus.key) : pending.length > 0;
                const dim = focus ? !waitingFocus : false;
                const classes = `${waitingFocus ? 'has-pending' : ''} ${dim ? 'is-dim' : ''} ${highlightUnit === occ.p.unitId || isMatch(u) ? 'is-match' : ''}`;
                if (occ.p.computer !== id)
                  return (
                    <span
                      key={c}
                      className={`bpc bpc--chair ${classes}`}
                      style={{ ['--g' as string]: tint }}
                      title={`${id} — cadeira de ${u?.members[occ.i]?.name ?? u?.name} (${u?.name})`}
                    >
                      <span className="pc__id mono">
                        <Armchair size={10} /> {id}
                      </span>
                      <span className="pc__who">{u?.members[occ.i]?.name.split(' ')[0] ?? ''}</span>
                    </span>
                  );
                const shown = focus ? pending.filter((p) => p.key === focus.key) : pending;
                return (
                  <div key={c} className={`bpc bpc--pc ${classes}`} style={{ ['--g' as string]: tint }}>
                    <button
                      className="bpc__head"
                      onClick={(e) => onOpen(occ.p.unitId, e.clientX, e.clientY)}
                      title={`${id} — ${u?.name}: ver questões e balões`}
                    >
                      <span className="pc__id mono">
                        <Monitor size={10} /> {id}
                      </span>
                      <span className="pc__who">{u?.name}</span>
                    </button>
                    {shown.length > 0 && (
                      <div className="bpc__balloons">
                        {shown.slice(0, MAX_BALLOONS).map((p) => (
                          <button
                            key={p.key}
                            className="bpc__balloon"
                            style={{ ['--c' as string]: p.color }}
                            onClick={() => u && onDeliver(u, p)}
                            title={`Entregar balão ${label(p)} para ${u?.name} (${id})`}
                            aria-label={`Entregar balão ${label(p)} para ${u?.name}`}
                          >
                            <Balloon color={p.color} size={22} />
                            <span className="mono">{label(p)}</span>
                          </button>
                        ))}
                        {shown.length > MAX_BALLOONS && <span className="bpc__more mono">+{shown.length - MAX_BALLOONS}</span>}
                      </div>
                    )}
                    <div className="bpc__foot">
                      {(b?.delivered ?? []).map((p) => (
                        <span key={p.key} className="bdone" style={{ ['--c' as string]: p.color }} title={`Balão ${label(p)} entregue`} />
                      ))}
                      {b?.standing && b.standing.solved > 0 && (
                        <span className="bpc__rank mono" title={`${b.standing.position}º lugar · ${b.standing.solved} resolvidas`}>
                          {b.standing.position}º · {b.standing.solved}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Detalhes de uma unidade a partir do mapa: todas as questões, com entrega e desfazer. */
function UnitPopover({
  unit,
  placement,
  problems,
  standing,
  x,
  y,
  onClose,
}: {
  unit: Unit;
  placement?: Placement;
  problems: Problem[];
  standing?: Standing;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { state } = useStore();
  const { deliver, askUndo, askManual, label } = useBalloonActions();
  const ref = useRef<HTMLDivElement>(null);
  const now = Date.now();
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.modal-backdrop') && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const width = Math.min(320, window.innerWidth - 24);
  const left = Math.max(12, Math.min(x, window.innerWidth - width - 12));
  const top = Math.max(8, Math.min(y, window.innerHeight - 420));
  const row = state.results[unit.id] ?? {};
  return (
    <div className="cellmenu unitpop" ref={ref} style={{ left, top, width }} role="dialog" aria-label={`Balões de ${unit.name}`}>
      <div className="unitpop__head">
        <div>
          <b>{unit.name}</b>
          <div className="muted mono unitpop__loc">
            <MapPin size={11} /> {placement ? (placement.seats.length > 1 ? `${placement.computer} · cadeiras ${placement.seats.join(', ')}` : placement.computer) : 'sem lugar'}
          </div>
          {unit.members.length > 1 && <div className="muted unitpop__members">{unit.members.map((m) => m.name).join(' · ')}</div>}
        </div>
        <button className="iconbtn" onClick={onClose} aria-label="Fechar">
          <X size={16} />
        </button>
      </div>
      {standing && (
        <div className="unitpop__stand mono">
          {standing.position}º lugar · {standing.solved} {standing.solved === 1 ? 'resolvida' : 'resolvidas'}
        </div>
      )}
      <ul className="unitpop__list">
        {problems.map((p) => {
          const cell = row[p.key];
          const st = cellStatus(cell);
          return (
            <li key={p.key} className={`unitpop__item is-${st}`}>
              <Balloon color={p.color} size={20} muted={st === 'idle'} />
              <span className="mono unitpop__lbl">{label(p)}</span>
              <span className="unitpop__st">
                {st === 'idle' && 'não resolvida'}
                {st === 'solved' && `aguardando · há ${since(cell!.detectedAt ?? cell!.solvedAt!, now)}`}
                {st === 'delivered' && `entregue ${formatTime(cell!.deliveredAt, false)}`}
                {cell?.solvedSource === 'manual' && ' · manual'}
              </span>
              {st === 'solved' && (
                <button className="btn btn--deliver btn--sm" onClick={() => deliver(unit, p)}>
                  <Check size={13} /> Entregue
                </button>
              )}
              {st === 'delivered' && (
                <button className="btn btn--ghost btn--sm" onClick={() => void askUndo(unit, p)} title="Desfazer entrega">
                  <Undo2 size={13} />
                </button>
              )}
              {st === 'idle' && (
                <button className="btn btn--ghost btn--sm" onClick={() => void askManual(unit, p)} title="Registrar Accepted manual">
                  manual
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
