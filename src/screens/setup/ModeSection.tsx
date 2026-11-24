import { Plus, Shuffle, Trash2, Users, User, ListOrdered } from 'lucide-react';
import { useStore } from '../../state/store';
import { useConfirm } from '../../components/Confirm';
import { Notice, Segmented, SectionHead } from '../../components/ui';
import { formTeams, moveMember, teamSizes, unassignedParticipants } from '../../domain/teams';
import { pad, uid } from '../../domain/ids';
import type { Mode, Team, TeamSettings } from '../../domain/types';

export function ModeSection() {
  const { state, commit, units } = useStore();
  const confirm = useConfirm();
  const ts = state.teamSettings;

  const setTs = (patch: Partial<TeamSettings>) => commit((s) => ({ ...s, teamSettings: { ...s.teamSettings, ...patch } }));
  const setTeams = (fn: (t: Team[]) => Team[]) => commit((s) => ({ ...s, teams: fn(s.teams) }));

  const autoForm = async (randomize: boolean) => {
    if (state.teams.length) {
      const ok = await confirm({
        title: 'Refazer as equipes?',
        body: 'A composição atual será substituída. Submissões e balões já registrados para as equipes atuais deixarão de aparecer na grade.',
        confirmLabel: 'Refazer equipes',
        danger: true,
      });
      if (!ok) return;
    }
    commit((s) => ({ ...s, teams: formTeams(s.participants, s.teamSettings, randomize) }));
  };

  const preview = teamSizes(state.participants.length, ts.size, ts.remainder);
  const unassigned = unassignedParticipants(state.teams, state.participants);
  const byId = new Map(state.participants.map((p) => [p.id, p]));

  return (
    <section className="section">
      <SectionHead index="04" title="Modalidade">
        No individual cada participante ocupa uma cadeira e usa um computador. Em grupo, cada integrante ocupa uma
        cadeira, todas vizinhas na mesma bancada, e a equipe compartilha um único computador.
      </SectionHead>

      <div className="mode-pick">
        {(['individual', 'team'] as Mode[]).map((m) => (
          <button key={m} className={`mode-card ${state.mode === m ? 'is-on' : ''}`} onClick={() => commit((s) => ({ ...s, mode: m }))} aria-pressed={state.mode === m}>
            <span className="mode-card__icon">{m === 'individual' ? <User size={22} /> : <Users size={22} />}</span>
            <span className="mode-card__title">{m === 'individual' ? 'Individual' : 'Em grupo'}</span>
            <span className="mode-card__desc mono">{m === 'individual' ? '1 pessoa · 1 cadeira · 1 PC' : `${ts.size} pessoas · ${ts.size} cadeiras vizinhas · 1 PC`}</span>
          </button>
        ))}
      </div>

      {state.mode === 'team' && (
        <div className="teams">
          <div className="teams__settings">
            <label>
              <span className="label">Integrantes por equipe</span>
              <Segmented<2 | 3> label="Integrantes por equipe" value={ts.size} onChange={(v) => setTs({ size: v })} options={[{ value: 2, label: 'Duplas' }, { value: 3, label: 'Trios' }]} />
            </label>
            <label>
              <span className="label">Quando sobrar gente</span>
              <Segmented
                label="Resto"
                value={ts.remainder}
                onChange={(v) => setTs({ remainder: v })}
                options={[
                  { value: 'balance', label: 'Equilibrar', hint: 'Evita equipes de 1 pessoa (ex.: 7 em trios → 3+2+2)' },
                  { value: 'smaller', label: 'Última menor', hint: 'Mantém o tamanho padrão e forma uma última equipe menor' },
                ]}
              />
            </label>
          </div>

          <div className="teams__auto">
            <span className="mono muted">
              {state.participants.length} participantes →{' '}
              {preview.length ? `${preview.length} equipes (${preview.join(' + ')})` : 'cadastre participantes primeiro'}
            </span>
            <div className="row-gap">
              <button className="btn btn--ghost" disabled={!state.participants.length} onClick={() => void autoForm(false)}>
                <ListOrdered size={16} /> Formar pela ordem da lista
              </button>
              <button className="btn btn--ghost" disabled={!state.participants.length} onClick={() => void autoForm(true)}>
                <Shuffle size={16} /> Formar aleatoriamente
              </button>
            </div>
          </div>

          {unassigned.length > 0 && state.teams.length > 0 && (
            <Notice tone="warn">
              {unassigned.length} participante{unassigned.length > 1 ? 's' : ''} sem equipe: {unassigned.map((p) => p.name).join(', ')}. Use o seletor
              em cada nome abaixo ou crie uma nova equipe.
            </Notice>
          )}

          {state.teams.length > 0 && (
            <div className="teamlist">
              {state.teams.map((t, i) => {
                const unit = units.find((u) => u.id === t.id);
                const odd = t.memberIds.length !== ts.size;
                return (
                  <div key={t.id} className={`team ${odd ? 'is-odd' : ''}`}>
                    <div className="team__head">
                      <span className="mono team__n">{pad(i + 1)}</span>
                      <input
                        className="team__name"
                        value={t.name}
                        onChange={(e) => setTeams((ts2) => ts2.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))}
                        aria-label="Nome da equipe"
                      />
                      <button
                        className="iconbtn iconbtn--sm"
                        aria-label={`Desfazer ${t.name}`}
                        title="Desfazer equipe (integrantes ficam sem equipe)"
                        onClick={() => setTeams((ts2) => ts2.filter((x) => x.id !== t.id))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <ul className="team__members">
                      {t.memberIds.map((m) => (
                        <li key={m}>
                          <span>{byId.get(m)?.name ?? '—'}</span>
                          <select
                            value={t.id}
                            aria-label="Mover para equipe"
                            onChange={(e) => setTeams((ts2) => moveMember(ts2, m, e.target.value || null))}
                          >
                            {state.teams.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                            <option value="">— sem equipe</option>
                          </select>
                        </li>
                      ))}
                    </ul>
                    {unassigned.length > 0 && (
                      <select
                        className="team__add"
                        value=""
                        aria-label="Adicionar integrante"
                        onChange={(e) => e.target.value && setTeams((ts2) => moveMember(ts2, e.target.value, t.id))}
                      >
                        <option value="">+ adicionar integrante</option>
                        {unassigned.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="team__foot mono">
                      {t.memberIds.length} pessoas · {unit?.seats ?? 0} cadeiras · 1 PC
                      {odd && <span className="tag tag--purple">exceção</span>}
                    </div>
                  </div>
                );
              })}
              <button
                className="team team--new"
                onClick={() => setTeams((t) => [...t, { id: uid('t'), name: `Equipe ${pad(t.length + 1)}`, memberIds: [], vjudge: '' }])}
              >
                <Plus size={18} /> Nova equipe
              </button>
            </div>
          )}
          {state.teams.some((t) => t.memberIds.length === 0) && (
            <Notice tone="info">Equipes vazias são ignoradas na alocação e na grade até receberem integrantes.</Notice>
          )}
        </div>
      )}
    </section>
  );
}
