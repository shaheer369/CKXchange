# CKXchange v2.0.0 — Change notes

## Implemented in this source copy

- Added a customer account-deletion flow with current-password verification, typed confirmation, blocking conditions for non-zero available/reserved balances and pending/processing requests, session invalidation, saved-bank removal, pseudonymous retention of financial ledger/transaction records, and an audit event.
- Removed the fixed-rate and data-storage items from Profile & Settings while preserving the app's real rate logic and admin rate configuration.
- Added public Telegram support contact display and administrator-managed support username configuration stored in MongoDB.
- Split the admin workspace into `/admin`, `/admin/deposits`, `/admin/payouts`, `/admin/users`, `/admin/audit`, and `/admin/settings` views.
- Added server-side paginated/searchable admin transaction queues, users, and audit logs (25 records per page by default; page size capped at 100).
- Added one-tap clipboard actions for deposit transaction hashes and payout bank account numbers in the admin interface.
- Added integration-test assertions for the new admin routes, pagination, Telegram support, and account-deletion safeguards.

## Checks performed in this workspace

- `npm test` — passed.
- `npm run check` — passed, including JavaScript syntax checks, UI/security invariants, and Vercel deployment checks.
- The MongoDB HTTP integration suite was **not run here** because this workspace does not have installed runtime dependencies or a disposable MongoDB test connection. Run it only with `MONGODB_TEST_URI` pointing to a disposable Atlas/replica-set test connection. The suite creates and drops its own uniquely named test database. Never point it at your production database.

## Before production use

- Review the changes in your own repository before pushing them to GitHub/Vercel.
- Run the MongoDB integration suite against a disposable test database.
- Manually verify account deletion, the six admin URLs, request pagination/search, support username updates, and the clipboard controls on a staging deployment.
- Do not use CKXchange to handle real money until financial, authorization, session, and reconciliation behavior has been independently reviewed and tested.


# CKXchange v2.3.0 — PWA, support contacts and notification/admin fixes

## Changes in this source copy

- Added an installable PWA manifest, CKX-branded 192px/512px app icons, Apple Home Screen metadata, versioned icon cache paths, and service-worker registration.
- Added network/offline state messaging and a generic offline screen. Cache rules exclude session-aware HTML, API responses, balances, bank data, and payout slips.
- Moved notification history, unread count, mark-read actions, and in-app/browser push controls into a dedicated Notifications page.
- Added optional Web Push using Node's built-in crypto and HTTPS modules (no added npm dependency), VAPID environment variables, browser subscription controls, endpoint-host validation, and a key generator script.
- Deposit-request notifications are written for active admins in the same MongoDB transaction as the pending deposit; payout-success notification is written only for the owner in the same transaction that marks the payout successful. Push delivery is outbox-based, retryable, and uses notification tags to avoid stacking duplicate browser alerts.
- Added customer Telegram/phone contact settings surfaced only through the authenticated profile and administrator-only user API; added amount/last-four detail in notifications and responsive audit hash wrapping with a copy-full-hash action.
- Fixed active admin self-service bank/deposit checks to verify active status without relying on a dummy `activity_seq` write. Integration tests now exercise an admin’s own deposit, bank-link, and payout workflow.
- Payout-success notifications include the INR amount and account last four digits; deposit request notifications include the USDT amount, INR estimate, and abbreviated transaction hash.
- Added an owner-scoped no-cache payout receipt endpoint and full account-number display in the on-screen receipt and PNG export. Ordinary transaction-list responses remain masked.
- Added notification crypto checks to `npm run check`.

## Required Vercel configuration

For browser push, generate a key pair with `node scripts/generate-vapid.js`, then configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in Vercel and redeploy. Do not commit or share the private key. In-app history works without these variables.

## Verification status

- `npm run check` and `npm test` passed in the source workspace, including static UI/security checks and Web Push key/encryption format tests.
- The full MongoDB HTTP integration suite and live delivery to browser push services were **not run** here because there is no disposable MongoDB test URI or live push subscription in this workspace. Those need staging verification before production use.

## Version 2.4.0

- Added a payout review/confirmation modal before submitting and reserving USDT.
- Fixed refresh-time login flash by showing a session-restoration state until authentication is confirmed.
- Extended rolling login-session cookie and MongoDB session TTL to 10 days.
- Simplified transaction history to three columns (Transaction, Amount, Status) without horizontal swipe; date/time now appears under the transaction identifier.
- Added owner-only in-app/Web Push notification when an admin approves a USDT deposit.
- Enforced a minimum USDT deposit of 10 and minimum INR payout of ₹1,000 in both UI and server APIs.

## v2.4.0 — payout, session, and transaction improvements

- Added a pre-submit payout review and explicit confirmation before reserving funds.
- Improved session restoration: temporary network/server failures retry and offer a retry screen instead of falsely presenting a login form. Login and registration now explicitly wait for MongoDB-backed session persistence. Rolling session cookie and store lifetime are 10 days.
- Kept the mobile transaction list to three columns (Transaction, Amount, Status), with abbreviated transaction IDs, view-slip action, and date/time below the transaction reference.
- Added an owner-targeted in-app/Web Push notification when a pending USDT deposit is approved and credited.
- Enforced the USDT 10 minimum deposit and INR 1,000 minimum withdrawal at both frontend and backend.


## v2.4.1 — payout-review and mobile receipt polish

- Fixed mobile transaction history alignment: the View slip action aligns beside the transaction reference, and Successful/Processing status badges stay on one line.
- Added an authenticated, owner-scoped, no-cache endpoint to retrieve a saved full account number only when opening the payout review step; normal bank listings remain masked.
- Removed the Pending/Processing-not-proof disclaimer from the payout slip and review receipt footer. The PNG retains a neutral note identifying the receipt as the current CKXchange status.
- Updated the static asset/service-worker cache version so deployed browsers fetch the refreshed UI.
- Added static and integration assertions for owner-only payout review account details and the updated layout/disclaimer behavior.
