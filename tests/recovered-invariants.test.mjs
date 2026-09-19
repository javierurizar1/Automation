import test from "node:test";
import assert from "node:assert/strict";
import {
  bucketForStableId,
  stableIdBelongsToBucket,
  parsePackNumber,
  packName,
  nextPackName,
  formatAuditTurnStatus,
  completionEvidence,
  responseDedupKey,
} from "../src/recovered-invariants.mjs";

test("bucket ownership is stable modulo 6", () => {
  assert.equal(bucketForStableId("0"), 0);
  assert.equal(bucketForStableId("1"), 1);
  assert.equal(bucketForStableId("6"), 0);
  assert.equal(stableIdBelongsToBucket("0x7", 1), true);
});

test("pack helpers preserve six-digit naming", () => {
  assert.equal(parsePackNumber("pack_000217.jsonl"), 217);
  assert.equal(packName(54), "pack_000054.jsonl");
  assert.equal(nextPackName("pack_000053.jsonl"), "pack_000054.jsonl");
});

test("status footer has exactly six lines", () => {
  const footer = formatAuditTurnStatus({status:"NORMAL", newCases:50, writesVerified:"YES", blocker:"NONE", triggerCoordinator:false});
  assert.equal(footer.split("\n").length, 6);
  assert.match(footer, /^AUDIT_TURN_STATUS\nSTATUS: NORMAL/);
});

test("completion requires full 65720 population and zero pending/unresolved", () => {
  assert.equal(completionEvidence({fullCorpusReconciled:true, auditablePopulation:65720, ownedPendingCases:0}).complete, true);
  assert.equal(completionEvidence({fullCorpusReconciled:true, auditablePopulation:65720, ownedPendingCases:1}).complete, false);
});

test("response dedup key is action-aware", () => {
  assert.notEqual(responseDedupKey({actionId:"A-1", responseHash:"same"}), responseDedupKey({actionId:"A-2", responseHash:"same"}));
});
