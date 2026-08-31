/* בדיקת ממשק מקצה לקצה בדפדפן אמיתי */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.zip': 'application/zip', '.css': 'text/css' };

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

await page.goto('http://localhost:8099/index.html');
await page.setInputFiles('#file', path.join(root, 'test/sample-gtfs.zip'));
await page.waitForSelector('#fileInfo.ok');
console.log('קובץ נבחר:', await page.textContent('#fileInfo'));

// --- מבחן 1: מצב תחנות מוצא, יום שני, 06:00–09:59
await page.selectOption('#mode', 'origins');
await page.selectOption('#day', '1');
await page.selectOption('#fromHour', '6');
await page.selectOption('#toHour', '9');
await page.click('#run');
await page.waitForSelector('#results:not(.hide)', { timeout: 120000 });
await page.waitForFunction(() => document.querySelectorAll('#tbody tr').length > 0, { timeout: 120000 });

const cards = await page.$$eval('#cards .card', els =>
  els.map(e => e.querySelector('span').textContent + ': ' + e.querySelector('b').textContent));
console.log('\nכרטיסי סיכום:', cards.join(' | '));

const rowCount = await page.$$eval('#tbody tr', e => e.length);
const first = await page.$$eval('#tbody tr', els => els.slice(0, 3).map(tr =>
  Array.from(tr.querySelectorAll('td')).map(td => td.innerText.replace(/\n/g, ' / ')).join(' | ')));
console.log('שורות בטבלה:', rowCount);
console.log('שלוש ראשונות:\n  ' + first.join('\n  '));

let fail = 0;
const ok = (n, c) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) fail++; };

console.log('\nבדיקות:');
ok('נמצאו תחנות חריגות', rowCount > 0);
ok('התחנה המובילה היא רמה א׳', (await page.textContent('#tbody tr:first-child .tag')).includes('רמה א'));
const topExact = await page.$eval('#tbody tr:first-child td:nth-child(3)', e => parseInt(e.innerText));
ok('רמה א׳ של המובילה ≥ 3 (בהתאם לעומסים שנשתלו)', topExact >= 3);

// --- מבחן 2: פתיחת מגירת פירוט
await page.click('#tbody tr:first-child td.name');
await page.waitForSelector('#drawer.open');
const dTitle = await page.textContent('#dTitle');
const peakRows = await page.$$eval('#dBody tr.peak', e => e.length);
console.log('\nמגירת פירוט:', dTitle, '— שורות שיא:', peakRows);
ok('המגירה נפתחה עם כותרת', dTitle.length > 1);
ok('יש שורות מסומנות כשיא', peakRows >= 2);
const detailSample = await page.$$eval('#dBody tr.peak', els => els.slice(0, 4).map(tr =>
  Array.from(tr.querySelectorAll('td')).map(td => td.innerText).join(' | ')));
console.log('  דוגמה:\n    ' + detailSample.join('\n    '));
await page.waitForTimeout(400); // המתנה לסיום אנימציית ההחלקה
const boxOpen = await page.$eval('#drawer',
  e => ({ right: e.getBoundingClientRect().right, vw: document.documentElement.clientWidth }));
ok('המגירה צמודה לקצה הימני כשהיא פתוחה (' + boxOpen.right + ' מתוך ' + boxOpen.vw + ')',
  Math.abs(boxOpen.right - boxOpen.vw) < 2);
await page.screenshot({ path: path.join(root, 'test/screenshot-drawer.png') });
await page.click('#dClose');
await page.waitForTimeout(400);
const closedVisible = await page.$eval('#drawer',
  e => { const r = e.getBoundingClientRect(); return r.left < window.innerWidth - 1 && getComputedStyle(e).visibility !== 'hidden'; });
ok('המגירה נעלמת לגמרי בסגירה (RTL)', !closedVisible);
ok('הרקע המעומעם נסגר יחד איתה',
  !(await page.$eval('#backdrop', e => e.classList.contains('open'))));

// --- מבחן 3: אורך התחנה משנה קיבולת ומוריד את הדירוג
const target = await page.$eval('#tbody tr:first-child input.len', e => e.dataset.stop);
const beforeCap = await page.textContent('#tbody tr:first-child td:nth-child(9)');
const beforeExact = await page.$eval('#tbody tr:first-child td:nth-child(3)', e => parseInt(e.innerText));
await page.fill('#tbody tr:first-child input.len', '120');
// change טבעי מבעבע — משחזרים בדיוק את מה שקורה כשמשתמש יוצא מהשדה
await page.$eval('#tbody tr:first-child input.len',
  el => el.dispatchEvent(new Event('change', { bubbles: true })));
await page.waitForTimeout(300);

// בסינון "רמה א׳+ב׳" התחנה אמורה להיעלם: 120 מ׳ = קיבולת 10 > שיא של 6
const goneFromAB = await page.$$eval('#tbody input.len',
  (els, s) => !els.some(e => e.dataset.stop === s), target);
await page.selectOption('#gradeFilter', 'all');
await page.waitForTimeout(300);
const after = await page.$$eval('#tbody tr', (els, s) => {
  const tr = els.find(t => t.querySelector('input.len') && t.querySelector('input.len').dataset.stop === s);
  if (!tr) return null;
  const td = tr.querySelectorAll('td');
  return { cap: td[8].innerText, grade: td[0].innerText.trim(), len: tr.querySelector('input.len').value };
}, target);
console.log('\nתחנה ' + target + ': קיבולת ' + beforeCap + ' (24 מ׳, שיא ' + beforeExact + ') → ' +
  JSON.stringify(after));
ok('האורך נשמר על התחנה הנכונה', after && after.len === '120');
ok('אורך 120 מ׳ נותן קיבולת 10', after && after.cap === '10');
ok('הדירוג יורד ל"תקין" כשהקיבולת עולה על השיא', after && after.grade === 'תקין');
ok('התחנה נעלמת מסינון "רמה א׳+ב׳"', goneFromAB);

// --- מבחן 4: סינון וחיפוש
await page.selectOption('#gradeFilter', 'a');
await page.waitForTimeout(200);
const onlyA = await page.$$eval('#tbody tr td:first-child .tag',
  els => els.length > 0 && els.every(e => e.textContent.includes('רמה א')));
ok('סינון "רמה א׳ בלבד" עובד', onlyA);
await page.selectOption('#gradeFilter', 'ab');

// --- מבחן 5: מצב "כולל תחנות ביניים"
await page.selectOption('#mode', 'all');
await page.click('#run');
await page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'), { timeout: 180000 });
await page.waitForTimeout(500);
const midRows = await page.$$eval('#tbody tr', e => e.length);
const cards2 = await page.$$eval('#cards .card b', e => e.map(x => x.textContent));
console.log('\nמצב "כולל תחנות ביניים": שורות =', midRows, ', כרטיסים =', cards2.join(' | '));
ok('מצב ביניים מחזיר תוצאות', midRows > 0);
await page.selectOption('#typeFilter', 'mid');
await page.waitForTimeout(200);
const midOnly = await page.$$eval('#tbody tr', els =>
  els.filter(t => t.dataset.u).every(t => t.querySelectorAll('td')[6].innerText.trim() === '0'));
ok('סינון "ביניים בלבד" מחזיר רק תחנות ללא יציאות מוצא', midOnly);
await page.selectOption('#typeFilter', 'all');

// --- מבחן 6: ייצוא CSV
const dl = page.waitForEvent('download', { timeout: 30000 });
await page.click('#export');
const download = await dl;
const stream = await download.createReadStream();
let csv = '';
for await (const c of stream) csv += c;
const lines = csv.split('\r\n');
console.log('\nCSV: ' + (lines.length - 1) + ' שורות');
console.log('  כותרת: ' + lines[0].slice(0, 120) + '…');
console.log('  שורה 1: ' + lines[1]);
ok('CSV מכיל BOM לעברית באקסל', csv.charCodeAt(0) === 0xfeff);
ok('CSV מכיל שורות', lines.length > 5);
ok('CSV מכיל עמודת דירוג', lines[0].includes('דירוג'));

// צילום מסך
await page.screenshot({ path: path.join(root, 'test/screenshot.png'), fullPage: false });
await page.selectOption('#gradeFilter', 'all');
await page.waitForTimeout(200);

console.log('\nשגיאות דפדפן: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'אין'));
if (errors.length) fail += errors.length;

await browser.close();
server.close();
console.log('\n' + (fail === 0 ? '✅ כל בדיקות הממשק עברו' : '❌ ' + fail + ' כשלים'));
process.exit(fail ? 1 : 0);
