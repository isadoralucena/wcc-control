import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ClipboardPaste, Filter, LayoutGrid, Map as MapIcon, MapPin, Palette, RefreshCw, Search, Undo2, X } from 'lucide-react';
import type { Route } from '../App';
import { useStore } from '../state/store';
import { useSync } from '../services/sync';
import { gatewayUrl } from '../services/gateway';
import { useToasts } from '../components/Toasts';
import { Balloon } from '../components/Balloon';
import { WccLogo } from '../components/WccLogo';
import { EmptyState, Segmented, contestClock, formatTime, since, useNow } from '../components/ui';
import { ProblemEditor, SyncStatus } from './VJudgeScreen';
import { BalloonMap } from './arena/BalloonMap';
import { useBalloonActions } from './arena/useBalloonActions';
import { balloonQueue, cellStatus, overview, problemStats } from '../domain/balloons';
import { allProblems, contestName, findContest, standings, unitsInContest } from '../domain/contests';
import { roomsOf } from '../state/selectors';
import { normalizeName } from '../domain/participants';
import { pad } from '../domain/ids';
import type { AppState, Cell, Contest, Problem, Unit } from '../domain/types';

type SortBy = 'list' | 'name' | 'rank' | 'place';
type View = 'grid' | 'map';

const VIEW_KEY = 'wcc-control:arena-view';
function loadView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'map' ? 'map' : 'grid';
  } catch {
    return 'grid';
  }
}
function saveView(v: View) {
  try {
    window.localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* preferência só deste navegador; sem armazenamento, apenas não é lembrada */
  }
}


/** Localização legível: sigla real do computador usado (e das cadeiras, em equipes). */
export function locationOf(state: AppState, unitId: string): string | null {
  const p = state.allocation?.placements[unitId];
  if (!p) return null;
  return p.seats.length > 1 ? `${p.computer} · cadeiras ${p.seats[0]}–${p.seats[p.seats.length - 1].split('-').pop()}` : p.computer;
}

export function PanelScreen({ go }: { go: (r: Route) => void }) {
  const { state, units } = useStore();
  const { busy, syncNow, applyPasted } = useSync();
  const { notify } = useToasts();
  const actions = useBalloonActions();
  const now = useNow();
  const [query, setQuery] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('list');
  const [focusProblem, setFocusProblem] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ unit: Unit; problem: Problem; x: number; y: number } | null>(null);
  const [showColors, setShowColors] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [view, setViewState] = useState<View>(loadView);
  const [scope, setScope] = useState<string>('all');
  const [highlight, setHighlight] = useState<string | null>(null);
  const setView = (v: View) => {
    setViewState(v);
    saveView(v);
  };

  const contests = state.contests;
  const multi = contests.length > 1;
  const scopeContest = scope !== 'all' ? findContest(state, scope) : undefined;
  useEffect(() => {
    if (scope !== 'all' && !scopeContest) setScope('all');
  }, [scope, scopeContest]);

  const problems = useMemo(() => (scopeContest ? scopeContest.problems : allProblems(state)), [state.contests, scopeContest]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeUnits = useMemo(() => (scopeContest ? unitsInContest(state, scopeContest, units) : units), [state, scopeContest, units]);
  const ov = useMemo(() => overview(state, scopeUnits, problems), [state, scopeUnits, problems]);
  const pstats = useMemo(() => problemStats(state, scopeUnits, problems), [state, scopeUnits, problems]);
  const queue = useMemo(() => balloonQueue(state, scopeUnits, problems), [state, scopeUnits, problems]);
  const stand = useMemo(() => standings(state, scopeUnits, problems), [state, scopeUnits, problems]);
  const rooms = useMemo(() => roomsOf(state).filter((r) => r.selected), [state.labCatalog, state.labSelection, state.customLabs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focusProblem && !problems.some((p) => p.key === focusProblem)) setFocusProblem(null);
  }, [focusProblem, problems]);
  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 6000);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const rows = useMemo(() => {
    let list = scopeUnits;
    if (query.trim()) {
      const q = normalizeName(query);
      list = list.filter((u) => normalizeName([u.name, ...u.members.map((m) => m.name), ...u.accounts].join(' ')).includes(q));
    }
    if (onlyPending) list = list.filter((u) => problems.some((p) => cellStatus(state.results[u.id]?.[p.key]) === 'solved'));
    const sorted = [...list];
    if (sortBy === 'name') sorted.sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)));
    if (sortBy === 'rank') sorted.sort((a, b) => (stand.get(a.id)?.position ?? 1e9) - (stand.get(b.id)?.position ?? 1e9));
    if (sortBy === 'place') sorted.sort((a, b) => (locationOf(state, a.id) ?? '~').localeCompare(locationOf(state, b.id) ?? '~', 'pt-BR', { numeric: true }));
    return sorted;
  }, [scopeUnits, query, onlyPending, sortBy, state, problems, stand]);

  if (!units.length)
    return (
      <div className="screen">
        <EmptyState title="Nenhuma participante na arena" action={<button className="btn btn--primary" onClick={() => go('setup')}>Configurar competição</button>}>
          Cadastre participantes{state.mode === 'team' ? ' e forme as equipes' : ''} primeiro.
        </EmptyState>
      </div>
    );

  const v = state.vjudge;
  const primary = scopeContest ?? (multi ? contests.find((c) => c.begin) : contests[0]) ?? contests[0];
  const clock = contestClock(now, primary.begin, primary.length);
  const ended = primary.begin && primary.length ? now > primary.begin + primary.length : false;
  const visibleQueue = focusProblem === null ? queue : queue.filter((q) => q.problem.key === focusProblem);
  const focus = focusProblem !== null ? problems.find((p) => p.key === focusProblem) : undefined;
  const hasLinks = contests.some((c) => c.contestId);
  const title = scopeContest ? contestName(scopeContest) : multi ? state.competitionName || 'Competição' : contests[0].contestTitle || state.competitionName || 'Competição';
  const firstOfContest = new Set(contests.map((c) => c.problems[0]?.key).filter(Boolean));
  const colorContests = scopeContest ? [scopeContest] : contests.filter((c) => c.problems.length);

  const showOnMap = (unitId: string) => {
    setView('map');
    setHighlight(unitId);
  };

  return (
    <div className="arena">
      <section className="band">
        <WccLogo size={300} className="band__bgstar" />
        <div className="band__top">
          <div className="band__title">
            <WccLogo size={30} spin={busy} />
            <div>
              <span className="eyebrow mono">
                // 04 — arena
                {multi ? ` · ${contests.length} contests` : contests[0].contestId ? ` · vjudge #${contests[0].contestId}` : ''}
              </span>
              <h1>{title}</h1>
            </div>
          </div>
          <div className="band__clock mono" title={primary.begin ? `Início: ${new Date(primary.begin).toLocaleString('pt-BR')}` : 'Horário atual'}>
            <span className="band__clock-l">
              {multi && primary.begin && !scopeContest ? `${primary.tag} · ` : ''}
              {clock ? (ended ? 'encerrado · duração' : 'tempo de prova') : primary.begin && now < primary.begin ? 'começa às ' + formatTime(primary.begin, false) : 'agora'}
            </span>
            <span className="band__clock-v">{clock ? <Ticking text={clock} live={!ended} /> : formatTime(now)}</span>
          </div>
          <div className="band__sync">
            {multi && !scopeContest ? <SyncSummary contests={contests} /> : <SyncStatus c={primary} />}
            {v.source === 'gateway' ? (
              <>
                {v.autoPoll && <span className="livechip mono">auto · {Math.max(10, v.pollSeconds)}s</span>}
                <button
                  className="btn btn--onDark btn--sm"
                  onClick={() => void syncNow({ contestKey: scopeContest?.key })}
                  disabled={busy || !gatewayUrl(state) || !hasLinks}
                >
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

        {multi && (
          <div className="ctabs" role="tablist" aria-label="Contests">
            <button role="tab" aria-selected={scope === 'all'} className={`ctab ${scope === 'all' ? 'is-on' : ''}`} onClick={() => setScope('all')}>
              <span className="ctab__tag mono">todos</span>
              <span className="ctab__name">{contests.length} contests</span>
            </button>
            {contests.map((c) => {
              const pending = balloonQueue(state, unitsInContest(state, c, units), c.problems).length;
              const ck = contestClock(now, c.begin, c.length);
              return (
                <button key={c.key} role="tab" aria-selected={scope === c.key} className={`ctab ${scope === c.key ? 'is-on' : ''}`} onClick={() => setScope(c.key)}>
                  <span className={`ctab__dot is-${c.lastSyncOk === false ? 'bad' : c.warning ? 'warn' : c.lastSyncAt ? 'ok' : 'idle'}`} />
                  <span className="ctab__tag mono">{c.tag}</span>
                  <span className="ctab__name">{contestName(c)}</span>
                  {ck && <span className="ctab__clock mono">{ck}</span>}
                  {pending > 0 && <span className="ctab__pending mono">{pending}</span>}
                </button>
              );
            })}
          </div>
        )}

        {pasteOpen && v.source === 'paste' && (
          <div className="band__paste">
            <textarea
              className="mono"
              rows={3}
              autoFocus
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={
                primary.contestId ? `Cole aqui o conteúdo de vjudge.net/contest/rank/single/${primary.contestId}` : 'Configure o contest na tela VJudge'
              }
            />
            <button
              className="btn btn--primary btn--sm"
              disabled={!pasted.trim()}
              onClick={() => {
                try {
                  const n = applyPasted(pasted, scopeContest?.key);
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
          <Stat v={scopeUnits.length} l={state.mode === 'team' ? 'equipes' : 'participantes'} />
          <Stat v={ov.problems} l="questões" />
          <Stat v={ov.accepted} l="accepted" tone="green" />
          <Stat v={ov.delivered} l="balões entregues" />
          <Stat v={ov.pending} l="balões pendentes" tone={ov.pending ? 'alert' : undefined} />
          <Stat v={ov.waitingUnits} l={state.mode === 'team' ? 'equipes aguardando' : 'aguardando balão'} tone={ov.waitingUnits ? 'alert' : undefined} />
        </div>
        {ov.accepted > 0 && (
          <div className="deliverybar" title="Balões entregues em relação aos Accepted registrados">
            <span className="deliverybar__l mono">entregas</span>
            <span className="deliverybar__track">
              <span style={{ width: `${(ov.delivered / ov.accepted) * 100}%` }} />
            </span>
            <span className="deliverybar__v mono">
              {ov.delivered}/{ov.accepted} · {Math.round((ov.delivered / ov.accepted) * 100)}%
            </span>
          </div>
        )}
      </section>

      {!problems.length ? (
        <EmptyState title="Defina as questões do contest" action={<button className="btn btn--primary" onClick={() => go('vjudge')}>Configurar VJudge</button>}>
          {(scopeContest ?? contests[0]).contestAccess === 'restricted'
            ? 'O contest é privado e o gateway ainda não tem acesso, então as questões não puderam ser importadas. Informe a quantidade na tela VJudge ou dê acesso ao gateway.'
            : 'A grade usa a quantidade de questões do contest. Com o gateway configurado elas são importadas automaticamente; também é possível informar manualmente.'}
        </EmptyState>
      ) : (
        <div className="arena__body">
          <section className="board">
            <div className="board__tools">
              <Segmented<View>
                label="Visualização"
                value={view}
                onChange={setView}
                options={[
                  { value: 'grid', label: <><LayoutGrid size={14} /> Grade</> },
                  { value: 'map', label: <><MapIcon size={14} /> Mapa</>, hint: 'Balões por computador na planta da sala' },
                ]}
              />
              <label className="search">
                <Search size={14} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar nome, equipe ou username" />
                {query && (
                  <button onClick={() => setQuery('')} aria-label="Limpar busca">
                    <X size={12} />
                  </button>
                )}
              </label>
              {view === 'grid' && (
                <>
                  <label className={`toggle ${onlyPending ? 'is-on' : ''}`}>
                    <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
                    <Filter size={14} /> só com balão pendente
                  </label>
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} aria-label="Ordenar">
                    <option value="list">ordem do cadastro</option>
                    <option value="rank">classificação</option>
                    <option value="name">nome</option>
                    <option value="place">localização</option>
                  </select>
                </>
              )}
              <button className={`btn btn--ghost btn--sm ${showColors ? 'is-on' : ''}`} onClick={() => setShowColors((s) => !s)}>
                <Palette size={14} /> Cores dos balões
              </button>
              {view === 'grid' && (
                <span className="legend">
                  <span className="dot dot--idle" /> não resolvida <span className="dot dot--solved" /> accepted · aguardando <span className="dot dot--delivered" /> balão entregue
                </span>
              )}
            </div>
            {showColors && (
              <div className="board__colors">
                {colorContests.map((c) => (
                  <div key={c.key} className="board__colorset">
                    {multi && <span className="mono board__colortag">{c.tag}</span>}
                    <ProblemEditor contestKey={c.key} compact />
                  </div>
                ))}
              </div>
            )}

            {view === 'map' ? (
              !state.allocation || !rooms.length ? (
                <EmptyState title="Mapa ainda não gerado" action={<button className="btn btn--primary" onClick={() => go('mapa')}>Ir para o mapa de sala</button>}>
                  Gere a alocação para ver os balões de cada computador na planta da sala.
                </EmptyState>
              ) : (
                <BalloonMap
                  rooms={rooms}
                  units={scopeUnits}
                  problems={problems}
                  focusProblem={focusProblem}
                  onFocusProblem={setFocusProblem}
                  highlightUnit={highlight}
                  query={query}
                />
              )
            ) : (
              <>
                <div className="sheet-wrap">
                  <table className="sheet">
                    <thead>
                      <tr>
                        <th className="sheet__corner">
                          <span className="mono">{rows.length}</span> {state.mode === 'team' ? 'equipes' : 'participantes'}
                        </th>
                        {problems.map((p) => {
                          const ps = pstats.find((x) => x.key === p.key)!;
                          const lbl = actions.label(p);
                          return (
                            <th key={p.key} className={`sheet__ph ${focusProblem === p.key ? 'is-focus' : ''} ${multi && !scopeContest && firstOfContest.has(p.key) ? 'is-cstart' : ''}`}>
                              <button
                                onClick={() => setFocusProblem(focusProblem === p.key ? null : p.key)}
                                title={`${p.title ? p.title + ' — ' : ''}clique para ver quem aguarda o balão ${lbl}`}
                              >
                                {multi && !scopeContest && <span className="sheet__ctag mono">{findContest(state, p.contest)?.tag}</span>}
                                <Balloon color={p.color} size={18} />
                                <span className="keycap sheet__letter" style={{ ['--c' as string]: p.color }}>
                                  {p.letter}
                                </span>
                                <span className="sheet__pcount mono">
                                  {ps.solved}
                                  {ps.pending > 0 && <em>·{ps.pending}</em>}
                                </span>
                              </button>
                            </th>
                          );
                        })}
                        <th className="sheet__sum mono" title="Questões resolvidas">
                          Σ
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((u) => {
                        const loc = locationOf(state, u.id);
                        const st = stand.get(u.id);
                        return (
                          <tr key={u.id}>
                            <th className="sheet__who" scope="row">
                              <div className="sheet__whobox">
                                <span className="sheet__name">
                                  {sortBy === 'rank' && st && st.solved > 0 && (
                                    <span className="sheet__pos mono" data-pos={st.position <= 3 ? st.position : undefined}>
                                      {st.position}º
                                    </span>
                                  )}
                                  {u.name}
                                </span>
                                <span className="sheet__meta mono">
                                  {u.accounts.length ? u.accounts.map((a) => `@${a}`).join(' ') : <span className="warn-text">sem conta vjudge</span>}
                                </span>
                                {state.mode === 'team' && <span className="sheet__meta">{u.members.map((m) => m.name.split(' ')[0]).join(' · ')}</span>}
                                {loc && (
                                  <button className="sheet__loc mono" onClick={() => showOnMap(u.id)} title="Ver no mapa">
                                    <MapPin size={10} /> {loc}
                                  </button>
                                )}
                              </div>
                            </th>
                            {problems.map((p) => {
                              const cell = state.results[u.id]?.[p.key];
                              const cs = cellStatus(cell);
                              const fresh = cs === 'solved' && cell?.detectedAt && now - cell.detectedAt < 90_000;
                              const first = pstats.find((x) => x.key === p.key)?.firstUnitId === u.id;
                              const ttl = cellTitle(u, actions.label(p), cell);
                              return (
                                <td key={p.key} className={`${focusProblem === p.key ? 'is-focus' : ''} ${multi && !scopeContest && firstOfContest.has(p.key) ? 'is-cstart' : ''}`}>
                                  <button
                                    className={`cell cell--${cs} ${fresh ? 'is-fresh' : ''}`}
                                    style={{ ['--c' as string]: p.color }}
                                    onClick={() => actions.toggle(u, p, cell)}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      setMenu({ unit: u, problem: p, x: e.clientX, y: e.clientY });
                                    }}
                                    title={ttl}
                                    aria-label={ttl}
                                  >
                                    {cs === 'idle' && <span className="cell__dot" />}
                                    {cs === 'solved' && <Balloon color={p.color} size={20} className="cell__balloon" />}
                                    {cs === 'delivered' && <Check size={16} strokeWidth={3} />}
                                    {first && <span className="cell__first" title="Primeira a resolver">1º</span>}
                                    {cell?.solvedSource === 'manual' && <span className="cell__manual">m</span>}
                                  </button>
                                </td>
                              );
                            })}
                            <td className="sheet__sum mono" title={st ? `${st.position}º lugar · soma dos tempos ${st.minutes} min (sem penalidade por tentativas)` : undefined}>
                              {st?.solved ?? 0}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {rows.length === 0 && <div className="sheet__none muted">Nenhuma linha corresponde aos filtros.</div>}
                </div>
                <p className="hint muted">
                  Clique ou toque em uma célula <b>verde</b> para registrar a entrega do balão; em uma <b>preta</b> para desfazer. Botão direito (ou
                  toque longo) mostra detalhes e opções. A classificação ordena por questões resolvidas e, no empate, pela soma dos tempos dos Accepted
                  (sem a penalidade por submissões rejeitadas).
                </p>
              </>
            )}
          </section>

          <aside className="queue">
            <header className="queue__head">
              <h2>
                Fila de balões <span className="mono queue__count">{pad(visibleQueue.length)}</span>
              </h2>
              {focus && (
                <button className="chip is-on" onClick={() => setFocusProblem(null)} style={{ ['--c' as string]: focus.color }}>
                  questão {actions.label(focus)} <X size={12} />
                </button>
              )}
            </header>
            {visibleQueue.length === 0 ? (
              <div className="queue__empty">
                <WccLogo size={40} className="is-muted" />
                <span>{focus ? `Nenhum balão ${actions.label(focus)} pendente.` : 'Nenhum balão pendente.'}</span>
              </div>
            ) : (
              <ol className="queue__list">
                {visibleQueue.map((q) => {
                  const loc = locationOf(state, q.unit.id);
                  const at = q.cell.solvedAt ?? q.cell.detectedAt ?? now;
                  const late = now - (q.cell.detectedAt ?? at) > 10 * 60_000;
                  return (
                    <li key={`${q.unit.id}:${q.problem.key}`} className={`qitem ${late ? 'is-late' : ''}`} style={{ ['--c' as string]: q.problem.color }}>
                      <Balloon color={q.problem.color} size={34} />
                      <div className="qitem__body">
                        <div className="qitem__top">
                          <span className="qitem__letter mono">{actions.label(q.problem)}</span>
                          <span className="qitem__name">{q.unit.name}</span>
                        </div>
                        <div className="qitem__meta mono">
                          {loc ? (
                            <button className="qitem__loc" onClick={() => showOnMap(q.unit.id)} title="Ver no mapa">
                              <MapPin size={10} /> {loc}
                            </button>
                          ) : (
                            'sem posição no mapa'
                          )}{' '}
                          · há {since(q.cell.detectedAt ?? at, now)}
                        </div>
                      </div>
                      <button className="btn btn--deliver btn--sm" onClick={() => actions.deliver(q.unit, q.problem)}>
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
          label={actions.label(menu.problem)}
          cell={state.results[menu.unit.id]?.[menu.problem.key]}
          loc={locationOf(state, menu.unit.id)}
          onClose={() => setMenu(null)}
          onDeliver={() => actions.deliver(menu.unit, menu.problem)}
          onUndo={() => actions.undo(menu.unit, menu.problem)}
          onManual={() => actions.manual(menu.unit, menu.problem)}
          onRemoveManual={() => actions.removeManual(menu.unit, menu.problem)}
        />
      )}
    </div>
  );
}

/** Estado resumido de vários contests (banda da Arena na aba "todos"). */
function SyncSummary({ contests }: { contests: Contest[] }) {
  const linked = contests.filter((c) => c.contestId);
  const bad = linked.filter((c) => c.lastSyncOk === false);
  const warn = linked.filter((c) => c.lastSyncOk !== false && c.warning);
  const last = Math.max(0, ...linked.map((c) => c.lastSyncAt ?? 0));
  if (bad.length)
    return (
      <span className="syncstatus is-bad" title={bad.map((c) => `${c.tag}: ${c.lastError}`).join('\n')}>
        <X size={14} /> falha em {bad.map((c) => c.tag).join(', ')}
      </span>
    );
  if (warn.length)
    return (
      <span className="syncstatus is-warn" title={warn.map((c) => `${c.tag}: ${c.warning}`).join('\n')}>
        aviso em {warn.map((c) => c.tag).join(', ')}
      </span>
    );
  return last ? (
    <span className="syncstatus is-ok">
      <Check size={14} /> {linked.length} contests · última leitura {formatTime(last)}
    </span>
  ) : (
    <span className="syncstatus muted">nenhuma leitura ainda</span>
  );
}

function cellTitle(u: Unit, label: string, cell: Cell | undefined): string {
  const st = cellStatus(cell);
  if (st === 'idle') return `${u.name} · ${label}: não resolvida`;
  const src = cell?.solvedSource === 'manual' ? 'registro manual' : `accepted ${formatTime(cell?.solvedAt)}${cell?.account ? ` (${cell.account})` : ''}`;
  if (st === 'solved') return `${u.name} · ${label}: ${src} — aguardando balão`;
  return `${u.name} · ${label}: ${src} — balão entregue ${formatTime(cell?.deliveredAt)}`;
}

/** Relógio de prova com os dois-pontos piscando enquanto o contest está em andamento. */
function Ticking({ text, live }: { text: string; live: boolean }) {
  const [h, m] = text.split(':');
  return (
    <>
      {h}
      <span className={live ? 'tick' : ''}>:</span>
      {m}
    </>
  );
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
  label,
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
  label: string;
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
            {label}
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
