/* מייצר קובץ GTFS.zip לדוגמה לבדיקת הממשק */
import { writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

function makeZip(files) {
  const enc = new TextEncoder(); const locals = []; const central = []; let offset = 0;
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
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// מחולל פסאודו-אקראי דטרמיניסטי (mulberry32)
let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0; seed = seed + 0x6d2b79f5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const pick = a => a[Math.floor(rnd() * a.length)];

const BIG = process.argv.includes('big');
const N_TRIPS = BIG ? 45000 : 6000;
const N_STOPS = BIG ? 3000 : 400;

const cities = ['תל אביב', 'חיפה', 'ירושלים', 'באר שבע', 'נתניה', 'רחובות', 'כפר סבא', 'רעננה'];
const streets = ['הרצל', 'ויצמן', 'בן גוריון', 'רוטשילד', 'ז׳בוטינסקי', 'אלנבי', 'הנשיא', 'סוקולוב'];
const agencies = [['1', 'אגד'], ['2', 'דן'], ['3', 'קווים'], ['4', 'מטרופולין'], ['5', 'סופרבוס']];

const stopRows = ['stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,location_type,parent_station,zone_id'];
const stops = [];
// 6 מסופים מרכזיים עם רציפים (parent_station)
let sid = 1;
const terminals = [];
for (let k = 0; k < 6; k++) {
  const city = cities[k % cities.length];
  const pid = 9000 + k;
  stopRows.push([pid, 90000 + k, `"ת. מרכזית ${city}"`,
    `"רחוב: המסוף עיר: ${city} רציף:  קומה: "`, (31 + rnd()).toFixed(6), (34.7 + rnd() * .5).toFixed(6), 1, '', 90000 + k].join(','));
  const plats = [];
  const nPlat = 3 + Math.floor(rnd() * 4);
  for (let p = 1; p <= nPlat; p++) {
    const id = sid++;
    stopRows.push([id, 10000 + id, `"ת. מרכזית ${city}"`,
      `"רחוב: המסוף עיר: ${city} רציף: ${p} קומה: "`, (31 + rnd()).toFixed(6), (34.7 + rnd() * .5).toFixed(6), 0, pid, 10000 + id].join(','));
    plats.push(String(id));
    stops.push(String(id));
  }
  terminals.push(plats);
}
// 400 תחנות רגילות
for (let i = 0; i < N_STOPS; i++) {
  const id = sid++;
  const city = pick(cities), st = pick(streets);
  stopRows.push([id, 10000 + id, `"${st}/${pick(streets)}"`,
    `"רחוב: ${st} ${1 + Math.floor(rnd() * 90)} עיר: ${city} רציף:  קומה: "`,
    (31 + rnd()).toFixed(6), (34.7 + rnd() * .5).toFixed(6), 0, '', 10000 + id].join(','));
  stops.push(String(id));
}

const routeRows = ['route_id,agency_id,route_short_name,route_long_name,route_desc,route_type'];
const routes = [];
for (let i = 1; i <= 260; i++) {
  const ag = pick(agencies);
  const rid = 'r' + i;
  const num = 1 + Math.floor(rnd() * 900);
  routeRows.push([rid, ag[0], num, `"${pick(cities)}-${pick(cities)}"`, `${20000 + i}-1-#`, 3].join(','));
  routes.push(rid);
}

// טווח קצר של שבועיים, כדי שרשימת התאריכים בממשק תהיה קריאה
const calendar = ['service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date',
  'WK,1,1,1,1,1,0,0,20260831,20260913',
  'FRI,0,0,0,0,0,1,0,20260831,20260913',
  'SAT,0,0,0,0,0,0,1,20260831,20260913'].join('\n');

const tripRows = ['trip_id,route_id,service_id,trip_headsign,direction_id'];
const stRows = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence'];
const hh = n => String(Math.floor(n / 3600)).padStart(2, '0') + ':' +
  String(Math.floor(n % 3600 / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

let tn = 0;
function addTrip(route, svc, originStop, startSec, nStops) {
  const id = 't' + (++tn);
  tripRows.push([id, route, svc, `"${pick(cities)}"`, Math.floor(rnd() * 2)].join(','));
  let t = startSec;
  stRows.push([id, hh(t), hh(t), originStop, 1].join(','));
  for (let s = 2; s <= nStops; s++) {
    t += 60 + Math.floor(rnd() * 180);
    stRows.push([id, hh(t), hh(t), pick(stops), s].join(','));
  }
}

// תנועה רגילה
for (let i = 0; i < N_TRIPS; i++) {
  const start = 5 * 3600 + Math.floor(rnd() * 19 * 3600);
  addTrip(pick(routes), rnd() < .8 ? 'WK' : (rnd() < .5 ? 'FRI' : 'SAT'),
    pick(stops), Math.floor(start / 60) * 60, 8 + Math.floor(rnd() * 20));
}
// עומסים מכוונים במסופים: הרבה יציאות באותה דקה מאותו רציף
terminals.forEach((plats, k) => {
  const plat = plats[0];
  [7 * 3600, 7 * 3600 + 30 * 60, 8 * 3600, 15 * 3600 + 45 * 60, 16 * 3600].forEach((base, j) => {
    const n = 2 + ((k + j) % 5);           // 2..6 יציאות באותה דקה
    for (let i = 0; i < n; i++) addTrip(pick(routes), 'WK', plat, base, 10);
    // וגם צביר בחלון ±4 דק'
    [-3, -1, 2, 4].forEach(off => addTrip(pick(routes), 'WK', plats[1] || plat, base + off * 60, 10));
  });
});
// אחרי חצות
for (let i = 0; i < 120; i++) {
  addTrip(pick(routes), 'WK', pick(stops), 24 * 3600 + Math.floor(rnd() * 3 * 3600 / 60) * 60, 6);
}

const zip = makeZip({
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\n' +
    agencies.map(a => `${a[0]},${a[1]},https://example.org,Asia/Jerusalem`).join('\n'),
  'stops.txt': stopRows.join('\n'),
  'routes.txt': routeRows.join('\n'),
  'calendar.txt': calendar,
  'calendar_dates.txt': 'service_id,date,exception_type\nWK,20260907,2\nSAT,20260907,1',
  'trips.txt': tripRows.join('\n'),
  'stop_times.txt': stRows.join('\n')
});
const out = path.join(here, BIG ? 'sample-gtfs-big.zip' : 'sample-gtfs.zip');
writeFileSync(out, zip);
console.log('נוצר ' + out + ' — ' + (zip.length / 1024).toFixed(0) + ' KB, ' +
  tn + ' נסיעות, ' + (stRows.length - 1) + ' עצירות, ' + (stopRows.length - 1) + ' תחנות');
