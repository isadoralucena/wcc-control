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

async function getJson(base: string, path: string): Promise<unknown> {
  if (!base) throw new GatewayError('Gateway não configurado.');
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { signal: ctrl.signal, cache: 'no-store' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new GatewayError('Tempo esgotado ao consultar o gateway.');
    throw new GatewayError(navigator.onLine ? 'Sem resposta do gateway (URL incorreta, fora do ar ou origem não permitida).' : 'Sem conexão com a internet.');
  } finally {
    window.clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    /* corpo não-JSON */
  }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new GatewayError(`Gateway ${res.status}: ${msg || 'erro'}`);
  }
  if (body === null) throw new GatewayError('O gateway não devolveu JSON.');
  return body;
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
  /** Gateway ≥ 2.1: diagnóstico de acesso (nunca devolve valores de segredos). */
  diag: (base: string, id: string) => getJson(base, `/vjudge/diag/${encodeURIComponent(id)}`) as Promise<GatewayDiag>,
};

export interface GatewayDiag {
  gateway: string;
  config: {
    allowedOrigins: string;
    requestOriginAllowedExplicitly: boolean;
    cookieConfigured: boolean;
    cookieLooksValid: boolean;
    cookieUsedForThisRequest: boolean;
    accessCodeConfigured: boolean;
    accessCodeVariable: string | null;
  };
  contest?: { id?: number; title?: string; openness?: number; access?: 'public' | 'authorized' | 'restricted'; problemsVisible?: boolean; problems?: number | null; error?: string };
  enterContest?: { attempted: boolean; ok?: boolean; vjudgeReason?: string | null };
  rank?: { participants: number; submissions: number; accepted: number; error?: string };
  hints: string[];
}
