# max-network/.github

Shared, reusable GitHub Actions workflows for the Max Network org. Mirrors the
`Max-Health-Inc/.github` convention.

## Why this exists

CI definitions were the single largest duplication hotspot in the org. `publish.yml`
existed in seven repos at 63–98% similarity, `checks.yml` and `auto-pr.yml` in several
more. Several of those copies even documented themselves as mirrors of one another.

The copies had drifted in **behaviour**, not just wording:

- `worker-utils`, `billing`, `text-search` and `i18n` publish on a merge to `main`.
- `hono-ui`, `mcp-oauth` and `hono-cms-core` published only from a GitHub Release, which
  is the exact bug the other four repos' comments describe having fixed. The fix was
  applied four times by copy-paste and three repos were missed, so a merged version bump
  in those three sat unpublished until someone cut a release by hand.
- Publish auth diverged too. `mcp-oauth`'s workflow records a v0.7.0 release 401'ing on
  `GH_PACKAGES_TOKEN`, a repo secret that is not set there.

One definition means one place to fix each of those.

## Workflows

| Workflow | Purpose |
| --- | --- |
| `publish-package.yml` | Build, gate and publish an `@max-network` package to GitHub Packages. Skips cleanly when the version is already on the registry. |
| `check.yml` | The PR quality gate. Called directly on `pull_request` and reused by a repo's publish workflow so both run the identical suite. |
| `auto-pr.yml` | Keeps a standing promotion PR open from the staging branch to `main`. |

## Using them

A package repo needs three small caller files.

`.github/workflows/check.yml`:

```yaml
name: Check
on:
  pull_request:
  workflow_call:
jobs:
  check:
    uses: max-network/.github/.github/workflows/check.yml@main
    with:
      steps: "typecheck test build"
    secrets: inherit
```

`.github/workflows/publish.yml`:

```yaml
name: Publish to GitHub Packages
on:
  push:
    branches: [main]
    tags: ["v*"]
  release:
    types: [published]
  workflow_dispatch:
concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false
jobs:
  publish:
    uses: max-network/.github/.github/workflows/publish-package.yml@main
    with:
      check-steps: "check"
      tag-release: true
    secrets:
      packages-token: ${{ secrets.GH_PACKAGES_TOKEN }}
```

`.github/workflows/auto-pr.yml`:

```yaml
name: Auto PR
on:
  push:
    branches: [develop]
jobs:
  promote:
    uses: max-network/.github/.github/workflows/auto-pr.yml@main
    with:
      head-branch: develop
    secrets: inherit
```

## Releasing a package

Releasing means **bumping the version in your PR**. A merge to `main` publishes whatever
`package.json` says. A merge whose version is already on the registry publishes nothing and
says so in the run summary, so a docs- or CI-only merge stays green.

## A note on org boundaries

These workflows are for Max Network repos. Max Health products have their own shared
workflows in `Max-Health-Inc/.github`; the two orgs are kept separate on purpose.
