const mongoose  = require('mongoose');
const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const sharp     = require('sharp');

// ── Admin routes ──
// Everything admin-only lives here: admin login/session handling and every
// /api/admin/* (or requireAdmin-protected) route. Registered by server.js via
//   require('./admin')(app, { ...models and shared helpers... });
// This module never requires server.js — the models and helper functions it
// needs (User, listing helpers, notifyUser, etc.) are handed in as `deps`
// instead, so there's no circular require between the two files.
module.exports = function registerAdminRoutes(app, deps) {
  const {
    User, VisitRequest, LISTING_MODEL_LIST,
    findListingById, updateListingById, deleteListingById, moveListingIfNeeded,
    NESTED_SECTIONS, validatePropertyFields, formatPrice,
    nextPropertyId, modelForStatus,
    notifyUser, visitCalendarMeta,
    HonestReview, Partner, PaymentSettings, PaymentRequest,
    SiteStat, DailyStat, todayStr, dateStrInTz, Referral,
    Review,
    ImageAsset,
    Visitor,
    PropertyView, PropertyViewer,
    UserSession, // force-logout action on the Customers grid (single-device login unlock)
  } = deps;

  // Empties a dedup collection completely (every document gone) without
  // touching its indexes. Used by the Visits/Views "reset" actions below.
  //
  // IMPORTANT: this must NOT be Model.collection.drop() — that removes the
  // collection's indexes along with its documents, and Mongoose does not
  // recreate them on its own afterwards (index creation only runs once, at
  // startup). PropertyView and PropertyViewer both rely on a unique index
  // to detect a repeat view (the create() call in POST /api/properties/:id/view
  // is expected to throw E11000 on a duplicate) — if that index were dropped,
  // every single page load, from every browser, would silently count as a
  // brand-new view forever afterwards (no more error to catch), permanently
  // breaking dedup until the process restarts. deleteMany({}) gets the same
  // "every visitor forgotten" result while leaving the index (and therefore
  // future dedup) intact.
  async function emptyCollection(Model) {
    await Model.deleteMany({});
  }

  if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD env vars are required in production (hardcoded admin/admin login is dev-only)');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── ADMIN LOGIN ──
  // Supports any number of admin accounts, each set via a numbered pair of env vars:
  //   ADMIN_EMAIL   / ADMIN_PASSWORD    (1st admin — required in production)
  //   ADMIN_EMAIL_2 / ADMIN_PASSWORD_2  (2nd admin — optional)
  //   ADMIN_EMAIL_3 / ADMIN_PASSWORD_3  (3rd admin — optional)
  //   ...and so on. Numbering must be consecutive — it stops at the first
  //   missing pair, so ADMIN_EMAIL_4 would be ignored if ADMIN_EMAIL_3 isn't set.
  // In dev (no ADMIN_EMAIL/ADMIN_PASSWORD set), falls back to admin@admin.com/admin.
  // In production, the env check above forces the first admin's real credentials to be set.
  // Sessions are stored in Mongo (not a JS Map) so they survive restarts/deploys —
  // important on free-tier hosting where the process restarts/cold-starts often.
  // ────────────────────────────────────────────────────────────────────────────
  // admin.html logs in with { email, password } and expects { adminKey, firstName } back,
  // then sends the key on every request as the 'x-admin-key' header — matched here.

  // Each account's password is hashed once at startup, never compared as a plain
  // string — closes the timing-attack gap a direct `password === ADMIN_PASSWORD`
  // check would have, and means the raw password only ever exists in process
  // memory for the comparison itself.
  function buildAdminAccounts() {
    const accounts = [{
      email: (process.env.ADMIN_EMAIL || 'admin@admin.com').toLowerCase(),
      passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin', 10),
    }];
    let i = 2;
    while (process.env[`ADMIN_EMAIL_${i}`] && process.env[`ADMIN_PASSWORD_${i}`]) {
      accounts.push({
        email: process.env[`ADMIN_EMAIL_${i}`].toLowerCase(),
        passwordHash: bcrypt.hashSync(process.env[`ADMIN_PASSWORD_${i}`], 10),
      });
      i++;
    }
    return accounts;
  }
  const ADMIN_ACCOUNTS = buildAdminAccounts();

  // Used when the submitted email doesn't match any admin, so we still run a
  // bcrypt.compare (against this instead of a real hash) — keeps a wrong-email
  // request and a wrong-password request taking the same amount of time.
  const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing-safety', 10);

  const ADMIN_NAME     = 'Admin';

  // ── DAILY 7 AM LOGIN ──
  // Every admin has to sign in again each day at 7:00 AM. A session is only
  // valid if it was created AFTER the most recent 7:00 AM, so everyone —
  // including sessions that were already open before this rule — is logged
  // out the moment 7:00 AM passes. Time zone is India (IST, UTC+5:30, no DST);
  // override with ADMIN_SESSION_RESET_HOUR / ADMIN_SESSION_TZ_OFFSET_MIN in .env.
  const SESSION_RESET_HOUR    = Number(process.env.ADMIN_SESSION_RESET_HOUR) || 7;
  const SESSION_TZ_OFFSET_MIN = process.env.ADMIN_SESSION_TZ_OFFSET_MIN !== undefined && process.env.ADMIN_SESSION_TZ_OFFSET_MIN !== ''
    ? Number(process.env.ADMIN_SESSION_TZ_OFFSET_MIN) : 330;
  const LEGACY_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // old sessions had no createdAt; they were issued with this TTL

  // The most recent 7:00 AM (local) at or before `now`, as a UTC Date.
  function lastResetBefore(now) {
    const off = SESSION_TZ_OFFSET_MIN * 60000;
    const local = new Date(now.getTime() + off);
    const r = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), SESSION_RESET_HOUR));
    if (r.getTime() > local.getTime()) r.setUTCDate(r.getUTCDate() - 1);
    return new Date(r.getTime() - off);
  }
  // The next 7:00 AM (local) after `now` — when a session issued now ends.
  function nextReset(now) {
    return new Date(lastResetBefore(now).getTime() + 24 * 60 * 60 * 1000);
  }

  const AdminSessionSchema = new mongoose.Schema({
    key:       { type: String, required: true, unique: true, index: true },
    // Which admin account this session belongs to — needed so requireAdmin
    // can tell the primary admin (ADMIN_EMAIL) apart from the numbered
    // sub-admins (ADMIN_EMAIL_2, _3, ...) and enforce per-feature access below.
    email:     { type: String, default: '' },
    // true for sessions issued by the single-device login (see the one-time purge below).
    single:    { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, expires: 0 }, // TTL index: Mongo auto-deletes once expiresAt passes (= next 7 AM)
  });

  const AdminSession = mongoose.model('AdminSession', AdminSessionSchema);

  // One-time cleanup: sessions from before single-device login (no `single` flag) never had a
  // working logout, so any left over would lock the account out. Drop them once at startup; every
  // session issued from now on carries the flag, so after the first run this deletes nothing.
  // (Anyone still on such a session just sees the login screen once.)
  AdminSession.deleteMany({ single: { $ne: true } }).catch(e => console.error('Legacy admin session purge failed:', e.message));

  async function issueAdminSession(email, single) {
    const key = crypto.randomBytes(32).toString('hex');
    await AdminSession.create({ key, email: email || '', single: !!single, createdAt: new Date(), expiresAt: nextReset(new Date()) });
    return key;
  }

  async function isValidAdminSession(key) {
    return !!(await getAdminSession(key));
  }

  // Returns the session doc (with email) for a key, or null. Used by
  // requireAdmin to attach req.adminEmail / req.isSuperAdmin. A session that
  // was created before the most recent 7:00 AM is treated as expired.
  async function getAdminSession(key) {
    if (!key) return null;
    const now = new Date();
    const session = await AdminSession.findOne({ key, expiresAt: { $gt: now } }).lean();
    if (!session) return null;
    const issuedAt = session.createdAt
      ? new Date(session.createdAt).getTime()
      : new Date(session.expiresAt).getTime() - LEGACY_SESSION_TTL_MS;
    if (issuedAt < lastResetBefore(now).getTime()) return null;
    return session;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ── SUB-ADMIN FEATURE PERMISSIONS ──
  // ADMIN_EMAIL (the first/primary admin account) is the "super admin" — it
  // always has full access and is the only account that can grant or revoke
  // features for the numbered sub-admins (ADMIN_EMAIL_2, ADMIN_EMAIL_3, ...).
  // Every feature is allowed by default for a sub-admin; the super admin can
  // switch individual features off per sub-admin from the "Admin Access" tab.
  // ────────────────────────────────────────────────────────────────────────────
  const SUPER_ADMIN_EMAIL = ADMIN_ACCOUNTS[0].email;

  // One entry per feature a sub-admin's access can be toggled for — keep this
  // list in sync with the requireModule(...) calls used on the routes below.
  const ADMIN_MODULES = {
    visits:        'Visits',
    customers:     'Customers',
    properties:    'Properties',
    appointments:  'Appointments',
    reviews:       'Honest Reviews',
    userReviews:   'Reviews',
    partners:      'Partners',
    referrals:     'Referrals',
    payments:      'Payments',
    stats:         'Visitor & Registration Stats',
    notifications: 'Admin Notifications',
  };

  // Per-button layer (finest level). Only the Action-column buttons of these
  // two tables are controllable. Keys MUST match the `pact-<key>` class on the
  // button's wrapper span in admin.html (and PROP_ACTION_BTNS / the customer
  // COL_TOGGLE_CONFIGS actions there). Default is allowed; super admin can
  // switch individual buttons off per sub-admin from the Admin Access modal.
  const ADMIN_BUTTONS = {
    properties: {
      publiccall: 'Public call toggle', block: 'Block / Unblock',
      check: 'Check availability', share: 'Share (WhatsApp)', tenant: 'Tenant share',
      view: 'View', navigate: 'Navigate', directions: 'Directions',
      facebook: 'Facebook', instagram: 'Instagram', delete: 'Delete', booking: 'Booking',
      // Top toolbar of the Properties tab (the floating buttons on mobile). Keys MUST
      // match TOOLBAR_BTN_SEL in admin.html. Not Action-column buttons, so no pact- class.
      tbAdd: 'Toolbar: Add property', tbCompare: 'Toolbar: Compare',
      tbTenant: 'Toolbar: Share to Tenant', tbShare: 'Toolbar: Share Links',
      tbCheck: 'Toolbar: Check Availability', tbRecalc: 'Toolbar: Recalculate Distance',
    },
    customers: {
      verified: 'Verified badge', view: 'View', whatsapp: 'WhatsApp', edit: 'Edit', subscription: 'Subscription',
      delete: 'Delete', logout: 'Force logout', resetviews: 'Reset views', publiccall: 'Public call toggle', block: 'Block / Unblock',
    },
  };

  const AdminPermissionSchema = new mongoose.Schema({
    email:   { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    // Explicit false = blocked for this sub-admin; missing/true = allowed
    // (allowed is the default so a freshly-added sub-admin isn't locked out
    // of everything until the super admin visits the Admin Access tab).
    // `modules` controls whether the sub-admin can see/read a feature at all
    // (its tab, its GET routes). `actions` is a second, finer-grained layer
    // on top: whether they can also add/edit/delete/verify/etc within a
    // feature they can already see. A sub-admin can be view-only in a module
    // (modules[key]=true, actions[key]=false) — they see the tab and its
    // data, but every button that changes something is hidden/blocked.
    modules: { type: Map, of: Boolean, default: {} },
    actions: { type: Map, of: Boolean, default: {} },
    // { <module>: { <buttonKey>: false } } — explicit false hides the button
    // and blocks its API route for this sub-admin. Missing/true = allowed.
    buttons: { type: mongoose.Schema.Types.Mixed }, // no default on purpose: a {} default can collide with dotted $set paths on upsert
  });
  const AdminPermission = mongoose.model('AdminPermission', AdminPermissionSchema);

  // Builds the full { moduleKey: boolean } map for an email — every key in
  // ADMIN_MODULES, defaulting to true unless a sub-admin's doc explicitly
  // sets it false. The super admin always gets every module true.
  async function getModulePermissions(email) {
    const full = {};
    for (const key of Object.keys(ADMIN_MODULES)) full[key] = true;
    if (email === SUPER_ADMIN_EMAIL) return full;
    const perm = await AdminPermission.findOne({ email }).lean();
    if (perm && perm.modules) {
      for (const [key, allowed] of Object.entries(perm.modules)) {
        if (key in full) full[key] = !!allowed;
      }
    }
    return full;
  }

  // Same shape as getModulePermissions, but for the action layer — whether
  // this email can perform mutating (add/edit/delete/verify/...) requests
  // within a module it can already view. Super admin always gets every
  // action true. A module the sub-admin can't even view is reported as
  // action-false too, since there's no meaningful "can edit something you
  // can't see" state.
  async function getActionPermissions(email) {
    const full = {};
    for (const key of Object.keys(ADMIN_MODULES)) full[key] = true;
    if (email === SUPER_ADMIN_EMAIL) return full;
    const perm = await AdminPermission.findOne({ email }).lean();
    if (perm) {
      for (const key of Object.keys(full)) {
        const moduleAllowed = !perm.modules || perm.modules[key] !== false;
        const actionAllowed = !perm.actions || perm.actions[key] !== false;
        full[key] = moduleAllowed && actionAllowed;
      }
    }
    return full;
  }

  // Full { module: { buttonKey: boolean } } map for an email. Raw saved flags
  // (default true) — not ANDed with module/action levels, so the Admin Access
  // modal can restore each switch's own state. Super admin: everything true.
  async function getButtonPermissions(email) {
    const full = {};
    for (const [mod, btns] of Object.entries(ADMIN_BUTTONS)) {
      full[mod] = {};
      for (const key of Object.keys(btns)) full[mod][key] = true;
    }
    if (email === SUPER_ADMIN_EMAIL) return full;
    const perm = await AdminPermission.findOne({ email }).lean();
    const saved = (perm && perm.buttons) || {};
    for (const mod of Object.keys(full)) {
      for (const key of Object.keys(full[mod])) {
        if (saved[mod] && saved[mod][key] === false) full[mod][key] = false;
      }
    }
    return full;
  }

  // Route-level gate for one specific button — chain AFTER requireModuleAction,
  // e.g. app.delete('/api/users/mobile/:mobile', requireAdmin,
  //   requireModuleAction('customers'), requireButton('customers','delete'), ...).
  // Keeps a hidden button's API route closed even if called by hand.
  function requireButton(moduleKey, buttonKey) {
    return async (req, res, next) => {
      try {
        if (req.isSuperAdmin) return next();
        const perm = await AdminPermission.findOne({ email: req.adminEmail }).lean();
        const blocked = perm && perm.buttons && perm.buttons[moduleKey] && perm.buttons[moduleKey][buttonKey] === false;
        if (blocked) {
          return res.status(403).json({ message: 'The primary admin has disabled this action for your account.' });
        }
        next();
      } catch (err) {
        console.error('requireButton error:', err);
        res.status(500).json({ message: 'Server error. Please try again.' });
      }
    };
  }

  // Route-level gate for a single feature — apply right after requireAdmin,
  // e.g. app.get('/api/users', requireAdmin, requireModule('customers'), ...).
  // The super admin always passes; a sub-admin is blocked only if the super
  // admin explicitly switched this module off for them.
  function requireModule(moduleKey) {
    return async (req, res, next) => {
      try {
        if (req.isSuperAdmin) return next();
        const perm = await AdminPermission.findOne({ email: req.adminEmail }).lean();
        const allowed = !perm || !perm.modules || perm.modules[moduleKey] !== false;
        if (!allowed) {
          return res.status(403).json({ message: 'Your admin account does not have access to this feature. Ask the primary admin to enable it.' });
        }
        next();
      } catch (err) {
        console.error('requireModule error:', err);
        res.status(500).json({ message: 'Server error. Please try again.' });
      }
    };
  }

  // Route-level gate for a MUTATING request within a feature (add/edit/
  // delete/verify/bulk-delete/etc) — apply in place of requireModule (not
  // in addition to it) on POST/PUT/PATCH/DELETE routes, e.g.
  //   app.delete('/api/properties/:id', requireAdmin, requireModuleAction('properties'), ...).
  // Blocks the request unless BOTH the module itself is viewable and the
  // action layer is allowed, so a sub-admin who can't see a feature at all
  // is also blocked from its write routes, and one who can see it but was
  // set view-only is blocked from anything that changes data.
  function requireModuleAction(moduleKey) {
    return async (req, res, next) => {
      try {
        if (req.isSuperAdmin) return next();
        const perm = await AdminPermission.findOne({ email: req.adminEmail }).lean();
        const moduleAllowed = !perm || !perm.modules || perm.modules[moduleKey] !== false;
        const actionAllowed = !perm || !perm.actions || perm.actions[moduleKey] !== false;
        if (!moduleAllowed || !actionAllowed) {
          return res.status(403).json({ message: 'Your admin account has view-only access to this feature. Ask the primary admin to enable actions.' });
        }
        next();
      } catch (err) {
        console.error('requireModuleAction error:', err);
        res.status(500).json({ message: 'Server error. Please try again.' });
      }
    };
  }

  // Same as requireModule / requireModuleAction, but passes if ANY of the listed
  // modules is allowed. Used by the Visits tab's data routes (total visits,
  // daily visits, users registered): the tab itself is toggled by the 'visits'
  // module, but its numbers were gated by 'stats' only — so a sub-admin with
  // Visits enabled saw an empty tab. Either permission now works.
  function requireAnyModule(...moduleKeys) {
    return async (req, res, next) => {
      try {
        if (req.isSuperAdmin) return next();
        const perm = await AdminPermission.findOne({ email: req.adminEmail }).lean();
        const allowed = moduleKeys.some(k => !perm || !perm.modules || perm.modules[k] !== false);
        if (!allowed) {
          return res.status(403).json({ message: 'Your admin account does not have access to this feature. Ask the primary admin to enable it.' });
        }
        next();
      } catch (err) {
        console.error('requireAnyModule error:', err);
        res.status(500).json({ message: 'Server error. Please try again.' });
      }
    };
  }

  function requireAnyModuleAction(...moduleKeys) {
    return async (req, res, next) => {
      try {
        if (req.isSuperAdmin) return next();
        const perm = await AdminPermission.findOne({ email: req.adminEmail }).lean();
        const allowed = moduleKeys.some(k =>
          (!perm || !perm.modules || perm.modules[k] !== false) &&
          (!perm || !perm.actions || perm.actions[k] !== false));
        if (!allowed) {
          return res.status(403).json({ message: 'Your admin account has view-only access to this feature. Ask the primary admin to enable actions.' });
        }
        next();
      } catch (err) {
        console.error('requireAnyModuleAction error:', err);
        res.status(500).json({ message: 'Server error. Please try again.' });
      }
    };
  }

  // Simple rate limiter on the login route to slow down brute-force attempts
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    message: { message: 'Too many login attempts. Please try again later.' }
  });

  // ── Login input validation ──
  // Rejects malformed input before any bcrypt work happens. Same email shape
  // check the rest of the app uses; the length caps keep absurd payloads out.
  const ADMIN_EMAIL_RE       = /^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[^\s@"'<>\\]+$/;
  const ADMIN_EMAIL_MAX      = 254;
  const ADMIN_PASSWORD_MAX   = 256;
  // Login id is either an email or a 10-digit mobile number (+91 / 0 prefix, spaces, dashes tolerated).
  function normalizeAdminId(raw) {
    const v = String(raw || '').trim();
    if (v.includes('@')) return v.toLowerCase();
    let d = v.replace(/\D/g, '');
    if (d.length > 10 && d.startsWith('0'))  d = d.slice(1);
    if (d.length > 10 && d.startsWith('91')) d = d.slice(d.length - 10);
    return d;
  }
  function validateAdminLoginInput(email, password) {
    if (typeof email !== 'string' || !email.trim())  return 'Please enter your email or mobile number.';
    if (typeof password !== 'string' || !password)   return 'Please enter your password.';
    const e = email.trim();
    if (e.length > ADMIN_EMAIL_MAX) return 'Please enter a valid email or mobile number.';
    if (e.includes('@') ? !ADMIN_EMAIL_RE.test(e) : !/^\d{10}$/.test(normalizeAdminId(e))) return 'Please enter a valid email or 10-digit mobile number.';
    if (password.length > ADMIN_PASSWORD_MAX)        return 'Password is too long.';
    return null;
  }

  // ── Single-device admin login ──
  // True if this admin account already has a live session (unexpired AND issued
  // after the most recent 7 AM reset — same rule getAdminSession applies). A
  // second login is refused until that session logs out or hits the 7 AM reset.
  async function findActiveAdminSessions(email, sortAsc) {
    const now = new Date();
    const q = AdminSession.find({ email, expiresAt: { $gt: now }, createdAt: { $gte: lastResetBefore(now) } });
    return sortAsc ? q.sort({ createdAt: 1, _id: 1 }).lean() : q.lean();
  }
  const ADMIN_ALREADY_LOGGED_IN = {
    message: 'This admin account is already logged in on another device. Please log out there first.',
    code: 'ALREADY_LOGGED_IN',
  };

  app.post('/api/login', loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const invalid = validateAdminLoginInput(email, password);
      if (invalid) return res.status(400).json({ message: invalid });
      const normalizedEmail = normalizeAdminId(email);
      const account = ADMIN_ACCOUNTS.find(a => normalizeAdminId(a.email) === normalizedEmail);
      // Always run bcrypt.compare — even when no account matches the email, in
      // which case we compare against DUMMY_PASSWORD_HASH — so a wrong-email
      // request and a wrong-password request take the same amount of time.
      const passwordMatch = typeof password === 'string'
        && await bcrypt.compare(password, account ? account.passwordHash : DUMMY_PASSWORD_HASH);
      if (account && passwordMatch) {
        // Only checked AFTER the password is verified, so nobody without the
        // password can probe whether an account is currently signed in.
        if ((await findActiveAdminSessions(account.email)).length) {
          return res.status(409).json(ADMIN_ALREADY_LOGGED_IN);
        }
        const adminKey = await issueAdminSession(account.email, true);
        // Two logins racing past the check above would both create a session.
        // Oldest live session wins (createdAt, then _id); the loser deletes its
        // own and is refused, so exactly one device ends up signed in.
        const [winner] = await findActiveAdminSessions(account.email, true);
        if (!winner || winner.key !== adminKey) {
          await AdminSession.deleteOne({ key: adminKey });
          return res.status(409).json(ADMIN_ALREADY_LOGGED_IN);
        }
        return res.json({
          message: 'Login successful', adminKey, firstName: ADMIN_NAME,
          isSuperAdmin: account.email === SUPER_ADMIN_EMAIL,
        });
      }
      return res.status(401).json({ message: 'Invalid email or password' });
    } catch (err) {
      console.error('Admin login error:', err);
      res.status(500).json({ message: 'Server error. Please try again.' });
    }
  });

  app.post('/api/admin/logout', async (req, res) => {
    try {
      const key = (req.headers['x-admin-key'] || '').toString();
      // Single-device login: signing out ends EVERY session for this account, so a
      // stale/orphaned one (closed tab, old cached page) can never keep it locked.
      const sess = key ? await AdminSession.findOne({ key }).lean() : null;
      if (sess && sess.email) await AdminSession.deleteMany({ email: sess.email });
      else await AdminSession.deleteOne({ key });
      res.json({ message: 'Logged out' });
    } catch (err) {
      console.error('Admin logout error:', err);
      res.status(500).json({ message: 'Server error. Please try again.' });
    }
  });

  // Middleware to protect admin-only API routes.
  // Apply this to any route you want to require a valid session for, e.g.:
  //   app.delete('/api/properties/:id', requireAdmin, async (req, res) => {...})
  async function requireAdmin(req, res, next) {
    try {
      const key = (req.headers['x-admin-key'] || '').toString();
      const session = await getAdminSession(key);
      if (!session) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      // Older sessions (issued before email was tracked) have no email —
      // treat them as the super admin so an already-logged-in primary admin
      // isn't locked out by this change; they'll pick up email on next login.
      req.adminEmail   = session.email || SUPER_ADMIN_EMAIL;
      req.isSuperAdmin = !session.email || session.email === SUPER_ADMIN_EMAIL;
      next();
    } catch (err) {
      console.error('requireAdmin error:', err);
      res.status(500).json({ message: 'Server error. Please try again.' });
    }
  }

  // ── GET /api/admin/me — who's logged in, and which features they can see ──
  // admin.html calls this right after login (and on auto-login) to decide
  // which tabs/buttons to show for a sub-admin account.
  app.get('/api/admin/me', requireAdmin, async (req, res) => {
    try {
      const [modules, actions, buttons] = await Promise.all([
        getModulePermissions(req.adminEmail),
        getActionPermissions(req.adminEmail),
        getButtonPermissions(req.adminEmail),
      ]);
      res.json({ email: req.adminEmail, isSuperAdmin: req.isSuperAdmin, modules, actions, buttons });
    } catch (err) {
      console.error('GET /api/admin/me error:', err.message);
      res.status(500).json({ message: 'Error fetching admin profile' });
    }
  });

  // Only the super admin (ADMIN_EMAIL) may view or change sub-admin access —
  // shared guard for the two routes below.
  function requireSuperAdmin(req, res, next) {
    if (!req.isSuperAdmin) {
      return res.status(403).json({ message: 'Only the primary admin can manage sub-admin access.' });
    }
    next();
  }

  // ── GET /api/admin/sub-admins — list every ADMIN_EMAIL_2/_3/... account
  // and its current feature access, for the "Admin Access" tab. ──
  app.get('/api/admin/sub-admins', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
      const subAccounts = ADMIN_ACCOUNTS.filter(a => a.email !== SUPER_ADMIN_EMAIL);
      const subAdmins = await Promise.all(subAccounts.map(async a => {
        const [modules, perm, buttons] = await Promise.all([
          getModulePermissions(a.email),
          AdminPermission.findOne({ email: a.email }).lean(),
          getButtonPermissions(a.email),
        ]);
        // Reported here as the raw per-key action flag (default true), not
        // ANDed with module visibility like getActionPermissions() does for
        // route-gating — the Admin Access tab needs to show/restore each
        // switch's own saved state independent of the module switch above it.
        const actions = {};
        for (const key of Object.keys(ADMIN_MODULES)) {
          actions[key] = !perm || !perm.actions || perm.actions[key] !== false;
        }
        const online = (await findActiveAdminSessions(a.email)).length > 0;
        return { email: a.email, modules, actions, buttons, online };
      }));
      res.json({ subAdmins, availableModules: ADMIN_MODULES, availableButtons: ADMIN_BUTTONS });
    } catch (err) {
      console.error('GET /api/admin/sub-admins error:', err.message);
      res.status(500).json({ message: 'Error fetching sub-admins' });
    }
  });

  // ── POST /api/admin/sub-admins/:email/logout — super admin force-logs a sub-admin out.
  // Deletes every session for that account (single-device login means there is at most
  // one live, but stale ones are cleared too). The sub-admin's next request gets a 401
  // and lands on the login screen; they can sign in again straight away. ──
  app.post('/api/admin/sub-admins/:email/logout', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
      const targetEmail = String(req.params.email || '').toLowerCase().trim();
      const account = ADMIN_ACCOUNTS.find(a => a.email === targetEmail);
      if (!account) return res.status(404).json({ message: 'No admin account with that email' });
      if (targetEmail === SUPER_ADMIN_EMAIL) {
        return res.status(400).json({ message: 'The primary admin cannot be force-logged out.' });
      }
      const r = await AdminSession.deleteMany({ email: targetEmail });
      res.json({ message: r.deletedCount ? 'Sub-admin logged out' : 'That sub-admin was not logged in', loggedOut: r.deletedCount || 0 });
    } catch (err) {
      console.error('POST /api/admin/sub-admins/:email/logout error:', err.message);
      res.status(500).json({ message: 'Error logging out sub-admin' });
    }
  });

  // ── PUT /api/admin/sub-admins/:email/modules — toggle which features a
  // given sub-admin can see, and (via `actions`) which of those features
  // they can also add/edit/delete/verify in, vs. view-only.
  // Body: { modules: { <key>: true|false, ... }, actions: { <key>: true|false, ... } }.
  app.put('/api/admin/sub-admins/:email/modules', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
      const targetEmail = String(req.params.email || '').toLowerCase().trim();
      const account = ADMIN_ACCOUNTS.find(a => a.email === targetEmail);
      if (!account) return res.status(404).json({ message: 'No admin account with that email' });
      if (targetEmail === SUPER_ADMIN_EMAIL) {
        return res.status(400).json({ message: 'The primary admin always has full access.' });
      }
      const { modules, actions, buttons } = req.body || {};
      if ((!modules || typeof modules !== 'object') && (!actions || typeof actions !== 'object') && (!buttons || typeof buttons !== 'object')) {
        return res.status(400).json({ message: 'modules, actions and/or buttons object is required' });
      }
      const update = {};
      for (const key of Object.keys(ADMIN_MODULES)) {
        if (modules && key in modules) update[`modules.${key}`] = !!modules[key];
        if (actions && key in actions) update[`actions.${key}`] = !!actions[key];
      }
      if (buttons && typeof buttons === 'object') {
        for (const [mod, btns] of Object.entries(ADMIN_BUTTONS)) {
          const sent = buttons[mod];
          if (!sent || typeof sent !== 'object') continue;
          for (const key of Object.keys(btns)) {
            if (key in sent) update[`buttons.${mod}.${key}`] = !!sent[key];
          }
        }
      }
      if (!Object.keys(update).length) {
        return res.status(400).json({ message: 'Nothing valid to update' });
      }
      await AdminPermission.findOneAndUpdate(
        { email: targetEmail },
        { $set: update },
        { upsert: true }
      );
      const [fullModules, fullActions, fullButtons] = await Promise.all([
        getModulePermissions(targetEmail),
        getActionPermissions(targetEmail),
        getButtonPermissions(targetEmail),
      ]);
      res.json({ message: 'Access updated', email: targetEmail, modules: fullModules, actions: fullActions, buttons: fullButtons });
    } catch (err) {
      console.error('PUT /api/admin/sub-admins/:email/modules error:', err.message);
      res.status(500).json({ message: 'Error updating sub-admin access' });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // ── ADMIN NOTIFICATIONS ──
  // In-app notifications *for the admin* (as opposed to notifyUser, which
  // notifies a customer/owner). Raised on: a new user registering, a new
  // property being listed, a new appointment (visit request), a new star
  // review, a new honest-review (video testimonial) submission, a new
  // referral, and a new partner being added. Call notifyAdmin(...) from
  // wherever those happen in server.js (see the returned helper at the bottom
  // of this file) or right here in admin.js for the partner case. Read by
  // admin.html's bell icon via the routes below.
  // ────────────────────────────────────────────────────────────────────────────
  const AdminNotificationSchema = new mongoose.Schema({
    type:    { type: String, required: true }, // e.g. 'user_registered', 'property_listed'
    title:   { type: String, required: true },
    message: { type: String, default: '' },
    meta:    { type: mongoose.Schema.Types.Mixed, default: {} },
    read:    { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: true },
  });
  const AdminNotification = mongoose.model('AdminNotification', AdminNotificationSchema);

  // Fire-and-forget style creator — swallow errors so a notification failure
  // never breaks the registration/listing flow that triggered it.
  async function notifyAdmin({ type, title, message = '', meta = {} }) {
    try {
      await AdminNotification.create({ type, title, message, meta });
    } catch (err) {
      console.error('notifyAdmin error:', err.message);
      return;
    }
    sendAdminPush({ type, title, message }); // fire-and-forget phone/desktop push
  }

  // ── ADMIN WEB PUSH (system notifications, even with the page closed) ──
  // Needs: `npm i web-push`, and env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
  // (generate once with `npx web-push generate-vapid-keys`), optional
  // VAPID_SUBJECT (e.g. mailto:you@example.com). If any of these is missing,
  // push is simply disabled — the in-page bell/sound keep working.
  // Browsers only allow push on HTTPS (or localhost).
  let webpush = null;
  try {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      webpush = require('web-push');
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || ('mailto:' + (process.env.ADMIN_EMAIL || 'admin@example.com')),
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
    }
  } catch (err) {
    console.error('web-push unavailable (run `npm i web-push`):', err.message);
    webpush = null;
  }

  const AdminPushSubSchema = new mongoose.Schema({
    endpoint:   { type: String, required: true, unique: true },
    keys:       { p256dh: String, auth: String },
    adminEmail: { type: String, default: '' },
    pageUrl:    { type: String, default: '/' },   // admin page to open when tapped
    createdAt:  { type: Date, default: Date.now },
  });
  const AdminPushSub = mongoose.model('AdminPushSub', AdminPushSubSchema);

  async function sendAdminPush({ type, title, message }) {
    if (!webpush) return;
    try {
      const subs = await AdminPushSub.find({}).lean();
      if (!subs.length) return;
      const permCache = {};
      await Promise.all(subs.map(async sub => {
        try {
          // Sub-admins without the Notifications module shouldn't get alerts.
          if (!(sub.adminEmail in permCache)) {
            permCache[sub.adminEmail] = (await getModulePermissions(sub.adminEmail || SUPER_ADMIN_EMAIL)).notifications !== false;
          }
          if (!permCache[sub.adminEmail]) return;
          const payload = JSON.stringify({
            title: String(title || 'Notification').slice(0, 80),
            body:  String(message || '').slice(0, 160),
            type,
            url:   sub.pageUrl || '/',
          });
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 60 * 60, urgency: 'high' }); // 'high' = deliver right away, even when the phone is idle / in battery saver
        } catch (err) {
          // 404/410 = the browser dropped this subscription; clean it up.
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            await AdminPushSub.deleteOne({ endpoint: sub.endpoint }).catch(() => {});
          } else {
            console.error('admin push send error:', err && (err.statusCode || err.message));
          }
        }
      }));
    } catch (err) {
      console.error('sendAdminPush error:', err.message);
    }
  }

  // Service worker — served from the site root so its scope covers the admin
  // page. It shows the system notification and focuses/opens the admin page on tap.
  app.get('/admin-sw.js', (req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.send(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) {}
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Admin page already open and in view: it chimes + refreshes itself, skip the duplicate.
    if (wins.some(c => c.visibilityState === 'visible' && c.focused)) return;
    await self.registration.showNotification(d.title || 'New notification', {
      body: d.body || '',
      tag: d.type || 'admin',
      renotify: true,
      icon: '/favicon.ico',
      data: { url: d.url || '/' },
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) { if ('focus' in c) { await c.focus(); return; } }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
`);
  });

  // GET /api/admin/push/public-key — lets admin.html know push is configured.
  app.get('/api/admin/push/public-key', requireAdmin, (req, res) => {
    if (!webpush) return res.status(503).json({ message: 'Push is not configured on the server' });
    res.json({ key: process.env.VAPID_PUBLIC_KEY });
  });

  // POST /api/admin/push/subscribe — store this browser's push subscription.
  app.post('/api/admin/push/subscribe', requireAdmin, async (req, res) => {
    try {
      if (!webpush) return res.status(503).json({ message: 'Push is not configured on the server' });
      const { subscription, pageUrl } = req.body || {};
      if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
        return res.status(400).json({ message: 'Invalid subscription' });
      }
      await AdminPushSub.findOneAndUpdate(
        { endpoint: subscription.endpoint },
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
          adminEmail: req.adminEmail, pageUrl: String(pageUrl || '/').slice(0, 300) },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      res.json({ message: 'Push enabled' });
    } catch (err) {
      console.error('POST /api/admin/push/subscribe error:', err.message);
      res.status(500).json({ message: 'Error enabling push' });
    }
  });

  // POST /api/admin/push/unsubscribe — remove this browser's subscription.
  app.post('/api/admin/push/unsubscribe', requireAdmin, async (req, res) => {
    try {
      const { endpoint } = req.body || {};
      if (endpoint) await AdminPushSub.deleteOne({ endpoint });
      res.json({ message: 'Push disabled' });
    } catch (err) {
      console.error('POST /api/admin/push/unsubscribe error:', err.message);
      res.status(500).json({ message: 'Error disabling push' });
    }
  });

  // GET /api/admin/notifications — newest first, capped at 200, plus unread count.
  app.get('/api/admin/notifications', requireAdmin, requireModule('notifications'), async (req, res) => {
    try {
      const [notifications, unreadCount] = await Promise.all([
        AdminNotification.find({}).sort({ createdAt: -1 }).limit(200).lean(),
        AdminNotification.countDocuments({ read: false }),
      ]);
      res.json({ notifications, unreadCount });
    } catch (err) {
      console.error('GET /api/admin/notifications error:', err.message);
      res.status(500).json({ message: 'Error fetching notifications' });
    }
  });

  // PATCH /api/admin/notifications/:id/read — mark one notification as read.
  app.patch('/api/admin/notifications/:id/read', requireAdmin, requireModuleAction('notifications'), async (req, res) => {
    try {
      const notification = await AdminNotification.findByIdAndUpdate(
        req.params.id, { read: true }, { new: true }
      ).lean();
      if (!notification) return res.status(404).json({ message: 'Notification not found' });
      res.json({ message: 'Marked as read', notification });
    } catch (err) {
      console.error('PATCH /api/admin/notifications/:id/read error:', err.message);
      res.status(500).json({ message: 'Error updating notification' });
    }
  });

  // POST /api/admin/notifications/mark-all-read
  app.post('/api/admin/notifications/mark-all-read', requireAdmin, requireModuleAction('notifications'), async (req, res) => {
    try {
      await AdminNotification.updateMany({ read: false }, { $set: { read: true } });
      res.json({ message: 'All notifications marked as read' });
    } catch (err) {
      console.error('POST /api/admin/notifications/mark-all-read error:', err.message);
      res.status(500).json({ message: 'Error updating notifications' });
    }
  });

  // DELETE /api/admin/notifications/:id — remove a single notification.
  app.delete('/api/admin/notifications/:id', requireAdmin, requireModuleAction('notifications'), async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid notification id' });
      const notification = await AdminNotification.findByIdAndDelete(req.params.id);
      if (!notification) return res.status(404).json({ message: 'Notification not found' });
      res.json({ message: 'Notification deleted' });
    } catch (err) {
      console.error('DELETE /api/admin/notifications/:id error:', err.message);
      res.status(500).json({ message: 'Error deleting notification' });
    }
  });

  // POST /api/admin/notifications/clear-all — remove every notification.
  app.post('/api/admin/notifications/clear-all', requireAdmin, requireModuleAction('notifications'), async (req, res) => {
    try {
      await AdminNotification.deleteMany({});
      res.json({ message: 'All notifications cleared' });
    } catch (err) {
      console.error('POST /api/admin/notifications/clear-all error:', err.message);
      res.status(500).json({ message: 'Error clearing notifications' });
    }
  });

  // ── GET /api/admin/visits (admin panel — all visit requests, newest first) ──
  app.get('/api/admin/visits', requireAdmin, requireModule('visits'), async (req, res) => {
    try {
      const docs = await VisitRequest.find({})
        .sort({ createdAt: -1 })
        .populate('propertyId', 'owner.propertyName location.area owner.phone')
        .lean();
      res.json({ visits: docs, total: docs.length });
    } catch (err) {
      console.error('GET /api/admin/visits error:', err);
      res.status(500).json({ message: 'Error fetching visit requests' });
    }
  });

  // ── PATCH /api/admin/visits/:id/status (admin: confirm/cancel/complete a visit) ──
  app.patch('/api/admin/visits/:id/status', requireAdmin, requireModuleAction('visits'), async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!['Pending', 'Confirmed', 'Cancelled', 'Completed'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      const before = await VisitRequest.findById(req.params.id).lean();
      const visit = await VisitRequest.findByIdAndUpdate(req.params.id, { status }, { new: true });
      if (!visit) return res.status(404).json({ message: 'Visit request not found' });

      if (before && before.status !== status && visit.userId) {
        const statusText = {
          Confirmed: 'confirmed', Cancelled: 'cancelled',
          Completed: 'marked as completed', Pending: 'set back to pending',
        }[status] || status.toLowerCase();
        await notifyUser(visit.userId, {
          type: 'visit_status',
          title: `Visit ${statusText}`,
          message: `Your visit scheduled for ${visit.visitDate} at ${visit.visitTime} has been ${statusText}.`,
          meta: { visitId: visit.visitId, mongoId: String(visit._id), status, ...(await visitCalendarMeta(visit)) },
        });
      }

      res.json({ message: 'Status updated', visit });
    } catch (err) {
      console.error('PATCH /api/admin/visits/:id/status error:', err);
      res.status(500).json({ message: 'Error updating visit status' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ── ADMIN: CUSTOMERS GRID ──
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/users', requireAdmin, requireModule('customers'), async (req, res) => {
    try {
      const users = await User.find({}).sort({ createdAt: -1 }).lean();
      const userIds = users.map(u => u._id);

      // Same 10-digit normalisation the rest of the app uses for mobiles.
      const normMobile = (raw) => {
        let d = String(raw || '').replace(/\D/g, '');
        if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
        if (d.length > 10 && d.startsWith('91')) d = d.slice(d.length - 10);
        return d;
      };
      // mobile -> [user _id strings], so a listing/visit that was never linked to an
      // account (added by an admin, or made before signup) is still credited to the
      // customer whose mobile number matches — same rule as getUserOwnershipFilter().
      const mobileToUsers = {};
      users.forEach(u => {
        const m = normMobile(u.mobile);
        if (m) (mobileToUsers[m] = mobileToUsers[m] || []).push(String(u._id));
      });
      const mobiles = Object.keys(mobileToUsers);

      const [listingsByModel, visitDocs, viewerAgg] = await Promise.all([
        Promise.all(LISTING_MODEL_LIST.map(M => M.find({ $or: [
          { userId: { $in: userIds } },
          { 'owner.phone': { $in: mobiles } },
          { 'owner.altPhone': { $in: mobiles } }
        ] }).select('userId owner.phone owner.altPhone views').lean())),
        VisitRequest.find({ $or: [
          { userId: { $in: userIds } },
          { visitorPhone: { $in: mobiles } }
        ] }).select('userId visitorPhone').lean(),
        PropertyViewer.aggregate([
          { $match: { userId: { $in: userIds } } },
          { $group: { _id: '$userId', count: { $sum: 1 } } }
        ])
      ]);

      const propMap = {};   // listings owned per customer (across rent/lease/pg/hourlyStay)
      const viewsMap = {};  // total views received on those listings
      for (const docs of listingsByModel) {
        for (const d of docs) {
          const owners = new Set();
          if (d.userId) owners.add(String(d.userId));
          const o = d.owner || {};
          [o.phone, o.altPhone].forEach(ph => {
            (mobileToUsers[normMobile(ph)] || []).forEach(id => owners.add(id));
          });
          owners.forEach(id => {
            propMap[id]  = (propMap[id]  || 0) + 1;
            viewsMap[id] = (viewsMap[id] || 0) + (d.views || 0);
          });
        }
      }
      const visitMap = {};  // visit requests per customer (by account or by phone)
      for (const v of visitDocs) {
        const owners = new Set();
        if (v.userId) owners.add(String(v.userId));
        (mobileToUsers[normMobile(v.visitorPhone)] || []).forEach(id => owners.add(id));
        owners.forEach(id => { visitMap[id] = (visitMap[id] || 0) + 1; });
      }
      const viewedMap = Object.fromEntries(viewerAgg.map(x => [String(x._id), x.count]));

      const rows = users.map(u => ({
        _id:           u._id,
        userId:        u.userId || '',
        name:          u.name || '',
        firstName:     u.firstName || '',
        lastName:      u.lastName || '',
        mobile:        u.mobile || '',
        email:         u.email  || '',
        profilePhoto:  u.profilePhoto || '',
        remarks:       u.remarks || [],
        reason:        u.reason || '',
        accountType:   u.accountType || 'customer',
        isVerified:    !!u.isVerified,
        verifiedAt:    u.verifiedAt || null,
        publicCall:    !!u.publicCall,
        isBlocked:     !!u.isBlocked,
        subscriptionAt: u.subscriptionAt || null,
        subscriptionFrom: u.subscriptionFrom || u.subscriptionAt || null,
        subscriptionTo:   u.subscriptionTo || null,
        subscriptionBhk:  u.subscriptionBhk || '',
        subscriptionFilter: u.subscriptionFilter || null,
        subscriptions:    (u.subscriptions || []).map(subPlanOut),
        listingsCount: propMap[String(u._id)]  || 0,
        visitsCount:   visitMap[String(u._id)] || 0,
        viewsCount:    viewsMap[String(u._id)] || 0,   // total views on this customer's listings
        propertiesViewed: viewedMap[String(u._id)] || 0, // distinct listings this customer has opened
        createdAt:     u.createdAt,
      }));

      res.json(rows);
    } catch (err) {
      console.error('GET /api/users error:', err);
      res.status(500).json({ message: 'Error fetching customers' });
    }
  });

  async function findUserByMobileOrId(key) {
    const decoded = decodeURIComponent(key || '').toLowerCase().trim();
    if (mongoose.Types.ObjectId.isValid(decoded)) {
      const byId = await User.findById(decoded);
      if (byId) return byId;
    }
    return User.findOne({ $or: [{ mobile: decoded }, { email: decoded }] });
  }

  app.delete('/api/users/mobile/:mobile', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'delete'), async (req, res) => {
    try {
      const user = await findUserByMobileOrId(req.params.mobile);
      if (!user) return res.status(404).json({ message: 'Customer not found' });
      await User.deleteOne({ _id: user._id });
      res.json({ message: 'Customer deleted' });
    } catch (err) {
      console.error('DELETE /api/users/mobile/:mobile error:', err);
      res.status(500).json({ message: 'Error deleting customer' });
    }
  });

  // ── POST /api/users/bulk-delete (admin: delete many customers at once) ──
  app.post('/api/users/bulk-delete', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'delete'), async (req, res) => {
    try {
      const { mobiles } = req.body || {};
      if (!Array.isArray(mobiles) || !mobiles.length) {
        return res.status(400).json({ message: 'mobiles must be a non-empty array' });
      }
      const users = await Promise.all(mobiles.map(m => findUserByMobileOrId(m)));
      const ids = users.filter(Boolean).map(u => u._id);
      if (!ids.length) return res.status(404).json({ message: 'No matching customers found' });
      const result = await User.deleteMany({ _id: { $in: ids } });
      res.json({ message: `${result.deletedCount} customer(s) deleted`, deletedCount: result.deletedCount });
    } catch (err) {
      console.error('POST /api/users/bulk-delete error:', err);
      res.status(500).json({ message: 'Error deleting customers' });
    }
  });

  // ── PATCH /api/users/:id/verify (admin: approve/unapprove a signup) ──
  // Flips User.isVerified. Until this is true, the account's own "submit"
  // routes (new listing, visit request, booking, honest review, payment
  // request/proof — see requireVerified in server.js) are blocked with a 403.
  // Body: { verified: true | false }. Defaults to true (the common case —
  // clicking "Verify" on a freshly signed-up user).
  app.patch('/api/users/:id/verify', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'verified'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const verified = req.body && req.body.verified === false ? false : true;
      const user = await User.findByIdAndUpdate(
        id,
        { isVerified: verified, verifiedAt: verified ? new Date() : null },
        { new: true }
      ).lean();
      if (!user) return res.status(404).json({ message: 'Customer not found' });

      // Notify only when the account is VERIFIED. Unverifying (revoking) is silent —
      // the customer/owner gets no notification for it.
      if (verified) {
        await notifyUser(user._id, {
          type: 'account_verification',
          title: 'Account verified',
          message: 'Your account has been verified by our team. You can now post listings, book visits, and more.',
          meta: { status: 'approved' },
        });
      }

      res.json({
        message: verified ? 'Customer verified' : 'Customer verification revoked',
        _id: user._id, isVerified: !!user.isVerified, verifiedAt: user.verifiedAt || null,
      });
    } catch (err) {
      console.error('PATCH /api/users/:id/verify error:', err);
      res.status(500).json({ message: 'Error updating verification status' });
    }
  });

  // ── SUBSCRIPTIONS (admin: add / edit / remove a customer's subscription plans) ──
  // A customer can have MORE THAN ONE plan (e.g. a renewal added while the first is still running).
  // Plans may not overlap or duplicate each other. User.subscriptions holds them all; the legacy
  // subscriptionFrom / subscriptionTo / subscriptionBhk / *Handled fields mirror the CURRENT plan
  // (running → else next upcoming → else latest ended), so the start / expiry sweeps, GET /api/properties
  // and the site's popups keep working exactly as before, one plan at a time.
  const SUB_ALLOWED_BHK = ['', '1 RK', '1 BHK', '2 BHK', '3 BHK', '4 BHK'];
  const SUB_BHK_LIST = ['1 RK', '1 BHK', '2 BHK', '3 BHK', '4 BHK'];
  // A plan's BHK list (new `bhks`, falling back to the legacy single `bhk`).
  const planBhks = (p) => (p.bhks && p.bhks.length) ? p.bhks : (p.bhk ? [p.bhk] : []);
  // Parking counts for a plan; legacy plans (bike/car = true) mean "any parking" = 1–4.
  const planCounts = (p, k) => (p[k + 'Counts'] && p[k + 'Counts'].length) ? p[k + 'Counts'] : (p[k] ? ['1', '2', '3', '4'] : []);
  const planFilter = (p) => ({
    bhks: planBhks(p), areas: p.areas || [], bikeCounts: planCounts(p, 'bike'), carCounts: planCounts(p, 'car'),
    budgetMin: p.budgetMin == null ? null : p.budgetMin, budgetMax: p.budgetMax == null ? null : p.budgetMax,
  });
  const sameFilter = (x, y) => JSON.stringify(x || {}) === JSON.stringify(y || {});
  const subPlanOut = (p) => Object.assign({ _id: p._id, from: p.from, to: p.to, bhk: planBhks(p)[0] || '' }, planFilter(p));
  function pickCurrentPlan(plans, now) {
    const list = (plans || []).filter(p => p && p.from && p.to);
    const running = list.find(p => new Date(p.from) <= now && new Date(p.to) > now);
    if (running) return running;
    const upcoming = list.filter(p => new Date(p.from) > now).sort((a, b) => new Date(a.from) - new Date(b.from))[0];
    if (upcoming) return upcoming;
    return list.sort((a, b) => new Date(b.to) - new Date(a.to))[0] || null;
  }
  // Makes the legacy single-plan fields mirror the current plan. Returns the fresh user (lean).
  async function syncCurrentSubscription(id, opts) {
    opts = opts || {};
    const user = await User.findById(id).select('subscriptions subscriptionFrom subscriptionAt subscriptionTo subscriptionBhk subscriptionFilter subscriptionExpiryHandled accountType isBlocked publicCall').lean();
    if (!user) return null;
    const now = new Date();
    const plan = pickCurrentPlan(user.subscriptions, now);
    const curFrom = user.subscriptionFrom || user.subscriptionAt || null;
    const curTo = user.subscriptionTo || null;
    const isTenant = (user.accountType || 'customer') !== 'owner' && !user.isBlocked;
    if (!plan) {
      // No plans left → clear the mirror. If a plan was running, switch Public call off (as the expiry sweep would).
      const wasRunning = !!(curFrom && curTo && new Date(curFrom) <= now && new Date(curTo) > now);
      const upd = { subscriptionAt: null, subscriptionFrom: null, subscriptionTo: null, subscriptionBhk: '', subscriptionFilter: null, subscriptionExpiryHandled: false, subscriptionStartHandled: false };
      if (wasRunning && (user.accountType || 'customer') !== 'owner') upd.publicCall = false;
      return User.findByIdAndUpdate(id, upd, { new: true }).lean();
    }
    const same = curFrom && curTo && +new Date(curFrom) === +new Date(plan.from) && +new Date(curTo) === +new Date(plan.to);
    if (same) {
      const pf = planFilter(plan);
      if ((user.subscriptionBhk || '') !== (pf.bhks[0] || '') || !sameFilter(user.subscriptionFilter, pf)) return User.findByIdAndUpdate(id, { subscriptionBhk: pf.bhks[0] || '', subscriptionFilter: pf }, { new: true }).lean();
      return user;
    }
    // Current plan changed (new / edited / next one promoted).
    const upd = { subscriptionAt: plan.from, subscriptionFrom: plan.from, subscriptionTo: plan.to, subscriptionBhk: planBhks(plan)[0] || '', subscriptionFilter: planFilter(plan), subscriptionExpiryHandled: false, subscriptionStartHandled: false };
    const running = new Date(plan.from) <= now && new Date(plan.to) > now;
    if (running) {
      if (isTenant) { upd.publicCall = true; upd.subscriptionStartHandled = true; }   // already running → Public call ON now
    } else if (curTo && new Date(curTo) <= now && !user.subscriptionExpiryHandled && (user.accountType || 'customer') !== 'owner') {
      upd.publicCall = false;   // previous plan ended before the expiry sweep ran, next one hasn't started
    }
    return User.findByIdAndUpdate(id, upd, { new: true }).lean();
  }
  const subResponse = (user, message) => ({
    message, publicCall: !!user.publicCall, _id: user._id,
    subscriptionAt: user.subscriptionAt || null,
    subscriptionFrom: user.subscriptionFrom || null, subscriptionTo: user.subscriptionTo || null,
    subscriptionBhk: user.subscriptionBhk || '', subscriptionFilter: user.subscriptionFilter || null,
    subscriptions: (user.subscriptions || []).map(subPlanOut),
  });
  const fmtPlanDate = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

  // ── GET /api/admin/listing-areas — distinct listing areas (suggestions for the subscription "Areas" field) ──
  app.get('/api/admin/listing-areas', requireAdmin, async (req, res) => {
    try {
      const lists = await Promise.all(LISTING_MODEL_LIST.map(M => M.distinct('location.area')));
      const areas = [...new Set(lists.flat().map(x => String(x || '').trim()).filter(Boolean))].sort((x, y) => x.localeCompare(y));
      res.json({ areas });
    } catch (err) {
      console.error('GET /api/admin/listing-areas error:', err);
      res.status(500).json({ message: 'Error loading areas' });
    }
  });

  // ── POST/PATCH /api/users/:id/subscription  (admin: ADD a subscription plan, or edit one) ──
  // Body: { subscriptionFrom, subscriptionTo, subscriptionBhk, subscriptionId? }
  // Without subscriptionId a NEW plan is added to the customer; with it, that plan is updated.
  // A plan that overlaps / duplicates another of the same customer is refused (409).
  app.patch('/api/users/:id/subscription', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'subscription'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const body = req.body || {};
      const parse = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? undefined : d; };
      const fromVal = parse(body.subscriptionFrom !== undefined ? body.subscriptionFrom : body.subscriptionAt);
      const toVal   = parse(body.subscriptionTo);
      if (fromVal === undefined || toVal === undefined) return res.status(400).json({ message: 'Invalid date/time' });
      if (!fromVal || !toVal) return res.status(400).json({ message: 'Both From and To dates are required' });
      if (toVal <= fromVal) return res.status(400).json({ message: 'To date must be after From date' });
      // BHK: multi-select array (`subscriptionBhks`); a legacy single `subscriptionBhk` string is still accepted. [] = all BHKs.
      let bhksVal = Array.isArray(body.subscriptionBhks) ? body.subscriptionBhks
                  : (body.subscriptionBhk ? [body.subscriptionBhk] : []);
      bhksVal = [...new Set(bhksVal.map(x => String(x).trim()).filter(Boolean))];
      if (!bhksVal.length) return res.status(400).json({ message: 'Select at least one BHK' });
      if (bhksVal.some(b => !SUB_BHK_LIST.includes(b))) return res.status(400).json({ message: 'Invalid BHK' });
      const areasVal = [...new Set((Array.isArray(body.subscriptionAreas) ? body.subscriptionAreas : []).map(x => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 50);
      const cleanCounts = (v) => [...new Set((Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean))];
      const bikeCounts = cleanCounts(body.subscriptionBikeCounts), carCounts = cleanCounts(body.subscriptionCarCounts);
      if ([...bikeCounts, ...carCounts].some(x => !/^[0-4]$/.test(x))) return res.status(400).json({ message: 'Invalid parking count' });
      const num = (v) => (v === undefined || v === null || v === '') ? null : Number(v);
      const budgetMinVal = num(body.subscriptionBudgetMin), budgetMaxVal = num(body.subscriptionBudgetMax);
      if ((budgetMinVal !== null && (!isFinite(budgetMinVal) || budgetMinVal < 0)) || (budgetMaxVal !== null && (!isFinite(budgetMaxVal) || budgetMaxVal < 0))) return res.status(400).json({ message: 'Invalid budget' });
      if (budgetMinVal !== null && budgetMaxVal !== null && budgetMaxVal < budgetMinVal) return res.status(400).json({ message: 'Max budget must be at least the min budget' });
      const planFields = { bhk: bhksVal[0] || '', bhks: bhksVal, areas: areasVal, bike: bikeCounts.length > 0, car: carCounts.length > 0, bikeCounts, carCounts, budgetMin: budgetMinVal, budgetMax: budgetMaxVal };
      const subId = body.subscriptionId ? String(body.subscriptionId) : '';
      if (subId && !mongoose.Types.ObjectId.isValid(subId)) return res.status(400).json({ message: 'Invalid subscription id' });

      const existing = await User.findById(id).select('subscriptions').lean();
      if (!existing) return res.status(404).json({ message: 'Customer not found' });
      const plans = existing.subscriptions || [];
      if (subId && !plans.some(p => String(p._id) === subId)) return res.status(404).json({ message: 'Subscription not found' });
      // Duplicate / overlap check against every OTHER plan of this customer.
      const clash = plans.find(p => String(p._id) !== subId && fromVal < new Date(p.to) && toVal > new Date(p.from));
      if (clash) {
        return res.status(409).json({ message: `This overlaps an existing subscription (${fmtPlanDate(clash.from)} → ${fmtPlanDate(clash.to)}). Pick dates that don't overlap.` });
      }
      if (subId) {
        await User.updateOne({ _id: id, 'subscriptions._id': subId },
          { $set: Object.assign({ 'subscriptions.$.from': fromVal, 'subscriptions.$.to': toVal },
            ...Object.keys(planFields).map(k => ({ ['subscriptions.$.' + k]: planFields[k] }))) });
      } else {
        await User.updateOne({ _id: id }, { $push: { subscriptions: Object.assign({ from: fromVal, to: toVal }, planFields) } });
      }
      const user = await syncCurrentSubscription(id);
      res.json(subResponse(user, subId ? 'Subscription updated' : 'Subscription added'));
    } catch (err) {
      console.error('PATCH /api/users/:id/subscription error:', err);
      res.status(500).json({ message: 'Error updating subscription' });
    }
  });

  // ── DELETE /api/users/:id/subscription/:subId  (admin: remove one subscription plan) ──
  app.delete('/api/users/:id/subscription/:subId', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'subscription'), async (req, res) => {
    try {
      const { id, subId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(subId)) return res.status(400).json({ message: 'Invalid id' });
      const r = await User.updateOne({ _id: id }, { $pull: { subscriptions: { _id: subId } } });
      if (!r.matchedCount && !r.n) return res.status(404).json({ message: 'Customer not found' });
      const user = await syncCurrentSubscription(id);
      res.json(subResponse(user, 'Subscription removed'));
    } catch (err) {
      console.error('DELETE /api/users/:id/subscription/:subId error:', err);
      res.status(500).json({ message: 'Error removing subscription' });
    }
  });

  // Plans saved before multi-subscription existed live only in the legacy fields → copy them into
  // User.subscriptions once (idempotent: only users whose list is still empty).
  async function migrateLegacySubscriptions() {
    try {
      const users = await User.find({
        subscriptionTo: { $ne: null },
        $or: [{ subscriptions: { $exists: false } }, { subscriptions: { $size: 0 } }],
      }).select('_id subscriptionFrom subscriptionAt subscriptionTo subscriptionBhk').lean();
      for (const u of users) {
        const from = u.subscriptionFrom || u.subscriptionAt;
        if (!from || !u.subscriptionTo) continue;
        await User.updateOne(
          { _id: u._id, $or: [{ subscriptions: { $exists: false } }, { subscriptions: { $size: 0 } }] },
          { $set: { subscriptions: [{ from, to: u.subscriptionTo, bhk: u.subscriptionBhk || '', bhks: u.subscriptionBhk ? [u.subscriptionBhk] : [] }] } }
        );
      }
    } catch (err) {
      console.error('migrateLegacySubscriptions error:', err.message);
    }
  }
  // When the current plan has ended and the customer has another plan that is running / upcoming,
  // move on to it (runs right after the expiry sweep, every minute).
  async function promoteNextSubscriptions() {
    try {
      const now = new Date();
      const due = await User.find({ subscriptionTo: { $lte: now }, subscriptions: { $elemMatch: { to: { $gt: now } } } }).select('_id').lean();
      for (const { _id } of due) await syncCurrentSubscription(_id);
    } catch (err) {
      console.error('promoteNextSubscriptions error:', err.message);
    }
  }

  // ── SUBSCRIPTION EXPIRY SWEEP ──
  // When a customer's subscriptionTo has passed: turn their Public call OFF. They stay logged in
  // (no session is touched) — GET /api/properties reads User.publicCall on every request, so
  // owner numbers disappear on their next load/refresh. Runs at startup and every minute. Each period is handled
  // once (subscriptionExpiryHandled), so a user who logs back in afterwards — or an admin
  // who re-enables Public call by hand — is not switched off again until a new period is saved.
  async function expireSubscriptions() {
    try {
      const due = await User.find({
        subscriptionTo: { $ne: null, $lte: new Date() },
        subscriptionExpiryHandled: { $ne: true },
      }).select('_id').lean();
      for (const { _id } of due) {
        // Atomic claim so overlapping runs / multiple instances act only once per user.
        await User.findOneAndUpdate(
          { _id, subscriptionExpiryHandled: { $ne: true }, subscriptionTo: { $lte: new Date() } },
          { publicCall: false, subscriptionExpiryHandled: true }
        );
      }
    } catch (err) {
      console.error('expireSubscriptions error:', err.message);
    }
    await promoteNextSubscriptions();
  }
  migrateLegacySubscriptions().then(expireSubscriptions);
  setInterval(expireSubscriptions, 60 * 1000).unref();

  // ── SUBSCRIPTION START SWEEP ──
  // When a tenant's subscriptionFrom has arrived (and subscriptionTo hasn't): turn THEIR Public call ON.
  // Only that user is touched. Handled once per saved period (subscriptionStartHandled), so if an admin later
  // switches Public call off by hand during the plan, it is not switched back on. Runs at startup + every minute.
  async function startSubscriptions() {
    try {
      const now = new Date();
      const due = await User.find({
        subscriptionFrom: { $ne: null, $lte: now },
        subscriptionTo:   { $ne: null, $gt: now },
        subscriptionStartHandled: { $ne: true },
        accountType: { $ne: 'owner' },
        isBlocked: { $ne: true },
      }).select('_id').lean();
      for (const { _id } of due) {
        // Atomic claim so overlapping runs / multiple instances act only once per user.
        await User.findOneAndUpdate(
          { _id, subscriptionStartHandled: { $ne: true }, subscriptionFrom: { $lte: new Date() }, subscriptionTo: { $gt: new Date() } },
          { publicCall: true, subscriptionStartHandled: true }
        );
      }
    } catch (err) {
      console.error('startSubscriptions error:', err.message);
    }
  }
  startSubscriptions();
  setInterval(startSubscriptions, 60 * 1000).unref();

  // ── PATCH /api/users/:id (admin: edit a customer's profile) ──
  // Body: { firstName, lastName, email, mobile, accountType }. Powers the Customers
  // grid's "Edit" button (openCustomerEditModal() in admin.html). Mobile is stored as
  // the plain 10-digit number, same as signup; email is optional (removed when blank).
  // Mobile and email must stay unique across customers -> 409 if another account has them.
  app.patch('/api/users/:id', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'edit'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const b = req.body || {};
      const firstName = String(b.firstName || '').trim();
      const lastName  = String(b.lastName  || '').trim();
      const email     = String(b.email     || '').trim().toLowerCase();
      let mobile = String(b.mobile || '').replace(/\D/g, '');
      if (mobile.length > 10 && mobile.startsWith('0'))  mobile = mobile.slice(1);
      if (mobile.length > 10 && mobile.startsWith('91')) mobile = mobile.slice(-10);
      const accountType = b.accountType === 'owner' ? 'owner' : 'customer';

      if (!firstName) return res.status(400).json({ message: 'First name is required.' });
      if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' });

      const clash = await User.findOne({
        _id: { $ne: id },
        $or: [{ mobile }, ...(email ? [{ email }] : [])]
      }).select('mobile email').lean();
      if (clash) {
        return res.status(409).json({ message: clash.mobile === mobile
          ? 'Another customer already uses this mobile number.'
          : 'Another customer already uses this email address.' });
      }

      const update = { $set: { firstName, lastName, name: `${firstName} ${lastName}`.trim(), mobile, accountType } };
      if (email) update.$set.email = email; else update.$unset = { email: 1 };
      const user = await User.findByIdAndUpdate(id, update, { new: true }).lean();
      if (!user) return res.status(404).json({ message: 'Customer not found' });
      res.json({
        message: 'Customer updated',
        _id: user._id, firstName: user.firstName, lastName: user.lastName, name: user.name,
        email: user.email || '', mobile: user.mobile, accountType: user.accountType,
      });
    } catch (err) {
      if (err && err.code === 11000) return res.status(409).json({ message: 'Mobile or email is already in use by another customer.' });
      console.error('PATCH /api/users/:id error:', err);
      res.status(500).json({ message: 'Error updating customer' });
    }
  });

  // ── PATCH /api/users/:id/publicCall (admin: per-user "Public call" switch) ──
  // Body: { publicCall: true | false }. Owner account → their listings show owner number(s) to
  // everyone; tenant account → that tenant (when logged in) sees them on all listings.
  // Both resolved in GET /api/properties.
  app.patch('/api/users/:id/publicCall', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'publiccall'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const value = (req.body || {}).publicCall;
      if (typeof value !== 'boolean') return res.status(400).json({ message: 'publicCall must be a boolean' });
      const user = await User.findByIdAndUpdate(id, { publicCall: value }, { new: true }).lean();
      if (!user) return res.status(404).json({ message: 'Customer not found' });
      res.json({ message: 'Public call updated', _id: user._id, publicCall: !!user.publicCall });
    } catch (err) {
      console.error('PATCH /api/users/:id/publicCall error:', err);
      res.status(500).json({ message: 'Error updating public call' });
    }
  });

  // ── DELETE /api/users/:id/session (admin: force logout) ──
  // Clears every active UserSession row for this user, so a customer locked
  // out by the single-device login check (server.js's hasActiveUserSession)
  // can log in again elsewhere without waiting out the 7-day session TTL.
  // Harmless to call on a user with no active session (just deletes 0 rows).
  app.delete('/api/users/:id/session', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'logout'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const { deletedCount } = await UserSession.deleteMany({ userObjectId: id });
      res.json({ message: deletedCount ? 'User logged out on all devices' : 'User had no active session', deletedCount });
    } catch (err) {
      console.error('DELETE /api/users/:id/session error:', err);
      res.status(500).json({ message: 'Error clearing user session' });
    }
  });

  // ── PATCH /api/users/:id/block (admin: block / unblock a customer) ──
  // Body: { blocked: true | false }. Blocking also deletes every session so they are logged out
  // right away; POST /api/user/login then refuses them with "Your account has been blocked".
  app.patch('/api/users/:id/block', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'block'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const blocked = (req.body || {}).blocked;
      if (typeof blocked !== 'boolean') return res.status(400).json({ message: 'blocked must be a boolean' });
      const user = await User.findByIdAndUpdate(
        id, { isBlocked: blocked, blockedAt: blocked ? new Date() : null }, { new: true }
      ).lean();
      if (!user) return res.status(404).json({ message: 'Customer not found' });
      if (blocked) await UserSession.deleteMany({ userObjectId: id });
      res.json({ message: blocked ? 'Customer blocked and logged out' : 'Customer unblocked', _id: user._id, isBlocked: !!user.isBlocked });
    } catch (err) {
      console.error('PATCH /api/users/:id/block error:', err);
      res.status(500).json({ message: 'Error updating block status' });
    }
  });

  // ── DELETE /api/users/:id/views (admin: reset one tenant's / owner's views) ──
  // Wipes every view record tied to this account, in both directions:
  //   1) Views they MADE  — their PropertyViewer rows ("viewed by" list) and their
  //      PropertyView dedup rows (fingerprint `user:<id>`). Each PropertyView row
  //      deleted was worth exactly +1 on that listing's `views` counter, so that
  //      is decremented back (floored at 0). Older views recorded under a device
  //      fingerprint can't be traced to a user, so they stay counted.
  //   2) Views they RECEIVED — for an owner, every listing they own (userId, or
  //      owner.phone/altPhone matching their mobile, same rule as the Customers
  //      grid) gets views = 0 and all PropertyView / PropertyViewer rows for those
  //      listings are deleted, so visitors can register fresh views afterwards.
  // Only rows belonging to this user / their listings are touched; DailyStat
  // (historical per-day totals) is left alone. Safe to call on an account with no views.
  app.delete('/api/users/:id/views', requireAdmin, requireModuleAction('customers'), requireButton('customers', 'resetviews'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const user = await User.findById(id).select('mobile').lean();
      if (!user) return res.status(404).json({ message: 'Customer not found' });

      // Listings this account owns (across rent/lease/pg/hourlyStay).
      let mobile = String(user.mobile || '').replace(/\D/g, '');
      if (mobile.length > 10 && mobile.startsWith('0')) mobile = mobile.slice(1);
      if (mobile.length > 10 && mobile.startsWith('91')) mobile = mobile.slice(mobile.length - 10);
      const ownerOr = [{ userId: id }];
      if (mobile) ownerOr.push({ 'owner.phone': mobile }, { 'owner.altPhone': mobile });
      const owned = (await Promise.all(
        LISTING_MODEL_LIST.map(M => M.find({ $or: ownerOr }).select('_id').lean())
      )).flat();
      const ownedIds = owned.map(d => String(d._id));
      const ownedSet = new Set(ownedIds);

      // 1) Views they made.
      const madeRows = await PropertyView.find({ fingerprint: `user:${id}` }).select('propertyId').lean();
      const decIds = madeRows
        .map(r => r.propertyId)
        .filter(pid => !ownedSet.has(String(pid)) && mongoose.Types.ObjectId.isValid(pid));
      if (decIds.length) {
        await Promise.all(LISTING_MODEL_LIST.map(M =>
          M.updateMany({ _id: { $in: decIds }, views: { $gt: 0 } }, { $inc: { views: -1 } })
        ));
      }
      const [madeView, madeViewer] = await Promise.all([
        PropertyView.deleteMany({ fingerprint: `user:${id}` }),
        PropertyViewer.deleteMany({ userId: id }),
      ]);

      // 2) Views they received on their own listings.
      let receivedView = { deletedCount: 0 }, receivedViewer = { deletedCount: 0 };
      if (ownedIds.length) {
        await Promise.all(LISTING_MODEL_LIST.map(M =>
          M.updateMany({ _id: { $in: ownedIds } }, { $set: { views: 0 } })
        ));
        [receivedView, receivedViewer] = await Promise.all([
          PropertyView.deleteMany({ propertyId: { $in: ownedIds } }),
          PropertyViewer.deleteMany({ propertyId: { $in: ownedIds } }),
        ]);
      }

      res.json({
        message: 'Views reset',
        listingsReset: ownedIds.length,
        viewedByThemCleared: madeViewer.deletedCount || 0,
        viewsOnTheirListingsCleared: (receivedView.deletedCount || 0) + (receivedViewer.deletedCount || 0),
      });
    } catch (err) {
      console.error('DELETE /api/users/:id/views error:', err);
      res.status(500).json({ message: 'Error resetting views' });
    }
  });

  // -- GET /api/users/:id/viewed-properties (admin: which listings this customer has opened) --
  // Feeds the "Properties viewed" section of the Customers grid's View modal. Reads the
  // customer's PropertyViewer rows (one per logged-in user per listing, newest first) and
  // looks each listing up so the modal can show its readable Property ID (e.g. AAA123).
  // Guest views and views recorded before the "viewed by" feature shipped have no user
  // attached, so they cannot appear here. A listing that has since been deleted is still
  // returned (with removed:true) so the list lines up with the count in the grid.
  app.get('/api/users/:id/viewed-properties', requireAdmin, requireModule('customers'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const rows = await PropertyViewer.find({ userId: id })
        .sort({ lastViewedAt: -1 }).limit(500)
        .select('propertyId firstViewedAt lastViewedAt').lean();
      const ids = rows.map(r => r.propertyId).filter(pid => mongoose.Types.ObjectId.isValid(pid));
      const found = {};
      if (ids.length) {
        const docs = (await Promise.all(LISTING_MODEL_LIST.map(M =>
          M.find({ _id: { $in: ids } })
            .select('propertyId basic.status location.area location.city property.type property.bhk').lean()
        ))).flat();
        docs.forEach(d => { found[String(d._id)] = d; });
      }
      res.json(rows.map(r => {
        const d = found[String(r.propertyId)];
        return {
          _id:           String(r.propertyId),
          propertyId:    d ? (d.propertyId || '') : '',
          removed:       !d,
          status:        d && d.basic ? (d.basic.status || '') : '',
          type:          d && d.property ? [d.property.bhk, d.property.type].filter(Boolean).join(' ') : '',
          area:          d && d.location ? (d.location.area || '') : '',
          city:          d && d.location ? (d.location.city || '') : '',
          firstViewedAt: r.firstViewedAt,
          lastViewedAt:  r.lastViewedAt,
        };
      }));
    } catch (err) {
      console.error('GET /api/users/:id/viewed-properties error:', err);
      res.status(500).json({ message: 'Error fetching viewed properties' });
    }
  });

  // -- Shared by the two "who viewed" admin modals (Properties grid + Customers grid) --
  // Given listing docs ({_id, propertyId}), returns everyone who opened any of them, split into
  // registered TENANTS, registered OWNERS and anonymous GUESTS.
  //  * Registered viewers come from PropertyViewer rows (named, one per user per listing) PLUS
  //    PropertyView rows whose fingerprint is `user:<id>` (logged-in views recorded before the
  //    named list existed), merged per user and resolved against User for name / contact / type.
  //  * Guests are PropertyView rows with a device-hash fingerprint. No identity exists behind
  //    them, so each is a timestamp plus a short device reference only.
  //  * withProps adds the readable Property IDs each viewer/guest opened (Customers modal);
  //    excludeUserId hides the listing owner's own views of their own listings.
  async function collectViewers(listings, { withProps = false, excludeUserId = '' } = {}) {
    const idToPid = {};
    listings.forEach(l => { idToPid[String(l._id)] = l.propertyId || ''; });
    const ids = Object.keys(idToPid);
    if (!ids.length) return { tenants: [], owners: [], guests: [] };

    const [viewerRows, viewRows] = await Promise.all([
      PropertyViewer.find({ propertyId: { $in: ids } }).sort({ lastViewedAt: -1 }).limit(3000)
        .select('userId propertyId userAccountType firstViewedAt lastViewedAt').lean(),
      PropertyView.find({ propertyId: { $in: ids } }).sort({ createdAt: -1 }).limit(5000)
        .select('propertyId fingerprint createdAt').lean(),
    ]);

    const byUser = new Map();
    const touch = (uid, pid, first, last, snap) => {
      if (excludeUserId && uid === String(excludeUserId)) return;
      let e = byUser.get(uid);
      if (!e) {
        e = { firstViewedAt: first, lastViewedAt: last, snapType: snap || '', props: new Set() };
        byUser.set(uid, e);
      } else {
        if (new Date(first) < new Date(e.firstViewedAt)) e.firstViewedAt = first;
        if (new Date(last)  > new Date(e.lastViewedAt))  e.lastViewedAt  = last;
        if (!e.snapType && snap) e.snapType = snap;
      }
      e.props.add(idToPid[pid] || '');
    };
    viewerRows.forEach(v => touch(String(v.userId), String(v.propertyId), v.firstViewedAt, v.lastViewedAt, v.userAccountType));
    const guests = [];
    viewRows.forEach(v => {
      const fp = String(v.fingerprint || '');
      if (fp.startsWith('user:')) touch(fp.slice(5), String(v.propertyId), v.createdAt, v.createdAt, '');
      else {
        const g = { viewedAt: v.createdAt, ref: fp.slice(0, 6).toUpperCase() };
        if (withProps) g.prop = idToPid[String(v.propertyId)] || '';
        guests.push(g);
      }
    });

    const userIds = [...byUser.keys()].filter(u => mongoose.Types.ObjectId.isValid(u));
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } })
          .select('userId name firstName lastName email mobile accountType').lean()
      : [];
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));

    const tenants = [], owners = [];
    byUser.forEach((meta, uid) => {
      const u = userMap[uid];
      const accountType = (u ? u.accountType : meta.snapType) === 'owner' ? 'owner' : 'customer';
      const row = {
        _id:           uid,
        userId:        u ? (u.userId || '') : '',
        name:          u ? ((`${u.firstName || ''} ${u.lastName || ''}`).trim() || u.name || '') : '',
        email:         u ? (u.email  || '') : '',
        mobile:        u ? (u.mobile || '') : '',
        removed:       !u,
        firstViewedAt: meta.firstViewedAt,
        lastViewedAt:  meta.lastViewedAt,
      };
      if (withProps) row.props = [...meta.props].filter(Boolean).sort();
      (accountType === 'owner' ? owners : tenants).push(row);
    });
    const byLast = (a, b) => new Date(b.lastViewedAt || 0) - new Date(a.lastViewedAt || 0);
    tenants.sort(byLast); owners.sort(byLast);
    return { tenants, owners, guests };
  }

  // -- GET /api/properties/:id/viewers-admin (admin: who viewed one listing) --
  // Feeds the eye-badge modal in the Properties grid's Views column.
  app.get('/api/properties/:id/viewers-admin', requireAdmin, requireModule('properties'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid property id' });
      const found = await findListingById(id, { lean: true });
      const doc = found && found.doc;
      const data = await collectViewers([{ _id: id, propertyId: doc ? doc.propertyId : '' }]);
      res.json({ propertyId: doc ? (doc.propertyId || '') : '', totalViews: doc ? (doc.views || 0) : 0, ...data });
    } catch (err) {
      console.error('GET /api/properties/:id/viewers-admin error:', err);
      res.status(500).json({ message: 'Error fetching viewers' });
    }
  });

  // -- GET /api/users/:id/listing-viewers (admin: who viewed THIS customer's listings) --
  // Feeds the Customers grid's eye-badge modal. "Their listings" uses the same ownership rule as
  // the grid's counts: listing.userId matches, or owner.phone / owner.altPhone equals their mobile.
  app.get('/api/users/:id/listing-viewers', requireAdmin, requireModule('customers'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid user id' });
      const user = await User.findById(id).select('mobile').lean();
      if (!user) return res.status(404).json({ message: 'User not found' });
      let m = String(user.mobile || '').replace(/\D/g, '');
      if (m.length > 10 && m.startsWith('0')) m = m.slice(1);
      if (m.length > 10 && m.startsWith('91')) m = m.slice(m.length - 10);
      const or = [{ userId: id }];
      if (m) { or.push({ 'owner.phone': m }, { 'owner.altPhone': m }); }
      const listings = (await Promise.all(LISTING_MODEL_LIST.map(M =>
        M.find({ $or: or }).select('propertyId views').lean()
      ))).flat();
      const data = await collectViewers(listings, { withProps: true, excludeUserId: id });
      res.json({ listings: listings.length, ...data });
    } catch (err) {
      console.error('GET /api/users/:id/listing-viewers error:', err);
      res.status(500).json({ message: 'Error fetching listing viewers' });
    }
  });

  app.patch('/api/users/mobile/:mobile/remarks', requireAdmin, requireModuleAction('customers'), async (req, res) => {
    try {
      const { remarks } = req.body || {};
      if (!remarks || !String(remarks).trim()) return res.status(400).json({ message: 'Remark text is required' });
      const user = await findUserByMobileOrId(req.params.mobile);
      if (!user) return res.status(404).json({ message: 'Customer not found' });
      user.remarks.push({ remark: String(remarks).trim().slice(0, 200), date: new Date() });
      await user.save();
      res.json({ message: 'Remark added', remarks: user.remarks });
    } catch (err) {
      console.error('PATCH /api/users/mobile/:mobile/remarks error:', err);
      res.status(500).json({ message: 'Error saving remark' });
    }
  });

  const TENANT_REASONS = ['Not interested', 'Found elsewhere', 'Spam / fake', 'Not serviceable location', 'Callback', 'Not answered', 'Switched off', 'Shifted through us'];
  const OWNER_REASONS  = ['Not reachable', 'Verification pending', 'Duplicate account', 'Wants to delist', 'Rent expectation high', 'Agent / broker', 'Callback', 'Not answered', 'Switched off', 'Shifted through us'];
  app.patch('/api/users/mobile/:mobile/reason', requireAdmin, requireModuleAction('customers'), async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim();
      const user = await findUserByMobileOrId(req.params.mobile);
      if (!user) return res.status(404).json({ message: 'Customer not found' });
      const allowed = user.accountType === 'owner' ? OWNER_REASONS : TENANT_REASONS;
      if (reason && !allowed.includes(reason)) return res.status(400).json({ message: 'Invalid reason' });
      user.reason = reason;
      await user.save();
      res.json({ message: 'Reason saved', reason: user.reason });
    } catch (err) {
      console.error('PATCH /api/users/mobile/:mobile/reason error:', err);
      res.status(500).json({ message: 'Error saving reason' });
    }
  });

  // Removes remarks[idx] straight in MongoDB with an atomic update (no full-document
  // validate/save, so unrelated invalid fields on the record can't block the delete).
  // Returns the remaining remarks, or null if nothing was written.
  async function deleteRemarkAt(doc, idx) {
    const remaining = doc.toObject().remarks || [];
    remaining.splice(idx, 1);
    const r = await doc.constructor.updateOne({ _id: doc._id }, { $set: { remarks: remaining } });
    if (!r || r.matchedCount === 0) return null;
    return remaining;
  }

  app.delete('/api/users/mobile/:mobile/remarks/:idx', requireAdmin, requireModuleAction('customers'), async (req, res) => {
    try {
      const idx  = Number(req.params.idx);
      const user = await findUserByMobileOrId(req.params.mobile);
      if (!user) return res.status(404).json({ message: 'Customer not found' });
      if (!Number.isInteger(idx) || idx < 0 || idx >= user.remarks.length)
        return res.status(400).json({ message: 'Invalid remark index' });
      const remaining = await deleteRemarkAt(user, idx);
      if (!remaining) return res.status(404).json({ message: 'Customer not found' });
      res.json({ message: 'Remark deleted', remarks: remaining });
    } catch (err) {
      console.error('DELETE /api/users/mobile/:mobile/remarks/:idx error:', err);
      res.status(500).json({ message: 'Error deleting remark' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ── ADMIN: APPOINTMENTS GRID ──
  // ─────────────────────────────────────────────────────────────────────────
  function visitTimeToDisplay(hhmm) {
    if (!hhmm) return '';
    const [hStr, mStr] = hhmm.split(':');
    let h = Number(hStr);
    const m = String(mStr || '00').padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${m} ${ampm}`;
  }

  function visitTimeToSlot(hhmm) {
    const h = Number(String(hhmm || '').split(':')[0]);
    if (Number.isNaN(h)) return '';
    if (h < 12) return 'Morning';
    if (h < 17) return 'Afternoon';
    return 'Evening';
  }

  function toApptRow(doc) {
    const prop         = doc.propertyId && typeof doc.propertyId === 'object' ? doc.propertyId : null;
    const user         = doc.userId && typeof doc.userId === 'object' ? doc.userId : null;
    const propertyName = (prop && prop.owner    && prop.owner.propertyName) || '';
    const propertyArea = (prop && prop.location && prop.location.area)      || '';
    const purpose      = (prop && prop.basic    && prop.basic.status)       || 'General Enquiry';
    return {
      _id:             doc._id,
      visitId:         doc.visitId      || '',
      name:            doc.visitorName  || '',
      mobile:          doc.visitorPhone || '',
      email:           doc.email        || '',
      profilePhoto:    (user && user.profilePhoto) || '',
      propertyId:      (prop && prop.propertyId) || '', // human-readable Property.propertyId code (e.g. AAA123), not the Mongo _id
      propertyName,
      propertyArea,
      purpose,
      date:            doc.visitDate    || '',
      visitTime:       doc.visitTime    || '',
      visitTimeDisplay:visitTimeToDisplay(doc.visitTime),
      timeSlot:        visitTimeToSlot(doc.visitTime),
      message:         doc.note         || '',
      status:          String(doc.status || 'Pending').toLowerCase(),
      remarks:         doc.remarks      || [],
      userId:          (user && user._id) || doc.userId || null,
      userReadableId:  doc.userReadableId || '',
      createdAt:       doc.createdAt,
    };
  }

  app.get('/api/appointments', requireAdmin, requireModule('appointments'), async (req, res) => {
    try {
      const docs = await VisitRequest.find({})
        .sort({ createdAt: -1 })
        .populate('propertyId', 'basic.status owner.propertyName location.area propertyId')
        .populate('userId', 'profilePhoto')
        .lean();
      res.json(docs.map(toApptRow));
    } catch (err) {
      console.error('GET /api/appointments error:', err);
      res.status(500).json({ message: 'Error fetching appointments' });
    }
  });

  app.patch('/api/appointments/:id', requireAdmin, requireModuleAction('appointments'), async (req, res) => {
    try {
      const { status } = req.body || {};
      const STATUS_MAP = { pending:'Pending', confirmed:'Confirmed', cancelled:'Cancelled', completed:'Completed' };
      const mapped = STATUS_MAP[String(status || '').toLowerCase()];
      if (!mapped) return res.status(400).json({ message: 'Invalid status' });
      const before = await VisitRequest.findById(req.params.id).lean();
      const visit = await VisitRequest.findByIdAndUpdate(req.params.id, { status: mapped }, { new: true });
      if (!visit) return res.status(404).json({ message: 'Appointment not found' });

      if (before && before.status !== mapped && visit.userId) {
        const statusText = {
          Confirmed: 'confirmed', Cancelled: 'cancelled',
          Completed: 'marked as completed', Pending: 'set back to pending',
        }[mapped] || mapped.toLowerCase();
        await notifyUser(visit.userId, {
          type: 'visit_status',
          title: `Visit ${statusText}`,
          message: `Your visit scheduled for ${visit.visitDate} at ${visit.visitTime} has been ${statusText}.`,
          meta: { visitId: visit.visitId, mongoId: String(visit._id), status: mapped, ...(await visitCalendarMeta(visit)) },
        });
      }

      res.json({ message: 'Status updated' });
    } catch (err) {
      console.error('PATCH /api/appointments/:id error:', err);
      res.status(500).json({ message: 'Error updating appointment' });
    }
  });

  app.patch('/api/appointments/:id/remarks', requireAdmin, requireModuleAction('appointments'), async (req, res) => {
    try {
      const { remarks } = req.body || {};
      if (!remarks || !String(remarks).trim()) return res.status(400).json({ message: 'Remark text is required' });
      const visit = await VisitRequest.findById(req.params.id);
      if (!visit) return res.status(404).json({ message: 'Appointment not found' });
      visit.remarks.push({ remark: String(remarks).trim().slice(0, 200), date: new Date() });
      await visit.save();
      res.json({ message: 'Remark added', remarks: visit.remarks });
    } catch (err) {
      console.error('PATCH /api/appointments/:id/remarks error:', err);
      res.status(500).json({ message: 'Error saving remark' });
    }
  });

  app.delete('/api/appointments/:id/remarks/:idx', requireAdmin, requireModuleAction('appointments'), async (req, res) => {
    try {
      const idx   = Number(req.params.idx);
      const visit = await VisitRequest.findById(req.params.id);
      if (!visit) return res.status(404).json({ message: 'Appointment not found' });
      if (!Number.isInteger(idx) || idx < 0 || idx >= visit.remarks.length)
        return res.status(400).json({ message: 'Invalid remark index' });
      const remaining = await deleteRemarkAt(visit, idx);
      if (!remaining) return res.status(404).json({ message: 'Appointment not found' });
      res.json({ message: 'Remark deleted', remarks: remaining });
    } catch (err) {
      console.error('DELETE /api/appointments/:id/remarks/:idx error:', err);
      res.status(500).json({ message: 'Error deleting remark' });
    }
  });

  app.delete('/api/appointments/:id', requireAdmin, requireModuleAction('appointments'), async (req, res) => {
    try {
      const visit = await VisitRequest.findByIdAndDelete(req.params.id);
      if (!visit) return res.status(404).json({ message: 'Appointment not found' });
      res.json({ message: 'Appointment deleted' });
    } catch (err) {
      console.error('DELETE /api/appointments/:id error:', err);
      res.status(500).json({ message: 'Error deleting appointment' });
    }
  });

  // ── POST /api/appointments/bulk-delete (admin: delete many appointments at once) ──
  app.post('/api/appointments/bulk-delete', requireAdmin, requireModuleAction('appointments'), async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ message: 'ids must be a non-empty array' });
      }
      const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
      if (!validIds.length) return res.status(400).json({ message: 'No valid appointment ids provided' });
      const result = await VisitRequest.deleteMany({ _id: { $in: validIds } });
      res.json({ message: `${result.deletedCount} appointment(s) deleted`, deletedCount: result.deletedCount });
    } catch (err) {
      console.error('POST /api/appointments/bulk-delete error:', err);
      res.status(500).json({ message: 'Error deleting appointments' });
    }
  });

  // ── GET /api/admin/properties (admin panel — flat array + flat fields) ──
  // admin.html's DataTable AND its View-modal (openAdminPropModal) both read
  // flat fields off each row — there is no nested basic/location/owner/... here,
  // everything is flattened to match what the modal's MODAL_FIELD_GROUPS expects.
  // Kept separate from the public GET /api/properties so that endpoint's
  // nested shape stays untouched for whatever already consumes it.
  // GET /api/admin/property-ids - every listing's human-readable Property ID
  // (all three listing collections), for the Booking Details dropdown.
  app.get('/api/admin/property-ids', requireAdmin, requireModule('properties'), async (req, res) => {
    try {
      const arrays = await Promise.all(LISTING_MODEL_LIST.map(M =>
        M.find({ propertyId: { $exists: true, $ne: '' } })
          .select('propertyId owner.phone owner.altPhone createdAt').lean()
      ));
      const list = arrays.flat()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(d => {
          const o = d.owner || {};
          // 9035205230 in the owner number is a placeholder - don't show it
          const ownerNum = String(o.phone || '').replace(/\D/g, '').slice(-10) === '9035205230' ? '' : o.phone;
          const label = [d.propertyId, ownerNum, o.altPhone].filter(Boolean).join(' - ');
          return { _id: String(d._id), propertyId: d.propertyId, label };
        });
      res.json(list);
    } catch (err) {
      console.error('GET /api/admin/property-ids error:', err);
      res.status(500).json({ message: 'Error loading property IDs' });
    }
  });

  // ── PROPERTY AVAILABILITY (Customers > Property Owners table) ──────────────
  // Reason (available / not available) + remark per listing, kept in its OWN
  // collection ('propertyAvailability') instead of on the listing document.
  // One doc per listing holds the latest values; every save is also pushed
  // onto `history` so earlier reasons/remarks are never lost.
  const AVAILABILITY_REASONS = {
    'Available':              true,
    'Already rented':         false,
    'Rented through us':      false,
    'Owner not reachable':    false,
    'Owner withdrew listing': false,
    'Under renovation':       false,
    'Sold':                   false,
  };
  const PropertyAvailabilitySchema = new mongoose.Schema({
    propertyObjectId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    propertyId:       { type: String, default: '', index: true },
    available:        { type: Boolean, default: null },
    reason:           { type: String, default: '' },
    remark:           { type: String, default: '', maxlength: 500 },
    updatedBy:        { type: String, default: '' },
    updatedAt:        { type: Date, default: Date.now },
    history: [{
      _id: false,
      available: Boolean, reason: String, remark: String, by: String,
      at: { type: Date, default: Date.now },
    }],
  }, { collection: 'propertyAvailability' });
  const PropertyAvailability = mongoose.model('PropertyAvailability', PropertyAvailabilitySchema);

  app.get('/api/admin/property-availability', requireAdmin, requireModule('customers'), async (req, res) => {
    try {
      const rows = await PropertyAvailability.find({}, { history: 0 }).lean();
      res.json(rows.map(r => ({
        _id: String(r.propertyObjectId), propertyId: r.propertyId || '',
        available: r.available, reason: r.reason || '', remark: r.remark || '',
        updatedBy: r.updatedBy || '', updatedAt: r.updatedAt,
      })));
    } catch (err) {
      console.error('GET /api/admin/property-availability error:', err);
      res.status(500).json({ message: 'Error loading availability' });
    }
  });

  app.put('/api/admin/property-availability/:id', requireAdmin, requireModuleAction('customers'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid property id' });
      const reason = String((req.body && req.body.reason) || '').trim();
      const remark = String((req.body && req.body.remark) || '').trim().slice(0, 500);
      if (reason && !Object.prototype.hasOwnProperty.call(AVAILABILITY_REASONS, reason)) {
        return res.status(400).json({ message: 'Invalid reason' });
      }
      const found = await findListingById(id, { lean: true });
      if (!found || !found.doc) return res.status(404).json({ message: 'Property not found' });
      const available = reason ? AVAILABILITY_REASONS[reason] : null;
      const by = req.adminEmail || '';
      const now = new Date();
      const doc = await PropertyAvailability.findOneAndUpdate(
        { propertyObjectId: id },
        {
          $set:  { propertyId: found.doc.propertyId || '', available, reason, remark, updatedBy: by, updatedAt: now },
          $push: { history: { available, reason, remark, by, at: now } },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      res.json({
        _id: String(doc.propertyObjectId), propertyId: doc.propertyId, available: doc.available,
        reason: doc.reason, remark: doc.remark, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt,
      });
    } catch (err) {
      console.error('PUT /api/admin/property-availability/:id error:', err);
      res.status(500).json({ message: 'Error saving availability' });
    }
  });

  app.get('/api/admin/properties', requireAdmin, requireModule('properties'), async (req, res) => {
    try {
      const docArrays = await Promise.all(LISTING_MODEL_LIST.map(M => M.find({}).populate('userId', 'profilePhoto').lean()));
      // 0 and null/undefined both mean "unranked" (see the promoted-priority
      // route below and admin.html's column render) and must sort to the
      // back, behind any listing with a real (>0) position.
      const rankOf = v => (v != null && v > 0) ? v : Infinity;
      const docs = docArrays.flat().sort((a, b) =>
        (Number(b.promoted) - Number(a.promoted)) ||
        (rankOf(a.promotedPriority) - rankOf(b.promotedPriority)) ||
        (new Date(b.createdAt) - new Date(a.createdAt))
      );

      const flat = docs.map(doc => {
        const basic    = doc.basic    || {};
        const location = doc.location || {};
        const owner    = doc.owner    || {};
        const price    = doc.price    || {};
        const property = doc.property || {};
        const amenities = doc.amenities || {};
        const media     = doc.media     || {};
        const pg        = doc.pg        || {};
        const shortStay = doc.shortStay || {};

        return {
          _id:          String(doc._id),
          propertyId:   doc.propertyId || '',
          userId:       doc.userReadableId || '', // human-readable User.userId (e.g. USER-000001), blank if posted while logged out

          // Complete raw record (every field stored in the DB for this property,
          // nested exactly as in the schema). The flattened fields below remain
          // for the table/cards and for the modal's existing named fields; `full`
          // exists so the View modal can also render anything NOT covered by the
          // flattened fields below — including ones added to the schema later
          // without needing a matching admin.html change.
          full: {
            basic, location, owner, price, property,
            amenities, terms: doc.terms || {}, rules: doc.rules || {},
            media, pg, shortStay,
            verified:         !!doc.verified,
            promoted:         !!doc.promoted,
            promotedPriority: doc.promotedPriority != null ? doc.promotedPriority : null,
            booked:           !!doc.booked,
            blocked:          !!doc.blocked,
            ownerDirectCall:  !!doc.ownerDirectCall,
            ownerPhoneCall:   !!doc.ownerPhoneCall,
            views:            doc.views != null ? doc.views : 0,
            visitCount:       doc.visitCount != null ? doc.visitCount : 0,
          },

          // Basic Info
          title:        owner.propertyName || '',
          status:       basic.status || '',
          price:        price.rent != null ? price.rent : null,
          displayPrice: formatPrice(price.rent, basic.status),
          city:         location.city || '',
          loc:          location.area || '',
          facing:       property.facing || '',
          age:          property.age || '',
          views:        doc.views != null ? doc.views : 0,
          visitCount:   doc.visitCount != null ? doc.visitCount : 0,
          verified:     !!doc.verified,
          promoted:     !!doc.promoted,
          booked:       !!doc.booked,
          blocked:      !!doc.blocked,
          ownerDirectCall: !!doc.ownerDirectCall,
          ownerPhoneCall:  !!doc.ownerPhoneCall,
          bookingDetails: doc.bookingDetails || null,
          bhk:          property.bhk || '',
          area:         property.area || '',
          floor:        property.floor || '',
          furnishing:   basic.status === 'PG' ? (pg.furnish || '')
                      : basic.status === 'Short Stay' ? (shortStay.furnish || '')
                      : (property.furnish || ''),
          carparking:   basic.status === 'PG' ? (pg.car || '') : (property.car || ''),
          bikeparking:  basic.status === 'PG' ? (pg.bike || '') : (property.bike || ''),
          toilet:       basic.status === 'PG' ? (pg.bathroom || '') : (property.bathrooms || ''),
          deposit:      price.deposit != null ? price.deposit : null,
          maintenance:  price.maintenance != null ? price.maintenance : null,
          negotiable:   price.negotiable || null,

          // PG Details
          pgPropertyType: pg.type || '',
          pgGender:     pg.gender || '',
          pgRoomType:   pg.room || '',
          pgMeals:      pg.meals || '',
          pgOccupancy:  pg.occupancy || '',
          pgNotice:     pg.notice || '',
          pgBathroom:   pg.bathroom || '',

          // Short Stay Details
          ssPropertyType:  shortStay.type || '',
          ssRoomType:      shortStay.roomType || '',
          ssAvailable24hrs:shortStay.available24hrs || '',
          ssCancellation:  shortStay.cancellation || '',
          ssCouplesAllowed:shortStay.couplesAllowed || '',
          ssFurnish:       shortStay.furnish || '',

          // Owner Info
          ownerName:    owner.name || '',
          ownerNumber:  owner.phone || '',
          ownerEmail:   owner.email || '',
          ownerAltPhone:owner.altPhone || '',
          ownerContactTime: owner.contactTime || '',
          // There's no photo on the manually-entered owner contact card itself —
          // this borrows the profilePhoto off the User account that posted the
          // listing (same field the Customers/Appointments tables use).
          ownerProfilePhoto: (doc.userId && typeof doc.userId === 'object' && doc.userId.profilePhoto) || '',

          // Admin
          remarks:      doc.remarks || [],
          reason:       doc.reason || '',
          createdAt:    doc.createdAt,

          // Gallery / description / amenities / map
          images:       Array.isArray(media.images) ? media.images : [],
          video:        media.video || '',
          desc:         media.desc || '',
          amenities:    Array.isArray(amenities.selected) ? amenities.selected : [],
          latitude:     location.lat != null ? location.lat : null,
          longitude:    location.lng != null ? location.lng : null,
        };
      });

      res.json(flat);
    } catch (err) {
      console.error('GET /api/admin/properties error:', err);
      res.status(500).json({ message: 'Error fetching properties' });
    }
  });

  // ── PATCH /api/properties/:id/remarks (admin: add a remark) ──
  app.patch('/api/properties/:id/remarks', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const { remarks } = req.body || {};
      if (!remarks || !String(remarks).trim()) {
        return res.status(400).json({ message: 'remarks is required' });
      }
      const { doc: prop } = await findListingById(req.params.id);
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      if (prop.remarks.length >= 200) {
        return res.status(400).json({ message: 'This property already has the maximum number of remarks (200). Delete an old one first.' });
      }
      prop.remarks.push(String(remarks).trim());
      await prop.save();
      res.json({ message: 'Remark added', remarks: prop.remarks });
    } catch (err) {
      console.error('PATCH /api/properties/:id/remarks error:', err);
      res.status(500).json({ message: 'Error adding remark' });
    }
  });

  // ── PATCH /api/properties/:id/reason (admin: set reason from dropdown; '' clears) ──
  const PROPERTY_REASONS = ['Already rented', 'Wrong details', 'Photos missing', 'Price too high', 'Duplicate listing', 'Fake listing', 'Location mismatch', 'Under renovation', 'Callback', 'Not answered', 'Switched off', 'Shifted through us'];
  app.patch('/api/properties/:id/reason', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim();
      if (reason && !PROPERTY_REASONS.includes(reason)) return res.status(400).json({ message: 'Invalid reason' });
      const { doc: prop } = await findListingById(req.params.id);
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      prop.reason = reason;
      await prop.save();
      res.json({ message: 'Reason saved', reason: prop.reason });
    } catch (err) {
      console.error('PATCH /api/properties/:id/reason error:', err);
      res.status(500).json({ message: 'Error saving reason' });
    }
  });

  // ── DELETE /api/properties/:id/remarks/:idx (admin: remove a remark) ──
  app.delete('/api/properties/:id/remarks/:idx', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const idx = Number(req.params.idx);
      const { doc: prop } = await findListingById(req.params.id);
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      if (!Number.isInteger(idx) || idx < 0 || idx >= prop.remarks.length) {
        return res.status(400).json({ message: 'Invalid remark index' });
      }
      const remaining = await deleteRemarkAt(prop, idx);
      if (!remaining) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Remark deleted', remarks: remaining });
    } catch (err) {
      console.error('DELETE /api/properties/:id/remarks/:idx error:', err);
      res.status(500).json({ message: 'Error deleting remark' });
    }
  });

  // ── PATCH /api/properties/:id/verified (admin: toggle verified flag) ──
  app.patch('/api/properties/:id/verified', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const { verified } = req.body || {};
      if (typeof verified !== 'boolean') {
        return res.status(400).json({ message: 'verified must be a boolean' });
      }
      // Grab the pre-update state so we only notify on the false → true
      // transition, not on every re-save while already verified.
      const before = await findListingById(req.params.id, { lean: true });
      const prop = await updateListingById(req.params.id, { verified }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });

      if (verified === true && before.doc && !before.doc.verified && prop.userId) {
        await notifyUser(prop.userId, {
          type: 'property_verified',
          title: 'Listing verified',
          message: `Your ${prop.basic.status} listing "${prop.owner.propertyName}" in ${prop.location.area} is now verified and live for everyone to see.`,
          meta: { propertyId: prop.propertyId, mongoId: String(prop._id) },
        });
      }

      res.json({ message: 'Verified status updated', verified: prop.verified });
    } catch (err) {
      console.error('PATCH /api/properties/:id/verified error:', err);
      res.status(500).json({ message: 'Error updating verified status' });
    }
  });

  // ── PATCH /api/properties/:id/promoted (admin: toggle promoted flag) ──
  app.patch('/api/properties/:id/promoted', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const { promoted } = req.body || {};
      if (typeof promoted !== 'boolean') {
        return res.status(400).json({ message: 'promoted must be a boolean' });
      }
      const prop = await updateListingById(req.params.id, { promoted }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Promoted status updated', promoted: prop.promoted });
    } catch (err) {
      console.error('PATCH /api/properties/:id/promoted error:', err);
      res.status(500).json({ message: 'Error updating promoted status' });
    }
  });

  // ── PATCH /api/properties/:id/promoted-priority (admin: set where in the
  // Promoted order this listing lands — 1 = first, 10 = tenth, etc.) ──
  // Promoted listings are sorted ascending by this number (ties broken by
  // newest first), so a lower value = higher up the list. Doesn't require
  // the listing to already be promoted — an admin can pre-set a position
  // before flipping the Promoted toggle on.
  app.patch('/api/properties/:id/promoted-priority', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const { promotedPriority } = req.body || {};
      if (typeof promotedPriority !== 'number' || !Number.isFinite(promotedPriority) ||
          !Number.isInteger(promotedPriority) || promotedPriority < 0) {
        return res.status(400).json({ message: 'promotedPriority must be a whole number, 0 or higher (0 = unranked, 1 = first place)' });
      }
      const prop = await updateListingById(req.params.id, { promotedPriority }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Promoted position updated', promotedPriority: prop.promotedPriority });
    } catch (err) {
      console.error('PATCH /api/properties/:id/promoted-priority error:', err);
      res.status(500).json({ message: 'Error updating promoted position' });
    }
  });

  // ── PATCH /api/properties/:id/ownerDirectCall | ownerPhoneCall (admin: "Public call" toggles) ──
  // ownerDirectCall → let index visitors call owner.altPhone; ownerPhoneCall → owner.phone.
  // Each is only allowed while that number is actually on file.
  [['ownerDirectCall', 'altPhone', 'alternate'], ['ownerPhoneCall', 'phone', 'owner']].forEach(([flag, numField, label]) => {
    app.patch('/api/properties/:id/' + flag, requireAdmin, requireModuleAction('properties'), requireButton('properties', 'publiccall'), async (req, res) => {
      try {
        const value = (req.body || {})[flag];
        if (typeof value !== 'boolean') {
          return res.status(400).json({ message: flag + ' must be a boolean' });
        }
        if (value) {
          const found = await findListingById(req.params.id, { lean: true });
          if (!found.doc) return res.status(404).json({ message: 'Property not found' });
          if (!String((found.doc.owner || {})[numField] || '').trim()) {
            return res.status(400).json({ message: 'Add the ' + label + ' number first' });
          }
        }
        const prop = await updateListingById(req.params.id, { [flag]: value }, { new: true });
        if (!prop) return res.status(404).json({ message: 'Property not found' });
        res.json({ message: 'Public call updated', [flag]: !!prop[flag] });
      } catch (err) {
        console.error('PATCH /api/properties/:id/' + flag + ' error:', err);
        res.status(500).json({ message: 'Error updating public call' });
      }
    });
  });

  // ── PATCH /api/properties/:id/publicCall (admin: ONE "Public call" toggle per listing) ──
  // Sets ownerPhoneCall and ownerDirectCall together in a single update, so the
  // two flags can never end up out of sync. ON enables each flag whose number is
  // on file (needs at least one); OFF clears both.
  app.patch('/api/properties/:id/publicCall', requireAdmin, requireModuleAction('properties'), requireButton('properties', 'publiccall'), async (req, res) => {
    try {
      const value = (req.body || {}).publicCall;
      if (typeof value !== 'boolean') {
        return res.status(400).json({ message: 'publicCall must be a boolean' });
      }
      const update = { ownerPhoneCall: false, ownerDirectCall: false };
      if (value) {
        const found = await findListingById(req.params.id, { lean: true });
        if (!found.doc) return res.status(404).json({ message: 'Property not found' });
        const owner = found.doc.owner || {};
        const hasMain = !!String(owner.phone || '').trim();
        const hasAlt  = !!String(owner.altPhone || '').trim();
        if (!hasMain && !hasAlt) {
          return res.status(400).json({ message: 'Add an owner number first' });
        }
        update.ownerPhoneCall  = hasMain;
        update.ownerDirectCall = hasAlt;
      }
      const prop = await updateListingById(req.params.id, update, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({
        message: 'Public call updated',
        publicCall: !!(prop.ownerPhoneCall || prop.ownerDirectCall),
        ownerPhoneCall: !!prop.ownerPhoneCall,
        ownerDirectCall: !!prop.ownerDirectCall,
      });
    } catch (err) {
      console.error('PATCH /api/properties/:id/publicCall error:', err);
      res.status(500).json({ message: 'Error updating public call' });
    }
  });

  // ── PATCH /api/properties/:id/booked (admin: toggle booked flag) ──
  // Once true, the listing is excluded from GET /api/properties (see the
  // `booked: { $ne: true }` filter there) and disappears from the public site,
  // regardless of its verified status.
  app.patch('/api/properties/:id/booked', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const { booked } = req.body || {};
      if (typeof booked !== 'boolean') {
        return res.status(400).json({ message: 'booked must be a boolean' });
      }
      const prop = await updateListingById(req.params.id, { booked }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Booked status updated', booked: prop.booked });
    } catch (err) {
      console.error('PATCH /api/properties/:id/booked error:', err);
      res.status(500).json({ message: 'Error updating booked status' });
    }
  });

  // ── PATCH /api/properties/:id/block (admin: block / unblock a property) ──
  // Body: { blocked: true | false }. A blocked property disappears from the public platform at
  // once — GET /api/properties, the shared-link page, visit requests and bookings all exclude it.
  // Nothing is deleted; unblocking brings it back exactly as it was (still needs verified:true).
  app.patch('/api/properties/:id/block', requireAdmin, requireModuleAction('properties'), requireButton('properties', 'block'), async (req, res) => {
    try {
      const { blocked } = req.body || {};
      if (typeof blocked !== 'boolean') return res.status(400).json({ message: 'blocked must be a boolean' });
      const prop = await updateListingById(req.params.id, { blocked, blockedAt: blocked ? new Date() : null }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: blocked ? 'Property blocked and removed from the platform' : 'Property unblocked', blocked: !!prop.blocked });
    } catch (err) {
      console.error('PATCH /api/properties/:id/block error:', err);
      res.status(500).json({ message: 'Error updating block status' });
    }
  });

  // ── PATCH /api/properties/:id/views/reset (admin: reset one listing's view count to 0) ──
  // Also deletes this listing's own rows from the PropertyView (fingerprint
  // dedup) and PropertyViewer (named "viewed by" list) collections, so a
  // visitor who already viewed it before the reset can register a fresh view
  // afterwards instead of staying invisible to a counter that now reads 0.
  // These are shared collections (every listing's rows live in them), so only
  // this property's own rows are deleted — the collections themselves aren't
  // dropped here (see reset-all below for that).
  app.patch('/api/properties/:id/views/reset', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const prop = await updateListingById(req.params.id, { views: 0 }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      await Promise.all([
        PropertyView.deleteMany({ propertyId: req.params.id }),
        PropertyViewer.deleteMany({ propertyId: req.params.id }),
      ]);
      res.json({ message: 'Views reset', views: prop.views });
    } catch (err) {
      console.error('PATCH /api/properties/:id/views/reset error:', err);
      res.status(500).json({ message: 'Error resetting views' });
    }
  });

  // ── POST /api/properties/views/reset-all (admin: reset every listing's view count to 0) ──
  // Every listing's `views` field is zeroed, and the PropertyView / PropertyViewer
  // dedup collections are emptied (every row deleted, indexes kept intact —
  // see emptyCollection above) so every visitor's/user's view history across
  // every listing is wiped clean.
  app.post('/api/properties/views/reset-all', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const results = await Promise.all(LISTING_MODEL_LIST.map(M => M.updateMany({}, { $set: { views: 0 } })));
      const modifiedCount = results.reduce((sum, r) => sum + (r.modifiedCount || 0), 0);
      await Promise.all([emptyCollection(PropertyView), emptyCollection(PropertyViewer)]);
      res.json({ message: 'All views reset', modifiedCount });
    } catch (err) {
      console.error('POST /api/properties/views/reset-all error:', err);
      res.status(500).json({ message: 'Error resetting all views' });
    }
  });

  // ── DELETE /api/properties/:id (example admin-protected route) ──
  app.delete('/api/properties/:id', requireAdmin, requireModuleAction('properties'), requireButton('properties', 'delete'), async (req, res) => {
    try {
      const deleted = await deleteListingById(req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Property deleted' });
    } catch (err) {
      console.error('DELETE /api/properties/:id error:', err);
      res.status(500).json({ message: 'Error deleting property' });
    }
  });

  // ── PATCH /api/properties/:id/booking-details (admin: save owner/tenant/booked-on info) ──
  // Populated from the "Booking Details" modal that opens off the extra action
  // button shown only on rows in the admin Booked tab. ownerId/tenantId are
  // optional — the admin may free-type details for someone not in the Users
  // list — but when present they should be valid User _ids.
  app.patch('/api/properties/:id/booking-details', requireAdmin, requireModuleAction('properties'), requireButton('properties', 'booking'), async (req, res) => {
    try {
      const body = req.body || {};
      const asId = (v) => (v && mongoose.Types.ObjectId.isValid(v)) ? v : null;
      const tenantId = asId(body.tenantId);
      const bookingDetails = {
        propertyId:  (body.propertyId  || '').toString().trim(),
        tenantId,
        tenantName: '', tenantPhone: '', tenantEmail: '', // snapshot filled from the User doc below
        bookedOn:    (body.bookedOn    || '').toString().trim(), // 'YYYY-MM-DD'
        description: (body.description || '').toString().trim(),
        // URLs returned by /api/upload-images, same as property media.images
        agreementImages: Array.isArray(body.agreementImages) ? body.agreementImages.filter(u => typeof u === 'string' && u.trim()) : [],
      };

      // Property ID/tenant/booked-on/description are required — mirrors the admin.html
      // modal's own validation, enforced again here since the API can be called
      // directly. Agreement/proof uploads are optional (attach-when-you-have-them).
      if (!bookingDetails.bookedOn || !bookingDetails.propertyId || !tenantId || !bookingDetails.description) {
        return res.status(400).json({ message: 'Please fill in property ID, tenant, booked-on date, and booking description.' });
      }

      // Tenant is picked by id only; snapshot name/phone/email server-side so
      // the record still reads fine if the User is later edited or deleted.
      const tenant = await User.findById(tenantId).select('name mobile email').lean();
      if (!tenant) return res.status(400).json({ message: 'Selected tenant no longer exists.' });
      bookingDetails.tenantName  = tenant.name   || '';
      bookingDetails.tenantPhone = tenant.mobile || '';
      bookingDetails.tenantEmail = tenant.email  || '';

      const prop = await updateListingById(req.params.id, { bookingDetails }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Booking details saved', bookingDetails: prop.bookingDetails });
    } catch (err) {
      console.error('PATCH /api/properties/:id/booking-details error:', err);
      res.status(500).json({ message: 'Error saving booking details' });
    }
  });

  // ── Booking Details modal uploads (admin-only) ──
  // Agreement and Proof files in that modal are only ever uploaded by an
  // admin, so — unlike the public /api/upload-images in server.js, which has
  // to stay open for anyone submitting a property listing's photos — both
  // routes below sit behind requireAdmin like everything else in this file.
  // Both write into the same ImageAsset store / GET /uploads/:id route
  // server.js already set up for property photos.
  const bookingUploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
    message: { message: 'Too many upload requests. Please try again later.' }
  });

  // Proof — images only, same sharp→WebP treatment as property photos.
  const uploadBookingImages = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'].includes(file.mimetype);
      cb(ok ? null : new Error('Only image files are allowed'), ok);
    },
  });
  app.post('/api/upload-booking-images', requireAdmin, requireModuleAction('properties'), requireButton('properties', 'booking'), bookingUploadLimiter, uploadBookingImages.array('images'), async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ message: 'No images uploaded' });
      const urls = [];
      for (const file of files) {
        const webpBuffer = await sharp(file.buffer)
          .rotate()
          .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        const doc = await ImageAsset.create({ data: webpBuffer, contentType: 'image/webp' });
        // .webp suffix lets the admin.html Booking Details modal tell images
        // and PDFs apart from the URL alone (see uploadBookingDocs below) —
        // GET /uploads/:id strips it before the DB lookup, so this stays
        // backward-compatible with the bare-id URLs everything else here uses.
        urls.push(`/uploads/${doc._id}.webp`);
      }
      res.status(201).json({ message: 'Images uploaded successfully', urls });
    } catch (err) {
      console.error('POST /api/upload-booking-images error:', err);
      res.status(500).json({ message: 'Error uploading images' });
    }
  });

  // Agreement — image or PDF; PDFs are stored as-is (sharp can't touch them).
  const uploadBookingDocs = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }, // PDFs run larger than photos
    fileFilter: (req, file, cb) => {
      const ok = [
        'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
        'application/pdf',
      ].includes(file.mimetype);
      cb(ok ? null : new Error('Only image or PDF files are allowed'), ok);
    },
  });
  app.post('/api/upload-documents', requireAdmin, requireModuleAction('properties'), requireButton('properties', 'booking'), bookingUploadLimiter, uploadBookingDocs.array('documents'), async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ message: 'No files uploaded' });
      const urls = [];
      for (const file of files) {
        if (file.mimetype === 'application/pdf') {
          const doc = await ImageAsset.create({ data: file.buffer, contentType: 'application/pdf' });
          // Extension in the URL is what lets the client distinguish a PDF
          // from an image without a round trip — see the .webp comment above.
          urls.push(`/uploads/${doc._id}.pdf`);
          continue;
        }
        const webpBuffer = await sharp(file.buffer)
          .rotate()
          .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        const doc = await ImageAsset.create({ data: webpBuffer, contentType: 'image/webp' });
        urls.push(`/uploads/${doc._id}.webp`);
      }
      res.status(201).json({ message: 'Files uploaded successfully', urls });
    } catch (err) {
      console.error('POST /api/upload-documents error:', err);
      res.status(500).json({ message: 'Error uploading files' });
    }
  });

  // Multer errors from either route above come through as thrown errors
  // rather than rejections multer formats itself — catch them here so the
  // client gets a clean 400 instead of a raw 500.
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || (err && /Only image( or PDF)? files/.test(err.message || ''))) {
      return res.status(400).json({ message: err.message });
    }
    next(err);
  });

  // ── POST /api/properties/bulk-delete (admin: delete many properties at once) ──
  app.post('/api/properties/bulk-delete', requireAdmin, requireModuleAction('properties'), requireButton('properties', 'delete'), async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ message: 'ids must be a non-empty array' });
      }
      const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
      if (!validIds.length) return res.status(400).json({ message: 'No valid property ids provided' });
      const results = await Promise.all(LISTING_MODEL_LIST.map(M => M.deleteMany({ _id: { $in: validIds } })));
      const deletedCount = results.reduce((sum, r) => sum + r.deletedCount, 0);
      res.json({ message: `${deletedCount} propert${deletedCount === 1 ? 'y' : 'ies'} deleted`, deletedCount });
    } catch (err) {
      console.error('POST /api/properties/bulk-delete error:', err);
      res.status(500).json({ message: 'Error deleting properties' });
    }
  });

  // ── POST /api/admin/properties (admin creates a new listing directly,
  // not tied to any owner account) — same field-handling as POST
  // /api/properties above (owner-created listings), just scoped by
  // requireAdmin instead of requireUser + requireOwner, and userId/
  // userReadableId are left null since there's no owner User account
  // behind an admin-created listing (schema already treats null userId as
  // "posted while logged out", which fits this case too). Doesn't run the
  // owner route's full findMissingRequiredFields() sweep (that helper —
  // and the BASE_REQUIRED_FIELDS/TYPE_REQUIRED_FIELDS lists it needs —
  // live in server.js and aren't handed to this module); the admin form
  // already blocks submission client-side until every visible required
  // field is filled, and validatePropertyFields() below still catches
  // malformed values same as the PUT route just above. ──
  app.post('/api/admin/properties', requireAdmin, requireModuleAction('properties'), requireButton('properties', 'tbAdd'), async (req, res) => {
    try {
      const body = req.body || {};
      const fields = NESTED_SECTIONS.reduce((acc, k) => {
        acc[k] = (body[k] && typeof body[k] === 'object') ? body[k] : {};
        return acc;
      }, {});

      const validationError = validatePropertyFields(fields);
      if (validationError) return res.status(400).json({ message: validationError });

      fields.basic = Object.assign({ status: 'For Rent', listedBy: 'Owner' }, fields.basic);
      fields.media.displayPrice = undefined; // not part of media; computed separately below

      const status = fields.basic.status;

      const priceLabel = status === 'Lease'      ? 'price.rent (lease amount)'
                        : status === 'PG'         ? 'price.rent (monthly charge)'
                        : status === 'Short Stay' ? 'price.rent (per day rate)'
                        :                           'price.rent (monthly rent)';
      if (!fields.owner.propertyName || !fields.location.area ||
          fields.price.rent === undefined || fields.price.rent === null || fields.price.rent === '') {
        return res.status(400).json({ message: `owner.propertyName, location.area, and ${priceLabel} are required.` });
      }
      if (status === 'PG' && (!fields.pg.gender || !fields.pg.room)) {
        return res.status(400).json({ message: 'pg.gender and pg.room are required for PG listings.' });
      }
      if (status === 'Lease' && !fields.terms.lease) {
        return res.status(400).json({ message: 'terms.lease (lease duration) is required for Lease listings.' });
      }
      if (status === 'Short Stay' && !fields.shortStay.roomType) {
        return res.status(400).json({ message: 'shortStay.roomType is required for Short Stay listings.' });
      }

      const displayPrice = formatPrice(fields.price.rent, status);
      const propertyId = await nextPropertyId();

      const ListingModel = modelForStatus(status);
      const prop = new ListingModel({
        propertyId,
        userId:         null, // admin-created listing — no owner User account behind it
        userReadableId: null,
        basic:     fields.basic,
        location:  fields.location,
        owner:     fields.owner,
        price:     fields.price,
        property:  status === 'PG' ? undefined : fields.property,
        amenities: fields.amenities,
        terms:     (status === 'PG' || status === 'Short Stay') ? undefined : fields.terms,
        rules:     (status === 'PG' || status === 'Short Stay') ? undefined : fields.rules,
        media:     fields.media,
        pg:        status === 'PG' ? fields.pg : undefined,
        shortStay: status === 'Short Stay' ? fields.shortStay : undefined,
      });
      await prop.save();

      const saved = prop.toObject();
      saved.displayPrice = displayPrice;

      res.status(201).json({ message: 'Property added successfully!', property: saved });
    } catch (err) {
      console.error('POST /api/admin/properties error:', err);
      res.status(500).json({ message: 'Error saving property' });
    }
  });

  // ── PUT /api/admin/properties/:id (admin edits any listing, regardless of
  // owner) — same field-handling logic as PUT /api/user/listings/:id above,
  // just scoped by requireAdmin + findListingById instead of requireUser +
  // findUserListingById(id, userId), since admin isn't the listing's owner. ──
  app.put('/api/admin/properties/:id', requireAdmin, requireModuleAction('properties'), async (req, res) => {
    try {
      const { doc: prop, model: currentModel } = await findListingById(req.params.id);
      if (!prop) return res.status(404).json({ message: 'Listing not found' });

      const body = req.body || {};
      const fields = NESTED_SECTIONS.reduce((acc, k) => {
        acc[k] = (body[k] && typeof body[k] === 'object') ? body[k] : {};
        return acc;
      }, {});

      const sentSections = NESTED_SECTIONS.filter(k => body[k] && typeof body[k] === 'object');
      const fieldsForValidation = {};
      for (const k of sentSections) fieldsForValidation[k] = fields[k];
      const validationError = validatePropertyFields(fieldsForValidation);
      if (validationError) return res.status(400).json({ message: validationError });

      const FULL_REPLACE_SECTIONS = new Set(['pg', 'shortStay']);
      for (const section of sentSections) {
        prop[section] = FULL_REPLACE_SECTIONS.has(section)
          ? fields[section]
          : Object.assign({}, prop[section]?.toObject ? prop[section].toObject() : prop[section], fields[section]);
      }

      const effectiveStatus = (fields.basic && fields.basic.status) || (prop.basic || {}).status;
      if (effectiveStatus === 'PG') {
        prop.property = undefined;
        prop.terms = undefined;
        prop.rules = undefined;
      } else if (effectiveStatus === 'Short Stay') {
        prop.terms = undefined;
        prop.rules = undefined;
      }

      const savedDoc = await moveListingIfNeeded(prop, currentModel);
      const saved = savedDoc.toObject();
      saved.displayPrice = formatPrice((saved.price || {}).rent, (saved.basic || {}).status);

      res.json({ message: 'Listing updated successfully', property: saved });
    } catch (err) {
      console.error('PUT /api/admin/properties/:id error:', err);
      res.status(500).json({ message: 'Error updating listing' });
    }
  });

  // GET /api/honest-reviews/all — admin-only, returns every entry regardless
  // of status (pending/approved/rejected) or active flag, for the manage UI.
  app.get('/api/honest-reviews/all', requireAdmin, requireModule('reviews'), async (req, res) => {
    try {
      const reviews = await HonestReview.find({})
        .sort({ createdAt: -1 })
        .lean();
      res.json({ reviews });
    } catch (err) {
      console.error('GET /api/honest-reviews/all error:', err.message);
      res.status(500).json({ error: 'Could not load honest reviews' });
    }
  });

  // POST /api/honest-reviews — admin-only, add a new video card (goes live immediately)
  app.post('/api/honest-reviews', requireAdmin, requireModuleAction('reviews'), async (req, res) => {
    try {
      const { videoUrl, thumbUrl, caption, title, meta, verifiedLabel, order, active } = req.body;
      if (!videoUrl || !thumbUrl || !caption || !title) {
        return res.status(400).json({ error: 'videoUrl, thumbUrl, caption and title are required' });
      }
      const review = await HonestReview.create({
        videoUrl, thumbUrl, caption, title,
        meta: meta || '',
        verifiedLabel: verifiedLabel || 'Verified tenant',
        order: Number(order) || 0,
        active: active !== false,
        status: 'approved'
      });
      res.status(201).json({ review });
    } catch (err) {
      console.error('POST /api/honest-reviews error:', err.message);
      res.status(500).json({ error: 'Could not save honest review' });
    }
  });

  // PUT /api/honest-reviews/:id — admin-only, edit an existing video card.
  // Also used to approve/reject user submissions by setting `status` (and
  // typically `active` alongside it).
  app.put('/api/honest-reviews/:id', requireAdmin, requireModuleAction('reviews'), async (req, res) => {
    try {
      const fields = (({ videoUrl, thumbUrl, caption, title, meta, verifiedLabel, order, active, status }) =>
        ({ videoUrl, thumbUrl, caption, title, meta, verifiedLabel, order, active, status }))(req.body);
      Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

      const before = await HonestReview.findById(req.params.id).lean();
      const review = await HonestReview.findByIdAndUpdate(req.params.id, fields, { new: true });
      if (!review) return res.status(404).json({ error: 'Honest review not found' });

      // Only notify on the pending/rejected → approved transition, not on
      // every subsequent edit to an already-approved card.
      if (review.status === 'approved' && before && before.status !== 'approved' && review.userId) {
        await notifyUser(review.userId, {
          type: 'review_approved',
          title: 'Honest Review approved',
          message: `Your video "${review.title}" has been approved and is now live in Honest Reviews.`,
          meta: { reviewId: String(review._id) },
        });
      }

      res.json({ review });
    } catch (err) {
      console.error('PUT /api/honest-reviews/:id error:', err.message);
      res.status(500).json({ error: 'Could not update honest review' });
    }
  });

  // DELETE /api/honest-reviews/:id — admin-only
  app.delete('/api/honest-reviews/:id', requireAdmin, requireModuleAction('reviews'), async (req, res) => {
    try {
      const deleted = await HonestReview.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Honest review not found' });
      res.json({ message: 'Honest review deleted' });
    } catch (err) {
      console.error('DELETE /api/honest-reviews/:id error:', err.message);
      res.status(500).json({ error: 'Could not delete honest review' });
    }
  });

  // POST /api/honest-reviews/bulk-delete — admin-only, delete several cards at once
  app.post('/api/honest-reviews/bulk-delete', requireAdmin, requireModuleAction('reviews'), async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'ids must be a non-empty array' });
      }
      const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
      if (!validIds.length) return res.status(400).json({ error: 'No valid review ids provided' });
      const result = await HonestReview.deleteMany({ _id: { $in: validIds } });
      res.json({ message: `${result.deletedCount} review${result.deletedCount === 1 ? '' : 's'} deleted`, deletedCount: result.deletedCount });
    } catch (err) {
      console.error('POST /api/honest-reviews/bulk-delete error:', err.message);
      res.status(500).json({ error: 'Could not bulk delete honest reviews' });
    }
  });

  // ── Star reviews (the Owner Reviews / Tenant Reviews section on the site; model: Review) ──
  // Separate feature from Honest Reviews (video cards) above, with its own 'userReviews' module.
  // GET /api/admin/reviews — every star review, newest first, plus the reviewer's contact so
  // admin can tell same-named people apart. The reviewer's session key (userKey) is never sent.
  app.get('/api/admin/reviews', requireAdmin, requireModule('userReviews'), async (req, res) => {
    try {
      const reviews = await Review.find({}).select('-userKey').sort({ createdAt: -1 }).lean();
      const users = await User.find({ _id: { $in: reviews.map(r => r.userId).filter(Boolean) } })
        .select('mobile email userId').lean();
      const byId = Object.fromEntries(users.map(u => [String(u._id), u]));
      reviews.forEach(r => {
        const u = byId[String(r.userId)] || {};
        r.contact = u.mobile || u.email || '';
        r.userReadableId = u.userId || '';
      });
      res.json({ reviews });
    } catch (err) {
      console.error('GET /api/admin/reviews error:', err.message);
      res.status(500).json({ error: 'Could not load reviews' });
    }
  });

  // DELETE /api/admin/reviews/:id — the reviewer can post again afterwards (one review per user).
  app.delete('/api/admin/reviews/:id', requireAdmin, requireModuleAction('userReviews'), async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid review id' });
      const deleted = await Review.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Review not found' });
      res.json({ message: 'Review deleted' });
    } catch (err) {
      console.error('DELETE /api/admin/reviews/:id error:', err.message);
      res.status(500).json({ error: 'Could not delete review' });
    }
  });

  // POST /api/admin/reviews/bulk-delete — body: { ids: [...] }
  app.post('/api/admin/reviews/bulk-delete', requireAdmin, requireModuleAction('userReviews'), async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
      const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
      if (!validIds.length) return res.status(400).json({ error: 'No valid review ids provided' });
      const result = await Review.deleteMany({ _id: { $in: validIds } });
      res.json({ message: `${result.deletedCount} review${result.deletedCount === 1 ? '' : 's'} deleted`, deletedCount: result.deletedCount });
    } catch (err) {
      console.error('POST /api/admin/reviews/bulk-delete error:', err.message);
      res.status(500).json({ error: 'Could not bulk delete reviews' });
    }
  });

  // GET /api/admin/partners — admin-only, returns every entry (active or not) for the manage UI.
  app.get('/api/admin/partners', requireAdmin, requireModule('partners'), async (req, res) => {
    try {
      const partners = await Partner.find({}).sort({ order: 1, createdAt: 1 }).lean();
      res.json({ partners });
    } catch (err) {
      console.error('GET /api/admin/partners error:', err.message);
      res.status(500).json({ error: 'Could not load partners' });
    }
  });

  // Only trust a photoUrl that points at an image this admin panel actually
  // generated via /api/upload-partner-photo — same reasoning as the
  // profilePhoto check in server.js. An empty string clears the photo.
  const isValidPartnerPhotoUrl = (val) => val === '' || /^\/uploads\/[a-f0-9]{24}$/.test(val);

  // POST /api/partners — admin-only, add a new partner
  app.post('/api/partners', requireAdmin, requireModuleAction('partners'), async (req, res) => {
    try {
      const { name, role, phone, email, location, avatarText, photoUrl, order, active } = req.body;
      if (!name || !role) {
        return res.status(400).json({ error: 'name and role are required' });
      }
      const cleanPhotoUrl = typeof photoUrl === 'string' ? photoUrl.trim() : '';
      if (!isValidPartnerPhotoUrl(cleanPhotoUrl)) {
        return res.status(400).json({ error: 'Invalid photo' });
      }
      const partner = await Partner.create({
        name, role,
        phone: phone || '',
        email: email || '',
        location: location || '',
        avatarText: avatarText || '',
        photoUrl: cleanPhotoUrl,
        order: Number(order) || 0,
        active: active !== false
      });
      notifyAdmin({
        type:    'partner_added',
        title:   'New partner added',
        message: `${partner.name} (${partner.role}) added to Our Partners`,
        meta:    { mongoId: String(partner._id) },
      }); // fire-and-forget; notifyAdmin swallows its own errors, doesn't block the response
      res.status(201).json({ partner });
    } catch (err) {
      console.error('POST /api/partners error:', err.message);
      res.status(500).json({ error: 'Could not save partner' });
    }
  });

  // PUT /api/partners/:id — admin-only, edit an existing partner
  app.put('/api/partners/:id', requireAdmin, requireModuleAction('partners'), async (req, res) => {
    try {
      const fields = (({ name, role, phone, email, location, avatarText, photoUrl, order, active }) => ({ name, role, phone, email, location, avatarText, photoUrl, order, active }))(req.body);
      Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

      if (fields.photoUrl !== undefined) {
        fields.photoUrl = fields.photoUrl.trim();
        if (!isValidPartnerPhotoUrl(fields.photoUrl)) {
          return res.status(400).json({ error: 'Invalid photo' });
        }
      }

      const partner = await Partner.findByIdAndUpdate(req.params.id, fields, { new: true }).lean();
      if (!partner) return res.status(404).json({ error: 'Partner not found' });
      res.json({ partner });
    } catch (err) {
      console.error('PUT /api/partners/:id error:', err.message);
      res.status(500).json({ error: 'Could not update partner' });
    }
  });

  // POST /api/upload-partner-photo — admin-only, single headshot upload for
  // the Partners modal. Same sharp→WebP pipeline as the booking-details
  // uploads above, sized down for an avatar-sized image, and returns a bare
  // '/uploads/<id>' URL (no ambiguity with PDFs here, so no suffix needed).
  const uploadPartnerPhoto = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'].includes(file.mimetype);
      cb(ok ? null : new Error('Only image files are allowed'), ok);
    },
  });
  app.post('/api/upload-partner-photo', requireAdmin, requireModuleAction('partners'), bookingUploadLimiter, uploadPartnerPhoto.single('photo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: 'No photo uploaded' });
      const webpBuffer = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 500, height: 500, fit: 'cover', position: 'top' })
        .webp({ quality: 82 })
        .toBuffer();
      const doc = await ImageAsset.create({ data: webpBuffer, contentType: 'image/webp' });
      res.status(201).json({ message: 'Photo uploaded successfully', url: `/uploads/${doc._id}` });
    } catch (err) {
      console.error('POST /api/upload-partner-photo error:', err);
      res.status(500).json({ message: 'Error uploading photo' });
    }
  });

  // DELETE /api/partners/:id — admin-only
  app.delete('/api/partners/:id', requireAdmin, requireModuleAction('partners'), async (req, res) => {
    try {
      const deleted = await Partner.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Partner not found' });
      res.json({ message: 'Partner deleted' });
    } catch (err) {
      console.error('DELETE /api/partners/:id error:', err.message);
      res.status(500).json({ error: 'Could not delete partner' });
    }
  });

  // POST /api/partners/bulk-delete — admin-only, delete several partners at once
  app.post('/api/partners/bulk-delete', requireAdmin, requireModuleAction('partners'), async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'ids must be a non-empty array' });
      }
      const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
      if (!validIds.length) return res.status(400).json({ error: 'No valid partner ids provided' });
      const result = await Partner.deleteMany({ _id: { $in: validIds } });
      res.json({ message: `${result.deletedCount} partner${result.deletedCount === 1 ? '' : 's'} deleted`, deletedCount: result.deletedCount });
    } catch (err) {
      console.error('POST /api/partners/bulk-delete error:', err.message);
      res.status(500).json({ error: 'Could not bulk delete partners' });
    }
  });

  // Admin — edit the one shared payment destination shown on every payment screen.
  app.put('/api/admin/payment-settings', requireAdmin, requireModuleAction('payments'), async (req, res) => {
    try {
      const { upiId, qrImageUrl, bankAccountName, bankAccountNumber, bankIfsc, paymentPhone } = req.body || {};
      const settings = await PaymentSettings.findOneAndUpdate(
        { key: 'default' },
        { $set: {
          upiId:             upiId ? String(upiId).trim() : '',
          qrImageUrl:        qrImageUrl ? String(qrImageUrl).trim() : '',
          bankAccountName:   bankAccountName ? String(bankAccountName).trim() : '',
          bankAccountNumber: bankAccountNumber ? String(bankAccountNumber).trim() : '',
          bankIfsc:          bankIfsc ? String(bankIfsc).trim() : '',
          paymentPhone:      paymentPhone ? String(paymentPhone).trim() : '',
          updatedAt: new Date(),
        } },
        { new: true, upsert: true }
      );
      res.json({ message: 'Payment settings updated', settings });
    } catch (err) {
      console.error('PUT /api/admin/payment-settings error:', err.message);
      res.status(500).json({ message: 'Error updating payment settings' });
    }
  });

  // Applies the one purpose that has an automatic side effect on verification
  // ('promotion' → Property.promoted = true). Shared by the admin verify route
  // so it stays consistent if any other verification path is added later. Kept
  // best-effort: a failure here (e.g. the linked listing was since deleted)
  // still leaves the payment marked verified rather than blocking the caller.
  async function applyPaymentVerifiedSideEffects(request) {
    if (request.purpose === 'promotion' && request.propertyId) {
      try {
        await updateListingById(request.propertyId, { promoted: true });
      } catch (sideEffectErr) {
        console.error('Payment verify side-effect error:', sideEffectErr.message);
      }
    }
  }

  // ── Admin: review queue ──
  // Optional ?status= filter, defaulting to everything (newest first) — the
  // admin tab can default its own view to 'submitted' (awaiting review) while
  // still being able to browse verified/rejected history through this same route.
  app.get('/api/admin/payments', requireAdmin, requireModule('payments'), async (req, res) => {
    try {
      const { status } = req.query;
      const filter = status && status !== 'all' ? { status } : {};
      const payments = await PaymentRequest.find(filter).sort({ createdAt: -1 }).lean();
      res.json({ payments });
    } catch (err) {
      console.error('GET /api/admin/payments error:', err.message);
      res.status(500).json({ message: 'Error fetching payments' });
    }
  });

  // Verifying flips status and applies the one purpose that has an automatic
  // side effect ('promotion' → Property.promoted = true). Kept best-effort: a
  // failure to apply the side effect (e.g. the linked listing was since
  // deleted) still leaves the payment marked verified rather than blocking
  // the admin's review action — brokerage/booking/visit_deposit payments are
  // pure financial records with nothing further to flip.
  app.patch('/api/admin/payments/:id/verify', requireAdmin, requireModuleAction('payments'), async (req, res) => {
    try {
      const request = await PaymentRequest.findById(req.params.id);
      if (!request) return res.status(404).json({ message: 'Payment request not found' });

      request.status = 'verified';
      request.verifiedAt = new Date();
      if (typeof (req.body && req.body.adminRemark) === 'string') request.adminRemark = req.body.adminRemark.trim().slice(0, 300);
      await request.save();

      await applyPaymentVerifiedSideEffects(request);

      res.json({ message: 'Payment verified', request });
    } catch (err) {
      console.error('PATCH /api/admin/payments/:id/verify error:', err.message);
      res.status(500).json({ message: 'Error verifying payment' });
    }
  });

  app.patch('/api/admin/payments/:id/reject', requireAdmin, requireModuleAction('payments'), async (req, res) => {
    try {
      const request = await PaymentRequest.findById(req.params.id);
      if (!request) return res.status(404).json({ message: 'Payment request not found' });

      request.status = 'rejected';
      if (typeof (req.body && req.body.adminRemark) === 'string') request.adminRemark = req.body.adminRemark.trim().slice(0, 300);
      await request.save();

      res.json({ message: 'Payment rejected', request });
    } catch (err) {
      console.error('PATCH /api/admin/payments/:id/reject error:', err.message);
      res.status(500).json({ message: 'Error rejecting payment' });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // ── ADMIN: Referrals tab ──
  // Backs the "Refer & Earn" register — list every submission (newest first),
  // let the admin move a referral through Pending → Rewarded/Rejected, and
  // delete stray/duplicate entries. Mirrors the payments queue pattern above.
  // ────────────────────────────────────────────────────────────────────────────
  const REFERRAL_STATUSES = ['Pending', 'Rewarded', 'Rejected'];

  // GET /api/admin/referrals — optional ?status= filter, defaulting to everything.
  app.get('/api/admin/referrals', requireAdmin, requireModule('referrals'), async (req, res) => {
    try {
      const { status } = req.query;
      const filter = status && status !== 'all' ? { status } : {};
      const referrals = await Referral.find(filter).sort({ createdAt: -1 }).lean();
      res.json({ referrals });
    } catch (err) {
      console.error('GET /api/admin/referrals error:', err.message);
      res.status(500).json({ message: 'Error fetching referrals' });
    }
  });

  // PATCH /api/admin/referrals/:id/status — move a referral to Pending/Rewarded/Rejected.
  app.patch('/api/admin/referrals/:id/status', requireAdmin, requireModuleAction('referrals'), async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!REFERRAL_STATUSES.includes(status)) {
        return res.status(400).json({ message: `status must be one of: ${REFERRAL_STATUSES.join(', ')}` });
      }
      const referral = await Referral.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true });
      if (!referral) return res.status(404).json({ message: 'Referral not found' });
      res.json({ message: 'Referral status updated', referral });
    } catch (err) {
      console.error('PATCH /api/admin/referrals/:id/status error:', err.message);
      res.status(500).json({ message: 'Error updating referral status' });
    }
  });

  // DELETE /api/admin/referrals/:id — remove a single referral entry.
  app.delete('/api/admin/referrals/:id', requireAdmin, requireModuleAction('referrals'), async (req, res) => {
    try {
      const referral = await Referral.findByIdAndDelete(req.params.id);
      if (!referral) return res.status(404).json({ message: 'Referral not found' });
      res.json({ message: 'Referral deleted' });
    } catch (err) {
      console.error('DELETE /api/admin/referrals/:id error:', err.message);
      res.status(500).json({ message: 'Error deleting referral' });
    }
  });

  // POST /api/admin/referrals/bulk-delete — remove several referrals at once
  // (same shape as the partners bulk-delete route used by the admin UI).
  app.post('/api/admin/referrals/bulk-delete', requireAdmin, requireModuleAction('referrals'), async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ message: 'ids array is required' });
      }
      await Referral.deleteMany({ _id: { $in: ids } });
      res.json({ message: 'Referrals deleted' });
    } catch (err) {
      console.error('POST /api/admin/referrals/bulk-delete error:', err.message);
      res.status(500).json({ message: 'Error deleting referrals' });
    }
  });

  // GET /api/admin/total-visits — admin-only, all-time visit counter for its own tab.
  app.get('/api/admin/total-visits', requireAdmin, requireAnyModule('stats', 'visits'), async (req, res) => {
    try {
      const doc = await SiteStat.findOne({ key: 'totalVisits' }).lean();
      res.json({ totalVisits: doc ? doc.value : 0 });
    } catch (err) {
      console.error('GET /api/admin/total-visits error:', err.message);
      res.status(500).json({ message: 'Error fetching total visits' });
    }
  });

  // POST /api/admin/total-visits/reset — reset the all-time counter to 0.
  // Deletes the SiteStat counter doc outright (GET /api/admin/total-visits
  // already falls back to 0 when no doc exists, so this is safe) and empties
  // the Visitor dedup collection (every row deleted, indexes kept — see
  // emptyCollection above), so a device/browser that was already counted
  // before the reset can be counted again afterwards instead of staying
  // invisible to a counter that now reads 0.
  app.post('/api/admin/total-visits/reset', requireAdmin, requireAnyModuleAction('stats', 'visits'), async (req, res) => {
    try {
      await SiteStat.deleteOne({ key: 'totalVisits' });
      await emptyCollection(Visitor);
      res.json({ message: 'Total visits reset', totalVisits: 0 });
    } catch (err) {
      console.error('POST /api/admin/total-visits/reset error:', err.message);
      res.status(500).json({ message: 'Error resetting total visits' });
    }
  });

  // GET /api/admin/total-users — admin-only, all-time count of registered user accounts
  // (actual User collection count, distinct from the daily-registration log below).
  app.get('/api/admin/total-users', requireAdmin, requireAnyModule('stats', 'visits'), async (req, res) => {
    try {
      const totalUsers = await User.countDocuments();
      res.json({ totalUsers });
    } catch (err) {
      console.error('GET /api/admin/total-users error:', err.message);
      res.status(500).json({ message: 'Error fetching total users' });
    }
  });

  // ── ADMIN: Daily Visits / Users Registered / Property Views tabs ──
  // :type is 'visit', 'registration', or 'propertyView' — all three are
  // categories under the Visits tab ("Visits" / "Users Registered" / "Property Views").
  const DAILY_STAT_TYPES = ['visit', 'registration', 'propertyView'];

  // GET /api/admin/visitors?scope=today|all — who visited the site (Visits tab).
  //   scope=today (default): visitors whose last visit date is today (todayStr(),
  //                          the same clock as the "Today's site visits" card).
  //   scope=all            : every visitor on record (the "All-time visits" card).
  // Backed by the Visitor dedup collection — one row per device. Logged-in
  // visitors come back with their name/contact (resolved from Visitor.userId);
  // everyone else is a guest, identified only by a short device ref. Raw IPs
  // and fingerprint hashes are never returned. Visitors recorded before this
  // feature shipped have no user link until they next visit / log in.
  function parseDeviceInfo(ua) {
    ua = String(ua || '');
    if (!ua) return { type: '', browser: '', os: '' };
    const type = /iPad|Tablet/i.test(ua) ? 'Tablet'
      : /Mobi|Android|iPhone|iPod/i.test(ua) ? 'Mobile' : 'Desktop';
    const browser = /Edg\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : '';
    const os = /Windows/.test(ua) ? 'Windows'
      : /Android/.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
      : /Linux/.test(ua) ? 'Linux' : '';
    return { type, browser, os };
  }

  app.get('/api/admin/visitors', requireAdmin, requireAnyModule('stats', 'visits'), async (req, res) => {
    try {
      const scope = req.query.scope === 'all' ? 'all' : 'today';
      const date = todayStr();
      const LIMIT = 1000;
      const filter = scope === 'today' ? { lastSeenDate: date } : {};
      const [rows, total] = await Promise.all([
        Visitor.find(filter).sort({ lastSeenAt: -1 }).limit(LIMIT).lean(),
        Visitor.countDocuments(filter),
      ]);

      const ids = [...new Set(rows.map(v => v.userId && String(v.userId)).filter(Boolean))]
        .filter(id => mongoose.Types.ObjectId.isValid(id));
      const users = ids.length
        ? await User.find({ _id: { $in: ids } })
            .select('name firstName lastName email mobile accountType userId')
            .lean()
        : [];
      const byId = new Map(users.map(u => [String(u._id), u]));
      // Distinct listings each logged-in visitor has opened (same count the Customers grid shows),
      // so the Visitors popup can offer a "N viewed" chip without a request per row.
      const viewedAgg = users.length
        ? await PropertyViewer.aggregate([
            { $match: { userId: { $in: users.map(u => u._id) } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
          ])
        : [];
      const viewedBy = new Map(viewedAgg.map(x => [String(x._id), x.count]));

      const visitors = rows.map(v => {
        const u = v.userId ? byId.get(String(v.userId)) : null;
        const ref = String(v.visitorId || v.fingerprint || '').slice(0, 6).toUpperCase();
        return {
          ref,
          firstSeenAt: v.firstSeenAt,
          // First visit of "today" for the today scope; otherwise the first visit ever.
          visitedAt: scope === 'today' ? (v.dayFirstAt || v.lastSeenAt || v.firstSeenAt) : v.firstSeenAt,
          lastSeenAt: v.lastSeenAt,
          isNew: !!(v.firstSeenAt && v.lastSeenDate === date && dateStrInTz(new Date(v.firstSeenAt)) === date),
          device: parseDeviceInfo(v.userAgent),
          // userId set but account since deleted → removed:true so the UI can say so.
          user: v.userId
            ? (u ? {
                _id: String(u._id),
                userId: u.userId || '',
                name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
                mobile: u.mobile || '',
                email: u.email || '',
                accountType: u.accountType === 'owner' ? 'owner' : 'customer',
                propertiesViewed: viewedBy.get(String(u._id)) || 0,
              } : { removed: true })
            : null,
        };
      });

      res.json({ scope, date, total, truncated: total > rows.length, visitors });
    } catch (err) {
      console.error('GET /api/admin/visitors error:', err.message);
      res.status(500).json({ message: 'Error fetching visitors' });
    }
  });

  // Which module(s) a sub-admin needs, per stat type, to see/act on these
  // generic daily-stats routes. All three ride on the Visits tab's
  // 'stats'/'visits' permissions — 'propertyView' backs the Visits tab's
  // own "Property Views" category, alongside "Visits" and "Users Registered".
  const DAILY_STAT_TYPE_MODULES = {
    visit:        ['stats', 'visits'],
    registration: ['stats', 'visits'],
    propertyView: ['stats', 'visits'],
  };
  function requireDailyStatModule(req, res, next) {
    return requireAnyModule(...(DAILY_STAT_TYPE_MODULES[req.params.type] || []))(req, res, next);
  }
  function requireDailyStatModuleAction(req, res, next) {
    return requireAnyModuleAction(...(DAILY_STAT_TYPE_MODULES[req.params.type] || []))(req, res, next);
  }

  function checkDailyStatType(req, res) {
    if (!DAILY_STAT_TYPES.includes(req.params.type)) {
      res.status(400).json({ message: 'Invalid stat type' });
      return false;
    }
    return true;
  }

  // GET /api/admin/daily-stats/:type — list tracked days, newest first, plus the all-time total.
  // Optional ?month=YYYY-MM restricts `days` to that month (used by the admin
  // "Daily visits — monthly view" table) — `total`, `today`, and `todayDate`
  // always reflect the FULL history regardless of the month filter, so the
  // big-number cards stay correct even while browsing a past month.
  app.get('/api/admin/daily-stats/:type', requireAdmin, requireDailyStatModule, async (req, res) => {
    try {
      if (!checkDailyStatType(req, res)) return;
      const allDays = await DailyStat.find({ type: req.params.type }).sort({ date: -1 }).lean();
      const total = allDays.reduce((sum, d) => sum + (d.count || 0), 0);
      const todayDate = todayStr();
      const todayDoc = allDays.find(d => d.date === todayDate);

      const month = (req.query.month || '').toString();
      const monthOk = /^\d{4}-\d{2}$/.test(month);
      const days = monthOk ? allDays.filter(d => d.date.startsWith(month)) : allDays;
      const monthTotal = monthOk ? days.reduce((sum, d) => sum + (d.count || 0), 0) : null;

      res.json({ days, total, today: todayDoc ? todayDoc.count : 0, todayDate, month: monthOk ? month : null, monthTotal });
    } catch (err) {
      console.error('GET /api/admin/daily-stats error:', err.message);
      res.status(500).json({ message: 'Error fetching daily stats' });
    }
  });

  // PATCH /api/admin/daily-stats/:type/:date/clear — reset one day's count to 0, keep the row.
  app.patch('/api/admin/daily-stats/:type/:date/clear', requireAdmin, requireDailyStatModuleAction, async (req, res) => {
    try {
      if (!checkDailyStatType(req, res)) return;
      const date = req.params.date === 'today' ? todayStr() : req.params.date;
      const doc = await DailyStat.findOneAndUpdate(
        { type: req.params.type, date },
        { $set: { count: 0 } },
        { new: true, upsert: true }
      );
      res.json({ message: 'Count cleared', day: doc });
    } catch (err) {
      console.error('PATCH /api/admin/daily-stats/:type/:date/clear error:', err.message);
      res.status(500).json({ message: 'Error clearing count' });
    }
  });

  // DELETE /api/admin/daily-stats/:type/:date — remove that day's row entirely.
  app.delete('/api/admin/daily-stats/:type/:date', requireAdmin, requireDailyStatModuleAction, async (req, res) => {
    try {
      if (!checkDailyStatType(req, res)) return;
      await DailyStat.deleteOne({ type: req.params.type, date: req.params.date });
      res.json({ message: 'Record deleted' });
    } catch (err) {
      console.error('DELETE /api/admin/daily-stats/:type/:date error:', err.message);
      res.status(500).json({ message: 'Error deleting record' });
    }
  });

  // POST /api/admin/daily-stats/:type/clear-all — reset every day's count for
  // this type. For 'visit' and 'propertyView' this now deletes the DailyStat
  // rows for that type outright (rather than zeroing `count` and keeping the
  // rows) and empties that type's dedup collection(s) too (rows deleted,
  // indexes kept — see emptyCollection above):
  //   - 'visit'          → empties the Visitor collection (same reasoning as
  //                        total-visits/reset above).
  //   - 'propertyView'   → empties the PropertyView and PropertyViewer collections.
  //   - 'registration'   → has no dedup collection, and its rows are kept (at
  //                        count 0) rather than deleted, since this endpoint
  //                        is only meant to wipe visit/view tracking data.
  app.post('/api/admin/daily-stats/:type/clear-all', requireAdmin, requireDailyStatModuleAction, async (req, res) => {
    try {
      if (!checkDailyStatType(req, res)) return;
      const { type } = req.params;
      if (type === 'visit') {
        await DailyStat.deleteMany({ type });
        await emptyCollection(Visitor);
      } else if (type === 'propertyView') {
        await DailyStat.deleteMany({ type });
        await Promise.all([emptyCollection(PropertyView), emptyCollection(PropertyViewer)]);
      } else {
        await DailyStat.updateMany({ type }, { $set: { count: 0 } });
      }
      res.json({ message: 'All counts cleared' });
    } catch (err) {
      console.error('POST /api/admin/daily-stats/:type/clear-all error:', err.message);
      res.status(500).json({ message: 'Error clearing counts' });
    }
  });

  // POST /api/admin/daily-stats/:type/delete-all — remove every tracked day for this type.
  app.post('/api/admin/daily-stats/:type/delete-all', requireAdmin, requireDailyStatModuleAction, async (req, res) => {
    try {
      if (!checkDailyStatType(req, res)) return;
      await DailyStat.deleteMany({ type: req.params.type });
      res.json({ message: 'All records deleted' });
    } catch (err) {
      console.error('POST /api/admin/daily-stats/:type/delete-all error:', err.message);
      res.status(500).json({ message: 'Error deleting records' });
    }
  });

  // Exposed so server.js can raise admin notifications from the registration
  // and property-creation routes (see notes at the top of this file):
  //   const { notifyAdmin } = require('./admin')(app, { ...deps });
  //   ...then call notifyAdmin({ type, title, message, meta }) after a
  //   successful signup / listing creation.
  return { notifyAdmin };
};
