import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {test} from "node:test";
import {runInNewContext} from "node:vm";
import {languageFor} from "../../analytics-schema.mjs";
import {onRequest} from "../../functions/api/analytics.js";

const origin = "https://eiricha.com";
const endpoint = origin + "/api/analytics";
const valid = {
    event: "email_click", path: "/en/", language: "en",
    source: "google", medium: "organic", campaign: "zurich_it_support"
};

function fixture() {
    const rows = [];
    const env = {
        CONVERSION_ANALYTICS_ENABLED: "true",
        ANALYTICS: {writeDataPoint: (row) => rows.push(row)}
    };
    return {rows, env};
}

function send(env, options = {}) {
    const {url = endpoint, headers = {}, method = "POST", body = JSON.stringify(valid)} = options;
    return onRequest({
        env, request: new Request(url, {
            method,
            headers: {"Origin": origin, "Content-Type": "application/json", ...headers},
            body: method === "POST" ? body : undefined,
            duplex: "half"
        })
    });
}

test("writes a minimal allowed event with a fixed sampling index", async () => {
    const {rows, env} = fixture();
    const reply = await send(env);
    assert.equal(reply.status, 204);
    assert.equal(reply.headers.get("Cache-Control"), "no-store");
    assert.equal(reply.headers.has("Access-Control-Allow-Origin"), false);
    assert.equal(await reply.text(), "");
    assert.deepEqual(rows, [{
        indexes: ["site"],
        blobs: ["email_click", "/en/", "en", "google", "organic", "zurich_it_support"]
    }]);
});

test("rejects malformed events, extra fields, unknown UTM values and personal data", async () => {
    const {rows, env} = fixture();
    for (const invalid of [
        {...valid, event: "pageview"},
        {...valid, event: "contact_form_success", path: "/en/it-support-zurich/"},
        {...valid, path: "/en/?name=Someone"},
        {...valid, language: "de"},
        {...valid, medium: "unknown"},
        {...valid, source: "somebody@example.com"},
        {...valid, campaign: "somebody@example.com"},
        {...valid, phone: "+41000000000"},
        {...valid, timestamp: 123},
        {...valid, event: "utm_landing", source: "other_referral", medium: "", campaign: ""},
        {...valid, campaign: null}, [], null
    ]) {
        assert.equal((await send(env, {body: JSON.stringify(invalid)})).status, 400);
    }
    assert.equal((await send(env, {body: "{"})).status, 400);
    assert.equal(rows.length, 0);
});

test("checks method, origin, media type and both declared and streamed body lengths", async () => {
    const {rows, env} = fixture();
    const cases = [
        [{method: "GET"}, 405], [{method: "OPTIONS"}, 405],
        [{url: endpoint + "?extra=1"}, 404],
        [{headers: {Origin: "null"}}, 403],
        [{headers: {Origin: "https://www.eiricha.com"}}, 403],
        [{headers: {"Sec-Fetch-Site": "cross-site"}}, 403],
        [{headers: {"Content-Type": "text/plain"}}, 415],
        [{headers: {"Content-Length": "513"}}, 413],
        [{body: new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(300));
                controller.enqueue(new Uint8Array(213));
                controller.close();
            }
        })}, 413]
    ];
    for (const [options, status] of cases) {
        assert.equal((await send(env, options)).status, status);
    }
    assert.equal(rows.length, 0);
});

test("suppresses writes for disabled, preview, GPC and DNT requests", async () => {
    const {rows, env} = fixture();
    assert.equal((await send({...env, CONVERSION_ANALYTICS_ENABLED: undefined})).status, 404);
    assert.equal((await send({...env, CF_PAGES_BRANCH: "feature"})).status, 404);
    assert.equal((await send(env, {url: "https://feature.eirich-it-services.pages.dev/api/analytics"})).status, 404);
    assert.equal((await send(env, {headers: {"Sec-GPC": "1"}})).status, 204);
    assert.equal((await send(env, {headers: {DNT: "1"}})).status, 204);
    assert.equal(rows.length, 0);
});

test("handles missing and failing Analytics Engine bindings", async () => {
    const {env} = fixture();
    assert.equal((await send({...env, ANALYTICS: undefined})).status, 503);
    assert.equal((await send({...env, ANALYTICS: {writeDataPoint() { throw new Error("offline"); }}})).status, 503);
});

test("caps writes per isolate and reopens the next minute", async (t) => {
    let now = 60_000;
    t.mock.method(Date, "now", () => now);
    const {rows, env} = fixture();
    for (let i = 0; i < 120; i++) assert.equal((await send(env)).status, 204);
    assert.equal((await send(env)).status, 429);
    assert.equal(rows.length, 120);
    now += 60_000;
    assert.equal((await send(env)).status, 204);
});

let browserNumber = 0;
async function exerciseBrowser({url = origin + "/", referrer = "", navigator = {}, transportFails = false}, exercise) {
    const requests = [];
    const formRequests = [];
    const listeners = new Map();
    const formListeners = new Map();
    const button = {disabled: false};
    const status = {};
    const form = {
        dataset: {endpoint: "https://formsubmit.co/ajax/test", msgOk: "sent", msgError: "error"},
        elements: {thema: {options: [{dataset: {service: "pc"}}]}},
        addEventListener: (type, listener) => formListeners.set(type, listener),
        querySelector: () => button,
        resetCount: 0,
        reset() { this.resetCount += 1; },
        dispatchEvent: (event) => listeners.get(event.type)?.({target: form, detail: event.detail})
    };
    const window = {location: new URL(url)};
    const document = {
        referrer,
        getElementById: (id) => ({"contact-form": form, "form-status": status})[id] ?? null,
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener(type, listener) {
            assert(!listeners.has(type), "duplicate analytics listener");
            listeners.set(type, listener);
        }
    };
    const fetch = (path, options) => {
        if (path === "/api/analytics") {
            requests.push(options);
            return transportFails ? Promise.reject(new Error("offline")) : Promise.resolve();
        }
        formRequests.push(options);
        return new Promise((resolve) => { form.respond = resolve; });
    };
    runInNewContext(readFileSync("script.js", "utf8"), {
        window, document, fetch, URLSearchParams, CustomEvent, FormData: class {}
    });

    const names = ["window", "document", "fetch", "navigator"];
    const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
    try {
        [window, document, fetch, navigator].forEach((value, index) => {
            Object.defineProperty(globalThis, names[index], {value, configurable: true});
        });
        const module = "../../analytics.js?browser=" + ++browserNumber;
        await import(module);
        await import(module);
        // Registered handlers read fetch and document when an event occurs.
        return await exercise({
            requests, formRequests, listeners, form, button, status,
            submit: () => formListeners.get("submit")({preventDefault() {}}),
            click(href, isTrusted = true) {
                listeners.get("click")?.({isTrusted, target: {closest: () => ({href})}});
            },
            events: () => requests.map(({body}) => JSON.parse(body))
        });
    } finally {
        descriptors.forEach((descriptor, index) => {
            if (descriptor) Object.defineProperty(globalThis, names[index], descriptor);
            else delete globalThis[names[index]];
        });
    }
}
function withBrowser(name, options, exercise) {
    test(name, () => exerciseBrowser(options, exercise));
}

withBrowser("delegates real contact clicks without sending full URLs or unknown UTM values", {
    url: origin + "/en/?utm_source=GOOGLE&utm_medium=email&utm_medium=social&utm_campaign=private%40example.com",
    referrer: "https://unlisted.example/private?secret=never"
}, ({click, events, requests}) => {
    click("tel:+41000000000");
    click("mailto:private@example.com");
    click("https://wa.me/41000000000");
    click("https://wa.me.evil.example/");
    click("tel:+41000000000", false);
    assert.deepEqual(events().map((data) => data.event), ["utm_landing", "phone_click", "email_click", "whatsapp_click"]);
    for (const {body, credentials, referrerPolicy, keepalive} of requests) {
        assert(!body.includes("example.com"));
        assert(!body.includes("41000000000"));
        assert.equal(credentials, "omit");
        assert.equal(referrerPolicy, "no-referrer");
        assert.equal(keepalive, true);
    }
    assert(events().every(({source, medium, campaign}) => source === "google" && medium === "" && campaign === ""));
});

withBrowser("tracks one confirmed form success, preserves service preselection and handles provider errors", {
    url: origin + "/en/?service=pc",
    transportFails: true
}, async ({submit, form, formRequests, events, status, button}) => {
    assert.equal(form.elements.thema.options[0].selected, true);
    const pending = submit();
    await submit();
    assert.equal(button.disabled, true);
    assert.equal(formRequests.length, 1);
    assert.equal(events().length, 0);
    form.respond({ok: true, json: async () => ({success: "true"})});
    await pending;
    assert.equal(form.resetCount, 1);
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, "sent");
    const second = submit();
    form.respond({ok: true, json: async () => ({success: "false"})});
    await second;
    assert.equal(form.resetCount, 1);
    assert.equal(status.textContent, "error");
    assert.deepEqual(events().map((data) => data.event), ["contact_form_success", "contact_form_error"]);
});

for (const navigator of [{globalPrivacyControl: true}, {doNotTrack: "1"}]) {
    withBrowser("respects browser " + Object.keys(navigator)[0], {navigator, url: origin + "/?utm_source=google"},
        ({click, requests}) => {
            click("tel:+41000000000");
            assert.equal(requests.length, 0);
        });
}

withBrowser("normalizes external referrers and caps events per document", {
    referrer: "https://www.google.ch/private?secret=hidden"
}, ({click, events}) => {
    for (let i = 0; i < 21; i++) click("tel:+41000000000");
    assert.equal(events().length, 20);
    assert(events().every(({source}) => source === "google"));
});

test("Pages builds preserve static routes, metadata, and disabled and preview isolation", () => {
    const sitemap = readFileSync("sitemap.xml", "utf8");
    const routes = Array.from(sitemap.matchAll(/<loc>https:\/\/eiricha\.com([^<]*)<\/loc>/g), (match) => match[1]);
    assert(routes.length > 0);
    const build = (branch, activation) => execFileSync("python3", [".github/scripts/build_pages.py"], {
        env: {...process.env, CF_PAGES_BRANCH: branch, CONVERSION_ANALYTICS_ENABLED: activation}
    });
    build("main", "true");
    for (const path of routes) {
        assert.equal(languageFor(path), path.startsWith("/en/") ? "en" : "de");
        const file = path.slice(1) + "index.html";
        const output = readFileSync("dist/" + file, "utf8");
        const loader = '<script type="module" src="/analytics.js" referrerpolicy="no-referrer"></script>\n';
        assert.equal(output.split(loader).length, 2);
        assert.equal(output.replace(loader, ""), readFileSync(file, "utf8"));
    }
    build("feature", "true");
    assert.equal(existsSync("dist/analytics.js"), false);
    assert.equal(readFileSync("dist/index.html", "utf8"), readFileSync("index.html", "utf8"));
    build("main", "");
    assert.equal(existsSync("dist/analytics.js"), false);
    assert.deepEqual(JSON.parse(readFileSync("dist/_routes.json", "utf8")), {
        version: 1, include: ["/api/analytics"], exclude: []
    });
    const publicFiles = [
        ...routes.map((path) => path.slice(1) + "index.html"),
        "_routes.json", "404.html", "CNAME", "robots.txt", "sitemap.xml", "styles.css", "script.js",
        "assets/arthur.jpg", "assets/arthur-web.jpg", "assets/logo.svg", "assets/og-image.jpg",
        ...readdirSync(".").filter((name) => /^[a-f0-9]{32}\.txt$/.test(name))
    ];
    assert.deepEqual(readdirSync("dist", {recursive: true, withFileTypes: true})
        .filter((entry) => entry.isFile())
        .map((entry) => entry.parentPath.slice(4).replace(/^\//, "") + "/" + entry.name)
        .map((name) => name.replace(/^\//, "")).sort(), publicFiles.sort());
    for (const file of publicFiles) {
        assert.deepEqual(readFileSync("dist/" + file), readFileSync(file));
    }
});
