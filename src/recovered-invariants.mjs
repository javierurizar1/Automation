/**
 * Reconstructed R4.3.3 invariant helpers.
 *
 * IMPORTANT: this is not represented as the original historical controller source.
 * It contains only behavior derivable from documented project invariants.
 */

export const AUDITABLE_POPULATION = null;
export const BUCKET_COUNT = 6;
export const MAX_ACTIVE_REVIEWERS = 2;
export const POST_GENERATION_STALL_MINUTES = 90;

export const TERMINAL_CLASSIFICATIONS = Object.freeze([
  "PASS",
  "MINOR",
  "FAIL",
  "SOURCE_UNAVAILABLE",
  "TECHNICAL_REVIEW_FAILURE",
]);

export const AUDIT_TURN_STATUSES = Object.freeze(["NORMAL", "ERROR", "COMPLETE"]);
export const WRITE_VERIFICATION_VALUES = Object.freeze(["YES", "NO", "PARTIAL"]);

export function normalizeStableId(stableId) {
  if (typeof stableId !== "string") throw new TypeError("stable_id must be a string");
  const value = stableId.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(value)) throw new Error(`Invalid hexadecimal stable_id: ${stableId}`);
  return value;
}

export function bucketForStableId(stableId) {
  const normalized = normalizeStableId(stableId);
  return Number(BigInt(`0x${normalized}`) % BigInt(BUCKET_COUNT));
}

export function assertBucket(bucket) {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket >= BUCKET_COUNT) {
    throw new RangeError(`bucket must be an integer from 0 to ${BUCKET_COUNT - 1}`);
  }
}

export function stableIdBelongsToBucket(stableId, bucket) {
  assertBucket(bucket);
  return bucketForStableId(stableId) === bucket;
}

export function isTerminalClassification(value) {
  return TERMINAL_CLASSIFICATIONS.includes(value);
}

export function parsePackNumber(packName) {
  if (typeof packName !== "string") throw new TypeError("packName must be a string");
  const match = /^pack_(\d{6})\.jsonl$/.exec(packName.trim());
  if (!match) throw new Error(`Invalid pack filename: ${packName}`);
  return Number(match[1]);
}

export function packName(packNumber) {
  if (!Number.isInteger(packNumber) || packNumber < 0 || packNumber > 999999) {
    throw new RangeError("packNumber must be an integer between 0 and 999999");
  }
  return `pack_${String(packNumber).padStart(6, "0")}.jsonl`;
}

export function nextPackName(currentPackName) {
  return packName(parsePackNumber(currentPackName) + 1);
}

export function formatAuditTurnStatus({status, newCases, writesVerified, blocker = "NONE", triggerCoordinator}) {
  if (!AUDIT_TURN_STATUSES.includes(status)) throw new Error(`Invalid STATUS: ${status}`);
  if (!Number.isInteger(newCases) || newCases < 0) throw new Error("NEW_CASES must be a non-negative integer");
  if (!WRITE_VERIFICATION_VALUES.includes(writesVerified)) throw new Error(`Invalid WRITES_VERIFIED: ${writesVerified}`);
  if (typeof blocker !== "string" || blocker.trim() === "") throw new Error("BLOCKER must be non-empty");
  if (typeof triggerCoordinator !== "boolean") throw new TypeError("triggerCoordinator must be boolean");
  return [
    "AUDIT_TURN_STATUS",
    `STATUS: ${status}`,
    `NEW_CASES: ${newCases}`,
    `WRITES_VERIFIED: ${writesVerified}`,
    `BLOCKER: ${blocker.trim()}`,
    `TRIGGER_COORDINATOR: ${triggerCoordinator ? "YES" : "NO"}`,
  ].join("\n");
}

export function completionEvidence({
  fullCorpusReconciled,
  auditablePopulation,
  expectedPopulation,
  ownedPendingCases,
  unresolvedWrites = 0,
}) {
  const populationVerified = Number.isSafeInteger(expectedPopulation)
    && expectedPopulation >= 0
    && auditablePopulation === expectedPopulation;
  const complete = fullCorpusReconciled === true
    && populationVerified
    && ownedPendingCases === 0
    && unresolvedWrites === 0;
  return {
    complete,
    lines: [
      "FULL_CORPUS_RECONCILED: " + (fullCorpusReconciled ? "YES" : "NO"),
      "FULL_CORPUS_AUDITABLE_POPULATION: " + (Number.isSafeInteger(auditablePopulation) ? auditablePopulation : "UNSPECIFIED"),
      "OWNED_PENDING_CASES: " + ownedPendingCases,
    ],
  };
}

/** Bind response deduplication to the action identity, not responseHash alone. */
export function responseDedupKey({actionId, responseHash}) {
  if (!actionId || typeof actionId !== "string") throw new Error("actionId is required");
  if (!responseHash || typeof responseHash !== "string") throw new Error("responseHash is required");
  return `${actionId}:${responseHash}`;
}
