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
