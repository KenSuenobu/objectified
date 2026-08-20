# Postman Collection v2.0 — `postman-v2`

Fixtures for the Postman half of **FMT-3.6** ([#5431](https://github.com/apiome/apiome/issues/5431)).
The shipped `postman/` corpus is Collection **v2.1**; `postman_parser.py` is written against 2.1, and
a v2.0 export — the form Insomnia reads — is detected by schema URL but not guaranteed to normalize.
The two shapes differ in ways that matter:

| | v2.0 | v2.1 |
| --- | --- | --- |
| `request.url` | a **string** (`"{{baseUrl}}/orders?status=new"`) | an object (`raw`, `host`, `path`, `query`) |
| `auth.basic` | an object (`{ "username": …, "password": … }`) | an array of `{key, value, type}` |
| `variable[].id` | present | usually absent |

Entries carry `adapter_key: null` and the `pending-adapter` tag until the v2.0 divergences are fixed.

**Detection marker.** `info.schema` ending `/collection/v2.0.0/collection.json`.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-single-request.json` | minimal | One GET, string URL. |
| `02-typical-crud-collection.json` | typical | Four requests, `{{baseUrl}}` variable, `:pathVariable` segments, a saved example response. |
| `03-composition-nested-folders.json` | composition | Folders inside folders → operation groups. |
| `04-stress-auth-bodies-and-scripts.json` | stress | `raw`/`urlencoded`/`formdata`/`graphql` bodies, collection-level and request-level auth in the **v2.0** shape, pre-request and test scripts, disabled entries. |
| `05-real-world-payments-collection.json` | real-world | Vendor sandbox collection: auth folder that captures a token, idempotency header, two saved example responses. |
| `06-environment-set/` | multi-file | Collection plus its environment file — variables only resolve across the set. |
| `negative/` | — | Unterminated string, an item-less collection, truncation, an OpenAPI document, UTF-16, and a **v1** collection (version-out-of-range). |

**Credential rule.** Every credential-shaped value here is an empty string or a `{{variable}}`
placeholder; the scrub gate must still be asserted, but these fixtures carry nothing to leak.
