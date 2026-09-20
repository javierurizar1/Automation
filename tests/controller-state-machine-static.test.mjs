import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRetiredReviewerTabs } from '../src/reviewer-tabs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controller = fs.readFileSync(path.join(ROOT, 'src', 'controller.mjs'), 'utf8');
const reviewerModel = fs.readFileSync(path.join(ROOT, 'src', 'reviewer-model.mjs'), 'utf8');

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

test('chat rotation identifies only open retired controller conversations', () => {
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
  assert.match(controller, /await closeRetiredReviewerTabs\(context, bucket\)/);
  assert.match(controller, /'RETIRED_REVIEWER_TABS_NOT_CLOSED'/);
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

test('browser generation probes fail closed briefly then escalate a persistently wedged page', () => {
  const probe = controller.slice(
    controller.indexOf('const PAGE_PROBE_TIMEOUT_MS'),
    controller.indexOf('async function conversationRolloverReason'),
  );
  assert.match(probe, /PAGE_PROBE_TIMEOUT_MS = 5000/);
  assert.match(probe, /PAGE_PROBE_STALL_THRESHOLD = 3/);
  assert.match(probe, /Promise\.race/);
  assert.match(probe, /error\.code = 'PAGE_PROBE_TIMEOUT'/);
  assert.match(probe, /stalled\.code = 'PAGE_PROBE_STALLED'/);
  assert.match(probe, /return true;/);

  const inspect = controller.slice(
    controller.indexOf('async function inspectLiveGeneratingByBucket'),
    controller.indexOf('function refreshLiveReviewerOccupancy'),
  );
  assert.match(inspect, /error\?\.code === 'PAGE_PROBE_STALLED'/);

  const reconcile = controller.slice(
    controller.indexOf('async function reconcileOutstandingResponses'),
    controller.indexOf('async function ensurePage'),
  );
  assert.match(reconcile, /PAGE_PROBE_STALLED/);
  assert.match(reconcile, /await rolloverReviewer/);
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
  assert.match(controller, /chromium\.connectOverCDP\(endpoint, \{ timeout: 10000 \}\)/);
  assert.doesNotMatch(controller, /connectOverCDP\(endpoint, \{ timeout: 60000 \}\)/);
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

test('reviewer rotation is capped at five chats and ambiguous creation never retries automatically', () => {
  assert.ok(controller.includes('const MAX_REVIEWER_CHAT_TABS = 5;'));
  assert.ok(controller.includes('managedReviewerChatCount() >= MAX_REVIEWER_CHAT_TABS'));
  assert.ok(controller.includes("error.code === 'SEND_NOT_OBSERVED' ? 'SEND_UNCONFIRMED' : 'UNRESOLVED'"));
  assert.ok(controller.includes('retry is disabled to avoid duplicate conversations'));
  const creation = controller.slice(
    controller.indexOf('async function createReviewer'),
    controller.indexOf('async function rolloverReviewer'),
  );
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
