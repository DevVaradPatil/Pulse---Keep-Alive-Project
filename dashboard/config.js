// Local-development defaults.
//
// The deploy workflow overwrites this file with the real repository slug, so
// the published dashboard reads history.json from the status branch. Left as
// it is, the page falls back to ./history.json next to index.html, which is
// what you want when opening the dashboard from the filesystem.
//
// To preview against your live data without deploying, open the page with
// ?data=https://raw.githubusercontent.com/<owner>/<repo>/status/status/history.json
window.PULSE_CONFIG = {
  repo: null,
  branch: 'status',
  path: 'status/history.json',
  refreshMs: 300000,
};
