"""Local regression tests. All GitHub and IndexNow requests are mocked."""

import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, call, patch
from urllib.error import HTTPError

import indexnow


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.original_dir = Path.cwd()
        git_dir = tempfile.TemporaryDirectory()
        self.addCleanup(git_dir.cleanup)
        os.chdir(git_dir.name)
        self.addCleanup(os.chdir, self.original_dir)
        self.git("init", "--quiet")

    def git(self, *args):
        return subprocess.check_output(["git", *args]).decode().strip()

    def commit(self, files):
        for name, content in files.items():
            path = Path(name)
            if content is None:
                path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
        self.git("add", ".")
        self.git("-c", "user.name=IndexNow test", "-c", "user.email=test@example.invalid",
                 "commit", "--quiet", "-m", "test snapshot")
        return self.git("rev-parse", "HEAD")

    def test_public_pages_and_shared_dependencies(self):
        before = self.commit({
            "index.html": '<link rel="canonical" href="/"><link rel="stylesheet" href="/styles.css">',
            "en/index.html": '<link rel="stylesheet" href="../styles.css"><script src="/script.js?v=2"></script>',
            "unchanged/index.html": "No shared assets here",
            "gone/index.html": "Goodbye",
            "old-name.html": "Moved page",
            "alias.html": '<link rel="canonical" href="/">',
            "private.html": '<meta name="robots" content="noindex, follow">',
            "404.html": "Error",
            "_includes/navigation.html": "Old navigation",
            "templated/index.html": '---\nlayout: default\n---\n<link rel="canonical" href="{{ page.url }}">',
            "styles.css": "body { color: blue }",
            "script.js": "console.log('before')",
        })
        after = self.commit({
            "index.html": '<link rel="canonical" href="/"><link rel="stylesheet" href="/styles.css"><h1>Home</h1>',
            "styles.css": "body { color: green }",
            "_includes/navigation.html": "New navigation",
            "gone/index.html": None,
            "old-name.html": None,
            "new-name.html": "Moved page",
            "neu über/index.html": "New page",
            "README.md": "Documentation does not change the public HTML.",
        })
        self.assertEqual(indexnow.changes(indexnow.manifest(before), indexnow.manifest(after)), {
            "added": [indexnow.SITE + "/neu%20%C3%BCber/", indexnow.SITE + "/new-name.html"],
            "modified": [indexnow.SITE + "/", indexnow.SITE + "/en/", indexnow.SITE + "/templated/"],
            "deleted": [indexnow.SITE + "/gone/", indexnow.SITE + "/old-name.html"],
        })
        js_only = self.commit({"script.js": "console.log('after')"})
        self.assertEqual(indexnow.changes(indexnow.manifest(after), indexnow.manifest(js_only)), {
            "added": [], "modified": [indexnow.SITE + "/en/"], "deleted": [],
        })

    def test_new_workflow_and_verification_key_do_not_change_pages(self):
        before = self.commit({"index.html": "Home", "en/index.html": "English home"})
        after = self.commit({
            ".github/workflows/indexnow.yml": "name: IndexNow",
            "0123456789abcdef0123456789abcdef.txt": "0123456789abcdef0123456789abcdef",
        })
        self.assertEqual(indexnow.changes(indexnow.manifest(before), indexnow.manifest(after)), {
            "added": [], "modified": [], "deleted": [],
        })

    def test_manual_dry_run_and_failed_verification_never_send(self):
        key = "0123456789abcdef0123456789abcdef"
        before = self.commit({"index.html": "Old home"})
        after = self.commit({"index.html": "New home", f"{key}.txt": key})
        event = Path("event.json")
        event.write_text("{}", encoding="utf-8")
        deployments = [{"head_sha": sha, "html_url": "https://github.com/owner/site/actions"}
                       for sha in (before, after)]
        env = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_EVENT_PATH": str(event),
            "GITHUB_REPOSITORY": "owner/site",
            "GH_TOKEN": "test-token",
            "INDEXNOW_SUBMIT": "false",
        }
        key_url = f"{indexnow.SITE}/{key}.txt"
        with (patch.dict(os.environ, env),
              patch.object(indexnow.GitHub, "production_pair", return_value=deployments),
              patch.object(indexnow, "request", return_value=(200, key.encode())) as verify,
              patch.object(indexnow, "submit_urls") as send):
            indexnow.main()
            verify.assert_called_once_with(key_url, verify_body=key.encode())
            send.assert_not_called()
            os.environ["INDEXNOW_SUBMIT"] = "true"
            verify.side_effect = RuntimeError("Verification unavailable")
            with self.assertRaisesRegex(RuntimeError, "Verification unavailable"):
                indexnow.main()
            send.assert_not_called()


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.api = indexnow.GitHub("owner/site", "test-token")

    def run_record(self, number, **fields):
        return {
            "id": number,
            "run_attempt": 1,
            "workflow_id": 42,
            "name": "pages build and deployment",
            "conclusion": "success",
            "head_branch": "main",
            "head_repository": {"full_name": "owner/site"},
            "updated_at": f"2026-11-24T00:00:{number:02d}Z",
            **fields,
        }

    def test_manual_and_automatic_use_real_successful_deployments(self):
        # Its report job finished late, but the deploy itself still came first.
        first = self.run_record(1, updated_at="2026-11-24T00:00:12Z")
        current = self.run_record(2)
        skipped = self.run_record(3)
        later = self.run_record(4)
        foreign = self.run_record(5, head_repository={"full_name": "fork/site"})
        unrelated = self.run_record(6, name="CI")
        failed = self.run_record(7, conclusion="failure")

        def rest(route, **params):
            if route.endswith("/runs"):
                return {"workflow_runs": [later, failed, unrelated, foreign, current, first, skipped]}
            run_id = int(route.split("/")[3])
            return {"jobs": [{
                "name": "deploy",
                "conclusion": "skipped" if run_id == 3 else "success",
                "completed_at": f"2026-11-24T00:00:{run_id:02d}Z",
            }]}

        with patch.object(self.api, "get", side_effect=rest):
            self.assertEqual(self.api.production_pair(current), (first, current))
            self.assertEqual(self.api.production_pair(None), (current, later))
            with self.assertRaisesRegex(RuntimeError, "did not successfully deploy"):
                self.api.production_pair(skipped)
            with self.assertRaisesRegex(RuntimeError, "did not successfully deploy"):
                self.api.production_pair(failed)

    def test_rerun_uses_previous_successful_attempt(self):
        first = self.run_record(1)
        rerun = self.run_record(1, run_attempt=2, updated_at="2026-11-24T00:00:02Z")
        failed = {**rerun, "conclusion": "failure"}

        def rest(route, **params):
            if route.endswith("/runs"):
                return {"workflow_runs": [rerun]}
            if route.endswith("/jobs"):
                attempt = int(route.split("/")[5])
                return {"jobs": [{"name": "deploy", "conclusion": "success",
                                  "completed_at": f"2026-11-24T00:00:{attempt:02d}Z"}]}
            self.assertTrue(route.endswith("/attempts/1"))
            return first

        with patch.object(self.api, "get", side_effect=rest):
            self.assertEqual(self.api.production_pair(rerun), (first, rerun))
        with patch.object(self.api, "get", side_effect=lambda route, **params: (
            {"workflow_runs": [failed]} if route.endswith("/runs") else rest(route, **params)
        )):
            self.assertEqual(self.api.production_pair(None), (None, first))


class HTTPTests(unittest.TestCase):
    def response(self, status, body=b""):
        resource = MagicMock()
        resource.status = status
        resource.read.return_value = body
        resource.__enter__.return_value = resource
        return resource

    def http_error(self, status, headers=None):
        return HTTPError(indexnow.ENDPOINT, status, "test error", headers or {}, io.BytesIO())

    def test_verification_waits_for_exact_production_key(self):
        opener = [self.http_error(404), self.response(200, b"wrong"), self.response(200, b"key")]
        with patch.object(indexnow.HTTP, "open", side_effect=opener), patch.object(indexnow.time, "sleep") as sleep:
            self.assertEqual(indexnow.request(indexnow.SITE + "/key.txt", verify_body=b"key"), (200, b"key"))
            self.assertEqual(sleep.call_args_list, [call(5), call(10)])

    def test_post_retries_transient_errors_and_accepts_202(self):
        responses = [self.http_error(429, {"Retry-After": "7"}), self.http_error(503), self.response(202)]
        with patch.object(indexnow.HTTP, "open", side_effect=responses) as send, patch.object(indexnow.time, "sleep") as sleep:
            indexnow.submit_urls("test-key", indexnow.SITE + "/key.txt", [indexnow.SITE + "/deleted/"])
            submitted = send.call_args.args[0]
            self.assertEqual(submitted.get_method(), "POST")
            self.assertEqual(submitted.full_url, indexnow.ENDPOINT)
            self.assertEqual(json.loads(submitted.data), {
                "host": indexnow.HOST, "key": "test-key", "keyLocation": indexnow.SITE + "/key.txt",
                "urlList": [indexnow.SITE + "/deleted/"],
            })
            self.assertEqual(sleep.call_args_list, [call(7), call(10)])

    def test_permanent_errors_are_not_retried(self):
        for status in (301, 400, 403, 422):
            with self.subTest(status=status):
                with patch.object(indexnow.HTTP, "open", side_effect=self.http_error(status)) as send:
                    with self.assertRaisesRegex(RuntimeError, f"HTTP {status}"):
                        indexnow.submit_urls("test-key", indexnow.SITE + "/key.txt", [indexnow.SITE + "/"])
                    send.assert_called_once()
