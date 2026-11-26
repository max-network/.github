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
| `deploy-worker.yml` | Install, gate, migrate D1 and `wrangler deploy` one environment of an npm Worker, stamped with its build version. `release: true` tags production with release notes. See [Deploying a Worker](#deploying-a-worker). |
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

`check.yml` and `deploy-worker.yml` take `cache-path` (and `cache-key`, default `check`), the
same inputs as Max-Health-Inc's check workflow: paths restored after the install and saved after
the gate, for a tool that validates its own incremental state, such as vitest's `fsModuleCache`
and its results file (which runs the slowest files first). One path per line, relative to the
repository root:

```yaml
    with:
      cache-path: |
        node_modules/.vitest-cache
        node_modules/.vite/vitest
```

Use one `cache-key` in both callers so a deploy and a pull request share the entries their
branches can reach.

On a pull request `check.yml` also checks the lockfile it installs from (`package-lock.json`
for npm, `bun.lock` for bun, or the one the custom `install` names). It fails when the
dependencies in `package.json` changed but that lockfile did not, and it warns about any
other lockfile in the directory, since CI never reads it and it drifts. A dependency bump made
with the other installer is what broke legal-web's beta deploy on 2026-11-11.

`publish-package.yml` also takes `gate: false` for a caller that runs its own gate job. `prerelease: beta` publishes `<version>-beta.<UTC yyyymmddHHMM>.<short sha>` under the `beta` dist-tag instead of the release, untagged, and the workflow's `version` output names what it published, for a caller that deploys that exact build. A
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

`note` appends a line to the body (what merging triggers, for instance). `refresh-body: true`
rewrites the open PR's body on every push with the commits ahead and the time of the update;
without it the body is written once, when the PR opens. Both work from any org, since this
repository is public. The PR is opened with the workflow token, so its `pull_request` checks
wait for approval; an App token would avoid that.

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

## Version PR

`.github/actions/version-pr` records a version in a JSON file of another repository as a pull
request, for a deploy or pin that should be a reviewed, revertable line in git. Each version gets
its own branch under `branch-prefix`; a re-run reuses it, and older open pull requests under the
same prefix are closed as superseded, so merging a stale one cannot roll anything back. Nothing is
opened when the base branch already records the version. It calls the REST API with the `token`
you pass, so mint that token for the target repository's org; it works across orgs.

```yaml
- uses: max-network/.github/.github/actions/version-pr@main
  with:
    token: ${{ steps.target-token.outputs.token }}
    repository: acme/deployments
    file: versions.json
    field: appVersion
    version: ${{ inputs.version }}
    branch-prefix: release/
```

## Deploying a Worker

One caller per environment, so beta and production share every step:

```yaml
name: deploy-prod
on:
  push:
    branches: [main]
concurrency:
  group: prod
  cancel-in-progress: false
jobs:
  deploy:
    permissions:
      actions: read
      contents: write
      packages: read
    uses: max-network/.github/.github/workflows/deploy-worker.yml@main
    with:
      environment: Production
      wrangler-env: production
      d1-database: my-database
      release: true
    secrets: inherit
```

The beta caller is the same on `test` with `wrangler-env: beta`, `contents: read` and no `release`.
`working-directory` points at a worker outside the repository root, `check` names the gate's
package scripts (default `check`), and `pre-deploy` runs a command with the Cloudflare
credentials before the migrations.

The gate uses the same [verified tree](#verified-tree) key as `check.yml` with `runtime: npm`
and `install: auto`, so a tree that `check.yml` or an earlier deploy already passed with the same
scripts deploys without running them again: the push to `main` that merges the promotion pull
request skips the gate its `test` deploy ran. Grant `actions: read` in the caller's job
permissions; without it the lookup misses and the gate runs as before. A skipped gate writes
nothing, so anything the deploy ships must come from `wrangler deploy` itself (its
`build.command`) or from git, never from a file the gate built. A staging push and the
promotion pull request it updates start at the same moment, so give both callers' jobs the same
`concurrency` group, e.g. `gate-${{ github.event.pull_request.head.sha || github.sha }}` with
`cancel-in-progress: false`: the second one waits for the first and then finds its record.

Versions come from `@max-health-inc/config/vite/release`, which the worker lists as a dev
dependency. The checkout keeps full history and tags, so beta deploys as a pre-release of the
next tag (`0.1.5-beta.202611161200.abc1234`) and production as the release
(`0.1.4+202611161200.abc1234`). The version reaches the code as `__APP_VERSION__` through
`wrangler deploy --define`; read it with a guard so tests and `wrangler dev` still run:

```ts
declare const __APP_VERSION__: string | undefined;
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
```

`release: true` runs `release-tag prepare` before a production deploy from `production-branch`,
which writes AI release notes into an annotated `vX.Y.Z` tag, and `release-tag publish` after
it, which pushes the tag and creates the GitHub release. The notes use `RELEASE_NOTES_TOKEN`
(a Cloudflare token with Workers AI) and fall back to the deploy token; without a working token
the tag is still cut, without notes. A repository that already uses `v*` tags for something
else must not set `release`.

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
