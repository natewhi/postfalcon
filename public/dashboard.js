function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const PLATFORM_DISPLAY_OVERRIDES = { tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn' };
function platformDisplayName(platform) {
  if (!platform) return 'Unknown';
  return PLATFORM_DISPLAY_OVERRIDES[platform] || platform.charAt(0).toUpperCase() + platform.slice(1);
}

// Header stat strip (scheduled/drafts/failed counts) — a nice-to-have glance at account
// health, independent of loadDrafts()/loadFailedBanner() below (which fetch the same statuses
// but for rendering their own lists, not just counting), so it fails quietly on its own.
async function loadDashboardStats() {
  try {
    const posts = await apiJson(`/api/v1/posts${buildPostsQuery({ status: 'draft,scheduled,failed' })}`);
    const counts = { draft: 0, scheduled: 0, failed: 0 };
    posts.forEach((p) => {
      if (counts[p.status] !== undefined) counts[p.status]++;
    });
    document.getElementById('stat-scheduled').textContent = counts.scheduled;
    document.getElementById('stat-drafts').textContent = counts.draft;
    document.getElementById('stat-failed').textContent = counts.failed;
  } catch {
    // stats are a nice-to-have — the rest of the dashboard works fine without them
  }
}

let activeAccountId = new URLSearchParams(window.location.search).get('account');

const CALENDAR_STATUS_STORAGE_KEY = 'postfox-calendar-statuses';
const ALL_CALENDAR_STATUSES = ['scheduled', 'failed', 'posted', 'canceled'];
const CALENDAR_VIEW_STORAGE_KEY = 'postfox-calendar-view';
const ALL_CALENDAR_VIEWS = ['dayGridMonth', 'timeGridWeek'];

function loadSavedCalendarView() {
  try {
    const saved = localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY);
    if (ALL_CALENDAR_VIEWS.includes(saved)) return saved;
  } catch {
    // ignore malformed storage value, fall back to default
  }
  return 'dayGridMonth';
}

function loadSavedCalendarStatuses() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALENDAR_STATUS_STORAGE_KEY));
    if (Array.isArray(saved)) {
      return saved.filter((s) => ALL_CALENDAR_STATUSES.includes(s));
    }
  } catch {
    // ignore malformed storage value, fall back to default
  }
  return ['scheduled', 'failed'];
}

const activeCalendarStatuses = new Set(loadSavedCalendarStatuses());

function setChipActive(chip, active) {
  chip.classList.toggle('active', active);
  chip.setAttribute('aria-pressed', String(active));
}

document.querySelectorAll('.status-filter-chip').forEach((chip) => {
  setChipActive(chip, activeCalendarStatuses.has(chip.dataset.status));
});

function buildPostsQuery(extra = {}) {
  const params = new URLSearchParams();
  if (activeAccountId) params.set('social_account_id', activeAccountId);
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

window.filterByAccount = (accountId) => {
  activeAccountId = accountId;
  const url = new URL(window.location.href);
  if (accountId) {
    url.searchParams.set('account', accountId);
  } else {
    url.searchParams.delete('account');
  }
  history.replaceState(null, '', url);
  loadDrafts();
  loadFailedBanner();
  loadDashboardStats();
  calendar.refetchEvents();
};

document.querySelectorAll('.status-filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const status = chip.dataset.status;
    if (activeCalendarStatuses.has(status)) {
      activeCalendarStatuses.delete(status);
      setChipActive(chip, false);
    } else {
      activeCalendarStatuses.add(status);
      setChipActive(chip, true);
    }
    localStorage.setItem(CALENDAR_STATUS_STORAGE_KEY, JSON.stringify(Array.from(activeCalendarStatuses)));
    calendar.refetchEvents();
  });
});

async function loadFailedBanner() {
  const banner = document.getElementById('failed-posts-banner');
  try {
    const failed = await apiJson(`/api/v1/posts${buildPostsQuery({ status: 'failed' })}`);
    if (failed.length > 0) {
      document.getElementById('failed-posts-message').textContent =
        failed.length === 1
          ? '⚠ 1 post failed to send. Check the calendar (Failed filter) for details.'
          : `⚠ ${failed.length} posts failed to send. Check the calendar (Failed filter) for details.`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  } catch {
    banner.hidden = true;
  }
}

let hasAccounts = false;
let accountsCache = [];

const PLATFORM_CHAR_LIMITS = {
  twitter: 280,
  mastodon: 500,
  threads: 500,
  bluesky: 300,
  facebook: 63206,
  instagram: 2200,
  linkedin: 3000,
  tiktok: 2200,
  pinterest: 500,
};

async function loadAccountOptions() {
  try {
    accountsCache = await apiJson('/api/v1/social-accounts');
    hasAccounts = accountsCache.length > 0;
    renderAccountPicker();
  } catch (err) {
    showToast(err.message);
  }
}

function renderAccountPicker() {
  const picker = document.getElementById('account-picker');
  picker.innerHTML = accountsCache
    .map(
      (a) => `
    <button type="button" class="account-chip" data-account-id="${a.id}">
      ${accountAvatarHtml(a)}
      <span>${escapeHtml(a.display_name)}</span>
    </button>
  `
    )
    .join('');

  picker.querySelectorAll('.account-chip').forEach((chip) => {
    chip.addEventListener('click', () => toggleAccount(chip.dataset.accountId));
  });
}

function selectedAccountIds() {
  return [...document.querySelectorAll('#account-picker .account-chip.selected')].map((c) => c.dataset.accountId);
}

function syncAccountSelection() {
  const ids = selectedAccountIds();
  document.getElementById('account-select').value = ids[0] || '';
  updateCharCount();
}

// New-post picker is multi-select (cross-posting); the edit dialog locks it to one channel.
function toggleAccount(id) {
  const picker = document.getElementById('account-picker');
  if (picker.classList.contains('locked')) return;
  picker.querySelector(`.account-chip[data-account-id="${id}"]`)?.classList.toggle('selected');
  syncAccountSelection();
}

function selectAccount(id) {
  document.querySelectorAll('#account-picker .account-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.accountId === String(id));
  });
  syncAccountSelection();
}

function updateCharCount() {
  const content = document.getElementById('post-content').value;
  const length = content.length;
  const accountId = document.getElementById('account-select').value;
  const account = accountsCache.find((a) => String(a.id) === String(accountId));
  const limit = account ? PLATFORM_CHAR_LIMITS[account.platform] : null;
  const counter = document.getElementById('char-count');

  if (limit) {
    const remaining = limit - length;
    counter.textContent = `${remaining} characters left`;
    counter.classList.toggle('char-count-warning', remaining < limit * 0.1 && remaining >= 0);
    counter.classList.toggle('char-count-over', remaining < 0);
  } else {
    counter.textContent = `${length} characters`;
    counter.classList.remove('char-count-warning', 'char-count-over');
  }
}

document.getElementById('post-content').addEventListener('input', updateCharCount);

const MAX_MEDIA_PER_POST = 10;
const mediaInput = document.getElementById('media-input');
const mediaPreviewGrid = document.getElementById('media-preview-grid');
const mediaUploadLabel = document.getElementById('media-upload-label');

let selectedMedia = [];

function renderMediaPreview() {
  mediaPreviewGrid.innerHTML = selectedMedia
    .map(
      (item, i) => `
    <div class="media-preview-item">
      <div class="media-preview-thumb">
        ${
          item.file.type.startsWith('video/')
            ? `<video src="${item.previewUrl}" muted></video>`
            : `<img src="${item.previewUrl}" alt="">`
        }
        <button type="button" class="media-remove" data-index="${i}" aria-label="Remove">&times;</button>
      </div>
      <input type="text" class="media-alt-input" data-index="${i}" placeholder="Alt text (optional)" value="${escapeHtml(item.altText)}">
    </div>
  `
    )
    .join('');

  mediaPreviewGrid.querySelectorAll('.media-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.index);
      URL.revokeObjectURL(selectedMedia[i].previewUrl);
      selectedMedia.splice(i, 1);
      renderMediaPreview();
    });
  });

  mediaPreviewGrid.querySelectorAll('.media-alt-input').forEach((input) => {
    input.addEventListener('input', () => {
      selectedMedia[Number(input.dataset.index)].altText = input.value;
    });
  });

  mediaUploadLabel.style.display = selectedMedia.length >= MAX_MEDIA_PER_POST ? 'none' : '';
}

function resetMediaPreview() {
  selectedMedia.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  selectedMedia = [];
  renderMediaPreview();
}

mediaInput.addEventListener('change', () => {
  const remaining = MAX_MEDIA_PER_POST - selectedMedia.length;
  const files = Array.from(mediaInput.files).slice(0, remaining);
  if (mediaInput.files.length > remaining) {
    showToast(`You can attach up to ${MAX_MEDIA_PER_POST} files per post.`, 'warning');
  }
  for (const file of files) {
    selectedMedia.push({ file, altText: '', previewUrl: URL.createObjectURL(file) });
  }
  mediaInput.value = '';
  renderMediaPreview();
});

const scheduledForInput = document.getElementById('scheduled-for-input');
const repeatSelect = document.getElementById('repeat-select');
const repeatUntilInput = document.getElementById('repeat-until-input');
const repeatUntilField = document.getElementById('repeat-until-field');
const repeatFields = document.getElementById('repeat-fields');

function refreshScheduleMin() {
  scheduledForInput.min = toLocalInputValue(new Date());
  repeatUntilInput.min = toLocalInputValue(new Date());
}

function setScheduleMode(isSchedule) {
  scheduledForInput.disabled = !isSchedule;
  scheduledForInput.required = isSchedule;
  repeatFields.hidden = !isSchedule;
  if (isSchedule) {
    refreshScheduleMin();
  } else {
    scheduledForInput.value = '';
    repeatSelect.value = '';
    repeatUntilInput.value = '';
    repeatUntilField.hidden = true;
  }
}

document.querySelectorAll('.schedule-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.schedule-option').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    setScheduleMode(btn.dataset.mode === 'schedule');
  });
});

repeatSelect.addEventListener('change', () => {
  repeatUntilField.hidden = repeatSelect.value === '';
  if (repeatSelect.value === '') repeatUntilInput.value = '';
});

let draftsCache = [];

function renderDraftsList(posts, { noMatchMessage } = {}) {
  const list = document.getElementById('drafts-list');
  list.innerHTML =
    posts
      .map(
        (p) => `
    <li class="draft-card" data-id="${p.id}" data-content="${escapeHtml(p.content)}">
      <div class="draft-card-top">
        <span class="cal-platform-badge" style="background:${(PLATFORM_META[p.platform] || { color: '#666666' }).color}" title="${escapeHtml(p.platform || '')}">${platformBadgeInner(p.platform)}</span>
        <span class="status status-${p.status}">${p.status}</span>
        ${
          p.media && p.media.length > 0
            ? `<span class="thumb-group">${p.media
                .slice(0, 3)
                .map((m) =>
                  m.media_type === 'video'
                    ? `<video class="thumb" src="${escapeHtml(m.url)}" muted></video>`
                    : `<img class="thumb" src="${escapeHtml(m.url)}" alt="${escapeHtml(m.alt_text || '')}">`
                )
                .join('')}${p.media.length > 3 ? `<span class="thumb-more">+${p.media.length - 3}</span>` : ''}</span>`
            : ''
        }
      </div>
      <p class="draft-card-content">${escapeHtml(p.content)}</p>
      <div class="draft-card-footer">
        <span class="draft-card-when">Created ${new Date(p.created_at).toLocaleDateString()}</span>
        <div class="draft-card-actions">
          <button data-id="${p.id}" class="edit-btn">Edit</button>
          <button data-id="${p.id}" class="delete-btn">Delete</button>
        </div>
      </div>
    </li>
  `
      )
      .join('') ||
    `<li class="empty">${noMatchMessage || 'No drafts &mdash; click + New post above to start one.'}</li>`;

  list.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const post = draftsCache.find((p) => String(p.id) === btn.dataset.id);
      if (post) openEditDialog(post);
    });
  });

  list.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener(
      'click',
      withLoading(btn, 'Deleting…', async () => {
        const ok = await confirmDialog('Delete this draft post?', { confirmText: 'Delete' });
        if (!ok) return;
        try {
          await apiJson(`/api/v1/posts/${btn.dataset.id}`, { method: 'DELETE' });
          loadDrafts();
          loadDashboardStats();
          calendar.refetchEvents();
        } catch (err) {
          showToast(err.message);
        }
      })
    );
  });
}

function populateDraftsPlatformFilter(posts) {
  const select = document.getElementById('drafts-platform-filter');
  const current = select.value;
  const platforms = [...new Set(posts.map((p) => p.platform))].sort();
  select.innerHTML =
    '<option value="">All platforms</option>' +
    platforms.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(platformDisplayName(p))}</option>`).join('');
  select.value = platforms.includes(current) ? current : '';
}

function applyDraftsFilter() {
  const search = document.getElementById('drafts-search').value.trim().toLowerCase();
  const platform = document.getElementById('drafts-platform-filter').value;
  const filtered = draftsCache.filter(
    (p) => (!search || p.content.toLowerCase().includes(search)) && (!platform || p.platform === platform)
  );
  renderDraftsList(filtered, { noMatchMessage: draftsCache.length > 0 ? 'No drafts match your search.' : undefined });
}

document.getElementById('drafts-search').addEventListener('input', applyDraftsFilter);
document.getElementById('drafts-platform-filter').addEventListener('change', applyDraftsFilter);

async function loadDrafts() {
  const list = document.getElementById('drafts-list');
  const count = document.getElementById('drafts-count');
  list.innerHTML = '<li class="loading"><span class="spinner"></span> Loading drafts…</li>';
  try {
    const posts = await apiJson(`/api/v1/posts${buildPostsQuery({ status: 'draft' })}`);
    draftsCache = posts;
    count.hidden = posts.length === 0;
    count.textContent = posts.length;
    populateDraftsPlatformFilter(posts);
    applyDraftsFilter();
  } catch (err) {
    count.hidden = true;
    list.innerHTML = '<li class="empty">Failed to load drafts.</li>';
    showToast(err.message);
  }
}

let editingPostId = null;

function openPostDialog(prefillDate) {
  if (!hasAccounts) {
    showToast('Connect a social account before scheduling a post.', 'warning', '/accounts');
    return;
  }
  editingPostId = null;
  document.getElementById('post-dialog-title').textContent = 'New post';
  document.getElementById('post-dialog-delete').hidden = true;
  document.getElementById('account-picker').classList.remove('locked');
  document.getElementById('crosspost-hint').hidden = false;
  document.getElementById('media-edit-hint').hidden = true;
  mediaUploadLabel.style.display = '';

  const form = document.getElementById('post-dialog-form');
  form.reset();

  const defaultAccountId = activeAccountId || accountsCache[0]?.id;
  if (defaultAccountId) {
    selectAccount(defaultAccountId);
  }

  resetMediaPreview();

  const scheduleMode = prefillDate ? 'schedule' : 'draft';
  document.querySelectorAll('.schedule-option').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === scheduleMode);
  });
  setScheduleMode(scheduleMode === 'schedule');
  scheduledForInput.value = prefillDate ? toLocalInputValue(prefillDate) : '';
  repeatSelect.value = '';
  repeatUntilInput.value = '';
  repeatUntilField.hidden = true;

  updateCharCount();
  document.getElementById('post-dialog').showModal();
}

function openEditDialog(post) {
  editingPostId = post.id;
  document.getElementById('post-dialog-title').textContent = 'Edit post';
  document.getElementById('post-dialog-delete').hidden = false;

  const form = document.getElementById('post-dialog-form');
  form.reset();

  renderAccountPicker();
  selectAccount(post.social_account_id);
  document.getElementById('account-picker').classList.add('locked');
  document.getElementById('crosspost-hint').hidden = true;

  document.getElementById('post-content').value = post.content;

  resetMediaPreview();
  mediaUploadLabel.style.display = 'none';
  if (post.media && post.media.length > 0) {
    mediaPreviewGrid.innerHTML = post.media
      .map(
        (m) => `
      <div class="media-preview-item">
        <div class="media-preview-thumb">
          ${
            m.media_type === 'video'
              ? `<video src="${escapeHtml(m.url)}" muted></video>`
              : `<img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.alt_text || '')}">`
          }
        </div>
      </div>
    `
      )
      .join('');
    document.getElementById('media-edit-hint').hidden = false;
  } else {
    mediaPreviewGrid.innerHTML = '<p class="media-empty">No media attached</p>';
    document.getElementById('media-edit-hint').hidden = true;
  }

  const scheduleMode = post.scheduled_for ? 'schedule' : 'draft';
  document.querySelectorAll('.schedule-option').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === scheduleMode);
  });
  setScheduleMode(scheduleMode === 'schedule');
  scheduledForInput.value = post.scheduled_for ? toLocalInputValue(new Date(post.scheduled_for)) : '';
  repeatSelect.value = post.repeat_interval || '';
  repeatUntilField.hidden = !post.repeat_interval;
  repeatUntilInput.value = post.repeat_until ? toLocalInputValue(new Date(post.repeat_until)) : '';

  updateCharCount();
  document.getElementById('post-dialog').showModal();
}

document.getElementById('new-post-btn').addEventListener('click', () => openPostDialog(null));

document.getElementById('post-dialog-delete').addEventListener(
  'click',
  withLoading(document.getElementById('post-dialog-delete'), 'Deleting…', async () => {
    if (!editingPostId) return;
    const ok = await confirmDialog('Delete this post?', { confirmText: 'Delete' });
    if (!ok) return;
    try {
      await apiJson(`/api/v1/posts/${editingPostId}`, { method: 'DELETE' });
      document.getElementById('post-dialog').close();
      loadDrafts();
      loadFailedBanner();
      loadDashboardStats();
      calendar.refetchEvents();
    } catch (err) {
      showToast(err.message);
    }
  })
);

document.getElementById('post-dialog-cancel').addEventListener('click', () => {
  document.getElementById('post-dialog').close();
});

document.getElementById('post-dialog-close').addEventListener('click', () => {
  document.getElementById('post-dialog').close();
});

document.getElementById('post-dialog').addEventListener('click', (e) => {
  if (e.target.id === 'post-dialog') e.target.close();
});

const postDialogForm = document.getElementById('post-dialog-form');
postDialogForm.addEventListener(
  'submit',
  withLoading(postDialogForm.querySelector('button[type="submit"]'), 'Saving…', async (e) => {
    e.preventDefault();
    const form = e.target;

    const accountIds = selectedAccountIds();
    if (accountIds.length === 0) {
      showToast('Choose at least one channel to post to.');
      return;
    }

    const scheduleMode = document.querySelector('.schedule-option.active')?.dataset.mode;
    const scheduledLocal = scheduleMode === 'schedule' ? scheduledForInput.value : '';
    const repeatInterval = scheduleMode === 'schedule' ? repeatSelect.value : '';
    const repeatUntilLocal = repeatInterval ? repeatUntilInput.value : '';

    if (scheduleMode === 'schedule') {
      if (!scheduledLocal) {
        showToast('Pick a date and time to schedule for.');
        return;
      }
      if (new Date(scheduledLocal).getTime() <= Date.now()) {
        showToast('Scheduled time must be in the future.');
        return;
      }
      if (repeatUntilLocal && new Date(repeatUntilLocal).getTime() <= new Date(scheduledLocal).getTime()) {
        showToast('The repeat end date must be after the first post.');
        return;
      }
    }

    if (editingPostId) {
      const payload = {
        content: form.content.value,
        status: scheduleMode === 'schedule' ? 'scheduled' : 'draft',
        scheduled_for: scheduledLocal ? new Date(scheduledLocal).toISOString() : null,
        repeat_interval: repeatInterval || null,
        repeat_until: repeatUntilLocal ? new Date(repeatUntilLocal).toISOString() : null,
      };
      try {
        await apiJson(`/api/v1/posts/${editingPostId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        document.getElementById('post-dialog').close();
        loadDrafts();
        loadFailedBanner();
        loadDashboardStats();
        calendar.refetchEvents();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    const body = new FormData();
    if (accountIds.length > 1) {
      accountIds.forEach((id) => body.append('social_account_ids', id));
    } else {
      body.set('social_account_id', accountIds[0]);
    }
    body.set('content', form.content.value);
    if (scheduledLocal) {
      body.set('scheduled_for', new Date(scheduledLocal).toISOString());
    }
    if (repeatInterval) {
      body.set('repeat_interval', repeatInterval);
      if (repeatUntilLocal) body.set('repeat_until', new Date(repeatUntilLocal).toISOString());
    }
    if (selectedMedia.length > 0) {
      selectedMedia.forEach((item) => body.append('media', item.file));
      body.set('alt_texts', JSON.stringify(selectedMedia.map((item) => item.altText)));
    }

    try {
      await apiJson('/api/v1/posts', { method: 'POST', body });
      document.getElementById('post-dialog').close();
      resetMediaPreview();
      loadDrafts();
      loadDashboardStats();
      calendar.refetchEvents();
    } catch (err) {
      showToast(err.message);
    }
  })
);

// A failed post's scheduled_for is already in the past by definition, and the scheduler's
// due-posts query (scheduler.js) is just `status = 'scheduled' AND scheduled_for <= now()` — so
// flipping status back to 'scheduled' with no other change makes it due again on the very next
// per-minute run, with no need to touch scheduled_for at all.
async function retryPost(id) {
  try {
    await apiJson(`/api/v1/posts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'scheduled' }),
    });
    showToast('Post queued for retry.', 'success');
    calendar.refetchEvents();
    loadFailedBanner();
    loadDashboardStats();
  } catch (err) {
    showToast(err.message);
  }
}

const calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
  initialView: loadSavedCalendarView(),
  headerToolbar: {
    left: 'prev,next today',
    center: 'title',
    right: 'dayGridMonth,timeGridWeek',
  },
  editable: true,
  eventStartEditable: true,
  eventDurationEditable: false,
  eventAllow: (dropInfo, draggedEvent) => draggedEvent.extendedProps.status === 'scheduled',
  dayCellClassNames: (arg) => (arg.isPast ? ['fc-day-past'] : []),

  // Lets a draft be dragged from the #drafts-list rail straight onto a date — see the
  // Draggable/eventReceive setup below the calendar definition.
  droppable: true,

  datesSet: (info) => {
    try {
      localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, info.view.type);
    } catch {
      // storage unavailable (private browsing, blocked site data) — view just won't persist
    }
  },

  loading: (isLoading) => {
    document.getElementById('calendar-loading').style.display = isLoading ? 'flex' : 'none';
  },

  dateClick: (info) => {
    const now = new Date();

    if (info.allDay) {
      const clickedDateOnly = new Date(info.date.getFullYear(), info.date.getMonth(), info.date.getDate());
      const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (clickedDateOnly < todayOnly) {
        showToast("Can't schedule a post on a day that's already passed.");
        return;
      }
      const date = new Date(info.date);
      date.setHours(9, 0, 0, 0);
      openPostDialog(date);
      return;
    }

    if (info.date.getTime() < now.getTime()) {
      showToast("Can't schedule a post in the past.");
      return;
    }
    openPostDialog(info.date);
  },

  events: async (info, successCallback, failureCallback) => {
    if (activeCalendarStatuses.size === 0) {
      successCallback([]);
      return;
    }
    try {
      const statuses = Array.from(activeCalendarStatuses).join(',');
      const posts = await apiJson(`/api/v1/posts${buildPostsQuery({ status: statuses })}`);
      const events = posts
        .filter((p) => p.scheduled_for)
        .map((p) => ({
          id: String(p.id),
          title: p.content.length > 40 ? `${p.content.slice(0, 40)}…` : p.content,
          start: p.scheduled_for,
          classNames: [`cal-status-${p.status}`],
          extendedProps: { status: p.status, content: p.content, platform: p.platform },
        }));
      successCallback(events);
    } catch (err) {
      showToast(err.message);
      failureCallback(err);
    }
  },

  eventContent: (arg) => {
    const meta = PLATFORM_META[arg.event.extendedProps.platform] || { label: '?', color: '#666666' };
    const isFailed = arg.event.extendedProps.status === 'failed';
    const wrapper = document.createElement('div');
    wrapper.className = 'cal-event-content';
    wrapper.innerHTML = `
      <span class="cal-platform-badge" style="background:${meta.color}" title="${escapeHtml(arg.event.extendedProps.platform || '')}">${platformBadgeInner(arg.event.extendedProps.platform)}</span>
      ${arg.timeText ? `<span class="fc-event-time">${escapeHtml(arg.timeText)}</span>` : ''}
      <span class="cal-event-title">${escapeHtml(arg.event.title)}</span>
      ${isFailed ? '<button type="button" class="cal-retry-btn" title="Retry this post">↻</button>' : ''}
    `;
    if (isFailed) {
      wrapper.querySelector('.cal-retry-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('Retry this failed post? It will be sent again on the next scheduling run.', {
          confirmText: 'Retry',
        });
        if (!ok) return;
        retryPost(arg.event.id);
      });
    }
    return { domNodes: [wrapper] };
  },

  eventDrop: async (info) => {
    try {
      await apiJson(`/api/v1/posts/${info.event.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_for: info.event.start.toISOString() }),
      });
    } catch (err) {
      info.revert();
      showToast(err.message);
    }
  },

  // A draft dropped from #drafts-list lands here — same past-date guards as dateClick, then
  // PATCHes the draft into a scheduled post. The dropped-in placeholder event is always
  // removed afterward: on success, refetchEvents() brings in the real, correctly-styled
  // scheduled event; on failure there's nothing valid to leave behind.
  eventReceive: async (info) => {
    const draftId = info.draggedEl.dataset.id;
    const now = new Date();
    let start = info.event.start;

    if (info.event.allDay) {
      const clickedDateOnly = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (clickedDateOnly < todayOnly) {
        showToast("Can't schedule a post on a day that's already passed.");
        info.event.remove();
        return;
      }
      start = new Date(start);
      start.setHours(9, 0, 0, 0);
    } else if (start.getTime() < now.getTime()) {
      showToast("Can't schedule a post in the past.");
      info.event.remove();
      return;
    }

    try {
      await apiJson(`/api/v1/posts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_for: start.toISOString(), status: 'scheduled' }),
      });
      showToast('Draft scheduled.', 'success');
      loadDrafts();
      loadDashboardStats();
    } catch (err) {
      showToast(err.message);
    } finally {
      info.event.remove();
      calendar.refetchEvents();
    }
  },

  eventClick: async (info) => {
    const { status, content } = info.event.extendedProps;

    if (status === 'scheduled') {
      try {
        const post = await apiJson(`/api/v1/posts/${info.event.id}`);
        openEditDialog(post);
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    const when = info.event.start.toLocaleString();
    const ok = await confirmDialog(`[${status}] ${content}\n${when}\n\nDelete this post?`, { confirmText: 'Delete' });
    if (!ok) return;
    try {
      await apiJson(`/api/v1/posts/${info.event.id}`, { method: 'DELETE' });
      info.event.remove();
      loadFailedBanner();
      loadDashboardStats();
    } catch (err) {
      showToast(err.message);
    }
  },
});

// Makes every .draft-card in the rail draggable onto the calendar (see droppable/eventReceive
// above). itemSelector is delegated, so this one instance also covers cards re-rendered later
// by loadDrafts()/applyDraftsFilter() — no need to reinitialize it after each render.
new FullCalendar.Draggable(document.getElementById('drafts-list'), {
  itemSelector: '.draft-card',
  eventData: (el) => {
    const content = el.dataset.content || '';
    return { title: content.length > 40 ? `${content.slice(0, 40)}…` : content, duration: '00:30' };
  },
});

calendar.render();
loadAccountOptions();
loadDrafts();
loadFailedBanner();
loadDashboardStats();
