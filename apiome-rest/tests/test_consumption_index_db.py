"""Consumption index against a real server — DUW-1.4 (private-suite#2571).

The unit suites pin the SQL (``test_consumption_index_store.py``) and the graph rules
(``test_consumption_index.py``). What neither can prove is the ticket's actual claim, which is
about a *catalog*: that the edges derived from real rows are the ones the mockup draws, that a
reference cycle in stored data terminates, and that answering costs seven statements and well under
300 ms on the 218-path catalog the epic's criteria name. That needs rows.

The seeded catalog is the mockup's scenario — ``Customer → Address → ContactMethod`` consumed by
four operations across two paths — sitting inside a bulk catalog large enough that none of the
numbers could be an artefact of a small one, plus two shapes no fixture graph can stand in for: a
class that references itself and a pair that reference each other, both reachable from an
operation.

Marked ``requires_db`` and skipped without ``DATABASE_URL``. To run against an ephemeral server, no
installation required::

    pg_virtualenv -v 16 bash -c 'DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE" \\
        uv run pytest tests/test_consumption_index_db.py -m requires_db'

Everything happens inside a transaction that is always rolled back, so a live database is left
exactly as it was found — which is also why the prerequisite subset of the schema is created here
rather than assumed. V242 itself is applied rather than hand-written, so the ``domain_id`` columns
are the real ones.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

from app.consumption_index import (
    KIND_DIRECT,
    KIND_NESTED,
    ClassGraph,
    build_edges,
    resolve_operations,
    resolve_paths,
    roll_up_paths,
)
from app.consumption_index_store import domain_scope, id_scope, load_version_facts, whole_version_scope

MIGRATION = "apiome-db/scripts/V242__domain_model_for_schemas_and_paths_2568.sql"

_db_url = os.environ.get("DATABASE_URL")

pytestmark = [
    pytest.mark.requires_db,
    pytest.mark.skipif(
        not _db_url, reason="DATABASE_URL not set – skipping live-DB integration tests"
    ),
]

PROJECT = "00000000-0000-4000-8000-000000000001"
VERSION = "00000000-0000-4000-8000-0000000000a1"
OTHER_VERSION = "00000000-0000-4000-8000-0000000000a2"

CUSTOMERS_DOMAIN = "00000000-0000-4000-8000-0000000000b1"
BULK_DOMAIN = "00000000-0000-4000-8000-0000000000b2"

#: The catalog size the epic's criteria name.
CATALOG_PATHS = 218
CATALOG_CLASSES = 250

#: Paths and classes belonging to the mockup scenario or the cycle fixtures; the rest pad ``bulk/``.
NAMED_PATHS = 4
NAMED_CLASSES = 8
BULK_PATHS = CATALOG_PATHS - NAMED_PATHS
BULK_CLASSES = CATALOG_CLASSES - NAMED_CLASSES

#: How many statements one read costs, whatever the catalog holds.
STATEMENTS = 7

#: The epic's latency budget, and how many samples it is judged over.
P95_BUDGET_MS = 300.0
LATENCY_SAMPLES = 20

#: The subset of the apiome schema a consumption index touches: the class graph, the paths and
#: operations, and the three schema sources the emitter reads. Narrower than production — only the
#: columns the store selects — but the ``domain_id`` columns come from V242.
_PREREQUISITE_SCHEMA = """
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS apiome;

CREATE TABLE apiome.projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL
);
CREATE TABLE apiome.versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES apiome.projects(id) ON DELETE CASCADE,
    version_id VARCHAR(255) NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE
);
CREATE TABLE apiome.classes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id UUID NOT NULL REFERENCES apiome.versions(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    schema JSONB DEFAULT '{}'::jsonb,
    enabled BOOLEAN DEFAULT TRUE,
    canvas_metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT classes_version_name_unique UNIQUE (version_id, name)
);
-- Properties carry a class's references. ``properties`` exists only because class_properties has
-- always keyed one, and the reference itself lives in the junction row's ``data``.
CREATE TABLE apiome.properties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL
);
CREATE TABLE apiome.class_properties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    class_id UUID NOT NULL REFERENCES apiome.classes(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES apiome.properties(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    data JSONB NOT NULL,
    CONSTRAINT class_properties_class_name_unique UNIQUE (class_id, name)
);
-- Tags are read by nothing here. They exist because V242's class backfill files a class under the
-- domain its project tag slugifies to, and the migration is applied rather than hand-written.
CREATE TABLE apiome.tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES apiome.projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(50) DEFAULT 'default',
    description TEXT,
    CONSTRAINT tags_project_name_unique UNIQUE (project_id, name)
);
CREATE TABLE apiome.class_tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    class_id UUID NOT NULL REFERENCES apiome.classes(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES apiome.tags(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT class_tags_class_tag_unique UNIQUE (class_id, tag_id)
);
CREATE TABLE apiome.version_path (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id UUID NOT NULL REFERENCES apiome.versions(id) ON DELETE CASCADE,
    pathname VARCHAR(255) NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (version_id, pathname)
);
CREATE TABLE apiome.path_operation (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_path_id UUID NOT NULL REFERENCES apiome.version_path(id) ON DELETE CASCADE,
    operation VARCHAR(50) NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (version_path_id, operation)
);
CREATE TABLE apiome.path_operation_description (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    path_operation_id UUID NOT NULL REFERENCES apiome.path_operation(id) ON DELETE CASCADE,
    summary VARCHAR(4096),
    description TEXT,
    operation_id VARCHAR(255),
    metadata JSONB,
    UNIQUE (path_operation_id)
);

-- Responses (V032 + V034): shared per path, linked to operations, schema on the response row or
-- on a per-media-type content row.
CREATE TABLE apiome.shared_path_response (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_path_id UUID NOT NULL REFERENCES apiome.version_path(id) ON DELETE CASCADE,
    status_code VARCHAR(10) NOT NULL,
    description TEXT,
    data JSONB,
    class_id UUID REFERENCES apiome.classes(id) ON DELETE SET NULL,
    inline_schema JSONB,
    schema_mode VARCHAR(20) DEFAULT 'object',
    UNIQUE (version_path_id, status_code)
);
CREATE TABLE apiome.shared_path_response_content (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shared_path_response_id UUID NOT NULL
        REFERENCES apiome.shared_path_response(id) ON DELETE CASCADE,
    media_type VARCHAR(255) NOT NULL DEFAULT 'application/json',
    class_id UUID REFERENCES apiome.classes(id) ON DELETE SET NULL,
    inline_schema JSONB,
    examples JSONB,
    UNIQUE (shared_path_response_id, media_type)
);
CREATE TABLE apiome.path_operation_response_link (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    path_operation_id UUID NOT NULL REFERENCES apiome.path_operation(id) ON DELETE CASCADE,
    shared_path_response_id UUID NOT NULL
        REFERENCES apiome.shared_path_response(id) ON DELETE CASCADE,
    metadata JSONB,
    UNIQUE (path_operation_id, shared_path_response_id)
);

-- Request bodies (V033): shared per path, at most one per operation, schema per media type.
CREATE TABLE apiome.shared_path_request_body (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_path_id UUID NOT NULL REFERENCES apiome.version_path(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    required BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (version_path_id, name)
);
CREATE TABLE apiome.shared_path_request_body_content (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shared_path_request_body_id UUID NOT NULL
        REFERENCES apiome.shared_path_request_body(id) ON DELETE CASCADE,
    media_type VARCHAR(255) NOT NULL,
    class_id UUID REFERENCES apiome.classes(id) ON DELETE SET NULL,
    inline_schema JSONB,
    encoding JSONB,
    examples JSONB,
    UNIQUE (shared_path_request_body_id, media_type)
);
CREATE TABLE apiome.path_operation_request_body_link (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    path_operation_id UUID NOT NULL REFERENCES apiome.path_operation(id) ON DELETE CASCADE,
    shared_path_request_body_id UUID NOT NULL
        REFERENCES apiome.shared_path_request_body(id) ON DELETE CASCADE,
    metadata JSONB,
    UNIQUE (path_operation_id)
);

-- Parameters (V031): shared per path, linked to operations, schema in ``data``.
CREATE TABLE apiome.shared_path_parameter (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_path_id UUID NOT NULL REFERENCES apiome.version_path(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    in_location VARCHAR(50) NOT NULL
        CHECK (in_location IN ('path', 'query', 'header', 'cookie')),
    summary VARCHAR(4096),
    description TEXT,
    data JSONB NOT NULL DEFAULT '{"type": "string", "required": true}'::jsonb,
    UNIQUE (version_path_id, name, in_location)
);
CREATE TABLE apiome.path_operation_parameter_link (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    path_operation_id UUID NOT NULL REFERENCES apiome.path_operation(id) ON DELETE CASCADE,
    shared_path_parameter_id UUID NOT NULL
        REFERENCES apiome.shared_path_parameter(id) ON DELETE CASCADE,
    metadata JSONB,
    UNIQUE (path_operation_id, shared_path_parameter_id)
);
"""


def _ref(name: str) -> str:
    """A JSON-pointer reference literal for embedding in seed SQL."""
    return '{"$ref":"#/components/schemas/' + name + '"}'


#: The mockup's catalog, plus the two cycle shapes and a bulk catalog to be counted and timed.
_SEED = f"""
INSERT INTO apiome.projects (id, name) VALUES ('{PROJECT}'::uuid, 'Primary');
INSERT INTO apiome.versions (id, project_id, version_id) VALUES
  ('{VERSION}'::uuid, '{PROJECT}'::uuid, '2.1'),
  ('{OTHER_VERSION}'::uuid, '{PROJECT}'::uuid, '3.0');
INSERT INTO apiome.properties (id, name) VALUES
  ('{PROJECT}'::uuid, 'generic');

-- The mockup's three classes, plus a parameter schema, a self-referencing class and a mutual pair.
INSERT INTO apiome.classes (version_id, name, schema) VALUES
  ('{VERSION}'::uuid, 'Customer',       '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'Address',        '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'ContactMethod',  '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'CustomerFilter', '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'TreeNode',       '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'LoopA',          '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'LoopB',          '{{"type":"object"}}'::jsonb),
  ('{VERSION}'::uuid, 'Unreferenced',   '{{"type":"object"}}'::jsonb);

INSERT INTO apiome.classes (version_id, name, schema)
SELECT '{VERSION}'::uuid, 'Bulk' || lpad(i::text, 4, '0'), '{{"type":"object"}}'::jsonb
  FROM generate_series(1, {BULK_CLASSES}) AS i;

-- Present in the table, absent from every edge: a soft-deleted class and one in another version.
INSERT INTO apiome.classes (version_id, name) VALUES
  ('{OTHER_VERSION}'::uuid, 'Customer');
INSERT INTO apiome.classes (version_id, name, deleted_at) VALUES
  ('{VERSION}'::uuid, 'AbandonedCustomer', CURRENT_TIMESTAMP);

-- Customer → Address → ContactMethod, the "cascades to Address, ContactMethod" of the mockup.
-- Address reaches ContactMethod through an array's items, which is a reference the naive reading
-- of a property (``data->>'$ref'``) would miss.
INSERT INTO apiome.class_properties (class_id, property_id, name, data)
SELECT c.id, '{PROJECT}'::uuid, v.name, v.data::jsonb
  FROM (VALUES
      ('Customer',      'address',  '{_ref("Address")}'),
      ('Customer',      'label',    '{{"type":"string"}}'),
      ('Address',       'contacts', '{{"type":"array","items":{_ref("ContactMethod")}}}'),
      ('ContactMethod', 'value',    '{{"type":"string"}}'),
      ('TreeNode',      'parent',   '{_ref("TreeNode")}'),
      ('LoopA',         'b',        '{_ref("LoopB")}'),
      ('LoopB',         'a',        '{_ref("LoopA")}'),
      ('Customer',      'dangling', '{_ref("NoSuchClass")}')
  ) AS v(class_name, name, data)
  JOIN apiome.classes c ON c.version_id = '{VERSION}'::uuid AND c.name = v.class_name;

INSERT INTO apiome.version_path (version_id, pathname) VALUES
  ('{VERSION}'::uuid, '/v1/customers'),
  ('{VERSION}'::uuid, '/v1/customers/{{id}}'),
  ('{VERSION}'::uuid, '/v1/trees'),
  ('{VERSION}'::uuid, '/v1/loops');

INSERT INTO apiome.version_path (version_id, pathname)
SELECT '{VERSION}'::uuid, '/v1/bulk/' || lpad(i::text, 4, '0')
  FROM generate_series(1, {BULK_PATHS}) AS i;

INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, unnest(ARRAY['POST','GET']) FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname = '/v1/customers';
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, unnest(ARRAY['DELETE','GET']) FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname = '/v1/customers/{{id}}';
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, 'GET' FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname IN ('/v1/trees', '/v1/loops');
INSERT INTO apiome.path_operation (version_path_id, operation)
SELECT id, 'GET' FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/bulk/%';

INSERT INTO apiome.path_operation_description (path_operation_id, operation_id, summary)
SELECT po.id, 'customers.' || lower(po.operation), initcap(po.operation) || ' customers'
  FROM apiome.path_operation po
  JOIN apiome.version_path vp ON vp.id = po.version_path_id
 WHERE vp.version_id = '{VERSION}'::uuid AND vp.pathname LIKE '/v1/customers%';

-- Responses. GET /customers and GET+DELETE /customers/{{id}} name Customer through a content row;
-- POST /customers names it on the response row itself, which is the emitter's fallback and has to
-- produce the same edge.
INSERT INTO apiome.shared_path_response (version_path_id, status_code, class_id)
SELECT vp.id, '201', c.id
  FROM apiome.version_path vp, apiome.classes c
 WHERE vp.version_id = '{VERSION}'::uuid AND vp.pathname = '/v1/customers'
   AND c.version_id = '{VERSION}'::uuid AND c.name = 'Customer';
INSERT INTO apiome.shared_path_response (version_path_id, status_code)
SELECT vp.id, s.status_code
  FROM apiome.version_path vp,
       (VALUES ('200'), ('204'), ('409')) AS s(status_code)
 WHERE vp.version_id = '{VERSION}'::uuid
   AND vp.pathname IN ('/v1/customers', '/v1/customers/{{id}}', '/v1/trees', '/v1/loops')
   AND NOT (vp.pathname = '/v1/customers' AND s.status_code <> '200');

INSERT INTO apiome.shared_path_response_content (shared_path_response_id, class_id)
SELECT spr.id, c.id
  FROM apiome.shared_path_response spr
  JOIN apiome.version_path vp ON vp.id = spr.version_path_id
  JOIN (VALUES
      ('/v1/customers',      '200', 'Customer'),
      ('/v1/customers/{{id}}','200', 'Customer'),
      ('/v1/customers/{{id}}','409', 'Customer'),
      ('/v1/trees',          '200', 'TreeNode'),
      ('/v1/loops',          '200', 'LoopA')
  ) AS m(pathname, status_code, class_name)
    ON m.pathname = vp.pathname AND m.status_code = spr.status_code
  JOIN apiome.classes c ON c.version_id = '{VERSION}'::uuid AND c.name = m.class_name
 WHERE vp.version_id = '{VERSION}'::uuid;

-- 204 carries no schema at all, which must produce no edge rather than a null one.
INSERT INTO apiome.path_operation_response_link (path_operation_id, shared_path_response_id)
SELECT po.id, spr.id
  FROM apiome.path_operation po
  JOIN apiome.version_path vp ON vp.id = po.version_path_id
  JOIN apiome.shared_path_response spr ON spr.version_path_id = vp.id
 WHERE vp.version_id = '{VERSION}'::uuid
   AND (
        (vp.pathname = '/v1/customers' AND po.operation = 'GET'  AND spr.status_code = '200')
     OR (vp.pathname = '/v1/customers' AND po.operation = 'POST' AND spr.status_code = '201')
     OR (vp.pathname = '/v1/customers/{{id}}' AND po.operation = 'GET' AND spr.status_code = '200')
     OR (vp.pathname = '/v1/customers/{{id}}' AND po.operation = 'DELETE'
         AND spr.status_code IN ('204', '409'))
     OR (vp.pathname IN ('/v1/trees', '/v1/loops') AND spr.status_code = '200')
   );

-- Each bulk path returns its own class, so the graph the timing runs over is a real one.
INSERT INTO apiome.shared_path_response (version_path_id, status_code, class_id)
SELECT vp.id, '200', c.id
  FROM apiome.version_path vp
  JOIN apiome.classes c
    ON c.version_id = '{VERSION}'::uuid
   AND c.name = 'Bulk' || right(vp.pathname, 4)
 WHERE vp.version_id = '{VERSION}'::uuid AND vp.pathname LIKE '/v1/bulk/%';
INSERT INTO apiome.path_operation_response_link (path_operation_id, shared_path_response_id)
SELECT po.id, spr.id
  FROM apiome.path_operation po
  JOIN apiome.version_path vp ON vp.id = po.version_path_id
  JOIN apiome.shared_path_response spr ON spr.version_path_id = vp.id
 WHERE vp.version_id = '{VERSION}'::uuid AND vp.pathname LIKE '/v1/bulk/%';

-- POST /customers takes a Customer body.
INSERT INTO apiome.shared_path_request_body (version_path_id, name)
SELECT id, 'CreateCustomer' FROM apiome.version_path
 WHERE version_id = '{VERSION}'::uuid AND pathname = '/v1/customers';
INSERT INTO apiome.shared_path_request_body_content
       (shared_path_request_body_id, media_type, class_id)
SELECT rb.id, 'application/json', c.id
  FROM apiome.shared_path_request_body rb, apiome.classes c
 WHERE c.version_id = '{VERSION}'::uuid AND c.name = 'Customer';
INSERT INTO apiome.path_operation_request_body_link (path_operation_id, shared_path_request_body_id)
SELECT po.id, rb.id
  FROM apiome.path_operation po
  JOIN apiome.version_path vp ON vp.id = po.version_path_id
  JOIN apiome.shared_path_request_body rb ON rb.version_path_id = vp.id
 WHERE vp.version_id = '{VERSION}'::uuid AND vp.pathname = '/v1/customers'
   AND po.operation = 'POST';

-- Two parameters on /customers: one plain string (no edge) and one that $refs a class.
INSERT INTO apiome.shared_path_parameter (version_path_id, name, in_location, data)
SELECT vp.id, v.name, v.in_location, v.data::jsonb
  FROM apiome.version_path vp,
       (VALUES
          ('page',   'query', '{{"type":"integer"}}'),
          ('filter', 'query', '{{"schema":{_ref("CustomerFilter")}}}')
       ) AS v(name, in_location, data)
 WHERE vp.version_id = '{VERSION}'::uuid AND vp.pathname = '/v1/customers';
INSERT INTO apiome.path_operation_parameter_link (path_operation_id, shared_path_parameter_id)
SELECT po.id, spp.id
  FROM apiome.path_operation po
  JOIN apiome.version_path vp ON vp.id = po.version_path_id
  JOIN apiome.shared_path_parameter spp ON spp.version_path_id = vp.id
 WHERE vp.version_id = '{VERSION}'::uuid AND vp.pathname = '/v1/customers'
   AND po.operation = 'GET';
"""

#: Domains are assigned explicitly rather than left to V242's backfill: those heuristics are
#: DUW-1.1's behaviour and are tested there. ``Address`` and ``ContactMethod`` stay in ``shared/``
#: on purpose — a domain-scoped index must still name them, which is what "nested via parent"
#: means.
_ASSIGN_DOMAINS = f"""
DELETE FROM apiome.domains WHERE version_id = '{VERSION}'::uuid;

INSERT INTO apiome.domains (id, version_id, name, slug, sort_order) VALUES
  ('{CUSTOMERS_DOMAIN}'::uuid, '{VERSION}'::uuid, 'customers', 'customers', 0),
  ('{BULK_DOMAIN}'::uuid,      '{VERSION}'::uuid, 'bulk',      'bulk',      1);

UPDATE apiome.classes SET domain_id = '{CUSTOMERS_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND name IN ('Customer', 'CustomerFilter');
UPDATE apiome.classes SET domain_id = '{BULK_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND name LIKE 'Bulk%';

UPDATE apiome.version_path SET domain_id = '{CUSTOMERS_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/customers%';
UPDATE apiome.version_path SET domain_id = '{BULK_DOMAIN}'::uuid
 WHERE version_id = '{VERSION}'::uuid AND pathname LIKE '/v1/bulk/%';

ANALYZE apiome.classes;
ANALYZE apiome.class_properties;
ANALYZE apiome.version_path;
ANALYZE apiome.path_operation;
ANALYZE apiome.shared_path_response;
"""


class CountingCursor:
    """A cursor that tallies every statement executed through it."""

    def __init__(self, cursor: Any, tally: List[str]) -> None:
        self._cursor = cursor
        self._tally = tally

    def execute(self, query: str, params: Any = None) -> Any:
        self._tally.append(" ".join(query.split()))
        return self._cursor.execute(query, params)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cursor, name)

    def __enter__(self) -> "CountingCursor":
        self._cursor.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        return self._cursor.__exit__(*exc)


class TransactionDb:
    """A ``_DbLike`` over one open transaction, counting statements.

    ``commit`` and ``rollback`` are no-ops: the store commits after every read (correctly — a bare
    SELECT still opens a transaction and holding it idle blocks VACUUM), but committing here would
    persist the seeded catalog into whatever cluster ``DATABASE_URL`` points at. That the store
    *does* commit is asserted against the fake connection in ``test_consumption_index_store.py``.
    """

    def __init__(self, conn: Any) -> None:
        self._conn = conn
        self.statements: List[str] = []

    def connect(self) -> "TransactionDb":
        return self

    def cursor(self) -> CountingCursor:
        return CountingCursor(self._conn.cursor(), self.statements)

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None


@pytest.fixture
def catalog(repo_root: Path):
    """The mockup's scenario inside a 218-path, 250-class catalog, rolled back when the test ends.

    Skips rather than colliding when ``DATABASE_URL`` already carries the real schema: building
    ``apiome.classes`` on top of a populated dev database would fail anyway, and half-running
    against real data is not what this suite is for.
    """
    psycopg2 = pytest.importorskip("psycopg2")
    from psycopg2.extras import RealDictCursor

    conn = psycopg2.connect(_db_url, cursor_factory=RealDictCursor)
    conn.autocommit = False
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT to_regclass('apiome.classes') IS NOT NULL "
                "    OR to_regclass('apiome.domains') IS NOT NULL AS present"
            )
            if cursor.fetchone()["present"]:
                pytest.skip(
                    "DATABASE_URL already carries the apiome schema; point this suite at a "
                    "scratch cluster (see the module docstring's pg_virtualenv invocation)."
                )

            cursor.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
            try:
                cursor.execute("SELECT uuid_generate_v4()")
            except psycopg2.Error:
                conn.rollback()
                pytest.skip("uuid-ossp is not resolvable on this cluster; cannot apply V242.")

            cursor.execute(_PREREQUISITE_SCHEMA)
            cursor.execute(_SEED)
            cursor.execute((repo_root / MIGRATION).read_text())
            cursor.execute(_ASSIGN_DOMAINS)

        yield TransactionDb(conn)
    finally:
        conn.rollback()
        conn.close()


def index(catalog: TransactionDb, scope=None):
    """Load and resolve one index, exactly as the route composes the two modules."""
    facts = load_version_facts(
        catalog, version_id=VERSION, scope=scope or whole_version_scope()
    )
    graph = ClassGraph(facts.classes, facts.class_properties)
    edges, capped = build_edges(
        paths=resolve_paths(facts.paths),
        operations=resolve_operations(
            operations=facts.operations,
            request_contents=facts.request_contents,
            response_contents=facts.response_contents,
            parameters=facts.parameters,
            graph=graph,
        ),
        graph=graph,
    )
    return edges, capped, graph


def for_path(edges, pathname: str) -> List[tuple]:
    """One path's edges as ``(method, class name, kind)``."""
    return [
        (edge.method, edge.class_name, edge.kind) for edge in edges if edge.pathname == pathname
    ]


def scalar(catalog: TransactionDb, query: str, params: tuple) -> int:
    """One count straight from SQL — the truth an assertion is checked against."""
    with catalog.cursor() as cursor:
        cursor.execute(query, params)
        return int(cursor.fetchone()["n"])


def class_ids(catalog: TransactionDb, *names: str) -> Dict[str, str]:
    """The seeded version's ids for a set of class names."""
    with catalog.cursor() as cursor:
        cursor.execute(
            "SELECT name, id FROM apiome.classes "
            " WHERE version_id = %s::uuid AND name = ANY(%s)",
            (VERSION, list(names)),
        )
        return {row["name"]: str(row["id"]) for row in cursor.fetchall()}


class TestCatalogSize:
    """The fixture is only interesting if it is actually the size it claims."""

    def test_the_catalog_is_the_size_the_criteria_name(self, catalog):
        paths = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.version_path WHERE version_id = %s::uuid",
            (VERSION,),
        )
        classes = scalar(
            catalog,
            "SELECT COUNT(*) AS n FROM apiome.classes "
            " WHERE version_id = %s::uuid AND deleted_at IS NULL",
            (VERSION,),
        )
        assert (paths, classes) == (CATALOG_PATHS, CATALOG_CLASSES)


class TestAcceptanceMockupScenario:
    """"The mockup scenario yields exactly the mockup's edge set, including nested via parent."""

    @pytest.fixture
    def customers(self, catalog):
        edges, _, _ = index(catalog, domain_scope(CUSTOMERS_DOMAIN))
        return edges

    def test_the_collection_path(self, customers):
        assert for_path(customers, "/v1/customers") == [
            ("GET", "Customer", KIND_DIRECT),
            ("GET", "CustomerFilter", KIND_DIRECT),
            ("GET", "Address", KIND_NESTED),
            ("GET", "ContactMethod", KIND_NESTED),
            ("POST", "Customer", KIND_DIRECT),
            ("POST", "Address", KIND_NESTED),
            ("POST", "ContactMethod", KIND_NESTED),
        ]

    def test_the_detail_path(self, customers):
        assert for_path(customers, "/v1/customers/{id}") == [
            ("GET", "Customer", KIND_DIRECT),
            ("GET", "Address", KIND_NESTED),
            ("GET", "ContactMethod", KIND_NESTED),
            ("DELETE", "Customer", KIND_DIRECT),
            ("DELETE", "Address", KIND_NESTED),
            ("DELETE", "ContactMethod", KIND_NESTED),
        ]

    def test_nested_edges_name_the_parents_they_hang_off(self, customers, catalog):
        ids = class_ids(catalog, "Customer", "Address")
        by_class = {edge.class_name: edge for edge in customers if edge.kind == KIND_NESTED}

        assert by_class["Address"].via == (ids["Customer"],)
        assert by_class["ContactMethod"].via == (ids["Customer"], ids["Address"])
        assert by_class["ContactMethod"].depth == 2

    def test_the_tree_block_badges_the_status_code(self, customers):
        """``Customer 200`` above ``Address nested`` — workspace.html lines 182–214."""
        block = [p for p in roll_up_paths(customers) if p["pathname"] == "/v1/customers"][0]
        rows = {row["class_name"]: row for row in block["classes"]}
        assert rows["Customer"]["badge"] == "200"
        assert rows["Address"]["badge"] == "nested"

    def test_the_status_bar_counts_distinct_path_class_pairs(self, customers):
        """``6 schema↔path links`` for the mockup's two paths — line 1040.

        The extra pair is ``CustomerFilter``, which the seed adds to prove a parameter ``$ref`` is
        consumption; the mockup's own six are ``Customer``, ``Address`` and ``ContactMethod``
        across the two paths.
        """
        rolled = roll_up_paths(customers)
        classes = {
            (entry["pathname"], row["class_name"])
            for entry in rolled
            for row in entry["classes"]
        }
        mockup = {c for c in classes if c[1] != "CustomerFilter"}
        assert len(mockup) == 6

    def test_a_request_body_is_consumption(self, customers):
        post = [e for e in customers if e.method == "POST" and e.class_name == "Customer"][0]
        assert "request" in post.roles

    def test_a_response_level_class_is_read_the_way_the_emitter_reads_it(self, customers):
        """POST's 201 names Customer on the response row, not on a content row."""
        post = [e for e in customers if e.method == "POST" and e.class_name == "Customer"][0]
        assert "response.201" in post.roles

    def test_a_status_with_no_schema_produces_no_edge(self, customers):
        delete = [e for e in customers if e.method == "DELETE"]
        assert all("response.204" not in edge.roles for edge in delete)

    def test_a_parameter_ref_is_consumption(self, customers):
        param = [e for e in customers if e.class_name == "CustomerFilter"][0]
        assert param.roles == ("parameter",)

    def test_a_dangling_reference_draws_nothing(self, customers):
        assert all(edge.class_name is not None for edge in customers)
        assert "NoSuchClass" not in {edge.class_name for edge in customers}


class TestAcceptanceCycleSafety:
    """"Self-referencing schemas terminate." Proved on stored rows, not on a fixture graph."""

    def test_a_class_that_references_itself_terminates(self, catalog):
        edges, capped, _ = index(catalog)
        trees = for_path(edges, "/v1/trees")
        assert trees == [("GET", "TreeNode", KIND_DIRECT)]
        assert capped is False

    def test_a_mutual_pair_terminates(self, catalog):
        edges, _, _ = index(catalog)
        assert for_path(edges, "/v1/loops") == [
            ("GET", "LoopA", KIND_DIRECT),
            ("GET", "LoopB", KIND_NESTED),
        ]


class TestScoping:
    """A scope narrows the paths it names, never the graph it walks."""

    def test_a_domain_scope_still_names_classes_outside_the_domain(self, catalog):
        """``Address`` is in ``shared/``; ``customers/`` consumes it all the same."""
        edges, _, _ = index(catalog, domain_scope(CUSTOMERS_DOMAIN))
        assert "Address" in {edge.class_name for edge in edges}
        assert {edge.pathname for edge in edges} == {"/v1/customers", "/v1/customers/{id}"}

    def test_the_shared_bucket_is_a_folder_a_scope_can_name(self, catalog):
        edges, _, _ = index(catalog, domain_scope(None))
        assert {edge.pathname for edge in edges} == {"/v1/loops", "/v1/trees"}

    def test_a_path_scope_answers_for_those_paths_only(self, catalog):
        with catalog.cursor() as cursor:
            cursor.execute(
                "SELECT id FROM apiome.version_path "
                " WHERE version_id = %s::uuid AND pathname = %s",
                (VERSION, "/v1/customers"),
            )
            path_id = str(cursor.fetchone()["id"])

        edges, _, _ = index(catalog, id_scope([path_id]))
        assert {edge.pathname for edge in edges} == {"/v1/customers"}

    def test_another_versions_class_of_the_same_name_is_never_reached(self, catalog):
        """Both versions define ``Customer``; a name resolves inside one version only."""
        _, _, graph = index(catalog)

        with catalog.cursor() as cursor:
            cursor.execute(
                "SELECT version_id, id FROM apiome.classes WHERE name = 'Customer' "
                " ORDER BY version_id",
                (),
            )
            rows = {str(row["version_id"]): str(row["id"]) for row in cursor.fetchall()}

        assert set(rows) == {VERSION, OTHER_VERSION}
        assert graph.id_of("Customer") == rows[VERSION]

    def test_a_soft_deleted_class_is_in_no_edge(self, catalog):
        _, _, graph = index(catalog)
        assert graph.id_of("AbandonedCustomer") is None


class TestCost:
    """Seven statements and well inside the epic's latency budget, on the named catalog."""

    def test_a_whole_version_index_costs_seven_statements(self, catalog):
        catalog.statements.clear()
        index(catalog)
        assert len(catalog.statements) == STATEMENTS

    def test_a_scoped_index_costs_the_same(self, catalog):
        catalog.statements.clear()
        index(catalog, domain_scope(CUSTOMERS_DOMAIN))
        assert len(catalog.statements) == STATEMENTS

    def test_p95_is_inside_the_budget(self, catalog):
        index(catalog)  # warm the plan cache; the budget is for a served request

        samples: List[float] = []
        for _ in range(LATENCY_SAMPLES):
            started = time.perf_counter()
            index(catalog)
            samples.append((time.perf_counter() - started) * 1000.0)

        samples.sort()
        p95 = samples[max(0, int(len(samples) * 0.95) - 1)]
        assert p95 < P95_BUDGET_MS, f"p95 {p95:.1f}ms over the {P95_BUDGET_MS:.0f}ms budget"

    def test_the_whole_catalogs_edges_are_derived(self, catalog):
        """Every bulk path returns its own class, so the index is catalog-sized, not sample-sized."""
        edges, _, _ = index(catalog)
        bulk = [edge for edge in edges if edge.pathname.startswith("/v1/bulk/")]
        assert len(bulk) == BULK_PATHS
