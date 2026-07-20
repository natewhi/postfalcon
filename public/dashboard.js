function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

let activeAccountId = new URLSearchParams(window.location.search).get('account');

const CALENDAR_STATUS_STORAGE_KEY = 'postfox-calendar-statuses';
const ALL_CALENDAR_STATUSES = ['scheduled', 'failed', 'posted', 'canceled'];

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
    const failed = await apiJson(`/api/posts${buildPostsQuery({ status: 'failed' })}`);
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
  facebook: 63206,
  instagram: 2200,
  linkedin: 3000,
  tiktok: 2200,
};

async function loadAccountOptions() {
  try {
    accountsCache = await apiJson('/api/social-accounts');
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
    chip.addEventListener('click', () => selectAccount(chip.dataset.accountId));
  });
}

function selectAccount(id) {
  document.getElementById('account-select').value = id;
  document.querySelectorAll('#account-picker .account-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.accountId === String(id));
  });
  updateCharCount();
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

function refreshScheduleMin() {
  scheduledForInput.min = toLocalInputValue(new Date());
}

document.querySelectorAll('.schedule-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.schedule-option').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const isSchedule = btn.dataset.mode === 'schedule';
    scheduledForInput.disabled = !isSchedule;
    scheduledForInput.required = isSchedule;
    if (isSchedule) {
      refreshScheduleMin();
    } else {
      scheduledForInput.value = '';
    }
  });
});

async function loadDrafts() {
  const list = document.getElementById('drafts-list');
  list.innerHTML = '<li class="loading"><span class="spinner"></span> Loading drafts…</li>';
  try {
    const posts = await apiJson(`/api/posts${buildPostsQuery({ status: 'draft' })}`);
    list.innerHTML =
      posts
        .map(
          (p) => `
      <li>
        <span class="cal-platform-badge" style="background:${(PLATFORM_META[p.platform] || { color: '#666666' }).color}" title="${escapeHtml(p.platform || '')}">${(PLATFORM_META[p.platform] || { label: '?' }).label}</span>
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
        <span class="content">${escapeHtml(p.content)}</span>
        <span class="when">Created ${new Date(p.created_at).toLocaleDateString()}</span>
        <button data-id="${p.id}" class="edit-btn">Edit</button>
        <button data-id="${p.id}" class="delete-btn">Delete</button>
      </li>
    `
        )
        .join('') || '<li class="empty">No drafts &mdash; click + New post above to start one.</li>';

    list.querySelectorAll('.edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const post = posts.find((p) => String(p.id) === btn.dataset.id);
        if (post) openEditDialog(post);
      });
    });

    list.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener(
        'click',
        withLoading(btn, 'Deleting…', async () => {
          const ok = await confirmDialog('Delete this post?', { confirmText: 'Delete' });
          if (!ok) return;
          try {
            await apiJson(`/api/posts/${btn.dataset.id}`, { method: 'DELETE' });
            loadDrafts();
            calendar.refetchEvents();
          } catch (err) {
            showToast(err.message);
          }
        })
      );
    });
  } catch (err) {
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
  scheduledForInput.disabled = scheduleMode !== 'schedule';
  scheduledForInput.required = scheduleMode === 'schedule';
  refreshScheduleMin();
  scheduledForInput.value = prefillDate ? toLocalInputValue(prefillDate) : '';

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
  scheduledForInput.disabled = scheduleMode !== 'schedule';
  scheduledForInput.required = scheduleMode === 'schedule';
  refreshScheduleMin();
  scheduledForInput.value = post.scheduled_for ? toLocalInputValue(new Date(post.scheduled_for)) : '';

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
      await apiJson(`/api/posts/${editingPostId}`, { method: 'DELETE' });
      document.getElementById('post-dialog').close();
      loadDrafts();
      loadFailedBanner();
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

    if (!form.social_account_id.value) {
      showToast('Choose which account to post to.');
      return;
    }

    const scheduleMode = document.querySelector('.schedule-option.active')?.dataset.mode;
    const scheduledLocal = scheduleMode === 'schedule' ? scheduledForInput.value : '';

    if (scheduleMode === 'schedule') {
      if (!scheduledLocal) {
        showToast('Pick a date and time to schedule for.');
        return;
      }
      if (new Date(scheduledLocal).getTime() <= Date.now()) {
        showToast('Scheduled time must be in the future.');
        return;
      }
    }

    if (editingPostId) {
      const payload = {
        content: form.content.value,
        status: scheduleMode === 'schedule' ? 'scheduled' : 'draft',
        scheduled_for: scheduledLocal ? new Date(scheduledLocal).toISOString() : null,
      };
      try {
        await apiJson(`/api/posts/${editingPostId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        document.getElementById('post-dialog').close();
        loadDrafts();
        loadFailedBanner();
        calendar.refetchEvents();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    const body = new FormData();
    body.set('social_account_id', form.social_account_id.value);
    body.set('content', form.content.value);
    if (scheduledLocal) {
      body.set('scheduled_for', new Date(scheduledLocal).toISOString());
    }
    if (selectedMedia.length > 0) {
      selectedMedia.forEach((item) => body.append('media', item.file));
      body.set('alt_texts', JSON.stringify(selectedMedia.map((item) => item.altText)));
    }

    try {
      await apiJson('/api/posts', { method: 'POST', body });
      document.getElementById('post-dialog').close();
      resetMediaPreview();
      loadDrafts();
      calendar.refetchEvents();
    } catch (err) {
      showToast(err.message);
    }
  })
);

const calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
  initialView: 'dayGridMonth',
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
      const posts = await apiJson(`/api/posts${buildPostsQuery({ status: statuses })}`);
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
    const wrapper = document.createElement('div');
    wrapper.className = 'cal-event-content';
    wrapper.innerHTML = `
      <span class="cal-platform-badge" style="background:${meta.color}" title="${escapeHtml(arg.event.extendedProps.platform || '')}">${meta.label}</span>
      ${arg.timeText ? `<span class="fc-event-time">${escapeHtml(arg.timeText)}</span>` : ''}
      <span class="cal-event-title">${escapeHtml(arg.event.title)}</span>
    `;
    return { domNodes: [wrapper] };
  },

  eventDrop: async (info) => {
    try {
      await apiJson(`/api/posts/${info.event.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_for: info.event.start.toISOString() }),
      });
    } catch (err) {
      info.revert();
      showToast(err.message);
    }
  },

  eventClick: async (info) => {
    const { status, content } = info.event.extendedProps;

    if (status === 'scheduled') {
      try {
        const post = await apiJson(`/api/posts/${info.event.id}`);
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
      await apiJson(`/api/posts/${info.event.id}`, { method: 'DELETE' });
      info.event.remove();
      loadFailedBanner();
    } catch (err) {
      showToast(err.message);
    }
  },
});

calendar.render();
loadAccountOptions();
loadDrafts();
loadFailedBanner();
