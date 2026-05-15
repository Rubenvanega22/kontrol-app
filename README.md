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

## cron-job.org — respaldo / cada 4 horas

Si la cuenta de Vercel está en plan Hobby (límite de 2 crons diarios) o se
quiere un disparo más frecuente que cubra cualquier hueco, registrar en
[cron-job.org](https://console.cron-job.org/) los siguientes jobs:

### Job: Sync de correos cada 4 horas

- **Title:** Kontrol sync-emails (4h)
- **URL:** `https://kontrol-app-eight.vercel.app/api/sync-emails`
- **Schedule:** every 4 hours (`0 */4 * * *` en UTC)
- **Notifications:** disabled

### Job: Recordatorios cada hora (modo 1h)

- **Title:** Kontrol reminders-cron (hourly)
- **URL:** `https://kontrol-app-eight.vercel.app/api/reminders-cron`
- **Schedule:** every hour at minute 0 (`0 * * * *`)
- **Notifications:** disabled

> El endpoint `reminders-cron` decide automáticamente entre el modo "resumen
> diario" (a las 13:00 UTC) y el modo "1 hora antes" (cualquier otra hora).
