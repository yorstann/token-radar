// Token Launch Radar's page. Everything it shows comes from window.RADAR, the data.js that
// main.ts writes beside this folder from the same board.json — no fetch, no network. The page
// never recomputes a value: it presents the components lib/model.ts computed, so what the
// screenshots show and what the code does are the same arithmetic.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var rows = D.rows;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    asof: $('asof'), stats: $('stats'), modelLine: $('model-line'),
    q: $('q'), cat: $('cat'), chain: $('chain'),
    watchonly: $('watchonly'), hideshadow: $('hideshadow'), count: $('count'),
    tbody: $('rows'), detail: $('detail'), detailBody: $('detail-body'), close: $('close'),
  };

  // Shareable views: ?q=, ?cat=, ?chain=, ?watch=1, ?noshadow=1, ?detail=<slug>.
  var params = new URLSearchParams(location.search);
  var state = {
    q: params.get('q') || '',
    cat: params.get('cat') || '',
    chain: params.get('chain') || '',
    watch: params.get('watch') === '1',
    noshadow: params.get('noshadow') === '1',
    sortKey: 'rank',
    sortDir: 1,
    selected: params.get('detail') || null,
  };

  /* ---------- formatting ---------- */
  var full = new Intl.NumberFormat('en-US');
  function fmtUsd(n) {
    if (n === null || n === undefined) return '—';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + full.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 730) return (days / 365).toFixed(1) + ' yrs';
    if (days >= 365) return '1.0 yrs';
    return days + ' days';
  }
  function fmtMult(n) { return n.toFixed(3); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- header ---------- */
  var s = D.stats;
  els.asof.innerHTML = 'snapshot as of ' + esc(D.as_of) + '<br>model ' + esc(D.model_version) + ' · floor $' + full.format(D.floor_usd);
  els.stats.innerHTML =
    stat(fmtUsd(s.total_implied_usd), 'total implied value') +
    stat(full.format(s.scanned), 'protocols scanned') +
    stat(full.format(s.pre_token), 'record no token') +
    stat('<em>' + s.watchlist_covered + '/' + s.watchlist_total + '</em>', 'watchlist covered') +
    stat(fmtMult(s.median_category_multiple) + '×', 'median category multiple');
  function stat(v, label) { return '<div class="stat"><b>' + v + '</b><span>' + label + '</span></div>'; }

  els.modelLine.innerHTML =
    'The model, in one line: <code>implied = TVL × categoryMultiple × momentum × maturity × breadth</code> — ' +
    'the multiple is the median market-cap/TVL of the category\u2019s tokenized peers (ratios winsorized at the peer ' +
    'set\u2019s 90th percentile, ' + fmtMult(D.peer_ratio_cap) + '×, so one outlier cannot price a category), shrunk toward the global ' +
    'median of ' + fmtMult(D.global_median_multiple) + '×; wrapped, staked and bridged claims take a further ' +
    '<code>× 0.35</code> shadow discount and are flagged, never hidden. Click any row for its full breakdown and farm plan.';

  /* ---------- filters ---------- */
  D.categories.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; els.cat.appendChild(o);
  });
  D.chains.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; els.chain.appendChild(o);
  });
  els.q.value = state.q;
  els.cat.value = state.cat;
  els.chain.value = state.chain;
  els.watchonly.checked = state.watch;
  els.hideshadow.checked = state.noshadow;

  function visible() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (state.watch && !r.watchlist) return false;
      if (state.noshadow && r.shadow) return false;
      if (q) {
        var hay = (r.name + ' ' + (r.category || '') + ' ' + r.slug + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  var SORTABLE = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    tvl_usd: function (r) { return r.tvl_usd; },
    change_7d: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
    age_days: function (r) { return r.age_days === null ? -1 : r.age_days; },
    implied_value_usd: function (r) { return r.implied_value_usd; },
    ratio: function (r) { return r.ratio; },
  };

  function render() {
    var list = visible();
    var get = SORTABLE[state.sortKey];
    list.sort(function (a, b) {
      var va = get(a), vb = get(b);
      if (va < vb) return -state.sortDir;
      if (va > vb) return state.sortDir;
      return a.rank - b.rank;
    });
    els.count.textContent = 'showing ' + list.length + ' of ' + rows.length + ' protocols';
    if (list.length === 0) {
      els.tbody.innerHTML = '<tr><td colspan="7" class="empty">No protocol matches these filters. Loosen one and the radar sweeps again.</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var badges = '';
      if (r.watchlist) badges += '<span class="badge watch">watchlist</span>';
      if (r.shadow) badges += '<span class="badge shadow">shadow</span>';
      var cls = r.change_7d === null || r.change_7d === 0 ? 'flat' : (r.change_7d > 0 ? 'pos' : 'neg');
      html += '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + badges + '<span class="pcat">' + esc(r.category || 'uncategorised') + '</span></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + cls + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td class="num">' + r.ratio.toFixed(2) + '×</td></tr>';
    }
    els.tbody.innerHTML = html;
    markSortHeader();
  }

  function markSortHeader() {
    var ths = document.querySelectorAll('th.sortable');
    ths.forEach(function (th) {
      var arrow = th.getAttribute('data-key') === state.sortKey
        ? ' <span class="arrow">' + (state.sortDir === 1 ? '▲' : '▼') + '</span>' : '';
      th.innerHTML = th.getAttribute('data-label') || th.textContent.replace(/ [▲▼]$/, '');
      if (!th.getAttribute('data-label')) th.setAttribute('data-label', th.innerHTML);
      th.innerHTML = th.getAttribute('data-label') + arrow;
    });
  }

  /* ---------- the model, presented ---------- */
  // modelBreakdown(): the same components impliedValue() multiplied in lib/model.ts, in words a
  // reader can check against the row: every factor, where it came from, and what it did.
  function modelBreakdown(r) {
    var m = r.model;
    var parts = ['$' + full.format(r.tvl_usd) + ' TVL'];
    parts.push(fmtMult(m.category_multiple) + ' multiple');
    parts.push(fmtMult(m.momentum) + ' momentum');
    parts.push(fmtMult(m.maturity) + ' maturity');
    parts.push(fmtMult(m.breadth) + ' breadth');
    if (r.shadow) parts.push('0.350 shadow');
    var formula = parts.join(' × ') + ' = $' + full.format(r.implied_value_usd);

    var lines = [];
    if (m.peer_count > 0) {
      lines.push('The <b>' + fmtMult(m.category_multiple) + '×</b> multiple is <code>categoryMultiple()</code>: the median market-cap/TVL of the <b>' +
        m.peer_count + '</b> tokenized ' + esc(r.category || '') + ' peers in this snapshot is ' + fmtMult(m.peer_median) +
        '×, shrunk toward the global tokenized median of ' + fmtMult(D.global_median_multiple) + '× with 4 phantom peers, so a thin category cannot price on two names alone.' +
        (m.peer_median >= D.peer_ratio_cap - 1e-9 ? ' That peer median sits at the winsorizing cap — the peer set\u2019s 90th percentile, ' + fmtMult(D.peer_ratio_cap) + '× — because at least one peer\u2019s raw ratio runs far above it.' : ''));
    } else {
      lines.push('No tokenized ' + esc(r.category || '') + ' protocol in this snapshot carries both a market cap and a TVL, so <code>categoryMultiple()</code> falls back to the global tokenized median of <b>' + fmtMult(D.global_median_multiple) + '×</b>.');
    }
    if (r.change_7d === null) {
      lines.push('No seven-day change is reported for ' + esc(r.name) + ', so momentum is neutral at <b>1.000</b>.');
    } else {
      lines.push('Its TVL moved <b>' + fmtPct(r.change_7d) + '</b> in seven days, so momentum is <b>' + fmtMult(m.momentum) + '</b> (1 + change, clamped to 0.700–1.600).');
    }
    if (r.age_days === null) {
      lines.push('No listing date is recorded, so maturity is neutral at <b>1.000</b>.');
    } else {
      lines.push('It has run <b>' + full.format(r.age_days) + ' days</b> with no token (listed ' + esc(r.listed_at) + '), so maturity is <b>' + fmtMult(m.maturity) + '</b> — 0.850 plus 0.300 for each 720 days survived, capped at two years.');
    }
    lines.push('It is live on <b>' + r.chains.length + (r.chains.length === 1 ? ' chain</b>' : ' chains</b>') + ', so breadth is <b>' + fmtMult(m.breadth) + '</b> — 1 plus 0.030 per extra chain, up to five.');
    if (r.shadow) {
      lines.push('<b>Shadow claim:</b> ' + esc(r.name) + ' is a wrapped, staked or bridged face on value a tokenized parent already prices (or sits in a category the radar treats that way), so its implied value takes the <b>× 0.350</b> shadow discount. It stays on the board — it records no token — but it is not priced like a first token.');
    }
    return '<div class="breakdown"><div class="formula">' + formula + '</div>' +
      lines.map(function (l) { return '<p>' + l + '</p>'; }).join('') +
      '<p>Computed by <code>impliedValue()</code> in lib/model.ts from the snapshot\u2019s own figures; no protocol is named in the model.</p></div>';
  }

  /* ---------- detail ---------- */
  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) { r = rows[i]; break; }
    if (!r) return;
    state.selected = slug;
    var badges = '';
    if (r.watchlist) badges += '<span class="badge watch">watchlist</span>';
    if (r.shadow) badges += '<span class="badge shadow">shadow</span>';
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    els.detailBody.innerHTML =
      '<h2>' + esc(r.name) + badges + '</h2>' +
      '<div class="sub">rank #' + r.rank + ' of ' + rows.length + ' · ' + esc(r.category || 'uncategorised') + ' · records no token</div>' +
      '<div class="big-implied">$' + full.format(r.implied_value_usd) + '<small>implied value if a token were priced on today\u2019s record — ' + r.ratio.toFixed(2) + '× its TVL</small></div>' +
      modelBreakdown(r) +
      '<div class="meta">' +
      '<span>TVL <b>$' + full.format(r.tvl_usd) + '</b></span>' +
      '<span>7d change <b>' + fmtPct(r.change_7d) + '</b></span>' +
      '<span>Listed <b>' + (r.listed_at ? esc(r.listed_at) : 'not recorded') + '</b></span>' +
      '<span>Age <b>' + fmtAge(r.age_days) + '</b></span>' +
      '</div>' +
      '<div class="chips">' + r.chains.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>' +
      '<div class="farm"><h3>Farm plan</h3>' +
      '<div class="summary">Cost: ' + esc(r.farm_cost) + ' · Time: ' + esc(r.farm_time) + '</div>' +
      '<ol>' + steps + '</ol></div>';
    els.detail.hidden = false;
    render();
    els.detail.scrollIntoView({ block: 'start' });
  }

  els.close.addEventListener('click', function () {
    els.detail.hidden = true;
    state.selected = null;
    render();
  });

  /* ---------- events ---------- */
  els.q.addEventListener('input', function () { state.q = els.q.value; render(); });
  els.cat.addEventListener('change', function () { state.cat = els.cat.value; render(); });
  els.chain.addEventListener('change', function () { state.chain = els.chain.value; render(); });
  els.watchonly.addEventListener('change', function () { state.watch = els.watchonly.checked; render(); });
  els.hideshadow.addEventListener('change', function () { state.noshadow = els.hideshadow.checked; render(); });
  document.querySelectorAll('th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-key');
      if (state.sortKey === key) state.sortDir = -state.sortDir;
      else { state.sortKey = key; state.sortDir = key === 'name' ? 1 : -1; }
      render();
    });
  });
  els.tbody.addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });

  render();
  if (state.selected) openDetail(state.selected);

  /* ---------- scope grain ----------
     A fixed film of per-pixel static over the page, drawn once from a seeded generator so
     every load shows the same grain: the radar scope's texture, and the reason the page's
     screenshots carry their weight. Kept faint enough that figures stay crisp. */
  (function grain() {
    var c = document.createElement('canvas');
    c.width = window.innerWidth;
    c.height = window.innerHeight;
    c.style.cssText = 'position:fixed;inset:0;z-index:60;pointer-events:none;';
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(c.width, c.height);
    var seed = 20261114;
    function rnd() {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    for (var i = 0; i < img.data.length; i += 4) {
      if (rnd() >= 0.013) continue;
      var v = 140 + Math.floor(rnd() * 115);
      img.data[i] = v; img.data[i + 1] = v + 14; img.data[i + 2] = v + 30;
      img.data[i + 3] = 30;
    }
    ctx.putImageData(img, 0, 0);
    document.body.appendChild(c);
  })();
})();
