import assert from "node:assert/strict";
import { test } from "node:test";

import { inferOwner, planModelChain } from "./models.mjs";

const listing = [
  { id: "claude-opus-5-5", object: "model", owned_by: "anthropic", created: 1 },
  { id: "gpt-6-sol", object: "model", owned_by: "openai", created: 2 },
];

test("a fully listed chain adds nothing", () => {
  const { unlisted, snapshot } = planModelChain(["gpt-6-sol", "claude-opus-5-5"], listing);
  assert.deepEqual(unlisted, []);
  assert.deepEqual(snapshot, listing);
});

test("an unlisted primary is kept and gets a synthetic snapshot entry", () => {
  const { unlisted, snapshot } = planModelChain(["gpt-6.1-sol", "claude-opus-5-5"], listing);
  assert.deepEqual(unlisted, ["gpt-6.1-sol"]);
  assert.deepEqual(snapshot, [...listing, { id: "gpt-6.1-sol", object: "model", owned_by: "openai" }]);
});

test("an id with no known family gets no owner", () => {
  const { snapshot } = planModelChain(["mystery-1"], listing);
  assert.deepEqual(snapshot.at(-1), { id: "mystery-1", object: "model" });
});

test("duplicates in the chain yield one entry", () => {
  const { unlisted, snapshot } = planModelChain(["gpt-6.1-sol", "gpt-6.1-sol"], listing);
  assert.deepEqual(unlisted, ["gpt-6.1-sol"]);
  assert.equal(snapshot.length, listing.length + 1);
});

test("inferOwner maps CLIProxyAPI families", () => {
  assert.equal(inferOwner("claude-sonnet-5-5"), "anthropic");
  assert.equal(inferOwner("gpt-6.1-sol"), "openai");
  assert.equal(inferOwner("o4-mini"), "openai");
  assert.equal(inferOwner("gemini-3-pro"), "google");
  assert.equal(inferOwner("kimi-k3"), undefined);
});
