'use strict'
// Shopify-Zugang der Buchhaltung (Admin-GraphQL).
// Der Zugang wird bei jedem Aufruf neu geholt: in Vendo aus Hermes (host.js, nur lesen; ein im System-Tab erneuerter Token
// gilt sofort), eigenständig aus den verschlüsselt gespeicherten Angaben. Der Token bleibt im Hauptteil, wird nie geloggt
// und nie an die Oberfläche gegeben.

const API_VERSION = '2025-07'

const warten = (ms) => new Promise((r) => setTimeout(r, ms))

// Woher der Zugang kommt, legt haupt.js über den Host fest: in Vendo aus Hermes, eigenständig aus der Oberfläche.
let quelle = null
function einrichten({ zugang } = {}) { quelle = typeof zugang === 'function' ? zugang : null }

function zugang() {
  if (!quelle) throw new Error('Kein Shopify-Zugang eingerichtet.')
  const z = quelle() || {}
  const token = String(z.token || '')
  const shop = String(z.shop || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!token || !shop) throw new Error('Kein Shopify-Zugang eingerichtet (Shop-Adresse und Zugriffstoken).')
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(shop)) throw new Error('Die Shop-Adresse ist ungültig (z. B. mein-shop.myshopify.com).')
  return { token, shop }
}

async function graphql(query, variablen = {}, versuch = 0) {
  const { token, shop } = zugang()
  let antwort
  try {
    antwort = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: variablen }),
      signal: AbortSignal.timeout(30000)
    })
  } catch {
    throw new Error('Shopify ist gerade nicht erreichbar.')
  }
  if (antwort.status === 401 || antwort.status === 403) throw new Error('Shopify lehnt den Token ab. Bitte den Zugang erneuern (in Vendo: System-Tab).')
  if (antwort.status === 429 && versuch < 5) { await warten(2000 * (versuch + 1)); return graphql(query, variablen, versuch + 1) }
  if (!antwort.ok) throw new Error(`Shopify antwortet mit Fehler ${antwort.status}.`)
  const j = await antwort.json()
  if (j.errors?.some?.((e) => e.extensions?.code === 'THROTTLED') && versuch < 5) { await warten(2000 * (versuch + 1)); return graphql(query, variablen, versuch + 1) }
  if (j.errors) throw new Error(Array.isArray(j.errors) ? j.errors.map((e) => e.message).join('; ') : String(j.errors))
  const kosten = j.extensions?.cost
  if (kosten?.throttleStatus && kosten.throttleStatus.currentlyAvailable < kosten.requestedQueryCost * 1.5) await warten(1500)
  return j.data
}

module.exports = { graphql, einrichten, API_VERSION }