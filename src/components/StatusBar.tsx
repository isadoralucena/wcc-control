/**
 * Barra de status (como a de um editor/IDE), fixa no rodapé de todas as telas.
 * Mantém à vista o que importa durante a prova, em qualquer etapa:
 * origem dos dados do VJudge, relógio de cada contest, balões pendentes e
 * salvamento local. Não executa nenhuma ação nova: só leitura e navegação.
 */
import type { Route } from '../App';
import { useStore } from '../state/store';
import { useSync } from '../services/sync';
import { gatewayUrl } from '../services/gateway';
import { overview } from '../domain/balloons';
import { Balloon } from './Balloon';
import { contestClock, formatTime, useNow } from './ui';

export function StatusBar({ go }: { go: (r: Route) => void }) {
  const { state, units, saveStatus } = useStore();
  const { busy } = useSync();
  const now = useNow(1000);
  const v = state.vjudge;
  const base = gatewayUrl(state);
  const linked = state.contests.filter((c) => c.contestId);
  const failing = linked.filter((c) => c.lastSyncOk === false);
  const pending = overview(state, units).pending;
  const multi = state.contests.length > 1;

  const source =
    v.source === 'paste' ? 'colar JSON' : !base ? 'sem gateway' : v.autoPoll && linked.length ? `auto · ${Math.max(10, v.pollSeconds)}s` : 'manual';
  const tone = failing.length ? 'bad' : v.source === 'gateway' && base && linked.length && v.autoPoll ? 'live' : 'idle';

  return (
    <footer className="statusbar noprint" aria-label="Barra de status">
      <button className={`sb sb--src is-${tone}`} onClick={() => go('vjudge')} title={failing.length ? failing.map((c) => `${c.tag}: ${c.lastError}`).join('\n') : 'Configuração do VJudge'}>
        <span className={`sb__dot ${busy ? 'is-busy' : ''}`} />
        <span className="sb__long">vjudge</span> <b>{source}</b>
        {failing.length > 0 && <span className="sb__err">falha {failing.map((c) => c.tag).join(', ')}</span>}
      </button>

      <div className="sb sb--clocks">
        {linked.length === 0 ? (
          <span className="sb__muted">nenhum contest</span>
        ) : (
          linked.map((c) => {
            const clock = contestClock(now, c.begin, c.length);
            const ended = c.begin && c.length ? now > c.begin + c.length : false;
            return (
              <span key={c.key} className="sb__clock" title={c.contestTitle || `#${c.contestId}`}>
                {multi && <span className="sb__tag">{c.tag}</span>}
                {clock ? (
                  <>
                    <b>{clock}</b>
                    {ended && <span className="sb__muted"> fim</span>}
                  </>
                ) : c.begin && now < c.begin ? (
                  <span className="sb__muted">início {formatTime(c.begin, false)}</span>
                ) : (
                  <span className="sb__muted">#{c.contestId}</span>
                )}
              </span>
            );
          })
        )}
      </div>

      <button className={`sb sb--balloons ${pending ? 'has-pending' : ''}`} onClick={() => go('painel')} title="Abrir a fila de balões na Arena">
        <Balloon color={pending ? 'var(--ink)' : 'transparent'} muted={!pending} size={15} />
        <b>{pending}</b> <span className="sb__long">{pending === 1 ? 'balão' : 'balões'}</span> {pending === 1 ? 'pendente' : 'pendentes'}
      </button>

      <span className="sb sb--spacer" />

      <span className="sb sb--keys" title="Atalhos de teclado">
        <kbd>1</kbd>–<kbd>4</kbd> etapas
      </span>
      <span className={`sb sb--save ${saveStatus.error ? 'is-bad' : ''}`} title={saveStatus.error ?? 'Salvo automaticamente neste navegador'}>
        <span className="sb__dot" />
        {saveStatus.error ? 'erro ao salvar' : saveStatus.at ? <><span className="sb__long">salvo </span>{formatTime(saveStatus.at, false)}</> : 'local'}
      </span>
    </footer>
  );
}
