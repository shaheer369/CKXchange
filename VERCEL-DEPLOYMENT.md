# Deploy CKXchange to Vercel + MongoDB Atlas

## 1. Upload the project

Push this whole project folder to a **private GitHub repository** (do not include `.env`, database exports, or credentials). In Vercel, import that repository and set the root directory to the folder containing `package.json` and `server.js`. Choose the **Express** framework preset. No separate frontend/backend project is needed.

## 2. Create the Atlas database

Create a MongoDB Atlas cluster, create a dedicated database user with read/write access, and copy the Node.js driver URI. URL-encode special characters in the database username/password. CKXchange uses MongoDB transactions, so use Atlas/a replica set, not a standalone MongoDB server.

For network access, allow the Vercel function's outbound IPs where your plan supports them. If Vercel's outbound IPs are not fixed, Atlas may require a broader IP list. Use `0.0.0.0/0` only if needed, and protect the database with strong unique credentials and least-privilege access.

## 3. Add these Vercel environment variables

Set them under **Project → Settings → Environment Variables**. Never put these values in frontend files or Git.

| Name | Value |
|---|---|
| `MONGODB_URI` | Atlas connection URI |
| `MONGODB_DB` | `ckxchange` |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | Exact origin, e.g. `https://your-project.vercel.app`, no final slash |
| `SESSION_SECRET` | Output of `openssl rand -hex 32` |
| `BANK_ENCRYPTION_KEY` | A *different* output of `openssl rand -hex 32` |
| `MONGODB_MAX_POOL_SIZE` | `5` |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `15000` |
| `INR_PER_USDT` | Initial reference rate, e.g. `106` |

If this is an existing CKXchange database, keep its original `BANK_ENCRYPTION_KEY` exactly: bank account numbers already encrypted with a different key cannot be decrypted. If the admin will configure the receiving address through the Admin panel, `DEPOSIT_ADDRESS_TRC20` may be omitted until then.

## 4. Deploy and provision the first admin

Deploy from Vercel after adding the variables. A normal-user/admin account created on your laptop is **not** automatically created in the production database.

Once you've installed Node.js and linked the local project with Vercel CLI, run:

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

Replace the example email/name and use a new unique password that is 14–128 characters, with letters and numbers. Do not pass a password using `--password`. The temporary `.env.vercel.production` file contains production secrets; keep it private and remove it when finished.

## 5. Check the deployment

Open `https://your-project.vercel.app/api/health`. It should return JSON with `ok: true` and `database: "mongodb"`. Then test registration, login persistence, adding/removing a bank account, admin-only settings, pending deposit verification and payout flows using test records.

## Important

Vercel serves `public/` files from its CDN, so the app's session-aware HTML is now in `views/index.html` and is included in the serverless function via `vercel.json`. Keep frontend assets in `public/`. `server.js` exports the Express app for Vercel and still runs normally with `npm start` locally. Rate-limit buckets and sessions are stored in MongoDB instead of process memory.

This app still performs **manual** deposit verification and payout completion. It does not independently verify blockchain confirmations or initiate real bank transfers. Do not accept real customer funds until appropriate provider integrations, security testing, reconciliation, monitoring, and legal/compliance review are completed.
