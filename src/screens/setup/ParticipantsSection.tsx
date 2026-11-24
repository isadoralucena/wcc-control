import { useEffect, useMemo, useState } from 'react';
import { Search, Trash2, UserPlus, X } from 'lucide-react';
import { useStore } from '../../state/store';
import { useConfirm } from '../../components/Confirm';
import { useToasts } from '../../components/Toasts';
import { Notice, Segmented, SectionHead } from '../../components/ui';
import { cleanName, cleanUsername, createParticipants, isDuplicateName, normalizeName, pairLists, parseNameList } from '../../domain/participants';
import { cleanTeams } from '../../domain/teams';
import { pad } from '../../domain/ids';
import type { AppState, Participant } from '../../domain/types';

type InputMode = 'names' | 'paired';

/** Remove participantes e mantém equipes/alocação consistentes. */
export function removeParticipants(s: AppState, ids: Set<string>): AppState {
  const participants = s.participants.filter((p) => !ids.has(p.id));
  const placements = { ...(s.allocation?.placements ?? {}) };
  ids.forEach((id) => delete placements[id]);
  return {
    ...s,
    participants,
    teams: cleanTeams(s.teams, participants),
    allocation: s.allocation ? { ...s.allocation, placements, edited: true } : null,
  };
}

export function ParticipantsSection() {
  const { state, commit } = useStore();
  const confirm = useConfirm();
  const { notify } = useToasts();
  const [mode, setMode] = useState<InputMode>('names');
  const [names, setNames] = useState('');
  const [users, setUsers] = useState('');
  const [query, setQuery] = useState('');

  const existing = state.participants.map((p) => p.name);
  const preview = useMemo(
    () => (mode === 'names' ? { kind: 'names' as const, ...parseNameList(names, existing) } : { kind: 'paired' as const, ...pairLists(names, users, existing) }),
    [mode, names, users, existing.join('\n')], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const toAdd = preview.kind === 'names' ? preview.names.length : preview.pairs.length;

  const add = async () => {
    let entries: { name: string; username?: string }[];
    if (preview.kind === 'names') entries = preview.names.map((name) => ({ name }));
    else {
      if (preview.mismatch) {
        const ok = await confirm({
          title: 'As listas têm tamanhos diferentes',
          body: (
            <>
              São <b>{preview.nameCount}</b> nomes e <b>{preview.usernameCount}</b> usernames. A associação é feita pela ordem: a linha 1 de
              nomes com a linha 1 de usernames e assim por diante.{' '}
              {preview.nameCount > preview.usernameCount
                ? `As últimas ${preview.nameCount - preview.usernameCount} participantes ficarão sem username.`
                : `Os últimos ${preview.usernameCount - preview.nameCount} usernames serão ignorados.`}{' '}
              Confira se nenhuma linha está faltando antes de continuar.
            </>
          ),
          confirmLabel: 'Associar mesmo assim',
        });
        if (!ok) return;
      }
      entries = preview.pairs;
    }
    if (!entries.length) return;
    commit((s) => ({ ...s, participants: [...s.participants, ...createParticipants(entries)] }));
    notify({
      kind: 'success',
      title: `${entries.length} participante${entries.length > 1 ? 's' : ''} adicionada${entries.length > 1 ? 's' : ''}`,
      detail: preview.duplicates.length ? `${preview.duplicates.length} duplicada(s) ignorada(s)` : undefined,
    });
    setNames('');
    setUsers('');
  };

  const update = (id: string, patch: Partial<Participant>) =>
    commit((s) => ({ ...s, participants: s.participants.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));

  const removeAll = async () => {
    const ok = await confirm({
      title: 'Remover todas as participantes?',
      body: 'Equipes e alocações associadas também serão desfeitas.',
      confirmLabel: 'Remover todas',
      danger: true,
    });
    if (ok) commit((s) => removeParticipants(s, new Set(s.participants.map((p) => p.id))));
  };

  const filtered = query.trim()
    ? state.participants.filter((p) => normalizeName(`${p.name} ${p.vjudge}`).includes(normalizeName(query)))
    : state.participants;
  const withUser = state.participants.filter((p) => p.vjudge).length;

  return (
    <section className="section">
      <SectionHead index="03" title="Participantes">
        Cole a lista com uma participante por linha. Linhas vazias são removidas e nomes repetidos são ignorados
        (sem diferenciar acentos e maiúsculas).
      </SectionHead>

      <div className="paste">
        <Segmented<InputMode>
          label="Forma de cadastro"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'names', label: 'Só nomes' },
            { value: 'paired', label: 'Nomes + usernames VJudge' },
          ]}
        />
        <div className={`paste__areas ${mode === 'paired' ? 'is-paired' : ''}`}>
          <label className="paste__area">
            <span className="label">Nomes</span>
            <textarea value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Ana Clara\nBeatriz Souza\nCamila Oliveira'} rows={7} spellCheck={false} />
          </label>
          {mode === 'paired' && (
            <label className="paste__area">
              <span className="label">Usernames do VJudge (mesma ordem)</span>
              <textarea value={users} onChange={(e) => setUsers(e.target.value)} placeholder={'ana123\nbia456\ncamila789'} rows={7} spellCheck={false} className="mono" />
            </label>
          )}
        </div>

        <div className="paste__bar">
          <span className="mono paste__count">
            {preview.kind === 'paired' ? `${preview.nameCount} nomes · ${preview.usernameCount} usernames` : `${toAdd} nova${toAdd === 1 ? '' : 's'}`}
            {preview.duplicates.length > 0 && ` · ${preview.duplicates.length} duplicada${preview.duplicates.length > 1 ? 's' : ''}`}
          </span>
          <button className="btn btn--primary" disabled={toAdd === 0} onClick={() => void add()}>
            <UserPlus size={16} /> Adicionar {toAdd > 0 ? toAdd : ''}
          </button>
        </div>
        {preview.kind === 'paired' && preview.mismatch && (names.trim() || users.trim()) && (
          <Notice tone="warn">
            Quantidades diferentes: {preview.nameCount} nomes e {preview.usernameCount} usernames. Você poderá confirmar antes da associação.
          </Notice>
        )}
        {preview.kind === 'paired' && preview.repeatedUsernames.length > 0 && (
          <Notice tone="warn">Usernames repetidos na lista: {preview.repeatedUsernames.join(', ')}</Notice>
        )}
        {preview.duplicates.length > 0 && (
          <Notice tone="info">Serão ignoradas por já existirem: {preview.duplicates.slice(0, 8).join(', ')}{preview.duplicates.length > 8 ? '…' : ''}</Notice>
        )}
      </div>

      <div className="roster">
        <div className="roster__head">
          <div className="roster__total">
            <span className="bignum">{pad(state.participants.length)}</span>
            <span>
              participantes
              <br />
              <span className="muted mono">{withUser} com username</span>
            </span>
          </div>
          {state.participants.length > 0 && (
            <div className="roster__tools">
              <label className="search">
                <Search size={14} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar nome ou username" />
                {query && (
                  <button onClick={() => setQuery('')} aria-label="Limpar busca">
                    <X size={12} />
                  </button>
                )}
              </label>
              <button className="btn btn--ghost btn--sm" onClick={() => void removeAll()}>
                Remover todas
              </button>
            </div>
          )}
        </div>
        {state.participants.length > 0 && (
          <ol className="roster__list">
            {filtered.map((p) => (
              <ParticipantRow
                key={p.id}
                p={p}
                n={state.participants.indexOf(p) + 1}
                onName={(name) => {
                  const clean = cleanName(name);
                  if (!clean) return notify({ kind: 'error', title: 'O nome não pode ficar vazio.' });
                  if (isDuplicateName(state.participants, clean, p.id)) return notify({ kind: 'error', title: `"${clean}" já está cadastrada.` });
                  update(p.id, { name: clean });
                }}
                onUser={(u) => update(p.id, { vjudge: cleanUsername(u) })}
                onRemove={() => commit((s) => removeParticipants(s, new Set([p.id])))}
              />
            ))}
            {filtered.length === 0 && <li className="muted roster__none">Nenhum resultado para "{query}".</li>}
          </ol>
        )}
      </div>
    </section>
  );
}

function ParticipantRow({
  p,
  n,
  onName,
  onUser,
  onRemove,
}: {
  p: Participant;
  n: number;
  onName: (v: string) => void;
  onUser: (v: string) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(p.name);
  const [user, setUser] = useState(p.vjudge);
  // mantém os rascunhos sincronizados se o valor mudar em outro lugar (ex.: tela VJudge, importação)
  useEffect(() => setName(p.name), [p.name]);
  useEffect(() => setUser(p.vjudge), [p.vjudge]);
  return (
    <li className="roster__row">
      <span className="mono roster__n">{pad(n)}</span>
      <input
        
        className="roster__name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name !== p.name && onName(name)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Nome"
      />
      <span className="roster__at mono">@</span>
      <input
        
        className="roster__user mono"
        value={user}
        placeholder="username"
        onChange={(e) => setUser(e.target.value)}
        onBlur={() => user !== p.vjudge && onUser(user)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Username do VJudge"
      />
      <button className="iconbtn iconbtn--sm" onClick={onRemove} aria-label={`Remover ${p.name}`}>
        <Trash2 size={14} />
      </button>
    </li>
  );
}
