/**
 * Ponto de entrada do WCC Gateway no Cloudflare Workers.
 *
 * O runtime do Workers só aceita handlers como exports do módulo principal,
 * por isso a lógica fica em `core.js` e aqui exportamos apenas o `default`.
 */
import { handle } from './core.js';

export default {
  async fetch(request, env) {
    return handle(request, env, typeof caches !== 'undefined' ? caches.default : null);
  },
};
