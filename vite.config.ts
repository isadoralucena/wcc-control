import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` gera caminhos relativos: o build funciona em
// https://<usuario>.github.io/<repositorio>/ sem precisar saber o nome do repo.
// A navegação usa hash (#/mapa), então não há problema de 404 no GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [react()],
  test: { environment: 'node' },
} as never);
