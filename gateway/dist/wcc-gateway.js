// gateway/core.js
var VERSION = "2.1.0";
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
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
var ACCESS_CODE_VARS = ["VJUDGE_CONTEST_PASSWORD", "VJUDGE_ACCESS_CODE", "CONTEST_PASSWORD", "VJUDGE_PASSWORD", "VJUDGE_SENHA", "SENHA", "PASSWORD"];
function accessCodeOf(env) {
  for (const name of ACCESS_CODE_VARS) if (typeof env[name] === "string" && env[name].trim()) return { name, value: env[name].trim() };
  return null;
}
function looksLikeCookie(v) {
  return typeof v === "string" && /^[^=;\s]+=[^;]*/.test(v.trim());
}
var enteredAt = /* @__PURE__ */ new Map();
var ENTER_TTL_MS = 10 * 60 * 1e3;
var UA = "wcc-gateway/2.1 (+WCC Control)";
async function enterContest(id, env) {
  const code = accessCodeOf(env);
  if (!code) return { ok: false, reason: "access_code_not_configured" };
  const res = await fetch(`${VJ}/contest/login/${id}`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Cookie: env.VJUDGE_COOKIE,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${VJ}/contest/${id}`
    },
    body: new URLSearchParams({ accessCode: code.value }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(1e4)
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
  }
  const err = body && body.error;
  if (!res.ok || err) return { ok: false, reason: err && (err.i18nKey || err) || `http_${res.status}` };
  enteredAt.set(id, Date.now());
  return { ok: true, reason: null };
}
async function contestWithAccess(id, env, useCookie) {
  const headers = { "User-Agent": UA, Accept: "text/html" };
  if (useCookie) headers.Cookie = env.VJUDGE_COOKIE;
  let info = extractContest(await upstream(`${VJ}/contest/${id}`, headers));
  if (!info) throw new UpstreamError("Contest inexistente ou p\xE1gina do VJudge em formato inesperado.", 404);
  let enter = null;
  if (useCookie && info.authStatus !== 1 && accessCodeOf(env)) {
    enter = await enterContest(id, env);
    if (enter.ok) info = extractContest(await upstream(`${VJ}/contest/${id}`, headers)) || info;
  }
  const access = info.openness === 0 ? "public" : info.authStatus === 1 ? "authorized" : "restricted";
  return { info: { ...info, access }, enter };
}
async function route(path, env, ctx) {
  const { useCookie } = ctx;
  if (path === "/" || path === "/health")
    return {
      status: 200,
      body: { ok: true, service: "wcc-gateway", version: VERSION, routes: ["/lcc/labs", "/vjudge/contest/{id}", "/vjudge/rank/{id}", "/vjudge/diag/{id}"] }
    };
  if (path === "/lcc/labs") {
    const html = await upstream(LCC_URL, { "User-Agent": UA, Accept: "text/html" });
    const labs = parseLcc(html);
    if (!labs.length) throw new UpstreamError("A p\xE1gina do LCC mudou de formato: nenhum laborat\xF3rio reconhecido.", 502);
    return { status: 200, body: { source: LCC_URL, fetchedAt: Date.now(), labs }, ttl: TTL.lcc };
  }
  const m = path.match(/^\/(?:vjudge\/)?(rank|contest|diag)\/(\d{1,10})\/?$/);
  if (!m) return { status: 404, body: { error: "Rota inv\xE1lida." } };
  const [, kind, id] = m;
  if (kind === "contest") {
    const { info } = await contestWithAccess(id, env, useCookie);
    const { authStatus: _a, ...pub } = info;
    return { status: 200, body: pub, ttl: TTL.contest };
  }
  if (kind === "rank") {
    let access = "unknown";
    if (useCookie && accessCodeOf(env)) {
      const last = enteredAt.get(id);
      if (!last || Date.now() - last > ENTER_TTL_MS) access = (await contestWithAccess(id, env, useCookie)).info.access;
      else access = "authorized";
    }
    const headers = { "User-Agent": UA, Accept: "application/json" };
    if (useCookie) headers.Cookie = env.VJUDGE_COOKIE;
    const text = await upstream(`${VJ}/contest/rank/single/${id}`, headers);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new UpstreamError("O VJudge n\xE3o devolveu JSON (contest privado sem acesso ou verifica\xE7\xE3o anti-rob\xF4).", 502);
    }
    return { status: 200, body: data, ttl: TTL.rank, headers: { "X-WCC-Access": access, "X-WCC-Session": useCookie ? "cookie" : "none" } };
  }
  const code = accessCodeOf(env);
  const diag = {
    gateway: VERSION,
    config: {
      allowedOrigins: String(env.ALLOWED_ORIGINS || "*"),
      requestOriginAllowedExplicitly: ctx.explicit,
      cookieConfigured: !!env.VJUDGE_COOKIE,
      cookieLooksValid: looksLikeCookie(env.VJUDGE_COOKIE),
      cookieUsedForThisRequest: useCookie,
      accessCodeConfigured: !!code,
      accessCodeVariable: code ? code.name : null,
      acceptedAccessCodeVariables: ACCESS_CODE_VARS
    }
  };
  try {
    const { info, enter } = await contestWithAccess(id, env, useCookie);
    diag.contest = { id: info.id, title: info.title, openness: info.openness, access: info.access, problemsVisible: Array.isArray(info.problems), problems: info.problems ? info.problems.length : null };
    diag.enterContest = enter ? { attempted: true, ok: enter.ok, vjudgeReason: enter.reason } : { attempted: false };
  } catch (e) {
    diag.contest = { error: e instanceof Error ? e.message : "erro" };
  }
  try {
    const headers = { "User-Agent": UA, Accept: "application/json" };
    if (useCookie) headers.Cookie = env.VJUDGE_COOKIE;
    const rank = JSON.parse(await upstream(`${VJ}/contest/rank/single/${id}`, headers));
    const subs = Array.isArray(rank.submissions) ? rank.submissions : [];
    diag.rank = { participants: Object.keys(rank.participants || {}).length, submissions: subs.length, accepted: subs.filter((s) => s[2] === 1).length };
  } catch (e) {
    diag.rank = { error: e instanceof Error ? e.message : "erro" };
  }
  diag.hints = diagHints(diag);
  return { status: 200, body: diag };
}
function diagHints(d) {
  const h = [];
  const c = d.config;
  if (d.contest && d.contest.access === "restricted") {
    if (c.accessCodeConfigured && !c.cookieConfigured)
      h.push("H\xE1 senha do contest configurada, mas nenhum VJUDGE_COOKIE: o VJudge s\xF3 aceita a senha de uma conta logada (contest.error.login_required).");
    if (c.cookieConfigured && !c.cookieLooksValid) h.push('VJUDGE_COOKIE n\xE3o tem o formato de um cabe\xE7alho Cookie ("nome=valor; ...").');
    if (c.cookieConfigured && !c.requestOriginAllowedExplicitly)
      h.push("VJUDGE_COOKIE existe, mas a origem desta requisi\xE7\xE3o n\xE3o est\xE1 listada explicitamente em ALLOWED_ORIGINS; o cookie n\xE3o foi usado.");
    if (c.cookieUsedForThisRequest && !c.accessCodeConfigured) h.push("Sess\xE3o em uso, mas sem senha do contest configurada (use o segredo VJUDGE_CONTEST_PASSWORD).");
    if (d.enterContest && d.enterContest.attempted && !d.enterContest.ok) h.push(`O VJudge recusou a entrada no contest: ${d.enterContest.vjudgeReason}.`);
    if (!c.cookieConfigured && !c.accessCodeConfigured) h.push("Contest privado sem nenhuma credencial configurada.");
  }
  if (d.rank && d.rank.participants === 0 && d.contest && d.contest.access !== "restricted")
    h.push("Ranking acess\xEDvel, mas ainda sem participantes/submiss\xF5es.");
  if (d.rank && d.rank.participants === 0 && d.contest && d.contest.access === "restricted")
    h.push("Ranking vazio sem acesso autorizado: n\xE3o \xE9 poss\xEDvel saber se h\xE1 submiss\xF5es.");
  return h;
}
async function handle(request, env = {}, cache = null) {
  const origin = request.headers.get("Origin") || "";
  const { headers: cors, explicit } = corsFor(origin, env);
  if (!cors) return json({ error: "Origem n\xE3o permitida." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ error: "M\xE9todo n\xE3o permitido." }, 405, cors);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const useCookie = explicit && !!env.VJUDGE_COOKIE;
  const cacheKey = new Request(`https://wcc-gateway.cache${path}?auth=${useCookie ? 1 : 0}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      res.headers.set("X-WCC-Cache", "HIT");
      return res;
    }
  }
  try {
    const r = await route(path, env, { useCookie, explicit });
    const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
    const extra = r.headers || {};
    if (r.status !== 200 || !r.ttl) return json(r.body, r.status, { ...cors, ...extra });
    if (cache) {
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
