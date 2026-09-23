import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  actionResponseKey,
  actionId,
  classifyHoldType,
  createHoldRecord,
  advanceSourcePackAfterBoundary,
  assistantAfterActionMarker,
  bucketBlocksCandidateActivation,
  bucketHasGenerationReservation,
  bucketHasUnresolvedAwaitingAction,
  bucketIsUnfinished,
  bucketNeedsReviewer,
  bucketOccupiesLiveReviewerSlot,
  bucketOccupiesReviewerSlot,
  bucketReclaimableIdleSlot,
  buildLiveReviewerOccupancy,
  computeDesiredActiveReviewers,
  conversationRolloverReasonFromText,
  countOccupiedReviewerSlots,
  getBucketState,
  isExactSetupAck,
  isRecoverableAdvisoryCoordinatorFooter,
  isRecoverableReadbackFooter,
  isRecoverableRegistryWriteFooter,
  isRecoverableSourcePackHoldIncident,
  isRecoverableTurnBoundaryFooter,
  isRecoverableUnavailableSourcePackFooter,
  isSourcePackBoundaryFooter,
  isVerifiedCorpusCompletion,
  markSourcePackAccessVerified,
  normalizeBucketId,
  parseSourcePackNumber,
  packNumberFromFilename,
  isValidSourcePackNumber,
  isInvalidZeroSourcePackFilename,
  resolveNextSourcePackTargetNumber,
  sanitizeStoredSourcePackCursorFields,
  extractLastVisibleSourcePackNumber,
  extractPackNumbersFromText,
  responseIndicatesSourcePackUnavailable,
  parseCorpusCompletionEvidence,
  parseFooter,
  recoverablePackNumberFromFooter,
  resetPerChatObservationState,
  resetSourcePackAccessState,
  clearStaleControllerSideSourcePackVerification,
  buildSourcePackContinuationPrompt,
  reviewerConfirmedSourcePackAccess,
  selectPendingBuckets,
  selectReviewerSlotCandidates,
  setupAckTimedOut,
  sha16,
  shouldClearStaleGenerationReservation,
  shouldEscalateFooter,
  shouldRetrySourcePackContinuation,
  sourcePackRetryDelayMs,
  sourcePackRetryReady,
  sourcePackContinuationAlreadySent,
  sourcePackFilename,
  sourcePackShardFolderUrl,
  isSourcePackBeyondInventory,
  validateConservativeSourcePackBoundary,
  isHoldRetryDue,
  holdValidationKind,
} from './protocol.mjs';
import {
  buildOperationsStatus,
  normalizeOperationsState,
  recordActivityEvent,
  recordAuditProgressEvent,
  recordSourcePackTransition,
} from './operations.mjs';
import { ensureHighestReviewerModel, REQUIRED_REVIEWER_EFFORT, REQUIRED_REVIEWER_MODEL } from './reviewer-model.mjs';
import { classifyReviewerHealth, ensureBrowserPageBudget, findActualGeneration } from './reviewer-tabs.mjs';
import {
  AUTOMATION_BOOTSTRAP_URL,
  cleanupAutomationProfileEphemeral,
  connectOrLaunchBrowser,
  terminateOwnedBrowserProcessGroup,
} from './browser-runtime.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1')), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const STATUS_PATH = path.join(ROOT, 'data', 'status.json');
const CONTROL_PATH = path.join(ROOT, 'data', 'control.json');
const COORDINATOR_STATUS_PATH = path.join(ROOT, 'data', 'coordinator-status.json');
const LOG_PATH = path.join(ROOT, 'logs', 'controller.log');
const INCIDENT_DIR = path.join(ROOT, 'data', 'incidents');
const COORDINATOR_WAKE = path.join(ROOT, 'CoordinatorWake.ps1');
const COORDINATOR_WAKE_STDOUT = path.join(ROOT, 'logs', 'coordinator-wake.stdout.log');
const COORDINATOR_WAKE_STDERR = path.join(ROOT, 'logs', 'coordinator-wake.stderr.log');
const SOURCE_PACK_READY_PATH = path.join(ROOT, 'data', 'source-packs-ready.json');
const RECONCILIATION_EVIDENCE_PATH = path.join(ROOT, 'config', 'reconciliation-evidence.json');

function dispatchStartGraceMs() {
  const configured = Number(config.dispatchStartGraceSeconds);
  if (Number.isFinite(configured) && configured > 0) return configured * 1000;
  return Math.max(45000, Number(config.pollSeconds || 12) * 3 * 1000);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
const MAX_ACTIVE_REVIEWERS = 2;
const MAX_REVIEWER_TABS = 2;
const MAX_AUTOMATION_TABS = 3;
function sourcePackShardMappingStatus() {
  const mapping = config.sourcePackShards;
  const missingBuckets = [];
  const placeholderBuckets = [];
  for (let bucket = 0; bucket < 6; bucket += 1) {
    const folderId = String(mapping?.[String(bucket)]?.folderId || '').trim();
    if (!folderId) missingBuckets.push(bucket);
    else if (/^(?:LOCAL_ONLY|PLACEHOLDER|REPLACE_ME|UNKNOWN)/i.test(folderId)) placeholderBuckets.push(bucket);
  }
  return {
    ready: missingBuckets.length === 0 && placeholderBuckets.length === 0,
    missingBuckets,
    placeholderBuckets,
  };
}

function configuredSourcePackShard(bucket) {
  const key = String(Number(bucket));
  const status = sourcePackShardMappingStatus();
  if (status.missingBuckets.includes(Number(key)) || status.placeholderBuckets.includes(Number(key))) return null;
  const folderId = String(config.sourcePackShards?.[key]?.folderId || '').trim();
  return folderId ? { folderId } : null;
}

function browserLaunchProfile() {
  const userConfigRoot = process.env.HOME || process.env.USERPROFILE || '';
  const braveUserDataDir = userConfigRoot
    ? path.join(userConfigRoot, '.config', 'BraveSoftware', 'Brave-Browser')
    : null;
  const braveDefaultProfile = braveUserDataDir && path.join(braveUserDataDir, 'Default');
  const hasExistingBraveProfile = Boolean(braveDefaultProfile && fs.existsSync(braveDefaultProfile));
  const firefoxFallbackProfile = config.firefoxProfileDir
    || (userConfigRoot ? path.join(userConfigRoot, '.config', 'R433-Firefox-Fallback') : path.join(ROOT, 'data', 'firefox-profile'));
  return {
    profileMode: config.browserProfileMode || 'source',
    profileDir: config.browserProfileDir
      || (hasExistingBraveProfile ? braveUserDataDir : path.join(ROOT, 'chrome-profile')),
    preferredExecutable: config.browserExecutable
      || config.browserPath
      || config.chromeExecutable
      || (hasExistingBraveProfile ? 'brave-browser' : null),
    firefoxFallbackEnabled: config.firefoxFallbackEnabled !== false,
    firefoxExecutable: config.firefoxExecutable || null,
    firefoxCandidates: config.firefoxCandidates || [],
    firefoxProfileDir: firefoxFallbackProfile,
  };
}

const SCHEDULING_BLOCKED_BUCKETS = new Set(
  (Array.isArray(config.schedulingBlockedBuckets) ? config.schedulingBlockedBuckets : [])
    .map(Number)
    .filter(bucket => Number.isInteger(bucket) && bucket >= 0 && bucket < Number(config.bucketCount || 0)),
);

function isSchedulingBlockedBucket(bucket) {
  return SCHEDULING_BLOCKED_BUCKETS.has(Number(bucket));
}

function desiredReviewerSlotCount(liveGenerationCount = 0) {
  const candidates = selectReviewerSlotCandidates(state.buckets, SCHEDULING_BLOCKED_BUCKETS)
    .filter(bucket => !state.buckets[String(bucket)]?.sourcePackCursorReconciliationRequired);
  return Math.min(
    MAX_REVIEWER_TABS,
    Math.max(Number(liveGenerationCount) || 0, Math.min(MAX_REVIEWER_TABS, candidates.length)),
  );
}

function bucketStateFor(value) {
  return getBucketState(state, value, config.bucketCount);
}

for (const dir of [path.dirname(STATE_PATH), path.dirname(LOG_PATH), INCIDENT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function now() {
  return new Date().toISOString();
}

function log(message) {
  const line = `${now()} ${message}\n`;
  fs.appendFileSync(LOG_PATH, line, 'utf8');
  console.log(line.trim());
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readControl() {
  const control = loadJson(CONTROL_PATH, null);
  const present = Boolean(control && typeof control === 'object' && !Array.isArray(control));
  const desiredState = String(control?.desiredState || 'RECONCILIATION_ONLY').toUpperCase();
  return {
    desiredState: ['RUNNING', 'PAUSED', 'STOPPED', 'RECONCILIATION_ONLY'].includes(desiredState)
      ? desiredState
      : 'RECONCILIATION_ONLY',
    present,
    requestedAt: control?.requestedAt || null,
    requestedBy: control?.requestedBy || null,
  };
}

function controlPauseError() {
  const error = new Error('controller is paused before sending a new action');
  error.code = 'CONTROL_PAUSED';
  return error;
}

function assertControlRunning() {
  const control = readControl();
  if (control.desiredState === 'PAUSED') throw controlPauseError();
  if (control.desiredState === 'STOPPED') {
    const error = new Error('controller was stopped before sending a new action');
    error.code = 'CONTROL_STOPPED';
    throw error;
  }
  if (control.desiredState !== 'RUNNING' || !preDispatchReady) {
    const error = new Error('controller is reconciling startup state; new actions remain disabled until pre-dispatch evidence is ready');
    error.code = 'CONTROL_RECONCILIATION_ONLY';
    throw error;
  }
}

function saveJsonAtomic(file, value) {
  // Multiple controller instances can briefly overlap during watchdog recovery.
  // Keep each staging file private so they cannot race on one shared .tmp path.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 8) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function projectConversationUrl(conversationId) {
  return `${config.projectUrl}/c/${conversationId}`;
}

function deferTransientHold(bucketState, reason, at = Date.now()) {
  const hold = bucketState?.hold;
  if (!hold || hold.type !== 'TRANSIENT_EXTERNAL') return false;
  const retryCount = Number(hold.retryCount || 0) + 1;
  const nextAttemptAt = new Date(at + [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000][Math.min(4, retryCount)]).toISOString();
  bucketState.transientHoldRetryCount = retryCount;
  bucketState.hold = createHoldRecord({
    ...hold,
    reason: reason || hold.reason,
    lastAttemptAt: new Date(at).toISOString(),
    nextAttemptAt,
    retryCount,
    validation: hold.validation,
  });
  return true;
}

function defaultBucketState(bucket) {
  const initial = config.buckets[String(bucket)] ?? {};
  const conversationId = initial.conversationId || null;
  const corpusCompleteVerified = Boolean(initial.corpusCompleteVerified);
  const complete = corpusCompleteVerified;
  return {
    complete,
    corpusCompleteVerified,
    chatId: conversationId,
    chatUrl: conversationId ? projectConversationUrl(conversationId) : null,
    newChatCreation: null,
    reviewerModelVerification: null,
    phase: complete ? 'COMPLETE' : conversationId ? 'ACTIVE' : 'PENDING',
    hold: complete ? { type: 'COMPLETE', reason: 'FULL_CORPUS_RECONCILED', retryPolicy: 'NONE', nextAttemptAt: null } : null,
    transientHoldRetryCount: 0,
    lastHash: null,
    processedHash: null,
    processedResponseKey: null,
    lastProcessedActionId: null,
    lastProcessedStatus: null,
    lastProcessedBlocker: null,
    candidateHash: null,
    candidateCount: 0,
    candidateActionId: null,
    candidateObservedAt: null,
    lastSeen: null,
    lastAction: null,
    lastSentAt: 0,
    lastMessageSentAt: null,
    lastMessageSentKind: null,
    lastMessageSentActionId: null,
    lastMessageReceivedAt: null,
    lastMessageReceivedHash: null,
    lastMessageReceivedPreview: null,
    lastResponseLatencyMs: null,
    casesReported: 0,
    casesSinceChatStart: 0,
    awaitingResponseAt: null,
    awaitingActionId: null,
    responseBaselineHash: null,
    setupVerified: false,
    setupVerifiedChatId: null,
    malformedCount: 0,
    transientFailures: 0,
    noAssistantCount: 0,
    generationSeenSinceAction: false,
    generationObservedAt: null,
    writeRecoveryResumePending: false,
    writeRecoveryIncidentId: null,
    writeRecoveryInterruptedActionId: null,
    advisoryAnomalyResumePending: false,
    advisoryAnomalyInterruptedActionId: null,
    chatHistory: [],
    rolloverCount: 0,
    lastRolloverAt: null,
    lastRolloverReason: null,
    sourcePackResumePending: false,
    sourcePackResumeIncidentId: null,
    sourcePackTargetNumber: null,
    sourcePackTargetFilename: null,
    sourcePackLastConsumedNumber: null,
    sourcePackLastVisibleNumber: null,
    sourcePackBoundaryResponsePreview: null,
    sourcePackLastDeliveredNumber: null,
    sourcePackLastDeliveredIncidentId: null,
    sourcePackLastDeliveredAt: null,
    sourcePackLastDeliveredActionId: null,
    sourcePackCursorEvidence: null,
    sourcePackCursorReconciliationRequired: true,
    sourcePackDeferredHold: null,
    sourcePackAccessVerified: false,
    sourcePackAccessVerifiedAt: null,
    sourcePackRequestActionId: null,
    sourcePackUnavailableCount: 0,
    sourcePackLastUnavailableAt: null,
    sourcePackRetryNotBefore: null,
    lastProgressAt: null,
    lastProgressActionId: null,
    lastProgressNewCases: null,
    lastProgressWritesVerified: null,
    lastProgressPack: null,
    lastRegistryWriteAt: null,
    lastRegistryWriteVerified: null,
    reviewerSlotId: null,
    lastSourcePackTransitionAt: null,
    lastSourcePackTransitionFrom: null,
    lastSourcePackTransitionTo: null,
  };
}

function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const storedVersion = state.version;
  if (storedVersion !== undefined
    && (!Number.isInteger(storedVersion) || storedVersion < 1 || storedVersion > 3)) {
    const error = new Error(`unsupported durable state schema version: ${String(storedVersion)}`);
    error.code = 'DURABLE_STATE_SCHEMA_UNSUPPORTED';
    throw error;
  }
  state.version = 3;
  state.startedAt ||= now();
  state.buckets ||= {};
  state.actions ||= {};
  state.incidents ||= {};
  state.completedAt ||= null;
  state.runState ||= 'RUNNING';
  state.runStartedAt ||= state.startedAt;
  state.workingMs = Number(state.workingMs || 0);
  state.lastWorkingAt ||= state.startedAt;
  state.pausedAt ||= null;
  state.metrics ||= {};
  state.metrics.casesReported = Number(state.metrics.casesReported || 0);
  state.metrics.casesReportedByBucket ||= {};
  state.metrics.progressBasis ||= 'sum of accepted NEW_CASES footer values observed by this controller';
  state.coordinator ||= {};

  normalizeOperationsState(state);

  for (let bucket = 0; bucket < Number(config.bucketCount); bucket += 1) {
    const key = String(bucket);
    const defaults = defaultBucketState(bucket);
    const existing = state.buckets[key] && typeof state.buckets[key] === 'object'
      ? state.buckets[key]
      : {};
    const merged = { ...defaults, ...existing };

    if (!merged.chatUrl && merged.chatId) merged.chatUrl = projectConversationUrl(merged.chatId);
    if (!merged.newChatCreation || typeof merged.newChatCreation !== 'object') merged.newChatCreation = null;
    if (!merged.reviewerModelVerification || typeof merged.reviewerModelVerification !== 'object') merged.reviewerModelVerification = null;
    if (!Array.isArray(merged.chatHistory)) merged.chatHistory = [];
    merged.rolloverCount = Number(merged.rolloverCount || 0);
    merged.transientHoldRetryCount = Math.max(0, Number(merged.transientHoldRetryCount || 0));
    merged.casesSinceChatStart = Number(merged.casesSinceChatStart || 0);
    merged.generationSeenSinceAction = Boolean(merged.generationSeenSinceAction);
    merged.writeRecoveryResumePending = Boolean(merged.writeRecoveryResumePending);
    merged.advisoryAnomalyResumePending = Boolean(merged.advisoryAnomalyResumePending);
    merged.setupVerified = Boolean(merged.setupVerified);
    if (merged.setupVerified && merged.setupVerifiedChatId && merged.chatId
      && String(merged.setupVerifiedChatId) !== String(merged.chatId)) {
      merged.setupVerified = false;
      merged.setupVerifiedChatId = null;
    }
    merged.sourcePackUnavailableCount = Math.max(0, Number(merged.sourcePackUnavailableCount || 0));
    merged.sourcePackResumePending = Boolean(merged.sourcePackResumePending);
    sanitizeStoredSourcePackCursorFields(Number(key), merged);
    merged.sourcePackTargetNumber = parseSourcePackNumber(merged.sourcePackTargetNumber, Number(key));
    merged.sourcePackLastDeliveredNumber = parseSourcePackNumber(merged.sourcePackLastDeliveredNumber, Number(key));
    merged.sourcePackLastConsumedNumber = parseSourcePackNumber(merged.sourcePackLastConsumedNumber, Number(key));
    merged.sourcePackLastVisibleNumber = parseSourcePackNumber(merged.sourcePackLastVisibleNumber, Number(key));
    merged.sourcePackAccessVerified = Boolean(merged.sourcePackAccessVerified);
    if (!merged.sourcePackCursorEvidence || typeof merged.sourcePackCursorEvidence !== 'object'
      || Array.isArray(merged.sourcePackCursorEvidence)) merged.sourcePackCursorEvidence = null;
    merged.sourcePackCursorReconciliationRequired = merged.sourcePackCursorReconciliationRequired !== false;
    if (!merged.sourcePackDeferredHold || typeof merged.sourcePackDeferredHold !== 'object'
      || Array.isArray(merged.sourcePackDeferredHold)) merged.sourcePackDeferredHold = null;
    if (clearStaleControllerSideSourcePackVerification(merged)) {
      merged.sourcePackAccessVerified = false;
    }
    if (merged.sourcePackResumePending && shouldRetrySourcePackContinuation(merged)) {
      resetSourcePackAccessState(merged);
    }

    // v3 completion is fail-closed. Historical COMPLETE states represented only
    // exhaustion of then-visible source packs, so they must not retire a bucket.
    merged.corpusCompleteVerified = Boolean(merged.corpusCompleteVerified);
    merged.complete = merged.corpusCompleteVerified;

    if (merged.complete) {
      merged.phase = 'COMPLETE';
      merged.hold = merged.hold?.type === 'COMPLETE'
        ? merged.hold
        : { type: 'COMPLETE', reason: 'FULL_CORPUS_RECONCILED', retryPolicy: 'NONE', nextAttemptAt: null };
    } else if (merged.phase === 'COMPLETE') {
      merged.phase = merged.chatUrl ? 'ACTIVE' : 'PENDING';
      merged.hold = null;
    }
    if (!merged.complete && !merged.chatUrl && merged.phase !== 'HOLD') {
      merged.phase = 'PENDING';
    } else if (!merged.complete && merged.chatUrl && !['SETUP_WAIT', 'ACTIVE', 'HOLD', 'PAUSED'].includes(merged.phase)) {
      merged.phase = 'ACTIVE';
    }
    if (merged.phase === 'HOLD' && !merged.hold) {
      const incidentId = String(merged.lastAction || '').startsWith('incident:')
        ? String(merged.lastAction).slice('incident:'.length)
        : null;
      const incidentRecord = incidentId
        ? Object.values(state.incidents).find(entry => entry?.id === incidentId)
        : null;
      const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
      merged.hold = createHoldRecord({
        type: incident ? classifyHoldType(incident.kind, incident.footer, incident.detail) : 'INTEGRITY',
        reason: incident?.footer?.blocker || incident?.kind || 'LEGACY_HOLD_REQUIRES_RECONCILIATION',
        incidentId,
        bucket: Number(key),
        createdAt: incident?.detectedAt || now(),
        retryCount: merged.transientHoldRetryCount,
      });
    }
    state.buckets[key] = merged;
  }

  return state;
}

function readDurableState() {
  try {
    const text = fs.readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('durable state root must be a JSON object');
      error.code = 'DURABLE_STATE_INVALID';
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    error.code ||= 'DURABLE_STATE_INVALID';
    throw error;
  }
}

let startupStateError = null;
let state;
try {
  state = normalizeState(readDurableState());
} catch (error) {
  startupStateError = error;
  state = normalizeState(null);
}

const controllerStartedAt = now();
const previousRuntimeStatus = loadJson(STATUS_PATH, null);
function previousControllerStale(status, currentTimeMs = Date.now()) {
  if (!status || Number(status.controllerPid) === process.pid) return false;
  const wasRunning = ['RUNNING', 'RECOVERING', 'DEGRADED'].includes(String(status.controllerState || status.runState || '').toUpperCase());
  if (!wasRunning) return false;
  const heartbeatAt = Date.parse(status.heartbeatAt || status.updatedAt || '');
  const staleAfterMs = Math.max(10_000, Number(config.heartbeatStaleSeconds || 90) * 1000);
  let pidAlive = false;
  const pid = Number(status.controllerPid);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      pidAlive = true;
    } catch (error) {
      pidAlive = error?.code === 'EPERM';
    }
  }
  return !pidAlive || !Number.isFinite(heartbeatAt) || currentTimeMs - heartbeatAt > staleAfterMs;
}

function sourceHashFromDisk() {
  const files = ['src/controller.mjs', 'src/protocol.mjs', 'src/operations.mjs', 'src/reviewer-tabs.mjs', 'src/browser-runtime.mjs'];
  const hash = crypto.createHash('sha256');
  for (const relativePath of files) {
    try {
      hash.update(relativePath).update('\0').update(fs.readFileSync(path.join(ROOT, relativePath))).update('\0');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update(relativePath).update('\0MISSING\0');
    }
  }
  return hash.digest('hex');
}

function readGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 1500 }).trim();
  } catch {
    return null;
  }
}

const loadedSourceHash = sourceHashFromDisk();
const loadedGitSha = readGitSha();
let controllerLifecycleState = startupStateError ? 'ERROR' : 'RECOVERING';
state.controllerSessionStartedAt = now();
state.responseMonitoringStartedAt = state.controllerSessionStartedAt;

let lastLiveReviewerOccupancy = buildLiveReviewerOccupancy({
  bucketStates: state.buckets,
  liveGeneratingByBucket: {},
  excludedBuckets: SCHEDULING_BLOCKED_BUCKETS,
  maxActive: MAX_ACTIVE_REVIEWERS,
  bucketCount: config.bucketCount,
});
let lastLiveGeneratingByBucket = {};
let browserRuntimeStatus = {
  browserConnected: false,
  browserExecutable: null,
  browserPid: null,
  cdpEndpoint: null,
  browserTransport: null,
  chatgptReady: false,
  authenticationRequired: false,
  coordinatorHealth: null,
  coordinatorTabPresent: false,
  reviewerTabCount: 0,
  automationTabCount: 0,
  liveReviewerGenerations: 0,
  reviewerSlots: [],
};
let preDispatchReady = false;
let preDispatchEvidence = {
  ready: false,
  checkedAt: null,
  blockers: ['STARTUP_RECONCILIATION_PENDING'],
  eligibleBuckets: [],
};
let startupReconciliationComplete = false;
let browserContextRef = null;
let coordinatorPageRef = null;
let reviewerSlotRegistry = new Map();
let ownedBrowserProfile = {
  launched: false,
  pid: null,
  profileDir: null,
  profileDirectoryName: 'Default',
  profileMode: 'source',
  context: null,
};

function cleanupOwnedBrowserProfileIfStopped() {
  if (!ownedBrowserProfile.launched || !ownedBrowserProfile.profileDir) return [];
  if (ownedBrowserProfile.pid) {
    try {
      process.kill(Number(ownedBrowserProfile.pid), 0);
      return [];
    } catch (error) {
      if (error.code !== 'ESRCH') return [];
    }
  }
  if (ownedBrowserProfile.profileMode !== 'clone') {
    ownedBrowserProfile.launched = false;
    return [];
  }
  try {
    const removed = cleanupAutomationProfileEphemeral(ownedBrowserProfile);
    if (removed.length) log(`cleaned ${removed.length} stale owned browser profile lock file(s)`);
    ownedBrowserProfile.launched = false;
    return removed;
  } catch (error) {
    log(`unable to clean owned browser profile locks: ${error.message || error}`);
    return [];
  }
}

function saveState() {
  for (const bucketState of Object.values(state.buckets || {})) {
    if (['INTEGRITY', 'USER'].includes(bucketState.hold?.type) && bucketState.phase !== 'COMPLETE') {
      bucketState.phase = 'HOLD';
      continue;
    }
    if (bucketState.phase !== 'HOLD'
      && bucketState.phase !== 'COMPLETE'
      && !bucketHasUnresolvedAwaitingAction(bucketState)) bucketState.hold = null;
  }
  normalizeOperationsState(state);
  saveJsonAtomic(STATE_PATH, state);
}

function applyDurableConservativeReconciliation() {
  const record = loadJson(RECONCILIATION_EVIDENCE_PATH, null);
  const validation = validateConservativeSourcePackBoundary(5, record, {
    expectedAuditablePopulation: config.auditablePopulation,
  });
  const bucketState = state.buckets?.['5'];
  if (!bucketState) return { applied: false, valid: false, reason: 'B5_STATE_MISSING' };

  const proof = bucketState.sourcePackCursorEvidence;
  const staticProof = proof?.evidenceKind === 'CONSERVATIVE_RECONCILIATION';
  if (!validation.valid) {
    // A previously projected proof must fail closed if its committed source
    // record is removed or altered.  Existing action-attributed evidence is
    // left alone; it is independently validated by isVerifiedSourcePackCursor.
    if (staticProof) {
      bucketState.sourcePackCursorEvidence = null;
      bucketState.sourcePackCursorReconciliationRequired = true;
      bucketState.sourcePackResumePending = false;
      bucketState.sourcePackTargetNumber = null;
      bucketState.sourcePackTargetFilename = null;
      bucketState.sourcePackLastConsumedNumber = null;
      bucketState.sourcePackLastVisibleNumber = null;
      bucketState.sourcePackResumeIncidentId = null;
      bucketState.phase = 'HOLD';
      bucketState.hold = createHoldRecord({
        type: 'INTEGRITY',
        reason: 'CONSERVATIVE_RECONCILIATION_RECORD_INVALID',
        bucket: 5,
      });
      bucketState.lastAction = `conservative-reconciliation-rejected:${validation.reason}`;
      saveState();
    }
    return { applied: false, valid: false, reason: validation.reason };
  }

  const target = validation.nextPack;
  const consumed = validation.terminalThroughPack;
  const hasCursorFields = [
    bucketState.sourcePackTargetNumber,
    bucketState.sourcePackTargetFilename,
    bucketState.sourcePackLastConsumedNumber,
    bucketState.sourcePackLastVisibleNumber,
    bucketState.sourcePackLastDeliveredNumber,
  ].some(value => value !== null && value !== undefined && value !== '');
  const hasIndependentProof = proof && !staticProof;
  if (hasIndependentProof || (hasCursorFields && !staticProof)) {
    // A later action-attributed cursor always outranks this conservative
    // startup record. Never rewind a bucket that has already progressed.
    return { applied: false, valid: true, reason: 'EXISTING_CURSOR_PRESERVED' };
  }
  if (staticProof) return { applied: true, valid: true, reason: 'ALREADY_APPLIED' };
  if (bucketState.hold
    && !(bucketState.hold.type === 'INTEGRITY'
      && bucketState.hold.reason === 'SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED')) {
    return { applied: false, valid: true, reason: 'EXISTING_HOLD_PRESERVED' };
  }

  const verifiedAt = record.generatedAt || now();
  bucketState.sourcePackTargetNumber = target;
  bucketState.sourcePackTargetFilename = validation.nextFilename;
  bucketState.sourcePackLastConsumedNumber = consumed;
  bucketState.sourcePackLastVisibleNumber = consumed;
  bucketState.sourcePackLastDeliveredNumber = null;
  bucketState.sourcePackLastDeliveredIncidentId = null;
  bucketState.sourcePackLastDeliveredActionId = null;
  bucketState.sourcePackResumeIncidentId = validation.reconciliationId;
  bucketState.sourcePackResumePending = true;
  bucketState.sourcePackCursorReconciliationRequired = false;
  bucketState.sourcePackAccessVerified = false;
  bucketState.sourcePackAccessVerifiedAt = null;
  bucketState.sourcePackRequestActionId = null;
  bucketState.sourcePackCursorEvidence = {
    evidenceKind: 'CONSERVATIVE_RECONCILIATION',
    reconciliationStatus: 'CONSERVATIVE_RESUME',
    reconciliationId: validation.reconciliationId,
    bucket: 5,
    targetNumber: target,
    targetFilename: validation.nextFilename,
    sourceActionTargetFilename: validation.nextFilename,
    consumedNumber: consumed,
    terminalThroughPack: consumed,
    registryTerminalSetAuthoritative: true,
    registryTerminalRowsChanged: 0,
    registrySubstantiveFieldsChanged: 0,
    skipTerminalStableIds: true,
    overwriteTerminalRows: false,
    readbackVerifyNewWrites: true,
    fullCorpusReconciled: false,
    actionAwareCursorProven: false,
    boundaryMonotonic: true,
    verifiedAt,
  };
  bucketState.hold = null;
  bucketState.phase = bucketState.chatUrl ? 'ACTIVE' : 'PENDING';
  bucketState.lastAction = `conservative-reconciliation-applied:pack-${target}`;
  saveState();
  log(`B5: applied validated conservative source-pack boundary; exact next target=${validation.nextFilename}`);
  return { applied: true, valid: true, reason: 'APPLIED' };
}

function updateWorkingClock(nextState) {
  const at = Date.now();
  if (state.runState === 'RUNNING' && state.lastWorkingAt) {
    const last = Date.parse(state.lastWorkingAt);
    if (Number.isFinite(last) && at > last) state.workingMs += at - last;
  }
  state.runState = nextState;
  state.lastWorkingAt = new Date(at).toISOString();
  if (nextState === 'RUNNING') state.responseMonitoringStartedAt = state.lastWorkingAt;
  if (nextState === 'PAUSED') state.pausedAt = state.lastWorkingAt;
  if (nextState === 'RUNNING') state.pausedAt = null;
}

function syncControlState() {
  const control = readControl();
  if (control.desiredState !== state.runState) {
    updateWorkingClock(control.desiredState);
    saveState();
    log(`run state changed to ${control.desiredState}`);
  }
  return control;
}

function workingElapsedMs() {
  let total = Number(state.workingMs || 0);
  if (state.runState === 'RUNNING' && state.lastWorkingAt) {
    const last = Date.parse(state.lastWorkingAt);
    if (Number.isFinite(last)) total += Math.max(0, Date.now() - last);
  }
  return total;
}

function trimActionLedger() {
  const entries = Object.entries(state.actions);
  if (entries.length <= 2500) return;
  const protectedIds = new Set(Object.values(state.buckets || {}).flatMap(bucket => [
    bucket?.sourcePackCursorEvidence?.sourceActionId,
    bucket?.sourcePackCursorEvidence?.responseActionId,
    bucket?.awaitingActionId,
    bucket?.sourcePackLastDeliveredActionId,
  ].filter(Boolean)));
  entries
    .sort((a, b) => String(a[1]?.updatedAt ?? '').localeCompare(String(b[1]?.updatedAt ?? '')))
    .slice(0, entries.length - 2000)
    .filter(([key]) => !protectedIds.has(key))
    .forEach(([key]) => delete state.actions[key]);
}

function setupPrompt(bucket) {
  return `PROTOCOL SETUP ONLY. You are the R4.3.3 source-summary audit reviewer assigned Bucket ${bucket} in the Automated project.

Canonical registry:
${config.registryId}

Permanent ownership:
int(stable_id, 16) % 6 == ${bucket}

Exact write tab:
R433_AUDIT_SHARD_${bucket}

This is a continuation of the existing R4.3.3 audit, not a restart. Preserve every valid terminal result already persisted by earlier reviewers. Do not audit, inspect source cases, write the registry, or make a substantive decision from this setup message. Do not write any other shard, CONFIG, MASTER, or immutable reconciliation/archive tab.

For substantive turns after setup:
- start from the current authoritative registry state;
- skip every already terminalized case;
- persist and readback-verify every newly completed result before treating it as authoritative;
- preserve case-level source/technical failures as terminal outcomes where the existing protocol requires;
- never overwrite a terminal result merely to reconcile a collision or duplicate mapping;
- route genuine workflow ambiguity to the coordinator;
- continue at maximum safe throughput across pack/group/run boundaries;
- exhaustion of the source packs currently visible to you is NOT bucket completion;
- STATUS: COMPLETE is allowed only after reconciliation against the full authoritative R4.3.3 finalized-summary population proves that this bucket has zero owned stable_ids without terminal registry results;
- if current packs are exhausted but owned pending stable_ids remain, use STATUS: NORMAL and BLOCKER: NEXT_SOURCE_PACKS_REQUIRED;
- end every substantive turn with exactly:
AUDIT_TURN_STATUS
STATUS: NORMAL / ERROR / COMPLETE
NEW_CASES: <number>
WRITES_VERIFIED: YES / NO / PARTIAL
BLOCKER: NONE or <brief blocker>
TRIGGER_COORDINATOR: YES / NO

Reply with exactly PROTOCOL_SETUP_ACK_V3 and nothing else.`;
}

function initialAuditPrompt(bucket) {
  return `Begin or resume Bucket ${bucket} from the current authoritative registry state. First reconcile R433_AUDIT_SHARD_${bucket} against the available R4.3.3 source packs and identify the next eligible pending case owned by int(stable_id, 16) % 6 == ${bucket}. Do not redo any valid terminalized case. Process as many additional eligible pending cases as this turn can safely complete, continuing across pack/group/run boundaries. Persist and readback-verify every new result before treating it as authoritative. Properly terminalized case-level source or technical failures are normal and must not stop the turn. Exhausting the source packs currently visible to you does not mean the bucket is complete. If visible packs are exhausted while full-corpus owned cases remain, use STATUS: NORMAL with BLOCKER: NEXT_SOURCE_PACKS_REQUIRED. Use STATUS: COMPLETE only after reconciliation against the full authoritative ${config.auditablePopulation}-summary R4.3.3 finalized population proves zero owned pending stable_ids and no unresolved writes. End with the required strict six-line AUDIT_TURN_STATUS footer.`;
}

function continuationPrompt(bucket) {
  return `Continue the source-summary audit from the current authoritative registry state for Bucket ${bucket}. Review as many additional eligible cases in your assigned bucket as this turn can possibly complete. There is no voluntary case quota. Do not redo completed cases. Persist and readback-verify each result according to the existing protocol and continue across pack/group/run boundaries until the turn itself can no longer proceed, the full-corpus bucket is genuinely complete, or a real global blocker prevents further work. Exhaustion of currently visible packs is not completion; when that happens with owned cases still pending, use STATUS: NORMAL with BLOCKER: NEXT_SOURCE_PACKS_REQUIRED. STATUS: COMPLETE requires full-population reconciliation against all ${config.auditablePopulation} finalized summaries. End with the required strict six-line AUDIT_TURN_STATUS footer.`;
}

function registryPrerequisiteRevalidationPrompt(bucket) {
  const tab = `R433_AUDIT_SHARD_${bucket}`;
  return `AUTOMATIC PREREQUISITE REVALIDATION for Bucket ${bucket}. A prior turn could not access the canonical registry structure. Use the connected Google Sheets capability to open spreadsheet ${config.registryId} and the exact tab ${tab}. Verify that the tab exists and is readable by listing/reading its header and enough rows to establish access. Do not create, rename, edit, or write any registry cells. Reconcile any outstanding submitted action against the canonical registry so no prior write is repeated. If and only if the exact tab is available, include the exact line REGISTRY_SHARD_AVAILABLE: YES and return the required footer with STATUS: NORMAL, NEW_CASES: 0, WRITES_VERIFIED: YES, BLOCKER: NONE, TRIGGER_COORDINATOR: NO. If access is still unavailable, include REGISTRY_SHARD_AVAILABLE: NO and return STATUS: ERROR, NEW_CASES: 0, WRITES_VERIFIED: YES, BLOCKER: REGISTRY_STRUCTURE_UNAVAILABLE, TRIGGER_COORDINATOR: YES. Do not begin substantive case review in this validation turn. End with exactly the six-line AUDIT_TURN_STATUS footer.`;
}

function registryAvailabilityBlocker(footer = null) {
  const blocker = String(footer?.blocker || '').trim().toUpperCase();
  return /^(?:REGISTRY_STRUCTURE_UNAVAILABLE|REGISTRY_SHARD_UNAVAILABLE|REGISTRY_ACCESS_UNAVAILABLE|REGISTRY_TAB_NOT_FOUND|REGISTRY_STRUCTURE_NOT_FOUND|REGISTRY_ACCESS_DENIED)$/.test(blocker);
}

function sourcePackContinuationPrompt(bucket, source) {
  return buildSourcePackContinuationPrompt(bucket, source);
}

function sourcePackInventoryLastNumber(bucket) {
  const marker = loadJson(SOURCE_PACK_READY_PATH, null);
  if (String(marker?.status || '').toUpperCase() !== 'UPLOADED') return null;
  const ranges = marker?.shards;
  const mapping = config.sourcePackShards;
  const configuredBuckets = Array.from({ length: 6 }, (_, index) => String(index));
  if (!ranges || Object.keys(ranges).length !== configuredBuckets.length) return null;

  let totalPackCount = 0;
  for (const key of configuredBuckets) {
    const shard = configuredSourcePackShard(key);
    const range = ranges[key];
    const startPack = Number(range?.startPack);
    const lastPack = Number(range?.lastPack);
    const packCount = Number(range?.packCount);
    if (!shard
      || !mapping?.[key]
      || !Number.isInteger(startPack)
      || startPack < 1
      || !Number.isInteger(lastPack)
      || lastPack < startPack
      || !Number.isInteger(packCount)
      || packCount !== lastPack - startPack + 1) return null;
    totalPackCount += packCount;
  }

  if (!Number.isInteger(Number(marker.packCount)) || totalPackCount !== Number(marker.packCount)) return null;
  return Number(ranges[String(Number(bucket))]?.lastPack);
}

function latestSourcePackBoundaryIncident(bucket) {
  const bucketNumber = Number(bucket);
  const prefix = `INC-B${bucketNumber}-`;
  const records = Object.values(state.incidents)
    .filter(record => String(record?.id || '').startsWith(prefix) && record.path)
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));
  for (const record of records) {
    const incident = loadJson(record.path, null);
    if (incident?.kind === 'NEXT_SOURCE_PACKS_REQUIRED'
      && Number(incident.bucket) === bucketNumber) return { record, incident };
  }
  return null;
}

function corpusReconciliationPrompt(bucket) {
  const shard = configuredSourcePackShard(bucket);
  const lastPack = sourcePackInventoryLastNumber(bucket);
  const inventoryRange = loadJson(SOURCE_PACK_READY_PATH, null)?.shards?.[String(Number(bucket))];
  const firstPack = Number(inventoryRange?.startPack);
  const inventoryHint = shard && Number.isInteger(lastPack)
    ? `The uploaded inventory snapshot spans ${sourcePackFilename(firstPack, Number(bucket))} through ${sourcePackFilename(lastPack, Number(bucket))}. Re-list and paginate the exact shard folder at ${sourcePackShardFolderUrl(shard.folderId)} to verify whether a newer pack exists before requesting one.`
    : 'Re-list and paginate the exact shard folder before requesting another pack.';
  return `The previous response is a completion or source-pack boundary candidate for Bucket ${bucket}; neither proves completion. ${inventoryHint} Reconcile R433_AUDIT_SHARD_${bucket} against the full authoritative R4.3.3 finalized-summary population of ${config.auditablePopulation} cases, using permanent ownership int(stable_id, 16) % 6 == ${bucket}. Pack exhaustion alone is not completion. If any owned stable_id lacks a terminal registry result, continue only with an exact source pack confirmed available in the shard folder, skipping every valid terminal row and readback-verifying every new write. If owned cases remain but no later exact pack exists, return STATUS: NORMAL with BLOCKER: NEXT_SOURCE_PACKS_REQUIRED and TRIGGER_COORDINATOR: YES. Only if full-population reconciliation proves zero owned pending stable_ids and there are no unresolved writes may you return STATUS: COMPLETE. In that case, immediately before the six-line footer include these exact evidence lines:\nFULL_CORPUS_RECONCILED: YES\nFULL_CORPUS_AUDITABLE_POPULATION: ${config.auditablePopulation}\nOWNED_PENDING_CASES: 0\nUNRESOLVED_WRITES: 0\nThen end with the strict six-line AUDIT_TURN_STATUS footer.`;
}

function malformedRecoveryPrompt(bucket) {
  return `Recover conservatively from the prior malformed or truncated Bucket ${bucket} response. First reconcile against the authoritative registry and identify every result already persisted by the interrupted turn. Readback-verify any newly written rows whose verification is uncertain. Do not re-review or rewrite any case already validly terminalized. Resolve any incomplete or defective write before proceeding, then continue additional eligible pending Bucket ${bucket} cases at maximum safe throughput. End with exactly the required six-line AUDIT_TURN_STATUS footer.`;
}

function partialWriteRecoveryPrompt(bucket, footer) {
  return `Recover Bucket ${bucket} conservatively before any new review work. The previous footer reported WRITES_VERIFIED: ${footer.writesVerified} and BLOCKER: ${footer.blocker || 'NONE'}. Reconcile only the uncertain write state from the previous turn against the authoritative registry, readback-verify every uncertain write, and repair only incomplete/defective writes. Do not re-audit or rewrite valid terminalized cases. Do not review any new cases in this recovery turn. Once the uncertain writes are fully reconciled, stop and return the required strict six-line AUDIT_TURN_STATUS footer with WRITES_VERIFIED: YES if and only if readback verification succeeded. The controller will resume ordinary source-pack work in a separate turn after this recovery completes.`;
}

function interruptedWriteRecoveryPrompt(bucket, footer, interruptedActionId) {
  return `The prior WRITE_RECOVERY action ${interruptedActionId} began generating but its browser/session connection was interrupted before any attributable assistant response completed. Treat that interrupted attempt as uncertain execution: reconcile from the authoritative registry and readback state before making any repair, and do not assume that an unverified write either succeeded or failed. ${partialWriteRecoveryPrompt(bucket, footer)}`;
}

function isolatedAnomalyContinuationPrompt(bucket) {
  return `Continue Bucket ${bucket} without allowing the previously reported isolated anomaly to freeze the whole bucket. The prior turn reported WRITES_VERIFIED: YES and requested coordinator attention for an anomaly that must not cause an already-terminal registry row to be rewritten. Preserve every existing terminal registry row exactly as-is, including any anomalous or disputed mapping described in the prior response; do not overwrite, relabel, or re-audit that terminalized case merely to reconcile the anomaly. Continue from the next eligible pending owned stable_id and process as many additional cases as this turn can safely complete. If the anomaly truly prevents identifying or processing later eligible cases, return a specific non-NONE blocker describing exactly what is blocked and set TRIGGER_COORDINATOR: YES. Otherwise continue normally and use TRIGGER_COORDINATOR: NO. Persist and readback-verify every new result and end with the required strict six-line AUDIT_TURN_STATUS footer.`;
}

async function readVisibleMessages(page, timeoutMs = 15000) {
  return withPageProbeTimeout(page.evaluate(() => {
    const attributedNodes = [...document.querySelectorAll('[data-message-author-role]')];
    if (attributedNodes.length) {
      return attributedNodes.map(node => ({
        role: node.getAttribute('data-message-author-role') || '',
        text: (node.innerText || node.textContent || '').trim(),
      }));
    }

    const userSelector = 'main .bg-user-message';
    const assistantSelector = 'main .group.flex.min-w-0.flex-col';
    const currentMessages = [...document.querySelectorAll(`${userSelector}, ${assistantSelector}`)]
      .filter(node => {
        const role = node.matches(userSelector) ? 'user' : 'assistant';
        const selector = role === 'user' ? userSelector : assistantSelector;
        return !node.querySelector(selector);
      })
      .map(node => ({
        role: node.matches(userSelector) ? 'user' : 'assistant',
        text: (node.innerText || node.textContent || '').trim(),
      }))
      .filter(message => message.text);
    if (currentMessages.length) return currentMessages;

    // Retain the older turn-wrapper fallback for UI variants that expose neither
    // of the current user-message nor assistant-message structures.
    const turns = [...document.querySelectorAll('main div.group.flex.flex-col.pb-2.pt-2')];
    return turns.map(turn => {
      const preferredNodes = [...turn.querySelectorAll('div.text-size-chat.whitespace-pre-wrap')];
      const contentNodes = preferredNodes.length
        ? preferredNodes
        : [...turn.querySelectorAll('div.text-size-chat')]
          .filter(node => !node.querySelector('div.text-size-chat')
            && !node.classList.contains('min-w-0'));
      const text = contentNodes
        .map(node => (node.innerText || node.textContent || '').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
      if (!text) return null;
      return {
        role: /\[\[R433_ACTION:[^\]]+\]\]/.test(text) ? 'user' : 'assistant',
        text,
      };
    }).filter(Boolean);
  }), 'readVisibleMessages', timeoutMs);
}

async function latestMessage(page, role, timeoutMs = 15000) {
  const messages = await readVisibleMessages(page, timeoutMs);
  const matches = messages.filter(message => message.role === role);
  return matches.length ? matches[matches.length - 1].text : '';
}

async function latestAssistantAfterActionMarker(page, actionIdValue) {
  if (!actionIdValue) return { attributed: false, text: '' };
  const messages = await readVisibleMessages(page);
  return assistantAfterActionMarker(messages, actionIdValue);
}

const COMPOSER_SELECTOR = '[role="textbox"][contenteditable="true"], #prompt-textarea';
const COMPOSER_LOCATOR_SELECTOR =
  '[role="textbox"][contenteditable="true"]:visible, #prompt-textarea:visible';

async function composerText(page, timeoutMs = PAGE_PROBE_TIMEOUT_MS) {
  return withPageProbeTimeout(page.evaluate((selector) => {
    const el = Array.from(document.querySelectorAll(selector))
      .find((candidate) => candidate.getClientRects().length > 0);
    if (!el) return '';
    return (el.innerText || el.textContent || el.value || '').trim();
  }, COMPOSER_SELECTOR), 'composerText', timeoutMs);
}

const PAGE_PROBE_TIMEOUT_MS = 15000;
const PAGE_PROBE_STALL_THRESHOLD = 3;
const SEND_UI_INTERACTION_TIMEOUT_MS = 4000;
const REVIEWER_HEALTH_PROBE_TIMEOUT_MS = 15000;
const REVIEWER_NAVIGATION_TIMEOUT_MS = 30000;
const REVIEWER_PAGE_CREATION_TIMEOUT_MS = 30000;
const pageProbeTimeoutCounts = new WeakMap();
const GENERATION_STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop generating"]',
  'button[aria-label="Stop"]',
];

function withPageProbeTimeout(promise, label, timeoutMs = PAGE_PROBE_TIMEOUT_MS) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeoutMs}ms`);
        error.code = 'PAGE_PROBE_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function isGenerating(page) {
  try {
    const generating = await withPageProbeTimeout(page.evaluate((selectors) => {
      const visible = element => {
        if (!element || !element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      return selectors.some(selector => Array.from(document.querySelectorAll(selector)).some(visible));
    }, GENERATION_STOP_SELECTORS), 'isGenerating', REVIEWER_HEALTH_PROBE_TIMEOUT_MS);
    pageProbeTimeoutCounts.delete(page);
    return generating;
  } catch (error) {
    if (error?.code === 'PAGE_PROBE_TIMEOUT') {
      const timeoutCount = Number(pageProbeTimeoutCounts.get(page) || 0) + 1;
      pageProbeTimeoutCounts.set(page, timeoutCount);
      if (timeoutCount >= PAGE_PROBE_STALL_THRESHOLD) {
        const stalled = new Error(`reviewer page failed ${timeoutCount} consecutive live-generation probes`);
        stalled.code = 'PAGE_PROBE_STALLED';
        stalled.timeoutCount = timeoutCount;
        throw stalled;
      }
      // Fail closed while a transiently slow page is still below the bounded
      // stall threshold so scheduler capacity is never freed speculatively.
      return true;
    }
    throw error;
  }
}

async function stopLiveGeneration(page) {
  for (const selector of GENERATION_STOP_SELECTORS) {
    const locator = page.locator(selector).first();
    try {
      if (!(await locator.count()) || !(await locator.isVisible())) continue;
      await locator.click({ timeout: 3000 });
      try {
        await locator.waitFor({ state: 'hidden', timeout: 5000 });
      } catch {}
      return true;
    } catch {}
  }
  return false;
}

async function conversationRolloverReason(page) {
  if (!config.conversationRolloverEnabled || config.conversationRolloverLimitDetection === false) return null;
  let body = '';
  try {
    body = await page.locator('body').innerText({ timeout: 5000 });
  } catch {
    return null;
  }
  return conversationRolloverReasonFromText(body);
}

async function fillComposer(page, text) {
  const composer = page.locator(COMPOSER_LOCATOR_SELECTOR).first();
  try {
    await composer.waitFor({ state: 'visible', timeout: 20000 });
  } catch (cause) {
    const error = new Error(`reviewer composer did not become visible: ${cause.message || cause}`);
    error.code = 'REVIEWER_COMPOSER_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }
  try {
    await composer.fill(text);
  } catch {
    await composer.evaluate((el, value) => {
      el.focus();
      if ('value' in el) {
        el.value = value;
      } else {
        el.textContent = value;
      }
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value,
      }));
    }, text);
  }
}

async function pressSend(page, marker) {
  assertControlRunning();
  const composer = page.locator(COMPOSER_LOCATOR_SELECTOR).first();
  const before = await composerText(page, SEND_UI_INTERACTION_TIMEOUT_MS);
  if (!before || !before.includes(marker)) {
    const error = new Error('the expected action marker is not present in the composer');
    error.code = 'REVIEWER_SEND_INTERACTION_FAILED';
    throw error;
  }
  const button = page.locator('button[data-testid="send-button"]:visible, button[aria-label="Send"]:visible').first();
  let interactionError = null;
  try {
    if (await button.count() && await button.isVisible() && await button.isEnabled()) {
      assertControlRunning();
      await button.click({ timeout: SEND_UI_INTERACTION_TIMEOUT_MS });
      await sleep(500);
    }
  } catch (error) {
    interactionError = error;
  }

  // Only use Enter as a fallback when the first submit left the exact action
  // marker in the composer. This avoids submitting an already accepted action
  // twice after a slow project-page response.
  let latestUser = '';
  try {
    latestUser = await latestMessage(page, 'user', SEND_UI_INTERACTION_TIMEOUT_MS);
  } catch (error) {
    if (isBrowserDisconnectedError(error)) throw error;
    interactionError ||= error;
  }
  if (latestUser.includes(marker)) return;
  let afterClick = '';
  try {
    afterClick = await composerText(page, SEND_UI_INTERACTION_TIMEOUT_MS);
  } catch (error) {
    if (isBrowserDisconnectedError(error)) throw error;
    interactionError ||= error;
  }
  if (!afterClick || afterClick !== before) return;

  assertControlRunning();
  try {
    await composer.press('Enter', { timeout: SEND_UI_INTERACTION_TIMEOUT_MS });
  } catch (error) {
    if (isBrowserDisconnectedError(error)) throw error;
    interactionError ||= error;
  }
  await sleep(500);
  if (interactionError) {
    const error = new Error(`reviewer send interaction did not complete: ${interactionError.message || interactionError}`);
    error.code = 'REVIEWER_SEND_INTERACTION_FAILED';
    error.cause = interactionError;
    throw error;
  }
}

function actionMarker(id) {
  return `[[R433_ACTION:${id}]]`;
}

async function waitForSentMarker(page, marker, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latestUser = await latestMessage(page, 'user', Math.min(5000, Math.max(500, deadline - Date.now())));
    if (latestUser.includes(marker)) return true;
    await sleep(500);
  }
  return false;
}

async function sendAction(page, bucket, kind, prompt, responseHash = '') {
  assertControlRunning();
  const bucketState = state.buckets[String(bucket)];
  const rolloverReason = await conversationRolloverReason(page);
  if (rolloverReason) {
    const error = new Error(rolloverReason);
    error.code = 'CHAT_ROLLOVER_REQUIRED';
    throw error;
  }
  const chatKey = bucketState?.chatId || bucketState?.chatUrl || `bucket-${bucket}`;
  const predecessorActionId = bucketState?.lastProcessedActionId || '';
  let id = actionId({
    bucket,
    chatKey,
    responseHash,
    kind,
    prompt,
    predecessorActionId,
  });
  let marker = actionMarker(id);
  let existingAction = state.actions[id];
  let latestUser = await latestMessage(page, 'user');
  if (!latestUser.includes(marker)) {
    const observedDraft = Object.values(state.actions).find(action =>
      action.bucket === bucket
        && action.kind === kind
        && (action.status === 'PREPARED' || action.status === 'DRAFTED')
        && latestUser.includes(actionMarker(action.id))
    );
    if (observedDraft) {
      id = observedDraft.id;
      marker = actionMarker(id);
      existingAction = observedDraft;
    }
  }
  const text = prompt + '\n\n' + marker;
  if (existingAction?.status === 'SENT') {
    if (latestUser.includes(marker)) {
      if (!bucketState.awaitingResponseAt
        && (!responseHash || bucketState.processedHash === responseHash)) {
        const sentAt = existingAction.sentAt || bucketState.lastMessageSentAt || now();
        bucketState.lastSentAt = Date.parse(sentAt);
        bucketState.lastMessageSentAt = sentAt;
        bucketState.lastMessageSentKind = kind;
        bucketState.lastMessageSentActionId = id;
        bucketState.awaitingResponseAt = sentAt;
        bucketState.awaitingActionId = id;
        bucketState.responseBaselineHash = responseHash || null;
        bucketState.candidateHash = null;
        bucketState.candidateCount = 0;
        bucketState.candidateActionId = null;
        bucketState.candidateObservedAt = null;
        bucketState.lastAction = `reconciled-sent:${id}`;
        saveState();
      }
      return id;
    }

    // The ledger said SENT, but the action marker is absent from the chat.
    // Treat this as an unconfirmed send and retry the preserved draft/action.
    state.actions[id].status = 'DRAFTED';
    state.actions[id].updatedAt = now();
    state.actions[id].deliveryVerified = false;
    saveState();
  }

  if (latestUser.includes(marker)) {
    const reconciledAt = now();
    const sentAt = existingAction?.sentAt || reconciledAt;
    state.actions[id] = {
      ...(existingAction || {}),
      id,
      bucket,
      kind,
      status: 'SENT',
      updatedAt: reconciledAt,
      sentAt,
      deliveryVerified: true,
      reconciledFromUserMessage: true,
    };
    bucketState.lastSentAt = Date.parse(sentAt);
    bucketState.lastMessageSentAt = sentAt;
    bucketState.lastMessageSentKind = kind;
    bucketState.lastMessageSentActionId = id;
    bucketState.awaitingResponseAt = sentAt;
    bucketState.awaitingActionId = id;
    bucketState.responseBaselineHash = responseHash || null;
    bucketState.candidateHash = null;
    bucketState.candidateCount = 0;
    bucketState.candidateActionId = null;
    bucketState.candidateObservedAt = null;
    bucketState.generationSeenSinceAction = false;
    bucketState.generationObservedAt = null;
    bucketState.lastAction = 'reconciled-sent:' + id;
    recordActivityEvent(state, {
      bucket,
      kind,
      summary: kind + ' sent (' + id + ')',
      at: reconciledAt,
    });
    saveState();
    trimActionLedger();
    return id;
  }

  const priorModelVerification = bucketState.reviewerModelVerification;
  const currentChatId = String(bucketState.chatId || '');
  const reuseVerifiedChatModel = Boolean(
    currentChatId
    && bucketState.setupVerified
    && String(bucketState.setupVerifiedChatId || '') === currentChatId
    && String(priorModelVerification?.chatId || '') === currentChatId
    && priorModelVerification?.model === REQUIRED_REVIEWER_MODEL
    && priorModelVerification?.effort === REQUIRED_REVIEWER_EFFORT,
  );
  let modelVerification;
  if (reuseVerifiedChatModel) {
    // Model and reasoning effort are conversation-scoped. Once the setup
    // action verified them for this exact chat, re-opening the selector on
    // every turn is redundant and can fail after ChatGPT changes its controls
    // from the new-chat selector to the in-conversation effort picker.
    modelVerification = {
      model: priorModelVerification.model,
      effort: priorModelVerification.effort,
    };
    log(`B${bucket}: reusing model verification for the current setup-verified chat`);
  } else {
    try {
      modelVerification = await ensureHighestReviewerModel(page);
    } catch (error) {
      if (error.code === 'REVIEWER_MODEL_UNAVAILABLE') {
        recordIncident(
          'REVIEWER_MODEL_UNAVAILABLE',
          bucket,
          'the required highest available model and High reasoning effort could not be confirmed; action was not sent',
          {
            requiredModel: REQUIRED_REVIEWER_MODEL,
            requiredEffort: REQUIRED_REVIEWER_EFFORT,
            verificationFailure: {
              message: error.message || String(error),
              cause: error.cause?.message || null,
            },
          },
          { wakeCoordinator: false },
        );
      }
      throw error;
    }
    bucketState.reviewerModelVerification = {
      model: modelVerification.model,
      effort: modelVerification.effort,
      verifiedAt: now(),
      actionKind: kind,
      actionId: id,
      chatId: bucketState.chatId || null,
      chatUrl: bucketState.chatUrl || null,
    };
    saveState();
  }

  let sendInteractionError = null;
  const existingDraft = await composerText(page);
  if (existingDraft) {
    if (!existingDraft.includes(marker)) {
      const error = new Error('composer contains a foreign or nonmatching draft; preserved');
      error.code = 'FOREIGN_DRAFT';
      throw error;
    }
    state.actions[id] = {
      ...(existingAction || {}),
      id,
      bucket,
      kind,
      status: 'DRAFTED',
      updatedAt: now(),
      sourcePackTargetFilename: kind === 'SOURCE_PACK_CONTINUE'
        ? bucketState.sourcePackTargetFilename || null
        : existingAction?.sourcePackTargetFilename || null,
    };
    saveState();
    assertControlRunning();
    try {
      await pressSend(page, marker);
    } catch (error) {
      if (['CONTROL_PAUSED', 'CONTROL_STOPPED', 'CONTROL_RECONCILIATION_ONLY'].includes(error?.code)) throw error;
      if (isBrowserDisconnectedError(error)) throw error;
      sendInteractionError = error;
    }
  } else {
    state.actions[id] = {
      id,
      bucket,
      kind,
      status: 'PREPARED',
      createdAt: existingAction?.createdAt || now(),
      updatedAt: now(),
      responseHash,
      marker,
      sourcePackTargetFilename: kind === 'SOURCE_PACK_CONTINUE'
        ? bucketState.sourcePackTargetFilename || null
        : existingAction?.sourcePackTargetFilename || null,
    };
    saveState();

    try {
      await fillComposer(page, text);
    } catch (error) {
      if (error?.code === 'REVIEWER_COMPOSER_UNAVAILABLE') {
        error.bucket = bucket;
        error.actionId = id;
        bucketState.lastAction = 'waiting-for-chat-composer';
        saveState();
      }
      throw error;
    }
    state.actions[id].status = 'DRAFTED';
    state.actions[id].updatedAt = now();
    saveState();

    assertControlRunning();
    try {
      await pressSend(page, marker);
    } catch (error) {
      if (['CONTROL_PAUSED', 'CONTROL_STOPPED', 'CONTROL_RECONCILIATION_ONLY'].includes(error?.code)) throw error;
      if (isBrowserDisconnectedError(error)) throw error;
      sendInteractionError = error;
    }
  }

  let submissionError = sendInteractionError;
  let delivered = false;
  try {
    delivered = await waitForSentMarker(page, marker, 15000);
  } catch (error) {
    if (['CONTROL_PAUSED', 'CONTROL_STOPPED', 'CONTROL_RECONCILIATION_ONLY'].includes(error?.code)) throw error;
    if (isBrowserDisconnectedError(error)) throw error;
    submissionError = error;
  }
  if (!delivered) {
    let finalLatestUser = '';
    let finalMessageRead = false;
    let finalComposer = '';
    let finalComposerRead = false;
    try {
      finalLatestUser = await latestMessage(page, 'user', SEND_UI_INTERACTION_TIMEOUT_MS);
      finalMessageRead = true;
    } catch (error) {
      if (isBrowserDisconnectedError(error)) throw error;
      submissionError ||= error;
    }
    if (finalLatestUser.includes(marker)) delivered = true;
    if (!delivered) {
      try {
        finalComposer = await composerText(page, SEND_UI_INTERACTION_TIMEOUT_MS);
        finalComposerRead = true;
      } catch (error) {
        if (isBrowserDisconnectedError(error)) throw error;
        submissionError ||= error;
      }
    }
    if (!delivered) {
      state.actions[id].status = 'DRAFTED';
      state.actions[id].updatedAt = now();
      state.actions[id].deliveryVerified = false;
      saveState();
      const error = new Error(`send action ${id} was not observed in the chat after 15 seconds`);
      error.code = 'SEND_NOT_OBSERVED';
      error.bucket = bucket;
      error.actionId = id;
      error.deliveryState = finalMessageRead && !finalLatestUser.includes(marker)
        && finalComposerRead && finalComposer.includes(marker)
        ? 'DRAFT_REMAINS'
        : 'AMBIGUOUS';
      error.cause = submissionError;
      throw error;
    }
  }

  const sentAt = now();
  state.actions[id].status = 'SENT';
  state.actions[id].updatedAt = sentAt;
  state.actions[id].sentAt = sentAt;
  state.actions[id].deliveryVerified = true;
  state.actions[id].nextRetryAt = null;
  bucketState.lastSentAt = Date.parse(sentAt);
  bucketState.lastMessageSentAt = sentAt;
  bucketState.lastMessageSentKind = kind;
  bucketState.lastMessageSentActionId = id;
  bucketState.awaitingResponseAt = sentAt;
  bucketState.awaitingActionId = id;
  bucketState.responseBaselineHash = responseHash || null;
  bucketState.candidateHash = null;
  bucketState.candidateCount = 0;
  bucketState.candidateActionId = null;
  bucketState.candidateObservedAt = null;
  bucketState.generationSeenSinceAction = false;
  bucketState.generationObservedAt = null;
  bucketState.lastAction = `${kind}:${id}`;
  recordActivityEvent(state, {
    bucket,
    kind,
    summary: `${kind} sent (${id})`,
    at: sentAt,
  });
  saveState();
  trimActionLedger();
  return id;
}

async function inspectLiveGeneratingByBucket(context) {
  await ensureBrowserSlots(context);
  const liveGeneratingByBucket = Object.fromEntries(
    Object.keys(state.buckets).map(bucket => [String(bucket), false]),
  );
  for (const slot of reviewerSlotRegistry.values()) {
    if (!slot.bucket || isSchedulingBlockedBucket(slot.bucket)) continue;
    try {
      const generation = await findActualGeneration(slot.page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
      const actualGeneration = Boolean(generation.active);
      slot.health = await classifyReviewerHealth(slot.page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
      liveGeneratingByBucket[slot.bucket] = actualGeneration;
    } catch {
      // An unprobeable slot is not proof of a live generation. The health
      // classifier exposes the broken state and bounded recovery can roll it
      // over without reserving capacity forever.
      liveGeneratingByBucket[slot.bucket] = false;
    }
  }
  await refreshReviewerSlotStatus();
  return liveGeneratingByBucket;
}

function refreshLiveReviewerOccupancy(liveGeneratingByBucket) {
  lastLiveGeneratingByBucket = { ...liveGeneratingByBucket };
  lastLiveReviewerOccupancy = buildLiveReviewerOccupancy({
    bucketStates: state.buckets,
    liveGeneratingByBucket,
    excludedBuckets: SCHEDULING_BLOCKED_BUCKETS,
    graceMs: dispatchStartGraceMs(),
    maxActive: MAX_ACTIVE_REVIEWERS,
    bucketCount: config.bucketCount,
  });
  return lastLiveReviewerOccupancy;
}

function bucketUsesLiveReviewerSlot(bucket, liveGeneratingByBucket) {
  const bucketState = state.buckets[String(bucket)];
  if (!bucketState) return false;
  return bucketOccupiesLiveReviewerSlot(bucketState, {
    isLiveGenerating: Boolean(liveGeneratingByBucket[String(bucket)]),
    graceMs: dispatchStartGraceMs(),
  });
}

function currentPageUrl(page) {
  try { return String(page?.url?.() || ''); } catch { return ''; }
}

function currentPageMatchesTarget(page, targetUrl, { exactPath = false } = {}) {
  const currentUrl = currentPageUrl(page);
  if (!exactPath) return currentUrl.startsWith(targetUrl);
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    const normalizedPath = value => value.replace(/\/+$/, '') || '/';
    return current.origin === target.origin
      && normalizedPath(current.pathname) === normalizedPath(target.pathname);
  } catch {
    return false;
  }
}

function isProjectPage(page) {
  const url = currentPageUrl(page);
  if (url === AUTOMATION_BOOTSTRAP_URL) return true;
  try {
    const pageHost = new URL(url).hostname.toLowerCase();
    const projectHost = new URL(config.projectUrl).hostname.toLowerCase();
    return pageHost === projectHost || pageHost.endsWith('.chatgpt.com') || pageHost.endsWith('.openai.com');
  } catch {
    return false;
  }
}

function bucketForPageUrl(url) {
  for (const [bucket, bucketState] of Object.entries(state.buckets || {})) {
    if (bucketState.chatUrl && url.startsWith(bucketState.chatUrl)) return String(bucket);
    const lastChat = Array.isArray(bucketState.chatHistory) ? bucketState.chatHistory.at(-1) : null;
    if (bucketState.reviewerSlotId && lastChat?.chatUrl && url.startsWith(lastChat.chatUrl)) return String(bucket);
  }
  return null;
}

async function createBoundedPage(context) {
  const pending = Promise.resolve().then(() => context.newPage());
  try {
    return await withPageProbeTimeout(pending, 'browser newPage', REVIEWER_PAGE_CREATION_TIMEOUT_MS);
  } catch (error) {
    // Playwright cannot cancel a pending newPage call. Close a page if the
    // underlying call resolves after its deadline so it cannot leak tab 4.
    pending.then(page => page?.close?.({ runBeforeUnload: false })).catch(() => {});
    if (error?.code === 'PAGE_PROBE_TIMEOUT') error.code = 'BROWSER_PAGE_CREATE_TIMEOUT';
    else error.code = error.code || 'BROWSER_PAGE_CREATE_TIMEOUT';
    throw error;
  }
}

async function ensureBrowserSlots(context) {
  const currentPages = context.pages().filter(page => !page.isClosed());
  const currentLiveGenerations = [...reviewerSlotRegistry.values()]
    .filter(slot => slot.health?.actualGeneration).length;
  const reviewerTargetCount = desiredReviewerSlotCount(currentLiveGenerations);
  if (browserContextRef === context
    && coordinatorPageRef && !coordinatorPageRef.isClosed()
    && [...reviewerSlotRegistry.values()].length === reviewerTargetCount
    && [...reviewerSlotRegistry.values()].every(slot => slot.page && !slot.page.isClosed())) {
    const existingPages = [...reviewerSlotRegistry.values()].map(slot => slot.page);
    const budget = await ensureBrowserPageBudget(context, {
      coordinatorPage: coordinatorPageRef,
      reviewerPages: existingPages,
      maxAutomationTabs: MAX_AUTOMATION_TABS,
      maxReviewerTabs: MAX_REVIEWER_TABS,
    });
    if (!budget.ok) {
      const error = new Error(`automation browser page budget is invalid: ${budget.reason}`);
      error.code = 'AUTOMATION_TAB_CAP_EXCEEDED';
      throw error;
    }
    const coordinatorHealth = await classifyReviewerHealth(coordinatorPageRef, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
    browserRuntimeStatus.coordinatorHealth = coordinatorHealth;
    browserRuntimeStatus.chatgptReady = coordinatorHealth.state === 'HEALTHY';
    browserRuntimeStatus.authenticationRequired = coordinatorHealth.state === 'AUTH_REQUIRED';
    return;
  }

  browserContextRef = context;
  coordinatorPageRef = null;
  reviewerSlotRegistry = new Map();

  const projectPages = currentPages.filter(isProjectPage);
  const healthByPage = new Map();
  for (const page of projectPages) {
    healthByPage.set(page, await classifyReviewerHealth(page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS }));
  }
  const generatingPages = projectPages.filter(page => healthByPage.get(page)?.actualGeneration);
  if (generatingPages.length > MAX_REVIEWER_TABS) {
    const error = new Error(`detected ${generatingPages.length} live reviewer generations; the safe limit is ${MAX_REVIEWER_TABS}`);
    error.code = 'REVIEWER_GENERATION_CAP_EXCEEDED';
    throw error;
  }
  const targetReviewerCount = desiredReviewerSlotCount(generatingPages.length);

  const reviewerPages = [...generatingPages];
  const orderedBucketStates = Object.entries(state.buckets || {})
    .filter(([, bucketState]) => !bucketState.complete && bucketState.chatUrl)
    .sort(([bucketA, stateA], [bucketB, stateB]) => {
      const aPinned = stateA.reviewerSlotId ? 1 : 0;
      const bPinned = stateB.reviewerSlotId ? 1 : 0;
      return bPinned - aPinned || Number(bucketA) - Number(bucketB);
    });
  for (const [, bucketState] of orderedBucketStates) {
    if (reviewerPages.length >= targetReviewerCount) break;
    const match = projectPages.find(page => currentPageUrl(page).startsWith(bucketState.chatUrl));
    if (match && !reviewerPages.includes(match)) reviewerPages.push(match);
  }
  for (const page of projectPages) {
    if (reviewerPages.length >= targetReviewerCount) break;
    if (reviewerPages.includes(page)) continue;
    const url = currentPageUrl(page);
    if (/\/c\//i.test(url)) reviewerPages.push(page);
  }

  const selected = new Set(reviewerPages);
  let coordinator = projectPages.find(page => !selected.has(page) && !/\/c\//i.test(currentPageUrl(page))) || null;
  if (!coordinator && projectPages.length > reviewerPages.length) {
    coordinator = projectPages.find(page => !selected.has(page)) || null;
  }
  if (!coordinator) coordinator = await createBoundedPage(context);

  while (reviewerPages.length < targetReviewerCount) {
    const reusable = projectPages.find(page => !reviewerPages.includes(page) && page !== coordinator);
    if (reusable) reviewerPages.push(reusable);
    else reviewerPages.push(await createBoundedPage(context));
  }

  if (!currentPageUrl(coordinator).startsWith(config.projectUrl)) {
    try {
      await coordinator.goto(config.projectUrl, { waitUntil: 'domcontentloaded', timeout: REVIEWER_NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      // A normal landing page can load enough DOM for the auth marker even
      // when navigation's domcontentloaded deadline expires. Preserve that
      // visible page and let the operator authenticate instead of killing it.
      const authHealth = await classifyReviewerHealth(coordinator, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
      if (authHealth.state === 'AUTH_REQUIRED') {
        healthByPage.set(coordinator, authHealth);
      } else {
        error.code = error.code || 'COORDINATOR_PAGE_NAVIGATION_FAILED';
        throw error;
      }
    }
  }

  const reviewerSlotIds = ['reviewer-1', 'reviewer-2'];
  for (let index = 0; index < reviewerPages.length; index += 1) {
    const page = reviewerPages[index];
    const bucket = bucketForPageUrl(currentPageUrl(page));
    const slotId = reviewerSlotIds[index];
    const slot = { slotId, page, bucket, health: healthByPage.get(page) || null, lastAssignedAt: now() };
    reviewerSlotRegistry.set(slotId, slot);
    if (bucket && state.buckets[bucket]) state.buckets[bucket].reviewerSlotId = slotId;
  }
  for (const [bucket, bucketState] of Object.entries(state.buckets || {})) {
    if (bucketState.reviewerSlotId && reviewerSlotRegistry.get(bucketState.reviewerSlotId)?.bucket !== String(bucket)) {
      bucketState.reviewerSlotId = null;
    }
  }
  coordinatorPageRef = coordinator;
  const coordinatorHealth = await classifyReviewerHealth(coordinatorPageRef, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });

  // Retire excess known project tabs only after checking that none is carrying
  // a live generation. Conversation URLs remain durable in state and are
  // reloaded into one of the reusable reviewer slots when needed.
  const keep = new Set([coordinatorPageRef, ...reviewerPages]);
  for (const page of projectPages) {
    if (keep.has(page)) continue;
    const health = healthByPage.get(page) || await classifyReviewerHealth(page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
    if (health.actualGeneration) {
      const error = new Error('an extra project tab still has a live generation; safe tab-budget recovery is deferred');
      error.code = 'REVIEWER_GENERATION_CAP_EXCEEDED';
      throw error;
    }
    try { await page.close({ runBeforeUnload: false }); } catch (error) {
      const failure = new Error(`could not retire an idle excess project tab: ${error.message || error}`);
      failure.code = 'AUTOMATION_TAB_CAP_EXCEEDED';
      throw failure;
    }
  }

  const budget = await ensureBrowserPageBudget(context, {
    coordinatorPage: coordinatorPageRef,
    reviewerPages: reviewerPages,
    maxAutomationTabs: MAX_AUTOMATION_TABS,
    maxReviewerTabs: MAX_REVIEWER_TABS,
  });
  if (!budget.ok) {
    const error = new Error(`automation browser page budget is invalid: ${budget.reason}`);
    error.code = 'AUTOMATION_TAB_CAP_EXCEEDED';
    throw error;
  }
  browserRuntimeStatus.coordinatorTabPresent = true;
  browserRuntimeStatus.coordinatorHealth = coordinatorHealth;
  browserRuntimeStatus.chatgptReady = coordinatorHealth.state === 'HEALTHY';
  browserRuntimeStatus.authenticationRequired = coordinatorHealth.state === 'AUTH_REQUIRED';
  browserRuntimeStatus.reviewerTabCount = budget.reviewerTabCount;
  browserRuntimeStatus.automationTabCount = budget.automationTabCount;
  browserRuntimeStatus.liveReviewerGenerations = [...reviewerSlotRegistry.values()]
    .filter(slot => slot.health?.actualGeneration).length;
  browserRuntimeStatus.reviewerSlots = [...reviewerSlotRegistry.values()].map(slot => ({
    slotId: slot.slotId,
    present: Boolean(slot.page && !slot.page.isClosed()),
    pageUrl: currentPageUrl(slot.page),
    bucket: slot.bucket,
    health: slot.health?.state || 'UNPROBED',
    actualGeneration: Boolean(slot.health?.actualGeneration),
    reason: slot.health?.reason || null,
  }));
  saveState();
}

async function reviewerSlotForBucket(context, bucket, { allowUninitialized = false } = {}) {
  await ensureBrowserSlots(context);
  const bucketKey = String(bucket);
  const bucketState = state.buckets[bucketKey];
  const existing = [...reviewerSlotRegistry.values()].find(slot => slot.bucket === bucketKey);
  if (existing) {
    const targetUrl = bucketState?.chatUrl || (allowUninitialized ? config.projectUrl : null);
    const targetIsLandingPage = allowUninitialized && !bucketState?.chatUrl;
    if (targetUrl && !currentPageMatchesTarget(existing.page, targetUrl, { exactPath: targetIsLandingPage })) {
      const health = await classifyReviewerHealth(existing.page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
      if (health.actualGeneration) {
        const error = new Error(`reviewer slot ${existing.slotId} is generating and cannot navigate to B${bucket}`);
        error.code = 'REVIEWER_SLOTS_BUSY';
        throw error;
      }
      await existing.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: REVIEWER_NAVIGATION_TIMEOUT_MS });
    }
    existing.health = await classifyReviewerHealth(existing.page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
    return existing;
  }

  const candidates = [...reviewerSlotRegistry.values()];
  for (const slot of candidates) {
    const health = await classifyReviewerHealth(slot.page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
    slot.health = health;
    if (health.actualGeneration) continue;
    const previousBucket = slot.bucket;
    if (previousBucket && state.buckets[previousBucket]) {
      state.buckets[previousBucket].reviewerSlotId = null;
    }
    slot.bucket = bucketKey;
    slot.lastAssignedAt = now();
    if (bucketState) bucketState.reviewerSlotId = slot.slotId;
    saveState();
    const targetUrl = bucketState?.chatUrl || (allowUninitialized ? config.projectUrl : null);
    if (!targetUrl) return slot;
    const targetIsLandingPage = allowUninitialized && !bucketState?.chatUrl;
    if (!currentPageMatchesTarget(slot.page, targetUrl, { exactPath: targetIsLandingPage })) {
      try {
        await slot.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: REVIEWER_NAVIGATION_TIMEOUT_MS });
      } catch (error) {
        error.code = error.code || 'REVIEWER_PAGE_NAVIGATION_FAILED';
        throw error;
      }
    }
    slot.health = await classifyReviewerHealth(slot.page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
    return slot;
  }
  const error = new Error(`both reusable reviewer slots are occupied by live generations; cannot load B${bucket}`);
  error.code = 'REVIEWER_SLOTS_BUSY';
  throw error;
}

async function refreshReviewerSlotStatus() {
  const slots = [];
  let liveReviewerGenerations = 0;
  for (const slot of reviewerSlotRegistry.values()) {
    const health = await classifyReviewerHealth(slot.page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
    slot.health = health;
    if (health.actualGeneration) liveReviewerGenerations += 1;
    slots.push({
      slotId: slot.slotId,
      present: Boolean(slot.page && !slot.page.isClosed()),
      pageUrl: currentPageUrl(slot.page),
      bucket: slot.bucket,
      health: health.state,
      actualGeneration: Boolean(health.actualGeneration),
      reason: health.reason,
    });
  }
  browserRuntimeStatus.coordinatorTabPresent = Boolean(coordinatorPageRef && !coordinatorPageRef.isClosed());
  browserRuntimeStatus.reviewerTabCount = slots.filter(slot => slot.present).length;
  browserRuntimeStatus.automationTabCount = Number(browserRuntimeStatus.reviewerTabCount)
    + Number(browserRuntimeStatus.coordinatorTabPresent);
  browserRuntimeStatus.liveReviewerGenerations = liveReviewerGenerations;
  browserRuntimeStatus.reviewerSlots = slots;
  return slots;
}

function latestRecoverableWriteIncident(bucket) {
  const candidates = Object.values(state.incidents || {})
    .filter(entry => entry?.path)
    .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  for (const record of candidates) {
    const incident = loadJson(record.path, null);
    if (Number(incident?.bucket) !== Number(bucket)) continue;
    if (incident?.kind !== 'REVIEWER_ERROR_FOOTER') continue;
    const footer = incident.footer;
    if (!(isRecoverableReadbackFooter(footer) || isRecoverableRegistryWriteFooter(footer))) continue;
    return { record, incident, footer };
  }
  return null;
}

function recoverableWriteIncidentById(bucket, incidentId) {
  if (!incidentId) return null;
  const record = Object.values(state.incidents || {}).find(entry => entry?.id === incidentId && entry?.path);
  if (!record) return null;
  const incident = loadJson(record.path, null);
  if (Number(incident?.bucket) !== Number(bucket) || incident?.kind !== 'REVIEWER_ERROR_FOOTER') return null;
  const footer = incident.footer;
  if (!(isRecoverableReadbackFooter(footer) || isRecoverableRegistryWriteFooter(footer))) return null;
  return { record, incident, footer };
}

function lostWriteRecoveryRetryReady(bucketState, responseAction, currentTimeMs = Date.now()) {
  if (!bucketState || !responseAction || responseAction.kind !== 'WRITE_RECOVERY') return false;
  if (!bucketState.generationSeenSinceAction) return false;
  const observedAt = Date.parse(bucketState.generationObservedAt || '');
  if (!Number.isFinite(observedAt)) return false;
  return currentTimeMs - observedAt >= 60 * 1000;
}

function noteGenerationObserved(bucketState) {
  const observedAt = Date.parse(bucketState.generationObservedAt || '');
  bucketState.generationSeenSinceAction = true;
  if (!Number.isFinite(observedAt)) bucketState.generationObservedAt = now();
}

function liveWriteRecoveryStallReason(bucketState, responseAction, currentTimeMs = Date.now()) {
  if (!bucketState?.awaitingResponseAt || responseAction?.kind !== 'WRITE_RECOVERY') return null;
  const sentAt = Date.parse(responseAction.sentAt || bucketState.awaitingResponseAt || '');
  if (!Number.isFinite(sentAt)) return null;
  const thresholdMinutes = Math.max(1, Number(config.writeRecoveryGenerationTimeoutMinutes || 10));
  if (currentTimeMs - sentAt < thresholdMinutes * 60 * 1000) return null;
  return `WRITE_RECOVERY ${responseAction.id || bucketState.awaitingActionId || 'unknown'} remained visibly generating for at least ${thresholdMinutes} minutes without an attributable assistant response`;
}

async function reconcileOutstandingResponses(context, liveGeneratingByBucket) {
  if (readControl().desiredState === 'STOPPED') return;

  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (bucketState.complete || !bucketHasUnresolvedAwaitingAction(bucketState) || !bucketState.chatUrl) continue;

    try {
      const page = await ensurePage(context, bucketState);
      if (!page) continue;
      if (isAuthenticationPage(page)) continue;

      if (await isGenerating(page)) {
        bucketState.transientFailures = 0;
        noteGenerationObserved(bucketState);
        if (bucketState.awaitingActionId) {
          bucketState.lastAction = `generating:${bucketState.awaitingActionId}`;
        }
        saveState();

        const responseActionId = bucketState.awaitingActionId;
        const responseAction = responseActionId ? state.actions[responseActionId] : null;
        const liveRecoveryStall = liveWriteRecoveryStallReason(bucketState, responseAction);
        if (liveRecoveryStall) {
          const stopped = await stopLiveGeneration(page);
          if (stopped) {
            if (await isGenerating(page)) {
              log(`B${bucket}: fail-closed WRITE_RECOVERY stall recovery; generation remains live after Stop`);
              continue;
            }
            const completedAfterStop = await latestAssistantAfterActionMarker(page, responseActionId);
            if (completedAfterStop.attributed && completedAfterStop.text) {
              log(`B${bucket}: WRITE_RECOVERY stall recovery deferred; completed response ${responseActionId} is available for reconciliation`);
              continue;
            }
            recordIncident(
              'WRITE_RECOVERY_GENERATION_STALL',
              bucket,
              liveRecoveryStall,
              { recoveryActionId: responseActionId },
              { wakeCoordinator: false, holdBucket: false },
            );
            log(`B${bucket}: stopped stalled WRITE_RECOVERY ${responseActionId}; rolling over conservatively`);
            await rolloverReviewer(context, Number(bucket), liveRecoveryStall);
          }
        }
        continue;
      }

      const responseActionId = bucketState.awaitingActionId;
      const attributed = await latestAssistantAfterActionMarker(page, responseActionId);
      if (!attributed.attributed || !attributed.text) {
        const responseAction = responseActionId ? state.actions[responseActionId] : null;
        if (lostWriteRecoveryRetryReady(bucketState, responseAction)) {
          const recovery = latestRecoverableWriteIncident(bucket);
          if (recovery) {
            if (!preDispatchReady || readControl().desiredState !== 'RUNNING') {
              clearAwaiting(bucketState, responseActionId);
              bucketState.writeRecoveryResumePending = true;
              bucketState.phase = 'ACTIVE';
              bucketState.lastAction = `write-recovery-reconciled-awaiting-dispatch-gate:${responseActionId}`;
              saveState();
              continue;
            }
            const latestAssistant = await latestMessage(page, 'assistant');
            const responseHash = latestAssistant
              ? sha16(latestAssistant)
              : (bucketState.processedHash || bucketState.lastHash || '');
            clearAwaiting(bucketState, responseActionId);
            bucketState.generationSeenSinceAction = false;
            bucketState.generationObservedAt = null;
            bucketState.candidateHash = null;
            bucketState.candidateCount = 0;
            bucketState.candidateActionId = null;
            bucketState.candidateObservedAt = null;
            saveState();
            const retryActionId = await sendAction(
              page,
              Number(bucket),
              'WRITE_RECOVERY',
              interruptedWriteRecoveryPrompt(Number(bucket), recovery.footer, responseActionId),
              responseHash,
            );
            bucketState.lastAction = `write-recovery-retried-after-interrupted-generation:${responseActionId}:${retryActionId}`;
            saveState();
            log(`B${bucket}: retried interrupted WRITE_RECOVERY ${responseActionId} as ${retryActionId}; incident preserved ${recovery.record.id}`);
          }
        }
        continue;
      }
      const text = attributed.text;
      const responseHash = sha16(text);
      const responseKey = actionResponseKey(responseActionId, responseHash);
      if (responseKey && bucketState.processedResponseKey === responseKey) {
        clearAwaiting(bucketState, responseActionId);
        saveState();
        continue;
      }
      if (!updateStableCandidate(bucketState, responseHash, responseActionId)) {
        saveState();
        continue;
      }

      updateReceivedMessage(bucketState, text, responseHash);
      const allowDispatch = !isSchedulingBlockedBucket(bucket)
        && !bucketState.sourcePackCursorReconciliationRequired
        && bucketState.phase !== 'HOLD'
        && !['INTEGRITY', 'USER', 'COMPLETE'].includes(bucketState.hold?.type)
        && sourcePackShardMappingStatus().ready
        && readControl().desiredState === 'RUNNING'
        && preDispatchReady;

      if (bucketState.phase === 'SETUP_WAIT') {
        await processSetupWait(page, bucket, bucketState, text, responseHash);
      } else {
        await processActive(page, bucket, bucketState, text, responseHash, { allowDispatch });
      }
    } catch (error) {
      if (error?.code === 'PAGE_PROBE_STALLED' && !isSchedulingBlockedBucket(bucket)) {
        const reason = `reviewer page failed ${error.timeoutCount || PAGE_PROBE_STALL_THRESHOLD} consecutive live-generation probes`;
        log(`B${bucket}: reviewer page probe stalled; checking the managed chat before recovery`);
        await recoverStalledReviewerGeneration(
          context,
          bucket,
          bucketState,
          reason,
          'runtime',
        );
        continue;
      }
      log(`B${bucket}: outstanding-response reconciliation error ${error.message || error}`);
    }
  }
}

async function ensurePage(context, bucketState) {
  if (!bucketState.chatUrl) return null;
  const bucket = Object.entries(state.buckets).find(([, value]) => value === bucketState)?.[0];
  if (bucket === undefined) return null;
  const slot = await reviewerSlotForBucket(context, Number(bucket));
  if (!currentPageUrl(slot.page).startsWith(bucketState.chatUrl)) {
    const health = await classifyReviewerHealth(slot.page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
    if (health.actualGeneration) {
      const error = new Error(`reviewer slot ${slot.slotId} has a live generation and cannot navigate to B${bucket}`);
      error.code = 'REVIEWER_SLOTS_BUSY';
      throw error;
    }
    await slot.page.goto(bucketState.chatUrl, { waitUntil: 'domcontentloaded', timeout: REVIEWER_NAVIGATION_TIMEOUT_MS });
  }
  return slot.page;
}

function isAuthenticationPage(page) {
  const url = String(page?.url?.() || '');
  return url.includes('accounts.google.com')
    || url.includes('auth.openai.com')
    || url.includes('chatgpt.com/auth/login');
}

function incidentFingerprint(kind, bucket, detail) {
  return sha16(`${kind}|${bucket ?? ''}|${detail}`);
}

function queueCoordinatorStatus(incidentId, detectedAt, kind) {
  const existing = loadJson(COORDINATOR_STATUS_PATH, {});
  saveJsonAtomic(COORDINATOR_STATUS_PATH, {
    ...existing,
    status: 'QUEUED',
    incidentId,
    queuedAt: detectedAt,
    kind,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    error: null,
  });
}

function wakeCodex(incidentPath) {
  try {
    const stdout = fs.openSync(COORDINATOR_WAKE_STDOUT, 'a');
    const stderr = fs.openSync(COORDINATOR_WAKE_STDERR, 'a');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', COORDINATOR_WAKE, '-IncidentPath', incidentPath],
      { detached: true, stdio: ['ignore', stdout, stderr], windowsHide: true },
    );
    child.on('error', error => log(`Coordinator wake process failed: ${error.message}`));
    child.unref();
    log(`Coordinator wake queued for ${path.basename(incidentPath)}`);
  } catch (error) {
    log(`Unable to launch Codex coordinator: ${error.message}`);
  }
}

function notifyUserIncident(incident) {
  if (process.platform !== 'win32') {
    log(`Operator notification skipped on ${process.platform}; incident ${incident.id} is available in the dashboard`);
    return;
  }
  try {
    const recipient = process.env.USERNAME || '*';
    const message = `R4.3.3 incident queued: ${incident.id}. Open the local dashboard for live coordinator status.`;
    const child = spawn('msg.exe', [recipient, message], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', error => log(`Unable to notify operator for ${incident.id}: ${error.message}`));
    child.unref();
  } catch (error) {
    log(`Unable to notify operator for ${incident.id}: ${error.message}`);
  }
}

function recordIncident(kind, bucket, detail, extra = {}, options = {}) {
  const fingerprint = incidentFingerprint(kind, bucket, detail);
  const previous = state.incidents[fingerprint];
  const nowMs = Date.now();
  const safeBucket = bucket === null || bucket === undefined ? null : String(bucket);
  const bucketState = safeBucket === null ? null : state.buckets[safeBucket];
  const applyHold = incidentId => {
    if (!bucketState || options.holdBucket === false) return;
    const holdType = options.holdType || classifyHoldType(kind, extra.footer, detail);
    const retryCount = holdType === 'TRANSIENT_EXTERNAL'
      ? Math.max(0, Number(bucketState.transientHoldRetryCount || 0))
      : 0;
    bucketState.phase = 'HOLD';
    bucketState.lastAction = `incident:${incidentId}`;
    if (holdType === 'TRANSIENT_EXTERNAL') bucketState.transientHoldRetryCount = retryCount + 1;
    bucketState.hold = createHoldRecord({
      type: holdType,
      reason: extra.footer?.blocker || kind,
      incidentId,
      bucket: Number(safeBucket),
      createdAt: now(),
      retryCount,
      validation: options.validation || holdValidationKind(kind, Number(safeBucket), extra.footer),
    });
  };
  if (previous && nowMs - Number(previous.lastTriggeredMs || 0) < 30 * 60 * 1000) {
    previous.lastSeenAt = now();
    previous.count = Number(previous.count || 1) + 1;
    if (bucketState && options.holdBucket !== false) applyHold(previous.id);
    saveState();
    return previous.path;
  }

  const incidentBucket = bucket === null || bucket === undefined ? 'GLOBAL' : `B${bucket}`;
  const id = `INC-${incidentBucket}-${new Date().toISOString().replace(/[:.]/g, '')}-${fingerprint}`;
  const file = path.join(INCIDENT_DIR, `${id}.json`);
  const incident = {
    id,
    detectedAt: now(),
    kind,
    bucket: bucket === null || bucket === undefined ? null : Number(bucket),
    detail,
    controllerRoot: ROOT,
    statusPath: STATUS_PATH,
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    ...extra,
  };
  saveJsonAtomic(file, incident);
  state.incidents[fingerprint] = {
    id,
    path: file,
    lastTriggeredMs: nowMs,
    lastSeenAt: incident.detectedAt,
    count: 1,
  };
  const wakeCoordinator = options.wakeCoordinator !== false;
  if (wakeCoordinator) {
    state.coordinator.lastQueuedAt = incident.detectedAt;
    state.coordinator.lastQueuedIncidentId = id;
    state.coordinator.lastQueuedKind = kind;
    queueCoordinatorStatus(id, incident.detectedAt, kind);
  }
  if (bucketState && options.holdBucket !== false) applyHold(id);
  saveState();
  log(`${id} ${kind}: ${detail}`);
  if (options.wakeCoordinator !== false) {
    notifyUserIncident(incident);
    wakeCodex(file);
  }
  return file;
}

function heldIncidentForCoordinator() {
  for (const [, bucketState] of Object.entries(state.buckets)) {
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    if (!incidentRecord?.path) continue;
    const incident = loadJson(incidentRecord.path, null);
    if (incident?.id !== incidentId) continue;
    if ([
      'NEXT_SOURCE_PACKS_REQUIRED',
      'NEW_CHAT_ID_TIMEOUT',
      'NEW_CHAT_SEND_UNCONFIRMED',
      'NEW_CHAT_CREATION_UNRESOLVED',
      'REVIEWER_MODEL_UNAVAILABLE',
      'REVIEWER_CHAT_CAP_REACHED',
      'RETIRED_REVIEWER_TABS_NOT_CLOSED',
      'NEW_CHAT_BUSY',
    ].includes(incident.kind)) continue;
    return { incident, path: incidentRecord.path };
  }
  return null;
}

function ensureCoordinatorWakeProgress() {
  const target = heldIncidentForCoordinator();
  if (!target) return;

  const { incident, path: incidentPath } = target;
  const coordinatorStatus = loadJson(COORDINATOR_STATUS_PATH, {});
  const status = String(coordinatorStatus?.status || '').toUpperCase();
  const sameIncident = coordinatorStatus?.incidentId === incident.id;
  const retryAfterMs = 5 * 60 * 1000;
  const currentTime = Date.now();

  if (status === 'RUNNING') return;
  if (sameIncident && status === 'COMPLETED') return;

  const statusAt = Date.parse(
    coordinatorStatus?.startedAt
    || coordinatorStatus?.queuedAt
    || coordinatorStatus?.completedAt
    || '',
  );
  if (sameIncident
    && ['QUEUED', 'FAILED'].includes(status)
    && Number.isFinite(statusAt)
    && currentTime - statusAt < retryAfterMs) return;

  const lastRecoveryWakeAt = Date.parse(state.coordinator?.lastRecoveryWakeAt || '');
  if (state.coordinator?.lastRecoveryWakeIncidentId === incident.id
    && Number.isFinite(lastRecoveryWakeAt)
    && currentTime - lastRecoveryWakeAt < retryAfterMs) return;

  const retryAt = now();
  state.coordinator.lastRecoveryWakeAt = retryAt;
  state.coordinator.lastRecoveryWakeIncidentId = incident.id;
  queueCoordinatorStatus(incident.id, retryAt, incident.kind || 'UNKNOWN');
  saveState();
  log(`Coordinator wake retry queued for ${incident.id}; prior status=${status || 'MISSING'}`);
  wakeCodex(incidentPath);
}

function managedReviewerChatCount() {
  return Object.values(state.buckets).filter(bucketState => (
    !bucketState.complete
    && (Boolean(bucketState.chatUrl) || Boolean(bucketState.newChatCreation?.status))
  )).length;
}

function latestSetupAction(bucket) {
  return Object.values(state.actions || {})
    .filter(action => Number(action?.bucket) === Number(bucket)
      && action?.kind === 'PROTOCOL_SETUP'
      && ['PREPARED', 'DRAFTED', 'SENT'].includes(action?.status))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

async function closeUnsentReviewerPage(page, bucketState, bucket) {
  bucketState.newChatCreation = null;
  saveState();
  const slot = [...reviewerSlotRegistry.values()].find(entry => entry.page === page);
  if (slot) slot.bucket = String(bucket);
  log(`B${bucket}: retained reusable reviewer slot after an unsent setup action`);
}

async function createReviewer(context, bucket) {
  assertControlRunning();
  if (isSchedulingBlockedBucket(bucket)) return;
  const bucketState = state.buckets[String(bucket)];
  if (bucketState.newChatCreation?.status) {
    if (bucketState.phase !== 'HOLD') {
      recordIncident(
        'NEW_CHAT_CREATION_UNRESOLVED',
        bucket,
        'an earlier reviewer-chat creation is unresolved; automatic retry is disabled to avoid a duplicate conversation',
        { creationStatus: bucketState.newChatCreation.status, actionId: bucketState.newChatCreation.actionId || null },
        { wakeCoordinator: false },
      );
    }
    return;
  }
  bucketState.newChatCreation = { status: 'OPENING', startedAt: now(), actionId: null };
  saveState();
  log(`B${bucket}: opening a reviewer chat in a reusable reviewer slot`);

  let page = null;
  let slot = null;
  try {
    slot = await reviewerSlotForBucket(context, bucket, { allowUninitialized: true });
    page = slot.page;
    // reviewerSlotForBucket already navigates to the landing page when needed.
    // Repeating goto here reloads ChatGPT immediately after hydration and can
    // leave a fresh reviewer page without its composer.
    if (!currentPageMatchesTarget(page, config.projectUrl, { exactPath: true })) {
      await page.goto(config.projectUrl, { waitUntil: 'domcontentloaded', timeout: REVIEWER_NAVIGATION_TIMEOUT_MS });
    }
    slot.bucket = String(bucket);
    bucketState.reviewerSlotId = slot.slotId;
    bucketState.newChatCreation.status = 'READY_TO_SEND';
    saveState();
  } catch (error) {
    await closeUnsentReviewerPage(page, bucketState, bucket);
    throw error;
  }

  const newChatHealth = await classifyReviewerHealth(page, { timeoutMs: REVIEWER_HEALTH_PROBE_TIMEOUT_MS });
  if (newChatHealth.state === 'GENERATING' || newChatHealth.actualGeneration) {
    bucketState.newChatCreation.status = 'BUSY';
    recordIncident(
      'NEW_CHAT_BUSY',
      bucket,
      'new project chat unexpectedly shows an active generation; no setup prompt was sent',
      { creationStatus: 'BUSY', healthEvidence: newChatHealth.evidence || null },
      { wakeCoordinator: false },
    );
    return;
  }
  if (newChatHealth.state !== 'HEALTHY') {
    await closeUnsentReviewerPage(page, bucketState, bucket);
    const evidence = newChatHealth.evidence || {};
    const safeEvidence = {
      url: evidence.url || currentPageUrl(page),
      title: evidence.title || null,
      readyState: evidence.readyState || null,
      composer: evidence.composer ?? null,
      authenticationRequired: evidence.authenticationRequired ?? null,
      challengeMarkers: evidence.challengeMarkers || [],
    };
    const error = new Error(`new project chat is not ready for protocol setup: ${newChatHealth.reason}; evidence=${JSON.stringify(safeEvidence)}`);
    error.code = 'NEW_CHAT_PAGE_NOT_READY';
    throw error;
  }

  try {
    assertControlRunning();
  } catch (error) {
    await closeUnsentReviewerPage(page, bucketState, bucket);
    throw error;
  }

  bucketState.newChatCreation.status = 'SENDING';
  saveState();
  let id;
  try {
    id = await sendAction(page, bucket, 'PROTOCOL_SETUP', setupPrompt(bucket), '');
  } catch (error) {
    if (['CONTROL_PAUSED', 'CONTROL_STOPPED', 'CONTROL_RECONCILIATION_ONLY', 'CHAT_ROLLOVER_REQUIRED', 'REVIEWER_MODEL_UNAVAILABLE'].includes(error.code)) {
      await closeUnsentReviewerPage(page, bucketState, bucket);
      throw error;
    }

    const action = latestSetupAction(bucket);
    const creationStatus = error.code === 'SEND_NOT_OBSERVED' ? 'SEND_UNCONFIRMED' : 'UNRESOLVED';
    bucketState.newChatCreation = {
      status: creationStatus,
      startedAt: bucketState.newChatCreation?.startedAt || now(),
      actionId: action?.id || null,
      errorCode: error.code || 'UNKNOWN',
    };
    recordIncident(
      creationStatus === 'SEND_UNCONFIRMED' ? 'NEW_CHAT_SEND_UNCONFIRMED' : 'NEW_CHAT_CREATION_UNRESOLVED',
      bucket,
      'reviewer-chat setup delivery is ambiguous; the tab is preserved and automatic retry is disabled to avoid duplicate conversations',
      { creationStatus, actionId: action?.id || null },
      { wakeCoordinator: false },
    );
    return;
  }

  bucketState.newChatCreation = {
    status: 'SENT_WAITING_FOR_ID',
    startedAt: bucketState.newChatCreation?.startedAt || now(),
    actionId: id,
  };
  saveState();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const url = page.url();
    const match = url.match(/\/c\/([0-9a-f-]{20,})/i);
    if (match) {
      const chatId = match[1];
      bucketState.chatId = chatId;
      bucketState.chatUrl = url.split('?')[0];
      if (bucketState.reviewerModelVerification?.actionKind === 'PROTOCOL_SETUP'
        && bucketState.reviewerModelVerification.actionId === id) {
        bucketState.reviewerModelVerification.chatId = chatId;
        bucketState.reviewerModelVerification.chatUrl = bucketState.chatUrl;
      }
      bucketState.newChatCreation = null;
      resetPerChatObservationState(bucketState);
      bucketState.setupVerified = false;
      bucketState.setupVerifiedChatId = null;
      bucketState.phase = 'SETUP_WAIT';
      bucketState.lastAction = 'setup-sent:' + id;
      saveState();
      log('B' + bucket + ': new reviewer chat ID captured');
      return;
    }
    await sleep(1000);
  }

  bucketState.newChatCreation.status = 'ID_UNRESOLVED';
  saveState();
  recordIncident(
    'NEW_CHAT_ID_TIMEOUT',
    bucket,
    'protocol setup was sent but the new conversation ID was not observed within 45 seconds; tab preserved and retry disabled',
    { actionId: id, creationStatus: 'ID_UNRESOLVED' },
    { wakeCoordinator: false },
  );
}

async function rolloverReviewer(context, bucket, reason) {
  const bucketState = state.buckets[String(bucket)];
  const oldChatId = bucketState.chatId || null;
  const oldChatUrl = bucketState.chatUrl || null;
  const interruptedActionId = bucketState.awaitingActionId || null;
  const interruptedAction = interruptedActionId ? state.actions[interruptedActionId] : null;
  const resumeAdvisoryAnomaly = Boolean(
    bucketState.advisoryAnomalyResumePending
    || interruptedAction?.kind === 'ISOLATED_ANOMALY_CONTINUE',
  );
  const advisoryAnomalyInterruptedActionId = interruptedAction?.kind === 'ISOLATED_ANOMALY_CONTINUE'
    ? interruptedActionId
    : (bucketState.advisoryAnomalyInterruptedActionId || null);
  let resumeWriteRecovery = Boolean(
    bucketState.writeRecoveryResumePending && bucketState.writeRecoveryIncidentId,
  );
  let writeRecoveryIncidentId = bucketState.writeRecoveryIncidentId || null;
  let writeRecoveryInterruptedActionId = bucketState.writeRecoveryInterruptedActionId || null;
  if (interruptedAction?.kind === 'WRITE_RECOVERY') {
    const recovery = latestRecoverableWriteIncident(bucket);
    if (recovery) {
      resumeWriteRecovery = true;
      writeRecoveryIncidentId = recovery.record.id;
      writeRecoveryInterruptedActionId = interruptedActionId;
    }
  }
  const rolloverTarget = parseSourcePackNumber(bucketState.sourcePackTargetNumber, Number(bucket));
  const rolloverConsumed = parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, Number(bucket));
  const resumeExactSourcePack = Boolean(
    rolloverTarget !== null
    && !bucketState.sourcePackAccessVerified
    && (rolloverConsumed === null || rolloverConsumed < rolloverTarget)
    && bucketState.sourcePackResumeIncidentId,
  );
  if (oldChatUrl) {
    bucketState.chatHistory ||= [];
    bucketState.chatHistory.push({
      chatId: oldChatId,
      chatUrl: oldChatUrl,
      rolledOverAt: now(),
      reason,
    });
    if (bucketState.chatHistory.length > 50) bucketState.chatHistory = bucketState.chatHistory.slice(-50);
  }
  bucketState.rolloverCount = Number(bucketState.rolloverCount || 0) + 1;
  bucketState.casesSinceChatStart = 0;
  bucketState.lastRolloverAt = now();
  bucketState.lastRolloverReason = reason;
  bucketState.chatId = null;
  bucketState.chatUrl = null;
  bucketState.phase = 'PENDING';
  bucketState.awaitingResponseAt = null;
  bucketState.awaitingActionId = null;
  bucketState.responseBaselineHash = null;
  resetPerChatObservationState(bucketState);
  bucketState.setupVerified = false;
  bucketState.setupVerifiedChatId = null;
  bucketState.transientFailures = 0;
  bucketState.recoveryRolloverReason = null;
  bucketState.writeRecoveryResumePending = resumeWriteRecovery;
  bucketState.writeRecoveryIncidentId = resumeWriteRecovery ? writeRecoveryIncidentId : null;
  bucketState.writeRecoveryInterruptedActionId = resumeWriteRecovery ? writeRecoveryInterruptedActionId : null;
  bucketState.advisoryAnomalyResumePending = resumeAdvisoryAnomaly;
  bucketState.advisoryAnomalyInterruptedActionId = resumeAdvisoryAnomaly
    ? advisoryAnomalyInterruptedActionId
    : null;
  if (resumeExactSourcePack) {
    bucketState.sourcePackResumePending = true;
    resetSourcePackAccessState(bucketState);
  }
  bucketState.lastAction = 'adaptive-rollover-pending';
  recordActivityEvent(state, {
    bucket,
    kind: 'ROLLOVER',
    summary: `rollover queued: ${reason}`,
  });
  saveState();

  log(`B${bucket}: adaptive chat rollover queued; reason=${reason}`);
}

function updateStableCandidate(bucketState, hash, actionIdValue = null, observedAtMs = Date.now()) {
  const sameCandidate = bucketState.candidateHash === hash
    && String(bucketState.candidateActionId || '') === String(actionIdValue || '');
  const previousObservedAt = Date.parse(bucketState.candidateObservedAt || '');
  if (sameCandidate) {
    if (!Number.isFinite(previousObservedAt) || observedAtMs - previousObservedAt >= 500) {
      bucketState.candidateCount = Number(bucketState.candidateCount || 0) + 1;
      bucketState.candidateObservedAt = new Date(observedAtMs).toISOString();
    }
  } else {
    bucketState.candidateHash = hash;
    bucketState.candidateCount = 1;
    bucketState.candidateActionId = actionIdValue || null;
    bucketState.candidateObservedAt = new Date(observedAtMs).toISOString();
  }
  return bucketState.candidateCount >= 2;
}

function clearAwaiting(bucketState, responseActionId) {
  if (!bucketState.awaitingResponseAt || !responseActionId) return false;
  if (String(bucketState.awaitingActionId || '') !== String(responseActionId)) return false;
  bucketState.awaitingResponseAt = null;
  bucketState.awaitingActionId = null;
  bucketState.responseBaselineHash = null;
  return true;
}

function markProcessedResponse(bucketState, responseHash, responseActionId, footer = null) {
  bucketState.processedHash = responseHash;
  bucketState.processedResponseKey = actionResponseKey(responseActionId, responseHash);
  bucketState.lastProcessedActionId = responseActionId || null;
  bucketState.lastProcessedStatus = footer?.status || null;
  bucketState.lastProcessedBlocker = footer?.blocker || null;
  bucketState.candidateHash = null;
  bucketState.candidateCount = 0;
  bucketState.candidateActionId = null;
  bucketState.candidateObservedAt = null;
}

function turnStallReason(bucketState) {
  if (!bucketState.awaitingResponseAt) return null;
  const awaitingAt = Date.parse(bucketState.awaitingResponseAt);
  const effectiveStart = Number.isFinite(awaitingAt) ? awaitingAt : Date.now();

  const generationObservedAt = Date.parse(bucketState.generationObservedAt || '');
  const generationSeen = Boolean(bucketState.generationSeenSinceAction) && Number.isFinite(generationObservedAt);
  const thresholdMinutes = generationSeen
    ? Number(config.postGenerationStallMinutes || 90)
    : Number(config.generationFallbackTimeoutMinutes || Math.max(120, Number(config.turnTimeoutMinutes || 30)));
  const anchor = generationSeen ? Math.max(effectiveStart, generationObservedAt) : effectiveStart;
  const elapsed = Date.now() - anchor;
  if (elapsed < thresholdMinutes * 60 * 1000) return null;

  if (generationSeen) {
    return `generation stopped and no new assistant response became available for ${thresholdMinutes} minutes after action ${bucketState.awaitingActionId || 'unknown'}`;
  }
  return `no visible generation or new assistant response was observed for ${thresholdMinutes} minutes after action ${bucketState.awaitingActionId || 'unknown'}`;
}

function recoverLostAwaitingState() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket) || bucketState.complete || !['ACTIVE', 'SETUP_WAIT'].includes(bucketState.phase)) continue;
    // A pending exact source-pack recovery intentionally clears the previous
    // action's awaiting state so the retry can be sent. Do not resurrect the
    // stale SENT action while that recovery is pending.
    if (bucketState.sourcePackResumePending) continue;

    if (bucketState.awaitingResponseAt || !bucketState.lastMessageSentActionId) continue;

    const actionIdValue = bucketState.lastMessageSentActionId;
    const action = state.actions[actionIdValue];
    if (!action || action.status !== 'SENT') continue;
    if (String(bucketState.lastProcessedActionId || '') === String(actionIdValue)) continue;

    const actionBaseline = action.responseHash || null;

    const sentAt = action.sentAt || bucketState.lastMessageSentAt;
    if (!sentAt || !Number.isFinite(Date.parse(sentAt))) continue;
    const sentAtMs = Date.parse(sentAt);
    const receivedAt = Date.parse(bucketState.lastMessageReceivedAt || '');
    if (Number.isFinite(receivedAt) && receivedAt > sentAtMs) continue;

    const restoreThresholdMinutes = Number(config.generationFallbackTimeoutMinutes || 120);
    if (Date.now() - sentAtMs > restoreThresholdMinutes * 60 * 1000) continue;

    bucketState.awaitingResponseAt = sentAt;
    bucketState.awaitingActionId = actionIdValue;
    bucketState.responseBaselineHash = actionBaseline || bucketState.processedHash || bucketState.lastHash || null;
    bucketState.lastAction = `recovered-awaiting:${actionIdValue}`;
    recovered = true;
    log(`B${bucket}: restored lost awaiting state for ${actionIdValue}`);
  }
  if (recovered) saveState();
  return recovered;
}

function recoverTimeoutHolds() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    if (incident?.kind !== 'TURN_TIMEOUT') continue;
    bucketState.phase = bucketState.chatUrl ? 'ACTIVE' : 'PENDING';
    bucketState.lastAction = 'startup-timeout-recovery';
    bucketState.transientFailures = 0;
    recovered = true;
    log(`B${bucket}: recovered timeout hold after controller restart; incident preserved ${incidentId}`);
  }
  if (recovered) saveState();
}

async function recoverSetupAckHolds(context) {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.phase !== 'HOLD' || !bucketState.chatUrl) continue;
    const setupActionId = bucketState.lastMessageSentActionId;
    const setupAction = setupActionId ? state.actions[setupActionId] : null;
    if (String(bucketState.lastMessageSentKind || setupAction?.kind || '') !== 'PROTOCOL_SETUP') continue;

    const preferredIncidentId = String(bucketState.lastAction || '').startsWith('incident:')
      ? String(bucketState.lastAction).slice('incident:'.length)
      : null;
    const incidentCandidates = Object.values(state.incidents)
      .filter(entry => entry?.path)
      .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
    if (preferredIncidentId) {
      incidentCandidates.sort((a, b) => Number(b.id === preferredIncidentId) - Number(a.id === preferredIncidentId));
    }
    let incidentId = null;
    let incident = null;
    for (const incidentRecord of incidentCandidates) {
      const candidate = loadJson(incidentRecord.path, null);
      if (Number(candidate?.bucket) !== Number(bucket)) continue;
      if (!['SETUP_ACK_MISMATCH', 'SETUP_ACK_TIMEOUT'].includes(String(candidate?.kind || ''))) continue;
      incidentId = incidentRecord.id;
      incident = candidate;
      break;
    }
    if (!incidentId || !incident) continue;

    const page = await ensurePage(context, bucketState);
    if (!page || isAuthenticationPage(page) || await isGenerating(page)) continue;
    const attributed = setupActionId
      ? await latestAssistantAfterActionMarker(page, setupActionId)
      : { attributed: false, text: '' };
    if (!attributed.attributed || !isExactSetupAck(attributed.text)) continue;

    const responseHash = sha16(attributed.text);
    updateReceivedMessage(bucketState, attributed.text, responseHash);
    markProcessedResponse(bucketState, responseHash, setupActionId);
    clearAwaiting(bucketState, setupActionId);
    bucketState.setupVerified = true;
    bucketState.setupVerifiedChatId = bucketState.chatId || null;
    bucketState.phase = 'SETUP_WAIT';
    bucketState.transientFailures = 0;
    bucketState.lastAction = `setup-ack-recovered:${incidentId}`;
    recovered = true;
    saveState();
    log(`B${bucket}: recovered exact setup ACK from current chat; incident preserved ${incidentId}`);
  }
  return recovered;
}

async function recoverLegacyPromotedSetupWaitStates(context) {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.complete || bucketState.phase !== 'ACTIVE' || !bucketState.chatUrl) continue;
    const setupActionId = bucketState.lastMessageSentActionId;
    const setupAction = setupActionId ? state.actions[setupActionId] : null;
    if (String(bucketState.lastMessageSentKind || setupAction?.kind || '') !== 'PROTOCOL_SETUP') continue;
    if (!setupActionId || bucketHasUnresolvedAwaitingAction(bucketState)) continue;

    const page = await ensurePage(context, bucketState);
    if (!page || isAuthenticationPage(page) || await isGenerating(page)) continue;
    const attributed = await latestAssistantAfterActionMarker(page, setupActionId);
    if (!attributed.attributed || !isExactSetupAck(attributed.text)) continue;

    const responseHash = sha16(attributed.text);
    updateReceivedMessage(bucketState, attributed.text, responseHash);
    markProcessedResponse(bucketState, responseHash, setupActionId);
    clearAwaiting(bucketState, setupActionId);
    bucketState.setupVerified = true;
    bucketState.setupVerifiedChatId = bucketState.chatId || null;
    bucketState.phase = 'SETUP_WAIT';
    bucketState.transientFailures = 0;
    bucketState.lastAction = `legacy-setup-wait-recovered:${setupActionId}`;
    recovered = true;
    saveState();
    log(`B${bucket}: normalized legacy ACTIVE setup state after exact setup ACK ${setupActionId}`);
  }
  return recovered;
}

function stageReviewerStallRecovery(bucket, bucketState, reason, lastActionPrefix) {
  if (bucketState.sourcePackResumePending) {
    bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.processedHash = null;
    bucketState.candidateHash = null;
    bucketState.candidateCount = 0;
    bucketState.transientFailures = 0;
    bucketState.lastAction = `${lastActionPrefix}-source-pack-stall-recovery:${reason}`;
    log(`B${bucket}: recovered stalled source-pack in-flight state without resurrecting the prior action; ${reason}`);
    return true;
  }

  if (bucketState.chatUrl) {
    bucketState.chatHistory ||= [];
    bucketState.chatHistory.push({
      chatId: bucketState.chatId || null,
      chatUrl: bucketState.chatUrl,
      rolledOverAt: now(),
      reason: `reviewer stall recovery: ${reason}`,
    });
    if (bucketState.chatHistory.length > 50) bucketState.chatHistory = bucketState.chatHistory.slice(-50);
  }
  bucketState.rolloverCount = Number(bucketState.rolloverCount || 0) + 1;
  bucketState.casesSinceChatStart = 0;
  bucketState.lastRolloverAt = now();
  bucketState.lastRolloverReason = `reviewer stall recovery: ${reason}`;
  bucketState.chatId = null;
  bucketState.chatUrl = null;
  bucketState.phase = 'PENDING';
  bucketState.awaitingResponseAt = null;
  bucketState.awaitingActionId = null;
  bucketState.responseBaselineHash = null;
  resetPerChatObservationState(bucketState);
  bucketState.transientFailures = 0;
  bucketState.lastAction = `${lastActionPrefix}-reviewer-stall-rollover:${reason}`;
  log(`B${bucket}: staged clean reviewer rollover after stall; ${reason}`);
  return true;
}

async function recoverStalledReviewerGeneration(context, bucket, bucketState, reason, lastActionPrefix) {
  if (!bucketState.chatUrl) {
    log(`B${bucket}: fail-closed reviewer stall recovery; no managed chat URL is available to verify generation`);
    return false;
  }

  let page;
  let isLive;
  try {
    page = await ensurePage(context, bucketState);
    if (!page || isAuthenticationPage(page)) {
      log(`B${bucket}: fail-closed reviewer stall recovery; managed chat is unavailable or requires authentication`);
      return false;
    }

    isLive = await isGenerating(page);
    if (isLive) {
      const stopped = await stopLiveGeneration(page);
      if (!stopped) {
        log(`B${bucket}: fail-closed reviewer stall recovery; live generation could not be stopped`);
        return false;
      }
      isLive = await isGenerating(page);
      if (isLive) {
        log(`B${bucket}: fail-closed reviewer stall recovery; generation remains live after Stop`);
        return false;
      }
    }

    const actionId = bucketState.awaitingActionId;
    if (actionId) {
      const attributed = await latestAssistantAfterActionMarker(page, actionId);
      if (attributed.attributed && attributed.text) {
        log(`B${bucket}: reviewer stall recovery deferred; completed response ${actionId} is available for reconciliation`);
        return false;
      }
    }
  } catch (error) {
    log(`B${bucket}: fail-closed reviewer stall recovery; generation could not be verified (${error.message || error})`);
    return false;
  }

  if (bucketState.sourcePackResumePending) {
    return stageReviewerStallRecovery(bucket, bucketState, reason, lastActionPrefix);
  }

  await rolloverReviewer(context, Number(bucket), `reviewer stall recovery: ${reason}`);
  return true;
}

async function recoverReviewerStallHolds(context) {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    if (incident?.kind !== 'REVIEWER_STALL') continue;

    if (await recoverStalledReviewerGeneration(
      context,
      bucket,
      bucketState,
      incidentId,
      'startup',
    )) recovered = true;
  }
  if (recovered) saveState();
}

function recoverLegacyInterruptedWriteRecoveryRollovers() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)
      || bucketState.complete
      || bucketState.phase === 'HOLD'
      || bucketState.writeRecoveryResumePending) continue;

    const recovery = latestRecoverableWriteIncident(bucket);
    if (!recovery) continue;
    const incidentAt = Date.parse(recovery.incident?.detectedAt || '');
    if (!Number.isFinite(incidentAt)) continue;

    const lastProgressAt = Date.parse(bucketState.lastProgressAt || '');
    if (Number.isFinite(lastProgressAt) && lastProgressAt > incidentAt) continue;

    const recoveryActions = Object.values(state.actions || {})
      .filter(action => (
        Number(action?.bucket) === Number(bucket)
        && action?.kind === 'WRITE_RECOVERY'
        && Number.isFinite(Date.parse(action?.sentAt || ''))
        && Date.parse(action.sentAt) >= incidentAt
      ))
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
    const latestRecoveryAction = recoveryActions[0];
    if (!latestRecoveryAction) continue;

    const recoverySentAt = Date.parse(latestRecoveryAction.sentAt);
    const rolloverAt = Date.parse(bucketState.lastRolloverAt || '');
    if (!Number.isFinite(rolloverAt) || rolloverAt <= recoverySentAt) continue;

    // A later processed action or source-pack transition proves this recovery
    // completed before the later rollover. Do not resurrect historical
    // WRITE_RECOVERY work merely because the original incident remains on disk.
    const laterProcessedAction = bucketState.lastProcessedActionId
      ? state.actions?.[bucketState.lastProcessedActionId]
      : null;
    const laterProcessedAt = Date.parse(laterProcessedAction?.sentAt || '');
    const laterSourcePackTransitionAt = Date.parse(bucketState.lastSourcePackTransitionAt || '');
    if ((Number.isFinite(laterProcessedAt) && laterProcessedAt > recoverySentAt)
      || (Number.isFinite(laterSourcePackTransitionAt) && laterSourcePackTransitionAt > recoverySentAt)) {
      continue;
    }

    const terminalFailureAfterRecovery = Object.values(state.incidents || {}).some(record => {
      if (!record?.path) return false;
      const incident = loadJson(record.path, null);
      return Number(incident?.bucket) === Number(bucket)
        && incident?.kind === 'WRITE_RECOVERY_TERMINAL_FAILURE'
        && Number.isFinite(Date.parse(incident?.detectedAt || ''))
        && Date.parse(incident.detectedAt) >= recoverySentAt;
    });
    if (terminalFailureAfterRecovery) continue;

    bucketState.writeRecoveryResumePending = true;
    bucketState.writeRecoveryIncidentId = recovery.record.id;
    bucketState.writeRecoveryInterruptedActionId = latestRecoveryAction.id;

    const target = parseSourcePackNumber(bucketState.sourcePackTargetNumber, Number(bucket));
    const consumed = parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, Number(bucket));
    if (target !== null
      && !bucketState.sourcePackAccessVerified
      && (consumed === null || consumed < target)) {
      bucketState.sourcePackResumePending = true;
      resetSourcePackAccessState(bucketState);
    }
    recovered = true;
    log(`B${bucket}: restored interrupted WRITE_RECOVERY ${latestRecoveryAction.id} after legacy chat rollover; incident ${recovery.record.id}`);
  }
  if (recovered) saveState();
  return recovered;
}

function recoverLegacyInterruptedAdvisoryAnomalyRollovers() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)
      || bucketState.complete
      || bucketState.advisoryAnomalyResumePending) continue;

    const candidates = Object.values(state.incidents || {})
      .filter(entry => entry?.path)
      .map(record => ({ record, incident: loadJson(record.path, null) }))
      .filter(entry => Number(entry.incident?.bucket) === Number(bucket)
        && entry.incident?.kind === 'REVIEWER_ERROR_FOOTER'
        && isRecoverableAdvisoryCoordinatorFooter(entry.incident?.footer))
      .sort((a, b) => Date.parse(b.incident?.detectedAt || '') - Date.parse(a.incident?.detectedAt || ''));
    const latestIncident = candidates[0];
    if (!latestIncident) continue;

    const incidentAt = Date.parse(latestIncident.incident?.detectedAt || '');
    if (!Number.isFinite(incidentAt)) continue;
    const advisoryActions = Object.values(state.actions || {})
      .filter(action => (
        Number(action?.bucket) === Number(bucket)
        && action?.kind === 'ISOLATED_ANOMALY_CONTINUE'
        && Number.isFinite(Date.parse(action?.sentAt || ''))
        && Date.parse(action.sentAt) >= incidentAt
      ))
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
    const latestAdvisoryAction = advisoryActions[0];
    if (!latestAdvisoryAction) continue;

    const advisorySentAt = Date.parse(latestAdvisoryAction.sentAt);
    const rolloverAt = Date.parse(bucketState.lastRolloverAt || '');
    if (!Number.isFinite(rolloverAt) || rolloverAt <= advisorySentAt) continue;

    const laterProgressAt = Date.parse(bucketState.lastProgressAt || '');
    const laterSourcePackTransitionAt = Date.parse(bucketState.lastSourcePackTransitionAt || '');
    if ((Number.isFinite(laterProgressAt) && laterProgressAt > advisorySentAt)
      || (Number.isFinite(laterSourcePackTransitionAt) && laterSourcePackTransitionAt > advisorySentAt)) {
      continue;
    }

    const lastProcessedAction = bucketState.lastProcessedActionId
      ? state.actions?.[bucketState.lastProcessedActionId]
      : null;
    const lastProcessedAt = Date.parse(lastProcessedAction?.sentAt || '');
    if (lastProcessedAction?.kind !== 'PROTOCOL_SETUP'
      && Number.isFinite(lastProcessedAt)
      && lastProcessedAt > rolloverAt) {
      continue;
    }

    bucketState.advisoryAnomalyResumePending = true;
    bucketState.advisoryAnomalyInterruptedActionId = latestAdvisoryAction.id;
    recovered = true;
    log(`B${bucket}: restored interrupted ISOLATED_ANOMALY_CONTINUE ${latestAdvisoryAction.id} after legacy chat rollover; incident ${latestIncident.record.id}`);
  }
  if (recovered) saveState();
  return recovered;
}

async function recoverStaleAwaitingReviewers(context) {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.complete || !['ACTIVE', 'SETUP_WAIT'].includes(bucketState.phase)) continue;
    const stall = turnStallReason(bucketState);
    if (!stall) continue;

    if (await recoverStalledReviewerGeneration(
      context,
      bucket,
      bucketState,
      stall,
      'runtime',
    )) recovered = true;
  }
  if (recovered) saveState();
}

function recoverUnavailableSourcePackHolds() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (!isVerifiedSourcePackCursor(bucket, bucketState)) continue;
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    const footer = incident?.footer;
    const blocker = String(footer?.blocker || '').trim().toUpperCase();
    if (incident?.kind !== 'REVIEWER_ERROR_FOOTER'
      || footer?.status !== 'ERROR'
      || footer?.writesVerified !== 'YES'
      || blocker !== 'SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED') continue;

    sanitizeStoredSourcePackCursorFields(Number(bucket), bucketState);
    const resolved = resolveNextSourcePackTargetNumber(Number(bucket), {
      bucketState,
      incident,
      incidentId,
    });
    if (!isValidSourcePackNumber(Number(bucket), resolved.targetNumber)) continue;

    const unavailableAt = now();
    const unavailableCount = Math.max(1, Number(bucketState.sourcePackUnavailableCount || 0));
    const retryNotBefore = bucketState.sourcePackRetryNotBefore
      || new Date(Date.parse(unavailableAt) + sourcePackRetryDelayMs(unavailableCount)).toISOString();
    bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
    bucketState.lastAction = `startup-source-pack-unavailable-backoff:${incidentId}:pack-${resolved.targetNumber}:until-${retryNotBefore}`;
    bucketState.candidateHash = null;
    bucketState.candidateCount = 0;
    bucketState.candidateActionId = null;
    bucketState.candidateObservedAt = null;
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.transientFailures = 0;
    bucketState.sourcePackResumePending = true;
    applyResolvedSourcePackTarget(Number(bucket), bucketState, resolved, incidentId);
    resetSourcePackAccessState(bucketState);
    bucketState.sourcePackUnavailableCount = unavailableCount;
    bucketState.sourcePackLastUnavailableAt ||= unavailableAt;
    bucketState.sourcePackRetryNotBefore = retryNotBefore;
    recovered = true;
    log(`B${bucket}: recovered unavailable source pack with persisted backoff until ${retryNotBefore}; incident preserved ${incidentId}`);
  }
  if (recovered) saveState();
}

function preserveUnresolvedNewChatHolds() {
  let changed = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    const creation = bucketState.newChatCreation;
    if (!bucketState.chatUrl
      && (bucketState.lastAction === 'new-chat-send-not-observed'
        || String(bucketState.lastAction || '').startsWith('startup-new-chat-retry:'))) {
      const action = latestSetupAction(bucket);
      recordIncident(
        'NEW_CHAT_SEND_UNCONFIRMED',
        bucket,
        'legacy controller state shows an unconfirmed setup send; automatic retry is disabled to avoid a duplicate conversation',
        { actionId: action?.id || bucketState.lastMessageSentActionId || null },
        { wakeCoordinator: false },
      );
      changed = true;
      continue;
    }
    if (creation?.status && bucketState.chatUrl) {
      bucketState.newChatCreation = null;
      changed = true;
      continue;
    }
    if (creation?.status && bucketState.phase !== 'HOLD') {
      recordIncident(
        'NEW_CHAT_CREATION_UNRESOLVED',
        bucket,
        'startup found an incomplete reviewer-chat creation (' + creation.status + '); it remains held to prevent a duplicate conversation',
        { creationStatus: creation.status, actionId: creation.actionId || null },
        { wakeCoordinator: false },
      );
      changed = true;
      continue;
    }
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    if (incident?.kind === 'NEW_CHAT_ID_TIMEOUT' || incident?.kind === 'NEW_CHAT_SEND_UNCONFIRMED') {
      log('B' + bucket + ': preserving unresolved chat creation; automatic retry disabled for ' + incident.kind);
    }
  }
  if (changed) saveState();
}

function recoverRetryablePartialWriteHolds() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    const footer = incident?.footer;
    if (incident?.kind !== 'REVIEWER_ERROR_FOOTER'
      || !(isRecoverableReadbackFooter(footer) || isRecoverableRegistryWriteFooter(footer))) continue;

    // Reprocess the same stable response once after restart so the recovery
    // action can be sent without discarding the incident record.
    bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
    bucketState.lastAction = `startup-partial-write-recovery:${incidentId}`;
    bucketState.processedHash = null;
    bucketState.candidateHash = null;
    bucketState.candidateCount = 0;
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.transientFailures = 0;
    recovered = true;
    log(`B${bucket}: recovered partial-write hold after controller restart; incident preserved ${incidentId}`);
  }
  if (recovered) saveState();
}

function recoverRetryableExactPackHolds() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    const footer = incident?.footer;
    const packNumber = recoverablePackNumberFromFooter(footer);
    if (incident?.kind !== 'REVIEWER_ERROR_FOOTER' || !Number.isInteger(packNumber)) continue;

    bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
    bucketState.lastAction = `startup-exact-pack-recovery:${incidentId}:pack-${packNumber}`;
    bucketState.processedHash = null;
    bucketState.candidateHash = null;
    bucketState.candidateCount = 0;
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.transientFailures = 0;
    recovered = true;
    log(`B${bucket}: staged exact-pack recovery for pack ${String(packNumber).padStart(6, '0')}; incident preserved ${incidentId}`);
  }
  if (recovered) saveState();
}

function recoverAdvisoryCoordinatorHolds() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.complete || bucketHasUnresolvedAwaitingAction(bucketState)) continue;

    let incidentId = null;
    let incidentRecord = null;
    let incident = null;
    if (bucketState.phase === 'HOLD' && String(bucketState.lastAction || '').startsWith('incident:')) {
      incidentId = String(bucketState.lastAction).slice('incident:'.length);
      incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
      incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    } else if (String(bucketState.lastProcessedStatus || '').toUpperCase() === 'ERROR'
      && String(bucketState.lastProcessedBlocker || '').trim().toUpperCase() === 'TERMINAL_DUPLICATE_CLASSIFICATION_COLLISION') {
      const candidates = Object.values(state.incidents || {})
        .filter(entry => entry?.path)
        .map(record => ({ record, incident: loadJson(record.path, null) }))
        .filter(entry => Number(entry.incident?.bucket) === Number(bucket)
          && entry.incident?.kind === 'REVIEWER_ERROR_FOOTER'
          && isRecoverableAdvisoryCoordinatorFooter(entry.incident?.footer))
        .sort((a, b) => Date.parse(b.incident?.detectedAt || '') - Date.parse(a.incident?.detectedAt || ''));
      const latest = candidates[0];
      if (!latest) continue;
      const incidentAt = Date.parse(latest.incident?.detectedAt || '');
      const lastSentAt = Date.parse(bucketState.lastMessageSentAt || '');
      if (Number.isFinite(lastSentAt) && Number.isFinite(incidentAt) && lastSentAt > incidentAt) continue;
      incidentRecord = latest.record;
      incident = latest.incident;
      incidentId = latest.record.id;
    } else {
      continue;
    }

    const footer = incident?.footer;
    if (incident?.kind !== 'REVIEWER_ERROR_FOOTER' || !isRecoverableAdvisoryCoordinatorFooter(footer)) continue;

    bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
    bucketState.lastAction = `startup-advisory-anomaly-recovery:${incidentId}`;
    bucketState.processedHash = null;
    bucketState.candidateHash = null;
    bucketState.candidateCount = 0;
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.transientFailures = 0;
    recovered = true;
    log(`B${bucket}: staged verified-write advisory anomaly recovery; incident preserved ${incidentId}`);
  }
  if (recovered) saveState();
}

function recoverRetryableTurnBoundaryHolds() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    const footer = incident?.footer;
    if (incident?.kind !== 'REVIEWER_ERROR_FOOTER'
      || !isRecoverableTurnBoundaryFooter(footer)) continue;

    // The reviewer finished a valid turn and verified its writes. Reprocess
    // that stable footer once so the normal continuation action is sent.
    bucketState.phase = bucketState.chatUrl ? 'ACTIVE' : 'PENDING';
    bucketState.lastAction = `startup-turn-boundary-recovery:${incidentId}`;
    bucketState.processedHash = null;
    bucketState.candidateHash = null;
    bucketState.candidateCount = 0;
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.transientFailures = 0;
    recovered = true;
    log(`B${bucket}: recovered benign ${footer.blocker} hold; incident preserved ${incidentId}`);
  }
  if (recovered) saveState();
}

function resetSetupWaitObservationState() {
  let reset = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.complete || bucketState.phase !== 'SETUP_WAIT') continue;
    if (bucketState.setupVerified
      && String(bucketState.setupVerifiedChatId || '') === String(bucketState.chatId || '')) continue;
    resetPerChatObservationState(bucketState);
    bucketState.lastAction = bucketState.awaitingActionId
      ? `setup-wait-observation-reset:${bucketState.awaitingActionId}`
      : 'setup-wait-observation-reset';
    reset = true;
    log(`B${bucket}: reset per-chat response hashes for SETUP_WAIT recovery`);
  }
  if (reset) saveState();
}

function recoverInvalidLegacyChatRehydration() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    const configuredChatId = config.buckets?.[String(bucket)]?.conversationId || null;
    if (!configuredChatId || bucketState.chatId !== configuredChatId || !bucketState.lastRolloverAt) continue;

    const rolledOverAt = Date.parse(bucketState.lastRolloverAt);
    const lastSentAt = Date.parse(bucketState.lastMessageSentAt || '');
    if (!Number.isFinite(rolledOverAt)) continue;
    if (Number.isFinite(lastSentAt) && rolledOverAt <= lastSentAt) continue;

    bucketState.chatId = null;
    bucketState.chatUrl = null;
    bucketState.phase = 'PENDING';
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    resetPerChatObservationState(bucketState);
    bucketState.lastAction = 'startup-invalid-legacy-chat-recovery';
    recovered = true;
    log(`B${bucket}: discarded legacy configured chat restored after a newer rollover`);
  }
  if (recovered) saveState();
}

function recoverSourcePackHolds() {
  const marker = loadJson(SOURCE_PACK_READY_PATH, null);
  const markerId = String(marker?.id || '').trim();
  if (!markerId || String(marker?.status || '').toUpperCase() !== 'UPLOADED') return;

  const released = [];
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (!isVerifiedSourcePackCursor(bucket, bucketState)) continue;
    if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) continue;
    const incidentId = String(bucketState.lastAction).slice('incident:'.length);
    const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    if (incident?.kind !== 'NEXT_SOURCE_PACKS_REQUIRED') continue;
    const shard = configuredSourcePackShard(bucket);
    if (!shard) continue;
    const resolved = resolveNextSourcePackTargetNumber(Number(bucket), {
      bucketState,
      incident,
      incidentId,
    });
    const targetNumber = resolved.targetNumber;
    if (!isValidSourcePackNumber(Number(bucket), targetNumber)) continue;
    const filename = sourcePackFilename(targetNumber, Number(bucket));
    if (bucketState.sourcePackResumePending
      && bucketState.sourcePackResumeIncidentId === incidentId
      && bucketState.sourcePackTargetNumber === targetNumber) continue;

    bucketState.phase = 'PAUSED';
    bucketState.lastAction = `source-pack-ready:${markerId}:${filename}:${incidentId}`;
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.candidateHash = null;
    bucketState.candidateCount = 0;
    bucketState.transientFailures = 0;
    bucketState.sourcePackResumePending = true;
    bucketState.sourcePackResumeIncidentId = incidentId;
    bucketState.sourcePackTargetNumber = targetNumber;
    bucketState.sourcePackTargetFilename = filename;
    resetSourcePackAccessState(bucketState);
    released.push(Number(bucket));
  }

  if (released.length) {
    state.sourcePackRelease = {
      id: markerId,
      recoveredAt: now(),
      records: Number(marker?.records || 0),
      packCount: Number(marker?.packCount || 0),
      buckets: released,
    };
    saveState();
    log(`source-pack release ${markerId}: prepared bucket boundaries ${released.join(',')}; active cap=${MAX_ACTIVE_REVIEWERS}`);
  }
}

async function sendPendingSourcePackContinuations(context) {
  if (readControl().desiredState !== 'RUNNING' || !preDispatchReady) return;
  for (const [bucket, bucketState] of Object.entries(state.buckets).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (readControl().desiredState !== 'RUNNING' || !preDispatchReady) return;
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (!isVerifiedSourcePackCursor(bucket, bucketState)) continue;
    if (!bucketState.sourcePackResumePending
      || bucketState.complete
      || bucketState.phase === 'HOLD'
      || bucketState.writeRecoveryResumePending) continue;
    if (bucketState.awaitingResponseAt || bucketState.awaitingActionId) continue;

    const currentTarget = parseSourcePackNumber(bucketState.sourcePackTargetNumber, Number(bucket));
    const inventoryLastPack = sourcePackInventoryLastNumber(bucket);
    if (isSourcePackBeyondInventory(currentTarget, inventoryLastPack)) {
      assertControlRunning();
      if (!bucketState.chatUrl) continue;
      const page = await ensurePage(context, bucketState);
      if (!page || await isGenerating(page)) continue;
      if (isAuthenticationPage(page)) {
        bucketState.lastAction = 'waiting-for-browser-auth';
        saveState();
        continue;
      }

      const composer = page.locator(COMPOSER_LOCATOR_SELECTOR).first();
      let composerVisible = false;
      try {
        composerVisible = await composer.count() > 0 && await composer.isVisible();
      } catch {}
      if (!composerVisible) {
        bucketState.lastAction = 'waiting-for-chat-composer';
        saveState();
        continue;
      }

      const latestAssistant = await latestMessage(page, 'assistant');
      const responseHash = latestAssistant ? sha16(latestAssistant) : (bucketState.processedHash || bucketState.lastHash || '');
      const actionIdSent = await sendAction(
        page,
        Number(bucket),
        'CORPUS_RECONCILE',
        corpusReconciliationPrompt(Number(bucket)),
        responseHash,
      );
      bucketState.sourcePackResumePending = false;
      bucketState.phase = 'ACTIVE';
      bucketState.lastAction = `corpus-reconcile-sent-after-pack-inventory-end:${inventoryLastPack}`;
      saveState();
      log(`B${bucket}: source-pack inventory ends at ${inventoryLastPack}; full-corpus reconciliation sent (${actionIdSent})`);
      recordActivityEvent(state, {
        bucket,
        kind: 'CORPUS_RECONCILE',
        summary: `full-corpus reconciliation after verified source-pack inventory end (${actionIdSent})`,
      });
      continue;
    }

    if (!sourcePackRetryReady(bucketState)) continue;
    assertControlRunning();

    const incidentId = bucketState.sourcePackResumeIncidentId;
    const incidentRecord = incidentId
      ? Object.values(state.incidents).find(entry => entry.id === incidentId)
      : null;
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    sanitizeStoredSourcePackCursorFields(Number(bucket), bucketState);
    const resolved = resolveNextSourcePackTargetNumber(Number(bucket), {
      bucketState,
      incident,
      incidentId,
    });
    if (!isValidSourcePackNumber(Number(bucket), resolved.targetNumber)) {
      bucketState.sourcePackResumePending = false;
      bucketState.lastAction = `source-pack-cursor-unresolved:${resolved.reason}`;
      saveState();
      log(`B${bucket}: refused invalid source-pack continuation target (${resolved.reason})`);
      continue;
    }
    if (!applyResolvedSourcePackTarget(Number(bucket), bucketState, resolved, incidentId)) {
      bucketState.lastAction = 'source-pack-invalid-target';
      saveState();
      continue;
    }
    const targetNumber = resolved.targetNumber;
    const shard = configuredSourcePackShard(bucket);
    if (!shard || !incidentId) {
      recordIncident('SOURCE_PACK_CURSOR_INVALID', Number(bucket), `source-pack recovery has no valid target for incident ${incidentId || 'unknown'}`);
      continue;
    }

    const filename = bucketState.sourcePackTargetFilename;
    if (path.basename(filename) !== filename || isInvalidZeroSourcePackFilename(filename)) {
      bucketState.lastAction = `source-pack-invalid-filename:${filename}`;
      saveState();
      continue;
    }

    const pendingDraft = Object.values(state.actions).find(action => (
      Number(action?.bucket) === Number(bucket)
      && action?.kind === 'SOURCE_PACK_CONTINUE'
      && action?.status === 'DRAFTED'
      && action?.sourcePackTargetFilename === filename
    ));
    const retryAt = Date.parse(pendingDraft?.nextRetryAt || '');
    if (Number.isFinite(retryAt) && Date.now() < retryAt) continue;

    if (sourcePackContinuationAlreadySent(bucketState, state.actions, targetNumber, incidentId)) {
      bucketState.sourcePackResumePending = false;
      bucketState.lastAction = `source-pack-continuation-already-sent:${filename}`;
      saveState();
      continue;
    }

    if (!bucketState.chatUrl) continue;

    const page = await ensurePage(context, bucketState);
    if (!page || await isGenerating(page)) continue;
    if (isAuthenticationPage(page)) {
      bucketState.lastAction = 'waiting-for-browser-auth';
      saveState();
      continue;
    }

    const composer = page.locator(COMPOSER_LOCATOR_SELECTOR).first();
    let composerVisible = false;
    try {
      composerVisible = await composer.count() > 0 && await composer.isVisible();
    } catch {}
    if (!composerVisible) {
      bucketState.lastAction = 'waiting-for-chat-composer';
      saveState();
      continue;
    }

    const latestAssistant = await latestMessage(page, 'assistant');
    const responseHash = latestAssistant ? sha16(latestAssistant) : (bucketState.processedHash || bucketState.lastHash || '');
    const footer = incident?.footer;
    const needsWriteRecovery = footer && footer.writesVerified !== 'YES';
    const source = {
      filename,
      folderUrl: sourcePackShardFolderUrl(shard.folderId),
    };
    const kind = needsWriteRecovery ? 'WRITE_RECOVERY' : 'SOURCE_PACK_CONTINUE';
    const prompt = needsWriteRecovery
      ? partialWriteRecoveryPrompt(Number(bucket), footer)
      : sourcePackContinuationPrompt(Number(bucket), source);

    const actionIdSent = await sendAction(page, Number(bucket), kind, prompt, responseHash);
    if (!needsWriteRecovery) {
      bucketState.sourcePackLastDeliveredNumber = targetNumber;
      bucketState.sourcePackLastDeliveredIncidentId = incidentId;
      bucketState.sourcePackLastDeliveredAt = now();
      bucketState.sourcePackLastDeliveredActionId = actionIdSent;
      recordSourcePackTransition(state, bucket, {
        fromPack: bucketState.sourcePackLastConsumedNumber != null
          ? sourcePackFilename(bucketState.sourcePackLastConsumedNumber, Number(bucket))
          : null,
        toPack: filename,
        at: now(),
      });
    }
    bucketState.sourcePackResumePending = false;
    bucketState.phase = 'ACTIVE';
    bucketState.lastAction = `${kind}-connected-drive:${filename}:${actionIdSent}`;
    saveState();
    log(`B${bucket}: SOURCE_PACK_CONTINUE sent for ${filename} using connected Drive source (${actionIdSent})`);
    recordActivityEvent(state, {
      bucket,
      kind: 'SOURCE_PACK_CONTINUE',
      summary: `SOURCE_PACK_CONTINUE ${filename} (${actionIdSent})`,
    });
  }
}

function updateReceivedMessage(bucketState, text, responseHash) {
  if (bucketState.lastMessageReceivedHash === responseHash) return false;
  bucketState.lastHash = responseHash;
  bucketState.lastMessageReceivedHash = responseHash;
  bucketState.lastMessageReceivedAt = now();
  bucketState.lastMessageReceivedPreview = String(text).replace(/\s+/g, ' ').trim().slice(0, 220);
  return true;
}

function recordFooterProgress(bucket, bucketState, footer, responseAction) {
  bucketState.lastRegistryWriteVerified = footer?.writesVerified || null;
  if (Number(footer?.newCases || 0) > 0 && footer?.writesVerified === 'YES') {
    bucketState.lastRegistryWriteAt = now();
  }
  const count = Number(footer?.newCases || 0);
  if (!Number.isFinite(count) || count <= 0) return;

  bucketState.casesReported = Number(bucketState.casesReported || 0) + count;
  bucketState.casesSinceChatStart = Number(bucketState.casesSinceChatStart || 0) + count;
  state.metrics.casesReported = Number(state.metrics.casesReported || 0) + count;
  state.metrics.casesReportedByBucket[String(bucket)] = Number(
    state.metrics.casesReportedByBucket[String(bucket)] || 0,
  ) + count;

  const sourcePack = bucketState.sourcePackTargetFilename
    || (bucketState.sourcePackTargetNumber != null
      ? sourcePackFilename(bucketState.sourcePackTargetNumber, Number(bucket))
      : null);
  recordAuditProgressEvent(state, {
    bucket,
    actionId: responseAction?.id || bucketState.awaitingActionId || null,
    newCases: count,
    writesVerified: footer?.writesVerified || null,
    sourcePack,
    at: now(),
  });
  recordActivityEvent(state, {
    bucket,
    kind: 'AUDIT_PROGRESS',
    summary: `${count} new cases, writes ${footer?.writesVerified || 'unknown'}${sourcePack ? ` (${sourcePack})` : ''}`,
    at: state.metrics.lastProgressAt,
  });
}

function recordResponseLatency(bucketState, responseAction) {
  if (!responseAction?.sentAt || !bucketState.lastMessageReceivedAt) return;
  const sent = Date.parse(responseAction.sentAt);
  const received = Date.parse(bucketState.lastMessageReceivedAt);
  if (Number.isFinite(sent) && Number.isFinite(received) && received >= sent) {
    bucketState.lastResponseLatencyMs = received - sent;
  }
}

async function processSetupWait(page, bucket, bucketState, text, responseHash) {
  const responseActionId = bucketState.awaitingActionId;
  const responseKey = actionResponseKey(responseActionId, responseHash);
  if (responseKey && bucketState.processedResponseKey === responseKey) return;
  bucketState.lastSeen = now();

  if (!isExactSetupAck(text)) {
    const setupAckTimeoutMinutes = Number(config.setupAckTimeoutMinutes || 5);
    if (!setupAckTimedOut(bucketState, setupAckTimeoutMinutes)) {
      saveState();
      return;
    }
    markProcessedResponse(bucketState, responseHash, responseActionId);
    clearAwaiting(bucketState, responseActionId);
    saveState();
    recordIncident(
      'SETUP_ACK_MISMATCH',
      bucket,
      `setup ACK mismatch; expected PROTOCOL_SETUP_ACK_V3 but received: ${text.slice(0, 500)}`,
    );
    return;
  }

  markProcessedResponse(bucketState, responseHash, responseActionId);
  clearAwaiting(bucketState, responseActionId);
  bucketState.setupVerified = true;
  bucketState.setupVerifiedChatId = bucketState.chatId || null;
  bucketState.phase = 'SETUP_WAIT';
  bucketState.lastAction = 'setup-ack-verified-awaiting-slot';
  saveState();
  log(`B${bucket}: setup ACK verified; waiting for a reviewer slot before initial audit dispatch`);
}

async function processActive(page, bucket, bucketState, text, responseHash, options = {}) {
  const { allowDispatch = true } = options;
  const responseActionId = bucketState.awaitingActionId;
  const responseKey = actionResponseKey(responseActionId, responseHash);
  if (responseKey && bucketState.processedResponseKey === responseKey) return;
  const responseAction = responseActionId ? state.actions[responseActionId] : null;
  clearAwaiting(bucketState, responseActionId);
  bucketState.lastSeen = now();
  recordResponseLatency(bucketState, responseAction);

  const footer = parseFooter(text);

  if (!footer) {
    bucketState.malformedCount = Number(bucketState.malformedCount || 0) + 1;
    markProcessedResponse(bucketState, responseHash, responseActionId);
    saveState();

    if (responseAction?.kind === 'PREREQUISITE_REVALIDATION') {
      recordIncident(
        'REGISTRY_PREREQUISITE_RESULT_MALFORMED',
        bucket,
        'registry prerequisite revalidation returned no strict AUDIT_TURN_STATUS footer; automatic release is unsafe',
        { actionId: responseAction.id, responsePreview: String(text).slice(0, 500) },
        { holdType: 'INTEGRITY' },
      );
      return;
    }

    if (bucketState.malformedCount <= 1) {
      if (!allowDispatch) {
        bucketState.lastAction = 'malformed-response-reconciled-without-dispatch';
        saveState();
        log(`B${bucket}: malformed response reconciled without dispatch`);
        return;
      }
      await sendAction(page, bucket, 'MALFORMED_RECOVERY', malformedRecoveryPrompt(bucket), responseHash);
      bucketState.lastAction = 'malformed-recovery-sent';
      saveState();
      log(`B${bucket}: malformed/truncated footer; recovery turn sent`);
      return;
    }

    recordIncident(
      'REPEATED_MALFORMED_FOOTER',
      bucket,
      `two consecutive stable reviewer responses lacked the required footer. Latest response starts: ${text.slice(0, 700)}`,
    );
    return;
  }

  bucketState.malformedCount = 0;
  markProcessedResponse(bucketState, responseHash, responseActionId, footer);
  recordFooterProgress(bucket, bucketState, footer, responseAction);

  if (responseAction?.kind === 'PREREQUISITE_REVALIDATION') {
    const availability = String(text).match(/(?:^|\n)REGISTRY_SHARD_AVAILABLE:\s*(YES|NO)\s*(?:\n|$)/i)?.[1]?.toUpperCase();
    if (availability === 'NO' || registryAvailabilityBlocker(footer)) {
      recordIncident(
        'REGISTRY_PREREQUISITE_UNAVAILABLE',
        bucket,
        `canonical registry shard ${bucket} is still unavailable after automatic revalidation`,
        { footer, actionId: responseAction.id, validation: { kind: 'REGISTRY_SHARD_AVAILABLE', bucket: Number(bucket) } },
        { holdType: 'TRANSIENT_EXTERNAL', validation: { kind: 'REGISTRY_SHARD_AVAILABLE', bucket: Number(bucket) } },
      );
      return;
    }
    if (availability !== 'YES'
      || footer.status !== 'NORMAL'
      || footer.writesVerified !== 'YES'
      || footer.blocker.trim().toUpperCase() !== 'NONE'
      || footer.triggerCoordinator !== 'NO') {
      recordIncident(
        'REGISTRY_PREREQUISITE_RESULT_AMBIGUOUS',
        bucket,
        'registry availability response did not prove the exact shard was accessible; preserving an integrity hold',
        { footer, actionId: responseAction.id, responsePreview: String(text).slice(0, 500) },
        { holdType: 'INTEGRITY' },
      );
      return;
    }

    bucketState.hold = null;
    bucketState.transientHoldRetryCount = 0;
    bucketState.phase = 'ACTIVE';
    bucketState.lastAction = `registry-prerequisite-revalidated:${responseAction.id}`;
    saveState();
    recordActivityEvent(state, {
      bucket,
      kind: 'HOLD_RELEASED',
      summary: `registry shard ${bucket} revalidated; prior action response reconciled`,
    });
    if (allowDispatch) {
      await sendAction(page, bucket, 'CONTINUE', continuationPrompt(bucket), responseHash);
      bucketState.lastAction = `continue-after-registry-revalidation:${responseAction.id}`;
      saveState();
    }
    return;
  }

  if (reviewerConfirmedSourcePackAccess(bucketState, footer, responseAction)) {
    const targetNumber = parseSourcePackNumber(bucketState.sourcePackTargetNumber, Number(bucket));
    markSourcePackAccessVerified(bucketState, {
      targetNumber,
      incidentId: bucketState.sourcePackResumeIncidentId || bucketState.sourcePackLastDeliveredIncidentId,
      filename: bucketState.sourcePackTargetFilename
        || sourcePackFilename(targetNumber, Number(bucket)),
      requestActionId: responseAction?.id || bucketState.sourcePackLastDeliveredActionId,
    });
    recordSourcePackCursorEvidence(bucket, bucketState, {
      targetNumber,
      evidenceKind: 'SOURCE_PACK_ACCESS',
      sourceActionId: responseAction?.id,
      responseActionId,
      responseHash,
      footer,
    });
  }

  if (responseAction?.kind === 'WRITE_RECOVERY') {
    const blocker = String(footer.blocker || '').trim().toUpperCase();
    const recoveryStillFailed = isRecoverableReadbackFooter(footer) || isRecoverableRegistryWriteFooter(footer);
    if (recoveryStillFailed) {
      bucketState.writeRecoveryResumePending = false;
      bucketState.writeRecoveryIncidentId = null;
      bucketState.writeRecoveryInterruptedActionId = null;
      saveState();
      recordIncident(
        'WRITE_RECOVERY_TERMINAL_FAILURE',
        bucket,
        `WRITE_RECOVERY ${responseAction.id} returned STATUS=${footer.status}; WRITES_VERIFIED=${footer.writesVerified}; BLOCKER=${footer.blocker}; automatic retry stopped`,
        { footer, recoveryActionId: responseAction.id },
      );
      return;
    }

    const recoverySucceeded = footer.status === 'NORMAL'
      && footer.writesVerified === 'YES'
      && footer.triggerCoordinator === 'NO'
      && ['NONE', 'NEXT_SOURCE_PACKS_REQUIRED'].includes(blocker);
    if (recoverySucceeded) {
      bucketState.writeRecoveryResumePending = false;
      bucketState.writeRecoveryIncidentId = null;
      bucketState.writeRecoveryInterruptedActionId = null;

      const recoveryTarget = parseSourcePackNumber(bucketState.sourcePackTargetNumber, Number(bucket));
      const recoveryConsumed = parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, Number(bucket));
      const exactSourcePackStillPending = Boolean(
        bucketState.sourcePackResumePending
        || (
          recoveryTarget !== null
          && !bucketState.sourcePackAccessVerified
          && (recoveryConsumed === null || recoveryConsumed < recoveryTarget)
          && bucketState.sourcePackResumeIncidentId
        ),
      );
      if (exactSourcePackStillPending) {
        bucketState.sourcePackResumePending = true;
        resetSourcePackAccessState(bucketState);
        bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
        bucketState.lastAction = 'write-recovery-complete-source-pack-resume-pending';
        saveState();
        log(`B${bucket}: write recovery verified; exact source-pack continuation remains pending`);
        return;
      }
      saveState();
    }
  }

  if (footer.status === 'COMPLETE') {
    if (footer.writesVerified !== 'YES') {
      saveState();
      if (!allowDispatch) {
        bucketState.lastAction = `complete-response-reconciled-without-dispatch-${footer.writesVerified.toLowerCase()}`;
        saveState();
        log(`B${bucket}: COMPLETE candidate reconciled without dispatch`);
        return;
      }
      await sendAction(page, bucket, 'WRITE_RECOVERY', partialWriteRecoveryPrompt(bucket, footer), responseHash);
      bucketState.lastAction = `write-recovery-before-corpus-completion-${footer.writesVerified.toLowerCase()}`;
      saveState();
      log(`B${bucket}: COMPLETE candidate had ${footer.writesVerified} writes; write reconciliation requested first`);
      return;
    }

    const evidence = parseCorpusCompletionEvidence(text);
    if (responseAction?.kind === 'CORPUS_RECONCILE') {
      if (footer.triggerCoordinator === 'YES' || footer.blocker.trim().toUpperCase() !== 'NONE') {
        saveState();
        recordIncident(
          'COMPLETE_WITH_UNRESOLVED_BLOCKER',
          bucket,
          `full-corpus reconciliation reported COMPLETE with BLOCKER=${footer.blocker}; TRIGGER_COORDINATOR=${footer.triggerCoordinator}`,
          { footer, evidence },
        );
        return;
      }

      if (isVerifiedCorpusCompletion(evidence, config.auditablePopulation)) {
        bucketState.corpusCompleteVerified = true;
        bucketState.complete = true;
        bucketState.phase = 'COMPLETE';
        bucketState.lastAction = 'corpus-complete-verified';
        bucketState.awaitingResponseAt = null;
        bucketState.awaitingActionId = null;
        saveState();
        log(`B${bucket}: full-corpus COMPLETE verified; reviewer slot released`);
        return;
      }

      saveState();
      recordIncident(
        'UNPROVEN_CORPUS_COMPLETION',
        bucket,
        `reviewer repeated COMPLETE without valid full-corpus evidence for auditable population ${config.auditablePopulation}`,
        { footer, evidence },
      );
      return;
    }

    bucketState.complete = false;
    bucketState.corpusCompleteVerified = false;
    saveState();
    if (!allowDispatch) {
      bucketState.lastAction = 'complete-response-reconciled-without-dispatch';
      saveState();
      log(`B${bucket}: COMPLETE observed during reconciliation without dispatch`);
      return;
    }
    await sendAction(page, bucket, 'CORPUS_RECONCILE', corpusReconciliationPrompt(bucket), responseHash);
    bucketState.lastAction = 'corpus-reconcile-sent';
    saveState();
    log(`B${bucket}: COMPLETE observed; full-corpus reconciliation requested instead of retiring bucket`);
    return;
  }

  if (responseAction?.kind === 'CORPUS_RECONCILE' && footer.writesVerified === 'YES') {
    bucketState.sourcePackResumePending = false;
    bucketState.sourcePackRetryNotBefore = null;
    saveState();
    const inventoryLastPack = sourcePackInventoryLastNumber(bucket);
    recordIncident(
      'CORPUS_RECONCILE_UNRESOLVED',
      bucket,
      `full-corpus reconciliation did not prove completion; STATUS=${footer.status}; BLOCKER=${footer.blocker}; verified source inventory last pack=${inventoryLastPack ?? 'unknown'}`,
      { footer, evidence: parseCorpusCompletionEvidence(text) },
    );
    return;
  }

  if (footer.blocker.trim().toUpperCase() === 'NEXT_SOURCE_PACKS_REQUIRED') {
    const currentTargetNumber = parseSourcePackNumber(bucketState.sourcePackTargetNumber, bucket);
    const currentTargetFilename = sourcePackFilename(currentTargetNumber, Number(bucket));
    if (currentTargetNumber !== null
      && currentTargetFilename
      && responseIndicatesSourcePackUnavailable(text, currentTargetFilename)) {
      recordSourcePackBoundaryEvidence(bucket, bucketState, text);
      const incidentPath = recordIncident(
        'SOURCE_PACK_BOUNDARY_CONTRADICTION',
        bucket,
        `${currentTargetFilename} was explicitly unavailable in a NEXT_SOURCE_PACKS_REQUIRED response; preserving the exact target instead of advancing`,
        { footer, preservedTarget: currentTargetFilename },
        { wakeCoordinator: false, holdBucket: false },
      );
      const incidentRecord = incidentPath
        ? Object.values(state.incidents).find(entry => entry.path === incidentPath)
        : null;
      stageUnavailableSourcePackBackoff(
        bucket,
        bucketState,
        currentTargetNumber,
        incidentRecord?.id || bucketState.sourcePackResumeIncidentId,
      );
      saveState();
      log(`B${bucket}: boundary footer contradicted by unavailable ${currentTargetFilename}; target preserved with retry backoff`);
      return;
    }

    recordSourcePackBoundaryEvidence(bucket, bucketState, text);
    const lastConsumed = parseSourcePackNumber(bucketState.sourcePackTargetNumber, bucket)
      ?? parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, bucket)
      ?? parseSourcePackNumber(bucketState.sourcePackLastVisibleNumber, bucket)
      ?? parseSourcePackNumber(bucketState.sourcePackLastDeliveredNumber, bucket);
    if (lastConsumed !== null) {
      bucketState.sourcePackLastDeliveredNumber = lastConsumed;
      bucketState.sourcePackLastConsumedNumber = lastConsumed;
    }
    saveState();
    const recoverableSourceBoundary = isSourcePackBoundaryFooter(footer);
    const incidentPath = recordIncident(
      'NEXT_SOURCE_PACKS_REQUIRED',
      bucket,
      `Bucket ${bucket} exhausted currently visible packs after delivered pack ${lastConsumed ?? bucketState.sourcePackLastDeliveredNumber ?? 'initial'} but still has owned cases pending in the ${config.auditablePopulation}-case finalized population`,
      {
        footer,
        requiredAction: `Resume Bucket ${bucket} from the connected Google Drive source using the exact next pack filename and shard folder location in the SOURCE_PACK_CONTINUE prompt. Preserve all terminal registry rows and resume the existing reviewer chat.`,
      },
      { wakeCoordinator: !recoverableSourceBoundary, holdBucket: false },
    );
    const incidentRecord = incidentPath
      ? Object.values(state.incidents).find(entry => entry.path === incidentPath)
      : null;
    const incidentId = incidentRecord?.id
      || bucketState.sourcePackResumeIncidentId
      || bucketState.sourcePackLastDeliveredIncidentId
      || null;
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    const previousFilename = bucketState.sourcePackTargetFilename
      || sourcePackFilename(lastConsumed, Number(bucket));
    const cursorEvidenceSourceActionId = bucketState.sourcePackRequestActionId
      || bucketState.sourcePackLastDeliveredActionId
      || (isSourcePackContinuationEvidenceKind(responseAction?.kind) ? responseActionId : null);
    const advanced = advanceSourcePackAfterBoundary(Number(bucket), bucketState, {
      incidentId,
      incident,
      responseText: text,
    });
    if (advanced.ok) {
      recordSourcePackCursorEvidence(bucket, bucketState, {
        targetNumber: advanced.nextPack,
        evidenceKind: 'SOURCE_PACK_BOUNDARY',
        sourceActionId: cursorEvidenceSourceActionId,
        responseActionId,
        responseHash,
        consumedNumber: advanced.consumed,
        footer,
      });
      bucketState.advisoryAnomalyResumePending = false;
      bucketState.advisoryAnomalyInterruptedActionId = null;
      bucketState.lastAction = responseActionId
        ? `processed:${responseActionId}:source-pack-boundary:pack-${advanced.nextPack}`
        : `source-pack-boundary:${incidentId || 'unknown'}:pack-${advanced.nextPack}`;
      recordSourcePackTransition(state, bucket, {
        fromPack: previousFilename || sourcePackFilename(advanced.consumed, Number(bucket)),
        toPack: advanced.nextFilename,
      });
      recordActivityEvent(state, {
        bucket,
        kind: 'SOURCE_PACK_BOUNDARY',
        summary: `pack ${advanced.consumed} exhausted, 0 new cases → staged ${advanced.nextFilename}`,
      });
      log(`B${bucket}: advanced source-pack target from ${previousFilename || sourcePackFilename(advanced.consumed, Number(bucket))} to ${advanced.nextFilename}`);
    } else {
      bucketState.lastAction = responseActionId
        ? `processed:${responseActionId}:source-pack-boundary-unresolved:${advanced.reason}`
        : `source-pack-boundary-unresolved:${advanced.reason}`;
      log(`B${bucket}: source-pack boundary reconciled but next pack could not be derived (${advanced.reason})`);
    }
    saveState();
    return;
  }

  const recoverablePackNumber = recoverablePackNumberFromFooter(footer);
  if (Number.isInteger(recoverablePackNumber) && isValidSourcePackNumber(Number(bucket), recoverablePackNumber)) {
    const shard = configuredSourcePackShard(bucket);
    if (!shard) {
      saveState();
      recordIncident('SOURCE_PACK_SHARD_CONFIG_MISSING', bucket, `no source-pack shard configuration exists for Bucket ${bucket}`, { footer });
      return;
    }
    const filename = sourcePackFilename(recoverablePackNumber, Number(bucket));
    bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
    bucketState.sourcePackResumePending = true;
    bucketState.sourcePackResumeIncidentId = `pack-retry:${responseHash}`;
    bucketState.sourcePackTargetNumber = recoverablePackNumber;
    bucketState.sourcePackTargetFilename = filename;
    resetSourcePackAccessState(bucketState);
    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.lastAction = `source-pack-retry-staged:${filename}`;
    saveState();
    log(`B${bucket}: exact source pack retry staged for connected Drive continuation (${filename})`);
    return;
  }

  if (isRecoverableUnavailableSourcePackFooter(footer)) {
    sanitizeStoredSourcePackCursorFields(Number(bucket), bucketState);
    const incidentRecord = bucketState.sourcePackResumeIncidentId
      ? Object.values(state.incidents).find(entry => entry.id === bucketState.sourcePackResumeIncidentId)
      : null;
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    const resolved = resolveNextSourcePackTargetNumber(Number(bucket), {
      bucketState,
      incident,
      incidentId: bucketState.sourcePackResumeIncidentId,
      responseText: isInvalidZeroSourcePackFilename(bucketState.sourcePackTargetFilename)
        ? bucketState.sourcePackBoundaryResponsePreview
        : text,
    });
    if (isValidSourcePackNumber(Number(bucket), resolved.targetNumber)) {
      stageUnavailableSourcePackBackoff(
        bucket,
        bucketState,
        resolved.targetNumber,
        bucketState.sourcePackResumeIncidentId,
      );
      saveState();
      log(`B${bucket}: unavailable source pack ${bucketState.sourcePackTargetFilename}; retry ${bucketState.sourcePackUnavailableCount} deferred until ${bucketState.sourcePackRetryNotBefore}`);
      return;
    }
  }

  if (isRecoverableReadbackFooter(footer) || isRecoverableRegistryWriteFooter(footer)) {
    saveState();
    if (!allowDispatch) {
      bucketState.lastAction = `write-recovery-reconciled-without-dispatch-${footer.writesVerified.toLowerCase()}`;
      saveState();
      log(`B${bucket}: recoverable readback response reconciled without dispatch`);
      return;
    }
    await sendAction(page, bucket, 'WRITE_RECOVERY', partialWriteRecoveryPrompt(bucket, footer), responseHash);
    bucketState.lastAction = `write-recovery-${footer.writesVerified.toLowerCase()}`;
    saveState();
    log(`B${bucket}: recoverable readback state (${footer.writesVerified}; ${footer.blocker || 'NONE'}); reconciliation turn sent`);
    return;
  }


  if (isRecoverableAdvisoryCoordinatorFooter(footer)) {
    saveState();
    if (!allowDispatch) {
      bucketState.lastAction = 'advisory-anomaly-reconciled-without-dispatch';
      saveState();
      log(`B${bucket}: advisory anomaly response reconciled without dispatch`);
      return;
    }
    await sendAction(page, bucket, 'ISOLATED_ANOMALY_CONTINUE', isolatedAnomalyContinuationPrompt(bucket), responseHash);
    bucketState.advisoryAnomalyResumePending = false;
    bucketState.advisoryAnomalyInterruptedActionId = null;
    bucketState.lastAction = 'isolated-anomaly-continuation-sent';
    saveState();
    log(`B${bucket}: verified-write advisory coordinator request isolated; continuation sent without rewriting anomaly`);
    return;
  }

  if (shouldEscalateFooter(footer)) {
    saveState();
    recordIncident(
      'REVIEWER_ERROR_FOOTER',
      bucket,
      `STATUS=${footer.status}; WRITES_VERIFIED=${footer.writesVerified}; BLOCKER=${footer.blocker}; TRIGGER_COORDINATOR=${footer.triggerCoordinator}`,
      { footer },
    );
    return;
  }

  saveState();
  if (bucketState.advisoryAnomalyResumePending) {
    if (!allowDispatch) {
      bucketState.lastAction = 'normal-response-reconciled-advisory-anomaly-pending';
      saveState();
      log(`B${bucket}: NORMAL footer reconciled; interrupted advisory anomaly continuation remains pending`);
      return;
    }
    const interruptedActionId = bucketState.advisoryAnomalyInterruptedActionId;
    await sendAction(
      page,
      bucket,
      'ISOLATED_ANOMALY_CONTINUE',
      interruptedActionId
        ? `The prior ISOLATED_ANOMALY_CONTINUE action ${interruptedActionId} was interrupted by a reviewer-chat rollover before its attributable response was reconciled. Reconcile the authoritative registry first and preserve every valid terminal row. ${isolatedAnomalyContinuationPrompt(bucket)}`
        : isolatedAnomalyContinuationPrompt(bucket),
      responseHash,
    );
    bucketState.advisoryAnomalyResumePending = false;
    bucketState.advisoryAnomalyInterruptedActionId = null;
    bucketState.lastAction = 'isolated-anomaly-continuation-after-legacy-rollover';
    saveState();
    log(`B${bucket}: resumed interrupted advisory anomaly continuation before ordinary CONTINUE`);
    return;
  }
  if (!allowDispatch) {
    bucketState.lastAction = 'normal-response-reconciled-without-dispatch';
    saveState();
    log(`B${bucket}: NORMAL footer reconciled without dispatch`);
    return;
  }
  await sendAction(page, bucket, 'CONTINUE', continuationPrompt(bucket), responseHash);
  bucketState.lastAction = 'continuation-sent';
  saveState();
  log(`B${bucket}: NORMAL footer; continuation turn sent`);
}

async function recoverIdleActiveBucket(page, bucket, bucketState, text, responseHash) {
  if (!preDispatchReady || readControl().desiredState !== 'RUNNING') return false;
  if (bucketState.phase !== 'ACTIVE'
    || bucketState.awaitingResponseAt
    || bucketState.processedHash !== responseHash) return false;

  const footer = parseFooter(text);
  if (!footer
    || footer.status !== 'NORMAL'
    || footer.writesVerified !== 'YES'
    || (footer.blocker.trim().toUpperCase() !== 'NONE' && !isRecoverableTurnBoundaryFooter(footer))
    || footer.triggerCoordinator !== 'NO') return false;

  if (bucketState.advisoryAnomalyResumePending) {
    const interruptedActionId = bucketState.advisoryAnomalyInterruptedActionId;
    await sendAction(
      page,
      bucket,
      'ISOLATED_ANOMALY_CONTINUE',
      interruptedActionId
        ? `The prior ISOLATED_ANOMALY_CONTINUE action ${interruptedActionId} was interrupted by a reviewer-chat rollover before its attributable response was reconciled. Reconcile the authoritative registry first and preserve every valid terminal row. ${isolatedAnomalyContinuationPrompt(bucket)}`
        : isolatedAnomalyContinuationPrompt(bucket),
      responseHash,
    );
    bucketState.advisoryAnomalyResumePending = false;
    bucketState.advisoryAnomalyInterruptedActionId = null;
    bucketState.lastAction = 'idle-isolated-anomaly-continuation-recovered';
    saveState();
    log(`B${bucket}: resumed interrupted advisory anomaly continuation from idle reconciled state`);
    return true;
  }

  await sendAction(page, bucket, 'CONTINUE', continuationPrompt(bucket), responseHash);
  bucketState.lastAction = 'idle-continuation-recovered';
  saveState();
  log(`B${bucket}: recovered idle ACTIVE bucket by restoring/sending continuation`);
  return true;
}

async function processBucket(context, bucket) {
  const bucketState = state.buckets[String(bucket)];
  if (isSchedulingBlockedBucket(bucket)
    || bucketState.sourcePackCursorReconciliationRequired
    || !isVerifiedSourcePackCursor(bucket, bucketState)
    || bucketState.complete
    || bucketState.phase === 'PENDING'
    || bucketState.phase === 'HOLD'
    || bucketState.phase === 'PAUSED') return;
  if (readControl().desiredState !== 'RUNNING' || !preDispatchReady) return;

  try {
    const page = await ensurePage(context, bucketState);
    if (!page) return;
    if (isAuthenticationPage(page)) {
      bucketState.noAssistantCount = 0;
      bucketState.lastAction = 'waiting-for-browser-auth';
      saveState();
      return;
    }

    if (bucketState.phase === 'SETUP_WAIT'
      && bucketState.setupVerified
      && String(bucketState.setupVerifiedChatId || '') === String(bucketState.chatId || '')
      && !bucketState.awaitingActionId
      && !bucketState.awaitingResponseAt) {
      bucketState.lastAction = 'setup-verified-awaiting-slot';
      saveState();
      return;
    }

    // Explicit terminal/interrupted UI states override the stop-button signal.
    // ChatGPT can leave the stop button visible while showing "Connection
    // interrupted. Waiting for the complete answer", which otherwise looks
    // like healthy generation forever and prevents conservative rollover.
    const explicitRolloverReason = await conversationRolloverReason(page);
    if (explicitRolloverReason) {
      await rolloverReviewer(context, bucket, explicitRolloverReason);
      return;
    }

    if (await isGenerating(page)) {
      bucketState.transientFailures = 0;
      noteGenerationObserved(bucketState);
      bucketState.lastAction = bucketState.awaitingActionId
        ? `generating:${bucketState.awaitingActionId}`
        : 'generating';
      saveState();
      return;
    }

    const responseActionId = bucketState.awaitingActionId;
    const attributed = responseActionId
      ? await latestAssistantAfterActionMarker(page, responseActionId)
      : null;
    const text = responseActionId ? attributed?.text || '' : await latestMessage(page, 'assistant');
    if (!text) {
      const setupAckTimeoutMinutes = Number(config.setupAckTimeoutMinutes || 5);
      if (setupAckTimedOut(bucketState, setupAckTimeoutMinutes)) {
        recordIncident(
          'SETUP_ACK_TIMEOUT',
          bucket,
          `setup ACK was not received within ${setupAckTimeoutMinutes} minutes after action ${bucketState.awaitingActionId || 'unknown'}`,
        );
        return;
      }
      const stall = turnStallReason(bucketState);
      if (stall) {
        recordIncident('REVIEWER_STALL', bucket, stall);
        return;
      }
      if (bucketState.phase === 'SETUP_WAIT' || bucketState.awaitingResponseAt) {
        bucketState.noAssistantCount = 0;
        saveState();
        return;
      }
      bucketState.noAssistantCount = Number(bucketState.noAssistantCount || 0) + 1;
      if (bucketState.noAssistantCount >= 5) {
        recordIncident(
          'NO_ASSISTANT_RESPONSE',
          bucket,
          'five consecutive polling cycles found no visible assistant response; authentication or page state may require repair',
        );
      }
      return;
    }

    bucketState.noAssistantCount = 0;
    bucketState.transientFailures = 0;
    if (bucketState.phase === 'SETUP_WAIT' && !isExactSetupAck(text)) {
      const setupAckTimeoutMinutes = Number(config.setupAckTimeoutMinutes || 5);
      if (setupAckTimedOut(bucketState, setupAckTimeoutMinutes)) {
        recordIncident(
          'SETUP_ACK_TIMEOUT',
          bucket,
          `setup ACK was not received within ${setupAckTimeoutMinutes} minutes after action ${bucketState.awaitingActionId || 'unknown'}`,
        );
        return;
      }
    }
    const responseHash = sha16(text);
    if (responseActionId && !attributed?.attributed) {
      const stall = turnStallReason(bucketState);
      if (stall) {
        recordIncident('REVIEWER_STALL', bucket, stall);
        return;
      }
      return;
    }
    const responseKey = actionResponseKey(responseActionId, responseHash);
    if (responseKey && bucketState.processedResponseKey === responseKey) {
      clearAwaiting(bucketState, responseActionId);
      saveState();
      return;
    }
    if (responseActionId && !updateStableCandidate(bucketState, responseHash, responseActionId)) {
      saveState();
      return;
    }
    if (updateReceivedMessage(bucketState, text, responseHash)) saveState();

    if (await recoverIdleActiveBucket(page, bucket, bucketState, text, responseHash)) return;

    if (bucketState.phase === 'SETUP_WAIT' && responseActionId) {
      await processSetupWait(page, bucket, bucketState, text, responseHash);
    } else if (bucketState.phase === 'ACTIVE' && responseActionId) {
      await processActive(page, bucket, bucketState, text, responseHash, {
        allowDispatch: preDispatchReady
          && readControl().desiredState === 'RUNNING'
          && sourcePackShardMappingStatus().ready,
      });
    }
  } catch (error) {
    if (['CONTROL_PAUSED', 'CONTROL_STOPPED', 'CONTROL_RECONCILIATION_ONLY'].includes(error.code)) {
      bucketState.lastAction = error.code === 'CONTROL_PAUSED'
        ? 'paused-before-send'
        : error.code === 'CONTROL_STOPPED'
          ? 'stopped-before-send'
          : 'reconciliation-only-before-send';
      saveState();
      return;
    }
    if (error.code === 'CHAT_ROLLOVER_REQUIRED') {
      await rolloverReviewer(context, bucket, error.message);
      return;
    }
    if (error.code === 'PAGE_PROBE_STALLED') {
      await recoverStalledReviewerGeneration(
        context,
        bucket,
        bucketState,
        `reviewer page failed ${error.timeoutCount || PAGE_PROBE_STALL_THRESHOLD} consecutive live-generation probes`,
        'runtime',
      );
      return;
    }
    bucketState.transientFailures = Number(bucketState.transientFailures || 0) + 1;
    bucketState.lastAction = `transient-error:${error.message}`;
    saveState();
    log(`B${bucket}: transient error ${bucketState.transientFailures}: ${error.stack || error}`);

    if (error.code === 'FOREIGN_DRAFT' || bucketState.transientFailures >= 3) {
      recordIncident(
        error.code === 'FOREIGN_DRAFT' ? 'FOREIGN_DRAFT' : 'REPEATED_BROWSER_ERROR',
        bucket,
        error.message,
        { stack: error.stack || null },
      );
    }
  }
}

function rebalanceExistingReviewerSlots() {
  const entries = Object.entries(state.buckets)
    .sort((a, b) => Number(a[0]) - Number(b[0]));

  let changed = false;
  for (const [bucket, bucketState] of entries) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (!bucketReclaimableIdleSlot(bucketState)) continue;
    bucketState.phase = 'PAUSED';
    bucketState.lastAction = 'paused-awaiting-source-pack-continuation';
    changed = true;
    log(`B${bucket}: paused idle source-pack waiter to free a reviewer slot`);
  }
  if (changed) saveState();
}

function applyResolvedSourcePackTarget(bucket, bucketState, resolved, incidentId) {
  const targetNumber = resolved?.targetNumber;
  const filename = sourcePackFilename(targetNumber, Number(bucket));
  if (!filename) return false;
  bucketState.sourcePackTargetNumber = targetNumber;
  bucketState.sourcePackTargetFilename = filename;
  bucketState.sourcePackResumeIncidentId = incidentId;
  if (Number.isInteger(resolved?.lastConsumed)) {
    bucketState.sourcePackLastConsumedNumber = resolved.lastConsumed;
  }
  if (Number.isInteger(resolved?.lastVisible)) {
    bucketState.sourcePackLastVisibleNumber = resolved.lastVisible;
  }
  return true;
}

function isVerifiedSourcePackCursor(bucket, bucketState) {
  const targetNumber = parseSourcePackNumber(bucketState?.sourcePackTargetNumber, Number(bucket));
  const targetFilename = sourcePackFilename(targetNumber, Number(bucket));
  const proof = bucketState?.sourcePackCursorEvidence;
  const sourceAction = proof?.sourceActionId ? state.actions[proof.sourceActionId] : null;
  const responseAction = proof?.responseActionId ? state.actions[proof.responseActionId] : null;
  const actionProofValid = [
    proof?.evidenceKind === 'SOURCE_PACK_ACCESS' || proof?.evidenceKind === 'SOURCE_PACK_BOUNDARY',
    proof?.sourceActionId,
    proof?.responseActionId,
    proof?.sourceActionId === proof?.responseActionId,
    sourceAction?.status === 'SENT',
    sourceAction?.deliveryVerified === true,
    isSourcePackContinuationEvidenceKind(sourceAction?.kind),
    sourceAction?.sourcePackTargetFilename === proof?.sourceActionTargetFilename,
    proof?.responseKey === actionResponseKey(proof?.responseActionId, proof?.responseHash),
    responseAction?.status === 'SENT',
    responseAction?.deliveryVerified === true,
    /^[a-f0-9]{16}$/i.test(String(proof?.responseHash || '')),
    Number.isFinite(Date.parse(proof?.verifiedAt || '')),
  ].every(Boolean);
  // A conservative reconciliation proof is deliberately separate from an
  // action/response proof.  It is accepted only after startup validates the
  // committed machine-readable record and projects these safety assertions
  // into durable state.  It never asserts corpus completion or write history.
  const conservativeProofValid = [
    proof?.evidenceKind === 'CONSERVATIVE_RECONCILIATION',
    String(proof?.reconciliationId || '').trim(),
    proof?.reconciliationStatus === 'CONSERVATIVE_RESUME',
    Number(proof?.bucket) === Number(bucket),
    Number(proof?.targetNumber) === targetNumber,
    proof?.targetFilename === targetFilename,
    Number(proof?.consumedNumber) === targetNumber - 1,
    Number(proof?.terminalThroughPack) === targetNumber - 1,
    proof?.registryTerminalSetAuthoritative === true,
    proof?.skipTerminalStableIds === true,
    proof?.overwriteTerminalRows === false,
    proof?.readbackVerifyNewWrites === true,
    proof?.fullCorpusReconciled === false,
    proof?.actionAwareCursorProven === false,
    proof?.boundaryMonotonic === true,
    proof?.registryTerminalRowsChanged === 0,
    proof?.registrySubstantiveFieldsChanged === 0,
    Number.isFinite(Date.parse(proof?.verifiedAt || '')),
  ].every(Boolean);
  return Boolean(
    targetNumber !== null
    && targetFilename
    && proof
    && Number(proof.bucket) === Number(bucket)
    && Number(proof.targetNumber) === targetNumber
    && proof.targetFilename === targetFilename
    && (actionProofValid || conservativeProofValid),
  );
}

function recordSourcePackCursorEvidence(bucket, bucketState, {
  targetNumber,
  evidenceKind,
  sourceActionId,
  responseActionId,
  responseHash,
  consumedNumber = null,
  footer = null,
} = {}) {
  const bucketNumber = Number(bucket);
  const target = parseSourcePackNumber(targetNumber, bucketNumber);
  const filename = sourcePackFilename(target, bucketNumber);
  const sourceAction = sourceActionId ? state.actions[sourceActionId] : null;
  const responseAction = responseActionId ? state.actions[responseActionId] : null;
  const responseKey = actionResponseKey(responseActionId, responseHash);
  const expectedActionPack = evidenceKind === 'SOURCE_PACK_ACCESS'
    ? target
    : parseSourcePackNumber(consumedNumber, bucketNumber);
  if (!filename
    || !['SOURCE_PACK_ACCESS', 'SOURCE_PACK_BOUNDARY'].includes(evidenceKind)
    || !sourceAction?.id
    || sourceAction.status !== 'SENT'
    || sourceAction.deliveryVerified !== true
    || !isSourcePackContinuationEvidenceKind(sourceAction.kind)
    || !responseAction?.id
    || responseAction.status !== 'SENT'
    || responseAction.deliveryVerified !== true
    || responseAction.id !== sourceAction.id
    || !expectedActionPack
    || sourceAction.sourcePackTargetFilename !== sourcePackFilename(expectedActionPack, bucketNumber)
    || bucketState.processedResponseKey !== responseKey
    || (evidenceKind === 'SOURCE_PACK_ACCESS' && footer?.status !== 'NORMAL')
    || (evidenceKind === 'SOURCE_PACK_BOUNDARY'
      && !(footer?.status === 'NORMAL' && String(footer?.blocker || '').toUpperCase() === 'NEXT_SOURCE_PACKS_REQUIRED'))) return false;

  bucketState.sourcePackCursorEvidence = {
    bucket: bucketNumber,
    targetNumber: target,
    targetFilename: filename,
    evidenceKind,
    sourceActionId: sourceAction.id,
    sourceActionTargetFilename: sourceAction.sourcePackTargetFilename,
    responseActionId: responseAction.id,
    responseHash,
    responseKey,
    consumedNumber: parseSourcePackNumber(consumedNumber, bucketNumber),
    footerStatus: footer?.status || null,
    footerBlocker: footer?.blocker || null,
    verifiedAt: now(),
  };
  bucketState.sourcePackCursorReconciliationRequired = false;
  if (bucketState.hold?.type === 'INTEGRITY'
    && bucketState.hold.reason === 'SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED') {
    bucketState.hold = bucketState.sourcePackDeferredHold || null;
    bucketState.sourcePackDeferredHold = null;
    bucketState.phase = bucketState.hold ? 'HOLD' : (bucketState.chatUrl ? 'ACTIVE' : 'PENDING');
    bucketState.lastAction = `source-pack-cursor-evidence-verified:${responseAction.id}`;
  }
  return true;
}

function isSourcePackContinuationEvidenceKind(kind) {
  return ['SOURCE_PACK_CONTINUE', 'SOURCE_PACK_RETRY'].includes(String(kind || ''));
}

function stageUnavailableSourcePackBackoff(
  bucket,
  bucketState,
  targetNumber,
  incidentId,
  { incrementCount = true, preserveRetryNotBefore = null } = {},
) {
  const bucketNumber = Number(bucket);
  const target = parseSourcePackNumber(targetNumber, bucketNumber);
  const filename = sourcePackFilename(target, bucketNumber);
  if (target === null || !filename) return false;

  const unavailableAt = now();
  const priorCount = Math.max(0, Number(bucketState.sourcePackUnavailableCount || 0));
  const unavailableCount = incrementCount ? priorCount + 1 : Math.max(1, priorCount);
  const preservedRetryAt = Date.parse(preserveRetryNotBefore || '');
  const retryNotBefore = Number.isFinite(preservedRetryAt) && preservedRetryAt > Date.now()
    ? new Date(preservedRetryAt).toISOString()
    : new Date(Date.parse(unavailableAt) + sourcePackRetryDelayMs(unavailableCount)).toISOString();

  bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
  bucketState.sourcePackResumePending = true;
  bucketState.sourcePackResumeIncidentId = incidentId || bucketState.sourcePackResumeIncidentId || null;
  bucketState.sourcePackTargetNumber = target;
  bucketState.sourcePackTargetFilename = filename;
  resetSourcePackAccessState(bucketState);
  bucketState.sourcePackUnavailableCount = unavailableCount;
  bucketState.sourcePackLastUnavailableAt = unavailableAt;
  bucketState.sourcePackRetryNotBefore = retryNotBefore;
  bucketState.awaitingResponseAt = null;
  bucketState.awaitingActionId = null;
  bucketState.responseBaselineHash = null;
  bucketState.lastAction = `source-pack-unavailable-backoff:pack-${target}:until-${retryNotBefore}`;
  return true;
}

function recordSourcePackBoundaryEvidence(bucket, bucketState, text) {
  const bucketNumber = Number(bucket);
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  bucketState.sourcePackBoundaryResponsePreview = normalized.slice(0, 500);
  const targetNumber = parseSourcePackNumber(bucketState.sourcePackTargetNumber, bucketNumber);
  const targetFilename = sourcePackFilename(targetNumber, bucketNumber);
  const targetUnavailable = Boolean(
    targetFilename && responseIndicatesSourcePackUnavailable(normalized, targetFilename),
  );
  const lastVisible = extractLastVisibleSourcePackNumber(normalized, bucketNumber);
  if (lastVisible !== null) bucketState.sourcePackLastVisibleNumber = lastVisible;
  if (targetUnavailable) {
    if (lastVisible !== null && (targetNumber === null || lastVisible < targetNumber)) {
      bucketState.sourcePackLastConsumedNumber = lastVisible;
    }
    return;
  }
  const packNumbers = extractPackNumbersFromText(normalized, bucketNumber);
  if (packNumbers.length) {
    bucketState.sourcePackLastConsumedNumber = packNumbers[packNumbers.length - 1];
  }
}

function recoverFalseSourcePackBoundaryAdvances() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket) || bucketState.complete || !bucketState.sourcePackResumePending) continue;
    if (!isVerifiedSourcePackCursor(bucket, bucketState)) continue;
    const bucketNumber = Number(bucket);
    const currentTarget = parseSourcePackNumber(bucketState.sourcePackTargetNumber, bucketNumber);
    if (currentTarget === null) continue;
    const priorTarget = currentTarget - 1;
    const priorFilename = sourcePackFilename(priorTarget, bucketNumber);
    if (!priorFilename) continue;

    let incidentId = bucketState.sourcePackResumeIncidentId;
    let incidentRecord = incidentId
      ? Object.values(state.incidents).find(entry => entry.id === incidentId)
      : null;
    let incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    if ((!incident || incident.kind !== 'NEXT_SOURCE_PACKS_REQUIRED')
      && String(bucketState.lastProcessedBlocker || '').trim().toUpperCase() === 'NEXT_SOURCE_PACKS_REQUIRED') {
      const latestBoundary = latestSourcePackBoundaryIncident(bucketNumber);
      if (latestBoundary) {
        incidentId = latestBoundary.incident.id;
        incidentRecord = latestBoundary.record;
        incident = latestBoundary.incident;
      }
    }
    if (incident?.kind !== 'NEXT_SOURCE_PACKS_REQUIRED') continue;

    const boundaryText = String(bucketState.sourcePackBoundaryResponsePreview || '');
    if (!responseIndicatesSourcePackUnavailable(boundaryText, priorFilename)) continue;

    const visible = extractLastVisibleSourcePackNumber(boundaryText, bucketNumber);
    const priorConsumed = parseSourcePackNumber(bucketState.sourcePackLastConsumedNumber, bucketNumber);
    const priorVisible = parseSourcePackNumber(bucketState.sourcePackLastVisibleNumber, bucketNumber);
    const trustedConsumed = [visible, priorVisible, priorConsumed]
      .filter(value => Number.isInteger(value) && value < priorTarget)
      .sort((a, b) => b - a)[0] ?? null;

    const correctionPath = recordIncident(
      'SOURCE_PACK_BOUNDARY_CONTRADICTION',
      bucketNumber,
      `${priorFilename} was explicitly unavailable in the response that advanced the cursor to ${sourcePackFilename(currentTarget, bucketNumber)}; restoring the exact unavailable target`,
      { originalIncidentId: incidentId, preservedTarget: priorFilename },
      { wakeCoordinator: false, holdBucket: false },
    );
    const correctionRecord = correctionPath
      ? Object.values(state.incidents).find(entry => entry.path === correctionPath)
      : null;

    bucketState.sourcePackTargetNumber = priorTarget;
    bucketState.sourcePackTargetFilename = priorFilename;
    bucketState.sourcePackLastConsumedNumber = trustedConsumed;
    if (visible !== null && visible < priorTarget) bucketState.sourcePackLastVisibleNumber = visible;
    bucketState.sourcePackLastDeliveredNumber = null;
    bucketState.sourcePackLastDeliveredIncidentId = null;
    bucketState.sourcePackLastDeliveredAt = null;
    bucketState.sourcePackLastDeliveredActionId = null;
    stageUnavailableSourcePackBackoff(
      bucketNumber,
      bucketState,
      priorTarget,
      correctionRecord?.id || incidentId,
      {
        incrementCount: false,
        preserveRetryNotBefore: bucketState.sourcePackRetryNotBefore,
      },
    );
    bucketState.lastAction = `recovered-false-boundary-advance:pack-${priorTarget}:${incidentId}`;
    recovered = true;
    log(`B${bucket}: restored falsely advanced source-pack target to ${priorFilename}; trusted consumed frontier=${trustedConsumed ?? 'unknown'}`);
  }
  if (recovered) saveState();
  return recovered;
}

function recoverStaleSourcePackBoundaryState() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (bucketState.complete) continue;
    if (!isVerifiedSourcePackCursor(bucket, bucketState)) continue;
    if (bucketState.sourcePackResumePending) continue;
    if (bucketHasUnresolvedAwaitingAction(bucketState)) continue;

    const staleGenerating = String(bucketState.lastAction || '').startsWith('generating:');
    const actionScopedBoundary = Boolean(
      bucketState.lastProcessedActionId
      && bucketState.processedResponseKey
      && String(bucketState.processedResponseKey).startsWith(`${bucketState.lastProcessedActionId}:`)
      && String(bucketState.lastProcessedStatus || '').toUpperCase() === 'NORMAL'
      && String(bucketState.lastProcessedBlocker || '').trim().toUpperCase() === 'NEXT_SOURCE_PACKS_REQUIRED'
      && bucketState.sourcePackBoundaryResponsePreview,
    );
    if (!actionScopedBoundary) continue;

    const incidentId = bucketState.sourcePackResumeIncidentId
      || bucketState.sourcePackLastDeliveredIncidentId;
    const incidentRecord = incidentId
      ? Object.values(state.incidents).find(entry => entry.id === incidentId)
      : null;
    const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
    const responseText = bucketState.sourcePackBoundaryResponsePreview
      || bucketState.lastMessageReceivedPreview
      || null;
    const previousFilename = bucketState.sourcePackTargetFilename
      || sourcePackFilename(bucketState.sourcePackTargetNumber, Number(bucket));
    const advanced = advanceSourcePackAfterBoundary(Number(bucket), bucketState, {
      incidentId,
      incident,
      responseText,
    });
    if (!advanced.ok) {
      if (staleGenerating) {
        const actionFromLast = String(bucketState.lastAction).slice('generating:'.length);
        bucketState.lastAction = `processed:${actionFromLast}:source-pack-boundary-unresolved:${advanced.reason}`;
        recovered = true;
      }
      continue;
    }

    bucketState.lastAction = `recovered-source-pack-boundary:pack-${advanced.nextPack}`;
    recovered = true;
    recordSourcePackTransition(state, bucket, {
      fromPack: previousFilename,
      toPack: advanced.nextFilename,
    });
    recordActivityEvent(state, {
      bucket,
      kind: 'SOURCE_PACK_BOUNDARY',
      summary: `recovered stale boundary ${previousFilename || 'unknown'} → ${advanced.nextFilename}`,
    });
    log(`B${bucket}: advanced source-pack target from ${previousFilename} to ${advanced.nextFilename} during stale-boundary recovery`);
  }
  if (recovered) saveState();
}

async function recoverInvalidSourcePackCursors(context) {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket) || bucketState.complete) continue;
    const bucketNumber = Number(bucket);
    const hadInvalid = sanitizeStoredSourcePackCursorFields(bucketNumber, bucketState)
      || isInvalidZeroSourcePackFilename(bucketState.sourcePackTargetFilename)
      || bucketState.sourcePackTargetNumber === 0
      || bucketState.sourcePackLastDeliveredNumber === 0;
    const proofValid = isVerifiedSourcePackCursor(bucketNumber, bucketState);
    const cursorSnapshot = {
      targetNumber: bucketState.sourcePackTargetNumber ?? null,
      targetFilename: bucketState.sourcePackTargetFilename ?? null,
      lastConsumedNumber: bucketState.sourcePackLastConsumedNumber ?? null,
      lastVisibleNumber: bucketState.sourcePackLastVisibleNumber ?? null,
      lastDeliveredNumber: bucketState.sourcePackLastDeliveredNumber ?? null,
      lastDeliveredActionId: bucketState.sourcePackLastDeliveredActionId ?? null,
      awaitingActionId: bucketState.awaitingActionId || null,
      processedResponseKey: bucketState.processedResponseKey || null,
      evidence: bucketState.sourcePackCursorEvidence || null,
    };

    if (proofValid) {
      bucketState.sourcePackCursorReconciliationRequired = false;
      if (bucketState.hold?.type === 'INTEGRITY'
        && bucketState.hold.reason === 'SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED') {
        bucketState.hold = bucketState.sourcePackDeferredHold || null;
        bucketState.sourcePackDeferredHold = null;
        bucketState.phase = bucketState.hold ? 'HOLD' : (bucketState.chatUrl ? 'ACTIVE' : 'PENDING');
        bucketState.lastAction = `source-pack-cursor-proof-accepted:${bucketState.sourcePackCursorEvidence.responseActionId}`;
        recovered = true;
      }
      continue;
    }

    bucketState.sourcePackCursorReconciliationRequired = true;
    bucketState.sourcePackResumePending = false;
    const currentHoldIsCursor = bucketState.hold?.type === 'INTEGRITY'
      && bucketState.hold.reason === 'SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED';
    if (currentHoldIsCursor) {
      bucketState.phase = 'HOLD';
      continue;
    }

    // Keep an existing external/user hold available for recovery after cursor evidence is resolved.
    if (bucketState.hold && !['INTEGRITY', 'USER', 'COMPLETE'].includes(bucketState.hold.type)) {
      bucketState.sourcePackDeferredHold = bucketState.hold;
    }
    if (bucketState.hold?.type === 'INTEGRITY' || bucketState.hold?.type === 'USER' || bucketState.hold?.type === 'COMPLETE') {
      bucketState.phase = 'HOLD';
      continue;
    }

    const pathValue = recordIncident(
      'SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED',
      bucketNumber,
      'source-pack target cannot be used until an action-attributed source-pack response proves the exact boundary',
      { cursorSnapshot, hadInvalid, contextAvailable: Boolean(context) },
      { holdType: 'INTEGRITY' },
    );
    const incident = pathValue ? Object.values(state.incidents).find(entry => entry.path === pathValue) : null;
    bucketState.sourcePackCursorIncidentId = incident?.id || bucketState.hold?.incidentId || null;
    bucketState.sourcePackResumePending = false;
    bucketState.phase = 'HOLD';
    log(`B${bucket}: source-pack cursor requires action-attributed reconciliation; dispatch remains blocked`);
    recovered = true;
  }
  if (recovered) saveState();
  return recovered;
}

function stageRecoverableSourcePackHold(bucket, bucketState, incidentId, incident, reasonPrefix) {
  sanitizeStoredSourcePackCursorFields(Number(bucket), bucketState);
  const resolved = resolveNextSourcePackTargetNumber(Number(bucket), {
    bucketState,
    incident,
    incidentId,
  });
  if (!isValidSourcePackNumber(Number(bucket), resolved.targetNumber)) {
    bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
    bucketState.lastAction = `${reasonPrefix}-source-pack-cursor-unresolved:${incidentId}:${resolved.reason}`;
    bucketState.sourcePackResumePending = false;
    return false;
  }

  bucketState.phase = bucketState.chatUrl ? 'PAUSED' : 'PENDING';
  bucketState.lastAction = `${reasonPrefix}-source-pack-recovery:${incidentId}:pack-${resolved.targetNumber}`;
  bucketState.processedHash = null;
  bucketState.candidateHash = null;
  bucketState.candidateCount = 0;
  bucketState.awaitingResponseAt = null;
  bucketState.awaitingActionId = null;
  bucketState.responseBaselineHash = null;
  bucketState.transientFailures = 0;
  bucketState.sourcePackResumePending = true;
  applyResolvedSourcePackTarget(Number(bucket), bucketState, resolved, incidentId);
  resetSourcePackAccessState(bucketState);
  return true;
}

function recoverRecoverableHoldForScheduling(bucket, bucketState) {
  if (bucketState.phase !== 'HOLD' || !String(bucketState.lastAction || '').startsWith('incident:')) return false;
  const incidentId = String(bucketState.lastAction).slice('incident:'.length);
  const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
  const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
  if (!isRecoverableSourcePackHoldIncident(incident, bucketState)) return false;
  if (!stageRecoverableSourcePackHold(bucket, bucketState, incidentId, incident, 'scheduler')) return false;
  log(`B${bucket}: staged recoverable source-pack hold for scheduling; incident preserved ${incidentId}`);
  return true;
}

function recoverRecoverableHoldsForScheduling() {
  let recovered = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)) continue;
    if (recoverRecoverableHoldForScheduling(bucket, bucketState)) recovered = true;
  }
  if (recovered) saveState();
}

async function recoverTransientRegistryHolds(context) {
  let changed = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (isSchedulingBlockedBucket(bucket)
      || bucketState.phase !== 'HOLD'
      || bucketState.hold?.type !== 'TRANSIENT_EXTERNAL'
      || bucketState.hold?.validation?.kind !== 'REGISTRY_SHARD_AVAILABLE'
      || bucketHasUnresolvedAwaitingAction(bucketState)
      || !isHoldRetryDue(bucketState.hold)) continue;

    if (!bucketState.chatUrl) {
      deferTransientHold(bucketState, 'reviewer conversation unavailable for registry revalidation');
      changed = true;
      continue;
    }

    let page;
    let health;
    try {
      page = await ensurePage(context, bucketState);
      health = await classifyReviewerHealth(page);
    } catch (error) {
      deferTransientHold(bucketState, `reviewer prerequisite probe failed: ${error.message || error}`);
      changed = true;
      continue;
    }

    if (health.state === 'AUTH_REQUIRED') {
      recordIncident(
        'REVIEWER_AUTH_REQUIRED',
        Number(bucket),
        'automatic registry revalidation requires the existing authenticated reviewer session',
        { health },
        { holdType: 'USER' },
      );
      changed = true;
      continue;
    }
    if (health.state !== 'HEALTHY' || health.actualGeneration) {
      deferTransientHold(bucketState, `registry revalidation deferred while reviewer is ${health.state}`);
      changed = true;
      continue;
    }

    try {
      const latestAssistant = await latestMessage(page, 'assistant');
      const responseHash = latestAssistant ? sha16(latestAssistant) : (bucketState.processedHash || bucketState.lastHash || '');
      const actionIdSent = await sendAction(
        page,
        Number(bucket),
        'PREREQUISITE_REVALIDATION',
        registryPrerequisiteRevalidationPrompt(Number(bucket)),
        responseHash,
      );
      bucketState.phase = 'ACTIVE';
      bucketState.hold = {
        ...bucketState.hold,
        revalidationActionId: actionIdSent,
        lastAttemptAt: now(),
      };
      bucketState.lastAction = `registry-prerequisite-revalidation-sent:${actionIdSent}`;
      saveState();
      recordActivityEvent(state, {
        bucket,
        kind: 'HOLD_REVALIDATION',
        summary: `registry prerequisite revalidation sent (${actionIdSent})`,
      });
      changed = true;
      log(`B${bucket}: transient registry hold revalidation sent (${actionIdSent})`);
    } catch (error) {
      if (bucketHasUnresolvedAwaitingAction(bucketState)) {
        bucketState.phase = 'ACTIVE';
        bucketState.hold.revalidationActionId = bucketState.awaitingActionId;
        bucketState.hold.lastAttemptAt = now();
      } else {
        deferTransientHold(bucketState, `registry revalidation dispatch failed: ${error.message || error}`);
      }
      changed = true;
    }
  }
  if (changed) saveState();
  return changed;
}

async function reconcileStaleGenerationReservations(context) {
  let changed = false;
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    const staleGeneratingLastAction = String(bucketState.lastAction || '').startsWith('generating');
    if (!bucketHasGenerationReservation(bucketState) && !staleGeneratingLastAction) continue;

    let isGen = false;
    if (bucketState.chatUrl) {
      try {
        const page = await ensurePage(context, bucketState);
        isGen = page ? await isGenerating(page) : false;
      } catch (error) {
        if (isSchedulingBlockedBucket(bucket)) {
          isGen = false;
          log(`B${bucket}: could not inspect blocked bucket generation state; treating as not generating (${error.message || error})`);
        }
      }
    }

    const stall = turnStallReason(bucketState);
    if (!shouldClearStaleGenerationReservation({ bucketState, isGenerating: isGen, stallReason: stall })) continue;

    bucketState.awaitingResponseAt = null;
    bucketState.awaitingActionId = null;
    bucketState.responseBaselineHash = null;
    bucketState.generationSeenSinceAction = false;
    bucketState.generationObservedAt = null;
    if (String(bucketState.lastAction || '').startsWith('generating')) {
      bucketState.lastAction = isSchedulingBlockedBucket(bucket)
        ? 'blocked-stale-generation-cleared'
        : 'stale-generation-cleared';
    }
    changed = true;
    log(`B${bucket}: cleared stale generation reservation`);
  }
  if (changed) saveState();
}

async function attemptActivateReviewerSlot(context, bucket, liveGeneratingByBucket) {
  if (isSchedulingBlockedBucket(bucket)) {
    return { activated: false, reason: 'scheduling-blocked' };
  }

  const bucketState = bucketStateFor(bucket);
  if (!bucketIsUnfinished(bucketState)) {
    return { activated: false, reason: 'missing-or-complete' };
  }
  if (bucketBlocksCandidateActivation(bucketState)) {
    return { activated: false, reason: 'awaiting-unresolved-action' };
  }
  if (bucketUsesLiveReviewerSlot(bucket, liveGeneratingByBucket)) {
    return { activated: false, reason: 'already-occupies-live-slot' };
  }

  if (bucketState.phase === 'HOLD') {
    return { activated: false, reason: 'hold-not-recoverable' };
  }

  if (bucketState.writeRecoveryResumePending && bucketState.chatUrl) {
    if (bucketState.phase === 'SETUP_WAIT'
      && (!bucketState.setupVerified
        || String(bucketState.setupVerifiedChatId || '') !== String(bucketState.chatId || ''))) {
      return { activated: false, reason: 'write-recovery-waiting-for-setup-ack' };
    }
    const recovery = recoverableWriteIncidentById(bucket, bucketState.writeRecoveryIncidentId)
      || latestRecoverableWriteIncident(bucket);
    if (!recovery) {
      return { activated: false, reason: 'write-recovery-incident-invalid' };
    }
    const page = await ensurePage(context, bucketState);
    if (!page || isAuthenticationPage(page)) {
      return { activated: false, reason: 'write-recovery-chat-unavailable' };
    }
    if (await isGenerating(page)) {
      return { activated: false, reason: 'write-recovery-chat-generating' };
    }
    const latestAssistant = await latestMessage(page, 'assistant');
    const responseHash = latestAssistant ? sha16(latestAssistant) : (bucketState.processedHash || bucketState.lastHash || '');
    const interruptedActionId = bucketState.writeRecoveryInterruptedActionId;
    await sendAction(
      page,
      Number(bucket),
      'WRITE_RECOVERY',
      interruptedActionId
        ? interruptedWriteRecoveryPrompt(Number(bucket), recovery.footer, interruptedActionId)
        : partialWriteRecoveryPrompt(Number(bucket), recovery.footer),
      responseHash,
    );
    bucketState.writeRecoveryResumePending = false;
    bucketState.writeRecoveryIncidentId = null;
    bucketState.writeRecoveryInterruptedActionId = null;
    bucketState.phase = 'ACTIVE';
    bucketState.lastAction = `write-recovery-dispatched-after-rollover:${recovery.record.id}`;
    saveState();
    return { activated: true, method: 'resume-interrupted-write-recovery' };
  }

  if (bucketState.advisoryAnomalyResumePending && bucketState.chatUrl) {
    if (bucketState.phase === 'SETUP_WAIT'
      && (!bucketState.setupVerified
        || String(bucketState.setupVerifiedChatId || '') !== String(bucketState.chatId || ''))) {
      return { activated: false, reason: 'advisory-anomaly-waiting-for-setup-ack' };
    }
    const page = await ensurePage(context, bucketState);
    if (!page || isAuthenticationPage(page)) {
      return { activated: false, reason: 'advisory-anomaly-chat-unavailable' };
    }
    if (await isGenerating(page)) {
      return { activated: false, reason: 'advisory-anomaly-chat-generating' };
    }
    const latestAssistant = await latestMessage(page, 'assistant');
    const responseHash = latestAssistant ? sha16(latestAssistant) : (bucketState.processedHash || bucketState.lastHash || '');
    const interruptedActionId = bucketState.advisoryAnomalyInterruptedActionId;
    await sendAction(
      page,
      Number(bucket),
      'ISOLATED_ANOMALY_CONTINUE',
      interruptedActionId
        ? `The prior ISOLATED_ANOMALY_CONTINUE action ${interruptedActionId} began generating but its browser/session connection was interrupted before an attributable assistant response completed. Reconcile the authoritative registry first and do not assume the interrupted attempt made no writes. ${isolatedAnomalyContinuationPrompt(Number(bucket))}`
        : isolatedAnomalyContinuationPrompt(Number(bucket)),
      responseHash,
    );
    bucketState.advisoryAnomalyResumePending = false;
    bucketState.advisoryAnomalyInterruptedActionId = null;
    bucketState.phase = 'ACTIVE';
    bucketState.lastAction = 'isolated-anomaly-continuation-dispatched-after-rollover';
    saveState();
    return { activated: true, method: 'resume-interrupted-advisory-anomaly' };
  }

  if (bucketState.phase === 'SETUP_WAIT'
    && bucketState.setupVerified
    && String(bucketState.setupVerifiedChatId || '') === String(bucketState.chatId || '')
    && !bucketState.awaitingActionId
    && !bucketState.awaitingResponseAt
    && bucketState.chatUrl) {
    if (bucketState.sourcePackResumePending) {
      return { activated: false, reason: 'setup-awaiting-source-pack-continuation' };
    }
    const page = await ensurePage(context, bucketState);
    if (!page || isAuthenticationPage(page)) {
      return { activated: false, reason: 'setup-chat-unavailable' };
    }
    if (await isGenerating(page)) {
      return { activated: false, reason: 'setup-chat-generating' };
    }
    await sendAction(page, Number(bucket), 'INITIAL_AUDIT', initialAuditPrompt(Number(bucket)), bucketState.processedHash || '');
    bucketState.phase = 'ACTIVE';
    bucketState.lastAction = 'initial-audit-sent-after-setup-recovery';
    saveState();
    return { activated: true, method: 'verified-setup-initial-audit' };
  }

  if (bucketState.phase === 'PAUSED' && bucketState.chatUrl) {
    if (bucketState.sourcePackResumePending) {
      return { activated: false, reason: 'awaiting-source-pack-continuation' };
    }
    const advisoryRecoveryPrefix = 'startup-advisory-anomaly-recovery:';
    if (String(bucketState.lastAction || '').startsWith(advisoryRecoveryPrefix)) {
      const incidentId = String(bucketState.lastAction).slice(advisoryRecoveryPrefix.length);
      const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
      const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
      const footer = incident?.footer;
      if (incident?.kind !== 'REVIEWER_ERROR_FOOTER'
        || !isRecoverableAdvisoryCoordinatorFooter(footer)) {
        return { activated: false, reason: 'advisory-recovery-incident-invalid' };
      }

      const page = await ensurePage(context, bucketState);
      if (!page || isAuthenticationPage(page)) {
        return { activated: false, reason: 'advisory-recovery-chat-unavailable' };
      }
      if (await isGenerating(page)) {
        return { activated: false, reason: 'advisory-recovery-chat-generating' };
      }

      const latestAssistant = await latestMessage(page, 'assistant');
      const responseHash = latestAssistant ? sha16(latestAssistant) : (bucketState.lastHash || '');
      await sendAction(
        page,
        Number(bucket),
        'ISOLATED_ANOMALY_CONTINUE',
        isolatedAnomalyContinuationPrompt(Number(bucket)),
        responseHash,
      );
      bucketState.phase = 'ACTIVE';
      bucketState.lastAction = 'isolated-anomaly-continuation-after-hold:' + incidentId;
      saveState();
      return { activated: true, method: 'recover-advisory-anomaly-hold' };
    }
    const partialWriteRecoveryPrefix = 'startup-partial-write-recovery:';
    if (String(bucketState.lastAction || '').startsWith(partialWriteRecoveryPrefix)) {
      const incidentId = String(bucketState.lastAction).slice(partialWriteRecoveryPrefix.length);
      const incidentRecord = Object.values(state.incidents).find(entry => entry.id === incidentId);
      const incident = incidentRecord?.path ? loadJson(incidentRecord.path, null) : null;
      const footer = incident?.footer;
      if (incident?.kind !== 'REVIEWER_ERROR_FOOTER'
        || !(isRecoverableReadbackFooter(footer) || isRecoverableRegistryWriteFooter(footer))) {
        return { activated: false, reason: 'write-recovery-incident-invalid' };
      }

      const page = await ensurePage(context, bucketState);
      if (!page || isAuthenticationPage(page)) {
        return { activated: false, reason: 'write-recovery-chat-unavailable' };
      }
      if (await isGenerating(page)) {
        return { activated: false, reason: 'write-recovery-chat-generating' };
      }

      const latestAssistant = await latestMessage(page, 'assistant');
      const responseHash = latestAssistant ? sha16(latestAssistant) : (bucketState.processedHash || bucketState.lastHash || '');
      await sendAction(
        page,
        Number(bucket),
        'WRITE_RECOVERY',
        partialWriteRecoveryPrompt(Number(bucket), footer),
        responseHash,
      );
      bucketState.phase = 'ACTIVE';
      bucketState.lastAction = `write-recovery-dispatched-after-hold:${incidentId}`;
      saveState();
      return { activated: true, method: 'recover-partial-write-hold' };
    }
    bucketState.phase = 'ACTIVE';
    bucketState.lastAction = 'resumed-from-reviewer-cap';
    saveState();
    return { activated: true, method: 'resume-paused' };
  }

  if (bucketNeedsReviewer(bucketState)) {
    try {
      await createReviewer(context, Number(bucket));
      const updated = bucketStateFor(bucket);
      if (updated?.chatUrl) return { activated: true, method: 'create-reviewer' };
      return { activated: false, reason: 'create-reviewer-no-chat' };
    } catch (error) {
      if (['CONTROL_PAUSED', 'CONTROL_STOPPED', 'CONTROL_RECONCILIATION_ONLY'].includes(error.code)) throw error;
      return { activated: false, reason: error.message || String(error) };
    }
  }

  return { activated: false, reason: 'not-eligible' };
}

async function fillReviewerSlots(context) {
  if (readControl().desiredState !== 'RUNNING' || !preDispatchReady) return;

  let liveGeneratingByBucket = await inspectLiveGeneratingByBucket(context);
  await reconcileOutstandingResponses(context, liveGeneratingByBucket);
  await recoverTransientRegistryHolds(context);
  liveGeneratingByBucket = await inspectLiveGeneratingByBucket(context);
  await reconcileStaleGenerationReservations(context);
  await recoverSetupAckHolds(context);
  await recoverLegacyPromotedSetupWaitStates(context);
  recoverRecoverableHoldsForScheduling();
  rebalanceExistingReviewerSlots();

  let occupancy = refreshLiveReviewerOccupancy(liveGeneratingByBucket);
  while (occupancy.availableSlots > 0) {
    const writeRecoveryCandidates = Object.entries(state.buckets)
      .filter(([bucket, bucketState]) => (
        !isSchedulingBlockedBucket(bucket)
        && !bucketState.sourcePackCursorReconciliationRequired
        && isVerifiedSourcePackCursor(bucket, bucketState)
        && !bucketState.complete
        && bucketState.phase !== 'HOLD'
        && bucketState.writeRecoveryResumePending
        && Boolean(bucketState.chatUrl)
        && !bucketBlocksCandidateActivation(bucketState)
        && (bucketState.phase !== 'SETUP_WAIT'
          || (bucketState.setupVerified
            && String(bucketState.setupVerifiedChatId || '') === String(bucketState.chatId || '')))
      ))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([bucket]) => bucket);
    const setupReadyCandidates = Object.entries(state.buckets)
      .filter(([bucket, bucketState]) => (
        !isSchedulingBlockedBucket(bucket)
        && !bucketState.sourcePackCursorReconciliationRequired
        && isVerifiedSourcePackCursor(bucket, bucketState)
        && bucketState.phase === 'SETUP_WAIT'
        && bucketState.setupVerified
        && String(bucketState.setupVerifiedChatId || '') === String(bucketState.chatId || '')
        && !bucketBlocksCandidateActivation(bucketState)
        && Boolean(bucketState.chatUrl)
      ))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([bucket]) => bucket);
    const regularCandidates = selectReviewerSlotCandidates(state.buckets, SCHEDULING_BLOCKED_BUCKETS);
    const candidates = [
      ...writeRecoveryCandidates,
      ...setupReadyCandidates.filter(bucket => !writeRecoveryCandidates.includes(bucket)),
      ...regularCandidates.filter(bucket => (
        !writeRecoveryCandidates.includes(bucket) && !setupReadyCandidates.includes(bucket)
        && !state.buckets[String(bucket)]?.sourcePackCursorReconciliationRequired
        && isVerifiedSourcePackCursor(bucket, state.buckets[String(bucket)])
      )),
    ];
    if (!candidates.length) break;

    let progressed = false;
    for (const bucket of candidates) {
      liveGeneratingByBucket = await inspectLiveGeneratingByBucket(context);
      occupancy = refreshLiveReviewerOccupancy(liveGeneratingByBucket);
      if (occupancy.availableSlots <= 0) break;
      if (bucketUsesLiveReviewerSlot(bucket, liveGeneratingByBucket)) continue;

      const result = await attemptActivateReviewerSlot(context, bucket, liveGeneratingByBucket);
      if (result.activated) {
        liveGeneratingByBucket = await inspectLiveGeneratingByBucket(context);
        occupancy = refreshLiveReviewerOccupancy(liveGeneratingByBucket);
        progressed = true;
        log(`B${bucket}: reviewer slot activation (${result.method})`);
        await sleep(500);
        break;
      }
      log(`B${bucket}: reviewer slot activation skipped (${result.reason})`);
    }
    if (!progressed) break;
  }
}

function allBucketsComplete() {
  return Object.values(state.buckets).every(bucket => bucket.complete);
}

function latestBucketEvent(field) {
  const entries = Object.entries(state.buckets)
    .map(([bucket, value]) => ({ bucket: Number(bucket), value, at: value[field] }))
    .filter(entry => entry.at && Number.isFinite(Date.parse(entry.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return entries[0] || null;
}

function statusMetrics() {
  const processed = Number(state.metrics.casesReported || 0);
  const population = Number(config.auditablePopulation || 0);
  const remaining = Math.max(0, population - processed);
  const elapsedWorkingMs = workingElapsedMs();
  const ratePerHour = elapsedWorkingMs > 0 ? processed / (elapsedWorkingMs / 3600000) : 0;
  const etaSeconds = remaining === 0 ? 0 : ratePerHour > 0 ? Math.ceil(remaining / ratePerHour * 3600) : null;
  const received = latestBucketEvent('lastMessageReceivedAt');
  const sent = latestBucketEvent('lastMessageSentAt');

  return {
    auditablePopulation: population,
    casesProcessed: processed,
    casesRemaining: remaining,
    casesProcessedExact: false,
    progressBasis: state.metrics.progressBasis,
    workingElapsedMs: elapsedWorkingMs,
    processingRatePerHour: Number(ratePerHour.toFixed(2)),
    etaSeconds,
    lastProgressAt: state.metrics.lastProgressAt || null,
    lastMessageReceived: received ? {
      bucket: received.bucket,
      at: received.at,
      preview: received.value.lastMessageReceivedPreview || null,
    } : null,
    lastMessageSent: sent ? {
      bucket: sent.bucket,
      at: sent.at,
      kind: sent.value.lastMessageSentKind || null,
      actionId: sent.value.lastMessageSentActionId || null,
    } : null,
  };
}

function writeStatus(extra = {}) {
  const control = readControl();
  const heartbeatAt = now();
  const metrics = statusMetrics();
  const sourceShardMapping = sourcePackShardMappingStatus();
  const operations = buildOperationsStatus({
    state,
    occupancy: lastLiveReviewerOccupancy,
    liveGeneratingByBucket: lastLiveGeneratingByBucket,
    excludedBuckets: SCHEDULING_BLOCKED_BUCKETS,
    maxActive: MAX_ACTIVE_REVIEWERS,
    bucketCount: config.bucketCount,
    auditablePopulation: config.auditablePopulation,
    graceMs: dispatchStartGraceMs(),
  });
  const schedulerExclusions = { ...(operations.bucketExclusions || {}) };
  for (const [bucket, value] of Object.entries(state.buckets)) {
    if (!value.complete && value.sourcePackCursorReconciliationRequired) {
      schedulerExclusions[bucket] = 'SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED';
    }
    if (!value.complete && preDispatchEvidence.bucketExclusions?.[bucket]) {
      schedulerExclusions[bucket] ||= preDispatchEvidence.bucketExclusions[bucket];
    }
  }
  if (!sourceShardMapping.ready) {
    for (let bucket = 0; bucket < 6; bucket += 1) {
      schedulerExclusions[String(bucket)] = `SOURCE_SHARD_CONFIG_MISSING: missing=${sourceShardMapping.missingBuckets.join(',') || 'none'}; placeholder=${sourceShardMapping.placeholderBuckets.join(',') || 'none'}`;
    }
  }
  const status = {
    updatedAt: heartbeatAt,
    controllerPid: process.pid,
    startedAt: controllerStartedAt,
    heartbeatAt,
    controllerState: controllerLifecycleState,
    stalePreviousRun: previousControllerStale(previousRuntimeStatus),
    previousRun: previousRuntimeStatus ? {
      controllerPid: previousRuntimeStatus.controllerPid || null,
      startedAt: previousRuntimeStatus.startedAt || null,
      heartbeatAt: previousRuntimeStatus.heartbeatAt || previousRuntimeStatus.updatedAt || null,
      stale: previousControllerStale(previousRuntimeStatus),
    } : null,
    build: {
      gitSha: loadedGitSha,
      sourceHash: loadedSourceHash,
      loadedSourceHash,
      diskSourceHash: sourceHashFromDisk(),
      startedAt: controllerStartedAt,
    },
    connected: true,
    configurationState: sourceShardMapping.ready ? 'READY' : 'CONFIG_MISSING',
    canonicalRegistry: {
      status: 'UNAVAILABLE',
      source: 'NO_FRESH_MACHINE_READABLE_CANONICAL_RECONCILIATION',
      reconciledAt: null,
      acceptedTerminalCount: null,
      remainingAuditableCases: null,
      duplicateTerminalRows: null,
      conflictingTerminalRows: null,
      ownershipMismatches: null,
    },
    acceptedTerminalCount: null,
    acceptedTerminalCountStatus: 'UNAVAILABLE',
    sourceShardMapping,
    preflightBlockers: sourceShardMapping.ready ? [] : ['SOURCE_SHARD_CONFIG_MISSING'],
    runState: control.desiredState === 'RUNNING' ? state.runState : control.desiredState,
    control,
    preDispatchReady,
    preDispatchMode: preDispatchReady ? 'DISPATCH_READY' : 'RECONCILIATION_ONLY',
    preDispatchBlockers: preDispatchEvidence.blockers,
    preDispatchEvidence,
    dispatchEnabled: Boolean(preDispatchReady && control.desiredState === 'RUNNING'),
    maxActiveReviewers: MAX_ACTIVE_REVIEWERS,
    maxReviewerTabs: MAX_REVIEWER_TABS,
    maxAutomationTabs: MAX_AUTOMATION_TABS,
    managedReviewerChatCount: managedReviewerChatCount(),
    reviewerModelPolicy: {
      model: REQUIRED_REVIEWER_MODEL,
      effort: REQUIRED_REVIEWER_EFFORT,
      verifiedBeforeEverySend: true,
      fallbackAllowed: false,
    },
    browserConnected: Boolean(browserRuntimeStatus.browserConnected),
    browserExecutable: browserRuntimeStatus.browserExecutable || null,
    browserPid: browserRuntimeStatus.browserPid || null,
    cdpEndpoint: browserRuntimeStatus.cdpEndpoint || null,
    browserTransport: browserRuntimeStatus.browserTransport || null,
    chatgptReady: Boolean(browserRuntimeStatus.chatgptReady),
    authenticationRequired: Boolean(browserRuntimeStatus.authenticationRequired),
    coordinatorHealth: browserRuntimeStatus.coordinatorHealth || null,
    coordinatorTabPresent: Boolean(browserRuntimeStatus.coordinatorTabPresent),
    reviewerTabCount: Number(browserRuntimeStatus.reviewerTabCount || 0),
    automationTabCount: Number(browserRuntimeStatus.automationTabCount || 0),
    reviewerSlots: browserRuntimeStatus.reviewerSlots || [],
    maxReviewerGenerations: operations.maxReviewerGenerations,
    liveReviewerGenerations: Number(browserRuntimeStatus.liveReviewerGenerations ?? operations.liveReviewerGenerations),
    productiveReviewerCount: operations.productiveReviewerCount,
    substantiveAuditGenerations: operations.substantiveAuditGenerations,
    schedulingBlockedBuckets: Array.from(SCHEDULING_BLOCKED_BUCKETS).sort((a, b) => a - b),
    activeReviewers: operations.liveReviewerGenerations,
    scheduledReviewers: lastLiveReviewerOccupancy.scheduledReviewers,
    liveGeneratingBuckets: operations.liveGeneratingBuckets,
    dispatchStartBuckets: lastLiveReviewerOccupancy.dispatchStartBuckets,
    awaitingResponseBuckets: lastLiveReviewerOccupancy.awaitingResponseBuckets,
    availableReviewerSlots: operations.availableReviewerSlots,
    desiredActiveReviewers: operations.desiredLiveReviewers,
    desiredLiveReviewers: operations.desiredLiveReviewers,
    schedulerUnderutilized: operations.schedulerUnderutilized,
    idleReviewerCapacity: operations.idleReviewerCapacity,
    idleCapacityReason: operations.idleCapacityReason,
    schedulerExclusions,
    progressingBuckets5m: operations.progressingBuckets5m,
    progressingBuckets15m: operations.progressingBuckets15m,
    progressingBuckets60m: operations.progressingBuckets60m,
    newCasesLast5m: operations.newCasesLast5m,
    newCasesLast15m: operations.newCasesLast15m,
    newCasesLast60m: operations.newCasesLast60m,
    verifiedWritesLast5m: operations.verifiedWritesLast5m,
    verifiedWritesLast15m: operations.verifiedWritesLast15m,
    verifiedWritesLast60m: operations.verifiedWritesLast60m,
    lastGlobalProgressAt: operations.lastGlobalProgressAt,
    minutesSinceLastGlobalProgress: operations.minutesSinceLastGlobalProgress,
    casesProcessedTotal: operations.casesProcessedTotal,
    casesRemainingEstimate: operations.casesRemainingEstimate,
    pendingBuckets: Object.entries(state.buckets)
      .filter(([bucket, value]) => !isSchedulingBlockedBucket(bucket) && !value.complete && !value.chatUrl && value.phase !== 'HOLD')
      .map(([bucket]) => Number(bucket)),
    heldBuckets: Object.entries(state.buckets)
      .filter(([, bucket]) => bucket.phase === 'HOLD')
      .map(([bucket]) => Number(bucket)),
    pausedBuckets: Object.entries(state.buckets)
      .filter(([, bucket]) => bucket.phase === 'PAUSED')
      .map(([bucket]) => Number(bucket)),
    buckets: Object.fromEntries(
      Object.entries(state.buckets).map(([bucket, value]) => {
        const ops = operations.buckets[bucket] || {};
        return [
          bucket,
          {
            schedulingBlocked: isSchedulingBlockedBucket(bucket),
            bucket: Number(bucket),
            complete: value.complete,
            phase: value.phase,
            holdType: value.hold?.type || null,
            holdReason: value.hold?.reason || null,
            holdSince: value.hold?.createdAt || null,
            recoverable: value.hold?.type === 'TRANSIENT_EXTERNAL',
            sourcePackCursorStatus: value.sourcePackCursorReconciliationRequired
              ? 'INTEGRITY_RECONCILIATION_REQUIRED'
              : 'PROVEN',
            sourcePackCursorReconciliationRequired: Boolean(value.sourcePackCursorReconciliationRequired),
            sourcePackCursorEvidence: value.sourcePackCursorEvidence || null,
            nextRecoveryAttemptAt: value.hold?.nextAttemptAt || null,
            eligibleForScheduling: sourceShardMapping.ready && (ops.eligibleForScheduling ?? false),
            schedulerExclusionReason: schedulerExclusions[bucket] || null,
            operationalState: ops.operationalState || null,
            workflowPhase: value.phase,
            reviewerModelVerification: value.reviewerModelVerification || null,
            newChatCreationStatus: value.newChatCreation?.status || null,
            liveGeneration: ops.liveGeneration ?? false,
            actualGenerationDetected: Boolean(lastLiveGeneratingByBucket[String(bucket)]),
            generationReserved: bucketHasGenerationReservation(value),
            reviewerSlot: value.reviewerSlotId || null,
            chatId: value.chatId,
            chatUrl: value.chatUrl,
            reviewerConversationId: value.chatId || null,
            lastSeen: value.lastSeen,
            lastAction: value.lastAction,
            currentActionId: ops.currentActionId || value.awaitingActionId || value.lastMessageSentActionId || null,
            currentActionType: value.awaitingActionId
              ? state.actions[value.awaitingActionId]?.kind || ops.currentActionType || value.lastMessageSentKind || null
              : ops.currentActionType || value.lastMessageSentKind || null,
            currentSourcePack: ops.currentSourcePack || null,
            lastConsumedSourcePack: ops.lastConsumedSourcePack || null,
            nextStagedSourcePack: ops.nextStagedSourcePack || null,
            currentPack: ops.currentSourcePack || null,
            lastConsumedPack: ops.lastConsumedSourcePack || null,
            targetPack: value.sourcePackTargetFilename || ops.nextStagedSourcePack || null,
            sourcePackResumePending: ops.sourcePackResumePending ?? Boolean(value.sourcePackResumePending),
            sourcePackAccessVerified: ops.sourcePackAccessVerified ?? Boolean(value.sourcePackAccessVerified),
            lastProgressAt: ops.lastProgressAt || value.lastProgressAt || null,
            lastRegistryWriteAt: value.lastRegistryWriteAt || null,
            lastRegistryWriteVerified: value.lastRegistryWriteVerified || null,
            minutesSinceLastProgress: ops.minutesSinceLastProgress ?? null,
            lastProgressNewCases: ops.lastProgressNewCases ?? value.lastProgressNewCases ?? null,
            recentCases15m: ops.recentCases15m ?? 0,
            recentCases60m: ops.recentCases60m ?? 0,
            awaitingResponse: ops.awaitingResponse ?? Boolean(value.awaitingActionId && value.awaitingResponseAt),
            exactBlocker: ops.exactBlocker || null,
            awaitingResponseAt: value.awaitingResponseAt,
            awaitingActionId: value.awaitingActionId,
            casesReported: Number(value.casesReported || 0),
            casesSinceChatStart: Number(value.casesSinceChatStart || 0),
            lastMessageReceivedAt: value.lastMessageReceivedAt,
            lastMessageReceivedPreview: value.lastMessageReceivedPreview,
            lastMessageSentAt: value.lastMessageSentAt,
            lastMessageSentKind: value.lastMessageSentKind,
            lastMessageSentActionId: value.lastMessageSentActionId,
            lastResponseLatencyMs: value.lastResponseLatencyMs,
            minutesSinceActionSent: ops.minutesSinceActionSent ?? null,
            minutesSinceGenerationObserved: ops.minutesSinceGenerationObserved ?? null,
            visibilityClass: ops.visibilityClass || 'normal',
          },
        ];
      }),
    ),
    metrics: {
      ...metrics,
      casesProcessedTotal: operations.casesProcessedTotal,
      newCasesLast5m: operations.newCasesLast5m,
      newCasesLast15m: operations.newCasesLast15m,
      newCasesLast60m: operations.newCasesLast60m,
      lastGlobalProgressAt: operations.lastGlobalProgressAt,
      minutesSinceLastGlobalProgress: operations.minutesSinceLastGlobalProgress,
    },
    operations,
    recentActivity: operations.recentActivity,
    coordinator: loadJson(COORDINATOR_STATUS_PATH, null),
    ...extra,
  };
  saveJsonAtomic(STATUS_PATH, status);
}

function isBrowserDisconnectedError(error) {
  if (['BROWSER_UNAVAILABLE', 'BROWSER_PAGE_CREATE_TIMEOUT', 'REVIEWER_PAGE_NAVIGATION_FAILED',
    'COORDINATOR_PAGE_NAVIGATION_FAILED', 'BROWSER_PROFILE_IN_USE'].includes(error?.code)) return true;
  const text = String(error?.stack || error?.message || error || '');
  return /browser|context|target page|CDP/i.test(text)
    && /closed|disconnect|timeout|target|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(text);
}

function isReviewerCapacitySafetyError(error) {
  return ['AUTOMATION_TAB_CAP_EXCEEDED', 'REVIEWER_GENERATION_CAP_EXCEEDED', 'REVIEWER_SLOTS_BUSY'].includes(error?.code);
}

function browserRetryDelayMs(attempt) {
  const base = Number(config.browserRetryBaseMs || 15000);
  const max = Number(config.browserRetryMaxMs || 300000);
  const safeBase = Number.isFinite(base) && base > 0 ? Math.min(base, 60000) : 15000;
  const safeMax = Number.isFinite(max) && max >= safeBase ? Math.min(max, 900000) : 300000;
  return Math.min(safeMax, safeBase * (2 ** Math.min(Math.max(0, attempt - 1), 8)));
}

function evaluatePreDispatchReadiness({ sourceShardMapping, liveGeneratingByBucket }) {
  const blockers = [];
  const bucketExclusions = {};
  const eligibleBuckets = [];
  const liveWorkBuckets = [];
  const allComplete = allBucketsComplete();

  if (!browserRuntimeStatus.browserConnected || !browserRuntimeStatus.chatgptReady) {
    blockers.push(browserRuntimeStatus.authenticationRequired ? 'BROWSER_AUTH_REQUIRED' : 'BROWSER_NOT_READY');
  }
  if (!sourceShardMapping?.ready) blockers.push('SOURCE_SHARD_CONFIG_MISSING');
  if (!startupReconciliationComplete) blockers.push('STARTUP_RECONCILIATION_PENDING');

  const scheduled = new Set(selectReviewerSlotCandidates(state.buckets, SCHEDULING_BLOCKED_BUCKETS).map(String));
  for (const [bucket, bucketState] of Object.entries(state.buckets)) {
    if (bucketState.complete) continue;
    let reason = null;
    if (isSchedulingBlockedBucket(bucket)) reason = 'SCHEDULING_BLOCKED';
    else if (!isVerifiedSourcePackCursor(bucket, bucketState)) reason = 'SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED';
    else if (bucketState.phase === 'HOLD' || bucketState.hold) {
      reason = `${bucketState.hold?.type || 'HOLD'}:${bucketState.hold?.reason || 'BUCKET_HELD'}`;
    } else if (bucketHasUnresolvedAwaitingAction(bucketState) && !liveGeneratingByBucket?.[bucket]) {
      reason = 'UNRESOLVED_ACTION_WITHOUT_LIVE_GENERATION';
    }

    if (!reason && (scheduled.has(bucket)
      || (bucketState.phase === 'SETUP_WAIT' && bucketState.setupVerified
        && String(bucketState.setupVerifiedChatId || '') === String(bucketState.chatId || '')))) {
      eligibleBuckets.push(Number(bucket));
      continue;
    }
    if (!reason && Boolean(liveGeneratingByBucket?.[bucket])) {
      liveWorkBuckets.push(Number(bucket));
      continue;
    }
    if (!reason) reason = bucketState.phase === 'ACTIVE'
      ? 'ACTIVE_REVIEWER_REQUIRES_RECONCILIATION'
      : `NOT_SCHEDULER_ELIGIBLE:${bucketState.phase || 'UNKNOWN'}`;
    bucketExclusions[bucket] = reason;
  }

  if (!eligibleBuckets.length && !liveWorkBuckets.length && !allComplete) {
    blockers.push('NO_EVIDENCE_BACKED_ELIGIBLE_BUCKET');
  }

  const ready = blockers.length === 0;
  return {
    ready,
    checkedAt: now(),
    blockers,
    eligibleBuckets,
    liveWorkBuckets,
    bucketExclusions,
    sourceShardMappingReady: Boolean(sourceShardMapping?.ready),
    browserReady: Boolean(browserRuntimeStatus.browserConnected && browserRuntimeStatus.chatgptReady),
    startupReconciliationComplete,
    allBucketsComplete: allComplete,
  };
}

function updatePreDispatchReadiness(sourceShardMapping, liveGeneratingByBucket) {
  preDispatchEvidence = evaluatePreDispatchReadiness({ sourceShardMapping, liveGeneratingByBucket });
  preDispatchReady = preDispatchEvidence.ready;
  return preDispatchEvidence;
}

function promoteRecoveredStartupControl(control) {
  if (!preDispatchReady || control.desiredState !== 'RECONCILIATION_ONLY') return false;
  const isControllerRecoveryRecord = control.requestedBy === 'controller-startup-recovery';
  if (control.present && !isControllerRecoveryRecord) return false;
  saveJsonAtomic(CONTROL_PATH, {
    desiredState: 'RUNNING',
    requestedAt: now(),
    requestedBy: 'controller-startup-recovery',
    preDispatchReadyAt: preDispatchEvidence.checkedAt,
    preDispatchEligibleBuckets: preDispatchEvidence.eligibleBuckets,
  });
  log('startup reconciliation gate passed; promoted controller startup recovery to RUNNING');
  return true;
}

async function main() {
  if (startupStateError) {
    controllerLifecycleState = 'ERROR';
    writeStatus({
      connected: false,
      controllerState: 'ERROR',
      fatal: startupStateError.message || String(startupStateError),
      durableStateError: startupStateError.code || 'DURABLE_STATE_INVALID',
    });
    throw startupStateError;
  }
  applyDurableConservativeReconciliation();
  recoverInvalidLegacyChatRehydration();
  recoverTimeoutHolds();
  recoverLegacyInterruptedWriteRecoveryRollovers();
  recoverLegacyInterruptedAdvisoryAnomalyRollovers();
  recoverUnavailableSourcePackHolds();
  preserveUnresolvedNewChatHolds();
  recoverRetryablePartialWriteHolds();
  recoverRetryableExactPackHolds();
  recoverAdvisoryCoordinatorHolds();
  recoverRetryableTurnBoundaryHolds();
  recoverSourcePackHolds();
  recoverFalseSourcePackBoundaryAdvances();
  recoverStaleSourcePackBoundaryState();
  resetSetupWaitObservationState();
  recoverLostAwaitingState();
  await recoverInvalidSourcePackCursors(null);
  saveState();
  log(`controller v6 starting; maxActiveReviewers=${MAX_ACTIVE_REVIEWERS}; auditablePopulation=${config.auditablePopulation}`);
  writeStatus({ connected: false, starting: true });
  let browser = null;
  let context = null;
  let browserRetryAttempt = 0;
  // Long Firefox navigation, page creation, and ChatGPT response probes can
  // take longer than the watchdog's stale-heartbeat threshold. Keep the
  // heartbeat fresh while those async browser operations are in flight so the
  // watchdog only restarts a controller whose event loop has actually stopped.
  const heartbeatTimer = setInterval(() => {
    try {
      const heartbeatAt = now();
      const control = readControl();
      const previousStatus = loadJson(STATUS_PATH, {});
      let browserConnected = false;
      try { browserConnected = Boolean(browser?.isConnected?.()); } catch {}
      saveJsonAtomic(STATUS_PATH, {
        ...previousStatus,
        updatedAt: heartbeatAt,
        heartbeatAt,
        controllerPid: process.pid,
        startedAt: controllerStartedAt,
        controllerState: controllerLifecycleState,
        runState: control.desiredState === 'RUNNING' ? state.runState : control.desiredState,
        control: {
          ...(previousStatus.control || {}),
          desiredState: control.desiredState,
          present: control.present,
          requestedAt: control.requestedAt,
          requestedBy: control.requestedBy,
        },
        browserConnected,
        chatgptReady: Boolean(browserConnected && browserRuntimeStatus.chatgptReady),
        authenticationRequired: Boolean(browserRuntimeStatus.authenticationRequired),
        preDispatchReady,
        preDispatchMode: preDispatchReady ? 'DISPATCH_READY' : 'RECONCILIATION_ONLY',
        dispatchEnabled: Boolean(preDispatchReady && control.desiredState === 'RUNNING'),
      });
    } catch {}
  }, 30_000);
  heartbeatTimer.unref();

  while (true) {
    const control = syncControlState();
    if (control.desiredState === 'STOPPED') {
      if (ownedBrowserProfile.profileMode === 'firefox' && ownedBrowserProfile.context) {
        try { await ownedBrowserProfile.context.close(); } catch (error) {
          log(`unable to close owned Firefox fallback context: ${error.message || error}`);
        }
      }
      cleanupOwnedBrowserProfileIfStopped();
      controllerLifecycleState = 'STOPPED';
      writeStatus({ connected: false, controllerState: 'STOPPED', stopped: true, allComplete: allBucketsComplete() });
      log('controller stopped by operator control');
      return;
    }

    try {
      if (!browser || !browser.isConnected() || !context) {
        const profile = browserLaunchProfile();
        const runtime = await connectOrLaunchBrowser({
          endpoint: config.cdpEndpoint || null,
          cdpPort: config.cdpPort,
          preferredExecutable: profile.preferredExecutable,
          profileDir: profile.profileDir,
          profileMode: profile.profileMode,
          profileDirectoryName: config.browserProfileName || 'Default',
          projectRoot: ROOT,
          connectTimeoutMs: config.browserConnectTimeoutMs || 5000,
          startupTimeoutMs: config.browserStartupTimeoutMs || 15000,
          retryIntervalMs: config.browserRetryIntervalMs || 500,
          candidateExecutables: config.browserCandidates || config.browserExecutables || [],
          firefoxFallbackEnabled: profile.firefoxFallbackEnabled,
          firefoxExecutable: profile.firefoxExecutable,
          firefoxCandidates: profile.firefoxCandidates,
          firefoxProfileDir: profile.firefoxProfileDir,
        });
        browser = runtime.browser;
        context = runtime.context;
        if (!context) throw new Error('Browser startup completed without a browser context');
        ownedBrowserProfile = {
          launched: Boolean(runtime.launched),
          pid: runtime.pid || null,
          profileDir: runtime.profileDir || null,
          profileDirectoryName: runtime.profileDirectoryName || config.browserProfileName || 'Default',
          profileMode: runtime.profileMode || profile.profileMode || 'source',
          context: runtime.context,
        };
        browserRetryAttempt = 0;
        browserRuntimeStatus.browserConnected = true;
        browserRuntimeStatus.browserExecutable = runtime.executable || config.browserExecutable || config.browserPath || null;
        browserRuntimeStatus.browserPid = runtime.pid || null;
        browserRuntimeStatus.browserTransport = runtime.transport || 'cdp';
        browserRuntimeStatus.cdpEndpoint = runtime.endpoint
          || (runtime.transport === 'persistent-firefox' ? null : config.cdpEndpoint || `http://127.0.0.1:${config.cdpPort}`);
      }

      await ensureBrowserSlots(context);
      if (!browserRuntimeStatus.chatgptReady) {
        preDispatchReady = false;
        startupReconciliationComplete = false;
        preDispatchEvidence = {
          ready: false,
          checkedAt: now(),
          blockers: [browserRuntimeStatus.authenticationRequired ? 'BROWSER_AUTH_REQUIRED' : 'BROWSER_NOT_READY'],
          eligibleBuckets: [],
          bucketExclusions: {},
        };
        controllerLifecycleState = 'DEGRADED';
        const browserState = browserRuntimeStatus.authenticationRequired ? 'AUTH_REQUIRED' : 'CHATGPT_NOT_READY';
        writeStatus({
          connected: true,
          controllerState: 'DEGRADED',
          browserState,
          browserConnected: Boolean(browser?.isConnected?.()),
          dispatchEnabled: false,
          browserError: browserRuntimeStatus.coordinatorHealth?.reason || 'ChatGPT project page is not ready',
        });
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }

      const shardMapping = sourcePackShardMappingStatus();
      if (!shardMapping.ready) {
        preDispatchReady = false;
        startupReconciliationComplete = false;
        await recoverInvalidSourcePackCursors(context);
        const liveGeneratingByBucket = await inspectLiveGeneratingByBucket(context);
        await reconcileOutstandingResponses(context, liveGeneratingByBucket);
        const reconciledLive = await inspectLiveGeneratingByBucket(context);
        refreshLiveReviewerOccupancy(reconciledLive);
        updatePreDispatchReadiness(shardMapping, reconciledLive);
        controllerLifecycleState = 'DEGRADED';
        writeStatus({
          connected: true,
          controllerState: 'DEGRADED',
          browserState: 'CONFIG_MISSING',
          configurationState: 'CONFIG_MISSING',
          preflightBlockers: ['SOURCE_SHARD_CONFIG_MISSING'],
          sourceShardMapping: shardMapping,
          dispatchEnabled: false,
          preDispatchReady: false,
          preDispatchBlockers: preDispatchEvidence.blockers,
        });
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }

      await recoverInvalidSourcePackCursors(context);
      await recoverReviewerStallHolds(context);
      recoverLostAwaitingState();
      recoverSourcePackHolds();
      recoverFalseSourcePackBoundaryAdvances();
      recoverRecoverableHoldsForScheduling();
      await recoverStaleAwaitingReviewers(context);
      recoverStaleSourcePackBoundaryState();
      let liveGeneratingByBucket = await inspectLiveGeneratingByBucket(context);
      await reconcileOutstandingResponses(context, liveGeneratingByBucket);
      liveGeneratingByBucket = await inspectLiveGeneratingByBucket(context);
      refreshLiveReviewerOccupancy(liveGeneratingByBucket);
      await recoverInvalidSourcePackCursors(context);
      startupReconciliationComplete = true;
      updatePreDispatchReadiness(shardMapping, liveGeneratingByBucket);

      const recoveredControl = readControl();
      if (promoteRecoveredStartupControl(recoveredControl)) {
        controllerLifecycleState = 'RECOVERING';
        writeStatus({
          connected: true,
          controllerState: 'RECOVERING',
          dispatchEnabled: false,
          preDispatchReady: true,
          startupControlPromoted: true,
        });
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }
      if (!preDispatchReady || recoveredControl.desiredState !== 'RUNNING') {
        controllerLifecycleState = recoveredControl.desiredState === 'PAUSED' ? 'PAUSED' : 'RECOVERING';
        writeStatus({
          connected: true,
          controllerState: controllerLifecycleState,
          paused: recoveredControl.desiredState === 'PAUSED',
          allComplete: allBucketsComplete(),
          dispatchEnabled: false,
          preDispatchReady,
          preDispatchBlockers: preDispatchEvidence.blockers,
        });
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }

      ensureCoordinatorWakeProgress();
      await sendPendingSourcePackContinuations(context);
      await fillReviewerSlots(context);
      controllerLifecycleState = 'RUNNING';

      for (let bucket = 0; bucket < Number(config.bucketCount); bucket += 1) {
        await processBucket(context, bucket);
      }

      await sendPendingSourcePackContinuations(context);
      liveGeneratingByBucket = await inspectLiveGeneratingByBucket(context);
      refreshLiveReviewerOccupancy(liveGeneratingByBucket);
      await fillReviewerSlots(context);

      if (allBucketsComplete()) {
        if (!state.completedAt) {
          state.completedAt = now();
          saveState();
          log('ALL BUCKETS COMPLETE');
        }
        writeStatus({ allComplete: true });
      } else {
        writeStatus({ allComplete: false });
      }
    } catch (error) {
      if (['CONTROL_PAUSED', 'CONTROL_STOPPED', 'CONTROL_RECONCILIATION_ONLY'].includes(error?.code)) {
        const desiredState = readControl().desiredState;
        const readinessWithdrawn = desiredState === 'RUNNING' && !preDispatchReady;
        controllerLifecycleState = desiredState === 'PAUSED'
          ? 'PAUSED'
          : desiredState === 'STOPPED'
            ? 'STOPPED'
            : 'RECOVERING';
        log(`dispatch gate changed during browser cycle; no further action will be submitted; desiredState=${desiredState}; readinessWithdrawn=${readinessWithdrawn}`);
        writeStatus({
          connected: Boolean(browser?.isConnected?.()),
          controllerState: controllerLifecycleState,
          browserConnected: Boolean(browser?.isConnected?.()),
          dispatchEnabled: false,
          preDispatchReady,
          preDispatchBlockers: preDispatchEvidence.blockers,
        });
        if (desiredState === 'STOPPED') continue;
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }
      if (error?.code === 'REVIEWER_MODEL_UNAVAILABLE') {
        const verificationFailure = [
          error.message || String(error),
          error.cause?.message ? `cause: ${error.cause.message}` : null,
        ].filter(Boolean).join(' | ');
        controllerLifecycleState = 'DEGRADED';
        preDispatchReady = false;
        startupReconciliationComplete = false;
        preDispatchEvidence = {
          ready: false,
          checkedAt: now(),
          blockers: ['REVIEWER_MODEL_UNAVAILABLE'],
          eligibleBuckets: [],
          bucketExclusions: {},
        };
        log(`reviewer model verification failed; affected bucket remains held and action was not sent: ${verificationFailure}`);
        writeStatus({
          connected: Boolean(browser?.isConnected?.()),
          controllerState: 'DEGRADED',
          browserState: 'REVIEWER_MODEL_UNAVAILABLE',
          browserError: verificationFailure,
          browserConnected: Boolean(browser?.isConnected?.()),
          dispatchEnabled: false,
          preDispatchReady: false,
          preDispatchBlockers: preDispatchEvidence.blockers,
        });
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }
      if (error?.code === 'REVIEWER_COMPOSER_UNAVAILABLE') {
        const bucket = String(error.bucket ?? '');
        const bucketState = state.buckets[bucket];
        const preparedAction = error.actionId ? state.actions[error.actionId] : null;
        if (preparedAction?.status === 'PREPARED') {
          preparedAction.lastAttemptFailedAt = now();
          preparedAction.lastAttemptFailure = 'composer unavailable before draft entry; action remains unsent';
        }
        if (bucketState) bucketState.lastAction = 'waiting-for-chat-composer';
        saveState();
        controllerLifecycleState = 'DEGRADED';
        preDispatchReady = false;
        startupReconciliationComplete = false;
        preDispatchEvidence = {
          ready: false,
          checkedAt: now(),
          blockers: ['REVIEWER_COMPOSER_UNAVAILABLE'],
          eligibleBuckets: [],
          bucketExclusions: bucket ? { [bucket]: 'REVIEWER_COMPOSER_UNAVAILABLE' } : {},
        };
        const failure = [
          error.message || String(error),
          error.cause?.message ? `cause: ${error.cause.message}` : null,
        ].filter(Boolean).join(' | ');
        log(`B${bucket || '?'}: composer disappeared before draft entry; action remains unsent and controller will retry after readiness returns: ${failure}`);
        writeStatus({
          connected: Boolean(browser?.isConnected?.()),
          controllerState: 'DEGRADED',
          browserState: 'REVIEWER_COMPOSER_UNAVAILABLE',
          browserError: failure,
          browserConnected: Boolean(browser?.isConnected?.()),
          dispatchEnabled: false,
          preDispatchReady: false,
          preDispatchBlockers: preDispatchEvidence.blockers,
        });
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }
      if (error?.code === 'SEND_NOT_OBSERVED') {
        const bucket = String(error.bucket ?? '');
        const bucketState = state.buckets[bucket];
        const pendingAction = error.actionId ? state.actions[error.actionId] : null;
        const attemptCount = Math.max(0, Number(pendingAction?.sendAttemptCount || 0)) + 1;
        const failure = [
          error.message || String(error),
          error.cause?.message ? `interaction: ${error.cause.message}` : null,
        ].filter(Boolean).join(' | ');
        if (pendingAction) {
          pendingAction.sendAttemptCount = attemptCount;
          pendingAction.lastAttemptFailedAt = now();
          pendingAction.lastAttemptFailure = failure;
        }
        if (bucketState && error.deliveryState === 'DRAFT_REMAINS' && attemptCount < 3) {
          const delayMs = Math.min(30_000 * (2 ** (attemptCount - 1)), 120_000);
          const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
          if (pendingAction) pendingAction.nextRetryAt = nextRetryAt;
          bucketState.lastAction = `send-retry-deferred:${error.actionId}:${nextRetryAt}`;
          saveState();
          controllerLifecycleState = 'RUNNING';
          log(`B${bucket}: send was not observed, but the exact action remains in the composer; deferred idempotent retry ${attemptCount}/2 until ${nextRetryAt}: ${failure}`);
          writeStatus({
            connected: Boolean(browser?.isConnected?.()),
            controllerState: 'RUNNING',
            browserState: null,
            browserError: null,
            browserConnected: Boolean(browser?.isConnected?.()),
            dispatchEnabled: Boolean(preDispatchReady && readControl().desiredState === 'RUNNING'),
            preDispatchReady,
            preDispatchBlockers: preDispatchEvidence.blockers,
          });
        } else {
          if (pendingAction) pendingAction.nextRetryAt = null;
          if (bucketState) {
            recordIncident(
              'REVIEWER_SEND_UNCONFIRMED',
              Number(bucket),
              'a source-pack action could not be confirmed in the chat; automatic retries are held to prevent duplicate delivery',
              {
                actionId: error.actionId || null,
                deliveryState: error.deliveryState || 'AMBIGUOUS',
                attemptCount,
                interactionFailure: error.cause?.message || null,
              },
              {
                wakeCoordinator: false,
                holdType: 'USER',
                validation: { kind: 'REVIEWER_CHAT_REACHABLE', bucket: Number(bucket) },
              },
            );
          } else {
            saveState();
          }
          controllerLifecycleState = 'DEGRADED';
          log(`B${bucket || '?'}: source-pack delivery remains unconfirmed; bucket held for chat reconciliation: ${failure}`);
          writeStatus({
            connected: Boolean(browser?.isConnected?.()),
            controllerState: 'DEGRADED',
            browserState: 'SEND_NOT_OBSERVED',
            browserError: failure,
            browserConnected: Boolean(browser?.isConnected?.()),
            dispatchEnabled: Boolean(preDispatchReady && readControl().desiredState === 'RUNNING'),
            preDispatchReady,
            preDispatchBlockers: preDispatchEvidence.blockers,
          });
        }
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }
      if (error?.code === 'PAGE_PROBE_TIMEOUT') {
        const failure = error.message || String(error);
        controllerLifecycleState = 'DEGRADED';
        preDispatchReady = false;
        startupReconciliationComplete = false;
        preDispatchEvidence = {
          ready: false,
          checkedAt: now(),
          blockers: ['PAGE_PROBE_TIMEOUT'],
          eligibleBuckets: [],
          bucketExclusions: {},
        };
        log(`reviewer page probe timed out; controller remains alive in reconciliation mode: ${failure}`);
        writeStatus({
          connected: Boolean(browser?.isConnected?.()),
          controllerState: 'DEGRADED',
          browserState: 'PAGE_PROBE_TIMEOUT',
          browserError: failure,
          browserConnected: Boolean(browser?.isConnected?.()),
          dispatchEnabled: false,
          preDispatchReady: false,
          preDispatchBlockers: preDispatchEvidence.blockers,
        });
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }
      if (isReviewerCapacitySafetyError(error)) {
        controllerLifecycleState = 'DEGRADED';
        writeStatus({
          connected: true,
          controllerState: 'DEGRADED',
          browserState: error.code,
          browserError: error.message || String(error),
          browserConnected: Boolean(browser?.isConnected?.()),
        });
        await sleep(Math.max(1000, Number(config.pollSeconds || 12) * 1000));
        continue;
      }
      if (!isBrowserDisconnectedError(error)) throw error;
      browserRetryAttempt += 1;
      const unavailable = error?.code === 'BROWSER_UNAVAILABLE';
      const delayMs = browserRetryDelayMs(browserRetryAttempt);
      const recoveryState = unavailable ? 'DEGRADED' : 'RECOVERING';
      log(`${unavailable ? 'browser unavailable' : 'browser connection lost'}; bounded retry in ${delayMs}ms: ${error.message || error}`);
      if (!unavailable) {
        recordIncident(
          'BROWSER_DISCONNECTED',
          null,
          'browser or page connection closed; controller will retry',
          { lastError: error.message || String(error), stack: error.stack || null },
        );
      }
      writeStatus({
        connected: false,
        controllerState: recoveryState,
        browserState: unavailable ? 'BROWSER_UNAVAILABLE' : 'DISCONNECTED',
        browserError: error.message || String(error),
        browserAttempts: error.attempts || null,
        retryInMs: delayMs,
      });
      controllerLifecycleState = recoveryState;
      browserRuntimeStatus.browserConnected = false;
      browserRuntimeStatus.browserTransport = null;
      browserRuntimeStatus.coordinatorTabPresent = false;
      browserRuntimeStatus.reviewerTabCount = 0;
      browserRuntimeStatus.liveReviewerGenerations = 0;
      browserRuntimeStatus.reviewerSlots = [];
      preDispatchReady = false;
      startupReconciliationComplete = false;
      preDispatchEvidence = {
        ready: false,
        checkedAt: now(),
        blockers: [unavailable ? 'BROWSER_UNAVAILABLE' : 'BROWSER_DISCONNECTED'],
        eligibleBuckets: [],
        bucketExclusions: {},
      };
      browser = null;
      context = null;
      if (ownedBrowserProfile.launched) {
        if (ownedBrowserProfile.profileMode === 'clone') {
          const recovery = await terminateOwnedBrowserProcessGroup({
            pid: ownedBrowserProfile.pid,
            profileDir: ownedBrowserProfile.profileDir,
            profileDirectoryName: ownedBrowserProfile.profileDirectoryName,
            remoteDebuggingPort: config.cdpPort,
            cleanupEphemeral: ownedBrowserProfile.profileMode === 'clone',
          });
          if (recovery.attempted && recovery.stopped) {
            log(`terminated owned browser after bounded readiness failure; cleaned ${recovery.cleaned?.length || 0} ephemeral lock file(s)`);
          } else if (recovery.attempted) {
            log(`owned browser cleanup did not complete: ${recovery.reason || 'unknown failure'}`);
          }
        } else if (ownedBrowserProfile.profileMode === 'source') {
          // Source mode may have been launched by this controller, but it is the
          // user's persistent authenticated browser identity. A readiness or
          // navigation timeout must preserve that visible browser so an operator
          // can complete authentication and the next bounded loop can reattach.
          log('preserving launched source browser after bounded readiness failure');
        } else if (ownedBrowserProfile.profileMode === 'firefox') {
          try {
            await ownedBrowserProfile.context?.close?.();
            log('closed owned Firefox fallback after bounded readiness failure');
          } catch (closeError) {
            log(`unable to close owned Firefox fallback: ${closeError.message || closeError}`);
          }
        }
      }
      cleanupOwnedBrowserProfileIfStopped();
      ownedBrowserProfile = {
        launched: false,
        pid: null,
        profileDir: null,
        profileDirectoryName: config.browserProfileName || 'Default',
        profileMode: config.browserProfileMode || 'source',
        context: null,
      };
      browserContextRef = null;
      coordinatorPageRef = null;
      reviewerSlotRegistry = new Map();
      await sleep(delayMs);
      continue;
    }

    await sleep(Number(config.pollSeconds) * 1000);
  }
}

main().then(() => {
  process.exit(0);
}).catch(error => {
  try {
    cleanupOwnedBrowserProfileIfStopped();
    controllerLifecycleState = 'ERROR';
    log(`FATAL ${error.stack || error}`);
    if (!startupStateError) recordIncident('CONTROLLER_FATAL', null, error.message || String(error), { stack: error.stack || null });
    writeStatus({ connected: false, controllerState: 'ERROR', fatal: error.message || String(error) });
  } catch {}
  process.exit(1);
});
