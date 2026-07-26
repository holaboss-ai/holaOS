# Web Search Tool — Implementation Spec

## Goal

Ship an official native `web_search` tool in the Pi harness that follows the same hosted-search path we validated externally:

- no API key required
- one stable agent-facing tool name
- direct request to the hosted Exa MCP endpoint
- raw Exa text output returned to the model

This replaces the earlier local provider-abstraction plan for now.

## Current Design

### Tool surface

The harness exposes a single native custom tool:

- `web_search`

### Input contract

```json
{
  "query": "string",
  "num_results": 8,
  "max_results": 8,
  "livecrawl": "fallback | preferred",
  "type": "auto | fast | deep",
  "context_max_characters": 10000
}
```

Notes:

- `query` is required.
- `num_results` is the primary count parameter.
- `max_results` is accepted as a compatibility alias.
- `livecrawl`, `type`, and `context_max_characters` map directly to the hosted backend request.

### Output contract

The tool returns the raw text block from the hosted search response.

Example shape:

```text
Title: Example result
URL: https://example.com/article
Published: 2026-04-03T10:00:00.000Z
Author: Example Author
Highlights:
Relevant excerpt text

---

Title: Next result
...
```

The harness does not normalize or reshape this text further.

## Backend Contract

### Endpoint

- `POST https://mcp.exa.ai/mcp`

### Request shape

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "web_search_exa",
    "arguments": {
      "query": "latest AI news 2026",
      "numResults": 8,
      "livecrawl": "fallback",
      "type": "auto",
      "contextMaxCharacters": 10000
    }
  }
}
```

### Response handling

- Accept `application/json, text/event-stream`
- Parse the SSE stream
- Read the first `data:` payload containing a text content block
- Return that text block directly as tool output
- Surface HTTP failures and backend error messages directly

## Why This Design

This path optimizes for:

- immediate search quality from a stronger backend
- no local crawler or ranking stack to maintain
- no API-key onboarding burden
- parity with the external implementation pattern we chose to copy

## Explicit Non-goals

- no local provider abstraction
- no self-hosted search backend
- no local result normalization, URL canonicalization, or dedupe
- no reranking or enrichment pipeline
- no structured JSON result envelope

## Capability and Registration Notes

- `web_search` is staged as a native Pi custom tool
- it is included in the capability manifest as a `custom_tool`
- it is enabled by default for Pi runs through the staged extra-tools set

## Future Follow-ups

If this path proves too lossy for downstream reasoning, the first extension should be additive rather than replacing the raw output contract:

1. add a separate native `web_fetch` tool for retrieving chosen URLs
2. optionally attach lightweight metadata alongside the raw text
3. only reintroduce structured shaping if the raw hosted format becomes a practical limitation
