"""Notify IndexNow about URL changes between successful Cloudflare Pages deployments."""

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from http.client import IncompleteRead
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

SITE = "https://eiricha.com"
HOST = urlsplit(SITE).netloc
ENDPOINT = "https://api.indexnow.org/indexnow"
PROJECT = "eirich-it-services"
CHECKPOINT_NAME = "indexnow-cloudflare-production-v1"
CHECKPOINT_FILE = "indexnow-checkpoint.json"
SHA = re.compile(r"[0-9a-f]{40}")
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


@dataclass(frozen=True)
class Deployment:
    id: str
    sha: str
    finished: datetime

    @property
    def order(self):
        return self.finished, self.id

    @classmethod
    def from_dict(cls, values):
        deployment_id, sha, timestamp = (values[key] for key in ("id", "sha", "finished"))
        if not isinstance(deployment_id, str) or str(UUID(deployment_id)) != deployment_id:
            raise ValueError("Invalid Cloudflare deployment ID.")
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ValueError("Invalid Cloudflare deployment ID or commit SHA.")
        return cls(deployment_id, sha, parse_time(timestamp))

    def to_dict(self):
        return {"id": self.id, "sha": self.sha, "finished": self.finished.isoformat()}


def parse_time(value):
    if not isinstance(value, str):
        raise ValueError("Expected a deployment completion timestamp.")
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("Expected a deployment timestamp with a time zone.")
    return timestamp


class Cloudflare:
    def __init__(self, account, token, repository):
        if not re.fullmatch(r"[0-9a-f]{32}", account) or not token:
            raise RuntimeError("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_PAGES_READ_TOKEN in GitHub Actions settings.")
        self.api = f"https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/{PROJECT}"
        self.headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Cache-Control": "no-cache",
        }
        self.repository = repository

    def get(self, path="", **params):
        query = f"?{urlencode(params)}" if params else ""
        _, data = request(self.api + path + query, self.headers)
        payload = json.loads(data)
        if payload.get("success") is not True:
            codes = [str(error.get("code", "unknown")) for error in payload.get("errors", [])]
            raise RuntimeError(f"Cloudflare Pages API rejected {path or 'project'} (codes: {', '.join(codes)}).")
        return payload["result"], payload.get("result_info") or {}

    @staticmethod
    def successful(record):
        if not record or record.get("environment") != "production" or record.get("is_skipped"):
            return None
        stage = record.get("latest_stage") or {}
        metadata = (record.get("deployment_trigger") or {}).get("metadata") or {}
        if (
            record.get("project_name") != PROJECT or metadata.get("branch") != PRODUCTION_BRANCH
            or stage.get("name") != "deploy" or stage.get("status") != "success"
        ):
            return None
        if metadata.get("commit_dirty"):
            raise RuntimeError("Cloudflare reported a successful production upload with uncommitted changes.")
        return Deployment.from_dict({
            "id": record["id"], "sha": metadata["commit_hash"], "finished": stage["ended_on"],
        })

    def current(self):
        project, _ = self.get()
        source = project.get("source") or {}
        config = source.get("config") or {}
        repository = f"{config.get('owner')}/{config.get('repo_name')}"
        if (
            project.get("name") != PROJECT or project.get("production_branch") != PRODUCTION_BRANCH
            or source.get("type") != "github" or repository.casefold() != self.repository.casefold()
        ):
            raise RuntimeError("Cloudflare Pages project does not match this repository and production branch.")
        return self.successful(project.get("canonical_deployment"))

    def verify_domain(self):
        domain, _ = self.get(f"/domains/{HOST}")
        if domain.get("name") != HOST or domain.get("status") != "active":
            raise RuntimeError(f"{HOST} is not active on the expected Cloudflare Pages project.")

    def history(self, current):
        found = {current.id: current}
        page = 1
        page_size = 25
        while True:
            records, info = self.get("/deployments", env="production", page=page, per_page=page_size)
            for record in records:
                deployment = self.successful(record)
                if deployment and deployment.id != current.id and deployment.order < current.order:
                    found[deployment.id] = deployment
            per_page = info.get("per_page") or page_size
            total_pages, total_count = info.get("total_pages"), info.get("total_count")
            last_page = len(records) < per_page
            if total_count is not None:
                last_page = page * per_page >= total_count
            if total_pages is not None:
                last_page = page >= total_pages
            if last_page:
                break
            if not records:
                raise RuntimeError("Cloudflare deployment history ended before its reported last page.")
            page += 1
        return sorted(found.values(), key=lambda item: item.order)


class Checkpoints:
    """Keep the last acknowledged deployment in an Actions artifact on main."""

    def __init__(self, repository, repository_id, token):
        self.repository = repository
        self.repository_id = int(repository_id)
        self.headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}"}

    def get(self, path):
        _, data = request(f"https://api.github.com/repos/{self.repository}/{path}", self.headers)
        return json.loads(data)

    def artifacts(self):
        page = 1
        while True:
            listing = self.get(f"actions/artifacts?name={CHECKPOINT_NAME}&per_page=100&page={page}")
            batch = listing["artifacts"]
            yield from sorted(batch, key=lambda item: (item["created_at"], item["id"]), reverse=True)
            if len(batch) < 100 or page * 100 >= listing["total_count"]:
                return
            page += 1

    def load(self):
        for artifact in self.artifacts():
            run = artifact.get("workflow_run") or {}
            if (
                artifact.get("expired") or run.get("head_branch") != PRODUCTION_BRANCH
                or run.get("head_repository_id") != self.repository_id
                or run.get("repository_id") != self.repository_id
            ):
                continue
            run_id = int(run["id"])
            workflow = self.get(f"actions/runs/{run_id}")
            if workflow["path"].split("@", 1)[0] != ".github/workflows/indexnow.yml":
                continue
            with TemporaryDirectory() as folder:
                subprocess.run(
                    ["gh", "run", "download", str(run_id), "--repo", self.repository,
                     "--name", CHECKPOINT_NAME, "--dir", folder],
                    check=True,
                )
                checkpoint = json.loads((Path(folder) / CHECKPOINT_FILE).read_text(encoding="utf-8"))
            refresh = parse_time(artifact["expires_at"]) - datetime.now(timezone.utc) <= timedelta(hours=12)
            return Deployment.from_dict(checkpoint), refresh
        return None, False

    @staticmethod
    def save(deployment):
        destination = Path(os.environ["RUNNER_TEMP"]) / CHECKPOINT_FILE
        destination.write_text(json.dumps(deployment.to_dict()) + "\n", encoding="utf-8")
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            output.write("checkpoint=true\n")
        print(f"Recorded checkpoint for {deployment.sha} (Cloudflare deployment {deployment.id}).")


def check_sha(event):
    check = event.get("check_run") or {}
    sha = check.get("head_sha") or ""
    if (
        event.get("action") == "completed"
        and (check.get("app") or {}).get("slug") == "cloudflare-workers-and-pages"
        and check.get("name") == "Cloudflare Pages" and check.get("conclusion") == "success"
        and SHA.fullmatch(sha)
    ):
        return sha
    return None


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
    if not SHA.fullmatch(commit):
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
    if any(not url.startswith(f"{SITE}/") or urlsplit(url).netloc != HOST for url in [key_url, *urls]):
        raise ValueError(f"IndexNow accepts only canonical URLs on {SITE}.")
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


def ensure_main_commits(deployments):
    for sha in dict.fromkeys(deployment.sha for deployment in deployments):
        try:
            git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")
        except subprocess.CalledProcessError:
            # GitHub can advance main after checkout while Cloudflare is deploying it.
            git("fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main")
            git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")


def pending_deployments(history, checkpoint):
    if checkpoint is None:
        return history[-2:]
    current = history[-1]
    if checkpoint == current:
        return [current]
    if current.order <= checkpoint.order:  # Cloudflare can restore a previous deployment.
        return [checkpoint, current]
    return [checkpoint, *(item for item in history if item.order > checkpoint.order)]


def deployment_changes(deployments):
    snapshots = {}
    for deployment in deployments:
        if deployment.sha not in snapshots:
            snapshots[deployment.sha] = manifest(deployment.sha)
    sequence = [snapshots[deployment.sha] for deployment in deployments]
    affected = set()
    for before, after in zip(sequence, sequence[1:]):
        for urls in changes(before, after).values():
            affected.update(urls)
    first, last = sequence[0].keys(), sequence[-1].keys()
    return {
        "added": sorted(affected & (last - first)),
        "modified": sorted(affected & first & last),
        "deleted": sorted(affected - last),
    }


def verify_key(sha):
    root = git("ls-tree", "-z", "--name-only", sha).decode("utf-8").split("\0")
    key_files = [name for name in root if KEY_FILE_PATTERN.fullmatch(name)]
    if len(key_files) != 1:
        raise RuntimeError("Expected exactly one root IndexNow key file in the deployed commit.")
    key_file = key_files[0]
    key = key_file.removesuffix(".txt")
    key_content = key.encode("utf-8")
    if git("show", f"{sha}:{key_file}") != key_content:
        raise RuntimeError("The IndexNow key file must contain exactly its filename stem in UTF-8.")
    key_url = f"{SITE}/{key_file}"
    request(key_url, verify_body=key_content)
    print(f"Verified the production IndexNow key at {key_url}.")
    return key, key_url


def reconcile(cloudflare, checkpoints, dry_run, event_sha=None):
    current = cloudflare.current()
    if current is None:
        print("Cloudflare has no confirmed successful canonical production deployment. Skipping.")
        return

    checkpoint, refresh = checkpoints.load()
    if checkpoint == current and not dry_run:
        print(f"Production deployment {current.id} was already processed.")
        if refresh:
            checkpoints.save(current)
        return

    history = cloudflare.history(current)
    if event_sha and not any(deployment.sha == event_sha for deployment in history):
        print("The check SHA is absent from successful production history. Skipping; the scheduled run will reconcile.")
        return

    previous = history[-2] if len(history) > 1 else None
    print(f"Production deployment: {current.sha} (Cloudflare {current.id})")
    if previous:
        print(f"Previous successful production deployment: {previous.sha} (Cloudflare {previous.id})")

    pending = pending_deployments(history, checkpoint)
    if len(pending) == 1 and checkpoint is None:
        print("No previous successful deployment is available. Recording an initial baseline in live mode.")
    elif len(pending) > 1:
        print(f"Comparing from {pending[0].sha} through {len(pending) - 1} production transition(s).")

    ensure_main_commits(pending)
    groups = deployment_changes(pending) if len(pending) > 1 else {}
    for label, urls in groups.items():
        print(f"{label}: {len(urls)}")
        for url in urls:
            print(f"  {url}")
    urls = sorted({url for group in groups.values() for url in group})

    if urls or dry_run:
        cloudflare.verify_domain()
        key, key_url = verify_key(current.sha)

    if dry_run:
        print("Dry run complete. No URLs sent and checkpoint left alone.")
        return

    if cloudflare.current() != current:
        print("Production advanced during reconciliation. Deferring to the next run.")
        return

    if urls:
        submit_urls(key, key_url, urls)
    else:
        print("No affected URLs to submit.")
    checkpoints.save(current)


def main():
    event_name = os.environ["GITHUB_EVENT_NAME"]
    if os.environ.get("GITHUB_REF") != f"refs/heads/{PRODUCTION_BRANCH}":
        raise RuntimeError("IndexNow must run from the production branch.")
    if event_name not in {"check_run", "schedule", "workflow_dispatch"}:
        raise RuntimeError(f"Unsupported trigger: {event_name}.")
    event_sha = None
    if event_name == "check_run":
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
        event_sha = check_sha(event)
        if event_sha is None:
            print("Ignoring a check that is not a successful Cloudflare Pages completion.")
            return

    dry_run = event_name == "workflow_dispatch" and os.environ.get("INDEXNOW_SUBMIT") != "true"
    repository = os.environ["GITHUB_REPOSITORY"]
    cloudflare = Cloudflare(os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""),
                            os.environ.get("CLOUDFLARE_PAGES_READ_TOKEN", ""), repository)
    checkpoints = Checkpoints(repository, os.environ["GITHUB_REPOSITORY_ID"], os.environ["GH_TOKEN"])
    reconcile(cloudflare, checkpoints, dry_run, event_sha)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, ValueError, KeyError, TypeError) as error:
        print(f"IndexNow failed: {error}", file=sys.stderr)
        sys.exit(1)
