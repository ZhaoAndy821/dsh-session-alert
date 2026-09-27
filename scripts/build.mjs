#!/usr/bin/env node
/**
 * Wrap the plugin source into the classic-script envelope a DSH client bundle
 * uses: window.__ModuleLoader__.load({ id, factory }).
 *
 * No bundler: the source is written as the factory body (it may require("react")
 * and other client modules; the loader provides them). The envelope format
 * mirrors the one dsh-hot-plugin-host/build.mjs produces, so the output is also
 * loadable straight from ~/.dsh/hot-plugins/<id>/client.js.
 *
 * usage: node scripts/build.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BUNDLE_ID = 'dsh-session-alert'
export const SRC = resolve(ROOT, 'src/client/index.js')
export const OUT = resolve(ROOT, 'lib/client.js')

/** Read the factory body, refusing a source that is already wrapped. */
export function readBody() {
  const body = readFileSync(SRC, 'utf8')
  if (body.includes('__ModuleLoader__')) {
    throw new Error('src/client/index.js must be a factory body, not an envelope')
  }
  return body
}

/** Build lib/client.js from src/client/index.js and report the result. */
export function build() {
  const body = readBody()
  const bundle =
    'window.__ModuleLoader__.load({\n' +
    '\tid: ' + JSON.stringify(BUNDLE_ID) + ',\n' +
    '\tfactory: (require) => {\n' +
    '\t\tvar module = { exports: {} };\n' +
    '\t\tvar exports = module.exports;\n' +
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n' +
    body +
    '\n\t\treturn module.exports;\n' +
    '\t}\n' +
    '});\n'
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, bundle)
  return { out: OUT, bytes: Buffer.byteLength(bundle) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = build()
  console.log('built ' + result.out + ' (' + result.bytes + ' bytes, id=' + BUNDLE_ID + ')')
}
