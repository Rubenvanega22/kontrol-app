# kontrolv1.0

## Migración: tabla `caja_movimientos` (REQUERIDA)

Las cajas usan una tabla **separada** de `movements`. Antes del primer
despliegue de esta versión, ejecuta este SQL en el SQL Editor de Supabase:

```sql
CREATE TABLE IF NOT EXISTS caja_movimientos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  caja_id uuid REFERENCES cajas(id),
  tipo text CHECK (tipo IN ('ingreso','gasto')),
  monto numeric NOT NULL,
  descripcion text,
  fecha date DEFAULT CURRENT_DATE,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE caja_movimientos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users own caja_movimientos" ON caja_movimientos
  FOR ALL USING (auth.uid() = user_id);
```

> Limpieza opcional: si ya tenías registros viejos con `categoria='caja'`
> dentro de `movements` (de versiones anteriores), bórralos para que no
> ensucien históricos: `DELETE FROM movements WHERE categoria='caja';`
> El frontend ya los filtra defensivamente, pero limpiarlos es lo correcto.

## Crons configurados en `vercel.json`

| Path                    | UTC         | Hora Colombia (UTC-5) |
|-------------------------|-------------|-----------------------|
| `/api/sync-emails`      | `0 13 * * *`| 08:00                 |
| `/api/sync-emails`      | `0 17 * * *`| 12:00                 |
| `/api/sync-emails`      | `0 21 * * *`| 16:00                 |
| `/api/sync-emails`      | `0 1 * * *` | 20:00                 |
| `/api/ai-analysis`      | `0 9 * * *` | 04:00                 |
| `/api/reminders-cron`   | `0 13 * * *`| 08:00 (resumen diario)|

## cron-job.org — frecuencia fina del "rolling" de recordatorios

Vercel Hobby solo permite crons diarios (rechaza `*/1 * * * *` al deploy).
Para soporte de "recuérdame en 5 minutos" usamos un cron externo en
[cron-job.org](https://console.cron-job.org/):

### Job: Sync de correos cada 4 horas

- **Title:** Kontrol sync-emails (4h)
- **URL:** `https://kontrol-app-eight.vercel.app/api/sync-emails`
- **Schedule:** every 4 hours (`0 */4 * * *` en UTC)
- **Notifications:** disabled

### Job: Recordatorios cada 1 minuto

- **Title:** Kontrol reminders-cron (1min)
- **URL:** `https://kontrol-app-eight.vercel.app/api/reminders-cron`
- **Schedule:** every minute (`* * * * *`)
- **Notifications:** disabled

> El endpoint `reminders-cron` ejecuta en cada tick los modos "rolling":
> `modoQuinceMinAntes` (ventana [-15, +30] min) y `modoUnaHoraAntes`
> (ventana [+15, +90] min). Cuando el `utcHour` es 13 (8am Col) o 23 (6pm
> Col), corre también los modos diarios (resumen agenda, batches de pagos).
>
> **Dedup garantizado por los flags** `notificado_15min` / `notificado_1h` /
> `notificado_agenda` de la tabla `events`: el primer tick que matchea marca
> el flag en true; ticks siguientes ven `eq('notificado_X', false)` no
> matchea y skip. Esto vale aunque un evento entre en múltiples ticks
> consecutivos por la ventana ampliada.
