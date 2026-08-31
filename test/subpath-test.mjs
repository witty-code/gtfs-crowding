/* מוודא שהאתר עובד גם תחת נתיב משנה, כמו user.github.io/repo/ */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root='/home/claude/gtfs-crowding';
const MIME={'.html':'text/html','.js':'text/javascript','.zip':'application/zip'};
const server=createServer(async(req,res)=>{
  let u=decodeURIComponent(req.url.split('?')[0]);
  if(!u.startsWith('/my-repo/')){res.writeHead(404);res.end('outside subpath');return;}
  u=u.slice('/my-repo'.length);
  const p=path.join(root, u==='/'?'index.html':u);
  try{const b=await readFile(p);res.writeHead(200,{'content-type':MIME[path.extname(p)]||'text/plain'});res.end(b);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(8097,r));
const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const page=await br.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
page.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
await page.route('**tile.openstreetmap.org/**', r =>
  r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));

await page.goto('http://localhost:8097/my-repo/');
await page.setInputFiles('#file', root+'/test/sample-gtfs.zip');
await page.click('#scan');
await page.waitForSelector('#feedInfo.on', { timeout: 120000 });
const nDates = await page.$$eval('#dateSel option', e => e.length);
await page.selectOption('#fromHour','6'); await page.selectOption('#toHour','9');
await page.click('#run');
await page.waitForFunction(()=>document.querySelectorAll('#tbody tr').length>0,{timeout:120000});
const n = await page.$$eval('#tbody tr', e=>e.length);
// גם המפה חייבת לעבוד תחת נתיב משנה (leaflet.css ותמונות הסמנים נטענים יחסית)
await page.click('#tabMap');
await page.waitForTimeout(900);
const mapOk = await page.evaluate(()=>!!document.querySelector('.leaflet-map-pane'));
console.log('תחת /my-repo/ — תאריכים: '+nDates+', שורות: '+n+', מפה: '+(mapOk?'תקינה':'נכשלה'));
console.log('שגיאות: '+(errs.length?errs.join(' | '):'אין'));
const good = n>0 && nDates>0 && mapOk && errs.length===0;
await br.close(); server.close();
process.exit(good ? 0 : 1);
