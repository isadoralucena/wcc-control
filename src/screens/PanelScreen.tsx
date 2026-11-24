import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ClipboardPaste, Filter, MapPin, Palette, RefreshCw, Search, Undo2, X } from 'lucide-react';
import type { Route } from '../App';
import { useStore } from '../state/store';
import { useSync } from '../services/sync';
import { gatewayUrl } from '../services/gateway';
import { useToasts } from '../components/Toasts';
import { useConfirm } from '../components/Confirm';
import { Balloon } from '../components/Balloon';
import { WccLogo } from '../components/WccLogo';
import { EmptyState, contestClock, formatTime, since } from '../components/ui';
import { ProblemEditor, SyncStatus } from './VJudgeScreen';
import {
  balloonQueue,
  cellStatus,
  deliverBalloon,
  markManualSolved,
  overview,
  problemStats,
  removeManualSolved,
  undoDelivery,
} from '../domain/balloons';
import { normalizeName } from '../domain/participants';
import { pad } from '../domain/ids';
import type { AppState, Cell, Problem, Unit } from '../domain/types';

type SortBy = 'list' | 'name' | 'solved' | 'place';

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** Localização legível: sigla real do computador usado (e das cadeiras, em equipes). */
export function locationOf(state: AppState, unitId: string): string | null {
  const p = state.allocation?.placements[unitId];
  if (!p) return null;
  return p.seats.length > 1 ? `${p.computer} · cadeiras ${p.seats[0]}–${p.seats[p.seats.length - 1].split('-').pop()}` : p.computer;
}

export function PanelScreen({ go }: { go: (r: Route) => void }) {
  const { state, commit, units } = useStore();
  const { busy, syncNow, applyPasted } = useSync();
  const { notify } = useToasts();
  const confirm = useConfirm();
  const now = useNow();
  const [query, setQuery] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('list');
  const [focusProblem, setFocusProblem] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ unit: Unit; problem: Problem; x: number; y: number } | null>(null);
  const [showColors, setShowColors] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');

  const v = state.vjudge;
  const ov = useMemo(() => overview(state, units), [state, units]);
  const pstats = useMemo(() => problemStats(state, units), [state, units]);
  const queue = useMemo(() => balloonQueue(state, units), [state, units]);
  const solvedCount = (u: Unit) => state.problems.filter((p) => cellStatus(state.results[u.id]?.[p.index]) !== 'idle').length;

  const rows = useMemo(() => {
    let list = units;
    if (query.trim()) {
      const q = normalizeName(query);
      list = list.filter((u) => normalizeName([u.name, ...u.members.map((m) => m.name), ...u.accounts].join(' ')).includes(q));
    }
    if (onlyPending) list = list.filter((u) => state.problems.some((p) => cellStatus(state.results[u.id]?.[p.index]) === 'solved'));
    const sorted = [...list];
    if (sortBy === 'name') sorted.sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)));
    if (sortBy === 'solved') sorted.sort((a, b) => solvedCount(b) - solvedCount(a));
    if (sortBy === 'place') sorted.sort((a, b) => (locationOf(state, a.id) ?? '~').localeCompare(locationOf(state, b.id) ?? '~', 'pt-BR', { numeric: true }));
    return sorted;
  }, [units, query, onlyPending, sortBy, state]); // eslint-disable-line react-hooks/exhaustive-deps

  const deliver = (unit: Unit, problem: Problem) => {
    commit((s) => deliverBalloon(s, unit.id, problem.index, Date.now()));
    notify({
      kind: 'success',
      title: `Balão ${problem.letter} entregue para ${unit.name}`,
      color: problem.color,
      ttl: 6000,
      action: { label: 'Desfazer', run: () => commit((s) => undoDelivery(s, unit.id, problem.index, Date.now())) },
    });
  };

  const onCell = async (unit: Unit, problem: Problem, cell: Cell | undefined) => {
    const st = cellStatus(cell);
    if (st === 'solved') return deliver(unit, problem);
    if (st === 'delivered') {
      const ok = await confirm({
        title: `Desfazer entrega do balão ${problem.letter}?`,
        body: `${unit.name} voltará para a fila de balões pendentes. O registro do Accepted é mantido.`,
        confirmLabel: 'Desfazer entrega',
      });
      if (ok) commit((s) => undoDelivery(s, unit.id, problem.index, Date.now()));
      return;
    }
    const ok = await confirm({
      title: `Registrar a questão ${problem.letter} como resolvida?`,
      body: (
        <>
          Não há Accepted do VJudge registrado para <b>{unit.name}</b> nesta questão. Use o registro manual apenas se você confirmou o Accepted por
          outro meio. Ele fica marcado como <b>manual</b> e é substituído pelo dado do VJudge quando este chegar.
        </>
      ),
      confirmLabel: 'Registrar manualmente',
    });
    if (ok) commit((s) => markManualSolved(s, unit.id, problem.index, Date.now()));
  };

  if (!units.length)
    return (
      <div className="screen">
        <EmptyState title="Nenhuma participante na arena" action={<button className="btn btn--primary" onClick={() => go('setup')}>Configurar competição</button>}>
          Cadastre participantes{state.mode === 'team' ? ' e forme as equipes' : ''} primeiro.
        </EmptyState>
      </div>
    );
  const clock = contestClock(now, v.begin, v.length);
  const ended = v.begin && v.length ? now > v.begin + v.length : false;
  const visibleQueue = focusProblem === null ? queue : queue.filter((q) => q.problem.index === focusProblem);
  const focus = focusProblem !== null ? state.problems.find((p) => p.index === focusProblem) : undefined;

  return (
    <div className="arena">
      <section className="band">
        <WccLogo size={300} className="band__bgstar" />
        <div className="band__top">
          <div className="band__title">
            <WccLogo size={30} spin={busy} />
            <div>
              <span className="eyebrow mono">// 04 — arena{v.contestId ? ` · vjudge #${v.contestId}` : ''}</span>
              <h1>{v.contestTitle || state.competitionName || 'Competição'}</h1>
            </div>
          </div>
          <div className="band__clock mono" title={v.begin ? `Início: ${new Date(v.begin).toLocaleString('pt-BR')}` : 'Horário atual'}>
            <span className="band__clock-l">{clock ? (ended ? 'encerrado · duração' : 'tempo de prova') : v.begin && now < v.begin ? 'começa às ' + formatTime(v.begin, false) : 'agora'}</span>
            <span className="band__clock-v">{clock ?? formatTime(now)}</span>
          </div>
          <div className="band__sync">
            <SyncStatus v={v} />
            {v.source === 'gateway' ? (
              <>
                {v.autoPoll && <span className="livechip mono">auto · {Math.max(10, v.pollSeconds)}s</span>}
                <button className="btn btn--onDark btn--sm" onClick={() => void syncNow()} disabled={busy || !gatewayUrl(state) || !v.contestId}>
                  <RefreshCw size={14} className={busy ? 'spin' : ''} /> Atualizar
                </button>
              </>
            ) : (
              <button className="btn btn--onDark btn--sm" onClick={() => setPasteOpen((o) => !o)}>
                <ClipboardPaste size={14} /> Colar ranking
              </button>
            )}
          </div>
        </div>

        {pasteOpen && v.source === 'paste' && (
          <div className="band__paste">
            <textarea
              className="mono"
              rows={3}
              autoFocus
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={v.contestId ? `Cole aqui o conteúdo de vjudge.net/contest/rank/single/${v.contestId}` : 'Configure o contest na tela VJudge'}
            />
            <button
              className="btn btn--primary btn--sm"
              disabled={!pasted.trim()}
              onClick={() => {
                try {
                  const n = applyPasted(pasted);
                  notify({ kind: 'success', title: 'Ranking processado', detail: n ? `${n} novo(s) Accepted` : 'Nenhum Accepted novo', ttl: 3000 });
                  setPasted('');
                  setPasteOpen(false);
                } catch (e) {
                  notify({ kind: 'error', title: 'Não foi possível ler o ranking', detail: e instanceof Error ? e.message : undefined });
                }
              }}
            >
              Processar
            </button>
          </div>
        )}

        <div className="stats">
          <Stat v={ov.participants} l="participantes" />
          {state.mode === 'team' && <Stat v={ov.teams} l="equipes" />}
          <Stat v={ov.problems} l="questões" />
          <Stat v={ov.accepted} l="accepted" tone="green" />
          <Stat v={ov.delivered} l="balões entregues" />
          <Stat v={ov.pending} l="balões pendentes" tone={ov.pending ? 'alert' : undefined} />
          <Stat v={ov.waitingUnits} l={state.mode === 'team' ? 'equipes aguardando' : 'aguardando balão'} tone={ov.waitingUnits ? 'alert' : undefined} />
        </div>
      </section>

      {!state.problems.length ? (
        <EmptyState title="Defina as questões do contest" action={<button className="btn btn--primary" onClick={() => go('vjudge')}>Configurar VJudge</button>}>
          {v.contestAccess === 'restricted'
            ? 'O contest é privado e o gateway ainda não tem acesso, então as questões não puderam ser importadas. Informe a quantidade na tela VJudge ou dê acesso ao gateway.'
            : 'A grade usa a quantidade de questões do contest. Com o gateway configurado elas são importadas automaticamente; também é possível informar manualmente.'}
        </EmptyState>
      ) : (
      <div className="arena__body">
        <section className="board">
          <div className="board__tools">
            <label className="search">
              <Search size={14} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar nome, equipe ou username" />
              {query && (
                <button onClick={() => setQuery('')} aria-label="Limpar busca">
                  <X size={12} />
                </button>
              )}
            </label>
            <label className={`toggle ${onlyPending ? 'is-on' : ''}`}>
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              <Filter size={14} /> só com balão pendente
            </label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} aria-label="Ordenar">
              <option value="list">ordem do cadastro</option>
              <option value="name">nome</option>
              <option value="solved">mais resolvidas</option>
              <option value="place">localização</option>
            </select>
            <button className={`btn btn--ghost btn--sm ${showColors ? 'is-on' : ''}`} onClick={() => setShowColors((s) => !s)}>
              <Palette size={14} /> Cores dos balões
            </button>
            <span className="legend">
              <span className="dot dot--idle" /> não resolvida <span className="dot dot--solved" /> accepted · aguardando <span className="dot dot--delivered" /> balão entregue
            </span>
          </div>
          {showColors && (
            <div className="board__colors">
              <ProblemEditor compact />
            </div>
          )}

          <div className="sheet-wrap">
            <table className="sheet">
              <thead>
                <tr>
                  <th className="sheet__corner">
                    <span className="mono">{rows.length}</span> {state.mode === 'team' ? 'equipes' : 'participantes'}
                  </th>
                  {state.problems.map((p) => {
                    const ps = pstats.find((x) => x.index === p.index)!;
                    return (
                      <th key={p.index} className={`sheet__ph ${focusProblem === p.index ? 'is-focus' : ''}`}>
                        <button
                          onClick={() => setFocusProblem(focusProblem === p.index ? null : p.index)}
                          title={`${p.title ? p.title + ' — ' : ''}clique para ver quem aguarda o balão ${p.letter}`}
                        >
                          <Balloon color={p.color} size={22} />
                          <span className="sheet__letter mono">{p.letter}</span>
                          <span className="sheet__pcount mono">
                            {ps.solved}
                            {ps.pending > 0 && <em>·{ps.pending}</em>}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                  <th className="sheet__sum mono">Σ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const loc = locationOf(state, u.id);
                  return (
                    <tr key={u.id}>
                      <th className="sheet__who" scope="row">
                        <div className="sheet__whobox">
                        <span className="sheet__name">{u.name}</span>
                        <span className="sheet__meta mono">
                          {u.accounts.length ? u.accounts.map((a) => `@${a}`).join(' ') : <span className="warn-text">sem conta vjudge</span>}
                        </span>
                        {state.mode === 'team' && <span className="sheet__meta">{u.members.map((m) => m.name.split(' ')[0]).join(' · ')}</span>}
                        {loc && (
                          <span className="sheet__loc mono">
                            <MapPin size={10} /> {loc}
                          </span>
                        )}
                        </div>
                      </th>
                      {state.problems.map((p) => {
                        const cell = state.results[u.id]?.[p.index];
                        const st = cellStatus(cell);
                        const fresh = st === 'solved' && cell?.detectedAt && now - cell.detectedAt < 90_000;
                        const first = pstats.find((x) => x.index === p.index)?.firstUnitId === u.id;
                        return (
                          <td key={p.index} className={focusProblem === p.index ? 'is-focus' : ''}>
                            <button
                              className={`cell cell--${st} ${fresh ? 'is-fresh' : ''}`}
                              style={{ ['--c' as string]: p.color }}
                              onClick={() => void onCell(u, p, cell)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setMenu({ unit: u, problem: p, x: e.clientX, y: e.clientY });
                              }}
                              title={cellTitle(u, p, cell)}
                              aria-label={cellTitle(u, p, cell)}
                            >
                              {st === 'idle' && <span className="cell__dot" />}
                              {st === 'solved' && <Balloon color={p.color} size={20} className="cell__balloon" />}
                              {st === 'delivered' && <Check size={16} strokeWidth={3} />}
                              {first && <span className="cell__first" title="Primeira a resolver">1º</span>}
                              {cell?.solvedSource === 'manual' && <span className="cell__manual">m</span>}
                            </button>
                          </td>
                        );
                      })}
                      <td className="sheet__sum mono">{solvedCount(u)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <div className="sheet__none muted">Nenhuma linha corresponde aos filtros.</div>}
          </div>
          <p className="hint muted">
            Clique ou toque em uma célula <b>verde</b> para registrar a entrega do balão; em uma <b>preta</b> para desfazer. Botão direito (ou
            toque longo) mostra detalhes e opções.
          </p>
        </section>

        <aside className="queue">
          <header className="queue__head">
            <h2>
              Fila de balões <span className="mono queue__count">{pad(visibleQueue.length)}</span>
            </h2>
            {focus && (
              <button className="chip is-on" onClick={() => setFocusProblem(null)} style={{ ['--c' as string]: focus.color }}>
                questão {focus.letter} <X size={12} />
              </button>
            )}
          </header>
          {visibleQueue.length === 0 ? (
            <div className="queue__empty">
              <WccLogo size={40} className="is-muted" />
              <span>{focus ? `Nenhum balão ${focus.letter} pendente.` : 'Nenhum balão pendente.'}</span>
            </div>
          ) : (
            <ol className="queue__list">
              {visibleQueue.map((q) => {
                const loc = locationOf(state, q.unit.id);
                const at = q.cell.solvedAt ?? q.cell.detectedAt ?? now;
                const late = now - (q.cell.detectedAt ?? at) > 10 * 60_000;
                return (
                  <li key={`${q.unit.id}:${q.problem.index}`} className={`qitem ${late ? 'is-late' : ''}`} style={{ ['--c' as string]: q.problem.color }}>
                    <Balloon color={q.problem.color} size={34} />
                    <div className="qitem__body">
                      <div className="qitem__top">
                        <span className="qitem__letter mono">{q.problem.letter}</span>
                        <span className="qitem__name">{q.unit.name}</span>
                      </div>
                      <div className="qitem__meta mono">
                        {loc ?? 'sem posição no mapa'} · há {since(q.cell.detectedAt ?? at, now)}
                      </div>
                    </div>
                    <button className="btn btn--deliver btn--sm" onClick={() => deliver(q.unit, q.problem)}>
                      Entregue
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="timeline">
            <h3 className="label">Linha do tempo</h3>
            {state.log.length === 0 ? (
              <span className="muted">Os eventos da competição aparecerão aqui.</span>
            ) : (
              <ol>
                {state.log.slice(0, 40).map((e) => (
                  <li key={e.id} className={`tl tl--${e.kind}`}>
                    <span className="mono tl__t">{formatTime(e.at, false)}</span>
                    <span>{e.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
      )}

      {menu && (
        <CellMenu
          {...menu}
          cell={state.results[menu.unit.id]?.[menu.problem.index]}
          loc={locationOf(state, menu.unit.id)}
          onClose={() => setMenu(null)}
          onDeliver={() => deliver(menu.unit, menu.problem)}
          onUndo={() => commit((s) => undoDelivery(s, menu.unit.id, menu.problem.index, Date.now()))}
          onManual={() => commit((s) => markManualSolved(s, menu.unit.id, menu.problem.index, Date.now()))}
          onRemoveManual={() => commit((s) => removeManualSolved(s, menu.unit.id, menu.problem.index, Date.now()))}
        />
      )}
    </div>
  );
}

function cellTitle(u: Unit, p: Problem, cell: Cell | undefined): string {
  const st = cellStatus(cell);
  if (st === 'idle') return `${u.name} · ${p.letter}: não resolvida`;
  const src = cell?.solvedSource === 'manual' ? 'registro manual' : `accepted ${formatTime(cell?.solvedAt)}${cell?.account ? ` (${cell.account})` : ''}`;
  if (st === 'solved') return `${u.name} · ${p.letter}: ${src} — aguardando balão`;
  return `${u.name} · ${p.letter}: ${src} — balão entregue ${formatTime(cell?.deliveredAt)}`;
}

function Stat({ v, l, tone }: { v: number; l: string; tone?: 'green' | 'alert' }) {
  return (
    <div className={`stat ${tone ? `stat--${tone}` : ''}`}>
      <span className="stat__v mono" key={v}>
        {pad(v)}
      </span>
      <span className="stat__l">{l}</span>
    </div>
  );
}

function CellMenu({
  unit,
  problem,
  cell,
  loc,
  x,
  y,
  onClose,
  onDeliver,
  onUndo,
  onManual,
  onRemoveManual,
}: {
  unit: Unit;
  problem: Problem;
  cell: Cell | undefined;
  loc: string | null;
  x: number;
  y: number;
  onClose: () => void;
  onDeliver: () => void;
  onUndo: () => void;
  onManual: () => void;
  onRemoveManual: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const st = cellStatus(cell);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 300);
  const top = Math.min(y, window.innerHeight - 280);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div className="cellmenu" ref={ref} style={{ left, top }} role="dialog" aria-label="Detalhes da célula">
      <div className="cellmenu__head" style={{ ['--c' as string]: problem.color }}>
        <Balloon color={problem.color} size={28} />
        <div>
          <b>
            {problem.letter}
            {problem.title ? ` — ${problem.title}` : ''}
          </b>
          <div className="muted">{unit.name}</div>
        </div>
      </div>
      <dl className="cellmenu__facts mono">
        <dt>accepted</dt>
        <dd>{cell?.solvedAt ? `${formatTime(cell.solvedAt)} · ${cell.solvedSource === 'manual' ? 'manual' : 'vjudge'}` : '—'}</dd>
        {cell?.account && (
          <>
            <dt>conta</dt>
            <dd>{cell.account}</dd>
          </>
        )}
        <dt>detectado</dt>
        <dd>{formatTime(cell?.detectedAt)}</dd>
        <dt>balão</dt>
        <dd>{cell?.deliveredAt ? `entregue ${formatTime(cell.deliveredAt)}` : st === 'solved' ? 'pendente' : '—'}</dd>
        <dt>local</dt>
        <dd>{loc ?? '—'}</dd>
      </dl>
      <div className="cellmenu__actions">
        {st === 'solved' && (
          <button className="btn btn--deliver btn--sm" onClick={act(onDeliver)}>
            <Check size={14} /> Marcar balão entregue
          </button>
        )}
        {st === 'delivered' && (
          <button className="btn btn--ghost btn--sm" onClick={act(onUndo)}>
            <Undo2 size={14} /> Desfazer entrega
          </button>
        )}
        {st === 'idle' && (
          <button className="btn btn--ghost btn--sm" onClick={act(onManual)}>
            Registrar accepted manual
          </button>
        )}
        {st === 'solved' && cell?.solvedSource === 'manual' && (
          <button className="btn btn--ghost btn--sm" onClick={act(onRemoveManual)}>
            Remover registro manual
          </button>
        )}
      </div>
    </div>
  );
}
