/**
 * Modelo de dados do WCC Control.
 *
 * Tudo aqui é serializável em JSON: é exatamente o que vai para o
 * LocalStorage e para o arquivo de exportação.
 */

export type Id = string;

/* ------------------------------------------------------------------ */
/* Laboratórios (dados de https://lcc.ufcg.edu.br/)                    */
/* ------------------------------------------------------------------ */

/** Status da máquina no momento da consulta ao site do LCC. */
export type MachineStatus = 'ok' | 'down' | 'unknown';

/** Célula da planta: computador (com sua cadeira), porta de acesso ou corredor/vazio. */
export type LccCell = { id: string; status: MachineStatus } | 'door' | null;

/**
 * Laboratório como publicado no site do LCC: a planta é uma grade e cada
 * computador ocupa uma célula. Regra física fixa: 1 computador = 1 cadeira.
 */
export interface LccLab {
  id: string;
  name: string;
  /** 'lcc' = planta do site do LCC/UFCG; 'custom' = laboratório cadastrado pelo organizador. */
  origin?: 'lcc' | 'custom';
  /** Direção das bancadas, quando conhecida (laboratórios personalizados). Sem ela, é detectada pela planta. */
  benchAxis?: 'h' | 'v';
  rows: number;
  cols: number;
  machines: number;
  cells: LccCell[][];
}

export interface LabCatalog {
  labs: LccLab[];
  /** Quando os dados foram obtidos na origem. */
  fetchedAt: number | null;
  /** 'gateway' = consulta ao vivo; 'snapshot' = cópia gerada automaticamente no build. */
  origin: 'gateway' | 'snapshot';
  lastAttemptAt: number | null;
  lastError: string | null;
}

/** Escolhas do organizador para um laboratório nesta competição. */
export interface LabSelection {
  selected: boolean;
  /** Computadores indisponíveis nesta competição (ex.: com defeito). */
  excluded: string[];
}

/** Posição da porta em um laboratório personalizado ("frente" = topo da planta). */
export type DoorPosition = 'front-left' | 'front-right' | 'back-left' | 'back-right' | 'none';

/**
 * Laboratório de outra instituição/local, descrito por parâmetros. A planta
 * (grade de computadores) é gerada a partir deles em `domain/customLabs.ts`,
 * no mesmo formato da planta do LCC — por isso a alocação funciona igual.
 */
export interface CustomLabSpec {
  /** Sigla única; também é o prefixo das máquinas (SALA1 → SALA1-01). */
  id: string;
  name: string;
  /** Computadores (= cadeiras). */
  machines: number;
  /** Quantidade de bancadas (fileiras ou colunas de computadores). */
  benches: number;
  /** 'h' = corredores horizontais (bancadas em fileiras); 'v' = corredores verticais (bancadas em colunas). */
  orientation: 'h' | 'v';
  /** Bancadas em pares, costas com costas (um corredor a cada duas bancadas). */
  paired: boolean;
  door: DoorPosition;
}

/** Laboratório pronto para uso: dados do site + escolhas do organizador. */
export interface Room extends LccLab {
  selected: boolean;
  excluded: string[];
}

/* ------------------------------------------------------------------ */
/* Participantes e equipes                                             */
/* ------------------------------------------------------------------ */

export interface Participant {
  id: Id;
  name: string;
  /** Username do VJudge. Pode ficar vazio e ser preenchido depois. */
  vjudge: string;
}

export interface Team {
  id: Id;
  name: string;
  memberIds: Id[];
  /** Conta do VJudge usada pela equipe (opcional; as contas das integrantes também contam). */
  vjudge: string;
}

export type Mode = 'individual' | 'team';

export type RemainderStrategy = 'balance' | 'smaller';

/**
 * Regras físicas fixas (não configuráveis):
 * - individual: 1 cadeira e 1 computador por participante;
 * - equipe: 1 cadeira por integrante, todas vizinhas, e 1 computador compartilhado.
 */
export interface TeamSettings {
  /** Tamanho padrão das equipes. */
  size: 2 | 3;
  /** O que fazer quando o total não é divisível pelo tamanho. */
  remainder: RemainderStrategy;
}

/* ------------------------------------------------------------------ */
/* Alocação                                                            */
/* ------------------------------------------------------------------ */

export type SeatOrder = 'list' | 'alpha' | 'random';

export interface AllocationSettings {
  /** Espaçamento máximo desejado (posições vazias entre unidades). */
  maxGap: 0 | 1 | 2;
  order: SeatOrder;
}

/** Lugares ocupados por uma "unidade" (participante no individual, equipe no modo em grupo). */
export interface Placement {
  unitId: Id;
  labId: Id;
  /** Computadores cujas cadeiras a unidade ocupa, vizinhos e em ordem (ex.: LCC1-06, LCC1-07, LCC1-08). */
  seats: string[];
  /** Computador efetivamente usado (sempre um dos `seats`). */
  computer: string;
}

export interface LabReport {
  labId: Id;
  units: number;
  /** Quantas unidades caberiam com o espaçamento adotado. */
  capacity: number;
  /** Computadores (= cadeiras) disponíveis no laboratório. */
  machines: number;
}

export interface AllocationReport {
  ok: boolean;
  units: number;
  gap: number;
  maxGap: number;
  /** Computadores = cadeiras disponíveis nos laboratórios selecionados (sem os excluídos). */
  machinesAvailable: number;
  /** Computadores que serão usados (1 por unidade). */
  computersUsed: number;
  /** Cadeiras ocupadas por pessoas. */
  seatsOccupied: number;
  /** Posições (computador + cadeira) livres. */
  free: number;
  perLab: LabReport[];
  /** Por que não foi possível usar o espaçamento máximo (se for o caso). */
  reason?: string;
  error?: string;
}

export interface Allocation {
  placements: Record<Id, Placement>;
  report: AllocationReport;
  computedAt: number;
  /** Mudou manualmente depois do cálculo automático? */
  edited: boolean;
}

/* ------------------------------------------------------------------ */
/* Contest / VJudge                                                    */
/* ------------------------------------------------------------------ */

export interface Problem {
  /** Identificador global da questão: "<contest>:<índice>". Chave de `results`. */
  key: string;
  /** Contest ao qual a questão pertence (`Contest.key`). */
  contest: Id;
  /** Índice 0-based, o mesmo usado pelo VJudge no ranking. */
  index: number;
  letter: string;
  title: string;
  color: string;
}

export type DataSource = 'gateway' | 'paste';

/** Configuração do acompanhamento, comum a todos os contests. */
export interface VJudgeSettings {
  source: DataSource;
  autoPoll: boolean;
  pollSeconds: number;
}

/** Um contest do VJudge acompanhado (pode haver vários ao mesmo tempo). */
export interface Contest {
  /** Identificador local (não é o ID do VJudge). */
  key: Id;
  /** Sigla curta que distingue as questões quando há mais de um contest (ex.: "INI", "AVA"). */
  tag: string;
  contestInput: string;
  contestId: string;
  /**
   * Acesso detectado pelo gateway: 'public' (aberto), 'authorized' (privado, sessão do
   * gateway entrou no contest) ou 'restricted' (privado, sem acesso). null = ainda não consultado.
   */
  contestAccess: 'public' | 'authorized' | 'restricted' | null;
  /** Aviso não fatal da última leitura (ex.: ranking vazio por falta de acesso). */
  warning: string | null;
  contestTitle: string;
  begin: number | null;
  length: number | null;
  lastSyncAt: number | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  /** Falhas consecutivas da atualização automática. */
  failures: number;
  /** Usernames (minúsculos) que apareceram no ranking na última leitura. */
  seenAccounts: string[];
  problems: Problem[];
}

/**
 * Estado de uma questão para uma unidade.
 * "Resolvida" e "balão entregue" são guardados separadamente:
 * entregar um balão nunca apaga o registro da submissão aceita.
 */
export interface Cell {
  solvedAt?: number;
  solvedSource?: 'vjudge' | 'manual';
  /** Quando o sistema detectou o Accepted. */
  detectedAt?: number;
  /** Conta do VJudge que gerou o Accepted. */
  account?: string;
  deliveredAt?: number;
}

/** results[unitId][problemKey] — problemKey = Problem.key ("<contest>:<índice>"). */
export type Results = Record<Id, Record<string, Cell>>;

export type LogKind = 'ac' | 'delivered' | 'undo' | 'manual' | 'sync' | 'info';

export interface LogEntry {
  id: Id;
  at: number;
  kind: LogKind;
  text: string;
}

/** Eventos que viram notificações (consumidos pela UI, não persistidos). */
export interface AppEvent {
  id: Id;
  kind: 'ac' | 'column-done' | 'pending' | 'sync-error' | 'info';
  title: string;
  detail?: string;
  color?: string;
}

/* ------------------------------------------------------------------ */
/* Estado global                                                       */
/* ------------------------------------------------------------------ */

export interface AppState {
  version: 3;
  competitionName: string;
  /** URL do WCC Gateway (vazio = usa o padrão definido no build, se houver). */
  gatewayUrl: string;
  labCatalog: LabCatalog;
  /** Escolhas por laboratório, indexadas pela sigla (LCC1, LCC2...). */
  labSelection: Record<Id, LabSelection>;
  /** Laboratórios cadastrados manualmente (outras instituições/locais). */
  customLabs: CustomLabSpec[];
  participants: Participant[];
  mode: Mode;
  teamSettings: TeamSettings;
  teams: Team[];
  allocationSettings: AllocationSettings;
  allocation: Allocation | null;
  vjudge: VJudgeSettings;
  /** Contests acompanhados, na ordem de exibição. */
  contests: Contest[];
  results: Results;
  /** Chaves "unidade:questão" (questão = Problem.key) já notificadas, para nunca repetir notificação. */
  notified: string[];
  log: LogEntry[];
  updatedAt: number;
}

/** Unidade alocável e acompanhável: uma participante ou uma equipe. */
export interface Unit {
  id: Id;
  name: string;
  members: Participant[];
  /** Contas do VJudge que contam para esta unidade (minúsculas, sem vazios). */
  accounts: string[];
  /** Cadeiras ocupadas = número de pessoas. Toda unidade usa exatamente 1 computador. */
  seats: number;
}
