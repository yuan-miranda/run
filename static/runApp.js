/**
 * RunApp - Windows Central Dashboard & Multi-Node Controller
 *
 * Core controller for managing connected client nodes, dispatching real-time PowerShell commands,
 * interactive dialogs (speech synthesis, message popups, full-screen image viewer, audio blaster),
 * full remote filesystem exploration (FTP browser), live desktop screenshot capture, and
 * real-time audit logs of administrative actions.
 */
const RunApp = (() => {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 1: APPLICATION STATE, CONFIGURATION & CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    // Automatically upgrade to HTTPS on remote hostnames so browser geolocation is enabled
    if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        window.location.protocol = 'https:';
    }

    const VPS_URL = window.location.origin;

    /**
     * Primary application reactive state container.
     */
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

    /**
     * Preset rotating example messages for Speak and Message modal modes.
     */
    const popupExamples = {
        speak: [
            'Audio test, all systems ready.',
            'Status update: task completed.',
            'Heads up, check your dashboard.'
        ],
        popup_msg: [
            'Reminder: save your work now.',
            'Notice: update available.',
            'Quick check: please confirm.'
        ]
    };

    /**
     * Static demo records displayed prior to connecting to a live server.
     */
    const demoUsers = [
        { username: 'a-00000000-W', ip: '192.168.1.101', updated_at: new Date(Date.now() - 4000).toISOString(), visible: true, demo: true },
        { username: 'b-00000000-W', ip: '192.168.1.102', updated_at: new Date(Date.now() - 17000).toISOString(), visible: false, demo: true },
        { username: 'c-00000000-W', ip: '192.168.1.103', updated_at: new Date(Date.now() - 75000).toISOString(), visible: false, demo: true },
        { username: 'd-00000000-L', ip: '192.168.1.104', updated_at: new Date(Date.now() - 90000).toISOString(), visible: true, demo: true }
    ];

    /**
     * Fast element query selector by ID.
     * @param {string} id - HTML element ID.
     * @returns {HTMLElement|null} Found element or null.
     */
    const $ = id => document.getElementById(id);

    const themeNames = ['night', 'graphite', 'midnight', 'forest', 'ember', 'polar'];
    const STATUS_ORDER = { green: 0, yellow: 1, red: 2 };
    const WIN_LOGO_HTML = `<i class="bi bi-windows os-logo" aria-hidden="true"></i>`;

    const ACTION_MODE_LABELS = {
        cmd: 'Commandline',
        speak: 'Speak',
        popup_msg: 'Message',
        imager: 'Imager',
        audio: 'Audio',
        scripts: 'Scripts',
        placeholder: 'Scripts'
    };

    let dashboardSocket = null;
    let isSendingCommand = false;

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 2: PLATFORM & USERNAME PARSING HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Parse structured client username into baseName, 8-character ID, and OS tag.
     *
     * @param {string} username - Composite username string (e.g. 'alice-4a7b9c1d-W').
     * @returns {{baseName: string, id: string, os: string}} Parsed username tokens.
     */
    function parseModernUsername(username) {
        if (window.RunUtils?.parseUsername) {
            return window.RunUtils.parseUsername(username);
        }
        const text = String(username || '').trim();
        const match = text.match(/^(.*?)-([^-]+)-(W|WIN)$/i);
        if (!match) return { baseName: text, id: '', os: 'W' };
        return { baseName: match[1], id: match[2], os: match[3].toUpperCase() };
    }

    /**
     * Retrieve disambiguated display name for a given user from precomputed map.
     *
     * @param {string} username - Unique composite username.
     * @returns {string} Human-friendly display name.
     */
    function getDisplayUsername(username) {
        return runState.displayNameMap?.get(username) || parseModernUsername(username).baseName;
    }

    /**
     * Construct a mapping of usernames to display labels, appending short ID only if name collision occurs.
     *
     * @param {Array<{username: string}>} rows - Array of user records.
     * @returns {Map<string, string>} Map linking username to display label.
     */
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

    /**
     * Parse server-generated UTC ISO or standard SQL datetime string into a JavaScript Date.
     *
     * @param {string} value - Datetime string.
     * @returns {Date} Parsed Date object.
     */
    function parseServerTime(value) {
        if (!value) return new Date(NaN);
        const text = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
            return new Date(text.replace(' ', 'T') + 'Z');
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text) && !text.endsWith('Z') && !/[+-]\d{2}:?\d{2}$/.test(text)) {
            return new Date(text + 'Z');
        }
        return new Date(text);
    }

    /**
     * Convert UTC server datetime string into formatted local browser time string (YYYY-MM-DD HH:MM:SS).
     *
     * @param {string} utcStr - Server UTC datetime string.
     * @returns {string} Localized date string.
     */
    function formatLocalDateTime(utcStr) {
        if (!utcStr) return '—';
        try {
            const date = parseServerTime(utcStr);
            if (isNaN(date.getTime())) return String(utcStr);

            const pad = n => String(n).padStart(2, '0');
            const y = date.getFullYear();
            const m = pad(date.getMonth() + 1);
            const d = pad(date.getDate());
            const hh = pad(date.getHours());
            const mm = pad(date.getMinutes());
            const ss = pad(date.getSeconds());
            return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
        } catch {
            return String(utcStr);
        }
    }

    /**
     * Determine client connectivity health status: 'green' (online), 'yellow' (stale), or 'red' (offline).
     *
     * @param {object} user - User record object.
     * @param {number} [nowMs=Date.now()] - Current epoch timestamp in milliseconds.
     * @returns {'green'|'yellow'|'red'} Status indicator string.
     */
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

    /**
     * Sort user rows prioritizing online status ('green' -> 'yellow' -> 'red'), then alphabetically by username.
     *
     * @param {object[]} rows - Array of user records to sort.
     * @returns {object[]} Sorted copy of user records.
     */
    function sortRows(rows) {
        return [...rows].sort((a, b) =>
            STATUS_ORDER[getStatus(a)] - STATUS_ORDER[getStatus(b)] || a.username.localeCompare(b.username)
        );
    }

    /**
     * Retrieve renderable user list: returns real server rows when connected, or mock demo list otherwise.
     *
     * @returns {object[]} Array of rows ready for grid rendering.
     */
    function getRenderableRows() {
        return runState.isConnected ? runState.sortedRows : sortRows(demoUsers);
    }

    /**
     * Determine which client card should receive single-letter hotkey hints ('C', 'V', etc.).
     *
     * @param {object[]} [sorted=getRenderableRows()] - Active sorted rows list.
     * @returns {string|null} Target username for hotkey hint, or null.
     */
    function getHintUsername(sorted = getRenderableRows()) {
        if (!sorted.length) return null;
        if (runState.activeUsername && sorted.some(u => u.username === runState.activeUsername)) {
            return runState.activeUsername;
        }
        return null;
    }

    /**
     * Generate compact diff signature string for user list to avoid redundant DOM reconciliation.
     *
     * @param {object[]} rows - Array of user objects.
     * @param {boolean} [isSorted=false] - True if rows are pre-sorted.
     * @returns {string} Hash signature string.
     */
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

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 3: DYNAMIC THEME ENGINE
    // ═══════════════════════════════════════════════════════════════════════════

    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

    /**
     * Select a random theme name from available themes palette.
     * @returns {string} Selected theme name.
     */
    function pickRandomTheme() {
        return themeNames[Math.floor(Math.random() * themeNames.length)];
    }

    /**
     * Update label text for "Random" dropdown options to reflect currently resolved palette.
     * @param {string} activeTheme - Name of currently applied active theme.
     */
    function updateRandomThemeOptionLabel(activeTheme) {
        const label = `Random (${cap(activeTheme)})`;
        ['run-theme-random-option', 'sidebar-theme-random-option'].forEach(id => {
            const el = $(id);
            if (el) el.textContent = label;
        });
    }

    /**
     * Apply active theme palette across DOM root and persist selection in localStorage.
     *
     * @param {string} [themeName='night'] - Target theme name or 'random'.
     */
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

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 4: AUTHENTICATION & VPS CONNECTION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Store dashboard password in session memory and sessionStorage.
     * @param {string} password - Dashboard password string.
     */
    function storePassword(password) {
        runState.password = password || '';
        if (runState.password) {
            sessionStorage.setItem('vps_password', runState.password);
        } else {
            sessionStorage.removeItem('vps_password');
        }
    }

    /**
     * Update UI connect/disconnect button labels and styling based on connection state.
     * @param {boolean} connected - Connection status flag.
     */
    function setConnectionState(connected) {
        runState.isConnected = !!connected;
        const label = connected ? 'disconnect' : 'connect';
        ['run-connect-btn', 'sidebar-connect-btn'].forEach(id => {
            const el = $(id);
            if (!el) return;
            el.textContent = label;
            el.classList.toggle('connected', !!connected);
        });
        const accessLogsWrap = $('runAccessLogsWrap');
        if (accessLogsWrap) accessLogsWrap.style.display = connected ? 'flex' : 'none';
        const sidebarAccessLogs = $('sidebar-access-logs-btn');
        if (sidebarAccessLogs) sidebarAccessLogs.style.display = connected ? 'block' : 'none';
    }

    /**
     * Disconnect from server, purge stored credentials, and reset grid to demo mode.
     */
    function disconnectAndReset() {
        storePassword('');
        setConnectionState(false);
        closeAccessLogsModal();
        runState.rows = [];
        runState.sortedRows = [];
        runState.lastRenderSignature = null;
        renderGrid();
        if (typeof FramesApp?.resetFramesState === 'function') {
            FramesApp.resetFramesState();
        }
    }

    /**
     * Request user GPS position with progressive fallback and permission state detection.
     * Prevents false timeouts on desktop PCs without GPS chips while strictly enforcing user consent.
     *
     * @param {number} [timeoutMs=15000] - Total maximum time to wait.
     * @returns {Promise<{ok: boolean, reason: string, coords: object|null, note?: string, error?: string}>}
     */
    async function requestGpsLocation(timeoutMs = 15000) {
        if (!navigator.geolocation) {
            return {
                ok: false,
                reason: !window.isSecureContext ? 'INSECURE_HTTP' : 'NOT_SUPPORTED',
                coords: null
            };
        }
        if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            return {
                ok: false,
                reason: 'INSECURE_HTTP',
                coords: null
            };
        }

        // Query browser permission status first if API is available
        let initialPermState = 'prompt';
        if (navigator.permissions?.query) {
            try {
                const p = await navigator.permissions.query({ name: 'geolocation' });
                initialPermState = p.state; // 'granted', 'prompt', or 'denied'
            } catch {}
        }

        if (initialPermState === 'denied') {
            return {
                ok: false,
                reason: 'PERMISSION_DENIED',
                coords: null,
                error: 'Permission is explicitly blocked in browser settings'
            };
        }

        // Helper to query position with specific options and timeout
        const tryGetPosition = (opts, maxWait) => new Promise(resolve => {
            let settled = false;
            const t = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve({ ok: false, errCode: 3, message: 'TIMEOUT' });
            }, maxWait);

            try {
                navigator.geolocation.getCurrentPosition(
                    pos => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(t);
                        resolve({ ok: true, pos });
                    },
                    err => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(t);
                        resolve({ ok: false, errCode: err.code, message: err.message });
                    },
                    opts
                );
            } catch (e) {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                resolve({ ok: false, errCode: -1, message: e.message });
            }
        });

        // Attempt 1: High accuracy (fast 5s attempt - ideal for phones / tablets / GPS-enabled devices)
        const res1 = await tryGetPosition({ enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }, 5500);
        if (res1.ok && res1.pos?.coords) {
            const c = res1.pos.coords;
            return {
                ok: true,
                reason: 'GRANTED',
                coords: {
                    latitude: c.latitude,
                    longitude: c.longitude,
                    accuracy: c.accuracy,
                    altitude: c.altitude,
                    altitudeAccuracy: c.altitudeAccuracy,
                    heading: c.heading,
                    speed: c.speed
                }
            };
        }

        // If explicitly denied by user click during Attempt 1
        if (res1.errCode === 1) {
            return { ok: false, reason: 'PERMISSION_DENIED', coords: null, error: res1.message };
        }

        // Attempt 2: Standard/Network accuracy (generous 7s attempt with cached position support)
        const res2 = await tryGetPosition({ enableHighAccuracy: false, timeout: 7000, maximumAge: 300000 }, 7500);
        if (res2.ok && res2.pos?.coords) {
            const c = res2.pos.coords;
            return {
                ok: true,
                reason: 'GRANTED',
                coords: {
                    latitude: c.latitude,
                    longitude: c.longitude,
                    accuracy: c.accuracy,
                    altitude: c.altitude,
                    altitudeAccuracy: c.altitudeAccuracy,
                    heading: c.heading,
                    speed: c.speed
                }
            };
        }

        if (res2.errCode === 1) {
            return { ok: false, reason: 'PERMISSION_DENIED', coords: null, error: res2.message };
        }

        // Check if permission was granted despite hardware sensor unavailability (e.g. desktop PC on wired LAN)
        let finalPermState = initialPermState;
        if (navigator.permissions?.query) {
            try {
                const p = await navigator.permissions.query({ name: 'geolocation' });
                finalPermState = p.state;
            } catch {}
        }

        if (finalPermState === 'granted') {
            return {
                ok: true,
                reason: 'GRANTED',
                coords: null,
                note: 'Permission Granted (Desktop / LAN - No GPS Hardware)'
            };
        }

        // If still in prompt or timed out
        return {
            ok: false,
            reason: res2.errCode === 3 || res1.errCode === 3 ? 'TIMEOUT' : 'POSITION_UNAVAILABLE',
            coords: null,
            error: res2.message || res1.message
        };
    }

    /**
     * Query connected media hardware (microphones, cameras, speakers) and their names.
     * @returns {Promise<object|null>} Media devices summary dictionary or null.
     */
    async function getMediaDevicesSummary() {
        if (!navigator.mediaDevices?.enumerateDevices) return null;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const counts = { audioinput: 0, videoinput: 0, audiooutput: 0 };
            const labels = [];
            devices.forEach(d => {
                if (counts[d.kind] !== undefined) counts[d.kind]++;
                if (d.label) labels.push(d.label);
            });
            return {
                microphones: counts.audioinput,
                cameras: counts.videoinput,
                speakers: counts.audiooutput,
                labels: labels.length > 0 ? labels : undefined
            };
        } catch {
            return null;
        }
    }

    /**
     * Query device battery state if Battery API is supported.
     * @returns {Promise<object|null>} Battery percentage, charging status, and times or null.
     */
    async function getBatteryStatus() {
        if (!navigator.getBattery) return null;
        try {
            const b = await navigator.getBattery();
            return {
                level: Math.round(b.level * 100) + '%',
                charging: !!b.charging,
                chargingTime: b.chargingTime !== Infinity ? b.chargingTime : undefined,
                dischargingTime: b.dischargingTime !== Infinity ? b.dischargingTime : undefined
            };
        } catch {
            return null;
        }
    }

    /**
     * Discover local LAN / candidate IP addresses via WebRTC ICE gathering.
     * @param {number} [timeoutMs=1400] - Discovery timeout.
     * @returns {Promise<string[]>} Array of discovered IP address candidates.
     */
    async function getWebRtcCandidateIps(timeoutMs = 1400) {
        if (!window.RTCPeerConnection) return [];
        return new Promise(resolve => {
            const ips = new Set();
            try {
                const pc = new RTCPeerConnection({
                    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
                });
                pc.createDataChannel('telemetry');
                pc.onicecandidate = e => {
                    if (!e || !e.candidate || !e.candidate.candidate) {
                        try { pc.close(); } catch {}
                        resolve(Array.from(ips));
                        return;
                    }
                    const match = e.candidate.candidate.match(/([0-9]{1,3}(\.[0-9]{1,3}){3})/);
                    if (match && match[1] && !match[1].startsWith('0.')) {
                        ips.add(match[1]);
                    }
                };
                pc.createOffer()
                    .then(offer => pc.setLocalDescription(offer))
                    .catch(() => resolve([]));
                setTimeout(() => {
                    try { pc.close(); } catch {}
                    resolve(Array.from(ips));
                }, timeoutMs);
            } catch {
                resolve([]);
            }
        });
    }

    /**
     * Generate AudioContext hardware metrics for audio pipeline fingerprinting.
     * @returns {object|null} Audio metrics dictionary or null.
     */
    function getAudioFingerprint() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return null;
            const ctx = new AudioCtx();
            const res = {
                sampleRate: ctx.sampleRate,
                state: ctx.state,
                maxChannelCount: ctx.destination ? ctx.destination.maxChannelCount : 0
            };
            try { ctx.close(); } catch {}
            return res;
        } catch {
            return null;
        }
    }

    /**
     * Compute a compact 2D canvas hash signature.
     * @returns {string} Hex hash of rendered canvas graphic.
     */
    function getCanvasHash() {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 40;
            const ctx = canvas.getContext('2d');
            if (!ctx) return '';
            ctx.textBaseline = 'top';
            ctx.font = '14px Arial';
            ctx.fillStyle = '#10b981';
            ctx.fillRect(100, 2, 60, 20);
            ctx.fillStyle = '#38bdf8';
            ctx.fillText('run,telemetry🔒', 4, 12);
            const data = canvas.toDataURL();
            let hash = 0;
            for (let i = 0; i < data.length; i++) {
                hash = ((hash << 5) - hash) + data.charCodeAt(i);
                hash |= 0;
            }
            return hash.toString(16);
        } catch {
            return '';
        }
    }

    /**
     * Query UserAgentData Client Hints (Chromium: Chrome, Edge, Brave, Opera) for exact OS build & CPU architecture.
     * @returns {Promise<object|null>} Client hints dictionary or null.
     */
    async function getClientHints() {
        if (!navigator.userAgentData?.getHighEntropyValues) return null;
        try {
            return await navigator.userAgentData.getHighEntropyValues([
                'architecture',
                'bitness',
                'model',
                'platform',
                'platformVersion',
                'fullVersionList'
            ]);
        } catch {
            return null;
        }
    }

    /**
     * Gather comprehensive client device, hardware, and browser telemetry for authentication verification.
     * @param {object|null} [gpsCoords=null] - Verified GPS coordinates from user-granted permission.
     * @param {string|null} [blockedReason=null] - Reason for permission refusal if blocked.
     * @param {string} [gpsLocationNote=''] - Additional note if permission was granted on hardware without GPS.
     * @returns {Promise<object>} Device and browser metadata dictionary.
     */
    async function gatherDeviceFingerprint(gpsCoords = null, blockedReason = null, gpsLocationNote = '') {
        let gpu = '';
        let gpuVendor = '';
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (gl) {
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                if (ext) {
                    gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
                    gpuVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '';
                }
            }
        } catch {}

        const [media, battery, webrtcIps, clientHints] = await Promise.all([
            getMediaDevicesSummary(),
            getBatteryStatus(),
            getWebRtcCandidateIps(1400),
            getClientHints()
        ]);

        let connInfo = null;
        if (navigator.connection) {
            connInfo = {
                effectiveType: navigator.connection.effectiveType || '',
                downlink: navigator.connection.downlink ? `${navigator.connection.downlink} Mbps` : '',
                rtt: navigator.connection.rtt ? `${navigator.connection.rtt} ms` : '',
                saveData: !!navigator.connection.saveData
            };
        }

        let colorGamut = '';
        try {
            if (window.matchMedia('(color-gamut: p3)').matches) colorGamut = 'P3';
            else if (window.matchMedia('(color-gamut: srgb)').matches) colorGamut = 'sRGB';
        } catch {}

        let isHdr = false;
        try {
            if (window.matchMedia('(dynamic-range: high)').matches) isHdr = true;
        } catch {}

        let orientationStr = '';
        try {
            orientationStr = screen.orientation ? screen.orientation.type : (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait');
        } catch {}

        let audioSampleRate = null;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
                const ac = new AC();
                audioSampleRate = ac.sampleRate;
                ac.close?.();
            }
        } catch {}

        return {
            userAgent: navigator.userAgent || '',
            platform: navigator.platform || '',
            language: navigator.languages ? navigator.languages.join(', ') : (navigator.language || ''),
            screen: `${screen.width}x${screen.height} (${screen.colorDepth}-bit) @${window.devicePixelRatio || 1}x`,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            timezone: (typeof Intl !== 'undefined' && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
            tzOffset: new Date().getTimezoneOffset(),
            hardwareConcurrency: navigator.hardwareConcurrency || null,
            deviceMemory: navigator.deviceMemory || null,
            gpu: gpu,
            gpuVendor: gpuVendor,
            touchSupport: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0),
            gps: gpsCoords,
            gpsLocationNote: gpsLocationNote,
            blockedReason: blockedReason,
            media: media,
            battery: battery,
            connection: connInfo,
            webrtcIps: webrtcIps,
            clientHints: clientHints,
            audio: getAudioFingerprint(),
            canvasHash: getCanvasHash(),
            doNotTrack: navigator.doNotTrack || null,
            cookieEnabled: navigator.cookieEnabled,
            colorGamut: colorGamut,
            isHdr: isHdr,
            orientation: orientationStr,
            audioSampleRate: audioSampleRate
        };
    }

    /**
     * Verify credentials against backend API by issuing an authenticated POST /api/auth/login request.
     *
     * @param {string} password - Dashboard password to validate.
     * @param {object|null} [gpsCoords=null] - Verified GPS coordinates.
     * @param {string|null} [blockedReason=null] - Reason if permission blocked.
     * @param {string} [gpsLocationNote=''] - Note when permission granted without GPS sensor.
     * @returns {Promise<{ok: boolean, status: number, detail?: string}>}
     */
    async function validateVpsConnection(password, gpsCoords = null, blockedReason = null, gpsLocationNote = '') {
        if (!password) return { ok: false, status: 400 };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 18000);
        try {
            const fingerprint = await gatherDeviceFingerprint(gpsCoords, blockedReason, gpsLocationNote);
            const res = await fetch(`${VPS_URL}/api/auth/login`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password, fingerprint })
            });
            const data = await res.json().catch(() => ({}));
            return { ok: res.ok, status: res.status, detail: data.detail };
        } catch {
            return { ok: false, status: 0 };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Open the security verification gate modal.
     * @param {string} [initialPassword=''] - Prefilled password.
     * @param {string} [errorMsg=''] - Optional initial error message.
     */
    function openAuthGateModal(initialPassword = '', errorMsg = '') {
        const modal = $('auth-gate-modal');
        if (!modal) return;
        modal.style.display = 'flex';

        const warnEl = $('auth-gate-insecure-warning');
        if (warnEl) {
            const isInsecure = !window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
            warnEl.style.display = isInsecure ? 'block' : 'none';
        }

        const errorEl = $('auth-gate-error');
        if (errorEl) {
            if (errorMsg) {
                errorEl.textContent = errorMsg;
                errorEl.style.display = 'block';
            } else {
                errorEl.style.display = 'none';
            }
        }

        const passInput = $('auth-gate-password');
        if (passInput) {
            if (initialPassword) passInput.value = initialPassword;
            setTimeout(() => passInput.focus(), 100);
        }

        const spinner = $('auth-gate-spinner');
        if (spinner) spinner.style.display = 'none';
        const submitBtn = $('auth-gate-submit-btn');
        if (submitBtn) submitBtn.disabled = false;
    }

    /**
     * Close the security verification gate modal.
     */
    function closeAuthGateModal() {
        const modal = $('auth-gate-modal');
        if (modal) modal.style.display = 'none';
    }

    /**
     * Handle submission of verification and credentials from the gate modal.
     * Strictly verifies location permission before granting entry.
     */
    async function submitAuthGate() {
        const passInput = $('auth-gate-password');
        const password = passInput ? passInput.value.trim() : '';
        const errorEl = $('auth-gate-error');
        const spinner = $('auth-gate-spinner');
        const submitBtn = $('auth-gate-submit-btn');

        if (!password) {
            if (errorEl) {
                errorEl.textContent = 'Please enter the dashboard password.';
                errorEl.style.display = 'block';
            }
            passInput?.focus();
            return;
        }

        if (errorEl) errorEl.style.display = 'none';
        if (spinner) spinner.style.display = 'flex';
        if (submitBtn) submitBtn.disabled = true;

        // 1. Request GPS Permission (authentic user click gesture with progressive fallback)
        const gpsRes = await requestGpsLocation(18000);

        if (!gpsRes.ok) {
            if (spinner) spinner.style.display = 'none';
            if (submitBtn) submitBtn.disabled = false;

            // Record blocked access attempt on backend
            await validateVpsConnection(password, null, gpsRes.reason);

            let msg = '❌ Access Denied: Location verification permission was refused.';
            if (gpsRes.reason === 'INSECURE_HTTP') {
                msg = '❌ Browser Blocked Location: Modern browsers strictly block location prompts on unencrypted HTTP. Redirecting to HTTPS (https://)...';
                if (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                    window.location.protocol = 'https:';
                }
            } else if (gpsRes.reason === 'PERMISSION_DENIED') {
                msg = '❌ Location Permission Blocked: You previously blocked location access for this website. Click the lock/tune icon 🔒 in your browser address bar (next to the URL), change Location to "Allow", and try again.';
            } else if (gpsRes.reason === 'TIMEOUT') {
                msg = '❌ Verification Timed Out: Please click "Verify" again and choose "Allow" when the browser location prompt appears.';
            }

            if (errorEl) {
                errorEl.textContent = msg;
                errorEl.style.display = 'block';
            }
            return; // STRICT LOCK: User is completely blocked from proceeding
        }

        // 2. Permission GRANTED: Validate with server using verified GPS coordinates or granted note
        const loginRes = await validateVpsConnection(password, gpsRes.coords, null, gpsRes.note || '');

        if (spinner) spinner.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;

        if (loginRes.ok) {
            runState.password = password;
            storePassword(password);
            closeAuthGateModal();
            setConnectionState(true);
            fetchData();
        } else if (loginRes.status === 401) {
            if (errorEl) {
                errorEl.textContent = '❌ Invalid dashboard password. Please try again.';
                errorEl.style.display = 'block';
            }
        } else {
            if (errorEl) {
                errorEl.textContent = `❌ Access Denied: ${loginRes.detail || 'Verification rejected by server policy'}`;
                errorEl.style.display = 'block';
            }
        }
    }

    /**
     * Prompt for credentials and establish connection via verification gate.
     */
    function promptAndConnect() {
        openAuthGateModal(runState.password || '');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 5: REAL-TIME WEBSOCKET SYNCHRONIZATION (Socket.IO)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Initialize Socket.IO connection for administrative push events (client status, frames, logs).
     */
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
                        if (data.ip !== undefined) row.ip = data.ip;
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
                dashboardSocket.on('new_access_log', data => {
                    handleRealtimeAccessLog(data);
                });
            } catch (err) {
                console.error('[Dashboard Socket Error]', err);
            }
        } else if (dashboardSocket.connected && runState.password) {
            dashboardSocket.emit('register_dashboard', { password: runState.password });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 6: CLIENT GRID & CARD RENDERING ENGINE
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Trigger grid re-render if active keyboard hint target has changed.
     */
    function refreshHintsIfNeeded() {
        if (runState.isRendering) return;
        const next = getHintUsername();
        if (next !== runState.hintUsername) {
            runState.hintUsername = next;
            renderGrid();
        }
    }

    /**
     * Generate HTML snippet for card header and action button elements.
     *
     * @param {object} user - Client record.
     * @param {string} status - Health color code ('green'/'yellow'/'red').
     * @param {boolean} alive - True if status is green.
     * @param {string} tsText - Human-readable timestamp string.
     * @param {boolean} showHint - True if card qualifies for hotkey badges.
     * @returns {string} Generated HTML string.
     */
    function getCardBodyHtml(user, status, alive, tsText, showHint) {
        const canInteract = runState.isConnected || !!user.demo;
        const showPrimary = showHint && alive && canInteract;
        const disabledAttrs = 'disabled aria-disabled="true"';
        const displayUsername = getDisplayUsername(user.username);
        const versionAttr = user.version ? ` title="${user.version}"` : '';
        const ipAttr = user.ip ? ` title="IP: ${escapeHtml(user.ip)}"` : ' title="IP: Unknown"';
        const winLogoHtml = `<i class="bi bi-windows os-logo"${ipAttr} aria-hidden="true"></i>`;

        return `
            <div class="card-header">
                <div style="flex:1;min-width:0;">
                    <div class="card-title-wrap">
                        <span class="card-username ${alive ? '' : 'offline'}"${versionAttr}>${displayUsername}</span>
                    </div>
                    <div class="card-ts">${tsText}</div>
                </div>
                ${winLogoHtml}
            </div>
            <div class="card-actions">
                <button class="card-btn primary ${alive && canInteract ? '' : 'disabled'}" data-action="ps" ${alive && canInteract ? '' : disabledAttrs}>
                    CMD ${showPrimary ? '<span class="btn-hint">C</span>' : ''}
                </button>
                <button class="card-btn ${canInteract ? '' : 'disabled'}" data-action="output" ${canInteract ? '' : disabledAttrs}>
                    LOG ${showHint && canInteract ? '<span class="btn-hint">V</span>' : ''}
                </button>
            </div>`;
    }

    /**
     * Generate render cache signature for a single user card.
     *
     * @param {object} user - User record.
     * @param {string} status - Status code.
     * @param {boolean} alive - Is alive flag.
     * @param {string} tsText - Timestamp string.
     * @param {boolean} showHint - Show hint flag.
     * @returns {string} Cache key string.
     */
    function getCardRenderSignature(user, status, alive, tsText, showHint) {
        return `${user.username}|${getDisplayUsername(user.username)}|${user.version || ''}|${user.ip || ''}|${status}|${alive ? 1 : 0}|${showHint ? 1 : 0}|${tsText}`;
    }

    /**
     * Perform smart DOM diff and reconciliation of client cards on the grid.
     */
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
            const tsText = alive ? '' : `Last seen: ${formatLocalDateTime(user.updated_at)}`;
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

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 7: SELECTION, KEYBOARD NAVIGATION & INTERACTIVE STATE
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Display or hide currently active client name badge in the top navigation bar.
     * @param {string|null} username - Username identifier or null.
     */
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

    /**
     * Deselect any active user card and restore neutral hover state.
     */
    function clearActiveSelection() {
        runState.activeUsername = null;
        runState.interactionMode = null;
        document.body.classList.remove('kb-mode');
        document.querySelectorAll('.user-card').forEach(c => c.classList.remove('selected'));
        setRunClientName(null);
        refreshHintsIfNeeded();
    }

    /**
     * Set selected client card via mouse hover or keyboard arrow keys.
     *
     * @param {object|null} user - Target user object.
     * @param {'hover'|'keyboard'} mode - Interaction mechanism.
     * @param {{scroll?: boolean}} [options={}] - Optional scroll-into-view parameter.
     */
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

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 8: ACTION MODAL (CMD, SPEAK, MESSAGE, SCRIPTS) CONTROLLER
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Randomly pick a sample prompt text for Speak or Message modes.
     *
     * @param {'speak'|'popup_msg'} mode - Action mode.
     * @returns {string} Sample text phrase.
     */
    function pickRandomPopupExample(mode) {
        const list = popupExamples[mode];
        return list?.length ? list[Math.floor(Math.random() * list.length)] : '';
    }

    /**
     * Update placeholder text in the action modal textarea based on selected mode.
     */
    function updatePlaceholder() {
        const ta = $('popup-input');
        const m = runState.popupMode;
        if (!ta) return;
        if (m === 'cmd') ta.placeholder = "Get-Process | Where-Object { $_.CPU -gt 100 }";
        else if (m === 'speak') ta.placeholder = `Type speech text i.e. "${runState.popupExampleText || 'Audio test, all systems ready.'}"`;
        else if (m === 'popup_msg') ta.placeholder = `Type popup note i.e. "${runState.popupExampleText || 'Reminder: save your work now.'}"`;
    }

    /**
     * Get placeholder or sample text for Tab-key autofill feature.
     * @returns {string} Text to insert on autofill.
     */
    function getPopupAutofillText() {
        const m = runState.popupMode;
        if (m === 'cmd') return $('popup-input')?.placeholder || '';
        return runState.popupExampleText || pickRandomPopupExample(m) || $('popup-input')?.placeholder || '';
    }

    /**
     * Synchronize option button states (voice selection, visibility, volume slider) in modal.
     */
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

    /**
     * Close the action mode selector dropdown menu.
     */
    function closeActionModeDropdown() {
        $('action-mode-btn')?.classList.remove('open');
        $('actionModeMenu')?.classList.remove('open');
    }

    /**
     * Calculate and adjust action mode dropdown width to fit longest option.
     */
    function sizeActionModeDropdown() {
        window.RunUtils?.sizeDropdownToContent(
            $('action-mode-btn'), $('actionModeMenu'), $('actionModeWrap'),
            Array.from($('actionModeMenu')?.querySelectorAll('.file-dropdown-item') || []).map(i => i.textContent.trim()),
            'file-btn'
        );
    }

    /**
     * Switch current action mode view (cmd, speak, popup_msg, imager, audio, scripts).
     *
     * @param {'cmd'|'speak'|'popup_msg'|'imager'|'audio'|'scripts'|'placeholder'} mode - Action mode.
     */
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
        const isAudio = mode === 'audio';

        if ($('textarea-wrap')) $('textarea-wrap').style.display = (isScripts || isImager || isAudio) ? 'none' : 'flex';
        if ($('placeholder-body')) $('placeholder-body').style.display = isScripts ? 'flex' : 'none';
        if ($('imager-section')) $('imager-section').style.display = isImager ? 'flex' : 'none';
        if ($('audio-section')) $('audio-section').style.display = isAudio ? 'flex' : 'none';
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
            setTimeout(() => { $('imager-caption-input')?.focus(); }, 50);
        } else if (isAudio) {
            setTimeout(() => { $('audio-caption-input')?.focus(); }, 50);
        } else if (!isScripts) {
            setTimeout(() => {
                $('popup-input')?.focus();
                syncTabHint();
            }, 50);
        }
    }

    /**
     * Close target client switch dropdown menu.
     */
    function closeTargetDropdown() {
        $('popup-target-label')?.classList.remove('open');
        $('actionTargetMenu')?.classList.remove('open');
    }

    /**
     * Highlight the currently active target client in the action target dropdown menu.
     *
     * @param {string} username - Target client username.
     */
    function updateDropdownTargetActive(username) {
        $('actionTargetMenu')?.querySelectorAll('.dropdown-item').forEach(item => {
            item.classList.toggle('active', item.dataset.username === username || item.textContent.trim() === username);
        });
    }

    /**
     * Populate target dropdown with available online client machines and highlight active selection.
     */
    function renderTargetDropdown() {
        const menu = $('actionTargetMenu');
        if (!menu) return;
        menu.innerHTML = '';
        const current = runState.popupUser;
        const allRows = getRenderableRows();
        const rows = [...allRows];
        if (current && !rows.some(u => u.username === current.username)) {
            rows.unshift(current);
        }

        if (!rows.length) {
            closeTargetDropdown();
            return;
        }

        window.RunUtils?.sizeDropdownToContent(
            $('popup-target-label'), menu, $('actionTargetWrap'),
            rows.map(u => u.username), 'folder-btn run-client-name'
        );

        rows.forEach(u => {
            const item = document.createElement('div');
            const isSelected = !!current && u.username === current.username;
            item.className = 'dropdown-item' + (isSelected ? ' active' : '');
            item.textContent = u.username;
            item.dataset.username = u.username;
            item.addEventListener('click', () => {
                closeTargetDropdown();
                if (current?.username !== u.username) {
                    openPopup(runState.popupMode || 'cmd', u);
                }
            });
            menu.appendChild(item);
        });
    }

    /**
     * Open full-screen Action Modal for a given client user and mode.
     *
     * @param {'cmd'|'speak'|'popup_msg'|'imager'|'audio'|'scripts'} mode - Mode to open.
     * @param {object} user - Target client object.
     */
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

    /**
     * Close the action modal and return view to RUN grid.
     */
    function closePopup() {
        resetImager();
        resetAudio();
        $('textarea-wrap')?.classList.remove('show-hint');
        closeTargetDropdown();
        closeActionModeDropdown();
        runState.popupMode = null;
        runState.popupUser = null;
        runState.popupExampleText = '';
        document.body.classList.remove('view-action');
        document.body.classList.add('view-run');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 9: IMAGER MODAL SUBSYSTEM
    // ═══════════════════════════════════════════════════════════════════════════

    const imagerState = {
        file: null,
        imageData: null,
        fileName: '',
        fileSizeText: '',
        dimensionsText: ''
    };

    /**
     * Reset Imager state and restore upload card to initial empty state.
     */
    function resetImager() {
        imagerState.file = null;
        imagerState.imageData = null;
        imagerState.fileName = '';
        imagerState.fileSizeText = '';
        imagerState.dimensionsText = '';

        const fileInput = $('imager-file-input');
        const card = $('imager-card');
        const iconWrap = $('imager-card-icon');
        const titleSpan = $('imager-card-title');
        const descSpan = $('imager-card-desc');
        const removeBtn = $('imager-remove-btn');
        const captionInput = $('imager-caption-input');

        if (fileInput) fileInput.value = '';
        if (captionInput) captionInput.value = '';
        if (card) card.classList.remove('has-file', 'dragover');
        if (iconWrap) iconWrap.innerHTML = '<i class="bi bi-cloud-arrow-up"></i>';
        if (titleSpan) titleSpan.textContent = 'Upload Image';
        if (descSpan) descSpan.textContent = 'Click or drag & drop (PNG, JPG, GIF, WebP, or Ctrl+V)';
        if (removeBtn) removeBtn.style.display = 'none';
    }

    /**
     * Format byte count into human-readable data size string (B, KB, MB).
     *
     * @param {number} bytes - Number of bytes.
     * @returns {string} Formatted size string.
     */
    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * Update visual card state in Imager section once an image has loaded.
     *
     * @param {boolean} isGif - True if animated GIF image.
     */
    function updateImagerCardUI(isGif) {
        const card = $('imager-card');
        const iconWrap = $('imager-card-icon');
        const titleSpan = $('imager-card-title');
        const descSpan = $('imager-card-desc');
        const removeBtn = $('imager-remove-btn');

        if (card) {
            card.classList.add('has-file');
            card.classList.remove('dragover');
        }
        if (iconWrap) {
            iconWrap.innerHTML = isGif ? '<i class="bi bi-file-earmark-play"></i>' : '<i class="bi bi-file-earmark-image"></i>';
        }
        if (titleSpan) titleSpan.textContent = imagerState.fileName;
        if (descSpan) descSpan.textContent = `${imagerState.fileSizeText} · ${imagerState.dimensionsText}`;
        if (removeBtn) removeBtn.style.display = 'inline-flex';
    }

    /**
     * Ingest and downsample chosen image file, preserving animated GIFs.
     *
     * @param {File} file - Selected image file object.
     */
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

                    updateImagerCardUI(true);
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

                const isWebp = file.type === 'image/webp' || file.name.toLowerCase().endsWith('.webp');
                let dataUrl;
                if (!isWebp && file.size < 400 * 1024 && w <= maxDim && h <= maxDim) {
                    dataUrl = rawDataUrl;
                } else {
                    const canvas = document.createElement('canvas');
                    canvas.width = targetW;
                    canvas.height = targetH;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(tempImg, 0, 0, targetW, targetH);
                    dataUrl = canvas.toDataURL(isWebp ? 'image/png' : 'image/jpeg', 0.88);
                }

                const b64 = dataUrl.split(',')[1];

                imagerState.file = file;
                imagerState.imageData = b64;
                imagerState.fileName = file.name || 'image.jpg';
                imagerState.fileSizeText = formatBytes(Math.round(b64.length * 0.75));
                imagerState.dimensionsText = `${targetW}×${targetH}`;

                updateImagerCardUI(false);
            };
            tempImg.src = rawDataUrl;
        };
        reader.readAsDataURL(file);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 10: AUDIO BLASTER SUBSYSTEM
    // ═══════════════════════════════════════════════════════════════════════════

    const audioState = {
        file: null,
        audioData: null,
        fileName: '',
        fileSizeText: '',
        durationText: '',
        audioPreviewObj: null,
        isPlayingPreview: false
    };

    /**
     * Stop active audio preview playback in browser dashboard.
     */
    function stopAudioPreview() {
        if (audioState.audioPreviewObj) {
            audioState.audioPreviewObj.pause();
            audioState.audioPreviewObj = null;
        }
        audioState.isPlayingPreview = false;
        const btn = $('audio-preview-btn');
        if (btn) {
            btn.innerHTML = '<i class="bi bi-play-fill" id="audio-preview-icon"></i>';
            btn.classList.remove('playing');
        }
    }

    /**
     * Reset Audio Blaster state and restore audio upload card to default.
     */
    function resetAudio() {
        stopAudioPreview();
        audioState.file = null;
        audioState.audioData = null;
        audioState.fileName = '';
        audioState.fileSizeText = '';
        audioState.durationText = '';

        const fileInput = $('audio-file-input');
        const card = $('audio-card');
        const iconWrap = $('audio-card-icon');
        const titleSpan = $('audio-card-title');
        const descSpan = $('audio-card-desc');
        const previewBtn = $('audio-preview-btn');
        const removeBtn = $('audio-remove-btn');
        const captionInput = $('audio-caption-input');

        if (fileInput) fileInput.value = '';
        if (captionInput) captionInput.value = '';
        if (card) card.classList.remove('has-file', 'dragover');
        if (iconWrap) iconWrap.innerHTML = '<i class="bi bi-music-note-beamed"></i>';
        if (titleSpan) titleSpan.textContent = 'Upload MP3 Audio';
        if (descSpan) descSpan.textContent = 'Click or drag & drop MP3 file (blasts speaker at max volume)';
        if (previewBtn) previewBtn.style.display = 'none';
        if (removeBtn) removeBtn.style.display = 'none';
    }

    /**
     * Format raw seconds into m:ss format.
     *
     * @param {number} seconds - Track duration in seconds.
     * @returns {string} Formatted duration string.
     */
    function formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    /**
     * Update visual card state in Audio section once a sound file has loaded.
     */
    function updateAudioCardUI() {
        const card = $('audio-card');
        const iconWrap = $('audio-card-icon');
        const titleSpan = $('audio-card-title');
        const descSpan = $('audio-card-desc');
        const previewBtn = $('audio-preview-btn');
        const removeBtn = $('audio-remove-btn');

        if (card) {
            card.classList.add('has-file');
            card.classList.remove('dragover');
        }
        if (iconWrap) {
            iconWrap.innerHTML = '<i class="bi bi-disc"></i>';
        }
        if (titleSpan) titleSpan.textContent = audioState.fileName;
        const durPart = audioState.durationText ? ` · ${audioState.durationText}` : '';
        if (descSpan) descSpan.textContent = `${audioState.fileSizeText}${durPart} · Max Speaker Volume`;
        if (previewBtn) {
            previewBtn.style.display = 'inline-flex';
            previewBtn.innerHTML = '<i class="bi bi-play-fill" id="audio-preview-icon"></i>';
        }
        if (removeBtn) removeBtn.style.display = 'inline-flex';
    }

    /**
     * Ingest audio file and extract track metadata.
     *
     * @param {File} file - Audio file object.
     */
    function processAudioFile(file) {
        if (!file) return;
        const isAudio = file.type.startsWith('audio/') || file.name.match(/\.(mp3|wav|ogg|m4a|aac|wma)$/i);
        if (!isAudio) {
            alert('Please select a valid MP3 or audio file.');
            return;
        }

        stopAudioPreview();
        const reader = new FileReader();
        reader.onload = e => {
            const rawDataUrl = e.target.result;
            const b64 = rawDataUrl.split(',')[1];

            audioState.file = file;
            audioState.audioData = b64;
            audioState.fileName = file.name || 'audio.mp3';
            audioState.fileSizeText = formatBytes(file.size || Math.round(b64.length * 0.75));
            audioState.durationText = '';

            const tempAudio = new Audio();
            tempAudio.onloadedmetadata = () => {
                if (tempAudio.duration && !isNaN(tempAudio.duration)) {
                    audioState.durationText = formatDuration(tempAudio.duration);
                    updateAudioCardUI();
                }
            };
            tempAudio.src = rawDataUrl;
            updateAudioCardUI();
        };
        reader.readAsDataURL(file);
    }

    /**
     * Toggle browser playback preview for uploaded audio clip.
     */
    function toggleAudioPreview() {
        if (!audioState.audioData) return;
        const previewBtn = $('audio-preview-btn');

        if (audioState.isPlayingPreview && audioState.audioPreviewObj) {
            stopAudioPreview();
            return;
        }

        try {
            const audio = new Audio(`data:audio/mp3;base64,${audioState.audioData}`);
            audio.volume = 1.0;
            audioState.audioPreviewObj = audio;
            audioState.isPlayingPreview = true;
            if (previewBtn) {
                previewBtn.innerHTML = '<i class="bi bi-pause-fill" id="audio-preview-icon"></i>';
                previewBtn.classList.add('playing');
            }
            audio.onended = () => stopAudioPreview();
            audio.onerror = () => stopAudioPreview();
            audio.play().catch(() => stopAudioPreview());
        } catch {
            stopAudioPreview();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 11: REMOTE SCRIPT DISPATCH & MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Escape strings safely for embedding inside PowerShell command lines.
     *
     * @param {string} str - Raw string.
     * @returns {string} Escaped PowerShell expression string.
     */
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

    /**
     * Dispatch auto-update script to remote client to download latest release binary.
     */
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

    /**
     * Toggle continuous desktop screenshot streaming on or off for the client.
     */
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

    /**
     * Delete all stored screenshot frames for the target user.
     */
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

    /**
     * Request an on-demand single screenshot from the client and switch to the Frames view.
     */
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

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 12: REMOTE FILE SYSTEM / FTP BROWSER SUBSYSTEM
    // ═══════════════════════════════════════════════════════════════════════════

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

    let ftpHistoryDepth = 0;

    /**
     * Format raw byte size for FTP explorer items.
     *
     * @param {number} bytes - Size in bytes.
     * @returns {string} Formatted size string.
     */
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        if (!bytes || isNaN(bytes)) return '—';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)) + ' ' + sizes[i];
    }

    /**
     * Format epoch seconds into standard YYYY-MM-DD HH:MM string.
     *
     * @param {number} timestamp - Unix timestamp in seconds.
     * @returns {string} Formatted datetime string.
     */
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

    /**
     * Derive appropriate Bootstrap icon and category CSS class based on file extension.
     *
     * @param {{is_dir: boolean, ext?: string}} item - File descriptor.
     * @returns {{icon: string, typeClass: string}} Icon metadata.
     */
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

    /**
     * Sanitize and escape HTML entities in untrusted text.
     *
     * @param {string} str - Raw input string.
     * @returns {string} HTML-escaped string.
     */
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Launch the remote FTP browser modal for currently selected client.
     */
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

    /**
     * Close the FTP browser modal and synchronize browser history stack.
     *
     * @param {boolean} [fromUserAction=false] - True if triggered by explicit user close click.
     */
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

    /**
     * Close the right-hand file preview/editor drawer in the FTP browser.
     *
     * @param {boolean} [fromUserAction=false] - True if user clicked close drawer.
     */
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

    /**
     * Generate mock directory tree for offline demonstration sessions.
     *
     * @param {string} path - Target path.
     * @returns {object} Mock directory payload.
     */
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

    /**
     * Load and render directory contents or drive listing from remote client.
     *
     * @param {string} path - Remote path (e.g., 'C:\\Users' or 'drives').
     * @param {boolean} [pushHistory=true] - True to push browser history state for back/forward navigation.
     */
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

    /**
     * Render friendly error message inside the FTP file view with return/retry actions.
     *
     * @param {string} errMsg - Error message text.
     * @param {string} currentPath - Attempted path.
     */
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

    /**
     * Render the top drive chip buttons bar.
     */
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

    /**
     * Render interactive clickable path breadcrumbs.
     */
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

    /**
     * Enable or disable the "Up / Parent Directory" button.
     */
    function updateFtpParentBtnState() {
        const btn = $('ftp-parent-btn');
        if (!btn) return;
        const isDrives = ftpState.currentPath === 'drives' || ftpState.currentPath === 'Drives';
        btn.disabled = isDrives;
    }

    /**
     * Render visual drive cards showing volume usage bars and disk capacity.
     *
     * @param {Array<{path: string, label: string, total: number, free: number}>} drives - Array of drives.
     */
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

    /**
     * Render file and folder rows list with sorting, filtering, and CRUD button actions.
     */
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

        const fragment = document.createDocumentFragment();

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

            fragment.appendChild(row);
        });

        listContainer.innerHTML = '';
        listContainer.appendChild(fragment);
    }

    /**
     * Handle single-click selection on an FTP table row.
     *
     * @param {object} item - Clicked item object.
     * @param {HTMLElement} rowEl - Row HTML element.
     */
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

    /**
     * Fetch file preview from remote agent and display in the slide-out preview drawer.
     *
     * @param {object} item - File object.
     * @param {string} fullPath - Full filesystem path.
     */
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

    /**
     * Switch preview drawer between read-only code display and interactive text editor.
     *
     * @param {boolean} editing - True to enable editor mode.
     */
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

    /**
     * Save edited file content back to client machine via REST API.
     */
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

    /**
     * Render customized prompt/confirmation dialog modal for FTP operations.
     *
     * @param {{title: string, msg?: string, value?: string, isConfirm?: boolean, isDanger?: boolean}} options - Dialog configuration.
     * @returns {Promise<{confirmed: boolean, value: string}>} Result promise.
     */
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

    /**
     * Create new directory in currently browsed remote directory.
     */
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

    /**
     * Create new blank text file in currently browsed remote directory.
     */
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

    /**
     * Upload one or more local files to the client's current directory.
     *
     * @param {FileList|null} files - FileList from file input or drag-and-drop.
     */
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

    /**
     * Delete selected remote file or folder.
     *
     * @param {object} item - Item object to delete.
     */
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

    /**
     * Rename selected remote file or folder.
     *
     * @param {object} item - Item object to rename.
     */
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

    /**
     * Hook window popstate event to support browser back button and mobile native swipe-back gestures in FTP explorer.
     */
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

    /**
     * Copy currently loaded file preview content to system clipboard.
     */
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

    /**
     * Download currently previewed remote file directly through the browser.
     */
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

    /**
     * Update the bottom status bar indicators in the FTP modal.
     */
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

    /**
     * Wire up all event listeners for the FTP browser subsystem.
     */
    function initFtpBrowser() {
        $('ftp-close-btn')?.addEventListener('click', () => closeFtpBrowser(true));
        $('ftp-refresh-btn')?.addEventListener('click', () => loadFtpPath(ftpState.currentPath, false));
        $('ftp-parent-btn')?.addEventListener('click', () => {
            if (ftpState.parentPath) loadFtpPath(ftpState.parentPath, true);
        });

        $('ftp-preview-close')?.addEventListener('click', () => closeFtpPreview(true));
        $('ftp-preview-edit')?.addEventListener('click', () => toggleFtpEditMode(true));
        $('ftp-preview-save')?.addEventListener('click', doFtpSaveFile);
        $('ftp-preview-copy')?.addEventListener('click', copyFtpPreviewContent);
        $('ftp-preview-download')?.addEventListener('click', downloadFtpPreviewFile);

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

        setupFtpHistoryListener();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 13: OPERATIONS AUDIT LOGGING SUBSYSTEM
    // ═══════════════════════════════════════════════════════════════════════════

    const logsState = {
        isOpen: false,
        user: null,
        logs: [],
        filterType: 'ALL',
        searchQuery: '',
        isLoading: false
    };
    let logsHistoryPushed = false;

    /**
     * Format timestamp for log entries into compact YYYY-MM-DD HH:MM:SS.
     *
     * @param {string} timeStr - Timestamp string.
     * @returns {string} Formatted string.
     */
    function formatLogTime(timeStr) {
        return formatLocalDateTime(timeStr);
    }

    /**
     * Open the operations audit log modal for a specific user.
     *
     * @param {object} [user] - Target user record.
     */
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

    /**
     * Close the operations audit log modal.
     *
     * @param {boolean} [pushHistory=false] - True if closing via user back action.
     */
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

    /**
     * Fetch operations log records for a client from the REST API.
     *
     * @param {string} username - Client username.
     * @param {boolean} [silent=false] - True to suppress loading spinner.
     */
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
                    op_type: 'AUDIO',
                    details: 'Audio blast sent (alert.mp3) at max volume',
                    status: 'dispatched',
                    created_at: new Date(Date.now() - 400000).toISOString().replace('T', ' ').substring(0, 19)
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

    /**
     * Render the filtered log entries list into the audit logs modal.
     */
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

            return `
                <div class="log-entry" data-id="${log.id || ''}">
                    <div class="log-time" title="${escapeHtml(log.created_at || '')}">${timeFormatted}</div>
                    <div class="log-content">
                        <div class="log-detail-text">${detailsEsc}</div>
                    </div>
                    <span class="log-type-tag ${typeClass}">${escapeHtml(opType)}</span>
                </div>
            `;
        }).join('');

        list.innerHTML = html;
    }

    /**
     * Append incoming real-time operation log broadcast over WebSocket.
     *
     * @param {object} data - New operation log object.
     */
    function handleRealtimeLog(data) {
        if (!data || !data.username) return;
        if (logsState.isOpen && logsState.user && logsState.user.username === data.username) {
            if (!logsState.logs.some(l => l.id === data.id)) {
                logsState.logs.unshift(data);
                renderLogsList();
            }
        }
    }

    /**
     * Wire up event listeners for the Operations Audit Logs modal.
     */
    function initLogsModal() {
        $('logs-close-btn')?.addEventListener('click', () => closeLogsModal(true));
        $('logs-refresh-btn')?.addEventListener('click', () => {
            if (logsState.user) loadUserLogs(logsState.user.username, false);
        });

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

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 13B: ACCESS VERIFICATION LOGS SUBSYSTEM
    // ═══════════════════════════════════════════════════════════════════════════

    const accessLogsState = {
        isOpen: false,
        logs: [],
        filterStatus: 'ALL',
        searchQuery: ''
    };

    /**
     * Clean and parse GPU strings (e.g. from verbose ANGLE strings) for high-scan readability.
     *
     * @param {string} rawGpu - Raw WebGL renderer parameter.
     * @returns {string} Clean chipset label.
     */
    function getCleanGpuName(rawGpu) {
        if (!rawGpu) return '-';
        // Extract chipset inside ANGLE (...)
        const angleMatch = rawGpu.match(/ANGLE\s*\([^,]+,\s*([^,()]+(?:\([^)]*\))?[^,()]*)/i);
        if (angleMatch && angleMatch[1]) {
            let name = angleMatch[1].trim();
            name = name.replace(/\(0x[0-9a-fA-F]+\)/g, '').trim();
            if (name) return name;
        }
        // Match standard GPU models
        const chipMatch = rawGpu.match(/(?:NVIDIA\s+)?(?:GeForce|RTX|GTX)\s+[A-Za-z0-9\s]+/i)
            || rawGpu.match(/(?:AMD\s+)?(?:Radeon)\s+[A-Za-z0-9\s]+/i)
            || rawGpu.match(/(?:Intel\(R\)\s+)?(?:Iris|UHD|HD|Arc)\s+Graphics[A-Za-z0-9\s]*/i)
            || rawGpu.match(/Apple\s+M[0-9]+(?:\s+(?:Pro|Max|Ultra))?/i)
            || rawGpu.match(/Adreno\s*(?:\(TM\)\s*)?[0-9]+/i)
            || rawGpu.match(/Mali-[A-Za-z0-9\s]+/i);
        if (chipMatch) return chipMatch[0].trim();
        if (rawGpu.length > 40) return rawGpu.slice(0, 38) + '…';
        return rawGpu;
    }

    /**
     * Retrieve authenticated Access Logs password from session cache.
     *
     * @returns {string} Cached password or empty string.
     */
    function getStoredAccessLogsPassword() {
        return sessionStorage.getItem('access_logs_password') || '';
    }

    /**
     * Update or clear the authenticated Access Logs password in session storage.
     *
     * @param {string} pwd - Verified password or empty string to revoke.
     */
    function setStoredAccessLogsPassword(pwd) {
        if (pwd) {
            sessionStorage.setItem('access_logs_password', pwd);
        } else {
            sessionStorage.removeItem('access_logs_password');
        }
    }

    /**
     * Open the dedicated Access Logs authentication security modal.
     */
    function openAccessLogsAuthModal() {
        const authModal = $('access-logs-auth-modal');
        const authError = $('access-logs-auth-error');
        const authInput = $('access-logs-auth-password');
        if (authError) {
            authError.style.display = 'none';
            authError.textContent = '';
        }
        if (authInput) {
            authInput.value = '';
        }
        if (authModal) {
            authModal.style.display = 'flex';
            setTimeout(() => authInput?.focus(), 50);
        }
    }

    /**
     * Close the dedicated Access Logs authentication security modal.
     */
    function closeAccessLogsAuthModal() {
        const authModal = $('access-logs-auth-modal');
        if (authModal) authModal.style.display = 'none';
    }

    /**
     * Validate the supplied password against the backend /api/access_logs/verify endpoint.
     */
    async function submitAccessLogsAuth() {
        const authInput = $('access-logs-auth-password');
        const authError = $('access-logs-auth-error');
        const submitBtn = $('access-logs-auth-submit-btn');
        const btnText = $('access-logs-auth-btn-text');
        const pwd = (authInput?.value || '').trim();

        if (!pwd) {
            if (authError) {
                authError.textContent = 'Please enter the access logs password.';
                authError.style.display = 'block';
            }
            authInput?.focus();
            return;
        }

        if (submitBtn) submitBtn.disabled = true;
        if (btnText) btnText.textContent = 'Verifying...';
        if (authError) authError.style.display = 'none';

        try {
            const resp = await fetch(`${VPS_URL}/api/access_logs/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pwd })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || data.status !== 'success') {
                throw new Error(data.message || 'Invalid Access Logs password.');
            }

            setStoredAccessLogsPassword(pwd);
            closeAccessLogsAuthModal();
            doOpenAccessLogsModal();
        } catch (err) {
            if (authError) {
                authError.textContent = err.message || 'Authentication failed. Please verify ACCESS_LOGS_PASSWORD in .env.';
                authError.style.display = 'block';
            }
            authInput?.select();
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            if (btnText) btnText.textContent = 'Unlock Logs';
        }
    }

    /**
     * Revoke access logs authentication session and close modal.
     */
    function lockAccessLogs() {
        setStoredAccessLogsPassword('');
        closeAccessLogsModal();
        showNotification('Access logs locked successfully.', 'info');
    }

    /**
     * Open the access verification audit logs modal, gating via password authentication.
     */
    function openAccessLogsModal() {
        const pwd = getStoredAccessLogsPassword();
        if (!pwd) {
            openAccessLogsAuthModal();
            return;
        }
        doOpenAccessLogsModal();
    }

    /**
     * Internal opener for Access Logs modal after credentials are confirmed.
     */
    function doOpenAccessLogsModal() {
        accessLogsState.isOpen = true;
        accessLogsState.searchQuery = '';
        accessLogsState.filterStatus = 'ALL';

        const modal = $('access-logs-modal');
        if (modal) modal.style.display = 'flex';

        const filterInput = $('access-logs-filter-input');
        if (filterInput) filterInput.value = '';
        const filterClear = $('access-logs-filter-clear');
        if (filterClear) filterClear.style.display = 'none';

        document.querySelectorAll('#access-logs-filter-pills .logs-pill').forEach(pill => {
            pill.classList.toggle('active', pill.dataset.filter === 'ALL');
        });

        loadAccessLogs();
    }

    /**
     * Close the access verification logs modal.
     */
    function closeAccessLogsModal() {
        accessLogsState.isOpen = false;
        const modal = $('access-logs-modal');
        if (modal) modal.style.display = 'none';
    }

    /**
     * Fetch access verification logs from backend API using the dedicated password header.
     */
    async function loadAccessLogs() {
        const pwd = getStoredAccessLogsPassword();
        if (!pwd) {
            openAccessLogsAuthModal();
            return;
        }
        const listEl = $('access-logs-list');
        if (listEl) {
            listEl.innerHTML = '<div class="access-log-empty"><i class="bi bi-hourglass-split"></i> Loading audit logs...</div>';
        }
        try {
            const resp = await fetch(`${VPS_URL}/api/access_logs`, {
                headers: {
                    'X-Access-Logs-Password': pwd,
                    'X-Password': pwd
                }
            });
            if (resp.status === 401) {
                setStoredAccessLogsPassword('');
                closeAccessLogsModal();
                openAccessLogsAuthModal();
                const authError = $('access-logs-auth-error');
                if (authError) {
                    authError.textContent = 'Session expired or password changed. Please enter the Access Logs password.';
                    authError.style.display = 'block';
                }
                return;
            }
            if (!resp.ok) throw new Error('Failed to retrieve logs');
            accessLogsState.logs = await resp.json();
            renderAccessLogsList();
        } catch (err) {
            console.error('[Access Logs Error]', err);
            if (listEl) {
                listEl.innerHTML = '<div class="access-log-empty" style="color:var(--run-status-red,#f87171);">Failed to load access logs.</div>';
            }
        }
    }

    /**
     * Toggle visibility of the deep telemetry technical inspector for a specific log card.
     *
     * @param {number} logId - Primary identifier of log record.
     */
    function toggleLogDetail(logId) {
        const panel = document.getElementById(`log-detail-${logId}`);
        const btn = document.getElementById(`log-toggle-btn-${logId}`);
        if (!panel) return;
        const isHidden = panel.style.display === 'none' || !panel.style.display;
        if (isHidden) {
            panel.style.display = 'block';
            if (btn) btn.innerHTML = '<i class="bi bi-chevron-up"></i> Less';
        } else {
            panel.style.display = 'none';
            if (btn) btn.innerHTML = '<i class="bi bi-chevron-down"></i> Details';
        }
    }

    /**
     * Copy full telemetry JSON of a specific log entry to system clipboard.
     *
     * @param {number} logId - Primary identifier of log record.
     */
    function copyLogJson(logId) {
        const log = accessLogsState.logs.find(l => l.id === logId);
        if (!log) return;
        let detailsObj = {};
        try {
            if (log.details) detailsObj = JSON.parse(log.details);
        } catch {}
        const fullRecord = {
            ...log,
            parsedDetails: detailsObj
        };
        navigator.clipboard.writeText(JSON.stringify(fullRecord, null, 2)).then(() => {
            showNotification('Telemetry JSON copied to clipboard!', 'success');
        }).catch(() => {
            showNotification('Failed to copy to clipboard', 'error');
        });
    }

    /**
     * Render the filtered access verification logs into the modal container with clean, uncluttered layout.
     */
    function renderAccessLogsList() {
        const listEl = $('access-logs-list');
        const counterEl = $('access-logs-counter');
        if (!listEl) return;

        let filtered = accessLogsState.logs || [];
        if (accessLogsState.filterStatus !== 'ALL') {
            filtered = filtered.filter(l => {
                const s = (l.status || '').toUpperCase();
                if (accessLogsState.filterStatus === 'BLOCKED') return s.startsWith('BLOCKED');
                if (accessLogsState.filterStatus === 'SUCCESS') return s.startsWith('SUCCESS');
                if (accessLogsState.filterStatus === 'FAILED') return s.startsWith('FAILED') && !s.startsWith('BLOCKED');
                return s === accessLogsState.filterStatus;
            });
        }

        if (accessLogsState.searchQuery) {
            const q = accessLogsState.searchQuery.toLowerCase();
            filtered = filtered.filter(l =>
                (l.ip || '').toLowerCase().includes(q) ||
                (l.country || '').toLowerCase().includes(q) ||
                (l.city || '').toLowerCase().includes(q) ||
                (l.region || '').toLowerCase().includes(q) ||
                (l.isp || '').toLowerCase().includes(q) ||
                (l.browser || '').toLowerCase().includes(q) ||
                (l.os || '').toLowerCase().includes(q) ||
                (l.device || '').toLowerCase().includes(q) ||
                (l.details || '').toLowerCase().includes(q)
            );
        }

        if (counterEl) {
            counterEl.textContent = `${filtered.length} log${filtered.length === 1 ? '' : 's'}`;
        }

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="access-log-empty"><i class="bi bi-shield-check"></i> No access logs found.</div>';
            return;
        }

        listEl.innerHTML = filtered.map(log => {
            const statusUpper = (log.status || '').toUpperCase();
            let statusClass = 'access-log-status-FAILED';
            if (statusUpper.startsWith('SUCCESS')) {
                statusClass = 'access-log-status-SUCCESS';
            } else if (statusUpper.startsWith('BLOCKED')) {
                statusClass = 'access-log-status-BLOCKED';
            }

            let detailsObj = {};
            try {
                if (log.details) detailsObj = JSON.parse(log.details);
            } catch {}

            const locationParts = [log.city, log.region, log.country].filter(Boolean);
            const locationStr = locationParts.length > 0 ? locationParts.join(', ') : 'Location unavailable';

            const hasGps = log.latitude !== null && log.latitude !== undefined && log.longitude !== null && log.longitude !== undefined;
            const mapsUrl = hasGps ? `https://www.google.com/maps?q=${log.latitude},${log.longitude}` : (detailsObj.mapsUrl || null);
            const localTimeStr = formatLocalDateTime(log.created_at);

            // Format GPS string cleanly without duplicate accuracy
            let gpsDisplay = '';
            if (hasGps) {
                const accVal = log.accuracy ? Math.round(log.accuracy) : null;
                const accStr = accVal !== null ? ` (±${accVal}m)` : '';
                gpsDisplay = `${Number(log.latitude).toFixed(5)}, ${Number(log.longitude).toFixed(5)}${accStr}`;
            }

            // Determine appropriate device/OS icon
            let deviceIcon = 'laptop';
            const osLower = (log.os || '').toLowerCase();
            if (log.device === 'Mobile' || osLower.includes('android') || osLower.includes('iphone')) {
                deviceIcon = 'phone';
            } else if (log.device === 'Tablet' || osLower.includes('ipad')) {
                deviceIcon = 'tablet';
            }

            // Network classification pill
            let netTagHtml = '';
            let netTypeLabel = 'Residential / Broadband';
            if (detailsObj.proxy || detailsObj.hosting) {
                netTagHtml = '<span class="access-log-net-tag hosting" title="Datacenter / Hosting / Proxy / VPN"><i class="bi bi-shield-shaded"></i> VPN / Datacenter</span>';
                netTypeLabel = detailsObj.proxy ? 'Proxy / VPN Detected' : 'Datacenter / Hosting IP';
            } else if (detailsObj.mobile) {
                netTagHtml = '<span class="access-log-net-tag mobile" title="Cellular / Mobile Network"><i class="bi bi-broadcast"></i> Cellular</span>';
                netTypeLabel = 'Cellular / Mobile Network';
            } else if (log.isp && log.isp !== 'Unknown') {
                netTagHtml = '<span class="access-log-net-tag residential" title="Residential / Broadband Connection"><i class="bi bi-house-door-fill"></i> Residential</span>';
                netTypeLabel = 'Residential / Broadband';
            }

            const cleanGpu = getCleanGpuName(log.gpu);
            const lanIp = (detailsObj.webrtcIps && detailsObj.webrtcIps.length > 0) ? detailsObj.webrtcIps[0] : '';
            const modelName = detailsObj.clientHints?.model || '';
            const asStr = detailsObj.as ? detailsObj.as.split(' ')[0] : '';
            const asClean = detailsObj.as ? detailsObj.as.split(' ')[0] : '-';
            const orgDisplay = (detailsObj.org && detailsObj.org !== log.isp) ? detailsObj.org : (log.isp || '-');

            // Format audio pipeline info cleanly
            let audioDisplay = '-';
            if (detailsObj.audio && typeof detailsObj.audio === 'object') {
                const sRate = detailsObj.audioSampleRate || detailsObj.audio.sampleRate;
                const ch = detailsObj.audio.maxChannelCount;
                const st = detailsObj.audio.state;
                audioDisplay = `${sRate ? `${sRate} Hz` : ''}${ch ? ` · ${ch}ch` : ''}${st ? ` (${st})` : ''}`.trim() || 'Available';
            } else if (detailsObj.audioSampleRate) {
                audioDisplay = `${detailsObj.audioSampleRate} Hz`;
            }

            return `
                <div class="access-log-entry" id="log-card-${log.id}">
                    <!-- Primary Header -->
                    <div class="access-log-header-row">
                        <div class="access-log-ip-badge">
                            <i class="bi bi-shield-check access-log-shield-icon"></i>
                            <span class="access-log-ip-text">${escapeHtml(log.ip || 'Unknown IP')}</span>
                            <span class="${statusClass}">${escapeHtml(log.status || 'UNKNOWN')}</span>
                            ${netTagHtml}
                        </div>
                        <div class="access-log-meta">
                            <span class="access-log-device-badge">
                                <i class="bi bi-${deviceIcon}"></i>
                                ${escapeHtml(log.os || 'OS')} · ${escapeHtml(log.browser || 'Browser')}
                            </span>
                            <span class="access-log-time" title="Local: ${localTimeStr} (UTC: ${escapeHtml(log.created_at || '')})">
                                <i class="bi bi-clock"></i> ${escapeHtml(localTimeStr)}
                            </span>
                            <button type="button" class="access-log-toggle-btn" onclick="RunApp.toggleLogDetail(${log.id})" id="log-toggle-btn-${log.id}" title="Toggle detailed technical inspector">
                                <i class="bi bi-chevron-down"></i> Details
                            </button>
                        </div>
                    </div>

                    <!-- Geo & ISP Row -->
                    <div class="access-log-location-row">
                        <i class="bi bi-geo-alt-fill access-log-geo-icon"></i>
                        <span class="access-log-geo-location">${escapeHtml(locationStr)}</span>
                        ${log.isp && log.isp !== 'Unknown' ? `<span class="access-log-geo-isp">• ${escapeHtml(log.isp)}</span>` : ''}
                        ${asStr ? `<span class="access-log-geo-as">• ${escapeHtml(asStr)}</span>` : ''}
                    </div>

                    ${hasGps ? `
                    <!-- Verified High-Accuracy GPS Row -->
                    <div class="access-log-gps-row">
                        <span class="access-log-gps-badge" title="High-accuracy GPS sensor coordinates">
                            <i class="bi bi-crosshair"></i> GPS: ${escapeHtml(gpsDisplay)}
                        </span>
                        <a class="access-log-maps-btn" href="${mapsUrl}" target="_blank" rel="noreferrer" title="Open GPS Location in Google Maps">
                            <i class="bi bi-geo-alt-fill"></i> View Map
                        </a>
                    </div>
                    ` : ''}

                    <!-- Quick-Scan Pills Row -->
                    <div class="access-log-pills-row">
                        <span class="access-log-pill" title="Screen resolution">
                            <i class="bi bi-display"></i> ${escapeHtml(log.screen || '-')}
                        </span>
                        <span class="access-log-pill" title="Hardware concurrency & memory">
                            <i class="bi bi-cpu"></i> ${escapeHtml(log.hardware || '-')}
                        </span>
                        <span class="access-log-pill" title="Graphics: ${escapeHtml(log.gpu || '')}">
                            <i class="bi bi-gpu-card"></i> ${escapeHtml(cleanGpu)}
                        </span>
                        ${detailsObj.battery ? `
                        <span class="access-log-pill" title="Device Battery">
                            <i class="bi bi-battery-charging"></i> ${escapeHtml(detailsObj.battery.level || '')} ${detailsObj.battery.charging ? '⚡' : ''}
                        </span>
                        ` : ''}
                        ${lanIp ? `
                        <span class="access-log-pill" title="LAN / Discovered Candidate IP">
                            <i class="bi bi-router"></i> ${escapeHtml(lanIp)}
                        </span>
                        ` : ''}
                        ${modelName ? `
                        <span class="access-log-pill" title="Device Model">
                            <i class="bi bi-phone"></i> ${escapeHtml(modelName)}
                        </span>
                        ` : ''}
                    </div>

                    <!-- Deep-Dive Forensic Inspector (Collapsible) -->
                    <div class="access-log-expanded-panel" id="log-detail-${log.id}" style="display: none;">
                        <div class="access-log-deep-grid">
                            <!-- Col 1: Hardware & Display Specs -->
                            <div class="access-log-deep-col">
                                <div class="access-log-deep-header"><i class="bi bi-motherboard"></i> Hardware & Display</div>
                                <div class="access-log-deep-row"><span>Viewport:</span> <code>${escapeHtml(detailsObj.viewport || '-')}</code></div>
                                <div class="access-log-deep-row"><span>Color / HDR:</span> <code>${detailsObj.isHdr ? 'HDR Active' : 'SDR'}${detailsObj.colorGamut ? ` (${escapeHtml(detailsObj.colorGamut)})` : ''}</code></div>
                                <div class="access-log-deep-row"><span>Orientation:</span> <code>${escapeHtml(detailsObj.orientation || '-')}</code></div>
                                <div class="access-log-deep-row"><span>Touch Support:</span> <code>${detailsObj.touchSupport ? 'Touch Enabled' : 'Mouse / No Touch'}</code></div>
                                <div class="access-log-deep-row"><span>Raw GPU:</span> <code class="truncate-code" title="${escapeHtml(log.gpu || '')}">${escapeHtml(log.gpu || '-')}</code></div>
                            </div>

                            <!-- Col 2: Network & Carrier Intelligence -->
                            <div class="access-log-deep-col">
                                <div class="access-log-deep-header"><i class="bi bi-diagram-3"></i> Network & Carrier</div>
                                <div class="access-log-deep-row"><span>ISP:</span> <code title="${escapeHtml(log.isp || '')}">${escapeHtml(log.isp || '-')}</code></div>
                                <div class="access-log-deep-row"><span>Autonomous System:</span> <code title="${escapeHtml(detailsObj.as || '')}">${escapeHtml(asClean)}</code></div>
                                <div class="access-log-deep-row"><span>Organization:</span> <code title="${escapeHtml(orgDisplay)}">${escapeHtml(orgDisplay)}</code></div>
                                <div class="access-log-deep-row"><span>Downlink / RTT:</span> <code>${detailsObj.connection ? `${escapeHtml(detailsObj.connection.effectiveType || '')} ${escapeHtml(detailsObj.connection.downlink || '')} (${escapeHtml(detailsObj.connection.rtt || '-')})` : '-'}</code></div>
                                <div class="access-log-deep-row"><span>Discovered LAN IPs:</span> <code>${detailsObj.webrtcIps && detailsObj.webrtcIps.length ? escapeHtml(detailsObj.webrtcIps.join(', ')) : 'None'}</code></div>
                                <div class="access-log-deep-row"><span>Net Type:</span> <code>${escapeHtml(netTypeLabel)}</code></div>
                            </div>

                            <!-- Col 3: Browser & Security Environment -->
                            <div class="access-log-deep-col">
                                <div class="access-log-deep-header"><i class="bi bi-shield-lock"></i> Environment & Audio</div>
                                <div class="access-log-deep-row"><span>Timezone:</span> <code>${escapeHtml(log.timezone || '-')}</code></div>
                                <div class="access-log-deep-row"><span>Languages:</span> <code>${escapeHtml(log.language || '-')}</code></div>
                                <div class="access-log-deep-row"><span>Audio Pipeline:</span> <code>${escapeHtml(audioDisplay)}</code></div>
                                <div class="access-log-deep-row"><span>Canvas Hash:</span> <code>${detailsObj.canvasHash ? escapeHtml(String(detailsObj.canvasHash).slice(0, 12)) : '-'}</code></div>
                                <div class="access-log-deep-row"><span>Media Hardware:</span> <code>${detailsObj.media ? `${detailsObj.media.cameras} Cams, ${detailsObj.media.microphones} Mics` : '-'}</code></div>
                                <div class="access-log-deep-row"><span>Cookies / DNT:</span> <code>${detailsObj.cookieEnabled ? 'Cookies On' : 'No Cookies'} · DNT: ${escapeHtml(String(detailsObj.doNotTrack ?? 'off'))}</code></div>
                            </div>
                        </div>

                        <div class="access-log-deep-actions">
                            <button type="button" class="access-log-copy-json-btn" onclick="RunApp.copyLogJson(${log.id})">
                                <i class="bi bi-clipboard"></i> Copy Telemetry JSON
                            </button>
                            ${hasGps ? `
                            <a class="access-log-maps-mini-btn" href="${mapsUrl}" target="_blank" rel="noreferrer">
                                <i class="bi bi-box-arrow-up-right"></i> Open Location in Google Maps
                            </a>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Handle incoming real-time access log broadcast via WebSocket.
     */
    function handleRealtimeAccessLog(data) {
        if (!data || !data.id) return;
        if (!accessLogsState.logs.some(l => l.id === data.id)) {
            accessLogsState.logs.unshift(data);
            if (accessLogsState.isOpen) {
                renderAccessLogsList();
            }
        }
    }

    /**
     * Initialize event listeners for the Access Verification Logs modal and security unlock gate.
     */
    function initAccessLogsModal() {
        $('run-access-logs-btn')?.addEventListener('click', openAccessLogsModal);
        $('sidebar-access-logs-btn')?.addEventListener('click', () => {
            openAccessLogsModal();
            closeSidebar();
        });
        $('access-logs-close-btn')?.addEventListener('click', closeAccessLogsModal);
        $('access-logs-lock-btn')?.addEventListener('click', lockAccessLogs);
        $('access-logs-refresh-btn')?.addEventListener('click', loadAccessLogs);

        // Access logs auth modal event listeners
        $('access-logs-auth-close-btn')?.addEventListener('click', closeAccessLogsAuthModal);
        $('access-logs-auth-cancel-btn')?.addEventListener('click', closeAccessLogsAuthModal);
        $('access-logs-auth-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            submitAccessLogsAuth();
        });
        $('access-logs-auth-submit-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            submitAccessLogsAuth();
        });
        $('access-logs-auth-password')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitAccessLogsAuth();
            }
        });
        $('access-logs-auth-modal')?.addEventListener('click', (e) => {
            if (e.target === $('access-logs-auth-modal')) closeAccessLogsAuthModal();
        });

        const filterInput = $('access-logs-filter-input');
        const filterClear = $('access-logs-filter-clear');
        if (filterInput) {
            filterInput.addEventListener('input', e => {
                accessLogsState.searchQuery = e.target.value.trim();
                if (filterClear) filterClear.style.display = accessLogsState.searchQuery ? 'block' : 'none';
                renderAccessLogsList();
            });
        }

        filterClear?.addEventListener('click', () => {
            if (filterInput) filterInput.value = '';
            accessLogsState.searchQuery = '';
            filterClear.style.display = 'none';
            renderAccessLogsList();
            filterInput?.focus();
        });

        document.querySelectorAll('#access-logs-filter-pills .logs-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                document.querySelectorAll('#access-logs-filter-pills .logs-pill').forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                accessLogsState.filterStatus = pill.dataset.filter || 'ALL';
                renderAccessLogsList();
            });
        });

        $('access-logs-modal')?.addEventListener('click', e => {
            if (e.target === $('access-logs-modal')) closeAccessLogsModal();
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 14: COMMAND DISPATCH & API EXECUTION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Dispatch confirmed command, speech synthesis, message popup, image popup, or audio blast.
     */
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

        if (mode === 'audio') {
            if (!audioState.audioData) {
                alert('Please upload an MP3 audio file first.');
                return;
            }
            isSendingCommand = true;
            const captionVal = ($('audio-caption-input')?.value || '').trim();
            try {
                const res = await fetch(`${VPS_URL}/api/audio`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-password': runState.password },
                    body: JSON.stringify({
                        username: user.username,
                        audio: audioState.audioData,
                        filename: audioState.fileName || 'sound.mp3',
                        title: captionVal
                    })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    alert(err.message || 'Failed to dispatch audio to client.');
                    return;
                }
                closePopup();
                fetchData();
            } catch (err) {
                alert('Failed to send audio: ' + err.message);
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

    /**
     * View audit log records for target client.
     *
     * @param {object} user - Target user object.
     */
    async function doViewOutput(user) {
        if (!user) return;
        openLogsModal(user);
    }

    /**
     * Poll client list from backend REST API and update grid if data signature changed.
     */
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

    /**
     * Update target client's console window visibility flag (visible or hidden).
     *
     * @param {boolean} nextVisible - True for visible, False for hidden.
     */
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

    /**
     * Synchronize display state of the Tab autofill and unfocus badges on modal textarea.
     */
    function syncTabHint() {
        const ta = $('popup-input');
        const wrap = $('textarea-wrap');
        if (!ta || !wrap) return;
        const focused = document.activeElement === ta;
        wrap.classList.toggle('show-hint', focused);
        if ($('tab-autofill-hint')) $('tab-autofill-hint').style.display = (focused && ta.value === '') ? 'flex' : 'none';
        if ($('tab-unfocus-hint')) $('tab-unfocus-hint').style.display = focused ? 'flex' : 'none';
    }

    /**
     * Autofill the active modal textarea with default/sample snippet on Tab press.
     */
    function autofillPopupInput() {
        const ta = $('popup-input');
        if (!ta || ta.value !== '') return;
        ta.value = getPopupAutofillText();
        runState.cmdLoadedFromUpload = false;
        ta.selectionStart = ta.selectionEnd = ta.value.length;
        updateOptionsUI();
        syncTabHint();
    }

    /**
     * Blur the modal textarea input.
     */
    function unfocusPopupInput() {
        $('popup-input')?.blur();
        syncTabHint();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK 15: APPLICATION BOOTSTRAP, GLOBAL EVENT DELEGATION & HOTKEYS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Open the responsive slide-out drawer sidebar.
     */
    function openSidebar() {
        if (window.__getCurrentMode?.() === 'frames' && window.__framesMenuDisabled) return;
        $('sidebar')?.classList.add('open');
        $('sidebarOverlay')?.classList.add('open');
    }

    /**
     * Close the responsive slide-out drawer sidebar.
     */
    function closeSidebar() {
        $('sidebar')?.classList.remove('open');
        $('sidebarOverlay')?.classList.remove('open');
    }

    /**
     * Main application initialization routine.
     */
    function init() {
        applyTheme(runState.themeSelection);
        setConnectionState(false);
        sizeActionModeDropdown();

        // Theme dropdown handling
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

        // Connection trigger button listeners
        const handleConnect = () => {
            if (runState.isConnected) {
                if (!confirm('Disconnect now?')) return;
                disconnectAndReset();
                return;
            }
            promptAndConnect();
        };
        ['run-connect-btn', 'sidebar-connect-btn'].forEach(id => $(id)?.addEventListener('click', handleConnect));

        // Sidebar theme triggers
        document.querySelectorAll('.sidebar-theme-btn').forEach(btn => {
            if (btn.dataset.themeVal) {
                btn.addEventListener('click', () => applyTheme(btn.dataset.themeVal));
            }
        });

        // Sidebar action mode triggers
        document.querySelectorAll('#sidebar-mode-list .sidebar-theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!runState.popupUser) return;
                applyActionMode(btn.dataset.mode);
                closeSidebar();
            });
        });

        // Sidebar download current frame button
        $('sidebar-download-btn')?.addEventListener('click', async () => {
            if (FramesApp?.downloadCurrentFrame) await FramesApp.downloadCurrentFrame();
            closeSidebar();
        });

        // Hamburger drawer triggers
        $('hamburgerBtn')?.addEventListener('click', openSidebar);
        $('sidebarOverlay')?.addEventListener('click', closeSidebar);
        $('sidebarClose')?.addEventListener('click', closeSidebar);

        // Periodic background poll
        setInterval(fetchData, 10000);

        // Grid user card mouse interactions
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

        // Target client switch menu
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

        // Action mode switch menu
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
        $('single-screenshot-btn')?.addEventListener('click', doTakeSingleScreenshot);
        $('enable-screenshot-btn')?.addEventListener('click', doToggleEnableScreenshot);
        $('delete-screenshots-btn')?.addEventListener('click', doDeleteAllScreenshots);
        initFtpBrowser();
        initLogsModal();
        initAccessLogsModal();

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

        // Global hotkey shortcuts
        document.addEventListener('keydown', e => {
            if ($('access-logs-auth-modal')?.style.display === 'flex') {
                if (e.key === 'Escape') {
                    closeAccessLogsAuthModal();
                    return;
                }
            }
            if (accessLogsState.isOpen) {
                if (e.key === 'Escape') {
                    closeAccessLogsModal();
                    return;
                }
            }
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
            if (key === 'm' && alive) openPopup('audio', u);
            if (key === 'v') doViewOutput(u);
        });

        document.addEventListener('click', e => {
            if (runState.popupMode) return;
            if (window.__getCurrentMode?.() !== 'run') return;
            if (!e.target.closest('.user-card')) clearActiveSelection();
        });

        // Security Verification Gate setup & listeners
        $('auth-gate-submit-btn')?.addEventListener('click', submitAuthGate);
        $('auth-gate-password')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') submitAuthGate();
        });

        // Initial connection setup via Verification Gate
        if (!runState.password) {
            openAuthGateModal('');
        } else {
            // If already stored password, test if location permission is already active
            requestGpsLocation(2000).then(gpsRes => {
                if (gpsRes.ok) {
                    validateVpsConnection(runState.password, gpsRes.coords, null).then(loginRes => {
                        if (loginRes.ok) {
                            setConnectionState(true);
                            fetchData();
                        } else {
                            openAuthGateModal(runState.password, 'Session expired. Please re-verify credentials.');
                        }
                    }).catch(() => {
                        openAuthGateModal(runState.password);
                    });
                } else {
                    // Location permission not yet granted or blocked: Gate requires explicit user click & allow
                    openAuthGateModal(runState.password);
                }
            });
        }

        if ($('popup-cancel')) $('popup-cancel').onclick = closePopup;
        if ($('popup-confirm')) $('popup-confirm').onclick = doSendPopup;

        // Imager upload & card listeners
        const imagerCard = $('imager-card');
        const imagerFileInput = $('imager-file-input');
        const imagerRemoveBtn = $('imager-remove-btn');
        const imagerCaptionInput = $('imager-caption-input');

        if (imagerCard && imagerFileInput) {
            imagerCard.addEventListener('click', e => {
                if (e.target.closest('#imager-remove-btn')) return;
                imagerFileInput.click();
            });

            imagerCard.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.target.closest('#imager-remove-btn')) return;
                    e.preventDefault();
                    imagerFileInput.click();
                }
            });

            imagerFileInput.addEventListener('change', e => {
                if (e.target.files && e.target.files[0]) {
                    processImagerFile(e.target.files[0]);
                }
            });

            imagerCard.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                imagerCard.classList.add('dragover');
            });
            imagerCard.addEventListener('dragenter', e => {
                e.preventDefault();
                imagerCard.classList.add('dragover');
            });
            imagerCard.addEventListener('dragleave', e => {
                if (!imagerCard.contains(e.relatedTarget)) {
                    imagerCard.classList.remove('dragover');
                }
            });
            imagerCard.addEventListener('drop', e => {
                e.preventDefault();
                imagerCard.classList.remove('dragover');
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

        // Audio upload & card listeners
        const audioCard = $('audio-card');
        const audioFileInput = $('audio-file-input');
        const audioRemoveBtn = $('audio-remove-btn');
        const audioPreviewBtn = $('audio-preview-btn');
        const audioCaptionInput = $('audio-caption-input');

        if (audioCard && audioFileInput) {
            audioCard.addEventListener('click', e => {
                if (e.target.closest('#audio-remove-btn') || e.target.closest('#audio-preview-btn')) return;
                audioFileInput.click();
            });

            audioCard.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.target.closest('#audio-remove-btn') || e.target.closest('#audio-preview-btn')) return;
                    e.preventDefault();
                    audioFileInput.click();
                }
            });

            audioFileInput.addEventListener('change', e => {
                if (e.target.files && e.target.files[0]) {
                    processAudioFile(e.target.files[0]);
                }
            });

            audioCard.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                audioCard.classList.add('dragover');
            });
            audioCard.addEventListener('dragenter', e => {
                e.preventDefault();
                audioCard.classList.add('dragover');
            });
            audioCard.addEventListener('dragleave', e => {
                if (!audioCard.contains(e.relatedTarget)) {
                    audioCard.classList.remove('dragover');
                }
            });
            audioCard.addEventListener('drop', e => {
                e.preventDefault();
                audioCard.classList.remove('dragover');
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    processAudioFile(e.dataTransfer.files[0]);
                }
            });
        }

        if (audioPreviewBtn) {
            audioPreviewBtn.addEventListener('click', e => {
                e.stopPropagation();
                toggleAudioPreview();
            });
        }

        if (audioRemoveBtn) {
            audioRemoveBtn.addEventListener('click', e => {
                e.stopPropagation();
                resetAudio();
            });
        }

        if (audioCaptionInput) {
            audioCaptionInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    doSendPopup();
                }
            });
        }

        // Global paste listener for Imager and Audio clips
        window.addEventListener('paste', e => {
            if (runState.popupMode === 'imager') {
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
            } else if (runState.popupMode === 'audio') {
                const items = e.clipboardData?.items;
                if (!items) return;
                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('audio') !== -1) {
                        const file = items[i].getAsFile();
                        if (file) {
                            processAudioFile(file);
                            break;
                        }
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

    return {
        init,
        openPopup,
        closePopup,
        openLogsModal,
        closeLogsModal,
        openFtpBrowser,
        closeFtpBrowser,
        toggleLogDetail,
        copyLogJson
    };
})();

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    RunApp.init();
});