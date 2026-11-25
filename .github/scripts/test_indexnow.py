"""Local regression tests. External API calls are mocked."""

import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
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
            "foreign.html": '<link rel="canonical" href="https://www.eiricha.com/foreign.html">',
            "preview.html": '<link rel="canonical" href="https://eirich-it-services.pages.dev/preview.html">',
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
        current, previous = deployment(2, after), deployment(1, before)
        cloudflare, checkpoints = MagicMock(), MagicMock()
        cloudflare.current.return_value = current
        cloudflare.history.return_value = [previous, current]
        checkpoints.load.return_value = (None, False)
        self.git("update-ref", "refs/remotes/origin/main", after)
        env = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY": "owner/site",
            "GITHUB_REPOSITORY_ID": "123",
            "GH_TOKEN": "test-token",
            "INDEXNOW_SUBMIT": "false",
        }
        key_url = f"{indexnow.SITE}/{key}.txt"
        with (patch.dict(os.environ, env),
              patch.object(indexnow, "Cloudflare", return_value=cloudflare),
              patch.object(indexnow, "Checkpoints", return_value=checkpoints),
              patch.object(indexnow, "request", return_value=(200, key.encode())) as verify,
              patch.object(indexnow, "submit_urls") as send):
            indexnow.main()
            verify.assert_called_once_with(
                key_url, headers={"User-Agent": "Eirich-IndexNow/1.0"}, verify_body=key.encode()
            )
            send.assert_not_called()
            checkpoints.save.assert_not_called()
            os.environ["INDEXNOW_SUBMIT"] = "true"
            verify.side_effect = RuntimeError("Verification unavailable")
            with self.assertRaisesRegex(RuntimeError, "Verification unavailable"):
                indexnow.main()
            send.assert_not_called()
            checkpoints.save.assert_not_called()


def deployment(number, sha=None):
    return indexnow.Deployment.from_dict({
        "id": f"00000000-0000-0000-0000-{number:012d}",
        "sha": sha or f"{number:040x}",
        "finished": f"2026-11-25T09:00:{number:02d}Z",
    })


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.api = indexnow.Cloudflare("1" * 32, "test-token", "owner/site")

    def record(self, number, *, environment="production", branch="main", status="success", **fields):
        item = deployment(number)
        return {
            "id": item.id,
            "project_name": indexnow.PROJECT,
            "environment": environment,
            "is_skipped": False,
            "deployment_trigger": {"metadata": {"branch": branch, "commit_hash": item.sha}},
            "latest_stage": {"name": "deploy", "status": status, "ended_on": item.finished.isoformat()},
            **fields,
        }

    def test_canonical_production_is_independent_of_latest_deployment(self):
        project = {
            "name": indexnow.PROJECT,
            "production_branch": "main",
            "source": {"type": "github", "config": {"owner": "Owner", "repo_name": "Site"}},
            "canonical_deployment": self.record(3),
            "latest_deployment": self.record(5, environment="preview", branch="branch"),
        }
        with patch.object(self.api, "get", return_value=(project, {})):
            self.assertEqual(self.api.current(), deployment(3))
            project["canonical_deployment"] = self.record(6, status="failure")
            self.assertIsNone(self.api.current())
            project["canonical_deployment"] = self.record(6, environment="preview", branch="main")
            self.assertIsNone(self.api.current())
            project["source"]["config"]["repo_name"] = "different"
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                self.api.current()

    def test_history_is_paginated_deduplicated_and_ordered_by_successful_deploy(self):
        first = [
            self.record(6), self.record(5, status="failure"),
            self.record(4, environment="preview", branch="preview"), self.record(2),
            self.record(7), self.record(3, is_skipped=True),
        ]
        second = [self.record(2), self.record(1), self.record(8, branch="other")]
        with patch.object(self.api, "get", side_effect=[(first, {"total_pages": 2}), (second, {"total_pages": 2})]) as get:
            self.assertEqual(self.api.history(deployment(6)), [deployment(1), deployment(2), deployment(6)])
            self.assertEqual(get.call_args_list, [
                call("/deployments", env="production", page=1, per_page=25),
                call("/deployments", env="production", page=2, per_page=25),
            ])

    def test_domain_requires_canonical_host_active(self):
        with patch.object(self.api, "get", return_value=({"name": "eiricha.com", "status": "pending"}, {})) as get:
            with self.assertRaisesRegex(RuntimeError, "not active"):
                self.api.verify_domain()
            get.assert_called_once_with("/domains/eiricha.com")

    def test_check_trigger_requires_cloudflare_app_and_full_sha(self):
        sha = deployment(1).sha
        check = {"app": {"slug": "cloudflare-workers-and-pages"}, "name": "Cloudflare Pages",
                 "conclusion": "success", "head_sha": sha}
        self.assertEqual(indexnow.check_sha({"action": "completed", "check_run": check}), sha)
        for fields in ({"app": {"slug": "another-app"}}, {"conclusion": "failure"}, {"head_sha": "bad"}):
            with self.subTest(fields=fields):
                self.assertIsNone(indexnow.check_sha({"action": "completed", "check_run": {**check, **fields}}))
        self.assertIsNone(indexnow.check_sha({"action": "rerequested", "check_run": check}))


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.cloudflare = MagicMock()
        self.checkpoints = MagicMock()
        self.first = deployment(1)
        self.second = deployment(2)
        self.current = deployment(3)
        self.cloudflare.current.return_value = self.current
        self.cloudflare.history.return_value = [self.first, self.second, self.current]
        self.checkpoints.load.return_value = (self.first, False)
        mocks = ExitStack()
        self.addCleanup(mocks.close)
        mocks.enter_context(patch.object(indexnow, "ensure_main_commits"))
        self.verify = mocks.enter_context(patch.object(indexnow, "verify_key", return_value=("key", indexnow.SITE + "/key.txt")))
        self.submit = mocks.enter_context(patch.object(indexnow, "submit_urls"))
        self.manifest = mocks.enter_context(patch.object(indexnow, "manifest", side_effect=lambda sha: self.snapshots[sha]))
        self.stable = indexnow.SITE + "/"
        self.transient = indexnow.SITE + "/temporary/"
        self.new = indexnow.SITE + "/new/"
        self.snapshots = {
            self.first.sha: {self.stable: "original"},
            self.second.sha: {self.stable: "changed", self.transient: "added"},
            self.current.sha: {self.stable: "original", self.new: "added"},
        }

    def test_multiple_rapid_deploys_collect_each_transition_and_submit_once(self):
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False, event_sha=self.second.sha)
        self.verify.assert_called_once_with(self.current.sha)
        self.cloudflare.verify_domain.assert_called_once()
        self.submit.assert_called_once_with("key", indexnow.SITE + "/key.txt", sorted([self.stable, self.transient, self.new]))
        self.checkpoints.save.assert_called_once_with(self.current)

    def test_duplicate_event_or_rerun_skips_submission(self):
        self.checkpoints.load.return_value = self.current, False
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False, event_sha=self.current.sha)
        self.cloudflare.history.assert_not_called()
        self.submit.assert_not_called()
        self.checkpoints.save.assert_not_called()

    def test_redeploying_same_commit_updates_checkpoint_without_resending(self):
        current = deployment(4, self.first.sha)
        self.cloudflare.current.return_value = current
        self.cloudflare.history.return_value = [self.first, current]
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False)
        self.verify.assert_not_called()
        self.submit.assert_not_called()
        self.checkpoints.save.assert_called_once_with(current)

    def test_missing_successful_canonical_deployment_skips_all_submission_steps(self):
        self.cloudflare.current.return_value = None
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False)
        self.cloudflare.history.assert_not_called()
        self.checkpoints.load.assert_not_called()
        self.verify.assert_not_called()
        self.submit.assert_not_called()

    def test_preview_check_does_not_submit(self):
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False, event_sha=deployment(4).sha)
        self.verify.assert_not_called()
        self.submit.assert_not_called()
        self.checkpoints.save.assert_not_called()

    def test_advanced_production_is_checked_again_after_key_verification(self):
        self.cloudflare.current.side_effect = [self.current, deployment(4)]
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False)
        self.verify.assert_called_once()
        self.submit.assert_not_called()
        self.checkpoints.save.assert_not_called()

    def test_failed_batch_leaves_checkpoint_for_retry(self):
        self.submit.side_effect = RuntimeError("Network failure")
        with self.assertRaisesRegex(RuntimeError, "Network failure"):
            indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False)
        self.checkpoints.save.assert_not_called()
        self.submit.side_effect = None
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False)
        self.checkpoints.save.assert_called_once_with(self.current)

    def test_first_run_uses_immediately_previous_success_and_skips_missing_baseline(self):
        self.checkpoints.load.return_value = None, False
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False)
        self.assertEqual(self.manifest.call_args_list, [call(self.second.sha), call(self.current.sha)])
        self.submit.reset_mock()
        self.cloudflare.history.return_value = [self.current]
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False)
        self.submit.assert_not_called()

    def test_rollback_compares_to_last_checkpoint_even_if_old_deploy_existed(self):
        self.cloudflare.current.return_value = self.first
        self.cloudflare.history.return_value = [self.first]
        self.checkpoints.load.return_value = self.current, False
        indexnow.reconcile(self.cloudflare, self.checkpoints, dry_run=False)
        self.submit.assert_called_once_with("key", indexnow.SITE + "/key.txt", [self.new])
        self.checkpoints.save.assert_called_once_with(self.first)


class CheckpointTests(unittest.TestCase):
    def test_only_downloads_verified_workflow_artifacts_from_this_repo_main(self):
        checkpoints = indexnow.Checkpoints("owner/site", "123", "test-token")
        item = deployment(1)
        run = {"id": 15, "head_branch": "main", "head_repository_id": 123, "repository_id": 123}
        base = {"created_at": "2026-11-25T09:00:00Z", "expires_at": "2027-02-23T09:00:00Z",
                "workflow_run": run, "expired": False}
        artifacts = [
            {**base, "id": 1},
            {**base, "id": 4, "expired": True},
            {**base, "id": 3, "workflow_run": {**run, "head_repository_id": 42}},
            {**base, "id": 2, "workflow_run": {**run, "id": 16}},
        ]

        def download(command, *, check):
            self.assertIn("15", command)
            Path(command[-1], indexnow.CHECKPOINT_FILE).write_text(json.dumps(item.to_dict()), encoding="utf-8")
        with (patch.object(checkpoints, "get", side_effect=[
            {"artifacts": artifacts}, {"path": ".github/workflows/ci.yml"}, {"path": ".github/workflows/indexnow.yml@main"},
        ]),
              patch.object(indexnow.subprocess, "run", side_effect=download) as run_command):
            self.assertEqual(checkpoints.load()[0], item)
            run_command.assert_called_once()


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

    def test_forbidden_diagnostics_distinguish_public_key_and_submission(self):
        key_url = indexnow.SITE + "/key.txt"
        with patch.object(indexnow.HTTP, "open", side_effect=self.http_error(403)) as send:
            with self.assertRaisesRegex(RuntimeError, "HTTP 403.*Public IndexNow key retrieval was denied"):
                indexnow.request(key_url, verify_body=b"key")
            send.assert_called_once()

        with patch.object(indexnow.HTTP, "open", side_effect=self.http_error(403)) as send:
            with self.assertRaisesRegex(RuntimeError, "HTTP 403.*IndexNow API authorization failed"):
                indexnow.submit_urls("test-key", key_url, [indexnow.SITE + "/"])
            send.assert_called_once()


    def test_rejects_noncanonical_hosts_before_indexnow_post(self):
        for host in ("www.eiricha.com", "eiricha.ch", "eirich-it-services.pages.dev", "preview.example"):
            with self.subTest(host=host), patch.object(indexnow.HTTP, "open") as send:
                with self.assertRaisesRegex(ValueError, "canonical URLs"):
                    indexnow.submit_urls("test-key", indexnow.SITE + "/key.txt", [f"https://{host}/"])
                send.assert_not_called()
