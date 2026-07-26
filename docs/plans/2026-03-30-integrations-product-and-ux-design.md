# Integrations Product And UX Design

Date: 2026-03-30
Status: Draft
Owner: Holaboss desktop/runtime

## Purpose

Define the product shape for a first-class Integrations management center in Holaboss.

This document covers:

- the user-facing information architecture
- the relationship between catalog, connected accounts, and workspace bindings
- the OSS versus managed-hosted product split
- the expected flows for connecting, selecting, and troubleshooting integrations

This document does not define the low-level runtime APIs or credential broker mechanics. Those are covered in the engineering design document.

## Problem

Today integrations exist mostly as app-specific behavior. Gmail, GitHub, Twitter, Sheets, and similar modules declare integration needs in `app.runtime.yaml`, but users do not have one clear place to:

- discover what integrations exist
- connect an external account
- understand whether a workspace app is actually ready
- fix auth failures before an agent tries a tool call

This creates two product problems:

1. the system feels fragile because errors surface late, often during a tool call
2. the commercial story is unclear because "integration support" is mixed together with "managed OAuth and hosted account handling"

## Product Principles

### 1. Separate availability from management

An integration should not be considered "business-only" if the real paid value is hosted auth and operational convenience.

The product should distinguish:

- `available in OSS with self-managed credentials`
- `available in managed mode with hosted auth`

### 2. Make connection state visible before tool execution

Users should be able to see whether Gmail or GitHub is connected before an agent attempts to send a message or open a repo.

### 3. One UI, multiple backends

The desktop UI should look the same in OSS and managed deployments. The difference should be in the connection backend and setup steps, not in the visible product structure.

### 4. Workspace context matters

A user may connect multiple accounts for the same provider. The system must support choosing which account a workspace, app, or agent should use.

## Proposed Information Architecture

Create a top-level `Integrations` management surface with four tabs.

### Discover

This is the catalog view. It should resemble the style of the reference marketplace screenshot: searchable cards, grouped by category, with a quick action on each item.

Each card should show:

- provider icon
- provider name
- short capability summary
- category
- availability badge:
  - `Self-managed`
  - `Managed`
  - `Managed recommended`
- state badge:
  - `Not connected`
  - `Connected`
  - `Needs setup`
  - `Needs re-auth`

Primary actions:

- `Connect`
- `Manage`
- `Learn setup`

### Connected

This is the connected accounts view. It is user-centric, not workspace-centric.

Each row should show:

- provider
- account label such as `owner@holaboss.ai`
- scopes summary
- last connected / refreshed time
- health state
- mode:
  - `Hosted`
  - `Self-managed`
  - `Manual token`

Actions:

- `Reconnect`
- `Disconnect`
- `Set default`
- `View usage`

### Workspace Bindings

This is the most important operational screen. It answers: which account will this workspace actually use?

The view should support:

- workspace default provider bindings
- per-app overrides
- per-agent overrides later

Example rows:

- `gmail app -> Google / owner@holaboss.ai`
- `github app -> GitHub / holaboss-bot`
- `default google -> Google / owner@holaboss.ai`

Actions:

- `Choose account`
- `Use workspace default`
- `Override`
- `Clear binding`

### Developer

This tab is especially important for OSS.

It should expose:

- custom OAuth app configuration
- callback URL and redirect diagnostics
- manual token import for supported providers
- provider setup guides
- local broker / state diagnostics

This is where OSS users should feel empowered, not blocked.

## Primary User Flows

### Flow 1: Connect From Catalog

1. User opens `Integrations > Discover`
2. User finds Gmail
3. User clicks `Connect`
4. The product offers the supported auth modes:
   - `Hosted auth` if available
   - `Bring your own OAuth app`
   - `Manual token` if supported
5. On success, the new account appears under `Connected`
6. If the current workspace contains a Gmail app or a Google-dependent app, the product offers `Bind to this workspace`

### Flow 2: Agent Encounters Missing Binding

1. Agent tries to use `gmail_send_draft`
2. The product sees that Gmail exists but no valid binding is available
3. Instead of only surfacing a tool failure, the UI opens a structured prompt:
   - `Gmail is not connected for this workspace`
   - `Connect account`
   - `Choose existing account`
4. After resolution, the agent can retry

### Flow 3: Multi-Account Selection

1. User has two GitHub accounts connected
2. In `Workspace Bindings`, the user chooses one for a specific workspace
3. A different workspace can use a different GitHub connection

## OSS Versus Managed Product Split

The split should be framed as backend capability, not feature denial.

### OSS

OSS should support:

- local integration catalog
- local connection store
- self-managed OAuth apps
- manual tokens for suitable providers
- local broker-backed execution
- workspace bindings

OSS should not promise:

- official hosted OAuth for every provider
- team-wide connection governance
- hosted secret management
- enterprise audit and policy controls

### Managed / Business

Managed mode should add:

- official hosted OAuth apps
- one-click connection flows
- automatic token refresh handled by Holaboss infrastructure
- team-shared accounts and admin controls
- audit trails
- centralized connection health and policy enforcement

### Product Messaging

Do not say:

- "simple integrations are free, complex ones are paid"

Prefer:

- "self-managed integrations are available in OSS"
- "managed integrations provide hosted auth, easier setup, and team administration"

That language makes the paid tier feel like an operational upgrade rather than a lockout.

## UX Requirements For Error Handling

Integration problems should be classified and surfaced in product terms, not raw provider terms.

Examples:

- `Gmail not connected`
- `Google connection expired`
- `Workspace is bound to an invalid GitHub account`
- `Twitter requires managed auth or a custom OAuth app`

Every error state should offer a direct next action:

- `Connect`
- `Reconnect`
- `Choose account`
- `Open developer setup`

## Suggested MVP Scope

### MVP providers

- GitHub
- Gmail
- Google Sheets

### MVP screens

- Discover
- Connected
- Workspace Bindings

### MVP auth modes

- self-managed token
- self-managed OAuth app
- managed auth where available

### Deferred

- per-agent bindings
- org/team binding policies
- usage analytics
- advanced provider capability matrices

## External Product References

This design borrows the following ideas:

- marketplace-style discovery and install actions from the reference screenshot
- connected account abstraction, multiple account support, and auth mode separation inspired by Composio

Useful references:

- <https://composio.dev/>
- <https://docs.composio.dev/docs/auth-configuration/connected-accounts>
- <https://docs.composio.dev/docs/authentication>
- <https://docs.composio.dev/tool-router/managing-multiple-accounts>

## Decision Summary

- Build a first-class Integrations management center.
- Split the UI into Discover, Connected, Workspace Bindings, and Developer.
- Support OSS through self-managed credentials and local broker behavior.
- Sell managed auth and operational convenience, not basic integration existence.
- Make missing connection and binding issues visible before tool execution, not only after tool failure.
