/**
 * Shared helpers for the issue-triage and issue-fix apply steps.
 *
 * The agent never writes to GitHub. It leaves files in an output directory and
 * these deterministic steps apply them, so the limits on what lands (one comment,
 * existing labels only, capped new issues, draft-only PRs) do not depend on the
 * model following instructions. Zero npm dependencies, like runner.mjs.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function env(name, fallback = "") {
  return (process.env[name] ?? fallback).trim();
}

export function intEnv(name, fallback) {
  const value = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
}

export function warn(title, message) {
  process.stdout.write(`::warning title=${title}::${message}\n`);
}

export function fail(title, message) {
  process.stdout.write(`::error title=${title}::${message}\n`);
  process.exit(1);
}

export function run(cmd, args, { input, allowFailure = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return null;
    const stderr = error.stderr?.toString().trim();
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${stderr || error.message}`);
  }
}

export function api(method, route, body, { allowFailure = false } = {}) {
  const args = ["api", "-X", method, route, "-H", "Accept: application/vnd.github+json"];
  const out =
    body === undefined
      ? run("gh", args, { allowFailure })
      : run("gh", [...args, "--input", "-"], { input: JSON.stringify(body), allowFailure });
  if (out === null) return null;
  return out.trim() ? JSON.parse(out) : {};
}

export function paginate(route) {
  const out = run("gh", ["api", "--paginate", route, "--jq", ".[] | tojson"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Read a file the agent wrote, refusing paths that escape its output directory. */
export function readOutput(outDir, name, { required = false } = {}) {
  const resolved = path.resolve(outDir, String(name ?? ""));
  if (!resolved.startsWith(path.resolve(outDir) + path.sep)) {
    throw new Error(`output path escapes the output directory: ${name}`);
  }
  if (!existsSync(resolved)) {
    if (required) throw new Error(`agent did not write ${name}`);
    return null;
  }
  return readFileSync(resolved, "utf8");
}

export function readResult(outDir) {
  const text = readOutput(outDir, "result.json", { required: true });
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw new Error(`result.json is not a JSON object: ${error.message}`);
  }
}

/**
 * Keep only labels that already exist in the repo (case-insensitive, returned
 * with the repo's spelling), de-duplicated, capped at `max`. Never creates labels.
 */
export function pickLabels(requested, existing, max) {
  const byLower = new Map(existing.map((name) => [name.toLowerCase(), name]));
  const kept = [];
  const dropped = [];
  for (const raw of Array.isArray(requested) ? requested : []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const name = byLower.get(raw.trim().toLowerCase());
    if (!name) dropped.push(raw.trim());
    else if (!kept.includes(name)) kept.push(name);
  }
  return { kept: kept.slice(0, max), dropped: [...dropped, ...kept.slice(max)] };
}

/** GitHub rejects comment and issue bodies over 65536 characters. */
export function truncate(text, max = 60000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n_…truncated; the full output is in the run's transcript artifact._`;
}

export const marker = (kind) => `<!-- pi-action:${kind} -->`;

/** One comment per issue per kind, edited in place on later runs. */
export function upsertComment({ repo, issue, botLogin, kind, body, dryRun }) {
  const tag = marker(kind);
  const full = `${body.trim()}\n\n${tag}\n`;
  const existing = paginate(`repos/${repo}/issues/${issue}/comments?per_page=100`).find(
    (comment) => comment.user?.login === botLogin && comment.body?.includes(tag),
  );
  if (dryRun) {
    summary(`#### Would ${existing ? `edit comment ${existing.html_url}` : "post a new comment"}\n`);
    summary(`<details><summary>Comment body</summary>\n\n${full}\n</details>\n`);
    return existing?.html_url ?? "";
  }
  const result = existing
    ? api("PATCH", `repos/${repo}/issues/comments/${existing.id}`, { body: full })
    : api("POST", `repos/${repo}/issues/${issue}/comments`, { body: full });
  return result.html_url;
}

export function removeLabel({ repo, issue, label, dryRun }) {
  if (dryRun) {
    summary(`- Would remove label \`${label}\``);
    return;
  }
  api("DELETE", `repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`, undefined, {
    allowFailure: true,
  });
}

/**
 * Judge a staged diff from `git diff --cached --numstat --no-renames`.
 * Returns the parsed files and every reason the change must not become a PR.
 */
export function checkDiff(numstat, { maxFiles, maxLines, forbidden }) {
  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split("\t");
      const binary = added === "-" || deleted === "-";
      return {
        path: rest.join("\t"),
        added: binary ? 0 : Number(added),
        deleted: binary ? 0 : Number(deleted),
        binary,
      };
    });
  const problems = [];
  if (files.length === 0) problems.push("the agent reported a fix but left no changes");
  const lines = files.reduce((total, file) => total + file.added + file.deleted, 0);
  if (files.length > maxFiles) problems.push(`${files.length} files changed (limit ${maxFiles})`);
  if (lines > maxLines) problems.push(`${lines} lines changed (limit ${maxLines})`);
  for (const file of files) {
    const prefix = forbidden.find((entry) => {
      const dir = entry.replace(/\/+$/, "");
      return dir && (file.path === dir || file.path.startsWith(`${dir}/`));
    });
    if (prefix) problems.push(`\`${file.path}\` is under \`${prefix}\`, which Pi may not change`);
    if (file.binary) problems.push(`\`${file.path}\` is a binary file`);
  }
  return { files, lines, problems };
}

export function runUrl() {
  const server = env("GITHUB_SERVER_URL", "https://github.com");
  const repo = env("GITHUB_REPOSITORY");
  const id = env("GITHUB_RUN_ID");
  return repo && id ? `${server}/${repo}/actions/runs/${id}` : "";
}

export function footer(what, model) {
  const url = runUrl();
  const parts = [`${what} by Pi`];
  if (model) parts[0] += ` (\`${model.replace(/^cpa\//, "")}\`)`;
  if (url) parts.push(`[run](${url})`);
  return `<sub>${parts.join(" · ")}</sub>`;
}
