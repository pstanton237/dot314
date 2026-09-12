import { createAccountingState, type AccountingState } from "./goal-accounting.js";
import { createGoalRecoveryMachine, type GoalRecoveryMachineState } from "./recovery-machine.js";
import {
  createStaleQueuedWorkGuard,
  type StaleQueuedWorkGuard,
} from "./stale-queued-work-guard.js";

export type ProactiveCompactionPhase = "idle" | "scheduled" | "compacting";

export interface GoalRuntimeState {
  accounting: AccountingState;
  recoveryState: GoalRecoveryMachineState;
  agentRunSequence: number;
  currentTurnIndex: number | null;
  staleQueuedWorkGuard: StaleQueuedWorkGuard;
  /** Tracks compaction from a qualifying tool turn through the next provider-context boundary. */
  proactiveCompactionPhase: ProactiveCompactionPhase;
}

export function createGoalRuntimeState(): GoalRuntimeState {
  return {
    accounting: createAccountingState(),
    recoveryState: createGoalRecoveryMachine(),
    agentRunSequence: 0,
    currentTurnIndex: null,
    staleQueuedWorkGuard: createStaleQueuedWorkGuard(),
    proactiveCompactionPhase: "idle",
  };
}
