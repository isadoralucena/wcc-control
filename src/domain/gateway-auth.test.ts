/**
 * Fluxo de conta do WCC Gateway 2.2 (login automático + KV) com um VJudge SIMULADO.
 * Exercita os caminhos de código que não dá para reproduzir sem uma conta real:
 * login aceito, sessão expirada, verificação humana e entrada no contest pelo app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://wcc.github.io';
const page = (data: object) => `<textarea name="dataJson">${JSON.stringify(data)}</textarea>`;

function kv() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => (data.has(k) ? JSON.parse(data.get(k)!) : null),
    put: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
}

/** VJudge falso: contest privado 77 com senha "certa"; a conta pode ser gerente. */
function fakeVJudge(opts: { requireHuman?: boolean; manager?: boolean } = {}) {
  const valid = new Set<string>();
  const entered = new Set<string>();
  let n = 0;
  const log: string[] = [];
  const sid = (init: RequestInit = {}) => /JSESSIONID=(\w+)/.exec(new Headers(init.headers).get('Cookie') ?? '')?.[1] ?? '';
  const fetchMock = async (url: string, init: RequestInit = {}) => {
    const path = url.replace('https://vjudge.net', '');
    log.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/') return new Response('home', { headers: { 'Set-Cookie': `JSESSIONID=s${++n}; Path=/; HttpOnly` } });
    if (path === '/user/login') {
      if (opts.requireHuman) return new Response(JSON.stringify({ i18nKey: 'user.error.human_verification_failed' }), { status: 400 });
      const body = new URLSearchParams(init.body as string);
      if (body.get('username') !== 'wcc' || body.get('password') !== 'pw')
        return new Response(JSON.stringify({ i18nKey: 'user.auth.error.invalid_credentials' }), { status: 401 });
      valid.add(sid(init));
      return new Response('{}');
    }
    const logged = valid.has(sid(init));
    if (path === '/contest/login/77') {
      if (!logged) return new Response(JSON.stringify({ error: { i18nKey: 'contest.error.login_required' } }));
      if (new URLSearchParams(init.body as string).get('accessCode') !== 'certa')
        return new Response(JSON.stringify({ error: { i18nKey: 'contest.error.access_code_incorrect_html' } }));
      entered.add(sid(init));
      return new Response('{}');
    }
    const access = logged && (opts.manager || entered.has(sid(init)));
    if (path === '/contest/77')
      return new Response(
        page({ id: 77, title: 'Privado', openness: 2, authStatus: access ? (opts.manager ? 3 : 2) : 0, ...(access ? { problems: [{ num: 'A' }, { num: 'B' }] } : {}) }),
      );
    if (path === '/contest/rank/single/77')
      return new Response(JSON.stringify(access ? { id: 77, participants: { 1: { name: 'ana' } }, submissions: [[1, 0, 1, 30]] } : { id: 77, participants: {}, submissions: [] }));
    return new Response('nf', { status: 404 });
  };
  return { fetchMock, log, expire: () => valid.clear() };
}

const env = () => ({ ALLOWED_ORIGINS: ORIGIN, VJUDGE_USERNAME: 'wcc', VJUDGE_ACCOUNT_PASSWORD: 'pw', WCC_KV: kv() });
type Handle = (r: Request, e: object) => Promise<Response>;
/** Importa um módulo novo a cada teste (o gateway mantém cache em memória por isolate). */
async function load(): Promise<Handle> {
  // @ts-expect-error módulo JS do gateway, sem declaração de tipos
  return (await import('../../gateway/core.js')).handle;
}
const get = (h: Handle, path: string, e: object, origin = ORIGIN) => h(new Request(`https://gw.test${path}`, { headers: { Origin: origin } }), e).then((r) => r.json());
const post = (h: Handle, path: string, e: object, body: object, origin = ORIGIN) =>
  h(new Request(`https://gw.test${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e);

describe('gateway 2.2 — conta da organização', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('conta gerente: faz login sozinho e lê questões sem senha do contest; nenhuma senha no KV', async () => {
    const vj = fakeVJudge({ manager: true });
    vi.stubGlobal('fetch', vj.fetchMock);
    const h = await load();
    const e = env();
    expect(await get(h, '/vjudge/contest/77', e)).toMatchObject({ access: 'authorized', role: 'manager', problems: [{ num: 'A' }, { num: 'B' }] });
    expect(vj.log.filter((l) => l === 'POST /user/login')).toHaveLength(1);
    expect(vj.log.some((l) => l.startsWith('POST /contest/login'))).toBe(false);
    expect([...e.WCC_KV.data.keys()]).toContain('vjudge:session');
    expect([...e.WCC_KV.data.values()].join()).not.toContain('pw');
  });

  it('senha informada no app: entra, guarda o código e reentra sozinho após a sessão expirar', async () => {
    const vj = fakeVJudge();
    vi.stubGlobal('fetch', vj.fetchMock);
    const h = await load();
    const e = env();
    expect(await (await post(h, '/vjudge/enter/77', e, { accessCode: 'errada' })).json()).toMatchObject({
      ok: false,
      reason: 'contest.error.access_code_incorrect_html',
    });
    const ok = await (await post(h, '/vjudge/enter/77', e, { accessCode: 'certa' })).json();
    expect(ok).toMatchObject({ ok: true, access: 'authorized', problems: 2 });
    expect(JSON.stringify(ok)).not.toContain('certa');

    vj.expire(); // a sessão expira no VJudge
    expect(await get(h, '/vjudge/contest/77', e)).toMatchObject({ access: 'authorized' });
    expect(vj.log.filter((l) => l === 'POST /user/login')).toHaveLength(2); // relogin automático
    expect(vj.log.filter((l) => l === 'POST /contest/login/77')).toHaveLength(3); // errada, certa, reentrada
    const rank = await get(h, '/vjudge/rank/77', e);
    expect(rank.submissions).toHaveLength(1);
  });

  it('verificação humana exigida: não contorna, informa e respeita a espera', async () => {
    const vj = fakeVJudge({ requireHuman: true });
    vi.stubGlobal('fetch', vj.fetchMock);
    const h = await load();
    const e = env();
    expect(await get(h, '/vjudge/auth', e)).toMatchObject({ mode: 'account', status: 'human_verification' });
    const again = await get(h, '/vjudge/auth?force=1', e);
    expect(again.retryAfter).toBeGreaterThan(Date.now());
    expect(vj.log.filter((l) => l === 'POST /user/login')).toHaveLength(1);
  });

  it('limita tentativas de senha e nunca usa a sessão para origens liberadas só por "*"', async () => {
    const vj = fakeVJudge();
    vi.stubGlobal('fetch', vj.fetchMock);
    const h = await load();
    const e = env();
    for (let i = 0; i < 5; i++) await post(h, '/vjudge/enter/77', e, { accessCode: 'x' });
    expect((await post(h, '/vjudge/enter/77', e, { accessCode: 'x' })).status).toBe(429);
    const wild = { ...env(), ALLOWED_ORIGINS: '*' };
    expect((await post(h, '/vjudge/enter/77', wild, { accessCode: 'x' }, 'https://outro.site')).status).toBe(403);
  });
});
