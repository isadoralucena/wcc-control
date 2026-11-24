import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, MoreHorizontal, RotateCcw } from 'lucide-react';
import { WccLogo } from './components/WccLogo';
import { useStore } from './state/store';
import { useConfirm } from './components/Confirm';
import { useToasts } from './components/Toasts';
import { downloadText, exportState, importState, localStorageAdapter, slugify } from './state/persistence';
import { defaultState } from './state/defaults';
import { overview } from './domain/balloons';
import { formatTime } from './components/ui';
import { SetupScreen } from './screens/SetupScreen';
import { MapScreen } from './screens/MapScreen';
import { VJudgeScreen } from './screens/VJudgeScreen';
import { PanelScreen } from './screens/PanelScreen';

export type Route = 'setup' | 'mapa' | 'vjudge' | 'painel';

const STEPS: { id: Route; n: string; label: string }[] = [
  { id: 'setup', n: '01', label: 'Configuração' },
  { id: 'mapa', n: '02', label: 'Mapa de sala' },
  { id: 'vjudge', n: '03', label: 'VJudge' },
  { id: 'painel', n: '04', label: 'Arena' },
];

function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  return (STEPS.find((s) => s.id === h)?.id ?? 'setup') as Route;
}

/** Navegação por hash: compatível com GitHub Pages e com o botão "voltar". */
export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (r: Route) => {
    window.location.hash = `/${r}`;
    window.scrollTo({ top: 0 });
  };
  return [route, go];
}

export default function App() {
  const [route, go] = useRoute();
  const { state, units } = useStore();
  const pending = overview(state, units).pending;

  useEffect(() => {
    const name = state.competitionName || 'WCC Control';
    document.title = pending > 0 ? `(${pending}) ${name}` : name;
  }, [pending, state.competitionName]);

  const stepStatus = (id: Route): string | null => {
    if (id === 'setup') return state.participants.length ? `${state.participants.length}` : null;
    if (id === 'mapa') return state.allocation?.report.ok ? `${Object.keys(state.allocation.placements).length}` : null;
    if (id === 'vjudge') return state.problems.length ? `${state.problems.length}q` : null;
    if (id === 'painel') return pending ? `${pending}` : null;
    return null;
  };

  return (
    <div className={`app route-${route}`}>
      <header className="topbar">
        <a className="brand" href="#/setup" aria-label="WCC Control — início">
          <WccLogo size={34} alt="WCC" />
          <span className="brand__text">
            <span className="brand__wcc">WCC</span>
            <span className="brand__sub">control</span>
          </span>
        </a>
        <div className="topbar__comp" title={state.competitionName}>
          {state.competitionName || <span className="muted">competição sem nome</span>}
        </div>
        <nav className="steps" aria-label="Etapas">
          {STEPS.map((s) => {
            const badge = stepStatus(s.id);
            return (
              <button
                key={s.id}
                className={`step ${route === s.id ? 'is-active' : ''} ${badge ? 'has-data' : ''} ${s.id === 'painel' && pending ? 'has-alert' : ''}`}
                onClick={() => go(s.id)}
                aria-current={route === s.id ? 'page' : undefined}
              >
                <span className="step__n">{s.n}</span>
                <span className="step__label">{s.label}</span>
                {badge && <span className="step__badge">{badge}</span>}
              </button>
            );
          })}
        </nav>
        <DataMenu />
      </header>

      <main className="main">
        {route === 'setup' && <SetupScreen go={go} />}
        {route === 'mapa' && <MapScreen go={go} />}
        {route === 'vjudge' && <VJudgeScreen go={go} />}
        {route === 'painel' && <PanelScreen go={go} />}
      </main>
    </div>
  );
}

function DataMenu() {
  const { state, replace, saveStatus } = useStore();
  const confirm = useConfirm();
  const { notify } = useToasts();
  const [open, setOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const doExport = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadText(`wcc-${slugify(state.competitionName)}-${stamp}.json`, exportState(state));
    setOpen(false);
  };

  const doImport = async (file: File) => {
    try {
      const next = importState(await file.text());
      const ok = await confirm({
        title: 'Importar competição?',
        body: `Os dados atuais serão substituídos por "${next.competitionName || 'competição sem nome'}" (${next.participants.length} participantes). Exporte antes se quiser guardar os atuais.`,
        confirmLabel: 'Importar',
      });
      if (!ok) return;
      replace(next);
      notify({ kind: 'success', title: 'Competição importada' });
    } catch (err) {
      notify({ kind: 'error', title: 'Não foi possível importar', detail: err instanceof Error ? err.message : undefined });
    }
  };

  const doReset = async () => {
    setOpen(false);
    const ok = await confirm({
      title: 'Reiniciar a competição?',
      body: 'Participantes, equipes, alocação, questões, submissões e entregas serão apagados deste navegador. Esta ação não pode ser desfeita.',
      confirmLabel: 'Apagar tudo',
      danger: true,
    });
    if (!ok) return;
    localStorageAdapter.clear();
    replace(defaultState());
    window.location.hash = '/setup';
    notify({ kind: 'info', title: 'Competição reiniciada' });
  };

  return (
    <div className="datamenu" ref={box}>
      <span className={`savechip ${saveStatus.error ? 'is-error' : ''}`} title={saveStatus.error ?? 'Salvo automaticamente neste navegador'}>
        <span className="savechip__dot" />
        {saveStatus.error ? 'erro ao salvar' : saveStatus.at ? `salvo ${formatTime(saveStatus.at)}` : 'local'}
      </span>
      <button className="iconbtn" onClick={() => setOpen((o) => !o)} aria-label="Dados da competição" aria-expanded={open}>
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={doExport}>
            <Download size={15} /> Exportar JSON
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              fileInput.current?.click();
            }}
          >
            <FileUp size={15} /> Importar JSON
          </button>
          <hr />
          <button role="menuitem" className="danger" onClick={doReset}>
            <RotateCcw size={15} /> Reiniciar competição
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void doImport(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
