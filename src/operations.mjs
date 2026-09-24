import {
  bucketBlocksCandidateActivation,
  bucketHasDispatchStartReservation,
  bucketHasGenerationReservation,
  bucketHasUnresolvedAwaitingAction,
  bucketEligibleForScheduling,
  bucketIsUnfinished,
  bucketNeedsReviewer,
  computeDesiredActiveReviewers,
  selectReviewerSlotCandidates,
  sourcePackFilename,
} from './protocol.mjs';

export const PROGRESS_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PROGRESS_EVENT_MAX_COUNT = 500;
export const ACTIVITY_EVENT_MAX_COUNT = 50;

export const THROUGHPUT_WINDOWS_MS = Object.freeze({
  m5: 5 * 60 * 1000,
  m15: 15 * 60 * 1000,
  m60: 60 * 60 * 1000,
});

export const RECENT_PROGRESS_MS = THROUGHPUT_WINDOWS_MS.m15;
export const STALL_WATCH_MINUTES = 10;
export const STALL_STALLED_MINUTES = 30;

function excludedBucketSet(excludedBuckets = []) {
  if (excludedBuckets instanceof Set) return excludedBuckets;
  return new Set(Array.from(excludedBuckets, value => Number(value)));
}

function isExcludedBucket(bucket, excludedBuckets = []) {
  return excludedBucketSet(excludedBuckets).has(Number(bucket));
}

function parseTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function minutesSince(value, nowMs = Date.now()) {
  const at = parseTime(value);
  if (at === null) return null;
  return Math.max(0, (nowMs - at) / 60000);
}

function trimBoundedEvents(events, {
  maxAgeMs = PROGRESS_EVENT_MAX_AGE_MS,
  maxCount = PROGRESS_EVENT_MAX_COUNT,
  nowMs = Date.now(),
} = {}) {
  const cutoff = nowMs - maxAgeMs;
  return (Array.isArray(events) ? events : [])
    .filter(event => parseTime(event?.at) !== null && parseTime(event.at) >= cutoff)
    .sort((a, b) => parseTime(b.at) - parseTime(a.at))
    .slice(0, maxCount);
}

export function normalizeOperationsState(state) {
  if (!state || typeof state !== 'object') return state;
  state.metrics ||= {};
  if (!Array.isArray(state.metrics.progressEvents)) state.metrics.progressEvents = [];
  if (!Array.isArray(state.metrics.activityEvents)) state.metrics.activityEvents = [];
  state.metrics.progressEvents = trimBoundedEvents(state.metrics.progressEvents);
  state.metrics.activityEvents = trimBoundedEvents(state.metrics.activityEvents, {
    maxAgeMs: PROGRESS_EVENT_MAX_AGE_MS,
    maxCount: ACTIVITY_EVENT_MAX_COUNT,
  });
  return state;
}

export function recordAuditProgressEvent(state, {
  bucket,
  actionId = null,
  newCases = 0,
  writesVerified = null,
  sourcePack = null,
  at = new Date().toISOString(),
} = {}) {
  normalizeOperationsState(state);
  const count = Number(newCases);
  if (!Number.isFinite(count) || count <= 0) return false;

  const bucketKey = String(bucket);
  const bucketState = state.buckets?.[bucketKey];
  const event = {
    at,
    bucket: Number(bucket),
    actionId,
    newCases: count,
    writesVerified: writesVerified ? String(writesVerified).toUpperCase() : null,
    sourcePack: sourcePack || null,
  };

  state.metrics.progressEvents.unshift(event);
  state.metrics.progressEvents = trimBoundedEvents(state.metrics.progressEvents);
  state.metrics.lastProgressAt = at;
  state.metrics.lastProgressActionId = actionId;
  state.metrics.lastProgressBucket = Number(bucket);

  if (bucketState) {
    bucketState.lastProgressAt = at;
    bucketState.lastProgressActionId = actionId;
    bucketState.lastProgressNewCases = count;
    bucketState.lastProgressWritesVerified = event.writesVerified;
    bucketState.lastProgressPack = sourcePack || bucketState.sourcePackTargetFilename || null;
  }
  return true;
}

export function recordActivityEvent(state, {
  bucket = null,
  kind,
  summary,
  at = new Date().toISOString(),
} = {}) {
  normalizeOperationsState(state);
  if (!kind || !summary) return false;
  state.metrics.activityEvents.unshift({
    at,
    bucket: bucket === null || bucket === undefined ? null : Number(bucket),
    kind: String(kind),
    summary: String(summary).slice(0, 220),
  });
  state.metrics.activityEvents = trimBoundedEvents(state.metrics.activityEvents, {
    maxAgeMs: PROGRESS_EVENT_MAX_AGE_MS,
    maxCount: ACTIVITY_EVENT_MAX_COUNT,
  });
  return true;
}

export function recordSourcePackTransition(state, bucket, {
  fromPack = null,
  toPack = null,
  at = new Date().toISOString(),
} = {}) {
  const bucketState = state?.buckets?.[String(bucket)];
  if (!bucketState) return false;
  bucketState.lastSourcePackTransitionAt = at;
  bucketState.lastSourcePackTransitionFrom = fromPack;
  bucketState.lastSourcePackTransitionTo = toPack;
  return true;
}

function sumWindow(events, windowMs, nowMs, predicate = () => true) {
  const cutoff = nowMs - windowMs;
  let newCases = 0;
  let verifiedWrites = 0;
  const buckets = new Set();
  for (const event of events) {
    const at = parseTime(event?.at);
    if (at === null || at < cutoff) continue;
    if (!predicate(event)) continue;
    newCases += Number(event.newCases || 0);
    if (String(event.writesVerified || '').toUpperCase() === 'YES') verifiedWrites += Number(event.newCases || 0);
    buckets.add(Number(event.bucket));
  }
  return { newCases, verifiedWrites, buckets: [...buckets].sort((a, b) => a - b) };
}

export function computeThroughputMetrics(state, nowMs = Date.now()) {
  normalizeOperationsState(state);
  const events = state.metrics.progressEvents || [];
  const w5 = sumWindow(events, THROUGHPUT_WINDOWS_MS.m5, nowMs);
  const w15 = sumWindow(events, THROUGHPUT_WINDOWS_MS.m15, nowMs);
  const w60 = sumWindow(events, THROUGHPUT_WINDOWS_MS.m60, nowMs);
  const lastGlobalProgressAt = state.metrics.lastProgressAt || null;
  return {
    progressingBuckets5m: w5.buckets,
    progressingBuckets15m: w15.buckets,
    progressingBuckets60m: w60.buckets,
    newCasesLast5m: w5.newCases,
    newCasesLast15m: w15.newCases,
    newCasesLast60m: w60.newCases,
    verifiedWritesLast5m: w5.verifiedWrites,
    verifiedWritesLast15m: w15.verifiedWrites,
    verifiedWritesLast60m: w60.verifiedWrites,
    lastGlobalProgressAt,
    minutesSinceLastGlobalProgress: minutesSince(lastGlobalProgressAt, nowMs),
  };
}

function bucketSourcePackView(bucket, bucketState) {
  const bucketNumber = Number(bucket);
  return {
    currentSourcePack: bucketState?.sourcePackTargetFilename
      || (bucketState?.sourcePackTargetNumber != null
        ? sourcePackFilename(bucketState.sourcePackTargetNumber, bucketNumber)
        : null),
    lastConsumedSourcePack: bucketState?.sourcePackLastConsumedNumber != null
      ? sourcePackFilename(bucketState.sourcePackLastConsumedNumber, bucketNumber)
      : null,
    nextStagedSourcePack: bucketState?.sourcePackResumePending
      ? (bucketState.sourcePackTargetFilename
        || (bucketState.sourcePackTargetNumber != null
          ? sourcePackFilename(bucketState.sourcePackTargetNumber, bucketNumber)
          : null))
      : null,
    sourcePackResumePending: Boolean(bucketState?.sourcePackResumePending),
    sourcePackAccessVerified: Boolean(bucketState?.sourcePackAccessVerified),
    lastSourcePackTransitionAt: bucketState?.lastSourcePackTransitionAt || null,
    lastSourcePackTransitionFrom: bucketState?.lastSourcePackTransitionFrom || null,
    lastSourcePackTransitionTo: bucketState?.lastSourcePackTransitionTo || null,
  };
}

function isRolloverState(bucketState) {
  const lastAction = String(bucketState?.lastAction || '').toLowerCase();
  return lastAction.includes('rollover')
    || lastAction.includes('creating a new reviewer');
}

const SUBSTANTIVE_AUDIT_ACTION_KINDS = new Set([
  'INITIAL_AUDIT',
  'CONTINUE',
  'CORPUS_RECONCILE',
  'WRITE_RECOVERY',
  'MALFORMED_RECOVERY',
  'ISOLATED_ANOMALY_CONTINUE',
]);

function isStalledBucket(bucketState, nowMs, isLiveGenerating) {
  if (isLiveGenerating) return false;
  if (bucketHasUnresolvedAwaitingAction(bucketState)) return false;
  const progressMinutes = minutesSince(bucketState?.lastProgressAt, nowMs);
  const actionMinutes = minutesSince(bucketState?.lastMessageSentAt, nowMs);
  const anchor = Math.max(progressMinutes ?? 0, actionMinutes ?? 0);
  if (anchor >= STALL_STALLED_MINUTES) return true;
  return false;
}

function isWatchBucket(bucketState, nowMs, isLiveGenerating) {
  if (isLiveGenerating) return false;
  const progressMinutes = minutesSince(bucketState?.lastProgressAt, nowMs);
  if (progressMinutes === null) return false;
  return progressMinutes >= STALL_WATCH_MINUTES && progressMinutes < STALL_STALLED_MINUTES;
}

export function deriveOperationalState({
  bucket,
  bucketState,
  schedulingBlocked = false,
  isLiveGenerating = false,
  nowMs = Date.now(),
} = {}) {
  if (!bucketState) return 'IDLE';
  if (bucketState.complete) return 'IDLE';
  if (schedulingBlocked) return 'BLOCKED';
  if (isLiveGenerating) return 'GENERATING';
  if (bucketState.phase === 'HOLD') return 'HOLD';
  if (isRolloverState(bucketState)) return 'ROLLOVER';
  if (bucketState.phase === 'SETUP_WAIT') return 'SETUP';
  if (bucketHasUnresolvedAwaitingAction(bucketState)) return 'WAITING_RESPONSE';
  if (bucketState.sourcePackResumePending) return 'WAITING_SOURCE_PACK';
  if (isStalledBucket(bucketState, nowMs, isLiveGenerating)) return 'STALLED';
  const recentProgressAt = parseTime(bucketState.lastProgressAt);
  if (recentProgressAt !== null && nowMs - recentProgressAt <= RECENT_PROGRESS_MS) return 'RECENT_PROGRESS';
  if (bucketIsUnfinished(bucketState) && !schedulingBlocked
    && !bucketHasUnresolvedAwaitingAction(bucketState)
    && !bucketState.sourcePackResumePending
    && !isLiveGenerating) {
    return 'RUNNABLE_IDLE';
  }
  return 'IDLE';
}

function bucketCasesInWindow(state, bucket, windowMs, nowMs) {
  const events = state?.metrics?.progressEvents || [];
  const cutoff = nowMs - windowMs;
  return events
    .filter(event => Number(event.bucket) === Number(bucket)
      && parseTime(event.at) !== null
      && parseTime(event.at) >= cutoff)
    .reduce((sum, event) => sum + Number(event.newCases || 0), 0);
}

export function buildBucketOperationsView({
  bucket,
  bucketState,
  schedulingBlocked = false,
  isLiveGenerating = false,
  state = {},
  nowMs = Date.now(),
} = {}) {
  const pack = bucketSourcePackView(bucket, bucketState);
  const operationalState = deriveOperationalState({
    bucket,
    bucketState,
    schedulingBlocked,
    isLiveGenerating,
    nowMs,
  });
  const progressMinutes = minutesSince(bucketState?.lastProgressAt, nowMs);
  const actionMinutes = minutesSince(bucketState?.lastMessageSentAt, nowMs);
  const generationMinutes = minutesSince(bucketState?.generationObservedAt, nowMs);
  let exactBlocker = 'none';
  if (schedulingBlocked) exactBlocker = 'scheduling-blocked';
  else if (operationalState === 'HOLD') exactBlocker = `hold:${bucketState?.hold?.type || 'INTEGRITY'}:${bucketState?.hold?.reason || bucketState?.lastAction || 'incident'}`;
  else if (operationalState === 'WAITING_RESPONSE') exactBlocker = `awaiting-response:${bucketState?.awaitingActionId || 'unknown'}`;
  else if (operationalState === 'WAITING_SOURCE_PACK') exactBlocker = 'source-pack-continuation-pending';
  else if (operationalState === 'STALLED') exactBlocker = 'no-recent-audit-progress';
  else if (operationalState === 'SETUP') exactBlocker = 'protocol-setup';
  else if (operationalState === 'ROLLOVER') exactBlocker = 'chat-rollover';
  else if (operationalState === 'RUNNABLE_IDLE') exactBlocker = 'runnable-idle';

  return {
    bucket: Number(bucket),
    operationalState,
    workflowPhase: bucketState?.phase || null,
    liveGeneration: Boolean(isLiveGenerating),
    actualGenerationDetected: Boolean(isLiveGenerating),
    generationReserved: bucketHasGenerationReservation(bucketState),
    eligibleForScheduling: bucketEligibleForScheduling(bucketState, nowMs),
    holdType: bucketState?.hold?.type || null,
    holdReason: bucketState?.hold?.reason || null,
    holdSince: bucketState?.hold?.createdAt || null,
    recoverable: bucketState?.hold?.type === 'TRANSIENT_EXTERNAL',
    nextRecoveryAttemptAt: bucketState?.hold?.nextAttemptAt || null,
    currentActionId: bucketState?.awaitingActionId || bucketState?.lastMessageSentActionId || null,
    currentActionType: bucketState?.lastMessageSentKind || null,
    currentSourcePack: pack.currentSourcePack,
    lastConsumedSourcePack: pack.lastConsumedSourcePack,
    nextStagedSourcePack: pack.nextStagedSourcePack,
    sourcePackResumePending: pack.sourcePackResumePending,
    sourcePackAccessVerified: pack.sourcePackAccessVerified,
    lastSourcePackTransitionAt: pack.lastSourcePackTransitionAt,
    lastSourcePackTransitionFrom: pack.lastSourcePackTransitionFrom,
    lastSourcePackTransitionTo: pack.lastSourcePackTransitionTo,
    lastProgressAt: bucketState?.lastProgressAt || null,
    minutesSinceLastProgress: progressMinutes,
    lastProgressNewCases: bucketState?.lastProgressNewCases ?? null,
    lastProgressWritesVerified: bucketState?.lastProgressWritesVerified ?? null,
    lastProgressPack: bucketState?.lastProgressPack ?? null,
    recentCases15m: bucketCasesInWindow(state, bucket, THROUGHPUT_WINDOWS_MS.m15, nowMs),
    recentCases60m: bucketCasesInWindow(state, bucket, THROUGHPUT_WINDOWS_MS.m60, nowMs),
    awaitingResponse: bucketHasUnresolvedAwaitingAction(bucketState),
    schedulingBlocked: Boolean(schedulingBlocked),
    exactBlocker,
    chatId: bucketState?.chatId || null,
    lastAction: bucketState?.lastAction || null,
    minutesSinceActionSent: actionMinutes,
    minutesSinceGenerationObserved: generationMinutes,
    visibilityClass: operationalState === 'STALLED'
      ? 'stalled'
      : isWatchBucket(bucketState, nowMs, isLiveGenerating)
        ? 'watch'
        : 'normal',
  };
}

function candidateBlockReason(bucket, bucketState, liveGeneratingByBucket) {
  if (bucketState?.hold) {
    return `B${bucket} ${bucketState.hold.type || 'INTEGRITY'} hold: ${bucketState.hold.reason || bucketState.lastAction || 'incident'}`;
  }
  if (bucketBlocksCandidateActivation(bucketState)) {
    return `B${bucket} waiting for unresolved response (${bucketState.awaitingActionId})`;
  }
  if (bucketState.sourcePackResumePending) {
    return `B${bucket} waiting for source-pack continuation (${bucketState.sourcePackTargetFilename || 'unknown pack'})`;
  }
  if (bucketNeedsReviewer(bucketState)) {
    return `B${bucket} needs reviewer chat creation`;
  }
  if (bucketState.phase === 'HOLD') {
    return `B${bucket} on hold (${bucketState.lastAction || 'incident'})`;
  }
  if (bucketHasGenerationReservation(bucketState)) {
    return `B${bucket} has generation reservation (${bucketState.lastAction || 'reserved'})`;
  }
  if (liveGeneratingByBucket[String(bucket)]) {
    return `B${bucket} already live generating`;
  }
  if (bucketState.phase === 'SETUP_WAIT') {
    return `B${bucket} setup/rollover in progress`;
  }
  return `B${bucket} not eligible (${bucketState.phase || 'unknown phase'})`;
}

export function analyzeSchedulerHealth({
  bucketStates,
  liveGeneratingByBucket = {},
  occupancy = {},
  excludedBuckets = [],
  maxActive = 2,
  bucketCount = 6,
  nowMs = Date.now(),
  graceMs = 45000,
} = {}) {
  const liveReviewerGenerations = Number(occupancy.activeReviewers || 0);
  const maxReviewerGenerations = Number(maxActive || 2);
  const availableReviewerSlots = Number(occupancy.availableSlots || 0);
  const desiredLiveReviewers = computeDesiredActiveReviewers(
    bucketStates,
    maxReviewerGenerations,
    excludedBuckets,
    bucketCount,
    nowMs,
    [
      ...(occupancy.liveGeneratingBuckets || []),
      ...(occupancy.dispatchStartBuckets || []),
    ],
  );
  const dispatchStartCount = Number(occupancy.dispatchStartBuckets?.length || 0);
  const awaitingResponseBuckets = occupancy.awaitingResponseBuckets || [];
  const scheduledCapacity = liveReviewerGenerations + dispatchStartCount;
  const reservationsExplainGap = scheduledCapacity >= desiredLiveReviewers;
  const candidates = selectReviewerSlotCandidates(bucketStates, excludedBuckets);
  const runnableCandidates = candidates.filter((bucket) => {
    const bucketState = bucketStates[String(bucket)];
    return bucketState && !liveGeneratingByBucket[String(bucket)];
  });

  let idleCapacityReason = null;
  let schedulerUnderutilized = false;

  if (liveReviewerGenerations < desiredLiveReviewers && availableReviewerSlots <= 0) {
    const dispatchBuckets = (occupancy.dispatchStartBuckets || []).map(bucket => `B${bucket} dispatch starting`);
    const reservations = [...dispatchBuckets];
    idleCapacityReason = reservations.length
      ? `capacity fully scheduled (${reservations.join('; ')})`
      : 'capacity fully scheduled';
  } else if (liveReviewerGenerations < desiredLiveReviewers && !reservationsExplainGap) {
    if (!runnableCandidates.length) {
      const blockers = [];
      for (const [bucket, bucketState] of Object.entries(bucketStates)) {
        if (isExcludedBucket(bucket, excludedBuckets) || !bucketIsUnfinished(bucketState)) continue;
        if (liveGeneratingByBucket[String(bucket)]) continue;
        blockers.push(candidateBlockReason(bucket, bucketState, liveGeneratingByBucket));
      }
      idleCapacityReason = blockers.length
        ? blockers.slice(0, 3).join('; ')
        : 'no eligible unblocked bucket';
      schedulerUnderutilized = false;
    } else {
      idleCapacityReason = `runnable candidates present (${runnableCandidates.map(b => `B${b}`).join(', ')}) but slot not yet filled`;
      schedulerUnderutilized = true;
    }
  } else if (availableReviewerSlots > 0 && runnableCandidates.length > 0) {
    idleCapacityReason = `runnable candidates present (${runnableCandidates.map(b => `B${b}`).join(', ')})`;
    schedulerUnderutilized = true;
  }

  return {
    liveReviewerGenerations,
    maxReviewerGenerations,
    availableReviewerSlots,
    desiredLiveReviewers,
    schedulerUnderutilized,
    idleReviewerCapacity: availableReviewerSlots,
    idleCapacityReason,
    runnableCandidates: runnableCandidates.map(Number),
    bucketExclusions: Object.fromEntries(Object.entries(bucketStates || {})
      .filter(([bucket, bucketState]) => !isExcludedBucket(bucket, excludedBuckets) && bucketIsUnfinished(bucketState))
      .map(([bucket, bucketState]) => {
        if (liveGeneratingByBucket[String(bucket)]) return [bucket, null];
        if (bucketEligibleForScheduling(bucketState, nowMs)
          && !liveGeneratingByBucket[String(bucket)]) {
          return [bucket, candidates.includes(bucket) ? null : candidateBlockReason(bucket, bucketState, liveGeneratingByBucket)];
        }
        return [bucket, candidateBlockReason(bucket, bucketState, liveGeneratingByBucket)];
      })),
    dispatchStartBuckets: occupancy.dispatchStartBuckets || [],
    awaitingResponseBuckets,
    liveGeneratingBuckets: occupancy.liveGeneratingBuckets || [],
  };
}

export function buildOperationsStatus({
  state,
  occupancy = {},
  liveGeneratingByBucket = {},
  excludedBuckets = [],
  maxActive = 2,
  bucketCount = 6,
  auditablePopulation = null,
  nowMs = Date.now(),
  graceMs = 45000,
} = {}) {
  normalizeOperationsState(state);
  const throughput = computeThroughputMetrics(state, nowMs);
  const scheduler = analyzeSchedulerHealth({
    bucketStates: state.buckets,
    liveGeneratingByBucket,
    occupancy,
    excludedBuckets,
    maxActive,
    bucketCount,
    nowMs,
    graceMs,
  });
  const casesProcessedTotal = Number(state.metrics?.casesReported || 0);
  const population = auditablePopulation == null ? null : Number(auditablePopulation);
  const productiveReviewerCount = Object.entries(liveGeneratingByBucket || {})
    .filter(([bucket, isLive]) => Boolean(isLive)
      && !isExcludedBucket(bucket, excludedBuckets)
      && SUBSTANTIVE_AUDIT_ACTION_KINDS.has(String(state.buckets?.[bucket]?.lastMessageSentKind || '')))
    .length;
  const buckets = Object.fromEntries(
    Object.entries(state.buckets || {}).map(([bucket, bucketState]) => [
      bucket,
      buildBucketOperationsView({
        bucket,
        bucketState,
        schedulingBlocked: isExcludedBucket(bucket, excludedBuckets),
        isLiveGenerating: Boolean(liveGeneratingByBucket[String(bucket)]),
        state,
        nowMs,
      }),
    ]),
  );

  return {
    ...scheduler,
    ...throughput,
    productiveReviewerCount,
    substantiveAuditGenerations: productiveReviewerCount,
    casesProcessedTotal,
    casesRemainingEstimate: population === null || !Number.isFinite(population) ? null : Math.max(0, population - casesProcessedTotal),
    casesProcessedBasis: state.metrics?.progressBasis || null,
    buckets,
    recentActivity: (state.metrics?.activityEvents || []).slice(0, ACTIVITY_EVENT_MAX_COUNT),
    progressEventCount: (state.metrics?.progressEvents || []).length,
  };
}
