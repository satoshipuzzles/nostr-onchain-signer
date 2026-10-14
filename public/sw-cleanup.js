// Unregister any stale service workers to prevent cache issues.
// A file rather than an inline script so the Content-Security-Policy can
// forbid inline scripts entirely.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (registrations) {
    for (var r of registrations) { r.unregister(); }
  });
}
