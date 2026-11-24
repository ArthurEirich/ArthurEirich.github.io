# ArthurEirich.github.io

## IndexNow

GitHub Pages publishes `eiricha.com` from `main`. The [IndexNow workflow](.github/workflows/indexnow.yml) runs after GitHub’s built-in **pages build and deployment** workflow completes on that branch. It confirms the `deploy` job succeeded and looks up the preceding successful deployment in the same repository. It compares the Git trees of those deployed commits. It skips submission if there is no previous deployment to compare or if the comparison yields no affected pages. Failed and skipped deployments are excluded.

The comparison uses public HTML routes in Git. For example, `en/index.html` represents `https://eiricha.com/en/`. It includes added pages, changed pages and old URLs for deleted or moved pages. It excludes hidden files, the root `404.html`, `noindex` pages and HTML aliases that declare a different canonical URL. A sitemap-only or documentation change does not affect the comparison. Changed local stylesheets, scripts, icons and images are attributed to the HTML pages that reference them directly. Changes in Jekyll’s shared template directories affect front-matter HTML pages. If `_config.yml` changes, the workflow treats every public page as affected because that configuration can change rendering or routes. When adding a different build system or introducing generated routes, review the URL and dependency mapping in the script.

Before any submission, the workflow fetches the public UTF-8 key file and checks its exact contents. It sends unique affected URLs to `https://api.indexnow.org/indexnow` in batches of up to 10,000. HTTP 200 means accepted and 202 means received with key validation pending. The workflow retries temporary network failures, 429, and server errors, respecting short `Retry-After` values. It also waits for a newly deployed key file to appear. The log shows the deployment SHAs, affected URLs by category and each submission result.

### Verify after merging

1. Wait for **pages build and deployment** on `main` to finish and check that its `deploy` job succeeded.
2. Confirm the production key URL returns HTTP 200 and exactly the key as UTF-8. From the repository root, run:

   ```bash
   key_file=753d1a3e095f1afdcd67af896cefed6b.txt
   curl --fail --silent --show-error "https://eiricha.com/$key_file" | cmp "$key_file" -
   ```

3. In **Actions → IndexNow → Run workflow**, select `main` and leave **Send the latest production delta** off. The dry run shows the deployment pair and URL list, and verifies the public key even when the list is empty. The merge that adds this integration alone should have no affected URLs.
4. After a subsequent content deployment, check the automatic IndexNow run for the expected URL list and HTTP 200 or 202. For manual recovery, rerun the failed IndexNow run for that deployment. Turning on **Send the latest production delta** submits the latest successful deployment’s changes again if they were already accepted.
5. Check IndexNow reports in Bing Webmaster Tools. Continue using the existing sitemap in Google Search Console, since Google Search does not consume IndexNow notifications.

The verification key is public by design. To rotate it, replace the root verification file with one new 32-character hexadecimal key followed by `.txt`. The file must contain only the key, without a byte-order mark or a trailing newline. Publish it through the existing Pages deployment.

### Local checks

With Git and Python 3.10 or newer:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .github/scripts -v
```

The tests use temporary Git history and mocked network responses.
