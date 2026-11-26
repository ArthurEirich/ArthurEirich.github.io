const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const {readFile} = require("node:fs/promises");
const {after, before, test} = require("node:test");

const {chromium} = require(process.env.PLAYWRIGHT_MODULE || require.resolve("playwright", {paths: [process.cwd()]}));
const origin = "https://eiricha.com";
const recipient = "arthur.eirich.88@gmail.com";
const account = "0123456789abcdef0123456789abcdef";
const preferenceKey = "eiricha.analyticsConsent";
let browser;
let contactHandler;
let analyticsHandler;

function build({contact = false, conversions = false, web = false} = {}) {
    execFileSync("python3", [".github/scripts/build_pages.py"], {
        env: {...process.env, CF_PAGES_BRANCH: "main", CONTACT_BACKEND_ENABLED: contact ? "true" : "",
            TURNSTILE_SITE_KEY: "isolatedMockSiteKey", CONVERSION_ANALYTICS_ENABLED: conversions ? "true" : "",
            WEB_ANALYTICS_BEACON_TOKEN: web ? account : ""}
    });
}

before(async () => {
    ({onRequest: contactHandler} = await import("../../functions/api/contact.js"));
    ({onRequest: analyticsHandler} = await import("../../functions/api/analytics.js"));
    browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {});
});
after(async () => {
    await browser?.close();
    build();
});

const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Expected browser request did not arrive");
};

async function fixture(t, flags, {mobile = false, signal} = {}) {
    build(flags);
    const context = await browser.newContext({
        viewport: mobile ? {width: 360, height: 760} : {width: 1280, height: 900},
        isMobile: mobile, hasTouch: mobile
    });
    t.after(() => context.close());
    if (signal) {
        await context.addInitScript((name) => Object.defineProperty(navigator, name, {
            value: name === "globalPrivacyControl" ? true : "1"
        }), signal);
    }
    const state = {
        rows: [], requests: [], deliveries: [], attempts: 0, legacy: 0, verifications: 0,
        emailStatus: "accepted", emailGate: null, moduleGate: null, widgetBlocked: false
    };
    const config = {CONTACT_BACKEND_ENABLED: flags.contact ? "true" : "", CF_PAGES_BRANCH: "main",
        CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_EMAIL_API_TOKEN: "test-secret",
        CONTACT_EMAIL_FROM: "anfragen@eiricha.com", TURNSTILE_SECRET_KEY: "test-secret",
        TURNSTILE_SITE_KEY: "isolatedMockSiteKey"};
    t.mock.method(globalThis, "fetch", async (url, request) => {
        if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
            state.verifications++;
            const token = request.body.get("response");
            assert.equal(request.body.get("secret"), "test-secret");
            return Response.json(token === "valid" ? {success: true, action: "contact", hostname: "eiricha.com"}
                : {success: false, "error-codes": [token === "expired" ? "timeout-or-duplicate" : "invalid-input-response"]});
        }
        assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`);
        state.deliveries.push(JSON.parse(request.body));
        await state.emailGate;
        if (state.emailStatus !== "accepted") return Response.json({success: false}, {status: 502});
        return Response.json({success: true, result: {message_id: "mock", queued: [recipient]}});
    });
    await context.route("**/*", async (route) => {
        const rq = route.request();
        const url = new URL(rq.url());
        state.requests.push(url.pathname);
        if (url.hostname === "challenges.cloudflare.com") {
            if (state.widgetBlocked) return route.abort();
            return route.fulfill({contentType: "text/javascript", body: `
                let callbacks;
                window.turnstile = {
                    render(element, options) {
                        if (options.action !== 'contact') throw new Error('Incorrect action');
                        callbacks = options;
                        element.textContent = 'Mock security check';
                        return 'test-widget';
                    },
                    reset() {},
                    testToken(token) { callbacks.callback(token); },
                    testExpiry() { callbacks['expired-callback'](); }
                };`});
        }
        if (url.hostname === "static.cloudflareinsights.com") {
            return route.fulfill({contentType: "text/javascript", body: "window.testBeaconLoaded = true;"});
        }
        if (url.hostname === "formsubmit.co") {
            state.legacy++;
            return route.fulfill({headers: {"access-control-allow-origin": origin}, json: {success: "true"}});
        }
        if (url.origin !== origin) return route.abort();
        if (url.pathname === "/api/contact" || url.pathname === "/api/analytics") {
            const headers = await rq.allHeaders();
            assert.equal(headers.origin, origin);
            assert.equal(headers.referer, undefined);
            assert.equal(headers.cookie, undefined);
            const request = new Request(url, {method: rq.method(), headers, body: rq.postData()});
            if (url.pathname === "/api/contact") {
                state.attempts++;
                const reply = await contactHandler({request, env: config});
                return route.fulfill({status: reply.status, contentType: "application/json", body: await reply.text()});
            }
            const reply = await analyticsHandler({request, env: {CONVERSION_ANALYTICS_ENABLED: flags.conversions ? "true" : "",
                ANALYTICS: {writeDataPoint(row) { state.rows.push(row); }}}});
            return route.fulfill({status: reply.status});
        }
        if (url.pathname === "/analytics.js") await state.moduleGate;
        const path = "dist" + url.pathname + (url.pathname.endsWith("/") ? "index.html" : "");
        return route.fulfill({path, body: await readFile(path),
            ...(path.endsWith(".mjs") ? {contentType: "text/javascript"} : {})});
    });
    async function newPage(path) {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        await page.goto(origin + path);
        await page.locator("#privacy-settings").waitFor();
        return page;
    }
    return {state, newPage};
}

const panel = (page) => page.locator("#privacy-consent");
const settings = (page) => page.locator("#privacy-settings");
const accept = (page) => page.locator("#privacy-accept");
const reject = (page) => page.locator("#privacy-reject");
const restart = (page) => page.locator("#privacy-restart");
const status = (page) => page.locator("#form-status");
const analyticsRequested = (state) => state.requests.some((path) =>
    ["/analytics.js", "/analytics-schema.mjs", "/api/analytics", "/beacon.min.js", "/cdn-cgi/rum"].includes(path));

async function fill(page) {
    const form = page.locator("#contact-form");
    for (const [name, value] of [["name", "Example"], ["kontakt", "reply@example.test"], ["nachricht", "Browser test draft"]]) {
        await form.locator(`[name="${name}"]`).fill(value);
    }
    await form.locator("[name=datenschutz]").check();
    return form;
}

async function token(page, value) {
    await page.getByText("Mock security check").waitFor();
    await page.evaluate((value) => window.turnstile.testToken(value), value);
}

test("German desktop and English mobile consent, keyboard controls, rejection and persisted acceptance", async (t) => {
    for (const [path, mobile, label] of [["/", false, "Statistik erlauben"], ["/en/", true, "Allow analytics"]]) {
        await t.test(label, async (t) => {
            const {state, newPage} = await fixture(t, {web: true}, {mobile});
            const page = await newPage(path);
            assert.equal(await accept(page).textContent(), label);
            assert.equal(await accept(page).evaluate((button) => button.className), await reject(page).evaluate((button) => button.className));
            assert.equal(await panel(page).evaluate((node) => node.getBoundingClientRect().right <= innerWidth), true);
            assert.equal(analyticsRequested(state), false);
            await reject(page).click();
            await page.goto(origin + (mobile ? "/" : "/en/"));
            await settings(page).focus();
            await page.keyboard.press("Enter");
            assert.equal(await page.evaluate(() => document.activeElement.id), "privacy-consent-title");
            await page.keyboard.press("Escape");
            assert.equal(await panel(page).isVisible(), false);
            assert.equal(await page.evaluate(() => document.activeElement.id), "privacy-settings");
            await settings(page).click();
            await accept(page).click();
            assert.equal(analyticsRequested(state), false);
            await page.reload();
            await page.waitForFunction(() => window.testBeaconLoaded);
            assert.equal(state.requests.filter((path) => path === "/beacon.min.js").length, 1);
            await settings(page).click();
            await Promise.all([page.waitForEvent("framenavigated"), reject(page).click()]);
            assert.equal(state.requests.filter((path) => path === "/beacon.min.js").length, 1);
        });
    }
});

test("GPC and DNT override consent; unconfigured analytics leaves the prompt closed", async (t) => {
    for (const signal of ["globalPrivacyControl", "doNotTrack", undefined]) {
        await t.test(signal || "unconfigured", async (t) => {
            const {state, newPage} = await fixture(t, {web: Boolean(signal), conversions: Boolean(signal)}, {signal});
            const page = await newPage("/en/?utm_source=google");
            await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
                version: 2, scope: "web-analytics,conversions", preference: "allow", date: "2026-11-26"
            })), preferenceKey);
            await page.reload();
            assert.equal(await panel(page).isVisible(), false);
            assert.equal(analyticsRequested(state), false);
            if (signal) {
                await settings(page).click();
                assert.equal(await accept(page).isDisabled(), true);
            }
        });
    }
});

test("queues only post-consent interactions while the conversion module loads", async (t) => {
    const {state, newPage} = await fixture(t, {conversions: true});
    let unblock;
    state.moduleGate = new Promise((resolve) => { unblock = resolve; });
    t.after(unblock);
    const page = await newPage("/en/?utm_source=google");
    // Target a new browsing context so the original landing document survives the real click.
    const link = page.locator('a[href^="mailto:"]').first();
    await link.evaluate((anchor) => { anchor.target = "_blank"; });
    await link.click();
    assert.equal(analyticsRequested(state), false);
    await accept(page).click();
    await link.click();
    unblock();
    await waitFor(() => state.rows.length === 2);
    assert.deepEqual(state.rows.map(({blobs}) => [blobs[0], blobs[3]]), [["utm_landing", "google"], ["email_click", "google"]]);
});

test("contact without consent handles missing, expired and invalid challenges, and retains failure inputs", async (t) => {
    const {state, newPage} = await fixture(t, {contact: true}, {mobile: true});
    const page = await newPage("/en/?service=wifi");
    assert.equal(await panel(page).isVisible(), false);
    const form = await fill(page);
    const submit = form.locator("button[type=submit]");
    assert.equal(await form.locator("[name=thema] option:checked").getAttribute("data-service"), "wifi");
    await page.getByText("Mock security check").waitFor();
    await submit.click();
    await page.locator("#form-status.err").waitFor();
    assert.equal(state.attempts, 0);
    await token(page, "valid");
    await page.evaluate(() => window.turnstile.testExpiry());
    await submit.click();
    assert.equal(state.attempts, 0);
    await token(page, "expired");
    await submit.click();
    await waitFor(() => state.attempts === 1);
    await page.locator("#form-status.err").waitFor();
    await token(page, "invalid");
    await submit.click();
    await waitFor(() => state.attempts === 2);
    await page.locator("#form-status.err").waitFor();
    assert.equal(state.verifications, 2);
    assert.equal(state.deliveries.length, 0);

    state.emailStatus = "unconfirmed";
    await token(page, "valid");
    await form.evaluate((element) => { element.requestSubmit(); element.requestSubmit(); });
    await page.waitForFunction(() => document.querySelector("#form-status").textContent.includes("could not be confirmed"));
    assert.equal(state.deliveries.length, 1);
    assert.equal(state.attempts, 3);
    assert.equal(await form.locator("[name=nachricht]").inputValue(), "Browser test draft");
    state.emailStatus = "accepted";
    await token(page, "valid");
    await submit.click();
    await page.locator("#form-status.ok").waitFor();
    assert.equal(state.deliveries.length, 2);
    assert.equal(state.deliveries[1].reply_to, "reply@example.test");
    assert.equal(state.deliveries[1].to, recipient);
    assert.equal(analyticsRequested(state), false);
});

test("blocked widget offers alternatives and makes no delivery request", async (t) => {
    const {state, newPage} = await fixture(t, {contact: true}, {mobile: true});
    state.widgetBlocked = true;
    const page = await newPage("/");
    const form = await fill(page);
    await form.locator("button[type=submit]").click();
    await page.locator("#form-status.err").waitFor();
    assert.match(await status(page).textContent(), /Ruf mich an/);
    assert.equal(await form.locator("[name=nachricht]").inputValue(), "Browser test draft");
    assert.equal(state.attempts, 0);
    assert.equal(state.legacy, 0);
});

test("cross-tab withdrawal protects pending delivery and preserves the confirmed outcome", async (t) => {
    const {state, newPage} = await fixture(t, {contact: true, conversions: true, web: true});
    const tab = await newPage("/en/");
    await accept(tab).click();
    const formPage = await newPage("/en/?service=mac");
    await formPage.waitForFunction(() => window.testBeaconLoaded);
    const form = await fill(formPage);
    await token(formPage, "valid");
    let finish;
    state.emailGate = new Promise((resolve) => { finish = resolve; });
    t.after(finish);
    await form.locator("button[type=submit]").click();
    await waitFor(() => state.deliveries.length === 1);
    await settings(tab).click();
    await reject(tab).click();
    await restart(formPage).waitFor();
    assert.equal(await restart(formPage).isDisabled(), true);
    assert.equal(await form.locator("[name=nachricht]").inputValue(), "Browser test draft");
    finish();
    await formPage.locator("#form-status.ok").waitFor();
    assert.equal(await restart(formPage).isDisabled(), false);
    assert.equal(state.rows.length, 0);
    assert.equal(state.deliveries.length, 1);
    assert.equal(await formPage.evaluate((key) => JSON.parse(localStorage.getItem(key)).preference, preferenceKey), "necessary");
    await Promise.all([formPage.waitForEvent("framenavigated"), restart(formPage).click()]);
    assert.equal(state.requests.filter((path) => path === "/beacon.min.js").length, 1);
});

test("local withdrawal preserves unsent fields and stores no contact details", async (t) => {
    const {newPage} = await fixture(t, {web: true});
    const page = await newPage("/");
    await accept(page).click();
    await page.reload();
    await page.waitForFunction(() => window.testBeaconLoaded);
    const form = await fill(page);
    await settings(page).click();
    await reject(page).click();
    await restart(page).waitFor();
    assert.equal(await form.locator("[name=nachricht]").inputValue(), "Browser test draft");
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("Browser test draft")), false);
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes("Browser test draft")), false);
    assert.equal(new URL(page.url()).search, "");
});

test("contact and conversions enabled together emit one sanitized accepted outcome", async (t) => {
    const {state, newPage} = await fixture(t, {contact: true, conversions: true});
    const page = await newPage("/en/?service=wifi&utm_source=google");
    await accept(page).click();
    await waitFor(() => state.rows.length === 1);
    const form = await fill(page);
    await token(page, "valid");
    await form.locator("button[type=submit]").click();
    await page.locator("#form-status.ok").waitFor();
    await waitFor(() => state.rows.length === 2);
    assert.deepEqual(state.rows.map(({blobs}) => [blobs[0], blobs[6]]),
        [["utm_landing", ""], ["contact_form_success", "wifi"]]);
    assert.equal(state.deliveries.length, 1);
    assert(!JSON.stringify(state.rows).includes("reply@example.test"));
});
