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
