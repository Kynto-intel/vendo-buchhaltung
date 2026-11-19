'use strict'
// Optionale PostgreSQL-Anbindung im eigenständigen Betrieb (Verbindungsangabe BUCHHALTUNG_DB_URL).
// Bietet dieselbe Schnittstelle wie Vendos ctx.datenbank: zustand, bereit, abfrage, transaktion, beiBereit, migrieren.
// Genutzt nur für den abgeleiteten Index (datenbank-index.js); maßgeblich bleibt das Belegarchiv.
// Braucht das Paket „pg“ (optionale Abhängigkeit); fehlt es, bleibt die Datenbank „aus“.

function datenbank(verbindung, { schema = 'buchhaltung' } = {}) {
  let pool = null
  let stand = { zustand: 'startet', meldung: 'Verbindet …' }
  const wartende = new Set()
  const bereit = () => stand.zustand === 'bereit'

  const start = (async () => {
    let pg
    try { pg = require('pg') } catch { stand = { zustand: 'aus', meldung: 'Paket „pg“ ist nicht installiert (npm install pg).' }; return }
    try {
      pool = new pg.Pool({ connectionString: verbindung, max: 4, connectionTimeoutMillis: 5000 })
      pool.on('error', (f) => { stand = { zustand: 'fehler', meldung: f.message } })
      await pool.query('SELECT 1')
      stand = { zustand: 'bereit', meldung: 'Verbunden.' }
      for (const fn of wartende) Promise.resolve().then(fn).catch((f) => console.warn(`Datenbank: ${f.message}`))
    } catch (f) {
      stand = { zustand: 'fehler', meldung: `Keine Verbindung: ${f.message}` }
    }
  })()

  async function migrieren(liste) {
    if (!bereit()) throw new Error(`Datenbank nicht bereit: ${stand.meldung}`)
    const c = await pool.connect()
    try {
      await c.query('CREATE TABLE IF NOT EXISTS public.buchhaltung_schema_version (bereich text PRIMARY KEY, version int NOT NULL, geaendert_am timestamptz NOT NULL DEFAULT now())')
      await c.query('BEGIN')
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
      const r = await c.query('SELECT version FROM public.buchhaltung_schema_version WHERE bereich = $1', [schema])
      const ist = r.rows[0]?.version || 0
      const offen = [...liste].sort((a, b) => a.version - b.version).filter((m) => m.version > ist)
      for (const m of offen) await c.query(m.sql)
      if (offen.length) await c.query('INSERT INTO public.buchhaltung_schema_version (bereich, version) VALUES ($1, $2) ON CONFLICT (bereich) DO UPDATE SET version = $2, geaendert_am = now()', [schema, offen.at(-1).version])
      await c.query('COMMIT')
      return { vorher: ist, jetzt: offen.at(-1)?.version || ist }
    } catch (f) {
      await c.query('ROLLBACK').catch(() => {})
      throw f
    } finally { c.release() }
  }

  return {
    start,
    zustand: () => ({ ...stand }),
    bereit,
    async abfrage(sql, werte) {
      if (!bereit()) throw new Error(`Datenbank nicht bereit: ${stand.meldung}`)
      return pool.query(sql, werte)
    },
    async transaktion(arbeit) {
      if (!bereit()) throw new Error(`Datenbank nicht bereit: ${stand.meldung}`)
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        const erg = await arbeit(c)
        await c.query('COMMIT')
        return erg
      } catch (f) {
        await c.query('ROLLBACK').catch(() => {})
        throw f
      } finally { c.release() }
    },
    beiBereit(fn) {
      if (bereit()) Promise.resolve().then(fn).catch((f) => console.warn(`Datenbank: ${f.message}`))
      wartende.add(fn)
      return () => wartende.delete(fn)
    },
    migrieren,
    async beenden() { await start; stand = { zustand: 'aus', meldung: 'Beendet.' }; wartende.clear(); await pool?.end().catch(() => {}) }
  }
}

module.exports = { datenbank }
