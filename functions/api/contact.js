import {productionOrigin, services} from "../../analytics-schema.mjs";

const sender = "anfragen@eiricha.com";
const recipient = "arthur.eirich.88@gmail.com";
const action = "contact";
const maxBytes = 16_384;
const fields = ["name", "contact", "service", "message", "language", "privacy", "honeypot", "token"];
const emailPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const singleLine = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const topics = {
    de: {pc: "PC & Windows", mac: "Mac & Apple", wifi: "WLAN", mobile: "Smartphone & Tablet",
        backup: "Datensicherung", printer: "Drucker & Scanner", seniors: "Hilfe für Senioren",
        web: "Webseiten", software: "Individualsoftware", other: "Sonstiges", "": "Ohne Thema"},
    en: {pc: "PC & Windows", mac: "Mac & Apple", wifi: "Wi-Fi", mobile: "Mobile & tablet",
        backup: "Data backup", printer: "Printers & scanners", seniors: "Help for seniors",
        web: "Websites", software: "Custom software", other: "Other", "": "Unspecified"}
};

function reply(status, error, headers) {
    return Response.json(error ? {success: false, error} : {success: true}, {
        status, headers: {"Cache-Control": "no-store", ...headers}
    });
}

async function readBody(request) {
    const reader = request.body?.getReader();
    if (!reader) return {};
    const bytes = new Uint8Array(maxBytes);
    let size = 0;
    try {
        for (;;) {
            const {value, done} = await reader.read();
            if (done) break;
            if (size + value.byteLength > maxBytes) {
                void reader.cancel().catch(() => {});
                return {oversized: true};
            }
            bytes.set(value, size);
            size += value.byteLength;
        }
        return {data: JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, size)))};
    } finally {
        reader.releaseLock();
    }
}

function validate(data) {
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        Object.keys(data).length !== fields.length ||
        !fields.every((field) => Object.hasOwn(data, field) && typeof data[field] === "string")) return null;
    const {language, privacy, honeypot, service, token} = data;
    if ((language !== "de" && language !== "en") || privacy !== "yes" || honeypot !== "" ||
        (!services.has(service) && service !== "other")) return null;
    const {name, contact, message} = data;
    if (name.length > 100 || contact.length > 100 || message.length > 3000 ||
        !singleLine.test(name) || !singleLine.test(contact) ||
        !name.trim() || !message.trim() ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)) return null;
    const address = contact.trim();
    const isEmail = emailPattern.test(address) && !address.startsWith(".") &&
        !address.includes("..") && !address.includes(".@") && address.indexOf("@") <= 64;
    const digits = address.replace(/\D/g, "");
    const isPhone = /^\+?[\d ()/.-]+$/.test(address) && digits.length >= 7 && digits.length <= 20;
    if (!isEmail && !isPhone) return null;
    return {
        name: name.trim(), contact: address, message: message.trim(), service, language,
        email: isEmail ? address : "", token
    };
}

async function verify(token, secret) {
    if (!token || token.length > 2048 || !singleLine.test(token)) return false;
    const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({secret, response: token}),
        signal: AbortSignal.timeout(8000),
        redirect: "error"
    });
    if (!verification.ok) throw new Error("Turnstile unavailable");
    const result = await verification.json();
    if (result?.["error-codes"]?.some((code) =>
        ["internal-error", "missing-input-secret", "invalid-input-secret"].includes(code))) {
        throw new Error("Turnstile unavailable");
    }
    return result?.success === true && result.hostname === "eiricha.com" && result.action === action;
}

async function deliver(form, env) {
    const topic = topics[form.language][form.service];
    const english = form.language === "en";
    const data = {
        from: {address: sender, name: "Eirich IT-Service"},
        to: recipient,
        subject: (english ? "New customer enquiry | " : "Neue Kundenanfrage | ") + topic,
        text: [
            `Name: ${form.name}`,
            `${english ? "Contact" : "Kontakt"}: ${form.contact}`,
            `${english ? "Service" : "Dienstleistung"}: ${topic}`,
            `${english ? "Language" : "Sprache"}: ${form.language.toUpperCase()}`,
            "", form.message
        ].join("\n")
    };
    if (form.email) data.reply_to = form.email;
    const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data),
            signal: AbortSignal.timeout(12000),
            redirect: "error"
        }
    );
    if (!response.ok) return false;
    const {success, result} = await response.json();
    return success === true && Boolean(result?.message_id) &&
        [result.delivered, result.queued].some((addresses) => Array.isArray(addresses) && addresses.includes(recipient));
}

export async function onRequest({request, env}) {
    const url = new URL(request.url);
    if (url.origin !== productionOrigin || url.pathname !== "/api/contact" || url.search ||
        env.CONTACT_BACKEND_ENABLED !== "true" || (env.CF_PAGES_BRANCH && env.CF_PAGES_BRANCH !== "main")) {
        return reply(404, "not_found");
    }
    if (request.method !== "POST") return reply(405, "method", {Allow: "POST"});
    if (request.headers.get("Origin") !== productionOrigin ||
        ![null, "same-origin"].includes(request.headers.get("Sec-Fetch-Site"))) return reply(403, "origin");
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")) {
        return reply(415, "content_type");
    }
    const length = request.headers.get("Content-Length");
    if (length !== null && !/^\d+$/.test(length)) return reply(400, "invalid_request");
    if (length !== null && Number(length) > maxBytes) return reply(413, "too_large");
    if (!/^[a-f\d]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
        !env.CLOUDFLARE_EMAIL_API_TOKEN?.trim() ||
        !/^[a-zA-Z0-9_-]{10,100}$/.test(env.TURNSTILE_SITE_KEY ?? "") ||
        !env.TURNSTILE_SECRET_KEY?.trim() || /^[123]x0{8}/.test(env.TURNSTILE_SITE_KEY) ||
        /^[123]x0{8}/.test(env.TURNSTILE_SECRET_KEY) ||
        env.CONTACT_EMAIL_FROM !== sender) return reply(503, "unavailable");

    let form;
    try {
        const body = await readBody(request);
        if (body.oversized) return reply(413, "too_large");
        form = validate(body.data);
    } catch {
        return reply(400, "invalid_request");
    }
    if (!form) return reply(400, "invalid_request");

    try {
        if (!await verify(form.token, env.TURNSTILE_SECRET_KEY)) return reply(400, "verification");
    } catch {
        return reply(503, "verification_unavailable");
    }
    try {
        if (await deliver(form, env)) return reply(200);
    } catch {
        // The provider may already have accepted the message. Never retry here.
    }
    return reply(502, "delivery_unconfirmed");
}
