const storageKey = "eiricha.analyticsConsent";
const policyVersion = 1;
const beaconURL = "https://static.cloudflareinsights.com/beacon.min.js";

function browserBlocksAnalytics() {
    const dnt = [navigator.doNotTrack, window.doNotTrack, navigator.msDoNotTrack];
    return navigator.globalPrivacyControl === true || dnt.some((value) => value === "1" || value === "yes");
}

function readPreference() {
    try {
        const raw = localStorage.getItem(storageKey);
        const value = JSON.parse(raw);
        if (value?.version !== policyVersion || !["allow", "necessary"].includes(value.preference) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return "";
        // An absent-key removal checks whether a saved grant can be withdrawn
        // without rewriting that grant or storing any additional value.
        if (value.preference === "allow") localStorage.removeItem(storageKey + ".probe");
        return value.preference;
    } catch {
        return "";
    }
}

function writePreference(preference) {
    try {
        localStorage.setItem(storageKey, JSON.stringify({
            preference, version: policyVersion, date: new Date().toISOString().slice(0, 10)
        }));
        return true;
    } catch {
        if (preference === "necessary") {
            try {
                localStorage.removeItem(storageKey);
                return true;
            } catch {
                // The current page still stops tracking if storage is unavailable.
            }
        }
        return false;
    }
}

const panel = document.getElementById("privacy-consent");
if (panel) {
    const settings = document.getElementById("privacy-settings");
    const title = document.getElementById("privacy-consent-title");
    const accept = document.getElementById("privacy-accept");
    const notice = document.getElementById("privacy-consent-notice");
    const {webAnalytics, conversionAnalytics} = panel.dataset;
    const configured = location.origin === "https://eiricha.com" && Boolean(webAnalytics || conversionAnalytics);
    const forcedNecessary = new URLSearchParams(location.search).get("privacy-choice") === "necessary";
    let storageUnavailable = forcedNecessary && !writePreference("necessary");
    let preference = forcedNecessary ? "necessary" : readPreference();
    let restoreSettingsFocus = false;
    let active = false;
    let beaconStarted = false;

    if (forcedNecessary && !storageUnavailable) {
        const url = new URL(location.href);
        url.searchParams.delete("privacy-choice");
        history.replaceState(history.state, "", url);
    }

    function show(open, focus = false) {
        panel.hidden = !open;
        settings.setAttribute("aria-expanded", String(open));
        accept.disabled = browserBlocksAnalytics();
        notice.hidden = !accept.disabled && !storageUnavailable;
        notice.textContent = accept.disabled ? notice.dataset.signal : notice.dataset.storage;
        if (focus) (open ? title : settings).focus();
    }

    function mayTrack() {
        return active && preference === "allow" && !browserBlocksAnalytics();
    }

    function stop(persisted) {
        active = false;
        if (!beaconStarted) return;
        if (persisted) {
            location.reload();
        } else {
            // Force a new document even if the older grant could not be removed.
            const url = new URL(location.href);
            url.searchParams.set("privacy-choice", "necessary");
            location.replace(url);
        }
    }

    function decide(choice) {
        const wasActive = active;
        const persisted = writePreference(choice);
        storageUnavailable = !persisted;
        preference = persisted ? choice : "necessary";
        if (wasActive && preference !== "allow") stop(persisted);
        show(storageUnavailable, restoreSettingsFocus && !storageUnavailable);
    }

    settings.hidden = false;
    settings.addEventListener("click", () => {
        restoreSettingsFocus = panel.hidden;
        show(panel.hidden, true);
    });
    panel.addEventListener("keydown", (event) => {
        if (event.key === "Escape") show(false, true);
    });
    document.getElementById("privacy-reject").addEventListener("click", () => decide("necessary"));
    accept.addEventListener("click", () => {
        if (!browserBlocksAnalytics()) decide("allow");
    });

    function refreshPreference() {
        const saved = readPreference();
        const blocked = browserBlocksAnalytics();
        // Never start analytics on an already loaded or restored page after a new grant.
        preference = saved;
        if (active && (saved !== "allow" || blocked)) stop(true);
        show(!panel.hidden || (!saved && !blocked));
    }
    window.addEventListener("storage", (event) => {
        if (event.key === storageKey || event.key === null) refreshPreference();
    });
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) refreshPreference();
    });

    show((!preference && !browserBlocksAnalytics()) || storageUnavailable);
    active = configured && preference === "allow" && !browserBlocksAnalytics();
    beaconStarted = active && Boolean(webAnalytics);
    if (beaconStarted && !document.querySelector(`script[src^="${beaconURL}"]`)) {
        const beacon = document.createElement("script");
        beacon.src = beaconURL;
        beacon.async = true;
        beacon.referrerPolicy = "no-referrer";
        beacon.dataset.cfBeacon = JSON.stringify({token: webAnalytics, spa: false});
        document.head.append(beacon);
    }
    if (active && conversionAnalytics) {
        void import("./analytics.js").then(({start}) => {
            if (mayTrack()) start(mayTrack);
        }).catch(() => {});
    }
}
