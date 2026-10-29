# CKXchange 2.0 — MongoDB backend

CKXchange is a responsive USDT-to-INR workflow app with user accounts, bank-account management, PNG payout receipts, and a role-protected administrator panel. **MongoDB is now the only active application database**: the app uses MongoDB collections for users, banks, transactions, the ledger, settings, audit records, and login sessions. SQLite is not a runtime dependency.

> Deposits are still manually verified, and bank payouts are still completed through an external authorized bank/provider. This app does not automatically verify blockchain confirmations or send real bank transfers. Do not accept real funds until the appropriate provider integrations, compliance review, security hardening, and reconciliation are complete.

## Requirements

- Node.js 22 or newer (Node.js 24 is suitable).
- A MongoDB deployment that supports transactions. **MongoDB Atlas is recommended** because deposit approvals and payout balance changes use multi-document transactions. A standalone local MongoDB server without replica-set mode will not support these transaction flows.
- Python 3 with its standard-library `sqlite3` module only if migrating an existing SQLite database.

## 1. Create the MongoDB database

1. Create a MongoDB Atlas project and cluster: <https://www.mongodb.com/atlas>.
2. In **Database Access**, create a dedicated database user with read/write access to the CKXchange database. This is separate from your Atlas website login.
3. In **Network Access**, allow connections from your hosting server or current development IP. Avoid leaving broad network access open unnecessarily.
4. Choose **Connect → Drivers → Node.js** and copy the connection string. URL-encode special characters in the database username/password if necessary.
5. Set the app database name to `ckxchange` with `MONGODB_DB=ckxchange` (or choose another name).

MongoDB connection documentation: <https://www.mongodb.com/docs/drivers/node/current/connect/connection-targets/>.

## 2. Configure `.env`

In the project folder, first check whether `.env` already exists:

```bash
ls -la .env .env.example
```

If this is a new install and `.env` does not exist, copy the template. If `.env` already exists from the SQLite version, **do not overwrite it**—open that existing file and add `MONGODB_URI` and `MONGODB_DB`, preserving the original `BANK_ENCRYPTION_KEY` and `SESSION_SECRET`. Generate secrets only for a genuinely new install.

```bash
# Run only if .env does not already exist:
cp .env.example .env

# Generate values only when you need to create new secrets:
openssl rand -hex 32
openssl rand -hex 32
nano .env
```

Set the following values:

```env
MONGODB_URI=mongodb+srv://DB_USER:URL_ENCODED_PASSWORD@YOUR_CLUSTER_HOST/?retryWrites=true&w=majority&appName=CKXchange
MONGODB_DB=ckxchange
NODE_ENV=development
PORT=3000
APP_ORIGIN=http://localhost:3000
SESSION_SECRET=PASTE_FIRST_RANDOM_VALUE_HERE
BANK_ENCRYPTION_KEY=PASTE_SECOND_RANDOM_VALUE_HERE
INR_PER_USDT=106
DEPOSIT_ADDRESS_TRC20=
```

Replace the sample connection string and both secret placeholders. `SESSION_SECRET` must be at least 32 characters. `BANK_ENCRYPTION_KEY` must be exactly 64 hexadecimal characters.

**Keep the existing `BANK_ENCRYPTION_KEY` if you are importing an old CKXchange SQLite database.** It is required to decrypt bank account numbers encrypted by the previous version. If you generate a new key, migrated bank account ciphertext will not be readable.

Never share `.env`, commit it to Git, paste secrets into chat, or place database connection credentials in frontend JavaScript.

## 3. Install and run

```bash
npm install
npm run check
npm test
npm start
```

Open <http://localhost:3000>. To open the administrator page, go to <http://localhost:3000/admin> after an administrator has been provisioned and signed in.

The server checks the MongoDB connection and creates required indexes before it starts accepting requests. A database connection failure should stop startup rather than silently fall back to local files.

## 4. Create or reset the administrator account

Set a new, unique password securely through a hidden terminal prompt:

```bash
read -s -p "Enter a new admin password: " ADMIN_PASS
printf '\n'
ADMIN_PASSWORD="$ADMIN_PASS" npm run create-admin -- --email admin@example.com --name 'CKXCHANGE ADMIN'
unset ADMIN_PASS
```

Replace the example email and name. The password must be 14–128 characters and contain at least one letter and one number. Do not pass a password as `--password ...`; command-line arguments can leak into shell history, process listings, or npm logs.

By default, this tool creates or updates the specified admin, demotes other accounts currently marked as administrators to ordinary users, and invalidates sessions for the target/demoted accounts. Pass `--keep-existing-admins` only if you intentionally want multiple administrators. This is a separate administrative tool; normal registration always creates a `user` role.

## 5. Database layout

MongoDB collections used by CKXchange:

| Collection | Contents |
|---|---|
| `users` | User identity, password hash, role, status and available/reserved USDT balances |
| `banks` | Bank details with AES-256-GCM-encrypted account number, account fingerprint and last four digits |
| `transactions` | Deposit/payout requests, amount values, statuses, TRC20 hash/address snapshots, and bank/provider references |
| `ledger` | Append-style records of deposit credits, payout reservations, completed payouts and released reservations |
| `app_settings` | Admin-configured INR-per-USDT reference rate and TRC20 receiving address |
| `audit_log` | Administrative actions and timestamps |
| `sessions` | Server-side Express login sessions, automatically expired by TTL index |

The server creates indexes for email uniqueness, duplicate TRC20 transaction-hash protection, one ledger entry per transaction/action, and common user/admin queries. Money values are stored as integer paise and integer micro-USDT to avoid using floating-point numbers as the balance source of truth.

Deposit approvals and payout reserve/complete/reject flows use MongoDB transactions. Use Atlas or another MongoDB replica set; do not switch the app to a standalone database without transaction support.

## 6. Optional: migrate existing SQLite data to MongoDB

You can preserve existing users, banks, transactions, balances, ledger records, admin settings and audit history. **Do not run this migration into a MongoDB database that already contains CKXchange records.** Choose an empty database name, and import before starting the app or creating the admin account in that target database.

1. Stop the old CKXchange server and back up the SQLite file and `.env` securely.
2. Update the existing `.env` with the new MongoDB connection string and target database name. **Do not run `cp .env.example .env` over your existing file:** preserve its original `BANK_ENCRYPTION_KEY` so encrypted bank-account numbers remain readable. Keep the current `SESSION_SECRET` if you prefer, though old sessions will not be imported.
3. Export from the old SQLite database (the export includes password hashes and encrypted bank information, so keep it private):

   ```bash
   python3 scripts/export-sqlite.py --input data/ckxchange.sqlite --output data/sqlite-export.json
   ```

   If your database file is in a different location, adjust `--input`.
4. Install the MongoDB driver dependencies:

   ```bash
   npm install
   ```
5. Import into the **empty** target MongoDB database:

   ```bash
   node scripts/import-sqlite-export.js data/sqlite-export.json
   ```

6. Verify record counts and log in, then securely remove the sensitive export file:

   ```bash
   rm -f data/sqlite-export.json
   ```

   Keep a separate encrypted backup according to your own retention policy.

The exporter deliberately does not migrate login sessions; everyone must sign in again. The original SQLite database is not modified or deleted. The importer refuses to import over existing business records and uses a MongoDB transaction so a failed import does not leave a partially migrated database.

For a brand-new database instead, skip this migration and create your admin account with the command in section 4.

## 7. Tests

`npm test` runs local unit checks without connecting to your live database. The UI/source check also runs through `npm run check`.

For full HTTP integration tests, create/use a **separate disposable MongoDB replica-set/Atlas database** and set `MONGODB_TEST_URI` in the environment to a connection string permitted to create/drop databases. Then run:

```bash
MONGODB_TEST_URI='mongodb+srv://TEST_USER:URL_ENCODED_PASSWORD@TEST_CLUSTER_HOST/?retryWrites=true&w=majority' npm run test:integration
```

The integration suite chooses a unique test database and attempts to drop only that database at completion. Never point `MONGODB_TEST_URI` at your production database. It exercises registration/role isolation, admin sessions, TRC20 address/rate settings, duplicate transaction hashes, one-time deposit credits, payout reservations and terminal states.

## 8. Deploy CKXchange to Vercel + MongoDB Atlas

This version is prepared to run as one Express application on Vercel. Vercel serves files under `public/` from its CDN; the HTML template lives in `views/index.html` so `/` and `/admin` go through Express and the session-aware HTML response. MongoDB stores application data, sessions, and shared rate-limit counters. The Vercel Functions and region settings are in `vercel.json`.

### A. Prepare MongoDB Atlas

1. Create a MongoDB Atlas cluster in a region close to Mumbai (for example, an India region if available to your cluster plan).
2. Create a dedicated database user with a strong, unique password and read/write access to the CKXchange database.
3. In Network Access, allow the outbound IPs used by your Vercel deployment. If your Vercel plan cannot provide fixed outbound IPs, Atlas may require broader network access; only use `0.0.0.0/0` when necessary, and then protect it with strong database credentials, TLS, least-privilege access, and regular credential rotation.
4. Copy the Node.js driver connection string. URL-encode special characters in the database username/password.
5. Keep the database on Atlas or another replica set, because deposit approvals and payout balance changes use MongoDB transactions.

### B. Put the code in GitHub and import it into Vercel

1. Upload/push this project directory to a private GitHub repository. Do not commit `.env`, database exports, real bank data, or credentials.
2. In Vercel, choose **Add New → Project**, import that repository, and set the **Root Directory** to the folder containing this `package.json` and `server.js`.
3. Use the **Express** framework preset. The app has no separate frontend/backend deployment: the same Express app serves the dynamic HTML and API, while `public/app.js` is delivered as a static asset.
4. Add the environment variables from the next section in Vercel Project Settings → Environment Variables. Add them to **Production** and to Preview only if you intend to use a separate/test database there.
5. Deploy. Vercel installs the dependencies from `package.json`; no separate build command is required for this project.

### C. Required Vercel environment variables

Set these in Vercel's environment settings, not in client-side JavaScript:

| Variable | Value |
|---|---|
| `MONGODB_URI` | Your Atlas connection URI |
| `MONGODB_DB` | `ckxchange` |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | Exact public origin, e.g. `https://your-project.vercel.app` (no trailing slash) |
| `SESSION_SECRET` | New random secret, at least 32 characters |
| `BANK_ENCRYPTION_KEY` | 64-character hexadecimal key |
| `MONGODB_MAX_POOL_SIZE` | `5` |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `15000` |
| `INR_PER_USDT` | Initial rate, e.g. `106` |

Generate secrets on your own computer with `openssl rand -hex 32` (run it separately for each secret). For an existing CKXchange database with encrypted bank account numbers, preserve the exact original `BANK_ENCRYPTION_KEY`; changing it makes previously encrypted account numbers undecryptable. If the admin configures the receiving address through the Admin panel, `DEPOSIT_ADDRESS_TRC20` can be left unset. Never paste secret values into chat or commit them to Git.

### D. Create the first admin on the deployed database

Creating an admin on your laptop does not create one in the cloud database. After the first deployment is linked with the Vercel CLI, pull the **Production** variables into a private local file and run the provisioning script against that database:

```bash
npx vercel login
npx vercel link
npx vercel env pull .env.vercel.production --environment=production
read -s -p "New admin password: " ADMIN_PASS
printf '\n'
DOTENV_CONFIG_PATH=.env.vercel.production ADMIN_PASSWORD="$ADMIN_PASS" node -r dotenv/config scripts/create-admin.js --email admin@example.com --name 'CKXCHANGE ADMIN'
unset ADMIN_PASS
rm -f .env.vercel.production
```

Replace the example email and name. Use a new password of 14–128 characters containing letters and numbers; do not pass the password as a command-line argument. The script connects to MongoDB using the pulled production URI. Keep the file private and remove it after use. The project `.gitignore` also excludes `.env.*` files.

### E. Verify the deployment

1. Open `https://your-project.vercel.app/api/health`; it should return JSON with `"ok": true` and `"database": "mongodb"`.
2. Open the homepage, register a normal user, sign in, and verify that refresh does not log you out.
3. Open `/admin` while signed out or as a normal user; admin-only controls should not be accessible. Test admin APIs as a normal user and confirm they return `403`.
4. Sign in as the provisioned admin, configure the TRC20 receiving address and INR/USDT rate, then test deposits and payouts with small test records before using any live funds.
5. Watch Vercel Function logs and Atlas metrics. The persistent rate-limiter uses a `rate_limits` collection and TTL index created by the app.

### Important deployment limits and operational notes

- Vercel Functions are request-driven, not a permanently running server. This app does not depend on an always-on worker; long-running blockchain watching and bank transfer integrations should use provider webhooks or a separate worker/queue.
- The Express app is deployed as a single Vercel Function. The private HTML template is included via `vercel.json`; static assets must stay under `public/`.
- Vercel rate limits and function timeouts vary by plan. This project sets a 30-second function maximum; tune it only if your Vercel plan supports the value.
- Protect Atlas with a separate application database user, least privilege, backups, and a tested restore process. Keep the bank-encryption key backed up separately from the database.
- Configure a verified TRC20 receiving address before enabling deposits. The app does not independently confirm on-chain ownership, token contract, amount or blockchain confirmations.
- Before accepting real customer funds, complete security testing, admin MFA, monitoring, support/dispute processes, provider integration, chain verification, bank-payout integration, reconciliation, and appropriate legal/compliance review. Manual approval in the current app is not a substitute for a real payments provider.

## Important behavior

- Only USDT on TRON (TRC20) is accepted by the deposit form and backend.
- Deposit requests stay Pending until manual admin verification. The app does not itself confirm blockchain transactions.
- Payout requests reserve available USDT atomically. Admin approval moves the payout to Processing; it should be marked Successful only after the bank/provider confirms the real transfer and a reference is recorded.
- The INR/USDT rate is a configured reference value, not an automatic market quote. The admin can change it in the Admin panel. Existing transactions keep their recorded amounts.
- The frontend and backend are served from the same Express origin. Admin API routes are centrally role-protected; browser-side changes do not grant admin permissions.

## PWA and notifications (v2.3.0)

CKXchange can be installed on supported phones and desktop browsers. The service worker caches only versioned/static assets, icons, the manifest, and a generic offline page. It does **not** cache the personalized HTML shell, login/session responses, balances, bank details, payout slips, or `/api` responses. Offline mode is informational only; all financial actions still require a live server connection.

### Configure browser push (optional)

1. Generate a VAPID key pair in your project folder:

   ```bash
   node scripts/generate-vapid.js
   ```

2. In Vercel → Project → **Settings → Environment Variables**, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`. Use the generated public/private key values, and replace the subject example with a contact mailbox you control, for example `mailto:support@your-domain.example`. Apply them to Production (and Preview only if you need push there), then redeploy.
3. Keep `VAPID_PRIVATE_KEY` server-side and secret. Do not paste it into HTML, frontend JavaScript, GitHub issues, or chat. Generate one production key pair and keep it stable; rotating it causes existing browser subscriptions to stop working until users enable push again.
4. Sign in to CKXchange, open the notification bell or the dedicated Notifications page, then choose **Enable browser push** and grant permission. Each admin who needs deposit-request push alerts must enable it in their own admin session. Users may enable push to receive their own successful-payout alert.

If the VAPID variables are absent or invalid, in-app history and unread counts continue to work, while the UI explains that browser push is not configured. Web Push support varies by browser/device; iOS/iPadOS requires a supported version and a Home Screen installation. Notification payloads include the transaction amount and the payout bank account’s last four digits as requested. They do not include the full account number; lock-screen previews may still reveal the amount and last four digits, so turn off OS lock-screen notification previews if that is not suitable for your device.

### Notification recipients

- A newly submitted USDT deposit creates a notification for each active administrator only; the message includes the USDT amount, INR estimate, and an abbreviated transaction hash.
- A payout-success notification is created for the owner of that specific payout only, inside the same database transaction as the successful status change; it includes the INR amount, USDT equivalent, and bank account last four digits.
- Notification history/read endpoints filter by the signed-in recipient. Push subscriptions are associated with the current MongoDB user and their server-verified role. Duplicate database events use deterministic IDs, and push display tags prevent duplicate alerts from stacking.

The full account number on a payout slip is returned by a dedicated no-cache endpoint only after confirming that the payout belongs to the signed-in account. PNG slips now include the full number as requested; downloaded slips can contain sensitive bank details, so share them carefully.

## v2.4.0 behavior changes

- Payouts require a review confirmation before submission; the server reserves USDT only after confirmation.
- Active rolling sessions last up to 10 days. A user with an already-issued 8-hour cookie may need to sign in once after deploying this update.
- Minimum deposit is 10 USDT and minimum payout is ₹1,000; both are enforced in frontend and backend.
- Deposit approval creates a deduplicated notification for the active deposit owner after balance credit is committed.
- Customer transaction history has three columns: Transaction, Amount, Status; date/time and a payout slip link appear under the transaction ID, avoiding horizontal scrolling.


## v2.4.1 visual and payout-review fixes

- Mobile transaction history keeps status badges on one line and aligns the View slip action with the transaction ID.
- Payout review now displays the complete saved account number through a dedicated owner-scoped, no-cache endpoint. Bulk bank listings remain masked; the new endpoint returns only the selected account number.
- Removed the Pending/Processing-not-proof disclaimer from the payout slip. v2.4.1 still included a separate neutral status note; that note is removed in v2.4.2.


## v2.4.2 receipt and audit-log improvements

- Downloaded payout slips no longer include the CKXchange heading at the top or the CKXchange status sentence at the bottom.
- The admin audit log now records the customer payout request in the same transaction as the payout reservation, shows a readable action name and actor, and joins the linked payout to display the requester, INR amount, reserved USDT, destination bank/holder/branch, masked account number, IFSC, current status, and bank reference where available.
- Audit searches can match the payout requester, bank, branch, IFSC, or account last four. Full account numbers are not copied into permanent audit details; the destination is identified with the masked account number and bank coordinates.
- Versioned PWA assets were bumped to v2.4.2 to refresh cached JavaScript.
- Fresh npm installs pin the transitive `body-parser` dependency to the patched 2.4.x line through an npm override.


## v2.4.3 — compact payout audit and receipt alignment

- Simplified payout audit rows to show the action, admin/requester identity and email, date/time, full PAY transaction reference, destination account number, account holder name, amount, and a View slip action.
- Added an admin-only, no-cache payout receipt endpoint so authorized administrators can open the same slip modal and download the receipt from audit history.
- Audit rows retrieve destination account numbers from the linked payout record at read time; full numbers are not written into permanent audit details.
- Corrected downloaded PNG receipt alignment by centering the status icon, title, subtitle, and payout amount on the canvas.
- Bumped PWA asset/cache version to 2.4.3.


## v2.4.4 — payout cap, MAX amount, account search and bank-form polish

- Removed duplicate literal plus signs from the Add bank buttons while keeping the SVG plus icon.
- Updated IFSC help copy to explain automatic bank/branch lookup without naming a provider.
- Added admin payout-queue search by exact full account number or last four digits.
- Added a MAX button that fills the payout amount with the smaller of the available INR value and the ₹100,000 per-request cap; rounding ensures the amount does not overrun available micro-USDT.
- Enforced the ₹100,000 maximum in the server payout endpoint as well as the client form.
- Bumped PWA asset cache/version strings so installed apps fetch the updated UI.
