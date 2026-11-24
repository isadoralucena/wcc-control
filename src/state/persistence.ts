/**
 * Persistência local (LocalStorage) e importação/exportação em JSON.
 *
 * A interface `StateStorage` isola o mecanismo de armazenamento: para
 * sincronizar vários dispositivos (Firebase/Supabase), basta implementar
 * outra versão dela — o restante da aplicação não muda.
 */
import type { AppState } from '../domain/types';
import { defaultState } from './defaults';

export const STORAGE_KEY = 'wcc-control:state:v1';

export interface StateStorage {
  load(): AppState | null;
  save(state: AppState): void;
  clear(): void;
}

/**
 * Mescla um objeto possivelmente incompleto/antigo com os valores padrão.
 *
 * Migração v1 → v2: a v1 tinha laboratórios com capacidade digitada à mão e
 * alocação por linha/coluna. Na v2 os laboratórios vêm do site do LCC; por
 * isso a configuração manual e a alocação antiga são descartadas, e todo o
 * resto (participantes, equipes, questões, submissões, balões) é mantido.
 */
export function hydrate(raw: unknown): AppState {
  if (!raw || typeof raw !== 'object') throw new Error('Arquivo sem dados da competição.');
  const r = raw as Record<string, unknown> & Partial<AppState>;
  const version = (raw as { version?: unknown }).version;
  if (version !== 1 && version !== 2) throw new Error('Versão de arquivo não reconhecida.');
  if (!Array.isArray(r.participants)) throw new Error('Estrutura de dados inválida.');
  const d = defaultState();
  const v1 = version === 1;
  const oldVj = (r.vjudge ?? {}) as Record<string, unknown>;
  const catalog = r.labCatalog && Array.isArray(r.labCatalog.labs) && r.labCatalog.labs.length ? r.labCatalog : d.labCatalog;
  return {
    ...d,
    competitionName: String(r.competitionName ?? ''),
    gatewayUrl: String(r.gatewayUrl ?? (v1 ? (oldVj.proxyUrl ?? '') : '')),
    labCatalog: catalog,
    labSelection: v1 ? {} : (r.labSelection ?? {}),
    participants: r.participants,
    mode: r.mode === 'team' ? 'team' : 'individual',
    teamSettings: { size: r.teamSettings?.size === 2 ? 2 : 3, remainder: r.teamSettings?.remainder === 'smaller' ? 'smaller' : 'balance' },
    teams: r.teams ?? [],
    allocationSettings: { ...d.allocationSettings, ...r.allocationSettings },
    allocation: v1 ? null : (r.allocation ?? null),
    vjudge: {
      ...d.vjudge,
      ...(r.vjudge ?? {}),
      // Com gateway disponível, o modo automático é o padrão (a v1 começava em "colar JSON").
      source: (r.gatewayUrl || oldVj.proxyUrl || d.vjudge.source === 'gateway') && (v1 || oldVj.source !== 'paste') ? 'gateway' : oldVj.source === 'paste' ? 'paste' : d.vjudge.source,
      contestAccess: (['public', 'authorized', 'restricted'] as const).find((x) => x === oldVj.contestAccess) ?? null,
      warning: null,
      failures: 0,
    },
    problems: r.problems ?? [],
    results: r.results ?? {},
    notified: r.notified ?? [],
    log: r.log ?? [],
    version: 2,
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
