const mongoose  = require('mongoose');
const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');

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
    SiteStat, DailyStat, todayStr,
  } = deps;

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

  // Sessions used to expire after 4 hours, which logged admins out mid-work
  // even though the tab was still open. The admin panel is meant to behave
  // like "stay signed in until you explicitly log out", so this is now a
  // long-lived TTL (180 days) — effectively indefinite for normal use, while
  // still giving Mongo's TTL index a backstop to clean up truly abandoned
  // sessions instead of keeping them forever.
  const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

  const AdminSessionSchema = new mongoose.Schema({
    key:       { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, expires: 0 }, // TTL index: Mongo auto-deletes once expiresAt passes
  });

  const AdminSession = mongoose.model('AdminSession', AdminSessionSchema);

  async function issueAdminSession() {
    const key = crypto.randomBytes(32).toString('hex');
    await AdminSession.create({ key, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    return key;
  }

  async function isValidAdminSession(key) {
    if (!key) return false;
    const session = await AdminSession.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
    return !!session;
  }

  // Simple rate limiter on the login route to slow down brute-force attempts
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    message: { message: 'Too many login attempts. Please try again later.' }
  });

  app.post('/api/login', loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const normalizedEmail = String(email || '').toLowerCase();
      const account = ADMIN_ACCOUNTS.find(a => a.email === normalizedEmail);
      // Always run bcrypt.compare — even when no account matches the email, in
      // which case we compare against DUMMY_PASSWORD_HASH — so a wrong-email
      // request and a wrong-password request take the same amount of time.
      const passwordMatch = typeof password === 'string'
        && await bcrypt.compare(password, account ? account.passwordHash : DUMMY_PASSWORD_HASH);
      if (account && passwordMatch) {
        const adminKey = await issueAdminSession();
        return res.json({ message: 'Login successful', adminKey, firstName: ADMIN_NAME });
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
      await AdminSession.deleteOne({ key });
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
      if (!(await isValidAdminSession(key))) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      next();
    } catch (err) {
      console.error('requireAdmin error:', err);
      res.status(500).json({ message: 'Server error. Please try again.' });
    }
  }

  // ── GET /api/admin/visits (admin panel — all visit requests, newest first) ──
  app.get('/api/admin/visits', requireAdmin, async (req, res) => {
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
  app.patch('/api/admin/visits/:id/status', requireAdmin, async (req, res) => {
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
  app.get('/api/users', requireAdmin, async (req, res) => {
    try {
      const users = await User.find({}).sort({ createdAt: -1 }).lean();
      const userIds = users.map(u => u._id);

      const [propAggByModel, visitAgg] = await Promise.all([
        Promise.all(LISTING_MODEL_LIST.map(M => M.aggregate([
          { $match: { userId: { $in: userIds } } },
          { $group: { _id: '$userId', count: { $sum: 1 } } }
        ]))),
        VisitRequest.aggregate([
          { $match: { userId: { $in: userIds } } },
          { $group: { _id: '$userId', count: { $sum: 1 } } }
        ])
      ]);

      // Sum counts per user across the four collections (a user's listings can
      // be split between rent/lease/pg/hourlyStay).
      const propMap = {};
      for (const agg of propAggByModel) {
        for (const x of agg) {
          const key = String(x._id);
          propMap[key] = (propMap[key] || 0) + x.count;
        }
      }
      const visitMap = Object.fromEntries(visitAgg.map(x => [String(x._id), x.count]));

      const rows = users.map(u => ({
        _id:           u._id,
        userId:        u.userId || '',
        name:          u.name || '',
        firstName:     u.firstName || '',
        lastName:      u.lastName || '',
        mobile:        u.mobile || '',
        email:         u.email  || '',
        password:      u.password || '',
        profilePhoto:  u.profilePhoto || '',
        remarks:       u.remarks || [],
        listingsCount: propMap[String(u._id)]  || 0,
        visitsCount:   visitMap[String(u._id)] || 0,
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

  app.delete('/api/users/mobile/:mobile', requireAdmin, async (req, res) => {
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
  app.post('/api/users/bulk-delete', requireAdmin, async (req, res) => {
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

  app.patch('/api/users/mobile/:mobile/remarks', requireAdmin, async (req, res) => {
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

  app.delete('/api/users/mobile/:mobile/remarks/:idx', requireAdmin, async (req, res) => {
    try {
      const idx  = Number(req.params.idx);
      const user = await findUserByMobileOrId(req.params.mobile);
      if (!user) return res.status(404).json({ message: 'Customer not found' });
      if (!Number.isInteger(idx) || idx < 0 || idx >= user.remarks.length)
        return res.status(400).json({ message: 'Invalid remark index' });
      user.remarks.splice(idx, 1);
      await user.save();
      res.json({ message: 'Remark deleted', remarks: user.remarks });
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

  app.get('/api/appointments', requireAdmin, async (req, res) => {
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

  app.patch('/api/appointments/:id', requireAdmin, async (req, res) => {
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

  app.patch('/api/appointments/:id/remarks', requireAdmin, async (req, res) => {
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

  app.delete('/api/appointments/:id/remarks/:idx', requireAdmin, async (req, res) => {
    try {
      const idx   = Number(req.params.idx);
      const visit = await VisitRequest.findById(req.params.id);
      if (!visit) return res.status(404).json({ message: 'Appointment not found' });
      if (!Number.isInteger(idx) || idx < 0 || idx >= visit.remarks.length)
        return res.status(400).json({ message: 'Invalid remark index' });
      visit.remarks.splice(idx, 1);
      await visit.save();
      res.json({ message: 'Remark deleted', remarks: visit.remarks });
    } catch (err) {
      console.error('DELETE /api/appointments/:id/remarks/:idx error:', err);
      res.status(500).json({ message: 'Error deleting remark' });
    }
  });

  app.delete('/api/appointments/:id', requireAdmin, async (req, res) => {
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
  app.post('/api/appointments/bulk-delete', requireAdmin, async (req, res) => {
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
  app.get('/api/admin/properties', requireAdmin, async (req, res) => {
    try {
      const docArrays = await Promise.all(LISTING_MODEL_LIST.map(M => M.find({}).populate('userId', 'profilePhoto').lean()));
      const docs = docArrays.flat().sort((a, b) =>
        (Number(b.promoted) - Number(a.promoted)) ||
        ((a.promotedPriority ?? 3) - (b.promotedPriority ?? 3)) ||
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
  app.patch('/api/properties/:id/remarks', requireAdmin, async (req, res) => {
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

  // ── DELETE /api/properties/:id/remarks/:idx (admin: remove a remark) ──
  app.delete('/api/properties/:id/remarks/:idx', requireAdmin, async (req, res) => {
    try {
      const idx = Number(req.params.idx);
      const { doc: prop } = await findListingById(req.params.id);
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      if (idx < 0 || idx >= prop.remarks.length) {
        return res.status(400).json({ message: 'Invalid remark index' });
      }
      prop.remarks.splice(idx, 1);
      await prop.save();
      res.json({ message: 'Remark deleted', remarks: prop.remarks });
    } catch (err) {
      console.error('DELETE /api/properties/:id/remarks/:idx error:', err);
      res.status(500).json({ message: 'Error deleting remark' });
    }
  });

  // ── PATCH /api/properties/:id/verified (admin: toggle verified flag) ──
  app.patch('/api/properties/:id/verified', requireAdmin, async (req, res) => {
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
  app.patch('/api/properties/:id/promoted', requireAdmin, async (req, res) => {
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
  app.patch('/api/properties/:id/promoted-priority', requireAdmin, async (req, res) => {
    try {
      const { promotedPriority } = req.body || {};
      if (typeof promotedPriority !== 'number' || !Number.isFinite(promotedPriority) ||
          !Number.isInteger(promotedPriority) || promotedPriority < 1) {
        return res.status(400).json({ message: 'promotedPriority must be a positive whole number (1 = first place)' });
      }
      const prop = await updateListingById(req.params.id, { promotedPriority }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Promoted position updated', promotedPriority: prop.promotedPriority });
    } catch (err) {
      console.error('PATCH /api/properties/:id/promoted-priority error:', err);
      res.status(500).json({ message: 'Error updating promoted position' });
    }
  });

  // ── PATCH /api/properties/:id/booked (admin: toggle booked flag) ──
  // Once true, the listing is excluded from GET /api/properties (see the
  // `booked: { $ne: true }` filter there) and disappears from the public site,
  // regardless of its verified status.
  app.patch('/api/properties/:id/booked', requireAdmin, async (req, res) => {
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

  // ── PATCH /api/properties/:id/views/reset (admin: reset one listing's view count to 0) ──
  app.patch('/api/properties/:id/views/reset', requireAdmin, async (req, res) => {
    try {
      const prop = await updateListingById(req.params.id, { views: 0 }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Views reset', views: prop.views });
    } catch (err) {
      console.error('PATCH /api/properties/:id/views/reset error:', err);
      res.status(500).json({ message: 'Error resetting views' });
    }
  });

  // ── POST /api/properties/views/reset-all (admin: reset every listing's view count to 0) ──
  app.post('/api/properties/views/reset-all', requireAdmin, async (req, res) => {
    try {
      const results = await Promise.all(LISTING_MODEL_LIST.map(M => M.updateMany({}, { $set: { views: 0 } })));
      const modifiedCount = results.reduce((sum, r) => sum + (r.modifiedCount || 0), 0);
      res.json({ message: 'All views reset', modifiedCount });
    } catch (err) {
      console.error('POST /api/properties/views/reset-all error:', err);
      res.status(500).json({ message: 'Error resetting all views' });
    }
  });

  // ── DELETE /api/properties/:id (example admin-protected route) ──
  app.delete('/api/properties/:id', requireAdmin, async (req, res) => {
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
  app.patch('/api/properties/:id/booking-details', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const asId = (v) => (v && mongoose.Types.ObjectId.isValid(v)) ? v : null;
      const ownerId  = asId(body.ownerId);
      const tenantId = asId(body.tenantId);
      const bookingDetails = {
        ownerId,
        ownerName:   (body.ownerName   || '').toString().trim(),
        ownerPhone:  (body.ownerPhone  || '').toString().trim(),
        ownerEmail:  (body.ownerEmail  || '').toString().trim(),
        tenantId,
        tenantName:  (body.tenantName  || '').toString().trim(),
        tenantPhone: (body.tenantPhone || '').toString().trim(),
        tenantEmail: (body.tenantEmail || '').toString().trim(),
        bookedOn:    (body.bookedOn    || '').toString().trim(), // 'YYYY-MM-DD'
        description: (body.description || '').toString().trim(),
      };

      // All fields are required — mirrors the admin.html modal's own validation,
      // enforced again here since the API can be called directly.
      const phoneOk = (v) => /^\d{10}$/.test(v);
      const emailOk = (v) => /^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[^\s@"'<>\\]+$/.test(v);
      if (
        !bookingDetails.bookedOn || !ownerId || !tenantId || !bookingDetails.description ||
        !bookingDetails.ownerName  || !phoneOk(bookingDetails.ownerPhone)  || !emailOk(bookingDetails.ownerEmail) ||
        !bookingDetails.tenantName || !phoneOk(bookingDetails.tenantPhone) || !emailOk(bookingDetails.tenantEmail)
      ) {
        return res.status(400).json({ message: 'All booking detail fields are required — please fill in owner, tenant, and booked-on date.' });
      }

      const prop = await updateListingById(req.params.id, { bookingDetails }, { new: true });
      if (!prop) return res.status(404).json({ message: 'Property not found' });
      res.json({ message: 'Booking details saved', bookingDetails: prop.bookingDetails });
    } catch (err) {
      console.error('PATCH /api/properties/:id/booking-details error:', err);
      res.status(500).json({ message: 'Error saving booking details' });
    }
  });

  // ── POST /api/properties/bulk-delete (admin: delete many properties at once) ──
  app.post('/api/properties/bulk-delete', requireAdmin, async (req, res) => {
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
  app.post('/api/admin/properties', requireAdmin, async (req, res) => {
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
  app.put('/api/admin/properties/:id', requireAdmin, async (req, res) => {
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
  app.get('/api/honest-reviews/all', requireAdmin, async (req, res) => {
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
  app.post('/api/honest-reviews', requireAdmin, async (req, res) => {
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
  app.put('/api/honest-reviews/:id', requireAdmin, async (req, res) => {
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
  app.delete('/api/honest-reviews/:id', requireAdmin, async (req, res) => {
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
  app.post('/api/honest-reviews/bulk-delete', requireAdmin, async (req, res) => {
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

  // GET /api/admin/partners — admin-only, returns every entry (active or not) for the manage UI.
  app.get('/api/admin/partners', requireAdmin, async (req, res) => {
    try {
      const partners = await Partner.find({}).sort({ order: 1, createdAt: 1 }).lean();
      res.json({ partners });
    } catch (err) {
      console.error('GET /api/admin/partners error:', err.message);
      res.status(500).json({ error: 'Could not load partners' });
    }
  });

  // POST /api/partners — admin-only, add a new partner
  app.post('/api/partners', requireAdmin, async (req, res) => {
    try {
      const { name, role, phone, email, location, avatarText, order, active } = req.body;
      if (!name || !role) {
        return res.status(400).json({ error: 'name and role are required' });
      }
      const partner = await Partner.create({
        name, role,
        phone: phone || '',
        email: email || '',
        location: location || '',
        avatarText: avatarText || '',
        order: Number(order) || 0,
        active: active !== false
      });
      res.status(201).json({ partner });
    } catch (err) {
      console.error('POST /api/partners error:', err.message);
      res.status(500).json({ error: 'Could not save partner' });
    }
  });

  // PUT /api/partners/:id — admin-only, edit an existing partner
  app.put('/api/partners/:id', requireAdmin, async (req, res) => {
    try {
      const fields = (({ name, role, phone, email, location, avatarText, order, active }) => ({ name, role, phone, email, location, avatarText, order, active }))(req.body);
      Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

      const partner = await Partner.findByIdAndUpdate(req.params.id, fields, { new: true }).lean();
      if (!partner) return res.status(404).json({ error: 'Partner not found' });
      res.json({ partner });
    } catch (err) {
      console.error('PUT /api/partners/:id error:', err.message);
      res.status(500).json({ error: 'Could not update partner' });
    }
  });

  // DELETE /api/partners/:id — admin-only
  app.delete('/api/partners/:id', requireAdmin, async (req, res) => {
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
  app.post('/api/partners/bulk-delete', requireAdmin, async (req, res) => {
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
  app.put('/api/admin/payment-settings', requireAdmin, async (req, res) => {
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
  app.get('/api/admin/payments', requireAdmin, async (req, res) => {
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
  app.patch('/api/admin/payments/:id/verify', requireAdmin, async (req, res) => {
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

  app.patch('/api/admin/payments/:id/reject', requireAdmin, async (req, res) => {
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

  // GET /api/admin/total-visits — admin-only, all-time visit counter for its own tab.
  app.get('/api/admin/total-visits', requireAdmin, async (req, res) => {
    try {
      const doc = await SiteStat.findOne({ key: 'totalVisits' }).lean();
      res.json({ totalVisits: doc ? doc.value : 0 });
    } catch (err) {
      console.error('GET /api/admin/total-visits error:', err.message);
      res.status(500).json({ message: 'Error fetching total visits' });
    }
  });

  // POST /api/admin/total-visits/reset — reset the all-time counter to 0.
  app.post('/api/admin/total-visits/reset', requireAdmin, async (req, res) => {
    try {
      const doc = await SiteStat.findOneAndUpdate(
        { key: 'totalVisits' },
        { $set: { value: 0 } },
        { upsert: true, new: true }
      );
      res.json({ message: 'Total visits reset', totalVisits: doc.value });
    } catch (err) {
      console.error('POST /api/admin/total-visits/reset error:', err.message);
      res.status(500).json({ message: 'Error resetting total visits' });
    }
  });

  // GET /api/admin/total-users — admin-only, all-time count of registered user accounts
  // (actual User collection count, distinct from the daily-registration log below).
  app.get('/api/admin/total-users', requireAdmin, async (req, res) => {
    try {
      const totalUsers = await User.countDocuments();
      res.json({ totalUsers });
    } catch (err) {
      console.error('GET /api/admin/total-users error:', err.message);
      res.status(500).json({ message: 'Error fetching total users' });
    }
  });

  // ── ADMIN: Daily Visits / Users Registered tabs ──
  // :type is 'visit' (Daily Visits tab) or 'registration' (Users Registered tab).
  const DAILY_STAT_TYPES = ['visit', 'registration'];

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
  app.get('/api/admin/daily-stats/:type', requireAdmin, async (req, res) => {
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
  app.patch('/api/admin/daily-stats/:type/:date/clear', requireAdmin, async (req, res) => {
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
  app.delete('/api/admin/daily-stats/:type/:date', requireAdmin, async (req, res) => {
    try {
      if (!checkDailyStatType(req, res)) return;
      await DailyStat.deleteOne({ type: req.params.type, date: req.params.date });
      res.json({ message: 'Record deleted' });
    } catch (err) {
      console.error('DELETE /api/admin/daily-stats/:type/:date error:', err.message);
      res.status(500).json({ message: 'Error deleting record' });
    }
  });

  // POST /api/admin/daily-stats/:type/clear-all — reset every day's count to 0, keep the rows.
  app.post('/api/admin/daily-stats/:type/clear-all', requireAdmin, async (req, res) => {
    try {
      if (!checkDailyStatType(req, res)) return;
      await DailyStat.updateMany({ type: req.params.type }, { $set: { count: 0 } });
      res.json({ message: 'All counts cleared' });
    } catch (err) {
      console.error('POST /api/admin/daily-stats/:type/clear-all error:', err.message);
      res.status(500).json({ message: 'Error clearing counts' });
    }
  });

  // POST /api/admin/daily-stats/:type/delete-all — remove every tracked day for this type.
  app.post('/api/admin/daily-stats/:type/delete-all', requireAdmin, async (req, res) => {
    try {
      if (!checkDailyStatType(req, res)) return;
      await DailyStat.deleteMany({ type: req.params.type });
      res.json({ message: 'All records deleted' });
    } catch (err) {
      console.error('POST /api/admin/daily-stats/:type/delete-all error:', err.message);
      res.status(500).json({ message: 'Error deleting records' });
    }
  });
};