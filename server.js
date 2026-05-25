// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' })); // increased for custom audio uploads

// ── MongoDB ─────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
let db = null;

async function connectMongo() {
  if (!MONGODB_URI) {
    console.log('  No MONGODB_URI set — running without database.');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('classroomTimer');
    console.log('  Connected to MongoDB Atlas.');
  } catch (e) {
    console.error('  MongoDB connection failed:', e.message);
    db = null;
  }
}

// ── Instructor Authentication ────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'livetimer-dev-secret-change-in-production';
const SALT_ROUNDS = 10;

async function createInstructor(email, password, name, isAdmin = false) {
  if (!db) throw new Error('Database not available');
  const existing = await db.collection('instructors').findOne({ email: email.toLowerCase() });
  if (existing) throw new Error('An account with this email already exists');
  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  const instructor = {
    email: email.toLowerCase(),
    password: hashedPassword,
    name: name || email.split('@')[0],
    isAdmin: !!isAdmin,
    createdAt: new Date(),
  };
  const result = await db.collection('instructors').insertOne(instructor);
  instructor._id = result.insertedId;

  // Seed new instructor with default sounds (if any exist)
  try {
    const defaults = await loadDefaultSounds();
    if (defaults.length > 0) {
      // Give each sound a new ID so they're independent copies
      const seeded = defaults.map(s => ({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: s.name,
        data: s.data,
        mimeType: s.mimeType,
        createdAt: new Date(),
      }));
      await saveCustomSounds(result.insertedId.toString(), seeded);
    }
  } catch (e) {
    console.error('  Failed to seed default sounds for new instructor:', e.message);
  }

  return instructor;
}

async function authenticateInstructor(email, password) {
  if (!db) throw new Error('Database not available');
  const instructor = await db.collection('instructors').findOne({ email: email.toLowerCase() });
  if (!instructor) throw new Error('Invalid email or password');
  const valid = await bcrypt.compare(password, instructor.password);
  if (!valid) throw new Error('Invalid email or password');
  return instructor;
}

function generateToken(instructor) {
  return jwt.sign(
    { id: instructor._id.toString(), email: instructor.email, name: instructor.name, isAdmin: !!instructor.isAdmin },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Ensure an instructor has an API key; generate one if missing
async function ensureApiKey(instructorDoc) {
  if (instructorDoc.apiKey) return instructorDoc.apiKey;
  const key = generateApiKey();
  await db.collection('instructors').updateOne(
    { _id: instructorDoc._id },
    { $set: { apiKey: key } }
  );
  return key;
}

// Look up instructor by API key
async function findByApiKey(key) {
  if (!key) return null;
  return db.collection('instructors').findOne({ apiKey: key });
}

// ── Auth middleware for REST endpoints ───────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.instructor = payload;
  req.instructorId = payload.id;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.instructor.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ── Per-instructor session state ────────────────────────────
// Each instructor gets their own isolated session with timer, library, etc.
const sessions = new Map(); // instructorId → session object

// Class code → instructorId reverse lookup
const codeToInstructor = new Map();

const DEFAULT_TIMER_STATE = {
  courseTitle: '',
  label: '',
  message: '',
  totalSeconds: 0,
  originalTotal: 0,
  remainingSeconds: 0,
  running: false,
  endTime: null,
  showEndTime: true,
  endTimeFormatted: '',
  endTimeLabel: 'Class resumes at',
  transparent: false,
  blackBg: false,
  clockOnly: false,
};

function createSession(instructorId) {
  return {
    instructorId,
    library: [],
    savedOrders: [],
    sequences: [],
    timerState: { ...DEFAULT_TIMER_STATE },
    lastTimer: null,
    classCode: null,
    muted: false,
    tickInterval: null,
    students: new Map(),
    studentCounter: 0,
    checkinEnabled: false,
    activeSequence: null,
    sequenceAdvanceTimeout: null,
    screenshotMode: false,
  };
}

function getSession(instructorId) {
  if (!sessions.has(instructorId)) {
    sessions.set(instructorId, createSession(instructorId));
  }
  return sessions.get(instructorId);
}

// ── Class code generation (unique across all instructors) ───
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code, attempts = 0;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    attempts++;
  } while (codeToInstructor.has(code) && attempts < 100);
  return code;
}

// ── MongoDB load/save (all scoped by instructorId) ──────────
const DEFAULT_LIBRARY = [
  { id: '1', name: 'Lunch 60',       minutes: 60, label: 'Lunch Break',    message: 'Enjoy your lunch! See you back in class soon.', showEndTime: true },
  { id: '2', name: 'Break 15',       minutes: 15, label: 'Short Break',    message: 'Quick break — grab a coffee or stretch!',       showEndTime: true },
  { id: '3', name: 'Break 10',       minutes: 10, label: 'Break',          message: 'Be back in 10!',                                showEndTime: true },
  { id: '4', name: 'Lab 30',         minutes: 30, label: 'Lab Activity',   message: 'Work through the lab at your own pace.',         showEndTime: true },
  { id: '5', name: 'Lab 60',         minutes: 60, label: 'Lab Activity',   message: 'Take your time — ask questions if you get stuck.', showEndTime: true },
];

async function loadLibrary(instructorId) {
  if (db) {
    try {
      const doc = await db.collection('libraries').findOne({ _id: instructorId });
      if (doc && doc.timers && doc.timers.length > 0) return doc.timers;
      // No data yet — seed with defaults
      await saveLibrary(instructorId, DEFAULT_LIBRARY);
      return [...DEFAULT_LIBRARY];
    } catch (e) {
      console.error('  MongoDB loadLibrary failed:', e.message);
    }
  }
  return [...DEFAULT_LIBRARY];
}

async function saveLibrary(instructorId, lib) {
  if (db) {
    try {
      await db.collection('libraries').updateOne(
        { _id: instructorId },
        { $set: { timers: lib, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error('  MongoDB saveLibrary failed:', e.message);
    }
  }
}

async function loadSavedOrders(instructorId) {
  if (db) {
    try {
      const doc = await db.collection('savedOrders').findOne({ _id: instructorId });
      if (doc && doc.orders) return doc.orders;
    } catch (e) {
      console.error('  MongoDB loadSavedOrders failed:', e.message);
    }
  }
  return [];
}

async function saveSavedOrders(instructorId, orders) {
  if (db) {
    try {
      await db.collection('savedOrders').updateOne(
        { _id: instructorId },
        { $set: { orders, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error('  MongoDB saveSavedOrders failed:', e.message);
    }
  }
}

async function loadSequences(instructorId) {
  if (db) {
    try {
      const doc = await db.collection('sequences').findOne({ _id: instructorId });
      if (doc && doc.sequences) return doc.sequences;
    } catch (e) {
      console.error('  MongoDB loadSequences failed:', e.message);
    }
  }
  return [];
}

async function saveSequences(instructorId, seqs) {
  if (db) {
    try {
      await db.collection('sequences').updateOne(
        { _id: instructorId },
        { $set: { sequences: seqs, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error('  MongoDB saveSequences failed:', e.message);
    }
  }
}

async function loadClassCode(instructorId) {
  if (db) {
    try {
      const doc = await db.collection('classCodes').findOne({ _id: instructorId });
      if (doc && doc.code) return doc.code;
    } catch (e) {
      console.error('  MongoDB loadClassCode failed:', e.message);
    }
  }
  return null;
}

async function saveClassCode(instructorId, code) {
  if (db) {
    try {
      await db.collection('classCodes').updateOne(
        { _id: instructorId },
        { $set: { code, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error('  MongoDB saveClassCode failed:', e.message);
    }
  }
}

async function saveTimerState(instructorId, session) {
  if (!db) return;
  try {
    await db.collection('timerStates').updateOne(
      { _id: instructorId },
      { $set: {
        timer: { ...session.timerState },
        lastTimer: session.lastTimer ? { ...session.lastTimer } : null,
        updatedAt: new Date()
      }},
      { upsert: true }
    );
  } catch (e) {
    console.error('  MongoDB saveTimerState failed:', e.message);
  }
}

async function loadTimerState(instructorId) {
  if (!db) return null;
  try {
    return await db.collection('timerStates').findOne({ _id: instructorId });
  } catch (e) {
    console.error('  MongoDB loadTimerState failed:', e.message);
    return null;
  }
}

// ── Alarm settings (per-instructor) ────────────────────────
async function loadAlarmSettings(instructorId) {
  if (!db) return null;
  try {
    const doc = await db.collection('alarmSettings').findOne({ _id: instructorId });
    return doc ? doc.settings : null;
  } catch (e) {
    console.error('  MongoDB loadAlarmSettings failed:', e.message);
    return null;
  }
}

async function saveAlarmSettings(instructorId, settings) {
  if (!db) return;
  try {
    await db.collection('alarmSettings').updateOne(
      { _id: instructorId },
      { $set: { settings, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.error('  MongoDB saveAlarmSettings failed:', e.message);
  }
}

// ── Custom sounds (per-instructor, stored as base64) ───────
async function loadCustomSounds(instructorId) {
  if (!db) return [];
  try {
    const doc = await db.collection('customSounds').findOne({ _id: instructorId });
    return doc && doc.sounds ? doc.sounds : [];
  } catch (e) {
    console.error('  MongoDB loadCustomSounds failed:', e.message);
    return [];
  }
}

async function saveCustomSounds(instructorId, sounds) {
  if (!db) return;
  try {
    await db.collection('customSounds').updateOne(
      { _id: instructorId },
      { $set: { sounds, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.error('  MongoDB saveCustomSounds failed:', e.message);
  }
}

// ── Default sounds (shared, admin-managed, seeded to new instructors) ──
async function loadDefaultSounds() {
  if (!db) return [];
  try {
    const doc = await db.collection('defaultSounds').findOne({ _id: 'defaults' });
    return doc && doc.sounds ? doc.sounds : [];
  } catch (e) {
    console.error('  MongoDB loadDefaultSounds failed:', e.message);
    return [];
  }
}

async function saveDefaultSounds(sounds) {
  if (!db) return;
  try {
    await db.collection('defaultSounds').updateOne(
      { _id: 'defaults' },
      { $set: { sounds, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.error('  MongoDB saveDefaultSounds failed:', e.message);
  }
}

// ── Initialize an instructor session (load from DB) ─────────
async function initSession(instructorId) {
  const s = getSession(instructorId);
  s.library = await loadLibrary(instructorId);
  s.savedOrders = await loadSavedOrders(instructorId);
  s.sequences = await loadSequences(instructorId);

  // Load or generate class code
  const existingCode = await loadClassCode(instructorId);
  if (existingCode) {
    s.classCode = existingCode;
  } else {
    s.classCode = generateCode();
    await saveClassCode(instructorId, s.classCode);
  }
  codeToInstructor.set(s.classCode, instructorId);

  // Recover timer state
  const savedState = await loadTimerState(instructorId);
  if (savedState) {
    if (savedState.timer) {
      Object.assign(s.timerState, savedState.timer);
      if (s.timerState.running && s.timerState.endTime) {
        const remaining = Math.round((s.timerState.endTime - Date.now()) / 1000);
        if (remaining > 0) {
          s.timerState.remainingSeconds = remaining;
          startTick(s);
          console.log(`  Recovered running timer for instructor ${instructorId}: ${remaining}s remaining`);
        } else {
          s.timerState.running = false;
          s.timerState.remainingSeconds = 0;
          s.timerState.endTime = null;
          s.timerState.endTimeFormatted = '';
          await saveTimerState(instructorId, s);
        }
      }
    }
    if (savedState.lastTimer) {
      s.lastTimer = savedState.lastTimer;
    }
  }

  return s;
}

// ── Timer engine (per-instructor) ───────────────────────────
function formatEndTime(epochMs) {
  if (!epochMs) return '';
  const d = new Date(epochMs);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function emitStudentCount(s) {
  // Count unique students with an active socket connection
  let count = 0;
  for (const st of s.students.values()) {
    if (st.socketId) count++;
  }
  io.to('instructor:' + s.instructorId).emit('client-count', count);
}

function broadcast(s) {
  if (s.timerState.endTime) {
    s.timerState.endTimeFormatted = formatEndTime(s.timerState.endTime);
  }
  const payload = { ...s.timerState, screenshotMode: s.screenshotMode };
  if (s.muted) {
    io.to('instructor:' + s.instructorId).emit('timer-update', payload);
  } else {
    io.to('instructor:' + s.instructorId).emit('timer-update', payload);
    io.to('students:' + s.instructorId).emit('timer-update', payload);
  }
}

function startTick(s) {
  stopTick(s);
  s.timerState.endTime = Date.now() + s.timerState.remainingSeconds * 1000;
  s.timerState.endTimeFormatted = formatEndTime(s.timerState.endTime);
  let doneFired = false;
  s.tickInterval = setInterval(() => {
    const left = Math.round((s.timerState.endTime - Date.now()) / 1000);
    s.timerState.remainingSeconds = left;
    if (left <= 0 && !doneFired) {
      doneFired = true;
      if (s.muted) {
        io.to('instructor:' + s.instructorId).emit('timer-done');
      } else {
        io.to('instructor:' + s.instructorId).emit('timer-done');
        io.to('students:' + s.instructorId).emit('timer-done');
      }
      if (s.activeSequence) {
        advanceSequence(s);
      }
    }
    broadcast(s);
  }, 250);
}

function stopTick(s) {
  if (s.tickInterval) { clearInterval(s.tickInterval); s.tickInterval = null; }
}

// ── Student check-in (per-instructor) ───────────────────────
function broadcastStudentList(s) {
  const list = Array.from(s.students.values()).map(st => ({
    id: st.id,
    name: st.name,
    state: st.state,
    timestamp: st.timestamp,
  }));
  io.to('instructor:' + s.instructorId).emit('student-list', list);
}

function resetAllStudentStates(s) {
  for (const st of s.students.values()) {
    st.state = 'idle';
    st.timestamp = null;
  }
  broadcastStudentList(s);
}

// ── Sequence playback (per-instructor) ──────────────────────
function clearSequenceState(s) {
  s.activeSequence = null;
  if (s.sequenceAdvanceTimeout) {
    clearTimeout(s.sequenceAdvanceTimeout);
    s.sequenceAdvanceTimeout = null;
  }
}

function broadcastSequenceState(s) {
  const seqState = s.activeSequence ? {
    id: s.activeSequence.id,
    name: s.activeSequence.name,
    currentIndex: s.activeSequence.currentIndex,
    totalSteps: s.activeSequence.steps.length,
    currentLabel: s.activeSequence.steps[s.activeSequence.currentIndex].label,
    nextLabel: s.activeSequence.currentIndex < s.activeSequence.steps.length - 1
      ? s.activeSequence.steps[s.activeSequence.currentIndex + 1].label
      : null,
  } : null;
  io.to('instructor:' + s.instructorId).emit('sequence-state', seqState);
}

function loadSequenceStep(s, index) {
  if (!s.activeSequence || index >= s.activeSequence.steps.length) {
    clearSequenceState(s);
    broadcastSequenceState(s);
    return false;
  }
  s.activeSequence.currentIndex = index;
  const step = s.activeSequence.steps[index];
  s.timerState.totalSeconds = step.totalSeconds;
  s.timerState.originalTotal = step.totalSeconds;
  s.timerState.remainingSeconds = step.totalSeconds;
  s.timerState.label = step.label || '';
  s.timerState.message = step.message || '';
  s.timerState.showEndTime = step.showEndTime !== false;
  s.timerState.endTimeLabel = 'Class resumes at';
  s.timerState.running = false;
  s.timerState.endTime = null;
  s.timerState.endTimeFormatted = '';
  stopTick(s);
  broadcast(s);
  broadcastSequenceState(s);
  saveTimerState(s.instructorId, s);
  return true;
}

function autoStartTimer(s) {
  s.timerState.running = true;
  s.lastTimer = {
    label: s.timerState.label,
    message: s.timerState.message,
    originalTotal: s.timerState.originalTotal,
    remainingSeconds: s.timerState.remainingSeconds,
    showEndTime: s.timerState.showEndTime,
    endTimeLabel: s.timerState.endTimeLabel,
    endTime: Date.now() + s.timerState.remainingSeconds * 1000,
  };
  startTick(s);
  broadcast(s);
  io.to('instructor:' + s.instructorId).emit('last-timer', s.lastTimer);
  saveTimerState(s.instructorId, s);
}

function advanceSequence(s) {
  if (!s.activeSequence) return;
  const nextIndex = s.activeSequence.currentIndex + 1;
  if (nextIndex >= s.activeSequence.steps.length) {
    clearSequenceState(s);
    broadcastSequenceState(s);
    return;
  }
  const nextStep = s.activeSequence.steps[nextIndex];
  stopTick(s);
  s.timerState.running = false;
  if (nextStep.autoStart !== false) {
    const preview = { label: nextStep.label, index: nextIndex, total: s.activeSequence.steps.length };
    if (s.muted) {
      io.to('instructor:' + s.instructorId).emit('sequence-next-preview', preview);
    } else {
      io.to('instructor:' + s.instructorId).emit('sequence-next-preview', preview);
      io.to('students:' + s.instructorId).emit('sequence-next-preview', preview);
    }
    s.sequenceAdvanceTimeout = setTimeout(() => {
      s.sequenceAdvanceTimeout = null;
      if (loadSequenceStep(s, nextIndex)) {
        autoStartTimer(s);
      }
    }, 3000);
  } else {
    loadSequenceStep(s, nextIndex);
  }
}

// ── Routes ───────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/instructor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'instructor.html')));

// ── Library REST endpoints (auth required) ──────────────────
app.get('/api/library', requireAuth, (req, res) => {
  const s = getSession(req.instructorId);
  res.json(s.library);
});

app.post('/api/library', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  const item = req.body;
  item.id = item.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const idx = s.library.findIndex(t => t.id === item.id);
  if (idx >= 0) s.library[idx] = item;
  else s.library.push(item);
  await saveLibrary(req.instructorId, s.library);
  res.json(s.library);
});

app.delete('/api/library/:id', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  s.library = s.library.filter(t => t.id !== req.params.id);
  await saveLibrary(req.instructorId, s.library);
  res.json(s.library);
});

app.put('/api/library/reorder', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  const { ids } = req.body;
  if (Array.isArray(ids)) {
    const map = Object.fromEntries(s.library.map(t => [t.id, t]));
    s.library = ids.map(id => map[id]).filter(Boolean);
    await saveLibrary(req.instructorId, s.library);
  }
  res.json(s.library);
});

app.get('/api/library/export', requireAuth, (req, res) => {
  const s = getSession(req.instructorId);
  res.setHeader('Content-Disposition', 'attachment; filename="timer-library.json"');
  res.json(s.library);
});

app.post('/api/library/import', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  const imported = req.body;
  if (!Array.isArray(imported)) return res.status(400).json({ error: 'Expected an array of timers' });
  s.library = imported;
  await saveLibrary(req.instructorId, s.library);
  res.json(s.library);
});

// ── Saved orders REST endpoints (auth required) ─────────────
app.get('/api/orders', requireAuth, (req, res) => {
  const s = getSession(req.instructorId);
  res.json(s.savedOrders);
});

app.post('/api/orders', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  const { name, ids } = req.body;
  if (!name || !Array.isArray(ids)) return res.status(400).json({ error: 'name and ids required' });
  const id = req.body.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const idx = s.savedOrders.findIndex(o => o.id === id);
  const order = { id, name, ids };
  if (idx >= 0) s.savedOrders[idx] = order;
  else s.savedOrders.push(order);
  await saveSavedOrders(req.instructorId, s.savedOrders);
  res.json(s.savedOrders);
});

app.delete('/api/orders/:id', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  s.savedOrders = s.savedOrders.filter(o => o.id !== req.params.id);
  await saveSavedOrders(req.instructorId, s.savedOrders);
  res.json(s.savedOrders);
});

// ── Sequence REST endpoints (auth required) ─────────────────
app.get('/api/sequences', requireAuth, (req, res) => {
  const s = getSession(req.instructorId);
  res.json(s.sequences);
});

app.post('/api/sequences', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  const seq = req.body;
  seq.id = seq.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const idx = s.sequences.findIndex(x => x.id === seq.id);
  if (idx >= 0) s.sequences[idx] = seq;
  else s.sequences.push(seq);
  await saveSequences(req.instructorId, s.sequences);
  res.json(s.sequences);
});

app.delete('/api/sequences/:id', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  s.sequences = s.sequences.filter(x => x.id !== req.params.id);
  await saveSequences(req.instructorId, s.sequences);
  res.json(s.sequences);
});

// ── Alarm settings REST endpoints (auth required) ──────────
app.get('/api/alarm-settings', requireAuth, async (req, res) => {
  const settings = await loadAlarmSettings(req.instructorId);
  res.json(settings || {});
});

app.post('/api/alarm-settings', requireAuth, async (req, res) => {
  const settings = req.body;
  await saveAlarmSettings(req.instructorId, settings);
  res.json({ success: true });
});

// ── General settings REST endpoints (auth required) ─────────
app.get('/api/settings', requireAuth, async (req, res) => {
  if (!db) return res.json({});
  try {
    const doc = await db.collection('instructorSettings').findOne({ _id: req.instructorId });
    res.json(doc ? doc.settings : {});
  } catch (e) { res.json({}); }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    const existing = await db.collection('instructorSettings').findOne({ _id: req.instructorId });
    const merged = { ...(existing?.settings || {}), ...req.body };
    await db.collection('instructorSettings').updateOne(
      { _id: req.instructorId },
      { $set: { settings: merged, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Custom sounds REST endpoints (auth required) ───────────
app.get('/api/custom-sounds', requireAuth, async (req, res) => {
  const sounds = await loadCustomSounds(req.instructorId);
  res.json(sounds);
});

app.post('/api/custom-sounds', requireAuth, async (req, res) => {
  const { name, data, mimeType } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'name and data required' });
  const sounds = await loadCustomSounds(req.instructorId);
  // Check for duplicate name
  if (sounds.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'A custom sound with that name already exists' });
  }
  // Enforce 10 MB aggregate cap per instructor
  const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
  const existingBytes = sounds.reduce((sum, s) => sum + (s.data ? s.data.length : 0), 0);
  if (existingBytes + data.length > MAX_TOTAL_BYTES) {
    const usedMB = (existingBytes / (1024 * 1024)).toFixed(1);
    return res.status(400).json({ error: `Storage limit reached (${usedMB} MB of 10 MB used). Delete some sounds to make room.` });
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  sounds.push({ id, name, data, mimeType: mimeType || 'audio/mpeg', createdAt: new Date() });
  await saveCustomSounds(req.instructorId, sounds);
  // Return list without data field to keep response small
  res.json(sounds.map(s => ({ id: s.id, name: s.name, mimeType: s.mimeType })));
});

app.delete('/api/custom-sounds/:id', requireAuth, async (req, res) => {
  let sounds = await loadCustomSounds(req.instructorId);
  sounds = sounds.filter(s => s.id !== req.params.id);
  await saveCustomSounds(req.instructorId, sounds);
  res.json(sounds.map(s => ({ id: s.id, name: s.name, mimeType: s.mimeType })));
});

// Get a single custom sound's audio data (for playback)
app.get('/api/custom-sounds/:id/data', requireAuth, async (req, res) => {
  const sounds = await loadCustomSounds(req.instructorId);
  const sound = sounds.find(s => s.id === req.params.id);
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  res.json({ id: sound.id, name: sound.name, data: sound.data, mimeType: sound.mimeType });
});

// ── Auth endpoints (no middleware needed) ────────────────────
app.post('/api/signup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const instructor = await createInstructor(email, password, name);
    const token = generateToken(instructor);
    res.json({ token, name: instructor.name, email: instructor.email });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const instructor = await authenticateInstructor(email, password);
    await ensureApiKey(instructor);
    const token = generateToken(instructor);
    res.json({ token, name: instructor.name, email: instructor.email });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  res.json({ name: payload.name, email: payload.email, isAdmin: !!payload.isAdmin });
});

// API key for display viewers (OBS, large screens)
app.get('/api/api-key', requireAuth, async (req, res) => {
  const instructor = await db.collection('instructors').findOne({ _id: new ObjectId(req.instructor.id) });
  if (!instructor) return res.status(404).json({ error: 'Instructor not found' });
  const key = await ensureApiKey(instructor);
  res.json({ apiKey: key });
});

app.post('/api/api-key/regenerate', requireAuth, async (req, res) => {
  const key = generateApiKey();
  await db.collection('instructors').updateOne(
    { _id: new ObjectId(req.instructor.id) },
    { $set: { apiKey: key } }
  );
  res.json({ apiKey: key });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const instructor = await db.collection('instructors').findOne({ email: req.instructor.email });
    if (!instructor) return res.status(404).json({ error: 'Account not found' });
    const valid = await bcrypt.compare(currentPassword, instructor.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashedNew = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await db.collection('instructors').updateOne({ _id: instructor._id }, { $set: { password: hashedNew } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ── Admin endpoints ─────────────────────────────────────────
app.post('/api/admin/reset-password', requireAdmin, async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: 'Email and new password required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const instructor = await db.collection('instructors').findOne({ email: email.toLowerCase() });
    if (!instructor) return res.status(404).json({ error: 'No account found with that email' });
    const hashedNew = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await db.collection('instructors').updateOne({ _id: instructor._id }, { $set: { password: hashedNew } });
    res.json({ success: true, email: instructor.email });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

app.get('/api/admin/instructors', requireAdmin, async (req, res) => {
  try {
    const instructors = await db.collection('instructors')
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
    res.json(instructors.map(i => ({ email: i.email, name: i.name, isAdmin: !!i.isAdmin, createdAt: i.createdAt })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to list instructors' });
  }
});

app.post('/api/admin/toggle-admin', requireAdmin, async (req, res) => {
  const { email, isAdmin } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (email.toLowerCase() === req.instructor.email.toLowerCase() && !isAdmin) {
    return res.status(400).json({ error: 'Cannot remove your own admin status' });
  }
  try {
    const result = await db.collection('instructors').updateOne(
      { email: email.toLowerCase() },
      { $set: { isAdmin: !!isAdmin } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Instructor not found' });
    res.json({ success: true, email: email.toLowerCase(), isAdmin: !!isAdmin });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update admin status' });
  }
});

app.post('/api/admin/add-instructor', requireAdmin, async (req, res) => {
  const { email, password, name, isAdmin } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const instructor = await createInstructor(email, password, name, isAdmin);
    res.json({ success: true, email: instructor.email, name: instructor.name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/update-instructor', requireAdmin, async (req, res) => {
  const { originalEmail, name, email } = req.body;
  if (!originalEmail || !email) return res.status(400).json({ error: 'Original email and new email required' });
  try {
    if (originalEmail.toLowerCase() !== email.toLowerCase()) {
      const existing = await db.collection('instructors').findOne({ email: email.toLowerCase() });
      if (existing) return res.status(400).json({ error: 'An account with that email already exists' });
    }
    const update = { email: email.toLowerCase() };
    if (name !== undefined) update.name = name;
    const result = await db.collection('instructors').updateOne(
      { email: originalEmail.toLowerCase() },
      { $set: update }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Instructor not found' });
    res.json({ success: true, email: email.toLowerCase(), name });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update instructor' });
  }
});

app.post('/api/admin/delete-instructor', requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (email.toLowerCase() === req.instructor.email.toLowerCase()) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  try {
    const result = await db.collection('instructors').deleteOne({ email: email.toLowerCase() });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Instructor not found' });
    res.json({ success: true, email: email.toLowerCase() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete instructor' });
  }
});

// ── Admin: default sounds management ───────────────────────
app.get('/api/admin/default-sounds', requireAdmin, async (req, res) => {
  const sounds = await loadDefaultSounds();
  // Return without audio data to keep response small
  res.json(sounds.map(s => ({ id: s.id, name: s.name, mimeType: s.mimeType })));
});

app.post('/api/admin/default-sounds', requireAdmin, async (req, res) => {
  const { name, data, mimeType } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'name and data required' });
  const sounds = await loadDefaultSounds();
  if (sounds.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: 'A default sound with that name already exists' });
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  sounds.push({ id, name, data, mimeType: mimeType || 'audio/mpeg', createdAt: new Date() });
  await saveDefaultSounds(sounds);
  res.json(sounds.map(s => ({ id: s.id, name: s.name, mimeType: s.mimeType })));
});

app.delete('/api/admin/default-sounds/:id', requireAdmin, async (req, res) => {
  let sounds = await loadDefaultSounds();
  sounds = sounds.filter(s => s.id !== req.params.id);
  await saveDefaultSounds(sounds);
  res.json(sounds.map(s => ({ id: s.id, name: s.name, mimeType: s.mimeType })));
});

app.get('/api/admin/default-sounds/:id/data', requireAdmin, async (req, res) => {
  const sounds = await loadDefaultSounds();
  const sound = sounds.find(s => s.id === req.params.id);
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  res.json({ id: sound.id, name: sound.name, data: sound.data, mimeType: sound.mimeType });
});

// ── QR code (auth required — scoped to instructor's class code) ──
app.get('/qr', requireAuth, async (req, res) => {
  const s = getSession(req.instructorId);
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const studentUrl = `${protocol}://${host}/?code=${s.classCode}`;
  try {
    const dataUrl = await QRCode.toDataURL(studentUrl, { width: 300, margin: 2 });
    res.json({ url: studentUrl, qr: dataUrl, code: s.classCode });
  } catch (err) {
    res.status(500).json({ error: 'Could not generate QR code' });
  }
});

// QR-only page — needs a code parameter to know which instructor
app.get('/qr-only', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LiveTimer QR Code</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a2e;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 5%;
  }
  .qr-container {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .scan-label {
    font-size: clamp(1.5rem, 4.5vw, 3rem);
    color: rgba(255,255,255,0.65);
    margin-bottom: 3%;
    max-width: 90%;
    line-height: 1.3;
    text-align: center;
  }
  .qr-image img {
    border-radius: 8px;
    background: #fff;
    padding: 6px;
    width: clamp(150px, 40vmin, 500px);
    height: auto;
  }
  .hint {
    font-size: clamp(1.2rem, 3.5vw, 2.2rem);
    color: rgba(255,255,255,0.6);
    margin-top: 4%;
    max-width: 90%;
    line-height: 1.4;
    text-align: center;
  }
  .hint b { color: rgba(255,255,255,0.75); display: block; margin-top: 0.5em; }
  .class-code {
    font-size: clamp(2.4rem, 7vw, 6rem);
    font-weight: 800;
    letter-spacing: 0.3em;
    color: rgba(255,255,255,0.85);
    font-family: monospace;
    margin-top: 4%;
    text-align: center;
  }
</style>
</head>
<body>
<div class="qr-container">
  <div class="scan-label">Scan to connect to LiveTimer</div>
  <div class="qr-image" id="qrImg"></div>
  <div class="hint" id="qrHint"></div>
  <div class="class-code" id="classCode"></div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
  // Get auth credentials from URL params for instructor-scoped QR
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const apiKey = params.get('key');

  function loadQR() {
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    fetch('/qr', { headers }).then(r => r.json()).then(data => {
      document.getElementById('qrImg').innerHTML = '<img src="' + data.qr + '" alt="QR code">';
      document.getElementById('classCode').textContent = data.code;
      const baseUrl = data.url.replace(/\\?.*$/, '');
      document.getElementById('qrHint').innerHTML = "Can't scan? Go to<br><b>" + baseUrl + "</b>";
    }).catch(() => {});
  }
  loadQR();

  // Auto-update when class code changes
  const authObj = apiKey ? { apiKey } : token ? { token } : {};
  const socket = io({ auth: authObj });
  socket.on('connect', () => { socket.emit('identify', 'preview'); });
  socket.on('class-code', () => { loadQR(); });
</script>
</body>
</html>`);
});

// ── Socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  let role = 'pending'; // pending | student | instructor | preview
  let validated = false;
  let studentPersistentId = null;
  let instructorId = null; // which instructor this socket belongs to
  let session = null;      // shorthand for getSession(instructorId)

  socket.on('identify', (r) => {
    if (r === 'instructor') {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      const payload = token ? verifyToken(token) : null;
      if (!payload) {
        socket.emit('connect_error', { message: 'Authentication required' });
        socket.disconnect(true);
        return;
      }
      role = 'instructor';
      validated = true;
      instructorId = payload.id;
      session = getSession(instructorId);
      socket.join('instructor:' + instructorId);
      // Send current state to instructor
      socket.emit('timer-update', session.timerState);
      socket.emit('last-timer', session.lastTimer);
      socket.emit('class-code', session.classCode);
      socket.emit('mute-state', session.muted);
      socket.emit('checkin-enabled', session.checkinEnabled);
      socket.emit('screenshot-mode', session.screenshotMode || false);
      emitStudentCount(session);
      broadcastStudentList(session);
      broadcastSequenceState(session);
    } else if (r === 'preview' || r === 'display' || (typeof r === 'object' && (r.role === 'preview' || r.role === 'display'))) {
      // Preview/display: try API key first, then auth token, then class code
      const identifyRole = typeof r === 'object' ? r.role : r;
      const identifyCode = typeof r === 'object' ? r.code : null;
      const apiKey = socket.handshake.auth && socket.handshake.auth.apiKey;
      const token = socket.handshake.auth && socket.handshake.auth.token;
      const payload = token ? verifyToken(token) : null;
      let joinRoom = null;
      if (apiKey) {
        // API key lookup (async — wrapped in IIFE)
        findByApiKey(apiKey).then(instructor => {
          if (instructor) {
            instructorId = instructor._id.toString();
            session = getSession(instructorId);
            role = identifyRole;
            validated = true;
            socket.join('instructor:' + instructorId);
            socket.emit('timer-update', session.timerState);
          }
        });
        return; // exit early — async path handles the rest
      } else if (payload) {
        instructorId = payload.id;
        session = getSession(instructorId);
        joinRoom = 'instructor:' + instructorId;
      } else if (identifyCode) {
        // Route via class code (e.g. large-screen display with ?code=XXXX)
        const ownerInstructorId = codeToInstructor.get(identifyCode.toUpperCase());
        if (ownerInstructorId) {
          instructorId = ownerInstructorId;
          session = getSession(instructorId);
          joinRoom = 'students:' + instructorId;
        }
      }
      role = identifyRole;
      validated = true;
      if (instructorId) {
        socket.join(joinRoom);
        socket.emit('timer-update', session.timerState);
      }
    }
  });

  // Student validates with class code — routes to the correct instructor
  socket.on('validate-code', (code) => {
    const ownerInstructorId = codeToInstructor.get(code);
    if (ownerInstructorId) {
      role = 'student';
      validated = true;
      instructorId = ownerInstructorId;
      session = getSession(instructorId);
      socket.join('students:' + instructorId);
      socket.emit('code-accepted');
      socket.emit('timer-update', session.timerState);
      socket.emit('checkin-enabled', session.checkinEnabled);
      emitStudentCount(session);
    } else {
      socket.emit('code-rejected');
    }
  });

  // Student identifies with persistent UUID and optional name
  socket.on('student-identify', ({ id, name }) => {
    if (role !== 'student' || !session) return;
    studentPersistentId = id;
    let student = session.students.get(id);
    if (student) {
      student.socketId = socket.id;
      if (name) student.name = name;
    } else {
      session.studentCounter++;
      student = {
        id,
        name: name || `Student ${session.studentCounter}`,
        state: 'idle',
        socketId: socket.id,
        timestamp: null,
      };
      session.students.set(id, student);
    }
    socket.emit('student-name', student.name);
    socket.emit('student-state-restore', student.state);
    broadcastStudentList(session);
  });

  socket.on('student-status', ({ state }) => {
    if (role !== 'student' || !studentPersistentId || !session) return;
    const student = session.students.get(studentPersistentId);
    if (!student) return;
    if (!['idle', 'working', 'done', 'away'].includes(state)) return;
    student.state = state;
    student.timestamp = Date.now();
    broadcastStudentList(session);
  });

  socket.on('disconnect', () => {
    if (role === 'student' && validated && session) {
      // Only clear socketId if it still belongs to THIS socket
      // (a re-scan may have already replaced it with a newer socket)
      if (studentPersistentId && session.students.has(studentPersistentId)) {
        const student = session.students.get(studentPersistentId);
        if (student.socketId === socket.id) {
          student.socketId = null;
        }
      }
      emitStudentCount(session);
    }
  });

  // ── Instructor-only events (all scoped to their session) ──

  socket.on('generate-code', async () => {
    if (role !== 'instructor' || !session) return;
    // Remove old code from lookup
    codeToInstructor.delete(session.classCode);
    // Generate new unique code
    session.classCode = generateCode();
    codeToInstructor.set(session.classCode, instructorId);
    await saveClassCode(instructorId, session.classCode);
    // Disconnect this instructor's students only
    io.to('students:' + instructorId).emit('code-expired');
    const studentSockets = await io.in('students:' + instructorId).fetchSockets();
    for (const s of studentSockets) s.disconnect(true);
    session.students.clear();
    session.studentCounter = 0;
    io.to('instructor:' + instructorId).emit('class-code', session.classCode);
    emitStudentCount(session);
    broadcastStudentList(session);
  });

  socket.on('reset-student-states', () => {
    if (role !== 'instructor' || !session) return;
    resetAllStudentStates(session);
  });

  socket.on('set-checkin-enabled', (enabled) => {
    if (role !== 'instructor' || !session) return;
    session.checkinEnabled = !!enabled;
    io.to('instructor:' + instructorId).emit('checkin-enabled', session.checkinEnabled);
    io.to('students:' + instructorId).emit('checkin-enabled', session.checkinEnabled);
  });

  socket.on('set-mute', (isMuted) => {
    if (role !== 'instructor' || !session) return;
    session.muted = !!isMuted;
    io.to('instructor:' + instructorId).emit('mute-state', session.muted);
    if (!session.muted) {
      io.to('students:' + instructorId).emit('timer-update', session.timerState);
    }
  });

  socket.on('set-screenshot-mode', (on) => {
    if (role !== 'instructor' || !session) return;
    session.screenshotMode = !!on;
    io.to('instructor:' + instructorId).emit('screenshot-mode', session.screenshotMode);
    broadcast(session);
  });

  socket.on('set-timer', ({ minutes, label, message, showEndTime, transparent, blackBg, clockOnly }) => {
    if (role !== 'instructor' || !session) return;
    const secs = Math.max(0, Math.round(minutes * 60));
    session.timerState.totalSeconds = secs;
    session.timerState.originalTotal = secs;
    session.timerState.remainingSeconds = secs;
    session.timerState.label = label || '';
    session.timerState.message = message || '';
    session.timerState.showEndTime = showEndTime !== false;
    session.timerState.transparent = !!transparent;
    session.timerState.blackBg = !!blackBg;
    session.timerState.clockOnly = !!clockOnly;
    session.timerState.running = false;
    session.timerState.endTime = null;
    session.timerState.endTimeFormatted = '';
    stopTick(session);
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('set-timer-only', ({ minutes, showEndTime }) => {
    if (role !== 'instructor' || !session) return;
    const secs = Math.max(0, Math.round(minutes * 60));
    session.timerState.totalSeconds = secs;
    session.timerState.originalTotal = secs;
    session.timerState.remainingSeconds = secs;
    session.timerState.showEndTime = showEndTime !== false;
    session.timerState.running = false;
    session.timerState.endTime = null;
    session.timerState.endTimeFormatted = '';
    stopTick(session);
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('start', () => {
    if (role !== 'instructor' || !session || session.timerState.totalSeconds <= 0 || session.timerState.running) return;
    session.timerState.running = true;
    session.lastTimer = {
      label: session.timerState.label,
      message: session.timerState.message,
      originalTotal: session.timerState.originalTotal,
      remainingSeconds: session.timerState.remainingSeconds,
      showEndTime: session.timerState.showEndTime,
      endTimeLabel: session.timerState.endTimeLabel,
      endTime: Date.now() + session.timerState.remainingSeconds * 1000,
    };
    startTick(session);
    broadcast(session);
    io.to('instructor:' + instructorId).emit('last-timer', session.lastTimer);
    saveTimerState(instructorId, session);
  });

  socket.on('pause', () => {
    if (role !== 'instructor' || !session || !session.timerState.running) return;
    session.timerState.running = false;
    session.timerState.endTime = null;
    session.timerState.endTimeFormatted = '';
    stopTick(session);
    if (session.lastTimer) {
      session.lastTimer.remainingSeconds = session.timerState.remainingSeconds;
    }
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('reset', () => {
    if (role !== 'instructor' || !session) return;
    session.timerState.remainingSeconds = session.timerState.totalSeconds;
    session.timerState.running = false;
    session.timerState.endTime = null;
    session.timerState.endTimeFormatted = '';
    stopTick(session);
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('add-time', ({ minutes }) => {
    if (role !== 'instructor' || !session) return;
    const extra = Math.round(minutes * 60);
    session.timerState.totalSeconds += extra;
    session.timerState.originalTotal += extra;
    session.timerState.remainingSeconds += extra;
    if (session.timerState.running && session.timerState.endTime) {
      session.timerState.endTime += extra * 1000;
      if (session.lastTimer) {
        session.lastTimer.endTime += extra * 1000;
        session.lastTimer.originalTotal += extra;
      }
    }
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('stop', () => {
    if (role !== 'instructor' || !session) return;
    if (session.lastTimer && session.timerState.remainingSeconds > 0) {
      session.lastTimer.remainingSeconds = session.timerState.remainingSeconds;
    }
    session.timerState.totalSeconds = 0;
    session.timerState.originalTotal = 0;
    session.timerState.remainingSeconds = 0;
    session.timerState.running = false;
    session.timerState.endTime = null;
    session.timerState.endTimeFormatted = '';
    session.timerState.label = '';
    session.timerState.message = '';
    session.timerState.endTimeLabel = '';
    session.timerState.showEndTime = false;
    stopTick(session);
    clearSequenceState(session);
    broadcastSequenceState(session);
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('update-message', ({ message }) => {
    if (role !== 'instructor' || !session) return;
    session.timerState.message = message || '';
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('update-label', ({ label }) => {
    if (role !== 'instructor' || !session) return;
    session.timerState.label = label || '';
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('update-end-time-label', ({ endTimeLabel }) => {
    if (role !== 'instructor' || !session) return;
    session.timerState.endTimeLabel = endTimeLabel || 'Class resumes at';
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('update-course-title', ({ courseTitle }) => {
    if (role !== 'instructor' || !session) return;
    session.timerState.courseTitle = courseTitle || '';
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('update-display-modes', ({ transparent, blackBg, clockOnly }) => {
    if (role !== 'instructor' || !session) return;
    session.timerState.transparent = !!transparent;
    session.timerState.blackBg = !!blackBg;
    session.timerState.clockOnly = !!clockOnly;
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('update-show-end-time', ({ showEndTime }) => {
    if (role !== 'instructor' || !session) return;
    session.timerState.showEndTime = showEndTime !== false;
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('restore-last-timer', () => {
    if (role !== 'instructor' || !session || !session.lastTimer || session.lastTimer.remainingSeconds <= 0) return;
    const remaining = session.lastTimer.remainingSeconds;
    const now = Date.now();
    const newEndTime = now + remaining * 1000;
    session.timerState.label = session.lastTimer.label;
    session.timerState.message = session.lastTimer.message;
    session.timerState.originalTotal = session.lastTimer.originalTotal;
    session.timerState.totalSeconds = session.lastTimer.originalTotal;
    session.timerState.remainingSeconds = remaining;
    session.timerState.showEndTime = session.lastTimer.showEndTime;
    session.timerState.endTimeLabel = session.lastTimer.endTimeLabel;
    session.timerState.running = true;
    session.timerState.endTime = newEndTime;
    session.timerState.endTimeFormatted = formatEndTime(newEndTime);
    startTick(session);
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  // ── Sequence playback ──
  socket.on('start-sequence', ({ sequenceId }) => {
    if (role !== 'instructor' || !session) return;
    stopTick(session);
    session.timerState.running = false;
    clearSequenceState(session);
    const seq = session.sequences.find(s => s.id === sequenceId);
    if (!seq || !seq.steps || seq.steps.length === 0) return;
    const resolvedSteps = seq.steps.map(step => {
      const libItem = session.library.find(t => t.id === step.timerId);
      if (!libItem) return null;
      return {
        timerId: libItem.id,
        label: libItem.label || libItem.name || '',
        message: libItem.message || '',
        totalSeconds: Math.max(0, Math.round((libItem.minutes || 0) * 60)),
        showEndTime: libItem.showEndTime !== false,
        autoStart: step.autoStart !== false,
      };
    }).filter(Boolean);
    if (resolvedSteps.length === 0) return;
    clearSequenceState(session);
    session.activeSequence = {
      id: seq.id,
      name: seq.name,
      steps: resolvedSteps,
      currentIndex: 0,
    };
    loadSequenceStep(session, 0);
    if (resolvedSteps[0].autoStart !== false) {
      autoStartTimer(session);
    }
  });

  socket.on('skip-sequence-step', () => {
    if (role !== 'instructor' || !session || !session.activeSequence) return;
    stopTick(session);
    session.timerState.running = false;
    session.timerState.endTime = null;
    session.timerState.endTimeFormatted = '';
    if (session.sequenceAdvanceTimeout) {
      clearTimeout(session.sequenceAdvanceTimeout);
      session.sequenceAdvanceTimeout = null;
    }
    const nextIndex = session.activeSequence.currentIndex + 1;
    if (nextIndex >= session.activeSequence.steps.length) {
      clearSequenceState(session);
      broadcastSequenceState(session);
      broadcast(session);
      saveTimerState(instructorId, session);
    } else {
      loadSequenceStep(session, nextIndex);
    }
  });

  socket.on('stop-sequence', () => {
    if (role !== 'instructor' || !session) return;
    clearSequenceState(session);
    stopTick(session);
    session.timerState.running = false;
    session.timerState.endTime = null;
    session.timerState.endTimeFormatted = '';
    broadcastSequenceState(session);
    broadcast(session);
    saveTimerState(instructorId, session);
  });

  socket.on('get-sequence-state', () => {
    if (role !== 'instructor' || !session) return;
    broadcastSequenceState(session);
  });
});

// Legacy data migration removed — migration to per-instructor data completed.

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  await connectMongo();

  // Ensure at least one instructor account exists (seed)
  if (db) {
    const count = await db.collection('instructors').countDocuments();
    if (count === 0) {
      console.log('  No instructor accounts found — creating seed account.');
      console.log('  Email: peterpsavila@gmail.com');
      console.log('  Password: livetimer (change this after first login!)');
      try {
        await createInstructor('peterpsavila@gmail.com', 'livetimer', 'Peter', true);
      } catch (e) {
        console.error('  Failed to create seed account:', e.message);
      }
    }
  }

  // Pre-load sessions for all instructors who have data
  if (db) {
    const instructors = await db.collection('instructors').find({}).toArray();
    for (const inst of instructors) {
      const id = inst._id.toString();
      await initSession(id);
      console.log(`  Loaded session for ${inst.email} (code: ${getSession(id).classCode})`);
    }
  }

  server.listen(PORT, () => {
    console.log(`\n  LiveTimer is running!`);
    console.log(`   Instructor panel : http://localhost:${PORT}/instructor`);
    console.log(`   Student view     : http://localhost:${PORT}/`);
    console.log(`\n   Share the student URL (or QR code) with your class.\n`);
  });
})();
