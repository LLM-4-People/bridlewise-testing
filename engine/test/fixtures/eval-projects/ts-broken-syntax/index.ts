// ts-broken-syntax: a failure-prone fixture with syntax errors.
// This file is intentionally malformed so harness quality packs must reject it.

export function add(a, b {
  return a + b
}

export const broken = "missing closing quote

function half(x) {
  return x / 2
