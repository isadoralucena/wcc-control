import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, DoorOpen, ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useStore } from '../../state/store';
import { useSync } from '../../services/sync';
import { gatewayUrl } from '../../services/gateway';
import { roomsOf } from '../../state/selectors';
import { availableMachines, machineIds } from '../../domain/allocation';
import { buildCustomLab, defaultCustomLab, DOOR_LABELS, MAX_CUSTOM_MACHINES, normalizeLabId, perBench, validateCustomLab } from '../../domain/customLabs';
import { useConfirm } from '../../components/Confirm';
import { SectionHead, Segmented, Stepper, formatTime } from '../../components/ui';
import type { CustomLabSpec, DoorPosition, LabSelection, Room } from '../../domain/types';

function ago(ts: number | null): string {
  if (!ts) return 'data desconhecida';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `hoje, ${formatTime(ts, false)}` : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function LabsSection() {
  const { state, commit } = useStore();
  const { labsBusy, refreshLabs } = useSync();
  const confirm = useConfirm();
  const cat = state.labCatalog;
  const rooms = roomsOf(state);
  const lccRooms = rooms.filter((r) => r.origin !== 'custom');
  const customRooms = rooms.filter((r) => r.origin === 'custom');
  const hasGateway = !!gatewayUrl(state);
  /** null = fechado; 'new' = cadastrando; sigla = editando. */
  const [editing, setEditing] = useState<string | null>(null);

  const setSel = (id: string, fn: (s: LabSelection) => LabSelection) =>
    commit((s) => ({
      ...s,
      labSelection: { ...s.labSelection, [id]: fn(s.labSelection[id] ?? { selected: false, excluded: [] }) },
    }));

  const toggleMachine = (lab: Room, id: string) =>
    setSel(lab.id, (sel) => ({ ...sel, excluded: sel.excluded.includes(id) ? sel.excluded.filter((x) => x !== id) : [...sel.excluded, id] }));

  const selected = rooms.filter((r) => r.selected);
  const total = selected.reduce((a, r) => a + availableMachines(r), 0);

  const saveCustom = (spec: CustomLabSpec, isNew: boolean) => {
    commit((s) => {
      const customLabs = isNew ? [...s.customLabs, spec] : s.customLabs.map((l) => (l.id === spec.id ? spec : l));
      const ids = new Set(machineIds({ ...buildCustomLab(spec), selected: false, excluded: [] }));
      const prev = s.labSelection[spec.id] ?? { selected: false, excluded: [] };
      return {
        ...s,
        customLabs,
        // Novo laboratório já entra selecionado; exclusões de máquinas que deixaram de existir são descartadas.
        labSelection: { ...s.labSelection, [spec.id]: { selected: isNew ? true : prev.selected, excluded: prev.excluded.filter((x) => ids.has(x)) } },
      };
    });
    setEditing(null);
  };

  const removeCustom = async (lab: Room) => {
    const ok = await confirm({
      title: `Remover ${lab.name}?`,
      body: 'O laboratório personalizado será apagado. Quem estiver alocado nele ficará sem lugar até você recalcular ou mover no mapa.',
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    commit((s) => {
      const labSelection = { ...s.labSelection };
      delete labSelection[lab.id];
      return { ...s, customLabs: s.customLabs.filter((l) => l.id !== lab.id), labSelection };
    });
  };

  const takenIds = (except?: string) => rooms.map((r) => r.id).filter((id) => id !== except);

  return (
    <section className="section">
      <SectionHead index="02" title="Laboratórios">
        Selecione um ou mais laboratórios. Cada computador tem uma cadeira, então a capacidade é a quantidade de computadores. Clique em um
        computador da planta para marcá-lo como indisponível nesta competição.
      </SectionHead>

      <h3 className="subhead">
        Laboratórios da UFCG{' '}
        <a className="link subhead__src" href="https://lcc.ufcg.edu.br/" target="_blank" rel="noreferrer">
          lcc.ufcg.edu.br <ExternalLink size={11} />
        </a>
      </h3>
      <div className={`labsource ${cat.lastError ? 'is-bad' : ''}`}>
        <div className="labsource__text">
          <span className={`labsource__dot is-${cat.origin === 'gateway' && !cat.lastError ? 'live' : cat.lastError ? 'bad' : 'snap'}`} />
          {cat.origin === 'gateway' ? (
            <span>
              Planta e computadores consultados no site do LCC: <b>{ago(cat.fetchedAt)}</b>
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
          <RefreshCw size={14} className={labsBusy ? 'spin' : ''} /> {labsBusy ? <span className="caret">consultando</span> : 'Atualizar agora'}
        </button>
      </div>

      {lccRooms.length === 0 ? (
        <div className="notice notice--error">Nenhum laboratório do LCC disponível. Configure o WCC Gateway para consultar o site do LCC.</div>
      ) : (
        <div className="labs">
          {lccRooms.map((lab) => {
            const down = lab.cells.flat().filter((c) => c && typeof c === 'object' && c.status === 'down').map((c) => (c as { id: string }).id);
            return (
              <LabCard
                key={lab.id}
                lab={lab}
                onSelect={(on) => setSel(lab.id, (s) => ({ ...s, selected: on }))}
                onToggleMachine={(id) => toggleMachine(lab, id)}
                foot={
                  <>
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
                  </>
                }
              />
            );
          })}
        </div>
      )}

      <h3 className="subhead">Laboratórios personalizados</h3>
      <p className="muted subhead__desc">
        Para salas de outras instituições ou locais: informe a quantidade de computadores, as bancadas, a direção dos corredores e a porta. A planta
        é gerada no mesmo formato da do LCC e pode ser usada junto com ela.
      </p>
      <div className="labs">
        {customRooms.map((lab) =>
          editing === lab.id ? null : (
            <LabCard
              key={lab.id}
              lab={lab}
              onSelect={(on) => setSel(lab.id, (s) => ({ ...s, selected: on }))}
              onToggleMachine={(id) => toggleMachine(lab, id)}
              foot={
                <>
                  <span>{specSummary(state.customLabs.find((l) => l.id === lab.id)!)}</span>
                  {lab.excluded.length > 0 && (
                    <button className="linkbtn" onClick={() => setSel(lab.id, (s) => ({ ...s, excluded: [] }))}>
                      {lab.excluded.length} indisponíve{lab.excluded.length > 1 ? 'is' : 'l'} · limpar
                    </button>
                  )}
                  <button className="linkbtn" onClick={() => setEditing(lab.id)}>
                    <Pencil size={11} /> editar
                  </button>
                  <button className="linkbtn linkbtn--warn" onClick={() => void removeCustom(lab)}>
                    <Trash2 size={11} /> remover
                  </button>
                </>
              }
            />
          ),
        )}
        {editing === null && (
          <button className="lab lab--add" onClick={() => setEditing('new')}>
            <Plus size={22} />
            <span>Adicionar laboratório</span>
          </button>
        )}
      </div>
      {editing !== null && (
        <CustomLabEditor
          key={editing}
          initial={editing === 'new' ? defaultCustomLab(takenIds()) : state.customLabs.find((l) => l.id === editing)!}
          isNew={editing === 'new'}
          taken={takenIds(editing === 'new' ? undefined : editing)}
          onCancel={() => setEditing(null)}
          onSave={(spec) => saveCustom(spec, editing === 'new')}
        />
      )}

      <p className="section-foot mono">
        {selected.length === 0
          ? 'nenhum laboratório selecionado'
          : `${selected.map((l) => l.name).join(' + ')} · ${total} computadores · ${total} cadeiras`}
      </p>
    </section>
  );
}

function specSummary(spec: CustomLabSpec): string {
  const per = perBench(spec);
  const last = spec.machines - per * (spec.benches - 1);
  const benches =
    last === per || spec.benches === 1
      ? `${spec.benches} bancada${spec.benches > 1 ? 's' : ''} de ${per}`
      : `${spec.benches - 1} bancada${spec.benches > 2 ? 's' : ''} de ${per} + 1 de ${last}`;
  return `${benches} · corredores ${spec.orientation === 'h' ? 'horizontais' : 'verticais'}`;
}

function LabCard({ lab, onSelect, onToggleMachine, foot }: { lab: Room; onSelect: (on: boolean) => void; onToggleMachine: (id: string) => void; foot: ReactNode }) {
  const avail = availableMachines(lab);
  return (
    <article className={`lab ${lab.selected ? 'is-selected' : ''}`}>
      <header className="lab__head">
        <label className="lab__toggle">
          <input type="checkbox" checked={lab.selected} onChange={(e) => onSelect(e.target.checked)} />
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
      {lab.origin === 'custom' && lab.name !== lab.id && <span className="mono lab__sigla">{lab.id}</span>}
      <LabPlan lab={lab} onToggle={onToggleMachine} />
      <footer className="lab__foot mono">{foot}</footer>
    </article>
  );
}

/** Cadastro/edição de um laboratório personalizado, com pré-visualização da planta. */
function CustomLabEditor({
  initial,
  isNew,
  taken,
  onSave,
  onCancel,
}: {
  initial: CustomLabSpec;
  isNew: boolean;
  taken: string[];
  onSave: (spec: CustomLabSpec) => void;
  onCancel: () => void;
}) {
  const [spec, setSpec] = useState<CustomLabSpec>(initial);
  const set = (patch: Partial<CustomLabSpec>) =>
    setSpec((s) => {
      const next = { ...s, ...patch };
      return { ...next, benches: Math.max(1, Math.min(next.benches, next.machines)) };
    });
  const errors = validateCustomLab(spec, taken);
  const preview: Room = { ...buildCustomLab({ ...spec, id: spec.id || 'LAB' }), selected: true, excluded: [] };

  return (
    <div className="labedit">
      <div className="labedit__form">
        <h4 className="labedit__title">{isNew ? 'Novo laboratório' : `Editar ${initial.name}`}</h4>
        <label className="field">
          <span className="label">Nome</span>
          <input value={spec.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} placeholder="ex.: Laboratório 2 — IFPB" />
        </label>
        <label className="field">
          <span className="label">Sigla (prefixo dos computadores)</span>
          <input
            className="mono"
            value={spec.id}
            disabled={!isNew}
            onChange={(e) => set({ id: normalizeLabId(e.target.value) })}
            placeholder="SALA1"
            title={isNew ? 'Letras e números; os computadores ficam SIGLA-01, SIGLA-02…' : 'A sigla não muda depois do cadastro'}
          />
        </label>
        <div className="labedit__nums">
          <div>
            <span className="label">Computadores</span>
            <Stepper value={spec.machines} min={1} max={MAX_CUSTOM_MACHINES} label="quantidade de computadores" onChange={(n) => set({ machines: n })} />
          </div>
          <div>
            <span className="label">Bancadas</span>
            <Stepper value={spec.benches} min={1} max={spec.machines} label="quantidade de bancadas" onChange={(n) => set({ benches: n })} />
          </div>
        </div>
        <div>
          <span className="label">Corredores</span>
          <Segmented<'h' | 'v'>
            label="Direção dos corredores"
            value={spec.orientation}
            onChange={(o) => set({ orientation: o })}
            options={[
              { value: 'h', label: 'Horizontais', hint: 'Bancadas em fileiras, de um lado ao outro da sala' },
              { value: 'v', label: 'Verticais', hint: 'Bancadas em colunas, da frente ao fundo da sala' },
            ]}
          />
        </div>
        <label className="switch labedit__pair">
          <input type="checkbox" checked={spec.paired} onChange={(e) => set({ paired: e.target.checked })} />
          <span className="switch__track" />
          Bancadas em pares (costas com costas, um corredor a cada duas)
        </label>
        <label className="field">
          <span className="label">Porta</span>
          <select value={spec.door} onChange={(e) => set({ door: e.target.value as DoorPosition })}>
            {(Object.keys(DOOR_LABELS) as DoorPosition[]).map((d) => (
              <option key={d} value={d}>
                {DOOR_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        {errors.length > 0 && (
          <ul className="labedit__errors">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="row-gap">
          <button className="btn btn--primary" disabled={errors.length > 0} onClick={() => onSave({ ...spec, name: spec.name.trim() })}>
            {isNew ? 'Adicionar laboratório' : 'Salvar alterações'}
          </button>
          <button className="btn btn--ghost" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
      <div className="labedit__preview">
        <span className="label">Pré-visualização · frente da sala no topo</span>
        <LabPlan lab={preview} />
        <span className="mono muted labedit__sum">
          {spec.machines} computadores = {spec.machines} cadeiras · {specSummary(spec)}
          <br />
          {spec.id || 'SIGLA'}-{'0'.repeat(Math.max(2, String(spec.machines).length) - 1)}1 … numerados bancada por bancada
        </span>
      </div>
    </div>
  );
}

/** Miniatura da planta: clique alterna "indisponível nesta competição" (sem `onToggle`, só exibição). */
function LabPlan({ lab, onToggle }: { lab: Room; onToggle?: (id: string) => void }) {
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
                if (!onToggle) return <span key={c} className="labplan__pc" title={cell.id} />;
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
