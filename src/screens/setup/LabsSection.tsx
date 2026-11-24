import { AlertTriangle, Check, DoorOpen, ExternalLink, RefreshCw } from 'lucide-react';
import { useStore } from '../../state/store';
import { useSync } from '../../services/sync';
import { gatewayUrl } from '../../services/gateway';
import { roomsOf } from '../../state/selectors';
import { availableMachines } from '../../domain/allocation';
import { SectionHead, formatTime } from '../../components/ui';
import type { LabSelection, Room } from '../../domain/types';

function ago(ts: number | null): string {
  if (!ts) return 'data desconhecida';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `hoje, ${formatTime(ts, false)}` : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function LabsSection() {
  const { state, commit } = useStore();
  const { labsBusy, refreshLabs } = useSync();
  const cat = state.labCatalog;
  const rooms = roomsOf(state);
  const hasGateway = !!gatewayUrl(state);

  const setSel = (id: string, fn: (s: LabSelection) => LabSelection) =>
    commit((s) => ({
      ...s,
      labSelection: { ...s.labSelection, [id]: fn(s.labSelection[id] ?? { selected: false, excluded: [] }) },
    }));

  const toggleMachine = (lab: Room, id: string) =>
    setSel(lab.id, (sel) => ({ ...sel, excluded: sel.excluded.includes(id) ? sel.excluded.filter((x) => x !== id) : [...sel.excluded, id] }));

  const selected = rooms.filter((r) => r.selected);
  const total = selected.reduce((a, r) => a + availableMachines(r), 0);

  return (
    <section className="section">
      <SectionHead index="02" title="Laboratórios">
        Planta e computadores importados de{' '}
        <a className="link" href="https://lcc.ufcg.edu.br/" target="_blank" rel="noreferrer">
          lcc.ufcg.edu.br <ExternalLink size={11} />
        </a>
        . Cada computador tem uma cadeira, então a capacidade é a quantidade de computadores. Clique em um computador para
        marcá-lo como indisponível nesta competição.
      </SectionHead>

      <div className={`labsource ${cat.lastError ? 'is-bad' : ''}`}>
        <div className="labsource__text">
          <span className={`labsource__dot is-${cat.origin === 'gateway' && !cat.lastError ? 'live' : cat.lastError ? 'bad' : 'snap'}`} />
          {cat.origin === 'gateway' ? (
            <span>
              Consulta ao site do LCC: <b>{ago(cat.fetchedAt)}</b>
            </span>
          ) : (
            <span>
              Cópia do site do LCC gerada no build: <b>{ago(cat.fetchedAt)}</b>
              {!hasGateway && <span className="muted"> — configure o WCC Gateway (tela VJudge) para consultar ao vivo</span>}
            </span>
          )}
          {cat.lastError && (
            <span className="labsource__err">
              <AlertTriangle size={13} /> Última tentativa ({formatTime(cat.lastAttemptAt, false)}) falhou: {cat.lastError} Usando a última planta conhecida.
            </span>
          )}
        </div>
        <button className="btn btn--ghost btn--sm" disabled={!hasGateway || labsBusy} onClick={() => void refreshLabs()}>
          <RefreshCw size={14} className={labsBusy ? 'spin' : ''} /> {labsBusy ? 'Consultando…' : 'Atualizar agora'}
        </button>
      </div>

      {rooms.length === 0 ? (
        <div className="notice notice--error">Nenhum laboratório disponível. Configure o WCC Gateway para consultar o site do LCC.</div>
      ) : (
        <div className="labs">
          {rooms.map((lab) => {
            const down = lab.cells.flat().filter((c) => c && typeof c === 'object' && c.status === 'down').map((c) => (c as { id: string }).id);
            const avail = availableMachines(lab);
            return (
              <article key={lab.id} className={`lab ${lab.selected ? 'is-selected' : ''}`}>
                <header className="lab__head">
                  <label className="lab__toggle">
                    <input type="checkbox" checked={lab.selected} onChange={(e) => setSel(lab.id, (s) => ({ ...s, selected: e.target.checked }))} />
                    <span className="lab__check" aria-hidden>
                      {lab.selected && <Check size={14} strokeWidth={3} />}
                    </span>
                    <span className="lab__name">{lab.name}</span>
                  </label>
                  <span className="lab__cap">
                    <span className="mono lab__capnum">{avail}</span>
                    <span className="lab__caplbl">
                      computadores
                      <br />= cadeiras
                    </span>
                  </span>
                </header>

                <LabPlan lab={lab} onToggle={(id) => toggleMachine(lab, id)} />

                <footer className="lab__foot mono">
                  <span>{lab.machines} no site</span>
                  {lab.excluded.length > 0 && (
                    <button className="linkbtn" onClick={() => setSel(lab.id, (s) => ({ ...s, excluded: [] }))}>
                      {lab.excluded.length} indisponíve{lab.excluded.length > 1 ? 'is' : 'l'} · limpar
                    </button>
                  )}
                  {down.length > 0 && cat.origin === 'gateway' && (
                    <button
                      className="linkbtn linkbtn--warn"
                      title={down.join(', ')}
                      onClick={() => setSel(lab.id, (s) => ({ ...s, excluded: [...new Set([...s.excluded, ...down])] }))}
                    >
                      {down.length} DOWN agora · marcar indisponíve{down.length > 1 ? 'is' : 'l'}
                    </button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <p className="section-foot mono">
        {selected.length === 0
          ? 'nenhum laboratório selecionado'
          : `${selected.map((l) => l.name).join(' + ')} · ${total} computadores · ${total} cadeiras`}
      </p>
    </section>
  );
}

/** Miniatura da planta real: clique alterna "indisponível nesta competição". */
function LabPlan({ lab, onToggle }: { lab: Room; onToggle: (id: string) => void }) {
  const excluded = new Set(lab.excluded);
  return (
    <div className="labplan" style={{ ['--cols' as string]: lab.cols }}>
      {lab.cells.map((row, r) => {
        const emptyRow = row.every((c) => c === null);
        return (
          <div key={r} className={`labplan__row ${emptyRow ? 'is-aisle' : ''}`}>
            {!emptyRow &&
              row.map((cell, c) => {
                if (cell === null) return <span key={c} className="labplan__gap" />;
                if (cell === 'door')
                  return (
                    <span key={c} className="labplan__door" title="Porta de acesso">
                      <DoorOpen size={11} />
                    </span>
                  );
                const off = excluded.has(cell.id);
                return (
                  <button
                    key={c}
                    className={`labplan__pc ${off ? 'is-off' : ''} ${cell.status === 'down' ? 'is-down' : ''}`}
                    onClick={() => onToggle(cell.id)}
                    title={`${cell.id}${cell.status === 'down' ? ' — DOWN na última consulta' : ''}${off ? ' — indisponível nesta competição' : ''}`}
                    aria-label={cell.id}
                    aria-pressed={off}
                  />
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
