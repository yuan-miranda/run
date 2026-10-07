(function () {
    // ── Shared Run Application Utilities ──
    window.RunUtils = {
        sizeDropdownToContent(btn, menu, wrap, names, btnClass = 'folder-btn') {
            if (!names || !names.length) return;
            const meas = document.createElement('button');
            meas.className = `${btnClass} folder-measure`;
            const span = document.createElement('span');
            meas.appendChild(span);
            document.body.appendChild(meas);
            let max = 0;
            for (const name of names) {
                span.textContent = name;
                max = Math.max(max, meas.getBoundingClientRect().width);
            }
            document.body.removeChild(meas);
            const w = Math.ceil(max) + 'px';
            if (btn) btn.style.minWidth = w;
            if (menu) menu.style.minWidth = w;
            if (wrap) wrap.style.minWidth = w;
        },
        encodeBase64(str) {
            return btoa(unescape(encodeURIComponent(str || '')));
        },
        decodeBase64(b64) {
            try {
                return decodeURIComponent(escape(atob(b64 || '')));
            } catch {
                return b64 || '';
            }
        },
        parseUsername(username) {
            const text = String(username || '').trim();
            const match = text.match(/^(.*?)-([^-]+)-(W|L|WIN|LINUX)$/i);
            if (!match) return { baseName: text, id: '', os: '' };
            return { baseName: match[1], id: match[2], os: match[3].toUpperCase() };
        },
        isWindows(username) {
            const parsed = this.parseUsername(username);
            return parsed.os === 'W' || parsed.os === 'WIN' || /-(?:w|win)$/i.test(String(username || '').trim());
        },
        isLinux(username) {
            const parsed = this.parseUsername(username);
            return parsed.os === 'L' || parsed.os === 'LINUX' || /-(?:l|linux)$/i.test(String(username || '').trim());
        }
    };

    // ── Mode Switcher Logic ──
    const body = document.body;
    const brandToggle = document.getElementById('brandToggle');
    const brandMode = document.getElementById('brandMode');
    let currentMode = 'run';
    let framesBooted = false;

    if (brandMode) brandMode.textContent = 'RUN';

    brandToggle?.addEventListener('click', () => {
        currentMode = currentMode === 'frames' ? 'run' : 'frames';
        // Animate label: fade up, swap text, fade back
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
            if (typeof FramesApp !== 'undefined' && FramesApp.onShow) FramesApp.onShow();
            body.classList.toggle('is-loading', !!(FramesApp?.state && FramesApp.state.loading));
        } else {
            body.classList.remove('is-loading');
        }
    });

    window.__setFramesLoading = on => {
        if (currentMode === 'frames') body.classList.toggle('is-loading', on);
    };
    window.__getCurrentMode = () => currentMode;

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