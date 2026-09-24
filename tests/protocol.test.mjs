import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLD_TYPES,
  actionResponseKey,
  actionId,
  assistantAfterActionMarker,
  classifyConversationMessageRole,
  bucketHasGenerationReservation,
  bucketOccupiesReviewerSlot,
  bucketReclaimableIdleSlot,
  buildLiveReviewerOccupancy,
  bucketEligibleForScheduling,
  computeDesiredActiveReviewers,
  classifyHoldType,
  conversationRolloverReasonFromText,
  countOccupiedReviewerSlots,
  exactSourcePackFilenameMatches,
  createHoldRecord,
  getBucketState,
  holdValidationKind,
  isHoldRetryDue,
  isExactSetupAck,
  isRecoverableAdvisoryCoordinatorFooter,
  isRecoverableReadbackFooter,
  isRecoverableRegistryWriteFooter,
  isRecoverableSourcePackHoldIncident,
  isRecoverableTurnBoundaryFooter,
  isRecoverableUnavailableSourcePackFooter,
  isSourcePackBoundaryFooter,
  isSourcePackBeyondInventory,
  isSourcePackAccessVerified,
  isVerifiedCorpusCompletion,
  markSourcePackAccessVerified,
  nextSourcePackNumber,
  normalizeBucketId,
  parseCorpusCompletionEvidence,
  parseFooter,
  recoverablePackNumberFromFooter,
  responseIndicatesSourcePackUnavailable,
  resetPerChatObservationState,
  resetSourcePackAccessState,
  clearStaleControllerSideSourcePackVerification,
  buildSourcePackContinuationPrompt,
  reviewerConfirmedSourcePackAccess,
  selectPendingBuckets,
  selectReviewerSlotCandidates,
  setupAckTimedOut,
  shouldClearStaleGenerationReservation,
  shouldEscalateFooter,
  shouldRetrySourcePackContinuation,
  sourcePackRetryDelayMs,
  sourcePackRetryReady,
  sourcePackContinuationAlreadySent,
  sourcePackFilename,
  sourcePackShardFolderUrl,
  sourcePackShardForBucket,
  SOURCE_PACK_SHARDS,
  parseSourcePackNumber,
  isValidSourcePackNumber,
  isInvalidZeroSourcePackFilename,
  packNumberFromFilename,
  extractPackNumbersFromText,
  extractLastVisibleSourcePackNumber,
  resolveNextSourcePackTargetNumber,
  sanitizeStoredSourcePackCursorFields,
  validateConservativeSourcePackBoundary,
} from '../src/protocol.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parses a strict NORMAL footer', () => {
  const footer = parseFooter(`work done

AUDIT_TURN_STATUS
STATUS: NORMAL
NEW_CASES: 100
WRITES_VERIFIED: YES
BLOCKER: NONE
TRIGGER_COORDINATOR: NO`);
  assert.deepEqual(footer, {
    status: 'NORMAL',
    newCases: 100,
    writesVerified: 'YES',
    blocker: 'NONE',
    triggerCoordinator: 'NO',
  });
});

test('parses COMPLETE footer', () => {
  const footer = parseFooter(`AUDIT_TURN_STATUS
STATUS: COMPLETE
NEW_CASES: 0
WRITES_VERIFIED: YES
BLOCKER: NONE
TRIGGER_COORDINATOR: NO`);
  assert.equal(footer.status, 'COMPLETE');
});

test('parses full-corpus completion evidence', () => {
  const evidence = parseCorpusCompletionEvidence(`Full reconciliation complete.\nFULL_CORPUS_RECONCILED: YES\nFULL_CORPUS_AUDITABLE_POPULATION: 123\nOWNED_PENDING_CASES: 0\nUNRESOLVED_WRITES: 0\n\nAUDIT_TURN_STATUS\nSTATUS: COMPLETE\nNEW_CASES: 0\nWRITES_VERIFIED: YES\nBLOCKER: NONE\nTRIGGER_COORDINATOR: NO`);
  assert.deepEqual(evidence, {
    reconciled: 'YES',
    auditablePopulation: 123,
    ownedPendingCases: 0,
    unresolvedWrites: 0,
  });
  assert.equal(isVerifiedCorpusCompletion(evidence, 123), true);
});

test('rejects pack exhaustion as full-corpus completion', () => {
  assert.equal(isVerifiedCorpusCompletion({
    reconciled: 'YES',
    auditablePopulation: 123,
    ownedPendingCases: 1,
  }, 123), false);
  assert.equal(isVerifiedCorpusCompletion(null, 123), false);
});

test('completion evidence requires exactly the authoritative 65,720 population', () => {
  const completeEvidence = {
    reconciled: 'YES',
    auditablePopulation: 65_720,
    ownedPendingCases: 0,
    unresolvedWrites: 0,
  };
  assert.equal(isVerifiedCorpusCompletion(completeEvidence, 65_720), true);
  assert.equal(isVerifiedCorpusCompletion({ ...completeEvidence, auditablePopulation: 65_719 }, 65_720), false);
  assert.equal(isVerifiedCorpusCompletion({ ...completeEvidence, ownedPendingCases: 1 }, 65_720), false);
  assert.equal(isVerifiedCorpusCompletion({ ...completeEvidence, unresolvedWrites: 1 }, 65_720), false);
  assert.equal(isVerifiedCorpusCompletion({ ...completeEvidence, unresolvedWrites: undefined }, 65_720), false);
});

test('typed transient registry holds carry a revalidation policy and bounded backoff', () => {
  assert.deepEqual(HOLD_TYPES, ['TRANSIENT_EXTERNAL', 'INTEGRITY', 'ADVISORY', 'USER', 'COMPLETE']);
  assert.equal(classifyHoldType('REGISTRY_STRUCTURE_UNAVAILABLE'), 'TRANSIENT_EXTERNAL');
  assert.deepEqual(holdValidationKind('REGISTRY_STRUCTURE_UNAVAILABLE', 2), {
    kind: 'REGISTRY_SHARD_AVAILABLE',
    bucket: 2,
  });

  const hold = createHoldRecord({
    type: 'TRANSIENT_EXTERNAL',
    reason: 'REGISTRY_STRUCTURE_UNAVAILABLE',
    bucket: 2,
    createdAt: '2026-09-18T10:00:00.000Z',
  });
  assert.equal(hold.retryPolicy, 'REVALIDATE');
  assert.equal(hold.nextAttemptAt, '2026-09-18T10:01:00.000Z');
  assert.deepEqual(hold.validation, { kind: 'REGISTRY_SHARD_AVAILABLE', bucket: 2 });
  assert.equal(isHoldRetryDue(hold, Date.parse('2026-09-18T10:00:59.999Z')), false);
  assert.equal(isHoldRetryDue(hold, Date.parse('2026-09-18T10:01:00.000Z')), true);

  const heldBucket = { complete: false, phase: 'HOLD', hold };
  assert.equal(bucketEligibleForScheduling(heldBucket, Date.parse('2026-09-18T10:02:00.000Z')), false);
  heldBucket.hold = null;
  heldBucket.phase = 'ACTIVE';
  assert.equal(bucketEligibleForScheduling(heldBucket, Date.parse('2026-09-18T10:02:00.000Z')), true);
});

test('integrity holds do not enter the timed transient-release path', () => {
  assert.equal(classifyHoldType('REGISTRY_MAPPING_AMBIGUOUS'), 'INTEGRITY');
  const hold = createHoldRecord({
    type: 'INTEGRITY',
    reason: 'ACTION_LEDGER_DISAGREEMENT',
    createdAt: '2026-09-18T10:00:00.000Z',
    nextAttemptAt: '2026-09-18T10:01:00.000Z',
  });
  assert.equal(hold.retryPolicy, 'EVIDENCE_RECONCILIATION');
  assert.equal(hold.nextAttemptAt, null);
  assert.equal(isHoldRetryDue(hold, Number.MAX_SAFE_INTEGER), false);
  assert.equal(bucketEligibleForScheduling({ complete: false, phase: 'HOLD', hold }, Number.MAX_SAFE_INTEGER), false);
});

test('rejects nonstandard status', () => {
  assert.equal(parseFooter(`AUDIT_TURN_STATUS
STATUS: ACTIVE_PENDING
NEW_CASES: 10
WRITES_VERIFIED: YES
BLOCKER: NONE
TRIGGER_COORDINATOR: NO`), null);
});

test('setup ack must be exact', () => {
  assert.equal(isExactSetupAck('PROTOCOL_SETUP_ACK_V3'), true);
  assert.equal(isExactSetupAck('PROTOCOL_SETUP_ACK_V3_'), true);
  assert.equal(isExactSetupAck('OK PROTOCOL_SETUP_ACK_V3'), false);
});

test('new chat reset allows identical setup ACK to be processed again', () => {
  const bucket = {
    processedHash: 'old-ack-hash',
    lastHash: 'old-ack-hash',
    lastMessageReceivedHash: 'old-ack-hash',
    candidateHash: 'old-ack-hash',
    candidateCount: 12,
    malformedCount: 2,
    casesReported: 123,
    awaitingResponseAt: '2026-09-15T23:24:14.666Z',
  };
  resetPerChatObservationState(bucket);
  assert.equal(bucket.processedHash, null);
  assert.equal(bucket.lastMessageReceivedHash, null);
  assert.equal(bucket.candidateHash, null);
  assert.equal(bucket.candidateCount, 0);
  assert.equal(bucket.malformedCount, 0);
  assert.equal(bucket.casesReported, 123);
  assert.equal(bucket.awaitingResponseAt, '2026-09-15T23:24:14.666Z');
});

test('fills reviewer slots up to the configured two-reviewer limit', () => {
  const buckets = {
    0: { complete: true, chatUrl: 'u0', phase: 'COMPLETE' },
    1: { complete: false, chatUrl: 'u1', phase: 'ACTIVE' },
    2: { complete: true, chatUrl: 'u2', phase: 'COMPLETE' },
    3: { complete: true, chatUrl: 'u3', phase: 'COMPLETE' },
    4: { complete: false, chatUrl: null, phase: 'PENDING' },
    5: { complete: false, chatUrl: null, phase: 'PENDING' },
  };
  assert.deepEqual(selectPendingBuckets(buckets, 2), ['4']);
});

test('does not launch a pending bucket when both reviewer slots are occupied', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE' },
    1: { complete: false, chatUrl: 'u1', phase: 'ACTIVE' },
    2: { complete: true, chatUrl: 'u2', phase: 'COMPLETE' },
    3: { complete: true, chatUrl: 'u3', phase: 'COMPLETE' },
    4: { complete: true, chatUrl: 'u4', phase: 'COMPLETE' },
    5: { complete: false, chatUrl: null, phase: 'PENDING' },
  };
  assert.deepEqual(selectPendingBuckets(buckets, 2), []);
});

test('excluded buckets neither consume reviewer capacity nor get launched', () => {
  const buckets = {
    0: { complete: false, chatUrl: null, phase: 'PENDING' },
    1: { complete: false, chatUrl: 'u1', phase: 'ACTIVE' },
    2: { complete: false, chatUrl: 'u2', phase: 'ACTIVE' },
    3: { complete: false, chatUrl: null, phase: 'PENDING' },
    4: { complete: false, chatUrl: 'u4', phase: 'PAUSED' },
    5: { complete: false, chatUrl: null, phase: 'PENDING' },
  };
  assert.deepEqual(selectPendingBuckets(buckets, 2, new Set([2, 4, 5])), ['0']);
});

test('paused reviewer does not consume an active slot', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE' },
    1: { complete: false, chatUrl: 'u1', phase: 'ACTIVE' },
    2: { complete: false, chatUrl: 'u2', phase: 'ACTIVE' },
    3: { complete: false, chatUrl: 'u3', phase: 'ACTIVE' },
    4: { complete: false, chatUrl: 'u4', phase: 'PAUSED' },
    5: { complete: false, chatUrl: null, phase: 'PENDING' },
  };
  assert.deepEqual(selectPendingBuckets(buckets, 2), []);
});

test('readback-required NORMAL footer is recovered locally', () => {
  assert.equal(isRecoverableReadbackFooter({
    status: 'NORMAL',
    writesVerified: 'YES',
    blocker: 'PACK_111_READBACK_REQUIRED',
    triggerCoordinator: 'NO',
  }), true);
  assert.equal(isRecoverableReadbackFooter({
    status: 'NORMAL',
    writesVerified: 'PARTIAL',
    blocker: 'NONE',
    triggerCoordinator: 'NO',
  }), true);
  assert.equal(isRecoverableReadbackFooter({
    status: 'NORMAL',
    writesVerified: 'YES',
    blocker: 'NEXT_SOURCE_PACKS_REQUIRED',
    triggerCoordinator: 'YES',
  }), false);
  assert.equal(isRecoverableReadbackFooter({
    status: 'NORMAL',
    writesVerified: 'YES',
    blocker: 'REGISTRY_MAPPING_AMBIGUOUS',
    triggerCoordinator: 'YES',
  }), false);
});

test('turn capacity and tool limits are normal continuation boundaries', () => {
  for (const blocker of ['TURN_CAPACITY', 'TURN_TOOL_LIMIT', 'TURN_TOKEN_LIMIT', 'TURN_TIME_LIMIT']) {
    const footer = {
      status: 'NORMAL',
      writesVerified: 'YES',
      blocker,
      triggerCoordinator: 'NO',
    };
    assert.equal(isRecoverableTurnBoundaryFooter(footer), true);
    assert.equal(shouldEscalateFooter(footer), false);
  }
});

test('genuine NORMAL blockers still escalate', () => {
  const footer = {
    status: 'NORMAL',
    writesVerified: 'YES',
    blocker: 'REGISTRY_MAPPING_AMBIGUOUS',
    triggerCoordinator: 'NO',
  };
  assert.equal(isRecoverableTurnBoundaryFooter(footer), false);
  assert.equal(shouldEscalateFooter(footer), true);
});

test('setup ACK timeout expires stalled SETUP_WAIT but not a fresh handshake', () => {
  const now = Date.parse('2026-09-15T23:00:00Z');
  assert.equal(setupAckTimedOut({
    phase: 'SETUP_WAIT',
    awaitingResponseAt: '2026-09-15T22:54:59Z',
  }, 5, now), true);
  assert.equal(setupAckTimedOut({
    phase: 'SETUP_WAIT',
    awaitingResponseAt: '2026-09-15T22:56:00Z',
  }, 5, now), false);
  assert.equal(setupAckTimedOut({
    phase: 'ACTIVE',
    awaitingResponseAt: '2026-09-15T22:00:00Z',
  }, 5, now), false);
});

test('action ids are deterministic', () => {
  const spec = { bucket: 4, chatKey: 'x', responseHash: 'r', kind: 'CONTINUE', prompt: 'p' };
  assert.equal(actionId(spec), actionId(spec));
});

test('identical response text remains distinct across action ids and idempotent within one action', () => {
  assert.equal(actionResponseKey('A1', 'same'), 'A1:same');
  assert.equal(actionResponseKey('A2', 'same'), 'A2:same');
  assert.notEqual(actionResponseKey('A1', 'same'), actionResponseKey('A2', 'same'));
  assert.equal(actionResponseKey('A2', 'same'), actionResponseKey('A2', 'same'));
  assert.notEqual(
    actionId({ bucket: 1, chatKey: 'c', responseHash: 'same', kind: 'CONTINUE', prompt: 'p', predecessorActionId: 'A1' }),
    actionId({ bucket: 1, chatKey: 'c', responseHash: 'same', kind: 'CONTINUE', prompt: 'p', predecessorActionId: 'A2' }),
  );
});

test('assistant response must occur after the matching action marker', () => {
  const beforeOnly = assistantAfterActionMarker([
    { role: 'assistant', text: 'old response' },
    { role: 'user', text: 'new turn [[R433_ACTION:A2]]' },
  ], 'A2');
  assert.equal(beforeOnly.attributed, false);
  const after = assistantAfterActionMarker([
    { role: 'assistant', text: 'old response' },
    { role: 'user', text: 'new turn [[R433_ACTION:A2]]' },
    { role: 'assistant', text: 'new response' },
  ], 'A2');
  assert.deepEqual(after, { attributed: true, text: 'new response' });
});

test('conversation DOM fallback classifies current user and assistant message roots', () => {
  assert.equal(classifyConversationMessageRole({
    className: 'MarkdownRoot-rZKhxa rich-text-user-turn',
  }), 'user');
  assert.equal(classifyConversationMessageRole({
    className: 'MarkdownRoot-rZKhxa [&>*:first-child]:mt-0',
  }), 'assistant');
  assert.equal(classifyConversationMessageRole({ authorRole: 'assistant', className: 'unknown' }), 'assistant');
  assert.equal(classifyConversationMessageRole({ className: 'unrelated-container' }), null);
});

test('conversation length and hard generation errors roll over, rate limits do not', () => {
  assert.match(conversationRolloverReasonFromText('maximum conversation length reached'), /conversation/i);
  assert.match(conversationRolloverReasonFromText('there was an error generating a response'), /failure/i);
  assert.match(conversationRolloverReasonFromText('Connection interrupted. Waiting for the complete answer'), /failure/i);
  assert.match(conversationRolloverReasonFromText('Waiting for the complete answer'), /failure/i);
  assert.equal(conversationRolloverReasonFromText('Too many requests. Rate limit exceeded.'), null);
});

test('error footer escalates', () => {
  assert.equal(shouldEscalateFooter({
    status: 'ERROR',
    triggerCoordinator: 'YES',
    blocker: 'registry',
  }), true);
});

test('source-pack exhaustion is recoverable only after verified writes', () => {
  assert.equal(isSourcePackBoundaryFooter({ status: 'NORMAL', writesVerified: 'YES', blocker: 'NEXT_SOURCE_PACKS_REQUIRED', triggerCoordinator: 'NO' }), true);
  assert.equal(isSourcePackBoundaryFooter({ status: 'NORMAL', writesVerified: 'PARTIAL', blocker: 'NEXT_SOURCE_PACKS_REQUIRED', triggerCoordinator: 'NO' }), false);
});

test('source-pack cursor is idempotent for one incident and advances for a later boundary', () => {
  assert.equal(nextSourcePackNumber({ startPack: 4, incidentId: 'INC-1', lastDeliveredNumber: null, lastDeliveredIncidentId: null }), 4);
  assert.equal(nextSourcePackNumber({ startPack: 4, incidentId: 'INC-1', lastDeliveredNumber: 4, lastDeliveredIncidentId: 'INC-1' }), 4);
  assert.equal(nextSourcePackNumber({ startPack: 4, incidentId: 'INC-2', lastDeliveredNumber: 4, lastDeliveredIncidentId: 'INC-1' }), 5);
  assert.equal(nextSourcePackNumber({ startPack: 1, incidentId: 'B0-2', lastDeliveredNumber: 7, lastDeliveredIncidentId: 'B0-1' }), 8);
});

test('known registry write failures are recoverable but arbitrary errors are not', () => {
  assert.equal(isRecoverableRegistryWriteFooter({
    status: 'ERROR',
    writesVerified: 'NO',
    blocker: 'REGISTRY_WRITE_NOT_COMPLETED',
    triggerCoordinator: 'NO',
  }), true);
  assert.equal(isRecoverableRegistryWriteFooter({
    status: 'ERROR',
    writesVerified: 'NO',
    blocker: 'REGISTRY_WRITE_BLOCKED_BY_CONNECTOR_GUARD',
    triggerCoordinator: 'YES',
  }), true);
  assert.equal(isRecoverableRegistryWriteFooter({
    status: 'ERROR',
    writesVerified: 'PARTIAL',
    blocker: 'ROWS_12_16_WRITE_ISSUED_READBACK_UNVERIFIED',
    triggerCoordinator: 'NO',
  }), true);
  assert.equal(isRecoverableRegistryWriteFooter({
    status: 'ERROR',
    writesVerified: 'PARTIAL',
    blocker: 'ROWS_12_16_WRITE_ISSUED_READBACK_UNVERIFIED_EXTRA',
    triggerCoordinator: 'NO',
  }), false);
  assert.equal(isRecoverableRegistryWriteFooter({
    status: 'ERROR',
    writesVerified: 'NO',
    blocker: 'REGISTRY_MAPPING_AMBIGUOUS',
    triggerCoordinator: 'YES',
  }), false);
});

test('exact unresolved pack blockers yield a deterministic retry pack', () => {
  assert.equal(recoverablePackNumberFromFooter({
    status: 'NORMAL',
    writesVerified: 'YES',
    blocker: 'PACK_000032_JSONL_NOT_YET_RESOLVED',
    triggerCoordinator: 'NO',
  }), 32);
  assert.equal(recoverablePackNumberFromFooter({
    status: 'NORMAL',
    writesVerified: 'PARTIAL',
    blocker: 'PACK_000032_JSONL_NOT_YET_RESOLVED',
    triggerCoordinator: 'NO',
  }), null);
});

test('verified writes with no blocker can isolate an advisory coordinator request', () => {
  assert.equal(isRecoverableAdvisoryCoordinatorFooter({
    status: 'NORMAL',
    writesVerified: 'YES',
    blocker: 'NONE',
    triggerCoordinator: 'YES',
  }), true);
  assert.equal(isRecoverableAdvisoryCoordinatorFooter({
    status: 'NORMAL',
    writesVerified: 'YES',
    blocker: 'REGISTRY_MAPPING_AMBIGUOUS',
    triggerCoordinator: 'YES',
  }), false);
  assert.equal(isRecoverableAdvisoryCoordinatorFooter({
    status: 'ERROR',
    writesVerified: 'YES',
    blocker: 'TERMINAL_DUPLICATE_CLASSIFICATION_COLLISION',
    triggerCoordinator: 'YES',
  }), true);
  assert.equal(shouldEscalateFooter({
    status: 'ERROR',
    writesVerified: 'YES',
    blocker: 'TERMINAL_DUPLICATE_CLASSIFICATION_COLLISION',
    triggerCoordinator: 'YES',
  }), false);
  assert.equal(isRecoverableAdvisoryCoordinatorFooter({
    status: 'ERROR',
    writesVerified: 'YES',
    blocker: 'REGISTRY_MAPPING_AMBIGUOUS',
    triggerCoordinator: 'YES',
  }), false);
});

test('normalizeBucketId accepts numeric and string ids', () => {
  assert.equal(normalizeBucketId(3), '3');
  assert.equal(normalizeBucketId('3'), '3');
  assert.equal(normalizeBucketId('03'), '3');
  assert.equal(normalizeBucketId(6), null);
  assert.equal(normalizeBucketId(-1), null);
});

test('getBucketState uses canonical string bucket keys', () => {
  const state = { buckets: { '1': { phase: 'ACTIVE', complete: false, chatUrl: 'u1' } } };
  assert.equal(getBucketState(state, 1)?.phase, 'ACTIVE');
  assert.equal(getBucketState(state, '1')?.phase, 'ACTIVE');
  assert.equal(getBucketState(state, 9), null);
});

test('two runnable unblocked buckets fill two reviewer slots', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE' },
    1: { complete: false, chatUrl: 'u1', phase: 'ACTIVE' },
    2: { complete: false, chatUrl: 'u2', phase: 'ACTIVE' },
    3: { complete: false, chatUrl: null, phase: 'PENDING' },
  };
  const blocked = new Set([2]);
  assert.equal(computeDesiredActiveReviewers(buckets, 2, blocked, 4), 2);
  assert.equal(countOccupiedReviewerSlots(buckets, blocked), 2);
});

test('three runnable buckets still cap at two occupied slots', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE' },
    1: { complete: false, chatUrl: 'u1', phase: 'ACTIVE' },
    3: { complete: false, chatUrl: 'u3', phase: 'ACTIVE' },
  };
  assert.equal(computeDesiredActiveReviewers(buckets, 2, [], 6), 2);
  assert.equal(countOccupiedReviewerSlots(buckets, []), 3);
});

test('candidate selection excludes setup and hold buckets while keeping pending reviewer creation eligible', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'HOLD' },
    1: { complete: false, chatUrl: 'u1', phase: 'SETUP_WAIT' },
    3: { complete: false, chatUrl: null, phase: 'PENDING' },
  };
  assert.deepEqual(selectReviewerSlotCandidates(buckets, []), ['3']);
});

test('blocked buckets do not prevent unblocked buckets from filling two slots', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE' },
    1: { complete: false, chatUrl: null, phase: 'PENDING' },
    2: { complete: false, chatUrl: 'u2', phase: 'ACTIVE' },
    3: { complete: false, chatUrl: 'u3', phase: 'PAUSED' },
    4: { complete: false, chatUrl: 'u4', phase: 'ACTIVE' },
    5: { complete: false, chatUrl: 'u5', phase: 'ACTIVE' },
  };
  const blocked = new Set([2, 4, 5]);
  assert.equal(computeDesiredActiveReviewers(buckets, 2, blocked, 6), 2);
  assert.equal(countOccupiedReviewerSlots(buckets, blocked), 1);
  const candidates = selectReviewerSlotCandidates(buckets, blocked);
  assert.deepEqual(candidates, ['3', '0', '1']);
  assert.equal(candidates.includes('2') || candidates.includes('4') || candidates.includes('5'), false);
});

test('recoverable source-pack hold is not treated as completion', () => {
  const incident = {
    kind: 'NEXT_SOURCE_PACKS_REQUIRED',
    footer: {
      status: 'NORMAL',
      writesVerified: 'YES',
      blocker: 'NEXT_SOURCE_PACKS_REQUIRED',
      triggerCoordinator: 'NO',
    },
  };
  const bucketState = { complete: false, sourcePackTargetNumber: 4 };
  assert.equal(isRecoverableSourcePackHoldIncident(incident, bucketState), true);
  assert.equal(isSourcePackBoundaryFooter(incident.footer), true);
  assert.equal(isVerifiedCorpusCompletion(null, 123), false);
});

test('unavailable source-pack footer is recoverable without coordinator escalation', () => {
  const footer = {
    status: 'ERROR',
    writesVerified: 'YES',
    blocker: 'SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED',
    triggerCoordinator: 'YES',
  };
  assert.equal(isRecoverableUnavailableSourcePackFooter(footer), true);
  assert.equal(shouldEscalateFooter(footer), false);
});

test('exact-pack unavailability evidence is detected without misclassifying positive verification', () => {
  assert.equal(
    responseIndicatesSourcePackUnavailable(
      'pack_000007.jsonl is not currently visible; the available folder ends at pack_000006.jsonl.',
      'pack_000007.jsonl',
    ),
    true,
  );
  assert.equal(
    responseIndicatesSourcePackUnavailable(
      'The exact pack_000005.jsonl cannot be opened; only pack_000005.README.md is visible.',
      'pack_000005.jsonl',
    ),
    true,
  );
  assert.equal(
    responseIndicatesSourcePackUnavailable(
      'Verified the exact pack_000007.jsonl and processed all 50 cases.',
      'pack_000007.jsonl',
    ),
    false,
  );
});

test('stale awaitingActionId clears when no generation exists', () => {
  const bucketState = {
    phase: 'ACTIVE',
    awaitingResponseAt: '2026-09-15T22:00:00Z',
    awaitingActionId: 'A-old',
    lastAction: 'generating:A-old',
  };
  assert.equal(shouldClearStaleGenerationReservation({
    bucketState,
    isGenerating: false,
    stallReason: 'no visible generation',
  }), true);
});

test('active generation keeps reservation until generation ends', () => {
  const bucketState = {
    phase: 'ACTIVE',
    awaitingResponseAt: '2026-09-17T04:30:06.909Z',
    awaitingActionId: 'A-live',
    lastAction: 'generating:A-live',
  };
  assert.equal(shouldClearStaleGenerationReservation({
    bucketState,
    isGenerating: true,
    stallReason: null,
  }), false);
  assert.equal(bucketHasGenerationReservation(bucketState), true);
});

test('setup-wait ack after cleared awaiting is treated as stale generation cleanup', () => {
  const bucketState = {
    phase: 'SETUP_WAIT',
    lastMessageReceivedAt: '2026-09-17T18:56:19.850Z',
    awaitingResponseAt: null,
    lastAction: 'generating',
  };
  assert.equal(shouldClearStaleGenerationReservation({
    bucketState,
    isGenerating: false,
    stallReason: null,
  }), true);
});

test('missing browser page does not mean canonical bucket is missing', () => {
  const state = { buckets: { '3': { complete: false, chatUrl: null, phase: 'PENDING' } } };
  assert.equal(getBucketState(state, 3)?.phase, 'PENDING');
  assert.equal(bucketOccupiesReviewerSlot(getBucketState(state, 3)), false);
});

test('paused bucket with pending source pack sends continuation without controller delivery gate', () => {
  const bucketState = {
    sourcePackResumePending: true,
    sourcePackTargetNumber: 4,
    sourcePackResumeIncidentId: 'INC-B3',
    sourcePackTargetFilename: 'pack_000004.jsonl',
    sourcePackAccessVerified: false,
  };
  assert.equal(isSourcePackAccessVerified(bucketState, 4, 'INC-B3'), false);
  assert.equal(sourcePackContinuationAlreadySent(bucketState, {}, 4, 'INC-B3'), false);
});

test('unavailable source-pack response preserves target and waits for persisted retry deadline', () => {
  const bucketState = {
    phase: 'PAUSED',
    sourcePackResumePending: true,
    sourcePackTargetNumber: 4,
    sourcePackResumeIncidentId: 'INC-B3',
    sourcePackLastDeliveredNumber: 4,
    sourcePackLastDeliveredIncidentId: 'INC-B3',
    sourcePackLastDeliveredActionId: 'A-test',
    sourcePackAccessVerified: false,
    lastMessageReceivedPreview: 'BLOCKER: SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED',
    sourcePackUnavailableCount: 1,
    sourcePackRetryNotBefore: '2026-09-17T20:05:00.000Z',
  };
  const actions = {
    'A-test': { status: 'SENT', kind: 'SOURCE_PACK_CONTINUE', sentAt: '2026-09-17T20:00:00.000Z' },
  };
  assert.equal(bucketOccupiesReviewerSlot(bucketState), false);
  assert.equal(sourcePackContinuationAlreadySent(bucketState, actions, 4, 'INC-B3'), false);
  assert.equal(shouldRetrySourcePackContinuation(bucketState), true);
  assert.equal(sourcePackRetryDelayMs(1), 5 * 60 * 1000);
  assert.equal(sourcePackRetryDelayMs(2), 15 * 60 * 1000);
  assert.equal(sourcePackRetryDelayMs(3), 30 * 60 * 1000);
  assert.equal(sourcePackRetryDelayMs(4), 60 * 60 * 1000);
  assert.equal(sourcePackRetryDelayMs(9), 60 * 60 * 1000);
  assert.equal(sourcePackRetryReady(bucketState, Date.parse('2026-09-17T20:04:59.000Z')), false);
  assert.equal(sourcePackRetryReady(bucketState, Date.parse('2026-09-17T20:05:00.000Z')), true);
  const restarted = JSON.parse(JSON.stringify(bucketState));
  assert.equal(restarted.sourcePackTargetNumber, 4);
  assert.equal(restarted.sourcePackRetryNotBefore, '2026-09-17T20:05:00.000Z');
});

test('HOLD and SETUP_WAIT buckets are not ordinary reviewer-slot candidates', () => {
  assert.deepEqual(selectReviewerSlotCandidates({
    0: { complete: false, chatUrl: 'u0', phase: 'HOLD' },
    1: { complete: false, chatUrl: 'u1', phase: 'SETUP_WAIT' },
    3: { complete: false, chatUrl: 'u3', phase: 'ACTIVE' },
  }, []), ['3']);
});

test('two live or start-reserved reviewers leave no capacity for a verified setup retry', () => {
  const nowMs = Date.parse('2026-09-18T00:40:00.000Z');
  const buckets = {
    0: {
      complete: false,
      chatUrl: 'u0',
      phase: 'ACTIVE',
      awaitingActionId: 'A-live',
      awaitingResponseAt: '2026-09-18T00:39:55.000Z',
      generationSeenSinceAction: true,
    },
    1: {
      complete: false,
      chatUrl: 'u1',
      phase: 'ACTIVE',
      awaitingActionId: 'A-start',
      awaitingResponseAt: '2026-09-18T00:39:59.000Z',
      generationSeenSinceAction: false,
    },
    3: {
      complete: false,
      chatUrl: 'u3',
      chatId: 'c3',
      phase: 'SETUP_WAIT',
      setupVerified: true,
      setupVerifiedChatId: 'c3',
      awaitingActionId: null,
      awaitingResponseAt: null,
    },
  };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: buckets,
    liveGeneratingByBucket: { 0: true, 1: false, 3: false },
    nowMs,
    graceMs: 45000,
    maxActive: 2,
    bucketCount: 6,
  });
  assert.deepEqual(occupancy.liveGeneratingBuckets, [0]);
  assert.deepEqual(occupancy.dispatchStartBuckets, [1]);
  assert.equal(occupancy.occupiedSlots, 2);
  assert.equal(occupancy.availableSlots, 0);
});

test('reviewer-confirmed access is idempotent for the same exact pack and incident', () => {
  const bucketState = {
    sourcePackResumePending: false,
    sourcePackTargetNumber: 4,
    sourcePackResumeIncidentId: 'INC-B3',
    sourcePackTargetFilename: 'pack_000004.jsonl',
  };
  markSourcePackAccessVerified(bucketState, {
    targetNumber: 4,
    incidentId: 'INC-B3',
    filename: 'pack_000004.jsonl',
    requestActionId: 'A-test',
  });
  assert.equal(isSourcePackAccessVerified(bucketState, 4, 'INC-B3'), true);
  resetSourcePackAccessState(bucketState);
  assert.equal(isSourcePackAccessVerified(bucketState, 4, 'INC-B3'), false);
});

test('controller-side delivery verification is cleared on restart', () => {
  const bucketState = {
    sourcePackResumePending: true,
    sourcePackTargetNumber: 4,
    sourcePackResumeIncidentId: 'INC-B3',
    sourcePackDeliveryVerified: true,
    sourcePackDeliveryMethod: 'project-sources-upload',
    sourcePackDeliveryPath: 'data/source-packs/UPLOAD_READY/shard_3/pack_000004.jsonl',
  };
  assert.equal(clearStaleControllerSideSourcePackVerification(bucketState), true);
  assert.equal(bucketState.sourcePackDeliveryVerified, false);
  assert.equal(bucketState.sourcePackAccessVerified, false);
});

test('SOURCE_PACK_CONTINUE prompt uses connected Google Drive source and exact shard location', () => {
  const shard = sourcePackShardForBucket(3);
  const filename = sourcePackFilename(4);
  const prompt = buildSourcePackContinuationPrompt(3, {
    filename,
    folderUrl: sourcePackShardFolderUrl(shard.folderId),
  });
  assert.match(prompt, /connected Google Drive source/i);
  assert.match(prompt, /pack_000004\.jsonl/);
  assert.match(prompt, /shard_3/);
  assert.match(prompt, new RegExp(sourcePackShardFolderUrl(shard.folderId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /paginate\/continue the folder listing/i);
  assert.match(prompt, /failed exact-name Drive search is not proof/i);
  assert.match(prompt, /folder listing is fully exhausted/i);
  assert.doesNotMatch(prompt, /project sources|attached source exposure|upload/i);
});

test('NEXT_SOURCE_PACKS_REQUIRED derives exact next filename from shard mapping', () => {
  assert.equal(nextSourcePackNumber({
    startPack: SOURCE_PACK_SHARDS[3].startPack,
    incidentId: 'INC-B3-1',
    lastDeliveredNumber: 4,
    lastDeliveredIncidentId: 'INC-B3-0',
  }), 5);
  assert.equal(sourcePackFilename(5), 'pack_000005.jsonl');
  assert.equal(SOURCE_PACK_SHARDS[3].folderId, 'LOCAL_ONLY_BUCKET_3_FOLDER');
});

test('reviewer access is confirmed only from continuation responses, not controller upload', () => {
  const bucketState = {
    sourcePackTargetNumber: 4,
    sourcePackTargetFilename: 'pack_000004.jsonl',
    sourcePackResumeIncidentId: 'INC-B3',
    sourcePackLastDeliveredNumber: 4,
    sourcePackLastDeliveredActionId: 'A-test',
  };
  const footer = {
    status: 'NORMAL',
    writesVerified: 'YES',
    blocker: 'NONE',
    triggerCoordinator: 'NO',
  };
  assert.equal(reviewerConfirmedSourcePackAccess(bucketState, footer, {
    kind: 'SOURCE_PACK_CONTINUE',
    id: 'A-test',
    status: 'SENT',
    deliveryVerified: true,
  }), true);
  assert.equal(reviewerConfirmedSourcePackAccess(bucketState, {
    status: 'ERROR',
    writesVerified: 'YES',
    blocker: 'SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED',
    triggerCoordinator: 'YES',
  }, { kind: 'SOURCE_PACK_CONTINUE', id: 'A-test', status: 'SENT', deliveryVerified: true }), false);
  assert.equal(reviewerConfirmedSourcePackAccess(bucketState, footer, {
    kind: 'SOURCE_PACK_CONTINUE',
    id: 'A-other',
    status: 'SENT',
    deliveryVerified: true,
  }), false, 'response attributed to a different action cannot prove delivery');
  assert.equal(reviewerConfirmedSourcePackAccess(bucketState, footer, {
    kind: 'SOURCE_PACK_CONTINUE',
    id: 'A-test',
    status: 'SENT',
    deliveryVerified: false,
  }), false, 'unverified delivery cannot prove reviewer access');
});

test('continuation already sent when awaiting reviewer response', () => {
  const bucketState = {
    sourcePackResumePending: true,
    sourcePackTargetNumber: 4,
    sourcePackResumeIncidentId: 'INC-B3',
    sourcePackLastDeliveredNumber: 4,
    sourcePackLastDeliveredIncidentId: 'INC-B3',
    sourcePackLastDeliveredActionId: 'A-test',
    awaitingActionId: 'A-test',
    sourcePackAccessVerified: false,
  };
  const actions = {
    'A-test': { status: 'SENT', kind: 'SOURCE_PACK_CONTINUE', sentAt: '2026-09-17T20:00:00.000Z' },
  };
  assert.equal(sourcePackContinuationAlreadySent(bucketState, actions, 4, 'INC-B3'), true);
});

test('controller restart does not resubmit an already submitted source-pack continuation', () => {
  const persisted = {
    bucketState: {
      sourcePackResumePending: true,
      sourcePackTargetNumber: 4,
      sourcePackResumeIncidentId: 'INC-B3',
      sourcePackLastDeliveredNumber: 4,
      sourcePackLastDeliveredIncidentId: 'INC-B3',
      sourcePackLastDeliveredActionId: 'A-restarted',
      awaitingActionId: 'A-restarted',
      sourcePackAccessVerified: false,
    },
    actions: {
      'A-restarted': { status: 'SENT', kind: 'SOURCE_PACK_CONTINUE', sentAt: '2026-09-17T20:00:00.000Z' },
    },
  };
  const restored = JSON.parse(JSON.stringify(persisted));
  assert.equal(sourcePackContinuationAlreadySent(
    restored.bucketState,
    restored.actions,
    4,
    'INC-B3',
  ), true);
});

test('verified reviewer access permits continuation dedupe after response', () => {
  const bucketState = {
    sourcePackResumePending: false,
    sourcePackTargetNumber: 4,
    sourcePackResumeIncidentId: 'INC-B3',
    sourcePackLastDeliveredNumber: 4,
    sourcePackLastDeliveredIncidentId: 'INC-B3',
    sourcePackLastDeliveredActionId: 'A-test',
    sourcePackAccessVerified: true,
    sourcePackAccessVerifiedAt: '2026-09-17T21:00:00.000Z',
  };
  const actions = {
    'A-test': { status: 'SENT', kind: 'SOURCE_PACK_CONTINUE', sentAt: '2026-09-17T20:00:00.000Z' },
  };
  assert.equal(sourcePackContinuationAlreadySent(bucketState, actions, 4, 'INC-B3'), true);
});

test('wrong pack filename cannot satisfy exact-pack requirement', () => {
  assert.equal(exactSourcePackFilenameMatches('pack_000005.jsonl', 4), false);
  assert.equal(exactSourcePackFilenameMatches('pack_000004.jsonl', 4), true);
  assert.equal(sourcePackFilename(4), 'pack_000004.jsonl');
});

test('next required pack derives generically after a later boundary incident', () => {
  assert.equal(nextSourcePackNumber({
    startPack: 4,
    incidentId: 'INC-B3-2',
    lastDeliveredNumber: 4,
    lastDeliveredIncidentId: 'INC-B3-1',
  }), 5);
  assert.equal(sourcePackFilename(5), 'pack_000005.jsonl');
});

test('controller restart preserves pending continuation state but clears stale controller-side verification', () => {
  const bucketState = {
    sourcePackResumePending: true,
    sourcePackTargetNumber: 4,
    sourcePackResumeIncidentId: 'INC-B3',
    sourcePackDeliveryVerified: true,
    sourcePackDeliveryMethod: 'project-sources-upload',
    lastMessageReceivedPreview: 'returns no pack_000004.jsonl object under the specified shard_3 folder',
  };
  assert.equal(shouldRetrySourcePackContinuation(bucketState), true);
  clearStaleControllerSideSourcePackVerification(bucketState);
  resetSourcePackAccessState(bucketState);
  assert.equal(bucketState.sourcePackResumePending, true);
  assert.equal(bucketState.sourcePackTargetNumber, 4);
});

test('source-pack waiter does not reserve reviewer capacity', () => {
  const bucketState = {
    phase: 'PAUSED',
    chatUrl: 'https://chatgpt.com/c/test',
    sourcePackResumePending: true,
    awaitingResponseAt: null,
    lastAction: 'paused-awaiting-source-pack-continuation',
  };
  assert.equal(bucketOccupiesReviewerSlot(bucketState), false);
  assert.equal(bucketReclaimableIdleSlot({ ...bucketState, phase: 'ACTIVE' }), true);
});

test('paused bucket without pending source pack remains eligible for reviewer slot selection', () => {
  const buckets = {
    1: { complete: false, chatUrl: 'u1', phase: 'ACTIVE', awaitingResponseAt: null },
    3: {
      complete: false,
      chatUrl: 'u3',
      phase: 'PAUSED',
      sourcePackResumePending: false,
      sourcePackAccessVerified: true,
      awaitingResponseAt: null,
      awaitingActionId: null,
    },
  };
  assert.deepEqual(selectReviewerSlotCandidates(buckets, []), ['3', '1']);
});

test('null cursor never coerces to pack 0', () => {
  assert.equal(parseSourcePackNumber(null, 1), null);
  assert.equal(parseSourcePackNumber(undefined, 1), null);
  assert.equal(parseSourcePackNumber('', 1), null);
  assert.equal(parseSourcePackNumber(Number.NaN, 1), null);
  assert.equal(parseSourcePackNumber('not-a-pack', 1), null);
  const resolved = resolveNextSourcePackTargetNumber(1, {
    bucketState: { sourcePackTargetNumber: null, casesReported: 7 },
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: { status: 'NORMAL', writesVerified: 'YES', blocker: 'NEXT_SOURCE_PACKS_REQUIRED', triggerCoordinator: 'NO' } },
  });
  assert.notEqual(resolved.targetNumber, 0);
  assert.notEqual(sourcePackFilename(resolved.targetNumber, 1), 'pack_000000.jsonl');
});

test('B5 conservative reconciliation proves the safe next pack 33 boundary', () => {
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'reconciliation-evidence.json'), 'utf8'));
  const result = validateConservativeSourcePackBoundary(5, record, {
    expectedAuditablePopulation: 65720,
  });
  assert.equal(result.valid, true);
  assert.equal(result.nextPack, 33);
  assert.equal(result.nextFilename, 'pack_000033.jsonl');
  assert.equal(result.terminalThroughPack, 32);
});

test('B4 indexed pack gap remains protected and cannot become a conservative resume', () => {
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'reconciliation-evidence.json'), 'utf8'));
  const b4 = JSON.parse(JSON.stringify(record));
  b4.buckets['4'] = {
    ...b4.buckets['4'],
    decision: 'CONSERVATIVE_RESUME',
    reconciliationId: 'R433-B4-UNSAFE',
    nextPack: 6,
    nextFilename: 'pack_000006.jsonl',
    boundary: { firstPack: 1, terminalThroughPack: 5, nextPack: 6 },
    terminalPrefix: { startPack: 1, endPack: 5 },
    packIndexPrefix: { startPack: 1, endPack: 5, recordCount: 850, registryTerminalCount: 841, missingTerminalCount: 9 },
    contentScan: { startPack: 18, endPack: 213, recordCount: 9795, validRecordCount: 9795, terminalRecordCount: 2750, pendingRecordCount: 7045, malformedRecordCount: 0, duplicateRecordCount: 0, ownershipMismatchCount: 0 },
    registry: { registryTerminalSetAuthoritative: true, terminalRowsChanged: 0, substantiveFieldsChanged: 0, skipTerminalStableIds: true, overwriteTerminalRows: false, readbackVerifyNewWrites: true, fullCorpusReconciled: false, actionAwareCursorProven: false, boundaryMonotonic: true },
  };
  const result = validateConservativeSourcePackBoundary(4, b4, {
    expectedAuditablePopulation: 65720,
  });
  assert.equal(result.valid, false);
  assert.ok(result.failures.includes('pack-index-missing-terminal'));
});

test('invalid persisted zero cursor is rejected for bucket 1', () => {
  assert.equal(parseSourcePackNumber(0, 1), null);
  assert.equal(isValidSourcePackNumber(1, 0), false);
  assert.equal(sourcePackFilename(0, 1), null);
  assert.equal(isInvalidZeroSourcePackFilename('pack_000000.jsonl'), true);
  const bucketState = {
    sourcePackTargetNumber: 0,
    sourcePackTargetFilename: 'pack_000000.jsonl',
    sourcePackLastDeliveredNumber: 0,
  };
  sanitizeStoredSourcePackCursorFields(1, bucketState);
  assert.equal(bucketState.sourcePackTargetNumber, null);
  assert.equal(bucketState.sourcePackTargetFilename, null);
  assert.equal(bucketState.sourcePackLastDeliveredNumber, null);
});

test('bucket startPack provides lower bound when no pack has been consumed', () => {
  assert.equal(nextSourcePackNumber({
    startPack: SOURCE_PACK_SHARDS[1].startPack,
    lastDeliveredNumber: null,
    bucket: 1,
  }), 2);
  assert.equal(nextSourcePackNumber({
    startPack: SOURCE_PACK_SHARDS[1].startPack,
    lastDeliveredNumber: 0,
    bucket: 1,
  }), 2);
});

test('valid last-consumed pack derives the next pack without replay', () => {
  assert.equal(nextSourcePackNumber({
    startPack: 2,
    incidentId: 'INC-B1-2',
    lastDeliveredNumber: 6,
    lastDeliveredIncidentId: 'INC-B1-1',
    bucket: 1,
  }), 7);
});

test('visible-through reviewer evidence resolves the next pack for bucket 1', () => {
  const resolved = resolveNextSourcePackTargetNumber(1, {
    bucketState: {
      sourcePackTargetNumber: null,
      sourcePackLastDeliveredNumber: null,
      sourcePackResumeIncidentId: 'INC-B1',
    },
    incident: {
      id: 'INC-B1',
      kind: 'NEXT_SOURCE_PACKS_REQUIRED',
      footer: { status: 'NORMAL', writesVerified: 'YES', blocker: 'NEXT_SOURCE_PACKS_REQUIRED', triggerCoordinator: 'NO' },
    },
    responseText: 'Visible Bucket 1 source packs extend through pack_000006.jsonl, so this is not source-pack exhaustion.',
  });
  assert.equal(resolved.targetNumber, 7);
  assert.equal(resolved.reason, 'visible-through-plus-one');
});

test('already-consumed pack is not replayed when explicit target remains valid', () => {
  const resolved = resolveNextSourcePackTargetNumber(1, {
    bucketState: {
      sourcePackTargetNumber: 7,
      sourcePackTargetFilename: 'pack_000007.jsonl',
      sourcePackLastDeliveredNumber: 6,
    },
    incident: { id: 'INC-B1', kind: 'NEXT_SOURCE_PACKS_REQUIRED' },
  });
  assert.equal(resolved.targetNumber, 7);
  assert.equal(resolved.reason, 'explicit-target');
});

test('legacy case totals and unproven shard start values cannot bootstrap a source-pack cursor', () => {
  const resolved = resolveNextSourcePackTargetNumber(2, {
    bucketState: {
      sourcePackTargetNumber: null,
      sourcePackLastConsumedNumber: null,
      sourcePackLastVisibleNumber: null,
      sourcePackLastDeliveredNumber: null,
      sourcePackLastDeliveredAt: null,
      sourcePackLastDeliveredIncidentId: null,
      sourcePackLastDeliveredActionId: null,
      casesReported: 4175,
    },
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED' },
  });
  assert.equal(resolved.targetNumber, null);
  assert.equal(resolved.reason, 'SOURCE_PACK_CURSOR_UNRESOLVED');
});

test('delivery evidence keeps a lost source-pack cursor unresolved', () => {
  const resolved = resolveNextSourcePackTargetNumber(1, {
    bucketState: {
      sourcePackTargetNumber: null,
      sourcePackLastDeliveredNumber: null,
      casesReported: 7,
      sourcePackLastDeliveredAt: '2026-09-19T00:00:00.000Z',
      sourcePackLastDeliveredIncidentId: 'INC-B1-prior',
    },
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED' },
  });
  assert.equal(resolved.targetNumber, null);
  assert.equal(resolved.reason, 'SOURCE_PACK_CURSOR_UNRESOLVED');
});

test('inventory boundary is distinct from numeric source-pack validity', () => {
  assert.equal(isSourcePackBeyondInventory(7, 7), false);
  assert.equal(isSourcePackBeyondInventory(8, 7), true);
  assert.equal(isSourcePackBeyondInventory(null, 7), false);
  assert.equal(isSourcePackBeyondInventory(8, null), false);
});

test('filename generation rejects invalid cursors and never emits pack zero', () => {
  assert.equal(sourcePackFilename(0, 1), null);
  assert.equal(sourcePackFilename(Number.NaN, 1), null);
  assert.equal(sourcePackFilename('not-a-pack', 1), null);
  assert.equal(sourcePackFilename(1, 1), 'pack_000001.jsonl');
  assert.equal(packNumberFromFilename('pack_000000.jsonl', 1), null);
});

test('B1 historical invalid zero state migrates to unresolved without emitting pack 0', () => {
  const bucketState = {
    sourcePackTargetNumber: 0,
    sourcePackTargetFilename: 'pack_000000.jsonl',
    sourcePackLastDeliveredNumber: 0,
    sourcePackLastDeliveredIncidentId: 'INC-B1',
    sourcePackResumeIncidentId: 'INC-B1',
    sourcePackResumePending: true,
    casesReported: 7,
  };
  sanitizeStoredSourcePackCursorFields(1, bucketState);
  const resolved = resolveNextSourcePackTargetNumber(1, {
    bucketState,
    incident: { id: 'INC-B1', kind: 'NEXT_SOURCE_PACKS_REQUIRED' },
  });
  assert.notEqual(resolved.targetNumber, 0);
  assert.notEqual(sourcePackFilename(resolved.targetNumber, 1), 'pack_000000.jsonl');
});

test('other buckets remain unaffected by bucket 1 zero-cursor sanitization', () => {
  const bucket3 = {
    sourcePackTargetNumber: 4,
    sourcePackTargetFilename: 'pack_000004.jsonl',
    sourcePackLastDeliveredNumber: 4,
  };
  sanitizeStoredSourcePackCursorFields(3, bucket3);
  assert.equal(bucket3.sourcePackTargetNumber, 4);
  assert.equal(bucket3.sourcePackTargetFilename, 'pack_000004.jsonl');
});

test('two-reviewer scheduler remains capped after cursor validation changes', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE' },
    1: { complete: false, chatUrl: 'u1', phase: 'PAUSED', sourcePackResumePending: true },
    3: { complete: false, chatUrl: 'u3', phase: 'ACTIVE' },
  };
  assert.equal(computeDesiredActiveReviewers(buckets, 2, [], 6), 2);
  assert.equal(countOccupiedReviewerSlots(buckets, []), 2);
});
