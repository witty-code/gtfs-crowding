/* בדיקת ממשק מקצה לקצה בדפדפן אמיתי */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.zip': 'application/zip',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  try {
    const buf = await readFile(p === path.join(root, '/') ? path.join(root, 'index.html') : p);
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(8099, r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
// אריחי OSM אינם נגישים מסביבת הבדיקה (חסימת egress), ולכן מגישים אריח מקומי
// במקומם. כך המפה מתרנדרת באמת ואין רעש של שגיאות רשת בקונסול.
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
await page.route('**tile.openstreetmap.org/**', r =>
  r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));

let fail = 0;
const ok = (n, c) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) fail++; };

await page.goto('http://localhost:8099/index.html');
await page.setInputFiles('#file', path.join(root, 'test/sample-gtfs.zip'));
await page.waitForSelector('#fileInfo.ok');

/* ---------- שלב 1: סריקה ---------- */
console.log('=== שלב סריקת הפיד ===');
await page.click('#scan');
await page.waitForSelector('#feedInfo.on', { timeout: 120000 });
const kv = await page.$$eval('#feedKv div', els =>
  els.map(e => e.querySelector('span').textContent + ': ' + e.querySelector('b').textContent));
console.log(kv.map(s => '  ' + s).join('\n'));
ok('פאנל פרטי הפיד הוצג', kv.length > 5);
ok('טווח התאריכים זוהה', kv.some(s => s.startsWith('טווח תאריכים') && s.includes('2026')));

const dates = await page.$$eval('#dateSel option', els => els.map(e => ({ v: e.value, t: e.textContent })));
console.log('  תאריכים ברשימה: ' + dates.length + ' — ראשון: ' + dates[0].t.trim());
ok('רשימת התאריכים מולאה מהפיד', dates.length >= 10 && dates.every(d => /^\d{8}$/.test(d.v)));
ok('כל תאריך מציג יום ומספר נסיעות', /יום \S+\s+·\s+[\d,]+ נסיעות/.test(dates[0].t));

// 07/09/2026 הוא יום שני שבו calendar_dates מבטל את WK ומוסיף את SAT,
// ולכן הוא חייב להציג הרבה פחות נסיעות מיום שני רגיל.
const tripsOf = t => parseInt((t.match(/([\d,]+) נסיעות/) || [0, '0'])[1].replace(/,/g, ''), 10);
const d0709 = dates.find(d => d.v === '20260907');
const normalMon = dates.find(d => d.v === '20260831');
console.log('  07/09 (WK מבוטל): ' + (d0709 ? tripsOf(d0709.t) : '—') +
  ' נסיעות · יום שני רגיל 31/08: ' + tripsOf(normalMon.t) + ' נסיעות');
ok('calendar_dates משפיע: 07/09 עם הרבה פחות נסיעות מיום שני רגיל',
  !!d0709 && tripsOf(d0709.t) > 0 && tripsOf(d0709.t) < tripsOf(normalMon.t) / 3);
ok('ברירת המחדל היא סינון לפי תאריך', await page.inputValue('#filterBy') === 'date');

/* ---------- שלב 2: ניתוח לפי תאריך ---------- */
console.log('\n=== ניתוח לפי תאריך ===');
const chosen = await page.inputValue('#dateSel');
console.log('  תאריך שנבחר אוטומטית: ' + chosen);
await page.selectOption('#mode', 'origins');
await page.selectOption('#fromHour', '6');
await page.selectOption('#toHour', '9');
await page.click('#run');
await page.waitForFunction(() => document.querySelectorAll('#tbody tr').length > 0, { timeout: 120000 });

const cards = await page.$$eval('#cards .card', els =>
  els.map(e => e.querySelector('span').textContent + ': ' + e.querySelector('b').textContent));
console.log('  ' + cards.join(' | '));
const when = await page.textContent('#resultWhen');
console.log('  כותרת התוצאות: ' + when);
ok('נמצאו תחנות חריגות', (await page.$$eval('#tbody tr', e => e.length)) > 0);
ok('התאריך הלועזי מוצג בכותרת התוצאות', /\d{2}\/\d{2}\/\d{4}/.test(when));
ok('התחנה המובילה היא רמה א׳',
  (await page.textContent('#tbody tr:first-child td:first-child')).includes('רמה א'));

/* ---------- שלב 3: מגירת פירוט מקובצת ---------- */
console.log('\n=== מגירת פירוט ===');
await page.click('#tbody tr:first-child td.name');
await page.waitForSelector('#drawer.open');
await page.waitForTimeout(400);
const dSub = await page.textContent('#dSub');
console.log('  כותרת משנה: ' + dSub.replace(/\s+/g, ' '));
ok('התאריך הלועזי מופיע במגירה', /\d{2}\/\d{2}\/\d{4}/.test(dSub));

const groups = await page.$$eval('.mingrp', els => els.map(e => ({
  time: e.querySelector('.hd .t').textContent,
  head: e.querySelector('.hd').innerText.replace(/\s+/g, ' ').trim(),
  rows: e.querySelectorAll('tbody tr').length,
  cls: e.className
})));
console.log('  קבוצות דקה: ' + groups.length);
groups.slice(0, 3).forEach(g => console.log('    ' + g.head + '  → ' + g.rows + ' שורות'));
ok('היציאות מקובצות לפי דקה', groups.length > 0);
ok('כל קבוצה מציגה את מספר היציאות', groups.every(g => /\d+ יציאות/.test(g.head)));
ok('קבוצות עם חפיפה מסומנות ברמה א׳', groups.some(g => g.cls.includes('lvA') && g.rows > 1));
ok('ברירת המחדל מציגה רק דקות עם חפיפה', groups.every(g => g.rows > 1));

const tids = await page.$$eval('.mingrp .tid', els => els.map(e => e.textContent.trim()));
console.log('  דוגמת trip_id: ' + tids.slice(0, 3).join(', '));
ok('trip_id מוצג לכל יציאה', tids.length > 0);

const platSel = await page.$eval('#dPlat', e => ({ n: e.options.length, vis: e.parentElement.style.display }));
console.log('  בורר רציפים: ' + platSel.n + ' אפשרויות, מוצג=' + (platSel.vis !== 'none'));
ok('בורר הרציפים קיים', platSel.n >= 1);

// סינון "כל הדקות" מגדיל את מספר הקבוצות
await page.selectOption('#dOnly', 'all');
await page.waitForTimeout(200);
const allGroups = await page.$$eval('.mingrp', e => e.length);
ok('סינון "כל הדקות" מציג יותר קבוצות', allGroups >= groups.length);
await page.selectOption('#dType', 'origin');
await page.waitForTimeout(200);
const originOnly = await page.$$eval('.mingrp .tag.n', els => els.filter(e => e.textContent === 'ביניים').length);
ok('סינון "מוצא בלבד" מסתיר יציאות ביניים', originOnly === 0);
await page.screenshot({ path: path.join(root, 'test/screenshot-drawer.png') });
await page.click('#dClose');
await page.waitForTimeout(400);
ok('המגירה נסגרת לגמרי',
  !(await page.$eval('#drawer', e => e.classList.contains('open'))));

/* ---------- שלב 4: מפה ---------- */
console.log('\n=== מפה ===');
await page.click('#tabMap');
await page.waitForTimeout(1200);
const mapState = await page.evaluate(() => ({
  visible: document.getElementById('mapWrap').classList.contains('on'),
  markers: document.querySelectorAll('#map canvas').length,
  panes: !!document.querySelector('.leaflet-map-pane'),
  legend: !!document.querySelector('.maplegend'),
  attrib: (document.querySelector('.leaflet-control-attribution') || {}).textContent || ''
}));
console.log('  ' + JSON.stringify(mapState));
ok('המפה מוצגת', mapState.visible);
ok('Leaflet אותחל מקומית (ללא CDN)', mapState.panes);
ok('מקרא המפה קיים', mapState.legend);
ok('ייחוס OpenStreetMap מוצג', mapState.attrib.includes('OpenStreetMap'));
await page.screenshot({ path: path.join(root, 'test/screenshot-map.png') });
await page.click('#tabTable');

/* ---------- שלב 5: סינון יום בשבוע מתריע ---------- */
console.log('\n=== סינון לפי יום בשבוע ===');
await page.selectOption('#filterBy', 'dow');
await page.waitForTimeout(150);
ok('בורר היום בשבוע נחשף', await page.isVisible('#dowWrap'));
await page.selectOption('#day', '1');
await page.click('#run');
await page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'), { timeout: 120000 });
await page.waitForTimeout(300);
const dowWhen = await page.textContent('#resultWhen');
console.log('  ' + dowWhen);
ok('כותרת מציינת שזה כל התאריכים', dowWhen.includes('כל התאריכים'));

/* ---------- שלב 6: ניקוי מצב והיעדר ספירה כפולה (סעיף ט') ---------- */
console.log('\n=== ניקוי מצב בין הרצות ===');
await page.selectOption('#filterBy', 'date');
await page.waitForTimeout(150);
const before = await page.$$eval('#tbody tr', e => e.length);
const beforeDep = await page.$eval('#cards .card:nth-child(2) b', e => e.textContent);
// הניקוי חייב לקרות סינכרונית ברגע הלחיצה, לפני שה-Worker מספיק להשיב
const clearedNow = await page.evaluate(() => {
  document.getElementById('run').click();
  return {
    rows: document.querySelectorAll('#tbody tr').length,
    cards: document.querySelectorAll('#cards .card').length,
    hidden: document.getElementById('results').classList.contains('hide')
  };
});
await page.waitForFunction(() => document.querySelectorAll('#tbody tr').length > 0, { timeout: 120000 });
const after = await page.$$eval('#tbody tr', e => e.length);
const afterDep = await page.$eval('#cards .card:nth-child(2) b', e => e.textContent);
console.log('  לפני: ' + before + ' שורות / ' + beforeDep + ' יציאות');
console.log('  מיד בלחיצה: ' + JSON.stringify(clearedNow));
console.log('  אחרי: ' + after + ' שורות / ' + afterDep + ' יציאות');
ok('הטבלה מתרוקנת מיידית בלחיצה', clearedNow.rows === 0);
ok('כרטיסי הסיכום מתאפסים', clearedNow.cards === 0);
ok('הרצה חוזרת מחזירה בדיוק אותו מספר שורות (אין הצטברות)', after === before);
ok('הרצה חוזרת לא מכפילה את מספר היציאות', afterDep === beforeDep);

/* ---------- שלב 7: אורך תחנה ---------- */
console.log('\n=== קיבולת לפי אורך תחנה ===');
const target = await page.$eval('#tbody tr:first-child input.len', e => e.dataset.stop);
await page.fill('#tbody tr:first-child input.len', '120');
await page.$eval('#tbody tr:first-child input.len',
  el => el.dispatchEvent(new Event('change', { bubbles: true })));
await page.waitForTimeout(300);
await page.selectOption('#gradeFilter', 'all');
await page.waitForTimeout(300);
const capRow = await page.$$eval('#tbody tr', (els, s) => {
  const tr = els.find(t => t.querySelector('input.len') && t.querySelector('input.len').dataset.stop === s);
  if (!tr) return null;
  const td = tr.querySelectorAll('td');
  return { cap: td[8].innerText, grade: td[0].innerText.trim() };
}, target);
console.log('  תחנה ' + target + ' עם 120 מ׳ → ' + JSON.stringify(capRow));
ok('אורך 120 מ׳ נותן קיבולת 10', capRow && capRow.cap === '10');
ok('הדירוג יורד ל"תקין"', capRow && capRow.grade === 'תקין');
await page.selectOption('#gradeFilter', 'ab');

/* ---------- שלב 8: ייצוא ---------- */
console.log('\n=== ייצוא CSV ===');
const dl = page.waitForEvent('download', { timeout: 30000 });
await page.click('#export');
const download = await dl;
let csv = '';
for await (const c of await download.createReadStream()) csv += c;
const lines = csv.split('\r\n');
console.log('  שם קובץ: ' + download.suggestedFilename());
console.log('  כותרת: ' + lines[0].slice(0, 110) + '…');
ok('CSV מכיל BOM לעברית', csv.charCodeAt(0) === 0xfeff);
ok('CSV מכיל עמודת תאריך', lines[0].includes('תאריך/יום'));
ok('CSV מכיל trip_id', lines[0].includes('trip_id'));
ok('שם הקובץ כולל את התאריך שנותח', /\d{8}/.test(download.suggestedFilename()));

/* ---------- שלב 9: התקדמות, ETA ועצירה על קובץ גדול ---------- */
console.log('\n=== התקדמות, זמן משוער ועצירה (קובץ גדול) ===');
await page.setInputFiles('#file', path.join(root, 'test/sample-gtfs-big.zip'));
await page.waitForSelector('#fileInfo.ok');
await page.click('#scan');
await page.waitForSelector('#feedInfo.on', { timeout: 180000 });

await page.selectOption('#mode', 'all');
await page.selectOption('#fromHour', '0');
await page.selectOption('#toHour', '27');
await page.click('#run');
await page.waitForSelector('#stop:not(.hide)', { timeout: 10000 });
ok('כפתור העצירה נחשף בזמן ריצה', true);

// אוספים דגימות התקדמות עד שמופיע "מתוך" או ETA
let sawTotal = false, sawEta = false, sample = '';
for (let i = 0; i < 60; i++) {
  const t = await page.textContent('#progText').catch(() => '');
  if (t && t.length > 4) sample = t.replace(/\s+/g, ' ').trim();
  if (/מתוך ~[\d,]+ שורות/.test(sample)) sawTotal = true;
  if (/נותרו כ-/.test(sample)) sawEta = true;
  if (sawTotal && sawEta) break;
  if (await page.isHidden('#stop')) break;
  await page.waitForTimeout(60);
}
console.log('  דגימת התקדמות: ' + sample.slice(0, 160));
ok('מוצג "X מתוך ~Y שורות"', sawTotal);
ok('מוצג זמן משוער שנותר', sawEta);

if (!(await page.isHidden('#stop'))) {
  await page.click('#stop');
  await page.waitForFunction(() => document.getElementById('stop').classList.contains('hide'), { timeout: 20000 });
  const stopMsg = await page.$$eval('#msgs .note', els => els.map(e => e.innerText.trim()));
  console.log('  הודעות אחרי עצירה: ' + stopMsg.join(' | ').replace(/\s+/g,' ').slice(0, 160));
  ok('העצירה החזירה את הכפתורים למצב פעיל', await page.isEnabled('#run'));
  ok('הוצגה הודעה על הביטול', stopMsg.some(s => s.includes('בוטל') || s.includes('הופסק')));
} else {
  ok('הריצה הסתיימה לפני שהספקנו לעצור — לא ניתן לבדוק עצירה', false);
}

/* ---------- שלב 10: הרצה מ-file:// ---------- */
console.log('\n=== אזהרת file:// ===');
const p2 = await browser.newPage();
await p2.goto('file://' + path.join(root, 'index.html'));
await p2.waitForTimeout(400);
const bootMsg = await p2.$$eval('#bootMsgs .note', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
console.log('  ' + (bootMsg[0] || '(אין)').slice(0, 150));
ok('מוצגת אזהרה ברורה בהרצה מקובץ מקומי',
  bootMsg.length > 0 && bootMsg[0].includes('file://'));
ok('האזהרה מציעה פתרון מעשי',
  bootMsg[0].includes('http-server') || bootMsg[0].includes('http.server'));
ok('כפתור הסריקה מושבת', await p2.isDisabled('#scan'));
await p2.close();

console.log('\nשגיאות דפדפן: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'אין'));
if (errors.length) fail += errors.length;

await browser.close();
server.close();
console.log('\n' + (fail === 0 ? '✅ כל בדיקות הממשק עברו' : '❌ ' + fail + ' כשלים'));
process.exit(fail ? 1 : 0);
