import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { listRetiredReviewerTabs } from '../src/reviewer-tabs.mjs';
import {
  actionResponseKey,
  isInvalidZeroSourcePackFilename,
  parseSourcePackNumber,
  sanitizeStoredSourcePackCursorFields,
  sourcePackFilename,
} from '../src/protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controller = fs.readFileSync(path.join(ROOT, 'src', 'controller.mjs'), 'utf8');
const protocol = fs.readFileSync(path.join(ROOT, 'src', 'protocol.mjs'), 'utf8');
const reviewerTabs = fs.readFileSync(path.join(ROOT, 'src', 'reviewer-tabs.mjs'), 'utf8');
const browserRuntime = fs.readFileSync(path.join(ROOT, 'src', 'browser-runtime.mjs'), 'utf8');
const reviewerModel = fs.readFileSync(path.join(ROOT, 'src', 'reviewer-model.mjs'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

function makeSourcePackCursorVerifier(state) {
  const verifierStart = controller.indexOf('function isVerifiedSourcePackCursor(');
  const verifierEnd = controller.indexOf('\nfunction recordSourcePackCursorEvidence', verifierStart);
  const evidenceKindStart = controller.indexOf('function isSourcePackContinuationEvidenceKind(');
  const evidenceKindEnd = controller.indexOf('\nfunction stageUnavailableSourcePackBackoff', evidenceKindStart);
  assert.ok(verifierStart >= 0 && verifierEnd > verifierStart);
  assert.ok(evidenceKindStart >= 0 && evidenceKindEnd > evidenceKindStart);
  const factory = new Function(
    'state',
    'parseSourcePackNumber',
    'sourcePackFilename',
    'actionResponseKey',
    `${controller.slice(verifierStart, verifierEnd)}\n${controller.slice(evidenceKindStart, evidenceKindEnd)}\nreturn isVerifiedSourcePackCursor;`,
  );
  return factory(state, parseSourcePackNumber, sourcePackFilename, actionResponseKey);
}

test('response reconciliation requires action attribution and real stability', () => {
  assert.match(controller, /latestAssistantAfterActionMarker\(page, responseActionId\)/);
  assert.match(controller, /processedResponseKey === responseKey/);
  assert.match(controller, /updateStableCandidate\(bucketState, responseHash, responseActionId\)/);
  assert.doesNotMatch(controller, /candidateCount\s*=\s*2/);
});

test('new-chat model verification waits for the selector and never downgrades', () => {
  const verificationStart = reviewerModel.indexOf('export async function ensureHighestReviewerModel');
  const verificationEnd = reviewerModel.indexOf('catch (cause)', verificationStart);
  const verification = reviewerModel.slice(verificationStart, verificationEnd);
  assert.ok(verification.indexOf("await selector.waitFor({ state: 'visible', timeout: 15000 })") >= 0);
  assert.ok(verification.indexOf('await selector.waitFor') < verification.indexOf('await selector.count()'));
  assert.match(reviewerModel, /REQUIRED_REVIEWER_MODEL = 'GPT-5\.6 Sol'/);
  assert.match(reviewerModel, /REQUIRED_REVIEWER_EFFORT = 'High'/);
  assert.match(verification, /modelUnavailable\(/);
});

test('retired chat history is identified while reviewer rotation reuses bounded slots', () => {
  const currentUrl = 'https://example.test/project/current';
  const retiredUrl = 'https://example.test/project/retired';
  const unrelatedUrl = 'https://example.test/chat/unassigned';
  const retired = listRetiredReviewerTabs({
    1: { chatUrl: currentUrl, chatHistory: [{ chatUrl: retiredUrl }] },
    2: { chatUrl: null, chatHistory: [{ url: 'https://example.test/project/older' }] },
  }, [
    `${retiredUrl}?mode=high`,
    currentUrl,
    unrelatedUrl,
    'not-a-url',
  ]);

  assert.deepEqual(retired, [{ bucket: '1', url: `${retiredUrl}?mode=high` }]);
  const slotAssignment = controller.slice(
    controller.indexOf('async function reviewerSlotForBucket'),
    controller.indexOf('async function refreshReviewerSlotStatus'),
  );
  assert.match(slotAssignment, /slot\.page\.goto\(targetUrl/);
  assert.match(slotAssignment, /both reusable reviewer slots are occupied/);
  assert.doesNotMatch(slotAssignment, /context\.newPage\(/);
});

test('setup verification is persisted and INITIAL_AUDIT dispatch is scheduler-gated', () => {
  const setupFunction = controller.slice(
    controller.indexOf('async function processSetupWait'),
    controller.indexOf('async function processActive'),
  );
  const verifiedAt = setupFunction.indexOf('bucketState.setupVerified = true;');
  const saveAt = setupFunction.indexOf('saveState();', verifiedAt);
  assert.ok(verifiedAt >= 0);
  assert.ok(saveAt > verifiedAt);
  assert.doesNotMatch(setupFunction, /INITIAL_AUDIT/);

  const processBucket = controller.slice(
    controller.indexOf('async function processBucket'),
    controller.indexOf('function rebalanceExistingReviewerSlots'),
  );
  assert.doesNotMatch(processBucket, /sendAction\([^\n]+INITIAL_AUDIT/);

  const activation = controller.slice(
    controller.indexOf('async function attemptActivateReviewerSlot'),
    controller.indexOf('async function fillReviewerSlots'),
  );
  assert.match(activation, /phase === 'SETUP_WAIT'/);
  assert.match(activation, /await sendAction\(page, Number\(bucket\), 'INITIAL_AUDIT'/);

  const scheduler = controller.slice(
    controller.indexOf('async function fillReviewerSlots'),
    controller.indexOf('function allBucketsComplete'),
  );
  assert.match(scheduler, /while \(occupancy\.availableSlots > 0\)/);
  assert.match(scheduler, /if \(occupancy\.availableSlots <= 0\) break;/);
  assert.match(scheduler, /attemptActivateReviewerSlot\(context, bucket, liveGeneratingByBucket\)/);
  assert.match(controller, /initial-audit-sent-after-setup-recovery/);
});

test('audit and corpus reconciliation prompts preserve terminal rows and verify every new write', () => {
  const setupPrompt = controller.slice(
    controller.indexOf('function setupPrompt(bucket)'),
    controller.indexOf('function initialAuditPrompt(bucket)'),
  );
  const initialPrompt = controller.slice(
    controller.indexOf('function initialAuditPrompt(bucket)'),
    controller.indexOf('function continuationPrompt(bucket)'),
  );
  const continuationPrompt = controller.slice(
    controller.indexOf('function continuationPrompt(bucket)'),
    controller.indexOf('function registryPrerequisiteRevalidationPrompt(bucket)'),
  );
  const completionPrompt = controller.slice(
    controller.indexOf('function corpusReconciliationPrompt(bucket)'),
    controller.indexOf('function malformedRecoveryPrompt(bucket)'),
  );

  assert.match(setupPrompt, /Preserve every valid terminal result/);
  assert.match(setupPrompt, /never overwrite a terminal result/);
  assert.match(initialPrompt, /Do not redo any valid terminalized case/);
  assert.match(initialPrompt, /Persist and readback-verify every new result/);
  assert.match(continuationPrompt, /Do not redo completed cases/);
  assert.match(continuationPrompt, /Persist and readback-verify each result/);
  assert.match(completionPrompt, /skipping every valid terminal row and readback-verifying every new write/);
  assert.match(completionPrompt, /UNRESOLVED_WRITES: 0/);
});

test('transient registry holds revalidate after backoff and release only on exact proof', () => {
  const revalidationStart = controller.indexOf('async function recoverTransientRegistryHolds(context)');
  const revalidationEnd = controller.indexOf('\nasync function reconcileStaleGenerationReservations', revalidationStart);
  const revalidation = controller.slice(revalidationStart, revalidationEnd);
  assert.ok(revalidationStart >= 0 && revalidationEnd > revalidationStart);
  assert.match(revalidation, /hold\?\.type !== 'TRANSIENT_EXTERNAL'/);
  assert.match(revalidation, /hold\?\.validation\?\.kind !== 'REGISTRY_SHARD_AVAILABLE'/);
  assert.match(revalidation, /!isHoldRetryDue\(bucketState\.hold\)/);
  assert.match(revalidation, /classifyReviewerHealth\(page\)/);
  assert.match(revalidation, /'PREREQUISITE_REVALIDATION'/);

  const scheduler = controller.slice(
    controller.indexOf('async function fillReviewerSlots'),
    controller.indexOf('function allBucketsComplete'),
  );
  assert.ok(scheduler.indexOf('await recoverTransientRegistryHolds(context)')
    < scheduler.indexOf('while (occupancy.availableSlots > 0)'));

  const processActiveStart = controller.indexOf('async function processActive(');
  const processActiveEnd = controller.indexOf('\nasync function ', processActiveStart + 1);
  const processActive = controller.slice(processActiveStart, processActiveEnd);
  const availabilityCheck = processActive.indexOf("availability !== 'YES'");
  const clearHold = processActive.indexOf('bucketState.hold = null;');
  assert.ok(availabilityCheck >= 0 && clearHold > availabilityCheck);
  const strictFooterChecks = [
    processActive.indexOf("footer.writesVerified !== 'YES'"),
    processActive.indexOf("footer.blocker.trim().toUpperCase() !== 'NONE'"),
    processActive.indexOf("footer.triggerCoordinator !== 'NO'"),
  ];
  assert.ok(strictFooterChecks.every(index => index >= 0 && index < clearHold));
  assert.ok(clearHold < processActive.indexOf("bucketState.phase = 'ACTIVE';", clearHold));

  const retryStart = protocol.indexOf('export function isHoldRetryDue');
  const retryEnd = protocol.indexOf('\nexport function sha16', retryStart);
  const retryHelper = protocol.slice(retryStart, retryEnd);
  assert.match(retryHelper, /hold\?\.type !== 'TRANSIENT_EXTERNAL'/);
  assert.match(retryHelper, /hold\?\.retryPolicy !== 'REVALIDATE'/);
});

test('stale persisted RUNNING state is detected and status includes lifecycle heartbeat and build identity', () => {
  const staleStart = controller.indexOf('function previousControllerStale(');
  const staleEnd = controller.indexOf('\nfunction sourceHashFromDisk', staleStart);
  const staleSource = controller.slice(staleStart, staleEnd);
  assert.ok(staleStart >= 0 && staleEnd > staleStart);

  const currentTimeMs = Date.parse('2026-09-21T12:00:00.000Z');
  const runStaleCheck = (status, livePids = new Set()) => {
    const processStub = {
      pid: 500,
      kill(pid) {
        if (!livePids.has(Number(pid))) {
          const error = new Error('process absent');
          error.code = 'ESRCH';
          throw error;
        }
      },
    };
    const check = vm.runInNewContext(`${staleSource}; previousControllerStale`, {
      process: processStub,
      config: { heartbeatStaleSeconds: 90 },
    });
    return check(status, currentTimeMs);
  };

  assert.equal(runStaleCheck({
    controllerPid: 501,
    controllerState: 'RUNNING',
    heartbeatAt: '2026-09-21T11:59:59.000Z',
  }), true, 'a previous RUNNING process that is gone is stale despite a recent heartbeat');
  assert.equal(runStaleCheck({
    controllerPid: 502,
    controllerState: 'RUNNING',
    heartbeatAt: '2026-09-21T11:57:00.000Z',
  }, new Set([502])), true, 'a live process with a stale heartbeat is also stale');
  assert.equal(runStaleCheck({
    controllerPid: 503,
    controllerState: 'RUNNING',
    heartbeatAt: '2026-09-21T11:59:59.000Z',
  }, new Set([503])), false);
  assert.equal(runStaleCheck({
    controllerPid: 504,
    controllerState: 'STOPPED',
    heartbeatAt: '2026-09-21T11:00:00.000Z',
  }), false);

  const statusStart = controller.indexOf('const status = {', controller.indexOf('function writeStatus('));
  const statusEnd = controller.indexOf('\n  };', statusStart);
  const statusObject = controller.slice(statusStart, statusEnd);
  assert.match(statusObject, /controllerPid: process\.pid/);
  assert.match(statusObject, /heartbeatAt,/);
  assert.match(statusObject, /controllerState: controllerLifecycleState/);
  assert.match(statusObject, /gitSha: loadedGitSha/);
  assert.match(statusObject, /sourceHash: loadedSourceHash/);
  assert.match(statusObject, /diskSourceHash: sourceHashFromDisk\(\)/);
  assert.match(statusObject, /canonicalRegistry:\s*\{\s*status: 'UNAVAILABLE'/);
  assert.match(statusObject, /acceptedTerminalCountStatus: 'UNAVAILABLE'/);
  assert.match(statusObject, /acceptedTerminalCount: null/);
  assert.equal((statusObject.match(/controllerState:/g) || []).length, 1,
    'status should publish one lifecycle controllerState field');
});

test('dashboard labels canonical totals separately from local controller telemetry', () => {
  assert.match(dashboardHtml, /canonical\.status === 'AVAILABLE'/);
  assert.match(dashboardHtml, /canonical\.acceptedTerminalCount != null/);
  assert.match(dashboardHtml, /canonical\.remainingAuditableCases != null/);
  assert.match(dashboardHtml, /Boolean\(canonical\.reconciledAt\)/);
  assert.match(dashboardHtml, /: 'Unavailable'/);
  assert.match(dashboardHtml, /<h3>Canonical registry population<\/h3>/);
  assert.match(dashboardHtml, /Registry reconciliation:/);
  assert.match(dashboardHtml, /Local cases reported:/);
  assert.match(dashboardHtml, /local remaining estimate:/);
  assert.match(dashboardHtml, /Controller telemetry is not canonical registry evidence/);
  assert.match(dashboardHtml, /tracker\.sanitized === true/);
  assert.match(dashboardHtml, /Latest sanitized snapshot .* \(may be stale\)/);
  assert.match(dashboardHtml, /Integrity conflict and misowned counts unavailable; no timestamped sanitized snapshot is loaded/);
});

test('positive source-pack targets without action-attributed provenance enter integrity hold', async () => {
  const bucketState = {
    complete: false,
    phase: 'PENDING',
    sourcePackTargetNumber: 17,
    sourcePackTargetFilename: 'pack_000017.jsonl',
    sourcePackResumePending: true,
    sourcePackCursorReconciliationRequired: false,
    sourcePackCursorEvidence: null,
    hold: null,
  };
  const state = { buckets: { 2: bucketState }, actions: {}, incidents: {} };
  const isVerifiedSourcePackCursor = makeSourcePackCursorVerifier(state);
  assert.equal(isVerifiedSourcePackCursor(2, bucketState), false);

  const incidentCalls = [];
  const recoveryStart = controller.indexOf('async function recoverInvalidSourcePackCursors(');
  const recoveryEnd = controller.indexOf('\nfunction stageRecoverableSourcePackHold', recoveryStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  const runRecovery = new Function(
    'state',
    'isSchedulingBlockedBucket',
    'sanitizeStoredSourcePackCursorFields',
    'isInvalidZeroSourcePackFilename',
    'isVerifiedSourcePackCursor',
    'recordIncident',
    'saveState',
    'log',
    `${controller.slice(recoveryStart, recoveryEnd)}\nreturn recoverInvalidSourcePackCursors;`,
  )(
    state,
    () => false,
    sanitizeStoredSourcePackCursorFields,
    isInvalidZeroSourcePackFilename,
    isVerifiedSourcePackCursor,
    (...args) => {
      incidentCalls.push(args);
      return '/test/source-pack-cursor-incident.json';
    },
    () => {},
    () => {},
  );
  assert.equal(await runRecovery(null), true);
  assert.equal(bucketState.sourcePackCursorReconciliationRequired, true);
  assert.equal(bucketState.sourcePackResumePending, false);
  assert.equal(bucketState.phase, 'HOLD');
  assert.equal(incidentCalls[0][0], 'SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED');
  assert.equal(incidentCalls[0][4].holdType, 'INTEGRITY');

  const processBucket = controller.slice(
    controller.indexOf('async function processBucket'),
    controller.indexOf('function rebalanceExistingReviewerSlots'),
  );
  assert.match(processBucket, /bucketState\.sourcePackCursorReconciliationRequired/);
  assert.match(processBucket, /!isVerifiedSourcePackCursor\(bucket, bucketState\)/);
  const scheduler = controller.slice(
    controller.indexOf('async function fillReviewerSlots'),
    controller.indexOf('function allBucketsComplete'),
  );
  assert.match(scheduler, /!bucketState\.sourcePackCursorReconciliationRequired/);
  assert.match(scheduler, /isVerifiedSourcePackCursor\(bucket,\s*state\.buckets\[String\(bucket\)\]\)/);
});

test('source-pack cursor proof requires matching delivered action and response evidence', () => {
  const responseHash = '0123456789abcdef';
  const sourceAction = {
    id: 'A-source-5',
    status: 'SENT',
    deliveryVerified: true,
    kind: 'SOURCE_PACK_CONTINUE',
    sourcePackTargetFilename: 'pack_000005.jsonl',
  };
  const bucketState = {
    sourcePackTargetNumber: 5,
    sourcePackCursorEvidence: {
      bucket: 2,
      targetNumber: 5,
      targetFilename: 'pack_000005.jsonl',
      evidenceKind: 'SOURCE_PACK_ACCESS',
      sourceActionId: sourceAction.id,
      responseActionId: sourceAction.id,
      sourceActionTargetFilename: sourceAction.sourcePackTargetFilename,
      responseHash,
      responseKey: actionResponseKey(sourceAction.id, responseHash),
      verifiedAt: '2026-09-21T12:00:00.000Z',
    },
  };
  const state = { actions: { [sourceAction.id]: sourceAction } };
  const verify = makeSourcePackCursorVerifier(state);
  assert.equal(verify(2, bucketState), true);

  assert.equal(verify(2, { ...bucketState, sourcePackCursorEvidence: null }), false,
    'a positive target without provenance is unresolved');
  assert.equal(verify(2, {
    ...bucketState,
    sourcePackCursorEvidence: { ...bucketState.sourcePackCursorEvidence, targetNumber: 6 },
  }), false, 'proof for a different numeric target is invalid');
  sourceAction.deliveryVerified = false;
  assert.equal(verify(2, bucketState), false, 'a sent action without delivery verification is invalid');
  sourceAction.deliveryVerified = true;
  bucketState.sourcePackCursorEvidence.responseActionId = 'A-other-action';
  assert.equal(verify(2, bucketState), false, 'evidence from another action is invalid');
});

test('missing shard mapping permits response reconciliation but never dispatch', () => {
  const main = controller.slice(controller.indexOf('async function main()'));
  const mappingGateStart = main.indexOf('const shardMapping = sourcePackShardMappingStatus();');
  const normalRecoveryStart = main.indexOf('await recoverReviewerStallHolds(context)', mappingGateStart);
  const mappingBranch = main.slice(mappingGateStart, normalRecoveryStart);
  assert.ok(mappingGateStart >= 0 && normalRecoveryStart > mappingGateStart);
  assert.match(mappingBranch, /if \(!shardMapping\.ready\)/);
  assert.match(mappingBranch, /await reconcileOutstandingResponses\(context, liveGeneratingByBucket\)/);
  assert.match(mappingBranch, /dispatchEnabled: false/);
  assert.match(mappingBranch, /controllerState: 'DEGRADED'/);
  assert.doesNotMatch(mappingBranch, /sendPendingSourcePackContinuations|fillReviewerSlots|processBucket\(/);

  const normalRecoveryAt = main.indexOf('await recoverReviewerStallHolds(context)');
  const staleRecoveryAt = main.indexOf('await recoverStaleAwaitingReviewers(context)', normalRecoveryAt);
  const reconcileAt = main.indexOf('await reconcileOutstandingResponses(context, liveGeneratingByBucket)', staleRecoveryAt);
  const dispatchAt = main.indexOf('await fillReviewerSlots(context)', reconcileAt);
  assert.ok(staleRecoveryAt > normalRecoveryAt && reconcileAt > staleRecoveryAt && dispatchAt > reconcileAt,
    'normal dispatch must follow stale-action recovery and response reconciliation');
});

test('startup partial-write HOLD recovery dispatches WRITE_RECOVERY before ordinary PAUSED resume', () => {
  assert.match(controller, /const partialWriteRecoveryPrefix = 'startup-partial-write-recovery:'/);
  assert.match(controller, /'WRITE_RECOVERY',[\s\S]*partialWriteRecoveryPrompt\(Number\(bucket\), footer\)/);
  assert.match(controller, /method: 'recover-partial-write-hold'/);
  assert.ok(
    controller.indexOf("const partialWriteRecoveryPrefix = 'startup-partial-write-recovery:'")
      < controller.indexOf("bucketState.lastAction = 'resumed-from-reviewer-cap'"),
  );
});

test('conversation rollover preserves an unverified exact source-pack frontier', () => {
  const rollover = controller.slice(
    controller.indexOf('async function rolloverReviewer'),
    controller.indexOf('function recoverLostAwaitingState'),
  );
  assert.match(rollover, /const resumeExactSourcePack = Boolean\(/);
  assert.match(rollover, /rolloverConsumed < rolloverTarget/);
  assert.match(rollover, /bucketState\.sourcePackResumePending = true;/);
  assert.match(rollover, /resetSourcePackAccessState\(bucketState\);/);
});

test('verified setup waits for pending exact source-pack continuation before INITIAL_AUDIT', () => {
  const activation = controller.slice(
    controller.indexOf('async function attemptActivateReviewerSlot'),
    controller.indexOf('async function fillReviewerSlots'),
  );
  const sourcePackGate = activation.indexOf('setup-awaiting-source-pack-continuation');
  const initialAudit = activation.indexOf("'INITIAL_AUDIT'");
  assert.ok(sourcePackGate >= 0);
  assert.ok(initialAudit > sourcePackGate);
});

test('browser generation probes use bounded live evidence and broken pages do not occupy slots', () => {
  assert.match(reviewerTabs, /DEFAULT_REVIEWER_PROBE_TIMEOUT_MS = 2500/);
  assert.match(reviewerTabs, /REVIEWER_PROBE_TIMEOUT/);
  assert.match(reviewerTabs, /RECONNECTING/);
  assert.match(reviewerTabs, /WAITING_NETWORK/);
  assert.match(reviewerTabs, /healthResult\('UNREACHABLE', false/);
  const inspect = controller.slice(
    controller.indexOf('async function inspectLiveGeneratingByBucket'),
    controller.indexOf('function refreshLiveReviewerOccupancy'),
  );
  assert.match(inspect, /await ensureBrowserSlots\(context\)/);
  assert.match(inspect, /findActualGeneration\(slot\.page/);
  assert.match(inspect, /classifyReviewerHealth\(slot\.page/);
  assert.match(inspect, /liveGeneratingByBucket\[slot\.bucket\] = actualGeneration/);
  assert.match(inspect, /liveGeneratingByBucket\[slot\.bucket\] = false/);
  assert.match(reviewerTabs, /RECONNECTING/);
  assert.match(reviewerTabs, /WAITING_NETWORK/);
  assert.match(reviewerTabs, /UNREACHABLE/);
});

test('rollover preserves an interrupted WRITE_RECOVERY for the replacement chat', () => {
  const rollover = controller.slice(
    controller.indexOf('async function rolloverReviewer'),
    controller.indexOf('function updateStableCandidate'),
  );
  assert.match(rollover, /interruptedAction\?\.kind === 'WRITE_RECOVERY'/);
  assert.match(rollover, /latestRecoverableWriteIncident\(bucket\)/);
  assert.match(rollover, /bucketState\.writeRecoveryResumePending = resumeWriteRecovery/);
  assert.match(rollover, /bucketState\.writeRecoveryInterruptedActionId/);
});

test('startup migrates a legacy rollover that lost an interrupted WRITE_RECOVERY flag', () => {
  const recovery = controller.slice(
    controller.indexOf('function recoverLegacyInterruptedWriteRecoveryRollovers'),
    controller.indexOf('async function recoverInvalidSourcePackCursors'),
  );
  assert.match(recovery, /latestRecoverableWriteIncident\(bucket\)/);
  assert.match(recovery, /action\?\.kind === 'WRITE_RECOVERY'/);
  assert.match(recovery, /rolloverAt <= recoverySentAt/);
  assert.match(recovery, /WRITE_RECOVERY_TERMINAL_FAILURE/);
  assert.match(recovery, /bucketState\.writeRecoveryResumePending = true/);
  assert.match(recovery, /bucketState\.writeRecoveryInterruptedActionId = latestRecoveryAction\.id/);
  assert.match(controller, /recoverLegacyInterruptedWriteRecoveryRollovers\(\);/);
});

test('replacement chat resumes interrupted write recovery before source-pack or INITIAL_AUDIT work', () => {
  const activation = controller.slice(
    controller.indexOf('async function attemptActivateReviewerSlot'),
    controller.indexOf('async function fillReviewerSlots'),
  );
  const writeRecoveryAt = activation.indexOf('if (bucketState.writeRecoveryResumePending && bucketState.chatUrl)');
  const sourcePackGateAt = activation.indexOf('setup-awaiting-source-pack-continuation');
  const initialAuditAt = activation.indexOf("'INITIAL_AUDIT'");
  assert.ok(writeRecoveryAt >= 0);
  assert.ok(sourcePackGateAt > writeRecoveryAt);
  assert.ok(initialAuditAt > sourcePackGateAt);
  assert.match(activation, /resume-interrupted-write-recovery/);
  assert.match(activation, /interruptedWriteRecoveryPrompt/);
});

test('replacement chat resumes interrupted isolated-anomaly continuation before INITIAL_AUDIT', () => {
  const rollover = controller.slice(
    controller.indexOf('async function rolloverReviewer'),
    controller.indexOf('function updateStableCandidate'),
  );
  assert.match(rollover, /interruptedAction\?\.kind === 'ISOLATED_ANOMALY_CONTINUE'/);
  assert.match(rollover, /bucketState\.advisoryAnomalyResumePending = resumeAdvisoryAnomaly/);

  const activation = controller.slice(
    controller.indexOf('async function attemptActivateReviewerSlot'),
    controller.indexOf('async function fillReviewerSlots'),
  );
  const anomalyResumeAt = activation.indexOf('if (bucketState.advisoryAnomalyResumePending && bucketState.chatUrl)');
  const initialAuditAt = activation.indexOf("'INITIAL_AUDIT'");
  assert.ok(anomalyResumeAt >= 0);
  assert.ok(initialAuditAt > anomalyResumeAt);
  assert.match(activation, /'ISOLATED_ANOMALY_CONTINUE'/);
  assert.match(activation, /resume-interrupted-advisory-anomaly/);
  assert.match(activation, /do not assume the interrupted attempt made no writes/);
});

test('startup restores a legacy isolated-anomaly rollover even when the replacement chat already sent setup', () => {
  const recovery = controller.slice(
    controller.indexOf('function recoverLegacyInterruptedAdvisoryAnomalyRollovers'),
    controller.indexOf('function recoverStaleAwaitingReviewers'),
  );
  assert.match(recovery, /action\?\.kind === 'ISOLATED_ANOMALY_CONTINUE'/);
  assert.match(recovery, /rolloverAt <= advisorySentAt/);
  assert.match(recovery, /lastProcessedAction\?\.kind !== 'PROTOCOL_SETUP'/);
  assert.match(recovery, /bucketState\.advisoryAnomalyResumePending = true/);
  assert.match(recovery, /bucketState\.advisoryAnomalyInterruptedActionId = latestAdvisoryAction\.id/);
  assert.match(controller, /recoverLegacyInterruptedAdvisoryAnomalyRollovers\(\);/);
});

test('pending legacy anomaly continuation takes precedence over ordinary CONTINUE after a later response', () => {
  const processActive = controller.slice(
    controller.indexOf('async function processActive'),
    controller.indexOf('async function recoverIdleActiveBucket'),
  );
  const pendingAt = processActive.lastIndexOf('if (bucketState.advisoryAnomalyResumePending)');
  const ordinaryContinueAt = processActive.lastIndexOf("await sendAction(page, bucket, 'CONTINUE'");
  assert.ok(pendingAt >= 0);
  assert.ok(ordinaryContinueAt > pendingAt);
  assert.match(processActive, /isolated-anomaly-continuation-after-legacy-rollover/);
  assert.match(processActive, /advanced\.ok[\s\S]*advisoryAnomalyResumePending = false/);

  const idleRecovery = controller.slice(
    controller.indexOf('async function recoverIdleActiveBucket'),
    controller.indexOf('async function processBucket'),
  );
  assert.match(idleRecovery, /if \(bucketState\.advisoryAnomalyResumePending\)/);
  assert.match(idleRecovery, /'ISOLATED_ANOMALY_CONTINUE'/);
});

test('source-pack dispatch is gated while write recovery is pending or bucket is held', () => {
  const sourceDispatch = controller.slice(
    controller.indexOf('async function sendPendingSourcePackContinuations'),
    controller.indexOf('function updateReceivedMessage'),
  );
  assert.match(sourceDispatch, /bucketState\.phase === 'HOLD'/);
  assert.match(sourceDispatch, /bucketState\.writeRecoveryResumePending/);
});

test('terminal failure of an actual WRITE_RECOVERY does not auto-loop another recovery turn', () => {
  const processActive = controller.slice(
    controller.indexOf('async function processActive'),
    controller.indexOf('async function recoverIdleActiveBucket'),
  );
  assert.match(processActive, /responseAction\?\.kind === 'WRITE_RECOVERY'/);
  assert.match(processActive, /WRITE_RECOVERY_TERMINAL_FAILURE/);
  assert.match(processActive, /automatic retry stopped/);
  assert.match(processActive, /write-recovery-complete-source-pack-resume-pending/);
});

test('WRITE_RECOVERY is bounded to write reconciliation and cannot consume the turn auditing new cases', () => {
  const recoveryPrompt = controller.slice(
    controller.indexOf('function partialWriteRecoveryPrompt'),
    controller.indexOf('function interruptedWriteRecoveryPrompt'),
  );
  assert.match(recoveryPrompt, /Do not review any new cases in this recovery turn/);
  assert.match(recoveryPrompt, /controller will resume ordinary source-pack work in a separate turn/i);
  assert.doesNotMatch(recoveryPrompt, /continue eligible pending Bucket/);
});

test('verified terminal duplicate-classification collision is isolated instead of holding the bucket', () => {
  const recovery = controller.slice(
    controller.indexOf('function recoverAdvisoryCoordinatorHolds'),
    controller.indexOf('function recoverRetryableTurnBoundaryHolds'),
  );
  const processActive = controller.slice(
    controller.indexOf('async function processActive'),
    controller.indexOf('async function recoverIdleActiveBucket'),
  );
  assert.match(recovery, /isRecoverableAdvisoryCoordinatorFooter\(footer\)/);
  assert.match(processActive, /'ISOLATED_ANOMALY_CONTINUE'/);
  assert.match(processActive, /isolatedAnomalyContinuationPrompt\(bucket\)/);
  const activation = controller.slice(
    controller.indexOf('async function attemptActivateReviewerSlot'),
    controller.indexOf('async function fillReviewerSlots'),
  );
  assert.match(activation, /startup-advisory-anomaly-recovery:/);
  assert.match(activation, /'ISOLATED_ANOMALY_CONTINUE'/);
  assert.match(activation, /recover-advisory-anomaly-hold/);
  assert.match(recovery, /lastProcessedBlocker/);
  assert.match(recovery, /TERMINAL_DUPLICATE_CLASSIFICATION_COLLISION/);
  assert.match(recovery, /lastMessageSentAt/);
});

test('legacy rollover recovery does not resurrect a WRITE_RECOVERY after later processed work', () => {
  const recovery = controller.slice(
    controller.indexOf('function recoverLegacyInterruptedWriteRecoveryRollovers'),
    controller.indexOf('function recoverStaleAwaitingReviewers'),
  );
  assert.match(recovery, /laterProcessedAction/);
  assert.match(recovery, /lastSourcePackTransitionAt/);
  assert.match(recovery, /laterProcessedAt > recoverySentAt/);
  assert.match(recovery, /laterSourcePackTransitionAt > recoverySentAt/);
});

test('controller CDP reconnect attempts do not block for a full minute', () => {
  assert.match(browserRuntime, /playwrightChromium\.connectOverCDP\(endpoint, \{ timeout: timeoutMs \}\)/);
  assert.match(browserRuntime, /boundedMs\(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 15000\)/);
  assert.match(browserRuntime, /boundedMs\(startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 30000\)/);
  assert.doesNotMatch(browserRuntime, /connectOverCDP\(endpoint, \{ timeout: 60000 \}\)/);
  assert.match(controller, /connectOrLaunchBrowser\(\{/);
  assert.match(controller, /connectTimeoutMs: config\.browserConnectTimeoutMs \|\| 5000/);
  assert.match(controller, /startupTimeoutMs: config\.browserStartupTimeoutMs \|\| 15000/);
  assert.match(controller, /profileDirectoryName: config\.browserProfileName \|\| 'Default'/);
});

test('interrupted WRITE_RECOVERY generation is retried after a short bounded grace', () => {
  assert.match(controller, /function lostWriteRecoveryRetryReady/);
  assert.match(controller, /responseAction\.kind !== 'WRITE_RECOVERY'/);
  assert.match(controller, /currentTimeMs - observedAt >= 60 \* 1000/);
  assert.match(controller, /function latestRecoverableWriteIncident/);
  assert.match(controller, /interruptedWriteRecoveryPrompt\(Number\(bucket\), recovery\.footer, responseActionId\)/);
  assert.match(controller, /write-recovery-retried-after-interrupted-generation/);
});

test('generation observation time is first-seen, not refreshed on every poll', () => {
  assert.match(controller, /function noteGenerationObserved/);
  assert.match(controller, /if \(!Number\.isFinite\(observedAt\)\) bucketState\.generationObservedAt = now\(\);/);

  const reconcile = controller.slice(
    controller.indexOf('async function reconcileOutstandingResponses'),
    controller.indexOf('async function ensurePage'),
  );
  assert.match(reconcile, /noteGenerationObserved\(bucketState\)/);
  assert.doesNotMatch(reconcile, /bucketState\.generationObservedAt = now\(\)/);

  const processBucket = controller.slice(
    controller.indexOf('async function processBucket'),
    controller.indexOf('function rebalanceExistingReviewerSlots'),
  );
  assert.match(processBucket, /noteGenerationObserved\(bucketState\)/);
  assert.doesNotMatch(processBucket, /bucketState\.generationObservedAt = now\(\)/);
});

test('visibly wedged WRITE_RECOVERY is stopped and conservatively rolled over after bounded live time', () => {
  assert.match(controller, /function liveWriteRecoveryStallReason/);
  assert.match(controller, /config\.writeRecoveryGenerationTimeoutMinutes \|\| 10/);
  assert.match(controller, /responseAction\?\.kind !== 'WRITE_RECOVERY'/);
  assert.match(controller, /async function stopLiveGeneration/);

  const reconcile = controller.slice(
    controller.indexOf('async function reconcileOutstandingResponses'),
    controller.indexOf('async function ensurePage'),
  );
  assert.match(reconcile, /liveWriteRecoveryStallReason\(bucketState, responseAction\)/);
  assert.match(reconcile, /await stopLiveGeneration\(page\)/);
  assert.match(reconcile, /WRITE_RECOVERY_GENERATION_STALL/);
  assert.match(reconcile, /await rolloverReviewer\(context, Number\(bucket\), liveRecoveryStall\)/);
});

test('message and composer DOM probes support the current ChatGPT UI', () => {
  assert.match(controller, /async function readVisibleMessages\(page\)/);
  assert.match(controller, /data-message-author-role/);
  assert.match(controller, /main div\.group\.flex\.flex-col\.pb-2\.pt-2/);
  assert.match(controller, /R433_ACTION:/);
  assert.match(controller, /assistantAfterActionMarker\(messages, actionIdValue\)/);
  assert.match(controller, /const COMPOSER_SELECTOR =/);
  assert.match(controller, /withPageProbeTimeout\(page\.evaluate\(\(selector\) => \{/);
  assert.match(controller, /document\.querySelectorAll\(selector\)/);
});



test('setup ACK hold recovery can recover when lastAction no longer points at the setup incident', () => {
  const recovery = controller.slice(
    controller.indexOf('async function recoverSetupAckHolds'),
    controller.indexOf('function stageReviewerStallRecovery'),
  );
  assert.match(recovery, /lastMessageSentKind \|\| setupAction\?\.kind/);
  assert.match(recovery, /Object\.values\(state\.incidents\)/);
  assert.match(recovery, /SETUP_ACK_MISMATCH/);
  assert.match(recovery, /SETUP_ACK_TIMEOUT/);
  assert.match(recovery, /latestAssistantAfterActionMarker\(page, setupActionId\)/);
});

test('legacy ACTIVE setup promotion is normalized only after exact action-attributed setup ACK', () => {
  const recovery = controller.slice(
    controller.indexOf('async function recoverLegacyPromotedSetupWaitStates'),
    controller.indexOf('function stageReviewerStallRecovery'),
  );
  assert.match(recovery, /bucketState\.phase !== 'ACTIVE'/);
  assert.match(recovery, /lastMessageSentKind \|\| setupAction\?\.kind/);
  assert.match(recovery, /latestAssistantAfterActionMarker\(page, setupActionId\)/);
  assert.match(recovery, /isExactSetupAck\(attributed\.text\)/);
  assert.match(recovery, /bucketState\.phase = 'SETUP_WAIT'/);
});

test('streaming setup output is not processed while generation is live', () => {
  const processBucket = controller.slice(
    controller.indexOf('async function processBucket'),
    controller.indexOf('function rebalanceExistingReviewerSlots'),
  );
  const generatingBlock = processBucket.slice(
    processBucket.indexOf('if (await isGenerating(page))'),
    processBucket.indexOf('const explicitRolloverReason'),
  );
  assert.doesNotMatch(generatingBlock, /processSetupWait/);
  assert.doesNotMatch(generatingBlock, /latestMessage\(page, 'assistant'\)/);
});

test('explicit connection interruption rolls over even when the stop button still reports generation', () => {
  const processBucket = controller.slice(
    controller.indexOf('async function processBucket'),
    controller.indexOf('async function reconcileStaleGenerationReservations'),
  );
  const rolloverCheckAt = processBucket.indexOf('const explicitRolloverReason = await conversationRolloverReason(page)');
  const generatingCheckAt = processBucket.indexOf('if (await isGenerating(page))');
  assert.ok(rolloverCheckAt >= 0);
  assert.ok(generatingCheckAt > rolloverCheckAt);
  assert.match(processBucket, /await rolloverReviewer\(context, bucket, explicitRolloverReason\)/);
});

test('stalled reviewer recovery stops and verifies a live generation before releasing its slot', () => {
  const recovery = controller.slice(
    controller.indexOf('async function recoverStalledReviewerGeneration'),
    controller.indexOf('async function recoverReviewerStallHolds'),
  );
  const liveCheckAt = recovery.indexOf('isLive = await isGenerating(page)');
  const stopAt = recovery.indexOf('await stopLiveGeneration(page)');
  const recheckAt = recovery.indexOf('isLive = await isGenerating(page)', liveCheckAt + 1);
  const rolloverAt = recovery.indexOf('await rolloverReviewer(context, Number(bucket)');
  assert.ok(liveCheckAt >= 0 && stopAt > liveCheckAt && recheckAt > stopAt && rolloverAt > recheckAt);
  assert.match(recovery, /fail-closed reviewer stall recovery/);
  assert.match(recovery, /latestAssistantAfterActionMarker\(page, actionId\)/);

  const main = controller.slice(controller.indexOf('async function main()'));
  const connectAt = main.indexOf('await connectOrLaunchBrowser({');
  const mappingGateStart = main.indexOf('const shardMapping = sourcePackShardMappingStatus();');
  const holdRecoveryAt = main.indexOf('await recoverReviewerStallHolds(context)', mappingGateStart);
  const mappingBranch = main.slice(mappingGateStart, holdRecoveryAt);
  assert.ok(connectAt >= 0 && mappingGateStart > connectAt && holdRecoveryAt > mappingGateStart);
  assert.match(mappingBranch, /await reconcileOutstandingResponses\(context, liveGeneratingByBucket\)/);
  assert.match(mappingBranch, /dispatchEnabled: false/);
  assert.doesNotMatch(mappingBranch, /sendPendingSourcePackContinuations|fillReviewerSlots|processBucket\(/);

  const staleRecoveryAt = main.indexOf('await recoverStaleAwaitingReviewers(context)', holdRecoveryAt);
  const reconcileAt = main.indexOf('await reconcileOutstandingResponses(context, liveGeneratingByBucket)', staleRecoveryAt);
  const dispatchAt = main.indexOf('await fillReviewerSlots(context)', reconcileAt);
  assert.ok(staleRecoveryAt > holdRecoveryAt && reconcileAt > staleRecoveryAt && dispatchAt > reconcileAt,
    'browser attachment and recovery/reconciliation must precede reviewer dispatch');
  assert.match(controller, /awaitingResponseBuckets: lastLiveReviewerOccupancy\.awaitingResponseBuckets/);

  const reconcile = controller.slice(
    controller.indexOf('async function reconcileOutstandingResponses'),
    controller.indexOf('async function ensurePage'),
  );
  assert.match(reconcile, /if \(error\?\.code === 'PAGE_PROBE_STALLED'[\s\S]*?await recoverStalledReviewerGeneration/);
  const liveWriteStart = reconcile.indexOf('const liveRecoveryStall =');
  const liveWriteEnd = reconcile.indexOf('\n        continue;\n      }\n\n      const responseActionId', liveWriteStart);
  const liveWriteRecovery = reconcile.slice(liveWriteStart, liveWriteEnd);
  assert.ok(liveWriteRecovery.indexOf('await stopLiveGeneration(page)') < liveWriteRecovery.indexOf('if (await isGenerating(page))'));
  assert.ok(liveWriteRecovery.indexOf('if (await isGenerating(page))') < liveWriteRecovery.indexOf('await rolloverReviewer'));

  const processBucket = controller.slice(
    controller.indexOf('async function processBucket'),
    controller.indexOf('function rebalanceExistingReviewerSlots'),
  );
  assert.match(processBucket, /if \(error\.code === 'PAGE_PROBE_STALLED'[\s\S]*?await recoverStalledReviewerGeneration/);
});

test('source-pack unavailability has a persisted retry deadline', () => {
  assert.match(controller, /sourcePackRetryNotBefore = retryNotBefore/);
  assert.match(controller, /if \(!sourcePackRetryReady\(bucketState\)\) continue;/);
  assert.match(controller, /source-pack-unavailable-backoff/);
});

test('stale source-pack boundary recovery requires action-scoped boundary evidence', () => {
  const recovery = controller.slice(
    controller.indexOf('function recoverStaleSourcePackBoundaryState'),
    controller.indexOf('async function recoverInvalidSourcePackCursors'),
  );
  assert.match(recovery, /lastProcessedActionId/);
  assert.match(recovery, /processedResponseKey/);
  assert.match(recovery, /NEXT_SOURCE_PACKS_REQUIRED/);
});

test('source-pack boundary advancement is gated by exact-target availability evidence', () => {
  const processActive = controller.slice(
    controller.indexOf('async function processActive'),
    controller.indexOf('async function recoverIdleActiveBucket'),
  );
  const boundaryAt = processActive.indexOf("footer.blocker.trim().toUpperCase() === 'NEXT_SOURCE_PACKS_REQUIRED'");
  const unavailableAt = processActive.indexOf('responseIndicatesSourcePackUnavailable(text, currentTargetFilename)', boundaryAt);
  const advanceAt = processActive.indexOf('advanceSourcePackAfterBoundary', boundaryAt);
  assert.ok(boundaryAt >= 0);
  assert.ok(unavailableAt > boundaryAt);
  assert.ok(advanceAt > unavailableAt);
  assert.match(processActive, /boundary footer contradicted by unavailable/);
  assert.match(controller, /recoverFalseSourcePackBoundaryAdvances\(\)/);
});


test('reviewer sends require the highest accessible model and High effort', () => {
  const modelHelper = fs.readFileSync(path.join(ROOT, 'src', 'reviewer-model.mjs'), 'utf8');
  const sendAction = controller.slice(
    controller.indexOf('async function sendAction'),
    controller.indexOf('async function inspectLiveGeneratingByBucket'),
  );
  const verificationAt = sendAction.indexOf('ensureHighestReviewerModel(page)');
  const fillAt = sendAction.indexOf('fillComposer(page, text)');
  const sendAt = sendAction.indexOf('pressSend(page)');
  assert.ok(verificationAt >= 0 && verificationAt < fillAt && verificationAt < sendAt);
  assert.match(modelHelper, /GPT-5\.6 Sol/);
  assert.match(modelHelper, /High,\\s\*3 of 3/);
  assert.match(modelHelper, /REVIEWER_MODEL_UNAVAILABLE/);
  assert.match(sendAction, /verifiedBeforeEverySend|ensureHighestReviewerModel/);
});

test('reviewer rotation reuses exactly two bounded slots and ambiguous creation never retries automatically', () => {
  assert.ok(controller.includes('const MAX_REVIEWER_TABS = 2;'));
  assert.ok(controller.includes('const MAX_AUTOMATION_TABS = 3;'));
  const slotSetup = controller.slice(
    controller.indexOf('async function ensureBrowserSlots'),
    controller.indexOf('async function reviewerSlotForBucket'),
  );
  assert.match(slotSetup, /reviewerSlotIds = \['reviewer-1', 'reviewer-2'\]/);
  assert.match(slotSetup, /ensureBrowserPageBudget\(context/);
  assert.match(slotSetup, /maxAutomationTabs: MAX_AUTOMATION_TABS/);
  assert.match(slotSetup, /maxReviewerTabs: MAX_REVIEWER_TABS/);

  const slotAssignment = controller.slice(
    controller.indexOf('async function reviewerSlotForBucket'),
    controller.indexOf('async function refreshReviewerSlotStatus'),
  );
  assert.match(slotAssignment, /existing\.page\.goto\(targetUrl/);
  assert.match(slotAssignment, /slot\.page\.goto\(targetUrl/);
  assert.match(slotAssignment, /both reusable reviewer slots are occupied/);
  assert.doesNotMatch(slotAssignment, /context\.newPage\(/);

  const ensurePage = controller.slice(
    controller.indexOf('async function ensurePage'),
    controller.indexOf('function isAuthenticationPage'),
  );
  assert.match(ensurePage, /reviewerSlotForBucket\(context/);
  assert.doesNotMatch(ensurePage, /context\.newPage\(/);

  const creationStart = controller.indexOf('async function createReviewer');
  const creationEnd = controller.indexOf('\nasync function ', creationStart + 1);
  const creation = controller.slice(creationStart, creationEnd);
  assert.match(creation, /reviewerSlotForBucket\(context, bucket, \{ allowUninitialized: true \}\)/);
  assert.match(creation, /page\.goto\(config\.projectUrl/);
  assert.doesNotMatch(creation, /context\.newPage\(/);
  assert.ok(controller.includes("error.code === 'SEND_NOT_OBSERVED' ? 'SEND_UNCONFIRMED' : 'UNRESOLVED'"));
  assert.ok(controller.includes('retry is disabled to avoid duplicate conversations'));
  assert.ok(creation.includes("'NEW_CHAT_ID_TIMEOUT'"));
  assert.ok(creation.includes('wakeCoordinator: false'));
  const recovery = controller.slice(
    controller.indexOf('function preserveUnresolvedNewChatHolds'),
    controller.indexOf('function recoverRetryablePartialWriteHolds'),
  );
  assert.doesNotMatch(recovery, /phase = 'PENDING'/);
  assert.match(recovery, /new-chat-send-not-observed/);
  assert.match(recovery, /startup-new-chat-retry:/);
  assert.doesNotMatch(controller, /recoverRetryableNewChatHolds/);
});

test('pack inventory exhaustion reconciles the corpus instead of retrying a phantom pack', () => {
  const continuation = controller.slice(
    controller.indexOf('async function sendPendingSourcePackContinuations'),
    controller.indexOf('function updateReceivedMessage'),
  );
  assert.ok(continuation.indexOf('isSourcePackBeyondInventory') >= 0);
  assert.ok(continuation.indexOf('isSourcePackBeyondInventory') < continuation.indexOf('sourcePackRetryReady'));
  assert.match(continuation, /'CORPUS_RECONCILE'/);
  const cursorRecovery = controller.slice(
    controller.indexOf('async function recoverInvalidSourcePackCursors'),
    controller.indexOf('function stageRecoverableSourcePackHold'),
  );
  assert.match(cursorRecovery, /isVerifiedSourcePackCursor\(bucketNumber, bucketState\)/);
  assert.match(cursorRecovery, /sourcePackCursorReconciliationRequired = true/);
  assert.match(cursorRecovery, /sourcePackResumePending = false/);
  assert.match(cursorRecovery, /SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED/);
  assert.match(cursorRecovery, /holdType: 'INTEGRITY'/);
  assert.match(cursorRecovery, /bucketState\.phase = 'HOLD'/);
});

test('missing control starts in recovery-only and cannot dispatch before pre-dispatch evidence', () => {
  const readStart = controller.indexOf('function readControl()');
  const readEnd = controller.indexOf('\nfunction controlPauseError', readStart);
  assert.ok(readStart >= 0 && readEnd > readStart);
  const readControl = new Function(
    'loadJson',
    'CONTROL_PATH',
    `${controller.slice(readStart, readEnd)}\nreturn readControl;`,
  )((_file, fallback) => fallback, '/tmp/missing-control.json');
  const absent = readControl();
  assert.equal(absent.present, false);
  assert.equal(absent.desiredState, 'RECONCILIATION_ONLY');

  const guardStart = controller.indexOf('function controlPauseError()');
  const guardEnd = controller.indexOf('\nfunction saveJsonAtomic', guardStart);
  const makeGuard = new Function(
    'readControl',
    'preDispatchReady',
    `${controller.slice(guardStart, guardEnd)}\nreturn assertControlRunning;`,
  );
  assert.throws(
    () => makeGuard(() => absent, false)(),
    error => error.code === 'CONTROL_RECONCILIATION_ONLY',
  );

  const sendActionStart = controller.indexOf('async function sendAction(');
  const sendActionEnd = controller.indexOf('\nasync function inspectLiveGeneratingByBucket', sendActionStart);
  assert.match(controller.slice(sendActionStart, sendActionEnd), /assertControlRunning\(\)/);
  assert.match(controller, /if \(readControl\(\)\.desiredState !== 'RUNNING' \|\| !preDispatchReady\) return;/);

  const main = controller.slice(controller.indexOf('async function main()'));
  const attachAt = main.indexOf('await connectOrLaunchBrowser({');
  const reconcileAt = main.indexOf('await reconcileOutstandingResponses(context, liveGeneratingByBucket)');
  const readinessAt = main.indexOf('updatePreDispatchReadiness(shardMapping, liveGeneratingByBucket)');
  const dispatchAt = main.indexOf('await sendPendingSourcePackContinuations(context)', readinessAt);
  assert.ok(attachAt >= 0 && reconcileAt > attachAt && readinessAt > reconcileAt && dispatchAt > readinessAt);
  assert.match(main, /if \(!preDispatchReady \|\| recoveredControl\.desiredState !== 'RUNNING'\)[\s\S]*?continue;/);
  assert.doesNotMatch(main, /if \(control\.desiredState === 'PAUSED'\)\s*\{[\s\S]*?continue;/);
});

test('incident notification cannot crash Linux when Windows msg.exe is unavailable', () => {
  const notifyStart = controller.indexOf('function notifyUserIncident(');
  const notifyEnd = controller.indexOf('\nfunction recordIncident(', notifyStart);
  assert.ok(notifyStart >= 0 && notifyEnd > notifyStart);
  const notify = controller.slice(notifyStart, notifyEnd);
  assert.match(notify, /process\.platform !== 'win32'/);
  assert.match(notify, /child\.on\('error'/);
  assert.match(notify, /dashboard/);
});

test('owned browser profile locks are cleaned only after the owned browser stops', () => {
  assert.match(controller, /cleanupAutomationProfileEphemeral/);
  assert.match(controller, /let ownedBrowserProfile = \{/);
  assert.match(controller, /process\.kill\(Number\(ownedBrowserProfile\.pid\), 0\)/);
  assert.match(controller, /cleanupOwnedBrowserProfileIfStopped\(\);/);
  assert.match(controller, /profileDirectoryName: runtime\.profileDirectoryName \|\| config\.browserProfileName \|\| 'Default'/);
});
