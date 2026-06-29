# Dockerfile — front estático servido por nginx.
#
# No hay build step, ni node_modules, ni dependencias externas: es un único
# index.html (HTML + CSS + JS vanilla). Las barras del ranking se dibujan con
# CSS puro, así que tampoco necesitamos una librería de gráficos.
# nginx:alpine sirve por defecto /usr/share/nginx/html en el :80.
FROM nginx:alpine

COPY index.html /usr/share/nginx/html/index.html
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 80
