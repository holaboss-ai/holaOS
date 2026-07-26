# Memory Quality Rubric

This rubric evaluates whether the workspace memory system meets the expected baseline:

- a user can chat for a while
- the agent can use integration tools
- the user can attach files
- important durable things retain concrete detail
- memories land in sensible places
- related entities and artifacts are discoverable
- retrieval finds the same memory from multiple relevant angles

The system is MD-backed. Markdown files remain the canonical memory artifacts, while the runtime DB stores derived graph structure such as semantic nodes, edges, evidence refs, and relations.

## Scoring

Each category is scored:

- `0`: weak or failing
- `1`: partial or mixed
- `2`: strong

Total possible: `20`

Interpretation:

- `18-20`: baseline met strongly
- `15-17`: good, but still has important gaps
- `11-14`: promising, not baseline-ready
- `0-10`: structurally inadequate

## Hard-Fail Conditions

The evaluated slice fails the baseline even if the numeric score is decent when any of these are true:

1. Important new memories are still clipped.
2. Request-shaped junk is still commonly persisted.
3. Non-trivial memories often have zero useful relations.
4. Artifact-backed evidence is not first-class for the source type in question.
5. Retrieval cannot find a memory from related entities or artifact names.

## Categories

### 1. Content Fidelity

Question: does the stored memory preserve the important detail?

Pass:

- names, orgs, systems, dates, IDs, thresholds, contacts, titles, account numbers, file names, and key claims are intact
- no meaningful detail is replaced by `...`
- evidence is specific enough to reconstruct why the memory matters

Fail:

- clipped summaries or evidence
- generic paraphrases where the original contained concrete detail
- memory content too thin to be useful later

### 2. Durable Admission

Question: should this have been remembered at all?

Pass:

- durable facts, references, blockers, procedures, decisions, or stable preferences are kept
- one-off requests and ephemeral execution state are excluded

Fail:

- request-shaped junk like `User asked to ...`
- temporary state, generic task prompts, or trivial restatements get persisted

### 3. Primary Placement

Question: does the memory land in the right primary home?

Pass:

- a clear section or entity like `Projects`, `Systems`, `Preferences & Rules`, `Knowledge`, `People`, or `Processes`
- `uncategorized` is used only as a real fallback

Fail:

- default sink behavior
- obviously wrong owner
- broad topic is used because the system could not decide

### 4. Artifact Backing

Question: if the memory came from an attachment, tool result, or deliverable, is the source artifact first-class?

Pass:

- the source artifact exists as its own document tree
- text is chunked and searchable when applicable
- the artifact is independently retrievable

Fail:

- the memory only stores a summary of the artifact
- no first-class source artifact exists
- the artifact name is mentioned but not persisted structurally

### 5. Provenance

Question: can the system trace where the memory came from?

Pass:

- evidence refs exist
- integration-derived memories carry provider and account provenance
- artifact-derived memories link back to the source artifact or deliverable
- turn and input lineage is preserved

Fail:

- provenance is weak or missing
- the source is only implied in markdown text

### 6. Relation Quality

Question: does the memory connect to the right related things?

Pass:

- related entities are meaningful
- relation types are useful
- targets resolve to real nodes when one exists
- non-trivial memories have more than one useful relation

Fail:

- zero relations for memories that clearly reference people, orgs, systems, or artifacts
- junk entities such as `topic:topic` or `artifact:artifact`
- unresolved placeholders when a real node exists
- the relation vocabulary exists but produces low-value edges

### 7. Relation Consistency

Question: do similar memories get similar relation treatment?

Pass:

- sibling memories from the same artifact or run resolve entities and artifacts the same way
- the same kind of source data gets the same relation richness

Fail:

- one memory links to a real artifact node while a sibling only points to a synthetic placeholder
- normalization varies across near-identical cases

### 8. Duplicate Enrichment

Question: when the same fact shows up again, does the memory improve?

Pass:

- the existing memory gains evidence, relations, or stronger detail
- the system avoids unnecessary duplicate leaf explosion

Fail:

- later mentions no-op without enrichment
- duplicates proliferate or the existing memory stays thin

### 9. Retrieval Coverage

Question: can the same memory be found from all relevant angles?

Pass:

- retrievable by fact wording
- retrievable by related person, org, system, or topic
- retrievable by artifact or deliverable name
- retrievable by provider or account when relevant

Fail:

- only retrievable by exact owner-tree wording
- related-entity or artifact queries miss it
- provenance-aware recall does not materially help

### 10. Graph Surface Quality

Question: does the memory browser and pane expose the structure meaningfully?

Pass:

- the user can see the primary home
- the user can inspect evidence and provenance
- related entities and relations are visible
- relation links are navigable

Fail:

- the graph exists but hides the important structure
- relations are present only in the DB and not in the product surface
- provenance is technically stored but not inspectable

## Priority Weighting

If the baseline is evaluated according to current product priorities, these categories should be weighted most heavily:

1. `Relation Quality`
2. `Relation Consistency`
3. `Artifact Backing`
4. `Retrieval Coverage`
5. `Content Fidelity`

If these are weak, the memory system should be scored down even when placement and provenance are otherwise decent.

## Practical Use

Use this rubric in three ways:

1. Evaluate a real workspace snapshot such as `mem-test-1`.
2. Evaluate a new implementation slice before calling it complete.
3. Compare old and new memory generations to see whether a backfill or rebuild materially improved quality.
