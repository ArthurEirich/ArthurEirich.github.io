export const endpoint = "/api/analytics";
export const productionOrigin = "https://eiricha.com";

const routes = new Map([
    ["/", ""], ["/en/", ""],
    ["/it-service-zuerich/", "pc"], ["/en/it-support-zurich/", "pc"],
    ["/mac-hilfe-zuerich/", "mac"], ["/en/mac-apple-support-zurich/", "mac"],
    ["/wlan-hilfe-zuerich/", "wifi"], ["/en/wifi-support-zurich/", "wifi"],
    ["/handy-hilfe-zuerich/", "mobile"], ["/en/smartphone-tablet-support-zurich/", "mobile"],
    ["/datensicherung-zuerich/", "backup"], ["/en/backup-data-protection-zurich/", "backup"],
    ["/drucker-hilfe-zuerich/", "printer"], ["/en/printer-scanner-support-zurich/", "printer"],
    ["/computerhilfe-senioren-zuerich/", "seniors"], ["/en/computer-help-seniors-zurich/", "seniors"],
    ["/webseiten-zuerich/", "web"], ["/en/website-design-zurich/", "web"],
    ["/individualsoftware-zuerich/", "software"], ["/en/custom-software-zurich/", "software"]
]);

export const services = new Set(routes.values());

export function serviceFor(path) {
    return routes.get(path);
}

export const events = new Set([
    "phone_click", "email_click", "whatsapp_click",
    "contact_form_success", "contact_form_error", "utm_landing"
]);

export const sources = new Set([
    "google", "bing", "cylex", "goregio", "infosenior", "zuerich_im",
    "firmen_ch", "local_ch", "search_ch", "stadtbranchenbuch", "expat",
    "apple_maps", "linkedin", "facebook", "other_referral"
]);

export const media = new Set([
    "organic", "referral", "directory", "social", "maps", "email", "cpc"
]);

export const campaigns = new Set([
    "zurich_it_support", "local_directories", "senior_it_help"
]);

export function languageFor(path) {
    if (!routes.has(path)) return "";
    return path.startsWith("/en/") ? "en" : "de";
}
