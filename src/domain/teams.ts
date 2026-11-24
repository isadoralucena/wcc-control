import type { AppState, Participant, RemainderStrategy, Team, TeamSettings, Unit } from './types';
import { pad, uid } from './ids';

/**
 * Calcula os tamanhos das equipes para `total` participantes.
 * Nunca descarta participantes.
 *
 * - 'smaller': equipes do tamanho padrão + uma última equipe menor.
 * - 'balance': evita equipes de 1 pessoa, redistribuindo o resto
 *   (ex.: 7 pessoas em trios → 3 + 2 + 2; 5 pessoas em duplas → 2 + 3).
 */
export function teamSizes(total: number, size: 2 | 3, strategy: RemainderStrategy): number[] {
  if (total <= 0) return [];
  const full = Math.floor(total / size);
  const rest = total % size;
  const sizes = Array<number>(full).fill(size);
  if (rest === 0) return sizes;
  if (strategy === 'smaller' || full === 0) return [...sizes, rest];
  if (size === 3) {
    // rest 2 → uma dupla; rest 1 → desfaz um trio e forma duas duplas.
    if (rest === 2) return [...sizes, 2];
    return [...sizes.slice(0, -1), 2, 2];
  }
  // size 2, rest 1 → a última dupla vira trio.
  return [...sizes.slice(0, -1), 3];
}

export function shuffle<T>(arr: T[], random: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Forma equipes automaticamente a partir da ordem informada. */
export function formTeams(participants: Participant[], settings: TeamSettings, randomize = false): Team[] {
  const ordered = randomize ? shuffle(participants) : participants;
  const sizes = teamSizes(ordered.length, settings.size, settings.remainder);
  const teams: Team[] = [];
  let cursor = 0;
  sizes.forEach((s, i) => {
    teams.push({
      id: uid('t'),
      name: `Equipe ${pad(i + 1)}`,
      memberIds: ordered.slice(cursor, cursor + s).map((p) => p.id),
      vjudge: '',
    });
    cursor += s;
  });
  return teams;
}

/** Remove de equipes as integrantes que não existem mais e descarta equipes vazias. */
export function cleanTeams(teams: Team[], participants: Participant[]): Team[] {
  const ids = new Set(participants.map((p) => p.id));
  return teams
    .map((t) => ({ ...t, memberIds: t.memberIds.filter((m) => ids.has(m)) }))
    .filter((t) => t.memberIds.length > 0);
}

/** Participantes que não estão em nenhuma equipe. */
export function unassignedParticipants(teams: Team[], participants: Participant[]): Participant[] {
  const inTeam = new Set(teams.flatMap((t) => t.memberIds));
  return participants.filter((p) => !inTeam.has(p.id));
}

/** Move uma integrante para outra equipe (ou para fora de qualquer equipe, se `toTeamId` for null). */
export function moveMember(teams: Team[], participantId: string, toTeamId: string | null): Team[] {
  return teams.map((t) => {
    const without = t.memberIds.filter((m) => m !== participantId);
    if (t.id === toTeamId) return { ...t, memberIds: [...without, participantId] };
    return { ...t, memberIds: without };
  });
}

/**
 * Constrói as unidades alocáveis a partir do estado.
 * Individual: 1 unidade = 1 participante = 1 cadeira = 1 computador.
 * Em grupo:   1 unidade = 1 equipe = 1 cadeira por integrante + 1 computador compartilhado.
 */
export function buildUnits(state: Pick<AppState, 'mode' | 'participants' | 'teams'>): Unit[] {
  const lower = (s: string) => s.trim().toLowerCase();
  if (state.mode === 'individual') {
    return state.participants.map((p) => ({
      id: p.id,
      name: p.name,
      members: [p],
      accounts: p.vjudge.trim() ? [lower(p.vjudge)] : [],
      seats: 1,
    }));
  }
  const byId = new Map(state.participants.map((p) => [p.id, p]));
  return state.teams
    .filter((t) => t.memberIds.length > 0)
    .map((t) => {
      const members = t.memberIds.map((m) => byId.get(m)).filter((p): p is Participant => !!p);
      const accounts = new Set<string>();
      if (t.vjudge.trim()) accounts.add(lower(t.vjudge));
      members.forEach((m) => m.vjudge.trim() && accounts.add(lower(m.vjudge)));
      return { id: t.id, name: t.name, members, accounts: [...accounts], seats: Math.max(1, members.length) };
    });
}
