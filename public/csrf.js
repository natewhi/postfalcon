let csrfTokenPromise = null;

function getCsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetch('/api/csrf-token', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data) => data.csrfToken);
  }
  return csrfTokenPromise;
}
