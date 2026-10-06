# Overview Dashboard

A Dynatrace AppEngine app that draws a four-column topology map: **RUM applications → Services →
Kubernetes workloads → Infrastructure**, with summary tiles, per-node details and a Davis forecast.

- Nodes and rates come from metrics, relationships from Smartscape, problems from `dt.davis.problems`.
- Pods are grouped into their Kubernetes workload on the map (the tiles still count pods).
- Service → workload traffic is drawn as Sankey bands with flowing particles, from
  `dt.service.request.count` split by `k8s.workload.name`.
- Entry services that no RUM application reaches are fed from a dashed **External callers** node.
  It is a stand-in, not a monitored entity.

Before changing a query, read [docs/dynatrace-query-notes.md](docs/dynatrace-query-notes.md). It
records platform behaviour that produces wrong numbers without raising an error. Working rules for
coding agents are in [AGENTS.md](AGENTS.md).

## Getting started

Requires Node.js 20.19 or later.

```bash
npm install
npm run start     # dev server, opens the app against the tenant in app.config.json
```

## Targeting a tenant

`environmentUrl` in [app.config.json](app.config.json) decides where `start` and `deploy` go. Change
it to deploy to another tenant.

## Deploying

```bash
npm run lint
npm run build
npm run deploy
```

**Bump `app.version` in `app.config.json` before every deploy.** Versions are immutable per tenant:
redeploying an installed version with different content fails with
`Cannot install app with version X because the same version is already installed with a different checksum.`
Each tenant checks this on its own, so a version that is free on one tenant may already be taken on another.

## Required scopes

Declared in `app.config.json` and granted on first open after a scope change:

| Scope | Used for |
| --- | --- |
| `storage:buckets:read` | Every Grail query. Without it queries succeed but return no records |
| `storage:metrics:read` | RUM, service, host and Kubernetes metrics |
| `storage:smartscape:read` | Smartscape nodes and edges |
| `storage:entities:read` | Classic entity model (`dt.entity.service` callers, names) |
| `storage:events:read` | `dt.davis.problems` |
| `storage:spans:read`, `storage:user.events:read` | Declared; no current query reads raw spans or user events |
| `davis:analyzers:execute` | Davis forecast in the details panel |

## Never commit

`.dt-app/` holds the OAuth tokens from the last `dt-app` command and is ignored by `.gitignore`.
Keep it that way.
