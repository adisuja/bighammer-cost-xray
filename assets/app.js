/* Databricks Cost X-Ray. Everything runs in this browser tab: no network calls, no storage. */
(function () {
  'use strict';

  // ---------- constants ----------
  var UTM = 'utm_source=cost-xray&utm_medium=lead-magnet&utm_campaign=dbx-webinar-nurture-2026&utm_content=';
  var LINKS = {
    book: 'https://bighammer.ai/book-demo/?' + UTM,
    assess: 'https://assessment.bighammerops.com/?' + UTM,
    guide: 'https://adisuja.github.io/bighammer-cost-field-guide/?' + UTM,
    tool: 'https://adisuja.github.io/bighammer-cost-xray/?' + UTM
  };
  // Databricks published list prices, Premium tier, AWS, checked 5 Oct 2026:
  // Jobs Classic $0.15/DBU (databricks.com/product/pricing/lakeflow-jobs),
  // Classic All-Purpose $0.55/DBU (databricks.com/product/pricing/datascience-ml).
  var JOBS_RATE = 0.15, AP_RATE = 0.55;
  var DEFAULT_RATIO = Math.round(JOBS_RATE / AP_RATE * 100) / 100; // 0.27
  var RS_TARGET_P95 = 60, RS_CAP = 0.5, UNDER_AVG = 20, UNDER_P95 = 40, MIN_HOURS = 0.5;
  var DAYS = 90;
  var FAILED_STATES = 'FAILED, TIMED_OUT, ERROR';

  var SCHEMAS = {
    spend: {
      label: 'Spend summary', q: 1,
      required: ['billing_origin_product', 'list_cost'],
      optional: ['sku_name', 'traced_to_job', 'priced', 'dbus', 'currency_code'],
      signature: ['billing_origin_product', 'sku_name', 'traced_to_job', 'priced', 'dbus']
    },
    jobs: {
      label: 'Cost per job', q: 2,
      required: ['job_id', 'list_cost'],
      optional: ['job_name', 'workspace_id', 'runs', 'failed_runs', 'failed_cost', 'all_purpose_cost', 'serverless_cost', 'scheduled_runs'],
      signature: ['job_id', 'job_name', 'runs', 'failed_runs', 'failed_cost', 'all_purpose_cost', 'scheduled_runs']
    },
    cpu: {
      label: 'Cluster CPU', q: 3,
      required: ['cluster_id', 'avg_cpu_percent', 'p95_cpu_percent'],
      optional: ['hours_observed', 'cluster_name', 'cluster_source', 'worker_node_type', 'worker_node_hours', 'list_cost', 'workspace_id'],
      signature: ['cluster_id', 'avg_cpu_percent', 'p95_cpu_percent', 'hours_observed', 'cluster_source', 'worker_node_hours']
    }
  };
  var ALIASES = { usage_quantity: 'dbus', name: 'job_name', avg_cpu: 'avg_cpu_percent', p95_cpu: 'p95_cpu_percent', hours: 'hours_observed', cost: 'list_cost' };

  var state = { data: { spend: null, jobs: null, cpu: null }, files: {}, sample: false, ratio: DEFAULT_RATIO, implied: null };

  // ---------- helpers ----------
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var currency = 'USD';
  function money(v, opts) {
    opts = opts || {};
    if (v == null || isNaN(v)) return 'n/a';
    var abs = Math.abs(v), d = opts.dp != null ? opts.dp : 0;
    try {
      if (opts.compact && abs >= 10000) {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency, currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: abs >= 1e6 ? 2 : 1 }).format(v);
      }
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    } catch (e) { return '$' + Math.round(v).toLocaleString('en-GB'); }
  }
  function pct(v, dp) { if (v == null || isNaN(v)) return 'n/a'; return (v * 100).toFixed(dp == null ? 0 : dp) + '%'; }
  function intf(v) { return v == null || isNaN(v) ? 'n/a' : Math.round(v).toLocaleString('en-GB'); }
  function sum(arr, f) { var s = 0; for (var i = 0; i < arr.length; i++) { var x = f(arr[i]); if (x != null && !isNaN(x)) s += x; } return s; }
  function linkFor(kind, slug) { return LINKS[kind] + slug; }
  function prettyProduct(p) { return String(p || 'UNKNOWN').toUpperCase(); }

  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? res() : rej(); } catch (e) { rej(e); } document.body.removeChild(ta);
    });
  }

  // ---------- CSV parsing ----------
  function parseCSV(text) {
    text = String(text).replace(/^\uFEFF/, '');
    var firstLine = text.split(/\r?\n/, 1)[0] || '';
    var delims = [',', ';', '\t', '|'], delim = ',', best = -1;
    delims.forEach(function (d) { var n = firstLine.split(d).length; if (n > best) { best = n; delim = d; } });
    var rows = [], row = [], field = '', i = 0, q = false, c;
    while (i < text.length) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
  }
  function normHeader(h) {
    var k = String(h).trim().replace(/^[`"']+|[`"']+$/g, '').toLowerCase().replace(/[\s\-.]+/g, '_').replace(/[^a-z0-9_]/g, '');
    return ALIASES[k] && k !== ALIASES[k] ? ALIASES[k] : k;
  }
  function num(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (s === '' || /^(null|nan|none|n\/a)$/i.test(s)) return null;
    var neg = /^\(.*\)$/.test(s);
    s = s.replace(/[()\s$£€,]/g, '').replace(/%$/, '');
    if (/e/i.test(s) && !isNaN(Number(s))) return neg ? -Number(s) : Number(s);
    var n = parseFloat(s);
    return isNaN(n) ? null : (neg ? -n : n);
  }
  function bool(v) { return /^(true|t|1|yes|y)$/i.test(String(v == null ? '' : v).trim()); }

  function detect(headers) {
    var set = {}; headers.forEach(function (h) { set[h] = 1; });
    var bestKind = null, bestScore = 0;
    Object.keys(SCHEMAS).forEach(function (k) {
      var s = SCHEMAS[k], score = 0;
      s.signature.concat(s.required).forEach(function (c) { if (set[c]) score++; });
      // unique anchors weigh more
      if (k === 'spend' && set.billing_origin_product) score += 5;
      if (k === 'jobs' && set.job_id) score += 5;
      if (k === 'cpu' && (set.avg_cpu_percent || set.p95_cpu_percent)) score += 5;
      if (score > bestScore) { bestScore = score; bestKind = k; }
    });
    if (bestScore < 5) return { kind: null };
    var missing = SCHEMAS[bestKind].required.filter(function (c) { return !set[c]; });
    return { kind: bestKind, missing: missing };
  }

  function buildRows(kind, headers, body) {
    var idx = {}; headers.forEach(function (h, i) { if (idx[h] == null) idx[h] = i; });
    var get = function (r, k) { return idx[k] == null ? undefined : r[idx[k]]; };
    var has = function (k) { return idx[k] != null; };
    var out = [], bad = 0;
    body.forEach(function (r) {
      var o;
      if (kind === 'spend') {
        var lc = num(get(r, 'list_cost'));
        o = { product: prettyProduct(get(r, 'billing_origin_product')), sku: String(get(r, 'sku_name') || ''),
          traced: has('traced_to_job') ? bool(get(r, 'traced_to_job')) : null,
          priced: has('priced') ? bool(get(r, 'priced')) && lc != null : lc != null,
          dbus: num(get(r, 'dbus')) || 0, cost: lc, cur: String(get(r, 'currency_code') || '').trim() };
        if (!o.product || o.product === 'UNKNOWN' && lc == null) { bad++; return; }
      } else if (kind === 'jobs') {
        o = { id: String(get(r, 'job_id') || '').trim(), name: String(get(r, 'job_name') || '').trim(),
          ws: String(get(r, 'workspace_id') || '').trim(), runs: num(get(r, 'runs')), failedRuns: num(get(r, 'failed_runs')),
          sched: has('scheduled_runs') ? num(get(r, 'scheduled_runs')) : null, cost: num(get(r, 'list_cost')),
          failedCost: num(get(r, 'failed_cost')), ap: num(get(r, 'all_purpose_cost')) || 0, sl: num(get(r, 'serverless_cost')) || 0 };
        if (!o.id || o.cost == null) { bad++; return; }
        if (!o.name) o.name = 'job ' + o.id;
      } else {
        o = { id: String(get(r, 'cluster_id') || '').trim(), name: String(get(r, 'cluster_name') || '').trim(),
          source: String(get(r, 'cluster_source') || '').trim().toUpperCase(), node: String(get(r, 'worker_node_type') || '').trim(),
          hours: num(get(r, 'hours_observed')), avg: num(get(r, 'avg_cpu_percent')), p95: num(get(r, 'p95_cpu_percent')),
          cost: has('list_cost') ? num(get(r, 'list_cost')) : null };
        if (!o.id || o.avg == null || o.p95 == null) { bad++; return; }
      }
      out.push(o);
    });
    return { rows: out, bad: bad, cols: idx, has: { scheduled: has('scheduled_runs'), traced: has('traced_to_job'), failed: has('failed_cost'), ap: has('all_purpose_cost'), hours: has('hours_observed'), cpuCost: has('list_cost') } };
  }

  function ingest(name, text) {
    var rows = parseCSV(text);
    if (!rows.length) return { error: '<b>' + esc(name) + '</b> is empty.' };
    var headers = rows[0].map(normHeader);
    var d = detect(headers);
    if (!d.kind) {
      return { error: '<b>' + esc(name) + '</b>: could not tell which query this came from. Expected columns such as <code>billing_origin_product</code> (query 1), <code>job_id</code> (query 2) or <code>cluster_id</code> and <code>avg_cpu_percent</code> (query 3). Found: ' + headers.slice(0, 8).map(function (h) { return '<code>' + esc(h || '(blank)') + '</code>'; }).join(' ') + (headers.length > 8 ? ' and ' + (headers.length - 8) + ' more' : '') + '.' };
    }
    var s = SCHEMAS[d.kind];
    if (d.missing.length) {
      return { kind: d.kind, error: '<b>' + esc(name) + '</b> looks like query ' + s.q + ' (' + s.label.toLowerCase() + ') but ' + (d.missing.length > 1 ? 'columns ' : 'the column ') + d.missing.map(function (m) { return '<code>' + m + '</code>'; }).join(' and ') + (d.missing.length > 1 ? ' are' : ' is') + ' missing. Re-run query ' + s.q + ' unchanged and download it again.' };
    }
    var built = buildRows(d.kind, headers, rows.slice(1));
    if (!built.rows.length) return { kind: d.kind, error: '<b>' + esc(name) + '</b> has the right columns for query ' + s.q + ' but no usable rows. If the query returned nothing, your account may not have data in that table for the last 90 days.' };
    var warn = null;
    var missingOpt = s.optional.filter(function (c) { return built.cols[c] == null; });
    var important = { spend: ['traced_to_job'], jobs: ['failed_cost', 'all_purpose_cost', 'scheduled_runs'], cpu: ['hours_observed', 'list_cost'] }[d.kind];
    var gone = important.filter(function (c) { return missingOpt.indexOf(c) >= 0; });
    if (gone.length) warn = '<b>' + esc(name) + '</b>: optional ' + (gone.length > 1 ? 'columns ' : 'column ') + gone.map(function (m) { return '<code>' + m + '</code>'; }).join(', ') + ' not found, so the matching parts of the report will be partial.';
    if (built.bad) warn = (warn ? warn + ' ' : '<b>' + esc(name) + '</b>: ') + built.bad + ' row' + (built.bad > 1 ? 's' : '') + ' skipped because key values were blank or not numeric.';
    return { kind: d.kind, data: built, rows: built.rows.length, warn: warn };
  }

  // ---------- upload UI ----------
  var msgs = [];
  function renderMsgs() {
    $('#msgs').innerHTML = msgs.map(function (m) { return '<div class="msg ' + m.type + '">' + m.html + '</div>'; }).join('');
  }
  function setSlot(kind, ok, text) {
    var el = $('.slot[data-kind="' + kind + '"]');
    el.classList.toggle('ok', ok === true); el.classList.toggle('bad', ok === false);
    $('.slot-s', el).innerHTML = text;
  }
  function refreshBuild() {
    var any = state.data.spend || state.data.jobs || state.data.cpu;
    $('#buildBtn').disabled = !any;
  }
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (state.sample) clearSample();
    msgs = [];
    var pending = files.length;
    files.forEach(function (f) {
      if (f.size > 60 * 1024 * 1024) { msgs.push({ type: 'err', html: '<b>' + esc(f.name) + '</b> is larger than 60 MB. The queries return at most a few thousand rows, so this is probably not one of their outputs.' }); if (--pending === 0) done(); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var res = ingest(f.name, reader.result);
        if (res.error) {
          msgs.push({ type: 'err', html: res.error });
          if (res.kind && !state.data[res.kind]) setSlot(res.kind, false, 'Problem with ' + esc(f.name));
        } else {
          if (state.files[res.kind] && state.files[res.kind] !== f.name) msgs.push({ type: 'info', html: '<b>' + esc(f.name) + '</b> replaced <b>' + esc(state.files[res.kind]) + '</b> as the ' + SCHEMAS[res.kind].label.toLowerCase() + ' file.' });
          state.data[res.kind] = res.data; state.files[res.kind] = f.name;
          setSlot(res.kind, true, esc(f.name) + ' &middot; ' + intf(res.rows) + ' rows');
          if (res.warn) msgs.push({ type: 'warn', html: res.warn });
        }
        if (--pending === 0) done();
      };
      reader.onerror = function () { msgs.push({ type: 'err', html: 'Could not read <b>' + esc(f.name) + '</b>.' }); if (--pending === 0) done(); };
      reader.readAsText(f);
    });
    function done() {
      renderMsgs(); refreshBuild();
      var n = ['spend', 'jobs', 'cpu'].filter(function (k) { return state.data[k]; }).length;
      if (n === 3 && !msgs.some(function (m) { return m.type === 'err'; })) { buildReport(); }
      else if (n) { msgs.push({ type: 'info', html: n + ' of 3 files ready. Add the rest, or select <b>Build my X-Ray</b> to see a report from what you have.' }); renderMsgs(); }
    }
  }
  function clearSample() {
    state.sample = false; state.data = { spend: null, jobs: null, cpu: null }; state.files = {};
    ['spend', 'jobs', 'cpu'].forEach(function (k) { setSlot(k, null, 'Waiting for file'); });
    setRibbon(false);
  }
  function setRibbon(on) {
    $('#sampleRibbon').hidden = !on; document.body.classList.toggle('has-ribbon', on);
    var st = $('#samplePage');
    if (on && !st) {
      st = document.createElement('style'); st.id = 'samplePage';
      st.textContent = '@page{@top-center{content:"SAMPLE DATA: synthetic workloads, not a real account";color:#FE0079;font-family:Axiforma,Poppins,sans-serif;font-weight:700;font-size:8.5pt;letter-spacing:.12em}}';
      document.head.appendChild(st);
    } else if (!on && st) st.parentNode.removeChild(st);
  }

  function loadSample() {
    var S = window.XRAY_SAMPLE;
    state.data = { spend: null, jobs: null, cpu: null }; state.files = {};
    ['spend', 'jobs', 'cpu'].forEach(function (k) {
      var res = ingest('sample-' + k + '.csv', S[k]);
      state.data[res.kind] = res.data; state.files[res.kind] = 'sample-' + k + '.csv';
    });
    state.sample = true; state.ratio = DEFAULT_RATIO;
    setRibbon(true);
    buildReport();
  }

  // ---------- model ----------
  function compute() {
    var D = state.data, m = { ratio: state.ratio };
    // currency
    currency = 'USD';
    if (D.spend) { var cur = D.spend.rows.map(function (r) { return r.cur; }).filter(Boolean)[0]; if (cur && /^[A-Z]{3}$/.test(cur)) currency = cur; }

    if (D.spend) {
      var rows = D.spend.rows, priced = rows.filter(function (r) { return r.priced; });
      m.total = sum(priced, function (r) { return r.cost; });
      m.unpriced = rows.filter(function (r) { return !r.priced; });
      m.unpricedDbus = sum(m.unpriced, function (r) { return r.dbus; });
      var byP = {};
      priced.forEach(function (r) { byP[r.product] = (byP[r.product] || 0) + r.cost; });
      m.byProduct = Object.keys(byP).map(function (k) { return { k: k, v: byP[k] }; }).filter(function (x) { return Math.abs(x.v) > 0.004; }).sort(function (a, b) { return b.v - a.v; });
      m.skuCount = new Set(priced.map(function (r) { return r.sku; })).size;
      if (D.spend.has.traced) {
        m.traced = sum(priced.filter(function (r) { return r.traced; }), function (r) { return r.cost; });
        m.untraced = m.total - m.traced;
        var byU = {};
        priced.filter(function (r) { return !r.traced; }).forEach(function (r) { byU[r.product] = (byU[r.product] || 0) + r.cost; });
        m.untracedBy = Object.keys(byU).map(function (k) { return { k: k, v: byU[k] }; }).sort(function (a, b) { return b.v - a.v; });
      }
      // implied price ratio from the account's own list prices
      var jc = priced.filter(function (r) { return /JOBS/.test(r.sku) && !/SERVERLESS/.test(r.sku) && !/ALL_PURPOSE/.test(r.sku); });
      var ap = priced.filter(function (r) { return /ALL_PURPOSE/.test(r.sku) && !/SERVERLESS/.test(r.sku); });
      var jcD = sum(jc, function (r) { return r.dbus; }), apD = sum(ap, function (r) { return r.dbus; });
      if (jcD > 0 && apD > 0) {
        var ir = (sum(jc, function (r) { return r.cost; }) / jcD) / (sum(ap, function (r) { return r.cost; }) / apD);
        if (ir > 0.05 && ir < 1) m.implied = Math.round(ir * 100) / 100;
      }
    }

    if (D.jobs) {
      var J = D.jobs.rows.slice().sort(function (a, b) { return b.cost - a.cost; });
      m.jobs = J; m.jobsTotal = sum(J, function (j) { return j.cost; });
      m.hasFailed = D.jobs.has.failed;
      m.failedCost = sum(J, function (j) { return j.failedCost; });
      m.failedRuns = sum(J, function (j) { return j.failedRuns; });
      m.runs = sum(J, function (j) { return j.runs; });
      m.hasAP = D.jobs.has.ap; m.hasSched = D.jobs.has.scheduled;
      J.forEach(function (j) {
        var c = j.cost > 0 ? j.cost : 0;
        j.apShare = c ? j.ap / c : 0; j.slShare = c ? j.sl / c : 0;
        j.type = !m.hasAP ? null : j.apShare >= 0.5 ? 'ap' : j.slShare >= 0.5 ? 'sl' : (j.apShare + j.slShare) < 0.1 ? 'jc' : 'mx';
      });
      var apJobs = J.filter(function (j) { return j.ap > 0 && (!m.hasSched || (j.sched || 0) > 0); });
      m.apJobs = apJobs;
      m.apBase = sum(apJobs, function (j) { return j.ap; });
      m.apAll = sum(J, function (j) { return j.ap; });
      m.apSaving = m.hasAP ? m.apBase * (1 - m.ratio) : 0;
    } else { m.apSaving = 0; }

    if (D.cpu) {
      var C = D.cpu.rows.slice();
      m.hasCpuCost = D.cpu.has.cpuCost;
      m.clustersSeen = C.length;
      var under = C.filter(function (c) { return (c.hours == null || c.hours >= MIN_HOURS) && c.avg < UNDER_AVG && c.p95 < UNDER_P95; });
      under.forEach(function (c) {
        var isAP = c.source === 'UI' || c.source === 'API';
        c.isAP = isAP;
        // apply after the AP-to-Jobs estimate: all-purpose cluster cost is reduced to the post-move remainder first
        c.base = c.cost == null ? null : c.cost * (isAP && m.apSaving > 0 ? m.ratio : 1);
        c.frac = Math.max(0, Math.min(RS_CAP, 1 - c.p95 / RS_TARGET_P95));
        c.saving = c.base == null ? null : c.base * c.frac;
      });
      under.sort(function (a, b) { return (b.saving || 0) - (a.saving || 0) || (b.cost || 0) - (a.cost || 0); });
      m.under = under;
      m.underCost = sum(under, function (c) { return c.cost; });
      m.rsSaving = sum(under, function (c) { return c.saving; });
    } else { m.rsSaving = 0; }

    m.est = m.apSaving + m.rsSaving;
    var ceiling = m.total != null ? m.total : (m.jobsTotal || 0) + (m.underCost || 0);
    m.capped = false;
    if (ceiling > 0 && m.est > ceiling) { m.est = ceiling; m.capped = true; }
    m.annual = m.est * 365 / DAYS;
    return m;
  }

  // ---------- report rendering ----------
  var ICON = {
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10.5V4a1.5 1.5 0 0 1 1.5-1.5H10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    print: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6V2.5h7V6M4.5 11.5h-2V6.5h11v5h-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="4.5" y="9.5" width="7" height="4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
  };
  var M_CHIP = '<span class="chip chip-m">Measured</span>';
  function E_CHIP(method) { return '<span class="chip chip-e" title="' + esc(method) + '">Estimated</span>'; }
  function emptyBox(what, q) { return '<div class="empty"><span class="chip chip-n">Not provided</span><span>Add the <b>query ' + q + '</b> file (' + what + ') to fill this section.</span></div>'; }

  function kpi(cls, label, value, chip, sub) {
    return '<div class="card kpi ' + cls + '"><div class="kpi-top"><span class="kpi-l">' + label + '</span>' + chip + '</div><div class="kpi-v">' + value + '</div><div class="kpi-s">' + sub + '</div></div>';
  }

  function render(m) {
    var D = state.data, provided = ['spend', 'jobs', 'cpu'].filter(function (k) { return D[k]; });
    var now = new Date();
    var dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    var h = '';

    // header
    h += '<section class="r-hero"><div class="grid-bg" aria-hidden="true"></div><div class="wrap" style="position:relative">';
    h += '<div class="r-toolbar no-print"><button type="button" class="tb-btn" data-action="reset">' + ICON.back + '<span>New X-Ray</span></button><span class="sp"></span>' +
      '<button type="button" class="tb-btn" data-action="copy-summary">' + ICON.copy + '<span>Copy summary</span></button>' +
      '<button type="button" class="tb-btn" data-action="print">' + ICON.print + '<span>Print / save as PDF</span></button></div>';
    h += '<div class="r-title-row"><div>';
    h += '<p class="eyebrow">' + (state.sample ? '<span class="sample-flag">Sample data</span> ' : '') + 'Databricks Cost X-Ray <span class="dot" aria-hidden="true">/</span> last ' + DAYS + ' days</p>';
    h += '<h1 class="h1" style="font-size:clamp(32px,4.4vw,52px)">Your 90-day <em>cost</em> <span class="nw">X-Ray</span></h1>';
    h += '<div class="r-meta"><span class="chip chip-g">Generated ' + esc(dateStr) + '</span><span class="chip chip-g">List prices, ' + esc(currency) + '</span>' +
      ['spend', 'jobs', 'cpu'].map(function (k) { return '<span class="chip ' + (D[k] ? 'chip-m' : 'chip-n') + '">Q' + SCHEMAS[k].q + ' ' + SCHEMAS[k].label + (D[k] ? '' : ': not provided') + '</span>'; }).join('') + '</div>';
    h += '</div><div class="r-legend" aria-label="Legend"><div>' + M_CHIP + '<span>Read directly from your system tables</span></div><div><span class="chip chip-e">Estimated</span><span>Derived with a stated rule. Treat as a range, not a promise</span></div></div>';
    h += '</div></div></section>';

    h += '<div class="r-body"><div class="wrap">';

    // KPIs
    h += '<div class="kpis">';
    h += m.total != null
      ? kpi('', '90-day list spend', money(m.total), M_CHIP, intf(m.skuCount) + ' SKUs at list price' + (m.unpriced && m.unpriced.length ? '. ' + m.unpriced.length + ' usage line' + (m.unpriced.length > 1 ? 's' : '') + ' had no list price match' : ''))
      : kpi('na', '90-day list spend', 'Needs query 1', '<span class="chip chip-n">Missing</span>', 'Add the spend summary file');
    h += m.traced != null
      ? kpi('', 'Traced to job runs', pct(m.total ? m.traced / m.total : 0), M_CHIP, money(m.traced) + ' traced. <b>' + money(m.untraced) + '</b> untraced is a visibility gap, not savings')
      : kpi('na', 'Traced to job runs', D.spend ? 'Column missing' : 'Needs query 1', '<span class="chip chip-n">Missing</span>', 'Needs the traced_to_job column');
    h += m.hasFailed
      ? kpi('k-waste', 'Failed or timed-out runs', money(m.failedCost), M_CHIP, intf(m.failedRuns) + ' of ' + intf(m.runs) + ' runs ended ' + 'FAILED, TIMED_OUT or ERROR')
      : kpi('na', 'Failed or timed-out runs', 'Needs query 2', '<span class="chip chip-n">Missing</span>', 'Add the cost per job file');
    var estMethod = 'All-Purpose to Jobs compute price ratio, then right-sizing on the remainder';
    h += (D.jobs || D.cpu)
      ? kpi('k-save', 'Estimated opportunity', money(m.est), E_CHIP(estMethod), (m.total ? pct(m.est / m.total, 1) + ' of 90-day spend. ' : '') + 'About ' + money(m.annual, { compact: true }) + ' a year at this run rate')
      : kpi('na', 'Estimated opportunity', 'Needs query 2 or 3', '<span class="chip chip-n">Missing</span>', 'Add the per-job or CPU file');
    h += '</div>';

    h += '<div class="r-grid">';

    // spend by product
    h += '<section class="card panel span-7" aria-labelledby="h-prod"><div class="p-head"><div><h3 id="h-prod">Spend by billing product</h3><p>90-day list cost by <code>billing_origin_product</code>.</p></div><div class="p-chips">' + M_CHIP + '</div></div>';
    if (m.byProduct) {
      var max = Math.max.apply(null, m.byProduct.map(function (x) { return x.v; }).concat([1]));
      var shown = m.byProduct.slice(0, 9), rest = m.byProduct.slice(9);
      if (rest.length) shown.push({ k: 'OTHER (' + rest.length + ')', v: sum(rest, function (x) { return x.v; }) });
      h += '<div class="bars" role="img" aria-label="Bar chart of spend by billing product">' + shown.map(function (x) {
        return '<div class="bar-row"><span class="bar-l" title="' + esc(x.k) + '">' + esc(x.k) + '</span><span class="bar-t"><span class="bar-f' + (x.k === 'ALL_PURPOSE' ? ' ap' : '') + '" style="width:' + Math.max(0.5, x.v / max * 100).toFixed(2) + '%"></span></span><span class="bar-v">' + money(x.v) + '</span><span class="bar-p">' + pct(m.total ? x.v / m.total : 0, 1) + '</span></div>';
      }).join('') + '</div>';
      if (m.unpriced && m.unpriced.length) h += '<p class="kpi-s" style="margin-top:14px">Not priced: ' + m.unpriced.map(function (r) { return '<code>' + esc(r.sku || r.product) + '</code>'; }).slice(0, 4).join(' ') + (m.unpriced.length > 4 ? ' and others' : '') + '. These usage lines had no matching list price (often non-DBU units such as networking) and are excluded from totals.</p>';
    } else h += emptyBox('spend summary', 1);
    h += '</section>';

    // visibility
    h += '<section class="card panel span-5" aria-labelledby="h-vis"><div class="p-head"><div><h3 id="h-vis">Visibility gap</h3><p>Spend traced to a job run versus everything else.</p></div><div class="p-chips">' + M_CHIP + '</div></div>';
    if (m.traced != null && m.total) {
      var tp = m.traced / m.total;
      h += '<div class="vis-big"><span class="n">' + pct(1 - tp) + '</span><span class="t">of spend (' + money(m.untraced) + ') cannot be attributed to a job</span></div>';
      h += '<div class="stack" role="img" aria-label="' + pct(tp) + ' traced, ' + pct(1 - tp) + ' untraced"><span class="tr" style="width:' + (tp * 100).toFixed(2) + '%"></span><span class="un" style="width:' + ((1 - tp) * 100).toFixed(2) + '%"></span></div>';
      h += '<div class="stack-l"><span><i class="sw tr"></i>Traced ' + money(m.traced) + '</span><span><i class="sw un"></i>Untraced ' + money(m.untraced) + '</span></div>';
      if (m.untracedBy && m.untracedBy.length) h += '<div class="mini" aria-label="Untraced spend by product">' + m.untracedBy.slice(0, 5).map(function (x) { return '<div><span>' + esc(x.k) + '</span><span>' + money(x.v) + '</span></div>'; }).join('') + '</div>';
      h += '<p class="vis-note">Untraced is <b>not</b> savings. It is notebooks, SQL warehouses, pipelines and serving that no job run owns. You cannot judge spend you cannot attribute, so closing this gap usually comes first.</p>';
    } else h += D.spend ? '<div class="empty">The spend file has no <code>traced_to_job</code> column, so the gap cannot be measured.</div>' : emptyBox('spend summary', 1);
    h += '</section>';

    // top jobs
    h += '<section class="card panel span-12" aria-labelledby="h-jobs"><div class="p-head"><div><h3 id="h-jobs">Top 10 jobs by cost</h3><p>List cost per job over 90 days, with the cost of runs that ended ' + FAILED_STATES + '.' + (m.jobs ? ' Showing ' + Math.min(10, m.jobs.length) + ' of ' + intf(m.jobs.length) + ' jobs, together ' + money(m.jobsTotal) + '.' : '') + '</p></div><div class="p-chips">' + M_CHIP + '</div></div>';
    if (m.jobs) {
      var top = m.jobs.slice(0, 10), topMax = top.length ? top[0].cost : 1;
      var TL = { ap: ['ap', 'All-Purpose'], jc: ['jc', 'Jobs compute'], sl: ['sl', 'Serverless'], mx: ['mx', 'Mixed'] };
      h += '<div class="tbl-wrap"><table class="t"><thead><tr><th scope="col">#</th><th scope="col">Job</th><th scope="col">Compute</th><th scope="col" class="r">Runs</th><th scope="col" class="r">Failed runs</th><th scope="col" class="r">Failed cost</th><th scope="col" class="r">90-day cost</th></tr></thead><tbody>';
      top.forEach(function (j, i) {
        var t = j.type ? TL[j.type] : null;
        h += '<tr><td class="rank">' + (i + 1) + '</td><td class="name" title="' + esc(j.name) + '">' + esc(j.name) + '<span class="sub">' + esc(j.id) + (j.sched === 0 ? ' &middot; manual runs' : '') + '</span></td>' +
          '<td data-label="Compute">' + (t ? '<span class="pill ' + t[0] + '">' + t[1] + '</span>' : '<span class="zero">n/a</span>') + '</td>' +
          '<td class="r" data-label="Runs">' + intf(j.runs) + '</td><td data-label="Failed runs" class="r' + (j.failedRuns ? '' : ' zero') + '">' + intf(j.failedRuns) + '</td>' +
          '<td data-label="Failed cost" class="r ' + (j.failedCost ? 'neg' : 'zero') + '">' + (j.failedCost == null ? 'n/a' : money(j.failedCost)) + '</td>' +
          '<td class="r" data-label="90-day cost"><b>' + money(j.cost) + '</b><span class="share" aria-hidden="true"><i style="width:' + (j.cost / topMax * 100).toFixed(1) + '%"></i></span></td></tr>';
      });
      h += '</tbody></table></div>';
    } else h += emptyBox('cost per job', 2);
    h += '</section>';

    // AP to Jobs
    var apMethod = 'All-Purpose cost x (1 - jobs rate / all-purpose rate)';
    h += '<section class="card panel span-12" aria-labelledby="h-ap"><div class="p-head"><div><h3 id="h-ap">Scheduled jobs on All-Purpose compute</h3><p>Automated job runs billed at the All-Purpose rate. Jobs compute runs the same workload at a lower list price per DBU.</p></div><div class="p-chips">' + M_CHIP.replace('Measured', 'Cost measured') + E_CHIP(apMethod).replace('>Estimated<', '>Saving estimated<') + '</div></div>';
    if (m.jobs && m.hasAP) {
      h += '<div class="est"><div>';
      h += '<div class="kpi-l">' + (m.hasSched ? 'Scheduled or triggered job cost on All-Purpose' : 'Job cost on All-Purpose (trigger type not in file)') + '</div>';
      h += '<div class="kpi-v" style="margin:4px 0 14px">' + money(m.apBase) + '</div>';
      h += '<div class="kpi-l">Estimated saving from moving it to Jobs compute</div><div class="est-n" id="apSaving">' + money(m.apSaving) + '</div>';
      h += '<div class="formula">Rule: All-Purpose cost × (1 - jobs rate / all-purpose rate)<br><b>' + money(m.apBase) + ' × (1 - ' + m.ratio.toFixed(2) + ') = ' + money(m.apSaving) + '</b></div>';
      if (m.hasSched && m.apAll - m.apBase > 1) h += '<p class="est-s">A further ' + money(m.apAll - m.apBase) + ' of job cost on All-Purpose comes from manually started runs and is not included.</p>';
      if (m.apJobs.length) h += '<div class="mini">' + m.apJobs.slice().sort(function (a, b) { return b.ap - a.ap; }).slice(0, 5).map(function (j) { return '<div><span>' + esc(j.name) + '</span><span>' + money(j.ap) + '</span></div>'; }).join('') + '</div>';
      h += '</div><div class="ratio-box no-print-inputs">';
      h += '<label for="ratioIn">Price ratio: Jobs rate / All-Purpose rate</label>';
      h += '<div class="ratio-in"><input id="ratioIn" type="number" min="0.05" max="1" step="0.01" value="' + m.ratio.toFixed(2) + '" inputmode="decimal" aria-describedby="ratioSrc"><span class="ratio-pct" id="ratioPct">Jobs compute costs ' + pct(m.ratio) + ' of the All-Purpose rate</span></div>';
      h += '<p class="ratio-src" id="ratioSrc"><b>List-price assumption.</b> Default ' + DEFAULT_RATIO.toFixed(2) + ' = $' + JOBS_RATE.toFixed(2) + ' per DBU for Jobs Classic divided by $' + AP_RATE.toFixed(2) + ' per DBU for Classic All-Purpose, from Databricks published list prices (Premium tier, AWS, checked 5 October 2026). Rates depend on cloud, tier and region, so edit it to match yours. <a href="https://www.databricks.com/product/pricing" rel="noopener">databricks.com/product/pricing</a></p>';
      if (m.implied && Math.abs(m.implied - m.ratio) >= 0.005) h += '<button type="button" class="ratio-use" data-action="use-implied" data-v="' + m.implied + '">Use the ratio implied by your own list prices: ' + m.implied.toFixed(2) + '</button>';
      else if (m.implied) h += '<p class="ratio-src">Matches the ratio implied by the list prices in your spend file (' + m.implied.toFixed(2) + ').</p>';
      h += '</div></div>';
    } else h += m.jobs ? '<div class="empty">The per-job file has no <code>all_purpose_cost</code> column, so this cannot be calculated.</div>' : emptyBox('cost per job', 2);
    h += '</section>';

    // under-used clusters
    var rsMethod = 'cost x min(50%, 1 - p95 CPU / 60%)';
    h += '<section class="card panel span-12" aria-labelledby="h-rs"><div class="p-head"><div><h3 id="h-rs">Under-used clusters</h3><p>Worker CPU averaged under ' + UNDER_AVG + '% with a 95th percentile under ' + UNDER_P95 + '%, across at least 30 minutes of activity. CPU measured; right-sizing saving estimated.</p></div><div class="p-chips">' + M_CHIP.replace('Measured', 'CPU measured') + E_CHIP(rsMethod).replace('>Estimated<', '>Saving estimated<') + '</div></div>';
    if (m.under) {
      if (!m.under.length) h += '<div class="empty">None of the ' + intf(m.clustersSeen) + ' clusters in the file met the under-used test. That is a good sign.</div>';
      else {
        h += '<div class="tbl-wrap"><table class="t"><thead><tr><th scope="col">Cluster</th><th scope="col">Source</th><th scope="col" class="r">Hours</th><th scope="col">Avg CPU</th><th scope="col">p95 CPU</th><th scope="col" class="r">90-day cost</th><th scope="col" class="r">Est. saving</th></tr></thead><tbody>';
        m.under.slice(0, 12).forEach(function (c) {
          h += '<tr><td class="name" title="' + esc(c.name || c.id) + '">' + esc(c.name || c.id) + '<span class="sub">' + esc(c.node || c.id) + '</span></td><td data-label="Source">' + (c.source ? '<span class="pill ' + (c.isAP ? 'ap' : 'jc') + '">' + esc(c.source) + '</span>' : '<span class="zero">n/a</span>') + '</td>' +
            '<td class="r" data-label="Hours">' + (c.hours == null ? 'n/a' : intf(c.hours)) + '</td>' +
            '<td data-label="Avg CPU"><span class="cpu"><span class="cpu-t" aria-hidden="true"><i style="width:' + Math.min(100, c.avg) + '%"></i></span>' + c.avg.toFixed(1) + '%</span></td>' +
            '<td data-label="p95 CPU"><span class="cpu"><span class="cpu-t" aria-hidden="true"><i style="width:' + Math.min(100, c.p95) + '%"></i></span>' + c.p95.toFixed(1) + '%</span></td>' +
            '<td class="r" data-label="90-day cost">' + (c.cost == null ? 'n/a' : money(c.cost)) + '</td><td class="r sav" data-label="Est. saving">' + (c.saving == null ? 'n/a' : money(c.saving)) + '</td></tr>';
        });
        h += '</tbody><tfoot><tr><td colspan="5" class="tf-l">' + m.under.length + ' of ' + intf(m.clustersSeen) + ' clusters flagged' + (m.under.length > 12 ? ' (top 12 shown)' : '') + '</td><td class="r" data-label="90-day cost">' + money(m.underCost) + '</td><td class="r sav" data-label="Est. saving">' + money(m.rsSaving) + '</td></tr></tfoot></table></div>';
        h += '<div class="formula">Rule: shrink until 95th percentile CPU would reach ' + RS_TARGET_P95 + '%. Saving = cost × min(' + (RS_CAP * 100) + '%, 1 - p95 / ' + RS_TARGET_P95 + '%).' + (m.apSaving > 0 ? ' For All-Purpose clusters (source UI or API) the cost is first reduced to what would remain after the All-Purpose to Jobs move, so the same dollar is never counted twice.' : '') + (m.hasCpuCost ? '' : ' The CPU file has no list_cost column, so savings cannot be priced.') + '</div>';
      }
    } else h += emptyBox('cluster CPU', 3);
    h += '</section>';

    // how they combine
    if (m.total != null && (D.jobs || D.cpu)) {
      var T = m.total, ap = Math.min(m.apSaving, T), rs = Math.min(m.rsSaving, Math.max(0, T - ap)), rem = Math.max(0, T - ap - rs);
      var w = function (v) { return (v / T * 100).toFixed(2) + '%'; };
      h += '<section class="card panel span-12" aria-labelledby="h-wf"><div class="p-head"><div><h3 id="h-wf">How the estimates combine</h3><p>Applied in sequence on the 90-day list spend so no dollar is counted twice. The total can never exceed what you spent.</p></div><div class="p-chips">' + E_CHIP(estMethod) + '</div></div>';
      h += '<div class="wf" role="img" aria-label="Waterfall from total spend to remaining spend after estimates">';
      h += '<div class="wf-row"><span class="wf-l">90-day list spend<small>Measured</small></span><span class="wf-t"><span class="wf-b base" style="left:0;width:100%"></span></span><span class="wf-v">' + money(T) + '</span></div>';
      h += '<div class="wf-row"><span class="wf-l">All-Purpose to Jobs<small>Estimated, step 1</small></span><span class="wf-t"><span class="wf-b cut" style="left:' + w(T - ap) + ';width:' + w(ap) + '"></span></span><span class="wf-v o">-' + money(ap) + '</span></div>';
      h += '<div class="wf-row"><span class="wf-l">Right-size under-used<small>Estimated, step 2, on the remainder</small></span><span class="wf-t"><span class="wf-b cut" style="left:' + w(T - ap - rs) + ';width:' + w(rs) + '"></span></span><span class="wf-v o">-' + money(rs) + '</span></div>';
      h += '<div class="wf-row"><span class="wf-l"><b>After both changes</b><small>Estimated</small></span><span class="wf-t"><span class="wf-b rem" style="left:0;width:' + w(rem) + '"></span></span><span class="wf-v"><b>' + money(rem) + '</b></span></div>';
      h += '</div>';
      h += '<div class="callout"><span class="chip chip-e">Estimated</span><span>Combined estimate <b>' + money(ap + rs) + '</b>, ' + pct((ap + rs) / T, 1) + ' of 90-day list spend. Failed-run cost (' + (m.hasFailed ? money(m.failedCost) : 'n/a') + ') is shown as measured waste and is deliberately not added here, and untraced spend is never counted as savings.' + (m.capped ? ' The estimate was capped at total spend.' : '') + '</span></div>';
      h += '</section>';
    }
    h += '</div>'; // r-grid

    // can't see + full assessment
    h += '<div class="cant">';
    h += '<section class="card cant-box miss" aria-labelledby="h-cant"><h3 class="h3" id="h-cant">What this report <em>can\'t</em> see</h3><ul>' +
      '<li><b>Contract discounts.</b> Everything is at list price. Committed-use discounts lower the dollars but not the proportions.</li>' +
      '<li><b>Cloud VM costs.</b> System tables hold DBUs, not the EC2, Azure VM or GCE bill behind classic compute, which can be as large again.</li>' +
      '<li><b>Untraced spend.</b> ' + (m.untraced != null ? money(m.untraced) + ' of usage' : 'Usage') + ' has no job attached, so it cannot be judged here.</li>' +
      '<li><b>Job classification.</b> Whether a job is still needed, duplicated or over-scheduled needs context that billing data does not carry.</li>' +
      '<li><b>Query and code efficiency.</b> Skew, spill, small files and inefficient joins hide inside well-utilised clusters.</li></ul></section>';
    h += '<section class="card cant-box adds" aria-labelledby="h-adds"><h3 class="h3" id="h-adds">What the full <em>assessment</em> adds</h3><ul>' +
      '<li><b>Net cost, not list.</b> Your contract rates and cloud infrastructure cost, reconciled to the invoice.</li>' +
      '<li><b>Every dollar attributed.</b> Notebooks, warehouses, pipelines and serving mapped to owners and workloads.</li>' +
      '<li><b>Workload-level fixes.</b> Code, configuration and scheduling changes ranked by saving and effort.</li>' +
      '<li><b>Renewal evidence.</b> A defensible baseline and forecast to take into your Databricks negotiation.</li></ul>' +
      '<div class="cta-row"><a class="btn btn-y print-url" data-short="bighammer.ai/book-demo" href="' + esc(linkFor('book', 'report-book-call')) + '">Book a call with BigHammer</a>' +
      '<a class="btn btn-outline-l print-url" data-short="assessment.bighammerops.com" href="' + esc(linkFor('assess', 'report-offline-assessment')) + '">Run the offline assessment</a></div>' +
      '<a class="guide-link" href="' + esc(linkFor('guide', 'report-field-guide')) + '">Read the Databricks Cost Field Guide</a></section>';
    h += '</div>';

    // methodology
    h += '<section class="card method" aria-labelledby="h-meth"><h3 id="h-meth">Method and definitions</h3><dl>' +
      '<dt>List cost</dt><dd><code>usage_quantity</code> × <code>pricing.effective_list.default</code> from <code>system.billing.list_prices</code>, matched on SKU, cloud, usage unit and the price validity window.</dd>' +
      '<dt>Traced</dt><dd>Usage where <code>usage_metadata.job_run_id</code> is not null.</dd>' +
      '<dt>Failed cost</dt><dd>Cost of job runs whose final <code>result_state</code> in <code>system.lakeflow.job_run_timeline</code> is ' + FAILED_STATES + '.</dd>' +
      '<dt>Scheduled runs</dt><dd>Runs with <code>trigger_type</code> CRON, PERIODIC, CONTINUOUS, FILE_ARRIVAL or TABLE.</dd>' +
      '<dt>All-Purpose cost</dt><dd>SKUs containing <code>ALL_PURPOSE</code> and not <code>SERVERLESS</code>.</dd>' +
      '<dt>CPU</dt><dd><code>cpu_user_percent + cpu_system_percent</code> on worker nodes from <code>system.compute.node_timeline</code>, per-minute samples. Single-node clusters have no workers and do not appear.</dd>' +
      '<dt>Price ratio</dt><dd>' + m.ratio.toFixed(2) + (Math.abs(m.ratio - DEFAULT_RATIO) < 0.005 ? ' (default, Databricks published list prices, Premium tier on AWS)' : ' (edited in this report)') + '.</dd>' +
      '</dl></section>';
    h += '<div class="r-foot"><span>' + (state.sample ? '<b>SAMPLE DATA.</b> Synthetic workloads, not a real account. ' : '') + 'Generated in your browser by BigHammer.ai Cost X-Ray on ' + esc(dateStr) + '. No data left this device.</span><span>adisuja.github.io/bighammer-cost-xray</span></div>';
    h += '</div></div>';
    return h;
  }

  var lastModel = null;
  function buildReport() {
    var m = compute();
    lastModel = m;
    var el = $('#report');
    el.innerHTML = render(m);
    $('#landing').hidden = true; el.hidden = false;
    document.title = (state.sample ? 'SAMPLE: ' : '') + 'Your Databricks Cost X-Ray | BigHammer.ai';
    window.scrollTo(0, 0);
    el.focus({ preventScroll: true });
    var inp = $('#ratioIn');
    if (inp) inp.addEventListener('change', onRatio);
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') onRatio(e); });
  }
  function onRatio(e) {
    var v = parseFloat(e.target.value);
    if (isNaN(v) || v < 0.05 || v > 1) { toast('Enter a ratio between 0.05 and 1'); e.target.value = state.ratio.toFixed(2); return; }
    state.ratio = Math.round(v * 100) / 100;
    rerenderKeepScroll('#ratioIn');
  }
  function rerenderKeepScroll(focusSel) {
    var y = window.scrollY; var m = compute(); lastModel = m;
    $('#report').innerHTML = render(m);
    window.scrollTo(0, y);
    var inp = $('#ratioIn');
    if (inp) { inp.addEventListener('change', onRatio); inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') onRatio(e); }); }
    if (focusSel && $(focusSel)) $(focusSel).focus({ preventScroll: true });
    toast('Estimates updated for ratio ' + state.ratio.toFixed(2));
  }
  function reset() {
    clearSample();
    msgs = []; renderMsgs(); refreshBuild();
    $('#report').hidden = true; $('#report').innerHTML = ''; $('#landing').hidden = false;
    document.title = 'Databricks Cost X-Ray | Free 90-day cost report | BigHammer.ai';
    var t = $('#drop'); if (t) t.scrollIntoView(); $('#fileInput').focus({ preventScroll: true });
  }

  function summary() {
    var m = lastModel, L = [];
    L.push('Databricks Cost X-Ray: last ' + DAYS + ' days at list price (' + currency + ')');
    if (state.sample) L.push('SAMPLE DATA: synthetic workloads, not a real account');
    L.push('');
    if (m.total != null) L.push('Total list spend: ' + money(m.total) + ' [measured]');
    if (m.traced != null) L.push('Traced to job runs: ' + money(m.traced) + ' (' + pct(m.traced / m.total) + '). Untraced visibility gap: ' + money(m.untraced) + ' (' + pct(m.untraced / m.total) + '), not counted as savings [measured]');
    if (m.hasFailed) L.push('Failed or timed-out runs: ' + money(m.failedCost) + ' across ' + intf(m.failedRuns) + ' runs [measured]');
    if (m.jobs && m.jobs.length) L.push('Top job: ' + m.jobs[0].name + ', ' + money(m.jobs[0].cost) + ' [measured]');
    if (m.jobs && m.hasAP) L.push('Scheduled jobs on All-Purpose compute: ' + money(m.apBase) + '. Moving to Jobs compute: about ' + money(m.apSaving) + ' [estimated, cost x (1 - ' + m.ratio.toFixed(2) + '), list-price ratio]');
    if (m.under) L.push('Under-used clusters (avg CPU < ' + UNDER_AVG + '%, p95 < ' + UNDER_P95 + '%): ' + m.under.length + ', right-sizing about ' + money(m.rsSaving) + ' [estimated, applied after the move above]');
    if (state.data.jobs || state.data.cpu) L.push('Combined estimate: ' + money(m.est) + (m.total ? ' (' + pct(m.est / m.total, 1) + ' of spend)' : '') + ', about ' + money(m.annual, { compact: true }) + ' a year [estimated, non-overlapping]');
    L.push('');
    L.push('Not included: contract discounts, cloud VM costs, untraced spend, job-level context.');
    L.push('Made with BigHammer.ai Cost X-Ray (runs in the browser, no upload): ' + linkFor('tool', 'copy-summary'));
    return L.join('\n');
  }

  // ---------- events ----------
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-action]');
    if (a) {
      var act = a.getAttribute('data-action');
      if (act === 'sample') { e.preventDefault(); loadSample(); }
      else if (act === 'build') { buildReport(); }
      else if (act === 'reset') { reset(); }
      else if (act === 'print') { window.print(); }
      else if (act === 'use-implied') { state.ratio = parseFloat(a.getAttribute('data-v')); rerenderKeepScroll('#ratioIn'); }
      else if (act === 'copy-summary') { copyText(summary()).then(function () { toast('Summary copied. Paste it into Slack or email.'); }, function () { toast('Copy failed. Select the text manually.'); }); }
      return;
    }
    var c = e.target.closest('.copy');
    if (c) {
      var code = $('#' + c.getAttribute('data-copy')).textContent;
      copyText(code).then(function () {
        c.textContent = 'Copied'; c.classList.add('ok');
        setTimeout(function () { c.textContent = 'Copy query'; c.classList.remove('ok'); }, 1800);
      }, function () { toast('Copy failed. Select the query manually.'); });
    }
  });

  // tabs
  var tabs = $$('[role=tab]');
  function selectTab(t, focus) {
    tabs.forEach(function (x) {
      var on = x === t; x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1;
      $('#' + x.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) t.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { selectTab(t); });
    t.addEventListener('keydown', function (e) {
      var j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabs.length - 1;
      if (j != null) { e.preventDefault(); selectTab(tabs[j], true); }
    });
  });

  // drop zone
  var dz = $('#dropzone'), fi = $('#fileInput');
  fi.addEventListener('change', function () { handleFiles(fi.files); fi.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); }); });
  dz.addEventListener('drop', function (e) { handleFiles(e.dataTransfer && e.dataTransfer.files); });
  // dropping a file anywhere on the landing page should not navigate away
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); if (!$('#landing').hidden && e.target.closest && !e.target.closest('#dropzone')) handleFiles(e.dataTransfer && e.dataTransfer.files); });

  // deep link: ?sample opens the sample report directly
  if (/[?&#]sample\b/.test(location.search + location.hash)) loadSample();

  // expose for tests
  window.__xray = { parseCSV: parseCSV, ingest: ingest, compute: compute, state: state };
})();
