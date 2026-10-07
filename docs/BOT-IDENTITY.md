# Bot identity — one-time setup

By default the agent posts as `github-actions[bot]`, because it uses the caller's `GITHUB_TOKEN`.
That is fine for a single commenting workflow. It breaks down in two specific ways:

1. **Review state collapses per reviewer.** GitHub tracks review state per *identity*, and every
   workflow using `GITHUB_TOKEN` authenticates as the same repository Actions app. Two agents that
   both submit reviews are one reviewer, so the later verdict silently overwrites the earlier one.
   The winner is whichever job happens to finish last.
2. **Attribution is ambiguous.** With Claude and Pi both posting as `github-actions[bot]`, telling
   their output apart means reading comment bodies.

Comments are unaffected — they are independent objects and never collapse. This only matters once
something submits a review with `APPROVE` or `REQUEST_CHANGES`.

The display name is the App's slug: an App named `acme-pi` posts as `acme-pi[bot]`. App names are
global across GitHub; `pi-action` and `pi` are both taken, so prefix yours with your org or user name.
The client secret is unused.

## One-time setup

Do this once per org or user account. Every repo afterwards is one variable, one secret and two inputs.

### 1. Create the App

**Settings → Developer settings → GitHub Apps → New GitHub App** on the owning org or user account.

Use exactly the settings in [`app-manifest.yml`](../app-manifest.yml):

| Field | Value |
|---|---|
| Name | e.g. `acme-pi` (produces `acme-pi[bot]`) |
| Homepage URL | `https://github.com/hank-warren/pi-action` (or your own) |
| Webhook | **Uncheck Active** — this App never receives events |
| Repository permissions → Pull requests | **Read and write** |
| Repository permissions → Contents | **Read and write** |
| Repository permissions → Issues | **Read and write** |
| Repository permissions → Metadata | Read-only (mandatory) |
| Where can this be installed | Only on this account |

Grant nothing else, and in particular not **Workflows**: without it GitHub rejects any push that
touches `.github/workflows/`, whatever the token.

The App's grant is a ceiling, not what each job gets. Every token is minted scoped down to the job:

| Job | Contents | Issues | Pull requests |
|---|---|---|---|
| Root action (reviews), default | read | read | write |
| `issue-triage` agent / apply step | read / — | read / write | read / — |
| `issue-fix` agent / apply step | read / write | read / write | read / write |
| `pr-review` agent / post step | read / read | read / — | read / write |

The agent in `issue-triage` and `issue-fix` only ever holds the read-only token. Writes happen in a
separate deterministic step after the agent exits, which is what guarantees Pi PRs are always drafts.
Changing the App's permissions makes GitHub ask an org owner to approve the new grant on the
installation; until then, tokens requesting the new permissions fail to mint.

Optionally upload an avatar on the App page; it is what shows next to `<app-slug>[bot]` on every comment.

### 2. Install it

**Install App** on the owning account, and select the repositories that will run agent workflows (at least
`pi-action` itself, for the smoke test). Add repos here as you onboard them — no per-repo App
configuration is needed.

### 3. Store the Client ID and a private key

On the App page, note the **Client ID** (`Iv23…`; not secret) and **Generate a private key**, which
downloads a `.pem` once. Keep it in your secrets manager, then set org-level values scoped to
selected repositories:

```bash
gh variable set PI_APP_CLIENT_ID --org <org> \
  --visibility selected --repos pi-action --body 'Iv23...'
gh secret set PI_APP_PRIVATE_KEY --org <org> \
  --visibility selected --repos pi-action < path/to/key.pem
```

Add repos to `--repos` as you onboard them. On a user account there are no account-level secrets:
set both per repository with `gh variable set` / `gh secret set -R <owner>/<repo>`.

## Per-repo onboarding

Two inputs:

```yaml
- uses: hank-warren/pi-action@v1
  with:
    app-client-id: ${{ vars.PI_APP_CLIENT_ID }}
    app-private-key: ${{ secrets.PI_APP_PRIVATE_KEY }}
    # ... prompt, skill, cliproxyapi-api-key as usual
```

The action mints a short-lived installation token scoped to `github.repository_owner`
(`actions/create-github-app-token@v3`) and exposes it to the agent as `GH_TOKEN`, so every `gh`
call inside the skill is attributed to `<app-slug>[bot]`. It also sets the agent's git author and committer
to `<app-slug>[bot]` with the App's noreply address, so any commit links to the App. The caller needs no
`GH_TOKEN` env and no `actions/create-github-app-token` step.

Omit both inputs and the agent uses the caller's `GH_TOKEN` env (`github-actions[bot]`), or pass
`github-token` explicitly. `github-token` and `app-client-id` are mutually exclusive.

The `bot-identity` output reports the login used (`<app-slug>[bot]`, or `github-actions`), for assertions
in smoke tests.

## What this does not buy you

**An App's approval still does not satisfy branch protection.** Required approving reviews are
satisfied by CODEOWNERS or human reviewers; a bot that is not a code owner does not count, whichever
identity it wears: bot `APPROVED` reviews leave `reviewDecision=REVIEW_REQUIRED`.

`REQUEST_CHANGES` **does** block, and a bot generally cannot dismiss its own stale blocking review —
dismissal needs permissions the review workflow does not hold. So every false positive becomes a
human interrupt. Give an agent blocking power only after its precision is measured, and scope it to
findings that genuinely warrant stopping a merge.

For reference, GitHub Copilot's own code review is comment-only: it never approves and never
requests changes.
