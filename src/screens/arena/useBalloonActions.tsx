/** Ações de balão compartilhadas pela grade, pela fila e pelo mapa (mesmas regras e mesmas confirmações). */
import { useStore } from '../../state/store';
import { useToasts } from '../../components/Toasts';
import { useConfirm } from '../../components/Confirm';
import { cellStatus, deliverBalloon, markManualSolved, removeManualSolved, undoDelivery } from '../../domain/balloons';
import { problemLabel } from '../../domain/contests';
import type { Cell, Problem, Unit } from '../../domain/types';

export function useBalloonActions() {
  const { state, commit } = useStore();
  const { notify } = useToasts();
  const confirm = useConfirm();
  const label = (p: Problem) => problemLabel(state, p);

  const deliver = (unit: Unit, problem: Problem) => {
    commit((s) => deliverBalloon(s, unit.id, problem.key, Date.now()));
    notify({
      kind: 'success',
      title: `Balão ${label(problem)} entregue para ${unit.name}`,
      color: problem.color,
      ttl: 6000,
      action: { label: 'Desfazer', run: () => commit((s) => undoDelivery(s, unit.id, problem.key, Date.now())) },
    });
  };

  const undo = (unit: Unit, problem: Problem) => commit((s) => undoDelivery(s, unit.id, problem.key, Date.now()));

  const askUndo = async (unit: Unit, problem: Problem) => {
    const ok = await confirm({
      title: `Desfazer entrega do balão ${label(problem)}?`,
      body: `${unit.name} voltará para a fila de balões pendentes. O registro do Accepted é mantido.`,
      confirmLabel: 'Desfazer entrega',
    });
    if (ok) undo(unit, problem);
  };

  const manual = (unit: Unit, problem: Problem) => commit((s) => markManualSolved(s, unit.id, problem.key, Date.now()));
  const removeManual = (unit: Unit, problem: Problem) => commit((s) => removeManualSolved(s, unit.id, problem.key, Date.now()));

  const askManual = async (unit: Unit, problem: Problem) => {
    const ok = await confirm({
      title: `Registrar a questão ${label(problem)} como resolvida?`,
      body: (
        <>
          Não há Accepted do VJudge registrado para <b>{unit.name}</b> nesta questão. Use o registro manual apenas se você confirmou o Accepted por
          outro meio. Ele fica marcado como <b>manual</b> e é substituído pelo dado do VJudge quando este chegar.
        </>
      ),
      confirmLabel: 'Registrar manualmente',
    });
    if (ok) manual(unit, problem);
  };

  /** Clique padrão em uma célula: verde → entrega; preta → desfazer (com confirmação); cinza → registro manual (com confirmação). */
  const toggle = (unit: Unit, problem: Problem, cell: Cell | undefined) => {
    const st = cellStatus(cell);
    if (st === 'solved') return deliver(unit, problem);
    if (st === 'delivered') return void askUndo(unit, problem);
    return void askManual(unit, problem);
  };

  return { deliver, undo, askUndo, manual, removeManual, askManual, toggle, label };
}
