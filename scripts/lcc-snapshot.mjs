/**
 * Gera src/data/lcc-snapshot.json a partir de https://lcc.ufcg.edu.br/,
 * usando o mesmo parser do WCC Gateway.
 *
 * Roda no build (GitHub Actions) para que o app tenha uma cópia recente dos
 * laboratórios mesmo antes de o gateway ser configurado ou se ele cair.
 * Se o site estiver fora do ar, mantém o snapshot anterior e não quebra o build.
 *
 * Os status das máquinas (OK/DOWN) NÃO são gravados: mudam a todo momento e
 * só fazem sentido na consulta ao vivo. Usuários logados nunca são lidos.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { parseLcc } from '../gateway/core.js';

const OUT = new URL('../src/data/lcc-snapshot.json', import.meta.url);

try {
  const res = await fetch('https://lcc.ufcg.edu.br/', { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'wcc-control-build' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const labs = parseLcc(await res.text()).map((lab) => ({
    ...lab,
    cells: lab.cells.map((row) => row.map((c) => (c && typeof c === 'object' ? { id: c.id, status: 'unknown' } : c))),
  }));
  if (!labs.length) throw new Error('nenhum laboratório reconhecido');
  writeFileSync(OUT, JSON.stringify({ source: 'https://lcc.ufcg.edu.br/', fetchedAt: Date.now(), labs }) + '\n');
  console.log(`[lcc] snapshot atualizado: ${labs.map((l) => `${l.id}=${l.machines}`).join(', ')}`);
} catch (err) {
  console.warn(`[lcc] não foi possível atualizar o snapshot (${err.message}).`);
  if (!existsSync(OUT)) {
    writeFileSync(OUT, JSON.stringify({ source: 'https://lcc.ufcg.edu.br/', fetchedAt: null, labs: [] }) + '\n');
    console.warn('[lcc] snapshot vazio criado; o app dependerá do gateway.');
  }
}
