/** Pure helpers for the pr-review apply step, kept apart so they are unit-testable. */

import { footer, marker, truncate } from "../lib/common.mjs";

export const REVIEW_MARKER = marker("pr-review");
export const VERDICTS = new Set(["approve", "request-changes"]);

/**
 * Parse the agent's final message: a `VERDICT: <verdict>` line, then the review
 * body. Text before the verdict line (narration) is dropped.
 */
export function parseResult(text) {
  const lines = String(text ?? "").split("\n");
  const index = lines.findIndex((line) => /^\s*\**VERDICT:?\**\s*:?/i.test(line));
  if (index === -1) throw new Error("the final message has no VERDICT line");
  const verdict = lines[index]
    .replace(/^\s*\**VERDICT:?\**\s*:?/i, "")
    .replace(/[*`.]/g, "")
    .trim()
    .toLowerCase();
  return { verdict, report: lines.slice(index + 1).join("\n").trim() };
}

/** Validate the verdict and pick the review event for the mode. */
export function planReview(result, mode) {
  const verdict = typeof result?.verdict === "string" ? result.verdict.trim().toLowerCase() : "";
  if (!VERDICTS.has(verdict)) {
    throw new Error(`verdict must be "approve" or "request-changes", got ${JSON.stringify(result?.verdict)}`);
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
  if (!text) throw new Error("the review body is empty but the verdict is request-changes");
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

/** Credentials from a newline-separated list that appear in the text. */
export function leakedSecrets(text, list) {
  return String(list ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length >= 8 && String(text ?? "").includes(value));
}
