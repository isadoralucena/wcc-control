/**
 * Interpretação dos dados do VJudge.
 *
 * Endpoints verificados (nov/2026) — usados pelo próprio site do VJudge, não são uma API oficial documentada:
 *
 *  GET https://vjudge.net/contest/rank/single/{id}
 *    JSON: { id, title, begin, length, isReplay,
 *            participants: { "<userId>": { name, nickname, ... } },      (formato atual)
 *                          { "<userId>": [ name, nickname, avatar ] }    (formato antigo)
 *            submissions: [ [userId, problemIndex, accepted(1|0), secondsSinceStart], ... ] }
 *
 *  GET https://vjudge.net/contest/{id}
 *    HTML com <textarea name="dataJson"> contendo { id, title, begin, end, openness,
 *    problems: [ { num: "A", title, oj, ... } ] }.
 *
 * Nenhum dos dois envia cabeçalhos CORS, então o navegador não consegue lê-los
 * diretamente a partir do GitHub Pages. Veja `services/vjudgeClient.ts`.
 */
import type { AppEvent, AppState, Cell, Contest, LogEntry, Problem } from './types';
import { buildUnits } from './teams';
import { problemLetter, uid } from './ids';
import { findContest, problemKey, problemLabel, updateContest } from './contests';

export const BALLOON_PALETTE = [
  '#61D295', '#1E88FD', '#7B68E5', '#F5C542', '#F2545B', '#FF8A3D',
  '#EC6FCF', '#2EC4B6', '#A0522D', '#9AA0A6', '#1B1D22', '#F4F1E8',
];

export function defaultColor(index: number): string {
  return BALLOON_PALETTE[index % BALLOON_PALETTE.length];
}

/** Extrai o ID numérico de um link ou ID de contest. */
export function parseContestId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/contest\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

export function rankUrl(id: string) {
  return `https://vjudge.net/contest/rank/single/${id}`;
}
export function contestUrl(id: string) {
  return `https://vjudge.net/contest/${id}`;
}

export interface RankData {
  id: number;
  title: string;
  begin: number;
  length: number;
  /** userId → username */
  accounts: Map<string, string>;
  submissions: { userId: string; problem: number; accepted: boolean; seconds: number }[];
}

export class VJudgeParseError extends Error {}

/** Valida e normaliza o JSON do ranking (aceita objeto ou texto colado). */
export function parseRank(input: unknown): RankData {
  let data: unknown = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new VJudgeParseError('O conteúdo está vazio.');
    if (text.startsWith('<')) throw new VJudgeParseError('Recebemos uma página HTML em vez do JSON do ranking. Verifique o link ou se é preciso fazer login.');
    try {
      data = JSON.parse(text);
    } catch {
      throw new VJudgeParseError('Não é um JSON válido. Copie todo o conteúdo da página do ranking.');
    }
  }
  if (!data || typeof data !== 'object') throw new VJudgeParseError('Formato inesperado.');
  const d = data as Record<string, unknown>;
  if (!('submissions' in d) || !Array.isArray(d.submissions) || !d.participants || typeof d.participants !== 'object')
    throw new VJudgeParseError('O JSON não tem os campos "participants" e "submissions" do ranking do VJudge.');

  const accounts = new Map<string, string>();
  for (const [userId, info] of Object.entries(d.participants as Record<string, unknown>)) {
    let name: unknown;
    if (Array.isArray(info)) name = info[0];
    else if (info && typeof info === 'object') name = (info as Record<string, unknown>).name;
    if (typeof name === 'string' && name) accounts.set(String(userId), name);
  }
  const submissions = (d.submissions as unknown[])
    .filter((s): s is unknown[] => Array.isArray(s) && s.length >= 4)
    .map((s) => ({ userId: String(s[0]), problem: Number(s[1]), accepted: Number(s[2]) === 1, seconds: Number(s[3]) }))
    .filter((s) => Number.isFinite(s.problem) && Number.isFinite(s.seconds));
  return {
    id: Number(d.id),
    title: String(d.title ?? ''),
    begin: Number(d.begin) || 0,
    length: Number(d.length) || 0,
    accounts,
    submissions,
  };
}

export interface ContestInfo {
  id: number;
  title: string;
  begin: number | null;
  end: number | null;
  /** 0 = público; outros valores = acesso restrito. */
  openness: number | null;
  /** Informado pelo gateway ≥ 2.1. */
  access?: 'public' | 'authorized' | 'restricted';
  /** null quando o VJudge não revela as questões (contest privado sem sessão). */
  problems: { num: string; title: string; oj?: string }[] | null;
}

export function parseContestInfo(input: unknown): ContestInfo {
  if (!input || typeof input !== 'object') throw new VJudgeParseError('Resposta inesperada ao ler o contest.');
  const d = input as Record<string, unknown>;
  return {
    id: Number(d.id),
    title: String(d.title ?? ''),
    begin: typeof d.begin === 'number' ? d.begin : null,
    end: typeof d.end === 'number' ? d.end : null,
    openness: typeof d.openness === 'number' ? d.openness : null,
    access: d.access === 'public' || d.access === 'authorized' || d.access === 'restricted' ? d.access : undefined,
    problems: Array.isArray(d.problems)
      ? (d.problems as Record<string, unknown>[]).map((p, i) => ({
          num: String(p.num ?? problemLetter(i)),
          title: String(p.title ?? ''),
          oj: p.oj ? String(p.oj) : undefined,
        }))
      : null,
  };
}

/** Menor quantidade de questões compatível com o ranking (maior índice submetido + 1). */
export function problemCountHint(rank: RankData): number {
  return rank.submissions.reduce((m, s) => Math.max(m, s.problem + 1), 0);
}

/**
 * Gera/atualiza a lista de questões de um contest preservando as cores já escolhidas.
 * `colorOffset` desloca a paleta padrão para que contests diferentes comecem com cores diferentes.
 */
export function buildProblems(contest: string, previous: Problem[], items: { num?: string; title?: string }[], colorOffset = 0): Problem[] {
  return items.map((it, i) => {
    const prev = previous.find((p) => p.index === i);
    return {
      key: problemKey(contest, i),
      contest,
      index: i,
      letter: it.num || prev?.letter || problemLetter(i),
      title: it.title ?? prev?.title ?? '',
      color: prev?.color ?? defaultColor(i + colorOffset),
    };
  });
}

/** Primeiro Accepted (em segundos desde o início) por conta e por questão. */
export function firstAccepted(rank: RankData): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const s of rank.submissions) {
    if (!s.accepted) continue;
    const name = rank.accounts.get(s.userId);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!out.has(key)) out.set(key, new Map());
    const m = out.get(key)!;
    const prev = m.get(s.problem);
    if (prev === undefined || s.seconds < prev) m.set(s.problem, s.seconds);
  }
  return out;
}

export interface ApplyResult {
  state: AppState;
  events: AppEvent[];
  newAccepted: number;
}

/**
 * Incorpora o ranking ao estado.
 *
 * Regras de consistência:
 * - Só ADICIONA informações de Accepted. Nunca remove uma questão resolvida.
 * - Nunca altera `deliveredAt` (controle manual do organizador).
 * - Um Accepted marcado manualmente passa a ser "vjudge" quando o VJudge o confirma.
 * - Notifica cada (unidade, questão) uma única vez, usando `state.notified`.
 * - Na primeira leitura de um contest já em andamento, agrupa as notificações.
 */
export function applyRank(state: AppState, contestKey: string, rank: RankData, now: number): ApplyResult {
  const contest = findContest(state, contestKey);
  if (!contest) throw new Error('Contest não encontrado.');
  const units = buildUnits(state);
  const acByAccount = firstAccepted(rank);
  const notified = new Set(state.notified);
  const results = { ...state.results };
  const fresh: { unitName: string; problem: number; account: string; at: number; key: string }[] = [];
  const firstSync = contest.lastSyncAt === null;
  const problemCount = contest.problems.length;

  for (const unit of units) {
    // Melhor (mais cedo) Accepted entre as contas da unidade.
    const best = new Map<number, { seconds: number; account: string }>();
    for (const acc of unit.accounts) {
      const m = acByAccount.get(acc);
      if (!m) continue;
      m.forEach((sec, prob) => {
        const cur = best.get(prob);
        if (!cur || sec < cur.seconds) best.set(prob, { seconds: sec, account: acc });
      });
    }
    if (best.size === 0) continue;
    const row = { ...(results[unit.id] ?? {}) };
    best.forEach(({ seconds, account }, prob) => {
      if (problemCount > 0 && prob >= problemCount) return; // questão fora da grade configurada
      const pk = problemKey(contestKey, prob);
      const prev: Cell = row[pk] ?? {};
      const solvedAt = rank.begin + seconds * 1000;
      if (prev.solvedAt !== undefined && prev.solvedSource === 'vjudge') return;
      row[pk] = {
        ...prev,
        solvedAt,
        solvedSource: 'vjudge',
        account,
        detectedAt: prev.detectedAt ?? now,
      };
      const key = `${unit.id}:${pk}`;
      if (!notified.has(key)) {
        notified.add(key);
        if (prev.solvedAt === undefined) fresh.push({ unitName: unit.name, problem: prob, account, at: solvedAt, key });
      }
    });
    results[unit.id] = row;
  }

  const letter = (i: number) => {
    const p = contest.problems.find((x) => x.index === i);
    return problemLabel(state, p ?? { contest: contestKey, letter: problemLetter(i) });
  };
  const color = (i: number) => contest.problems.find((p) => p.index === i)?.color;
  const events: AppEvent[] = [];
  const log: LogEntry[] = [];
  fresh.sort((a, b) => a.at - b.at);
  if (firstSync && fresh.length > 3) {
    events.push({
      id: uid('ev'),
      kind: 'info',
      title: `${fresh.length} submissões aceitas importadas`,
      detail: 'Primeira leitura do ranking: os Accepted anteriores foram carregados de uma vez.',
    });
  } else {
    for (const f of fresh)
      events.push({
        id: uid('ev'),
        kind: 'ac',
        title: `${f.unitName} ACERTOU a questão ${letter(f.problem)}!`,
        detail: `conta ${f.account}`,
        color: color(f.problem),
      });
  }
  for (const f of fresh)
    log.push({ id: uid('log'), at: now, kind: 'ac', text: `${f.unitName} resolveu ${letter(f.problem)} (${f.account})` });

  const next = updateContest(
    { ...state, results, notified: [...notified], log: [...log.reverse(), ...state.log].slice(0, 300) },
    contestKey,
    (c) => ({
      ...c,
      contestTitle: rank.title || c.contestTitle,
      begin: rank.begin || c.begin,
      length: rank.length || c.length,
      seenAccounts: [...rank.accounts.values()].map((n) => n.toLowerCase()),
    }),
  );
  return {
    state: next,
    events,
    newAccepted: fresh.length,
  };
}

/**
 * Aviso não fatal sobre o conteúdo do ranking. Diferencia "contest sem acesso"
 * de "contest ainda sem submissões" e de "contas cadastradas não aparecem".
 */
export function rankWarning(state: AppState, contest: Contest, rank: RankData): string | null {
  if (rank.accounts.size === 0) {
    if (contest.contestAccess === 'restricted')
      return 'Contest privado e o gateway não tem acesso autorizado: o VJudge devolve o ranking vazio. Use "Testar conexão" para ver o diagnóstico.';
    return null; // acessível e ainda sem submissões
  }
  const mine = new Set(buildUnits(state).flatMap((u) => u.accounts));
  if (mine.size === 0) return 'Nenhum username do VJudge cadastrado: associe as contas na tela VJudge.';
  const seen = [...rank.accounts.values()].map((n) => n.toLowerCase());
  if (!seen.some((n) => mine.has(n)))
    return `Nenhuma das ${mine.size} contas cadastradas aparece entre as ${seen.length} do ranking. Confira os usernames.`;
  return null;
}
