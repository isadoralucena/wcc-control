import type { AppState, LabCatalog, LccLab } from '../domain/types';
import snapshot from '../data/lcc-snapshot.json';
import { BUILD_GATEWAY_URL } from '../config';

/**
 * Catálogo inicial dos laboratórios: cópia de https://lcc.ufcg.edu.br/
 * gerada automaticamente no build (scripts/lcc-snapshot.mjs). Assim que o
 * gateway responde, é substituída pela consulta ao vivo.
 */
export function snapshotCatalog(): LabCatalog {
  return {
    labs: (snapshot.labs ?? []) as unknown as LccLab[],
    fetchedAt: snapshot.fetchedAt ?? null,
    origin: 'snapshot',
    lastAttemptAt: null,
    lastError: null,
  };
}

export function defaultState(): AppState {
  return {
    version: 2,
    competitionName: '',
    gatewayUrl: '',
    labCatalog: snapshotCatalog(),
    labSelection: {},
    participants: [],
    mode: 'individual',
    teamSettings: { size: 3, remainder: 'balance' },
    teams: [],
    allocationSettings: { maxGap: 2, order: 'list' },
    allocation: null,
    vjudge: {
      contestInput: '',
      contestId: '',
      contestAccess: null,
      warning: null,
      source: BUILD_GATEWAY_URL ? 'gateway' : 'paste',
      // Liga por padrão: só roda quando houver gateway e contest configurados.
      autoPoll: true,
      pollSeconds: 15,
      contestTitle: '',
      begin: null,
      length: null,
      lastSyncAt: null,
      lastSyncOk: null,
      lastError: null,
      failures: 0,
      seenAccounts: [],
    },
    problems: [],
    results: {},
    notified: [],
    log: [],
    updatedAt: Date.now(),
  };
}
