const PAGE_SIZE = 25;

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function createAdminSection({ apiPath, formId, bodyId, prevId, nextId, statusId, columns }) {
  let page = 1;

  function currentFilters() {
    const form = document.getElementById(formId);
    const params = new URLSearchParams(new FormData(form));
    for (const [key, value] of [...params.entries()]) {
      if (!value) params.delete(key);
    }
    return params;
  }

  async function load() {
    const params = currentFilters();
    params.set('page', String(page));
    params.set('pageSize', String(PAGE_SIZE));

    const body = document.getElementById(bodyId);
    body.innerHTML = `<tr><td colspan="${columns.length}" class="empty"><span class="spinner"></span> Loading…</td></tr>`;

    try {
      const result = await apiJson(`${apiPath}?${params.toString()}`);
      render(result);
    } catch (err) {
      body.innerHTML = `<tr><td colspan="${columns.length}" class="empty">Failed to load.</td></tr>`;
      showToast(err.message);
    }
  }

  function render(result) {
    const body = document.getElementById(bodyId);
    if (result.rows.length === 0) {
      body.innerHTML = `<tr><td colspan="${columns.length}" class="empty">No results.</td></tr>`;
    } else {
      body.innerHTML = result.rows
        .map(
          (row) =>
            `<tr>${columns.map((col) => `<td>${escapeHtml(formatCell(col.render ? col.render(row) : row[col.key]))}</td>`).join('')}</tr>`
        )
        .join('');
    }

    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    document.getElementById(statusId).textContent = `Page ${result.page} of ${totalPages} (${result.total} total)`;
    document.getElementById(prevId).disabled = result.page <= 1;
    document.getElementById(nextId).disabled = result.page >= totalPages;
  }

  document.getElementById(formId).addEventListener('submit', (e) => {
    e.preventDefault();
    page = 1;
    load();
  });
  document.getElementById(prevId).addEventListener('click', () => {
    page = Math.max(1, page - 1);
    load();
  });
  document.getElementById(nextId).addEventListener('click', () => {
    page += 1;
    load();
  });

  load();
}

createAdminSection({
  apiPath: '/api/admin/auth-events',
  formId: 'auth-events-filter',
  bodyId: 'auth-events-body',
  prevId: 'auth-events-prev',
  nextId: 'auth-events-next',
  statusId: 'auth-events-status',
  columns: [
    { render: (r) => new Date(r.created_at).toLocaleString() },
    { key: 'event_type' },
    { key: 'email' },
    { key: 'user_id' },
    { key: 'ip_address' },
    { key: 'user_agent' },
  ],
});

createAdminSection({
  apiPath: '/api/admin/page-visits',
  formId: 'page-visits-filter',
  bodyId: 'page-visits-body',
  prevId: 'page-visits-prev',
  nextId: 'page-visits-next',
  statusId: 'page-visits-status',
  columns: [
    { render: (r) => new Date(r.created_at).toLocaleString() },
    { key: 'path' },
    { key: 'email' },
    { key: 'user_id' },
    { key: 'ip_address' },
    { key: 'user_agent' },
  ],
});

createAdminSection({
  apiPath: '/api/admin/product-events',
  formId: 'product-events-filter',
  bodyId: 'product-events-body',
  prevId: 'product-events-prev',
  nextId: 'product-events-next',
  statusId: 'product-events-status',
  columns: [
    { render: (r) => new Date(r.created_at).toLocaleString() },
    { key: 'event_name' },
    { key: 'email' },
    { key: 'user_id' },
    { key: 'metadata' },
  ],
});
