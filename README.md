# TaskFlow

A to-do app built with vanilla HTML/CSS/JS on **Firebase**:

- **Firebase Authentication**: email/password (with Firebase password-reset emails), Google sign-in and phone (SMS) sign-in
- **Cloud Firestore** (Standard edition, `asia-south1`): tasks, categories and the Quick note, synced live across tabs and devices
- A small **Node/Express** server that serves the site and stores task attachments, checking each request's Firebase ID token

Firebase project: `task-flow-app-97462` · web app `Task-Flow-App` (`1:685374773284:web:5ca35a109de65c4adc60b1`).

## Run locally

```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:3000, restarts on server changes, reloads the page on front-end changes
```

The browser talks to Firebase directly, so no database runs locally. Attachments are stored in `.data/uploads/<uid>/<taskId>/`.

## Firestore data model

```
users/{uid}                  name, note, noteUpdatedAt, createdAt
users/{uid}/tasks/{taskId}   title, description, status, priority, category, dueDate,
                             attachments[], completedAt, deletedAt, createdAt, updatedAt
```

Access is controlled by [firestore.rules](firestore.rules): each user can read and write only their own documents, every field is type- and size-checked, and timestamps must be set by the server. Deleted tasks stay in the trash for 30 days, then the app removes them.

## Deploying Firebase config

Use the Firebase CLI through `npx` (logged in to an account with access to the project):

```bash
npx -y firebase-tools@latest deploy --only firestore   # rules + indexes
npx -y firebase-tools@latest deploy --only auth        # Email/Password + Google providers (see firebase.json)
```

**Phone sign-in** can only be enabled in the Firebase Console: *Authentication → Sign-in method → Phone*. Sending real SMS needs the Blaze (pay-as-you-go) plan. For testing on the free plan, add test numbers with fixed codes under *Phone → Phone numbers for testing*.

For any domain other than `localhost`, add it under *Authentication → Settings → Authorized domains* so Google and phone sign-in work there.

## Project structure

```
server.js                    Express: static site, attachments API, live reload in development
middleware/firebaseAuth.js   Verifies Firebase ID tokens (needs only the project ID)
routes/attachments.js        Upload / download / delete attachment files
lib/attachmentStorage.js     Attachment files on disk
lib/liveReload.js            Development auto-reload
public/js/firebase.js        Firebase app config and initialization
public/js/api.js             Data layer: Firebase Auth + Firestore (+ attachments API)
public/js/app.js             UI
firebase.json, .firebaserc   Firebase CLI config (Firestore, Auth providers)
firestore.rules              Firestore Security Rules
```

## Attachments API

All routes need `Authorization: Bearer <Firebase ID token>`; files are stored per user.

| Method | Path | |
| --- | --- | --- |
| POST | `/api/attachments/:taskId` | `multipart/form-data` field `files` (max 10 per task, 10 MB each) |
| GET | `/api/attachments/:taskId/:attId` | Download. `?inline=1` opens images, PDFs and plain text in the browser |
| DELETE | `/api/attachments/:taskId/:attId` | Remove one file |
| DELETE | `/api/attachments/:taskId` | Remove all files of a task |

## Keyboard shortcuts

- `n`: new task
- `/`: focus search
