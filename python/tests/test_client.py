"""Tests for client utilities."""

from wechatbot.client import _chunk_text, _detect_type, _extract_text


def test_chunk_short():
    assert _chunk_text("hello", 2000) == ["hello"]


def test_chunk_empty():
    assert _chunk_text("", 2000) == [""]


def test_chunk_at_paragraph():
    text = "A" * 1500 + "\n\n" + "B" * 1000
    chunks = _chunk_text(text, 2000)
    assert len(chunks) == 2
    assert chunks[0] == "A" * 1500 + "\n\n"


def test_chunk_hard_cut():
    text = "A" * 5000
    chunks = _chunk_text(text, 2000)
    assert len(chunks) == 3
    assert "".join(chunks) == text


def test_detect_type_text():
    assert _detect_type([{"type": 1}]) == "text"


def test_detect_type_image():
    assert _detect_type([{"type": 2}]) == "image"


def test_detect_type_empty():
    assert _detect_type([]) == "text"


def test_extract_text():
    items = [
        {"type": 1, "text_item": {"text": "Hello"}},
        {"type": 2, "image_item": {"url": "https://img.com/1.jpg"}},
    ]
    result = _extract_text(items)
    assert result == "Hello\nhttps://img.com/1.jpg"
