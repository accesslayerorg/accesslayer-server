# API Route Inventory

This document lists the current HTTP endpoints exposed by the Access Layer Server.

**Base URL:** `/api/v1`

## Health Module

Routes for service availability checks and diagnostics.

| Method | Path               | Description                                                   |
| :----- | :----------------- | :------------------------------------------------------------ |
| `GET`  | `/health`          | Simple liveness check for load balancers and uptime monitors. |
| `GET`  | `/health/ready`    | Readiness check that verifies critical dependencies.          |
| `GET`  | `/health/detailed` | Detailed diagnostics including system and database status.    |

## Auth Module

Authentication and session-related endpoints.

| Method | Path             | Description                                        |
| :----- | :--------------- | :------------------------------------------------- |
| `POST` | `/auth/login`    | Authenticate a user and return a session response. |
| `POST` | `/auth/register` | Register a new user account.                       |

## Config Module

Public bootstrap configuration.

| Method | Path      | Description                                              |
| :----- | :-------- | :------------------------------------------------------- |
| `GET`  | `/config` | Return public protocol configuration for client startup. |

## Creators Module

Public creator discovery and stats endpoints.

| Method | Path                  | Description                                  |
| :----- | :-------------------- | :------------------------------------------- |
| `GET`  | `/creators`           | List creators with pagination and filtering. |
| `GET`  | `/creators/:id/stats` | Return public stats for a specific creator.  |

## Activity Module

Public activity feed endpoints.

| Method | Path        | Description                      |
| :----- | :---------- | :------------------------------- |
| `GET`  | `/activity` | Return the public activity feed. |

## Ownership Module

Ownership lookup endpoints.

| Method | Path         | Description                                           |
| :----- | :----------- | :---------------------------------------------------- |
| `GET`  | `/ownership` | Look up key ownership by owner address or creator ID. |

## Metrics Module

Operational metrics for background work.

| Method | Path              | Description                                   |
| :----- | :---------------- | :-------------------------------------------- |
| `GET`  | `/metrics/queues` | Return queue depth metrics for worker queues. |

## Admin Module

Restricted administrative endpoints.

| Method  | Path                           | Description                                         |
| :------ | :----------------------------- | :-------------------------------------------------- |
| `PATCH` | `/admin/creators/:id/metadata` | Update creator metadata such as verification state. |
| `POST`  | `/admin/indexer/replay`        | Trigger an indexer replay job.                      |

---

## Root and Miscellaneous

Endpoints outside the `/api/v1` namespace.

| Method | Path          | Description                                      |
| :----- | :------------ | :----------------------------------------------- |
| `GET`  | `/`           | Redirect to `/api-docs`.                         |
| `GET`  | `/api-docs`   | Interactive API documentation.                   |
| `GET`  | `/test-email` | Diagnostic endpoint for testing email transport. |
