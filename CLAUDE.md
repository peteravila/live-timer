# CLAUDE.md — Working Rules for This Project

## How We Work Together

1. **Question everything.** Don't blindly execute requests. If you have a question, concern, or a better idea about any request — no matter how small — voice it before doing any work. This isn't about questioning for the sake of it; it's about surfacing anything useful rather than silently going along.

2. **Finish the conversation first.** When discussing a change, don't start development until the discussion is fully resolved and Peter gives explicit go-ahead (e.g., "go ahead," "proceed," or similar). Never jump into implementation mid-conversation.

3. **Watch for "..." signals.** If Peter's message ends with `...` on its own line, it means he has more to say. Do not act on the message. Wait for a follow-up that either gives the go-ahead or arrives without the ellipsis and without a question or request for feedback.

---

## Version Numbering

**Current version: 1.00.012.** The version lives in **one place only**: the top (newest) entry of `changelog.json` — `changelog[0].version` IS the app version. The server reads it into `APP_VERSION` at startup.

To release a new version, add a new entry to the top of `changelog.json` with the incremented version (by 0.00.001) — that's the single edit. Do NOT hardcode the version anywhere else.

Where the version surfaces (all read from `APP_VERSION` / changelog.json, never hardcoded):
- Instructor Settings → About (`#aboutVersion`, populated from `GET /api/changelog`).
- `GET /version` — plain-text running version, for confirming a deploy went live.
- Server startup log — prints `LiveTimer v<version>` on boot (visible in Render logs).

The old per-file header comments in server.js and student.html are now plain non-load-bearing notes; they no longer carry the version and don't need syncing.

---

## Product Name

**LiveTimer** — this is the product/brand name. Use it in all user-facing contexts.

---

## Architecture

This is a real-time classroom timer for virtual instruction (Zoom + OBS). An instructor sets timers (breaks, labs, etc.) and students see a live countdown on their phones or screens. The core differentiator: the timer follows the student — they scan a QR code and the countdown is on their phone, so they can walk away from their desk.

### Stack
- Node.js + Express + Socket.io (real-time WebSocket communication)
- MongoDB Atlas free tier for persistent library storage and class code persistence
- Hosted on Render free tier
- GitHub repo for deployment (push to GitHub → Render auto-deploys)

### Files
- **server.js** — Express server, Socket.io event handlers, timer state, MongoDB connection, REST API for library CRUD, QR code generation, class code persistence. Timer state, library, and class code persist to MongoDB (primary). Library and class code also back up to JSON files.
- **public/student.html** — Student-facing timer display. Shows course title, progress ring, countdown digits, label, end time, message. Color transitions: green → yellow → orange → pulsing red. Includes code entry gate for phone users. Handles socket reconnection after disconnect-all.
- **public/instructor.html** — Instructor control panel. Single-column layout with a live phone mockup as the centerpiece. The mockup has Edit/Live tabs — Edit shows contenteditable fields inline on the mockup, Live shows an iframe of the actual student page for pixel-perfect preview. Below the mockup: transport buttons (play/pause/stop/restore), tabs (Timers, Alarms, Students), and a draggable duration popup overlay with hour/minute spinners. All native dialogs (confirm/alert/prompt) replaced with custom styled dialogs.
- **timer-library.json** — Local JSON backup of the timer library (also stored in MongoDB).
- **class-code.json** — Local JSON backup of the current class code (also stored in MongoDB).
- **package.json** — Dependencies: express, socket.io, mongodb, qrcode, dotenv. Dev: nodemon.
- **deploy.bat** — Batch script for git add/commit/push deployment.

### Key Concepts

**Timer State (server-side, persisted to MongoDB):** courseTitle, label, message, totalSeconds, originalTotal, remainingSeconds, running, endTime (epoch ms), showEndTime, endTimeFormatted, endTimeLabel. The `courseTitle` persists across stop/reset — it's a session-level field, not per-timer. Timer state and the lastTimer restore snapshot are saved to MongoDB on every user-initiated state change (start, pause, stop, load, text edits, etc.) but not on every tick — the saved endTime is sufficient for recovery. On server restart, if a timer was running and its endTime is still in the future, the server resumes ticking automatically.

**Library:** Array of timer presets (name, minutes, label, message, showEndTime, goToTab). Stored in MongoDB Atlas with JSON file fallback. Also backed up to localStorage in the instructor's browser. Supports export/import via JSON files.

**Three-layer persistence for library:** MongoDB (primary, survives redeploys), localStorage (browser backup, survives MongoDB outages), export files (manual backup).

**Keep-alive ping:** instructor.html pings `/api/library` every 5 minutes to prevent Render free tier from spinning down. Only works while instructor tab is active — browsers throttle background tabs.

**Instructor page layout:** The instructor page uses a single-column layout centered around a live phone mockup that mirrors the student view. Text fields (course title, label, end time label, message) are contenteditable elements directly on the mockup — what you edit is what students see. Transport controls (play, pause, stop, restore) sit below the mockup. Tabs below that provide access to Library, Options, and Settings.

**Instructor page tabs:**
- Timers (formerly Library): Has a Timers/Sequences view toggle at the top. Timers view: Full-width grid showing all timer fields with horizontal scrolling and resizable columns (widths persist in localStorage). Toolbar with batch operations: New, Edit, Save, Cancel, Duplicate, Reset Columns, Search. Checkboxes for multi-select. Click a timer name to load, play button to start immediately. Columns: checkbox, load, play, name, duration, title, end time label, message, show end time, background mode, clock only, after loading. Drag handles for reordering. Saved Orders dropdown in the search bar area for saving/restoring named timer arrangements. Sequences view: list of named sequences with a builder UI (see Sequences below).
- Alarms: Time-of-day alarms with per-alarm settings (sound, visual flash, repeat, day-of-week scheduling). Alarm sets for saving/loading named collections (see Alarm Sets below). Master on/off toggle. Checkboxes with blue row highlight for batch selection and deletion. Spinners for hour/minute/AM-PM. Drag handles for reordering. Alarms fire client-side by comparing current time to alarm times every second.
- Students: Class code display, student QR code, phones-connected count, "Disconnect All Phones" button, check-in toggle, student list with status indicators (working/done/away/idle), summary bar (counts per state), reset all button. See Check-in / Student Monitoring below.

**Digit spinners on mockup:** The clock digits on the phone mockup are flanked by spinner arrow controls — hours (▲▼) on the left, minutes (▲▼) on the right, with "hrs"/"min" labels above each. A "..." button below the right spinner opens the duration popup. Arrows are blue, go green on hover, and support hold-to-repeat (400ms delay, 120ms interval). When the timer is running or paused, spinner arrows are disabled (dimmed). The clock field has a fixed width (180px) so spinners don't shift during use. When idle, digits display in HH:MM format (no seconds); when running, HH:MM:SS with seconds. The `fmtHM()` formatter handles idle display, `fmt()` handles live countdown.

**Duration popup:** A draggable overlay with hour/minute spinners, quick-set buttons, target-time mode, and Add button (for adding time to a running timer). CSS uses `backdrop-filter: blur(6px)` with a light translucent background (`rgba(180, 180, 200, 0.2)`) so the timer is visible counting down underneath. The mockup spinners are quick-access shortcuts; the popup is the full editor with target-time mode and Add functionality.

**Custom dialogs:** All native browser confirm(), alert(), and prompt() calls have been replaced with custom styled modal dialogs using frosted glass styling (`backdrop-filter: blur(8px)`, `rgba(30, 30, 50, 0.7)`, `max-width: 360px`). Functions: `customConfirm(msg)` returns a Promise<boolean>, `customAlert(msg)` returns a Promise<void>, `customPrompt(label)` returns a Promise<string|null>.

**Student page layout (top to bottom):** Code entry gate (phones only, if no valid code) → Course title (large banner) → progress ring → label → countdown digits → end time → message → "Time's Up" banner (when done) → status badge. The QR corner was removed from the student page — QR code display is now handled by the dedicated `/qr-only` route (see below).

**Class code system:** Server generates a 4-character alphanumeric code on startup (no ambiguous chars like 0/O/1/l). Code persists to MongoDB and class-code.json so it survives restarts. Students must enter the code on their phone to see the timer. QR code URL includes `?code=XXXX` so scanning skips the entry screen. Large screens (≥800px, projected displays) skip the code gate entirely and connect as "display" viewers. The instructor's "Disconnect All Students" button generates a new code and disconnects all current students.

**Code entry reconnection:** When the instructor clicks "Disconnect All Students", the server calls `disconnectSockets(true)` which kills the underlying transport. The student page uses a `codeExpired` flag to prevent stale QR code auto-retry, and explicitly calls `socket.connect()` when needed. The `submitCode()` function checks `socket.connected` and reconnects before emitting. This ensures students on phones can re-enter a new code after being disconnected.

**Mute toggle:** When muted, broadcast() only sends updates to the instructor room (instructor + preview sockets), not to students. Unmuting pushes the current state to all connected students. Useful for debugging/developing without disrupting students' phones.

**Line breaks:** Course Title, Title, and Message fields support `\n` (literal backslash-n) which converts to a real newline when pushed. Student view uses `white-space: pre-line` to render them. The `\n` code is stripped before placeholder detection so it doesn't trigger a prompt.

**Color states on student view:** CSS classes on body — state-idle (#1a1a2e), state-green (#0d3b2e), state-yellow (#3b3010), state-orange (#3b2010), state-done (#4a0e0e). The "almost done" state uses orange, not red, because students were confusing it with "time's up." Hybrid color thresholds: yellow = min(35% of total, 10 minutes), orange = min(15% of total, 3 minutes). This prevents long timers (e.g. multi-hour) from turning yellow/orange too early — short timers use percentages, long timers cap at fixed times.

**Phone mockup — Edit/Live views:** The phone mockup has two tab views above it:
- **Edit** (default): Native HTML/CSS that mirrors the student view. Contenteditable fields (course title, label, end time label, message) push changes to the server on blur or via Push buttons. During countdown, receives timer-update events and updates digits, ring, colors in real time. Important: `getField()`/`setField()` use `textContent` (not `innerText`) because `innerText` returns empty for `visibility: hidden` elements — which breaks when Live mode hides Edit content.
- **Live**: An iframe loading the actual student page with `?preview&phonesim=true&code=XXXX&key=API_KEY`. Shows exactly what a phone student sees, including check-in buttons. The `phonesim` parameter overrides `isDisplayViewer` so phone-specific UI (check-in footer, name display) renders despite being a preview connection. Lazy-loads on first tab switch. Reloads when class code changes. Visual indicators: gold border, gold glow, pulsing "LIVE" badge with red dot.

**Stop resets to 00:00:** When the instructor clicks Stop, the spinners and mockup digits reset to 00:00 (not the previous duration). The HTML defaults and reset function also use 00:00. On page load, the first `timer-update` from the server syncs the spinners to the server's `totalSeconds`.

**Sequences:** Named chains of library timers that play back-to-back. The instructor builds a sequence in the Sequences view (inside the Timers tab) by adding timers from the library, naming the sequence, and saving. Playback: click a sequence name to start — the first timer loads and auto-starts, and when it finishes the next one loads automatically. The server manages sequence state (`activeSequence` with `currentIndex`). Socket events: `start-sequence`, `skip-sequence-step`, `stop-sequence`, `get-sequence-state`. The instructor sees a sequence progress bar with current/next labels and Skip/End buttons. Sequence data persists to MongoDB (`sequences` collection per instructor). Timer deletion checks for sequence dependencies and warns the instructor. REST API: `GET /api/sequences`, `POST /api/sequences`, `DELETE /api/sequences/:id`.

**Alarm sets:** Named collections of alarms. Each instructor can have multiple alarm sets (e.g., "Morning Class", "Afternoon Lab"). The active set's alarms are what actually fire. UI: a dropdown to switch between sets, plus New, Duplicate, and a "..." menu (rename, delete). Each set has its own array of alarm objects. Persists to MongoDB (`alarmSets` collection per instructor). REST API: `GET /api/alarm-sets`, `PUT /api/alarm-sets`. Alarm settings (sound, visual flash, etc.) are saved separately via `GET/POST /api/alarm-settings`.

**Saved orders:** Named arrangements of the timer library. When the search bar is open, a Saved Orders dropdown appears. The instructor can save the current timer order as a named arrangement and switch between them. Useful for teaching multiple classes with the same timers in different sequences. Applying a saved order reorders the library to match, with any new timers appended at the end. REST API: `GET /api/orders`, `POST /api/orders`, `DELETE /api/orders/:id`.

**Check-in / student monitoring:** The Students tab includes a check-in toggle that enables/disables status buttons on student phones. When enabled, students see Working, Done, Away, and Clear buttons at the bottom of their screen. The instructor sees a real-time student board with each student's name, state (working/done/away/idle), and time since last change. A summary bar shows counts per state. The Students tab badge shows the count of active (non-idle) students, color-coded: blue if anyone is still working, green if all done, orange if anyone is away. Server events: `set-checkin-enabled`, `student-checkin`, `student-list`, `reset-student-states`. The student list tracks each connected student in a `students` Map on the server session.

**Instructor phone connection:** The instructor can connect their own phone without being counted as a student. In Settings, the "Instructor Phone" section shows a QR code that encodes the student URL with `&instructor=true&key=API_KEY`. When the phone connects, it sends `isInstructor: true` in the `student-identify` event; the server verifies the API key and marks the student record as `isInstructor: true`. Instructor phones are excluded from the connected-phones count and the student list. The Students tab shows a "+ you" indicator when the instructor's phone is connected. Server route: `GET /qr-instructor`.

**Auto-size text fields:** Contenteditable fields on the mockup (course title, label, message) auto-size their font to fit the available space. Each field has a config with max/min/step font sizes (in rem). On every keystroke, `autoSizeField()` shrinks text until it fits, then tries growing back toward max. All fields resize together since they share vertical space in the mockup. The auto-sizer never resets to max on its own to prevent oscillation at line-wrap boundaries.

**Help overlay:** A full-page overlay (opened via "?" button in the topbar) with documentation for all features: phone mockup, transport controls, duration popup, timer library, sequences, alarms, students tab, settings, and keyboard shortcuts. Supports print layout (`@media print` rules). Closes on Escape key, click outside, or close button.

**Authentication:** JWT-based instructor auth. Login gate on the instructor page. Supports signup (first user auto-promoted to admin), login, change password. Admin capabilities: add/edit/delete instructors, reset passwords, toggle admin status. Admin grid accessible from Settings. API key per instructor for preview/phone connections. Server middleware: `requireAuth` (validates JWT on all `/api` routes), `requireAdmin` (checks `isAdmin` flag). MongoDB collection: `instructors` (email, password hash, name, isAdmin, apiKey, createdAt).

**No Clock mode (per-timer):** When `noClock` is checked on a timer, the progress ring, digits, end time, and done banner are hidden on the student page. Only Course Title, Label, and Message display — pulled up with no gap. Background defaults to black. Duration can be 0. The timer doesn't count down — it's a static announcement. The instructor clicks Stop to clear it from all phones. Used for "balance of the day" labs or any message-only display.

**Font size overrides:** Each text field on the mockup has A−/A+ buttons in its context bar. These control the font size on student phones via `transform: scale()`. Overrides are stored in `timerState.fontOverrides` (per field: courseTitle, label, message). When null, auto-size runs normally. When set, auto-size is bypassed. Overrides reset on Stop. The scale value is sent to students in every `timer-update` broadcast.

**Anonymous class progress (donut chart):** Students can tap the progress ring on their phone to see an anonymous proportional donut chart showing working/done/away status. Instructor controls visibility via "Class progress on phones" toggle in Students tab. Server broadcasts `class-progress` event with anonymous counts (no names). The chart uses SVG stroke-dasharray segments inside the same SVG as the progress ring, crossfading with CSS opacity transitions.

**Wake Lock API:** The student page requests `navigator.wakeLock.request('screen')` when the student validates their code. Keeps the phone screen on for the entire session. Re-acquired on visibility change (tab switch back). Prevents most idle disconnects.

**Grace period on disconnect:** When a student's socket disconnects, the server keeps their record in the `students` Map for 30 minutes. If they reconnect within that window (Socket.io auto-reconnects), the grace timer cancels and the student is seamlessly restored. If 30 minutes pass, the student is removed. "Disconnect All Phones" clears all grace timers immediately.

**Display modes (per-timer, saved with library items):**
- **Transparent**: Background becomes transparent on OBS/display viewers. Phones are unaffected. Useful for OBS overlays.
- **Clock only**: Hides everything except the countdown digits on OBS/display viewers. Phones show the full view. Digit color transitions still apply.
- **No Clock**: Hides ring, digits, and end time. Shows only title, label, and message. Defaults to black background.
- Clock only, transparent, and no clock can be combined as needed. They only affect display/preview/OBS viewers for clock-only and transparent; no clock affects all viewers.

**OBS browser source**: Use `?obs=true` parameter (e.g. `https://your-url/?obs=true`). Skips the code gate, identifies as a display viewer, and respects transparent/clock-only modes regardless of window size.

**`/qr-only` route (QR code display page):** A dedicated server-rendered page at `/qr-only` that shows only the QR code, class code, and connection instructions — designed to be used as an OBS browser source in its own scene or as part of an OBS URL grid. The page displays "Scan to connect to LiveTimer" above the QR image, the class code in large monospace text, and a "Can't scan? Go to [URL]" hint below. Connects as a "preview" socket role to receive class-code update events in real time. Uses responsive CSS with `clamp()` for font sizing and `vmin` for QR image sizing so it scales well at any OBS browser source dimensions. Styled with a dark background (`#1a1a2e`) matching the student page idle state.

**OBS scene setup:** The instructor uses an OBS URL grid approach — multiple browser sources (timer, QR-only page, slides, camera, etc.) arranged across scenes. OBS browser sources cache aggressively; enable "Refresh browser when scene becomes active" in each source's properties so they reload on scene switch. After deploying changes, switch away from the scene and back to trigger a refresh. Set browser source dimensions to match the actual display size to avoid fuzzy text from OBS raster downscaling.

**Restore feature:** When a timer starts, the server snapshots it as `lastTimer` (label, message, originalTotal, showEndTime, endTimeLabel, endTime). If the timer is stopped or the page refreshes, the instructor can restore it — the server recalculates remaining time from the original endTime.

**Update notifications:** `changelog.json` (project root, newest entry first) is the single source for both the app version and the update history. Each entry has `version`, `date`, `title`, optional `urgent` boolean, and an `items` array. The server reads it at startup (`APP_VERSION` = `changelog[0].version`) and exposes `GET /api/changelog` (entries + version + the instructor's `lastSeenVersion`) and `POST /api/changelog/seen` (sets `lastSeenVersion` = current version on the instructor record). Client logic (instructor.html): `getUnseenUpdates()` is the one function that decides what's new (entries newer than `lastSeenVersion`, via `compareVersions()`); a red dot shows on the Settings gear and the What's New button whenever anything is unseen; the What's New overlay (Settings → About) renders the full changelog via the single `renderUpdatesHTML()` function and marks everything seen on open. An unseen `urgent` entry additionally interrupts with the overlay on load — but never while a timer is running/paused; it defers via `maybeShowDeferredUpdates()` until the timer next goes idle. Most releases stay un-flagged (dot only); flag `urgent: true` only for changes instructors must notice.

### Deployment
- Push updated files to GitHub (Peter uses the GitHub web editor or deploy.bat)
- Render auto-deploys from latest commit (or use Manual Deploy)
- Deploying restarts the server, but running timers recover automatically from MongoDB (endTime-based resumption)
- OBS browser sources: enable "Refresh browser when scene becomes active" in source properties, then switch scenes after deploy to trigger refresh
- Phone browsers also cache — hard refresh or re-scan QR code after deploys
- See DEPLOY.md for step-by-step instructions for Peter

### Marketing Materials
- **LiveTimer_Brochure.pdf** — 3-page dark-themed marketing brochure with screenshots. Generated via Python/reportlab. Source script is session-local (livetimer_brochure10.py). Screenshots are ss_*.png files in the project root.
- **LiveTimer_Brochure.docx** — Word version of the same brochure, generated via python-docx.

### Completed
- **Multi-instructor support** — Full per-instructor data isolation: library, timer state, class code, sequences, and saved orders scoped by instructor ID. Socket rooms per-instructor. Auth system, admin grid for managing instructors.
- **Alarm sets** — Named alarm collections with CRUD, per-instructor MongoDB persistence.
- **Sequences** — Named timer chains with auto-advance, skip, stop. Builder UI, sequence dependency checking on timer delete.
- **Help overlay** — Full documentation overlay with print support.
- **Check-in / student monitoring** — Real-time student status board with working/done/away/idle states.
- **Instructor phone connection** — Instructor phone via QR code, not counted as student, "+ you" indicator.
- **Edit/Live mockup tabs** — Live iframe preview of student page with gold border and LIVE badge.
- **Saved orders** — Named timer arrangements for different classes.
- **Custom dialogs** — Frosted glass modal dialogs replacing all native confirm/alert/prompt.
- **Timer state persistence** — MongoDB persistence with auto-recovery of running timers on server restart.
- **Anonymous class progress** — Students can tap the progress ring to see a proportional donut chart of class status. Instructor-controlled visibility toggle.
- **No Clock mode** — Timer mode that hides the clock and displays only text. For announcements and "balance of the day" messages. Duration can be 0.
- **Font size overrides** — Instructor can adjust text size on student phones via A−/A+ controls per field. Uses CSS transform scale. Resets on Stop.
- **Wake Lock API** — Student phones stay awake for the entire session. Re-acquired on tab switch back.
- **Grace period on disconnect** — Students stay in the list for 30 minutes after disconnect. Seamless reconnection.
- **Default timers and alarms** — Admin can manage default timer presets and alarm presets that are automatically seeded to new instructor accounts.
- **Security hardening** — Server-side input sanitization (HTML escaping, length limits), login rate limiting (10 attempts per 15 min per IP).
- **Login ID system** — Login field accepts any string (not just email). "Login ID" label throughout UI and error messages.
- **Favicon** — LiveTimer SVG icon with light/dark mode adaptation via CSS media query. Applied to all pages.
- **Instructor Guide** — PDF and DOCX documentation for new instructors covering all features.
- **Code refactor** — Consolidated 7 duplicated start paths, 2 load paths, and multiple save paths into shared utility functions (`startOrAnnounce`, `interruptRunningTimer`, `loadTimerToMockup`, `collectMockupFields`, `pushFieldsToServer`).
- **Transparent mode text outline** — Text-shadow outline on all text elements when transparent background is active, for readability against any background image.
- **Version numbering** — v1.00.010. Single source: `changelog.json[0].version` → `APP_VERSION`. Surfaced via Settings > About, `GET /version`, and the server startup log. Increments by 0.00.001 per release (one edit to changelog.json).
- **Update notifications** — `changelog.json` single source for version + history. Settings-gear dot for any unseen entry; What's New overlay in Settings → About; `urgent` entries interrupt on load but defer until the timer is idle. Endpoints: `GET /api/changelog`, `POST /api/changelog/seen`.
- **Prep Mode / Display Modes rename + fixes** (v1.00.011) — The mute toggle is now labeled **Prep Mode**; the left-panel **Options** are now **Display Modes** (UI labels only — `muteStudents`/`toggle-mute` and the display-mode flags are unchanged). Dropdown `<option>` rows now use palette colors so sound names are readable in dark schemes. NaN guards added to `fmt`/`fmtHM`/`getSpinVal`/`setSpinVal`/`setDurationFromMinutes` so clocks can't get stuck showing "NaN."
- **End-time label as text field** (v1.00.012) — Added `showEndTimeLabel` (parallel to `showEndTime`). Two checkboxes in the Display Modes panel: **Show End Time Label** (renders the end-time label line) and **Show End Time** (appends the computed clock time; implies label shown). Render: label shows when `showEndTimeLabel` true even if time suppressed → free text line; No Clock/Clock Only still hide it. Server `effLabel()` / client `effLabelClient()` enforce "time ⇒ label" and default legacy timers (no flag) to follow `showEndTime`, so existing timers are unchanged. New socket event `update-show-end-time-label`. Threaded through the To Library dialog, new-timer dialog, and the Timers grid (a Show End Time Label column with a per-row dependency: ticking Show End Time locks that row's label box).

### Pending / In Progress
- **Email-based forgot password** — Add when manual admin resets become a hassle.
- **Brochure iteration** — The brochure (v10) has mixed-alignment layout with text wrapping around images, reduced word count, larger fonts. Peter may have further feedback.
