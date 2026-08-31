/* בדיקת ליבה: בונה פיד GTFS סינתטי כ-ZIP אמיתי ומריץ עליו את gtfs-core.js */
import { readFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- ZIP writer מינימלי ---------------- */
function makeZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const raw = enc.encode(text);
    const comp = deflateRawSync(raw);
    const crc = crc32(raw) >>> 0;

    const lh = Buffer.alloc(30 + nameB.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    Buffer.from(nameB).copy(lh, 30);
    locals.push(lh, comp);

    const ch = Buffer.alloc(46 + nameB.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    Buffer.from(nameB).copy(ch, 46);
    central.push(ch);
    offset += lh.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ---------------- פיד סינתטי ---------------- */
// A(1) תחנת מוצא: 3 יציאות ב-07:00:00 בדיוק  → רמה א' = 3
// B(2) תחנת מוצא: 08:00, 08:03, 08:07          → רמה א' = 1, חלון ±4 = 3
// C(3) תחנת ביניים בלבד: 09:00, 09:02, 09:05   → חלון ±2 = 2
// D(4)+E(5) רציפים תחת תחנת אם P(100)          → בדיקת parent_station
// F(6) יציאה ב-25:10 (אחרי חצות)
// שירות WK = א'-ה', שירות SAT = שבת בלבד
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
const routes = [
  'route_id,agency_id,route_short_name,route_long_name,route_desc',
  'r1,1,1,קו 1,10001-1-0',
  'r2,1,2,קו 2,10002-1-0',
  'r3,2,3,קו 3,10003-1-0',
  'r4,2,4,קו 4,10004-1-0',
  'r5,1,5,קו 5,10005-1-0',
  'r6,1,6,קו 6,10006-1-0'
].join('\n');

const calendar = [
  'service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date',
  'WK,1,1,1,1,1,0,0,20260101,20261231',
  'SAT,0,0,0,0,0,0,1,20260101,20261231'
].join('\n');

const calendar_dates = 'service_id,date,exception_type\nWK,20260406,2';

const tripRows = [];
const stRows = [];
function addTrip(id, route, svc, stops2) {
  tripRows.push([id, route, svc, 'יעד ' + id, '0'].join(','));
  stops2.forEach(([stop, time, seq]) => {
    stRows.push([id, time, time, stop, seq].join(','));
  });
}
// A: שלוש יציאות באותה דקה (07:00) — כולן תחנת מוצא ב-1
addTrip('tA1', 'r1', 'WK', [['1', '07:00:00', '1'], ['3', '07:20:00', '2']]);
addTrip('tA2', 'r2', 'WK', [['1', '07:00:00', '1'], ['3', '07:25:00', '2']]);
addTrip('tA3', 'r3', 'WK', [['1', '07:00:30', '1'], ['3', '07:30:00', '2']]);
// A: נסיעה של שבת באותה דקה — לא אמורה להיספר ביום ראשון
addTrip('tA4', 'r4', 'SAT', [['1', '07:00:00', '1']]);
// B: 08:00 / 08:03 / 08:07 — חלון ±4 מגיע ל-3
addTrip('tB1', 'r1', 'WK', [['2', '08:00:00', '1']]);
addTrip('tB2', 'r2', 'WK', [['2', '08:03:00', '1']]);
addTrip('tB3', 'r3', 'WK', [['2', '08:07:00', '1']]);
// C: תחנת ביניים בלבד — 09:00 / 09:02 / 09:05
addTrip('tC1', 'r4', 'WK', [['6', '08:50:00', '1'], ['3', '09:00:00', '2']]);
addTrip('tC2', 'r5', 'WK', [['6', '08:52:00', '1'], ['3', '09:02:00', '2']]);
addTrip('tC3', 'r6', 'WK', [['6', '08:55:00', '1'], ['3', '09:05:00', '2']]);
// D/E: שני רציפים תחת תחנת אם 100, שניהם ב-10:00
addTrip('tD1', 'r1', 'WK', [['4', '10:00:00', '1']]);
addTrip('tE1', 'r2', 'WK', [['5', '10:00:00', '1']]);
// F: אחרי חצות — stop_sequence לא ממוין, המוצא הוא seq=1 ב-6
addTrip('tF1', 'r3', 'WK', [['1', '25:40:00', '5'], ['6', '25:10:00', '1']]);

const trips = ['trip_id,route_id,service_id,trip_headsign,direction_id', ...tripRows].join('\n');
const stop_times = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence', ...stRows].join('\n');

const zipBuf = makeZip({
  'agency.txt': agency, 'stops.txt': stops, 'routes.txt': routes,
  'calendar.txt': calendar, 'calendar_dates.txt': calendar_dates,
  'trips.txt': trips, 'stop_times.txt': stop_times
});

/* ---------------- טעינת הליבה ---------------- */
const ctx = { TextDecoder, TextEncoder, DecompressionStream, setTimeout, console, Date };
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(path.join(here, '..', 'gtfs-core.js'), 'utf8'), ctx);
const Core = ctx.GTFSCore;

const zipFile = new File([zipBuf], 'gtfs.zip');

/* ---------------- הרצה ---------------- */
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  → קיבלתי ' + JSON.stringify(got) + ' במקום ' + JSON.stringify(want)); }
}

const src = await Core.makeSource([zipFile]);
console.log('רשומות ב-ZIP:', src.names.join(', '));

// --- מבחן 1: מצב "כל העצירות", יום ראשון (day=0)
const optsLoad = { mode: 'all', unit: 'platform', day: 0, date: null, fromHour: 0, toHour: 27, maxRows: 1e6 };
const feed = await Core.loadFeed(src, optsLoad);
console.log('\nפיד: ' + feed.nStops + ' תחנות, ' + feed.nTrips + ' נסיעות, ' + feed.keptRows + ' עצירות נשמרו');

const A = Core.analyze(feed, { day: 0, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
const byStop = {};
for (const r of A.allRows) byStop[feed.stops.id[r.u]] = r;

console.log('\nמבחני ניתוח (יום ראשון, כל העצירות, רציף בודד):');
check('תחנה 1 — רמה א׳ = 3 (שתי נסיעות ב-07:00:00 + אחת ב-07:00:30, שבת לא נספרת)', byStop['1'].maxExact, 3);
check('תחנה 1 — סה"כ יציאות = 4 (3 בבוקר + 1 אחרי חצות)', byStop['1'].n, 4);
check('תחנה 1 — כל היציאות הן תחנת מוצא? לא, tF1 עוצרת שם ב-seq 5', byStop['1'].nOrigin, 3);
check('תחנה 2 — רמה א׳ = 1', byStop['2'].maxExact, 1);
check('תחנה 2 — חלון מוצא ±4 = 3', byStop['2'].winOrg, 3);
// 08:00/08:03/08:07 — הפער המינימלי הוא 3 דק', ולכן חלון ±2 אינו תופס אף זוג
check('תחנה 2 — חלון כללי ±2 = 1 (הפערים גדולים מ-2 דק׳)', byStop['2'].winAll, 1);
check('תחנה 3 — אין יציאות מוצא', byStop['3'].nOrigin, 0);
check('תחנה 3 — חלון ביניים ±2 = 2', byStop['3'].winAll, 2);
check('תחנה 3 — חלון מוצא = 0 (אין מוצא)', byStop['3'].winOrg, 0);
check('תחנה 6 — המוצא של tF1 מזוהה למרות seq לא ממוין', byStop['6'].nOrigin, 4);
check('שעה מעל 24:00 נשמרת', Core.fmtTime(feed.origins.time[feed.trips.headsign.indexOf('יעד tF1')]), '25:10');

// --- מבחן 2: קיבוץ לפי תחנת אם
const feedSt = await Core.loadFeed(src, Object.assign({}, optsLoad, { unit: 'station' }));
const Ast = Core.analyze(feedSt, { day: 0, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
const stMap = {};
for (const r of Ast.allRows) stMap[feedSt.stops.id[r.u]] = r;
console.log('\nמבחני קיבוץ לפי תחנת אם:');
check('רציפים 4+5 מתמזגים לתחנה 100', stMap['100'] ? stMap['100'].maxExact : null, 2);
check('רציף 4 כבר לא מופיע בנפרד', stMap['4'] === undefined, true);
console.log('  ‣ בלי קיבוץ, רציף 4 לבדו: רמה א׳ =', byStop['4'].maxExact, '(כצפוי 1)');
check('בלי קיבוץ רציף 4 = 1', byStop['4'].maxExact, 1);

// --- מבחן 3: יום שבת
console.log('\nמבחן סינון יום:');
check('ניתוח שבת על פיד שנטען לראשון מסומן כלא־תואם',
  Core.analyzeCompatible(feed, { mode: 'all', unit: 'platform', day: 6, fromHour: 0, toHour: 27 }), 'שינוי היום בשבוע');
check('ניתוח ראשון על אותו פיד — תואם',
  Core.analyzeCompatible(feed, { mode: 'all', unit: 'platform', day: 0, fromHour: 7, toHour: 20 }), null);
const feedSat = await Core.loadFeed(src, Object.assign({}, optsLoad, { day: 6 }));
const Asat = Core.analyze(feedSat, { day: 6, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 1 });
const satStop1 = Asat.allRows.find(r => feedSat.stops.id[r.u] === '1');
check('בשבת יש רק יציאה אחת מתחנה 1', satStop1 ? satStop1.n : 0, 1);
check('במצב "מוצא בלבד" אין צורך בטעינה מחדש לשום יום',
  Core.analyzeCompatible(await Core.loadFeed(src, Object.assign({}, optsLoad, { mode: 'origins' })),
    { mode: 'origins', unit: 'platform', day: 6, fromHour: 0, toHour: 27 }), null);

// --- מבחן 4: מצב "תחנות מוצא בלבד"
const feedO = await Core.loadFeed(src, Object.assign({}, optsLoad, { mode: 'origins' }));
const Ao = Core.analyze(feedO, { day: 0, fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 2 });
const oMap = {};
for (const r of Ao.allRows) oMap[feedO.stops.id[r.u]] = r;
console.log('\nמבחני מצב "תחנות מוצא בלבד":');
check('תחנה 1 — רמה א׳ = 3 גם במצב מוצא', oMap['1'].maxExact, 3);
check('תחנה 1 — סופרת רק 3 יציאות מוצא (בלי המעבר ב-25:40)', oMap['1'].n, 3);
check('תחנה 3 — לא מופיעה כלל (אין ממנה יציאות מוצא)', oMap['3'] === undefined, true);
check('תחנה 2 — חלון מוצא ±4 = 3', oMap['2'].winOrg, 3);

// --- מבחן 5: טווח שעות
const Ahr = Core.analyze(feed, { day: 0, fromHour: 8, toHour: 8, winOrigin: 4, winMid: 2, minCount: 1 });
const hrMap = {};
for (const r of Ahr.allRows) hrMap[feed.stops.id[r.u]] = r;
console.log('\nמבחן טווח שעות (08:00–08:59):');
// תחנה 6 פעילה גם היא: יציאות המוצא של tC1/tC2/tC3 הן ב-08:50/08:52/08:55
check('תחנות 2 ו-6 פעילות בלבד', Object.keys(hrMap).sort(), ['2', '6']);
check('3 יציאות מתחנה 2', hrMap['2'].n, 3);
// מרכז 08:52 → חלון [08:48, 08:56] תופס את שלוש היציאות
check('תחנה 6 — חלון מוצא ±4 = 3 (08:50 / 08:52 / 08:55)', hrMap['6'].winOrg, 3);
check('תחנה 6 — חלון כללי ±2 = 2 (08:50 ו-08:52)', hrMap['6'].winAll, 2);

// --- מבחן 6: חריגת calendar_dates לפי תאריך
const Aexc = Core.analyze(feed, { date: '20260406', fromHour: 0, toHour: 27, winOrigin: 4, winMid: 2, minCount: 1 });
console.log('\nמבחן calendar_dates (6/4/2026 — WK מבוטל, יום שני):');
check('אין אף יציאה', Aexc.stats.departures, 0);

// --- מבחן 7: peakWindow ישירות
console.log('\nמבחני peakWindow:');
check('[0,120,240,360] עם W=120 → 3', Core.peakWindow(Int32Array.from([0, 120, 240, 360]), null, 4, 120).max, 3);
check('[0,600] עם W=120 → 1', Core.peakWindow(Int32Array.from([0, 600]), null, 2, 120).max, 1);
check('ריק → 0', Core.peakWindow(Int32Array.from([]), null, 0, 120).max, 0);
check('W=0 סופר זהות מדויקת', Core.peakWindow(Int32Array.from([5, 5, 5, 9]), null, 4, 0).max, 3);

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + pass + ' עברו, ' + fail + ' נכשלו');
process.exit(fail ? 1 : 0);
