# Browse protocol / format facets (MFI-6.1, #3753)

The public directory spans many API description formats, so browsing it needs more than a name
search. Two facet axes narrow every browse listing:

| Axis | Query parameter | Vocabulary | Source column |
|------|-----------------|------------|---------------|
| Protocol | `protocol` | the canonical `ApiParadigm`: `rest`, `rpc`, `event`, `graph`, `data_schema`, `agent` | `apiome.versions.protocol` |
| Format | `format` | the specific source-format key an adapter recorded at import: `openapi-3.1`, `swagger-2.0`, `protobuf`, `graphql`, `asyncapi-3`, … | `apiome.versions.source_format` |

Both columns were added by MFI-7.1 (`V136`) and are populated by the import pipeline; that migration
also created the two partial indexes (`idx_versions_protocol`, `idx_versions_source_format`) these
reads sit on.

## Endpoints

Both listings accept the filters and both return a `facets` block:

- `GET /v1/browse/tenants?protocol=…&format=…`
- `GET /v1/browse/tenants/{tenant_slug}/projects?protocol=…&format=…`

```jsonc
{
  "tenants": [
    {
      "slug": "acme-corp",
      "protocols": ["event", "rest"],       // distinct values across the listed versions
      "formats": ["asyncapi-3", "openapi-3.1"]
    }
  ],
  "filtered_count": 1,
  "facets": {
    "protocols": [{ "value": "rest", "label": "REST", "count": 12 }],
    "formats":   [{ "value": "openapi-3.1", "label": "OpenAPI 3.1", "count": 9 }]
  }
}
```

`GET /v1/browse/tenants/{tenant_slug}/projects/{project_slug}/versions` does not filter, but each
version row now reports its own `protocol` and `source_format`.

## Semantics

**Filters narrow, they never fail.** A value that is not in the vocabulary is normalized and
matched anyway, which returns an empty listing — the same contract the existing `search` and
`domain` filters have. Nothing here can produce a 4xx.

**Matching is case- and punctuation-insensitive.** `data-schema`, `data schema` and `DATASCHEMA`
all mean `data_schema`; `graphql` means `graph`, `event-driven` means `event`, `mcp` means `agent`.
Format keys are matched after a trim + lower-case.

**The two axes compose with AND**, and each is satisfied when *any* listed version of the entry
carries the value. A project published once as OpenAPI and once as gRPC matches both
`protocol=rest` and `protocol=rpc`.

**A facet narrows which entries are listed; it does not rewrite them.** `published_versions`,
`latest_version` and the `protocols`/`formats` arrays always describe all of an entry's listed
versions, so a row looks the same however you arrived at it.

**Counts ignore the facet selection itself.** They honour the listing's other filters (`search`,
`domain`) so they describe what is on screen, but they are *not* re-scoped by the selected
protocol/format — a chip row has to answer "what else could I pick", which it cannot do if
selecting REST collapses it to one chip. Protocols are returned in canonical paradigm order;
formats by descending count with ties broken by key.

**Member reads use the member scope.** An authenticated tenant member sees their whole tenant
(every visibility), so their facet counts come from `get_member_browse_project_facets_for_tenant`
rather than the public accessor. A member project with no published version at all drops out of a
*faceted* listing — it has no version that could carry a value — but is still listed unfiltered.

## Labels

`app/browse_facets.py` owns the vocabulary. Protocol labels come from a table keyed by
`ApiParadigm`. Format labels come from the **import-source registry** — the same descriptors that
drive the import source cards — so a newly registered adapter labels its own facet chip with no
change here. A versioned key is labelled from its adapter's name plus the version suffix, and the
name is chosen to match the key when one adapter covers several formats:

| Key | Label |
|-----|-------|
| `graphql` | GraphQL |
| `protobuf` | gRPC / Protobuf |
| `openapi-3.1` | OpenAPI 3.1 |
| `swagger-2.0` | Swagger 2.0 |
| `json-schema-2020-12` | JSON Schema 2020-12 |
| `iso20022` | ISO 20022 |
| *anything unregistered* | the raw key |

Keys that merely end in digits (`iso20022`, `hl7v2`, `asn1`) are never split into name + version.

## Browse app

`apiome-browse` renders the same facets on the organization directory (home) and on a tenant's
project list. Its vocabulary lives in `lib/browseFacets.ts`, deliberately mirroring this module so
the API and the app describe a facet with the same words; the roll-up SQL is in
`lib/db/helper.ts`. The chip components (`src/app/components/FacetFilter.tsx`) are presentational —
counting, ordering, filtering and labelling are all in the pure module and unit-tested there.

## Caveat: unbackfilled revisions

Revisions imported before MFI-7.1 carry `NULL` in both columns and therefore contribute no chip and
match no facet. On a directory of only such specs the facet bar renders nothing at all rather than
an empty filter. **MFI-7.3 (#3758)** is the one-off backfill that tags existing OpenAPI/Arazzo
artifacts and lights the facets up for pre-existing specs.

## Tests

- `tests/test_browse_facets.py` — normalization, aliases, labelling, ordering.
- `tests/test_browse_public_api.py` — the route wiring: filters passed through normalized, facet
  counts labelled and ordered, member vs public accessor, degradation on missing columns.
- `apiome-browse/lib/__tests__/browseFacets.test.ts` — the browse app's mirror of the same rules.
