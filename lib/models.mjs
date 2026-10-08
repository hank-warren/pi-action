/**
 * Model-chain planning against the gateway's /models listing.
 *
 * CLIProxyAPI drops a model from /models while it has the model suspended or
 * cooling down on every credential, and only a successful request through it
 * brings it back. Skipping unlisted models up front therefore never sends the
 * request that would clear the suspension, so a briefly hidden primary stays
 * hidden. The runner instead tries every model in the chain and lets the
 * per-attempt fallback (model_not_found, auth_unavailable, model_cooldown)
 * move on when a model really cannot answer.
 */

// CLIProxyAPI's owned_by values; the provider extension picks the wire API from it.
const OWNER_BY_PREFIX = [
  [/^claude-/, "anthropic"],
  [/^(gpt-|o\d|codex-)/, "openai"],
  [/^gemini-/, "google"],
];

export function inferOwner(id) {
  return OWNER_BY_PREFIX.find(([pattern]) => pattern.test(id))?.[1];
}

/**
 * @param {string[]} modelIds bare ids in chain order (no provider prefix)
 * @param {{id: string, object?: string, owned_by?: string, created?: number}[]} gatewayModels
 * @returns {{unlisted: string[], snapshot: object[]}} unlisted ids, and the listing plus a
 *   synthetic entry per unlisted id so the provider extension registers it with real metadata.
 */
export function planModelChain(modelIds, gatewayModels) {
  const listedIds = new Set(gatewayModels.map((entry) => entry.id));
  const unlisted = [...new Set(modelIds)].filter((id) => !listedIds.has(id));
  const synthetic = unlisted.map((id) => {
    const owner = inferOwner(id);
    return { id, object: "model", ...(owner ? { owned_by: owner } : {}) };
  });
  return { unlisted, snapshot: [...gatewayModels, ...synthetic] };
}
