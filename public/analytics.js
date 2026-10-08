(function () {
  const loadingEl = document.getElementById('analytics-loading');
  const contentEl = document.getElementById('analytics-content');
  const emptyEl = document.getElementById('analytics-empty');
  const chartEl = document.getElementById('an-chart');
  const RANGE_KEY = 'postfalcon-analytics-range';
  const METRIC_KEY = 'postfalcon-analytics-metric';
  const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const NAME_OVERRIDES = { youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn', twitter: 'X' };
  const METRIC_TITLES = {
    views: 'Views by publish day',
    engagements: 'Engagements by publish day',
    published: 'Posts published per day',
  };

  function readPref(key, allowed, fallback) {
    try {
      const v = localStorage.getItem(key);
      return allowed.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage unavailable (private mode etc.) — the choice just isn't remembered
    }
  }

  let range = readPref(RANGE_KEY, ['7', '30', '90'], '7');
  let metric = readPref(METRIC_KEY, ['views', 'engagements', 'published'], 'views');
  let data = null;

  const fmt = (n) => Number(n || 0).toLocaleString();
  const compact = new Intl.NumberFormat([], { notation: 'compact', maximumFractionDigits: 1 });
  // null = no post in scope reports this metric (e.g. TikTok); shown as a dash, not a zero.
  const metricText = (n) => (n == null ? '&mdash;' : fmt(n));
  const platformName = (p) => NAME_OVERRIDES[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Unknown');
  const engagementsOf = (o) => (o.likes || 0) + (o.comments || 0) + (o.shares || 0);

  function rateText(engaged, views) {
    if (!views) return '&mdash;';
    return `${((engaged / views) * 100).toFixed(1)}%`;
  }

  function badge(platform) {
    const meta = PLATFORM_META[platform] || { color: '#666666' };
    return `<span class="cal-platform-badge" style="background:${meta.color}" title="${escapeHtml(platformName(platform))}">${platformBadgeInner(platform)}</span>`;
  }

  function relativeTime(date) {
    const minutes = Math.round((new Date(date).getTime() - Date.now()) / 60000);
    const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
    if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 48) return rtf.format(hours, 'hour');
    return rtf.format(Math.round(hours / 24), 'day');
  }

  function setSegmented(groupId, attr, value) {
    document.querySelectorAll(`#${groupId} button`).forEach((b) => {
      const active = b.dataset[attr] === value;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  // --- tiles ------------------------------------------------------------------------------
  function renderTiles(period) {
    document.getElementById('an-published').textContent = fmt(period.published);
    const sub = [];
    if (period.failed) sub.push(`${fmt(period.failed)} failed`);
    if (period.scheduled) sub.push(`${fmt(period.scheduled)} scheduled`);
    document.getElementById('an-published-sub').textContent = sub.join(' · ') || 'None failed';
    document.getElementById('an-views').innerHTML = metricText(period.views);
    document.getElementById('an-likes').innerHTML = metricText(period.likes);
    document.getElementById('an-comments').innerHTML = metricText(period.comments);
    document.getElementById('an-shares').innerHTML = metricText(period.shares);
    document.getElementById('an-rate').innerHTML =
      period.engagementRate == null ? '&mdash;' : `${(period.engagementRate * 100).toFixed(1)}%`;
  }

  // --- chart ------------------------------------------------------------------------------
  // One series, so one colour (--color-primary) and no legend: the title names it. Thin
  // bars with rounded tops on a shared baseline, three recessive gridlines, a direct label
  // only on the tallest bar, and a hover tooltip per day with all of that day's numbers.
  function niceCeil(n) {
    if (n <= 0) return 1;
    const exp = 10 ** Math.floor(Math.log10(n));
    const f = n / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  }

  function dayValue(d) {
    if (metric === 'engagements') return engagementsOf(d);
    if (metric === 'published') return d.published;
    return d.views;
  }

  function dayLabel(dateStr, long) {
    // Plain YYYY-MM-DD in the viewer's timezone (the API bucketed it there); parse as a local
    // date so the label can't shift a day.
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (long) return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    return data.days.length <= 7
      ? date.toLocaleDateString([], { weekday: 'short' })
      : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function renderChart() {
    document.getElementById('an-chart-title').textContent = METRIC_TITLES[metric];
    const days = data.days;
    const values = days.map(dayValue);
    const max = Math.max(0, ...values);
    const top = metric === 'published' ? Math.max(2, Math.ceil(max / 2) * 2) : niceCeil(max);
    const maxIndex = max > 0 ? values.indexOf(max) : -1;
    const labelEvery = days.length <= 7 ? 1 : days.length <= 30 ? 5 : 15;

    const grid = [1, 0.5, 0]
      .map(
        (f) => `
        <div class="an-gridline" style="bottom:${f * 100}%">
          <span>${compact.format(top * f)}</span>
        </div>`
      )
      .join('');
    const cols = days
      .map((d, i) => {
        const pct = values[i] > 0 ? Math.max(1.5, (values[i] / top) * 100) : 0;
        return `
        <div class="an-col" data-i="${i}">
          ${i === maxIndex ? `<span class="an-bar-label" style="bottom:${pct}%">${compact.format(values[i])}</span>` : ''}
          <div class="an-bar" style="height:${pct}%"></div>
        </div>`;
      })
      .join('');
    const xLabels = days
      .map(
        (d, i) =>
          `<span class="an-xlabel">${i % labelEvery === 0 || i === days.length - 1 ? escapeHtml(dayLabel(d.date)) : ''}</span>`
      )
      .join('');

    const total = values.reduce((a, b) => a + b, 0);
    chartEl.innerHTML = `
      <div class="an-plot" role="img" aria-label="${escapeHtml(`${METRIC_TITLES[metric]}: ${fmt(total)} in total over ${days.length} days`)}">
        <div class="an-grid">${grid}</div>
        <div class="an-bars">${cols}</div>
        <div class="an-tooltip" hidden></div>
      </div>
      <div class="an-xlabels">${xLabels}</div>
    `;

    const plot = chartEl.querySelector('.an-plot');
    const tip = chartEl.querySelector('.an-tooltip');
    chartEl.querySelectorAll('.an-col').forEach((col) => {
      col.addEventListener('mouseenter', () => {
        const d = days[Number(col.dataset.i)];
        tip.innerHTML = `
          <strong>${escapeHtml(dayLabel(d.date, true))}</strong>
          <span>${fmt(d.published)} post${d.published === 1 ? '' : 's'} published</span>
          <span>${fmt(d.views)} views</span>
          <span>${fmt(engagementsOf(d))} engagements</span>`;
        tip.hidden = false;
        const center = col.offsetLeft + col.offsetWidth / 2;
        const half = tip.offsetWidth / 2;
        tip.style.left = `${Math.min(Math.max(center, half), plot.clientWidth - half)}px`;
        col.classList.add('is-hover');
      });
      col.addEventListener('mouseleave', () => {
        tip.hidden = true;
        col.classList.remove('is-hover');
      });
    });
  }

  // --- tables -----------------------------------------------------------------------------
  function renderPlatforms(platforms) {
    const body = document.getElementById('an-platforms');
    body.innerHTML = platforms.length
      ? platforms
          .map(
            (r) => `
        <tr>
          <td><span class="an-platform">${badge(r.platform)} ${escapeHtml(platformName(r.platform))}</span></td>
          <td>${fmt(r.posts)}</td>
          <td>${metricText(r.views)}</td>
          <td>${metricText(r.likes)}</td>
          <td>${metricText(r.comments)}</td>
          <td>${metricText(r.shares)}</td>
          <td>${rateText(engagementsOf(r), r.views)}</td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="7" class="an-table-empty">No posts published in the last ${range} days.</td></tr>`;
  }

  function renderPosts(posts) {
    const body = document.getElementById('an-posts');
    body.innerHTML = posts.length
      ? posts
          .map((p) => {
            const raw = p.content || '';
            const snippet = escapeHtml(raw.slice(0, 90)) + (raw.length > 90 ? '&hellip;' : '');
            return `
        <tr>
          <td>
            <div class="an-post">
              ${badge(p.platform)}
              <div class="an-post-text">
                <span class="an-post-snippet">${snippet}</span>
                <span class="an-post-account">${escapeHtml(p.account_display_name || '')}</span>
              </div>
            </div>
          </td>
          <td class="an-nowrap">${escapeHtml(new Date(p.posted_at).toLocaleDateString([], { day: 'numeric', month: 'short' }))}</td>
          <td>${metricText(p.metric_views)}</td>
          <td>${metricText(p.metric_likes)}</td>
          <td>${metricText(p.metric_comments)}</td>
          <td>${metricText(p.metric_shares)}</td>
        </tr>`;
          })
          .join('')
      : `<tr><td colspan="6" class="an-table-empty">No posts published in the last ${range} days.</td></tr>`;
  }

  function renderNotes() {
    document.getElementById('an-updated').textContent = data.metricsUpdatedAt
      ? `Last refreshed ${relativeTime(data.metricsUpdatedAt)}.`
      : '';
    if (data.postsPosted === 0) {
      emptyEl.textContent = 'Nothing published yet. Once Postfalcon publishes a post, its numbers show up here.';
      emptyEl.hidden = false;
    } else if (data.postsWithMetrics === 0) {
      emptyEl.textContent = 'Metrics are fetched every few hours after a post goes out, so check back soon.';
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
    }
  }

  async function load() {
    setSegmented('an-range', 'days', range);
    setSegmented('an-metric', 'metric', metric);
    contentEl.classList.add('is-loading');
    try {
      data = await apiJson(`/api/v1/analytics/summary?days=${range}&tz=${encodeURIComponent(TIME_ZONE)}`);
      renderTiles(data.period);
      renderChart();
      renderPlatforms(data.platforms);
      renderPosts(data.posts);
      renderNotes();
    } catch (err) {
      showToast(err.message || 'Failed to load analytics', 'error');
    } finally {
      loadingEl.style.display = 'none';
      contentEl.hidden = false;
      contentEl.classList.remove('is-loading');
    }
  }

  document.querySelectorAll('#an-range button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.days === range) return;
      range = b.dataset.days;
      writePref(RANGE_KEY, range);
      load();
    })
  );
  document.querySelectorAll('#an-metric button').forEach((b) =>
    b.addEventListener('click', () => {
      metric = b.dataset.metric;
      writePref(METRIC_KEY, metric);
      setSegmented('an-metric', 'metric', metric);
      if (data) renderChart();
    })
  );

  load();
})();
