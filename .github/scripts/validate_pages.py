"""Check that staged Pages files cover the references used by the site."""
from html.parser import HTMLParser
from pathlib import Path
import re
from urllib.parse import unquote, urljoin, urlsplit
from xml.etree import ElementTree

from build_pages import DIST, ORIGIN, ROOT, SITEMAP_NS


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for name in ("src", "href", "poster"):
            if attrs.get(name):
                self.urls.add(attrs[name])
        for entry in attrs.get("srcset", "").split(","):
            if entry.strip():
                self.urls.add(entry.split()[0])
        if attrs.get("property") in {"og:image", "og:url"} or attrs.get("name") == "twitter:image":
            self.urls.add(attrs["content"])


def require(condition, message):
    if not condition:
        raise ValueError(message)


def require_target(base, reference):
    url = urlsplit(urljoin(base, reference))
    if url.scheme not in {"http", "https"} or url.netloc != urlsplit(ORIGIN).netloc:
        return
    target = DIST / unquote(url.path).lstrip("/")
    if target.is_dir():
        target /= "index.html"
    # Pages also serves clean URLs for static .html files.
    require(target.is_file() or target.with_suffix(".html").is_file(), f"{base}: missing {reference}")


def validate():
    sitemap = ElementTree.parse(DIST / "sitemap.xml")
    routes = [node.text for node in sitemap.findall("s:url/s:loc", SITEMAP_NS)]
    require(bool(routes), "The sitemap is empty")
    for url in routes:
        require_target(ORIGIN, url)

    for page in sorted(DIST.rglob("*.html")):
        relative = page.relative_to(DIST).as_posix()
        url = f"{ORIGIN}/{relative.removesuffix('index.html')}"
        refs = References()
        refs.feed(page.read_text(encoding="utf-8"))
        for reference in refs.urls:
            require_target(url, reference)

    for css in DIST.rglob("*.css"):
        url = f"{ORIGIN}/{css.relative_to(DIST).as_posix()}"
        for reference in re.findall(r"""url\(\s*['"]?([^'")]+)""", css.read_text(encoding="utf-8")):
            require_target(url, reference.strip())

    for module in [*DIST.rglob("*.js"), *DIST.rglob("*.mjs")]:
        url = f"{ORIGIN}/{module.relative_to(DIST).as_posix()}"
        for reference in re.findall(r"""\bfrom\s*['"](\.[^'"]+)""", module.read_text(encoding="utf-8")):
            require_target(url, reference)

    for name in ("404.html", "robots.txt", "sitemap.xml", "_routes.json"):
        require((DIST / name).read_bytes() == (ROOT / name).read_bytes(), f"Staged {name} differs from source")
    robots = (DIST / "robots.txt").read_text(encoding="utf-8")
    require(f"Sitemap: {ORIGIN}/sitemap.xml" in robots.splitlines(), "robots.txt must advertise sitemap.xml")
    keys = [file for file in DIST.glob("*.txt") if re.fullmatch(r"[a-f0-9]{32}\.txt", file.name)]
    require(len(keys) == 1, "Expected exactly one staged IndexNow key")
    require(keys[0].read_bytes() == (ROOT / keys[0].name).read_bytes() == keys[0].stem.encode(),
            "IndexNow verification bytes must match the key filename")
    print(f"Validated {len(routes)} sitemap routes, local asset references, 404, robots.txt and IndexNow key.")


if __name__ == "__main__":
    validate()
