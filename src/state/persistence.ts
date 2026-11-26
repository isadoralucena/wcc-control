/**
 * Persistência local (LocalStorage) e importação/exportação em JSON.
 *
 * A interface `StateStorage` isola o mecanismo de armazenamento: para
 * sincronizar vários dispositivos (Firebase/Supabase), basta implementar
 * outra versão dela — o restante da aplicação não muda.
 */
import type { AppState, Contest, CustomLabSpec, Problem } from '../domain/types';
import { newContest, problemKey } from '../domain/contests';
import { defaultState } from './defaults';

export const STORAGE_KEY = 'wcc-control:state:v1';

export interface StateStorage {
  load(): AppState | null;
  save(state: AppState): void;
  clear(): void;
}

const ACCESS = ['public', 'authorized', 'restricted'] as const;
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normaliza um contest salvo (preenche campos ausentes, garante chaves das questões). */
function hydrateContest(raw: Record<string, unknown>, fallbackTag: string): Contest {
  const key = str(raw.key) || newContest([]).key;
  const problems = (Array.isArray(raw.problems) ? raw.problems : []) as Partial<Problem>[];
  return {
    ...newContest([]),
    key,
    tag: str(raw.tag, fallbackTag).slice(0, 6) || fallbackTag,
    contestInput: str(raw.contestInput),
    contestId: str(raw.contestId),
    contestAccess: ACCESS.find((x) => x === raw.contestAccess) ?? null,
    warning: null,
    contestTitle: str(raw.contestTitle),
    begin: numOrNull(raw.begin),
    length: numOrNull(raw.length),
    lastSyncAt: numOrNull(raw.lastSyncAt),
    lastSyncOk: typeof raw.lastSyncOk === 'boolean' ? raw.lastSyncOk : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    failures: 0,
    seenAccounts: Array.isArray(raw.seenAccounts) ? raw.seenAccounts.map(String) : [],
    problems: problems.map((p, i) => {
      const index = Number.isInteger(p.index) ? (p.index as number) : i;
      return { key: problemKey(key, index), contest: key, index, letter: str(p.letter), title: str(p.title), color: str(p.color, '#61D295') };
    }),
  };
}

/**
 * Mescla um objeto possivelmente incompleto/antigo com os valores padrão.
 *
 * Migração v1 → v2: a v1 tinha laboratórios com capacidade digitada à mão e
 * alocação por linha/coluna. Na v2 os laboratórios vêm do site do LCC; por
 * isso a configuração manual e a alocação antiga são descartadas, e todo o
 * resto (participantes, equipes, questões, submissões, balões) é mantido.
 *
 * Migração v2 → v3: a v2 acompanhava um único contest (`vjudge.contest*`,
 * `problems` e `results[unidade][índice]`). Na v3 há uma lista de contests; o
 * contest antigo vira o primeiro da lista e os resultados passam a ser
 * indexados pela chave da questão ("<contest>:<índice>"). Nada é perdido.
 */
export function hydrate(raw: unknown): AppState {
  if (!raw || typeof raw !== 'object') throw new Error('Arquivo sem dados da competição.');
  const r = raw as Record<string, unknown> & Partial<AppState>;
  const version = (raw as { version?: unknown }).version;
  if (version !== 1 && version !== 2 && version !== 3) throw new Error('Versão de arquivo não reconhecida.');
  if (!Array.isArray(r.participants)) throw new Error('Estrutura de dados inválida.');
  const d = defaultState();
  const v1 = version === 1;
  const oldVj = (r.vjudge ?? {}) as Record<string, unknown>;
  const catalog = r.labCatalog && Array.isArray(r.labCatalog.labs) && r.labCatalog.labs.length ? r.labCatalog : d.labCatalog;

  let contests: Contest[];
  let results: AppState['results'] = (r.results ?? {}) as AppState['results'];
  let notified: string[] = Array.isArray(r.notified) ? r.notified.map(String) : [];
  if (version === 3 && Array.isArray(r.contests) && r.contests.length) {
    contests = (r.contests as unknown as Record<string, unknown>[]).map((c, i) => hydrateContest(c, `C${i + 1}`));
  } else {
    // v1/v2: um único contest em `vjudge` + `problems`; resultados por índice.
    const legacy = hydrateContest({ ...oldVj, key: d.contests[0].key, tag: 'C1', problems: (r as { problems?: unknown }).problems ?? [] }, 'C1');
    contests = [legacy];
    const k = legacy.key;
    results = Object.fromEntries(
      Object.entries(results).map(([unit, row]) => [unit, Object.fromEntries(Object.entries(row ?? {}).map(([idx, cell]) => [problemKey(k, Number(idx)), cell]))]),
    );
    notified = notified.map((n) => {
      const i = n.lastIndexOf(':');
      return i > 0 ? `${n.slice(0, i)}:${problemKey(k, Number(n.slice(i + 1)))}` : n;
    });
  }

  const customLabs = Array.isArray(r.customLabs) ? (r.customLabs as CustomLabSpec[]).filter((l) => l && typeof l.id === 'string' && l.machines > 0) : [];
  return {
    ...d,
    competitionName: String(r.competitionName ?? ''),
    gatewayUrl: String(r.gatewayUrl ?? (v1 ? (oldVj.proxyUrl ?? '') : '')),
    labCatalog: catalog,
    labSelection: v1 ? {} : (r.labSelection ?? {}),
    customLabs,
    participants: r.participants,
    mode: r.mode === 'team' ? 'team' : 'individual',
    teamSettings: { size: r.teamSettings?.size === 2 ? 2 : 3, remainder: r.teamSettings?.remainder === 'smaller' ? 'smaller' : 'balance' },
    teams: r.teams ?? [],
    allocationSettings: { ...d.allocationSettings, ...r.allocationSettings },
    allocation: v1 ? null : (r.allocation ?? null),
    vjudge: {
      // Com gateway disponível, o modo automático é o padrão (a v1 começava em "colar JSON").
      source: (r.gatewayUrl || oldVj.proxyUrl || d.vjudge.source === 'gateway') && (v1 || oldVj.source !== 'paste') ? 'gateway' : oldVj.source === 'paste' ? 'paste' : d.vjudge.source,
      autoPoll: typeof oldVj.autoPoll === 'boolean' ? oldVj.autoPoll : d.vjudge.autoPoll,
      pollSeconds: typeof oldVj.pollSeconds === 'number' ? Math.max(10, oldVj.pollSeconds) : d.vjudge.pollSeconds,
    },
    contests,
    results,
    notified,
    log: r.log ?? [],
    version: 3,
    updatedAt: Number(r.updatedAt) || Date.now(),
  };
}

export const localStorageAdapter: StateStorage = {
  load() {
    try {
      const text = window.localStorage.getItem(STORAGE_KEY);
      return text ? hydrate(JSON.parse(text)) : null;
    } catch (err) {
      console.warn('[wcc] não foi possível ler o estado salvo', err);
      return null;
    }
  },
  save(state) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  },
  clear() {
    window.localStorage.removeItem(STORAGE_KEY);
  },
};

export interface ExportFile {
  app: 'wcc-control';
  exportedAt: string;
  state: AppState;
}

export function exportState(state: AppState): string {
  const file: ExportFile = { app: 'wcc-control', exportedAt: new Date().toISOString(), state };
  return JSON.stringify(file, null, 2);
}

export function importState(text: string): AppState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('O arquivo não é um JSON válido.');
  }
  const p = parsed as Partial<ExportFile>;
  return hydrate(p && p.app === 'wcc-control' ? p.state : parsed);
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugify(s: string) {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'competicao'
  );
}
