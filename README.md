# TaskFlow

A full-stack to-do app: Node.js + Express API, MongoDB (Mongoose), JWT auth, and a vanilla HTML/CSS/JS frontend.

## Quick start

```bash
npm install
cp .env.example .env      # then set JWT_SECRET and MONGODB_URI
npm start                 # http://localhost:3000
```

No MongoDB installed? Set `MONGODB_URI=memory` (or run `npm run dev:memory`) to run an embedded MongoDB. Its data is saved in `.data/db`, so it survives restarts. Delete that folder to start fresh.

| Script | What it does |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Development: restarts the server when back-end code changes, and open browser tabs reload automatically when anything in `public/` changes |
| `npm run dev:memory` | Same as `dev`, with the embedded MongoDB |

Live reload runs only on `localhost` and is disabled when `NODE_ENV=production`.

### Sample data

Add 12 example tasks due 3 to 30 days from now to an existing account:

```bash
node scripts/seed-sample-tasks.js you@example.com [mongoUri]
```

`mongoUri` defaults to `MONGODB_URI` from `.env`. With the embedded database, pass the `mongod` port shown by `ps aux | grep mongod`, for example `mongodb://127.0.0.1:60376/taskflow`.

### Password reset emails

Reset links are sent through SMTP. Fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` in `.env`. For Gmail use `smtp.gmail.com`, port `465` and an [app password](https://myaccount.google.com/apppasswords). Without SMTP settings, the link is printed in the server log instead. `APP_URL` must be the address users open the app at, because it is used to build the link.

## Project structure

```
server.js              Express app, static hosting, error handler
config/db.js           MongoDB connection (supports MONGODB_URI=memory)
models/User.js         User schema, bcrypt hashing
models/Task.js         Task schema ({ timestamps: true })
middleware/auth.js     JWT verification → req.user
routes/auth.js         Register, login, profile, password
routes/tasks.js        Task CRUD, search, filter, sort, trash
routes/attachments.js  Upload, download and delete task attachments
lib/attachmentStorage.js  Attachment files on disk and orphan cleanup
lib/liveReload.js      Development auto-reload (server-sent events)
lib/mailer.js          SMTP email (password reset links)
public/                Frontend (index.html, css/, js/api.js, js/app.js)
```

## API

All task routes require `Authorization: Bearer <token>` and only ever touch the caller's own tasks.

| Method | Path | Body / query |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ name, email, password }` |
| POST | `/api/auth/login` | `{ email, password }` |
| GET | `/api/auth/me` | |
| PATCH | `/api/auth/profile` | `{ name }` |
| PATCH | `/api/auth/password` | `{ currentPassword, newPassword }`. Returns a fresh `token` (other sessions are signed out) |
| POST | `/api/auth/forgot` | `{ email }` emails a reset link (valid 30 min). Same response whether or not the account exists |
| POST | `/api/auth/reset` | `{ token, password }` sets a new password and signs out all existing sessions |
| PATCH | `/api/auth/note` | `{ note }` saves the dashboard Quick note (max 10,000 characters) |
| GET | `/api/tasks` | `?search=&status=(active\|pending\|in-progress\|completed\|overdue\|deleted)&priority=&category=&sort=(newest\|oldest\|due\|priority)` |
| GET | `/api/tasks/categories` | Your categories plus `defaultCategories` |
| DELETE | `/api/tasks/categories/:name` | Removes a custom category from all your tasks (the tasks are kept). Default categories can't be deleted |
| GET | `/api/tasks/stats` | Counts: total, pending, inProgress, completed, overdue, deleted |
| POST | `/api/tasks` | `{ title, description?, status?, priority?, dueDate?, category? }` |
| GET | `/api/tasks/:id` | |
| PUT / PATCH | `/api/tasks/:id` | Any task fields |
| DELETE | `/api/tasks/:id` | Moves the task to the trash. Add `?permanent=true` to delete it for good |
| POST | `/api/tasks/:id/restore` | Restores a task from the trash |
| DELETE | `/api/tasks/trash` | Permanently deletes everything in the trash |
| POST | `/api/tasks/:id/attachments` | `multipart/form-data`, one or more `files` fields (max 10 per task, 10 MB each) |
| GET | `/api/tasks/:id/attachments/:attId` | Downloads a file. Add `?inline=1` to view images, PDFs and plain text in the browser |
| DELETE | `/api/tasks/:id/attachments/:attId` | Removes an attachment |

Deleted tasks stay in the trash for 30 days, then a MongoDB TTL index removes them automatically.

Attachments are stored in `.data/uploads/<taskId>/` and are only served through the authenticated API. Only images, PDFs and plain text can open in the browser. Every other file type (including HTML and SVG) is served as a download with a sandboxed Content-Security-Policy. Files are removed when their task is permanently deleted, and a cleanup sweep runs at startup and every 6 hours for tasks the TTL index purged.

`createdAt` and `updatedAt` are always set by the server. The server ignores any `userId` or timestamps sent by the client.

## Keyboard shortcuts

- `n`: new task
- `/`: focus search
- `Tab` / `Shift+Tab`: move between tasks and controls; `Esc` closes dialogs
