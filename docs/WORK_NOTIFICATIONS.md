# Work notifications

Work can notify the member who started a run when it completes, fails, is interrupted, or needs approval. Notifications are opt-in under Cloud Work → Settings. Turning the **Work notifications** switch off stops new alerts and removes this account's displayed browser notifications. Preferences apply to one account and browser, not an entire organization.

The desktop application has its own Work → Settings → General preference. Code's existing notification preference and delivery remain independent.

## Delivery and privacy

- Notifications contain generic status text, never conversation titles, prompts, answers, tool arguments, filenames, or error details.
- Cloud events are committed in the same transaction as the run or approval. Rollbacks do not produce events, and cancellation does not produce failure notifications.
- The feed is restricted to the authenticated organization and initiating member. Project access, Work access, current run status, and pending approval state are rechecked before returning events. Administrators do not receive another member's alerts.
- The browser polls every 15 seconds while Enterprise is open. Returning focus or reconnecting triggers an immediate scan. Background throttling, offline periods, OS Focus settings, and browser permission can delay or suppress display. This is not a Web Push service: closing all Enterprise tabs stops new delivery.
- The feed covers at most the previous 24 hours, starting at opt-in. Paginated scans deliberately revisit that window, so transactions committing out of sequence cannot create a cursor gap. Persistent, atomic IndexedDB receipts prevent duplicate delivery across tabs and reloads. A rejected browser delivery releases its receipt so a later scan can retry. Web Locks avoid duplicate polling when available.
- A conversation visible in a focused browser tab is not notified. Multiple events for one conversation are collapsed to its newest event. Successive events reuse one tray entry and request a new alert with `renotify` on browsers that support it. A notification click opens a fresh, authorized conversation route, preserving drafts in existing tabs. The service worker only handles notification clicks and does not cache application data.
- Clicks never approve or retry actions. An expired sign-in preserves the conversation destination; inaccessible or deleted conversations remain protected by existing authorization.
- Native desktop delivery requires Lori to be running. macOS permission must be enabled from the installed app; an unbundled development binary cannot reliably exercise notification authorization. The desktop keeps durable receipts in SQLite and validates access again on click.

## If notifications do not appear

Settings shows **Off**, **On**, or **Paused**. There are separate permission layers: Work must be enabled for this account/browser, the website must have browser notification permission, and the browser must be allowed to display notifications by the operating system.

Use **Send test** in Work Settings to test delivery without starting an AI run. The message confirms acceptance by the browser, not guaranteed OS presentation. On macOS, inspect System Settings → Notifications → Google Chrome (including its notification component if listed separately), or Lori for native desktop alerts. Do Not Disturb/Focus and screen-sharing notification settings can also suppress banners. The application does not change those global settings.

After enabling notifications, start a new run and switch away. Earlier completed runs are not replayed. Private conversations are tracked directly from the mounted workspace; their IDs need not be present in the URL for foreground suppression to work.

## Deployment

Apply `037_work_notifications.sql` using the normal migration owner, then run the existing runtime-role provisioning step so the API role receives access to the new table and identity sequence. Deploy the API before enabling clients. The migration installs small metadata-only run/approval triggers and does not backfill historical notifications.

Serve the web app over HTTPS (localhost is permitted for development). Ship `public/work-notifications.js` at `/work-notifications.js`; its registration scope is `/work/`. Keep this file reachable without an authentication redirect. No push credentials or third-party notification service are required.

## Qualification

Automated coverage includes notification state selection, per-approval deduplication, SQLite receipts, stale local approval checks, browser permission denial, mute during an in-flight request, account switches, malformed responses, and pagination through revoked items. PostgreSQL integration tests run with a non-owner/non-bypass runtime role and cover initiator isolation, project revocation, maintenance transitions, pending approvals, and rollback behavior.

Before a release, exercise signed/installed desktop builds on macOS, Windows, and Linux; permission denial and later re-enabling; OS Focus modes; click navigation; and supported browsers/mobile installations. Browser tests and a macOS Rust build do not qualify those other operating systems. System notifications are best-effort: a crash between claiming an event and OS display can lose the banner; durable conversation status remains authoritative.

## Research

- [MDN: Using the Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API): permission requires a user gesture and a secure context; service-worker notifications support mobile browsers.
- [MDN: showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification): rejected delivery promises and replacement notification behavior.
- [MDN: notificationclick](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclick_event): persistent notification click handling.
- [MDN: Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API): coordination across same-origin tabs.
- [Apple: handling notifications](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions): foreground presentation and response handling.
- [Tauri notification reference](https://tauri.app/reference/javascript/notification/): platform-specific click limitations. Lori's pinned plugin predates the current desktop action implementation; Work uses a dedicated native adapter without upgrading Code's existing notification path.

### Local verification — 2026-10-24

- Enterprise API suite: 527 tests passed. Restricted-role PostgreSQL project/notification integration suite: 19 passed.
- Enterprise web suite: 902 passed. Desktop Work frontend suite: 1,004 passed.
- Dedicated native notification tests: 5 passed. macOS Cargo check and strict Clippy passed.
- Desktop frontend production build and performance budgets passed. Enterprise contracts/API and Webpack production build passed.
- Chromium verified atomic cross-tab IndexedDB claims, reload deduplication, actual service-worker registration, account-scoped mute propagation, and responsive settings. The system permission/display boundary was mocked because this headless host reports permission denied; this does not establish real OS banner or click behavior.
- Three existing Rust transport/compaction failures reproduced in an untouched checkout: `active_task_compaction_preserves_latest_exchange_and_full_history`, `compaction_preserves_full_history_and_latest_prompt`, and `five_large_reads_complete_and_remain_retrievable`. They were not changed by this feature. The baseline checkout additionally could not execute a sandboxed image-tool test through its temporary runtime symlink.

The feature is implemented and locally verified within these limits. Signed desktop OS delivery, Windows/Linux execution, supported mobile browsers, and hosted deployment remain release qualification gates.

Follow-up verification: all 908 Enterprise web tests passed after adding permission status, the test-notification action, and mounted-conversation visibility tracking. A real Chrome test notification was confirmed visible after the website and macOS app permissions were enabled.

### Enterprise reliability and compact settings review — 2026-10-24

Fixed confirmed browser defects:

- P2: Rejected system-notification calls permanently consumed delivery receipts. Failed delivery now releases the claim for retry; intentional foreground suppression still consumes it.
- P2: Visibility was sampled before asynchronous receipt storage. The delivery path now rechecks focus, permission, mute, and the opt-in baseline immediately before display.
- P2: Reusing a tray tag silently replaced later alerts. Work and test notifications now request `renotify` while preserving one tray entry per conversation.
- P2: Late cleanup from an old scan or mute request could close a newer alert after opt-in changed. Cleanup now matches the specific event and checks the current preference before closing notifications.
- P2: A saved enabled preference could not be switched off when notification APIs became unavailable. Turning it off now works without those APIs.
- P3: Corrupt preference JSON incorrectly reported blocked browser storage. Invalid preference data now falls back to Off and can be overwritten by explicit opt-in.

The notification section uses the existing accessible switch, a short On/Off/Paused status, a compact test action, and expandable delivery/privacy guidance. Paused also covers feed and delivery errors. No new shared styles or dependencies were added.

Current verification: 527 API tests; 19 restricted-role PostgreSQL integration tests; 917 web tests, including 27 notification regressions; full type checking; contracts/API and Webpack production builds. Changed-file ESLint and the UI detector passed. Repository-wide ESLint encounters pre-existing errors in ignored `.local` QA scripts and generated bundles. Chromium separately verified atomic IndexedDB claims, duplicate suppression, failed-delivery claim release/retry, and actual service-worker registration. The actual settings component was rendered in a simulated account fixture at desktop and 360px widths; it had no horizontal overflow.

The first integration attempt and typecheck encountered temporary host disk exhaustion; both passed on retry without deleting unrelated files. This review changes Enterprise only. Prior desktop results above are historical evidence and were not rerun in this review. Hosted deployment and real system banner/click delivery remain release qualification checks. A final signed-in route smoke was unavailable because the local API and web listeners had stopped; the browser checks above used an isolated component fixture.

Follow-up local startup verification: the API, web health route, proxied API readiness, Cloud Work route, and service-worker script returned HTTP 200. The notification migration is applied, and an active isolated worker advertises files, tools, project scopes, and document previews. The browser rendered the sign-in form. Authenticated run delivery and real OS banner/click behavior were not exercised.
