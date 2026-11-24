# Eirich IT local SEO and pricing expansion

Both homepages now present nine service cards with a pricing reference, a service link and a contact option. Windows and Mac have separate cards. The compact hero identifies the supported platforms and the free introductory consultation. Arthur’s existing professional information, photograph, opening hours and contact details are used across the site.

## Pages and search intent

The site has 20 canonical pages. The German [homepage](index.html) and the English [homepage](en/index.html) were both updated. The table lists every service page, its status and the customer intent covered. Search intents are editorial targets.

| Change | German route | English route | Local search intent |
|---|---|---|---|
| Updated | [/it-service-zuerich/](it-service-zuerich/index.html) | [/en/it-support-zurich/](en/it-support-zurich/index.html) | PC-Hilfe, Windows-Updates und Notebook-Einrichtung Zürich. On-site and remote Windows support. |
| New | [/mac-hilfe-zuerich/](mac-hilfe-zuerich/index.html) | [/en/mac-apple-support-zurich/](en/mac-apple-support-zurich/index.html) | MacBook-Hilfe, Mac-Umzug, iCloud und Time Machine Zürich. Independent English-speaking Mac setup and troubleshooting. |
| Updated | [/wlan-hilfe-zuerich/](wlan-hilfe-zuerich/index.html) | [/en/wifi-support-zurich/](en/wifi-support-zurich/index.html) | WLAN-Probleme, FRITZ!Box, Router und Mesh Zürich. Wi-Fi dead zones, home-office connectivity and router setup. |
| New | [/handy-hilfe-zuerich/](handy-hilfe-zuerich/index.html) | [/en/smartphone-tablet-support-zurich/](en/smartphone-tablet-support-zurich/index.html) | Handy-Hilfe, iPhone- oder Android-Einrichtung und Datenumzug Zürich. Phone and tablet setup and supported WhatsApp transfers. |
| New | [/datensicherung-zuerich/](datensicherung-zuerich/index.html) | [/en/backup-data-protection-zurich/](en/backup-data-protection-zurich/index.html) | Datensicherung, NAS und Backup einrichten Zürich. Automatic backups, restore tests and restoration from existing backups. |
| New | [/drucker-hilfe-zuerich/](drucker-hilfe-zuerich/index.html) | [/en/printer-scanner-support-zurich/](en/printer-scanner-support-zurich/index.html) | WLAN-Drucker und Scanner einrichten Zürich. Offline printer troubleshooting, AirPrint and scan-to-computer. |
| New | [/computerhilfe-senioren-zuerich/](computerhilfe-senioren-zuerich/index.html) | [/en/computer-help-seniors-zurich/](en/computer-help-seniors-zurich/index.html) | Computerhilfe für Senioren zu Hause in Zürich. Help with devices, email, WhatsApp, video calls and safe browsing for older customers. |
| Updated | [/webseiten-zuerich/](webseiten-zuerich/index.html) | [/en/website-design-zurich/](en/website-design-zurich/index.html) | Webdesign, Firmenwebseite und Landingpage für KMU Zürich. Responsive small-business websites and the scope of a starter one-page site. |
| Updated | [/individualsoftware-zuerich/](individualsoftware-zuerich/index.html) | [/en/custom-software-zurich/](en/custom-software-zurich/index.html) | Individualsoftware, Prozessautomatisierung und API-Entwicklung für KMU Zürich. Java and Spring Boot backends, REST integrations, architecture and MVPs. |

Each service has its own metadata, scope, process, local availability, FAQ and relevant related-service links. The site uses the same three navigation groups in both languages. Breadcrumbs and footer links provide routes back to the correct homepage, FAQ and legal sections. Language links open the matching translation. Phone, WhatsApp and enquiry links are available on the service pages. The form accepts nine service topics, with optional preselection from the service page URL.

## Pricing and calculator

| Customer | Hourly rate | Each 15 minutes |
|---|---:|---:|
| Private | CHF 130 | CHF 32.50 |
| Business | CHF 160 | CHF 40 |

- Remote support starts billing at 15 minutes in 15-minute increments. It has no call-out fee.
- On-site support has a 60-minute minimum, followed by 15-minute increments. A one-time fee per appointment applies using the existing distance bands from Zürich-Oerlikon. Up to 5 km costs CHF 20, over 5 to 10 km costs CHF 25, over 10 to 15 km costs CHF 30, over 15 to 20 km costs CHF 40, and over 20 to 25 km costs CHF 50. Materials and licences are disclosed separately. Parking and other extra charges require prior agreement.
- The 15-minute introductory consultation by phone or WhatsApp is free and non-binding. Technical troubleshooting and remote support are paid work.
- A fixed price must be agreed before work for a defined scope. It covers that scope regardless of time taken. Any out-of-scope work needs prior approval. The same scope is billed once.
- Website projects start at CHF 1'490. Custom software projects start at CHF 2'500. The individual quote sets the scope and deliverables.

The vanilla JavaScript calculator reads the rates, minimums, available durations and travel fees from its HTML controls and calculates in rappen. Both languages show the hourly rate, billable time, labour, travel and CHF total. Remote mode disables and hides the travel selector. The estimate covers hourly support and excludes fixed-price work, development projects and separately agreed expenses. The complete static tariff remains visible without JavaScript.

## Structured data and indexability

The site uses one business identifier, `https://eiricha.com/#business`, with updated hourly rates and existing contact details, hours, address and service-area examples. The homepage FAQ markup matches its visible answers. Every service page has localized `WebPage`, `Service` and `BreadcrumbList` data. Service offer markup describes the applicable hourly rate or project minimum in CHF.

All 20 content URLs have a self-referencing canonical, reciprocal German and English hreflang links, matching sitemap entries and suitable language attributes. Existing public routes, robots.txt, CNAME and legal sections were preserved. The sitemap last-modified values reflect this update.

## Verification

- Nu HTML Checker reported zero errors across all 20 pages. XML, JSON-LD structure, offer amounts, breadcrumbs, canonical and reciprocal hreflang were checked against the rendered pages.
- Chromium and Playwright verified four viewport widths at 320, 390, 768 and 1440 px, all 20 pages, and 43 internal HTTP request targets plus their fragments. Tests covered image loading, grouped navigation, focus and Escape handling, equivalent translations, form topic preselection and JavaScript-disabled access. Both contact forms were exercised with mocked HTTP success and failure responses.
- Axe found zero violations of the audited WCAG 2.0/2.1 A and AA rules at 320 and 1440 px. The grouped menu was separately exercised while open.
- All 11 supplied calculator examples passed in both languages, plus 384 combinations covering both customer types, all selectable durations, both support modes and each travel zone. The static rates and billing rules remain readable with JavaScript disabled.
- Delaying the menu script by one second produced no measured layout shift on the German homepage and English Mac page. Blocking the script left the native navigation usable.

Lighthouse 13.6.0 ran locally in headless Chromium. These are individual local measurements.

| Page and profile | Performance | Accessibility | SEO | LCP | CLS |
|---|---:|---:|---:|---:|---:|
| Previous German homepage, mobile | 100 | 100 | 100 | 0.9 s | 0 |
| Updated German homepage, mobile | 100 | 100 | 100 | 1.1 s | 0 |
| Updated German homepage, desktop | 100 | 100 | 100 | 0.3 s | 0 |
| New English Mac page, mobile | 100 | 100 | 100 | 0.9 s | 0 |

## Limitations and after deployment

- The advertised service area remains approximately 20 km from Zürich-Oerlikon. The existing fee table extends to 25 km. The pricing section asks visitors to confirm availability in the outer zone. The source does not specify whether distance is measured by road or straight line. The calculator uses the chosen zone and leaves that commercial decision with the owner.
- IndexNow is pending on the separate `seo/automatic-indexnow` branch. It was absent from the `main` branch used here. Its detector identified 10 additions and 10 modifications in the local Git comparison. The deployment trigger, public key and submission still require live verification if that branch is approved.
- The production fetch returned HTTP 403 from this environment. Live delivery, external contact destinations and genuine contact-form delivery were outside the local checks.
- After approval and deployment, confirm GitHub Pages succeeded, check a few live German and English service routes and their language/contact links, and inspect the new URLs in Google Search Console and Bing Webmaster Tools. Resubmit `https://eiricha.com/sitemap.xml` and monitor indexing and the queries each service actually receives. If IndexNow is merged, check the public key, run its manual dry run and verify the first successful live submission in Actions.

[Review the complete branch against main](https://github.com/ArthurEirich/ArthurEirich.github.io/compare/main...seo%2Fservice-expansion-pricing-redesign?expand=1).
