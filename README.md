# BlockWorld — Render + managed PostgreSQL

This project is prepared for deployment as a public Node.js web service on Render. It uses a managed PostgreSQL database for account records and login sessions. It does not use `better-sqlite3`, `sqlite3`, native build scripts, or Visual Studio C++ tools.

## Included
- BlockWorld website UI, signup and login
- Editable player profiles with unique usernames, display names, bios, and public username lookup
- Password hashing with bcryptjs (passwords are never stored in plain text)
- PostgreSQL user table with unique, case-insensitive username/email indexes
- PostgreSQL-backed session storage (sessions survive app restarts)
- Rate limits on signup/login routes
- `/healthz` health check for hosting
- `render.yaml` blueprint for the web service

## Deploy online (free-tier availability/limits may change)

You will need a GitHub account for the source repository, a Render account for the web service, and a managed PostgreSQL database such as Neon. Do not put database URLs or secrets into GitHub.

### 1. Create the hosted database
1. Open https://neon.tech/ and create a project.
2. Open the project's **Connect** panel and copy its PostgreSQL connection string (choose the pooled connection string if offered).
3. Keep the connection string private. It contains credentials.

### 2. Put this project in GitHub
1. Extract this ZIP on your computer.
2. On https://github.com/, create a new repository named `blockworld` (a private repository is fine).
3. Open the new repository and choose **Add file → Upload files**.
4. Upload the *contents* of the `blockworld_render` folder (including `render.yaml`, `package.json`, `server.js`, and `public/`). Do not upload `.env` or real secrets.
5. Commit the files to the repository's default branch.

### 3. Deploy the web service on Render
1. Open https://render.com/ and sign in.
2. Choose **New → Blueprint** (or connect the repository as a Web Service if Blueprint is not offered).
3. Select your `blockworld` GitHub repository. Render should read `render.yaml` and create the web service.
4. When asked for `DATABASE_URL`, paste the connection string from Neon into the Render environment variable. Do not paste it into source files.
5. Confirm deployment. Render installs dependencies with `npm install` and starts with `npm start`.
6. Once deployment succeeds, open the `*.onrender.com` URL shown on the service page.

If deploying as a Web Service manually instead of Blueprint, set:
- **Runtime:** Node
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check path:** `/healthz`
- **Environment variables:** `NODE_ENV=production`, `SESSION_SECRET` (a unique random secret of at least 32 characters), and `DATABASE_URL` (the managed PostgreSQL connection string)

### 4. Test the live site
1. Open the Render URL.
2. Create a test account.
3. Refresh the page and confirm the session remains signed in.
4. Log out and log back in.
5. If the deployment logs show a database connection error, verify that `DATABASE_URL` is copied correctly and that the provider allows connections.

## Neon CLI / agent setup (for the configured Neon project)

Run these commands from this project folder on your own computer, where the Neon CLI can open a browser for sign-in:

```sh
npm i -g neon@latest
npx neon skills -y
neon init -y --org-id org-rapid-river-46472846 --project-id summer-hill-40990445 --branch production --services postgres
neon deploy
```

If global installation fails, use `npx neon@latest` in place of `neon`. If sign-in opens a browser, finish the sign-in there. If it times out or fails, run `neon login` and retry. The app already uses the standard `DATABASE_URL` environment variable with `pg` and `connect-pg-simple`; Neon CLI should supply the connection variable in `.env.local` (or `.env` if present). Keep those files private and never commit connection strings.

The CLI setup and deploy commands require network access and authentication to the specified Neon organization/project. They must complete successfully before the database can be verified end to end.

## Run locally (optional)
1. Install Node.js 20 or newer from https://nodejs.org/.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env` and edit `SESSION_SECRET`.
4. With `DATABASE_URL` empty, local testing uses `data/users.json` for accounts and in-memory sessions. This local fallback is for development only.
5. Run `npm start` and open http://localhost:3000.

## Security notes
- Never commit `.env`, database connection strings, or real account data.
- Render production mode requires both `DATABASE_URL` and a strong `SESSION_SECRET`.
- This is a starter project, not a fully hardened identity service. Before a larger public launch, add email verification, password reset, account deletion, monitoring, and a backup/restore plan. The included rate limit is a basic layer, not a complete anti-abuse system.
- Review the current free-tier limits of Render and your database provider; free plans can change, sleep, or have storage/usage limits. A free subdomain is provided by Render; a custom domain usually costs extra.


## Hourly currency rewards
The Currency page lets logged-in players claim a random 100–500 coins once every 60 minutes. The server chooses the reward and enforces the cooldown in PostgreSQL, so refreshing the page or sending repeated requests cannot reset the timer. On startup, the server adds `currency` and `currency_claimed_at` columns to the existing `users` table using safe `ADD COLUMN IF NOT EXISTS` migrations; existing accounts are preserved.


## Hourly reward UI update
The navigation label is now Hourly Reward. A BlockWorld BW coin icon is used for the wallet and a persistent header counter shows the logged-in player's balance.


## Account deletion request emails (Render Free)

Deletion requests are sent through Resend's HTTPS API (not SMTP), which avoids Render Free's outbound SMTP port restrictions. In Render → your web service → Environment, set `OWNER_EMAIL` to the inbox that should receive requests and `RESEND_API_KEY` to your Resend API key. `RESEND_FROM` is optional and defaults to `BlockWorld <onboarding@resend.dev>` for initial testing. Resend's onboarding sender can only deliver to the email address associated with your Resend account; to send to other recipients, verify a domain in Resend and set `RESEND_FROM` to an address on that domain. Remove the old `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` variables after switching. This endpoint sends a request for manual review only; it does not delete accounts.
