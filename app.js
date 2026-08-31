/* app.js — שכבת הממשק. כל העבודה הכבדה נעשית ב-worker.js */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var worker = null;
  var files = null;
  var ROWS = [];
  var STATS = null;
  var sortKey = 'maxExact', sortAsc = false;
  var LENS = {};          // stop_id → אורך במטרים (דריסה ידנית)
  var lastOpts = null;

  try { LENS = JSON.parse(localStorage.getItem('gtfsCrowdLens') || '{}'); } catch (e) { LENS = {}; }
  function saveLens() {
    try { localStorage.setItem('gtfsCrowdLens', JSON.stringify(LENS)); } catch (e) {}
  }

  /* ---------- מילוי בוררי שעות ---------- */
  (function () {
    var f = $('fromHour'), t = $('toHour');
    for (var h = 0; h <= 27; h++) {
      var lbl = (h < 10 ? '0' + h : h) + ':00' + (h >= 24 ? '  (למחרת)' : '');
      f.add(new Option(lbl, h));
      t.add(new Option((h < 10 ? '0' + h : h) + ':59' + (h >= 24 ? '  (למחרת)' : ''), h));
    }
    f.value = '6'; t.value = '9';
  })();

  $('day').addEventListener('change', function () {
    $('dateWrap').classList.toggle('hide', this.value !== 'date');
    markStale();
  });

  /* ---------- בחירת קבצים ---------- */
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

  function takeFiles(list) {
    var arr = Array.prototype.slice.call(list || []);
    if (!arr.length) return;
    var zip = arr.filter(function (f) { return /\.zip$/i.test(f.name); });
    var txt = arr.filter(function (f) { return /\.txt$/i.test(f.name); });
    if (!zip.length && !txt.length) {
      showMsg('err', 'לא זוהו קבצים מתאימים. צריך GTFS.zip או קבצי txt.');
      return;
    }
    files = zip.length ? [zip[0]] : txt;
    var total = files.reduce(function (a, f) { return a + f.size; }, 0);
    $('fileInfo').className = 'ok';
    $('fileInfo').textContent = zip.length
      ? '✓ ' + zip[0].name + ' (' + fmtBytes(zip[0].size) + ')'
      : '✓ ' + files.length + ' קבצים: ' + files.map(function (f) { return f.name; }).join(', ') +
        ' (' + fmtBytes(total) + ')';
    $('run').disabled = false;
    clearMsgs();
  }

  /* ---------- הודעות ---------- */
  function clearMsgs() { $('msgs').innerHTML = ''; }
  function showMsg(kind, text) {
    var d = document.createElement('div');
    d.className = 'note ' + kind;
    d.textContent = text;
    $('msgs').appendChild(d);
  }

  /* ---------- איסוף הגדרות ---------- */
  function readOpts() {
    var dayVal = $('day').value;
    var useDate = dayVal === 'date';
    var dateStr = null;
    if (useDate) {
      var v = $('date').value; // YYYY-MM-DD
      if (!v) { showMsg('err', 'בחר תאריך.'); return null; }
      dateStr = v.replace(/-/g, '');
    }
    var from = parseInt($('fromHour').value, 10);
    var to = parseInt($('toHour').value, 10);
    if (to < from) { showMsg('err', 'שעת הסיום מוקדמת משעת ההתחלה.'); return null; }
    return {
      mode: $('mode').value,
      unit: $('unit').value,
      day: useDate ? null : parseInt(dayVal, 10),
      date: dateStr,
      fromHour: from,
      toHour: to,
      winOrigin: Math.max(0, parseInt($('winOrigin').value, 10) || 0),
      winMid: Math.max(0, parseInt($('winMid').value, 10) || 0),
      minCount: Math.max(2, parseInt($('minCount').value, 10) || 2),
      busLen: Math.max(1, parseFloat($('busLen').value) || 12),
      defaultLen: Math.max(1, parseFloat($('defaultLen').value) || 24),
      maxRows: 6000000,
      maxResults: 4000
    };
  }

  function markStale() {
    if (!STATS) return;
    $('staleNote').classList.remove('hide');
    $('staleNote').textContent = 'ההגדרות השתנו — לחץ "הרץ ניתוח" לעדכון.';
  }
  ['mode', 'unit', 'day', 'date', 'fromHour', 'toHour', 'winOrigin', 'winMid', 'minCount']
    .forEach(function (id) { $(id).addEventListener('change', markStale); });
  // אורך תחנה וקיבולת מחושבים בצד הלקוח — עדכון מיידי בלי הרצה מחדש
  ['defaultLen', 'busLen'].forEach(function (id) {
    $(id).addEventListener('change', function () { if (STATS) render(); });
  });

  /* ---------- הרצה ---------- */
  $('run').addEventListener('click', function () {
    var opts = readOpts();
    if (!opts || !files) return;
    lastOpts = opts;
    clearMsgs();
    $('staleNote').classList.add('hide');
    $('run').disabled = true;
    $('export').disabled = true;
    setProgress(0, 'מתחיל…');

    if (opts.mode === 'all') {
      showMsg('warn', 'מצב "כולל תחנות ביניים" קורא את כל stop_times.txt ועלול לקחת מספר דקות ' +
        'ולצרוך זיכרון רב בפידים גדולים. אל תסגור את הלשונית.');
    }

    if (!worker) {
      worker = new Worker('worker.js');
      worker.onmessage = onWorker;
      worker.onerror = function (e) {
        showMsg('err', 'שגיאה ב-Worker: ' + (e.message || 'לא ידועה'));
        $('run').disabled = false;
        $('progress').classList.remove('on');
      };
      worker.postMessage({ type: 'load', files: files, opts: opts });
    } else {
      worker.postMessage({ type: 'reanalyze', opts: opts });
    }
  });

  function setProgress(pct, text) {
    $('progress').classList.add('on');
    $('progBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (text !== undefined) $('progText').textContent = text;
  }

  function onWorker(e) {
    var m = e.data;
    if (m.type === 'progress') {
      if (m.p) {
        var p = m.p;
        var pct = p.total ? (p.bytes / p.total) * 100 : 0;
        setProgress(pct, p.text || '');
      } else if (m.text) {
        setProgress(100, m.text);
      }
    } else if (m.type === 'loaded-source') {
      setProgress(2, 'נמצאו ' + m.names.length + ' קבצים בפיד…');
    } else if (m.type === 'result') {
      ROWS = m.rows; STATS = m.stats;
      (m.warnings || []).forEach(function (w) { showMsg('warn', w); });
      $('progress').classList.remove('on');
      $('run').disabled = false;
      $('export').disabled = false;
      $('results').classList.remove('hide');
      document.querySelectorAll('.wo').forEach(function (n) { n.textContent = lastOpts.winOrigin; });
      document.querySelectorAll('.wm').forEach(function (n) { n.textContent = lastOpts.winMid; });
      render();
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (m.type === 'detail') {
      renderDetail(m);
    } else if (m.type === 'export') {
      downloadCsv(m.csv);
      $('progress').classList.remove('on');
    } else if (m.type === 'error') {
      $('progress').classList.remove('on');
      $('run').disabled = false;
      showMsg('err', m.message);
    }
  }

  /* ---------- חישוב דירוג ---------- */
  function lenOf(r) {
    return LENS[r.stopId] !== undefined ? LENS[r.stopId] : (parseFloat($('defaultLen').value) || 24);
  }
  function capOf(r) {
    return Math.max(1, Math.floor(lenOf(r) / (parseFloat($('busLen').value) || 12)));
  }
  function gradeOf(r) {
    var c = capOf(r);
    if (r.maxExact > c) return 'a';
    if (r.winOrg > c || r.winAll > c) return 'b';
    return 'ok';
  }
  function peakOf(r) { return Math.max(r.maxExact, r.winOrg, r.winAll); }
  function needOf(r) { return peakOf(r) * (parseFloat($('busLen').value) || 12); }

  /* ---------- טבלה ---------- */
  var GRADE_LABEL = { a: 'רמה א׳', b: 'רמה ב׳', ok: 'תקין' };

  function visibleRows() {
    var q = $('q').value.trim();
    var gf = $('gradeFilter').value;
    var tf = $('typeFilter').value;
    var out = ROWS.filter(function (r) {
      var g = gradeOf(r);
      if (gf === 'a' && g !== 'a') return false;
      if (gf === 'ab' && g === 'ok') return false;
      if (tf === 'origin' && !r.nOrigin) return false;
      if (tf === 'mid' && r.nOrigin) return false;
      if (q) {
        var hay = r.name + ' ' + r.city + ' ' + r.code + ' ' + r.stopId + ' ' + r.street;
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var get = {
      grade: function (r) { return { a: 2, b: 1, ok: 0 }[gradeOf(r)]; },
      name: function (r) { return r.name; },
      len: lenOf, cap: capOf, need: needOf
    };
    out.sort(function (x, y) {
      var f = get[sortKey];
      var a = f ? f(x) : x[sortKey];
      var b = f ? f(y) : y[sortKey];
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
      card(STATS.units.toLocaleString('he-IL'), 'יחידות ניתוח נבדקו') +
      card(STATS.departures.toLocaleString('he-IL'), 'יציאות בטווח') +
      card(nA.toLocaleString('he-IL'), 'תחנות ברמה א׳', 'a') +
      card(nB.toLocaleString('he-IL'), 'תחנות ברמה ב׳', 'b') +
      card(rows.length.toLocaleString('he-IL'), 'מוצגות כעת');

    var html = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], g = gradeOf(r);
      html.push('<tr data-u="' + r.u + '">' +
        '<td><span class="tag ' + g + '">' + GRADE_LABEL[g] + '</span></td>' +
        '<td class="name">' + esc(r.name) +
          (r.platform ? ' <span class="tag n">רציף ' + esc(r.platform) + '</span>' : '') +
          '<small>' + esc(r.city || '') + (r.street ? ' · ' + esc(r.street) : '') +
          ' · קוד ' + esc(r.code || r.stopId) + '</small></td>' +
        '<td class="num">' + big(r.maxExact, g === 'a') + (r.exactAt >= 0 && r.maxExact > 1 ? '<small>' + fmt(r.exactAt) + '</small>' : '') + '</td>' +
        '<td class="num">' + (r.nOrigin ? big(r.winOrg, false) + (r.winOrgAt >= 0 && r.winOrg > 1 ? '<small>' + fmt(r.winOrgAt) + '</small>' : '') : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td class="num">' + big(r.winAll, false) + (r.winAllAt >= 0 && r.winAll > 1 ? '<small>' + fmt(r.winAllAt) + '</small>' : '') + '</td>' +
        '<td class="num">' + r.n + '</td>' +
        '<td class="num">' + r.nOrigin + '</td>' +
        '<td><input class="len" type="number" min="6" step="1" value="' + lenOf(r) +
          '" data-stop="' + esc(r.stopId) + '" title="אורך התחנה במטרים"></td>' +
        '<td class="num">' + capOf(r) + '</td>' +
        '<td class="num">' + needOf(r) + '</td>' +
        '</tr>');
    }
    $('tbody').innerHTML = html.join('') ||
      '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:26px">אין תוצאות התואמות לסינון.</td></tr>';

    document.querySelectorAll('thead th').forEach(function (th) {
      th.classList.toggle('sorted', th.dataset.k === sortKey);
      th.classList.toggle('asc', th.dataset.k === sortKey && sortAsc);
    });
  }

  function big(v, hot) {
    return '<span' + (hot ? ' style="color:var(--a)"' : '') + '>' + v + '</span>';
  }
  function card(v, l, cls) {
    return '<div class="card' + (cls ? ' ' + cls : '') + '"><b>' + v + '</b><span>' + l + '</span></div>';
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
  }

  document.querySelectorAll('thead th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.dataset.k;
      if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
      render();
    });
  });
  ['q', 'gradeFilter', 'typeFilter'].forEach(function (id) {
    $(id).addEventListener('input', render);
  });

  $('tbody').addEventListener('change', function (e) {
    var el = e.target;
    if (!el.classList.contains('len')) return;
    var v = parseFloat(el.value);
    var stop = el.dataset.stop;
    if (isNaN(v) || v <= 0) delete LENS[stop]; else LENS[stop] = v;
    saveLens();
    render();
  });
  $('tbody').addEventListener('click', function (e) {
    if (e.target.classList.contains('len')) return;
    var tr = e.target.closest('tr');
    if (!tr || !tr.dataset.u) return;
    worker.postMessage({ type: 'detail', u: parseInt(tr.dataset.u, 10) });
  });

  /* ---------- מגירת פירוט ---------- */
  $('dClose').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('backdrop').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
  }

  function renderDetail(m) {
    var meta = m.meta, rows = m.rows.slice().sort(function (a, b) { return a.t - b.t; });
    $('dTitle').textContent = meta.name + (meta.platform ? ' — רציף ' + meta.platform : '');
    $('dSub').textContent = [meta.city, meta.street, 'קוד ' + (meta.code || meta.stopId)]
      .filter(Boolean).join(' · ');

    // סימון רגעי השיא
    var Wo = lastOpts.winOrigin * 60, Wm = lastOpts.winMid * 60;
    var minuteCount = {};
    rows.forEach(function (r) { var k = Math.floor(r.t / 60); minuteCount[k] = (minuteCount[k] || 0) + 1; });

    var body = ['<table><thead><tr><th>שעה</th><th>קו</th><th>מפעיל</th><th>יעד</th><th>סוג</th></tr></thead><tbody>'];
    rows.forEach(function (r) {
      var mk = Math.floor(r.t / 60);
      var cls = minuteCount[mk] > 1 ? ' class="peak"' : (nearby(rows, r, r.origin ? Wo : Wm) > 1 ? ' class="peakb"' : '');
      body.push('<tr' + cls + '><td class="num">' + fmtSec(r.t) + '</td>' +
        '<td><b>' + esc(r.line) + '</b></td>' +
        '<td>' + esc(r.agency) + '</td>' +
        '<td style="white-space:normal">' + esc(r.headsign || r.lineLong) + '</td>' +
        '<td>' + (r.origin ? '<span class="tag b">מוצא</span>' : '<span class="tag n">ביניים</span>') + '</td></tr>');
    });
    body.push('</tbody></table>');
    body.push('<div class="legend" style="margin-top:14px">' +
      'שורות באדום — יציאות באותה דקה בדיוק (רמה א׳). שורות בכתום — יציאות בתוך חלון רמה ב׳.<br>' +
      'סה"כ ' + rows.length + ' יציאות בטווח שנבחר.</div>');

    $('dBody').innerHTML = body.join('');
    $('drawer').classList.add('open');
    $('backdrop').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('dBody').scrollTop = 0;
  }
  function nearby(rows, r, W) {
    if (W <= 0) return 1;
    var c = 0;
    for (var i = 0; i < rows.length; i++) {
      if (r.origin && !rows[i].origin) continue;
      if (Math.abs(rows[i].t - r.t) <= W) c++;
    }
    return c;
  }
  function fmtSec(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return p(h) + ':' + p(m) + (s ? ':' + p(s) : '');
  }

  /* ---------- ייצוא ---------- */
  $('export').addEventListener('click', function () {
    setProgress(100, 'בונה CSV…');
    worker.postMessage({
      type: 'export',
      capacityOf: LENS,
      defaultLen: parseFloat($('defaultLen').value) || 24,
      busLen: parseFloat($('busLen').value) || 12
    });
  });

  function downloadCsv(csv) {
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var d = new Date();
    a.download = 'gtfs-overcrowding-' + d.toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- בדיקת תאימות דפדפן ---------- */
  if (typeof DecompressionStream === 'undefined') {
    showMsg('warn', 'הדפדפן אינו תומך בפריסת ZIP מקומית. אפשר להעלות קבצי txt בודדים, ' +
      'או להשתמש ב-Chrome/Edge 103+, Firefox 113+ או Safari 16.4+.');
  }
  $('ver').textContent = 'גרסה 1.0';
})();
