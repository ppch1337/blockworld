require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required in production. Add a managed PostgreSQL connection string.');
    process.exit(1);
  }
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    console.error('SESSION_SECRET must be set to a unique random string of at least 32 characters in production.');
    process.exit(1);
  }
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10kb' }));

let pool = null;
let PgSessionStore = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  PgSessionStore = require('connect-pg-simple')(session);
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Managed PostgreSQL providers such as Neon require TLS.
    ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  pool.on('error', err => console.error('Unexpected PostgreSQL pool error:', err.message));
}

const sessionOptions = {
  name: 'blockworld.sid',
  secret: SESSION_SECRET || 'local-development-secret-change-before-deploying-123456',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
};
if (pool) {
  sessionOptions.store = new PgSessionStore({ pool, createTableIfMissing: true, tableName: 'user_sessions' });
}
app.use(session(sessionOptions));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.display_name || user.displayName || user.username,
    bio: user.bio || '',
    createdAt: user.created_at || user.createdAt || null
  };
}
function requireFields(body, fields) {
  return fields.every(field => typeof body[field] === 'string' && body[field].trim().length > 0);
}
function normalizeUser(row) {
  return row ? { id: Number(row.id), username: row.username, email: row.email, password_hash: row.password_hash } : null;
}

async function findUserByLogin(login) {
  if (pool) {
    const result = await pool.query(
      'SELECT id, username, email, password_hash FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1',
      [login]
    );
    return normalizeUser(result.rows[0]);
  }
  // Local fallback for testing only. On Render, DATABASE_URL is required.
  const fs = require('fs');
  const dataDir = path.join(__dirname, 'data');
  const usersFile = path.join(dataDir, 'users.json');
  try {
    return (JSON.parse(fs.readFileSync(usersFile, 'utf8')) || []).find(user =>
      user.username.toLowerCase() === login.toLowerCase() || user.email.toLowerCase() === login.toLowerCase()
    ) || null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function createUser(username, email, passwordHash) {
  if (pool) {
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, password_hash',
      [username, email, passwordHash]
    );
    return normalizeUser(result.rows[0]);
  }
  const fs = require('fs');
  const dataDir = path.join(__dirname, 'data');
  const usersFile = path.join(dataDir, 'users.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let users = [];
  try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (users.some(user => user.username.toLowerCase() === username.toLowerCase() || user.email.toLowerCase() === email.toLowerCase())) {
    const duplicate = new Error('duplicate'); duplicate.code = '23505'; throw duplicate;
  }
  const user = { id: users.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1, username, email, password_hash: passwordHash, created_at: new Date().toISOString() };
  users.push(user);
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), { encoding: 'utf8', mode: 0o600 });
  return user;
}

async function initializeDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL is not set: using local JSON account storage and in-memory sessions. Do not use this mode for public hosting.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(20) NOT NULL,
      email VARCHAR(254) NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (lower(username))');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email))');
  // Add profile fields safely for existing accounts; existing users are preserved.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(30) NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(160) NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_outfit JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS currency BIGINT NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_claimed_at TIMESTAMPTZ");
  await pool.query(`CREATE TABLE IF NOT EXISTS user_inventory (user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id VARCHAR(80) NOT NULL, purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, item_id))`);
  await pool.query("UPDATE users SET display_name = username WHERE display_name = ''");
  await pool.query('SELECT 1');
  console.log('Connected to PostgreSQL; account tables are ready.');
}

app.post('/api/signup', authLimiter, async (req, res) => {
  const body = req.body || {};
  const { username, email, password } = body;
  if (!requireFields(body, ['username', 'email', 'password'])) {
    return res.status(400).json({ error: 'Please fill in every field.' });
  }
  const cleanUsername = username.trim();
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters and use only letters, numbers, or underscores.' });
  }
  if (cleanEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
  }

  try {
    const existingUsername = await findUserByLogin(cleanUsername);
    if (existingUsername && existingUsername.username.toLowerCase() === cleanUsername.toLowerCase()) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    const existingEmail = await findUserByLogin(cleanEmail);
    if (existingEmail && existingEmail.email.toLowerCase() === cleanEmail) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser(cleanUsername, cleanEmail, passwordHash);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Account created, but sign-in failed. Please log in.' });
      req.session.userId = user.id;
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ error: 'Account created, but sign-in failed. Please log in.' });
        return res.status(201).json({ user: publicUser(user) });
      });
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That username or email is already registered.' });
    console.error('Signup error:', error.message);
    return res.status(500).json({ error: 'Could not create account right now.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const body = req.body || {};
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Enter your username/email and password.' });
  }
  try {
    const user = await findUserByLogin(username.trim());
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect username/email or password.' });
    }
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Could not start your session. Please try again.' });
      req.session.userId = user.id;
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ error: 'Could not save your session. Please try again.' });
        return res.json({ user: publicUser(user) });
      });
    });
  } catch (error) {
    console.error('Login error:', error.message);
    return res.status(500).json({ error: 'Could not log in right now.' });
  }
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  try {
    let user;
    if (pool) {
      const result = await pool.query('SELECT id, username, email, display_name, bio, created_at FROM users WHERE id = $1', [req.session.userId]);
      user = result.rows[0];
    } else {
      const fs = require('fs');
      const usersFile = path.join(__dirname, 'data', 'users.json');
      try { user = JSON.parse(fs.readFileSync(usersFile, 'utf8')).find(item => item.id === req.session.userId); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!user) return req.session.destroy(() => res.json({ user: null }));
    return res.json({ user: publicUser(user) });
  } catch (error) {
    console.error('Session lookup error:', error.message);
    return res.status(500).json({ error: 'Could not load account right now.' });
  }
});

// Public profile lookup: never return email addresses or password hashes.
app.get('/api/profile/:username', async (req, res) => {
  const username = String(req.params.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Enter a valid username.' });
  try {
    if (!pool) {
      const fs = require('fs');
      const usersFile = path.join(__dirname, 'data', 'users.json');
      let users = [];
      try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const user = users.find(item => item.username.toLowerCase() === username.toLowerCase());
      if (!user) return res.status(404).json({ error: 'We couldn’t find that player.' });
      return res.json({ profile: { username: user.username, displayName: user.display_name || user.displayName || user.username, bio: user.bio || '', createdAt: user.created_at || null, outfit: user.avatar_outfit || user.avatarOutfit || {} } });
    }
    const result = await pool.query(
      'SELECT username, display_name, bio, created_at, avatar_outfit FROM users WHERE lower(username) = lower($1) LIMIT 1',
      [username]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'We couldn’t find that player.' });
    return res.json({ profile: { username: user.username, displayName: user.display_name || user.username, bio: user.bio || '', createdAt: user.created_at, outfit: user.avatar_outfit || {} } });
  } catch (error) {
    console.error('Public profile lookup error:', error.message);
    return res.status(500).json({ error: 'Could not load that profile right now.' });
  }
});

app.post('/api/profile', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in to edit your profile.' });
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters and use only letters, numbers, or underscores.' });
  }
  if (displayName.length < 1 || displayName.length > 30) return res.status(400).json({ error: 'Display name must be 1–30 characters.' });
  if (bio.length > 160) return res.status(400).json({ error: 'Bio must be 160 characters or fewer.' });
  try {
    if (pool) {
      const result = await pool.query(
        'UPDATE users SET username = $1, display_name = $2, bio = $3 WHERE id = $4 RETURNING id, username, email, display_name, bio, created_at',
        [username, displayName, bio, req.session.userId]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Account not found. Please log in again.' });
      return res.json({ user: publicUser(result.rows[0]) });
    }
    const fs = require('fs');
    const usersFile = path.join(__dirname, 'data', 'users.json');
    let users = [];
    try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (users.some(item => item.id !== req.session.userId && item.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    const user = users.find(item => item.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'Account not found. Please log in again.' });
    user.username = username; user.display_name = displayName; user.bio = bio;
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), { encoding: 'utf8', mode: 0o600 });
    return res.json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    console.error('Profile update error:', error.message);
    return res.status(500).json({ error: 'Could not save your profile right now.' });
  }
});



const CATALOG_ITEMS = {
  'blockworld-tee': { name: 'BlockWorld Tee', price: 99 },
  'neon-crown': { name: 'Neon Dream Top Hat', price: 349 },
  'og': { name: 'og', price: 650 }
};
app.post('/api/avatar/outfit', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in to save your avatar.' });
  if (!pool) return res.status(503).json({ error: 'Avatar saving requires the connected database.' });
  const body = req.body || {};
  const outfit = {
    skinColor: /^#[0-9a-fA-F]{6}$/.test(body.skinColor || '') ? body.skinColor : '#ffd83d',
    shirt: body.shirt === 'pixel' ? 'pixel' : 'classic',
    hat: ['none','classic','neon','og'].includes(body.hat) ? body.hat : 'none',
    hairColor: /^#[0-9a-fA-F]{6}$/.test(body.hairColor || '') ? body.hairColor : '#473026',
    hairStyle: body.hairStyle === 'long' ? 'long' : 'short'
  };
  try {
    await pool.query('UPDATE users SET avatar_outfit = $1::jsonb WHERE id = $2', [JSON.stringify(outfit), req.session.userId]);
    return res.json({ success: true, outfit });
  } catch (error) {
    console.error('Avatar outfit save error:', error.message);
    return res.status(500).json({ error: 'Could not save your avatar right now.' });
  }
});

app.get('/api/catalog/owned', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in to view your inventory.' });
  if (!pool) return res.status(503).json({ error: 'Catalog purchases require the connected PostgreSQL database.' });
  try { const result = await pool.query('SELECT item_id FROM user_inventory WHERE user_id = $1', [req.session.userId]); return res.json({ items: result.rows.map(row => row.item_id) }); }
  catch (error) { console.error('Inventory lookup error:', error.message); return res.status(500).json({ error: 'Could not load your inventory.' }); }
});
app.post('/api/catalog/purchase', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in to buy items.' });
  if (!pool) return res.status(503).json({ error: 'Catalog purchases require the connected PostgreSQL database.' });
  const itemId = req.body && req.body.itemId;
  const item = CATALOG_ITEMS[itemId];
  if (!item) return res.status(400).json({ error: 'That item is not available.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const already = await client.query('SELECT item_id FROM user_inventory WHERE user_id = $1 AND item_id = $2', [req.session.userId, itemId]);
    if (already.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'You already own this item.' }); }
    const user = await client.query('SELECT currency FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
    if (!user.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Account not found.' }); }
    const balance = Number(user.rows[0].currency || 0);
    if (balance < item.price) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'You need ' + (item.price - balance) + ' more coins to buy this item.' }); }
    const updated = await client.query('UPDATE users SET currency = currency - $1 WHERE id = $2 RETURNING currency', [item.price, req.session.userId]);
    await client.query('INSERT INTO user_inventory (user_id, item_id) VALUES ($1, $2)', [req.session.userId, itemId]);
    await client.query('COMMIT');
    return res.json({ success: true, itemId, balance: Number(updated.rows[0].currency) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Catalog purchase error:', error.message);
    return res.status(500).json({ error: 'Could not complete the purchase right now.' });
  } finally { client.release(); }
});

// Currency wallet and hourly reward. The server chooses the amount and enforces the cooldown.
app.get('/api/currency', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in to view your wallet.' });
  if (!pool) return res.status(503).json({ error: 'Currency requires the connected PostgreSQL database.' });
  try {
    const result = await pool.query(
      'SELECT currency, currency_claimed_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Account not found.' });
    const row = result.rows[0];
    const lastClaim = row.currency_claimed_at ? new Date(row.currency_claimed_at).getTime() : null;
    const nextClaimAt = lastClaim === null ? null : lastClaim + 60 * 60 * 1000;
    return res.json({
      balance: Number(row.currency || 0),
      canClaim: nextClaimAt === null || Date.now() >= nextClaimAt,
      nextClaimAt: nextClaimAt === null ? null : new Date(nextClaimAt).toISOString()
    });
  } catch (error) {
    console.error('Currency lookup error:', error.message);
    return res.status(500).json({ error: 'Could not load your wallet right now.' });
  }
});

app.post('/api/currency/claim', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in to claim currency.' });
  if (!pool) return res.status(503).json({ error: 'Currency requires the connected PostgreSQL database.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT currency, currency_claimed_at FROM users WHERE id = $1 FOR UPDATE',
      [req.session.userId]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.' });
    }
    const row = result.rows[0];
    const now = Date.now();
    const lastClaim = row.currency_claimed_at ? new Date(row.currency_claimed_at).getTime() : null;
    const nextClaimAt = lastClaim === null ? null : lastClaim + 60 * 60 * 1000;
    if (nextClaimAt !== null && now < nextClaimAt) {
      await client.query('ROLLBACK');
      return res.status(429).json({
        error: 'Your next reward is not ready yet.',
        balance: Number(row.currency || 0),
        nextClaimAt: new Date(nextClaimAt).toISOString()
      });
    }
    const reward = Math.floor(Math.random() * 401) + 100;
    const updated = await client.query(
      'UPDATE users SET currency = currency + $1, currency_claimed_at = NOW() WHERE id = $2 RETURNING currency, currency_claimed_at',
      [reward, req.session.userId]
    );
    await client.query('COMMIT');
    return res.json({
      reward,
      balance: Number(updated.rows[0].currency),
      nextClaimAt: new Date(new Date(updated.rows[0].currency_claimed_at).getTime() + 60 * 60 * 1000).toISOString()
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Currency claim error:', error.message);
    return res.status(500).json({ error: 'Could not claim your reward right now.' });
  } finally {
    client.release();
  }
});

app.post('/api/account/deletion-request', authLimiter, async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in to request account deletion.' });
  const ownerEmail = process.env.OWNER_EMAIL;
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFrom = process.env.RESEND_FROM || 'BlockWorld <onboarding@resend.dev>';
  if (!ownerEmail || !resendApiKey) {
    return res.status(503).json({ error: 'Account deletion email is not configured yet. Please contact the site owner directly.' });
  }
  try {
    let user;
    if (pool) {
      const result = await pool.query('SELECT username, email, created_at FROM users WHERE id = $1', [req.session.userId]);
      user = result.rows[0];
    } else {
      const fs = require('fs');
      const usersFile = path.join(__dirname, 'data', 'users.json');
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      user = users.find(item => item.id === req.session.userId);
    }
    if (!user) return res.status(404).json({ error: 'Account not found. Please log in again.' });
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [ownerEmail],
        reply_to: user.email,
        subject: `BlockWorld account deletion request: ${user.username}`,
        text: `A player has requested account deletion.\n\nUsername: ${user.username}\nAccount email: ${user.email}\nAccount created: ${user.created_at || 'unknown'}\n\nThis is a request only. No account has been deleted. Please review and process it manually.`
      }),
      signal: AbortSignal.timeout(15000)
    });
    const emailResult = await emailResponse.json().catch(() => ({}));
    if (!emailResponse.ok) {
      console.error('Account deletion request email failed: Resend API returned', emailResponse.status, emailResult.message || emailResult.name || 'unknown error');
      return res.status(502).json({ error: 'The email service rejected the deletion request. Please try again later.' });
    }
    return res.json({ ok: true, message: 'Deletion request sent.' });
  } catch (error) {
    console.error('Account deletion request email failed:', error.message);
    return res.status(500).json({ error: 'Could not email the deletion request. Please try again later.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    res.clearCookie('blockworld.sid', { httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production' });
    if (err) return res.status(500).json({ error: 'Could not log out. Please try again.' });
    return res.json({ ok: true });
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => console.log(`BlockWorld is running on port ${PORT}`));
  } catch (error) {
    console.error('Could not initialize BlockWorld database:', error.message);
    process.exit(1);
  }
}
start();
