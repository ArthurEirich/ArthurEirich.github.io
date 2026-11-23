document.getElementById("y").textContent = new Date().getFullYear();

const form = document.getElementById("contact-form");
if (form) {
    const status = document.getElementById("form-status");
    const button = form.querySelector("button[type=submit]");

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        status.className = "form-status";
        status.textContent = form.dataset.msgSending;
        button.disabled = true;

        try {
            const res = await fetch(form.dataset.endpoint, {
                method: "POST",
                headers: {Accept: "application/json"},
                body: new FormData(form)
            });
            if (!res.ok) throw new Error(res.status);
            form.reset();
            status.className = "form-status ok";
            status.textContent = form.dataset.msgOk;
        } catch (err) {
            status.className = "form-status err";
            status.textContent = form.dataset.msgError;
        } finally {
            button.disabled = false;
        }
    });
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

    toggle.hidden = false;
    toggle.addEventListener("click", () => {
        if (menuIsOpen()) services.open = false;
        toggle.setAttribute("aria-expanded", String(!menuIsOpen()));
    });

    links.addEventListener("click", (event) => {
        const link = event.target.closest("a");
        if (!link) return;

        services.open = false;
        if (!mobile.matches) return;

        closeMobileMenu();
        if (link.hash) {
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
