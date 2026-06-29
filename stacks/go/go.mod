// go.mod — manifiesto de dependencias del módulo.
//
// Declara el nombre del módulo, la versión de Go y las dependencias directas.
// Fijamos versiones EXACTAS (no rangos) para que el build sea reproducible: el
// mismo go.mod baja siempre lo mismo. El go.sum (checksums) lo genera el build.
module race-go

go 1.23

require (
	github.com/gin-gonic/gin v1.10.0
	github.com/jackc/pgx/v5 v5.7.1
)
