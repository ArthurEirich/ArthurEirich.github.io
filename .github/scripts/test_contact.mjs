import assert from "node:assert/strict";
import {test} from "node:test";
import {onRequest} from "../../functions/api/contact.js";

const origin = "https://eiricha.com";
const env = {
    CONTACT_BACKEND_ENABLED: "true", CF_PAGES_BRANCH: "main",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_EMAIL_API_TOKEN: "mock-api-token", CONTACT_EMAIL_FROM: "anfragen@eiricha.com",
    TURNSTILE_SITE_KEY: "isolatedMockSiteKey", TURNSTILE_SECRET_KEY: "isolatedMockSecret"
};
const valid = {
    name: "Example", contact: "reply@example.test", service: "wifi", message: "Please call\nThank you",
    language: "en", privacy: "yes", honeypot: "", token: "isolated-mock-token"
};
const recipient = "arthur.eirich.88@gmail.com";

function send({
    url = origin + "/api/contact", method = "POST", options = {},
    headers = {}, body = JSON.stringify(valid)
} = {}) {
    return onRequest({
        env: {...env, ...options}, request: new Request(url, {
            method,
            headers: {Origin: origin, "Content-Type": "application/json", ...headers},
            ...(method === "POST" ? {body, duplex: "half"} : {})
        })
    });
}

function mock(t, {
    verify = () => Response.json({success: true, hostname: "eiricha.com", action: "contact"}),
    email = () => Response.json({success: true, result: {message_id: "mock-id", queued: [recipient]}})
} = {}) {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, request) => {
        calls.push({url, request});
        if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") return verify();
        assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`);
        return email();
    });
    return calls;
}

test("isolates preview and disabled contact and rejects unsafe routing and content types", async (t) => {
    const calls = mock(t);
    for (const [options, status] of [
        [{url: "https://preview.pages.dev/api/contact"}, 404],
        [{options: {CF_PAGES_BRANCH: "feature"}}, 404],
        [{options: {CONTACT_BACKEND_ENABLED: undefined}}, 404],
        [{url: origin + "/api/contact?token=foo"}, 404],
        [{method: "GET"}, 405], [{method: "OPTIONS"}, 405],
        [{headers: {Origin: "null"}}, 403],
        [{headers: {Origin: "https://example.test"}}, 403],
        [{headers: {"Sec-Fetch-Site": "cross-site"}}, 403],
        [{headers: {"Content-Type": "multipart/form-data; boundary=abc"}}, 415]
    ]) {
        const response = await send(options);
        assert.equal(response.status, status);
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
    }
    assert.equal(calls.length, 0);
});

test("rejects missing or test configuration before outbound requests", async (t) => {
    const calls = mock(t);
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_EMAIL_API_TOKEN",
        "CONTACT_EMAIL_FROM", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]) {
        assert.equal((await send({options: {[name]: undefined}})).status, 503);
    }
    assert.equal((await send({options: {TURNSTILE_SITE_KEY: "1x00000000000000000000AA"}})).status, 503);
    assert.equal((await send({options: {CONTACT_EMAIL_FROM: "other@example.test"}})).status, 503);
    assert.equal(calls.length, 0);
});

test("rejects malformed, injected, oversized and unexpected form input", async (t) => {
    const calls = mock(t);
    for (const data of [
        {...valid, attachments: []}, {...valid, from: "fake@example.test"},
        {...valid, language: "fr"}, {...valid, service: "<script>"}, {...valid, service: "__proto__"},
        {...valid, contact: "reply@example.test\r\nBcc: evil@example.test"},
        {...valid, contact: "Doe <reply@example.test>"}, {...valid, contact: "a..b@example.test"},
        {...valid, name: "Example\nCc: extra@example.test"}, {...valid, name: " "},
        {...valid, token: ""}, {...valid, token: "t".repeat(2049)},
        {...valid, message: "x".repeat(3001)}, {...valid, message: "x\u0000"},
        {...valid, privacy: "no"}, {...valid, honeypot: "bot"}, [], null
    ]) {
        assert.equal((await send({body: JSON.stringify(data)})).status, 400);
    }
    assert.equal((await send({body: "{"})).status, 400);
    assert.equal((await send({headers: {"Content-Length": "16385"}})).status, 413);
    assert.equal((await send({body: new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(10_000));
            controller.enqueue(new Uint8Array(6_500));
            controller.close();
        }
    })})).status, 413);
    assert.equal(calls.length, 0);
});

test("validates Turnstile hostname, action and token before delivery", async (t) => {
    let verification;
    const calls = mock(t, {verify: () => verification});
    for (const [result, status] of [
        [Response.json({success: false, "error-codes": ["timeout-or-duplicate"]}), 400],
        [Response.json({success: true, hostname: "preview.pages.dev", action: "contact"}), 400],
        [Response.json({success: true, hostname: "eiricha.com", action: "other"}), 400],
        [Response.json({success: false, "error-codes": ["internal-error"]}), 503],
        [new Response("", {status: 503}), 503]
    ]) {
        verification = result;
        assert.equal((await send()).status, status);
    }
    assert.equal(calls.length, 5);
    assert(calls.every(({request}) => request.body.get("response") === valid.token && !request.body.has("remoteip")));
});

test("sends plain text to a fixed verified recipient and reports queued acceptance", async (t) => {
    const messages = ["log", "warn", "error"].map((level) => t.mock.method(console, level, () => {}));
    const calls = mock(t);
    const response = await send({body: JSON.stringify({...valid, message: "<script>alert(1)</script>\nHelp"})});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {success: true});
    const {request} = calls[1];
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.Authorization, "Bearer mock-api-token");
    assert.deepEqual(JSON.parse(request.body), {
        from: {address: "anfragen@eiricha.com", name: "Eirich IT-Service"},
        to: recipient, subject: "New customer enquiry | Wi-Fi", reply_to: "reply@example.test",
        text: "Name: Example\nContact: reply@example.test\nService: Wi-Fi\nLanguage: EN\n\n<script>alert(1)</script>\nHelp"
    });
    assert(messages.every((entry) => entry.mock.callCount() === 0));
});

test("preserves phone-only enquiries and uses a German subject without Reply-To", async (t) => {
    const calls = mock(t, {email: () => Response.json({
        success: true, result: {message_id: "mock-id", delivered: [recipient]}
    })});
    assert.equal((await send({body: JSON.stringify({
        ...valid, contact: "+41 (0)76 123 45 67", language: "de", service: "other"
    })})).status, 200);
    const data = JSON.parse(calls[1].request.body);
    assert.equal(data.reply_to, undefined);
    assert.equal(data.subject, "Neue Kundenanfrage | Sonstiges");
    assert.match(data.text, /Kontakt: \+41/);
});

test("does not resend when delivery is ambiguous or rejected", async (t) => {
    let attempts = 0;
    mock(t, {email() {
        attempts++;
        if (attempts === 1) throw new Error("connection lost after submission");
        if (attempts === 2) return new Response("provider details", {status: 500});
        return Response.json({
            success: true, result: {message_id: "mock-id", suppressed_recipients: [recipient]}
        });
    }});
    for (let i = 1; i <= 3; i++) {
        const response = await send();
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), {success: false, error: "delivery_unconfirmed"});
        assert.equal(attempts, i);
    }
});

test("relies on single-use Turnstile verification to reject a repeated token", async (t) => {
    let consumed = false;
    const calls = mock(t, {verify() {
        if (consumed) return Response.json({success: false, "error-codes": ["timeout-or-duplicate"]});
        consumed = true;
        return Response.json({success: true, hostname: "eiricha.com", action: "contact"});
    }});
    const responses = await Promise.all([send(), send()]);
    assert.deepEqual(responses.map(({status}) => status).sort(), [200, 400]);
    assert.equal(calls.filter(({url}) => url.startsWith("https://api.cloudflare.com/")).length, 1);
});
