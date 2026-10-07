#!/usr/bin/env node
/**
 * Apply a triage the agent wrote to $PI_OUT: labels, follow-up issues, and one
 * triage comment edited in place. Everything the agent asked for is filtered
 * here: only labels that already exist, at most PI_MAX_NEW_ISSUES new issues,
 * no closing. With PI_DRY_RUN=true nothing is written; the plan goes to the
 * step summary.
 */

import {
  api,
  env,
  fail,
  footer,
  intEnv,
  paginate,
  pickLabels,
  readOutput,
  readResult,
  removeLabel,
  setOutput,
  summary,
  truncate,
  upsertComment,
  warn,
} from "../lib/common.mjs";

const TITLE = "pi-issue-triage";
const MAX_LABELS = 8;
const FIX_CANDIDATES = new Set(["yes", "no", "unsure"]);

const repo = env("PI_REPO");
const issue = Number.parseInt(env("PI_ISSUE"), 10);
const outDir = env("PI_OUT");
const botLogin = env("PI_BOT_LOGIN");
const dryRun = env("PI_DRY_RUN") === "true";
const maxNewIssues = intEnv("PI_MAX_NEW_ISSUES", 1);
const fixLabel = env("PI_FIX_LABEL");
const doneLabels = env("PI_REMOVE_LABELS").split(/[\s,]+/).filter(Boolean);
const model = env("PI_MODEL_USED");

if (!repo || !Number.isInteger(issue) || !outDir || !botLogin) {
  fail(TITLE, "PI_REPO, PI_ISSUE, PI_OUT and PI_BOT_LOGIN are required.");
}

let result;
let report;
try {
  result = readResult(outDir);
  report = readOutput(outDir, "triage.md", { required: true }).trim();
  if (!report) throw new Error("triage.md is empty");
} catch (error) {
  fail(TITLE, `The agent did not produce a usable triage: ${error.message}`);
}

summary(`### Pi triage${dryRun ? " (dry run)" : ""}\n`);

const existingLabels = paginate(`repos/${repo}/labels?per_page=100`).map((label) => label.name);
const current = api("GET", `repos/${repo}/issues/${issue}`).labels.map((label) => label.name);

// Labels
const { kept, dropped } = pickLabels(result.labels, existingLabels, MAX_LABELS);
if (dropped.length) warn(TITLE, `Ignored labels that do not exist or exceed the cap: ${dropped.join(", ")}`);

let duplicateOf = null;
if (Number.isInteger(result.duplicate_of) && result.duplicate_of !== issue) {
  const original = api("GET", `repos/${repo}/issues/${result.duplicate_of}`, undefined, { allowFailure: true });
  if (original) {
    duplicateOf = result.duplicate_of;
    const duplicateLabel = existingLabels.find((name) => name.toLowerCase() === "duplicate");
    if (duplicateLabel && !kept.includes(duplicateLabel)) kept.push(duplicateLabel);
  } else {
    warn(TITLE, `duplicate_of #${result.duplicate_of} does not exist; ignoring it.`);
  }
}

const toAdd = kept.filter((name) => !current.includes(name));
if (toAdd.length) {
  if (dryRun) summary(`- Would add labels: ${toAdd.map((name) => `\`${name}\``).join(", ")}`);
  else api("POST", `repos/${repo}/issues/${issue}/labels`, { labels: toAdd });
}
for (const label of doneLabels.filter((name) => current.includes(name))) {
  removeLabel({ repo, issue, label, dryRun });
}

// Follow-up issues: capped, and never a second copy of an open issue's exact title.
const proposed = Array.isArray(result.new_issues) ? result.new_issues : [];
if (proposed.length > maxNewIssues) {
  warn(TITLE, `Agent proposed ${proposed.length} new issues; filing at most ${maxNewIssues}.`);
}
const created = [];
for (const entry of proposed.slice(0, maxNewIssues)) {
  const title = typeof entry?.title === "string" ? entry.title.trim().slice(0, 200) : "";
  let body;
  try {
    body = readOutput(outDir, entry?.body_file, { required: true }).trim();
  } catch (error) {
    warn(TITLE, `Skipping proposed issue "${title}": ${error.message}`);
    continue;
  }
  if (!title || !body) continue;
  const query = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${title.replaceAll('"', "")}"`);
  const matches = api("GET", `search/issues?q=${query}&per_page=20`).items ?? [];
  const twin = matches.find((item) => item.title.trim().toLowerCase() === title.toLowerCase());
  if (twin) {
    warn(TITLE, `Not filing "${title}": #${twin.number} already has that title.`);
    created.push({ number: twin.number, title, existing: true });
    continue;
  }
  const labels = pickLabels(entry.labels, existingLabels, 5).kept;
  const fullBody = truncate(`${body}\n\n---\n_Filed by Pi while triaging #${issue}._`);
  if (dryRun) {
    summary(`- Would file issue **${title}** with labels [${labels.join(", ")}]`);
    summary(`<details><summary>Issue body</summary>\n\n${fullBody}\n</details>\n`);
    created.push({ number: null, title });
  } else {
    const issueResult = api("POST", `repos/${repo}/issues`, { title, body: fullBody, labels });
    created.push({ number: issueResult.number, title });
  }
}

// Comment
const fixCandidate = FIX_CANDIDATES.has(result.fix_candidate) ? result.fix_candidate : "unsure";
const sections = [truncate(report, 55000)];
if (created.length) {
  sections.push(
    `**Follow-ups:** ${created
      .map((item) => (item.number ? `#${item.number}` : `"${item.title}" (dry run)`))
      .join(", ")}`,
  );
}
if (duplicateOf) sections.push(`**Possible duplicate of #${duplicateOf}.** Left open for a human to confirm.`);
if (fixCandidate === "yes" && fixLabel && existingLabels.includes(fixLabel)) {
  sections.push(
    `> [!TIP]\n> Pi thinks this is a reasonable candidate for an automated fix. A maintainer can add the ` +
      `\`${fixLabel}\` label to have Pi open a **draft** PR for a developer to review and finish.`,
  );
}
sections.push(footer("Automated triage", model));

const commentUrl = upsertComment({
  repo,
  issue,
  botLogin,
  kind: "issue-triage",
  body: sections.join("\n\n"),
  dryRun,
});

setOutput("comment-url", commentUrl);
setOutput("fix-candidate", fixCandidate);
setOutput("created-issues", created.map((item) => item.number).filter(Boolean).join(","));
summary(`\nFix candidate: **${fixCandidate}**${commentUrl ? ` · ${commentUrl}` : ""}`);
