# AI Coding Agent Instructions

## DQL - Dynatrace Query Language

Before writing any DQL query, the agent must always use the knowledge base (`get_dql_knowledgebase` tool) to search for relevant DQL documentation, syntax, and examples, whenever the tool is available.

## UI Components - Strato

Before using any Strato UI component, the agent must always use the knowledge base tools to search for relevant component documentation and usage examples, whenever the tools are available:

- Use the `list_strato_components` tool to search for available Strato components by name or keyword.
- Use the `get_strato_component` tool to retrieve detailed documentation, props, and code examples for a specific component.
- Use the `get_strato_usecases` tool to get code for specific component use cases and patterns.

## Build Quality Rules

- **Important**: Use Strato Design System components wherever possible!
- **Important**: `npm run build` must pass without errors!
- **Important**: `npm run lint` must pass without errors!

## Project Overview

This repository contains a **Dynatrace App** built with the Dynatrace App Toolkit "dt-app", running on **Dynatrace AppEngine**. Use the **App Toolkit** during development and CI (`dt-app dev`, `dt-app build`, `dt-app deploy`, `dt-app publish`).

## Core Concepts

### Dynatrace Apps

- UI is **TypeScript/React** using **Strato Design System** components for consistent Dynatrace UX.
- Backend logic runs inside the **Dynatrace JavaScript runtime**. Let the app execute backend code, primarily to call external URLs (e.g., third‑party APIs) that shouldn't be invoked directly from the browser.
- Apps can use **Intents** for cross-app communication
- Apps can provide **Actions** and **Widgets** to extend Dynatrace.

### Grail

- **Grail** stores observability data (logs, metrics, events, traces, business events).
- **DQL** is used to query Grail.

### DQL (Dynatrace Query Language)

DQL is a **pipeline-style query language** for Grail: you start with a data source (e.g., `fetch logs` or `timeseries` for metrics), then add pipe‑separated commands like `filter`, `summarize`, `sort`, and `makeTimeseries` to transform and aggregate results. Typical patterns include counting events, building time series, and grouping by dimensions (e.g., host or status).

### Platform Services

A set of services are available to Dynatrace Apps to read and write data. Every service provides a typescript **client sdk** to interact with it. Common services include:

- **Grail Query Service**: Query Dynatrace Grail data using DQL. Prefer using the `useDql` React hook from `@dynatrace-sdk/react-hooks` in UI code, but the low‑level client `@dynatrace-sdk/client-query` is also available.
- **Document Service** (a.k.a. document store): CRUD API for storing **app-generated, user-created content** such as dashboards and notebooks. Protected by IAM; each document lives in the context of an SSO user. Supports sharing and optional history/snapshots. Apps can also ship **ready-made documents**. Use `@dynatrace-sdk/client-document` to interact with it.
- **(User) App State Service**: Store and retrieve user‑specific or app‑specific key/value data. Used for caching or user preferences. Use `@dynatrace-sdk/client-state` to interact with it.

## Strato Design System

The **Strato Design System** is Dynatrace's official design system and component library. It provides React components, design tokens (colors, borders, shadows), and icons to build consistent UIs that align with Dynatrace's look and feel.

Available packages:

- `@dynatrace/strato-components` — React component library. Includes stable primitives (Button, ProgressBar, ProgressCircle, Skeleton, SkeletonText, AppRoot, Container, Divider, Flex, Grid, Surface, Heading, Link, List, Paragraph, Strikethrough, Strong, Text, TextEllipsis) as well as Charts (TimeseriesChart, HistogramChart, HoneycombChart, SingleValue, PieChart, ...), Content (Accordion, Chip, HealthIndicator, MessageContainer, ...), Editors (CodeEditor, DQLEditor), Filters (FilterBar, FilterField, SegmentSelector, TimeframeSelector), Forms (Checkbox, Radio, Select, Switch, TextInput, ...), Layouts (AppHeader, HelpMenu, InputGroup, Page, TitleBar), Navigation (AppLink, Breadcrumbs, Menu, Tabs), Overlays (Modal, Overlay, Sheet, Tooltip), Tables (DataTable, SimpleTable)
- `@dynatrace/strato-design-tokens` — design tokens (colors, spacing, typography) for consistent styling.
- `@dynatrace/strato-geo` — map visualization primitives.
- `@dynatrace/strato-icons` — Strato icon library.

### Working with Table components

When using table components from Strato, prefer `DataTable` from `@dynatrace/strato-components/tables` for advanced features like sorting, filtering, pagination, and selection. Use `SimpleTable` for basic tabular data without interactivity, mostly used for Markdown rendering.

Table API:

- Tables require the `data` and `columns` props
- Column definitions must include `id`, `header`, and `accessor` (string path or function)

### Importing Strato Components

When importing Strato components, follow these guidelines to ensure optimal bundle size and performance:

1. **Never** import from `@dynatrace/strato-components` package root
2. **Always** import from the specific category subdirectory (e.g., `/layouts`, `/typography`, `/tables`)
3. **Wrong**: `import { Flex, Heading } from "@dynatrace/strato-components";`
4. **Correct**:

   ```typescript
   import { Flex } from "@dynatrace/strato-components/layouts";
   import { Heading } from "@dynatrace/strato-components/typography";
   ```

**TypeScript Definitions**: All Strato packages have TypeScript definitions located directly in the package root under each component folder. For example:

- `node_modules/@dynatrace/strato-components/forms/select/Select.d.ts` - Main Select component
- `node_modules/@dynatrace/strato-components/forms/select/SelectOption.d.ts` - Select.Option component
- Pattern: `node_modules/@dynatrace/strato-components/<category>/<component>/<Component>.d.ts`

**Important**: Always check the `.d.ts` files directly in `node_modules/@dynatrace/strato-components/` to understand component APIs. Do NOT look for a separate `types/` subdirectory.

## Client SDKs

Dynatrace provides TypeScript client SDKs to interact with platform services. Each service has its own package, for example: `@dynatrace-sdk/client-query`, `@dynatrace-sdk/client-document`, `@dynatrace-sdk/client-state`. Those packages are autogenerated from the service OpenAPI specs and have the following characteristics:

- Exported clients to call service endpoints, eg. `queryClient` or `documentClient`.
- Example:

  ```typescript
  const result = await queryClient.queryExecute({ body: { query: 'fetch logs | count' }});
  ```

**Important**: Prefer using the higher‑level React hooks from `@dynatrace-sdk/react-hooks` in UI code, as they encapsulate state management, polling, and error handling.

## Other SDKs

- React hooks — `@dynatrace-sdk/react-hooks`: React hooks for DQL (useDql), documents, app state, settings and other platform services. Prefer using these in UI code. Request and response types match the low‑level client SDKs. Example:

  ```typescript
  const { data, error, isLoading } = useDocument({ id: documentId });
  ```

-- Common React Hooks:
--- `useDql(query: string)` - Execute DQL queries
--- `useDocument({ id: string })` - Fetch a single document
--- `useListDocuments(params)` - List all documents (requires `document:documents:read` scope)
--- `useAppState({ key: string })` and `useUserAppState({ key: string })` - Read app (user) state
--- `useSetAppState()` and `useSetUserAppState()` - Write app (user) state. Returns an execute function.
--- `useAppFunction({ name: string, data: any })` - Call backend functions
-- All update/set/POST hooks return an execute function that you can call to perform the action.

- Units & formatting — `@dynatrace-sdk/units`: Convert values to human‑readable strings (e.g., bytes → KiB/MB) and ensure consistent unit formatting across UI and functions.
- App Environment — `@dynatrace-sdk/app-environment`: Read app/environment context (IDs, URLs, current user) directly in the app
- User Preferences — `@dynatrace-sdk/user-preferences`: Retrieve the logged‑in user's theme, language, regional format, and timezone to adapt UI/formatting. Can not be used to store custom user settings. Use the App State service for that.

## Development Workflow

### Commands

```bash
npm run start            # Start dev server with hot reload (opens browser automatically)
npm run build            # Compile and bundle the app into dist/
npm run deploy           # Build and deploy to the environment in app.config.json
npm run lint             # Run ESLint across the entire project
npm run create:function  # Scaffold a new backend function (Dynatrace JS runtime)
npm run create:action    # Scaffold a new Action (extends Dynatrace platform actions)
npm run update           # Update dt-app and SDK dependencies to latest compatible versions
```

### Configuration

- **App Metadata**: `app.config.json` defines app name, ID, version, and required scopes
- **Environment URL**: Set `environmentUrl` in `app.config.json` to target Dynatrace environment
- **Scopes**: Add required permissions to `app.config.json` `scopes` array (e.g., `storage:logs:read`, `document:documents:read`, `document:documents:write`, `state:app-states:read`, `state:app-states:write`)

## Source Structure

```text
app.config.json              # App metadata: name, ID, version, environmentUrl, scopes
package.json                 # npm scripts and dependencies
eslint.config.mjs            # ESLint flat config (security + Strato import rules)
ui/
  main.tsx                   # React app entry point (ReactDOM.createRoot)
  tsconfig.json              # TypeScript config for UI code
  app/
    App.tsx                  # Root component: router setup and route definitions
    components/
      Header.tsx             # Top nav bar: app title and navigation links
    pages/
      Home.tsx               # "/" route — landing page
      Data.tsx               # "/data" route — DQL query example
  assets/                    # Static images and SVGs bundled with the app
```

## ESLint Enforcement

ESLint is configured in `eslint.config.mjs` using the flat config format. The following rules cause **CI failures** (set to `"error"`) and must not be violated:

- **No root Strato imports** — importing directly from `@dynatrace/strato-components` or `@dynatrace/strato-design-tokens` package roots is blocked. Always import from the specific subcategory path:

  ```typescript
  // Wrong — fails lint
  import { Flex } from "@dynatrace/strato-components";
  // Correct
  import { Flex } from "@dynatrace/strato-components/layouts";
  ```

- **No secrets** — `eslint-plugin-no-secrets` scans all source files for hardcoded credentials. A custom regex additionally detects Dynatrace API tokens (`dt0[a-zA-Z]{1}[0-9]{2}.\.[A-Z0-9]{8,24}\.[A-Z0-9]{64}`). Never commit tokens or keys.

- **No eval** — `no-eval` is enabled. Dynamic code execution is forbidden.

- **No deprecated APIs** — `@typescript-eslint/no-deprecated` flags calls to deprecated SDK methods or Strato component APIs.

**File-specific rule sets:**

| File pattern | Notes |
| --- | --- |
| `**/*.ts`, `**/*.tsx` (excluding `.action.*`, `.widget.*`, `.test.*`) | Full strict rule set including type-checked TypeScript rules |
| `**/*.action.ts`, `**/*.widget.tsx` | Same base rules; unsafe TypeScript access rules downgraded to warnings to accommodate the Dynatrace JS runtime environment |

Run `npm run lint` locally before pushing to catch violations early.

## Common Tasks

- **Add Route**: Update `Routes` in [ui/app/App.tsx](ui/app/App.tsx) and add nav item to [ui/app/components/Header.tsx](ui/app/components/Header.tsx)
- **Query Data**: Use `useDql` hook with DQL query string (Dynatrace Query Language)
- **Style Components**: Import from `@dynatrace/strato-design-tokens/{colors,borders,box-shadows}` for design tokens

## Application topology dashboard

The app in `ui/app/` is a four-column topology map: RUM applications → Services → Kubernetes pods →
Infrastructure. [ui/app/hooks/useTopologyData.ts](ui/app/hooks/useTopologyData.ts) owns every query;
[ui/app/components/TopologyGraph.tsx](ui/app/components/TopologyGraph.tsx) owns the SVG.

**Read [docs/dynatrace-query-notes.md](docs/dynatrace-query-notes.md) before touching a query.** It
records platform behaviour that produces wrong numbers or empty results *without raising an error* —
silent permission failures, the 1000-record default, `scalar: true` semantics, the two entity models,
and the `smartscapeNodes`/`smartscapeEdges` traps. Each entry there cost a debugging cycle.

### Division of sources

| Concern | Source |
| --- | --- |
| Node inventory and rates | Metrics (`timeseries`) |
| Relationships between tiers | Smartscape (`smartscapeNodes` / `smartscapeEdges`) |
| Problems and impacted entities | `dt.davis.problems` (**not** `dt.davis.events`) |

No query reads raw spans or `user.events`. Both were removed: they do not scale (see
`JOIN_RIGHT_TABLE_SIZE` in the notes) and Smartscape covers the same relationships more completely.
Reintroducing a raw-record scan should be a deliberate decision, not a convenience.

### The map is not the tiles

The tiles count **inventory** — every entity in the tenant. The map draws **relationships**, which
only exist where a traced path reached. On one tenant that is 419 pods against 1 the map can draw.
The two numbers are meant to differ; do not "fix" one to match the other.

The map anchors instead of ranking each column independently. Anchors are the top services, or the
selected node when there is one; other columns show what the anchors reach, ordered by where their
nearest already-placed neighbour sits. Ranking columns independently produced a map with almost no
edges, because the busiest services and the busiest hosts are different entities.

### Working rules for this app

- **Verify DQL against the live environment before shipping.** The notes explain how to run queries
  with the token in `.dt-app/.tokens.json`. A query that compiles is not a query that is correct.
- **Bump `app.config.json` version before every deploy** — versions are immutable.
- **`npm run build` and `npm run lint` must pass.**
- When a count disagrees with a Dynatrace app, compare against that app's own view before changing
  the query. Several past "bugs" were the dashboard measuring something different, not incorrectly.
- Queries report errors **per query** (`errors` from the hook), so one failure does not blank the
  page. Keep that when adding queries.
- **Caps are silent.** Every query has an entry in `QUERY_CAPS`; a result sitting on its cap raises
  the truncation banner. Keep that wiring when adding a query.
- Sorting is client-side and must stay instant. It only moves into the queries once something came
  back truncated — see the notes before changing that.
- Edits here hit large files with template literals and single-line JSX. Shell heredocs mangle
  backticks, and a short anchor like `  return {` matches the wrong occurrence. Use a Node script
  with a quoted heredoc, pick a unique anchor, and grep to confirm the edit landed.
