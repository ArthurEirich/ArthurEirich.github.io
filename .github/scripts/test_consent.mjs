import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {runInNewContext} from "node:vm";

const source = readFileSync("consent.js", "utf8").replace("export function", "function").replace('import("./analytics.js")', "loadConversions()");
const key = "eiricha.analyticsConsent";
const grant = JSON.stringify({preference: "allow", version: 2, scope: "web-analytics,conversions", date: "2026-09-30"});
const deny = JSON.stringify({preference: "necessary", version: 2, scope: "web-analytics,conversions", date: "2026-09-30"});

class Element extends EventTarget {
    dataset = {};
    attributes = {};
    hidden = true;
    disabled = false;
    focused = false;
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
    click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}

async function load({
    store = new Map(), path = "/", hostname = "https://eiricha.com", privacy = {}, unavailable = false,
    web = true, conversions = true, existingBeacon = false, readOnly = false, contact
} = {}) {
    const elements = Object.fromEntries(["privacy-consent", "privacy-settings", "privacy-consent-title",
        "privacy-accept", "privacy-reject", "privacy-consent-notice", "privacy-restart"].map((id) => [id, new Element()]));
    const panel = elements["privacy-consent"];
    if (web) panel.dataset.webAnalytics = "0123456789abcdef0123456789abcdef";
    if (conversions) panel.dataset.conversionAnalytics = "true";
    if (contact) {
        const form = new Element();
        form.elements = {
            name: {value: contact.draft ?? ""}, kontakt: {value: ""}, nachricht: {value: ""},
            thema: {selectedIndex: 0}, datenschutz: {checked: false}
        };
        form.dataset.contactPending = contact.pending ? "true" : "";
        elements["contact-form"] = form;
    }
    const beacons = [];
    const conversionChecks = [];
    const document = {
        addEventListener() {},
        removeEventListener() {},
        getElementById: (id) => elements[id],
        querySelector: () => existingBeacon || beacons[0],
        head: {append: (element) => beacons.push(element)},
        createElement: () => new Element()
    };
    const localStorage = {
        getItem(name) {
            if (unavailable) throw new Error("blocked");
            return store.get(name) ?? null;
        },
        setItem(name, value) {
            if (unavailable || readOnly) throw new Error("blocked");
            store.set(name, value);
        },
        removeItem(name) {
            if (unavailable || readOnly) throw new Error("blocked");
            store.delete(name);
        }
    };
    const window = new EventTarget();
    const location = new URL(path, hostname);
    const navigations = [];
    location.reload = () => navigations.push("reload");
    location.replace = (url) => navigations.push(url.href);
    runInNewContext(source, {
        document, localStorage, window, navigator: privacy, history: {replaceState() {}}, location,
        URL, URLSearchParams, performance, loadConversions: async () => ({start: (check) => conversionChecks.push(check)})
    });
    await Promise.resolve();
    await Promise.resolve();
    return {
        panel, beacons, navigations, conversionChecks, window, store, form: elements["contact-form"],
        restart: elements["privacy-restart"],
        accept: elements["privacy-accept"], reject: elements["privacy-reject"], settings: elements["privacy-settings"]
    };
}

test("starts only conversions immediately after acceptance and keeps Web Analytics for the next load", async () => {
    const page = await load();
    assert.equal(page.panel.hidden, false);
    assert.equal(page.settings.hidden, false);
    assert.deepEqual(page.beacons, []);
    assert.deepEqual(page.conversionChecks, []);
    page.accept.click();
    assert.equal(page.panel.hidden, true);
    const saved = JSON.parse(page.store.get(key));
    assert.deepEqual(Object.keys(saved).sort(), ["date", "preference", "scope", "version"]);
    assert.equal(saved.preference, "allow");
    assert.equal(saved.version, 2);
    assert.match(saved.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(page.beacons, []);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(page.conversionChecks.length, 1);
    assert(page.conversionChecks[0]());
    assert.equal(page.conversionChecks[0](0), false);

    const english = await load({store: page.store, path: "/en/wifi-support-zurich/"});
    assert.equal(english.panel.hidden, true);
    assert.equal(english.beacons.length, 1);
    assert.equal(english.beacons[0].referrerPolicy, "no-referrer");
    assert.equal(english.conversionChecks.length, 1);
    assert(english.conversionChecks[0]());
});

test("remembers a rejection in both languages and leaves analytics off", async () => {
    const page = await load({path: "/en/"});
    page.reject.click();
    assert.equal(JSON.parse(page.store.get(key)).preference, "necessary");
    const german = await load({store: page.store});
    assert.equal(german.panel.hidden, true);
    assert.deepEqual(german.beacons, []);
    assert.deepEqual(german.conversionChecks, []);
});

test("withdraws active consent, stops conversion callbacks and reloads the beacon page", async () => {
    const page = await load({store: new Map([[key, grant]])});
    page.settings.click();
    assert.equal(page.settings.attributes["aria-expanded"], "true");
    page.reject.click();
    assert.equal(page.settings.focused, true);
    assert.equal(JSON.parse(page.store.get(key)).preference, "necessary");
    assert.equal(page.conversionChecks[0](), false);
    assert.deepEqual(page.navigations, ["reload"]);
});

test("honors cross-tab withdrawal and does not restart after a cross-tab grant", async () => {
    const store = new Map([[key, grant]]);
    const page = await load({store});
    store.set(key, deny);
    const change = new Event("storage");
    change.key = key;
    page.window.dispatchEvent(change);
    assert.equal(page.conversionChecks[0](), false);
    assert.deepEqual(page.navigations, ["reload"]);
    const rejected = await load({store});
    store.set(key, grant);
    rejected.window.dispatchEvent(change);
    assert.deepEqual(rejected.beacons, []);
    assert.deepEqual(rejected.conversionChecks, []);
});

test("browser privacy signals override stored consent", async () => {
    for (const privacy of [{globalPrivacyControl: true}, {doNotTrack: "1"}]) {
        const page = await load({privacy, store: new Map([[key, grant]])});
        page.settings.click();
        assert.equal(page.accept.disabled, true);
        assert.deepEqual(page.beacons, []);
        assert.deepEqual(page.conversionChecks, []);
    }
});

test("does not load analytics if consent cannot be saved or read", async () => {
    const page = await load({unavailable: true, store: new Map([[key, grant]])});
    page.accept.click();
    assert.equal(page.panel.hidden, false);
    assert.deepEqual(page.beacons, []);
    assert.deepEqual(page.conversionChecks, []);
});

test("does not reuse a grant in read-only storage", async () => {
    const page = await load({readOnly: true, store: new Map([[key, grant]])});
    assert.deepEqual(page.beacons, []);
    assert.deepEqual(page.conversionChecks, []);
});

test("honors independent product flags, preview isolation and existing beacon detection", async () => {
    const store = new Map([[key, grant]]);
    const preview = await load({store, hostname: "https://preview.pages.dev"});
    assert.deepEqual(preview.beacons, []);
    assert.deepEqual(preview.conversionChecks, []);
    const webOnly = await load({store: new Map([[key, grant.replace("web-analytics,conversions", "web-analytics")]]), conversions: false});
    assert.equal(webOnly.beacons.length, 1);
    assert.deepEqual(webOnly.conversionChecks, []);
    const conversionOnly = await load({store: new Map([[key, grant.replace("web-analytics,conversions", "conversions")]]), web: false});
    assert.deepEqual(conversionOnly.beacons, []);
    assert.equal(conversionOnly.conversionChecks.length, 1);
    const existing = await load({store, existingBeacon: true});
    assert.deepEqual(existing.beacons, []);
});

test("requires a new decision after a policy version change", async () => {
    const page = await load({store: new Map([[key, grant.replace('"version":2', '"version":1')]])});
    assert.equal(page.panel.hidden, false);
    assert.deepEqual(page.beacons, []);
    assert.deepEqual(page.conversionChecks, []);
});

test("requires fresh consent when configured analytics products change", async () => {
    const store = new Map([[key, grant.replace("web-analytics,conversions", "web-analytics")]]);
    const page = await load({store});
    assert.equal(page.panel.hidden, false);
    assert.deepEqual(page.beacons, []);
    assert.deepEqual(page.conversionChecks, []);
});

test("withdrawal preserves a draft until the visitor explicitly reloads", async () => {
    const page = await load({store: new Map([[key, grant]]), contact: {draft: "Unsaved"}});
    page.reject.click();
    assert.equal(page.conversionChecks[0](), false);
    assert.equal(JSON.parse(page.store.get(key)).preference, "necessary");
    assert.equal(page.form.elements.name.value, "Unsaved");
    assert.deepEqual(page.navigations, []);
    assert.equal(page.restart.hidden, false);
    page.restart.click();
    assert.deepEqual(page.navigations, ["reload"]);
});

test("cross-tab withdrawal waits for an in-flight submission and keeps its result visible", async () => {
    const store = new Map([[key, grant]]);
    const page = await load({store, contact: {pending: true}});
    store.set(key, deny);
    const change = new Event("storage");
    change.key = key;
    page.window.dispatchEvent(change);
    assert.equal(page.restart.disabled, true);
    assert.equal(page.conversionChecks[0](), false);
    page.restart.click();
    assert.deepEqual(page.navigations, []);
    delete page.form.dataset.contactPending;
    page.form.dispatchEvent(new Event("contact-form-result"));
    assert.equal(page.restart.disabled, false);
    assert.deepEqual(page.navigations, []);
    page.restart.click();
    assert.deepEqual(page.navigations, ["reload"]);
});

test("neither analytics product configured leaves the panel closed", async () => {
    const page = await load({web: false, conversions: false});
    assert.equal(page.panel.hidden, true);
    assert.equal(page.settings.hidden, false);
    assert.deepEqual(page.beacons, []);
    assert.deepEqual(page.conversionChecks, []);
});

test("withdrawal also protects a result that completed just before the consent change", async () => {
    const page = await load({store: new Map([[key, grant]]), contact: {}});
    page.form.dataset.contactOutcome = "success";
    page.reject.click();
    assert.equal(page.form.dataset.contactOutcome, "success");
    assert.deepEqual(page.navigations, []);
    assert.equal(page.restart.hidden, false);
    assert.equal(page.restart.disabled, false);
});
