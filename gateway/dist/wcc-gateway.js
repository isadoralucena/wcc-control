// gateway/core.js
var VERSION = "2.2.0";
var LCC_URL = "https://lcc.ufcg.edu.br/";
var VJ = "https://vjudge.net";
var TTL = { rank: 5, contest: 60, lcc: 120 };
function parseLcc(html) {
  const labs = [];
  const headRe = /<div class="panel-heading[^"]*"[^>]*title="([^"]*)"[^>]*>\s*<div class="panel-title" id="([\w-]+)-titulo">([^<]*)<\/div>/g;
  let m;
  while (m = headRe.exec(html)) {
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
  while (c = cellRe.exec(rowHtml)) marks.push({ kind: c[1], at: c.index });
  marks.forEach((mk, i) => {
    const chunk = rowHtml.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : rowHtml.length);
    if (mk.kind === "coluna-vazia") {
      cells.push(/porta\d?\.png/.test(chunk.slice(0, 200)) ? "door" : null);
      return;
    }
    const id = (chunk.match(/<span class="destaque">\s*([^<\s]+)\s*<\/span>/) || [])[1];
    if (!id) {
      cells.push(null);
      return;
    }
    const text = (chunk.match(/<b>\s*[^<]*?-\s*(OK|DOWN)\s*<\/b>/i) || [])[1];
    const img = (chunk.match(/images\/(\w+)\.png" class="imgStatus"/) || [])[1] || "";
    let status = "unknown";
    if (text) status = text.toUpperCase() === "OK" ? "ok" : "down";
    else if (img.startsWith("on")) status = "ok";
    else if (img === "off") status = "down";
    cells.push({ id, status });
  });
  return cells;
}
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
  const machines = grid.flat().filter((x) => x && typeof x === "object").length;
  return { id, name, rows: grid.length, cols: right - left, machines, cells: grid };
}
function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
}
function extractContest(html) {
  const m = html.match(/<textarea[^>]*name="dataJson"[^>]*>([\s\S]*?)<\/textarea>/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
  return {
    id: data.id,
    title: data.title,
    begin: data.begin ?? null,
    end: data.end ?? null,
    openness: data.openness ?? null,
    authStatus: data.authStatus ?? null,
    problems: Array.isArray(data.problems) ? data.problems.map((p) => ({ num: p.num, title: p.title, oj: p.oj })) : null
  };
}
var UpstreamError = class extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
};
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function upstream(url, headers) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(1e4) });
      if (res.status >= 300 && res.status < 400)
        throw new UpstreamError("A origem redirecionou (provavelmente exige login ou senha do contest).", 403);
      if (res.status === 404) throw new UpstreamError("N\xE3o encontrado na origem.", 404);
      if (res.status >= 500 || res.status === 429) throw new UpstreamError(`A origem respondeu ${res.status}.`, 502);
      if (!res.ok) throw new UpstreamError(`A origem respondeu ${res.status}.`, 502);
      return await res.text();
    } catch (err) {
      lastErr = err instanceof UpstreamError ? err : new UpstreamError("Falha de rede ao contatar a origem.", 502);
      if (lastErr.status !== 502 || attempt === 1) break;
      await sleep(400);
    }
  }
  throw lastErr;
}
function corsFor(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const explicit = !!origin && allowed.includes(origin);
  const allow = explicit ? origin : allowed.includes("*") ? "*" : null;
  if (!allow) return { headers: null, explicit };
  return {
    explicit,
    headers: {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "X-WCC-Cache, X-WCC-Fetched-At, X-WCC-Access, X-WCC-Session",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin"
    }
  };
}
function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }
  });
}
var UA = "wcc-gateway/2.2 (+WCC Control)";
var ACCESS_CODE_VARS = ["VJUDGE_CONTEST_PASSWORD", "VJUDGE_ACCESS_CODE", "CONTEST_PASSWORD", "VJUDGE_PASSWORD", "VJUDGE_SENHA", "SENHA", "PASSWORD"];
var KV_SESSION = "vjudge:session";
var KV_AUTH = "vjudge:auth";
var kvCode = (id) => `vjudge:code:${id}`;
var kvEnterTries = (id) => `vjudge:enter-tries:${id}`;
var SESSION_TTL_S = 7 * 24 * 3600;
var CODE_TTL_S = 30 * 24 * 3600;
var LOGIN_BACKOFF_MS = { invalid_credentials: 30 * 60 * 1e3, human_verification: 15 * 60 * 1e3, error: 60 * 1e3 };
var ENTER_MAX_TRIES_PER_HOUR = 5;
function accessCodeOf(env) {
  for (const name of ACCESS_CODE_VARS) if (typeof env[name] === "string" && env[name].trim()) return { name, value: env[name].trim() };
  return null;
}
function secretShape(v) {
  if (typeof v !== "string") return null;
  return {
    length: v.length,
    trimmedLength: v.trim().length,
    surroundingWhitespace: v !== v.trim(),
    wrappedInQuotes: /^(["']).*\1$/s.test(v.trim()),
    innerWhitespace: /\s/.test(v.trim())
  };
}
function authMode(env) {
  if (env.VJUDGE_USERNAME && env.VJUDGE_ACCOUNT_PASSWORD) return "account";
  if (env.VJUDGE_COOKIE) return "cookie";
  return "none";
}
var memory = /* @__PURE__ */ new Map();
var store = (env) => ({
  persistent: !!(env.WCC_KV && typeof env.WCC_KV.get === "function"),
  async get(key) {
    const m = memory.get(key);
    if (m && (!m.exp || m.exp > Date.now())) return m.value;
    if (!env.WCC_KV) return null;
    const v = await env.WCC_KV.get(key, "json");
    if (v !== null) memory.set(key, { value: v, exp: Date.now() + 30 * 1e3 });
    return v;
  },
  async put(key, value, ttlS) {
    memory.set(key, { value, exp: ttlS ? Date.now() + ttlS * 1e3 : 0 });
    if (env.WCC_KV) await env.WCC_KV.put(key, JSON.stringify(value), ttlS ? { expirationTtl: Math.max(60, ttlS) } : void 0);
  },
  async del(key) {
    memory.delete(key);
    if (env.WCC_KV) await env.WCC_KV.delete(key);
  }
});
function setCookiesOf(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  if (typeof res.headers.getAll === "function") return res.headers.getAll("Set-Cookie");
  const one = res.headers.get("Set-Cookie");
  return one ? one.split(/,(?=\s*[^;=\s]+=)/) : [];
}
function mergeCookies(jar, res) {
  for (const sc of setCookiesOf(res)) {
    const pair = sc.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
}
var cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
var errorKey = (body) => body && body.error ? body.error.i18nKey || String(body.error) : body && body.i18nKey ? body.i18nKey : null;
async function login(env) {
  const jar = {};
  const home = await fetch(`${VJ}/`, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(1e4) });
  mergeCookies(jar, home);
  const res = await fetch(`${VJ}/user/login`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Cookie: cookieHeader(jar),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${VJ}/`
    },
    body: new URLSearchParams({ username: env.VJUDGE_USERNAME.trim(), password: env.VJUDGE_ACCOUNT_PASSWORD }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(1e4)
  });
  mergeCookies(jar, res);
  const body = await readJson(res);
  const key = errorKey(body);
  if (res.ok && !key) return { ok: true, cookie: cookieHeader(jar) };
  if (key && /human_verification/.test(key)) return { ok: false, reason: "human_verification", vjudge: key };
  if (key && /invalid_credentials|password|username/.test(key)) return { ok: false, reason: "invalid_credentials", vjudge: key };
  return { ok: false, reason: "error", vjudge: key || `http_${res.status}` };
}
async function getSession(env, { force = false } = {}) {
  const mode = authMode(env);
  if (mode === "cookie") return { cookie: env.VJUDGE_COOKIE.trim(), mode, state: { status: "ok", source: "cookie" } };
  if (mode === "none") return { cookie: null, mode, state: { status: "not_configured" } };
  const kv = store(env);
  if (!force) {
    const s = await kv.get(KV_SESSION);
    if (s && s.cookie && s.username === env.VJUDGE_USERNAME.trim()) return { cookie: s.cookie, mode, state: await kv.get(KV_AUTH) || { status: "ok" } };
  }
  const auth = await kv.get(KV_AUTH) || {};
  if (auth.status && auth.status !== "ok" && auth.username === env.VJUDGE_USERNAME.trim()) {
    const wait = LOGIN_BACKOFF_MS[auth.status] ?? LOGIN_BACKOFF_MS.error;
    if (Date.now() - (auth.at || 0) < wait) return { cookie: null, mode, state: { ...auth, retryAfter: auth.at + wait } };
  }
  let r;
  try {
    r = await login(env);
  } catch {
    r = { ok: false, reason: "error", vjudge: "network" };
  }
  const state = { status: r.ok ? "ok" : r.reason, vjudge: r.vjudge ?? null, at: Date.now(), username: env.VJUDGE_USERNAME.trim() };
  await kv.put(KV_AUTH, state, SESSION_TTL_S);
  if (!r.ok) {
    await kv.del(KV_SESSION);
    return { cookie: null, mode, state };
  }
  await kv.put(KV_SESSION, { cookie: r.cookie, username: state.username, at: state.at }, SESSION_TTL_S);
  return { cookie: r.cookie, mode, state };
}
async function dropSession(env) {
  if (authMode(env) === "account") await store(env).del(KV_SESSION);
}
function accessOf(info) {
  if (info.openness === 0) return "public";
  if (Array.isArray(info.problems) || typeof info.authStatus === "number" && info.authStatus > 0) return "authorized";
  return "restricted";
}
var roleOf = (info) => info.authStatus === 3 ? "manager" : null;
async function enterContest(id, cookie, code) {
  const res = await fetch(`${VJ}/contest/login/${id}`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${VJ}/contest/${id}`
    },
    body: new URLSearchParams({ accessCode: code }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(1e4)
  });
  const key = errorKey(await readJson(res));
  return res.ok && !key ? { ok: true, reason: null } : { ok: false, reason: key || `http_${res.status}` };
}
var readContest = async (id, cookie) => {
  const headers = { "User-Agent": UA, Accept: "text/html" };
  if (cookie) headers.Cookie = cookie;
  const info = extractContest(await upstream(`${VJ}/contest/${id}`, headers));
  if (!info) throw new UpstreamError("Contest inexistente ou p\xE1gina do VJudge em formato inesperado.", 404);
  return info;
};
var verifiedAt = /* @__PURE__ */ new Map();
var VERIFY_TTL_MS = 5 * 60 * 1e3;
async function contestWithAccess(id, env, useSession) {
  const steps = [];
  let session = useSession ? await getSession(env) : { cookie: null, mode: "none", state: { status: "unused" } };
  let info = await readContest(id, session.cookie);
  if (accessOf(info) === "restricted" && useSession && session.mode === "account" && session.cookie) {
    session = await getSession(env, { force: true });
    steps.push({ step: "relogin", ok: !!session.cookie, status: session.state.status });
    if (session.cookie) info = await readContest(id, session.cookie);
  }
  let enter = null;
  if (accessOf(info) === "restricted" && useSession && session.cookie) {
    const stored = await store(env).get(kvCode(id));
    const code = stored && stored.code || accessCodeOf(env)?.value;
    if (code) {
      enter = await enterContest(id, session.cookie, code);
      enter.codeSource = stored && stored.code ? "app" : "secret";
      if (enter.ok) info = await readContest(id, session.cookie);
    }
  }
  const access = accessOf(info);
  if (access !== "restricted") verifiedAt.set(id, Date.now());
  return { info: { ...info, access, role: roleOf(info) }, enter, session, steps };
}
async function enterFromApp(id, code, env) {
  const kv = store(env);
  const tries = await kv.get(kvEnterTries(id)) || { n: 0, since: Date.now() };
  if (Date.now() - tries.since > 3600 * 1e3) Object.assign(tries, { n: 0, since: Date.now() });
  if (tries.n >= ENTER_MAX_TRIES_PER_HOUR) return { status: 429, body: { ok: false, reason: "too_many_attempts", retryAfter: tries.since + 3600 * 1e3 } };
  tries.n++;
  await kv.put(kvEnterTries(id), tries, 3600);
  let session = await getSession(env);
  if (!session.cookie) return { status: 409, body: { ok: false, reason: "no_session", auth: publicAuthState(env, session) } };
  let r = await enterContest(id, session.cookie, code);
  if (!r.ok && /login_required/.test(r.reason || "") && session.mode === "account") {
    session = await getSession(env, { force: true });
    if (session.cookie) r = await enterContest(id, session.cookie, code);
  }
  if (!r.ok) return { status: 200, body: { ok: false, reason: r.reason } };
  await kv.put(kvCode(id), { code, at: Date.now() }, CODE_TTL_S);
  const info = await readContest(id, session.cookie);
  verifiedAt.set(id, Date.now());
  return { status: 200, body: { ok: true, access: accessOf(info), role: roleOf(info), problems: info.problems ? info.problems.length : null } };
}
function publicAuthState(env, session) {
  const st = session.state || {};
  return {
    mode: session.mode,
    username: session.mode === "account" ? env.VJUDGE_USERNAME.trim() : null,
    status: st.status || "unknown",
    vjudge: st.vjudge || null,
    lastLoginAt: st.at || null,
    retryAfter: st.retryAfter || null
  };
}
async function route(path, env, ctx) {
  const { explicit, method } = ctx;
  const useSession = explicit && authMode(env) !== "none";
  if (path === "/" || path === "/health")
    return {
      status: 200,
      body: {
        ok: true,
        service: "wcc-gateway",
        version: VERSION,
        routes: ["/lcc/labs", "/vjudge/contest/{id}", "/vjudge/rank/{id}", "/vjudge/auth", "POST /vjudge/enter/{id}", "/vjudge/diag/{id}"]
      }
    };
  if (path === "/lcc/labs") {
    const html = await upstream(LCC_URL, { "User-Agent": UA, Accept: "text/html" });
    const labs = parseLcc(html);
    if (!labs.length) throw new UpstreamError("A p\xE1gina do LCC mudou de formato: nenhum laborat\xF3rio reconhecido.", 502);
    return { status: 200, body: { source: LCC_URL, fetchedAt: Date.now(), labs }, ttl: TTL.lcc };
  }
  if (path === "/vjudge/auth") {
    if (!useSession) return { status: 200, body: { mode: authMode(env), status: explicit ? "not_configured" : "origin_not_allowed" } };
    const session = await getSession(env, { force: ctx.query.get("force") === "1" });
    return { status: 200, body: { ...publicAuthState(env, session), persistentStore: store(env).persistent } };
  }
  const m = path.match(/^\/(?:vjudge\/)?(rank|contest|diag|enter)\/(\d{1,10})\/?$/);
  if (!m) return { status: 404, body: { error: "Rota inv\xE1lida." } };
  const [, kind, id] = m;
  if (kind === "enter") {
    if (method !== "POST") return { status: 405, body: { error: "Use POST." } };
    if (!useSession) return { status: 403, body: { ok: false, reason: explicit ? "no_credentials" : "origin_not_allowed" } };
    const code2 = typeof ctx.body?.accessCode === "string" ? ctx.body.accessCode.trim() : "";
    if (!code2 || code2.length > 200) return { status: 400, body: { ok: false, reason: "invalid_access_code" } };
    return enterFromApp(id, code2, env);
  }
  if (kind === "contest") {
    const { info } = await contestWithAccess(id, env, useSession);
    const { authStatus: _a, ...pub } = info;
    return { status: 200, body: pub, ttl: TTL.contest };
  }
  if (kind === "rank") {
    let access = "unknown";
    let session = { cookie: null };
    if (useSession) {
      const last = verifiedAt.get(id);
      if (!last || Date.now() - last > VERIFY_TTL_MS) {
        const r = await contestWithAccess(id, env, true);
        access = r.info.access;
        session = r.session;
      } else {
        access = "authorized";
        session = await getSession(env);
      }
    }
    const headers = { "User-Agent": UA, Accept: "application/json" };
    if (session.cookie) headers.Cookie = session.cookie;
    const text = await upstream(`${VJ}/contest/rank/single/${id}`, headers);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (useSession) {
        await dropSession(env);
        verifiedAt.delete(id);
      }
      throw new UpstreamError("O VJudge n\xE3o devolveu JSON (sess\xE3o expirada ou verifica\xE7\xE3o anti-rob\xF4). Nova tentativa na pr\xF3xima leitura.", 502);
    }
    return { status: 200, body: data, ttl: TTL.rank, headers: { "X-WCC-Access": access, "X-WCC-Session": useSession ? authMode(env) : "none" } };
  }
  const code = accessCodeOf(env);
  const storedCode = await store(env).get(kvCode(id));
  const diag = {
    gateway: VERSION,
    config: {
      allowedOrigins: String(env.ALLOWED_ORIGINS || "*"),
      requestOriginAllowedExplicitly: explicit,
      authMode: authMode(env),
      accountConfigured: authMode(env) === "account",
      persistentStore: store(env).persistent,
      cookieConfigured: !!env.VJUDGE_COOKIE,
      sessionUsedForThisRequest: useSession,
      accessCodeConfigured: !!code,
      accessCodeVariable: code ? code.name : null,
      accessCodeShape: code ? secretShape(env[code.name]) : null,
      accessCodeFromApp: !!(storedCode && storedCode.code),
      acceptedAccessCodeVariables: ACCESS_CODE_VARS
    }
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
      problems: info.problems ? info.problems.length : null
    };
    diag.steps = steps;
    diag.enterContest = enter ? { attempted: true, ok: enter.ok, vjudgeReason: enter.reason, codeSource: enter.codeSource } : { attempted: false };
    try {
      const headers = { "User-Agent": UA, Accept: "application/json" };
      if (session.cookie) headers.Cookie = session.cookie;
      const rank = JSON.parse(await upstream(`${VJ}/contest/rank/single/${id}`, headers));
      const subs = Array.isArray(rank.submissions) ? rank.submissions : [];
      diag.rank = { participants: Object.keys(rank.participants || {}).length, submissions: subs.length, accepted: subs.filter((s) => s[2] === 1).length };
    } catch (e) {
      diag.rank = { error: e instanceof Error ? e.message : "erro" };
    }
  } catch (e) {
    diag.contest = { error: e instanceof Error ? e.message : "erro" };
  }
  diag.hints = diagHints(diag);
  return { status: 200, body: diag };
}
function diagHints(d) {
  const h = [];
  const c = d.config;
  const a = d.auth || {};
  if (c.authMode === "none" && d.contest && d.contest.access === "restricted")
    h.push("Contest privado e nenhuma conta configurada: crie os segredos VJUDGE_USERNAME e VJUDGE_ACCOUNT_PASSWORD.");
  if (c.authMode !== "none" && !c.requestOriginAllowedExplicitly)
    h.push("H\xE1 credenciais, mas a origem desta requisi\xE7\xE3o n\xE3o est\xE1 em ALLOWED_ORIGINS: a sess\xE3o n\xE3o foi usada.");
  if (c.authMode === "account" && !c.persistentStore)
    h.push("Sem Workers KV (binding WCC_KV): a sess\xE3o fica s\xF3 na mem\xF3ria e o login \xE9 refeito com mais frequ\xEAncia.");
  if (a.status === "human_verification")
    h.push("O VJudge exigiu verifica\xE7\xE3o humana no login a partir do servidor. O gateway n\xE3o contorna essa verifica\xE7\xE3o: use o Conector do navegador.");
  if (a.status === "invalid_credentials") h.push("O VJudge recusou usu\xE1rio/senha da conta (VJUDGE_USERNAME / VJUDGE_ACCOUNT_PASSWORD).");
  if (c.accessCodeShape && (c.accessCodeShape.wrappedInQuotes || c.accessCodeShape.surroundingWhitespace))
    h.push("O segredo da senha do contest parece conter aspas ou espa\xE7os extras.");
  if (d.enterContest && d.enterContest.attempted && !d.enterContest.ok) {
    if (/access_code_incorrect/.test(d.enterContest.vjudgeReason || ""))
      h.push(`O VJudge disse que a senha do contest est\xE1 incorreta (origem: ${d.enterContest.codeSource === "app" ? "informada no app" : "segredo do Cloudflare"}).`);
    else h.push(`O VJudge recusou a entrada no contest: ${d.enterContest.vjudgeReason}.`);
  }
  if (d.contest && d.contest.access === "restricted" && a.status === "ok" && !(d.enterContest && d.enterContest.attempted))
    h.push("A conta est\xE1 logada mas n\xE3o tem acesso a este contest: informe a senha do contest no app (tela VJudge) ou torne a conta gerente do contest.");
  if (d.contest && d.contest.role === "manager") h.push("A conta \xE9 gerente do contest: a senha do contest n\xE3o \xE9 necess\xE1ria.");
  if (d.rank && d.rank.participants === 0 && d.contest && d.contest.access !== "restricted")
    h.push("Acesso ok, mas o ranking ainda n\xE3o tem participantes/submiss\xF5es.");
  if (d.rank && d.rank.participants === 0 && d.contest && d.contest.access === "restricted")
    h.push("Ranking vazio sem acesso autorizado: n\xE3o \xE9 poss\xEDvel saber se h\xE1 submiss\xF5es.");
  return h;
}
async function handle(request, env = {}, cache = null) {
  const origin = request.headers.get("Origin") || "";
  let { headers: cors, explicit } = corsFor(origin, env);
  if (!cors && !origin) cors = {};
  if (!cors) return json({ error: "Origem n\xE3o permitida." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "M\xE9todo n\xE3o permitido." }, 405, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  let body = null;
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      return json({ error: "Corpo JSON inv\xE1lido." }, 400, cors);
    }
  }
  const useSession = explicit && authMode(env) !== "none";
  const cacheKey = new Request(`https://wcc-gateway.cache${path}?auth=${useSession ? 1 : 0}`);
  const cacheable = request.method === "GET" && !path.startsWith("/vjudge/auth") && !path.startsWith("/vjudge/diag");
  if (cache && cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      res.headers.set("X-WCC-Cache", "HIT");
      return res;
    }
  }
  try {
    const r = await route(path, env, { explicit, method: request.method, body, query: url.searchParams });
    const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
    const extra = r.headers || {};
    if (r.status !== 200 || !r.ttl) return json(r.body, r.status, { ...cors, ...extra });
    if (cache && cacheable) {
      const toCache = json(r.body, 200, { "Cache-Control": `public, max-age=${r.ttl}`, "X-WCC-Fetched-At": fetchedAt, ...extra });
      await cache.put(cacheKey, toCache);
    }
    return json(r.body, 200, { ...cors, ...extra, "X-WCC-Cache": "MISS", "X-WCC-Fetched-At": fetchedAt });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    return json({ error: err instanceof Error ? err.message : "Erro interno." }, status, cors);
  }
}

// gateway/worker.js
var worker_default = {
  async fetch(request, env) {
    return handle(request, env, typeof caches !== "undefined" ? caches.default : null);
  }
};
export {
  worker_default as default
};
