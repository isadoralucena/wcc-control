/**
 * Estado da conta do VJudge usada pelo WCC Gateway e entrada em contests privados.
 *
 * O app nunca recebe usuário/senha da conta nem cookies: só o estado público
 * devolvido por GET /vjudge/auth. A senha do contest digitada aqui vai uma única
 * vez para o gateway (POST /vjudge/enter) e não é salva no navegador.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, LogIn, RefreshCw, UserRound } from 'lucide-react';
import { gateway, type AuthStatus, type GatewayAuth } from '../../services/gateway';
import { formatTime } from '../../components/ui';

export interface AuthView {
  loading: boolean;
  data: GatewayAuth | null;
  /** Gateway sem a rota /vjudge/auth (versão anterior à 2.2) ou inacessível. */
  error: string | null;
}

export function authLabel(status: AuthStatus | undefined): string {
  switch (status) {
    case 'ok':
      return 'conectada';
    case 'human_verification':
      return 'VJudge exigiu verificação humana';
    case 'invalid_credentials':
      return 'usuário ou senha recusados';
    case 'not_configured':
      return 'não configurada';
    case 'origin_not_allowed':
      return 'origem não autorizada';
    case 'error':
      return 'falha ao conectar';
    default:
      return 'estado desconhecido';
  }
}

export interface AuthRequest {
  n: number;
  /** Força um novo login no gateway (respeitando a espera após falhas). */
  force: boolean;
}

/** Consulta o estado da conta sempre que `req.n` muda. */
export function useGatewayAuth(base: string, req: AuthRequest): AuthView {
  const [view, setView] = useState<AuthView>({ loading: false, data: null, error: null });
  useEffect(() => {
    if (!base) {
      setView({ loading: false, data: null, error: null });
      return;
    }
    let alive = true;
    setView((v) => ({ ...v, loading: true }));
    gateway
      .auth(base, req.force)
      .then((data) => alive && setView({ loading: false, data, error: null }))
      .catch((e) => alive && setView({ loading: false, data: null, error: e instanceof Error ? e.message : 'erro' }));
    return () => {
      alive = false;
    };
  }, [base, req.n]); // eslint-disable-line react-hooks/exhaustive-deps
  return view;
}

export function AuthCard({ auth, onReconnect }: { auth: AuthView; onReconnect: () => void }) {
  const d = auth.data;
  let tone: 'ok' | 'warn' | 'idle' = 'idle';
  let title = 'Conta do VJudge no gateway';
  let text = '';
  if (auth.error) {
    tone = 'warn';
    text = /404|Rota inválida/.test(auth.error)
      ? 'O gateway publicado é anterior à versão 2.2 e não faz login sozinho. Publique gateway/dist/wcc-gateway.js.'
      : auth.error;
  } else if (!d) {
    text = auth.loading ? 'consultando' : '';
  } else if (d.status === 'origin_not_allowed') {
    tone = 'warn';
    text = 'Este endereço do app não está em ALLOWED_ORIGINS do gateway; contests privados não ficam acessíveis daqui.';
  } else if (d.mode === 'none') {
    text = 'Nenhuma conta configurada: apenas contests públicos. Para contests privados, configure VJUDGE_USERNAME e VJUDGE_ACCOUNT_PASSWORD no gateway.';
  } else if (d.mode === 'cookie') {
    tone = 'warn';
    text = 'Usando um cookie copiado manualmente (modo legado, expira). Configure VJUDGE_USERNAME e VJUDGE_ACCOUNT_PASSWORD para o login automático.';
  } else {
    tone = d.status === 'ok' ? 'ok' : 'warn';
    title = `Conta ${d.username ?? ''} · ${authLabel(d.status)}`;
    text =
      d.status === 'ok'
        ? `Login automático ativo${d.lastLoginAt ? ` (último login ${formatTime(d.lastLoginAt, false)})` : ''}. A sessão é renovada sozinha quando expira.${
            d.persistentStore === false ? ' Sem Workers KV: a sessão fica só em memória.' : ''
          }`
        : d.status === 'human_verification'
          ? 'O VJudge pediu verificação humana para o login feito pelo servidor. O gateway não contorna essa proteção; tente reconectar mais tarde ou use o modo "Colar JSON" no navegador logado.'
          : d.status === 'invalid_credentials'
            ? 'O VJudge recusou VJUDGE_USERNAME/VJUDGE_ACCOUNT_PASSWORD. Corrija os segredos no Cloudflare.'
            : `Não foi possível fazer login (${d.vjudge ?? 'erro'}).`;
    if (d.retryAfter) text += ` Nova tentativa liberada às ${formatTime(d.retryAfter, false)}.`;
  }
  return (
    <div className={`authcard is-${tone}`}>
      <span className="authcard__icon">{tone === 'ok' ? <CheckCircle2 size={18} /> : tone === 'warn' ? <AlertTriangle size={18} /> : <UserRound size={18} />}</span>
      <div className="authcard__body">
        <b>{title}</b>
        {text && <span className={auth.loading && !d ? 'caret' : ''}>{text}</span>}
      </div>
      {d && d.mode === 'account' && (
        <button className="btn btn--ghost btn--sm" onClick={onReconnect} disabled={auth.loading}>
          <RefreshCw size={14} className={auth.loading ? 'spin' : ''} /> Reconectar
        </button>
      )}
    </div>
  );
}

const ENTER_REASONS: Record<string, string> = {
  too_many_attempts: 'Muitas tentativas para este contest. Aguarde uma hora antes de tentar de novo.',
  no_session: 'O gateway não está logado no VJudge (veja o estado da conta abaixo).',
  no_credentials: 'O gateway não tem conta do VJudge configurada.',
  origin_not_allowed: 'Este endereço do app não está em ALLOWED_ORIGINS do gateway.',
  invalid_access_code: 'Informe a senha do contest.',
  'contest.error.login_required': 'O VJudge exigiu login: a sessão do gateway caiu. Tente novamente.',
};
const reasonText = (r?: string) =>
  r && /access_code_incorrect/.test(r) ? 'O VJudge informou que a senha do contest está incorreta.' : (r && ENTER_REASONS[r]) || `O VJudge recusou: ${r ?? 'erro'}`;

/** Formulário mostrado quando o contest é privado e o gateway ainda não tem acesso. */
export function EnterContest({
  base,
  contestId,
  auth,
  onEntered,
}: {
  base: string;
  contestId: string;
  auth: AuthView;
  onEntered: (access: 'public' | 'authorized' | 'restricted') => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const accountReady = auth.data?.mode !== 'none' && auth.data?.status === 'ok';

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await gateway.enter(base, contestId, code.trim());
      if (r.ok) {
        setMsg({ tone: 'ok', text: `Acesso liberado${r.problems ? ` · ${r.problems} questões` : ''}. A atualização automática já pode ler o ranking.` });
        setCode('');
        onEntered(r.access ?? 'authorized');
      } else setMsg({ tone: 'bad', text: reasonText(r.reason) });
    } catch (e) {
      const m = e instanceof Error ? e.message : 'erro';
      setMsg({ tone: 'bad', text: /404|405|Rota/.test(m) ? 'Atualize o gateway para a versão 2.2 para entrar em contests pelo app.' : m });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="enter">
      <p className="enter__text">
        Contest <b>privado</b> e o gateway ainda não tem acesso. Se a conta do gateway for <b>gerente</b> do contest, não é preciso senha. Caso contrário,
        informe a senha do contest uma vez: ela vai direto para o gateway e não fica salva neste navegador.
      </p>
      <form
        className="enter__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="label">Senha do contest</span>
          <input type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="senha do contest no VJudge" />
        </label>
        <button className="btn btn--primary" type="submit" disabled={busy || !code.trim() || !accountReady}>
          {busy ? <RefreshCw size={16} className="spin" /> : <LogIn size={16} />} Entrar no contest
        </button>
      </form>
      {!accountReady && !auth.loading && (
        <span className="enter__hint">
          <KeyRound size={13} /> Disponível quando a conta do gateway estiver conectada.
        </span>
      )}
      {msg && <span className={`enter__msg is-${msg.tone}`}>{msg.text}</span>}
    </div>
  );
}
