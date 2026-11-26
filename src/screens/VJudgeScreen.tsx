import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardPaste,
  ExternalLink,
  Globe,
  Info,
  Lock,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Wand2,
  XCircle,
} from 'lucide-react';
import type { Route } from '../App';
import { useStore } from '../state/store';
import { useSync } from '../services/sync';
import { useToasts } from '../components/Toasts';
import { useConfirm } from '../components/Confirm';
import { Notice, SectionHead, Stepper, formatTime } from '../components/ui';
import { Balloon } from '../components/Balloon';
import { buildProblems, contestUrl, parseContestId, parseContestInfo, parseRank, problemCountHint, rankUrl } from '../domain/vjudge';
import {
  allProblems,
  contestHasData,
  findContest,
  newContest,
  removeContest,
  setContestLink,
  updateContest,
} from '../domain/contests';
import { gateway, gatewayUrl } from '../services/gateway';
import { AuthCard, EnterContest, authLabel, useGatewayAuth, type AuthView } from './vjudge/GatewayAuth';
import { BUILD_GATEWAY_URL } from '../config';
import { parseUsernameList, cleanUsername } from '../domain/participants';
import { problemLetter } from '../domain/ids';
import type { AppState, Contest, VJudgeSettings } from '../domain/types';

interface TestResult {
  ok: boolean;
  /** ok: true = passou, false = falhou, null = informação/aviso. */
  lines: { ok: boolean | null; text: string }[];
}

/** Versão com diagnóstico (2.1) e com login automático da conta (2.2). */
const GATEWAY_DIAG_VERSION = '2.1.0';
const GATEWAY_MIN_VERSION = '2.2.0';
const versionLt = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};

function AccessBadge({ access }: { access: Contest['contestAccess'] }) {
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
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  const setV = (patch: Partial<VJudgeSettings>) => commit((s) => ({ ...s, vjudge: { ...s.vjudge, ...patch } }));
  const base = gatewayUrl(state);
  const [gwDraft, setGwDraft] = useState(state.gatewayUrl);
  const [authReq, setAuthReq] = useState({ n: 0, force: false });
  const refreshAuth = (force = false) => setAuthReq((r) => ({ n: r.n + 1, force }));
  const auth = useGatewayAuth(base, authReq);
  const linked = state.contests.filter((c) => c.contestId);
  const multi = state.contests.length > 1;

  /**
   * Testa o fluxo real: gateway → LCC → cada contest → ranking. Com gateway ≥ 2.1 usa o
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
      push({ ok: null, text: `Gateway publicado está na versão ${version}. Publique a ${GATEWAY_MIN_VERSION} (gateway/dist/wcc-gateway.js) para o login automático da conta do VJudge.` });
    await step('Site do LCC', async () => {
      const r = await gateway.labs(base);
      return r.labs.map((l) => `${l.id}=${l.machines}`).join(', ');
    });
    if (online) {
      for (const c of linked) {
        const pre = multi ? `[${c.tag}] ` : '';
        if (!versionLt(version, GATEWAY_DIAG_VERSION)) {
          try {
            const d = await gateway.diag(base, c.contestId);
            const ci = d.contest;
            if (ci && !ci.error) {
              const acc =
                ci.access === 'public'
                  ? 'público'
                  : ci.access === 'authorized'
                    ? `privado · acesso autorizado${ci.role === 'manager' ? ' (gerente)' : ''}`
                    : 'privado · SEM acesso';
              push({ ok: ci.access !== 'restricted', text: `${pre}Contest: "${ci.title}" · ${acc} · ${ci.problemsVisible ? `${ci.problems} questões` : 'questões ocultas'}` });
              commit((s) => updateContest(s, c.key, (x) => ({ ...x, contestAccess: ci.access ?? x.contestAccess, contestTitle: ci.title || x.contestTitle })));
            } else push({ ok: false, text: `${pre}Contest: ${ci?.error ?? 'sem resposta'}` });
            if (d.rank && !d.rank.error)
              push({
                ok: d.rank.participants > 0 || ci?.access !== 'restricted' ? true : null,
                text: `${pre}Ranking: ${d.rank.participants} contas · ${d.rank.submissions} submissões (${d.rank.accepted} aceitas)`,
              });
            else push({ ok: false, text: `${pre}Ranking: ${d.rank?.error ?? 'sem resposta'}` });
            const cfg = d.config;
            const used = cfg.sessionUsedForThisRequest ?? cfg.cookieUsedForThisRequest;
            const mode =
              cfg.authMode === 'account'
                ? `conta ${d.auth?.username ?? ''} (${authLabel(d.auth?.status)})`
                : cfg.cookieConfigured
                  ? 'cookie copiado (legado)'
                  : 'nenhuma credencial';
            push({
              ok: null,
              text: `${pre}Gateway: ${mode}${cfg.authMode && cfg.authMode !== 'none' && !used ? ' — não usada para esta origem' : ''} · senha do contest ${
                cfg.accessCodeFromApp ? 'informada no app' : cfg.accessCodeConfigured ? `em segredo (${cfg.accessCodeVariable})` : 'não informada'
              }${d.enterContest?.attempted ? ` · entrada no contest: ${d.enterContest.ok ? 'ok' : d.enterContest.vjudgeReason}` : ''}`,
            });
            d.hints.forEach((h) => push({ ok: null, text: `${pre}${h}` }));
          } catch (e) {
            push({ ok: false, text: `${pre}Diagnóstico: ${e instanceof Error ? e.message : 'erro'}` });
          }
        } else {
          let hidden = false;
          await step(`${pre}Contest`, async () => {
            const info = parseContestInfo(await gateway.contest(base, c.contestId));
            hidden = !info.problems;
            return info.problems ? `"${info.title}" · ${info.problems.length} questões` : `"${info.title}" · privado`;
          });
          if (hidden) push({ ok: false, text: `${pre}Questões ocultas: o gateway não tem acesso a este contest privado.` });
          try {
            const rank = parseRank(await gateway.rank(base, c.contestId));
            const empty = rank.accounts.size === 0;
            push({
              ok: empty && hidden ? false : empty ? null : true,
              text: `${pre}Ranking: ${rank.accounts.size} contas · ${rank.submissions.length} submissões (${rank.submissions.filter((x) => x.accepted).length} aceitas)${
                empty && hidden ? ' — vazio porque o gateway não tem acesso; não dá para saber se há submissões' : empty ? ' — ainda sem submissões' : ''
              }`,
            });
          } catch (e) {
            push({ ok: false, text: `${pre}Ranking: ${e instanceof Error ? e.message : 'erro'}` });
          }
        }
      }
    }
    setTesting(false);
    refreshAuth();
  };

  const saveGateway = () => {
    const url = gwDraft.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//.test(url)) return notify({ kind: 'error', title: 'A URL do gateway deve começar com https://' });
    commit((s) => ({
      ...s,
      gatewayUrl: url,
      vjudge: { ...s.vjudge, source: url || BUILD_GATEWAY_URL ? 'gateway' : s.vjudge.source, autoPoll: url || BUILD_GATEWAY_URL ? true : s.vjudge.autoPoll },
      contests: s.contests.map((c) => ({ ...c, contestAccess: null, failures: 0 })),
    }));
    setTest(null);
    if (url || BUILD_GATEWAY_URL) window.setTimeout(() => void refreshLabs(), 50);
    refreshAuth();
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

  const addContest = () => commit((s) => ({ ...s, contests: [...s.contests, newContest(s.contests)] }));
  const totalProblems = allProblems(state).length;

  return (
    <div className="screen vj">
      <div className="screen-title">
        <div>
          <span className="eyebrow mono">// 03 — vjudge</span>
          <h1>{multi ? 'Conecte os contests' : 'Conecte o contest'}</h1>
        </div>
      </div>

      <section className="section">
        <SectionHead index="01" title={multi ? 'Contests' : 'Contest'}>
          Cole o link do contest (ex.: https://vjudge.net/contest/870665) ou apenas o número. Para acompanhar mais de um contest ao mesmo tempo (por
          exemplo, divisões iniciante e avançada na mesma sala), adicione outro: cada um tem as próprias questões e cores, e a Arena mostra todos
          juntos ou um de cada vez.
        </SectionHead>
        <div className="contests">
          {state.contests.map((c) => (
            <ContestCard key={c.key} contest={c} multi={multi} base={base} auth={auth} refreshAuth={refreshAuth} />
          ))}
        </div>
        <button className="btn btn--ghost addcontest" onClick={addContest}>
          <Plus size={16} /> Adicionar outro contest
        </button>
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
          {base && <AuthCard auth={auth} onReconnect={() => refreshAuth(true)} />}
          <div className="row-gap">
            <button className="btn btn--ghost" disabled={!base || testing} onClick={() => void runTest()}>
              <PlugZap size={16} /> {testing ? <span className="caret">testando</span> : 'Testar conexão'}
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
            desc="Os rankings são consultados periodicamente; os Accepted aparecem sozinhos na Arena."
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
                <input type="checkbox" checked={v.autoPoll} disabled={!base || !linked.length} onChange={(e) => setV({ autoPoll: e.target.checked })} />
                <span className="switch__track" />
                Atualização automática
              </label>
              <span className="muted">a cada</span>
              <Stepper value={v.pollSeconds} min={10} max={600} label="segundos entre atualizações" onChange={(n) => setV({ pollSeconds: n })} />
              <span className="muted">segundos{linked.length > 1 ? ` (os ${linked.length} contests, um após o outro)` : ''}</span>
              <button className="btn btn--ghost btn--sm" disabled={!base || !linked.length || busy} onClick={() => void syncNow()}>
                <RefreshCw size={14} className={busy ? 'spin' : ''} /> Atualizar agora
              </button>
            </div>
            {!base && <Notice tone="warn">Informe a URL do gateway acima para ativar a atualização automática.</Notice>}
          </div>
        ) : (
          <div className="pastebox">
            <ol className="steps-list">
              <li>
                Abra o JSON do ranking de cada contest:{' '}
                {linked.length
                  ? linked.map((c) => (
                      <a key={c.key} className="link" href={rankUrl(c.contestId)} target="_blank" rel="noreferrer">
                        {multi ? `${c.tag} ` : ''}#{c.contestId} <ExternalLink size={12} />
                      </a>
                    ))
                  : 'informe o contest acima para gerar o link do ranking'}
              </li>
              <li>Selecione tudo (Ctrl+A) e copie (Ctrl+C).</li>
              <li>Cole abaixo e clique em processar — o contest é reconhecido pelo ID do JSON. Repita quando quiser atualizar.</li>
            </ol>
            <textarea className="mono" rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"id":870665,"title":"…","participants":{…},"submissions":[…]}' spellCheck={false} />
            <div className="row-gap">
              <button className="btn btn--primary" disabled={!pasted.trim()} onClick={processPasted}>
                Processar ranking
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="section">
        <SectionHead index="03" title="Contas do VJudge">
          Associe cada {state.mode === 'team' ? 'equipe' : 'participante'} à sua conta. Alterar um username não apaga submissões nem balões já
          registrados. {state.mode === 'team' && 'Em grupo, contam os Accepted da conta da equipe e das contas das integrantes.'}
          {multi && ' A mesma conta vale para todos os contests: cada participante aparece nos contests em que submeter.'}
        </SectionHead>
        <AccountsEditor />
      </section>

      <div className="cta">
        <span className="mono muted">
          {multi ? `${state.contests.length} contests · ` : ''}
          {totalProblems} questões · {state.participants.filter((p) => p.vjudge).length}/{state.participants.length} usernames
        </span>
        <button className="btn btn--primary btn--lg" onClick={() => go('painel')}>
          Abrir a Arena <ArrowRight size={18} />
        </button>
      </div>
    </div>
  );
}

/** Um contest: link, acesso, sincronização e questões/cores. */
function ContestCard({
  contest: c,
  multi,
  base,
  auth,
  refreshAuth,
}: {
  contest: Contest;
  multi: boolean;
  base: string;
  auth: AuthView;
  refreshAuth: (force?: boolean) => void;
}) {
  const { state, commit } = useStore();
  const { busy, syncNow } = useSync();
  const { notify } = useToasts();
  const confirm = useConfirm();
  const [draft, setDraft] = useState(c.contestInput);
  const [lastInput, setLastInput] = useState(c.contestInput);
  if (c.contestInput !== lastInput) {
    setLastInput(c.contestInput);
    setDraft(c.contestInput);
  }
  const [problemCount, setProblemCount] = useState(Math.max(1, c.problems.length || 5));
  const draftId = parseContestId(draft);

  const commitLink = async () => {
    if (draft === c.contestInput) return;
    const id = parseContestId(draft) ?? '';
    if (id && state.contests.some((o) => o.key !== c.key && o.contestId === id)) {
      notify({ kind: 'error', title: `O contest #${id} já está na lista.` });
      setDraft(c.contestInput);
      return;
    }
    if (id && c.contestId && id !== c.contestId && contestHasData(state, c)) {
      const ok = await confirm({
        title: `Trocar o contest #${c.contestId} pelo #${id}?`,
        body: 'Os Accepted e as entregas de balão registrados para o contest atual serão apagados, junto com as questões e cores dele.',
        confirmLabel: 'Trocar contest',
        danger: true,
      });
      if (!ok) {
        setDraft(c.contestInput);
        return;
      }
    }
    commit((s) => setContestLink(s, c.key, draft, id));
  };

  const remove = async () => {
    const has = contestHasData(state, c);
    const ok = await confirm({
      title: `Remover ${multi ? c.tag : 'o contest'}${c.contestId ? ` (#${c.contestId})` : ''}?`,
      body: has
        ? 'Os Accepted e as entregas de balão registrados para este contest serão apagados. Os outros contests não são afetados.'
        : 'As questões e cores deste contest serão removidas.',
      confirmLabel: 'Remover',
      danger: has,
    });
    if (ok) commit((s) => removeContest(s, c.key));
  };

  const offset = () => state.contests.filter((o) => o.key !== c.key).reduce((a, o) => a + o.problems.length, 0);

  const importProblems = async () => {
    try {
      const info = parseContestInfo(await gateway.contest(base, c.contestId));
      const meta = (x: Contest): Contest => ({
        ...x,
        contestTitle: info.title || x.contestTitle,
        begin: info.begin ?? x.begin,
        length: info.begin && info.end ? info.end - info.begin : x.length,
      });
      if (!info.problems) {
        // Contest privado sem acesso: o VJudge esconde as questões. Se o ranking tiver dados, sugere a quantidade.
        const hint = problemCountHint(parseRank(await gateway.rank(base, c.contestId)));
        commit((s) => updateContest(s, c.key, meta));
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
      commit((s) => updateContest(s, c.key, (x) => ({ ...meta(x), problems: buildProblems(c.key, x.problems, info.problems!, offset()) })));
      notify({ kind: 'success', title: `${info.problems.length} questões importadas do VJudge` });
    } catch (e) {
      notify({ kind: 'error', title: 'Não foi possível importar as questões', detail: e instanceof Error ? e.message : undefined });
    }
  };

  const generateProblems = () =>
    commit((s) =>
      updateContest(s, c.key, (x) => ({
        ...x,
        problems: buildProblems(
          c.key,
          x.problems,
          Array.from({ length: problemCount }, (_, i) => ({ num: x.problems[i]?.letter ?? problemLetter(i), title: x.problems[i]?.title ?? '' })),
          offset(),
        ),
      })),
    );

  return (
    <article className="ccard">
      <header className="ccard__head">
        {multi && (
          <label className="ccard__tag" title="Sigla curta usada na Arena para distinguir as questões dos contests">
            <span className="label">Sigla</span>
            <input
              className="mono"
              value={c.tag}
              maxLength={6}
              onChange={(e) => {
                const tag = e.target.value.toUpperCase().replace(/\s+/g, '');
                commit((s) => updateContest(s, c.key, (x) => ({ ...x, tag })));
              }}
              onBlur={() => !c.tag && commit((s) => updateContest(s, c.key, (x) => ({ ...x, tag: `C${s.contests.indexOf(x) + 1}` })))}
              aria-label="Sigla do contest"
            />
          </label>
        )}
        <label className="field field--xl ccard__link">
          <span className="label">Link ou ID</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitLink()}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            placeholder="https://vjudge.net/contest/870665"
            spellCheck={false}
          />
        </label>
        {(multi || c.contestId) && (
          <button className="iconbtn ccard__remove" onClick={() => void remove()} aria-label="Remover contest" title="Remover contest">
            <Trash2 size={16} />
          </button>
        )}
      </header>

      <div className="vj-contest__id">
        {c.contestId ? (
          <>
            <span className="mono vj-contest__num">#{c.contestId}</span>
            {c.contestTitle && <span className="vj-contest__title">{c.contestTitle}</span>}
            <a className="link" href={contestUrl(c.contestId)} target="_blank" rel="noreferrer">
              abrir contest <ExternalLink size={12} />
            </a>
          </>
        ) : draft && !draftId ? (
          <span className="error-text">Não reconheci um ID de contest nesse texto.</span>
        ) : (
          <span className="muted">{draft ? 'Saia do campo (ou Enter) para confirmar.' : 'Nenhum contest informado.'}</span>
        )}
      </div>

      {c.contestId && (
        <div className="vj-access">
          <AccessBadge access={c.contestAccess} />
          {c.contestAccess === 'restricted' && (
            <EnterContest
              base={base}
              contestId={c.contestId}
              auth={auth}
              onEntered={(access) => {
                commit((s) => updateContest(s, c.key, (x) => ({ ...x, contestAccess: access, warning: null })));
                refreshAuth();
                void syncNow({ contestKey: c.key });
              }}
            />
          )}
          <div className="ccard__sync">
            <SyncStatus c={c} />
            {state.vjudge.source === 'gateway' && (
              <button className="btn btn--ghost btn--sm" disabled={!base || busy} onClick={() => void syncNow({ contestKey: c.key })}>
                <RefreshCw size={14} className={busy ? 'spin' : ''} /> Atualizar
              </button>
            )}
          </div>
        </div>
      )}

      <div className="ccard__problems">
        <span className="label">Questões e balões</span>
        <div className="row-gap">
          {base && c.contestId && (
            <button className="btn btn--ghost btn--sm" onClick={() => void importProblems()}>
              <Wand2 size={14} /> Importar questões do contest
            </button>
          )}
          <span className="muted">ou defina manualmente:</span>
          <Stepper value={problemCount} min={1} max={30} label="quantidade de questões" onChange={setProblemCount} />
          <button className="btn btn--ghost btn--sm" onClick={generateProblems}>
            {c.problems.length ? 'Ajustar quantidade' : 'Gerar questões'}
          </button>
        </div>
        {c.problems.length > 0 ? (
          <ProblemEditor contestKey={c.key} />
        ) : (
          <span className="muted ccard__hint">Cada questão tem uma cor de balão; com o gateway, as questões são importadas sozinhas na primeira leitura.</span>
        )}
      </div>
    </article>
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

export function SyncStatus({ c }: { c: Contest }) {
  if (c.lastSyncOk === false)
    return (
      <span className="syncstatus is-bad" title={c.lastError ?? ''}>
        <XCircle size={14} /> {c.failures > 1 ? `${c.failures} falhas seguidas` : 'falhou'}
        {c.lastSyncAt ? ` · último dado ${formatTime(c.lastSyncAt)}` : ''} — {c.lastError}
      </span>
    );
  if (c.lastSyncAt && c.warning)
    return (
      <span className="syncstatus is-warn" title={c.warning}>
        <AlertTriangle size={14} /> leitura {formatTime(c.lastSyncAt)} — {c.warning}
      </span>
    );
  if (c.lastSyncAt)
    return (
      <span className="syncstatus is-ok">
        <CheckCircle2 size={14} /> última leitura {formatTime(c.lastSyncAt)}
      </span>
    );
  return <span className="syncstatus muted">nenhuma leitura ainda</span>;
}

export function ProblemEditor({ contestKey, compact = false }: { contestKey: string; compact?: boolean }) {
  const { state, commit } = useStore();
  const contest = findContest(state, contestKey);
  if (!contest) return null;
  const update = (key: string, patch: { title?: string; color?: string; letter?: string }) =>
    commit((s) => updateContest(s, contestKey, (c) => ({ ...c, problems: c.problems.map((p) => (p.key === key ? { ...p, ...patch } : p)) })));
  return (
    <div className={`problems ${compact ? 'is-compact' : ''}`}>
      {contest.problems.map((p) => (
        <div key={p.key} className="problem">
          <label className="problem__color" title="Cor do balão" style={{ ['--c' as string]: p.color }}>
            <Balloon color={p.color} size={compact ? 26 : 34} />
            <input type="color" value={p.color} onChange={(e) => update(p.key, { color: e.target.value })} aria-label={`Cor do balão da questão ${p.letter}`} />
          </label>
          <span className="problem__letter mono">{p.letter}</span>
          {!compact && (
            <input className="problem__title" value={p.title} placeholder="título (opcional)" onChange={(e) => update(p.key, { title: e.target.value })} aria-label={`Título da questão ${p.letter}`} />
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
  const seen = new Set(state.contests.flatMap((c) => c.seenAccounts));
  const hasSeen = state.contests.some((c) => c.lastSyncAt !== null);
  const multi = state.contests.length > 1;
  const seenIn = (u: string) =>
    state.contests
      .filter((c) => c.seenAccounts.includes(u.toLowerCase()))
      .map((c) => c.tag)
      .join(', ');

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
      <span className="acc acc--ok" title="Esta conta aparece no ranking">
        no ranking{multi ? ` · ${seenIn(u)}` : ''}
      </span>
    ) : (
      <span className="acc acc--wait" title="Ainda não apareceu no ranking. No VJudge, a conta só aparece após a primeira submissão.">ainda não apareceu</span>
    );
  };

  if (!state.participants.length) return <Notice tone="info">Cadastre participantes na tela de configuração.</Notice>;

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
