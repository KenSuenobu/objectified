"""A minimal DNS client for custom-domain ownership checks — Slate 10.1 (private-suite#119).

Verifying a custom domain means reading the tenant's public DNS. The stdlib cannot: ``socket``
resolves names to addresses through the system resolver and discards the CNAME chain and every
TXT record on the way, which are precisely the two things a verification check needs. Rather than
add a DNS dependency for two record types, this module speaks the wire format directly — a query
is 12 bytes of header plus a name, and an answer is a list of records with one compression scheme.

The whole thing is behind :class:`DnsResolver`, so the service can be tested against recorded
packets and fixed answers with no network at all. :class:`SystemDnsResolver` is the live
implementation; :func:`parse_response` and :func:`build_query` are pure and are what the tests
actually pin, because a codec proven only through a socket is a codec proven only when the network
is up.

**Deliberate limits.** UDP only, no EDNS0, no DNSSEC validation, no recursion of its own — it asks
a configured recursive resolver and reads the answer. That is sufficient and honest for the job:
ownership is proven by a record the tenant published being visible from here, and a check that
cannot see it fails closed with the reason. Answers are never cached, because a cached "verified"
would outlive the record that justified it.
"""

from __future__ import annotations

import os
import re
import secrets
import socket
import struct
from dataclasses import dataclass, field
from typing import List, Optional, Protocol, Sequence, Tuple

__all__ = [
    "DEFAULT_NAMESERVERS",
    "DnsAnswer",
    "DnsError",
    "DnsResolver",
    "StaticDnsResolver",
    "SystemDnsResolver",
    "TYPE_A",
    "TYPE_CNAME",
    "TYPE_TXT",
    "build_query",
    "parse_response",
    "system_nameservers",
]

#: Resource-record types this module reads. Everything else in an answer is skipped.
TYPE_A = 1
TYPE_CNAME = 5
TYPE_TXT = 16

#: Class IN.
_CLASS_IN = 1

#: Recursion-desired flag in the header.
_FLAG_RD = 0x0100

#: Answer is truncated and should be retried over TCP. Reported rather than silently accepted.
_FLAG_TC = 0x0200

#: Public recursive resolvers used when the host has no usable ``resolv.conf``. Two operators so a
#: single provider's outage cannot make every tenant's domain look unverified.
DEFAULT_NAMESERVERS = ("1.1.1.1", "8.8.8.8")

#: RCODEs worth naming; anything else is reported by number.
_RCODE_NAMES = {
    0: "NOERROR",
    1: "FORMERR",
    2: "SERVFAIL",
    3: "NXDOMAIN",
    4: "NOTIMP",
    5: "REFUSED",
}


class DnsError(Exception):
    """A DNS query could not be completed, or its answer could not be read.

    Attributes:
        code: Stable reason — ``timeout``, ``truncated``, ``malformed``, ``no-nameserver``, or the
            server's RCODE name (``SERVFAIL``, ``REFUSED``, …). ``NXDOMAIN`` is *not* an error; a
            name that does not exist is an empty answer, which is a legitimate check result.
        message: An operator-facing sentence.
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class DnsAnswer:
    """The records a query returned.

    Attributes:
        cname: The first CNAME target in the answer, or None. Trailing dot removed and lowercased,
            so it compares directly against a normalized hostname.
        txt: Every TXT record's assembled value. A TXT record is a sequence of length-prefixed
            strings, which providers split at 255 characters; they are joined back together here
            because the tenant published one value, not three.
        addresses: Any A records in the answer, in wire order.
        rcode: The response code, so a caller can distinguish "no such name" from "no such record".
    """

    cname: Optional[str] = None
    txt: Tuple[str, ...] = ()
    addresses: Tuple[str, ...] = ()
    rcode: int = 0
    #: Every name traversed while following the answer's CNAME chain, for diagnostics.
    chain: Tuple[str, ...] = field(default=())


class DnsResolver(Protocol):
    """The DNS surface the domain service depends on.

    One method, so a test double is three lines and the service never reaches a socket by
    accident.
    """

    def query(self, name: str, record_type: int) -> DnsAnswer:
        """Resolve ``name`` for ``record_type``.

        Args:
            name: The fully-qualified name to look up.
            record_type: One of :data:`TYPE_A`, :data:`TYPE_CNAME`, :data:`TYPE_TXT`.

        Returns:
            The answer, possibly empty.

        Raises:
            DnsError: When the query could not be completed.
        """
        ...


# ─── Wire format ─────────────────────────────────────────────────────────────


def _encode_name(name: str) -> bytes:
    """Encode a domain name as length-prefixed labels terminated by a zero byte.

    Args:
        name: The name, with or without a trailing dot.

    Returns:
        The wire encoding.

    Raises:
        DnsError: ``malformed`` when a label is empty or longer than 63 bytes.
    """
    encoded = bytearray()
    for label in name.rstrip(".").split("."):
        raw = label.encode("ascii", errors="strict") if label.isascii() else label.encode("idna")
        if not raw or len(raw) > 63:
            raise DnsError("malformed", f"'{label}' is not a DNS label that can be queried.")
        encoded.append(len(raw))
        encoded.extend(raw)
    encoded.append(0)
    return bytes(encoded)


def build_query(name: str, record_type: int, *, transaction_id: Optional[int] = None) -> bytes:
    """Build a recursion-desired query for one name and type.

    Args:
        name: The fully-qualified name.
        record_type: The record type to ask for.
        transaction_id: Fixed id, for tests. A random one is generated otherwise — it is the only
            thing making an off-path spoofed answer harder, so it is not a counter.

    Returns:
        The complete query datagram.
    """
    ident = transaction_id if transaction_id is not None else secrets.randbelow(0x10000)
    header = struct.pack("!HHHHHH", ident, _FLAG_RD, 1, 0, 0, 0)
    question = _encode_name(name) + struct.pack("!HH", record_type, _CLASS_IN)
    return header + question


def _read_name(data: bytes, offset: int, *, depth: int = 0) -> Tuple[str, int]:
    """Read a possibly-compressed name, returning it and the offset after it.

    Args:
        data: The whole datagram (compression pointers are absolute within it).
        offset: Where the name starts.
        depth: Pointer-following depth, bounded so a self-referential pointer cannot hang the
            process — a malicious or broken resolver must not be able to make a verification check
            spin forever.

    Returns:
        ``(name, next_offset)``. ``next_offset`` is the position after the name *as written here*,
        which for a compressed name is two bytes on, not the end of what it pointed at.

    Raises:
        DnsError: ``malformed`` on a truncated name or a pointer loop.
    """
    if depth > 16:
        raise DnsError("malformed", "The DNS answer contains a compression-pointer loop.")

    labels: List[str] = []
    cursor = offset
    while True:
        if cursor >= len(data):
            raise DnsError("malformed", "The DNS answer ended inside a name.")
        length = data[cursor]
        if length == 0:
            return ".".join(labels), cursor + 1
        if length & 0xC0 == 0xC0:
            if cursor + 1 >= len(data):
                raise DnsError("malformed", "The DNS answer ended inside a compression pointer.")
            pointer = ((length & 0x3F) << 8) | data[cursor + 1]
            suffix, _ = _read_name(data, pointer, depth=depth + 1)
            if suffix:
                labels.append(suffix)
            return ".".join(labels), cursor + 2
        cursor += 1
        if cursor + length > len(data):
            raise DnsError("malformed", "The DNS answer ended inside a label.")
        labels.append(data[cursor : cursor + length].decode("ascii", errors="replace"))
        cursor += length


def parse_response(data: bytes, *, expected_id: Optional[int] = None) -> DnsAnswer:
    """Read an answer datagram into a :class:`DnsAnswer`.

    Args:
        data: The response bytes.
        expected_id: The transaction id that was sent. A mismatch is refused rather than parsed,
            because accepting an answer to a question we did not ask is how a check gets spoofed.

    Returns:
        The records found. An ``NXDOMAIN`` is returned as an empty answer with its rcode, not
        raised: "that name does not exist" is a verification result, not a failure to check.

    Raises:
        DnsError: ``malformed`` on a short or unreadable datagram, ``truncated`` when the server
            set TC, or the RCODE name for a server-side failure.
    """
    if len(data) < 12:
        raise DnsError("malformed", "The DNS answer was too short to contain a header.")

    ident, flags, qdcount, ancount, _nscount, _arcount = struct.unpack("!HHHHHH", data[:12])
    if expected_id is not None and ident != expected_id:
        raise DnsError("malformed", "The DNS answer did not match the query that was sent.")
    if flags & _FLAG_TC:
        raise DnsError(
            "truncated",
            "The DNS answer was too large for UDP. Retry the check, or reduce the number of "
            "records at that name.",
        )

    rcode = flags & 0x0F
    if rcode not in (0, 3):  # NOERROR / NXDOMAIN
        name = _RCODE_NAMES.get(rcode, f"RCODE{rcode}")
        raise DnsError(name, f"The nameserver answered {name}. Retry the check in a moment.")

    offset = 12
    for _ in range(qdcount):
        _, offset = _read_name(data, offset)
        offset += 4  # qtype + qclass

    cname: Optional[str] = None
    chain: List[str] = []
    txt: List[str] = []
    addresses: List[str] = []

    for _ in range(ancount):
        owner, offset = _read_name(data, offset)
        if offset + 10 > len(data):
            raise DnsError("malformed", "The DNS answer ended inside a record header.")
        rtype, _rclass, _ttl, rdlength = struct.unpack("!HHIH", data[offset : offset + 10])
        offset += 10
        if offset + rdlength > len(data):
            raise DnsError("malformed", "The DNS answer ended inside record data.")
        rdata = data[offset : offset + rdlength]

        if rtype == TYPE_CNAME:
            target, _ = _read_name(data, offset)
            chain.append(owner.lower())
            if cname is None:
                cname = target.rstrip(".").lower()
        elif rtype == TYPE_TXT:
            parts: List[str] = []
            cursor = 0
            while cursor < len(rdata):
                length = rdata[cursor]
                cursor += 1
                parts.append(rdata[cursor : cursor + length].decode("utf-8", errors="replace"))
                cursor += length
            txt.append("".join(parts))
        elif rtype == TYPE_A and rdlength == 4:
            addresses.append(".".join(str(byte) for byte in rdata))

        offset += rdlength

    return DnsAnswer(
        cname=cname,
        txt=tuple(txt),
        addresses=tuple(addresses),
        rcode=rcode,
        chain=tuple(chain),
    )


# ─── Resolvers ───────────────────────────────────────────────────────────────


def system_nameservers(resolv_conf: str = "/etc/resolv.conf") -> Tuple[str, ...]:
    """Read the host's configured recursive resolvers.

    Args:
        resolv_conf: Path to read. Overridable so the parse is testable.

    Returns:
        The nameserver addresses, falling back to :data:`DEFAULT_NAMESERVERS` when the file is
        absent, unreadable, or lists only loopback stubs. A container's ``127.0.0.11`` is a stub
        that may or may not be reachable from where this code runs, so a public resolver is a
        better default than a check that fails for infrastructure reasons and reads as "the tenant
        has not published the record".
    """
    override = (os.environ.get("APIOME_SLATE_DNS_NAMESERVERS") or "").strip()
    if override:
        servers = tuple(part.strip() for part in override.split(",") if part.strip())
        if servers:
            return servers

    try:
        with open(resolv_conf, "r", encoding="utf-8") as handle:
            content = handle.read()
    except OSError:
        return DEFAULT_NAMESERVERS

    found = [
        match.group(1)
        for match in re.finditer(r"^\s*nameserver\s+(\S+)", content, flags=re.MULTILINE)
    ]
    routable = [server for server in found if not server.startswith("127.") and server != "::1"]
    return tuple(routable) if routable else DEFAULT_NAMESERVERS


class SystemDnsResolver:
    """Queries a recursive resolver over UDP.

    Args:
        nameservers: Servers to ask, in order. Read from the host when omitted.
        timeout: Per-server timeout in seconds. Short on purpose: verification runs inside a
            request a person is waiting on, and a slow answer is worth less than a prompt
            "could not check, try again".
        port: Server port; 53 outside tests.
    """

    def __init__(
        self,
        nameservers: Optional[Sequence[str]] = None,
        *,
        timeout: float = 3.0,
        port: int = 53,
    ) -> None:
        self._nameservers = tuple(nameservers) if nameservers else system_nameservers()
        self._timeout = timeout
        self._port = port

    def query(self, name: str, record_type: int) -> DnsAnswer:
        """Ask each configured nameserver in turn until one answers.

        Args:
            name: The fully-qualified name.
            record_type: The record type.

        Returns:
            The first usable answer.

        Raises:
            DnsError: ``no-nameserver`` when none is configured, or the last server's failure when
                every server failed.
        """
        if not self._nameservers:
            raise DnsError(
                "no-nameserver",
                "No DNS resolver is configured on this host, so domain ownership cannot be "
                "checked. Set APIOME_SLATE_DNS_NAMESERVERS.",
            )

        transaction_id = secrets.randbelow(0x10000)
        packet = build_query(name, record_type, transaction_id=transaction_id)
        last: DnsError = DnsError("timeout", "No nameserver answered.")

        for server in self._nameservers:
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.settimeout(self._timeout)
                    sock.sendto(packet, (server, self._port))
                    data, _ = sock.recvfrom(4096)
                return parse_response(data, expected_id=transaction_id)
            except socket.timeout:
                last = DnsError(
                    "timeout", f"The nameserver {server} did not answer within {self._timeout:g}s."
                )
            except OSError as exc:
                last = DnsError("timeout", f"The nameserver {server} could not be reached: {exc}.")
            except DnsError as exc:
                last = exc

        raise last


class StaticDnsResolver:
    """A resolver that answers from a supplied table.

    Not a test-only convenience: it is also how a deployment pins a check to a known answer while
    diagnosing a resolver problem. Anything absent from the table answers NXDOMAIN, which is what
    an unpublished record looks like.

    Args:
        answers: ``{(name, record_type): DnsAnswer}``. Names are matched case-insensitively with
            any trailing dot removed.
    """

    def __init__(self, answers: Optional[dict] = None) -> None:
        self._answers = {
            (str(name).rstrip(".").lower(), rtype): answer
            for (name, rtype), answer in (answers or {}).items()
        }

    def query(self, name: str, record_type: int) -> DnsAnswer:
        """Return the configured answer for ``name``/``record_type``.

        Args:
            name: The fully-qualified name.
            record_type: The record type.

        Returns:
            The configured answer, or an empty NXDOMAIN answer.
        """
        key = (name.rstrip(".").lower(), record_type)
        return self._answers.get(key, DnsAnswer(rcode=3))
