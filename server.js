// done by:
// https://github.com/Marianuo/project3
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const fileUpload = require('express-fileupload');
const session = require('express-session');

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// how long to keep a finished output if user never downloads (ms)
const AUTO_CLEAN_MS = 2 * 60 * 1000; // 2 minutes

// ---------- View engine ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- Middleware ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB guard
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));

// Ensure required folders exist
const dbDir = path.join(__dirname, 'db');
const uploadsDir = path.join(__dirname, 'uploads'); // for profile pictures
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ---------- DB setup ----------
const db = new sqlite3.Database(path.join(dbDir, 'users.db'));
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    dob TEXT,
    profile_pic TEXT
  )
`);

// ---------- Helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function tempPath(name) {
  return path.join(os.tmpdir(), name);
}

// In-memory jobs:
// jobId -> { userId, proc, lines:[], done:false, inputPath, outputPath, token:null, stopped:false, cleanTimer:null }
const jobs = new Map();

// Only show high-level markers
function shouldShow(line) {
  return (
    line.startsWith('[start]') ||
    line.startsWith('[progress]') ||
    line.startsWith('[alert]') ||
    line.startsWith('[done]') ||
    line.startsWith('[info]') ||
    line.startsWith('[error]') ||
    line.startsWith('[stopped]')
  );
}
function pushLine(jobId, text) {
  const j = jobs.get(jobId);
  if (!j) return;
  const line = String(text).trim();
  // de-dupe consecutive identical lines
  if (j.lines.length && j.lines[j.lines.length - 1] === line) return;
  j.lines.push(line);
  if (j.lines.length > 500) j.lines.splice(0, j.lines.length - 500);
}

// Resolve a REAL Python executable path (fixes Windows code 9009)
function resolvePythonExe() {
  if (process.platform === 'win32') {
    // (a) Ask `py` which interpreter it launches
    try {
      const r = spawnSync('py', ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8',
        shell: true,
      });
      const exe = r.stdout && r.stdout.trim();
      if (r.status === 0 && exe && fs.existsSync(exe)) return exe;
    } catch {}

    // (b) Use `where python`
    try {
      const r = spawnSync('where', ['python'], { encoding: 'utf8' });
      if (r.status === 0) {
        const exe = r.stdout.split(/\r?\n/).find(s => s && s.toLowerCase().endsWith('.exe'));
        if (exe && fs.existsSync(exe.trim())) return exe.trim();
      }
    } catch {}

    // (c) Guess common install locations
    const guesses = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
      'C:\\Python313', 'C:\\Python312', 'C:\\Python311', 'C:\\Python310',
    ].filter(Boolean);

    for (const root of guesses) {
      try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && /^Python3\d+$/i.test(e.name)) {
            const candidate = path.join(root, e.name, 'python.exe');
            if (fs.existsSync(candidate)) return candidate;
          }
        }
      } catch {}
    }
    return null;
  } else {
    // Linux/Mac
    for (const c of ['python3', 'python']) {
      const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
      if (!r.error) return c;
    }
    return null;
  }
}
const PYTHON_EXE = resolvePythonExe();

// Cross-platform process kill (best-effort)
function killProcess(proc, cb) {
  if (!proc || proc.killed) return cb && cb();
  if (process.platform === 'win32') {
    // kills process and its children
    exec(`taskkill /PID ${proc.pid} /T /F`, () => cb && cb());
  } else {
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (!proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
      }
      cb && cb();
    }, 500);
  }
}

async function safeUnlink(p) {
  try { if (p) await fs.promises.unlink(p); } catch {}
}

function scheduleAutoClean(jobId) {
  const j = jobs.get(jobId);
  if (!j) return;
  if (j.cleanTimer) clearTimeout(j.cleanTimer);
  j.cleanTimer = setTimeout(async () => {
    const jj = jobs.get(jobId);
    if (!jj) return;
    await safeUnlink(jj.outputPath); // delete output if it still exists
    jobs.delete(jobId);
  }, AUTO_CLEAN_MS);
}

// ---------- Auth & pages ----------

// Signup GET
app.get('/signup', (req, res) => {
  res.render('signup', { message: null });
});

// Signup POST
app.post('/signup', async (req, res) => {
  const { first_name, last_name, username, email, password, dob } = req.body;
  const profilePic = req.files?.profile_pic;

  if (!profilePic) {
    return res.render('signup', { message: 'Please upload a profile picture.' });
  }

  try {
    const extension = path.extname(profilePic.name);
    const sanitizedUsername = username.replace(/[^a-zA-Z0-9]/g, '');
    const uniqueFilename = `${sanitizedUsername}_${Date.now()}${extension}`;
    const uploadPath = path.join(uploadsDir, uniqueFilename);
    await profilePic.mv(uploadPath);

    const hashedPassword = await bcrypt.hash(password, 10);

    db.run(
      `INSERT INTO users (username, password, first_name, last_name, email, dob, profile_pic)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, hashedPassword, first_name, last_name, email, dob, uniqueFilename],
      function (err) {
        if (err) {
          console.error(err);
          return res.render('signup', { message: 'Username or email might already exist.' });
        }
        res.redirect('/login');
      }
    );
  } catch (error) {
    console.error(error);
    res.render('signup', { message: 'An error occurred. Please try again.' });
  }
});

// Login GET

app.get('/', (req, res) => {
  res.render('login', { message: null });
});

app.get('/login', (req, res) => {
  res.render('login', { message: null });
});

// Login POST
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err) {
      console.error(err);
      return res.render('login', { message: 'Server error. Please try again later.' });
    }

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('login', { message: 'Invalid username or password.' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      dob: user.dob,
      profile_pic: user.profile_pic
    };

    res.redirect('/homepage');
  });
});

// Homepage (only for logged-in users)
app.get('/homepage', requireAuth, (req, res) => {
  db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, user) => {
    if (err || !user) {
      return res.send('Error loading user data.');
    }
    res.render('homepage', { user });
  });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.send('Error logging out.');
    res.redirect('/login');
  });
});

// Serve profile pictures (only allow the logged-in user to fetch their own)
app.get('/profile-pic/:filename', (req, res) => {
  if (!req.session.user) return res.status(403).send('Unauthorized');
  const expected = req.session.user.profile_pic;
  if (req.params.filename !== expected) return res.status(403).send('Forbidden');

  const filePath = path.join(uploadsDir, req.params.filename);
  res.sendFile(filePath, err => {
    if (err) res.status(404).send('Image not found');
  });
});

// ---Python processing chatgpt helped alot here because there's things I do not know how to do such as
//storing files in OS temp or giving a file a random uid or processing a python file at all 
//important to note that i included the yolov8 poses weights in the project files, usually
//these will be downloaded to a new user I dont want you downloading stuff u dont need on ur pc.
//overall was a good learning process

app.post('/process-video', requireAuth, async (req, res) => {
  try {
    const file = req.files?.video;
    if (!file) return res.status(400).json({ error: 'No video uploaded' });

    const allowed = ['video/mp4', 'video/quicktime'];
    if (!allowed.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Unsupported video type' });
    }

    const ext = path.extname(file.name).toLowerCase();
    const base = crypto.randomUUID();
    const inputPath  = tempPath(`${base}${ext}`);
    const outputPath = tempPath(`${base}_out.mp4`);
    await file.mv(inputPath);

    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
      userId: req.session.user.id,
      proc: null,
      lines: [],
      done: false,
      inputPath,
      outputPath,
      token: null,
      stopped: false,
      cleanTimer: null
    });

    if (!PYTHON_EXE) {
      pushLine(jobId, '[error] Could not locate a Python interpreter on this system.');
      const j = jobs.get(jobId); j.done = true;
      // delete input immediately since we're not proceeding
      await safeUnlink(inputPath);
      return res.json({ jobId });
    }

    pushLine(jobId, `[info] using python: ${PYTHON_EXE}`);
    pushLine(jobId, `[start] input=${inputPath} output=${outputPath}`);

    const py = spawn(
      PYTHON_EXE,
      ['main.py', '--input', inputPath, '--output', outputPath],
      {
        cwd: __dirname,
        env: { ...process.env },
        shell: false, // real exe path;
      }
    );
    jobs.get(jobId).proc = py;

    py.on('error', (err) => {
      pushLine(jobId, `[error] failed to start Python: ${err.message}`);
      const j = jobs.get(jobId); if (j) j.done = true;
      // input best-effort delete
      safeUnlink(inputPath);
    });

    py.stdout.on('data', (d) => {
      const t = d.toString();
      if (shouldShow(t)) pushLine(jobId, t);
    });

    py.stderr.on('data', (d) => {
      const t = d.toString();
      if (t.includes('Downloading')) return; // hide Ultralytics weight download spam
      if (shouldShow(t)) pushLine(jobId, `[stderr] ${t}`);
    });

    py.on('close', async (code) => {
      const j = jobs.get(jobId);
      if (!j) return;

      // Always delete the uploaded input immediately
      await safeUnlink(inputPath);

      if (j.stopped) {
        // User pressed Stop: remove output if created
        await safeUnlink(outputPath);
        j.done = true;
        j.token = null;
        pushLine(jobId, `[stopped] job terminated by user`);
        scheduleAutoClean(jobId); // will just delete job entry soon
      } else if (code === 0 && fs.existsSync(outputPath)) {
        // Generate one-time token; file is kept ONLY until download or timeout
        j.token = crypto.randomUUID();
        j.done = true;
        pushLine(jobId, `[done] saved=${outputPath}`);
        pushLine(jobId, `[info] process exited with code 0`);
        scheduleAutoClean(jobId); // short (2 mins)
      } else {
        j.done = true;
        pushLine(jobId, `[error] process exited with code ${code}`);
        await safeUnlink(outputPath); // nothing to download, remove output
        scheduleAutoClean(jobId); // short TTL (2 mins)
      }
    });

    return res.json({ jobId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to start job' });
  }
});

// Poll progress; returns one-time download URL when ready
app.get('/jobs/:jobId/status', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.json({ error: 'Unknown job id' });

  if (job.userId !== req.session.user.id) return res.json({ error: 'Forbidden' });

  const lines = job.lines.splice(0, job.lines.length); // drain
  const outputUrl = (job.done && job.token) ? `/d/${job.token}` : null;
  res.json({ lines, done: job.done, outputUrl });
});

// Stop an in-flight job
app.post('/jobs/:jobId/stop', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job id' });
  if (job.userId !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (job.done) return res.json({ success: true });

  job.stopped = true;
  const proc = job.proc;

  killProcess(proc, async () => {
    // cleanup files best-effort
    await safeUnlink(job.inputPath);
    await safeUnlink(job.outputPath);

    job.done = true;
    job.token = null;
    if (!job.lines) job.lines = [];
    job.lines.push('[stopped] Job killed by user');

    scheduleAutoClean(req.params.jobId); // short 
    return res.json({ success: true });
  });
});

//One-time download: stream file and delete after sending
app.get('/d/:token', requireAuth, (req, res) => {
  const entry = [...jobs.entries()].find(([, j]) => j.token === req.params.token);
  if (!entry) return res.status(404).send('Not found');

  const [jobId, job] = entry;

  if (job.userId !== req.session.user.id) return res.status(403).send('Forbidden');

  const filePath = job.outputPath;
  if (!filePath || !fs.existsSync(filePath)) {
    jobs.delete(jobId);
    return res.status(410).send('Gone');
  }

  // make token one-time
  job.token = null;

  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  const cleanup = async () => {
    await safeUnlink(filePath);      // delete output immediately after sending
    if (job.cleanTimer) clearTimeout(job.cleanTimer);
    jobs.delete(jobId);
  };
  stream.on('close', cleanup);
  stream.on('error', cleanup);
});

//Start server 
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
