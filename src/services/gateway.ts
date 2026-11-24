/**
 * Cliente do WCC Gateway (pasta /gateway).
 *
 * O navegador não consegue ler lcc.ufcg.edu.br nem vjudge.net diretamente
 * (nenhum dos dois envia cabeçalhos CORS). O gateway faz essas leituras e
 * devolve JSON com CORS liberado.
 */
import { BUILD_GATEWAY_URL } from '../config';
import type { AppState, LccLab } from '../domain/types';

export class GatewayError extends Error {}

const TIMEOUT_MS = 15000;

/** URL efetiva: a definida pelo organizador ou, se vazia, a do build. */
export function gatewayUrl(state: Pick<AppState, 'gatewayUrl'>): string {
  return (state.gatewayUrl.trim() || BUILD_GATEWAY_URL).replace(/\/+$/, '');
}

const getJson = (base: string, path: string) => request(base, path);
const postJson = (base: string, path: string, body: object) => request(base, path, body);

async function request(base: string, path: string, body?: object): Promise<unknown> {
  if (!base) throw new GatewayError('Gateway não configurado.');
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `${base}${path}`,
      body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal, cache: 'no-store' }
        : { signal: ctrl.signal, cache: 'no-store' },
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new GatewayError('Tempo esgotado ao consultar o gateway.');
    throw new GatewayError(navigator.onLine ? 'Sem resposta do gateway (URL incorreta, fora do ar ou origem não permitida).' : 'Sem conexão com a internet.');
  } finally {
    window.clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    data = JSON.parse(await res.text());
  } catch {
    /* corpo não-JSON */
  }
  // POST /enter devolve o motivo da recusa no corpo (409/429/403): repassa para a interface.
  if (!res.ok && body && data && typeof data === 'object' && 'reason' in data) return data;
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : res.statusText;
    throw new GatewayError(`Gateway ${res.status}: ${msg || 'erro'}`);
  }
  if (data === null) throw new GatewayError('O gateway não devolveu JSON.');
  return data;
}

export const gateway = {
  health: (base: string) => getJson(base, '/health') as Promise<{ ok: boolean; version: string }>,
  labs: async (base: string) => {
    const r = (await getJson(base, '/lcc/labs')) as { labs?: LccLab[]; fetchedAt?: number };
    if (!Array.isArray(r.labs) || !r.labs.length) throw new GatewayError('Resposta do LCC sem laboratórios.');
    return { labs: r.labs, fetchedAt: r.fetchedAt ?? Date.now() };
  },
  rank: (base: string, id: string) => getJson(base, `/vjudge/rank/${encodeURIComponent(id)}`),
  contest: (base: string, id: string) => getJson(base, `/vjudge/contest/${encodeURIComponent(id)}`),
  /** Gateway ≥ 2.2: estado da conta do VJudge usada pelo gateway. `force` refaz o login. */
  auth: (base: string, force = false) => getJson(base, `/vjudge/auth${force ? '?force=1' : ''}`) as Promise<GatewayAuth>,
  /** Gateway ≥ 2.2: entra no contest com a senha digitada pelo organizador (não fica guardada no app). */
  enter: (base: string, id: string, accessCode: string) => postJson(base, `/vjudge/enter/${encodeURIComponent(id)}`, { accessCode }) as Promise<EnterResult>,
  /** Gateway ≥ 2.1: diagnóstico de acesso (nunca devolve valores de segredos). */
  diag: (base: string, id: string) => getJson(base, `/vjudge/diag/${encodeURIComponent(id)}`) as Promise<GatewayDiag>,
};

export type AuthStatus = 'ok' | 'human_verification' | 'invalid_credentials' | 'error' | 'not_configured' | 'origin_not_allowed' | 'unknown';

export interface GatewayAuth {
  mode: 'account' | 'cookie' | 'none';
  username?: string | null;
  status: AuthStatus;
  vjudge?: string | null;
  lastLoginAt?: number | null;
  retryAfter?: number | null;
  persistentStore?: boolean;
}

export interface EnterResult {
  ok: boolean;
  reason?: string;
  access?: 'public' | 'authorized' | 'restricted';
  role?: 'manager' | null;
  problems?: number | null;
  retryAfter?: number;
}

export interface GatewayDiag {
  gateway: string;
  config: {
    allowedOrigins: string;
    requestOriginAllowedExplicitly: boolean;
    authMode?: 'account' | 'cookie' | 'none';
    persistentStore?: boolean;
    cookieConfigured: boolean;
    sessionUsedForThisRequest?: boolean;
    /** gateway 2.1 */
    cookieUsedForThisRequest?: boolean;
    accessCodeConfigured: boolean;
    accessCodeVariable: string | null;
    accessCodeFromApp?: boolean;
  };
  auth?: GatewayAuth;
  contest?: {
    id?: number;
    title?: string;
    openness?: number;
    authStatus?: number | null;
    access?: 'public' | 'authorized' | 'restricted';
    role?: 'manager' | null;
    problemsVisible?: boolean;
    problems?: number | null;
    error?: string;
  };
  enterContest?: { attempted: boolean; ok?: boolean; vjudgeReason?: string | null };
  rank?: { participants: number; submissions: number; accepted: number; error?: string };
  hints: string[];
}
