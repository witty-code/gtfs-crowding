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
await page.goto('http://localhost:8097/my-repo/');
await page.setInputFiles('#file', root+'/test/sample-gtfs.zip');
await page.selectOption('#day','1'); await page.selectOption('#fromHour','6'); await page.selectOption('#toHour','9');
await page.click('#run');
await page.waitForFunction(()=>document.querySelectorAll('#tbody tr').length>0,{timeout:90000});
const n=await page.$$eval('#tbody tr',e=>e.length);
console.log('שורות תחת /my-repo/: '+n);
console.log('שגיאות: '+(errs.length?errs.join(' | '):'אין'));
await br.close(); server.close();
process.exit(n>0 && errs.length===0 ? 0 : 1);
