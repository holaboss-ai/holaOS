# Gmail Memory Architecture

## What exists today

Gmail integration memory is implemented as one global integration tree per connected Gmail account. The tree is keyed by `provider + owner_user_id + account_key`, where the Gmail fetch path resolves `account_key` to the mailbox email when `GMAIL_GET_PROFILE` returns one.

This tree is not workspace-local. Its semantic node files live under the global memory root at:

```text
memory/semantic/integration/trees/<tree-slug>/
```

Leaf evidence files are still persisted separately under:

```text
memory/integration/trees/<tree-slug>/
```

A workspace can see that tree when the Gmail connection is active and the workspace-level integration overrides do not hide or repin it. Explicit `integration_bindings` are used for tool routing, but they do not gate memory visibility or memory retrieval.

## Fetch entrypoints

The current Gmail memory pipeline can start from three places:

1. A connection becoming active triggers `onConnectionActive`, which immediately starts a context fetch for supported providers.
2. `POST /api/v1/integrations/context-fetch` starts or dedupes a fetch for a specific `connection_id`.
3. The integration autofetch worker rechecks active connections on a schedule and starts a new fetch when `contextCronAutoFetchEnabled` is true and the connection is due.

Current autofetch defaults:

- poll interval: 60 seconds
- schedule interval: 30 minutes

Progress is tracked in-memory by `integration-context-fetch-manager.ts` and exposed through `GET /api/v1/integrations/context-fetch`.

## Ingestion pipeline

The Gmail fetch implementation is provider-specific and currently does the following:

1. Call `GMAIL_GET_PROFILE`.
2. Resolve the durable account identity from `emailAddress` when available.
3. Persist a profile leaf on branch `profile`.
4. Call `GMAIL_LIST_THREADS` with `max_results = 100`.
5. For each returned thread, call `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`.
6. Page through the full thread if Composio returns a `nextPageToken`.
7. Persist one leaf per Gmail message on branch `messages`, grouped under a per-thread entity.
8. Rebuild the semantic integration tree and semantic relations.

The current fetch path passes only `embeddingClient: null` into `rebuildIntegrationTree(...)`. That means the live Gmail fetch builds deterministic semantic-node summaries immediately, but it does not create embeddings during the fetch itself.

## Leaf model

### Account profile leaf

- `subject_key`: `profile`
- `branch_key`: `profile`
- `branch_label`: `Profile`
- `source_type`: `gmail.profile`
- `external_object_type`: `gmail_profile`

This leaf stores mailbox-level metadata such as total messages, total threads, history id, and the resolved account email.

### Message leaf

- `subject_key`: `message:<gmail-message-id>`
- `entity_key`: `thread:<thread-id>`
- `entity_label`: the message subject
- `branch_key`: `messages`
- `branch_label`: `Messages`
- `source_type`: `gmail.message`
- `external_object_type`: `gmail_message`

Each message leaf stores a normalized markdown snapshot with the sender, recipient, thread id, labels, received time, and snippet.

The tag set starts with `gmail` and `message`, then adds one tag per Gmail label in the form `label:<label-id>`.

## Logical tree shape

The logical tree shape for one account looks like this:

```text
<gmail connection>
- Profile
  - Gmail profile for <account>
- Threads
  - <thread subject A>
    - Messages
      - <message 1>
      - <message 2>
  - <thread subject B>
    - Messages
      - <message 3>
- Contacts
  - <contact email>
    - related to thread references
```

The runtime also materializes semantic contact nodes and semantic `participant` relations from contacts to related threads.

## Persistence behavior

The shared integration-memory persistence layer applies these rules:

- one tree per `(provider, owner_user_id, account_key)`
- exact body fingerprint duplicate: no new leaf
- same `subject_key` with changed content: create a new active leaf and supersede the previous one
- leaf bodies are stored as markdown evidence files and indexed in `integration_leaves`
- semantic nodes, containment edges, and semantic relations are rebuilt after the fetch finishes

One Gmail-specific detail: the current Gmail fetch does not retire entities or messages that fall out of the latest fetch window. It is effectively a recent-thread snapshot plus dedupe/supersession, not a full mailbox reconciliation pass.

## Retrieval and visibility

After rebuild, Gmail memory is surfaced through:

- `integration_trees`, `integration_leaves`
- `semantic_memory_nodes`, `semantic_memory_edges`, and `semantic_memory_relations`
- Settings -> Memory browser / graph
- `memory_retrieve`, via the combined workspace memory retrieval layer

Because the live fetch path does not write embeddings, initial retrieval depends on lexical scoring plus the semantic containment tree.

## Current limits and gaps

- The fetch window is capped at the 100 most recent threads returned by `GMAIL_LIST_THREADS`.
- The pipeline stores message metadata and snippets, not full decoded message bodies.
- The profile leaf records Gmail `historyId`, but the current implementation does not use `GMAIL_LIST_HISTORY` or maintain an incremental sync cursor.
- There is no Gmail-specific reconciliation pass that retires old thread/message leaves when they are no longer returned by the snapshot window.

## Key source files

- `runtime/api-server/src/integration-context-fetch.ts`
- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/integration-context-fetch-manager.ts`
- `runtime/api-server/src/integration-context-autofetch-worker.ts`
- `runtime/api-server/src/workspace-integration-visibility.ts`
- `runtime/state-store/src/store.ts`
