const year = document.getElementById("y");
if (year) year.textContent = new Date().getFullYear();

const form = document.getElementById("contact-form");
if (form) {
    const status = document.getElementById("form-status");
    const button = form.querySelector("button[type=submit]");
    const service = new URLSearchParams(window.location.search).get("service");
    const topic = Array.from(form.elements.thema.options).find((option) => option.dataset.service === service);
    if (topic) topic.selected = true;

    let submitting = false;
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (submitting) return;
        submitting = true;
        status.className = "form-status";
        status.textContent = form.dataset.msgSending;
        button.disabled = true;

        let outcome;
        try {
            const res = await fetch(form.dataset.endpoint, {
                method: "POST",
                headers: {Accept: "application/json"},
                body: new FormData(form)
            });
            if (!res.ok) throw new Error(res.status);
            const result = await res.json();
            // FormSubmit returns its success flag as a string or boolean.
            if (result?.success !== true && result?.success !== "true") {
                throw new Error("FormSubmit did not confirm submission");
            }
            form.reset();
            status.className = "form-status ok";
            status.textContent = form.dataset.msgOk;
            outcome = "success";
        } catch {
            status.className = "form-status err";
            status.textContent = form.dataset.msgError;
            outcome = "error";
        } finally {
            submitting = false;
            button.disabled = false;
        }
        form.dispatchEvent(new CustomEvent("contact-form-result", {bubbles: true, detail: outcome}));
    });
}

const calculator = document.getElementById("cost-calculator");
if (calculator) {
    const panel = document.getElementById("kostenrechner");
    const {customer, mode, duration, zone} = calculator.elements;
    const travelZone = calculator.querySelector("[data-travel-zone]");
    const results = Object.fromEntries(
        Array.from(panel.querySelectorAll("[data-estimate]"), (element) => [element.dataset.estimate, element])
    );
    const status = panel.querySelector("[data-estimate-status]");
    const integerCHF = new Intl.NumberFormat("de-CH", {
        style: "currency", currency: "CHF", maximumFractionDigits: 0
    });
    const decimalCHF = new Intl.NumberFormat("de-CH", {style: "currency", currency: "CHF"});
    const money = (rappen) => (rappen % 100 === 0 ? integerCHF : decimalCHF).format(rappen / 100);

    function updateEstimate() {
        const onSite = mode.value === "onsite";
        const hourly = Number(customer.value) * 100;
        const minimum = Number(mode.selectedOptions[0].dataset.minutes);
        const billable = Math.max(Number(duration.value), minimum);
        const labour = Math.round(hourly * billable / 60);
        const travel = onSite ? Number(zone.value) * 100 : 0;
        const total = money(labour + travel);

        zone.disabled = !onSite;
        travelZone.hidden = !onSite;
        results.rate.textContent = money(hourly);
        results.billable.textContent = `${billable} min`;
        results.labour.textContent = money(labour);
        results.travel.textContent = money(travel);
        results.total.textContent = total;
        status.textContent = `${results.total.previousElementSibling.textContent}: ${total}`;
    }

    calculator.addEventListener("change", updateEstimate);
    calculator.addEventListener("submit", (event) => event.preventDefault());
    updateEstimate();
    panel.hidden = false;
}

document.querySelectorAll("[data-scroll-form]").forEach((link) => {
    link.addEventListener("click", () => {
        const field = document.querySelector("#contact-form input[name=name]");
        if (field) setTimeout(() => field.focus({preventScroll: true}), 600);
    });
});

const navigation = document.querySelector(".site-nav-bar");
if (navigation) {
    const toggle = navigation.querySelector(".nav-toggle");
    const links = navigation.querySelector(".site-nav");
    const services = links.querySelector(".nav-services");
    const servicesSummary = services.querySelector("summary");
    const mobile = window.matchMedia("(max-width: 720px)");

    const menuIsOpen = () => toggle.getAttribute("aria-expanded") === "true";
    const closeMobileMenu = () => toggle.setAttribute("aria-expanded", "false");

    toggle.addEventListener("click", () => {
        if (menuIsOpen()) services.open = false;
        toggle.setAttribute("aria-expanded", String(!menuIsOpen()));
    });

    links.addEventListener("click", (event) => {
        const link = event.target.closest("a");
        if (!link) return;

        services.open = false;
        if (mobile.matches) closeMobileMenu();
        if (link.hash && link.pathname === window.location.pathname) {
            const section = document.getElementById(link.hash.slice(1));
            if (section) {
                section.tabIndex = -1;
                section.focus({preventScroll: true});
            }
        }
    });

    navigation.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (services.open) {
            services.open = false;
            if (services.contains(event.target)) servicesSummary.focus();
        } else if (mobile.matches && menuIsOpen()) {
            closeMobileMenu();
            toggle.focus();
        }
    });

    document.addEventListener("click", (event) => {
        if (!services.contains(event.target)) services.open = false;
    });

    mobile.addEventListener("change", () => {
        const focusInMenu = links.contains(document.activeElement);
        const focusOnToggle = document.activeElement === toggle;
        services.open = false;
        closeMobileMenu();
        if (mobile.matches && focusInMenu) toggle.focus();
        if (!mobile.matches && focusOnToggle) links.querySelector("a").focus();
    });
}
