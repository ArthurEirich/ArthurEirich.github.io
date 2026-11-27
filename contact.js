const widgetURL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function setup(form) {
    const container = form.querySelector("[data-turnstile]");
    const notice = form.querySelector("[data-turnstile-notice]");
    let widget;
    let loading;
    let token = "";

    function unavailable() {
        token = "";
        notice.textContent = notice.dataset.unavailable;
    }

    function ready() {
        if (widget !== undefined) return Promise.resolve();
        if (loading) return loading;
        const loader = document.createElement("script");
        loader.async = true;
        loader.src = widgetURL;
        loader.referrerPolicy = "origin";
        loading = new Promise((resolve, reject) => {
            let expired = false;
            const timeout = setTimeout(() => {
                expired = true;
                reject(new Error("Turnstile timeout"));
            }, 8000);
            loader.onerror = () => {
                clearTimeout(timeout);
                reject(new Error("Turnstile script unavailable"));
            };
            loader.onload = () => {
                clearTimeout(timeout);
                if (expired) return;
                try {
                    widget = window.turnstile.render(container, {
                        sitekey: form.dataset.turnstileSiteKey,
                        "response-field": false,
                        action: "contact",
                        language: form.dataset.contactLanguage,
                        callback(value) { token = value; notice.textContent = ""; },
                        "expired-callback"() { token = ""; notice.textContent = notice.dataset.complete; },
                        "timeout-callback": unavailable,
                        "error-callback": unavailable
                    });
                    resolve();
                } catch (error) {
                    reject(error);
                }
            };
            document.head.append(loader);
        }).catch(() => {
            loader.remove();
            loading = undefined;
            unavailable();
            throw new Error("Turnstile unavailable");
        });
        return loading;
    }

    function prepare() {
        void ready().catch(() => {});
    }

    if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            prepare();
        }, {rootMargin: "100px"});
        observer.observe(form);
    }
    form.addEventListener("focusin", prepare, {once: true});

    return async function submit(service) {
        try {
            await ready();
        } catch {
            return {error: "verification_unavailable"};
        }
        if (!token) {
            notice.textContent = notice.dataset.complete;
            return {error: "verification"};
        }
        const {name, kontakt, nachricht, datenschutz, _honey} = form.elements;
        const body = JSON.stringify({
            name: name.value,
            contact: kontakt.value,
            message: nachricht.value,
            language: form.dataset.contactLanguage,
            service,
            privacy: datenschutz.checked ? "yes" : "",
            honeypot: _honey.value,
            token
        });
        token = "";
        try {
            const response = await fetch("/api/contact", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                credentials: "omit",
                referrerPolicy: "no-referrer",
                body
            });
            const result = await response.json();
            if (response.ok && result?.success === true) return {success: true};
            return {error: result?.error ?? "delivery_unconfirmed"};
        } catch {
            return {error: "delivery_unconfirmed"};
        } finally {
            try {
                window.turnstile.reset(widget);
            } catch {
                unavailable();
            }
        }
    };
}
