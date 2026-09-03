/*
 * gtfs-core.js — ליבת פענוח וניתוח GTFS, רצה כולה בדפדפן (ללא שרת).
 * נטענת גם ב-Web Worker (importScripts) וגם ב-Node לבדיקות.
 *
 * מונחים:
 *   יחידת ניתוח (unit) = רציף בודד (stop_id) או תחנת-אם (parent_station), לפי ההגדרה.
 *   תחנת מוצא         = היציאה הראשונה של הנסיעה (stop_sequence המינימלי של ה-trip).
 *
 * הטעינה דו-שלבית:
 *   scanFeed()      — קורא הכול חוץ מ-stop_times.txt. מהיר, ומגלה את טווח התאריכים.
 *   loadStopTimes() — השלב הכבד, רץ רק אחרי שהמשתמש בחר תאריך וטווח שעות.
 */
(function (global) {
  'use strict';

  /* ==================================================================== */
  /* ביטול פעולה                                                          */
  /* ==================================================================== */

  function AbortError() {
    const e = new Error('הפעולה בוטלה על ידי המשתמש');
    e.name = 'AbortError';
    e.aborted = true;
    return e;
  }
  function checkAbort(abort) {
    if (abort && abort()) throw AbortError();
  }

  /* ==================================================================== */
  /* ZIP                                                                  */
  /* ==================================================================== */

  async function readSlice(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }
  function view(u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  /** קורא את ספריית ה-ZIP המרכזית (תומך גם ZIP64). */
  async function readZipEntries(file) {
    const size = file.size;
    const tailLen = Math.min(size, 66000);
    const tail = await readSlice(file, size - tailLen, size);
    const t = view(tail);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (t.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('הקובץ אינו ZIP תקין (לא נמצא End Of Central Directory).');

    let cdSize = t.getUint32(eocd + 12, true);
    let cdOffset = t.getUint32(eocd + 16, true);
    let nEntries = t.getUint16(eocd + 10, true);

    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || nEntries === 0xffff) {
      let loc = -1;
      for (let i = eocd - 20; i >= 0; i--) {
        if (t.getUint32(i, true) === 0x07064b50) { loc = i; break; }
      }
      if (loc < 0) throw new Error('ZIP64 ללא רשומת איתור (locator).');
      const z64Off = Number(t.getBigUint64(loc + 8, true));
      const z = view(await readSlice(file, z64Off, z64Off + 56));
      if (z.getUint32(0, true) !== 0x06064b50) throw new Error('רשומת ZIP64 EOCD פגומה.');
      nEntries = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdOffset = Number(z.getBigUint64(48, true));
    }

    const cd = await readSlice(file, cdOffset, cdOffset + cdSize);
    const c = view(cd);
    const dec = new TextDecoder('utf-8');
    const entries = [];
    let p = 0;

    for (let i = 0; i < nEntries && p + 46 <= cd.length; i++) {
      if (c.getUint32(p, true) !== 0x02014b50) break;
      const method = c.getUint16(p + 10, true);
      let compSize = c.getUint32(p + 20, true);
      let uncompSize = c.getUint32(p + 24, true);
      const nameLen = c.getUint16(p + 28, true);
      const extraLen = c.getUint16(p + 30, true);
      const cmtLen = c.getUint16(p + 32, true);
      let lho = c.getUint32(p + 42, true);
      const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));

      if (uncompSize === 0xffffffff || compSize === 0xffffffff || lho === 0xffffffff) {
        let e = p + 46 + nameLen;
        const endE = e + extraLen;
        while (e + 4 <= endE) {
          const id = c.getUint16(e, true);
          const sz = c.getUint16(e + 2, true);
          if (id === 0x0001) {
            let q = e + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(c.getBigUint64(q, true)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(c.getBigUint64(q, true)); q += 8; }
            if (lho === 0xffffffff) { lho = Number(c.getBigUint64(q, true)); q += 8; }
            break;
          }
          e += 4 + sz;
        }
      }
      entries.push({ name: name, method: method, compSize: compSize, uncompSize: uncompSize, lho: lho });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return entries;
  }

  /** מחזיר ReadableStream של תוכן רשומה ב-ZIP, מפוענח בזרימה. */
  async function zipEntryStream(file, entry) {
    const head = view(await readSlice(file, entry.lho, entry.lho + 30));
    if (head.getUint32(0, true) !== 0x04034b50) {
      throw new Error('כותרת מקומית פגומה עבור ' + entry.name);
    }
    const nameLen = head.getUint16(26, true);
    const extraLen = head.getUint16(28, true);
    const start = entry.lho + 30 + nameLen + extraLen;
    const blob = file.slice(start, start + entry.compSize);
    let s = blob.stream();
    if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('הדפדפן אינו תומך ב-DecompressionStream. נסה Chrome/Edge 103+, Firefox 113+ או Safari 16.4+.');
      }
      s = s.pipeThrough(new DecompressionStream('deflate-raw'));
    } else if (entry.method !== 0) {
      throw new Error('שיטת דחיסה לא נתמכת (' + entry.method + ') בקובץ ' + entry.name);
    }
    return s;
  }

  /* ==================================================================== */
  /* CSV                                                                  */
  /* ==================================================================== */

  /**
   * פיצול שורת CSV, סלחני כלפי הפיד הישראלי.
   *
   * הכלל הקריטי: מרכאה נחשבת פותחת שדה מצוטט רק אם היא התו הראשון בשדה.
   * בפיד של משרד התחבורה יש שמות תחנה עם גרשיים שאינם מצוטטים כלל
   * (למשל  ת.רק"ל הקוממיות/דרך בגין ), ומנתח תמים היה בולע בגללן את
   * שאר השורה לתוך שם התחנה ומאבד את הקואורדינטות.
   */
  function splitCsv(line) {
    if (line.indexOf('"') === -1) return line.split(',');
    const out = [];
    const n = line.length;
    let i = 0;
    for (;;) {
      let cur = '';
      if (i < n && line.charCodeAt(i) === 34) {   // שדה מצוטט תקני
        i++;
        for (;;) {
          const q = line.indexOf('"', i);
          if (q === -1) { cur += line.slice(i); i = n; break; }
          cur += line.slice(i, q);
          if (line.charCodeAt(q + 1) === 34) { cur += '"'; i = q + 2; continue; }
          i = q + 1;
          break;
        }
      }
      // שארית השדה עד הפסיק — מרכאות כאן הן תו רגיל לכל דבר
      const c = line.indexOf(',', i);
      if (c === -1) { out.push(cur + line.slice(i)); return out; }
      out.push(cur + line.slice(i, c));
      i = c + 1;
      if (i === n) { out.push(''); return out; }
    }
  }

  /**
   * אם שורה מכילה יותר שדות מהכותרת, ככל הנראה שדה טקסט חופשי הכיל פסיק
   * בלי ציטוט. מאחים את העודף בחזרה לתוך העמודה החשודה (joinIdx).
   */
  function fixOverflow(r, nCols, joinIdx) {
    if (joinIdx < 0 || r.length <= nCols) return r;
    const extra = r.length - nCols;
    return r.slice(0, joinIdx)
      .concat([r.slice(joinIdx, joinIdx + extra + 1).join(',')])
      .concat(r.slice(joinIdx + extra + 1));
  }

  /**
   * קורא CSV בזרימה.
   * onProgress(bytesRead, rowsRead) נקרא אחת לכמה מקטעים; אם הוא זורק — הקריאה נעצרת.
   */
  async function streamCsv(stream, onHeader, onRow, onProgress) {
    const reader = stream.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let header = null;
    let bytes = 0;
    let rows = 0;
    let sinceReport = 0;

    const handleLine = function (line) {
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (line.length === 0) return;
      if (header === null) {
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
        header = splitCsv(line).map(function (s) { return s.trim(); });
        onHeader(header);
      } else {
        onRow(splitCsv(line));
        rows++;
      }
    };

    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.byteLength;
        buf += dec.decode(r.value, { stream: true });
        let start = 0;
        let nl;
        while ((nl = buf.indexOf('\n', start)) !== -1) {
          handleLine(buf.slice(start, nl));
          start = nl + 1;
        }
        buf = start > 0 ? buf.slice(start) : buf;
        sinceReport += r.value.byteLength;
        if (onProgress && sinceReport > 4 * 1024 * 1024) {
          sinceReport = 0;
          onProgress(bytes, rows);
          // מאפשר ל-Worker לנשום, לשלוח התקדמות ולקלוט בקשת עצירה
          await new Promise(function (res) { setTimeout(res, 0); });
        }
      }
      buf += dec.decode();
      if (buf.length) handleLine(buf);
      if (onProgress) onProgress(bytes, rows);
    } finally {
      try { reader.cancel(); } catch (e) { /* כבר נסגר */ }
    }
    return { bytes: bytes, rows: rows };
  }

  function colIndex(header, names) {
    for (let i = 0; i < names.length; i++) {
      const k = header.indexOf(names[i]);
      if (k !== -1) return k;
    }
    return -1;
  }

  /** "25:10:00" → 90600 שניות מתחילת יום השירות. */
  function parseTime(s) {
    if (!s) return -1;
    let h = 0, m = 0, sec = 0, i = 0, c;
    const n = s.length;
    while (i < n && (c = s.charCodeAt(i)) >= 48 && c <= 57) { h = h * 10 + (c - 48); i++; }
    if (s.charCodeAt(i) !== 58) return -1;
    i++;
    while (i < n && (c = s.charCodeAt(i)) >= 48 && c <= 57) { m = m * 10 + (c - 48); i++; }
    if (s.charCodeAt(i) === 58) {
      i++;
      while (i < n && (c = s.charCodeAt(i)) >= 48 && c <= 57) { sec = sec * 10 + (c - 48); i++; }
    }
    return h * 3600 + m * 60 + sec;
  }

  function fmtTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return p(h) + ':' + p(m) + (s ? ':' + p(s) : '');
  }

  /**
   * מפרק stop_desc בסגנון משרד התחבורה: "רחוב: X עיר: Y רציף: Z קומה: W".
   * תומך גם בגרסה האנגלית של הפיד ("Street: … City: … Platform: … Floor: …")
   * וגם כשהשדות מופרדים בפסיקים.
   */
  const DESC_LABELS = [
    ['רחוב:', 'street'], ['עיר:', 'city'], ['רציף:', 'platform'], ['קומה:', 'floor'],
    ['Street:', 'street'], ['City:', 'city'], ['Platform:', 'platform'], ['Floor:', 'floor']
  ];
  /* חץ שמאלה עטוף בסימני LRM. החץ מסומן ב-Bidi_Mirrored, ובלי העטיפה
     דפדפן או אקסל יהפכו אותו לחץ ימינה בתוך טקסט עברי. */
  const ARROW = '‎←‎';

  /**
   * מפרק route_long_name של משרד התחבורה לשני קצוות.
   * המבנה: "<תחנה>-<עיר><->‎<תחנה>-<עיר>-<חלופה>".
   * פידים ותיקים או מקוצרים כותבים "<עיר>-<עיר>" בלבד, ואז אין שם תחנה.
   * מחזיר null כשלא ניתן לפרק, והקורא נופל אחורה לשם המקורי.
   */
  function parseLongName(long) {
    const raw = String(long === undefined || long === null ? '' : long).trim();
    if (!raw) return null;

    const side = function (part, stripAlt) {
      let t = String(part).trim();
      if (stripAlt) t = t.replace(/-(?:\d+|#)$/, '').trim();
      const i = t.lastIndexOf('-');
      if (i <= 0 || i === t.length - 1) return { city: t, stop: '' };
      return { stop: t.slice(0, i).trim(), city: t.slice(i + 1).trim() };
    };

    const k = raw.indexOf('<->');
    if (k !== -1) {
      return { a: side(raw.slice(0, k), false), b: side(raw.slice(k + 3), true) };
    }
    // מבנה מקוצר: שתי ערים בלבד
    const parts = raw.replace(/-(?:\d+|#)$/, '').split('-');
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      return { a: { city: parts[0].trim(), stop: '' }, b: { city: parts[1].trim(), stop: '' } };
    }
    return null;
  }

  /** "עיר: תחנה" לצד אחד, או רק העיר כשאין שם תחנה. */
  function endLabel(e) {
    if (!e) return '';
    return e.stop ? e.city + ': ' + e.stop : e.city;
  }

  /**
   * תיאור מוצא ויעד לתצוגה ולייצוא: "אופקים: מבנה ← ירושלים: הארזים".
   * מחזיר את שם המסלול המקורי כשלא ניתן לפרק אותו.
   */
  function routeEnds(long) {
    const p = parseLongName(long);
    if (!p) return String(long === undefined || long === null ? '' : long);
    const a = endLabel(p.a), b = endLabel(p.b);
    if (!a || !b) return a || b || String(long);
    return a + ' ' + ARROW + ' ' + b;
  }

  function parseStopDesc(d) {
    const res = { street: '', city: '', platform: '', floor: '' };
    if (!d) return res;
    const found = [];
    for (let i = 0; i < DESC_LABELS.length; i++) {
      const k = d.indexOf(DESC_LABELS[i][0]);
      if (k >= 0) found.push({ i: k, len: DESC_LABELS[i][0].length, key: DESC_LABELS[i][1] });
    }
    if (!found.length) return res;
    found.sort(function (a, b) { return a.i - b.i; });
    for (let j = 0; j < found.length; j++) {
      const s = found[j].i + found[j].len;
      const e = j + 1 < found.length ? found[j + 1].i : d.length;
      let v = d.slice(s, e).trim();
      if (v.charCodeAt(v.length - 1) === 44) v = v.slice(0, -1).trim(); // פסיק מפריד
      if (!res[found[j].key]) res[found[j].key] = v;
    }
    return res;
  }

  /* ==================================================================== */
  /* עזרי תאריך                                                           */
  /* ==================================================================== */

  const DAY_COLS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const DAY_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  function dateToNum(s) { return s ? parseInt(s, 10) : 0; }          // '20260901' → 20260901
  function numToDate(n) { return String(n); }
  function dateObj(s) {
    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  }
  function objToStr(d) {
    const p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  /** '20260901' → '01/09/2026' */
  function fmtDateHe(s) {
    if (!s || s.length !== 8) return '';
    return s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4);
  }

  /* ==================================================================== */
  /* מקור קבצים (ZIP או קבצים בודדים)                                     */
  /* ==================================================================== */

  function baseName(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return (i === -1 ? p : p.slice(i + 1)).toLowerCase();
  }

  async function makeSource(fileList) {
    const files = Array.from(fileList);
    const zip = files.find(function (f) { return /\.zip$/i.test(f.name); });
    if (zip) {
      const entries = await readZipEntries(zip);
      const map = new Map();
      for (const e of entries) {
        if (e.name.endsWith('/')) continue;
        map.set(baseName(e.name), e);
      }
      return {
        kind: 'zip',
        label: zip.name,
        names: Array.from(map.keys()),
        sizeOf: function (n) { const e = map.get(n); return e ? e.uncompSize : 0; },
        has: function (n) { return map.has(n); },
        open: function (n) {
          const e = map.get(n);
          if (!e) return null;
          return zipEntryStream(zip, e);
        }
      };
    }
    const map = new Map();
    for (const f of files) map.set(baseName(f.name), f);
    return {
      kind: 'files',
      label: files.length + ' קבצים',
      names: Array.from(map.keys()),
      sizeOf: function (n) { const f = map.get(n); return f ? f.size : 0; },
      has: function (n) { return map.has(n); },
      open: async function (n) {
        const f = map.get(n);
        return f ? f.stream() : null;
      }
    };
  }

  /* ==================================================================== */
  /* שלב א' — סריקת הפיד (הכול חוץ מ-stop_times)                          */
  /* ==================================================================== */

  /**
   * opts: { unit: 'platform' | 'station' }
   * report(p) לדיווח התקדמות, abort() להחזרת true כדי לבטל.
   */
  async function scanFeed(source, opts, report, abort) {
    const warn = [];
    const say = report || function () {};

    const need = ['stops.txt', 'trips.txt', 'stop_times.txt'];
    for (const n of need) {
      if (!source.has(n)) throw new Error('חסר הקובץ ' + n + ' בפיד.');
    }

    /* ---------- stops ---------- */
    say({ phase: 'stops', text: 'קורא stops.txt…' });
    const stopIndex = new Map();
    const stopId = [], stopCode = [], stopName = [], stopCity = [], stopStreet = [],
      stopPlatform = [], stopLat = [], stopLon = [], stopParentRaw = [], stopLocType = [];
    let nStopCols = 0, nStopsRepaired = 0, nStopsBadCoord = 0;
    const badSamples = [];
    {
      let c = null;
      await streamCsv(await source.open('stops.txt'),
        function (h) {
          nStopCols = h.length;
          c = {
            id: colIndex(h, ['stop_id']), code: colIndex(h, ['stop_code']),
            name: colIndex(h, ['stop_name']), desc: colIndex(h, ['stop_desc']),
            lat: colIndex(h, ['stop_lat']), lon: colIndex(h, ['stop_lon']),
            parent: colIndex(h, ['parent_station']), loc: colIndex(h, ['location_type']),
            plat: colIndex(h, ['platform_code'])
          };
        },
        function (r) {
          if (r.length > nStopCols) {
            // שדה טקסט עם פסיק שלא צוטט — מאחים אותו בחזרה לתוך stop_desc
            if (nStopsRepaired < 5) badSamples.push(r.join(',').slice(0, 200));
            r = fixOverflow(r, nStopCols, c.desc);
            nStopsRepaired++;
          }
          const id = r[c.id];
          if (id === undefined || id === '') return;
          const d = parseStopDesc(c.desc >= 0 ? r[c.desc] : '');
          stopIndex.set(id, stopId.length);
          stopId.push(id);
          stopCode.push(c.code >= 0 ? (r[c.code] || '') : '');
          stopName.push(c.name >= 0 ? (r[c.name] || '') : '');
          stopCity.push(d.city);
          stopStreet.push(d.street);
          stopPlatform.push((c.plat >= 0 && r[c.plat]) ? r[c.plat] : d.platform);
          const la = c.lat >= 0 ? parseFloat(r[c.lat]) : NaN;
          const lo = c.lon >= 0 ? parseFloat(r[c.lon]) : NaN;
          if (isNaN(la) || isNaN(lo)) nStopsBadCoord++;
          stopLat.push(la);
          stopLon.push(lo);
          stopParentRaw.push(c.parent >= 0 ? (r[c.parent] || '') : '');
          stopLocType.push(c.loc >= 0 ? (parseInt(r[c.loc], 10) || 0) : 0);
        },
        function () { checkAbort(abort); });
    }
    const nStops = stopId.length;
    let nStationRecords = 0, nWithParent = 0;
    for (let i = 0; i < nStops; i++) {
      if (stopLocType[i] === 1) nStationRecords++;
      if (stopParentRaw[i]) nWithParent++;
    }
    checkAbort(abort);

    // unitOf: מיפוי רציף → יחידת ניתוח
    const unitOfStop = new Int32Array(nStops);
    let nParented = 0;
    for (let i = 0; i < nStops; i++) {
      let u = i;
      if (opts.unit === 'station' && stopParentRaw[i]) {
        const p = stopIndex.get(stopParentRaw[i]);
        if (p !== undefined) { u = p; nParented++; }
      }
      unitOfStop[i] = u;
    }
    if (opts.unit === 'station' && !nParented) {
      warn.push('לא נמצאו ערכי parent_station בפיד — הניתוח בוצע לפי stop_id (רציף בודד).');
    }

    /* ---------- agency ---------- */
    const agencyName = new Map();
    if (source.has('agency.txt')) {
      let c = null;
      await streamCsv(await source.open('agency.txt'),
        function (h) { c = { id: colIndex(h, ['agency_id']), name: colIndex(h, ['agency_name']) }; },
        function (r) { agencyName.set(c.id >= 0 ? (r[c.id] || '') : '', c.name >= 0 ? (r[c.name] || '') : ''); });
    }

    /* ---------- routes ---------- */
    say({ phase: 'routes', text: 'קורא routes.txt…' });
    const routeIndex = new Map();
    const routeShort = [], routeLong = [], routeAgency = [], routeDesc = [], routeId = [];
    if (source.has('routes.txt')) {
      let c = null;
      await streamCsv(await source.open('routes.txt'),
        function (h) {
          c = {
            id: colIndex(h, ['route_id']), sh: colIndex(h, ['route_short_name']),
            ln: colIndex(h, ['route_long_name']), ag: colIndex(h, ['agency_id']),
            de: colIndex(h, ['route_desc'])
          };
        },
        function (r) {
          const id = r[c.id];
          if (id === undefined) return;
          routeIndex.set(id, routeShort.length);
          routeId.push(id);
          routeShort.push(c.sh >= 0 ? (r[c.sh] || '') : '');
          routeLong.push(c.ln >= 0 ? (r[c.ln] || '') : '');
          routeAgency.push(agencyName.get(c.ag >= 0 ? (r[c.ag] || '') : '') || '');
          routeDesc.push(c.de >= 0 ? (r[c.de] || '') : '');
        },
        function () { checkAbort(abort); });
    }
    checkAbort(abort);

    /* ---------- calendar ---------- */
    say({ phase: 'calendar', text: 'קורא calendar.txt…' });
    const serviceIndex = new Map();
    const svcDays = [], svcStart = [], svcEnd = [];
    let nCalendarRows = 0, nWithDayFlags = 0;
    if (source.has('calendar.txt')) {
      let c = null;
      await streamCsv(await source.open('calendar.txt'),
        function (h) {
          c = { id: colIndex(h, ['service_id']), d: DAY_COLS.map(function (n) { return colIndex(h, [n]); }),
            s: colIndex(h, ['start_date']), e: colIndex(h, ['end_date']) };
        },
        function (r) {
          const id = r[c.id];
          if (id === undefined) return;
          nCalendarRows++;
          serviceIndex.set(id, svcDays.length);
          const bits = [];
          let any = 0;
          for (let k = 0; k < 7; k++) {
            const v = c.d[k] >= 0 && r[c.d[k]] === '1' ? 1 : 0;
            bits.push(v); any |= v;
          }
          if (any) nWithDayFlags++;
          svcDays.push(bits);
          svcStart.push(c.s >= 0 ? (r[c.s] || '') : '');
          svcEnd.push(c.e >= 0 ? (r[c.e] || '') : '');
        });
    }
    // calendar_dates
    const svcExc = new Map();
    let nCalendarDateRows = 0, nAddedFromDates = 0;
    if (source.has('calendar_dates.txt')) {
      let c = null;
      await streamCsv(await source.open('calendar_dates.txt'),
        function (h) { c = { id: colIndex(h, ['service_id']), d: colIndex(h, ['date']), t: colIndex(h, ['exception_type']) }; },
        function (r) {
          const id = r[c.id];
          if (id === undefined) return;
          nCalendarDateRows++;
          let si = serviceIndex.get(id);
          if (si === undefined) { // שירות שקיים רק ב-calendar_dates
            si = svcDays.length;
            serviceIndex.set(id, si);
            svcDays.push([0, 0, 0, 0, 0, 0, 0]);
            svcStart.push(''); svcEnd.push('');
            nAddedFromDates++;
          }
          let m = svcExc.get(si);
          if (!m) { m = new Map(); svcExc.set(si, m); }
          m.set(r[c.d], parseInt(r[c.t], 10));
        },
        function () { checkAbort(abort); });
    }
    const nServices = svcDays.length;
    checkAbort(abort);

    /* ---------- trips ---------- */
    say({ phase: 'trips', text: 'קורא trips.txt…' });
    const tripIndex = new Map();
    let nTripsWithShape = 0;
    const shapeIds = new Set();
    const tripIds = [], tripRoute = [], tripService = [], tripHeadsign = [], tripDir = [];
    {
      let c = null;
      const total = source.sizeOf('trips.txt') || 0;
      await streamCsv(await source.open('trips.txt'),
        function (h) {
          c = {
            id: colIndex(h, ['trip_id']), rt: colIndex(h, ['route_id']),
            sv: colIndex(h, ['service_id']), hs: colIndex(h, ['trip_headsign']),
            dr: colIndex(h, ['direction_id']), sp: colIndex(h, ['shape_id'])
          };
        },
        function (r) {
          const id = r[c.id];
          if (id === undefined) return;
          tripIndex.set(id, tripRoute.length);
          tripIds.push(id);
          const ri = c.rt >= 0 ? routeIndex.get(r[c.rt]) : undefined;
          tripRoute.push(ri === undefined ? -1 : ri);
          const si = c.sv >= 0 ? serviceIndex.get(r[c.sv]) : undefined;
          tripService.push(si === undefined ? -1 : si);
          tripHeadsign.push(c.hs >= 0 ? (r[c.hs] || '') : '');
          tripDir.push(c.dr >= 0 ? (parseInt(r[c.dr], 10) || 0) : 0);
          if (c.sp >= 0 && r[c.sp]) { nTripsWithShape++; shapeIds.add(r[c.sp]); }
        },
        function (bytes, rows) {
          checkAbort(abort);
          say({ phase: 'trips', bytes: bytes, total: total, rows: rows, text: 'קורא trips.txt…' });
        });
    }
    const nTrips = tripRoute.length;
    checkAbort(abort);

    const services = { nServices: nServices, svcDays: svcDays, svcStart: svcStart, svcEnd: svcEnd, svcExc: svcExc };

    // כמה נסיעות לכל שירות — מאפשר לספור נסיעות לכל תאריך במהירות
    const tripsPerService = new Uint32Array(Math.max(1, nServices));
    for (let i = 0; i < nTrips; i++) {
      const s = tripService[i];
      if (s >= 0) tripsPerService[s]++;
    }

    say({ phase: 'dates', text: 'מזהה את טווח התאריכים של הפיד…' });
    const coverage = dateCoverage(services, tripsPerService);

    /* ---------- אבחון ---------- */
    const diag = {
      source: source.label,
      files: source.names.slice().sort(),
      nStops: nStops, nTrips: nTrips, nRoutes: routeShort.length, nServices: nServices,
      nParented: nParented,
      nStationRecords: nStationRecords,
      nWithParent: nWithParent,
      hasCalendar: source.has('calendar.txt'),
      hasCalendarDates: source.has('calendar_dates.txt'),
      nCalendarRows: nCalendarRows,
      nServicesWithDayFlags: nWithDayFlags,
      nCalendarDateRows: nCalendarDateRows,
      nServicesOnlyInDates: nAddedFromDates,
      stopTimesBytes: source.sizeOf('stop_times.txt') || 0,
      shapesBytes: source.sizeOf('shapes.txt') || 0,
      nTripsWithShape: nTripsWithShape,
      nDistinctShapes: shapeIds.size,
      nStopsRepaired: nStopsRepaired,
      nStopsBadCoord: nStopsBadCoord,
      malformedSamples: badSamples,
      coverage: coverage
    };
    if (nStopsRepaired) {
      warn.push(nStopsRepaired.toLocaleString('he-IL') + ' שורות ב-stops.txt הכילו פסיק בשדה ' +
        'לא מצוטט ואוחו אוטומטית. ראה "אבחון מלא" לדוגמאות.');
    }
    if (nStopsBadCoord) {
      warn.push(nStopsBadCoord.toLocaleString('he-IL') + ' תחנות ללא קואורדינטות תקינות — ' +
        'הן לא יופיעו על המפה.');
    }

    // אזהרות מנחות
    if (nServices === 0) {
      warn.push('הפיד אינו כולל נתוני לוח שנה כלל — כל הנסיעות ייספרו יחד ללא סינון לפי יום.');
    } else if (nWithDayFlags === 0) {
      warn.push('בפיד זה אף שירות אינו מסומן בימי השבוע ב-calendar.txt — הוא מוגדר לפי תאריכים ' +
        'מפורשים ב-calendar_dates.txt. סינון "יום בשבוע" יחזיר אפס תוצאות; יש לבחור תאריך מסוים.');
    }
    if (!coverage.dates.length) {
      warn.push('לא נמצא אף תאריך שבו פועל שירות כלשהו. בדוק שהפיד תקין.');
    }

    return {
      warnings: warn,
      diag: diag,
      unit: opts.unit,
      mode: null,           // ייקבע ב-loadStopTimes
      loadedFilter: null,
      nStops: nStops, nTrips: nTrips, nRoutes: routeShort.length, nServices: nServices,
      keptRows: 0,
      coverage: coverage,
      stopIndex: stopIndex,
      stops: {
        id: stopId, code: stopCode, name: stopName, city: stopCity, street: stopStreet,
        platform: stopPlatform, lat: stopLat, lon: stopLon, parent: stopParentRaw, locType: stopLocType
      },
      unitOfStop: unitOfStop,
      routes: { id: routeId, short: routeShort, long: routeLong, agency: routeAgency, desc: routeDesc },
      trips: { id: tripIds, route: tripRoute, service: tripService, headsign: tripHeadsign, dir: tripDir },
      tripIndex: tripIndex,
      services: services,
      tripsPerService: tripsPerService,
      origins: null,
      bucket: null
    };
  }

  /**
   * מחשב לכל תאריך בטווח הפיד כמה שירותים ונסיעות פעילים בו.
   * מוגבל ל-maxDays ימים כדי לא להיתקע על פיד עם טווח שנים.
   */
  function dateCoverage(svc, tripsPerService, maxDays) {
    maxDays = maxDays || 400;
    let min = 0, max = 0;
    const upd = function (d) {
      const n = dateToNum(d);
      if (!n) return;
      if (!min || n < min) min = n;
      if (!max || n > max) max = n;
    };
    for (let i = 0; i < svc.nServices; i++) { upd(svc.svcStart[i]); upd(svc.svcEnd[i]); }
    svc.svcExc.forEach(function (m) { m.forEach(function (v, d) { upd(d); }); });

    if (!min || !max) return { min: null, max: null, dates: [], truncated: false };

    const dates = [];
    let d = dateObj(numToDate(min));
    const end = dateObj(numToDate(max));
    let guard = 0;
    let truncated = false;
    while (d <= end) {
      if (guard++ >= maxDays) { truncated = true; break; }
      const ds = objToStr(d);
      const dow = d.getDay();
      let nSvc = 0, nTrip = 0;
      for (let i = 0; i < svc.nServices; i++) {
        const exc = svc.svcExc.get(i);
        const e = exc ? exc.get(ds) : undefined;
        let on;
        if (e === 2) on = false;
        else if (e === 1) on = true;
        else {
          const inRange = (!svc.svcStart[i] || svc.svcStart[i] <= ds) &&
                          (!svc.svcEnd[i] || ds <= svc.svcEnd[i]);
          on = inRange && !!svc.svcDays[i][dow];
        }
        if (on) { nSvc++; nTrip += tripsPerService ? tripsPerService[i] : 0; }
      }
      if (nSvc > 0) dates.push({ date: ds, dow: dow, services: nSvc, trips: nTrip });
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    return { min: numToDate(min), max: numToDate(max), dates: dates, truncated: truncated };
  }

  /* ==================================================================== */
  /* שלב ב' — קריאת stop_times                                            */
  /* ==================================================================== */

  /**
   * opts: { mode:'origins'|'all', day, date, fromHour, toHour, maxRows }
   * משנה את feed במקום ומחזיר אותו.
   */
  async function loadStopTimes(source, feed, opts, report, abort) {
    const say = report || function () {};
    const nTrips = feed.nTrips;

    const activeSvc = buildActiveServices(feed.services, opts);

    say({ phase: 'stop_times', text: 'קורא stop_times.txt…' });
    const stTotal = source.sizeOf('stop_times.txt') || 0;

    const tripMinSeq = new Int32Array(nTrips).fill(0x7fffffff);
    const tripMaxSeq = new Int32Array(nTrips).fill(-1);
    const tripNStops = new Int32Array(nTrips);
    const tripOriginStop = new Int32Array(nTrips).fill(-1);
    const tripOriginTime = new Int32Array(nTrips).fill(-1);

    const keepAll = opts.mode === 'all';
    const padSec = 40 * 60;
    const loSec = opts.fromHour * 3600 - padSec;
    const hiSec = opts.toHour * 3600 + 3600 + padSec;
    const maxRows = opts.maxRows || 6000000;
    const bucket = new Map(); // unitIdx → {t:[], tr:[], sq:[], st:[]}
    let kept = 0, truncated = false;

    const t0 = Date.now();
    let c = null;
    await streamCsv(await source.open('stop_times.txt'),
      function (h) {
        c = {
          tr: colIndex(h, ['trip_id']), st: colIndex(h, ['stop_id']),
          dep: colIndex(h, ['departure_time']), arr: colIndex(h, ['arrival_time']),
          sq: colIndex(h, ['stop_sequence'])
        };
        if (c.tr < 0 || c.st < 0) throw new Error('stop_times.txt חסר עמודת trip_id או stop_id.');
      },
      function (r) {
        const ti = feed.tripIndex.get(r[c.tr]);
        if (ti === undefined) return;
        const si = feed.stopIndex.get(r[c.st]);
        if (si === undefined) return;
        const seq = c.sq >= 0 ? (parseInt(r[c.sq], 10) || 0) : 0;
        let t = c.dep >= 0 ? parseTime(r[c.dep]) : -1;
        if (t < 0 && c.arr >= 0) t = parseTime(r[c.arr]);
        if (t < 0) return;

        if (seq < tripMinSeq[ti]) {
          tripMinSeq[ti] = seq;
          tripOriginStop[ti] = si;
          tripOriginTime[ti] = t;
        }
        if (seq > tripMaxSeq[ti]) tripMaxSeq[ti] = seq;
        tripNStops[ti]++;

        if (keepAll && !truncated) {
          if (activeSvc && feed.trips.service[ti] >= 0 && !activeSvc[feed.trips.service[ti]]) return;
          if (t < loSec || t > hiSec) return;
          if (kept >= maxRows) { truncated = true; return; }
          const u = feed.unitOfStop[si];
          let b = bucket.get(u);
          if (!b) { b = { t: [], tr: [], sq: [], st: [] }; bucket.set(u, b); }
          b.t.push(t); b.tr.push(ti); b.sq.push(seq); b.st.push(si);
          kept++;
        }
      },
      function (bytes, rows) {
        checkAbort(abort);
        const frac = stTotal ? bytes / stTotal : 0;
        const elapsed = (Date.now() - t0) / 1000;
        const estRows = frac > 0.005 ? Math.round(rows / frac) : 0;
        const eta = frac > 0.02 && frac < 1 ? Math.round(elapsed * (1 - frac) / frac) : -1;
        say({
          phase: 'stop_times', bytes: bytes, total: stTotal, rows: rows,
          estRows: estRows, eta: eta, kept: kept,
          text: 'קורא stop_times.txt'
        });
      });

    if (truncated) {
      feed.warnings.push('הופסקה הקריאה אחרי ' + maxRows.toLocaleString('he-IL') +
        ' עצירות (תקרת זיכרון). צמצם את טווח השעות או עבור למצב "תחנות מוצא בלבד".');
    }

    feed.mode = opts.mode;
    feed.keptRows = kept;
    feed.origins = { stop: tripOriginStop, time: tripOriginTime, seq: tripMinSeq,
      maxSeq: tripMaxSeq, nStops: tripNStops };
    feed.bucket = bucket;
    feed.loadedFilter = keepAll
      ? { day: (opts.day === undefined ? null : opts.day), date: opts.date || null,
          fromHour: opts.fromHour, toHour: opts.toHour }
      : null;
    return feed;
  }

  /** מחזיר Uint8Array של שירותים פעילים, או null אם אין סינון. */
  function buildActiveServices(svc, opts) {
    if (!svc.nServices) return null;
    if (opts.date) {
      const d = opts.date;
      const dow = dateObj(d).getDay();
      const a = new Uint8Array(svc.nServices);
      for (let i = 0; i < svc.nServices; i++) {
        const exc = svc.svcExc.get(i);
        const e = exc ? exc.get(d) : undefined;
        if (e === 2) { a[i] = 0; continue; }
        if (e === 1) { a[i] = 1; continue; }
        const inRange = (!svc.svcStart[i] || svc.svcStart[i] <= d) && (!svc.svcEnd[i] || d <= svc.svcEnd[i]);
        a[i] = inRange && svc.svcDays[i][dow] ? 1 : 0;
      }
      return a;
    }
    if (opts.day === null || opts.day === undefined) return null;
    const a = new Uint8Array(svc.nServices);
    for (let i = 0; i < svc.nServices; i++) a[i] = svc.svcDays[i][opts.day] ? 1 : 0;
    return a;
  }

  /* ==================================================================== */
  /* ניתוח                                                                */
  /* ==================================================================== */

  /**
   * משנה את יחידת הניתוח (רציף / תחנת אם) על פיד שכבר נסרק.
   * מחזיר true אם צריך לקרוא מחדש את stop_times — קורה רק במצב 'all',
   * שבו העצירות כבר מקובצות לפי יחידה בזמן הקריאה.
   */
  function setUnit(feed, unit) {
    if (feed.unit === unit) return false;
    const n = feed.stops.id.length;
    let nParented = 0;
    for (let i = 0; i < n; i++) {
      let u = i;
      if (unit === 'station' && feed.stops.parent[i]) {
        const p = feed.stopIndex.get(feed.stops.parent[i]);
        if (p !== undefined) { u = p; nParented++; }
      }
      feed.unitOfStop[i] = u;
    }
    feed.unit = unit;
    feed.diag.nParented = nParented;
    return feed.mode === 'all';
  }

  function analyzeCompatible(feed, opts) {
    if (!feed || !feed.origins) return 'טרם נקרא stop_times';
    if (feed.mode !== opts.mode) return 'שינוי היקף העצירות (מוצא / כולל ביניים)';
    if (feed.unit !== opts.unit) return 'שינוי יחידת הניתוח (רציף / תחנת אם)';
    const f = feed.loadedFilter;
    if (!f) return null; // מצב 'origins' — הכול נשמר, כל סינון מיידי
    const day = opts.day === undefined ? null : opts.day;
    if ((f.date || null) !== (opts.date || null)) return 'שינוי התאריך';
    if (!opts.date && f.day !== day) return 'שינוי היום בשבוע';
    if (opts.fromHour < f.fromHour || opts.toHour > f.toHour) return 'הרחבת טווח השעות';
    return null;
  }

  function analyze(feed, opts) {
    const active = buildActiveServices(feed.services, opts);
    const lo = opts.fromHour * 3600;
    const hi = opts.toHour * 3600 + 3599;
    const Wo = (opts.winOrigin || 0) * 60;
    const Wm = (opts.winMid || 0) * 60;

    const units = new Map(); // unitIdx → {t:[], tr:[], og:[], st:[], sq:[]}
    const push = function (u, t, tr, og, st, sq) {
      let b = units.get(u);
      if (!b) { b = { t: [], tr: [], og: [], st: [], sq: [] }; units.set(u, b); }
      b.t.push(t); b.tr.push(tr); b.og.push(og); b.st.push(st); b.sq.push(sq);
    };

    if (feed.mode === 'all') {
      feed.bucket.forEach(function (b, u) {
        for (let i = 0; i < b.t.length; i++) {
          const ti = b.tr[i];
          if (active && feed.trips.service[ti] >= 0 && !active[feed.trips.service[ti]]) continue;
          const t = b.t[i];
          if (t < lo || t > hi) continue;
          push(u, t, ti, b.sq[i] === feed.origins.seq[ti] ? 1 : 0, b.st[i], b.sq[i]);
        }
      });
    } else {
      const os = feed.origins.stop, ot = feed.origins.time;
      for (let ti = 0; ti < os.length; ti++) {
        const si = os[ti];
        if (si < 0) continue;
        if (active && feed.trips.service[ti] >= 0 && !active[feed.trips.service[ti]]) continue;
        const t = ot[ti];
        if (t < lo || t > hi) continue;
        push(feed.unitOfStop[si], t, ti, 1, si, feed.origins.seq[ti]);
      }
    }

    const rows = [];
    let totalDep = 0;

    units.forEach(function (b, u) {
      const n = b.t.length;
      totalDep += n;
      const idx = new Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      idx.sort(function (a, c2) { return b.t[a] - b.t[c2]; });
      const T = new Int32Array(n), TR = new Int32Array(n), OG = new Uint8Array(n),
        ST = new Int32Array(n), SQ = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const k = idx[i];
        T[i] = b.t[k]; TR[i] = b.tr[k]; OG[i] = b.og[k]; ST[i] = b.st[k]; SQ[i] = b.sq[k];
      }

      // רמה א' — אותה דקה בדיוק
      let maxExact = 0, exactAt = -1;
      let i = 0;
      while (i < n) {
        const min0 = Math.floor(T[i] / 60);
        let j = i;
        while (j < n && Math.floor(T[j] / 60) === min0) j++;
        if (j - i > maxExact) { maxExact = j - i; exactAt = min0 * 60; }
        i = j;
      }

      const winAll = peakWindow(T, null, n, Wm);
      const oIdx = [];
      for (let k = 0; k < n; k++) if (OG[k]) oIdx.push(k);
      const OT = new Int32Array(oIdx.length);
      for (let k = 0; k < oIdx.length; k++) OT[k] = T[oIdx[k]];
      const winOrg = peakWindow(OT, null, OT.length, Wo);

      rows.push({
        u: u, n: n, nOrigin: oIdx.length,
        maxExact: maxExact, exactAt: exactAt,
        winAll: winAll.max, winAllAt: winAll.at,
        winOrg: winOrg.max, winOrgAt: winOrg.at,
        _T: T, _TR: TR, _OG: OG, _ST: ST, _SQ: SQ
      });
    });

    const minC = opts.minCount || 2;
    const keep = rows.filter(function (r) {
      return r.maxExact >= minC || r.winOrg >= minC || r.winAll >= minC;
    });
    keep.sort(function (a, b) {
      return (b.maxExact - a.maxExact) || (b.winOrg - a.winOrg) || (b.winAll - a.winAll) || (b.n - a.n);
    });

    return { rows: keep, allRows: rows, stats: { units: units.size, departures: totalDep, flagged: keep.length } };
  }

  /** מקסימום מספר יציאות בטווח [t-W, t+W] סביב יציאה כלשהי. T ממוין. */
  function peakWindow(T, _unused, n, W) {
    if (!n) return { max: 0, at: -1 };
    if (W <= 0) {
      let best = 1, at = T[0], i = 0;
      while (i < n) {
        let j = i;
        while (j < n && T[j] === T[i]) j++;
        if (j - i > best) { best = j - i; at = T[i]; }
        i = j;
      }
      return { max: best, at: at };
    }
    let lo = 0, hi = 0, best = 0, at = -1;
    for (let i = 0; i < n; i++) {
      while (T[lo] < T[i] - W) lo++;
      if (hi < i) hi = i;
      while (hi + 1 < n && T[hi + 1] <= T[i] + W) hi++;
      const cnt = hi - lo + 1;
      if (cnt > best) { best = cnt; at = T[i]; }
    }
    return { max: best, at: at };
  }

  /**
   * לוח יציאות יומי לכל קו, מתחנת המוצא, לפי הסינון הנתון (יום שלם).
   * מחזיר Map: routeIdx → Map(direction → [{ t, count, trips:[tripIdx] }])
   * היציאות מקובצות לפי דקה, כך ש-count>1 = כמה אוטובוסים באותה שעה.
   */
  function routeTimetable(feed, opts) {
    if (!feed.origins) return new Map();
    const active = buildActiveServices(feed.services, opts);
    const byRoute = new Map();
    const os = feed.origins.stop, ot = feed.origins.time;
    for (let ti = 0; ti < os.length; ti++) {
      if (os[ti] < 0) continue;
      if (active && feed.trips.service[ti] >= 0 && !active[feed.trips.service[ti]]) continue;
      const ri = feed.trips.route[ti];
      if (ri < 0) continue;
      let dirs = byRoute.get(ri);
      if (!dirs) { dirs = new Map(); byRoute.set(ri, dirs); }
      const d = feed.trips.dir[ti];
      let arr = dirs.get(d);
      if (!arr) { arr = []; dirs.set(d, arr); }
      arr.push({ t: ot[ti], ti: ti });
    }
    byRoute.forEach(function (dirs) {
      dirs.forEach(function (arr, d) {
        arr.sort(function (a, b) { return a.t - b.t; });
        const grouped = [];
        let i = 0;
        while (i < arr.length) {
          const m = Math.floor(arr[i].t / 60);
          let j = i;
          while (j < arr.length && Math.floor(arr[j].t / 60) === m) j++;
          const trips = [];
          for (let k = i; k < j; k++) trips.push(arr[k].ti);
          grouped.push({ t: m * 60, count: j - i, trips: trips });
          i = j;
        }
        dirs.set(d, grouped);
      });
    });
    return byRoute;
  }

  /**
   * בונה אינדקס tripIdx → עצירות מסודרות, מתוך מה שנשמר ב-bucket.
   * זמין רק במצב 'all'. המסלול עשוי להיקטע בקצוות של חלון השעות שנקרא.
   */
  function tripPathIndex(feed) {
    const idx = new Map();
    if (!feed.bucket) return idx;
    feed.bucket.forEach(function (b) {
      for (let i = 0; i < b.t.length; i++) {
        const ti = b.tr[i];
        let arr = idx.get(ti);
        if (!arr) { arr = []; idx.set(ti, arr); }
        arr.push({ st: b.st[i], sq: b.sq[i], t: b.t[i] });
      }
    });
    idx.forEach(function (arr) { arr.sort(function (a, b) { return a.sq - b.sq; }); });
    return idx;
  }

  /** מרחק בין שתי נקודות במטרים (haversine). */
  function distMeters(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const la = a[0] * rad, lb = b[0] * rad;
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * משווה סינון "יום בשבוע" מול תאריכים ספציפיים של אותו יום.
   * מחזיר אזהרה אם צפויה ספירת יתר בגלל ריבוי גרסאות בפיד.
   */
  function dayOverlapWarning(feed, day) {
    const cov = feed.coverage;
    if (!cov || !cov.dates.length) return null;
    const svc = feed.services;
    const byDay = buildActiveServices(svc, { day: day });
    if (!byDay) return null;
    let nDay = 0;
    for (let i = 0; i < byDay.length; i++) nDay += byDay[i];
    const sameDow = cov.dates.filter(function (d) { return d.dow === day; });
    if (!sameDow.length) return null;
    const counts = sameDow.map(function (d) { return d.services; }).sort(function (a, b) { return a - b; });
    const median = counts[Math.floor(counts.length / 2)];
    if (median > 0 && nDay > median * 1.25) {
      return 'סינון לפי יום בשבוע מפעיל ' + nDay.toLocaleString('he-IL') + ' שירותים, לעומת ' +
        median.toLocaleString('he-IL') + ' בתאריך בודד של אותו יום. הפיד מכיל כמה גרסאות לוח זמנים ' +
        'שחופפות באותו יום בשבוע, ולכן אותה נסיעה תיספר יותר מפעם אחת. בחר תאריך מסוים לתוצאה מדויקת.';
    }
    return null;
  }

  global.GTFSCore = {
    readZipEntries: readZipEntries,
    zipEntryStream: zipEntryStream,
    streamCsv: streamCsv,
    splitCsv: splitCsv,
    parseTime: parseTime,
    fmtTime: fmtTime,
    fmtDateHe: fmtDateHe,
    dateObj: dateObj,
    objToStr: objToStr,
    parseStopDesc: parseStopDesc,
    parseLongName: parseLongName,
    routeEnds: routeEnds,
    ARROW: ARROW,
    makeSource: makeSource,
    scanFeed: scanFeed,
    loadStopTimes: loadStopTimes,
    dateCoverage: dateCoverage,
    analyze: analyze,
    analyzeCompatible: analyzeCompatible,
    setUnit: setUnit,
    routeTimetable: routeTimetable,
    tripPathIndex: tripPathIndex,
    distMeters: distMeters,
    fixOverflow: fixOverflow,
    dayOverlapWarning: dayOverlapWarning,
    peakWindow: peakWindow,
    buildActiveServices: buildActiveServices,
    DAY_HE: DAY_HE,
    AbortError: AbortError
  };
})(typeof self !== 'undefined' ? self : globalThis);
