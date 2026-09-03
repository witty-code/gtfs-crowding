/* app.js — שכבת הממשק. כל העבודה הכבדה נעשית ב-worker.js */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var DAY_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  var worker = null, files = null;
  var ROWS = [], STATS = null, COVERAGE = null, DIAG = null;
  var sortKey = 'maxExact', sortAsc = false;
  var LENS = {}, lastOpts = null, busy = false;
  var map = null, mapLayer = null, mapReady = false, detailRows = null, detailMeta = null;

  try { LENS = JSON.parse(localStorage.getItem('gtfsCrowdLens') || '{}'); } catch (e) { LENS = {}; }
  function saveLens() { try { localStorage.setItem('gtfsCrowdLens', JSON.stringify(LENS)); } catch (e) {} }

  /* ================= בדיקת סביבה ================= */
  function boot(kind, html) {
    var d = document.createElement('div');
    d.className = 'note ' + kind;
    d.innerHTML = '<svg class="ic lg"><use href="#i-' +
      (kind === 'err' ? 'alert-circle' : kind === 'warn' ? 'alert-triangle' : 'info') +
      '"></use></svg><div>' + html + '</div>';
    $('bootMsgs').appendChild(d);
  }
  var FATAL = false;
  if (location.protocol === 'file:') {
    FATAL = true;
    boot('err', '<b>הדף נפתח כקובץ מקומי (<code>file://</code>) ולכן לא יוכל לעבוד.</b><br>' +
      'דפדפנים חוסמים Web Worker מקובץ מקומי מטעמי אבטחה. שלוש דרכים להריץ:<br>' +
      '1. השתמש בגרסה המקוונת — <a href="https://witty-code.github.io/gtfs-crowding/">' +
      'witty-code.github.io/gtfs-crowding</a><br>' +
      '2. הרץ שרת מקומי בתיקייה: <code dir="ltr">npx http-server -p 8080</code> ואז פתח ' +
      '<code dir="ltr">http://localhost:8080</code><br>' +
      '3. או עם פייתון: <code dir="ltr">python -m http.server 8080</code>');
  } else if (typeof Worker === 'undefined') {
    FATAL = true;
    boot('err', 'הדפדפן אינו תומך ב-Web Workers ולכן הכלי לא יוכל לפעול.');
  } else if (typeof DecompressionStream === 'undefined') {
    boot('warn', 'הדפדפן אינו תומך בפריסת ZIP מקומית. אפשר להעלות קבצי txt בודדים, ' +
      'או להשתמש ב-Chrome/Edge 103+, Firefox 113+ או Safari 16.4+.');
  }

  window.addEventListener('error', function (e) {
    if (busy) { showMsg('err', 'שגיאה בלתי צפויה: ' + (e.message || e.type)); finish(); }
  });

  /* ================= בוררי שעות ================= */
  (function () {
    var f = $('fromHour'), t = $('toHour');
    for (var h = 0; h <= 27; h++) {
      var suf = h >= 24 ? '  (למחרת)' : '';
      f.add(new Option((h < 10 ? '0' + h : h) + ':00' + suf, h));
      t.add(new Option((h < 10 ? '0' + h : h) + ':59' + suf, h));
    }
    f.value = '6'; t.value = '9';
  })();

  $('filterBy').addEventListener('change', function () {
    var d = this.value === 'date';
    $('dateWrap').classList.toggle('hide', !d);
    $('dowWrap').classList.toggle('hide', d);
    markStale();
  });

  /* ================= בחירת קבצים ================= */
  var drop = $('drop'), input = $('file');
  drop.addEventListener('click', function () { input.click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) { takeFiles(e.dataTransfer.files); });
  input.addEventListener('change', function () { takeFiles(input.files); });

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  /* שני הצדדים באותה יחידה, שנבחרת לפי הגודל הכולל — כך המספר לא מחליף
     יחידה באמצע הריצה והעין יכולה לעקוב אחרי ההתקדמות. */
  function fmtPair(a, b) {
    var u = b >= 1073741824 ? [1073741824, 'GB', 2]
          : b >= 1048576 ? [1048576, 'MB', 0]
          : [1024, 'KB', 0];
    return (a / u[0]).toFixed(u[2]) + ' / ' + (b / u[0]).toFixed(u[2]) + ' ' + u[1];
  }
  function num(n) { return (n || 0).toLocaleString('he-IL'); }
  function fmtDur(s) {
    if (s < 0) return '';
    if (s < 60) return s + ' שנ׳';
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + ':' + (r < 10 ? '0' + r : r) + ' דק׳';
    return Math.floor(m / 60) + ' שע׳ ' + (m % 60) + ' דק׳';
  }

  function takeFiles(list) {
    var arr = Array.prototype.slice.call(list || []);
    if (!arr.length) return;
    var zip = arr.filter(function (f) { return /\.zip$/i.test(f.name); });
    var txt = arr.filter(function (f) { return /\.txt$/i.test(f.name); });
    if (!zip.length && !txt.length) { showMsg('err', 'לא זוהו קבצים מתאימים. צריך GTFS.zip או קבצי txt.'); return; }
    files = zip.length ? [zip[0]] : txt;
    var total = files.reduce(function (a, f) { return a + f.size; }, 0);
    $('fileInfo').className = 'ok';
    $('fileInfo').innerHTML = '<svg class="ic"><use href="#i-check"></use></svg> ' +
      (zip.length ? esc(zip[0].name) + ' (' + fmtBytes(zip[0].size) + ')'
                  : files.length + ' קבצים (' + fmtBytes(total) + ')');
    $('scan').disabled = FATAL;
    $('run').disabled = true;
    resetResults();
    clearMsgs();
  }

  /* ================= הודעות ================= */
  function clearMsgs() { $('msgs').innerHTML = ''; }
  function showMsg(kind, text) {
    var d = document.createElement('div');
    d.className = 'note ' + kind;
    d.innerHTML = '<svg class="ic lg"><use href="#i-' +
      (kind === 'err' ? 'alert-circle' : kind === 'warn' ? 'alert-triangle' :
       kind === 'ok' ? 'check' : 'info') + '"></use></svg><div>' + esc(text) + '</div>';
    $('msgs').appendChild(d);
    return d;
  }

  /* ================= איפוס מלא לפני הרצה (סעיף ט') ================= */
  function resetResults() {
    ROWS = []; STATS = null; detailRows = null; detailMeta = null; ROUTES = [];
    $('rBody').innerHTML = '';
    $('ttPanel').innerHTML = '';
    $('ttPanel').classList.add('hide');
    $('tbody').innerHTML = '';
    $('cards').innerHTML = '';
    $('results').classList.add('hide');
    $('export').disabled = true;
    $('resultWhen').textContent = '';
    closeDrawer();
    if (mapLayer) { mapLayer.clearLayers(); }
  }

  /* ================= הגדרות ================= */
  function readOpts() {
    var byDate = $('filterBy').value === 'date';
    var dateStr = null, day = null;
    if (byDate) {
      dateStr = $('dateSel').value;
      if (!dateStr || dateStr.length !== 8) { showMsg('err', 'בחר תאריך מתוך רשימת התאריכים של הפיד.'); return null; }
    } else {
      day = parseInt($('day').value, 10);
    }
    var from = parseInt($('fromHour').value, 10);
    var to = parseInt($('toHour').value, 10);
    if (to < from) { showMsg('err', 'שעת הסיום מוקדמת משעת ההתחלה.'); return null; }
    return {
      mode: $('mode').value, unit: $('unit').value,
      day: day, date: dateStr, fromHour: from, toHour: to,
      winOrigin: Math.max(0, parseInt($('winOrigin').value, 10) || 0),
      winMid: Math.max(0, parseInt($('winMid').value, 10) || 0),
      minCount: Math.max(2, parseInt($('minCount').value, 10) || 2),
      busLen: Math.max(1, parseFloat($('busLen').value) || 12),
      defaultLen: Math.max(1, parseFloat($('defaultLen').value) || 24),
      maxRows: 6000000, maxResults: 4000
    };
  }

  function markStale() {
    if (!STATS) return;
    $('staleNote').classList.remove('hide');
    $('staleNote').textContent = 'ההגדרות השתנו — לחץ "הרץ ניתוח" לעדכון.';
  }
  ['mode', 'unit', 'filterBy', 'dateSel', 'day', 'fromHour', 'toHour', 'winOrigin', 'winMid', 'minCount']
    .forEach(function (id) { $(id).addEventListener('change', markStale); });
  ['defaultLen', 'busLen'].forEach(function (id) {
    $(id).addEventListener('change', function () { if (STATS) render(); });
  });

  /* ================= Worker ================= */
  function ensureWorker() {
    if (worker) return true;
    try {
      worker = new Worker('worker.js');
      worker.onmessage = onWorker;
      worker.onerror = function (e) {
        e.preventDefault();
        showMsg('err', 'לא ניתן להפעיל את מנוע העיבוד: ' + (e.message || 'שגיאה לא ידועה') +
          (location.protocol === 'file:' ? ' — הדף חייב לרוץ דרך שרת ולא כקובץ מקומי.' : ''));
        finish();
        worker = null;
      };
      return true;
    } catch (err) {
      showMsg('err', 'לא ניתן להפעיל את מנוע העיבוד: ' + err.message);
      return false;
    }
  }

  function start(label) {
    busy = true;
    $('scan').disabled = true;
    $('run').disabled = true;
    $('export').disabled = true;
    $('stop').classList.remove('hide');
    $('staleNote').classList.add('hide');
    setProgress(-1, label);
  }
  function finish() {
    busy = false;
    $('scan').disabled = !files || FATAL;
    $('run').disabled = !COVERAGE;
    $('export').disabled = !STATS;
    $('stop').classList.add('hide');
    $('progress').classList.remove('on');
  }

  $('scan').addEventListener('click', function () {
    if (!files || !ensureWorker()) return;
    clearMsgs(); resetResults(); COVERAGE = null;
    start('סורק את הפיד…');
    worker.postMessage({ type: 'scan', files: files, opts: { unit: $('unit').value } });
  });

  $('run').addEventListener('click', function () {
    var opts = readOpts();
    if (!opts || !ensureWorker()) return;
    lastOpts = opts;
    clearMsgs(); resetResults();
    start('מתחיל ניתוח…');
    if (opts.mode === 'all') {
      showMsg('warn', 'מצב "כולל תחנות ביניים" קורא את כל stop_times.txt ועלול לקחת מספר דקות ' +
        'ולצרוך זיכרון רב בפידים גדולים. אפשר לעצור בכל רגע.');
    }
    worker.postMessage({ type: 'analyze', opts: opts });
  });

  $('stop').addEventListener('click', function () {
    if (!worker) return;
    $('stop').disabled = true;
    setProgress(-1, 'עוצר…');
    worker.postMessage({ type: 'cancel' });
    // אם ה-Worker לא הגיב תוך 4 שניות — מכבים אותו בכוח
    setTimeout(function () {
      if (busy && worker) {
        worker.terminate(); worker = null;
        COVERAGE = null; $('run').disabled = true;
        showMsg('warn', 'העיבוד הופסק בכוח. יש לסרוק את הפיד מחדש.');
        finish();
      }
      $('stop').disabled = false;
    }, 4000);
  });

  function setProgress(pct, text, extra) {
    $('progress').classList.add('on');
    var indet = pct < 0;
    $('progBarWrap').classList.toggle('indet', indet);
    if (!indet) $('progBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    var html = '<b>' + esc(text || '') + '</b>';
    if (extra) html += extra;
    $('progText').innerHTML = html;
  }

  function onWorker(e) {
    var m = e.data;

    if (m.type === 'progress') {
      if (m.p) {
        var p = m.p;
        var pct = p.total ? (p.bytes / p.total) * 100 : -1;
        var extra = '';
        if (pct >= 0) extra += '<span class="s-pct">' + Math.round(pct) + '%</span>';
        if (p.rows !== undefined) {
          extra += '<span class="s-rows"><svg class="ic"><use href="#i-file-text"></use></svg>' +
            '<span class="num">' + num(p.rows) + '</span>' +
            (p.estRows ? ' מתוך <span class="num">~' + num(p.estRows) + '</span>' : '') +
            ' שורות</span>';
        }
        if (p.total) extra += '<span class="s-bytes"><span class="num">' +
          fmtPair(p.bytes, p.total) + '</span></span>';
        // הכיתוב מעורב עברית ומספרים; כפיית direction:ltr הפכה את הסדר
        // ל-"שנ׳ 45", ולכן כאן משאירים זרימה טבעית ורק קובעים רוחב.
        if (p.eta > 0) extra += '<span class="s-eta"><svg class="ic"><use href="#i-clock"></use></svg>' +
          ' נותרו כ-' + fmtDur(p.eta) + '</span>';
        if (p.kept) extra += '<span class="s-kept"><span class="num">' + num(p.kept) +
          '</span> נשמרו</span>';
        setProgress(pct, p.text || '', extra);
      } else {
        setProgress(m.indeterminate ? -1 : 100, m.text || '');
      }

    } else if (m.type === 'scanned') {
      DIAG = m.diag; COVERAGE = m.coverage;
      renderFeedInfo(m.diag, m.coverage);
      (m.warnings || []).forEach(function (w) { showMsg('warn', w); });
      finish();
      $('run').disabled = false;
      $('feedInfo').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    } else if (m.type === 'result') {
      ROWS = m.rows; STATS = m.stats;
      (m.warnings || []).forEach(function (w) { showMsg('warn', w); });
      finish();
      $('results').classList.remove('hide');
      $('resultWhen').textContent = '— ' + describeWhen(lastOpts);
      document.querySelectorAll('.wo').forEach(function (n) { n.textContent = lastOpts.winOrigin; });
      document.querySelectorAll('.wm').forEach(function (n) { n.textContent = lastOpts.winMid; });
      render();
      // אבחנה אמפירית: פיד שאין בו ולו יציאה כפולה אחת הוא כמעט תמיד
      // הפיד המלא, שבו הנתון הזה פשוט לא קיים
      if (STATS.departures > 0 && !STATS.flagged) {
        showMsg('warn', 'נמצאו ' + num(STATS.departures) + ' יציאות, ואף אחת מהן אינה ' +
          'חופפת ליציאה אחרת מאותו רציף. ממצא זה מצביע על כך שהפיד אינו מכיל את ' +
          'נתוני היציאות הכפולות. לבדיקת עומס יש להוריד את הקובץ Gtfs_10_days.zip ' +
          'מכתובת gtfs.mot.gov.il/gtfsfiles ולסרוק שוב.');
      }
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });

    } else if (m.type === 'detail') {
      renderDetail(m);

    } else if (m.type === 'paths') {
      renderPaths(m);

    } else if (m.type === 'routes') {
      ROUTES = m.rows; RSEL.clear();
      finish();
      renderRoutes();

    } else if (m.type === 'timetable') {
      renderTimetable(m);

    } else if (m.type === 'export') {
      downloadCsv(m.csv, m.name);
      finish();

    } else if (m.type === 'sheet') {
      downloadBlob(m.html, m.name, 'text/html;charset=utf-8');
      finish();
      showMsg('ok', 'הלוח נוצר (' + m.days + ' ימים). פתח את הקובץ בדפדפן ולחץ ' +
        '"הדפסה / שמירה כ-PDF" כדי לקבל PDF מוכן להפצה.');

    } else if (m.type === 'aborted') {
      showMsg('warn', 'הפעולה בוטלה.');
      finish();

    } else if (m.type === 'error') {
      showMsg('err', m.message);
      finish();
    }
  }

  function describeWhen(o) {
    if (!o) return '';
    var when = o.date
      ? fmtDateHe(o.date) + ', יום ' + DAY_HE[dowOf(o.date)]
      : 'יום ' + DAY_HE[o.day] + ' (כל התאריכים)';
    return when + ' · ' + pad(o.fromHour) + ':00–' + pad(o.toHour) + ':59';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDateHe(s) { return s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4); }
  function dowOf(s) { return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getDay(); }

  /* ================= פרטי הפיד ================= */
  function renderFeedInfo(d, cov) {
    var kv = [
      ['מקור', esc(d.source)],
      ['תחנות', num(d.nStops)],
      ['קווים', num(d.nRoutes)],
      ['נסיעות', num(d.nTrips)],
      ['שירותים (service_id)', num(d.nServices)],
      ['גודל stop_times', fmtBytes(d.stopTimesBytes)],
      ['גודל shapes', d.shapesBytes ? fmtBytes(d.shapesBytes) : '— אין בפיד'],
      ['צורות מסלול נפרדות', num(d.nDistinctShapes)],
      ['רשומות מסוג station', num(d.nStationRecords)],
      ['רציפים עם parent_station', num(d.nWithParent)],
      ['שורות calendar', num(d.nCalendarRows) + (d.nServicesWithDayFlags ? '' : ' (ללא דגלי ימים)')],
      ['שורות calendar_dates', num(d.nCalendarDateRows)],
      ['טווח תאריכים', cov.min ? fmtDateHe(cov.min) + ' – ' + fmtDateHe(cov.max) : '—'],
      ['ימים עם שירות', num(cov.dates.length)]
    ];
    $('feedKv').innerHTML = kv.map(function (p) {
      return '<div><span>' + p[0] + '</span><b>' + p[1] + '</b></div>';
    }).join('');
    $('diagPre').textContent = JSON.stringify(d, null, 2);
    $('feedInfo').classList.add('on');

    // מילוי רשימת התאריכים
    var sel = $('dateSel');
    sel.innerHTML = '';
    if (!cov.dates.length) {
      sel.add(new Option('— לא נמצאו תאריכים עם שירות —', ''));
      $('filterBy').value = 'dow';
      $('dateWrap').classList.add('hide');
      $('dowWrap').classList.remove('hide');
    } else {
      cov.dates.forEach(function (x) {
        sel.add(new Option(fmtDateHe(x.date) + '  ·  יום ' + DAY_HE[x.dow] +
          '  ·  ' + num(x.trips) + ' נסיעות', x.date));
      });
      // ברירת מחדל: יום חול טיפוסי (הכי הרבה נסיעות)
      var best = cov.dates.reduce(function (a, b) { return b.trips > a.trips ? b : a; }, cov.dates[0]);
      sel.value = best.date;
      // אותם תאריכים משמשים גם את טווח הלוח לפרסום
      ['pubFrom', 'pubTo'].forEach(function (id) {
        var t = $(id); t.innerHTML = '';
        cov.dates.forEach(function (x) {
          t.add(new Option(fmtDateHe(x.date) + '  ·  יום ' + DAY_HE[x.dow], x.date));
        });
      });
      $('pubFrom').value = cov.dates[0].date;
      $('pubTo').value = cov.dates[cov.dates.length - 1].date;
      $('filterBy').value = 'date';
      $('dateWrap').classList.remove('hide');
      $('dowWrap').classList.add('hide');
    }
    if (cov.truncated) {
      showMsg('info', 'טווח התאריכים של הפיד ארוך מ-400 ימים; הרשימה נקטעה.');
    }
    // איזה פיד נטען: יציאות כפולות מופיעות בפועל רק ב-Gtfs_10_days
    if (/israel[-_ ]?public[-_ ]?transport/i.test(d.source || '')) {
      showMsg('warn', 'נטען הפיד המלא (' + esc(d.source) + '). קובץ זה אינו מכיל את ' +
        'נתוני היציאות הכפולות, ולכן ניתוח העומס יציג ערכים נמוכים מן המתוכנן בפועל, ' +
        'ולעיתים טבלה ריקה. לבדיקת עומס יש להשתמש בקובץ Gtfs_10_days.zip.');
    }

    // למה "רציפים עם תחנת אם" יוצא 0 — שאלה שעולה כמעט תמיד על הפיד הישראלי
    if (!d.nWithParent) {
      showMsg('info', 'אף תחנה בפיד אינה מצביעה על תחנת אם (parent_station ריק בכל השורות)' +
        (d.nStationRecords ? ', למרות שיש בו ' + num(d.nStationRecords) +
          ' רשומות המוגדרות כתחנה (location_type=1). הפיד מגדיר תחנות אך אינו מקשר אליהן רציפים'
          : '') +
        '. לכן "תחנת אם" ו"רציף בודד" יתנהגו זהה, וכל רציף נספר בנפרד — ' +
        'וזה גם הפירוש הנכון לצורך בדיקת עומס על רציף.');
    }
  }

  /* ================= דירוג ================= */
  function lenOf(r) {
    return LENS[r.stopId] !== undefined ? LENS[r.stopId] : (parseFloat($('defaultLen').value) || 24);
  }
  function capOf(r) { return Math.max(1, Math.floor(lenOf(r) / (parseFloat($('busLen').value) || 12))); }
  function gradeOf(r) {
    var c = capOf(r);
    if (r.maxExact > c) return 'a';
    if (r.winOrg > c || r.winAll > c) return 'b';
    return 'ok';
  }
  function peakOf(r) { return Math.max(r.maxExact, r.winOrg, r.winAll); }
  function needOf(r) { return peakOf(r) * (parseFloat($('busLen').value) || 12); }

  /* ================= טבלה ================= */
  var GRADE_LABEL = { a: 'רמה א׳', b: 'רמה ב׳', ok: 'תקין' };
  var GRADE_COLOR = { a: '#dc2626', b: '#d97706', ok: '#16a34a' };

  function visibleRows() {
    var q = $('q').value.trim(), gf = $('gradeFilter').value, tf = $('typeFilter').value;
    var out = ROWS.filter(function (r) {
      var g = gradeOf(r);
      if (gf === 'a' && g !== 'a') return false;
      if (gf === 'ab' && g === 'ok') return false;
      if (tf === 'origin' && !r.nOrigin) return false;
      if (tf === 'mid' && r.nOrigin) return false;
      if (q && (r.name + ' ' + r.city + ' ' + r.code + ' ' + r.stopId + ' ' + r.street).indexOf(q) === -1) return false;
      return true;
    });
    var get = { grade: function (r) { return { a: 2, b: 1, ok: 0 }[gradeOf(r)]; },
      name: function (r) { return r.name; }, len: lenOf, cap: capOf, need: needOf };
    out.sort(function (x, y) {
      var f = get[sortKey];
      var a = f ? f(x) : x[sortKey], b = f ? f(y) : y[sortKey];
      var c = (typeof a === 'string') ? a.localeCompare(b, 'he') : (a - b);
      if (!c) c = y.maxExact - x.maxExact || y.winOrg - x.winOrg;
      return sortAsc ? c : -c;
    });
    return out;
  }

  function render() {
    var rows = visibleRows();
    var nA = 0, nB = 0;
    ROWS.forEach(function (r) { var g = gradeOf(r); if (g === 'a') nA++; else if (g === 'b') nB++; });

    $('cards').innerHTML =
      card(num(STATS.units), 'יחידות ניתוח נבדקו') +
      card(num(STATS.departures), 'יציאות בטווח') +
      card(num(nA), 'תחנות ברמה א׳', 'a') +
      card(num(nB), 'תחנות ברמה ב׳', 'b') +
      card(num(rows.length), 'מוצגות כעת');

    var html = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], g = gradeOf(r);
      html.push('<tr data-u="' + r.u + '">' +
        '<td><span class="tag ' + g + '">' + GRADE_LABEL[g] + '</span></td>' +
        '<td class="name">' + esc(r.name) +
          (r.platform ? ' <span class="tag n">רציף ' + esc(r.platform) + '</span>' : '') +
          '<small>' + esc(r.city || '') + (r.street ? ' · ' + esc(r.street) : '') +
          ' · קוד ' + esc(r.code || r.stopId) + '</small></td>' +
        '<td class="num">' + big(r.maxExact, g === 'a') +
          (r.exactAt >= 0 && r.maxExact > 1 ? '<small>' + fmtB(r.exactAt) + '</small>' : '') + '</td>' +
        '<td class="num">' + (r.nOrigin ? r.winOrg +
          (r.winOrgAt >= 0 && r.winOrg > 1 ? '<small>' + fmtB(r.winOrgAt) + '</small>' : '')
          : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td class="num">' + r.winAll +
          (r.winAllAt >= 0 && r.winAll > 1 ? '<small>' + fmtB(r.winAllAt) + '</small>' : '') + '</td>' +
        '<td class="num">' + r.n + '</td>' +
        '<td class="num">' + r.nOrigin + '</td>' +
        '<td><input class="len" type="number" min="6" step="1" value="' + lenOf(r) +
          '" data-stop="' + esc(r.stopId) + '" title="אורך התחנה במטרים"></td>' +
        '<td class="num">' + capOf(r) + '</td>' +
        '<td class="num">' + needOf(r) + '</td></tr>');
    }
    $('tbody').innerHTML = html.join('') ||
      '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:26px">אין תוצאות התואמות לסינון.</td></tr>';

    document.querySelectorAll('thead th').forEach(function (th) {
      th.classList.toggle('sorted', th.dataset.k === sortKey);
      th.classList.toggle('asc', th.dataset.k === sortKey && sortAsc);
    });
    if (mapReady && $('mapWrap').classList.contains('on')) drawMap(rows);
  }

  function big(v, hot) { return '<span' + (hot ? ' style="color:var(--a)"' : '') + '>' + v + '</span>'; }
  function card(v, l, cls) {
    return '<div class="card' + (cls ? ' ' + cls : '') + '"><b>' + v + '</b><span>' + l + '</span></div>';
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(sec) { return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor((sec % 3600) / 60)); }
  /* אותה שעה, אבל מבודדת לכיווניות — כדי שהנקודתיים והמקף לא יתהפכו בעברית */
  function fmtB(sec) { return '<bdi class="tnum">' + fmt(sec) + '</bdi>'; }
  function fmtSec(sec) {
    var s = sec % 60;
    return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor((sec % 3600) / 60)) + (s ? ':' + pad(s) : '');
  }

  /* מיון רק בטבלת התוצאות הראשית — לא בטבלת הקווים שאין לה data-k */
  document.querySelectorAll('thead th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.dataset.k;
      if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
      render();
    });
  });
  ['q', 'gradeFilter', 'typeFilter'].forEach(function (id) { $(id).addEventListener('input', render); });

  $('tbody').addEventListener('change', function (e) {
    var el = e.target;
    if (!el.classList.contains('len')) return;
    var v = parseFloat(el.value), stop = el.dataset.stop;
    if (isNaN(v) || v <= 0) delete LENS[stop]; else LENS[stop] = v;
    saveLens(); render();
  });
  $('tbody').addEventListener('click', function (e) {
    if (e.target.classList.contains('len')) return;
    var tr = e.target.closest('tr');
    if (!tr || !tr.dataset.u || !worker) return;
    worker.postMessage({ type: 'detail', u: parseInt(tr.dataset.u, 10) });
  });

  /* ================= מפה ================= */
  $('tabTable').addEventListener('click', function () { showTab('table'); });
  $('tabMap').addEventListener('click', function () { showTab('map'); });

  function showTab(t) {
    $('tabTable').classList.toggle('on', t === 'table');
    $('tabMap').classList.toggle('on', t === 'map');
    $('tabRoutes').classList.toggle('on', t === 'routes');
    $('tblWrap').classList.toggle('hide', t !== 'table');
    $('mapWrap').classList.toggle('on', t === 'map');
    $('routesWrap').classList.toggle('hide', t !== 'routes');
    if (t === 'map') {
      initMap();
      setTimeout(function () { if (map) { map.invalidateSize(); drawMap(visibleRows()); } }, 60);
    } else if (t === 'routes' && !ROUTES.length && worker) {
      setProgress(-1, 'בונה לוחות זמנים לכל הקווים…');
      busy = true;
      worker.postMessage({ type: 'routes' });
    }
  }

  function initMap() {
    if (mapReady || typeof L === 'undefined') return;
    map = L.map('map', { preferCanvas: true }).setView([31.8, 35.0], 8);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
    // ככל שמתרחקים, העיגולים מתכווצים — כך נוצרת "מפת חום" של אזורי צפיפות
    map.on('zoomend', function () { if (mapLayer) drawMap(visibleRows(), false); });
    var legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      var d = L.DomUtil.create('div', 'maplegend');
      d.innerHTML = '<i style="background:' + GRADE_COLOR.a + '"></i>רמה א׳ — אותה דקה<br>' +
        '<i style="background:' + GRADE_COLOR.b + '"></i>רמה ב׳ — חלון חפיפה<br>' +
        '<i style="background:' + GRADE_COLOR.ok + '"></i>בגבול הקיבולת<br>' +
        '<span style="color:var(--muted)">גודל העיגול = מספר היציאות בשיא</span>';
      return d;
    };
    legend.addTo(map);
    mapReady = true;
  }

  /* גודל הסימון תלוי גם בעומס וגם ברמת הזום */
  function radiusFor(peak) {
    var z = map ? map.getZoom() : 12;
    var f = Math.max(0.28, Math.min(1.35, (z - 5) / 8));
    return Math.max(1.6, Math.min(22, (3 + peak * 1.5) * f));
  }

  function drawMap(rows, fit) {
    if (!mapReady) return;
    mapLayer.clearLayers();
    var pts = [];
    rows.forEach(function (r) {
      if (isNaN(r.lat) || isNaN(r.lon) || (!r.lat && !r.lon)) return;
      var g = gradeOf(r), peak = peakOf(r);
      var m = L.circleMarker([r.lat, r.lon], {
        radius: radiusFor(peak),
        color: '#fff', weight: 1.2, opacity: .9,
        fillColor: GRADE_COLOR[g], fillOpacity: g === 'ok' ? .45 : .78
      });
      m.bindPopup(
        '<b>' + esc(r.name) + (r.platform ? ' — רציף ' + esc(r.platform) : '') + '</b><br>' +
        esc(r.city || '') + ' · קוד ' + esc(r.code || r.stopId) + '<br>' +
        '<span style="color:' + GRADE_COLOR[g] + ';font-weight:700">' + GRADE_LABEL[g] + '</span> · ' +
        'רמה א׳: ' + r.maxExact + ' · מוצא: ' + r.winOrg + ' · כללי: ' + r.winAll + '<br>' +
        'סה"כ ' + r.n + ' יציאות · קיבולת ' + capOf(r) + '<br>' +
        '<a href="#" data-u="' + r.u + '" class="popdet">פירוט היציאות ←</a>');
      m.addTo(mapLayer);
      pts.push([r.lat, r.lon]);
    });
    // ממרכזים רק כשקבוצת התחנות השתנתה. אחרת כל שינוי זום היה מחזיר
    // את המפה למסגרת המקורית והמשתמש לא היה מצליח להתרחק.
    if (fit !== false && pts.length) {
      try { map.fitBounds(pts, { padding: [30, 30], maxZoom: 14 }); } catch (e) {}
    }
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a.popdet');
    if (!a) return;
    e.preventDefault();
    if (worker) worker.postMessage({ type: 'detail', u: parseInt(a.dataset.u, 10) });
  });

  /* ================= מגירת פירוט ================= */
  $('dClose').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  function closeDrawer() {
    var d = $('drawer');
    // הפוקוס חייב לצאת מהמגירה לפני שהיא מוסתרת, אחרת הדפדפן מתריע
    // "Blocked aria-hidden on an element because its descendant retained focus".
    if (d.contains(document.activeElement)) document.activeElement.blur();
    d.classList.remove('open');
    $('backdrop').classList.remove('open');
    d.inert = true;
    d.removeAttribute('aria-hidden');
    if (typeof stopMeasuring === 'function') stopMeasuring();
  }
  function openDrawer() {
    var d = $('drawer');
    d.inert = false;
    d.removeAttribute('aria-hidden');
    d.classList.add('open');
    $('backdrop').classList.add('open');
  }
  ['dPlat', 'dType', 'dOnly', 'dSort'].forEach(function (id) {
    $(id).addEventListener('change', function () { if (detailRows) paintDetail(); });
  });

  function renderDetail(m) {
    detailRows = m.rows; detailMeta = m.meta;
    detailMeta.u = m.u;
    var meta = m.meta;
    $('dTitle').textContent = meta.name + (meta.platform ? ' — רציף ' + meta.platform : '');
    $('dSub').innerHTML = esc([meta.city, meta.street, 'קוד ' + (meta.code || meta.stopId)]
      .filter(Boolean).join(' · ')) + '<br><b>' + esc(describeWhen(lastOpts)) + '</b>';

    // רשימת רציפים/תחנות פנימיות
    var seen = new Map();
    detailRows.forEach(function (r) {
      if (!seen.has(r.stopId)) {
        seen.set(r.stopId, (r.platform ? 'רציף ' + r.platform : r.stopName) +
          ' (' + (r.stopCode || r.stopId) + ')');
      }
    });
    var sel = $('dPlat');
    sel.innerHTML = '<option value="">הכול (' + seen.size + ')</option>';
    seen.forEach(function (label, id) { sel.add(new Option(label, id)); });
    sel.parentElement.style.display = seen.size > 1 ? '' : 'none';

    paintDetail();
    openDrawer();
    $('dBody').scrollTop = 0;
  }

  /* מה עוד קורה בקו הזה סביב היציאה — כדי לדעת אם אפשר להזיז אותה */
  function routeCtxHtml(r) {
    var c = r.ctx;
    if (!c || c.idx < 0) return '';
    var gapBefore = c.prev ? Math.round((c.here.t - c.prev.t) / 60) : null;
    var gapAfter = c.next ? Math.round((c.next.t - c.here.t) / 60) : null;
    var seq = [];
    if (c.prev2) seq.push(ctxSlot(c.prev2, false));
    if (c.prev) seq.push(ctxSlot(c.prev, false));
    seq.push(ctxSlot(c.here, true));
    if (c.next) seq.push(ctxSlot(c.next, false));
    if (c.next2) seq.push(ctxSlot(c.next2, false));
    return '<div class="ctxbox">' +
      '<b>הקו לאורך היום:</b> ' + (c.total === 1 ? 'יציאה אחת' : c.total + ' יציאות') + ' מהמוצא, ' +
      '<bdi class="tnum">' + fmt(c.first) + '–' + fmt(c.last) + '</bdi>' + '<br>' +
      '<b>סביב היציאה הזו במוצא:</b> ' + seq.join(' · ') +
      (gapBefore !== null || gapAfter !== null
        ? '<br><b>מרווחים:</b> ' +
          (gapBefore !== null ? gapBefore + ' דק׳ אחורה' : '—') + ' · ' +
          (gapAfter !== null ? gapAfter + ' דק׳ קדימה' : '—')
        : '') +
      '</div>';
  }
  /* מיקום התחנה במסלול: X מתוך Y, בצבע ליניארי ירוק→אדום, עם ציר בהובר */
  function seqChip(r) {
    if (r.origin) return '<span class="tag b">מוצא</span>';
    var first = r.seqFirst || 1, last = r.seqLast || r.seq || 1;
    var span = Math.max(1, last - first);
    var pos = Math.max(0, Math.min(1, (r.seq - first) / span));
    var idx = (r.seq - first) + 1, total = (last - first) + 1;
    return '<span class="seqchip" tabindex="0" style="background:' + seqColor(pos) + '">' +
      idx + '/' + total +
      '<span class="seqpop">תחנה <b>' + idx + '</b> מתוך <b>' + total + '</b> במסלול' +
      ' — ' + Math.round(pos * 100) + '% מהדרך' +
      '<span class="seqaxis"><span class="track"></span>' +
      '<span class="mk" style="inset-inline-end:' + (pos * 100).toFixed(1) + '%"></span></span>' +
      '<span class="seqends"><span>מוצא</span><span>סוף מסלול</span></span>' +
      '</span></span>';
  }
  /* ירוק → צהוב → כתום → אדום */
  function seqColor(p) {
    var stops = [[0, 22, 163, 74], [0.4, 234, 179, 8], [0.7, 249, 115, 22], [1, 220, 38, 38]];
    for (var i = 1; i < stops.length; i++) {
      if (p <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i];
        var f = (p - a[0]) / (b[0] - a[0] || 1);
        return 'rgb(' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
          Math.round(a[2] + (b[2] - a[2]) * f) + ',' +
          Math.round(a[3] + (b[3] - a[3]) * f) + ')';
      }
    }
    return 'rgb(220,38,38)';
  }

  function ctxSlot(g, isNow) {
    return '<span class="' + (isNow ? 'now' : '') + '">' + fmtB(g.t) +
      (g.count > 1 ? '×' + g.count : '') + '</span>';
  }

  function filteredDetail() {
    var plat = $('dPlat').value, type = $('dType').value;
    return detailRows.filter(function (r) {
      if (plat && r.stopId !== plat) return false;
      if (type === 'origin' && !r.origin) return false;
      if (type === 'mid' && r.origin) return false;
      return true;
    }).sort(function (a, b) { return a.t - b.t || (a.line + '').localeCompare(b.line + '', 'he'); });
  }
  function groupByMinute(rows) {
    var groups = [], cur = null;
    rows.forEach(function (r) {
      var mk = Math.floor(r.t / 60);
      if (!cur || cur.min !== mk) { cur = { min: mk, rows: [] }; groups.push(cur); }
      cur.rows.push(r);
    });
    return groups;
  }

  function paintDetail() {
    var only = $('dOnly').value;
    var rows = filteredDetail();
    var groups = groupByMinute(rows);

    var Wo = lastOpts.winOrigin, Wm = lastOpts.winMid;
    var shown = groups.filter(function (g) { return only !== 'multi' || g.rows.length > 1; });
    if ($('dSort').value === 'load') {
      shown = shown.slice().sort(function (a, b) { return b.rows.length - a.rows.length || a.min - b.min; });
    }

    var html = [];
    if (!shown.length) {
      html.push('<div style="padding:30px;text-align:center;color:var(--muted)">' +
        (groups.length ? 'אין דקה עם יותר מיציאה אחת בסינון הזה.' : 'אין יציאות בסינון הזה.') + '</div>');
    }
    shown.forEach(function (g) {
      var n = g.rows.length;
      // רמת חומרה של הדקה
      var lv = '';
      if (n > 1) lv = 'lvA';
      else {
        var W = g.rows[0].origin ? Wo : Wm;
        var near = groups.filter(function (o) { return Math.abs(o.min - g.min) <= W; })
          .reduce(function (s, o) { return s + o.rows.length; }, 0);
        if (near > 1) lv = 'lvB';
      }
      var nOrg = g.rows.filter(function (r) { return r.origin; }).length;
      html.push('<div class="mingrp ' + lv + '"><div class="hd">' +
        '<svg class="ic"><use href="#i-clock"></use></svg>' +
        '<span class="t">' + fmtB(g.min * 60) + '</span>' +
        '<span>' + (n === 1 ? 'יציאה אחת' : n + ' יציאות') +
          (nOrg && nOrg !== n ? ' · ' + nOrg + ' מוצא' : '') + '</span>' +
        '<button class="sm showpaths" data-min="' + g.min + '" style="margin-inline-start:auto">' +
        '<svg class="ic"><use href="#i-map"></use></svg> מסלולים</button>' +
        (n > 1 ? '<span class="tag a">חפיפה</span>' : '') +
        '</div><table><tbody>');
      g.rows.forEach(function (r) {
        html.push('<tr><td style="width:52px" class="num">' + fmtSec(r.t) + '</td>' +
          '<td style="width:52px"><b>' + esc(r.line) + '</b></td>' +
          '<td style="width:74px">' + esc(r.agency) + '</td>' +
          '<td style="white-space:normal">' + esc(r.headsign || r.lineLong) +
            (r.platform ? ' <span class="tag n">רציף ' + esc(r.platform) + '</span>' : '') +
            '<br><span class="tid">' + esc(r.tripId) + '</span>' +
            (r.makat ? ' <span class="tid">' + esc(r.makat) + '</span>' : '') + '</td>' +
          '<td style="width:96px">' + seqChip(r) + '</td></tr>');
        var ctx = routeCtxHtml(r);
        if (ctx) html.push('<tr class="ctxrow"><td colspan="5">' + ctx + '</td></tr>');
      });
      html.push('</tbody></table></div>');
    });

    html.push('<div class="legend" style="padding:14px 18px">' +
      'כותרת אדומה — יותר מיציאה אחת באותה דקה (רמה א׳). כותרת כתומה — יציאה בודדת שנמצאת ' +
      'בתוך חלון רמה ב׳ של יציאה סמוכה.<br>' +
      'מוצגות ' + shown.length + ' מתוך ' + groups.length + ' דקות · ' + rows.length + ' יציאות.<br>' +
      'ה-trip_id מוצג לצד כל יציאה לצורך אימות מול מערכות אחרות.<br>' +
      'תיבת ההקשר מציגה את שעות היציאה של אותו קו <b>מתחנת המוצא שלו</b> — ' +
      'לא את השעות בתחנה הזו — כדי לבחון אם אפשר להזיז את הנסיעה קדימה או אחורה.<br>' +
      'התגית הצבעונית = מיקום התחנה במסלול (תחנה X מתוך Y). ' +
      '<b>ככל שהתחנה רחוקה יותר מהמוצא, שעת ההגעה משוערת יותר</b> — ירוק קרוב למוצא, ' +
      'אדום קרוב לסוף המסלול. מעבר עכבר מציג את המיקום על ציר.</div>');

    $('dBody').innerHTML = html.join('');
  }


  $('dBody').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button.showpaths');
    if (!b) return;
    var min = parseInt(b.dataset.min, 10);
    var trips = filteredDetail()
      .filter(function (r) { return Math.floor(r.t / 60) === min; })
      .map(function (r) { return r.tripIdx; })
      .filter(function (v) { return v !== undefined && v !== null; });
    requestPaths(min, trips);
  });

  /* ============ פאנל המפה במגירה: מיקום, מדידה ומסלולים ============ */
  var dMap = null, dLayerStop = null, dLayerMeasure = null, dLayerRoutes = null;
  var mPts = [], mLen = 0, measuring = false;
  var pathRows = [], pathVisible = {}, pathFocus = null;
  var ROUTE_COLORS = ['#1d4ed8', '#b45309', '#15803d', '#7c3aed', '#be123c',
    '#0e7490', '#a16207', '#4d7c0f', '#9333ea', '#c2410c'];

  function ensureDrawerMap() {
    if (dMap) return dMap;
    dMap = L.map('dMap', { zoomControl: true, preferCanvas: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, maxNativeZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(dMap);
    dLayerStop = L.layerGroup().addTo(dMap);
    dLayerRoutes = L.layerGroup().addTo(dMap);
    dLayerMeasure = L.layerGroup().addTo(dMap);
    dMap.on('click', function (e) { if (measuring) addMeasurePoint(e.latlng); });
    return dMap;
  }

  function openSidePane(zoom) {
    $('dSide').classList.add('on');
    $('dMapToggle').innerHTML = '<svg class="ic"><use href="#i-map"></use></svg> הסתר מפה';
    ensureDrawerMap();
    if (detailMeta && !isNaN(detailMeta.lat) && !isNaN(detailMeta.lon)) {
      dLayerStop.clearLayers();
      L.circleMarker([detailMeta.lat, detailMeta.lon],
        { radius: 6, color: '#fff', weight: 2, fillColor: '#1d4ed8', fillOpacity: 1 })
        .bindTooltip(detailMeta.name, { permanent: false }).addTo(dLayerStop);
      dMap.setView([detailMeta.lat, detailMeta.lon], zoom || 17);
    }
    setTimeout(function () { if (dMap) dMap.invalidateSize(); }, 80);
  }
  function closeSidePane() {
    $('dSide').classList.remove('on');
    $('dMapToggle').innerHTML = '<svg class="ic"><use href="#i-map"></use></svg> הצג מפה';
    stopMeasuring();
  }

  $('dMapToggle').addEventListener('click', function () {
    if ($('dSide').classList.contains('on')) closeSidePane();
    else { openSidePane(17); setSideMode('מיקום התחנה'); }
  });

  $('dCtxToggle').addEventListener('click', function () {
    var off = document.body.classList.toggle('noctx');
    this.innerHTML = '<svg class="ic"><use href="#i-info"></use></svg> ' +
      (off ? 'הצג הקשר קו' : 'הסתר הקשר קו');
  });

  function setSideMode(t) { $('dSideMode').textContent = t; }

  /* ---------- מדידה ---------- */
  $('dMeasureBtn').addEventListener('click', function () {
    if (measuring) { stopMeasuring(); return; }
    if (!detailMeta || isNaN(detailMeta.lat) || isNaN(detailMeta.lon)) {
      showMsg('warn', 'אין קואורדינטות לתחנה הזו, ולכן אי אפשר למדוד אותה.');
      return;
    }
    openSidePane(19);
    measuring = true;
    setSideMode('מדידה');
    $('dMeasureBtn').classList.add('primary');
    $('dMeasureSave').classList.remove('hide');
    $('dMeasureClear').classList.remove('hide');
    clearMeasure();
  });
  function stopMeasuring() {
    measuring = false;
    $('dMeasureBtn').classList.remove('primary');
    $('dMeasureSave').classList.add('hide');
    $('dMeasureClear').classList.add('hide');
    $('dMeasureVal').textContent = '';
    $('dMeasureHint').textContent = '';
    if (dLayerMeasure) dLayerMeasure.clearLayers();
    mPts = []; mLen = 0;
    setSideMode('מיקום התחנה');
  }
  function addMeasurePoint(ll) {
    mPts.push([ll.lat, ll.lng]);
    L.circleMarker(ll, { radius: 4, color: '#b91c1c', fillColor: '#fff', fillOpacity: 1 })
      .addTo(dLayerMeasure);
    if (mPts.length > 1) {
      mLen = 0;
      for (var i = 1; i < mPts.length; i++) mLen += haversine(mPts[i - 1], mPts[i]);
      L.polyline(mPts, { color: '#b91c1c', weight: 3 }).addTo(dLayerMeasure);
      L.marker(mPts[mPts.length - 1], { icon: L.divIcon({ className: '',
        html: '<span class="measure-lbl">' + mLen.toFixed(1) + ' מ׳</span>' }) }).addTo(dLayerMeasure);
    }
    $('dMeasureVal').textContent = mLen.toFixed(1) + ' מ׳';
    $('dMeasureHint').textContent = mPts.length < 2
      ? 'סמן נקודה נוספת בקצה השני'
      : Math.floor(mLen / (parseFloat($('busLen').value) || 12)) + ' אוטובוסים';
    $('dMeasureSave').disabled = mLen <= 0;
  }
  function haversine(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function clearMeasure() {
    if (dLayerMeasure) dLayerMeasure.clearLayers();
    mPts = []; mLen = 0;
    $('dMeasureVal').textContent = '0 מ׳';
    $('dMeasureHint').textContent = 'לחץ על המפה כדי לסמן את קצות התחנה';
    $('dMeasureSave').disabled = true;
  }
  $('dMeasureClear').addEventListener('click', clearMeasure);
  $('dMeasureSave').addEventListener('click', function () {
    if (!detailMeta || mLen <= 0) return;
    LENS[detailMeta.stopId] = Math.round(mLen * 10) / 10;
    saveLens(); render();
    showMsg('ok', 'נשמר: ' + mLen.toFixed(1) + ' מ׳ לתחנה ' + detailMeta.name +
      ' (קיבולת ' + Math.max(1, Math.floor(mLen / (parseFloat($('busLen').value) || 12))) + ').');
    stopMeasuring();
  });

  /* ---------- מסלולי הקווים של דקה נבחרת (סעיף ה') ---------- */
  function requestPaths(minute, trips) {
    if (!worker) return;
    openSidePane(14);
    setSideMode('מסלולים · ' + fmt(minute * 60));
    $('dRouteList').classList.remove('hide');
    $('dRouteList').innerHTML = '<span class="hint">טוען מסלולים…</span>';
    worker.postMessage({ type: 'paths', u: detailMeta.u, minute: minute, trips: trips });
  }

  function renderPaths(m) {
    pathRows = m.rows || [];
    pathVisible = {}; pathFocus = null;
    dLayerRoutes.clearLayers();
    if (!pathRows.length) {
      $('dRouteList').innerHTML = '<span class="hint">' +
        esc(m.note || 'לא נמצאו מסלולים להצגה.') + '</span>';
      return;
    }
    pathRows.forEach(function (p, i) { pathVisible[i] = true; });
    $('dRouteList').innerHTML = pathRows.map(function (p, i) {
      return '<label><input type="checkbox" data-i="' + i + '" checked>' +
        '<span class="sw" style="background:' + ROUTE_COLORS[i % ROUTE_COLORS.length] + '"></span>' +
        '<b>' + esc(p.line) + '</b> ' + esc(p.agency) +
        ' <span class="hint" style="margin:0">' + p.pts.length + ' תחנות</span></label>';
    }).join('') + (m.note ? '<div class="hint">' + esc(m.note) + '</div>' : '');
    drawPaths();
  }

  function drawPaths() {
    dLayerRoutes.clearLayers();
    var all = [];
    pathRows.forEach(function (p, i) {
      if (!pathVisible[i]) return;
      var dim = pathFocus !== null && pathFocus !== i;
      var pts = p.pts.map(function (x) { return [x.lat, x.lon]; });
      if (pts.length < 2) return;
      L.polyline(pts, {
        color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        weight: dim ? 2 : 4, opacity: dim ? 0.25 : 0.85
      }).bindTooltip('קו ' + p.line + ' · ' + p.headsign).addTo(dLayerRoutes);
      if (!dim) all = all.concat(pts);
    });
    if (all.length) { try { dMap.fitBounds(all, { padding: [20, 20] }); } catch (e) {} }
  }

  $('dRouteList').addEventListener('change', function (e) {
    if (e.target.type !== 'checkbox') return;
    pathVisible[e.target.dataset.i] = e.target.checked;
    drawPaths();
  });
  $('dRouteList').addEventListener('mouseover', function (e) {
    var l = e.target.closest('label');
    if (!l) return;
    pathFocus = parseInt(l.querySelector('input').dataset.i, 10);
    drawPaths();
  });
  $('dRouteList').addEventListener('mouseleave', function () { pathFocus = null; drawPaths(); });

  /* ---------- ייצוא התחנה ---------- */
  $('dExportCsv').addEventListener('click', function () {
    if (!worker || !detailMeta) return;
    busy = true;
    setProgress(-1, 'בונה CSV לתחנה…');
    worker.postMessage({ type: 'exportStop', u: detailMeta.u });
  });

  $('dExportPng').addEventListener('click', function () { exportDrawerPng(); });

  /* מצייר את כל היציאות של התחנה לתמונה אחת. כתיבה ידנית על canvas
     במקום ספריית צילום — פלט צפוי, RTL נכון, ובלי תלות חיצונית. */
  function exportDrawerPng() {
    if (!detailRows || !detailMeta) return;
    var rows = filteredDetail();
    if (!rows.length) { showMsg('warn', 'אין יציאות להצגה בסינון הנוכחי.'); return; }
    var groups = groupByMinute(rows);

    var W = 1100, pad = 26, rowH = 26, hdrH = 30, titleH = 86;
    var H = titleH + groups.reduce(function (a, g) { return a + hdrH + g.rows.length * rowH + 8; }, 0) + pad + 34;
    var c = document.createElement('canvas');
    var dpr = 2;
    c.width = W * dpr; c.height = H * dpr;
    var x = c.getContext('2d');
    x.scale(dpr, dpr);
    x.direction = 'rtl';
    x.textBaseline = 'middle';
    var bg = '#ffffff', ink = '#141821', muted = '#5c6675', line = '#e3e7ec';
    x.fillStyle = bg; x.fillRect(0, 0, W, H);

    var right = W - pad;
    x.fillStyle = ink; x.font = 'bold 22px "Segoe UI", Arial, sans-serif';
    x.fillText(detailMeta.name + (detailMeta.platform ? ' — רציף ' + detailMeta.platform : ''), right, 30);
    x.fillStyle = muted; x.font = '13px "Segoe UI", Arial, sans-serif';
    x.fillText([detailMeta.city, detailMeta.street, 'קוד ' + (detailMeta.code || detailMeta.stopId)]
      .filter(Boolean).join(' · '), right, 54);
    x.fillStyle = ink; x.font = 'bold 14px "Segoe UI", Arial, sans-serif';
    x.fillText(describeWhen(lastOpts), right, 74);

    var cols = [0, 90, 165, 300, 760, 1000];  // מרווחים מימין
    var y = titleH;
    groups.forEach(function (g) {
      var multi = g.rows.length > 1;
      x.fillStyle = multi ? '#fee2e2' : '#f6f7f9';
      x.fillRect(pad, y, W - pad * 2, hdrH);
      x.fillStyle = multi ? '#b91c1c' : ink;
      x.font = 'bold 15px "Segoe UI", Arial, sans-serif';
      x.fillText(fmt(g.min * 60) + '  ·  ' +
        (g.rows.length === 1 ? 'יציאה אחת' : g.rows.length + ' יציאות') +
        (multi ? '  ·  חפיפה' : ''), right - 8, y + hdrH / 2);
      y += hdrH;
      g.rows.forEach(function (r, i) {
        if (i % 2) { x.fillStyle = '#fafbfc'; x.fillRect(pad, y, W - pad * 2, rowH); }
        x.font = '13px "Segoe UI", Arial, sans-serif';
        x.fillStyle = ink;
        x.fillText(fmtSec(r.t), right - 8, y + rowH / 2);
        x.font = 'bold 13px "Segoe UI", Arial, sans-serif';
        x.fillText(r.line, right - cols[1], y + rowH / 2);
        x.font = '13px "Segoe UI", Arial, sans-serif';
        x.fillStyle = muted;
        x.fillText(r.agency, right - cols[2], y + rowH / 2);
        x.fillStyle = ink;
        var dest = (r.headsign || r.lineLong || '').slice(0, 46);
        x.fillText(dest, right - cols[3], y + rowH / 2);
        x.fillStyle = muted;
        x.font = '11px "Segoe UI", Arial, sans-serif';
        x.fillText(r.origin ? 'מוצא' : 'תחנה ' + ((r.seq - (r.seqFirst || 1)) + 1) +
          '/' + (((r.seqLast || r.seq) - (r.seqFirst || 1)) + 1), right - cols[4], y + rowH / 2);
        x.fillStyle = '#9aa3ad';
        x.fillText(r.tripId, right - cols[5], y + rowH / 2);
        y += rowH;
      });
      x.strokeStyle = line; x.lineWidth = 1;
      x.beginPath(); x.moveTo(pad, y + 0.5); x.lineTo(W - pad, y + 0.5); x.stroke();
      y += 8;
    });

    x.fillStyle = muted; x.font = '12px "Segoe UI", Arial, sans-serif';
    x.fillText('הופק מקובץ GTFS · ' + rows.length + ' יציאות · ' + groups.length + ' דקות', right, H - 20);

    c.toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'stop-' + (detailMeta.code || detailMeta.stopId) + '-' +
        (lastOpts && lastOpts.date ? lastOpts.date : 'day') + '.png';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }, 'image/png');
  }

  /* ================= לשונית לוחות זמנים (סעיף ט') ================= */
  var ROUTES = [];

  $('tabRoutes').addEventListener('click', function () { showTab('routes'); });

  var RSEL = new Set();   // קווים שסומנו ידנית בתוצאות החיפוש

  $('rq').addEventListener('input', renderRoutes);
  $('rFilter').addEventListener('change', renderRoutes);

  /* סימון/ניקוי של כל התוצאות המוצגות כרגע */
  $('rAll').addEventListener('change', function () {
    var vis = visibleRoutes();
    if (this.checked) vis.forEach(function (r) { RSEL.add(r.ri); });
    else vis.forEach(function (r) { RSEL.delete(r.ri); });
    renderRoutes();
  });

  /* הייצוא הוא בדיוק מה שמסומן; אם אין סימון — כל מה שמוצג בטבלה */
  $('exportRoutes').addEventListener('click', function () {
    if (!worker) return;
    var shown = exportRoutesList();
    if (!shown.length) { showMsg('warn', 'אין קווים לייצוא בסינון הנוכחי.'); return; }
    busy = true;
    setProgress(-1, 'בונה קובץ לוחות זמנים (' + shown.length + ' קווים)…');
    worker.postMessage({ type: 'exportRoutes', onlyDup: false, maxCols: 80,
      label: $('rq').value, only: shown.map(function (r) { return r.ri; }) });
  });

  /* ---- סדרת קווים: "402, 404, 410-415" ---- */
  $('rSeriesGo').addEventListener('click', applySeries);
  $('rSeries').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); applySeries(); }
  });
  $('rSeriesClear').addEventListener('click', function () {
    RSEL.clear(); renderRoutes();
    $('pubNote').textContent = '';
  });

  /* מפרק רשימה וטווחים למספרי קו. טווח מוגבל ב-500 ערכים כדי
     ש-"1-999999" לא יתקע את הדפדפן. */
  function parseSeries(txt) {
    var exact = new Set(), ranges = [];
    String(txt || '').split(/[,;\s]+/).forEach(function (tok) {
      tok = tok.trim();
      if (!tok) return;
      var m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(tok);
      if (m) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a > b) { var t = a; a = b; b = t; }
        if (b - a > 500) b = a + 500;
        ranges.push([a, b]);
      } else {
        exact.add(tok);
      }
    });
    return { exact: exact, ranges: ranges };
  }

  function seriesMatch(line, spec) {
    var s = String(line).trim();
    if (spec.exact.has(s)) return true;
    var n = parseInt(s, 10);
    if (isNaN(n) || String(n) !== s) return false;
    return spec.ranges.some(function (r) { return n >= r[0] && n <= r[1]; });
  }

  function applySeries() {
    var spec = parseSeries($('rSeries').value);
    if (!spec.exact.size && !spec.ranges.length) {
      showMsg('warn', 'לא זוהתה סדרת קווים. דוגמה: 402, 404, 410-415');
      return;
    }
    if (!ROUTES.length) { showMsg('warn', 'אין עדיין רשימת קווים — הרץ ניתוח תחילה.'); return; }
    var hit = new Set();
    ROUTES.forEach(function (r) {
      if (!seriesMatch(r.line, spec)) return;
      hit.add(String(r.line).trim());
      RSEL.add(r.ri);
    });
    $('rq').value = '';
    $('rFilter').value = 'all';   // אחרת הסדרה שסומנה תיעלם מאחורי סינון הכפולות
    renderRoutes();
    var missing = [];
    spec.exact.forEach(function (x) { if (!hit.has(x)) missing.push(x); });
    if (!hit.size) {
      showMsg('warn', 'לא נמצא אף קו תואם בפיד לסדרה שהוזנה.');
      $('pubNote').textContent = '';
    } else {
      $('pubNote').textContent = 'סומנו ' + RSEL.size + ' כיווני נסיעה · ' +
        hit.size + ' מספרי קו';
      if (missing.length) {
        showMsg('info', 'לא נמצאו בפיד הקווים: ' + missing.slice(0, 12).join(', ') +
          (missing.length > 12 ? ' ועוד ' + (missing.length - 12) : '') + '.');
      }
    }
  }

  /* ---- טווח תאריכים: אותו לוח לכל יום בטווח ---- */
  function pubDates() {
    var a = $('pubFrom').value, b = $('pubTo').value;
    if (a && b && a > b) { var t = a; a = b; b = t; $('pubFrom').value = a; $('pubTo').value = b; }
    return { from: a, to: b };
  }

  /* התאריכים עם שירות בתוך הטווח — נלקחים מכיסוי הפיד שכבר בידינו */
  function datesInRange(from, to) {
    if (!COVERAGE || !COVERAGE.dates) return [];
    return COVERAGE.dates.filter(function (x) {
      return (!from || x.date >= from) && (!to || x.date <= to);
    }).map(function (x) { return x.date; });
  }

  $('pubCsv').addEventListener('click', function () {
    if (!worker) return;
    var shown = publishRoutesList();
    if (!shown.length) { showMsg('warn', 'לא נבחרו קווים.'); return; }
    var d = pubDates();
    busy = true;
    setProgress(-1, 'בונה CSV לטווח התאריכים…');
    worker.postMessage({ type: 'exportRoutes', onlyDup: false, maxCols: 80,
      label: $('rSeries').value || $('rq').value,
      only: shown.map(function (r) { return r.ri; }),
      dates: datesInRange(d.from, d.to) });
  });

  $('pubHtml').addEventListener('click', function () {
    if (!worker) return;
    var shown = publishRoutesList();
    if (!shown.length) { showMsg('warn', 'לא נבחרו קווים ללוח.'); return; }
    if (shown.length > 40) {
      showMsg('warn', 'נבחרו ' + shown.length + ' קווים — לוח מודפס נעשה בלתי קריא מעל 40. ' +
        'צמצם את הבחירה.');
      return;
    }
    var d = pubDates();
    busy = true;
    setProgress(-1, 'בונה לוח זמנים להפצה…');
    worker.postMessage({ type: 'publishSheet',
      only: shown.map(function (r) { return r.ri; }),
      label: $('rSeries').value || $('rq').value,
      from: d.from, to: d.to, perTable: 8 });
  });

  /* לפרסום: הקווים המסומנים ללא תלות בסינון התצוגה — סדרה שסומנה
     דרך תיבת הסדרה לא תיעלם רק מפני שהטבלה מציגה "רק כפולות". */
  function publishRoutesList() {
    if (RSEL.size) return ROUTES.filter(function (r) { return RSEL.has(r.ri); });
    return visibleRoutes();
  }

  /* הקווים שיצאו לקובץ: המסומנים מתוך המוצגים, ואם אין — כל המוצגים */
  function exportRoutesList() {
    var vis = visibleRoutes();
    var picked = vis.filter(function (r) { return RSEL.has(r.ri); });
    return picked.length ? picked : vis;
  }

  /* חיפוש חופשי בכל השדות, אך התאמה מדויקת של מספר הקו עולה לראש הרשימה */
  function visibleRoutes() {
    var q = $('rq').value.trim();
    var onlyDup = $('rFilter').value === 'dup';
    var out = ROUTES.filter(function (r) {
      if (onlyDup && !r.dup) return false;
      if (q && (r.line + ' ' + r.long + ' ' + r.agency + ' ' + r.makat).indexOf(q) === -1) return false;
      return true;
    });
    if (q) {
      var rank = function (r) {
        if (String(r.line) === q) return 0;              // מספר הקו בדיוק
        if (String(r.makat).indexOf(q) === 0) return 1;  // תחילת המק״ט
        if (String(r.line).indexOf(q) === 0) return 2;
        return 3;
      };
      out = out.map(function (r, i) { return { r: r, i: i, k: rank(r) }; })
        .sort(function (a, b) { return a.k - b.k || a.i - b.i; })
        .map(function (x) { return x.r; });
    }
    return out;
  }

  function renderRoutes() {
    var all = visibleRoutes();
    var rows = all.slice(0, 800);
    var nPicked = all.filter(function (r) { return RSEL.has(r.ri); }).length;
    var nExp = exportRoutesList().length;
    $('rAll').checked = all.length > 0 && nPicked === all.length;
    $('rAll').indeterminate = nPicked > 0 && nPicked < all.length;
    $('exportRoutes').innerHTML = '<svg class="ic"><use href="#i-download"></use></svg> ייצוא ל-Canva (' +
      nExp + ')';
    $('exportRoutes').title = nPicked
      ? nPicked + ' קווים מסומנים מתוך ' + all.length + ' תוצאות'
      : 'לא סומן דבר — ייוצאו כל ' + all.length + ' התוצאות המוצגות';
    $('rBody').innerHTML = rows.map(function (r) {
      var on = RSEL.has(r.ri);
      return '<tr data-ri="' + r.ri + '"' + (on ? ' class="picked"' : '') + '>' +
        '<td class="chk"><input type="checkbox" data-pick="' + r.ri + '"' +
          (on ? ' checked' : '') + ' aria-label="בחר את קו ' + esc(r.line) + '"></td>' +
        '<td class="num"><b>' + esc(r.line) + '</b></td>' +
        '<td>' + esc(r.agency) + '</td>' +
        '<td class="name" style="font-weight:400">' + esc(r.long) +
          '<small class="tid">' + esc(r.makat) + '</small></td>' +
        '<td class="num">' + r.total + '</td>' +
        '<td class="num">' + r.slots + '</td>' +
        '<td class="num">' + (r.dup ? '<span style="color:var(--a)">' + r.dup + '</span>' : '0') + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:26px">' +
      'אין קווים תואמים.</td></tr>';
    if (all.length > rows.length) {
      $('rBody').insertAdjacentHTML('beforeend',
        '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:10px">' +
        'מוצגות ' + rows.length + ' תוצאות ראשונות מתוך ' + all.length +
        ' — צמצם את החיפוש כדי לסמן את השאר.</td></tr>');
    }
  }

  $('rBody').addEventListener('click', function (e) {
    var box = e.target.closest('input[data-pick]');
    if (box) {                       // סימון לייצוא — לא פותח לוח זמנים
      var ri = parseInt(box.dataset.pick, 10);
      if (box.checked) RSEL.add(ri); else RSEL.delete(ri);
      renderRoutes();
      return;
    }
    var tr = e.target.closest('tr');
    if (!tr || !tr.dataset.ri || !worker) return;
    worker.postMessage({ type: 'timetable', ri: parseInt(tr.dataset.ri, 10) });
  });

  /* שורה אחת לכל שעה עגולה, והדקות שבתוכה לצידה */
  function hourRows(slots) {
    var byHour = new Map();
    slots.forEach(function (g) {
      var h = Math.floor(g.t / 3600);
      if (!byHour.has(h)) byHour.set(h, []);
      byHour.get(h).push(g);
    });
    var out = [];
    Array.from(byHour.keys()).sort(function (a, b) { return a - b; }).forEach(function (h) {
      var gs = byHour.get(h);
      var tot = gs.reduce(function (a, g) { return a + g.count; }, 0);
      out.push('<div class="ttrow"><span class="tth"><bdi class="tnum">' +
        pad(h % 24) + ':00</bdi>' +
        (h >= 24 ? '<sup>+1</sup>' : '') + '</span>' +
        '<span class="ttn">' + tot + '</span>' +
        '<span class="ttmins">' + gs.map(function (g) {
          // שעה מלאה בכל שבב: הנקודתיים בתוך bdi כדי שלא יתהפכו בעברית
          return '<span class="slot' + (g.count > 1 ? ' dup' : '') + '"><bdi class="tnum">' +
            pad(h % 24) + ':' + pad(Math.floor((g.t % 3600) / 60)) + '</bdi>' +
            (g.count > 1 ? ' ×' + g.count : '') + '</span>';
        }).join('') + '</span></div>');
    });
    return '<div class="tthours">' + out.join('') + '</div>';
  }

  function renderTimetable(m) {
    var html = ['<h3 style="margin:18px 0 4px">קו ' + esc(m.info.line) + ' — ' + esc(m.info.long) + '</h3>',
      '<div class="hint" style="margin-bottom:6px">' + esc(m.info.agency) +
      ' · מק״ט ' + esc(m.info.makat) + ' · ' + esc(describeWhen(lastOpts).split(' · ')[0]) + '</div>'];
    m.dirs.forEach(function (d) {
      var total = d.slots.reduce(function (a, g) { return a + g.count; }, 0);
      var dup = d.slots.filter(function (g) { return g.count > 1; }).length;
      html.push('<div class="ttday"><h4>' +
        '<svg class="ic"><use href="#i-bus"></use></svg> כיוון ' + (d.dir + 1) +
        (d.name ? ' — ' + esc(d.name) : '') +
        '<small>' + (d.origin ? 'מ' + esc(d.origin) + ' · ' : '') + total + ' יציאות · ' +
        d.slots.length + ' שעות' + (dup ? ' · ' + dup + ' שעות עם יותר מאוטובוס אחד' : '') +
        '</small></h4>' + hourRows(d.slots) + '</div>');
    });
    html.push('<div class="legend">שעה מסומנת באדום = יותר מאוטובוס אחד יוצא באותה דקה. ' +
      'בייצוא ל-Canva היא מסומנת ב-<code dir="ltr">*X</code>.</div>');
    $('ttPanel').innerHTML = html.join('');
    $('ttPanel').classList.remove('hide');
    $('ttPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ================= ייצוא ================= */
  $('export').addEventListener('click', function () {
    if (!worker) return;
    setProgress(-1, 'בונה CSV…');
    busy = true;
    worker.postMessage({ type: 'export', capacityOf: LENS,
      defaultLen: parseFloat($('defaultLen').value) || 24,
      busLen: parseFloat($('busLen').value) || 12 });
  });

  function downloadBlob(text, name, mime) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function downloadCsv(csv, name) {
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || ('gtfs-export-' +
      (lastOpts && lastOpts.date ? lastOpts.date : new Date().toISOString().slice(0, 10)) + '.csv');
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  $('ver').textContent = 'גרסה 2.3.1';
})();
