# Dockerfile mínimo para servir el frontend público.
#
# Usa Caddy (single binary, < 50MB, autoTLS opcional, gzip/zstd
# built-in). No hace falta build step — son archivos estáticos.

FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html app.js /srv/

EXPOSE 80

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
