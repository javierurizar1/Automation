import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceSourcePackAfterBoundary,
  bucketHasDispatchStartReservation,
  bucketHasGenerationReservation,
  bucketHasUnresolvedAwaitingAction,
  bucketBlocksCandidateActivation,
  isValidSourcePackNumber,
  parseSourcePackNumber,
  resolveNextSourcePackTargetNumber,
  selectReviewerSlotCandidates,
  sourcePackFilename,
  SOURCE_PACK_SHARDS,
} from '../src/protocol.mjs';

const blocked = new Set([2, 4, 5]);
const graceMs = 45000;
const nowMs = Date.parse('2026-01-01T00:00:00.000Z');

function boundaryFooter() {
  return {
    status: 'NORMAL',
    newCases: 0,
    writesVerified: 'YES',
    blocker: 'NEXT_SOURCE_PACKS_REQUIRED',
    triggerCoordinator: 'NO',
  };
}

function makeB3BoundaryState(overrides = {}) {
  return {
    complete: false,
    chatUrl: 'https://chatgpt.com/c/b3',
    phase: 'ACTIVE',
    awaitingActionId: null,
    awaitingResponseAt: null,
    processedHash: 'fixturehash001',
    lastAction: 'generating:A-TEST-1',
    sourcePackTargetNumber: 4,
    sourcePackTargetFilename: 'pack_000004.jsonl',
    sourcePackLastDeliveredNumber: 4,
    sourcePackLastDeliveredIncidentId: 'INC-TEST-B3-01',
    sourcePackResumeIncidentId: 'INC-TEST-B3-01',
    sourcePackAccessVerified: true,
    sourcePackResumePending: false,
    sourcePackBoundaryResponsePreview: 'Verified pack_000004.jsonl; sample records are already terminalized.',
    ...overrides,
  };
}

test('sample target 4 + valid NEXT_SOURCE_PACKS_REQUIRED advances to target 5', () => {
  const bucketState = makeB3BoundaryState();
  const result = advanceSourcePackAfterBoundary(3, bucketState, {
    incidentId: 'INC-TEST-B3-01',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
    responseText: bucketState.sourcePackBoundaryResponsePreview,
  });
  assert.equal(result.ok, true);
  assert.equal(result.consumed, 4);
  assert.equal(result.nextPack, 5);
  assert.equal(bucketState.sourcePackTargetNumber, 5);
});

test('NEXT_SOURCE_PACKS_REQUIRED cannot advance past an explicitly unavailable current pack', () => {
  const bucketState = {
    sourcePackTargetNumber: 7,
    sourcePackTargetFilename: 'pack_000007.jsonl',
    sourcePackLastConsumedNumber: 6,
    sourcePackLastDeliveredNumber: 7,
    sourcePackResumeIncidentId: 'INC-B1',
    sourcePackResumePending: false,
  };
  const result = advanceSourcePackAfterBoundary(1, bucketState, {
    incidentId: 'INC-B1',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
    responseText: 'pack_000007.jsonl is not currently visible; the available folder ends at pack_000006.jsonl.',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'current-pack-unavailable');
  assert.equal(bucketState.sourcePackTargetNumber, 7);
  assert.equal(bucketState.sourcePackTargetFilename, 'pack_000007.jsonl');
  assert.equal(bucketState.sourcePackLastConsumedNumber, 6);
});

test('sourcePackResumePending becomes true after boundary advance', () => {
  const bucketState = makeB3BoundaryState();
  advanceSourcePackAfterBoundary(3, bucketState, {
    incidentId: 'INC-B3',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
    responseText: 'pack_000004.jsonl exhausted',
  });
  assert.equal(bucketState.sourcePackResumePending, true);
});

test('sourcePackAccessVerified resets false for next pack', () => {
  const bucketState = makeB3BoundaryState();
  advanceSourcePackAfterBoundary(3, bucketState, {
    incidentId: 'INC-B3',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
    responseText: 'pack_000004.jsonl exhausted',
  });
  assert.equal(bucketState.sourcePackAccessVerified, false);
  assert.equal(bucketState.sourcePackAccessVerifiedAt, null);
});

test('sample pack is not resent after its boundary response', () => {
  const bucketState = makeB3BoundaryState();
  advanceSourcePackAfterBoundary(3, bucketState, {
    incidentId: 'INC-B3',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
    responseText: 'pack_000004.jsonl exhausted',
  });
  assert.notEqual(bucketState.sourcePackTargetNumber, 4);
  assert.equal(bucketState.sourcePackTargetFilename, 'pack_000005.jsonl');
});

test('exact next filename is pack_000005.jsonl for bucket 3', () => {
  const bucketState = makeB3BoundaryState();
  advanceSourcePackAfterBoundary(3, bucketState, {
    incidentId: 'INC-B3',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
    responseText: 'pack_000004.jsonl exhausted',
  });
  assert.equal(bucketState.sourcePackTargetFilename, 'pack_000005.jsonl');
});

test('progression is generic: target N derives correct next valid target', () => {
  for (const [bucket, shard] of Object.entries(SOURCE_PACK_SHARDS)) {
    if (Number(bucket) === 2 || Number(bucket) === 4 || Number(bucket) === 5) continue;
    const current = shard.startPack;
    const next = current + 1;
    if (!isValidSourcePackNumber(Number(bucket), next)) continue;
    const bucketState = {
      sourcePackTargetNumber: current,
      sourcePackTargetFilename: sourcePackFilename(current, Number(bucket)),
      sourcePackLastDeliveredNumber: current,
      sourcePackAccessVerified: true,
    };
    const result = advanceSourcePackAfterBoundary(Number(bucket), bucketState, {
      incidentId: `INC-B${bucket}`,
      incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
      responseText: `${sourcePackFilename(current, Number(bucket))} exhausted`,
    });
    assert.equal(result.ok, true, `bucket ${bucket} should advance from ${current}`);
    assert.equal(result.nextPack, next);
  }
});

test('invalid/missing current target does not silently invent pack 0', () => {
  const bucketState = {
    sourcePackTargetNumber: null,
    sourcePackTargetFilename: null,
    sourcePackLastDeliveredNumber: null,
    sourcePackLastConsumedNumber: null,
    casesReported: 100,
  };
  const result = advanceSourcePackAfterBoundary(3, bucketState, {
    incidentId: 'INC-B3',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-current-pack');
  assert.notEqual(bucketState.sourcePackTargetNumber, 0);
});

test('shard lower bound remains enforced after boundary advance', () => {
  const bucket = 1;
  const startPack = SOURCE_PACK_SHARDS[bucket].startPack;
  const bucketState = {
    sourcePackTargetNumber: startPack,
    sourcePackTargetFilename: sourcePackFilename(startPack, bucket),
    sourcePackLastDeliveredNumber: startPack,
    sourcePackAccessVerified: true,
  };
  const result = advanceSourcePackAfterBoundary(bucket, bucketState, {
    incidentId: 'INC-B1',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
    responseText: sourcePackFilename(startPack, bucket),
  });
  assert.equal(result.ok, true);
  assert.equal(result.nextPack, startPack + 1);
  assert.equal(isValidSourcePackNumber(bucket, result.nextPack), true);
  assert.equal(parseSourcePackNumber(0, bucket), null);
});

test('awaitingActionId=null + stale lastAction=generating:old => bucketHasGenerationReservation=false', () => {
  const bucketState = makeB3BoundaryState();
  assert.equal(bucketHasGenerationReservation(bucketState), false);
});

test('unresolved awaitingActionId keeps candidate blocked', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u1',
    phase: 'ACTIVE',
    awaitingResponseAt: '2026-09-17T22:02:17.158Z',
    awaitingActionId: 'A-TEST-1',
    lastAction: 'generating:A-TEST-1',
  };
  assert.equal(bucketHasUnresolvedAwaitingAction(bucketState), true);
  assert.equal(bucketBlocksCandidateActivation(bucketState), true);
  assert.equal(bucketHasGenerationReservation(bucketState), true);
  assert.deepEqual(selectReviewerSlotCandidates({ 1: bucketState }, blocked), []);
});

test('short dispatch-start reservation still reserves capacity correctly', () => {
  const bucketState = {
    complete: false,
    awaitingResponseAt: '2026-09-17T22:09:50.000Z',
    awaitingActionId: 'A-start',
    generationSeenSinceAction: false,
  };
  assert.equal(bucketHasDispatchStartReservation(bucketState, { nowMs, graceMs, isLiveGenerating: false }), true);
  assert.equal(bucketHasGenerationReservation(bucketState, { nowMs, graceMs }), true);
});

test('B3 reproduction: boundary response processed yields dispatchable continuation state', () => {
  const bucketState = makeB3BoundaryState();
  const result = advanceSourcePackAfterBoundary(3, bucketState, {
    incidentId: 'INC-TEST-B3-01',
    incident: { kind: 'NEXT_SOURCE_PACKS_REQUIRED', footer: boundaryFooter() },
    responseText: bucketState.sourcePackBoundaryResponsePreview,
  });
  assert.equal(result.ok, true);
  assert.equal(bucketState.awaitingActionId, null);
  assert.equal(bucketHasGenerationReservation(bucketState), false);
  assert.equal(bucketState.sourcePackTargetNumber, 5);
  assert.equal(bucketState.sourcePackResumePending, true);
  assert.deepEqual(selectReviewerSlotCandidates({ 3: bucketState }, blocked), ['3']);

  const resolved = resolveNextSourcePackTargetNumber(3, {
    bucketState,
    incidentId: bucketState.sourcePackResumeIncidentId,
  });
  assert.equal(resolved.targetNumber, 5);
  assert.equal(resolved.reason, 'explicit-target');
});
