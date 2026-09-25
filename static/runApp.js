const RunApp = (() => {
    const runState = {
        rows: [], sortedRows: [],
        url: localStorage.getItem('vps_url'),
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
        { username: 'loren-00000000-W', updated_at: new Date(Date.now() - 4000).toISOString(), visible: true, demo: true },
        { username: 'kirk-00000000-W', updated_at: new Date(Date.now() - 17000).toISOString(), visible: false, demo: true },
        { username: 'windows-00000000-W', updated_at: new Date(Date.now() - 75000).toISOString(), visible: false, demo: true },
        { username: 'ubuntu-00000000-L', updated_at: new Date(Date.now() - 90000).toISOString(), visible: true, demo: true }
    ];
    const $ = id => document.getElementById(id);
    const themeNames = ['night', 'graphite', 'midnight', 'forest', 'ember', 'polar'];
    const conflictTimers = new Map();

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
    function setStoredCredentials(url, password = runState.password) {
        runState.url = url;
        runState.password = password || '';
        if (url) { localStorage.setItem('vps_url', url); }
        else { localStorage.removeItem('vps_url'); }
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
        setStoredCredentials(null, ''); setConnectionState(false);
        runState.rows = []; runState.sortedRows = []; runState.lastRenderSignature = null;
        renderGrid();
        if (typeof FramesApp?.resetFramesState === 'function') FramesApp.resetFramesState();
    }
    async function validateVpsConnection(url, password) {
        if (!url || !password) return false;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);
        try {
            const res = await fetch(`${url}/api/clients`, {
                signal: controller.signal,
                headers: { 'x-password': password }
            });
            return res.ok;
        } catch { return false; } finally { clearTimeout(timeoutId); }
    }
    async function connectWithCredentials(url, { notifyOnFail = true } = {}) {
        const isValid = await validateVpsConnection(url, runState.password);
        if (!isValid) {
            setStoredCredentials(null, ''); setConnectionState(false);
            if (notifyOnFail) alert('Connection failed. URL was reset. Please reconnect.');
            return false;
        }
        setStoredCredentials(url, runState.password); setConnectionState(true);
        fetchData(); return true;
    }
    async function promptAndConnect() {
        const ok = promptAllCredentials();
        if (!ok) return;
        await connectWithCredentials(runState.url.trim(), { notifyOnFail: true });
    }
    function promptAllCredentials() {
        const urlInput = prompt('VPS URL (e.g. http://your-vps:8000):', runState.url || '');
        if (!urlInput) return false;

        const passwordInput = prompt('Dashboard password:');
        if (passwordInput === null || !passwordInput) return false;

        runState.url = urlInput.trim();
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
    function getStatus(user, nowMs = Date.now()) {
        if (user.demo && user.username === 'loren-00000000-W') return 'green';
        const diff = (nowMs - parseServerTime(user.updated_at).getTime()) / 1000;
        return diff < 10 ? 'green' : diff < 30 ? 'yellow' : 'red';
    }
    const STATUS_ORDER = { green: 0, yellow: 1, red: 2 };
    function parseModernUsername(username) {
        // Accept either trailing -W (Windows) or -L (Linux) for modern usernames
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
        return sorted[0].username;
    }
    function buildRowsRenderSignature(rows, isSorted = false) {
        const nowMs = Date.now() + runState.serverTimeOffset;
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
        return `
                <div class="card-header">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            ${showWin ? WIN_LOGO_HTML : ''}${showLinux ? LINUX_LOGO_HTML : ''}
                            <span class="card-username ${alive ? '' : 'offline'}">${displayUsername}</span>
                        </div>
                        <div class="card-ts">${tsText}</div>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="card-btn primary ${alive && canInteract ? '' : 'disabled'}" data-action="ps" ${alive && canInteract ? '' : disabledAttrs}>
                        CMD ${showPrimary ? '<span class="btn-hint">C</span>' : ''}
                    </button>
                    <button class="card-btn ${alive && canInteract ? '' : 'disabled'}" data-action="speak" ${alive && canInteract ? '' : disabledAttrs}>
                        SPK ${showPrimary ? '<span class="btn-hint">S</span>' : ''}
                    </button>
                    <button class="card-btn ${alive && canInteract ? '' : 'disabled'}" data-action="popup_msg" ${alive && canInteract ? '' : disabledAttrs}>
                        MSG ${showPrimary ? '<span class="btn-hint">A</span>' : ''}
                    </button>
                    <button class="card-btn ${canInteract ? '' : 'disabled'}" data-action="output" ${canInteract ? '' : disabledAttrs}>
                        OUT ${showHint && canInteract ? '<span class="btn-hint">V</span>' : ''}
                    </button>
                </div>`;
    }
    function getCardRenderSignature(user, status, alive, tsText, showHint) {
        return `${user.username}|${getDisplayUsername(user.username)}|${status}|${alive ? 1 : 0}|${showHint ? 1 : 0}|${tsText}`;
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
        runState.isRendering = false;
    }

    // ── Selection ──
    function clearActiveSelection() {
        runState.activeUsername = null; runState.interactionMode = null;
        document.body.classList.remove('kb-mode');
        document.querySelectorAll('.user-card').forEach(c => c.classList.remove('selected'));
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
        // Toggle active class on option buttons
        const setActive = (id, cond) => $(id).className = 'opt-btn' + (cond ? ' active' : '');
        setActive('voice-david', runState.selectedVoice === 'David');
        setActive('voice-zira', runState.selectedVoice === 'Zira');
        setActive('vis-true', runState.selectedVis);
        setActive('vis-false', !runState.selectedVis);

        const setPill = (id, cond) => $(id).className = 'collapsible-meta-pill' + (cond ? ' active' : '');
        setPill('shell-summary-ps', true);
        setPill('shell-summary-upload', runState.cmdLoadedFromUpload);

        const vol = $('spk-volume'), spd = $('spk-speed');
        if (vol) vol.value = String(runState.selectedSpkVolume);
        if (spd) spd.value = String(runState.selectedSpkSpeed);
        const volV = $('spk-volume-value'), spdV = $('spk-speed-value'), meta = $('spk-summary-meta');
        if (volV) volV.textContent = String(runState.selectedSpkVolume);
        if (spdV) spdV.textContent = String(runState.selectedSpkSpeed);
        if (meta) meta.textContent = `Volume ${runState.selectedSpkVolume} | Speed ${runState.selectedSpkSpeed}`;
        updatePlaceholder();
    }

    function flashConflict(buttonId) {
        const button = $(buttonId); if (!button) return;
        button.classList.add('conflict');
        const existing = conflictTimers.get(buttonId);
        if (existing) clearTimeout(existing);
        conflictTimers.set(buttonId, setTimeout(() => { button.classList.remove('conflict'); conflictTimers.delete(buttonId); }, 1500));
    }

    // ── Popup open/close ──
    function openPopup(mode, user) {
        runState.popupMode = mode; runState.popupUser = user; runState.selectedVis = !!user.visible;
        runState.popupExampleText = (mode === 'speak' || mode === 'popup_msg') ? pickRandomPopupExample(mode) : '';
        runState.cmdLoadedFromUpload = false;
        $('popup-input').value = '';
        $('popup-target-label').textContent = getDisplayUsername(user.username);
        $('popup-overlay').classList.add('open');
        $('textarea-wrap').classList.remove('show-hint');
        const isCmd = mode === 'cmd', isSpk = mode === 'speak';
        $('vis-section').style.display = isCmd ? 'flex' : 'none';
        $('shell-section').style.display = isCmd ? 'block' : 'none';
        $('voice-section').style.display = isSpk ? 'flex' : 'none';
        $('spk-controls').style.display = isSpk ? 'block' : 'none';
        $('shell-section').open = false; $('spk-controls').open = false;
        $('popup-mode-label').textContent = isCmd ? 'Execute PowerShell' : isSpk ? 'Voice Message' : 'Message Box';
        updateOptionsUI();
        setTimeout(() => { $('popup-input').focus(); syncTabHint(); }, 50);
    }
    function closePopup() {
        $('popup-overlay').classList.remove('open');
        $('textarea-wrap').classList.remove('show-hint');
        runState.popupMode = null; runState.popupUser = null; runState.popupExampleText = '';
    }

    // ── Command building ──
    function bytesToBase64(bytes) {
        const chunkSize = 0x8000; let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize)
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        return btoa(binary);
    }
    function formatPSString(str) {
        return str.replace(/'/g, "''").split(/\r?\n/).map(line => `'${line}'`).join(' + [char]13 + ');
    }
    function wrapPowershell(val, hidden = true) {
        const utf16 = new Uint8Array(val.length * 2);
        for (let i = 0; i < val.length; i++) {
            const c = val.charCodeAt(i);
            utf16[i * 2] = c & 0xff; utf16[i * 2 + 1] = (c >> 8) & 0xff;
        }
        return `powershell -NoP -EP Bypass -W ${hidden ? 'H' : 'Normal'} -EncodedCommand ${bytesToBase64(utf16)}`;
    }
    function isSpecialCommandInput(text) {
        return /^(panic|nodat|altf4|sauce)(?:\b|$)/i.test((text || '').trim());
    }
    // ── Send / fetch ──
    async function doSendPopup() {
        const user = runState.popupUser, mode = runState.popupMode;
        const val = $('popup-input').value.trim();
        if (!user) return;
        if (!runState.isConnected || user.demo) { closePopup(); alert('Demo mode: action preview only. Connect to send real commands.'); return; }

        let rawCmd = '';
        if (mode === 'cmd') {
            if (val) rawCmd = isSpecialCommandInput(val) ? val : wrapPowershell(val, !runState.selectedVis);
        } else if (val) {
            const msg = formatPSString(val);
            if (mode === 'speak') {
                rawCmd = `$s=New-Object -Com SAPI.SpVoice;$s.Volume=${runState.selectedSpkVolume};$s.Rate=${runState.selectedSpkSpeed};$s.Voice=$s.GetVoices()|Where-Object{$_.GetDescription() -like '*${runState.selectedVoice}*'};$s.Speak(${msg})`;
            } else {
                rawCmd = `(New-Object -Com WScript.Shell).Popup(${msg})`;
            }
        }

        if (!rawCmd && mode !== 'cmd') { closePopup(); return; }
        const body = {
            username: user.username,
            cmd: rawCmd ? btoa(rawCmd) : '',
            visible: mode === 'cmd'
                ? (runState.selectedVis ? 1 : 0)
                : 1
        };

        try {
            const res = await fetch(`${runState.url}/api/command`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-password': runState.password
                },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                console.error('Command request failed:', res.status, await res.text());
                return;
            }

            closePopup();
            fetchData();
        } catch (e) {
            console.error('Send error', e);
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
        if (!runState.url || !runState.isConnected || runState.fetchInFlight) return;
        runState.fetchInFlight = true;
        try {
            const res = await fetch(`${runState.url}/api/clients`, {
                headers: { 'x-password': runState.password }
            });
            const nextRows = await res.json();
            const nextSorted = sortRows(nextRows);
            const sig = buildRowsRenderSignature(nextSorted, true);
            runState.rows = nextRows; runState.sortedRows = nextSorted;
            if (sig === runState.lastRenderSignature) return;
            runState.lastRenderSignature = sig;
            renderGrid();
        } catch (e) { console.error(e); } finally { runState.fetchInFlight = false; }
    }

    // ── Visibility ──
    async function setPopupVisibility(nextVisible) {
        if (runState.popupMode !== 'cmd' || !runState.popupUser) return;
        runState.selectedVis = !!nextVisible;
        runState.popupUser.visible = runState.selectedVis;
        const idx = runState.rows.findIndex(r => r.username === runState.popupUser.username);
        if (idx !== -1) runState.rows[idx] = { ...runState.rows[idx], visible: runState.selectedVis };
        updateOptionsUI(); renderGrid();
        if (!runState.isConnected || !runState.url || runState.popupUser.demo) return;
        try {
            await fetch(`${runState.url}/api/visibility`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-password': runState.password
                },
                body: JSON.stringify({ username: runState.popupUser.username, visible: runState.selectedVis ? 1 : 0 })
            });
        } catch (e) { console.error('Visibility sync error', e); }
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
            btn.addEventListener('click', () => applyTheme(btn.dataset.themeVal));
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
            if (action === 'speak') openPopup('speak', user);
            if (action === 'popup_msg') openPopup('popup_msg', user);
            if (action === 'output') doViewOutput(user);
        });

        // Option button listeners
        $('voice-david').onclick = () => { runState.selectedVoice = 'David'; updateOptionsUI(); };
        $('voice-zira').onclick = () => { runState.selectedVoice = 'Zira'; updateOptionsUI(); };
        $('spk-volume').oninput = e => { runState.selectedSpkVolume = Number(e.target.value); updateOptionsUI(); };
        $('spk-speed').oninput = e => { runState.selectedSpkSpeed = Number(e.target.value); updateOptionsUI(); };
        $('vis-true').onclick = () => setPopupVisibility(true);
        $('vis-false').onclick = () => setPopupVisibility(false);
        $('upload-btn').onclick = () => $('file-upload').click();

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
            if (window.__getCurrentMode() !== 'run') return;
            if (runState.popupMode) {
                if (e.key === 'Escape') closePopup();
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSendPopup(); }
                if (e.key === 'Shift' && document.activeElement !== $('popup-input')) {
                    if (runState.popupMode === 'speak') { runState.selectedVoice = runState.selectedVoice === 'David' ? 'Zira' : 'David'; updateOptionsUI(); }
                    else if (runState.popupMode === 'cmd') setPopupVisibility(!runState.selectedVis);
                }
                return;
            }
            const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
            if (arrowKeys.includes(e.key)) {
                e.preventDefault();
                const cards = document.querySelectorAll('.user-card'); if (!cards.length) return;
                const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
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
            if (key === 'p' && alive) openPopup('cmd', u);
            if (key === 's' && alive) { runState.selectedVoice = e.shiftKey ? 'Zira' : 'David'; openPopup('speak', u); }
            if (key === 'a' && alive) openPopup('popup_msg', u);
            if (key === 'v') doViewOutput(u);
        });

        // Initial connection
        if (!runState.url) {
            const ok = promptAllCredentials();
            if (!ok) { renderGrid(); }
            else if (runState.url) {
                $('user-grid').innerHTML = '<div class="empty">Connecting...</div>';
                connectWithCredentials(runState.url, { notifyOnFail: false }).then(ok => { if (!ok) renderGrid(); });
            } else { renderGrid(); }
        } else {
            $('user-grid').innerHTML = '<div class="empty">Connecting...</div>';
            connectWithCredentials(runState.url, { notifyOnFail: false }).then(ok => { if (!ok) renderGrid(); });
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
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSendPopup(); }
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