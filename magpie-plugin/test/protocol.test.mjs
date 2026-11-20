import test from 'node:test'
import assert from 'node:assert/strict'
import {
  conversationTurns,
  hasInjectedContext,
  injectContext,
  replyText
} from '../lib/protocol.mjs'

const BLOCK = '# MemorySQL 续接上下文\n- 项目: demo'

test('chat: 注入到第一条用户消息，system/后续用户消息不动', () => {
  const body = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' }
    ]
  }
  const bytes = injectContext(body, 'chat', BLOCK)
  assert.ok(bytes > 0)
  assert.match(body.messages[1].content, /<memorysql-context>/)
  assert.match(body.messages[1].content, /项目: demo/)
  assert.equal(body.messages[3].content, 'next')
  assert.ok(hasInjectedContext(body, 'chat'))
  // 幂等：同一请求再注入一次不叠加
  assert.equal(injectContext(body, 'chat', BLOCK), 0)
})

test('chat: content 是 parts 数组时追加 text part', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
  injectContext(body, 'chat', BLOCK)
  assert.equal(body.messages[0].content.length, 2)
  assert.equal(body.messages[0].content[1].type, 'text')
  assert.match(body.messages[0].content[1].text, /MemorySQL/)
})

test('anthropic: 注入 user turn，system 原样保留', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'hello' }] }
  injectContext(body, 'anthropic', BLOCK)
  assert.equal(body.system, 'sys')
  assert.match(body.messages[0].content, /<memorysql-context>/)
})

test('responses: input 是字符串与数组两种形状', () => {
  const one = { input: 'hello' }
  injectContext(one, 'responses', BLOCK)
  assert.match(one.input, /<memorysql-context>/)

  const two = {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
  }
  injectContext(two, 'responses', BLOCK)
  assert.equal(two.input[0].content.length, 2)
  assert.equal(two.input[0].content[1].type, 'input_text')
})

test('gemini: 注入 contents 的 user parts，systemInstruction 不动', () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    systemInstruction: { parts: [{ text: 'sys' }] }
  }
  injectContext(body, 'gemini', BLOCK)
  assert.equal(body.contents[0].parts.length, 2)
  assert.match(body.contents[0].parts[1].text, /MemorySQL/)
  assert.equal(body.systemInstruction.parts.length, 1)
})

test('没有用户消息时不注入', () => {
  const body = { messages: [{ role: 'system', content: 'only system' }] }
  assert.equal(injectContext(body, 'chat', BLOCK), 0)
})

test('replyText 四种协议', () => {
  assert.equal(replyText({ choices: [{ message: { content: 'hi' } }] }, 'chat'), 'hi')
  assert.equal(
    replyText(
      { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }] },
      'responses'
    ),
    'hi'
  )
  assert.equal(replyText({ content: [{ type: 'text', text: 'hi' }, { type: 'tool_use' }] }, 'anthropic'), 'hi')
  assert.equal(
    replyText({ candidates: [{ content: { parts: [{ text: 'hi' }, { text: 'think', thought: true }] } }] }, 'gemini'),
    'hi'
  )
})

test('conversationTurns 只取 user/assistant 文本', () => {
  const turns = conversationTurns(
    {
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'tool', content: 't' },
        { role: 'assistant', content: 'a' }
      ]
    },
    'chat'
  )
  assert.deepEqual(
    turns.map((t) => [t.role, t.text]),
    [
      ['user', 'u'],
      ['assistant', 'a']
    ]
  )
})
