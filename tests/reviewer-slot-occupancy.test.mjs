import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketBlocksCandidateActivation,
  bucketHasDispatchStartReservation,
  bucketHasUnresolvedAwaitingAction,
  bucketOccupiesLiveReviewerSlot,
  buildLiveReviewerOccupancy,
  selectReviewerSlotCandidates,
} from '../src/protocol.mjs';

const blocked = new Set([2, 4, 5]);
const graceMs = 45000;
const nowMs = Date.parse('2026-09-17T22:10:00.000Z');

test('phase ACTIVE with live generation occupies one reviewer slot', () => {
  const bucketState = {
    complete: false,
    awaitingResponseAt: '2026-09-17T22:09:00.000Z',
    awaitingActionId: 'A-live',
    generationSeenSinceAction: true,
  };
  assert.equal(bucketOccupiesLiveReviewerSlot(bucketState, { isLiveGenerating: true, nowMs, graceMs }), true);
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: { 0: bucketState },
    liveGeneratingByBucket: { 0: true },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
    bucketCount: 6,
  });
  assert.equal(occupancy.activeReviewers, 1);
  assert.equal(occupancy.scheduledReviewers, 1);
});

test('unresolved action stays outside live count but reserves scheduler capacity', () => {
  const bucketState = {
    complete: false,
    awaitingResponseAt: '2026-09-17T22:02:17.158Z',
    awaitingActionId: 'A-TEST-1',
    generationSeenSinceAction: true,
    generationObservedAt: '2026-09-17T22:02:29.711Z',
  };
  assert.equal(bucketOccupiesLiveReviewerSlot(bucketState, { isLiveGenerating: false, nowMs, graceMs }), false);
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: { 0: { complete: false }, 1: bucketState },
    liveGeneratingByBucket: { 0: true, 1: false },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
    bucketCount: 6,
  });
  assert.equal(occupancy.activeReviewers, 1);
  assert.equal(occupancy.scheduledReviewers, 2);
  assert.equal(occupancy.availableSlots, 0);
  assert.deepEqual(occupancy.awaitingResponseBuckets, [1]);
});

test('unresolved awaitingActionId blocks duplicate dispatch for the same bucket', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u1',
    phase: 'ACTIVE',
    awaitingResponseAt: '2026-09-17T22:02:17.158Z',
    awaitingActionId: 'A-TEST-1',
  };
  assert.equal(bucketHasUnresolvedAwaitingAction(bucketState), true);
  assert.equal(bucketBlocksCandidateActivation(bucketState), true);
  assert.deepEqual(selectReviewerSlotCandidates({ 1: bucketState }, blocked), []);
});

test('scheduling-blocked ACTIVE bucket does not consume scheduler slot when not live', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u2',
    phase: 'ACTIVE',
    awaitingResponseAt: null,
  };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: { 2: bucketState },
    liveGeneratingByBucket: { 2: false },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
    bucketCount: 6,
  });
  assert.equal(occupancy.scheduledReviewers, 0);
});

test('PAUSED bucket does not consume slot merely because awaitingActionId exists', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u3',
    phase: 'PAUSED',
    awaitingResponseAt: '2026-09-17T21:28:32.840Z',
    awaitingActionId: 'A-TEST-2',
    generationSeenSinceAction: true,
  };
  assert.equal(bucketOccupiesLiveReviewerSlot(bucketState, { isLiveGenerating: false, nowMs, graceMs }), false);
});

test('newly dispatched prompt temporarily reserves one slot until generation becomes observable', () => {
  const bucketState = {
    complete: false,
    awaitingResponseAt: '2026-09-17T22:09:50.000Z',
    awaitingActionId: 'A-start',
    generationSeenSinceAction: false,
  };
  assert.equal(bucketHasDispatchStartReservation(bucketState, { nowMs, graceMs, isLiveGenerating: false }), true);
  assert.equal(bucketOccupiesLiveReviewerSlot(bucketState, { isLiveGenerating: false, nowMs, graceMs }), true);
});

test('live-only helper reports generation ended while unresolved action remains a scheduler reservation', () => {
  const bucketState = {
    complete: false,
    awaitingResponseAt: '2026-09-17T22:02:17.158Z',
    awaitingActionId: 'A-TEST-1',
    generationSeenSinceAction: true,
    generationObservedAt: '2026-09-17T22:02:29.711Z',
  };
  assert.equal(bucketHasDispatchStartReservation(bucketState, { nowMs, graceMs, isLiveGenerating: false }), false);
  assert.equal(bucketOccupiesLiveReviewerSlot(bucketState, { isLiveGenerating: false, nowMs, graceMs }), false);
});

test('total live/start reservations never exceeds configured max in occupancy math', () => {
  const buckets = {
    0: {
      complete: false,
      awaitingResponseAt: '2026-09-17T22:09:00.000Z',
      awaitingActionId: 'A0',
      generationSeenSinceAction: false,
    },
    1: {
      complete: false,
      awaitingResponseAt: '2026-09-17T22:09:20.000Z',
      awaitingActionId: 'A1',
      generationSeenSinceAction: false,
    },
    3: {
      complete: false,
      chatUrl: 'u3',
      phase: 'PAUSED',
      sourcePackResumePending: false,
    },
  };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: buckets,
    liveGeneratingByBucket: { 0: true, 1: false },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
    bucketCount: 6,
  });
  assert.equal(occupancy.scheduledReviewers, 2);
  assert.equal(occupancy.occupiedSlots, 2);
  assert.equal(occupancy.availableSlots, 0);
});

test('PAUSED bucket with completed outstanding response becomes candidate after awaiting clears', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE', awaitingResponseAt: null },
    1: {
      complete: false,
      chatUrl: 'u1',
      phase: 'ACTIVE',
      awaitingResponseAt: '2026-09-17T22:02:17.158Z',
      awaitingActionId: 'A-TEST-1',
    },
    3: {
      complete: false,
      chatUrl: 'u3',
      phase: 'PAUSED',
      sourcePackResumePending: false,
      awaitingResponseAt: null,
      awaitingActionId: null,
    },
  };
  assert.deepEqual(selectReviewerSlotCandidates(buckets, blocked), ['3', '0']);
});

test('HOLD bucket with awaiting remains blocked from candidate activation until awaiting clears', () => {
  const buckets = {
    3: {
      complete: false,
      chatUrl: 'u3',
      phase: 'HOLD',
      awaitingResponseAt: '2026-09-17T21:28:32.840Z',
      awaitingActionId: 'A-TEST-2',
    },
  };
  assert.deepEqual(selectReviewerSlotCandidates(buckets, blocked), []);
});

test('scheduling-blocked bucket with awaiting is excluded from live occupancy but not from reconciliation eligibility conceptually', () => {
  const buckets = {
    2: {
      complete: false,
      chatUrl: 'u2',
      phase: 'ACTIVE',
      awaitingResponseAt: '2026-09-17T22:00:00.000Z',
      awaitingActionId: 'A2',
      generationSeenSinceAction: true,
    },
  };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: buckets,
    liveGeneratingByBucket: { 2: false },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
    bucketCount: 6,
  });
  assert.equal(occupancy.scheduledReviewers, 0);
});

test('B0 live + B1 unresolved/non-live + B3 runnable keeps the stale generation slot reserved', () => {
  const buckets = {
    0: {
      complete: false,
      chatUrl: 'u0',
      phase: 'ACTIVE',
      awaitingResponseAt: '2026-09-17T21:52:11.007Z',
      awaitingActionId: 'A-TEST-3',
      generationSeenSinceAction: true,
    },
    1: {
      complete: false,
      chatUrl: 'u1',
      phase: 'ACTIVE',
      awaitingResponseAt: '2026-09-17T22:02:17.158Z',
      awaitingActionId: 'A-TEST-1',
      generationSeenSinceAction: true,
    },
    3: {
      complete: false,
      chatUrl: 'u3',
      phase: 'PAUSED',
      sourcePackResumePending: false,
      awaitingResponseAt: null,
      awaitingActionId: null,
    },
  };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: buckets,
    liveGeneratingByBucket: { 0: true, 1: false, 3: false },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
    bucketCount: 6,
  });
  assert.equal(occupancy.activeReviewers, 1);
  assert.equal(occupancy.scheduledReviewers, 2);
  assert.equal(occupancy.availableSlots, 0);
  assert.deepEqual(occupancy.awaitingResponseBuckets, [1]);
  assert.deepEqual(selectReviewerSlotCandidates(buckets, blocked), ['3']);
});

test('B1 awaiting/non-live is not a slot-fill candidate', () => {
  const buckets = {
    1: {
      complete: false,
      chatUrl: 'u1',
      phase: 'ACTIVE',
      awaitingResponseAt: '2026-09-17T22:02:17.158Z',
      awaitingActionId: 'A-TEST-1',
    },
  };
  assert.deepEqual(selectReviewerSlotCandidates(buckets, blocked), []);
});

test('candidate failure still falls through to the next eligible bucket', () => {
  const buckets = {
    0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE', awaitingResponseAt: null },
    1: { complete: false, chatUrl: null, phase: 'PENDING' },
    3: {
      complete: false,
      chatUrl: 'u3',
      phase: 'PAUSED',
      sourcePackResumePending: false,
      awaitingResponseAt: null,
    },
  };
  assert.deepEqual(selectReviewerSlotCandidates(buckets, blocked), ['3', '0', '1']);
});

test('scheduler occupancy never counts more than two live/start reservations', () => {
  const buckets = {
    0: {
      complete: false,
      awaitingResponseAt: '2026-09-17T22:09:50.000Z',
      awaitingActionId: 'A0',
      generationSeenSinceAction: false,
    },
    1: {
      complete: false,
      awaitingResponseAt: '2026-09-17T22:09:55.000Z',
      awaitingActionId: 'A1',
      generationSeenSinceAction: false,
    },
    3: {
      complete: false,
      awaitingResponseAt: '2026-09-17T22:09:58.000Z',
      awaitingActionId: 'A3',
      generationSeenSinceAction: false,
    },
  };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: buckets,
    liveGeneratingByBucket: { 0: true, 1: false, 3: false },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
    bucketCount: 6,
  });
  assert.equal(occupancy.scheduledReviewers, 3);
  assert.equal(occupancy.occupiedSlots, 2);
  assert.equal(occupancy.availableSlots, 0);
});
