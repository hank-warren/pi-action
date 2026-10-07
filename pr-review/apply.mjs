#!/usr/bin/env node
/**
 * Post the review the agent wrote to $PI_OUT: exactly one review, pinned to the
 * commit that was reviewed, then collapse this identity's older Pi reviews. When
 * a newer non-approving review replaces a blocking one, the old block is
 * dismissed so it cannot outlive the findings. With PI_DRY_RUN=true nothing is
 * written; the plan goes to the step summary.
 */

import { api, env, fail, readOutput, readResult, run, setOutput, summary, warn } from "../lib/common.mjs";
import { buildBody, planReview, staleBlockingReviews, supersededReviews } from "./review.mjs";

const TITLE = "pi-pr-review";

const repo = env("PI_REPO");
const pr = Number.parseInt(env("PI_PR"), 10);
const outDir = env("PI_OUT");
const headSha = env("PI_HEAD_SHA");
const mode = env("PI_REVIEW_MODE", "verdict");
const dryRun = env("PI_DRY_RUN") === "true";
const model = env("PI_MODEL_USED");

if (!repo || !Number.isInteger(pr) || !outDir || !headSha) {
  fail(TITLE, "PI_REPO, PI_PR, PI_OUT and PI_HEAD_SHA are required.");
}

let plan;
let body;
try {
  plan = planReview(readResult(outDir), mode);
  body = buildBody({ verdict: plan.verdict, report: readOutput(outDir, "review.md"), model });
} catch (error) {
  fail(TITLE, `The agent did not produce a usable review: ${error.message}`);
}
setOutput("verdict", plan.verdict);

summary(`### Pi review${dryRun ? " (dry run)" : ""}\n`);
summary(`Verdict: **${plan.verdict}** · event: \`${plan.event}\`\n`);

if (dryRun) {
  summary(`<details><summary>Review body</summary>\n\n${body}\n</details>`);
  setOutput("event", plan.event);
  process.exit(0);
}

// A push after the snapshot means a newer run reviews the new head; this one
// is stale and must not post.
const currentHead = api("GET", `repos/${repo}/pulls/${pr}`).head.sha;
if (currentHead !== headSha) {
  warn(TITLE, `PR head moved from ${headSha.slice(0, 7)} to ${currentHead.slice(0, 7)} during review; not posting.`);
  process.exit(0);
}

function postReview(event) {
  return api("POST", `repos/${repo}/pulls/${pr}/reviews`, { commit_id: headSha, event, body });
}

let event = plan.event;
let review;
try {
  review = postReview(event);
} catch (error) {
  // GITHUB_TOKEN may not approve unless the repo allows it; say the same thing as a comment.
  if (event !== "APPROVE" || !/not permitted to approve/i.test(error.message)) throw error;
  warn(
    TITLE,
    "This token may not approve pull requests (enable \"Allow GitHub Actions to create and approve pull requests\" " +
      "or use an App); posting the approval as a comment.",
  );
  event = "COMMENT";
  review = postReview(event);
}
setOutput("event", event);
setOutput("review-url", review.html_url ?? "");
summary(`Posted ${event}: ${review.html_url ?? ""}`);

// Cleanup is best-effort: a failure here never un-posts the review.
try {
  const [owner, name] = repo.split("/");
  const query = `query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $pr) {
      reviews(last: 100) { nodes { id databaseId state isMinimized viewerDidAuthor body } } } } }`;
  const nodes = JSON.parse(
    run("gh", ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `pr=${pr}`, "-f", `query=${query}`]),
  ).data.repository.pullRequest.reviews.nodes;
  const keepId = review.node_id;

  if (event !== "APPROVE" && event !== "REQUEST_CHANGES") {
    for (const node of staleBlockingReviews(nodes, keepId)) {
      api("PUT", `repos/${repo}/pulls/${pr}/reviews/${node.databaseId}/dismissals`, {
        message: "Superseded by a newer Pi review.",
        event: "DISMISS",
      });
    }
  }

  const mutation = `mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { clientMutationId } }`;
  const old = supersededReviews(nodes, keepId);
  for (const node of old) run("gh", ["api", "graphql", "-f", `id=${node.id}`, "-f", `query=${mutation}`]);
  if (old.length) summary(`Collapsed ${old.length} superseded review(s).`);
} catch (error) {
  warn(TITLE, `Could not clean up older reviews: ${error.message}`);
}
