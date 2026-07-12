function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('not authenticated');
  }
  return res;
}

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadAccounts() {
  const res = await api('/api/social-accounts');
  const accounts = await res.json();

  document.getElementById('accounts-list').innerHTML =
    accounts.map((a) => `<li>${escapeHtml(a.platform)}: ${escapeHtml(a.display_name)}</li>`).join('') ||
    '<li class="empty">No accounts yet</li>';

  document.getElementById('account-select').innerHTML = accounts
    .map((a) => `<option value="${a.id}">${escapeHtml(a.platform)}: ${escapeHtml(a.display_name)}</option>`)
    .join('');
}

async function loadPosts() {
  const res = await api('/api/posts');
  const posts = await res.json();
  const list = document.getElementById('posts-list');

  list.innerHTML =
    posts
      .map(
        (p) => `
    <li>
      <span class="status status-${p.status}">${p.status}</span>
      ${
        p.media_url
          ? p.media_type === 'video'
            ? `<video class="thumb" src="${escapeHtml(p.media_url)}" muted></video>`
            : `<img class="thumb" src="${escapeHtml(p.media_url)}" alt="">`
          : ''
      }
      <span class="content">${escapeHtml(p.content)}</span>
      <span class="when">${p.scheduled_for ? new Date(p.scheduled_for).toLocaleString() : 'no schedule'}</span>
      <button data-id="${p.id}" class="delete-btn">Delete</button>
    </li>
  `
      )
      .join('') || '<li class="empty">No posts yet</li>';

  list.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/posts/${btn.dataset.id}`, { method: 'DELETE' });
      loadPosts();
      calendar.refetchEvents();
    });
  });
}

function openPostDialog(prefillDate) {
  const form = document.getElementById('post-dialog-form');
  form.reset();
  if (prefillDate) {
    form.scheduled_for.value = toLocalInputValue(prefillDate);
  }
  document.getElementById('post-dialog').showModal();
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

document.getElementById('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/api/social-accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: form.platform.value, display_name: form.display_name.value }),
  });
  form.reset();
  loadAccounts();
});

document.getElementById('new-post-btn').addEventListener('click', () => openPostDialog(null));

document.getElementById('post-dialog-cancel').addEventListener('click', () => {
  document.getElementById('post-dialog').close();
});

document.getElementById('post-dialog').addEventListener('click', (e) => {
  if (e.target.id === 'post-dialog') e.target.close();
});

document.getElementById('post-dialog-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const scheduledLocal = form.scheduled_for.value;

  const body = new FormData();
  body.set('social_account_id', form.social_account_id.value);
  body.set('content', form.content.value);
  if (scheduledLocal) {
    body.set('scheduled_for', new Date(scheduledLocal).toISOString());
  }
  if (form.media.files[0]) {
    body.set('media', form.media.files[0]);
  }

  const res = await api('/api/posts', { method: 'POST', body });
  if (res.ok) {
    document.getElementById('post-dialog').close();
    loadPosts();
    calendar.refetchEvents();
  }
});

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

  dateClick: (info) => {
    const date = info.date;
    if (info.allDay) {
      date.setHours(9, 0, 0, 0);
    }
    openPostDialog(date);
  },

  events: async (info, successCallback, failureCallback) => {
    try {
      const res = await api('/api/posts');
      const posts = await res.json();
      const events = posts
        .filter((p) => p.scheduled_for)
        .map((p) => ({
          id: String(p.id),
          title: p.content.length > 40 ? `${p.content.slice(0, 40)}…` : p.content,
          start: p.scheduled_for,
          classNames: [`cal-status-${p.status}`],
          extendedProps: { status: p.status, content: p.content },
        }));
      successCallback(events);
    } catch (err) {
      failureCallback(err);
    }
  },

  eventDrop: async (info) => {
    const res = await fetch(`/api/posts/${info.event.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduled_for: info.event.start.toISOString() }),
    });
    if (!res.ok) {
      info.revert();
    } else {
      loadPosts();
    }
  },

  eventClick: async (info) => {
    const { status, content } = info.event.extendedProps;
    const when = info.event.start.toLocaleString();
    if (!confirm(`[${status}] ${content}\n${when}\n\nDelete this post?`)) return;
    const res = await fetch(`/api/posts/${info.event.id}`, { method: 'DELETE' });
    if (res.ok) {
      info.event.remove();
      loadPosts();
    }
  },
});

calendar.render();
loadAccounts();
loadPosts();
