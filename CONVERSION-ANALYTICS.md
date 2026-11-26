# Conversion tracking on Cloudflare Pages

Custom conversion tracking ships disabled. Cloudflare Web Analytics measures site traffic and performance when configured and allowed by the visitor. The custom endpoint has no read operation.

## Migrate Cloudflare Web Analytics to consent-controlled loading

The Pages build remains `python3 .github/scripts/build_pages.py` with output `dist`. Do not deploy consent UI to a domain where Cloudflare still injects a beacon before the visitor's choice. The site code cannot prevent a script injected by Cloudflare outside the build.

1. In the Cloudflare account, open **Analytics & Logs → Web Analytics**, select the existing `eiricha.com` site, and open **Manage Site**. Choose **Enable with JS Snippet installation**. Copy only the public token value from the official snippet's `data-cf-beacon` JSON and confirm it belongs to this site. Do not select **Add a site**, use an API token, or paste the snippet itself into repository HTML.
2. In **Workers & Pages → eirich-it-services → Metrics**, disable the Pages automatic Web Analytics injection. Also verify the existing site remains in manual snippet mode under **Manage Site** and that no zone-level automatic injection is enabled. If dashboard controls are linked, verify the final result in both views. If the existing site cannot be put in manual mode without injection, leave Web Analytics off and omit the token variable until resolved.
3. If Pages still serves a previously injected beacon, redeploy the currently approved production commit with injection off and recheck uncached responses. In a fresh browser, check source HTML and Network on `eiricha.com` and on the Pages preview hostname. There should be no injected `beacon.min.js` and no RUM request. Check both languages. A brief measurement gap is preferable to pre-consent collection.
4. In **Workers & Pages → eirich-it-services → Settings → Variables and Secrets**, add the verified public token as the **Production** plain-text build variable `WEB_ANALYTICS_BEACON_TOKEN`. Leave it unset in Preview. Keep `CONVERSION_ANALYTICS_ENABLED` unset in both environments. Leave the existing Production `ANALYTICS` binding and rate-limit rule as configured. Deploy the approved consent implementation only after step 3 passes. The code stages a public token as configuration and creates the beacon script only for consenting visitors on the canonical origin. With no configured token, Web Analytics stays off.
5. Verify the rollout with the browser checks below. If pre-consent requests appear, check the Pages and zone injection settings again. Remove the public token and redeploy to stop the manual integration while diagnosing. Keep automatic injection off when rolling back.

Cloudflare describes the [manual and Pages setup](https://developers.cloudflare.com/web-analytics/get-started/), [manual beacon behavior](https://developers.cloudflare.com/web-analytics/faq/) and [dataset retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/#data-retention). Manual Web Analytics reports to `https://cloudflareinsights.com/cdn-cgi/rum`. If a Content Security Policy is added, the script source is `https://static.cloudflareinsights.com` and its RUM destination must be allowed separately.

## Consent and later conversion activation

The bilingual controls appear on all 20 canonical pages. The footer settings control reopens the same non-modal panel. A decision stores only preference, policy version, configured analytics product scope and date in origin-local browser storage. Policy version or product-scope changes require a fresh decision. A rejected, unavailable or outdated choice cannot grant consent. Global Privacy Control and Do Not Track override stored consent. After a fresh grant, enabled conversions can attribute the current landing page and record new actions. Earlier clicks and submissions are never replayed. Cloudflare Web Analytics waits until the next page load to avoid measuring the earlier navigation.

Withdrawal disables custom sends immediately and reloads pages where the Web Analytics beacon was loaded. The beacon does not provide a supported teardown. An in-flight or unload request may still complete during withdrawal, and previous data is unaffected. Other open tabs on the same origin react to storage changes. A browser may require a new page load to apply a changed GPC or DNT setting to an already initialized third-party beacon. If storage becomes unwritable during withdrawal and even removing the saved decision fails, the reload uses a temporary necessary-only URL marker and retries saving the rejection. If the browser still cannot persist the change, clear this site's browser data before re-enabling storage.

After separate approval, set `CONVERSION_ANALYTICS_ENABLED=true` as a **Production-only** Pages build and Functions runtime variable and redeploy `main`. The independent conversion gate still requires prior consent and the canonical origin. Preview builds omit both products' configuration. The endpoint's Origin check and activation gate protect the write route; a forged client can still send valid-looking requests. A client-only consent decision is not server authentication.

## Privacy items to confirm before rollout

- Verify which Cloudflare contract terms cover Pages, Web Analytics and Analytics Engine for this account, including the [Cloudflare DPA](https://www.cloudflare.com/cloudflare-customer-dpa/), product-specific processing locations, the applicable transfer mechanism and operational retention settings. The DPA describes safeguards including standard contractual clauses where applicable. The public terms alone do not confirm how this account is configured.
- Confirm whether the Gmail inbox is consumer Gmail or a Google Workspace account and which terms and transfer safeguards apply to it. Confirm FormSubmit's contracting entity, subprocessors, locations, retention, deletion and transfer terms. The [Google privacy policy](https://policies.google.com/privacy) and [FormSubmit site](https://formsubmit.co/) describe the services but do not establish account-specific arrangements.
- Confirm the controller details, applicable legal bases and retention periods for communication and infrastructure logs. Review the policy against the [Swiss FADP](https://www.fedlex.admin.ch/eli/cc/2022/491/en) and the [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj) where applicable.

The staging script copies the sitemap routes, shared static files, custom 404 page and current IndexNow verification file explicitly. Add any future static assets to the staging list and update the canonical route allowlist when routes change. The only Functions invocation routes are `/api/analytics` and `/api/contact`.

## Collection and limits

The browser sends a fixed event over same-origin HTTPS using a non-blocking keepalive request with credentials omitted and referrer suppressed. Analytics respects browser Global Privacy Control and Do Not Track. The browser holds attribution in memory for the current document. Navigation can lose attribution, including a service-page link to the contact form. No cross-page attribution or identifier is created. Known external referrers map to source labels. Other external referrers map to `other_referral`. Duplicate query parameters and unknown UTM values are ignored. The service ID comes from the canonical service page or, for form outcomes, the selected preset option at submission time. The existing `?service=…#kontakt` links can preselect the topic. Choosing another topic overrides that preselection. The catch-all or empty option leaves the service blank. Contact details and free-text values never enter the analytics payload.

The directory allowlist matches exact apex and `www` hosts for Cylex Switzerland (`cylex-swiss.ch`), Goregio (`goregio.ch`), Infosenior (`infosenior.ch`), Zürich.im (the business listing uses `zuerich.im` and `www.zuerich.im`; the IDN hosts `xn--zrich-kva.im` and `www.xn--zrich-kva.im` remain supported), Firmen.ch, Stadtbranchenbuch (`stadtbranchenbuch.ch`) and Expat.com. Before activation, compare these hosts with the public business listing URLs and follow each listing link in a browser. A directory may redirect through another host or suppress the referrer. Where a listing permits tagged links, an allowlisted `utm_source` can supply attribution without relying on its referrer.

Use the source allowlist in `analytics-schema.mjs`. Recognized media are `organic`, `referral`, `directory`, `social`, `maps`, `email` and `cpc`. Campaigns start with `zurich_it_support`, `local_directories` and `senior_it_help`. These are proposed tracking labels. Confirm campaign naming before launch and add reviewed labels to the shared allowlist. Keep personal information out of all UTM tags, including tags ignored by this feature, because URLs may reach infrastructure logs.

The endpoint validates the exact HTTPS origin, JSON content type, maximum 512-byte body and allowlisted fields. It allows one write per request and caps attempted writes at 120 per minute per isolate. The browser caps events at 20 per document. The isolate cap resets on isolate replacement and is neither an account-wide quota nor a substitute for edge rate limits. Origin and Fetch Metadata checks discourage browser cross-site submissions. Automated clients can forge those headers and submit valid-looking events. A burst can crowd out legitimate events, and delivery can also be lost when the browser closes or the network fails. Treat the counts as estimates.

### Cloudflare edge rate limit

In the `eiricha.com` zone, add a WAF rate-limiting rule with this match expression:

```text
(http.host eq "eiricha.com" and http.request.uri.path eq "/api/analytics" and http.request.method eq "POST")
```

Start with **30 requests per 10 seconds per IP**, action **Block**, and a **10-second mitigation timeout** where the plan offers those controls. This leaves room for the browser's 20-event document limit. Use a block response, preferably HTTP 429 if configurable, since an analytics fetch cannot solve an interactive challenge. Review Security Events and adjust for shared-IP false positives and observed bursts. The edge uses IP for enforcement in Cloudflare infrastructure. The application dataset still contains no IP. Per-IP limits do not prevent distributed traffic or enforce a global quota.

Clicks measure contact intent. Form success means FormSubmit confirmed the submission. It does not confirm inbox delivery, a qualified lead, or a sale. Form errors and campaign landings provide context for the conversion counts.

## Dataset schema and retention

| Column | Value |
| --- | --- |
| `timestamp` | UTC ingestion time generated by Analytics Engine |
| `index1` | Constant `site` sampling index, never a visitor identifier |
| `blob1` | Event type |
| `blob2` | Canonical site path |
| `blob3` | Language, `de` or `en` |
| `blob4` | Allowed source or referral category |
| `blob5` | Allowed medium |
| `blob6` | Allowed campaign |
| `blob7` | Preset service ID, or empty when unassigned |

Empty attribution values are stored as empty strings. Cloudflare documents three months of [Analytics Engine retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/#data-retention). The application does not record IP addresses, User-Agent, contact or form data, full URLs, arbitrary query strings, or identifiers. Review infrastructure logging separately. Access reports through authorized Cloudflare tooling and use existing approved access.

## SQL reports

The queries cover the last 30 days and weight every count by `_sample_interval` to account for Analytics Engine sampling. The conversion breakdowns include contact clicks and confirmed form submissions. The event breakdown also surfaces diagnostics.

```sql
-- Conversions by UTC day
SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS events
FROM eirich_conversions
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob1 IN ('phone_click', 'email_click', 'whatsapp_click', 'contact_form_success')
GROUP BY day ORDER BY day;

-- Events by type
SELECT blob1 AS event_type, SUM(_sample_interval) AS events
FROM eirich_conversions
WHERE timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY event_type ORDER BY events DESC;

-- Conversions by service page, excluding the homepages
SELECT blob2 AS page_path, SUM(_sample_interval) AS events
FROM eirich_conversions
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob1 IN ('phone_click', 'email_click', 'whatsapp_click', 'contact_form_success')
  AND blob2 NOT IN ('/', '/en/')
GROUP BY page_path ORDER BY events DESC;

-- Conversions by service, across languages and including homepage form outcomes
SELECT blob7 AS service, SUM(_sample_interval) AS events
FROM eirich_conversions
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob1 IN ('phone_click', 'email_click', 'whatsapp_click', 'contact_form_success')
  AND blob7 != ''
GROUP BY service ORDER BY events DESC;

-- Conversions by language
SELECT blob3 AS language, SUM(_sample_interval) AS events
FROM eirich_conversions
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob1 IN ('phone_click', 'email_click', 'whatsapp_click', 'contact_form_success')
GROUP BY language ORDER BY events DESC;

-- Conversions by traffic source, including unattributed rows (empty source)
SELECT blob4 AS source, SUM(_sample_interval) AS events
FROM eirich_conversions
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob1 IN ('phone_click', 'email_click', 'whatsapp_click', 'contact_form_success')
GROUP BY source ORDER BY events DESC;

-- Conversions by recognized UTM campaign
SELECT blob6 AS campaign, SUM(_sample_interval) AS events
FROM eirich_conversions
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob1 IN ('phone_click', 'email_click', 'whatsapp_click', 'contact_form_success')
  AND blob6 != ''
GROUP BY campaign ORDER BY events DESC;

-- Daily contact form outcomes
SELECT toStartOfDay(timestamp) AS day, blob1 AS outcome, blob7 AS service, SUM(_sample_interval) AS events
FROM eirich_conversions
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob1 IN ('contact_form_success', 'contact_form_error')
GROUP BY day, outcome, service ORDER BY day, outcome, service;
```

## Verification and rollback

### Before activation

- With Node.js 24 and Python 3.10 or newer, run `node --test .github/scripts/test_analytics.mjs .github/scripts/test_consent.mjs` and `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .github/scripts -v`. Run `python3 .github/scripts/build_pages.py` and `python3 .github/scripts/validate_pages.py`. Pull-request CI validates both disabled and enabled build output.
- In the temporary preview and the initial disabled production deployment, check both languages, the calculator, menu and contact links. Confirm the HTML contains no custom analytics loader and a POST to `/api/analytics` produces no dataset row. Check CSS, JavaScript, images, sitemap, robots and the IndexNow key. Confirm an unknown route returns the custom page with HTTP 404 and repository tests or configuration outside the public allowlist return 404. Check canonical redirects and confirm there is no automatic Web Analytics injection. Record baseline mobile and desktop PageSpeed Insights results for the homepages and a representative service page.

### After the Web Analytics migration, with conversions still disabled

1. In a fresh browser with DevTools Network open, visit a German and an English page. Before making a choice, there should be no request for `beacon.min.js`, `/cdn-cgi/rum` or `/api/analytics`. Choose **Necessary only** and navigate across languages. Repeat the network check.
2. Reopen **Privacy settings** in the footer and choose **Allow analytics**. With conversions disabled, the current page still makes no analytics request. Navigate to another page. Expect one Web Analytics script initialization and a RUM request. Verify data arrives in the existing Web Analytics site. The custom module and endpoint should still be unused.
3. Withdraw via **Necessary only** and verify a reload leaves subsequent pages silent. Test a second open tab, GPC, DNT and a preview URL. Check for duplicates in the browser and verify the baseline PageSpeed measurements. Submit a controlled enquiry and verify actual Gmail delivery independently of the choice.

### After separate approval and activation of custom conversions

1. In a browser with prior analytics consent and GPC and DNT off, open DevTools Network and enable **Preserve log**. Visit `https://eiricha.com/en/wifi-support-zurich/?utm_source=google&utm_medium=organic&utm_campaign=zurich_it_support`. Verify `/analytics.js` and `/analytics-schema.mjs` return HTTP 200 with a JavaScript MIME type such as `text/javascript` or `application/javascript`, and check for module errors in the console.
2. Expect one `utm_landing` POST to the same-origin `/api/analytics` with a 204 response and `service: "wifi"`. Check Request Headers for the canonical Origin and absence of Cookie and Referer. Inspect the JSON for exactly the seven documented event fields. Do not copy personal data or form request bodies into logs or screenshots. Click one actual contact link and check that it produces one matching click event while normal navigation proceeds.
3. Follow the Wi-Fi service link to the form. Verify the topic is preselected, then switch to a different preset service and submit with a controlled test inbox and an identifiable test message. In Network, inspect the real FormSubmit response and verify HTTP success with JSON `success: true` or `success: "true"`. Confirm the enquiry email arrives in the site's configured recipient inbox. Check for a single `contact_form_success` posted after FormSubmit responds and verify its `service` reflects the selected preset. Block the FormSubmit request in DevTools and verify the form shows its error state and posts `contact_form_error`.
4. Repeat in a browser with GPC or DNT enabled and confirm it sends zero custom analytics POSTs. Confirm Cloudflare Web Analytics remains present.
5. Using authorized Analytics Engine tooling, verify ingestion against the test time, page and service. The endpoint's 204 acknowledges the write call and does not by itself prove the row is queryable. Use this query alongside the weighted reports above:

   ```sql
   SELECT timestamp, blob1 AS event_type, blob2 AS page_path, blob3 AS language,
          blob4 AS source, blob5 AS medium, blob6 AS campaign, blob7 AS service, _sample_interval
   FROM eirich_conversions
   WHERE timestamp >= NOW() - INTERVAL '1' HOUR
     AND index1 = 'site'
   ORDER BY timestamp DESC
   LIMIT 50;
   ```

6. Rerun PageSpeed Insights on the same URLs for mobile and desktop and compare against the baseline. Check Lighthouse diagnostics for new JavaScript or network regressions if scores or metrics move.

To stop collection, unset the Production activation variable and redeploy. Verify the conversion module is no longer staged and valid POSTs return 404. For an urgent stop before redeployment completes, block `/api/analytics` at the edge if available. Existing rows age out under Analytics Engine retention. To roll back application changes, redeploy a known-good build or revert the commit and coordinate the build settings if the restored version predates the staging script.
