# max-network/.github

Shared, reusable GitHub Actions workflows for the Max Network org.

## Why this exists

CI definitions were the single largest duplication hotspot in the org: the publish
workflow existed in seven repositories at 63–98% similarity, and the check and auto-PR
workflows in several more. Some of those copies even documented themselves as mirrors of
one another.

The copies had drifted in **behaviour**, not just wording. Some published on a merge to
`main` while others published only from a GitHub Release — so in the second group a merged
version bump sat unpublished until someone noticed and cut a release by hand. That fix was
applied by copy-paste and several repositories were missed. Publish authentication had
diverged the same way.

One definition means one place to fix each of those.

## Workflows

| Workflow | Purpose |
| --- | --- |
| `publish-package.yml` | Build, gate and publish a package. Defaults to GitHub Packages; set `registry` to publish to public npm. Skips cleanly when the version is already on the registry. |
| `check.yml` | The PR quality gate. Called directly on `pull_request` and reused by a repo's publish workflow so both run the identical suite. |
| `auto-pr.yml` | Keeps a standing promotion PR open from the staging branch to `main`. |
| `changelog-release.yml` | Changelog-driven npm release: stamps `[Unreleased]`, tags, cuts a GitHub Release, syncs the staging branch and dispatches the caller's `publish.yml`. Runs `scripts/changelog.ts` from this repository, and refuses a release or staging sync that changes an already released section. Used by prefab and mcp-http. |
| `changelog-guard.yml` | PR check that every released `CHANGELOG.md` section still matches the base branch. |
| `python-check.yml` | ruff + pytest under uv across a Python version matrix. |
| `pyproject-version.yml` | Reads the `pyproject.toml` version and reports whether it is already tagged. The PyPI upload stays in the caller, since trusted publishing rejects reusable workflows. |
| `d1-backup.yml` | Exports D1 databases to gzipped SQL in the `d1-backups` R2 bucket (35-day expiry), one folder per database. See [Restoring a D1 backup](#restoring-a-d1-backup). |
| `retry-transient.yml` | Reruns a failed run's failed jobs when every one of them died on a network or outage error (a 5xx from GitHub or a registry, a reset connection, a lost runner), waiting 1, 2, 3, then 4 minutes between attempts. A failing test is never retried. See [Retrying transient failures](#retrying-transient-failures). |

Both `check.yml` and `publish-package.yml` take `runtime: npm` (default) or `runtime: bun`,
for a package whose suite cannot run under node.

Both also take `install: none` or a custom install command, for a package without a lockfile,
with an `.npmrc` that reads `${GITHUB_TOKEN}`, or tested under bun with a package-lock
(`runtime: bun` plus `install: npm ci`). `publish-package.yml` passes it on to its gate.

`check.yml` takes `working-directory` (default `.`) for a repository whose package is not at
its root, such as a worker in `worker/`. The install and every step run there. The directory
joins the verified-tree key only when it is not `.`, so existing callers keep their records.

`publish-package.yml` also takes `gate: false` for a caller that runs its own gate job. A
version lower than the registry's `latest` is published under `backport-dist-tag` (default
`legacy`), so a backport never moves `latest` to an older line.

Max-Health-Inc's **public** repositories call these too, because Max-Health-Inc/.github is
private and GitHub only lets private repositories use a private repository's workflows.

## Changelog script

`scripts/changelog.ts` (bun, node built-ins only, so public callers need no registry token):

- `--check <version>` prints `promoted`, `present` or `missing` and writes nothing.
- `<version> [date]` stamps `## [Unreleased]` as the version, keeps a fresh `[Unreleased]` with
  an anchor comment directly under it, and maintains the Keep a Changelog compare links.
- `--verify <ref>` fails when a released section differs from `<ref>`.

The anchor comment makes a release merge-back conflict instead of filing new entries under the
version that just shipped; `--verify` catches the cases where git still merges silently.

## Using them

A package repo needs four small caller files.

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
name: Publish
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false
# A reusable workflow cannot hold MORE permission than its caller, and a repository whose
# default is `read` then fails at STARTUP with no job and no log.
permissions:
  contents: write
  packages: write
  id-token: write
jobs:
  publish:
    uses: max-network/.github/.github/workflows/publish-package.yml@main
    with:
      check-steps: "check"
      tag-release: true
    secrets: inherit
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

`.github/workflows/retry.yml`:

```yaml
name: Retry transient failures
on:
  workflow_run:
    workflows: ["**"]
    types: [completed]
permissions:
  actions: write
  contents: read
jobs:
  retry:
    if: github.event.workflow_run.conclusion == 'failure'
    uses: max-network/.github/.github/workflows/retry-transient.yml@main
```

## Retrying transient failures

`workflow_run` only fires for workflow files on the default branch, so `retry.yml` takes effect
once it is on `main`. It then watches every workflow in the repository, itself excluded.

`scripts/transient-failure.sh` reads `gh run view --log-failed` and decides per failed job. It
only trusts `##[error]` lines and the error lines npm, pnpm and bun print for a failed fetch,
because a test that exercises an outage logs the same words as a real outage. One failed job
without a transient cause leaves the whole run for a person.

## Verified tree

`.github/actions/verified-tree` records that a git tree passed a gate (`mode: record`, as the
gate's last step) and finds the record again (`mode: lookup`, as its first). A pull request, the
push that merges it, the promotion pull request and the push to `main` usually carry the same
tree, so the gate runs once instead of up to four times. The record is an artifact named after
the tree and a hash of `key`; only runs of the repository itself count, never a fork's. The
lookup needs `actions: read`; without it the lookup misses and the gate simply runs.

## Setup Bun

`.github/actions/setup-bun` (`bun-version`, or `bun-version-file` for package.json's `packageManager`,
`.bun-version` or `.tool-versions`) runs `oven-sh/setup-bun` and, when GitHub cannot serve the release
download, installs the same build from the npm registry (`@oven/bun-<os>-<arch>`). Use it
instead of `oven-sh/setup-bun` in every workflow: on 2026-11-08 GitHub's release downloads
answered 504 for over an hour, longer than any retry backs off, while npm served Bun throughout.

## Backing up a D1 database

```yaml
name: D1 backup
on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:
jobs:
  backup:
    uses: max-network/.github/.github/workflows/d1-backup.yml@main
    with:
      databases: '["my-database"]'
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

The token needs D1 read and R2 write. The bucket and its 35-day lifecycle rule exist once per
account (`wrangler r2 bucket create d1-backups`, then
`wrangler r2 bucket lifecycle add d1-backups expire-after-35-days --expire-days 35`).

### Restoring a D1 backup

A database that answers every query with `internal error` cannot restore itself, and Time
Travel goes through the same broken API. Restore into a new database instead:

```sh
wrangler r2 object get d1-backups/<db>/<timestamp>.sql.gz --file dump.sql.gz --remote
gunzip dump.sql.gz
wrangler d1 create <db>-restored --location <region>
wrangler d1 execute <db>-restored --remote --file dump.sql
```

Then point the worker's `database_id` at the new database and deploy through the normal
branch flow. Anything written after the backup is lost, so prefer waiting on Cloudflare when
the outage is short.

## Gotchas these workflows already paid for

- **No expressions in `permissions:`.** `contents: ${{ inputs.x && 'write' || 'read' }}` fails
  at startup with no job, no log, and only "this run likely failed because of a workflow
  file issue". Scope the elevated permission to its own job instead.
- **`A && B || C` is not a ternary.** It returns `C` whenever `B` is *falsy*, and an empty
  string is falsy. `cache: ${{ inputs.runtime == 'bun' && '' || 'npm' }}` therefore always
  selected `npm`, and `${{ x && secrets.MAYBE_UNSET || secrets.OTHER }}` silently selects
  `OTHER` when the first secret is absent — which is how a missing npm token became a 404
  about a missing package. Only use the idiom when the true-value is itself truthy;
  otherwise use two steps with an `if:`, or decide in shell where empty is just empty.
- **A reusable workflow cannot exceed its caller's permissions.** If the calling repository's
  default workflow permission is `read`, a called job asking for `packages: write` fails the
  same silent way. Declare `permissions` in the caller.
- **Secret names cannot contain hyphens.** A `workflow_call` secret with a hyphen in its name
  parses in an expression as subtraction rather than a name. The value silently becomes
  garbage and npm returns 401. Callers use `secrets: inherit` and the workflow reads the
  secret directly.
- **A workflow that only triggers on push to `main` is not exercised by the PR that adds it.**
  Dispatch it manually against a branch before wiring repos to it.
- **Neither publish credential works everywhere.** GitHub Packages' npm registry takes a
  classic PAT, and for some repositories that is the only thing it accepts, while for others
  the workflow token is. `publish-package.yml` tries the PAT first, falls back to the
  workflow token, and uses whichever the registry actually answers. Installs go through
  `.github/actions/install`, which does the same: it retries with the workflow token only when
  the registry refused the PAT. A green install can also hide a missing grant, because
  `cache: npm` serves tarballs without asking the registry until the lockfile changes.
- **A public repository cannot call a reusable workflow from a private one**, even inside the
  same org. That is why this repository is public.
- **`cache: npm` on `setup-node` fails without a lockfile**, so it is disabled under
  `runtime: bun`.

## Releasing a package

Releasing means **bumping the version in your PR**. A merge to `main` publishes whatever
`package.json` says. A merge whose version is already on the registry publishes nothing and
says so in the run summary, so a docs- or CI-only merge stays green.
