#!/usr/bin/env node
/**
 * Turn the fix agent's working tree into a DRAFT pull request, or explain on
 * the issue why there is none. The agent never holds a token that can push or
 * open a PR; this step does both, and the only PR it ever creates is a draft.
 * The trigger label is removed at the end of every path so a maintainer can
 * re-apply it to retry. With PI_DRY_RUN=true nothing is pushed or posted.
 */

import {
  api,
  checkDiff,
  env,
  fail,
  footer,
  intEnv,
  paginate,
  readOutput,
  readResult,
  removeLabel,
  run,
  setOutput,
  summary,
  truncate,
  upsertComment,
} from "../lib/common.mjs";

const TITLE = "pi-issue-fix";

const repo = env("PI_REPO");
const issue = Number.parseInt(env("PI_ISSUE"), 10);
const outDir = env("PI_OUT");
const botLogin = env("PI_BOT_LOGIN");
const dryRun = env("PI_DRY_RUN") === "true";
const base = env("PI_BASE");
const baseSha = env("PI_BASE_SHA");
const branch = env("PI_BRANCH");
const requester = env("PI_REQUESTER");
const triggerLabel = env("PI_TRIGGER_LABEL");
const prLabel = env("PI_PR_LABEL");
const blocked = env("PI_BLOCKED");
const agentOutcome = env("PI_AGENT_OUTCOME");
const rateLimited = env("PI_RATE_LIMITED") === "true";
const model = env("PI_MODEL_USED");
const token = env("GH_TOKEN");
const limits = {
  maxFiles: intEnv("PI_MAX_FILES", 20),
  maxLines: intEnv("PI_MAX_LINES", 600),
  forbidden: env("PI_FORBIDDEN")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean),
};

if (!repo || !Number.isInteger(issue) || !outDir || !botLogin) {
  fail(TITLE, "PI_REPO, PI_ISSUE, PI_OUT and PI_BOT_LOGIN are required.");
}

const mention = requester ? `@${requester} ` : "";
summary(`### Pi fix${dryRun ? " (dry run)" : ""}\n`);

function finish(message, { failed = false } = {}) {
  upsertComment({
    repo,
    issue,
    botLogin,
    kind: "issue-fix",
    body: `${message}\n\n${footer("Automated fix attempt", model)}`,
    dryRun,
  });
  if (triggerLabel) removeLabel({ repo, issue, label: triggerLabel, dryRun });
  if (failed) process.exit(1);
  process.exit(0);
}

const git = (args, options) => run("git", args, options);

if (blocked) {
  finish(`${mention}Pi did not start a fix: ${blocked}.`);
}
if (rateLimited) {
  finish(`${mention}Pi could not attempt a fix: model quota is exhausted right now. Re-add \`${triggerLabel}\` later to retry.`);
}
if (agentOutcome !== "success") {
  finish(
    `${mention}Pi's fix attempt did not finish (the agent step ended with \`${agentOutcome || "unknown"}\`). ` +
      `See the run for details; re-add \`${triggerLabel}\` to retry.`,
    { failed: true },
  );
}

let result;
try {
  result = readResult(outDir);
} catch (error) {
  finish(`${mention}Pi's fix attempt produced no usable result (${error.message}).`, { failed: true });
}

if (result.status !== "fixed") {
  const explanation =
    readOutput(outDir, "declined.md")?.trim() ||
    (typeof result.summary === "string" && result.summary.trim()) ||
    "No explanation was provided.";
  finish(`${mention}Pi looked at this and decided not to open a PR.\n\n${truncate(explanation, 50000)}`);
}

// Collapse anything the agent committed, then stage the whole working tree.
const head = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
if (head !== branch) {
  finish(`${mention}Pi's fix attempt left the checkout on \`${head}\` instead of \`${branch}\`; not opening a PR.`, {
    failed: true,
  });
}
git(["reset", "--soft", baseSha]);
git(["add", "-A"]);
const diff = checkDiff(git(["diff", "--cached", "--numstat", "--no-renames"]), limits);
const stat = git(["diff", "--cached", "--stat", "--no-renames"]).trim();
summary(`\`\`\`\n${stat || "(no changes)"}\n\`\`\`\n`);

const description = readOutput(outDir, "pr.md")?.trim() || (typeof result.summary === "string" ? result.summary : "");
if (diff.problems.length) {
  finish(
    `${mention}Pi drafted a change but did not open a PR:\n\n${diff.problems.map((problem) => `- ${problem}`).join("\n")}` +
      (description ? `\n\n<details><summary>What Pi tried</summary>\n\n${truncate(description, 40000)}\n</details>` : ""),
  );
}

const rawTitle = typeof result.title === "string" && result.title.trim() ? result.title.trim() : `fix: issue #${issue}`;
const title = rawTitle.split("\n")[0].slice(0, 120);
const body = truncate(
  `${description || "_No description provided._"}\n\n` +
    `> [!IMPORTANT]\n> Draft opened by Pi for #${issue}${requester ? ` at @${requester}'s request` : ""}. ` +
    "Pi never marks PRs ready for review. A developer owns this from here: review it, push changes, " +
    "and mark it ready when it is right.\n\n" +
    `Closes #${issue}\n\n${footer("Drafted", model)}`,
);

if (dryRun) {
  summary(`- Would commit and push \`${branch}\` (base \`${base}\` @ ${baseSha.slice(0, 12)})`);
  summary(`- Would open a draft PR: **${title}**`);
  summary(`<details><summary>PR body</summary>\n\n${body}\n</details>\n`);
  finish(`${mention}Dry run: Pi would open a draft PR, **${title}**.`);
}

// Commit as the bot so the change is attributed to the App.
const appSlug = botLogin.replace(/\[bot\]$/, "");
const botId = api("GET", `users/${encodeURIComponent(botLogin)}`, undefined, { allowFailure: true })?.id;
const email = botId ? `${botId}+${botLogin}@users.noreply.github.com` : `${appSlug}@users.noreply.github.com`;
git(["-c", `user.name=${botLogin}`, "-c", `user.email=${email}`, "commit", "--no-verify", "-q", "-m", title, "-m", `Refs #${issue}`]);

// Push with the write token only, replacing the checkout's persisted credentials.
const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
process.stdout.write(`::add-mask::${basic}\n`);
git([
  "-c",
  "http.https://github.com/.extraheader=",
  "-c",
  `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
  "push",
  "--force",
  "--no-verify",
  `https://github.com/${repo}.git`,
  `HEAD:refs/heads/${branch}`,
]);

const pr = api("POST", `repos/${repo}/pulls`, {
  title,
  head: branch,
  base,
  body,
  draft: true,
  maintainer_can_modify: true,
});

// Belt and braces: the create call asked for a draft; make sure it is one.
const check = api("GET", `repos/${repo}/pulls/${pr.number}`);
if (!check.draft) {
  run("gh", [
    "api",
    "graphql",
    "-f",
    "query=mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
    "-f",
    `id=${check.node_id}`,
  ]);
  fail(TITLE, `PR #${pr.number} was not created as a draft; converted it back. Investigate before re-running.`);
}

if (requester) {
  api("POST", `repos/${repo}/issues/${pr.number}/assignees`, { assignees: [requester] }, { allowFailure: true });
}
if (prLabel) {
  const labels = paginate(`repos/${repo}/labels?per_page=100`).map((label) => label.name);
  if (labels.includes(prLabel)) api("POST", `repos/${repo}/issues/${pr.number}/labels`, { labels: [prLabel] });
}

setOutput("pr-number", String(pr.number));
setOutput("pr-url", pr.html_url);
summary(`Opened draft ${pr.html_url}`);
finish(
  `${mention}Pi opened a draft PR: ${pr.html_url}\n\n` +
    `${diff.files.length} file(s), ${diff.lines} line(s) changed. It is a starting point, not a finished fix: ` +
    "review it, take it over, and mark it ready when it is right.",
);
