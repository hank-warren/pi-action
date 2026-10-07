# Review guidance for pi-action

This repo is a set of composite GitHub Actions (`action.yml`, `issue-triage/`, `issue-fix/`,
`pr-review/`) around one zero-dependency Node runner (`runner.mjs`). Other repos pin it by tag, so a
regression ships to every consumer on the next tag move.

Blocking, in this repo:

- **Expression injection.** `${{ inputs.* }}`, `${{ github.event.* }}` or step outputs interpolated
  directly into a `run:` script. Untrusted values must reach scripts through `env:`.
- **Credential exposure.** The gateway key or a GitHub token reaching the agent when it should not,
  appearing in logs or step summaries, or `runner.mjs` setting `ANTHROPIC_*`/`OPENAI_*` credentials.
  Agents in `issue-triage`, `issue-fix` and `pr-review` must never hold a write token.
- **Wiring drift.** A `PI_ACTION_*` variable the runner reads that some `action.yml` does not pass,
  or `pi-version` / `provider-extension-version` defaults that differ between actions.
- **Apply-step limits.** Anything that lets agent output bypass the deterministic limits: draft-only
  PRs, existing labels only, capped follow-up issues, one review per run, paths escaping `$PI_OUT`.
- **Exit semantics.** A path where the runner exits 0 on a real failure, or fails on quota exhaustion
  under `on-rate-limit: skip`.

Not blocking: README wording, example workflows, comment phrasing.
