/**
 * WCC Gateway — intermediário serverless entre o WCC Control (GitHub Pages)
 * e duas fontes externas que NÃO enviam cabeçalhos CORS:
 *
 *   - https://lcc.ufcg.edu.br/   (planta e computadores dos laboratórios)
 *   - https://vjudge.net/         (questões e ranking dos contests)
 *
 * Este arquivo contém toda a lógica e usa apenas a Fetch API padrão, então
 * roda em Cloudflare Workers, Deno Deploy, Vercel/Netlify (Web handlers) e
 * Node 18+. O ponto de entrada do Cloudflare é `worker.js`; para colar no
 * painel use o arquivo único `dist/wcc-gateway.js` (npm run gateway:bundle).
 *
 * Rotas (somente leitura — não é um proxy aberto):
 *   GET /health                 → { ok, service, version }
 *   GET /lcc/labs               → laboratórios, planta e computadores (sem dados de usuários)
 *   GET /vjudge/contest/{id}    → { id, title, begin, end, openness, problems[] | null }
 *                                 (problems = null quando o contest é privado e não há sessão)
 *   GET /vjudge/rank/{id}       → JSON original do ranking do VJudge
 *   GET /vjudge/diag/{id}       → diagnóstico de acesso (quais configurações existem; nunca os valores)
 *   GET /vjudge/auth[?force=1]  → estado da conta do gateway (login automático)
 *   POST /vjudge/enter/{id}     → { accessCode } — entra no contest com a senha informada no app
 *   (aliases legados: /contest/{id}, /rank/{id})
 *
 * Variáveis de ambiente (todas opcionais):
 *   ALLOWED_ORIGINS          origens permitidas, separadas por vírgula. Padrão "*".
 *   VJUDGE_USERNAME          (secret) usuário da conta do VJudge da organização.
 *   VJUDGE_ACCOUNT_PASSWORD  (secret) senha dessa conta. O gateway faz login sozinho
 *                            e renova a sessão quando ela expira.
 *   WCC_KV                   (binding KV) guarda a sessão entre execuções.
 *   VJUDGE_COOKIE            (secret, legado) sessão copiada do navegador; usada só se
 *                            não houver usuário/senha.
 *   A sessão só é usada quando a origem da requisição está listada EXPLICITAMENTE
 *   em ALLOWED_ORIGINS (nunca via "*").
 *   VJUDGE_CONTEST_PASSWORD  (secret) senha/código de acesso do contest privado. O gateway
 *                            entra no contest com ela usando a sessão acima. Também aceita
 *                            os nomes listados em ACCESS_CODE_VARS.
 *
 * Contest privado no VJudge = conta logada + (senha do contest ou conta gerente).
 * O VJudge recusa a senha sem conta logada ("contest.error.login_required"). O login
 * de conta pode exigir verificação humana (Turnstile) conforme o risco; o gateway
 * nunca tenta contorná-la — informa o estado e o app oferece o Conector do navegador.
 */

export const VERSION = '2.2.0';
const LCC_URL = 'https://lcc.ufcg.edu.br/';
const VJ = 'https://vjudge.net';

/** Tempo de cache na borda (segundos). Agrupa várias abas/organizadores em uma única consulta. */
const TTL = { rank: 5, contest: 60, lcc: 120 };

/* ------------------------------------------------------------------ */
/* LCC                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Interpreta o HTML de lcc.ufcg.edu.br.
 *
 * Cada laboratório é um painel cujo cabeçalho diz "status do laboratório",
 * com título em `#<id>-titulo` e a planta em `#<id>-dados`. A planta é uma
 * sequência de `<div class="linha">`, cada uma com células
 * `<div class="coluna">` (computador) ou `<div class="coluna-vazia">`
 * (corredor; pode conter o ícone de porta).
 *
 * Retorna apenas sigla, planta e status de cada máquina. Os usuários logados,
 * que também aparecem na página, são descartados de propósito.
 */
export function parseLcc(html) {
  const labs = [];
  const headRe = /<div class="panel-heading[^"]*"[^>]*title="([^"]*)"[^>]*>\s*<div class="panel-title" id="([\w-]+)-titulo">([^<]*)<\/div>/g;
  let m;
  while ((m = headRe.exec(html))) {
    const [, title, key, rawName] = m;
    if (!/laborat/i.test(title)) continue;
    const start = html.indexOf(`id="${key}-dados"`, m.index);
    if (start < 0) continue;
    let end = html.indexOf('<div class="panel-heading', start);
    if (end < 0) end = html.length;
    const block = html.slice(start, end);
    const rows = block.split('<div class="linha">').slice(1).map(parseRow);
    const lab = normalizeLab(key.toUpperCase(), rawName.trim() || key.toUpperCase(), rows);
    if (lab.machines > 0) labs.push(lab);
  }
  return labs;
}

function parseRow(rowHtml) {
  const cells = [];
  const cellRe = /<div class="(coluna|coluna-vazia)">/g;
  const marks = [];
  let c;
  while ((c = cellRe.exec(rowHtml))) marks.push({ kind: c[1], at: c.index });
  marks.forEach((mk, i) => {
    const chunk = rowHtml.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : rowHtml.length);
    if (mk.kind === 'coluna-vazia') {
      cells.push(/porta\d?\.png/.test(chunk.slice(0, 200)) ? 'door' : null);
      return;
    }
    const id = (chunk.match(/<span class="destaque">\s*([^<\s]+)\s*<\/span>/) || [])[1];
    if (!id) {
      cells.push(null);
      return;
    }
    const text = (chunk.match(/<b>\s*[^<]*?-\s*(OK|DOWN)\s*<\/b>/i) || [])[1];
    const img = (chunk.match(/images\/(\w+)\.png" class="imgStatus"/) || [])[1] || '';
    let status = 'unknown';
    if (text) status = text.toUpperCase() === 'OK' ? 'ok' : 'down';
    else if (img.startsWith('on')) status = 'ok';
    else if (img === 'off') status = 'down';
    cells.push({ id, status });
  });
  return cells;
}

/** Iguala a largura das linhas e remove linhas/colunas totalmente vazias nas bordas. */
function normalizeLab(id, name, rows) {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  let grid = rows.map((r) => [...r, ...Array(cols - r.length).fill(null)]);
  const empty = (cell) => cell === null;
  while (grid.length && grid[grid.length - 1].every(empty)) grid.pop();
  while (grid.length && grid[0].every(empty)) grid.shift();
  let left = 0;
  let right = cols;
  while (left < right && grid.every((r) => empty(r[left]))) left++;
  while (right > left && grid.every((r) => empty(r[right - 1]))) right--;
  grid = grid.map((r) => r.slice(left, right));
  const machines = grid.flat().filter((x) => x && typeof x === 'object').length;
  return { id, name, rows: grid.length, cols: right - left, machines, cells: grid };
}

/* ------------------------------------------------------------------ */
/* VJudge                                                              */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Extrai os dados do contest do `<textarea name="dataJson">` da página do VJudge. */
export function extractContest(html) {
  const m = html.match(/<textarea[^>]*name="dataJson"[^>]*>([\s\S]*?)<\/textarea>/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
  // Em contests privados sem login o VJudge omite `problems` (o ranking continua público).
  return {
    id: data.id,
    title: data.title,
    begin: data.begin ?? null,
    end: data.end ?? null,
    openness: data.openness ?? null,
    authStatus: data.authStatus ?? null,
    problems: Array.isArray(data.problems) ? data.problems.map((p) => ({ num: p.num, title: p.title, oj: p.oj })) : null,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Busca na origem com timeout e uma nova tentativa em falhas transitórias. */
async function upstream(url, headers) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (res.status >= 300 && res.status < 400)
        throw new UpstreamError('A origem redirecionou (provavelmente exige login ou senha do contest).', 403);
      if (res.status === 404) throw new UpstreamError('Não encontrado na origem.', 404);
      if (res.status >= 500 || res.status === 429) throw new UpstreamError(`A origem respondeu ${res.status}.`, 502);
      if (!res.ok) throw new UpstreamError(`A origem respondeu ${res.status}.`, 502);
      return await res.text();
    } catch (err) {
      lastErr = err instanceof UpstreamError ? err : new UpstreamError('Falha de rede ao contatar a origem.', 502);
      if (lastErr.status !== 502 || attempt === 1) break;
      await sleep(400);
    }
  }
  throw lastErr;
}

function corsFor(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const explicit = !!origin && allowed.includes(origin);
  const allow = explicit ? origin : allowed.includes('*') ? '*' : null;
  if (!allow) return { headers: null, explicit };
  return {
    explicit,
    headers: {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Expose-Headers': 'X-WCC-Cache, X-WCC-Fetched-At, X-WCC-Access, X-WCC-Session',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  };
}

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

/* ------------------------------------------------------------------ */
/* Sessão do VJudge                                                    */
/* ------------------------------------------------------------------ */
/*
 * Modos de autenticação, em ordem de preferência:
 *
 *  'account'  VJUDGE_USERNAME + VJUDGE_ACCOUNT_PASSWORD: o gateway faz login com
 *             POST /user/login (o mesmo do formulário do site), guarda a sessão no
 *             Workers KV (binding WCC_KV) e refaz o login quando ela expira.
 *             Se o VJudge exigir verificação humana (Turnstile), o gateway NÃO
 *             tenta contorná-la: registra o estado 'human_verification' e para.
 *  'cookie'   VJUDGE_COOKIE (legado): sessão copiada manualmente do navegador.
 *  'none'     sem credenciais: só contests públicos.
 *
 * A sessão só é usada para origens listadas explicitamente em ALLOWED_ORIGINS.
 */

const UA = 'wcc-gateway/2.2 (+WCC Control)';

/**
 * Nomes aceitos para o segredo com a senha (código de acesso) do contest.
 * Vários nomes são aceitos porque o segredo pode ter sido criado antes desta versão.
 */
const ACCESS_CODE_VARS = ['VJUDGE_CONTEST_PASSWORD', 'VJUDGE_ACCESS_CODE', 'CONTEST_PASSWORD', 'VJUDGE_PASSWORD', 'VJUDGE_SENHA', 'SENHA', 'PASSWORD'];

const KV_SESSION = 'vjudge:session';
const KV_AUTH = 'vjudge:auth';
const kvCode = (id) => `vjudge:code:${id}`;
const kvEnterTries = (id) => `vjudge:enter-tries:${id}`;

const SESSION_TTL_S = 7 * 24 * 3600; // a sessão é validada a cada uso; isto só limita o lixo no KV
const CODE_TTL_S = 30 * 24 * 3600;
/** Espera mínima antes de tentar login de novo, por motivo de falha (evita bloquear a conta). */
const LOGIN_BACKOFF_MS = { invalid_credentials: 30 * 60 * 1000, human_verification: 15 * 60 * 1000, error: 60 * 1000 };
const ENTER_MAX_TRIES_PER_HOUR = 5;

function accessCodeOf(env) {
  for (const name of ACCESS_CODE_VARS) if (typeof env[name] === 'string' && env[name].trim()) return { name, value: env[name].trim() };
  return null;
}

/** Formato do segredo (nunca o valor): ajuda a achar aspas ou espaços colados por engano. */
function secretShape(v) {
  if (typeof v !== 'string') return null;
  return {
    length: v.length,
    trimmedLength: v.trim().length,
    surroundingWhitespace: v !== v.trim(),
    wrappedInQuotes: /^(["']).*\1$/s.test(v.trim()),
    innerWhitespace: /\s/.test(v.trim()),
  };
}

function authMode(env) {
  if (env.VJUDGE_USERNAME && env.VJUDGE_ACCOUNT_PASSWORD) return 'account';
  if (env.VJUDGE_COOKIE) return 'cookie';
  return 'none';
}

/* ---------- armazenamento (KV com fallback em memória) ---------- */

const memory = new Map();
const store = (env) => ({
  persistent: !!(env.WCC_KV && typeof env.WCC_KV.get === 'function'),
  async get(key) {
    const m = memory.get(key);
    if (m && (!m.exp || m.exp > Date.now())) return m.value;
    if (!env.WCC_KV) return null;
    const v = await env.WCC_KV.get(key, 'json');
    if (v !== null) memory.set(key, { value: v, exp: Date.now() + 30 * 1000 });
    return v;
  },
  async put(key, value, ttlS) {
    memory.set(key, { value, exp: ttlS ? Date.now() + ttlS * 1000 : 0 });
    if (env.WCC_KV) await env.WCC_KV.put(key, JSON.stringify(value), ttlS ? { expirationTtl: Math.max(60, ttlS) } : undefined);
  },
  async del(key) {
    memory.delete(key);
    if (env.WCC_KV) await env.WCC_KV.delete(key);
  },
});

/* ---------- cookies ---------- */

function setCookiesOf(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  if (typeof res.headers.getAll === 'function') return res.headers.getAll('Set-Cookie');
  const one = res.headers.get('Set-Cookie');
  return one ? one.split(/,(?=\s*[^;=\s]+=)/) : [];
}

function mergeCookies(jar, res) {
  for (const sc of setCookiesOf(res)) {
    const pair = sc.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
}
const cookieHeader = (jar) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
const errorKey = (body) => (body && body.error ? body.error.i18nKey || String(body.error) : body && body.i18nKey ? body.i18nKey : null);

/* ---------- login ---------- */

/**
 * Faz login com a conta configurada. Devolve { ok, cookie?, reason? }.
 * Não envia token de verificação humana: se o VJudge exigir, a falha é registrada
 * como 'human_verification' e nenhuma nova tentativa é feita durante a espera.
 */
async function login(env) {
  const jar = {};
  const home = await fetch(`${VJ}/`, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  mergeCookies(jar, home);
  const res = await fetch(`${VJ}/user/login`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: cookieHeader(jar),
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${VJ}/`,
    },
    body: new URLSearchParams({ username: env.VJUDGE_USERNAME.trim(), password: env.VJUDGE_ACCOUNT_PASSWORD }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  mergeCookies(jar, res);
  const body = await readJson(res);
  const key = errorKey(body);
  if (res.ok && !key) return { ok: true, cookie: cookieHeader(jar) };
  if (key && /human_verification/.test(key)) return { ok: false, reason: 'human_verification', vjudge: key };
  if (key && /invalid_credentials|password|username/.test(key)) return { ok: false, reason: 'invalid_credentials', vjudge: key };
  return { ok: false, reason: 'error', vjudge: key || `http_${res.status}` };
}

/**
 * Sessão atual para uso nas consultas. `force` descarta a sessão guardada e faz
 * novo login (respeitando a espera após falhas). Devolve { cookie, mode, state }.
 */
async function getSession(env, { force = false } = {}) {
  const mode = authMode(env);
  if (mode === 'cookie') return { cookie: env.VJUDGE_COOKIE.trim(), mode, state: { status: 'ok', source: 'cookie' } };
  if (mode === 'none') return { cookie: null, mode, state: { status: 'not_configured' } };

  const kv = store(env);
  if (!force) {
    const s = await kv.get(KV_SESSION);
    if (s && s.cookie && s.username === env.VJUDGE_USERNAME.trim()) return { cookie: s.cookie, mode, state: (await kv.get(KV_AUTH)) || { status: 'ok' } };
  }
  const auth = (await kv.get(KV_AUTH)) || {};
  if (auth.status && auth.status !== 'ok' && auth.username === env.VJUDGE_USERNAME.trim()) {
    const wait = LOGIN_BACKOFF_MS[auth.status] ?? LOGIN_BACKOFF_MS.error;
    if (Date.now() - (auth.at || 0) < wait) return { cookie: null, mode, state: { ...auth, retryAfter: auth.at + wait } };
  }
  let r;
  try {
    r = await login(env);
  } catch {
    r = { ok: false, reason: 'error', vjudge: 'network' };
  }
  const state = { status: r.ok ? 'ok' : r.reason, vjudge: r.vjudge ?? null, at: Date.now(), username: env.VJUDGE_USERNAME.trim() };
  await kv.put(KV_AUTH, state, SESSION_TTL_S);
  if (!r.ok) {
    await kv.del(KV_SESSION);
    return { cookie: null, mode, state };
  }
  await kv.put(KV_SESSION, { cookie: r.cookie, username: state.username, at: state.at }, SESSION_TTL_S);
  return { cookie: r.cookie, mode, state };
}

async function dropSession(env) {
  if (authMode(env) === 'account') await store(env).del(KV_SESSION);
}

/* ------------------------------------------------------------------ */
/* Acesso a contests                                                   */
/* ------------------------------------------------------------------ */

/**
 * Nível de acesso a partir do dataJson. No VJudge, `openness` 0 = público,
 * 1 = protegido, 2 = privado; quando a sessão não tem acesso, as questões são
 * omitidas. `authStatus` 3 = gerente do contest.
 */
function accessOf(info) {
  if (info.openness === 0) return 'public';
  if (Array.isArray(info.problems) || (typeof info.authStatus === 'number' && info.authStatus > 0)) return 'authorized';
  return 'restricted';
}
const roleOf = (info) => (info.authStatus === 3 ? 'manager' : null);

/** POST /contest/login/{id} com o código de acesso (o mesmo do botão do site). */
async function enterContest(id, cookie, code) {
  const res = await fetch(`${VJ}/contest/login/${id}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${VJ}/contest/${id}`,
    },
    body: new URLSearchParams({ accessCode: code }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  const key = errorKey(await readJson(res));
  return res.ok && !key ? { ok: true, reason: null } : { ok: false, reason: key || `http_${res.status}` };
}

const readContest = async (id, cookie) => {
  const headers = { 'User-Agent': UA, Accept: 'text/html' };
  if (cookie) headers.Cookie = cookie;
  const info = extractContest(await upstream(`${VJ}/contest/${id}`, headers));
  if (!info) throw new UpstreamError('Contest inexistente ou página do VJudge em formato inesperado.', 404);
  return info;
};

/** Contests já verificados neste isolate (evita repetir a checagem a cada leitura do ranking). */
const verifiedAt = new Map();
const VERIFY_TTL_MS = 5 * 60 * 1000;

/**
 * Lê o contest garantindo o acesso quando possível:
 * 1. lê com a sessão; se já houver acesso, pronto;
 * 2. se a sessão expirou (conta), refaz o login e relê;
 * 3. se ainda sem acesso e houver código (KV, informado pelo app, ou segredo), entra no contest e relê.
 */
async function contestWithAccess(id, env, useSession) {
  const steps = [];
  let session = useSession ? await getSession(env) : { cookie: null, mode: 'none', state: { status: 'unused' } };
  let info = await readContest(id, session.cookie);

  if (accessOf(info) === 'restricted' && useSession && session.mode === 'account' && session.cookie) {
    // Pode ser sessão expirada: um novo login resolve sem precisar da senha do contest
    // se a conta já tiver acesso (ex.: é gerente ou já entrou antes).
    session = await getSession(env, { force: true });
    steps.push({ step: 'relogin', ok: !!session.cookie, status: session.state.status });
    if (session.cookie) info = await readContest(id, session.cookie);
  }

  let enter = null;
  if (accessOf(info) === 'restricted' && useSession && session.cookie) {
    const stored = await store(env).get(kvCode(id));
    const code = (stored && stored.code) || accessCodeOf(env)?.value;
    if (code) {
      enter = await enterContest(id, session.cookie, code);
      enter.codeSource = stored && stored.code ? 'app' : 'secret';
      if (enter.ok) info = await readContest(id, session.cookie);
    }
  }
  const access = accessOf(info);
  if (access !== 'restricted') verifiedAt.set(id, Date.now());
  return { info: { ...info, access, role: roleOf(info) }, enter, session, steps };
}

/**
 * Entrada no contest pedida pelo app (organizador digitou a senha do contest).
 * Limitada a ENTER_MAX_TRIES_PER_HOUR tentativas por contest, para não expor a
 * conta a tentativas em massa. Em caso de sucesso, guarda o código no KV para
 * reentrar sozinho se a sessão for renovada.
 */
async function enterFromApp(id, code, env) {
  const kv = store(env);
  const tries = (await kv.get(kvEnterTries(id))) || { n: 0, since: Date.now() };
  if (Date.now() - tries.since > 3600 * 1000) Object.assign(tries, { n: 0, since: Date.now() });
  if (tries.n >= ENTER_MAX_TRIES_PER_HOUR) return { status: 429, body: { ok: false, reason: 'too_many_attempts', retryAfter: tries.since + 3600 * 1000 } };
  tries.n++;
  await kv.put(kvEnterTries(id), tries, 3600);

  let session = await getSession(env);
  if (!session.cookie) return { status: 409, body: { ok: false, reason: 'no_session', auth: publicAuthState(env, session) } };
  let r = await enterContest(id, session.cookie, code);
  if (!r.ok && /login_required/.test(r.reason || '') && session.mode === 'account') {
    session = await getSession(env, { force: true });
    if (session.cookie) r = await enterContest(id, session.cookie, code);
  }
  if (!r.ok) return { status: 200, body: { ok: false, reason: r.reason } };
  await kv.put(kvCode(id), { code, at: Date.now() }, CODE_TTL_S);
  const info = await readContest(id, session.cookie);
  verifiedAt.set(id, Date.now());
  return { status: 200, body: { ok: true, access: accessOf(info), role: roleOf(info), problems: info.problems ? info.problems.length : null } };
}

/** Estado de autenticação exibível (nunca inclui cookie nem senha). */
function publicAuthState(env, session) {
  const st = session.state || {};
  return {
    mode: session.mode,
    username: session.mode === 'account' ? env.VJUDGE_USERNAME.trim() : null,
    status: st.status || 'unknown',
    vjudge: st.vjudge || null,
    lastLoginAt: st.at || null,
    retryAfter: st.retryAfter || null,
  };
}

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

/** Resolve a rota e devolve { status, body, ttl?, headers? } (sem CORS/cache). */
async function route(path, env, ctx) {
  const { explicit, method } = ctx;
  const useSession = explicit && authMode(env) !== 'none';

  if (path === '/' || path === '/health')
    return {
      status: 200,
      body: {
        ok: true,
        service: 'wcc-gateway',
        version: VERSION,
        routes: ['/lcc/labs', '/vjudge/contest/{id}', '/vjudge/rank/{id}', '/vjudge/auth', 'POST /vjudge/enter/{id}', '/vjudge/diag/{id}'],
      },
    };

  if (path === '/lcc/labs') {
    const html = await upstream(LCC_URL, { 'User-Agent': UA, Accept: 'text/html' });
    const labs = parseLcc(html);
    if (!labs.length) throw new UpstreamError('A página do LCC mudou de formato: nenhum laboratório reconhecido.', 502);
    return { status: 200, body: { source: LCC_URL, fetchedAt: Date.now(), labs }, ttl: TTL.lcc };
  }

  if (path === '/vjudge/auth') {
    if (!useSession) return { status: 200, body: { mode: authMode(env), status: explicit ? 'not_configured' : 'origin_not_allowed' } };
    const session = await getSession(env, { force: ctx.query.get('force') === '1' });
    return { status: 200, body: { ...publicAuthState(env, session), persistentStore: store(env).persistent } };
  }

  const m = path.match(/^\/(?:vjudge\/)?(rank|contest|diag|enter)\/(\d{1,10})\/?$/);
  if (!m) return { status: 404, body: { error: 'Rota inválida.' } };
  const [, kind, id] = m;

  if (kind === 'enter') {
    if (method !== 'POST') return { status: 405, body: { error: 'Use POST.' } };
    if (!useSession) return { status: 403, body: { ok: false, reason: explicit ? 'no_credentials' : 'origin_not_allowed' } };
    const code = typeof ctx.body?.accessCode === 'string' ? ctx.body.accessCode.trim() : '';
    if (!code || code.length > 200) return { status: 400, body: { ok: false, reason: 'invalid_access_code' } };
    return enterFromApp(id, code, env);
  }

  if (kind === 'contest') {
    const { info } = await contestWithAccess(id, env, useSession);
    const { authStatus: _a, ...pub } = info;
    void _a;
    return { status: 200, body: pub, ttl: TTL.contest };
  }

  if (kind === 'rank') {
    let access = 'unknown';
    let session = { cookie: null };
    if (useSession) {
      const last = verifiedAt.get(id);
      if (!last || Date.now() - last > VERIFY_TTL_MS) {
        const r = await contestWithAccess(id, env, true);
        access = r.info.access;
        session = r.session;
      } else {
        access = 'authorized';
        session = await getSession(env);
      }
    }
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (session.cookie) headers.Cookie = session.cookie;
    const text = await upstream(`${VJ}/contest/rank/single/${id}`, headers);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // HTML no lugar de JSON costuma ser sessão expirada: descarta para relogar na próxima.
      if (useSession) {
        await dropSession(env);
        verifiedAt.delete(id);
      }
      throw new UpstreamError('O VJudge não devolveu JSON (sessão expirada ou verificação anti-robô). Nova tentativa na próxima leitura.', 502);
    }
    return { status: 200, body: data, ttl: TTL.rank, headers: { 'X-WCC-Access': access, 'X-WCC-Session': useSession ? authMode(env) : 'none' } };
  }

  // Diagnóstico: diz QUAIS configurações existem e o que o VJudge respondeu — nunca os valores.
  const code = accessCodeOf(env);
  const storedCode = await store(env).get(kvCode(id));
  const diag = {
    gateway: VERSION,
    config: {
      allowedOrigins: String(env.ALLOWED_ORIGINS || '*'),
      requestOriginAllowedExplicitly: explicit,
      authMode: authMode(env),
      accountConfigured: authMode(env) === 'account',
      persistentStore: store(env).persistent,
      cookieConfigured: !!env.VJUDGE_COOKIE,
      sessionUsedForThisRequest: useSession,
      accessCodeConfigured: !!code,
      accessCodeVariable: code ? code.name : null,
      accessCodeShape: code ? secretShape(env[code.name]) : null,
      accessCodeFromApp: !!(storedCode && storedCode.code),
      acceptedAccessCodeVariables: ACCESS_CODE_VARS,
    },
  };
  try {
    const { info, enter, session, steps } = await contestWithAccess(id, env, useSession);
    diag.auth = publicAuthState(env, session);
    diag.contest = {
      id: info.id,
      title: info.title,
      openness: info.openness,
      authStatus: info.authStatus,
      access: info.access,
      role: info.role,
      problemsVisible: Array.isArray(info.problems),
      problems: info.problems ? info.problems.length : null,
    };
    diag.steps = steps;
    diag.enterContest = enter ? { attempted: true, ok: enter.ok, vjudgeReason: enter.reason, codeSource: enter.codeSource } : { attempted: false };
    try {
      const headers = { 'User-Agent': UA, Accept: 'application/json' };
      if (session.cookie) headers.Cookie = session.cookie;
      const rank = JSON.parse(await upstream(`${VJ}/contest/rank/single/${id}`, headers));
      const subs = Array.isArray(rank.submissions) ? rank.submissions : [];
      diag.rank = { participants: Object.keys(rank.participants || {}).length, submissions: subs.length, accepted: subs.filter((s) => s[2] === 1).length };
    } catch (e) {
      diag.rank = { error: e instanceof Error ? e.message : 'erro' };
    }
  } catch (e) {
    diag.contest = { error: e instanceof Error ? e.message : 'erro' };
  }
  diag.hints = diagHints(diag);
  return { status: 200, body: diag };
}

function diagHints(d) {
  const h = [];
  const c = d.config;
  const a = d.auth || {};
  if (c.authMode === 'none' && d.contest && d.contest.access === 'restricted')
    h.push('Contest privado e nenhuma conta configurada: crie os segredos VJUDGE_USERNAME e VJUDGE_ACCOUNT_PASSWORD.');
  if (c.authMode !== 'none' && !c.requestOriginAllowedExplicitly)
    h.push('Há credenciais, mas a origem desta requisição não está em ALLOWED_ORIGINS: a sessão não foi usada.');
  if (c.authMode === 'account' && !c.persistentStore)
    h.push('Sem Workers KV (binding WCC_KV): a sessão fica só na memória e o login é refeito com mais frequência.');
  if (a.status === 'human_verification')
    h.push('O VJudge exigiu verificação humana no login a partir do servidor. O gateway não contorna essa verificação: use o Conector do navegador.');
  if (a.status === 'invalid_credentials') h.push('O VJudge recusou usuário/senha da conta (VJUDGE_USERNAME / VJUDGE_ACCOUNT_PASSWORD).');
  if (c.accessCodeShape && (c.accessCodeShape.wrappedInQuotes || c.accessCodeShape.surroundingWhitespace))
    h.push('O segredo da senha do contest parece conter aspas ou espaços extras.');
  if (d.enterContest && d.enterContest.attempted && !d.enterContest.ok) {
    if (/access_code_incorrect/.test(d.enterContest.vjudgeReason || ''))
      h.push(`O VJudge disse que a senha do contest está incorreta (origem: ${d.enterContest.codeSource === 'app' ? 'informada no app' : 'segredo do Cloudflare'}).`);
    else h.push(`O VJudge recusou a entrada no contest: ${d.enterContest.vjudgeReason}.`);
  }
  if (d.contest && d.contest.access === 'restricted' && a.status === 'ok' && !(d.enterContest && d.enterContest.attempted))
    h.push('A conta está logada mas não tem acesso a este contest: informe a senha do contest no app (tela VJudge) ou torne a conta gerente do contest.');
  if (d.contest && d.contest.role === 'manager') h.push('A conta é gerente do contest: a senha do contest não é necessária.');
  if (d.rank && d.rank.participants === 0 && d.contest && d.contest.access !== 'restricted')
    h.push('Acesso ok, mas o ranking ainda não tem participantes/submissões.');
  if (d.rank && d.rank.participants === 0 && d.contest && d.contest.access === 'restricted')
    h.push('Ranking vazio sem acesso autorizado: não é possível saber se há submissões.');
  return h;
}

/**
 * Handler portátil (Fetch API). `cache` é opcional: no Cloudflare é `caches.default`.
 */
export async function handle(request, env = {}, cache = null) {
  const origin = request.headers.get('Origin') || '';
  let { headers: cors, explicit } = corsFor(origin, env);
  // Sem cabeçalho Origin = acesso direto (barra de endereço, curl), não uma página de outro site:
  // responde dados públicos e diagnóstico, mas nunca usa a sessão (explicit = false).
  if (!cors && !origin) cors = {};
  if (!cors) return json({ error: 'Origem não permitida.' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405, cors);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let body = null;
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Corpo JSON inválido.' }, 400, cors);
    }
  }
  const useSession = explicit && authMode(env) !== 'none';
  // Só GET é cacheado; a chave separa respostas obtidas com e sem sessão.
  const cacheKey = new Request(`https://wcc-gateway.cache${path}?auth=${useSession ? 1 : 0}`);
  const cacheable = request.method === 'GET' && !path.startsWith('/vjudge/auth') && !path.startsWith('/vjudge/diag');

  if (cache && cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      res.headers.set('X-WCC-Cache', 'HIT');
      return res;
    }
  }

  try {
    const r = await route(path, env, { explicit, method: request.method, body, query: url.searchParams });
    const fetchedAt = new Date().toISOString();
    const extra = r.headers || {};
    if (r.status !== 200 || !r.ttl) return json(r.body, r.status, { ...cors, ...extra });
    if (cache && cacheable) {
      const toCache = json(r.body, 200, { 'Cache-Control': `public, max-age=${r.ttl}`, 'X-WCC-Fetched-At': fetchedAt, ...extra });
      await cache.put(cacheKey, toCache);
    }
    return json(r.body, 200, { ...cors, ...extra, 'X-WCC-Cache': 'MISS', 'X-WCC-Fetched-At': fetchedAt });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    return json({ error: err instanceof Error ? err.message : 'Erro interno.' }, status, cors);
  }
}
