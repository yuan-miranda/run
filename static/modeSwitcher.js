(function () {
    const body = document.body;
    const brandToggle = document.getElementById('brandToggle');
    const brandMode = document.getElementById('brandMode');
    let currentMode = 'run';
    let framesBooted = false;

    if (brandMode) brandMode.textContent = 'RUN';

    brandToggle.addEventListener('click', () => {
        currentMode = currentMode === 'frames' ? 'run' : 'frames';
        // animate label: fade up, swap text, fade back
        if (brandMode) {
            brandMode.classList.add('brand-mode-fade');
            setTimeout(() => {
                brandMode.textContent = currentMode === 'frames' ? 'FRAMES' : 'RUN';
                brandMode.classList.remove('brand-mode-fade');
            }, 140);
        }
        body.classList.remove('view-frames', 'view-run');
        body.classList.add('view-' + currentMode);

        if (currentMode === 'frames') {
            if (!framesBooted) { FramesApp.init(); framesBooted = true; }
            if (FramesApp.onShow) FramesApp.onShow();
            body.classList.toggle('is-loading', !!(FramesApp.state && FramesApp.state.loading));
        } else {
            body.classList.remove('is-loading');
        }
    });

    window.__setFramesLoading = on => {
        if (currentMode === 'frames') body.classList.toggle('is-loading', on);
    };
    window.__getCurrentMode = () => currentMode;
})();