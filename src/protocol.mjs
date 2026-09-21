import crypto from 'node:crypto';

export const REQUIRED_FOOTER_LINES = 6;

export const HOLD_TYPES = Object.freeze(['TRANSIENT_EXTERNAL', 'INTEGRITY', 'ADVISORY', 'USER', 'COMPLETE']);
const HOLD_RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000]);

export function classifyHoldType(kind, footer = null, detail = '') {
  const incidentKind = String(kind || '').toUpperCase();
  const blocker = String(footer?.blocker || '').trim().toUpperCase();
  const reason = `${incidentKind} ${blocker} ${detail}`.toUpperCase();
  if (incidentKind === 'COMPLETE' || incidentKind === 'CORPUS_COMPLETE') return 'COMPLETE';
  if (/TERMINAL_DUPLICATE_CLASSIFICATION_COLLISION|ADVISORY|ISOLATED_ANOMALY/.test(reason)) return 'ADVISORY';
  if (/NEW_CHAT_ID_TIMEOUT|NEW_CHAT_SEND_UNCONFIRMED|NEW_CHAT_CREATION_UNRESOLVED|AUTH_REQUIRED|AUTHENTICATION_REQUIRED|REVIEWER_MODEL_UNAVAILABLE|REVIEWER_CHAT_CAP_REACHED|USER_ACTION/.test(reason)) return 'USER';
  if (/SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED|PACK_\d{6}_(?:NOT_YET_RESOLVED|UNAVAILABLE|NOT_FOUND)|REGISTRY_(?:STRUCTURE|SHARD|ACCESS|SHEET).*(?:UNAVAILABLE|MISSING|NOT_FOUND|NOT_ACCESSIBLE|TIMEOUT)|(?:REGISTRY|SHEET|DRIVE).*(?:UNAVAILABLE|DISCONNECTED|ACCESS_DENIED)|TURN_TIMEOUT|REVIEWER_STALL|SETUP_ACK_TIMEOUT|NO_ASSISTANT_RESPONSE|BROWSER_DISCONNECTED/.test(reason)) return 'TRANSIENT_EXTERNAL';
  return 'INTEGRITY';
}

export function holdValidationKind(kind, bucket, footer = null) {
  const reason = `${String(kind || '')} ${String(footer?.blocker || '')}`.toUpperCase();
  if (/REGISTRY|SHEET/.test(reason)) return { kind: 'REGISTRY_SHARD_AVAILABLE', bucket: Number(bucket) };
  if (/SOURCE_PACK|DRIVE/.test(reason)) return { kind: 'SOURCE_PACK_FOLDER_LISTING', bucket: Number(bucket) };
  if (/REVIEWER|CHAT|GENERATION|ASSISTANT/.test(reason)) return { kind: 'REVIEWER_CHAT_REACHABLE', bucket: Number(bucket) };
  return null;
}

export function createHoldRecord({
  type = 'INTEGRITY',
  reason = 'UNCLASSIFIED_HOLD',
  incidentId = null,
  bucket = null,
  createdAt = new Date().toISOString(),
  retryCount = 0,
  nextAttemptAt = null,
  validation = null,
  ...metadata
} = {}) {
  const safeType = HOLD_TYPES.includes(type) ? type : 'INTEGRITY';
  const attempts = Math.max(0, Number(retryCount) || 0);
  const retryDelay = HOLD_RETRY_DELAYS_MS[Math.min(HOLD_RETRY_DELAYS_MS.length - 1, attempts)];
  const createdMs = Date.parse(createdAt);
  const scheduledAt = Date.parse(nextAttemptAt || '');
  const next = safeType === 'TRANSIENT_EXTERNAL'
    ? (Number.isFinite(scheduledAt)
      ? new Date(scheduledAt).toISOString()
      : new Date((Number.isFinite(createdMs) ? createdMs : Date.now()) + retryDelay).toISOString())
    : null;
  return {
    ...metadata,
    type: safeType,
    reason: String(reason || 'UNCLASSIFIED_HOLD').trim(),
    incidentId: incidentId || null,
    createdAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : new Date().toISOString(),
    retryPolicy: safeType === 'TRANSIENT_EXTERNAL' ? 'REVALIDATE' : safeType === 'INTEGRITY' ? 'EVIDENCE_RECONCILIATION' : safeType === 'ADVISORY' ? 'ADVISORY_REVIEW' : safeType === 'COMPLETE' ? 'NONE' : 'USER_ACTION',
    retryCount: attempts,
    nextAttemptAt: next,
    validation: validation || (safeType === 'TRANSIENT_EXTERNAL' ? holdValidationKind(reason, bucket) : null),
  };
}

export function isHoldRetryDue(hold, nowMs = Date.now()) {
  if (hold?.type !== 'TRANSIENT_EXTERNAL' || hold?.retryPolicy !== 'REVALIDATE' || !hold.nextAttemptAt) return false;
  const nextAttempt = Date.parse(hold.nextAttemptAt);
  return Number.isFinite(nextAttempt) && Number(nowMs) >= nextAttempt;
}

export function sha16(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

export function normalizeBucketId(value, bucketCount = 6) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n >= Number(bucketCount)) return null;
  return String(n);
}

export function getBucketState(state, value, bucketCount = 6) {
  const id = normalizeBucketId(value, bucketCount);
  if (id === null) return null;
  return state?.buckets?.[id] ?? null;
}

export function parseFooter(text) {
  const source = String(text ?? '').trim();
  const match = source.match(
    /(?:^|\n)AUDIT_TURN_STATUS\s*\r?\nSTATUS:\s*(NORMAL|ERROR|COMPLETE)\s*\r?\nNEW_CASES:\s*(\d+)\s*\r?\nWRITES_VERIFIED:\s*(YES|NO|PARTIAL)\s*\r?\nBLOCKER:\s*([^\r\n]*)\s*\r?\nTRIGGER_COORDINATOR:\s*(YES|NO)\s*$/i,
  );
  if (!match) return null;

  return {
    status: match[1].toUpperCase(),
    newCases: Number(match[2]),
    writesVerified: match[3].toUpperCase(),
    blocker: match[4].trim(),
    triggerCoordinator: match[5].toUpperCase(),
  };
}

export function parseCorpusCompletionEvidence(text) {
  const source = String(text ?? '').trim();
  const reconciled = source.match(/(?:^|\n)FULL_CORPUS_RECONCILED:\s*(YES|NO)\s*$/im);
  const population = source.match(/(?:^|\n)FULL_CORPUS_AUDITABLE_POPULATION:\s*(\d+)\s*$/im);
  const pending = source.match(/(?:^|\n)OWNED_PENDING_CASES:\s*(\d+)\s*$/im);
  const unresolved = source.match(/(?:^|\n)UNRESOLVED_WRITES:\s*(\d+)\s*$/im);
  if (!reconciled || !population || !pending || !unresolved) return null;

  return {
    reconciled: reconciled[1].toUpperCase(),
    auditablePopulation: Number(population[1]),
    ownedPendingCases: Number(pending[1]),
    unresolvedWrites: Number(unresolved[1]),
  };
}

export function isVerifiedCorpusCompletion(evidence, expectedAuditablePopulation) {
  return Boolean(
    evidence
    && evidence.reconciled === 'YES'
    && evidence.ownedPendingCases === 0
    && evidence.unresolvedWrites === 0
    && evidence.auditablePopulation === Number(expectedAuditablePopulation),
  );
}

export function isExactSetupAck(text) {
  return /^PROTOCOL_SETUP_ACK_V3_?\s*$/i.test(String(text ?? '').trim());
}

export function actionResponseKey(actionIdValue, responseHash) {
  if (!actionIdValue || !responseHash) return null;
  return `${String(actionIdValue)}:${String(responseHash)}`;
}

export function assistantAfterActionMarker(messages, actionIdValue) {
  const marker = `[[R433_ACTION:${String(actionIdValue || '')}]]`;
  if (!actionIdValue || !Array.isArray(messages)) return { attributed: false, text: '' };
  let markerIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const role = String(messages[index]?.role || '').trim().toLowerCase();
    const text = String(messages[index]?.text || '');
    if (role === 'user' && text.includes(marker)) markerIndex = index;
  }
  if (markerIndex < 0) return { attributed: false, text: '' };
  let text = '';
  for (let index = markerIndex + 1; index < messages.length; index += 1) {
    if (String(messages[index]?.role || '').trim().toLowerCase() !== 'assistant') continue;
    const candidate = String(messages[index]?.text || '').trim();
    if (candidate) text = candidate;
  }
  return { attributed: Boolean(text), text };
}

export function classifyConversationMessageRole({ authorRole, className } = {}) {
  const explicitRole = String(authorRole || '').trim().toLowerCase();
  if (explicitRole === 'user' || explicitRole === 'assistant') return explicitRole;

  const classes = String(className || '').split(/\s+/).filter(Boolean);
  if (classes.includes('rich-text-user-turn')) return 'user';
  if (classes.some(classNameValue => classNameValue.includes('MarkdownRoot'))) return 'assistant';
  return null;
}

export function conversationRolloverReasonFromText(bodyText) {
  const body = String(bodyText || '');
  const limitPatterns = [
    /you[’']?ve reached the maximum length for this conversation/i,
    /this conversation has reached (?:its )?maximum length/i,
    /conversation (?:is|has become) too long/i,
    /maximum conversation length/i,
    /start a new chat to continue/i,
  ];
  if (limitPatterns.some(pattern => pattern.test(body))) {
    return 'ChatGPT reports that this conversation is too long or has reached its conversation limit';
  }
  const deliveryFailurePatterns = [
    /message delivery timed out/i,
    /there was an error generating a response/i,
    /something went wrong while generating/i,
    /connection interrupted\.?(?:\s+waiting for the complete answer)?/i,
    /waiting for the complete answer/i,
  ];
  if (deliveryFailurePatterns.some(pattern => pattern.test(body))) {
    return 'ChatGPT reports an explicit message-delivery or response-generation failure';
  }
  return null;
}

export function resetPerChatObservationState(bucketState) {
  if (!bucketState || typeof bucketState !== 'object') return bucketState;
  bucketState.lastHash = null;
  bucketState.processedHash = null;
  bucketState.processedResponseKey = null;
  bucketState.lastProcessedActionId = null;
  bucketState.lastProcessedStatus = null;
  bucketState.lastProcessedBlocker = null;
  bucketState.candidateHash = null;
  bucketState.candidateCount = 0;
  bucketState.candidateActionId = null;
  bucketState.candidateObservedAt = null;
  bucketState.lastMessageReceivedHash = null;
  bucketState.noAssistantCount = 0;
  bucketState.generationSeenSinceAction = false;
  bucketState.generationObservedAt = null;
  bucketState.malformedCount = 0;
  return bucketState;
}

export function actionId({ bucket, chatKey, responseHash, kind, prompt, predecessorActionId = '' }) {
  return `A-${sha16([bucket, chatKey, responseHash ?? '', kind, sha16(prompt), predecessorActionId].join('|'))}`;
}

export function bucketIsUnfinished(bucketState) {
  return Boolean(bucketState && !bucketState.complete);
}

export function bucketNeedsReviewer(bucketState) {
  return bucketIsUnfinished(bucketState) && !bucketState.chatUrl && bucketState.phase !== 'HOLD';
}

export function bucketCountsAsActive(bucketState) {
  return bucketIsUnfinished(bucketState)
    && Boolean(bucketState.chatUrl)
    && bucketState.phase !== 'HOLD'
    && bucketState.phase !== 'PAUSED';
}

export const DEFAULT_DISPATCH_START_GRACE_MS = 45000;

export function bucketOccupiesReviewerSlot(bucketState) {
  return bucketCountsAsActive(bucketState);
}

export function bucketHasUnresolvedAwaitingAction(bucketState) {
  return Boolean(bucketState?.awaitingActionId && bucketState?.awaitingResponseAt);
}

/**
 * A bucket can be unfinished without being dispatchable. In particular, an
 * outstanding action must first be reconciled and a held bucket must not
 * consume a reviewer target slot. Source-pack retries become eligible only
 * after their persisted backoff expires.
 */
export function bucketEligibleForScheduling(bucketState, nowMs = Date.now()) {
  if (!bucketIsUnfinished(bucketState) || bucketState.phase === 'HOLD') return false;
  if (bucketHasUnresolvedAwaitingAction(bucketState)) return false;
  if (bucketState.sourcePackResumePending && !sourcePackRetryReady(bucketState, nowMs)) return false;
  return true;
}

export function bucketHasDispatchStartReservation(
  bucketState,
  {
    nowMs = Date.now(),
    graceMs = DEFAULT_DISPATCH_START_GRACE_MS,
    isLiveGenerating = false,
  } = {},
) {
  if (isLiveGenerating) return false;
  if (!bucketHasUnresolvedAwaitingAction(bucketState)) return false;
  if (bucketState.generationSeenSinceAction) return false;
  const sentAt = Date.parse(bucketState.awaitingResponseAt);
  if (!Number.isFinite(sentAt)) return false;
  return nowMs - sentAt < graceMs;
}

export function bucketOccupiesLiveReviewerSlot(
  bucketState,
  {
    isLiveGenerating = false,
    nowMs = Date.now(),
    graceMs = DEFAULT_DISPATCH_START_GRACE_MS,
  } = {},
) {
  if (!bucketState || bucketState.complete) return false;
  if (isLiveGenerating) return true;
  return bucketHasDispatchStartReservation(bucketState, { nowMs, graceMs, isLiveGenerating: false });
}

export function buildLiveReviewerOccupancy({
  bucketStates,
  liveGeneratingByBucket = {},
  excludedBuckets = [],
  nowMs = Date.now(),
  graceMs = DEFAULT_DISPATCH_START_GRACE_MS,
  maxActive = 2,
  bucketCount = 6,
} = {}) {
  const excluded = new Set(Array.from(excludedBuckets, value => String(value)));
  const liveGeneratingBuckets = [];
  const dispatchStartBuckets = [];
  const awaitingResponseBuckets = [];

  for (const [bucket, bucketState] of Object.entries(bucketStates || {})) {
    if (excluded.has(String(bucket)) || !bucketIsUnfinished(bucketState)) continue;
    const isLive = Boolean(liveGeneratingByBucket[String(bucket)]);
    if (isLive) {
      liveGeneratingBuckets.push(Number(bucket));
      continue;
    }
    if (bucketHasDispatchStartReservation(bucketState, { nowMs, graceMs, isLiveGenerating: false })) {
      dispatchStartBuckets.push(Number(bucket));
      continue;
    }
    if (bucketHasUnresolvedAwaitingAction(bucketState)) awaitingResponseBuckets.push(Number(bucket));
  }

  const activeReviewers = liveGeneratingBuckets.length;
  const capacityBuckets = [...liveGeneratingBuckets, ...dispatchStartBuckets];
  const desiredActiveReviewers = computeDesiredActiveReviewers(
    bucketStates,
    maxActive,
    excludedBuckets,
    bucketCount,
    nowMs,
    capacityBuckets,
  );
  // Only credible active generations and short dispatch-start grace count
  // against simultaneous generation capacity. An unresolved action is useful
  // diagnostic state, but cannot reserve a reviewer forever by itself.
  const rawScheduled = activeReviewers + dispatchStartBuckets.length;
  const occupiedSlots = Math.min(desiredActiveReviewers, rawScheduled);
  const availableSlots = Math.max(0, desiredActiveReviewers - occupiedSlots);

  return {
    liveGeneratingBuckets,
    dispatchStartBuckets,
    awaitingResponseBuckets,
    activeReviewers,
    scheduledReviewers: rawScheduled,
    occupiedSlots,
    desiredActiveReviewers,
    availableSlots,
  };
}

export function bucketBlocksCandidateActivation(bucketState) {
  return bucketHasUnresolvedAwaitingAction(bucketState);
}

export function bucketHasGenerationReservation(bucketState, options = {}) {
  if (!bucketState) return false;
  if (bucketHasUnresolvedAwaitingAction(bucketState)) return true;
  const { nowMs = Date.now(), graceMs = DEFAULT_DISPATCH_START_GRACE_MS } = options;
  return bucketHasDispatchStartReservation(bucketState, { nowMs, graceMs, isLiveGenerating: false });
}

export function bucketReclaimableIdleSlot(bucketState) {
  return Boolean(
    bucketState
    && bucketState.phase === 'ACTIVE'
    && bucketState.chatUrl
    && !bucketHasGenerationReservation(bucketState)
    && bucketState.sourcePackResumePending,
  );
}

export function countOccupiedReviewerSlots(bucketStates, excludedBuckets = []) {
  const excluded = new Set(Array.from(excludedBuckets, value => String(value)));
  return Object.entries(bucketStates).filter(([bucket, state]) => (
    !excluded.has(String(bucket)) && bucketOccupiesReviewerSlot(state)
  )).length;
}

export function countUnblockedUnfinishedBuckets(bucketStates, excludedBuckets = [], bucketCount = 6) {
  const excluded = new Set(Array.from(excludedBuckets, value => String(value)));
  let count = 0;
  for (let bucket = 0; bucket < Number(bucketCount); bucket += 1) {
    const id = String(bucket);
    if (excluded.has(id)) continue;
    if (bucketIsUnfinished(bucketStates[id])) count += 1;
  }
  return count;
}

export function computeDesiredActiveReviewers(
  bucketStates,
  maxActive,
  excludedBuckets = [],
  bucketCount = 6,
  nowMs = Date.now(),
  occupiedBuckets = [],
) {
  const excluded = new Set(Array.from(excludedBuckets, value => String(value)));
  const occupied = new Set(Array.from(occupiedBuckets, value => String(value)));
  const eligibleCount = Object.entries(bucketStates || {}).filter(([bucket, bucketState]) => (
    !excluded.has(String(bucket))
    && (occupied.has(String(bucket)) || bucketEligibleForScheduling(bucketState, nowMs))
  )).length;
  return Math.min(
    Number(maxActive) || 1,
    Math.min(eligibleCount, Number(bucketCount) || eligibleCount),
  );
}

export function selectPendingBuckets(bucketStates, maxActive, excludedBuckets = []) {
  const excluded = new Set(Array.from(excludedBuckets, value => String(value)));
  const entries = Object.entries(bucketStates).sort((a, b) => Number(a[0]) - Number(b[0]));
  const active = entries.filter(([bucket, state]) => !excluded.has(String(bucket)) && bucketCountsAsActive(state)).length;
  const free = Math.max(0, Number(maxActive) - active);
  return entries
    .filter(([bucket, state]) => !excluded.has(String(bucket)) && bucketNeedsReviewer(state))
    .slice(0, free)
    .map(([bucket]) => bucket);
}

export function selectReviewerSlotCandidates(bucketStates, excludedBuckets = []) {
  const excluded = new Set(Array.from(excludedBuckets, value => String(value)));
  const ranked = [];
  for (const [bucket, bucketState] of Object.entries(bucketStates).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (excluded.has(bucket) || !bucketIsUnfinished(bucketState)) continue;
    if (bucketBlocksCandidateActivation(bucketState)) continue;
    if (bucketState.phase === 'PAUSED' && bucketState.chatUrl && !bucketState.sourcePackResumePending) {
      ranked.push({ bucket, priority: 1 });
    } else if (bucketState.phase === 'ACTIVE' && bucketState.chatUrl && !bucketHasGenerationReservation(bucketState)) {
      ranked.push({ bucket, priority: 3 });
    } else if (bucketNeedsReviewer(bucketState)) {
      ranked.push({ bucket, priority: 4 });
    }
  }
  ranked.sort((a, b) => a.priority - b.priority || Number(a.bucket) - Number(b.bucket));
  return ranked.map(entry => entry.bucket);
}

export function shouldClearStaleGenerationReservation({ bucketState, isGenerating, stallReason }) {
  if (!bucketState) return false;
  const staleGeneratingLastAction = String(bucketState.lastAction || '').startsWith('generating');
  if (!bucketHasGenerationReservation(bucketState)) {
    if (staleGeneratingLastAction && !isGenerating) {
      if (stallReason) return true;
      if (bucketState.phase === 'SETUP_WAIT' && bucketState.lastMessageReceivedAt && !bucketState.awaitingResponseAt) {
        return true;
      }
      if (!bucketState.awaitingResponseAt && !bucketState.awaitingActionId) return true;
    }
    return false;
  }
  if (isGenerating) return false;
  if (stallReason) return true;
  if (bucketState.phase === 'SETUP_WAIT' && bucketState.lastMessageReceivedAt && !bucketState.awaitingResponseAt) {
    return true;
  }
  return false;
}

export function setupAckTimedOut(bucketState, timeoutMinutes = 5, currentTimeMs = Date.now()) {
  if (!bucketState || bucketState.phase !== 'SETUP_WAIT' || !bucketState.awaitingResponseAt) return false;
  const awaitingAt = Date.parse(bucketState.awaitingResponseAt);
  if (!Number.isFinite(awaitingAt)) return false;
  const timeoutMs = Math.max(1, Number(timeoutMinutes) || 5) * 60 * 1000;
  return Number(currentTimeMs) - awaitingAt >= timeoutMs;
}

export function isRecoverableReadbackFooter(footer) {
  if (!footer || footer.status !== 'NORMAL') return false;
  const blocker = String(footer.blocker || '').trim().toUpperCase();
  if (blocker === 'NEXT_SOURCE_PACKS_REQUIRED') return false;
  if (footer.writesVerified !== 'YES') return true;
  if (!blocker || blocker === 'NONE') return false;
  return /(READBACK|WRITE[_ -]?VERIFY|UNVERIFIED[_ -]?WRITES?|VERIFICATION[_ -]?REQUIRED)/.test(blocker);
}

export function isRecoverableRegistryWriteFooter(footer) {
  if (!footer || footer.status !== 'ERROR') return false;
  if (!['NO', 'PARTIAL'].includes(String(footer.writesVerified || '').toUpperCase())) return false;
  const blocker = String(footer.blocker || '').trim().toUpperCase();
  return /^(?:REGISTRY_WRITE_NOT_COMPLETED|REGISTRY_WRITE_INCOMPLETE|REGISTRY_READBACK_REQUIRED|WRITE_VERIFICATION_REQUIRED|REGISTRY_WRITE_BLOCKED_BY_CONNECTOR_GUARD|ROWS_\d+_\d+_WRITE_ISSUED_READBACK_UNVERIFIED)$/.test(blocker);
}

export function recoverablePackNumberFromFooter(footer) {
  if (!footer || footer.status !== 'NORMAL' || footer.writesVerified !== 'YES' || footer.triggerCoordinator !== 'NO') return null;
  const blocker = String(footer.blocker || '').trim().toUpperCase();
  const match = blocker.match(/^PACK_(\d{6})_(?:JSONL_)?(?:NOT_YET_RESOLVED|UNAVAILABLE|NOT_FOUND)$/);
  return match ? Number(match[1]) : null;
}

export function isRecoverableUnavailableSourcePackFooter(footer) {
  return Boolean(
    footer
    && footer.status === 'ERROR'
    && footer.writesVerified === 'YES'
    && String(footer.blocker || '').trim().toUpperCase() === 'SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED',
  );
}

export function isRecoverableSourcePackHoldIncident(incident, bucketState) {
  if (!incident || !bucketState) return false;
  if (incident.kind === 'NEXT_SOURCE_PACKS_REQUIRED') return true;
  if (incident.kind !== 'REVIEWER_ERROR_FOOTER') return false;
  const footer = incident.footer;
  if (isRecoverableUnavailableSourcePackFooter(footer)) {
    return parseSourcePackNumber(bucketState.sourcePackTargetNumber, incident.bucket) !== null;
  }
  if (isSourcePackBoundaryFooter(footer)) return true;
  return Number.isInteger(recoverablePackNumberFromFooter(footer));
}

export function isRecoverableAdvisoryCoordinatorFooter(footer) {
  if (!footer || footer.writesVerified !== 'YES' || footer.triggerCoordinator !== 'YES') return false;
  const blocker = String(footer.blocker || '').trim().toUpperCase();
  if (footer.status === 'NORMAL' && blocker === 'NONE') return true;
  return footer.status === 'ERROR'
    && blocker === 'TERMINAL_DUPLICATE_CLASSIFICATION_COLLISION';
}

export function isRecoverableTurnBoundaryFooter(footer) {
  if (!footer || footer.status !== 'NORMAL') return false;
  if (footer.writesVerified !== 'YES' || footer.triggerCoordinator !== 'NO') return false;
  const blocker = String(footer.blocker || '').trim().toUpperCase();
  return /^(?:TURN_(?:CAPACITY|TOOL_LIMIT|TOKEN_LIMIT|TIME_LIMIT|OUTPUT_LIMIT|CONTEXT_LIMIT|BUDGET)|TURN_LIMIT)$/.test(blocker);
}

export function shouldEscalateFooter(footer) {
  if (!footer) return false;
  if (isRecoverableUnavailableSourcePackFooter(footer)) return false;
  if (isRecoverableAdvisoryCoordinatorFooter(footer)) return false;
  if (footer.status === 'ERROR') return true;
  if (footer.triggerCoordinator === 'YES') return true;
  if (isRecoverableTurnBoundaryFooter(footer)) return false;
  if (footer.status !== 'COMPLETE' && footer.blocker && footer.blocker.toUpperCase() !== 'NONE') return true;
  return false;
}

export function isSourcePackBoundaryFooter(footer) {
  return Boolean(
    footer
    && footer.status === 'NORMAL'
    && footer.writesVerified === 'YES'
    && String(footer.blocker || '').trim().toUpperCase() === 'NEXT_SOURCE_PACKS_REQUIRED',
  );
}

export function isValidSourcePackNumber(bucket, packNumber) {
  const config = sourcePackShardForBucket(bucket);
  return Boolean(
    config
    && Number.isInteger(packNumber)
    && packNumber > 0,
  );
}

export function isSourcePackBeyondInventory(packNumber, inventoryLastPack) {
  const target = Number(packNumber);
  const lastAvailable = Number(inventoryLastPack);
  return Number.isInteger(target)
    && target > 0
    && Number.isInteger(lastAvailable)
    && lastAvailable > 0
    && target > lastAvailable;
}

export function parseSourcePackNumber(value, bucket = null) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (bucket === null || bucket === undefined) return parsed > 0 ? parsed : null;
  return isValidSourcePackNumber(bucket, parsed) ? parsed : null;
}

export function packNumberFromFilename(filename, bucket = null) {
  if (!filename || typeof filename !== 'string') return null;
  const match = filename.match(/(?:^|\/)pack_(\d{6})\.jsonl$/i);
  if (!match) return null;
  return parseSourcePackNumber(Number(match[1]), bucket);
}

export function extractPackNumbersFromText(text, bucket = null) {
  const source = String(text ?? '');
  const numbers = new Set();
  for (const match of source.matchAll(/pack_(\d{6})\.jsonl/gi)) {
    const parsed = parseSourcePackNumber(Number(match[1]), bucket);
    if (parsed !== null) numbers.add(parsed);
  }
  for (const match of source.matchAll(/PACK_(\d{6})(?:_|$|\b)/gi)) {
    const parsed = parseSourcePackNumber(Number(match[1]), bucket);
    if (parsed !== null) numbers.add(parsed);
  }
  return [...numbers].sort((a, b) => a - b);
}

export function responseIndicatesSourcePackUnavailable(text, filename) {
  const source = String(text ?? '');
  const target = String(filename ?? '').trim();
  if (!source || !target) return false;
  const targetLower = target.toLowerCase();
  const segments = source
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map(segment => segment.trim())
    .filter(Boolean);
  const unavailable = /\b(?:not\s+(?:currently\s+)?(?:visible|available|found|accessible|present)|(?:is|was|remains?)\s+(?:unavailable|absent|missing)|unavailable|absent|missing|cannot\s+(?:be\s+)?(?:opened?|access(?:ed)?|found|located|verified)|can't\s+(?:be\s+)?(?:opened?|access(?:ed)?|find|locate|verify)|could\s+not\s+(?:be\s+)?(?:opened?|access(?:ed)?|find|locate|verify)|unable\s+to\s+(?:open|access|find|locate|verify)|(?:is|was|has|had)\s+not\s+been\s+(?:opened|accessed|found|located|verified))\b/i;
  return segments.some(segment => (
    segment.toLowerCase().includes(targetLower) && unavailable.test(segment)
  ));
}

export function extractLastVisibleSourcePackNumber(text, bucket) {
  const source = String(text ?? '');
  const match = source.match(/(?:extend(?:s|ed)?\s+through|visible[^.\n]{0,80}through|(?:available|visible)[^.\n]{0,80}ends?\s+(?:at|with))\s+pack_(\d{6})\.jsonl/i);
  if (!match) return null;
  return parseSourcePackNumber(Number(match[1]), bucket);
}

export function nextSourcePackNumber({ startPack, incidentId, lastDeliveredNumber, lastDeliveredIncidentId, bucket = null }) {
  const start = Number(startPack);
  if (!Number.isInteger(start) || start < 0) return null;
  const last = parseSourcePackNumber(lastDeliveredNumber, bucket);
  if (last === null) return start;
  if (last < start) return start;
  if (incidentId && String(lastDeliveredIncidentId || '') === String(incidentId)) return last;
  return last + 1;
}

export function sourcePackFilename(packNumber, bucket = null) {
  const parsed = bucket === null || bucket === undefined
    ? parseSourcePackNumber(packNumber)
    : parseSourcePackNumber(packNumber, bucket);
  if (parsed === null) return null;
  return `pack_${String(parsed).padStart(6, '0')}.jsonl`;
}

export function isInvalidZeroSourcePackFilename(filename) {
  return String(filename || '').toLowerCase() === 'pack_000000.jsonl';
}

export function resolveNextSourcePackTargetNumber(bucket, {
  bucketState = {},
  incident = null,
  incidentId = null,
  responseText = null,
} = {}) {
  const shard = sourcePackShardForBucket(bucket);
  if (!shard) return { targetNumber: null, reason: 'shard-missing' };

  const resolvedIncidentId = incidentId
    || bucketState.sourcePackResumeIncidentId
    || incident?.id
    || null;

  const explicitTarget = parseSourcePackNumber(bucketState.sourcePackTargetNumber, bucket);
  const explicitFilename = packNumberFromFilename(bucketState.sourcePackTargetFilename, bucket);
  if (explicitTarget !== null) {
    if (explicitFilename !== null && explicitFilename !== explicitTarget) {
      return { targetNumber: null, reason: 'target-filename-conflict' };
    }
    return {
      targetNumber: explicitTarget,
      reason: 'explicit-target',
      lastConsumed: parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, bucket)
        ?? parseSourcePackNumber(bucketState.sourcePackLastDeliveredNumber, bucket),
    };
  }

  const lastConsumed = parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, bucket)
    ?? parseSourcePackNumber(bucketState.sourcePackLastVisibleNumber, bucket)
    ?? parseSourcePackNumber(bucketState.sourcePackLastDeliveredNumber, bucket);

  if (lastConsumed !== null) {
    const targetNumber = nextSourcePackNumber({
      // The source-code example contains redacted/stale startPack values.
      // Advance only from a durable or response-evidenced cursor.
      startPack: lastConsumed,
      incidentId: resolvedIncidentId,
      lastDeliveredNumber: lastConsumed,
      lastDeliveredIncidentId: bucketState.sourcePackLastDeliveredIncidentId,
      bucket,
    });
    if (isValidSourcePackNumber(bucket, targetNumber)) {
      return { targetNumber, reason: 'last-consumed-plus-one', lastConsumed };
    }
  }

  const footerPack = recoverablePackNumberFromFooter(incident?.footer);
  if (isValidSourcePackNumber(bucket, footerPack)) {
    return { targetNumber: footerPack, reason: 'incident-footer-pack', lastConsumed };
  }

  const evidenceTexts = [
    responseText,
    bucketState.sourcePackBoundaryResponsePreview,
    bucketState.lastMessageReceivedPreview,
  ].filter(Boolean);

  for (const text of evidenceTexts) {
    const lastVisible = extractLastVisibleSourcePackNumber(text, bucket);
    if (lastVisible !== null) {
      const targetNumber = lastVisible + 1;
      if (isValidSourcePackNumber(bucket, targetNumber)) {
        return { targetNumber, reason: 'visible-through-plus-one', lastConsumed: lastVisible, lastVisible };
      }
    }
  }

  for (const text of evidenceTexts) {
    const packNumbers = extractPackNumbersFromText(text, bucket);
    if (!packNumbers.length) continue;
    const highest = packNumbers[packNumbers.length - 1];
    const targetNumber = (incident?.kind === 'NEXT_SOURCE_PACKS_REQUIRED'
      || isSourcePackBoundaryFooter(incident?.footer))
      ? highest + 1
      : highest;
    if (isValidSourcePackNumber(bucket, targetNumber)) {
      return { targetNumber, reason: 'highest-mentioned-pack', lastConsumed: highest };
    }
  }

  return { targetNumber: null, reason: 'SOURCE_PACK_CURSOR_UNRESOLVED', lastConsumed };
}

export function advanceSourcePackAfterBoundary(bucket, bucketState, {
  incidentId = null,
  incident = null,
  responseText = null,
} = {}) {
  const bucketNumber = Number(bucket);
  if (!bucketState || !Number.isInteger(bucketNumber)) {
    return { ok: false, reason: 'invalid-input', consumed: null, nextPack: null, nextFilename: null };
  }

  sanitizeStoredSourcePackCursorFields(bucketNumber, bucketState);

  const explicitCurrent = parseSourcePackNumber(bucketState.sourcePackTargetNumber, bucketNumber);
  const explicitFilename = sourcePackFilename(explicitCurrent, bucketNumber);
  if (explicitCurrent !== null
    && explicitFilename
    && responseIndicatesSourcePackUnavailable(responseText, explicitFilename)) {
    return {
      ok: false,
      reason: 'current-pack-unavailable',
      consumed: parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, bucketNumber),
      nextPack: null,
      nextFilename: null,
    };
  }

  const consumed = parseSourcePackNumber(bucketState.sourcePackTargetNumber, bucketNumber)
    ?? parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, bucketNumber)
    ?? parseSourcePackNumber(bucketState.sourcePackLastVisibleNumber, bucketNumber)
    ?? parseSourcePackNumber(bucketState.sourcePackLastDeliveredNumber, bucketNumber);

  if (consumed === null) {
    return { ok: false, reason: 'missing-current-pack', consumed: null, nextPack: null, nextFilename: null };
  }

  bucketState.sourcePackLastConsumedNumber = consumed;
  bucketState.sourcePackLastDeliveredNumber = consumed;

  const resolvedIncidentId = incidentId
    || bucketState.sourcePackResumeIncidentId
    || bucketState.sourcePackLastDeliveredIncidentId
    || incident?.id
    || null;

  const cursorForResolve = {
    ...bucketState,
    sourcePackTargetNumber: null,
    sourcePackTargetFilename: null,
    sourcePackLastConsumedNumber: consumed,
    sourcePackLastDeliveredIncidentId: null,
  };

  const resolved = resolveNextSourcePackTargetNumber(bucketNumber, {
    bucketState: cursorForResolve,
    incident,
    incidentId: resolvedIncidentId,
    responseText,
  });

  if (!isValidSourcePackNumber(bucketNumber, resolved.targetNumber)) {
    return {
      ok: false,
      reason: resolved.reason || 'invalid-next-pack',
      consumed,
      nextPack: null,
      nextFilename: null,
      resolved,
    };
  }

  if (resolved.targetNumber <= consumed) {
    return {
      ok: false,
      reason: 'next-not-after-consumed',
      consumed,
      nextPack: resolved.targetNumber,
      nextFilename: sourcePackFilename(resolved.targetNumber, bucketNumber),
      resolved,
    };
  }

  const nextFilename = sourcePackFilename(resolved.targetNumber, bucketNumber);
  bucketState.sourcePackTargetNumber = resolved.targetNumber;
  bucketState.sourcePackTargetFilename = nextFilename;
  bucketState.sourcePackResumePending = true;
  bucketState.sourcePackResumeIncidentId = resolvedIncidentId;
  if (Number.isInteger(resolved.lastConsumed)) {
    bucketState.sourcePackLastConsumedNumber = resolved.lastConsumed;
  }
  if (Number.isInteger(resolved.lastVisible)) {
    bucketState.sourcePackLastVisibleNumber = resolved.lastVisible;
  }
  resetSourcePackAccessState(bucketState);
  bucketState.sourcePackUnavailableCount = 0;
  bucketState.sourcePackLastUnavailableAt = null;
  bucketState.sourcePackRetryNotBefore = null;

  return {
    ok: true,
    consumed,
    nextPack: resolved.targetNumber,
    nextFilename,
    resolved,
    incidentId: resolvedIncidentId,
  };
}

export function sanitizeStoredSourcePackCursorFields(bucket, bucketState) {
  if (!bucketState || typeof bucketState !== 'object') return false;
  let changed = false;
  const bucketNumber = Number(bucket);

  if (isInvalidZeroSourcePackFilename(bucketState.sourcePackTargetFilename)
    || parseSourcePackNumber(bucketState.sourcePackTargetNumber, bucketNumber) === null && bucketState.sourcePackTargetNumber !== null && bucketState.sourcePackTargetNumber !== undefined) {
    bucketState.sourcePackTargetNumber = null;
    bucketState.sourcePackTargetFilename = null;
    changed = true;
  }

  if (parseSourcePackNumber(bucketState.sourcePackLastDeliveredNumber, bucketNumber) === null
    && bucketState.sourcePackLastDeliveredNumber !== null
    && bucketState.sourcePackLastDeliveredNumber !== undefined) {
    bucketState.sourcePackLastDeliveredNumber = null;
    changed = true;
  }

  if (parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, bucketNumber) === null
    && bucketState.sourcePackLastConsumedNumber !== null
    && bucketState.sourcePackLastConsumedNumber !== undefined) {
    bucketState.sourcePackLastConsumedNumber = null;
    changed = true;
  }

  if (parseSourcePackNumber(bucketState.sourcePackLastVisibleNumber, bucketNumber) === null
    && bucketState.sourcePackLastVisibleNumber !== null
    && bucketState.sourcePackLastVisibleNumber !== undefined) {
    bucketState.sourcePackLastVisibleNumber = null;
    changed = true;
  }

  const filenameNumber = packNumberFromFilename(bucketState.sourcePackTargetFilename, bucketNumber);
  if (bucketState.sourcePackTargetFilename && filenameNumber === null) {
    bucketState.sourcePackTargetFilename = null;
    changed = true;
  }

  return changed;
}

export function exactSourcePackFilenameMatches(filename, packNumber) {
  return filename === sourcePackFilename(packNumber);
}

export const SOURCE_PACK_SHARDS = Object.freeze({
  0: { startPack: 1, folderId: 'LOCAL_ONLY_BUCKET_0_FOLDER' },
  1: { startPack: 2, folderId: 'LOCAL_ONLY_BUCKET_1_FOLDER' },
  2: { startPack: 3, folderId: 'LOCAL_ONLY_BUCKET_2_FOLDER' },
  3: { startPack: 4, folderId: 'LOCAL_ONLY_BUCKET_3_FOLDER' },
  4: { startPack: 5, folderId: 'LOCAL_ONLY_BUCKET_4_FOLDER' },
  5: { startPack: 6, folderId: 'LOCAL_ONLY_BUCKET_5_FOLDER' },
});

export function sourcePackShardFolderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export function sourcePackShardForBucket(bucket) {
  return SOURCE_PACK_SHARDS[Number(bucket)] || null;
}

export function buildSourcePackContinuationPrompt(bucket, source) {
  return `Continue Bucket ${bucket} using the exact next R4.3.3 source pack in the connected Google Drive source. Before reviewing, locate and open the exact file named ${source.filename} in shard_${bucket} at ${source.folderUrl}. Use the connected Google Drive source capability. List the exact shard folder and paginate/continue the folder listing until either ${source.filename} is found or the folder listing is fully exhausted. A failed exact-name Drive search is not proof that a raw JSONL file is absent; exact-name search may be used only as a supplementary lookup after folder listing, and you must not stop merely because search returns no result. Do not substitute another pack. Do not infer source content from prior context. Reconcile R433_AUDIT_SHARD_${bucket} against this exact pack, skip every valid terminalized stable_id, and process as many additional eligible owned cases as this turn can safely complete. Persist and readback-verify every new result. Only if the exact shard folder listing has been exhausted and the exact Drive file still cannot be found/opened or its identity cannot be verified, stop without guessing and return STATUS: ERROR with BLOCKER: SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED and TRIGGER_COORDINATOR: YES. If this pack is exhausted and full-corpus owned cases remain, return STATUS: NORMAL, WRITES_VERIFIED: YES, BLOCKER: NEXT_SOURCE_PACKS_REQUIRED, TRIGGER_COORDINATOR: NO. Current-pack exhaustion is never corpus completion. End with the required strict six-line AUDIT_TURN_STATUS footer.`;
}

function isControllerSideDeliveryMethod(method) {
  const value = String(method || '').trim().toLowerCase();
  if (!value) return false;
  if (value.includes('project') && value.includes('sources') && value.includes('upload')) return true;
  if (value === 'chat-attachment') return true;
  if (value.startsWith('drive-')) return true;
  return false;
}

export function isSourcePackAccessVerified(bucketState, targetNumber, incidentId) {
  return Boolean(
    bucketState
    && bucketState.sourcePackAccessVerified === true
    && bucketState.sourcePackTargetNumber === targetNumber
    && String(bucketState.sourcePackResumeIncidentId || '') === String(incidentId || ''),
  );
}

export function resetSourcePackAccessState(bucketState) {
  if (!bucketState || typeof bucketState !== 'object') return bucketState;
  bucketState.sourcePackAccessVerified = false;
  bucketState.sourcePackAccessVerifiedAt = null;
  bucketState.sourcePackRequestActionId = null;
  bucketState.sourcePackDeliveryVerified = false;
  bucketState.sourcePackDeliveryVerifiedAt = null;
  bucketState.sourcePackDeliveryMethod = null;
  bucketState.sourcePackDeliveryPath = null;
  bucketState.sourcePackDeliveryAttemptedAt = null;
  bucketState.sourcePackDeliveryLastFailureAt = null;
  return bucketState;
}

export function markSourcePackAccessVerified(bucketState, {
  targetNumber,
  incidentId,
  filename,
  requestActionId = null,
  verifiedAt = new Date().toISOString(),
}) {
  if (!bucketState || typeof bucketState !== 'object') return bucketState;
  bucketState.sourcePackAccessVerified = true;
  bucketState.sourcePackAccessVerifiedAt = verifiedAt;
  bucketState.sourcePackRequestActionId = requestActionId || bucketState.sourcePackRequestActionId || null;
  bucketState.sourcePackTargetNumber = targetNumber;
  bucketState.sourcePackTargetFilename = filename;
  bucketState.sourcePackResumeIncidentId = incidentId;
  bucketState.sourcePackUnavailableCount = 0;
  bucketState.sourcePackLastUnavailableAt = null;
  bucketState.sourcePackRetryNotBefore = null;
  return bucketState;
}

export function clearStaleControllerSideSourcePackVerification(bucketState) {
  if (!bucketState || typeof bucketState !== 'object') return false;
  const method = String(bucketState.sourcePackDeliveryMethod || '').trim().toLowerCase();
  const hadControllerSideVerification = Boolean(
    bucketState.sourcePackDeliveryVerified
    || isControllerSideDeliveryMethod(method),
  );
  if (!hadControllerSideVerification) return false;
  resetSourcePackAccessState(bucketState);
  return true;
}

export function sourcePackContinuationAlreadySent(bucketState, actionLedger, targetNumber, incidentId) {
  const actionIdValue = bucketState?.sourcePackLastDeliveredActionId;
  const action = actionIdValue ? actionLedger?.[actionIdValue] : null;
  if (bucketState.sourcePackLastDeliveredNumber !== targetNumber) return false;
  if (String(bucketState.sourcePackLastDeliveredIncidentId || '') !== String(incidentId || '')) return false;
  if (action?.status !== 'SENT') return false;
  if (!['SOURCE_PACK_CONTINUE', 'SOURCE_PACK_RETRY', 'WRITE_RECOVERY'].includes(String(action.kind || ''))) return false;

  if (bucketState.awaitingActionId === actionIdValue) return true;
  return isSourcePackAccessVerified(bucketState, targetNumber, incidentId);
}

export function bucketAwaitingExactSourcePackContinuation(bucketState) {
  if (!bucketState?.awaitingActionId) return false;
  return Boolean(
    bucketState.sourcePackResumePending
    || String(bucketState.lastMessageSentKind || '').startsWith('SOURCE_PACK'),
  );
}

export function shouldRetrySourcePackContinuation(bucketState) {
  if (!bucketState?.sourcePackResumePending) return false;
  const preview = String(bucketState.lastMessageReceivedPreview || '');
  return /SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED|cannot be opened or identity-verified|returns no pack_/i.test(preview);
}

export function sourcePackRetryDelayMs(unavailableCount) {
  const scheduleMinutes = [5, 15, 30, 60];
  const index = Math.min(scheduleMinutes.length - 1, Math.max(0, Number(unavailableCount || 1) - 1));
  return scheduleMinutes[index] * 60 * 1000;
}

export function sourcePackRetryReady(bucketState, nowMs = Date.now()) {
  if (!bucketState?.sourcePackRetryNotBefore) return true;
  const retryAt = Date.parse(bucketState.sourcePackRetryNotBefore);
  if (!Number.isFinite(retryAt)) return true;
  return nowMs >= retryAt;
}

export function isSourcePackContinuationActionKind(kind) {
  return ['SOURCE_PACK_CONTINUE', 'SOURCE_PACK_RETRY'].includes(String(kind || ''));
}

export function reviewerConfirmedSourcePackAccess(bucketState, footer, responseAction) {
  if (!bucketState || !footer || !responseAction) return false;
  if (!isSourcePackContinuationActionKind(responseAction.kind)) return false;
  if (responseAction.status !== 'SENT' || responseAction.deliveryVerified !== true || !responseAction.id) return false;
  if (String(bucketState.sourcePackLastDeliveredActionId || '') !== String(responseAction.id)) return false;
  if (parseSourcePackNumber(bucketState.sourcePackLastDeliveredNumber) !== parseSourcePackNumber(bucketState.sourcePackTargetNumber)) return false;
  if (isRecoverableUnavailableSourcePackFooter(footer)) return false;
  if (!Number.isInteger(parseSourcePackNumber(bucketState.sourcePackTargetNumber))) return false;
  return true;
}
