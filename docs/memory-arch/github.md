# GitHub Memory Architecture

## What exists today

GitHub integration memory is implemented as one global integration tree per connected GitHub account. Tree identity is derived from `provider + owner_user_id + account_key`, where the GitHub fetch path resolves `account_key` from the authenticated user's `login` when available.

The semantic tree is stored under the global memory root, not inside a workspace-local `.holaboss/memory` directory:

```text
memory/semantic/integration/trees/<tree-slug>/
```

Leaf evidence files are still persisted separately under:

```text
memory/integration/trees/<tree-slug>/
```

A workspace can retrieve and browse that tree when the corresponding GitHub connection is active and visible under workspace integration overrides.

## Fetch entrypoints

The GitHub memory pipeline is started by the same shared integration fetch system used by Gmail and Notion:

1. connection activation
2. `POST /api/v1/integrations/context-fetch`
3. scheduled autofetch when `contextCronAutoFetchEnabled = true`

The fetch manager dedupes in-flight runs per connection and exposes status through `GET /api/v1/integrations/context-fetch`.

## Ingestion pipeline

The current GitHub fetch path is explicitly repository-centric:

1. Call `GITHUB_GET_THE_AUTHENTICATED_USER`.
2. Persist the GitHub profile leaf.
3. Try `GITHUB_LIST_NOTIFICATIONS` with:
   - `all: false`
   - `participating: true`
   - `per_page: 50`
4. Discover repositories, preferring direct proxy access when available:
   - `GET /user/repos?type=owner&sort=updated&direction=desc&per_page=12`
   - fallback: `GET /users/<login>/repos?...`
   - fallback: `GITHUB_FIND_REPOSITORIES`
5. For each discovered repo:
   - fetch README with `GITHUB_GET_A_REPOSITORY_README`
   - persist repo overview
   - persist README when present
   - fetch open pull requests with `GITHUB_LIST_PULL_REQUESTS` limited to 10
   - fetch open issues with `GITHUB_LIST_REPOSITORY_ISSUES` limited to 10
6. Retire repo-scoped leaves whose repository entity is no longer in the latest discovered repo set.
7. Rebuild the semantic integration tree.

Like the other live integration fetches, this path rebuilds the tree with `embeddingClient: null`, so the immediate result is deterministic semantic-node summaries with no embeddings.

## Leaf model

### Account profile leaf

- `subject_key`: `profile`
- `branch_key`: `profile`
- `branch_label`: `Profile`
- `source_type`: `github.profile`
- `external_object_type`: `github_profile`

This leaf stores the authenticated user's login, name, email, public repo count, followers, following, and profile URL.

### Repository overview leaf

- `subject_key`: `repository:<owner>/<repo>`
- `entity_key`: `repo:<owner>/<repo>`
- `branch_key`: `overview`
- `branch_label`: `Overview`
- `source_type`: `github.repository`

This is the base repo identity leaf for a repository entity.

### README leaf

- `subject_key`: `readme:<owner>/<repo>`
- `entity_key`: `repo:<owner>/<repo>`
- `branch_key`: `readme`
- `branch_label`: `README`
- `source_type`: `github.readme`

The README content is decoded from base64 when necessary and clipped before persistence.

### Notification leaf

- `subject_key`: `notification:<notification-id>`
- `entity_key`: `repo:<owner>/<repo>` when repository metadata exists
- `branch_key`: `notifications`
- `branch_label`: `Notifications`
- `source_type`: `github.notification`

### Pull request leaf

- `subject_key`: `pull:<owner>/<repo>:<number>`
- `entity_key`: `repo:<owner>/<repo>`
- `branch_key`: `pull_requests`
- `branch_label`: `Pull requests`
- `source_type`: `github.pull_request`

### Issue leaf

- `subject_key`: `issue:<owner>/<repo>:<number>`
- `entity_key`: `repo:<owner>/<repo>`
- `branch_key`: `issues`
- `branch_label`: `Issues`
- `source_type`: `github.issue`

## Logical tree shape

The logical shape for one GitHub account looks like this:

```text
<github connection>
- Profile
  - GitHub profile for <account>
- Repositories
  - <owner>/<repo A>
    - Overview
      - <owner>/<repo A>
    - README
      - <owner>/<repo A> README
    - Pull requests
      - <repo A> #<n>: <title>
    - Issues
      - <repo A> #<n>: <title>
    - Notifications
      - <notification title>
  - <owner>/<repo B>
    - ...
```

The semantic shape is fixed by provider structure rather than by a separate summary-node tree.

## Persistence and reconciliation behavior

Shared persistence rules still apply:

- exact fingerprint duplicate: no-op
- same `subject_key` with changed content: create new active leaf and supersede the old one
- markdown bodies are stored as evidence files and indexed in `integration_leaves`
- semantic nodes, containment edges, and semantic relations are rebuilt after each fetch

GitHub adds one important reconciliation step: after repo discovery finishes, the runtime retires every active leaf whose `entity_key` starts with `repo:` but is not present in the latest discovered repository set.

That means current GitHub memory is bounded by the current repo discovery window. In practice:

- only the discovered owner repos are kept active
- repo-scoped notifications, README leaves, PR leaves, and issue leaves disappear when their repo is no longer in the fetched repo set
- if repo discovery returns an empty set, repo-scoped leaves are retired

## Failure handling

The GitHub fetch path is intentionally tolerant of partial upstream failures:

- missing notifications tool: fetch continues
- forbidden notifications call: fetch continues
- missing README: repo overview still persists
- forbidden README / PR / issue subcalls: repo overview still persists

Repository discovery is the one structurally important step because later retirement uses its result.

## Retrieval and visibility

After rebuild, GitHub memory is surfaced through the same integration-memory stack as other providers:

- visible integration trees for the workspace
- Memory browser tree and graph
- `semantic_memory_nodes`, `semantic_memory_edges`, and `semantic_memory_relations`
- `memory_retrieve` through the combined workspace memory retrieval layer

Because the live fetch path does not generate embeddings, retrieval initially relies on lexical matching and the semantic containment tree.

## Current limits and gaps

- notifications: max 50, participating only
- repositories: max 12 owner repos
- pull requests: max 10 open PRs per repo
- issues: max 10 open issues per repo
- README persistence is best-effort and skipped on not-found / forbidden responses
- the current design is repo-window-based, not a full-account historical mirror
- repo retirement is tied to the latest discovery response, so the fetch behaves more like a refreshed working set than an append-only archive

## Key source files

- `runtime/api-server/src/integration-context-fetch.ts`
- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/integration-context-fetch-manager.ts`
- `runtime/api-server/src/integration-context-autofetch-worker.ts`
- `runtime/api-server/src/workspace-integration-visibility.ts`
- `runtime/state-store/src/store.ts`
