# ArthurEirich.github.io

## IndexNow on Cloudflare Pages

Cloudflare Pages publishes `https://eiricha.com` from the `main` branch of this repository using the `eirich-it-services` project.

The [IndexNow workflow](.github/workflows/indexnow.yml) wakes up when the `cloudflare-workers-and-pages` GitHub App completes a successful **Cloudflare Pages** check. A check run can belong to a preview. The script independently confirms that the check SHA appears in successful Cloudflare production history. A twice-hourly scheduled run reconciles production if GitHub suppresses or delays the check event, or the API has not recorded the deployment by the time the check arrives. `workflow_dispatch` on `main` defaults to a dry run.

Cloudflare’s project API establishes the canonical production deployment, the GitHub source repository, and the production branch. The script requires a successful `deploy` stage and full commit SHA, verifies that the commit belongs to `main`, and reads the paginated production history to find the preceding success. It verifies the `eiricha.com` custom domain is active and serves the exact UTF-8 IndexNow key. Before sending, it checks that the canonical production deployment is still the one used for the comparison.

### GitHub Actions configuration

Add these under **Settings → Secrets and variables → Actions**:

| Kind | Name | Value / scope |
| --- | --- | --- |
| Repository variable | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID for `eirich-it-services`. |
| Repository secret | `CLOUDFLARE_PAGES_READ_TOKEN` | A custom API token with **Account → Cloudflare Pages → Read** (shown as **Pages Read** in the API permission list), restricted to that account. The script uses project, deployment-list and custom-domain GET endpoints. |

The built-in `GITHUB_TOKEN` uses `contents: read` for the Git history and `actions: read` to find and download its checkpoint artifact. The hosted runner’s GitHub CLI handles the artifact download. This setup uses no Cloudflare deployment hooks, write permissions or additional service. [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

### What is sent

The comparison uses public HTML routes in Git. For example, `en/index.html` represents `https://eiricha.com/en/`. It includes added pages, changed pages and old URLs for deleted or moved pages. It excludes hidden files, the root `404.html`, `noindex` pages and HTML aliases that declare a different canonical URL. A sitemap-only or documentation change does not affect the comparison. Changed local stylesheets, scripts, icons and images are attributed to the HTML pages that reference them directly. The existing template dependency rules remain in place.

When there is no checkpoint, the workflow compares the latest two confirmed production deployments. If only one is available, it establishes a baseline with no submission. Subsequently, the workflow uses its most recent checkpoint and combines URL changes across successful production transitions, including temporary pages removed before the latest release. A rollback is compared with the last checkpoint. Failed, skipped and preview builds are excluded. Only `https://eiricha.com/` URLs enter the payload.

A serialized job saves a checkpoint as an Actions artifact after every successful reconciliation, including when there is nothing to send. An acknowledged deployment is skipped on duplicate checks and reruns. The artifact follows the repository’s retention policy and is refreshed near expiry while scheduled runs are active. If all checkpoints expire or are deleted, the next run falls back to the latest pair. An interruption between IndexNow accepting a batch and the checkpoint being saved can replay that batch on retry.

The script sends unique URLs to `https://api.indexnow.org/indexnow` in batches of up to 10,000. HTTP 200 means accepted and 202 means received with key validation pending. Temporary network failures, HTTP 429 and server errors are retried. The workflow also allows time for the public key to become available. It logs deployment IDs and SHAs, affected URLs by category and each submission result.

### Verify after merging

1. In Cloudflare Pages, confirm the project uses `main` and `eiricha.com` is active under **Custom domains**.
2. Confirm the canonical key URL returns HTTP 200 and exactly the key as UTF-8. From the repository root, run:

   ```bash
   key_file=753d1a3e095f1afdcd67af896cefed6b.txt
   curl --fail --silent --show-error "https://eiricha.com/$key_file" | cmp "$key_file" -
   ```

3. In **Actions → IndexNow → Run workflow**, select `main` and leave **Send the pending production delta** off. The dry run reports the production deployment and delta, and checks the domain and key even when the list is empty. It does not submit or update the checkpoint.
4. After a content deployment, open the commit’s Cloudflare Pages check and confirm the SHA in the IndexNow log. Look for IndexNow HTTP 200 or 202. If an event is missed or a run fails temporarily, the next scheduled run reconciles production. You can also run the workflow manually with **Send the pending production delta** enabled.
5. Check IndexNow reports in Bing Webmaster Tools. Continue using the existing sitemap in Google Search Console.

The verification key is public by design. To rotate it, replace the root verification file with one new 32-character hexadecimal key followed by `.txt`. The file must contain only the key, without a byte-order mark or a trailing newline.

### Local checks

With Git and Python 3.10 or newer:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .github/scripts -v
```

The tests use temporary Git history and mock external API responses.
