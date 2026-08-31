/* worker.js — מריץ את הפענוח והניתוח ברקע כדי שהממשק לא ייתקע */
importScripts('gtfs-core.js');

let FEED = null;
let SRC = null;
let LAST = null; // תוצאת הניתוח האחרונה (כולל מערכי הזמנים לפירוט)

function send(msg) { self.postMessage(msg); }

function stopMeta(feed, u) {
  const s = feed.stops;
  return {
    stopId: s.id[u], code: s.code[u], name: s.name[u], city: s.city[u],
    street: s.street[u], platform: s.platform[u], lat: s.lat[u], lon: s.lon[u]
  };
}

/** ממיר שורות ניתוח לתצוגה (בלי המערכים הכבדים). */
function toRow(feed, r) {
  const m = stopMeta(feed, r.u);
  m.n = r.n;
  m.nOrigin = r.nOrigin;
  m.maxExact = r.maxExact;
  m.exactAt = r.exactAt;
  m.winAll = r.winAll;
  m.winAllAt = r.winAllAt;
  m.winOrg = r.winOrg;
  m.winOrgAt = r.winOrgAt;
  m.u = r.u;
  return m;
}

function runAnalyze(opts) {
  send({ type: 'progress', text: 'מחשב עומס…' });
  const res = GTFSCore.analyze(FEED, opts);
  LAST = { res: res, opts: opts };
  const limit = opts.maxResults || 4000;
  send({
    type: 'result',
    rows: res.rows.slice(0, limit).map(function (r) { return toRow(FEED, r); }),
    stats: {
      units: res.stats.units,
      departures: res.stats.departures,
      flagged: res.stats.flagged,
      shown: Math.min(limit, res.rows.length),
      nStops: FEED.nStops, nTrips: FEED.nTrips, nRoutes: FEED.nRoutes,
      mode: FEED.mode, unit: FEED.unit
    },
    warnings: FEED.warnings
  });
}

self.onmessage = async function (e) {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      SRC = await GTFSCore.makeSource(msg.files);
      const missing = ['stops.txt', 'trips.txt', 'stop_times.txt'].filter(function (n) { return !SRC.has(n); });
      if (missing.length) throw new Error('חסרים קבצים בפיד: ' + missing.join(', '));
      send({ type: 'loaded-source', names: SRC.names, kind: SRC.kind });
      FEED = await GTFSCore.loadFeed(SRC, msg.opts, function (p) { send({ type: 'progress', p: p }); });
      runAnalyze(msg.opts);

    } else if (msg.type === 'reanalyze') {
      if (!FEED) throw new Error('לא נטען פיד.');
      const why = GTFSCore.analyzeCompatible(FEED, msg.opts);
      if (why) {
        send({ type: 'progress', text: why + ' מחייב קריאה מחדש של הפיד…' });
        FEED = await GTFSCore.loadFeed(SRC, msg.opts, function (p) { send({ type: 'progress', p: p }); });
      }
      runAnalyze(msg.opts);

    } else if (msg.type === 'detail') {
      if (!LAST) throw new Error('אין תוצאות.');
      const r = LAST.res.allRows.find(function (x) { return x.u === msg.u; });
      if (!r) throw new Error('לא נמצאה תחנה.');
      const out = [];
      for (let i = 0; i < r._T.length; i++) {
        const ti = r._TR[i];
        const ri = FEED.trips.route[ti];
        out.push({
          t: r._T[i],
          origin: !!r._OG[i],
          line: ri >= 0 ? FEED.routes.short[ri] : '',
          lineLong: ri >= 0 ? FEED.routes.long[ri] : '',
          agency: ri >= 0 ? FEED.routes.agency[ri] : '',
          desc: ri >= 0 ? FEED.routes.desc[ri] : '',
          headsign: FEED.trips.headsign[ti]
        });
      }
      send({ type: 'detail', u: msg.u, meta: stopMeta(FEED, msg.u), rows: out });

    } else if (msg.type === 'export') {
      if (!LAST) throw new Error('אין תוצאות לייצוא.');
      send({ type: 'progress', text: 'בונה קובץ CSV…' });
      const cap = msg.capacityOf || {};
      const head = ['stop_id', 'קוד תחנה', 'שם תחנה', 'עיר', 'רחוב', 'רציף',
        'סה"כ יציאות', 'יציאות מוצא', 'רמה א׳ (אותה דקה)', 'שעת שיא א׳',
        'חלון מוצא ±' + LAST.opts.winOrigin, 'שעת שיא מוצא',
        'חלון כללי ±' + LAST.opts.winMid, 'שעת שיא כללי',
        'אורך תחנה (מ׳)', 'קיבולת (אוטובוסים)', 'אורך נדרש (מ׳)', 'דירוג', 'קווים בשיא', 'lat', 'lon'];
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
        // קווים ברגע השיא (רמה א׳)
        const at = r.exactAt;
        const lines2 = [];
        for (let i = 0; i < r._T.length; i++) {
          if (Math.floor(r._T[i] / 60) * 60 === at) {
            const ri = FEED.trips.route[r._TR[i]];
            if (ri >= 0) lines2.push(FEED.routes.short[ri]);
          }
        }
        lines.push([m.stopId, m.code, m.name, m.city, m.street, m.platform,
          r.n, r.nOrigin, r.maxExact, GTFSCore.fmtTime(Math.max(0, r.exactAt)),
          r.winOrg, r.winOrgAt >= 0 ? GTFSCore.fmtTime(r.winOrgAt) : '',
          r.winAll, r.winAllAt >= 0 ? GTFSCore.fmtTime(r.winAllAt) : '',
          len, capacity, peak * msg.busLen, grade, lines2.join(' | '),
          isNaN(m.lat) ? '' : m.lat, isNaN(m.lon) ? '' : m.lon].map(q).join(','));
      }
      send({ type: 'export', csv: '﻿' + lines.join('\r\n') });
    }
  } catch (err) {
    send({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
