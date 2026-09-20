import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSchedulerHealth,
  buildBucketOperationsView,
  buildOperationsStatus,
  computeThroughputMetrics,
  deriveOperationalState,
  normalizeOperationsState,
  recordAuditProgressEvent,
  recordActivityEvent,
  PROGRESS_EVENT_MAX_COUNT,
  THROUGHPUT_WINDOWS_MS,
} from '../src/operations.mjs';
import {
  bucketBlocksCandidateActivation,
  bucketHasDispatchStartReservation,
  bucketHasGenerationReservation,
  bucketHasUnresolvedAwaitingAction,
  bucketOccupiesLiveReviewerSlot,
  buildLiveReviewerOccupancy,
} from '../src/protocol.mjs';

const blocked = [2, 4, 5];
const graceMs = 45000;
const nowMs = Date.now();

function makeState(overrides = {}) {
  return normalizeOperationsState({
    buckets: {
      0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE', awaitingResponseAt: null },
      1: {
        complete: false,
        chatUrl: 'u1',
        phase: 'ACTIVE',
        awaitingResponseAt: '2026-09-17T22:02:17.158Z',
        awaitingActionId: 'A-TEST-2',
        generationSeenSinceAction: true,
      },
      3: {
        complete: false,
        chatUrl: 'u3',
        phase: 'ACTIVE',
        sourcePackResumePending: false,
        sourcePackTargetNumber: 5,
        sourcePackTargetFilename: 'pack_000005.jsonl',
      },
    },
    metrics: {
      casesReported: 100,
      progressBasis: 'sum of accepted NEW_CASES footer values observed by this controller',
      progressEvents: [],
      activityEvents: [],
    },
    ...overrides,
  });
}

test('workflow ACTIVE != live reviewer', () => {
  const bucketState = { complete: false, chatUrl: 'u1', phase: 'ACTIVE', awaitingResponseAt: '2026-09-17T22:02:17.158Z', awaitingActionId: 'A1' };
  assert.equal(deriveOperationalState({ bucket: 1, bucketState, isLiveGenerating: false }), 'WAITING_RESPONSE');
  assert.equal(bucketOccupiesLiveReviewerSlot(bucketState, { isLiveGenerating: false, nowMs, graceMs }), false);
});

test('CDP live generation increments liveReviewerGenerations', () => {
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: { 0: { complete: false }, 3: { complete: false } },
    liveGeneratingByBucket: { 0: true, 3: true },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
  });
  assert.equal(occupancy.activeReviewers, 2);
});

test('NEW_CASES > 0 records progress event', () => {
  const state = makeState();
  assert.equal(recordAuditProgressEvent(state, {
    bucket: 3,
    actionId: 'A1',
    newCases: 31,
    writesVerified: 'YES',
    sourcePack: 'pack_000005.jsonl',
    at: new Date(nowMs - 120000).toISOString(),
  }), true);
  assert.equal(state.metrics.progressEvents.length, 1);
  assert.equal(state.buckets[3].lastProgressNewCases, 31);
});

test('NEW_CASES=0 source-pack verification does not count as audit progress', () => {
  const state = makeState();
  assert.equal(recordAuditProgressEvent(state, {
    bucket: 3,
    actionId: 'A2',
    newCases: 0,
    writesVerified: 'YES',
    at: new Date(nowMs).toISOString(),
  }), false);
  assert.equal(state.metrics.progressEvents.length, 0);
  recordActivityEvent(state, { bucket: 3, kind: 'SOURCE_PACK_BOUNDARY', summary: 'sample pack exhausted, 0 new cases' });
  assert.equal(state.metrics.activityEvents.length, 1);
});

test('5/15/60 minute throughput windows calculate correctly', () => {
  const state = makeState();
  recordAuditProgressEvent(state, { bucket: 0, newCases: 10, at: new Date(nowMs - 2 * 60 * 1000).toISOString() });
  recordAuditProgressEvent(state, { bucket: 3, newCases: 20, at: new Date(nowMs - 10 * 60 * 1000).toISOString() });
  recordAuditProgressEvent(state, { bucket: 1, newCases: 30, at: new Date(nowMs - 45 * 60 * 1000).toISOString() });
  const throughput = computeThroughputMetrics(state, nowMs);
  assert.equal(throughput.newCasesLast5m, 10);
  assert.equal(throughput.newCasesLast15m, 30);
  assert.equal(throughput.newCasesLast60m, 60);
  assert.deepEqual(throughput.progressingBuckets15m.sort(), [0, 3]);
});

test('lastProgressAt updates only on real progress', () => {
  const state = makeState();
  recordActivityEvent(state, { bucket: 0, kind: 'SOURCE_PACK_CONTINUE', summary: 'sent pack' });
  assert.equal(state.buckets[0]?.lastProgressAt, undefined);
  recordAuditProgressEvent(state, { bucket: 0, newCases: 5, at: new Date(nowMs).toISOString() });
  assert.ok(state.buckets[0].lastProgressAt);
  assert.equal(state.metrics.lastProgressAt, state.buckets[0].lastProgressAt);
});

test('scheduling-blocked ACTIVE bucket does not count as reviewer or progress candidate', () => {
  const state = makeState({
    buckets: {
      2: { complete: false, chatUrl: 'u2', phase: 'ACTIVE' },
    },
  });
  const ops = buildOperationsStatus({
    state,
    occupancy: buildLiveReviewerOccupancy({
      bucketStates: state.buckets,
      liveGeneratingByBucket: { 2: true },
      excludedBuckets: blocked,
      nowMs,
      graceMs,
      maxActive: 2,
    }),
    liveGeneratingByBucket: { 2: true },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
  });
  assert.equal(ops.buckets[2].operationalState, 'BLOCKED');
  assert.equal(ops.buckets[2].schedulingBlocked, true);
});

test('available slot + runnable bucket → schedulerUnderutilized=true until activation', () => {
  const state = makeState();
  const liveGeneratingByBucket = { 0: true };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: state.buckets,
    liveGeneratingByBucket,
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
  });
  const health = analyzeSchedulerHealth({
    bucketStates: state.buckets,
    liveGeneratingByBucket,
    occupancy,
    excludedBuckets: blocked,
    maxActive: 2,
    nowMs,
    graceMs,
  });
  assert.equal(health.availableReviewerSlots, 1);
  assert.equal(health.schedulerUnderutilized, true);
  assert.ok(health.runnableCandidates.includes(3));
});

test('available slot + no runnable bucket → schedulerUnderutilized=false', () => {
  const state = makeState({
    buckets: {
      0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE' },
      1: {
        complete: false,
        chatUrl: 'u1',
        phase: 'ACTIVE',
        awaitingResponseAt: '2026-09-17T22:02:17.158Z',
        awaitingActionId: 'A1',
      },
    },
  });
  const liveGeneratingByBucket = { 0: true };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: state.buckets,
    liveGeneratingByBucket,
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
  });
  const health = analyzeSchedulerHealth({
    bucketStates: state.buckets,
    liveGeneratingByBucket,
    occupancy,
    excludedBuckets: blocked,
    maxActive: 2,
    nowMs,
    graceMs,
  });
  assert.equal(health.schedulerUnderutilized, false);
  assert.match(String(health.idleCapacityReason || ''), /B1 waiting for unresolved response/);
});

test('unresolved awaiting action does not count as live generation', () => {
  const bucketState = {
    complete: false,
    awaitingResponseAt: '2026-09-17T22:02:17.158Z',
    awaitingActionId: 'A-TEST-2',
    generationSeenSinceAction: true,
  };
  assert.equal(bucketHasUnresolvedAwaitingAction(bucketState), true);
  assert.equal(bucketOccupiesLiveReviewerSlot(bucketState, { isLiveGenerating: false, nowMs, graceMs }), false);
});

test('duplicate dispatch remains blocked', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u1',
    phase: 'ACTIVE',
    awaitingResponseAt: '2026-09-17T22:02:17.158Z',
    awaitingActionId: 'A-TEST-2',
  };
  assert.equal(bucketBlocksCandidateActivation(bucketState), true);
});

test('source-pack progression is shown independently of case progress', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u3',
    phase: 'ACTIVE',
    sourcePackTargetNumber: 5,
    sourcePackTargetFilename: 'pack_000005.jsonl',
    sourcePackLastDeliveredNumber: 5,
    sourcePackLastConsumedNumber: 4,
    sourcePackResumePending: false,
    lastProgressAt: null,
    lastSourcePackTransitionAt: new Date(nowMs - 60000).toISOString(),
    lastSourcePackTransitionFrom: 'pack_000004.jsonl',
    lastSourcePackTransitionTo: 'pack_000005.jsonl',
  };
  const view = buildBucketOperationsView({
    bucket: 3,
    bucketState,
    isLiveGenerating: true,
    state: makeState(),
    nowMs,
  });
  assert.equal(view.currentSourcePack, 'pack_000005.jsonl');
  assert.equal(view.lastConsumedSourcePack, 'pack_000004.jsonl');
  assert.equal(view.operationalState, 'GENERATING');
  assert.equal(view.lastProgressAt, null);
  assert.equal(view.lastSourcePackTransitionTo, 'pack_000005.jsonl');
});

test('dashboard never reports a merely delivered unavailable pack as consumed', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u1',
    phase: 'PAUSED',
    sourcePackTargetNumber: 7,
    sourcePackTargetFilename: 'pack_000007.jsonl',
    sourcePackLastDeliveredNumber: 7,
    sourcePackLastConsumedNumber: 6,
    sourcePackLastVisibleNumber: 6,
    sourcePackResumePending: true,
  };
  const view = buildBucketOperationsView({
    bucket: 1,
    bucketState,
    isLiveGenerating: false,
    state: makeState(),
    nowMs,
  });
  assert.equal(view.currentSourcePack, 'pack_000007.jsonl');
  assert.equal(view.lastConsumedSourcePack, 'pack_000006.jsonl');
  assert.equal(view.nextStagedSourcePack, 'pack_000007.jsonl');
});

test('dashboard/status activeReviewers matches CDP live count', () => {
  const state = makeState();
  const liveGeneratingByBucket = { 0: true, 3: true };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: state.buckets,
    liveGeneratingByBucket,
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
  });
  const ops = buildOperationsStatus({
    state,
    occupancy,
    liveGeneratingByBucket,
    excludedBuckets: blocked,
    maxActive: 2,
    nowMs,
    graceMs,
  });
  assert.equal(ops.liveReviewerGenerations, 2);
  assert.deepEqual(ops.liveGeneratingBuckets, [0, 3]);
});

test('productive reviewer metrics exclude setup and source-pack generations', () => {
  const state = makeState({
    buckets: {
      0: { complete: false, chatUrl: 'u0', phase: 'ACTIVE', lastMessageSentKind: 'CONTINUE' },
      1: { complete: false, chatUrl: 'u1', phase: 'SETUP_WAIT', lastMessageSentKind: 'PROTOCOL_SETUP' },
      3: { complete: false, chatUrl: 'u3', phase: 'ACTIVE', lastMessageSentKind: 'SOURCE_PACK_CONTINUE' },
    },
  });
  const liveGeneratingByBucket = { 0: true, 1: true, 3: true };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: state.buckets,
    liveGeneratingByBucket,
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
  });
  const ops = buildOperationsStatus({
    state,
    occupancy,
    liveGeneratingByBucket,
    excludedBuckets: blocked,
    maxActive: 2,
    nowMs,
    graceMs,
  });
  assert.equal(ops.productiveReviewerCount, 1);
  assert.equal(ops.substantiveAuditGenerations, 1);
});

test('historical rollover timestamp does not misclassify a later HOLD', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u1',
    phase: 'HOLD',
    lastAction: 'incident:INC-B1',
    lastRolloverAt: '2026-09-17T20:00:00.000Z',
  };
  assert.equal(deriveOperationalState({ bucket: 1, bucketState, nowMs }), 'HOLD');
});

test('maximum concurrency remains 2', () => {
  const buckets = {
    0: { complete: false, awaitingResponseAt: new Date(nowMs - 10000).toISOString(), awaitingActionId: 'A0', generationSeenSinceAction: false },
    1: { complete: false, awaitingResponseAt: new Date(nowMs - 5000).toISOString(), awaitingActionId: 'A1', generationSeenSinceAction: false },
    3: { complete: false, awaitingResponseAt: new Date(nowMs - 2000).toISOString(), awaitingActionId: 'A3', generationSeenSinceAction: false },
  };
  const occupancy = buildLiveReviewerOccupancy({
    bucketStates: buckets,
    liveGeneratingByBucket: { 0: true, 1: false, 3: false },
    excludedBuckets: blocked,
    nowMs,
    graceMs,
    maxActive: 2,
  });
  assert.equal(occupancy.occupiedSlots, 2);
  assert.equal(occupancy.availableSlots, 0);
});

test('progress history remains bounded', () => {
  const state = makeState();
  for (let i = 0; i < PROGRESS_EVENT_MAX_COUNT + 50; i += 1) {
    recordAuditProgressEvent(state, {
      bucket: 0,
      newCases: 1,
      at: new Date(nowMs - i * 1000).toISOString(),
    });
  }
  assert.ok(state.metrics.progressEvents.length <= PROGRESS_EVENT_MAX_COUNT);
});

test('controller restart preserves recent progress metrics', () => {
  const state = makeState();
  recordAuditProgressEvent(state, {
    bucket: 3,
    newCases: 12,
    at: new Date(nowMs - THROUGHPUT_WINDOWS_MS.m15 + 60000).toISOString(),
  });
  const serialized = JSON.parse(JSON.stringify(state));
  const reloaded = normalizeOperationsState(serialized);
  const throughput = computeThroughputMetrics(reloaded, nowMs);
  assert.equal(throughput.newCasesLast15m, 12);
  assert.equal(reloaded.buckets[3].lastProgressNewCases, 12);
});

test('short dispatch-start reservation still reserves capacity correctly', () => {
  const bucketState = {
    complete: false,
    awaitingResponseAt: new Date(nowMs - 10000).toISOString(),
    awaitingActionId: 'A-start',
    generationSeenSinceAction: false,
  };
  assert.equal(bucketHasDispatchStartReservation(bucketState, { nowMs, graceMs, isLiveGenerating: false }), true);
  assert.equal(bucketHasGenerationReservation(bucketState, { nowMs, graceMs }), true);
});

test('stale generating lastAction alone does not reserve generation', () => {
  const bucketState = {
    complete: false,
    chatUrl: 'u3',
    phase: 'ACTIVE',
    lastAction: 'generating:A-old',
    awaitingActionId: null,
    awaitingResponseAt: null,
  };
  assert.equal(bucketHasGenerationReservation(bucketState, { nowMs, graceMs }), false);
});
