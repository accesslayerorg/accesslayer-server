# Support Tickets

In-app support for signed-in users: tickets, threaded replies, attachments and an agent workflow (#1327).

User routes need a wallet JWT for a wallet linked to a user account. Agent routes need the admin JWT.

## User routes (`/v1/support`)

| Method | Path                                                 | Purpose                                              |
| ------ | ---------------------------------------------------- | ---------------------------------------------------- |
| `POST` | `/tickets`                                           | Create a ticket with up to 3 attachments. `201` with one upload link per attachment. |
| `GET`  | `/tickets`                                           | Your tickets, most recently active first. Filter with `status`. |
| `GET`  | `/tickets/:ticketId`                                 | One ticket with its thread, attachments and status history. |
| `POST` | `/tickets/:ticketId/messages`                        | Reply. A reply on a `waiting` or `resolved` ticket reopens it. `409` on a closed ticket. |
| `GET`  | `/tickets/:ticketId/attachments/:attachmentId`       | Download an uploaded attachment.                     |
| `PUT`  | `/attachments/:attachmentId/upload?expires=&sig=`    | Upload the bytes for one attachment (raw body, see below). |

Another user's ticket returns `404`, the same as a ticket that does not exist.

### Creating a ticket

```json
{
   "category": "payments",
   "subject": "Payment did not arrive",
   "description": "I paid on 20 November but my keys were not credited.",
   "attachments": [{ "fileName": "receipt.png", "contentType": "image/png", "sizeBytes": 183420 }]
}
```

Categories: `account`, `payments`, `keys`, `trading`, `creators`, `technical`, `other`.

The response carries `uploads`, one per attachment:

```json
{
   "attachmentId": "clx...",
   "fileName": "receipt.png",
   "uploadUrl": "https://.../v1/support/attachments/clx.../upload?expires=1764000000000&sig=...",
   "expiresAt": "2026-11-24T12:15:00.000Z",
   "maxBytes": 5242880
}
```

### Uploading bytes

`PUT` the file bytes to `uploadUrl` with the file's `Content-Type`. The link is valid for 15 minutes and works once.

The server then checks the bytes:

- The byte count must equal the declared `sizeBytes`.
- The content is identified from its magic numbers, not its name. The bytes must match the declared content type.
- Executables and scripts are refused even when renamed. This covers Windows (`MZ`), ELF, Mach-O, shebang and PHP content.

### Attachment rules

| Rule                                   | Result                                    |
| -------------------------------------- | ----------------------------------------- |
| More than 3 attachments                | `400`                                     |
| A file over 5 MB                       | `400`                                     |
| Executable or script extension         | `400`, blocked before any upload link is issued |
| Type other than PNG, JPEG, GIF, WebP, PDF or plain text | `400`        |
| Bytes that do not match the declared type or are executable | `422`              |
| Upload link expired or tampered        | `403`                                     |
| Second upload for the same attachment  | `409`                                     |

## Agent routes (`/v1/admin/support`)

| Method | Path                                                  | Purpose                                                    |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------- |
| `GET`  | `/tickets?status=&assigneeId=&page=&limit=`           | All tickets.                                               |
| `GET`  | `/tickets/:ticketId`                                  | Full thread, attachments and status history (includes `userId`). |
| `POST` | `/tickets/:ticketId/assign`                           | Assign to `assigneeId`, or to the calling agent.          |
| `POST` | `/tickets/:ticketId/replies`                          | Reply to the user. Optional `status` in the body.          |
| `POST` | `/tickets/:ticketId/status`                           | Set a status. The change is timestamped.                   |
| `GET`  | `/tickets/:ticketId/attachments/:attachmentId`        | Download an attachment.                                    |

### Status workflow

```
open ──► waiting ──► open
  │         │
  ▼         ▼
resolved ──► open
  │
  ▼
closed  (final)
```

- An agent reply moves an `open` ticket to `waiting`, unless a status is given in the request.
- A user reply moves `waiting` or `resolved` back to `open`.
- Invalid moves return `409`. For example, a closed ticket cannot be reopened.
- `resolvedAt` and `closedAt` are stamped when those statuses are set. Every change is stored in `statusHistory` with its actor and time.

### Notifications

Each agent reply emails the ticket owner once. The message's `notifiedAt` is claimed before sending, so a retry does not email again. A send that fails is not retried. The email contains a link to `FRONTEND_URL/support/tickets/:ticketId` and does not include the reply text.

## Storage

Attachment bytes are stored on the `support_ticket_attachments` row. Each file is at most 5 MB, and a ticket has at most 3 files. Messages and status changes are stored in `support_ticket_messages` and `support_ticket_status_changes`.
