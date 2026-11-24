"""Notify IndexNow about URL changes between successful GitHub Pages deployments."""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from http.client import IncompleteRead
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

SITE = "https://eiricha.com"
HOST = urlsplit(SITE).netloc
ENDPOINT = "https://api.indexnow.org/indexnow"
PAGES_WORKFLOW = "pages build and deployment"
PRODUCTION_BRANCH = "main"
TEMPLATE_DIRS = {"_includes", "_layouts", "_data", "_sass"}
KEY_FILE_PATTERN = re.compile(r"([0-9a-f]{32})\.txt")
MAX_BATCH = 10_000


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = build_opener(NoRedirects())


def request(url, headers=None, data=None, accepted=(200,), verify_body=None):
    """Retry transient responses and allow time for Pages to serve a new key."""
    delays = (5, 10, 20, 40, 60)
    for attempt in range(len(delays) + 1):
        retry_after = None
        try:
            with HTTP.open(Request(url, data=data, headers=headers or {}), timeout=20) as response:
                status = response.status
                body = response.read()
            if status not in accepted:
                raise RuntimeError(f"{url} returned unexpected HTTP {status}.")
            if verify_body is None or body == verify_body:
                return status, body
            problem = "HTTP 200 with verification content that does not match the key file"
        except HTTPError as error:
            status = error.code
            problem = f"HTTP {status}"
            retry_after = error.headers.get("Retry-After")
            error.close()
            retryable = status == 429 or 500 <= status < 600 or (verify_body is not None and status == 404)
            if not retryable:
                hint = {
                    400: "Check the request body and key format.",
                    403: "Check authorization or IndexNow key ownership.",
                    422: "Check that every URL belongs to the verified host.",
                }.get(status, "Check the endpoint and response.")
                raise RuntimeError(f"{url} returned {problem}. {hint}") from error
        except (IncompleteRead, URLError, TimeoutError) as error:
            problem = f"network error: {error}"

        if attempt == len(delays):
            raise RuntimeError(f"{url} still returned {problem} after {attempt + 1} attempts.")
        delay = delays[attempt]
        if retry_after:
            try:
                wait = int(retry_after) if retry_after.isdecimal() else (
                    parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)
                ).total_seconds()
                delay = max(delay, wait)
            except (TypeError, ValueError):
                pass
        if delay > 60:
            raise RuntimeError(f"{url} returned {problem}; Retry-After exceeds 60 seconds. Retry the run later.")
        print(f"{url}: {problem}; retrying in {delay:g}s.")
        time.sleep(delay)


class GitHub:
    def __init__(self, repository, token):
        self.repository = repository
        self.api = f"https://api.github.com/repos/{repository}"
        self.headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def get(self, route, **params):
        query = f"?{urlencode(params)}" if params else ""
        _, body = request(self.api + route + query, self.headers)
        return json.loads(body)

    def pages_run(self, run):
        repository = run.get("head_repository") or {}
        return (
            run.get("name") == PAGES_WORKFLOW
            and run.get("head_branch") == PRODUCTION_BRANCH
            and repository.get("full_name") == self.repository
        )

    def deployment_order(self, run):
        if run.get("conclusion") != "success":
            return None
        jobs = self.get(f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs")["jobs"]
        completed = next((job["completed_at"] for job in jobs
                          if job["name"] == "deploy" and job["conclusion"] == "success"), None)
        return (completed, run["id"], run["run_attempt"]) if completed else None

    def production_pair(self, triggered_run):
        selected = []
        target = None
        if triggered_run:
            target = self.deployment_order(triggered_run) if self.pages_run(triggered_run) else None
            if target is None:
                raise RuntimeError("The triggering workflow did not successfully deploy production Pages.")
            selected.append((target, triggered_run))

        route = (f"/actions/workflows/{triggered_run['workflow_id']}/runs"
                 if triggered_run else "/actions/runs")
        history = []
        for page in range(1, 11):
            runs = self.get(route, branch=PRODUCTION_BRANCH, per_page=100, page=page)["workflow_runs"]
            for run in runs:
                if not self.pages_run(run):
                    continue
                history.append(run)
                # The list endpoint exposes only the latest attempt of each run.
                for attempt in range(1, run["run_attempt"]):
                    history.append(self.get(f"/actions/runs/{run['id']}/attempts/{attempt}"))
            if len(runs) < 100:
                break

        for run in sorted(history, key=lambda item: item["updated_at"], reverse=True):
            # A deploy job cannot finish later than the workflow that ran it.
            if len(selected) == 2 and run["updated_at"] < selected[-1][0][0]:
                break
            if target and (run["id"], run["run_attempt"]) == target[1:]:
                continue
            order = self.deployment_order(run)
            if order is not None and (target is None or order < target):
                selected.append((order, run))
                selected.sort(key=lambda item: item[0], reverse=True)
                del selected[2:]
        if not selected:
            raise RuntimeError("No successful production Pages deployment found.")
        previous = selected[1][1] if len(selected) == 2 else None
        return previous, selected[0][1]


class PageMarkup(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.canonical = None
        self.noindex = False
        self.references = set()
        self.feed(text)

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        rel = (attrs.get("rel") or "").lower().split()
        if tag == "link":
            if "canonical" in rel:
                self.canonical = attrs.get("href")
            elif {"stylesheet", "modulepreload", "icon", "apple-touch-icon"}.intersection(rel):
                self.references.add(attrs.get("href"))
        elif tag in {"script", "img"}:
            self.references.add(attrs.get("src"))
        elif tag == "meta" and (attrs.get("name") or "").lower() == "robots":
            directives = re.split(r"[\s,]+", (attrs.get("content") or "").lower())
            self.noindex |= "noindex" in directives or "none" in directives


def git(*args):
    return subprocess.check_output(["git", *args])


def local_path(url, base):
    parts = urlsplit(urljoin(base, url))
    if parts.scheme == "https" and parts.netloc == HOST:
        return unquote(parts.path).lstrip("/")
    return None


def public_path(path):
    return not any(part.startswith((".", "_")) for part in PurePosixPath(path).parts)


def page_url(path):
    route = path.removesuffix("index.html") if PurePosixPath(path).name == "index.html" else path
    return f"{SITE}/{quote(route, safe='/')}"


def manifest(commit):
    """Map each indexable HTML URL to its source and dependency blob hashes."""
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Invalid deployment commit SHA.")
    entries = {}
    for record in git("ls-tree", "-rz", commit).split(b"\0"):
        if not record:
            continue
        metadata, path = record.split(b"\t", 1)
        mode, kind, digest = metadata.decode().split()
        if kind == "blob" and mode != "120000":
            entries[path.decode("utf-8")] = digest

    template_hashes = {
        path: digest for path, digest in entries.items()
        if path.split("/")[0] in TEMPLATE_DIRS
    }
    result = {}
    for path, digest in entries.items():
        if not path.endswith(".html") or path == "404.html" or not public_path(path):
            continue
        text = git("cat-file", "blob", digest).decode("utf-8-sig")
        url = page_url(path)
        markup = PageMarkup(text)
        templated = bool(re.match(r"^---[ \t]*\r?\n", text))
        if markup.noindex:
            continue
        if markup.canonical and not (templated and "{{" in markup.canonical):
            canonical = urlsplit(urljoin(url, markup.canonical))
            canonical_url = urlunsplit((canonical.scheme, canonical.netloc, canonical.path, canonical.query, ""))
            if canonical_url != url:
                continue
        dependencies = {
            ref_path: entries.get(ref_path)
            for ref in markup.references if ref
            if (ref_path := local_path(ref, url)) is not None
        }
        dependencies["_config.yml"] = entries.get("_config.yml")
        if templated:
            dependencies.update(template_hashes)
        result[url] = (digest, dependencies)
    return result


def changes(before, after):
    return {
        "added": sorted(after.keys() - before.keys()),
        "modified": sorted(url for url in before.keys() & after.keys() if before[url] != after[url]),
        "deleted": sorted(before.keys() - after.keys()),
    }


def submit_urls(key, key_url, urls):
    for start in range(0, len(urls), MAX_BATCH):
        batch = urls[start:start + MAX_BATCH]
        payload = json.dumps({"host": HOST, "key": key, "keyLocation": key_url, "urlList": batch})
        status, _ = request(
            ENDPOINT,
            {"Content-Type": "application/json; charset=utf-8"},
            payload.encode("utf-8"),
            accepted=(200, 202),
        )
        result = "accepted" if status == 200 else "received; key validation pending"
        print(f"IndexNow HTTP {status}: {len(batch)} URL(s) {result}.")


def main():
    event_name = os.environ["GITHUB_EVENT_NAME"]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    api = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    dry_run = event_name == "workflow_dispatch" and os.environ.get("INDEXNOW_SUBMIT") != "true"
    previous, current = api.production_pair(event.get("workflow_run"))
    print(f"Production deployment: {current['head_sha']} ({current['html_url']})")
    groups = {}
    if previous:
        print(f"Previous deployment:   {previous['head_sha']} ({previous['html_url']})")
        groups = changes(manifest(previous["head_sha"]), manifest(current["head_sha"]))
        for label, urls in groups.items():
            print(f"{label}: {len(urls)}")
            for url in urls:
                print(f"  {url}")
    else:
        print("No previous successful deployment is available. Skipping the initial submission.")

    urls = sorted(url for group in groups.values() for url in group)
    if not urls and not dry_run:
        print("No affected URLs to submit.")
        return

    deployed_sha = current["head_sha"]
    root = git("ls-tree", "-z", "--name-only", deployed_sha).decode("utf-8").split("\0")
    key_files = [name for name in root if KEY_FILE_PATTERN.fullmatch(name)]
    if len(key_files) != 1:
        raise RuntimeError("Expected exactly one root IndexNow key file in the deployed commit.")
    key_file = key_files[0]
    key = key_file.removesuffix(".txt")
    key_content = key.encode("utf-8")
    if git("show", f"{deployed_sha}:{key_file}") != key_content:
        raise RuntimeError("The IndexNow key file must contain exactly its filename stem in UTF-8.")
    key_url = f"{SITE}/{key_file}"
    request(key_url, verify_body=key_content)
    print(f"Verified the production IndexNow key at {key_url}.")
    if dry_run:
        print("Dry run complete. No URLs sent to IndexNow.")
    else:
        submit_urls(key, key_url, urls)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"IndexNow failed: {error}", file=sys.stderr)
        sys.exit(1)
