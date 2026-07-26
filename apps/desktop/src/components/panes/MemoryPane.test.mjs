import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./MemoryPane.tsx", import.meta.url);

test("memory pane loads node detail and surfaces provenance plus related graph context", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(
    source,
    /const \[selectedNodeDetail, setSelectedNodeDetail\] =\s*useState<MemoryBrowserNodeDetailResponsePayload \| null>\(null\);/,
  );
  assert.match(
    source,
    /const loadNodeDetail = useCallback\(\s*async \(node: MemoryBrowserGraphNodePayload \| null\) => \{/,
  );
  assert.match(source, /const MEMORY_GRAPH_MAX_LAYERS = 6;/);
  assert.match(source, /const MEMORY_GRAPH_MAX_NODES = 320;/);
  assert.match(
    source,
    /window\.electronAPI\.workspace\.readMemoryBrowserNodeDetail\([\s\S]*workspaceId,[\s\S]*nodeId: node\.id,[\s\S]*treeId: node\.tree_id,[\s\S]*\)/,
  );
  assert.match(
    source,
    /window\.electronAPI\.workspace\.listMemoryBrowserGraph\([\s\S]*workspaceId,[\s\S]*forest: "workspace",[\s\S]*maxLayers: MEMORY_GRAPH_MAX_LAYERS,[\s\S]*maxNodes: MEMORY_GRAPH_MAX_NODES,[\s\S]*\)/,
  );
  assert.match(
    source,
    /const handleSelectGraphNodeById = useCallback\(\s*\(nodeId: string \| null\) => \{/,
  );
  assert.match(
    source,
    /findGraphNodeForPath,\s*isNavigableMemoryRelationTarget,\s*parseMemoryRelatedSections,\s*resolveParsedRelatedEntities,\s*resolveParsedRelatedRelations,/,
  );
  assert.match(
    source,
    /const matchedGraphNode = findGraphNodeForPath\(graph\?\.nodes, targetPath\);/,
  );
  assert.match(
    source,
    /setSelectedGraphNodeId\(matchedGraphNode\?\.id \?\? null\);/,
  );
  assert.match(
    source,
    /if \(matchedGraphNode\) \{\s*void loadNodeDetail\(matchedGraphNode\);\s*\} else \{\s*setSelectedNodeDetail\(null\);\s*\}/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(!graph \|\| !selectedPath \|\| selectedGraphNodeId \|\| selectedNodeDetail\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /const matchedGraphNode = findGraphNodeForPath\(graph\.nodes, selectedPath\);/,
  );
  assert.match(
    source,
    /setSelectedGraphNodeId\(matchedGraphNode\.id\);\s*void loadNodeDetail\(matchedGraphNode\);/,
  );
  assert.match(source, /Evidence & provenance/);
  assert.match(source, /Connects to/);
  assert.match(source, /Referenced by/);
  assert.match(source, /relationResolutionBadgeClass/);
  assert.match(source, /relationResolutionLabel/);
  assert.match(source, /isNavigableMemoryRelationTarget/);
  assert.match(source, /Related entities/);
  assert.match(source, /parseMemoryRelatedSections\(selectedFile\.content\)/);
  assert.match(
    source,
    /buildRelatedTargetResolution\(\{\s*graphNodes: graph\?\.nodes,\s*outgoingRelations: selectedNodeDetail\?\.outgoing_relations,\s*\}\)/,
  );
  assert.match(
    source,
    /resolveParsedRelatedEntities\(\s*relatedTargetResolution,\s*selectedFileRelatedInfo\.entities,\s*\)/,
  );
  assert.match(
    source,
    /selectedNodeDetail\.evidence_refs\.length > 0\s*\|\|\s*selectedNodeDetail\.outgoing_relations\.length > 0\s*\|\|\s*selectedNodeDetail\.incoming_relations\.length > 0/,
  );
  assert.match(
    source,
    /relation\.target_label \?\? relation\.target_entity_key \?\? relation\.target_node_id/,
  );
  assert.match(
    source,
    /relation\.target_resolution_kind/,
  );
  assert.match(
    source,
    /relation\.source_label \?\? relation\.source_node_id/,
  );
  assert.match(
    source,
    /if \(!isNavigableMemoryRelationTarget\(relation\.target_resolution_kind\)\) \{\s*return \(\s*<div[\s\S]*relationContent[\s\S]*<\/div>\s*\);\s*\}/,
  );
  assert.match(
    source,
    /onClick=\{\(\) => handleSelectGraphNodeById\(relation\.target_node_id\)\}/,
  );
  assert.match(
    source,
    /onClick=\{\(\) => handleSelectGraphNodeById\(relation\.source_node_id\)\}/,
  );
  assert.match(
    source,
    /<Badge[\s\S]*relation\.target_resolution_kind[\s\S]*Referenced by|Referenced by[\s\S]*<Badge[\s\S]*relation\.target_resolution_kind/s,
  );
  assert.match(
    source,
    /onClick=\{\(\) => handleSelectGraphNodeById\(entity\.nodeId\)\}|onClick=\{\(\) => handleSelectGraphNodeById\(relation\.nodeId\)\}/s,
  );
  assert.match(
    source,
    /resolveParsedRelatedRelations\(\s*relatedTargetResolution,\s*selectedFileRelatedInfo\.relations,\s*\)/,
  );
  assert.match(
    source,
    /entity\.targetResolutionKind|relation\.targetResolutionKind/s,
  );
  assert.match(
    source,
    /!entity\.navigable\s*\|\|\s*!entity\.nodeId|!relation\.navigable\s*\|\|\s*!relation\.nodeId/s,
  );
});
