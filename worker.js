/* worker.js — מריץ את הפענוח והניתוח ברקע כדי שהממשק לא ייתקע */
importScripts('gtfs-core.js');

let FEED = null;
let SRC = null;
let LAST = null;      // תוצאת הניתוח האחרונה (כולל מערכי הזמנים לפירוט)
let CANCEL = false;
let ROUTE_TT = null;   // מטמון לוח היציאות לכל קו, נבנה לפי דרישה
let PATHS = null;      // מטמון מסלולי הנסיעות

function send(msg) { self.postMessage(msg); }
const abort = function () { return CANCEL; };

function stopMeta(feed, u) {
  const s = feed.stops;
  return {
    stopId: s.id[u], code: s.code[u], name: s.name[u], city: s.city[u],
    street: s.street[u], platform: s.platform[u], lat: s.lat[u], lon: s.lon[u]
  };
}

function toRow(feed, r) {
  const m = stopMeta(feed, r.u);
  m.n = r.n; m.nOrigin = r.nOrigin;
  m.maxExact = r.maxExact; m.exactAt = r.exactAt;
  m.winAll = r.winAll; m.winAllAt = r.winAllAt;
  m.winOrg = r.winOrg; m.winOrgAt = r.winOrgAt;
  m.u = r.u;
  return m;
}

function runAnalyze(opts) {
  send({ type: 'progress', text: 'מחשב עומס…', indeterminate: true });
  const res = GTFSCore.analyze(FEED, opts);
  LAST = { res: res, opts: opts };
  ROUTE_TT = null; PATHS = null; TT_BY_DATE.clear();   // ההגדרות השתנו — המטמון כבר לא תקף

  const warnings = FEED.warnings.slice();
  if (!opts.date && opts.day !== null && opts.day !== undefined) {
    const w = GTFSCore.dayOverlapWarning(FEED, opts.day);
    if (w) warnings.push(w);
  }
  if (res.stats.departures === 0) {
    warnings.push('לא נמצאה אף יציאה בטווח שנבחר. ' +
      (FEED.diag.nServicesWithDayFlags === 0
        ? 'בפיד זה אין דגלי ימי שבוע — יש לבחור תאריך מסוים מתוך הרשימה.'
        : 'בדוק את התאריך/היום ואת טווח השעות מול טווח התאריכים של הפיד.'));
  }

  const limit = opts.maxResults || 4000;
  send({
    type: 'result',
    rows: res.rows.slice(0, limit).map(function (r) { return toRow(FEED, r); }),
    stats: {
      units: res.stats.units, departures: res.stats.departures, flagged: res.stats.flagged,
      shown: Math.min(limit, res.rows.length),
      nStops: FEED.nStops, nTrips: FEED.nTrips, nRoutes: FEED.nRoutes,
      mode: FEED.mode, unit: FEED.unit
    },
    warnings: warnings
  });
}

/** לוח היציאות של כל קו ליום שלם, נבנה פעם אחת לכל ניתוח. */
function routeTT() {
  if (ROUTE_TT) return ROUTE_TT;
  const o = LAST.opts;
  ROUTE_TT = GTFSCore.routeTimetable(FEED, { day: o.day, date: o.date });
  return ROUTE_TT;
}

/** לוח היציאות לתאריך מסוים. משתמש רק ב-feed.origins שכבר בזיכרון,
    ולכן זול לקרוא לו לכל תאריך בטווח בלי לקרוא שוב את stop_times. */
const TT_BY_DATE = new Map();
function ttFor(date) {
  if (!date) return routeTT();
  let t = TT_BY_DATE.get(date);
  if (!t) { t = GTFSCore.routeTimetable(FEED, { date: date }); TT_BY_DATE.set(date, t); }
  return t;
}

/** התאריכים שיש בהם שירות בטווח שנבחר, לפי כיסוי הפיד. */
function datesInRange(from, to) {
  const all = (FEED.coverage && FEED.coverage.dates) || [];
  const out = [];
  for (const d of all) {
    if (from && d.date < from) continue;
    if (to && d.date > to) continue;
    out.push(d.date);
  }
  return out;
}

/**
 * מספר הקו לתצוגה. בפיד הישראלי route_short_name ריק אצל חלק מהקווים
 * (בעיקר רכבת), ולכן נופלים אחורה למק"ט ואז ל-route_id.
 */
function lineNumber(ri) {
  const sh = (FEED.routes.short[ri] || '').trim();
  if (sh) return sh;
  const desc = (FEED.routes.desc[ri] || '').trim();
  if (desc) return desc.split('-')[0];
  return FEED.routes.id ? FEED.routes.id[ri] : '';
}

/* תעתיק עברי→לטיני לשמות קבצים. דפדפנים מבוססי Chromium מתעלמים
   לחלוטין מערך download שאינו ASCII ומורידים קובץ בשם "download",
   ולכן שם הקובץ חייב להיות אנגלי גם כשהחיפוש היה בעברית. */
const HE2LAT = {
  'א': 'a', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z', 'ח': 'h',
  'ט': 't', 'י': 'y', 'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n',
  'ן': 'n', 'ס': 's', 'ע': 'a', 'פ': 'p', 'ף': 'p', 'צ': 'ts', 'ץ': 'ts',
  'ק': 'k', 'ר': 'r', 'ש': 'sh', 'ת': 't'
};

/**
 * ניקוי מחרוזת שמקורה בקלט משתמש לשימוש בשם קובץ.
 * אחרי התעתיק משאירים אך ורק ספרות, אותיות לטיניות, מקף וקו תחתון —
 * כך שאין תווי נתיב (/ \ ..), אין נקודות שיוצרות סיומת שנייה,
 * אין תווי בקרה ואין תווי כיווניות דו-כיווניים שמסתירים סיומת.
 */
function safeSlug(s, max) {
  s = String(s === undefined || s === null ? '' : s);
  s = s.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  s = s.replace(/[֐-׿]/g, function (c) { return HE2LAT[c] || ''; });
  s = s.replace(/[^0-9A-Za-z_]+/g, '-');
  s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, max || 40).replace(/-+$/, '');
}

/** שם קובץ הייצוא: תיאור הבחירה (מק״ט/קו/מפעיל) + היום שנבחר. */
function exportName(prefix, label, only) {
  const parts = [prefix];
  if (only && only.length && only.length <= 4) {
    const lines = [], makats = [];
    for (const ri of only) {
      const ln = safeSlug(lineNumber(ri), 12);
      if (ln && lines.indexOf(ln) === -1) lines.push(ln);
      const mk = safeSlug(FEED.routes.desc[ri], 16);
      if (mk && makats.indexOf(mk) === -1) makats.push(mk);
    }
    if (lines.length) parts.push('line-' + lines.join('-'));
    if (only.length <= 2 && makats.length) parts.push(makats.join('-'));
  } else {
    const lb = safeSlug(label, 40);
    if (lb) parts.push(lb);
  }
  parts.push(safeSlug(LAST.opts.date || 'day' + LAST.opts.day, 12));
  return parts.join('-').slice(0, 120) + '.csv';
}

/** כמו exportName, אבל עם טווח התאריכים בשם ובסיומת הנתונה. */
function rangeName(prefix, label, only, dates, ext) {
  const base = exportName(prefix, label, only).replace(/\.csv$/, '');
  if (!dates || !dates.length) return base + (ext || '.csv');
  const from = safeSlug(dates[0], 12), to = safeSlug(dates[dates.length - 1], 12);
  // exportName כבר הוסיף את יום הניתוח בסוף — מחליפים אותו בטווח בפועל
  const stem = base.replace(new RegExp('-' + safeSlug(LAST.opts.date || 'day' + LAST.opts.day, 12) + '$'), '');
  return (stem + '-' + from + (to !== from ? '-' + to : '')).slice(0, 120) + (ext || '.csv');
}

function routeInfo(ri) {
  return {
    ri: ri,
    line: lineNumber(ri),
    shortName: FEED.routes.short[ri],
    long: FEED.routes.long[ri],
    ends: GTFSCore.routeEnds(FEED.routes.long[ri]),
    agency: FEED.routes.agency[ri], makat: FEED.routes.desc[ri]
  };
}

self.onmessage = async function (e) {
  const msg = e.data;

  if (msg.type === 'cancel') { CANCEL = true; return; }

  try {
    CANCEL = false;

    if (msg.type === 'scan') {
      FEED = null; LAST = null;
      SRC = await GTFSCore.makeSource(msg.files);
      const missing = ['stops.txt', 'trips.txt', 'stop_times.txt'].filter(function (n) { return !SRC.has(n); });
      if (missing.length) throw new Error('חסרים קבצים בפיד: ' + missing.join(', ') + '.');
      FEED = await GTFSCore.scanFeed(SRC, msg.opts, function (p) { send({ type: 'progress', p: p }); }, abort);
      send({
        type: 'scanned',
        diag: FEED.diag,
        coverage: FEED.coverage,
        warnings: FEED.warnings
      });

    } else if (msg.type === 'analyze') {
      if (!FEED) throw new Error('לא נסרק פיד.');
      // שינוי יחידת הניתוח מחייב מיפוי מחדש של רציף→יחידה
      GTFSCore.setUnit(FEED, msg.opts.unit);
      const why = GTFSCore.analyzeCompatible(FEED, msg.opts);
      if (why) {
        send({ type: 'progress', text: why + ' — קורא את stop_times.txt…', indeterminate: true });
        FEED.warnings = FEED.warnings.filter(function (w) { return w.indexOf('הופסקה הקריאה') === -1; });
        await GTFSCore.loadStopTimes(SRC, FEED, msg.opts,
          function (p) { send({ type: 'progress', p: p }); }, abort);
      }
      runAnalyze(msg.opts);

    } else if (msg.type === 'detail') {
      if (!LAST) throw new Error('אין תוצאות.');
      const r = LAST.res.allRows.find(function (x) { return x.u === msg.u; });
      if (!r) throw new Error('לא נמצאה תחנה.');
      const tt = routeTT();
      const out = [];
      for (let i = 0; i < r._T.length; i++) {
        const ti = r._TR[i];
        const ri = FEED.trips.route[ti];
        const si = r._ST[i];
        // הקשר: מתי הקו יוצא מתחנת המוצא לפני ואחרי הנסיעה הזו
        let ctx = null;
        if (ri >= 0) {
          const dirs = tt.get(ri);
          const arr = dirs && dirs.get(FEED.trips.dir[ti]);
          if (arr && arr.length) {
            let k = -1;
            for (let z = 0; z < arr.length; z++) {
              if (arr[z].trips.indexOf(ti) !== -1) { k = z; break; }
            }
            ctx = {
              total: arr.reduce(function (a, g) { return a + g.count; }, 0),
              slots: arr.length,
              first: arr[0].t, last: arr[arr.length - 1].t,
              idx: k,
              prev: k > 0 ? arr[k - 1] : null,
              here: k >= 0 ? arr[k] : null,
              next: k >= 0 && k + 1 < arr.length ? arr[k + 1] : null,
              prev2: k > 1 ? arr[k - 2] : null,
              next2: k >= 0 && k + 2 < arr.length ? arr[k + 2] : null
            };
          }
        }
        out.push({
          tripIdx: ti,
          seq: r._SQ[i],
          seqFirst: FEED.origins.seq[ti],
          seqLast: FEED.origins.maxSeq[ti],
          nStops: FEED.origins.nStops[ti],
          ctx: ctx,
          t: r._T[i],
          origin: !!r._OG[i],
          line: ri >= 0 ? FEED.routes.short[ri] : '',
          lineLong: ri >= 0 ? FEED.routes.long[ri] : '',
          agency: ri >= 0 ? FEED.routes.agency[ri] : '',
          makat: ri >= 0 ? FEED.routes.desc[ri] : '',
          headsign: FEED.trips.headsign[ti],
          tripId: FEED.trips.id[ti],
          dir: FEED.trips.dir[ti],
          stopId: FEED.stops.id[si],
          stopCode: FEED.stops.code[si],
          stopName: FEED.stops.name[si],
          platform: FEED.stops.platform[si]
        });
      }
      send({ type: 'detail', u: msg.u, meta: stopMeta(FEED, msg.u), rows: out, opts: LAST.opts });

    } else if (msg.type === 'routes') {
      if (!LAST) throw new Error('אין תוצאות.');
      const tt = routeTT();
      const list = [];
      tt.forEach(function (dirs, ri) {
        let total = 0, slots = 0, dup = 0;
        dirs.forEach(function (arr) {
          arr.forEach(function (g) { total += g.count; slots++; if (g.count > 1) dup++; });
        });
        const info = routeInfo(ri);
        info.total = total; info.slots = slots; info.dup = dup;
        info.dirs = Array.from(dirs.keys()).sort();
        list.push(info);
      });
      list.sort(function (a, b) { return b.dup - a.dup || b.total - a.total; });
      send({ type: 'routes', rows: list });

    } else if (msg.type === 'timetable') {
      if (!LAST) throw new Error('אין תוצאות.');
      const dirs = routeTT().get(msg.ri);
      if (!dirs) throw new Error('לא נמצא לוח זמנים לקו.');
      const out = [];
      Array.from(dirs.keys()).sort().forEach(function (d) {
        out.push({
          dir: d,
          name: dirHeadsign(msg.ri, d),
          origin: dirOrigin(msg.ri, d),
          slots: dirs.get(d).map(function (g) { return { t: g.t, count: g.count }; })
        });
      });
      send({ type: 'timetable', ri: msg.ri, info: routeInfo(msg.ri), dirs: out, opts: LAST.opts });

    } else if (msg.type === 'exportRoutes') {
      if (!LAST) throw new Error('אין תוצאות.');
      send({ type: 'progress', text: 'בונה קובץ לוחות זמנים…', indeterminate: true });
      send({ type: 'export', csv: buildRoutesCsv(msg.onlyDup, msg.maxCols, msg.only, msg.dates),
        name: rangeName('gtfs-timetables', msg.label, msg.only, msg.dates, '.csv') });

    } else if (msg.type === 'publishSheet') {
      if (!LAST) throw new Error('אין תוצאות.');
      const dates = datesInRange(msg.from, msg.to);
      if (!dates.length) throw new Error('אין תאריכים עם שירות בטווח שנבחר.');
      send({ type: 'progress', text: 'בונה לוח זמנים ל-' + dates.length + ' ימים…', indeterminate: true });
      send({
        type: 'sheet',
        html: buildPrintSheet(msg.only, dates, msg.perTable),
        name: rangeName('luach', msg.label, msg.only, dates, '.html'),
        days: dates.length
      });

    } else if (msg.type === 'rangeDates') {
      if (!FEED) throw new Error('לא נסרק פיד.');
      send({ type: 'rangeDates', dates: datesInRange(msg.from, msg.to) });

    } else if (msg.type === 'exportStop') {
      if (!LAST) throw new Error('אין תוצאות.');
      const r = LAST.res.allRows.find(function (x) { return x.u === msg.u; });
      if (!r) throw new Error('לא נמצאה תחנה.');
      const m = stopMeta(FEED, msg.u);
      const when = LAST.opts.date ? GTFSCore.fmtDateHe(LAST.opts.date)
        : 'יום ' + GTFSCore.DAY_HE[LAST.opts.day];
      const q = function (v) {
        v = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      };
      const head = ['תאריך', 'שם תחנה', 'קוד תחנה', 'stop_id', 'רציף', 'עיר',
        'שעה', 'דקה', 'סוג', 'מספר תחנה במסלול', 'סה"כ תחנות בנסיעה',
        'קו', 'מפעיל', 'יעד', 'מק"ט', 'trip_id', 'יציאות באותה דקה'];
      const perMin = {};
      for (let i = 0; i < r._T.length; i++) {
        const k = Math.floor(r._T[i] / 60);
        perMin[k] = (perMin[k] || 0) + 1;
      }
      const lines = [head.join(',')];
      const order = [];
      for (let i = 0; i < r._T.length; i++) order.push(i);
      order.sort(function (a, b) { return r._T[a] - r._T[b]; });
      for (const i of order) {
        const ti = r._TR[i], ri = FEED.trips.route[ti], si = r._ST[i];
        lines.push([when, m.name, m.code, m.stopId, FEED.stops.platform[si], m.city,
          GTFSCore.fmtTime(r._T[i]), GTFSCore.fmtTime(Math.floor(r._T[i] / 60) * 60),
          r._OG[i] ? 'מוצא' : 'ביניים',
          r._SQ[i], FEED.origins.nStops[ti],
          ri >= 0 ? lineNumber(ri) : '', ri >= 0 ? FEED.routes.agency[ri] : '',
          FEED.trips.headsign[ti], ri >= 0 ? FEED.routes.desc[ri] : '',
          FEED.trips.id[ti], perMin[Math.floor(r._T[i] / 60)]].map(q).join(','));
      }
      send({ type: 'export', csv: '﻿' + lines.join('\r\n'),
        name: 'stop-' + safeSlug(m.code || m.stopId, 16) + '-' +
          safeSlug(m.name, 24) + '-' + safeSlug(LAST.opts.date || 'day', 12) + '.csv' });

    } else if (msg.type === 'paths') {
      if (!LAST) throw new Error('אין תוצאות.');
      if (FEED.mode !== 'all') {
        send({ type: 'paths', u: msg.u, minute: msg.minute, rows: [],
          note: 'שרטוט מסלולים דורש מצב "כולל תחנות ביניים" — במצב "תחנות מוצא בלבד" ' +
                'נשמרת רק היציאה הראשונה של כל נסיעה.' });
      } else {
        if (!PATHS) PATHS = GTFSCore.tripPathIndex(FEED);
        const out = [];
        for (const ti of msg.trips) {
          const arr = PATHS.get(ti) || [];
          const pts = [];
          for (const p of arr) {
            const la = FEED.stops.lat[p.st], lo = FEED.stops.lon[p.st];
            if (isNaN(la) || isNaN(lo)) continue;
            pts.push({ lat: la, lon: lo, seq: p.sq, t: p.t,
              name: FEED.stops.name[p.st], code: FEED.stops.code[p.st] });
          }
          const ri = FEED.trips.route[ti];
          out.push({
            tripId: FEED.trips.id[ti], line: ri >= 0 ? lineNumber(ri) : '',
            agency: ri >= 0 ? FEED.routes.agency[ri] : '',
            headsign: FEED.trips.headsign[ti],
            seqFirst: FEED.origins.seq[ti], seqLast: FEED.origins.maxSeq[ti],
            nStops: FEED.origins.nStops[ti], pts: pts
          });
        }
        send({ type: 'paths', u: msg.u, minute: msg.minute, rows: out,
          note: out.some(function (p) { return p.pts.length < p.nStops; })
            ? 'המסלול מצויר מהעצירות שנקראו בטווח השעות שנבחר, ולכן עשוי להיקטע בקצוות.'
            : '' });
      }

    } else if (msg.type === 'export') {
      if (!LAST) throw new Error('אין תוצאות לייצוא.');
      send({ type: 'progress', text: 'בונה קובץ CSV…', indeterminate: true });
      const cap = msg.capacityOf || {};
      const when = LAST.opts.date
        ? GTFSCore.fmtDateHe(LAST.opts.date)
        : 'יום ' + GTFSCore.DAY_HE[LAST.opts.day];
      const head = ['תאריך/יום', 'stop_id', 'קוד תחנה', 'שם תחנה', 'עיר', 'רחוב', 'רציף',
        'סה"כ יציאות', 'יציאות מוצא', 'רמה א׳ (אותה דקה)', 'שעת שיא א׳',
        'חלון מוצא ±' + LAST.opts.winOrigin, 'שעת שיא מוצא',
        'חלון כללי ±' + LAST.opts.winMid, 'שעת שיא כללי',
        'אורך תחנה (מ׳)', 'קיבולת (אוטובוסים)', 'אורך נדרש (מ׳)', 'דירוג',
        'קווים בשיא', 'trip_id בשיא', 'lat', 'lon'];
      const lines = [head.join(',')];
      const q = function (v) {
        v = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      };
      for (const r of LAST.res.rows) {
        const m = stopMeta(FEED, r.u);
        const len = cap[m.stopId] !== undefined ? cap[m.stopId] : msg.defaultLen;
        const capacity = Math.max(1, Math.floor(len / msg.busLen));
        const peak = Math.max(r.maxExact, r.winOrg, r.winAll);
        const grade = r.maxExact > capacity ? 'רמה א׳'
          : ((r.winOrg > capacity || r.winAll > capacity) ? 'רמה ב׳' : 'תקין');
        const at = r.exactAt;
        const lns = [], tids = [];
        for (let i = 0; i < r._T.length; i++) {
          if (Math.floor(r._T[i] / 60) * 60 === at) {
            const ri = FEED.trips.route[r._TR[i]];
            if (ri >= 0) lns.push(FEED.routes.short[ri]);
            tids.push(FEED.trips.id[r._TR[i]]);
          }
        }
        lines.push([when, m.stopId, m.code, m.name, m.city, m.street, m.platform,
          r.n, r.nOrigin, r.maxExact, GTFSCore.fmtTime(Math.max(0, r.exactAt)),
          r.winOrg, r.winOrgAt >= 0 ? GTFSCore.fmtTime(r.winOrgAt) : '',
          r.winAll, r.winAllAt >= 0 ? GTFSCore.fmtTime(r.winAllAt) : '',
          len, capacity, peak * msg.busLen, grade,
          lns.join(' | '), tids.join(' | '),
          isNaN(m.lat) ? '' : m.lat, isNaN(m.lon) ? '' : m.lon].map(q).join(','));
      }
      send({ type: 'export', csv: '﻿' + lines.join('\r\n'),
        name: 'gtfs-overcrowding-' + (LAST.opts.date || 'day' + LAST.opts.day) + '.csv' });
    }
  } catch (err) {
    if (err && err.aborted) send({ type: 'aborted' });
    else send({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

/* ==================================================================== */
/* עזרי לוחות זמנים                                                     */
/* ==================================================================== */

/** שם היעד הנפוץ ביותר בכיוון נתון — משמש כשם הכיוון בייצוא. */
function dirHeadsign(ri, d, TT) {
  const tt = (TT || routeTT()).get(ri);
  const arr = tt && tt.get(d);
  if (!arr) return '';
  const count = new Map();
  for (const g of arr) {
    for (const ti of g.trips) {
      const h = (FEED.trips.headsign[ti] || '').split('_')[0].trim();
      if (h) count.set(h, (count.get(h) || 0) + 1);
    }
  }
  let best = '', n = 0;
  count.forEach(function (v, k) { if (v > n) { n = v; best = k; } });
  if (best) return best;
  // נפילה אחורה: החצי המתאים של route_long_name
  const parts = (FEED.routes.long[ri] || '').split(/[-–]/);
  return (parts[d === 0 ? 0 : parts.length - 1] || '').trim();
}

/** שם תחנת המוצא הנפוצה בכיוון נתון. */
function dirOrigin(ri, d, TT) {
  const tt = (TT || routeTT()).get(ri);
  const arr = tt && tt.get(d);
  if (!arr) return '';
  const count = new Map();
  for (const g of arr) {
    for (const ti of g.trips) {
      const si = FEED.origins.stop[ti];
      if (si < 0) continue;
      const nm = FEED.stops.name[si];
      count.set(nm, (count.get(nm) || 0) + 1);
    }
  }
  let best = '', n = 0;
  count.forEach(function (v, k) { if (v > n) { n = v; best = k; } });
  return best;
}

/**
 * CSV של לוחות זמנים בפורמט Bulk Create של Canva.
 * כל שורה = קו אחד. עמודות שעה נפרדות (Dir1_Time_1…) לצד עמודה מרוכזת
 * אחת (Dir1_Times) לעיצובים שמשתמשים בתיבת טקסט אחת.
 * שעה שיוצאים בה כמה אוטובוסים מסומנת ב-*X.
 */
/* ==================================================================== */
/* לוח זמנים מודפס להפצה לציבור                                          */
/* ==================================================================== */

/* ---------------- תאריך עברי ושם היום ---------------- */

/* גימטריה. מיוצרת בקוד ולא נלקחת מ-Intl, כי Intl מחזיר ספרות
   ("18 באלול 5786") ולא אותיות, והתצוגה המקובלת בלוח מודפס היא באותיות. */
const GEM_ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const GEM_TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const GEM_HUND = ['', 'ק', 'ר', 'ש', 'ת'];

function gematria(n) {
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return '';
  let out = '';
  while (n >= 400) { out += 'ת'; n -= 400; }
  if (n >= 100) { out += GEM_HUND[Math.floor(n / 100)]; n %= 100; }
  // ט"ו וט"ז במקום י"ה וי"ו, שהם צירופי שם
  if (n === 15) { out += 'טו'; n = 0; }
  else if (n === 16) { out += 'טז'; n = 0; }
  if (n >= 10) { out += GEM_TENS[Math.floor(n / 10)]; n %= 10; }
  if (n > 0) out += GEM_ONES[n];
  if (out.length === 1) return out + '׳';
  return out.slice(0, -1) + '״' + out.slice(-1);
}

/** "י״ח באלול תשפ״ו" מתוך תאריך YYYYMMDD. ריק אם אין תמיכה בלוח העברי. */
function hebrewDate(ymd) {
  try {
    const d = GTFSCore.dateObj(ymd);
    const parts = new Intl.DateTimeFormat('he-IL-u-ca-hebrew',
      { day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d);
    let day = '', month = '', year = '';
    for (const p of parts) {
      if (p.type === 'day') day = p.value;
      else if (p.type === 'month') month = p.value;
      else if (p.type === 'year') year = p.value;
    }
    if (!month) return '';
    // אלפי השנה אינם נכתבים: 5786 נכתב תשפ"ו
    const y = gematria(parseInt(year, 10) % 1000);
    return gematria(parseInt(day, 10)) + ' ב' + month + (y ? ' ' + y : '');
  } catch (e) {
    return '';
  }
}

/* שם היום בלוח. שבת מוצגת כמוצ"ש: בישראל שירות האוטובוסים בשבת
   מתחיל בפועל בצאת השבת, ולוח שכותרתו "שבת" מטעה את הנוסע. */
function dayLabel(ymd) {
  const dow = GTFSCore.dateObj(ymd).getDay();
  return dow === 6 ? 'מוצ״ש' : 'יום ' + GTFSCore.DAY_HE[dow];
}

const ORG_CREDIT = 'קו ישיר — הפורום הארצי לקידום תחבורה ציבורית (ע״ר)';

function h(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * מסמך HTML עצמאי עם לוח זמנים אחד מאוחד לכל הקווים שנבחרו, לכל תאריך
 * בטווח. מיועד להדפסה או לשמירה כ-PDF מהדפדפן, ולכן אין בו תלות חיצונית.
 * @param {number[]} only    אינדקסי הקווים שנבחרו
 * @param {string[]} dates   תאריכי YYYYMMDD מתוך כיסוי הפיד
 * @param {number}   perTable כמה עמודות קו בטבלה אחת לפני פיצול
 */
function buildPrintSheet(only, dates, perTable) {
  perTable = perTable || 8;
  const days = (dates && dates.length) ? dates : [LAST.opts.date || null];
  const allow = only && only.length ? only.slice() : null;
  if (!allow) throw new Error('לא נבחרו קווים ללוח.');

  /* העמודות נבנות לכל יום בנפרד: קו שאינו פועל באותו תאריך לא מקבל
     עמודה כלל, במקום עמודה שכולה מקפים. */
  const colsFor = function (tt) {
    const out = [];
    for (const ri of allow) {
      const dirs = tt.get(ri);
      if (!dirs) continue;
      Array.from(dirs.keys()).sort().forEach(function (d) {
        const arr = dirs.get(d) || [];
        if (!arr.length) return;
        out.push({
          key: ri + ':' + d, ri: ri, d: d,
          line: lineNumber(ri),
          name: dirHeadsign(ri, d, tt),
          origin: dirOrigin(ri, d, tt),
          agency: FEED.routes.agency[ri],
          makat: FEED.routes.desc[ri]
        });
      });
    }
    out.sort(function (a, b) {
      const la = parseInt(a.line, 10), lb = parseInt(b.line, 10);
      if (!isNaN(la) && !isNaN(lb) && la !== lb) return la - lb;
      return String(a.line).localeCompare(String(b.line), 'he') || a.d - b.d;
    });
    return out;
  };

  const allLines = [];
  const body = [];
  let anyDup = false, anyCol = false;
  const usedRis = new Set();

  for (const day of days) {
    const tt = ttFor(day);
    const cols = colsFor(tt);
    cols.forEach(function (c) { if (allLines.indexOf(c.line) === -1) allLines.push(c.line); });
    cols.forEach(function (c) { usedRis.add(c.ri); });

    body.push('<section class="day">');
    body.push('<h2>' + h(dayHeading(day)) + '</h2>');
    if (!cols.length) {
      body.push('<p class="empty">אין קווים פעילים בתאריך זה מבין הקווים שנבחרו.</p></section>');
      continue;
    }
    anyCol = true;

    /* שעות → עמודה → משבצות */
    const grid = new Map();
    let total = 0;
    for (const c of cols) {
      const dirs = tt.get(c.ri);
      const arr = (dirs && dirs.get(c.d)) || [];
      for (const g of arr) {
        const hr = Math.floor(g.t / 3600);
        let row = grid.get(hr);
        if (!row) { row = new Map(); grid.set(hr, row); }
        let cell = row.get(c.key);
        if (!cell) { cell = []; row.set(c.key, cell); }
        cell.push(g);
        total += g.count;
        if (g.count > 1) anyDup = true;
      }
    }
    const hours = Array.from(grid.keys()).sort(function (a, b) { return a - b; });
    body.push('<p class="sum">' + cols.length + ' כיווני נסיעה · ' + total + ' יציאות</p>');

    const chunks = [];
    for (let i = 0; i < cols.length; i += perTable) chunks.push(cols.slice(i, i + perTable));

    for (const chunk of chunks) {
      body.push('<table><thead><tr><th class="hcol">שעה</th>');
      for (const c of chunk) {
        body.push('<th><span class="ln">' + h(c.line) + '</span>' +
          (c.name ? '<span class="dst">' + h(c.name) + '</span>' : '') +
          (c.origin ? '<span class="org">מ: ' + h(c.origin) + '</span>' : '') +
          '<span class="ag">' + h(c.agency) + '</span></th>');
      }
      body.push('</tr></thead><tbody>');
      for (const hr of hours) {
        const row = grid.get(hr);
        if (!chunk.some(function (c) { return row.get(c.key); })) continue;
        body.push('<tr><th class="hcol"><bdi>' + pad2(hr % 24) + ':00</bdi>' +
          (hr >= 24 ? '<sup>למחרת</sup>' : '') + '</th>');
        for (const c of chunk) {
          const cell = row.get(c.key);
          body.push('<td>' + (cell ? cell.map(function (g) {
            return '<span class="m' + (g.count > 1 ? ' dup' : '') + '"><bdi>' +
              pad2(hr % 24) + ':' + pad2(Math.floor((g.t % 3600) / 60)) + '</bdi>' +
              (g.count > 1 ? '<i>×' + g.count + '</i>' : '') + '</span>';
          }).join('') : '<span class="none">·</span>') + '</td>');
        }
        body.push('</tr>');
      }
      body.push('</tbody></table>');
    }
    body.push('</section>');
  }
  if (!anyCol) throw new Error('אין יציאות לקווים שנבחרו בטווח התאריכים.');

  /* קווים שנבחרו ואינם פועלים כלל בטווח אינם מקבלים עמודה, ולכן מצוינים
     בהערה אחת בסוף המסמך כדי שהבחירה תישאר מתועדת. */
  const idle = [];
  for (const ri of allow) {
    if (usedRis.has(ri)) continue;
    const ln = lineNumber(ri);
    if (ln && idle.indexOf(ln) === -1) idle.push(ln);
  }

  const range = days.length > 1 && days[0]
    ? GTFSCore.fmtDateHe(days[0]) + ' – ' + GTFSCore.fmtDateHe(days[days.length - 1])
    : (days[0] ? GTFSCore.fmtDateHe(days[0]) : describeDay());
  const lines = allLines.slice();
  /* כותרת עם 30 מספרי קו אינה כותרת: מקצרים ומציינים כמה נשארו */
  const lineList = lines.length > 10
    ? lines.slice(0, 10).join(', ') + ' ועוד ' + (lines.length - 10)
    : lines.join(', ');

  /* החלפה עם פונקציה — אחרת רצף כמו $& בשם קו היה מתפרש כתבנית */
  const fill = {
    TITLE: h('לוח זמנים · קווים ' + lineList + ' · ' + range),
    HEAD: h('לוח זמנים — קווים ' + lineList),
    RANGE: h(range),
    BODY: body.join('\n'),
    IDLENOTE: idle.length
      ? '<p class="dupnote">קווים שנבחרו ואינם פועלים בטווח התאריכים, ולכן אינם מופיעים בלוח: ' +
        h(idle.slice(0, 30).join(', ')) +
        (idle.length > 30 ? ' ועוד ' + (idle.length - 30) : '') + '.</p>'
      : '',
    DUPNOTE: anyDup
      ? '<p class="dupnote">שעה המסומנת <span class="m dup"><bdi>08:15</bdi><i>×2</i></span> ' +
        'היא דקה שבה מתוכננת יציאה של יותר מאוטובוס אחד מאותו קו.</p>'
      : '',
    SOURCE: h(FEED.diag.source || 'GTFS'),
    CREDIT: h(ORG_CREDIT),
    MADE: h(new Date().toLocaleDateString('he-IL'))
  };
  return PRINT_HTML.replace(/\{\{([A-Z]+)\}\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(fill, k) ? fill[k] : m;
  });
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function describeDay() {
  if (LAST.opts.date) return GTFSCore.fmtDateHe(LAST.opts.date);
  return 'יום ' + GTFSCore.DAY_HE[LAST.opts.day];
}

/** כותרת היום בלוח: תאריך לועזי, שם היום ותאריך עברי. */
function dayHeading(day) {
  if (!day) return describeDay();
  const heb = hebrewDate(day);
  return GTFSCore.fmtDateHe(day) + ' · ' + dayLabel(day) + (heb ? ' · ' + heb : '');
}

/* תבנית המסמך. עצמאית לחלוטין — בלי גופנים חיצוניים ובלי סקריפטים,
   כדי שתיפתח גם במחשב מנותק ותודפס זהה בכל דפדפן. */
const PRINT_HTML = [
  '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>{{TITLE}}</title><style>',
  ':root{--ink:#111;--muted:#555;--line:#c9ced6;--dup:#b91c1c;--soft:#f2f4f7}',
  '*{box-sizing:border-box}',
  'body{margin:0;padding:18px;background:#fff;color:var(--ink);',
  '  font:15px/1.45 "Segoe UI",Arial,sans-serif}',
  '.sheet{max-width:1100px;margin:0 auto}',
  'h1{font-size:24px;margin:0 0 4px}',
  '.range{color:var(--muted);margin:0 0 14px;font-size:15px}',
  /* שני תאריכים ומקף בתוך פסקה עברית מתהפכים בלי בידוד */
  '.range bdi{direction:ltr;unicode-bidi:isolate}',
  '.day{margin:0 0 26px;break-inside:auto}',
  'h2{font-size:18px;margin:20px 0 2px;padding-bottom:5px;border-bottom:2px solid var(--ink)}',
  '.sum{color:var(--muted);font-size:13px;margin:4px 0 10px}',
  '.empty{color:var(--muted);font-style:italic}',
  'table{width:100%;border-collapse:collapse;margin:0 0 14px;font-size:14px}',
  'th,td{border:1px solid var(--line);padding:5px 7px;vertical-align:top;text-align:right}',
  'thead th{background:var(--soft);text-align:center;line-height:1.25}',
  'th.hcol{width:4.6em;text-align:center;background:var(--soft);font-variant-numeric:tabular-nums}',
  'th.hcol sup{display:block;font-size:9px;font-weight:400;color:var(--muted)}',
  '.ln{display:block;font-size:20px;font-weight:800}',
  '.dst{display:block;font-size:12px;font-weight:600}',
  '.org{display:block;font-size:11px;font-weight:400;color:var(--muted)}',
  '.ag{display:block;font-size:10px;font-weight:400;color:var(--muted)}',
  /* direction:ltr יחד עם isolate — אחרת הסימון ×2 מוצג משמאל לשעה */
  '.m{display:inline-block;margin:1px 0 1px 6px;font-variant-numeric:tabular-nums;',
  '  direction:ltr;unicode-bidi:isolate}',
  '.m.dup{color:var(--dup);font-weight:700}',
  '.m i{font-style:normal;font-size:11px;margin-inline-start:1px}',
  '.none{color:var(--line)}',
  '.dupnote{font-size:13px;color:var(--muted);margin:10px 0}',
  'footer{margin-top:22px;padding-top:10px;border-top:1px solid var(--line);',
  '  font-size:12px;color:var(--muted)}',
  'footer b{color:var(--ink)}',
  '.noprint{margin:0 0 16px}',
  'button{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;',
  '  border:1px solid var(--line);background:#fff;cursor:pointer}',
  '@media print{',
  '  body{padding:0;font-size:12px}',
  '  .noprint{display:none}',
  '  .day{break-before:page}.day:first-of-type{break-before:auto}',
  '  table{font-size:11px}.ln{font-size:16px}',
  '  thead{display:table-header-group}tr{break-inside:avoid}',
  '  footer{position:running(f)}',
  '}',
  '@page{size:A4;margin:12mm}',
  '</style></head><body><div class="sheet">',
  '<div class="noprint"><button onclick="window.print()">הדפסה / שמירה כ-PDF</button></div>',
  '<h1>{{HEAD}}</h1>',
  '<p class="range"><bdi>{{RANGE}}</bdi></p>',
  '{{BODY}}',
  '{{DUPNOTE}}',
  '{{IDLENOTE}}',
  '<footer><b>{{CREDIT}}</b><br>',
  'הלוח הופק מקובץ ה-GTFS הרשמי של משרד התחבורה ({{SOURCE}}) בתאריך {{MADE}}.<br>',
  'השעות הן שעות היציאה המתוכננות מתחנת המוצא. ייתכנו שינויים; ',
  'המקור המחייב הוא פרסומי המפעיל ומשרד התחבורה.</footer>',
  '</div></body></html>'
].join('\n');

function buildRoutesCsv(onlyDup, maxCols, only, dates) {
  const allow = only && only.length ? new Set(only) : null;
  maxCols = maxCols || 60;
  /* טווח תאריכים: שורה לכל קו בכל תאריך. בלי טווח — היום שנותח. */
  const days = (dates && dates.length) ? dates.slice() : [null];
  const q = function (v) {
    v = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const slotText = function (g) {
    return GTFSCore.fmtTime(g.t) + (g.count > 1 ? '*' + g.count : '');
  };

  // כמה עמודות שעה באמת צריך — לכל כיוון בנפרד.
  // בפיד הישראלי כל כיוון נסיעה הוא route_id נפרד, ולכן ברוב הייצואים
  // אין כיוון שני כלל; במקרה כזה לא מייצרים עמודות Dir2 ריקות.
  let need1 = 0, need2 = 0;
  const rows = [];
  for (const day of days) {
    const tt = ttFor(day);
    tt.forEach(function (dirs, ri) {
      const ds = Array.from(dirs.keys()).sort();
      const d1 = dirs.get(ds[0]) || [];
      const d2 = ds.length > 1 ? (dirs.get(ds[1]) || []) : [];
      if (allow && !allow.has(ri)) return;
      const dup = d1.concat(d2).some(function (g) { return g.count > 1; });
      if (onlyDup && !dup) return;
      need1 = Math.max(need1, d1.length);
      need2 = Math.max(need2, d2.length);
      rows.push({ ri: ri, ds: ds, d1: d1, d2: d2, dup: dup, day: day, tt: tt });
    });
  }
  need1 = Math.min(need1, maxCols);
  need2 = Math.min(need2, maxCols);
  const hasD2 = need2 > 0;

  const head = ['Line_Number', 'Destination', 'Direction_1_Name'];
  if (hasD2) head.push('Direction_2_Name');
  head.push('Agency', 'Makat', 'Service_Date', 'Dir1_Count');
  if (hasD2) head.push('Dir2_Count');
  head.push('Dir1_Times');
  if (hasD2) head.push('Dir2_Times');
  for (let i = 1; i <= need1; i++) head.push('Dir1_Time_' + i);
  for (let i = 1; i <= need2; i++) head.push('Dir2_Time_' + i);

  const whenOf = function (day) {
    if (day) return GTFSCore.fmtDateHe(day);
    return LAST.opts.date ? GTFSCore.fmtDateHe(LAST.opts.date)
      : 'יום ' + GTFSCore.DAY_HE[LAST.opts.day];
  };
  const out = [head.join(',')];

  /* מיון: קו, ואז תאריך — כך שכל הקווים של יום אחד יושבים יחד בעיצוב */
  rows.sort(function (a, b) {
    if (a.day !== b.day) return String(a.day).localeCompare(String(b.day));
    const la = parseInt(lineNumber(a.ri), 10), lb = parseInt(lineNumber(b.ri), 10);
    if (!isNaN(la) && !isNaN(lb) && la !== lb) return la - lb;
    return String(lineNumber(a.ri)).localeCompare(String(lineNumber(b.ri)), 'he');
  });

  for (const r of rows) {
    const t1 = r.d1.map(slotText), t2 = r.d2.map(slotText);
    const line = [
      lineNumber(r.ri),
      GTFSCore.routeEnds(FEED.routes.long[r.ri]),
      dirHeadsign(r.ri, r.ds[0], r.tt)
    ];
    if (hasD2) line.push(r.ds.length > 1 ? dirHeadsign(r.ri, r.ds[1], r.tt) : '');
    line.push(
      FEED.routes.agency[r.ri],
      FEED.routes.desc[r.ri],
      whenOf(r.day),
      r.d1.reduce(function (a, g) { return a + g.count; }, 0));
    if (hasD2) line.push(r.d2.reduce(function (a, g) { return a + g.count; }, 0));
    line.push(t1.join(' '));
    if (hasD2) line.push(t2.join(' '));
    for (let i = 0; i < need1; i++) line.push(t1[i] || '');
    for (let i = 0; i < need2; i++) line.push(t2[i] || '');
    out.push(line.map(q).join(','));
  }
  return '﻿' + out.join('\r\n');
}
