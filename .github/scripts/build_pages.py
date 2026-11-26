"""Stage only public site files for Cloudflare Pages."""
import os
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "dist"
ORIGIN = "https://eiricha.com"
ROUTE = re.compile(r"/(?:[a-z0-9-]+/)*")
SITEMAP_NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
CONSENT_COPY = {
    "de": (
        "Datenschutzeinstellungen", "Nur notwendige", "Statistik erlauben", "Datenschutz",
        "Mit deiner Erlaubnis messen wir die Nutzung der Website. Falls aktiviert, zählt die Conversion-Messung ab deiner "
        "Einwilligung. Cloudflare Web Analytics startet beim nächsten Seitenaufruf.",
        "Dein Browser lehnt Statistik über Global Privacy Control oder Do Not Track ab.",
        "Dein Browser konnte die Auswahl nicht speichern. Für einen dauerhaften Widerruf lösche die Website-Daten im Browser.",
    ),
    "en": (
        "Privacy settings", "Necessary only", "Allow analytics", "Privacy policy",
        "With your permission, we measure how the site is used. If enabled, conversion tracking starts when you agree. "
        "Cloudflare Web Analytics starts on your next page load.",
        "Your browser opts out of analytics through Global Privacy Control or Do Not Track.",
        "Your browser could not save the choice. To withdraw permanently, clear this site’s data in your browser.",
    ),
}

CONTACT_COPY = {
    "de": (
        "Danke! Unser E-Mail-Dienst hat deine Anfrage angenommen.",
        "Bitte schliesse die Sicherheitsprüfung ab und sende das Formular erneut.",
        "Die Sicherheitsprüfung ist nicht verfügbar. Ruf mich an oder schreib mir direkt per E-Mail.",
        "Bitte überprüfe deine Eingaben. Gib eine gültige E-Mail-Adresse oder Telefonnummer an.",
        "Die Zustellung konnte nicht bestätigt werden. Deine Eingaben bleiben erhalten. Bitte kontaktiere mich "
        "direkt, statt die Nachricht sofort erneut zu senden.",
    ),
    "en": (
        "Thank you. Our email service accepted your enquiry.",
        "Please complete the security check and submit the form again.",
        "The security check is unavailable. Please call or email me directly.",
        "Please check your details and enter a valid email address or phone number.",
        "Delivery could not be confirmed. Your entries are still here. Please contact me directly "
        "before attempting another submission.",
    ),
}

public_files = (
    "_routes.json", "404.html", "CNAME", "robots.txt", "sitemap.xml", "styles.css",
    "script.js", "consent.js", "assets/arthur-web.jpg", "assets/arthur.jpg", "assets/logo.svg",
    "assets/og-image.jpg",
)


def add_consent(html, language, token, conversions):
    settings, reject, accept, privacy, explanation, signal, storage = CONSENT_COPY[language]
    policy = "/en/#datenschutz" if language == "en" else "/#datenschutz"
    config = (f' data-web-analytics="{token}"' if token else "")
    if conversions:
        config += ' data-conversion-analytics="true"'
    banner = f'''<aside class="card privacy-consent" id="privacy-consent" aria-labelledby="privacy-consent-title"{config} hidden>
    <h2 id="privacy-consent-title" tabindex="-1">{settings}</h2>
    <p>{explanation} <a href="{policy}">{privacy}</a></p>
    <p id="privacy-consent-notice" role="status" data-signal="{signal}" data-storage="{storage}" hidden></p>
    <div class="privacy-consent-actions">
        <button type="button" class="btn" id="privacy-reject">{reject}</button>
        <button type="button" class="btn" id="privacy-accept">{accept}</button>
    </div>
</aside>'''
    control = (f'<button type="button" class="privacy-settings" id="privacy-settings" '
               f'aria-controls="privacy-consent" aria-expanded="false" hidden>{settings}</button>')
    footer = re.compile(r'(<footer class="footer">.*?<nav\b[^>]*>.*?)(</nav>)', re.S)
    html, count = footer.subn(lambda match: match[1] + control + "\n" + match[2], html)
    if count != 1 or html.count("<body>") != 1 or html.count("</body>") != 1:
        raise ValueError("Expected one body and one footer navigation")
    html = html.replace("<body>", "<body>\n" + banner, 1)
    return html.replace("</body>", '<script type="module" src="/consent.js" referrerpolicy="no-referrer"></script>\n</body>', 1)


def configure_contact(html, language, site_key):
    if not site_key:
        return html
    accepted, verify, unavailable, invalid, unconfirmed = CONTACT_COPY[language]
    old = re.compile(r'(id="contact-form" method="POST")\s+action="https://formsubmit\.co/[^"]+"'
                     r'\s+data-endpoint="https://formsubmit\.co/ajax/[^"]+"')
    replacement = (f' action="/api/contact" data-endpoint="/api/contact" '
                   f'data-contact-language="{language}" data-turnstile-site-key="{site_key}" '
                   f'data-msg-verification="{verify}" data-msg-verification-unavailable="{unavailable}" '
                   f'data-msg-invalid="{invalid}" data-msg-unconfirmed="{unconfirmed}"')
    html, count = old.subn(lambda match: match[1] + replacement, html)
    if count != 1:
        raise ValueError("Expected one existing contact form")
    html = re.sub(r'data-msg-ok="[^"]+"', f'data-msg-ok="{accepted}"', html, count=1)
    html = re.sub(r'^[ \t]*<input type="hidden" name="_(subject|template|captcha)"[^>]+>\n', "", html, flags=re.M)
    notice = ("Cloudflare Turnstile schützt dieses Formular vor automatisierten Eingaben."
              if language == "de" else "Cloudflare Turnstile protects this form against automated submissions.")
    controls = (
        f'<p class="hint">{notice}</p>\n'
        f'<div data-turnstile></div>\n'
        f'<p data-turnstile-notice data-unavailable="{unavailable}" data-complete="{verify}" role="status"></p>\n'
        f'<noscript><p>{unavailable}</p></noscript>\n'
    )
    html = html.replace('<div class="form-actions">', controls + '<div class="form-actions">', 1)
    html = html.replace('<button class="btn primary" type="submit">',
                        '<button class="btn primary" type="submit" disabled>', 1)
    return (html.replace('data-contact-status="cloudflare" hidden', 'data-contact-status="cloudflare"')
                .replace('data-contact-status="formsubmit"', 'data-contact-status="formsubmit" hidden'))


def disable_preview_contact(html, language):
    note = ("Die Formularübermittlung ist in dieser Vorschau deaktiviert."
            if language == "de" else "Form delivery is disabled in this preview.")
    html = re.sub(r'action="https://formsubmit\.co/[^"]+"', 'action="/api/contact"', html, count=1)
    html = re.sub(r'data-endpoint="https://formsubmit\.co/ajax/[^"]+"',
                  'data-contact-preview="true"', html, count=1)
    html = html.replace('data-contact-status="formsubmit"', 'data-contact-status="formsubmit" hidden')
    return html.replace('<button class="btn primary" type="submit">',
                        f'<p class="hint">{note}</p><button class="btn primary" type="submit" disabled>', 1)


def build():
    branch = os.environ.get("CF_PAGES_BRANCH")
    production = branch == "main"
    conversions = production and os.environ.get("CONVERSION_ANALYTICS_ENABLED") == "true"
    token = os.environ.get("WEB_ANALYTICS_BEACON_TOKEN", "") if production else ""
    if token and not re.fullmatch(r"[a-fA-F0-9]{32}", token):
        raise ValueError("Expected a 32-character public Cloudflare Web Analytics beacon token")
    contact_enabled = production and os.environ.get("CONTACT_BACKEND_ENABLED") == "true"
    site_key = os.environ.get("TURNSTILE_SITE_KEY", "") if contact_enabled else ""
    if contact_enabled and not re.fullmatch(r"[a-zA-Z0-9_-]{10,100}", site_key):
        raise ValueError("CONTACT_BACKEND_ENABLED requires a public TURNSTILE_SITE_KEY")
    sitemap = ElementTree.parse(ROOT / "sitemap.xml")
    pages = []
    for node in sitemap.findall("s:url/s:loc", SITEMAP_NS):
        url = node.text or ""
        path = url.removeprefix(ORIGIN)
        if not url.startswith(ORIGIN) or not ROUTE.fullmatch(path):
            raise ValueError(f"Invalid site route in sitemap: {url!r}")
        pages.append(Path(path.lstrip("/")) / "index.html")

    keys = [path.name for path in ROOT.glob("*.txt") if re.fullmatch(r"[a-f0-9]{32}\.txt", path.name)]
    if not pages or len(keys) != 1:
        raise ValueError("Expected sitemap pages and exactly one IndexNow key file")

    with TemporaryDirectory(prefix=".pages-", dir=ROOT) as temp:
        stage = Path(temp) / "public"
        for name in (*public_files, *keys, *pages):
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        if conversions:
            for name in ("analytics.js", "analytics-schema.mjs"):
                shutil.copyfile(ROOT / name, stage / name)
        if contact_enabled:
            shutil.copyfile(ROOT / "contact.js", stage / "contact.js")
        for page in pages:
            target = stage / page
            language = "en" if page.parts[0] == "en" else "de"
            html = target.read_text(encoding="utf-8")
            if conversions:
                html = html.replace('data-conversion-status="enabled" hidden', 'data-conversion-status="enabled"')
                html = html.replace('data-conversion-status="disabled"', 'data-conversion-status="disabled" hidden')
            if page in (Path("index.html"), Path("en/index.html")):
                if contact_enabled:
                    html = configure_contact(html, language, site_key)
                elif branch and not production:
                    html = disable_preview_contact(html, language)
            target.write_text(add_consent(html, language, token, conversions), encoding="utf-8")
        if DIST.exists():
            shutil.rmtree(DIST)
        stage.rename(DIST)


if __name__ == "__main__":
    build()
