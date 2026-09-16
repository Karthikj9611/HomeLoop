// ─── Festive wish image preload (originally in <head>, deferred to idle time) ───
// Preload today's festive wish image (if any) — but only as a low-priority,
// idle-time nicety. This used to inject the <link rel="preload"> immediately
// during HTML parsing, before anything else on the page, and the browser
// treats preload as a high-priority fetch — on a slow/mobile connection that
// meant this (often multi-hundred-KB) image was competing for bandwidth and
// connection slots with the actual property listings fetch, delaying the
// page's real content for a festive-banner nicety. Deferred to
// requestIdleCallback (i.e. only once the browser has nothing more important
// to do) and marked fetchPriority='low' so it never gets in front of
// anything the visitor is actually here for.
(function(){
  var WISH_PRELOAD = [
    { startDate:'2026-08-20', endDate:'2026-08-21', image:'/wishes/varalakshmi-vratam-2026.webp' },
    { startDate:'2026-09-13', endDate:'2026-09-14', image:'/wishes/ganesh-chaturthi-2026.webp' }
  ];
  function todayStr(){ var d=new Date(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0'); return d.getFullYear()+'-'+m+'-'+day; }
  function doPreload(){
    var today = todayStr();
    for (var i=0;i<WISH_PRELOAD.length;i++){
      var w = WISH_PRELOAD[i];
      if (today >= w.startDate && today <= w.endDate){
        var link = document.createElement('link');
        link.rel = 'preload'; link.as = 'image'; link.href = w.image;
        link.setAttribute('fetchpriority', 'low');
        document.head.appendChild(link);
        break;
      }
    }
  }
  if ('requestIdleCallback' in window) requestIdleCallback(doPreload, { timeout: 3000 });
  else setTimeout(doPreload, 1500);
})();

// ─── Main application logic ───
/* ═══════════════════════════════════════════════
   FEATURE FLAGS
═══════════════════════════════════════════════ */
// "Pay online" (brokerage) buttons in the Charges modal — tenant & owner views.
// Off for now; flip to true to re-enable when online payment collection goes live.
const FEATURE_PAY_ONLINE = false;
if (!FEATURE_PAY_ONLINE) {
  document.querySelectorAll('.pay-online-btn').forEach(btn => btn.style.display = 'none');
}

/* ═══════════════════════════════════════════════
   SECURITY HELPERS — escape any user-submitted text
   before it touches innerHTML, and allowlist URL
   schemes before any value is used as an href/src.
   Apply esc() to every piece of listing/owner/user
   text rendered via innerHTML; apply safeUrl() to
   every mapLink/video/image URL before using it as
   an href or src.
═══════════════════════════════════════════════ */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
// Escapes text but preserves line breaks as <br> (for free-text fields like description).
function escMultiline(v) {
  return esc(v).replace(/\n/g, '<br>');
}
// For location text like "HSR Layout, 6th Block" — the part before the first
// comma, used on mobile property cards where width is tight and the full
// "Area, Sub-area" string wraps or gets ellipsis-truncated mid-word.
function locShort(v) {
  return String(v || '').split(',')[0].trim();
}
// Only allows http/https URLs through to an href/src; anything else (javascript:, data:, etc.) is dropped.
function safeUrl(v) {
  if (!v) return '';
  const s = String(v).trim();
  try {
    const u = new URL(s, window.location.origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {}
  return '';
}

/* Recognize YouTube / Vimeo / direct video-file links so the property view
   can embed a real player instead of just linking out. Returns null for
   anything else (custom tour hosts, etc.) so the caller can fall back to
   a plain "open link" row. */
function getVideoEmbedInfo(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  // YouTube/Vimeo IDs are always plain alphanumeric (plus -/_ for YouTube).
  // Anything else means the "id" isn't really one — could be a crafted
  // ?v= value smuggling markup through (URLSearchParams decodes percent-
  // encoding, so raw quotes/angle-brackets survive into the extracted
  // value) — so treat it as unrecognized rather than embed it.
  const validId = (id, re) => (id && re.test(id)) ? id : null;
  const YT_ID = /^[\w-]{1,64}$/;
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = validId(u.pathname.slice(1).split('/')[0], YT_ID);
    if (id) return { type: 'youtube', id };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (u.pathname === '/watch') {
      const id = validId(u.searchParams.get('v'), YT_ID);
      if (id) return { type: 'youtube', id };
    }
    const m = u.pathname.match(/^\/(embed|shorts)\/([^/?]+)/);
    if (m) {
      const id = validId(m[2], YT_ID);
      if (id) return { type: 'youtube', id };
    }
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(\d+)/);
    if (m) return { type: 'vimeo', id: m[1] };
  }
  if (/\.(mp4|webm|ogg|mov)$/i.test(u.pathname)) {
    return { type: 'file', src: url };
  }
  return null;
}

// Builds a playable embed for the property-view video field; returns '' when
// the URL isn't a recognizable embeddable format (caller keeps the link row).
function buildVideoEmbed(url) {
  const info = getVideoEmbedInfo(url);
  if (!info) return '';
  if (info.type === 'youtube') {
    return `<iframe src="https://www.youtube-nocookie.com/embed/${info.id}" title="Video tour" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
  }
  if (info.type === 'vimeo') {
    return `<iframe src="https://player.vimeo.com/video/${info.id}" title="Video tour" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  }
  if (info.type === 'file') {
    return `<video controls preload="metadata" src="${safeUrl(info.src)}"></video>`;
  }
  return '';
}

/* ═══════════════════════════════════════════════
   DATA
═══════════════════════════════════════════════ */
let PROPERTIES = [];
// Booked listings are excluded from PROPERTIES by the server (see
// GET /api/properties) so they never show up mixed into the live grid. They're
// fetched separately into this array purely to populate the read-only "Booked"
// section under Promoted/Rent/Lease/PG — see fetchBookedProperties() /
// renderBookedSections() further down.
let BOOKED_PROPERTIES = [];
// Recently Viewed renders its cards through the same styling as PROPERTIES
// (via cardHTML), so it must not render until the initial fetch has actually
// resolved — otherwise it briefly falls back to the plain snapshot-card style
// for every entry (PROPERTIES is still empty), then flashes to the real card
// look once data arrives. Set true (success or failure) at the end of the
// first fetchProperties() call.
let _initialPropertiesFetchDone = false;


/* ─── Device signature ───────────────────────────
   A best-effort, non-cookie identifier for "this physical device/browser
   install", built from things that stay stable across incognito windows and
   network changes (screen size, timezone, language, platform, pixel ratio)
   but do NOT stay stable across different devices. Sent as `deviceSig` on
   requests the backend dedups by fingerprint (see visitorFingerprint() in
   server.js) — /api/stats/visit and /api/properties/:id/view — so the same
   phone/laptop isn't recounted just because it opened an incognito window or
   switched from wifi to mobile data. Falls back to IP+UA server-side if this
   ever throws (very old browsers, JS restrictions) or returns empty. */
function buildDeviceSignature() {
  try {
    const parts = [
      screen.width, screen.height, screen.colorDepth,
      window.devicePixelRatio || 1,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      navigator.language || '',
      (navigator.languages || []).join(','),
      navigator.platform || '',
      navigator.hardwareConcurrency || '',
      navigator.maxTouchPoints || 0,
    ];
    return parts.join('|');
  } catch (e) {
    return ''; // server falls back to IP+UA when this is empty
  }
}

/* ─── View counts (DB-backed) ───────────────────
   The real count lives on the property document (Property.views) so admin's
   reset actions are reflected for every visitor, not just the browser that
   triggered them. Each browser still keeps a local "seen" set (localStorage)
   purely to avoid double-counting the same listing on repeat opens/refreshes
   — it is NOT where the number itself is stored anymore. */
const VIEWS_SEEN_KEY = 'homeloop_property_views_seen_v2'; // _v2: bumped so ids marked "seen" under the old, purely-local counter (pre-DB-backed views) don't block real increments now
let viewedSeen = new Set();
(function loadViewedSeen() {
  try {
    viewedSeen = new Set(JSON.parse(localStorage.getItem(VIEWS_SEEN_KEY)) || []);
  } catch (e) {
    viewedSeen = new Set();
  }
})();
function saveViewedSeen() {
  try {
    localStorage.setItem(VIEWS_SEEN_KEY, JSON.stringify([...viewedSeen]));
  } catch (e) { /* storage unavailable — dedupe still works for this session */ }
}
function getViews(p) {
  return (p && p.views) || 0;
}
function incrementViews(p) {
  const key = String(p.id);
  if (viewedSeen.has(key)) return getViews(p); // already counted for this browser — reopening or refreshing shouldn't bump it again
  viewedSeen.add(key);
  saveViewedSeen();
  // Optimistically bump the in-memory count so the card/detail view updates
  // immediately, then confirm with the server (source of truth). If the
  // request fails, the next fetchProperties() reload will self-correct.
  p.views = getViews(p) + 1;
  fetch(`/api/properties/${p.id}/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceSig: buildDeviceSignature() }),
  })
    .then(res => res.ok ? res.json() : null)
    .then(data => { if (data && typeof data.views === 'number') p.views = data.views; })
    .catch(() => { /* view count will reconcile on next full reload */ });
  return p.views;
}
function formatViews(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}


/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
let currentTab = 'Rent'; // default tab shown on load
const SHOW_VERIFIED_BADGE = false; // verified badge hidden on cards for now — flip to true to bring it back
let currentSort = 'newest';
let userCoords = null;      // {lat, lng} once geolocation succeeds, used for "Near me first" sort
let nearbyAreaName = '';    // reverse-geocoded locality name — secondary fallback for
                             // listings that have no lat/lng saved, and the banner text
let nearbyPincode = '';     // reverse-geocoded postcode — primary fallback match for
                             // listings that have no lat/lng saved (stronger signal than area text)
let sortSetByUser = false;  // true once the visitor manually opens Sort and picks an option
const SHORTLIST_KEY = 'homeloop_shortlisted_properties';
const SHORTLIST_DATA_KEY = 'homeloop_shortlisted_properties_data';
function loadShortlist() {
  try {
    const arr = JSON.parse(localStorage.getItem(SHORTLIST_KEY));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}
function saveShortlist() {
  try {
    localStorage.setItem(SHORTLIST_KEY, JSON.stringify([...shortlisted]));
  } catch (e) { /* storage unavailable — shortlist still works for this session */ }
}
function loadShortlistData() {
  try {
    const obj = JSON.parse(localStorage.getItem(SHORTLIST_DATA_KEY));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}
function saveShortlistData() {
  try {
    localStorage.setItem(SHORTLIST_DATA_KEY, JSON.stringify(shortlistedData));
  } catch (e) { /* storage unavailable — shortlist still works for this session */ }
}
let shortlisted = loadShortlist();
let shortlistedData = loadShortlistData();

/* ─── Recently Viewed ─── */
const RECENTLY_VIEWED_KEY = 'homeloop_recently_viewed';
const RECENTLY_VIEWED_DATA_KEY = 'homeloop_recently_viewed_data';
const RECENTLY_VIEWED_MAX = 12;
function loadRecentlyViewed() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENTLY_VIEWED_KEY));
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (e) {
    return [];
  }
}
function saveRecentlyViewed() {
  try {
    localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(recentlyViewed));
  } catch (e) { console.warn('Could not save recently-viewed list:', e); }
}
function loadRecentlyViewedData() {
  try {
    const obj = JSON.parse(localStorage.getItem(RECENTLY_VIEWED_DATA_KEY));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}
function saveRecentlyViewedData() {
  try {
    localStorage.setItem(RECENTLY_VIEWED_DATA_KEY, JSON.stringify(recentlyViewedData));
  } catch (e) { console.warn('Could not save recently-viewed data:', e); }
}
let recentlyViewed = loadRecentlyViewed();
let recentlyViewedData = loadRecentlyViewedData();

/* Build a small thumbnail-only snapshot rather than persisting the entire
   property object — keeps storage tiny and avoids quota failures that were
   silently dropping entries on refresh. */
function recentlyViewedSnapshot(p) {
  return {
    id: String(p.id),
    name: p.propertyId || 'Untitled listing',
    area: p.location?.area || '',
    rent: p.price?.rent ?? null,
    img: (p.media?.images || [])[0] || null,
    type: pTypeLabel(p)
  };
}

/* Record a property as viewed: move/insert it at the front, snapshot its
   data, and cap the list length. Called from openDetail(). */
function recordRecentlyViewed(p) {
  const id = String(p.id);
  recentlyViewed = recentlyViewed.filter(x => x !== id);
  recentlyViewed.unshift(id);
  if (recentlyViewed.length > RECENTLY_VIEWED_MAX) {
    const dropped = recentlyViewed.splice(RECENTLY_VIEWED_MAX);
    dropped.forEach(dId => { delete recentlyViewedData[dId]; });
  }
  recentlyViewedData[id] = recentlyViewedSnapshot(p);
  saveRecentlyViewed();
  saveRecentlyViewedData();
  renderRecentlyViewed();
}

function removeRecentlyViewed(id) {
  id = String(id);
  recentlyViewed = recentlyViewed.filter(x => x !== id);
  delete recentlyViewedData[id];
  saveRecentlyViewed();
  saveRecentlyViewedData();
  renderRecentlyViewed();
}

function clearRecentlyViewed() {
  recentlyViewed = [];
  recentlyViewedData = {};
  saveRecentlyViewed();
  saveRecentlyViewedData();
  renderRecentlyViewed();
}

function recentlyViewedCardHTML(rv) {
  // When the property is still live, render it with the exact same card
  // used by the main grid/shortlist (image ribbon, badges, stats, chips) so
  // recently-viewed matches everywhere else. No per-card remove button —
  // removal is handled by the section's "Clear all" only.
  // Booked listings never reach this point (renderRecentlyViewed's filter
  // drops any id present in BOOKED_PROPERTIES before calling here), so this
  // only ever needs to check PROPERTIES.
  const live = PROPERTIES.find(x => x.id === rv.id);
  if (live) {
    return cardHTML(live, false);
  }
  // Fallback for stale/deleted entries no longer in PROPERTIES — only the
  // small saved snapshot is available, so use the lightweight thumb card.
  const thumb = rv.img ? `style="background-image:url('${safeUrl(rv.img)}')"` : '';
  const rent = rv.rent != null ? fmtRupee(rv.rent) : '—';
  return `<div class="rv-card" onclick="openDetail('${rv.id}')">
    <div class="rv-card-thumb" ${thumb}>${rv.img ? '' : 'No photo'}</div>
    <div class="rv-card-body">
      <div class="rv-card-title">${esc(rv.name)}</div>
      <div class="rv-card-sub">${esc(rv.area)}</div>
      <div class="rv-card-price">${rent}<span style="color:var(--text-3);font-weight:500">/ Month</span></div>
    </div>
  </div>`;
}

function renderRecentlyViewed() {
  const section = document.getElementById('recentlyViewedSection');
  if (!section) return;
  // Don't render until the initial properties fetch has resolved — otherwise
  // every entry falls back to the plain snapshot-card style (PROPERTIES is
  // still empty) and then flashes to the real card look once data arrives.
  // Just stay hidden for this one extra beat instead.
  if (!_initialPropertiesFetchDone) { section.style.display = 'none'; return; }
  // Not needed on the Explore/All tab — that view already shows everything,
  // so a "recently viewed" strip on top of it is redundant.
  if (currentTab === 'All') { section.style.display = 'none'; return; }
  const strip = document.getElementById('recentlyViewedStrip');
  // One-time migration: entries saved before "name" stored the Property ID
  // (or rendered while PROPERTIES hadn't loaded yet) get corrected in place
  // the first time live property data is available, so the fix sticks.
  let healed = false;
  recentlyViewed.forEach(id => {
    const rv = recentlyViewedData[id];
    if (!rv) return;
    const live = PROPERTIES.find(x => x.id === id);
    if (live?.propertyId && rv.name !== live.propertyId) {
      rv.name = live.propertyId;
      healed = true;
    }
  });
  if (healed) saveRecentlyViewedData();
  const ids = recentlyViewed.filter(id => {
    const rv = recentlyViewedData[id];
    if (!rv) return false;
    // A property viewed while live can later be marked Booked — booked
    // listings shouldn't appear in Recently Viewed at all, so drop it here
    // too (not just at record time in openDetail) once it shows up in
    // BOOKED_PROPERTIES, rather than falling back to a booked-listing card.
    if (BOOKED_PROPERTIES.some(x => x.id === id)) return false;
    if (currentTab === 'Promoted' || currentTab === 'Verified') {
      const live = PROPERTIES.find(x => x.id === id);
      return live ? matchesTab(live, currentTab) : false;
    }
    // Older entries saved before "type" was tracked fall back to a live
    // lookup so they don't just vanish under a specific tab.
    const type = rv.type || pTypeLabel(PROPERTIES.find(x => x.id === id) || {});
    return type === currentTab;
  });
  if (ids.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  strip.innerHTML = ids.map(id => recentlyViewedCardHTML(recentlyViewedData[id])).join('');
  observeCardImgs(strip);
  requestAnimationFrame(syncRecentlyViewedCardWidth);
}
// Keeps Recently Viewed cards sized relative to the real property cards
// currently on screen (the property grid is fluid — auto-fill(minmax(260px,1fr))
// — so its rendered card width changes with viewport size), but deliberately
// smaller/more compact than the full grid card — this strip is a quick-glance
// revisit list, not a duplicate of the main grid. Reads one live .prop-card's
// actual width, scales it down, and pushes the result into a CSS var the
// rv-card flex-basis uses, so the horizontally-scrollable strip always stays
// proportionally smaller, on any screen size.
//
// On narrow (mobile) screens the strip instead sizes each card to a fraction
// of the visible strip width (minus the gap) so a full 3 (smaller) cards
// fit per screen, all details legible — while staying horizontally
// scrollable/slidable to reach the rest.
const RV_CARD_SCALE = 0.85;
// Mobile-only 3-up sizing, shared between the Viewed strip and every Booked
// strip: reads the container's own width/gap/padding and fits 3 cards. Each
// container gets the var set on itself (not inherited from Viewed) since
// Booked grids aren't descendants of #recentlyViewedStrip — but the same
// formula on containers with the same gap/padding yields the same width, so
// Viewed and Booked end up pixel-matched on mobile without being coupled.
function mobileStripCardWidth(el) {
  const cs = getComputedStyle(el);
  const gap = parseFloat(cs.columnGap || cs.gap) || 8;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const available = el.clientWidth - padL - padR - gap * 2;
  return available / 3;
}
function syncRecentlyViewedCardWidth() {
  const strip = document.getElementById('recentlyViewedStrip');
  const bookedGrids = document.querySelectorAll('[id$="BookedGrid"]');
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    if (strip) {
      const w = mobileStripCardWidth(strip);
      if (w > 0) strip.style.setProperty('--rv-card-w', w + 'px');
    }
    bookedGrids.forEach(grid => {
      const w = mobileStripCardWidth(grid);
      if (w > 0) grid.style.setProperty('--rv-card-w', w + 'px');
    });
    return;
  }
  // Desktop: scale relative to a real full-size grid card. Booked/Viewed
  // cards are excluded from the sample query — now that Booked is a strip
  // too, both are .prop-grid .prop-card same as a regular listing card, and
  // Booked's markup comes first in the DOM, so without the exclusion this
  // would sample an already-shrunk Booked card and compound the shrink on
  // every resize instead of always scaling off a true full-size reference.
  const sample = document.querySelector('.prop-grid:not([id$="BookedGrid"]) .prop-card');
  if (!sample) return;
  const w = sample.getBoundingClientRect().width * RV_CARD_SCALE;
  if (w <= 0) return;
  if (strip) strip.style.setProperty('--rv-card-w', w + 'px');
  bookedGrids.forEach(grid => grid.style.setProperty('--rv-card-w', w + 'px'));
}
window.addEventListener('resize', () => { clearTimeout(window._rvWidthTimer); window._rvWidthTimer = setTimeout(syncRecentlyViewedCardWidth, 150); });

let compareSet = new Set();
let compareDiffOnly = false;
function toggleCompareDiffOnly(){
  compareDiffOnly = !compareDiffOnly;
  const btn = document.getElementById('compareDiffToggle');
  if (btn) btn.classList.toggle('active', compareDiffOnly);
  renderCompareTable();
}
const COMPARE_MAX = 3;
let isListView = false;
let searchQuery = '';

/* ═══════════════════════════════════════════════
   RENDER
═══════════════════════════════════════════════ */
/* getFiltered() defined in FILTERS section below */

function injectPaginationDividers(arr) {
  let html = '';
  arr.forEach((p, i) => {
    html += cardHTML(p);
    if ((i + 1) % 4 === 0 && i !== arr.length - 1) {
      html += `<div style="grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--bg-2);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div style="flex:1;height:1px;background:var(--border)"></div>
        <span style="font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap">More listings below</span>
        <div style="flex:1;height:1px;background:var(--border)"></div>
      </div>`;
    }
  });
  return html;
}

let promotedPage = 0;
let rentPage = 0;
let leasePage = 0;
let pgPage = 0;
let shortstayPage = 0;
let sellPage = 0;
const PAGE_SIZE = 8;

// Which of the four on-page sections a (non-promoted) listing belongs in,
// mirroring the backend's rent/lease/pg collection split.
function sectionKeyFor(p) {
  const t = pTypeLabel(p);
  if (t === 'Lease') return 'lease';
  if (t === 'PG') return 'pg';
  if (t === 'ShortStay') return 'shortstay';
  if (t === 'Sell') return 'sell';
  return 'rent';
}

// Human-readable name for each tab, used by the empty state so the
// message actually names what's missing ("No PG listings yet") instead
// of a generic "No properties found" regardless of which tab you're on.
const TAB_EMPTY_LABEL = {
  Promoted: 'promoted listings',
  Rent: 'rental listings',
  Lease: 'lease listings',
  PG: 'PG listings',
  ShortStay: 'short stay listings',
  Sell: 'listings for sale',
  All: 'listings',
};

// Listings for the current tab, ignoring every filter/search — used to
// tell apart "nothing exists in this category at all" (filters can't
// help) from "filters narrowed an otherwise non-empty category down to
// zero" (clearing filters can help), so the empty state can say the
// right thing and only offer "Clear filters" when it would actually do
// something.
function tabRawCount(tab) {
  return PROPERTIES.filter(p => {
    if (!SHORT_STAY_ENABLED && pTypeLabel(p) === 'ShortStay') return false;
    if (!PG_ENABLED && pTypeLabel(p) === 'PG') return false;
    return matchesTab(p, tab);
  }).length;
}

function setEmptyStateContent() {
  const title = document.getElementById('emptyStateTitle');
  const text = document.getElementById('emptyStateText');
  const actions = document.getElementById('emptyStateActions');
  if (!title || !text || !actions) return;

  // The very first renderCards() call fires synchronously on page load,
  // before the async fetchProperties() request has come back — PROPERTIES
  // is still `[]` at that point, which would otherwise make this claim
  // "No listings yet" for a split second while data is still loading (and
  // clash visually with the grid's own "Finding your perfect home…"
  // placeholder). Show a neutral loading message instead until that first
  // fetch has actually completed.
  if (!_initialPropertiesFetchDone) {
    title.textContent = 'Loading listings…';
    text.textContent = 'Hang tight while we fetch the latest properties.';
    actions.style.display = 'none';
    return;
  }

  const label = TAB_EMPTY_LABEL[currentTab] || 'listings';
  if (tabRawCount(currentTab) === 0) {
    // Nothing in this category at all — filters are irrelevant here.
    title.textContent = `No ${label} yet`;
    text.textContent = currentTab === 'All'
      ? "There's nothing listed yet. Check back soon, or be the first to post one!"
      : `There are no ${label} on HomeLoop yet. Check back soon, or try another category.`;
    actions.style.display = 'none';
  } else {
    // Listings exist, but the current filters/search ruled all of them out.
    title.textContent = 'No properties found';
    text.textContent = "We couldn't find anything matching your filters. Try widening your search or clearing a few filters.";
    actions.style.display = '';
  }
}

function renderCards() {
  saveFilterState(); // keep localStorage in sync with live filter/tab state on every render
  const empty = document.getElementById('emptyState');
  const list = getFiltered();
  document.getElementById('resultCount').textContent = list.length;

  const SECTIONS = ['promoted', 'rent', 'lease', 'pg', 'shortstay', 'sell'];

  if (list.length === 0) {
    SECTIONS.forEach(key => {
      document.getElementById(key + 'Grid').innerHTML = '';
      document.getElementById(key + 'Divider').style.display = 'none';
    });
    setEmptyStateContent();
    empty.classList.add('show');
    return;
  }
  empty.classList.remove('show');

  // On the Promoted tab, `list` is already scoped to promoted items only,
  // so every card would land in both the "Promoted listings" highlight
  // bucket AND its own Rent/Lease/PG/Short Stay section — pure duplication.
  // Skip the highlight bucket there and let items fall through to their
  // normal type sections. On "All", `list` spans every type, so keeping
  // promoted items in both the highlights section and their type section
  // is intentional (that's what makes that view comprehensive).
  // Promoted listings always display in admin's Promoted Priority order
  // (lower number = shown first, same convention as the server-side sort),
  // regardless of whichever Sort option (newest/price/etc.) the visitor has
  // picked — priority is a paid placement, not just another sort choice.
  // 0/missing (not yet manually ranked by an admin) sorts to the back,
  // matching the server's rankOf() — a fresh promotion doesn't jump ahead
  // of listings an admin already ranked 1, 2, 3...
  const rankOf = (p) => (p && p > 0) ? p : Infinity;
  // Tie-break (both unranked, or same explicit priority) is newest-first —
  // matching the server's own tie-break (server.js rankOf + createdAt desc)
  // — rather than leaving it to fall through to Array.sort's stability and
  // inherit whatever order `list` happened to be in. `list` order depends on
  // currentSort (default 'newest' actually sorts oldest-first — see
  // propertyListedAt), so without this explicit tiebreak, an unranked
  // promoted listing's position silently depended on the visitor's Sort
  // choice — exactly what this comment above says it shouldn't.
  const byPromotedPriority = (a, b) =>
    (rankOf(a.promotedPriority) - rankOf(b.promotedPriority)) ||
    (propertyListedAt(b) - propertyListedAt(a));

  const promoted = currentTab === 'Promoted' ? [] : list.filter(p => p.promoted).sort(byPromotedPriority);
  // On a single-type tab (Rent/Lease/PG/ShortStay), `list` is already
  // scoped to just that type, so the "promoted" and typed buckets below
  // would otherwise be drawing from the exact same set — showing every
  // promoted item twice. Exclude that overlap only on those tabs; on
  // All, `list` spans multiple types and showing a promoted
  // property in both the highlights section and its type section is
  // intentional (that's what makes that view comprehensive).
  const dedupe = ['Rent', 'Lease', 'PG', 'ShortStay', 'Sell'].includes(currentTab);
  const groups = {
    promoted,
    rent:      list.filter(p => (!dedupe || !p.promoted) && sectionKeyFor(p) === 'rent'),
    lease:     list.filter(p => (!dedupe || !p.promoted) && sectionKeyFor(p) === 'lease'),
    pg:        list.filter(p => (!dedupe || !p.promoted) && sectionKeyFor(p) === 'pg'),
    shortstay: list.filter(p => (!dedupe || !p.promoted) && sectionKeyFor(p) === 'shortstay'),
    sell:      list.filter(p => (!dedupe || !p.promoted) && sectionKeyFor(p) === 'sell'),
  };
  // On the Promoted tab itself, `list` is already scoped to promoted items
  // only (see matchesTab), so every item in every one of these type groups
  // is a promoted listing — apply the same priority ordering there too,
  // instead of leaving them in Sort-dropdown order.
  if (currentTab === 'Promoted') {
    groups.rent.sort(byPromotedPriority);
    groups.lease.sort(byPromotedPriority);
    groups.pg.sort(byPromotedPriority);
    groups.shortstay.sort(byPromotedPriority);
    groups.sell.sort(byPromotedPriority);
  }

  const gridClass = 'prop-grid' + (isListView ? ' list-view' : '');
  const pageGetters = { promoted: () => promotedPage, rent: () => rentPage, lease: () => leasePage, pg: () => pgPage, shortstay: () => shortstayPage, sell: () => sellPage };
  const pageSetters = { promoted: v => promotedPage = v, rent: v => rentPage = v, lease: v => leasePage = v, pg: v => pgPage = v, shortstay: v => shortstayPage = v, sell: v => sellPage = v };
  // On the single-type tabs (Rent/Lease/PG/ShortStay) that section is the
  // only one populated, so pagination just adds noise — show every
  // matching listing on one page with no page controls. All/Promoted
  // still page normally since multiple sections stack together there.
  const noPagination = ['Rent', 'Lease', 'PG', 'ShortStay', 'Sell'].includes(currentTab);

  SECTIONS.forEach(key => {
    const items = groups[key];
    const grid = document.getElementById(key + 'Grid');
    const divider = document.getElementById(key + 'Divider');
    grid.className = gridClass;

    if (items.length === 0) {
      divider.style.display = 'none';
      grid.innerHTML = '';
      return;
    }

    divider.style.display = '';
    document.getElementById(key + 'Count').textContent = items.length;

    if (noPagination) {
      grid.innerHTML = items.map(p => cardHTML(p, key !== 'promoted')).join('');
      return;
    }

    let page = Math.min(pageGetters[key](), Math.floor((items.length - 1) / PAGE_SIZE));
    pageSetters[key](page);
    const slice = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    grid.innerHTML = slice.map(p => cardHTML(p, key !== 'promoted')).join('') +
      paginationHTML(key, page, items.length);
  });

  // Collapse each card's spec row down to what actually fits, now that
  // the fresh markup is in the DOM and real widths are known.
  syncChipRowFade();

  // Premium Services / Honest Reviews cards are fixed-width horizontal
  // scroll strips, but property cards are a fluid CSS Grid (auto-fill) —
  // their real rendered width changes with viewport size and column count
  // in a way no single formula captures. So instead of guessing a number,
  // measure an actual rendered .prop-card and mirror that width via a CSS
  // variable, keeping the two visually identical at any screen size.
  syncScrollCardWidth();

  renderBookedSections();
  observeCardImgs();
}

// Renders the read-only "Booked" bucket under Promoted/Rent/Lease/PG. Source
// data is BOOKED_PROPERTIES (fetched separately — see fetchBookedProperties()
// — since the main /api/properties response never includes booked listings).
// Each tab's bucket is scoped to match what that tab actually shows:
// Promoted's bucket is only booked listings that were promoted (p.promoted),
// same as Rent/Lease/PG each showing only their own type's booked listings.
// Ignores search/filter state — a booked listing has nothing left to filter
// on (price/BHK/etc. no longer matter once it's off the market) — and only
// one bucket is ever populated at a time, matching whichever tab is active.
function renderBookedSections() {
  const groups = { promoted: [], rent: [], lease: [], pg: [], sell: [] };
  if (currentTab === 'Promoted') {
    groups.promoted = BOOKED_PROPERTIES.filter(p => p.promoted);
  } else if (currentTab === 'Rent') {
    groups.rent = BOOKED_PROPERTIES.filter(p => sectionKeyFor(p) === 'rent');
  } else if (currentTab === 'Lease') {
    groups.lease = BOOKED_PROPERTIES.filter(p => sectionKeyFor(p) === 'lease');
  } else if (currentTab === 'PG') {
    groups.pg = BOOKED_PROPERTIES.filter(p => sectionKeyFor(p) === 'pg');
  } else if (currentTab === 'Sell') {
    groups.sell = BOOKED_PROPERTIES.filter(p => sectionKeyFor(p) === 'sell');
  }
  // Any other tab (e.g. "All"/Explore) leaves every bucket empty — that tab
  // hides the whole bookedSection wrapper anyway (see updateAllOnlySections()).

  const gridClass = 'prop-grid' + (isListView ? ' list-view' : '');

  ['promoted', 'rent', 'lease', 'pg', 'sell'].forEach(key => {
    const divider = document.getElementById(key + 'BookedDivider');
    const grid = document.getElementById(key + 'BookedGrid');
    if (!divider || !grid) return;

    const items = groups[key];
    if (items.length === 0) {
      divider.style.display = 'none';
      // Also hide the grid itself, not just clear it — as a flex strip (see
      // the [id$="BookedGrid"] mobile rules) it still has its own top
      // padding even with zero cards inside, so leaving it merely empty (as
      // opposed to a regular .prop-grid, which has no vertical padding of
      // its own and collapses to 0 height either way) added a stray ~10px
      // gap for every unused Booked bucket sitting between the one that's
      // actually showing and whatever section comes after it.
      grid.style.display = 'none';
      grid.innerHTML = '';
      return;
    }

    divider.style.display = '';
    grid.style.display = '';
    document.getElementById(key + 'BookedCount').textContent = items.length;
    grid.className = gridClass;
    grid.innerHTML = items.map(p => cardHTML(p, key !== 'promoted')).join('');
    observeCardImgs(grid);
  });
  // Booked grids are sized on mobile the same way the Viewed strip is (see
  // syncRecentlyViewedCardWidth) — needs a fresh run once cards are in the
  // DOM so clientWidth reflects the just-rendered content.
  requestAnimationFrame(syncRecentlyViewedCardWidth);
}

// Only the stat/amenity row's own JS knows whether it truly overflows its
// visible width, so the trailing "there's more to scroll" fade (.has-overflow
// in CSS) is toggled here rather than being an unconditional CSS rule —
// otherwise a row where every stat already fit still had its last item's
// tail faded away (e.g. "3333 sqft" reading as "3333 sq").
function syncChipRowFade() {
  document.querySelectorAll('.prop-chip-row-scroll, .price-chips-scroll').forEach(row => {
    row.classList.toggle('has-overflow', row.scrollWidth > row.clientWidth + 2);
  });
}
let _chipRowFadeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_chipRowFadeTimer);
  _chipRowFadeTimer = setTimeout(syncChipRowFade, 150);
});

function syncScrollCardWidth() {
  const propCard = document.querySelector('.prop-card');
  if (!propCard) return;
  const rect = propCard.getBoundingClientRect();
  if (rect.width > 0) {
    document.documentElement.style.setProperty('--matched-card-w', rect.width + 'px');
  }
  if (rect.height > 0) {
    document.documentElement.style.setProperty('--matched-card-h', rect.height + 'px');
  }
}
// Re-measure on resize (debounced) so rotating a phone or resizing a
// desktop window keeps the Premium Services / Honest Reviews card width
// in sync with whatever width property cards are actually rendering at.
let _syncCardWidthTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_syncCardWidthTimer);
  _syncCardWidthTimer = setTimeout(syncScrollCardWidth, 150);
});

function paginationHTML(section, page, total) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) return '';
  return `
    <div class="pagination-bar">
      <div class="pagination-controls">
        <button class="page-btn" onclick="changePage('${section}',-1)" ${page===0?'disabled':''}>Prev</button>
        <span class="pagination-info">Page ${page + 1} of ${totalPages}</span>
        <button class="page-btn" onclick="changePage('${section}',1)" ${page>=totalPages-1?'disabled':''}>Next</button>
      </div>
    </div>`;
}

function sectionItems(section) {
  const list = getFiltered();
  if (section === 'promoted') return list.filter(p => p.promoted);
  const dedupe = ['Rent', 'Lease', 'PG', 'ShortStay', 'Sell'].includes(currentTab);
  return list.filter(p => (!dedupe || !p.promoted) && sectionKeyFor(p) === section);
}

const SECTION_PAGE_GETTERS = { promoted: () => promotedPage, rent: () => rentPage, lease: () => leasePage, pg: () => pgPage, shortstay: () => shortstayPage, sell: () => sellPage };
const SECTION_PAGE_SETTERS = { promoted: v => promotedPage = v, rent: v => rentPage = v, lease: v => leasePage = v, pg: v => pgPage = v, shortstay: v => shortstayPage = v, sell: v => sellPage = v };

function changePage(section, dir) {
  const items = sectionItems(section);
  const max = Math.ceil(items.length / PAGE_SIZE) - 1;
  SECTION_PAGE_SETTERS[section](Math.max(0, Math.min(SECTION_PAGE_GETTERS[section]() + dir, max)));
  renderCards();
  // scroll to the section top
  const el = document.getElementById(section + 'Divider');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function goToPage(section, pageIndex) {
  const items = sectionItems(section);
  const max = Math.ceil(items.length / PAGE_SIZE) - 1;
  SECTION_PAGE_SETTERS[section](Math.max(0, Math.min(pageIndex, max)));
  renderCards();
  const el = document.getElementById(section + 'Divider');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetPages() {
  promotedPage = 0;
  rentPage = 0;
  leasePage = 0;
  pgPage = 0;
}

// Builds the inner HTML for the video tour's slide: a real embedded player
// when the URL is a recognizable YouTube/Vimeo/file link, otherwise a
// centered "watch" fallback card — plus a small open-externally/copy chip
// in the corner either way, so the raw link is always reachable.
function buildVideoSlideHtml(p) {
  const videoUrl = p.media?.video || '';
  const safeVideoUrl = safeUrl(videoUrl);
  if (!safeVideoUrl) return '';
  const embedHtml = buildVideoEmbed(safeVideoUrl);
  const body = embedHtml || `<div class="video-slide-fallback">
      <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      <a href="${esc(safeVideoUrl)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Watch video tour</a>
    </div>`;
  const actions = `<div class="video-slide-actions" onclick="event.stopPropagation()">
      <a href="${esc(safeVideoUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open video in new tab" title="Open in new tab">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
      <button type="button" class="video-copy-btn" data-url="${esc(videoUrl)}" onclick="copyVideoLink(this.dataset.url)" aria-label="Copy video link" title="Copy link">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
    </div>`;
  return body + actions;
}

// Viewed and Booked cards are read-only quick-glance cards — no call/
// shortlist/compare actions (those icons are hidden there already), so
// tapping the photo should behave like tapping the rest of the card and go
// straight to the property view, rather than opening the zoom lightbox the
// way an image tap does everywhere else (main grid, shortlist, etc.), where
// the photo is genuinely worth a closer look before the user commits to
// opening the full listing.
function handleCardImgClick(el, id, idx) {
  if (el.closest('.recently-viewed-strip') || el.closest('[id$="BookedGrid"]')) {
    openDetail(id);
  } else {
    openLightbox(id, idx);
  }
}
// Same property can legitimately be rendered into more than one place at
// once — e.g. a listing sits in Recently Viewed AND in its normal Rent/
// Lease/PG/Promoted grid card at the same time, or a promoted listing
// appears in both the Promoted highlight bucket and its own type section.
// buildImgSlider used to id each slider purely as 'sl' + property id (+ a
// per-caller suffix like '-grid'), so any two of those simultaneous
// renders produced the exact same DOM id. getElementById only ever finds
// the first one, so the swipe/drag handlers (which look the element up by
// id) silently updated that first copy while the card the visitor was
// actually touching never visibly changed — e.g. swiping the property card
// appeared to do nothing while the Recently Viewed copy of the same
// property changed instead. A per-render counter keeps every slider's id
// unique regardless of how many times the same property gets drawn on the
// page.
let _imgSliderSeq = 0;
function buildImgSlider(p, fg, uidSuffix, videoSlideHtml) {
  const imgs = (p.media?.images && p.media.images.length) ? p.media.images : [];
  if (imgs.length === 0 && !videoSlideHtml) {
    return `<div class="prop-img-placeholder"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="${fg}" opacity=".3"/><polyline points="9 22 9 12 15 12 15 22" stroke="${fg}" opacity=".3"/></svg></div>`;
  }
  const uid = 'sl' + p.id + (uidSuffix || '') + '-' + (_imgSliderSeq++);
  // The first slide (the one actually shown) uses native lazy-loading, so
  // the browser defers fetching it until the card scrolls near the
  // viewport. The rest of a card's slides sit right behind it, hidden with
  // display:none, until the user swipes — they're marked data-src instead
  // of src, so the browser doesn't fetch them at all yet. observeCardImgs()
  // then loads all of a card's slides together (via IntersectionObserver,
  // same near-viewport threshold as the native lazy first slide) the
  // moment the *card itself* nears the viewport, well before any swipe.
  // That still avoids the old swipe-lag (everything's fetched together,
  // ahead of time) without the eager-loading-every-card's-extra-photos
  // approach, which fired for every rendered card regardless of scroll
  // position and congested the network enough to blank out the very
  // images that were actually scrolling into view.
  const imgSlides = imgs.map((url, i) =>
    `<img class="img-slide${i===0?' active':''}" ${i===0?`src="${safeUrl(url)}" loading="lazy"`:`data-src="${safeUrl(url)}"`} decoding="async" alt="" draggable="false" onclick="event.stopPropagation();handleCardImgClick(this,'${p.id}',${i})" />`
  ).join('');
  // Video tour, when present, always comes after every photo — the last
  // slide in the same swipeable gallery rather than a separate section.
  const videoSlide = videoSlideHtml
    ? `<div class="img-slide video-slide${imgs.length===0?' active':''}">${videoSlideHtml}</div>`
    : '';
  return `<div class="img-slides" id="${uid}">${imgSlides}${videoSlide}</div>`;
}

// Loads a card's non-first slides (see the data-src comment in
// buildImgSlider above) once the card nears the viewport, instead of all
// at once for every card on the page. rootMargin gives it a head start —
// slides are ready by the time the card is actually visible, so swiping
// still feels instant — without fetching photos for cards the user hasn't
// scrolled anywhere near yet.
let _cardImgObserver = null;
function observeCardImgs(root) {
  if (!_cardImgObserver) {
    if (!('IntersectionObserver' in window)) {
      // No IntersectionObserver support — fall back to loading everything
      // immediately rather than never loading the extra slides at all.
      (root || document).querySelectorAll('.img-slide[data-src]').forEach(img => {
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      });
      return;
    }
    _cardImgObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.querySelectorAll('.img-slide[data-src]').forEach(img => {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        });
        _cardImgObserver.unobserve(entry.target);
      });
    }, { rootMargin: '800px 0px' });
  }
  (root || document).querySelectorAll('.img-slides').forEach(el => {
    if (el.querySelector('.img-slide[data-src]')) _cardImgObserver.observe(el);
  });
}

// Blocks the right-click "Save image as..." menu on listing photos (cards,
// detail gallery, and the fullscreen lightbox + its thumbnails) as a casual
// deterrent. Delegated on document so it covers slides/thumbs added after
// this script runs, with no per-image listener bookkeeping needed. This is
// a speed bump, not real protection: dev tools, disabling JS, or a
// screenshot bypass it entirely (screenshots are OS-level and no website
// can block them). Does not affect right-click anywhere else on the site.
document.addEventListener('contextmenu', e => {
  if (e.target.closest('.img-slide, .lightbox-img, .lightbox-thumb')) e.preventDefault();
});

function slideGo(uid, idx) {
  const c = document.getElementById(uid);
  if (!c) return;
  c.querySelectorAll('.img-slide').forEach((s,i) => s.classList.toggle('active', i===idx));
  // Compare-modal cards show dot indicators alongside the slider (see
  // compare-slide-dots) — keep them in sync too when present. Every other
  // .img-slides consumer (property cards, shortlist panel, etc.) has no
  // such sibling, so this is a no-op for them.
  const dotsWrap = c.parentElement && c.parentElement.querySelector('.compare-slide-dots');
  if (dotsWrap) dotsWrap.querySelectorAll('span').forEach((d,i) => d.classList.toggle('active', i===idx));
}

function slideStep(uid, dir) {
  const c = document.getElementById(uid);
  if (!c) return;
  const slides = c.querySelectorAll('.img-slide');
  let cur = [...slides].findIndex(s => s.classList.contains('active'));
  const next = (cur + dir + slides.length) % slides.length;
  slideGo(uid, next);
}

/* Swipe-to-change-photo for every .img-slides gallery (property cards,
   shortlist panel cards, and the property-view gallery all share this
   markup, so one delegated listener covers all of them). A horizontal
   drag past a small threshold steps the slide; anything more vertical
   than horizontal is left alone so the page can still scroll normally. */
(function(){
  let sx = 0, sy = 0, active = null;
  document.addEventListener('touchstart', function(e){
    const el = e.target.closest('.img-slides');
    if (!el || !el.id) { active = null; return; }
    if (el.closest('.recently-viewed-strip, [id$="BookedGrid"]')) { active = null; return; }
    if (el.querySelectorAll('.img-slide').length < 2) { active = null; return; }
    active = el;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, {passive:true});
  document.addEventListener('touchend', function(e){
    if (!active) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      slideStep(active.id, dx < 0 ? 1 : -1);
    }
    active = null;
  }, {passive:true});
})();

/* Mouse-drag swipe for desktop — same threshold/logic as the touch handler
   above, so trackpad/mouse users can swipe through photos without arrow
   buttons. A plain click (no meaningful drag) still falls through to the
   image's own onclick (opens the lightbox). */
(function(){
  let mx = 0, my = 0, active = null;
  document.addEventListener('mousedown', function(e){
    const el = e.target.closest('.img-slides');
    if (!el || !el.id) { active = null; return; }
    if (el.closest('.recently-viewed-strip, [id$="BookedGrid"]')) { active = null; return; }
    if (el.querySelectorAll('.img-slide').length < 2) { active = null; return; }
    active = el;
    mx = e.clientX;
    my = e.clientY;
  });
  document.addEventListener('mouseup', function(e){
    if (!active) return;
    const dx = e.clientX - mx;
    const dy = e.clientY - my;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      slideStep(active.id, dx < 0 ? 1 : -1);
    }
    active = null;
  });
})();

/* ═══════════════════════════════════════════════
   LIGHTBOX (full-image viewer)
═══════════════════════════════════════════════ */
let lightboxImgs = [];
let lightboxIdx = 0;
let lightboxVideoHtml = ''; // '' when this property has no (valid) video tour

// The lightbox swaps a single <img>'s src on each swipe instead of
// pre-rendering hidden slides (see the note near the touch handler below),
// so it never had the buildImgSlider lazy-loading issue — but nothing was
// fetching the next photo ahead of time either, so there was still a beat
// of loading on every swipe. This preloads the photo on either side of the
// current one into the browser's cache, so by the time a swipe reaches it,
// it's already there. A Set just avoids re-requesting the same URL twice.
const lightboxPreloaded = new Set();
function preloadLightboxImage(url) {
  if (!url || lightboxPreloaded.has(url)) return;
  lightboxPreloaded.add(url);
  new Image().src = safeUrl(url);
}
function preloadLightboxNeighbors() {
  const total = lightboxImgs.length;
  if (total < 2) return;
  preloadLightboxImage(lightboxImgs[(lightboxIdx + 1) % total]);
  preloadLightboxImage(lightboxImgs[(lightboxIdx - 1 + total) % total]);
}

function openLightbox(propId, idx) {
  const p = PROPERTIES.find(x => x.id === propId) || BOOKED_PROPERTIES.find(x => x.id === propId);
  if (!p || !p.media?.images || !p.media.images.length) return;
  closeAllFd();        // the image's own onclick stops propagation (see below),
                        // so the document-level outside-click listener that
                        // normally closes open filter dropdowns never fires —
                        // close them explicitly so one doesn't get left
                        // floating (z-index:2000) on top of the lightbox
  incrementViews(p);   // clicking a card's photo also counts as a view — the
                        // image's own onclick stops propagation so it never
                        // reaches the card's openDetail(id) handler
  // Zooming into a card's photos is a real "viewed this property" signal
  // too, even if the visitor never opens the full detail page — so it
  // should land in Recently Viewed exactly like openDetail() does. Same
  // booked-listing guard: booked/off-market listings don't belong there.
  if (PROPERTIES.some(x => x.id === propId)) recordRecentlyViewed(p);
  renderCards();        // reflect the new count on the card grid
  lightboxImgs = p.media.images;
  lightboxVideoHtml = buildVideoSlideHtml(p);
  lightboxIdx = idx || 0;
  lightboxPreloaded.clear();
  renderLightbox();
  document.getElementById('lightboxOverlay').classList.add('open');
}

function closeLightbox() {
  document.getElementById('lightboxOverlay').classList.remove('open');
}

// Generic entry point for viewing a single image (or plain array of images)
// full-size without any of openLightbox()'s property-specific side effects
// (view counts, Recently Viewed, card re-render) — used e.g. by the About
// modal's partner photos.
function openLightboxSimple(urls, idx) {
  if (!Array.isArray(urls) || !urls.length) return;
  lightboxImgs = urls;
  lightboxVideoHtml = '';
  lightboxIdx = idx || 0;
  lightboxPreloaded.clear();
  renderLightbox();
  document.getElementById('lightboxOverlay').classList.add('open');
}

function lightboxTotal() {
  return lightboxImgs.length + (lightboxVideoHtml ? 1 : 0);
}

function lightboxStep(dir) {
  const total = lightboxTotal();
  if (!total) return;
  lightboxIdx = (lightboxIdx + dir + total) % total;
  renderLightbox();
}

function lightboxGo(idx) {
  lightboxIdx = idx;
  renderLightbox();
}

function renderLightbox() {
  const total = lightboxTotal();
  if (!total) return;
  const isVideo = lightboxIdx >= lightboxImgs.length;
  const imgEl = document.getElementById('lightboxImg');
  const videoEl = document.getElementById('lightboxVideo');
  if (isVideo) {
    imgEl.style.display = 'none';
    videoEl.style.display = 'block';
    videoEl.innerHTML = lightboxVideoHtml;
  } else {
    videoEl.style.display = 'none';
    videoEl.innerHTML = '';
    imgEl.style.display = 'block';
    imgEl.src = safeUrl(lightboxImgs[lightboxIdx]);
  }
  document.getElementById('lightboxCounter').textContent = (lightboxIdx + 1) + ' / ' + total;
  const multi = total > 1;
  document.getElementById('lightboxThumbs').innerHTML = multi
    ? lightboxImgs.map((url, i) => `<div class="lightbox-thumb${i===lightboxIdx?' active':''}" style="background-image:url('${safeUrl(url)}')" onclick="lightboxGo(${i})"></div>`).join('')
      + (lightboxVideoHtml ? `<div class="lightbox-thumb video-thumb${isVideo?' active':''}" onclick="lightboxGo(${lightboxImgs.length})"><svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></div>` : '')
    : '';
  preloadLightboxNeighbors();
}

/* Swipe-to-change-photo inside the fullscreen lightbox — separate from the
   card sliders since the lightbox swaps a single <img> src rather than
   toggling .img-slide elements. */
(function(){
  let lsx = 0, lsy = 0, lactive = false;
  const stage = document.querySelector('.lightbox-stage');
  if (stage) {
    stage.addEventListener('touchstart', function(e){
      if (lightboxTotal() < 2) { lactive = false; return; }
      lactive = true;
      lsx = e.touches[0].clientX;
      lsy = e.touches[0].clientY;
    }, {passive:true});
    stage.addEventListener('touchend', function(e){
      if (!lactive) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - lsx;
      const dy = t.clientY - lsy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        lightboxStep(dx < 0 ? 1 : -1);
      }
      lactive = false;
    }, {passive:true});

    // Mouse-drag swipe for desktop, same idea as the touch handler above.
    let lmx = 0, lmy = 0, lmactive = false;
    stage.addEventListener('mousedown', function(e){
      if (lightboxTotal() < 2) { lmactive = false; return; }
      lmactive = true;
      lmx = e.clientX;
      lmy = e.clientY;
    });
    stage.addEventListener('mouseup', function(e){
      if (!lmactive) return;
      const dx = e.clientX - lmx;
      const dy = e.clientY - lmy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        lightboxStep(dx < 0 ? 1 : -1);
      }
      lmactive = false;
    });
  }
})();

/* Derive the frontend tab label (Rent/Lease/PG) from the nested basic.status */
function pTypeLabel(p) {
  const status = p.basic?.status;
  if (status === 'For Rent') return 'Rent';
  if (status === 'Lease') return 'Lease';
  if (status === 'PG') return 'PG';
  if (status === 'Short Stay') return 'ShortStay';
  if (status === 'For Sale') return 'Sell';
  return status || 'Rent';
}

/* Promoted/Verified are attribute-based tabs, not property types — this
   centralises the special-casing so every tab-filtered list (cards,
   recently-viewed, shortlist panel) stays in sync. */
function matchesTab(p, tab) {
  if (tab === 'All') return true;
  if (tab === 'Promoted') return !!p.promoted;
  if (tab === 'Verified') return !!p.verified;
  return pTypeLabel(p) === tab;
}

/* Lift/elevator is derived from the amenities list rather than stored as its own field */
function pHasLift(p) {
  return (p.amenities?.selected || []).some(a => /lift/i.test(a));
}

/* Full amenities list (selected + comma-separated "extra" ones) as pill tags,
   shown on every card type right after the Furnished/Maint/Water chip row. */
/* Icon per amenity, keyed by its base label (unit suffix like " ×3" stripped
   before lookup). Falls back to a generic check icon for custom/"extra"
   amenities not in this list. */
// Custom line-icon SVGs (matching the app's existing stroke-icon style) for
// amenities that have no accurate dedicated emoji — a generic ❄️/🧊/🥘-style
// stand-in doesn't actually depict the object, so these are hand-drawn
// instead. Icons below with an exact emoji already available (bed, sofa,
// elevator, gym, meals, wifi symbol, gas flame, water drop) keep the emoji.
const AMENITY_SVG = {
  'ac': '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="6" rx="1.5"/><path d="M5 11v3M9 11v4M13 11v3M17 11v4M21 11v3"/><path d="M4 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>',
  'washing machine': '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="13.5" r="5.5"/><circle cx="12" cy="13.5" r="2.5"/><circle cx="7" cy="6.5" r="0.9"/><circle cx="10.5" cy="6.5" r="0.9"/></svg>',
  'refrigerator': '<svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="5" y1="9" x2="19" y2="9"/><line x1="8" y1="4.5" x2="8" y2="7"/><line x1="8" y1="11.5" x2="8" y2="14"/></svg>',
  'microwave': '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="1.5"/><rect x="4" y="8.3" width="12" height="7.4" rx="1"/><circle cx="19" cy="10" r="1.2"/><line x1="17.4" y1="14" x2="20.6" y2="14"/></svg>',
  'geyser': '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="16" rx="5"/><line x1="12" y1="19" x2="12" y2="22"/><circle cx="12" cy="8" r="1"/><path d="M9 22h6"/></svg>',
  'cupboards': '<svg viewBox="0 0 24 24"><rect x="3" y="2" width="18" height="20" rx="1.5"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="9" y1="11" x2="9" y2="13"/><line x1="15" y1="11" x2="15" y2="13"/></svg>',
  'balcony': '<svg viewBox="0 0 24 24"><line x1="2" y1="6" x2="22" y2="6"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="4" y1="10" x2="4" y2="20"/><line x1="8" y1="10" x2="8" y2="20"/><line x1="12" y1="10" x2="12" y2="20"/><line x1="16" y1="10" x2="16" y2="20"/><line x1="20" y1="10" x2="20" y2="20"/><line x1="2" y1="20" x2="22" y2="20"/></svg>',
  'cctv': '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="12" height="7" rx="1.5"/><circle cx="17.5" cy="11.5" r="3.5"/><path d="M3 8L1 6M3 15l-2 2"/></svg>',
  'power backup': '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="18" height="10" rx="2"/><line x1="22" y1="10" x2="22" y2="14"/><path d="M13 9l-4 5h3l-1 4 4-5h-3z"/></svg>',
};
const AMENITY_ICONS = {
  'wi-fi': '🛜',
  'ac': AMENITY_SVG.ac,
  'washing machine': AMENITY_SVG['washing machine'],
  'refrigerator': AMENITY_SVG.refrigerator,
  'microwave': AMENITY_SVG.microwave,
  'geyser': AMENITY_SVG.geyser,
  'cupboards': AMENITY_SVG.cupboards,
  'bed': '🛏️',
  'sofa': '🛋️',
  'elevator': '🛗',
  'balcony': AMENITY_SVG.balcony,
  'gym': '🏋️',
  'cctv': AMENITY_SVG.cctv,
  'chimney': '💨',
  'power backup': AMENITY_SVG['power backup'],
  'garden': '🌳',
  'laundry': '👕',
  'meals included': '🍽️',
  'piped gas connection': '🔥',
  'ro water filter': '💧',
};
function amenityIcon(label) {
  const base = label.replace(/\s*×\d+\s*$/, '').trim().toLowerCase();
  if (AMENITY_ICONS[base]) return AMENITY_ICONS[base];
  // Fallback: keyword match for custom/free-text amenities hosts type in
  // themselves, so they still get a sensible, closely-related icon instead
  // of the generic 🏠 — covers the common extras seen in Indian rental
  // listings beyond the fixed checklist above.
  const KEYWORD_ICONS = [
    [/park/, '🅿️'], [/24.?7.*water|water supply|hot water|water\b/, '💧'], [/\btv\b|television/, '📺'],
    [/internet|broadband|wifi|wi-fi/, '🛜'], [/security guard|watchman|guard|gated/, '💂'],
    [/pool|swim/, '🏊'], [/play area|kids/, '🧒'], [/club\s?house/, '🏛️'],
    [/intercom/, '☎️'], [/fire/, '🧯'], [/solar/, '☀️'], [/pet/, '🐾'],
    [/store|storage|servant/, '📦'], [/curtain/, '🪟'], [/dining/, '🍽️'],
    [/kitchen|modular/, '🍳'], [/dish\s?washer/, '🧽'], [/chimney/, '💨'],
    [/house\s?keep|maid|cleaning/, '🧹'], [/puja|prayer/, '🙏'], [/study/, '📚'],
    [/false ceiling/, '🏠'], [/vastu/, '🧭'], [/terrace|rooftop/, '🌆'],
    [/yoga|meditation/, '🧘'], [/jogging|track|walk/, '🚶'], [/temple/, '🛕'],
    [/school/, '🏫'], [/hospital|clinic/, '🏥'], [/metro|bus stop|transit/, '🚏'],
    [/mall|shopping/, '🛍️'], [/lawn|lush/, '🌿'], [/rain\s?water/, '🌧️'],
    [/sewage|stp/, '♻️'], [/generator/, '🔋'], [/wardrobe|closet/, '🚪'],
  ];
  for (const [re, icon] of KEYWORD_ICONS) if (re.test(base)) return icon;
  return '🏠';
}
function amenityTagsHTML(p) {
  const list = (p.amenities?.selected || []).slice();
  if (p.amenities?.extra) list.push(...p.amenities.extra.split(',').map(s => s.trim()).filter(Boolean));
  if (!list.length) return '';
  return list.map(a => `<span class="prop-chip chip-amenity" title="${esc(a)}"><span class="prop-chip-icon">${amenityIcon(a)}</span>${esc(a)}</span>`).join('');
}

function cardHTML(p, compact, extraLeftBadge) {
  const liked = shortlisted.has(String(p.id));
  const compared = compareSet.has(p.id);
  const lockedType = getCompareType();
  const pType = pTypeLabel(p);
  const pTypeLetter = {Rent:'R',Lease:'L',PG:'PG',ShortStay:'S',Sell:'SL'}[pType] || pType[0];
  const compareDisabled = !compared && lockedType && pType !== lockedType;
  const colors = {Rent:'#e8f5ee:#1a6640',Lease:'#dde9fa:#1a4680',PG:'#eee8fa:#4a2a9a',ShortStay:'#e0f7fa:#00646e',Sell:'#fdf1e0:#a15c00'};
  const [bg, fg] = (colors[pType]||'#f0f0f0:#333').split(':');
  const listClass = isListView ? ' list-view' : '';
  const isPGCard = pType === 'PG';
  const isSSCard = pType === 'ShortStay';
  const pg = p.pg || {};
  const shortStay = p.shortStay || {};
  const bathrooms = isPGCard ? (parseInt(pg.bathroom) || 1) : (parseInt(p.property?.bathrooms) || 1);
  const carCount = isPGCard ? (parseInt(pg.car, 10) || 0) : (parseInt(p.property?.car, 10) || 0);
  const bikeCount = isPGCard ? (parseInt(pg.bike, 10) || 0) : (parseInt(p.property?.bike, 10) || 0);
  const carpark = carCount > 0;
  const bikepark = bikeCount > 0;
  const lift = pHasLift(p);
  const deposit = p.price?.deposit || 0;
  const maintenance = p.price?.maintenance || 0;
  const floor = isPGCard ? '' : (p.property?.floor || '');
  const available = isPGCard ? (pg.available || '') : (p.property?.available || '');
  const waterLabel = p.price?.water || '';
  const electricLabel = p.price?.electricity || '';
  // ── Extra fields captured on the post-property form but not previously shown on cards ──
  const ptype = p.property?.type || pg.type || shortStay.type || '';
  const areaSqft = (p.property?.area || '').toString().replace(/\s*sqft\s*$/i, '').trim();
  const leaseDur = p.terms?.lease || '';
  const video = p.media?.video || '';
  // Plain-text chip, no icon — used for the long tail of fields below so we're not
  // hand-drawing an SVG per field. Skips rendering entirely when value is empty.
  const chip = (label, value) => value ? `<span class="prop-chip" title="${esc(label)}"><span class="prop-chip-val">${esc(value)}</span></span>` : '';
  const availableInfo = availableDateInfo(available);
  const compactClass = compact ? ' compact' : '';
  const promotedClass = p.promoted ? ' prop-card-promoted' : '';
  const availAccentClass = availableInfo ? (availableInfo.cls === 'prop-loc-avail-past' ? ' avail-past' : ' avail-future') : '';
  return `<div class="prop-card${listClass}${compactClass}${promotedClass} type-${pType.toLowerCase()}${availAccentClass}" data-property-id="${p.id}" onclick="openDetail('${p.id}')">
    <div class="prop-img" style="background:${bg}" data-idx="0">
      ${buildImgSlider(p, fg, '-grid')}
      ${priceChipsHTML(p, pType, deposit, maintenance, leaseDur, {ribbon:true})}
      <span class="prop-img-id-badge">${esc(p.propertyId || '')}</span>
      <div class="prop-card-top-row">
        <div class="prop-left-badges">
          ${(!compact && !['Rent','Lease','PG','ShortStay'].includes(currentTab)) ? `<span class="prop-badge-type-letter${pTypeLetter.length>1?' wide':''} badge-${pType.toLowerCase()}" title="${pType}">${pTypeLetter}</span>` : ''}
        </div>
        <div class="prop-right-badges">
          ${extraLeftBadge || ''}
          ${p.promoted ? '<div class="prop-icon-badge prop-icon-promoted" title="Promoted"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.26 6.9.8-5.1 4.7 1.4 6.84L12 17.3l-6.1 3.3 1.4-6.84-5.1-4.7 6.9-.8z"/></svg></div>' : ''}
          ${(SHOW_VERIFIED_BADGE && p.verified) ? '<div class="prop-icon-badge prop-icon-verified" title="Verified"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#fff"/><path d="M8 12.3l2.6 2.6 5.4-5.8" stroke="#1a73e8" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' : ''}
          <div class="prop-icon-badge prop-views-float" title="${getViews(p).toLocaleString('en-IN')} views">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="prop-views-float-badge">${formatViews(getViews(p))}</span>
          </div>
          <div class="prop-icon-badge prop-compare-float prop-action-compare${compared?' checked':''}${compareDisabled?' disabled':''}" onclick="event.stopPropagation();toggleCompare('${p.id}',this)" aria-label="${compared?'Remove from':'Add to'} compare" title="${compareDisabled?`You're comparing ${lockedType} properties`:(compared?'Added to compare':'Compare')}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5" opacity="0.55"/></svg>
          </div>
          <div class="prop-heart${liked?' liked':''}" onclick="event.stopPropagation();toggleShortlist('${p.id}',this)" aria-label="${liked?'Remove from':'Add to'} shortlist">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </div>
          <div class="prop-icon-badge prop-icon-call" onclick="event.stopPropagation();openCall('${p.id}')" aria-label="Call agent" title="Call agent">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </div>
        </div>
      </div>
    </div>
    <div class="prop-body">
      <div class="prop-meta">
      <div class="prop-title" title="${esc(p.propertyId)}">
        <span class="prop-title-id">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="prop-title-icon"><path d="M20.59 13.41L11 3.83A2 2 0 0 0 9.59 3.24L4 3a1 1 0 0 0-1 1l.24 5.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.82z"/><circle cx="7.5" cy="7.5" r="1.4"/></svg>
          <span class="prop-title-text">${esc(p.propertyId || 'Untitled listing')}</span>
        </span>
        ${p.location?.area ? `<span class="prop-title-buildtype" title="${esc(p.location.area)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M6 21V7l6-4 6 4v14M10 21v-5h4v5"/></svg><span class="prop-loc-full">${esc(p.location.area)}</span><span class="prop-loc-short">${esc(locShort(p.location.area))}</span></span>` : ''}
      </div>
      </div>
	  <div class="prop-stats">
        ${(() => { const bhkVal = String(p.property?.bhk || '').replace(/\s*BHK\s*$/i, '').trim(); return (parseFloat(bhkVal) > 0) ? `<span class="prop-stat" title="Configuration">
          <span class="prop-stat-icon icon-bed">🛏️</span>
          ${bhkVal}
        </span>` : ''; })()}
        ${isPGCard && pg.room ? (() => { const sharingMap = { 'Single': 1, 'Double Sharing': 2, 'Triple Sharing': 3 }; const sharingVal = sharingMap[pg.room]; return `<span class="prop-stat" title="${esc(pg.room)}">
          <span class="prop-stat-icon icon-bed">🛏️</span>
          ${sharingVal || esc(pg.room)}
        </span>`; })() : ''}
        ${isPGCard ? (pg.occupancy ? `<span class="prop-stat" title="Occupancy">
          <span class="prop-stat-icon icon-occupancy">🧍</span>
          ${esc(pg.occupancy)}
        </span>` : '') : (bathrooms > 0 ? `<span class="prop-stat" title="Bathrooms">
          <span class="prop-stat-icon icon-bath">🚽</span>
          ${bathrooms}
        </span>` : '')}
        ${isPGCard ? (pg.gender ? (() => { const gIcon = {'Boys':'♂️','Girls':'♀️','Co-ed':'⚥'}[pg.gender] || '🚻'; const gAbbr = {'Boys':'M','Girls':'F','Co-ed':'M/F'}[pg.gender] || esc(pg.gender); return `<span class="prop-stat" title="Gender preference: ${esc(pg.gender)}">
          <span class="prop-stat-icon icon-gender">${gIcon}</span>
          ${gAbbr}
        </span>`; })() : '') : `<span class="prop-stat" title="${carCount+' car parking spot'+(carCount===1?'':'s')}">
          <span class="prop-stat-icon icon-car">🚗</span>
          ${carCount}
        </span>`}
        ${bikeCount > 0 ? `<span class="prop-stat" title="${bikeCount+' bike parking spot'+(bikeCount>1?'s':'')}">
          <span class="prop-stat-icon icon-bike">🏍️</span>
          ${bikeCount}
        </span>` : ''}
        ${areaSqft ? `<span class="prop-stat" title="Built-up area">
          <span class="prop-stat-icon icon-area">📐</span>
          ${areaSqft}sqft
        </span>` : ''}
      </div>
<!--<div class="prop-footer">
        <div class="prop-quick-actions">
          <button class="prop-qa-btn prop-qa-3d qa-call" onclick="event.stopPropagation();openCall('${p.id}')" aria-label="Call owner">
            <span class="qa-3d-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg></span>
            <span class="prop-qa-label">Call</span>
          </button>
          <button class="prop-qa-btn prop-qa-3d qa-whatsapp" onclick="event.stopPropagation();openWhatsApp('${p.id}')" aria-label="Contact on WhatsApp">
            <span class="qa-3d-icon"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.6 6.32A8.86 8.86 0 0 0 12.05 4C7.4 4 3.6 7.8 3.6 12.45c0 1.6.45 3.13 1.27 4.45L4 21l4.2-1.1a8.83 8.83 0 0 0 4.07.99h.01c4.65 0 8.45-3.8 8.45-8.45a8.4 8.4 0 0 0-2.93-5.62zM12.06 19.5a7.05 7.05 0 0 1-3.6-.99l-.26-.15-2.67.7.71-2.6-.17-.27a6.99 6.99 0 0 1-1.08-3.74c0-3.86 3.15-7 7.04-7 1.88 0 3.64.73 4.97 2.06a6.96 6.96 0 0 1 2.06 4.96c0 3.87-3.16 7.03-7 7.03zm3.86-5.27c-.21-.1-1.24-.62-1.43-.68-.19-.07-.33-.1-.47.1-.14.21-.54.68-.66.81-.12.14-.24.16-.45.05-.21-.1-.87-.32-1.66-1.03-.61-.55-1.03-1.22-1.15-1.43-.12-.21-.01-.32.1-.43.1-.1.21-.26.32-.39.1-.13.14-.21.21-.36.07-.14.04-.27-.02-.38-.07-.1-.62-1.49-.85-2.04-.18-.43-.36-.37-.5-.38h-.42c-.14 0-.38.05-.58.27-.21.21-.79.77-.79 1.88 0 1.1.81 2.18.92 2.33.12.14 1.58 2.42 3.83 3.3 1.9.75 2.28.6 2.7.56.42-.04 1.36-.55 1.55-1.09.19-.53.19-.98.13-1.08-.05-.1-.21-.16-.43-.27z"/></svg></span>
            <span class="prop-qa-label">Chat</span>
          </button>
          ${pType === 'ShortStay' ? `
          <div class="prop-qa-icon prop-qa-3d qa-book" id="prop-qa-icon-${p.id}" data-prop-id="${p.id}" onclick="event.stopPropagation();openBookingModal('${p.id}')" aria-label="Book now" title="Book now">
            <span class="qa-3d-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="15" rx="2"/><line x1="7" y1="1.5" x2="7" y2="6.5"/><line x1="17" y1="1.5" x2="17" y2="6.5"/><line x1="2.5" y1="9" x2="21.5" y2="9"/><path d="M8 14.2l2.4 2.4L16 11"/></svg></span>
            <span class="prop-qa-label">Book</span>
          </div>` : `
          <div class="prop-qa-icon prop-qa-3d qa-visit" id="prop-qa-icon-${p.id}" data-prop-id="${p.id}" onclick="event.stopPropagation();openScheduleModal('${p.id}')" aria-label="Schedule a visit" title="Schedule a visit">
            <span class="qa-3d-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="14" height="15" rx="2"/><line x1="6" y1="1.5" x2="6" y2="6.5"/><line x1="13" y1="1.5" x2="13" y2="6.5"/><line x1="2.5" y1="9" x2="16.5" y2="9"/><circle cx="16.5" cy="16.5" r="6.2" fill="#c9975c"/><path d="M16.5 12.8v3.7l2.6 1.5"/></svg></span>
            <span class="prop-qa-label">Visit</span>
            <span class="prop-qa-count" style="${(p.visitCount||0) > 0 ? '' : 'display:none'}">${p.visitCount||0}</span>
          </div>`}
          <div class="prop-qa-icon prop-qa-3d qa-compare prop-action-compare${compared?' checked':''}${compareDisabled?' disabled':''}" onclick="event.stopPropagation();toggleCompare('${p.id}',this)" aria-label="${compared?'Remove from':'Add to'} compare" title="${compareDisabled?`You're comparing ${lockedType} properties`:'Compare'}">
            <span class="qa-3d-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5" opacity="0.55"/></svg></span>
            <span class="prop-qa-label">${compared?'Added':'Compare'}</span>
          </div>
          <span class="prop-views" title="${getViews(p).toLocaleString('en-IN')} views">
            <span class="prop-views-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <span class="prop-views-badge">${formatViews(getViews(p))}</span>
            </span>
            <span class="prop-qa-label">Views</span>
          </span>
        </div>
      </div>-->
    </div>
  </div>`;
}

/* Compact card used only inside the Shortlisted side panel. Unlike the full
   cardHTML(), it deliberately drops the long tail of chips (floor, tenant,
   negotiable, lease terms, age, description, etc.) so the 4 action buttons
   (Contact / WhatsApp / Schedule visit / Compare) are reachable without
   scrolling through a full spec sheet — the panel is for quick review, not
   full listing detail (tap the card to open the full detail modal for that). */
function shortlistCardHTML(p) {
  const liked = shortlisted.has(String(p.id));
  const compared = compareSet.has(p.id);
  const lockedType = getCompareType();
  const pType = pTypeLabel(p);
  const compareDisabled = !compared && lockedType && pType !== lockedType;
  const colors = {Rent:'#e8f5ee:#1a6640',Lease:'#dde9fa:#1a4680',PG:'#eee8fa:#4a2a9a',ShortStay:'#e0f7fa:#00646e',Sell:'#fdf1e0:#a15c00'};
  const [bg, fg] = (colors[pType]||'#f0f0f0:#333').split(':');
  const isPGCardSL = pType === 'PG';
  const pgSL = p.pg || {};
  const bathrooms = isPGCardSL ? (parseInt(pgSL.bathroom) || 1) : (parseInt(p.property?.bathrooms) || 1);
  const carCount = isPGCardSL ? (parseInt(pgSL.car, 10) || 0) : (parseInt(p.property?.car, 10) || 0);
  const bikeCount = isPGCardSL ? (parseInt(pgSL.bike, 10) || 0) : (parseInt(p.property?.bike, 10) || 0);
  const carpark = carCount > 0;
  const bikepark = bikeCount > 0;
  const lift = pHasLift(p);
  const areaSqft = (p.property?.area || '').toString().replace(/\s*sqft\s*$/i, '').trim();
  const deposit = p.price?.deposit || 0;
  const maintenance = p.price?.maintenance || 0;
  const leaseDur = p.terms?.lease || '';
  const waterLabel = p.price?.water || '';
  const electricLabel = p.price?.electricity || '';
  const ptype = p.property?.type || pgSL.type || p.shortStay?.type || '';
  const available = isPGCardSL ? (pgSL.available || '') : (p.property?.available || '');
  const availableInfo = availableDateInfo(available);
  const availAccentClassSL = availableInfo ? (availableInfo.cls === 'prop-loc-avail-past' ? ' avail-past' : ' avail-future') : '';
  return `<div class="prop-card type-${pType.toLowerCase()}${availAccentClassSL}" data-property-id="${p.id}" onclick="toggleShortlistPanel();openDetail('${p.id}')">
    <div class="prop-img" style="background:${bg}" data-idx="0">
      ${buildImgSlider(p, fg, '-sl')}
      ${priceChipsHTML(p, pType, deposit, maintenance, leaseDur, {ribbon:true})}
      <div class="prop-card-top-row" style="justify-content:flex-end">
        <div class="prop-right-badges">
          ${p.promoted ? '<div class="prop-icon-badge prop-icon-promoted" title="Promoted"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.26 6.9.8-5.1 4.7 1.4 6.84L12 17.3l-6.1 3.3 1.4-6.84-5.1-4.7 6.9-.8z"/></svg></div>' : ''}
          ${(SHOW_VERIFIED_BADGE && p.verified) ? '<div class="prop-icon-badge prop-icon-verified" title="Verified"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#fff"/><path d="M8 12.3l2.6 2.6 5.4-5.8" stroke="#1a73e8" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' : ''}
          <div class="prop-icon-badge prop-views-float" title="${getViews(p).toLocaleString('en-IN')} views">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="prop-views-float-badge">${formatViews(getViews(p))}</span>
          </div>
          <div class="prop-icon-badge prop-compare-float prop-action-compare${compared?' checked':''}${compareDisabled?' disabled':''}" onclick="event.stopPropagation();toggleCompare('${p.id}',this)" aria-label="${compared?'Remove from':'Add to'} compare" title="${compareDisabled?`You're comparing ${lockedType} properties`:(compared?'Added to compare':'Compare')}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5" opacity="0.55"/></svg>
          </div>
          <div class="prop-heart${liked?' liked':''}" onclick="event.stopPropagation();toggleShortlist('${p.id}',this)" aria-label="${liked?'Remove from':'Add to'} shortlist">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </div>
          <div class="prop-icon-badge prop-icon-call" onclick="event.stopPropagation();openCall('${p.id}')" aria-label="Call agent" title="Call agent">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </div>
        </div>
      </div>
    </div>
    <div class="prop-body">
      <div class="prop-meta">
      <div class="prop-title" title="${esc(p.propertyId)}">
        <span class="prop-title-id">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="prop-title-icon"><path d="M20.59 13.41L11 3.83A2 2 0 0 0 9.59 3.24L4 3a1 1 0 0 0-1 1l.24 5.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.82z"/><circle cx="7.5" cy="7.5" r="1.4"/></svg>
          <span class="prop-title-text">${esc(p.propertyId || 'Untitled listing')}</span>
        </span>
        ${p.location?.area ? `<span class="prop-title-buildtype" title="${esc(p.location.area)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M6 21V7l6-4 6 4v14M10 21v-5h4v5"/></svg><span class="prop-loc-full">${esc(p.location.area)}</span><span class="prop-loc-short">${esc(locShort(p.location.area))}</span></span>` : ''}
      </div>
      </div>
      <div class="prop-stats">
        ${(() => { const bhkVal = String(p.property?.bhk || '').replace(/\s*BHK\s*$/i, '').trim(); return (parseFloat(bhkVal) > 0) ? `<span class="prop-stat" title="Configuration">
          <span class="prop-stat-icon icon-bed">🛏️</span>
          ${bhkVal}
        </span>` : ''; })()}
        ${isPGCardSL && pgSL.room ? (() => { const sharingMap = { 'Single': 1, 'Double Sharing': 2, 'Triple Sharing': 3 }; const sharingVal = sharingMap[pgSL.room]; return `<span class="prop-stat" title="${esc(pgSL.room)}">
          <span class="prop-stat-icon icon-bed">🛏️</span>
          ${sharingVal || esc(pgSL.room)}
        </span>`; })() : ''}
        ${isPGCardSL ? (pgSL.occupancy ? `<span class="prop-stat" title="Occupancy">
          <span class="prop-stat-icon icon-occupancy">🧍</span>
          ${esc(pgSL.occupancy)}
        </span>` : '') : (bathrooms > 0 ? `<span class="prop-stat" title="Bathrooms">
          <span class="prop-stat-icon icon-bath">🚽</span>
          ${bathrooms}
        </span>` : '')}
        ${isPGCardSL ? (pgSL.gender ? (() => { const gIcon = {'Boys':'♂️','Girls':'♀️','Co-ed':'⚥'}[pgSL.gender] || '🚻'; const gAbbr = {'Boys':'M','Girls':'F','Co-ed':'M/F'}[pgSL.gender] || esc(pgSL.gender); return `<span class="prop-stat" title="Gender preference: ${esc(pgSL.gender)}">
          <span class="prop-stat-icon icon-gender">${gIcon}</span>
          ${gAbbr}
        </span>`; })() : '') : `<span class="prop-stat" title="${carCount+' car parking spot'+(carCount===1?'':'s')}">
          <span class="prop-stat-icon icon-car">🚗</span>
          ${carCount}
        </span>`}
        ${bikeCount > 0 ? `<span class="prop-stat" title="${bikeCount+' bike parking spot'+(bikeCount>1?'s':'')}">
          <span class="prop-stat-icon icon-bike">🏍️</span>
          ${bikeCount}
        </span>` : ''}
        ${areaSqft ? `<span class="prop-stat" title="Built-up area">
          <span class="prop-stat-icon icon-area">📐</span>
          ${areaSqft}sqft
        </span>` : ''}
      </div>
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════
   SHORTLIST
═══════════════════════════════════════════════ */
function toggleShortlist(id, el) {
  id = String(id);
  if (shortlisted.has(id)) {
    shortlisted.delete(id);
    delete shortlistedData[id];
    el.classList.remove('liked');
    showToast('Removed from shortlist');
  } else {
    shortlisted.add(id);
    const p = PROPERTIES.find(x => String(x.id) === id);
    if (p) shortlistedData[id] = p;
    el.classList.add('liked');
    showToast('Added to shortlist ♥');
  }
  saveShortlist();
  saveShortlistData();
  updateShortlistCount();
  renderShortlistPanel();
  const saveBtn = document.getElementById('modal-save-btn');
  if (saveBtn && saveBtn.dataset.propId == id) {
    const isLiked = shortlisted.has(id);
    saveBtn.classList.toggle('liked', isLiked);
    const lbl = document.getElementById('modal-save-btn-label');
    if (lbl) lbl.textContent = isLiked ? 'Shortlisted' : 'Shortlist';
  }
}

function updateShortlistCount() {
  const n = shortlisted.size;
  document.getElementById('shortlistCount').textContent = n;
  const menuBadge = document.getElementById('menuShortlistCount');
  if (menuBadge) menuBadge.textContent = n;
  const bottomBadge = document.getElementById('bottomTabShortlistCount');
  if (bottomBadge) bottomBadge.textContent = n;
  // panelCount intentionally not set here — renderShortlistPanel() keeps it in
  // sync with whatever the current tab filter actually shows (see below).
}

function renderShortlistPanel() {
  const list = document.getElementById('panelList');
  const ids = [...shortlisted].filter(id => {
    const p = shortlistedData[id];
    return p && matchesTab(p, currentTab);
  });
  // Header shows the count of items actually visible for the current tab, so it
  // never disagrees with the list below it (e.g. "Shortlisted (2)" while only
  // 1 Lease card is shown because the other saved item is a Rent listing).
  document.getElementById('panelCount').textContent = ids.length;
  if (ids.length === 0) {
    list.innerHTML = shortlisted.size === 0
      ? '<div class="panel-empty">No shortlisted properties yet.<br>Tap ♥ on any listing to save it.</div>'
      : `<div class="panel-empty">No shortlisted ${currentTab} properties.<br>Switch tabs to see the rest of your shortlist.</div>`;
    return;
  }
  list.innerHTML = ids.map(id => shortlistCardHTML(shortlistedData[id])).join('');
  observeCardImgs(list);
}


function removeShortlist(id) {
  id = String(id);
  shortlisted.delete(id);
  delete shortlistedData[id];
  saveShortlist();
  saveShortlistData();
  const hearts = document.querySelectorAll('.prop-heart');
  hearts.forEach(h => {
    if (h.onclick && h.onclick.toString().includes(`toggleShortlist('${id}',`)) h.classList.remove('liked');
  });
  updateShortlistCount();
  renderShortlistPanel();
  renderCards();
}

/* ═══════════════════════════════════════════════
   COMPARE
═══════════════════════════════════════════════ */
function toggleCompare(id, el) {
  const prop = PROPERTIES.find(x => x.id === id);
  if (!prop) return;

  if (compareSet.has(id)) {
    compareSet.delete(id);
    if (el) el.classList.remove('checked');
  } else {
    if (compareSet.size >= COMPARE_MAX) {
      showToast(`You can compare up to ${COMPARE_MAX} properties at a time`, 'warning');
      return;
    }
    const existingType = getCompareType();
    if (existingType && pTypeLabel(prop) !== existingType) {
      showToast(`You can only compare ${existingType} properties together`, 'warning');
      return;
    }
    compareSet.add(id);
    if (el) el.classList.add('checked');
  }
  renderCompareBar();
  updateComparePillStates();
  if (document.getElementById('compareModal').classList.contains('open')) {
    if (compareSet.size === 0) {
      closeCompareModal();
    } else {
      renderCompareTable();
      updateCompareUrl();
    }
  }
}

function updateComparePillStates() {
  const lockedType = getCompareType();
  document.querySelectorAll('.prop-card').forEach(card => {
    const pill = card.querySelector('.prop-action-compare');
    if (!pill) return;
    const isChecked = pill.classList.contains('checked');
    const onclickStr = pill.getAttribute('onclick') || '';
    const m = onclickStr.match(/toggleCompare\('([^']+)'/);
    if (!m) return;
    const cardId = m[1];
    const prop = PROPERTIES.find(p => p.id === cardId);
    if (!prop) return;
    const shouldDisable = !isChecked && lockedType && pTypeLabel(prop) !== lockedType;
    pill.classList.toggle('disabled', shouldDisable);
    pill.title = shouldDisable ? `You're comparing ${lockedType} properties` : '';
  });
}

function getCompareType() {
  if (compareSet.size === 0) return null;
  const first = PROPERTIES.find(p => p.id === [...compareSet][0]);
  return first ? pTypeLabel(first) : null;
}

function clearCompare() {
  compareSet.clear();
  renderCompareBar();
  document.querySelectorAll('.prop-action-compare.checked').forEach(el => el.classList.remove('checked'));
  updateComparePillStates();
  closeCompareModal();
}

function removeFromCompare(id) {
  compareSet.delete(id);
  const pills = document.querySelectorAll('.prop-action-compare');
  pills.forEach(p => {
    if (p.onclick && p.onclick.toString().includes(`toggleCompare('${id}'`)) p.classList.remove('checked');
  });
  renderCompareBar();
  updateComparePillStates();
  if (compareSet.size === 0) {
    closeCompareModal();
  } else {
    renderCompareTable();
    updateCompareUrl();
  }
}

function renderCompareBar() {
  const bar = document.getElementById('compareBar');
  const n = compareSet.size;
  if (n < 1) {
    bar.classList.remove('show');
    return;
  }
  bar.classList.add('show');
  const ids = [...compareSet];
  document.getElementById('compareBarThumbs').innerHTML = ids.map(id => {
    const p = PROPERTIES.find(x => x.id === id);
    const label = p ? esc(p.propertyId) : '?';
    return `<span class="compare-bar-thumb" title="${label}">${label}</span>`;
  }).join('');
  
  const btn = document.getElementById('compareBarBtn');
  btn.disabled = false;
  btn.textContent = `Compare (${n})`;
}

// Strips any deep-link markers (?property=, ?compare=, or the /property/:id
// path) from the address bar without reloading the page — so refreshing
// after closing a shared property/compare view doesn't reopen it again.
function clearDeepLinkUrl() {
  const url = new URL(window.location.href);
  let changed = false;
  if (url.searchParams.has('property')) { url.searchParams.delete('property'); changed = true; }
  if (url.searchParams.has('compare'))  { url.searchParams.delete('compare');  changed = true; }
  if (/^\/property\/[a-fA-F0-9]{24}$/.test(url.pathname)) { url.pathname = '/'; changed = true; }
  if (changed) history.replaceState(null, '', url.pathname + url.search + url.hash);
}

// Keeps the address bar's ?compare= param in sync with compareSet while the
// compare modal is open, so a plain browser refresh (not just a shared
// WhatsApp link) restores the same comparison. No-ops (and clears the param)
// once fewer than 2 properties remain, same threshold openCompareModal() uses.
function updateCompareUrl() {
  const url = new URL(window.location.href);
  if (compareSet.size >= 2) {
    url.searchParams.set('compare', [...compareSet].join(','));
  } else {
    url.searchParams.delete('compare');
  }
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function openCompareModal() {
  if (compareSet.size < 2) {
    showToast('Select at least 2 properties to compare', 'warning');
    return;
  }
  renderCompareTable();
  document.getElementById('compareModal').classList.add('open');
  lockBodyScroll();
  updateCompareUrl();
}

function closeCompareModal() {
  document.getElementById('compareModal').classList.remove('open');
  unlockBodyScroll();
  clearDeepLinkUrl();
}

function shareCompareViaWhatsApp() {
  const ids = [...compareSet];
  if (ids.length < 2) return;
  const props = ids.map(id => PROPERTIES.find(p => p.id === id)).filter(Boolean);
  const compareUrl = `${window.location.origin}${window.location.pathname}?compare=${ids.join(',')}`;
  const names = props.map(p => p.propertyId).join(', ');
  const msg = `Check out this comparison of ${props.length} properties on HomeLoop — ${names}\n\n${compareUrl}`;
  const url = 'https://wa.me/?text=' + encodeURIComponent(msg);
  window.open(url, '_blank', 'noopener');
}

function renderCompareTable() {
  const ids = [...compareSet];
  const props = ids.map(id => PROPERTIES.find(p => p.id === id)).filter(Boolean);
  if (props.length === 0) {
    document.getElementById('compareTableWrap').innerHTML = '';
    return;
  }

  const yn = (v) => v ? '<span class="compare-yes">Yes</span>' : '<span class="compare-no">No</span>';
  const dash = (v) => esc((v === undefined || v === null || v === '') ? '—' : v);
  const hasAny = (props, path) => props.some(p => {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), p);
    return v !== undefined && v !== null && v !== '';
  });
  const anyPG = props.some(p => pTypeLabel(p) === 'PG');
  const anyLease = props.some(p => pTypeLabel(p) === 'Lease');
  const anySell = props.some(p => pTypeLabel(p) === 'Sell');
  const allSell = props.length > 0 && props.every(p => pTypeLabel(p) === 'Sell');
  const section = (label) => ({ section: label });

  const rows = [
    section('Listing Info'),
    { label: 'Location', get: p => dash(p.location?.area) },
    { label: 'City', get: p => dash(p.location?.city) },

    section('Pricing'),
    // Label flips to "Price" when every compared listing is a sale — "Rent /
    // Month" on a resale flat's expected price was misleading.
    { label: allSell ? 'Price' : 'Rent / Month', get: p => `<span style="font-weight:700;color:var(--text)">${fmtRupee(p.price?.rent||0)}</span>` },
    // No security deposit on a sale — same reasoning as the listing form
    // hiding f-depositWrap for Sell. Was previously showing "₹0" for every
    // Sell listing instead of degrading gracefully like the other rows here.
    { label: 'Deposit', get: p => pTypeLabel(p) === 'Sell' ? '—' : `${fmtRupee(p.price?.deposit||0)}` },
    // "Included" (meaning "folded into the rent") doesn't make sense for a
    // one-time sale — show "—" instead when a Sell listing has none entered.
    { label: 'Maintenance', get: p => p.price?.maintenance ? `${fmtRupee(p.price.maintenance)}` : (pTypeLabel(p) === 'Sell' ? '—' : 'Included') },
    { label: 'Electricity', get: p => dash(p.price?.electricity) },
    { label: 'Water charge', get: p => dash(p.price?.water) },
    { label: 'Rent negotiable', get: p => dash(p.price?.negotiable) },
    { label: 'Rent escalation', get: p => p.price?.rentIncrease ? `${String(p.price.rentIncrease).replace('%','')}%` : '—' },

    section('Property Details'),
    { label: 'Property type', get: p => dash(p.property?.type ?? p.pg?.type ?? p.shortStay?.type) },
    { label: 'Configuration', get: p => dash(p.property?.bhk) },
    { label: 'Built-up area', get: p => p.property?.area ? `${String(p.property.area).replace(/\s*sqft\s*$/i, '').trim()} sqft` : '—' },
    { label: 'Age of property', get: p => dash(p.property?.age) },
    { label: 'Furnishing', get: p => dash(p.property?.furnish ?? p.pg?.furnish ?? p.shortStay?.furnish) },
    { label: 'Floor', get: p => dash(p.property?.floor) },
    { label: 'Bathrooms', get: p => dash(p.property?.bathrooms ?? p.pg?.bathroom) },
    { label: 'Toilet type', get: p => dash(p.property?.toiletType ?? p.pg?.toiletType) },
    { label: 'Facing', get: p => dash(p.property?.facing) },
    { label: 'Tenant preferred', get: p => dash(p.property?.tenant) },
    { label: 'Lift', get: p => yn(pHasLift(p)) },
    { label: 'Car park', get: p => (parseInt(p.property?.car ?? p.pg?.car, 10) || 0) > 0 ? `${parseInt(p.property?.car ?? p.pg?.car, 10)}` : 'No' },
    { label: 'Bike park', get: p => (parseInt(p.property?.bike ?? p.pg?.bike, 10) || 0) > 0 ? `${parseInt(p.property?.bike ?? p.pg?.bike, 10)}` : 'No' },
    { label: 'Available from', get: p => { const v = p.property?.available ?? p.pg?.available; return v ? formatDateDisplay(v) : '—'; } },

    section('Terms'),
    { label: 'Notice period', get: p => dash(p.terms?.notice) },
    ...(anyLease ? [
      { label: 'Contract Term', get: p => dash(p.terms?.lease) },
      { label: 'Lease type', get: p => dash(p.terms?.leaseType) },
      { label: 'Lock-in period', get: p => dash(p.terms?.lockIn) },
    ] : []),

    section('Rules'),
    { label: 'Pets allowed', get: p => dash(p.rules?.pets) },
    { label: 'Non-veg allowed', get: p => dash(p.rules?.nonVeg) },
    ...(hasAny(props, 'rules.gas') ? [{ label: 'Piped gas', get: p => dash(p.rules?.gas) }] : []),

    ...(anyPG ? [
      section('PG Details'),
      { label: 'Property type', get: p => dash(p.pg?.type) },
      { label: 'Gender', get: p => dash(p.pg?.gender) },
      { label: 'Room type', get: p => dash(p.pg?.room) },
      { label: 'Occupancy', get: p => dash(p.pg?.occupancy) },
      { label: 'Attached bathroom', get: p => dash(p.pg?.bathroom) },
      { label: 'Toilet type', get: p => dash(p.pg?.toiletType) },
      { label: 'Room furnishing', get: p => dash(p.pg?.furnish) },
      { label: 'Meals included', get: p => dash(p.pg?.meals) },
      { label: 'Food type', get: p => dash(p.pg?.food) },
      { label: 'Visitor policy', get: p => dash(p.pg?.visitors) },
      { label: 'Gate time', get: p => dash(p.pg?.gateTime) },
    ] : []),

    // Was entirely missing — a Sell-vs-Sell comparison showed nothing about
    // ownership, RERA, or any of the resale-specific fields at all before
    // this. Mirrors the same fields buildDetailTable() shows in the
    // single-listing view.
    ...(anySell ? [
      section('Sale Details'),
      { label: 'Total floors in building', get: p => dash(p.sale?.totalFloors) },
      { label: 'Balconies', get: p => dash(p.sale?.balconies) },
      { label: 'Ownership type', get: p => dash(p.sale?.ownership) },
      { label: 'Possession status', get: p => dash(p.sale?.possession) },
      { label: 'Possession date', get: p => p.sale?.possessionDate ? formatDateDisplay(p.sale.possessionDate) : '—' },
      { label: 'RERA registered', get: p => dash(p.sale?.reraRegistered) },
      { label: 'RERA ID', get: p => dash(p.sale?.reraId) },
      section('Legal & Ownership Details'),
      { label: 'Khata type', get: p => dash(p.sale?.khataType) },
      { label: 'Property tax paid up to date', get: p => dash(p.sale?.propertyTaxPaid) },
      { label: 'Loan status', get: p => dash(p.sale?.loanStatus) },
      { label: 'OC available', get: p => dash(p.sale?.ocAvailable) },
      { label: 'CC available', get: p => dash(p.sale?.ccAvailable) },
      { label: 'Previous owners', get: p => dash(p.sale?.previousOwners) },
      { label: 'Society / Project name', get: p => dash(p.sale?.projectName) },
      section('Structure & Site Details'),
      { label: 'Flooring type', get: p => dash(p.sale?.flooring) },
      { label: 'Water source', get: p => dash(p.sale?.waterSource) },
      { label: 'Boundary wall', get: p => dash(p.sale?.boundaryWall) },
      { label: 'Width of facing road', get: p => p.sale?.roadWidth ? p.sale.roadWidth + ' ft' : '—' },
      { label: 'Open sides', get: p => dash(p.sale?.openSides) },
      { label: 'Corner property', get: p => dash(p.sale?.cornerProperty) },
      { label: 'Overlooking', get: p => dash(p.sale?.overlooking) },
    ] : []),

    section('Media & Amenities'),
    { label: 'Video tour', get: p => p.media?.video ? '<span class="compare-yes">Available</span>' : '<span class="compare-no">Not added</span>' },
    { label: 'Description', get: p => p.media?.desc ? `<span class="compare-desc-cell">${esc(p.media.desc)}</span>` : '—' },
    { label: 'Amenities', get: p => {
        const list = (p.amenities?.selected || []).slice();
        if (p.amenities?.extra) list.push(...p.amenities.extra.split(',').map(s => s.trim()).filter(Boolean));
        return list.length ? list.map(esc).join(', ') : '—';
      } },
  ];

  const headCells = props.map(p => {
    const pType = pTypeLabel(p);
    const colors = {Rent:'#e8f5ee:#1a6640',Lease:'#dde9fa:#1a4680',PG:'#eee8fa:#4a2a9a',ShortStay:'#e0f7fa:#00646e',Sell:'#fdf1e0:#a15c00'};
    const [bg, fg] = (colors[pType]||'#f0f0f0:#333').split(':');
    const liked = shortlisted.has(String(p.id));
    const deposit = p.price?.deposit || 0;
    const maintenance = p.price?.maintenance || 0;
    const leaseDur = p.terms?.lease || '';
    const ptype = p.property?.type || p.pg?.type || p.shortStay?.type || '';
    const cmpImgs = p.media?.images || [];
    return `<th class="compare-col compare-col-head">
      <div class="compare-col-card">
        <div class="compare-col-img" style="background:${bg}">
          ${buildImgSlider(p, fg, '-cmp')}
          ${cmpImgs.length > 1 ? `
          <div class="compare-slide-dots">${cmpImgs.map((_,i)=>`<span class="${i===0?'active':''}"></span>`).join('')}</div>
          ` : ''}
          <div class="prop-card-top-row" style="justify-content:flex-end">
            <div class="prop-right-badges">
              ${(SHOW_VERIFIED_BADGE && p.verified) ? '<div class="prop-icon-badge prop-icon-verified" title="Verified"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#fff"/><path d="M8 12.3l2.6 2.6 5.4-5.8" stroke="#1a73e8" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' : ''}
              <div class="prop-icon-badge prop-views-float" title="${getViews(p).toLocaleString('en-IN')} views">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                <span class="prop-views-float-badge">${formatViews(getViews(p))}</span>
              </div>
              <div class="prop-icon-badge prop-compare-float checked" onclick="event.stopPropagation();removeFromCompare('${p.id}')" aria-label="Remove from compare" title="Remove from comparison">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5" opacity="0.55"/></svg>
              </div>
              <div class="prop-heart${liked?' liked':''}" onclick="event.stopPropagation();toggleShortlist('${p.id}',this)" aria-label="${liked?'Remove from':'Add to'} shortlist">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </div>
          <div class="prop-icon-badge prop-icon-call" onclick="event.stopPropagation();openCall('${p.id}')" aria-label="Call agent" title="Call agent">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </div>
            </div>
          </div>
        </div>
      </div>
    </th>`;
  }).join('');

  const sectionClass = (label) => 'sec-' + label.toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const rowsWithDiff = rows.map(r => {
    if (r.section) return r;
    const vals = props.map(p => r.get(p));
    const isDiff = props.length > 1 && vals.some(v => v !== vals[0]);
    return { ...r, vals, isDiff };
  });

  // A section header is only worth showing in diff-only mode if at least one
  // row under it actually differs; otherwise it's just an empty label.
  const sectionHasDiff = new Map();
  let curSection = null;
  rowsWithDiff.forEach(r => {
    if (r.section) { curSection = r; sectionHasDiff.set(r, false); return; }
    if (r.isDiff && curSection) sectionHasDiff.set(curSection, true);
  });

  const bodyRows = rowsWithDiff.map(r => {
    if (r.section) {
      if (compareDiffOnly && !sectionHasDiff.get(r)) return '';
      return `<tr class="compare-section-row ${sectionClass(r.section)}"><td colspan="${props.length + 1}">${esc(r.section)}</td></tr>`;
    }
    return `<tr class="${r.isDiff ? 'compare-diff-row' : ''}">
      <td class="compare-row-label">${r.label}${r.isDiff ? '<span class="compare-diff-dot" title="Differs across properties"></span>' : ''}</td>
      ${r.vals.map(v => `<td>${v}</td>`).join('')}
    </tr>`;
  }).join('');

  document.getElementById('compareTableWrap').classList.toggle('diff-only', !!compareDiffOnly);

  document.getElementById('compareTableWrap').innerHTML = `
    <table class="compare-table">
      <thead>
        <tr>
          <th class="compare-row-label" style="background:var(--bg)"></th>
          ${headCells}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
  observeCardImgs(document.getElementById('compareTableWrap'));
}

document.getElementById('compareModal').addEventListener('click', function(e) {
  if (e.target === this) closeCompareModal();
});

function toggleShortlistPanel() {
  const panel = document.getElementById('shortlistPanel');
  const backdrop = document.getElementById('panelBackdrop');
  panel.classList.toggle('open');
  backdrop.classList.toggle('open');
  if (panel.classList.contains('open')) lockBodyScroll(); else unlockBodyScroll();

  if (panel.classList.contains('open')) renderShortlistPanel();
}

function toggleMenuPanel() {
  const panel = document.getElementById('menuPanel');
  const backdrop = document.getElementById('menuBackdrop');
  panel.classList.toggle('open');
  backdrop.classList.toggle('open');
  if (panel.classList.contains('open')) lockBodyScroll(); else unlockBodyScroll();
}

/* ═══════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════ */
/* When switching tabs, any filter dropdown that becomes hidden for the new
   tab (e.g. "Lease Amt" when moving to the Rent tab) must have its selected
   options cleared. Otherwise the selection stays active and silently affects
   results / the total-selected badge while being invisible to the user. */
// Clears every active filter — pills, search boxes, and the Price/Deposit/
// Maintenance range inputs — whenever the visitor switches tabs, so each
// tab (Rent/Lease/PG/ShortStay/Sell/Promoted) always starts from a clean
// slate instead of inheriting the previous tab's selections. Previously
// this only cleared filters whose button wasn't visible on the new tab
// (e.g. PG-only filters when leaving PG) — but many filter buttons (like
// BHK) are shown on more than one tab (Rent + Lease + Sell), so a BHK
// selection made on Rent used to silently carry over to Lease and could
// hide every Lease listing that didn't share that exact BHK value. Tabs
// are meant to filter independently of one another, so every tab switch
// now resets the whole filter bar unconditionally.
function clearFiltersHiddenByTab() {
  document.querySelectorAll('.fp-opt.sel').forEach(o => o.classList.remove('sel'));
  document.querySelectorAll('.fd-search').forEach(s => s.value = '');
  document.querySelectorAll('.fp-opt.fd-hidden').forEach(o => o.classList.remove('fd-hidden'));
  Object.keys(FD_GROUPS).forEach(id => refreshFdBtn(id));
  FD_RANGE_IDS.forEach(id => {
    const minEl = document.getElementById('fd-' + id + '-min');
    const maxEl = document.getElementById('fd-' + id + '-max');
    if (minEl) minEl.value = '';
    if (maxEl) maxEl.value = '';
    refreshFdRangeBtn(id, true);
  });
}

/* UrbanAware (honest video reviews), the "Add a Review" section, and
   Premium Services are only relevant when browsing the unfiltered full
   listing set, so they're shown for the "All" tab only and hidden for
   every other tab (Rent, Lease, PG, ShortStay, Promoted).
   hasHonestReviews tracks whether there's actually data to show, so
   UrbanAware still hides itself on the All tab if the API returns none;
   renderHonestReviews() only flips that flag and defers to this function
   for the actual display, instead of setting style.display itself
   (which used to race with tab switches and re-show it on other tabs). */
let hasHonestReviews = false;
function updateAllOnlySections() {
  const show = currentTab === 'All';

  const urbanAware = document.getElementById('honestReviewsSection');
  const reviewsSection = document.querySelector('.reviews-section');
  const premiumServices = document.getElementById('premiumServicesSection');

  const promotedSection = document.getElementById('promotedSection');
  const rentSection = document.getElementById('rentSection');
  const leaseSection = document.getElementById('leaseSection');
  const pgSection = document.getElementById('pgSection');
  const sellSection = document.getElementById('sellSection');
  const bookedSection = document.getElementById('bookedSection');

  // Show only on "All"
  if (urbanAware) urbanAware.style.display = (show && hasHonestReviews) ? '' : 'none';
  if (reviewsSection) reviewsSection.style.display = show ? '' : 'none';
  if (premiumServices) premiumServices.style.display = show ? '' : 'none';

  // Hide Promoted, Rent, Lease, PG, Sell and the Booked bucket when "All" is
  // selected — each of these already has its own dedicated bottom-nav tab,
  // so showing them again on Explore would just duplicate that tab's
  // content. Short Stay has no tab of its own, so it's deliberately left
  // out of this list and stays visible on Explore.
  if (promotedSection) promotedSection.style.display = show ? 'none' : '';
  if (rentSection) rentSection.style.display = show ? 'none' : '';
  if (leaseSection) leaseSection.style.display = show ? 'none' : '';
  if (pgSection) pgSection.style.display = show ? 'none' : '';
  if (sellSection) sellSection.style.display = show ? 'none' : '';
  if (bookedSection) bookedSection.style.display = show ? 'none' : '';

  // The results-header (count + ad banner) exists only for Promoted/Rent/
  // Lease/Sell, where the ad banner shows. The "X Properties found" count is
  // permanently hidden via .results-count{display:none} in CSS regardless of
  // tab, so on Explore ("All") the header holds nothing visible — reserving
  // it there just leaves a blank gap between the filter bar and Premium
  // Services. Collapsed entirely on Explore instead. PG/ShortStay are left
  // out since they don't have their own bottom-nav tab in this build.
  const rh = document.getElementById('resultsHeader');
  const resultsCountEl = document.querySelector('.results-count');
  const adBannerEl = document.getElementById('adBanner');
  if (rh) {
    const promoTab = ['Promoted', 'Rent', 'Lease', 'Sell'].includes(currentTab);
    rh.style.display = promoTab ? '' : 'none';
    if (resultsCountEl) resultsCountEl.style.display = show ? '' : 'none';
    if (adBannerEl) adBannerEl.style.display = promoTab ? '' : 'none';
    const mainEl2 = document.getElementById('mainContent');
    if (mainEl2) mainEl2.style.paddingTop = promoTab ? '' : '0';
  }


  // Mobile bottom-nav clearance
  const mainEl = document.getElementById('mainContent');
  if (mainEl) {
    mainEl.classList.toggle('needs-nav-clear', !show);
    // On Explore/"All", Premium Services / UrbanAware follow immediately
    // after <main> — collapse its bottom padding and force-hide the
    // "No properties found" empty state (which is meaningless here since
    // this tab isn't really about the property grid) so there's no dead
    // gap before "Our Premium Services", regardless of how renderCards()
    // sets emptyState's own display afterward.
    mainEl.classList.toggle('tab-explore', show);
  }
  const emptyStateEl = document.getElementById('emptyState');
  if (emptyStateEl && show) emptyStateEl.classList.remove('show');
}

function switchTab(el) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  currentTab = el.dataset.tab;
  // Playful bounce on the clicked tab's icon (restart the animation even if
  // it's already mid-run from a fast double-click).
  const icon = el.querySelector('.nav-tab-icon');
  if (icon) {
    icon.classList.remove('pop');
    void icon.offsetWidth; // force reflow so the animation restarts
    icon.classList.add('pop');
    icon.addEventListener('animationend', () => icon.classList.remove('pop'), { once: true });
  }
  syncMobileTab();
  syncFdBar();
  clearFiltersHiddenByTab();
  buildFilterOptions(); // rebuild dropdown options from only this tab's data (Rent/Lease/PG/ShortStay)
  closeAllFd();
  updateAllOnlySections();
  renderCards();
  renderBookedSections(); // re-filter the already-fetched BOOKED_PROPERTIES for the new tab
  renderRecentlyViewed();
  renderShortlistPanel();
}

function switchTabMobile(el) {
  document.querySelectorAll('.bottom-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  currentTab = el.dataset.tab;
  syncDesktopTab();
  syncFdBar();
  clearFiltersHiddenByTab();
  buildFilterOptions(); // rebuild dropdown options from only this tab's data (Rent/Lease/PG/ShortStay)
  closeAllFd();
  updateAllOnlySections();
  renderCards();
  renderBookedSections(); // re-filter the already-fetched BOOKED_PROPERTIES for the new tab
  renderRecentlyViewed();
  renderShortlistPanel();
}

function syncMobileTab() {
  document.querySelectorAll('.bottom-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === currentTab);
  });
}

function syncDesktopTab() {
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === currentTab);
  });
}

/* ═══════════════════════════════════════════════
   SEARCH
═══════════════════════════════════════════════ */
function handleSearch() {
  searchQuery = document.getElementById('searchInput').value.trim();
  renderCards();
}


/* ═══════════════════════════════════════════════
   FILTERS — Dropdown system
═══════════════════════════════════════════════ */

/* Map each dropdown id → which data-filter keys live inside it */
const FD_GROUPS = {
  type:       ['propertyType'],
  propertyIdFilter: ['propertyIdCode'],
  pincode:    ['pincode'],
  locality:   ['locality'],
  bhk:        ['bhk'],
  negotiable: ['negotiable'],
  furnishing: ['furnishing'],
  tenant:     ['tenant'],
  facing:     ['facing'],
  bathrooms:  ['bathrooms'],
  age:        ['age'],
  availFrom:  ['_availBucket'],
  escalation: ['_escalationBucket'],
  floor:      ['_floorBucket'],
  area:       ['_areaBucket'],
  leaseDuration: ['leaseDuration'],
  leaseType:     ['leaseType'],
  lockIn:        ['lockIn'],
  amenities:  ['amenities'],
  facilities: ['lift','carpark','bikepark','verified'],
  pgGender:   ['pgGender'],
  pgRoom:     ['pgRoomType'],
  pgMeals:    ['pgMeals','pgFoodType'],
  pgOccupancy:  ['pgOccupancy'],
  pgGateTime:   ['pgGateTime'],
  pgVisitors:   ['pgVisitors'],
  ssCancellation: ['ssCancellation'],
  ssCouples:      ['ssCouples'],
};

let openFd = null;

/* ── Build dropdown options dynamically from PROPERTIES data ── */

/* Short display labels for known values (falls back to the raw value if absent) */
const FD_LABELS = {
  facing: { 'North-East':'NE', 'North-West':'NW', 'South-East':'SE', 'South-West':'SW' },
  age: { 'Less than 1 Year':'<1 Year', '1-5 Years':'1–5 Yrs', '5-10 Years':'5–10 Yrs' },
};

/* Preferred sort order for fields where natural/alpha sort looks wrong */
const FD_SORT_ORDER = {
  facing: ['North','South','East','West','North-East','North-West','South-East','South-West'],
  age: ['Under Construction','Less than 1 Year','1-5 Years','5-10 Years','10+ Years'],
  furnishing: ['Furnished','Fully Furnished','Semi-Furnished','Unfurnished'],
  bathrooms: ['1','2','3','4','Yes','Shared'],
  pgMeals: ['All 3 Meals','Breakfast only','No meals'],
  leaseDuration: ['6 Months','12 Months','24 Months','36 Months','48 Months','48+ Months','1 Year','2 Years','3 Years','5 Years','9 Years','15 Years','30 Years'],
  leaseType: ['Residential','Commercial','Industrial','Mixed Use'],
  lockIn: ['1 Year','2 Years','3 Years'],
  pgGateTime: ['9 PM','10 PM','11 PM'],
  pgVisitors: ['Allowed','Lobby Only','Not Allowed'],
};

function fdLabel(filterKey, val) {
  return (FD_LABELS[filterKey] && FD_LABELS[filterKey][val]) || val;
}

function fdSortValues(filterKey, values) {
  const order = FD_SORT_ORDER[filterKey];
  if (order) {
    return values.slice().sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }
  // Numeric-aware sort (handles "1 RK","1 BHK","2 BHK"... and plain numbers like bathrooms)
  return values.slice().sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

/* Maps the legacy flat filter-key names (used as .dataset.filter values throughout
   the filter-dropdown markup) to their nested-object path in the new property shape. */
const FILTER_FIELD_PATHS = {
  propertyType: ['property','type'],
  bhk:          ['property','bhk'],
  furnishing:   ['property','furnish'],
  tenant:       ['property','tenant'],
  facing:       ['property','facing'],
  bathrooms:    ['property','bathrooms'],
  age:          ['property','age'],
  leaseDuration:['terms','lease'],
  leaseType:    ['terms','leaseType'],
  lockIn:       ['terms','lockIn'],
  pgGender:     ['pg','gender'],
  pgPropertyType: ['pg','type'],
  pgRoomType:   ['pg','room'],
  pgMeals:      ['pg','meals'],
  pgFoodType:   ['pg','food'],
  pgBathroom:   ['pg','bathroom'],
  pgOccupancy:  ['pg','occupancy'],
  pgFurnishing: ['pg','furnish'],
  pgGateTime:   ['pg','gateTime'],
  pgVisitors:   ['pg','visitors'],
  ssRoomType:     ['shortStay','roomType'],
  ssPropertyType: ['shortStay','type'],
  ssCancellation: ['shortStay','cancellation'],
  ssCouples:      ['shortStay','couplesAllowed'],
  ssFurnishing:   ['shortStay','furnish'],
};
function pFieldByPath(p, pathArr) {
  return pathArr.reduce((o, k) => (o == null ? o : o[k]), p);
}

/* Collect the distinct values present in PROPERTIES for a simple scalar field
   (field is a legacy flat key resolved via FILTER_FIELD_PATHS to its nested path).
   Always scoped to the currently active tab first (matchesTab), so switching
   Rent/Lease/PG/Short Stay rebuilds each dropdown from only that type's data —
   "All"/"Promoted"/"Verified" tabs still pool across types, same as the card grid does. */
function fdCollectValues(field, predicate) {
  const set = new Set();
  const path = FILTER_FIELD_PATHS[field] || [field];
  PROPERTIES.forEach(p => {
    if (!matchesTab(p, currentTab)) return;
    if (predicate && !predicate(p)) return;
    const v = pFieldByPath(p, path);
    if (v === null || v === undefined || v === '') return;
    if (field === 'tenant') {
      String(v).split(',').map(s => s.trim()).filter(Boolean).forEach(t => set.add(t));
    } else {
      set.add(String(v).trim());
    }
  });
  return Array.from(set);
}

/* Collect values across several legacy field keys and union them — used to
   merge filters that mean the same thing but live in different nested paths
   depending on listing type (e.g. Furnishing = property.furnish for
   Rent/Lease, pg.furnish for PG; Room type = pg.room for PG, shortStay.roomType
   for Short Stay). Inherits the same tab scoping from fdCollectValues. */
function fdCollectMerged(fields, predicate) {
  const set = new Set();
  fields.forEach(f => fdCollectValues(f, predicate).forEach(v => set.add(v)));
  return Array.from(set);
}

/* Collect distinct property ids (the QWR001-style codes, not the Mongo
   _id) present in PROPERTIES, scoped to the active tab — same pattern as
   fdCollectPincodes. Used by the owner-facing Property ID filter.
   Ordered by listed_on (createdAt, ascending) to match how the property
   cards themselves are ordered — not alphabetically, since these codes
   start with 3 random letters (see propertyListedAt) that carry no
   meaning to sort by. */
function fdCollectPropertyIds() {
  const seen = new Set();
  const rows = [];
  PROPERTIES.forEach(p => {
    if (!matchesTab(p, currentTab)) return;
    if (!p.propertyId || seen.has(p.propertyId)) return;
    seen.add(p.propertyId);
    rows.push(p);
  });
  rows.sort((a, b) => propertyListedAt(a) - propertyListedAt(b));
  return rows.map(p => p.propertyId);
}

/* Collect distinct pincodes present in PROPERTIES, scoped to the active tab.
   Uses getPropertyPincode() (defined further below) so listings that only
   have a free-text address — no explicit location.pincode saved yet — still
   show up, matching the same fallback logic used by the "Near me" filter. */
function fdCollectPincodes() {
  const set = new Set();
  PROPERTIES.forEach(p => {
    if (!matchesTab(p, currentTab)) return;
    const pin = getPropertyPincode(p);
    if (pin) set.add(pin);
  });
  return Array.from(set);
}

/* Collect distinct localities (location.area, e.g. "Singasandra, AECS
   Layout") present in PROPERTIES, scoped to the active tab — same pattern
   as fdCollectPincodes, just against the free-text area field instead. */
function fdCollectLocalities() {
  const set = new Set();
  PROPERTIES.forEach(p => {
    if (!matchesTab(p, currentTab)) return;
    const area = (p.location?.area || '').trim();
    if (area) set.add(area);
  });
  return Array.from(set);
}

/* Collect distinct amenity names, stripping quantity suffixes like " ×2".
   Also scoped to the currently active tab, same as fdCollectValues. */
function fdCollectAmenities() {
  const set = new Set();
  PROPERTIES.forEach(p => {
    if (!matchesTab(p, currentTab)) return;
    (p.amenities?.selected || []).forEach(a => {
      const clean = String(a).replace(/\s*×\s*\d+\s*$/, '').trim();
      if (clean) set.add(clean);
    });
  });
  return Array.from(set);
}

/* Render a list of values into a target <div class="fd-opts" id="..."> as .fp-opt pills */
function fdRenderOpts(containerId, filterKey, values, fdGroupId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  values.forEach(val => {
    const opt = document.createElement('div');
    opt.className = 'fp-opt';
    opt.dataset.filter = filterKey;
    opt.dataset.val = val;
    opt.textContent = fdLabel(filterKey, val);
    opt.addEventListener('click', () => toggleOpt(opt, fdGroupId));
    container.appendChild(opt);
  });
}

/* Build every data-driven dropdown's options from current PROPERTIES contents.
   Preserves any options that are currently selected (.sel) so re-running this
   after new data is added (e.g. a new listing) doesn't clear active filters. */
function buildFilterOptions() {
  // Remember currently-selected values per filter key before we wipe the DOM
  const prevSel = {};
  document.querySelectorAll('.fp-opt.sel').forEach(el => {
    const key = el.dataset.filter;
    if (!prevSel[key]) prevSel[key] = new Set();
    prevSel[key].add(el.dataset.val);
  });
  // One-shot restore after a page refresh (see restoreFilterStateBeforeBuild) —
  // merge in on top of whatever's already live in the DOM.
  if (pendingRestoreSel) {
    Object.keys(pendingRestoreSel).forEach(key => {
      if (!prevSel[key]) prevSel[key] = new Set();
      pendingRestoreSel[key].forEach(v => prevSel[key].add(v));
    });
    pendingRestoreSel = null;
  }

  // filterKey/fdGroupId are the same values passed to the fdRenderOpts()
  // call just above each restoreSel() call — needed so that a value
  // selected under a different tab (e.g. a pincode/locality/BHK that only
  // exists among that other tab's listings) can be recreated as a pill here
  // instead of just vanishing because this tab's live data doesn't have it.
  function restoreSel(containerId, filterKey, fdGroupId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const set = prevSel[filterKey];
    if (!set) return;
    const seen = new Set();
    container.querySelectorAll('.fp-opt').forEach(opt => {
      if (set.has(opt.dataset.val)) { opt.classList.add('sel'); seen.add(opt.dataset.val); }
    });
    set.forEach(val => {
      if (seen.has(val)) return;
      const opt = document.createElement('div');
      opt.className = 'fp-opt sel';
      opt.dataset.filter = filterKey;
      opt.dataset.val = val;
      opt.textContent = fdLabel(filterKey, val);
      opt.addEventListener('click', () => toggleOpt(opt, fdGroupId));
      container.appendChild(opt);
    });
  }

  // Property type now shows on Rent/Lease, PG, and Short Stay tabs alike —
  // merge options from all listing types into one shared dropdown.
  fdRenderOpts('fdo-type', 'propertyType',
    fdSortValues('propertyType', fdCollectMerged(['propertyType','pgPropertyType','ssPropertyType'])), 'type');
  restoreSel('fdo-type', 'propertyType', 'type');

  // Property ID dropdown — owner-facing, lets someone with many listings
  // jump straight to a specific one by its code. Rebuilt from live data
  // like Pincode/Locality. Passed straight through (not via fdSortValues,
  // which would alphabetize it — meaningless here since these codes start
  // with 3 random letters) since fdCollectPropertyIds already returns them
  // in listed_on order, matching how the property cards themselves sort.
  fdRenderOpts('fdo-propertyIdFilter', 'propertyIdCode', fdCollectPropertyIds(), 'propertyIdFilter');
  restoreSel('fdo-propertyIdFilter', 'propertyIdCode', 'propertyIdFilter');

  // Pincode dropdown — rebuilt from whatever's actually in PROPERTIES right
  // now, so newly added/verified listings' pincodes appear without any
  // hardcoded list to maintain.
  fdRenderOpts('fdo-pincode', 'pincode', fdSortValues('pincode', fdCollectPincodes()), 'pincode');
  restoreSel('fdo-pincode', 'pincode', 'pincode');
  fdHighlightNearbyPincode();

  // Locality dropdown — same "rebuilt from live data" pattern, driven by
  // location.area instead of pincode. Alphabetical (fdSortValues falls back
  // to localeCompare for non-numeric values, which is what we want here).
  fdRenderOpts('fdo-locality', 'locality', fdSortValues('locality', fdCollectLocalities()), 'locality');
  restoreSel('fdo-locality', 'locality', 'locality');

  fdRenderOpts('fdo-bhk', 'bhk',
    fdSortValues('bhk', fdCollectValues('bhk')), 'bhk');
  restoreSel('fdo-bhk', 'bhk', 'bhk');

  // Furnishing now shows on Rent/Lease, PG, and Short Stay tabs alike — merge
  // options from all listing types into one shared dropdown.
  fdRenderOpts('fdo-furnishing', 'furnishing',
    fdSortValues('furnishing', fdCollectMerged(['furnishing','pgFurnishing','ssFurnishing'])), 'furnishing');
  restoreSel('fdo-furnishing', 'furnishing', 'furnishing');

  fdRenderOpts('fdo-tenant', 'tenant',
    fdSortValues('tenant', fdCollectValues('tenant')), 'tenant');
  restoreSel('fdo-tenant', 'tenant', 'tenant');

  fdRenderOpts('fdo-facing', 'facing',
    fdSortValues('facing', fdCollectValues('facing')), 'facing');
  restoreSel('fdo-facing', 'facing', 'facing');

  // Bathrooms now shows on Rent/Lease and PG tabs alike — merge options from
  // both listing types (numeric bathroom count for Rent/Lease, Yes/Shared for PG).
  fdRenderOpts('fdo-bathrooms', 'bathrooms',
    fdSortValues('bathrooms', fdCollectMerged(['bathrooms','pgBathroom'])), 'bathrooms');
  restoreSel('fdo-bathrooms', 'bathrooms', 'bathrooms');

  fdRenderOpts('fdo-age', 'age',
    fdSortValues('age', fdCollectValues('age')), 'age');
  restoreSel('fdo-age', 'age', 'age');

  fdRenderOpts('fdo-leaseDuration', 'leaseDuration',
    fdSortValues('leaseDuration', fdCollectValues('leaseDuration', p => pTypeLabel(p) === 'Rent' || pTypeLabel(p) === 'Lease')), 'leaseDuration');
  restoreSel('fdo-leaseDuration', 'leaseDuration', 'leaseDuration');

  fdRenderOpts('fdo-leaseType', 'leaseType',
    fdSortValues('leaseType', fdCollectValues('leaseType', p => pTypeLabel(p) === 'Lease')), 'leaseType');
  restoreSel('fdo-leaseType', 'leaseType', 'leaseType');

  fdRenderOpts('fdo-lockIn', 'lockIn',
    fdSortValues('lockIn', fdCollectValues('lockIn', p => pTypeLabel(p) === 'Lease')), 'lockIn');
  restoreSel('fdo-lockIn', 'lockIn', 'lockIn');

  fdRenderOpts('fdo-amenities', 'amenities',
    fdSortValues('amenities', fdCollectAmenities()), 'amenities');
  restoreSel('fdo-amenities', 'amenities', 'amenities');

  fdRenderOpts('fdo-ssCancellation', 'ssCancellation',
    fdSortValues('ssCancellation', fdCollectValues('ssCancellation', p => pTypeLabel(p) === 'ShortStay')), 'ssCancellation');
  restoreSel('fdo-ssCancellation', 'ssCancellation', 'ssCancellation');

  fdRenderOpts('fdo-ssCouples', 'ssCouples',
    fdSortValues('ssCouples', fdCollectValues('ssCouples', p => pTypeLabel(p) === 'ShortStay')), 'ssCouples');
  restoreSel('fdo-ssCouples', 'ssCouples', 'ssCouples');

  // Refresh badges/has-sel state for every dropdown after rebuilding
  Object.keys(FD_GROUPS).forEach(id => refreshFdBtn(id));
}

function syncFdBar() {
  const bar = document.getElementById('filterDdBar');
  if (!bar) return;
  bar.classList.remove('tab-all','tab-rent','tab-lease','tab-pg','tab-promoted','tab-shortstay','tab-sell');
  bar.classList.add('tab-' + currentTab.toLowerCase());
}

/* Toggle a dropdown open/closed */
/* ── Robust body-scroll lock for modals/panels/overlays ──
   Plain `overflow:hidden` on <body> is what every modal here used to set,
   but iOS Safari still lets touch/momentum scrolling bleed through to the
   page behind a modal even with that set. Pinning the body with
   position:fixed (restoring the exact scroll offset on unlock) is the
   reliable cross-browser fix. Counter-based so nested/stacked modals
   (e.g. opening a picker on top of another modal) don't unlock too early. */
let _scrollLockCount = 0;
let _scrollLockY = 0;
function lockBodyScroll() {
  if (_scrollLockCount === 0) {
    _scrollLockY = window.scrollY || window.pageYOffset || 0;
    document.body.style.position = 'fixed';
    document.body.style.top = (-_scrollLockY) + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
  }
  _scrollLockCount++;
}
function unlockBodyScroll() {
  _scrollLockCount = Math.max(0, _scrollLockCount - 1);
  if (_scrollLockCount === 0) {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    window.scrollTo(0, _scrollLockY);
  }
}

function toggleFd(id, btnEl) {
  const pop = document.getElementById('fdp-' + id);
  if (!pop) return;
  const isOpen = pop.classList.contains('open');
  closeAllFd();
  if (!isOpen) {
    // Move pop to body so it escapes overflow:hidden/auto containers
    if (pop.parentElement !== document.body) document.body.appendChild(pop);

    const rect = btnEl.getBoundingClientRect();
    const popW = 240; // min-width estimate; adjust after open
    let left = rect.left;
    // If it would overflow right edge, pin to right of button instead
    if (left + popW > window.innerWidth - 12) left = Math.max(8, rect.right - popW);

    pop.style.top  = (rect.bottom + 6) + 'px';
    pop.style.left = left + 'px';
    pop.style.right = '';

    pop.classList.add('open');
    btnEl.classList.add('open');
    openFd = id;

    // After render, re-check if it overflows right or bottom
    requestAnimationFrame(() => {
      const pr = pop.getBoundingClientRect();
      if (pr.right > window.innerWidth - 8) {
        pop.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
      }
      if (pr.bottom > window.innerHeight - 8) {
        // Flip above the button if there's more room there; otherwise just
        // pin it to the bottom of the viewport so it's always fully reachable.
        const spaceAbove = rect.top - 8;
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        if (spaceAbove > spaceBelow) {
          pop.style.top = Math.max(8, rect.top - pr.height - 6) + 'px';
        } else {
          pop.style.top = Math.max(8, window.innerHeight - pr.height - 8) + 'px';
        }
      }
    });
  }
}

function closeAllFd() {
  document.querySelectorAll('.fd-pop.open').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('.fd-btn.open').forEach(b => b.classList.remove('open'));
  openFd = null;
}

/* Toggle a pill option and update its dropdown badge */
function toggleOpt(el, group) {
  el.classList.toggle('sel');
  if (group) refreshFdBtn(group);
  renderCards();
}

/* Refresh a button's badge based on selected opts + range state */
function refreshFdBtn(id) {
  const btn  = document.getElementById('fdb-' + id);
  const badge = document.getElementById('fdbc-' + id);
  if (!btn) return;

  const keys = FD_GROUPS[id] || [];
  let selCount = 0;
  keys.forEach(k => {
    selCount += document.querySelectorAll(`#fdp-${id} .fp-opt[data-filter="${k}"].sel`).length;
  });

  const hasAny = selCount > 0;
  btn.classList.toggle('has-sel', hasAny);

  if (badge) {
    if (selCount > 0) {
      badge.textContent = selCount;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
  refreshTotalBadge();
}

function refreshTotalBadge() {
  const total = document.querySelectorAll('.fp-opt.sel').length + fdActiveRangeCount();

  const badge = document.getElementById('fdTotalBadge');
  const clearBtn = document.getElementById('fdClearAll');
  if (badge) { badge.textContent = total; badge.classList.toggle('show', total > 0); }
  if (clearBtn) clearBtn.style.display = total > 0 ? '' : 'none';
}

/* Live-filters a dropdown's option pills as the owner types in its search
   box — every option-list filter has one (see fdSearchOpts wiring in the
   HTML). Case-insensitive substring match against each pill's visible
   text; non-matching pills are hidden via .fd-hidden rather than removed,
   so selections survive typing and clearing the search back out. */
function fdSearchOpts(containerId, query) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const q = query.trim().toLowerCase();
  container.querySelectorAll('.fp-opt').forEach(opt => {
    const match = !q || opt.textContent.toLowerCase().includes(q);
    opt.classList.toggle('fd-hidden', !match);
  });
}

/* Apply = close popover and rerender */
function applyFd(id) {
  refreshFdBtn(id);
  closeAllFd();
  renderCards();
}

/* Clear a single dropdown */
function clearFd(id) {
  const pop = document.getElementById('fdp-' + id);
  if (pop) {
    pop.querySelectorAll('.fp-opt.sel').forEach(o => o.classList.remove('sel'));
    // Reset any search box in this dropdown (e.g. Property ID) and
    // un-hide every pill it had filtered out.
    const search = pop.querySelector('.fd-search');
    if (search) search.value = '';
    pop.querySelectorAll('.fp-opt.fd-hidden').forEach(o => o.classList.remove('fd-hidden'));
  }
  refreshFdBtn(id);
  renderCards();
}

/* Clear all filters */
function clearFilters() {
  document.querySelectorAll('.fp-opt.sel').forEach(o => o.classList.remove('sel'));
  document.querySelectorAll('.fd-search').forEach(s => s.value = '');
  document.querySelectorAll('.fp-opt.fd-hidden').forEach(o => o.classList.remove('fd-hidden'));
  Object.keys(FD_GROUPS).forEach(id => refreshFdBtn(id));
  FD_RANGE_IDS.forEach(id => {
    const minEl = document.getElementById('fd-' + id + '-min');
    const maxEl = document.getElementById('fd-' + id + '-max');
    if (minEl) minEl.value = '';
    if (maxEl) maxEl.value = '';
    refreshFdRangeBtn(id, true);
  });
  closeAllFd();
  renderCards();
}

/* ── Unified min/max range filters: Price, Deposit, Maintenance ──
   These apply the same underlying field (price.rent / price.deposit /
   price.maintenance) across every property type — Rent, Lease, PG, and
   Short Stay — instead of type-specific preset buckets. The user types
   any custom range, e.g. 0–10000, or leaves Max blank for "0 and above". */
const FD_RANGE_IDS = ['price', 'deposit', 'maintenance'];

function fdActiveRangeCount() {
  let n = 0;
  FD_RANGE_IDS.forEach(id => {
    const minEl = document.getElementById('fd-' + id + '-min');
    const maxEl = document.getElementById('fd-' + id + '-max');
    if ((minEl && minEl.value !== '') || (maxEl && maxEl.value !== '')) n++;
  });
  return n;
}

/* Refresh a range button's badge/has-sel state based on whether Min/Max
   have values. Pass skipRender=true to avoid re-rendering cards (used when
   just clearing inputs, where the caller already triggers a render). */
function refreshFdRangeBtn(id, skipRender) {
  const btn = document.getElementById('fdb-' + id);
  const badge = document.getElementById('fdbc-' + id);
  const minEl = document.getElementById('fd-' + id + '-min');
  const maxEl = document.getElementById('fd-' + id + '-max');
  const hasAny = !!((minEl && minEl.value !== '') || (maxEl && maxEl.value !== ''));

  if (btn) btn.classList.toggle('has-sel', hasAny);
  if (badge) {
    badge.textContent = '1';
    badge.style.display = hasAny ? '' : 'none';
  }
  refreshTotalBadge();
  if (!skipRender) renderCards();
}

/* Apply = close popover and rerender (values are already live via oninput,
   this just matches the existing Apply-button UX used by every other filter) */
function applyFdRange(id) {
  refreshFdRangeBtn(id, true);
  closeAllFd();
  renderCards();
}

/* Clear a single range filter's Min/Max inputs */
function clearFdRange(id) {
  const minEl = document.getElementById('fd-' + id + '-min');
  const maxEl = document.getElementById('fd-' + id + '-max');
  if (minEl) minEl.value = '';
  if (maxEl) maxEl.value = '';
  refreshFdRangeBtn(id, true);
  renderCards();
}

function fmtRupee(n) {
  n = Number(n) || 0;
  const trim = x => x.toFixed(2).replace(/\.?0+$/, '');
  if (n >= 10000000) return '₹' + trim(n/10000000) + 'Cr';
  if (n >= 100000)   return '₹' + trim(n/100000) + 'L';
  if (n >= 1000)     return '₹' + trim(n/1000) + 'K';
  return '₹' + n;
}

// Responsive rupee amount: shows the full comma-separated figure (₹30,000)
// on desktop, and falls back to fmtRupee()'s abbreviated K/L/Cr form
// (₹1L) on mobile, where card width is tight. Both spans are always
// rendered; CSS (.amt-full / .amt-short, see the max-width:640px block)
// decides which one is visible — same pattern as .unit-full/.unit-short.
function fmtRupeeResponsive(n, noSymbol) {
  n = Number(n) || 0;
  const sym = noSymbol ? '' : '₹';
  const full = sym + n.toLocaleString('en-IN');
  const short = (noSymbol ? fmtRupee(n).replace('₹','') : fmtRupee(n));
  return `<span class="amt-full">${full}</span><span class="amt-short">${short}</span>`;
}

// Builds the price row as equally-divided chip cells: rent always shown,
// plus maintenance and/or security deposit when applicable. Column count
// (and therefore each chip's width) adapts to how many are actually present
// — 1 (rent alone), 2 (rent + one of maintenance/deposit), or 3 (all three).
function priceChipsHTML(p, pType, deposit, maintenance, leaseDur, opts) {
  const rentUnit = pType === 'Sell' ? '' : pType === 'Lease' ? (fmtLeaseDur(leaseDur) || 'Lease') : pType === 'ShortStay' ? ' Day' : 'Month';
  const rentUnitShort = pType === 'Sell' ? '' : pType === 'Lease' ? (fmtLeaseDur(leaseDur) || 'Lease') : pType === 'ShortStay' ? ' Day' : 'Mo';
  const maintSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  const rentSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>';
  const depositSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="2.5"/></svg>';

  const rentChip = `<div class="prop-chip price-chip price-chip-rent">
    <span class="price-ico-3d">${rentSvg}</span>
    <span class="price-text-stack">
      <span class="prop-price">₹${fmtRupeeResponsive(p.price?.rent||0, true)}${pType === 'Sell' ? '' : `<span class="prop-price-unit">/ <span class="unit-full">${rentUnit}</span><span class="unit-short">${rentUnitShort}</span></span>`}</span>
    </span>
  </div>`;
  const maintChip = maintenance > 0 ? `<div class="prop-chip price-chip" title="Monthly maintenance">
    <span class="price-ico-3d">${maintSvg}</span>
    <span class="price-text-stack">
      <span class="prop-deposit-val">₹${fmtRupeeResponsive(maintenance, true)}</span>
      <span class="prop-deposit-lbl"><span class="unit-full">Maintenance</span><span class="unit-short">Maint</span></span>
    </span>
  </div>` : '';
  const depositChip = deposit > 0 ? `<div class="prop-chip price-chip" title="Security deposit">
    <span class="price-ico-3d">${depositSvg}</span>
    <span class="price-text-stack">
      <span class="prop-deposit-val">₹${fmtRupeeResponsive(deposit, true)}</span>
      <span class="prop-deposit-lbl"><span class="unit-full">Deposit</span><span class="unit-short">SD</span></span>
    </span>
  </div>` : '';

  const inRibbon = !!(opts && opts.ribbon);
  const chips = [rentChip];
  if (pType === 'ShortStay') {
    // rent only
  } else if (pType === 'Lease') {
    if (maintChip && !inRibbon) chips.push(maintChip);
  } else {
    if (maintChip && !inRibbon) chips.push(maintChip);
    if (depositChip) chips.push(depositChip);
  }
  const gridCols = chips.length >= 2 ? `repeat(${chips.length},1fr)` : `repeat(${chips.length},auto)`;
  const equalClass = chips.length >= 2 ? ' price-chips-equal' : '';
  const scrollClass = chips.length > 2 ? ' price-chips-scroll' : '';
  const inner = `<div class="prop-price-chips${scrollClass}${equalClass}" style="grid-template-columns:${gridCols}">${chips.join('')}</div>`;
  if (opts && opts.ribbon) {
    // Ribbon mode: only a single chip (rent alone, e.g. Short Stay) hugs its
    // content — with 2 or 3 chips the bar spans the full image width and
    // the chips divide it equally.
    const fitClass = chips.length < 2 ? ' prop-img-price-fit' : '';
    return `<div class="prop-img-price${fitClass}">${inner}</div>`;
  }
  return inner;
}

// Abbreviates lease-duration strings for the tight "20L/2yrs" price display,
// e.g. "2 Years" -> "2yrs", "18 Months" -> "18mo". Falls back to the raw
// string for anything that doesn't match the expected "<N> Year(s)/Month(s)"
// shape from the lease-duration dropdowns.
function fmtLeaseDur(s) {
  if (!s) return '';
  let m = s.match(/^(\d+)\s*Year/i);
  if (m) return m[1] + ' Year' + (m[1] === '1' ? '' : 's');
  m = s.match(/^(\d+)(\+?)\s*Month/i);
  if (m) return m[1] + m[2] + ' Mo';
  return s;
}

/* Close dropdowns on outside click */
document.addEventListener('click', function(e) {
  if (!e.target.closest('.fd-btn') && !e.target.closest('.fd-pop')) closeAllFd();
});
/* The popover is appended to <body> with fixed pixel coordinates computed
   from the trigger button's position (see toggleFd). Rather than closing
   it every time the page scrolls, just recompute those coordinates so it
   keeps tracking its button — the filter bar itself is sticky, so once it
   reaches the top of the viewport the button stops moving anyway. */
window.addEventListener('scroll', function() {
  if (!openFd) return;
  const active = document.activeElement;
  if (active && active.closest('.fd-pop')) return;
  const btnEl = document.getElementById('fdb-' + openFd);
  const pop = document.getElementById('fdp-' + openFd);
  if (!btnEl || !pop) { closeAllFd(); return; }
  const rect = btnEl.getBoundingClientRect();
  // Button scrolled out of view entirely (e.g. horizontal filter-bar
  // scroll) — closing is still the right call here.
  if (rect.bottom < 0 || rect.top > window.innerHeight) { closeAllFd(); return; }
  const popW = pop.getBoundingClientRect().width || 240;
  let left = rect.left;
  if (left + popW > window.innerWidth - 12) left = Math.max(8, rect.right - popW);
  pop.style.top  = (rect.bottom + 6) + 'px';
  pop.style.left = left + 'px';
}, true);
window.addEventListener('resize', () => {
  // On mobile, focusing one of the Min/Max range inputs opens the on-screen
  // keyboard, which shrinks the visual viewport and fires this same resize
  // event — closing the dropdown right then would blur the input and dismiss
  // the keyboard before a single digit could be typed. Only auto-close for
  // resizes that aren't just the keyboard appearing over an active field.
  const active = document.activeElement;
  if (active && active.closest('.fd-pop')) return;
  closeAllFd();
});

/* ═══════════════════════════════════════════════
   FILTER STATE PERSISTENCE (survive a refresh, a closed
   browser, even a different device once logged in)
   Saved to localStorage, scoped per logged-in user (see
   filterStateKey()) — the same account sees its filters again
   on any browser it logs into; a guest gets a shared "guest"
   slot that a fresh login doesn't inherit. Every renderCards()
   call re-saves, so this always mirrors the live DOM state;
   restoring only happens once, right before the very first
   buildFilterOptions() call, via pendingRestoreSel (consumed
   by buildFilterOptions/restoreSel below) so a restored
   selection gets the same "recreate the pill even if this
   tab's data doesn't have it" treatment as a normal tab switch
   — see restoreSel(). */
const FILTER_STATE_KEY = 'homeloop_filterState';
let pendingRestoreSel = null;   // one-shot: consumed by buildFilterOptions()
let _initialFilterRestoreDone = false;

// Scopes the storage key to whoever's logged in (getLoggedInUser() is
// declared further below but hoisted, so this is safe to call here) —
// falls back to a shared guest key when nobody's logged in. Keeps two
// people sharing a browser (or a guest, then an account) from seeing
// each other's filters.
function filterStateKey() {
  const user = getLoggedInUser();
  const uid = user && (user.id || user.userId || user.email);
  return uid ? `${FILTER_STATE_KEY}:${uid}` : `${FILTER_STATE_KEY}:guest`;
}

function saveFilterState() {
  // Guard against the pre-data-load renderCards() call at page init (see
  // bottom-of-file INIT block): that call fires before fetchProperties()
  // resolves and restoreFilterStateBeforeBuild() has had a chance to run,
  // so saving here would overwrite last session's real filters with the
  // blank/default state and make it look like filters "reset on refresh."
  // Once the initial restore has run (_initialFilterRestoreDone), it's
  // safe to keep localStorage mirroring the live state on every render.
  if (!_initialFilterRestoreDone) return;
  try {
    localStorage.setItem(filterStateKey(), JSON.stringify({
      tab: currentTab,
      search: searchQuery,
      sel: getFilterState()
    }));
  } catch (e) { /* storage unavailable/full — fail silently */ }
}

function restoreFilterStateBeforeBuild() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(filterStateKey())); } catch (e) { saved = null; }
  if (!saved) return;

  if (saved.tab) {
    currentTab = saved.tab;
    const desktopBtn = document.querySelector(`.nav-tab[data-tab="${saved.tab}"]`);
    const mobileBtn = document.querySelector(`.bottom-tab[data-tab="${saved.tab}"]`);
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t === desktopBtn));
    document.querySelectorAll('.bottom-tab').forEach(t => t.classList.toggle('active', t === mobileBtn));
    syncFdBar();
    updateAllOnlySections();
  }

  if (saved.search) {
    searchQuery = saved.search;
    const input = document.getElementById('searchInput');
    if (input) input.value = saved.search;
  }

  const sel = saved.sel || {};

  // Range filters (Price/Deposit/Maintenance) live in static, always-present
  // number inputs — not rebuilt per tab — so they can be restored directly.
  const RANGE_MAP = {
    _priceMin: ['price', 'min'], _priceMax: ['price', 'max'],
    _depositMin: ['deposit', 'min'], _depositMax: ['deposit', 'max'],
    _maintenanceMin: ['maintenance', 'min'], _maintenanceMax: ['maintenance', 'max']
  };
  Object.keys(RANGE_MAP).forEach(k => {
    const val = sel[k];
    if (val === null || val === undefined) return;
    const [id, which] = RANGE_MAP[k];
    const el = document.getElementById(`fd-${id}-${which}`);
    if (el) el.value = val;
  });

  // Everything else (.fp-opt pill filters) is handed off to buildFilterOptions
  // via pendingRestoreSel rather than applied here directly, since the pill
  // elements themselves don't exist yet until buildFilterOptions renders them.
  // Note: some pill filters (Sqft/Available/Floor/Escalation) are also keyed
  // with a leading underscore, same convention as the RANGE_MAP number-input
  // keys above — so we skip only the RANGE_MAP keys specifically here, not
  // every underscore-prefixed key, or those pills silently drop on refresh.
  pendingRestoreSel = {};
  Object.keys(sel).forEach(key => {
    if (RANGE_MAP.hasOwnProperty(key)) return;
    if (Array.isArray(sel[key]) && sel[key].length) pendingRestoreSel[key] = new Set(sel[key]);
  });
}

/* Called right after login/signup/logout, once getLoggedInUser() reflects
   the new identity — swaps whatever's currently applied for that
   identity's own saved filters/tab (or the shared guest slot), instead of
   leaving the previous identity's selections showing until next refresh. */
function switchFilterIdentity() {
  document.querySelectorAll('.fp-opt.sel').forEach(o => o.classList.remove('sel'));
  FD_RANGE_IDS.forEach(id => {
    const minEl = document.getElementById('fd-' + id + '-min');
    const maxEl = document.getElementById('fd-' + id + '-max');
    if (minEl) minEl.value = '';
    if (maxEl) maxEl.value = '';
  });
  restoreFilterStateBeforeBuild();
  buildFilterOptions();
  renderCards();
}

/* ── Read all active filter state ── */
function getFilterState() {
  const state = {};
  document.querySelectorAll('.fp-opt.sel').forEach(el => {
    const key = el.dataset.filter, val = el.dataset.val;
    if (!key) return;
    if (!state[key]) state[key] = [];
    state[key].push(val);
  });

  /* Unified Price / Deposit / Maintenance min-max ranges (common to all
     property types) — read straight from the number inputs. */
  const fdRange = (id) => {
    const minEl = document.getElementById('fd-' + id + '-min');
    const maxEl = document.getElementById('fd-' + id + '-max');
    const min = minEl && minEl.value !== '' ? Number(minEl.value) : null;
    const max = maxEl && maxEl.value !== '' ? Number(maxEl.value) : null;
    return [min, max];
  };
  [state._priceMin, state._priceMax] = fdRange('price');
  [state._depositMin, state._depositMax] = fdRange('deposit');
  [state._maintenanceMin, state._maintenanceMax] = fdRange('maintenance');

  return state;
}

/* Check if a numeric value falls inside any of the selected "min-max" bucket strings.
   A bucket like "100000-" means open-ended (100000 and above). */
function fdValueInBuckets(value, buckets) {
  if (!buckets || buckets.length === 0) return true;
  const v = Number(value) || 0;
  return buckets.some(b => {
    const [minStr, maxStr] = b.split('-');
    const min = Number(minStr);
    const max = maxStr === '' ? Infinity : Number(maxStr);
    return v >= min && v < max;
  });
}

/* Rent escalation is stored like "5%" — strip the % and parse the number */
function fdEscalationNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  return parseFloat(String(v).replace('%', '')) || 0;
}
/* Floor is stored as free text ("G", "3rd", "12th"...) — treat Ground/G as 0 */
function fdFloorNum(v) {
  if (!v) return 0;
  const s = String(v).trim();
  if (/^g(round)?$/i.test(s)) return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}
/* Area is stored like "1200Sqft" — strip the suffix and parse the number */
function fdAreaNum(v) {
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}

/* Days between today and a YYYY-MM-DD date string (negative if already past) */
function fdDaysFromToday(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00');
  if (isNaN(target.getTime())) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((target - today) / 86400000);
}

/* Robust numeric coercion for price fields coming from the API — handles
   plain numbers, numeric strings, and (just in case older/legacy records
   have it) strings with stray currency symbols, commas, or text like
   "₹2,000" or "2000/month". Anything unparseable/missing becomes 0,
   exactly like the old bucket filters treated it. Used for rent/deposit/
   maintenance so Maintenance is parsed exactly as defensively as Price. */
function fdPriceNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Short Stay is on ice for now — flip this back to true (and re-show the
// nav tab / FAB option / menu item / add-listing type option below) to
// bring it back. Everything else (data model, filters, booking flow,
// rendering) is untouched so it can be switched on again with just these
// flips.
const SHORT_STAY_ENABLED = false;

// PG is on ice for now too, same pattern as Short Stay above (Sell has taken
// its spot in the main nav) — flip this back to true (and re-show the nav
// tab / bottom tab / FAB option / menu item below) to bring it back. Nothing
// about PG itself was removed: the data model, filters, listing form, and
// card rendering are all untouched.
const PG_ENABLED = false;

function getFiltered() {
  const fs = getFilterState();
  const hasFilters = Object.keys(fs).some(k => {
    const v = fs[k];
    return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
  });

  let list = PROPERTIES.filter(p => {
    if (!SHORT_STAY_ENABLED && pTypeLabel(p) === 'ShortStay') return false;
    if (!PG_ENABLED && pTypeLabel(p) === 'PG') return false;
    if (!matchesTab(p, currentTab)) return false;
    // NOTE: pType was previously used further down (Rent/Lease/PG-specific
    // filter checks) without ever being declared in this scope, which threw
    // a ReferenceError the moment any filter was selected — silently
    // breaking every filter dropdown. Declaring it here fixes that for the
    // existing Rent/Lease/PG filters too, not just the new Short Stay ones.
    const pType = pTypeLabel(p);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const area = (p.location?.area || '').toLowerCase();
      const bhk = (p.property?.bhk || '').toLowerCase();
      if (!area.includes(q) && !bhk.includes(q)) return false;
    }
    // Filters have no use on Explore/"All" (per KR) — the bar is hidden
    // there (see .filter-dd-bar.tab-all), so any filter state left over
    // from another tab must be ignored here too, or it'd keep silently
    // narrowing this view with no visible controls left to see or clear it.
    if (currentTab === 'All' || !hasFilters) return true;

    if (fs.propertyType) {
      const typeVal = p.property?.type ?? p.pg?.type ?? p.shortStay?.type;
      if (!fs.propertyType.includes(typeVal)) return false;
    }
    if (fs.propertyIdCode) {
      if (!fs.propertyIdCode.includes(p.propertyId)) return false;
    }
    if (fs.pincode) {
      if (!fs.pincode.includes(getPropertyPincode(p))) return false;
    }
    if (fs.locality) {
      if (!fs.locality.includes((p.location?.area || '').trim())) return false;
    }
    // Section-scoped filters below only ever narrow the listing types whose
    // filter bar actually shows that button (see the .fd-rent/.fd-lease/
    // .fd-pg/.fd-shortstay/.fd-sell classes on each fd-btn in the markup).
    // On a single-type tab this is a no-op (every row already matches), but
    // on the Promoted tab — which mixes every type together and shows every
    // filter button at once — it stops e.g. a Rent-only "BHK" filter from
    // wrongly excluding a promoted PG/ShortStay listing that simply has no
    // BHK value. Each block below is a no-op for out-of-scope types instead
    // of falling through to a false/empty-value comparison that would
    // otherwise exclude them.
    if (fs.bhk && ['Rent','Lease','Sell'].includes(pType)) {
      const bhkVal = (p.property?.bhk||'').trim();
      const match = fs.bhk.some(b => b==='4 BHK' ? parseInt(bhkVal)>=4 : bhkVal===b);
      if (!match) return false;
    }
    if (fs.furnishing) {
      const furnishVal = p.property?.furnish ?? p.pg?.furnish ?? p.shortStay?.furnish;
      if (furnishVal != null && furnishVal !== '' && !fs.furnishing.includes(furnishVal)) return false;
    }
    if (fs.tenant && ['Rent','Lease'].includes(pType)) {
      const tenantList = String(p.property?.tenant || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!fs.tenant.some(t => t==='Any' || tenantList.includes(t) || tenantList.includes('Any'))) return false;
    }
    if (fs.facing && ['Rent','Lease','Sell'].includes(pType) && !fs.facing.includes(p.property?.facing)) return false;
    if (fs.bathrooms && ['Rent','Lease','PG','Sell'].includes(pType)) {
      const pgBath = p.pg?.bathroom;
      if (pgBath != null && pgBath !== '') {
        if (!fs.bathrooms.includes(pgBath)) return false;
      } else {
        const baths = parseInt(p.property?.bathrooms)||0;
        if (baths > 0 && !fs.bathrooms.some(b => parseInt(b)===4 ? baths>=4 : baths===parseInt(b))) return false;
      }
    }
    if (fs.age && ['Rent','Lease','Sell'].includes(pType) && !fs.age.includes(p.property?.age)) return false;
    if (fs.negotiable && !fs.negotiable.includes(String(p.price?.negotiable || '').toLowerCase())) return false;
    if (fs._availBucket && ['Rent','Lease','PG','Sell'].includes(pType)) {
      const availVal = p.pg?.available ?? p.property?.available;
      const days = fdDaysFromToday(availVal);
      if (days === null || !fdValueInBuckets(Math.max(days, 0), fs._availBucket)) return false;
    }
    const lift = pHasLift(p);
    const carpark = (parseInt(p.pg?.car ?? p.property?.car, 10) || 0) > 0;
    const bikepark = (parseInt(p.pg?.bike ?? p.property?.bike, 10) || 0) > 0;
    if (fs.lift && fs.lift.includes('true') && !lift) return false;
    if (fs.carpark && fs.carpark.includes('true') && !carpark) return false;
    if (fs.bikepark && fs.bikepark.includes('true') && !bikepark) return false;
    if (fs.verified && fs.verified.includes('true') && !p.verified) return false;
    if (fs.amenities) {
      // Match against individual amenity entries (qty suffixes like " ×2" stripped)
      // rather than a single joined string, so short tokens like "AC" can't
      // false-positive match inside unrelated words such as "Terrace" or "backup".
      const pAmList = (p.amenities?.selected||[]).map(a => String(a).replace(/\s*×\s*\d+\s*$/, '').trim().toLowerCase());
      const hasToken = (needle) => pAmList.some(a => a === needle || a.split(/[\s/&]+/).includes(needle));
      if (!fs.amenities.every(a => {
        if (a==='Parking') return carpark||bikepark;
        if (a==='AC') return hasToken('ac');
        if (a==='Gym') return hasToken('gym')||hasToken('pool');
        if (a==='CCTV') return hasToken('security')||hasToken('cctv');
        return pAmList.includes(a.toLowerCase());
      })) return false;
    }
    /* Unified Price / Deposit / Maintenance range filters — same
       price.rent / price.deposit / price.maintenance fields, and the same
       Min/Max inputs, apply across Rent, Lease, PG, and Short Stay alike. */
    if (fs._priceMin != null && fdPriceNum(p.price?.rent) < fs._priceMin) return false;
    if (fs._priceMax != null && fdPriceNum(p.price?.rent) > fs._priceMax) return false;
    // Deposit is only shown on Rent/Lease/PG — guard it the same way as the
    // other section-scoped filters above, so it never wrongly filters out a
    // promoted Sell/ShortStay listing (which has no deposit field) on the
    // mixed-type Promoted tab.
    if (['Rent','Lease','PG'].includes(pType)) {
      if (fs._depositMin != null && fdPriceNum(p.price?.deposit) < fs._depositMin) return false;
      if (fs._depositMax != null && fdPriceNum(p.price?.deposit) > fs._depositMax) return false;
    }
    if (fs._maintenanceMin != null && fdPriceNum(p.price?.maintenance) < fs._maintenanceMin) return false;
    if (fs._maintenanceMax != null && fdPriceNum(p.price?.maintenance) > fs._maintenanceMax) return false;

    // Area / Floor range filters are shown on Rent, Lease, AND Sell only —
    // guarded here so they're a no-op for PG/ShortStay listings (which have
    // no floor/area concept) instead of excluding them via a null/0 mismatch.
    if (['Rent','Lease','Sell'].includes(pType)) {
      if (fs._floorBucket && !fdValueInBuckets(fdFloorNum(p.property?.floor), fs._floorBucket)) return false;
      if (fs._areaBucket && !fdValueInBuckets(fdAreaNum(p.property?.area), fs._areaBucket)) return false;
    }

    if (pType==='Rent') {
      if (fs._escalationBucket && !fdValueInBuckets(fdEscalationNum(p.price?.rentIncrease), fs._escalationBucket)) return false;
      if (fs.leaseDuration && !fs.leaseDuration.includes(p.terms?.lease)) return false;
    }
    if (pType==='Lease') {
      if (fs.leaseDuration && !fs.leaseDuration.includes(p.terms?.lease)) return false;
      if (fs.leaseType && !fs.leaseType.includes(p.terms?.leaseType)) return false;
      if (fs.lockIn && !fs.lockIn.includes(p.terms?.lockIn)) return false;
    }
    // PG-only filters must exclude non-PG properties outright (checked unconditionally,
    // not nested inside an `if (pType==='PG')` gate, otherwise Rent/Lease rows would
    // skip the check entirely and incorrectly pass through every PG filter).
    if (fs.pgGender) {
      if (pType!=='PG' || !fs.pgGender.includes(p.pg?.gender)) return false;
    }
    // Room type now shows on PG and Short Stay alike — soft-match whichever
    // field path applies (pg.room or shortStay.roomType); Rent/Lease listings
    // have neither field and pass through unaffected.
    if (fs.pgRoomType) {
      const roomVal = pType==='PG' ? p.pg?.room : pType==='ShortStay' ? p.shortStay?.roomType : null;
      if (roomVal != null && roomVal !== '' && !fs.pgRoomType.includes(roomVal)) return false;
    }
    if (fs.pgMeals) {
      if (pType!=='PG' || !fs.pgMeals.includes(p.pg?.meals)) return false;
    }
    if (fs.pgFoodType) {
      if (pType!=='PG' || !fs.pgFoodType.includes(p.pg?.food)) return false;
    }
    if (fs.pgOccupancy) {
      if (pType!=='PG' || !fs.pgOccupancy.includes(String(p.pg?.occupancy ?? ''))) return false;
    }
    if (fs.pgGateTime) {
      if (pType!=='PG' || !fs.pgGateTime.includes(p.pg?.gateTime)) return false;
    }
    if (fs.pgVisitors) {
      if (pType!=='PG' || !fs.pgVisitors.includes(p.pg?.visitors)) return false;
    }
    // Short-Stay-only filters — same unconditional-check pattern as the PG
    // filters above, so a Rent/Lease/PG row can never slip through them.
    if (fs.ssCancellation) {
      if (pType!=='ShortStay' || !fs.ssCancellation.includes(p.shortStay?.cancellation)) return false;
    }
    if (fs.ssCouples) {
      if (pType!=='ShortStay' || !fs.ssCouples.includes(p.shortStay?.couplesAllowed)) return false;
    }
    return true;
  });

  if (currentSort==='price-asc') list.sort((a,b)=>(a.price?.rent||0)-(b.price?.rent||0));
  else if (currentSort==='price-desc') list.sort((a,b)=>(b.price?.rent||0)-(a.price?.rent||0));
  else if (currentSort==='promoted') list.sort((a,b)=>(b.promoted?1:0)-(a.promoted?1:0));
  // Removed per KR: distance-based "Near me first" sort and the pincode-
  // match priority boost both used to reorder the grid based on the
  // visitor's location. Now every case (including 'nearby', if still
  // selected via old saved state) falls through to the same default —
  // ordered purely by listed_on (ascending), the property listed first
  // shows first, with no location signal touching the order at all.
  else list.sort((a, b) => propertyListedAt(a) - propertyListedAt(b));

  return list;
}

/* stubs so nothing breaks if old references exist */
function toggleChip(){}
function toggleFilters(){}
function applyFilters(){ closeAllFd(); renderCards(); }



/* ═══════════════════════════════════════════════
   NEARBY LOCATION
   Detects the visitor's current position (with permission),
   then sorts listings so the closest ones show first.
   Falls back silently (no error shown, no UI) if geolocation
   is unavailable, denied, or times out — the default sort
   just stays in place.
═══════════════════════════════════════════════ */
// Many older/imported listings never got location.pincode populated
// directly and only have the full free-text location.address (which
// still ends with a 6-digit Indian pincode before the state/country,
// e.g. "...Bengaluru Urban, Karnataka, 560095, India"). Prefer the
// explicit field when present, otherwise pull the pincode out of the
// address text so those listings can still match on pincode.
/* Property listing order — sorted by createdAt (the actual date/time the
   property was listed), ascending, so the first-ever listed property shows
   first. This is the authoritative "listed on" timestamp; parsing the
   number out of the property code is not used here since p.id is actually
   the MongoDB _id (not the QWR001-style code — that's p.propertyId), and
   createdAt is more direct anyway. */
function propertyListedAt(p) {
  const t = new Date(p.createdAt).getTime();
  return isNaN(t) ? 0 : t;
}

function getPropertyPincode(p) {
  if (p.location?.pincode) return String(p.location.pincode).trim();
  const address = p.location?.address || '';
  const matches = String(address).match(/\b\d{6}\b/g);
  return matches ? matches[matches.length - 1] : '';
}

/* Marks whichever pincode pill in the filter dropdown matches nearbyPincode
   (the visitor's reverse-geocoded postcode — see initNearbyLocation below)
   with the .fp-nearby class, so it visually stands out as "your area"
   without being auto-selected as a filter. Safe to call any time: clears
   any stale mark first, then re-applies (or does nothing if nearbyPincode
   isn't known yet, e.g. geolocation hasn't resolved). Called both after
   every dropdown rebuild (buildFilterOptions) and again once the reverse-
   geocode call finishes, since that can resolve after the dropdown already
   rendered. */
function fdHighlightNearbyPincode() {
  const container = document.getElementById('fdo-pincode');
  if (!container) return;
  container.querySelectorAll('.fp-opt.fp-nearby').forEach(el => el.classList.remove('fp-nearby'));
  if (!nearbyPincode) return;
  const match = container.querySelector(`.fp-opt[data-val="${CSS.escape(nearbyPincode.trim())}"]`);
  if (match) match.classList.add('fp-nearby');
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function initNearbyLocation() {
  if (!('geolocation' in navigator)) { console.log('[nearby-location] geolocation not supported on this browser/device'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      console.log('[nearby-location] got coords:', userCoords);
      // Auto-switch to "Near me first" only if the visitor hasn't manually
      // picked a sort yet. But if currentSort is already 'nearby' — either
      // from that auto-switch or because they picked it manually before we
      // had coordinates — re-render now that we finally have a position.
      if (!sortSetByUser) {
        currentSort = 'nearby';
        document.querySelectorAll('.sort-option').forEach(o => o.classList.remove('active'));
        const opt = document.querySelector('.sort-option[data-sort="nearby"]');
        if (opt) opt.classList.add('active');
      }
      if (currentSort === 'nearby') renderCards();
      // Reverse-geocode via Nominatim — the same source used to capture
      // each listing's address/pincode when it was added, so the postcode
      // format lines up on both sides. Feeds nearbyPincode and
      // nearbyAreaName, the fallback match signals used in getFiltered()
      // for listings that have no lat/lng saved. Its failure/latency
      // never blocks the distance-based sort above, which already ran.
      fetch(`https://nominatim.openstreetmap.org/reverse?lat=${userCoords.lat}&lon=${userCoords.lng}&format=json&accept-language=en`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          console.log('[nearby-location] reverse-geocode response:', data);
          if (!data || !data.address) { console.log('[nearby-location] no address in response — nearbyPincode stays empty'); return; }
          const addr = data.address;
          nearbyPincode = addr.postcode || '';
          nearbyAreaName = addr.suburb || addr.neighbourhood || addr.city_district || addr.city || '';
          console.log('[nearby-location] resolved nearbyPincode:', nearbyPincode, '| nearbyAreaName:', nearbyAreaName);
          fdHighlightNearbyPincode(); // mark the matching pill in the Pincode dropdown now that we know it
          if (nearbyPincode || nearbyAreaName) renderCards();
        })
        .catch(err => console.error('[nearby-location] reverse geocode error:', err));
    },
    (err) => console.error('[nearby-location] geolocation error:', err.message),
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 5 * 60 * 1000 }
  );
}

/* ═══════════════════════════════════════════════
   SORT
═══════════════════════════════════════════════ */
function toggleSort() {
  document.getElementById('sortModal').classList.toggle('open');
}
function closeSort() {
  document.getElementById('sortModal').classList.remove('open');
}
function setSort(el, val) {
  document.querySelectorAll('.sort-option').forEach(o => o.classList.remove('active'));
  el.classList.add('active');
  currentSort = val;
  sortSetByUser = true; // don't let a late-resolving geolocation callback override a manual pick
  closeSort();
  if (val === 'nearby' && !userCoords) initNearbyLocation(); // ask now if we don't have a position yet
  renderCards();
}

/* ═══════════════════════════════════════════════
   VIEW
═══════════════════════════════════════════════ */
function setView(type, btn) {
  isListView = type === 'list';
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderCards();
}

/* ═══════════════════════════════════════════════
   DETAIL MODAL
═══════════════════════════════════════════════ */
// Set while the "List your property" form/modal is being reused to show a
// read-only view of an existing listing (see openDetail below), so the
// shared open/close plumbing (backdrop click, the header X button, autosave)
// can tell the two uses apart and not clobber the user's own in-progress draft.
let propertyViewMode = false;
// Set to a listing's id while the "List your property" form is being reused
// to edit that *existing* listing (see openEditListingFull below). null
// means the form is in its normal "create a new listing" mode.
let editingPropertyId = null;

function openDetail(id) {
  const p = PROPERTIES.find(x => x.id === id) || BOOKED_PROPERTIES.find(x => x.id === id);
  if (!p) return;
  closeAllFd();        // clicks that reach here (card body, or an image/icon
                        // whose own onclick stopped propagation) may never
                        // reach the document-level listener that normally
                        // closes open filter dropdowns — close them here too
                        // so one doesn't stay floating (z-index:2000) on top
                        // of the detail modal
  incrementViews(p);   // count this open as a view, persisted to storage
  // Booked listings are read-only/off-market — they don't belong in Recently
  // Viewed, so only record it when it's a live (non-booked) property, i.e.
  // actually present in PROPERTIES rather than only in BOOKED_PROPERTIES.
  if (PROPERTIES.some(x => x.id === id)) recordRecentlyViewed(p);
  renderCards();        // reflect the new count on the card grid

  // View mode never touches the actual "list your property" form — it
  // builds a plain read-only key/value table straight from the property
  // object instead (see buildDetailTable()), so there's nothing here that
  // could ever be clicked, checked, or typed into.
  propertyViewMode = true;

  document.getElementById('addModalTitleText').textContent = p.propertyId || 'Property details';
  const sub = document.getElementById('addModalSubtitleText');
  const subArea = p.location?.area || '';
  if (sub) { sub.textContent = subArea; sub.style.display = subArea ? '' : 'none'; }

  // Render the same photo slider used on the property card (large image,
  // arrows/dots, tap-to-zoom) — with the video tour, when present, appended
  // as its own final slide so it always comes after every photo in the
  // same swipeable gallery rather than a separate section.
  const gallerySlot = document.getElementById('detailGallerySlot');
  if (gallerySlot) {
    const pType = pTypeLabel(p);
    const colors = {Rent:'#e8f5ee:#1a6640',Lease:'#dde9fa:#1a4680',PG:'#eee8fa:#4a2a9a',ShortStay:'#e0f7fa:#00646e',Sell:'#fdf1e0:#a15c00'};
    const [gbg, gfg] = (colors[pType]||'#f0f0f0:#333').split(':');
    const videoSlideHtml = buildVideoSlideHtml(p);
    gallerySlot.innerHTML = `<div class="prop-img" style="background:${gbg}" data-idx="0">${buildImgSlider(p, gfg, '-detail', videoSlideHtml)}</div>`;
    observeCardImgs(gallerySlot);
  }

  // Plain key/value table with every spec — see buildDetailTable() below.
  const tableWrap = document.getElementById('detailTableWrap');
  if (tableWrap) tableWrap.innerHTML = buildDetailTable(p);

  // Wire up the same quick actions the old detail view offered (save,
  // contact, schedule a visit, WhatsApp) onto the form's action row.
  const liked = shortlisted.has(String(p.id));
  const saveBtn = document.getElementById('modal-save-btn');
  saveBtn.classList.toggle('liked', liked);
  document.getElementById('modal-save-btn-label').textContent = liked ? 'Shortlisted' : 'Shortlist';
  saveBtn.dataset.propId = String(p.id);
  saveBtn.onclick = () => toggleShortlistFromModal(String(p.id));
  document.getElementById('viewScheduleBtn').onclick = () => openScheduleModal(p.id);
  document.getElementById('viewCallBtn').onclick = () => openCall(p.id);
  document.getElementById('viewWhatsappBtn').onclick = () => openWhatsApp(p.id);
  // Owner accounts don't need to schedule a visit or WhatsApp-contact through
  // the property view — those actions are for prospective tenants only.
  const viewerIsOwner = (() => { const u = getLoggedInUser(); return !!u && u.accountType === 'owner'; })();
  document.getElementById('viewScheduleBtn').style.display = viewerIsOwner ? 'none' : '';
  document.getElementById('viewWhatsappBtn').style.display = viewerIsOwner ? 'none' : '';
  const visitBadge = document.getElementById('modal-visit-count');
  visitBadge.dataset.propId = String(p.id);
  if ((p.visitCount || 0) > 0) { visitBadge.textContent = p.visitCount; visitBadge.style.display = ''; }
  else { visitBadge.style.display = 'none'; }
  document.getElementById('viewActionsRow').style.display = '';
  // Owners only see Shortlist + Call (no Schedule visit / WhatsApp), so pull
  // Call up into the first row next to Shortlist — 50/50 split — instead of
  // leaving it alone on its own full-width row underneath.
  const actionsRow1 = document.getElementById('viewActionsRow');
  const actionsRow2 = document.getElementById('viewActionsRow2');
  const callBtn = document.getElementById('viewCallBtn');
  const whatsappBtn = document.getElementById('viewWhatsappBtn');
  if (viewerIsOwner) {
    actionsRow1.appendChild(callBtn);
    actionsRow2.style.display = 'none';
  } else {
    actionsRow2.insertBefore(callBtn, whatsappBtn);
    actionsRow2.style.display = '';
  }
  document.getElementById('viewActionsFooter').style.display = 'block';

  // Read-only view of an existing property — "Clear form" only makes sense
  // for a listing actually being drafted, never here.
  const clearBtn = document.getElementById('clearFormBtn');
  if (clearBtn) clearBtn.style.display = 'none';

  document.getElementById('addModalBox').classList.add('view-mode');
  document.getElementById('addModal').classList.add('view-mode');
  document.getElementById('addModal').classList.add('open');
  lockBodyScroll();

  const scrollBody = document.getElementById('addModalScrollBody');
  if (scrollBody) scrollBody.scrollTop = 0;
}

/* Builds the plain key/value spec table used by the property view. Reads
   straight from the property object (never touches the actual form), and
   skips any field that has no value so the table only shows what was
   actually filled in. Contact details (owner name/phone/email/address,
   agent info) and the full address/lat-lng/maps link are intentionally
   left out here, same as before — contacting the owner goes through the
   Call/WhatsApp/Schedule buttons instead of showing raw contact info. */
function buildDetailTable(p) {
  const basic = p.basic || {}, location = p.location || {}, price = p.price || {},
        property = p.property || {}, amenities = p.amenities || {}, terms = p.terms || {},
        rules = p.rules || {}, media = p.media || {}, pg = p.pg || {}, shortStay = p.shortStay || {},
        sale = p.sale || {};

  const status = basic.status || 'For Rent';
  const isPG = status === 'PG', isLease = status === 'Lease', isShortStay = status === 'Short Stay',
        isSell = status === 'For Sale';

  // Single continuous <table>, one colored "section band" row per group
  // (same color-per-category language as the Compare table's
  // .compare-section-row.sec-*) followed by its plain label/value rows —
  // rather than separate boxed panels, this reads as one flowing table.
  const rowsHtml = [];
  function section(label, sectionClass, rows) {
    const filtered = rows.filter(Boolean);
    if (!filtered.length) return;
    rowsHtml.push('<tr class="detail-section-row ' + sectionClass + '"><td colspan="2">' + label + '</td></tr>');
    rowsHtml.push(...filtered);
  }
  function kv(label, value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    return '<tr><td class="detail-row-label">' + esc(label) + '</td><td class="detail-row-value">' + esc(text) + '</td></tr>';
  }

  section('📋 Basic Information', 'sec-listing-info', [
    kv('Status', status),
    kv('Listed by', basic.listedBy),
  ]);

  section('📍 Location', 'sec-listing-info', [
    kv('Area / Locality', location.area),
    kv('City', location.city),
  ]);

  if (isLease) {
    section('💰 Pricing', 'sec-pricing', [
      kv('Lease amount', price.rent != null ? fmtRupee(price.rent) + '/month' : null),
      kv('Maintenance', price.maintenance != null ? fmtRupee(price.maintenance) : null),
    ]);
  } else {
    section('💰 Pricing', 'sec-pricing', [
      // Label and unit both need to vary here: "Rent ... /month" was wrong
      // for a Sell listing's expected price (no "/month" on a sale) and
      // technically wrong for Short Stay too (that's a per-day rate, not
      // monthly) — neither had ever been corrected for this shared branch.
      kv(isSell ? 'Price' : 'Rent', price.rent != null ? fmtRupee(price.rent) + (isSell ? '' : isShortStay ? '/day' : '/month') : null),
      !isShortStay ? kv('Deposit', price.deposit != null ? fmtRupee(price.deposit) : null) : null,
      kv('Maintenance', price.maintenance != null ? fmtRupee(price.maintenance) : null),
      kv('Rent increase', price.rentIncrease),
      kv('Electricity included', price.electricity),
      kv('Water charge', price.water),
      kv('Negotiable', price.negotiable),
    ]);
  }

  section('🏢 Property Details', 'sec-property-details', [
    !isPG && !isShortStay ? kv('Property type', property.type) : null,
    !isPG && !isShortStay ? kv('BHK', property.bhk) : null,
    // For Sell, show which area figure this is (Carpet/Super Built-up/Built-up)
    // right in the label when the seller specified one — falls back to the
    // generic "Built-up area" label for Rent/Lease/PG or when unspecified.
    !isPG && !isShortStay ? kv((isSell && sale.areaType) ? sale.areaType : 'Built-up area', property.area) : null,
    !isPG && !isShortStay ? kv('Age of property', property.age) : null,
    !isPG && !isShortStay && !isSell ? kv('Preferred tenants', property.tenant) : null,
    !isPG && !isShortStay ? kv('Facing', property.facing) : null,
    kv('Bike parking', property.bike),
    kv('Car parking', property.car),
    kv('Floor', property.floor),
    kv('Bathrooms', property.bathrooms),
    !isPG && !isShortStay ? kv('Toilet type', property.toiletType) : null,
    kv('Furnishing', property.furnish),
    !isPG && !isSell ? kv('Available from', property.available ? formatDateDisplay(property.available) : property.available) : null,
  ]);

  if (isSell) {
    section('🏷️ Sale Details', 'sec-property-details', [
      kv('Total floors in building', sale.totalFloors),
      kv('Balconies', sale.balconies),
      kv('Ownership type', sale.ownership),
      kv('Possession status', sale.possession),
      kv('Possession date', sale.possessionDate ? formatDateDisplay(sale.possessionDate) : sale.possessionDate),
      kv('RERA registered', sale.reraRegistered),
      kv('RERA ID', sale.reraId),
    ]);
    section('🏛️ Legal & Ownership Details', 'sec-property-details', [
      kv('Khata type', sale.khataType),
      kv('Property tax paid up to date', sale.propertyTaxPaid),
      kv('Loan status', sale.loanStatus),
      kv('Occupancy Certificate (OC) available', sale.ocAvailable),
      kv('Completion Certificate (CC) available', sale.ccAvailable),
      kv('Number of previous owners', sale.previousOwners),
      kv('Society / Project name', sale.projectName),
    ]);
    section('🧱 Structure & Site Details', 'sec-property-details', [
      kv('Flooring type', sale.flooring),
      kv('Water source', sale.waterSource),
      kv('Boundary wall', sale.boundaryWall),
      kv('Width of facing road', sale.roadWidth ? sale.roadWidth + ' ft' : sale.roadWidth),
      kv('Number of open sides', sale.openSides),
      kv('Corner property', sale.cornerProperty),
      kv('Overlooking', sale.overlooking),
    ]);
  }

  section('📅 Availability & Terms', 'sec-terms', [
    isLease ? kv('Notice period', terms.notice) : (!isPG && !isShortStay ? kv('Notice period', terms.notice) : null),
    isLease ? kv('Contract Term', terms.lease) : (!isPG && !isShortStay ? kv('Contract Term', terms.lease) : null),
    isLease ? kv('Lease type', terms.leaseType) : null,
    isLease ? kv('Lock-in period', terms.lockIn) : null,
  ]);

  if (!isShortStay) {
    section('⚖️ Tenant Rules', 'sec-rules', [
      kv('Pets allowed', rules.pets),
      kv('Non-veg allowed', rules.nonVeg),
      kv('Piped gas', rules.gas),
    ]);
  }

  if (isPG) {
    section('🛏 PG Details', 'sec-pg-details', [
      kv('Property type', pg.type),
      kv('Gender preference', pg.gender),
      kv('Room type', pg.room),
      kv('Meals', pg.meals),
      kv('Occupancy', pg.occupancy),
      kv('Notice period', pg.notice),
      kv('Bathroom', pg.bathroom),
      kv('Toilet type', pg.toiletType),
      kv('Room furnishing', pg.furnish),
      kv('Food type', pg.food),
      kv('Available from', pg.available ? formatDateDisplay(pg.available) : pg.available),
      kv('Visitor policy', pg.visitors),
      kv('Gate closing time', pg.gateTime),
    ]);
  }

  if (isShortStay) {
    section('🛎 Short Stay Details', 'sec-pg-details', [
      kv('Property type', shortStay.type),
      kv('Room type', shortStay.roomType),
      kv('Available 24 hours', shortStay.available24hrs),
      kv('Free cancellation window', shortStay.cancellation),
      kv('Unmarried couples allowed', shortStay.couplesAllowed),
      kv('Room furnishing', shortStay.furnish),
    ]);
  }

  const selected = Array.isArray(amenities.selected) ? amenities.selected : [];
  section('✨ Amenities', 'sec-media-amenities', [
    kv('Amenities', selected.join(', ')),
    kv('Additional amenities', amenities.extra),
  ]);

  section('📝 Description', 'sec-media-amenities', [
    kv('Description', media.desc),
  ]);

  if (!rowsHtml.length) return '<div class="profile-list-empty" style="padding:14px 0">No details added yet.</div>';
  return '<div class="detail-table-card"><table class="detail-table"><tbody>' + rowsHtml.join('') + '</tbody></table></div>';
}

function closeDetail() {
  document.getElementById('addModal').classList.remove('open');
  document.getElementById('addModalBox').classList.remove('view-mode');
  document.getElementById('addModal').classList.remove('view-mode');
  unlockBodyScroll();
  propertyViewMode = false;
  const clearBtn = document.getElementById('clearFormBtn');
  if (clearBtn) clearBtn.style.display = '';
  const gallerySlot = document.getElementById('detailGallerySlot');
  if (gallerySlot) gallerySlot.innerHTML = '';
  const tableWrap = document.getElementById('detailTableWrap');
  if (tableWrap) tableWrap.innerHTML = '';

  document.getElementById('addModalTitleText').textContent = 'List your property';
  const sub = document.getElementById('addModalSubtitleText');
  if (sub) { sub.style.display = 'none'; sub.textContent = ''; }

  document.getElementById('viewActionsRow').style.display = 'none';
  document.getElementById('viewActionsRow2').style.display = 'none';
  document.getElementById('viewActionsFooter').style.display = 'none';
  clearDeepLinkUrl();
}

function toggleShortlistFromModal(id) {
  id = String(id);
  const el = {classList:{contains:()=>shortlisted.has(id),add:()=>{},remove:()=>{}}};
  if (shortlisted.has(id)) {
    shortlisted.delete(id);
    delete shortlistedData[id];
    document.getElementById('modal-save-btn').classList.remove('liked');
    document.getElementById('modal-save-btn-label').textContent = 'Shortlist';
    showToast('Removed from shortlist');
  } else {
    shortlisted.add(id);
    const p = PROPERTIES.find(x => String(x.id) === id);
    if (p) shortlistedData[id] = p;
    document.getElementById('modal-save-btn').classList.add('liked');
    document.getElementById('modal-save-btn-label').textContent = 'Shortlisted';
    showToast('Added to shortlist ♥');
  }
  saveShortlist();
  saveShortlistData();
  updateShortlistCount();
  renderShortlistPanel();
  renderCards();
}

/* ═══════════════════════════════════════════════
   SCHEDULE A VISIT
═══════════════════════════════════════════════ */
let scheduleForPropId = null;
let bookingForPropId = null;

function openScheduleModal(propId) {
  if (!getLoggedInUser()) { showToast('Please log in to schedule a visit', 'warning'); openAuthModal(); return; }
  if (blockIfNotVerified()) return;
  const p = PROPERTIES.find(x => x.id === propId);
  if (!p) return;
  closeAllFd();        // this is triggered by a quick-action icon whose own
                        // onclick stops propagation, so it never reaches the
                        // document-level listener that closes open filter
                        // dropdowns — close them here so one doesn't stay
                        // floating (z-index:2000) on top of this modal
  scheduleForPropId = propId;
  document.getElementById('scheduleModalSubtitle').textContent = (p.propertyId || '') + ' · ' + (p.location?.area || '');
  // reset fields, pre-filling name/phone if the visitor is logged in
  const user = getLoggedInUser();
  document.getElementById('sched-date').value = '';
  document.getElementById('sched-time').value = '';
  const preloadName = (user && `${user.firstName || ''} ${user.lastName || ''}`.trim()) || (user && user.name) || '';
  document.getElementById('sched-name').value = preloadName;
  document.getElementById('sched-phone').value = (user && user.mobile) || '';
  document.getElementById('sched-email').value = (user && user.email) || '';
  document.getElementById('sched-note').value = '';
  // Lock these to the signed-up account's own details — a visit request
  // should always carry the real identity of the logged-in user, not an
  // editable stand-in for it.
  ['sched-name', 'sched-phone', 'sched-email'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.readOnly = true;
    el.classList.add('identity-locked');
    const hint = document.getElementById(id + '-hint');
    if (hint) hint.style.display = '';
  });
  // default the date picker's minimum to today so past dates can't be picked
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('sched-date').min = today;
  document.getElementById('scheduleModal').classList.add('open');
  lockBodyScroll();
}

function closeScheduleModal() {
  document.getElementById('scheduleModal').classList.remove('open');
  unlockBodyScroll();
}

/* ═══════════════════════════════════════════════
   ADD-TO-CALENDAR — Google/Outlook web links + a downloadable .ics, so a
   scheduled visit can drop straight into whatever calendar app the visitor
   actually uses (the calendar app's own reminder covers "before it" —
   there's no separate push/email reminder system in this app).
═══════════════════════════════════════════════ */
// details: { propertyName, propertyArea, propertyCode, visitDate ('YYYY-MM-DD'),
//            visitTime ('HH:MM'), note }
function buildVisitCalendarEvent(details) {
  const start = new Date(`${details.visitDate}T${details.visitTime}:00`);
  const end   = new Date(start.getTime() + 30 * 60000); // 30-minute visit slot
  const pad = n => String(n).padStart(2, '0');
  const toUTCStamp = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const propertyLabel = details.propertyName || details.propertyCode || 'HomeLoop listing';
  const title = `Property visit — ${propertyLabel}`;
  const location = details.propertyArea || '';
  const descLines = [
    `Scheduled visit for ${propertyLabel}${details.propertyCode ? ' (' + details.propertyCode + ')' : ''}.`,
    details.note ? `Note: ${details.note}` : '',
  ].filter(Boolean);
  return { start, end, title, location, description: descLines.join('\n'), toUTCStamp };
}

function googleCalendarLink(ev) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${ev.toUTCStamp(ev.start)}/${ev.toUTCStamp(ev.end)}`,
    details: ev.description,
    location: ev.location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Opens the shared "add to calendar" modal, wiring its three links up to
// this particular visit. Used both right after booking and from a
// visit_status notification later on.
function openVisitCalendarOptions(details, { title, sub } = {}) {
  const ev = buildVisitCalendarEvent(details);
  document.getElementById('visitConfirmTitle').textContent = title || 'Visit requested';
  const dateObj   = ev.start;
  const dateTimeLabel = formatDateDisplay(dateObj, true);
  document.getElementById('visitConfirmSub').textContent = sub || `${dateTimeLabel}${details.propertyCode ? ' — ' + details.propertyCode : ''}`;
  document.getElementById('calGoogleBtn').href = googleCalendarLink(ev);
  document.getElementById('visitConfirmModal').classList.add('open');
  lockBodyScroll();
}

function closeVisitConfirmModal() {
  document.getElementById('visitConfirmModal').classList.remove('open');
  unlockBodyScroll();
}

async function submitScheduleVisit() {
  const date  = document.getElementById('sched-date').value;
  const time  = document.getElementById('sched-time').value;
  const name  = document.getElementById('sched-name').value.trim();
  const phone = document.getElementById('sched-phone').value.trim();
  const email = document.getElementById('sched-email').value.trim();
  const note  = document.getElementById('sched-note').value.trim();

  if (!date || !time) {
    showToast('Please pick a date and time for your visit', 'warning');
    return;
  }
  if (!name) { showToast('Please enter your name', 'warning'); return; }
  if (!phone) { showToast('Please enter your phone number', 'warning'); return; }
  if (!isValidIndianMobile(phone)) { showToast('Enter a valid 10-digit mobile number starting with 6, 7, 8 or 9', 'warning'); return; }

  const p = PROPERTIES.find(x => x.id === scheduleForPropId);
  if (!p) { showToast('Could not find that property. Please try again.', 'error'); return; }

  const btn = document.getElementById('scheduleSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Requesting…';

  try {
    const res = await fetch('/api/visits', {
      method: 'POST',
      headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        propertyId:   scheduleForPropId,
        visitorName:  name,
        visitorPhone: phone,
        email,
        note,
        visitDate:    date,
        visitTime:    time,
      })
    });
    const data = await res.json();
    if (!res.ok) { if (handleNotVerifiedError(data)) return; showToast(data.message || 'Could not request the visit. Please try again.', 'error'); return; }

    // Reflect the server's authoritative visitCount locally so the badge in
    // the detail modal / My Listings updates immediately, without touching
    // the unrelated page-view counter.
    if (typeof data.visitCount === 'number') {
      p.visitCount = data.visitCount;
      const badge = document.querySelector(`#modal-visit-count[data-prop-id="${p.id}"]`);
      if (badge) {
        badge.textContent = data.visitCount;
        badge.style.display = data.visitCount > 0 ? '' : 'none';
      }
      // Grid/list card badge (the small count next to the calendar icon) —
      // was previously only re-rendered on the next full page load.
      const cardCount = document.querySelector(`#prop-qa-icon-${p.id} .prop-qa-count`);
      if (cardCount) {
        cardCount.textContent = data.visitCount;
        cardCount.style.display = data.visitCount > 0 ? '' : 'none';
      }
      if (typeof MY_LISTINGS_CACHE !== 'undefined') {
        const myListing = MY_LISTINGS_CACHE.find(x => x.id === p.id);
        if (myListing) { myListing.visitCount = data.visitCount; renderMyListings(); }
      }
    }

    closeScheduleModal();
    openVisitCalendarOptions({
      propertyName: p.owner?.propertyName || '',
      propertyArea: p.location?.area || '',
      propertyCode: p.propertyId || '',
      visitDate:    date,
      visitTime:    time,
      note,
    }, { title: 'Visit requested' });
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Request visit';
  }
}

/* ═══════════════════════════════════════════════
   BOOK NOW — direct customer booking for Short Stay listings
   (OYO-style: no owner visit needed, guest books the room directly)
═══════════════════════════════════════════════ */
function openBookingModal(propId) {
  if (!getLoggedInUser()) { showToast('Please log in to book', 'warning'); openAuthModal(); return; }
  if (blockIfNotVerified()) return;
  const p = PROPERTIES.find(x => x.id === propId);
  if (!p) return;
  closeAllFd();        // this is triggered by a quick-action icon whose own
                        // onclick stops propagation, so it never reaches the
                        // document-level listener that closes open filter
                        // dropdowns — close them here so one doesn't stay
                        // floating (z-index:2000) on top of this modal
  bookingForPropId = propId;
  document.getElementById('bookingModalSubtitle').textContent = (p.propertyId || '') + ' · ' + (p.location?.area || '');
  const user = getLoggedInUser();
  document.getElementById('book-checkin').value = '';
  document.getElementById('book-days').value = '';
  document.getElementById('book-guests').value = '';
  const preloadName = (user && `${user.firstName || ''} ${user.lastName || ''}`.trim()) || (user && user.name) || '';
  document.getElementById('book-name').value = preloadName;
  document.getElementById('book-phone').value = (user && user.mobile) || '';
  document.getElementById('book-email').value = (user && user.email) || '';
  document.getElementById('book-note').value = '';
  // Lock these to the signed-up account's own details, same as the
  // schedule-visit form — a booking should always carry the real identity
  // of the logged-in user, not an editable stand-in for it.
  ['book-name', 'book-phone', 'book-email'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.readOnly = true;
    el.classList.add('identity-locked');
    const hint = document.getElementById(id + '-hint');
    if (hint) hint.style.display = '';
  });
  // default the date picker's minimum to today so past dates can't be picked
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('book-checkin').min = today;
  document.getElementById('bookingModal').classList.add('open');
  lockBodyScroll();
}

function closeBookingModal() {
  document.getElementById('bookingModal').classList.remove('open');
  unlockBodyScroll();
}

async function submitBookingRequest() {
  const checkin = document.getElementById('book-checkin').value;
  const days    = document.getElementById('book-days').value;
  const guests  = document.getElementById('book-guests').value;
  const name    = document.getElementById('book-name').value.trim();
  const phone   = document.getElementById('book-phone').value.trim();
  const email   = document.getElementById('book-email').value.trim();
  const note    = document.getElementById('book-note').value.trim();

  if (!checkin) { showToast('Please pick a check-in date', 'warning'); return; }
  if (!days || parseInt(days) < 1) { showToast('Please enter the number of days', 'warning'); return; }
  if (!name) { showToast('Please enter your name', 'warning'); return; }
  if (!phone) { showToast('Please enter your phone number', 'warning'); return; }
  if (!isValidIndianMobile(phone)) { showToast('Enter a valid 10-digit mobile number starting with 6, 7, 8 or 9', 'warning'); return; }

  const p = PROPERTIES.find(x => x.id === bookingForPropId);
  if (!p) { showToast('Could not find that property. Please try again.', 'error'); return; }

  const btn = document.getElementById('bookingSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Booking…';

  try {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        propertyId:   bookingForPropId,
        guestName:    name,
        guestPhone:   phone,
        email,
        note,
        checkinDate:  checkin,
        days:         parseInt(days) || 1,
        guests:       parseInt(guests) || 1,
      })
    });
    const data = await res.json();
    if (!res.ok) { if (handleNotVerifiedError(data)) return; showToast(data.message || 'Could not complete the booking. Please try again.', 'error'); return; }

    const dateLabel = formatDateDisplay(checkin);
    closeBookingModal();
    showToast(`Booked from ${dateLabel} for ${days} day${days > 1 ? 's' : ''} — ${p.propertyId || ''}`);
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm booking';
  }
}

/* ═══════════════════════════════════════════════
   CALL CONTACT — open to any visitor, no login/verification gate
═══════════════════════════════════════════════ */
function openCall(propId) {
  const p = PROPERTIES.find(x => x.id === propId);
  if (!p) return;
  const rawPhone = (p.owner?.agentPhone || '').replace(/\D/g, '');
  if (!rawPhone) {
    showToast('No agent phone number added for this listing', 'warning');
    return;
  }
  const phone = rawPhone.length === 10 ? '+91' + rawPhone : ('+' + rawPhone);
  window.location.href = 'tel:' + phone;
}

/* ═══════════════════════════════════════════════
   WHATSAPP CONTACT
═══════════════════════════════════════════════ */
function openWhatsApp(propId) {
  const p = PROPERTIES.find(x => x.id === propId);
  if (!p) return;
  const rawPhone = (p.owner?.agentPhone || '').replace(/\D/g, '');
  if (!rawPhone) {
    showToast('No agent phone number added for this listing', 'warning');
    return;
  }
  const phone = rawPhone.length === 10 ? '91' + rawPhone : rawPhone;
  const propertyUrl = `${window.location.origin}/property/${p.id}`;
  const msg = `Hi, I'm interested in "${p.propertyId}" (${p.location?.area}) listed on HomeLoop. Is it still available?\n\nView listing: ${propertyUrl}`;
  const url = 'https://wa.me/' + phone + '?text=' + encodeURIComponent(msg);
  window.open(url, '_blank', 'noopener');
}

/* ═══════════════════════════════════════════════
   ADD LISTING MODAL
═══════════════════════════════════════════════ */
function resetListingForm() {
  // Reset all standard inputs/selects/textareas inside the modal
  document.querySelectorAll('#addModal input:not([type="checkbox"]), #addModal select, #addModal textarea').forEach(el => { el.value = ''; });
  // Re-apply default notice periods (3 Months for Rent/Lease, 15 Days for PG)
  // which the blanket reset above just cleared back to the placeholder.
  const noticeRent = document.getElementById('f-noticePeriod');
  const noticeLease = document.getElementById('f-leaseNoticePeriod');
  const noticePg = document.getElementById('f-pgNotice');
  if (noticeRent) noticeRent.value = '3 Months';
  if (noticeLease) noticeLease.value = '3 Months';
  if (noticePg) noticePg.value = '15 Days';
  // Re-apply default lease durations (12 Months for Rent, 2 Years for Lease)
  // which the blanket reset above just cleared back to the placeholder.
  const leaseDurRent = document.getElementById('f-leaseDuration');
  const leaseDurLease = document.getElementById('f-leaseDurationVal');
  if (leaseDurRent) leaseDurRent.value = '12 Months';
  if (leaseDurLease) leaseDurLease.value = '2 Years';
  // Re-apply default City (Bangalore) which the blanket reset above just
  // cleared back to blank.
  const cityField = document.getElementById('f-city');
  if (cityField) cityField.value = 'Bangalore';
  // Re-apply the fixed agent contact details (non-editable) which the
  // blanket reset above just cleared back to blank.
  const agentPhoneField = document.getElementById('f-agentPhone');
  const agentAreaField = document.getElementById('f-agentArea');
  if (agentPhoneField) agentPhoneField.value = '9035205230';
  if (agentAreaField) agentAreaField.value = 'Prashanth B, Singasandra';
  // Re-apply default Tenant Rules (Pets allowed = No, Non-veg allowed = Yes)
  // which the blanket reset above just cleared back to the placeholder.
  // Still fully editable — these are just sensible starting values.
  const petsRent = document.getElementById('f-petsAllowed');
  const nonVegRent = document.getElementById('f-nonVegAllowed');
  const petsLease = document.getElementById('f-leasePets');
  const nonVegLease = document.getElementById('f-leaseNonVeg');
  if (petsRent) petsRent.value = 'No';
  if (nonVegRent) nonVegRent.value = 'Yes';
  if (petsLease) petsLease.value = 'No';
  if (nonVegLease) nonVegLease.value = 'Yes';
  // Undo the maintenance>0 lock on electricity/water so a fresh form starts unlocked
  const elecReset = document.getElementById('f-electricityIncluded');
  const waterReset = document.getElementById('f-waterCharge');
  if (elecReset) elecReset.disabled = false;
  if (waterReset) waterReset.disabled = false;
  // Uncheck all checkboxes (amenities + misc toggles)
  document.querySelectorAll('#addModal input[type="checkbox"]').forEach(el => { el.checked = false; });
  // For a brand-new listing, default "Same as building live address" back
  // to checked — most owners live at the property they're listing, so
  // Owner address should auto-fill (and stay locked/readonly) once the
  // Building Live Address is captured, rather than starting blank. The
  // owner can still uncheck it to enter a different address by hand.
  const sameAddrChk = document.getElementById('f-sameAsBuildingAddress');
  if (sameAddrChk) sameAddrChk.checked = true;
  // The "Same as building live address" checkbox above was just unchecked by
  // the loop — make sure Owner address goes back to editable with it.
  applySameAsBuildingAddressState();
  // Clear amenity unit qty fields and re-render
  amClearAll();
  // Reset tenant preference dropdown label/hidden value (checkboxes were
  // already unchecked by the loop above)
  if (typeof renderTenantSelected === 'function') renderTenantSelected();
  // Same reset for the Sell-only "Overlooking" dropdown
  if (typeof renderOverlookingSelected === 'function') renderOverlookingSelected();
  // Clears the auto-computed price-per-sqft nudge along with price/area
  if (typeof updateSellPricePerSqft === 'function') updateSellPricePerSqft();
  // Reset image previews
  fImages = [];
  renderFImages();
  // Undo any empty-field hiding from a previous property view (see
  // hideEmptyViewFields) so a fresh "List your property" form always shows
  // every field.
  resetFieldVisibility();
}

/* Property view only: hide any field whose value is empty so a viewer only
   sees the specs that were actually filled in, instead of a form full of
   blank boxes. Reversed by resetFieldVisibility() whenever the form resets. */
function resetFieldVisibility() {
  document.querySelectorAll('#addModalScrollBody .form-group').forEach(group => {
    group.style.display = '';
  });
  document.querySelectorAll('#addModalScrollBody .lm-section').forEach(header => {
    header.classList.remove('view-hidden');
  });
}
const VIEW_ALWAYS_HIDDEN_GROUPS = ['fullAddressGroup', 'latLngGroup', 'mapsLinkGroup', 'imgFormGroup'];
const VIEW_SECTION_HEADERS_SKIP = ['mediaSectionHeader']; // hidden by their own logic already
function hideEmptyViewFields() {
  document.querySelectorAll('#addModalScrollBody .form-group').forEach(group => {
    if (VIEW_ALWAYS_HIDDEN_GROUPS.includes(group.id)) return; // already force-hidden elsewhere
    const controls = group.querySelectorAll('input, select, textarea');
    if (!controls.length) return; // not a field group — leave as-is
    let hasValue = false;
    controls.forEach(el => {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) hasValue = true;
      } else if (String(el.value || '').trim() !== '') {
        hasValue = true;
      }
    });
    group.style.display = hasValue ? '' : 'none';
  });
  // A form-row with every field hidden shouldn't leave an empty gap.
  document.querySelectorAll('#addModalScrollBody .form-row').forEach(row => {
    const groups = [...row.children].filter(c => c.classList && c.classList.contains('form-group'));
    const anyVisible = groups.some(g => g.style.display !== 'none');
    row.style.display = (groups.length && !anyVisible) ? 'none' : '';
  });
  // A section heading ("Lease Terms", "House Rules", etc.) with every field
  // underneath it hidden shouldn't sit there with nothing under it — walk
  // each header's siblings up to the next header and hide it if none of
  // that section's fields ended up visible.
  document.querySelectorAll('#addModalScrollBody .lm-section').forEach(header => {
    if (VIEW_SECTION_HEADERS_SKIP.includes(header.id)) return;
    let sib = header.nextElementSibling;
    let anyVisible = false;
    while (sib && !sib.classList.contains('lm-section')) {
      if (sib.style.display !== 'none') {
        const fields = sib.matches('.form-group, .form-row') ? [sib] : [...sib.querySelectorAll('.form-group, .form-row')];
        if (fields.length) {
          if (fields.some(f => f.style.display !== 'none')) anyVisible = true;
        } else {
          anyVisible = true; // non-field content (e.g. an info box) — leave the header be
        }
      }
      sib = sib.nextElementSibling;
    }
    header.classList.toggle('view-hidden', !anyVisible);
  });
}

/* ── Draft autosave: keeps whatever the user has typed even if the
   modal gets closed accidentally (backdrop click, Escape, etc.) ── */
const LISTING_DRAFT_KEY = 'homeloop_listing_draft_v1';
let _draftSaveTimer = null;

function saveListingDraftNow() {
  // While editing an existing listing (see openEditListingFull), the form is
  // full of *that listing's* data, not a new listing in progress — never let
  // it overwrite the person's own unrelated "new listing" draft.
  if (editingPropertyId) return;
  try {
    const fields = {};
    document.querySelectorAll('#addModal input, #addModal select, #addModal textarea').forEach(el => {
      if (!el.id || el.type === 'file') return;
      if (el.type === 'checkbox') fields[el.id] = el.checked;
      else fields[el.id] = el.value;
    });
    const draft = { fields, fImages: fImages.slice(), savedAt: Date.now() };
    localStorage.setItem(LISTING_DRAFT_KEY, JSON.stringify(draft));
  } catch (e) { /* localStorage unavailable/full — fail silently */ }
}
function queueListingDraftSave() {
  clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(saveListingDraftNow, 300);
}
function clearListingDraft() {
  try { localStorage.removeItem(LISTING_DRAFT_KEY); } catch (e) {}
}
function restoreListingDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(LISTING_DRAFT_KEY) || 'null'); } catch (e) { draft = null; }
  if (!draft || !draft.fields) return false;

  Object.keys(draft.fields).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!draft.fields[id];
    else el.value = draft.fields[id];
  });
  fImages = Array.isArray(draft.fImages) ? draft.fImages.slice() : [];
  renderFImages();
  renderAmSelected();
  return true;
}

/* ═══════════════════════════════════════════════
   FAB ADD-TYPE PICKER — the FAB opens this small picker first so the
   person chooses which kind of listing to create, instead of jumping
   straight into the (Rent-defaulted) form.
═══════════════════════════════════════════════ */
function openFabPicker() {
  document.getElementById('fabPickerBackdrop').classList.add('open');
  document.getElementById('fabPicker').classList.add('open');
}
function closeFabPicker() {
  document.getElementById('fabPickerBackdrop').classList.remove('open');
  document.getElementById('fabPicker').classList.remove('open');
}
function selectFabType(type) {
  closeFabPicker();
  openAddModal(type);
}

// Fills the owner name/phone/email fields with the signed-up account's own
// details and locks them (readonly) so a listing always carries the real,
// verified contact info of whoever created it — same identity the account
// was signed up with. Only used for a brand-new listing (openAddModal);
// editing an existing listing (openEditListingFull) leaves these editable
// since a listing's saved contact can differ from the editor's own account.
// "Same as building live address" checkbox next to Owner address — when
// checked, copies the auto-captured Building Live Address in and locks the
// field (readonly) so it can't quietly drift out of sync; unchecking frees
// it back up for a different owner address.
function applySameAsBuildingAddressState() {
  const chk = document.getElementById('f-sameAsBuildingAddress');
  const ownerAddr = document.getElementById('f-ownerAddress');
  if (!chk || !ownerAddr) return;
  ownerAddr.readOnly = chk.checked;
  ownerAddr.classList.toggle('identity-locked', chk.checked);
}
function toggleSameAsBuildingAddress(checkbox) {
  const ownerAddr = document.getElementById('f-ownerAddress');
  const buildingAddr = document.getElementById('f-fullAddress');
  if (!ownerAddr) return;
  if (checkbox.checked) {
    // Checked: pull in the current building live address.
    if (buildingAddr) ownerAddr.value = buildingAddr.value.trim();
  } else {
    // Unchecked: clear it out rather than leaving the copied-in address
    // sitting there editable — it's no longer "the same as", so it
    // shouldn't look like it still is.
    ownerAddr.value = '';
  }
  applySameAsBuildingAddressState();
}
function lockIdentityFieldsForNewListing() {
  const user = getLoggedInUser();
  if (!user) return;
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.name || '';

  // Owner name and phone are prefilled from the account for convenience
  // but stay editable — a listing is often posted on someone else's
  // behalf (a broker, a family member), so neither should be locked to
  // whoever is logged in. Email remains locked since it's the verified
  // contact identity tied to the account.
  const prefillOnly = [
    ['f-ownerName', fullName],
    ['f-ownerPhone', user.mobile || '']
  ];
  prefillOnly.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && !el.value.trim()) el.value = val;
  });

  const fields = [
    ['f-ownerEmail', user.email || '']
  ];
  fields.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    el.readOnly = true;
    el.classList.add('identity-locked');
    const hint = document.getElementById(id + '-hint');
    if (hint) hint.style.display = '';
  });
}
function unlockIdentityFieldsForEdit() {
  ['f-ownerName', 'f-ownerPhone', 'f-ownerEmail'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.readOnly = false;
    el.classList.remove('identity-locked');
    const hint = document.getElementById(id + '-hint');
    if (hint) hint.style.display = 'none';
  });
}
function openAddModal(presetType) {
  if (!getLoggedInUser()) { openAuthModal(); return; }
  if (blockIfNotVerified()) return;
  const restored = restoreListingDraft();
  if (!restored) resetListingForm();
  if (presetType) {
    document.getElementById('f-type').value = presetType;
  }
  const typeSelect = document.getElementById('f-type');
  if (typeSelect) typeSelect.disabled = !!presetType;
  // Always reflect the logged-in account's own name/phone/email here — even
  // a restored draft — so the listing's contact identity can't drift from
  // the signed-up account, and lock the fields so it can't be edited away.
  lockIdentityFieldsForNewListing();
  applySameAsBuildingAddressState();
  document.getElementById('addModal').classList.add('open');
  lockBodyScroll();
  onFTypeChange(document.getElementById('f-type').value);
  if (restored) showToast('Your unfinished listing was restored');
  // Fresh listing (no restored draft, no address yet): auto-fill the
  // current location so the field is populated without the person having
  // to tap "Live" themselves. They can still tap it later to refresh.
  if (!restored && !document.getElementById('f-fullAddress').value.trim()) {
    fCaptureLocation();
  }
}
function closeAddModal() {
  // Same modal/header X button and backdrop-click are shared with the
  // read-only property view (see openDetail/closeDetail) — route there
  // instead so we don't save someone else's listing as this user's draft.
  if (propertyViewMode) { closeDetail(); return; }
  // Same modal is also reused to edit one of the user's own existing
  // listings (see openEditListingFull) — route there so closing doesn't
  // save the *edited* listing's data over their unrelated new-listing draft.
  if (editingPropertyId) { closeEditListingFull(); return; }
  // Do NOT clear the draft here — closing (even accidentally) should not
  // wipe what the user has already filled in. It's cleared only on
  // successful submission or explicit "Clear form".
  saveListingDraftNow();
  document.getElementById('addModal').classList.remove('open');
  unlockBodyScroll();
}

// Populates every Add/Edit Listing form field from a property object.
// Originally shared with the "import JSON" panel (now removed); still used
// by openEditListingFull() to load an existing listing's data for editing.
function applyImportedProperty(p) {
  function sv(id, val) { const el = document.getElementById(id); if (el && val !== undefined && val !== null) el.value = val; }
  const basic = p.basic || {}, location = p.location || {}, owner = p.owner || {}, price = p.price || {},
        property = p.property || {}, amenities = p.amenities || {}, terms = p.terms || {}, rules = p.rules || {},
        media = p.media || {}, pg = p.pg || {}, shortStay = p.shortStay || {}, sale = p.sale || {};

  // Map schema status back → the dropdown's own value set
  // ('Short Stay' → 'ShortStay' was missing here, so Short Stay listings fell
  // through to the raw 'Short Stay' string, which matches no <option> in
  // #f-type and made onFTypeChange()/isShortStay checks below fail silently —
  // the view rendered as a plain Rent form and lost all Short-Stay-specific data.)
  const reverseStatusMap = { 'For Rent': 'Rent', 'Lease': 'Lease', 'PG': 'PG', 'Short Stay': 'ShortStay', 'For Sale': 'Sell' };
  const typeVal = reverseStatusMap[basic.status] || (basic.status || 'Rent');
  sv('f-type', typeVal);
  sv('f-listedBy', basic.listedBy);
  const isPG = typeVal === 'PG', isLease = typeVal === 'Lease', isShortStay = typeVal === 'ShortStay';

  // Location
  sv('f-location', location.area);
  sv('f-city', location.city || 'Bangalore');
  sv('f-fullAddress', location.address);
  if (location.pincode) sv('f-pincode', location.pincode);
  if (location.lat != null) sv('f-latitude', location.lat);
  if (location.lng != null) sv('f-longitude', location.lng);
  if (location.lat != null && location.lng != null) {
    sv('f-latLngDisplay', Number(location.lat).toFixed(6) + '° N, ' + Number(location.lng).toFixed(6) + '° E');
  }
  sv('f-googleMapsLink', location.mapLink);

  // Owner
  sv('f-title', owner.propertyName);
  sv('f-ownerName', owner.name);
  sv('f-ownerPhone', owner.phone);
  sv('f-ownerEmail', owner.email);
  sv('f-ownerAltPhone', owner.altPhone);
  sv('f-contactTime', owner.contactTime);
  sv('f-ownerAddress', owner.address);
  // Agent contact is fixed/non-editable — always show the fixed value
  // rather than whatever happens to be stored on this listing.
  sv('f-agentPhone', '9035205230');
  sv('f-agentArea', 'Prashanth B, Singasandra');

  // Pricing
  if (isLease) {
    sv('f-leaseAmount', price.rent);
    sv('f-leaseMaintenance', price.maintenance);
  } else {
    sv('f-rent', price.rent);
    if (isPG) sv('f-pgDeposit', price.deposit);
    else if (!isShortStay) sv('f-deposit', price.deposit);
    sv('f-maintenance', price.maintenance);
    if (price.rentIncrease) sv('f-escalation', parseFloat(price.rentIncrease));
    sv('f-electricityIncluded', price.electricity);
    sv('f-waterCharge', price.water);
    sv('f-negotiable', (price.negotiable || '').toLowerCase() === 'yes' ? 'yes' : (price.negotiable || '').toLowerCase() === 'no' ? 'no' : '');
    onMaintenanceChange();
  }

  // Property details
  if (!isPG && !isShortStay) {
    sv('f-propertyType', property.type);
    sv('f-bhk', property.bhk);
    sv('f-area', property.area);
    formatAreaSqft(document.getElementById('f-area'));
    sv('f-age', property.age);
    sv('f-tenant', property.tenant);
    if (typeof syncTenantCheckboxesFromValue === 'function') syncTenantCheckboxesFromValue(property.tenant);
    sv('f-facing', property.facing);
  }
  sv('f-bikepark', (isPG || isShortStay) ? '0' : property.bike);
  sv('f-carpark', (isPG || isShortStay) ? '0' : property.car);
  if (isPG) { sv('f-pgBikePark', pg.bike); sv('f-pgCarPark', pg.car); }
  if (isShortStay) { sv('f-ssBikePark', property.bike); sv('f-ssCarPark', property.car); }
  sv('f-floor', property.floor);
  sv('f-baths', isPG ? '1' : property.bathrooms);
  if (!isPG && !isShortStay) sv('f-toiletType', property.toiletType);
  sv('f-furnishing', property.furnish);
  if (isPG) sv('f-pgAvailableFrom', pg.available);
  else if (isLease) sv('f-leaseAvailableFrom', property.available);
  else if (!isShortStay) sv('f-avail', property.available);

  // Amenities — check the boxes whose label matches, parsing any "Label ×N" qty suffix
  const selected = Array.isArray(amenities.selected) ? amenities.selected : [];
  AM_LIST.forEach(([checkId, label, unitId]) => {
    const match = selected.find(s => s === label || s.indexOf(label + ' ×') === 0 || s.indexOf(label + ' x') === 0);
    const cb = document.getElementById(checkId);
    if (cb) cb.checked = !!match;
    if (match && unitId) {
      const qtyMatch = match.match(/[×x]\s*(\d+)/i);
      if (qtyMatch) sv(unitId, qtyMatch[1]);
    }
  });
  sv('f-amenities-extra', amenities.extra);
  if (typeof onAmCheck === 'function') onAmCheck();
  if (typeof renderAmSelected === 'function') renderAmSelected();

  // Terms
  if (isPG) {
    sv('f-pgNotice', pg.notice);
  } else if (isLease) {
    sv('f-leaseNoticePeriod', terms.notice);
    sv('f-leaseDurationVal', terms.lease);
    sv('f-leaseType', terms.leaseType);
    sv('f-lockInPeriod', terms.lockIn);
  } else {
    sv('f-noticePeriod', terms.notice);
    sv('f-leaseDuration', terms.lease);
  }

  // Rules
  if (isLease) {
    sv('f-leasePets', rules.pets);
    sv('f-leaseNonVeg', rules.nonVeg);
  } else {
    sv('f-petsAllowed', rules.pets);
    sv('f-nonVegAllowed', rules.nonVeg);
  }

  // Media
  sv('f-videoUrl', media.video);
  sv('f-desc', media.desc);
  if (Array.isArray(media.images) && media.images.length) {
    fImages = media.images.slice();
    renderFImages();
  }

  // PG-specific block
  if (isPG) {
    sv('f-pgPropertyType', pg.type);
    sv('f-pgGender', pg.gender);
    sv('f-pgRoomType', pg.room);
    sv('f-pgMeals', pg.meals);
    sv('f-pgOccupancy', pg.occupancy);
    sv('f-pgBathroom', pg.bathroom);
    sv('f-pgToiletType', pg.toiletType);
    sv('f-pgRoomFurnishing', pg.furnish);
    sv('f-pgFoodType', pg.food);
    sv('f-pgVisitorPolicy', pg.visitors);
    sv('f-pgGateTime', pg.gateTime);
  }

  // Short-Stay-specific block (was missing entirely — none of these ever
  // got restored when viewing a Short Stay listing).
  if (isShortStay) {
    sv('f-ssPropertyType', shortStay.type);
    sv('f-ssRoomType', shortStay.roomType);
    sv('f-ss24hrs', shortStay.available24hrs);
    sv('f-ssCancellation', shortStay.cancellation);
    sv('f-ssCouples', shortStay.couplesAllowed);
    sv('f-ssFurnish', shortStay.furnish);
  }

  // Sell-specific block.
  if (typeVal === 'Sell') {
    sv('f-sellTotalFloors', sale.totalFloors);
    sv('f-sellBalconies', sale.balconies);
    sv('f-sellOwnership', sale.ownership);
    sv('f-sellPossession', sale.possession);
    sv('f-sellPossessionDate', sale.possessionDate);
    sv('f-sellRera', sale.reraRegistered);
    sv('f-sellReraId', sale.reraId);
    sv('f-sellKhataType', sale.khataType);
    sv('f-sellTaxPaid', sale.propertyTaxPaid);
    sv('f-sellLoanStatus', sale.loanStatus);
    sv('f-sellOcAvailable', sale.ocAvailable);
    sv('f-sellCcAvailable', sale.ccAvailable);
    sv('f-sellPreviousOwners', sale.previousOwners);
    sv('f-sellProjectName', sale.projectName);
    sv('f-sellFlooring', sale.flooring);
    sv('f-sellWaterSource', sale.waterSource);
    sv('f-sellBoundaryWall', sale.boundaryWall);
    sv('f-sellRoadWidth', sale.roadWidth);
    sv('f-sellOpenSides', sale.openSides);
    sv('f-sellCornerProperty', sale.cornerProperty);
    sv('f-areaType', sale.areaType);
    if (typeof syncOverlookingCheckboxesFromValue === 'function') syncOverlookingCheckboxesFromValue(sale.overlooking);
    updateSellPricePerSqft();
  }

  onFTypeChange(typeVal);
  queueListingDraftSave();
}

function clearAddModalDraft() {
  resetListingForm();
  // resetListingForm() blanket-clears every input, including owner
  // name/phone/email — those should never actually be clearable since
  // they're locked to the signed-up account, so restore them right after.
  lockIdentityFieldsForNewListing();
  clearListingDraft();
  onFTypeChange(document.getElementById('f-type').value);
  showToast('Form cleared');
}

async function confirmClearAddModalDraft() {
  if (await showConfirmDialog({
    title: 'Clear form?',
    message: "Clear everything you've filled in for this listing?",
    okText: 'Clear form'
  })) {
    clearAddModalDraft();
  }
}

/* ═══════════════════════════════════════════════
   LOG IN / SIGN UP MODAL
═══════════════════════════════════════════════ */
function openAuthModal() {
  document.getElementById('authModal').classList.add('open');
  lockBodyScroll();
  backToSignupForm();
}
function closeAuthModal() {
  document.getElementById('authModal').classList.remove('open');
  unlockBodyScroll();
  backToSignupForm();
}

function openProfileModal() {
  const user = getLoggedInUser();
  if (!user) return;
  setAvatarContent(document.getElementById('profileAvatarLg'), user);
  document.getElementById('profileModalName').textContent = user.name || 'User';
  document.getElementById('profileModalContact').textContent = user.email || '';
  document.getElementById('profileTileName').textContent = user.name || '—';
  document.getElementById('profileTileEmail').textContent = user.email || '—';
  document.getElementById('profileTileMobile').textContent = user.mobile || '—';
  // Tenants ('customer' accounts) can't own listings, so the "Listings" tab
  // has nothing to show them — same owner-only gate as updateListPropertyVisibility().
  const canList = user.accountType === 'owner';
  const listingsTabEl = document.getElementById('profileTabListings');
  if (listingsTabEl) listingsTabEl.style.display = canList ? '' : 'none';
  document.getElementById('profileModal').classList.add('open');
  lockBodyScroll();
  switchProfileTab('info');
}
function closeProfileModal() {
  document.getElementById('profileModal').classList.remove('open');
  unlockBodyScroll();
  exitProfileEditMode();
  exitPasswordEditMode();
}
// Parses either a real Date, an ISO string, or the server's legacy
// 'dd-mm-yyyy hh:mm AM/PM' string into a Date object.
function parseFlexibleDate(input) {
  if (input instanceof Date) return input;
  if (typeof input === 'string') {
    const m = input.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (m) {
      let [, dd, mm, yyyy, hh, min, ap] = m;
      hh = parseInt(hh, 10);
      if (/pm/i.test(ap) && hh !== 12) hh += 12;
      if (/am/i.test(ap) && hh === 12) hh = 0;
      return new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hh, parseInt(min, 10));
    }
  }
  return new Date(input);
}
// Single source of truth for how dates render anywhere in the app:
// 'D MMM YYYY' (e.g. '27 Jul 2026'), or with withTime: 'D MMM YYYY · h:mm AM/PM'.
function formatDateDisplay(input, withTime = false) {
  const d = parseFlexibleDate(input);
  if (isNaN(d)) return typeof input === 'string' ? input : '';
  const datePart = `${d.getDate()} ${d.toLocaleDateString('en-IN', { month: 'short' })} ${d.getFullYear()}`;
  if (!withTime) return datePart;
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12; if (hours === 0) hours = 12;
  return `${datePart} · ${hours}:${minutes} ${ampm}`;
}
// Kept for any older call sites — now just delegates to the shared formatter.
function formatPostedDateTime(date) {
  return formatDateDisplay(date, true);
}
// "Available from" badge shown on property cards: always the plain date
// (no more "In 8 days" / "Today" / "2 Months" phrasing), colored red when
// the date has already passed and green when it's today or upcoming.
function availableDateInfo(available) {
  if (!available) return null;
  const d = parseFlexibleDate(available);
  if (isNaN(d)) return { text: available, cls: 'prop-loc-avail-future' };
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const dateStr = `${dd}-${mm}-${yyyy}`;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const cls = target < today ? 'prop-loc-avail-past' : 'prop-loc-avail-future';
  return { text: dateStr, cls };
}
function getLoggedInUser() {
  try { return JSON.parse(localStorage.getItem('homeloop_user')); } catch { return null; }
}
// Silent background sync so the cached isVerified flag (set at login/signup)
// doesn't stay stale for a user who was verified by admin mid-session — runs
// once on page load. Never shows an error; this is best-effort only, and
// the server-side requireVerified check on each submit route remains the
// real source of truth either way.
async function refreshVerificationStatus() {
  const user = getLoggedInUser();
  if (!user || !user.userKey) return;
  try {
    const res = await fetch('/api/user/me', { headers: userAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const fresh = getLoggedInUser();
    if (!fresh) return; // logged out while this was in flight
    fresh.isVerified = !!data.isVerified;
    fresh.accountType = data.accountType || fresh.accountType;
    localStorage.setItem('homeloop_user', JSON.stringify(fresh));
  } catch (err) { /* best-effort */ }
}
// Call at the top of any "open the submit form" function, right after the
// existing getLoggedInUser() login check. Shows the pending-verification
// modal and returns true (blocked) if the account isn't verified yet, so
// the caller can `if (blockIfNotVerified()) return;`. Not a security
// boundary — server-side requireVerified is — this is purely so people
// don't fill out a whole form before finding out they can't submit it.
function blockIfNotVerified() {
  const user = getLoggedInUser();
  if (user && !user.isVerified) {
    showPendingVerificationModal();
    return true;
  }
  return false;
}
// Fills an avatar circle with the user's uploaded photo when they have one,
// falling back to their initial on a colored background otherwise. Shared by
// the nav menu avatar and the profile modal's large avatar.
function setAvatarContent(el, user) {
  if (!el || !user) return;
  if (user.profilePhoto) {
    el.innerHTML = '<img src="' + esc(user.profilePhoto) + '" alt="' + esc(user.name || 'Profile') + '"/>';
  } else {
    el.textContent = (user.name || user.email || '?')[0].toUpperCase();
  }
}
// Every authenticated request to /api/user/... or /api/properties/... edits
// must carry this header so the server can verify which account is asking.
function userAuthHeaders(extra) {
  const user = getLoggedInUser();
  return Object.assign({ 'x-user-key': (user && user.userKey) || '' }, extra || {});
}
async function logoutUser() {
  const user = getLoggedInUser();
  try {
    if (user && user.userKey) {
      await fetch('/api/user/logout', { method: 'POST', headers: userAuthHeaders() });
    }
  } catch (err) { /* best-effort; clear local session regardless */ }
  localStorage.removeItem('homeloop_user');
  closeProfileModal();
  updateNavAuth();
  switchFilterIdentity();
  showToast('Logged out successfully');
}
function handleMenuAuthClick() {
  if (getLoggedInUser()) openProfileModal();
  else openAuthModal();
}
function updateNavAuth() {
  const user = getLoggedInUser();
  const navBtn = document.getElementById('navAuthBtn');
  const qmbIcon = document.getElementById('qmbProfileIcon');
  if (user) {
    navBtn.innerHTML = '';
    setAvatarContent(document.getElementById('menuAvatar'), user);
    document.getElementById('menuUserName').textContent = user.name || 'User';
    document.getElementById('menuUserSub').textContent = user.email || 'Logged in';
    document.getElementById('menuAuthLabel').textContent = 'My Profile / Log out';
    if (qmbIcon) {
      if (user.profilePhoto) {
        qmbIcon.innerHTML = '<img src="' + esc(user.profilePhoto) + '" alt="Profile"/>';
        qmbIcon.classList.add('qmb-icon-photo');
      } else {
        qmbIcon.textContent = '🧑\u200d💼';
        qmbIcon.classList.remove('qmb-icon-photo');
      }
    }
  } else {
    navBtn.innerHTML = '';
    document.getElementById('menuAvatar').textContent = 'G';
    document.getElementById('menuUserName').textContent = 'Guest';
    document.getElementById('menuUserSub').textContent = 'Log in to manage listings';
    document.getElementById('menuAuthLabel').textContent = 'Log in / Sign up';
    if (qmbIcon) {
      qmbIcon.textContent = '🧑\u200d💼';
      qmbIcon.classList.remove('qmb-icon-photo');
    }
  }
  updateListPropertyVisibility(user);
  initReviewForm();
  refreshNotifPolling();
}
// Shown by default for guests (not logged in yet) so anyone can start
// listing before creating an account. Once logged in, it's owner-only —
// tenant ('customer') accounts don't get to list a property. Controls both
// FAB add buttons and the four "List ... Property" items (plus their
// Manage section label) in the menu panel; "Post Your Video Review" stays
// visible for everyone since it's a testimonial, not a listing.
// Ad banner has two sets of slides tagged data-audience="owner"/"tenant"
// (see the #adTrack/#adDots markup) — guests see both sets, a logged-in
// owner sees only the owner set, a logged-in tenant sees only the tenant
// set. Called on load and again on every login/logout.
function updateAdBannerAudience() {
  const user = getLoggedInUser();
  const audience = !user ? 'all' : (user.accountType === 'owner' ? 'owner' : 'tenant');
  document.querySelectorAll('#adTrack .ad-slide[data-audience]').forEach(el => {
    el.style.display = (audience === 'all' || el.dataset.audience === audience) ? '' : 'none';
  });
  document.querySelectorAll('#adDots .ad-dot[data-audience]').forEach(el => {
    el.style.display = (audience === 'all' || el.dataset.audience === audience) ? '' : 'none';
  });
  // The "For Tenants"/"For Owners" tag only earns its place when a guest is
  // seeing both sets mixed together — once logged in, every visible slide
  // already belongs to that person's own audience, so the tag is redundant.
  document.querySelectorAll('#adTrack .ad-slide-audience').forEach(el => {
    el.style.display = (audience === 'all') ? '' : 'none';
  });
  // Carousel already initialized (DOMContentLoaded) reads live DOM state, but
  // needs a nudge to reset `cur` after the visible slide set just changed.
  if (typeof window.refreshAdBannerCarousel === 'function') window.refreshAdBannerCarousel();
}
function updateListPropertyVisibility(user) {
  const canList = !user || user.accountType === 'owner';
  const display = canList ? '' : 'none';
  ['fabAdd', 'fabInlineAdd', 'menuManageLabel', 'menuListRent', 'menuListLease', 'menuListPG', 'menuListSell']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = display; });
  // resultsHeader/adBanner visibility depends on both owner status and the
  // active tab (see updateAllOnlySections), so defer to that instead of
  // setting them here — avoids this function stomping the per-tab decision
  // right after a login/logout on a non-Explore tab.
  updateAllOnlySections();
  updateAdBannerAudience();
}
function switchAuthTab(tab) {
  backToSignupForm();
  const isLogin = tab === 'login';
  document.getElementById('authTabLogin').classList.toggle('active', isLogin);
  document.getElementById('authTabSignup').classList.toggle('active', !isLogin);
  document.getElementById('authSignupTypeField').style.display = isLogin ? 'none' : '';
  document.getElementById('authSignupPhotoField').style.display = isLogin ? 'none' : '';
  document.getElementById('authSignupNameField').style.display = isLogin ? 'none' : '';
  document.getElementById('authLoginContactField').style.display = isLogin ? '' : 'none';
  document.getElementById('authSignupContactFields').style.display = isLogin ? 'none' : '';
  document.getElementById('authSignupConfirmField').style.display = isLogin ? 'none' : '';
  document.getElementById('authOtpChannelRow').style.display = isLogin ? 'none' : '';
  document.getElementById('authForgotRow').style.display = isLogin ? '' : 'none';
  document.getElementById('authModalTitle').textContent = isLogin ? 'Welcome back' : 'Create your account';
  document.getElementById('authSubmitBtn').textContent = isLogin ? 'Log in' : 'Sign up';
  document.getElementById('authFoot').innerHTML = isLogin
    ? 'New to <span class="brandname">Home<span class="bn-accent">Loop</span></span>? <a onclick="switchAuthTab(\'signup\')">Sign up</a>'
    : 'Already have an account? <a onclick="switchAuthTab(\'login\')">Log in</a>';
}
// Which of the two signup account types is currently selected — starts
// unselected (neither tab has 'active' in the HTML); submitAuth() requires
// this to be set before a signup can go through.
let selectedAccountType = null;
function selectAccountType(type) {
  selectedAccountType = type;
  document.getElementById('authTypeCustomer').classList.toggle('active', type === 'customer');
  document.getElementById('authTypeOwner').classList.toggle('active', type === 'owner');
  document.getElementById('authTypeTabsRow').classList.remove('has-error');
  document.getElementById('authTypeError').style.display = 'none';
  saveSignupDraft();
}

// Which channel the signup verification code goes out on — defaults to
// email, switchable right up until "Sign up" is submitted (the channel
// picker locks along with the rest of the fields once a code is sent, see
// setSignupFieldsDisabled).
let signupOtpChannel = 'email';
function selectOtpChannel(channel) {
  signupOtpChannel = channel;
  document.getElementById('authChannelEmail').classList.toggle('active', channel === 'email');
  document.getElementById('authChannelWhatsapp').classList.toggle('active', channel === 'whatsapp');
}

// Signup profile photo — captured live via the front camera or picked from
// the device. Uploaded immediately (same endpoint as listing photos) and the
// resulting URL is sent along with the rest of the signup form.
let authProfilePicUrl = null;
// Placeholder icon shown when no photo has been picked yet.
const AUTH_PHOTO_PLACEHOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
function resetAuthProfilePic() {
  authProfilePicUrl = null;
  const preview = document.getElementById('authPhotoPreview');
  if (preview) preview.innerHTML = AUTH_PHOTO_PLACEHOLDER;
  const camInput = document.getElementById('auth-photo-camera');
  const fileInput = document.getElementById('auth-photo-file');
  if (camInput) camInput.value = '';
  if (fileInput) fileInput.value = '';
  saveSignupDraft();
}
async function addAuthProfilePic(input) {
  const file = (input.files || [])[0];
  input.value = '';
  if (!file) return;

  const preview = document.getElementById('authPhotoPreview');
  if (preview) preview.innerHTML = '<span style="font-size:11px">…</span>';

  const form = new FormData();
  form.append('images', file);

  try {
    const res = await fetch('/api/upload-images', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Upload failed');
    const url = (data.urls || [])[0];
    if (url) {
      authProfilePicUrl = url;
      if (preview) {
        preview.innerHTML = '<img src="' + url + '" alt="Profile photo"/>'
          + '<span class="auth-photo-remove" onclick="event.stopPropagation();resetAuthProfilePic()" title="Remove photo">'
          + '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>';
      }
      saveSignupDraft();
    }
  } catch (err) {
    showToast(err.message || 'Could not upload photo. Please try again.', 'error');
    if (preview) preview.innerHTML = AUTH_PHOTO_PLACEHOLDER;
  }
}

// ── Signup draft — persists first/last name, email, mobile, account type and
// profile photo to localStorage as the person types, so a page refresh mid-
// signup doesn't lose what they've entered. Restored whenever the auth modal
// opens or the tab is switched (see backToSignupForm), cleared only once the
// account is actually created. Password/confirm-password are deliberately
// left out of the draft — not stored in localStorage even short-term.
const SIGNUP_DRAFT_KEY = 'homeloop_signup_draft';
function saveSignupDraft() {
  const draft = {
    firstName:  document.getElementById('auth-firstname').value,
    lastName:   document.getElementById('auth-lastname').value,
    email:      document.getElementById('auth-email').value,
    mobile:     document.getElementById('auth-mobile').value,
    accountType: selectedAccountType,
    profilePic: authProfilePicUrl || null,
  };
  try { localStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify(draft)); } catch (err) { /* storage unavailable — draft just won't persist */ }
}
function clearSignupDraft() {
  try { localStorage.removeItem(SIGNUP_DRAFT_KEY); } catch (err) { /* ignore */ }
}
function restoreSignupDraft() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(SIGNUP_DRAFT_KEY) || 'null'); } catch (err) { draft = null; }

  document.getElementById('auth-firstname').value = (draft && draft.firstName) || '';
  document.getElementById('auth-lastname').value  = (draft && draft.lastName)  || '';
  document.getElementById('auth-email').value     = (draft && draft.email)     || '';
  document.getElementById('auth-mobile').value    = (draft && draft.mobile)    || '';

  selectedAccountType = (draft && draft.accountType) || null;
  document.getElementById('authTypeCustomer').classList.toggle('active', selectedAccountType === 'customer');
  document.getElementById('authTypeOwner').classList.toggle('active', selectedAccountType === 'owner');
  document.getElementById('authTypeTabsRow').classList.remove('has-error');
  document.getElementById('authTypeError').style.display = 'none';

  if (draft && draft.profilePic) {
    authProfilePicUrl = draft.profilePic;
    const preview = document.getElementById('authPhotoPreview');
    if (preview) {
      preview.innerHTML = '<img src="' + draft.profilePic + '" alt="Profile photo"/>'
        + '<span class="auth-photo-remove" onclick="event.stopPropagation();resetAuthProfilePic()" title="Remove photo">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>';
    }
  } else {
    authProfilePicUrl = null;
    const preview = document.getElementById('authPhotoPreview');
    if (preview) preview.innerHTML = AUTH_PHOTO_PLACEHOLDER;
  }
}

// Holds the signup form's data between "send code" and "verify code" — set
// once send-otp/send-otp-whatsapp succeeds, cleared once the account is
// actually created (or the person backs out via cancelSignupOtp/backToSignupForm).
let pendingSignupBody = null;

async function submitAuth() {
  const btn = document.getElementById('authSubmitBtn');
  if (btn.disabled) return; // already submitting — ignore extra clicks/taps

  // A code's already been sent and the OTP field is showing — this same
  // button now reads "Verify & create account", so route there instead.
  if (pendingSignupBody) { verifySignupOtp(); return; }

  const isLogin = document.getElementById('authTabLogin').classList.contains('active');

  const password = document.getElementById('auth-password').value;

  let body;

  if (isLogin) {
    const contact = document.getElementById('auth-contact').value.trim();
    if (!contact || !password) { showToast('Please fill in your details', 'warning'); return; }
    body = { contact, password };
  } else {
    if (!selectedAccountType) {
      document.getElementById('authTypeTabsRow').classList.add('has-error');
      document.getElementById('authTypeError').style.display = '';
      document.getElementById('authTypeTabsRow').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const firstName       = document.getElementById('auth-firstname').value.trim();
    const lastName        = document.getElementById('auth-lastname').value.trim();
    const email            = document.getElementById('auth-email').value.trim();
    const mobile            = document.getElementById('auth-mobile').value.trim();
    const confirmPassword = document.getElementById('auth-confirm-password').value;

    if (!firstName || !lastName) { showToast('Please enter your first and last name', 'warning'); return; }
    if (!email)  { showToast('Please enter your email', 'warning'); return; }
    if (!mobile) { showToast('Please enter your mobile number', 'warning'); return; }
    if (!isValidIndianMobile(mobile)) { showToast('Enter a valid 10-digit mobile number starting with 6, 7, 8 or 9', 'warning'); return; }
    if (!password) { showToast('Please enter a password', 'warning'); return; }
    if (password !== confirmPassword) { showToast('Passwords do not match', 'warning'); return; }
    body = { firstName, lastName, email, mobile, password, confirmPassword, accountType: selectedAccountType, profilePic: authProfilePicUrl || null };
  }

  btn.disabled = true;

  if (isLogin) {
    btn.textContent = 'Logging in…';
    try {
      const res  = await fetch('/api/user/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.message || 'Something went wrong', 'error'); return; }
      finishAuthSuccess(data);
    } catch (err) {
      showToast('Network error. Please try again.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
    return;
  }

  // Signup: send a verification code on the chosen channel first — the
  // account itself is only created once verifySignupOtp() confirms it
  // (see that function for what happens if sending/verifying fails).
  btn.textContent = 'Sending code…';
  try {
    const sendUrl = signupOtpChannel === 'whatsapp' ? '/api/user/signup/send-otp-whatsapp' : '/api/user/signup/send-otp';
    const sendPayload = signupOtpChannel === 'whatsapp' ? { mobile: body.mobile } : { email: body.email };
    const res  = await fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendPayload)
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Could not send verification code', 'error'); return; }

    pendingSignupBody = body;
    document.getElementById('authOtpChannelText').textContent = signupOtpChannel === 'whatsapp' ? 'Code sent on WhatsApp to' : 'Code sent to';
    document.getElementById('authOtpEmailLabel').textContent = signupOtpChannel === 'whatsapp' ? body.mobile : body.email;
    document.getElementById('authSignupOtpField').style.display = '';
    document.getElementById('authChannelTabsRow').style.pointerEvents = 'none';
    document.getElementById('authChannelTabsRow').style.opacity = '0.6';
    setSignupFieldsDisabled(true);
    btn.textContent = 'Verify & create account';
    document.getElementById('auth-otp').focus();
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
    btn.textContent = 'Sign up';
  } finally {
    btn.disabled = false;
  }
}

// Shared by login and (post-verification) signup — stashes the session and
// updates the UI the same way either path finishes.
function finishAuthSuccess(data) {
  localStorage.setItem('homeloop_user', JSON.stringify({
    id: data._id, userId: data.userId,
    firstName: data.firstName, lastName: data.lastName, name: data.name,
    email: data.email, mobile: data.mobile, accountType: data.accountType,
    profilePhoto: data.profilePhoto || '',
    isVerified: !!data.isVerified,
    userKey: data.userKey
  }));
  clearSignupDraft();
  closeAuthModal();
  updateNavAuth();
  switchFilterIdentity();
  showToast(data.message);
}

// Called via submitAuth() once a code has already been sent (second click
// of the same "Sign up" button, now reading "Verify & create account").
async function verifySignupOtp() {
  const btn = document.getElementById('authSubmitBtn');
  if (btn.disabled) return; // already submitting — ignore extra clicks/taps

  if (!pendingSignupBody) { cancelSignupOtp(); return; }
  const otp = document.getElementById('auth-otp').value.trim();
  const channelLabel = signupOtpChannel === 'whatsapp' ? 'WhatsApp' : 'email';
  if (!/^\d{6}$/.test(otp)) { showToast(`Enter the 6-digit code from your ${channelLabel}`, 'warning'); return; }

  btn.disabled = true;
  btn.textContent = 'Verifying…';

  try {
    const verifyUrl     = signupOtpChannel === 'whatsapp' ? '/api/user/signup/verify-otp-whatsapp' : '/api/user/signup/verify-otp';
    const verifyPayload = signupOtpChannel === 'whatsapp' ? { mobile: pendingSignupBody.mobile, otp } : { email: pendingSignupBody.email, otp };
    const verifyRes  = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyPayload)
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok) { showToast(verifyData.message || 'Incorrect code', 'error'); return; }

    btn.textContent = 'Creating account…';
    const signupRes  = await fetch('/api/user/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingSignupBody)
    });
    const signupData = await signupRes.json();
    if (!signupRes.ok) { showToast(signupData.message || 'Something went wrong', 'error'); return; }

    pendingSignupBody = null;
    finishAuthSuccess(signupData);
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = pendingSignupBody ? 'Verify & create account' : 'Sign up';
  }
}

// "Resend code" link, shown alongside the inline verification field.
async function resendSignupOtp() {
  if (!pendingSignupBody) return;
  const link = document.getElementById('authOtpResendLink');
  if (link.style.pointerEvents === 'none') return; // already sending — ignore extra clicks/taps
  link.style.pointerEvents = 'none';
  link.style.opacity = '0.5';
  try {
    const resendUrl     = signupOtpChannel === 'whatsapp' ? '/api/user/signup/send-otp-whatsapp' : '/api/user/signup/send-otp';
    const resendPayload = signupOtpChannel === 'whatsapp' ? { mobile: pendingSignupBody.mobile } : { email: pendingSignupBody.email };
    const res  = await fetch(resendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resendPayload)
    });
    const data = await res.json();
    showToast(res.ok ? 'Code resent' : (data.message || 'Could not resend code'), res.ok ? 'success' : 'error');
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    setTimeout(() => { link.style.pointerEvents = ''; link.style.opacity = ''; }, 15000);
  }
}

// Locks/unlocks the signup detail fields while a verification code is
// pending — prevents editing the email (or anything else) out from under a
// code that's already been sent for the original details.
function setSignupFieldsDisabled(disabled) {
  ['auth-firstname', 'auth-lastname', 'auth-email', 'auth-mobile', 'auth-password', 'auth-confirm-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  const typeTabs = document.getElementById('authTypeTabsRow');
  if (typeTabs) { typeTabs.style.pointerEvents = disabled ? 'none' : ''; typeTabs.style.opacity = disabled ? '0.6' : ''; }
}

// "← Edit details" link on the inline verification field — drops back to an
// editable form without wiping what was already filled in (profile photo
// included), unlike the full reset backToSignupForm() below does.
function cancelSignupOtp() {
  pendingSignupBody = null;
  document.getElementById('authSignupOtpField').style.display = 'none';
  setSignupFieldsDisabled(false);
  const channelTabs = document.getElementById('authChannelTabsRow');
  channelTabs.style.pointerEvents = '';
  channelTabs.style.opacity = '';
  document.getElementById('authSubmitBtn').textContent = 'Sign up';
}

// Full reset — called whenever the auth modal opens/closes or the login/
// signup tab is switched.
function backToSignupForm() {
  pendingSignupBody = null;
  restoreSignupDraft();
  document.getElementById('authSignupOtpField').style.display = 'none';
  setSignupFieldsDisabled(false);
  selectOtpChannel('email');
  const channelTabs = document.getElementById('authChannelTabsRow');
  channelTabs.style.pointerEvents = '';
  channelTabs.style.opacity = '';
  const isLogin = document.getElementById('authTabLogin')?.classList.contains('active');
  document.getElementById('authModalTitle').textContent = isLogin ? 'Welcome back' : 'Create your account';
  document.getElementById('authSubmitBtn').textContent = isLogin ? 'Log in' : 'Sign up';
  resetForgotPasswordView();
}

/* ═══════════════════════════════════════════════
   AUTH MODAL — FORGOT PASSWORD
   Inline 3-stage view within #authModal: email → otp → new password.
   forgotEmail/forgotResetToken hold state between stages (mirrors
   pendingSignupBody's role in the signup OTP flow above).
═══════════════════════════════════════════════ */
let forgotEmail = null;
let forgotResetToken = null;

function resetForgotPasswordView() {
  forgotEmail = null;
  forgotResetToken = null;
  document.getElementById('authFormStep').style.display = '';
  document.getElementById('authForgotStep').style.display = 'none';
  document.getElementById('forgotStageEmail').style.display = '';
  document.getElementById('forgotStageOtp').style.display = 'none';
  document.getElementById('forgotStageNewPass').style.display = 'none';
  document.getElementById('forgot-email').value = '';
  document.getElementById('forgot-otp').value = '';
  document.getElementById('forgot-newpassword').value = '';
  document.getElementById('forgot-confirmpassword').value = '';
}

function openForgotPassword() {
  resetForgotPasswordView();
  // Carry over whatever was already typed into the login "Phone or email"
  // field, if it looks like an email — saves retyping it.
  const contact = (document.getElementById('auth-contact').value || '').trim();
  if (contact.includes('@')) document.getElementById('forgot-email').value = contact;
  document.getElementById('authFormStep').style.display = 'none';
  document.getElementById('authForgotStep').style.display = '';
  document.getElementById('authModalTitle').textContent = 'Reset your password';
}

function cancelForgotPassword() {
  resetForgotPasswordView();
  document.getElementById('authFormStep').style.display = '';
  document.getElementById('authForgotStep').style.display = 'none';
  const isLogin = document.getElementById('authTabLogin')?.classList.contains('active');
  document.getElementById('authModalTitle').textContent = isLogin ? 'Welcome back' : 'Create your account';
}

async function sendForgotOtp() {
  const btn = document.getElementById('forgotSendBtn');
  if (btn.disabled) return;
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) { showToast('Please enter your email', 'warning'); return; }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res  = await fetch('/api/user/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Something went wrong', 'error'); return; }

    forgotEmail = email;
    document.getElementById('forgotOtpEmailLabel').textContent = email;
    document.getElementById('forgot-otp').value = '';
    document.getElementById('forgotStageEmail').style.display = 'none';
    document.getElementById('forgotStageOtp').style.display = '';
    showToast(data.message);
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send reset code';
  }
}

async function resendForgotOtp() {
  if (!forgotEmail) return;
  const link = document.getElementById('forgotResendLink');
  if (link.style.pointerEvents === 'none') return;
  link.style.pointerEvents = 'none';
  link.style.opacity = '0.5';
  try {
    const res  = await fetch('/api/user/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: forgotEmail })
    });
    const data = await res.json();
    showToast(res.ok ? 'Code resent' : (data.message || 'Could not resend code'), res.ok ? 'success' : 'error');
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    setTimeout(() => { link.style.pointerEvents = ''; link.style.opacity = ''; }, 15000);
  }
}

function backToForgotEmail() {
  document.getElementById('forgotStageOtp').style.display = 'none';
  document.getElementById('forgotStageEmail').style.display = '';
}

async function verifyForgotOtp() {
  const btn = document.getElementById('forgotVerifyBtn');
  if (btn.disabled) return;
  if (!forgotEmail) { cancelForgotPassword(); return; }
  const otp = document.getElementById('forgot-otp').value.trim();
  if (!/^\d{6}$/.test(otp)) { showToast('Enter the 6-digit code from your email', 'warning'); return; }

  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    const res  = await fetch('/api/user/password/forgot/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: forgotEmail, otp })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Incorrect code', 'error'); return; }

    forgotResetToken = data.resetToken;
    document.getElementById('forgotStageOtp').style.display = 'none';
    document.getElementById('forgotStageNewPass').style.display = '';
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify code';
  }
}

async function submitNewPassword() {
  const btn = document.getElementById('forgotResetBtn');
  if (btn.disabled) return;
  if (!forgotEmail || !forgotResetToken) { cancelForgotPassword(); return; }

  const newPassword     = document.getElementById('forgot-newpassword').value;
  const confirmPassword = document.getElementById('forgot-confirmpassword').value;
  if (!newPassword || newPassword.length < 6) { showToast('New password must be at least 6 characters', 'warning'); return; }
  if (newPassword !== confirmPassword) { showToast('Passwords do not match', 'warning'); return; }

  btn.disabled = true;
  btn.textContent = 'Resetting…';
  try {
    const res  = await fetch('/api/user/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: forgotEmail, resetToken: forgotResetToken, newPassword })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Something went wrong', 'error'); return; }

    showToast(data.message);
    cancelForgotPassword();
    switchAuthTab('login');
    document.getElementById('auth-contact').value = forgotEmail || '';
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reset password';
  }
}

/* ═══════════════════════════════════════════════
   PROFILE MODAL — TABS
═══════════════════════════════════════════════ */
function switchProfileTab(tab) {
  document.getElementById('profileTabInfo').classList.toggle('active', tab === 'info');
  document.getElementById('profileTabListings').classList.toggle('active', tab === 'listings');
  document.getElementById('profileTabSaved').classList.toggle('active', tab === 'saved');
  document.getElementById('profilePanelInfo').classList.toggle('active', tab === 'info');
  document.getElementById('profilePanelListings').classList.toggle('active', tab === 'listings');
  document.getElementById('profilePanelSaved').classList.toggle('active', tab === 'saved');

  if (tab === 'info') { exitProfileEditMode(); exitPasswordEditMode(); }
  if (tab === 'listings') loadMyListings();
  if (tab === 'saved') loadSavedListings();
}

/* ═══════════════════════════════════════════════
   EDIT-RESTRICTED MODAL — shown in place of inline editing for account
   details and verified listings. Both call this instead of actually
   opening an edit form; support handles the change on the backend.
═══════════════════════════════════════════════ */
function openEditRestrictedModal(context, propertyLabel) {
  const messages = {
    profile: 'To keep accounts accurate, profile details can\'t be edited directly. Reach out to our support team and they\'ll update it for you.',
    listing: `To keep verified listings accurate, ${propertyLabel ? `<strong>${esc(propertyLabel)}</strong>` : 'this listing'} can't be edited directly. Reach out to our support team and they'll make the change for you.`,
  };
  document.getElementById('editRestrictedMessage').innerHTML = messages[context] || messages.profile;
  document.getElementById('editRestrictedModal').classList.add('open');
  lockBodyScroll();
}
function closeEditRestrictedModal() {
  document.getElementById('editRestrictedModal').classList.remove('open');
  unlockBodyScroll();
}

/* ═══════════════════════════════════════════════
   PENDING VERIFICATION MODAL — shown instead of a toast whenever the
   server rejects a submit action (new listing, review, visit request,
   booking, payment) because the account hasn't been verified by admin yet
   (see requireVerified in server.js, code 'NOT_VERIFIED'). Call
   showPendingVerificationModal() from any submit handler's error branch.
═══════════════════════════════════════════════ */
function showPendingVerificationModal() {
  document.getElementById('pendingVerificationModal').classList.add('open');
  lockBodyScroll();
}
function closePendingVerificationModal() {
  document.getElementById('pendingVerificationModal').classList.remove('open');
  unlockBodyScroll();
}
// Call from a submit handler's error branch with the parsed error response.
// Returns true (and shows the modal) if this was a not-verified rejection,
// so the caller can `return` instead of falling through to its usual toast.
function handleNotVerifiedError(data) {
  if (data && data.code === 'NOT_VERIFIED') {
    showPendingVerificationModal();
    return true;
  }
  return false;
}

/* ═══════════════════════════════════════════════
   PROFILE MODAL — EDIT NAME / EMAIL / MOBILE
═══════════════════════════════════════════════ */
function enterProfileEditMode() {
  const user = getLoggedInUser();
  if (!user) return;
  document.getElementById('profile-edit-name').value = user.name || '';
  document.getElementById('profile-edit-email').value = user.email || '';
  document.getElementById('profile-edit-mobile').value = user.mobile || '';
  document.getElementById('profileViewMode').style.display = 'none';
  document.getElementById('profileEditMode').style.display = '';
  document.getElementById('passwordEditMode').style.display = 'none';
}
function exitProfileEditMode() {
  document.getElementById('profileViewMode').style.display = '';
  document.getElementById('profileEditMode').style.display = 'none';
}
async function saveProfileEdits() {
  const name   = document.getElementById('profile-edit-name').value.trim();
  const email  = document.getElementById('profile-edit-email').value.trim();
  const mobile = document.getElementById('profile-edit-mobile').value.trim();
  if (!email)  { showToast('Email cannot be empty', 'warning'); return; }
  if (!mobile) { showToast('Mobile number cannot be empty', 'warning'); return; }
  if (!isValidIndianMobile(mobile)) { showToast('Enter a valid 10-digit mobile number starting with 6, 7, 8 or 9', 'warning'); return; }

  const btn = document.getElementById('profileSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/user/me', {
      method: 'PUT',
      headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name, email, mobile })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Could not update profile', 'error'); return; }

    const user = getLoggedInUser();
    user.name = data.name;
    user.email = data.email;
    user.mobile = data.mobile;
    localStorage.setItem('homeloop_user', JSON.stringify(user));

    setAvatarContent(document.getElementById('profileAvatarLg'), user);
    document.getElementById('profileModalName').textContent = user.name || 'User';
    document.getElementById('profileModalContact').textContent = user.email || '';
    document.getElementById('profileTileName').textContent = user.name || '—';
    document.getElementById('profileTileEmail').textContent = user.email || '—';
    document.getElementById('profileTileMobile').textContent = user.mobile || '—';
    updateNavAuth();
    exitProfileEditMode();
    showToast('Profile updated');
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
}

/* ═══════════════════════════════════════════════
   PROFILE MODAL — CHANGE PASSWORD
═══════════════════════════════════════════════ */
function enterPasswordEditMode() {
  document.getElementById('profile-current-password').value = '';
  document.getElementById('profile-new-password').value = '';
  document.getElementById('profileViewMode').style.display = 'none';
  document.getElementById('profileEditMode').style.display = 'none';
  document.getElementById('passwordEditMode').style.display = '';
}
function exitPasswordEditMode() {
  document.getElementById('passwordEditMode').style.display = 'none';
  document.getElementById('profileViewMode').style.display = '';
}
async function savePasswordChange() {
  const currentPassword = document.getElementById('profile-current-password').value;
  const newPassword     = document.getElementById('profile-new-password').value;
  if (!currentPassword || !newPassword) { showToast('Please fill in both fields', 'warning'); return; }
  if (newPassword.length < 6) { showToast('New password must be at least 6 characters', 'warning'); return; }

  const btn = document.getElementById('profilePasswordBtn');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const res = await fetch('/api/user/password', {
      method: 'PUT',
      headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message || 'Could not update password', 'error'); return; }
    exitPasswordEditMode();
    showToast('Password updated successfully');
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update password';
  }
}

/* ═══════════════════════════════════════════════
   PROFILE MODAL — MY LISTINGS (only what this user posted)
═══════════════════════════════════════════════ */
let MY_LISTINGS_CACHE = [];

async function loadMyListings() {
  const wrap = document.getElementById('myListingsContent');
  wrap.innerHTML = '<div class="profile-loading">Loading your listings…</div>';
  try {
    const res = await fetch('/api/user/my-listings', { headers: userAuthHeaders() });
    const data = await res.json();
    if (!res.ok) { wrap.innerHTML = `<div class="profile-list-empty">${esc(data.message || 'Could not load your listings.')}</div>`; return; }
    MY_LISTINGS_CACHE = data.properties || [];
    renderMyListings();
  } catch (err) {
    wrap.innerHTML = '<div class="profile-list-empty">⚠️ Could not connect to server.</div>';
  }
}

function renderMyListings() {
  const wrap = document.getElementById('myListingsContent');
  const summaryEl = document.getElementById('myListingsSummary');

  if (!MY_LISTINGS_CACHE.length) {
    if (summaryEl) summaryEl.innerHTML = '';
    wrap.innerHTML = `<div class="profile-list-empty">
      <div class="profile-list-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9l9-7 9 7v11a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg></div>
      You haven't posted any listings yet.<br>Tap "+ List property" to add one.
    </div>`;
    return;
  }

  // Summary strip — totals across every listing this owner has, so they get
  // a single-glance read on overall performance without opening each card.
  if (summaryEl) {
    const totalViews  = MY_LISTINGS_CACHE.reduce((sum, p) => sum + (p.views || 0), 0);
    const totalVisits = MY_LISTINGS_CACHE.reduce((sum, p) => sum + (p.visitCount || 0), 0);
    summaryEl.innerHTML = `
      <div class="mylistings-summary">
        <div class="mylistings-stat"><div class="mylistings-stat-val">${totalViews}</div><div class="mylistings-stat-lbl">Total Views</div></div>
        <div class="mylistings-stat"><div class="mylistings-stat-val">${totalVisits}</div><div class="mylistings-stat-lbl">Visit Requests</div></div>
        <div class="mylistings-stat"><div class="mylistings-stat-val">${MY_LISTINGS_CACHE.length}</div><div class="mylistings-stat-lbl">Listings</div></div>
      </div>`;
  }

  wrap.innerHTML = MY_LISTINGS_CACHE.map(p => {
    const img = (p.media?.images || [])[0];
    const thumb = img ? `style="background-image:url('${safeUrl(img)}')"` : '';
    const rent = p.price?.rent != null ? fmtRupee(p.price.rent) : '—';
    const daysLive = p.createdAt ? Math.max(0, Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000)) : null;
    return `<div class="profile-mini-card" onclick="closeProfileModal();openDetail('${p.id}')">
      <div class="profile-mini-thumb" ${thumb}>${img ? '' : 'No photo'}</div>
      <div class="profile-mini-body">
        <div class="profile-mini-title">${esc(p.propertyId) || 'Untitled listing'}</div>
        <div class="profile-mini-sub">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${esc(p.location?.area)}
        </div>
        <div class="profile-mini-price">${rent}<span style="color:var(--text-3);font-weight:500">/ Month</span></div>
        <span class="profile-status-pill">${esc(p.basic?.status) || 'For Rent'}</span>
        ${p.booked ? `<span class="profile-status-pill booked-pill" style="margin-left:5px">Booked</span>` : ''}
        ${p.visitCount > 0 ? `<span class="profile-status-pill" style="background:var(--brand-light);color:var(--brand);margin-left:5px">${p.visitCount} visit${p.visitCount===1?'':'s'} requested</span>` : ''}
        <div class="profile-mini-stats">
          <span class="profile-mini-stat" title="Total views">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            ${p.views || 0} view${p.views===1?'':'s'}
          </span>
          ${daysLive !== null ? `<span class="profile-mini-stat" title="Days since posted">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${daysLive === 0 ? 'Posted today' : `${daysLive} day${daysLive===1?'':'s'} live`}
          </span>` : ''}
        </div>
      </div>
      <div class="profile-mini-actions">
        <button class="profile-mini-icon-btn" title="Duplicate — start a new listing pre-filled with these details" onclick="event.stopPropagation();openCloneListingFull('${p.id}')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="profile-mini-icon-btn" title="Edit" onclick="event.stopPropagation();openEditRestrictedModal('listing', '${esc(p.propertyId||'')}')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="profile-mini-icon-btn${p.booked ? ' booked-active' : ''}" title="${p.booked ? 'Mark as available' : 'Mark as booked'}" onclick="event.stopPropagation();toggleMyListingBooked('${p.id}', this)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </button>
        <button class="profile-mini-icon-btn profile-mini-icon-whatsapp" title="Share on WhatsApp" onclick="event.stopPropagation();shareMyListingViaWhatsApp('${p.id}')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.6 6.32A7.85 7.85 0 0 0 12.05 4c-4.37 0-7.93 3.56-7.93 7.93 0 1.4.37 2.76 1.06 3.96L4 20l4.24-1.11a7.9 7.9 0 0 0 3.8.97h.01c4.37 0 7.93-3.56 7.93-7.93 0-2.12-.82-4.11-2.38-5.61zm-5.55 12.2h-.01a6.58 6.58 0 0 1-3.35-.92l-.24-.14-2.51.66.67-2.45-.16-.25a6.58 6.58 0 0 1-1.01-3.5c0-3.64 2.96-6.6 6.61-6.6a6.57 6.57 0 0 1 6.6 6.61c0 3.64-2.97 6.6-6.61 6.6zm3.62-4.94c-.2-.1-1.17-.58-1.35-.64-.18-.07-.31-.1-.45.1-.13.2-.51.64-.62.77-.11.13-.23.15-.42.05-.2-.1-.83-.31-1.58-.98-.58-.52-.98-1.16-1.09-1.36-.11-.2-.01-.3.09-.4.09-.09.2-.23.3-.35.1-.11.13-.2.2-.33.06-.13.03-.25-.02-.35-.05-.1-.45-1.08-.61-1.48-.16-.39-.33-.33-.45-.34-.12-.01-.25-.01-.38-.01-.13 0-.35.05-.53.25-.18.2-.7.69-.7 1.67 0 .98.72 1.93.82 2.06.1.13 1.41 2.15 3.42 3.02.48.2.85.33 1.14.42.48.15.91.13 1.26.08.38-.06 1.17-.48 1.34-.94.16-.46.16-.86.11-.94-.05-.09-.18-.14-.38-.24z"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

// Owner-only: flip the booked flag on one of their own listings (mirrors the
// admin panel's Booked toggle). Once booked, the listing drops out of the
// public site's results, so this is how an owner takes it off-market
// themselves the moment a tenant is finalized, without waiting on admin.
async function toggleMyListingBooked(id, btnEl) {
  const p = MY_LISTINGS_CACHE.find(x => x.id === id);
  if (!p) return;
  const desired = !p.booked;
  btnEl.disabled = true;
  try {
    const res = await fetch(`/api/user/listings/${id}/booked`, {
      method: 'PATCH',
      headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ booked: desired })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.message || 'Could not update booked status.'); return; }
    p.booked = typeof data.booked === 'boolean' ? data.booked : desired;
    renderMyListings();
  } catch (err) {
    alert('⚠️ Could not connect to server.');
  } finally {
    btnEl.disabled = false;
  }
}

// Owner-only: share one of their own listings to anyone via WhatsApp (no
// fixed number — opens wa.me/?text= so the owner picks the recipient from
// their own WhatsApp contacts, same no-fixed-number pattern used by
// shareCompareViaWhatsApp() and admin.html's owner-share feature).
function shareMyListingViaWhatsApp(id) {
  const p = MY_LISTINGS_CACHE.find(x => x.id === id);
  if (!p) return;
  const status = p.basic?.status || 'For Rent';
  const isSell = status === 'For Sale';
  const isShortStay = status === 'Short Stay';
  const rent = p.price?.rent != null ? fmtRupee(p.price.rent) : null;
  const propertyUrl = `${window.location.origin}/property/${p.id}`;
  const lines = [
    `Check out my property "${p.propertyId}" on HomeLoop:`,
    `📍 ${p.location?.area || '—'}`,
  ];
  // "/month" was wrong for a Sell listing's one-time price, and technically
  // wrong for Short Stay's per-day rate too — same fix as buildDetailTable().
  if (rent) lines.push(`💰 ${rent}${isSell ? '' : isShortStay ? '/day' : '/month'}`);
  lines.push(`🏷️ ${status}`);
  lines.push('', `View details: ${propertyUrl}`);
  const msg = lines.join('\n');
  const url = 'https://wa.me/?text=' + encodeURIComponent(msg);
  window.open(url, '_blank', 'noopener');
}

/* ═══════════════════════════════════════════════
   PAYMENTS — UPI/QR/bank transfer with manual admin verification.
   One combined screen (paymentStage2): amount field and QR/UPI/bank details
   are visible together — no separate "Continue" step. The QR/UPI/bank
   details are static settings (/api/payment-settings) and render
   immediately on open. The PaymentRequest itself (which needs an
   amount) is created quietly in the background once the amount field loses
   focus (handleAmountBlur() → ensureCurrentPaymentRequest()). Hitting
   "I've paid — submit for verification" (submitPaymentProof())
   finalizes the request if the amount changed since, then submits an
   optional screenshot; an admin verifies it by hand against the
   bank/UPI statement (server.js: /api/admin/payments/:id/verify).
═══════════════════════════════════════════════ */
let CURRENT_PAYMENT_REQUEST = null; // { id, refCode, amount, purpose }
let PAYMENT_SETTINGS_CACHE  = null; // UPI/QR/bank details, lazy-loaded only when needed
// Stage 1 (purpose/amount/property picker) is skipped entirely now — every
// entry point goes straight to stage 2's combined amount+payment-details
// screen. Property context (when an entry point already knows the listing,
// e.g. "Promote this listing") has nowhere left to be read from at submit
// time, so it's stashed here by openPaymentModal() and read back when the
// PaymentRequest is created.
let CURRENT_PAY_PROPERTY_ID = null;
let CURRENT_PAY_PROPERTY_NOTE = '';
// Whether the "Payment for" category (rent/lease/pg/other) applies to the
// currently-open flow — false for the owner's flat brokerage fee, which has
// no category picker. Read by ensureCurrentPaymentRequest() so the server
// gets a real category (for amount cross-checking) or none, never a stale one.
let CURRENT_PAY_CATEGORY_APPLICABLE = true;

// Plain rupee formatting with thousands separators (fmtRupee() abbreviates to
// K/L/Cr, which isn't right for an exact amount someone is about to pay).
function fmtINR(n) {
  n = Number(n) || 0;
  return '₹' + n.toLocaleString('en-IN');
}

// Builds <option> entries for the "which property" picker out of every
// loaded listing (PROPERTIES, already fetched site-wide on load), formatted
// as "<propertyId> - <Type> - <Area>" e.g. "HWR123 - Rent - Whitefield".
// Sorted by propertyId so a long list stays scannable.
function payPropertyOptionsList() {
  return PROPERTIES
    .filter(p => p.propertyId)
    .map(p => ({ id: String(p.id), label: `${p.propertyId} - ${pTypeLabel(p)} - ${p.location?.area || ''}`.trim().replace(/ - $/, '') }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function populatePayPropertyOptions(selectedId, selectedLabel) {
  const sel = document.getElementById('pay-property');
  const options = payPropertyOptionsList();
  // If we were handed a specific listing (e.g. the Promote button on My
  // Listings) that isn't already in shortlist/recently-viewed, add it so
  // it's selectable and pre-selected.
  if (selectedId && !options.some(o => o.id === String(selectedId))) {
    options.unshift({ id: String(selectedId), label: selectedLabel ? `${selectedLabel}` : 'This listing' });
  }
  sel.innerHTML = '<option value="">Not specific to a property</option>' +
    options.map(o => `<option value="${o.id}">${esc(o.label)}</option>`).join('');
  sel.value = selectedId ? String(selectedId) : '';
}

// purpose: one of 'brokerage' | 'booking' | 'visit_deposit' | 'promotion'.
// propertyId / propertyLabel are optional — passed by entry points that
// already know the specific listing (e.g. the "Promote" button on My
// Listings); stashed in CURRENT_PAY_PROPERTY_ID/NOTE for whenever the
// PaymentRequest ends up getting created, since there's no stage-1 property
// picker left to read it from.
// Stage 1 ("what's this for" / "which property") is skipped for every entry
// point now — this shows the single combined stage-2 screen (amount +
// QR/UPI/bank details) right away. The static payment
// details render immediately; the PaymentRequest itself waits until an
// amount is entered (see handleAmountBlur()).
function openPaymentModal(purpose, propertyId, propertyLabel) {
  const user = getLoggedInUser();
  if (!user) { openAuthModal(); return; }
  if (blockIfNotVerified()) return;

  CURRENT_PAYMENT_REQUEST = null;
  CURRENT_PAY_PROPERTY_ID = propertyId || null;
  CURRENT_PAY_PROPERTY_NOTE = propertyLabel || '';
  document.getElementById('pay-purpose').value = purpose || 'brokerage';

  document.getElementById('paymentStage1').style.display = 'none';
  document.getElementById('paymentStage2').style.display = '';
  document.getElementById('paymentDetailsSection').style.display = '';

  const amtInline = document.getElementById('pay-amount-inline');
  amtInline.value = '';
  amtInline.readOnly = false;
  amtInline.classList.remove('identity-locked');
  document.getElementById('payAmountChangeBtn').style.display = 'none';
  const fileInput = document.getElementById('pay-screenshot');
  if (fileInput) fileInput.value = '';

  // Owner paying the brokerage fee: skip the tenant-style "Payment for"
  // picker and rent math entirely — it's always a flat fixed charge.
  const isOwnerBrokerage = !!user && user.accountType === 'owner' && (purpose || 'brokerage') === 'brokerage';
  // Tells ensureCurrentPaymentRequest() whether the "Payment for" category
  // (rent/lease/pg/other) is meaningful for this flow — the server uses it to
  // cross-check the amount, so we must not send a stale category value left
  // over from a previous open when this flow doesn't actually use one (e.g.
  // the owner's flat fee below).
  CURRENT_PAY_CATEGORY_APPLICABLE = !isOwnerBrokerage;
  document.getElementById('pay-category-group').style.display = isOwnerBrokerage ? 'none' : '';
  document.getElementById('payOwnerFlat').style.display = isOwnerBrokerage ? '' : 'none';

  if (isOwnerBrokerage) {
    document.getElementById('payRentCalc').style.display = 'none';
    document.getElementById('payPgFlat').style.display = 'none';
    document.getElementById('paymentAmountEntry').style.display = 'none';
    amtInline.value = 2000;
    amtInline.readOnly = true;
    amtInline.classList.add('identity-locked');
    handleAmountBlur(); // quietly create the PaymentRequest for the flat ₹2,000
  } else {
    // Reset the "Payment for" picker to Rent by default and sync the visible
    // section (rent calc / charges redirect / manual amount) to match.
    document.getElementById('pay-category').value = 'rent';
    const rentTotal = document.getElementById('pay-rent-total');
    if (rentTotal) rentTotal.value = '';
    handlePayCategoryChange();
  }

  document.getElementById('paymentModal').classList.add('open');
  lockBodyScroll();
  loadPaymentDetailsBox();
}
function closePaymentModal() {
  document.getElementById('paymentModal').classList.remove('open');
  unlockBodyScroll();
}

// Fetches (if not already cached) and renders the static QR/UPI/bank details
// box. These are account-level settings, not tied to a specific
// PaymentRequest, so they can — and now do — render before any amount is
// entered or request created.
async function loadPaymentDetailsBox() {
  if (!PAYMENT_SETTINGS_CACHE) {
    try {
      const s = await fetch('/api/payment-settings');
      PAYMENT_SETTINGS_CACHE = await s.json();
    } catch (err) {
      console.error('payment-settings fetch failed:', err);
    }
  }
  renderPaymentDetailsBox();
}

// Shared clipboard-copy helper. Used directly on click of the UPI ID / UPI
// number rows (tapping the value copies it) and on the amount's copy icon
// in the payment modal. event.stopPropagation() keeps a click here from
// bubbling to any parent row handler. Falls back to a hidden-textarea +
// execCommand for non-secure contexts where navigator.clipboard isn't
// available.
async function copyPaymentDetail(text, btnEl, event) {
  if (event) event.stopPropagation();
  const value = String(text ?? '').trim();
  if (!value) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('Copied to clipboard');
    if (btnEl) {
      btnEl.classList.add('copied');
      setTimeout(() => btnEl.classList.remove('copied'), 1200);
    }
  } catch (err) {
    showToast('Could not copy — please copy it manually', 'error');
  }
}

// Copies whatever amount is currently payable, no matter which category UI
// is showing (Rent/Lease's computed 30%/50%, PG's flat ₹1000, or the plain
// manual field) — they all keep pay-amount-inline in sync, so this is the
// single source of truth to read from.
function copyCurrentAmount(btnEl, event) {
  if (event) event.stopPropagation();
  const val = document.getElementById('pay-amount-inline').value;
  if (!val || Number(val) <= 0) { showToast('Enter an amount first', 'warning'); return; }
  copyPaymentDetail(val, btnEl, event);
}

function renderPaymentDetailsBox() {
  const s = PAYMENT_SETTINGS_CACHE || {};
  const box = document.getElementById('paymentDetailsBox');
  if (!s.upiId && !s.bankAccountNumber && !s.paymentPhone) {
    box.innerHTML = `<div class="profile-list-empty">Payment details haven't been set up yet. Please contact us via Help &amp; Support.</div>`;
    return;
  }
  box.innerHTML = `
    ${s.qrImageUrl ? `<img class="payment-qr-img" src="${safeUrl(s.qrImageUrl)}" alt="Payment QR code" />` : ''}
    <table class="payment-details-table">
      <tbody>
        ${s.upiId ? `<tr class="is-clickable" onclick='copyPaymentDetail(${JSON.stringify(s.upiId).replace(/'/g, "&#39;")}, this, event)' role="button" tabindex="0"><td>UPI ID</td><td><b>${esc(s.upiId)}</b></td></tr>` : ''}
        ${s.paymentPhone ? `<tr class="is-clickable" onclick='copyPaymentDetail(${JSON.stringify(s.paymentPhone).replace(/'/g, "&#39;")}, this, event)' role="button" tabindex="0"><td>UPI / GPay number</td><td><b>${esc(s.paymentPhone)}</b></td></tr>` : ''}
        ${s.bankAccountName ? `<tr><td>Account name</td><td><b>${esc(s.bankAccountName)}</b></td></tr>` : ''}
        ${s.bankAccountNumber ? `<tr><td>Account number</td><td><b>${esc(s.bankAccountNumber)}</b></td></tr>` : ''}
        ${s.bankIfsc ? `<tr><td>IFSC</td><td><b>${esc(s.bankIfsc)}</b></td></tr>` : ''}
      </tbody>
    </table>
	${s.upiId ? `
      <button type="button" class="form-submit payment-upi-pay-btn" onclick="payViaUpiApp()">Pay via UPI app</button>
    ` : ''}
  `;
}

// Switches the payment modal's visible section based on the "Payment for"
// dropdown: Rent auto-calculates 30% of the entered monthly rent, Lease
// auto-calculates 50% (half a month's rent), PG is a flat ₹1000 fee with no
// total-amount entry needed, and Other keeps the plain manual amount field.
// In every case the computed figure feeds the same hidden pay-amount-inline
// field, so the existing PaymentRequest/UPI-link plumbing needs no changes.
function handlePayCategoryChange() {
  const cat = document.getElementById('pay-category').value;
  const rentBox = document.getElementById('payRentCalc');
  const pgBox = document.getElementById('payPgFlat');
  const amountEntry = document.getElementById('paymentAmountEntry');
  const rentLabel = document.getElementById('pay-rent-label');
  const computedLabel = document.getElementById('pay-rent-computed-label');
  const amt = document.getElementById('pay-amount-inline');

  rentBox.style.display = 'none';
  pgBox.style.display = 'none';
  amountEntry.style.display = 'none';

  if (cat === 'rent' || cat === 'lease') {
    rentBox.style.display = '';
    rentLabel.textContent = 'Monthly rent (₹)';
    computedLabel.textContent = cat === 'rent' ? 'Amount payable (30%)' : "Amount payable (50%)";
    document.getElementById('pay-rent-total').value = '';
    document.getElementById('pay-rent-computed').textContent = fmtINR(0);
    amt.value = '';
    amt.readOnly = true;
    amt.classList.add('identity-locked');
  } else if (cat === 'pg') {
    pgBox.style.display = '';
    amt.value = 1000;
    amt.readOnly = true;
    amt.classList.add('identity-locked');
    handleAmountBlur(); // quietly create the PaymentRequest for the flat ₹1000
  } else {
    amountEntry.style.display = '';
    amt.value = '';
    amt.readOnly = false;
    amt.classList.remove('identity-locked');
    document.getElementById('payAmountChangeBtn').style.display = 'none';
  }
}

// Live display only (no network calls) — keeps the computed figure and the
// hidden amount field in sync as the user types the monthly rent. Percentage
// depends on which category is selected: 30% for Rent, 50% for Lease.
function updateRentComputedDisplay() {
  const cat = document.getElementById('pay-category').value;
  const pct = cat === 'lease' ? 0.5 : 0.3;
  const total = Number(document.getElementById('pay-rent-total').value) || 0;
  const amount = Math.round(total * pct);
  document.getElementById('pay-rent-computed').textContent = fmtINR(amount);
  document.getElementById('pay-amount-inline').value = amount > 0 ? amount : '';
}

// Fires once the rent-total field loses focus: finalizes the computed
// display, then quietly creates/refreshes the PaymentRequest for the 30%
// amount so the UPI link/QR are ready, same as handleAmountBlur() does for
// the plain amount field.
function handleRentTotalBlur() {
  updateRentComputedDisplay();
  handleAmountBlur();
}

// Fires on the amount field losing focus: creates the PaymentRequest quietly
// in the background (or re-creates it if the amount changed since) so the
// reference code / "Pay via UPI app" button are ready before the user needs
// them — no separate "Continue" click. Silently no-ops until a valid amount
// is present; submitPaymentProof() re-checks and creates it at submit time
// too, in case this blur handler never fired (e.g. autofill, or submitting
// without leaving the field).
async function handleAmountBlur() {
  const amount = Number(document.getElementById('pay-amount-inline').value);
  if (!amount || amount <= 0) return;
  await ensureCurrentPaymentRequest(amount);
}

// Creates the PaymentRequest if none exists yet for this amount, or
// re-creates it if the amount has changed since the last one was made
// (the old in-progress request is simply abandoned, same as before).
async function ensureCurrentPaymentRequest(amount) {
  if (CURRENT_PAYMENT_REQUEST && CURRENT_PAYMENT_REQUEST.amount === amount) return CURRENT_PAYMENT_REQUEST;
  const purpose = document.getElementById('pay-purpose').value;
  // category/rentTotal let the server cross-check the amount against the
  // same 30%/50%/flat-fee rules this UI already computes — see
  // handlePayCategoryChange()/updateRentComputedDisplay() above.
  const category = CURRENT_PAY_CATEGORY_APPLICABLE ? document.getElementById('pay-category').value : undefined;
  const rentTotalEl = document.getElementById('pay-rent-total');
  const rentTotal = (category === 'rent' || category === 'lease') && rentTotalEl && rentTotalEl.value
    ? Number(rentTotalEl.value) : undefined;
  return finalizePaymentRequestCreation(purpose, amount, CURRENT_PAY_PROPERTY_NOTE, CURRENT_PAY_PROPERTY_ID, category, rentTotal);
}

// Creates the PaymentRequest server-side and updates the reference badge.
// Called both from the amount-blur auto-create path and from
// submitPaymentProof() as a fallback. Returns the created request, or null
// if it failed (toast already shown).
async function finalizePaymentRequestCreation(purpose, amount, note, propertyId, category, rentTotal) {
  const res = await fetch('/api/payments/request', {
    method: 'POST',
    headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ purpose, amount, note, propertyId: propertyId || undefined, category, rentTotal })
  });
  const data = await res.json();
  if (!res.ok) { if (handleNotVerifiedError(data)) return null; showToast(data.message || 'Could not start payment', 'error'); return null; }

  CURRENT_PAYMENT_REQUEST = {
    id: data.request._id, refCode: data.request.refCode, amount: data.request.amount,
    purpose: data.request.purpose,
  };
  return CURRENT_PAYMENT_REQUEST;
}

// Dead code now that stage 1's markup is never shown (kept only in case it's
// wanted back) — paymentStage1Btn's onclick still points here but the button
// is unreachable since #paymentStage1 stays display:none.
async function createPaymentRequest() {
  const purpose      = document.getElementById('pay-purpose').value;
  const propSel      = document.getElementById('pay-property');
  const propertyId   = propSel.value || null;
  const propertyNote = propSel.value ? propSel.options[propSel.selectedIndex].textContent : '';
  const amount     = Number(document.getElementById('pay-amount').value);
  const note       = propertyNote;

  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'warning'); return; }

  const btn = document.getElementById('paymentStage1Btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const request = await finalizePaymentRequestCreation(purpose, amount, note, propertyId);
    if (!request) return;
    document.getElementById('paymentStage1').style.display = 'none';
    document.getElementById('paymentStage2').style.display = '';
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
}

// Lets the user unlock and re-enter the amount after payment details have
// already been generated for it (e.g. they mistyped it). The in-progress
// PaymentRequest is simply abandoned -- hitting Continue again creates a
// fresh one with the corrected amount.
// Lets the user unlock and re-enter the amount after a request has already
// been created for it (e.g. resuming a pending payment, or they mistyped
// it). The in-progress PaymentRequest is simply abandoned — losing focus on
// the field again (or hitting submit) creates a fresh one with the
// corrected amount.
function changePaymentAmount() {
  CURRENT_PAYMENT_REQUEST = null;
  const amountInput = document.getElementById('pay-amount-inline');
  amountInput.readOnly = false;
  amountInput.classList.remove('identity-locked');
  amountInput.focus();
  document.getElementById('payAmountChangeBtn').style.display = 'none';
}
// Jumps straight to stage 2 for an existing pending/submitted request, e.g.
// when the user reopens a payment from their history instead of starting a
// new one. Any old paymentMethod:'razorpay' record that never completed is
// resumed here too — Razorpay is gone, so this is the only path forward now.
async function resumePaymentRequest(payment) {
  if (!PAYMENT_SETTINGS_CACHE) {
    try {
      PAYMENT_SETTINGS_CACHE = await (await fetch('/api/payment-settings')).json();
    } catch (err) {
      console.error('payment-settings fetch failed:', err);
    }
  }

  CURRENT_PAYMENT_REQUEST = { id: payment._id, refCode: payment.refCode, amount: payment.amount, purpose: payment.purpose };
  CURRENT_PAY_PROPERTY_ID = null;
  CURRENT_PAY_PROPERTY_NOTE = '';

  document.getElementById('paymentModal').classList.add('open');
  lockBodyScroll();
  document.getElementById('paymentStage1').style.display = 'none';
  document.getElementById('paymentStage2').style.display = '';
  document.getElementById('paymentDetailsSection').style.display = '';
  // Resuming an existing request — the amount is already fixed, so show the
  // plain amount field rather than the rent-calc/charges-redirect UI.
  document.getElementById('pay-category').value = 'other';
  document.getElementById('payRentCalc').style.display = 'none';
  document.getElementById('payPgFlat').style.display = 'none';
  document.getElementById('paymentAmountEntry').style.display = '';
  const amtInline = document.getElementById('pay-amount-inline');
  amtInline.value = payment.amount;
  amtInline.readOnly = true; // resuming an existing request — amount is fixed unless they hit Change
  amtInline.classList.add('identity-locked');
  document.getElementById('payAmountChangeBtn').style.display = '';
  const fileInput = document.getElementById('pay-screenshot');
  if (fileInput) fileInput.value = '';
  renderPaymentDetailsBox();
}


// Builds a standard UPI deep link (upi://pay?...) — tapping/opening this on a
// phone hands off to whichever UPI apps are installed (GPay, PhonePe, Paytm,
// BHIM, etc.) via the OS's own app chooser; we never see which app they used
// or any payment instrument, exactly like the QR code does. `tn` (transaction
// note) is set to our reference code so it's easy to match back to this
// PaymentRequest when reviewing the screenshot they submit after.
function buildUpiIntentUrl(s) {
  if (!s?.upiId || !CURRENT_PAYMENT_REQUEST?.amount) return null;
  const params = new URLSearchParams({
    pa: s.upiId,
    pn: s.bankAccountName || 'Payment',
    am: String(CURRENT_PAYMENT_REQUEST.amount),
    cu: 'INR',
    tn: CURRENT_PAYMENT_REQUEST.refCode || '',
  });
  return `upi://pay?${params.toString()}`;
}

// Handler for the "Pay via UPI app" button and the clickable UPI ID/number
// rows. Only works on a device with a UPI app installed (i.e. a phone) —
// desktop browsers have nothing registered to handle the upi:// scheme, so
// this will silently do nothing there; the QR code and manual entry remain
// as the fallback either way.
function payViaUpiApp() {
  const url = buildUpiIntentUrl(PAYMENT_SETTINGS_CACHE);
  if (!url) { showToast('Enter an amount first', 'warning'); return; }
  window.location.href = url;
}

// Combined submit: makes sure a PaymentRequest exists for the current amount
// (normally already created quietly by handleAmountBlur() when the amount
// field lost focus — this is the fallback for e.g. autofill, or hitting
// submit without ever leaving the field), then submits the screenshot
// proof against it.
async function submitPaymentProof() {
  const amount = Number(document.getElementById('pay-amount-inline').value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'warning'); return; }

  const fileInput = document.getElementById('pay-screenshot');
  const formData = new FormData();
  if (fileInput && fileInput.files[0]) formData.append('screenshot', fileInput.files[0]);

  const btn = document.getElementById('paymentSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    const request = await ensureCurrentPaymentRequest(amount);
    if (!request) return;
    const res = await fetch(`/api/payments/${request.id}/submit-proof`, {
      method: 'POST',
      headers: userAuthHeaders(), // no Content-Type — the browser sets the multipart boundary itself
      body: formData
    });
    const data = await res.json();
    if (!res.ok) { if (handleNotVerifiedError(data)) return; showToast(data.message || 'Could not submit payment proof', 'error'); return; }
    showToast('Payment submitted — we\'ll verify it shortly');
    closePaymentModal();
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = "I've paid — submit for verification";
  }
}

/* ═══════════════════════════════════════════════
   PROPERTY EDIT (full form) — reuses the exact same form used to create a
   listing (applyImportedProperty() already knows how to load every field
   from a property object, since it also powers the read-only detail view
   and the JSON-import feature) so the owner can edit *every* field of a
   listing they posted, not just a few. submitListing() below then PUTs
   instead of POSTs when editingPropertyId is set.
═══════════════════════════════════════════════ */
function openEditListingFull(id) {
  const p = MY_LISTINGS_CACHE.find(x => x.id === id);
  if (!p) { showToast('Could not find that listing', 'error'); return; }

  closeProfileModal();
  editingPropertyId = id;
  resetListingForm();
  unlockIdentityFieldsForEdit();
  applyImportedProperty(p);
  onFTypeChange(document.getElementById('f-type').value);

  // Changing the listing type (Rent/Lease/PG/Short Stay) after creation would
  // need re-deriving a lot of type-specific fields, so keep it locked here —
  // same restriction the old quick-edit modal had.
  const typeSelect = document.getElementById('f-type');
  if (typeSelect) typeSelect.disabled = true;

  // Hide the "Clear form" button — doesn't make sense while editing a
  // listing that already exists.
  const clearBtn = document.getElementById('clearFormBtn');
  if (clearBtn) clearBtn.style.display = 'none';

  document.getElementById('addModalTitleText').textContent = 'Edit listing';
  const sub = document.getElementById('addModalSubtitleText');
  if (sub) {
    sub.textContent = p.propertyId || '';
    sub.style.display = p.propertyId ? '' : 'none';
  }

  const submitBtn = document.getElementById('listingSubmitBtn');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save changes'; }

  document.getElementById('addModal').classList.add('open');
  lockBodyScroll();
}

function closeEditListingFull() {
  document.getElementById('addModal').classList.remove('open');
  unlockBodyScroll();
  editingPropertyId = null;

  const typeSelect = document.getElementById('f-type');
  if (typeSelect) typeSelect.disabled = false;

  const clearBtn = document.getElementById('clearFormBtn');
  if (clearBtn) clearBtn.style.display = '';

  document.getElementById('addModalTitleText').textContent = 'List your property';
  const sub = document.getElementById('addModalSubtitleText');
  if (sub) { sub.style.display = 'none'; sub.textContent = ''; }

  const submitBtn = document.getElementById('listingSubmitBtn');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit listing'; }

  // Put the form back to a blank "new listing" state, then restore whatever
  // the user themselves had in progress before they tapped Edit, if anything.
  resetListingForm();
  restoreListingDraft();
}

/* ═══════════════════════════════════════════════
   DUPLICATE LISTING — for the "same building, another vacant unit" case:
   pre-fills the normal "List your property" form from an existing listing
   of this owner's so they don't have to re-key everything, then leaves it
   as a completely independent new-listing draft (editingPropertyId stays
   null, so submitListing() POSTs a fresh property, not a PUT). Owner
   identity fields are re-locked to the logged-in account afterward, same
   as any other new listing.
═══════════════════════════════════════════════ */
function openCloneListingFull(id) {
  const p = MY_LISTINGS_CACHE.find(x => x.id === id);
  if (!p) { showToast('Could not find that listing', 'error'); return; }

  closeProfileModal();
  resetListingForm();
  applyImportedProperty(p);
  // applyImportedProperty() copies the source listing's owner name/phone/
  // email too. Owner name is left as copied (it's an editable field, not
  // an account-locked one — cloning "same building, another unit" usually
  // means the same owner). Phone/email are still overwritten back to the
  // logged-in account and re-locked, exactly like starting any other new
  // listing.
  lockIdentityFieldsForNewListing();
  onFTypeChange(document.getElementById('f-type').value);

  // Unlike editing, the type is free to change — this is a brand-new,
  // independent listing.
  const typeSelect = document.getElementById('f-type');
  if (typeSelect) typeSelect.disabled = false;

  const clearBtn = document.getElementById('clearFormBtn');
  if (clearBtn) clearBtn.style.display = '';

  document.getElementById('addModalTitleText').textContent = 'List your property';
  const sub = document.getElementById('addModalSubtitleText');
  if (sub) {
    sub.textContent = p.propertyId ? `Copied from ${p.propertyId} — update what's different` : '';
    sub.style.display = p.propertyId ? '' : 'none';
  }

  const submitBtn = document.getElementById('listingSubmitBtn');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit listing'; }

  document.getElementById('addModal').classList.add('open');
  lockBodyScroll();
  showToast('Details copied — update what\'s different and submit');
}

/* ═══════════════════════════════════════════════
   PROFILE MODAL — SAVED (shortlisted) PROPERTIES
═══════════════════════════════════════════════ */
function loadSavedListings() {
  const wrap = document.getElementById('savedListingsContent');
  const ids = [...shortlisted];
  const emptyHtml = `<div class="profile-list-empty">
    <div class="profile-list-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></div>
    No saved properties yet.<br>Tap ♡ on any listing to save it here.
  </div>`;
  if (!ids.length) {
    wrap.innerHTML = emptyHtml;
    return;
  }
  const items = ids.map(id => shortlistedData[id]).filter(Boolean);
  if (!items.length) {
    wrap.innerHTML = emptyHtml;
    return;
  }
  wrap.innerHTML = items.map(p => {
    const img = (p.media?.images || [])[0];
    const thumb = img ? `style="background-image:url('${safeUrl(img)}')"` : '';
    const rent = p.price?.rent != null ? fmtRupee(p.price.rent) : '—';
    return `<div class="profile-mini-card" onclick="closeProfileModal();openDetail('${p.id}')">
      <div class="profile-mini-thumb" ${thumb}>${img ? '' : 'No photo'}</div>
      <div class="profile-mini-body">
        <div class="profile-mini-title">${esc(p.propertyId) || 'Untitled listing'}</div>
        <div class="profile-mini-sub">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${esc(p.location?.area)}
        </div>
        <div class="profile-mini-price">${rent}<span style="color:var(--text-3);font-weight:500">/ Month</span></div>
      </div>
      <div class="profile-mini-actions">
        <button class="profile-mini-icon-btn danger" title="Remove from saved" onclick="event.stopPropagation();removeSavedListing('${p.id}')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}
function removeSavedListing(id) {
  id = String(id);
  shortlisted.delete(id);
  delete shortlistedData[id];
  saveShortlist();
  saveShortlistData();
  loadSavedListings();
  renderCards();
  showToast('Removed from saved');
}



/* ═══════════════════════════════════════════════
   NOTIFICATIONS MODAL
═══════════════════════════════════════════════ */
let notifPollTimer = null;

// Called from updateNavAuth() — starts/stops the unread-count poll based on login state.
function refreshNotifPolling() {
  if (notifPollTimer) { clearInterval(notifPollTimer); notifPollTimer = null; }
  if (!getLoggedInUser()) { updateNotifBadge(0); return; }
  refreshNotifCount();
  notifPollTimer = setInterval(refreshNotifCount, 30000);
}
async function refreshNotifCount() {
  if (!getLoggedInUser()) return;
  try {
    const res = await fetch('/api/user/notifications/unread-count', { headers: userAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    updateNotifBadge(data.unreadCount || 0);
  } catch (err) { /* silent — badge just skips this cycle */ }
}
function updateNotifBadge(count) {
  [document.getElementById('navNotifCount'), document.getElementById('menuNotifCount'), document.getElementById('qmbNotifCount')].forEach(el => {
    if (!el) return;
    el.textContent = count > 9 ? '9+' : String(count);
  });
}
// Icon + color per notification kind. visit_status notifications are further
// split by meta.status (Confirmed/Cancelled/Completed/Pending) so a cancelled
// visit reads differently at a glance from a confirmed one.
const NOTIF_STYLE = {
  property_verified: { bg: '#e8f7ef', color: '#1a9c5c', icon: '<polyline points="20 6 9 17 4 12"/>' },
  review_approved:   { bg: '#f2eeff', color: '#7c5cff', icon: '<polygon points="6 3 20 12 6 21 6 3"/>' },
  account_approved:  { bg: '#e8f7ef', color: '#1a9c5c', icon: '<polyline points="20 6 9 17 4 12"/>' },
  account_rejected:  { bg: '#fdecef', color: '#E03A52', icon: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' },
  visit_confirmed:   { bg: '#eaf1ff', color: '#2f6fed', icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/>' },
  visit_cancelled:   { bg: '#fdecef', color: '#E03A52', icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9.5" y1="14" x2="14.5" y2="18"/><line x1="14.5" y1="14" x2="9.5" y2="18"/>' },
  visit_completed:   { bg: '#eef1fc', color: '#5b7be8', icon: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>' },
  visit_pending:     { bg: '#fff8e6', color: '#b8860b', icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
  default:           { bg: 'var(--brand-light)', color: 'var(--brand)', icon: '<circle cx="12" cy="12" r="1.6"/>' },
};
function resolveNotifStyle(n) {
  let key = n.type;
  if (n.type === 'visit_status' && n.meta && n.meta.status) key = 'visit_' + String(n.meta.status).toLowerCase();
  if (n.type === 'account_verification' && n.meta && n.meta.status) key = 'account_' + String(n.meta.status).toLowerCase();
  return NOTIF_STYLE[key] || NOTIF_STYLE.default;
}
// Relative timestamp for a notification, e.g. "3 hours ago".
function notifTimeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return mins + (mins === 1 ? ' min ago' : ' mins ago');
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hrs / 24);
  if (days < 7)  return days + (days === 1 ? ' day ago' : ' days ago');
  return formatDateDisplay(dateStr);
}
function renderNotifications(list) {
  const container = document.getElementById('notifList');
  if (!list || !list.length) {
    container.innerHTML = `<div class="notif-empty">
      <svg viewBox="0 0 24 24" width="34" height="34" stroke-width="1.5" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      No notifications yet
    </div>`;
    updateNotifChrome(0);
    return;
  }
  container.innerHTML = list.map(n => {
    const st = resolveNotifStyle(n);
    return `
    <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n._id}">
      <div class="notif-icon" style="background:${st.bg};color:${st.color}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${st.icon}</svg>
      </div>
      <div class="notif-body">
        <div class="notif-text">${n.read ? `${esc(n.title)} ${esc(n.message)}` : `<b>${esc(n.title)} ${esc(n.message)}</b>`}</div>
        <div class="notif-meta-row">
          <span class="notif-time">${notifTimeAgo(n.createdAt)}</span>
          <span style="display:flex;align-items:center;gap:12px">
            ${notifCalendarLink(n)}
            ${n.read ? '' : `<span class="notif-mark-read" onclick="markNotifRead('${n._id}', this)">Mark as read</span>`}
          </span>
        </div>
      </div>
    </div>`;
  }).join('');
  updateNotifChrome(list.filter(n => !n.read).length);
}
// "Add to calendar" link shown on a visit_status notification, as long as
// the visit still has a date/time to add and hasn't been cancelled — a
// cancelled visit has nothing worth putting on the calendar. Meta is stashed
// in a data attribute (base64, to sidestep quote-escaping in the HTML) and
// decoded on click rather than inlined into the onclick handler itself.
function notifCalendarLink(n) {
  if (n.type !== 'visit_status' || !n.meta || !n.meta.visitDate || !n.meta.visitTime) return '';
  if (n.meta.status === 'Cancelled') return '';
  const payload = btoa(encodeURIComponent(JSON.stringify(n.meta)));
  return `<span class="cal-notif-link" onclick="openVisitCalendarFromNotif('${payload}')">Add to calendar</span>`;
}
function openVisitCalendarFromNotif(payload) {
  let meta;
  try { meta = JSON.parse(decodeURIComponent(atob(payload))); } catch { return; }
  closeNotifModal();
  openVisitCalendarOptions({
    propertyName: meta.propertyName || '',
    propertyArea: meta.propertyArea || '',
    propertyCode: meta.propertyCode || '',
    visitDate:    meta.visitDate,
    visitTime:    meta.visitTime,
  }, { title: 'Add your visit to calendar' });
}
// Keeps the header subtitle and footer button in sync with how many unread
// items are currently shown in the list (recomputed from the DOM so it stays
// correct after individual mark-as-read clicks, not just on initial load).
function updateNotifChrome(unreadCount) {
  const sub = document.getElementById('notifModalSub');
  if (sub) sub.textContent = unreadCount > 0 ? `${unreadCount} unread update${unreadCount > 1 ? 's' : ''}` : "You're all caught up";
  const btn = document.getElementById('notifMarkAllBtn');
  if (btn) btn.disabled = unreadCount === 0;
}
async function openNotifModal() {
  document.getElementById('notifModal').classList.add('open');
  lockBodyScroll();
  const user = getLoggedInUser();
  const list = document.getElementById('notifList');
  if (!user) {
    list.innerHTML = '<div class="notif-empty">Log in to see your notifications</div>';
    updateNotifChrome(0);
    return;
  }
  list.innerHTML = '<div class="notif-empty">Loading…</div>';
  try {
    const res = await fetch('/api/user/notifications', { headers: userAuthHeaders() });
    const data = await res.json();
    renderNotifications(data.notifications);
    updateNotifBadge(data.unreadCount || 0);
  } catch (err) {
    list.innerHTML = '<div class="notif-empty">Couldn\'t load notifications</div>';
  }
}
// Marks one notification as read in place — unbolds its text, drops its
// "Mark as read" link, and updates the header/footer/badge accordingly.
async function markNotifRead(id, el) {
  const item = el.closest('.notif-item');
  try {
    await fetch(`/api/user/notifications/${id}/read`, { method: 'PATCH', headers: userAuthHeaders() });
    if (item) {
      item.classList.remove('unread');
      const b = item.querySelector('.notif-text b');
      if (b) b.replaceWith(document.createTextNode(b.textContent));
      el.remove();
    }
    updateNotifChrome(document.querySelectorAll('#notifList .notif-item.unread').length);
    refreshNotifCount();
  } catch (err) { /* best-effort */ }
}
async function markAllNotifsRead() {
  if (!getLoggedInUser()) return;
  try {
    await fetch('/api/user/notifications/read-all', { method: 'PATCH', headers: userAuthHeaders() });
    updateNotifBadge(0);
    document.querySelectorAll('#notifList .notif-item.unread').forEach(item => item.classList.remove('unread'));
    document.querySelectorAll('#notifList .notif-text b').forEach(b => b.replaceWith(document.createTextNode(b.textContent)));
    document.querySelectorAll('#notifList .notif-mark-read').forEach(el => el.remove());
    updateNotifChrome(0);
  } catch (err) { /* best-effort */ }
}
function closeNotifModal() {
  document.getElementById('notifModal').classList.remove('open');
  unlockBodyScroll();
}

/* ═══════════════════════════════════════════════
   REFER & EARN MODAL
═══════════════════════════════════════════════ */
function openReferModal() {
  const user = getLoggedInUser();
  const preloadName = (user && `${user.firstName || ''} ${user.lastName || ''}`.trim()) || (user && user.name) || '';
  document.getElementById('refer-name').value = preloadName;
  document.getElementById('refer-phone').value = (user && user.mobile) || '';
  document.getElementById('refer-tenant-name').value = '';
  document.getElementById('refer-tenant-phone').value = '';
  // Lock the referrer's own identity to the logged-in account, same pattern
  // as the Schedule a Visit modal, only when logged in — guests fill both
  // their own and the tenant's fields in themselves.
  ['refer-name', 'refer-phone'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.readOnly = !!user;
    el.classList.toggle('identity-locked', !!user);
    const hint = document.getElementById(id + '-hint');
    if (hint) hint.style.display = user ? '' : 'none';
  });
  document.getElementById('referModal').classList.add('open');
  lockBodyScroll();
}
function closeReferModal() {
  document.getElementById('referModal').classList.remove('open');
  unlockBodyScroll();
}
// Sharing always works, with or without any details filled in:
//  - tenant's phone given → invite goes straight to their WhatsApp
//  - tenant's phone blank → generic "share with anyone" link (native share
//    sheet / clipboard fallback), same as before
// Registering the referral (for reward credit) only happens when every
// field is filled in and valid. When it does, the user sees a confirmation
// modal with exactly what got registered *before* the invite is shared —
// sharing is resumed only once they hit "Continue to share" on that modal.
// If registration isn't attempted (fields missing/invalid) or it fails,
// sharing still goes out immediately, same as before.
let _pendingReferralShare = null;

async function inviteAndRegisterReferral() {
  const referrerName  = document.getElementById('refer-name').value.trim();
  const referrerPhone = document.getElementById('refer-phone').value.trim();
  const tenantName    = document.getElementById('refer-tenant-name').value.trim();
  const tenantPhone   = document.getElementById('refer-tenant-phone').value.trim();

  // Catch the common case immediately, without a round trip — both fields
  // are already digit-only via sanitizeMobileInput, so a plain compare works.
  if (referrerPhone && tenantPhone && referrerPhone === tenantPhone) {
    openReferSelfModal({ tenantName, tenantPhone });
    return;
  }

  const canRegister = referrerName && isValidIndianMobile(referrerPhone) && tenantName && isValidIndianMobile(tenantPhone);

  if (canRegister) {
    try {
      const res = await fetch('/api/referrals', {
        method: 'POST',
        headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ referrerName, referrerPhone, tenantName, tenantPhone })
      });
      if (res.ok) {
        _pendingReferralShare = { tenantName, tenantPhone };
        openReferDetailsModal({ referrerName, referrerPhone, tenantName, tenantPhone });
        return; // share happens from the details modal's "Continue" action
      }
      if (res.status === 409 || res.status === 400) {
        let body = {};
        try { body = await res.json(); } catch (e) {}
        if (body && body.duplicate) {
          _pendingReferralShare = { tenantName, tenantPhone };
          openReferDuplicateModal({ tenantName, tenantPhone });
          return; // share happens from the duplicate modal's "Share anyway" action
        }
        // Belt-and-braces: the client-side check above should already have
        // caught this, but a normalization difference server-side (or a
        // stale/pre-filled field) could still slip one through.
        if (body && body.selfReferral) {
          openReferSelfModal({ tenantName, tenantPhone });
          return; // share happens from the self-referral modal's "Share anyway" action
        }
      }
    } catch (err) {
      // Registration failed — fall through and share anyway below,
      // honoring the "sharing always works" guarantee.
    }
  }

  if (isValidIndianMobile(tenantPhone)) {
    shareToTenantWhatsApp(tenantPhone, tenantName);
  } else {
    shareReferralCode(tenantName);
  }
  document.getElementById('refer-tenant-name').value = '';
  document.getElementById('refer-tenant-phone').value = '';
  closeReferModal();
}

// Swaps the entry form for the confirmation modal without releasing the
// scroll lock in between (one modal is open at all times here).
function openReferDetailsModal(details) {
  document.getElementById('referDetailsName').textContent = details.referrerName;
  document.getElementById('referDetailsPhone').textContent = details.referrerPhone;
  document.getElementById('referDetailsTenantName').textContent = details.tenantName;
  document.getElementById('referDetailsTenantPhone').textContent = details.tenantPhone;
  document.getElementById('referModal').classList.remove('open');
  document.getElementById('referDetailsModal').classList.add('open');
}

// Closing without continuing (✕ / backdrop) cancels the pending share —
// the referral stays registered, but nothing gets sent to the tenant.
function closeReferDetailsModal() {
  document.getElementById('referDetailsModal').classList.remove('open');
  unlockBodyScroll();
  _pendingReferralShare = null;
  document.getElementById('refer-tenant-name').value = '';
  document.getElementById('refer-tenant-phone').value = '';
}

function continueShareAfterRegistration() {
  const pending = _pendingReferralShare;
  document.getElementById('referDetailsModal').classList.remove('open');
  unlockBodyScroll();
  _pendingReferralShare = null;
  document.getElementById('refer-tenant-name').value = '';
  document.getElementById('refer-tenant-phone').value = '';
  if (!pending) return;
  shareToTenantWhatsApp(pending.tenantPhone, pending.tenantName);
  showToast("Referral registered — you'll get credit for the reward!", 'success');
}

// This tenant's number was already referred (by anyone) — the backend
// rejects it as a duplicate before it ever reaches Referral.create, so no
// second entry is written and no reward is registered for this attempt.
// The referrer can still forward the link; they just won't get credited
// twice for the same tenant.
function openReferDuplicateModal(details) {
  document.getElementById('referDuplicateTenantName').textContent = details.tenantName;
  document.getElementById('referDuplicateTenantPhone').textContent = details.tenantPhone;
  document.getElementById('referModal').classList.remove('open');
  document.getElementById('referDuplicateModal').classList.add('open');
}

function closeReferDuplicateModal() {
  document.getElementById('referDuplicateModal').classList.remove('open');
  unlockBodyScroll();
  _pendingReferralShare = null;
  document.getElementById('refer-tenant-name').value = '';
  document.getElementById('refer-tenant-phone').value = '';
}

function shareAnywayAfterDuplicate() {
  const pending = _pendingReferralShare;
  document.getElementById('referDuplicateModal').classList.remove('open');
  unlockBodyScroll();
  _pendingReferralShare = null;
  document.getElementById('refer-tenant-name').value = '';
  document.getElementById('refer-tenant-phone').value = '';
  if (!pending) return;
  shareToTenantWhatsApp(pending.tenantPhone, pending.tenantName);
}

// The tenant number matches the referrer's own number — no referral gets
// registered. "Share anyway" uses the generic link (not a WhatsApp message
// to yourself), same as leaving the tenant fields blank.
function openReferSelfModal(details) {
  document.getElementById('referSelfTenantPhone').textContent = details.tenantPhone;
  document.getElementById('referModal').classList.remove('open');
  document.getElementById('referSelfModal').classList.add('open');
}

function closeReferSelfModal() {
  document.getElementById('referSelfModal').classList.remove('open');
  unlockBodyScroll();
  _pendingReferralShare = null;
  document.getElementById('refer-tenant-name').value = '';
  document.getElementById('refer-tenant-phone').value = '';
}

function shareAnywayAfterSelfReferral() {
  const tenantName = document.getElementById('refer-tenant-name').value.trim();
  document.getElementById('referSelfModal').classList.remove('open');
  unlockBodyScroll();
  _pendingReferralShare = null;
  document.getElementById('refer-tenant-name').value = '';
  document.getElementById('refer-tenant-phone').value = '';
  shareReferralCode(tenantName);
}

// Opens a WhatsApp chat pre-filled with the invite, addressed directly to
// the tenant's number (assumes India, +91 — matches isValidIndianMobile).
function shareToTenantWhatsApp(tenantPhone, tenantName) {
  const website = "https://homeloop.in";
  const greeting = tenantName ? `Hi ${tenantName}! 🏠` : '🏠 Hey!';
  const text = `${greeting}

Find verified Rentals, PGs, Leases, Short Stays, and more—all in one place.
${website}`;
  window.open(`https://wa.me/91${tenantPhone}?text=${encodeURIComponent(text)}`, '_blank');
}
function copyVideoLink(url) {
  if (!url) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('Video link copied!'));
  } else {
    showToast('Video link: ' + url, 'info');
  }
}

function copyReferralCode() {
  const code = document.getElementById('referCodeText').textContent.trim();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => showToast('Referral code copied!'));
  } else {
    showToast('Referral code: ' + code, 'info');
  }
}
function shareReferralCode(tenantName) {
  const website = "https://homeloop.in";

  const greeting = tenantName ? `Hi ${tenantName}! 🏠` : '🏠 Looking for a home?';
  const text = `${greeting}

Find verified Rentals, PGs, Leases, Short Stays, and more—all in one place.`;

  if (navigator.share) {
    navigator.share({
      title: "RentInPeace",
      text: text,
      url: website
    }).catch(() => {});
  } else {
    navigator.clipboard.writeText(`${text}\n${website}`).then(() => {
      showToast("Website link copied!");
    });
  }
}

/* ═══════════════════════════════════════════════
   HELP & SUPPORT MODAL
═══════════════════════════════════════════════ */
function openChargesModal() {
  const user = getLoggedInUser();
  const isOwner = !!user && user.accountType === 'owner';
  const isTenant = !!user && user.accountType !== 'owner';
  document.getElementById('chargesTenantView').style.display = isTenant ? '' : 'none';
  document.getElementById('chargesOwnerView').style.display = isOwner ? '' : 'none';
  document.getElementById('chargesGuestView').style.display = user ? 'none' : '';
  if (!user) switchChargesAudience('tenant'); // always reset guest tab to Tenants on open
  document.getElementById('chargesModal').classList.add('open');
  lockBodyScroll();
}
function closeChargesModal() {
  document.getElementById('chargesModal').classList.remove('open');
  unlockBodyScroll();
}
function switchChargesAudience(which) {
  ['tenant', 'owner'].forEach(k => {
    document.getElementById('chargesTabBtn-' + k).classList.toggle('active', k === which);
    document.getElementById('chargesTabPanel-' + k).classList.toggle('active', k === which);
  });
}

function openHelpModal() {
  document.getElementById('helpModal').classList.add('open');
  lockBodyScroll();
}
function scrollServices(dir) {
  const el = document.getElementById('servicesScroll');
  const cardWidth = el.querySelector('.service-card')?.offsetWidth || 280;
  el.scrollBy({ left: dir * (cardWidth + 16) * 2, behavior: 'smooth' });
}
function scrollHonestReviews(dir) {
  const el = document.getElementById('honestReviewsScroll');
  const cardWidth = el.querySelector('.hr-card')?.offsetWidth || 280;
  el.scrollBy({ left: dir * (cardWidth + 14) * 2, behavior: 'smooth' });
}
function openHonestReview(url) {
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}

const HR_PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const HR_VERIFIED_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5.5 3.4 9.7 8 11 4.6-1.3 8-5.5 8-11V5l-8-3z"/></svg>';

function renderHonestReviews(reviews) {
  const wrap = document.getElementById('honestReviewsScroll');
  if (!wrap) return;

  hasHonestReviews = !!(reviews && reviews.length);
  updateAllOnlySections(); // apply combined tab + data-availability visibility
  if (!hasHonestReviews) return;

  wrap.innerHTML = reviews.map(r => {
    const url = safeUrl(r.videoUrl);
    return `
      <div class="hr-card" onclick="openHonestReview('${esc(url)}')">
        <div class="hr-thumb">
          <img src="${esc(safeUrl(r.thumbUrl))}" alt="${esc(r.title || 'Customer review video')}" loading="lazy" />
          <div class="hr-thumb-overlay"></div>
          <div class="hr-play">${HR_PLAY_ICON}</div>
        </div>
        <div class="hr-card-title">${esc(r.title)}</div>
        ${r.meta ? `<div class="hr-card-meta">${esc(r.meta)}</div>` : ''}
      </div>`;
  }).join('');
}

async function loadHonestReviews() {
  const wrap = document.getElementById('honestReviewsScroll');
  try {
    const res = await fetch('/api/honest-reviews');
    if (!res.ok) throw new Error('Request failed: ' + res.status);
    const data = await res.json();
    renderHonestReviews(data.reviews || []);
  } catch (err) {
    console.error('loadHonestReviews error:', err);
    if (wrap) wrap.innerHTML = '<div class="hr-empty">Couldn\'t load reviews right now.</div>';
  }
}

/* ── Post Your Video Review (any logged-in user) ── */
function openSubmitVideoModal() {
  if (!getLoggedInUser()) { showToast('Please log in to submit your video', 'warning'); openAuthModal(); return; }
  if (blockIfNotVerified()) return;
  document.getElementById('submitVideoModal').classList.add('open');
  lockBodyScroll();
}
function closeSubmitVideoModal() {
  document.getElementById('submitVideoModal').classList.remove('open');
  unlockBodyScroll();
}
async function submitVideoReview(evt) {
  evt.preventDefault();
  const videoUrl = document.getElementById('svf-videoUrl').value.trim();
  const title = document.getElementById('svf-title').value.trim();
  const caption = document.getElementById('svf-caption').value.trim();
  const btn = document.getElementById('svfSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    const res = await fetch('/api/honest-reviews/submit', {
      method: 'POST',
      headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ videoUrl, title, caption })
    });
    const data = await res.json();
    if (!res.ok) { if (handleNotVerifiedError(data)) return; throw new Error(data.error || 'Could not submit your video'); }
    showToast(data.message || 'Thanks! Your video has been submitted for review and will go live once approved.');
    document.getElementById('submitVideoForm').reset();
    closeSubmitVideoModal();
    loadHonestReviews();
  } catch (err) {
    console.error('submitVideoReview error:', err);
    showToast(err.message || 'Could not submit your video', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit for review';
  }
}
document.getElementById('submitVideoModal').addEventListener('click', function(e) {
  if (e.target === this) closeSubmitVideoModal();
});

const SERVICE_PRICING = {
  'KR Webcrafts': {
    items: [
      { label: 'Static Website',     value: '₹8,000',   note: 'onwards' },
	  { label: 'Dynamic Website',     value: '₹25,000',   note: 'onwards' },
      { label: 'Mobile App',        value: '₹35,000',  note: 'onwards' },
      { label: 'Maintenance',       value: '₹2000',     note: '/ month' },
    ],
    note: '🕐 Delivery in ASAP.'
  },
  'Rental Agreement': {
    items: [
      { label: 'Basic Draft',       value: '₹499',     note: 'one-time' },
      { label: 'E-Stamp + Print',   value: '₹999',     note: 'one-time' },
      { label: 'Notarised Copy',    value: '₹1,499',   note: 'one-time' },
      { label: 'Express (24 hrs)',  value: '₹1,999',   note: 'one-time' },
    ],
    note: '📋 Karnataka stamp duty as per govt rates, charged separately.'
  },
  'Building Painter': {
    items: [
      { label: 'Labour (1 BHK)',    value: '₹2,500',   note: 'onwards' },
      { label: 'Labour (2 BHK)',    value: '₹5,000',   note: 'onwards' },
      { label: 'Labour (3 BHK)',    value: '₹7,500',  note: 'onwards' },
      { label: 'Paint Material',    value: 'Actual',   note: 'cost extra' },
    ],
    note: '🎨 Platform charges are included with labour charges.'
  },
  'Plumbing': {
    items: [
      { label: 'Minor Repair',      value: '₹300–600', note: '' },
      { label: 'New Fixture Fit',   value: '₹500–1,200', note: '' }
    ],
    note: '🔧 Platform charges separate'
  },
  'Transportation': {
    items: [
      { label: '1 BHK Move',        value: '₹2,000',  note: 'onwards' },
      { label: '2 BHK Move',        value: '₹4,000',  note: 'onwards' },
      { label: '3 BHK Move',        value: '₹6,000',  note: 'onwards' },
      { label: 'Mini Truck(With driver)',   value: '₹1,000',  note: 'per hour' },
    ],
    note: '🚚 Prices may vary on Distances. Packing material extra.'
  },
  'Electrician': {
    items: [
      { label: 'Visit Charge',      value: '₹150',     note: 'adjusted in bill' },
      { label: 'Minor Work',        value: '₹200–500', note: '' },
      { label: 'Fan / Light Fit',   value: '₹150',     note: 'per point' },
      { label: 'Wiring (hr)',       value: '₹350',     note: '/ hour' },
    ],
    note: '⚡ Material charged at actual. Same-day service available in most areas.'
  },
  'Water Can Services': {
    items: [
      { label: '20L Water Can',     value: '₹35–60',   note: 'per can' },
    ],
    note: '💧 Price varies by brand, area & building floor. Refundable can deposit may apply.'
  },
};

// These two skip the pricing breakdown entirely — just a quick "call us
// directly" prompt, since pricing varies too much case-by-case to quote.
const SIMPLE_CONTACT_SERVICES = ['Rental Agreement', 'Building Painter'];

function openServiceModal(name, category, icon, imgUrl) {
  document.getElementById('svc-service').value = name;
  document.getElementById('svcModalIcon').textContent = icon;
  document.getElementById('svcModalLabel').textContent = name;

  // Inject pricing block
  const pricing = SIMPLE_CONTACT_SERVICES.includes(name) ? null : SERVICE_PRICING[name];
  let pricingHTML = '';
  if (SIMPLE_CONTACT_SERVICES.includes(name)) {
    pricingHTML = `
      <div class="svc-pricing-section">
        <div class="svc-price-note" style="margin-top:0">📞 Call or WhatsApp us directly for ${name} — we'll sort out the details with you.</div>
      </div>`;
  } else if (pricing) {
    const itemsHTML = pricing.items.map(i => `
      <div class="svc-price-item">
        <div class="svc-price-label">${i.label}</div>
        <div class="svc-price-value">${i.value} <span>${i.note}</span></div>
      </div>`).join('');
    pricingHTML = `
      <div class="svc-pricing-section">
        <div class="svc-pricing-title">💰 Estimated Costs</div>
        <div class="svc-pricing-grid">${itemsHTML}</div>
        <div class="svc-price-note">${pricing.note}</div>
      </div>`;
  }
  document.getElementById('svc-pricing-block').innerHTML = pricingHTML;

  document.getElementById('serviceModal').classList.add('open');
  lockBodyScroll();
}
function closeServiceModal() {
  document.getElementById('serviceModal').classList.remove('open');
  unlockBodyScroll();
}

document.getElementById('serviceModal').addEventListener('click', function(e) {
  if (e.target === this) closeServiceModal();
});

// Rent Receipt Generator — loaded lazily into the iframe on first open so it
// doesn't fetch/run until the person actually wants it, then left in place
// (not reset) so re-opening keeps whatever they'd already filled in.
function openRentReceiptTool() {
  const frame = document.getElementById('rentReceiptFrame');
  if (!frame.src) frame.src = '/rent-receipt.html';
  document.getElementById('rentReceiptModal').classList.add('open');
  lockBodyScroll();
}
function closeRentReceiptTool() {
  document.getElementById('rentReceiptModal').classList.remove('open');
  unlockBodyScroll();
}

// The Rent Receipt tool runs in an <iframe>, and the browser's Contact
// Picker API (navigator.contacts.select) only works from a top-level
// browsing context — calling it inside the iframe throws "Failed to
// execute 'select' on 'ContactsManager'". So when the iframe's tenant
// "pick from contacts" button is tapped, it posts a message here, this
// (top-level) page runs the actual picker, and the result is posted back.
window.addEventListener('message', async function(e) {
  const data = e.data;
  if (!data || data.type !== 'kr-rr-pick-contact') return;
  const frame = document.getElementById('rentReceiptFrame');
  if (!frame || !frame.contentWindow) return;

  if (!('contacts' in navigator && 'ContactsManager' in window)) {
    frame.contentWindow.postMessage({
      type: 'kr-rr-contact-pick-error',
      message: "Contact picker isn't supported on this device/browser — please type the number in."
    }, '*');
    return;
  }

  try {
    const contacts = await navigator.contacts.select(['name', 'tel'], { multiple: false });
    if (!contacts || !contacts.length) return;
    const picked = contacts[0];
    frame.contentWindow.postMessage({
      type: 'kr-rr-contact-picked',
      name: (picked.name && picked.name[0]) || '',
      tel: (picked.tel && picked.tel[0]) || ''
    }, '*');
  } catch (err) {
    if (err && err.name !== 'AbortError') {
      frame.contentWindow.postMessage({
        type: 'kr-rr-contact-pick-error',
        message: 'Could not read that contact — please type the number in.'
      }, '*');
    }
  }
});
document.getElementById('rentReceiptModal').addEventListener('click', function(e) {
  if (e.target === this) closeRentReceiptTool();
});

function closeHelpModal() {
  document.getElementById('helpModal').classList.remove('open');
  unlockBodyScroll();
}
function toggleFaq(el) {
  const item = el.parentElement;
  const wasOpen = item.classList.contains('open');
  document.querySelectorAll('#faqList .faq-item').forEach(f => f.classList.remove('open'));
  if (!wasOpen) item.classList.add('open');
}

/* ═══════════════════════════════════════════════
   ABOUT HOMELOOP MODAL
═══════════════════════════════════════════════ */
let partnersLoaded = false;
function openAboutModal() {
  document.getElementById('aboutModal').classList.add('open');
  lockBodyScroll();
  if (!partnersLoaded) loadPartners();
}
function closeAboutModal() {
  document.getElementById('aboutModal').classList.remove('open');
  unlockBodyScroll();
}

function partnerInitials(name) {
  return (name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
}

function renderPartners(partners) {
  const wrap = document.getElementById('aboutPartnersScroll');
  if (!wrap) return;
  if (!partners || !partners.length) {
    wrap.innerHTML = '<div class="about-partners-loading">No partners added yet.</div>';
    return;
  }
  wrap.innerHTML = partners.map(p => `
    <div class="about-partner-card">
      ${p.photoUrl
        ? `<img class="about-partner-avatar about-partner-avatar-photo" src="${esc(p.photoUrl)}" alt="${esc(p.name)}" style="cursor:pointer" onclick="openLightboxSimple(['${esc(p.photoUrl)}'],0)">`
        : `<div class="about-partner-avatar">${esc(p.avatarText || partnerInitials(p.name))}</div>`}
      <div class="about-partner-info">
        <div class="about-partner-name">${esc(p.name)}</div>
        <div class="about-partner-meta">
          <span class="about-partner-role">${esc(p.role)}</span>
          ${p.location ? `<span class="about-partner-dot">·</span><span class="about-partner-location">${esc(p.location)}</span>` : ''}
        </div>
      </div>
    </div>`).join('');
}

async function loadPartners() {
  partnersLoaded = true;
  try {
    const res = await fetch('/api/partners');
    if (!res.ok) throw new Error('Request failed: ' + res.status);
    const data = await res.json();
    renderPartners(data.partners || []);
  } catch (err) {
    console.error('loadPartners error:', err);
    partnersLoaded = false;
    const wrap = document.getElementById('aboutPartnersScroll');
    if (wrap) wrap.innerHTML = '<div class="about-partners-loading">Couldn\'t load partners right now.</div>';
  }
}

/* ═══════════════════════════════════════════════
   AMENITIES MULTI-SELECT DROPDOWN
═══════════════════════════════════════════════ */
const AM_LIST = [
  ['am-ac',       'AC',                     'f-acUnits'],
  ['am-balcony',  'Balcony',      'f-balconyUnits'],
  ['am-bed',      'Bed',         'f-bedUnits'],
  ['am-security', 'CCTV',        'f-securityUnits'],
  ['am-chimney',  'Chimney',                'f-chimneyUnits'],
  ['am-wardrobe', 'Cupboards',   'f-wardrobeUnits'],
  ['am-lift',     'Elevator',        'f-liftUnits'],
  ['am-garden',   'Garden',                 'f-gardenUnits'],
  ['am-geyser',   'Geyser',  'f-geyserUnits'],
  ['am-gym',      'Gym',             'f-gymUnits'],
  ['am-laundry',  'Laundry',                'f-laundryUnits'],
  ['am-meals',    'Meals included',         'f-mealsUnits'],
  ['am-microwave','Microwave',       'f-microwaveUnits'],
  ['am-pipedgas', 'Piped gas connection',   'f-pipedgasUnits'],
  ['am-power',    'Power backup',           'f-powerUnits'],
  ['am-fridge',   'Refrigerator',           'f-fridgeUnits'],
  ['am-ro',       'RO water filter',        'f-roUnits'],
  ['am-sofa',     'Sofa',         'f-sofaUnits'],
  ['am-washing',  'Washing machine',        'f-washingUnits'],
  ['am-wifi',     'Wi-Fi',                  'f-wifiUnits'],
];

function toggleAmDropdown(e) {
  e.stopPropagation();
  document.getElementById('amDropdown').classList.toggle('open');
}

function amSelectAll() {
  AM_LIST.forEach(([id]) => { const cb = document.getElementById(id); if (cb) cb.checked = true; });
  renderAmSelected();
}

function amClearAll() {
  AM_LIST.forEach(([id, , unitId]) => {
    const cb = document.getElementById(id); if (cb) cb.checked = false;
    if (unitId) { const u = document.getElementById(unitId); if (u) u.value = ''; }
  });
  renderAmSelected();
}

function onAmCheck() {
  renderAmSelected();
}

function amRemove(id) {
  const cb = document.getElementById(id);
  if (cb) cb.checked = false;
  const entry = AM_LIST.find(([eid]) => eid === id);
  if (entry && entry[2]) { const u = document.getElementById(entry[2]); if (u) u.value = ''; }
  renderAmSelected();
}

function renderAmSelected() {
  const box = document.getElementById('amSelectedBox');
  const empty = document.getElementById('amSelectedEmpty');
  const ddLabel = document.getElementById('amDdLabel');
  const ddCount = document.getElementById('amDdCount');

  const selected = AM_LIST.filter(([id]) => document.getElementById(id).checked);

  box.querySelectorAll('.am-tag').forEach(t => t.remove());
  if (!selected.length) {
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
    selected.forEach(([id, label, unitId]) => {
      let text = label;
      if (unitId) {
        const u = document.getElementById(unitId);
        const qty = u ? u.value.trim() : '';
        text += ' ×' + (qty && parseInt(qty) > 0 ? qty : '1');
      }
      const tag = document.createElement('span');
      tag.className = 'am-tag';
      tag.innerHTML = '<span>' + text + '</span><button type="button" class="am-tag-remove" aria-label="Remove">✕</button>';
      tag.querySelector('.am-tag-remove').onclick = function() { amRemove(id); };
      box.appendChild(tag);
    });
  }

  ddLabel.textContent = selected.length ? selected.length + ' selected' : 'Choose amenities…';
  ddCount.style.display = selected.length ? '' : 'none';
  ddCount.textContent = selected.length;
}

AM_LIST.forEach(([, , unitId]) => {
  if (!unitId) return;
  const el = document.getElementById(unitId);
  if (!el) return;
  el.addEventListener('click', e => e.stopPropagation());
  el.addEventListener('input', renderAmSelected);
});

/* ─── Tenant preference multi-select dropdown ───────────
   Mirrors the amenities dropdown pattern above, but with no per-item
   quantity inputs. Selections are stored as a comma-joined string in
   the hidden #f-tenant input, which the rest of the form (submit +
   edit-prefill + filters) already reads/writes as plain text. */
const TENANT_LIST = [
  ['tenant-any',      'Any'],
  ['tenant-family',   'Family'],
  ['tenant-bachelor', 'Bachelor'],
  ['tenant-female',   'Female only'],
];

function toggleTenantDropdown(e) {
  e.stopPropagation();
  document.getElementById('tenantDropdown').classList.toggle('open');
}

function onTenantCheck() {
  renderTenantSelected();
}

function renderTenantSelected() {
  const label = document.getElementById('tenantDdLabel');
  const count = document.getElementById('tenantDdCount');
  const hidden = document.getElementById('f-tenant');
  const selected = TENANT_LIST.filter(([id]) => document.getElementById(id).checked).map(([, name]) => name);

  hidden.value = selected.join(', ');
  label.textContent = selected.length ? selected.join(', ') : 'Choose tenant preference…';
  count.style.display = selected.length ? '' : 'none';
  count.textContent = selected.length;
}

/* Checks the boxes matching a comma-joined value (used on edit-prefill). */
function syncTenantCheckboxesFromValue(val) {
  const parts = String(val || '').split(',').map(s => s.trim()).filter(Boolean);
  TENANT_LIST.forEach(([id, name]) => {
    const cb = document.getElementById(id);
    if (cb) cb.checked = parts.includes(name);
  });
  renderTenantSelected();
}

/* ─── Sell-only "Overlooking" multi-select dropdown ───────────
   Same pattern as the tenant-preference dropdown above: no per-item
   quantity inputs, selections stored as a comma-joined string in the
   hidden #f-sellOverlooking input. */
const OVERLOOKING_LIST = [
  ['ov-mainroad',   'Main Road'],
  ['ov-gardenpark', 'Garden / Park'],
  ['ov-pool',       'Pool'],
  ['ov-club',       'Club'],
];

function toggleOverlookingDropdown(e) {
  e.stopPropagation();
  document.getElementById('overlookingDropdown').classList.toggle('open');
}

function onOverlookingCheck() {
  renderOverlookingSelected();
}

function renderOverlookingSelected() {
  const label = document.getElementById('overlookingDdLabel');
  const count = document.getElementById('overlookingDdCount');
  const hidden = document.getElementById('f-sellOverlooking');
  const selected = OVERLOOKING_LIST.filter(([id]) => document.getElementById(id).checked).map(([, name]) => name);

  hidden.value = selected.join(', ');
  label.textContent = selected.length ? selected.join(', ') : 'Choose what it overlooks…';
  count.style.display = selected.length ? '' : 'none';
  count.textContent = selected.length;
}

/* Checks the boxes matching a comma-joined value (used on edit-prefill). */
function syncOverlookingCheckboxesFromValue(val) {
  const parts = String(val || '').split(',').map(s => s.trim()).filter(Boolean);
  OVERLOOKING_LIST.forEach(([id, name]) => {
    const cb = document.getElementById(id);
    if (cb) cb.checked = parts.includes(name);
  });
  renderOverlookingSelected();
}

/* ═══════════════════════════════════════════════
   REVIEWS
   Site-wide feedback from logged-in users, stored on
   the backend (not localStorage) so everyone sees the
   same review list. Requires /api/reviews GET + POST
   routes on the server (see server.js snippet).
═══════════════════════════════════════════════ */
let reviewRatingSelected = 0;
let reviewsPage = 1;
const REVIEWS_PAGE_SIZE = 10;
let reviewsTotalCount = 0;

// Small pencil icon shown next to the title whenever it's clickable, so it
// visibly reads as a button rather than plain text a user might not think
// to tap.
const REVIEWS_TITLE_ICON = '<svg class="reviews-title-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

async function initReviewForm() {
  const user = getLoggedInUser();
  const title = document.getElementById('reviewsTitle');
  if (!title) return;

  function setTitleAction(fn) {
    if (fn) {
      title.classList.add('reviews-title-clickable');
      title.onclick = fn;
      title.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
      title.setAttribute('role', 'button');
      title.setAttribute('tabindex', '0');
    } else {
      title.classList.remove('reviews-title-clickable');
      title.onclick = null;
      title.onkeydown = null;
      title.removeAttribute('role');
      title.removeAttribute('tabindex');
    }
  }

  if (!user) {
    title.innerHTML = REVIEWS_TITLE_ICON + 'Login to write a <span>Review</span>';
    setTitleAction(() => openAuthModal());
    return;
  }

  title.innerHTML = REVIEWS_TITLE_ICON + 'Add a <span>Review</span>';
  // Default to clickable while we check; if they've already reviewed,
  // drop back to a plain (non-clickable) heading below.
  setTitleAction(() => openReviewModal());

  try {
    const res = await fetch('/api/reviews/mine', { headers: userAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data.hasReviewed) {
        title.innerHTML = 'Add a <span>Review</span>';
        setTitleAction(null);
      }
    }
  } catch (err) {
    // If the check fails, leave it clickable — worst case they hit the
    // 409 on submit, which is still handled gracefully.
  }
}

function openReviewModal() {
  const user = getLoggedInUser();
  if (!user) { openAuthModal(); return; }
  if (blockIfNotVerified()) return;
  document.getElementById('reviewModal').classList.add('open');
}
function closeReviewModal() {
  document.getElementById('reviewModal').classList.remove('open');
}

function setReviewRating(val) {
  reviewRatingSelected = val;
  document.querySelectorAll('#reviewStarsInput .review-star-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.val) <= val);
  });
}

function renderStarString(rating) {
  const r = Math.round(rating || 0);
  return '★★★★★☆☆☆☆☆'.slice(5 - r, 10 - r);
}

function reviewTimeAgo(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return days + ' days ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
  const years = Math.floor(months / 12);
  return years + (years === 1 ? ' year ago' : ' years ago');
}

async function submitReview() {
  const user = getLoggedInUser();
  if (!user) { openAuthModal(); return; }
  if (!reviewRatingSelected) { showToast('Please select a star rating', 'warning'); return; }
  const text = document.getElementById('reviewText').value.trim();
  if (!text) { showToast('Please write a short review', 'warning'); return; }

  const btn = document.getElementById('reviewSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Posting…';
  try {
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ rating: reviewRatingSelected, text })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (handleNotVerifiedError(data)) return;
      if (res.status === 409) {
        showToast(data.error || 'You have already posted a review', 'error');
        closeReviewModal();
        initReviewForm();
        return;
      }
      throw new Error(data.error || ('Server returned ' + res.status));
    }
    document.getElementById('reviewText').value = '';
    document.getElementById('reviewCharCount').textContent = '0 / 500';
    setReviewRating(0);
    showToast('Thanks for your review!');
    closeReviewModal();
    initReviewForm();
    reviewsPage = 1;
    loadReviews();
  } catch (err) {
    console.error('Could not submit review:', err.message);
    showToast('Could not post your review. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post review';
  }
}

function avatarColorFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue},70%,60%), hsl(${(hue+30)%360},70%,48%))`;
}

function reviewRole(rv) {
  // Reviewer role — the backend's Review docs carry `accountType`
  // ('customer' or 'owner'), mirroring the User model. Older reviews saved
  // before this field existed will have neither, so they fall into 'other'.
  const rawRole = rv.accountType || rv.userType || rv.role || '';
  const r = String(rawRole).toLowerCase();
  if (r === 'owner') return 'owner';
  if (r === 'customer') return 'tenant';
  return 'other';
}

function reviewCardHTML(rv) {
  const name = esc(rv.userName || 'HomeLoop user');
  const initial = (name[0] || 'U').toUpperCase();
  const photoUrl = rv.userPhoto || rv.profilePhoto || rv.avatar || '';
  const avatarInner = photoUrl
    ? `<img src="${safeUrl(photoUrl)}" alt="${name}"/>`
    : initial;
  const avatarStyle = photoUrl ? '' : ` style="background:${avatarColorFromName(name)}"`;

  return `<div class="review-card">
    <div class="review-card-head">
      <div class="review-avatar"${avatarStyle}>${avatarInner}</div>
      <div class="review-card-meta">
        <div class="review-card-name-row">
          <div class="review-card-name">${name}</div>
        </div>
        <div class="review-card-date">${reviewTimeAgo(rv.createdAt)}</div>
      </div>
      <div class="review-card-stars-wrap">
        <div class="review-card-stars" aria-label="${rv.rating} out of 5 stars">${renderStarString(rv.rating)}</div>
        <div class="review-card-rating-num">${rv.rating}/5</div>
      </div>
    </div>
    <div class="review-card-text">${esc(rv.text)}</div>
  </div>`;
}

const REVIEW_GROUP_LABELS = { owner: 'Owner', tenant: 'Tenant', other: 'Other' };

function reviewGroupsHTML(reviews) {
  const buckets = { owner: [], tenant: [], other: [] };
  reviews.forEach(rv => buckets[reviewRole(rv)].push(rv));
  return ['owner', 'tenant', 'other']
    .filter(key => buckets[key].length)
    .map(key => `<div class="reviews-group" data-group="${key}">
      <div class="reviews-group-label">${REVIEW_GROUP_LABELS[key]} <span>Reviews</span></div>
      <div class="reviews-group-cards" id="reviewsGroupCards-${key}">
        ${buckets[key].map(reviewCardHTML).join('')}
        <div class="reviews-carousel-dots" id="reviewsDots-${key}"></div>
      </div>
    </div>`).join('');
}

// Appends new cards into their matching group (creating the group if it
// didn't exist on the page yet — e.g. the first tenant review only shows
// up on page 2 of "Show more").
function appendReviewsToGroups(list, reviews) {
  const buckets = { owner: [], tenant: [], other: [] };
  reviews.forEach(rv => buckets[reviewRole(rv)].push(rv));
  ['owner', 'tenant', 'other'].forEach(key => {
    if (!buckets[key].length) return;
    let cardsEl = document.getElementById(`reviewsGroupCards-${key}`);
    if (!cardsEl) {
      list.insertAdjacentHTML('beforeend', `<div class="reviews-group" data-group="${key}">
        <div class="reviews-group-label">${REVIEW_GROUP_LABELS[key]} <span>Reviews</span></div>
        <div class="reviews-group-cards" id="reviewsGroupCards-${key}">
          <div class="reviews-carousel-dots" id="reviewsDots-${key}"></div>
        </div>
      </div>`);
      cardsEl = document.getElementById(`reviewsGroupCards-${key}`);
    }
    // New cards go before the dots, which must stay last.
    cardsEl.querySelector('.reviews-carousel-dots')
      .insertAdjacentHTML('beforebegin', buckets[key].map(reviewCardHTML).join(''));
  });
}

function renderRatingBars(ratingCounts) {
  const total = [1, 2, 3, 4, 5].reduce((sum, s) => sum + (ratingCounts[s] || 0), 0);
  [1, 2, 3, 4, 5].forEach(star => {
    const count = ratingCounts[star] || 0;
    const pct = total ? Math.round((count / total) * 100) : 0;
    const fill = document.querySelector(`.reviews-bar-fill[data-star="${star}"]`);
    const label = document.querySelector(`[data-star-count="${star}"]`);
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = count;
  });
}

async function loadReviews() {
  const list = document.getElementById('reviewsList');
  const loadMoreBtn = document.getElementById('reviewsLoadMoreBtn');
  if (!list) return;
  if (reviewsPage === 1) list.innerHTML = '<div class="reviews-loading">Loading reviews…</div>';
  try {
    const res = await fetch(`/api/reviews?page=${reviewsPage}&limit=${REVIEWS_PAGE_SIZE}`);
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const data = await res.json();
    const reviews = data.reviews || [];
    reviewsTotalCount = data.total || reviews.length;

    if (reviewsPage === 1) {
      if (reviews.length === 0) {
        list.innerHTML = '<div class="reviews-empty">No reviews yet — be the first to share your experience!</div>';
        document.getElementById('reviewsAvgScore').textContent = '—';
        document.getElementById('reviewsAvgStars').textContent = '';
        document.getElementById('reviewsCount').textContent = 'No reviews yet';
        renderRatingBars({});
        loadMoreBtn.style.display = 'none';
        return;
      }
      list.innerHTML = reviewGroupsHTML(reviews);
      const avg = data.avgRating || 0;
      document.getElementById('reviewsAvgScore').textContent = avg.toFixed(1);
      document.getElementById('reviewsAvgStars').textContent = renderStarString(avg);
      document.getElementById('reviewsCount').textContent = reviewsTotalCount + (reviewsTotalCount === 1 ? ' review' : ' reviews');
      renderRatingBars(data.ratingCounts || {});
      initReviewCarousel();
    } else {
      appendReviewsToGroups(list, reviews);
      initReviewCarousel();
    }

    const shown = reviewsPage * REVIEWS_PAGE_SIZE;
    loadMoreBtn.style.display = shown < reviewsTotalCount ? '' : 'none';
  } catch (err) {
    console.error('Could not load reviews:', err.message);
    if (reviewsPage === 1) list.innerHTML = '<div class="reviews-empty">Could not load reviews right now.</div>';
  }
}

function loadMoreReviews() {
  reviewsPage += 1;
  loadReviews();
}

document.getElementById('reviewText')?.addEventListener('input', function() {
  document.getElementById('reviewCharCount').textContent = this.value.length + ' / 500';
});

initReviewForm();
loadReviews();

/* ═══════════════════════════════════════════════
   LOAD PROPERTIES FROM DB
   Reusable so it can be re-run after a user edits/deletes
   one of their own listings from the My Listings tab.

   renderAfter=false is used only by the initial page-load path below,
   which fetches this AND fetchBookedProperties() together and renders
   both in one pass afterward — so Booked doesn't visibly pop in after
   everything else just because its request happened to resolve later.
   Every other caller leaves renderAfter at its default (true) and gets
   the old fetch-then-render-immediately behavior.
═══════════════════════════════════════════════ */
async function fetchProperties(renderAfter = true) {
  const rentGrid = document.getElementById('rentGrid');
  const leaseGrid = document.getElementById('leaseGrid');
  const pgGrid = document.getElementById('pgGrid');
  const promotedGrid = document.getElementById('promotedGrid');
  // No inline "Finding your perfect home…" placeholder here anymore — the
  // very first renderCards() call (which runs synchronously before this
  // fetch even starts) already puts up the emptyState's own "Loading
  // listings…" message, so setting a second, different-looking loading
  // string in the grid itself just produced two conflicting messages
  // stacked on top of each other on a fresh page load.
  if (leaseGrid) leaseGrid.innerHTML = '';
  if (pgGrid) pgGrid.innerHTML = '';
  if (promotedGrid) promotedGrid.innerHTML = '';
  try {
    const res = await fetch('/api/properties');
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const data = await res.json();
    if (data.properties && data.properties.length > 0) {
      PROPERTIES = data.properties;
      // One-time migration: backfill shortlistedData for ids saved before
      // the full-object storage existed, so old shortlists keep working.
      let migrated = false;
      shortlisted.forEach(id => {
        if (!shortlistedData[id]) {
          const p = PROPERTIES.find(x => String(x.id) === String(id));
          if (p) { shortlistedData[id] = p; migrated = true; }
        }
      });
      if (migrated) { saveShortlistData(); renderShortlistPanel(); }
    }
  } catch (err) {
    console.error('Could not load properties from server:', err.message);
    const rentGrid2 = document.getElementById('rentGrid');
    if (rentGrid2) rentGrid2.innerHTML = '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-2)">⚠️ Could not connect to server. Please refresh the page.</div>';
    // Hide the emptyState's "Loading listings…" message now that we know
    // the fetch actually failed — otherwise it'd sit stacked underneath
    // the connection-error message above, the same double-message look
    // this was fixed to avoid.
    const emptyEl = document.getElementById('emptyState');
    if (emptyEl) emptyEl.classList.remove('show');
    // Still run the one-shot restore (and let saveFilterState resume saving)
    // even on failure — otherwise a failed fetch permanently blocks filter
    // persistence for the rest of this page load.
    if (!_initialFilterRestoreDone) {
      restoreFilterStateBeforeBuild();
      _initialFilterRestoreDone = true;
    }
    _initialPropertiesFetchDone = true;
    if (renderAfter) renderRecentlyViewed(); // now unblocked — falls back to snapshot cards for this session
    return false;
  }
  if (!_initialFilterRestoreDone) {
    restoreFilterStateBeforeBuild(); // re-apply tab/search/filters saved before this refresh
    _initialFilterRestoreDone = true;
  }
  _initialPropertiesFetchDone = true;
  if (renderAfter) {
    buildFilterOptions();
    renderCards();
    renderRecentlyViewed();
  }
  return true;
}

// Fetches booked listings (verified + booked, the mirror image of the main
// /api/properties filter) for the read-only "Booked" sections under
// Promoted/Rent/Lease/PG. Kept as its own small, best-effort call — separate
// from fetchProperties() — since it's supplementary and shouldn't block or
// complicate the main listing load if it's slow or fails.
//
// renderAfter=false is used only by the initial page-load path below, which
// waits for this AND fetchProperties() together before rendering either —
// see the note on fetchProperties() for why.
async function fetchBookedProperties(renderAfter = true) {
  // Hard timeout so a slow/hanging Booked API can't hold up the initial
  // Promise.all render (see loadPropertiesFromDB above) — Booked is a
  // supplementary, read-only section, and it's better to show the page
  // with an empty Booked bucket than to block real listings on it.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('/api/properties?booked=true', { signal: controller.signal });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const data = await res.json();
    BOOKED_PROPERTIES = data.properties || [];
  } catch (err) {
    console.error('Could not load booked properties:', err.name === 'AbortError' ? 'Timed out after 4s' : err.message);
    BOOKED_PROPERTIES = [];
  } finally {
    clearTimeout(timeoutId);
  }
  if (!renderAfter) return;
  renderBookedSections();
  // A Recently Viewed entry may point at a property that's since been
  // booked — renderRecentlyViewed() now filters those out (booked listings
  // don't belong in Recently Viewed), but that only takes effect once this
  // data has actually arrived, so re-render to drop it immediately instead
  // of waiting for a tab switch.
  renderRecentlyViewed();
}

/* ── Ad Banner ── */
document.addEventListener('DOMContentLoaded', function() {
  // Fire-and-forget: records this page load as a visit. The server dedups
  // by a long-lived cookie (plus an IP/device fallback for incognito), so
  // reloads, extra tabs, and repeat visits from this browser don't inflate
  // the count — see POST /api/stats/visit on the backend.
  fetch('/api/stats/visit', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceSig: buildDeviceSignature() }),
  }).catch(() => { /* stats are best-effort, never block the page on this */ });

  syncFdBar();
  updateAllOnlySections(); // hide UrbanAware / Reviews / Premium on initial load (default tab is Rent)

  // restoreFilterStateBeforeBuild() only reads localStorage — it doesn't
  // need the /api/properties response, it was just nested inside
  // fetchProperties()'s callback for convenience. Running it here, before
  // either fetch fires, means currentTab (and the saved tab/search/filter
  // state) is already correct no matter which of fetchProperties() /
  // fetchBookedProperties() resolves first below.
  if (!_initialFilterRestoreDone) {
    restoreFilterStateBeforeBuild();
    _initialFilterRestoreDone = true;
  }

  // ── Load properties from DB ──
  // Both requests fire together, and — unlike a plain Promise.all — neither
  // one renders until BOTH have come back. Firing them concurrently alone
  // isn't enough: they're still two independent round trips, so whichever
  // response lands first would render first regardless, and Booked would
  // keep visibly popping in after the rest. Fetching with renderAfter=false
  // and doing the render step for both only once everything has arrived is
  // what actually makes them appear together.
  (async function loadPropertiesFromDB() {
    const [ok] = await Promise.all([
      fetchProperties(false),
      fetchBookedProperties(false)
    ]);
    // Only render the main grids on success — on failure, fetchProperties()
    // has already put its own connection-error message in the grid, and
    // rendering over it with an empty-PROPERTIES buildFilterOptions/
    // renderCards would just stomp that message (this matches what the
    // old failure path did: skip these two calls entirely).
    if (ok) {
      buildFilterOptions();
      renderCards();
    }
    renderBookedSections();
    renderRecentlyViewed();
    if (!ok) return;
    initNearbyLocation(); // ask for location once listings are in, so "Near me first" has data to sort

    // ── Deep-link: auto-open property from URL ──
    // Supports both the current `/property/:id` path (server-rendered, used
    // by openWhatsApp() for a rich share preview) and the older `?property=`
    // query string (kept so previously-shared links still open correctly).
    const _dlPathMatch = window.location.pathname.match(/^\/property\/([a-fA-F0-9]{24})$/);
    const _dlParam = _dlPathMatch ? _dlPathMatch[1] : new URLSearchParams(window.location.search).get('property');
    if (_dlParam) {
      const _dlProp = PROPERTIES.find(x => String(x.id) === _dlParam);
      if (_dlProp) openDetail(_dlProp.id);
    }

    // ── Deep-link: auto-open a shared comparison from URL param ──
    const _cmpParam = new URLSearchParams(window.location.search).get('compare');
    if (_cmpParam) {
      const _cmpIds = _cmpParam.split(',').map(s => s.trim()).filter(Boolean);
      const _validIds = _cmpIds.filter(id => PROPERTIES.some(p => String(p.id) === id)).slice(0, COMPARE_MAX);
      if (_validIds.length >= 2) {
        compareSet = new Set(_validIds);
        renderCompareBar();
        renderCards();
        openCompareModal();
      }
    }
  })();

  const banner = document.getElementById('adBanner');
  const track = document.getElementById('adTrack');
  const allDots = document.querySelectorAll('#adDots .ad-dot');
  if (!track || !allDots.length) return;
  let cur = 0, timer;
  // Reads live DOM state each call, so a slide/dot hidden for tenants
  // (see updateListPropertyVisibility) is simply skipped — no separate
  // "total" to keep in sync.
  function visibleSlides() { return Array.from(track.children).filter(el => el.style.display !== 'none'); }
  function visibleDots() { return Array.from(allDots).filter(el => el.style.display !== 'none'); }
  function goTo(n) {
    const slides = visibleSlides(), dots = visibleDots();
    const total = slides.length;
    if (!total) return;
    cur = (n + total) % total;
    track.style.transform = 'translateX(-' + (cur * 100) + '%)';
    dots.forEach((d, i) => d.classList.toggle('active', i === cur));
  }
  function start() {
    timer = setInterval(() => {
      // Skip advancing while the banner itself is hidden (e.g. on the
      // Explore tab) or the browser tab is backgrounded — nothing to
      // animate for, no point waking up every 10s for it.
      if (banner.style.display === 'none' || document.hidden) return;
      goTo(cur + 1);
    }, 10000);
  }
  function stop()  { clearInterval(timer); }
  document.getElementById('adBanner').addEventListener('mouseenter', stop);
  document.getElementById('adBanner').addEventListener('mouseleave', start);
  document.addEventListener('visibilitychange', () => { document.hidden ? stop() : start(); });
  allDots.forEach(d => d.addEventListener('click', e => { e.stopPropagation(); stop(); goTo(visibleDots().indexOf(d)); start(); }));
  window.refreshAdBannerCarousel = () => goTo(0);
  updateAdBannerAudience(); // set initial owner/tenant/guest slide set before first render
  goTo(0);
  start();

  // ── Swipe / drag support ──────────────────────────────────────────
  // Pointer Events unify mouse (desktop) and touch (mobile) so the same
  // code drags the track live under the finger/cursor and either snaps
  // to the next/previous slide or springs back on release, instead of
  // only reacting to the dot clicks and auto-rotate above.
  let dragging = false, dragStartX = 0, dragDeltaX = 0, dragMoved = false;
  function bannerWidth() { return banner.clientWidth || 1; }
  function onDragStart(e) {
    if (visibleSlides().length < 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true; dragMoved = false; dragStartX = e.clientX; dragDeltaX = 0;
    stop();
    track.style.transition = 'none';
    banner.style.cursor = 'grabbing';
    if (e.pointerId != null && track.setPointerCapture) {
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }
  function onDragMove(e) {
    if (!dragging) return;
    dragDeltaX = e.clientX - dragStartX;
    if (Math.abs(dragDeltaX) > 4) dragMoved = true;
    const percent = (dragDeltaX / bannerWidth()) * 100;
    track.style.transform = 'translateX(calc(-' + (cur * 100) + '% + ' + percent + '%))';
  }
  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    track.style.transition = '';
    banner.style.cursor = 'pointer';
    const threshold = bannerWidth() * 0.15;
    if (dragDeltaX <= -threshold) goTo(cur + 1);
    else if (dragDeltaX >= threshold) goTo(cur - 1);
    else goTo(cur);
    start();
    // A real drag shouldn't also fire the slide's tel: link click — swallow
    // just the click that immediately follows a drag past the move threshold.
    if (dragMoved) {
      const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); };
      banner.addEventListener('click', swallow, { capture: true, once: true });
    }
  }
  banner.style.touchAction = 'pan-y';
  banner.addEventListener('pointerdown', onDragStart);
  banner.addEventListener('pointermove', onDragMove);
  banner.addEventListener('pointerup', onDragEnd);
  banner.addEventListener('pointercancel', onDragEnd);
  banner.addEventListener('pointerleave', e => { if (dragging && e.buttons === 0) onDragEnd(); });
});

/* ─── Auto-slide the property-card icon/chip rows (stats + furnished/
   maintenance/available chips) every 20s when they overflow their card
   width. Rather than jumping (a jarring snap) or fading/blurring, we
   smoothly animate scrollLeft over ~2.5s so the row visibly, gently
   glides across to reveal the rest of the row, then glides back on the
   next tick. Users can still drag/scroll them manually at any time, and
   a manual drag cancels any in-progress auto-slide. Runs globally so it
   picks up newly rendered cards each tick. */
let _propRowPhase = false;
function _easeInOutSine(t){ return -(Math.cos(Math.PI * t) - 1) / 2; }
function _slowSlide(row, target, duration){
  if (row._slideRAF) cancelAnimationFrame(row._slideRAF);
  const start = row.scrollLeft;
  const dist = target - start;
  if (Math.abs(dist) < 2) return;
  const prevBehavior = row.style.scrollBehavior;
  row.style.scrollBehavior = 'auto'; // let our RAF loop control motion, not CSS smooth-scroll
  const t0 = performance.now();
  function step(now){
    if (row.classList.contains('is-dragging')) { row._slideRAF = null; row.style.scrollBehavior = prevBehavior; return; } // manual drag wins
    const p = Math.min(1, (now - t0) / duration);
    row.scrollLeft = start + dist * _easeInOutSine(p);
    if (p < 1) row._slideRAF = requestAnimationFrame(step);
    else { row._slideRAF = null; row.style.scrollBehavior = prevBehavior; }
  }
  row._slideRAF = requestAnimationFrame(step);
}
function _autoSlidePropRows(){
  _propRowPhase = !_propRowPhase;
  document.querySelectorAll('.prop-chip-row-scroll, .price-chips-scroll').forEach(row => {
    if (row.scrollWidth <= row.clientWidth + 4) return;
    if (row.classList.contains('is-dragging')) return; // don't fight a manual drag
    const target = _propRowPhase ? row.scrollWidth - row.clientWidth : 0;
    _slowSlide(row, target, 32000);
  });
}
/* ─── Manual drag-to-scroll for the stat/chip rows on desktop ───────────
   These rows already scroll via touch/trackpad; this adds mouse-drag
   support so desktop users (no touchpad) can slide them by click+drag.
   A small movement threshold distinguishes a drag from a normal click,
   and we swallow the click that would otherwise bubble up to the card's
   onclick="openDetail(...)" only when an actual drag happened. */
(function(){
  let drag = null;
  let justDragged = false;
  document.addEventListener('touchstart', function(e){
    const row = e.target.closest('.prop-chip-row-scroll, .price-chips-scroll');
    if (row && row._slideRAF) { cancelAnimationFrame(row._slideRAF); row._slideRAF = null; }
  }, {passive:true});
  document.addEventListener('mousedown', function(e){
    const row = e.target.closest('.prop-chip-row-scroll, .price-chips-scroll');
    if (!row || row.scrollWidth <= row.clientWidth + 4) return;
    if (row._slideRAF) { cancelAnimationFrame(row._slideRAF); row._slideRAF = null; }
    drag = { row, startX: e.pageX, startScroll: row.scrollLeft, moved: false };
    row.classList.add('is-dragging');
  });
  document.addEventListener('mousemove', function(e){
    if (!drag) return;
    const dx = e.pageX - drag.startX;
    if (Math.abs(dx) > 4) drag.moved = true;
    drag.row.scrollLeft = drag.startScroll - dx;
  });
  document.addEventListener('mouseup', function(){
    if (!drag) return;
    justDragged = drag.moved;
    drag.row.classList.remove('is-dragging');
    drag = null;
  });
  window.addEventListener('blur', function(){
    if (drag) drag.row.classList.remove('is-dragging');
    drag = null;
  });
  document.addEventListener('click', function(e){
    if (justDragged) { e.stopPropagation(); e.preventDefault(); justDragged = false; }
  }, true);
})();
setInterval(_autoSlidePropRows, 32000);

/* ─── Reviews carousel ──────────────────────────────────────────────
   Owner and Tenant reviews are shown as two separate groups, each its
   own single-card carousel (so a reader can tell at a glance which
   side of a listing left the review, instead of them being interleaved).
   No auto-advance — a group only changes card on tap or swipe, via the
   prev/next arrows, or by clicking a dot. Re-run initReviewCarousel()
   any time #reviewsList's contents change (initial load, "Show more",
   a fresh submission) so it always reflects what's actually in the DOM. */
const _reviewCarousels = {}; // key -> { index }

function _reviewCarouselGroupEl(key) {
  return document.getElementById(`reviewsGroupCards-${key}`);
}

function _setReviewCarouselIndex(key, index) {
  const group = _reviewCarouselGroupEl(key);
  if (!group) return;
  const cards = group.querySelectorAll('.review-card');
  if (!cards.length) return;
  const clamped = ((index % cards.length) + cards.length) % cards.length;
  cards.forEach((c, i) => c.classList.toggle('active', i === clamped));
  const dots = document.getElementById(`reviewsDots-${key}`);
  if (dots) {
    dots.querySelectorAll('.reviews-carousel-dot').forEach((d, i) => d.classList.toggle('active', i === clamped));
  }
  if (_reviewCarousels[key]) _reviewCarousels[key].index = clamped;
}

// Called by the prev/next arrow buttons.
function reviewCarouselStep(key, dir) {
  const current = _reviewCarousels[key]?.index ?? 0;
  _setReviewCarouselIndex(key, current + dir);
}

// Called by clicking a dot — jumps straight to that review.
function reviewCarouselGoTo(key, index) {
  _setReviewCarouselIndex(key, index);
}

function initReviewCarousel(){
  const list = document.getElementById('reviewsList');
  if (!list) return;

  list.querySelectorAll('.reviews-group-cards').forEach(group => {
    const key = group.id.replace('reviewsGroupCards-', '');
    const cards = Array.from(group.querySelectorAll('.review-card'));
    if (!cards.length) return;

    _reviewCarousels[key] = { index: 0 };
    cards.forEach((c, i) => c.classList.toggle('active', i === 0));

    const multi = cards.length > 1;
    group.classList.toggle('is-swipeable', multi);

    const dots = document.getElementById(`reviewsDots-${key}`);
    if (dots) {
      dots.innerHTML = multi
        ? cards.map((_, i) => `<button class="reviews-carousel-dot${i === 0 ? ' active' : ''}" aria-label="Go to review ${i + 1}" onclick="reviewCarouselGoTo('${key}', ${i})"></button>`).join('')
        : '';
    }
  });

  _wireReviewCarouselGestures();
}

/* Tap-or-swipe navigation, in place of prev/next arrow buttons: tapping
   a review card advances to the next one, swiping left/right in either
   direction steps forward/back. Uses pointer events so it works the same
   for touch and mouse. Wiring only happens once per group container
   (tracked via dataset.gestureWired) since the same container element is
   reused across "Show more" appends and re-runs of initReviewCarousel(). */
function _wireReviewCarouselGestures() {
  document.querySelectorAll('.reviews-group-cards').forEach(group => {
    if (group.dataset.gestureWired) return;
    group.dataset.gestureWired = '1';
    const key = group.id.replace('reviewsGroupCards-', '');
    let startX = 0, startY = 0, tracking = false;

    group.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.reviews-carousel-dot')) return;
      startX = e.clientX; startY = e.clientY; tracking = true;
    });
    group.addEventListener('pointerup', (e) => {
      if (!tracking || e.target.closest('.reviews-carousel-dot')) { tracking = false; return; }
      tracking = false;
      const cardCount = group.querySelectorAll('.review-card').length;
      if (cardCount <= 1) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        reviewCarouselStep(key, dx < 0 ? 1 : -1); // swipe left = next, swipe right = prev
      } else {
        reviewCarouselStep(key, 1); // plain tap = next
      }
    });
  });
}

document.addEventListener('click', function(e) {
  const dd = document.getElementById('amDropdown');
  if (dd.classList.contains('open') && !dd.contains(e.target)) {
    dd.classList.remove('open');
  }
  const tdd = document.getElementById('tenantDropdown');
  if (tdd && tdd.classList.contains('open') && !tdd.contains(e.target)) {
    tdd.classList.remove('open');
  }
  const odd = document.getElementById('overlookingDropdown');
  if (odd && odd.classList.contains('open') && !odd.contains(e.target)) {
    odd.classList.remove('open');
  }
});

/* ═══════════════════════════════════════════════
   PROPERTY IMAGES (URL paste / file upload / camera)
═══════════════════════════════════════════════ */
let fImages = [];
let fImgDrag = null; // { from, current, el, startX, startY, moved }
function renderFImages() {
  const grid = document.getElementById('fImgGrid');
  const hint = document.getElementById('fImgHint');
  const orderHint = document.getElementById('fImgOrderHint');
  grid.innerHTML = fImages.map((src, i) =>
    '<div class="img-thumb" data-idx="' + i + '" onpointerdown="fImgPointerDown(event,' + i + ')">' +
      '<img src="' + src + '" alt="img" draggable="false"/>' +
      (i === 0 ? '<span class="img-thumb-cover">Cover</span>' : '') +
      '<button type="button" class="img-thumb-del" onclick="event.stopPropagation();removeFImage(' + i + ')">✕</button>' +
    '</div>'
  ).join('');
  hint.style.display = fImages.length ? 'none' : 'block';
  if (orderHint) orderHint.style.display = fImages.length > 1 ? 'block' : 'none';
}
function removeFImage(i) {
  fImages.splice(i, 1);
  renderFImages();
}
// Drag-to-reorder for the property-images thumbnail grid. Uses Pointer
// Events (not the HTML5 Drag-and-Drop API) so the same code works with
// mouse, touch, and pen — plain HTML5 DnD doesn't fire on touch in iOS
// Safari. The first thumbnail after reordering becomes the "Cover" image,
// which is what shows on property cards, compare, and shortlist.
function fImgPointerDown(e, i) {
  if (e.target.closest('.img-thumb-del')) return;
  e.preventDefault();
  const grid = document.getElementById('fImgGrid');
  const el = grid.querySelector('.img-thumb[data-idx="' + i + '"]');
  if (!el) return;
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  fImgDrag = { from: i, current: i, el, startX: e.clientX, startY: e.clientY, moved: false };
  el.classList.add('dragging');
  const onMove = (ev) => fImgPointerMove(ev);
  const onUp = (ev) => { fImgPointerUp(ev); document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
function fImgPointerMove(e) {
  if (!fImgDrag) return;
  const dx = e.clientX - fImgDrag.startX, dy = e.clientY - fImgDrag.startY;
  if (!fImgDrag.moved && Math.hypot(dx, dy) < 4) return;
  fImgDrag.moved = true;
  fImgDrag.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  // The dragged thumbnail now sits visually right under the cursor (that's
  // the point of the transform above), so elementFromPoint would just find
  // itself. Make it transparent to hit-testing for this one lookup so we
  // find the thumbnail actually underneath the cursor instead.
  fImgDrag.el.style.pointerEvents = 'none';
  const target = document.elementFromPoint(e.clientX, e.clientY);
  fImgDrag.el.style.pointerEvents = '';
  const overThumb = target && target.closest('.img-thumb');
  document.querySelectorAll('#fImgGrid .img-thumb').forEach(t => t.classList.remove('drag-over'));
  if (overThumb && overThumb !== fImgDrag.el) {
    overThumb.classList.add('drag-over');
    fImgDrag.current = parseInt(overThumb.dataset.idx, 10);
  } else {
    fImgDrag.current = fImgDrag.from;
  }
}
function fImgPointerUp() {
  if (!fImgDrag) return;
  const { from, current, el, moved } = fImgDrag;
  fImgDrag = null;
  if (moved && current !== from) {
    const item = fImages.splice(from, 1)[0];
    fImages.splice(current, 0, item);
  } else {
    el.style.transform = '';
  }
  renderFImages();
}
async function addImagesFromFiles(input) {
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length) return;

  const hint = document.getElementById('fImgHint');
  if (hint) hint.textContent = 'Uploading…';

  const form = new FormData();
  // Stamp every photo with a centered "homeloop.in" watermark (matching how
  // other listing sites like NoBroker brand their photos) before it ever
  // leaves the device — the server only ever sees the watermarked version.
  const watermarked = await Promise.all(files.map(f => watermarkImageFile(f).catch(() => f)));
  watermarked.forEach(file => form.append('images', file));

  try {
    const res = await fetch('/api/upload-images', { method: 'POST', body: form, headers: userAuthHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Upload failed');
    (data.urls || []).forEach(u => { if (fImages.indexOf(u) < 0) fImages.push(u); });
  } catch (err) {
    showToast(err.message || 'Could not upload images. Please try again.', 'error');
  } finally {
    renderFImages();
  }
}

// Draws the source image onto a canvas with a semi-transparent watermark
// centered over it — the circular ".logo-mark-wrap" badge (golden ring +
// white-bordered logo) next to the "homeloop.in" wordmark, matching the
// header logo rather than just the flat logo artwork — then returns a new
// File with the same name/type so it's a drop-in replacement in the upload
// FormData.
// Falls back to the original file (via the .catch() at the call site) if
// anything about loading/encoding fails, so a bad photo never blocks the
// whole upload.
// Cache the already-loaded header logo so repeat uploads in the same
// session don't have to decode the (fairly large) base64 PNG again.
let _watermarkLogoPromise = null;
function getWatermarkLogo() {
  if (!_watermarkLogoPromise) {
    _watermarkLogoPromise = new Promise((resolve, reject) => {
      const headerLogo = document.querySelector('.logo-mark');
      if (!headerLogo || !headerLogo.src) { reject(new Error('logo not found')); return; }
      const logoImg = new Image();
      logoImg.onload = () => resolve(logoImg);
      logoImg.onerror = () => reject(new Error('logo failed to load'));
      logoImg.src = headerLogo.src; // exact same data: URI used in the header
    });
  }
  return _watermarkLogoPromise;
}

async function watermarkImageFile(file) {
  const logo = await getWatermarkLogo();
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        // Small logo icon + brand name side by side, centered on the photo
        // as one group — like a NoBroker-style mark rather than the logo
        // alone taking up a big chunk of the middle of the photo.
        const iconSize = Math.min(w, h) * 0.09;
        const fontSize = iconSize * 0.62;
        const gap = iconSize * 0.06;
        const label = 'homeloop.in';

        ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
        const textWidth = ctx.measureText(label).width;
        const groupWidth = iconSize + gap + textWidth;
        const groupX = (w - groupWidth) / 2;
        const cy = h / 2;

        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.shadowColor = 'rgba(0,0,0,.35)';
        ctx.shadowBlur = iconSize * 0.12;

        // Circular badge matching the header's .logo-mark-wrap: a golden
        // conic-gradient ring behind a white-bordered, circularly-clipped
        // logo image — not just the raw square logo artwork.
        const iconCX = groupX + iconSize / 2;
        const iconCY = cy;
        const iconR = iconSize / 2;
        ctx.beginPath();
        ctx.arc(iconCX, iconCY, iconR, 0, Math.PI * 2);
        if (ctx.createConicGradient) {
          const ringGrad = ctx.createConicGradient(220 * Math.PI / 180, iconCX, iconCY);
          ringGrad.addColorStop(0, '#d4af6a');
          ringGrad.addColorStop(0.33, '#a97a2f');
          ringGrad.addColorStop(0.66, '#7a5a22');
          ringGrad.addColorStop(1, '#d4af6a');
          ctx.fillStyle = ringGrad;
        } else {
          ctx.fillStyle = '#a97a2f'; // flat fallback if conic gradients aren't supported
        }
        ctx.fill();

        // White inset "padding" ring (mirrors the wrap's padding + the
        // .logo-mark's own white border), then the logo clipped to a circle
        // and cover-fit inside it.
        const innerR = iconR * 0.86;
        ctx.beginPath();
        ctx.arc(iconCX, iconCY, innerR, 0, Math.PI * 2);
        ctx.fillStyle = '#fdfcf9';
        ctx.fill();

        ctx.save();
        ctx.beginPath();
        ctx.arc(iconCX, iconCY, innerR * 0.92, 0, Math.PI * 2);
        ctx.clip();
        const side = innerR * 0.92 * 2;
        ctx.drawImage(logo, iconCX - side / 2, iconCY - side / 2, side, side);
        ctx.restore();

        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, groupX + iconSize + gap, cy + fontSize * 0.03);
        ctx.restore();

        canvas.toBlob(blob => {
          URL.revokeObjectURL(url);
          if (!blob) { reject(new Error('toBlob failed')); return; }
          resolve(new File([blob], file.name, { type: blob.type || file.type || 'image/jpeg' }));
        }, 'image/jpeg', 0.92);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}
function onFTypeChange(val) {
  const isPG = val === 'PG';
  const isLease = val === 'Lease';
  const isShortStay = val === 'ShortStay';
  const isSell = val === 'Sell';
  document.getElementById('addPgSection').style.display = isPG ? '' : 'none';
  document.getElementById('addShortStaySection').style.display = isShortStay ? '' : 'none';
  document.getElementById('addSellSection').style.display = isSell ? '' : 'none';
  // addRentSection doubles as the Rent-only "Terms & Rules" block (notice
  // period, contract term, pets, non-veg) — none of that applies to a sale.
  document.getElementById('addRentSection').style.display = (!isPG && !isLease && !isShortStay && !isSell) ? '' : 'none';
  document.getElementById('addLeaseSection').style.display = isLease ? '' : 'none';
  document.getElementById('addPropDetailsSection').style.display = (isPG || isShortStay) ? 'none' : '';
  document.getElementById('addAmenitiesSection').style.display = '';
  document.getElementById('addPricingSection').style.display = isLease ? 'none' : '';
  // Maintenance still applies to a resale flat (society maintenance) — only
  // hidden for PG/Short Stay. Rent escalation, electricity-included and
  // water/borewell charges are rental-only concepts, so those three are
  // hidden for Sell too on top of PG/Short Stay.
  document.getElementById('f-maintenanceWrap').style.display = (isPG || isShortStay) ? 'none' : '';
  ['f-escalationWrap', 'f-electricityWrap', 'f-waterWrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (isPG || isShortStay || isSell) ? 'none' : '';
  });
  // No security deposit on a sale (nothing being held/returned) — same
  // reasoning as PG/Short Stay, hidden for a different reason.
  document.getElementById('f-depositWrap').style.display = (isPG || isShortStay || isSell) ? 'none' : '';
  // "Price negotiable" still very much applies to a sale — only hidden for
  // PG/Short Stay, same as before.
  document.getElementById('f-negotiableWrap').style.display = (isPG || isShortStay) ? 'none' : '';
  // Lease has its own "Available from" dropdown in addLeaseSection — hide the
  // Property-Details date field for Lease so there isn't a second, unused one.
  document.getElementById('f-availWrap').style.display = (isLease || isShortStay) ? 'none' : '';
  // Tenant preference is a rental-only concept — doesn't apply when selling.
  const tenantGroup = document.getElementById('tenantFormGroup');
  if (tenantGroup) tenantGroup.style.display = isSell ? 'none' : '';
  const lbl = document.getElementById('f-rentLabel');
  if (lbl) lbl.innerHTML = (val === 'For Rent' || val === 'Rent') ? 'Monthly rent (₹) <span style="color:var(--brand)">*</span>'
    : isLease ? 'Token rent (₹) <span style="color:var(--brand)">*</span>'
    : isShortStay ? 'Per day rate (₹) <span style="color:var(--brand)">*</span>'
    : isSell ? 'Expected price (₹) <span style="color:var(--brand)">*</span>'
    : 'Monthly charge (₹) <span style="color:var(--brand)">*</span>';
  // Area-type clarifier and the auto price-per-sqft nudge only make sense
  // once there's a sale price and an area to divide it by.
  document.getElementById('f-areaTypeWrap').style.display = isSell ? '' : 'none';
  document.getElementById('f-pricePerSqftWrap').style.display = isSell ? '' : 'none';
  updateSellPricePerSqft();
  // Re-apply the Plot/Land field toggling now that Sell's own sections are
  // showing/hiding — matters when restoring a draft that already had
  // "Plot / Land" picked, or when switching type away from and back to Sell.
  onSellPropertyTypeChange();
}

// Read-only nudge, not a stored/required field — recomputed on every price
// or area keystroke while the Sell tab is active. Silently clears/no-ops for
// any other listing type or if either input is empty/non-numeric.
function updateSellPricePerSqft() {
  const out = document.getElementById('f-pricePerSqft');
  if (!out) return;
  const isSell = document.getElementById('f-type').value === 'Sell';
  if (!isSell) { out.value = ''; return; }
  const price = parseFloat(document.getElementById('f-rent').value);
  const areaRaw = (document.getElementById('f-area').value || '').replace(/[^\d.]/g, '');
  const area = parseFloat(areaRaw);
  if (!price || !area) { out.value = ''; return; }
  out.value = '₹' + Math.round(price / area).toLocaleString('en-IN') + ' / sqft';
}

// A plot/vacant-land Sell listing doesn't have a BHK, floor count, bathrooms,
// furnishing, toilet type, age, or parking — none of that exists until
// something is built on it. Total floors/balconies (in addSellSection) don't
// apply either. Only property type, area (plot size), facing, ownership,
// possession and RERA still make sense — same fields NoBroker/Housing/
// 99acres ask for a "Plot/Land for Sale" listing. Only applies to Sell —
// Rent/Lease/PG rarely list plots, so their field set is left untouched.
function onSellPropertyTypeChange() {
  const isSell = document.getElementById('f-type').value === 'Sell';
  const isLand = isSell && document.getElementById('f-propertyType').value === 'Plot / Land';
  ['f-bhkWrap', 'f-floorWrap', 'f-bathsWrap', 'f-toiletTypeWrap', 'f-furnishingWrap', 'f-ageWrap',
   'f-bikeparkWrap', 'f-carparkWrap', 'f-sellTotalFloorsWrap', 'f-sellBalconiesWrap',
   // Nothing's built yet on vacant land — no flooring, no Carpet/Super-Built-up
   // distinction, and nothing for a municipal body to issue an occupancy/
   // completion certificate against. Boundary wall, road width, open sides,
   // corner, and overlooking all still apply to a plot, so those stay.
   'f-sellFlooringWrap', 'f-areaTypeWrap', 'f-sellOcAvailableWrap', 'f-sellCcAvailableWrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isLand ? 'none' : '';
  });
  const areaLbl = document.getElementById('f-areaLabel');
  if (areaLbl) areaLbl.textContent = isLand ? 'Plot area (sqft)' : 'Area (sqft)';
}

function stripAreaSqft(el) {
  el.value = el.value.replace(/\s*Sqft\s*$/i, '').trim();
}
function formatAreaSqft(el) {
  const num = el.value.replace(/[^\d.]/g, '').trim();
  el.value = num ? num + 'Sqft' : '';
}
function formatFloorOrdinal(el) {
  const raw = el.value.trim();
  // Only auto-convert when the person typed a plain number (e.g. "3");
  // leave anything already containing text (e.g. "3rd / 10 floors") alone.
  if (!/^\d+$/.test(raw)) return;
  const n = parseInt(raw, 10);
  const mod100 = n % 100;
  const mod10 = n % 10;
  let suffix = 'th';
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = 'st';
    else if (mod10 === 2) suffix = 'nd';
    else if (mod10 === 3) suffix = 'rd';
  }
  el.value = n + suffix;
}
function onMaintenanceChange() {
  // Electricity and water charges are independent of maintenance — the
  // user picks these themselves regardless of what's entered here.
}
// Pulls a 6-digit Indian pincode out of a free-text address string, e.g.
// "...Koramangala, Bengaluru, Karnataka 560034, India" -> "560034".
function extractPincodeFromAddress(text) {
  const m = String(text || '').match(/\b\d{6}\b/);
  return m ? m[0] : '';
}

// True once the person has typed into the Pincode box themselves — after
// that we stop overwriting it from the address text, so a manual correction
// (or a pincode the address text doesn't contain) always sticks.
let pincodeManuallyEdited = false;

function onFullAddressInput(value) {
  if (!pincodeManuallyEdited) {
    const guess = extractPincodeFromAddress(value);
    if (guess) document.getElementById('f-pincode').value = guess;
  }
  // Keep Owner address mirrored while "Same as building live address" is
  // checked, same as the auto-capture path in fCaptureLocation.
  const sameChk = document.getElementById('f-sameAsBuildingAddress');
  if (sameChk && sameChk.checked) {
    const ownerAddr = document.getElementById('f-ownerAddress');
    if (ownerAddr) ownerAddr.value = value;
  }
  // Re-resolve lat/lng (and the Google Maps link) from the address text
  // itself whenever the person hand-edits it — debounced so we're not
  // firing a geocode call on every keystroke.
  clearTimeout(addressGeocodeTimer);
  addressGeocodeTimer = setTimeout(() => geocodeAddressText(value), 900);
}

// Matches only a link this form generated itself from raw coordinates
// (see fCaptureLocation / geocodeAddressText below) — used to avoid
// clobbering a link the owner has deliberately pasted/customized
// (e.g. pointing at the exact building entrance instead of a plain pin).
const AUTO_MAPS_LINK_RE = /^https:\/\/www\.google\.com\/maps\?q=-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

// Fires the moment the person leaves the address field (tab/click away) —
// skips the debounce wait so the edit lands immediately instead of after
// the 900ms pause, while typing itself still stays debounced.
function onFullAddressBlur(value) {
  clearTimeout(addressGeocodeTimer);
  geocodeAddressText(value);
}

let addressGeocodeTimer = null;
function geocodeAddressText(value) {
  const trimmed = String(value || '').trim();
  const status = document.getElementById('f-locStatus');
  if (trimmed.length < 8) return; // too short/likely mid-typing to bother geocoding
  if (status) status.textContent = 'Updating coordinates from address...';
  fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(trimmed) + '&format=json&limit=1&accept-language=en')
    .then(r => r.json())
    .then(results => {
      if (!results || !results.length) {
        if (status) status.textContent = 'Could not match address to a location.';
        return;
      }
      const lat = parseFloat(results[0].lat), lon = parseFloat(results[0].lon);
      document.getElementById('f-latitude').value = lat;
      document.getElementById('f-longitude').value = lon;
      document.getElementById('f-latLngDisplay').value = lat.toFixed(6) + '° N, ' + lon.toFixed(6) + '° E';
      const mapsLinkEl = document.getElementById('f-googleMapsLink');
      if (mapsLinkEl && (!mapsLinkEl.value || AUTO_MAPS_LINK_RE.test(mapsLinkEl.value))) {
        mapsLinkEl.value = 'https://www.google.com/maps?q=' + lat + ',' + lon;
      }
      if (status) status.textContent = 'Coordinates updated from edited address.';
    })
    .catch(() => { if (status) status.textContent = 'Coordinate lookup failed.'; });
}

function onPincodeInput(el) {
  el.value = el.value.replace(/\D/g, '').slice(0, 6);
  pincodeManuallyEdited = true;
}

function fCaptureLocation() {
  const btnTxt = document.getElementById('f-locBtnTxt');
  const status = document.getElementById('f-locStatus');
  if (!navigator.geolocation) { status.textContent = 'Not supported on this device/browser'; return; }
  btnTxt.textContent = '...'; status.textContent = 'Getting location...';
  navigator.geolocation.getCurrentPosition(function(pos) {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    document.getElementById('f-latitude').value = lat;
    document.getElementById('f-longitude').value = lon;
    document.getElementById('f-latLngDisplay').value = lat.toFixed(6) + '° N, ' + lon.toFixed(6) + '° E';
    btnTxt.textContent = 'OK';
    // Auto-fill Google Maps link from the same coordinates as the Building
    // Live Address — a plain pin link that opens straight to this spot.
    // Left editable (field is optional) so it can be swapped for a more
    // specific link (e.g. the exact building entrance) if the owner has one.
    document.getElementById('f-googleMapsLink').value = 'https://www.google.com/maps?q=' + lat + ',' + lon;
    fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lon + '&format=json&accept-language=en')
      .then(r => r.json())
      .then(d => {
        document.getElementById('f-fullAddress').value = d.display_name || '';
        // Structured postcode from the same lookup — used to prioritize
        // this listing for visitors detected in the same pincode later,
        // far more reliable than matching free-text area names. Falls back
        // to pulling a 6-digit code out of the address text itself if the
        // geocoder didn't return a structured postcode.
        pincodeManuallyEdited = false; // fresh capture — a prior manual edit no longer applies
        document.getElementById('f-pincode').value = (d.address && d.address.postcode) || extractPincodeFromAddress(d.display_name);
        status.textContent = 'Address captured · Enter Location / Area manually';
        // Keep Owner address in sync if "Same as building live address" is checked
        const sameChk = document.getElementById('f-sameAsBuildingAddress');
        if (sameChk && sameChk.checked) {
          const ownerAddr = document.getElementById('f-ownerAddress');
          if (ownerAddr) ownerAddr.value = d.display_name || '';
        }
      }).catch(() => { status.textContent = 'Coordinates saved.'; });
  }, function() { btnTxt.textContent = 'Live'; status.textContent = 'Permission denied.'; });
}

// ═══════════════════════════════════════════════
// REQUIRED-FIELD VALIDATION (listing form)
// Every field in the Add/Post Property form is mandatory except a small set
// of true meta/utility inputs (hidden coords, file pickers, the bulk-import
// helper, and per-amenity quantity boxes that only matter if their checkbox
// is checked). Missing fields get a red border + an inline message right
// under that field.
// ═══════════════════════════════════════════════
const OPTIONAL_FIELD_IDS = new Set([
  'f-latitude', 'f-longitude', 'f-latLngDisplay',
  'f-imgFileInput', 'f-imgCameraInput',
  'f-amenities-extra',
  'f-ownerAltPhone', 'f-videoUrl', 'f-age', 'f-area',
  'f-maintenance', 'f-leaseMaintenance',
  'f-sellPossessionDate', 'f-sellReraId', 'f-pricePerSqft',
  // Sell-only trust/detail fields kept optional — same reasoning as
  // reraId above: many legit resale listings won't have a tidy answer
  // (pre-2000 buildings with no OC/CC on file, independent houses with
  // no "project" name, sellers who don't know the previous-owner count).
  // Khata type, loan status, and area type are left OUT of this set on
  // purpose — those are mandatory whenever the Sell tab is showing.
  'f-sellTaxPaid', 'f-sellOcAvailable', 'f-sellCcAvailable',
  'f-sellPreviousOwners', 'f-sellProjectName', 'f-sellFlooring',
  'f-sellWaterSource', 'f-sellBoundaryWall', 'f-sellRoadWidth',
  'f-sellOpenSides', 'f-sellCornerProperty',
]);
function isUnitField(id) { return /Units$/.test(id); }

function getAllListingFields() {
  return Array.from(document.querySelectorAll(
    '#addModal input[id^="f-"], #addModal select[id^="f-"], #addModal textarea[id^="f-"]'
  )).filter(el =>
    el.type !== 'hidden' && el.type !== 'file' && !el.readOnly &&
    !OPTIONAL_FIELD_IDS.has(el.id) && !isUnitField(el.id)
  );
}
function isFieldVisible(el) {
  return !!el && !!el.offsetParent && window.getComputedStyle(el).display !== 'none';
}
function markRequiredLabels() {
  getAllListingFields().forEach(el => {
    const group = el.closest('.form-group');
    const label = group ? group.querySelector('.form-label') : null;
    if (!label) return;
    // Every field is now mandatory — strip any leftover "(optional)" wording.
    label.innerHTML = label.innerHTML
      .replace(/\s*\(₹,\s*optional\)/i, ' (₹)')
      .replace(/\s*\(optional\)/i, '');
    const hasStar = Array.from(label.querySelectorAll('span')).some(s => s.textContent.trim() === '*');
    if (!hasStar) {
      label.insertAdjacentHTML('beforeend', ' <span style="color:var(--brand)">*</span>');
    }
  });
}
function setGroupError(group, message) {
  if (!group) return;
  group.classList.add('has-error');
  let msg = group.querySelector('.field-error-text');
  if (!msg) {
    msg = document.createElement('div');
    msg.className = 'field-error-text';
    group.appendChild(msg);
  }
  msg.textContent = message;
}
function clearAllFieldErrors() {
  document.querySelectorAll('#addModal .form-group.has-error').forEach(g => {
    g.classList.remove('has-error');
    const msg = g.querySelector('.field-error-text');
    if (msg) msg.remove();
  });
}
function fieldLabelText(el) {
  const group = el.closest('.form-group');
  const label = group ? group.querySelector('.form-label') : null;
  if (!label) return 'This field';
  // Strip the trailing red "*" and any stray whitespace, keep just the label text.
  return label.textContent.replace(/\*\s*$/, '').trim();
}
function validateListingForm() {
  clearAllFieldErrors();
  let firstErrorEl = null;
  getAllListingFields().forEach(el => {
    if (!isFieldVisible(el)) return; // field belongs to a hidden section (e.g. PG fields while Rent is selected)
    const val = (el.value || '').trim();
    const missing = el.tagName === 'SELECT' ? (val === '' || val === 'Select') : (val === '');
    if (missing) {
      setGroupError(el.closest('.form-group'), fieldLabelText(el) + ' is required');
      if (!firstErrorEl) firstErrorEl = el;
    }
  });
  // Property images — at least one is required
  const imgGroup = document.getElementById('imgFormGroup');
  if (imgGroup && isFieldVisible(imgGroup) && (!Array.isArray(fImages) || fImages.length === 0)) {
    setGroupError(imgGroup, 'Please add at least one property image');
    if (!firstErrorEl) firstErrorEl = imgGroup;
  }
  // Tenant preference — at least one option must be selected
  const tenantGroup = document.getElementById('tenantFormGroup');
  if (tenantGroup && isFieldVisible(tenantGroup) && !document.getElementById('f-tenant').value.trim()) {
    setGroupError(tenantGroup, 'Tenant preference is required');
    if (!firstErrorEl) firstErrorEl = tenantGroup;
  }
  return firstErrorEl;
}

function submitListing() {
  const firstError = validateListingForm();
  if (firstError) {
    showToast('Please fill in all required fields', 'warning');
    firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (typeof firstError.focus === 'function') firstError.focus();
    return;
  }
  const title = document.getElementById('f-title').value.trim();
  const rent = document.getElementById('f-rent').value;
  const loc = document.getElementById('f-location').value.trim();
  const ownerName = document.getElementById('f-ownerName').value.trim();
  const ownerPhone = document.getElementById('f-ownerPhone').value.trim();
/*  if (!title || !rent || !loc || !ownerName || !ownerPhone) {
    showToast('Please fill in title, rent, location and owner details', 'warning');
    return;
  }
*/

  function gv(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function gb(id) { const el = document.getElementById(id); return el ? el.checked : false; }

  if (ownerPhone && !isValidIndianMobile(ownerPhone)) {
    showToast('Enter a valid 10-digit owner phone number starting with 6, 7, 8 or 9', 'warning');
    return;
  }
  const ownerAltPhone = gv('f-ownerAltPhone');
  if (ownerAltPhone && !isValidIndianMobile(ownerAltPhone)) {
    showToast('Enter a valid 10-digit alternate number starting with 6, 7, 8 or 9', 'warning');
    return;
  }
  const agentPhone = gv('f-agentPhone');
  if (agentPhone && !isValidIndianMobile(agentPhone)) {
    showToast('Enter a valid 10-digit agent phone number starting with 6, 7, 8 or 9', 'warning');
    return;
  }

  const amenitiesSelected = AM_LIST.filter(([id]) => gb(id)).map(([id, label, unitId]) => {
    if (unitId) {
      const qty = parseInt(gv(unitId)) || 1;
      return qty > 1 ? label + ' ×' + qty : label;
    }
    return label;
  });
  const amenitiesExtra = gv('f-amenities-extra');

  const images = fImages.slice();

  const typeRaw = document.getElementById('f-type').value;
  // Map frontend type values → schema basic.status enum values
  // Schema enum: "For Sale" | "For Rent" | "New Launch" | "Sold" | "Booked" | "Lease" | "PG" | "Short Stay"
  const statusMap = { 'Rent': 'For Rent', 'For Rent': 'For Rent', 'Lease': 'Lease', 'PG': 'PG', 'ShortStay': 'Short Stay', 'Sell': 'For Sale' };
  const status = statusMap[typeRaw] || 'For Rent';
  const isPG = status === 'PG';
  const isLease = status === 'Lease';
  const isShortStay = status === 'Short Stay';
  const isSell = status === 'For Sale';
  // A Plot/Land Sell listing skips BHK/floor/bathrooms/furnishing/toilet
  // type/age/parking/total-floors/balconies entirely — see
  // onSellPropertyTypeChange(), which hides those fields on-screen for the
  // same reason.
  const isLand = isSell && gv('f-propertyType') === 'Plot / Land';

  // ── Build the nested submission payload ──────────────────────
  // {basic, location, owner, price, property, amenities, terms, rules, media, pg}
  const newProp = {
    basic: {
      status:   status,
      listedBy: document.getElementById('f-listedBy').value,
    },
    location: {
      area:    loc,
      city:    document.getElementById('f-city').value.trim() || 'Bangalore',
      address: document.getElementById('f-fullAddress').value.trim(),
      pincode: document.getElementById('f-pincode').value.trim() || null,
      lat:     parseFloat(document.getElementById('f-latitude').value) || null,
      lng:     parseFloat(document.getElementById('f-longitude').value) || null,
      mapLink: gv('f-googleMapsLink') || null,
    },
    owner: {
      propertyName: title,
      name:         ownerName,
      phone:        ownerPhone,
      email:        document.getElementById('f-ownerEmail').value.trim(),
      altPhone:     gv('f-ownerAltPhone') || null,
      contactTime:  gv('f-contactTime') || null,
      address:      gv('f-ownerAddress') || null,
      agentPhone:   gv('f-agentPhone') || null,
      agentArea:    gv('f-agentArea') || null,
    },
    price: isLease ? {
      rent:         parseFloat(gv('f-leaseAmount')) || 0,
      maintenance:  parseFloat(gv('f-leaseMaintenance')) || null,
      // Deposit/rentIncrease/electricity/water/negotiable live in #addPricingSection,
      // which is hidden for Lease — reading them here would silently save stale/default
      // values the user never saw or entered. Lease simply doesn't collect these, so
      // they're omitted entirely rather than sent as null.
    } : {
      rent:         parseInt(rent) || 0, // doubles as the expected sale price for Sell listings
      // Deposit is not collected for Short Stay or Sell — omitted entirely
      // rather than sending a stale/default value.
      ...(isShortStay || isSell ? {} : {
        deposit: isPG ? (parseInt(gv('f-pgDeposit')) || 0)
                      : (parseInt(document.getElementById('f-deposit').value) || 0),
      }),
      // Maintenance/escalation/electricity/water fields are hidden for PG,
      // Short Stay, and Sell — omitted entirely rather than sending
      // stale/default nulls.
      ...((isPG || isShortStay || isSell) ? {} : {
        maintenance:  parseFloat(gv('f-maintenance')) || null,
        rentIncrease: parseFloat(gv('f-escalation')) ? gv('f-escalation') + '%' : null,
        electricity:  gv('f-electricityIncluded') || null,
        water:        gv('f-waterCharge') || null,
      }),
      // Negotiable still applies to Sell (still hidden for PG/Short Stay).
      ...((isPG || isShortStay) ? {} : {
        negotiable:   gv('f-negotiable').toLowerCase() === 'yes' ? 'Yes'
                    : gv('f-negotiable').toLowerCase() === 'no'  ? 'No'
                    : null,
      }),
    },
    ...(isPG ? {} : {
      property: {
        // type/bhk/area/age are only collected for Rent and Lease — PG and Short
        // Stay have their own room/occupancy fields instead, so these are omitted
        // entirely rather than sent as null. A Sell listing marked "Plot / Land"
        // has no BHK or age either (nothing built on it yet) — omitted for the
        // same reason, area (plot size) is the only one that still applies.
        ...(isShortStay ? {} : { type: gv('f-propertyType'), area: gv('f-area') }),
        ...(isShortStay || isLand ? {} : { bhk: gv('f-bhk'), age: gv('f-age') }),
        // Vacant land has nowhere to park a bike/car either.
        ...(isLand ? {} : {
          bike:      isShortStay ? String(parseInt(document.getElementById('f-ssBikePark').value, 10) || 0)
                   : String(parseInt(document.getElementById('f-bikepark').value, 10) || 0),
          car:       isShortStay ? String(parseInt(document.getElementById('f-ssCarPark').value, 10) || 0)
                   : String(parseInt(document.getElementById('f-carpark').value, 10) || 0),
        }),
        // floor/bathrooms/furnish/facing/tenant/available live in
        // #addPropDetailsSection, which is hidden entirely for Short Stay —
        // reading them here would silently save stale/default values the
        // user never saw or entered. Short Stay simply doesn't collect
        // these, so they're omitted entirely rather than sent as null.
        // Land also skips floor/bathrooms/toiletType/furnish (no building
        // exists yet) but keeps facing/tenant/available.
        ...(isShortStay ? {} : {
          ...(isLand ? {} : {
            floor:     document.getElementById('f-floor').value || 'G',
            bathrooms: document.getElementById('f-baths').value || '1',
            toiletType: document.getElementById('f-toiletType').value,
            furnish:   document.getElementById('f-furnishing').value,
          }),
          facing:    document.getElementById('f-facing').value,
          tenant:    document.getElementById('f-tenant').value,
          available: isLease ? gv('f-leaseAvailableFrom') : (document.getElementById('f-avail').value || null),
        }),
      },
    }),
    amenities: {
      selected: amenitiesSelected,
      extra:    amenitiesExtra,
    },
    // terms (notice/lease/leaseType/lockIn) is a Rent/Lease concept — PG's
    // notice period lives only in pg.notice, Short Stay's cancellation
    // policy lives only in shortStay.cancellation, and a Sell listing has no
    // notice/lease-term concept at all, so `terms` is omitted entirely for
    // all three rather than duplicating/nulling it here.
    ...((isPG || isShortStay || isSell) ? {} : {
      terms: {
        notice: isLease ? (gv('f-leaseNoticePeriod') || null)
              : (gv('f-noticePeriod') || null),
        // Rent's own lease-duration dropdown (f-leaseDuration) doesn't apply to
        // Lease, so the "lease" key uses the Lease-specific dropdown for it.
        ...(isLease ? { lease: gv('f-leaseDurationVal') || null }
          : { lease: gv('f-leaseDuration') || null }),
        // Lease-only fields — omitted entirely (not even sent as null) for every
        // other listing type, including Rent.
        ...(isLease ? { leaseType: gv('f-leaseType') || null, lockIn: gv('f-lockInPeriod') || null } : {}),
      },
    }),
    // Pets/non-veg house rules don't apply to a sale either — same
    // omit-entirely treatment as terms above.
    ...((isPG || isShortStay || isSell) ? {} : {
      rules: {
        pets:   isLease ? (gv('f-leasePets') || null) : (gv('f-petsAllowed') || null),
        nonVeg: isLease ? (gv('f-leaseNonVeg') || null) : (gv('f-nonVegAllowed') || null),
        // "gas" field removed entirely from the Rent form submission — the piped
        // gas checkbox (am-pipedgas) still adds "Piped gas connection" to the
        // amenities list, it just no longer also writes a separate rules.gas value.
      },
    }),
    media: {
      video: gv('f-videoUrl') || null,
      desc:  document.getElementById('f-desc').value.trim(),
      images: images,
    },
    // All PG-specific data — including parking, which lives under property for
    // every other listing type — is captured here only, so nothing about a PG
    // listing is duplicated into property/terms/rules.
    pg: isPG ? {
      type:      document.getElementById('f-pgPropertyType').value,
      gender:    document.getElementById('f-pgGender').value,
      room:      document.getElementById('f-pgRoomType').value,
      meals:     document.getElementById('f-pgMeals').value,
      occupancy: gv('f-pgOccupancy') || null,
      notice:    gv('f-pgNotice') || null,
      bathroom:  gv('f-pgBathroom') || null,
      toiletType: gv('f-pgToiletType') || null,
      furnish:   gv('f-pgRoomFurnishing') || null,
      food:      gv('f-pgFoodType') || null,
      available: gv('f-pgAvailableFrom') || null,
      visitors:  gv('f-pgVisitorPolicy') || null,
      gateTime:  gv('f-pgGateTime') || null,
      bike:      String(parseInt(document.getElementById('f-pgBikePark').value, 10) || 0),
      car:       String(parseInt(document.getElementById('f-pgCarPark').value, 10) || 0),
    } : {},
    shortStay: isShortStay ? {
      type:          document.getElementById('f-ssPropertyType').value,
      roomType:      document.getElementById('f-ssRoomType').value,
      available24hrs: document.getElementById('f-ss24hrs').value,
      cancellation:  gv('f-ssCancellation') || null,
      couplesAllowed: gv('f-ssCouples') || null,
      furnish:       gv('f-ssFurnish') || null,
    } : {},
    // Sell-only fields — resale specifics not covered by property.* above.
    // totalFloors/balconies/flooring/OC/CC/areaType don't apply to vacant
    // land, same reasoning as property.bhk/floor/bathrooms above (see
    // onSellPropertyTypeChange()).
    sale: isSell ? {
      ...(isLand ? {} : {
        totalFloors: gv('f-sellTotalFloors') || null,
        balconies:   gv('f-sellBalconies') || null,
        flooring:    gv('f-sellFlooring') || null,
        ocAvailable: gv('f-sellOcAvailable') || null,
        ccAvailable: gv('f-sellCcAvailable') || null,
        areaType:    gv('f-areaType') || null,
      }),
      ownership:       gv('f-sellOwnership') || null,
      possession:      gv('f-sellPossession') || null,
      possessionDate:  gv('f-sellPossessionDate') || null,
      reraRegistered:  gv('f-sellRera') || null,
      reraId:          gv('f-sellReraId') || null,
      khataType:       gv('f-sellKhataType') || null,
      propertyTaxPaid: gv('f-sellTaxPaid') || null,
      loanStatus:      gv('f-sellLoanStatus') || null,
      previousOwners:  gv('f-sellPreviousOwners') || null,
      projectName:     gv('f-sellProjectName') || null,
      waterSource:     gv('f-sellWaterSource') || null,
      boundaryWall:    gv('f-sellBoundaryWall') || null,
      roadWidth:       gv('f-sellRoadWidth') || null,
      openSides:       gv('f-sellOpenSides') || null,
      cornerProperty:  gv('f-sellCornerProperty') || null,
      overlooking:     gv('f-sellOverlooking') || null,
    } : {},
  };

  // ── POST (new listing) or PUT (editing an existing one) to backend ──
  const isEditing = !!editingPropertyId;
  const submitBtn = document.getElementById('listingSubmitBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = isEditing ? 'Saving…' : 'Submitting…'; }

  fetch(isEditing ? ('/api/user/listings/' + editingPropertyId) : '/api/properties', {
    method: isEditing ? 'PUT' : 'POST',
    headers: userAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(newProp)
  })
  .then(async res => {
    const data = await res.json();
    if (!res.ok) { if (data.code === 'NOT_VERIFIED') { showPendingVerificationModal(); return; } throw new Error(data.message || 'Server error'); }
    if (isEditing) {
      showToast('Updated!');
      closeEditListingFull();
      loadMyListings();     // refresh "My Listings" with the saved changes
      fetchProperties();    // refresh the public grid so the edit shows up there too
      return;
    }
    // Don't add this to PROPERTIES / the public grid — a brand-new listing
    // is unverified, and the public /api/properties endpoint only returns
    // verified: true listings. It'll show up once admin verifies it; until
    // then it's visible to the owner via "My Listings" (fetched fresh from
    // /api/user/my-listings, which is unfiltered for the owner's own posts).
    clearListingDraft();
    resetListingForm();
    document.getElementById('addModal').classList.remove('open');
    unlockBodyScroll();
    showToast('Submitted! Will appear once our team verifies it.');
  })
  .catch(err => {
    console.error('Submit listing error:', err);
    showToast('Failed to ' + (isEditing ? 'save changes' : 'submit') + ': ' + err.message, 'error');
  })
  .finally(() => {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEditing ? 'Save changes' : 'Submit listing'; }
  });
}

/* ═══════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════ */
let toastTimer;
const TOAST_ICONS = {
  success: '<path d="M20 6L9 17l-5-5"/>',
  error:   '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="16.01"/>',
  warning: '<path d="M12 9v4"/><path d="M12 16.01h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
  info:    '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.5" x2="12" y2="7.51"/>',
};

/* ── Indian mobile number validation ──
   Valid mobile numbers: exactly 10 digits, first digit 6/7/8/9. */
function isValidIndianMobile(v) {
  return /^[6-9]\d{9}$/.test((v || '').trim());
}

// Attach via oninput to any dedicated mobile-number <input>. Strips
// non-digits, drops leading digits that can't start a valid number
// (0–5), and caps the length at 10 digits — all in real time as the
// person types or pastes.
function sanitizeMobileInput(el) {
  let digits = el.value.replace(/\D/g, '');
  while (digits.length && !/[6-9]/.test(digits[0])) {
    digits = digits.slice(1);
  }
  el.value = digits.slice(0, 10);
}

// Lets the person pick a number straight from their phone's contacts
// instead of typing it. Uses the browser Contact Picker API, which only
// exists on some mobile browsers (e.g. Chrome on Android) over HTTPS —
// everywhere else we just tell them to type the number in manually.
async function pickContactFromDevice(fieldId, nameFieldId) {
  if (!('contacts' in navigator && 'ContactsManager' in window)) {
    showToast("Contact picker isn't supported on this device/browser — please type the number in.", 'error');
    return;
  }
  try {
    const contacts = await navigator.contacts.select(['tel', 'name'], { multiple: false });
    if (!contacts || !contacts.length) return;
    const picked = contacts[0];
    const rawTel = (picked.tel && picked.tel[0]) || '';
    let digits = rawTel.replace(/\D/g, '').slice(-10);
    while (digits.length && !/[6-9]/.test(digits[0])) digits = digits.slice(1);
    if (!digits) {
      showToast('That contact has no usable mobile number.', 'error');
      return;
    }
    const field = document.getElementById(fieldId);
    if (field) {
      field.value = digits;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (nameFieldId && picked.name && picked.name[0]) {
      const nameField = document.getElementById(nameFieldId);
      if (nameField) {
        nameField.value = picked.name[0];
        nameField.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') {
      showToast('Could not read that contact — please type the number in.', 'error');
    }
  }
}

/* ── Confirm dialog (Promise-based replacement for window.confirm()) ──
   Usage: if (!await showConfirmDialog({ message: 'Delete this?' })) return; */
function showConfirmDialog({ title = 'Are you sure?', message = 'This action cannot be undone.', okText = 'Confirm', cancelText = 'Cancel', variant = 'danger' } = {}) {
  return new Promise(resolve => {
    const overlay   = document.getElementById('confirmOverlay');
    const iconEl    = document.getElementById('confirmIcon');
    const titleEl   = document.getElementById('confirmTitle');
    const msgEl     = document.getElementById('confirmMsg');
    const okBtn     = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;

    const isInfo = variant === 'info';
    iconEl.classList.toggle('info', isInfo);
    okBtn.classList.toggle('info', isInfo);

    function cleanup(result) {
      overlay.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlayClick(e) { if (e.target === overlay) cleanup(false); }
    function onKeydown(e) { if (e.key === 'Escape') cleanup(false); if (e.key === 'Enter') cleanup(true); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);

    overlay.classList.add('open');
    okBtn.focus();
  });
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  const backdrop = document.getElementById('toastBackdrop');
  const kind = TOAST_ICONS[type] ? type : 'success';
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastIcon').innerHTML =
    `<svg viewBox="0 0 24 24" aria-hidden="true">${TOAST_ICONS[kind]}</svg>`;
  t.classList.remove('toast-success', 'toast-error', 'toast-warning', 'toast-info');
  t.classList.add('toast-' + kind);
  t.classList.add('show');
  backdrop.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); backdrop.classList.remove('show'); }, 2400);
}

/* ═══════════════════════════════════════════════
   KEYBOARD & CLOSE
═══════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (document.getElementById('lightboxOverlay').classList.contains('open')) {
    if (e.key === 'Escape') { closeLightbox(); return; }
    if (e.key === 'ArrowLeft') { lightboxStep(-1); return; }
    if (e.key === 'ArrowRight') { lightboxStep(1); return; }
  }
  if (e.key === 'Escape') {
    closeDetail();
    closeSort();
    closeAddModal();
    closeAuthModal();
    closeNotifModal();
    closeReferModal();
    closeHelpModal();
    closeAboutModal();
    closeCompareModal();
    closeScheduleModal();
    closeVisitConfirmModal();
    closeBookingModal();
    closeFabPicker();
    document.getElementById('filterPanel').classList.remove('open');
    if (document.getElementById('submitVideoModal').classList.contains('open')) closeSubmitVideoModal();
    if (document.getElementById('shortlistPanel').classList.contains('open')) toggleShortlistPanel();
    if (document.getElementById('menuPanel').classList.contains('open')) toggleMenuPanel();
  }
});

document.getElementById('lightboxOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeLightbox();
});
document.getElementById('detailModal').addEventListener('click', function(e) {
  if (e.target === this) closeDetail();
});
document.getElementById('scheduleModal').addEventListener('click', function(e) {
  if (e.target === this) closeScheduleModal();
});
document.getElementById('visitConfirmModal').addEventListener('click', function(e) {
  if (e.target === this) closeVisitConfirmModal();
});
document.getElementById('bookingModal').addEventListener('click', function(e) {
  if (e.target === this) closeBookingModal();
});
document.getElementById('addModal').addEventListener('click', function(e) {
  if (e.target === this) closeAddModal();
});
// Autosave the listing form as the user types/selects, so an accidental
// close (backdrop click, Escape, browser back, etc.) never loses their work.
document.getElementById('addModal').addEventListener('input', queueListingDraftSave);
document.getElementById('addModal').addEventListener('change', queueListingDraftSave);
document.getElementById('authModal').addEventListener('click', function(e) {
  if (e.target === this) closeAuthModal();
});
document.getElementById('profileModal').addEventListener('click', function(e) {
  if (e.target === this) closeProfileModal();
});
document.getElementById('notifModal').addEventListener('click', function(e) {
  if (e.target === this) closeNotifModal();
});
document.getElementById('chargesModal').addEventListener('click', function(e) {
  if (e.target === this) closeChargesModal();
});
document.getElementById('referModal').addEventListener('click', function(e) {
  if (e.target === this) closeReferModal();
});
document.getElementById('referDetailsModal').addEventListener('click', function(e) {
  if (e.target === this) closeReferDetailsModal();
});
document.getElementById('referDuplicateModal').addEventListener('click', function(e) {
  if (e.target === this) closeReferDuplicateModal();
});
document.getElementById('referSelfModal').addEventListener('click', function(e) {
  if (e.target === this) closeReferSelfModal();
});
document.getElementById('helpModal').addEventListener('click', function(e) {
  if (e.target === this) closeHelpModal();
});
document.getElementById('editRestrictedModal').addEventListener('click', function(e) {
  if (e.target === this) closeEditRestrictedModal();
});
document.getElementById('pendingVerificationModal').addEventListener('click', function(e) {
  if (e.target === this) closePendingVerificationModal();
});
document.getElementById('aboutModal').addEventListener('click', function(e) {
  if (e.target === this) closeAboutModal();
});
document.getElementById('reviewModal').addEventListener('click', function(e) {
  if (e.target === this) closeReviewModal();
});

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
buildFilterOptions();
syncFdBar();
renderCards();
updateShortlistCount();
renderShortlistPanel();
renderRecentlyViewed();
updateNavAuth();
refreshVerificationStatus(); // silent — keeps cached isVerified from going stale between logins
loadHonestReviews();
markRequiredLabels();
document.getElementById('addModal').addEventListener('input', function(e){
  const group = e.target.closest && e.target.closest('.form-group');
  if (group && group.classList.contains('has-error')) {
    const val = (e.target.value || '').trim();
    if (val !== '' && val !== 'Select') {
      group.classList.remove('has-error');
      const msg = group.querySelector('.field-error-text');
      if (msg) msg.remove();
    }
  }
});
document.getElementById('addModal').addEventListener('change', function(e){
  const group = e.target.closest && e.target.closest('.form-group');
  if (group && group.classList.contains('has-error')) {
    const val = (e.target.value || '').trim();
    if (val !== '' && val !== 'Select') {
      group.classList.remove('has-error');
      const msg = group.querySelector('.field-error-text');
      if (msg) msg.remove();
    }
  }
  const imgGroup = document.getElementById('imgFormGroup');
  if (imgGroup && imgGroup.classList.contains('has-error') && Array.isArray(fImages) && fImages.length > 0) {
    imgGroup.classList.remove('has-error');
    const msg = imgGroup.querySelector('.field-error-text');
    if (msg) msg.remove();
  }
});

// ── Image Zoom Lightbox ──
function openImgZoom(src, evt, label, title){
  if(evt) evt.stopPropagation();
  const overlay = document.getElementById('imgZoomOverlay');
  document.getElementById('imgZoomSrc').src = src;
  const cap = document.getElementById('imgZoomCaption');
  if(title){
    cap.innerHTML = (label? '<span>'+label+'</span>':'') + title;
    cap.classList.add('show');
  } else {
    cap.classList.remove('show');
    cap.innerHTML='';
  }
  overlay.classList.add('open');
}
function closeImgZoom(){
  document.getElementById('imgZoomOverlay').classList.remove('open');
}
document.addEventListener('keydown',function(e){
  if(e.key==='Escape') closeImgZoom();
});

// ─── Festive wish modal ───
(function(){
  // ── Add/edit entries here for any future wish. Each entry only shows on
  // its own date(s); nothing needs to be removed afterwards, it just stops
  // firing once the date passes.
  var WISH_CONFIG = [
    {
      id: 'varalakshmi-vratam-2026',
      startDate: '2026-08-20',   // YYYY-MM-DD (inclusive)
      endDate:   '2026-08-21',   // last day it should show (inclusive)
      image:     '/wishes/varalakshmi-vratam-2026.webp',
      imageFallback: '/wishes/varalakshmi-vratam-2026.jpg',
      alt:       'Happy Varalakshmi Vratam — from Home Loop'
    },
    {
      id: 'ganesh-chaturthi-2026',
      startDate: '2026-09-13',   // YYYY-MM-DD (inclusive)
      endDate:   '2026-09-14',   // last day it should show (inclusive)
      image:     '/wishes/ganesh-chaturthi-2026.webp',
      imageFallback: '/wishes/ganesh-chaturthi-2026.jpg',
      alt:       'Happy Ganesh Chaturthi — from Home Loop'
    }
    // Example for the future:
    // {
    //   id: 'diwali-2026',
    //   startDate: '2026-11-08',
    //   endDate:   '2026-11-09',
    //   image:     '/wishes/diwali-2026.webp',
    //   imageFallback: '/wishes/diwali-2026.jpg',
    //   alt:       'Happy Diwali — from Home Loop'
    // }
  ];

  function todayStr(){
    var d = new Date();
    var m = String(d.getMonth()+1).padStart(2,'0');
    var day = String(d.getDate()).padStart(2,'0');
    return d.getFullYear()+'-'+m+'-'+day;
  }

  function activeWish(){
    var today = todayStr();
    for (var i=0; i<WISH_CONFIG.length; i++){
      var w = WISH_CONFIG[i];
      if (today >= w.startDate && today <= w.endDate) return w;
    }
    return null;
  }

  function openWishModal(w){
    var overlay = document.getElementById('wishModalOverlay');
    var img = document.getElementById('wishModalImg');
    var revealed = false;
    function reveal(){
      if (revealed) return;
      revealed = true;
      overlay.classList.add('open');
      lockBodyScroll();
    }
    // Preload off-screen first so the modal only appears once the image is
    // actually ready — avoids a blank/broken flash while it downloads.
    // Marked low priority so this festive-banner image never competes with
    // the actual property listings fetch for bandwidth/connection slots.
    var preloadImg = new Image();
    preloadImg.fetchPriority = 'low';
    preloadImg.onload = function(){ img.src = preloadImg.src; reveal(); };
    preloadImg.onerror = function(){
      if (w.imageFallback && preloadImg.src.indexOf(w.imageFallback) === -1) {
        preloadImg.src = w.imageFallback;
      } else {
        // Both formats failed — still reveal so the close button/alt text
        // is reachable rather than silently doing nothing.
        img.src = w.image;
        reveal();
      }
    };
    preloadImg.src = w.image;
    img.alt = w.alt || '';
    // Safety net: if the image is unusually slow (very slow connection),
    // don't leave the visitor waiting forever — show it after 2s regardless.
    setTimeout(function(){ if (!revealed) { img.src = preloadImg.src || w.image; reveal(); } }, 2000);
  }

  function closeWishModal(){
    var overlay = document.getElementById('wishModalOverlay');
    if (!overlay.classList.contains('open')) return; // never opened (or already closed) — don't touch the shared scroll lock
    overlay.classList.remove('open');
    unlockBodyScroll();
  }

  document.getElementById('wishModalClose').addEventListener('click', closeWishModal);
  document.getElementById('wishModalOverlay').addEventListener('click', function(e){
    if (e.target === this) closeWishModal();
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') closeWishModal();
  });

  // Don't stack the festive popup on top of a deep-linked view (a shared
  // compare link, a shared property link, or /property/:id) — whoever the
  // visitor actually followed a link for should be the only thing that
  // opens on load. Checked directly against the URL (not compareSet/PROPERTIES)
  // since this runs before those deep links finish resolving asynchronously.
  function hasIncomingDeepLink(){
    var params = new URLSearchParams(window.location.search);
    if (params.has('compare') || params.has('property')) return true;
    if (/^\/property\/[a-fA-F0-9]{24}$/.test(window.location.pathname)) return true;
    return false;
  }

  document.addEventListener('DOMContentLoaded', function(){
    var w = activeWish();
    if (!w) return;
    if (hasIncomingDeepLink()) return;
    openWishModal(w);
  });
})();
