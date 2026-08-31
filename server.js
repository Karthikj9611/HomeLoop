require('dotenv').config();

const express    = require('express');
const compression = require('compression');
const helmet     = require('helmet');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const sharp      = require('sharp');
const { sendEmailWithBrevo, otpEmailTemplate, passwordResetOtpEmailTemplate } = require('./mail');

// ── Env checks ──
if (!process.env.MONGODB_URI)   throw new Error('MONGODB_URI env var is required');
if (!process.env.ALLOWED_ORIGIN) {
  if (process.env.NODE_ENV === 'production') throw new Error('ALLOWED_ORIGIN env var is required in production');
  console.warn('⚠️  ALLOWED_ORIGIN not set — defaulting to * (development only)');
}

if (!process.env.BREVO_API_KEY) {
  console.warn('⚠️  BREVO_API_KEY not set — signup OTP emails will fail to send');
}

const app = express();
app.set('trust proxy', 1); // we're behind Render's proxy; needed for express-rate-limit to key off the real client IP
// contentSecurityPolicy left off for now — index.html/admin.html use inline
// <script> blocks throughout, so a default CSP would break them; enabling it
// properly needs a nonce- or hash-based rework of those pages first.
app.use(compression()); // gzip every response — index.html and JSON API payloads were going out uncompressed
app.use(helmet({ contentSecurityPolicy: false }));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://homeloop.in,https://www.homeloop.in')
  .split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({
  limit: '10mb', // 10mb to allow base64 images
}));
app.use(express.static('public', { maxAge: '7d', etag: true }));

 // 4 hours

// ── User Schema ──
const RemarkEntrySchema = new mongoose.Schema({
  remark: { type: String, required: true, trim: true, maxlength: 200 },
  date:   { type: Date, default: Date.now },
}, { _id: false });

const UserSchema = new mongoose.Schema({
  name:      { type: String, trim: true }, // derived as `${firstName} ${lastName}`.trim(), kept for backward compat with existing UI code
  firstName: { type: String, trim: true },
  lastName:  { type: String, trim: true },
  email:     { type: String, trim: true, lowercase: true, sparse: true, unique: true },
  mobile:    { type: String, trim: true, sparse: true, unique: true },
  password:  { type: String, required: true },
  // URL of the user's avatar, e.g. '/uploads/<ImageAsset id>' — set at signup
  // (or later via PUT /api/user/me) using the same image pipeline as listing
  // photos. Empty string means "no photo", and the UI falls back to initials.
  profilePhoto: { type: String, trim: true, default: '' },
  // Which of the two signup paths the person picked — drives what admin sees
  // and can later drive customer- vs owner-specific UI. Defaults to
  // 'customer' for any pre-existing accounts created before this field existed.
  accountType: { type: String, enum: ['customer', 'owner'], default: 'customer' },
  remarks:   { type: [RemarkEntrySchema], default: [] },
  // Human-readable unique id, same pattern as Property.propertyId (e.g. USER-000001).
  // This is a *display* identifier, distinct from the Mongo _id. Session docs
  // (UserSession) store this alongside the ObjectId reference — see below.
  userId:    { type: String, unique: true, sparse: true, index: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// ────────────────────────────────────────────────────────────────────────────
// ── SIGNUP EMAIL OTP ──
// One doc per email, overwritten on every resend. The OTP itself is bcrypt-hashed
// (same pattern as passwords) so a DB read alone doesn't leak a usable code.
// `verified` flips true once the correct OTP is submitted; /api/user/signup checks
// this flag before creating the account. expiresAt carries a Mongo TTL index so
// stale/unverified docs (and used ones, past their window) clean themselves up —
// no cron job needed.
// ────────────────────────────────────────────────────────────────────────────
const OTP_TTL_MS          = 5  * 60 * 1000; // matches "Valid for 5 minutes" in the email template
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;   // minimum gap between sends for the same email
const OTP_MAX_ATTEMPTS     = 5;             // wrong-code guesses allowed before the code is dead

const EmailOtpSchema = new mongoose.Schema({
  email:      { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
  otpHash:    { type: String, required: true },
  attempts:   { type: Number, default: 0 },
  verified:   { type: Boolean, default: false },
  lastSentAt: { type: Date, default: Date.now },
  expiresAt:  { type: Date, required: true, index: { expires: 0 } }, // TTL: Mongo auto-deletes once this passes
});
const EmailOtp = mongoose.model('EmailOtp', EmailOtpSchema);

// ────────────────────────────────────────────────────────────────────────────
// ── PASSWORD RESET ──
// Same bcrypt-hashed-OTP pattern as signup (EmailOtp), but for an EXISTING
// account. Step 2 also mints a random resetToken (separately hashed) so step 3
// can't be reached by anyone who merely knows the email — the token is proof
// the OTP step actually passed, held only by whoever received the email.
// Kept as its own collection rather than reusing EmailOtp, since that one is
// tied to the "email must NOT already have an account" signup invariant.
// ────────────────────────────────────────────────────────────────────────────
const RESET_OTP_TTL_MS         = 5  * 60 * 1000; // same 5-minute window as signup
const RESET_TOKEN_TTL_MS       = 10 * 60 * 1000; // slightly longer — covers "pick a new password" time
const RESET_RESEND_COOLDOWN_MS = 30 * 1000;
const RESET_MAX_ATTEMPTS       = 5;

const PasswordResetSchema = new mongoose.Schema({
  email:          { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
  otpHash:        { type: String, required: true },
  attempts:       { type: Number, default: 0 },
  verified:       { type: Boolean, default: false },
  resetTokenHash: { type: String, default: null }, // set once verify-otp succeeds
  lastSentAt:     { type: Date, default: Date.now },
  expiresAt:      { type: Date, required: true, index: { expires: 0 } }, // TTL: re-set to a longer window once verified
});
const PasswordReset = mongoose.model('PasswordReset', PasswordResetSchema);

// Rate limiter for password-reset endpoints — same shape as otpLimiter, since
// a real email goes out on every hit here too.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' }
});

// Rate limiter for the OTP endpoints specifically — tighter than the general
// auth limiter since each hit sends a real email (Brevo has its own quota/cost).
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many OTP requests. Please try again later.' }
});

// Rate limiter for user auth
const userAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again later.' }
});

// Rate limiter for profile updates — same cadence as userAuthLimiter but a
// separate bucket, so editing your profile doesn't eat into your login/signup
// attempt quota (or vice versa).
const profileUpdateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many profile updates. Please try again later.' }
});

// ────────────────────────────────────────────────────────────────────────────
// ── USER SESSIONS ──
// Same pattern as admin sessions above, also Mongo-backed: a random token
// handed back on login/signup, sent on later requests as 'x-user-key',
// matched here. Survives restarts and cold starts.
// ────────────────────────────────────────────────────────────────────────────
const USER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const UserSessionSchema = new mongoose.Schema({
  key:            { type: String, required: true, unique: true, index: true },
  userObjectId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true }, // Mongo _id — used internally for querying other collections
  userId:         { type: String, default: null, index: true }, // human-readable User.userId (e.g. USER-000001), stored for readability/lookups in the DB
  expiresAt:      { type: Date, required: true, expires: 0 }, // TTL index: Mongo auto-deletes once expiresAt passes
});
const UserSession = mongoose.model('UserSession', UserSessionSchema);

// Takes the full user document so the session can carry both the Mongo _id
// (used internally to query Property/VisitRequest/etc, all of which reference
// users by ObjectId) and the human-readable userId (for admins browsing the
// usersessions collection directly).
async function issueUserSession(user) {
  const key = crypto.randomBytes(32).toString('hex');
  await UserSession.create({
    key,
    userObjectId: user._id,
    userId:       user.userId || null,
    expiresAt:    new Date(Date.now() + USER_SESSION_TTL_MS),
  });
  return key;
}

async function getUserIdFromSession(key) {
  if (!key) return null;
  const session = await UserSession.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
  return session ? String(session.userObjectId) : null;
}

// Same lookup as getUserIdFromSession, but returns both the Mongo _id and the
// human-readable User.userId (e.g. USER-000001) in one query — the session
// doc already stores both (see issueUserSession above), so no extra User
// lookup is needed. Used wherever a created doc should be stamped with both.
async function getSessionUserIds(key) {
  if (!key) return { userId: null, userReadableId: null };
  const session = await UserSession.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
  if (!session) return { userId: null, userReadableId: null };
  return { userId: String(session.userObjectId), userReadableId: session.userId || null };
}

// Middleware to protect routes that require a logged-in user.
// Attaches req.userId (ObjectId string) and req.userReadableId (e.g. USER-000001) when the session is valid.
async function requireUser(req, res, next) {
  try {
    const key = (req.headers['x-user-key'] || '').toString();
    const { userId, userReadableId } = await getSessionUserIds(key);
    if (!userId) return res.status(401).json({ message: 'Please log in to continue' });
    req.userId = userId;
    req.userReadableId = userReadableId;
    next();
  } catch (err) {
    console.error('requireUser error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
}

// Runs after requireUser. Blocks tenants (accountType 'customer') from
// creating listings — only 'owner' accounts may list a property.
async function requireOwner(req, res, next) {
  try {
    const user = await User.findById(req.userId).select('accountType').lean();
    if (!user || user.accountType !== 'owner') {
      return res.status(403).json({ message: 'Only property owner accounts can list a property.' });
    }
    next();
  } catch (err) {
    console.error('requireOwner error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
}

// Like requireUser, but never blocks the request — just attaches req.userId
// (and req.userReadableId) if a valid session key was sent (null otherwise).
// Used on routes that must still work for guests, e.g. submitting a listing
// while logged out.
async function attachUserIfPresent(req, res, next) {
  try {
    const key = (req.headers['x-user-key'] || '').toString();
    const { userId, userReadableId } = await getSessionUserIds(key);
    req.userId = userId;
    req.userReadableId = userReadableId;
    next();
  } catch (err) {
    console.error('attachUserIfPresent error:', err);
    req.userId = null;
    req.userReadableId = null;
    next();
  }
}

// Strips everything but digits, then drops a leading '91' country code when
// the result is longer than the standard 10-digit Indian mobile number —
// so "9876543210", "+91 98765 43210", and "091-98765-43210" are all treated
// as the same number for uniqueness checks and lookups.
function normalizeMobile(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(digits.length - 10);
  return digits;
}

// ── Signup: Step 1 — send email OTP ──
// Called when the person fills in their email on the signup form, before the
// account is actually created. Generates a 6-digit code, bcrypt-hashes it into
// EmailOtp (upsert — a resend just overwrites the previous code), and emails it
// via Brevo. Doesn't require the account to exist yet (it doesn't, at this point).
app.post('/api/user/signup/send-otp', otpLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !String(email).trim()) return res.status(400).json({ message: 'Email is required' });
    const cleanEmail = String(email).toLowerCase().trim();
    if (!/^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[^\s@"'<>\\]+$/.test(cleanEmail)) return res.status(400).json({ message: 'Please enter a valid email address' });

    const existingUser = await User.findOne({ email: cleanEmail });
    if (existingUser) return res.status(409).json({ message: 'Account already exists for this email. Please log in.' });

    // Cheap resend-spam guard on top of the IP-based otpLimiter above — stops
    // someone from hammering "resend" for one target email from many IPs.
    const existingOtp = await EmailOtp.findOne({ email: cleanEmail }).lean();
    if (existingOtp && (Date.now() - new Date(existingOtp.lastSentAt).getTime()) < OTP_RESEND_COOLDOWN_MS) {
      return res.status(429).json({ message: 'Please wait a few seconds before requesting another code.' });
    }

    const otp = String(crypto.randomInt(100000, 1000000)); // 6-digit, zero can't lead since randomInt floor is 100000
    const otpHash = await bcrypt.hash(otp, 10);

    await EmailOtp.findOneAndUpdate(
      { email: cleanEmail },
      { email: cleanEmail, otpHash, attempts: 0, verified: false, lastSentAt: new Date(), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
      { upsert: true }
    );

    const mailResult = await sendEmailWithBrevo(cleanEmail, 'Your HomeLoop verification code', otpEmailTemplate(otp));
    if (!mailResult.success) {
      console.error('Failed to send signup OTP email:', mailResult.error);
      return res.status(502).json({ message: 'Could not send the verification email. Please try again in a moment.' });
    }

    return res.json({ message: 'Verification code sent to your email' });
  } catch (err) {
    console.error('Send signup OTP error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── Signup: Step 2 — verify the OTP ──
// Marks the EmailOtp doc `verified: true` on a correct code, which /api/user/signup
// below checks before creating the account. Wrong guesses are capped at
// OTP_MAX_ATTEMPTS so the 6-digit space can't just be brute-forced within the
// 5-minute window.
app.post('/api/user/signup/verify-otp', otpLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) return res.status(400).json({ message: 'Email and code are required' });
    const cleanEmail = String(email).toLowerCase().trim();

    const record = await EmailOtp.findOne({ email: cleanEmail });
    if (!record) return res.status(400).json({ message: 'Code expired or not found. Please request a new one.' });
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
    }

    const match = await bcrypt.compare(String(otp).trim(), record.otpHash);
    if (!match) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ message: 'Incorrect code. Please try again.' });
    }

    record.verified = true;
    await record.save();
    return res.json({ message: 'Email verified' });
  } catch (err) {
    console.error('Verify signup OTP error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── User Signup ──
app.post('/api/user/signup', userAuthLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, mobile, password, confirmPassword, accountType, profilePic } = req.body || {};

    if (!firstName || !String(firstName).trim()) return res.status(400).json({ message: 'First name is required' });
    if (!lastName  || !String(lastName).trim())  return res.status(400).json({ message: 'Last name is required' });
    if (!email     || !String(email).trim())     return res.status(400).json({ message: 'Email is required' });
    if (!/^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[^\s@"'<>\\]+$/.test(String(email).trim())) return res.status(400).json({ message: 'Please enter a valid email address' });
    if (!mobile    || !String(mobile).trim())    return res.status(400).json({ message: 'Mobile number is required' });
    if (!/^[\d+\-\s]{7,15}$/.test(String(mobile).trim())) return res.status(400).json({ message: 'Please enter a valid mobile number' });
    if (!password || password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' });

    const cleanAccountType = accountType === 'owner' ? 'owner' : 'customer';

    const cleanEmail  = String(email).toLowerCase().trim();
    const cleanMobile = normalizeMobile(mobile);
    if (!/^\d{10}$/.test(cleanMobile)) return res.status(400).json({ message: 'Please enter a valid 10-digit mobile number' });

    const [existingEmail, existingMobile] = await Promise.all([
      User.findOne({ email: cleanEmail }),
      User.findOne({ mobile: cleanMobile }),
    ]);
    if (existingEmail)  return res.status(409).json({ message: 'Account already exists for this email. Please log in.' });
    if (existingMobile) return res.status(409).json({ message: 'Account already exists for this mobile number. Please log in.' });

    // Email must have gone through the OTP flow above and come back verified —
    // this is what actually stops an account from being created on an email the
    // person doesn't own. The OTP doc still carries its original 5-minute TTL,
    // so this also enforces "finish signup shortly after verifying".
    const otpRecord = await EmailOtp.findOne({ email: cleanEmail, verified: true });
    if (!otpRecord) return res.status(403).json({ message: 'Please verify your email with the code we sent before continuing.' });

    // Only trust a photo URL that actually points at an image we generated via
    // /api/upload-images — never store an arbitrary attacker-supplied URL here.
    const cleanProfilePhoto = (typeof profilePic === 'string' && /^\/uploads\/[a-f0-9]{24}$/.test(profilePic.trim()))
      ? profilePic.trim()
      : '';

    const hashed = await bcrypt.hash(password, 10);
    const userId = await nextSequenceId('USER');
    const name = `${String(firstName).trim()} ${String(lastName).trim()}`.trim();
    const user = await User.create({
      firstName: String(firstName).trim(),
      lastName:  String(lastName).trim(),
      name,
      email:     cleanEmail,
      mobile:    cleanMobile,
      password:  hashed,
      accountType: cleanAccountType,
      profilePhoto: cleanProfilePhoto,
      userId,
    });
    const userKey = await issueUserSession(user);
    await EmailOtp.deleteOne({ email: cleanEmail }); // one-time use — clear it now that the account exists
    bumpDailyStat('registration'); // fire-and-forget; doesn't block the response
    return res.status(201).json({
      message: 'Account created successfully',
      _id: user._id, userId: user.userId,
      firstName: user.firstName, lastName: user.lastName, name: user.name,
      email: user.email, mobile: user.mobile, accountType: user.accountType,
      profilePhoto: user.profilePhoto || '',
      userKey,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── User Login ──
app.post('/api/user/login', userAuthLimiter, async (req, res) => {
  try {
    const { contact, password } = req.body || {};
    if (!contact || !password) return res.status(400).json({ message: 'Please enter your details' });

    // 'contact' is whatever the person typed into the single "Phone or email"
    // field — figure out which one it is and match the corresponding column.
    const identifier = String(contact).toLowerCase().trim();
    const query = identifier.includes('@') ? { email: identifier } : { mobile: normalizeMobile(identifier) };
    const user = await User.findOne(query);
    // Same message either way (wrong identifier vs. wrong password) — a
    // different message per case would let the response be used to check
    // which emails/numbers have accounts on the site.
    const genericError = { message: 'Incorrect email/mobile or password' };
    if (!user) return res.status(401).json(genericError);

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json(genericError);

    const userKey = await issueUserSession(user);
    return res.json({
      message: 'Logged in successfully',
      _id: user._id, userId: user.userId,
      firstName: user.firstName, lastName: user.lastName, name: user.name,
      email: user.email, mobile: user.mobile, accountType: user.accountType,
      profilePhoto: user.profilePhoto || '',
      userKey,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── User Logout ──
app.post('/api/user/logout', async (req, res) => {
  try {
    const key = (req.headers['x-user-key'] || '').toString();
    await UserSession.deleteOne({ key });
    res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('User logout error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── GET current user profile ──
app.get('/api/user/me', requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({
      _id: user._id, userId: user.userId || '',
      firstName: user.firstName || '', lastName: user.lastName || '', name: user.name || '',
      email: user.email || '', mobile: user.mobile || '',
      profilePhoto: user.profilePhoto || '',
      createdAt: user.createdAt,
    });
  } catch (err) {
    console.error('GET /api/user/me error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── UPDATE current user profile (name / email / mobile) ──
app.put('/api/user/me', profileUpdateLimiter, requireUser, async (req, res) => {
  try {
    const { name, email, mobile, profilePhoto } = req.body || {};
    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (email !== undefined) {
      const cleanEmail = String(email).toLowerCase().trim();
      if (!cleanEmail) return res.status(400).json({ message: 'Email cannot be empty' });
      if (!/^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[^\s@"'<>\\]+$/.test(cleanEmail)) return res.status(400).json({ message: 'Please enter a valid email address' });
      const existing = await User.findOne({ email: cleanEmail, _id: { $ne: req.userId } });
      if (existing) return res.status(409).json({ message: 'That email is already in use by another account' });
      update.email = cleanEmail;
    }
    if (mobile !== undefined) {
      const cleanMobile = normalizeMobile(mobile);
      if (!cleanMobile) return res.status(400).json({ message: 'Mobile number cannot be empty' });
      if (!/^\d{10}$/.test(cleanMobile)) return res.status(400).json({ message: 'Please enter a valid 10-digit mobile number' });
      const existing = await User.findOne({ mobile: cleanMobile, _id: { $ne: req.userId } });
      if (existing) return res.status(409).json({ message: 'That mobile number is already in use by another account' });
      update.mobile = cleanMobile;
    }
    if (profilePhoto !== undefined) {
      // Same trust boundary as signup: only accept URLs we generated ourselves
      // via /api/upload-images, or an explicit empty string to remove the photo.
      const cleanPhoto = String(profilePhoto).trim();
      if (cleanPhoto === '' || /^\/uploads\/[a-f0-9]{24}$/.test(cleanPhoto)) {
        update.profilePhoto = cleanPhoto;
      } else {
        return res.status(400).json({ message: 'Invalid profile photo' });
      }
    }
    const user = await User.findByIdAndUpdate(req.userId, update, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'Profile updated', _id: user._id, name: user.name || '', email: user.email || '', mobile: user.mobile || '', profilePhoto: user.profilePhoto || '' });
  } catch (err) {
    console.error('PUT /api/user/me error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── CHANGE password ──
app.put('/api/user/password', requireUser, userAuthLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Current and new password are required' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ message: 'Current password is incorrect' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    // Log out every other active session for this account (e.g. a leaked/
    // stolen session key, or a device you're no longer using) — but not the
    // one making this request, since the frontend keeps using its existing
    // key after a password change rather than rotating to a new one.
    const currentKey = (req.headers['x-user-key'] || '').toString();
    await UserSession.deleteMany({ userObjectId: user._id, key: { $ne: currentKey } });

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('PUT /api/user/password error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── Forgot password: Step 1 — send email OTP ──
app.post('/api/user/password/forgot', passwordResetLimiter, async (req, res) => {
  const startedAt = Date.now();
  // Floor for the "account not found" (fast) and "account found, OTP sent"
  // (slow — bcrypt hash + DB write + Brevo API round-trip) paths to converge
  // on, so a caller can't distinguish which happened purely by response time.
  // This won't fully mask a slow Brevo response (that path can still run
  // past the floor), but it closes the trivial gap where "not found" would
  // otherwise return near-instantly while "found" always does real work.
  const FORGOT_MIN_RESPONSE_MS = 400;
  const padToFloor = async () => {
    const remaining = FORGOT_MIN_RESPONSE_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
  };

  try {
    const { email } = req.body || {};
    if (!email || !String(email).trim()) return res.status(400).json({ message: 'Email is required' });
    const cleanEmail = String(email).toLowerCase().trim();

    // Generic response either way — unlike signup, we do NOT want to reveal
    // whether an account exists for this email. We just skip the send
    // silently if there's no match — but we still do equivalent-cost dummy
    // work and pad to the same floor as the real path below, so the two
    // cases can't be told apart by response time either.
    const genericResponse = { message: 'If an account exists for that email, a reset code has been sent.' };

    const user = await User.findOne({ email: cleanEmail }).select('_id').lean();
    if (!user) {
      await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10); // match the real path's bcrypt cost
      await padToFloor();
      return res.json(genericResponse);
    }

    const existing = await PasswordReset.findOne({ email: cleanEmail }).lean();
    if (existing && (Date.now() - new Date(existing.lastSentAt).getTime()) < RESET_RESEND_COOLDOWN_MS) {
      return res.status(429).json({ message: 'Please wait a few seconds before requesting another code.' });
    }

    const otp = String(crypto.randomInt(100000, 1000000)); // 6-digit, same as signup OTP
    const otpHash = await bcrypt.hash(otp, 10);

    await PasswordReset.findOneAndUpdate(
      { email: cleanEmail },
      {
        email: cleanEmail, otpHash, attempts: 0, verified: false, resetTokenHash: null,
        lastSentAt: new Date(), expiresAt: new Date(Date.now() + RESET_OTP_TTL_MS),
      },
      { upsert: true }
    );

    const mailResult = await sendEmailWithBrevo(cleanEmail, 'Reset your HomeLoop password', passwordResetOtpEmailTemplate(otp));
    if (!mailResult.success) {
      console.error('Failed to send password reset OTP email:', mailResult.error);
      return res.status(502).json({ message: 'Could not send the reset email. Please try again in a moment.' });
    }
    await padToFloor();

    return res.json(genericResponse);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── Forgot password: Step 2 — verify OTP, issue a one-time reset token ──
app.post('/api/user/password/forgot/verify-otp', passwordResetLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) return res.status(400).json({ message: 'Email and code are required' });
    const cleanEmail = String(email).toLowerCase().trim();

    const record = await PasswordReset.findOne({ email: cleanEmail });
    if (!record) return res.status(400).json({ message: 'Code expired or not found. Please request a new one.' });
    if (record.attempts >= RESET_MAX_ATTEMPTS) {
      return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
    }

    const match = await bcrypt.compare(String(otp).trim(), record.otpHash);
    if (!match) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ message: 'Incorrect code. Please try again.' });
    }

    // Mint the token step 3 actually trusts — not the email alone (otherwise
    // step 3 could be raced/hit by anyone who just knows the target email).
    const resetToken = crypto.randomBytes(32).toString('hex');
    record.verified = true;
    record.resetTokenHash = await bcrypt.hash(resetToken, 10);
    record.expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS); // extend TTL to cover the "set new password" step
    await record.save();

    return res.json({ message: 'Code verified', resetToken });
  } catch (err) {
    console.error('Verify reset OTP error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── Forgot password: Step 3 — set the new password ──
app.post('/api/user/password/reset', passwordResetLimiter, async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body || {};
    if (!email || !resetToken || !newPassword) return res.status(400).json({ message: 'Missing required fields' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters' });
    const cleanEmail = String(email).toLowerCase().trim();

    const record = await PasswordReset.findOne({ email: cleanEmail, verified: true });
    if (!record || !record.resetTokenHash) {
      return res.status(400).json({ message: 'Reset session expired. Please start again.' });
    }

    const tokenMatch = await bcrypt.compare(String(resetToken), record.resetTokenHash);
    if (!tokenMatch) return res.status(401).json({ message: 'Invalid or expired reset link. Please start again.' });

    const user = await User.findOne({ email: cleanEmail });
    if (!user) return res.status(404).json({ message: 'Account not found' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    // Same reasoning as the logged-in change-password route: a stolen/leaked
    // session shouldn't survive a reset. No "current session" to preserve
    // here, so every session for this account is killed.
    await UserSession.deleteMany({ userObjectId: user._id });

    // One-time use — remove the record so the token can't be replayed.
    await PasswordReset.deleteOne({ _id: record._id });

    return res.json({ message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────

// ── MongoDB ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── Property Schema (nested, matches the listing-submission payload shape) ──
const BasicSchema = new mongoose.Schema({
  status:    { type: String, enum: ['For Sale','For Rent','New Launch','Sold','Booked','Lease','PG','Short Stay'], default: 'For Rent' },
  listedBy:  { type: String, default: 'Owner' },
}, { _id: false });

const LocationSchema = new mongoose.Schema({
  area:    { type: String, required: true },
  city:    { type: String, default: 'Bangalore' },
  address: { type: String, default: '' },
  // 6-digit Indian PIN code, captured separately from the free-text address
  // (auto-extracted from it on the frontend, editable by the owner) so
  // listings can be matched/filtered by postcode without regex-parsing
  // the address string on every read.
  pincode: { type: String, default: '' },
  lat:     { type: Number, default: null },
  lng:     { type: Number, default: null },
  mapLink: { type: String, default: '' },
}, { _id: false });

const OwnerSchema = new mongoose.Schema({
  propertyName: { type: String, required: true },
  name:         { type: String, default: '' },
  phone:        { type: String, default: '' },
  email:        { type: String, default: '' },
  altPhone:     { type: String, default: '' },
  contactTime:  { type: String, default: '' },
  address:      { type: String, default: '' },
  agentPhone:   { type: String, default: '' },
  agentArea:    { type: String, default: '' },
}, { _id: false });

const PriceSchema = new mongoose.Schema({
  rent:         { type: Number, required: true },
  deposit:      { type: Number }, // Not collected for Lease listings (form hides this field) — no default, so it's omitted entirely instead of appearing as null
  monthlyRent:  { type: Number }, // Legacy field — no form sends this anymore (not even Lease); no default so it no longer appears on newly saved listings
  maintenance:  { type: Number }, // Not collected for PG or Short Stay listings (form hides this field for both) — no default, so it's omitted entirely instead of appearing as null
  rentIncrease: { type: String }, // Not collected for PG, Short Stay, or Lease listings — no default, so it's omitted entirely instead of appearing as null
  electricity:  { type: String }, // Not collected for PG, Short Stay, or Lease listings — no default, so it's omitted entirely instead of appearing as null
  water:        { type: String }, // Not collected for PG, Short Stay, or Lease listings — no default, so it's omitted entirely instead of appearing as null
  negotiable:   { type: String }, // 'Yes' | 'No' | not collected for Lease — no default, so it's omitted entirely instead of appearing as null
}, { _id: false });

const PropertyDetailsSchema = new mongoose.Schema({
  type:      { type: String },   // propertyType (Apartment/Villa/etc.) — not collected for PG/Short Stay; no default, so omitted entirely for them
  bhk:       { type: String },   // not collected for PG/Short Stay; no default, so omitted entirely for them
  bike:      { type: String, default: '0' },    // bikeparking: count as string, e.g. '0'..'4'
  car:       { type: String, default: '0' },    // carparking:  count as string, e.g. '0'..'4'
  floor:     { type: String }, // Not collected for Short Stay (form hides this field) — no default, so it's omitted entirely instead of appearing as a default value
  area:      { type: String },   // not collected for PG/Short Stay; no default, so omitted entirely for them
  bathrooms: { type: String }, // Not collected for Short Stay (form hides this field) — no default, so it's omitted entirely instead of appearing as a default value
  toiletType: { type: String }, // Indian / Western / Both — not collected for PG/Short Stay; no default, so omitted entirely for them
  furnish:   { type: String }, // Not collected for Short Stay (form hides this field) — no default, so it's omitted entirely instead of appearing as a default value
  facing:    { type: String }, // Not collected for Short Stay (form hides this field) — no default, so it's omitted entirely instead of appearing as a default value
  age:       { type: String },   // not collected for PG/Short Stay; no default, so omitted entirely for them
  tenant:    { type: String }, // Not collected for Short Stay (form hides this field) — no default, so it's omitted entirely instead of appearing as a default value
  available: { type: String }, // Not collected for Short Stay (form hides this field) — no default, so it's omitted entirely instead of appearing as null
}, { _id: false });

const AmenitiesSchema = new mongoose.Schema({
  selected: { type: [String], default: [] },
  extra:    { type: String, default: '' },
}, { _id: false });

const TermsSchema = new mongoose.Schema({
  notice:    { type: String, default: null }, // noticePeriod / leaseNotice / pgNotice
  lease:     { type: String }, // leaseDuration (Rent) / leaseDurationVal (Lease) — not collected for PG/Short Stay; no default, so omitted entirely for them
  leaseType: { type: String }, // Lease only: Residential / Commercial / Industrial / Mixed Use — no default, so Rent (and other non-Lease) listings omit this field entirely
  lockIn:    { type: String }, // Lease only: lock-in period — no default, so Rent (and other non-Lease) listings omit this field entirely
}, { _id: false });

const RulesSchema = new mongoose.Schema({
  pets:   { type: String }, // petsAllowed / leasePets — PG's "Pets allowed" field was removed from the form; no default, so it's omitted entirely for PG listings
  nonVeg: { type: String, default: null }, // nonVegAllowed / leaseNonVeg
  gas:    { type: String }, // No longer sent by the Rent form (or any form) — no default, so it's omitted entirely from newly saved listings
}, { _id: false });

const MediaSchema = new mongoose.Schema({
  video:  { type: String, default: '' },
  desc:   { type: String, default: '' },
  images: { type: [String], default: [] },
}, { _id: false });

const PgSchema = new mongoose.Schema({
  type:          { type: String, default: null }, // pgPropertyType (Apartment/Independent House/Villa/Studio) — lives here only, property.type is omitted for PG
  gender:        { type: String, default: null },
  room:          { type: String, default: null }, // pgRoomType
  meals:         { type: String, default: null }, // pgMeals
  occupancy:     { type: String, default: null },
  notice:        { type: String, default: null }, // pgNotice — lives here only, not mirrored into terms.notice
  bathroom:      { type: String, default: null },
  toiletType:    { type: String, default: null }, // pgToiletType — Indian / Western / Both
  furnish:       { type: String, default: null }, // pgRoomFurnishing
  food:          { type: String, default: null }, // pgFoodType
  available:     { type: String, default: null }, // pgAvailableFrom — lives here only, not mirrored into property.available
  visitors:      { type: String, default: null }, // pgVisitorPolicy
  gateTime:      { type: String, default: null },
  bike:          { type: String, default: '0' }, // pgBikePark — lives here only, not mirrored into property.bike
  car:           { type: String, default: '0' }, // pgCarPark — lives here only, not mirrored into property.car
  // kitchen, nonVeg — removed along with the "Kitchen access" and "Non-veg
  // allowed" inputs on the PG form. mealCost, beds, pets were removed earlier
  // for the same reason. Any stray values on old documents get dropped the
  // next time that listing is edited (see the full-replace logic in
  // PUT /api/user/listings/:id below).
}, { _id: false });

const ShortStaySchema = new mongoose.Schema({
  type:            { type: String, default: null }, // ssPropertyType (Apartment/Independent House/Villa/Studio) — lives here only, same reasoning as shortStay.furnish
  roomType:        { type: String, default: null }, // ssRoomType (Single/Double/Deluxe/Suite)
  available24hrs:  { type: String, default: null }, // ss24hrs (Yes/No)
  cancellation:    { type: String, default: null }, // ssCancellation
  couplesAllowed:  { type: String, default: null }, // ssCouples (Yes/No)
  furnish:         { type: String, default: null }, // ssFurnish — lives here only, same reasoning as pg.furnish; property.furnish is omitted for Short Stay
}, { _id: false });

// ── Counter (atomic per-type sequence for human-readable property IDs) ──
// Using a dedicated collection with $inc (rather than e.g. Property.countDocuments()+1)
// so two simultaneous submissions can never be handed the same number.
const CounterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. 'RENT' | 'LEASE' | 'PG'
  seq: { type: Number, default: 0 },
}, { _id: false });
const Counter = mongoose.model('Counter', CounterSchema);

// Generic version of the same atomic-counter trick, reused below for
// visitId (VisitRequest) and userId (User) — same Counter collection,
// keyed by whatever prefix is passed in, so each entity type counts
// independently of the others.
async function nextSequenceId(prefix) {
  const counter = await Counter.findOneAndUpdate(
    { _id: prefix },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}-${String(counter.seq).padStart(6, '0')}`; // e.g. RENT-000123
}

async function nextPropertyId() {
  // 3 random letters + a globally incrementing number (e.g. QWR001). The
  // letters are re-randomized on every call; the number comes from a single
  // shared Counter (key 'PROPERTY') via atomic $inc, so it keeps
  // incrementing across all property types regardless of the letters,
  // and never needs a collision-retry loop.
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const randomLetters = () => {
    let code = '';
    for (let i = 0; i < 3; i++) code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    return code;
  };
  const counter = await Counter.findOneAndUpdate(
    { _id: 'PROPERTY' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${randomLetters()}${String(counter.seq).padStart(3, '0')}`; // e.g. QWR001
}

// ────────────────────────────────────────────────────────────────────────────
// ── LISTING MODELS: split across four collections by category ──
// A listing is stored in exactly one of four collections based on its
// basic.status: 'Lease' → the `lease` collection, 'PG' → the `pg` collection,
// 'Short Stay' → the `hourlyStay` collection, and everything else (For Rent /
// For Sale / New Launch / Sold / Booked) → the `rent` collection. All four
// share the identical schema shape below — only the collection (and therefore
// the Mongoose model) differs — so a listing's category can be switched later
// by moving the document between models (see moveListingIfNeeded below)
// rather than needing a migration.
// ────────────────────────────────────────────────────────────────────────────
function buildListingSchema() {
  const schema = new mongoose.Schema({
    basic:      { type: BasicSchema,            required: true },
    location:   { type: LocationSchema,         required: true },
    owner:      { type: OwnerSchema,            required: true },
    price:      { type: PriceSchema,            required: true },
    property:   { type: PropertyDetailsSchema }, // no default — left unset for PG listings (see property: below), same reasoning as pg/shortStay
    amenities:  { type: AmenitiesSchema,        default: () => ({}) },
    terms:      { type: TermsSchema }, // no default — left unset for PG listings, all PG term data (notice) lives in pg.notice instead
    rules:      { type: RulesSchema }, // no default — left unset for PG listings, which don't collect pets/non-veg rules
    media:      { type: MediaSchema,            default: () => ({}) },
    pg:         { type: PgSchema }, // no default — left unset for non-PG listings so we don't store an all-null subdocument
    shortStay:  { type: ShortStaySchema }, // no default — left unset for non-Short-Stay listings, same reasoning as pg above
    // ── Meta (kept top-level / flat — not part of the submitted payload) ──
    propertyId:       { type: String, unique: true, sparse: true, index: true }, // random alphanumeric code, e.g. AAA123
    userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }, // owner of this listing, null = posted while logged out
    userReadableId:   { type: String, default: null, index: true }, // human-readable User.userId (e.g. USER-000001), stamped at creation for admin readability — same pattern as UserSession.userId
    verified:         { type: Boolean, default: false },
    promoted:         { type: Boolean, default: false },
    promotedPriority: { type: Number,  default: 0 }, // 0 = not manually ranked yet; sorts to the back of the promoted queue (see rankOf below) until an admin assigns 1, 2, 3...
    booked:           { type: Boolean, default: false }, // once true, listing is hidden from the public site regardless of verified status
    // Captured from the admin Booked-tab "Booking Details" modal — who the
    // deal was between and when. ownerId / tenantId reference registered
    // Users (picked from the two dropdowns in that modal); the *Name/Phone/
    // Email fields are a snapshot at save-time so the record still reads
    // fine even if that User doc later changes or is deleted.
    bookingDetails: {
      ownerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      ownerName:   { type: String, default: '' },
      ownerPhone:  { type: String, default: '' },
      ownerEmail:  { type: String, default: '' },
      tenantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      tenantName:  { type: String, default: '' },
      tenantPhone: { type: String, default: '' },
      tenantEmail: { type: String, default: '' },
      bookedOn:    { type: String, default: '' }, // 'YYYY-MM-DD'
      description: { type: String, default: '', trim: true, maxlength: 1000 }, // free-text notes captured with the booking (terms agreed, move-in details, etc.)
    },
    views:            { type: Number,  default: 0 },
    visitCount:       { type: Number,  default: 0 }, // # of "Schedule a Visit" requests made for this listing
    bookingCount:     { type: Number,  default: 0 }, // # of direct "Book Now" requests made for this listing (Short Stay only)
    remarks:          { type: [String], default: [] }, // admin-panel notes
    createdAt:        { type: Date,    default: Date.now },
  });
  schema.index({ createdAt: -1 });
  schema.index({ 'basic.status': 1, createdAt: -1 });
  // Every public GET /api/properties call filters on exactly these two
  // fields (verified:true, booked:{$ne:true}) — without this, that query
  // was a full collection scan on every listing-page load.
  schema.index({ verified: 1, booked: 1, createdAt: -1 });
  return schema;
}

// Explicit 3rd arg pins the exact collection name — 'rent' / 'lease' / 'pg' /
// 'hourlyStay' — instead of Mongoose's default pluralization.
const Rent       = mongoose.model('Rent',       buildListingSchema(), 'rent');
const Lease      = mongoose.model('Lease',      buildListingSchema(), 'lease');
const Pg         = mongoose.model('Pg',         buildListingSchema(), 'pg');
const HourlyStay = mongoose.model('HourlyStay', buildListingSchema(), 'hourlyStay');

// Keyed by the same names used for VisitRequest.propertyType (refPath target).
const LISTING_MODELS = { Rent, Lease, Pg, HourlyStay };
const LISTING_MODEL_LIST = Object.values(LISTING_MODELS);

// A listing's basic.status decides which collection it belongs in.
function modelForStatus(status) {
  if (status === 'Lease')      return Lease;
  if (status === 'PG')         return Pg;
  if (status === 'Short Stay') return HourlyStay;
  return Rent; // For Rent, For Sale, New Launch, Sold, Booked
}
// Finds a listing by Mongo _id without knowing in advance which of the four
// collections it lives in — tries all four in parallel (a given ObjectId can
// only ever exist in one, since each collection mints its own _ids).
async function findListingById(id, { lean = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(id)) return { doc: null, model: null, type: null };
  const types = Object.keys(LISTING_MODELS);
  const results = await Promise.all(types.map(t => {
    const q = LISTING_MODELS[t].findById(id);
    return lean ? q.lean() : q;
  }));
  for (let i = 0; i < types.length; i++) {
    if (results[i]) return { doc: results[i], model: LISTING_MODELS[types[i]], type: types[i] };
  }
  return { doc: null, model: null, type: null };
}

// Same idea, scoped to a specific owner — used by the user-owned-listing routes.
async function findUserListingById(id, userId, { lean = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(id)) return { doc: null, model: null, type: null };
  const types = Object.keys(LISTING_MODELS);
  const results = await Promise.all(types.map(t => {
    const q = LISTING_MODELS[t].findOne({ _id: id, userId });
    return lean ? q.lean() : q;
  }));
  for (let i = 0; i < types.length; i++) {
    if (results[i]) return { doc: results[i], model: LISTING_MODELS[types[i]], type: types[i] };
  }
  return { doc: null, model: null, type: null };
}

// Tries findByIdAndUpdate against each collection in turn, stopping at the
// first hit — used by the admin verified/promoted toggles, which only have
// an _id to go on.
async function updateListingById(id, update, options = { new: true }) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  for (const M of LISTING_MODEL_LIST) {
    const result = await M.findByIdAndUpdate(id, update, options);
    if (result) return result;
  }
  return null;
}

async function deleteListingById(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  for (const M of LISTING_MODEL_LIST) {
    const deleted = await M.findByIdAndDelete(id);
    if (deleted) return deleted;
  }
  return null;
}

// If an edit changes basic.status into a different category (e.g. Rent →
// Lease), the document needs to move to the matching collection rather than
// just being saved in place. Re-creates it in the target collection with the
// same _id and deletes the original; returns the (possibly new) document.
async function moveListingIfNeeded(doc, currentModel) {
  const targetModel = modelForStatus(doc.basic && doc.basic.status);
  if (targetModel === currentModel) {
    await doc.save();
    return doc;
  }
  const plain = doc.toObject();
  const moved = new targetModel(plain); // same _id, since plain._id is preserved
  await moved.save();
  await currentModel.findByIdAndDelete(doc._id);
  return moved;
}

// ── Visit Request Schema (from the "Schedule a Visit" modal) ──
const VisitRequestSchema = new mongoose.Schema({
  // Human-readable unique id, same pattern as Property.propertyId (e.g. VISIT-000001).
  visitId:      { type: String, unique: true, sparse: true, index: true },
  propertyId:   { type: mongoose.Schema.Types.ObjectId, refPath: 'propertyType', required: true, index: true },
  // Which of the three listing collections propertyId points into — stamped
  // at creation (see POST /api/visits) so populate() can resolve it dynamically.
  propertyType: { type: String, enum: ['Rent', 'Lease', 'Pg', 'HourlyStay'], default: 'Rent' },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  userReadableId: { type: String, default: null, index: true }, // human-readable User.userId (e.g. USER-000001), stamped at creation for admin readability — same pattern as UserSession.userId
  visitorName:  { type: String, required: true, trim: true },
  visitorPhone: { type: String, required: true, trim: true },
  email:        { type: String, default: '', trim: true, lowercase: true }, // preloaded from the logged-in user's account email
  note:         { type: String, default: '', trim: true },
  visitDate:    { type: String, required: true }, // 'YYYY-MM-DD'
  visitTime:    { type: String, required: true }, // 'HH:MM'
  status:       { type: String, enum: ['Pending', 'Confirmed', 'Cancelled', 'Completed'], default: 'Pending' },
  remarks:      { type: [RemarkEntrySchema], default: [] },
  createdAt:    { type: Date, default: Date.now },
});
VisitRequestSchema.index({ createdAt: -1 });
// Speeds up the duplicate-visit lookup in POST /api/visits (same user + property + date).
VisitRequestSchema.index({ userId: 1, propertyId: 1, visitDate: 1 });
const VisitRequest = mongoose.model('VisitRequest', VisitRequestSchema);

// ── Booking Request Schema (from the "Book Now" modal — Short Stay direct booking) ──
const BookingRequestSchema = new mongoose.Schema({
  // Human-readable unique id, same pattern as VisitRequest.visitId (e.g. BOOKING-000001).
  bookingId:    { type: String, unique: true, sparse: true, index: true },
  propertyId:   { type: mongoose.Schema.Types.ObjectId, refPath: 'propertyType', required: true, index: true },
  // Which listing collection propertyId points into — stamped at creation
  // (see POST /api/bookings) so populate() can resolve it dynamically.
  // In practice this is always 'HourlyStay' today, since Book Now only appears
  // on Short Stay cards, but kept as an enum (matching VisitRequest's pattern)
  // in case direct booking is ever offered on another listing type.
  propertyType: { type: String, enum: ['Rent', 'Lease', 'Pg', 'HourlyStay'], default: 'HourlyStay' },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  userReadableId: { type: String, default: null, index: true }, // human-readable User.userId (e.g. USER-000001), stamped at creation for admin readability
  guestName:    { type: String, required: true, trim: true },
  guestPhone:   { type: String, required: true, trim: true },
  email:        { type: String, default: '', trim: true, lowercase: true }, // preloaded from the logged-in user's account email
  note:         { type: String, default: '', trim: true },
  checkinDate:  { type: String, required: true }, // 'YYYY-MM-DD'
  days:         { type: Number, required: true, min: 1 },
  guests:       { type: Number, default: 1, min: 1 },
  status:       { type: String, enum: ['Pending', 'Confirmed', 'Cancelled', 'Completed'], default: 'Pending' },
  remarks:      { type: [RemarkEntrySchema], default: [] },
  createdAt:    { type: Date, default: Date.now },
});
BookingRequestSchema.index({ createdAt: -1 });
// Speeds up the duplicate-booking lookup in POST /api/bookings (same user + property + check-in date).
BookingRequestSchema.index({ userId: 1, propertyId: 1, checkinDate: 1 });
const BookingRequest = mongoose.model('BookingRequest', BookingRequestSchema);

// ── Notification Schema (in-app notifications for logged-in users) ──
// Fired whenever an admin action changes something a user is waiting on:
// a listing gets verified, a submitted Honest Review video gets approved,
// or a Schedule-a-Visit request changes status. Read via GET
// /api/user/notifications and the unread badge polls /unread-count.
const NotificationSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:      { type: String, enum: ['property_verified', 'review_approved', 'visit_status'], required: true },
  title:     { type: String, required: true },
  message:   { type: String, required: true },
  read:      { type: Boolean, default: false, index: true },
  meta:      { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { propertyId, visitId, status }
  createdAt: { type: Date, default: Date.now },
});
NotificationSchema.index({ userId: 1, createdAt: -1 });
const Notification = mongoose.model('Notification', NotificationSchema);

// Best-effort notification creation — never lets a notification failure
// break the admin action that triggered it. No-op if userId is null (e.g.
// a listing posted while logged out has no owner to notify).
async function notifyUser(userId, { type, title, message, meta }) {
  if (!userId) return;
  try {
    await Notification.create({ userId, type, title, message, meta: meta || {} });
  } catch (err) {
    console.error('notifyUser error:', err.message);
  }
}

// Extra fields folded into a visit_status notification's meta so the
// frontend can offer an "Add to calendar" action straight off the
// notification, without a follow-up API call. Best-effort — a listing that
// was since deleted just means an emptier calendar event, not a broken
// status-change notification.
async function visitCalendarMeta(visit) {
  try {
    const { doc: property } = await findListingById(visit.propertyId, { lean: true });
    return {
      visitDate:    visit.visitDate,
      visitTime:    visit.visitTime,
      propertyName: (property && property.owner    && property.owner.propertyName) || '',
      propertyArea: (property && property.location && property.location.area)      || '',
      propertyCode: (property && property.propertyId) || '',
    };
  } catch (err) {
    return { visitDate: visit.visitDate, visitTime: visit.visitTime, propertyName: '', propertyArea: '', propertyCode: '' };
  }
}

// ── Helpers ──
function formatPrice(price, status) {
  const num = Number(price);
  let display = '';
  if      (num >= 10000000) display = (num / 10000000).toFixed(2).replace(/\.?0+$/, '') + 'Cr';
  else if (num >= 100000)   display = (num / 100000).toFixed(1).replace(/\.?0+$/, '') + 'L';
  else if (num >= 1000)     display = (num / 1000).toFixed(1).replace(/\.?0+$/, '') + 'K';
  else                      display = String(num);
  if (status === 'Short Stay') display += '/Day';
  else if (['For Rent', 'Lease', 'PG'].includes(status)) display += '/Month';
  return display;
}

// Formats a Date as 'dd-mm-yyyy hh:mm AM/PM' in IST, e.g. '30-06-2026 02:30 PM'.
function formatPostedDateTime(date) {
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  const dayPart   = get('day');
  const monthPart = get('month');
  const yearPart  = get('year');
  const hourPart  = get('hour');
  const minPart   = get('minute');
  const ampm      = get('dayPeriod').toUpperCase();
  return `${dayPart}-${monthPart}-${yearPart} ${hourPart}:${minPart} ${ampm}`;
}

// Top-level keys accepted from the client, matching the nested submission shape exactly.
const NESTED_SECTIONS = ['basic','location','owner','price','property','amenities','terms','rules','media','pg','shortStay'];

const URL_FIELDS_BY_SECTION = { location: ['mapLink'], media: ['video'] };
const MAX_LENGTHS = {
  'owner.propertyName': 200,
  'media.desc':         5000,
  'location.area':      200,
  'location.address':   500,
  'location.pincode':   6,
  'owner.name':         100,
  'owner.address':      300,
  'owner.contactTime':  100,
};

function validatePropertyFields(fields) {
  for (const [section, urlKeys] of Object.entries(URL_FIELDS_BY_SECTION)) {
    const obj = fields[section] || {};
    for (const k of urlKeys) {
      const val = obj[k];
      if (val && String(val).trim()) {
        let parsed;
        try { parsed = new URL(String(val).trim()); } catch { return `Invalid URL in field '${section}.${k}'.`; }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return `Field '${section}.${k}' must be an http(s) URL.`;
        }
      }
    }
  }
  for (const [path, max] of Object.entries(MAX_LENGTHS)) {
    const [section, key] = path.split('.');
    const val = (fields[section] || {})[key];
    if (val && String(val).length > max)
      return `Field '${path}' must be at most ${max} characters.`;
  }
  const pincode = (fields.location || {}).pincode;
  if (pincode && String(pincode).trim() && !/^\d{6}$/.test(String(pincode).trim()))
    return `Field 'location.pincode' must be a 6-digit PIN code.`;

  const email = (fields.owner || {}).email;
  if (email && String(email).trim() &&
      !/^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[^\s@"'<>\\]+$/.test(String(email).trim()))
    return `Invalid email address in field 'owner.email'.`;

  const images = (fields.media || {}).images;
  if (images !== undefined) {
    if (!Array.isArray(images)) return `Field 'media.images' must be an array.`;
    if (images.length > 20) return `Field 'media.images' must have at most 20 images.`;
    for (const img of images) {
      if (typeof img !== 'string' || !img.trim()) return `Field 'media.images' contains an invalid entry.`;
      const val = img.trim();
      if (val.startsWith('/uploads/')) continue; // our own upload endpoint returns relative paths — allow as-is
      let parsed;
      try { parsed = new URL(val); } catch { return `Field 'media.images' contains an invalid URL.`; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `Field 'media.images' must contain only http(s) URLs.`;
      }
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// ── REQUIRED-FIELD ENFORCEMENT ──
// The listing form now marks nearly every field mandatory client-side, but a
// client-side check can always be bypassed (a direct API call, a modified
// request, etc.) — so the same requiredness is enforced again here before
// anything is written to Mongo. Fields intentionally left null for a given
// listing type (e.g. property.bhk for a PG, price.deposit for a Lease — the
// form hides those inputs entirely for that type) are NOT required for that
// type; only fields the form actually shows are enforced, matching the
// per-status field visibility in onFTypeChange() on the frontend.
// ────────────────────────────────────────────────────────────────────────────
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function isEmptyValue(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

// Required for every listing type — propertyName/area/price.rent are already
// checked (with a type-specific label) right before this runs, so they're
// deliberately left out here to avoid a duplicate message.
const BASE_REQUIRED_FIELDS = [
  ['location.city',     'Location: City'],
  ['location.address',  'Location: Building live address'],
  ['location.pincode',  'Location: Pincode'],
  ['location.mapLink',  'Location: Google Maps link'],
  ['owner.name',        'Owner name'],
  ['owner.phone',       'Owner phone number'],
  ['owner.email',       'Owner email'],
  ['owner.contactTime', 'Preferred contact time'],
  ['owner.address',     'Owner address'],
  ['media.desc',        'Description'],
];

// Extra fields required only for the listing types whose form section
// actually shows them.
const TYPE_REQUIRED_FIELDS = {
  'For Rent': [
    ['price.deposit',      'Security deposit'],
    ['price.negotiable',   'Price negotiable'],
    ['property.type',      'Property type'],
    ['property.bhk',       'BHK'],
    ['property.floor',     'Floor'],
    ['property.area',      'Area (sqft)'],
    ['property.age',       'Age of property'],
    ['property.available', 'Available from'],
    ['terms.lease',        'Lease duration'],
    ['rules.pets',         'Pets allowed'],
    ['rules.nonVeg',       'Non-veg allowed'],
  ],
  'Lease': [
    ['property.type',      'Property type'],
    ['property.bhk',       'BHK'],
    ['property.floor',     'Floor'],
    ['property.area',      'Area (sqft)'],
    ['property.available', 'Available from'],
    ['terms.leaseType',    'Lease type'],
    ['rules.pets',         'Pets allowed'],
    ['rules.nonVeg',       'Non-veg allowed'],
  ],
  'PG': [
    ['price.deposit', 'Security deposit'],
    ['pg.type',      'Property type'],
    ['pg.meals',     'Meals'],
    ['pg.occupancy', 'Occupancy available'],
    ['pg.bathroom',  'Attached bathroom'],
    ['pg.furnish',   'Room furnishing'],
    ['pg.available', 'Available from'],
    ['pg.visitors',  'Visitor policy'],
    ['pg.food',      'Food type'],
  ],
  'Short Stay': [
    ['shortStay.type',           'Property type'],
    ['shortStay.available24hrs', 'Available 24 hours'],
    ['shortStay.cancellation',   'Free cancellation window'],
    ['shortStay.couplesAllowed', 'Unmarried couples allowed'],
    ['shortStay.furnish',        'Furnishing'],
  ],
};

// Returns a list of human-readable labels for every required field that's
// missing/empty for this listing's status — empty array means nothing's missing.
function findMissingRequiredFields(fields, status) {
  const required = BASE_REQUIRED_FIELDS.concat(TYPE_REQUIRED_FIELDS[status] || []);
  if ((fields.basic || {}).listedBy === 'Agent') {
    required.push(['owner.agentPhone', 'Agent phone number'], ['owner.agentArea', 'Agent service area']);
  }
  const missing = required.filter(([path]) => isEmptyValue(getPath(fields, path)));
  const labels = missing.map(([, label]) => label);
  const images = (fields.media || {}).images;
  if (!Array.isArray(images) || images.length === 0) labels.push('Property images');
  return labels;
}

// ── Rate limiter ──
const listingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many listing submissions. Please try again later.' }
});

// Separate bucket for editing/deleting existing listings, so those don't
// compete with an owner's new-listing creation quota above.
const listingWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many listing changes. Please try again later.' }
});

// ── POST /api/properties ──
app.post('/api/properties', listingLimiter, requireUser, requireOwner, async (req, res) => {
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

    // Fields required by every listing type, with a type-appropriate label in the error message
    // (price.rent doubles as "monthly rent" for Rent, "lease amount" for Lease, "monthly charge" for PG,
    // "per day rate" for Short Stay).
    const priceLabel = status === 'Lease'      ? 'price.rent (lease amount)'
                      : status === 'PG'         ? 'price.rent (monthly charge)'
                      : status === 'Short Stay' ? 'price.rent (per day rate)'
                      :                           'price.rent (monthly rent)';
    if (!fields.owner.propertyName || !fields.location.area ||
        fields.price.rent === undefined || fields.price.rent === null || fields.price.rent === '') {
      return res.status(400).json({ message: `owner.propertyName, location.area, and ${priceLabel} are required.` });
    }

    // Fields required only for specific listing types.
    if (status === 'PG' && (!fields.pg.gender || !fields.pg.room)) {
      return res.status(400).json({ message: 'pg.gender and pg.room are required for PG listings.' });
    }
    if (status === 'Lease' && !fields.terms.lease) {
      return res.status(400).json({ message: 'terms.lease (lease duration) is required for Lease listings.' });
    }
    if (status === 'Short Stay' && !fields.shortStay.roomType) {
      return res.status(400).json({ message: 'shortStay.roomType is required for Short Stay listings.' });
    }

    // Every other field the form shows for this listing type must be filled
    // in too — reject the whole request rather than silently storing nulls.
    const missingFields = findMissingRequiredFields(fields, status);
    if (missingFields.length) {
      return res.status(400).json({ message: `Please fill in all required fields: ${missingFields.join(', ')}.` });
    }

    const displayPrice = formatPrice(fields.price.rent, status);
    const propertyId = await nextPropertyId();

    const ListingModel = modelForStatus(status); // Rent, Lease, Pg, or HourlyStay — decided by basic.status
    const prop = new ListingModel({
      propertyId,
      userId:         req.userId || null, // links the listing to its creator when logged in
      userReadableId: req.userReadableId || null, // e.g. USER-000001, for admin readability
      basic:     fields.basic,
      location:  fields.location,
      owner:     fields.owner,
      price:     fields.price,
      // property/terms/rules are Rent/Lease concepts — PG data lives entirely
      // in `pg` below, and Short Stay doesn't collect terms.notice or
      // rules.nonVeg (no such fields on the Short Stay form), so terms/rules
      // stay unset for both PG and Short Stay listings instead of storing
      // duplicate/blank values (e.g. property.bike mirroring pg.bike,
      // terms.notice mirroring pg.notice, or an all-null rules object).
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
    console.error('POST /api/properties error:', err);
    res.status(500).json({ message: 'Error saving property' });
  }
});

// ── GET /api/properties ──
app.get('/api/properties', async (req, res) => {
  try {
    // Default limit bumped from 100 → 2000: the frontend calls this endpoint
    // with no query params at all (a single `fetch('/api/properties')` on
    // page load) and uses the result as its *entire* in-memory dataset for
    // rendering, searching, sorting, and building filter-dropdown options
    // (pincodes, localities, etc). With more than 100 verified listings, the
    // old default silently cut off everything past the 100th (by promoted →
    // promotedPriority → newest order) — those listings' pincodes could
    // never appear in the Pincode filter no matter what. 2000 comfortably
    // covers real-world scale for this site while still bounding worst-case
    // query size; raise further (or add real pagination + a dedicated
    // lightweight distinct-pincodes endpoint) if the catalog outgrows this.
    const { status, q, limit = 2000, skip = 0, booked } = req.query;
    // Default: only available listings (verified, not booked) — same as before.
    // ?booked=true flips this to fetch the booked ones instead, so the frontend
    // can show a separate "Booked" section per type without ever mixing the two.
    const filter = booked === 'true'
      ? { verified: true, booked: true }
      : { verified: true, booked: { $ne: true } }; // a listing only appears to the public once admin has verified it, and disappears again once marked booked
    if (status && typeof status === 'string') filter['basic.status'] = status;
    if (q && typeof q === 'string') {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ 'owner.propertyName': re }, { 'location.area': re }, { 'media.desc': re }];
    }

    // Internal/admin-only fields — never read by the public frontend
    const PUBLIC_SELECT =
      '-remarks -userId -userReadableId -__v -bookingDetails ' +
      // Owner PII that only ever populated hidden form inputs in the read-only
      // detail view (VIEW_ALWAYS_HIDDEN_GROUPS on the frontend). owner.phone is
      // excluded too — Call/WhatsApp now read owner.agentPhone only (dynamically),
      // so the owner's personal number never needs to leave the server.
      // owner.propertyName excluded too (client-side search no longer matches on
      // it — search now matches area/BHK only). owner.agentPhone is kept for
      // Call/WhatsApp.
      '-owner.name -owner.propertyName -owner.email -owner.phone -owner.altPhone -owner.contactTime -owner.address -owner.agentArea ' +
      // Location detail that's likewise only used to fill the always-hidden
      // full-address/lat-lng/Google-Maps-link form groups.
      // NOTE: location.address is intentionally *not* excluded at the query
      // level anymore — see the pincode-backfill step below, which needs it
      // to derive a pincode for listings that never got location.pincode set
      // directly. It's deleted from each doc right after that, so the full
      // address still never reaches the public response.
      '-location.lat -location.lng -location.mapLink';

    // If a status was requested, we already know exactly which single
    // collection to query. Otherwise we need to fan out to all four and
    // merge, since listings now live in separate rent/lease/pg/hourlyStay collections.
    const modelsToQuery = (status && typeof status === 'string')
      ? [modelForStatus(status)]
      : LISTING_MODEL_LIST;

    const docArrays = await Promise.all(
      modelsToQuery.map(M => M.find(filter).select(PUBLIC_SELECT).lean())
    );
    let docs = docArrays.flat();

    // Backfill location.pincode from the free-text address for listings that
    // never got an explicit pincode saved (older/imported listings). Mirrors
    // the same "last 6-digit run in the address" pattern the frontend used
    // to rely on client-side via getPropertyPincode() — except that fallback
    // never actually worked in production, because location.address was
    // excluded from this response entirely, so the frontend had nothing to
    // parse. Doing it here, before address is stripped below, means every
    // listing with a parseable pincode in its address now surfaces it: the
    // Pincode filter dropdown, "near me" priority-boost, and pincode search
    // all fed off this field and were silently missing these listings.
    docs.forEach(doc => {
      if (!doc.location) return;
      if (!doc.location.pincode) {
        const matches = String(doc.location.address || '').match(/\b\d{6}\b/g);
        if (matches) doc.location.pincode = matches[matches.length - 1];
      }
      // Full free-text address itself is still never sent to the public
      // frontend — only the derived pincode above survives past this point.
      delete doc.location.address;
    });

    // Sort/paginate in memory across the merged set (same ordering as before:
    // promoted first, then promotedPriority, then newest).
    // 0 (the schema default) and any missing/null value both mean "an admin
    // hasn't manually ranked this one yet" — treat those as the lowest
    // possible priority (Infinity) so a freshly-promoted listing lands at
    // the back of the promoted queue, behind every listing an admin has
    // explicitly set to 1, 2, 3..., rather than jumping to the front.
    const rankOf = (p) => (p && p > 0) ? p : Infinity;
    docs.sort((a, b) =>
      (Number(b.promoted) - Number(a.promoted)) ||
      (rankOf(a.promotedPriority) - rankOf(b.promotedPriority)) ||
      (new Date(b.createdAt) - new Date(a.createdAt))
    );
    docs = docs.slice(Number(skip), Number(skip) + Number(limit));

    // promotedPriority is now intentionally left on each doc (unlike the rest
    // of PUBLIC_SELECT's exclusions): the frontend needs it to order listings
    // within the Promoted section to match the priority set in admin, not
    // just group promoted vs. non-promoted.

    // Attach id + computed displayPrice + posted label; the nested shape itself
    // (basic/location/owner/price/property/amenities/terms/rules/media/pg)
    // is returned as-is and read directly by the frontend.
    const mapped = docs.map(doc => ({
      ...doc,
      id:           String(doc._id),
      displayPrice: formatPrice((doc.price || {}).rent, (doc.basic || {}).status),
      posted:       doc.createdAt
                      ? formatPostedDateTime(doc.createdAt)
                      : 'Recently',
      verified:     !!doc.verified,
      booked:       !!doc.booked,
    }));

    res.set('Cache-Control', 'public, max-age=30'); // public listing data only, already scrubbed of PII — avoids a redundant DB hit on quick back/forward navigation
    res.json({ properties: mapped, total: mapped.length });
  } catch (err) {
    console.error('GET /api/properties error:', err);
    res.status(500).json({ message: 'Error fetching properties' });
  }
});

// ── POST /api/properties/:id/view (public: record one view of a listing) ──
// Called once per browser per listing. Dedup is now server-side via
// PropertyView (propertyId + visitorFingerprint(req), see above) rather than
// trusting the frontend's localStorage "seen" set — localStorage is empty in
// every fresh incognito window, so a device could inflate a listing's count
// just by opening it privately under the old, client-only dedup. This is
// what admin's per-listing / reset-all views actions operate on.
const viewLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' }
});

app.post('/api/properties/:id/view', viewLimiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid property id' });
    }

    const fingerprint = visitorFingerprint(req);

    // Try to claim this (propertyId, fingerprint) pair. The unique index
    // rejects a repeat with E11000 — that's how we know this device has
    // already been counted for this listing, incognito or not.
    let isNewView = true;
    try {
      await PropertyView.create({ propertyId: req.params.id, fingerprint });
    } catch (err) {
      if (err && err.code === 11000) {
        isNewView = false;
      } else {
        throw err;
      }
    }

    let updated = null;
    for (const M of LISTING_MODEL_LIST) {
      updated = isNewView
        ? await M.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true })
        : await M.findById(req.params.id);
      if (updated) break;
    }
    if (!updated) return res.status(404).json({ message: 'Property not found' });
    res.json({ views: updated.views });
  } catch (err) {
    console.error('POST /api/properties/:id/view error:', err);
    res.status(500).json({ message: 'Error recording view' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// ── GET /property/:id — server-rendered OG preview + SPA shell ──
// WhatsApp/FB/Google crawlers don't run JS, so a plain fetch of `/` only ever
// sees the generic HomeLoop title/description — never a specific listing's
// photo/price/area, no matter what query string or path was shared. This
// route reads the same index.html served at `/`, swaps in listing-specific
// <title>/description/OG/Twitter tags server-side (so the crawler sees them
// in the initial HTML), then sends it as-is — the page's existing client JS
// still runs identically afterwards and opens the listing modal itself (see
// the path-based deep-link check added to the DOMContentLoaded handler in
// index.html). openWhatsApp() in index.html builds links in this
// `/property/:id` form now instead of the old `?property=` query string;
// old `?property=` links still open the right listing client-side (unchanged
// logic) but won't get a rich preview, since that only happens server-side here.
// Falls back to the untouched generic shell for a bad/unverified/booked id,
// so a stale or malformed link just degrades to the normal homepage instead
// of erroring.
// ────────────────────────────────────────────────────────────────────────────
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');

// Cached in memory so /property/:id doesn't re-read this ~850KB file from
// disk on every request — it only changes on deploy, so we read it once
// (lazily, on the first request that needs it) and reuse the string after.
let _indexHtmlCache = null;

function escapeHtmlAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.get('/property/:id', async (req, res, next) => {
  let html;
  try {
    if (_indexHtmlCache === null) {
      _indexHtmlCache = await fs.promises.readFile(INDEX_HTML_PATH, 'utf8');
    }
    html = _indexHtmlCache;
  } catch (readErr) {
    console.error('GET /property/:id — could not read index.html:', readErr.message);
    return next(); // let the 404/static handlers deal with it, same as any other unmatched route
  }

  try {
    const { id } = req.params;
    if (mongoose.Types.ObjectId.isValid(id)) {
      // Same public-visibility rule as GET /api/properties: only verified,
      // non-booked listings are eligible for a rich preview.
      const results = await Promise.all(
        LISTING_MODEL_LIST.map(M => M.findOne({ _id: id, verified: true, booked: { $ne: true } }).lean())
      );
      const doc = results.find(Boolean);

      if (doc) {
        const area   = (doc.location && doc.location.area) || 'Bangalore';
        const status = (doc.basic && doc.basic.status) || 'For Rent';
        // doc.property.bhk already stores the full label from the post-form
        // dropdown (e.g. "1 RK", "1 BHK", "2 BHK") — don't re-append " BHK"
        // or it doubles up as "1 BHK BHK".
        const bhk    = (doc.property && doc.property.bhk) ? `${doc.property.bhk} ` : '';
        const type   = (doc.property && doc.property.type)
          ? `${doc.property.type} `
          : (status === 'PG' ? 'PG ' : status === 'Short Stay' ? 'Stay ' : 'Property ');
        const price  = formatPrice((doc.price || {}).rent, status);
        // status is already phrased as "For Rent" for that case, so a bare
        // "for ${status}" reads as "for For Rent" — only prefix "for" when
        // status isn't already leading with it.
        const statusPhrase = /^for\b/i.test(status) ? status : `for ${status}`;

        const title = `${bhk}${type}${statusPhrase} in ${area}, Bangalore \u2013 \u20B9${price} | HomeLoop`;
        const descSource = (doc.media && doc.media.desc && doc.media.desc.trim())
          ? doc.media.desc
          : `${bhk}${type}available ${statusPhrase} in ${area}, Bangalore. View photos, price and contact details on HomeLoop.`;
        const description = String(descSource).replace(/\s+/g, ' ').trim().slice(0, 200);

        const firstImage = (doc.media && Array.isArray(doc.media.images) && doc.media.images[0]) || '';
        // media.images entries are relative paths served by GET /uploads/:id
        // (e.g. "/uploads/123-abc.webp") — OG needs an absolute URL, so
        // resolve against this request's own host.
        const origin = `${req.protocol}://${req.get('host')}`;
        const imageUrl = firstImage ? `${origin}${firstImage}` : `${origin}/og-default.png`;
        // NOTE: add a real /public/og-default.png (1200x630 recommended) as
        // the fallback preview image for listings with no photos yet — a
        // missing file here just means those previews show no image.
        const pageUrl = `${origin}/property/${id}`;

        const safeTitle = escapeHtmlAttr(title);
        const safeDesc  = escapeHtmlAttr(description);
        const safeImage = escapeHtmlAttr(imageUrl);
        const safeUrl   = escapeHtmlAttr(pageUrl);

        html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`);
        html = html.replace(/<meta name="description" content="[^"]*"\s*\/?>/i,
          `<meta name="description" content="${safeDesc}" />`);

        const ogTags = `
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${safeImage}" />
  <meta property="og:url" content="${safeUrl}" />
  <meta property="og:site_name" content="HomeLoop" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeImage}" />
</head>`;
        html = html.replace('</head>', ogTags);
      }
      // Unverified/booked/nonexistent id → doc is null, generic shell goes out untouched below.
    }

    // Listing data (price, verified, booked) can change, so don't let a CDN
    // or browser cache a preview that goes stale.
    res.set('Cache-Control', 'no-cache');
    res.send(html);
  } catch (err) {
    console.error('GET /property/:id error:', err);
    res.set('Cache-Control', 'no-cache');
    res.send(html); // still serve the generic shell rather than a hard error page
  }
});

// ── POST /api/visits (Schedule a Visit modal) ──
const visitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many visit requests. Please try again later.' }
});

app.post('/api/visits', visitLimiter, requireUser, async (req, res) => {
  try {
    const { propertyId, visitorName, visitorPhone, email, note, visitDate, visitTime } = req.body || {};

    if (!propertyId || !mongoose.Types.ObjectId.isValid(propertyId)) {
      return res.status(400).json({ message: 'A valid propertyId is required' });
    }
    if (!visitorName || !String(visitorName).trim()) {
      return res.status(400).json({ message: 'Your name is required' });
    }
    if (!visitorPhone || !String(visitorPhone).trim()) {
      return res.status(400).json({ message: 'Your phone number is required' });
    }
    if (!visitDate || !/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) {
      return res.status(400).json({ message: 'A valid visit date is required' });
    }
    if (!visitTime || !/^\d{2}:\d{2}$/.test(visitTime)) {
      return res.status(400).json({ message: 'A valid visit time is required' });
    }

    const { doc: property, model: propertyModel, type: propertyType } = await findListingById(propertyId, { lean: true });
    if (!property) return res.status(404).json({ message: 'Property not found' });

    // Block a second visit request from the same user for the same property on the
    // same date — regardless of the time slot chosen. A previously cancelled request
    // doesn't count, so the user can still rebook after cancelling.
    if (req.userId) {
      const duplicate = await VisitRequest.findOne({
        userId:     req.userId,
        propertyId,
        visitDate,
        status: { $ne: 'Cancelled' },
      }).lean();
      if (duplicate) {
        return res.status(409).json({ message: 'You already have a visit request for this property on this date. Please choose a different date, or cancel your existing request first.' });
      }
    }

    const visitId = await nextSequenceId('VISIT');

    const visit = await VisitRequest.create({
      visitId,
      propertyId,
      propertyType,
      userId:         req.userId || null,
      userReadableId: req.userReadableId || null, // e.g. USER-000001, for admin readability
      visitorName:  String(visitorName).trim(),
      visitorPhone: String(visitorPhone).trim(),
      email:        email ? String(email).trim().toLowerCase() : '',
      note:         note ? String(note).trim().slice(0, 1000) : '',
      visitDate,
      visitTime,
    });

    // Bump the property's visit-request counter. $inc is atomic, so concurrent
    // requests for the same property can't race and undercount each other.
    const updatedProperty = await propertyModel.findByIdAndUpdate(
      propertyId,
      { $inc: { visitCount: 1 } },
      { new: true, select: 'visitCount' }
    ).lean();

    // Drop a notification for the visit itself (not just later status
    // changes) — this is what lets the notification panel offer an
    // "Add to calendar" action right away, before an owner/admin has
    // confirmed anything. `property` was already fetched above via
    // findListingById, so no extra query is needed here.
    await notifyUser(visit.userId, {
      type: 'visit_status',
      title: 'Visit requested',
      message: `Your visit request for ${visitDate} at ${visitTime} has been saved and is awaiting confirmation.`,
      meta: {
        visitId: visit.visitId, mongoId: String(visit._id), status: 'Pending',
        visitDate, visitTime,
        propertyName: (property.owner    && property.owner.propertyName) || '',
        propertyArea: (property.location && property.location.area)      || '',
        propertyCode: property.propertyId || '',
      },
    });

    res.status(201).json({
      message: 'Visit request saved',
      visit,
      visitCount: updatedProperty ? updatedProperty.visitCount : undefined,
    });
  } catch (err) {
    console.error('POST /api/visits error:', err);
    res.status(500).json({ message: 'Error saving visit request' });
  }
});

// ── POST /api/bookings (Book Now modal — Short Stay direct booking) ──
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many booking requests. Please try again later.' }
});

app.post('/api/bookings', bookingLimiter, requireUser, async (req, res) => {
  try {
    const { propertyId, guestName, guestPhone, email, note, checkinDate, days, guests } = req.body || {};

    if (!propertyId || !mongoose.Types.ObjectId.isValid(propertyId)) {
      return res.status(400).json({ message: 'A valid propertyId is required' });
    }
    if (!guestName || !String(guestName).trim()) {
      return res.status(400).json({ message: 'Your name is required' });
    }
    if (!guestPhone || !String(guestPhone).trim()) {
      return res.status(400).json({ message: 'Your phone number is required' });
    }
    if (!checkinDate || !/^\d{4}-\d{2}-\d{2}$/.test(checkinDate)) {
      return res.status(400).json({ message: 'A valid check-in date is required' });
    }
    const daysNum = parseInt(days, 10);
    if (!daysNum || daysNum < 1) {
      return res.status(400).json({ message: 'Number of days must be at least 1' });
    }
    const guestsNum = parseInt(guests, 10) || 1;

    const { doc: property, model: propertyModel, type: propertyType } = await findListingById(propertyId, { lean: true });
    if (!property) return res.status(404).json({ message: 'Property not found' });
    if (propertyType !== 'HourlyStay') {
      return res.status(400).json({ message: 'Direct booking is only available for Short Stay listings.' });
    }

    // Block a second booking from the same user for the same property on the
    // same check-in date. A previously cancelled booking doesn't count, so the
    // user can still rebook after cancelling.
    if (req.userId) {
      const duplicate = await BookingRequest.findOne({
        userId:      req.userId,
        propertyId,
        checkinDate,
        status: { $ne: 'Cancelled' },
      }).lean();
      if (duplicate) {
        return res.status(409).json({ message: 'You already have a booking for this property on this check-in date. Please choose a different date, or cancel your existing booking first.' });
      }
    }

    const bookingId = await nextSequenceId('BOOKING');

    const booking = await BookingRequest.create({
      bookingId,
      propertyId,
      propertyType,
      userId:         req.userId || null,
      userReadableId: req.userReadableId || null, // e.g. USER-000001, for admin readability
      guestName:  String(guestName).trim(),
      guestPhone: String(guestPhone).trim(),
      email:      email ? String(email).trim().toLowerCase() : '',
      note:       note ? String(note).trim().slice(0, 1000) : '',
      checkinDate,
      days:   daysNum,
      guests: guestsNum,
    });

    // Bump the property's booking counter. $inc is atomic, so concurrent
    // requests for the same property can't race and undercount each other.
    const updatedProperty = await propertyModel.findByIdAndUpdate(
      propertyId,
      { $inc: { bookingCount: 1 } },
      { new: true, select: 'bookingCount' }
    ).lean();

    res.status(201).json({
      message: 'Booking confirmed',
      booking,
      bookingCount: updatedProperty ? updatedProperty.bookingCount : undefined,
    });
  } catch (err) {
    console.error('POST /api/bookings error:', err);
    res.status(500).json({ message: 'Error saving booking' });
  }
});

// ── GET /api/user/my-visits (visit requests the logged-in user has made) ──
app.get('/api/user/my-visits', requireUser, async (req, res) => {
  try {
    const docs = await VisitRequest.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .populate('propertyId', 'owner.propertyName location.area')
      .lean();
    res.json({ visits: docs });
  } catch (err) {
    console.error('GET /api/user/my-visits error:', err);
    res.status(500).json({ message: 'Error fetching your visit requests' });
  }
});

// ── GET /api/user/notifications (logged-in user's notification feed) ──
app.get('/api/user/notifications', requireUser, async (req, res) => {
  try {
    const notifications = await Notification.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const unreadCount = await Notification.countDocuments({ userId: req.userId, read: false });
    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error('GET /api/user/notifications error:', err);
    res.status(500).json({ message: 'Error fetching notifications' });
  }
});

// ── GET /api/user/notifications/unread-count (lightweight — polled for the nav badge) ──
app.get('/api/user/notifications/unread-count', requireUser, async (req, res) => {
  try {
    const unreadCount = await Notification.countDocuments({ userId: req.userId, read: false });
    res.json({ unreadCount });
  } catch (err) {
    console.error('GET /api/user/notifications/unread-count error:', err);
    res.status(500).json({ message: 'Error fetching unread count' });
  }
});

// ── PATCH /api/user/notifications/:id/read (marks a single notification as read) ──
app.patch('/api/user/notifications/:id/read', requireUser, async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { read: true },
      { new: true }
    );
    if (!notif) return res.status(404).json({ message: 'Notification not found' });
    res.json({ message: 'Marked as read', notification: notif });
  } catch (err) {
    console.error('PATCH /api/user/notifications/:id/read error:', err);
    res.status(500).json({ message: 'Error marking notification as read' });
  }
});

// ── PATCH /api/user/notifications/read-all (marks every notification as read) ──
app.patch('/api/user/notifications/read-all', requireUser, async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.userId, read: false }, { read: true });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('PATCH /api/user/notifications/read-all error:', err);
    res.status(500).json({ message: 'Error marking notifications as read' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// ── USER-OWNED LISTINGS ──
// These three routes are the only way a regular (non-admin) user can read,
// edit, or delete listings tied to their own account. Every query below
// filters by { _id, userId: req.userId } together — never by _id alone — so
// a user can only ever touch a property that has THEIR userId stamped on it.
// Listings posted while logged out (userId: null) are not user-editable by
// anyone; only the admin panel can manage those.
// ────────────────────────────────────────────────────────────────────────────

// ── GET /api/user/my-listings ──
app.get('/api/user/my-listings', requireUser, async (req, res) => {
  try {
    const docArrays = await Promise.all(LISTING_MODEL_LIST.map(M => M.find({ userId: req.userId }).lean()));
    const docs = docArrays.flat().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const mapped = docs.map(doc => {
      const { bookingDetails, ...rest } = doc; // admin-only booking record — never shown in user-facing UI
      return {
        ...rest,
        id:           String(doc._id),
        displayPrice: formatPrice((doc.price || {}).rent, (doc.basic || {}).status),
      };
    });

    res.json({ properties: mapped, total: mapped.length });
  } catch (err) {
    console.error('GET /api/user/my-listings error:', err);
    res.status(500).json({ message: 'Error fetching your listings' });
  }
});

// ── PUT /api/user/listings/:id (edit a listing the user owns) ──
app.put('/api/user/listings/:id', listingWriteLimiter, requireUser, async (req, res) => {
  try {
    const { doc: prop, model: currentModel } = await findUserListingById(req.params.id, req.userId);
    if (!prop) return res.status(404).json({ message: 'Listing not found, or you do not have permission to edit it' });

    const body = req.body || {};
    const fields = NESTED_SECTIONS.reduce((acc, k) => {
      acc[k] = (body[k] && typeof body[k] === 'object') ? body[k] : {};
      return acc;
    }, {});

    // Only validate/apply sections the client actually sent something for,
    // so a partial edit (e.g. just price) doesn't get wiped by empty objects.
    const sentSections = NESTED_SECTIONS.filter(k => body[k] && typeof body[k] === 'object');
    const fieldsForValidation = {};
    for (const k of sentSections) fieldsForValidation[k] = fields[k];
    const validationError = validatePropertyFields(fieldsForValidation);
    if (validationError) return res.status(400).json({ message: validationError });

    // pg / shortStay are always sent in full by the form on every submit
    // (create or edit) — there's no partial-field editing UI for them like
    // there is for, say, price or amenities. So for these two, replace the
    // section outright rather than merging over the existing stored object.
    // This is what actually drops stale/legacy keys (e.g. old mealCost/beds/
    // pets values on older PG listings) the next time the owner saves an edit,
    // instead of carrying them forward forever via Object.assign.
    const FULL_REPLACE_SECTIONS = new Set(['pg', 'shortStay']);
    for (const section of sentSections) {
      prop[section] = FULL_REPLACE_SECTIONS.has(section)
        ? fields[section]
        : Object.assign({}, prop[section]?.toObject ? prop[section].toObject() : prop[section], fields[section]);
    }

    // property/terms/rules are Rent/Lease concepts, not PG ones — if this
    // listing is (or is being changed into) a PG, drop all three so no
    // duplicate/stale data lingers alongside `pg`, which already carries
    // everything the PG form collects. Short Stay doesn't collect
    // terms.notice or rules.nonVeg either, so drop just those two for it.
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
    console.error('PUT /api/user/listings/:id error:', err);
    res.status(500).json({ message: 'Error updating listing' });
  }
});

// ── PATCH /api/user/listings/:id/booked (owner: toggle booked flag on their own listing) ──
// Mirrors the admin booked toggle (admin.js), but scoped to the requesting
// owner — findOneAndUpdate is always filtered by { _id, userId } together so
// an owner can never flip this for a listing that isn't theirs. Once true,
// the listing is excluded from GET /api/properties (booked: { $ne: true }
// filter there) and disappears from the public site, same as the admin toggle.
app.patch('/api/user/listings/:id/booked', listingWriteLimiter, requireUser, async (req, res) => {
  try {
    const { booked } = req.body || {};
    if (typeof booked !== 'boolean') {
      return res.status(400).json({ message: 'booked must be a boolean' });
    }
    let updated = null;
    for (const M of LISTING_MODEL_LIST) {
      updated = await M.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { booked }, { new: true });
      if (updated) break;
    }
    if (!updated) return res.status(404).json({ message: 'Listing not found, or you do not have permission to update it' });
    res.json({ message: 'Booked status updated', booked: updated.booked });
  } catch (err) {
    console.error('PATCH /api/user/listings/:id/booked error:', err);
    res.status(500).json({ message: 'Error updating booked status' });
  }
});

app.delete('/api/user/listings/:id', listingWriteLimiter, requireUser, async (req, res) => {
  try {
    let deleted = null;
    for (const M of LISTING_MODEL_LIST) {
      deleted = await M.findOneAndDelete({ _id: req.params.id, userId: req.userId });
      if (deleted) break;
    }
    if (!deleted) return res.status(404).json({ message: 'Listing not found, or you do not have permission to delete it' });
    res.json({ message: 'Listing deleted' });
  } catch (err) {
    console.error('DELETE /api/user/listings/:id error:', err);
    res.status(500).json({ message: 'Error deleting listing' });
  }
});

const reviewSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  userKey:     { type: String, required: true, index: true },
  userName:    { type: String, required: true },
  userPhoto:   { type: String, trim: true, default: '' },
  accountType: { type: String, enum: ['customer', 'owner'], default: 'customer' },
  rating:      { type: Number, required: true, min: 1, max: 5 },
  text:        { type: String, required: true, maxlength: 500 },
  createdAt:   { type: Date, default: Date.now }
});

const Review = mongoose.model('Review', reviewSchema);

// GET /api/reviews?page=1&limit=10
// Public — no auth required to read reviews.
app.get('/api/reviews', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const skip  = (page - 1) * limit;

    const [reviews, total, avgResult, starBuckets] = await Promise.all([
      Review.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Review.countDocuments({}),
      Review.aggregate([{ $group: { _id: null, avg: { $avg: '$rating' } } }]),
      Review.aggregate([{ $group: { _id: '$rating', count: { $sum: 1 } } }])
    ]);

    const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    starBuckets.forEach(b => { if (ratingCounts[b._id] !== undefined) ratingCounts[b._id] = b.count; });

    res.json({
      reviews,
      total,
      avgRating: avgResult[0]?.avg || 0,
      ratingCounts
    });
  } catch (err) {
    console.error('GET /api/reviews error:', err.message);
    res.status(500).json({ error: 'Could not load reviews' });
  }
});

// GET /api/reviews/mine — tells the client whether the logged-in user has
// already posted a review, so the form can be hidden/shown correctly on load
// (not just right after a successful submit in the same session).
app.get('/api/reviews/mine', async (req, res) => {
  try {
    const userKey = req.headers['x-user-key'];
    if (!userKey) return res.json({ hasReviewed: false });

    const userId = await getUserIdFromSession(userKey);
    if (!userId) return res.json({ hasReviewed: false });

    const existing = await Review.findOne({ userId }).lean();
    res.json({ hasReviewed: !!existing, review: existing || null });
  } catch (err) {
    console.error('GET /api/reviews/mine error:', err.message);
    res.status(500).json({ error: 'Could not check review status' });
  }
});

// Rate limiter for review submission — the one-review-per-user check below
// already stops repeat spam from the same account, but this caps attempts
// (e.g. account-cycling) the same way every other write route here does.
const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many review submissions. Please try again later.' }
});

// Same cadence as reviewLimiter, separate bucket — honest reviews are a
// distinct collection/feature from the star reviews above.
const honestReviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many submissions. Please try again later.' }
});

// POST /api/reviews — requires a logged-in user (x-user-key header).
// Mirrors the same auth pattern used by your other /api/user/... routes.
app.post('/api/reviews', reviewLimiter, async (req, res) => {
  try {
    const userKey = req.headers['x-user-key'];
    if (!userKey) return res.status(401).json({ error: 'Please log in to leave a review' });

    const userId = await getUserIdFromSession(userKey);
    if (!userId) return res.status(401).json({ error: 'Invalid or expired session' });

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const rating = Number(req.body.rating);
    const text = (req.body.text || '').trim();
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    if (!text || text.length > 500) {
      return res.status(400).json({ error: 'Review text must be 1–500 characters' });
    }

    const existing = await Review.findOne({ userId: user._id });
    if (existing) {
      return res.status(409).json({ error: 'You have already posted a review' });
    }

    const review = await Review.create({
      userId: user._id,
      userKey,
      userName: user.name || 'HomeLoop user',
      userPhoto: user.profilePhoto || '',
      accountType: user.accountType || 'customer',
      rating,
      text
    });

    res.status(201).json({ review });
  } catch (err) {
    console.error('POST /api/reviews error:', err.message);
    res.status(500).json({ error: 'Could not save review' });
  }
});

// ── Honest Reviews (video testimonials shown as a "Shorts" style row) ──
// Two ways cards get in here, both go live immediately (no manage/approve
// UI exists on the site yet):
//  1) Admin adds one directly via POST /api/honest-reviews.
//  2) A logged-in user submits their own YouTube link via
//     POST /api/honest-reviews/submit.
// The `status` field (pending/approved/rejected) and the admin-only
// /api/honest-reviews/all, PUT, DELETE routes are kept so a moderation
// step can be reintroduced later without a schema change.
const honestReviewSchema = new mongoose.Schema({
  videoUrl:  { type: String, required: true },       // real YouTube/video link opened on click
  thumbUrl:  { type: String, required: true },        // thumbnail image shown on the card
  caption:   { type: String, required: true, maxlength: 120 },  // overlay text on the thumbnail
  title:     { type: String, required: true, maxlength: 120 }, // e.g. "Priya & Rohan — 2BHK in Indiranagar"
  meta:      { type: String, default: '', maxlength: 80 },     // e.g. "Moved in April 2026"
  verifiedLabel: { type: String, default: 'Verified tenant' },
  order:     { type: Number, default: 0 },             // lower shows first
  active:    { type: Boolean, default: true },
  status:    { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, default: null },   // set only for user-submitted videos
  userName:  { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const HonestReview = mongoose.model('HonestReview', honestReviewSchema);

// Pulls the video ID out of the common YouTube URL shapes so we can build a
// thumbnail automatically for user submissions (they won't have one to give
// us). Returns null if the link isn't a YouTube URL we recognize.
function extractYouTubeId(url) {
  try {
    const u = new URL(String(url).trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const shortsMatch = u.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = u.pathname.match(/^\/embed\/([^/?]+)/);
      if (embedMatch) return embedMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

// GET /api/honest-reviews — public, powers the homepage video row.
// Only approved + active cards are ever shown to regular visitors.
app.get('/api/honest-reviews', async (req, res) => {
  try {
    const reviews = await HonestReview.find({ active: true, status: 'approved' })
      .sort({ order: 1, createdAt: -1 })
      .lean();
    res.set('Cache-Control', 'public, max-age=300'); // admin-curated content, changes rarely
    res.json({ reviews });
  } catch (err) {
    console.error('GET /api/honest-reviews error:', err.message);
    res.status(500).json({ error: 'Could not load honest reviews' });
  }
});

// GET /api/honest-reviews/mine — a logged-in user checking the status of
// the video(s) they've submitted (pending / approved / rejected).
app.get('/api/honest-reviews/mine', requireUser, async (req, res) => {
  try {
    const reviews = await HonestReview.find({ userId: req.userId }).sort({ createdAt: -1 }).lean();
    res.json({ reviews });
  } catch (err) {
    console.error('GET /api/honest-reviews/mine error:', err.message);
    res.status(500).json({ error: 'Could not load your submissions' });
  }
});

// POST /api/honest-reviews/submit — any logged-in user can submit their own
// YouTube video. Goes live immediately (no manage/approve UI exists yet on
// the site) — if moderation is added back later, flip `active`/`status`
// below to false/'pending' and reintroduce an approve step.
app.post('/api/honest-reviews/submit', honestReviewLimiter, requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const videoUrl = (req.body.videoUrl || '').trim();
    const title = (req.body.title || '').trim();
    const caption = (req.body.caption || '').trim();

    const videoId = extractYouTubeId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Please paste a valid YouTube video link' });
    }
    if (!title) return res.status(400).json({ error: 'Please give your video a short title' });

    const review = await HonestReview.create({
      videoUrl,
      thumbUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      caption: caption || title,
      title: title.slice(0, 120),
      meta: `Submitted by ${user.name || 'a HomeLoop user'}`,
      verifiedLabel: 'Verified user',
      active: false,
      status: 'pending',
      userId: user._id,
      userName: user.name || ''
    });

    res.status(201).json({ review, message: 'Thanks! Your video has been submitted for review and will go live once approved.' });
  } catch (err) {
    console.error('POST /api/honest-reviews/submit error:', err.message);
    res.status(500).json({ error: 'Could not submit your video' });
  }
});

// ── Referrals (Refer & Earn modal — "refer a tenant directly" form) ──
// Same cadence as the other write-route limiters above, own bucket.
const referralLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many referrals submitted. Please try again later.' }
});

const referralSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }, // null when referred while logged out
  userReadableId: { type: String, default: null, index: true }, // e.g. USER-000001, for admin readability
  referrerName:   { type: String, required: true, trim: true },
  referrerPhone:  { type: String, required: true, trim: true },
  tenantName:     { type: String, required: true, trim: true },
  tenantPhone:    { type: String, required: true, trim: true, index: true }, // dedup is enforced in the route below, not via a DB-level unique index — see comment there for why
  status:         { type: String, enum: ['Pending', 'Rewarded', 'Rejected'], default: 'Pending' },
  createdAt:      { type: Date, default: Date.now },
});
referralSchema.index({ createdAt: -1 });
const Referral = mongoose.model('Referral', referralSchema);

// POST /api/referrals — "Refer & Earn" modal's direct-refer form. Works for
// guests too (the ₹1,000 reward just won't have an account to credit until
// they log in) — attachUserIfPresent stamps userId when a session exists,
// same pattern as POST /api/upload-images, and leaves it null otherwise.
app.post('/api/referrals', referralLimiter, attachUserIfPresent, async (req, res) => {
  try {
    const { referrerName, referrerPhone, tenantName, tenantPhone } = req.body || {};

    if (!referrerName || !String(referrerName).trim()) {
      return res.status(400).json({ message: 'Your name is required' });
    }
    if (!referrerPhone || !/^\d{10}$/.test(normalizeMobile(referrerPhone))) {
      return res.status(400).json({ message: 'A valid 10-digit phone number is required' });
    }
    if (!tenantName || !String(tenantName).trim()) {
      return res.status(400).json({ message: "Tenant's name is required" });
    }
    if (!tenantPhone || !/^\d{10}$/.test(normalizeMobile(tenantPhone))) {
      return res.status(400).json({ message: "A valid 10-digit tenant phone number is required" });
    }

    const normalizedReferrerPhone = normalizeMobile(referrerPhone);
    const normalizedTenantPhone   = normalizeMobile(tenantPhone);

    if (normalizedReferrerPhone === normalizedTenantPhone) {
      return res.status(400).json({ message: "You can't refer yourself.", selfReferral: true });
    }

    // Dedup on tenant number, but a Rejected referral (bad number, fraud,
    // etc.) shouldn't permanently block that tenant from being referred
    // again — only an active (Pending/Rewarded) referral counts as a
    // duplicate. That "not Rejected" condition can't be expressed as a
    // MongoDB partial-unique index (partialFilterExpression only supports
    // equality/$exists/$gt(e)/$lt(e)/$type, not $ne/$in), so this check —
    // not a DB-level unique constraint — is the actual dedup guarantee.
    // The referralLimiter above keeps concurrent-duplicate races rare
    // enough not to need one.
    const existing = await Referral.findOne({
      tenantPhone: normalizedTenantPhone,
      status: { $ne: 'Rejected' },
    });
    if (existing) {
      return res.status(409).json({ message: 'This tenant has already been referred.', duplicate: true });
    }

    const referral = await Referral.create({
      userId:         req.userId,
      userReadableId: req.userReadableId || null,
      referrerName:   String(referrerName).trim(),
      referrerPhone:  normalizedReferrerPhone,
      tenantName:     String(tenantName).trim(),
      tenantPhone:    normalizedTenantPhone,
    });

    res.status(201).json({ message: 'Thanks! We\'ll reach out to your referral shortly.', referral });
  } catch (err) {
    console.error('POST /api/referrals error:', err.message);
    res.status(500).json({ message: 'Could not save your referral. Please try again.' });
  }
});

// ── Partners (shown in the About Us modal's "Our Partners" row) ──
const partnerSchema = new mongoose.Schema({
  name:       { type: String, required: true, maxlength: 80 },
  role:       { type: String, required: true, maxlength: 80 },  // e.g. "Legal Advisor"
  phone:      { type: String, default: '', maxlength: 20 },
  email:      { type: String, default: '', maxlength: 120 },
  location:   { type: String, default: '', maxlength: 80 },     // e.g. "Indiranagar, Bengaluru"
  avatarText: { type: String, default: '', maxlength: 4 },      // optional override; frontend derives initials from name if blank
  order:      { type: Number, default: 0 },                      // lower shows first
  active:     { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now }
});

const Partner = mongoose.model('Partner', partnerSchema);

// GET /api/partners — public, powers the About Us modal's partners row.
app.get('/api/partners', async (req, res) => {
  try {
    const partners = await Partner.find({ active: true })
      .sort({ order: 1, createdAt: 1 })
      .lean();
    res.set('Cache-Control', 'public, max-age=300'); // partner logos, changes rarely
    res.json({ partners });
  } catch (err) {
    console.error('GET /api/partners error:', err.message);
    res.status(500).json({ error: 'Could not load partners' });
  }
});

// Accepts any number of images (multipart/form-data, field name 'images'), converts
// each to WebP (max 1200px on the long edge, quality 80) via sharp, and saves
// the resulting bytes as a document in MongoDB (not the local disk — Render's
// filesystem is wiped on every restart/redeploy/free-tier spin-down, but Mongo
// data persists, and this way no extra paid service or third-party account is
// needed). Each image is served back from GET /uploads/:id. Files never touch
// disk — multer holds them in memory, sharp re-encodes buffer-to-buffer, which
// also strips any embedded scripts/metadata that might be hiding in a
// malicious "image" upload.
// ────────────────────────────────────────────────────────────────────────────
const ImageAssetSchema = new mongoose.Schema({
  data:        { type: Buffer, required: true },
  contentType: { type: String, required: true, default: 'image/webp' },
  createdAt:   { type: Date, default: Date.now },
});
const ImageAsset = mongoose.model('ImageAsset', ImageAssetSchema);

// Public — anyone viewing a listing needs to load these, no auth required.
// Cached hard since each id's bytes never change (a re-upload creates a new id).
app.get('/uploads/:id', async (req, res) => {
  try {
    const img = await ImageAsset.findById(req.params.id).lean();
    if (!img) return res.status(404).end();
    res.set('Content-Type', img.contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data.buffer || img.data));
  } catch (err) {
    // Malformed/non-ObjectId id, etc. — just 404 rather than 500.
    res.status(404).end();
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per file, no cap on file count
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'].includes(file.mimetype);
    cb(ok ? null : new Error('Only image files are allowed'), ok);
  },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many upload requests. Please try again later.' }
});

app.post('/api/upload-images', uploadLimiter, attachUserIfPresent, upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: 'No images uploaded' });

    const urls = [];
    for (const file of files) {
      const webpBuffer = await sharp(file.buffer)
        .rotate() // honor EXIF orientation before stripping metadata
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      const doc = await ImageAsset.create({ data: webpBuffer, contentType: 'image/webp' });
      urls.push(`/uploads/${doc._id}`);
    }

    res.status(201).json({ message: 'Images uploaded successfully', urls });
  } catch (err) {
    console.error('POST /api/upload-images error:', err);
    res.status(500).json({ message: 'Error uploading images' });
  }
});

// Multer-specific errors (file too large, too many files, wrong type) come through
// as thrown errors rather than rejections multer itself formats — catch them here
// so the client gets a clean 400 instead of a raw 500.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || (err && /Only image files/.test(err.message || ''))) {
    return res.status(400).json({ message: err.message });
  }
  next(err);
});

// ────────────────────────────────────────────────────────────────────────────
// ── PAYMENTS (UPI/QR/bank transfer, verified by hand) ──
// A PaymentRequest is created the moment a user starts paying (purpose +
// amount, optionally a propertyId). The frontend then shows our UPI ID/QR
// code/bank details (PaymentSettings, edited by admin); the request's
// reference code is embedded automatically as the transfer note when paying
// via the in-app UPI deep link. Once they've paid externally (their own UPI
// app or bank), they submit an optional screenshot via
// /api/payments/:id/submit-proof, which flips status to 'submitted'. An
// admin then reviews it against the bank/UPI statement and calls
// /api/admin/payments/:id/verify or /reject.
// ────────────────────────────────────────────────────────────────────────────

// Single document (key: 'default') holding the shared payment destination,
// editable by admin. Nothing here is more sensitive than what you'd put on
// an invoice, since it's shown to any user about to pay.
const PaymentSettingsSchema = new mongoose.Schema({
  key:               { type: String, default: 'default', unique: true },
  upiId:             { type: String, default: '', trim: true },
  qrImageUrl:        { type: String, default: '', trim: true }, // '/uploads/<ImageAsset id>' — same pipeline as listing photos
  bankAccountName:   { type: String, default: '', trim: true },
  bankAccountNumber: { type: String, default: '', trim: true },
  bankIfsc:          { type: String, default: '', trim: true },
  paymentPhone:      { type: String, default: '', trim: true },
  updatedAt:         { type: Date, default: Date.now },
});
const PaymentSettings = mongoose.model('PaymentSettings', PaymentSettingsSchema);

// Public — anyone about to pay needs to see where to send money
// (UPI ID/QR/bank details, edited by admin below).
// TEMPORARY: until there's an admin screen to set real values (and someone
// uses it), DUMMY_PAYMENT_DETAILS below is shown instead of nothing. These
// are NOT real payment details — replace them with your actual UPI id/bank
// account either via PUT /api/admin/payment-settings once that screen
// exists, or by editing this object directly, then delete this block.
const DUMMY_PAYMENT_DETAILS = {
  upiId:             '8553261336@sbi',
  qrImageUrl:        '',
  bankAccountName:   'Prashanth B',
  bankAccountNumber: '45271244115',
  bankAccountType:   'Savings Account',
  bankName:          'SBI',
  bankBranch:        'PBB BELLANDUR',
  bankIfsc:          'SBIN0017608',
  paymentPhone:      '8553261336',
};
app.get('/api/payment-settings', async (req, res) => {
  try {
    const settings = await PaymentSettings.findOne({ key: 'default' }).lean();
    if (!settings) console.warn('⚠️  No PaymentSettings in DB — serving DUMMY_PAYMENT_DETAILS. Replace these before accepting real payments.');
    res.set('Cache-Control', 'public, max-age=60'); // rarely changes; kept short since it's payment-related
    res.json(settings || DUMMY_PAYMENT_DETAILS);
  } catch (err) {
    console.error('GET /api/payment-settings error:', err.message);
    res.status(500).json({ message: 'Error fetching payment settings' });
  }
});

// ── Payment requests ──
// Created the moment a user starts a payment (before they've actually paid),
// so there's a refCode up front to put in the transfer note. Stays 'pending'
// until they submit a screenshot (-> 'submitted'), then an admin marks it
// 'verified' or 'rejected' by hand. razorpay* fields are kept only so old,
// pre-existing records (from when this used Razorpay) still load correctly.
const PaymentRequestSchema = new mongoose.Schema({
  refCode:        { type: String, unique: true, index: true }, // e.g. PAY-000123
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userReadableId: { type: String, default: null, index: true }, // human-readable User.userId, same pattern as VisitRequest/Property
  purpose:        { type: String, enum: ['brokerage', 'booking', 'visit_deposit', 'promotion'], required: true },
  // Real listing _id, when the caller has one on hand (e.g. the "Promote this
  // listing" button on My Listings, which already knows the property's Mongo
  // _id, or the property picker in the payment modal). Left null when the
  // payment isn't tied to a specific listing.
  propertyId:     { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  // Freeform context — e.g. "HWR123 - Rent - Whitefield" from the property
  // picker — shown alongside the payment in history/admin views.
  note:           { type: String, default: '', trim: true, maxlength: 300 },
  amount:         { type: Number, required: true }, // rupees
  paymentMethod:  { type: String, enum: ['razorpay', 'manual'], default: 'manual' }, // 'razorpay' only appears on old pre-existing records
  razorpayOrderId:     { type: String, default: '', index: true }, // legacy, pre-existing records only
  razorpayPaymentId:   { type: String, default: '' },               // legacy, pre-existing records only
  razorpaySignature:   { type: String, default: '' },               // legacy, pre-existing records only
  utr:            { type: String, default: '', trim: true }, // UPI transaction ref, entered by the payer
  screenshotUrl:  { type: String, default: '' }, // '/uploads/<ImageAsset id>'
  status:         { type: String, enum: ['pending', 'submitted', 'verified', 'rejected'], default: 'pending', index: true },
  adminRemark:    { type: String, default: '', trim: true, maxlength: 300 },
  createdAt:      { type: Date, default: Date.now },
  submittedAt:    { type: Date, default: null },
  verifiedAt:     { type: Date, default: null },
});
PaymentRequestSchema.index({ createdAt: -1 });
const PaymentRequest = mongoose.model('PaymentRequest', PaymentRequestSchema);

// Mirrors the rate-limit pattern used for visits/bookings/reviews above.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many payment requests. Please try again later.' }
});

// Step 1 — user starts a payment: creates the PaymentRequest with a fresh
// refCode. The frontend follows up by showing our UPI/QR/bank details
// (fetched separately from /api/payment-settings) alongside this refCode.
app.post('/api/payments/request', paymentLimiter, requireUser, async (req, res) => {
  try {
    const { purpose, amount, note, propertyId, category, rentTotal } = req.body || {};
    if (!['brokerage', 'booking', 'visit_deposit', 'promotion'].includes(purpose)) {
      return res.status(400).json({ message: 'Invalid payment purpose' });
    }
    let amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: 'A valid amount is required' });
    // Sanity ceiling — nothing charged through this flow should ever be this
    // high; catches typos/overflow attempts regardless of which branch below applies.
    if (amt > 1_00_00_000) return res.status(400).json({ message: 'Amount is too large' });
    if (propertyId && !mongoose.Types.ObjectId.isValid(propertyId)) {
      return res.status(400).json({ message: 'Invalid property id' });
    }

    // If a propertyId was given, resolve the actual listing doc now — used
    // below both to enforce ownership (for purposes that require it) and to
    // cross-check the amount against fixed/percentage fee rules where one exists.
    let propertyDoc = null;
    if (propertyId) {
      for (const M of LISTING_MODEL_LIST) {
        propertyDoc = await M.findById(propertyId).select('userId basic.status').lean();
        if (propertyDoc) break;
      }
      if (!propertyDoc) return res.status(404).json({ message: 'Property not found' });
    }

    // "Promote my listing" only makes sense against a listing you own —
    // require the propertyId and check ownership, same rule the edit/delete
    // routes above use ({ _id, userId } together).
    if (purpose === 'promotion') {
      if (!propertyDoc) return res.status(400).json({ message: 'A property you own is required to promote a listing' });
      if (String(propertyDoc.userId) !== String(req.userId)) {
        return res.status(403).json({ message: 'You can only promote your own listing' });
      }
    }

    // Fee amounts we can actually verify server-side, mirroring the numbers
    // the frontend itself computes/locks in the payment modal. Anything not
    // covered here (booking/visit_deposit, or "Other" amounts with no fixed
    // schedule) still just gets the basic positive-number check above —
    // those are self-declared figures with no ground truth to validate against,
    // and rely on the admin's manual verification against the bank/UPI statement.
    const user = await User.findById(req.userId).select('accountType').lean();
    if (purpose === 'brokerage' && user && user.accountType === 'owner') {
      // Flat fixed charge — the frontend locks this field to 2000 and never
      // lets an owner edit it, so ignore whatever the client sent and use
      // the known-correct figure instead of merely validating it.
      amt = 2000;
    } else if (purpose === 'brokerage' && category === 'pg') {
      if (amt !== 1000) return res.status(400).json({ message: 'PG brokerage is a flat ₹1,000 fee' });
    } else if (purpose === 'brokerage' && (category === 'rent' || category === 'lease')) {
      const total = Number(rentTotal);
      if (!Number.isFinite(total) || total <= 0) {
        return res.status(400).json({ message: 'A valid monthly rent is required to compute the brokerage amount' });
      }
      const pct = category === 'lease' ? 0.5 : 0.3;
      const expected = Math.round(total * pct);
      if (amt !== expected) {
        return res.status(400).json({ message: `Amount does not match ${category === 'lease' ? '50%' : '30%'} of the entered rent` });
      }
    }

    const refCode = await nextSequenceId('PAY');
    const request = await PaymentRequest.create({
      refCode,
      userId:         req.userId,
      userReadableId: req.userReadableId,
      purpose,
      propertyId: propertyId || null,
      note:       note ? String(note).trim().slice(0, 300) : '',
      amount: amt,
    });
    console.log('payment request created:', { refCode, amount: amt, purpose });

    res.status(201).json({ message: 'Payment request created', request });
  } catch (err) {
    console.error('POST /api/payments/request error:', err.message);
    res.status(500).json({ message: 'Error creating payment request' });
  }
});

// Step 2 — user submits proof after paying externally via UPI/bank transfer:
// an optional screenshot (reuses the same multer + sharp pipeline as listing
// photo uploads, single file this time). `utr` is accepted if sent but no
// longer required — the frontend no longer collects it. Only the request's
// own owner can submit for it. An admin reviews the submission by hand
// (see /api/admin/payments/:id/verify below).
app.post('/api/payments/:id/submit-proof', paymentLimiter, requireUser, upload.single('screenshot'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid payment id' });
    const request = await PaymentRequest.findOne({ _id: req.params.id, userId: req.userId });
    if (!request) return res.status(404).json({ message: 'Payment request not found' });
    if (request.status === 'verified') return res.status(409).json({ message: 'This payment is already verified' });

    const { utr } = req.body || {};

    let screenshotUrl = request.screenshotUrl;
    if (req.file) {
      const webpBuffer = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      const doc = await ImageAsset.create({ data: webpBuffer, contentType: 'image/webp' });
      screenshotUrl = `/uploads/${doc._id}`;
    }

    request.utr = utr ? String(utr).trim() : '';
    request.screenshotUrl = screenshotUrl;
    request.status = 'submitted';
    request.submittedAt = new Date();
    await request.save();

    res.json({ message: 'Payment proof submitted — awaiting verification', request });
  } catch (err) {
    console.error('POST /api/payments/:id/submit-proof error:', err.message);
    res.status(500).json({ message: 'Error submitting payment proof' });
  }
});

// User's own payment history, newest first — powers the Payments tab in the profile modal.
app.get('/api/user/payments', requireUser, async (req, res) => {
  try {
    const payments = await PaymentRequest.find({ userId: req.userId }).sort({ createdAt: -1 }).lean();
    res.json({ payments });
  } catch (err) {
    console.error('GET /api/user/payments error:', err.message);
    res.status(500).json({ message: 'Error fetching payments' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// ── SITE STATS (visitor counter + total registered users) ──
// Powers the two small stat pills above the FAB on the homepage:
//   - "Website visitors": all-time count of UNIQUE visitors (not page loads),
//     bumped once per visitor by a fire-and-forget call from the frontend on
//     load. "Today's visitors" is the same idea, scoped to the current day.
//   - "Login users": total registered users (User.countDocuments()).
// A single-document counter (keyed by `key`) is enough here — no need for
// the Counter/nextSequenceId pattern used for human-readable IDs elsewhere.
// ────────────────────────────────────────────────────────────────────────────
const SiteStatSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true, index: true },
  value: { type: Number, default: 0 },
});
const SiteStat = mongoose.model('SiteStat', SiteStatSchema);

// ── Visitor identity, for dedup ──
// Two-tier identity so a person isn't recounted from the same device:
//   1. `visitorId` — a random token set as a long-lived cookie. Survives
//      refreshes, new tabs, and closing/reopening the browser normally.
//   2. `fingerprint` — sha256(IP + User-Agent). Cookies don't survive an
//      incognito/private window (browsers isolate that storage on purpose),
//      so this is the fallback that still recognizes "same device, same
//      network" even when no cookie comes back.
// A visit is "new" (bumps the all-time counter) only when NEITHER identity
// matches an existing record. Note this is best-effort, not exact: devices
// sharing one IP behind the same NAT with an identical browser/OS combo can
// collide (undercount), and a visitor switching networks while incognito
// won't be recognized (overcount). That's an inherent limit of dedup without
// requiring accounts/login — normal for any visitor-counter implementation.
const VisitorSchema = new mongoose.Schema({
  visitorId:    { type: String, default: null, index: true },
  fingerprint:  { type: String, required: true, index: true },
  firstSeenAt:  { type: Date, default: Date.now },
  lastSeenAt:   { type: Date, default: Date.now },
  lastSeenDate: { type: String, required: true }, // 'YYYY-MM-DD', local to bumpDailyStat's clock
});
const Visitor = mongoose.model('Visitor', VisitorSchema);

const VISITOR_COOKIE_NAME  = 'hl_vid';
const VISITOR_COOKIE_MAXAGE_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 5 years

// ── Per-property view dedup ──
// Same fingerprint idea as Visitor above (visitorFingerprint()), but scoped
// per-listing: one doc per (propertyId, fingerprint) pair. This is what makes
// /api/properties/:id/view safe against incognito windows — the old version
// relied only on the frontend's localStorage "seen" set, which is empty in
// every fresh incognito session, so the same device could re-inflate a
// listing's view count just by opening it privately. The unique index below
// is the actual dedup: a repeat (propertyId, fingerprint) throws E11000
// instead of inserting, so we know not to increment again.
const PropertyViewSchema = new mongoose.Schema({
  propertyId:  { type: String, required: true },
  fingerprint: { type: String, required: true },
  createdAt:   { type: Date, default: Date.now },
});
PropertyViewSchema.index({ propertyId: 1, fingerprint: 1 }, { unique: true });
const PropertyView = mongoose.model('PropertyView', PropertyViewSchema);

// Minimal cookie reader — avoids pulling in cookie-parser for one cookie.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function visitorFingerprint(req) {
  const ua = (req.headers['user-agent'] || '').toString();

  // Preferred: a device signature the frontend builds from screen size,
  // timezone, language, platform, etc. (see buildDeviceSignature() in
  // index.html). These stay the same across incognito windows AND across
  // network changes (VPN, wifi -> mobile data) on the same physical device,
  // so switching networks no longer makes a returning visitor look "new".
  const sig = req.body && typeof req.body.deviceSig === 'string' ? req.body.deviceSig.slice(0, 512) : '';
  if (sig) return crypto.createHash('sha256').update(`${ua}|${sig}`).digest('hex');

  // Fallback for clients that couldn't supply a signature (JS blocked, very
  // old browser) — IP+UA, best-effort only. req.ip respects 'trust proxy'
  // (set above), so this is the real client IP behind Render's proxy.
  const ip = (req.ip || '').toString();
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex');
}

// ── Daily breakdown backing the admin panel's "Daily Visits" and
// "Users Registered" tabs. One doc per (date, type) — bumped once per page
// load (type: 'visit') or once per new account (type: 'registration').
// Kept separate from SiteStat (which only holds the all-time totals) so the
// admin can clear or delete individual days without touching real data
// (VisitRequest docs / User accounts).
const DailyStatSchema = new mongoose.Schema({
  date:  { type: String, required: true }, // 'YYYY-MM-DD'
  type:  { type: String, required: true, enum: ['visit', 'registration'] },
  count: { type: Number, default: 0 },
});
DailyStatSchema.index({ date: 1, type: 1 }, { unique: true });
const DailyStat = mongoose.model('DailyStat', DailyStatSchema);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function bumpDailyStat(type) {
  try {
    await DailyStat.findOneAndUpdate(
      { date: todayStr(), type },
      { $inc: { count: 1 } },
      { upsert: true }
    );
  } catch (err) {
    console.error(`bumpDailyStat(${type}) error:`, err.message);
  }
}

// Light rate limit — this is a public, unauthenticated endpoint hit once per
// page load, so it just needs to keep bots from spamming it, not restrict
// normal browsing.
const visitLimiterStats = rateLimit({
  windowMs: 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' }
});

app.post('/api/stats/visit', visitLimiterStats, async (req, res) => {
  try {
    const today = todayStr();
    const cookieVid = readCookie(req, VISITOR_COOKIE_NAME);
    const fingerprint = visitorFingerprint(req);

    // Cookie match first (most precise — one browser, not "one IP+UA").
    // Fingerprint is only a fallback for when the cookie didn't come back,
    // e.g. a fresh incognito window on the same device/network.
    let visitor = null;
    if (cookieVid) visitor = await Visitor.findOne({ visitorId: cookieVid });
    if (!visitor) visitor = await Visitor.findOne({ fingerprint });

    let totalVisits;
    let visitorIdForCookie;

    if (visitor) {
      // Returning visitor (recognized via cookie or fingerprint) — never
      // bump the all-time counter again. Only bump "today" if this is the
      // first time we've seen them today.
      const isNewDay = visitor.lastSeenDate !== today;
      visitor.visitorId    = cookieVid || visitor.visitorId; // backfill if browser had no cookie yet
      visitor.fingerprint   = fingerprint;
      visitor.lastSeenAt    = new Date();
      visitor.lastSeenDate  = today;
      await visitor.save();

      if (isNewDay) await bumpDailyStat('visit');

      visitorIdForCookie = visitor.visitorId || crypto.randomBytes(16).toString('hex');
      const doc = await SiteStat.findOne({ key: 'totalVisits' }).lean();
      totalVisits = doc ? doc.value : 0;
    } else {
      // Genuinely new visitor — bump both all-time and today.
      visitorIdForCookie = cookieVid || crypto.randomBytes(16).toString('hex');
      await Visitor.create({
        visitorId:    visitorIdForCookie,
        fingerprint,
        lastSeenDate: today,
      });

      const doc = await SiteStat.findOneAndUpdate(
        { key: 'totalVisits' },
        { $inc: { value: 1 } },
        { upsert: true, new: true }
      );
      await bumpDailyStat('visit');
      totalVisits = doc.value;
    }

    res.cookie(VISITOR_COOKIE_NAME, visitorIdForCookie, {
      maxAge: VISITOR_COOKIE_MAXAGE_MS,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    res.json({ totalVisits });
  } catch (err) {
    console.error('POST /api/stats/visit error:', err.message);
    res.status(500).json({ message: 'Error recording visit' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [visitDoc, totalUsers, todayVisitDoc] = await Promise.all([
      SiteStat.findOne({ key: 'totalVisits' }).lean(),
      User.countDocuments(),
      DailyStat.findOne({ date: todayStr(), type: 'visit' }).lean(),
    ]);
    res.set('Cache-Control', 'public, max-age=10'); // short TTL — these are meant to feel live
    res.json({
      totalVisits: visitDoc ? visitDoc.value : 0,
      totalUsers,
      todayVisits: todayVisitDoc ? todayVisitDoc.count : 0,
    });
  } catch (err) {
    console.error('GET /api/stats error:', err.message);
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

// ── Admin routes (separated out to admin.js) ── mounted last among real
// routes so every model/helper it needs is already defined above, but
// still before the catch-all 404 below.
require('./admin')(app, {
  User, VisitRequest, LISTING_MODEL_LIST,
  findListingById, updateListingById, deleteListingById, moveListingIfNeeded,
  NESTED_SECTIONS, validatePropertyFields, formatPrice,
  nextPropertyId, modelForStatus,
  notifyUser, visitCalendarMeta,
  HonestReview, Partner, PaymentSettings, PaymentRequest,
  SiteStat, DailyStat, todayStr, Referral,
});

// 404 for any API route that didn't match above.
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

// ── Global error handler ── (registered last, after every route, so it
// actually catches errors from all of them — admin.js's requireAdmin
// middleware needs this too, which is why admin routes are mounted above.)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ message: 'An unexpected error occurred.' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));