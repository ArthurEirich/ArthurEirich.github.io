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
        "Mit deiner Erlaubnis messen wir die Nutzung der Website. Wenn Statistik verfügbar ist, startet sie beim nächsten "
        "Seitenaufruf. Du kannst deine Wahl jederzeit in den Datenschutzeinstellungen ändern.",
        "Dein Browser lehnt Statistik über Global Privacy Control oder Do Not Track ab.",
        "Dein Browser konnte die Auswahl nicht speichern. Auf dieser Seite bleibt die Statistik aus.",
    ),
    "en": (
        "Privacy settings", "Necessary only", "Allow analytics", "Privacy policy",
        "With your permission, we measure how the site is used. When available, analytics starts on your next page load. "
        "You can change your choice at any time in Privacy settings.",
        "Your browser opts out of analytics through Global Privacy Control or Do Not Track.",
        "Your browser could not save the choice. Analytics stays off on this page.",
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


def build():
    production = os.environ.get("CF_PAGES_BRANCH") == "main"
    conversions = production and os.environ.get("CONVERSION_ANALYTICS_ENABLED") == "true"
    token = os.environ.get("WEB_ANALYTICS_BEACON_TOKEN", "") if production else ""
    if token and not re.fullmatch(r"[a-fA-F0-9]{32}", token):
        raise ValueError("Expected a 32-character public Cloudflare Web Analytics beacon token")
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
        for page in pages:
            target = stage / page
            language = "en" if page.parts[0] == "en" else "de"
            html = target.read_text(encoding="utf-8")
            if conversions:
                html = html.replace('data-conversion-status="enabled" hidden', 'data-conversion-status="enabled"')
                html = html.replace('data-conversion-status="disabled"', 'data-conversion-status="disabled" hidden')
            target.write_text(add_consent(html, language, token, conversions), encoding="utf-8")
        if DIST.exists():
            shutil.rmtree(DIST)
        stage.rename(DIST)


if __name__ == "__main__":
    build()
