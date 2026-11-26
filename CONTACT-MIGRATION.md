# Migrate the contact form to Cloudflare Email Sending

The deployed default continues to use FormSubmit. The first-party endpoint and bilingual form are switched together only in a new production build with `CONTACT_BACKEND_ENABLED=true`. The flag is independent of consent and the conversion-analytics flag. Contact works with analytics rejected. There is no automatic provider fallback or delivery retry.

## What the platform supports

[Cloudflare’s announcement](https://developers.cloudflare.com/changelog/post/2026-11-24-email-sending-workers-free/) and [current pricing](https://developers.cloudflare.com/email-service/platform/pricing/) describe outbound sending on Workers Free to verified destination addresses in the same Cloudflare account. The pricing table lists free, unlimited sends to those addresses, subject to platform throttling and anti-abuse controls. Sending to unverified destinations requires Workers Paid. This migration needs one verified Gmail recipient and sends no automatic replies.

The [Pages Functions binding list](https://developers.cloudflare.com/pages/functions/bindings/) does not list the native `send_email` binding. The [send binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/) and [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) document it for Workers. Native availability in this project's Pages account was not verified. Keep the existing Python Pages build and use the documented [Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) from the Function. There is no `EMAIL` binding to configure for this implementation.

## Prepare manually while leaving FormSubmit active

1. In **Compute → Email Service → Email Sending**, onboard `eiricha.com` for **outbound sending**. Cloudflare requires Cloudflare DNS. In **Email Sending → Settings**, review the exact records Cloudflare proposes before approving any DNS change. The [outbound domain guide](https://developers.cloudflare.com/email-service/configuration/domains/) documents sending-related DKIM and DMARC plus SPF and MX for the separate `cf-bounce.eiricha.com` subdomain. Review any existing DMARC record and preserve the existing root routing and authentication configuration. Do not change the STRATO apex MX records or enable inbound Email Routing. Stop for approval if onboarding proposes any unexpected DNS change.
2. In Email Sending destination addresses, add and verify `arthur.eirich.88@gmail.com` via the confirmation message. Confirm `anfragen@eiricha.com` is an eligible sender under the verified domain. The application fixes From and To to these addresses and has no CC or BCC. A validated submitted email becomes Reply-To. A phone-only enquiry keeps its phone number in the text and has no Reply-To.
3. Create a [Cloudflare API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) with only the Email Sending permission needed by the [Send Email API](https://developers.cloudflare.com/api/resources/email_sending/methods/send/) in the one account. Confirm the current permission label in the dashboard. Use neither a global API key nor additional zone or DNS permissions. REST does not use Workers binding-level restrictions. The account's verified-recipient restriction and the fixed application recipient apply. Restrict who can read or manage the token.
4. Create a **Managed** [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/) for the exact hostname `eiricha.com` with the free plan. The form sets the action to `contact`. The server checks action, hostname and success using [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) before sending. Leave **pre-clearance off** unless independently needed. The widget loads near or on focus of the form and is independent of analytics consent. The local and CI tests mock Turnstile and delivery and do not use production keys.
5. In **Workers & Pages → eirich-it-services → Settings → Variables and Secrets**, prepare the following in **Production only**. Keep the activation flag unset at this stage and leave all of these out of Preview. Cloudflare branch previews show the form with delivery disabled and use neither provider.

| Name | Type | Value and use |
| --- | --- | --- |
| `CONTACT_BACKEND_ENABLED` | Build and runtime variable | Unset initially. Set exactly `true` only for an approved cutover. |
| `TURNSTILE_SITE_KEY` | Public build and runtime variable | The production widget's public site key. It is staged only in the two contact pages. |
| `TURNSTILE_SECRET_KEY` | Runtime secret | Secret paired with the production site key. |
| `CLOUDFLARE_ACCOUNT_ID` | Runtime variable | Account that owns Email Sending. |
| `CLOUDFLARE_EMAIL_API_TOKEN` | Runtime secret | Restricted Email Sending token. |
| `CONTACT_EMAIL_FROM` | Runtime variable | Exactly `anfragen@eiricha.com`. This also guards against activating with an unintended sender. |

Keep the existing `ANALYTICS` binding and analytics settings independent. Do not set `CONVERSION_ANALYTICS_ENABLED` as part of this migration. `/api/contact` returns 404 when disabled or accessed through a preview hostname. A missing public key blocks the enabled build. Incomplete runtime configuration prevents delivery.

## Verification, rollout and rollback

1. Review the bilingual contact disclosures, the Email Service logging settings, and the unresolved items below. Turn off Email preview for this domain if content in Activity Log is unnecessary. Make sure Pages, Workers and external log configuration do not capture request bodies, credentials or the Turnstile token.
2. Before affecting the public form, use the official send procedure with a controlled test message from the proposed From address to the verified Gmail address. This manually authorized production configuration check is separate from preview and CI. Verify the API's message ID and accepted status, Cloudflare Activity Log delivery status, the actual Gmail inbox or spam folder, message authentication (SPF, DKIM, DMARC), and a reply addressed to the controlled Reply-To. Update Gmail filters for `anfragen@eiricha.com` and the German/English subject prefixes. Keep the old FormSubmit filters until migration finishes.
3. For the approved canary, set `CONTACT_BACKEND_ENABLED=true` in Production, redeploy the approved main commit and immediately test both form languages on the canonical host. Confirm service preselection, an actual Turnstile challenge and same-origin POST, and one email for each controlled submission. Test with analytics rejected. Check the actual Gmail inbox, sender, language, topic, body and Reply-To. Include a phone-only test. The UI confirms provider acceptance (delivered or queued), which can precede inbox arrival. Confirm the previous working FormSubmit deployment is available for rollback.
4. With browser Network tools, block the widget script and verify the contact alternatives remain available. Test an expired token and provider failure in the isolated mock setup. Inputs must remain intact, and retrying an ambiguous send is a manual decision. The browser locks the current submission and the single-use Turnstile token blocks replay; a new valid token can represent a new submission. There is no cross-request enquiry store.
5. If cutover fails, unset the flag and redeploy. Verify the FormSubmit endpoint and disclosure are restored. An urgent rollback can use the previous successful Pages deployment; turn off the runtime flag or block the first-party route if necessary until the rollback is live. Never forward a failed first-party submission automatically to FormSubmit.
6. After successful delivery verification and monitoring, remove the legacy FormSubmit form configuration and current-processing text in a separate approved change. Keep an appropriate legacy retention notice while applicable. Revoke any obsolete configuration only after the rollback window closes.

## Abuse and privacy

The existing analytics WAF rule is scoped to `POST /api/analytics` per project documentation. The live rule and account entitlement were not audited here. Do not assume another free WAF rate-limit rule. The contact route uses managed Turnstile, bounded JSON, a honeypot, strict origin checks, single-use tokens and a fixed destination. Monitor contact automation and quotas after activation. If abuse warrants a Cloudflare rule, check available entitlement first. A shared rule that includes both endpoints can share a bucket and affect legitimate traffic, so review the current rule, counters and mitigation behavior before replacing it.

Cloudflare's [Activity Log documentation](https://developers.cloudflare.com/email-service/observability/logs/) confirms delivery and authentication details and says Email preview can expose text, HTML, headers, attachments and raw source for about seven days. New sending domains have preview enabled by default. The dashboard's time-range selector does not establish a guaranteed deletion time for every log. Verify account-specific log retention, access, queue and bounce processing, Cloudflare terms and transfer safeguards, Turnstile processing, Gmail account type and retention. FormSubmit's [documentation](https://formsubmit.co/documentation) describes 30-day submission retention. Its exact locations, terms and transfer safeguards remain to be confirmed.

## Local checks

Run `node --test .github/scripts/test_analytics.mjs .github/scripts/test_consent.mjs .github/scripts/test_contact.mjs` plus the existing IndexNow tests. For an active-shape staging check with no provider access, run:

```bash
CF_PAGES_BRANCH=main CONTACT_BACKEND_ENABLED=true TURNSTILE_SITE_KEY=isolatedMockSiteKey python3 .github/scripts/build_pages.py
python3 .github/scripts/validate_pages.py
```

This dummy build exercises markup only. Do not deploy it.
