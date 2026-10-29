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
| `changelog-release.yml` | Changelog-driven npm release: stamps `[Unreleased]`, tags, cuts a GitHub Release, syncs the staging branch and dispatches the caller's `publish.yml`. Used by prefab and mcp-http. |
| `python-check.yml` | ruff + pytest under uv across a Python version matrix. |
| `pyproject-version.yml` | Reads the `pyproject.toml` version and reports whether it is already tagged. The PyPI upload stays in the caller, since trusted publishing rejects reusable workflows. |
| `d1-backup.yml` | Exports D1 databases to gzipped SQL in the `d1-backups` R2 bucket (35-day expiry), one folder per database. See [Restoring a D1 backup](#restoring-a-d1-backup). |

Both `check.yml` and `publish-package.yml` take `runtime: npm` (default) or `runtime: bun`,
for a package whose suite cannot run under node.

`publish-package.yml` also takes `gate: false` for a caller that runs its own gate job, and
`install: none` or a custom install command for a package without a lockfile or with an
`.npmrc` that reads `${GITHUB_TOKEN}`.

Max-Health-Inc's **public** repositories call these too, because Max-Health-Inc/.github is
private and GitHub only lets private repositories use a private repository's workflows.

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
  workflow token, and uses whichever the registry actually answers.
- **A public repository cannot call a reusable workflow from a private one**, even inside the
  same org. That is why this repository is public.
- **`cache: npm` on `setup-node` fails without a lockfile**, so it is disabled under
  `runtime: bun`.

## Releasing a package

Releasing means **bumping the version in your PR**. A merge to `main` publishes whatever
`package.json` says. A merge whose version is already on the registry publishes nothing and
says so in the run summary, so a docs- or CI-only merge stays green.
