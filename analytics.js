import {
    campaigns, endpoint, events, languageFor, media, productionOrigin, serviceFor, services, sources
} from "./analytics-schema.mjs";

const referrers = new Map([
    ["google.com", "google"], ["www.google.com", "google"],
    ["google.ch", "google"], ["www.google.ch", "google"],
    ["bing.com", "bing"], ["www.bing.com", "bing"],
    ["local.ch", "local_ch"], ["www.local.ch", "local_ch"],
    ["search.ch", "search_ch"], ["www.search.ch", "search_ch"],
    ["maps.apple.com", "apple_maps"],
    ["www.linkedin.com", "linkedin"], ["www.facebook.com", "facebook"],
    ["l.facebook.com", "facebook"],
    ["cylex-swiss.ch", "cylex"], ["www.cylex-swiss.ch", "cylex"],
    ["goregio.ch", "goregio"], ["www.goregio.ch", "goregio"],
    ["infosenior.ch", "infosenior"], ["www.infosenior.ch", "infosenior"],
    ["zuerich.im", "zuerich_im"], ["www.zuerich.im", "zuerich_im"],
    ["xn--zrich-kva.im", "zuerich_im"], ["www.xn--zrich-kva.im", "zuerich_im"],
    ["firmen.ch", "firmen_ch"], ["www.firmen.ch", "firmen_ch"],
    ["stadtbranchenbuch.ch", "stadtbranchenbuch"], ["www.stadtbranchenbuch.ch", "stadtbranchenbuch"],
    ["expat.com", "expat"], ["www.expat.com", "expat"]
]);

const contactResult = "contact-form-result";
const maxEventsPerDocument = 20;

function allowedParam(params, name, allowed) {
    const values = params.getAll(name);
    if (values.length !== 1) return "";
    const value = values[0].trim().toLowerCase();
    return allowed.has(value) ? value : "";
}

function referralSource(referrer) {
    if (!referrer) return "";
    try {
        const url = new URL(referrer);
        if (!["http:", "https:"].includes(url.protocol) || url.origin === productionOrigin) return "";
        return referrers.get(url.hostname) ?? "other_referral";
    } catch {
        return "";
    }
}

function linkEvent(target) {
    const anchor = target?.closest?.("a[href]");
    if (!anchor) return "";
    const url = new URL(anchor.href);
    if (url.protocol === "tel:") return "phone_click";
    if (url.protocol === "mailto:") return "email_click";
    if (url.protocol === "https:" && url.hostname === "wa.me") return "whatsapp_click";
    return "";
}

let initialized = false;

export function start(mayTrack) {
    if (initialized || !mayTrack()) return;
    const {origin, pathname, search} = window.location;
    const language = languageFor(pathname);
    if (origin !== productionOrigin || !language) return;
    if (navigator.globalPrivacyControl || [navigator.doNotTrack, window.doNotTrack, navigator.msDoNotTrack]
        .some((value) => value === "1" || value === "yes")) return;

    initialized = true;
    const params = new URLSearchParams(search);
    const utmSource = allowedParam(params, "utm_source", sources);
    const medium = allowedParam(params, "utm_medium", media);
    const campaign = allowedParam(params, "utm_campaign", campaigns);
    const source = (utmSource === "other_referral" ? "" : utmSource) ||
        referralSource(document.referrer);
    let eventCount = 0;

    function send(event, service = serviceFor(pathname)) {
        if (!mayTrack() || !events.has(event) || eventCount >= maxEventsPerDocument) return;
        eventCount += 1;
        try {
            // Fetch permits suppressing the full URL in the Referer header.
            void fetch(endpoint, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({event, path: pathname, language, source, medium, campaign, service}),
                keepalive: true,
                credentials: "omit",
                referrerPolicy: "no-referrer"
            }).catch(() => {});
        } catch {
            // Analytics is best effort.
        }
    }

    document.addEventListener("click", (event) => {
        if (event.defaultPrevented || !event.isTrusted) return;
        try {
            send(linkEvent(event.target));
        } catch {
            // An invalid link must never interfere with navigation.
        }
    });
    document.addEventListener(contactResult, (event) => {
        if (event.target !== document.getElementById("contact-form")) return;
        const {outcome, service, startedAt} = event.detail ?? {};
        if (!mayTrack(startedAt)) return;
        const allowedService = services.has(service) ? service : "";
        if (outcome === "success") send("contact_form_success", allowedService);
        if (outcome === "error") send("contact_form_error", allowedService);
    });

    if ((utmSource && utmSource !== "other_referral") || medium || campaign) send("utm_landing");
}
