"""Main WeChatBot client — orchestrates all SDK components."""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from .auth import clear_credentials, load_credentials, login
from .errors import ApiError, NoContextError
from .protocol import DEFAULT_BASE_URL, ILinkApi
from .types import (
    CDNMedia,
    Credentials,
    FileContent,
    ImageContent,
    IncomingMessage,
    MessageItemType,
    MessageType,
    QuotedMessage,
    VideoContent,
    VoiceContent,
)

MessageHandler = Callable[[IncomingMessage], Any]


class WeChatBot:
    """WeChat iLink Bot client.

    Usage::

        bot = WeChatBot()
        await bot.login()

        @bot.on_message
        async def handle(msg):
            await bot.send_typing(msg.user_id)
            await bot.reply(msg, f"Echo: {msg.text}")

        await bot.start()
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        cred_path: str | None = None,
        on_qr_url: Callable[[str], None] | None = None,
        on_scanned: Callable[[], None] | None = None,
        on_expired: Callable[[], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
    ) -> None:
        self._base_url = base_url or DEFAULT_BASE_URL
        self._cred_path = Path(cred_path) if cred_path else None
        self._on_qr_url = on_qr_url
        self._on_scanned = on_scanned
        self._on_expired = on_expired
        self._on_error = on_error

        self._api = ILinkApi()
        self._credentials: Credentials | None = None
        self._context_tokens: dict[str, str] = {}
        self._handlers: list[MessageHandler] = []
        self._cursor = ""
        self._stopped = False

    # ── Auth ──────────────────────────────────────────────────────────

    async def login(self, *, force: bool = False) -> Credentials:
        """QR code login. Skips QR if stored credentials exist."""
        creds = await login(
            self._api,
            base_url=self._base_url,
            cred_path=self._cred_path,
            force=force,
            on_qr_url=self._on_qr_url,
            on_scanned=self._on_scanned,
            on_expired=self._on_expired,
        )
        self._credentials = creds
        self._base_url = creds.base_url
        self._log(f"Logged in as {creds.user_id}")
        return creds

    def get_credentials(self) -> Credentials | None:
        return self._credentials

    # ── Message Handlers ──────────────────────────────────────────────

    def on_message(self, handler: MessageHandler) -> MessageHandler:
        """Register a message handler. Can be used as a decorator."""
        self._handlers.append(handler)
        return handler

    # ── Sending ───────────────────────────────────────────────────────

    async def reply(self, msg: IncomingMessage, text: str) -> None:
        """Reply to an incoming message. Auto context_token + auto stop typing."""
        self._context_tokens[msg.user_id] = msg._context_token
        await self._send_text(msg.user_id, text, msg._context_token)
        try:
            await self.stop_typing(msg.user_id)
        except Exception:
            pass

    async def send(self, user_id: str, text: str) -> None:
        """Send text to a user (requires prior context_token)."""
        ct = self._context_tokens.get(user_id)
        if not ct:
            raise NoContextError(user_id)
        await self._send_text(user_id, text, ct)

    async def send_typing(self, user_id: str) -> None:
        """Show 'typing...' indicator."""
        ct = self._context_tokens.get(user_id)
        if not ct:
            return
        creds = self._require_creds()
        config = await self._api.get_config(creds.base_url, creds.token, user_id, ct)
        ticket = config.get("typing_ticket")
        if ticket:
            await self._api.send_typing(creds.base_url, creds.token, user_id, ticket, 1)

    async def stop_typing(self, user_id: str) -> None:
        """Cancel 'typing...' indicator."""
        ct = self._context_tokens.get(user_id)
        if not ct:
            return
        creds = self._require_creds()
        config = await self._api.get_config(creds.base_url, creds.token, user_id, ct)
        ticket = config.get("typing_ticket")
        if ticket:
            await self._api.send_typing(creds.base_url, creds.token, user_id, ticket, 2)

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the long-poll loop. Blocks until stop() is called."""
        creds = self._require_creds()
        self._stopped = False
        self._log("Long-poll started")
        retry_delay = 1.0

        while not self._stopped:
            try:
                creds = self._require_creds()
                updates = await self._api.get_updates(
                    creds.base_url, creds.token, self._cursor
                )

                buf = updates.get("get_updates_buf")
                if buf:
                    self._cursor = buf
                retry_delay = 1.0

                for raw in updates.get("msgs", []):
                    self._remember_context(raw)
                    msg = self._parse_message(raw)
                    if msg:
                        await self._dispatch(msg)

            except ApiError as e:
                if e.is_session_expired:
                    self._log("Session expired — re-login")
                    await clear_credentials(self._cred_path)
                    self._context_tokens.clear()
                    self._cursor = ""
                    try:
                        await self.login(force=True)
                        retry_delay = 1.0
                        continue
                    except Exception as login_err:
                        self._report_error(login_err)
                else:
                    self._report_error(e)

                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 10.0)

            except asyncio.CancelledError:
                break

            except Exception as e:
                if self._stopped:
                    break
                self._report_error(e)
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 10.0)

        self._log("Long-poll stopped")

    def stop(self) -> None:
        """Stop the long-poll loop."""
        self._stopped = True

    def run(self) -> None:
        """Synchronous entry: login + start. Convenience for scripts."""
        asyncio.run(self._run_sync())

    async def _run_sync(self) -> None:
        await self.login()
        await self.start()

    # ── Internal ──────────────────────────────────────────────────────

    async def _send_text(self, user_id: str, text: str, context_token: str) -> None:
        if not text:
            raise ValueError("Message text cannot be empty")
        creds = self._require_creds()
        for chunk in _chunk_text(text, 2000):
            msg = self._api.build_text_message(user_id, context_token, chunk)
            await self._api.send_message(creds.base_url, creds.token, msg)

    def _remember_context(self, raw: dict[str, Any]) -> None:
        mt = raw.get("message_type")
        uid = raw.get("from_user_id") if mt == MessageType.USER else raw.get("to_user_id")
        ct = raw.get("context_token")
        if uid and ct:
            self._context_tokens[uid] = ct

    def _parse_message(self, raw: dict[str, Any]) -> IncomingMessage | None:
        if raw.get("message_type") != MessageType.USER:
            return None

        items = raw.get("item_list", [])
        images, voices, files, videos = [], [], [], []
        quoted = None

        for item in items:
            t = item.get("type")
            if t == MessageItemType.IMAGE and item.get("image_item"):
                ii = item["image_item"]
                media = _parse_cdn_media(ii.get("media"))
                images.append(ImageContent(
                    media=media, thumb_media=_parse_cdn_media(ii.get("thumb_media")),
                    aes_key=ii.get("aeskey"), url=ii.get("url"),
                    width=ii.get("thumb_width"), height=ii.get("thumb_height"),
                ))
            elif t == MessageItemType.VOICE and item.get("voice_item"):
                vi = item["voice_item"]
                voices.append(VoiceContent(
                    media=_parse_cdn_media(vi.get("media")),
                    text=vi.get("text"), duration_ms=vi.get("playtime"),
                    encode_type=vi.get("encode_type"),
                ))
            elif t == MessageItemType.FILE and item.get("file_item"):
                fi = item["file_item"]
                size = None
                if fi.get("len"):
                    try:
                        size = int(fi["len"])
                    except (ValueError, TypeError):
                        pass
                files.append(FileContent(
                    media=_parse_cdn_media(fi.get("media")),
                    file_name=fi.get("file_name"), md5=fi.get("md5"), size=size,
                ))
            elif t == MessageItemType.VIDEO and item.get("video_item"):
                vi = item["video_item"]
                videos.append(VideoContent(
                    media=_parse_cdn_media(vi.get("media")),
                    thumb_media=_parse_cdn_media(vi.get("thumb_media")),
                    duration_ms=vi.get("play_length"),
                ))
            if item.get("ref_msg"):
                ref = item["ref_msg"]
                qt = ref.get("message_item", {}).get("text_item", {}).get("text")
                quoted = QuotedMessage(title=ref.get("title"), text=qt)

        return IncomingMessage(
            user_id=raw["from_user_id"],
            text=_extract_text(items),
            type=_detect_type(items),
            timestamp=datetime.fromtimestamp(
                raw.get("create_time_ms", 0) / 1000, tz=timezone.utc
            ),
            images=images, voices=voices, files=files, videos=videos,
            quoted_message=quoted, raw=raw,
            _context_token=raw.get("context_token", ""),
        )

    async def _dispatch(self, msg: IncomingMessage) -> None:
        for handler in self._handlers:
            try:
                result = handler(msg)
                if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                    await result
            except Exception as e:
                self._report_error(e)

    def _require_creds(self) -> Credentials:
        if not self._credentials:
            raise RuntimeError("Not logged in. Call login() first.")
        return self._credentials

    def _report_error(self, err: Any) -> None:
        self._log(str(err))
        if self._on_error and isinstance(err, Exception):
            self._on_error(err)

    def _log(self, msg: str) -> None:
        print(f"[wechatbot] {msg}", file=sys.stderr)


def _detect_type(items: list[dict[str, Any]]) -> str:
    if not items:
        return "text"
    t = items[0].get("type")
    return {
        MessageItemType.IMAGE: "image",
        MessageItemType.VOICE: "voice",
        MessageItemType.FILE: "file",
        MessageItemType.VIDEO: "video",
    }.get(t, "text")


def _extract_text(items: list[dict[str, Any]]) -> str:
    parts = []
    for item in items:
        t = item.get("type")
        if t == MessageItemType.TEXT:
            parts.append(item.get("text_item", {}).get("text", ""))
        elif t == MessageItemType.IMAGE:
            parts.append(item.get("image_item", {}).get("url", "[image]"))
        elif t == MessageItemType.VOICE:
            parts.append(item.get("voice_item", {}).get("text", "[voice]"))
        elif t == MessageItemType.FILE:
            parts.append(item.get("file_item", {}).get("file_name", "[file]"))
        elif t == MessageItemType.VIDEO:
            parts.append("[video]")
    return "\n".join(p for p in parts if p)


def _chunk_text(text: str, limit: int) -> list[str]:
    if len(text) <= limit:
        return [text]
    chunks = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break
        window = text[:limit]
        cut = -1
        idx = window.rfind("\n\n")
        if idx > limit * 3 // 10:
            cut = idx + 2
        if cut == -1:
            idx = window.rfind("\n")
            if idx > limit * 3 // 10:
                cut = idx + 1
        if cut == -1:
            idx = window.rfind(" ")
            if idx > limit * 3 // 10:
                cut = idx + 1
        if cut == -1:
            cut = limit
        chunks.append(text[:cut])
        text = text[cut:]
    return chunks or [""]


def _parse_cdn_media(data: dict[str, Any] | None) -> CDNMedia | None:
    if not data:
        return None
    return CDNMedia(
        encrypt_query_param=data.get("encrypt_query_param", ""),
        aes_key=data.get("aes_key", ""),
        encrypt_type=data.get("encrypt_type"),
    )
