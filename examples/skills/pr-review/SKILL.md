---
name: pr-review
description: Review the current pull request and post a single consolidated review comment.
---

# PR review

You are reviewing one pull request. Work read-only against the checkout, then post exactly one
comment. Do not push commits, do not approve, do not request changes.

## Gather context

```bash
gh pr view "$PR_NUMBER" --json title,body,files
gh pr diff "$PR_NUMBER"
```

## What to look for

Report only findings you can point at a specific file and line for. In priority order:

1. **Correctness** — logic errors, unhandled failures, broken invariants.
2. **Security** — injection, authz gaps, secrets in code or logs.
3. **Data safety** — destructive migrations, unbounded queries, missing transactions.
4. **Tests** — behavior changed without a test covering it.

Skip style, formatting, and naming. Linters own those.

## Output

Post one comment. If there are no findings worth raising, say so in one line — do not manufacture
nits to look thorough.

```bash
gh pr comment "$PR_NUMBER" --body-file review.md
```

Structure `review.md` as:

```markdown
## Automated review

**Verdict:** <one line>

### Findings
- `path/to/file.py:42` — what is wrong and why it matters.

### Notes
- Optional. Non-blocking observations.
```

If you post nothing, the run has failed at its job. Always post.
