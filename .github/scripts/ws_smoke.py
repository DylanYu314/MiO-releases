#!/usr/bin/env python3
"""Assert that Caddy proxies a WebSocket upgrade through to the API.

Standard library only, because this runs on a bare CI runner against a
container stack — installing a client library to test the deployment would add
a moving part to the thing whose whole point is to have none.

## Why this is not `curl`

It used to be. `curl` cannot speak WebSocket over an `Upgrade:` header, so the
old check sent the handshake by hand and inferred success from `%{http_code}`
being 101, relying on the server dropping the TCP connection to make `curl`
exit. That held until **uvicorn 0.52.1** (2026-08-01), which fixed
`websocket.close` to perform the RFC 6455 *closing handshake* — send a close
frame, then wait up to ten seconds for the peer to echo it — instead of
closing the transport outright. `curl` never echoes, because it never
understood it was in a WebSocket. So the connection stayed open, `--max-time
10` fired first and the step died with exit 28 on unchanged code (#285).

The lesson is the one that keeps recurring here: a fake client validates the
fake. This speaks enough of the protocol to be a real one, so it asserts what
production actually does and cannot be broken by teardown timing again.
"""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
import sys

HOST = os.environ.get("MIO_SMOKE_HOST", "localhost")
PORT = int(os.environ.get("MIO_SMOKE_PORT", "443"))
PATH = os.environ.get("MIO_SMOKE_PATH", "/api/jobs/1/ws")
USE_TLS = os.environ.get("MIO_SMOKE_TLS", "1") != "0"

# Job 1 cannot exist in a stack that has just booted with an empty database, so
# the endpoint accepts the socket and then closes it with this application code
# (WS_CLOSE_JOB_NOT_FOUND in backend/app/routers/jobs.py). Asserting on it
# proves more than the upgrade: the accept, the app-level close and its reason
# all made it back through the proxy.
EXPECT_CLOSE_CODE = 4004

# RFC 6455 §1.3. Concatenated with the client key to derive the server's accept.
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

TIMEOUT_SECONDS = 15.0


def fail(message: str) -> None:
    print(f"  FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def connect() -> socket.socket:
    sock = socket.create_connection((HOST, PORT), timeout=TIMEOUT_SECONDS)
    if USE_TLS:
        # The local stack runs MIO_DOMAIN=localhost, so Caddy issues from its
        # own internal CA and there is no chain to verify against. Equivalent to
        # the `-k` the curl version passed.
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        sock = context.wrap_socket(sock, server_hostname=HOST)
    sock.settimeout(TIMEOUT_SECONDS)
    return sock


def read_until_headers_end(sock: socket.socket) -> tuple[bytes, bytes]:
    """Read the HTTP response head, returning (head, bytes already read past it)."""
    buffer = b""
    while b"\r\n\r\n" not in buffer:
        chunk = sock.recv(4096)
        if not chunk:
            fail(f"connection closed during the handshake after {len(buffer)} bytes")
        buffer += chunk
    head, _, rest = buffer.partition(b"\r\n\r\n")
    return head, rest


def recv_exactly(sock: socket.socket, count: int, buffered: bytes) -> tuple[bytes, bytes]:
    """Return exactly `count` bytes, drawing on `buffered` first."""
    while len(buffered) < count:
        chunk = sock.recv(4096)
        if not chunk:
            fail(f"connection closed mid-frame: wanted {count} bytes, got {len(buffered)}")
        buffered += chunk
    return buffered[:count], buffered[count:]


def main() -> None:
    key = base64.b64encode(os.urandom(16)).decode()
    expected_accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()

    sock = connect()
    request = (
        f"GET {PATH} HTTP/1.1\r\n"
        f"Host: {HOST}\r\n"
        "Connection: Upgrade\r\n"
        "Upgrade: websocket\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "\r\n"
    )
    sock.sendall(request.encode())

    head, rest = read_until_headers_end(sock)
    status_line = head.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 101" not in status_line:
        fail(f"expected a 101 upgrade through Caddy, got: {status_line}")

    # A proxy that forwards the status but mangles the handshake would pass a
    # status-only check and break every real client.
    headers = head.decode(errors="replace").lower()
    if f"sec-websocket-accept: {expected_accept.lower()}" not in headers:
        fail("the Sec-WebSocket-Accept header is missing or does not match the key we sent")
    print(f"  {status_line} — handshake verified")

    # The server should now send its close frame: FIN + opcode 8, unmasked
    # (servers never mask), with a 2-byte code and a UTF-8 reason.
    header, rest = recv_exactly(sock, 2, rest)
    fin_opcode, length_byte = header[0], header[1]
    if fin_opcode != 0x88:
        fail(f"expected a close frame (0x88), got first byte 0x{fin_opcode:02x}")
    length = length_byte & 0x7F
    if length > 125:
        fail(f"a close frame's payload must be 125 bytes or fewer, got {length}")
    payload, _ = recv_exactly(sock, length, rest)
    code = struct.unpack("!H", payload[:2])[0] if length >= 2 else None
    reason = payload[2:].decode(errors="replace")
    if code != EXPECT_CLOSE_CODE:
        fail(f"expected close code {EXPECT_CLOSE_CODE} for a job that does not exist, got {code}")
    print(f"  close frame {code} {reason!r} — the app's own close survived the proxy")

    # Echo the close so the handshake completes and the server tears down at
    # once rather than sitting on its ten-second timer. Client frames are
    # masked (RFC 6455 §5.3).
    mask = os.urandom(4)
    body = struct.pack("!H", EXPECT_CLOSE_CODE)
    masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(body))
    sock.sendall(bytes([0x88, 0x80 | len(body)]) + mask + masked)
    sock.close()


if __name__ == "__main__":
    try:
        main()
    except TimeoutError:
        # The failure this check exists to catch is a hang, so it is the one
        # that must not arrive as a traceback: say which stage stalled.
        fail(
            f"timed out after {TIMEOUT_SECONDS:.0f}s waiting on {HOST}:{PORT}{PATH} — "
            "the upgrade or the close frame never arrived"
        )
    except OSError as exc:
        fail(f"could not talk to {HOST}:{PORT}: {exc}")
