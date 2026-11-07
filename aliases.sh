alias sanda='sbx run --name summarizer-wrapper' # not needed if using t3code
alias tsand='sbx exec -it summarizer-wrapper tmux new -A -s main'
alias sand='sbx exec -it summarizer-wrapper bash'


# 3001 serves the API and the websocket; Socket.IO attaches to the same server.
alias sand_ports='sbx ports summarizer-wrapper --publish 5173:5173 && sbx ports summarizer-wrapper --publish 3001:3001'

alias sanda_browser='sbx run --name summarizer-wrapper-browser --template summarizer-codex-playwright:v1'
alias sand_browser='sbx exec -it summarizer-wrapper-browser bash'
alias sand_browser_ports='sbx ports summarizer-wrapper-browser --publish 5173:5173 && sbx ports summarizer-wrapper-browser --publish 3001:3001'

# Everything the stack has to reach, with the sandbox left on default-deny.
# Re-run after recreating a sandbox — the allow-list does not survive it.
#   runtime: supabase (db + storage), cloudamqp, and the
#            deepgram / openrouter / workos / supadata APIs
#   build:   docker hub and npm, or `docker compose build` fails
# Inspect with `sbx policy ls`; `sbx policy log` shows what got blocked and why.
alias sand_policy='sbx policy allow network supabase.co,pooler.supabase.com,cloudamqp.com,api.deepgram.com,openrouter.ai,api.workos.com,api.supadata.ai,registry.npmjs.org,registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com'
