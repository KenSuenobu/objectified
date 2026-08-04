"""The DNS client behind ownership verification — Slate 10.1 (private-suite#119).

Unit tests over :mod:`app.slate_dns`. No socket is opened: the codec is pure, so the tests build
answer packets byte by byte and read them back. That is the point of writing the wire format out
rather than depending on a resolver library — a codec proven only through a live query is a codec
proven only while the network is up.

The cases that matter are the ones a real nameserver produces and a naive parser gets wrong:
compression pointers (universal in CNAME answers), TXT records split into 255-byte chunks by the
provider, NXDOMAIN as an *answer* rather than an error, and a transaction id that does not match
the question we asked.
"""

from __future__ import annotations

import struct

import pytest

from app.slate_dns import (
    DEFAULT_NAMESERVERS,
    TYPE_A,
    TYPE_CNAME,
    TYPE_TXT,
    DnsAnswer,
    DnsError,
    StaticDnsResolver,
    build_query,
    parse_response,
    system_nameservers,
)


def _name(value: str) -> bytes:
    """Encode a domain name as length-prefixed labels plus the root terminator."""
    out = bytearray()
    for label in value.rstrip(".").split("."):
        out.append(len(label))
        out.extend(label.encode("ascii"))
    out.append(0)
    return bytes(out)


def _packet(
    *,
    question: str,
    qtype: int,
    answers: list,
    transaction_id: int = 0x1234,
    flags: int = 0x8180,
) -> bytes:
    """Assemble a response datagram from ``(name, type, rdata)`` answer triples."""
    header = struct.pack("!HHHHHH", transaction_id, flags, 1, len(answers), 0, 0)
    body = _name(question) + struct.pack("!HH", qtype, 1)
    for owner, rtype, rdata in answers:
        body += _name(owner) + struct.pack("!HHIH", rtype, 1, 300, len(rdata)) + rdata
    return header + body


def _txt_rdata(*strings: str) -> bytes:
    """Encode TXT record data as the sequence of length-prefixed strings DNS actually carries."""
    out = bytearray()
    for value in strings:
        raw = value.encode("utf-8")
        out.append(len(raw))
        out.extend(raw)
    return bytes(out)


class TestBuildQuery:
    """What goes on the wire."""

    def test_a_query_asks_one_question_with_recursion_desired(self) -> None:
        packet = build_query("payments-docs.acme.io", TYPE_CNAME, transaction_id=0x2A2A)
        ident, flags, qdcount, ancount, _, _ = struct.unpack("!HHHHHH", packet[:12])
        assert ident == 0x2A2A
        assert flags == 0x0100  # RD
        assert (qdcount, ancount) == (1, 0)

    def test_the_question_carries_the_name_type_and_class(self) -> None:
        packet = build_query("acme.io", TYPE_TXT, transaction_id=1)
        assert packet[12:] == _name("acme.io") + struct.pack("!HH", TYPE_TXT, 1)

    def test_a_trailing_dot_does_not_produce_an_empty_label(self) -> None:
        assert build_query("acme.io.", TYPE_A, transaction_id=1) == build_query(
            "acme.io", TYPE_A, transaction_id=1
        )

    def test_an_unqueryable_label_is_refused_rather_than_sent(self) -> None:
        with pytest.raises(DnsError) as exc:
            build_query("a" * 64 + ".acme.io", TYPE_A)
        assert exc.value.code == "malformed"

    def test_two_queries_for_the_same_name_use_different_transaction_ids(self) -> None:
        # The id is the only thing making an off-path spoofed answer harder, so it must not be a
        # constant. Sampling a handful is enough to catch a counter or a fixed value.
        ids = {struct.unpack("!H", build_query("acme.io", TYPE_A)[:2])[0] for _ in range(24)}
        assert len(ids) > 1


class TestParseResponse:
    """What comes back, including the shapes a naive parser mishandles."""

    def test_a_cname_answer_is_read_lowercased_without_its_trailing_dot(self) -> None:
        packet = _packet(
            question="payments-docs.acme.io",
            qtype=TYPE_CNAME,
            answers=[("payments-docs.acme.io", TYPE_CNAME, _name("Sites.Apiome.App"))],
        )
        answer = parse_response(packet, expected_id=0x1234)
        assert answer.cname == "sites.apiome.app"

    def test_a_compressed_cname_target_resolves_through_its_pointer(self) -> None:
        # Real answers point back into the question section rather than repeating the zone.
        question = _name("docs.acme.io")
        header = struct.pack("!HHHHHH", 0x1234, 0x8180, 1, 1, 0, 0)
        body = question + struct.pack("!HH", TYPE_CNAME, 1)
        # "sites" + a pointer to offset 17, which is "acme.io" inside the question.
        zone_offset = 12 + 1 + len("docs")
        rdata = b"\x05sites" + struct.pack("!H", 0xC000 | zone_offset)
        body += _name("docs.acme.io") + struct.pack("!HHIH", TYPE_CNAME, 1, 300, len(rdata)) + rdata
        answer = parse_response(header + body, expected_id=0x1234)
        assert answer.cname == "sites.acme.io"

    def test_a_txt_record_split_into_chunks_is_rejoined(self) -> None:
        packet = _packet(
            question="_apiome-challenge.acme.io",
            qtype=TYPE_TXT,
            answers=[
                (
                    "_apiome-challenge.acme.io",
                    TYPE_TXT,
                    _txt_rdata("apiome-domain-verification=", "abc123"),
                )
            ],
        )
        answer = parse_response(packet, expected_id=0x1234)
        assert answer.txt == ("apiome-domain-verification=abc123",)

    def test_every_txt_record_at_a_name_is_returned(self) -> None:
        packet = _packet(
            question="acme.io",
            qtype=TYPE_TXT,
            answers=[
                ("acme.io", TYPE_TXT, _txt_rdata("v=spf1 -all")),
                ("acme.io", TYPE_TXT, _txt_rdata("apiome-domain-verification=abc")),
            ],
        )
        answer = parse_response(packet, expected_id=0x1234)
        assert answer.txt == ("v=spf1 -all", "apiome-domain-verification=abc")

    def test_a_records_are_read_as_dotted_quads(self) -> None:
        packet = _packet(
            question="acme.io",
            qtype=TYPE_A,
            answers=[("acme.io", TYPE_A, bytes([203, 0, 113, 10]))],
        )
        assert parse_response(packet, expected_id=0x1234).addresses == ("203.0.113.10",)

    def test_record_types_that_were_not_asked_for_are_skipped_not_misread(self) -> None:
        packet = _packet(
            question="acme.io",
            qtype=TYPE_CNAME,
            answers=[
                ("acme.io", 15, b"\x00\x0a" + _name("mail.acme.io")),  # MX
                ("acme.io", TYPE_CNAME, _name("sites.apiome.app")),
            ],
        )
        assert parse_response(packet, expected_id=0x1234).cname == "sites.apiome.app"

    def test_nxdomain_is_an_empty_answer_not_an_exception(self) -> None:
        packet = _packet(question="nope.acme.io", qtype=TYPE_CNAME, answers=[], flags=0x8183)
        answer = parse_response(packet, expected_id=0x1234)
        assert answer.rcode == 3
        assert answer.cname is None
        assert answer.txt == ()

    def test_a_server_failure_is_raised_under_its_rcode_name(self) -> None:
        packet = _packet(question="acme.io", qtype=TYPE_A, answers=[], flags=0x8182)
        with pytest.raises(DnsError) as exc:
            parse_response(packet, expected_id=0x1234)
        assert exc.value.code == "SERVFAIL"

    def test_a_truncated_answer_is_refused_rather_than_read_partially(self) -> None:
        packet = _packet(question="acme.io", qtype=TYPE_TXT, answers=[], flags=0x8380)
        with pytest.raises(DnsError) as exc:
            parse_response(packet, expected_id=0x1234)
        assert exc.value.code == "truncated"

    def test_an_answer_to_a_different_question_is_refused(self) -> None:
        packet = _packet(question="acme.io", qtype=TYPE_A, answers=[], transaction_id=0x0001)
        with pytest.raises(DnsError) as exc:
            parse_response(packet, expected_id=0x1234)
        assert exc.value.code == "malformed"

    def test_a_datagram_too_short_for_a_header_is_refused(self) -> None:
        with pytest.raises(DnsError) as exc:
            parse_response(b"\x00\x01")
        assert exc.value.code == "malformed"

    def test_a_record_claiming_more_data_than_it_carries_is_refused(self) -> None:
        header = struct.pack("!HHHHHH", 0x1234, 0x8180, 1, 1, 0, 0)
        body = _name("acme.io") + struct.pack("!HH", TYPE_A, 1)
        body += _name("acme.io") + struct.pack("!HHIH", TYPE_A, 1, 300, 240) + b"\x00\x00"
        with pytest.raises(DnsError) as exc:
            parse_response(header + body, expected_id=0x1234)
        assert exc.value.code == "malformed"

    def test_a_self_referential_compression_pointer_cannot_hang_the_parser(self) -> None:
        # A pointer at offset 12 pointing at offset 12. Without a depth bound this recurses until
        # the interpreter gives up — inside a request a person is waiting on.
        header = struct.pack("!HHHHHH", 0x1234, 0x8180, 1, 0, 0, 0)
        body = struct.pack("!H", 0xC00C) + struct.pack("!HH", TYPE_A, 1)
        with pytest.raises(DnsError) as exc:
            parse_response(header + body, expected_id=0x1234)
        assert exc.value.code == "malformed"


class TestSystemNameservers:
    """Where queries are sent when nothing overrides it."""

    def test_configured_resolvers_are_read_from_the_file(self, tmp_path) -> None:
        path = tmp_path / "resolv.conf"
        path.write_text("# comment\nnameserver 203.0.113.53\nnameserver 198.51.100.53\nsearch x\n")
        assert system_nameservers(str(path)) == ("203.0.113.53", "198.51.100.53")

    def test_a_missing_file_falls_back_to_public_resolvers(self, tmp_path) -> None:
        assert system_nameservers(str(tmp_path / "absent")) == DEFAULT_NAMESERVERS

    def test_a_loopback_only_stub_falls_back_rather_than_failing_every_check(self, tmp_path) -> None:
        # A container's 127.0.0.11 stub may not be reachable from where this runs, and a check that
        # fails for infrastructure reasons reads to a tenant as "you have not published the record".
        path = tmp_path / "resolv.conf"
        path.write_text("nameserver 127.0.0.11\n")
        assert system_nameservers(str(path)) == DEFAULT_NAMESERVERS

    def test_an_environment_override_wins(self, tmp_path, monkeypatch) -> None:
        path = tmp_path / "resolv.conf"
        path.write_text("nameserver 203.0.113.53\n")
        monkeypatch.setenv("APIOME_SLATE_DNS_NAMESERVERS", "9.9.9.9, 149.112.112.112")
        assert system_nameservers(str(path)) == ("9.9.9.9", "149.112.112.112")


class TestStaticDnsResolver:
    """The seam the service is tested through, and the pin an operator can apply."""

    def test_it_answers_from_its_table_case_insensitively(self) -> None:
        resolver = StaticDnsResolver(
            {("Payments-Docs.acme.io.", TYPE_CNAME): DnsAnswer(cname="sites.apiome.app")}
        )
        assert resolver.query("payments-docs.acme.io", TYPE_CNAME).cname == "sites.apiome.app"

    def test_an_absent_name_answers_nxdomain_like_an_unpublished_record(self) -> None:
        answer = StaticDnsResolver().query("acme.io", TYPE_TXT)
        assert answer.rcode == 3
        assert answer.txt == ()
