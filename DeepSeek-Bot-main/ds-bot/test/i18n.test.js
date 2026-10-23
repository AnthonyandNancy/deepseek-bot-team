import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY, hostText, installLocale, language, t } from '../src/client/i18n.js'

function fakeLocale(active) {
  const dicts = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = (active === 'zh' ? dicts.get(`${ns}:zh`)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active }),
  }
}

test('every literal the client translates has a Chinese entry', () => {
  // Both client directories, not just `src/client/`: the Workgroup panel is a second surface with
  // its own strings, and scanning only the first one let sixteen untranslated keys through. A
  // missing entry is invisible until someone runs the Chinese UI, which is the shape of bug this
  // test exists to catch.
  const dirs = [
    new URL('../src/client/', import.meta.url),
    new URL('../src/workgroup/client/', import.meta.url),
  ]
  const missing = []
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter(file => file.endsWith('.js'))) {
      // Comments are stripped first: this repository's sources quote the shipped DSH registrations
      // verbatim, and a quoted `t("panel")` is documentation of another package's string, not one
      // this plugin has to translate.
      const text = readFileSync(new URL(name, dir), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .filter(line => !line.trim().startsWith('//'))
        .join('\n')
      for (const match of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
        const key = match[2].replace(/\\'/g, "'")
        if (!Object.hasOwn(DICTIONARY.zh, key)) missing.push(`${name}: ${key}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('copy follows the DSH language and stays English without a locale service', () => {
  assert.equal(t('Message {name}', { name: 'Chief' }), 'Message Chief')
  assert.equal(language(), 'en')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(language(), 'zh')
    assert.equal(t('Message {name}', { name: 'Chief' }), '给 Chief 发消息')
    assert.equal(t('Model'), '模型')
    assert.equal(hostText('A Bot named Writer already exists'), '已经有叫 Writer 的 Bot 了')
    assert.equal(hostText('The team needs at least one Main Bot'), '团队至少要有一个主 Bot')
    assert.equal(hostText('Something new'), 'Something new')
    // Whole memory messages, not only their first words, become Chinese.
    assert.equal(hostText('An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.'), '一条记忆最多 300 个字符，这条有 301 个')
    assert.equal(hostText("Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic."), '主记忆会超过 4000 个字符的上限，请先删掉一些')
    assert.equal(hostText('There is no entry 9.'), '没有第 9 条')
  } finally {
    off()
  }
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
})
