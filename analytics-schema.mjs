export const endpoint = "/api/analytics";
export const productionOrigin = "https://eiricha.com";

const routes = new Set([
    "/", "/en/",
    "/it-service-zuerich/", "/en/it-support-zurich/",
    "/mac-hilfe-zuerich/", "/en/mac-apple-support-zurich/",
    "/wlan-hilfe-zuerich/", "/en/wifi-support-zurich/",
    "/handy-hilfe-zuerich/", "/en/smartphone-tablet-support-zurich/",
    "/datensicherung-zuerich/", "/en/backup-data-protection-zurich/",
    "/drucker-hilfe-zuerich/", "/en/printer-scanner-support-zurich/",
    "/computerhilfe-senioren-zuerich/", "/en/computer-help-seniors-zurich/",
    "/webseiten-zuerich/", "/en/website-design-zurich/",
    "/individualsoftware-zuerich/", "/en/custom-software-zurich/"
]);

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
