import type { Participant } from './types';
import { uid } from './ids';

/** Normaliza um nome para comparação (sem acentos, caixa, espaços extras). */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Limpa um nome digitado: remove espaços duplicados, marcadores e numeração de lista. */
export function cleanName(raw: string): string {
  return raw
    .replace(/\t+/g, ' ')
    .replace(/^\s*(?:[-*•·]|\d{1,3}[.)\-–])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanUsername(raw: string): string {
  return raw.replace(/^@/, '').trim();
}

/** Divide o texto colado em linhas não vazias. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export interface ParsedList {
  names: string[];
  /** Linhas descartadas por duplicidade (dentro da própria lista ou já cadastradas). */
  duplicates: string[];
}

/**
 * Interpreta uma lista colada: uma participante por linha.
 * Remove linhas vazias e duplicadas (comparação sem acento/caixa).
 */
export function parseNameList(text: string, existing: string[] = []): ParsedList {
  const seen = new Set(existing.map(normalizeName));
  const names: string[] = [];
  const duplicates: string[] = [];
  for (const line of splitLines(text)) {
    const name = cleanName(line);
    if (!name) continue;
    const key = normalizeName(name);
    if (seen.has(key)) {
      duplicates.push(name);
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return { names, duplicates };
}

/** Lista de usernames, preservando posição (linhas vazias contam como "sem username"? não: são removidas). */
export function parseUsernameList(text: string): string[] {
  return splitLines(text).map(cleanUsername);
}

export interface PairingPreview {
  pairs: { name: string; username: string }[];
  duplicates: string[];
  nameCount: number;
  usernameCount: number;
  mismatch: boolean;
  /** Usernames repetidos na lista colada. */
  repeatedUsernames: string[];
}

/**
 * Opção A — cadastro conjunto: associa nomes e usernames pela ordem.
 * Se as listas tiverem tamanhos diferentes, `mismatch` fica verdadeiro e
 * os nomes sem par recebem username vazio (só aplicado após confirmação na UI).
 */
export function pairLists(namesText: string, usernamesText: string, existing: string[] = []): PairingPreview {
  // Pareamos linha a linha ANTES de remover duplicadas, para não desalinhar as listas.
  const rawNames = splitLines(namesText).map(cleanName).filter(Boolean);
  const usernames = parseUsernameList(usernamesText);
  const seen = new Set(existing.map(normalizeName));
  const pairs: { name: string; username: string }[] = [];
  const duplicates: string[] = [];
  rawNames.forEach((name, i) => {
    const key = normalizeName(name);
    if (seen.has(key)) {
      duplicates.push(name);
      return;
    }
    seen.add(key);
    pairs.push({ name, username: usernames[i] ?? '' });
  });
  const counts = new Map<string, number>();
  for (const u of usernames) counts.set(u.toLowerCase(), (counts.get(u.toLowerCase()) ?? 0) + 1);
  const repeatedUsernames = [...counts.entries()].filter(([, c]) => c > 1).map(([u]) => u);
  return {
    pairs,
    duplicates,
    nameCount: rawNames.length,
    usernameCount: usernames.length,
    mismatch: rawNames.length !== usernames.length,
    repeatedUsernames,
  };
}

export function createParticipants(entries: { name: string; username?: string }[]): Participant[] {
  return entries.map((e) => ({ id: uid('p'), name: e.name, vjudge: cleanUsername(e.username ?? '') }));
}

/** Verifica se um nome já existe (ignorando a própria participante). */
export function isDuplicateName(list: Participant[], name: string, ignoreId?: string): boolean {
  const key = normalizeName(name);
  return list.some((p) => p.id !== ignoreId && normalizeName(p.name) === key);
}
