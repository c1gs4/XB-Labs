/* App-wide constants (board columns, theme palettes, command palette) and the empty shape the
   live data fills (app/js/live.js). No sample rows: before the hub answers, pages are empty. */
window.DB = {
  user: { name: 'User', email: '', plan: 'PRO', initials: 'U' },
  workspaces: [],
  stats: [],
  chart7: [],
  devices: [],
  sessions: [],
  columns: [
    { key: 'queued', label: 'Queued', color: 'var(--text-secondary)' },
    { key: 'running', label: 'Running', color: 'var(--success)' },
    { key: 'waiting', label: 'Waiting approval', color: 'var(--warning)' },
    { key: 'done', label: 'Done', color: 'var(--text-tertiary)' },
    { key: 'hibernated', label: 'Hibernated', color: 'var(--accent)' }
  ],
  deploys: [],
  logs: [],
  notes: [],
  usage: { metrics: [], days14: [], series: [], perDevice: [], storage: [], budget: { used: 0, total: 0, tokens: '' } },
  palette: [
    { key: 'midnight', name: 'Midnight', dot: '#8ea2f0', note: 'Control room' },
    { key: 'aubergine', name: 'Nocturne', dot: '#d6b97c', note: 'Ink and brass' },
    { key: 'lime', name: 'Clay', dot: '#d97757', note: 'Warm studio' },
    { key: 'teal', name: 'Fjord', dot: '#86bfd2', note: 'Glacier' },
    { key: 'espresso', name: 'Bordeaux', dot: '#e0a6a6', note: 'Wine cellar' },
    { key: 'orchid', name: 'Orchid', dot: '#c7a4dc', note: 'Night garden' },
    { key: 'paper', name: 'Paper', dot: '#3f5a9a', note: 'Print', light: true },
    { key: 'porcelain', name: 'Porcelain', dot: '#4f6ea8', note: 'Gallery', light: true },
    { key: 'sage', name: 'Sage', dot: '#5a7a5c', note: 'Greenhouse', light: true },
    { key: 'rose', name: 'Rosé', dot: '#a85d78', note: 'Atelier', light: true },
    { key: 'lavender', name: 'Lavender', dot: '#6f60a8', note: 'Dusk', light: true },
    { key: 'sand', name: 'Sand', dot: '#985f38', note: 'Dune', light: true }
  ],
  commands: [
    { g: 'Session', rows: [['New session', '', 'plus'], ['Resume last session', '', 'arrows-clockwise'], ['Enter focus mode', 'Ctrl F', 'corners-out']] },
    { g: 'Jobs', rows: [['Dispatch job', '', 'paper-plane-tilt'], ['Go to Jobs', '', 'kanban']] },
    { g: 'Workspace', rows: [['Pair a device', '', 'qr-code'], ['New shell', '', 'terminal-window']] },
    { g: 'App', rows: [['Open settings', 'Ctrl ,', 'gear-six'], ['Toggle theme', '', 'moon']] }
  ]
};
