import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessAllowed } from '../src/lib/retention-access'

test('local chat and customer requests work without a token', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(accessAllowed(new Request('http://' + host + ':3000/api/customers')), true)
    assert.equal(accessAllowed(new Request('http://' + host + ':3000/api/chat', { method: 'POST', headers: { origin: 'http://' + host + ':3000' } })), true)
  }
})
test('remote hosts and cross-origin requests remain unavailable', () => {
  assert.equal(accessAllowed(new Request('http://192.168.1.10:3000/api/chat')), false)
  assert.equal(accessAllowed(new Request('http://localhost:3000/api/chat', { headers: { origin: 'https://external.example' } })), false)
  assert.equal(accessAllowed(new Request('http://localhost:3000/api/chat', { headers: { host: 'external.example' } })), false)
  assert.equal(accessAllowed(new Request('http://localhost:3000/api/chat', { headers: { origin: 'null' } })), false)
})

test('localhost works when Next binds its internal URL to 127.0.0.1', () => {
  assert.equal(accessAllowed(new Request('http://127.0.0.1:3000/api/chat', { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } })), true)
})
