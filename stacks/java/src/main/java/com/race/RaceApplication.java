package com.race;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Punto de entrada del stack Java + Spring Boot.
 *
 * <p>La anotación {@code @SpringBootApplication} activa el "auto-configure" de
 * Spring Boot: al ver el driver de Postgres y la config del DataSource en
 * application.properties, arma automáticamente el pool HikariCP y el
 * {@code JdbcTemplate} que inyectamos en el controller. También levanta el
 * Tomcat embebido en el puerto configurado (:3000).</p>
 *
 * <p>No hay nada más que hacer acá: toda la lógica HTTP vive en
 * {@link ApiController}. Mantener el arranque mínimo es a propósito (sin
 * filtros ni middleware extra) para no agregar latencia al benchmark.</p>
 */
@SpringBootApplication
public class RaceApplication {

    public static void main(String[] args) {
        SpringApplication.run(RaceApplication.class, args);
    }
}
