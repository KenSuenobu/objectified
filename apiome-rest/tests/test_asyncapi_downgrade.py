"""AsyncAPI 3.1 → 2.6 downgrade projection tests — FMT-3.2 (#5427).

Exercises :mod:`app.asyncapi_downgrade`, the projection that gives the AsyncAPI target
the 2.x output its importer has always been able to read. The acceptance criteria
proven here (the ones that do not need the Node parser — validation and the end-to-end
round trip live in ``test_asyncapi_emitter.py`` and ``test_asyncapi_roundtrip.py``):

* **the 2.x object model, not a dialect** — channels are re-keyed by address and carry
  their own ``publish``/``subscribe`` operation, the channel's messages move onto that
  operation, and a server's ``host``/``pathname`` split is recombined into one ``url``;
* **3.x-only constructs are reported as losses with named reasons** — an operation
  ``reply``, a second operation of the same action on one channel, two channels sharing
  an address, a channel named apart from its address, and each 3.x-only object key the
  closed 2.6 object model has no field for;
* the projection is **pure and deterministic** — the input document is not mutated and
  two runs produce identical output and loss lists.
"""

import copy

from app.asyncapi_downgrade import ASYNCAPI_26_VERSION, downgrade_to_asyncapi_2
from app.emitter import LossKind, LossTracker

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _v3_document() -> dict:
    """A 3.1 document exercising every construct the 2.6 projection has to move."""
    return {
        "asyncapi": "3.1.0",
        "info": {"title": "User Events", "version": "1.2.0"},
        "servers": {
            "prod": {
                "host": "broker.example.com",
                "pathname": "/v1",
                "protocol": "kafka",
                "protocolVersion": "3.0",
                "description": "prod broker",
            }
        },
        "channels": {
            "userSignedUp": {
                "address": "user/{region}/signedup",
                "description": "signup stream",
                "parameters": {
                    "region": {"description": "deployment region", "enum": ["us", "eu"]}
                },
                "bindings": {"kafka": {"topic": "signups"}},
                "messages": {
                    "UserSignedUp": {
                        "name": "UserSignedUp",
                        "contentType": "application/json",
                        "payload": {"type": "object"},
                    }
                },
            }
        },
        "operations": {
            "onUserSignedUp": {
                "action": "receive",
                "channel": {"$ref": "#/channels/userSignedUp"},
                "description": "consume signups",
                "messages": [
                    {"$ref": "#/channels/userSignedUp/messages/UserSignedUp"}
                ],
            }
        },
        "components": {"schemas": {"User": {"type": "object"}}},
    }


def _downgrade(document: dict, **kwargs):
    """Run the projection, returning ``(document, losses)``."""
    losses = LossTracker()
    result = downgrade_to_asyncapi_2(document, losses, **kwargs)
    return result, losses.records()


def _subjects(losses) -> list:
    """The loss subjects, in the tracker's deterministic order."""
    return [loss.subject for loss in losses]


# ---------------------------------------------------------------------------
# Acceptance criterion: the 2.x document shape
# ---------------------------------------------------------------------------


def test_channels_are_rekeyed_by_address_and_carry_their_operation() -> None:
    doc, losses = _downgrade(_v3_document())

    assert doc["asyncapi"] == ASYNCAPI_26_VERSION
    assert "operations" not in doc
    assert list(doc["channels"]) == ["user/{region}/signedup"]

    channel = doc["channels"]["user/{region}/signedup"]
    assert channel["description"] == "signup stream"
    assert channel["bindings"] == {"kafka": {"topic": "signups"}}
    # ``receive`` is the application's perspective; 2.x states the client's.
    assert set(channel) & {"publish", "subscribe"} == {"subscribe"}
    assert channel["subscribe"]["operationId"] == "onUserSignedUp"
    assert channel["subscribe"]["description"] == "consume signups"
    assert losses == []


def test_channel_messages_are_inlined_onto_the_operation() -> None:
    doc, _ = _downgrade(_v3_document())
    channel = doc["channels"]["user/{region}/signedup"]

    # 2.x has no channel-level message map: the message rides on the operation.
    assert "messages" not in channel
    assert channel["subscribe"]["message"] == {
        "name": "UserSignedUp",
        "contentType": "application/json",
        "payload": {"type": "object"},
    }


def test_several_messages_become_a_one_of() -> None:
    document = _v3_document()
    channel = document["channels"]["userSignedUp"]
    channel["messages"]["UserResigned"] = {"name": "UserResigned"}
    document["operations"]["onUserSignedUp"]["messages"].append(
        {"$ref": "#/channels/userSignedUp/messages/UserResigned"}
    )

    doc, losses = _downgrade(document)
    message = doc["channels"]["user/{region}/signedup"]["subscribe"]["message"]

    assert [entry["name"] for entry in message["oneOf"]] == [
        "UserSignedUp",
        "UserResigned",
    ]
    assert losses == []


def test_server_host_and_pathname_recombine_into_one_url() -> None:
    doc, _ = _downgrade(_v3_document())

    assert doc["servers"]["prod"] == {
        "url": "kafka://broker.example.com/v1",
        "protocol": "kafka",
        "protocolVersion": "3.0",
        "description": "prod broker",
    }


def test_server_url_keeps_a_scheme_the_host_already_carries() -> None:
    document = _v3_document()
    document["servers"]["prod"] = {"host": "mqtt://broker.example.com", "protocol": "mqtt"}

    doc, _ = _downgrade(document)

    assert doc["servers"]["prod"]["url"] == "mqtt://broker.example.com"


def test_channel_parameters_gain_a_schema_from_the_model() -> None:
    doc, _ = _downgrade(
        _v3_document(),
        parameter_schemas={
            "user/{region}/signedup": {
                "region": {"type": "string", "pattern": "^[a-z]{2}$"}
            }
        },
    )

    assert doc["channels"]["user/{region}/signedup"]["parameters"] == {
        "region": {
            "description": "deployment region",
            # The model's schema, with the 3.x sibling ``enum`` folded into it.
            "schema": {"type": "string", "pattern": "^[a-z]{2}$", "enum": ["us", "eu"]},
        }
    }


def test_channel_parameters_without_a_model_schema_default_to_string() -> None:
    doc, _ = _downgrade(_v3_document())

    assert doc["channels"]["user/{region}/signedup"]["parameters"]["region"]["schema"] == {
        "type": "string",
        "enum": ["us", "eu"],
    }


def test_channel_server_refs_become_server_names() -> None:
    document = _v3_document()
    document["channels"]["userSignedUp"]["servers"] = [{"$ref": "#/servers/prod"}]

    doc, _ = _downgrade(document)

    assert doc["channels"]["user/{region}/signedup"]["servers"] == ["prod"]


def test_named_schemas_keep_their_components_path() -> None:
    doc, losses = _downgrade(_v3_document())

    # Unlike Swagger 2.0's ``#/definitions``, AsyncAPI 2.6 keeps ``components.schemas``,
    # so no ``$ref`` has to be rewritten.
    assert doc["components"] == {"schemas": {"User": {"type": "object"}}}
    assert losses == []


def test_channels_is_declared_even_when_empty() -> None:
    # ``channels`` is a required root member in 2.x (optional in 3.x), so a
    # components-only export still declares it.
    doc, _ = _downgrade(
        {
            "asyncapi": "3.1.0",
            "info": {"title": "Types", "version": "1.0.0"},
            "components": {"schemas": {"User": {"type": "object"}}},
        }
    )

    assert doc["channels"] == {}


def test_root_metadata_is_carried_across() -> None:
    document = _v3_document()
    document["id"] = "urn:example:events"
    document["defaultContentType"] = "application/json"

    doc, _ = _downgrade(document)

    assert doc["id"] == "urn:example:events"
    assert doc["defaultContentType"] == "application/json"


# ---------------------------------------------------------------------------
# Acceptance criterion: 3.x-only constructs are reported as losses
# ---------------------------------------------------------------------------


def test_operation_reply_is_reported_as_a_loss() -> None:
    document = _v3_document()
    channel = document["channels"]["userSignedUp"]
    channel["messages"]["Ack"] = {"name": "Ack"}
    document["operations"]["onUserSignedUp"]["reply"] = {
        "channel": {"$ref": "#/channels/userSignedUp"},
        "messages": [{"$ref": "#/channels/userSignedUp/messages/Ack"}],
    }

    doc, losses = _downgrade(document)
    reply_losses = [loss for loss in losses if loss.subject == "asyncapi2-operation-reply"]

    assert "reply" not in doc["channels"]["user/{region}/signedup"]["subscribe"]
    assert len(reply_losses) == 1
    assert reply_losses[0].kind is LossKind.NA
    assert "request/reply pattern AsyncAPI 2.6 cannot express" in reply_losses[0].detail
    assert reply_losses[0].pointer == "/operations/onUserSignedUp/reply"


def test_second_operation_of_one_action_on_a_channel_is_reported() -> None:
    document = _v3_document()
    document["operations"]["alsoOnUserSignedUp"] = {
        "action": "receive",
        "channel": {"$ref": "#/channels/userSignedUp"},
    }

    doc, losses = _downgrade(document)
    duplicate = [loss for loss in losses if loss.subject == "asyncapi2-duplicate-action"]

    # The first operation keeps the single ``subscribe`` slot; the second is named.
    assert doc["channels"]["user/{region}/signedup"]["subscribe"]["operationId"] == (
        "onUserSignedUp"
    )
    assert len(duplicate) == 1
    assert duplicate[0].kind is LossKind.NA
    assert "one subscribe slot" in duplicate[0].detail


def test_both_actions_share_one_channel_without_a_loss() -> None:
    document = _v3_document()
    document["operations"]["publishUserSignedUp"] = {
        "action": "send",
        "channel": {"$ref": "#/channels/userSignedUp"},
    }

    doc, losses = _downgrade(document)
    channel = doc["channels"]["user/{region}/signedup"]

    assert channel["publish"]["operationId"] == "publishUserSignedUp"
    assert channel["subscribe"]["operationId"] == "onUserSignedUp"
    assert _subjects(losses) == []


def test_two_channels_sharing_an_address_are_reported() -> None:
    document = _v3_document()
    document["channels"]["userSignedUpAgain"] = {
        "address": "user/{region}/signedup",
        "description": "a second declaration of the same address",
    }

    doc, losses = _downgrade(document)
    collision = [loss for loss in losses if loss.subject == "asyncapi2-channel-collision"]

    assert doc["channels"]["user/{region}/signedup"]["description"] == "signup stream"
    assert len(collision) == 1
    assert collision[0].kind is LossKind.NA


def test_channel_named_apart_from_its_address_is_reported() -> None:
    _, losses = _downgrade(
        _v3_document(), named_channel_addresses=frozenset({"user/{region}/signedup"})
    )
    name_losses = [loss for loss in losses if loss.subject == "asyncapi2-channel-name"]

    assert len(name_losses) == 1
    assert name_losses[0].kind is LossKind.NA
    assert "keys a channel by its address alone" in name_losses[0].detail


def test_a_derived_channel_name_is_not_reported_as_a_loss() -> None:
    # A model imported from 2.x declares no channel name of its own — the 3.1 emitter
    # derived it from the address — so collapsing it back says nothing.
    _, losses = _downgrade(_v3_document())

    assert _subjects(losses) == []


def test_unaddressed_channel_is_keyed_by_its_name() -> None:
    document = _v3_document()
    del document["channels"]["userSignedUp"]["address"]

    doc, losses = _downgrade(document)
    inferred = [loss for loss in losses if loss.subject == "asyncapi2-channel-address"]

    assert "userSignedUp" in doc["channels"]
    assert len(inferred) == 1
    assert inferred[0].kind is LossKind.INFERRED


def test_three_x_only_object_keys_are_reported_per_object() -> None:
    document = _v3_document()
    document["servers"]["prod"]["title"] = "Prod broker"
    document["channels"]["userSignedUp"]["tags"] = [{"name": "users"}]
    document["operations"]["onUserSignedUp"]["title"] = "On signup"

    doc, losses = _downgrade(document)

    assert "title" not in doc["servers"]["prod"]
    assert "tags" not in doc["channels"]["user/{region}/signedup"]
    assert "title" not in doc["channels"]["user/{region}/signedup"]["subscribe"]
    assert _subjects(losses) == [
        "asyncapi2-channel-field",
        "asyncapi2-operation-field",
        "asyncapi2-server-field",
    ]
    assert all(loss.kind is LossKind.NA for loss in losses)


def test_operation_with_an_unresolvable_channel_is_reported() -> None:
    document = _v3_document()
    document["operations"]["orphan"] = {
        "action": "send",
        "channel": {"$ref": "#/channels/missing"},
    }

    _, losses = _downgrade(document)

    assert "asyncapi2-operation-channel" in _subjects(losses)


def test_operation_without_a_send_or_receive_action_is_reported() -> None:
    document = _v3_document()
    document["operations"]["mystery"] = {"channel": {"$ref": "#/channels/userSignedUp"}}

    _, losses = _downgrade(document)

    assert "asyncapi2-operation-action" in _subjects(losses)


def test_message_no_operation_carries_is_reported() -> None:
    document = _v3_document()
    document["channels"]["userSignedUp"]["messages"]["Unused"] = {"name": "Unused"}

    _, losses = _downgrade(document)
    orphan = [loss for loss in losses if loss.subject == "asyncapi2-orphan-message"]

    assert len(orphan) == 1
    assert orphan[0].kind is LossKind.NA
    assert orphan[0].pointer == "/channels/userSignedUp/messages/Unused"


def test_components_member_2_6_does_not_have_is_reported() -> None:
    document = _v3_document()
    document["components"]["replies"] = {"Ack": {}}

    doc, losses = _downgrade(document)

    assert "replies" not in doc["components"]
    assert "asyncapi2-components-member" in _subjects(losses)


# ---------------------------------------------------------------------------
# Purity and determinism
# ---------------------------------------------------------------------------


def test_projection_does_not_mutate_its_input() -> None:
    document = _v3_document()
    before = copy.deepcopy(document)

    downgraded, _ = _downgrade(document)
    downgraded["channels"].clear()

    assert document == before


def test_projection_is_deterministic() -> None:
    first_doc, first_losses = _downgrade(_v3_document())
    second_doc, second_losses = _downgrade(_v3_document())

    assert first_doc == second_doc
    assert first_losses == second_losses
