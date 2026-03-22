/**
 * Minimal WeChat iLink Bot client for the pi extension.
 * Zero dependencies — uses Node 22 built-in fetch.
 *
 * Handles: QR login, long-poll, send text, typing indicator.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const BASE_URL = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '2.0.0'
const CRED_PATH = path.join(os.homedir(), '.wechatbot', 'credentials.json')

export interface Credentials {
  token: string
  baseUrl: string
  accountId: string
  userId: string
}

export interface IncomingMessage {
  userId: string
  text: string
  type: 'text' | 'image' | 'voice' | 'file' | 'video'
  contextToken: string
  timestamp: Date
}

interface WireMessage {
  from_user_id: string
  to_user_id: string
  message_type: number
  context_token: string
  create_time_ms: number
  item_list: Array<{
    type: number
    text_item?: { text: string }
    image_item?: { url?: string }
    voice_item?: { text?: string }
    file_item?: { file_name?: string }
  }>
}

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

function headers(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': randomUin(),
  }
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION }
}

export class WeChatClient {
  private creds?: Credentials
  private cursor = ''
  private stopped = false
  private ctrl: AbortController | null = null
  private ctxTokens = new Map<string, string>()
  private handlers: MessageHandler[] = []
  private log: (msg: string) => void

  constructor(log?: (msg: string) => void) {
    this.log = log ?? ((m) => process.stderr.write(`[wechat] ${m}\n`))
  }

  /** Login — returns QR URL via callback. Caller must render it. */
  async login(opts: {
    force?: boolean
    onQrUrl?: (url: string) => void
  } = {}): Promise<Credentials> {
    if (!opts.force) {
      try {
        const raw = await readFile(CRED_PATH, 'utf8')
        const c = JSON.parse(raw) as Credentials
        if (c.token && c.baseUrl) {
          this.creds = c
          this.log(`Loaded credentials for ${c.userId}`)
          return c
        }
      } catch { /* no stored creds */ }
    }

    for (;;) {
      const qr = await this.get<{ qrcode: string; qrcode_img_content: string }>(
        `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
      )
      opts.onQrUrl?.(qr.qrcode_img_content)

      let last = ''
      for (;;) {
        const s = await this.get<{
          status: string; bot_token?: string
          ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string
        }>(
          `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
          { 'iLink-App-ClientVersion': '1' },
        )

        if (s.status !== last) {
          last = s.status
          if (s.status === 'scaned') this.log('QR scanned — confirm in WeChat')
          if (s.status === 'expired') this.log('QR expired')
          if (s.status === 'confirmed') this.log('Login confirmed')
        }

        if (s.status === 'confirmed') {
          const c: Credentials = {
            token: s.bot_token!, baseUrl: s.baseurl || BASE_URL,
            accountId: s.ilink_bot_id!, userId: s.ilink_user_id!,
          }
          await mkdir(path.dirname(CRED_PATH), { recursive: true, mode: 0o700 })
          await writeFile(CRED_PATH, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
          this.creds = c
          return c
        }
        if (s.status === 'expired') break
        await sleep(2000)
      }
    }
  }

  onMessage(h: MessageHandler) { this.handlers.push(h) }

  async reply(msg: IncomingMessage, text: string) {
    this.ctxTokens.set(msg.userId, msg.contextToken)
    await this.sendText(msg.userId, text, msg.contextToken)
  }

  async sendTyping(userId: string) {
    const ct = this.ctxTokens.get(userId)
    if (!ct || !this.creds) return
    try {
      const cfg = await this.post<{ typing_ticket?: string }>(
        `${this.creds.baseUrl}/ilink/bot/getconfig`,
        { ilink_user_id: userId, context_token: ct, base_info: baseInfo() },
        this.creds.token,
      )
      if (cfg.typing_ticket)
        await this.post(`${this.creds.baseUrl}/ilink/bot/sendtyping`, {
          ilink_user_id: userId, typing_ticket: cfg.typing_ticket, status: 1, base_info: baseInfo(),
        }, this.creds.token)
    } catch { /* typing is non-fatal */ }
  }

  async stopTyping(userId: string) {
    const ct = this.ctxTokens.get(userId)
    if (!ct || !this.creds) return
    try {
      const cfg = await this.post<{ typing_ticket?: string }>(
        `${this.creds.baseUrl}/ilink/bot/getconfig`,
        { ilink_user_id: userId, context_token: ct, base_info: baseInfo() },
        this.creds.token,
      )
      if (cfg.typing_ticket)
        await this.post(`${this.creds.baseUrl}/ilink/bot/sendtyping`, {
          ilink_user_id: userId, typing_ticket: cfg.typing_ticket, status: 2, base_info: baseInfo(),
        }, this.creds.token)
    } catch { /* non-fatal */ }
  }

  /** Start long-poll loop. Blocks until stop() is called. */
  async run() {
    if (!this.creds) throw new Error('Not logged in')
    this.stopped = false
    this.log('Long-poll started')
    let retryMs = 1000

    while (!this.stopped) {
      try {
        this.ctrl = new AbortController()
        const r = await this.post<{
          ret: number; msgs: WireMessage[]; get_updates_buf: string; errcode?: number
        }>(
          `${this.creds.baseUrl}/ilink/bot/getupdates`,
          { get_updates_buf: this.cursor, base_info: baseInfo() },
          this.creds.token, 40000, this.ctrl.signal,
        )
        this.ctrl = null

        if (r.ret !== 0) {
          if (r.errcode === -14) {
            this.log('Session expired — re-login')
            await rm(CRED_PATH, { force: true })
            this.ctxTokens.clear(); this.cursor = ''
            await this.login({ force: true })
            continue
          }
          throw new Error(`getupdates ret=${r.ret}`)
        }

        if (r.get_updates_buf) this.cursor = r.get_updates_buf
        retryMs = 1000

        for (const raw of r.msgs ?? []) {
          const uid = raw.message_type === 1 ? raw.from_user_id : raw.to_user_id
          if (uid && raw.context_token) this.ctxTokens.set(uid, raw.context_token)
          if (raw.message_type !== 1) continue

          const msg = parseMsg(raw)
          for (const h of this.handlers) {
            try { await h(msg) } catch (e) { this.log(`handler error: ${e}`) }
          }
        }
      } catch (e) {
        this.ctrl = null
        if (this.stopped) break
        this.log(`poll error: ${e instanceof Error ? e.message : e}`)
        await sleep(retryMs)
        retryMs = Math.min(retryMs * 2, 10000)
      }
    }
    this.log('Long-poll stopped')
  }

  async send(userId: string, text: string) {
    const ct = this.ctxTokens.get(userId)
    if (!ct) throw new Error(`No context_token for user ${userId}`)
    await this.sendText(userId, text, ct)
  }

  stop() { this.stopped = true; this.ctrl?.abort() }
  getCredentials() { return this.creds }

  private async sendText(userId: string, text: string, ct: string) {
    if (!this.creds) return
    for (let i = 0; i < text.length; i += 2000) {
      const chunk = text.slice(i, i + 2000)
      await this.post(`${this.creds.baseUrl}/ilink/bot/sendmessage`, {
        msg: {
          from_user_id: '', to_user_id: userId, client_id: randomUUID(),
          message_type: 2, message_state: 2, context_token: ct,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        },
        base_info: baseInfo(),
      }, this.creds.token)
    }
  }

  private async get<T>(url: string, h?: Record<string, string>): Promise<T> {
    return (await fetch(url, { headers: h })).json() as Promise<T>
  }

  private async post<T>(url: string, body: unknown, token: string, timeoutMs = 15000, signal?: AbortSignal): Promise<T> {
    const ts = AbortSignal.timeout(timeoutMs)
    const s = signal ? AbortSignal.any([signal, ts]) : ts
    return (await fetch(url, {
      method: 'POST', headers: headers(token), body: JSON.stringify(body), signal: s,
    })).json() as Promise<T>
  }
}

function parseMsg(raw: WireMessage): IncomingMessage {
  let text = '', type: IncomingMessage['type'] = 'text'
  for (const it of raw.item_list ?? []) {
    if (it.type === 1 && it.text_item) text += it.text_item.text
    else if (it.type === 2) { type = 'image'; text += it.image_item?.url ?? '[image]' }
    else if (it.type === 3) { type = 'voice'; text += it.voice_item?.text ?? '[voice]' }
    else if (it.type === 4) { type = 'file'; text += it.file_item?.file_name ?? '[file]' }
    else if (it.type === 5) { type = 'video'; text += '[video]' }
  }
  return { userId: raw.from_user_id, text, type, contextToken: raw.context_token, timestamp: new Date(raw.create_time_ms) }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
