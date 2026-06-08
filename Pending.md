# LiveTimer — Pending Items

**Updated:** June 7, 2026

---

### 1. Email-Based Forgot Password

Add email-based password recovery when manual admin resets become a hassle. Currently, admin can reset any instructor's password from the admin grid.

**Status:** Deferred

---

### 2. LiveTimer Brochure

Marketing brochure (v10) has been generated as both PDF and DOCX. Current layout uses mixed left/right alignment, text wrapping around images, reduced word count, and larger fonts. Peter may have further feedback on the layout and content.

**Status:** Awaiting Peter's review

---

### 3. Free Tier Sleep

Render spins down after ~15 min inactivity. The keep-alive ping (instructor.html pings `/api/library` every 5 minutes) mitigates this but only while the instructor tab is active — browsers throttle background tabs.

**Status:** Known limitation, no fix planned

---

### 4. Batch Alarm Editing

Allow changing several alarms at once, the way timers can be batch-edited (multi-select, then apply a change to all selected). Currently alarms must be edited one at a time.

**Status:** Requested

---

### Completed (Archive)

- ~~**Updates/changelog system**~~ — Done (v1.00.010). `changelog.json` is the single source for version + history. Settings-gear dot for any unseen entry; What's New overlay in Settings → About; per-entry `urgent` flag interrupts on load but defers until the timer is idle. `lastSeenVersion` tracked per instructor.

- ~~**Timer state persistence to MongoDB**~~ — Done. Auto-recovery of running timers on restart.
- ~~**Multi-instructor support**~~ — Done. Full per-instructor data isolation.
- ~~**Authentication**~~ — Done. JWT-based with admin roles. Login ID (not email-only).
- ~~**Progress ring scaling**~~ — Removed. Linear ring depletion now.
- ~~**Debug code cleanup**~~ — Done. submitCode() cleaned up.
- ~~**Library mismatch**~~ — Resolved.
- ~~**Push button race condition**~~ — Fixed via mousedown-capture + 2-second sync guard.
- ~~**Edit/Live mockup tabs**~~ — Done. iframe preview with gold border and LIVE badge.
- ~~**Check-in / student monitoring**~~ — Done. Real-time status board.
- ~~**Sequences**~~ — Done. Named timer chains with auto-advance.
- ~~**Alarm sets**~~ — Done. Named alarm collections with CRUD.
- ~~**Help overlay**~~ — Done. Full documentation with print support.
- ~~**Instructor phone connection**~~ — Done. Not counted as student.
- ~~**Saved orders**~~ — Done. Named timer arrangements.
- ~~**Custom dialogs**~~ — Done. Frosted glass modals.
- ~~**Anonymous class progress**~~ — Done. Donut chart on student phone ring tap.
- ~~**No Clock mode**~~ — Done. Message-only display, 0 duration allowed.
- ~~**Font size overrides**~~ — Done. A−/A+ controls per field, sent to phones.
- ~~**Wake Lock API**~~ — Done. Phone screen stays on for entire session.
- ~~**Grace period on disconnect**~~ — Done. 30-minute window for seamless reconnect.
- ~~**Default timers/alarms admin**~~ — Done. Seeded to new instructor accounts.
- ~~**Security hardening**~~ — Done. Input sanitization + login rate limiting.
- ~~**Login ID system**~~ — Done. Accepts any string, not just email.
- ~~**Favicon**~~ — Done. SVG icon with light/dark mode.
- ~~**Instructor Guide**~~ — Done. PDF and DOCX.
- ~~**Code refactor**~~ — Done. Consolidated duplicated start/load/save paths into shared utilities.
- ~~**Instructor page shrinkage**~~ — Removed from pending (viewport meta tag fix).
