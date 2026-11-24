import { ArrowRight } from 'lucide-react';
import type { Route } from '../App';
import { useStore } from '../state/store';
import { allocate } from '../state/actions';
import { Notice, Segmented, SectionHead } from '../components/ui';
import { WccLogo } from '../components/WccLogo';
import { LabsSection } from './setup/LabsSection';
import { ParticipantsSection } from './setup/ParticipantsSection';
import { ModeSection } from './setup/ModeSection';
import { unassignedParticipants } from '../domain/teams';
import type { AllocationSettings } from '../domain/types';

export function SetupScreen({ go }: { go: (r: Route) => void }) {
  const { state, commit, units } = useStore();
  const as = state.allocationSettings;
  const setAs = (patch: Partial<AllocationSettings>) => commit((s) => ({ ...s, allocationSettings: { ...s.allocationSettings, ...patch } }));

  const problems: string[] = [];
  if (!Object.values(state.labSelection).some((l) => l.selected)) problems.push('selecione ao menos um laboratório');
  if (!state.participants.length) problems.push('cadastre participantes');
  if (state.mode === 'team' && !units.length) problems.push('forme as equipes');
  const unassigned = state.mode === 'team' && state.teams.length ? unassignedParticipants(state.teams, state.participants).length : 0;

  return (
    <div className="screen setup">
      <div className="hero">
        <div className="hero__text">
          <span className="eyebrow mono">// 01 — configuração</span>
          <h1 className="hero__title">
            Monte a arena.
            <br />
            <span className="hero__accent">
              Distribua. <span style={{ color: 'var(--blue)' }}>Acompanhe.</span> <span style={{ color: 'var(--green-ink)' }}>Entregue.</span>
            </span>
          </h1>
          <p className="hero__lead">
            Os laboratórios vêm direto do site do LCC. Cadastre participantes, escolha as salas e deixe o WCC Control
            distribuir computadores e cadeiras. Tudo é salvo automaticamente neste navegador.
          </p>
        </div>
        <div className="hero__art" aria-hidden>
          <WccLogo size={220} className="hero__star" />
          <span className="hero__orbit" />
        </div>
      </div>

      <section className="section">
        <SectionHead index="01" title="Competição" />
        <label className="field field--xl">
          <span className="label">Nome da competição</span>
          <input
            value={state.competitionName}
            onChange={(e) => commit((s) => ({ ...s, competitionName: e.target.value }))}
            placeholder="ex.: WCC 2026 — Seletiva interna"
            maxLength={120}
          />
        </label>
      </section>

      <LabsSection />
      <ParticipantsSection />
      <ModeSection />

      <section className="section">
        <SectionHead index="05" title="Espaçamento e ordem">
          O algoritmo tenta deixar até o espaçamento escolhido entre participantes ou equipes na mesma bancada e reduz
          automaticamente quando não há espaço.
        </SectionHead>
        <div className="spacing">
          <div>
            <span className="label">Espaçamento máximo desejado</span>
            <Segmented<0 | 1 | 2>
              label="Espaçamento máximo"
              value={as.maxGap}
              onChange={(v) => setAs({ maxGap: v })}
              options={[
                { value: 2, label: '2 vazias' },
                { value: 1, label: '1 vazia' },
                { value: 0, label: 'Sem espaço' },
              ]}
            />
            <GapDiagram gap={as.maxGap} width={state.mode === 'team' ? state.teamSettings.size : 1} />
          </div>
          <div>
            <span className="label">Ordem de ocupação</span>
            <Segmented
              label="Ordem"
              value={as.order}
              onChange={(v) => setAs({ order: v })}
              options={[
                { value: 'list', label: 'Ordem da lista' },
                { value: 'alpha', label: 'Alfabética' },
                { value: 'random', label: 'Sorteio' },
              ]}
            />
          </div>
        </div>
      </section>

      <div className="cta">
        {problems.length > 0 ? (
          <Notice tone="info">Para gerar o mapa: {problems.join(', ')}.</Notice>
        ) : unassigned > 0 ? (
          <Notice tone="warn">{unassigned} participante(s) sem equipe não serão alocadas.</Notice>
        ) : (
          <span className="mono muted">
            {units.length} {state.mode === 'team' ? 'equipes' : 'participantes'} prontas para alocação
          </span>
        )}
        <button
          className="btn btn--primary btn--lg"
          disabled={problems.length > 0}
          onClick={() => {
            commit(allocate);
            go('mapa');
          }}
        >
          {state.allocation ? 'Recalcular mapa de sala' : 'Gerar mapa de sala'} <ArrowRight size={18} />
        </button>
      </div>
    </div>
  );
}

function GapDiagram({ gap, width }: { gap: number; width: number }) {
  const cells: ('on' | 'off')[] = [];
  for (let u = 0; u < 3; u++) {
    for (let w = 0; w < width; w++) cells.push('on');
    if (u < 2) for (let g = 0; g < gap; g++) cells.push('off');
  }
  return (
    <div className="gapdiagram" aria-hidden>
      {cells.map((c, i) => (
        <span key={i} className={`gapdiagram__cell is-${c}`} />
      ))}
    </div>
  );
}
