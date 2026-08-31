/* worker.js — מריץ את הפענוח והניתוח ברקע כדי שהממשק לא ייתקע */
importScripts('gtfs-core.js');

let FEED = null;
let SRC = null;
let LAST = null;      // תוצאת הניתוח האחרונה (כולל מערכי הזמנים לפירוט)
let CANCEL = false;
let ROUTE_TT = null;   // מטמון לוח היציאות לכל קו, נבנה לפי דרישה

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
  ROUTE_TT = null;   // ההגדרות השתנו — המטמון כבר לא תקף

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

function routeInfo(ri) {
  return {
    ri: ri,
    line: FEED.routes.short[ri], long: FEED.routes.long[ri],
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
          seq: r._SQ[i],
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
      send({ type: 'export', csv: buildRoutesCsv(msg.onlyDup, msg.maxCols),
        name: 'gtfs-timetables-' + (LAST.opts.date || 'day' + LAST.opts.day) + '.csv' });

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
function dirHeadsign(ri, d) {
  const tt = routeTT().get(ri);
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
function dirOrigin(ri, d) {
  const tt = routeTT().get(ri);
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
function buildRoutesCsv(onlyDup, maxCols) {
  maxCols = maxCols || 60;
  const tt = routeTT();
  const q = function (v) {
    v = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const slotText = function (g) {
    return GTFSCore.fmtTime(g.t) + (g.count > 1 ? '*' + g.count : '');
  };

  // כמה עמודות שעה באמת צריך
  let need = 0;
  const rows = [];
  tt.forEach(function (dirs, ri) {
    const ds = Array.from(dirs.keys()).sort();
    const d1 = dirs.get(ds[0]) || [];
    const d2 = ds.length > 1 ? (dirs.get(ds[1]) || []) : [];
    const dup = d1.concat(d2).some(function (g) { return g.count > 1; });
    if (onlyDup && !dup) return;
    need = Math.max(need, d1.length, d2.length);
    rows.push({ ri: ri, ds: ds, d1: d1, d2: d2, dup: dup });
  });
  need = Math.min(need, maxCols);

  const head = ['Line_Number', 'Destination', 'Direction_1_Name', 'Direction_2_Name',
    'Agency', 'Makat', 'Service_Date', 'Dir1_Count', 'Dir2_Count',
    'Dir1_Times', 'Dir2_Times'];
  for (let i = 1; i <= need; i++) head.push('Dir1_Time_' + i);
  for (let i = 1; i <= need; i++) head.push('Dir2_Time_' + i);

  const when = LAST.opts.date ? GTFSCore.fmtDateHe(LAST.opts.date)
    : 'יום ' + GTFSCore.DAY_HE[LAST.opts.day];
  const out = [head.join(',')];

  rows.sort(function (a, b) {
    const la = parseInt(FEED.routes.short[a.ri], 10), lb = parseInt(FEED.routes.short[b.ri], 10);
    if (!isNaN(la) && !isNaN(lb) && la !== lb) return la - lb;
    return String(FEED.routes.short[a.ri]).localeCompare(String(FEED.routes.short[b.ri]), 'he');
  });

  for (const r of rows) {
    const t1 = r.d1.map(slotText), t2 = r.d2.map(slotText);
    const line = [
      FEED.routes.short[r.ri],
      FEED.routes.long[r.ri],
      dirHeadsign(r.ri, r.ds[0]),
      r.ds.length > 1 ? dirHeadsign(r.ri, r.ds[1]) : '',
      FEED.routes.agency[r.ri],
      FEED.routes.desc[r.ri],
      when,
      r.d1.reduce(function (a, g) { return a + g.count; }, 0),
      r.d2.reduce(function (a, g) { return a + g.count; }, 0),
      t1.join(' '), t2.join(' ')
    ];
    for (let i = 0; i < need; i++) line.push(t1[i] || '');
    for (let i = 0; i < need; i++) line.push(t2[i] || '');
    out.push(line.map(q).join(','));
  }
  return '﻿' + out.join('\r\n');
}
