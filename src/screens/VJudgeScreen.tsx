import { useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardPaste, ExternalLink, Globe, Info, Lock, PlugZap, RefreshCw, Server, Wand2, XCircle } from 'lucide-react';
import type { Route } from '../App';
import { useStore } from '../state/store';
import { useSync } from '../services/sync';
import { useToasts } from '../components/Toasts';
import { useConfirm } from '../components/Confirm';
import { Notice, SectionHead, Stepper, formatTime } from '../components/ui';
import { Balloon } from '../components/Balloon';
import { buildProblems, contestUrl, parseContestId, parseContestInfo, parseRank, problemCountHint, rankUrl } from '../domain/vjudge';
import { gateway, gatewayUrl } from '../services/gateway';
import { BUILD_GATEWAY_URL } from '../config';
import { parseUsernameList, cleanUsername } from '../domain/participants';
import { problemLetter } from '../domain/ids';
import type { AppState, VJudgeSettings } from '../domain/types';

interface TestResult {
  ok: boolean;
  /** ok: true = passou, false = falhou, null = informação/aviso. */
  lines: { ok: boolean | null; text: string }[];
}

const GATEWAY_MIN_VERSION = '2.1.0';
const versionLt = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};

function AccessBadge({ access }: { access: VJudgeSettings['contestAccess'] }) {
  if (!access) return <span className="accbadge">acesso ainda não verificado</span>;
  if (access === 'public')
    return (
      <span className="accbadge is-ok">
        <Globe size={13} /> público
      </span>
    );
  if (access === 'authorized')
    return (
      <span className="accbadge is-ok">
        <Lock size={13} /> privado · gateway com acesso
      </span>
    );
  return (
    <span className="accbadge is-bad">
      <Lock size={13} /> privado · gateway sem acesso
    </span>
  );
}

export function VJudgeScreen({ go }: { go: (r: Route) => void }) {
  const { state, commit } = useStore();
  const { busy, syncNow, applyPasted, refreshLabs } = useSync();
  const { notify } = useToasts();
  const v = state.vjudge;
  const [pasted, setPasted] = useState('');
  const [problemCount, setProblemCount] = useState(Math.max(1, state.problems.length || 5));
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  const setV = (patch: Partial<VJudgeSettings>) => commit((s) => ({ ...s, vjudge: { ...s.vjudge, ...patch } }));
  const base = gatewayUrl(state);
  const [gwDraft, setGwDraft] = useState(state.gatewayUrl);

  const onContestInput = (text: string) => {
    const id = parseContestId(text) ?? '';
    commit((s) => {
      const changed = id && id !== s.vjudge.contestId;
      return {
        ...s,
        vjudge: {
          ...s.vjudge,
          contestInput: text,
          contestId: id,
          // novo contest: zera metadados da leitura anterior
          ...(changed
            ? { contestTitle: '', begin: null, length: null, lastSyncAt: null, lastSyncOk: null, lastError: null, warning: null, failures: 0, contestAccess: null, seenAccounts: [] }
            : {}),
        },
      };
    });
  };

  /**
   * Testa o fluxo real: gateway → LCC → contest → ranking. Com gateway ≥ 2.1 usa o
   * diagnóstico (/vjudge/diag), que explica por que um contest privado não está acessível.
   */
  const runTest = async () => {
    if (!base) return;
    setTesting(true);
    const lines: TestResult['lines'] = [];
    const push = (l: TestResult['lines'][number]) => {
      lines.push(l);
      setTest({ ok: lines.every((x) => x.ok !== false), lines: [...lines] });
    };
    const step = async (label: string, fn: () => Promise<string>) => {
      const t0 = performance.now();
      try {
        push({ ok: true, text: `${label}: ${await fn()} (${Math.round(performance.now() - t0)} ms)` });
        return true;
      } catch (e) {
        push({ ok: false, text: `${label}: ${e instanceof Error ? e.message : 'erro'}` });
        return false;
      }
    };
    let version = '';
    const online = await step('Gateway', async () => {
      version = (await gateway.health(base)).version;
      return `online, versão ${version}`;
    });
    if (online && versionLt(version, GATEWAY_MIN_VERSION))
      push({ ok: null, text: `Gateway publicado está na versão ${version}. Publique a ${GATEWAY_MIN_VERSION} (gateway/dist/wcc-gateway.js) para contests privados e diagnóstico.` });
    await step('Site do LCC', async () => {
      const r = await gateway.labs(base);
      return r.labs.map((l) => `${l.id}=${l.machines}`).join(', ');
    });
    if (v.contestId && online) {
      if (!versionLt(version, GATEWAY_MIN_VERSION)) {
        try {
          const d = await gateway.diag(base, v.contestId);
          const c = d.contest;
          if (c && !c.error) {
            const acc = c.access === 'public' ? 'público' : c.access === 'authorized' ? 'privado · acesso autorizado' : 'privado · SEM acesso';
            push({ ok: c.access !== 'restricted', text: `Contest: "${c.title}" · ${acc} · ${c.problemsVisible ? `${c.problems} questões` : 'questões ocultas'}` });
            commit((s) => ({ ...s, vjudge: { ...s.vjudge, contestAccess: c.access ?? s.vjudge.contestAccess, contestTitle: c.title || s.vjudge.contestTitle } }));
          } else push({ ok: false, text: `Contest: ${c?.error ?? 'sem resposta'}` });
          if (d.rank && !d.rank.error)
            push({ ok: d.rank.participants > 0 || c?.access !== 'restricted' ? true : null, text: `Ranking: ${d.rank.participants} contas · ${d.rank.submissions} submissões (${d.rank.accepted} aceitas)` });
          else push({ ok: false, text: `Ranking: ${d.rank?.error ?? 'sem resposta'}` });
          const cfg = d.config;
          push({
            ok: null,
            text: `Configuração do gateway: sessão (VJUDGE_COOKIE) ${cfg.cookieConfigured ? (cfg.cookieUsedForThisRequest ? 'em uso' : 'presente, mas não usada para esta origem') : 'ausente'} · senha do contest ${cfg.accessCodeConfigured ? `presente (${cfg.accessCodeVariable})` : 'ausente'}${d.enterContest?.attempted ? ` · entrada no contest: ${d.enterContest.ok ? 'ok' : d.enterContest.vjudgeReason}` : ''}`,
          });
          d.hints.forEach((h) => push({ ok: null, text: h }));
        } catch (e) {
          push({ ok: false, text: `Diagnóstico: ${e instanceof Error ? e.message : 'erro'}` });
        }
      } else {
        let hidden = false;
        await step('Contest', async () => {
          const info = parseContestInfo(await gateway.contest(base, v.contestId));
          hidden = !info.problems;
          return info.problems ? `"${info.title}" · ${info.problems.length} questões` : `"${info.title}" · privado`;
        });
        if (hidden) push({ ok: false, text: 'Questões ocultas: o gateway não tem acesso a este contest privado.' });
        try {
          const rank = parseRank(await gateway.rank(base, v.contestId));
          const empty = rank.accounts.size === 0;
          push({
            ok: empty && hidden ? false : empty ? null : true,
            text: `Ranking: ${rank.accounts.size} contas · ${rank.submissions.length} submissões (${rank.submissions.filter((x) => x.accepted).length} aceitas)${
              empty && hidden ? ' — vazio porque o gateway não tem acesso; não dá para saber se há submissões' : empty ? ' — ainda sem submissões' : ''
            }`,
          });
        } catch (e) {
          push({ ok: false, text: `Ranking: ${e instanceof Error ? e.message : 'erro'}` });
        }
      }
    }
    setTesting(false);
  };

  const saveGateway = () => {
    const url = gwDraft.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//.test(url)) return notify({ kind: 'error', title: 'A URL do gateway deve começar com https://' });
    commit((s) => ({
      ...s,
      gatewayUrl: url,
      vjudge: { ...s.vjudge, source: url || BUILD_GATEWAY_URL ? 'gateway' : s.vjudge.source, autoPoll: url || BUILD_GATEWAY_URL ? true : s.vjudge.autoPoll, contestAccess: null, failures: 0 },
    }));
    setTest(null);
    if (url || BUILD_GATEWAY_URL) window.setTimeout(() => void refreshLabs(), 50);
  };

  const importProblems = async () => {
    try {
      const info = parseContestInfo(await gateway.contest(base, v.contestId));
      const meta = (st: AppState): AppState['vjudge'] => ({
        ...st.vjudge,
        contestTitle: info.title || st.vjudge.contestTitle,
        begin: info.begin ?? st.vjudge.begin,
        length: info.begin && info.end ? info.end - info.begin : st.vjudge.length,
      });
      if (!info.problems) {
        // Contest privado sem acesso: o VJudge esconde as questões. Se o ranking tiver dados, sugere a quantidade.
        const hint = problemCountHint(parseRank(await gateway.rank(base, v.contestId)));
        commit((s) => ({ ...s, vjudge: meta(s) }));
        if (hint) setProblemCount(Math.max(hint, problemCount));
        notify({
          kind: 'info',
          title: `"${info.title}" é privado: o VJudge não revela as questões sem login`,
          detail: hint
            ? `O ranking tem submissões em ${hint} questões. Confira a quantidade e clique em "Gerar questões".`
            : 'Defina a quantidade de questões manualmente ou dê acesso ao gateway (veja Testar conexão).',
          ttl: 12000,
        });
        return;
      }
      commit((s) => ({ ...s, problems: buildProblems(s.problems, info.problems!), vjudge: meta(s) }));
      notify({ kind: 'success', title: `${info.problems.length} questões importadas do VJudge` });
    } catch (e) {
      notify({ kind: 'error', title: 'Não foi possível importar as questões', detail: e instanceof Error ? e.message : undefined });
    }
  };

  const generateProblems = () => {
    commit((s) => ({ ...s, problems: buildProblems(s.problems, Array.from({ length: problemCount }, (_, i) => ({ num: s.problems[i]?.letter ?? problemLetter(i), title: s.problems[i]?.title ?? '' }))) }));
  };

  const processPasted = () => {
    try {
      const n = applyPasted(pasted);
      notify({ kind: 'success', title: 'Ranking processado', detail: n ? `${n} novo(s) Accepted` : 'Nenhum Accepted novo' });
      setPasted('');
    } catch (e) {
      notify({ kind: 'error', title: 'Não foi possível ler o ranking', detail: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <div className="screen vj">
      <div className="screen-title">
        <div>
          <span className="eyebrow mono">// 03 — vjudge</span>
          <h1>Conecte o contest</h1>
        </div>
      </div>

      <section className="section">
        <SectionHead index="01" title="Contest">
          Cole o link do contest (ex.: https://vjudge.net/contest/870665) ou apenas o número.
        </SectionHead>
        <div className="vj-contest">
          <label className="field field--xl">
            <span className="label">Link ou ID</span>
            <input value={v.contestInput} onChange={(e) => onContestInput(e.target.value)} placeholder="https://vjudge.net/contest/870665" spellCheck={false} />
          </label>
          <div className="vj-contest__id">
            {v.contestId ? (
              <>
                <span className="mono vj-contest__num">#{v.contestId}</span>
                {v.contestTitle && <span className="vj-contest__title">{v.contestTitle}</span>}
                <a className="link" href={contestUrl(v.contestId)} target="_blank" rel="noreferrer">
                  abrir contest <ExternalLink size={12} />
                </a>
              </>
            ) : (
              v.contestInput && <span className="error-text">Não reconheci um ID de contest nesse texto.</span>
            )}
          </div>
        </div>

        {v.contestId && (
          <div className="vj-access">
            <AccessBadge access={v.contestAccess} />
            {v.contestAccess === 'restricted' && (
              <Notice tone="warn">
                <span>
                  Este contest é <b>privado</b> e o gateway ainda não tem acesso: o VJudge devolve as questões ocultas e o ranking vazio. O VJudge só
                  aceita a senha do contest de uma <b>conta logada</b>, por isso o gateway precisa também do segredo <code>VJUDGE_COOKIE</code> (sessão
                  dessa conta). A senha nunca fica no app. Passo a passo em <code>gateway/README.md</code>; o botão <b>Testar conexão</b> mostra o que falta.
                </span>
              </Notice>
            )}
          </div>
        )}
      </section>

      <section className="section">
        <SectionHead index="02" title="WCC Gateway">
          O VJudge e o site do LCC não liberam acesso direto de outros sites (não enviam cabeçalhos CORS). O WCC Gateway, um
          Cloudflare Worker gratuito do próprio WCC (pasta <code>gateway/</code>), faz essas consultas e permite a atualização automática.
        </SectionHead>
        <div className="gw">
          <label className="field">
            <span className="label">URL do gateway</span>
            <input
              value={gwDraft}
              onChange={(e) => setGwDraft(e.target.value)}
              onBlur={() => gwDraft.trim().replace(/\/+$/, '') !== state.gatewayUrl && saveGateway()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder={BUILD_GATEWAY_URL || 'https://wcc-gateway.<sua-conta>.workers.dev'}
              spellCheck={false}
              className="mono"
            />
          </label>
          <span className="muted gw__hint">
            {BUILD_GATEWAY_URL
              ? state.gatewayUrl
                ? 'Sobrescrevendo o gateway padrão deste site.'
                : 'Usando o gateway padrão configurado na publicação deste site.'
              : base
                ? ''
                : 'Sem gateway: os laboratórios usam a cópia do build e o ranking precisa ser colado manualmente.'}
          </span>
          <div className="row-gap">
            <button className="btn btn--ghost" disabled={!base || testing} onClick={() => void runTest()}>
              <PlugZap size={16} /> {testing ? 'Testando…' : 'Testar conexão'}
            </button>
          </div>
          {test && (
            <ul className={`testres ${test.ok ? 'is-ok' : 'is-bad'}`}>
              {test.lines.map((l, i) => (
                <li key={i} className={l.ok === null ? 'is-info' : l.ok ? '' : 'is-fail'}>
                  {l.ok === null ? <Info size={15} /> : l.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />} <span>{l.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="sources">
          <SourceCard
            on={v.source === 'gateway'}
            onClick={() => setV({ source: 'gateway' })}
            icon={<Server size={20} />}
            title="Automático (gateway)"
            desc="O ranking é consultado periodicamente; os Accepted aparecem sozinhos na Arena."
          />
          <SourceCard
            on={v.source === 'paste'}
            onClick={() => setV({ source: 'paste', autoPoll: false })}
            icon={<ClipboardPaste size={20} />}
            title="Colar JSON (contingência)"
            desc="Sem gateway ou se ele falhar: abra o ranking em outra aba, copie e cole aqui."
          />
        </div>

        {v.source === 'gateway' ? (
          <div className="proxy">
            <div className="poll">
              <label className="switch">
                <input type="checkbox" checked={v.autoPoll} disabled={!base || !v.contestId} onChange={(e) => setV({ autoPoll: e.target.checked, failures: 0 })} />
                <span className="switch__track" />
                Atualização automática
              </label>
              <span className="muted">a cada</span>
              <Stepper value={v.pollSeconds} min={10} max={600} label="segundos entre atualizações" onChange={(n) => setV({ pollSeconds: n })} />
              <span className="muted">segundos</span>
              <button className="btn btn--ghost btn--sm" disabled={!base || !v.contestId || busy} onClick={() => void syncNow()}>
                <RefreshCw size={14} className={busy ? 'spin' : ''} /> Atualizar agora
              </button>
            </div>
            {!base && <Notice tone="warn">Informe a URL do gateway acima para ativar a atualização automática.</Notice>}
            <SyncStatus v={v} />
          </div>
        ) : (
          <div className="pastebox">
            <ol className="steps-list">
              <li>
                {v.contestId ? (
                  <a className="link" href={rankUrl(v.contestId)} target="_blank" rel="noreferrer">
                    Abra o JSON do ranking <ExternalLink size={12} />
                  </a>
                ) : (
                  'Informe o contest acima para gerar o link do ranking'
                )}{' '}
                <span className="muted mono">{v.contestId ? rankUrl(v.contestId) : ''}</span>
              </li>
              <li>Selecione tudo (Ctrl+A) e copie (Ctrl+C).</li>
              <li>Cole abaixo e clique em processar. Repita quando quiser atualizar.</li>
            </ol>
            <textarea className="mono" rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"id":870665,"title":"…","participants":{…},"submissions":[…]}' spellCheck={false} />
            <div className="row-gap">
              <button className="btn btn--primary" disabled={!pasted.trim()} onClick={processPasted}>
                Processar ranking
              </button>
              <SyncStatus v={v} />
            </div>
          </div>
        )}
      </section>

      <section className="section">
        <SectionHead index="03" title="Questões e balões">
          Cada questão tem uma cor de balão. Escolha qualquer cor; dá para mudar depois, também na Arena.
        </SectionHead>
        <div className="row-gap">
          {base && v.contestId && (
            <button className="btn btn--ghost" onClick={() => void importProblems()}>
              <Wand2 size={16} /> Importar questões do contest
            </button>
          )}
          <span className="muted">ou defina manualmente:</span>
          <Stepper value={problemCount} min={1} max={30} label="quantidade de questões" onChange={setProblemCount} />
          <button className="btn btn--ghost" onClick={generateProblems}>
            {state.problems.length ? 'Ajustar quantidade' : 'Gerar questões'}
          </button>
        </div>
        {state.problems.length > 0 && <ProblemEditor />}
      </section>

      <section className="section">
        <SectionHead index="04" title="Contas do VJudge">
          Associe cada {state.mode === 'team' ? 'equipe' : 'participante'} à sua conta. Alterar um username não apaga submissões nem balões já
          registrados. {state.mode === 'team' && 'Em grupo, contam os Accepted da conta da equipe e das contas das integrantes.'}
        </SectionHead>
        <AccountsEditor />
      </section>

      <div className="cta">
        <span className="mono muted">
          {state.problems.length} questões · {state.participants.filter((p) => p.vjudge).length}/{state.participants.length} usernames
        </span>
        <button className="btn btn--primary btn--lg" onClick={() => go('painel')}>
          Abrir a Arena <ArrowRight size={18} />
        </button>
      </div>
    </div>
  );
}

function SourceCard({ on, onClick, icon, title, desc }: { on: boolean; onClick: () => void; icon: ReactNode; title: string; desc: string }) {
  return (
    <button className={`source ${on ? 'is-on' : ''}`} onClick={onClick} aria-pressed={on}>
      <span className="source__icon">{icon}</span>
      <span className="source__title">{title}</span>
      <span className="source__desc">{desc}</span>
    </button>
  );
}

export function SyncStatus({ v }: { v: VJudgeSettings }) {
  if (v.lastSyncOk === false)
    return (
      <span className="syncstatus is-bad" title={v.lastError ?? ''}>
        <XCircle size={14} /> {v.failures > 1 ? `${v.failures} falhas seguidas` : 'falhou'}
        {v.lastSyncAt ? ` · último dado ${formatTime(v.lastSyncAt)}` : ''} — {v.lastError}
      </span>
    );
  if (v.lastSyncAt && v.warning)
    return (
      <span className="syncstatus is-warn" title={v.warning}>
        <AlertTriangle size={14} /> leitura {formatTime(v.lastSyncAt)} — {v.warning}
      </span>
    );
  if (v.lastSyncAt)
    return (
      <span className="syncstatus is-ok">
        <CheckCircle2 size={14} /> última leitura {formatTime(v.lastSyncAt)}
      </span>
    );
  return <span className="syncstatus muted">nenhuma leitura ainda</span>;
}

export function ProblemEditor({ compact = false }: { compact?: boolean }) {
  const { state, commit } = useStore();
  const update = (index: number, patch: { title?: string; color?: string; letter?: string }) =>
    commit((s) => ({ ...s, problems: s.problems.map((p) => (p.index === index ? { ...p, ...patch } : p)) }));
  return (
    <div className={`problems ${compact ? 'is-compact' : ''}`}>
      {state.problems.map((p) => (
        <div key={p.index} className="problem">
          <label className="problem__color" title="Cor do balão" style={{ ['--c' as string]: p.color }}>
            <Balloon color={p.color} size={compact ? 26 : 34} />
            <input type="color" value={p.color} onChange={(e) => update(p.index, { color: e.target.value })} aria-label={`Cor do balão da questão ${p.letter}`} />
          </label>
          <span className="problem__letter mono">{p.letter}</span>
          {!compact && (
            <input className="problem__title" value={p.title} placeholder="título (opcional)" onChange={(e) => update(p.index, { title: e.target.value })} aria-label={`Título da questão ${p.letter}`} />
          )}
          <span className="problem__hex mono">{p.color.toUpperCase()}</span>
        </div>
      ))}
    </div>
  );
}

function AccountsEditor() {
  const { state, commit, units } = useStore();
  const confirm = useConfirm();
  const { notify } = useToasts();
  const [bulk, setBulk] = useState('');
  const seen = new Set(state.vjudge.seenAccounts);
  const hasSeen = state.vjudge.lastSyncAt !== null;

  const setUser = (pid: string, u: string) =>
    commit((s) => ({ ...s, participants: s.participants.map((p) => (p.id === pid ? { ...p, vjudge: cleanUsername(u) } : p)) }));
  const setTeamUser = (tid: string, u: string) => commit((s) => ({ ...s, teams: s.teams.map((t) => (t.id === tid ? { ...t, vjudge: cleanUsername(u) } : t)) }));

  const applyBulk = async () => {
    const list = parseUsernameList(bulk);
    const n = state.participants.length;
    if (list.length !== n) {
      const ok = await confirm({
        title: 'Quantidades diferentes',
        body: `Há ${n} participantes e ${list.length} usernames. A associação segue a ordem da lista de participantes; ${
          list.length < n ? `as últimas ${n - list.length} ficarão como estão.` : `os últimos ${list.length - n} usernames serão ignorados.`
        }`,
        confirmLabel: 'Associar mesmo assim',
      });
      if (!ok) return;
    }
    commit((s: AppState) => ({ ...s, participants: s.participants.map((p, i) => (i < list.length ? { ...p, vjudge: list[i] } : p)) }));
    notify({ kind: 'success', title: `${Math.min(n, list.length)} usernames associados` });
    setBulk('');
  };

  const chip = (u: string) => {
    if (!u) return <span className="acc acc--none">sem conta</span>;
    if (!hasSeen) return null;
    return seen.has(u.toLowerCase()) ? (
      <span className="acc acc--ok" title="Esta conta aparece no ranking do contest">no ranking</span>
    ) : (
      <span className="acc acc--wait" title="Ainda não apareceu no ranking. No VJudge, a conta só aparece após a primeira submissão.">ainda não apareceu</span>
    );
  };

  if (!state.participants.length) return <Notice tone="info">Cadastre participantes na etapa 01.</Notice>;

  return (
    <div className="accounts">
      <details className="bulk">
        <summary>Colar usernames na ordem da lista de participantes</summary>
        <textarea className="mono" rows={5} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'ana123\nbia456\ncamila789'} />
        <button className="btn btn--ghost" disabled={!bulk.trim()} onClick={() => void applyBulk()}>
          Associar pela ordem
        </button>
      </details>
      <div className="acctable" role="table">
        {state.mode === 'individual'
          ? state.participants.map((p) => (
              <div className="acctable__row" role="row" key={p.id}>
                <span className="acctable__name">{p.name}</span>
                <UserInput value={p.vjudge} onCommit={(u) => setUser(p.id, u)} />
                {chip(p.vjudge)}
              </div>
            ))
          : units.map((u) => {
              const team = state.teams.find((t) => t.id === u.id)!;
              return (
                <div className="acctable__group" key={u.id}>
                  <div className="acctable__row is-team" role="row">
                    <span className="acctable__name">
                      <b>{u.name}</b> <span className="muted">conta da equipe</span>
                    </span>
                    <UserInput value={team.vjudge} onCommit={(x) => setTeamUser(team.id, x)} />
                    {team.vjudge ? chip(team.vjudge) : <span className="acc acc--none">opcional</span>}
                  </div>
                  {u.members.map((m) => (
                    <div className="acctable__row is-member" role="row" key={m.id}>
                      <span className="acctable__name">{m.name}</span>
                      <UserInput value={m.vjudge} onCommit={(x) => setUser(m.id, x)} />
                      {chip(m.vjudge)}
                    </div>
                  ))}
                </div>
              );
            })}
      </div>
    </div>
  );
}

function UserInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setDraft(value);
  }
  return (
    <input
      className="acctable__input mono"
      value={draft}
      placeholder="username"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      spellCheck={false}
      aria-label="Username do VJudge"
    />
  );
}
