# Deployment — rocky-api on AWS EC2

This guide records how the production server for rocky-api was set up (issue #6) and how to
redeploy it. It satisfies C-06 (EC2 behind Nginx, managed by PM2) and NFR-OPS-01 (automatic
restart on crash and on reboot).

The files in the repository are the source of truth for the commands below. If this guide and
one of these files disagree, the file wins and this guide should be updated:

| File                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `ecosystem.config.cjs`  | PM2 process definition (one fork-mode instance, ADR-012)      |
| `deploy/nginx/rocky.conf` | Nginx site: `/api/` → `127.0.0.1:4000`, placeholder for `/` |
| `deploy/redeploy.sh`    | Pull, install, build, migrate, reload, health check           |
| `.env.example`          | Every environment variable the API reads                      |

**Not covered yet:** HTTPS (domain, TLS certificate, HTTP→HTTPS redirect, HSTS) is issue #15,
and the frontend (rocky-web) is deployed in a later issue. Until then Nginx serves plain HTTP
and `/` returns a "coming soon" placeholder.

## Contents

1. [Target architecture](#1-target-architecture)
2. [Launch the EC2 instance](#2-launch-the-ec2-instance)
3. [Allocate an Elastic IP](#3-allocate-an-elastic-ip)
4. [Connect from Windows](#4-connect-from-windows)
5. [Base system and swap](#5-base-system-and-swap)
6. [Node.js 26](#6-nodejs-26)
7. [PostgreSQL 18](#7-postgresql-18)
8. [Nginx and PM2](#8-nginx-and-pm2)
9. [Firebase service account](#9-firebase-service-account)
10. [Clone the repository](#10-clone-the-repository)
11. [Production `.env`](#11-production-env)
12. [Build, migrate and start](#12-build-migrate-and-start)
13. [Start on boot](#13-start-on-boot)
14. [Enable the Nginx site](#14-enable-the-nginx-site)
15. [Verify](#15-verify)
16. [Redeploy](#16-redeploy)
17. [Troubleshooting](#17-troubleshooting)

Placeholders used below: `<elastic-ip>` is the instance's public address, `<admin-ip>` is the
public IP of the machine you administer from and `<key-file>` is the private key downloaded
from AWS.

Server layout:

| Path                                         | Contents                                   |
| -------------------------------------------- | ------------------------------------------ |
| `/home/ubuntu/rocky/rocky-api`               | This repository (`~/rocky/rocky-api`)      |
| `/home/ubuntu/rocky/secrets/`                | Secrets directory, mode 700                |
| `/home/ubuntu/rocky/secrets/firebase-admin.json` | Firebase service account key, mode 600 |

## 1. Target architecture

```
Internet ──► :80 Nginx ──► /api/*  ──► 127.0.0.1:4000  rocky-api (PM2, fork, 1 instance)
                      └──► /*      ──► placeholder text (rocky-web later)
                                        │
                                        ├─► 127.0.0.1:5432 PostgreSQL 18 (ADR-009)
                                        └─► Firebase Auth / Storage (HTTPS, outbound)
```

Only ports 22 (from the admin IP), 80 and 443 are reachable from outside. The API and
PostgreSQL are protected twice:

- **API:** it binds to `127.0.0.1:4000` (the `HOST` variable, default `127.0.0.1`), so it does
  not accept connections from other machines at all, and the security group does not open
  port 4000 either. Only Nginx, on the same host, can reach it.
- **PostgreSQL:** it listens on localhost only (ADR-009), and port 5432 is not opened in the
  security group.

## 2. Launch the EC2 instance

In the AWS console: **EC2 → Instances → Launch instances**.

| Setting        | Value                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| Name           | `rocky`                                                                     |
| AMI            | Ubuntu Server 26.04.1 LTS (64-bit x86)                                      |
| Instance type  | `t3.small` (2 vCPU, 2 GiB RAM)                                              |
| Key pair       | **Create new key pair** → type **ED25519**, format **.pem**                 |
| Storage        | 20 GiB gp3                                                                  |

**Security group** (create a new one, e.g. `rocky-sg`), inbound rules:

| Type  | Port | Source            | Why                                      |
| ----- | ---- | ----------------- | ---------------------------------------- |
| SSH   | 22   | `<admin-ip>/32`   | Administration from your machine only    |
| HTTP  | 80   | `0.0.0.0/0`, `::/0` | Public web traffic                     |
| HTTPS | 443  | `0.0.0.0/0`, `::/0` | Opened now; used once TLS is set up (#15) |

Do **not** add rules for 4000 (API) or 5432 (PostgreSQL). Outbound: leave the default
(all traffic), which the server needs for `apt`, `npm`, GitHub and Firebase.

ED25519 keys are shorter and faster than RSA with equivalent or better security. Store the
downloaded `.pem` file outside the repository; AWS does not let you download it again.

> If your home IP changes, SSH will time out. Update the SSH rule in the security group
> (**Edit inbound rules → My IP**).

## 3. Allocate an Elastic IP

A normal public IP changes every time the instance is stopped and started. An Elastic IP stays
fixed, which the DNS record in #15 will need.

1. **EC2 → Elastic IPs → Allocate Elastic IP address → Allocate.**
2. Select the new address → **Actions → Associate Elastic IP address** → choose the `rocky`
   instance → **Associate**.

From now on, use this address as `<elastic-ip>`. An Elastic IP that is allocated but not
associated with a running instance is billed, so release it if the instance is terminated.

## 4. Connect from Windows

OpenSSH refuses a private key that other users can read ("UNPROTECTED PRIVATE KEY FILE").
On Windows this is controlled with ACLs instead of `chmod`. In PowerShell, in the folder that
holds the key:

```powershell
# Remove inherited permissions (Users, Administrators, ...).
icacls .\<key-file>.pem /inheritance:r
# Give only the current user read access.
icacls .\<key-file>.pem /grant:r "$($env:USERNAME):(R)"
# Check: only your user should be listed.
icacls .\<key-file>.pem
```

Connect (the default user on Ubuntu AMIs is `ubuntu`):

```powershell
ssh -i .\<key-file>.pem ubuntu@<elastic-ip>
```

All following commands run on the server as `ubuntu`, unless stated otherwise.

## 5. Base system and swap

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot   # only if the upgrade installed a new kernel; reconnect afterwards
```

The `t3.small` has 2 GiB of RAM, shared by PostgreSQL, Nginx and the API. `npm ci` and
`nest build` use a lot of memory for a short time; without swap the out-of-memory killer can
stop the build or a running process. Add a 2 GiB swap file (the kernel's default swappiness
is kept):

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile          # swap can contain secrets from memory; root only
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # keep it after a reboot

free -h   # Swap: 2.0Gi
```

## 6. Node.js 26

Ubuntu's own `nodejs` package is older than the version `package.json` requires
(`"node": ">=26 <27"`). Install Node 26 from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_26.x -o nodesource_setup.sh
less nodesource_setup.sh          # read a script before running it as root
sudo bash nodesource_setup.sh
sudo apt install -y nodejs
rm nodesource_setup.sh

node --version   # v26.x
npm --version    # 11.x or later
```

## 7. PostgreSQL 18

Ubuntu's archive pins one PostgreSQL major version per release. The official PostgreSQL
(PGDG) apt repository provides PostgreSQL 18 and its security updates.

```bash
sudo apt install -y postgresql-common
# Official helper: adds the apt.postgresql.org repository and its signing key.
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt install -y postgresql-18
```

**Localhost only (ADR-009).** The packaged default is `listen_addresses = 'localhost'`.
Confirm it is not overridden:

```bash
sudo grep -n "listen_addresses" /etc/postgresql/18/main/postgresql.conf
sudo ss -tlnp | grep 5432   # must show 127.0.0.1:5432 (and [::1]:5432), never 0.0.0.0
```

The security group does not open 5432 either, so the database is protected twice.

**Database and user.** `--pwprompt` asks for the password interactively, so it never appears
in the shell history or the process list:

```bash
sudo -u postgres createuser --pwprompt rocky
sudo -u postgres createdb --owner=rocky rocky
```

Use a long random password and keep it in your password manager. The `rocky` user owns the
`rocky` database, which is enough for `prisma migrate deploy` to create tables; it is not a
superuser.

Check the login (prompts for the password):

```bash
psql "postgresql://rocky@127.0.0.1:5432/rocky" -c "select version();"
```

## 8. Nginx and PM2

```bash
sudo apt install -y nginx
systemctl status nginx --no-pager   # active (running)
```

PM2 is the process manager — comparable to running a Spring Boot jar as a systemd service,
with crash restarts and log files built in:

```bash
sudo npm install -g pm2
pm2 --version
```

PM2 writes logs to `~/.pm2/logs/` and never rotates them by default. `pm2-logrotate` prevents
them from filling the disk. It is installed with its default settings:

```bash
pm2 install pm2-logrotate
pm2 conf pm2-logrotate   # shows the active settings (max_size, retain, compress, ...)
```

## 9. Firebase service account

ADR-011: the API loads the Firebase Admin SDK key from a JSON file whose path is in `.env`.
The file lives outside the repository, readable only by the application user.

On the server, create the directory:

```bash
mkdir -p ~/rocky/secrets
chmod 700 ~/rocky/secrets
```

From your Windows machine (PowerShell), copy the key over SSH. Replace the local path with
wherever you keep the key; it never goes through Git:

```powershell
scp -i .\<key-file>.pem <local-path-to-service-account>.json ubuntu@<elastic-ip>:~/rocky/secrets/firebase-admin.json
```

Back on the server:

```bash
chmod 600 ~/rocky/secrets/firebase-admin.json
ls -ld ~/rocky/secrets              # drwx------ ... /home/ubuntu/rocky/secrets
ls -l ~/rocky/secrets/              # -rw------- 1 ubuntu ubuntu ... firebase-admin.json
```

Do not `cat` the file to check it; the API validates it at startup (it must contain
`project_id`, `client_email` and `private_key`, and `project_id` must equal
`FIREBASE_PROJECT_ID`).

## 10. Clone the repository

```bash
cd ~/rocky
git clone https://github.com/ChathuniPG/rocky-api.git
cd ~/rocky/rocky-api
```

The rest of this guide assumes the repository is at `/home/ubuntu/rocky/rocky-api`.

## 11. Production `.env`

Both the Nest `ConfigModule` and `prisma.config.ts` read `.env` from the repository root.
Create it **before** `npm ci`, because the `postinstall` script runs `prisma generate`:

```bash
cd ~/rocky/rocky-api
nano .env
chmod 600 .env
```

Set these variables. `.env.example` describes each one; `src/config/env.validation.ts`
validates them and the API refuses to start if one is missing or invalid.

| Variable                        | Production notes                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `NODE_ENV`                      | `production`. PM2 also sets it (`ecosystem.config.cjs`), which takes precedence. |
| `PORT`                          | Must match Nginx's `proxy_pass` port and `HEALTH_URL` in `redeploy.sh` (both 4000). |
| `HOST`                          | Optional. The default `127.0.0.1` is what Nginx proxies to; do not set `0.0.0.0` here. |
| `DATABASE_URL`                  | The `rocky` user and database from step 7, host `127.0.0.1`, port `5432`.        |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Absolute path of the key from step 9: `/home/ubuntu/rocky/secrets/firebase-admin.json`. |
| `FIREBASE_PROJECT_ID`           | Firebase console → Project settings → General.                                    |
| `FIREBASE_STORAGE_BUCKET`       | Bare bucket name, no `gs://`.                                                     |
| `FIREBASE_WEB_API_KEY`          | Firebase console → Project settings → General. Treat it as a secret.             |
| `COOKIE_SECURE`                 | **`true`**. The API refuses to start in production with `false` (ADR-003).        |
| `SEED_DEMO_PASSWORD`            | Optional. Only needed for the one-off demo seed (below); the API ignores it.     |

The `POSTGRES_*` variables in `.env.example` are read by Docker Compose for local development
only and are not needed on the server.

Notes:

- If the database password contains characters such as `@`, `:`, `/`, `#` or `%`,
  percent-encode them in `DATABASE_URL`, or the URL will be parsed incorrectly.
- Never commit, print or paste the server's `.env`. It is excluded by `.gitignore`.
- **`COOKIE_SECURE=true` over plain HTTP:** browsers do not store cookies with the Secure flag
  on an `http://` site. Until HTTPS is set up (#15), login from a browser will not keep the
  session. `curl` and the health check are unaffected.

## 12. Build, migrate and start

The first deployment runs the same steps as `deploy/redeploy.sh`, by hand:

```bash
cd ~/rocky/rocky-api

# The Nest CLI (build) and the Prisma CLI (migrate) are devDependencies.
npm ci --include=dev

npm run build                 # nest build → dist/main.js

# Applies the migrations in prisma/migrations. Unlike `migrate dev`, it never resets
# data or creates new migrations.
npm run db:migrate:deploy

pm2 start ecosystem.config.cjs
pm2 status                    # rocky-api: online
```

Check that the API answers locally:

```bash
curl -i http://127.0.0.1:4000/api/v1/health
# HTTP/1.1 200 OK ... {"status":"ok","database":"up"}
```

The startup line in `pm2 logs rocky-api` reads `Listening on http://127.0.0.1:4000/api/v1`.

### Demo data for reviewers (optional)

`npm run db:seed` creates six demo users (`demo_*` usernames, `demo.<name>@example.com`
emails, password `SEED_DEMO_PASSWORD`) with avatars, about 25 posts, likes, saves, follows,
comments and two conversations. It goes through the API's own services, so the demo users are
real Firebase accounts and their images live in Firebase Storage. It refuses to run with
`NODE_ENV=production` unless asked to explicitly:

```bash
cd ~/rocky/rocky-api
npm run db:seed -- --allow-production            # safe to repeat: creates only what is missing
npm run db:seed -- --allow-production --reset    # delete every demo_ user, then seed fresh
```

`--reset` deletes the demo users' Firebase accounts, Storage folders and database rows
(cascading to their posts, comments, likes and messages). Other users are never touched.

## 13. Start on boot

NFR-OPS-01: PM2 must start on boot and restore the API.

```bash
pm2 startup systemd
```

This prints a `sudo env PATH=... pm2 startup systemd -u ubuntu --hp /home/ubuntu` command.
Copy and run exactly that command; it installs the `pm2-ubuntu` systemd service. Then save the
current process list, which the service restores at boot:

```bash
pm2 save
systemctl status pm2-ubuntu --no-pager   # enabled
```

Run `pm2 save` again whenever the process list changes (`redeploy.sh` does this).

## 14. Enable the Nginx site

The commands are taken from the header of `deploy/nginx/rocky.conf`:

```bash
cd ~/rocky/rocky-api
sudo cp deploy/nginx/rocky.conf /etc/nginx/sites-available/rocky
sudo ln -s /etc/nginx/sites-available/rocky /etc/nginx/sites-enabled/rocky
# The default site also claims default_server on port 80; two default servers fail nginx -t.
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The site forwards `/api/` unchanged to `127.0.0.1:4000`, overwrites `X-Forwarded-For` with
the real client address (the API uses `trust proxy = loopback` for per-IP rate limits,
ADR-012), allows request bodies up to 30 MB (25 MB videos, FR-POST-02) and hides the Nginx
version.

When `rocky.conf` changes in the repository, copy it again and run the last command. The
`sites-available` file is a copy, not a link, so `git pull` alone does not change Nginx.

## 15. Verify

From your own machine (not the server):

```bash
# API through Nginx
curl -i http://<elastic-ip>/api/v1/health
# HTTP/1.1 200 OK, {"status":"ok","database":"up"}, no "Server: nginx/x.y" version

# Frontend placeholder
curl http://<elastic-ip>/
# R.O.C.K.Y. web app coming soon.

# Ports that must NOT be reachable (both should time out)
curl --max-time 5 http://<elastic-ip>:4000/api/v1/health
nc -vz -w 5 <elastic-ip> 5432    # or: Test-NetConnection <elastic-ip> -Port 5432 (PowerShell)
```

Swagger UI is at `http://<elastic-ip>/api/docs`.

On the server:

```bash
pm2 status                           # rocky-api online, restarts not climbing
pm2 logs rocky-api --lines 50        # Nest startup lines, no errors
free -h                              # swap active
```

**Listening sockets.** Check which address each service is bound to:

```bash
sudo ss -tlnp
```

Expected (other columns trimmed):

| Local address                    | Process  | Meaning                                    |
| -------------------------------- | -------- | ------------------------------------------ |
| `127.0.0.1:4000`                 | `node`   | API, loopback only (`HOST`)                |
| `127.0.0.1:5432`, `[::1]:5432`   | `postgres` | PostgreSQL, loopback only (ADR-009)      |
| `0.0.0.0:80`, `[::]:80`          | `nginx`  | Public entry point                         |
| `0.0.0.0:22`, `[::]:22`          | `sshd`   | SSH (restricted by the security group)     |

`0.0.0.0:4000`, `*:4000` or `0.0.0.0:5432` would mean the API or the database listens on all
interfaces: check `HOST` in `.env` and `listen_addresses` in `postgresql.conf`.

**Crash test** (automatic restart):

```bash
pm2 describe rocky-api | grep -E "pid|restarts"
kill -9 <pid>                        # simulate a crash
pm2 status                           # online again, restarts +1, new pid
```

**Reboot test** (start on boot):

```bash
sudo reboot
```

Wait a minute, reconnect, then:

```bash
pm2 status                                      # rocky-api online, without starting it by hand
systemctl is-active nginx postgresql            # active, active
curl -i http://127.0.0.1:4000/api/v1/health     # 200
```

And again from your machine: `curl -i http://<elastic-ip>/api/v1/health` returns 200, which
also confirms the Elastic IP survived the reboot.

## 16. Redeploy

After changes are merged into `main`, on the server:

```bash
bash ~/rocky/rocky-api/deploy/redeploy.sh
```

The script (`set -euo pipefail`, stops on the first error):

1. `git pull --ff-only` — never creates a merge commit on the server
2. `npm ci --include=dev`
3. `npm run build`
4. `npm run db:migrate:deploy`
5. `pm2 reload ecosystem.config.cjs --update-env`, or `pm2 start` if the app is not running
6. `pm2 save`
7. Polls `http://127.0.0.1:4000/api/v1/health` up to 15 times, 2 s apart, and exits non-zero
   if it never returns 200

If `PORT` is not 4000, pass the health URL explicitly:

```bash
HEALTH_URL=http://127.0.0.1:<port>/api/v1/health bash ~/rocky/rocky-api/deploy/redeploy.sh
```

Changes the script does **not** apply:

- A changed `deploy/nginx/rocky.conf` — copy it and reload Nginx (step 14).
- A changed `.env` — edit it, then run `pm2 reload ecosystem.config.cjs --update-env`.
- A replaced service account key — copy it as in step 9, then reload PM2.

## 17. Troubleshooting

**The API does not start or keeps restarting**

```bash
pm2 status
pm2 logs rocky-api --lines 100       # recent output and errors
pm2 logs rocky-api --err --lines 100 # errors only
pm2 describe rocky-api               # script, cwd, restarts, log file paths
```

Common causes:

- `Invalid environment configuration: ...` — a variable in `.env` is missing or invalid. The
  message names the variable but never prints its value. Compare with `.env.example`.
- `COOKIE_SECURE must be true in production` — set `COOKIE_SECURE=true`.
- `HOST must be an IPv4 or IPv6 address` — `HOST` must be an IP literal such as `127.0.0.1`,
  not `localhost`; or remove the line to use the default.
- Service account errors — check `FIREBASE_SERVICE_ACCOUNT_PATH` is absolute and correct,
  the file is owned by `ubuntu` with mode 600, and its project matches `FIREBASE_PROJECT_ID`.
- Database connection errors — `systemctl status postgresql`, and check `DATABASE_URL`
  (user, password encoding, `127.0.0.1:5432`, database name).
- Build killed during `npm ci` / `npm run build` — check `free -h`; the swap file from step 5
  must be active.

**Nginx returns 502 Bad Gateway / 504 Gateway Timeout**

The API is not answering on `127.0.0.1:4000`. Check `pm2 status` and
`curl -i http://127.0.0.1:4000/api/v1/health` on the server, then the PM2 logs above. If the
API is running but `sudo ss -tlnp` shows it on another address (e.g. `[::1]:4000`), `HOST` in
`.env` does not match the `127.0.0.1` that Nginx proxies to.

**Nginx does not start or reload**

```bash
sudo nginx -t                                   # syntax check, shows the file and line
systemctl status nginx --no-pager
sudo journalctl -u nginx --since "10 min ago"
sudo tail -n 50 /var/log/nginx/error.log
```

`a duplicate default server for 0.0.0.0:80` means `/etc/nginx/sites-enabled/default` is still
present (step 14).

**413 Request Entity Too Large** — the upload exceeds `client_max_body_size` (30 MB) in
`rocky.conf`. This is intended for files over the API's limits.

**The API does not come back after a reboot**

```bash
systemctl status pm2-ubuntu --no-pager
pm2 resurrect                                   # restore the saved list by hand
```

If the service is missing, repeat step 13 (`pm2 startup systemd`, run the printed command,
`pm2 save`).

**SSH times out** — your public IP has probably changed; update the SSH rule in the security
group (step 2). "Permission denied (publickey)" or "UNPROTECTED PRIVATE KEY FILE" — check the
key's ACLs (step 4) and that you connect as `ubuntu`.

**`redeploy.sh` fails at `git pull --ff-only`** — the server's checkout has local changes or
diverged history. Inspect with `git status`; the server should never have local commits.
