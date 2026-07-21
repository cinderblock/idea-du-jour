# Cloudflare DNS change (staged — do not apply without authorization)

File: `cloudflare/config/isozilla/isozilla.com.yaml` in the ops repo.

Under the `firefly.isozilla.com` entry's `proxies:` map (alongside
`vikunja.isozilla.com:` etc.), add one line:

```yaml
    idj.isozilla.com: idea-du-jour capture/todo app (docker stack)
```

`proxies:` entries are Cloudflare-proxied (orange cloud) CNAMEs to firefly — the
same treatment as the existing Vikunja app. Nothing else in the zone changes.

Validate before committing (per ops CLAUDE.md): `bun run sync` (dry-run) in the
cloudflare/ dir to see the exact diff CI will apply. Requires `CF_API_TOKEN`.
