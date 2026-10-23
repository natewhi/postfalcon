const PAGE_SIZE = 25;

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function createAdminSection({ apiPath, formId, bodyId, prevId, nextId, statusId, columns }) {
  let page = 1;
  let requestId = 0;

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

    // Guards against out-of-order responses: rapid Prev/Next clicks (or a slow network) can
    // let an older request resolve after a newer one and overwrite the display with stale
    // data. Each call claims the next id; a response is only rendered if it's still current.
    const thisRequestId = ++requestId;

    const body = document.getElementById(bodyId);
    body.innerHTML = `<tr><td colspan="${columns.length}" class="empty"><span class="spinner"></span> Loading…</td></tr>`;

    try {
      const result = await apiJson(`${apiPath}?${params.toString()}`);
      if (thisRequestId !== requestId) return;
      render(result);
    } catch (err) {
      if (thisRequestId !== requestId) return;
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
            `<tr>${columns
              .map(
                (col) =>
                  `<td${col.nowrap ? ' class="nowrap"' : ''}>${escapeHtml(formatCell(col.render ? col.render(row) : row[col.key]))}</td>`
              )
              .join('')}</tr>`
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
  return { reload: load };
}

function formatDay(value) {
  return value ? new Date(value).toLocaleDateString() : '';
}

const billingSection = createAdminSection({
  apiPath: '/api/admin/billing',
  formId: 'billing-filter',
  bodyId: 'billing-body',
  prevId: 'billing-prev',
  nextId: 'billing-next',
  statusId: 'billing-status-text',
  columns: [
    { render: (r) => (r.is_admin ? `${r.email} (admin)` : r.email) },
    { key: 'plan', nowrap: true },
    { key: 'plan_status', nowrap: true },
    { render: (r) => formatDay(r.plan_renews_at), nowrap: true },
    { render: (r) => formatDay(r.plan_cancels_at), nowrap: true },
    { render: (r) => r.stripe_customer_id || '—', nowrap: true },
  ],
});

const reconcileBtn = document.getElementById('billing-reconcile');
reconcileBtn.addEventListener(
  'click',
  withLoading(reconcileBtn, 'Checking…', async () => {
    try {
      const { checked, corrected, failed } = await apiJson('/api/admin/billing/reconcile', { method: 'POST' });
      const summary = `Checked ${checked} subscriber${checked === 1 ? '' : 's'} against Stripe: ${corrected} corrected${failed ? `, ${failed} failed (see logs)` : ''}.`;
      showToast(summary, failed ? 'warning' : 'success');
      billingSection.reload();
    } catch (err) {
      showToast(err.message);
    }
  })
);

createAdminSection({
  apiPath: '/api/admin/auth-events',
  formId: 'auth-events-filter',
  bodyId: 'auth-events-body',
  prevId: 'auth-events-prev',
  nextId: 'auth-events-next',
  statusId: 'auth-events-status',
  columns: [
    { render: (r) => new Date(r.created_at).toLocaleString(), nowrap: true },
    { key: 'event_type', nowrap: true },
    { key: 'email' },
    { key: 'user_id', nowrap: true },
    { key: 'ip_address', nowrap: true },
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
    { render: (r) => new Date(r.created_at).toLocaleString(), nowrap: true },
    { key: 'path', nowrap: true },
    { key: 'email' },
    { key: 'user_id', nowrap: true },
    { key: 'ip_address', nowrap: true },
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
    { render: (r) => new Date(r.created_at).toLocaleString(), nowrap: true },
    { key: 'event_name', nowrap: true },
    { key: 'email' },
    { key: 'user_id', nowrap: true },
    { key: 'metadata' },
  ],
});
