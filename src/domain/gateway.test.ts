/**
 * Testes do WCC Gateway (gateway/core.js) e das regras de sincronização.
 *
 * As respostas do VJudge aqui são SIMULADAS para exercitar caminhos de código
 * (ex.: entrada bem-sucedida em contest privado), que não podem ser reproduzidos
 * sem credenciais reais. A integração real é verificada por "Testar conexão" e
 * pelos testes manuais descritos no README.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error módulo JS do gateway, sem declaração de tipos
import { handle } from '../../gateway/core.js';
import { parseRank, rankWarning } from './vjudge';
import { createParticipants } from './participants';
import { defaultState } from '../state/defaults';
import { hydrate } from '../state/persistence';

const page = (data: object) => `<html><textarea style="display: none" name="dataJson">${JSON.stringify(data)}</textarea></html>`;
const req = (path: string, origin = 'https://wcc.github.io') => new Request(`https://gw.test${path}`, { headers: { Origin: origin } });

describe('gateway: contest privado', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('entra no contest com a senha configurada usando a sessão e só então lê questões e ranking', async () => {
    let entered = false;
    const calls: { url: string; method: string; cookie: string | null; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      calls.push({ url, method: init.method ?? 'GET', cookie: headers.get('Cookie'), body: init.body as string | undefined });
      if (url.endsWith('/contest/login/123')) {
        entered = true;
        return new Response('{}', { status: 200 });
      }
      if (url.endsWith('/contest/123'))
        return new Response(
          page(entered ? { id: 123, title: 'T', openness: 2, authStatus: 1, problems: [{ num: 'A', title: 'x' }] } : { id: 123, title: 'T', openness: 2, authStatus: 0 }),
        );
      if (url.endsWith('/contest/rank/single/123'))
        return new Response(JSON.stringify(entered ? { id: 123, participants: { 9: { name: 'ana' } }, submissions: [[9, 0, 1, 60]] } : { id: 123, participants: {}, submissions: [] }));
      return new Response('nf', { status: 404 });
    });
    const env = { ALLOWED_ORIGINS: 'https://wcc.github.io', VJUDGE_COOKIE: 'JSESSIONID=abc', VJUDGE_CONTEST_PASSWORD: 'segredo' };
    const contest = await (await handle(req('/vjudge/contest/123'), env)).json();
    expect(contest).toMatchObject({ access: 'authorized', problems: [{ num: 'A' }] });
    expect(contest).not.toHaveProperty('authStatus');
    const login = calls.find((c) => c.method === 'POST')!;
    expect(login.cookie).toBe('JSESSIONID=abc');
    expect(login.body).toBe('accessCode=segredo');
    const rank = await (await handle(req('/vjudge/rank/123'), env)).json();
    expect(rank.submissions).toHaveLength(1);
  });

  it('nunca usa a sessão para origens liberadas só por "*" e nunca expõe segredos no diagnóstico', async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers).get('Cookie'));
      if (url.includes('/rank/')) return new Response(JSON.stringify({ id: 1, participants: {}, submissions: [] }));
      return new Response(page({ id: 1, title: 'T', openness: 2, authStatus: 0 }));
    });
    const env = { VJUDGE_COOKIE: 'JSESSIONID=supersecreto', CONTEST_PASSWORD: 'senha-secreta' };
    const res = await handle(req('/vjudge/diag/1', 'https://qualquer.site'), env);
    const text = await res.text();
    expect(seen.every((c) => c === null)).toBe(true);
    expect(text).not.toContain('supersecreto');
    expect(text).not.toContain('senha-secreta');
    const d = JSON.parse(text);
    expect(d.config).toMatchObject({ cookieConfigured: true, sessionUsedForThisRequest: false, accessCodeVariable: 'CONTEST_PASSWORD' });
    expect(d.hints.join(' ')).toContain('ALLOWED_ORIGINS');
  });
});

describe('sincronização', () => {
  const state = () => ({ ...defaultState(), participants: createParticipants([{ name: 'Ana', username: 'ana123' }]) });

  it('avisa quando o ranking vem vazio por falta de acesso, mas não quando o contest só não tem submissões', () => {
    const empty = parseRank({ id: 1, participants: {}, submissions: [] });
    const c = state().contests[0];
    expect(rankWarning(state(), { ...c, contestAccess: 'restricted' }, empty)).toMatch(/privado/);
    expect(rankWarning(state(), { ...c, contestAccess: 'public' }, empty)).toBeNull();
  });
  it('avisa quando nenhuma conta cadastrada aparece no ranking', () => {
    const rank = parseRank({ id: 1, participants: { 1: { name: 'outra' } }, submissions: [] });
    const c = state().contests[0];
    expect(rankWarning(state(), c, rank)).toMatch(/Nenhuma das 1 contas/);
    expect(rankWarning(state(), c, parseRank({ id: 1, participants: { 1: { name: 'ANA123' } }, submissions: [] }))).toBeNull();
  });
  it('migração: estado da v1 com proxy configurado passa a usar o gateway automaticamente', () => {
    const v1 = { version: 1, participants: [], labs: [], vjudge: { source: 'paste', proxyUrl: 'https://gw.example', autoPoll: false } };
    const s = hydrate(v1);
    expect(s.gatewayUrl).toBe('https://gw.example');
    expect(s.vjudge.source).toBe('gateway');
    expect(s.contests[0].contestAccess).toBeNull();
  });
  it('exportar e importar preserva entregas de balão', () => {
    const st = state();
    const k = `${st.contests[0].key}:0`;
    const s = { ...st, results: { x: { [k]: { solvedAt: 1, solvedSource: 'vjudge' as const, deliveredAt: 2 } } } };
    expect(hydrate(JSON.parse(JSON.stringify(s))).results.x[k].deliveredAt).toBe(2);
  });
});
