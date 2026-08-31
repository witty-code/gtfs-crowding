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
    ROWS = []; STATS = null; detailRows = null; detailMeta = null;
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
        if (p.rows !== undefined) {
          extra += '<span><svg class="ic"><use href="#i-file-text"></use></svg> ' + num(p.rows) +
            (p.estRows ? ' מתוך ~' + num(p.estRows) : '') + ' שורות</span>';
        }
        if (p.total) extra += '<span>' + fmtBytes(p.bytes) + ' / ' + fmtBytes(p.total) + '</span>';
        if (p.eta > 0) extra += '<span><svg class="ic"><use href="#i-clock"></use></svg> נותרו כ-' +
          fmtDur(p.eta) + '</span>';
        if (p.kept) extra += '<span>' + num(p.kept) + ' עצירות נשמרו</span>';
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
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });

    } else if (m.type === 'detail') {
      renderDetail(m);

    } else if (m.type === 'export') {
      downloadCsv(m.csv);
      finish();

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
      ['רציפים עם תחנת אם', num(d.nParented)],
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
      $('filterBy').value = 'date';
      $('dateWrap').classList.remove('hide');
      $('dowWrap').classList.add('hide');
    }
    if (cov.truncated) {
      showMsg('info', 'טווח התאריכים של הפיד ארוך מ-400 ימים; הרשימה נקטעה.');
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
          (r.exactAt >= 0 && r.maxExact > 1 ? '<small>' + fmt(r.exactAt) + '</small>' : '') + '</td>' +
        '<td class="num">' + (r.nOrigin ? r.winOrg +
          (r.winOrgAt >= 0 && r.winOrg > 1 ? '<small>' + fmt(r.winOrgAt) + '</small>' : '')
          : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td class="num">' + r.winAll +
          (r.winAllAt >= 0 && r.winAll > 1 ? '<small>' + fmt(r.winAllAt) + '</small>' : '') + '</td>' +
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
  function fmtSec(sec) {
    var s = sec % 60;
    return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor((sec % 3600) / 60)) + (s ? ':' + pad(s) : '');
  }

  document.querySelectorAll('thead th').forEach(function (th) {
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
    var isMap = t === 'map';
    $('tabTable').classList.toggle('on', !isMap);
    $('tabMap').classList.toggle('on', isMap);
    $('tblWrap').classList.toggle('hide', isMap);
    $('mapWrap').classList.toggle('on', isMap);
    if (isMap) {
      initMap();
      setTimeout(function () { if (map) { map.invalidateSize(); drawMap(visibleRows()); } }, 60);
    }
  }

  function initMap() {
    if (mapReady || typeof L === 'undefined') return;
    map = L.map('map', { preferCanvas: true }).setView([31.8, 35.0], 8);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
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

  function drawMap(rows) {
    if (!mapReady) return;
    mapLayer.clearLayers();
    var pts = [];
    rows.forEach(function (r) {
      if (isNaN(r.lat) || isNaN(r.lon) || (!r.lat && !r.lon)) return;
      var g = gradeOf(r), peak = peakOf(r);
      var m = L.circleMarker([r.lat, r.lon], {
        radius: Math.min(20, 4 + peak * 1.6),
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
    if (pts.length) {
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
    $('drawer').classList.remove('open');
    $('backdrop').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
  }
  ['dPlat', 'dType', 'dOnly'].forEach(function (id) {
    $(id).addEventListener('change', function () { if (detailRows) paintDetail(); });
  });

  function renderDetail(m) {
    detailRows = m.rows; detailMeta = m.meta;
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
    $('drawer').classList.add('open');
    $('backdrop').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('dBody').scrollTop = 0;
  }

  function paintDetail() {
    var plat = $('dPlat').value, type = $('dType').value, only = $('dOnly').value;
    var rows = detailRows.filter(function (r) {
      if (plat && r.stopId !== plat) return false;
      if (type === 'origin' && !r.origin) return false;
      if (type === 'mid' && r.origin) return false;
      return true;
    }).sort(function (a, b) { return a.t - b.t || (a.line + '').localeCompare(b.line + '', 'he'); });

    // קיבוץ לפי דקת יציאה
    var groups = [];
    var cur = null;
    rows.forEach(function (r) {
      var mk = Math.floor(r.t / 60);
      if (!cur || cur.min !== mk) { cur = { min: mk, rows: [] }; groups.push(cur); }
      cur.rows.push(r);
    });

    var Wo = lastOpts.winOrigin, Wm = lastOpts.winMid;
    var shown = groups.filter(function (g) { return only !== 'multi' || g.rows.length > 1; });

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
        '<span class="t">' + fmt(g.min * 60) + '</span>' +
        '<span>' + n + ' יציאות' + (nOrg && nOrg !== n ? ' · ' + nOrg + ' מוצא' : '') + '</span>' +
        (n > 1 ? '<span class="tag a" style="margin-inline-start:auto">חפיפה</span>' : '') +
        '</div><table><tbody>');
      g.rows.forEach(function (r) {
        html.push('<tr><td style="width:52px" class="num">' + fmtSec(r.t) + '</td>' +
          '<td style="width:52px"><b>' + esc(r.line) + '</b></td>' +
          '<td style="width:74px">' + esc(r.agency) + '</td>' +
          '<td style="white-space:normal">' + esc(r.headsign || r.lineLong) +
            (r.platform ? ' <span class="tag n">רציף ' + esc(r.platform) + '</span>' : '') +
            '<br><span class="tid">' + esc(r.tripId) + '</span>' +
            (r.makat ? ' <span class="tid">' + esc(r.makat) + '</span>' : '') + '</td>' +
          '<td style="width:52px">' + (r.origin ? '<span class="tag b">מוצא</span>'
            : '<span class="tag n">ביניים</span>') + '</td></tr>');
      });
      html.push('</tbody></table></div>');
    });

    html.push('<div class="legend" style="padding:14px 18px">' +
      'כותרת אדומה — יותר מיציאה אחת באותה דקה (רמה א׳). כותרת כתומה — יציאה בודדת שנמצאת ' +
      'בתוך חלון רמה ב׳ של יציאה סמוכה.<br>' +
      'מוצגות ' + shown.length + ' מתוך ' + groups.length + ' דקות · ' + rows.length + ' יציאות.<br>' +
      'ה-trip_id מוצג לצד כל יציאה לצורך אימות מול מערכות אחרות.</div>');

    $('dBody').innerHTML = html.join('');
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

  function downloadCsv(csv) {
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var tag = lastOpts && lastOpts.date ? lastOpts.date : new Date().toISOString().slice(0, 10);
    a.download = 'gtfs-overcrowding-' + tag + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  $('ver').textContent = 'גרסה 2.0';
})();
