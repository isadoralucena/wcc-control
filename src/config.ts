/**
 * Configuração definida no build.
 *
 * VITE_WCC_GATEWAY_URL: URL do WCC Gateway. Definida como variável do
 * repositório no GitHub (Settings → Secrets and variables → Actions →
 * Variables), faz com que todo navegador que abrir o app já venha conectado,
 * sem nenhuma configuração manual. O organizador ainda pode sobrescrever na tela VJudge.
 */
export const BUILD_GATEWAY_URL: string = (import.meta.env.VITE_WCC_GATEWAY_URL ?? '').trim();
