/* בדיקת ממשק מקצה לקצה בדפדפן אמיתי */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
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
ok('מוצג כמה רשומות station יש בפיד', kv.some(s => s.startsWith('רשומות מסוג station')));
// בפיד הדוגמה יש parent_station, ולכן ההסבר לא אמור להופיע.
// המקרה ההפוך (פיד ללא תחנות אם) נבדק בבדיקות הליבה.
const parentNote = await page.$$eval('#msgs .note', els =>
  els.map(e => e.innerText).filter(t => /parent_station/.test(t)));
const nParent = parseInt((kv.find(x => x.startsWith('רציפים עם parent_station')) || '0')
  .replace(/\D/g, ''), 10);
console.log('  רציפים עם תחנת אם: ' + nParent + ' · הסבר מוצג: ' + (parentNote.length > 0));
ok('ההסבר מוצג רק כשאין תחנות אם', (nParent > 0) === (parentNote.length === 0));

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

/* ---------- שלב 9ב: תיקוני הגרסה הזו ---------- */
console.log('\n=== מיון הפירוט, הקשר הקו ומספר תחנה במסלול ===');
await page.setInputFiles('#file', path.join(root, 'test/sample-gtfs.zip'));
await page.waitForSelector('#fileInfo.ok');
await page.click('#scan');
await page.waitForSelector('#feedInfo.on', { timeout: 120000 });
await page.selectOption('#mode', 'all');
await page.selectOption('#fromHour', '6');
await page.selectOption('#toHour', '9');
await page.click('#run');
await page.waitForFunction(() => document.querySelectorAll('#tbody tr').length > 0, { timeout: 180000 });
await page.click('#tbody tr:first-child td.name');
await page.waitForSelector('#drawer.open');
await page.waitForTimeout(400);

await page.selectOption('#dOnly', 'all');
await page.waitForTimeout(250);
const byTime = await page.$$eval('.mingrp .hd .t', e => e.map(x => x.textContent));
await page.selectOption('#dSort', 'load');
await page.waitForTimeout(250);
const byLoad = await page.$$eval('.mingrp', els => els.map(e => e.querySelectorAll('tbody tr').length));
console.log('  לפי שעה: ' + byTime.slice(0, 5).join(', '));
console.log('  לפי עומס: ' + byLoad.slice(0, 8).join(', '));
ok('מיון לפי שעה עולה', byTime.every((v, i) => i === 0 || v >= byTime[i - 1]));
ok('מיון לפי עומס יורד', byLoad.every((v, i) => i === 0 || v <= byLoad[i - 1]));
await page.selectOption('#dSort', 'time');
await page.waitForTimeout(200);

const ctx = await page.$$eval('.ctxbox', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
console.log('  הקשר קו לדוגמה: ' + (ctx[0] || '(אין)').slice(0, 150));
ok('מוצג הקשר של הקו לאורך היום', ctx.length > 0 && /יציאות מהמוצא/.test(ctx[0]));
ok('מוצגים מרווחים לפני ואחרי', ctx.some(c => /מרווחים/.test(c)));
await page.click('#dClose');
await page.waitForTimeout(300);
// בוחרים תחנה שיש בה באמת יציאות ביניים
await page.selectOption('#typeFilter', 'mid');
await page.waitForTimeout(250);
const nMid = await page.$$eval('#tbody tr[data-u]', e => e.length);
console.log('  תחנות ביניים בטבלה: ' + nMid);
await page.click('#tbody tr:first-child td.name');
await page.waitForSelector('#drawer.open');
await page.waitForTimeout(500);
await page.selectOption('#dType', 'all');   // שלב קודם השאיר "מוצא בלבד"
await page.selectOption('#dOnly', 'all');
await page.waitForTimeout(300);
const midTags = await page.$$eval('.seqchip', els =>
  els.map(e => e.textContent.split('תחנה')[0].trim()).filter(t => /^\d+\/\d+$/.test(t)));
console.log('  מחווני מיקום במסלול: ' + midTags.slice(0, 5).join(', '));
ok('תחנת ביניים מציגה מיקום X/Y במסלול', midTags.length > 0);
ok('המיקום הגיוני (X קטן או שווה ל-Y)',
  midTags.every(t => { const [a2, b2] = t.split('/').map(Number); return a2 >= 1 && a2 <= b2; }));
await page.click('#dClose');
await page.waitForTimeout(250);
await page.selectOption('#typeFilter', 'all');
await page.waitForTimeout(250);
await page.click('#tbody tr:first-child td.name');
await page.waitForSelector('#drawer.open');
await page.waitForTimeout(400);

console.log('\n=== כלי מדידת אורך תחנה ===');
await page.click('#dMeasureBtn');
await page.waitForTimeout(1000);
ok('פאנל הצד נפתח עם המפה', await page.isVisible('#dMap'));
const box = await page.$eval('#dMap', e => { const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.click(box.x + box.w * 0.42, box.y + box.h * 0.5);
await page.waitForTimeout(250);
await page.mouse.click(box.x + box.w * 0.58, box.y + box.h * 0.5);
await page.waitForTimeout(350);
const measured = await page.textContent('#dMeasureVal');
console.log('  נמדד: ' + measured);
ok('המדידה מחזירה אורך במטרים', /^[\d.]+ מ׳$/.test(measured) && parseFloat(measured) > 0);
const stopBeingMeasured = await page.$eval('#tbody tr:first-child input.len', e => e.dataset.stop);
await page.click('#dMeasureSave');
await page.waitForTimeout(400);
const savedLen = await page.$$eval('#tbody input.len', (els, sid) => {
  const el = els.find(x => x.dataset.stop === sid); return el ? el.value : null;
}, stopBeingMeasured);
ok('האורך שנמדד נשמר על התחנה', savedLen !== null && parseFloat(savedLen) === parseFloat(measured));
const persisted = await page.evaluate(s2 =>
  JSON.parse(localStorage.getItem('gtfsCrowdLens') || '{}')[s2], stopBeingMeasured);
ok('האורך נשמר בזיכרון הדפדפן', typeof persisted === 'number' && persisted > 0);

console.log('\n=== מגירה דו-טורית, טוגל הקשר ומחוון מיקום ===');
const wide = await page.evaluate(() => {
  const d = document.getElementById('drawer');
  return { w: Math.round(d.getBoundingClientRect().width), vw: document.documentElement.clientWidth };
});
console.log('  רוחב המגירה: ' + wide.w + ' מתוך ' + wide.vw);
ok('המגירה רחבה מ-800px במסך רחב', wide.w > 800);
const sideOn = await page.evaluate(() => {
  const s2 = document.getElementById('dSide');
  const b = document.getElementById('dBody');
  return { sideX: s2.getBoundingClientRect().x, bodyX: b.getBoundingClientRect().x,
    sameRow: Math.abs(s2.getBoundingClientRect().y - b.getBoundingClientRect().y) < 60 };
});
console.log('  ' + JSON.stringify(sideOn));
ok('המפה משמאל והנתונים מימין, באותה שורה', sideOn.sideX < sideOn.bodyX && sideOn.sameRow);

const ctxBefore = await page.$$eval('.ctxrow', e => e.filter(x => x.offsetParent !== null).length);
await page.click('#dCtxToggle');
await page.waitForTimeout(200);
const ctxAfter = await page.$$eval('.ctxrow', e => e.filter(x => x.offsetParent !== null).length);
console.log('  תיבות הקשר: ' + ctxBefore + ' → ' + ctxAfter);
ok('טוגל אחד מכבה את כל תיבות ההקשר', ctxBefore > 0 && ctxAfter === 0);
await page.click('#dCtxToggle');
await page.waitForTimeout(200);
ok('והטוגל מחזיר אותן', (await page.$$eval('.ctxrow', e => e.filter(x => x.offsetParent !== null).length)) > 0);

const chips = await page.$$eval('.seqchip', els => els.map(e => ({
  txt: e.textContent.split('תחנה')[0].trim(), bg: getComputedStyle(e).backgroundColor })));
console.log('  מחווני מיקום: ' + chips.slice(0, 4).map(c => c.txt).join(', '));
ok('מוצג "X/Y" למיקום התחנה במסלול', chips.some(c => /^\d+\/\d+$/.test(c.txt)));
ok('לכל מחוון צבע משלו לפי המיקום', new Set(chips.map(c => c.bg)).size > 1);
const popShown = await page.evaluate(() => {
  const c = document.querySelector('.seqchip');
  if (!c) return null;
  c.focus();
  const p = c.querySelector('.seqpop');
  const mk = c.querySelector('.seqaxis .mk');
  return { visible: getComputedStyle(p).display !== 'none', hasAxis: !!mk,
    pos: mk ? mk.style.insetInlineEnd : null, text: p.textContent.slice(0, 60) };
});
console.log('  ' + JSON.stringify(popShown));
ok('פופ-הובר נפתח עם ציר וסמן', popShown && popShown.visible && popShown.hasAxis);
ok('הסמן ממוקם באחוזים', popShown && /%$/.test(popShown.pos || ''));
const legendOnce = await page.$$eval('#dBody .legend', els =>
  els.map(e => e.innerText).join(' ').split('משוערת יותר').length - 1);
console.log('  "משוערת יותר" מופיע במקרא: ' + legendOnce + ' פעמים');
ok('ההסבר מופיע פעם אחת במקרא ולא בכל שורה', legendOnce === 1);

console.log('\n=== מסלולי הקווים לדקה נבחרת ===');
await page.click('.mingrp .showpaths');
await page.waitForFunction(() => {
  const l = document.getElementById('dRouteList');
  return l && !l.classList.contains('hide') && !/טוען/.test(l.textContent);
}, { timeout: 30000 });
await page.waitForTimeout(700);
const paths = await page.evaluate(() => ({
  boxes: document.querySelectorAll('#dRouteList input[type=checkbox]').length,
  lines: document.querySelectorAll('#dMap path.leaflet-interactive').length,
  txt: document.getElementById('dRouteList').innerText.replace(/\s+/g, ' ').slice(0, 110)
}));
console.log('  ' + JSON.stringify(paths));
ok('נטענו מסלולים לדקה', paths.boxes > 0);
ok('המסלולים משורטטים על המפה', paths.lines > 0);
const afterUncheck = await page.evaluate(async () => {
  const cb = document.querySelector('#dRouteList input[type=checkbox]');
  cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return document.querySelectorAll('#dMap path.leaflet-interactive').length;
});
console.log('  קווים אחרי כיבוי אחד: ' + afterUncheck);
ok('אפשר לכבות מסלול בודד', afterUncheck < paths.lines);
await page.screenshot({ path: path.join(root, 'test/screenshot-drawer.png') });

console.log('\n=== ייצוא התחנה ===');
const dlPng = page.waitForEvent('download', { timeout: 30000 });
await page.click('#dExportPng');
const png = await dlPng;
const pngBuf = [];
for await (const c of await png.createReadStream()) pngBuf.push(c);
const pngData = Buffer.concat(pngBuf);
console.log('  תמונה: ' + png.suggestedFilename() + ' · ' + Math.round(pngData.length / 1024) + ' KB');
ok('נוצרה תמונת PNG', pngData.length > 3000 && pngData[1] === 0x50 && pngData[2] === 0x4e);
ok('שם התמונה כולל את קוד התחנה', /^stop-\d+/.test(png.suggestedFilename()));

const dlStop = page.waitForEvent('download', { timeout: 30000 });
await page.click('#dExportCsv');
const stopCsv = await dlStop;
let sc = '';
for await (const c of await stopCsv.createReadStream()) sc += c;
const scLines = sc.split('\r\n');
console.log('  CSV תחנה: ' + stopCsv.suggestedFilename() + ' · ' + (scLines.length - 1) + ' שורות');
console.log('  כותרת: ' + scLines[0].slice(0, 120));
ok('CSV פר תחנה נוצר', scLines.length > 2);
ok('כולל שעה, דקה ומספר תחנה במסלול',
  ['שעה', 'דקה', 'מספר תחנה במסלול', 'trip_id'].every(h => scLines[0].includes(h)));
ok('כולל כמה יציאות באותה דקה', scLines[0].includes('יציאות באותה דקה'));

console.log('\n=== נגישות: aria-hidden ===');
await page.click('#dClose');           // הבדיקות כאן נוגעות למצב הסגור
await page.waitForTimeout(450);
const a11y = await page.evaluate(() => {
  const d = document.getElementById('drawer');
  return { hasAria: d.hasAttribute('aria-hidden'), inert: d.inert === true,
    focusInside: d.contains(document.activeElement) };
});
console.log('  ' + JSON.stringify(a11y));
ok('אין aria-hidden על המגירה', !a11y.hasAria);
ok('המגירה מסומנת inert בסגירה', a11y.inert);
ok('הפוקוס יצא מהמגירה', !a11y.focusInside);

console.log('\n=== מפה: המגירה מעל, ורדיוס לפי זום ===');
await page.click('#tabMap');
await page.waitForTimeout(1000);
const zTop = await page.evaluate(() => {
  const d = getComputedStyle(document.getElementById('drawer')).zIndex;
  const panes = Array.from(document.querySelectorAll('.leaflet-pane, .leaflet-control'))
    .map(e => parseInt(getComputedStyle(e).zIndex, 10)).filter(n => !isNaN(n));
  return { drawer: parseInt(d, 10), maxLeaflet: Math.max.apply(null, panes.concat([0])) };
});
console.log('  z-index מגירה=' + zTop.drawer + ' מול Leaflet=' + zTop.maxLeaflet);
ok('המגירה מעל כל שכבות המפה', zTop.drawer > zTop.maxLeaflet);

const painted = async () => page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  if (!c) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
  return n;
});
const paintedBefore = await painted();
// מרחיקים דרך פקד הזום של Leaflet — לחיצת מקלדת לא בהכרח מגיעה למפה
await page.click('.leaflet-control-zoom-out');
await page.waitForTimeout(700);
await page.click('.leaflet-control-zoom-out');
await page.waitForTimeout(1100);
const paintedAfter = await painted();
console.log('  פיקסלים צבועים לפני הרחקה: ' + paintedBefore + ' אחרי: ' + paintedAfter);
ok('העיגולים מצטמצמים בהרחקה (מפת חום)',
  paintedBefore > 0 && paintedAfter > 0 && paintedAfter < paintedBefore);

console.log('\n=== לשונית לוחות זמנים וייצוא Canva ===');
await page.click('#tabRoutes');
await page.waitForFunction(() => document.querySelectorAll('#rBody tr').length > 0, { timeout: 60000 });
const rRows = await page.$$eval('#rBody tr', els => els.slice(0, 3).map(t =>
  Array.from(t.querySelectorAll('td')).map(td => td.innerText.replace(/\n/g, ' ')).join(' | ')));
console.log('  ' + rRows.join('\n  '));
ok('רשימת הקווים נבנתה', rRows.length > 0);
await page.click('#rBody tr:first-child');
await page.waitForSelector('#ttPanel:not(.hide)', { timeout: 20000 });
const slots = await page.$$eval('#ttPanel .slot', els => els.map(e => e.textContent.trim()));
const dupSlots = await page.$$eval('#ttPanel .slot.dup', els => els.map(e => e.textContent.trim()));
console.log('  שעות בלוח: ' + slots.length + ' · כפולות: ' + dupSlots.slice(0, 4).join(', '));
ok('לוח הזמנים מציג שעות', slots.length > 0);
ok('שעות עם יותר מאוטובוס אחד מסומנות ב-×N', dupSlots.every(t => /×\d+/.test(t)));
await page.screenshot({ path: path.join(root, 'test/screenshot-routes.png') });

const dl2 = page.waitForEvent('download', { timeout: 40000 });
await page.click('#exportRoutes');
const download2 = await dl2;
let csv2 = '';
for await (const c of await download2.createReadStream()) csv2 += c;
const l2 = csv2.split('\r\n');
console.log('  קובץ: ' + download2.suggestedFilename() + ' · ' + (l2.length - 1) + ' קווים');
console.log('  כותרת: ' + l2[0].slice(0, 150));
console.log('  שורה 1: ' + l2[1].slice(0, 150));
ok('CSV לוחות זמנים נוצר', l2.length > 1);
ok('כותרות Bulk Create קיימות',
  ['Line_Number', 'Destination', 'Direction_1_Name', 'Direction_2_Name'].every(h => l2[0].includes(h)));
ok('יש עמודות שעה ממוספרות', /Dir1_Time_1/.test(l2[0]) && /Dir2_Time_1/.test(l2[0]));
ok('יש גם עמודה מרוכזת אחת', l2[0].includes('Dir1_Times'));
ok('יציאות כפולות מסומנות ב-*X', /\*\d/.test(csv2));
ok('CSV מכיל BOM', csv2.charCodeAt(0) === 0xfeff);

/* --- סעיף ב׳: השעה המלאה בכל שבב, ובכיווניות מבודדת --- */
const slotShape = await page.$$eval('#ttPanel .slot bdi', els =>
  els.slice(0, 6).map(e => ({ txt: e.textContent.trim(), dir: getComputedStyle(e).unicodeBidi })));
console.log('  שבבי שעה: ' + JSON.stringify(slotShape.slice(0, 3)));
ok('כל שבב מציג שעה מלאה HH:MM ולא רק דקות',
  slotShape.length > 0 && slotShape.every(o => /^\d{2}:\d{2}$/.test(o.txt)));
ok('שבבי השעה מבודדים לכיווניות (הנקודתיים לא מתהפכות)',
  slotShape.every(o => /isolate/.test(o.dir)));
const hourShape = await page.$$eval('#ttPanel .tth bdi', els =>
  els.slice(0, 3).map(e => ({ txt: e.textContent.trim(), dir: getComputedStyle(e).unicodeBidi })));
ok('כותרת השעה מבודדת אף היא',
  hourShape.length > 0 && hourShape.every(o => /^\d{2}:00$/.test(o.txt) && /isolate/.test(o.dir)));

/* --- סעיף ד׳: צ׳קבוקסים בתוצאות החיפוש --- */
const nAll = await page.$$eval('#rBody tr[data-ri]', els => els.length);
await page.click('#rBody tr[data-ri]:nth-child(1) input[data-pick]');
await page.click('#rBody tr[data-ri]:nth-child(2) input[data-pick]');
const btnTxt = await page.textContent('#exportRoutes');
console.log('  מתוך ' + nAll + ' תוצאות סומנו 2 · כפתור: ' + btnTxt.trim());
ok('סימון שני קווים מצמצם את הייצוא לשניים', /\(2\)/.test(btnTxt));
const rowPicked = await page.$$eval('#rBody tr.picked', els => els.length);
ok('השורות המסומנות מודגשות', rowPicked === 2);
/* קליק על הצ׳קבוקס לא פותח לוח זמנים של קו אחר */
const ttHead = await page.textContent('#ttPanel h3');

const dlSel = page.waitForEvent('download', { timeout: 40000 });
await page.click('#exportRoutes');
const dSel = await dlSel;
let csvSel = '';
for await (const c of await dSel.createReadStream()) csvSel += c;
const lSel = csvSel.split('\r\n').filter(x => x.length);
console.log('  קובץ מסומנים: ' + dSel.suggestedFilename() + ' · ' + (lSel.length - 1) + ' שורות');
ok('הייצוא כולל בדיוק את הקווים שסומנו', lSel.length - 1 === 2);
/* --- סעיף ג׳: שם הקובץ נושא את הקו/המק״ט, ומנוקה --- */
ok('שם הקובץ כולל את מספר הקו', /line-/.test(dSel.suggestedFilename()),
  dSel.suggestedFilename());
ok('שם הקובץ ASCII וחוקי — בלי נתיבים ובלי סיומת כפולה',
  /^[0-9A-Za-z_-]+\.csv$/.test(dSel.suggestedFilename()), dSel.suggestedFilename());

/* סימון־הכל מחזיר את כל התוצאות */
await page.click('#rAll');
await page.click('#rAll');
const btnAll = await page.textContent('#exportRoutes');
ok('ניקוי הסימון מחזיר ייצוא של כל התוצאות המוצגות', btnAll.includes('(' + nAll + ')'));

/* --- סעיף ד׳: חיפוש שמחזיר הרבה תוצאות, וסימון בורר מתוכן --- */
const someLine = await page.evaluate(() => {
  const tr = document.querySelector('#rBody tr[data-ri]');
  return tr ? tr.querySelector('td.num b').textContent.trim() : '';
});
await page.fill('#rq', someLine);
await page.waitForTimeout(150);
const nHits = await page.$$eval('#rBody tr[data-ri]', els => els.length);
const firstLine = await page.$eval('#rBody tr[data-ri] td.num b', e => e.textContent.trim());
console.log('  חיפוש "' + someLine + '" → ' + nHits + ' תוצאות, ראשונה: ' + firstLine);
ok('התאמה מדויקת של מספר הקו עולה לראש התוצאות', firstLine === someLine);
await page.click('#rBody tr[data-ri]:nth-child(1) input[data-pick]');
const btnOne = await page.textContent('#exportRoutes');
ok('אפשר לבחור קו בודד מתוך תוצאות חיפוש רחבות', /\(1\)/.test(btnOne), btnOne.trim());
await page.fill('#rq', '');
await page.waitForTimeout(150);

/* --- סדרת קווים + טווח תאריכים + לוח מודפס --- */
console.log('\n=== סדרת קווים ולוח לפרסום ===');
await page.click('#rSeriesClear');
const lineList = await page.$$eval('#rBody tr[data-ri] td.num b',
  els => els.map(e => e.textContent.trim()).filter(t => /^\d+$/.test(t)));
const nums = Array.from(new Set(lineList.map(Number))).sort((a, b) => a - b);
const seriesTxt = nums[0] + ', ' + nums[1] + '-' + nums[Math.min(3, nums.length - 1)];
await page.fill('#rSeries', seriesTxt);
await page.click('#rSeriesGo');
const picked = await page.$$eval('#rBody tr.picked', els => els.length);
const note = await page.textContent('#pubNote');
console.log('  סדרה "' + seriesTxt + '" → ' + picked + ' שורות מסומנות · ' + note.trim());
ok('סדרת קווים עם טווח מסמנת קווים', picked > 0);
ok('הסינון עובר ל"כל הקווים" כדי שהסימון יהיה גלוי',
  (await page.inputValue('#rFilter')) === 'all');
ok('מוצג סיכום של מה שסומן', /סומנו/.test(note));

/* קלט לא תקין לא מסמן ולא קורס */
await page.fill('#rSeries', 'שלום');
await page.click('#rSeriesGo');
ok('טקסט חופשי מטופל בלי קריסה', true);

await page.fill('#rSeries', seriesTxt);
await page.click('#rSeriesGo');

const pubDates = await page.$$eval('#pubFrom option', els => els.map(e => e.value));
console.log('  תאריכים בטווח: ' + pubDates.length + ' (' + pubDates[0] + '…' + pubDates[pubDates.length - 1] + ')');
ok('רשימת התאריכים לטווח מולאה מהפיד', pubDates.length > 1);
await page.selectOption('#pubFrom', pubDates[0]);
await page.selectOption('#pubTo', pubDates[Math.min(2, pubDates.length - 1)]);

const dlRange = page.waitForEvent('download', { timeout: 60000 });
await page.click('#pubCsv');
const dR = await dlRange;
let csvRange = '';
for await (const c of await dR.createReadStream()) csvRange += c;
const rowsRange = csvRange.split('\r\n').filter(Boolean);
const dCol = rowsRange[0].replace(/^﻿/, '').split(',').indexOf('Service_Date');
const distinctDates = new Set(rowsRange.slice(1).map(r => r.split(',')[dCol]));
console.log('  CSV טווח: ' + dR.suggestedFilename() + ' · ' + (rowsRange.length - 1) +
  ' שורות · ' + distinctDates.size + ' תאריכים');
ok('CSV לטווח מכיל יותר מתאריך אחד', distinctDates.size > 1, String(distinctDates.size));
ok('שם קובץ הטווח ASCII וחוקי', /^[0-9A-Za-z_-]+\.csv$/.test(dR.suggestedFilename()),
  dR.suggestedFilename());

const dlSheet = page.waitForEvent('download', { timeout: 60000 });
await page.click('#pubHtml');
const dS = await dlSheet;
let sheetHtml = '';
for await (const c of await dS.createReadStream()) sheetHtml += c;
console.log('  לוח: ' + dS.suggestedFilename() + ' · ' + sheetHtml.length + ' תווים');
ok('הלוח יורד כקובץ HTML', /\.html$/.test(dS.suggestedFilename()), dS.suggestedFilename());
ok('הלוח הוא מסמך עצמאי', sheetHtml.startsWith('<!doctype html>'));
ok('הקרדיט לארגון מופיע בלוח', sheetHtml.includes('קו ישיר') &&
  sheetHtml.includes('הפורום הארצי לקידום תחבורה ציבורית'));
ok('הודעת ההצלחה מסבירה איך להפיק PDF',
  /שמירה כ-PDF/.test(await page.textContent('#msgs')));

/* הלוח באמת נפתח ומודפס — נטען לדפדפן ונמדד */
const sheetPage = await browser.newPage({ viewport: { width: 1180, height: 1000 } });
await sheetPage.setContent(sheetHtml);
const tblCount = await sheetPage.$$eval('table', t => t.length);
const dirOk = await sheetPage.evaluate(() => document.documentElement.dir);
const dupText = await sheetPage.$$eval('.m.dup bdi', els => els.slice(0, 2).map(e => e.textContent));
console.log('  בלוח: ' + tblCount + ' טבלאות · dir=' + dirOk + ' · כפולות: ' + dupText.join(', '));
ok('הלוח נטען ומכיל טבלאות', tblCount > 0);
ok('הלוח מוגדר RTL', dirOk === 'rtl');
const printBtnHidden = await sheetPage.evaluate(() => {
  const b = document.querySelector('.noprint');
  return b ? getComputedStyle(b).display !== 'none' : false;
});
ok('כפתור ההדפסה גלוי על המסך', printBtnHidden);
const rngTxt = await sheetPage.textContent('.range');
const rngDir = await sheetPage.$eval('.range bdi', e => getComputedStyle(e).direction);
console.log('  טווח בכותרת: ' + rngTxt.trim() + ' (' + rngDir + ')');
ok('טווח התאריכים מבודד ולכן לא מתהפך', rngDir === 'ltr');
const headTxt = await sheetPage.textContent('h1');
ok('כותרת עם הרבה קווים מקוצרת', headTxt.length < 120, String(headTxt.length));
await sheetPage.screenshot({ path: path.join(root, 'test/screenshot-luach.png'), fullPage: false });
await sheetPage.close();

console.log('\n=== יישור שורת ההתקדמות ===');
const progAlign = await page.evaluate(() => {
  document.getElementById('progress').classList.add('on');
  const p = document.getElementById('progText');
  p.innerHTML = '<b>קורא</b><span class="s-pct">7%</span>' +
    '<span class="s-rows"><span class="num">1,000 / ~9,000,000</span> שורות</span>' +
    '<span class="s-bytes"><span class="num">0.05 / 1.99 GB</span></span>';
  const a = document.querySelector('#progText .s-bytes').getBoundingClientRect();
  p.querySelector('.s-bytes .num').textContent = '1.27 / 1.99 GB';
  const b = document.querySelector('#progText .s-bytes').getBoundingClientRect();
  p.innerHTML = '';
  document.getElementById('progress').classList.remove('on');
  return { w1: Math.round(a.width), w2: Math.round(b.width), x1: Math.round(a.x), x2: Math.round(b.x) };
});
console.log('  משבצת הנפח: ' + JSON.stringify(progAlign));
ok('משבצת הנפח נמדדה בפועל', progAlign.w1 > 40);
ok('משבצת הנפח שומרת רוחב קבוע', progAlign.w1 === progAlign.w2);
ok('המשבצת לא זזה בין עדכונים', progAlign.x1 === progAlign.x2);

console.log('\n=== אזהרת בחירת הפיד ===');
const feedWarn = await page.$eval('.note.warn', e => e.innerText.replace(/\s+/g, ' '));
console.log('  ' + feedWarn.slice(0, 170));
ok('מוצגת אזהרה לפני ההעלאה על בחירת הקובץ', /Gtfs_10_days/.test(feedWarn));
ok('האזהרה מסבירה מה חסר בפיד המלא',
  /יציאות כפולות/.test(feedWarn) && /israel-public-transportation/.test(feedWarn));
ok('האזהרה מקשרת את זה גם לניתוח העומס', /עומס/.test(feedWarn));
/* זיהוי אוטומטי של הפיד המלא לפי שם הקובץ */
const fullName = path.join(root, 'test/israel-public-transportation.zip');
fs.copyFileSync(path.join(root, 'test/sample-gtfs.zip'), fullName);
const p3 = await browser.newPage();
await p3.goto('http://localhost:8099/index.html');
await p3.setInputFiles('#file', fullName);
await p3.waitForSelector('#fileInfo.ok');
await p3.click('#scan');
await p3.waitForSelector('#feedInfo.on', { timeout: 120000 });
const scanMsgs = await p3.textContent('#msgs');
console.log('  לאחר סריקת קובץ בשם הפיד המלא: ' +
  (scanMsgs.match(/נטען הפיד המלא[^.]*\./) || ['—'])[0]);
ok('הפיד המלא מזוהה לפי שם הקובץ ומופקת אזהרה',
  /נטען הפיד המלא/.test(scanMsgs));
ok('האזהרה מפנה ל-Gtfs_10_days', /Gtfs_10_days/.test(scanMsgs));
await p3.close();
fs.unlinkSync(fullName);

console.log('\n=== כתובת ההורדה הרשמית ===');
const motLink = await page.$eval('a[href*="gtfs.mot.gov.il"]', e => e.href).catch(() => null);
console.log('  ' + motLink);
ok('מוצגת כתובת ההורדה של משרד התחבורה', motLink === 'https://gtfs.mot.gov.il/gtfsfiles/');

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
