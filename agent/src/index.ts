/**
 * Pi Extension: WeChat Bridge
 *
 * Scan a QR code in WeChat → chat with your Pi coding agent from your phone.
 *
 * How it works:
 *   1. User runs `/wechat` command in pi
 *   2. Extension starts WeChat iLink login, shows QR code in the pi TUI
 *   3. User scans QR with WeChat on their phone
 *   4. WeChat messages become pi prompts
 *   5. Pi responses are sent back to WeChat
 *
 * Architecture:
 *   ┌──────────────┐      ┌──────────────┐      ┌──────────┐
 *   │  WeChat User │ ←──→ │  iLink API   │ ←──→ │ Pi Agent │
 *   │  (phone)     │      │  (Tencent)   │      │ (laptop) │
 *   └──────────────┘      └──────────────┘      └──────────┘
 *                                                     ↑
 *                                              This extension
 *
 * Install:
 *   pi -e /path/to/wechatbot/agent/src/index.ts
 *   # or copy to ~/.pi/agent/extensions/wechat-bridge/
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { WeChatClient, type IncomingMessage } from './wechat.js'

export default function wechatBridge(pi: ExtensionAPI) {
  let wechat: WeChatClient | null = null
  let connected = false
  let activeUserId: string | null = null
  let pendingReply: { userId: string; contextToken: string } | null = null

  // ── Collect assistant response text for the active WeChat user ─────
  let assistantText = ''
  let isStreaming = false

  // When agent finishes, send the accumulated reply to WeChat
  pi.on('agent_end', async (event, ctx) => {
    if (!wechat || !connected || !pendingReply) return

    const reply = pendingReply
    pendingReply = null
    isStreaming = false

    // Extract the assistant's last message text
    const messages = event.messages ?? []
    let finalText = ''
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'text') finalText += block.text
        }
      }
    }

    if (!finalText.trim()) {
      finalText = assistantText || '[No response from agent]'
    }

    try {
      await wechat.stopTyping(reply.userId)
      await wechat.reply(
        { userId: reply.userId, text: '', type: 'text', contextToken: reply.contextToken, timestamp: new Date() },
        finalText,
      )
      ctx.ui.setStatus('wechat', `✓ Replied to WeChat user`)
    } catch (e) {
      ctx.ui.setStatus('wechat', `✗ Failed to reply: ${e instanceof Error ? e.message : e}`)
    }

    assistantText = ''
  })

  // Track streaming text so we can send it even if agent_end messages are empty
  pi.on('message_update', async (event) => {
    if (!isStreaming) return
    const msg = event.message
    if (msg.role === 'assistant') {
      let text = ''
      for (const block of msg.content) {
        if (block.type === 'text') text += block.text
      }
      assistantText = text
    }
  })

  // ── /wechat command — start the bridge ────────────────────────────

  pi.registerCommand('wechat', {
    description: 'Connect WeChat — scan QR code to chat with Pi from your phone',
    handler: async (args, ctx) => {
      if (connected && wechat) {
        const action = await ctx.ui.select('WeChat is already connected', [
          'Disconnect',
          'Show status',
          'Cancel',
        ])
        if (action === 'Disconnect') {
          wechat.stop()
          connected = false
          ctx.ui.setStatus('wechat', undefined)
          ctx.ui.notify('WeChat disconnected', 'info')
        } else if (action === 'Show status') {
          const creds = wechat.getCredentials()
          ctx.ui.notify(
            `Connected as ${creds?.accountId ?? 'unknown'}\nUser: ${creds?.userId ?? 'unknown'}`,
            'info',
          )
        }
        return
      }

      // Start login
      wechat = new WeChatClient((msg) => {
        ctx.ui.setStatus('wechat', msg)
      })

      const forceLogin = args?.trim() === '--force'

      ctx.ui.notify('Starting WeChat login...', 'info')
      ctx.ui.setStatus('wechat', '⏳ Waiting for QR scan...')

      try {
        const creds = await wechat.login({
          force: forceLogin,
          onQrUrl: (url) => {
            // Show the QR URL in pi TUI — user opens it on their phone
            // In a real deployment, you'd render an actual QR code here
            ctx.ui.setWidget('wechat-qr', [
              '╔══════════════════════════════════════════╗',
              '║    📱 Scan this QR code in WeChat        ║',
              '╚══════════════════════════════════════════╝',
              '',
              url,
              '',
              'Open this URL in WeChat to login.',
              'Or scan the QR code from the URL page.',
            ])
          },
        })

        // Clear QR widget after login
        ctx.ui.setWidget('wechat-qr', undefined)
        ctx.ui.setStatus('wechat', `✓ WeChat: ${creds.accountId}`)
        ctx.ui.notify(`WeChat connected! Account: ${creds.accountId}`, 'info')
        connected = true

        // Register message handler — WeChat messages become pi prompts
        wechat.onMessage(async (msg: IncomingMessage) => {
          if (msg.type !== 'text' || !msg.text.trim()) {
            // For non-text messages, just acknowledge
            await wechat!.reply(msg, `[Received ${msg.type} — only text messages are supported]`)
            return
          }

          activeUserId = msg.userId
          pendingReply = { userId: msg.userId, contextToken: msg.contextToken }
          isStreaming = true
          assistantText = ''

          // Show typing indicator in WeChat
          await wechat!.sendTyping(msg.userId)

          // Show in pi TUI
          ctx.ui.setStatus('wechat', `📱 ${msg.userId.slice(0, 20)}...: ${msg.text.slice(0, 50)}`)

          // Send as a user message to pi — this triggers the agent!
          pi.sendUserMessage(msg.text)
        })

        // Start the long-poll loop (runs in background)
        wechat.run().catch((e) => {
          ctx.ui.setStatus('wechat', `✗ WeChat poll error: ${e instanceof Error ? e.message : e}`)
          connected = false
        })

      } catch (e) {
        ctx.ui.setWidget('wechat-qr', undefined)
        ctx.ui.setStatus('wechat', undefined)
        ctx.ui.notify(`WeChat login failed: ${e instanceof Error ? e.message : e}`, 'error')
        wechat = null
      }
    },
  })

  // ── /wechat-disconnect command ────────────────────────────────────

  pi.registerCommand('wechat-disconnect', {
    description: 'Disconnect WeChat bridge',
    handler: async (_args, ctx) => {
      if (wechat) {
        wechat.stop()
        wechat = null
      }
      connected = false
      activeUserId = null
      pendingReply = null
      ctx.ui.setStatus('wechat', undefined)
      ctx.ui.setWidget('wechat-qr', undefined)
      ctx.ui.notify('WeChat disconnected', 'info')
    },
  })

  // ── /wechat-send command — manually send to WeChat ────────────────

  pi.registerCommand('wechat-send', {
    description: 'Send a message to the connected WeChat user',
    handler: async (args, ctx) => {
      if (!wechat || !connected || !activeUserId) {
        ctx.ui.notify('No WeChat user connected. Run /wechat first.', 'error')
        return
      }
      const text = args?.trim()
      if (!text) {
        ctx.ui.notify('Usage: /wechat-send <message>', 'error')
        return
      }
      try {
        await wechat.send(activeUserId, text)
        ctx.ui.notify(`Sent to WeChat: ${text.slice(0, 50)}...`, 'info')
      } catch (e) {
        ctx.ui.notify(`Send failed: ${e instanceof Error ? e.message : e}`, 'error')
      }
    },
  })

  // ── Cleanup on shutdown ───────────────────────────────────────────

  pi.on('session_shutdown', async () => {
    if (wechat) {
      wechat.stop()
      wechat = null
    }
    connected = false
  })

  // ── Status on session start ───────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    if (connected && wechat) {
      const creds = wechat.getCredentials()
      ctx.ui.setStatus('wechat', `✓ WeChat: ${creds?.accountId ?? 'connected'}`)
    }
  })
}
