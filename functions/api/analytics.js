import {
    campaigns, endpoint, events, languageFor, media, productionOrigin, serviceFor, services, sources
} from "../../analytics-schema.mjs";

const maxBodyBytes = 512;
const maxWritesPerMinute = 120;
let minute = -1;
let writes = 0;
const fields = ["event", "path", "language", "source", "medium", "campaign", "service"];
const response = (status, headers) => new Response(null, {
    status, headers: {"Cache-Control": "no-store", ...headers}
});

async function readBody(request) {
    const reader = request.body?.getReader();
    if (!reader) return {};
    const bytes = new Uint8Array(maxBodyBytes);
    let size = 0;
    try {
        for (;;) {
            const {value, done} = await reader.read();
            if (done) break;
            if (size + value.byteLength > maxBodyBytes) {
                void reader.cancel().catch(() => {});
                return {tooLarge: true};
            }
            bytes.set(value, size);
            size += value.byteLength;
        }
        return {data: JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, size)))};
    } finally {
        reader.releaseLock();
    }
}

function isValid(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    if (Object.keys(data).length !== fields.length ||
        !fields.every((field) => Object.hasOwn(data, field) && typeof data[field] === "string")) return false;
    const routeService = serviceFor(data.path);
    const formEvent = data.event.startsWith("contact_form_");
    return events.has(data.event) &&
        languageFor(data.path) !== "" && languageFor(data.path) === data.language &&
        (formEvent ? routeService === "" && services.has(data.service) : data.service === routeService) &&
        (data.source === "" || sources.has(data.source)) &&
        (data.medium === "" || media.has(data.medium)) &&
        (data.campaign === "" || campaigns.has(data.campaign)) &&
        (data.event !== "utm_landing" || (data.source && data.source !== "other_referral") || data.medium || data.campaign);
}

export async function onRequest({request, env}) {
    const url = new URL(request.url);
    if (url.origin !== productionOrigin || url.pathname !== endpoint || url.search) return response(404);
    if (request.method !== "POST") return response(405, {Allow: "POST"});
    if (request.headers.get("Origin") !== productionOrigin) return response(403);
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (fetchSite && fetchSite !== "same-origin") return response(403);
    if (request.headers.get("Sec-GPC") === "1" || request.headers.get("DNT") === "1") return response(204);
    if (env.CONVERSION_ANALYTICS_ENABLED !== "true" ||
        (env.CF_PAGES_BRANCH && env.CF_PAGES_BRANCH !== "main")) return response(404);

    const contentType = request.headers.get("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) return response(415);
    const length = request.headers.get("Content-Length");
    if (length !== null && !/^\d+$/.test(length)) return response(400);
    if (length !== null && Number(length) > maxBodyBytes) return response(413);

    let data;
    try {
        const body = await readBody(request);
        if (body.tooLarge) return response(413);
        data = body.data;
    } catch {
        return response(400);
    }
    if (!isValid(data)) return response(400);

    try {
        if (!env.ANALYTICS) return response(503);
        // This counter stores no request identity and is local to one isolate.
        const currentMinute = Math.floor(Date.now() / 60_000);
        if (currentMinute !== minute) {
            minute = currentMinute;
            writes = 0;
        }
        if (writes >= maxWritesPerMinute) return response(429);
        writes += 1;
        // Analytics Engine supplies the ingestion timestamp. A fixed index supports sampling-aware counts.
        env.ANALYTICS.writeDataPoint({
            indexes: ["site"],
            blobs: [data.event, data.path, data.language, data.source, data.medium, data.campaign, data.service]
        });
    } catch {
        return response(503);
    }
    return response(204);
}
