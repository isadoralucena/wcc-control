let counter = 0;

/** Gera um identificador curto e único o suficiente para uso local. */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

/** Letra da questão a partir do índice: 0 → A, 25 → Z, 26 → AA. */
export function problemLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function pad(n: number, size = 2): string {
  return String(n).padStart(size, '0');
}
