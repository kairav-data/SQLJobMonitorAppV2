/* Projects and Pipeline Logic */
console.log('Projects Logic Loaded');

function canEditPipeline() {
    if (typeof isAdmin === 'function') return isAdmin();
    return String(S.role || '').trim().toLowerCase() === 'admin';
}

function getProjectAssignedUsers(project) {
    return Array.isArray(project && project.assigned_users) ? project.assigned_users : [];
}

function getProjectAccessSummary(project) {
    const users = getProjectAssignedUsers(project);
    if (!users.length) return 'No users assigned';
    return users.map(user => user.username).join(', ');
}

async function runPipelineJob(jobName) {
    if (!S.activeServer) return;

    showConfirm('Run Job', `Start SQL Agent job:\n\n"${jobName}"?`, async () => {
        const res = await api().run_job(S.activeServer.id, jobName);
        if (res && res.ok) {
            toast(res.message, 'success');
            setTimeout(loadJobs, 2500);
        } else {
            toast('Failed: ' + (res ? res.message : 'Unknown error'), 'error');
        }
    }, 'Run', 'primary');
}

function projectSnapshot(projects) {
    try {
        return JSON.stringify(Array.isArray(projects) ? projects : []);
    } catch (err) {
        console.warn('Unable to serialize project state:', err);
        return '';
    }
}

function setProjectsState(projects) {
    S.projects = Array.isArray(projects) ? projects : [];
    S.projectsSnapshot = projectSnapshot(S.projects);
}

function findProject(projectId, projects = S.projects) {
    return (projects || []).find(project => project.id === projectId) || null;
}

function updateSavePipelineButton() {
    const btn = $('btn-save-pipeline');
    if (btn) {
        btn.disabled = !canEditPipeline() || !S.activeProject || S.pipelineSaveInFlight;
        if (S.pipelineSaveInFlight) {
            btn.textContent = 'Saving...';
        } else {
            btn.textContent = S.pipelineDirty ? 'Save Pipeline*' : 'Save Pipeline';
        }
    }
    if (typeof updatePipelineRunButton === 'function') updatePipelineRunButton();
}

function clearPipelineSaveTimer() {
    clearTimeout(S.pipelineSaveTimer);
    S.pipelineSaveTimer = null;
}

function queuePipelineSave() {
    if (!canEditPipeline() || !S.activeProject) return;
    clearPipelineSaveTimer();
    S.pipelineSaveTimer = setTimeout(() => savePipeline({ silent: true }), 800);
}

function markPipelineDirty() {
    if (!canEditPipeline() || !S.activeProject) return;
    S.pipelineDirty = true;
    updateSavePipelineButton();
}

function getAutoRoutedEdge(sX, sY, sW, sH, tX, tY, tW, tH) {
    const sCx = sX + sW / 2;
    const sCy = sY + sH / 2;
    const tCx = tX + tW / 2;
    const tCy = tY + tH / 2;

    const dx = tCx - sCx;
    const dy = tCy - sCy;

    let x1, y1, x2, y2, isHorizontal;

    if (Math.abs(dx) > Math.abs(dy)) {
        isHorizontal = true;
        y1 = sCy;
        y2 = tCy;
        if (dx > 0) {
            x1 = sX + sW;
            x2 = tX;
        } else {
            x1 = sX;
            x2 = tX + tW;
        }
    } else {
        isHorizontal = false;
        x1 = sCx;
        x2 = tCx;
        if (dy > 0) {
            y1 = sY + sH;
            y2 = tY;
        } else {
            y1 = sY;
            y2 = tY + tH;
        }
    }

    if (isHorizontal) {
        const midX = (x1 + x2) / 2;
        return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
    } else {
        const midY = (y1 + y2) / 2;
        return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
    }
}

function stopProjectSync() {
    if (S.projectsSyncTimer) clearInterval(S.projectsSyncTimer);
    S.projectsSyncTimer = null;
}

function startProjectSync() {
    stopProjectSync();
    S.projectsSyncTimer = setInterval(() => syncProjects({ silent: true }), 4000);
}

function applyProjectsFromServer(projects, options = {}) {
    const activeProjectId = S.activeProject ? S.activeProject.id : null;
    setProjectsState(projects);

    if (!activeProjectId) {
        if (S.currentView === 'projects') renderProjects();
        return;
    }

    const nextActiveProject = findProject(activeProjectId);
    if (!nextActiveProject) {
        S.activeProject = null;
        S.pipelineDirty = false;
        clearPipelineSaveTimer();
        cancelEdgeDraw();

        const listView = $('projects-list-view');
        const pipeView = $('pipeline-view');
        if (listView) listView.style.display = 'flex';
        if (pipeView) pipeView.classList.add('hidden');

        renderProjects();
        updateSavePipelineButton();

        if (!options.silent && typeof toast === 'function') {
            toast('The selected project is no longer available.', 'warning');
        }
        return;
    }

    S.activeProject = nextActiveProject;
    if (S.currentView === 'projects') {
        const title = $('pipeline-title');
        if (title) title.textContent = nextActiveProject.name;
        updateAvailableJobsList();
        renderPipeline();
        updateSavePipelineButton();
    }
}

async function syncProjects(options = {}) {
    if (S.currentView !== 'projects' || !S.activeServer) return;
    if (canEditPipeline() && (S.isDraggingNode || S.isDrawingEdge || S.pipelineDirty || S.pipelineSaveInFlight)) {
        return;
    }

    try {
        const res = await api().get_projects(S.activeServer.id);
        if (!res || !res.ok) return;

        const nextSnapshot = projectSnapshot(res.projects);
        if (nextSnapshot === S.projectsSnapshot) return;
        applyProjectsFromServer(res.projects, options);
    } catch (err) {
        console.error('Error syncing projects:', err);
    }
}

function initProjects() {
    console.log('Initializing Project Listeners...');
    const tabJobs = $('tab-jobs');
    const tabProjects = $('tab-projects');
    const tabSqlDownload = $('tab-sql-operations');

    if (tabJobs) tabJobs.addEventListener('click', () => switchTab('jobs'));
    if (tabProjects) tabProjects.addEventListener('click', () => switchTab('projects'));
    if (tabSqlDownload) tabSqlDownload.addEventListener('click', () => switchTab('sql-operations'));

    const btnCreate = $('btn-create-project');
    if (btnCreate) btnCreate.addEventListener('click', openCreateProject);

    const btnBack = $('btn-back-projects');
    if (btnBack) btnBack.addEventListener('click', closePipeline);

    const btnSave = $('btn-save-pipeline');
    if (btnSave) btnSave.addEventListener('click', () => savePipeline({ silent: false }));

    const btnRun = $('btn-run-pipeline');
    if (btnRun) btnRun.addEventListener('click', togglePipelineRun);

    S.pipelineZoom = 1;
    const btnZoomIn = $('btn-zoom-in');
    const btnZoomOut = $('btn-zoom-out');
    const canvasArea = $('pipeline-canvas');
    if (btnZoomIn) btnZoomIn.addEventListener('click', () => setPipelineZoom(S.pipelineZoom + 0.1));
    if (btnZoomOut) btnZoomOut.addEventListener('click', () => setPipelineZoom(S.pipelineZoom - 0.1));
    if (canvasArea) {
        canvasArea.addEventListener('wheel', e => {
            if (e.ctrlKey) {
                e.preventDefault();
                setPipelineZoom(S.pipelineZoom - (e.deltaY > 0 ? 0.1 : -0.1));
            }
        });
    }

    const resizer = $('jobs-panel-resizer');
    if (resizer) {
        resizer.addEventListener('mousedown', e => {
            S.isResizingPanel = true;
            S.resizeStartX = e.clientX;
            const panel = $('pipeline-jobs-panel');
            S.resizeStartWidth = panel ? panel.offsetWidth : 280;
            resizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
        });
    }

    document.addEventListener('mousemove', e => {
        if (S.isDraggingNode) handleNodeDrag(e);
        if (S.isDrawingEdge) handleEdgeDrag(e);
        if (S.isResizingPanel) {
            const panel = $('pipeline-jobs-panel');
            if (panel) {
                const diff = e.clientX - S.resizeStartX;
                const newWidth = Math.max(200, Math.min(800, S.resizeStartWidth + diff));
                panel.style.width = newWidth + 'px';
            }
        }
    });

    document.addEventListener('mouseup', e => {
        if (S.isDraggingNode) endNodeDrag();
        if (S.isDrawingEdge && !e.target.closest('.node-port')) cancelEdgeDraw();
        if (S.isResizingPanel) {
            S.isResizingPanel = false;
            if (resizer) resizer.classList.remove('dragging');
            document.body.style.cursor = '';
        }
    });

    // Init SQL Download panel
    if (typeof initSqlDownload === 'function') initSqlOperations();
}

function switchTab(tab) {
    S.currentView = tab;
    const tJobs = $('tab-jobs');
    const tProjs = $('tab-projects');
    const tSqlDl = $('tab-sql-operations');
    if (tJobs) tJobs.classList.toggle('active', tab === 'jobs');
    if (tProjs) tProjs.classList.toggle('active', tab === 'projects');
    if (tSqlDl) tSqlDl.classList.toggle('active', tab === 'sql-operations');

    const vJobs = $('view-jobs');
    const vProjs = $('view-projects');
    const vSqlDl = $('view-sql-operations');

    // Hide all panels first
    if (vJobs) vJobs.style.display = 'none';
    if (vProjs) vProjs.classList.add('hidden');
    if (vSqlDl) vSqlDl.classList.add('hidden');

    if (tab === 'jobs') {
        stopProjectSync();
        if (vJobs) vJobs.style.display = 'flex';
        return;
    }

    if (tab === 'projects') {
        if (vProjs) vProjs.classList.remove('hidden');
        startProjectSync();
        loadProjects();
        return;
    }

    if (tab === 'sql-operations') {
        stopProjectSync();
        if (vSqlDl) vSqlDl.classList.remove('hidden');
        return;
    }
}

async function loadProjects() {
    if (!S.activeServer) return;
    try {
        const res = await api().get_projects(S.activeServer.id);
        if (res && res.ok) {
            applyProjectsFromServer(res.projects, { silent: true });
            if (!canEditPipeline() && !S.activeProject) {
                const projects = Array.isArray(res.projects) ? res.projects : [];
                const preferredProject =
                    projects.find(project => project.id === S.defaultProjectId) ||
                    (projects.length === 1 ? projects[0] : null);
                if (preferredProject) openPipeline(preferredProject);
            }
        }
    } catch (err) {
        console.error('Error loading projects:', err);
    }
}

function renderProjects() {
    const grid = $('projects-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!S.projects || !S.projects.length) {
        grid.innerHTML = '<div class="empty-state" style="padding:40px; text-align:center; color:var(--text-3);"><p>No projects found. Create one to get started.</p></div>';
        return;
    }

    S.projects.forEach(project => {
        const card = el('div', 'project-card');
        card.innerHTML = `
            <div class="project-title">${project.name}</div>
            <div class="project-desc">${project.description || 'No description'}</div>
            <div class="project-meta">
                <span>${(project.jobs || []).length} Job(s)</span>
                ${canEditPipeline() ? '<button class="project-del-btn" title="Delete Project">✕</button>' : ''}
            </div>
        `;

        card.addEventListener('click', event => {
            if (event.target.closest('.project-del-btn')) {
                deleteProject(project.id);
                return;
            }
            openPipeline(project);
        });

        grid.appendChild(card);
    });
}

async function deleteProject(projectId) {
    if (!canEditPipeline()) {
        if (typeof toast === 'function') toast('Only admins can delete projects.', 'warning');
        return;
    }
    if (typeof showConfirm !== 'function') return;

    showConfirm('Delete Project', 'Are you sure you want to delete this project?', async () => {
        const res = await api().delete_project(projectId);
        if (res && res.ok) applyProjectsFromServer(res.projects, { silent: true });
    });
}

function openCreateProject() {
    if (!canEditPipeline()) {
        if (typeof toast === 'function') toast('Only admins can create projects.', 'warning');
        return;
    }

    // Set width on the actual modal container
    const mBox = document.getElementById('modal-box');
    if (mBox) {
        mBox.style.width = '460px';
        mBox.style.padding = '24px 32px';
    }

    const box = el('div');
    box.innerHTML = `
    <div class="modal-title" style="margin-bottom: 6px;">Create New Project</div>
    <div class="modal-sub" style="margin-bottom: 24px;">Organize your jobs into a structured pipeline workflow.</div>
    <div class="form-group">
      <label class="form-label">Project Name <span style="color:var(--danger)">*</span></label>
      <input id="cp-name" class="form-input" placeholder="e.g. Nightly ETL Processing" style="width:100%">
    </div>
    <div class="form-group" style="margin-bottom: 28px;">
      <label class="form-label">Description</label>
      <input id="cp-desc" class="form-input" placeholder="Optional description of this project's purpose" style="width:100%">
    </div>
    <div class="modal-footer" style="margin-top: 0;">
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" id="cp-save">Create Project</button>
    </div>`;
    showModal(box);

    document.getElementById('cp-save').addEventListener('click', async () => {
        const name = document.getElementById('cp-name').value.trim();
        const desc = document.getElementById('cp-desc').value.trim();
        if (!name) return;

        const btn = document.getElementById('cp-save');
        btn.disabled = true;
        btn.textContent = 'Creating...';

        const res = await api().add_project(name, desc, S.activeServer.id);
        
        btn.disabled = false;
        btn.textContent = 'Create Project';

        if (res && res.ok) {
            applyProjectsFromServer(res.projects, { silent: true });
            hideModal();
        }
    });
}

function openPipeline(project) {
    S.activeProject = project;
    S.pipelineDirty = false;
    clearPipelineSaveTimer();
    cancelEdgeDraw();

    const listView = $('projects-list-view');
    const pipeView = $('pipeline-view');
    if (listView) listView.style.display = 'none';
    if (pipeView) pipeView.classList.remove('hidden');
    
    const resizer = $('jobs-panel-resizer');
    if (resizer) resizer.classList.remove('hidden');

    const title = $('pipeline-title');
    if (title) title.textContent = project.name;

    setPipelineZoom(1);
    updateAvailableJobsList();
    renderPipeline();
    updateSavePipelineButton();
}

function setPipelineZoom(level) {
    if (level < 0.2) level = 0.2;
    if (level > 3) level = 3;
    S.pipelineZoom = level;
    
    const wrapper = $('pipeline-zoom-wrapper');
    if (wrapper) wrapper.style.transform = `scale(${S.pipelineZoom})`;
    
    const label = $('pipeline-zoom-level');
    if (label) label.textContent = Math.round(S.pipelineZoom * 100) + '%';
}

function closePipeline() {
    S.activeProject = null;
    S.pipelineDirty = false;
    S.pipelineSaveInFlight = false;
    clearPipelineSaveTimer();
    cancelEdgeDraw();

    const listView = $('projects-list-view');
    const pipeView = $('pipeline-view');
    if (listView) listView.style.display = 'flex';
    if (pipeView) pipeView.classList.add('hidden');
    
    const resizer = $('jobs-panel-resizer');
    if (resizer) resizer.classList.add('hidden');

    renderProjects();
    updateSavePipelineButton();
    loadProjects();
}

function updateAvailableJobsList() {
    const container = $('pipeline-available-jobs');
    if (!container) return;
    container.innerHTML = '';

    if (!S.activeProject || !canEditPipeline()) return;

    const usedJobs = new Set(S.activeProject.jobs || []);
    S.jobs.forEach(job => {
        if (usedJobs.has(job.name)) return;

        const item = el('div', 'available-job-item');
        item.textContent = job.name;
        item.title = 'Click to add to canvas';
        item.addEventListener('click', () => addJobToPipeline(job.name));
        container.appendChild(item);
    });
}

function addJobToPipeline(jobName) {
    if (!canEditPipeline()) {
        if (typeof toast === 'function') toast('Only admins can change the pipeline.', 'warning');
        return;
    }
    if (!S.activeProject) return;

    if (!Array.isArray(S.activeProject.jobs)) S.activeProject.jobs = [];
    if (!S.activeProject.nodes || typeof S.activeProject.nodes !== 'object') S.activeProject.nodes = {};
    if (!Array.isArray(S.activeProject.edges)) S.activeProject.edges = [];
    if (S.activeProject.jobs.includes(jobName)) return;

    S.activeProject.jobs.push(jobName);

    const canvasArea = $('pipeline-canvas');
    const x = 50 + (canvasArea ? canvasArea.scrollLeft : 0);
    const y = 50 + (canvasArea ? canvasArea.scrollTop : 0);
    S.activeProject.nodes[jobName] = { x, y };

    updateAvailableJobsList();
    renderPipeline();
    markPipelineDirty();
}

function appendPipelineEdge(svg, edge, project, editable) {
    const sourceNode = project.nodes[edge.source];
    const targetNode = project.nodes[edge.target];
    if (!sourceNode || !targetNode) return;

    const sNodeEl = document.querySelector(`.pipeline-node[data-job="${edge.source}"]`);
    const tNodeEl = document.querySelector(`.pipeline-node[data-job="${edge.target}"]`);
    
    const sWidth = sNodeEl ? sNodeEl.offsetWidth : 180;
    const sHeight = sNodeEl ? sNodeEl.offsetHeight : 86;
    const tWidth = tNodeEl ? tNodeEl.offsetWidth : 180;
    const tHeight = tNodeEl ? tNodeEl.offsetHeight : 86;

    const pathD = getAutoRoutedEdge(sourceNode.x, sourceNode.y, sWidth, sHeight, targetNode.x, targetNode.y, tWidth, tHeight);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('class', 'edge-path');
    path.style.cursor = editable ? 'pointer' : 'default';

    if (editable) {
        path.addEventListener('click', event => {
            event.stopPropagation();
            project.edges = project.edges.filter(existing => existing !== edge);
            renderPipelineEdgesOnly();
            markPipelineDirty();
        });
    }

    const jobInfo = S.jobs.find(job => job.name === edge.source);
    let statusClass = 'Unknown';
    if (jobInfo) statusClass = jobInfo.last_run_status.replace(/\s+/g, '');
    
    path.classList.add('status-' + statusClass);
    path.setAttribute('marker-end', `url(#arrow-${statusClass})`);

    svg.appendChild(path);
}

function renderPipeline() {
    const canvas = $('pipeline-nodes');
    const svg = $('pipeline-svg');
    if (!canvas || !svg) return;

    canvas.innerHTML = '';
    svg.innerHTML = '';

    const project = S.activeProject;
    if (!project) return;

    if (!Array.isArray(project.jobs)) project.jobs = [];
    if (!Array.isArray(project.edges)) project.edges = [];
    if (!project.nodes || typeof project.nodes !== 'object') project.nodes = {};

    const editable = canEditPipeline();

    project.jobs.forEach(jobName => {
        const nodeData = project.nodes[jobName];
        if (!nodeData) return;

        const jobInfo = S.jobs.find(job => job.name === jobName);
        const statusKey = jobInfo ? jobInfo.last_run_status.replace(/\s+/g, '') : 'Unknown';
        const displayStatus = jobInfo ? jobInfo.last_run_status : 'Unknown';

        const fmtDate = d => d ? new Date(d).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'N/A';
        const lastRunStr = jobInfo ? fmtDate(jobInfo.start_execution_date) : 'N/A';
        const nextRunStr = jobInfo ? fmtDate(jobInfo.next_scheduled_run_date) : 'N/A';

        const node = el('div', 'pipeline-node');
        node.style.left = nodeData.x + 'px';
        node.style.top = nodeData.y + 'px';
        if (nodeData.w) node.style.width = nodeData.w + 'px';
        if (nodeData.h) node.style.height = nodeData.h + 'px';
        node.dataset.job = jobName;
        node.innerHTML = `
            ${editable ? '<div class="node-port left" data-port="left"></div><div class="node-port right" data-port="right"></div>' : ''}
            <div class="node-title" title="${jobName}">${jobName}</div>
            <div class="node-status node-${statusKey}">${displayStatus}</div>
            ${editable ? '<button class="delete-node-btn" title="Remove">✕</button>' : ''}
        `;

        node.addEventListener('mousedown', event => {
            if (event.target.closest('.delete-node-btn') || event.target.closest('.node-port')) return;

            const rect = node.getBoundingClientRect();
            if (event.clientX > rect.right - 18 && event.clientY > rect.bottom - 18) return;

            event.preventDefault();
            S.isDraggingNode = true;
            S.dragNode = node;
            S.dragMoved = false;

            S.dragOffset = {
                x: (event.clientX - rect.left) / S.pipelineZoom,
                y: (event.clientY - rect.top) / S.pipelineZoom
            };
            node.classList.add('dragging');
        });

        const ro = new ResizeObserver(() => {
            const newW = node.offsetWidth;
            const newH = node.offsetHeight;
            if (project.nodes[jobName]) {
                const oldW = project.nodes[jobName].w;
                const oldH = project.nodes[jobName].h;
                if (oldW !== newW || oldH !== newH) {
                    project.nodes[jobName].w = newW;
                    project.nodes[jobName].h = newH;
                    renderPipelineEdgesOnly();
                    if (editable && (oldW !== undefined || oldH !== undefined)) {
                        markPipelineDirty();
                    }
                }
            }
        });
        ro.observe(node);

        const deleteButton = node.querySelector('.delete-node-btn');
        if (deleteButton) {
            deleteButton.addEventListener('click', event => {
                event.stopPropagation();
                project.jobs = project.jobs.filter(existingJob => existingJob !== jobName);
                delete project.nodes[jobName];
                project.edges = project.edges.filter(edge => edge.source !== jobName && edge.target !== jobName);
                updateAvailableJobsList();
                renderPipeline();
                markPipelineDirty();
            });
        }

        if (editable) {
            const rightPort = node.querySelector('.node-port.right');
            const leftPort = node.querySelector('.node-port.left');

            if (rightPort) {
                rightPort.addEventListener('mousedown', event => {
                    event.stopPropagation();
                    startEdgeDraw(jobName);
                });
            }

            if (leftPort) {
                leftPort.addEventListener('mouseup', event => {
                    event.stopPropagation();
                    endEdgeDraw(jobName);
                });
                leftPort.addEventListener('click', event => {
                    event.stopPropagation();
                    if (S.isDrawingEdge) endEdgeDraw(jobName);
                });
            }
        }

        canvas.appendChild(node);
    });
}

function handleNodeDrag(event) {
    if (!S.isDraggingNode || !S.dragNode || !S.activeProject) return;
    const canvasArea = $('pipeline-canvas');
    if (!canvasArea) return;

    const parentRect = canvasArea.getBoundingClientRect();
    let nextX = (event.clientX - parentRect.left + canvasArea.scrollLeft) / S.pipelineZoom - S.dragOffset.x;
    let nextY = (event.clientY - parentRect.top + canvasArea.scrollTop) / S.pipelineZoom - S.dragOffset.y;

    if (nextX < 0) nextX = 0;
    if (nextY < 0) nextY = 0;

    const currentX = parseFloat(S.dragNode.style.left || '0');
    const currentY = parseFloat(S.dragNode.style.top || '0');
    if (currentX !== nextX || currentY !== nextY) S.dragMoved = true;

    S.dragNode.style.left = nextX + 'px';
    S.dragNode.style.top = nextY + 'px';

    const jobName = S.dragNode.dataset.job;
    S.activeProject.nodes[jobName] = { x: nextX, y: nextY };
    renderPipelineEdgesOnly();
}

function renderPipelineEdgesOnly() {
    const svg = $('pipeline-svg');
    if (!svg) return;

    svg.innerHTML = `
        <defs>
            <marker id="arrow-Unknown" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
            </marker>
            <marker id="arrow-Failed" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--danger)" />
            </marker>
            <marker id="arrow-Succeeded" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--success)" />
            </marker>
        </defs>
    `;
    const project = S.activeProject;
    if (!project || !Array.isArray(project.edges)) return;

    const editable = canEditPipeline();
    project.edges.forEach(edge => appendPipelineEdge(svg, edge, project, editable));
}

function endNodeDrag() {
    if (S.isDraggingNode && S.dragNode) {
        S.dragNode.classList.remove('dragging');
        if (S.dragMoved) markPipelineDirty();
    }

    S.isDraggingNode = false;
    S.dragNode = null;
    S.dragMoved = false;
}

function startEdgeDraw(sourceJob) {
    if (!canEditPipeline() || !S.activeProject || !S.activeProject.nodes[sourceJob]) return;

    cancelEdgeDraw();
    S.isDrawingEdge = true;
    S.edgeSource = sourceJob;
    S.tempEdgePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    S.tempEdgePath.setAttribute('class', 'temp-edge');

    const sourceNode = S.activeProject.nodes[sourceJob];
    const sNodeEl = document.querySelector(`.pipeline-node[data-job="${sourceJob}"]`);
    const sWidth = sNodeEl ? sNodeEl.offsetWidth : 180;
    const sHeight = sNodeEl ? sNodeEl.offsetHeight : 86;
    
    const x = sourceNode.x + (sWidth / 2);
    const y = sourceNode.y + (sHeight / 2);
    S.tempEdgePath.setAttribute('d', `M ${x} ${y} L ${x} ${y}`);

    const svg = $('pipeline-svg');
    if (svg) svg.appendChild(S.tempEdgePath);
}

function handleEdgeDrag(event) {
    if (!S.isDrawingEdge || !S.edgeSource || !S.tempEdgePath || !S.activeProject) return;

    const sourceNode = S.activeProject.nodes[S.edgeSource];
    const canvasArea = $('pipeline-canvas');
    if (!sourceNode || !canvasArea) return;

    const parentRect = canvasArea.getBoundingClientRect();
    const sNodeEl = document.querySelector(`.pipeline-node[data-job="${S.edgeSource}"]`);
    const sWidth = sNodeEl ? sNodeEl.offsetWidth : 180;
    const sHeight = sNodeEl ? sNodeEl.offsetHeight : 86;
    
    const mouseX = (event.clientX - parentRect.left + canvasArea.scrollLeft) / S.pipelineZoom;
    const mouseY = (event.clientY - parentRect.top + canvasArea.scrollTop) / S.pipelineZoom;

    const pathD = getAutoRoutedEdge(sourceNode.x, sourceNode.y, sWidth, sHeight, mouseX, mouseY, 0, 0);
    S.tempEdgePath.setAttribute('d', pathD);
}

function endEdgeDraw(targetJob) {
    if (!canEditPipeline() || !S.activeProject) {
        cancelEdgeDraw();
        return;
    }

    if (S.isDrawingEdge && S.edgeSource && S.edgeSource !== targetJob) {
        if (!Array.isArray(S.activeProject.edges)) S.activeProject.edges = [];

        const exists = S.activeProject.edges.find(edge => edge.source === S.edgeSource && edge.target === targetJob);
        if (!exists) {
            S.activeProject.edges.push({ source: S.edgeSource, target: targetJob });
            renderPipelineEdgesOnly();
            markPipelineDirty();
        }
    }

    cancelEdgeDraw();
}

function cancelEdgeDraw() {
    S.isDrawingEdge = false;
    S.edgeSource = null;
    if (S.tempEdgePath) {
        S.tempEdgePath.remove();
        S.tempEdgePath = null;
    }
}

async function savePipeline(options = {}) {
    if (!S.activeProject || !canEditPipeline()) {
        updateSavePipelineButton();
        return;
    }
    if (S.pipelineSaveInFlight) return;

    clearPipelineSaveTimer();
    S.pipelineSaveInFlight = true;
    updateSavePipelineButton();

    const project = S.activeProject;
    try {
        const res = await api().update_project_pipeline(
            project.id,
            project.jobs || [],
            project.nodes || {},
            project.edges || []
        );

        if (!res || !res.ok) {
            throw new Error((res && res.error) || 'Unable to save pipeline.');
        }

        S.pipelineDirty = false;
        applyProjectsFromServer(res.projects, { silent: true });
        if (!options.silent && typeof toast === 'function') {
            toast('Pipeline saved.', 'success');
        }
    } catch (err) {
        S.pipelineDirty = true;
        console.error('Error saving pipeline:', err);
        if (typeof toast === 'function') toast('Pipeline save failed.', 'error');
    } finally {
        S.pipelineSaveInFlight = false;
        updateSavePipelineButton();
    }
}

function getProjectAssignedUsers(project) {
    return Array.isArray(project && project.assigned_users) ? project.assigned_users : [];
}

function getProjectAccessSummary(project) {
    const users = getProjectAssignedUsers(project);
    if (!users.length) return 'No users assigned';
    return users.map(user => user.username).join(', ');
}

async function runPipelineJob(jobName) {
    if (!S.activeServer) return;

    showConfirm('Run Job', `Start SQL Agent job:\n\n"${jobName}"?`, async () => {
        const res = await api().run_job(S.activeServer.id, jobName);
        if (res && res.ok) {
            toast(res.message, 'success');
            setTimeout(loadJobs, 2500);
        } else {
            toast('Failed: ' + (res ? res.message : 'Unknown error'), 'error');
        }
    }, 'Run', 'primary');
}

async function loadProjects() {
    if (!S.activeServer) return;
    try {
        const res = await api().get_projects(S.activeServer.id);
        if (res && res.ok) {
            applyProjectsFromServer(res.projects, { silent: true });
            if (!canEditPipeline() && !S.activeProject) {
                const projects = Array.isArray(res.projects) ? res.projects : [];
                const preferredProject =
                    projects.find(project => project.id === S.defaultProjectId) ||
                    (projects.length === 1 ? projects[0] : null);
                if (preferredProject) openPipeline(preferredProject);
            }
        }
    } catch (err) {
        console.error('Error loading projects:', err);
    }
}

function renderProjects() {
    const grid = $('projects-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!S.projects || !S.projects.length) {
        grid.innerHTML = '<div class="empty-state" style="padding:40px; text-align:center; color:var(--text-3);"><p>No projects found. Create one to get started.</p></div>';
        return;
    }

    S.projects.forEach(project => {
        const card = el('div', 'project-card');
        const assignedUsers = getProjectAssignedUsers(project);
        card.innerHTML = `
            <div class="project-title">${project.name}</div>
            <div class="project-desc">${project.description || 'No description'}</div>
            ${canEditPipeline() ? `<div class="project-access-summary" title="${getProjectAccessSummary(project)}">${getProjectAccessSummary(project)}</div>` : ''}
            <div class="project-meta">
                <span>${(project.jobs || []).length} Job(s)</span>
                ${canEditPipeline() ? `<span>${assignedUsers.length} User(s)</span>` : ''}
            </div>
            ${canEditPipeline() ? `
            <div class="project-actions">
                <button class="btn btn-ghost sm project-access-btn" title="Manage Project Access">Access</button>
                <button class="btn btn-danger sm project-del-btn" title="Delete Project">x</button>
            </div>` : ''}
        `;

        card.addEventListener('click', event => {
            if (event.target.closest('.project-access-btn')) {
                openProjectAccess(project);
                return;
            }
            if (event.target.closest('.project-del-btn')) {
                deleteProject(project.id);
                return;
            }
            openPipeline(project);
        });

        grid.appendChild(card);
    });
}

async function openProjectAccess(project) {
    if (!canEditPipeline()) {
        toast('Only admins can change project access.', 'warning');
        return;
    }

    const users = (await api().list_users()).filter(user => user.role !== 'admin');
    const selectedUserIds = new Set((project.assigned_user_ids || []).map(String));
    const rows = users.length
        ? users.map(user => `
            <label class="project-access-row">
                <input type="checkbox" value="${user.id}" ${selectedUserIds.has(String(user.id)) ? 'checked' : ''}>
                <span>${user.username}</span>
                <span class="badge">${user.role}</span>
            </label>
        `).join('')
        : '<div class="empty-state" style="padding:16px 0"><p>No non-admin users available.</p></div>';

    const box = el('div');
    box.innerHTML = `
    <div class="modal-title">Project Access</div>
    <div class="modal-sub">Choose which users can run jobs from <strong>${project.name}</strong>.</div>
    <div id="project-access-list" class="project-access-list">${rows}</div>
    <p id="project-access-msg" style="font-size:12px; min-height:16px; margin-top:10px"></p>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" id="project-access-save">Save Access</button>
    </div>`;
    showModal(box);

    const saveButton = document.getElementById('project-access-save');
    if (!saveButton) return;

    saveButton.addEventListener('click', async () => {
        const ids = Array.from(document.querySelectorAll('#project-access-list input[type="checkbox"]:checked'))
            .map(input => input.value);
        const res = await api().update_project_assignments(project.id, ids);
        if (res && res.ok) {
            applyProjectsFromServer(res.projects, { silent: true });
            hideModal();
            toast(`Access updated for '${project.name}'.`, 'success');
        } else {
            const msg = document.getElementById('project-access-msg');
            if (msg) {
                msg.style.color = 'var(--danger)';
                msg.textContent = (res && res.error) || 'Unable to save project access.';
            }
        }
    });
}

function renderPipeline() {
    const canvas = $('pipeline-nodes');
    const svg = $('pipeline-svg');
    if (!canvas || !svg) return;

    canvas.innerHTML = '';
    svg.innerHTML = `
        <defs>
            <marker id="arrow-Unknown" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
            </marker>
            <marker id="arrow-Failed" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--danger)" />
            </marker>
            <marker id="arrow-Succeeded" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--success)" />
            </marker>
        </defs>
    `;

    const project = S.activeProject;
    if (!project) return;

    if (!Array.isArray(project.jobs)) project.jobs = [];
    if (!Array.isArray(project.edges)) project.edges = [];
    if (!project.nodes || typeof project.nodes !== 'object') project.nodes = {};

    const editable = canEditPipeline();

    project.jobs.forEach(jobName => {
        const nodeData = project.nodes[jobName];
        if (!nodeData) return;

        const jobInfo = S.jobs.find(job => job.name === jobName);
        const statusKey = jobInfo ? jobInfo.last_run_status.replace(/\s+/g, '') : 'Unknown';
        const displayStatus = jobInfo ? jobInfo.last_run_status : 'Unknown';

        const fmtDate = d => d ? new Date(d).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'N/A';
        const lastRunStr = jobInfo ? fmtDate(jobInfo.start_execution_date) : 'N/A';
        const nextRunStr = jobInfo ? fmtDate(jobInfo.next_scheduled_run_date) : 'N/A';

        const node = el('div', 'pipeline-node');
        node.style.left = nodeData.x + 'px';
        node.style.top = nodeData.y + 'px';
        if (nodeData.w) node.style.width = nodeData.w + 'px';
        if (nodeData.h) node.style.height = nodeData.h + 'px';
        node.dataset.job = jobName;

        const iconMap = { Succeeded: '✓', Failed: '✗', InProgress: '↻', Unknown: '?' };
        const icon = iconMap[statusKey] || '?';

        node.innerHTML = `
            ${editable ? `
                <div class="node-port top"    data-port="top"></div>
                <div class="node-port bottom" data-port="bottom"></div>
                <div class="node-port left"   data-port="left"></div>
                <div class="node-port right"  data-port="right"></div>
            ` : ''}
            ${editable ? '<button class="delete-node-btn" title="Remove">✕</button>' : ''}
            <div class="node-header node-header-${statusKey}">
                <div class="node-header-icon node-header-icon-${statusKey}">${icon}</div>
                <div class="node-title" title="${jobName}">${jobName}</div>
                <div class="node-status node-${statusKey}">${displayStatus}</div>
            </div>
            <div class="node-body">
                <div class="node-dates">
                    <div class="node-date"><span>Last</span><span class="node-date-val">${lastRunStr}</span></div>
                    <div class="node-date"><span>Next</span><span class="node-date-val">${nextRunStr}</span></div>
                </div>
            </div>
            <div class="node-actions">
                <button class="node-action-btn node-run-btn" ${!canOperateJobs() || !jobInfo || !jobInfo.enabled ? 'disabled' : ''}>▶ Run</button>
                <button class="node-action-btn node-history-btn" ${!jobInfo ? 'disabled' : ''}>⏱ History</button>
            </div>
        `;

        node.addEventListener('mousedown', event => {
            if (
                event.target.closest('.delete-node-btn')
                || event.target.closest('.node-port')
                || event.target.closest('.node-action-btn')
            ) return;

            const rect = node.getBoundingClientRect();
            // Prevent dragging if clicking on the bottom-right resize handle
            if (event.clientX > rect.right - 18 && event.clientY > rect.bottom - 18) {
                return;
            }

            event.preventDefault();
            S.isDraggingNode = true;
            S.dragNode = node;
            S.dragMoved = false;

            S.dragOffset = {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top
            };
            node.classList.add('dragging');
        });

        const deleteButton = node.querySelector('.delete-node-btn');
        if (deleteButton) {
            deleteButton.addEventListener('click', event => {
                event.stopPropagation();
                project.jobs = project.jobs.filter(existingJob => existingJob !== jobName);
                delete project.nodes[jobName];
                project.edges = project.edges.filter(edge => edge.source !== jobName && edge.target !== jobName);
                updateAvailableJobsList();
                renderPipeline();
                markPipelineDirty();
            });
        }

        const runButton = node.querySelector('.node-run-btn');
        if (runButton) {
            runButton.addEventListener('click', event => {
                event.stopPropagation();
                if (!runButton.disabled) runPipelineJob(jobName);
            });
        }

        const historyButton = node.querySelector('.node-history-btn');
        if (historyButton) {
            historyButton.addEventListener('click', event => {
                event.stopPropagation();
                if (!historyButton.disabled) openHistory(jobInfo || { name: jobName });
            });
        }

        if (editable) {
            node.querySelectorAll('.node-port').forEach(port => {
                port.addEventListener('mousedown', event => {
                    event.stopPropagation();
                    startEdgeDraw(jobName);
                });
                port.addEventListener('mouseup', event => {
                    event.stopPropagation();
                    endEdgeDraw(jobName);
                });
                port.addEventListener('click', event => {
                    event.stopPropagation();
                    if (S.isDrawingEdge) endEdgeDraw(jobName);
                });
            });
        }

        canvas.appendChild(node);
    });

    // Render edges after nodes are in DOM
    project.edges.forEach(edge => appendPipelineEdge(svg, edge, project, editable));
}

// --- SEQUENTIAL PIPELINE EXECUTION ---

function computeTopologicalSort(project) {
    const jobs = project.jobs || [];
    const edges = project.edges || [];
    const adj = {};
    const inDegree = {};
    
    jobs.forEach(j => {
        adj[j] = [];
        inDegree[j] = 0;
    });
    
    edges.forEach(e => {
        if (adj[e.source] && inDegree[e.target] !== undefined) {
            adj[e.source].push(e.target);
            inDegree[e.target]++;
        }
    });
    
    const queue = [];
    jobs.forEach(j => {
        if (inDegree[j] === 0) queue.push(j);
    });
    
    const sorted = [];
    while (queue.length > 0) {
        const u = queue.shift();
        sorted.push(u);
        adj[u].forEach(v => {
            inDegree[v]--;
            if (inDegree[v] === 0) queue.push(v);
        });
    }
    
    if (sorted.length !== jobs.length) {
        return null; // Cycle detected
    }
    return sorted;
}

function togglePipelineRun() {
    if (S.pipelineIsRunning) {
        if (typeof showConfirm === 'function') {
            showConfirm(
                'Halt Pipeline Execution?',
                'This will stop the automated sequence. The currently running job will finish, but no further jobs will be triggered.',
                stopPipeline,
                'Stop Pipeline',
                'danger'
            );
        } else {
            stopPipeline();
        }
    } else {
        if (!S.activeProject || !canOperateJobs()) return;
        const sorted = computeTopologicalSort(S.activeProject);
        if (!sorted) {
            toast('Cannot run pipeline: circular dependency detected.', 'error');
            return;
        }
        if (sorted.length === 0) {
            toast('Pipeline is empty.', 'warning');
            return;
        }
        
        if (typeof showConfirm === 'function') {
            showConfirm(
                'Execute Pipeline Sequence',
                `Are you sure you want to run <strong>${sorted.length}</strong> jobs sequentially?<br><br>The application will automatically orchestrate the execution and trigger the next job when the current one succeeds.`,
                () => { startPipeline(sorted); },
                'Start Sequence',
                'primary'
            );
        } else {
            startPipeline(sorted);
        }
    }
}

function startPipeline(preSorted = null) {
    if (!S.activeProject || !canOperateJobs()) return;
    const sorted = preSorted || computeTopologicalSort(S.activeProject);
    if (!sorted || sorted.length === 0) return;
    
    S.pipelineQueue = sorted;
    S.pipelineActiveJob = null;
    S.pipelineIsRunning = true;
    updatePipelineRunButton();
    triggerNextPipelineJob();
}

function stopPipeline() {
    S.pipelineIsRunning = false;
    S.pipelineQueue = [];
    S.pipelineActiveJob = null;
    updatePipelineRunButton();
    renderPipeline(); 
    toast('Pipeline execution stopped.', 'info');
}

function updatePipelineRunButton() {
    const btn = $('btn-run-pipeline');
    if (!btn) return;
    
    if (!canOperateJobs() || !S.activeProject || !S.activeProject.jobs || S.activeProject.jobs.length === 0) {
        btn.classList.add('hidden');
        return;
    }
    
    btn.classList.remove('hidden');
    if (S.pipelineIsRunning) {
        btn.textContent = '■ Stop Pipeline';
        btn.style.backgroundColor = 'var(--danger)';
        btn.style.borderColor = 'var(--danger)';
    } else {
        btn.textContent = '▶ Run Pipeline';
        btn.style.backgroundColor = 'var(--success)';
        btn.style.borderColor = 'var(--success)';
    }
}

async function triggerNextPipelineJob() {
    if (!S.pipelineIsRunning) return;
    
    if (S.pipelineQueue.length === 0) {
        S.pipelineIsRunning = false;
        S.pipelineActiveJob = null;
        updatePipelineRunButton();
        renderPipeline();
        toast('Pipeline execution completed successfully!', 'success');
        return;
    }
    
    const nextJob = S.pipelineQueue.shift();
    S.pipelineActiveJob = nextJob;
    S.pipelineJobStartTime = new Date().getTime();
    renderPipeline(); 
    
    toast(`Pipeline: Starting ${nextJob}...`, 'info');
    const res = await api().run_job(S.activeServer.id, nextJob);
    if (!res || !res.ok) {
        toast(`Pipeline halted: Failed to start ${nextJob}. ${res ? res.message : ''}`, 'error');
        stopPipeline();
    } else {
        setTimeout(() => { if (typeof loadJobs === 'function') loadJobs(); }, 1000);
    }
}

function checkPipelineQueue() {
    if (!S.pipelineIsRunning || !S.pipelineActiveJob) return;
    
    const jobInfo = (S.jobs || []).find(j => j.name === S.pipelineActiveJob);
    if (!jobInfo) return; 
    
    const jobStartMs = jobInfo.start_execution_date ? new Date(jobInfo.start_execution_date).getTime() : 0;
    const status = jobInfo.last_run_status.replace(/\s+/g, '');
    
    if (status === 'Succeeded') {
        if (jobStartMs < (S.pipelineJobStartTime || 0) - 5000) {
            return; 
        }
        triggerNextPipelineJob();
    } else if (status === 'Failed' || status === 'Canceled') {
        if (jobStartMs < (S.pipelineJobStartTime || 0) - 5000) {
            return; 
        }
        toast(`Pipeline halted: ${S.pipelineActiveJob} ${status}.`, 'error');
        stopPipeline();
    }
}
