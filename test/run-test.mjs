/* בדיקת ליבה: בונה פידים סינתטיים כ-ZIP אמיתי ומריץ עליהם את gtfs-core.js */
import { readFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- ZIP writer מינימלי ---------------- */
function makeZip(files) {
  const enc = new TextEncoder();
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name), raw = enc.encode(text);
    const comp = deflateRawSync(raw), crc = crc32(raw) >>> 0;
    const lh = Buffer.alloc(30 + nameB.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameB.length, 26); Buffer.from(nameB).copy(lh, 30);
    locals.push(lh, comp);
    const ch = Buffer.alloc(46 + nameB.length);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    Buffer.from(nameB).copy(ch, 46);
    central.push(ch); offset += lh.length + comp.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ---------------- טעינת הליבה ---------------- */
const ctx = { TextDecoder, TextEncoder, DecompressionStream, setTimeout, console, Date };
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(path.join(here, '..', 'gtfs-core.js'), 'utf8'), ctx);
const Core = ctx.GTFSCore;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  → קיבלתי ' + JSON.stringify(got) + ' במקום ' + JSON.stringify(want)); }
}
const load = async (zip, opts) => {
  const src = await Core.makeSource([new File([zip], 'gtfs.zip')]);
  const feed = await Core.scanFeed(src, { unit: opts.unit || 'platform' });
  await Core.loadStopTimes(src, feed, opts);
  return { src, feed };
};
const byStopOf = (feed, res) => {
  const m = {};
  for (const r of res.allRows) m[feed.stops.id[r.u]] = r;
  return m;
};

/* ==================================================================== */
/* פיד א' — קלאסי, עם דגלי ימי שבוע ב-calendar.txt                       */
/* ==================================================================== */
const stops = [
  'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,location_type,parent_station,zone_id',
  '1,11111,"תחנה א","רחוב: הרצל 1 עיר: תל אביב רציף:  קומה: ",32.10,34.80,0,,11111',
  '2,22222,"תחנה ב","רחוב: ויצמן 2 עיר: חיפה רציף:  קומה: ",32.80,34.99,0,,22222',
  '3,33333,"תחנה ג","רחוב: בגין 3 עיר: ירושלים רציף:  קומה: ",31.78,35.21,0,,33333',
  '4,44444,"מסוף רציף 1","רחוב: המסוף עיר: באר שבע רציף: 1 קומה: ",31.25,34.79,0,100,44444',
  '5,55555,"מסוף רציף 2","רחוב: המסוף עיר: באר שבע רציף: 2 קומה: ",31.25,34.79,0,100,55555',
  '6,66666,"תחנה ו","רחוב: לילה 6 עיר: אילת רציף:  קומה: ",29.55,34.95,0,,66666',
  '100,10000,"מסוף מרכזי","רחוב: המסוף עיר: באר שבע רציף:  קומה: ",31.25,34.79,1,,10000'
].join('\n');
const agency = 'agency_id,agency_name\n1,אגד\n2,דן';
const routes = ['route_id,agency_id,route_short_name,route_long_name,route_desc',
  'r1,1,1,קו 1,10001-1-0', 'r2,1,2,קו 2,10002-1-0', 'r3,2,3,קו 3,10003-1-0',
  'r4,2,4,קו 4,10004-1-0', 'r5,1,5,קו 5,10005-1-0', 'r6,1,6,קו 6,10006-1-0'].join('\n');
const calendar = ['service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date',
  'WK,1,1,1,1,1,0,0,20260101,20260131',
  'SAT,0,0,0,0,0,0,1,20260101,20260131'].join('\n');

const tripRows = [], stRows = [];
function addTrip(id, route, svc, list) {
  tripRows.push([id, route, svc, 'יעד ' + id, '0'].join(','));
  list.forEach(([stop, time, seq]) => stRows.push([id, time, time, stop, seq].join(',')));
}
addTrip('tA1', 'r1', 'WK', [['1', '07:00:00', '1'], ['3', '07:20:00', '2']]);
addTrip('tA2', 'r2', 'WK', [['1', '07:00:00', '1'], ['3', '07:25:00', '2']]);
addTrip('tA3', 'r3', 'WK', [['1', '07:00:30', '1'], ['3', '07:30:00', '2']]);
addTrip('tA4', 'r4', 'SAT', [['1', '07:00:00', '1']]);
addTrip('tB1', 'r1', 'WK', [['2', '08:00:00', '1']]);
addTrip('tB2', 'r2', 'WK', [['2', '08:03:00', '1']]);
addTrip('tB3', 'r3', 'WK', [['2', '08:07:00', '1']]);
addTrip('tC1', 'r4', 'WK', [['6', '08:50:00', '1'], ['3', '09:00:00', '2']]);
addTrip('tC2', 'r5', 'WK', [['6', '08:52:00', '1'], ['3', '09:02:00', '2']]);
addTrip('tC3', 'r6', 'WK', [['6', '08:55:00', '1'], ['3', '09:05:00', '2']]);
addTrip('tD1', 'r1', 'WK', [['4', '10:00:00', '1']]);
addTrip('tE1', 'r2', 'WK', [['5', '10:00:00', '1']]);
addTrip('tF1', 'r3', 'WK', [['1', '25:40:00', '5'], ['6', '25:10:00', '1']]);

const zipA = makeZip({
  'agency.txt': agency, 'stops.txt': stops, 'routes.txt': routes, 'calendar.txt': calendar,
  'calendar_dates.txt': 'service_id,date,exception_type\nWK,20260106,2',
  'trips.txt': ['trip_id,route_id,service_id,trip_headsign,direction_id', ...tripRows].join('\n'),
  'stop_times.txt': ['trip_id,arrival_time,departure_time,stop_id,stop_sequence', ...stRows].join('\n')
});

console.log('=== פיד א׳: calendar.txt עם דגלי ימים ===');
// 2026-01-04 הוא יום ראשון
const base = { mode: 'all', unit: 'platform', day: 0, date: null, fromHour: 0, toHour: 27, maxRows: 1e6 };
const A = await load(zipA, base);
const rA = Core.analyze(A.feed, { day: 0, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
const sA = byStopOf(A.feed, rA);

check('תחנה 1 — רמה א׳ = 3', sA['1'].maxExact, 3);
check('תחנה 1 — סה"כ 4 יציאות', sA['1'].n, 4);
check('תחנה 1 — 3 מהן מוצא', sA['1'].nOrigin, 3);
check('תחנה 2 — חלון מוצא ±4 = 3', sA['2'].winOrg, 3);
check('תחנה 2 — חלון כללי ±2 = 1', sA['2'].winAll, 1);
check('תחנה 3 — חלון ביניים ±2 = 2', sA['3'].winAll, 2);
check('תחנה 3 — אין יציאות מוצא', sA['3'].nOrigin, 0);
check('תחנה 6 — מוצא מזוהה גם ב-seq לא ממוין', sA['6'].nOrigin, 4);

console.log('\n--- מעקב אחרי תחנת המקור של כל יציאה (_ST) ---');
check('כל יציאה יודעת מאיזה stop_id היא יצאה',
  [...new Set(Array.from(sA['1']._ST))].map(i => A.feed.stops.id[i]), ['1']);

console.log('\n--- קיבוץ לפי תחנת אם ---');
const Ast = await load(zipA, { ...base, unit: 'station' });
const rAst = Core.analyze(Ast.feed, { day: 0, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
const sAst = byStopOf(Ast.feed, rAst);
check('רציפים 4+5 מתמזגים לתחנה 100', sAst['100'].maxExact, 2);
check('רציף 4 לא מופיע בנפרד', sAst['4'] === undefined, true);
check('שתי היציאות המאוחדות מגיעות משני רציפים שונים',
  [...new Set(Array.from(sAst['100']._ST))].map(i => Ast.feed.stops.id[i]).sort(), ['4', '5']);

console.log('\n--- טווח תאריכים ---');
check('טווח הפיד זוהה', [A.feed.coverage.min, A.feed.coverage.max], ['20260101', '20260131']);
const jan4 = A.feed.coverage.dates.find(d => d.date === '20260104'); // ראשון
const jan5 = A.feed.coverage.dates.find(d => d.date === '20260105'); // שני
const jan6 = A.feed.coverage.dates.find(d => d.date === '20260106'); // שלישי — WK מבוטל
const jan3 = A.feed.coverage.dates.find(d => d.date === '20260103'); // שבת
check('יום ראשון 04/01 — 12 נסיעות WK', jan4 ? jan4.trips : null, 12);
check('יום שלישי 06/01 מבוטל ולכן לא ברשימה', jan6, undefined);
check('שבת 03/01 — נסיעה אחת', jan3 ? jan3.trips : null, 1);
check('כל תאריך יודע את יום השבוע שלו', jan5 ? jan5.dow : null, 1);

console.log('\n--- ניתוח לפי תאריך מסוים ---');
const Ad = await load(zipA, { ...base, day: null, date: '20260104' });
const rAd = Core.analyze(Ad.feed, { date: '20260104', fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
check('04/01 (ראשון) מחזיר אותה תוצאה כמו יום ראשון', byStopOf(Ad.feed, rAd)['1'].maxExact, 3);
const Aexc = await load(zipA, { ...base, day: null, date: '20260106' });
const rAexc = Core.analyze(Aexc.feed, { date: '20260106', fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
check('06/01 מבוטל ב-calendar_dates — אפס יציאות', rAexc.stats.departures, 0);

/* ==================================================================== */
/* פיד ב' — סגנון "Gtfs_10_days": calendar ללא דגלי ימים                 */
/* ==================================================================== */
const cal10 = ['service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date',
  'S1,0,0,0,0,0,0,0,20260901,20260910',
  'S2,0,0,0,0,0,0,0,20260901,20260910'].join('\n');
const dates10 = ['service_id,date,exception_type',
  'S1,20260901,1', 'S1,20260902,1', 'S1,20260903,1',
  'S2,20260902,1', 'S2,20260903,1', 'S2,20260904,1'].join('\n');
const t10 = [], st10 = [];
function addTrip10(id, svc, stop, time) {
  t10.push([id, 'r1', svc, 'יעד', '0'].join(','));
  st10.push([id, time, time, stop, 1].join(','));
}
// שלוש יציאות באותה דקה מתחנה 1 בשירות S1
addTrip10('x1', 'S1', '1', '06:00:00');
addTrip10('x2', 'S1', '1', '06:00:00');
addTrip10('x3', 'S1', '1', '06:00:00');
// שתיים בשירות S2 מאותה תחנה, גם ב-06:00
addTrip10('y1', 'S2', '1', '06:00:00');
addTrip10('y2', 'S2', '1', '06:00:00');

const zipB = makeZip({
  'agency.txt': agency, 'stops.txt': stops, 'routes.txt': routes,
  'calendar.txt': cal10, 'calendar_dates.txt': dates10,
  'trips.txt': ['trip_id,route_id,service_id,trip_headsign,direction_id', ...t10].join('\n'),
  'stop_times.txt': ['trip_id,arrival_time,departure_time,stop_id,stop_sequence', ...st10].join('\n')
});

console.log('\n=== פיד ב׳: סגנון Gtfs_10_days (calendar_dates בלבד) ===');
const srcB = await Core.makeSource([new File([zipB], 'g10.zip')]);
const feedB = await Core.scanFeed(srcB, { unit: 'platform' });
check('נקלטו 2 שירותים', feedB.nServices, 2);
check('אף שירות אינו מסומן בימי שבוע', feedB.diag.nServicesWithDayFlags, 0);
check('נוצרה אזהרה שמסבירה למה סינון יום בשבוע ייכשל',
  feedB.warnings.some(w => w.includes('calendar_dates')), true);
check('טווח התאריכים זוהה', [feedB.coverage.min, feedB.coverage.max], ['20260901', '20260910']);
check('4 תאריכים עם שירות', feedB.coverage.dates.map(d => d.date), ['20260901', '20260902', '20260903', '20260904']);
check('01/09 — רק S1 פעיל (3 נסיעות)', feedB.coverage.dates[0].trips, 3);
check('02/09 — שני השירותים (5 נסיעות)', feedB.coverage.dates[1].trips, 5);
check('04/09 — רק S2 (2 נסיעות)', feedB.coverage.dates[3].trips, 2);

await Core.loadStopTimes(srcB, feedB, { mode: 'origins', fromHour: 0, toHour: 27 });

console.log('\n--- זהו הבאג המקורי: סינון לפי יום בשבוע ---');
const dowRes = Core.analyze(feedB, { day: 2, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
check('סינון "יום שלישי" מחזיר אפס — בדיוק התסמין שדווח', dowRes.stats.departures, 0);

console.log('\n--- והתיקון: סינון לפי תאריך ---');
const d1 = Core.analyze(feedB, { date: '20260901', fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
check('01/09 מוצא 3 יציאות באותה דקה', byStopOf(feedB, d1)['1'].maxExact, 3);
const d2 = Core.analyze(feedB, { date: '20260902', fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
check('02/09 מוצא 5 (שני השירותים פעילים באמת)', byStopOf(feedB, d2)['1'].maxExact, 5);
const d4 = Core.analyze(feedB, { date: '20260904', fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
check('04/09 מוצא 2', byStopOf(feedB, d4)['1'].maxExact, 2);

/* ==================================================================== */
/* פיד ג' — ספירת יתר בסינון יום בשבוע (ריבוי גרסאות)                    */
/* ==================================================================== */
const calMulti = ['service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date',
  'V1,1,1,1,1,1,0,0,20260901,20260907',
  'V2,1,1,1,1,1,0,0,20260908,20260914'].join('\n');
const tM = [], stM = [];
for (const [id, svc] of [['m1', 'V1'], ['m2', 'V1'], ['m3', 'V2'], ['m4', 'V2']]) {
  tM.push([id, 'r1', svc, 'יעד', '0'].join(','));
  stM.push([id, '06:00:00', '06:00:00', '1', 1].join(','));
}
const zipC = makeZip({
  'agency.txt': agency, 'stops.txt': stops, 'routes.txt': routes, 'calendar.txt': calMulti,
  'trips.txt': ['trip_id,route_id,service_id,trip_headsign,direction_id', ...tM].join('\n'),
  'stop_times.txt': ['trip_id,arrival_time,departure_time,stop_id,stop_sequence', ...stM].join('\n')
});

console.log('\n=== פיד ג׳: שתי גרסאות לוח זמנים חופפות באותו יום בשבוע ===');
const srcC = await Core.makeSource([new File([zipC], 'multi.zip')]);
const feedC = await Core.scanFeed(srcC, { unit: 'platform' });
await Core.loadStopTimes(srcC, feedC, { mode: 'origins', fromHour: 0, toHour: 27 });
const cDow = Core.analyze(feedC, { day: 1, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
const cDate = Core.analyze(feedC, { date: '20260907', fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
check('סינון "יום שני" סופר 4 — ספירת יתר, שתי הגרסאות יחד', byStopOf(feedC, cDow)['1'].maxExact, 4);
check('סינון 07/09 סופר 2 — הנכון', byStopOf(feedC, cDate)['1'].maxExact, 2);
const warnMulti = Core.dayOverlapWarning(feedC, 1);
check('הכלי מתריע מראש על ספירת היתר', !!warnMulti && warnMulti.includes('יותר מפעם אחת'), true);
check('אין התרעה כשאין חפיפה (פיד א׳)', Core.dayOverlapWarning(A.feed, 0), null);

/* ==================================================================== */
/* ביטול פעולה                                                          */
/* ==================================================================== */
console.log('\n=== ביטול פעולה ===');
let aborted = false;
try {
  const srcAb = await Core.makeSource([new File([zipA], 'gtfs.zip')]);
  await Core.scanFeed(srcAb, { unit: 'platform' }, null, () => true);
} catch (e) { aborted = !!e.aborted; }
check('scanFeed נעצר כשמבקשים ביטול', aborted, true);

/* ==================================================================== */
/* תאימות ניתוח ו-peakWindow                                            */
/* ==================================================================== */
console.log('\n=== תאימות ו-peakWindow ===');
check('שינוי מצב מחייב קריאה חוזרת',
  Core.analyzeCompatible(A.feed, { mode: 'origins', unit: 'platform', day: 0, fromHour: 0, toHour: 27 }),
  'שינוי היקף העצירות (מוצא / כולל ביניים)');
check('אותן הגדרות — תואם',
  Core.analyzeCompatible(A.feed, { mode: 'all', unit: 'platform', day: 0, fromHour: 7, toHour: 20 }), null);
check('במצב מוצא כל תאריך מיידי',
  Core.analyzeCompatible(feedB, { mode: 'origins', unit: 'platform', date: '20260903', fromHour: 0, toHour: 27 }), null);
check('[0,120,240,360] W=120 → 3', Core.peakWindow(Int32Array.from([0, 120, 240, 360]), null, 4, 120).max, 3);
check('[0,600] W=120 → 1', Core.peakWindow(Int32Array.from([0, 600]), null, 2, 120).max, 1);
check('ריק → 0', Core.peakWindow(Int32Array.from([]), null, 0, 120).max, 0);
check('W=0 סופר זהות מדויקת', Core.peakWindow(Int32Array.from([5, 5, 5, 9]), null, 4, 0).max, 3);
check('fmtDateHe', Core.fmtDateHe('20260901'), '01/09/2026');

/* ==================================================================== */
/* שינוי יחידת ניתוח על פיד שכבר נסרק                                    */
/* ==================================================================== */
console.log('\n=== החלפת יחידת ניתוח אחרי סריקה ===');
{
  const src = await Core.makeSource([new File([zipA], 'gtfs.zip')]);
  const feed = await Core.scanFeed(src, { unit: 'platform' });
  await Core.loadStopTimes(src, feed, { mode: 'origins', fromHour: 0, toHour: 27 });
  const asPlat = byStopOf(feed, Core.analyze(feed,
    { day: 0, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 }));
  check('לפני ההחלפה — רציף 4 עומד בפני עצמו', asPlat['4'].maxExact, 1);

  const needsReload = Core.setUnit(feed, 'station');
  check('במצב מוצא אין צורך בקריאה חוזרת', needsReload, false);
  check('feed.unit התעדכן', feed.unit, 'station');
  const asStation = byStopOf(feed, Core.analyze(feed,
    { day: 0, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 }));
  check('אחרי ההחלפה — רציפים 4+5 מאוחדים לתחנה 100', asStation['100'].maxExact, 2);
  check('רציף 4 כבר לא נפרד', asStation['4'] === undefined, true);
  check('setUnit לאותה יחידה לא עושה כלום', Core.setUnit(feed, 'station'), false);

  // במצב 'all' חובה קריאה חוזרת כי הדליים מקובצים לפי יחידה
  const feed2 = await Core.scanFeed(src, { unit: 'platform' });
  await Core.loadStopTimes(src, feed2, { mode: 'all', day: 0, fromHour: 0, toHour: 27, maxRows: 1e6 });
  check('במצב "כולל ביניים" נדרשת קריאה חוזרת', Core.setUnit(feed2, 'station'), true);
}

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + pass + ' עברו, ' + fail + ' נכשלו');
process.exit(fail ? 1 : 0);
