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
ANALYTICS_TAG = '<script type="module" src="/analytics.js" referrerpolicy="no-referrer"></script>'

public_files = (
    "_routes.json", "404.html", "CNAME", "robots.txt", "sitemap.xml", "styles.css",
    "script.js", "assets/arthur-web.jpg", "assets/arthur.jpg", "assets/logo.svg",
    "assets/og-image.jpg",
)


def build():
    enabled = (
        os.environ.get("CF_PAGES_BRANCH") == "main"
        and os.environ.get("CONVERSION_ANALYTICS_ENABLED") == "true"
    )
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
        if enabled:
            for name in ("analytics.js", "analytics-schema.mjs"):
                shutil.copyfile(ROOT / name, stage / name)
            for page in pages:
                target = stage / page
                html = target.read_text(encoding="utf-8")
                if html.count("</body>") != 1:
                    raise ValueError(f"Expected one closing body tag in {page}")
                target.write_text(html.replace("</body>", ANALYTICS_TAG + "\n</body>"), encoding="utf-8")
        if DIST.exists():
            shutil.rmtree(DIST)
        stage.rename(DIST)


if __name__ == "__main__":
    build()
