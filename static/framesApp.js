const FramesApp = (() => {
    function getVpsUrl() { return localStorage.getItem('vps_url') || ''; }
    function getVpsPassword() { return sessionStorage.getItem('vps_password') || ''; }
    function authHeaders(extra = {}) {
        return { ...extra, 'x-password': getVpsPassword() };
    }
    let isInitialized = false;

    const state = {
        urls: [], imagesMeta: [], total: 0, idx: 0,
        playInterval: null, isPlaying: false,
        currentFolder: null, autoRefresh: null,
        loading: true, viewInitialized: false, restoreView: null,
        error: null, fps: 12, lastActivityAt: Date.now()
    };
    const els = {};
    const storageKey = 'framesViewerState';
    const $ = id => document.getElementById(id);

    // ── Persistence ──
    function readSavedState() {
        try { const r = localStorage.getItem(storageKey); return r ? JSON.parse(r) : { folder: null, frames: {}, views: {} }; }
        catch { return { folder: null, frames: {}, views: {} }; }
    }
    function writeSavedState(next) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { }
    }
    function saveViewState() {
        if (!state.currentFolder) return;
        const saved = readSavedState();
        saved.folder = state.currentFolder;
        saved.views = saved.views || {};
        saved.views[state.currentFolder] = { scale: view.scale, ox: view.ox, oy: view.oy };
        writeSavedState(saved);
    }

    // ── Loading state ──
    function setLoading(on) {
        state.loading = !!on;
        if (on) {
            window.__setFramesLoading(true);
            syncControlStates();
        } else {
            setTimeout(() => {
                state.loading = false;
                window.__setFramesLoading(false);
                syncControlStates();
            }, 1000);
        }
    }

    // ── Element binding ──
    function bindElements() {
        const ids = ['frames-status-msg', 'mainImage', 'controlsRow', 'sliderWrap', 'slider',
            'counter', 'fileName', 'progressWrap', 'progressBar', 'folderBtn', 'folderName',
            'dropdownMenu', 'playBtn', 'fpsWrap', 'fpsBtn', 'fpsMenu', 'fpsLabel',
            'fileBtn', 'fileDropdownMenu', 'downloadItem', 'prevBtn', 'nextBtn'];
        ids.forEach(k => {
            const key = k.replace(/-/g, '');
            els[key] = $(k);
        });
        els.statusmsg = $('frames-status-msg');
        const fpsBtnFps = parseInt(els.fpsBtn?.dataset.fps || '12', 10);
        if (Number.isFinite(fpsBtnFps)) state.fps = fpsBtnFps;
        updateSidebarFpsActive(state.fps);
    }

    // ── FPS ──
    function updateSidebarFpsActive(next) {
        document.querySelectorAll('.sidebar-fps-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.fps === String(next));
        });
    }
    function setFps(next) {
        if (!Number.isFinite(next)) return;
        state.fps = next;
        if (els.fpsLabel) els.fpsLabel.textContent = String(next);
        if (els.fpsBtn) els.fpsBtn.dataset.fps = String(next);
        els.fpsMenu?.querySelectorAll('.file-dropdown-item').forEach(opt => {
            opt.classList.toggle('active', opt.dataset.fps === String(next));
        });
        updateSidebarFpsActive(next);
        if (state.isPlaying) { stopPlay(); startPlay(); }
    }

    // ── Control state sync ──
    function formatCounter(current, total) {
        const d = Math.max(1, String(total).length);
        return String(current).padStart(d, '0') + ' / ' + String(total).padStart(d, '0');
    }
    function syncControlStates() {
        const isReady = !state.loading && state.total > 0 && !state.error;
        document.body.classList.toggle('frames-dim', !isReady);
        document.body.classList.toggle('frames-menu-disabled', !isReady);
        window.__framesMenuDisabled = !isReady;
        els.folderBtn.disabled = state.loading;
        els.fileBtn.disabled = !isReady;
        els.slider.disabled = !isReady;
        els.fpsBtn.disabled = !isReady;
        els.playBtn.disabled = !isReady;
        els.prevBtn.disabled = !isReady || state.idx <= 0;
        els.nextBtn.disabled = !isReady || state.idx >= state.total - 1;
    }

    // ── Frame display ──
    function extractNumber(name) { const m = name.match(/(\d+)/); return m ? parseInt(m[1]) : null; }

    function showFrame(i) {
        i = Math.max(0, Math.min(state.total - 1, i));
        state.idx = i;
        els.mainImage.src = state.urls[i];
        els.mainImage.style.display = 'block';
        els.counter.textContent = formatCounter(i + 1, state.total);
        const meta = state.imagesMeta[i];
        const name = meta ? meta.name : '';
        els.fileName.textContent = name;
        const sidebarFileName = $('sidebar-file-name');
        if (sidebarFileName) sidebarFileName.textContent = name || 'no file';
        els.slider.value = i;
        syncControlStates();
        if (state.currentFolder) {
            const saved = readSavedState();
            saved.folder = state.currentFolder;
            saved.frames = saved.frames || {};
            saved.frames[state.currentFolder] = i;
            writeSavedState(saved);
        }
        if (!state.viewInitialized) {
            const applyInitialView = () => {
                const rv = state.restoreView;
                if (rv && Number.isFinite(rv.scale)) {
                    view.scale = rv.scale; view.ox = rv.ox; view.oy = rv.oy;
                    clampPan(); applyTransform();
                } else { fitToArea(); }
                state.restoreView = null; state.viewInitialized = true;
                els.mainImage.onload = null;
            };
            if (els.mainImage.complete && els.mainImage.naturalWidth) applyInitialView();
            else els.mainImage.onload = applyInitialView;
        }
    }

    function updateSidebarFolderActive(name) {
        $('sidebar-folder-list')?.querySelectorAll('.sidebar-folder-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.folderName === name);
        });
    }

    // ── Playback ──
    function stopPlay() {
        clearInterval(state.playInterval); state.playInterval = null; state.isPlaying = false;
        els.playBtn.textContent = 'FF play'; els.playBtn.classList.remove('active');
        syncControlStates();
    }
    function startPlay() {
        if (!state.total) return;
        state.isPlaying = true; els.playBtn.textContent = 'FF stop'; els.playBtn.classList.add('active');
        syncControlStates();
        state.playInterval = setInterval(() => {
            state.idx = (state.idx + 1) % state.total;
            els.mainImage.src = state.urls[state.idx];
            els.counter.textContent = formatCounter(state.idx + 1, state.total);
            els.fileName.textContent = state.imagesMeta[state.idx]?.name || '';
            els.slider.value = state.idx;
            syncControlStates();
        }, Math.round(1000 / (state.fps || 12)));
    }

    // ── (no-op stubs kept for API compat) ──
    function setGithubToken() { }
    function getGithubToken() { return ''; }

    // ── Reset ──
    function resetFramesState() {
        Object.assign(state, {
            currentFolder: null, urls: [], imagesMeta: [], total: 0, idx: 0,
            viewInitialized: false, restoreView: null, error: null
        });
        if (!isInitialized) return;
        if (els.mainImage) { els.mainImage.src = ''; els.mainImage.style.display = 'none'; }
        if (els.controlsRow) els.controlsRow.style.display = 'none';
        if (els.progressWrap) els.progressWrap.style.display = 'none';
        if (els.progressBar) els.progressBar.style.width = '0%';
        if (els.counter) els.counter.textContent = '— / —';
        if (els.fileName) els.fileName.textContent = '';
        const sfn = $('sidebar-file-name');
        if (sfn) sfn.textContent = 'no file';
        if (els.dropdownMenu) els.dropdownMenu.innerHTML = '';
        if (els.folderName) els.folderName.textContent = 'loading...';
        if (els.statusmsg) { els.statusmsg.style.display = ''; els.statusmsg.textContent = 'loading...'; }
        syncControlStates();
    }

    function initFoldersIfReady() {
        if (!isInitialized) return false;
        if (!getVpsUrl()) {
            state.error = 'VPS URL not configured';
            els.folderName.textContent = 'url required';
            els.statusmsg.textContent = 'VPS URL not configured';
            syncControlStates();
            return false;
        }
        initFolders();
        return true;
    }

    // ── VPS API ──
    async function fetchFrameFiles(username) {
        const base = getVpsUrl();
        if (!base) throw new Error('VPS URL not configured');
        const res = await fetch(`${base}/api/frames/${encodeURIComponent(username)}`, {
            headers: authHeaders()
        });
        if (!res.ok) throw new Error('error ' + res.status);
        return await res.json();
    }

    // ── Download ──
    async function downloadCurrentFrame() {
        const url = state.urls[state.idx];
        if (!url) return;
        const name = state.imagesMeta[state.idx]?.name || 'frame.png';
        const a = document.createElement('a');
        a.download = name;
        try {
            const res = await fetch(url, {
                mode: 'cors',
                headers: authHeaders()
            });
            if (!res.ok) throw new Error('download failed');
            const blobUrl = URL.createObjectURL(await res.blob());
            a.href = blobUrl;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        } catch {
            a.href = url;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        }
    }

    // ── Preload ──
    async function loadAuthenticatedImages(urls) {
        const loaded = [];
        for (const url of urls) {
            try {
                const res = await fetch(url, {
                    mode: 'cors',
                    headers: authHeaders()
                });
                if (!res.ok) throw new Error('image error ' + res.status);
                const blob = await res.blob();
                loaded.push(URL.createObjectURL(blob));
            } catch (e) {
                console.error('Image load error', e);
                loaded.push(url);
            }
        }
        return loaded;
    }

    function preloadImages(urls) {
        return new Promise(resolve => {
            let done = 0;
            const total = urls.length;
            const tick = () => {
                els.progressBar.style.width = Math.round((done / total) * 100) + '%';
                els.statusmsg.textContent = `loading ${done} / ${total}`;
                if (done < total) return;
                els.progressWrap.style.display = 'none';
                els.statusmsg.style.display = 'none';
                resolve();
            };
            urls.forEach(u => {
                const img = new Image();
                img.onload = img.onerror = () => { done++; tick(); };
                img.src = u;
            });
        });
    }

    // ── Folder loading ──
    async function loadFolder(folder) {
        stopPlay(); setLoading(true); syncControlStates();
        state.error = null; state.currentFolder = folder;
        els.folderName.textContent = folder;
        updateSidebarFolderActive(folder);
        els.dropdownMenu.classList.remove('open'); els.folderBtn.classList.remove('open');
        els.mainImage.style.display = 'none'; els.mainImage.src = '';
        els.controlsRow.style.display = 'none';
        els.statusmsg.style.display = ''; els.statusmsg.textContent = 'loading...';
        els.progressWrap.style.display = ''; els.progressBar.style.width = '0%';
        els.fileName.textContent = ''; els.counter.textContent = '— / —';
        Object.assign(state, { urls: [], imagesMeta: [], total: 0, idx: 0, viewInitialized: false, restoreView: null });
        syncControlStates();
        try {
            const files = await fetchFrameFiles(folder);
            const images = files
                .filter(f => /\.(png|jpe?g)$/i.test(f))
                .map(f => ({ name: f }));
            images.sort((a, b) => {
                const na = extractNumber(a.name), nb = extractNumber(b.name);
                if (na !== null && nb !== null) return na - nb;
                if (na !== null) return -1; if (nb !== null) return 1;
                return a.name.localeCompare(b.name);
            });
            if (!images.length) {
                state.error = 'no images found';
                els.statusmsg.textContent = 'no images found.';
                els.progressWrap.style.display = 'none';
                setLoading(false); return;
            }
            state.imagesMeta = images; state.total = images.length;
            const base = `${getVpsUrl()}/frames/${encodeURIComponent(folder)}`;
            const imageUrls = images.map(img => `${base}/${encodeURIComponent(img.name)}`);
            state.urls = await loadAuthenticatedImages(imageUrls);
            await preloadImages(state.urls);
            els.slider.max = state.total - 1;
            els.controlsRow.style.display = 'flex';
            const saved = readSavedState();
            const savedIdx = saved.frames?.[folder];
            const startIndex = savedIdx != null ? Math.min(Math.max(savedIdx, 0), state.total - 1) : state.total - 1;
            state.restoreView = saved.views?.[folder] || null;
            showFrame(startIndex);
        } catch (err) {
            state.error = err.message || 'unknown error';
            els.statusmsg.textContent = 'error: ' + err.message;
            els.progressWrap.style.display = 'none';
        } finally { setLoading(false); syncControlStates(); }
    }

    async function initFolders() {
        try {
            const base = getVpsUrl();
            const res = await fetch(`${base}/api/clients`, {
                headers: authHeaders()
            });
            if (!res.ok) throw new Error('error ' + res.status);
            const clients = await res.json();
            const folders = clients.map(c => ({ name: c.username }));
            els.dropdownMenu.innerHTML = '';
            const sidebarList = $('sidebar-folder-list');
            if (sidebarList) sidebarList.innerHTML = '';

            folders.forEach(f => {
                const item = document.createElement('div');
                item.className = 'dropdown-item'; item.textContent = f.name;
                item.addEventListener('click', () => loadFolder(f.name));
                els.dropdownMenu.appendChild(item);

                if (sidebarList) {
                    const btn = document.createElement('button');
                    btn.className = 'sidebar-row-btn sidebar-folder-btn';
                    btn.textContent = f.name; btn.dataset.folderName = f.name;
                    btn.addEventListener('click', () => {
                        loadFolder(f.name);
                        $('sidebar')?.classList.remove('open');
                        $('sidebarOverlay')?.classList.remove('open');
                    });
                    sidebarList.appendChild(btn);
                }
            });

            sizeDropdownToContent(els.folderBtn, els.dropdownMenu, $('folderWrap'), folders.map(f => f.name), 'folder-btn');
            const saved = readSavedState();
            const def = folders.find(f => f.name === saved.folder)
                || folders.find(f => f.name === 'carlo')
                || folders[0];
            if (def) loadFolder(def.name);
            else {
                state.error = 'no folders found';
                els.folderName.textContent = 'no folders';
                els.statusmsg.textContent = 'no folders found.';
                syncControlStates();
            }
        } catch (err) {
            state.error = err.message || 'unknown error';
            els.folderName.textContent = 'error';
            els.statusmsg.textContent = 'error: ' + err.message;
            syncControlStates();
        }
    }

    // ── Shared: measure text and size a dropdown ──
    function sizeDropdownToContent(btn, menu, wrap, names, btnClass) {
        if (!names?.length) return;
        const meas = document.createElement('button');
        meas.className = `${btnClass} folder-measure`;
        const span = document.createElement('span');
        meas.append(span);
        document.body.appendChild(meas);
        let max = 0;
        names.forEach(n => { span.textContent = n; max = Math.max(max, meas.getBoundingClientRect().width); });
        document.body.removeChild(meas);
        const w = Math.ceil(max) + 'px';
        if (btn) btn.style.minWidth = w;
        if (menu) menu.style.minWidth = w;
        if (wrap) wrap.style.minWidth = w;
    }

    // ── Event listeners ──
    function setupListeners() {
        els.playBtn.addEventListener('click', () => state.isPlaying ? stopPlay() : startPlay());

        // FPS dropdown
        const toggleFpsMenu = () => {
            if (els.fpsBtn.disabled) return;
            els.fpsBtn.classList.toggle('open'); els.fpsMenu.classList.toggle('open');
        };
        els.fpsBtn.addEventListener('click', e => { e.stopPropagation(); toggleFpsMenu(); });
        els.fpsWrap.addEventListener('click', e => { if (!e.target.closest('#fpsMenu')) toggleFpsMenu(); });
        els.fpsMenu.querySelectorAll('.file-dropdown-item').forEach(item => {
            item.addEventListener('click', e => {
                e.stopPropagation();
                const next = parseInt(item.dataset.fps, 10);
                if (Number.isFinite(next)) { setFps(next); els.fpsBtn.classList.remove('open'); els.fpsMenu.classList.remove('open'); }
            });
        });
        document.querySelectorAll('.sidebar-fps-btn').forEach(btn => {
            btn.addEventListener('click', () => { const n = parseInt(btn.dataset.fps, 10); if (Number.isFinite(n)) setFps(n); });
        });

        els.prevBtn.addEventListener('click', () => { stopPlay(); showFrame(state.idx - 1); });
        els.nextBtn.addEventListener('click', () => { stopPlay(); showFrame(state.idx + 1); });
        els.slider.addEventListener('mousedown', () => { if (state.isPlaying) stopPlay(); });
        els.slider.addEventListener('touchstart', () => { if (state.isPlaying) stopPlay(); });
        els.slider.addEventListener('input', e => { state.idx = parseInt(e.target.value); showFrame(state.idx); });

        els.sliderWrap.addEventListener('pointerdown', e => {
            if (state.loading || !state.total || e.target === els.slider) return;
            if (state.isPlaying) stopPlay();
            const seek = clientX => {
                const rect = els.sliderWrap.getBoundingClientRect();
                const min = parseInt(els.slider.min || '0'), max = parseInt(els.slider.max || '0');
                const ratio = rect.width ? Math.min(Math.max(clientX - rect.left, 0), rect.width) / rect.width : 0;
                showFrame(Math.round(min + ratio * (max - min)));
            };
            seek(e.clientX);
            const onMove = ev => seek(ev.clientX);
            const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });

        window.addEventListener('keydown', ev => {
            if (window.__getCurrentMode() !== 'frames' || state.loading || !state.total) return;
            if (ev.key === 'ArrowLeft') { stopPlay(); showFrame(state.idx - 1); ev.preventDefault(); }
            else if (ev.key === 'ArrowRight') { stopPlay(); showFrame(state.idx + 1); ev.preventDefault(); }
            else if (ev.key === ' ') { state.isPlaying ? stopPlay() : startPlay(); ev.preventDefault(); }
            else if (ev.key === '0') { resetView(); }
        });

        els.folderBtn.addEventListener('click', () => { els.folderBtn.classList.toggle('open'); els.dropdownMenu.classList.toggle('open'); });
        els.fileBtn.addEventListener('click', () => { els.fileBtn.classList.toggle('open'); els.fileDropdownMenu.classList.toggle('open'); });
        els.downloadItem.addEventListener('click', async () => {
            await downloadCurrentFrame();
            els.fileBtn.classList.remove('open'); els.fileDropdownMenu.classList.remove('open');
        });

        // Close dropdowns on outside click
        document.addEventListener('click', e => {
            if (!$('folderWrap').contains(e.target)) { els.folderBtn.classList.remove('open'); els.dropdownMenu.classList.remove('open'); }
            if (!$('fileWrap').contains(e.target)) { els.fileBtn.classList.remove('open'); els.fileDropdownMenu.classList.remove('open'); }
            if (!$('fpsWrap')?.contains(e.target)) { els.fpsBtn.classList.remove('open'); els.fpsMenu.classList.remove('open'); }
        });

        setupPanZoom();
    }

    // ── Pan / zoom ──
    const view = { scale: 1, ox: 0, oy: 0 };
    let drag = { active: false, startX: 0, startY: 0, startOx: 0, startOy: 0 };
    let zoomHideTimer = null, touchMode = null, pinchStartDist = 0, pinchStartScale = 1;

    function applyTransform() {
        els.mainImage.style.transform = `translate(${view.ox}px,${view.oy}px) scale(${view.scale})`;
        const zl = $('zoomLevel');
        zl.textContent = Math.round(view.scale * 100) + '%'; zl.classList.add('visible');
        clearTimeout(zoomHideTimer);
        zoomHideTimer = setTimeout(() => zl.classList.remove('visible'), 1200);
        saveViewState();
    }
    function fitToArea() {
        const img = els.mainImage;
        if (!img.naturalWidth) return;
        const area = $('imageArea');
        const scale = Math.min(area.clientWidth / img.naturalWidth, area.clientHeight / img.naturalHeight, 1);
        view.scale = scale;
        view.ox = (area.clientWidth - img.naturalWidth * scale) / 2;
        view.oy = (area.clientHeight - img.naturalHeight * scale) / 2;
        applyTransform();
    }
    function resetView() { fitToArea(); }
    function clampPan() {
        const img = els.mainImage, area = $('imageArea');
        const aw = area.clientWidth, ah = area.clientHeight;
        const iw = img.naturalWidth * view.scale, ih = img.naturalHeight * view.scale;
        view.ox = iw <= aw ? (aw - iw) / 2 : Math.min(0, Math.max(aw - iw, view.ox));
        view.oy = ih <= ah ? (ah - ih) / 2 : Math.min(0, Math.max(ah - ih, view.oy));
    }
    function zoomAt(cx, cy, delta) {
        const area = $('imageArea');
        const rect = area.getBoundingClientRect();
        const mx = cx - rect.left, my = cy - rect.top;
        const factor = delta > 0 ? 1.12 : 1 / 1.12;
        const newScale = Math.min(Math.max(view.scale * factor, 0.1), 20);
        const ratio = newScale / view.scale;
        view.ox = mx - ratio * (mx - view.ox);
        view.oy = my - ratio * (my - view.oy);
        view.scale = newScale;
        clampPan(); applyTransform();
    }
    function setupPanZoom() {
        const area = $('imageArea');
        area.addEventListener('wheel', e => {
            if (state.loading || !state.total) return;
            e.preventDefault(); zoomAt(e.clientX, e.clientY, -e.deltaY);
        }, { passive: false });
        area.addEventListener('mousedown', e => {
            if (state.loading || !state.total || e.button !== 0) return;
            drag = { active: true, startX: e.clientX, startY: e.clientY, startOx: view.ox, startOy: view.oy };
            area.classList.add('dragging');
        });
        area.addEventListener('touchstart', e => {
            if (state.loading || !state.total) return;
            if (e.touches.length === 1) {
                const t = e.touches[0];
                touchMode = 'pan';
                drag = { active: true, startX: t.clientX, startY: t.clientY, startOx: view.ox, startOy: view.oy };
                area.classList.add('dragging');
            } else if (e.touches.length === 2) {
                touchMode = 'pinch';
                pinchStartDist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
                pinchStartScale = view.scale;
            }
            e.preventDefault();
        }, { passive: false });
        window.addEventListener('mousemove', e => {
            if (!drag.active) return;
            view.ox = drag.startOx + (e.clientX - drag.startX);
            view.oy = drag.startOy + (e.clientY - drag.startY);
            clampPan(); applyTransform();
        });
        window.addEventListener('touchmove', e => {
            if (state.loading || !state.total) return;
            if (touchMode === 'pan' && drag.active && e.touches.length === 1) {
                const t = e.touches[0];
                view.ox = drag.startOx + (t.clientX - drag.startX);
                view.oy = drag.startOy + (t.clientY - drag.startY);
                clampPan(); applyTransform(); e.preventDefault();
            } else if (touchMode === 'pinch' && e.touches.length === 2) {
                const [t1, t2] = e.touches;
                const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
                const rect = area.getBoundingClientRect();
                const cx = (t1.clientX + t2.clientX) / 2 - rect.left;
                const cy = (t1.clientY + t2.clientY) / 2 - rect.top;
                const nextScale = Math.min(Math.max(pinchStartScale * (dist / (pinchStartDist || 1)), 0.1), 20);
                const ratio = nextScale / view.scale;
                view.ox = cx - ratio * (cx - view.ox);
                view.oy = cy - ratio * (cy - view.oy);
                view.scale = nextScale;
                pinchStartDist = dist; pinchStartScale = nextScale;
                clampPan(); applyTransform(); e.preventDefault();
            }
        }, { passive: false });

        const clearDrag = () => { drag.active = false; touchMode = null; area.classList.remove('dragging'); };
        window.addEventListener('mouseup', () => { drag.active = false; area.classList.remove('dragging'); });
        window.addEventListener('touchend', clearDrag);
        window.addEventListener('touchcancel', clearDrag);
        area.addEventListener('dblclick', resetView);
        window.addEventListener('resize', () => { if (els.mainImage.style.display !== 'none') fitToArea(); });
    }

    function setupActivityMonitor() {
        const mark = () => { state.lastActivityAt = Date.now(); };
        ['pointerdown', 'pointermove', 'mousemove', 'keydown', 'wheel', 'touchstart', 'touchmove', 'click', 'scroll']
            .forEach(evt => window.addEventListener(evt, mark, { passive: true }));
        document.addEventListener('visibilitychange', () => { if (!document.hidden) mark(); });
    }

    function init() {
        if (isInitialized) return;
        bindElements(); setupListeners(); setupActivityMonitor(); syncControlStates();
        isInitialized = true;
        state.autoRefresh = setInterval(() => {
            if (state.currentFolder && Date.now() - state.lastActivityAt >= 10000)
                loadFolder(state.currentFolder);
        }, 60000);
    }

    function onShow() {
        if (!isInitialized) init();
        if (!state.currentFolder) { initFoldersIfReady(); return; }
        requestAnimationFrame(() => {
            if (!els.mainImage) return;
            if (state.total && els.mainImage.style.display === 'none') showFrame(state.idx);
            if (!state.viewInitialized) { fitToArea(); return; }
            clampPan(); applyTransform();
        });
    }

    return { init, loadFolder, state, setGithubToken, getGithubToken, initFoldersIfReady, onShow, resetFramesState, downloadCurrentFrame, sizeDropdownToContent };
})();