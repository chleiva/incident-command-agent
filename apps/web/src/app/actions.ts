/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Presenter and duty-manager actions, with optimistic approvals and error toasts. */
import type {
  ApprovalDecisionRequest,
  ControlRequest,
  CreateRunRequest,
  CreateRunResponse,
  TwistRequest,
} from '@ica/schema/browser';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApiClient } from '../lib/api';
import { downloadBlob } from '../lib/evidencePdf';
import { useUi } from '../store/ui';
import { useServices } from './services';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Optimistic approval: mark "decided (sending…)" now; the `approval.decision` event reconciles; roll back on error. */
export async function decideOptimistically(
  api: Pick<ApiClient, 'decideApproval'>,
  runId: string,
  approvalId: string,
  req: ApprovalDecisionRequest,
): Promise<boolean> {
  const ui = useUi.getState();
  ui.setOptimistic(approvalId, {
    decision: req.decision,
    state: 'sending',
    selectedOptionId: req.selectedOptionId,
  });
  try {
    await api.decideApproval(runId, approvalId, req);
    return true;
  } catch (e) {
    useUi.getState().setOptimistic(approvalId, null);
    useUi.getState().pushToast({ tone: 'critical', title: 'Decision not sent', body: message(e) }, 8_000);
    return false;
  }
}

export function useRunActions() {
  const { api } = useServices();
  const navigate = useNavigate();
  return useMemo(() => {
    const toast = useUi.getState().pushToast;
    const start = async (scenarioId: string, opts: { withBaseline: boolean; speed: number }) => {
      useUi.getState().markTriggered();
      try {
        let baselineId: string | undefined;
        if (opts.withBaseline) {
          baselineId = (await api.createRun({ scenarioId, mode: 'baseline', speed: opts.speed })).runId;
        }
        const { runId } = await api.createRun({
          scenarioId,
          mode: 'agent',
          speed: opts.speed,
          ...(baselineId ? { pairedRunId: baselineId } : {}),
        });
        if (baselineId) useUi.getState().setPair(runId, baselineId);
        navigate(`/runs/${encodeURIComponent(runId)}`);
        return runId;
      } catch (e) {
        toast({ tone: 'critical', title: 'Could not start the run', body: message(e) }, 8_000);
        return null;
      }
    };
    /**
     * Report an incident on a live-network flight (task 07). The server rebuilds the scenario from the flight; with a
     * baseline, the baseline request builds (and stores) it first and the agent run reuses its id, so the pair runs
     * the same scenario — as `start` does for library scenarios.
     */
    const startFromFlight = async (
      report: Pick<CreateRunRequest, 'flightContext' | 'incidentType' | 'text'>,
      opts: { withBaseline: boolean; speed: number },
    ) => {
      useUi.getState().markTriggered();
      try {
        let runId: string;
        let res: CreateRunResponse;
        if (opts.withBaseline) {
          res = await api.createRun({ ...report, mode: 'baseline', speed: opts.speed });
          const agent = await api.createRun({
            scenarioId: res.scenarioId!,
            mode: 'agent',
            speed: opts.speed,
            pairedRunId: res.runId,
          });
          runId = agent.runId;
          useUi.getState().setPair(runId, res.runId);
        } else {
          res = await api.createRun({ ...report, mode: 'agent', speed: opts.speed });
          runId = res.runId;
        }
        if (res.authorFallback)
          toast({
            tone: 'warning',
            title: 'Scenario Author unavailable',
            body: 'The run uses the incident template for this flight; your details were not added.',
          });
        else if (res.screening?.verdict === 'neutralised')
          toast({ tone: 'info', title: 'Details neutralised by screening before reaching the agents.' });
        navigate(`/runs/${encodeURIComponent(runId)}`);
        return runId;
      } catch (e) {
        toast({ tone: 'critical', title: 'Could not start the run', body: message(e) }, 8_000);
        return null;
      }
    };
    return {
      start,
      startFromFlight,
      decide: (runId: string, approvalId: string, req: ApprovalDecisionRequest) =>
        decideOptimistically(api, runId, approvalId, req),
      control: async (runId: string, req: ControlRequest) => {
        try {
          await api.control(runId, req);
        } catch (e) {
          toast({ tone: 'critical', title: 'Control command failed', body: message(e) });
        }
      },
      twist: async (runId: string, req: TwistRequest) => {
        try {
          const r = await api.injectTwist(runId, req);
          if (!r.accepted) {
            toast(
              {
                tone: 'warning',
                title: 'Twist rejected by input screening',
                body: r.screening?.findings.map((f) => f.pattern).join(', '),
              },
              8_000,
            );
          } else {
            toast({
              tone: 'info',
              title: 'Twist injected',
              body:
                r.screening?.verdict === 'neutralised'
                  ? 'Neutralised by screening before reaching the agents.'
                  : undefined,
            });
          }
        } catch (e) {
          toast({ tone: 'critical', title: 'Twist failed', body: message(e) });
        }
      },
      replayBaseline: async (runId: string, scenarioId: string, speed: number) => {
        try {
          const b = await api.createRun({ scenarioId, mode: 'baseline', speed, pairedRunId: runId });
          useUi.getState().setPair(runId, b.runId);
          toast({
            tone: 'info',
            title: 'Baseline replay started',
            body: 'Ghost figures now compare against it.',
          });
          return b.runId;
        } catch (e) {
          toast({ tone: 'critical', title: 'Could not start the baseline', body: message(e) });
          return null;
        }
      },
      exportJson: async (runId: string) => {
        try {
          const r = await api.exportRun(runId);
          if ('url' in r.trace && !Array.isArray(r.trace)) {
            window.open(r.trace.url, '_blank', 'noopener');
            return;
          }
          downloadBlob(JSON.stringify(r, null, 2), `${runId}.trace.json`, 'application/json');
        } catch (e) {
          toast({ tone: 'critical', title: 'Export failed', body: message(e) });
        }
      },
    };
  }, [api, navigate]);
}
