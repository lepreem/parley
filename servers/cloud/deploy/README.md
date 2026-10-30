# Deploying to the VPS

Production is one VPS running `../compose.yaml` with `../compose.prod.yaml` on
top, behind a Caddy proxy that other projects on the box can share. Every push
to `main` builds the images and deploys them
(`.github/workflows/deploy.yml`).

| File           | What it is                                                    |
| -------------- | ------------------------------------------------------------- |
| `provision.sh` | One-time server setup. Safe to run again.                     |
| `deploy.sh`    | One deploy. The workflow copies it to the server and runs it. |
| `parley.caddy` | Parley's site on the proxy. `deploy.sh` fills in the domain.  |
| `proxy/`       | The shared Caddy, installed at `/opt/proxy`.                  |

## Set up the server

Once per server. Steps 1 to 3 happen on your own machine.

1. **Order the VPS.** Ubuntu 24.04 or 26.04, in the region closest to the Supabase
   project, with your SSH public key added when ordering.
2. **Make a deploy key** for GitHub Actions. It signs in as `deploy`, a user
   that can run Docker and nothing more.

   ```sh
   ssh-keygen -t ed25519 -N '' -C parley-deploy -f parley-deploy
   ```

3. **Provision.** From the repo root, with `ubuntu` being the user the VPS came
   with:

   ```sh
   scp -r servers/cloud/deploy ubuntu@<server-ip>:
   ssh ubuntu@<server-ip> "sudo sh deploy/provision.sh '$(cat parley-deploy.pub)'"
   ```

   It turns off password sign-in, so it refuses to run unless that user signs
   in with a key.

4. **Secrets.** In Doppler, project `parley`, fill in the `prd` config with
   the production values, plus `RABBITMQ_PASSWORD`, from `openssl rand -hex 24`. Leave out `MQ_URL`,
   `PORT`, `CLIENT_URL` and `API_BASE_URL`: the compose files set those.
   For guest chat (chatting without an account), add `GUEST_SESSION_SECRET`,
   from `openssl rand -base64 32`, and `OPENROUTER_GUEST_API_KEY`, an
   OpenRouter key of its own with a credit limit: that limit is the cap on
   what guests can spend. Without both, there's no guest chat.
   Then create a service token for `prd` (Access → Service Tokens) and paste
   it into this, followed by Enter and Ctrl-D:

   ```sh
   ssh ubuntu@<server-ip> 'sudo install -m 600 -o deploy -g deploy /dev/stdin /etc/parley/doppler-token'
   ```

5. **DNS.** An `A` record for the domain pointing at the server's IPv4
   address, and optionally an `AAAA` record for its IPv6 one.
6. **WorkOS.** Add `https://<domain>/auth/callback` as a redirect URI.
7. **GitHub.** In the repo, Settings → Secrets and variables → Actions:

   | Kind     | Name                 | Value                                               |
   | -------- | -------------------- | --------------------------------------------------- |
   | Secret   | `DEPLOY_SSH_KEY`     | The contents of `parley-deploy` (the private half)  |
   | Variable | `DEPLOY_HOST`        | The server's IP address                             |
   | Variable | `DEPLOY_KNOWN_HOSTS` | The output of `ssh-keyscan -t ed25519 <server-ip>`  |
   | Variable | `PARLEY_DOMAIN`      | The domain, e.g. `parley.example.com`               |
   | Variable | `DEPLOY_ENABLED`     | `true`. Until it is, the workflow skips every push. |

8. **Deploy.** Actions → Deploy → Run workflow. Caddy gets the certificate on
   the first request.

## Day to day

- **Logs:** `ssh deploy@<server-ip> docker logs -f parley-api-1`, or
  `parley-youtube-fetcher-1`, `parley-rabbitmq-1`.
- **RabbitMQ's UI:** `ssh -L 15672:127.0.0.1:15672 deploy@<server-ip>`, then
  <http://localhost:15672> as `parley` with `RABBITMQ_PASSWORD`. Changing that
  password later takes `rabbitmqctl change_password parley <new>` in the
  container as well as Doppler, since the broker keeps the first one.
- **Roll back:** re-run the Deploy workflow run of the last good commit. It
  deploys that commit's images again.
- **A failed deploy** leaves the containers it started running, and prints
  the logs of any that kept restarting.

## Another project on the same server

Give its web container a network alias that's unique on the server, on the
external `proxy` network (see `compose.prod.yaml` for Parley's), add a site
file like `parley.caddy` to `/opt/proxy/caddy/sites/`, and reload Caddy:

```sh
docker compose -f /opt/proxy/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile
```
