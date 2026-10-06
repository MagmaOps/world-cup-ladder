# World Cup Ladder

## Goal

Build a temporary web app for ~25 days that displays a player ladder based on data from a published Google Spreadsheet.

The app runs in a private homelab. It has outbound Internet access.

**Optimize for simplicity and speed, not long-term production readiness.**

---

## Source

Published Google Spreadsheet:

https://docs.google.com/spreadsheets/d/e/2PACX-1vTLWEqvGmL5UhP1wKBpMyus9nNlNh_OehPrwkmcyTWBNLS_d4QinlPKLVdZNdrZj_DtNqyit_quFUfh/pubhtml?gid=1410145111&single=true

Source language: Portuguese.

Extract only:

| Source    | Application |
| --------- | ----------- |
| Jogadores | Name        |
| categoria | Category    |
| pontos    | Points      |

UI must use English labels.

---

## Architecture

```text
Google Sheet
     │
     ▼
Backend ──── SQLite
     │
     ▼
Web UI
```

Single application/container is preferred.

### Backend

* Fetch and parse spreadsheet.
* Store latest valid data in SQLite.
* Run automatic sync every 60 minutes.
* Expose REST API.
* Support manual sync.
* SQLite stored on persistent Kubernetes storage.

### Frontend

* Display ladder/ranking graph.
* Display Name, Category, Points and Rank.
* Display last successful sync time.
* Provide `Sync` button.
* Refresh graph after successful manual sync.

---

## Ranking

Sort players by:

```text
Points DESC
Name ASC
```

Highest points = rank 1.

No additional competition/tie-breaking rules.

---

## API

### `GET /api/players`

Return current data:

```json
{
  "players": [
    {
      "rank": 1,
      "name": "Player",
      "category": "A",
      "points": 1250
    }
  ],
  "lastSuccessfulSync": "2026-10-06T09:00:00Z"
}
```

### `POST /api/sync`

Fetch → parse → validate → persist.

Return success/failure and sync timestamp.

### `GET /api/health`

Return HTTP 200 when the application is running.

---

## Sync Rules

Automatic sync: every 60 minutes.

Manual sync: `POST /api/sync`.

Both must use the same sync implementation.

Prevent concurrent sync operations.

A failed sync must **never destroy existing valid data**.

Only replace/update the database after the complete source has been successfully fetched and parsed.

Do not accept an unexpectedly empty dataset as a successful sync.

---

## Database

Use **SQLite**.

Persistent database path, e.g.:

```text
/data/world-cup-ladder.db
```

Store only the current dataset and sync metadata.

No historical data required.

---

## UI

Single page.

```text
World Cup Ladder                         [ Sync ]

Last updated: 06 Oct 2026 09:00

              Ladder / Graph
              
              Player
              Category
              Points
              Rank
```

States:

* Loading
* Data available
* Syncing
* Sync failed
* No data

On sync failure, continue showing the previous data.

---

## Kubernetes / Homelab

Environment:

```text
Proxmox
  └── k3s
       └── Argo CD
            └── World Cup Ladder
```

Requirements:

* OCI/Docker image.
* Kubernetes Deployment.
* `replicas: 1`.
* Kubernetes Service.
* PersistentVolumeClaim for SQLite.
* Configurable environment variables.
* Argo CD deployment manifests.
* `/api/health` for health/readiness checks.

Suggested configuration:

```text
SOURCE_URL
SYNC_INTERVAL_MINUTES=60
DATABASE_PATH=/data/world-cup-ladder.db
```

No public Internet exposure required.

Do not introduce PostgreSQL or other external databases.

---

## Explicitly Out of Scope

Because the application is only needed for ~25 days:

* Authentication
* Authorization / RBAC
* User accounts
* Tests
* CI/CD test infrastructure
* Enterprise features
* Multi-tenancy
* Historical data
* Analytics
* Notifications
* HA
* Multiple replicas
* Autoscaling
* Redis
* Message queues
* Distributed workers
* Service mesh
* Complex monitoring
* Distributed tracing
* Scalability architecture
* Public Internet deployment

---

## Definition of Done

* App deploys through Argo CD to k3s.
* Spreadsheet is successfully parsed.
* Name, Category and Points are stored.
* Data persists across pod restarts.
* Ladder displays correct ranking.
* Hourly sync works.
* Manual `Sync` works.
* Failed sync preserves previous data.
* Last successful sync is displayed.
* No authentication is required.
