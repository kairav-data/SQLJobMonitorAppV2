/* ══════════════════════════════════════════════════════════════════════════════
   SQL Job Monitor  — app.js
   Single-page application logic powered by pywebview's Python API bridge.
   ══════════════════════════════════════════════════════════════════════════════ */

'use strict';

/* ─── helpers ──────────────────────────────────────────────────────────────── */
var $ = id => document.getElementById(id);
var el = (tag, cls = '', html = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
};
var fmt = isoStr => {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};
var fmtDateLabel = isoStr => {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return isoStr;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
var fmtDur = secs => {
    if (secs == null) return '';
    return secs < 60 ? `(${secs}s)` : `(${Math.floor(secs / 60)}m ${secs % 60}s)`;
};

/* ─── state ────────────────────────────────────────────────────────────────── */
var S = {
    role: null, userId: null, username: null, permissions: {view: false, run: false, toggle: false},
    defaultServerId: null, defaultProjectId: null,
    servers: [], activeServer: null,
    jobs: [], sortBy: 'name', sortDir: 'asc', q: '',
    statusFilter: null, dateFilter: null, dateJobs: null, dateActivity: {},
    statusMessage: '', statusColor: '',
    alertedKeys: new Set(), alertTimer: null,
    runningPollTimer: null,
    searchDebounce: null,
    storageStatus: null,
    storageWarningShown: false,
    // Projects state
    projects: [],
    activeProject: null,
    currentView: 'jobs',
    isDraggingNode: false,
    dragNode: null,
    dragMoved: false,
    dragOffset: {x:0, y:0},
    isDrawingEdge: false,
    edgeSource: null,
    tempEdgePath: null,
    pipelineDirty: false,
    pipelineSaveTimer: null,
    pipelineSaveInFlight: false,
    projectsSyncTimer: null,
    projectsSnapshot: '',
    sharedSyncTimer: null
};

var normalizeRole = role => {
    const value = String(role || '').trim().toLowerCase();
    if (value === 'viewer') return 'user';
    return ['admin', 'ops', 'user'].includes(value) ? value : 'user';
};
var isAdmin = () => normalizeRole(S.role) === 'admin';
var isRestrictedUser = () => normalizeRole(S.role) === 'user';
var canOperateJobs = () => {
    if (isAdmin()) return true;
    return S.permissions ? S.permissions.run : false;
};
var canToggleJobs = () => {
    if (isAdmin()) return true;
    return S.permissions ? S.permissions.toggle : false;
};
var canSqlDownload = () => {
    if (isAdmin()) return true;
    return S.permissions ? S.permissions.sql_download : false;
};
var canSqlUpdate = () => {
    if (isAdmin()) return true;
    return S.permissions ? S.permissions.sql_update : false;
};

function setAdminOnlyVisibility(isVisible) {
    const method = isVisible ? 'remove' : 'add';
    // Handle specific IDs
    ['btn-add-server', 'btn-manage-users', 'btn-create-project', 'btn-save-pipeline', 'pipeline-jobs-panel']
        .forEach(id => {
            const node = $(id);
            if (node) node.classList[method]('hidden');
        });
    
    // Handle all .admin-only classes
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList[method]('hidden');
    });
}


function updateTabsVisibility() {
    const tabSql = $('tab-sql-operations');
    if (tabSql) {
        const hasSqlAccess = canSqlDownload() || canSqlUpdate();
        tabSql.classList.toggle('hidden', !hasSqlAccess);
    }
    updateSqlPermissionsUI();
}

function updateSqlPermissionsUI() {
    const btnDl = $('sql-mode-download');
    const btnUp = $('sql-mode-update');
    const pnlDl = $('sql-panel-download');
    const pnlUp = $('sql-panel-update');

    if (!btnDl || !btnUp) return;

    const hasDl = canSqlDownload();
    const hasUp = canSqlUpdate();

    btnDl.classList.toggle('hidden', !hasDl);
    btnUp.classList.toggle('hidden', !hasUp);

    // If only one is available, ensure we switch to the right panel
    if (hasUp && !hasDl) {
        btnUp.classList.add('active');
        btnDl.classList.remove('active');
        pnlUp.classList.remove('hidden');
        pnlDl.classList.add('hidden');
        if (typeof loadSqlTemplates === 'function') loadSqlTemplates();
    } else if (hasDl) {
        // Default to Download if available
        btnDl.classList.add('active');
        btnUp.classList.remove('active');
        pnlDl.classList.remove('hidden');
        pnlUp.classList.add('hidden');
    }
}


function updateActiveDatePill() {
    const pill = $('active-date-pill');
    if (!pill) return;
    pill.textContent = '';
    pill.classList.add('hidden');
}

/* ─── API bridge ───────────────────────────────────────────────────────────── */
var api = () => window.pywebview.api;

function storageStatusColor(status) {
    if (!status) return 'var(--text-3)';
    if (status.level === 'warning') return 'var(--warning)';
    if (status.level === 'success') return 'var(--success)';
    return 'var(--text-3)';
}

function renderStatusBar() {
    const bar = $('status-bar');
    if (!bar) return;

    const parts = [];
    const titles = [];

    if (S.storageStatus && S.storageStatus.summary) {
        parts.push(S.storageStatus.summary);
        if (S.storageStatus.detail) titles.push(S.storageStatus.detail);
        if (Array.isArray(S.storageStatus.notes) && S.storageStatus.notes.length) {
            titles.push(S.storageStatus.notes.join('\n'));
        }
    }

    if (S.statusMessage) {
        parts.push(S.statusMessage);
        titles.push(S.statusMessage);
    }

    bar.textContent = parts.join(' | ');
    bar.title = titles.join('\n');
    bar.style.color = S.statusMessage
        ? (S.statusColor || 'var(--text-3)')
        : storageStatusColor(S.storageStatus);
}

function setStorageStatus(status) {
    S.storageStatus = status || null;
    renderStatusBar();
}

async function refreshStorageStatus() {
    try {
        const status = await api().get_storage_status();
        setStorageStatus(status);

        if (
            status
            && status.configured_backend === 'sqlserver'
            && status.effective_backend !== 'sqlserver'
            && !S.storageWarningShown
        ) {
            S.storageWarningShown = true;
            toast('Shared SQL is unavailable. New users and pipelines are saving to local JSON for now.', 'warning', 7000);
        }
    } catch (e) {
        setStorageStatus({
            summary: 'Storage status unavailable',
            detail: String(e),
            level: 'warning',
            notes: []
        });
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════════ */
function init() {
    // Login
    $('btn-login').addEventListener('click', doLogin);
    $('inp-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    $('inp-user').addEventListener('keydown', e => { if (e.key === 'Enter') $('inp-pass').focus(); });

    // Header
    $('btn-refresh').addEventListener('click', loadJobs);
    $('btn-calendar').addEventListener('click', e => {
        if (e.target.closest('.clear-date-filter')) {
            setDateFilter(null);
            e.stopPropagation();
        } else {
            openCalendar();
        }
    });
    $('btn-logout').addEventListener('click', doLogout);
    $('btn-manage-users').addEventListener('click', openUserManagement);
    $('btn-add-server').addEventListener('click', openAddServer);

    // KPI Filters
    $('stat-total').addEventListener('click', () => setStatusFilter(null));
    $('stat-ok').addEventListener('click', () => setStatusFilter('Succeeded'));
    $('stat-run').addEventListener('click', () => setStatusFilter('In Progress'));
    $('stat-fail').addEventListener('click', () => setStatusFilter('Failed'));
    $('stat-dis').addEventListener('click', () => setStatusFilter('Disabled'));

    // Search
    $('inp-search').addEventListener('input', () => {
        clearTimeout(S.searchDebounce);
        S.q = $('inp-search').value.trim().toLowerCase();
        if (S.q.length === 0 || S.q.length >= 3) {
            S.searchDebounce = setTimeout(loadJobs, 350);
        } else {
            renderJobs();
        }
    });

    // Sort columns
    document.querySelectorAll('.th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (S.sortBy === col) S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
            else { S.sortBy = col; S.sortDir = 'asc'; }
            document.querySelectorAll('.th.sortable').forEach(t => t.classList.remove('sorted'));
            th.classList.add('sorted');
            renderJobs();
        });
    });

    // Modal overlay click-to-close
    $('modal-overlay').addEventListener('click', e => {
        if (e.target === $('modal-overlay')) hideModal();
    });

    initResizers();
    if (typeof initProjects === 'function') initProjects();
}

/* ══════════════════════════════════════════════════════════════════════════════
   COLUMN RESIZING
   ══════════════════════════════════════════════════════════════════════════════ */
function initResizers() {
    let isResizing = false;
    let currentResizer = null;
    let startX = 0;
    let startWidth = 0;
    let nextStartWidth = 0;
    let cssVar = '';
    let nextCssVar = '';

    document.querySelectorAll('.resizer').forEach(resizer => {
        resizer.addEventListener('mousedown', e => {
            e.stopPropagation();
            e.preventDefault();
            isResizing = true;
            currentResizer = resizer;
            resizer.classList.add('dragging');
            cssVar = resizer.dataset.var;
            
            // Convert all columns to fixed px widths upon first drag
            const ths = document.querySelectorAll('.table-header .th');
            const vars = ['--w-name', '--w-status', '--w-last', '--w-next', '--w-actions', '--w-toggle'];
            
            const parentTh = resizer.closest('.th');
            const thIndex = Array.from(ths).indexOf(parentTh);

            ths.forEach((th, i) => {
                const w = th.getBoundingClientRect().width;
                document.documentElement.style.setProperty(vars[i], w + 'px');
            });

            startX = e.pageX;
            startWidth = parentTh.getBoundingClientRect().width;
            
            if (thIndex !== -1 && thIndex + 1 < vars.length) {
                nextCssVar = vars[thIndex + 1];
                nextStartWidth = ths[thIndex + 1].getBoundingClientRect().width;
            } else {
                nextCssVar = '';
            }

            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });
    });

    document.addEventListener('mousemove', e => {
        if (!isResizing) return;
        let diffX = e.pageX - startX;
        
        let newWidth = startWidth + diffX;
        let newNextWidth = nextStartWidth - diffX;
        
        if (newWidth < 60) {
            diffX = 60 - startWidth;
            newWidth = 60;
            newNextWidth = nextStartWidth - diffX;
        }
        if (nextCssVar && newNextWidth < 60) {
            diffX = nextStartWidth - 60;
            newNextWidth = 60;
            newWidth = startWidth + diffX;
        }

        document.documentElement.style.setProperty(cssVar, newWidth + 'px');
        if (nextCssVar) {
            document.documentElement.style.setProperty(nextCssVar, newNextWidth + 'px');
        }
    });

    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        if (currentResizer) currentResizer.classList.remove('dragging');
        currentResizer = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
}

/* ══════════════════════════════════════════════════════════════════════════════
   AUTH
   ══════════════════════════════════════════════════════════════════════════════ */
async function doLogin() {
    const u = $('inp-user').value.trim();
    const p = $('inp-pass').value;
    if (!u || !p) { showErr('Please enter username and password.'); return; }

    $('btn-login').disabled = true;
    $('btn-login-text').textContent = 'Signing in…';
    $('btn-login-spin').classList.remove('hidden');
    $('login-err').classList.add('hidden');

    try {
        const res = await api().login(u, p);
        if (!res.ok) {
            showErr('Invalid username or password.');
            return;
        }
        S.role = normalizeRole(res.role);
        S.userId = res.user_id;
        S.username = res.username;
        S.permissions = res.permissions || {view: false, run: false, toggle: false, sql_download: false, sql_update: false};
        S.defaultServerId = res.default_server_id || null;
        S.defaultProjectId = res.default_project_id || null;
        await showDashboard();
    } catch (e) {
        showErr('Connection error: ' + e);
    } finally {
        $('btn-login').disabled = false;
        $('btn-login-text').textContent = 'Sign In';
        $('btn-login-spin').classList.add('hidden');
    }
}

function showErr(msg) {
    const e = $('login-err');
    e.textContent = msg;
    e.classList.remove('hidden');
}

function doLogout() {
    if (api() && typeof api().logout === 'function') {
        Promise.resolve(api().logout()).catch(e => {
            console.warn('Logout sync failed:', e);
        });
    }
    clearAlertTimer();
    clearTimeout(S.runningPollTimer);
    S.runningPollTimer = null;
    if (typeof stopProjectSync === 'function') stopProjectSync();
    stopSharedSync();
    S.role = null; S.userId = null; S.username = null; S.permissions = null;
    S.defaultServerId = null; S.defaultProjectId = null;
    S.servers = []; S.activeServer = null;
    S.jobs = []; S.q = ''; S.alertedKeys.clear();
    S.statusFilter = null; S.dateFilter = null;
    S.dateJobs = null; S.dateActivity = {};
    S.statusMessage = ''; S.statusColor = '';
    S.storageStatus = null; S.storageWarningShown = false;
    S.pipelineDirty = false;
    S.pipelineSaveInFlight = false;
    clearTimeout(S.pipelineSaveTimer);
    S.pipelineSaveTimer = null;
    S.projectsSnapshot = '';
    $('inp-user').value = '';
    $('inp-pass').value = '';
    $('login-err').classList.add('hidden');
    $('view-dash').classList.add('hidden');
    $('view-login').classList.remove('hidden');
    $('view-tabs').classList.add('hidden');
    updateActiveDatePill();
    setAdminOnlyVisibility(false);
    renderStatusBar();
    if (typeof S.projects !== 'undefined') { S.projects = []; S.activeProject = null; }
}

/* ══════════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ══════════════════════════════════════════════════════════════════════════════ */
async function showDashboard() {
    $('view-login').classList.add('hidden');
    $('view-dash').classList.remove('hidden');

    // Role badge
    const badge = $('role-badge');
    badge.textContent = normalizeRole(S.role);
    badge.className = 'role-badge ' + normalizeRole(S.role);
    setAdminOnlyVisibility(isAdmin());
    updateTabsVisibility();

    await refreshServers();
    await refreshStorageStatus();
    if (isRestrictedUser() && S.servers.length) {
        const targetServer = S.servers.find(server => server.id === S.defaultServerId) || S.servers[0];
        if (targetServer) {
            await selectServer(targetServer);
        }
    }
    startSharedSync();
}

/* ══════════════════════════════════════════════════════════════════════════════
   SERVERS
   ══════════════════════════════════════════════════════════════════════════════ */
async function refreshServers() {
    S.servers = await api().get_servers();
    renderServers();
}

function renderServers() {
    const list = $('server-list');
    list.innerHTML = '';
    S.servers.forEach(srv => {
        const isActive = S.activeServer && S.activeServer.id === srv.id;
        const item = el('div', 'server-item' + (isActive ? ' active' : ''));

        const btn = el('button', 'server-item-btn');
        btn.textContent = srv.alias;
        btn.title = srv.address + (srv.instance ? '\\' + srv.instance : '');
        btn.addEventListener('click', () => selectServer(srv));
        item.appendChild(btn);

        if (isAdmin()) {
            const del = el('button', 'server-del-btn', '✕');
            del.title = 'Remove server';
            del.addEventListener('click', e => { e.stopPropagation(); deleteServer(srv.id); });
            item.appendChild(del);
        }
        list.appendChild(item);
    });
}

function stopSharedSync() {
    if (S.sharedSyncTimer) clearInterval(S.sharedSyncTimer);
    S.sharedSyncTimer = null;
}

function startSharedSync() {
    stopSharedSync();
    S.sharedSyncTimer = setInterval(syncSharedData, 5000);
}

async function syncSharedData() {
    if (!S.role) return;
    try {
        const servers = await api().get_servers();
        const activeServerId = S.activeServer ? S.activeServer.id : null;
        S.servers = Array.isArray(servers) ? servers : [];

        if (activeServerId) {
            const refreshedServer = S.servers.find(server => server.id === activeServerId) || null;
            if (refreshedServer) {
                S.activeServer = refreshedServer;
            } else {
                S.activeServer = null;
                S.projects = [];
                S.activeProject = null;
                S.currentView = 'jobs';
                if (typeof stopProjectSync === 'function') stopProjectSync();
                $('server-title').textContent = 'Select a server';
                $('server-subtitle').textContent = '';
                $('btn-refresh').disabled = true;
                $('btn-calendar').disabled = true;
                $('inp-search').disabled = true;
                $('view-tabs').classList.add('hidden');
                clearJobs();
                resetStats();
            }
        }

        renderServers();
    } catch (err) {
        console.warn('Shared sync failed:', err);
    }
}

async function selectServer(srv) {
    S.activeServer = srv;
    S.activeProject = null;
    S.alertedKeys.clear();
    S.statusFilter = null;
    S.dateFilter = null;
    S.dateJobs = null;
    S.dateActivity = {};
    clearTimeout(S.runningPollTimer);
    S.runningPollTimer = null;
    ['stat-total', 'stat-ok', 'stat-run', 'stat-fail', 'stat-dis'].forEach(id => $(id).classList.remove('active'));
    $('stat-total').classList.add('active');
    $('btn-calendar').innerHTML = 'Calendar';
    $('btn-calendar').classList.remove('active-filter');
    updateActiveDatePill();
    $('server-title').textContent = srv.alias;
    $('server-subtitle').textContent = srv.address + (srv.instance ? '\\' + srv.instance : '');
    $('btn-refresh').disabled = false;
    $('btn-calendar').disabled = false;
    $('inp-search').disabled = false;
    $('view-tabs').classList.remove('hidden');
    if(typeof switchTab === 'function') switchTab(isRestrictedUser() ? 'projects' : 'jobs');
    renderServers();
    await loadJobs();
    if (isRestrictedUser() && typeof loadProjects === 'function') {
        await loadProjects();
    }
    startAlertTimer();
}

async function deleteServer(serverId) {
    showConfirm('Remove Server', 'Remove this server from the list?', async () => {
        const res = await api().delete_server(serverId);
        S.servers = res.servers;
        if (S.activeServer && S.activeServer.id === serverId) {
            S.activeServer = null;
            $('server-title').textContent = 'Select a server';
            $('server-subtitle').textContent = '';
            $('btn-refresh').disabled = true;
            $('btn-calendar').disabled = true;
            $('inp-search').disabled = true;
            clearJobs();
            resetStats();
        }
        renderServers();
        toast('Server removed.', 'success');
    }, '✕ Remove', 'danger');
}

function openAddServer() {
    const box = el('div', 'history-modal');
    box.innerHTML = `
    <div class="modal-title">Add SQL Server</div>
    <div class="modal-sub">Connect to a SQL Server Agent instance</div>
    <div class="add-server-form">
      <div class="form-group"><label class="form-label">Server Alias *</label>
        <input id="as-alias" class="form-input" placeholder="e.g. Production DB"></div>
      <div class="form-group"><label class="form-label">Server Address / IP *</label>
        <input id="as-addr" class="form-input" placeholder="192.168.1.10"></div>
      <div class="form-group"><label class="form-label">Instance (optional)</label>
        <input id="as-inst" class="form-input" placeholder="SQLEXPRESS"></div>
      <div class="form-group"><label class="form-label">Username (blank = Windows Auth)</label>
        <input id="as-user" class="form-input" placeholder="sa"></div>
      <div class="form-group"><label class="form-label">Password</label>
        <input id="as-pass" class="form-input" type="password" placeholder="••••••••"></div>
      <p id="as-msg" style="font-size:12px; margin-top:6px; min-height:18px;"></p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-muted" id="as-test">Test Connection</button>
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" id="as-save">Save Server</button>
    </div>`;
    showModal(box);

    document.getElementById('as-test').addEventListener('click', async () => {
        const btn = document.getElementById('as-test');
        btn.disabled = true; btn.textContent = 'Testing…';
        const msg = document.getElementById('as-msg');
        const res = await api().test_connection(
            v('as-alias'), v('as-addr'), v('as-inst'), v('as-user'), v('as-pass'));
        btn.disabled = false; btn.textContent = 'Test Connection';
        msg.textContent = (res.ok ? '✓ ' : '✗ ') + res.message;
        msg.style.color = res.ok ? 'var(--success)' : 'var(--danger)';
    });

    document.getElementById('as-save').addEventListener('click', async () => {
        if (!v('as-alias') || !v('as-addr')) {
            document.getElementById('as-msg').textContent = 'Alias and Address are required.';
            document.getElementById('as-msg').style.color = 'var(--danger)';
            return;
        }
        const btn = document.getElementById('as-save');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        
        const res = await api().add_server(v('as-alias'), v('as-addr'), v('as-inst'), v('as-user'), v('as-pass'));
        
        btn.disabled = false;
        btn.textContent = 'Save Server';
        
        S.servers = res.servers;
        renderServers();
        hideModal();
        toast(`Server '${v('as-alias') || 'new'}' added.`, 'success');
    });
}

const v = id => document.getElementById(id)?.value.trim() ?? '';

/* ══════════════════════════════════════════════════════════════════════════════
   JOBS
   ══════════════════════════════════════════════════════════════════════════════ */
async function loadJobs() {
    if (!S.activeServer) return;
    setStatus('Loading jobs…', 'var(--text-3)');
    clearJobs();
    $('job-list').innerHTML = '<div class="empty-state"><div class="spin" style="width:28px;height:28px;border-width:3px"></div><p>Fetching jobs…</p></div>';

    try {
        const res = await api().fetch_jobs(S.activeServer.id);
        if (!res.ok) { setStatus('Error: ' + res.error, 'var(--danger)'); $('job-list').innerHTML = ''; return; }
        S.jobs = res.jobs;
        if (S.dateFilter) {
            const filteredRes = await api().fetch_jobs_by_date(S.activeServer.id, S.dateFilter);
            S.dateJobs = filteredRes && filteredRes.ok ? filteredRes.jobs : [];
        }
        setStatus('', '');
        renderJobs();

        // If any jobs are actively running or pipeline is running, poll every 5 seconds
        const hasRunning = S.jobs.some(j => j.last_run_status === 'In Progress') || (typeof S.pipelineIsRunning !== 'undefined' && S.pipelineIsRunning);
        if (hasRunning) {
            clearTimeout(S.runningPollTimer);
            setStatus('⟳ Job running — auto-refreshing…', 'var(--primary)');
            S.runningPollTimer = setTimeout(loadJobs, 5000);
        } else {
            clearTimeout(S.runningPollTimer);
            S.runningPollTimer = null;
        }

        if (typeof S !== 'undefined' && S.currentView === 'projects' && S.activeProject && typeof renderPipeline === 'function') {
            renderPipeline();
        }
        
        if (typeof checkPipelineQueue === 'function') {
            checkPipelineQueue();
        }
    } catch (e) {
        setStatus('Error: ' + e, 'var(--danger)');
        $('job-list').innerHTML = '';
    }
}

function setStatusFilter(filter) {
    if (S.statusFilter === filter) filter = null;
    S.statusFilter = filter;
    
    ['stat-total', 'stat-ok', 'stat-run', 'stat-fail', 'stat-dis'].forEach(id => $(id).classList.remove('active'));
    if (S.statusFilter === null) $('stat-total').classList.add('active');
    else if (S.statusFilter === 'Succeeded') $('stat-ok').classList.add('active');
    else if (S.statusFilter === 'In Progress') $('stat-run').classList.add('active');
    else if (S.statusFilter === 'Failed') $('stat-fail').classList.add('active');
    else if (S.statusFilter === 'Disabled') $('stat-dis').classList.add('active');
    
    renderJobs();
}

async function setDateFilter(dateStr) {
    if (S.dateFilter === dateStr) {
        S.dateFilter = null;
        S.dateJobs = null;
    } else {
        S.dateFilter = dateStr;
    }

    const btn = $('btn-calendar');
    if (S.dateFilter) {
        btn.innerHTML = `${fmtDateLabel(S.dateFilter)} <span class="clear-date-filter" title="Clear filter">Clear</span>`;
        btn.classList.add('active-filter');

        $('job-list').innerHTML = '<div class="empty-state"><div class="spin" style="width:28px;height:28px;border-width:3px"></div><p>Fetching jobs for ' + S.dateFilter + '...</p></div>';
        const res = await api().fetch_jobs_by_date(S.activeServer.id, S.dateFilter);
        if (res && res.ok) {
            S.dateJobs = res.jobs;
        } else {
            toast('Failed to fetch history: ' + (res ? res.error : 'Unknown error'), 'error');
            S.dateJobs = [];
        }
    } else {
        btn.innerHTML = 'Calendar';
        btn.classList.remove('active-filter');
        S.dateJobs = null;
    }
    updateActiveDatePill();
    renderJobs();
}

function renderJobs() {
    const list = $('job-list');
    list.innerHTML = '';

    let baseJobs = S.dateFilter && S.dateJobs ? S.dateJobs : S.jobs;

    let jobs = baseJobs.filter(j =>
        !S.q || j.name.toLowerCase().includes(S.q) || (j.description || '').toLowerCase().includes(S.q));

    // Update stats BEFORE status filter
    updateStats(jobs);

    if (S.statusFilter) {
        if (S.statusFilter === 'Disabled') jobs = jobs.filter(j => !j.enabled);
        else jobs = jobs.filter(j => j.last_run_status === S.statusFilter);
    }

    jobs.sort((a, b) => {
        let va = a[S.sortBy] ?? '', vb = b[S.sortBy] ?? '';
        return S.sortDir === 'asc' ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
    });

    if (!jobs.length) {
        const emptyMessage = S.dateFilter
            ? `No jobs were found for ${fmtDateLabel(S.dateFilter)}.`
            : 'No jobs match your search.';
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">•</div><p>${emptyMessage}</p></div>`;
        return;
    }

    jobs.forEach((job, i) => {
        const row = buildJobRow(job, i);
        list.appendChild(row);
    });
}

function buildJobRow(job, idx) {
    const canRun = canOperateJobs();
    const canToggle = canToggleJobs();
    const status = job.last_run_status.replace(' ', '');
    const lastStr = fmt(job.start_execution_date);
    const dur = fmtDur(job.duration_seconds);
    const nextStr = fmt(job.next_scheduled_run_date);

    const row = el('div', 'job-row');
    row.style.animationDelay = `${idx * 0.03}s`;

    // Name cell
    const nameCell = el('div', 'job-cell cell-name');
    nameCell.title = `${job.name}\n${job.description || 'No description'}`;
    const nameEl = el('div', 'job-name' + (!job.enabled ? ' disabled' : ''), '');
    nameEl.textContent = job.name;
    const descEl = el('div', 'job-desc');
    descEl.textContent = job.description || 'No description';
    nameCell.appendChild(nameEl);
    nameCell.appendChild(descEl);
    row.appendChild(nameCell);

    // Status badge
    const statusCell = el('div', 'job-cell cell-status');
    const badge = el('span', `badge badge-${status}`);
    badge.textContent = job.last_run_status;
    statusCell.appendChild(badge);
    row.appendChild(statusCell);

    // Last run
    const lastCell = el('div', 'job-cell cell-last');
    lastCell.innerHTML = `<div class="date-text">${lastStr}</div>${dur ? `<div class="date-dur">${dur}</div>` : ''}`;
    row.appendChild(lastCell);

    // Next run
    const nextCell = el('div', 'job-cell cell-next');
    const nextEl = el('div', 'date-next');
    nextEl.textContent = nextStr;
    nextCell.appendChild(nextEl);
    row.appendChild(nextCell);

    // Actions
    const actCell = el('div', 'job-cell cell-actions');
    const runBtn = el('button', 'row-btn', '▶ Run');
    runBtn.disabled = !canRun || !job.enabled;
    runBtn.addEventListener('click', () => openRunJobConfirm(job, runBtn));
    const histBtn = el('button', 'row-btn hist', '📋');
    histBtn.title = 'View run history';
    histBtn.addEventListener('click', () => openHistory(job));
    actCell.appendChild(runBtn);
    actCell.appendChild(histBtn);
    row.appendChild(actCell);

    // Toggle
    const togCell = el('div', 'job-cell cell-toggle');
    const togWrap = el('div', 'toggle-wrap');
    const tog = el('div', `toggle${job.enabled ? ' on' : ''}${!canToggle ? ' disabled' : ''}`);
    const knob = el('div', 'toggle-knob');
    tog.appendChild(knob);
    const togLbl = el('div', 'toggle-label');
    togLbl.textContent = job.enabled ? 'ON' : 'OFF';

    if (canToggle) {
        tog.addEventListener('click', () => {
            const newEnabled = !job.enabled;
            const action = newEnabled ? 'Enable' : 'Disable';
            showConfirm(`${action} Job`,
                `${action} job:\n"${job.name}"?`,
                async () => {
                    tog.classList.add('disabled');
                    const res = await api().set_job_enabled(S.activeServer.id, job.name, newEnabled);
                    tog.classList.remove('disabled');
                    if (res.ok) { toast(res.message, 'success'); setTimeout(loadJobs, 600); }
                    else {
                        toast('Failed: ' + res.message, 'error');
                    }
                },
                action,
                newEnabled ? 'success' : 'danger',
                () => { } // cancel: do nothing, UI refreshes on next load
            );
        });
    }

    togWrap.appendChild(tog);
    togWrap.appendChild(togLbl);
    togCell.appendChild(togWrap);
    row.appendChild(togCell);

    return row;
}

/* ── Stats ──────────────────────────────────────────────────────────────────── */
function updateStats(jobs) {
    const total = jobs.length;
    const ok    = jobs.filter(j => j.last_run_status === 'Succeeded').length;
    const run   = jobs.filter(j => j.last_run_status === 'In Progress').length;
    const fail  = jobs.filter(j => j.last_run_status === 'Failed').length;
    const dis   = jobs.filter(j => !j.enabled).length;
    animateNum($('stat-total').querySelector('.stat-value'), total);
    animateNum($('stat-ok').querySelector('.stat-value'), ok);
    animateNum($('stat-run').querySelector('.stat-value'), run);
    animateNum($('stat-fail').querySelector('.stat-value'), fail);
    animateNum($('stat-dis').querySelector('.stat-value'), dis);
}

function animateNum(el, target) {
    const start = parseInt(el.textContent) || 0;
    const diff = target - start;
    if (diff === 0) { el.textContent = target; return; }
    const steps = 20;
    let step = 0;
    const timer = setInterval(() => {
        step++;
        el.textContent = Math.round(start + diff * (step / steps));
        if (step >= steps) clearInterval(timer);
    }, 20);
}

function resetStats() {
    ['stat-total', 'stat-ok', 'stat-run', 'stat-fail', 'stat-dis'].forEach(id => {
        $(`${id}`).querySelector('.stat-value').textContent = '—';
    });
}

function clearJobs() { $('job-list').innerHTML = ''; }
function setStatus(msg, color) {
    S.statusMessage = msg || '';
    S.statusColor = color || '';
    renderStatusBar();
}

/* ══════════════════════════════════════════════════════════════════════════════
   HISTORY MODAL
   ══════════════════════════════════════════════════════════════════════════════ */
async function openHistory(job) {
    const box = el('div', 'history-modal');
    box.innerHTML = `
    <div class="modal-title">Run History</div>
    <div class="modal-sub">${job.name}</div>
    <div id="hist-body" class="history-table-wrap"><div class="empty-state"><div class="spin" style="width:24px;height:24px;border-width:3px"></div><p>Loading...</p></div></div>
    <div class="modal-footer"><button class="btn btn-ghost" id="btn-copy-history-all">Copy All Comments</button><button class="btn btn-ghost" onclick="hideModal()">Close</button></div>`;
    showModal(box);

    const res = await api().fetch_history(S.activeServer.id, job.name);
    const body = document.getElementById('hist-body');
    const copyAllBtn = document.getElementById('btn-copy-history-all');
    const copyText = async (text, trigger) => {
        const value = String(text || '').trim();
        if (!value) return;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                const temp = document.createElement('textarea');
                temp.value = value;
                temp.setAttribute('readonly', '');
                temp.style.position = 'absolute';
                temp.style.left = '-9999px';
                document.body.appendChild(temp);
                temp.select();
                document.execCommand('copy');
                document.body.removeChild(temp);
            }
            if (trigger) {
                const original = trigger.textContent;
                trigger.textContent = 'Copied';
                setTimeout(() => { trigger.textContent = original; }, 1200);
            }
            toast('Comment copied.', 'success', 1800);
        } catch (e) {
            toast('Copy failed.', 'error', 2200);
        }
    };
    if (!res.ok) { body.innerHTML = `<p style="color:var(--danger)">${res.error}</p>`; return; }
    if (!res.history.length) { body.innerHTML = '<div class="empty-state"><p>No history found.</p></div>'; return; }

    body.innerHTML = '<div class="history-list" id="history-list"></div>';

    const historyList = document.getElementById('history-list');
    if (copyAllBtn) {
        copyAllBtn.addEventListener('click', () => {
            const combined = res.history
                .map(h => `[${fmt(h.run_datetime)}] ${h.status}: ${h.message || 'No message available.'}`)
                .join('\n\n');
            copyText(combined, copyAllBtn);
        });
    }
    res.history.forEach(h => {
        const s = h.status.replace(' ', '');
        const row = el('div', 'history-entry');
        row.innerHTML = `
          <div class="history-entry-top">
            <span class="hist-date">${fmt(h.run_datetime)}</span>
            <span class="badge badge-${s}">${h.status}</span>
            <span class="hist-dur">${fmtDur(h.duration_seconds) || ''}</span>
          </div>
          <div class="hist-msg-wrap">
            <div class="hist-msg">${h.message || 'No message available.'}</div>
            <button class="btn btn-ghost sm history-copy-btn" type="button">Copy</button>
          </div>
        `;
        row.querySelector('.history-copy-btn').addEventListener('click', () => {
            copyText(h.message || 'No message available.', row.querySelector('.history-copy-btn'));
        });
        historyList.appendChild(row);
    });
}
/* ══════════════════════════════════════════════════════════════════════════════
   CALENDAR MODAL
   ══════════════════════════════════════════════════════════════════════════════ */
let _calYear = null, _calMonth = null;

async function openCalendar() {
    const box = el('div');
    box.innerHTML = `
    <div class="modal-title">Activity Calendar</div>
    <div class="modal-sub">Pick any date to load jobs that ran on that day. Highlighted dates have recorded execution activity.</div>
    <div id="cal-body"><div class="empty-state"><div class="spin" style="width:24px;height:24px;border-width:3px"></div><p>Loading activity...</p></div></div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="hideModal()">Close</button></div>`;
    showModal(box);

    const res = await api().fetch_activity_dates(S.activeServer.id, 365);
    if (!res || !res.ok) {
        document.getElementById('cal-body').innerHTML = `<div class="empty-state"><p style="color:var(--danger)">Unable to load activity calendar. ${res ? res.error : ''}</p></div>`;
        return;
    }
    S.dateActivity = res.activity || {};
    const baseDate = S.dateFilter ? new Date(S.dateFilter) : new Date();
    _calYear = baseDate.getFullYear();
    _calMonth = baseDate.getMonth();
    renderCalendar();
}

function renderCalendar() {
    const body = document.getElementById('cal-body');
    if (!body) return;

    // Build date→jobs map
    const map = S.dateActivity || {};

    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

    const firstDay = new Date(_calYear, _calMonth, 1);
    const totalDays = new Date(_calYear, _calMonth + 1, 0).getDate();
    // Monday-based start offset
    let startDow = firstDay.getDay(); // 0=Sun
    startDow = startDow === 0 ? 6 : startDow - 1;

    const todayStr = new Date().toISOString().split('T')[0];

    let html = `
    <div class="cal-nav">
      <button class="btn btn-ghost sm" id="cal-prev">◀</button>
      <span class="cal-month">${MONTHS[_calMonth]} ${_calYear}</span>
      <button class="btn btn-ghost sm" id="cal-next">▶</button>
    </div>
    <div class="cal-legend">
      <span class="cal-legend-item"><span class="cal-legend-swatch active"></span>Activity logged</span>
      <span class="cal-legend-item"><span class="cal-legend-swatch today"></span>Today</span>
    </div>
    <div class="cal-grid">`;

    DAYS.forEach(d => { html += `<div class="cal-dow">${d}</div>`; });

    // Empty cells before first day
    for (let i = 0; i < startDow; i++) html += '<div class="cal-day empty"></div>';

    for (let day = 1; day <= totalDays; day++) {
        const dd = String(day).padStart(2, '0');
        const mm = String(_calMonth + 1).padStart(2, '0');
        const dateStr = `${_calYear}-${mm}-${dd}`;
        const isToday = dateStr === todayStr;
        const isSelected = dateStr === S.dateFilter;
        const activity = map[dateStr] || null;
        const count = activity ? Number(activity.count || 0) : 0;

        html += `<button class="cal-day${isToday ? ' today' : ''}${count ? ' has-activity' : ''}${isSelected ? ' selected' : ''}" data-date="${dateStr}" type="button">
      <div class="cal-day-head">
        <div class="cal-day-num">${day}</div>
        ${count ? '<span class="cal-indicator" aria-hidden="true"></span>' : ''}
      </div>
    </button>`;
    }
    html += '</div>';
    body.innerHTML = html;

    document.getElementById('cal-prev').addEventListener('click', () => {
        _calMonth--; if (_calMonth < 0) { _calMonth = 11; _calYear--; } renderCalendar();
    });
    document.getElementById('cal-next').addEventListener('click', () => {
        _calMonth++; if (_calMonth > 11) { _calMonth = 0; _calYear++; } renderCalendar();
    });

    // Day click
    body.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
        cell.addEventListener('click', async () => {
            const dateStr = cell.dataset.date;
            await setDateFilter(dateStr);
            hideModal();
        });
    });
}

function showDayPopup(dateStr, jobs) {
    const d = new Date(dateStr);
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const box = el('div');
    box.innerHTML = `
    <div class="modal-title">📅 ${label}</div>
    <div class="modal-sub">${jobs.length} job(s) scheduled</div>
    <div class="day-popup">
      ${jobs.map(name => `<div class="day-job-item"><span class="day-job-dot">●</span><span>${name}</span></div>`).join('')}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="popup-back">← Back to Calendar</button>
      <button class="btn btn-ghost" onclick="hideModal()">Close</button>
    </div>`;
    showModal(box, false);
    document.getElementById('popup-back').addEventListener('click', () => { renderCalendar(); document.getElementById('cal-body') && renderCalendar(); openCalendar(); });
    // simpler: just re-render calendar in-place
    document.getElementById('popup-back').addEventListener('click', () => {
        hideModal();
        setTimeout(openCalendar, 100);
    }, { once: true });
}

/* ══════════════════════════════════════════════════════════════════════════════
   USER MANAGEMENT MODAL
   ══════════════════════════════════════════════════════════════════════════════ */
async function openUserManagement() {
    const box = el('div');
    box.innerHTML = `
    <div class="modal-title">👤 User Management</div>
    <div class="modal-sub">Manage application users and roles</div>
    <div id="um-list"></div>
    <div class="modal-divider"></div>
    <div style="margin-top:4px">
      <div class="modal-sub" style="margin-bottom:12px; font-weight:600; color:var(--text)">Add New User</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 110px;gap:10px;align-items:end">
        <div><label class="form-label">Username</label><input id="um-uname" class="form-input" placeholder="username"></div>
        <div><label class="form-label">Password</label><input id="um-pass" class="form-input" type="password" placeholder="••••••••"></div>
        <div><label class="form-label">Role</label>
          <select id="um-role" class="form-input form-select">
            <option value="user">user</option>
            <option value="ops">ops</option>
            <option value="admin">admin</option>
          </select>
        </div>
      </div>
      <p id="um-msg" style="font-size:12px;margin-top:8px;min-height:16px"></p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="hideModal()">Close</button>
      <button class="btn btn-primary" id="um-add">+ Add User</button>
    </div>`;
    showModal(box);
    await renderUserList();

    document.getElementById('um-add').addEventListener('click', async () => {
        const uname = document.getElementById('um-uname').value.trim();
        const pass = document.getElementById('um-pass').value;
        const role = document.getElementById('um-role').value;
        const msg = document.getElementById('um-msg');
        if (!uname || !pass) { msg.style.color = 'var(--danger)'; msg.textContent = 'Username and password are required.'; return; }
        
        const btn = document.getElementById('um-add');
        btn.disabled = true;
        btn.textContent = 'Adding...';
        
        const res = await api().add_user(uname, pass, role);
        
        btn.disabled = false;
        btn.textContent = '+ Add User';
        
        if (res.ok) {
            msg.style.color = 'var(--success)';
            msg.textContent = `✓ User '${uname}' added.`;
            document.getElementById('um-uname').value = '';
            document.getElementById('um-pass').value = '';
            await renderUserList();
        } else {
            msg.style.color = 'var(--danger)';
            msg.textContent = '✗ ' + res.error;
        }
    });
}

async function renderUserList() {
    const ul = document.getElementById('um-list');
    if (!ul) return;
    const users = await api().list_users();

    const roleColors = { admin: 'var(--primary)', ops: 'var(--warning)', user: 'var(--success)' };

    let html = `<div class="user-list-header"><div>Username</div><div>Role</div><div>Actions</div></div>`;
    users.forEach(u => {
        const isSelf = u.id === S.userId;
        const rColor = roleColors[u.role] || 'var(--text-2)';
        html += `<div class="user-row" data-uid="${u.id}">
      <div class="user-name">${u.username}${isSelf ? ' <span style="font-size:10px;color:var(--text-3)">(you)</span>' : ''}</div>
      <div><span class="badge" style="background:rgba(0,0,0,.3);color:${rColor};border:1px solid ${rColor}40">${u.role}</span></div>
      <div class="user-actions">
        <button class="btn btn-ghost sm um-acc" data-uid="${u.id}" data-name="${u.username}" data-perms='${JSON.stringify(u.permissions||{})}' style="font-size:11px;padding:4px 10px">⚙️ Access</button>
        <button class="btn btn-ghost sm um-pwd" data-uid="${u.id}" data-name="${u.username}" style="font-size:11px;padding:4px 10px">🔑 Passwd</button>
        <button class="btn btn-danger sm um-del" data-uid="${u.id}" data-name="${u.username}" style="font-size:11px;padding:4px 10px" ${isSelf ? 'disabled title="Cannot delete yourself"' : ''}>✕</button>
      </div>
    </div>`;
    });
    ul.innerHTML = html;

    ul.querySelectorAll('.um-acc').forEach(btn => {
        btn.addEventListener('click', () => changeAccess(btn.dataset.uid, btn.dataset.name, JSON.parse(btn.dataset.perms)));
    });
    ul.querySelectorAll('.um-pwd').forEach(btn => {
        btn.addEventListener('click', () => changePassword(btn.dataset.uid, btn.dataset.name));
    });
    ul.querySelectorAll('.um-del:not(:disabled)').forEach(btn => {
        btn.addEventListener('click', () => deleteUser(btn.dataset.uid, btn.dataset.name));
    });
}

function changeAccess(userId, username, perms) {
    const box = el('div');
    const pView        = perms.view !== false;
    const pRun         = perms.run === true;
    const pToggle      = perms.toggle === true;
    const pSqlDownload = perms.sql_download === true;
    const pSqlUpdate   = perms.sql_update === true;
    
    box.innerHTML = `
    <div class="modal-title">⚙️ Access Permissions</div>
    <div class="modal-sub">Granular access for <strong>${username}</strong></div>

    <div style="display:flex;flex-direction:column;gap:4px;margin:16px 0 8px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px;">Jobs</div>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg-alt);">
        <input type="checkbox" id="chk-view" ${pView ? 'checked' : ''}>
        <span><strong>View Jobs &amp; Projects</strong> <span style="color:var(--text-3);font-size:12px;">— see jobs, history, pipeline</span></span>
      </label>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg-alt);">
        <input type="checkbox" id="chk-run" ${pRun ? 'checked' : ''}>
        <span><strong>Run Jobs</strong> <span style="color:var(--text-3);font-size:12px;">— manually trigger SQL Agent jobs</span></span>
      </label>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg-alt);">
        <input type="checkbox" id="chk-toggle" ${pToggle ? 'checked' : ''}>
        <span><strong>Enable / Disable Jobs</strong> <span style="color:var(--text-3);font-size:12px;">— toggle job enabled state</span></span>
      </label>
    </div>

    <div style="display:flex;flex-direction:column;gap:4px;margin:8px 0 8px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px;">SQL Operations</div>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg-alt);">
        <input type="checkbox" id="chk-sql-dl" ${pSqlDownload ? 'checked' : ''}>
        <span><strong>SQL Download</strong> <span style="color:var(--text-3);font-size:12px;">— run SELECT queries &amp; export results</span></span>
      </label>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg-alt);">
        <input type="checkbox" id="chk-sql-upd" ${pSqlUpdate ? 'checked' : ''}>
        <span><strong>SQL Update</strong> <span style="color:var(--text-3);font-size:12px;">— execute admin-approved update templates</span></span>
      </label>
    </div>

    <p id="acc-msg" style="font-size:12px;min-height:16px;margin-top:4px;"></p>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="acc-back">← Back</button>
      <button class="btn btn-primary" id="acc-save">Save Permissions</button>
    </div>`;
    showModal(box, false);
    document.getElementById('acc-back').addEventListener('click', openUserManagement);
    document.getElementById('acc-save').addEventListener('click', async () => {
        const newPerms = {
            view:         document.getElementById('chk-view').checked,
            run:          document.getElementById('chk-run').checked,
            toggle:       document.getElementById('chk-toggle').checked,
            sql_download: document.getElementById('chk-sql-dl').checked,
            sql_update:   document.getElementById('chk-sql-upd').checked,
        };
        const msg = document.getElementById('acc-msg');
        msg.textContent = 'Saving...';
        msg.style.color = 'var(--text-2)';

        const btn = document.getElementById('acc-save');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        const res = await api().update_user_permissions(userId, newPerms);

        btn.disabled = false;
        btn.textContent = 'Save Permissions';
        
        if (res.ok) { 
            toast(`Permissions updated for '${username}'.`, 'success'); 
            openUserManagement(); 
        } else { 
            msg.style.color = 'var(--danger)'; 
            msg.textContent = '✗ ' + res.error; 
        }
    });
}

function changePassword(userId, username) {
    const box = el('div');
    box.innerHTML = `
    <div class="modal-title">🔑 Change Password</div>
    <div class="modal-sub">New password for <strong>${username}</strong></div>
    <input id="pwd-inp" class="form-input" type="password" placeholder="New password" style="margin-bottom:8px">
    <p id="pwd-msg" style="font-size:12px;min-height:16px"></p>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="pwd-back">← Back</button>
      <button class="btn btn-primary" id="pwd-save">Save Password</button>
    </div>`;
    showModal(box, false);
    document.getElementById('pwd-back').addEventListener('click', openUserManagement);
    document.getElementById('pwd-save').addEventListener('click', async () => {
        const newPwd = document.getElementById('pwd-inp').value;
        const msg = document.getElementById('pwd-msg');
        if (!newPwd) { msg.style.color = 'var(--danger)'; msg.textContent = 'Password cannot be empty.'; return; }
        const res = await api().update_password(userId, newPwd);
        if (res.ok) { toast(`Password updated for '${username}'.`, 'success'); openUserManagement(); }
        else { msg.style.color = 'var(--danger)'; msg.textContent = '✗ ' + res.error; }
    });
}

async function deleteUser(userId, username) {
    showConfirm('Delete User', `Delete user '${username}'?\nThis cannot be undone.`, async () => {
        const res = await api().delete_user(userId);
        if (res.ok) { toast(`User '${username}' deleted.`, 'success'); openUserManagement(); }
        else { toast('Error: ' + res.error, 'error'); openUserManagement(); }
    }, '✕ Delete', 'danger', () => { openUserManagement(); });
}

/* ══════════════════════════════════════════════════════════════════════════════
   UPCOMING-JOB ALERTS
   ══════════════════════════════════════════════════════════════════════════════ */
const ALERT_MINS = 5;

function startAlertTimer() {
    clearAlertTimer();
    S.alertTimer = setInterval(checkUpcomingJobs, 60_000);
}

function clearAlertTimer() {
    if (S.alertTimer) clearInterval(S.alertTimer);
    S.alertTimer = null;
}

function checkUpcomingJobs() {
    const now = Date.now();
    S.jobs.forEach(j => {
        if (!j.next_scheduled_run_date) return;
        const runAt = new Date(j.next_scheduled_run_date).getTime();
        const diffMin = (runAt - now) / 60_000;
        if (diffMin >= 0 && diffMin <= ALERT_MINS) {
            const key = j.name + '|' + j.next_scheduled_run_date;
            if (!S.alertedKeys.has(key)) {
                S.alertedKeys.add(key);
                toast(`⏰ "${j.name}" runs in ~${Math.ceil(diffMin)} min`, 'warning', 8000);
            }
        }
    });
}

/* ══════════════════════════════════════════════════════════════════════════════
   MODAL SYSTEM
   ══════════════════════════════════════════════════════════════════════════════ */
function showModal(contentEl, closeOnOverlay = true) {
    const overlay = $('modal-overlay');
    const box = $('modal-box');
    box.innerHTML = '';
    box.appendChild(contentEl);
    overlay.classList.remove('hidden');
    // close on overlay only when allowed
    overlay.onclick = e => { if (closeOnOverlay && e.target === overlay) hideModal(); };
}

function hideModal() {
    $('modal-overlay').classList.add('hidden');
    $('modal-box').innerHTML = '';
    $('modal-box').removeAttribute('style');
}

function showConfirm(title, message, onConfirm, confirmLabel = 'Confirm', confirmStyle = 'primary', onCancel = null) {
    const ICON_MAP = { danger: '&#10006;', primary: '&#9432;', success: '&#10004;', warning: '&#9888;' };
    const icon = ICON_MAP[confirmStyle] || '&#9888;';
    
    let kicker = 'Action Required';
    if (confirmStyle === 'danger') kicker = 'Critical Action';
    if (title.includes('Enable') || title.includes('Disable')) kicker = 'Job Configuration';
    if (title.includes('Server')) kicker = 'Server Management';

    const box = el('div', 'run-confirm-modal');
    box.innerHTML = `
    <div class="run-confirm-hero">
      <div class="run-confirm-icon ${confirmStyle}-icon">${icon}</div>
      <div class="run-confirm-kicker">${kicker}</div>
      <div class="run-confirm-title">${title}</div>
      <div class="run-confirm-sub">${message.replace(/\n/g, '<br>')}</div>
    </div>
    <div class="modal-footer run-confirm-footer">
      <button class="btn btn-ghost" id="conf-cancel">Cancel</button>
      <button class="btn btn-${confirmStyle}" id="conf-ok">${confirmLabel}</button>
    </div>`;
    showModal(box);
    document.getElementById('conf-cancel').addEventListener('click', () => { 
        if (onCancel) onCancel(); 
        else hideModal(); 
    });
    document.getElementById('conf-ok').addEventListener('click', async () => { 
        const btn = document.getElementById('conf-ok');
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'Processing...';
        
        try {
            if (onConfirm) await onConfirm();
        } finally {
            if (document.contains(btn)) {
                hideModal();
            }
        }
    });
}

/* ══════════════════════════════════════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════════════════════════════════════ */
function openRunJobConfirm(job, runBtn) {
    const box = el('div', 'run-confirm-modal');
    box.innerHTML = `
    <div class="run-confirm-hero">
      <div class="run-confirm-icon">&#9654;</div>
      <div class="run-confirm-kicker">SQL Agent Execution</div>
      <div class="run-confirm-title">Run job now?</div>
      <div class="run-confirm-sub">This will trigger the selected SQL Agent job immediately on the active server.</div>
    </div>
    <div class="run-confirm-card">
      <div class="run-confirm-label">Selected Job</div>
      <div class="run-confirm-name">${job.name}</div>
      <div class="run-confirm-meta">
        <span class="run-confirm-meta-pill">${S.activeServer ? S.activeServer.alias : 'Active server'}</span>
        <span class="run-confirm-meta-pill subtle">${job.enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
    </div>
    <div class="modal-footer run-confirm-footer">
      <button class="btn btn-ghost" id="run-confirm-cancel">Cancel</button>
      <button class="btn btn-primary" id="run-confirm-ok">Run Job</button>
    </div>`;
    showModal(box);

    document.getElementById('run-confirm-cancel').addEventListener('click', hideModal);
    document.getElementById('run-confirm-ok').addEventListener('click', async () => {
        hideModal();
        runBtn.disabled = true;
        runBtn.textContent = '...';
        const res = await api().run_job(S.activeServer.id, job.name);
        runBtn.textContent = '▶ Run';
        if (res.ok) {
            toast(res.message, 'success');
            setTimeout(loadJobs, 2500);
        } else {
            toast('Failed: ' + res.message, 'error');
            runBtn.disabled = false;
        }
    });
}
function toast(message, type = 'success', duration = 3500) {
    const container = $('toast-container');
    const t = el('div', `toast ${type}`);
    t.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;
    container.appendChild(t);
    setTimeout(() => {
        t.classList.add('toast-out');
        setTimeout(() => t.remove(), 280);
    }, duration);
}

/* ══════════════════════════════════════════════════════════════════════════════
   BOOTSTRAP
   ══════════════════════════════════════════════════════════════════════════════ */
if (window.pywebview) {
    window.addEventListener('pywebviewready', init);
} else {
    // Fallback for dev in browser (without pywebview)
    window.addEventListener('DOMContentLoaded', () => {
        // patch api() to return a dummy when testing in browser
        window.pywebview = { api: {} };
        init();
    });
}


/* ══════════════════════════════════════════════════════════════════════════════
   SQL DOWNLOAD FEATURE
   ══════════════════════════════════════════════════════════════════════════════ */

var _sqlResultData = null; // { columns, rows }

function initSqlDownload() {
    const runBtn  = $('btn-sql-run');
    const dlBtn   = $('btn-sql-download');
    const clrBtn  = $('btn-sql-clear');
    const editor  = $('sql-query-input');

    if (!runBtn || !editor) return;

    // Enable run button when server is active
    function updateSqlRunBtn() {
        if (runBtn) runBtn.disabled = !S.activeServer;
    }
    updateSqlRunBtn();

    // Ctrl+Enter to run
    editor.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!runBtn.disabled) runSqlQuery();
        }
    });

    runBtn.addEventListener('click', runSqlQuery);
    dlBtn.addEventListener('click', downloadSqlExcel);
    clrBtn.addEventListener('click', () => {
        editor.value = '';
        _sqlResultData = null;
        setSqlStatus('', '');
        setSqlRowCount('');
        $('btn-sql-download').disabled = true;
        $('sql-result-empty').classList.remove('hidden');
        $('sql-result-table-wrap').classList.add('hidden');
        $('sql-result-table').innerHTML = '';
    });

    // Keep run button in sync with server selection (poll S.activeServer)
    setInterval(updateSqlRunBtn, 500);
}

async function runSqlQuery() {
    if (!S.activeServer) { toast('Select a server first.', 'warning'); return; }

    const sql = $('sql-query-input').value.trim();
    if (!sql) { setSqlStatus('Please enter a SELECT query.', 'error'); return; }

    const runBtn = $('btn-sql-run');
    runBtn.disabled = true;
    runBtn.textContent = '⟳ Running…';
    setSqlStatus('Executing query…', '');
    setSqlRowCount('');
    $('btn-sql-download').disabled = true;
    _sqlResultData = null;

    // Show loading state in result area
    $('sql-result-empty').classList.add('hidden');
    $('sql-result-table-wrap').classList.add('hidden');
    const resultWrap = $('sql-result-wrap');
    let loadingEl = document.createElement('div');
    loadingEl.className = 'sql-result-loading';
    loadingEl.id = 'sql-result-loading';
    loadingEl.innerHTML = '<div class="spin" style="width:22px;height:22px;border-width:3px;border-top-color:var(--primary)"></div><span>Executing query…</span>';
    resultWrap.appendChild(loadingEl);

    try {
        const res = await api().execute_sql_download(S.activeServer.id, sql);
        if (!res.ok) {
            setSqlStatus('✗ ' + res.error, 'error');
            setSqlRowCount('');
            $('sql-result-empty').classList.remove('hidden');
        } else {
            _sqlResultData = { columns: res.columns, rows: res.rows };
            renderSqlResultTable(res.columns, res.rows);
            setSqlStatus('✓ Query executed successfully', 'success');
            setSqlRowCount(`${res.row_count.toLocaleString()} row${res.row_count !== 1 ? 's' : ''}`);
            $('btn-sql-download').disabled = false;
            toast(`Query returned ${res.row_count.toLocaleString()} row${res.row_count !== 1 ? 's' : ''}.`, 'success', 3000);
        }
    } catch (e) {
        setSqlStatus('✗ ' + String(e), 'error');
        setSqlRowCount('');
        $('sql-result-empty').classList.remove('hidden');
    } finally {
        runBtn.disabled = !S.activeServer;
        runBtn.textContent = '▶ Run Query';
        const loaderEl = document.getElementById('sql-result-loading');
        if (loaderEl) loaderEl.remove();
    }
}

function renderSqlResultTable(columns, rows) {
    const table = $('sql-result-table');
    table.innerHTML = '';

    // Header
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        th.title = col;
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    rows.forEach(row => {
        const tr = document.createElement('tr');
        row.forEach(cell => {
            const td = document.createElement('td');
            td.textContent = cell;
            td.title = cell;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    $('sql-result-empty').classList.add('hidden');
    $('sql-result-table-wrap').classList.remove('hidden');
}

async function downloadSqlExcel() {
    if (!_sqlResultData) { toast('No data to download. Run a query first.', 'warning'); return; }

    const { columns, rows } = _sqlResultData;

    // Build CSV with all values quoted as strings (forces Excel to treat as text)
    const escape = val => '"' + String(val === null || val === undefined ? '' : val).replace(/"/g, '""') + '"';

    const lines = [];
    lines.push(columns.map(escape).join(','));
    rows.forEach(row => {
        lines.push(row.map(cell => escape(cell)).join(','));
    });

    // CSV content (no BOM — Python writes utf-8-sig BOM on save)
    const csvContent = lines.join('\r\n');

    // Suggested filename with timestamp
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const suggestedName = `sql_download_${ts}.csv`;

    // Disable button while dialog is open
    const dlBtn = $('btn-sql-download');
    if (dlBtn) { dlBtn.disabled = true; dlBtn.textContent = '⟳ Saving…'; }

    try {
        // Ask Python to open the native Save As dialog and write the file
        const res = await api().save_csv_file(suggestedName, csvContent);

        if (res.cancelled) {
            // User closed/cancelled the dialog — no action needed
            return;
        }
        if (!res.ok) {
            toast('Save failed: ' + (res.error || 'Unknown error'), 'error', 4000);
            return;
        }

        // Show the saved path in the toast
        const shortPath = res.path.length > 60
            ? '…' + res.path.slice(-57)
            : res.path;
        toast(`✓ Saved ${rows.length.toLocaleString()} rows → ${shortPath}`, 'success', 5000);

    } catch (e) {
        toast('Save error: ' + String(e), 'error', 4000);
    } finally {
        if (dlBtn) { dlBtn.disabled = false; dlBtn.textContent = '⬇ Download Excel'; }
    }
}


function setSqlStatus(msg, type) {
    const el = $('sql-status-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sql-status-msg' + (type ? ' ' + type : '');
}

function setSqlRowCount(txt) {
    const el = $('sql-row-count');
    if (el) el.textContent = txt;
}








/* ─── SQL Operations (Download & Update) ─────────────────────────────────── */

let sqlTemplates = [];
let activeSqlTemplateId = null;

function initSqlOperations() {
    // Mode toggles
    const btnDl = $('sql-mode-download');
    const btnUp = $('sql-mode-update');
    const pnlDl = $('sql-panel-download');
    const pnlUp = $('sql-panel-update');

    if (btnDl && btnUp) {
        btnDl.addEventListener('click', () => {
            btnDl.classList.add('active');
            btnUp.classList.remove('active');
            pnlDl.classList.remove('hidden');
            pnlUp.classList.add('hidden');
        });
        btnUp.addEventListener('click', () => {
            btnUp.classList.add('active');
            btnDl.classList.remove('active');
            pnlUp.classList.remove('hidden');
            pnlDl.classList.add('hidden');
            loadSqlTemplates();
        });
    }

    // New Template (Admin)
    const btnNewTpl = $('btn-new-sql-template');
    if (btnNewTpl) {
        btnNewTpl.addEventListener('click', () => openTemplateEditor(null));
    }

    // Save/Cancel Template (Admin)
    const btnSaveTpl = $('btn-save-template');
    const btnCancelTpl = $('btn-cancel-template');
    if (btnSaveTpl) btnSaveTpl.addEventListener('click', saveSqlTemplate);
    if (btnCancelTpl) btnCancelTpl.addEventListener('click', closeTemplateEditor);

    // Delete Template (Admin)
    const btnDelTpl = $('btn-delete-template');
    const btnEditTpl = $('btn-edit-template');
    if (btnEditTpl) btnEditTpl.addEventListener('click', () => openTemplateEditor(sqlTemplates.find(t => t.id === activeSqlTemplateId)));
    if (btnDelTpl) btnDelTpl.addEventListener('click', deleteSqlTemplate);

    // Execute Template
    const btnRunUpdate = $('btn-run-update');
    if (btnRunUpdate) btnRunUpdate.addEventListener('click', executeSqlUpdate);
    
    // Live preview
    const inpSet = $('exec-inp-set');
    const inpWhere = $('exec-inp-where');
    if (inpSet) inpSet.addEventListener('input', updateSqlPreview);
    if (inpWhere) inpWhere.addEventListener('input', updateSqlPreview);

    // SQL Download bindings (if any were not bound)
    const btnSqlRun = $('btn-sql-run');
    if (btnSqlRun) {
        // remove existing listeners if any
        const newBtnSqlRun = btnSqlRun.cloneNode(true);
        btnSqlRun.parentNode.replaceChild(newBtnSqlRun, btnSqlRun);
        newBtnSqlRun.addEventListener('click', runSqlDownload);
    }
    
    const inpQuery = $('sql-query-input');
    if (inpQuery) {
        inpQuery.addEventListener('input', () => {
            const val = inpQuery.value.trim();
            const btn = $('btn-sql-run');
            if (btn) btn.disabled = !val || !S.activeServer;
        });
    }

    const btnSqlDl = $('btn-sql-download');
    if (btnSqlDl) {
        const newBtnSqlDl = btnSqlDl.cloneNode(true);
        btnSqlDl.parentNode.replaceChild(newBtnSqlDl, btnSqlDl);
        newBtnSqlDl.addEventListener('click', downloadSqlExcel);
    }
    
    const btnSqlClear = $('btn-sql-clear');
    if (btnSqlClear) {
        const newBtnSqlClear = btnSqlClear.cloneNode(true);
        btnSqlClear.parentNode.replaceChild(newBtnSqlClear, btnSqlClear);
        newBtnSqlClear.addEventListener('click', clearSqlDownload);
    }
}

async function runSqlDownload() {
    const query = $('sql-query-input').value.trim();
    if (!query || !S.activeServer) return;

    const btn = $('btn-sql-run');
    btn.disabled = true;
    btn.textContent = 'Running...';
    $('sql-status-msg').textContent = 'Executing query...';
    $('sql-status-msg').className = 'sql-status-msg';

    try {
        const res = await api().execute_sql_download(S.activeServer.id, query);
        if (res && res.ok) {
            window.lastSqlDownloadCsv = formatAsCsv(res.columns, res.rows);
            window.lastSqlDownloadHint = 'Query_Results_' + S.activeServer.alias.replace(/\s+/g, '_') + '.csv';
            renderSqlTable(res.columns, res.rows);
            $('sql-row-count').textContent = res.row_count + ' rows';
            $('sql-status-msg').textContent = 'Success';
            $('sql-status-msg').className = 'sql-status-msg success';
            $('btn-sql-download').disabled = false;
        } else {
            $('sql-status-msg').textContent = res.error || 'Query failed';
            $('sql-status-msg').className = 'sql-status-msg error';
            $('sql-row-count').textContent = '';
            $('btn-sql-download').disabled = true;
        }
    } catch (err) {
        $('sql-status-msg').textContent = 'System error';
        $('sql-status-msg').className = 'sql-status-msg error';
    } finally {
        btn.disabled = false;
        btn.textContent = '▶ Run Query';
    }
}

function formatAsCsv(columns, rows) {
    const escapeCsv = val => {
        if (val === null || val === undefined) return '';
        let str = String(val);
        if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
            str = '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    };
    let csv = columns.map(escapeCsv).join(',') + '\n';
    rows.forEach(row => {
        csv += row.map(escapeCsv).join(',') + '\n';
    });
    return csv;
}

function renderSqlTable(columns, rows) {
    $('sql-result-empty').classList.add('hidden');
    $('sql-result-table-wrap').classList.remove('hidden');
    
    const table = $('sql-result-table');
    table.innerHTML = '';
    
    const thead = document.createElement('thead');
    const thr = document.createElement('tr');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        thr.appendChild(th);
    });
    thead.appendChild(thr);
    table.appendChild(thead);
    
    const tbody = document.createElement('tbody');
    rows.forEach(row => {
        const tr = document.createElement('tr');
        row.forEach(cell => {
            const td = document.createElement('td');
            td.textContent = cell;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
}

async function downloadSqlExcel() {
    if (!window.lastSqlDownloadCsv) return;
    const btn = $('btn-sql-download');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
        const res = await api().save_csv_file(window.lastSqlDownloadHint, window.lastSqlDownloadCsv);
        if (res && res.ok) {
            toast('Results saved to ' + res.path, 'success');
        } else if (res && !res.cancelled) {
            toast('Failed to save file: ' + res.error, 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '⬇ Download Excel';
    }
}

function clearSqlDownload() {
    $('sql-query-input').value = '';
    $('sql-result-table').innerHTML = '';
    $('sql-result-table-wrap').classList.add('hidden');
    $('sql-result-empty').classList.remove('hidden');
    $('sql-status-msg').textContent = '';
    $('sql-row-count').textContent = '';
    $('btn-sql-run').disabled = true;
    $('btn-sql-download').disabled = true;
    window.lastSqlDownloadCsv = null;
}

// SQL Update Templates

async function loadSqlTemplates() {
    try {
        const res = await api().get_sql_templates();
        if (res && res.ok) {
            sqlTemplates = res.templates || [];
            renderSqlTemplatesList();
            
            // Check admin status to show new template button
            const isAdmin = String(S.role || '').trim().toLowerCase() === 'admin';
            const btnNewTpl = $('btn-new-sql-template');
            if (btnNewTpl) {
                if (isAdmin) btnNewTpl.classList.remove('hidden');
                else btnNewTpl.classList.add('hidden');
            }
            
            // Re-select active template if still exists
            if (activeSqlTemplateId) {
                const stillExists = sqlTemplates.find(t => t.id === activeSqlTemplateId);
                if (!stillExists) {
                    activeSqlTemplateId = null;
                    $('sql-template-empty').classList.remove('hidden');
                    $('sql-template-editor').classList.add('hidden');
                    $('sql-template-executor').classList.add('hidden');
                } else {
                    openTemplateExecutor(stillExists);
                }
            } else {
                $('sql-template-empty').classList.remove('hidden');
                $('sql-template-editor').classList.add('hidden');
                $('sql-template-executor').classList.add('hidden');
            }
        }
    } catch (err) {
        console.error('Error loading SQL templates:', err);
    }
}

function renderSqlTemplatesList() {
    const list = $('sql-templates-list');
    if (!list) return;
    list.innerHTML = '';
    
    if (!sqlTemplates.length) {
        list.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: var(--text-3); font-size: 12px;">No templates available</div>';
        return;
    }
    
    sqlTemplates.forEach(t => {
        const item = document.createElement('div');
        item.className = 'sql-template-item' + (activeSqlTemplateId === t.id ? ' active' : '');
        item.innerHTML = `
            <div class="tpl-name">${t.name}</div>
            <div class="tpl-table">${t.target_table}</div>
        `;
        item.addEventListener('click', () => openTemplateExecutor(t));
        list.appendChild(item);
    });
}

function openTemplateEditor(template) {
    activeSqlTemplateId = template ? template.id : null;
    renderSqlTemplatesList(); // Remove active state
    
    $('sql-template-empty').classList.add('hidden');
    $('sql-template-executor').classList.add('hidden');
    $('sql-template-editor').classList.remove('hidden');
    
    $('template-editor-title').textContent = template ? 'Edit Template' : 'Create Template';
    $('tpl-inp-name').value = template ? template.name : '';
    $('tpl-inp-table').value = template ? template.target_table : '';
    $('tpl-inp-set').value = template ? template.set_clause_template : '';
    $('tpl-inp-where').value = template ? template.where_clause_template : '';
}

function closeTemplateEditor() {
    $('sql-template-editor').classList.add('hidden');
    activeSqlTemplateId = null;
    loadSqlTemplates();
}

async function saveSqlTemplate() {
    const name = $('tpl-inp-name').value.trim();
    const table = $('tpl-inp-table').value.trim();
    const setClause = $('tpl-inp-set').value.trim();
    const whereClause = $('tpl-inp-where').value.trim();
    
    if (!name || !table || !setClause || !whereClause) {
        toast('All fields are required.', 'warning');
        return;
    }
    
    const btn = $('btn-save-template');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    
    try {
        let res;
        if (activeSqlTemplateId) {
            res = await api().edit_sql_template(activeSqlTemplateId, name, table, setClause, whereClause);
        } else {
            res = await api().add_sql_template(name, table, setClause, whereClause);
        }
        if (res && res.ok) {
            toast('Template saved successfully.', 'success');
            sqlTemplates = res.templates || [];
            closeTemplateEditor();
        } else {
            toast('Error: ' + (res.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        toast('System error.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Template';
    }
}

function openTemplateExecutor(template) {
    activeSqlTemplateId = template.id;
    renderSqlTemplatesList();
    
    $('sql-template-empty').classList.add('hidden');
    $('sql-template-editor').classList.add('hidden');
    $('sql-template-executor').classList.remove('hidden');
    
    $('exec-title').textContent = template.name;
    $('exec-target-table').textContent = template.target_table;
    
    const placeholders = new Set();
    const regex = /\{([^}]+)\}/g;
    let match;
    while ((match = regex.exec(template.set_clause_template)) !== null) placeholders.add(match[1]);
    while ((match = regex.exec(template.where_clause_template)) !== null) placeholders.add(match[1]);
    
    const container = $('exec-inputs-container');
    container.innerHTML = '';
    
    placeholders.forEach(ph => {
        const group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML = `
            <label>Input for {${ph}}</label>
            <input type="text" id="exec-inp-dyn-${ph}" data-placeholder="${ph}" class="form-input code-font" placeholder="Value for {${ph}}">
        `;
        container.appendChild(group);
        const inp = group.querySelector('input');
        inp.addEventListener('input', updateSqlPreview);
    });
    
    if (placeholders.size === 0) {
        container.innerHTML = '<div style="font-size: 13px; color: var(--text-2);">No placeholders found in this template.</div>';
    }
    
    $('exec-status-msg').textContent = '';
    
    // Check if admin to show edit/delete buttons
    const isAdmin = String(S.role || '').trim().toLowerCase() === 'admin';
    const btnDel = $('btn-delete-template');
    const btnEdit = $('btn-edit-template');
    if (btnDel) {
        if (isAdmin) btnDel.classList.remove('hidden');
        else btnDel.classList.add('hidden');
    }
    if (btnEdit) {
        if (isAdmin) btnEdit.classList.remove('hidden');
        else btnEdit.classList.add('hidden');
    }
    
    updateSqlPreview();
}

async function deleteSqlTemplate() {
    if (!activeSqlTemplateId) return;
    
    if (!confirm('Are you sure you want to delete this template?')) return;
    
    try {
        const res = await api().delete_sql_template(activeSqlTemplateId);
        if (res && res.ok) {
            toast('Template deleted.', 'success');
            activeSqlTemplateId = null;
            loadSqlTemplates();
        } else {
            toast('Error: ' + (res.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        toast('System error.', 'error');
    }
}

function updateSqlPreview() {
    const template = sqlTemplates.find(t => t.id === activeSqlTemplateId);
    if (!template) return;
    
    let finalSet = template.set_clause_template;
    let finalWhere = template.where_clause_template;
    
    const inputs = document.querySelectorAll('#exec-inputs-container input');
    inputs.forEach(inp => {
        const ph = inp.getAttribute('data-placeholder');
        const val = inp.value || `{${ph}}`;
        const regex = new RegExp(`\\{${ph}\\}`, 'g');
        finalSet = finalSet.replace(regex, val);
        finalWhere = finalWhere.replace(regex, val);
    });
    
    const finalSql = `UPDATE ${template.target_table}\nSET ${finalSet}\nWHERE ${finalWhere}`;
    $('exec-sql-preview').textContent = finalSql;
}

async function executeSqlUpdate() {
    if (!activeSqlTemplateId || !S.activeServer) return;
    
    const inputsDict = {};
    const inputs = document.querySelectorAll('#exec-inputs-container input');
    let missing = false;
    inputs.forEach(inp => {
        const val = inp.value.trim();
        if (!val) missing = true;
        inputsDict[inp.getAttribute('data-placeholder')] = val;
    });
    
    if (missing) {
        $('exec-status-msg').textContent = 'Please provide values for all placeholders.';
        $('exec-status-msg').style.color = 'var(--danger)';
        return;
    }
    
    const btn = $('btn-run-update');
    btn.disabled = true;
    btn.textContent = 'Executing...';
    $('exec-status-msg').textContent = '';
    
    try {
        const res = await api().execute_sql_update(S.activeServer.id, activeSqlTemplateId, inputsDict);
        if (res && res.ok) {
            $('exec-status-msg').textContent = res.message;
            $('exec-status-msg').style.color = 'var(--success)';
            toast('Update executed successfully.', 'success');
        } else {
            $('exec-status-msg').textContent = res.error || 'Failed to execute update.';
            $('exec-status-msg').style.color = 'var(--danger)';
        }
    } catch (err) {
        $('exec-status-msg').textContent = 'System error.';
        $('exec-status-msg').style.color = 'var(--danger)';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Execute Update';
    }
}

