// Listen only while conversions are permitted. Bufferable values are event names and preset service IDs.
export function observeConversions(mayTrack, record) {
    function onClick(event) {
        if (event.defaultPrevented || !event.isTrusted || !mayTrack()) return;
        const anchor = event.target?.closest?.("a[href]");
        if (!anchor) return;
        try {
            const url = new URL(anchor.href);
            if (url.protocol === "tel:") record("phone_click");
            if (url.protocol === "mailto:") record("email_click");
            if (url.protocol === "https:" && url.hostname === "wa.me") record("whatsapp_click");
        } catch {
            // Invalid links are irrelevant to conversion tracking.
        }
    }

    function onResult(event) {
        if (event.target !== document.getElementById("contact-form")) return;
        const {outcome, service, startedAt} = event.detail ?? {};
        if (!Number.isFinite(startedAt) || !mayTrack(startedAt)) return;
        // The form emits only preset IDs. Exclude malformed values before buffering.
        const preset = typeof service === "string" && /^(pc|mac|wifi|mobile|backup|printer|seniors|web|software)$/.test(service)
            ? service : "";
        if (outcome === "success") record("contact_form_success", preset);
        if (outcome === "error") record("contact_form_error", preset);
    }

    document.addEventListener("click", onClick);
    document.addEventListener("contact-form-result", onResult);
    return () => {
        document.removeEventListener("click", onClick);
        document.removeEventListener("contact-form-result", onResult);
    };
}

const storageKey = "eiricha.analyticsConsent";
const policyVersion = 2;
const beaconURL = "https://static.cloudflareinsights.com/beacon.min.js";

function browserBlocksAnalytics() {
    const dnt = [navigator.doNotTrack, window.doNotTrack, navigator.msDoNotTrack];
    return navigator.globalPrivacyControl === true || dnt.some((value) => value === "1" || value === "yes");
}

function readPreference(scope) {
    try {
        const raw = localStorage.getItem(storageKey);
        const value = JSON.parse(raw);
        if (value?.version !== policyVersion || value.scope !== scope || !["allow", "necessary"].includes(value.preference) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return "";
        // An absent-key removal checks whether a saved grant can be withdrawn
        // without rewriting that grant or storing any additional value.
        if (value.preference === "allow") localStorage.removeItem(storageKey + ".probe");
        return value.preference;
    } catch {
        return "";
    }
}

function writePreference(preference, scope) {
    try {
        localStorage.setItem(storageKey, JSON.stringify({
            preference, version: policyVersion, scope, date: new Date().toISOString().slice(0, 10)
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

const panel = typeof document === "undefined" ? null : document.getElementById("privacy-consent");
if (panel) {
    const settings = document.getElementById("privacy-settings");
    const restart = document.getElementById("privacy-restart");
    const form = document.getElementById("contact-form");
    const title = document.getElementById("privacy-consent-title");
    const accept = document.getElementById("privacy-accept");
    const notice = document.getElementById("privacy-consent-notice");
    const {webAnalytics, conversionAnalytics} = panel.dataset;
    const scope = [webAnalytics && "web-analytics", conversionAnalytics && "conversions"].filter(Boolean).join(",");
    const configured = location.origin === "https://eiricha.com" && Boolean(webAnalytics || conversionAnalytics);
    const forcedNecessary = new URLSearchParams(location.search).get("privacy-choice") === "necessary";
    let storageUnavailable = forcedNecessary && !writePreference("necessary", scope);
    let preference = forcedNecessary ? "necessary" : readPreference(scope);
    let restoreSettingsFocus = false;
    let active = false;
    let grantedAt = 0;
    let beaconStarted = false;
    let pendingReload;
    let loadingConversions = false;
    let sendConversion;
    let stopObserving;
    const pendingConversions = [];

    if (forcedNecessary && !storageUnavailable) {
        const url = new URL(location.href);
        url.searchParams.delete("privacy-choice");
        history.replaceState(history.state, "", url);
    }

    function show(open, focus = false) {
        panel.hidden = !open;
        settings.setAttribute("aria-expanded", String(open));
        accept.disabled = browserBlocksAnalytics() || Boolean(pendingReload);
        notice.hidden = !accept.disabled && !storageUnavailable;
        notice.textContent = [
            storageUnavailable && notice.dataset.storage,
            pendingReload ? notice.dataset.reload : browserBlocksAnalytics() && notice.dataset.signal
        ].filter(Boolean).join(" ");
        restart.hidden = !pendingReload;
        restart.disabled = form?.dataset.contactPending === "true";
        if (focus) (open ? title : settings).focus();
    }

    function mayTrack(startedAt = Infinity) {
        return startedAt >= grantedAt && active && preference === "allow" && !browserBlocksAnalytics();
    }

    function reload(persisted) {
        if (persisted) {
            location.reload();
        } else {
            const url = new URL(location.href);
            url.searchParams.set("privacy-choice", "necessary");
            location.replace(url);
        }
    }

    function contactNeedsProtection() {
        if (!form) return false;
        const {name, kontakt, nachricht, thema, datenschutz} = form.elements;
        return form.dataset.contactPending === "true" || Boolean(form.dataset.contactOutcome || name.value || kontakt.value ||
            nachricht.value || datenschutz.checked ||
            (thema.selectedIndex !== Number(form.dataset.initialTopic ?? 0)));
    }

    function stop(persisted) {
        active = false;
        stopObserving?.();
        stopObserving = undefined;
        pendingConversions.length = 0;
        if (!beaconStarted && persisted) return;
        if (pendingReload || contactNeedsProtection()) {
            pendingReload = {persisted};
            return;
        }
        reload(persisted);
    }

    function startConversions() {
        if (!conversionAnalytics || stopObserving || !mayTrack()) return;
        // Capture normalized events synchronously after consent while the module downloads.
        stopObserving = observeConversions(mayTrack, (...event) => {
            if (sendConversion) sendConversion(...event);
            else if (pendingConversions.length < 20) pendingConversions.push(event);
        });
        if (loadingConversions || sendConversion) return;
        loadingConversions = true;
        void import("./analytics.js").then(({start}) => {
            if (mayTrack()) {
                sendConversion = start(mayTrack);
                for (const event of pendingConversions) sendConversion?.(...event);
            }
        }).catch(() => {
            stopObserving?.();
            stopObserving = undefined;
        }).finally(() => {
            pendingConversions.length = 0;
            loadingConversions = false;
        });
    }

    function decide(choice) {
        const wasActive = active;
        const persisted = writePreference(choice, scope);
        storageUnavailable = !persisted;
        preference = persisted ? choice : "necessary";
        if (preference === "allow") {
            if (!wasActive) grantedAt = performance.now();
            active = configured;
            startConversions();
        } else if (wasActive) {
            stop(persisted);
        }
        show(storageUnavailable || Boolean(pendingReload), restoreSettingsFocus && !storageUnavailable && !pendingReload);
    }

    restart.addEventListener("click", () => {
        if (pendingReload && form?.dataset.contactPending !== "true") reload(pendingReload.persisted);
    });
    for (const event of ["contact-form-start", "contact-form-result"]) {
        form?.addEventListener(event, () => {
            if (pendingReload) restart.disabled = form.dataset.contactPending === "true";
        });
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
        const saved = readPreference(scope);
        const blocked = browserBlocksAnalytics();
        // Never start analytics on an already loaded or restored page after a new grant.
        preference = saved;
        if (active && (saved !== "allow" || blocked)) stop(true);
        show(Boolean(pendingReload) || !panel.hidden || (configured && !saved && !blocked));
    }
    window.addEventListener("storage", (event) => {
        if (event.key === storageKey || event.key === null) refreshPreference();
    });
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) refreshPreference();
    });

    show((configured && !preference && !browserBlocksAnalytics()) || storageUnavailable);
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
    startConversions();
}
