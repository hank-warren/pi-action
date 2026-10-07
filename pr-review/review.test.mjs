import assert from "node:assert/strict";
import { test } from "node:test";

import { REVIEW_MARKER, buildBody, planReview, staleBlockingReviews, supersededReviews } from "./review.mjs";

test("planReview maps verdicts to events in verdict mode", () => {
  assert.deepEqual(planReview({ verdict: "approve" }, "verdict"), { verdict: "approve", event: "APPROVE" });
  assert.deepEqual(planReview({ verdict: " Request-Changes " }, "verdict"), {
    verdict: "request-changes",
    event: "REQUEST_CHANGES",
  });
});

test("planReview never blocks in comment mode", () => {
  assert.equal(planReview({ verdict: "request-changes" }, "comment").event, "COMMENT");
  assert.equal(planReview({ verdict: "approve" }, "comment").event, "COMMENT");
});

test("planReview rejects anything but the two verdicts", () => {
  assert.throws(() => planReview({ verdict: "lgtm" }, "verdict"), /verdict must be/);
  assert.throws(() => planReview({}, "verdict"), /verdict must be/);
});

test("buildBody keeps approvals to one line and ignores the report", () => {
  const body = buildBody({ verdict: "approve", report: "I checked everything.", model: "cpa/gpt-6.1-sol" });
  assert.match(body, /^✅ No blocking issues\.\n/);
  assert.doesNotMatch(body, /checked everything/);
  assert.match(body, /`gpt-6\.1-sol`/);
  assert.ok(body.trimEnd().endsWith(REVIEW_MARKER));
});

test("buildBody carries findings and refuses an empty blocking review", () => {
  const body = buildBody({ verdict: "request-changes", report: "1. `a.js:3`: boom\n", model: "" });
  assert.match(body, /^1\. `a\.js:3`: boom\n/);
  assert.ok(body.includes(REVIEW_MARKER));
  assert.throws(() => buildBody({ verdict: "request-changes", report: "  ", model: "" }), /empty/);
  assert.throws(() => buildBody({ verdict: "request-changes", report: null, model: "" }), /empty/);
});

const nodes = [
  { id: "a", viewerDidAuthor: true, isMinimized: false, state: "CHANGES_REQUESTED", body: `x\n${REVIEW_MARKER}` },
  { id: "b", viewerDidAuthor: true, isMinimized: true, state: "COMMENTED", body: `x\n${REVIEW_MARKER}` },
  { id: "c", viewerDidAuthor: false, isMinimized: false, state: "CHANGES_REQUESTED", body: `x\n${REVIEW_MARKER}` },
  { id: "d", viewerDidAuthor: true, isMinimized: false, state: "COMMENTED", body: "unrelated bot review" },
  { id: "e", viewerDidAuthor: true, isMinimized: false, state: "APPROVED", body: `ok\n${REVIEW_MARKER}` },
];

test("supersededReviews picks only this identity's expanded, marked reviews other than the new one", () => {
  assert.deepEqual(
    supersededReviews(nodes, "e").map((node) => node.id),
    ["a"],
  );
});

test("staleBlockingReviews picks this identity's marked change requests", () => {
  assert.deepEqual(
    staleBlockingReviews(nodes, "e").map((node) => node.id),
    ["a"],
  );
  assert.deepEqual(staleBlockingReviews(undefined, "e"), []);
});
