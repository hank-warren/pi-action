/** Pure helpers for the pr-review apply step, kept apart so they are unit-testable. */

import { footer, marker, truncate } from "../lib/common.mjs";

export const REVIEW_MARKER = marker("pr-review");
export const VERDICTS = new Set(["approve", "request-changes"]);

/** Validate result.json and pick the review event for the mode. */
export function planReview(result, mode) {
  const verdict = typeof result?.verdict === "string" ? result.verdict.trim().toLowerCase() : "";
  if (!VERDICTS.has(verdict)) {
    throw new Error(`result.json verdict must be "approve" or "request-changes", got ${JSON.stringify(result?.verdict)}`);
  }
  let event = "COMMENT";
  if (mode === "verdict") event = verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";
  return { verdict, event };
}

/**
 * A clean PR gets a one-line body whatever the agent wrote, so approvals stay
 * quiet. Findings get the agent's report. Both end with the footer and marker
 * the collapse step keys on.
 */
export function buildBody({ verdict, report, model }) {
  const text = verdict === "approve" ? "✅ No blocking issues." : truncate((report ?? "").trim(), 60000);
  if (!text) throw new Error("review.md is empty but the verdict is request-changes");
  return `${text}\n\n${footer("Automated review", model)}\n${REVIEW_MARKER}\n`;
}

/** Older reviews by this identity that carry the marker and are still expanded. */
export function supersededReviews(nodes, keepId) {
  return (Array.isArray(nodes) ? nodes : []).filter(
    (node) => node?.viewerDidAuthor && !node.isMinimized && node.id !== keepId && node.body?.includes(REVIEW_MARKER),
  );
}

/** This identity's earlier blocking reviews, which a non-approval does not clear. */
export function staleBlockingReviews(nodes, keepId) {
  return (Array.isArray(nodes) ? nodes : []).filter(
    (node) =>
      node?.viewerDidAuthor && node.state === "CHANGES_REQUESTED" && node.id !== keepId && node.body?.includes(REVIEW_MARKER),
  );
}
