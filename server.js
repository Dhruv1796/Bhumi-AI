const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.BHOOMI_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'dashboard.json');
const DEMO_PARCELS_FILE = path.join(DATA_DIR, 'demo_parcel.geojson');
const PARCELS_FILE = path.join(DATA_DIR, 'parcels.geojson');
const DOCUMENTS_DIR = path.join(DATA_DIR, 'documents');
const DB_PATH = process.env.BHOOMI_DB_PATH || path.join(DATA_DIR, 'bhoomi.db');
const db = new sqlite3.Database(DB_PATH);
let databaseReady;
const DEMO_USERS = {
  admin: {
    username: 'admin',
    fullname: 'Alex Williamson',
    role: 'Admin',
    password: 'admin123'
  },
  inspector: {
    username: 'inspector',
    fullname: 'Rohit Kulkarni',
    role: 'Inspector',
    password: 'inspector123'
  }
};

app.use(express.json({ limit: '8mb' }));
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/app.js', '/styles.css'], (req, res) => res.sendFile(path.join(__dirname, req.path.slice(1))));

function getRequestUser(req) {
  const authHeader = req.headers.authorization || '';
  return getUserFromToken(authHeader);
}

app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.user = user;
  return Promise.resolve(databaseReady)
    .then(() => next())
    .catch((error) => {
      console.error('Database initialization failed:', error);
      res.status(503).json({ error: 'The application database is unavailable.' });
    });
});

function getUserFromToken(token) {
  if (!token || typeof token !== 'string') return null;

  const normalized = token.startsWith('Bearer ') ? token.slice(7) : token;
  if (!normalized.startsWith('demo:')) return null;

  const username = normalized.slice(5);
  const user = DEMO_USERS[username];
  return user ? { username: user.username, fullname: user.fullname, role: user.role } : null;
}

function loadParcelCollection() {
  for (const file of [PARCELS_FILE, DEMO_PARCELS_FILE]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
        return parsed;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Parcel data unavailable at ${file}:`, error.message);
      }
    }
  }

  return { type: 'FeatureCollection', features: [] };
}

let parcelCollection = loadParcelCollection();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      resolve(row);
    });
  });
}

async function addColumnIfMissing(table, column, definition) {
  const columns = await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (error, rows) => {
      if (error) return reject(error);
      resolve(rows || []);
    });
  });
  if (!columns.some((entry) => entry.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureDatabase() {
  await fs.promises.mkdir(DOCUMENTS_DIR, { recursive: true });
  await run(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      village TEXT NOT NULL,
      documentType TEXT DEFAULT 'Mutation Record',
      status TEXT DEFAULT 'Pending',
      progress INTEGER DEFAULT 35,
      latitude REAL,
      longitude REAL
    )
  `);
  await addColumnIfMissing('records', 'latitude', 'REAL');
  await addColumnIfMissing('records', 'longitude', 'REAL');
  await run(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      recordId TEXT NOT NULL,
      filename TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      filePath TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Received',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const row = await get('SELECT COUNT(*) AS count FROM records');
  if (Number(row?.count) === 0) {
    const dashboard = JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8'));
    for (const record of dashboard.records || []) {
      await run(
        'INSERT OR IGNORE INTO records (id, owner, village, documentType, status, progress, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          record.id,
          record.owner || 'Unknown Owner',
          record.village || 'Unknown Village',
          record.documentType || 'Mutation Record',
          record.status || 'Pending',
          Number(record.progress || 35),
          record.latitude ?? null,
          record.longitude ?? null
        ]
      );
    }
  }
}

function getRecordsFromDb() {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, owner, village, documentType, status, progress, latitude, longitude FROM records ORDER BY rowid DESC',
      (error, rows) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(
          (rows || []).map((row) => ({
            ...row,
            progress: Number(row.progress || 0),
            latitude: row.latitude === null ? null : Number(row.latitude),
            longitude: row.longitude === null ? null : Number(row.longitude)
          }))
        );
      }
    );
  });
}

app.get('/api/dashboard', async (req, res) => {
  try {
    const dashboard = JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8'));
    const records = await getRecordsFromDb();
    res.json({
      ...dashboard,
      metrics: [
        { label: 'Total Records', value: records.length.toLocaleString(), change: 'in registry', trendDirection: 'up', color: '#45c77d', line: 'M2 16 C14 18, 22 9, 30 10 S46 20, 58 12 S70 6, 78 9' },
        { label: 'Approved', value: records.filter((record) => record.status === 'Approved').length.toLocaleString(), change: 'current total', trendDirection: 'up', color: '#4cc6a5', line: 'M2 12 C12 10, 24 15, 34 17 S48 8, 58 10 S72 16, 78 12' },
        { label: 'Pending Review', value: records.filter((record) => /pending|review/i.test(record.status)).length.toLocaleString(), change: 'current total', trendDirection: 'down', color: '#f4a261', line: 'M2 15 C10 16, 24 10, 34 12 S48 13, 58 8 S70 9, 78 14' }
      ],
      records
    });
  } catch (error) {
    console.error('Failed to read dashboard data:', error);
    res.status(500).json({ error: 'Dashboard data unavailable' });
  }
});

app.get('/api/records', async (req, res) => {
  try {
    const records = await getRecordsFromDb();
    res.json(records);
  } catch (error) {
    console.error('Failed to read records:', error);
    res.status(500).json({ error: 'Records unavailable' });
  }
});

app.post('/api/records', async (req, res) => {
  try {
    const { id, owner, village, documentType, status = 'Pending', progress = 35, latitude = null, longitude = null } = req.body || {};

    if (![id, owner, village].every((value) => typeof value === 'string' && value.trim())) {
      return res.status(400).json({ error: 'Record id, owner, and village are required.' });
    }
    if (latitude !== null && (!Number.isFinite(Number(latitude)) || Number(latitude) < -90 || Number(latitude) > 90)) {
      return res.status(400).json({ error: 'Latitude must be between -90 and 90.' });
    }
    if (longitude !== null && (!Number.isFinite(Number(longitude)) || Number(longitude) < -180 || Number(longitude) > 180)) {
      return res.status(400).json({ error: 'Longitude must be between -180 and 180.' });
    }

    const record = {
      id: id.trim(),
      owner: owner.trim(),
      village: village.trim(),
      documentType: typeof documentType === 'string' ? documentType : 'Mutation Record',
      status: typeof status === 'string' ? status : 'Pending',
      progress: Number(progress),
      latitude: latitude === null ? null : Number(latitude),
      longitude: longitude === null ? null : Number(longitude)
    };
    if (!['Pending', 'Review', 'In Review', 'Approved', 'Rejected'].includes(record.status)) {
      return res.status(400).json({ error: 'Invalid record status.' });
    }
    if (!Number.isInteger(record.progress) || record.progress < 0 || record.progress > 100) {
      return res.status(400).json({ error: 'Progress must be a whole number from 0 to 100.' });
    }

    const inserted = await run(
      'INSERT INTO records (id, owner, village, documentType, status, progress, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [record.id, record.owner, record.village, record.documentType, record.status, record.progress, record.latitude, record.longitude]
    ).catch(async (error) => {
      if (error.code !== 'SQLITE_CONSTRAINT') throw error;
      const existing = await get(
        'SELECT id, owner, village, documentType, status, progress, latitude, longitude FROM records WHERE id = ?',
        [record.id]
      );
      if (!existing) throw error;
      return { changes: 0, existing };
    });

    if (!inserted.changes && inserted.existing) {
      return res.json({
        ...inserted.existing,
        progress: Number(inserted.existing.progress),
        latitude: inserted.existing.latitude === null ? null : Number(inserted.existing.latitude),
        longitude: inserted.existing.longitude === null ? null : Number(inserted.existing.longitude),
        alreadyExists: true
      });
    }
    return res.status(201).json(record);
  } catch (error) {
    console.error('Failed to add record:', error);
    res.status(500).json({ error: 'Unable to add record' });
  }
});

app.patch('/api/records/:id', async (req, res) => {
  try {
    const { status, progress } = req.body || {};
    const recordId = req.params.id;

    const existing = await new Promise((resolve, reject) => {
      db.get(
        'SELECT id, owner, village, documentType, status, progress, latitude, longitude FROM records WHERE id = ?',
        [recordId],
        (error, row) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(row || null);
        }
      );
    });

    if (!existing) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const nextStatus = status || existing.status;
    const nextProgress = progress !== undefined ? Number(progress) : Number(existing.progress);
    if (!['Pending', 'Review', 'In Review', 'Approved', 'Rejected'].includes(nextStatus)
      || !Number.isInteger(nextProgress) || nextProgress < 0 || nextProgress > 100) {
      return res.status(400).json({ error: 'Invalid status or progress value.' });
    }

    await run('UPDATE records SET status = ?, progress = ? WHERE id = ?', [nextStatus, nextProgress, recordId]);

    res.json({ ...existing, status: nextStatus, progress: nextProgress });
  } catch (error) {
    console.error('Failed to update record:', error);
    res.status(500).json({ error: 'Unable to update record' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = DEMO_USERS[username];

  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = `demo:${username}`;
  return res.json({ token, user: { username: user.username, fullname: user.fullname, role: user.role } });
});

app.get('/api/me', (req, res) => {
  const user = getRequestUser(req);

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  return res.json({ user: { ...user } });
});

app.get('/api/parcels', (req, res) => {
  return res.json(parcelCollection);
});

app.post('/api/parcels', (req, res) => {
  const { geojson, name } = req.body || {};

  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    return res.status(400).json({ error: 'A valid GeoJSON FeatureCollection is required.' });
  }

  const nextCollection = {
    ...geojson,
    name: name || geojson.name || 'Imported parcel layer'
  };

  fs.promises.writeFile(PARCELS_FILE, JSON.stringify(nextCollection, null, 2), 'utf8')
    .then(() => {
      parcelCollection = nextCollection;
      return res.status(201).json({
        name: parcelCollection.name,
        featureCount: parcelCollection.features.length,
        geojson: parcelCollection
      });
    })
    .catch((error) => {
      console.error('Failed to save parcel data:', error);
      return res.status(500).json({ error: 'Unable to save parcel data.' });
    });
});

app.get('/api/documents', (req, res) => {
  db.all(
    'SELECT id, recordId, filename, mimeType, status, createdAt FROM documents ORDER BY createdAt DESC',
    (error, rows) => {
      if (error) {
        console.error('Failed to read documents:', error);
        return res.status(500).json({ error: 'Documents unavailable.' });
      }
      return res.json(rows || []);
    }
  );
});

app.post('/api/documents', async (req, res) => {
  const { recordId, filename, mimeType, fileContent } = req.body || {};
  if (typeof recordId !== 'string' || !recordId.trim()) {
    return res.status(400).json({ error: 'A record ID is required for the document.' });
  }
  if (typeof filename !== 'string' || !filename.trim() || typeof fileContent !== 'string') {
    return res.status(400).json({ error: 'Choose a PDF or image file to upload.' });
  }

  const extension = path.extname(filename).toLowerCase();
  const allowedTypes = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
  };
  if (!allowedTypes[extension] || mimeType !== allowedTypes[extension]) {
    return res.status(400).json({ error: 'Only PDF, PNG, and JPEG documents are supported.' });
  }

  const base64 = fileContent.replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length > 7_000_000) {
    return res.status(400).json({ error: 'File is invalid or exceeds the 5 MB upload limit.' });
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'File is empty or exceeds the 5 MB upload limit.' });
  }

  try {
    const record = await get('SELECT id FROM records WHERE id = ?', [recordId.trim()]);
    if (!record) return res.status(404).json({ error: 'The selected record does not exist.' });

    const id = `DOC-${randomUUID()}`;
    const safeName = path.basename(filename).replace(/[^\w.-]/g, '_').slice(0, 120) || `document${extension}`;
    const filePath = path.join(DOCUMENTS_DIR, `${id}${extension}`);
    await fs.promises.writeFile(filePath, buffer, { flag: 'wx' });
    try {
      await run(
        'INSERT INTO documents (id, recordId, filename, mimeType, filePath, status) VALUES (?, ?, ?, ?, ?, ?)',
        [id, recordId.trim(), safeName, allowedTypes[extension], filePath, 'Received']
      );
    } catch (error) {
      await fs.promises.unlink(filePath);
      throw error;
    }
    return res.status(201).json({
      id,
      recordId: recordId.trim(),
      filename: safeName,
      mimeType: allowedTypes[extension],
      status: 'Received',
      message: 'Document stored. OCR processing is not configured in this demo.'
    });
  } catch (error) {
    console.error('Failed to save document:', error);
    return res.status(500).json({ error: 'Unable to save the uploaded document.' });
  }
});

app.get('/api/documents/:id/file', (req, res) => {
  db.get('SELECT filename, mimeType, filePath FROM documents WHERE id = ?', [req.params.id], (error, document) => {
    if (error) {
      console.error('Failed to look up document:', error);
      return res.status(500).json({ error: 'Document unavailable.' });
    }
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    return res.download(document.filePath, document.filename, (downloadError) => {
      if (downloadError && !res.headersSent) {
        console.error('Failed to download document:', downloadError);
        res.status(500).json({ error: 'Unable to download the document.' });
      }
    });
  });
});

app.all('/api/*', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

databaseReady = ensureDatabase();
databaseReady.catch((error) => console.error('Database initialization failed:', error));

app.listen(PORT, () => {
  console.log(`Bhumi AI backend running at http://localhost:${PORT}`);
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  console.error('Unhandled request error:', error);
  return res.status(500).json({ error: 'Unexpected server error.' });
});
