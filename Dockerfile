# Dockerfile mínimo para servir el frontend público.
#
# Usa Caddy (single binary, < 50MB, autoTLS opcional, gzip/zstd
# built-in). No hace falta build step para los archivos en sí — son
# estáticos — pero SÍ corre un paso de cache-busting automático (ver
# abajo) antes de servirlos.

FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html app.js reserve.html /srv/

# Cache-busting automático: renombra app.js a app.<hash-del-contenido>.js
# y actualiza la referencia en index.html. Así, cuando el contenido de
# app.js cambia, el NOMBRE del archivo también cambia — el navegador de
# un cliente nunca reutiliza una copia vieja porque la URL es distinta,
# sin depender de que respete el Cache-Control ni de que alguien se
# acuerde de bumpear una versión a mano (eso fallaba en la práctica: un
# `?v=` manual en index.html quedó pegado en una fecha vieja durante
# semanas pese a que app.js cambió varias veces).
RUN HASH=$(sha256sum /srv/app.js | cut -c1-12) && \
    mv /srv/app.js "/srv/app.${HASH}.js" && \
    sed -i "s|src=\"\./app\.js\"|src=\"./app.${HASH}.js\"|" /srv/index.html

EXPOSE 80

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
