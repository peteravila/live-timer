# LiveTimer — Pending Items

**Updated:** May 16, 2026

---

### 1. Deploy Latest Changes to Production

Local files have many changes that haven't been pushed to GitHub/Render yet:
- Custom styled dialogs replacing all native confirm/alert/prompt (instructor.html)
- Duration popup lightened to `rgba(180, 180, 200, 0.2)` with `blur(6px)` (instructor.html)
- Socket reconnection fixes after disconnect-all (student.html)
- `codeExpired` flag to prevent stale QR code auto-retry (student.html)
- Timer state persistence to MongoDB with auto-recovery on restart (server.js)
- Instructor authentication system (signup, login, token validation, admin roles, change/reset password) (server.js, instructor.html)
- Library toolbar with batch operations (batch update, duplicate, delete) (instructor.html)
- Library grid with all timer fields, horizontal scrolling, resizable columns with localStorage persistence (instructor.html)
- Sequence dependency checking before timer deletion (instructor.html)
- Digit spinner controls on phone mockup (hours/minutes arrows, hold-to-repeat, disabled when running) (instructor.html)
- HH:MM idle display format vs HH:MM:SS running format on mockup (instructor.html)
- "..." button on mockup for quick access to duration popup (instructor.html)
- Transport button focus outline fix (instructor.html)

**Status:** Ready to deploy. Use deploy.bat or follow DEPLOY.md.

---

### ~~2. Library Mismatch~~ ✓ RESOLVED

---

---

### ~~3. Push Button Race Condition Fix~~ ✓ DONE

Fixed via mousedown-capture: the Push button grabs the field value before blur fires, preventing incoming timer-update events from overwriting it. A 2-second sync guard also suppresses server overwrites during the round-trip.

---

### 4. Instructor Page Shrinkage

The viewport meta tag was removed in a previous session to fix the instructor page shrinking on certain screens. Not yet confirmed whether the fix worked.

**Status:** Needs confirmation

---

### ~~5. Progress Ring Scaling for Long Timers~~ ✓ DONE

Implemented a power curve (`Math.pow(pct, 0.55)`) for timers longer than 10 minutes. The ring drains faster at the start and slower toward the end, keeping it visible in the final minutes.

---

### ~~6. Persist Timer State to MongoDB~~ ✓ DONE

Timer state (including endTime and lastTimer restore snapshot) now saves to MongoDB on every user-initiated state change. On server restart, if a running timer's endTime is still in the future, the server resumes ticking automatically.

---

### ~~7. Clean Up Debug Code in student.html~~ ✓ DONE

`submitCode()` has been cleaned up — now shows only "Reconnecting..." with no verbose diagnostics.

---

### 8. LiveTimer Brochure

Marketing brochure (v10) has been generated as both PDF and DOCX. Current layout uses mixed left/right alignment, text wrapping around images, reduced word count, and larger fonts. Peter may have further feedback on the layout and content.

**Status:** Awaiting Peter's review

---

### 9. Multi-Instructor Support (Phase 2)

Per-instructor data isolation: scope library, timer state, class code, sequences, and saved orders by instructor ID. Socket rooms per-instructor. Auth system is already in place (Step 1 complete).

**Status:** Deferred

---

### 10. Email-Based Forgot Password

Add email-based password recovery when manual admin resets become a hassle.

**Status:** Deferred
