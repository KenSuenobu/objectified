/* ==========================================================================
   Apiome "Hive" mockup runtime
   --------------------------------------------------------------------------
   Renders the shared application shell around each mockup page, applies the
   user preferences (theme / font size / density / rail / motion) that the
   Settings pane edits, and provides the small amount of interactivity the
   mockups need (⌘K palette, dialogs/drawers/menus toggled via data-attrs,
   tabs, the implementation-notes panel).

   Page contract (see README.md):
     <body data-shell="app|admin|studio|auth|bare"
           data-nav="<nav item id>"      → which rail item is active
           data-page="<slug>"            → used by the notes panel + index
           data-tenant="Acme Corp">      → optional workspace name
       <main class="page"> …page content… </main>
       <template id="notes"> …implementation notes (HTML)… </template>
     </body>
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- Preferences (persisted; same keys the product should use) -- */
  const PREF_KEYS = { theme: 'hive.theme', font: 'hive.fontScale', density: 'hive.density', rail: 'hive.rail', motion: 'hive.motion', annot: 'hive.annot' };
  const THEMES = [
    { id: 'system', name: 'Follow system', desc: 'Match the OS light/dark preference', swatch: null },
    { id: 'light', name: 'Light', desc: 'Warm paper, navy ink', swatch: ['#F6F5F2', '#FFFFFF', '#16265C', '#1E7FD6'] },
    { id: 'dark', name: 'Dark', desc: 'Low-glare, warm blacks', swatch: ['#141311', '#1B1A18', '#EDEBE6', '#5AA6F2'] },
    { id: 'high-contrast', name: 'High contrast', desc: 'Pure black, white lines, WCAG AAA', swatch: ['#000', '#000', '#FFF', '#6FB8FF'] },
    { id: 'blueprint', name: 'Blueprint', desc: 'Drafting-table blues', swatch: ['#0C1E3A', '#102645', '#E3F2FD', '#6FC1FF'] },
    { id: 'whiteboard', name: 'Whiteboard', desc: 'Neutral, cool light', swatch: ['#FAFAFA', '#FFFFFF', '#111827', '#2563EB'] },
    { id: 'solarized', name: 'Solarized', desc: 'Ethan Schoonover’s palette', swatch: ['#002B36', '#073642', '#EEE8D5', '#2AA198'] },
    { id: 'nord', name: 'Nord', desc: 'Arctic, bluish tones', swatch: ['#2E3440', '#3B4252', '#ECEFF4', '#88C0D0'] },
    { id: 'darcula', name: 'Darcula', desc: 'IDE-familiar darkness', swatch: ['#2B2B2B', '#313335', '#E8E8E8', '#6897BB'] },
  ];
  const FONT_SCALES = [
    { id: 'xs', label: 'Small', px: 14 }, { id: 'sm', label: 'Compact', px: 15 }, { id: 'md', label: 'Default', px: 16 },
    { id: 'lg', label: 'Large', px: 17 }, { id: 'xl', label: 'Larger', px: 18 }, { id: '2xl', label: 'Largest', px: 20 },
  ];
  const root = document.documentElement;
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolveTheme(id) { return id === 'system' ? (mq && mq.matches ? 'dark' : 'light') : id; }
  function applyPrefs() {
    const theme = store.get(PREF_KEYS.theme, 'system');
    root.setAttribute('data-theme', resolveTheme(theme));
    root.setAttribute('data-theme-choice', theme);
    root.setAttribute('data-font-scale', store.get(PREF_KEYS.font, 'md'));
    root.setAttribute('data-density', store.get(PREF_KEYS.density, 'comfortable'));
    root.setAttribute('data-rail', store.get(PREF_KEYS.rail, root.getAttribute('data-rail-default') || 'expanded'));
    root.setAttribute('data-motion', store.get(PREF_KEYS.motion, 'auto'));
    root.setAttribute('data-annot', store.get(PREF_KEYS.annot, 'off'));
  }
  applyPrefs();
  if (mq && mq.addEventListener) mq.addEventListener('change', applyPrefs);

  const Hive = window.Hive = {
    THEMES, FONT_SCALES,
    setTheme(id) { store.set(PREF_KEYS.theme, id); applyPrefs(); document.dispatchEvent(new CustomEvent('hive:prefs')); },
    setFontScale(id) { store.set(PREF_KEYS.font, id); applyPrefs(); document.dispatchEvent(new CustomEvent('hive:prefs')); },
    setDensity(id) { store.set(PREF_KEYS.density, id); applyPrefs(); document.dispatchEvent(new CustomEvent('hive:prefs')); },
    setRail(id) { store.set(PREF_KEYS.rail, id); applyPrefs(); },
    setMotion(id) { store.set(PREF_KEYS.motion, id); applyPrefs(); document.dispatchEvent(new CustomEvent('hive:prefs')); },
    toggleRail() { Hive.setRail(root.getAttribute('data-rail') === 'collapsed' ? 'expanded' : 'collapsed'); },
    toggleAnnot() { store.set(PREF_KEYS.annot, root.getAttribute('data-annot') === 'on' ? 'off' : 'on'); applyPrefs(); },
    cycleTheme() { const cur = store.get(PREF_KEYS.theme, 'system'); Hive.setTheme(resolveTheme(cur) === 'dark' ? 'light' : 'dark'); },
    prefs() { return { theme: store.get(PREF_KEYS.theme, 'system'), font: store.get(PREF_KEYS.font, 'md'), density: store.get(PREF_KEYS.density, 'comfortable'), motion: store.get(PREF_KEYS.motion, 'auto') }; },
    open(id) { const el = document.getElementById(id); if (el) { el.classList.add('is-open'); el.dispatchEvent(new CustomEvent('hive:open')); } },
    close(id) { const el = document.getElementById(id); if (el) el.classList.remove('is-open'); },
    icons() { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); },
  };

  /* ---------- Navigation model (single source of truth for the rail) ----- */
  // `root` is the relative path from the current page folder to docs/mockups/.
  function navModel(rel) {
    const p = (path) => rel + path;
    return {
      app: {
        brandSub: 'Platform',
        groups: [
          { items: [
            { id: 'home', label: 'Home', icon: 'house', href: p('home/overview.html') },
          ]},
          { label: 'Build', items: [
            { id: 'projects', label: 'Projects', icon: 'folder-kanban', href: p('build/projects.html') },
            { id: 'studio', label: 'Studio', icon: 'pen-tool', href: p('studio/editor.html'), ext: true },
            { id: 'primitives', label: 'Primitives & types', icon: 'shapes', href: p('build/primitives.html') },
          ]},
          { label: 'Bring in', items: [
            { id: 'catalog', label: 'Catalog', icon: 'library', href: p('sources/catalog.html') },
            { id: 'repositories', label: 'Repositories', icon: 'git-branch', href: p('sources/repositories.html') },
            { id: 'mcp', label: 'MCP servers', icon: 'network', href: p('sources/mcp-servers.html') },
          ]},
          { label: 'Ship', items: [
            { id: 'published', label: 'Published', icon: 'globe', href: p('ship/published.html') },
            { id: 'sunset', label: 'Sunset timeline', icon: 'sunset', href: p('ship/sunset-timeline.html') },
            { id: 'export', label: 'Export studio', icon: 'package-open', href: p('ship/export-studio.html') },
          ]},
          { label: 'Govern', items: [
            { id: 'style-guides', label: 'Style guides', icon: 'book-open-check', href: p('govern/style-guides.html') },
            { id: 'lint', label: 'Lint posture', icon: 'shield-check', href: p('govern/lint-posture.html'), pill: 'Preview' },
            { id: 'audit', label: 'Access audit', icon: 'scroll-text', href: p('workspace/audit.html') },
          ]},
          { label: 'Workspace', items: [
            { id: 'members', label: 'Members', icon: 'users', href: p('workspace/members.html') },
            { id: 'roles', label: 'Roles', icon: 'shield', href: p('workspace/roles.html') },
            { id: 'api-keys', label: 'API keys', icon: 'key-round', href: p('workspace/api-keys.html') },
            { id: 'tenants', label: 'Tenants', icon: 'building-2', href: p('workspace/tenants.html') },
          ]},
          { label: 'Tools', items: [
            { id: 'database', label: 'Data browser', icon: 'database', href: p('tools/database.html') },
            { id: 'migration', label: 'Migrations', icon: 'route', href: p('tools/migration.html') },
          ]},
        ],
      },
      admin: {
        brandSub: 'Admin console',
        groups: [
          { items: [
            { id: 'admin-overview', label: 'Overview', icon: 'gauge', href: p('admin/overview.html') },
          ]},
          { label: 'Directory', items: [
            { id: 'admin-users', label: 'Users', icon: 'users', href: p('admin/users.html') },
            { id: 'admin-tenants', label: 'Tenants', icon: 'building-2', href: p('admin/tenants.html') },
          ]},
          { label: 'Commercial', items: [
            { id: 'admin-licenses', label: 'Licenses', icon: 'badge-check', href: p('admin/licenses.html') },
            { id: 'admin-flags', label: 'Feature flags', icon: 'flag', href: p('admin/feature-flags.html') },
          ]},
          { label: 'Platform', items: [
            { id: 'admin-templates', label: 'Property templates', icon: 'layout-template', href: p('admin/templates.html') },
            { id: 'admin-settings', label: 'Auth providers', icon: 'key-square', href: p('admin/settings.html') },
          ]},
          { items: [
            { id: 'admin-back', label: 'Back to app', icon: 'arrow-left', href: p('home/overview.html') },
          ]},
        ],
      },
    };
  }

  /* ---------- Shell rendering ------------------------------------------- */
  function relRoot() {
    // Pages live one folder below docs/mockups (e.g. build/projects.html) except index/foundations.
    const explicit = document.body.getAttribute('data-root');
    if (explicit != null) return explicit;
    const parts = location.pathname.split('/');
    parts.pop();
    return parts[parts.length - 1] === 'mockups' ? '' : '../';
  }

  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function renderRail(kind, activeId, rel) {
    const model = navModel(rel)[kind === 'admin' ? 'admin' : 'app'];
    const tenant = document.body.getAttribute('data-tenant') || 'Acme Corp';
    const initials = tenant.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    let collapsed = [];
    try { collapsed = JSON.parse(store.get('hive.navCollapsed', '[]')); } catch (e) { collapsed = []; }
    const groups = model.groups.map((g) => `
      <div class="nav-group${g.label && collapsed.includes(g.label) ? ' is-collapsed' : ''}" data-group="${esc(g.label || '')}">
        ${g.label ? `<div class="nav-group__label" data-action="nav-group" role="button" aria-expanded="${!collapsed.includes(g.label)}">${esc(g.label)}<i data-lucide="chevron-down"></i></div>` : ''}
        <div class="nav-group__items">
        ${g.items.map((it) => `
          <a class="nav-item${it.id === activeId ? ' is-active' : ''}${it.disabled ? ' is-disabled' : ''}" href="${it.href}" data-nav-id="${it.id}" ${it.id !== activeId ? `data-tip-side="right"` : ''}>
            <i data-lucide="${it.icon}"></i><span class="t-truncate">${esc(it.label)}</span>
            ${it.pill ? `<span class="badge badge--honey nav-pill">${esc(it.pill)}</span>` : ''}
            ${it.ext ? `<i data-lucide="arrow-up-right" class="nav-ext"></i>` : ''}
          </a>`).join('')}
        </div>
      </div>`).join('');

    return h(`
      <aside class="rail${kind === 'admin' ? ' rail--admin' : ''}" aria-label="Primary">
        <button class="rail__collapse" data-action="toggle-rail" title="Collapse sidebar (⌘\\)"><i data-lucide="chevrons-left"></i></button>
        <div class="rail__top">
          <a class="rail__brand" href="${rel}home/launcher.html" title="Apiome home">
            <span class="brand-mark"></span>
            <span class="brand-text"><div class="brand-name">apiome</div><div class="brand-sub">${esc(model.brandSub)}</div></span>
          </a>
          ${kind === 'admin' ? '' : `
          <div class="rail__ws">
            <button class="ws-switch" data-action="open" data-target="ws-menu" aria-haspopup="menu">
              <span class="avatar avatar--sm avatar--hex avatar--brand">${esc(initials)}</span>
              <span class="grow min-w-0"><div class="ws-name t-truncate">${esc(tenant)}</div><div class="ws-meta">Owner · Team plan</div></span>
              <i data-lucide="chevrons-up-down"></i>
            </button>
          </div>
          <div class="rail__search">
            <button class="search-trigger" data-action="open" data-target="palette"><i data-lucide="search"></i><span>Search or jump to…</span><span class="kbd">⌘K</span></button>
          </div>`}
        </div>
        <nav class="rail__nav">${groups}</nav>
        <div class="rail__bottom">
          <a class="nav-item" href="${rel}foundations/help.html"><i data-lucide="circle-help"></i><span>Help &amp; docs</span></a>
          <a class="nav-item" href="#" data-action="open" data-target="settings-pane"><i data-lucide="settings-2"></i><span>Preferences</span><span class="kbd" style="margin-left:auto">⌘,</span></a>
          <button class="rail__user" data-action="open" data-target="user-menu" aria-haspopup="menu">
            <span class="avatar avatar--sm avatar--a">AL</span>
            <span class="grow min-w-0"><div class="u-name t-truncate">Ada Lovelace</div><div class="u-mail t-truncate">ada@example.com</div></span>
            <i data-lucide="ellipsis"></i>
          </button>
        </div>
      </aside>`);
  }

  function renderOverlays(rel, kind) {
    const wrap = document.createElement('div');
    wrap.id = 'hive-overlays';
    wrap.innerHTML = `
      <!-- Workspace (tenant) switcher -->
      <div class="overlay" id="ws-menu" data-overlay style="align-items:flex-start;justify-content:flex-start;padding:70px 0 0 76px;background:transparent">
        <div class="menu" style="width:300px" role="menu">
          <div class="menu__label">Workspaces</div>
          <a class="menu__item" href="#"><span class="avatar avatar--xs avatar--hex avatar--brand">AC</span><span class="grow">Acme Corp</span><span class="badge badge--outline">Owner</span><i data-lucide="check" style="margin-left:6px;color:var(--accent)"></i></a>
          <a class="menu__item" href="#"><span class="avatar avatar--xs avatar--hex avatar--c">GL</span><span class="grow">Globex Labs</span><span class="badge badge--outline">Admin</span></a>
          <a class="menu__item" href="#"><span class="avatar avatar--xs avatar--hex avatar--d">IN</span><span class="grow">Initech</span><span class="badge badge--outline">Member</span></a>
          <div class="menu__sep"></div>
          <a class="menu__item" href="${rel}workspace/tenants.html"><i data-lucide="building-2"></i>Manage workspaces</a>
          <a class="menu__item" href="${rel}workspace/tenants.html#create"><i data-lucide="plus"></i>Create workspace</a>
        </div>
      </div>
      <!-- User menu -->
      <div class="overlay" id="user-menu" data-overlay style="align-items:flex-end;justify-content:flex-start;padding:0 0 64px 76px;background:transparent">
        <div class="menu" style="width:260px" role="menu">
          <div style="padding:8px 10px 10px" class="row"><span class="avatar avatar--a">AL</span><span class="grow min-w-0"><div class="t-sm t-600">Ada Lovelace</div><div class="t-xs t-subtle t-truncate">ada@example.com</div></span></div>
          <div class="menu__sep"></div>
          <a class="menu__item" href="${rel}account/profile.html"><i data-lucide="circle-user"></i>Profile</a>
          <a class="menu__item" href="${rel}account/linked-accounts.html"><i data-lucide="link"></i>Linked accounts</a>
          <a class="menu__item" href="#" data-action="open" data-target="settings-pane"><i data-lucide="settings-2"></i>Preferences<span class="kbd">⌘,</span></a>
          <a class="menu__item" href="#" data-action="open" data-target="whats-new"><i data-lucide="sparkles"></i>What’s new<span class="dot dot--honey" style="margin-left:auto"></span></a>
          <a class="menu__item" href="${rel}foundations/help.html"><i data-lucide="keyboard"></i>Keyboard shortcuts<span class="kbd">?</span></a>
          <div class="menu__sep"></div>
          <a class="menu__item" href="${rel}admin/overview.html"><i data-lucide="shield-half"></i>Admin console<i data-lucide="arrow-up-right" style="margin-left:auto"></i></a>
          <a class="menu__item" href="${rel}home/launcher.html"><i data-lucide="layout-grid"></i>All apps</a>
          <div class="menu__sep"></div>
          <a class="menu__item is-danger" href="${rel}auth/login.html"><i data-lucide="log-out"></i>Sign out</a>
          <div class="t-2xs t-faint mono" style="padding:8px 10px 4px">v0.241.0 RC · build 2026.08.14</div>
        </div>
      </div>
      <!-- Command palette -->
      <div class="overlay" id="palette" data-overlay>
        <div class="palette" role="dialog" aria-label="Command palette">
          <div class="palette__input"><i data-lucide="search"></i><input type="text" placeholder="Search projects, versions, catalog items… or type a command" autofocus /><span class="kbd">esc</span></div>
          <div class="palette__list">
            <div class="palette__group">Jump to</div>
            <div class="palette__item is-active"><i data-lucide="folder-kanban"></i><span>Projects</span><span class="pi-sub">Build</span><span class="pi-right"><span class="kbd">G</span><span class="kbd">P</span></span></div>
            <div class="palette__item"><i data-lucide="library"></i><span>Catalog</span><span class="pi-sub">Bring in</span><span class="pi-right"><span class="kbd">G</span><span class="kbd">C</span></span></div>
            <div class="palette__item"><i data-lucide="shield-check"></i><span>Lint posture</span><span class="pi-sub">Govern</span></div>
            <div class="palette__group">Actions</div>
            <div class="palette__item"><i data-lucide="plus"></i><span>New project…</span><span class="pi-right"><span class="kbd">N</span></span></div>
            <div class="palette__item"><i data-lucide="upload"></i><span>Import a spec…</span><span class="pi-right"><span class="kbd">I</span></span></div>
            <div class="palette__item"><i data-lucide="key-round"></i><span>Create API key…</span></div>
            <div class="palette__item"><i data-lucide="palette"></i><span>Change theme…</span></div>
            <div class="palette__group">Recent</div>
            <div class="palette__item"><i data-lucide="file-json-2"></i><span>Payments API</span><span class="pi-sub">v2.4.0 · draft</span><span class="pi-right t-xs t-subtle">2h ago</span></div>
            <div class="palette__item"><i data-lucide="file-json-2"></i><span>Orders Service</span><span class="pi-sub">v1.9.2 · published</span><span class="pi-right t-xs t-subtle">yesterday</span></div>
          </div>
          <div class="palette__foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> navigate</span><span><span class="kbd">↵</span> open</span><span><span class="kbd">tab</span> actions</span><span style="margin-left:auto">Type <span class="kbd">&gt;</span> for commands</span></div>
        </div>
      </div>
      <!-- Preferences pane -->
      <div class="overlay overlay--drawer" id="settings-pane" data-overlay>
        <div class="drawer" role="dialog" aria-label="Preferences" id="settings-drawer"></div>
      </div>
      <!-- Keyboard shortcuts sheet (?) -->
      <div class="overlay" id="shortcuts" data-overlay>
        <div class="dialog dialog--lg">
          <div class="dialog__header"><div><div class="dialog__title">Keyboard shortcuts</div><div class="dialog__desc">Press <span class="kbd">?</span> anywhere to open this sheet.</div></div><button class="btn btn--ghost btn--icon dialog__close" data-action="close"><i data-lucide="x"></i></button></div>
          <div class="dialog__body grid grid-2 gap-6">
            <div><div class="t-caps mb-2">Global</div><div class="col gap-2 t-sm">
              <div class="row-between"><span>Command palette</span><span><span class="kbd">⌘</span><span class="kbd">K</span></span></div>
              <div class="row-between"><span>Preferences</span><span><span class="kbd">⌘</span><span class="kbd">,</span></span></div>
              <div class="row-between"><span>Collapse / expand sidebar</span><span><span class="kbd">⌘</span><span class="kbd">\\</span></span></div>
              <div class="row-between"><span>Focus search / filter</span><span class="kbd">/</span></div>
              <div class="row-between"><span>Close dialog, drawer, menu</span><span class="kbd">Esc</span></div>
              <div class="row-between"><span>This sheet</span><span class="kbd">?</span></div>
            </div></div>
            <div><div class="t-caps mb-2">Jump (press G, then…)</div><div class="col gap-2 t-sm">
              <div class="row-between"><span>Home</span><span><span class="kbd">G</span><span class="kbd">H</span></span></div>
              <div class="row-between"><span>Projects</span><span><span class="kbd">G</span><span class="kbd">P</span></span></div>
              <div class="row-between"><span>Catalog</span><span><span class="kbd">G</span><span class="kbd">C</span></span></div>
              <div class="row-between"><span>Lint posture</span><span><span class="kbd">G</span><span class="kbd">L</span></span></div>
              <div class="row-between"><span>Studio</span><span><span class="kbd">G</span><span class="kbd">S</span></span></div>
              <div class="row-between"><span>Members</span><span><span class="kbd">G</span><span class="kbd">M</span></span></div>
            </div></div>
            <div><div class="t-caps mb-2">On a list</div><div class="col gap-2 t-sm">
              <div class="row-between"><span>New item</span><span class="kbd">N</span></div>
              <div class="row-between"><span>Import</span><span class="kbd">I</span></div>
              <div class="row-between"><span>Move selection</span><span><span class="kbd">↑</span><span class="kbd">↓</span></span></div>
              <div class="row-between"><span>Open</span><span class="kbd">↵</span></div>
              <div class="row-between"><span>Select row</span><span class="kbd">X</span></div>
              <div class="row-between"><span>Row actions</span><span class="kbd">.</span></div>
            </div></div>
            <div><div class="t-caps mb-2">Studio</div><div class="col gap-2 t-sm">
              <div class="row-between"><span>Save</span><span><span class="kbd">⌘</span><span class="kbd">S</span></span></div>
              <div class="row-between"><span>Search canvas</span><span><span class="kbd">⌘</span><span class="kbd">F</span></span></div>
              <div class="row-between"><span>Auto-layout</span><span><span class="kbd">⇧</span><span class="kbd">L</span></span></div>
              <div class="row-between"><span>Fit view</span><span><span class="kbd">⇧</span><span class="kbd">1</span></span></div>
              <div class="row-between"><span>Toggle inspector</span><span><span class="kbd">⌘</span><span class="kbd">I</span></span></div>
              <div class="row-between"><span>Editor · Paths · Code</span><span><span class="kbd">1</span><span class="kbd">2</span><span class="kbd">3</span></span></div>
            </div></div>
          </div>
          <div class="dialog__footer"><span class="left t-xs t-subtle">Shortcut chips on buttons can be hidden in Preferences.</span><button class="btn" data-action="close">Done</button></div>
        </div>
      </div>
      <!-- What's new -->
      <div class="overlay" id="whats-new" data-overlay>
        <div class="dialog dialog--sm">
          <div class="dialog__header"><div><div class="t-caps" style="color:var(--honey-fg)">What’s new</div><div class="dialog__title" style="margin-top:4px">v0.241.0</div><div class="dialog__desc">Released 14 Aug 2026</div></div><button class="btn btn--ghost btn--icon dialog__close" data-action="close"><i data-lucide="x"></i></button></div>
          <div class="dialog__body col gap-3">
            <div class="row-start gap-3"><span class="icon-tile icon-tile--sm icon-tile--honey"><i data-lucide="sparkles"></i></span><div><div class="t-sm t-600">Import from the Versions list</div><div class="t-xs t-muted">Bring a spec straight into a project without leaving the list.</div></div></div>
            <div class="row-start gap-3"><span class="icon-tile icon-tile--sm icon-tile--accent"><i data-lucide="shield-check"></i></span><div><div class="t-sm t-600">Stored lint reports</div><div class="t-xs t-muted">Version lint badges load from the stored report — no re-lint on list.</div></div></div>
            <div class="row-start gap-3"><span class="icon-tile icon-tile--sm icon-tile--ok"><i data-lucide="database"></i></span><div><div class="t-sm t-600">DB-backed config source</div><div class="t-xs t-muted">Validation + provider setup docs for the database config source.</div></div></div>
          </div>
          <div class="dialog__footer"><a class="btn btn--ghost left" href="#">Full changelog <i data-lucide="arrow-up-right"></i></a><button class="btn btn--primary" data-action="close">Got it</button></div>
        </div>
      </div>`;
    return wrap;
  }

  function renderSettings(container) {
    const p = Hive.prefs();
    const themeCards = THEMES.map((t) => {
      const sw = t.swatch;
      const preview = sw
        ? `<div class="theme-prev" style="background:${sw[0]}"><div style="background:${sw[1]};box-shadow:0 0 0 1px rgba(0,0,0,.08)"><span style="background:${sw[2]}"></span><span style="background:${sw[3]}"></span></div></div>`
        : `<div class="theme-prev theme-prev--split"><div style="background:#F6F5F2"></div><div style="background:#141311"></div></div>`;
      return `<button class="theme-card${p.theme === t.id ? ' is-active' : ''}" data-theme-id="${t.id}" role="radio" aria-checked="${p.theme === t.id}">${preview}<div class="theme-card__name">${esc(t.name)}</div><div class="theme-card__desc">${esc(t.desc)}</div></button>`;
    }).join('');
    const idx = Math.max(0, FONT_SCALES.findIndex((f) => f.id === p.font));
    container.innerHTML = `
      <div class="drawer__header">
        <div><div class="drawer__title">Preferences</div><div class="t-xs t-muted">Personal to you · applies to every workspace on this device</div></div>
        <button class="btn btn--ghost btn--icon" style="margin-left:auto" data-action="close" aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <div class="drawer__body col gap-6">
        <div class="tabs" style="margin-top:-6px;border-bottom:1px solid var(--border)">
          <a class="tab is-active" href="#appearance"><i data-lucide="palette"></i>Appearance</a>
          <a class="tab" href="#account"><i data-lucide="circle-user"></i>Account</a>
          <a class="tab" href="#notifications"><i data-lucide="bell"></i>Notifications</a>
          <a class="tab" href="#shortcuts"><i data-lucide="keyboard"></i>Shortcuts</a>
        </div>
        <section>
          <div class="t-h4">Theme</div>
          <div class="t-xs t-muted mb-3">A theme is a token swap: surfaces, ink, accent. Layout and type never change.</div>
          <div class="theme-grid" role="radiogroup" aria-label="Theme">${themeCards}</div>
        </section>
        <section>
          <div class="row-between"><div><div class="t-h4">Font size</div><div class="t-xs t-muted">Scales the whole interface, not just body text.</div></div><span class="badge badge--outline t-num" id="font-scale-label">${FONT_SCALES[idx].label} · ${FONT_SCALES[idx].px}px</span></div>
          <div class="row gap-3 mt-3"><span style="font-size:11px" class="t-subtle">A</span><input type="range" class="slider" id="font-scale-slider" min="0" max="${FONT_SCALES.length - 1}" step="1" value="${idx}" aria-label="Font size" /><span style="font-size:18px" class="t-subtle">A</span></div>
          <div class="row-between t-2xs t-faint mt-1" style="padding:0 18px">${FONT_SCALES.map((f) => `<span>${f.label}</span>`).join('')}</div>
          <div class="card card--soft mt-3" style="padding:12px 14px"><div class="t-sm t-600">Preview</div><div class="t-sm t-muted">Orders Service · v1.9.2 · 14 paths, 32 schemas · Published 3 days ago</div><div class="mono t-xs mt-1">GET /orders/{orderId} → 200 Order</div></div>
        </section>
        <section>
          <div class="t-h4">Density</div>
          <div class="t-xs t-muted mb-3">Compact tightens rows, controls and page padding for large screens.</div>
          <div class="segmented" role="radiogroup" aria-label="Density">
            <button data-density-id="comfortable" class="${p.density === 'comfortable' ? 'is-active' : ''}"><i data-lucide="rows-3"></i>Comfortable</button>
            <button data-density-id="compact" class="${p.density === 'compact' ? 'is-active' : ''}"><i data-lucide="rows-4"></i>Compact</button>
          </div>
        </section>
        <section>
          <div class="switch-row"><div><div class="sw-title">Reduce motion</div><div class="sw-desc">Turn off transitions and animated progress.</div></div><button class="switch${p.motion === 'reduce' ? ' is-on' : ''}" role="switch" aria-checked="${p.motion === 'reduce'}" data-motion-toggle></button></div>
          <div class="switch-row"><div><div class="sw-title">Collapse sidebar by default</div><div class="sw-desc">Start with the icon rail; hover to peek labels.</div></div><button class="switch${root.getAttribute('data-rail') === 'collapsed' ? ' is-on' : ''}" role="switch" data-rail-toggle></button></div>
          <div class="switch-row"><div><div class="sw-title">Monospace for identifiers</div><div class="sw-desc">Render ids, hashes and versions in JetBrains Mono.</div></div><button class="switch is-on" role="switch" aria-checked="true"></button></div>
          <div class="switch-row"><div><div class="sw-title">Show keyboard hints</div><div class="sw-desc">Display shortcut chips on buttons and menus.</div></div><button class="switch is-on" role="switch" aria-checked="true"></button></div>
        </section>
      </div>
      <div class="drawer__footer"><span class="t-xs t-subtle" style="margin-right:auto">Saved automatically</span><button class="btn" data-action="close">Done</button></div>`;
    // wire
    container.querySelectorAll('[data-theme-id]').forEach((b) => b.addEventListener('click', () => { Hive.setTheme(b.getAttribute('data-theme-id')); renderSettings(container); Hive.icons(); }));
    container.querySelectorAll('[data-density-id]').forEach((b) => b.addEventListener('click', () => { Hive.setDensity(b.getAttribute('data-density-id')); renderSettings(container); Hive.icons(); }));
    const slider = container.querySelector('#font-scale-slider');
    slider.addEventListener('input', () => { const f = FONT_SCALES[+slider.value]; Hive.setFontScale(f.id); container.querySelector('#font-scale-label').textContent = `${f.label} · ${f.px}px`; });
    container.querySelector('[data-motion-toggle]').addEventListener('click', (e) => { Hive.setMotion(e.currentTarget.classList.contains('is-on') ? 'auto' : 'reduce'); renderSettings(container); Hive.icons(); });
    container.querySelector('[data-rail-toggle]').addEventListener('click', (e) => { Hive.toggleRail(); renderSettings(container); Hive.icons(); });
  }

  /* Settings pane component styles (kept here so pages need no extra CSS) */
  const settingsCss = `
    .theme-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
    .theme-card { text-align: left; padding: 8px; border-radius: var(--r-md); background: var(--bg-surface); box-shadow: 0 0 0 1px var(--border) inset; transition: box-shadow var(--dur-fast); }
    .theme-card:hover { box-shadow: 0 0 0 1px var(--border-strong) inset; }
    .theme-card.is-active { box-shadow: 0 0 0 2px var(--accent) inset; }
    .theme-card__name { font-size: var(--fs-sm); font-weight: 600; margin-top: 8px; }
    .theme-card__desc { font-size: var(--fs-2xs); color: var(--fg-subtle); }
    .theme-prev { height: 54px; border-radius: 6px; padding: 8px 8px 0 8px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); overflow: hidden; }
    .theme-prev > div { height: 100%; border-radius: 4px 4px 0 0; padding: 6px; display: flex; gap: 4px; align-items: flex-start; }
    .theme-prev > div > span { display: block; height: 6px; border-radius: 3px; }
    .theme-prev > div > span:first-child { width: 40%; } .theme-prev > div > span:last-child { width: 20%; }
    .theme-prev--split { display: grid; grid-template-columns: 1fr 1fr; padding: 0; }
    .theme-prev--split > div { border-radius: 0; height: 100%; }
    .tip { position: fixed; z-index: 300; padding: 5px 8px; border-radius: 6px; background: var(--fg); color: var(--bg-surface); font-size: 11px; font-weight: 500; pointer-events: none; white-space: nowrap; }
  `;

  function mountShell() {
    const kind = document.body.getAttribute('data-shell') || 'app';
    const rel = relRoot();
    const main = document.querySelector('body > main') || document.querySelector('main');
    // Mockup chrome present on every page
    const chrome = h(`
      <div class="mock-bar" role="toolbar" aria-label="Mockup tools">
        <a href="${rel}index.html" title="Back to the mockup index"><i data-lucide="layout-grid"></i>Index</a>
        <span class="sep"></span>
        <button data-action="notes" title="Implementation notes for this screen"><i data-lucide="notebook-pen"></i>Notes</button>
        <button data-action="annot" title="Toggle numbered annotations"><i data-lucide="message-square-dot"></i>Callouts</button>
        <span class="sep"></span>
        <button data-action="theme" title="Toggle light/dark"><i data-lucide="sun-moon"></i></button>
        <button data-action="open" data-target="settings-pane" title="Preferences (⌘,)"><i data-lucide="settings-2"></i></button>
      </div>`);
    const style = document.createElement('style'); style.textContent = settingsCss; document.head.appendChild(style);

    if (kind === 'app' || kind === 'admin') {
      const shell = document.createElement('div');
      shell.className = 'shell';
      const active = document.body.getAttribute('data-nav') || '';
      const rail = renderRail(kind, active, rel);
      document.body.insertBefore(shell, main);
      shell.appendChild(rail);
      shell.appendChild(main);
    } else if (kind === 'studio') {
      // Studio pages render their own topbar; the rail is collapsed by default.
      if (!root.hasAttribute('data-rail-user')) root.setAttribute('data-rail', store.get(PREF_KEYS.rail, 'collapsed'));
      const shell = document.createElement('div');
      shell.className = 'shell';
      const rail = renderRail('app', document.body.getAttribute('data-nav') || 'studio', rel);
      document.body.insertBefore(shell, main);
      shell.appendChild(rail);
      shell.appendChild(main);
    }
    document.body.appendChild(renderOverlays(rel, kind));
    document.body.appendChild(chrome);

    // Notes panel from <template id="notes">
    const tpl = document.getElementById('notes');
    const notes = h(`<aside class="mock-notes" id="mock-notes"><h3><i data-lucide="notebook-pen"></i>Implementation notes</h3><div class="mock-notes__body"></div></aside>`);
    notes.querySelector('.mock-notes__body').innerHTML = tpl ? tpl.innerHTML : '<p class="t-muted">No notes for this screen yet.</p>';
    document.body.appendChild(notes);

    // Delegated actions
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-action]');
      if (t) {
        const a = t.getAttribute('data-action');
        if (a === 'open') { e.preventDefault(); const id = t.getAttribute('data-target'); if (id === 'settings-pane') renderSettings(document.getElementById('settings-drawer')); Hive.open(id); Hive.icons(); }
        else if (a === 'close') { e.preventDefault(); const ov = t.closest('.overlay'); if (ov) ov.classList.remove('is-open'); }
        else if (a === 'swap') { e.preventDefault(); const ov = t.closest('.overlay'); if (ov) ov.classList.remove('is-open'); const id = t.getAttribute('data-target'); if (id === 'settings-pane') renderSettings(document.getElementById('settings-drawer')); Hive.open(id); Hive.icons(); }
        else if (a === 'toggle-rail') { Hive.toggleRail(); }
        else if (a === 'nav-group') { const g = t.closest('.nav-group'); g.classList.toggle('is-collapsed'); t.setAttribute('aria-expanded', !g.classList.contains('is-collapsed')); const all = [...document.querySelectorAll('.nav-group.is-collapsed')].map((x) => x.getAttribute('data-group')).filter(Boolean); store.set('hive.navCollapsed', JSON.stringify(all)); }
        else if (a === 'theme') { Hive.cycleTheme(); }
        else if (a === 'notes') { notes.classList.toggle('is-open'); }
        else if (a === 'annot') { Hive.toggleAnnot(); }
        else if (a === 'toggle') { const id = t.getAttribute('data-target'); const el = document.getElementById(id); if (el) el.hidden = !el.hidden; }
        else if (a === 'tab') {
          const group = t.closest('[data-tabs]');
          if (group) {
            group.querySelectorAll('.tab, .segmented > button, .segmented > a').forEach((x) => x.classList.remove('is-active'));
            t.classList.add('is-active');
            const panelId = t.getAttribute('data-target');
            if (panelId) {
              const scope = document.getElementById(group.getAttribute('data-tabs')) || document;
              // Only this group's own panels: skip panels nested inside another panel,
              // so a nested tab group keeps its own visibility state.
              scope.querySelectorAll('[data-tab-panel]').forEach((p) => {
                const owner = p.parentElement && p.parentElement.closest('[data-tab-panel]');
                if (owner && scope.contains(owner)) return; // belongs to a nested group
                p.hidden = p.getAttribute('data-tab-panel') !== panelId;
              });
            }
          }
          e.preventDefault();
        }
        else if (a === 'switch') { const on = t.classList.toggle('is-on'); t.setAttribute('aria-checked', on); }
        else if (a === 'chip') { t.classList.toggle('is-active'); }
        else if (a === 'select-row') { t.closest('tr').classList.toggle('is-selected'); }
        return;
      }
      // click on overlay backdrop closes
      const ov = e.target.classList && e.target.classList.contains('overlay') ? e.target : null;
      if (ov) ov.classList.remove('is-open');
    });
    document.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); Hive.open('palette'); const inp = document.querySelector('#palette input'); if (inp) inp.focus(); }
      if (meta && e.key === ',') { e.preventDefault(); renderSettings(document.getElementById('settings-drawer')); Hive.open('settings-pane'); Hive.icons(); }
      if (meta && e.key === '\\') { e.preventDefault(); Hive.toggleRail(); }
      if (e.key === 'Escape') document.querySelectorAll('.overlay.is-open').forEach((o) => o.classList.remove('is-open'));
      if (e.key === '?' && !/input|textarea/i.test(document.activeElement.tagName)) { Hive.open('shortcuts'); }
    });
    // Rail tooltips when collapsed
    let tip;
    document.addEventListener('mouseover', (e) => {
      const it = e.target.closest('.rail .nav-item, .rail .ws-switch, .rail .rail__user, .rail .search-trigger');
      if (!it || root.getAttribute('data-rail') !== 'collapsed') return;
      const label = it.querySelector('span:not(.avatar):not(.kbd):not(.badge)') ? it.querySelector('span:not(.avatar):not(.kbd):not(.badge)').textContent.trim() : (it.getAttribute('title') || '');
      if (!label) return;
      tip = document.createElement('div'); tip.className = 'tip'; tip.textContent = label; document.body.appendChild(tip);
      const r = it.getBoundingClientRect(); tip.style.left = (r.right + 8) + 'px'; tip.style.top = (r.top + r.height / 2 - 12) + 'px';
      it.addEventListener('mouseleave', () => { if (tip) tip.remove(); tip = null; }, { once: true });
    });

    // Sortable header + row-hover affordances (visual only)
    document.querySelectorAll('.table th.sortable').forEach((th) => th.addEventListener('click', () => { th.parentElement.querySelectorAll('th').forEach((x) => x.classList.remove('is-sorted')); th.classList.add('is-sorted'); }));

    Hive.icons();
    document.addEventListener('hive:prefs', () => Hive.icons());
    document.dispatchEvent(new CustomEvent('hive:mounted'));
    const auto = document.body.getAttribute('data-open');
    if (auto) { if (auto === 'settings-pane') renderSettings(document.getElementById('settings-drawer')); Hive.open(auto); Hive.icons(); }
  }

  /* ---------- Icons: load lucide (CDN) then mount ------------------------ */
  function boot() {
    if (window.lucide) { mountShell(); return; }
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js';
    s.onload = mountShell;
    s.onerror = mountShell; // degrade gracefully: icons render as empty
    document.head.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
