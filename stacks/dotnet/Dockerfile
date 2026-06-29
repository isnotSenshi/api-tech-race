# Dockerfile — empaqueta el stack .NET en una imagen lista para correr en :3000.
#
# Multi-stage: compilamos en la imagen pesada del SDK y copiamos el resultado a
# una runtime chica. Así la imagen final NO lleva compilador ni fuentes, solo lo
# necesario para ejecutar. Versiones fijas (8.0) para builds reproducibles.

# ── Etapa 1: build ───────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Truco de CACHE de capas: copiamos PRIMERO solo el .csproj y restauramos las
# dependencias NuGet. Esa capa solo se invalida si cambian las dependencias, así
# que editar Program.cs no fuerza un restore completo en cada rebuild.
COPY dotnet.csproj ./
RUN dotnet restore

# Ahora sí el resto del código (lo que cambia seguido).
COPY . .

# publish -c Release: compilación optimizada. --no-restore porque ya restauramos.
# Salida a /app/publish: ahí queda la dll lista para ejecutar.
RUN dotnet publish dotnet.csproj -c Release -o /app/publish --no-restore

# ── Etapa 2: runtime ─────────────────────────────────────────────────────────
# aspnet:8.0 = runtime de ASP.NET Core, sin SDK: imagen mucho más chica.
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

# Copiamos SOLO el artefacto publicado desde la etapa de build.
COPY --from=build /app/publish ./

# Puerto interno donde escucha el server (lo fija UseUrls en Program.cs). El mapeo
# real al host lo define docker-compose.yml. EXPOSE es documentativo.
EXPOSE 3000

# Arranca la app ejecutando la dll. El nombre sale del <AssemblyName>, que por
# defecto es el del proyecto: dotnet.csproj -> dotnet.dll.
ENTRYPOINT ["dotnet", "dotnet.dll"]
