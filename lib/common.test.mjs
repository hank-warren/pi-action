import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkDiff, pickLabels, readOutput, truncate } from "./common.mjs";

test("pickLabels keeps existing labels in the repo's spelling and drops the rest", () => {
  const { kept, dropped } = pickLabels(
    ["Bug", "area:api", "made-up", "bug", 7, " priority:high "],
    ["bug", "area:api", "priority:high"],
    8,
  );
  assert.deepEqual(kept, ["bug", "area:api", "priority:high"]);
  assert.deepEqual(dropped, ["made-up"]);
});

test("pickLabels caps the count", () => {
  const { kept, dropped } = pickLabels(["a", "b", "c"], ["a", "b", "c"], 2);
  assert.deepEqual(kept, ["a", "b"]);
  assert.deepEqual(dropped, ["c"]);
});

test("pickLabels tolerates a missing list", () => {
  assert.deepEqual(pickLabels(undefined, ["a"], 3), { kept: [], dropped: [] });
});

const limits = { maxFiles: 3, maxLines: 100, forbidden: [".github/"] };

test("checkDiff accepts a small change", () => {
  const result = checkDiff("10\t2\tapp/routers/datasets.py\n5\t0\ttests/test_datasets.py\n", limits);
  assert.deepEqual(result.problems, []);
  assert.equal(result.lines, 17);
});

test("checkDiff refuses an empty change", () => {
  assert.match(checkDiff("", limits).problems[0], /no changes/);
});

test("checkDiff refuses forbidden paths, binaries, and oversize changes", () => {
  const numstat = [
    "1\t0\t.github/workflows/ci.yml",
    "-\t-\tassets/logo.png",
    "90\t20\ta.py",
    "1\t1\tb.py",
  ].join("\n");
  const { problems } = checkDiff(numstat, limits);
  assert.ok(problems.some((p) => p.includes(".github/workflows/ci.yml")));
  assert.ok(problems.some((p) => p.includes("binary")));
  assert.ok(problems.some((p) => p.includes("4 files")));
  assert.ok(problems.some((p) => p.includes("113 lines")));
});

test("checkDiff treats forbidden entries as paths, not string prefixes", () => {
  const forbid = (file, entry) => checkDiff(`1\t0\t${file}\n`, { ...limits, forbidden: [entry] }).problems.length;
  assert.equal(forbid("deploy/x.yml", "deploy"), 1);
  assert.equal(forbid("deploy/x.yml", "deploy/"), 1);
  assert.equal(forbid("deploy", "deploy/"), 1);
  assert.equal(forbid("deployment.py", "deploy"), 0);
  assert.equal(forbid(".github-notes.md", ".github/"), 0);
});

test("readOutput refuses paths outside the output directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-out-"));
  writeFileSync(path.join(dir, "ok.md"), "hello");
  assert.equal(readOutput(dir, "ok.md"), "hello");
  assert.equal(readOutput(dir, "missing.md"), null);
  assert.throws(() => readOutput(dir, "../etc/passwd"), /escapes/);
  assert.throws(() => readOutput(dir, "missing.md", { required: true }), /did not write/);
});

test("truncate leaves short text alone and marks long text", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.match(truncate("x".repeat(20), 10), /^x{10}\n\n_…truncated/);
});
