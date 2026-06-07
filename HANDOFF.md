# LiveTimer — Handoff Document for Claude

## What This App Does

LiveTimer is a real-time classroom timer for virtual Zoom/OBS instruction. The instructor controls timers from a control panel, and students see the countdown on their phones or on the Zoom screen share. The key differentiator is that the timer follows the student — they scan a QR code and the countdown is on their phone, so they can walk away from their desk. All clients stay in sync via WebSockets.

## URLs (Production)

- **Instructor panel:** https://livetimer-classroomtimer.onrender.com/instructor
- **Student view:** https://livetimer-classroomtimer.onrender.com/ (or /student.html)
- **Hosting:** Render.com (free tier) — auto-deploys from GitHub

Note: The root URL `/` serves student.html via an Express route. The instructor view is at `/instructor`.

## GitHub Repository

- **Repo:** https://github.com/peteravila/live-timer (formerly classroom-timer)
- **Branch:** main
- **Owner:** Peter (peteravila)

## Deployment Workflow

Peter is not a developer. There are two methods:

**Method 1 — deploy.bat (preferred):**
A batch script in the project root runs `git add . && git commit && git push`. Peter double-clicks it.

**Method 2 — GitHub web editor (fallback):**
1. Navigate to the file in GitHub, click the pencil icon
2. Select all (Ctrl+A), delete, paste new content from local file
3. Commit changes
4. Go to Render dashboard → Manual Deploy → Deploy latest commit

See `DEPLOY.md` for detailed step-by-step instructions.

**Important:** When giving Peter instructions to update GitHub, be explicit and simple. He is comfortable using the GitHub web editor but not git command line tools.

## Local Development

Peter has Node.js installed on Windows. To test locally:

```bash
cd C:\Users\peter\Dropbox\Development\TimerApp
npm install    # only needed once or after dependency changes
npm start      # starts server on http://localhost:3000
```

- Instructor panel: http://localhost:3000/instructor
- Student view: http://localhost:3000/

Stop the server with Ctrl+C. Restart after any server.js changes. Use `npm run dev` for auto-restart with nodemon (ignores timer-library.json and class-code.json changes).

## Tech Stack

- **Runtime:** Node.js
- **Server:** Express.js
- **Real-time:** Socket.io (WebSockets)
- **Database:** MongoDB Atlas (free tier) — stores timer library, class code, timer state, and instructor accounts
- **Auth:** bcrypt (password hashing), jsonwebtoken (JWT tokens)
- **QR Code:** qrcode (npm package, generates data URL PNGs)
- **Environment:** dotenv for MONGODB_URI and JWT_SECRET
- **Frontend:** Vanilla HTML/CSS/JavaScript (no build step, no frameworks)

## File Structure

```
TimerApp/
  package.json           — Dependencies (express, socket.io, mongodb, qrcode, dotenv)
  server.js              — Express + Socket.io server, timer logic, REST API, class code persistence
  timer-library.json     — Auto-generated, JSON backup of timer library (primary is MongoDB)
  class-code.json        — Auto-generated, JSON backup of current class code
  deploy.bat             — Git add/commit/push script for deployment
  CLAUDE.md              — Working rules and architecture docs for Claude
  HANDOFF.md             — This file
  DEPLOY.md              — Step-by-step deployment instructions for Peter
  README.md              — User-facing setup instructions
  Pending Items.md       — Known issues and pending decisions
  LiveTimer_Brochure.pdf — Marketing brochure (3 pages, dark theme, screenshots)
  LiveTimer_Brochure.docx — Word version of the brochure
  ss_*.png               — Screenshots used in the brochure
  public/
    instructor.html      — Instructor control panel (single self-contained HTML file)
    student.html         — Student countdown view (single self-contained HTML file)
```

## Architecture Overview

### Server (server.js)

The server manages per-instructor sessions. Each session contains a timer state object, library, sequences, alarm sets, class code, and student tracking. Sessions are keyed by instructor ID and created on first login.

**Timer state fields:** courseTitle, label, message, totalSeconds, originalTotal, remainingSeconds, running, endTime (epoch ms), showEndTime, endTimeFormatted, endTimeLabel. The `courseTitle` persists across stop/reset — it's a session-level field.

**Timer accuracy:** The server calculates `endTime` as an absolute timestamp when the timer starts. The tick interval (250ms) computes remaining time as `endTime - Date.now()`, avoiding drift from interval inaccuracy.

**Persistence:** Timer state saves to MongoDB on every user-initiated state change (start, pause, stop, load, text edits) but not on every tick — the saved `endTime` is sufficient for recovery. On server restart, if a running timer's `endTime` is still in the future, the server resumes ticking automatically.

**Socket rooms:** Each instructor gets `instructor:{id}` (instructor panel + preview connections) and `students:{id}` (student connections) rooms. The `broadcast()` function sends to both rooms (or just the instructor room when muted).

**Socket.io events (client → server):**
- Timer: `set-timer`, `start`, `pause`, `stop`, `reset`, `add-time`, `restore`
- Text: `update-message`, `update-label`, `update-course-title`, `update-end-time-label`
- Code: `validate-code`, `disconnect-all`
- Display: `update-display-modes` (transparent, blackBg, clockOnly, noClock), `toggle-mute`
- Font: `update-font-override` (field, scale)
- Sequences: `start-sequence`, `skip-sequence-step`, `stop-sequence`, `get-sequence-state`
- Check-in: `set-checkin-enabled`, `set-class-progress-visible`, `student-checkin`, `student-identify`, `reset-student-states`

**Socket.io events (server → client):**
- `timer-update` — Broadcasts full timerState including fontOverrides and noClock (4x/second while running)
- `timer-done` — When countdown reaches zero
- `client-count` — Connected phone count (excludes instructor phone)
- `last-timer` — Restore snapshot to instructor
- `class-code` — Current code to instructor
- `code-accepted` / `code-rejected` / `code-expired` — Code validation
- `sequence-state` / `sequence-next-preview` — Sequence playback state
- `checkin-enabled` — Check-in toggle state
- `class-progress-visible` / `class-progress` — Anonymous class progress donut chart
- `student-list` — Real-time student status board
- `instructor-phone` — Whether instructor's phone is connected

### REST API

**Auth:**
- `POST /api/login` — Returns JWT
- `POST /api/signup` — First user becomes admin
- `POST /api/change-password` — Change own password
- `GET /api/me` — Current user info
- `GET /api/api-key` — Get instructor's API key
- `POST /api/api-key/regenerate` — Regenerate API key

**Admin (requireAdmin middleware):**
- `GET /api/admin/instructors` — List all instructors
- `POST /api/admin/add-instructor`, `update-instructor`, `delete-instructor`, `reset-password`, `toggle-admin`
- `GET/POST/DELETE /api/admin/default-timers` — Default timer presets for new accounts
- `GET/POST/DELETE /api/admin/default-alarms` — Default alarm presets for new accounts
- `GET/POST/DELETE /api/admin/default-sounds` — Default sounds for new accounts

**Library:**
- `GET /api/library` — List timers
- `POST /api/library` — Upsert timer
- `DELETE /api/library/:id` — Delete timer
- `PUT /api/library/reorder` — Reorder by ID array
- `GET /api/library/export` — Export library as JSON
- `POST /api/library/import` — Import library from JSON

**Settings:**
- `GET /api/settings` — Get user settings (palette, etc.)
- `POST /api/settings` — Save user settings

**Custom sounds:**
- `GET /api/custom-sounds` — List custom alarm sounds
- `POST /api/custom-sounds` — Upload custom sound
- `DELETE /api/custom-sounds/:id` — Delete custom sound
- `GET /api/custom-sounds/:id/data` — Get sound data

**Sequences:** `GET /api/sequences`, `POST /api/sequences`, `DELETE /api/sequences/:id`

**Alarm sets:** `GET /api/alarm-sets`, `PUT /api/alarm-sets`

**Alarm settings:** `GET /api/alarm-settings`, `POST /api/alarm-settings`

**Saved orders:** `GET /api/orders`, `POST /api/orders`, `DELETE /api/orders/:id`

**QR codes:** `GET /qr` (student), `GET /qr-instructor` (instructor phone)

**Pages:** `GET /qr-only` (dedicated QR display page for OBS)

### MongoDB Collections (per instructor)

- `instructors` — Accounts (email, password hash, name, isAdmin, apiKey)
- `timerState` — Per-instructor timer state
- `library` — Per-instructor timer presets
- `sequences` — Per-instructor sequence definitions
- `alarmSets` — Per-instructor alarm set collections
- `alarmSettings` — Per-instructor alarm preferences (sound, visual flash)
- `savedOrders` — Per-instructor named timer arrangements
- `classCode` — Per-instructor class code persistence
- `customSounds` — Per-instructor custom alarm sounds (audio data)
- `defaultTimers` — Admin-managed default timer presets (seeded to new accounts)
- `defaultAlarms` — Admin-managed default alarm presets (seeded to new accounts)
- `defaultSounds` — Admin-managed default alarm sounds (seeded to new accounts)

### Instructor Page (public/instructor.html)

Single self-contained HTML file (~8800 lines). Key features:

- **Phone mockup with Edit/Live tabs:** Edit mode shows native HTML/CSS mockup with contenteditable fields. Live mode shows an iframe of the actual student page (`?preview&phonesim=true&code=XXXX&key=API_KEY`) with gold border and pulsing "LIVE" badge. Important: `getField()`/`setField()` use `textContent` (not `innerText`) because `innerText` returns empty for `visibility: hidden` elements.
- **Digit spinners:** Hour/minute spinners on the mockup with hold-to-repeat. Disabled when running. "..." button opens duration popup.
- **Auto-size text fields:** Contenteditable fields auto-shrink/grow font size to fit the mockup space.
- **Transport controls:** Play, Pause, Stop (resets to 00:00), Restore.
- **Duration popup:** Draggable overlay with spinners, quick-set buttons, target-time mode, Add button.
- **Tabs:** Timers (library grid + sequences), Alarms (alarm sets with CRUD), Students (check-in board).
- **Settings overlay:** Instructor phone QR, mute toggle, library backup, after-starting/after-loading tab preferences, startup tab.
- **Help overlay:** Full documentation, printable.
- **Authentication:** JWT login gate, admin grid for managing instructors.
- **Custom dialogs:** Frosted glass modals replacing native confirm/alert/prompt.
- **Sequences:** Builder UI for chaining library timers. Auto-advance on timer completion.
- **Alarm sets:** Named alarm collections. Per-alarm: time, sound, visual flash, repeat, day-of-week scheduling.
- **Check-in board:** Real-time student status (working/done/away/idle) with summary counts and tab badge.
- **Saved orders:** Named timer arrangements accessible from the search bar.
- **No Clock mode:** Per-timer option that hides clock and shows only text. For announcements. Duration can be 0. Stop clears from all phones.
- **Font size overrides:** A−/A+ buttons per field control phone font sizes via CSS transform scale. Stored in timerState.fontOverrides. Reset on Stop.
- **Default timers/alarms admin:** Admin can manage default presets that seed new instructor accounts.
- **Login ID system:** Login field accepts any string. "Login ID" label throughout.
- **Security:** Input sanitization, login rate limiting (10/15min/IP).
- **Favicon:** LiveTimer SVG icon with light/dark mode adaptation.
- **Consolidated code architecture:** Shared utility functions (`startOrAnnounce`, `interruptRunningTimer`, `loadTimerToMockup`, `collectMockupFields`, `pushFieldsToServer`) replace 7+ duplicated start paths.
- **Transparent mode text outline:** Text-shadow on all text elements for readability against any background.
- **Version numbering:** v1.00.009 displayed in Settings > About and as comments in student.html/server.js.

### Student Page (public/student.html)

Single self-contained HTML file. Mobile-first design.

- **Code entry gate:** Phones must enter class code or scan QR. Large screens (≥800px) bypass as "display" viewers.
- **Check-in buttons:** Working, Done, Away, Clear — shown when instructor enables check-in. `phonesim` parameter renders these in the Live preview iframe.
- **Anonymous class progress:** Tap progress ring to see proportional donut chart of class status. Instructor-controlled.
- **No Clock mode:** When noClock is set, hides ring/digits/end-time/done-banner. Shows only title, label, message. Defaults to black background.
- **Wake Lock:** Screen stays on for entire session. Re-acquired on tab switch back.
- **OBS mode:** `?obs=true` skips code gate, respects transparent/clock-only modes.
- **Color transitions:** idle → green → yellow → orange → pulsing red (done). Linear ring depletion.
- **Phone vibration:** `navigator.vibrate()` on timer finish.
- **`/qr-only` route:** Dedicated QR display page for OBS browser sources.

## Known Issues / Future Work

See `Pending.md` for the current list. Key items:

- **Email-based forgot password** — Deferred until manual admin resets become a hassle.
- **Brochure iteration** — v10 awaiting Peter's review.
- **Instructor page shrinkage** — Viewport meta tag removed; needs confirmation.
- **Free tier sleep** — Render spins down after ~15 min inactivity. Keep-alive ping mitigates.

## CSS Design System

Both pages use a consistent dark theme:

```css
--bg: #1a1a2e        /* Page background */
--card: #16213e      /* Card/section background */
--card2: #1c2a4a     /* Library item background */
--accent: #0f3460    /* Borders, active states */
--text: #e0e0e0      /* Primary text */
--dim: #888          /* Secondary text */
--green: #4ecca3     /* Timer safe / start button */
--yellow: #f0c24b    /* Timer warning / pause button */
--red: #e74c3c       /* Timer urgent / done state */
--blue: #3498db      /* Links, end time, info accents */
```

## How Peter Uses This in Class

1. Opens instructor panel a couple minutes before needed (to wake up Render)
2. Shares the student view in Zoom screen share (or uses OBS with multiple browser sources)
3. Students scan QR code from shared screen — timer is now on their phone
4. Picks a timer from the library, optionally tweaks fields on the mockup, clicks play
5. Can run sequences for hands-free multi-timer sessions (lecture → break → lab)
6. Enables check-in so students can report their status (working/done/away)
7. Students see countdown on the Zoom share AND on their phones
8. When students walk away (break, lunch), the timer is in their pocket
9. Color transitions give at-a-glance status; no one needs to ask "how much time is left?"
