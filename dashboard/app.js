/*
 * Pulse dashboard.
 *
 * Plain browser JavaScript, no modules and no build step, so the page works
 * three ways with no configuration:
 *
 *   1. Deployed to GitHub Pages, reading history.json from the status branch
 *      (config.js is generated at deploy time from GITHUB_REPOSITORY).
 *   2. Opened straight off the filesystem next to a local history.json.
 *   3. Anywhere, with ?data=<url> to point at an arbitrary history file.
 */

(function () {
  'use strict';

  var DAYS = 90;
  var SPARK_POINTS = 45;

  var els = {
    grid: document.getElementById('grid'),
    loading: document.getElementById('loading'),
    notice: document.getElementById('notice'),
    noticeTitle: document.getElementById('notice-title'),
    noticeBody: document.getElementById('notice-body'),
    noticeDetail: document.getElementById('notice-detail'),
    search: document.getElementById('search'),
    onlyFailing: document.getElementById('only-failing'),
    count: document.getElementById('result-count'),
    template: document.getElementById('card-template'),
    sourceUrl: document.getElementById('source-url'),
    themeToggle: document.getElementById('theme-toggle'),
    stats: {
      total: document.getElementById('stat-total'),
      healthy: document.getElementById('stat-healthy'),
      failing: document.getElementById('stat-failing'),
      lastRun: document.getElementById('stat-lastrun'),
      failingBox: document.querySelector('.stat--down'),
    },
  };

  /** @type {Array<object>} */
  var targets = [];

  // ---------- data source ----------

  function dataUrl() {
    var override = new URLSearchParams(window.location.search).get('data');
    if (override) return override;

    var config = window.PULSE_CONFIG || {};
    if (config.repo) {
      return (
        'https://raw.githubusercontent.com/' +
        config.repo +
        '/' +
        (config.branch || 'status') +
        '/' +
        (config.path || 'status/history.json')
      );
    }
    // Local development: a history.json sitting next to this page.
    return './history.json';
  }

  function load() {
    var url = dataUrl();
    els.sourceUrl.textContent = url;

    // Cache-busting: raw.githubusercontent.com caches for a few minutes, which
    // would otherwise show a stale run right after a heartbeat.
    var busted = url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();

    fetch(busted, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        }
        return response.text();
      })
      .then(function (text) {
        var history;
        try {
          history = JSON.parse(text);
        } catch (error) {
          throw new Error('The status file is not valid JSON: ' + error.message);
        }
        if (!history || typeof history !== 'object' || !history.targets) {
          throw new Error('The status file loaded but has no "targets" object.');
        }
        render(history, url);
      })
      .catch(function (error) {
        showNotice(
          'Could not load the status data',
          'Pulse fetched the history file but did not get usable data back. The most likely causes: ' +
            'the daily heartbeat has not run yet, so the status branch does not exist; the repository ' +
            'is private, so the raw URL is not publicly readable; or dashboard/config.js still points ' +
            'at a placeholder repository.',
          url + '\n\n' + error.message
        );
      });
  }

  // ---------- rendering ----------

  function render(history, url) {
    targets = Object.keys(history.targets)
      .map(function (id) {
        var target = history.targets[id] || {};
        var runs = Array.isArray(target.runs) ? target.runs.slice() : [];
        runs.sort(function (a, b) {
          return String(a.t).localeCompare(String(b.t));
        });
        var last = runs[runs.length - 1];
        return {
          id: id,
          name: target.name || id,
          platform: target.platform || target.type || '',
          publicUrl: target.publicUrl || '',
          notes: target.notes || '',
          runs: runs,
          last: last,
          state: !last ? 'unknown' : last.ok ? 'up' : 'down',
        };
      })
      .sort(function (a, b) {
        // Failing first, then alphabetically: the thing you opened the page for
        // should never be below the fold.
        if (a.state !== b.state) {
          if (a.state === 'down') return -1;
          if (b.state === 'down') return 1;
        }
        return a.name.localeCompare(b.name);
      });

    els.loading.hidden = true;

    if (targets.length === 0) {
      showNotice(
        'No targets recorded yet',
        'The history file loaded correctly but contains no targets. Add an entry to config/targets.json ' +
          'and run the heartbeat-daily workflow once - the first run creates the history.',
        url
      );
      return;
    }

    var failing = targets.filter(function (target) {
      return target.state === 'down';
    }).length;

    els.stats.total.textContent = String(targets.length);
    els.stats.healthy.textContent = String(
      targets.filter(function (target) {
        return target.state === 'up';
      }).length
    );
    els.stats.failing.textContent = String(failing);
    els.stats.failingBox.setAttribute('data-zero', failing === 0 ? 'true' : 'false');
    els.stats.lastRun.textContent = history.lastRun ? formatDateTime(history.lastRun) : 'never';
    if (history.lastRun) {
      els.stats.lastRun.title = new Date(history.lastRun).toString();
    }

    applyFilter();
  }

  function applyFilter() {
    var query = els.search.value.trim().toLowerCase();
    var onlyFailing = els.onlyFailing.checked;

    var visible = targets.filter(function (target) {
      if (onlyFailing && target.state !== 'down') return false;
      if (!query) return true;
      return (
        target.name.toLowerCase().indexOf(query) !== -1 ||
        target.id.toLowerCase().indexOf(query) !== -1 ||
        String(target.platform).toLowerCase().indexOf(query) !== -1
      );
    });

    els.grid.textContent = '';
    visible.forEach(function (target) {
      els.grid.appendChild(buildCard(target));
    });
    els.grid.hidden = false;
    els.notice.hidden = true;

    els.count.textContent =
      visible.length === targets.length
        ? targets.length + (targets.length === 1 ? ' target' : ' targets')
        : 'Showing ' + visible.length + ' of ' + targets.length;

    if (visible.length === 0) {
      els.grid.hidden = true;
      showNotice(
        'Nothing matches',
        onlyFailing && !query
          ? 'Every target is healthy right now.'
          : 'No target matches the current filter. Clear the search box or turn off "show only failing".',
        ''
      );
    }
  }

  function buildCard(target) {
    var node = els.template.content.cloneNode(true);
    var article = node.querySelector('article');
    var titleId = 'target-' + target.id;

    node.querySelector('.card__title').textContent = target.name;
    node.querySelector('.card__title').id = titleId;
    article.setAttribute('aria-labelledby', titleId);
    node.querySelector('.card__platform').textContent = target.platform || target.id;

    var badge = node.querySelector('.badge');
    badge.setAttribute('data-state', target.state);
    badge.querySelector('.badge__text').textContent =
      target.state === 'up' ? 'Healthy' : target.state === 'down' ? 'Down' : 'No data';

    var time = node.querySelector('.card__checked time');
    if (target.last) {
      time.dateTime = target.last.t;
      time.textContent = formatRelative(target.last.t);
      time.title = new Date(target.last.t).toString();
    } else {
      time.textContent = '—';
    }

    node.querySelector('.card__response').textContent = target.last ? target.last.ms + ' ms' : '—';

    var days = buildDays(target.runs);
    node.querySelector('.card__uptime').textContent = formatUptime(days);
    buildStrip(node.querySelector('.card__strip'), days, target.name);
    buildSparkline(node.querySelector('.card__spark'), target.runs);

    if (target.state === 'down' && target.last && target.last.e) {
      var error = node.querySelector('.card__error');
      error.textContent = target.last.e;
      error.hidden = false;
    }

    if (target.notes) {
      var notes = node.querySelector('.card__notes');
      notes.textContent = target.notes;
      notes.hidden = false;
    }

    var link = node.querySelector('.card__link');
    if (target.publicUrl) {
      link.href = target.publicUrl;
      link.textContent = displayHost(target.publicUrl);
    } else {
      node.querySelector('.card__links').remove();
    }

    return node;
  }

  // ---------- 90-day strip ----------

  function buildDays(runs) {
    var byDay = {};
    runs.forEach(function (run) {
      var day = String(run.t).slice(0, 10);
      if (!byDay[day]) byDay[day] = { total: 0, ok: 0 };
      byDay[day].total += 1;
      if (run.ok) byDay[day].ok += 1;
    });

    var days = [];
    var cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    for (var i = DAYS - 1; i >= 0; i--) {
      var date = new Date(cursor.getTime() - i * 86400000);
      var key = date.toISOString().slice(0, 10);
      var entry = byDay[key];
      days.push({
        key: key,
        state: !entry
          ? 'none'
          : entry.ok === entry.total
            ? 'up'
            : entry.ok === 0
              ? 'down'
              : 'partial',
        total: entry ? entry.total : 0,
        ok: entry ? entry.ok : 0,
      });
    }
    return days;
  }

  function buildStrip(container, days, name) {
    var withData = days.filter(function (day) {
      return day.total > 0;
    });
    container.setAttribute(
      'aria-label',
      withData.length === 0
        ? 'No uptime history recorded for ' + name + ' yet.'
        : name +
            ': ' +
            formatUptime(days) +
            ' uptime across ' +
            withData.length +
            ' day(s) with data in the last ' +
            DAYS +
            ' days.'
    );

    days.forEach(function (day) {
      var cell = document.createElement('div');
      cell.className = 'day';
      cell.setAttribute('data-state', day.state);
      cell.title =
        day.total === 0
          ? day.key + ': no data'
          : day.key + ': ' + day.ok + '/' + day.total + ' checks healthy';
      container.appendChild(cell);
    });
  }

  function formatUptime(days) {
    var total = 0;
    var ok = 0;
    days.forEach(function (day) {
      total += day.total;
      ok += day.ok;
    });
    if (total === 0) return '—';
    var pct = (ok / total) * 100;
    // Two decimals only when it matters; "99.9%" reads better than "99.90%".
    return (pct === 100 ? '100' : pct.toFixed(pct >= 99.9 ? 2 : 1)) + '%';
  }

  // ---------- sparkline ----------

  function buildSparkline(container, runs) {
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');

    var points = runs.slice(-SPARK_POINTS);
    if (points.length < 2) {
      svg.setAttribute('aria-label', 'Not enough runs yet to draw a response-time chart.');
      svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
      var text = document.createElementNS(svgNS, 'text');
      text.setAttribute('class', 'spark__empty');
      text.setAttribute('x', '0');
      text.setAttribute('y', '18');
      text.textContent = 'Response times appear after two runs';
      svg.appendChild(text);
      container.appendChild(svg);
      return;
    }

    var values = points.map(function (run) {
      return typeof run.ms === 'number' ? run.ms : 0;
    });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || 1;

    var coords = values.map(function (value, index) {
      var x = (index / (values.length - 1)) * 100;
      var y = 28 - ((value - min) / span) * 26;
      return x.toFixed(2) + ',' + y.toFixed(2);
    });

    var area = document.createElementNS(svgNS, 'polygon');
    area.setAttribute('class', 'spark__area');
    area.setAttribute('points', '0,30 ' + coords.join(' ') + ' 100,30');
    svg.appendChild(area);

    var line = document.createElementNS(svgNS, 'polyline');
    line.setAttribute('class', 'spark__line');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('points', coords.join(' '));
    svg.appendChild(line);

    svg.setAttribute(
      'aria-label',
      'Response time over the last ' +
        values.length +
        ' checks: between ' +
        min +
        ' and ' +
        max +
        ' milliseconds, most recently ' +
        values[values.length - 1] +
        ' milliseconds.'
    );

    container.appendChild(svg);
  }

  // ---------- formatting ----------

  function formatDateTime(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return 'unknown';
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatRelative(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return 'unknown';
    var seconds = Math.round((Date.now() - date.getTime()) / 1000);
    var units = [
      ['minute', 60],
      ['hour', 3600],
      ['day', 86400],
    ];
    if (seconds < 60) return 'just now';
    var unit = 'minute';
    var size = 60;
    for (var i = 0; i < units.length; i++) {
      if (seconds >= units[i][1]) {
        unit = units[i][0];
        size = units[i][1];
      }
    }
    var amount = Math.round(seconds / size);
    if (unit === 'day' && amount > 30) return formatDateTime(iso);
    if (typeof Intl !== 'undefined' && Intl.RelativeTimeFormat) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-amount, unit);
    }
    return amount + ' ' + unit + (amount === 1 ? '' : 's') + ' ago';
  }

  function displayHost(url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function showNotice(title, body, detail) {
    els.loading.hidden = true;
    els.notice.hidden = false;
    els.noticeTitle.textContent = title;
    els.noticeBody.textContent = body;
    els.noticeDetail.hidden = !detail;
    els.noticeDetail.textContent = detail || '';
  }

  // ---------- theme ----------

  function initTheme() {
    var stored = null;
    try {
      stored = window.localStorage.getItem('pulse-theme');
    } catch {
      // Private browsing or blocked storage: fall back to the system theme.
    }
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
    syncToggle();

    els.themeToggle.addEventListener('click', function () {
      var current =
        document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        window.localStorage.setItem('pulse-theme', next);
      } catch {
        // Not being able to remember the choice is not worth failing over.
      }
      syncToggle();
    });
  }

  function syncToggle() {
    var isDark =
      (document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
    els.themeToggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    els.themeToggle.querySelector('.theme-toggle__label').textContent = isDark ? 'Dark' : 'Light';
  }

  // ---------- boot ----------

  initTheme();
  els.search.addEventListener('input', applyFilter);
  els.onlyFailing.addEventListener('change', applyFilter);
  load();

  var refreshMs = (window.PULSE_CONFIG || {}).refreshMs;
  if (refreshMs && refreshMs >= 30000) {
    window.setInterval(load, refreshMs);
  }
})();
