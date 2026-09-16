(async function () {
  const loadingEl = document.getElementById('analytics-loading');
  const contentEl = document.getElementById('analytics-content');
  const emptyEl = document.getElementById('analytics-empty');
  const chartEl = document.getElementById('analytics-chart');
  const topPostEl = document.getElementById('analytics-top-post');

  function fmt(n) {
    return Number(n || 0).toLocaleString();
  }

  function dayLabel(dateStr) {
    // dateStr is a plain YYYY-MM-DD; parse as UTC midnight so the weekday can't shift a day
    // depending on the viewer's timezone offset.
    const d = new Date(`${dateStr}T00:00:00Z`);
    return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  }

  function renderChart(days) {
    const max = Math.max(1, ...days.map((d) => d.views));
    chartEl.innerHTML = days
      .map((d) => {
        const pct = d.views > 0 ? Math.max(4, Math.round((d.views / max) * 100)) : 0;
        return `
          <div class="analytics-bar-col">
            <span class="analytics-bar-value">${d.views > 0 ? fmt(d.views) : ''}</span>
            <div class="analytics-bar-track"><div class="analytics-bar-fill" style="height:${pct}%"></div></div>
            <span class="analytics-bar-label">${dayLabel(d.date)}</span>
          </div>
        `;
      })
      .join('');
  }

  function renderTopPost(post) {
    if (!post) {
      topPostEl.hidden = true;
      return;
    }
    const meta = PLATFORM_META[post.platform] || { label: '?', color: '#666666' };
    const metricText =
      post.metric_views != null
        ? `${fmt(post.metric_views)} views`
        : post.metric_likes != null
          ? `${fmt(post.metric_likes)} likes`
          : 'some engagement';
    const raw = post.content || '';
    const snippet = escapeHtml(raw.slice(0, 120)) + (raw.length > 120 ? '&hellip;' : '');
    topPostEl.innerHTML = `
      <span class="cal-platform-badge" style="background:${meta.color}" title="${escapeHtml(post.platform || '')}">${platformBadgeInner(post.platform)}</span>
      <span>Your top post this week got <strong>${metricText}</strong> &mdash; &ldquo;${snippet}&rdquo;</span>
    `;
    topPostEl.hidden = false;
  }

  try {
    const data = await apiJson('/api/v1/analytics/summary');
    renderChart(data.days);
    document.getElementById('stat-views').textContent = fmt(data.totals.views);
    document.getElementById('stat-likes').textContent = fmt(data.totals.likes);
    document.getElementById('stat-comments').textContent = fmt(data.totals.comments);
    document.getElementById('stat-shares').textContent = fmt(data.totals.shares);
    renderTopPost(data.topPost);

    if (data.postsPosted === 0) {
      emptyEl.textContent = 'Nothing posted yet — once Postfox publishes a post, its numbers will show up here.';
      emptyEl.hidden = false;
    } else if (data.postsWithMetrics === 0) {
      emptyEl.textContent = 'Metrics refresh a few times a day after a post goes out — check back soon.';
      emptyEl.hidden = false;
    }
  } catch (err) {
    showToast(err.message || 'Failed to load analytics', 'error');
  } finally {
    loadingEl.style.display = 'none';
    contentEl.hidden = false;
  }
})();
