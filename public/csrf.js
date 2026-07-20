let csrfTokenPromise = null;

function getCsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetch('/api/csrf-token', { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error('failed to fetch csrf token');
        return res.json();
      })
      .then((data) => data.csrfToken)
      .catch((err) => {
        // Don't cache a failed fetch — a later call should retry instead of permanently
        // sending the literal string "undefined" as the csrf header on every request after.
        csrfTokenPromise = null;
        throw err;
      });
  }
  return csrfTokenPromise;
}
