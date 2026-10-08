# pi-action

Run the [Pi](https://github.com/earendil-works/pi-mono) coding agent headlessly in GitHub Actions,
with all model traffic going through a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) gateway you run.

A generic, skill-driven replacement for `anthropics/claude-code-action@v1`. Behavior lives in
reviewable `SKILL.md` files in the calling repo, not in action config. Every run uploads a full
JSONL session transcript.

## Quick start

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: hank-warren/pi-action@v1
        with:
          skill: .github/skills/pr-review
          prompt: 'Review this PR per the skill.'
          tools: read,bash
          cliproxyapi-api-key: ${{ secrets.CLIPROXYAPI_API_KEY }}
          cliproxyapi-base-url: ${{ vars.CLIPROXYAPI_BASE_URL }}
          app-client-id: ${{ vars.PI_APP_CLIENT_ID }}
          app-private-key: ${{ secrets.PI_APP_PRIVATE_KEY }}
```

Runs on `ubuntu-latest`; the gateway must be reachable from the runner. Comments and reviews post as
your App's `<app-slug>[bot]`, or `github-actions[bot]` without one (see [Bot identity](#bot-identity)).

## PR review

`hank-warren/pi-action/pr-review@v1` posts one review per push: an approval for a clean PR, or
"request changes" with `path:line` findings. Older Pi reviews on the PR are collapsed so only the
newest stays expanded. See [`examples/workflows/pi-review.yml`](examples/workflows/pi-review.yml):

```yaml
- uses: actions/checkout@v4
  with:
    persist-credentials: false
- uses: hank-warren/pi-action/pr-review@v1
  with:
    cliproxyapi-api-key: ${{ secrets.CLIPROXYAPI_API_KEY }}
    cliproxyapi-base-url: ${{ vars.CLIPROXYAPI_BASE_URL }}
```

- **Models:** `cpa/gpt-6.1-sol`, falling back to `cpa/claude-opus-5-5` on quota exhaustion or an
  unavailable model, with `thinking: high`. Out of quota on both posts nothing and exits 0.
- **The agent never writes to GitHub, or to disk.** The action prefetches the PR's metadata, diff and
  earlier reviews into files; the agent reads those and the checkout with read-only tools
  (`read,grep,find,ls`) and answers with a verdict plus a review body. A deterministic step posts
  exactly one review, pinned to the reviewed commit. With no `write` or `bash`, prompt-injected PR
  text cannot alter that step or reach the gateway key.
- **Reviews the commit on disk.** When the PR's head has moved past the checked-out `head-sha` (a
  push mid-run, or re-running an old workflow), the run skips and the newer push's run reviews it.
- **Identity:** `github-token` (default `GITHUB_TOKEN`, `github-actions[bot]`) or an App via
  `app-client-id` / `app-private-key`. `GITHUB_TOKEN` can only approve when the repo enables
  *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*; without
  it an approval is posted as a comment and this identity's earlier "changes requested" is dismissed
  instead, so a fixed PR is never left blocked.
- **Trust model: same-repo PRs only.** Run it on `pull_request`, never on `pull_request_target` with
  the PR's code checked out. The agent can read its own environment, so a prompt-injected PR can get
  the gateway key into what the model sees. The runner redacts the key and the agent's token from the
  transcript, outputs and summary, and the post step refuses a body containing either, but a model
  can re-encode a value it has seen. Under `pull_request` that adds no exposure: fork PRs get no
  secrets, and a same-repo author can already read them by editing a workflow.
- **`mode: comment`** posts the same review as a plain comment that never approves or blocks.
- Repos can add `.github/pi/review.md` with what matters (and what to ignore) locally; the skill reads
  it along with `AGENTS.md`/`CLAUDE.md`. `dry-run: true` writes the planned review to the step
  summary instead.

## Issue triage and draft fixes

Two packaged sub-actions ship their own skills, so every repo gets the same behavior from a short
workflow. See [`examples/workflows/pi-issues.yml`](examples/workflows/pi-issues.yml).

| Action | When | What lands |
|---|---|---|
| `hank-warren/pi-action/issue-triage@v1` | A human opens an issue (or manual dispatch) | Existing labels, one triage comment edited in place, at most `max-new-issues` follow-up issues |
| `hank-warren/pi-action/issue-fix@v1` | A human adds `pi:fix` | A **draft** PR from `pi/issue-<n>` against the default branch, or a comment explaining why not |

The triage comment covers root cause with `file:line` evidence, which shipped `release/*` lines are
affected, related issues and PRs, a suggested fix, and a Mermaid diagram when a flow is worth drawing.
It ends with a fix-candidate verdict and suggests `pi:fix` for good candidates.

How the limits hold:

- **The agent never writes to GitHub.** It runs with a read-only App token and no push credentials,
  and leaves files in an output directory. A deterministic step applies them with a separately
  minted write token.
- **Draft only.** The apply step is the only thing that opens PRs, always with `draft: true`, and it
  verifies the result. Nothing in either action marks a PR ready. A developer reviews, takes over,
  and marks it ready; merging still needs code-owner approval.
- **No bloat.** Bot-created issues (Sentry, Dependabot, Pi's own follow-ups) are never triaged. Labels
  must already exist. Follow-ups are capped and never duplicate an open issue's title. One comment
  per issue per action, edited in place. At most one open Pi draft per issue.
- **Bounded fixes.** Changes over `max-changed-files` / `max-changed-lines`, binaries, or anything
  under `forbidden-paths` (default `.github/`) are refused with an explanation. The App has no
  `workflows` permission, so workflow edits cannot be pushed anyway.

Repos can add `.github/pi/triage.md` or `.github/pi/fix.md` with local guidance; the skills read
them, along with `AGENTS.md`/`CLAUDE.md`. `dry-run: true` on either action writes the planned result
to the step summary instead of GitHub.

Onboarding a repo: install your Pi App on it, give it `PI_APP_CLIENT_ID` / `PI_APP_PRIVATE_KEY`,
a `CLIPROXYAPI_API_KEY` secret and a `CLIPROXYAPI_BASE_URL` variable, create the `pi:fix` label (and optionally
`pi-draft` for the PRs), and add the workflow. The App needs issues and contents write; see
[docs/BOT-IDENTITY.md](docs/BOT-IDENTITY.md).

## Models and the gateway

Pi talks to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) through the
[`@hank-warren/pi-cliproxyapi-provider`](https://www.npmjs.com/package/@hank-warren/pi-cliproxyapi-provider)
extension, registered as provider `cpa`. There is no direct Anthropic or OpenAI path: the runner
clears ambient `ANTHROPIC_*`/`OPENAI_*` credentials, and `model` must be a gateway model
(`cpa/<id>`; a bare id gets the prefix). Claude models go out as native Anthropic Messages.

- **Key:** `cliproxyapi-api-key` is a CLIProxyAPI client key. Use one key per consumer so gateway
  usage is attributable.
- **URL:** `cliproxyapi-base-url` is required and has no default. GitHub-hosted runners need a
  publicly reachable endpoint (e.g. a Cloudflare tunnel); self-hosted runners can use an internal URL.
- **Context window** comes from the provider's model metadata. Claude Code's `[1m]` selector does not
  exist in pi and is rejected.

Before pi starts, the runner fetches the gateway's `/models` and seeds the extension's model
snapshot. A cold runner otherwise has no snapshot: the extension registers a placeholder and refreshes
in the background, which a one-shot run never waits for, so the model resolves as an unknown custom id
and Claude goes out over `openai-completions` instead of `anthropic-messages`. The same request fails
the step early, with a clear message, on a rejected key, an unreachable gateway, or a model the
gateway does not serve. CI checks that the pinned extension still reads the snapshot from the path
the runner writes.

## Inputs

| Input | Default | Description |
|---|---|---|
| `prompt` | — | Instruction text. Mutually exclusive with `prompt-file`. |
| `prompt-file` | — | Path to a file containing the prompt. |
| `skill` | — | Skill file or directory, **one path per line**. Ambient discovery is off; only these load. |
| `append-system-prompt` | — | Text appended to the system prompt. |
| `model` | `cpa/claude-opus-5-5` | Gateway model, `cpa/<id>` as listed by `/v1/models`. |
| `fallback-models` | — | Ordered fallback models, comma- or newline-separated. See [Model fallback](#model-fallback). |
| `thinking` | — | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `tools` | — | Comma-separated tool allowlist. Empty means Pi's default toolset. |
| `max-turns` | `25` | Assistant turn cap. Exceeding it **fails the step**. |
| `timeout-minutes` | `20` | Wall-clock limit. |
| `on-rate-limit` | `fail` | `fail` or `skip`. What to do when every gateway credential for the model is in quota cooldown. |
| `cliproxyapi-api-key` | — | **Required.** CLIProxyAPI client key. |
| `cliproxyapi-base-url` | — | **Required.** Gateway base URL, including `/v1`. |
| `app-client-id` | — | GitHub App Client ID. When set, the agent posts as `<app-slug>[bot]`. See [docs/BOT-IDENTITY.md](docs/BOT-IDENTITY.md). |
| `app-private-key` | — | GitHub App private key. Required with `app-client-id`. |
| `app-permission-contents` | `read` | Contents permission of the minted App token. Empty omits it. |
| `app-permission-issues` | `read` | Issues permission of the minted App token. Empty omits it. |
| `app-permission-pull-requests` | `write` | Pull requests permission of the minted App token. Empty omits it. |
| `github-token` | — | Explicit `GH_TOKEN` for the agent. Mutually exclusive with `app-client-id`. |
| `working-directory` | `.` | Directory the agent runs in. |
| `pi-version` | `1.1.0` | Pinned Pi version. |
| `provider-extension-version` | `0.4.0` | Pinned `@hank-warren/pi-cliproxyapi-provider` version. |
| `upload-transcript` | `true` | Upload the JSONL transcript as an artifact. |
| `transcript-name` | `pi-session` | Artifact name. |

## Outputs

| Output | Description |
|---|---|
| `result` | Final assistant message text. |
| `model-used` | The model that produced the result (or the last one tried). |
| `turns` | Assistant turns used. |
| `transcript` | Path to the raw JSONL transcript on the runner. |
| `rate-limited` | `true` when the run stopped because the gateway's credentials for the model (and every fallback) were in quota cooldown. |
| `bot-identity` | Login the agent posted as: `<app-slug>[bot]`, or `github-actions`. |

## Bot identity

Like `claude-code-action` posting as `claude[bot]`, this action posts as its own App, `<app-slug>[bot]`,
when given one:

```yaml
- uses: hank-warren/pi-action@v1
  with:
    app-client-id: ${{ vars.PI_APP_CLIENT_ID }}
    app-private-key: ${{ secrets.PI_APP_PRIVATE_KEY }}
```

The action mints the installation token itself and exposes it to the agent as `GH_TOKEN`, and sets
the agent's git author/committer to the bot. Without an App the agent uses the caller's `GH_TOKEN`
(`github-actions[bot]`), or pass `github-token` explicitly.

This matters once more than one agent submits **reviews**: GitHub tracks review state per identity,
and every workflow using `GITHUB_TOKEN` is the same identity, so verdicts overwrite each other and
the last job to finish wins. Comments are unaffected.

One-time setup is in [docs/BOT-IDENTITY.md](docs/BOT-IDENTITY.md); the exact App settings are
recorded in [`app-manifest.yml`](app-manifest.yml).

## Model fallback

```yaml
- uses: hank-warren/pi-action@v1
  with:
    model: cpa/claude-opus-5-5
    fallback-models: cpa/gpt-6.1-sol
    # ...
```

The action walks the chain `model`, then `fallback-models` in order:

- **Before running**, any model the gateway's `/models` does not list (disabled in CLIProxyAPI, or no
  usable credential) is skipped with a warning. The step fails only if no model in the chain is served.
- **After a run**, if it ended because the model could not answer, the next model gets a fresh run:

  | Gateway response | Meaning |
  |---|---|
  | `429 model_cooldown` | quota exhausted on every credential for the model |
  | `400 model_not_found` ("unknown provider for model") | the gateway cannot route the model |
  | `503 auth_unavailable` / `auth_not_found` ("no auth available") | no usable credential |

  Any other failure (turn cap, a different model error, a crash) ends the step without fallback.

Fallback restarts the task from scratch on the next model; it does not continue the previous model's
partial run. Keep posting as the skill's last step so a run that dies before it leaves nothing to
duplicate. `timeout-minutes` is one budget for all attempts, `max-turns` applies per attempt, and the
step summary lists what happened to each model. Each attempt's agent sees its bare model id as `PI_MODEL_ID` (e.g. `gpt-6.1-sol`), so a
skill can sign its output with the model that actually answered:
`*Automated review by Pi - $PI_MODEL_ID*`. The same skill and tools work across Claude
(`anthropic-messages`) and GPT (`openai-responses`) models; expect somewhat different output.

## Running out of quota

Quota exhaustion is not the same failure as a broken action, and a workflow that cannot tell them
apart teaches people to ignore red builds.

When every gateway credential for a model is cooling down, CLIProxyAPI answers 429 `model_cooldown`
("All credentials for model X are cooling down"); upstream subscription wording can also pass
through. Pi auto-retries a 429 (3 attempts with 2/4/8 s backoff), so exhaustion lands as the run's
final assistant message ending on that error. This action matches the wording on the run's **final**
error only: a 429 that a retry recovered from is not exhaustion. Retries are not agent turns and do
not spend `max-turns`, and quota is reported ahead of the timeout and turn cap, so a run killed while
waiting out a quota retry is reported as out of quota, not hung. The step summary shows the retry count.

With `on-rate-limit: skip` the step exits 0, emits a warning annotation, and sets
`rate-limited: true`:

```yaml
- uses: hank-warren/pi-action@v1
  id: pi
  with:
    on-rate-limit: skip
    # ...

- name: Note the skip
  if: steps.pi.outputs.rate-limited == 'true'
  run: gh pr comment "$PR" --body 'Automated review skipped — model quota exhausted.'
```

Detection is deliberately narrow: any other failure still fails the step, even under `skip`. That
includes a run whose last assistant message ended on a model error: pi exits 0 in that case, and the
action fails the step anyway.

## Isolation guarantees

Every run is invoked with discovery disabled and resources passed explicitly:

- `--no-extensions` + an explicit `--extension` for the gateway provider only
- `--no-skills` + explicit `--skill` paths (both flags preserve explicitly-passed paths)
- `--no-prompt-templates`, `--no-context-files`, `--no-mcp`, `--no-session`
- `PI_CODING_AGENT_DIR` pointed at a scratch directory, so no stored `~/.pi` state applies
- Gateway connection settings passed as `CLIPROXYAPI_*` env vars, which override any
  `pi-cliproxyapi-provider` config file on a self-hosted runner

## Migrating from claude-code-action

| claude-code-action | pi-action |
|---|---|
| `prompt` | `prompt` |
| `claude_args: --max-turns N` | `max-turns: N` |
| `claude_args: --model X` | `model: cpa/X` |
| `claude_args: --allowedTools` | `tools` |
| `anthropic_api_key` / `CLAUDE_CODE_OAUTH_TOKEN` | `cliproxyapi-api-key` |
| `github_token` | `github-token` |
| Claude GitHub App (`claude[bot]`) | `app-client-id` + `app-private-key` (`<app-slug>[bot]`) |
| built-in PR comment posting | do it in the skill, via `gh` |

The last row is the real work in a migration. `claude-code-action` posts PR comments and reviews
natively; here the skill does it explicitly with the `gh` CLI. More verbose, more auditable, and the
posting behavior is reviewed as markdown alongside everything else.

## Known gaps

- **Gateway is a single point of failure.** A CLIProxyAPI or tunnel outage fails every run. Keep
  agent jobs out of required checks until that is acceptable.
- **Tunnel timeout.** Cloudflare returns 524 when a proxied request sends no response bytes for
  ~100 s. Pi streams, so this only bites a stalled upstream; self-hosted runners can use an internal
  URL to avoid the edge.
- **Pinned versions are load-bearing.** Bump `pi-version` and `provider-extension-version`
  deliberately; CI fails a provider bump that moves the snapshot path.

## Development

```bash
node --check runner.mjs
```

CI runs a syntax check, an action.yml wiring check, the gateway-only env guard and the provider
snapshot contract check on every push. The end-to-end smoke test is `workflow_dispatch` only, because
it spends real quota.
