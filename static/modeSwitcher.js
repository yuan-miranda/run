/**
 * Mode Switcher & Shared Run Application Utilities
 * Manages view switching between RUN control grid and FRAMES screenshot browser,
 * global keyboard shortcuts, and shared utility helpers.
 */
(function () {
    'use strict';

    // ── Shared Run Application Utilities ───────────────────────────────────────
    window.RunUtils = {
        /**
         * Dynamically measures maximum text width among an array of names and adjusts
         * minimum width of dropdown button, menu, and wrapper to avoid layout shift.
         *
         * @param {HTMLElement|null} btn - Button element to resize.
         * @param {HTMLElement|null} menu - Dropdown menu container to resize.
         * @param {HTMLElement|null} wrap - Outer wrapper element to resize.
         * @param {string[]} names - Array of string labels to measure.
         * @param {string} [btnClass='folder-btn'] - CSS class to apply to offscreen measuring element.
         */
        sizeDropdownToContent(btn, menu, wrap, names, btnClass = 'folder-btn') {
            if (!names || !names.length) return;
            const meas = document.createElement('button');
            meas.className = `${btnClass} folder-measure`;
            meas.style.position = 'absolute';
            meas.style.visibility = 'hidden';
            meas.style.pointerEvents = 'none';
            const span = document.createElement('span');
            meas.appendChild(span);
            document.body.appendChild(meas);

            let max = 0;
            try {
                for (const name of names) {
                    span.textContent = name;
                    max = Math.max(max, meas.getBoundingClientRect().width);
                }
            } finally {
                if (meas.parentNode) {
                    document.body.removeChild(meas);
                }
            }

            const w = Math.ceil(max) + 'px';
            if (btn) btn.style.minWidth = w;
            if (menu) menu.style.minWidth = w;
            if (wrap) wrap.style.minWidth = w;
        },

        /**
         * Safely encode a UTF-8 string into standard Base64 representation.
         *
         * @param {string} str - Raw string to encode.
         * @returns {string} Base64-encoded string.
         */
        encodeBase64(str) {
            try {
                return btoa(unescape(encodeURIComponent(str || '')));
            } catch {
                return '';
            }
        },

        /**
         * Safely decode a Base64-encoded UTF-8 string, falling back to original if invalid.
         *
         * @param {string} b64 - Base64 string to decode.
         * @returns {string} Decoded plain text string.
         */
        decodeBase64(b64) {
            try {
                return decodeURIComponent(escape(atob(b64 || '')));
            } catch {
                return b64 || '';
            }
        },

        /**
         * Parse structured client username string into base username, 8-character ID, and OS tag.
         * Expected pattern: [baseName]-[id]-[os] (e.g., 'user-a1b2c3d4-W').
         *
         * @param {string} username - Composite client username.
         * @returns {{baseName: string, id: string, os: string}} Parsed username object.
         */
        parseUsername(username) {
            const text = String(username || '').trim();
            const match = text.match(/^(.*?)-([^-]+)-(W|WIN)$/i);
            if (!match) return { baseName: text, id: '', os: 'W' };
            return { baseName: match[1], id: match[2], os: match[3].toUpperCase() };
        }
    };

    // ── Mode Switcher Logic ───────────────────────────────────────────────────
    const body = document.body;
    const brandToggle = document.getElementById('brandToggle');
    const brandMode = document.getElementById('brandMode');
    let currentMode = 'run';
    let framesBooted = false;

    if (brandMode) brandMode.textContent = 'RUN';

    /**
     * Switch view mode between 'run' (client dashboard) and 'frames' (screenshot viewer).
     *
     * @param {'run'|'frames'} targetMode - Desired view mode.
     */
    function switchMode(targetMode) {
        if (targetMode === currentMode) return;
        currentMode = targetMode;

        if (brandMode) {
            brandMode.classList.add('brand-mode-fade');
            setTimeout(() => {
                brandMode.textContent = currentMode === 'frames' ? 'FRAMES' : 'RUN';
                brandMode.classList.remove('brand-mode-fade');
            }, 140);
        }

        body.classList.remove('view-frames', 'view-run', 'view-action');
        body.classList.add('view-' + currentMode);

        if (currentMode === 'frames') {
            if (!framesBooted && typeof FramesApp !== 'undefined') {
                FramesApp.init();
                framesBooted = true;
            }
            if (typeof FramesApp !== 'undefined' && FramesApp.onShow) {
                FramesApp.onShow();
            }
            body.classList.toggle('is-loading', !!(FramesApp?.state && FramesApp.state.loading));
        } else {
            body.classList.remove('is-loading');
        }
    }

    // Toggle mode when brand banner is clicked
    brandToggle?.addEventListener('click', () => {
        switchMode(currentMode === 'frames' ? 'run' : 'frames');
    });

    /**
     * Set global loading spinner state when frames viewer is loading data.
     * @param {boolean} on - Loading state.
     */
    window.__setFramesLoading = on => {
        if (currentMode === 'frames') body.classList.toggle('is-loading', !!on);
    };

    /**
     * Get active mode string.
     * @returns {'run'|'frames'} Current active mode.
     */
    window.__getCurrentMode = () => currentMode;

    /**
     * Expose switchMode globally for header/sidebar menu triggers.
     * @param {'run'|'frames'} targetMode - Mode to activate.
     */
    window.__switchMode = switchMode;

    // ── Global Keyboard Shortcuts ─────────────────────────────────────────────
    // Press 'R' for RUN mode, 'F' for FRAMES mode when not typing in form controls
    window.addEventListener('keydown', e => {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
        if (document.body.classList.contains('view-action')) return;

        if (e.key === 'r' || e.key === 'R') {
            if (currentMode !== 'run') brandToggle?.click();
        } else if (e.key === 'f' || e.key === 'F') {
            if (currentMode !== 'frames') brandToggle?.click();
        }
    });
})();