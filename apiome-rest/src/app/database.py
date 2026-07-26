import hashlib
import json
import logging
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import bcrypt
import numpy as np
import psycopg2
from psycopg2.extras import Json, RealDictCursor

from .axis_score import (
    ALGORITHM_ID,
    catalog_axis_evaluation,
    evaluation_row,
    mcp_axis_evaluation,
)
from .config import WEBHOOK_MAX_DELIVERY_ATTEMPTS, settings
from .jsonschema_generator import generate_class_jsonschema_spec
from .lint_evidence import (
    SUBJECT_CATALOG_REVISION,
    SUBJECT_MCP_ENDPOINT_VERSION,
    mcp_evidence_run,
    native_evidence_run,
)
from .mcp_facets import (
    COMPLEXITY_MODERATE_MAX_PROPERTIES,
    COMPLEXITY_SIMPLE_MAX_PROPERTIES,
    SAFETY_HAS_DESTRUCTIVE,
    SAFETY_READ_ONLY_ONLY,
    UNCATEGORIZED_VALUE,
    UNGRADED_VALUE,
    UNKNOWN_VALUE,
)
from .push_webhook_crypto import encrypt_signing_secret
from .revision_deprecation import (
    coerce_metadata,
    effective_sunset_string,
    is_uuid_string,
    successor_revision_id_from_metadata,
)
from .revision_lifecycle import prepare_version_metadata_update, sql_effective_lifecycle_expr

_logger = logging.getLogger(__name__)


def normalize_email(email: str) -> str:
    """Canonicalize an email address to the stored/indexed form: trimmed and lower-cased.

    Case and surrounding whitespace never distinguish two accounts — ``Ada@Example.com`` and
    ``ada@example.com`` are one identity (OLO-1.1, #4186). Every read and write path that keys on
    email must pass user input through here so lookups stay case-insensitive and no duplicate-cased
    account can be created.

    Args:
        email: The raw email address as supplied by the caller.

    Returns:
        The normalized address (``email.strip().lower()``).
    """
    return email.strip().lower()


def _deep_equal(a: Any, b: Any) -> bool:
    """Recursive equality for JSON-like values."""
    if type(a) != type(b):
        return False
    if a is None or isinstance(a, (str, int, float, bool)):
        return a == b
    if isinstance(a, dict):
        if set(a) != set(b):
            return False
        return all(_deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        if len(a) != len(b):
            return False
        return all(_deep_equal(x, y) for x, y in zip(a, b))
    return False


def _parse_pgvector_text(text: Optional[str]) -> Optional[List[float]]:
    """Parse a pgvector column read as text (``"[0.1,0.2,...]"``) into a float list.

    Reading a ``vector`` column with ``::text`` avoids needing the ``pgvector`` psycopg2 adapter
    (``register_vector``) just to fetch stored embeddings for in-process nearest-neighbour ranking.
    Returns ``None`` for a NULL / blank / unparseable value so the caller can simply skip that row and
    fall back to the non-embedding path rather than raising.
    """
    if not text:
        return None
    inner = text.strip().strip("[]")
    if not inner:
        return None
    try:
        return [float(part) for part in inner.split(",")]
    except (TypeError, ValueError):
        return None


def format_mcp_version_tag(discovered_at: datetime) -> str:
    """Build the human-readable UTC date/time tag for an MCP version snapshot (#3671).

    Produces a compact, minute-precision ISO-8601-style label such as ``2026-06-26T14:03Z``
    from the moment a discovery ran. The value is normalized to UTC so the tag is stable and
    comparable regardless of the server clock's timezone, matching the SQL backfill format in
    migration V131 (``YYYY-MM-DD"T"HH24:MI"Z"`` over ``discovered_at AT TIME ZONE 'UTC'``).

    Args:
        discovered_at: When the discovery that produced the snapshot ran. A naive datetime is
            assumed to already be UTC; an aware one is converted to UTC.

    Returns:
        The base date/time tag (without any collision suffix).
    """
    dt = discovered_at if discovered_at.tzinfo is not None else discovered_at.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


class StaleHeadPushError(Exception):
    """Branch tip changed after the client's base revision check (optimistic lock, #2566)."""

    def __init__(self, current_tip_revision_id: str):
        self.current_tip_revision_id = current_tip_revision_id
        super().__init__("stale head")


class BranchNotFoundError(Exception):
    """Branch row disappeared between head-resolution and the transactional FOR UPDATE lock."""

    def __init__(self, branch_id: str):
        self.branch_id = branch_id
        super().__init__(f"branch not found: {branch_id}")


class BranchDefaultConflictError(Exception):
    """Concurrent default-branch promotion conflicted with unique default-per-project invariant."""


class SourceApplyConflictError(Exception):
    """Structured failure inside the source-apply transaction (DCW-2.3, private-suite#2360).

    Carries a machine-readable ``code`` plus a structured ``payload`` so the
    REST layer can emit precise 409/422 bodies. Raising this always rolls the
    transaction back — a failed apply leaves the revision unchanged.

    Codes: ``version_not_found``, ``published_version``, ``draft_lock_conflict``,
    ``permission_denied``, ``stale_base``, ``change_set_mismatch``, ``blocked``,
    ``apply_fidelity``, ``apply_lossy``.
    """

    def __init__(self, code: str, payload: Optional[Dict[str, Any]] = None):
        self.code = code
        self.payload = payload or {}
        super().__init__(code)


def _compute_delta(old: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
    """
    Compute top-level delta: keys added, removed, or changed.
    Removed keys appear as key: None. If nothing changed, returns {}.
    """
    delta = {}
    all_keys = set(old) | set(new)
    for k in all_keys:
        if k not in new:
            delta[k] = None
        elif k not in old or not _deep_equal(old[k], new[k]):
            delta[k] = new[k]
    return delta


class TenantProvisioningError(Exception):
    """Base error for first-tenant provisioning (OLO-4.3, #4207).

    Carries a machine-readable ``code`` (stable, kebab-case) alongside the
    human-readable message so the REST layer can emit structured 403/409
    payloads and the UI can map codes to friendly copy (409 for slug
    conflicts, 403 for the tenant-cap license guard — OLO-5.3, #4213).
    """

    code = "tenant-provisioning-failed"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class TenantSlugConflictError(TenantProvisioningError):
    """The requested tenant slug is already in use by an active tenant."""

    code = "tenant-slug-taken"


class TenantCapReachedError(TenantProvisioningError):
    """The caller already has as many tenants as their entitlement allows."""

    code = "tenant-cap-reached"


# Fallback when a user has no ``user_entitlements`` row yet: the Free tier
# allows a single tenant (matches the V097 Free license seats and the free-tier
# entitlement seed used at signup).
DEFAULT_FREE_MAX_TENANTS = 1

# Fallback when a tenant has no ``tenant_licenses`` row (or its license ``seats``
# JSON is missing/malformed): the Free tier allows five members per tenant
# (matches the V097 Free license seats; every tenant should hold a license since
# the V183 auto-issue trigger + backfill, so this is a defensive default).
DEFAULT_FREE_MAX_USERS_PER_TENANT = 5

# Fallbacks for the license quota keys (#64) when the tenant's license ``seats``
# JSON omits the key or stores a non-numeric value. They mirror the Free tier
# seeded by V195 and the apiome-ui enforcement defaults
# (``entitlement-limits-from-license-seats.ts``): 1 project, 3 versions, no AI.
DEFAULT_FREE_MAX_PROJECTS = 1
DEFAULT_FREE_MAX_VERSIONS = 3
DEFAULT_FREE_MAX_AI_REQUESTS = 0

# Lifetime of an ``onboarding_wizard_state`` row (OLO-4.5, #4209). A wizard the
# user never finishes is pruned this long after its last save, matching the
# short-lived staging pattern of ``oauth_signup_pending`` (V071). A day is long
# enough to span a "come back tomorrow and finish setup" gap.
ONBOARDING_WIZARD_STATE_TTL_HOURS = 24


class Database:
    """Database connection and query manager."""

    def __init__(self):
        self.connection = None

    def connect(self):
        """Establish database connection."""
        if not self.connection or self.connection.closed:
            try:
                self.connection = psycopg2.connect(
                    settings.effective_database_url,
                    cursor_factory=RealDictCursor,
                )
            except psycopg2.OperationalError as e:
                err_s = str(e).lower()
                if "does not exist" in err_s and "database" in err_s:
                    db_name = settings.postgres_db
                    raise psycopg2.OperationalError(
                        f"{e}\n\n"
                        "PostgreSQL has no database with that name yet. Create it, then apply migrations "
                        "from apiome-db/scripts (see apiome-db/docs/README.md). Example:\n"
                        f"  psql -U {settings.postgres_user} -h {settings.postgres_host} "
                        f"-p {settings.postgres_port} -c 'CREATE DATABASE {db_name};'\n"
                        "If you use DATABASE_URL, the database name is the path segment after the last '/'."
                    ) from e
                raise
        return self.connection

    def close(self):
        """Close database connection."""
        if self.connection and not self.connection.closed:
            self.connection.close()

    def execute_query(self, query: str, params: tuple = None) -> List[Dict[str, Any]]:
        """Execute a SELECT query and return results.

        Commits on success so the shared connection returns to IDLE. Leaving
        reads in "idle in transaction" holds locks, blocks VACUUM, and causes
        subsequent writers that toggle ``conn.autocommit`` to crash with
        ``set_session cannot be used inside a transaction``.
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                rows = cursor.fetchall()
            conn.commit()
            return rows
        except Exception as e:
            conn.rollback()
            raise e

    def _begin_tx(self, conn) -> bool:
        """Flush any dangling transaction, then enter manual-commit mode.

        Psycopg2 implements ``conn.autocommit = X`` via ``set_session``, which
        raises when the connection is not IDLE. Any prior statement on the
        shared connection (direct ``conn.cursor()`` usage that didn't commit)
        can leave us in ``INTRANS`` or ``INERROR``. Rolling back first is safe
        and idempotent and restores a clean starting point for the new tx.

        Returns the previous autocommit value so the caller can restore it
        in ``finally``.
        """
        if conn.info.transaction_status != psycopg2.extensions.TRANSACTION_STATUS_IDLE:
            conn.rollback()
        prev = conn.autocommit
        conn.autocommit = False
        return prev

    def get_version_by_slugs(self, tenant_slug: str, project_slug: str, version_id: str) -> Optional[Dict[str, Any]]:
        """Get version information by tenant, project, and version slugs."""
        query = """
            SELECT v.id, v.version_id, v.visibility, v.published,
                   p.description as project_description, p.metadata as project_metadata,
                   v.metadata
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            JOIN apiome.tenants t ON p.tenant_id = t.id
            WHERE t.slug = %s
              AND p.slug = %s
              AND v.version_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
              AND t.deleted_at IS NULL
        """
        results = self.execute_query(query, (tenant_slug, project_slug, version_id))
        return results[0] if results else None

    def get_classes_for_version(self, version_id: str) -> List[Dict[str, Any]]:
        """Get all classes for a specific version."""
        query = """
            SELECT id, version_id, name, description, schema, enabled
            FROM apiome.classes
            WHERE version_id = %s AND deleted_at IS NULL
            ORDER BY name ASC
        """
        return self.execute_query(query, (version_id,))

    def get_class_by_name(self, version_id: str, class_name: str) -> Optional[Dict[str, Any]]:
        """Get a specific class by name for a version."""
        query = """
            SELECT id, version_id, name, description, schema, enabled
            FROM apiome.classes
            WHERE version_id = %s AND name = %s AND deleted_at IS NULL
        """
        results = self.execute_query(query, (version_id, class_name))
        return results[0] if results else None

    def get_properties_for_class(self, class_id: str) -> List[Dict[str, Any]]:
        """Get all properties for a specific class."""
        query = """
            SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id,
                   cp.primitive_id, cp.primitive_ref,
                   p.id as property_source_id, p.name as property_source_name, p.data as property_source_data
            FROM apiome.class_properties cp
            LEFT JOIN apiome.properties p ON cp.property_id = p.id
            WHERE cp.class_id = %s
            ORDER BY cp.parent_id NULLS FIRST, cp.name ASC
        """
        return self.execute_query(query, (class_id,))

    def get_classes_with_properties_and_tags_for_version(self, version_id: str) -> List[Dict[str, Any]]:
        """Get all classes for a version with their properties and tags in bulk."""
        # Query 1: Get all classes for the version
        classes_query = """
            SELECT id, version_id, name, description, schema, enabled, canvas_metadata, created_at, updated_at
            FROM apiome.classes
            WHERE version_id = %s AND deleted_at IS NULL
            ORDER BY name ASC
        """
        classes = self.execute_query(classes_query, (version_id,))

        if not classes:
            return []

        class_ids = [c['id'] for c in classes]

        if not class_ids:
            return []

        # Query 2: Get all properties for all classes
        # Use IN clause with tuple for proper UUID handling
        placeholders = ','.join(['%s'] * len(class_ids))
        properties_query = f"""
            SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id,
                   cp.primitive_id, cp.primitive_ref,
                   p.id as property_source_id, p.name as property_source_name, p.data as property_source_data
            FROM apiome.class_properties cp
            LEFT JOIN apiome.properties p ON cp.property_id = p.id
            WHERE cp.class_id IN ({placeholders})
            ORDER BY cp.class_id, cp.parent_id NULLS FIRST, cp.name ASC
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(properties_query, tuple(class_ids))
                properties = cursor.fetchall()
        except Exception as e:
            conn.rollback()
            raise e

        # Query 3: Get all tags for all classes
        tags_query = f"""
            SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
                   t.name as tag_name, t.color as tag_color, t.description as tag_description,
                   t.project_id
            FROM apiome.class_tags ct
            JOIN apiome.tags t ON ct.tag_id = t.id
            WHERE ct.class_id IN ({placeholders})
            ORDER BY ct.class_id, t.name ASC
        """
        try:
            with conn.cursor() as cursor:
                cursor.execute(tags_query, tuple(class_ids))
                tags = cursor.fetchall()
        except Exception as e:
            conn.rollback()
            raise e

        # Group properties and tags by class_id
        properties_by_class = {}
        for prop in properties:
            class_id = prop['class_id']
            if class_id not in properties_by_class:
                properties_by_class[class_id] = []
            properties_by_class[class_id].append(prop)

        tags_by_class = {}
        for tag in tags:
            class_id = tag['class_id']
            if class_id not in tags_by_class:
                tags_by_class[class_id] = []
            tags_by_class[class_id].append(tag)

        # Combine classes with their properties and tags
        result = []
        for cls in classes:
            result.append({
                **cls,
                'properties': properties_by_class.get(cls['id'], []),
                'tags': tags_by_class.get(cls['id'], [])
            })

        return result

    def get_class_with_properties_and_tags(self, class_id: str) -> Optional[Dict[str, Any]]:
        """Get a single class with its properties and tags."""
        # Query 1: Get the class
        class_query = """
            SELECT id, version_id, name, description, schema, enabled, canvas_metadata, created_at, updated_at
            FROM apiome.classes
            WHERE id = %s AND deleted_at IS NULL
        """
        classes = self.execute_query(class_query, (class_id,))

        if not classes:
            return None

        cls = classes[0]

        # Query 2: Get all properties for this class
        properties_query = """
            SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id,
                   cp.primitive_id, cp.primitive_ref,
                   p.id as property_source_id, p.name as property_source_name, p.data as property_source_data
            FROM apiome.class_properties cp
            LEFT JOIN apiome.properties p ON cp.property_id = p.id
            WHERE cp.class_id = %s
            ORDER BY cp.parent_id NULLS FIRST, cp.name ASC
        """
        properties = self.execute_query(properties_query, (class_id,))

        # Query 3: Get all tags for this class
        tags_query = """
            SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
                   t.name as tag_name, t.color as tag_color, t.description as tag_description,
                   t.project_id
            FROM apiome.class_tags ct
            JOIN apiome.tags t ON ct.tag_id = t.id
            WHERE ct.class_id = %s
            ORDER BY t.name ASC
        """
        tags = self.execute_query(tags_query, (class_id,))

        return {
            **cls,
            'properties': properties,
            'tags': tags
        }

    # ==================== Class CRUD Operations ====================

    def get_version_for_tenant(self, tenant_id: str, version_id: str) -> Optional[Dict[str, Any]]:
        """Get a version by ID, ensuring it belongs to the tenant."""
        query = """
            SELECT v.id, v.version_id, v.project_id, v.visibility, v.published,
                   p.name as project_name, p.slug as project_slug
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
        """
        results = self.execute_query(query, (version_id, tenant_id))
        return results[0] if results else None

    def get_versions_for_tenant(self, tenant_id: str) -> List[Dict[str, Any]]:
        """Get all versions for a tenant."""
        query = """
            SELECT v.id, v.version_id, v.project_id, v.visibility, v.published,
                   p.name as project_name, p.slug as project_slug
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
            ORDER BY p.name, v.version_id
        """
        return self.execute_query(query, (tenant_id,))

    def get_class_by_id(self, class_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific class by ID, ensuring it belongs to the tenant."""
        query = """
            SELECT c.id, c.version_id, c.name, c.description, c.schema, c.enabled,
                   c.created_at, c.updated_at
            FROM apiome.classes c
            JOIN apiome.versions v ON c.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE c.id = %s
              AND p.tenant_id = %s
              AND c.deleted_at IS NULL
        """
        results = self.execute_query(query, (class_id, tenant_id))
        return results[0] if results else None

    def get_classes_for_tenant_version(self, tenant_id: str, version_id: str) -> List[Dict[str, Any]]:
        """Get all classes for a specific version, ensuring it belongs to the tenant."""
        query = """
            SELECT c.id, c.version_id, c.name, c.description, c.schema, c.enabled,
                   c.created_at, c.updated_at
            FROM apiome.classes c
            JOIN apiome.versions v ON c.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE c.version_id = %s
              AND p.tenant_id = %s
              AND c.deleted_at IS NULL
            ORDER BY c.name ASC
        """
        return self.execute_query(query, (version_id, tenant_id))

    def create_class(
        self,
        version_id: str,
        name: str,
        schema: Dict[str, Any],
        description: Optional[str] = None,
        enabled: bool = True
    ) -> Dict[str, Any]:
        """Create a new class."""
        import json
        query = """
            INSERT INTO apiome.classes
            (version_id, name, description, schema, enabled)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, version_id, name, description, schema, enabled,
                      created_at, updated_at
        """
        schema_json = json.dumps(schema)

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (version_id, name, description, schema_json, enabled)
                )
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_class(
        self,
        class_id: str,
        tenant_id: str,
        updates: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update an existing class, ensuring it belongs to the tenant."""
        import json

        # First verify the class belongs to the tenant
        existing = self.get_class_by_id(class_id, tenant_id)
        if not existing:
            return None

        # Build dynamic update query
        update_fields = []
        params = []

        if 'name' in updates and updates['name'] is not None:
            update_fields.append("name = %s")
            params.append(updates['name'])
        if 'description' in updates and updates['description'] is not None:
            update_fields.append("description = %s")
            params.append(updates['description'])
        if 'schema' in updates and updates['schema'] is not None:
            update_fields.append("schema = %s")
            params.append(json.dumps(updates['schema']))
        if 'enabled' in updates and updates['enabled'] is not None:
            update_fields.append("enabled = %s")
            params.append(updates['enabled'])
        if 'canvas_metadata' in updates and updates['canvas_metadata'] is not None:
            update_fields.append("canvas_metadata = %s")
            params.append(json.dumps(updates['canvas_metadata']))

        if not update_fields:
            # Nothing to update, return current class
            return existing

        update_fields.append("updated_at = CURRENT_TIMESTAMP")
        params.append(class_id)

        query = f"""
            UPDATE apiome.classes
            SET {', '.join(update_fields)}
            WHERE id = %s AND deleted_at IS NULL
            RETURNING id, version_id, name, description, schema, enabled, canvas_metadata,
                      created_at, updated_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_class(self, class_id: str, tenant_id: str) -> bool:
        """Delete a class (soft delete), ensuring it belongs to the tenant."""
        # First verify the class belongs to the tenant
        existing = self.get_class_by_id(class_id, tenant_id)
        if not existing:
            return False

        query = """
            UPDATE apiome.classes
            SET deleted_at = CURRENT_TIMESTAMP
            WHERE id = %s AND deleted_at IS NULL
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (class_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def add_property_to_class(
        self,
        class_id: str,
        property_id: Optional[str],
        name: str,
        description: Optional[str],
        data: Dict[str, Any],
        parent_id: Optional[str] = None,
        primitive_id: Optional[str] = None,
        primitive_ref: Optional[str] = None
    ) -> Dict[str, Any]:
        """Add a property to a class.

        Args:
            primitive_id: Optional FK to the apiome.primitives row this property is bound
                to (the resolved target of a registry $ref). Read by the Designer (#3448).
            primitive_ref: Optional registry $ref string persisted alongside primitive_id.
        """
        import json

        if not name or not name.strip():
            raise ValueError('Property name is required')

        # Validate: either property_id must be set, or data must contain $ref
        has_ref = data and (data.get('$ref') or (data.get('type') == 'array' and data.get('items', {}).get('$ref')))
        if not property_id and not has_ref:
            raise ValueError('Property must have either a library reference (property_id) or a schema $ref')

        query = """
            INSERT INTO apiome.class_properties
                (class_id, property_id, name, description, data, parent_id, primitive_id, primitive_ref)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, class_id, property_id, name, description, data, parent_id,
                      primitive_id, primitive_ref
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (class_id, property_id, name.strip(), description, json.dumps(data),
                     parent_id, primitive_id, primitive_ref)
                )
                result = cursor.fetchone()
                # Binding a property to a registry type counts as a use of that
                # primitive (#3475 — increment usage via the existing usage_count
                # pattern). Done in the same transaction so the count and the
                # binding commit atomically.
                if primitive_id:
                    cursor.execute(
                        "UPDATE apiome.primitives SET usage_count = usage_count + 1 WHERE id = %s",
                        (primitive_id,)
                    )
                conn.commit()
                # Parse JSON data if it's a string
                if result and isinstance(result.get('data'), str):
                    result['data'] = json.loads(result['data'])
                return result
        except Exception as e:
            conn.rollback()
            # Check for unique constraint violation
            if "unique constraint" in str(e).lower() or "23505" in str(e):
                raise ValueError('A property with this name already exists at this level')
            raise e

    def update_class_property(
        self,
        class_property_id: str,
        class_id: str,
        tenant_id: str,
        updates: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update a class property, ensuring it belongs to the class and tenant."""
        import json

        # First verify the class property belongs to a class that belongs to the tenant.
        # Also fetch the current primitive binding so we can tell whether this update
        # newly binds the property to a primitive (for the usage_count increment, #3475).
        verify_query = """
            SELECT cp.id, cp.class_id, cp.primitive_id
            FROM apiome.class_properties cp
            JOIN apiome.classes c ON cp.class_id = c.id
            JOIN apiome.versions v ON c.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE cp.id = %s
              AND c.id = %s
              AND p.tenant_id = %s
        """
        verify_result = self.execute_query(verify_query, (class_property_id, class_id, tenant_id))
        if not verify_result:
            return None
        old_primitive_id = verify_result[0].get('primitive_id')

        # Build dynamic update query
        update_fields = []
        params = []

        if 'name' in updates and updates['name'] is not None:
            update_fields.append("name = %s")
            params.append(updates['name'].strip())
        if 'description' in updates:
            update_fields.append("description = %s")
            params.append(updates['description'])
        if 'data' in updates and updates['data'] is not None:
            update_fields.append("data = %s")
            params.append(json.dumps(updates['data']))
        # Property→primitive binding (#3448). These accept None so a binding can be cleared.
        if 'primitive_id' in updates:
            update_fields.append("primitive_id = %s")
            params.append(updates['primitive_id'])
        if 'primitive_ref' in updates:
            update_fields.append("primitive_ref = %s")
            params.append(updates['primitive_ref'])

        if not update_fields:
            # Nothing to update, return current property
            return self.execute_query(
                "SELECT id, class_id, property_id, name, description, data, parent_id, primitive_id, primitive_ref FROM apiome.class_properties WHERE id = %s",
                (class_property_id,)
            )[0] if self.execute_query("SELECT id FROM apiome.class_properties WHERE id = %s", (class_property_id,)) else None

        params.append(class_property_id)

        query = f"""
            UPDATE apiome.class_properties
            SET {', '.join(update_fields)}
            WHERE id = %s
            RETURNING id, class_id, property_id, name, description, data, parent_id,
                      primitive_id, primitive_ref
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                result = cursor.fetchone()
                # If this update binds the property to a *different* primitive than
                # before, count it as a new use of that primitive (#3475). Comparing
                # against the prior value keeps repeated saves of an unchanged binding
                # from inflating usage_count. Same transaction as the update.
                if 'primitive_id' in updates:
                    new_primitive_id = updates['primitive_id']
                    if new_primitive_id and str(new_primitive_id) != str(old_primitive_id):
                        cursor.execute(
                            "UPDATE apiome.primitives SET usage_count = usage_count + 1 WHERE id = %s",
                            (new_primitive_id,)
                        )
                conn.commit()
                if result and isinstance(result.get('data'), str):
                    result['data'] = json.loads(result['data'])
                return result
        except Exception as e:
            conn.rollback()
            # Check for unique constraint violation
            if "unique constraint" in str(e).lower() or "23505" in str(e):
                raise ValueError('A property with this name already exists at this level')
            raise e

    def delete_class_property(
        self,
        class_property_id: str,
        class_id: str,
        tenant_id: str
    ) -> bool:
        """Delete a class property, ensuring it belongs to the class and tenant."""
        # First verify the class property belongs to a class that belongs to the tenant
        verify_query = """
            SELECT cp.id
            FROM apiome.class_properties cp
            JOIN apiome.classes c ON cp.class_id = c.id
            JOIN apiome.versions v ON c.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE cp.id = %s
              AND c.id = %s
              AND p.tenant_id = %s
        """
        verify_result = self.execute_query(verify_query, (class_property_id, class_id, tenant_id))
        if not verify_result:
            return False

        query = """
            DELETE FROM apiome.class_properties
            WHERE id = %s
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (class_property_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def validate_api_key(self, api_key: str) -> Optional[Dict[str, Any]]:
        """
        Validate an API key and return tenant information.
        Uses the same key_prefix format as the UI (first 12 chars + '...') for lookup,
        then verifies the full key against the stored bcrypt key_hash.

        Args:
            api_key: The API key to validate

        Returns:
            Dict with tenant_id and tenant info if valid, None otherwise
        """
        if not api_key or len(api_key) < 12:
            return None

        # Match UI format: key_prefix is first 12 characters + '...'
        key_prefix = api_key[:12] + '...'

        query_with_scopes = """
            SELECT ak.id, ak.tenant_id, ak.created_by_user_id, ak.key_hash, ak.expires_at, ak.enabled,
                   ak.scopes,
                   t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
            FROM apiome.api_keys ak
            JOIN apiome.tenants t ON ak.tenant_id = t.id
            WHERE ak.key_prefix = %s
              AND ak.deleted_at IS NULL
              AND ak.enabled = true
              AND t.deleted_at IS NULL
              AND t.enabled = true
              AND (ak.expires_at IS NULL OR ak.expires_at > CURRENT_TIMESTAMP)
        """
        query_with_creator = """
            SELECT ak.id, ak.tenant_id, ak.created_by_user_id, ak.key_hash, ak.expires_at, ak.enabled,
                   t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
            FROM apiome.api_keys ak
            JOIN apiome.tenants t ON ak.tenant_id = t.id
            WHERE ak.key_prefix = %s
              AND ak.deleted_at IS NULL
              AND ak.enabled = true
              AND t.deleted_at IS NULL
              AND t.enabled = true
              AND (ak.expires_at IS NULL OR ak.expires_at > CURRENT_TIMESTAMP)
        """
        query_legacy = """
            SELECT ak.id, ak.tenant_id, ak.key_hash, ak.expires_at, ak.enabled,
                   t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
            FROM apiome.api_keys ak
            JOIN apiome.tenants t ON ak.tenant_id = t.id
            WHERE ak.key_prefix = %s
              AND ak.deleted_at IS NULL
              AND ak.enabled = true
              AND t.deleted_at IS NULL
              AND t.enabled = true
              AND (ak.expires_at IS NULL OR ak.expires_at > CURRENT_TIMESTAMP)
        """
        try:
            results = self.execute_query(query_with_scopes, (key_prefix,))
        except Exception as e:
            root = e.__cause__ if getattr(e, "__cause__", None) else e
            pgcode = getattr(root, "pgcode", None)
            msg_l = str(e).lower()
            if pgcode == "42703" or ("scopes" in msg_l and "does not exist" in msg_l):
                try:
                    results = self.execute_query(query_with_creator, (key_prefix,))
                except Exception as e2:
                    root2 = e2.__cause__ if getattr(e2, "__cause__", None) else e2
                    pgcode2 = getattr(root2, "pgcode", None)
                    msg2 = str(e2).lower()
                    if pgcode2 == "42703" or ("created_by_user_id" in msg2 and "does not exist" in msg2):
                        results = self.execute_query(query_legacy, (key_prefix,))
                    else:
                        raise
            elif pgcode == "42703" or ("created_by_user_id" in msg_l and "does not exist" in msg_l):
                results = self.execute_query(query_legacy, (key_prefix,))
            else:
                raise

        if not results:
            return None

        # Verify the full key against the stored bcrypt hash
        api_key_bytes = api_key.encode('utf-8')
        for row in results:
            key_hash = row['key_hash']
            if isinstance(key_hash, str):
                key_hash = key_hash.encode('utf-8')
            try:
                if bcrypt.checkpw(api_key_bytes, key_hash):
                    api_key_data = dict(row)
                    # Pre-V177 rows / legacy SELECT: treat missing scopes as full access.
                    if api_key_data.get("scopes") is None:
                        api_key_data["scopes"] = ["*"]
                    # Update last_used_at
                    try:
                        update_query = "UPDATE apiome.api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = %s"
                        conn = self.connect()
                        with conn.cursor() as cursor:
                            cursor.execute(update_query, (api_key_data['id'],))
                            conn.commit()
                    except Exception:
                        pass  # Don't fail if we can't update last_used_at
                    return api_key_data
            except (ValueError, TypeError):
                continue

        return None

    def get_fallback_creator_user_id_for_tenant(self, tenant_id: str) -> Optional[str]:
        """
        When an API key has no created_by_user_id (legacy rows), attribute writes to the first
        tenant administrator if any, otherwise the first tenant member.
        """
        admin_q = """
            SELECT user_id::text AS user_id
            FROM apiome.tenant_administrators
            WHERE tenant_id = %s::uuid
            ORDER BY created_at ASC
            LIMIT 1
        """
        rows = self.execute_query(admin_q, (tenant_id,))
        if rows:
            uid = rows[0].get("user_id")
            if uid:
                return str(uid)
        member_q = """
            SELECT user_id::text AS user_id
            FROM apiome.tenant_users
            WHERE tenant_id = %s::uuid
            ORDER BY created_at ASC
            LIMIT 1
        """
        rows = self.execute_query(member_q, (tenant_id,))
        if rows:
            uid = rows[0].get("user_id")
            if uid:
                return str(uid)
        return None

    def count_tenants_for_user(self, user_id: str) -> int:
        """Count enabled, non-deleted tenants the user belongs to (member or administrator)."""
        query = """
            SELECT COUNT(DISTINCT t.id)::int AS c
            FROM apiome.tenants t
            INNER JOIN (
                SELECT tenant_id FROM apiome.tenant_users WHERE user_id = %s::uuid
                UNION
                SELECT tenant_id FROM apiome.tenant_administrators WHERE user_id = %s::uuid
            ) access ON access.tenant_id = t.id
            WHERE t.deleted_at IS NULL
              AND t.enabled IS TRUE
        """
        rows = self.execute_query(query, (user_id, user_id))
        if not rows:
            return 0
        c = rows[0].get("c")
        return int(c) if c is not None else 0

    def list_tenants_for_user_page(
        self, user_id: str, limit: int, offset: int
    ) -> List[Dict[str, Any]]:
        """
        List a user's tenant memberships enriched for the tenant switcher (OLO-6.2, #4219).

        One query — no per-tenant follow-ups — returning, per membership row:

        - ``role``: the effective RBAC role slug, resolved exactly like the permission
          guard (``user_has_permission``): a ``tenant_administrators`` row is
          Owner-equivalent (V118 rule), otherwise the assigned V119
          ``tenant_user_roles`` slug, otherwise the built-in Editor default.
        - ``status``: the V121 member lifecycle status (``active``/``pending``/
          ``suspended``); an administrator with no ``tenant_users`` row reads as
          ``active``.
        - ``license_name`` / ``license_type``: the tenant's attached plan from the
          V182 ``tenant_licenses`` → V097 catalog join; both NULL when the tenant
          has no license row (callers treat that as the Free fallback, mirroring
          ``license_capacity.member_seat_limit``).

        Ordered by slug ascending.

        :param user_id: Canonical UUID string of the user.
        :param limit: Page size.
        :param offset: Page start.
        :returns: Rows with ``id``, ``slug``, ``name``, ``role``, ``status``,
            ``license_name``, ``license_type``.
        """
        query = """
            SELECT t.id::text AS id, t.slug, t.name,
                   CASE WHEN ta.user_id IS NOT NULL THEN 'owner'
                        ELSE COALESCE(r.slug, 'editor') END AS role,
                   COALESCE(tu.status, 'active') AS status,
                   l.name AS license_name,
                   l.license_type AS license_type
            FROM apiome.tenants t
            INNER JOIN (
                SELECT tenant_id, user_id FROM apiome.tenant_users WHERE user_id = %s::uuid
                UNION
                SELECT tenant_id, user_id FROM apiome.tenant_administrators WHERE user_id = %s::uuid
            ) access ON access.tenant_id = t.id AND access.user_id = %s::uuid
            LEFT JOIN apiome.tenant_administrators ta
              ON ta.tenant_id = t.id AND ta.user_id = access.user_id
            LEFT JOIN apiome.tenant_users tu
              ON tu.tenant_id = t.id AND tu.user_id = access.user_id
            LEFT JOIN apiome.tenant_user_roles tur
              ON tur.tenant_id = t.id AND tur.user_id = access.user_id
            LEFT JOIN apiome.roles r ON r.id = tur.role_id
            LEFT JOIN apiome.tenant_licenses tl ON tl.tenant_id = t.id
            LEFT JOIN apiome.licenses l ON l.id = tl.license_id
            WHERE t.deleted_at IS NULL AND t.enabled IS TRUE
            ORDER BY t.slug ASC
            LIMIT %s OFFSET %s
        """
        return self.execute_query(query, (user_id, user_id, user_id, limit, offset))

    def get_tenant_row_by_slug(self, slug: str) -> Optional[Dict[str, Any]]:
        """Return tenant id/slug/name/created_at if slug exists and is active."""
        query = """
            SELECT t.id::text AS id, t.slug, t.name, t.created_at
            FROM apiome.tenants t
            WHERE t.slug = %s AND t.deleted_at IS NULL AND t.enabled IS TRUE
            LIMIT 1
        """
        rows = self.execute_query(query, (slug,))
        return rows[0] if rows else None

    def get_tenant_usage_stats(self, tenant_id: str) -> Dict[str, Any]:
        """Aggregate member, project, and version counts for tenant detail (#3198)."""
        query = """
            SELECT
              (SELECT COUNT(*)::int FROM apiome.tenant_users tu WHERE tu.tenant_id = %s) AS members_count,
              (SELECT COUNT(*)::int FROM apiome.projects p
                 WHERE p.tenant_id = %s AND p.deleted_at IS NULL) AS projects_count,
              (SELECT COUNT(*)::int
                 FROM apiome.versions v
                 INNER JOIN apiome.projects p ON v.project_id = p.id
                 WHERE p.tenant_id = %s AND p.deleted_at IS NULL) AS versions_count,
              (SELECT COUNT(*)::int
                 FROM apiome.versions v
                 INNER JOIN apiome.projects p ON v.project_id = p.id
                 WHERE p.tenant_id = %s AND p.deleted_at IS NULL AND v.published IS TRUE)
                AS published_versions_count
        """
        rows = self.execute_query(query, (tenant_id, tenant_id, tenant_id, tenant_id))
        if not rows:
            return {
                "members_count": 0,
                "projects_count": 0,
                "versions_count": 0,
                "published_versions_count": 0,
            }
        return dict(rows[0])

    # ---- First-tenant provisioning (OLO-4.3, #4207) -------------------

    def provision_first_tenant(
        self,
        user_id: str,
        name: str,
        slug: str,
        description: str = "",
    ) -> Dict[str, Any]:
        """Atomically provision a tenant for ``user_id`` (OLO-4.3, #4207).

        One transaction performs, in order:

        1. Enforce the caller's tenant cap (``user_entitlements.max_tenants``,
           Free default when no row) against their current tenant count.
        2. Insert the ``apiome.tenants`` row (enabled, not deleted).
        3. Attach the Free license (``apiome.attach_free_license``, V183,
           OLO-5.2). The V183 trigger already fires on the insert; the
           explicit call keeps the endpoint's guarantee visible and holds
           even if the trigger is ever dropped (idempotent either way).
        4. Seed the built-in RBAC roles (``apiome.seed_builtin_roles``, V118).
        5. Insert the caller into ``apiome.tenant_users`` with status
           ``active`` (V121) and assign the built-in **Owner** role in
           ``apiome.tenant_user_roles`` (V119).
        6. Insert the caller into ``apiome.tenant_administrators`` — the
           legacy full-access plane the RBAC guard still honours (V119 note).
        7. Seed free-tier ``user_entitlements`` for the caller when absent
           (idempotent; mirrors the UI's ``insertFreeTierEntitlements``).

        Everything commits together or not at all; the sample project is
        deliberately *not* part of the transaction (best-effort, see
        ``provision_sample_project``).

        Args:
            user_id: Canonical UUID string of the authenticated caller.
            name: Tenant display name (already trimmed and non-empty).
            slug: Validated, normalized tenant slug.
            description: Optional tenant description; empty by default.

        Returns:
            The created tenant row: ``id`` (text), ``name``, ``slug``,
            ``created_at``.

        Raises:
            TenantCapReachedError: The caller is at their max-tenants cap.
            TenantSlugConflictError: An active tenant already uses ``slug``.
            TenantProvisioningError: The owner role could not be resolved.
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT max_tenants FROM apiome.user_entitlements WHERE user_id = %s::uuid",
                    (user_id,),
                )
                ent_row = cursor.fetchone()
                max_tenants = (
                    int(ent_row["max_tenants"])
                    if ent_row and ent_row.get("max_tenants") is not None
                    else DEFAULT_FREE_MAX_TENANTS
                )

                cursor.execute(
                    """
                    SELECT COUNT(DISTINCT t.id)::int AS c
                    FROM apiome.tenants t
                    INNER JOIN (
                        SELECT tenant_id FROM apiome.tenant_users WHERE user_id = %s::uuid
                        UNION
                        SELECT tenant_id FROM apiome.tenant_administrators WHERE user_id = %s::uuid
                    ) access ON access.tenant_id = t.id
                    WHERE t.deleted_at IS NULL
                      AND t.enabled IS TRUE
                    """,
                    (user_id, user_id),
                )
                count_row = cursor.fetchone()
                current = int(count_row["c"]) if count_row and count_row.get("c") is not None else 0
                if current >= max_tenants:
                    raise TenantCapReachedError(
                        f"Tenant limit reached ({current}/{max_tenants} tenants used)"
                    )

                cursor.execute(
                    "SELECT 1 FROM apiome.tenants WHERE slug = %s AND deleted_at IS NULL",
                    (slug,),
                )
                if cursor.fetchone():
                    raise TenantSlugConflictError("A tenant with this slug already exists")

                cursor.execute(
                    """
                    INSERT INTO apiome.tenants (name, description, slug, enabled)
                    VALUES (%s, %s, %s, true)
                    RETURNING id::text AS id, name, slug, created_at
                    """,
                    (name, description, slug),
                )
                tenant = dict(cursor.fetchone())
                tenant_id = tenant["id"]

                cursor.execute("SELECT apiome.attach_free_license(%s::uuid)", (tenant_id,))

                cursor.execute("SELECT apiome.seed_builtin_roles(%s::uuid)", (tenant_id,))

                cursor.execute(
                    """
                    INSERT INTO apiome.tenant_users (tenant_id, user_id, status)
                    VALUES (%s::uuid, %s::uuid, 'active')
                    ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
                    """,
                    (tenant_id, user_id),
                )

                cursor.execute(
                    "SELECT id::text AS id FROM apiome.roles WHERE tenant_id = %s::uuid AND slug = 'owner'",
                    (tenant_id,),
                )
                owner_row = cursor.fetchone()
                if not owner_row:
                    raise TenantProvisioningError(
                        "Built-in owner role missing after seeding (V118)"
                    )
                cursor.execute(
                    """
                    INSERT INTO apiome.tenant_user_roles (tenant_id, user_id, role_id)
                    VALUES (%s::uuid, %s::uuid, %s::uuid)
                    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id
                    """,
                    (tenant_id, user_id, owner_row["id"]),
                )

                cursor.execute(
                    """
                    INSERT INTO apiome.tenant_administrators (tenant_id, user_id)
                    VALUES (%s::uuid, %s::uuid)
                    ON CONFLICT DO NOTHING
                    """,
                    (tenant_id, user_id),
                )

                cursor.execute(
                    """
                    INSERT INTO apiome.user_entitlements
                        (user_id, plan_code, max_tenants, max_projects, max_versions, license_id)
                    SELECT %s::uuid, l.license_type, 1, 1, 3, l.id
                    FROM apiome.licenses l
                    WHERE l.name = 'Free' AND l.license_type = 'free'
                    LIMIT 1
                    ON CONFLICT (user_id) DO NOTHING
                    """,
                    (user_id,),
                )
            conn.commit()
            return tenant
        except psycopg2.errors.UniqueViolation as e:
            # Lost a slug race to a concurrent insert: the pre-check passed but
            # the tenants slug unique index rejected the row.
            conn.rollback()
            raise TenantSlugConflictError("A tenant with this slug already exists") from e
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def provision_sample_project(self, tenant_id: str, user_id: str) -> Optional[str]:
        """Seed the curated Petstore sample project for a fresh tenant.

        Thin wrapper over ``apiome.provision_sample_project`` (V122), which is
        idempotent and returns NULL when the tenant already has the sample.
        Callers treat this as best-effort — a fresh tenant may simply start
        empty — so failures should be caught and logged, never re-raised into
        the provisioning response.

        Args:
            tenant_id: UUID string of the tenant to seed.
            user_id: UUID string of the creating user (recorded as creator).

        Returns:
            The created sample project id, or ``None`` when skipped.
        """
        rows = self.execute_query(
            "SELECT apiome.provision_sample_project(%s::uuid, %s::uuid) AS project_id",
            (tenant_id, user_id),
        )
        if rows and rows[0].get("project_id"):
            return str(rows[0]["project_id"])
        return None

    # ---- Onboarding wizard resume state + funnel telemetry (OLO-4.5) --------

    def upsert_onboarding_wizard_state(
        self,
        user_id: str,
        step: str,
        org_name: Optional[str],
        slug: Optional[str],
    ) -> None:
        """Persist the caller's onboarding-wizard resume position (OLO-4.5, #4209).

        One row per user (``ON CONFLICT (user_id)``); each save moves the
        ``expires_at`` sweep window forward so an actively-used wizard is never
        pruned mid-session. Mirrors the ``oauth_signup_pending`` (V071) staging
        pattern. The wizard reloads this row on the next login to reopen on
        ``step`` with ``org_name``/``slug`` pre-filled.

        Args:
            user_id: Canonical UUID string of the authenticated caller.
            step: Wizard step to resume on.
            org_name: Organization name entered so far, or None.
            slug: Tenant slug entered so far, or None.
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.onboarding_wizard_state
                        (user_id, step, org_name, slug, expires_at)
                    VALUES (
                        %s::uuid, %s, %s, %s,
                        CURRENT_TIMESTAMP + make_interval(hours => %s)
                    )
                    ON CONFLICT (user_id) DO UPDATE SET
                        step = EXCLUDED.step,
                        org_name = EXCLUDED.org_name,
                        slug = EXCLUDED.slug,
                        updated_at = CURRENT_TIMESTAMP,
                        expires_at = EXCLUDED.expires_at
                    """,
                    (user_id, step, org_name, slug, ONBOARDING_WIZARD_STATE_TTL_HOURS),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def get_onboarding_wizard_state(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Return the caller's saved wizard state, or None when absent/expired.

        Expired rows (past ``expires_at``) are treated as absent so an abandoned
        wizard never resurrects a stale step; the tail is swept separately by
        :meth:`prune_onboarding_wizard_state`.

        Args:
            user_id: Canonical UUID string of the authenticated caller.

        Returns:
            A dict with ``step``, ``org_name``, ``slug``, ``updated_at`` (ISO
            string), or None.
        """
        rows = self.execute_query(
            """
            SELECT step, org_name, slug, updated_at
            FROM apiome.onboarding_wizard_state
            WHERE user_id = %s::uuid AND expires_at > CURRENT_TIMESTAMP
            """,
            (user_id,),
        )
        if not rows:
            return None
        row = dict(rows[0])
        updated_at = row.get("updated_at")
        return {
            "step": row.get("step"),
            "org_name": row.get("org_name"),
            "slug": row.get("slug"),
            "updated_at": updated_at.isoformat() if updated_at is not None else None,
        }

    def delete_onboarding_wizard_state(self, user_id: str) -> int:
        """Clear the caller's saved wizard state; return rows removed.

        Called when the wizard completes (a provisioned tenant means the wizard
        no longer shows) so no stale resume row lingers until it expires.

        Args:
            user_id: Canonical UUID string of the authenticated caller.

        Returns:
            The number of rows deleted (0 or 1).
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM apiome.onboarding_wizard_state WHERE user_id = %s::uuid",
                    (user_id,),
                )
                deleted = cursor.rowcount
            conn.commit()
            return deleted
        except Exception:
            conn.rollback()
            raise

    def record_onboarding_funnel_event(
        self,
        user_id: Optional[str],
        step: str,
        event: str,
        detail: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append an onboarding funnel event (best-effort; never raises).

        Feeds the append-only ``onboarding_funnel_events`` ledger used for
        step-drop-off metrics. Telemetry must never fail the wizard action it
        records, so any error is swallowed and logged (mirrors the best-effort
        ``auth_events`` writes, V193).

        Args:
            user_id: Caller's UUID string, or None if unknown.
            step: Wizard step the event is about.
            event: One of ``reached``, ``completed``, ``abandoned``.
            detail: Optional structured context serialized to JSONB.
        """
        try:
            conn = self.connect()
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.onboarding_funnel_events
                        (user_id, step, event, detail)
                    VALUES (%s::uuid, %s, %s, %s::jsonb)
                    """,
                    (
                        user_id,
                        step,
                        event,
                        json.dumps(detail) if detail is not None else None,
                    ),
                )
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            _logger.warning("record_onboarding_funnel_event failed: %s", e)

    def prune_onboarding_wizard_state(self) -> int:
        """Delete abandoned wizard rows past their ``expires_at``; return rows removed.

        The "abandon cleanup" sweep (OLO-4.5, #4209): a user who walks away
        mid-wizard leaves a row that no completion clears, so it is pruned once
        its TTL lapses. Best-effort — a failed sweep is logged, never raised.

        Returns:
            The number of expired rows deleted.
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    DELETE FROM apiome.onboarding_wizard_state
                    WHERE expires_at <= CURRENT_TIMESTAMP
                    """
                )
                deleted = cursor.rowcount
            conn.commit()
            return deleted
        except Exception as e:
            conn.rollback()
            _logger.warning("prune_onboarding_wizard_state failed: %s", e)
            return 0

    def get_tag_by_id(self, tag_id: str) -> Optional[Dict[str, Any]]:
        """Get a single project tag by ID."""
        query = """
            SELECT id, project_id, name, color, description, created_at, updated_at
            FROM apiome.tags
            WHERE id = %s
        """
        rows = self.execute_query(query, (tag_id,))
        return dict(rows[0]) if rows else None

    def get_tags_for_project(self, project_id: str) -> List[Dict[str, Any]]:
        """Get all tags for a specific project."""
        query = """
            SELECT id, project_id, name, color, description, created_at, updated_at
            FROM apiome.tags
            WHERE project_id = %s
            ORDER BY name ASC
        """
        return self.execute_query(query, (project_id,))

    def get_tags_for_class(self, class_id: str) -> List[Dict[str, Any]]:
        """Get all tags assigned to a specific class."""
        query = """
            SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
                   t.name as tag_name, t.color as tag_color, t.description as tag_description
            FROM apiome.class_tags ct
            JOIN apiome.tags t ON ct.tag_id = t.id
            WHERE ct.class_id = %s
            ORDER BY t.name ASC
        """
        return self.execute_query(query, (class_id,))

    def create_tag(self, project_id: str, name: str, color: str = "default", description: Optional[str] = None) -> Dict[str, Any]:
        """Create a new tag."""
        query = """
            INSERT INTO apiome.tags (project_id, name, color, description)
            VALUES (%s, %s, %s, %s)
            RETURNING id, project_id, name, color, description, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (project_id, name, color, description))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_tag(self, tag_id: str, name: Optional[str] = None, color: Optional[str] = None, description: Optional[str] = None) -> Dict[str, Any]:
        """Update an existing tag."""
        # Build dynamic update query
        updates = []
        params = []

        if name is not None:
            updates.append("name = %s")
            params.append(name)
        if color is not None:
            updates.append("color = %s")
            params.append(color)
        if description is not None:
            updates.append("description = %s")
            params.append(description)

        if not updates:
            # Nothing to update, just return current tag
            return self.get_tag_by_id(tag_id)

        params.append(tag_id)
        query = f"""
            UPDATE apiome.tags
            SET {', '.join(updates)}
            WHERE id = %s
            RETURNING id, project_id, name, color, description, created_at, updated_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_tag(self, tag_id: str) -> bool:
        """Delete a tag (will cascade delete class_tags due to FK constraint)."""
        query = "DELETE FROM apiome.tags WHERE id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (tag_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def assign_tag_to_class(self, class_id: str, tag_id: str) -> Dict[str, Any]:
        """Assign a tag to a class."""
        query = """
            INSERT INTO apiome.class_tags (class_id, tag_id)
            VALUES (%s, %s)
            ON CONFLICT (class_id, tag_id) DO NOTHING
            RETURNING id, class_id, tag_id, created_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (class_id, tag_id))
                result = cursor.fetchone()
                conn.commit()
                # If conflict, fetch existing record
                if result is None:
                    cursor.execute(
                        "SELECT id, class_id, tag_id, created_at FROM apiome.class_tags WHERE class_id = %s AND tag_id = %s",
                        (class_id, tag_id)
                    )
                    result = cursor.fetchone()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def remove_tag_from_class(self, class_id: str, tag_id: str) -> bool:
        """Remove a tag from a class."""
        query = "DELETE FROM apiome.class_tags WHERE class_id = %s AND tag_id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (class_id, tag_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def get_security_schemes_for_version(self, version_id: str) -> List[Dict[str, Any]]:
        """Get all security schemes for a version (OpenAPI components.securitySchemes)."""
        query = """
            SELECT id, version_id, scheme_name, scheme_type, in_location, param_name, http_scheme, description, data
            FROM apiome.version_security_scheme
            WHERE version_id = %s
            ORDER BY scheme_name
        """
        return self.execute_query(query, (version_id,))

    def get_servers_for_version(self, version_id: str) -> List[Dict[str, Any]]:
        """Get all server definitions for a version (OpenAPI servers array)."""
        query = """
            SELECT id, version_id, name, url, description, sort_order, variables, environment, created_at, updated_at
            FROM apiome.version_server
            WHERE version_id = %s
            ORDER BY sort_order, url
        """
        return self.execute_query(query, (version_id,))

    def get_paths_for_version(self, version_id: str) -> List[Dict[str, Any]]:
        """Get all paths for a specific version."""
        query = """
            SELECT
                id,
                pathname,
                metadata->>'summary' as summary,
                metadata->>'description' as description
            FROM apiome.version_path
            WHERE version_id = %s
            ORDER BY pathname
        """
        return self.execute_query(query, (version_id,))

    def get_operations_for_path(self, version_path_id: str) -> List[Dict[str, Any]]:
        """Get all operations for a specific path."""
        query = """
            SELECT id, version_path_id, operation, metadata, created_at, updated_at
            FROM apiome.path_operation
            WHERE version_path_id = %s
            ORDER BY CASE operation
                WHEN 'GET' THEN 1 WHEN 'POST' THEN 2 WHEN 'PUT' THEN 3
                WHEN 'PATCH' THEN 4 WHEN 'DELETE' THEN 5 ELSE 6
            END
        """
        return self.execute_query(query, (version_path_id,))

    def get_operation_description(self, path_operation_id: str) -> Optional[Dict[str, Any]]:
        """Get operation description."""
        query = """
            SELECT
                id,
                summary,
                description,
                operation_id,
                metadata->'tags' as tags,
                (metadata->>'deprecated')::boolean as deprecated,
                (metadata->>'x-private')::boolean as x_private,
                metadata->'external_docs' as external_docs,
                metadata
            FROM apiome.path_operation_description
            WHERE path_operation_id = %s
            LIMIT 1
        """
        results = self.execute_query(query, (path_operation_id,))
        return results[0] if results else None

    def get_parameters_for_operation(self, path_operation_id: str) -> List[Dict[str, Any]]:
        """Get all parameters linked to an operation."""
        query = """
            SELECT spp.id, spp.name, spp.in_location, spp.summary, spp.description, spp.data
            FROM apiome.shared_path_parameter spp
            INNER JOIN apiome.path_operation_parameter_link popl ON spp.id = popl.shared_path_parameter_id
            WHERE popl.path_operation_id = %s
            ORDER BY CASE spp.in_location
                WHEN 'path' THEN 1 WHEN 'query' THEN 2 WHEN 'header' THEN 3 ELSE 4
            END, spp.name
        """
        return self.execute_query(query, (path_operation_id,))

    def get_request_body_for_operation(self, path_operation_id: str) -> Optional[Dict[str, Any]]:
        """Get request body linked to an operation with content types."""
        query = """
            SELECT rb.id, rb.name, rb.description, rb.required,
                COALESCE(json_agg(json_build_object(
                    'id', rbc.id, 'media_type', rbc.media_type, 'class_id', rbc.class_id,
                    'class_name', c.name, 'inline_schema', rbc.inline_schema,
                    'encoding', rbc.encoding, 'examples', rbc.examples
                )) FILTER (WHERE rbc.id IS NOT NULL), '[]') as content_types
            FROM apiome.shared_path_request_body rb
            INNER JOIN apiome.path_operation_request_body_link link ON rb.id = link.shared_path_request_body_id
            LEFT JOIN apiome.shared_path_request_body_content rbc ON rb.id = rbc.shared_path_request_body_id
            LEFT JOIN apiome.classes c ON rbc.class_id = c.id
            WHERE link.path_operation_id = %s
            GROUP BY rb.id
        """
        results = self.execute_query(query, (path_operation_id,))
        return results[0] if results else None

    def get_responses_for_operation(self, path_operation_id: str) -> List[Dict[str, Any]]:
        """Get all responses linked to an operation with content types."""
        query = """
            SELECT
                spr.id,
                spr.status_code,
                spr.description,
                spr.data,
                spr.class_id,
                c.name as class_name,
                spr.inline_schema,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', rc.id,
                            'media_type', rc.media_type,
                            'class_id', rc.class_id,
                            'class_name', rc_class.name,
                            'inline_schema', rc.inline_schema,
                            'examples', rc.examples
                        )
                    ) FILTER (WHERE rc.id IS NOT NULL),
                    '[]'
                ) as content_types
            FROM apiome.shared_path_response spr
            INNER JOIN apiome.path_operation_response_link porl ON spr.id = porl.shared_path_response_id
            LEFT JOIN apiome.classes c ON spr.class_id = c.id
            LEFT JOIN apiome.shared_path_response_content rc ON spr.id = rc.shared_path_response_id
            LEFT JOIN apiome.classes rc_class ON rc.class_id = rc_class.id
            WHERE porl.path_operation_id = %s
            GROUP BY spr.id, spr.status_code, spr.description, spr.data, spr.class_id, c.name, spr.inline_schema
            ORDER BY spr.status_code
        """
        return self.execute_query(query, (path_operation_id,))

    def registry_ping(self) -> Dict[str, Any]:
        """Probe the Primitives type-registry storage backend (#3450).

        The registry lives in the existing ``apiome-db`` database, backed
        by the ``apiome.primitives`` table (see ROADMAP_TYPE_REGISTRY_GOVERNANCE.md
        §1a — single database, no separate registry DB). This runs a single
        lightweight query that both confirms the shared connection is actually
        live (not merely an object that claims to be open) and reports whether
        the registry's storage table is present.

        Returns:
            A dict with:
              - ``connection``: ``"connected"`` when the query succeeds.
              - ``storage_present``: ``True`` when ``apiome.primitives`` exists.

        Raises:
            Exception: Propagated from the driver when the apiome-db
            connection cannot be established or the probe query fails, so the
            caller can report an unhealthy registry layer.
        """
        rows = self.execute_query(
            "SELECT to_regclass('apiome.primitives') IS NOT NULL AS storage_present"
        )
        storage_present = bool(rows and rows[0].get("storage_present"))
        return {"connection": "connected", "storage_present": storage_present}

    def get_primitives_for_tenant(self, tenant_id: str, category: Optional[str] = None) -> List[Dict[str, Any]]:
        """List the primitives a tenant may read: system-core ∪ the tenant's own (#3453).

        Read scope is ``is_system = true`` (shared system-core types, visible to every
        tenant) unioned with ``tenant_id = <caller>`` (the tenant's private types). A
        different tenant's private types are never returned, so Tenant A cannot read
        Tenant B's custom types. System-core types are seeded per tenant, so a tenant
        that already owns a core row would otherwise see it twice; ``DISTINCT ON
        (category, name)`` collapses those, preferring the caller's own row.

        Args:
            tenant_id: The caller's tenant id (scopes visibility).
            category: Optional category filter.

        Returns:
            The visible primitives, ordered by category then name.
        """
        query = """
            SELECT DISTINCT ON (category, name)
                   id, tenant_id, name, description, category, schema, tags,
                   created_by, is_system, is_public, usage_count, source,
                   schema_id, draft, namespace, base_uri, refs,
                   created_at, updated_at
            FROM apiome.primitives
            WHERE (tenant_id = %s OR is_system = true)
        """
        params = [tenant_id]

        if category:
            query += " AND category = %s"
            params.append(category)

        # Within each (category, name) group prefer the caller's own row over a
        # foreign system-core copy; the leading keys satisfy DISTINCT ON.
        query += " ORDER BY category, name, (tenant_id = %s) DESC"
        params.append(tenant_id)
        return self.execute_query(query, tuple(params))

    def get_primitive_by_id(self, primitive_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a primitive by ID within the tenant's read scope: system-core ∪ own (#3453).

        Returns the row when it is the tenant's own or a shared system-core type; a
        different tenant's private type resolves to ``None`` (cross-tenant isolation).
        System-core rows are read-only — the route layer rejects writes to them — so
        returning one here for a read does not grant write access.

        Args:
            primitive_id: The primitive id.
            tenant_id: The caller's tenant id (scopes visibility).

        Returns:
            The primitive row, or None when missing or not visible to the tenant.
        """
        query = """
            SELECT id, tenant_id, name, description, category, schema, tags,
                   created_by, is_system, is_public, usage_count, source,
                   schema_id, draft, namespace, base_uri, refs,
                   created_at, updated_at
            FROM apiome.primitives
            WHERE id = %s AND (tenant_id = %s OR is_system = true)
        """
        results = self.execute_query(query, (primitive_id, tenant_id))
        return results[0] if results else None

    def get_primitive_by_schema_id(
        self, schema_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Resolve a primitive by its JSON Schema ``$id`` within the tenant's read scope (#3456).

        Backs relative ``$ref`` resolution: a resolved absolute registry URI is matched
        against ``apiome.primitives.schema_id``. Scope is the same as the other reads —
        system-core ∪ the caller's own — so a tenant resolves only to shared system-core
        or its own types, never to another tenant's private type (honoring #3453). When
        system-core types are seeded per tenant, the caller's own copy is preferred.

        Args:
            schema_id: The absolute ``$id`` to resolve (the ref's resolved target URI).
            tenant_id: The caller's tenant id (scopes visibility).

        Returns:
            The matching primitive row, or None when no visible type has that ``$id``.
        """
        query = """
            SELECT id, tenant_id, name, description, category, schema, tags,
                   created_by, is_system, is_public, usage_count, source,
                   schema_id, draft, namespace, base_uri, refs,
                   created_at, updated_at
            FROM apiome.primitives
            WHERE schema_id = %s AND (tenant_id = %s OR is_system = true)
            ORDER BY (tenant_id = %s) DESC
            LIMIT 1
        """
        results = self.execute_query(query, (schema_id, tenant_id, tenant_id))
        return results[0] if results else None

    def create_primitive(
        self,
        tenant_id: str,
        name: str,
        category: str,
        schema: Dict[str, Any],
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
        created_by: Optional[str] = None,
        source: str = 'human',
        schema_id: Optional[str] = None,
        draft: str = '2020-12',
        namespace: Optional[str] = None,
        base_uri: Optional[str] = None,
        refs: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """Create a new primitive.

        Args:
            source: Provenance of the primitive — 'human' (authored in-app, default)
                or 'imported' (created by an import). Stored on apiome.primitives.source.
            schema_id: The computed JSON Schema ``$id`` for the primitive (#3452).
            draft: The JSON Schema dialect/draft, default '2020-12' (#3452).
            namespace: Optional registry namespace path locating the primitive (#3452).
            base_uri: Optional namespace base URI the ``$id`` was computed against (#3452).
            refs: Resolved relative-``$ref`` edges for the schema, each
                ``{relative_ref, resolved_target, status}`` (#3456). Defaults to ``[]``.
        """
        query = """
            INSERT INTO apiome.primitives
            (tenant_id, name, description, category, schema, tags, created_by, source,
             schema_id, draft, namespace, base_uri, refs)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, tenant_id, name, description, category, schema, tags,
                      created_by, is_system, is_public, usage_count, source,
                      schema_id, draft, namespace, base_uri, refs,
                      created_at, updated_at
        """

        import json
        schema_json = json.dumps(schema)
        refs_json = json.dumps(refs or [])

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (tenant_id, name, description, category, schema_json, tags or [],
                     created_by, source, schema_id, draft, namespace, base_uri, refs_json)
                )
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_primitive(
        self,
        primitive_id: str,
        tenant_id: str,
        updates: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update an existing primitive, ensuring it belongs to the tenant."""
        import json

        # Build dynamic update query
        update_fields = []
        params = []

        if 'name' in updates and updates['name'] is not None:
            update_fields.append("name = %s")
            params.append(updates['name'])
        if 'description' in updates and updates['description'] is not None:
            update_fields.append("description = %s")
            params.append(updates['description'])
        if 'category' in updates and updates['category'] is not None:
            update_fields.append("category = %s")
            params.append(updates['category'])
        if 'schema' in updates and updates['schema'] is not None:
            update_fields.append("schema = %s")
            params.append(json.dumps(updates['schema']))
        if 'tags' in updates and updates['tags'] is not None:
            update_fields.append("tags = %s")
            params.append(updates['tags'])
        if 'enabled' in updates and updates['enabled'] is not None:
            update_fields.append("enabled = %s")
            params.append(updates['enabled'])
        # JSON Schema 2020-12 registry identity columns (#3452). Re-derived by the
        # route whenever the schema or registry placement changes.
        if 'schema_id' in updates and updates['schema_id'] is not None:
            update_fields.append("schema_id = %s")
            params.append(updates['schema_id'])
        if 'draft' in updates and updates['draft'] is not None:
            update_fields.append("draft = %s")
            params.append(updates['draft'])
        if 'namespace' in updates and updates['namespace'] is not None:
            update_fields.append("namespace = %s")
            params.append(updates['namespace'])
        if 'base_uri' in updates and updates['base_uri'] is not None:
            update_fields.append("base_uri = %s")
            params.append(updates['base_uri'])
        # Resolved relative-$ref edges, re-derived by the route whenever the schema or
        # registry placement changes (#3456). May be an empty list (no edges), so the
        # presence of the key — not its truthiness — drives the write.
        if 'refs' in updates and updates['refs'] is not None:
            update_fields.append("refs = %s")
            params.append(json.dumps(updates['refs']))

        if not update_fields:
            # Nothing to update, return current primitive
            return self.get_primitive_by_id(primitive_id, tenant_id)

        params.extend([primitive_id, tenant_id])
        query = f"""
            UPDATE apiome.primitives
            SET {', '.join(update_fields)}
            WHERE id = %s AND tenant_id = %s
            RETURNING id, tenant_id, name, description, category, schema, tags,
                      created_by, is_system, is_public, usage_count, source,
                      schema_id, draft, namespace, base_uri, refs,
                      created_at, updated_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_primitive(self, primitive_id: str, tenant_id: str) -> bool:
        """Delete a primitive, ensuring it belongs to the tenant."""
        query = """
            DELETE FROM apiome.primitives
            WHERE id = %s AND tenant_id = %s AND is_system = false
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (primitive_id, tenant_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def increment_primitive_usage(self, primitive_id: str) -> None:
        """Increment the usage count for a primitive."""
        query = "UPDATE apiome.primitives SET usage_count = usage_count + 1 WHERE id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (primitive_id,))
                conn.commit()
        except Exception:
            pass  # Don't fail if we can't increment usage

    # ============== Unresolved-$ref detection, flags & counts (#3457) ==============
    #
    # A primitive's relative ``$ref`` edges live in the ``refs`` JSONB column, each
    # ``{relative_ref, resolved_target, status}`` with status resolved|unresolved (#3456).
    # The aggregates below summarize the unresolved edges for the registry overview KPIs
    # (#3454) and the resolver UI (#3470); ``mark_refs_resolved_to_target`` clears the
    # unresolved flag on dependents once the referenced target is created (re-resolve).
    #
    # Scope note: system-core primitives are seeded *per tenant* (one ``apiome.primitives``
    # row per tenant, with ``is_system = true``), so the tenant's own ``tenant_id`` rows
    # already include a copy of every visible system type. The aggregates therefore scope
    # to ``tenant_id = <caller>`` alone — adding ``OR is_system = true`` would re-count
    # every *other* tenant's system copies. Unresolved edges only ever occur on a tenant's
    # authored/imported types anyway (the std/v0 seed resolves fully).

    def count_unresolved_refs(self, tenant_id: str) -> Dict[str, int]:
        """Count the tenant's unresolved ``$ref`` edges and the primitives carrying them (#3457).

        Aggregates over the ``refs`` JSONB column of the tenant's primitives, feeding the
        registry overview KPIs (#3454) and the resolver UI (#3470).

        Args:
            tenant_id: The caller's tenant id (scopes the aggregate — see section note).

        Returns:
            ``{"unresolved_ref_count": int, "affected_primitive_count": int}`` —
            the total number of unresolved edges and the number of distinct primitives
            that have at least one. Both are ``0`` when nothing is unresolved.
        """
        query = """
            SELECT
                COUNT(*) FILTER (WHERE edge->>'status' = 'unresolved')
                    AS unresolved_ref_count,
                COUNT(DISTINCT p.id) FILTER (WHERE edge->>'status' = 'unresolved')
                    AS affected_primitive_count
            FROM apiome.primitives p
            LEFT JOIN LATERAL jsonb_array_elements(p.refs) AS edge ON true
            WHERE p.tenant_id = %s
        """
        results = self.execute_query(query, (tenant_id,))
        row = results[0] if results else {}
        return {
            "unresolved_ref_count": int(row.get("unresolved_ref_count") or 0),
            "affected_primitive_count": int(row.get("affected_primitive_count") or 0),
        }

    def get_registry_coverage_stats(self, tenant_id: str) -> Dict[str, int]:
        """Aggregate registry coverage KPIs for the Primitives overview (#3454).

        Type counts use the tenant's own ``apiome.primitives`` rows (system-core types are
        seeded per tenant). Property bindings count ``class_properties`` rows in the
        tenant's projects that carry a ``primitive_id`` or ``primitive_ref``.

        Args:
            tenant_id: The caller's tenant id.

        Returns:
            Counts for core/tenant/imported types, bindings, unresolved refs, and namespaces.
        """
        query = """
            WITH type_counts AS (
                SELECT
                    COUNT(*) FILTER (WHERE is_system) AS core_type_count,
                    COUNT(*) FILTER (WHERE NOT is_system) AS tenant_type_count,
                    COUNT(*) FILTER (WHERE source = 'imported') AS imported_count,
                    COUNT(DISTINCT namespace) FILTER (WHERE namespace IS NOT NULL)
                        AS namespace_count
                FROM apiome.primitives
                WHERE tenant_id = %s
            ),
            binding_counts AS (
                SELECT
                    COUNT(*) AS properties_bound_count,
                    COUNT(DISTINCT cp.class_id) AS bound_class_count
                FROM apiome.class_properties cp
                JOIN apiome.classes c ON cp.class_id = c.id
                JOIN apiome.versions v ON c.version_id = v.id
                JOIN apiome.projects p ON v.project_id = p.id
                WHERE p.tenant_id = %s
                  AND (cp.primitive_id IS NOT NULL OR cp.primitive_ref IS NOT NULL)
            ),
            unresolved AS (
                SELECT
                    COUNT(*) FILTER (WHERE edge->>'status' = 'unresolved')
                        AS unresolved_ref_count
                FROM apiome.primitives p
                LEFT JOIN LATERAL jsonb_array_elements(p.refs) AS edge ON true
                WHERE p.tenant_id = %s
            )
            SELECT
                tc.core_type_count,
                tc.tenant_type_count,
                tc.imported_count,
                tc.namespace_count,
                bc.properties_bound_count,
                bc.bound_class_count,
                u.unresolved_ref_count
            FROM type_counts tc
            CROSS JOIN binding_counts bc
            CROSS JOIN unresolved u
        """
        results = self.execute_query(query, (tenant_id, tenant_id, tenant_id))
        row = results[0] if results else {}
        return {
            "core_type_count": int(row.get("core_type_count") or 0),
            "tenant_type_count": int(row.get("tenant_type_count") or 0),
            "imported_count": int(row.get("imported_count") or 0),
            "namespace_count": int(row.get("namespace_count") or 0),
            "properties_bound_count": int(row.get("properties_bound_count") or 0),
            "bound_class_count": int(row.get("bound_class_count") or 0),
            "unresolved_ref_count": int(row.get("unresolved_ref_count") or 0),
        }

    def get_primitives_with_unresolved_refs(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List the tenant's primitives that have at least one unresolved ``$ref`` edge (#3457).

        Backs the resolver UI's dangling-reference table (#3470): each returned row
        carries the primitive's identity plus its full ``refs`` edge list (the route
        narrows it to the unresolved edges).

        Args:
            tenant_id: The caller's tenant id (scopes the listing — see section note).

        Returns:
            The matching primitive rows (id, name, schema_id, namespace, base_uri, refs),
            ordered by namespace then name. Empty when nothing is unresolved.
        """
        query = """
            SELECT id, tenant_id, name, schema_id, namespace, base_uri, refs
            FROM apiome.primitives
            WHERE tenant_id = %s
              AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(refs) AS e
                  WHERE e->>'status' = 'unresolved'
              )
            ORDER BY namespace NULLS FIRST, name
        """
        return self.execute_query(query, (tenant_id,))

    def mark_refs_resolved_to_target(self, tenant_id: str, target_schema_id: str) -> int:
        """Clear the unresolved flag on edges that point at a now-existing target (#3457).

        When a primitive is created/imported (or repinned), any of the tenant's other
        primitives that carried an *unresolved* edge whose ``resolved_target`` equals the
        new primitive's ``$id`` are re-resolved: just that edge flips to ``resolved`` in
        place, preserving edge order and leaving every other edge untouched. This is the
        "fixing target clears on re-resolve" half of the acceptance criteria — it runs
        without requiring the dependent primitive to be re-saved by hand.

        Only the tenant's own rows are rewritten (system-core rows are seeded/immutable),
        and only edges that are both unresolved *and* aimed at ``target_schema_id`` change.

        Args:
            tenant_id: The tenant whose primitives may reference the new target.
            target_schema_id: The absolute ``$id`` of the just-created/updated primitive.

        Returns:
            The number of dependent primitives whose ``refs`` were updated (0 when none
            referenced the target as unresolved).
        """
        query = """
            UPDATE apiome.primitives p
            SET refs = (
                SELECT jsonb_agg(
                    CASE
                        WHEN e->>'resolved_target' = %s AND e->>'status' = 'unresolved'
                        THEN jsonb_set(e, '{status}', '"resolved"'::jsonb)
                        ELSE e
                    END
                    ORDER BY ord
                )
                FROM jsonb_array_elements(p.refs) WITH ORDINALITY AS t(e, ord)
            )
            WHERE p.tenant_id = %s
              AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(p.refs) AS e2
                  WHERE e2->>'resolved_target' = %s AND e2->>'status' = 'unresolved'
              )
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (target_schema_id, tenant_id, target_schema_id))
                affected = cursor.rowcount
                conn.commit()
                return affected
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Primitive Import Provenance (#3448) ====================

    def create_primitive_import(
        self,
        tenant_id: str,
        report: Dict[str, Any],
        source_kind: str = 'json-schema',
        source_label: Optional[str] = None,
        target_namespace: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
        imported_count: int = 0,
        skipped_count: int = 0,
        error_count: int = 0,
        imported_by: Optional[str] = None
    ) -> Dict[str, Any]:
        """Record an auditable provenance row for a primitive import.

        Args:
            tenant_id: The tenant the import ran for.
            report: The import outcome report (imported/skipped/errors lists + counts).
            source_kind: Shape of the source document — one of 'json-schema',
                'type-def-bundle', 'openapi'.
            source_label: Optional human label (filename / URL) of the source.
            target_namespace: Optional registry namespace imported into.
            options: Import options echoed back for reproducibility.
            imported_count/skipped_count/error_count: Outcome tallies.
            imported_by: The authenticated user id (None for API-key auth).

        Returns:
            The persisted provenance row.
        """
        import json

        query = """
            INSERT INTO apiome.primitive_imports
            (tenant_id, source_kind, source_label, target_namespace, options, report,
             imported_count, skipped_count, error_count, imported_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, tenant_id, source_kind, source_label, target_namespace,
                      options, report, imported_count, skipped_count, error_count,
                      imported_by, created_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (
                        tenant_id, source_kind, source_label, target_namespace,
                        json.dumps(options or {}), json.dumps(report),
                        imported_count, skipped_count, error_count, imported_by
                    )
                )
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def get_primitive_imports(
        self, tenant_id: str, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """List primitive import provenance records for a tenant, newest first."""
        query = """
            SELECT id, tenant_id, source_kind, source_label, target_namespace,
                   options, report, imported_count, skipped_count, error_count,
                   imported_by, created_at
            FROM apiome.primitive_imports
            WHERE tenant_id = %s
            ORDER BY created_at DESC
            LIMIT %s
        """
        return self.execute_query(query, (tenant_id, limit))

    def get_primitive_import_by_id(
        self, import_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get a single primitive import provenance record scoped to the tenant."""
        query = """
            SELECT id, tenant_id, source_kind, source_label, target_namespace,
                   options, report, imported_count, skipped_count, error_count,
                   imported_by, created_at
            FROM apiome.primitive_imports
            WHERE id = %s AND tenant_id = %s
        """
        results = self.execute_query(query, (import_id, tenant_id))
        return results[0] if results else None

    # ==================== Type-registry Namespaces (#3451) ====================
    #
    # Namespaces are the durable scope/base-uri/version-root/visibility/default records of the
    # type registry, stored in apiome.type_namespaces. Their `namespace` column mirrors
    # apiome.primitives.namespace, which is the join key for a namespace's type count.

    def list_type_namespaces(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List the namespaces visible to a tenant: system-core ∪ this tenant's own.

        Each row carries a ``type_count``: the number of ``apiome.primitives`` rows the caller's
        tenant has in that namespace (system-core primitives are seeded per tenant, so the count
        is correct from the caller's perspective for both scopes).

        Args:
            tenant_id: The caller's tenant id.

        Returns:
            Namespace rows (system-core first, then alphabetical), each with ``type_count``.
        """
        query = """
            SELECT n.id, n.tenant_id, n.namespace, n.base_uri, n.version_root,
                   n.description, n.is_system, n.is_public, n.is_default,
                   n.created_by, n.created_at, n.updated_at,
                   (SELECT COUNT(*) FROM apiome.primitives p
                     WHERE p.namespace = n.namespace AND p.tenant_id = %s::uuid) AS type_count
            FROM apiome.type_namespaces n
            WHERE n.is_system = true OR n.tenant_id = %s::uuid
            ORDER BY n.is_system DESC, n.namespace ASC
        """
        return self.execute_query(query, (tenant_id, tenant_id))

    def get_type_namespace_by_id(
        self, namespace_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get a single namespace visible to a tenant (system-core or its own), with type count.

        Args:
            namespace_id: The namespace row id.
            tenant_id: The caller's tenant id (scopes visibility).

        Returns:
            The namespace row with ``type_count``, or None when missing/not visible.
        """
        query = """
            SELECT n.id, n.tenant_id, n.namespace, n.base_uri, n.version_root,
                   n.description, n.is_system, n.is_public, n.is_default,
                   n.created_by, n.created_at, n.updated_at,
                   (SELECT COUNT(*) FROM apiome.primitives p
                     WHERE p.namespace = n.namespace AND p.tenant_id = %s::uuid) AS type_count
            FROM apiome.type_namespaces n
            WHERE n.id = %s::uuid AND (n.is_system = true OR n.tenant_id = %s::uuid)
        """
        results = self.execute_query(query, (tenant_id, namespace_id, tenant_id))
        return results[0] if results else None

    def get_type_namespace_by_path(
        self, namespace: str, tenant_id: str, is_system: bool
    ) -> Optional[Dict[str, Any]]:
        """Look up a namespace by its path within a scope (for conflict detection).

        Args:
            namespace: The registry path (e.g. tenant/acme/v1/types).
            tenant_id: The owning tenant id (ignored when is_system is True).
            is_system: True to match a system-core path, False to match this tenant's path.

        Returns:
            The matching namespace row, or None.
        """
        if is_system:
            query = """
                SELECT id, tenant_id, namespace, base_uri, version_root, description,
                       is_system, is_public, is_default, created_by, created_at, updated_at
                FROM apiome.type_namespaces
                WHERE is_system = true AND namespace = %s
            """
            results = self.execute_query(query, (namespace,))
        else:
            query = """
                SELECT id, tenant_id, namespace, base_uri, version_root, description,
                       is_system, is_public, is_default, created_by, created_at, updated_at
                FROM apiome.type_namespaces
                WHERE is_system = false AND tenant_id = %s::uuid AND namespace = %s
            """
            results = self.execute_query(query, (tenant_id, namespace))
        return results[0] if results else None

    def create_type_namespace(
        self,
        namespace: str,
        base_uri: str,
        *,
        tenant_id: Optional[str],
        version_root: Optional[str] = None,
        description: Optional[str] = None,
        is_system: bool = False,
        is_public: bool = False,
        is_default: bool = False,
        created_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a namespace.

        When ``is_default`` is True, any existing default in the same scope (system-core, or this
        tenant) is cleared first so at most one default exists per scope — done in one transaction.

        Args:
            namespace: The registry path (unique within its scope).
            base_uri: Base URL the namespace's relative $ref values resolve against.
            tenant_id: Owning tenant id; None for a system-core namespace.
            version_root: Version segment (e.g. v1); derived by the caller when omitted.
            description: Optional human description.
            is_system: True for a platform-curated system-core namespace.
            is_public: True when visible to all tenants (always True for system-core).
            is_default: True to make this the default namespace for its scope.
            created_by: The authenticated user id (None for API-key auth).

        Returns:
            The persisted namespace row (with ``type_count`` of 0).
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                if is_default:
                    self._clear_default_type_namespace(cursor, tenant_id, is_system)
                cursor.execute(
                    """
                    INSERT INTO apiome.type_namespaces
                    (tenant_id, namespace, base_uri, version_root, description,
                     is_system, is_public, is_default, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id, tenant_id, namespace, base_uri, version_root, description,
                              is_system, is_public, is_default, created_by, created_at, updated_at
                    """,
                    (
                        tenant_id, namespace, base_uri, version_root, description,
                        is_system, is_public, is_default, created_by,
                    ),
                )
                result = cursor.fetchone()
                conn.commit()
                result["type_count"] = 0
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_type_namespace(
        self, namespace_id: str, tenant_id: str, updates: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update a namespace's mutable fields (base_uri, version_root, description, visibility,
        default), ensuring it belongs to the tenant. The namespace path itself is immutable — it
        links the namespace to its ``apiome.primitives`` rows.

        When ``is_default`` is set True, any existing default in the same scope is cleared first.

        Args:
            namespace_id: The namespace row id.
            tenant_id: The owning tenant id (scopes the write).
            updates: Subset of base_uri / version_root / description / is_public / is_default.

        Returns:
            The updated namespace row with ``type_count``, or None when not found for the tenant.
        """
        allowed = ("base_uri", "version_root", "description", "is_public", "is_default")
        update_fields = []
        params: List[Any] = []
        for field in allowed:
            if field in updates and updates[field] is not None:
                update_fields.append(f"{field} = %s")
                params.append(updates[field])

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                if updates.get("is_default") is True:
                    self._clear_default_type_namespace(cursor, tenant_id, is_system=False)

                if not update_fields:
                    conn.commit()
                    return self.get_type_namespace_by_id(namespace_id, tenant_id)

                update_fields.append("updated_at = CURRENT_TIMESTAMP")
                params.extend([namespace_id, tenant_id])
                cursor.execute(
                    f"""
                    UPDATE apiome.type_namespaces
                    SET {', '.join(update_fields)}
                    WHERE id = %s::uuid AND tenant_id = %s::uuid AND is_system = false
                    RETURNING id
                    """,
                    tuple(params),
                )
                updated = cursor.fetchone()
                conn.commit()
                if not updated:
                    return None
                return self.get_type_namespace_by_id(namespace_id, tenant_id)
        except Exception as e:
            conn.rollback()
            raise e

    @staticmethod
    def _clear_default_type_namespace(cursor, tenant_id: Optional[str], is_system: bool) -> None:
        """Clear the current default namespace in a scope so a new default can be set.

        Runs on the caller's open cursor/transaction. System-core and tenant scopes are disjoint:
        system-core clears where is_system is true; a tenant clears its own rows.
        """
        if is_system:
            cursor.execute(
                "UPDATE apiome.type_namespaces SET is_default = false "
                "WHERE is_system = true AND is_default = true"
            )
        else:
            cursor.execute(
                "UPDATE apiome.type_namespaces SET is_default = false "
                "WHERE tenant_id = %s::uuid AND is_system = false AND is_default = true",
                (tenant_id,),
            )

    # ==================== Type-registry settings (#3472) ====================

    # The mutable settings columns, in one place so the read projection and the upsert write
    # list stay in lock-step (a column added to one but not the other would silently drop).
    TYPE_REGISTRY_SETTINGS_COLUMNS = (
        "default_draft",
        "strict_validation",
        "allow_annotation_keywords",
        "coerce_imported_drafts",
        "resolution_base_url",
        "ref_style",
        "allow_remote_refs",
        "remote_host_allowlist",
        "max_resolution_depth",
        "circular_ref_policy",
        "default_import_scope",
        "default_target_namespace",
        "rewrite_refs_on_import",
        "accepted_formats",
        "dedupe_identical_types",
        "validate_on_save",
        "block_publish_on_errors",
        "core_publish_role",
    )

    def get_type_registry_settings(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a tenant's persisted type-registry settings (#3472).

        Returns the saved row when one exists. A tenant that has never saved settings has no
        row; this returns ``None`` and the route layer serves the model defaults (the GET is a
        pure read and never materializes a row).

        Args:
            tenant_id: The caller's tenant id.

        Returns:
            The settings row, or None when the tenant has not saved settings yet.
        """
        columns = ", ".join(self.TYPE_REGISTRY_SETTINGS_COLUMNS)
        query = f"""
            SELECT {columns}, updated_by, created_at, updated_at
            FROM apiome.type_registry_settings
            WHERE tenant_id = %s::uuid
        """
        results = self.execute_query(query, (tenant_id,))
        return results[0] if results else None

    def upsert_type_registry_settings(
        self, tenant_id: str, updates: Dict[str, Any], updated_by: Optional[str] = None
    ) -> Dict[str, Any]:
        """Insert or update a tenant's type-registry settings (#3472).

        The first save for a tenant inserts a row; subsequent saves update only the supplied
        fields and leave the rest untouched (``COALESCE`` keeps the stored value when a column
        is omitted, falling back to the table default on the initial insert). Runs as a single
        upsert keyed on ``tenant_id``.

        Args:
            tenant_id: The owning tenant id.
            updates: Subset of {@link TYPE_REGISTRY_SETTINGS_COLUMNS} to persist; omitted
                columns keep their current value (or the table default on first save).
            updated_by: The authenticated user id making the change (None for API-key auth).

        Returns:
            The full persisted settings row after the write.
        """
        columns = list(self.TYPE_REGISTRY_SETTINGS_COLUMNS)
        # Only the supplied columns get an explicit value; omitted ones fall to their table default
        # on first insert. On conflict we update *only* the supplied columns — an omitted column is
        # left exactly as stored. (We cannot COALESCE over EXCLUDED here: for a column absent from
        # the INSERT list, EXCLUDED.<col> is that column's DEFAULT, not NULL, so a partial update
        # would otherwise reset every untouched column back to its default.)
        supplied = [col for col in columns if col in updates]
        insert_cols = ["tenant_id", "updated_by", *supplied]
        insert_vals: List[Any] = [tenant_id, updated_by, *(updates[col] for col in supplied)]

        set_clauses = [f"{col} = EXCLUDED.{col}" for col in supplied]
        set_clauses.append("updated_by = EXCLUDED.updated_by")
        set_clauses.append("updated_at = CURRENT_TIMESTAMP")

        placeholders = ", ".join(["%s"] * len(insert_vals))
        select_cols = ", ".join(columns)
        query = f"""
            INSERT INTO apiome.type_registry_settings ({", ".join(insert_cols)})
            VALUES ({placeholders})
            ON CONFLICT (tenant_id) DO UPDATE SET {", ".join(set_clauses)}
            RETURNING {select_cols}, updated_by, created_at, updated_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(insert_vals))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Auth Provider Config (OLO-8.2/8.4) ====================

    #: Columns returned for an ``auth_provider_config`` row (V196). ``client_secret_encrypted`` is
    #: deliberately NOT selected on the read paths below: the ciphertext never needs to leave the
    #: DB for the admin CRUD surface (secrets are write-only there), so only its *presence* is
    #: reported via ``enc_key_id``/a boolean flag. The two secret columns are written together to
    #: satisfy the V196 both-or-neither CHECK.
    AUTH_PROVIDER_CONFIG_READ_COLUMNS = (
        "provider_id",
        "enabled",
        "client_id",
        "enc_key_id",
        "config",
        "updated_at",
        "updated_by",
    )

    #: Columns the admin surface may write. ``client_secret_encrypted``/``enc_key_id`` travel as a
    #: pair (both set to store/rotate a secret, both NULL to clear it and fall back to env).
    AUTH_PROVIDER_CONFIG_WRITABLE_COLUMNS = (
        "enabled",
        "client_id",
        "client_secret_encrypted",
        "enc_key_id",
        "config",
    )

    def list_auth_provider_config(self) -> List[Dict[str, Any]]:
        """List every stored provider-config row (server-global; OLO-8.2/8.4, #4970).

        The table is server-wide (one row per provider), not tenant-scoped, so this takes no
        tenant. Only providers with a saved row appear; a provider with no row is governed entirely
        by env (OLO-8.5) and is surfaced by the route layer from the registry instead.

        The encrypted secret is never selected — only ``enc_key_id`` is, so the caller can report
        "secret set / not set" without the ciphertext ever leaving the database.

        Returns:
            One dict per stored provider row, ordered by ``provider_id`` for a stable listing.
        """
        select_cols = ", ".join(self.AUTH_PROVIDER_CONFIG_READ_COLUMNS)
        query = f"""
            SELECT {select_cols}
            FROM apiome.auth_provider_config
            ORDER BY provider_id
        """
        return self.execute_query(query)

    def list_auth_provider_config_with_secret(self) -> List[Dict[str, Any]]:
        """List stored provider rows INCLUDING the encrypted secret (OLO-8.5, #4971).

        The counterpart to :meth:`list_auth_provider_config` for the server-to-server resolved read
        path only: it additionally selects ``client_secret_encrypted`` so the caller can decrypt it
        in-process (:func:`app.auth_provider_secret_crypto.unseal_provider_secret`) and hand the
        plaintext to the login-time provider resolver. This must NEVER back a client-facing response
        — the ciphertext is returned here solely so the internal endpoint can unseal it and drop it.

        Returns:
            One dict per stored provider row, each with ``client_secret_encrypted`` (bytes/None) and
            ``enc_key_id`` alongside the read columns, ordered by ``provider_id``.
        """
        select_cols = ", ".join(
            (*self.AUTH_PROVIDER_CONFIG_READ_COLUMNS, "client_secret_encrypted")
        )
        query = f"""
            SELECT {select_cols}
            FROM apiome.auth_provider_config
            ORDER BY provider_id
        """
        return self.execute_query(query)

    def get_auth_provider_config(self, provider_id: str) -> Optional[Dict[str, Any]]:
        """Read one stored provider-config row (OLO-8.2/8.4, #4970).

        Args:
            provider_id: Provider slug (e.g. ``"github"``).

        Returns:
            The stored row (without the encrypted secret; ``enc_key_id`` signals its presence), or
            ``None`` when the provider has no row (fall back to env for the whole provider).
        """
        select_cols = ", ".join(self.AUTH_PROVIDER_CONFIG_READ_COLUMNS)
        query = f"""
            SELECT {select_cols}
            FROM apiome.auth_provider_config
            WHERE provider_id = %s
        """
        results = self.execute_query(query, (provider_id,))
        return results[0] if results else None

    def upsert_auth_provider_config(
        self, provider_id: str, updates: Dict[str, Any], updated_by: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Insert or partially update a provider-config row (OLO-8.4, #4970).

        Partial-update semantics, mirroring :meth:`upsert_type_registry_settings`: only the columns
        present in ``updates`` are written. An omitted column keeps its stored value on update (or
        falls to the table default on the first insert) — this is what lets the admin surface clear
        one field to env-fallback (pass it explicitly as ``None``) without disturbing the others
        (omit them). ``updated_at`` is maintained by the V196 BEFORE UPDATE trigger on the update
        path and by the column default on insert, so it is never written here.

        The secret columns ``client_secret_encrypted`` and ``enc_key_id`` must be supplied together
        (both set to store/rotate, both ``None`` to clear) so the V196 both-or-neither CHECK always
        holds — the caller (the route layer) is responsible for pairing them.

        Args:
            provider_id: Provider slug — the primary key. Assumed already validated against the
                registry by the caller; the V196 CHECK is the final backstop against a bad slug.
            updates: Subset of :data:`AUTH_PROVIDER_CONFIG_WRITABLE_COLUMNS` to persist. ``config``,
                when present, must be a JSON-serializable dict (wrapped in ``Json`` here).
            updated_by: Identity of the super-admin making the change (recorded in ``updated_by``).

        Returns:
            The persisted row (read columns only — no ciphertext), or ``None`` if the write somehow
            returned nothing.
        """
        supplied = [col for col in self.AUTH_PROVIDER_CONFIG_WRITABLE_COLUMNS if col in updates]

        def _bind(col: str) -> Any:
            value = updates[col]
            # JSONB extras must be adapted so psycopg2 sends valid JSON, not a Python-repr string.
            return Json(value) if col == "config" and value is not None else value

        insert_cols = ["provider_id", "updated_by", *supplied]
        insert_vals: List[Any] = [provider_id, updated_by, *(_bind(col) for col in supplied)]

        # On conflict, update ONLY the supplied columns (never COALESCE over EXCLUDED: for a column
        # absent from the INSERT list EXCLUDED.<col> is that column's DEFAULT, so touching it would
        # reset an untouched field). ``updated_at`` is left to the BEFORE UPDATE trigger.
        set_clauses = [f"{col} = EXCLUDED.{col}" for col in supplied]
        set_clauses.append("updated_by = EXCLUDED.updated_by")

        placeholders = ", ".join(["%s"] * len(insert_vals))
        select_cols = ", ".join(self.AUTH_PROVIDER_CONFIG_READ_COLUMNS)
        query = f"""
            INSERT INTO apiome.auth_provider_config ({", ".join(insert_cols)})
            VALUES ({placeholders})
            ON CONFLICT (provider_id) DO UPDATE SET {", ".join(set_clauses)}
            RETURNING {select_cols}
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(insert_vals))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Project CRUD Operations ====================
    # NOTE: queries below select `change_report_template_version_id`, which requires
    # migration 20260414-150000.sql. Ensure that migration is applied before deploying.

    #: Version rollup for the projects list: live version count plus the mean captured quality
    #: score (AVG ignores NULL scores). Grade is derived from the mean via the same A–F bands as
    #: ``schema_lint.GRADE_THRESHOLDS`` so list cards summarize every version, not only the tip.
    _PROJECT_VERSIONS_SUMMARY_LATERAL = """
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS versions_count,
                       ROUND(AVG(v.quality_score))::int AS quality_score
                FROM apiome.versions v
                WHERE v.project_id = p.id AND v.deleted_at IS NULL
            ) qs ON TRUE
    """

    _PROJECT_VERSIONS_SUMMARY_COLUMNS = """
                   COALESCE(qs.versions_count, 0) AS versions_count,
                   qs.quality_score,
                   CASE
                     WHEN qs.quality_score IS NULL THEN NULL
                     WHEN qs.quality_score >= 90 THEN 'A'
                     WHEN qs.quality_score >= 80 THEN 'B'
                     WHEN qs.quality_score >= 70 THEN 'C'
                     WHEN qs.quality_score >= 60 THEN 'D'
                     ELSE 'F'
                   END AS quality_grade
    """

    def get_projects_for_tenant(
        self, tenant_id: str, *, include_deleted: bool = False
    ) -> List[Dict[str, Any]]:
        """Get all projects for a tenant.

        By default only non-deleted rows are returned. When include_deleted is True,
        soft-deleted projects are included too (active rows first, then deleted).

        Each row carries a versions summary: ``versions_count`` (live revisions) and the mean
        captured ``quality_score`` / derived ``quality_grade`` across those revisions (NULL when
        no revision has been scored yet). Empty projects (``versions_count = 0``) have no scores.
        """
        deleted_filter = "" if include_deleted else "AND p.deleted_at IS NULL"
        order_clause = (
            "ORDER BY (p.deleted_at IS NULL) DESC, p.created_at DESC"
            if include_deleted
            else "ORDER BY p.created_at DESC"
        )
        query = f"""
            SELECT p.id, p.tenant_id, p.creator_id, p.name, p.description, p.slug,
                   p.enabled, p.metadata, p.change_report_template_version_id, p.publishable,
                   p.created_at, p.updated_at,
                   p.deleted_at,
                   u.name as creator_name, u.email as creator_email,
                   {self._PROJECT_VERSIONS_SUMMARY_COLUMNS}
            FROM apiome.projects p
            LEFT JOIN apiome.users u ON p.creator_id = u.id
            {self._PROJECT_VERSIONS_SUMMARY_LATERAL}
            WHERE p.tenant_id = %s {deleted_filter}
            {order_clause}
        """
        return self.execute_query(query, (tenant_id,))

    # The columns a catalog item projects off its latest live revision (MFI-7.1/7.2): the captured
    # lint score/grade plus what *kind* of API it is and the format provenance. Shared by the list
    # and single-item catalog reads so both surfaces project an identical shape.
    _CATALOG_VERSION_LATERAL = """
            LEFT JOIN LATERAL (
                SELECT v.quality_score, v.quality_grade,
                       v.source_format, v.protocol, v.format_metadata,
                       v.source_tool_versions AS tool_versions
                FROM apiome.versions v
                WHERE v.project_id = p.id AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC NULLS LAST, v.id DESC
                LIMIT 1
            ) cv ON TRUE
    """

    #: Live revision count for catalog list/detail cards (parity with projects list ``versions_count``).
    _CATALOG_VERSIONS_COUNT_LATERAL = """
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS versions_count
                FROM apiome.versions v
                WHERE v.project_id = p.id AND v.deleted_at IS NULL
            ) vc ON TRUE
    """

    #: Latest convert-to-OpenAPI provenance for a catalog item (MFI-23.11), joined to the target
    #: publishable Project for its display name/slug/deleted state. A catalog item that has been
    #: converted (apiome.conversion_provenance, MFI-22.5) carries a back-link to the Project it produced,
    #: so the Catalog card/detail can show "Converted -> {project}". LEFT JOINs so an unconverted item
    #: simply yields NULLs (no conversion). ``conv_*`` columns are consumed by the catalog routes.
    _CATALOG_CONVERSION_LATERAL = """
            LEFT JOIN LATERAL (
                SELECT cp.target_project_id, cp.target_version_id, cp.target_version_label,
                       cp.reconverted, cp.fidelity_grade, cp.fidelity_tier, cp.created_at
                FROM apiome.conversion_provenance cp
                WHERE cp.tenant_id = p.tenant_id AND cp.source_project_id = p.id
                ORDER BY cp.created_at DESC
                LIMIT 1
            ) conv ON TRUE
            LEFT JOIN apiome.projects tp ON tp.id = conv.target_project_id
    """

    #: The ``conv_*`` / ``conv_target_*`` SELECT list projecting the conversion lateral above onto
    #: stable, prefixed column names the routes build a :class:`CatalogConversionRef` from.
    _CATALOG_CONVERSION_COLUMNS = """
                   conv.target_project_id AS conv_target_project_id,
                   conv.target_version_id AS conv_target_version_id,
                   conv.target_version_label AS conv_target_version_label,
                   conv.reconverted AS conv_reconverted,
                   conv.fidelity_grade AS conv_fidelity_grade,
                   conv.fidelity_tier AS conv_fidelity_tier,
                   conv.created_at AS conv_converted_at,
                   tp.name AS conv_target_project_name,
                   tp.slug AS conv_target_project_slug,
                   tp.deleted_at AS conv_target_project_deleted_at
    """

    #: Identity group membership for browse facet + detail (MFI-6.4, #4410).
    _CATALOG_IDENTITY_JOIN = """
            LEFT JOIN apiome.api_identity_members aim
              ON aim.tenant_id = p.tenant_id AND aim.project_id = p.id
    """

    def get_catalog_items_for_tenant(
        self,
        tenant_id: str,
        *,
        include_deleted: bool = False,
        identity_group_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """List a tenant's catalog items (MFI-23.1): the ``publishable = false`` slice of projects.

        A catalog item is a projection over the same ``projects`` + ``versions`` tables a Project
        uses, so this mirrors :meth:`get_projects_for_tenant` (creator join, latest-revision quality
        score, soft-delete handling) but (a) filters to non-publishable rows and (b) also projects
        the latest revision's ``source_format`` / ``protocol`` / ``format_metadata`` /
        ``tool_versions`` so the Catalog screen can show each item's format/protocol/source. Live
        rows only by default; ``include_deleted`` appends soft-deleted items (active first).

        When ``identity_group_id`` is set, only catalog items in that cross-format identity group
        are returned (MFI-6.4 browse facet: "show all representations").
        """
        deleted_filter = "" if include_deleted else "AND p.deleted_at IS NULL"
        identity_filter = (
            "AND aim.group_id = %s::uuid" if identity_group_id else ""
        )
        order_clause = (
            "ORDER BY (p.deleted_at IS NULL) DESC, p.created_at DESC"
            if include_deleted
            else "ORDER BY p.created_at DESC"
        )
        query = f"""
            SELECT p.id, p.tenant_id, p.creator_id, p.name, p.description, p.slug,
                   p.enabled, p.metadata, p.change_report_template_version_id, p.publishable,
                   p.created_at, p.updated_at, p.deleted_at,
                   u.name as creator_name, u.email as creator_email,
                   cv.quality_score, cv.quality_grade,
                   cv.source_format, cv.protocol, cv.format_metadata, cv.tool_versions,
                   COALESCE(vc.versions_count, 0) AS versions_count,
                   aim.group_id::text AS identity_group_id,
                   {self._CATALOG_CONVERSION_COLUMNS}
            FROM apiome.projects p
            LEFT JOIN apiome.users u ON p.creator_id = u.id
            {self._CATALOG_VERSION_LATERAL}
            {self._CATALOG_VERSIONS_COUNT_LATERAL}
            {self._CATALOG_CONVERSION_LATERAL}
            {self._CATALOG_IDENTITY_JOIN}
            WHERE p.tenant_id = %s AND p.publishable = false {deleted_filter} {identity_filter}
            {order_clause}
        """
        params: tuple[Any, ...] = (tenant_id,)
        if identity_group_id:
            params = (tenant_id, identity_group_id)
        return self.execute_query(query, params)

    def get_catalog_item_by_id(
        self, item_id: str, tenant_id: str, *, include_deleted: bool = False
    ) -> Optional[Dict[str, Any]]:
        """Get a single catalog item by id, scoped to the tenant (MFI-23.1).

        Like :meth:`get_project_by_id` but restricted to non-publishable rows and carrying the
        latest revision's format/protocol/source projection. Returns ``None`` when no non-publishable
        project with that id exists for the tenant (a publishable Project is *not* a catalog item and
        is intentionally not returned here).
        """
        deleted_clause = "" if include_deleted else "AND p.deleted_at IS NULL"
        query = f"""
            SELECT p.id, p.tenant_id, p.creator_id, p.name, p.description, p.slug,
                   p.enabled, p.metadata, p.change_report_template_version_id, p.publishable,
                   p.created_at, p.updated_at, p.deleted_at,
                   u.name as creator_name, u.email as creator_email,
                   cv.quality_score, cv.quality_grade,
                   cv.source_format, cv.protocol, cv.format_metadata, cv.tool_versions,
                   COALESCE(vc.versions_count, 0) AS versions_count,
                   aim.group_id::text AS identity_group_id,
                   {self._CATALOG_CONVERSION_COLUMNS}
            FROM apiome.projects p
            LEFT JOIN apiome.users u ON p.creator_id = u.id
            {self._CATALOG_VERSION_LATERAL}
            {self._CATALOG_VERSIONS_COUNT_LATERAL}
            {self._CATALOG_CONVERSION_LATERAL}
            {self._CATALOG_IDENTITY_JOIN}
            WHERE p.id = %s AND p.tenant_id = %s AND p.publishable = false {deleted_clause}
        """
        results = self.execute_query(query, (item_id, tenant_id))
        return results[0] if results else None

    def set_version_quality_score(
        self,
        version_record_id: str,
        tenant_id: str,
        score: int,
        grade: str,
        report_fingerprint: Optional[str] = None,
        quality_report: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Persist the captured quality/lint score onto a revision (#3609 follow-up).

        Scoped to ``tenant_id`` via the owning project so a caller cannot write a score onto another
        tenant's revision. When ``quality_report`` is supplied, the full report JSON (findings,
        tallies, categories) is stored alongside the headline score/grade/fingerprint so lint
        routes can serve the import-time report without recomputing. Returns True when a row was
        updated.
        """
        report_json = Json(quality_report if quality_report is not None else {})
        query = """
            UPDATE apiome.versions v
            SET quality_score = %s,
                quality_grade = %s,
                quality_report_fingerprint = %s,
                quality_report = %s::jsonb,
                updated_at = CURRENT_TIMESTAMP
            FROM apiome.projects p
            WHERE v.id = %s
              AND v.project_id = p.id
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
            RETURNING v.id
        """
        rows = self.execute_query(
            query,
            (score, grade, report_fingerprint, report_json, version_record_id, tenant_id),
        )
        if rows and quality_report and quality_report.get("report_fingerprint"):
            # CLX-1.1 (#4848): every persisted native report is also represented in the
            # immutable evidence substrate. Best-effort: evidence must never break scoring.
            try:
                self.record_lint_evidence_run(native_evidence_run(version_record_id, quality_report))
            except Exception:  # noqa: BLE001 - evidence capture is strictly additive
                _logger.warning(
                    "Failed to record lint evidence for revision %s",
                    version_record_id,
                    exc_info=True,
                )
            # CLX-1.2 (#4849): mirror the report into a versioned multi-axis evaluation.
            try:
                self.record_axis_evaluation(
                    evaluation_row(
                        catalog_axis_evaluation(quality_report),
                        subject_type=SUBJECT_CATALOG_REVISION,
                        subject_id=version_record_id,
                    )
                )
            except Exception:  # noqa: BLE001 - axis capture is strictly additive
                _logger.warning(
                    "Failed to record axis evaluation for revision %s",
                    version_record_id,
                    exc_info=True,
                )
        return bool(rows)

    def record_lint_evidence_run(self, run: Dict[str, Any]) -> Optional[str]:
        """Insert one write-once lint evidence run (CLX-1.1, #4848).

        Evidence rows are immutable and append-only (``lint_evidence_runs``, V167): a re-scan
        inserts a NEW row rather than updating an old one. To keep unchanged re-scores from
        appending duplicate rows, the insert is skipped when the same subject + scanner already
        has a run with the same ``report_fingerprint`` (a fingerprint identifies report content).

        Args:
            run: Column-name -> value dict built by :func:`app.lint_evidence.native_evidence_run`
                or :func:`app.lint_evidence.mcp_evidence_run`. ``findings`` / ``coverage`` are
                plain Python structures and are JSONB-wrapped here.

        Returns:
            The new run's id, or ``None`` when an identical report was already evidenced.
        """
        query = """
            INSERT INTO apiome.lint_evidence_runs (
                subject_type, version_record_id, mcp_version_id, scanner_id, scanner_version,
                adapter_version, profile, started_at, finished_at, outcome, input_fingerprint,
                source_fingerprint, config_fingerprint, raw_artifact_ref, report_fingerprint,
                findings, coverage, envelope_version
            )
            SELECT %s, %s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                   %s::jsonb, %s::jsonb, %s
            WHERE NOT EXISTS (
                SELECT 1 FROM apiome.lint_evidence_runs r
                WHERE r.scanner_id = %s
                  AND r.report_fingerprint = %s
                  AND (
                        (%s::uuid IS NOT NULL AND r.version_record_id = %s::uuid)
                        OR (%s::uuid IS NOT NULL AND r.mcp_version_id = %s::uuid)
                      )
            )
            RETURNING id
        """
        version_record_id = run.get("version_record_id")
        mcp_version_id = run.get("mcp_version_id")
        rows = self.execute_query(
            query,
            (
                run["subject_type"],
                version_record_id,
                mcp_version_id,
                run["scanner_id"],
                run.get("scanner_version"),
                run.get("adapter_version"),
                run.get("profile"),
                run.get("started_at"),
                run.get("finished_at"),
                run["outcome"],
                run.get("input_fingerprint"),
                run.get("source_fingerprint"),
                run.get("config_fingerprint"),
                run.get("raw_artifact_ref"),
                run.get("report_fingerprint"),
                Json(run.get("findings") or []),
                Json(run.get("coverage") or {"state": "unknown"}),
                run.get("envelope_version", 1),
                run["scanner_id"],
                run.get("report_fingerprint"),
                version_record_id,
                version_record_id,
                mcp_version_id,
                mcp_version_id,
            ),
        )
        new_id = str(rows[0]["id"]) if rows else None
        if new_id:
            # CLX-4.2 (#4860): a genuinely NEW run notifies lint.scan.completed subscribers.
            # The dedup skip above (rows empty) stays silent, and any notification failure is
            # swallowed — evidence capture runs inside import scoring and must never break it.
            try:
                from .lint_notifications import notify_lint_scan_completed

                tenant_id = self.tenant_id_for_lint_subject(
                    run["subject_type"],
                    version_record_id=version_record_id,
                    mcp_version_id=mcp_version_id,
                )
                if tenant_id:
                    notify_lint_scan_completed(
                        self, tenant_id=tenant_id, run={**run, "id": new_id}
                    )
            except Exception:  # noqa: BLE001 - notification is strictly additive
                _logger.warning(
                    "Failed to notify lint.scan.completed for run %s", new_id, exc_info=True
                )
        return new_id

    def tenant_id_for_lint_subject(
        self,
        subject_type: str,
        *,
        version_record_id: Optional[str] = None,
        mcp_version_id: Optional[str] = None,
    ) -> Optional[str]:
        """Resolve the owning tenant of a lint subject (CLX-4.2, #4860).

        Evidence writers don't carry a tenant id (the V167 contract is subject-scoped), but
        webhook fan-out is tenant-scoped — this resolves catalog revisions through their
        project and MCP snapshots through their endpoint.

        Args:
            subject_type: ``catalog_revision`` | ``mcp_endpoint_version``.
            version_record_id: The revision id, for catalog subjects.
            mcp_version_id: The snapshot id, for MCP subjects.

        Returns:
            The tenant id string, or ``None`` when the subject cannot be resolved.
        """
        if subject_type == "catalog_revision" and version_record_id:
            rows = self.execute_query(
                """
                SELECT p.tenant_id
                FROM apiome.versions v
                JOIN apiome.projects p ON p.id = v.project_id
                WHERE v.id = %s
                """,
                (version_record_id,),
            )
        elif subject_type == "mcp_endpoint_version" and mcp_version_id:
            rows = self.execute_query(
                """
                SELECT ep.tenant_id
                FROM apiome.mcp_endpoint_versions mv
                JOIN apiome.mcp_endpoints ep ON ep.id = mv.endpoint_id
                WHERE mv.id = %s
                """,
                (mcp_version_id,),
            )
        else:
            return None
        return str(rows[0]["tenant_id"]) if rows and rows[0].get("tenant_id") else None

    _LINT_EVIDENCE_COLUMNS = """
            r.id, r.subject_type, r.version_record_id, r.mcp_version_id, r.scanner_id,
            r.scanner_version, r.adapter_version, r.profile, r.started_at, r.finished_at,
            r.outcome, r.input_fingerprint, r.source_fingerprint, r.config_fingerprint,
            r.raw_artifact_ref, r.report_fingerprint, r.findings, r.coverage,
            r.envelope_version, r.created_at
    """

    def list_lint_evidence_runs_for_version(
        self, version_record_id: str, tenant_id: str
    ) -> List[Dict[str, Any]]:
        """List evidence runs for one catalog revision, most recent first (CLX-1.1, #4848).

        Tenant-scoped through the owning project (like :meth:`set_version_quality_score`), so a
        caller can never read another tenant's evidence. The raw artifact reference IS included
        in the rows for server-side use; API responses must redact it to an availability flag.

        Args:
            version_record_id: The revision (``versions.id``) whose evidence to list.
            tenant_id: The caller's tenant; rows outside it are invisible.

        Returns:
            Evidence-run rows ordered ``created_at DESC, id`` (deterministic).
        """
        query = f"""
            SELECT {self._LINT_EVIDENCE_COLUMNS}
            FROM apiome.lint_evidence_runs r
            JOIN apiome.versions v ON v.id = r.version_record_id
            JOIN apiome.projects p ON p.id = v.project_id
            WHERE r.version_record_id = %s AND p.tenant_id = %s
            ORDER BY r.created_at DESC, r.id
        """
        return self.execute_query(query, (version_record_id, tenant_id))

    def list_lint_evidence_runs_for_mcp_version(self, version_id: str) -> List[Dict[str, Any]]:
        """List evidence runs for one MCP discovery snapshot, most recent first (CLX-1.1, #4848).

        Tenant scoping is the caller's job (mirroring :meth:`get_mcp_version_score`): MCP
        routes re-validate the owning endpoint against the token tenant before reading.

        Args:
            version_id: The snapshot (``mcp_endpoint_versions.id``) whose evidence to list.

        Returns:
            Evidence-run rows ordered ``created_at DESC, id`` (deterministic).
        """
        query = f"""
            SELECT {self._LINT_EVIDENCE_COLUMNS}
            FROM apiome.lint_evidence_runs r
            WHERE r.mcp_version_id = %s
            ORDER BY r.created_at DESC, r.id
        """
        return self.execute_query(query, (version_id,))

    def record_axis_evaluation(self, evaluation: Dict[str, Any]) -> Optional[str]:
        """Insert one write-once multi-axis evaluation (CLX-1.2, #4849).

        Evaluations are immutable and append-only (``lint_axis_evaluations``, V168): a re-score
        inserts a NEW row. To keep unchanged re-scores from appending duplicates, the insert is
        skipped when the same subject + ``algorithm_id`` already has a row with the same
        ``source_report_fingerprint``.

        Args:
            evaluation: Column-name -> value dict from :func:`app.axis_score.evaluation_row`.

        Returns:
            The new evaluation's id, or ``None`` when an identical evaluation already exists.
        """
        query = """
            INSERT INTO apiome.lint_axis_evaluations (
                subject_type, version_record_id, mcp_version_id, algorithm_id, algorithm_version,
                axes, composite_score, composite_grade, required_coverage_met,
                source_report_fingerprint
            )
            SELECT %s, %s::uuid, %s::uuid, %s, %s, %s::jsonb, %s, %s, %s, %s
            WHERE NOT EXISTS (
                SELECT 1 FROM apiome.lint_axis_evaluations e
                WHERE e.algorithm_id = %s
                  AND e.source_report_fingerprint = %s
                  AND (
                        (%s::uuid IS NOT NULL AND e.version_record_id = %s::uuid)
                        OR (%s::uuid IS NOT NULL AND e.mcp_version_id = %s::uuid)
                      )
            )
            RETURNING id
        """
        version_record_id = evaluation.get("version_record_id")
        mcp_version_id = evaluation.get("mcp_version_id")
        rows = self.execute_query(
            query,
            (
                evaluation["subject_type"],
                version_record_id,
                mcp_version_id,
                evaluation.get("algorithm_id", ALGORITHM_ID),
                evaluation.get("algorithm_version", "1"),
                Json(evaluation.get("axes") or []),
                evaluation.get("composite_score"),
                evaluation.get("composite_grade"),
                bool(evaluation.get("required_coverage_met")),
                evaluation.get("source_report_fingerprint"),
                evaluation.get("algorithm_id", ALGORITHM_ID),
                evaluation.get("source_report_fingerprint"),
                version_record_id,
                version_record_id,
                mcp_version_id,
                mcp_version_id,
            ),
        )
        return str(rows[0]["id"]) if rows else None

    _AXIS_EVALUATION_COLUMNS = """
            e.id, e.subject_type, e.version_record_id, e.mcp_version_id, e.algorithm_id,
            e.algorithm_version, e.axes, e.composite_score, e.composite_grade,
            e.required_coverage_met, e.source_report_fingerprint, e.evaluated_at, e.created_at
    """

    def get_latest_axis_evaluation_for_version(
        self, version_record_id: str, tenant_id: str, *, algorithm_id: str = ALGORITHM_ID
    ) -> Optional[Dict[str, Any]]:
        """Return the latest axis evaluation for a catalog revision (CLX-1.2, #4849).

        Tenant-scoped through the owning project. Prefer the newest row for ``algorithm_id``.
        """
        query = f"""
            SELECT {self._AXIS_EVALUATION_COLUMNS}
            FROM apiome.lint_axis_evaluations e
            JOIN apiome.versions v ON v.id = e.version_record_id
            JOIN apiome.projects p ON p.id = v.project_id
            WHERE e.version_record_id = %s AND p.tenant_id = %s AND e.algorithm_id = %s
            ORDER BY e.evaluated_at DESC, e.id DESC
            LIMIT 1
        """
        rows = self.execute_query(query, (version_record_id, tenant_id, algorithm_id))
        return rows[0] if rows else None

    def get_latest_axis_evaluation_for_mcp_version(
        self, version_id: str, *, algorithm_id: str = ALGORITHM_ID
    ) -> Optional[Dict[str, Any]]:
        """Return the latest axis evaluation for an MCP snapshot (CLX-1.2, #4849).

        Tenant scoping is the caller's job (mirrors :meth:`get_mcp_version_score`).
        """
        query = f"""
            SELECT {self._AXIS_EVALUATION_COLUMNS}
            FROM apiome.lint_axis_evaluations e
            WHERE e.mcp_version_id = %s AND e.algorithm_id = %s
            ORDER BY e.evaluated_at DESC, e.id DESC
            LIMIT 1
        """
        rows = self.execute_query(query, (version_id, algorithm_id))
        return rows[0] if rows else None

    # --- Policy packs / waivers (CLX-1.3, #4850) ---------------------------------------------

    _POLICY_VERSION_COLUMNS = """
            pv.id, pv.guide_id, pv.tenant_id, pv.version_number, pv.content_fingerprint,
            pv.rules_snapshot, pv.axis_gates, pv.required_coverage, pv.ci_outcomes,
            pv.actor_user_id, pv.actor_label, pv.created_at
    """

    def update_style_guide_policy_settings(
        self,
        guide_id: str,
        tenant_id: str,
        *,
        axis_gates: Optional[Dict[str, Any]] = None,
        required_coverage: Optional[List[Any]] = None,
        ci_outcomes: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Update draft policy gate settings on a custom style guide (CLX-1.3, #4850).

        Builtin guides are excluded in the WHERE clause. Passing ``None`` for a field leaves
        the existing column value untouched.

        Args:
            guide_id: Guide to update.
            tenant_id: Owning tenant.
            axis_gates: New axis gates object, or ``None`` to leave unchanged.
            required_coverage: New required-coverage list, or ``None`` to leave unchanged.
            ci_outcomes: New CI outcome toggles, or ``None`` to leave unchanged.

        Returns:
            The updated guide row (subset of columns), or ``None`` when no custom guide matched.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return None
        query = """
            UPDATE apiome.style_guides
            SET axis_gates = COALESCE(%s::jsonb, axis_gates),
                required_coverage = COALESCE(%s::jsonb, required_coverage),
                ci_outcomes = COALESCE(%s::jsonb, ci_outcomes),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s AND tenant_id = %s AND source <> 'builtin'
            RETURNING id, name, description, source, is_default,
                      axis_gates, required_coverage, ci_outcomes, created_at, updated_at
        """
        rows = self.execute_query(
            query,
            (
                Json(axis_gates) if axis_gates is not None else None,
                Json(required_coverage) if required_coverage is not None else None,
                Json(ci_outcomes) if ci_outcomes is not None else None,
                guide_id,
                tenant_id,
            ),
        )
        return rows[0] if rows else None

    def insert_style_guide_policy_version(
        self,
        *,
        guide_id: str,
        tenant_id: str,
        rules_snapshot: List[Dict[str, Any]],
        axis_gates: Dict[str, Any],
        required_coverage: List[Any],
        ci_outcomes: Dict[str, Any],
        content_fingerprint: str,
        actor_user_id: Optional[str] = None,
        actor_label: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Append one immutable policy pack version for a style guide (CLX-1.3, #4850).

        Assigns the next monotonic ``version_number`` for the guide.

        Returns:
            The inserted policy version row, or ``None`` when inputs are invalid.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return None
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return None
        query = """
            INSERT INTO apiome.style_guide_policy_versions (
                guide_id, tenant_id, version_number, content_fingerprint,
                rules_snapshot, axis_gates, required_coverage, ci_outcomes,
                actor_user_id, actor_label
            )
            SELECT %s::uuid, %s::uuid,
                   COALESCE((
                       SELECT MAX(pv.version_number)
                       FROM apiome.style_guide_policy_versions pv
                       WHERE pv.guide_id = %s::uuid
                   ), 0) + 1,
                   %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
                   %s::uuid, %s
            RETURNING id, guide_id, tenant_id, version_number, content_fingerprint,
                      rules_snapshot, axis_gates, required_coverage, ci_outcomes,
                      actor_user_id, actor_label, created_at
        """
        rows = self.execute_query(
            query,
            (
                guide_id,
                tenant_id,
                guide_id,
                content_fingerprint,
                Json(rules_snapshot),
                Json(axis_gates),
                Json(required_coverage),
                Json(ci_outcomes),
                actor_user_id,
                actor_label,
            ),
        )
        return rows[0] if rows else None

    def list_style_guide_policy_versions(
        self, guide_id: str, tenant_id: str
    ) -> List[Dict[str, Any]]:
        """List policy pack versions for a guide, newest first (CLX-1.3, #4850)."""
        if not guide_id or not is_uuid_string(str(guide_id)):
            return []
        query = """
            SELECT id, guide_id, tenant_id, version_number, content_fingerprint,
                   rules_snapshot, axis_gates, required_coverage, ci_outcomes,
                   actor_user_id, actor_label, created_at
            FROM apiome.style_guide_policy_versions
            WHERE guide_id = %s AND tenant_id = %s
            ORDER BY version_number DESC
        """
        return self.execute_query(query, (guide_id, tenant_id))

    def get_style_guide_policy_version(
        self, policy_version_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one policy pack version scoped to a tenant (CLX-1.3, #4850)."""
        if not policy_version_id or not is_uuid_string(str(policy_version_id)):
            return None
        query = """
            SELECT id, guide_id, tenant_id, version_number, content_fingerprint,
                   rules_snapshot, axis_gates, required_coverage, ci_outcomes,
                   actor_user_id, actor_label, created_at
            FROM apiome.style_guide_policy_versions
            WHERE id = %s AND tenant_id = %s
        """
        rows = self.execute_query(query, (policy_version_id, tenant_id))
        return rows[0] if rows else None

    def get_latest_style_guide_policy_version(
        self, guide_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Return the newest policy pack for a guide, or ``None`` (CLX-1.3, #4850)."""
        rows = self.list_style_guide_policy_versions(guide_id, tenant_id)
        return rows[0] if rows else None

    def list_lint_finding_decisions(
        self,
        tenant_id: str,
        *,
        project_id: Optional[str] = None,
        fingerprints: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """List finding decisions for a tenant, optionally filtered (CLX-1.3, #4850).

        When ``project_id`` is set, returns both project-scoped and tenant-wide rows so
        callers can prefer project scope on match. When ``fingerprints`` is set, restricts
        to those source fingerprints.
        """
        clauses = ["d.tenant_id = %s"]
        params: List[Any] = [tenant_id]
        if project_id:
            clauses.append("(d.project_id IS NULL OR d.project_id = %s)")
            params.append(project_id)
        if fingerprints:
            clauses.append("d.source_fingerprint = ANY(%s)")
            params.append(list(fingerprints))
        query = f"""
            SELECT d.id, d.tenant_id, d.project_id, d.source_fingerprint, d.rule_id, d.state,
                   d.owner_user_id, d.rationale, d.linked_ticket, d.expires_at,
                   d.policy_version_id, d.evidence_fingerprint_at_decision,
                   d.actor_user_id, d.actor_label, d.created_at, d.updated_at
            FROM apiome.lint_finding_decisions d
            WHERE {' AND '.join(clauses)}
            ORDER BY d.updated_at DESC
        """
        return self.execute_query(query, tuple(params))

    def get_lint_finding_decision(
        self, decision_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one finding decision by id (CLX-1.3, #4850)."""
        if not decision_id or not is_uuid_string(str(decision_id)):
            return None
        query = """
            SELECT d.id, d.tenant_id, d.project_id, d.source_fingerprint, d.rule_id, d.state,
                   d.owner_user_id, d.rationale, d.linked_ticket, d.expires_at,
                   d.policy_version_id, d.evidence_fingerprint_at_decision,
                   d.actor_user_id, d.actor_label, d.created_at, d.updated_at
            FROM apiome.lint_finding_decisions d
            WHERE d.id = %s AND d.tenant_id = %s
        """
        rows = self.execute_query(query, (decision_id, tenant_id))
        return rows[0] if rows else None

    def upsert_lint_finding_decision(
        self,
        *,
        tenant_id: str,
        source_fingerprint: str,
        state: str,
        project_id: Optional[str] = None,
        rule_id: Optional[str] = None,
        owner_user_id: Optional[str] = None,
        rationale: Optional[str] = None,
        linked_ticket: Optional[str] = None,
        expires_at: Optional[Any] = None,
        policy_version_id: Optional[str] = None,
        evidence_fingerprint_at_decision: Optional[str] = None,
        actor_user_id: Optional[str] = None,
        actor_label: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Insert or update a finding decision and append an audit event (CLX-1.3, #4850).

        Matching key is ``(tenant_id, source_fingerprint)`` when ``project_id`` is NULL, or
        ``(project_id, source_fingerprint)`` when set. Always records an append-only event.
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                if project_id:
                    cursor.execute(
                        """
                        SELECT id, state FROM apiome.lint_finding_decisions
                        WHERE project_id = %s AND source_fingerprint = %s
                        FOR UPDATE
                        """,
                        (project_id, source_fingerprint),
                    )
                else:
                    cursor.execute(
                        """
                        SELECT id, state FROM apiome.lint_finding_decisions
                        WHERE tenant_id = %s AND project_id IS NULL
                          AND source_fingerprint = %s
                        FOR UPDATE
                        """,
                        (tenant_id, source_fingerprint),
                    )
                existing = cursor.fetchone()
                before_state = None
                if existing:
                    before_state = existing.get("state")
                    decision_id = str(existing["id"])
                    cursor.execute(
                        """
                        UPDATE apiome.lint_finding_decisions
                        SET state = %s, rule_id = COALESCE(%s, rule_id),
                            owner_user_id = %s, rationale = %s, linked_ticket = %s,
                            expires_at = %s, policy_version_id = %s,
                            evidence_fingerprint_at_decision = COALESCE(%s, evidence_fingerprint_at_decision),
                            actor_user_id = %s, actor_label = %s, updated_at = CURRENT_TIMESTAMP,
                            -- A (re-)granted waiver gets a fresh expiry, so the one-shot
                            -- lint.waiver.expiring marker must re-arm (#4860).
                            expiry_notified_at = CASE WHEN %s = 'waived' THEN NULL
                                                      ELSE expiry_notified_at END
                        WHERE id = %s
                        RETURNING id, tenant_id, project_id, source_fingerprint, rule_id, state,
                                  owner_user_id, rationale, linked_ticket, expires_at,
                                  policy_version_id, evidence_fingerprint_at_decision,
                                  actor_user_id, actor_label, created_at, updated_at
                        """,
                        (
                            state,
                            rule_id,
                            owner_user_id,
                            rationale,
                            linked_ticket,
                            expires_at,
                            policy_version_id,
                            evidence_fingerprint_at_decision or source_fingerprint,
                            actor_user_id,
                            actor_label,
                            state,
                            decision_id,
                        ),
                    )
                else:
                    cursor.execute(
                        """
                        INSERT INTO apiome.lint_finding_decisions (
                            tenant_id, project_id, source_fingerprint, rule_id, state,
                            owner_user_id, rationale, linked_ticket, expires_at,
                            policy_version_id, evidence_fingerprint_at_decision,
                            actor_user_id, actor_label
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                        )
                        RETURNING id, tenant_id, project_id, source_fingerprint, rule_id, state,
                                  owner_user_id, rationale, linked_ticket, expires_at,
                                  policy_version_id, evidence_fingerprint_at_decision,
                                  actor_user_id, actor_label, created_at, updated_at
                        """,
                        (
                            tenant_id,
                            project_id,
                            source_fingerprint,
                            rule_id,
                            state,
                            owner_user_id,
                            rationale,
                            linked_ticket,
                            expires_at,
                            policy_version_id,
                            evidence_fingerprint_at_decision or source_fingerprint,
                            actor_user_id,
                            actor_label,
                        ),
                    )
                decision = dict(cursor.fetchone())
                cursor.execute(
                    """
                    INSERT INTO apiome.lint_finding_decision_events (
                        decision_id, tenant_id, before_state, after_state, rationale,
                        expires_at, linked_ticket, policy_version_id, actor_user_id, actor_label
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        str(decision["id"]),
                        tenant_id,
                        before_state,
                        state,
                        rationale,
                        expires_at,
                        linked_ticket,
                        policy_version_id,
                        actor_user_id,
                        actor_label,
                    ),
                )
            conn.commit()
            return decision
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def claim_expiring_lint_waivers(
        self, *, cutoff: Any, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """Atomically claim waivers whose expiry falls before ``cutoff`` (CLX-4.2, #4860).

        Stamps ``expiry_notified_at`` on up to ``limit`` unnotified active waivers and returns
        the claimed rows, so the ``lint.waiver.expiring`` webhook fires exactly once per grant
        even with several replicas sweeping concurrently (``FOR UPDATE SKIP LOCKED``). A
        waiver re-granted with a new expiry re-arms because the decision upsert resets the
        marker to NULL.

        Args:
            cutoff: Claim waivers with ``expires_at <= cutoff`` (a timezone-aware datetime).
            limit: Max rows claimed per call (sweep batch size).

        Returns:
            The claimed decision rows (including ``tenant_id`` for notification fan-out),
            ordered soonest-expiring first.
        """
        query = """
            UPDATE apiome.lint_finding_decisions d
            SET expiry_notified_at = CURRENT_TIMESTAMP
            WHERE d.id IN (
                SELECT id FROM apiome.lint_finding_decisions
                WHERE state = 'waived'
                  AND expiry_notified_at IS NULL
                  AND expires_at IS NOT NULL
                  AND expires_at <= %s
                ORDER BY expires_at
                LIMIT %s
                FOR UPDATE SKIP LOCKED
            )
            RETURNING d.id, d.tenant_id, d.project_id, d.source_fingerprint, d.rule_id,
                      d.state, d.owner_user_id, d.rationale, d.linked_ticket, d.expires_at,
                      d.policy_version_id, d.actor_user_id, d.actor_label,
                      d.created_at, d.updated_at
        """
        rows = self.execute_query(query, (cutoff, limit))
        return sorted(rows, key=lambda r: str(r.get("expires_at") or ""))

    # ------------------------------------------------------------------
    # Import/export quality policy + waivers (IXH-2.3, #5098)
    # ------------------------------------------------------------------

    #: Columns every quality-policy read returns, so a row always adapts cleanly into
    #: :func:`app.import_export_quality_policy.policy_from_row`.
    _QUALITY_POLICY_COLUMNS = """
        id::text AS id, tenant_id::text AS tenant_id, version_number, content_fingerprint,
        import_min_grade, import_min_score, import_block_on_severity, import_enforcement,
        export_min_grade, export_min_score, export_block_on_severity, export_enforcement,
        format_overrides, allow_override, override_roles, waiver_ttl_hours,
        actor_user_id::text AS actor_user_id, actor_label, created_at
    """

    def get_latest_import_export_quality_policy(
        self, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """The tenant's quality policy in force — its highest version (IXH-2.3, #5098).

        Args:
            tenant_id: Tenant to read.

        Returns:
            The policy row, or ``None`` when the tenant has never saved one (callers then run
            the advisory default).
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return None
        rows = self.execute_query(
            f"""
            SELECT {self._QUALITY_POLICY_COLUMNS}
            FROM apiome.import_export_quality_policies
            WHERE tenant_id = %s::uuid
            ORDER BY version_number DESC
            LIMIT 1
            """,
            (tenant_id,),
        )
        return rows[0] if rows else None

    def list_import_export_quality_policy_versions(
        self, tenant_id: str, *, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """The tenant's policy versions, newest first (IXH-2.3, #5098)."""
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return []
        return self.execute_query(
            f"""
            SELECT {self._QUALITY_POLICY_COLUMNS}
            FROM apiome.import_export_quality_policies
            WHERE tenant_id = %s::uuid
            ORDER BY version_number DESC
            LIMIT %s
            """,
            (tenant_id, max(1, min(int(limit), 200))),
        )

    def insert_import_export_quality_policy(
        self,
        *,
        tenant_id: str,
        content_fingerprint: str,
        import_min_grade: Optional[str],
        import_min_score: Optional[int],
        import_block_on_severity: Optional[str],
        import_enforcement: str,
        export_min_grade: Optional[str],
        export_min_score: Optional[int],
        export_block_on_severity: Optional[str],
        export_enforcement: str,
        format_overrides: Dict[str, Any],
        allow_override: bool,
        override_roles: List[str],
        waiver_ttl_hours: int,
        actor_user_id: Optional[str] = None,
        actor_label: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Append a new policy version for a tenant (IXH-2.3, #5098).

        Policy rows are append-only (a write-once trigger guards them), so a save is an insert
        at ``max(version_number) + 1`` — the previous versions stay readable for the verdicts
        that named them.

        Args:
            tenant_id: Tenant the policy governs.
            content_fingerprint: SHA-256 over the canonicalized policy body.
            import_min_grade: Import grade floor, or ``None``.
            import_min_score: Import score floor, or ``None``.
            import_block_on_severity: Import severity floor, or ``None``.
            import_enforcement: ``advisory`` | ``block``.
            export_min_grade: Export grade floor, or ``None``.
            export_min_score: Export score floor, or ``None``.
            export_block_on_severity: Export severity floor, or ``None``.
            export_enforcement: ``advisory`` | ``block``.
            format_overrides: Per-format override map.
            allow_override: Whether a blocking verdict may be waived.
            override_roles: Role slugs permitted to waive.
            waiver_ttl_hours: Lifetime of a granted waiver.
            actor_user_id: Publishing user.
            actor_label: Human-readable actor label.

        Returns:
            The inserted row, or ``None`` when the tenant id is not a UUID.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return None
        query = f"""
            INSERT INTO apiome.import_export_quality_policies (
                tenant_id, version_number, content_fingerprint,
                import_min_grade, import_min_score, import_block_on_severity, import_enforcement,
                export_min_grade, export_min_score, export_block_on_severity, export_enforcement,
                format_overrides, allow_override, override_roles, waiver_ttl_hours,
                actor_user_id, actor_label
            )
            SELECT %s::uuid,
                   COALESCE(MAX(version_number), 0) + 1,
                   %s, %s, %s, %s, %s, %s, %s, %s, %s,
                   %s::jsonb, %s, %s::jsonb, %s, %s::uuid, %s
            FROM apiome.import_export_quality_policies
            WHERE tenant_id = %s::uuid
            RETURNING {self._QUALITY_POLICY_COLUMNS}
        """
        params = (
            tenant_id,
            content_fingerprint,
            import_min_grade,
            import_min_score,
            import_block_on_severity,
            import_enforcement,
            export_min_grade,
            export_min_score,
            export_block_on_severity,
            export_enforcement,
            json.dumps(format_overrides or {}, sort_keys=True),
            allow_override,
            json.dumps(list(override_roles or [])),
            waiver_ttl_hours,
            actor_user_id,
            actor_label,
            tenant_id,
        )
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                row = cursor.fetchone()
            conn.commit()
            return row
        except Exception:
            conn.rollback()
            raise

    #: Columns every quality-waiver read returns.
    _QUALITY_WAIVER_COLUMNS = """
        id::text AS id, tenant_id::text AS tenant_id, scope, subject_key, subject_label,
        format_key, report_fingerprint, score, grade,
        policy_version_id::text AS policy_version_id, policy_content_fingerprint,
        reason, expires_at, expiry_notified_at,
        actor_user_id::text AS actor_user_id, actor_label, actor_role, created_at
    """

    def insert_import_export_quality_waiver(
        self,
        *,
        tenant_id: str,
        scope: str,
        subject_key: str,
        reason: str,
        expires_at: Any,
        subject_label: Optional[str] = None,
        format_key: Optional[str] = None,
        report_fingerprint: Optional[str] = None,
        score: Optional[int] = None,
        grade: Optional[str] = None,
        policy_version_id: Optional[str] = None,
        policy_content_fingerprint: Optional[str] = None,
        actor_user_id: Optional[str] = None,
        actor_label: Optional[str] = None,
        actor_role: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Record one import/export quality waiver (IXH-2.3, #5098).

        Args:
            tenant_id: Granting tenant.
            scope: ``import`` | ``export``.
            subject_key: Subject identity (candidate content hash / delivery subject).
            reason: The actor's stated justification (required by a CHECK constraint).
            expires_at: When the waiver stops being honoured.
            subject_label: Display label for the subject.
            format_key: Adapter key / export target the waiver applies to.
            report_fingerprint: Fingerprint of the waived lint report.
            score: Score at waiver time.
            grade: Grade at waiver time.
            policy_version_id: Policy version in force (``None`` for the built-in default).
            policy_content_fingerprint: That policy's content fingerprint.
            actor_user_id: Granting user.
            actor_label: Human-readable actor label.
            actor_role: The actor's effective role slug at grant time.

        Returns:
            The inserted row, or ``None`` when the tenant id is not a UUID.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return None
        policy_id = (
            policy_version_id
            if policy_version_id and is_uuid_string(str(policy_version_id))
            else None
        )
        query = f"""
            INSERT INTO apiome.import_export_quality_waivers (
                tenant_id, scope, subject_key, subject_label, format_key,
                report_fingerprint, score, grade, policy_version_id,
                policy_content_fingerprint, reason, expires_at,
                actor_user_id, actor_label, actor_role
            )
            VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::uuid, %s, %s, %s, %s::uuid, %s, %s)
            RETURNING {self._QUALITY_WAIVER_COLUMNS}
        """
        params = (
            tenant_id,
            scope,
            subject_key,
            subject_label,
            format_key,
            report_fingerprint,
            score,
            grade,
            policy_id,
            policy_content_fingerprint,
            reason,
            expires_at,
            actor_user_id,
            actor_label,
            actor_role,
        )
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                row = cursor.fetchone()
            conn.commit()
            return row
        except Exception:
            conn.rollback()
            raise

    def list_active_import_export_quality_waivers(
        self, tenant_id: str, *, scope: str, subject_key: str, now: Any
    ) -> List[Dict[str, Any]]:
        """Unexpired waivers covering one subject, newest expiry first (IXH-2.3, #5098).

        Args:
            tenant_id: Tenant scope.
            scope: ``import`` | ``export``.
            subject_key: The subject identity to match.
            now: Instant expiry is evaluated against.

        Returns:
            The matching rows; empty when nothing active covers the subject.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return []
        return self.execute_query(
            f"""
            SELECT {self._QUALITY_WAIVER_COLUMNS}
            FROM apiome.import_export_quality_waivers
            WHERE tenant_id = %s::uuid AND scope = %s AND subject_key = %s
              AND expires_at > %s
            ORDER BY expires_at DESC
            """,
            (tenant_id, scope, subject_key, now),
        )

    def list_import_export_quality_waivers(
        self,
        tenant_id: str,
        *,
        scope: Optional[str] = None,
        active_only: bool = True,
        now: Any = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """The tenant's waiver ledger, newest first (IXH-2.3, #5098).

        Args:
            tenant_id: Tenant scope.
            scope: Restrict to ``import`` or ``export``; ``None`` returns both.
            active_only: Drop waivers that have already expired.
            now: Instant expiry is evaluated against (defaults to the database clock).
            limit: Page size (capped at 500).

        Returns:
            The waiver rows.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return []
        clauses = ["tenant_id = %s::uuid"]
        params: List[Any] = [tenant_id]
        if scope:
            clauses.append("scope = %s")
            params.append(scope)
        if active_only:
            if now is None:
                clauses.append("expires_at > CURRENT_TIMESTAMP")
            else:
                clauses.append("expires_at > %s")
                params.append(now)
        params.append(max(1, min(int(limit), 500)))
        return self.execute_query(
            f"""
            SELECT {self._QUALITY_WAIVER_COLUMNS}
            FROM apiome.import_export_quality_waivers
            WHERE {' AND '.join(clauses)}
            ORDER BY created_at DESC
            LIMIT %s
            """,
            tuple(params),
        )

    def claim_expiring_import_export_quality_waivers(
        self, *, cutoff: Any, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """Atomically claim quality waivers expiring before ``cutoff`` (IXH-2.3, #5098).

        Same claim protocol as :meth:`claim_expiring_lint_waivers` (V176): stamp
        ``expiry_notified_at`` under ``FOR UPDATE SKIP LOCKED`` and return only the rows this
        instance won, so the shared expiry sweep notifies each grant exactly once across
        replicas.

        Args:
            cutoff: Claim waivers with ``expires_at <= cutoff``.
            limit: Max rows claimed per call.

        Returns:
            The claimed rows, soonest-expiring first.
        """
        query = f"""
            UPDATE apiome.import_export_quality_waivers w
            SET expiry_notified_at = CURRENT_TIMESTAMP
            WHERE w.id IN (
                SELECT id FROM apiome.import_export_quality_waivers
                WHERE expiry_notified_at IS NULL AND expires_at <= %s
                ORDER BY expires_at
                LIMIT %s
                FOR UPDATE SKIP LOCKED
            )
            RETURNING {self._QUALITY_WAIVER_COLUMNS}
        """
        rows = self.execute_query(query, (cutoff, limit))
        return sorted(rows, key=lambda r: str(r.get("expires_at") or ""))

    def get_effective_role_slug(self, tenant_id: str, user_id: str) -> Optional[str]:
        """The user's effective RBAC role slug in a tenant (IXH-2.3, #5098).

        Resolved exactly like :meth:`user_has_permission`: a ``tenant_administrators`` row is
        Owner-equivalent (V118), otherwise the assigned ``tenant_user_roles`` slug wins, and a
        non-suspended member with no explicit role inherits the built-in Editor grid.

        Args:
            tenant_id: Tenant to resolve within.
            user_id: The user.

        Returns:
            ``owner`` | the assigned role slug | ``editor``, or ``None`` when the user is not a
            member of the tenant.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return None
        if not user_id or not is_uuid_string(str(user_id)):
            return None
        if self.is_user_tenant_admin(tenant_id, user_id):
            return "owner"
        assigned = self.execute_query(
            """
            SELECT r.slug
            FROM apiome.tenant_user_roles tur
            JOIN apiome.roles r ON r.id = tur.role_id
            WHERE tur.tenant_id = %s::uuid AND tur.user_id = %s::uuid
            ORDER BY r.slug
            LIMIT 1
            """,
            (tenant_id, user_id),
        )
        if assigned:
            return str(assigned[0]["slug"])
        member = self.execute_query(
            """
            SELECT 1 FROM apiome.tenant_users
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid AND status <> 'suspended'
            LIMIT 1
            """,
            (tenant_id, user_id),
        )
        return "editor" if member else None

    def list_lint_finding_decision_events(
        self, decision_id: str, tenant_id: str
    ) -> List[Dict[str, Any]]:
        """List audit events for a decision, oldest first (CLX-1.3, #4850)."""
        query = """
            SELECT id, decision_id, tenant_id, before_state, after_state, rationale,
                   expires_at, linked_ticket, policy_version_id, actor_user_id, actor_label,
                   created_at
            FROM apiome.lint_finding_decision_events
            WHERE decision_id = %s AND tenant_id = %s
            ORDER BY created_at ASC
        """
        return self.execute_query(query, (decision_id, tenant_id))

    def record_lint_policy_evaluation(self, evaluation: Dict[str, Any]) -> Optional[str]:
        """Insert one write-once policy evaluation (CLX-1.3, #4850).

        Skips when the same subject + policy content fingerprint + evidence fingerprint
        already exists (reproducible no-op recompute).

        Args:
            evaluation: Column-name -> value dict for ``lint_policy_evaluations``.

        Returns:
            The new evaluation id, or ``None`` when an identical row already exists.
        """
        query = """
            INSERT INTO apiome.lint_policy_evaluations (
                subject_type, version_record_id, mcp_version_id, policy_version_id,
                policy_content_fingerprint, evidence_run_id, axis_evaluation_id,
                evidence_fingerprint, passed, gate_results, finding_decisions
            )
            SELECT %s, %s::uuid, %s::uuid, %s::uuid, %s, %s::uuid, %s::uuid, %s, %s,
                   %s::jsonb, %s::jsonb
            WHERE NOT EXISTS (
                SELECT 1 FROM apiome.lint_policy_evaluations e
                WHERE e.policy_content_fingerprint = %s
                  AND e.evidence_fingerprint IS NOT DISTINCT FROM %s
                  AND (
                        (%s::uuid IS NOT NULL AND e.version_record_id = %s::uuid)
                        OR (%s::uuid IS NOT NULL AND e.mcp_version_id = %s::uuid)
                      )
            )
            RETURNING id
        """
        version_record_id = evaluation.get("version_record_id")
        mcp_version_id = evaluation.get("mcp_version_id")
        rows = self.execute_query(
            query,
            (
                evaluation["subject_type"],
                version_record_id,
                mcp_version_id,
                evaluation["policy_version_id"],
                evaluation["policy_content_fingerprint"],
                evaluation.get("evidence_run_id"),
                evaluation.get("axis_evaluation_id"),
                evaluation.get("evidence_fingerprint"),
                bool(evaluation.get("passed")),
                Json(evaluation.get("gate_results") or {}),
                Json(evaluation.get("finding_decisions") or []),
                evaluation["policy_content_fingerprint"],
                evaluation.get("evidence_fingerprint"),
                version_record_id,
                version_record_id,
                mcp_version_id,
                mcp_version_id,
            ),
        )
        return str(rows[0]["id"]) if rows else None

    def get_latest_lint_policy_evaluation_for_version(
        self, version_record_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Return the latest policy evaluation for a catalog revision (CLX-1.3, #4850)."""
        query = """
            SELECT e.id, e.subject_type, e.version_record_id, e.mcp_version_id,
                   e.policy_version_id, e.policy_content_fingerprint, e.evidence_run_id,
                   e.axis_evaluation_id, e.evidence_fingerprint, e.passed, e.gate_results,
                   e.finding_decisions, e.evaluated_at, e.created_at
            FROM apiome.lint_policy_evaluations e
            JOIN apiome.versions v ON v.id = e.version_record_id
            JOIN apiome.projects p ON p.id = v.project_id
            WHERE e.version_record_id = %s AND p.tenant_id = %s
            ORDER BY e.evaluated_at DESC, e.id DESC
            LIMIT 1
        """
        rows = self.execute_query(query, (version_record_id, tenant_id))
        return rows[0] if rows else None

    def get_latest_lint_policy_evaluation_for_mcp_version(
        self, version_id: str
    ) -> Optional[Dict[str, Any]]:
        """Return the latest policy evaluation for an MCP snapshot (CLX-1.3, #4850)."""
        query = """
            SELECT e.id, e.subject_type, e.version_record_id, e.mcp_version_id,
                   e.policy_version_id, e.policy_content_fingerprint, e.evidence_run_id,
                   e.axis_evaluation_id, e.evidence_fingerprint, e.passed, e.gate_results,
                   e.finding_decisions, e.evaluated_at, e.created_at
            FROM apiome.lint_policy_evaluations e
            WHERE e.mcp_version_id = %s
            ORDER BY e.evaluated_at DESC, e.id DESC
            LIMIT 1
        """
        rows = self.execute_query(query, (version_id,))
        return rows[0] if rows else None

    # --- Lint workspace — tenant-wide read paths (CLX-4.1, #4859) ----------------------------
    #
    # ``lint_evidence_runs`` / ``lint_axis_evaluations`` / ``lint_policy_evaluations`` carry no
    # tenant_id: tenant scope is joined through the owning project (catalog revisions) or the
    # owning endpoint (MCP snapshots). The workspace reads the LATEST live revision per project
    # and the LATEST snapshot per endpoint — stale revisions never pollute the queue.

    #: Latest live revision per live project in a tenant (optionally one project).
    _WORKSPACE_CATALOG_SUBJECTS = """
        catalog_subjects AS (
            SELECT DISTINCT ON (v.project_id)
                   v.id AS subject_version_record_id, v.version_id AS subject_label,
                   p.id AS project_id, p.name AS project_name, p.publishable
            FROM apiome.versions v
            JOIN apiome.projects p ON p.id = v.project_id
            WHERE p.tenant_id = %s AND p.deleted_at IS NULL AND v.deleted_at IS NULL
              AND (%s::uuid IS NULL OR p.id = %s::uuid)
            ORDER BY v.project_id, v.created_at DESC NULLS LAST, v.id DESC
        )
    """

    #: Latest discovery snapshot per live endpoint in a tenant.
    _WORKSPACE_MCP_SUBJECTS = """
        mcp_subjects AS (
            SELECT DISTINCT ON (mv.endpoint_id)
                   mv.id AS subject_mcp_version_id, ep.name AS subject_label
            FROM apiome.mcp_endpoint_versions mv
            JOIN apiome.mcp_endpoints ep ON ep.id = mv.endpoint_id
            WHERE ep.tenant_id = %s AND ep.deleted_at IS NULL
            ORDER BY mv.endpoint_id, mv.version_seq DESC
        )
    """

    def list_latest_lint_evidence_runs_for_tenant(
        self,
        tenant_id: str,
        *,
        project_id: Optional[str] = None,
        runs_per_scanner: int = 2,
    ) -> List[Dict[str, Any]]:
        """List the newest evidence runs per (subject, scanner) across a tenant (CLX-4.1, #4859).

        Subjects are the latest live catalog revision per project plus the latest snapshot per
        MCP endpoint. ``runs_per_scanner`` newest rows are returned for each (subject, scanner)
        pair — the workspace merges row 1 per scanner into "current findings" and diffs row 1
        against row 2 for regression (new-finding) detection.

        Args:
            tenant_id: The caller's tenant.
            project_id: When set, restricts to that project's latest revision only (the MCP
                side is excluded — MCP endpoints have no project scope).
            runs_per_scanner: How many newest runs per (subject, scanner) to return (>= 1).

        Returns:
            Evidence-run rows newest-first, each carrying ``rn`` (1 = newest for its scanner),
            ``project_id`` / ``project_name`` / ``publishable`` (catalog side, else NULL) and
            ``subject_label`` (revision label or endpoint name).
        """
        per_scanner = max(1, int(runs_per_scanner))
        run_columns = """
                   r.id, r.subject_type, r.version_record_id, r.mcp_version_id, r.scanner_id,
                   r.scanner_version, r.profile, r.outcome, r.report_fingerprint,
                   r.findings, r.coverage, r.created_at
        """
        catalog_branch = f"""
            SELECT * FROM (
                SELECT {run_columns},
                       cs.project_id, cs.project_name::text AS project_name, cs.publishable,
                       cs.subject_label::text AS subject_label,
                       ROW_NUMBER() OVER (
                           PARTITION BY r.version_record_id, r.scanner_id
                           ORDER BY r.created_at DESC, r.id DESC
                       ) AS rn
                FROM apiome.lint_evidence_runs r
                JOIN catalog_subjects cs ON cs.subject_version_record_id = r.version_record_id
            ) c WHERE c.rn <= %s
        """
        mcp_branch = f"""
            SELECT * FROM (
                SELECT {run_columns},
                       NULL::uuid AS project_id, NULL::text AS project_name,
                       NULL::boolean AS publishable, ms.subject_label::text AS subject_label,
                       ROW_NUMBER() OVER (
                           PARTITION BY r.mcp_version_id, r.scanner_id
                           ORDER BY r.created_at DESC, r.id DESC
                       ) AS rn
                FROM apiome.lint_evidence_runs r
                JOIN mcp_subjects ms ON ms.subject_mcp_version_id = r.mcp_version_id
            ) m WHERE m.rn <= %s
        """
        if project_id:
            query = f"""
                WITH {self._WORKSPACE_CATALOG_SUBJECTS}
                {catalog_branch}
                ORDER BY created_at DESC, id
            """
            params: Tuple[Any, ...] = (tenant_id, project_id, project_id, per_scanner)
        else:
            query = f"""
                WITH {self._WORKSPACE_CATALOG_SUBJECTS}, {self._WORKSPACE_MCP_SUBJECTS}
                {catalog_branch}
                UNION ALL
                {mcp_branch}
                ORDER BY created_at DESC, id
            """
            # Placeholder order follows the SQL text: BOTH CTEs first (catalog: tenant,
            # project, project; mcp: tenant), then each branch's rn cap.
            params = (tenant_id, None, None, tenant_id, per_scanner, per_scanner)
        return self.execute_query(query, params)

    def list_latest_axis_evaluations_for_tenant(
        self,
        tenant_id: str,
        *,
        project_id: Optional[str] = None,
        algorithm_id: str = ALGORITHM_ID,
    ) -> List[Dict[str, Any]]:
        """Newest axis evaluation per workspace subject across a tenant (CLX-4.1, #4859).

        Same subject scoping as :meth:`list_latest_lint_evidence_runs_for_tenant`.

        Returns:
            One row per subject with axes / composite / coverage columns plus
            ``project_id`` / ``project_name`` / ``subject_label``.
        """
        eval_columns = """
                       e.id, e.subject_type, e.version_record_id, e.mcp_version_id,
                       e.axes, e.composite_score, e.composite_grade,
                       e.required_coverage_met, e.evaluated_at
        """
        catalog_branch = f"""
            SELECT DISTINCT ON (e.version_record_id)
                   {eval_columns},
                   cs.project_id, cs.project_name::text AS project_name,
                   cs.subject_label::text AS subject_label
            FROM apiome.lint_axis_evaluations e
            JOIN catalog_subjects cs ON cs.subject_version_record_id = e.version_record_id
            WHERE e.algorithm_id = %s
            ORDER BY e.version_record_id, e.evaluated_at DESC, e.id DESC
        """
        mcp_branch = f"""
            SELECT DISTINCT ON (e.mcp_version_id)
                   {eval_columns},
                   NULL::uuid AS project_id, NULL::text AS project_name,
                   ms.subject_label::text AS subject_label
            FROM apiome.lint_axis_evaluations e
            JOIN mcp_subjects ms ON ms.subject_mcp_version_id = e.mcp_version_id
            WHERE e.algorithm_id = %s
            ORDER BY e.mcp_version_id, e.evaluated_at DESC, e.id DESC
        """
        if project_id:
            query = f"""
                WITH {self._WORKSPACE_CATALOG_SUBJECTS}
                SELECT * FROM ({catalog_branch}) c
            """
            params: Tuple[Any, ...] = (tenant_id, project_id, project_id, algorithm_id)
        else:
            query = f"""
                WITH {self._WORKSPACE_CATALOG_SUBJECTS}, {self._WORKSPACE_MCP_SUBJECTS}
                SELECT * FROM ({catalog_branch}) c
                UNION ALL
                SELECT * FROM ({mcp_branch}) m
            """
            # Placeholder order follows the SQL text: BOTH CTEs first (catalog: tenant,
            # project, project; mcp: tenant), then each branch's algorithm filter.
            params = (tenant_id, None, None, tenant_id, algorithm_id, algorithm_id)
        return self.execute_query(query, params)

    def list_latest_lint_policy_evaluations_for_tenant(
        self,
        tenant_id: str,
        *,
        project_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Newest policy evaluation per workspace subject across a tenant (CLX-4.1, #4859).

        Same subject scoping as :meth:`list_latest_lint_evidence_runs_for_tenant`.

        Returns:
            One row per subject: id, policy_version_id, passed, gate_results, evaluated_at.
        """
        eval_columns = """
                       e.id, e.subject_type, e.version_record_id, e.mcp_version_id,
                       e.policy_version_id, e.passed, e.gate_results, e.evaluated_at
        """
        catalog_branch = f"""
            SELECT DISTINCT ON (e.version_record_id) {eval_columns}
            FROM apiome.lint_policy_evaluations e
            JOIN catalog_subjects cs ON cs.subject_version_record_id = e.version_record_id
            ORDER BY e.version_record_id, e.evaluated_at DESC, e.id DESC
        """
        mcp_branch = f"""
            SELECT DISTINCT ON (e.mcp_version_id) {eval_columns}
            FROM apiome.lint_policy_evaluations e
            JOIN mcp_subjects ms ON ms.subject_mcp_version_id = e.mcp_version_id
            ORDER BY e.mcp_version_id, e.evaluated_at DESC, e.id DESC
        """
        if project_id:
            query = f"""
                WITH {self._WORKSPACE_CATALOG_SUBJECTS}
                SELECT * FROM ({catalog_branch}) c
            """
            params: Tuple[Any, ...] = (tenant_id, project_id, project_id)
        else:
            query = f"""
                WITH {self._WORKSPACE_CATALOG_SUBJECTS}, {self._WORKSPACE_MCP_SUBJECTS}
                SELECT * FROM ({catalog_branch}) c
                UNION ALL
                SELECT * FROM ({mcp_branch}) m
            """
            params = (tenant_id, None, None, tenant_id)
        return self.execute_query(query, params)

    def list_lint_finding_decision_events_for_tenant(
        self,
        tenant_id: str,
        *,
        since: Any,
        project_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """List decision audit events in a window, oldest first (CLX-4.1, #4859 trends).

        Args:
            tenant_id: The caller's tenant.
            since: Inclusive lower bound on ``created_at`` (datetime or ISO string).
            project_id: When set, restricts to that project's decisions plus tenant-wide ones
                (matching how decisions apply to a project's findings).

        Returns:
            Event rows joined with their decision's fingerprint / project / owner columns.
        """
        clauses = ["e.tenant_id = %s", "e.created_at >= %s"]
        params: List[Any] = [tenant_id, since]
        if project_id:
            clauses.append("(d.project_id IS NULL OR d.project_id = %s)")
            params.append(project_id)
        query = f"""
            SELECT e.id, e.decision_id, e.before_state, e.after_state, e.rationale,
                   e.expires_at, e.linked_ticket, e.policy_version_id,
                   e.actor_user_id, e.actor_label, e.created_at,
                   d.source_fingerprint, d.project_id, d.rule_id, d.owner_user_id
            FROM apiome.lint_finding_decision_events e
            JOIN apiome.lint_finding_decisions d ON d.id = e.decision_id
            WHERE {' AND '.join(clauses)}
            ORDER BY e.created_at ASC, e.id
        """
        return self.execute_query(query, tuple(params))

    def list_style_guide_policy_versions_for_tenant(
        self, tenant_id: str, *, since: Any
    ) -> List[Dict[str, Any]]:
        """List policy pack publications in a window, oldest first (CLX-4.1, #4859 trends)."""
        query = """
            SELECT pv.id, pv.guide_id, pv.version_number, pv.actor_user_id, pv.actor_label,
                   pv.created_at
            FROM apiome.style_guide_policy_versions pv
            WHERE pv.tenant_id = %s AND pv.created_at >= %s
            ORDER BY pv.created_at ASC, pv.id
        """
        return self.execute_query(query, (tenant_id, since))

    # --- Lint workspace — saved views (CLX-4.1, #4859) ---------------------------------------

    _LINT_WORKSPACE_SAVED_VIEW_COLUMNS = (
        "id, tenant_id, user_id, name, filters, query, sort, is_pinned, created_at, updated_at"
    )

    def list_lint_workspace_saved_views(
        self, tenant_id: str, user_id: str
    ) -> List[Dict[str, Any]]:
        """List a user's saved workspace views, pinned first then newest (CLX-4.1, #4859)."""
        q = f"""
            SELECT {self._LINT_WORKSPACE_SAVED_VIEW_COLUMNS}
            FROM apiome.lint_workspace_saved_views
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid
            ORDER BY is_pinned DESC, updated_at DESC, name ASC
        """
        return [dict(r) for r in self.execute_query(q, (tenant_id, user_id))]

    def get_lint_workspace_saved_view(
        self, tenant_id: str, user_id: str, view_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one saved workspace view scoped to tenant + owner (CLX-4.1, #4859)."""
        q = f"""
            SELECT {self._LINT_WORKSPACE_SAVED_VIEW_COLUMNS}
            FROM apiome.lint_workspace_saved_views
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND user_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (view_id, tenant_id, user_id))
        return dict(rows[0]) if rows else None

    def create_lint_workspace_saved_view(
        self,
        tenant_id: str,
        user_id: str,
        *,
        name: str,
        filters: Dict[str, Any],
        query: str,
        sort: str,
        is_pinned: bool,
    ) -> Dict[str, Any]:
        """Insert a saved workspace view for the owner (CLX-4.1, #4859)."""
        q = f"""
            INSERT INTO apiome.lint_workspace_saved_views
                (tenant_id, user_id, name, filters, query, sort, is_pinned)
            VALUES (%s::uuid, %s::uuid, %s, %s::jsonb, %s, %s, %s)
            RETURNING {self._LINT_WORKSPACE_SAVED_VIEW_COLUMNS}
        """
        rows = self.execute_query(
            q,
            (tenant_id, user_id, name, Json(filters), query, sort, is_pinned),
        )
        return dict(rows[0]) if rows else {}

    def update_lint_workspace_saved_view(
        self,
        tenant_id: str,
        user_id: str,
        view_id: str,
        *,
        name: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        query: Optional[str] = None,
        sort: Optional[str] = None,
        is_pinned: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        """Patch a saved workspace view owned by the caller (CLX-4.1, #4859)."""
        sets: List[str] = ["updated_at = CURRENT_TIMESTAMP"]
        params: List[Any] = []
        if name is not None:
            sets.append("name = %s")
            params.append(name)
        if filters is not None:
            sets.append("filters = %s::jsonb")
            params.append(Json(filters))
        if query is not None:
            sets.append("query = %s")
            params.append(query)
        if sort is not None:
            sets.append("sort = %s")
            params.append(sort)
        if is_pinned is not None:
            sets.append("is_pinned = %s")
            params.append(is_pinned)
        params.extend([view_id, tenant_id, user_id])
        q = f"""
            UPDATE apiome.lint_workspace_saved_views
            SET {", ".join(sets)}
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND user_id = %s::uuid
            RETURNING {self._LINT_WORKSPACE_SAVED_VIEW_COLUMNS}
        """
        rows = self.execute_query(q, tuple(params))
        return dict(rows[0]) if rows else None

    def delete_lint_workspace_saved_view(
        self, tenant_id: str, user_id: str, view_id: str
    ) -> bool:
        """Delete a saved workspace view owned by the caller (CLX-4.1, #4859)."""
        q = """
            DELETE FROM apiome.lint_workspace_saved_views
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND user_id = %s::uuid
        """
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(q, (view_id, tenant_id, user_id))
                deleted = cur.rowcount > 0
            conn.commit()
            return deleted
        except Exception:
            conn.rollback()
            raise

    def set_version_source_format(
        self,
        version_record_id: str,
        tenant_id: str,
        source_format: Optional[str] = None,
        protocol: Optional[str] = None,
        format_metadata: Optional[Dict[str, Any]] = None,
        source_tool_versions: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Persist a revision's source format / protocol / format provenance (MFI-7.1/7.2, MFI-23.1).

        The import path captures what *kind* of API a revision came from (``source_format`` /
        ``protocol``) plus the format-specific metadata bag and tool-version provenance. Catalog
        items (MFI-23.1) project these off their latest revision, so a non-OpenAPI import is
        retrievable with its format/protocol/source. Scoped to ``tenant_id`` via the owning project
        so a caller cannot write onto another tenant's revision.

        ``format_metadata`` / ``source_tool_versions`` are JSONB columns that never accept NULL
        (they default to ``{}``); passing ``None`` leaves the existing value untouched via COALESCE.

        Returns:
            True when a matching live revision was updated, False otherwise.
        """
        import json
        format_metadata_json = json.dumps(format_metadata) if format_metadata is not None else None
        tool_versions_json = (
            json.dumps(source_tool_versions) if source_tool_versions is not None else None
        )
        query = """
            UPDATE apiome.versions v
            SET source_format = COALESCE(%s, v.source_format),
                protocol = COALESCE(%s, v.protocol),
                format_metadata = COALESCE(%s::jsonb, v.format_metadata),
                source_tool_versions = COALESCE(%s::jsonb, v.source_tool_versions),
                updated_at = CURRENT_TIMESTAMP
            FROM apiome.projects p
            WHERE v.id = %s
              AND v.project_id = p.id
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
            RETURNING v.id
        """
        rows = self.execute_query(
            query,
            (
                source_format,
                protocol,
                format_metadata_json,
                tool_versions_json,
                version_record_id,
                tenant_id,
            ),
        )
        return bool(rows)

    def get_version_quality_score(
        self, version_record_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Read the captured quality/lint score persisted on a revision (MFI-4.4 surfacing).

        Returns the ``quality_score`` / ``quality_grade`` / ``quality_report_fingerprint`` /
        ``quality_report`` that was rolled up and stored at import time (#3609 for specs,
        MFI-4.2 for canonical models) so all three surfaces (REST, ADE, CLI) can show the
        *authoritative persisted* score and findings for a version rather than only a live
        recompute. Scoped to ``tenant_id`` via the owning project so a caller cannot read
        another tenant's revision.

        Args:
            version_record_id: The ``versions.id`` (revision UUID) to read.
            tenant_id: The tenant that must own the revision's project.

        Returns:
            A dict with keys ``quality_score`` (int or None), ``quality_grade`` (str or None),
            ``quality_report_fingerprint`` (str or None), and ``quality_report`` (dict) when the
            revision exists; ``None`` when no matching revision is found for the tenant. A revision
            that has never been scored yields a dict whose score fields are all ``None`` and
            ``quality_report`` is ``{}``.
        """
        if not version_record_id or not is_uuid_string(str(version_record_id)):
            return None
        query = """
            SELECT v.quality_score, v.quality_grade, v.quality_report_fingerprint,
                   v.quality_report
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
        """
        rows = self.execute_query(query, (version_record_id, tenant_id))
        return rows[0] if rows else None

    def get_assigned_style_guide(
        self, tenant_id: str, project_id: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Resolve the style guide governing a lint run (GOV-1.4, #4430).

        Walks the V159 assignment chain in one query: a **project**-level assignment wins
        over a **tenant**-wide assignment, which wins over the tenant's ``is_default``
        guide. Every candidate is joined back to ``style_guides`` scoped by ``tenant_id``,
        so an assignment can never resolve to another tenant's guide.

        Args:
            tenant_id: The tenant whose guide chain applies.
            project_id: The owning project, when the caller has one. A non-UUID value
                (e.g. a slug) simply skips the project tier.

        Returns:
            A dict with ``id`` / ``name`` / ``source`` for the winning guide, or ``None``
            when the tenant has no assignment and no default guide (the caller then falls
            back to the in-code defaults).
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return None
        project_param = (
            str(project_id) if project_id and is_uuid_string(str(project_id)) else None
        )
        query = """
            SELECT g.id, g.name, g.source
            FROM (
                SELECT a.guide_id, 0 AS precedence
                FROM apiome.style_guide_assignments a
                WHERE a.project_id = %s
                UNION ALL
                SELECT a.guide_id, 1 AS precedence
                FROM apiome.style_guide_assignments a
                WHERE a.tenant_id = %s
                UNION ALL
                SELECT g2.id AS guide_id, 2 AS precedence
                FROM apiome.style_guides g2
                WHERE g2.tenant_id = %s AND g2.is_default
            ) candidate
            JOIN apiome.style_guides g
              ON g.id = candidate.guide_id AND g.tenant_id = %s
            ORDER BY candidate.precedence
            LIMIT 1
        """
        rows = self.execute_query(query, (project_param, tenant_id, tenant_id, tenant_id))
        return rows[0] if rows else None

    def get_style_guide_rules(self, guide_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        """Read a style guide's rule rows for compilation (GOV-1.4, #4430).

        Returns every ``style_guide_rules`` row of the guide — enabled and disabled alike,
        so the compiled guide's content fingerprint reflects the full row set — scoped to
        ``tenant_id`` via the owning guide so a caller cannot read another tenant's rules.

        Args:
            guide_id: The ``style_guides.id`` to read rules for.
            tenant_id: The tenant that must own the guide.

        Returns:
            Rows with ``rule_id`` / ``enabled`` / ``severity`` / ``custom_def`` (jsonb,
            already decoded to a dict or ``None``), sorted by ``rule_id``.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return []
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return []
        query = """
            SELECT r.rule_id, r.enabled, r.severity, r.custom_def
            FROM apiome.style_guide_rules r
            JOIN apiome.style_guides g ON r.guide_id = g.id
            WHERE r.guide_id = %s AND g.tenant_id = %s
            ORDER BY r.rule_id
        """
        return self.execute_query(query, (guide_id, tenant_id))

    def ensure_builtin_style_guide(self, tenant_id: str) -> None:
        """Seed the read-only "Apiome Recommended" guide when the tenant lacks one (GOV-2.1).

        V159 seeds the builtin guide for tenants that existed at migration time; tenants
        created later have none until something calls ``apiome.seed_builtin_style_guide``
        (idempotent, V118 pattern). Mirrors ``ensure_builtin_roles``: called on every list
        so the Style Guides screen self-heals. A no-op when the guide already exists.

        Args:
            tenant_id: The tenant to seed. Non-UUID values are ignored.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return
        rows = self.execute_query(
            "SELECT 1 FROM apiome.style_guides WHERE tenant_id = %s AND source = 'builtin'",
            (tenant_id,),
        )
        if not rows:
            self.execute_query("SELECT apiome.seed_builtin_style_guide(%s)", (tenant_id,))

    def list_style_guides(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List a tenant's style guides with list-view rollups (GOV-2.1, #4433).

        Args:
            tenant_id: The tenant whose guides to list.

        Returns:
            One row per guide — ``id`` / ``name`` / ``description`` / ``source`` /
            ``is_default`` / ``created_at`` / ``updated_at`` plus ``rule_count``,
            ``enabled_rule_count`` and ``tenant_assigned`` (an explicit tenant-wide
            assignment row points at the guide) — builtin guide first, then by name.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return []
        query = """
            SELECT g.id, g.name, g.description, g.source, g.is_default,
                   g.external_lint_profile,
                   g.created_at, g.updated_at,
                   COUNT(r.id) AS rule_count,
                   COUNT(r.id) FILTER (WHERE r.enabled) AS enabled_rule_count,
                   EXISTS (
                       SELECT 1 FROM apiome.style_guide_assignments a
                       WHERE a.guide_id = g.id AND a.tenant_id IS NOT NULL
                   ) AS tenant_assigned
            FROM apiome.style_guides g
            LEFT JOIN apiome.style_guide_rules r ON r.guide_id = g.id
            WHERE g.tenant_id = %s
            GROUP BY g.id
            ORDER BY (g.source = 'builtin') DESC, g.name ASC
        """
        return self.execute_query(query, (tenant_id,))

    def list_style_guide_project_assignments(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List every project-level style-guide assignment of a tenant (GOV-2.1, #4433).

        Args:
            tenant_id: The tenant whose assignments to list (scoped via the owning guide).

        Returns:
            Rows with ``guide_id`` / ``project_id`` / ``project_name`` for live (undeleted)
            projects, sorted by project name.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return []
        query = """
            SELECT a.guide_id, a.project_id, p.name AS project_name
            FROM apiome.style_guide_assignments a
            JOIN apiome.style_guides g ON g.id = a.guide_id
            JOIN apiome.projects p ON p.id = a.project_id
            WHERE g.tenant_id = %s
              AND a.project_id IS NOT NULL
              AND p.deleted_at IS NULL
            ORDER BY p.name ASC
        """
        return self.execute_query(query, (tenant_id,))

    def get_style_guide_by_id(self, guide_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Read one style guide, scoped to its owning tenant (GOV-2.1, #4433).

        Args:
            guide_id: The ``style_guides.id`` to read. Non-UUID values return ``None``.
            tenant_id: The tenant that must own the guide.

        Returns:
            The guide row (``id`` / ``name`` / ``description`` / ``source`` /
            ``is_default`` / ``created_at`` / ``updated_at``), or ``None``.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return None
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return None
        query = """
            SELECT id, name, description, source, is_default,
                   axis_gates, required_coverage, ci_outcomes,
                   external_lint_profile,
                   created_at, updated_at
            FROM apiome.style_guides
            WHERE id = %s AND tenant_id = %s
        """
        rows = self.execute_query(query, (guide_id, tenant_id))
        return rows[0] if rows else None

    def create_style_guide(
        self,
        tenant_id: str,
        name: str,
        description: Optional[str],
        source_guide_id: Optional[str] = None,
        external_lint_profile: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a custom style guide, optionally copying another guide's rules (GOV-2.1).

        Copying implements duplicate and "start from Recommended": every rule row of
        ``source_guide_id`` (enabled state, severity, custom defs alike) is copied onto the
        new guide in the same transaction. The new guide is always ``source='custom'`` and
        never the default — assignment is a separate, explicit action.

        Args:
            tenant_id: The owning tenant.
            name: Display name (unique per tenant — violations raise ``IntegrityError``).
            description: Optional description.
            source_guide_id: Same-tenant guide whose rules to copy, or ``None`` for empty.
            external_lint_profile: Optional CLX-2.2 profile; defaults to the source guide's
                profile when copying, otherwise ``baseline``.

        Returns:
            The created guide row.

        Raises:
            ValueError: ``source_guide_id`` is not a guide of this tenant.
            psycopg2.IntegrityError: The name is already taken in this tenant.
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                if source_guide_id is not None:
                    if not is_uuid_string(str(source_guide_id)):
                        raise ValueError("Source guide not found")
                    cursor.execute(
                        "SELECT 1 FROM apiome.style_guides WHERE id = %s AND tenant_id = %s",
                        (source_guide_id, tenant_id),
                    )
                    if cursor.fetchone() is None:
                        raise ValueError("Source guide not found")
                profile = (external_lint_profile or "").strip() or None
                cursor.execute(
                    """
                    INSERT INTO apiome.style_guides (
                        tenant_id, name, description, source, is_default, external_lint_profile
                    )
                    VALUES (
                        %s, %s, %s, 'custom', false,
                        COALESCE(
                            %s,
                            (SELECT external_lint_profile FROM apiome.style_guides WHERE id = %s),
                            'baseline'
                        )
                    )
                    RETURNING id, name, description, source, is_default, external_lint_profile,
                              created_at, updated_at
                    """,
                    (tenant_id, name.strip(), description, profile, source_guide_id),
                )
                guide = cursor.fetchone()
                if source_guide_id is not None:
                    cursor.execute(
                        """
                        INSERT INTO apiome.style_guide_rules (guide_id, rule_id, enabled, severity, custom_def)
                        SELECT %s, rule_id, enabled, severity, custom_def
                        FROM apiome.style_guide_rules
                        WHERE guide_id = %s
                        """,
                        (guide["id"], source_guide_id),
                    )
            conn.commit()
            return guide
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def update_style_guide(
        self,
        guide_id: str,
        tenant_id: str,
        name: str,
        description: Optional[str],
        external_lint_profile: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Rename / re-describe a custom style guide (GOV-2.1, #4433).

        The builtin guide is excluded in the WHERE clause as defence in depth — the route
        layer already rejects it with a 409 before calling here.

        Args:
            guide_id: The guide to update. Non-UUID values return ``None``.
            tenant_id: The tenant that must own the guide.
            name: The final name to store (caller resolves partial updates).
            description: The final description to store.
            external_lint_profile: Optional CLX-2.2 profile (``baseline`` /
                ``tenant_guide`` / ``strict``); ``None`` leaves the column unchanged.

        Returns:
            The updated guide row, or ``None`` when no matching custom guide exists.

        Raises:
            psycopg2.IntegrityError: The name is already taken in this tenant.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return None
        query = """
            UPDATE apiome.style_guides
            SET name = %s,
                description = %s,
                external_lint_profile = COALESCE(%s, external_lint_profile),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s AND tenant_id = %s AND source <> 'builtin'
            RETURNING id, name, description, source, is_default, external_lint_profile,
                      created_at, updated_at
        """
        rows = self.execute_query(
            query, (name.strip(), description, external_lint_profile, guide_id, tenant_id)
        )
        return rows[0] if rows else None

    def replace_style_guide_builtin_rules(
        self,
        guide_id: str,
        tenant_id: str,
        rules: List[Dict[str, Any]],
    ) -> bool:
        """Replace a guide's built-in rule rows with ``rules`` (GOV-2.2, #4434).

        The rule catalog tab saves its whole state at once, so this is a transactional
        delete-and-insert of the guide's built-in rows (``custom_def IS NULL``). Custom-rule
        rows are left untouched — they belong to the custom-rules tab (GOV-2.3). The guide's
        ``updated_at`` is bumped so the list view reflects the edit, and the next lint run
        picks the change up via the content-addressed compile cache (GOV-1.4).

        The builtin guide is excluded in the WHERE clause as defence in depth — the route
        layer already rejects it with a 409 before calling here.

        Args:
            guide_id: The guide to write. Non-UUID values return ``False``.
            tenant_id: The tenant that must own the guide.
            rules: Rows to store — dicts with ``rule_id`` / ``enabled`` / ``severity`` keys.

        Returns:
            ``True`` when the guide exists and was updated, ``False`` when none matched.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return False
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return False
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE apiome.style_guides
                    SET updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND tenant_id = %s AND source <> 'builtin'
                    RETURNING id
                    """,
                    (guide_id, tenant_id),
                )
                if cursor.fetchone() is None:
                    conn.rollback()
                    return False
                cursor.execute(
                    "DELETE FROM apiome.style_guide_rules WHERE guide_id = %s AND custom_def IS NULL",
                    (guide_id,),
                )
                for rule in rules:
                    cursor.execute(
                        """
                        INSERT INTO apiome.style_guide_rules (guide_id, rule_id, enabled, severity)
                        VALUES (%s, %s, %s, %s)
                        """,
                        (guide_id, rule["rule_id"], bool(rule["enabled"]), rule["severity"]),
                    )
            conn.commit()
            return True
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def replace_style_guide_custom_rules(
        self,
        guide_id: str,
        tenant_id: str,
        rules: List[Dict[str, Any]],
    ) -> bool:
        """Replace a guide's custom-rule rows with ``rules`` (GOV-2.3, #4435).

        The custom-rules tab saves its whole YAML document at once, so this is a transactional
        delete-and-insert of rows carrying a ``custom_def``. Built-in rows (``custom_def IS NULL``)
        are left untouched — they belong to the rule-catalog tab (GOV-2.2).

        Args:
            guide_id: The guide to write. Non-UUID values return ``False``.
            tenant_id: The tenant that must own the guide.
            rules: Rows to store — dicts with ``rule_id`` / ``enabled`` / ``severity`` /
                ``custom_def`` keys (``custom_def`` is the validated jsonb shape).

        Returns:
            ``True`` when the guide exists and was updated, ``False`` when none matched.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return False
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return False
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE apiome.style_guides
                    SET updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND tenant_id = %s AND source <> 'builtin'
                    RETURNING id
                    """,
                    (guide_id, tenant_id),
                )
                if cursor.fetchone() is None:
                    conn.rollback()
                    return False
                cursor.execute(
                    "DELETE FROM apiome.style_guide_rules WHERE guide_id = %s AND custom_def IS NOT NULL",
                    (guide_id,),
                )
                for rule in rules:
                    cursor.execute(
                        """
                        INSERT INTO apiome.style_guide_rules
                            (guide_id, rule_id, enabled, severity, custom_def)
                        VALUES (%s, %s, %s, %s, %s::jsonb)
                        """,
                        (
                            guide_id,
                            rule["rule_id"],
                            bool(rule.get("enabled", True)),
                            rule["severity"],
                            json.dumps(rule["custom_def"]),
                        ),
                    )
            conn.commit()
            return True
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def delete_style_guide(self, guide_id: str, tenant_id: str) -> bool:
        """Delete a custom style guide (GOV-2.1, #4433).

        Assignment rows cascade with the guide. When the deleted guide was the tenant
        default, the builtin "Apiome Recommended" guide is promoted back to default in the
        same transaction, so the tenant always keeps a resolvable default. The builtin
        guide itself is excluded in the WHERE clause (defence in depth behind the route's
        409).

        Args:
            guide_id: The guide to delete. Non-UUID values return ``False``.
            tenant_id: The tenant that must own the guide.

        Returns:
            ``True`` when a guide was deleted, ``False`` when none matched.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return False
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    DELETE FROM apiome.style_guides
                    WHERE id = %s AND tenant_id = %s AND source <> 'builtin'
                    RETURNING is_default
                    """,
                    (guide_id, tenant_id),
                )
                deleted = cursor.fetchone()
                if deleted and deleted["is_default"]:
                    cursor.execute(
                        """
                        UPDATE apiome.style_guides
                        SET is_default = true, updated_at = CURRENT_TIMESTAMP
                        WHERE tenant_id = %s AND source = 'builtin'
                        """,
                        (tenant_id,),
                    )
            conn.commit()
            return deleted is not None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def set_style_guide_tenant_default(
        self, guide_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Make a guide the tenant default (GOV-2.1, #4433).

        In one transaction: moves the ``is_default`` flag onto the guide and replaces the
        tenant-wide ``style_guide_assignments`` row with one pointing at it. The two
        mechanisms are tiers 1 and 2 of the GOV-1.4 resolution chain; writing both keeps
        them agreeing, so the list view's default badge (``is_default``) is always what
        lint actually resolves for projects without their own assignment.

        Args:
            guide_id: The guide to promote. Non-UUID values return ``None``.
            tenant_id: The tenant that must own the guide.

        Returns:
            The promoted guide row, or ``None`` when the guide is not the tenant's.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return None
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT 1 FROM apiome.style_guides WHERE id = %s AND tenant_id = %s",
                    (guide_id, tenant_id),
                )
                if cursor.fetchone() is None:
                    conn.rollback()
                    return None
                cursor.execute(
                    """
                    UPDATE apiome.style_guides
                    SET is_default = false, updated_at = CURRENT_TIMESTAMP
                    WHERE tenant_id = %s AND is_default AND id <> %s
                    """,
                    (tenant_id, guide_id),
                )
                cursor.execute(
                    """
                    UPDATE apiome.style_guides
                    SET is_default = true, updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND tenant_id = %s
                    RETURNING id, name, description, source, is_default, created_at, updated_at
                    """,
                    (guide_id, tenant_id),
                )
                guide = cursor.fetchone()
                cursor.execute(
                    "DELETE FROM apiome.style_guide_assignments WHERE tenant_id = %s",
                    (tenant_id,),
                )
                cursor.execute(
                    """
                    INSERT INTO apiome.style_guide_assignments (guide_id, tenant_id)
                    VALUES (%s, %s)
                    """,
                    (guide_id, tenant_id),
                )
            conn.commit()
            return guide
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def assign_style_guide_to_project(
        self, guide_id: str, tenant_id: str, project_id: str
    ) -> bool:
        """Assign a guide to one project (GOV-2.1, #4433) — tier 0 of the GOV-1.4 chain.

        Replaces any existing assignment of the project (a project has at most one). Both
        the guide and the project must belong to ``tenant_id``; the V159 schema leaves that
        consistency to this service layer.

        Args:
            guide_id: The guide to assign. Non-UUID values return ``False``.
            tenant_id: The tenant that must own both the guide and the project.
            project_id: The project to assign. Non-UUID values return ``False``.

        Returns:
            ``True`` on success, ``False`` when guide or project is not the tenant's.
        """
        if not guide_id or not is_uuid_string(str(guide_id)):
            return False
        if not project_id or not is_uuid_string(str(project_id)):
            return False
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT 1 FROM apiome.style_guides WHERE id = %s AND tenant_id = %s",
                    (guide_id, tenant_id),
                )
                if cursor.fetchone() is None:
                    conn.rollback()
                    return False
                cursor.execute(
                    """
                    SELECT 1 FROM apiome.projects
                    WHERE id = %s AND tenant_id = %s AND deleted_at IS NULL
                    """,
                    (project_id, tenant_id),
                )
                if cursor.fetchone() is None:
                    conn.rollback()
                    return False
                cursor.execute(
                    "DELETE FROM apiome.style_guide_assignments WHERE project_id = %s",
                    (project_id,),
                )
                cursor.execute(
                    """
                    INSERT INTO apiome.style_guide_assignments (guide_id, project_id)
                    VALUES (%s, %s)
                    """,
                    (guide_id, project_id),
                )
            conn.commit()
            return True
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def unassign_style_guide_from_project(self, tenant_id: str, project_id: str) -> bool:
        """Remove a project's style-guide assignment (GOV-2.1, #4433).

        The project then falls back to the tenant-wide assignment / default guide per the
        GOV-1.4 resolution order. Scoped through the owning guide so a caller cannot clear
        another tenant's assignment.

        Args:
            tenant_id: The tenant that must own the assignment's guide.
            project_id: The project whose assignment to remove. Non-UUID returns ``False``.

        Returns:
            ``True`` when an assignment row was removed, ``False`` when none existed.
        """
        if not project_id or not is_uuid_string(str(project_id)):
            return False
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return False
        query = """
            DELETE FROM apiome.style_guide_assignments a
            USING apiome.style_guides g
            WHERE a.guide_id = g.id
              AND g.tenant_id = %s
              AND a.project_id = %s
            RETURNING a.id
        """
        rows = self.execute_query(query, (tenant_id, project_id))
        return bool(rows)

    def get_project_by_id(
        self, project_id: str, tenant_id: str, *, include_deleted: bool = False
    ) -> Optional[Dict[str, Any]]:
        """Get a specific project by ID, ensuring it belongs to the tenant.

        Includes the same versions summary (``versions_count``, mean quality score/grade) as
        :meth:`get_projects_for_tenant` so single-project reads match the list shape.
        """
        deleted_clause = "" if include_deleted else "AND p.deleted_at IS NULL"
        query = f"""
            SELECT p.id, p.tenant_id, p.creator_id, p.name, p.description, p.slug,
                   p.enabled, p.metadata, p.change_report_template_version_id, p.publishable,
                   p.created_at, p.updated_at,
                   p.deleted_at,
                   u.name as creator_name, u.email as creator_email,
                   {self._PROJECT_VERSIONS_SUMMARY_COLUMNS}
            FROM apiome.projects p
            LEFT JOIN apiome.users u ON p.creator_id = u.id
            {self._PROJECT_VERSIONS_SUMMARY_LATERAL}
            WHERE p.id = %s AND p.tenant_id = %s {deleted_clause}
        """
        results = self.execute_query(query, (project_id, tenant_id))
        return results[0] if results else None

    def get_project_by_slug(self, slug: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific project by slug, ensuring it belongs to the tenant."""
        query = """
            SELECT p.id, p.tenant_id, p.creator_id, p.name, p.description, p.slug,
                   p.enabled, p.metadata, p.change_report_template_version_id, p.publishable,
                   p.created_at, p.updated_at,
                   u.name as creator_name, u.email as creator_email
            FROM apiome.projects p
            LEFT JOIN apiome.users u ON p.creator_id = u.id
            WHERE p.slug = %s AND p.tenant_id = %s AND p.deleted_at IS NULL
        """
        results = self.execute_query(query, (slug, tenant_id))
        return results[0] if results else None

    def allocate_project_slug(self, tenant_id: str, base_slug: str) -> str:
        """Pick a tenant-unique project slug derived from ``base_slug``.

        Returns ``base_slug`` when free, otherwise the first free ``base_slug-N`` (N ≥ 2).
        Collision detection includes soft-deleted rows because ``(tenant_id, slug)`` is unique
        across all projects.
        """
        base = (base_slug or "imported-source").strip().lower() or "imported-source"
        query = """
            SELECT slug FROM apiome.projects
            WHERE tenant_id = %s AND (slug = %s OR slug LIKE %s)
        """
        rows = self.execute_query(query, (tenant_id, base, f"{base}-%"))
        taken = {str(row["slug"]) for row in rows}
        if base not in taken:
            return base
        suffix = 2
        while f"{base}-{suffix}" in taken:
            suffix += 1
        return f"{base}-{suffix}"

    def allocate_version_id(self, project_id: str, base_version_id: str) -> str:
        """Pick a project-unique version label derived from ``base_version_id``.

        Returns ``base_version_id`` when free, otherwise the first free ``base_version_id-N`` (N ≥ 2).
        Collision detection includes soft-deleted rows because ``(project_id, version_id)`` is unique
        across all versions.
        """
        base = (base_version_id or "1.0.0").strip() or "1.0.0"
        query = """
            SELECT version_id FROM apiome.versions
            WHERE project_id = %s AND (version_id = %s OR version_id LIKE %s)
        """
        rows = self.execute_query(query, (project_id, base, f"{base}-%"))
        taken = {str(row["version_id"]) for row in rows}
        if base not in taken:
            return base
        suffix = 2
        while f"{base}-{suffix}" in taken:
            suffix += 1
        return f"{base}-{suffix}"

    def create_project(
        self,
        tenant_id: str,
        creator_id: Optional[str],
        name: str,
        slug: str,
        description: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        publishable: bool = True,
    ) -> Dict[str, Any]:
        """Create a new project.

        ``publishable`` is the Project-vs-Catalog boundary (MFI-23.1): pass ``True`` (the default,
        preserving today's behaviour) for an OpenAPI/Swagger Project, ``False`` to create a
        non-publishable catalog item (an OpenAPI-worthy non-OpenAPI import, routed here by MFI-23.7).
        The flag is write-once — a database trigger rejects any later change — so a catalog item can
        never be promoted to a publishable Project except via the MFI-EPIC-22 convert flow.
        """
        import json
        query = """
            INSERT INTO apiome.projects
            (tenant_id, creator_id, name, description, slug, metadata, publishable)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id, tenant_id, creator_id, name, description, slug,
                      enabled, metadata, change_report_template_version_id, publishable,
                      created_at, updated_at
        """
        metadata_json = json.dumps(metadata) if metadata else '{}'

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (tenant_id, creator_id, name, description, slug.lower(), metadata_json, publishable)
                )
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_project(
        self,
        project_id: str,
        tenant_id: str,
        updates: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update an existing project, ensuring it belongs to the tenant."""
        import json

        # First verify the project belongs to the tenant
        existing = self.get_project_by_id(project_id, tenant_id)
        if not existing:
            return None

        # Build dynamic update query
        update_fields = []
        params = []

        if 'name' in updates and updates['name'] is not None:
            update_fields.append("name = %s")
            params.append(updates['name'])
        if 'description' in updates:
            update_fields.append("description = %s")
            params.append(updates['description'])
        if 'slug' in updates and updates['slug'] is not None:
            update_fields.append("slug = %s")
            params.append(updates['slug'].lower())
        if 'enabled' in updates and updates['enabled'] is not None:
            update_fields.append("enabled = %s")
            params.append(updates['enabled'])
        if 'metadata' in updates:
            update_fields.append("metadata = %s")
            params.append(json.dumps(updates['metadata']) if updates['metadata'] else '{}')
        if 'change_report_template_version_id' in updates:
            update_fields.append("change_report_template_version_id = %s")
            params.append(updates['change_report_template_version_id'])

        if not update_fields:
            # Nothing to update, return current project
            return existing

        # Always update updated_at
        update_fields.append("updated_at = CURRENT_TIMESTAMP")

        params.extend([project_id, tenant_id])
        query = f"""
            UPDATE apiome.projects
            SET {', '.join(update_fields)}
            WHERE id = %s AND tenant_id = %s AND deleted_at IS NULL
            RETURNING id, tenant_id, creator_id, name, description, slug,
                      enabled, metadata, change_report_template_version_id, publishable,
                      created_at, updated_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_project(self, project_id: str, tenant_id: str) -> bool:
        """Soft delete a project, ensuring it belongs to the tenant."""
        query = """
            UPDATE apiome.projects
            SET pre_delete_enabled = enabled, enabled = false,
                deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s AND tenant_id = %s AND deleted_at IS NULL
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (project_id, tenant_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def restore_project(self, project_id: str, tenant_id: str) -> bool:
        """Clear soft-delete on a project, restoring its pre-delete enabled state."""
        query = """
            UPDATE apiome.projects
            SET deleted_at = NULL,
                enabled = COALESCE(pre_delete_enabled, TRUE),
                pre_delete_enabled = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s AND tenant_id = %s AND deleted_at IS NOT NULL
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (project_id, tenant_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Version CRUD Operations ====================

    def get_versions_for_project(
        self,
        project_id: str,
        tenant_id: str,
        lifecycle: Optional[str] = None,
        *,
        message_q: Optional[str] = None,
        creator_id: Optional[str] = None,
        created_after: Optional[datetime] = None,
        created_before: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """Get all versions for a project, ensuring project belongs to tenant.

        Optional lifecycle filter (#739). Optional history filters (#2579): substring match on
        revision note / changelog / commit message body, creator id, and created_at range.
        """
        lifecycle_clause = ""
        params: List[Any] = [project_id, tenant_id]
        if lifecycle:
            lifecycle_clause = f" AND {sql_effective_lifecycle_expr('v')} = %s"
            params.append(lifecycle.strip().lower())

        message_clause = ""
        mq = (message_q or "").strip()
        if mq:
            message_clause = """
              AND (
                strpos(lower(COALESCE(v.description, '')), lower(%s)) > 0
                OR strpos(lower(COALESCE(v.change_log, '')), lower(%s)) > 0
                OR strpos(lower(COALESCE(v.commit_message, '')), lower(%s)) > 0
                OR strpos(lower(COALESCE(v.commit_author, '')), lower(%s)) > 0
              )
            """
            params.extend([mq, mq, mq, mq])

        creator_clause = ""
        cid = (creator_id or "").strip()
        if cid:
            creator_clause = " AND v.creator_id = %s"
            params.append(cid)

        created_after_clause = ""
        if created_after is not None:
            created_after_clause = " AND v.created_at >= %s"
            params.append(created_after)

        created_before_clause = ""
        if created_before is not None:
            created_before_clause = " AND v.created_at <= %s"
            params.append(created_before)

        query = f"""
            SELECT v.id, v.project_id, v.creator_id, v.version_id, v.description,
                   v.change_log, v.visibility, v.published, v.published_at, v.published_immutable,
                   v.mock_enabled,
                   v.mock_settings,
                   v.enabled, v.parent_version_id, v.merge_parent_version_id,
                   v.forked_from_revision_id, v.upstream_project_id,
                   v.revision_locked, v.metadata,
                   v.commit_author, v.commit_message, v.external_ref,
                   v.source_commit_sha, v.source_committed_at,
                   vf.version_id AS fork_source_version_string,
                   pf.name AS fork_source_project_name,
                   up.name AS upstream_project_name,
                   v.created_at, v.updated_at,
                   u.name as creator_name, u.email as creator_email,
                   p.name as project_name, p.slug as project_slug
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            LEFT JOIN apiome.versions vf ON vf.id = v.forked_from_revision_id AND vf.deleted_at IS NULL
            LEFT JOIN apiome.projects pf ON pf.id = vf.project_id AND pf.deleted_at IS NULL
            LEFT JOIN apiome.projects up ON up.id = v.upstream_project_id AND up.deleted_at IS NULL
            LEFT JOIN apiome.users u ON v.creator_id = u.id
            WHERE v.project_id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
              {lifecycle_clause}
              {message_clause}
              {creator_clause}
              {created_after_clause}
              {created_before_clause}
            ORDER BY v.created_at DESC
        """
        return self.execute_query(query, tuple(params))

    def list_sunset_timeline_entries(
        self, tenant_id: str, project_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Schema revisions with deprecation and/or a sunset date (#508).
        """
        project_filter = ""
        params: List[Any] = [tenant_id]
        if project_id:
            project_filter = " AND v.project_id = %s"
            params.append(project_id)

        query = f"""
            SELECT v.id, v.project_id, v.version_id, v.metadata, v.published,
                   p.name AS project_name, p.slug AS project_slug
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
              {project_filter}
              AND (
                COALESCE(v.metadata->>'deprecated', '') IN ('true', '1', 'True', 'yes')
                OR (v.metadata @> '{{"deprecated": true}}'::jsonb)
                OR NULLIF(trim(COALESCE(v.metadata->>'sunsetDate', v.metadata->>'sunset_date', '')), '') IS NOT NULL
              )
            ORDER BY p.name ASC, v.version_id ASC
        """
        return self.execute_query(query, tuple(params))

    def get_version_by_id(self, version_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific version by ID, ensuring it belongs to the tenant."""
        # A non-UUID identifier (e.g. a version string like '0.0.1' sent to a route that
        # expects the version record UUID) can never match v.id and would otherwise raise
        # psycopg2 InvalidTextRepresentation -> a 500. Treat it as "not found" instead.
        if not version_id or not is_uuid_string(str(version_id)):
            return None
        query = """
            SELECT v.id, v.project_id, v.creator_id, v.version_id, v.description,
                   v.change_log, v.visibility, v.published, v.published_at, v.published_immutable,
                   v.mock_enabled,
                   v.mock_settings,
                   v.enabled, v.parent_version_id, v.merge_parent_version_id,
                   v.forked_from_revision_id, v.upstream_project_id,
                   v.revision_locked, v.metadata,
                   v.commit_author, v.commit_message, v.external_ref,
                   v.source_commit_sha, v.source_committed_at,
                   vf.version_id AS fork_source_version_string,
                   pf.name AS fork_source_project_name,
                   up.name AS upstream_project_name,
                   v.created_at, v.updated_at,
                   u.name as creator_name, u.email as creator_email,
                   p.name as project_name, p.slug as project_slug
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            LEFT JOIN apiome.versions vf ON vf.id = v.forked_from_revision_id AND vf.deleted_at IS NULL
            LEFT JOIN apiome.projects pf ON pf.id = vf.project_id AND pf.deleted_at IS NULL
            LEFT JOIN apiome.projects up ON up.id = v.upstream_project_id AND up.deleted_at IS NULL
            LEFT JOIN apiome.users u ON v.creator_id = u.id
            WHERE v.id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
        """
        results = self.execute_query(query, (version_id, tenant_id))
        return results[0] if results else None

    def get_version_by_version_id(self, project_id: str, version_id_str: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific version by version_id string (e.g., '1.0.0'), ensuring it belongs to tenant."""
        query = """
            SELECT v.id, v.project_id, v.creator_id, v.version_id, v.description,
                   v.change_log, v.visibility, v.published, v.published_at, v.published_immutable,
                   v.mock_enabled,
                   v.mock_settings,
                   v.enabled, v.parent_version_id, v.merge_parent_version_id,
                   v.forked_from_revision_id, v.upstream_project_id,
                   v.revision_locked, v.metadata,
                   v.commit_author, v.commit_message, v.external_ref,
                   v.source_commit_sha, v.source_committed_at,
                   vf.version_id AS fork_source_version_string,
                   pf.name AS fork_source_project_name,
                   up.name AS upstream_project_name,
                   v.created_at, v.updated_at,
                   u.name as creator_name, u.email as creator_email,
                   p.name as project_name, p.slug as project_slug
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            LEFT JOIN apiome.versions vf ON vf.id = v.forked_from_revision_id AND vf.deleted_at IS NULL
            LEFT JOIN apiome.projects pf ON pf.id = vf.project_id AND pf.deleted_at IS NULL
            LEFT JOIN apiome.projects up ON up.id = v.upstream_project_id AND up.deleted_at IS NULL
            LEFT JOIN apiome.users u ON v.creator_id = u.id
            WHERE v.project_id = %s
              AND v.version_id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
        """
        results = self.execute_query(query, (project_id, version_id_str, tenant_id))
        return results[0] if results else None

    def get_version_source_projection(
        self, version_record_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Project one revision's captured-source fields for canonical-model rebuild (MFX-2.5).

        The catalog item view (:meth:`get_catalog_item_by_id`) projects the *latest* revision's
        ``source_format`` / ``protocol`` / ``format_metadata`` / ``tool_versions``. Export fidelity
        is **version-scoped** (a version may differ from the latest), so this returns the same
        projection for a *specific* revision, shaped like a catalog item row so
        :func:`app.catalog_conversion.build_conversion_source` can rebuild its canonical model.
        Scoped to ``tenant_id`` via the owning project so a caller cannot read another tenant's
        revision.

        Args:
            version_record_id: The revision (``versions.id``) to project.
            tenant_id: Owning tenant id.

        Returns:
            A row carrying ``id`` (the owning project id), ``project_slug``, ``version_label``,
            ``source_format``, ``protocol``, ``format_metadata``, ``tool_versions`` and the project
            ``metadata``, or ``None`` when no live revision with that id exists for the tenant.
        """
        if not version_record_id or not is_uuid_string(str(version_record_id)):
            return None
        query = """
            SELECT v.project_id AS id, p.slug AS project_slug,
                   v.version_id AS version_label,
                   v.source_format, v.protocol, v.format_metadata,
                   v.source_tool_versions AS tool_versions,
                   p.metadata
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
        """
        results = self.execute_query(query, (version_record_id, tenant_id))
        return results[0] if results else None

    def get_public_version_source_projection(
        self, tenant_slug: str, project_slug: str, version_slug: str
    ) -> Optional[Dict[str, Any]]:
        """Project a **published, public** revision's captured-source fields by slugs (MFX-7.1).

        The public browse export path (`/v1/browse/.../export/*`) resolves its source from URL
        slugs, not from an authenticated tenant id, so this variant of
        :meth:`get_version_source_projection` joins tenants → projects → versions on their slugs
        and hard-gates on the public browse predicate (``published IS TRUE AND visibility =
        'public'``, undeleted — the same slice ``apiome-browse`` and the ``/v1/browse`` directory
        serve). A private, unpublished, or deleted revision is indistinguishable from a missing
        one: both return ``None``, so a caller can never learn that a hidden artifact exists.

        Args:
            tenant_slug: The owning tenant's slug.
            project_slug: The project (artifact) slug within the tenant.
            version_slug: The version label (``versions.version_id``, e.g. ``1.0.0``).

        Returns:
            A row shaped like :meth:`get_version_source_projection`'s (``id`` is the owning
            project id, plus ``project_slug``, ``version_label``, ``source_format``,
            ``protocol``, ``format_metadata``, ``tool_versions``, project ``metadata``) with an
            extra ``version_record_id`` (the resolved ``versions.id``), or ``None`` when no
            published public revision matches the slugs.
        """
        query = """
            SELECT p.id AS id, p.slug AS project_slug,
                   v.id AS version_record_id,
                   v.version_id AS version_label,
                   v.source_format, v.protocol, v.format_metadata,
                   v.source_tool_versions AS tool_versions,
                   p.metadata
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            JOIN apiome.tenants t ON p.tenant_id = t.id
            WHERE t.slug = %s
              AND p.slug = %s
              AND v.version_id = %s
              AND v.published IS TRUE
              AND v.visibility = 'public'
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
              AND t.deleted_at IS NULL
        """
        results = self.execute_query(query, (tenant_slug, project_slug, version_slug))
        return results[0] if results else None

    def revision_has_protected_named_ref(
        self, version_row_id: str, project_id: str, tenant_id: str
    ) -> bool:
        """
        True if this revision is the tip of a protected branch or the target of a protected tag (#504).
        Used to block successor redirection off an immutable anchor (#749).
        """
        q_branch = """
            SELECT 1 FROM apiome.version_branches b
            INNER JOIN apiome.projects p ON p.id = b.project_id AND p.deleted_at IS NULL
            WHERE b.project_id = %s AND b.tip_version_id = %s AND b.protected = TRUE
              AND p.tenant_id = %s
            LIMIT 1
        """
        q_tag = """
            SELECT 1 FROM apiome.version_tags t
            INNER JOIN apiome.projects p ON p.id = t.project_id AND p.deleted_at IS NULL
            WHERE t.project_id = %s AND t.version_id = %s AND t.protected = TRUE
              AND p.tenant_id = %s
            LIMIT 1
        """
        if self.execute_query(q_branch, (project_id, version_row_id, tenant_id)):
            return True
        if self.execute_query(q_tag, (project_id, version_row_id, tenant_id)):
            return True
        return False

    def resolve_successor_revision_chain(
        self,
        start_version_id: str,
        tenant_id: str,
        project_id: str,
        *,
        max_hops: int = 32,
    ) -> Tuple[str, List[str], str, Optional[str]]:
        """
        Walk ``metadata.successorRevisionId`` from ``start_version_id`` (#749).

        Returns ``(final_id, hop_targets, status, missing_successor_id)`` where ``hop_targets`` lists
        each successor revision id visited in order. ``missing_successor_id`` is set when ``status``
        is ``missing_target`` (pointer to a deleted or unknown revision).
        """
        current = start_version_id
        visited: Set[str] = {start_version_id}
        hops: List[str] = []

        for _ in range(max_hops + 1):
            row = self.get_version_by_id(current, tenant_id)
            if not row:
                return current, hops, "missing_target", None
            if str(row.get("project_id")) != project_id:
                return current, hops, "project_mismatch", None

            succ = successor_revision_id_from_metadata(row.get("metadata"))
            if not succ:
                st = "none" if not hops else "resolved"
                return current, hops, st, None

            if self.revision_has_protected_named_ref(current, project_id, tenant_id):
                return current, hops, "blocked_protected_ref", None

            if succ in visited:
                return current, hops, "cycle", None

            nxt = self.get_version_by_id(succ, tenant_id)
            if not nxt:
                return current, hops, "missing_target", succ
            if str(nxt.get("project_id")) != project_id:
                return current, hops, "project_mismatch", None

            hops.append(succ)
            visited.add(succ)
            current = succ

        return current, hops, "max_hops_exceeded", None

    def get_latest_version_for_project(self, project_id: str, tenant_id: str) -> Optional[str]:
        """Get the latest version_id string for a project."""
        query = """
            SELECT v.version_id
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.project_id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
            ORDER BY v.created_at DESC
            LIMIT 1
        """
        results = self.execute_query(query, (project_id, tenant_id))
        return results[0]['version_id'] if results else None

    def create_version(
        self,
        project_id: str,
        creator_id: Optional[str],
        version_id: str,
        description: Optional[str] = None,
        change_log: Optional[str] = None,
        commit_author: Optional[str] = None,
        commit_message: Optional[str] = None,
        external_ref: Optional[str] = None,
        source_commit_sha: Optional[str] = None,
        source_committed_at: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Create a new version.

        ``source_commit_sha`` / ``source_committed_at`` record RAR-4.2 refresh
        provenance: the repository source commit that produced this revision. Both
        default to ``None`` for hand-authored / non-repository revisions.
        """
        query = """
            INSERT INTO apiome.versions
            (project_id, creator_id, version_id, description, change_log,
             commit_author, commit_message, external_ref,
             source_commit_sha, source_committed_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, project_id, creator_id, version_id, description,
                      change_log, visibility, published, published_at,
                      enabled, parent_version_id, merge_parent_version_id,
                      commit_author, commit_message, external_ref,
                      source_commit_sha, source_committed_at,
                      created_at, updated_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (
                        project_id,
                        creator_id,
                        version_id,
                        description,
                        change_log,
                        commit_author,
                        commit_message,
                        external_ref,
                        source_commit_sha,
                        source_committed_at,
                    ),
                )
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def apply_version_refresh_provenance(
        self,
        version_record_id: str,
        tenant_id: str,
        *,
        parent_version_id: Optional[str] = None,
        source_commit_sha: Optional[str] = None,
        source_committed_at: Optional[Any] = None,
    ) -> Optional[Dict[str, Any]]:
        """Stamp RAR-4.2 refresh provenance onto an existing version row.

        A repository auto-refresh creates the new version through the import worker;
        this records the refresh lineage on that row afterwards: the prior version it
        supersedes (``parent_version_id``) and the source commit that triggered it
        (``source_commit_sha`` + ``source_committed_at``). The update is tenant-scoped
        via the owning project so a refresh cannot stamp another tenant's version.

        Only non-``None`` arguments are written; passing ``None`` leaves the existing
        column untouched (so a parent already set by the importer is preserved when a
        caller stamps only the commit signals).

        Args:
            version_record_id: The version row id (``versions.id``) to stamp.
            tenant_id: The tenant that must own the version's project.
            parent_version_id: Prior version this refresh supersedes; the new
                version's linear parent.
            source_commit_sha: Repository source commit SHA that triggered the refresh.
            source_committed_at: Commit timestamp of ``source_commit_sha``.

        Returns:
            The updated version row (via :meth:`get_version_by_id`), or ``None`` when
            no version matches the id within the tenant.
        """
        sets: List[str] = []
        params: List[Any] = []
        if parent_version_id is not None:
            sets.append("parent_version_id = %s")
            params.append(parent_version_id)
        if source_commit_sha is not None:
            sets.append("source_commit_sha = %s")
            params.append(source_commit_sha)
        if source_committed_at is not None:
            sets.append("source_committed_at = %s")
            params.append(source_committed_at)

        if not sets:
            # Nothing to record — return the current row unchanged.
            return self.get_version_by_id(version_record_id, tenant_id)

        sets.append("updated_at = CURRENT_TIMESTAMP")
        query = f"""
            UPDATE apiome.versions v
            SET {", ".join(sets)}
            FROM apiome.projects p
            WHERE v.id = %s
              AND v.project_id = p.id
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
            RETURNING v.id
        """
        params.extend([version_record_id, tenant_id])

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                row = cursor.fetchone()
                conn.commit()
                if not row:
                    return None
                return self.get_version_by_id(version_record_id, tenant_id)
        except Exception as e:
            conn.rollback()
            raise e

    def create_forked_version(
        self,
        target_project_id: str,
        tenant_id: str,
        creator_id: Optional[str],
        version_id: str,
        description: Optional[str],
        change_log: Optional[str],
        source_revision_id: str,
        upstream_project_id: Optional[str],
        commit_author: Optional[str] = None,
        commit_message: Optional[str] = None,
        external_ref: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create a new version in target_project_id as a fork of source_revision_id (cross-project).
        Copies classes from the source revision. Sets fork lineage columns; parent_version_id stays NULL (new root in target project).
        """
        source = self.get_version_by_id(source_revision_id, tenant_id)
        if not source:
            return {"success": False, "error": "Source revision not found or not accessible"}

        src_project_id = source["project_id"]
        if src_project_id == target_project_id:
            return {
                "success": False,
                "error": "Fork requires a different target project than the source. Use “Branch from here” for named branches within the same project.",
            }

        target = self.get_project_by_id(target_project_id, tenant_id)
        if not target:
            return {"success": False, "error": "Target project not found"}

        upstream = upstream_project_id if upstream_project_id else src_project_id
        up_proj = self.get_project_by_id(upstream, tenant_id)
        if not up_proj:
            return {"success": False, "error": "Upstream project not found or not accessible"}

        effective_upstream = upstream

        insert_query = """
            INSERT INTO apiome.versions
            (project_id, creator_id, version_id, description, change_log,
             parent_version_id, forked_from_revision_id, upstream_project_id,
             commit_author, commit_message, external_ref)
            VALUES (%s, %s, %s, %s, %s, NULL, %s, %s, %s, %s, %s)
            RETURNING id
        """
        conn = self.connect()
        new_id = None
        copied_count = 0
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    insert_query,
                    (
                        target_project_id,
                        creator_id,
                        version_id,
                        description,
                        change_log,
                        source_revision_id,
                        effective_upstream,
                        commit_author,
                        commit_message,
                        external_ref,
                    ),
                )
                row = cursor.fetchone()
                new_id = row["id"] if row else None
                if not new_id:
                    conn.rollback()
                    return {"success": False, "error": "Failed to create forked version"}

                # Copy classes within the same transaction so insert + copy are atomic
                cursor.execute("""
                    INSERT INTO apiome.classes (version_id, name, description, schema, enabled, canvas_metadata)
                    SELECT %s, name, description, schema, enabled, canvas_metadata
                    FROM apiome.classes
                    WHERE version_id = %s AND deleted_at IS NULL
                    RETURNING id, name
                """, (new_id, source_revision_id))

                copied_classes = cursor.fetchall()
                copied_count = len(copied_classes)

                for copied_class in copied_classes:
                    new_class_id = copied_class["id"]
                    class_name = copied_class["name"]

                    cursor.execute("""
                        SELECT id FROM apiome.classes
                        WHERE version_id = %s AND name = %s AND deleted_at IS NULL
                    """, (source_revision_id, class_name))

                    original = cursor.fetchone()
                    if original:
                        original_class_id = original["id"]
                        cursor.execute("""
                            INSERT INTO apiome.class_properties (class_id, property_id, name, description, data, primitive_id, primitive_ref)
                            SELECT %s, property_id, name, description, data, primitive_id, primitive_ref
                            FROM apiome.class_properties
                            WHERE class_id = %s AND parent_id IS NULL
                        """, (new_class_id, original_class_id))

                conn.commit()
        except Exception as e:
            conn.rollback()
            return {"success": False, "error": str(e)}

        full = self.get_version_by_id(new_id, tenant_id)
        if not full:
            return {"success": False, "error": "Fork created but could not load version"}
        return {"success": True, "version": full, "copied_count": copied_count}

    def _validate_successor_revision_pointer(
        self,
        *,
        tenant_id: str,
        project_id: str,
        version_record_id: str,
        metadata: Dict[str, Any],
    ) -> None:
        """When a sunset is set, successor must point at another revision in the same project (#748)."""
        if not effective_sunset_string(metadata):
            return
        m = coerce_metadata(metadata)
        succ = m.get("successorRevisionId") or m.get("successor_revision_id")
        if not isinstance(succ, str) or not succ.strip():
            return
        succ_id = succ.strip()
        if succ_id == version_record_id:
            raise ValueError("successorRevisionId cannot reference the same revision")
        other = self.get_version_by_id(succ_id, tenant_id)
        if not other or str(other.get("project_id")) != project_id:
            raise ValueError("successorRevisionId must reference another revision in the same project")

    def update_version(
        self,
        version_record_id: str,
        tenant_id: str,
        updates: Dict[str, Any],
        lifecycle_admin: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Update an existing version, ensuring it belongs to the tenant."""
        existing = self.get_version_by_id(version_record_id, tenant_id)
        if not existing:
            return None

        if existing.get("published"):
            allowed_only = set(updates.keys()) <= {"revision_locked", "metadata"}
            if not allowed_only:
                raise Exception("Cannot edit a published version. Published versions are frozen.")

        update_fields = []
        params = []

        if "description" in updates:
            update_fields.append("description = %s")
            params.append(updates["description"])
        if "change_log" in updates:
            update_fields.append("change_log = %s")
            params.append(updates["change_log"])
        if "enabled" in updates and updates["enabled"] is not None:
            update_fields.append("enabled = %s")
            params.append(updates["enabled"])
        if "revision_locked" in updates:
            update_fields.append("revision_locked = %s")
            params.append(bool(updates["revision_locked"]))
        if "metadata" in updates and updates["metadata"] is not None:
            merged_meta = prepare_version_metadata_update(
                existing.get("metadata"),
                updates["metadata"],
                allow_exit_archived=lifecycle_admin,
            )
            self._validate_successor_revision_pointer(
                tenant_id=tenant_id,
                project_id=str(existing.get("project_id")),
                version_record_id=version_record_id,
                metadata=merged_meta,
            )
            update_fields.append("metadata = %s::jsonb")
            params.append(json.dumps(merged_meta))

        if not update_fields:
            return existing

        update_fields.append("updated_at = CURRENT_TIMESTAMP")

        params.append(version_record_id)
        query = f"""
            UPDATE apiome.versions
            SET {', '.join(update_fields)}
            WHERE id = %s AND deleted_at IS NULL
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                conn.commit()
                return self.get_version_by_id(version_record_id, tenant_id)
        except Exception as e:
            conn.rollback()
            raise e

    def publish_version(
        self,
        version_record_id: str,
        tenant_id: str,
        user_id: str,
        visibility: str = "private",
        description: Optional[str] = None,
        change_log: Optional[str] = None,
        published_immutable: bool = True,
    ) -> Optional[Dict[str, Any]]:
        """Publish a version (only owner or tenant admin can publish). Captures class schemas to apiome.class_schema.

        description and change_log are written in the same update as publish (validated in routes).
        """
        query = """
            UPDATE apiome.versions v
            SET published = true,
                published_at = CURRENT_TIMESTAMP,
                visibility = %s,
                description = %s,
                change_log = %s,
                published_immutable = %s,
                mock_settings = CASE
                    -- Publishing clears the private-draft 'mode' gate but preserves
                    -- every other mock knob (scenario overrides #4454 survive republish).
                    WHEN v.mock_enabled THEN COALESCE(v.mock_settings, '{}'::jsonb) - 'mode'
                    ELSE v.mock_settings
                END,
                updated_at = CURRENT_TIMESTAMP
            FROM apiome.projects p
            WHERE v.id = %s
              AND v.project_id = p.id
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
              AND (
                v.creator_id = %s
                OR EXISTS (
                  SELECT 1 FROM apiome.tenant_administrators ta
                  WHERE ta.tenant_id = p.tenant_id AND ta.user_id = %s
                )
              )
            RETURNING v.id, v.project_id, v.creator_id, v.version_id, v.description,
                      v.change_log, v.visibility, v.published, v.published_at, v.published_immutable,
                      v.mock_enabled,
                      v.enabled, v.commit_author, v.commit_message, v.external_ref,
                      v.source_commit_sha, v.source_committed_at,
                      v.created_at, v.updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (
                        visibility,
                        description,
                        change_log,
                        published_immutable,
                        version_record_id,
                        tenant_id,
                        user_id,
                        user_id,
                    ),
                )
                result = cursor.fetchone()
                if result:
                    # Capture frozen JSON Schema 2020-12 per class into class_schema
                    cursor.execute("""
                        SELECT v.version_id, p.slug AS project_slug, t.slug AS tenant_slug
                        FROM apiome.versions v
                        JOIN apiome.projects p ON v.project_id = p.id
                        JOIN apiome.tenants t ON p.tenant_id = t.id
                        WHERE v.id = %s
                    """, (version_record_id,))
                    slug_row = cursor.fetchone()
                    if slug_row:
                        classes = self.get_classes_with_properties_and_tags_for_version(version_record_id)
                        for class_data in classes:
                            schema_dict = generate_class_jsonschema_spec(
                                slug_row['tenant_slug'],
                                slug_row['project_slug'],
                                slug_row['version_id'],
                                class_data,
                                class_data.get('properties', []),
                            )
                            schema_json = json.dumps(schema_dict)
                            cursor.execute("""
                                INSERT INTO apiome.class_schema (version_id, class_id, schema, updated_at)
                                VALUES (%s, %s, %s::jsonb, CURRENT_TIMESTAMP)
                                ON CONFLICT (version_id, class_id)
                                DO UPDATE SET schema = EXCLUDED.schema, updated_at = CURRENT_TIMESTAMP
                            """, (version_record_id, class_data['id'], schema_json))
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def set_version_mock_enabled(
        self,
        version_record_id: str,
        tenant_id: str,
        user_id: str,
        *,
        enabled: bool,
        published: bool,
    ) -> Optional[Dict[str, Any]]:
        """Toggle mock_enabled on a version (creator or tenant admin only, #4422, #4446)."""
        from app.mock_settings_util import mock_settings_for_toggle

        mock_settings_json = mock_settings_for_toggle(enabled=enabled, published=published)
        query = """
            UPDATE apiome.versions v
            SET mock_enabled = %s,
                -- Merge the toggle's 'mode' fragment over the existing settings so other
                -- mock knobs (scenario overrides #4454) survive enable/disable round-trips.
                mock_settings = (COALESCE(v.mock_settings, '{}'::jsonb) - 'mode') || %s::jsonb,
                updated_at = CURRENT_TIMESTAMP
            FROM apiome.projects p
            WHERE v.id = %s
              AND v.project_id = p.id
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
              AND (
                v.creator_id = %s
                OR EXISTS (
                  SELECT 1 FROM apiome.tenant_administrators ta
                  WHERE ta.tenant_id = p.tenant_id AND ta.user_id = %s
                )
              )
            RETURNING v.id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (enabled, mock_settings_json, version_record_id, tenant_id, user_id, user_id),
                )
                updated = cursor.fetchone()
                conn.commit()
                if not updated:
                    return None
                return self.get_version_by_id(version_record_id, tenant_id)
        except Exception as e:
            conn.rollback()
            raise e

    def set_version_mock_scenarios(
        self,
        version_record_id: str,
        tenant_id: str,
        user_id: str,
        *,
        scenarios: Dict[str, Any],
        chaos: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Replace the ``scenarios`` and ``chaos`` keys of ``versions.mock_settings``.

        Only those two keys (#4454 SIM-4.2 scenarios, #4455 SIM-4.3 chaos) are
        rewritten; every other mock knob (e.g. the private-draft ``mode``) is
        preserved. An empty scenarios mapping / ``None`` chaos removes the key.
        The update bumps ``updated_at`` so the mock spec-cache NOTIFY trigger
        fires and running mocks pick up the new definitions.

        Args:
            version_record_id: The ``versions.id`` UUID.
            tenant_id: Tenant owning the version (scope check).
            user_id: Acting user; must be the version creator or a tenant admin.
            scenarios: Canonical scenario definitions keyed by name.
            chaos: Canonical version-level chaos knobs, or ``None`` to clear.

        Returns:
            The updated version row, or ``None`` when the caller lacks ownership.
        """
        replacement: Dict[str, Any] = {}
        if scenarios:
            replacement["scenarios"] = scenarios
        if chaos is not None:
            replacement["chaos"] = chaos
        fragment = json.dumps(replacement) if replacement else "{}"
        query = """
            UPDATE apiome.versions v
            SET mock_settings = (COALESCE(v.mock_settings, '{}'::jsonb) - 'scenarios' - 'chaos') || %s::jsonb,
                updated_at = CURRENT_TIMESTAMP
            FROM apiome.projects p
            WHERE v.id = %s
              AND v.project_id = p.id
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
              AND (
                v.creator_id = %s
                OR EXISTS (
                  SELECT 1 FROM apiome.tenant_administrators ta
                  WHERE ta.tenant_id = p.tenant_id AND ta.user_id = %s
                )
              )
            RETURNING v.id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (fragment, version_record_id, tenant_id, user_id, user_id),
                )
                updated = cursor.fetchone()
                conn.commit()
                if not updated:
                    return None
                return self.get_version_by_id(version_record_id, tenant_id)
        except Exception as e:
            conn.rollback()
            raise e

    def version_has_data_records(self, version_record_id: str) -> bool:
        """Return True if any data_record exists for class_schema rows belonging to this version."""
        query = """
            SELECT 1
            FROM apiome.data_record dr
            JOIN apiome.class_schema cs ON dr.class_schema_id = cs.id
            WHERE cs.version_id = %s
            LIMIT 1
        """
        results = self.execute_query(query, (version_record_id,))
        return len(results) > 0

    def version_has_class_schema(self, version_record_id: str) -> bool:
        """Return True if any class_schema row exists for this version (schema already frozen)."""
        query = """
            SELECT 1 FROM apiome.class_schema WHERE version_id = %s LIMIT 1
        """
        results = self.execute_query(query, (version_record_id,))
        return len(results) > 0

    # ------------------------- Data records & data_snapshot (embedding in REST) -------------------------

    def assert_class_schema_tenant_access(self, class_schema_id: str, tenant_id: str) -> bool:
        """Return True if class_schema_id belongs to a version in a project under the tenant."""
        query = """
            SELECT 1 FROM apiome.class_schema cs
            JOIN apiome.versions v ON v.id = cs.version_id AND v.deleted_at IS NULL
            JOIN apiome.projects p ON p.id = v.project_id AND p.tenant_id = %s AND p.deleted_at IS NULL
            WHERE cs.id = %s
        """
        results = self.execute_query(query, (tenant_id, class_schema_id))
        return len(results) > 0

    def get_class_schema_tenant_info(self, class_schema_id: str) -> Optional[Dict[str, Any]]:
        """Return class_schema row and its version's project tenant_id if it exists; None otherwise."""
        query = """
            SELECT cs.id, cs.version_id, p.tenant_id AS project_tenant_id
            FROM apiome.class_schema cs
            JOIN apiome.versions v ON v.id = cs.version_id AND v.deleted_at IS NULL
            JOIN apiome.projects p ON p.id = v.project_id AND p.deleted_at IS NULL
            WHERE cs.id = %s
        """
        results = self.execute_query(query, (class_schema_id,))
        return results[0] if results else None

    def get_class_schema_by_id(self, class_schema_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a single class_schema row by id. Returns None if not found or tenant has no access."""
        if not self.assert_class_schema_tenant_access(class_schema_id, tenant_id):
            return None
        query = """
            SELECT cs.id AS class_schema_id, cs.class_id, c.name AS class_name, cs.schema
            FROM apiome.class_schema cs
            JOIN apiome.classes c ON c.id = cs.class_id AND c.deleted_at IS NULL
            JOIN apiome.versions v ON v.id = cs.version_id AND v.deleted_at IS NULL
            JOIN apiome.projects p ON p.id = v.project_id AND p.tenant_id = %s AND p.deleted_at IS NULL
            WHERE cs.id = %s
        """
        results = self.execute_query(query, (tenant_id, class_schema_id))
        if not results:
            return None
        row = results[0]
        return {
            "class_schema_id": row["class_schema_id"],
            "class_id": row["class_id"],
            "class_name": row["class_name"],
            "schema": row["schema"] if isinstance(row["schema"], dict) else {},
        }

    def insert_data_record(
        self,
        class_schema_id: str,
        tenant_id: str,
        data: Dict[str, Any],
        created_by: Optional[str] = None,
    ) -> str:
        """
        Insert a new record: one data_record (action 'created', record_sequence 1) and one data_snapshot row.
        Returns record_id. Raises if tenant has no access to the class_schema.
        """
        if not self.assert_class_schema_tenant_access(class_schema_id, tenant_id):
            raise ValueError("Access denied to class schema")
        import uuid
        record_id = str(uuid.uuid4())
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.data_record (record_id, class_schema_id, action, record_sequence, data, tenant_id, created_by)
                    VALUES (%s, %s, 'created', 1, %s::jsonb, %s, %s)
                    """,
                    (record_id, class_schema_id, json.dumps(data), tenant_id, created_by),
                )
                cursor.execute(
                    """
                    INSERT INTO apiome.data_snapshot (record_id, class_schema_id, data, tenant_id)
                    VALUES (%s, %s, %s::jsonb, %s)
                    """,
                    (record_id, class_schema_id, json.dumps(data), tenant_id),
                )
                conn.commit()
            return record_id
        except Exception as e:
            conn.rollback()
            raise e

    def get_data_snapshot(
        self,
        record_id: str,
        class_schema_id: str,
        tenant_id: str,
    ) -> Optional[Dict[str, Any]]:
        """
        Get the current data_snapshot row for a record (data only).
        Returns None if tenant has no access or record not found (e.g. deleted).
        """
        if not self.assert_class_schema_tenant_access(class_schema_id, tenant_id):
            return None
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT data FROM apiome.data_snapshot
                    WHERE record_id = %s AND class_schema_id = %s AND tenant_id = %s
                    """,
                    (record_id, class_schema_id, tenant_id),
                )
                row = cursor.fetchone()
                if not row:
                    return None
                data = row["data"]
                return {"data": data} if data is not None else {"data": {}}
        finally:
            conn.close()

    def update_data_record(
        self,
        record_id: str,
        class_schema_id: str,
        tenant_id: str,
        data: Dict[str, Any],
        updated_by: Optional[str] = None,
    ) -> bool:
        """
        Update an existing record: compute delta vs current snapshot; if no changes, return False.
        Otherwise append data_record (action 'updated', data = delta only), update data_snapshot with full data,
        and return True. Raises if tenant has no access or record not found.
        """
        if not self.assert_class_schema_tenant_access(class_schema_id, tenant_id):
            raise ValueError("Access denied to class schema")
        snapshot = self.get_data_snapshot(record_id, class_schema_id, tenant_id)
        if not snapshot:
            raise ValueError("Record not found")
        old_data = snapshot.get("data") or {}
        if not isinstance(old_data, dict):
            old_data = {}
        delta = _compute_delta(old_data, data)
        if not delta:
            return False
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT COALESCE(MAX(record_sequence), 0) + 1 AS next_seq
                    FROM apiome.data_record WHERE record_id = %s AND class_schema_id = %s AND tenant_id = %s
                    """,
                    (record_id, class_schema_id, tenant_id),
                )
                row = cursor.fetchone()
                next_seq = row["next_seq"] if row else 1
                cursor.execute(
                    """
                    UPDATE apiome.data_snapshot
                    SET data = %s::jsonb, updated_at = CURRENT_TIMESTAMP
                    WHERE record_id = %s AND class_schema_id = %s AND tenant_id = %s
                    """,
                    (json.dumps(data), record_id, class_schema_id, tenant_id),
                )
                if cursor.rowcount == 0:
                    conn.rollback()
                    raise ValueError("Record not found")
                cursor.execute(
                    """
                    INSERT INTO apiome.data_record (record_id, class_schema_id, action, record_sequence, data, tenant_id, created_by)
                    VALUES (%s, %s, 'updated', %s, %s::jsonb, %s, %s)
                    """,
                    (record_id, class_schema_id, next_seq, json.dumps(delta), tenant_id, updated_by),
                )
                conn.commit()
            return True
        except Exception as e:
            conn.rollback()
            raise e

    def delete_data_record(
        self,
        record_id: str,
        class_schema_id: str,
        tenant_id: str,
        deleted_by: Optional[str] = None,
    ) -> None:
        """
        Delete a record: append data_record (action 'deleted') then remove data_snapshot row.
        Raises if tenant has no access or record not found.
        """
        if not self.assert_class_schema_tenant_access(class_schema_id, tenant_id):
            raise ValueError("Access denied to class schema")
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT data FROM apiome.data_snapshot
                    WHERE record_id = %s AND class_schema_id = %s AND tenant_id = %s
                    """,
                    (record_id, class_schema_id, tenant_id),
                )
                snapshot_row = cursor.fetchone()
                if not snapshot_row:
                    conn.rollback()
                    raise ValueError("Record not found")
                current_data = snapshot_row["data"]
                cursor.execute(
                    """
                    SELECT COALESCE(MAX(record_sequence), 0) + 1 AS next_seq
                    FROM apiome.data_record WHERE record_id = %s AND class_schema_id = %s AND tenant_id = %s
                    """,
                    (record_id, class_schema_id, tenant_id),
                )
                seq_row = cursor.fetchone()
                next_seq = seq_row["next_seq"] if seq_row else 1
                cursor.execute(
                    """
                    INSERT INTO apiome.data_record (record_id, class_schema_id, action, record_sequence, data, tenant_id, created_by)
                    VALUES (%s, %s, 'deleted', %s, %s::jsonb, %s, %s)
                    """,
                    (record_id, class_schema_id, next_seq, json.dumps(current_data or {}), tenant_id, deleted_by),
                )
                cursor.execute(
                    """
                    DELETE FROM apiome.data_snapshot
                    WHERE record_id = %s AND class_schema_id = %s AND tenant_id = %s
                    """,
                    (record_id, class_schema_id, tenant_id),
                )
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def restore_data_record(
        self,
        record_id: str,
        class_schema_id: str,
        tenant_id: str,
        restored_by: Optional[str] = None,
    ) -> None:
        """
        Restore a deleted record: data must have action 'deleted'. Pull data from the
        deleted data_record, insert a new data_snapshot row with that data, and append
        a data_record with action 'restored', data '{}', record_sequence incremented by 1.
        Raises if tenant has no access, record not found, or latest action is not 'deleted'.
        """
        if not self.assert_class_schema_tenant_access(class_schema_id, tenant_id):
            raise ValueError("Access denied to class schema")
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT data, record_sequence, action
                    FROM apiome.data_record
                    WHERE record_id = %s AND class_schema_id = %s AND tenant_id = %s
                    ORDER BY record_sequence DESC
                    LIMIT 1
                    """,
                    (record_id, class_schema_id, tenant_id),
                )
                row = cursor.fetchone()
                if not row:
                    conn.rollback()
                    raise ValueError("Record not found")
                if row["action"] != "deleted":
                    conn.rollback()
                    raise ValueError("Record is not deleted; only deleted records can be restored")
                data_to_restore = row["data"] or {}
                next_seq = (row["record_sequence"] or 0) + 1

                cursor.execute(
                    """
                    INSERT INTO apiome.data_record (record_id, class_schema_id, action, record_sequence, data, tenant_id, created_by)
                    VALUES (%s, %s, 'restored', %s, '{}'::jsonb, %s, %s)
                    """,
                    (record_id, class_schema_id, next_seq, tenant_id, restored_by),
                )
                cursor.execute(
                    """
                    INSERT INTO apiome.data_snapshot (record_id, class_schema_id, data, tenant_id)
                    VALUES (%s, %s, %s::jsonb, %s)
                    """,
                    (record_id, class_schema_id, json.dumps(data_to_restore), tenant_id),
                )
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def update_data_snapshot_embedding(
        self, record_id: str, embedding: List[float], model: str
    ) -> None:
        """
        Update the embedding (and metadata) for a data_snapshot row.
        No-op if embedding is empty. Logs and no-ops if pgvector type is not available.
        """
        if not embedding or len(embedding) == 0:
            return

        if not isinstance(embedding, np.ndarray):
            embedding = np.array(embedding, dtype=np.float32)

        conn = self.connect()

        try:
            from pgvector.psycopg2 import register_vector
            register_vector(conn)
        except Exception as e:
            print("pgvector not available; embedding update skipped for record_id=", record_id)
            print(f"register_vector failed: {type(e).__name__}: {e}")
            return

        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE apiome.data_snapshot
                    SET embedding = %s,
                        embedding_model = %s,
                        embedding_updated_at = CURRENT_TIMESTAMP
                    WHERE record_id = %s
                    """,
                    (embedding, model, record_id),
                )
            conn.commit()
        except Exception as e:
            conn.rollback()
            code = getattr(e, "pgcode", None) or getattr(e, "code", None)
            msg = str(getattr(e, "message", e) or e)
            if code == "42704" or ("vector" in msg.lower() and "does not exist" in msg.lower()):
                print(
                    "pgvector not available: ", msg, "code=", code, " embedding update skipped for record_id=", record_id
                )
                return
            raise

    def freeze_version_schema(
        self, version_record_id: str, tenant_id: str, user_id: str
    ) -> Optional[Dict[str, Any]]:
        """
        Capture class schemas into apiome.class_schema for this version (same as publish capture).
        Only allowed when the version has no class_schema rows yet.
        Returns version dict if successful; None if permission denied or schema already frozen.
        """
        if self.version_has_class_schema(version_record_id):
            return None
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT v.id, v.version_id, p.id AS project_id
                    FROM apiome.versions v
                    JOIN apiome.projects p ON v.project_id = p.id
                    JOIN apiome.tenants t ON p.tenant_id = t.id
                    WHERE v.id = %s AND p.tenant_id = %s AND v.deleted_at IS NULL AND p.deleted_at IS NULL
                      AND (v.creator_id = %s OR EXISTS (
                        SELECT 1 FROM apiome.tenant_administrators ta
                        WHERE ta.tenant_id = p.tenant_id AND ta.user_id = %s
                      ))
                    """,
                    (version_record_id, tenant_id, user_id, user_id),
                )
                row = cursor.fetchone()
                if not row:
                    return None
                cursor.execute(
                    """
                    SELECT v.version_id, p.slug AS project_slug, t.slug AS tenant_slug
                    FROM apiome.versions v
                    JOIN apiome.projects p ON v.project_id = p.id
                    JOIN apiome.tenants t ON p.tenant_id = t.id
                    WHERE v.id = %s
                    """,
                    (version_record_id,),
                )
                slug_row = cursor.fetchone()
                if not slug_row:
                    return None
                classes = self.get_classes_with_properties_and_tags_for_version(version_record_id)
                for class_data in classes:
                    schema_dict = generate_class_jsonschema_spec(
                        slug_row["tenant_slug"],
                        slug_row["project_slug"],
                        slug_row["version_id"],
                        class_data,
                        class_data.get("properties", []),
                    )
                    schema_json = json.dumps(schema_dict)
                    cursor.execute(
                        """
                        INSERT INTO apiome.class_schema (version_id, class_id, schema, updated_at)
                        VALUES (%s, %s, %s::jsonb, CURRENT_TIMESTAMP)
                        ON CONFLICT (version_id, class_id)
                        DO UPDATE SET schema = EXCLUDED.schema, updated_at = CURRENT_TIMESTAMP
                        """,
                        (version_record_id, class_data["id"], schema_json),
                    )
                conn.commit()
                return self.get_version_by_id(version_record_id, tenant_id)
        except Exception as e:
            conn.rollback()
            raise e

    def unpublish_version(self, version_record_id: str, tenant_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Unpublish a version (only owner or tenant admin can unpublish). Call version_has_data_records before this to block when data exists."""
        query = """
            UPDATE apiome.versions v
            SET published = false,
                published_at = NULL,
                published_immutable = false,
                updated_at = CURRENT_TIMESTAMP
            FROM apiome.projects p
            WHERE v.id = %s
              AND v.project_id = p.id
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
              AND (
                v.creator_id = %s
                OR EXISTS (
                  SELECT 1 FROM apiome.tenant_administrators ta
                  WHERE ta.tenant_id = p.tenant_id AND ta.user_id = %s
                )
              )
            RETURNING v.id, v.project_id, v.creator_id, v.version_id, v.description,
                      v.change_log, v.visibility, v.published, v.published_at, v.published_immutable,
                      v.enabled, v.commit_author, v.commit_message, v.external_ref,
                      v.source_commit_sha, v.source_committed_at,
                      v.created_at, v.updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (version_record_id, tenant_id, user_id, user_id))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def is_user_tenant_admin(self, tenant_id: str, user_id: str) -> bool:
        """True if user is a tenant administrator."""
        q = """
            SELECT 1 FROM apiome.tenant_administrators
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid LIMIT 1
        """
        return bool(self.execute_query(q, (tenant_id, user_id)))

    # ------------------------------------------------------------------
    # Granular RBAC (#3611): roles, permissions, members, access audit
    # ------------------------------------------------------------------

    def user_has_permission(
        self, tenant_id: str, user_id: str, resource: str, action: str
    ) -> bool:
        """
        Central authorization predicate used by the permission guard.

        A tenant administrator (Owner-equivalent / legacy ``tenant_administrators``) is allowed
        everything; otherwise the user's assigned role — or the built-in Editor default for a member
        with no explicit role — must grant ``resource:action``.
        """
        if self.is_user_tenant_admin(tenant_id, user_id):
            return True
        return f"{resource}:{action}" in self.get_effective_permissions(
            tenant_id, user_id
        )

    def _modify(self, query: str, params: tuple = None) -> int:
        """Execute a write that returns no rows (UPDATE/DELETE/INSERT-without-RETURNING).

        Commits on success and returns the affected row count, mirroring ``execute_query``'s
        connection hygiene (a committed write leaves the shared connection IDLE).
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                affected = cursor.rowcount
            conn.commit()
            return affected
        except Exception:
            conn.rollback()
            raise

    def is_platform_admin(self, user_id: Optional[str]) -> bool:
        """True when the user is a platform administrator (the plane separate from tenant admin)."""
        if not user_id:
            return False
        return bool(
            self.execute_query(
                "SELECT 1 FROM apiome.platform_administrators WHERE user_id = %s::uuid LIMIT 1",
                (user_id,),
            )
        )

    def ensure_builtin_roles(self, tenant_id: str) -> None:
        """Idempotently seed the four built-in roles + grids for a tenant (safe to call on every read)."""
        self.execute_query("SELECT apiome.seed_builtin_roles(%s::uuid)", (tenant_id,))

    def get_effective_permissions(self, tenant_id: str, user_id: str) -> Set[str]:
        """
        Resolve a member's granted ``resource:action`` permissions from their assigned role.

        A member with no explicit role assignment inherits the built-in **Editor** grid (any member
        could create/edit content before RBAC). A suspended member has no permissions. Tenant
        administrators are handled upstream by the guard's full-access plane and never reach here.
        """
        rows = self.execute_query(
            """
            SELECT rp.resource, rp.action
            FROM apiome.tenant_user_roles tur
            JOIN apiome.role_permissions rp ON rp.role_id = tur.role_id
            WHERE tur.tenant_id = %s::uuid AND tur.user_id = %s::uuid
            """,
            (tenant_id, user_id),
        )
        if rows:
            return {f"{r['resource']}:{r['action']}" for r in rows}

        member = self.execute_query(
            """
            SELECT 1 FROM apiome.tenant_users
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid AND status <> 'suspended'
            LIMIT 1
            """,
            (tenant_id, user_id),
        )
        if not member:
            return set()

        editor_rows = self.execute_query(
            """
            SELECT rp.resource, rp.action
            FROM apiome.roles r
            JOIN apiome.role_permissions rp ON rp.role_id = r.id
            WHERE r.tenant_id = %s::uuid AND r.slug = 'editor'
            """,
            (tenant_id,),
        )
        return {f"{r['resource']}:{r['action']}" for r in editor_rows}

    def write_access_audit(
        self,
        *,
        tenant_id: Optional[str],
        action: str,
        actor_id: Optional[str] = None,
        actor_label: Optional[str] = None,
        target: Optional[str] = None,
        source: str = "web",
        detail: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append a hash-chained row to ``apiome.access_audit`` (best-effort; callers swallow failures)."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT entry_hash FROM apiome.access_audit
                    WHERE tenant_id IS NOT DISTINCT FROM %s::uuid
                    ORDER BY created_at DESC, id DESC LIMIT 1
                    """,
                    (tenant_id,),
                )
                prev_row = cursor.fetchone()
                prev_hash = prev_row["entry_hash"] if prev_row else None
                detail_json = (
                    json.dumps(detail, sort_keys=True, default=str)
                    if detail is not None
                    else None
                )
                payload = "|".join(
                    [
                        prev_hash or "",
                        str(tenant_id or ""),
                        str(actor_id or actor_label or ""),
                        action,
                        str(target or ""),
                        detail_json or "",
                    ]
                )
                entry_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
                cursor.execute(
                    """
                    INSERT INTO apiome.access_audit
                        (tenant_id, actor_id, actor_label, action, target, source, detail, prev_hash, entry_hash)
                    VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s::jsonb, %s, %s)
                    """,
                    (
                        tenant_id,
                        actor_id,
                        actor_label,
                        action,
                        target,
                        source,
                        detail_json,
                        prev_hash,
                        entry_hash,
                    ),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def list_access_audit(
        self, tenant_id: str, *, action_prefix: Optional[str] = None, limit: int = 200
    ) -> List[Dict[str, Any]]:
        """Return access-audit rows for a tenant, newest first, optionally filtered by action prefix."""
        params: list = [tenant_id]
        where = "tenant_id = %s::uuid"
        if action_prefix:
            where += " AND action LIKE %s"
            params.append(f"{action_prefix}%")
        params.append(max(1, min(int(limit), 1000)))
        return self.execute_query(
            f"""
            SELECT id::text, actor_id::text, actor_label, action, target, source,
                   detail, created_at
            FROM apiome.access_audit
            WHERE {where}
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            tuple(params),
        )

    # ---- Auth events (sign-in / sign-up / link audit ledger, OLO-1.6, #4191) -----

    def write_auth_event(
        self,
        *,
        event_type: str,
        outcome: str,
        provider: Optional[str] = None,
        user_id: Optional[str] = None,
        user_label: Optional[str] = None,
        error_code: Optional[str] = None,
        ip_hash: Optional[str] = None,
        user_agent_hash: Optional[str] = None,
        detail: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append a hash-chained row to ``apiome.auth_events`` (best-effort — logs and swallows).

        Records one authentication outcome (see :mod:`app.auth_events`). Best-effort by design: a
        failed audit write can never fail or block the sign-in it records, so DB errors are logged
        and swallowed rather than raised. Unlike :meth:`write_access_audit` the chain is global
        (auth happens before any tenant context), so ``prev_hash`` links to the newest row in the
        whole table.

        Args:
            event_type: One of ``app.auth_events.AUTH_EVENT_TYPES`` (sign_in/sign_up/link/unlink).
            outcome: ``success`` or ``failure`` (matches the ``auth_events_outcome_check`` constraint).
            provider: OAuth provider slug, or None when unknown.
            user_id: Resolved user id, or None for failures / pre-account sign-ups.
            user_label: Canonical email retained independent of the users row.
            error_code: Stable auth error code on failure.
            ip_hash: Salted SHA-256 of the client IP — never the raw address.
            user_agent_hash: Salted SHA-256 of the client User-Agent — never the raw header.
            detail: Structured JSON context (e.g. ``{"auto_linked": True}``).
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT entry_hash FROM apiome.auth_events
                    ORDER BY created_at DESC, id DESC LIMIT 1
                    """
                )
                prev_row = cursor.fetchone()
                prev_hash = prev_row["entry_hash"] if prev_row else None
                detail_json = (
                    json.dumps(detail, sort_keys=True, default=str)
                    if detail is not None
                    else None
                )
                payload = "|".join(
                    [
                        prev_hash or "",
                        event_type,
                        outcome,
                        provider or "",
                        str(user_id or ""),
                        user_label or "",
                        error_code or "",
                        ip_hash or "",
                        user_agent_hash or "",
                        detail_json or "",
                    ]
                )
                entry_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
                cursor.execute(
                    """
                    INSERT INTO apiome.auth_events
                        (event_type, user_id, user_label, provider, outcome, error_code,
                         ip_hash, user_agent_hash, detail, prev_hash, entry_hash)
                    VALUES (%s, %s::uuid, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                    """,
                    (
                        event_type,
                        user_id,
                        user_label,
                        provider,
                        outcome,
                        error_code,
                        ip_hash,
                        user_agent_hash,
                        detail_json,
                        prev_hash,
                        entry_hash,
                    ),
                )
            conn.commit()
        except Exception as e:
            conn.rollback()
            _logger.warning("write_auth_event failed: %s", e)

    def log_auth_event(
        self,
        event: "AuthEvent",
        *,
        ip_hash: Optional[str] = None,
        user_agent_hash: Optional[str] = None,
    ) -> None:
        """Persist an :class:`app.auth_events.AuthEvent` (from ``event_from_decision``).

        Thin adapter over :meth:`write_auth_event` so callers can map a 1.3 resolution outcome to an
        event once and hand it straight to the ledger, attaching the request's hashed IP / UA.

        Args:
            event: The event to record.
            ip_hash: Salted SHA-256 of the client IP for this request, when available.
            user_agent_hash: Salted SHA-256 of the client User-Agent for this request, when available.
        """
        self.write_auth_event(
            event_type=event.event_type,
            outcome=event.outcome,
            provider=event.provider,
            user_id=event.user_id,
            user_label=event.user_label,
            error_code=event.error_code,
            ip_hash=ip_hash,
            user_agent_hash=user_agent_hash,
            detail=dict(event.detail) if event.detail else None,
        )

    def list_auth_events_for_user(
        self, user_id: str, *, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Return a user's authentication events, newest first (the login-history read path).

        Feeds the Profile login-history surface (#1607/#534/#2418). Only rows still attributed to
        the user are returned; failed sign-ins with no resolved user are intentionally excluded.

        Args:
            user_id: The user to fetch history for.
            limit: Max rows (clamped to 1..1000).

        Returns:
            Auth-event rows (id, event_type, provider, outcome, error_code, ip_hash,
            user_agent_hash, detail, created_at), newest first.
        """
        return self.execute_query(
            """
            SELECT id::text, event_type, provider, outcome, error_code,
                   ip_hash, user_agent_hash, detail, created_at
            FROM apiome.auth_events
            WHERE user_id = %s::uuid
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            (user_id, max(1, min(int(limit), 1000))),
        )

    def prune_auth_events(self, *, retention_days: int) -> int:
        """Delete auth events older than ``retention_days`` (tail retention); return rows removed.

        Retention prunes only the oldest rows, so the retained suffix of the hash chain stays
        contiguous and independently verifiable. See ``apiome-rest/docs/AUTH_EVENTS.md``.

        Args:
            retention_days: Age threshold in days; rows strictly older are deleted. Must be >= 1.

        Returns:
            The number of rows deleted.
        """
        days = max(1, int(retention_days))
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    DELETE FROM apiome.auth_events
                    WHERE created_at < CURRENT_TIMESTAMP - make_interval(days => %s)
                    """,
                    (days,),
                )
                deleted = cursor.rowcount
            conn.commit()
            return deleted
        except Exception as e:
            conn.rollback()
            _logger.warning("prune_auth_events failed: %s", e)
            return 0

    # ---- Roles -------------------------------------------------------

    def list_roles(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List a tenant's roles with their assigned-member counts (built-in first, then by name)."""
        return self.execute_query(
            """
            SELECT r.id::text, r.slug, r.name, r.description, r.is_builtin,
                   r.created_at, r.updated_at,
                   (SELECT COUNT(*) FROM apiome.tenant_user_roles tur WHERE tur.role_id = r.id) AS member_count
            FROM apiome.roles r
            WHERE r.tenant_id = %s::uuid
            ORDER BY r.is_builtin DESC,
                     CASE r.slug WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                                 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END,
                     r.name ASC
            """,
            (tenant_id,),
        )

    def get_role(self, tenant_id: str, role_id: str) -> Optional[Dict[str, Any]]:
        """Fetch one role scoped to a tenant, or None."""
        rows = self.execute_query(
            """
            SELECT id::text, slug, name, description, is_builtin, created_at, updated_at
            FROM apiome.roles WHERE id = %s::uuid AND tenant_id = %s::uuid
            """,
            (role_id, tenant_id),
        )
        return rows[0] if rows else None

    def get_role_permissions(self, role_id: str) -> List[Dict[str, str]]:
        """Return the allowed ``resource``/``action`` pairs for a role."""
        return self.execute_query(
            "SELECT resource, action FROM apiome.role_permissions WHERE role_id = %s::uuid",
            (role_id,),
        )

    def create_role(
        self, tenant_id: str, slug: str, name: str, description: Optional[str]
    ) -> Dict[str, Any]:
        """Create a custom (non-built-in) role and return it."""
        rows = self.execute_query(
            """
            INSERT INTO apiome.roles (tenant_id, slug, name, description, is_builtin)
            VALUES (%s::uuid, %s, %s, %s, false)
            RETURNING id::text, slug, name, description, is_builtin, created_at, updated_at
            """,
            (tenant_id, slug, name, description),
        )
        return rows[0]

    def update_role(
        self, tenant_id: str, role_id: str, name: str, description: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        """Update a role's name/description (built-in or custom). Returns the updated row or None."""
        rows = self.execute_query(
            """
            UPDATE apiome.roles SET name = %s, description = %s
            WHERE id = %s::uuid AND tenant_id = %s::uuid
            RETURNING id::text, slug, name, description, is_builtin, created_at, updated_at
            """,
            (name, description, role_id, tenant_id),
        )
        return rows[0] if rows else None

    def set_role_permissions(self, role_id: str, pairs: List[Tuple[str, str]]) -> None:
        """Replace a role's permission grid with the given ``(resource, action)`` pairs."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM apiome.role_permissions WHERE role_id = %s::uuid", (role_id,)
                )
                for resource, action in pairs:
                    cursor.execute(
                        """
                        INSERT INTO apiome.role_permissions (role_id, resource, action)
                        VALUES (%s::uuid, %s, %s)
                        ON CONFLICT (role_id, resource, action) DO NOTHING
                        """,
                        (role_id, resource, action),
                    )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def delete_role(self, tenant_id: str, role_id: str) -> int:
        """Delete a custom role (assignments cascade). Returns rows deleted."""
        return self._modify(
            "DELETE FROM apiome.roles WHERE id = %s::uuid AND tenant_id = %s::uuid AND is_builtin = false",
            (role_id, tenant_id),
        )

    # ---- Members -----------------------------------------------------

    def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        """Resolve an active user by email (for member invites).

        The lookup is case-insensitive: the input is canonicalized and compared against the
        normalized stored address so any casing of a known address resolves to its one account.
        """
        rows = self.execute_query(
            """
            SELECT id::text, name, email FROM apiome.users
            WHERE lower(email) = %s AND deleted_at IS NULL
            LIMIT 1
            """,
            (normalize_email(email),),
        )
        return rows[0] if rows else None

    def list_members(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List tenant members with their role, lifecycle status, and admin flag."""
        return self.execute_query(
            """
            SELECT u.id::text AS user_id, u.name, u.email,
                   tu.status,
                   tu.updated_at AS member_since,
                   r.id::text AS role_id, r.name AS role_name, r.slug AS role_slug,
                   EXISTS (
                       SELECT 1 FROM apiome.tenant_administrators ta
                       WHERE ta.tenant_id = tu.tenant_id AND ta.user_id = u.id
                   ) AS is_admin
            FROM apiome.tenant_users tu
            JOIN apiome.users u ON u.id = tu.user_id
            LEFT JOIN apiome.tenant_user_roles tur
                   ON tur.tenant_id = tu.tenant_id AND tur.user_id = tu.user_id
            LEFT JOIN apiome.roles r ON r.id = tur.role_id
            WHERE tu.tenant_id = %s::uuid AND u.deleted_at IS NULL
            ORDER BY u.name ASC
            """,
            (tenant_id,),
        )

    def get_tenant_license_seats(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Return the ``seats`` JSON of the tenant's attached license (OLO-5.3, #4213).

        Reads the one-active-license-per-tenant attachment (``apiome.tenant_licenses``,
        V182) joined to the V097 catalog. Every tenant should hold a license since the
        V183 auto-issue trigger + backfill.

        :param tenant_id: Canonical UUID string of the tenant.
        :returns: The license ``seats`` dict (e.g. ``{"max_tenants": 1,
            "max_users_per_tenant": 5}``), or ``None`` when the tenant has no
            license row or the stored value is not a JSON object — callers fall
            back to the Free defaults.
        """
        rows = self.execute_query(
            """
            SELECT l.seats
            FROM apiome.tenant_licenses tl
            JOIN apiome.licenses l ON l.id = tl.license_id
            WHERE tl.tenant_id = %s::uuid
            """,
            (tenant_id,),
        )
        seats = rows[0].get("seats") if rows else None
        return seats if isinstance(seats, dict) else None

    def count_member_seats_in_use(self, tenant_id: str) -> int:
        """Count the tenant members currently occupying license seats (OLO-5.3, #4213).

        A seat is occupied by every membership row whose lifecycle status is not
        ``suspended`` (so ``active`` and ``pending`` both count — an outstanding
        invite reserves its seat) and whose user account is not soft-deleted
        (``users.deleted_at``). Suspended members (V121) deliberately do **not**
        count, so suspending frees a seat and reinstating consumes one again.

        :param tenant_id: Canonical UUID string of the tenant.
        :returns: The number of seats in use (0 when the tenant has no members).
        """
        rows = self.execute_query(
            """
            SELECT COUNT(*)::int AS c
            FROM apiome.tenant_users tu
            JOIN apiome.users u ON u.id = tu.user_id
            WHERE tu.tenant_id = %s::uuid
              AND tu.status <> 'suspended'
              AND u.deleted_at IS NULL
            """,
            (tenant_id,),
        )
        return int(rows[0]["c"]) if rows and rows[0].get("c") is not None else 0

    def get_member_status(self, tenant_id: str, user_id: str) -> Optional[str]:
        """Return a member's lifecycle status (``active``/``pending``/``suspended``).

        :param tenant_id: Canonical UUID string of the tenant.
        :param user_id: The member's user id.
        :returns: The membership status string, or ``None`` when the user has no
            membership row in the tenant.
        """
        rows = self.execute_query(
            "SELECT status FROM apiome.tenant_users WHERE tenant_id = %s::uuid AND user_id = %s::uuid",
            (tenant_id, user_id),
        )
        return str(rows[0]["status"]) if rows and rows[0].get("status") is not None else None

    def add_member(self, tenant_id: str, user_id: str, status: str = "active") -> None:
        """Add (or reactivate) a tenant membership with the given lifecycle status."""
        self._modify(
            """
            INSERT INTO apiome.tenant_users (tenant_id, user_id, status)
            VALUES (%s::uuid, %s::uuid, %s)
            ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = EXCLUDED.status
            """,
            (tenant_id, user_id, status),
        )

    def set_member_status(self, tenant_id: str, user_id: str, status: str) -> int:
        """Set a member's lifecycle status (active/pending/suspended). Returns rows updated."""
        return self._modify(
            "UPDATE apiome.tenant_users SET status = %s WHERE tenant_id = %s::uuid AND user_id = %s::uuid",
            (status, tenant_id, user_id),
        )

    def activate_pending_membership(self, tenant_id: str, user_id: str) -> str:
        """Activate a user's *pending* membership in a tenant (OLO-4.4, #4208).

        Status-aware per V121: only a ``pending`` row transitions to
        ``active``. An already-active membership is a no-op, and a
        ``suspended`` membership is deliberately never reactivated here —
        unsuspending is an admin action (``set_member_status``), not a
        side effect of the member logging in.

        :param tenant_id: Tenant whose membership should be activated.
        :param user_id: The member's user id.
        :returns: One of ``'activated'`` (pending row became active),
            ``'already-active'`` (nothing to do), ``'suspended'`` (row exists
            but was left untouched), or ``'none'`` (no membership row).
        """
        updated = self._modify(
            """
            UPDATE apiome.tenant_users SET status = 'active', updated_at = NOW()
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid AND status = 'pending'
            """,
            (tenant_id, user_id),
        )
        if updated:
            return "activated"
        rows = self.execute_query(
            "SELECT status FROM apiome.tenant_users WHERE tenant_id = %s::uuid AND user_id = %s::uuid",
            (tenant_id, user_id),
        )
        if not rows:
            return "none"
        status = str(rows[0].get("status") or "active")
        return "already-active" if status == "active" else status

    def assign_member_role(self, tenant_id: str, user_id: str, role_id: str) -> None:
        """Assign (replacing any existing) a role to a tenant member."""
        self._modify(
            """
            INSERT INTO apiome.tenant_user_roles (tenant_id, user_id, role_id)
            VALUES (%s::uuid, %s::uuid, %s::uuid)
            ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id
            """,
            (tenant_id, user_id, role_id),
        )

    def remove_member(self, tenant_id: str, user_id: str) -> int:
        """Offboard a member: drop membership, role assignment, and any tenant-admin row."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM apiome.tenant_user_roles WHERE tenant_id = %s::uuid AND user_id = %s::uuid",
                    (tenant_id, user_id),
                )
                cursor.execute(
                    "DELETE FROM apiome.tenant_administrators WHERE tenant_id = %s::uuid AND user_id = %s::uuid",
                    (tenant_id, user_id),
                )
                cursor.execute(
                    "DELETE FROM apiome.tenant_users WHERE tenant_id = %s::uuid AND user_id = %s::uuid",
                    (tenant_id, user_id),
                )
                affected = cursor.rowcount
            conn.commit()
            return affected
        except Exception:
            conn.rollback()
            raise

    def tenant_has_feature_flag(
        self,
        tenant_id: Optional[str],
        user_id: Optional[str],
        flag_name: str,
    ) -> bool:
        """Resolve whether a tenant/user is entitled to a named feature flag (#3478).

        Effective entitlement layers, highest precedence first:

        1. Per-user override (``apiome.user_feature_flags.enabled``) — an admin explicitly
           granting or revoking the flag for this user.
        2. Per-tenant override (``apiome.tenant_feature_flags.enabled``) — all members of the
           tenant inherit this unless a user override exists.
        3. License default (``apiome.license_feature_flags`` via ``user_entitlements.license_id``)
           — the flag is bundled into the user's assigned plan.

        The flag's global master switch (``apiome.feature_flags.enabled``) is honored: a missing
        or globally-disabled flag is never entitled, regardless of overrides. ``user_id`` may be
        ``None`` (e.g. a legacy API key without an attributed user), in which case only the
        tenant-level override is consulted.

        Args:
            tenant_id: The acting tenant's id (``None`` skips the tenant-override lookup).
            user_id: The acting user's id (``None`` skips user-override and license lookups).
            flag_name: The feature flag slug, e.g. ``"primitives-registry"``.

        Returns:
            True when the flag is globally enabled and the resolved entitlement grants it.
        """
        row = self.execute_query(
            """
            WITH ff AS (
                SELECT id, enabled FROM apiome.feature_flags WHERE name = %s
            )
            SELECT
                ff.enabled                          AS flag_enabled,
                uff.enabled                         AS user_override,
                tff.enabled                         AS tenant_override,
                (lff.feature_flag_id IS NOT NULL)   AS license_grant
            FROM ff
            LEFT JOIN apiome.user_feature_flags uff
                   ON uff.feature_flag_id = ff.id AND uff.user_id = %s::uuid
            LEFT JOIN apiome.tenant_feature_flags tff
                   ON tff.feature_flag_id = ff.id AND tff.tenant_id = %s::uuid
            LEFT JOIN apiome.user_entitlements ue
                   ON ue.user_id = %s::uuid
            LEFT JOIN apiome.license_feature_flags lff
                   ON lff.feature_flag_id = ff.id AND lff.license_id = ue.license_id
            LIMIT 1
            """,
            (flag_name, user_id, tenant_id, user_id),
        )
        if not row:
            # Flag is not defined in the registry — treat as not entitled.
            return False

        record = row[0]
        if not record["flag_enabled"]:
            # Globally disabled master switch — off for everyone.
            return False

        if record["user_override"] is not None:
            return bool(record["user_override"])
        if record["tenant_override"] is not None:
            return bool(record["tenant_override"])
        return bool(record["license_grant"])

    def get_tenant_license_info(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Return the tenant's attached license plan for the REST surface (OLO-5.4, #4214).

        Reads the one-active-license-per-tenant attachment (``apiome.tenant_licenses``,
        V182) joined to the V097 catalog, one level up from
        ``get_tenant_license_seats`` (which returns only the ``seats`` JSON for the
        enforcement path).

        :param tenant_id: Canonical UUID string of the tenant.
        :returns: A dict with ``name`` (plan display name), ``license_type``
            (``free``/``paid``/``sponsor``), ``seats`` (the capacity JSON), and
            ``issued_at``, or ``None`` when the tenant has no license row (a
            tenant predating the V183 backfill) — callers fall back to the Free
            defaults, mirroring ``license_capacity.member_seat_limit``.
        """
        rows = self.execute_query(
            """
            SELECT l.name, l.license_type, l.seats, tl.issued_at
            FROM apiome.tenant_licenses tl
            JOIN apiome.licenses l ON l.id = tl.license_id
            WHERE tl.tenant_id = %s::uuid
            """,
            (tenant_id,),
        )
        return rows[0] if rows else None

    def list_tenant_effective_features(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List the feature flags composing a tenant's effective entitlement (OLO-5.4, #4214).

        Returns the union of the tenant license's bundled flags
        (``apiome.license_feature_flags`` via the V182 ``tenant_licenses``
        attachment) and the tenant's explicit overrides
        (``apiome.tenant_feature_flags``), per the V097 composition. Per-user
        overrides are deliberately excluded — this is the *tenant's* license
        surface, not any one member's view (``tenant_has_feature_flag`` resolves
        the per-user answer).

        Each row carries the raw layers; the caller composes the effective state
        (override beats license default, a disabled master switch beats both):

        * ``name`` / ``label`` / ``description`` / ``is_preview`` — flag metadata.
        * ``flag_enabled`` — the flag's global master switch
          (``feature_flags.enabled``).
        * ``license_grant`` — True when the tenant's license bundles the flag.
        * ``tenant_override`` — the tenant-level override (True granted, False
          revoked), or ``None`` when no override row exists.

        :param tenant_id: Canonical UUID string of the tenant.
        :returns: One dict per flag in the union, ordered by flag name. Empty
            when the tenant has no license row and no overrides.
        """
        return self.execute_query(
            """
            SELECT
                ff.name,
                ff.label,
                ff.description,
                ff.is_preview,
                ff.enabled                        AS flag_enabled,
                (lff.feature_flag_id IS NOT NULL) AS license_grant,
                tff.enabled                       AS tenant_override
            FROM apiome.feature_flags ff
            LEFT JOIN apiome.tenant_licenses tl
                   ON tl.tenant_id = %s::uuid
            LEFT JOIN apiome.license_feature_flags lff
                   ON lff.feature_flag_id = ff.id AND lff.license_id = tl.license_id
            LEFT JOIN apiome.tenant_feature_flags tff
                   ON tff.feature_flag_id = ff.id AND tff.tenant_id = %s::uuid
            WHERE lff.feature_flag_id IS NOT NULL OR tff.feature_flag_id IS NOT NULL
            ORDER BY ff.name ASC
            """,
            (tenant_id, tenant_id),
        )

    def get_active_tenant_auth_row(self, tenant_slug: str) -> Optional[Dict[str, Any]]:
        """Resolve a non-deleted tenant slug to id/slug/name for auth checks."""
        query = """
            SELECT id::text AS tenant_id, slug AS tenant_slug, name AS tenant_name
            FROM apiome.tenants
            WHERE slug = %s AND deleted_at IS NULL
            LIMIT 1
        """
        rows = self.execute_query(query, (tenant_slug,))
        return rows[0] if rows else None

    def get_active_tenant_auth_row_by_id(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Resolve a non-deleted tenant id to id/slug/name for auth checks.

        The by-slug sibling above serves routes that carry ``{tenant_slug}`` in their path.
        Routes that deliberately do not — ``/v1/slate/*`` reads tenancy from the JWT, so the
        browser is never handed a slug it has no reason to know — need the same row starting
        from the ``current_tenant_id`` claim instead.

        Args:
            tenant_id: Tenant UUID, as carried by the JWT's ``current_tenant_id`` claim.

        Returns:
            The tenant's id, slug and name, or ``None`` when no active tenant has that id.
        """
        query = """
            SELECT id::text AS tenant_id, slug AS tenant_slug, name AS tenant_name
            FROM apiome.tenants
            WHERE id = %s::uuid AND deleted_at IS NULL
            LIMIT 1
        """
        try:
            rows = self.execute_query(query, (tenant_id,))
        except Exception:
            # A malformed claim is a failed lookup, not a 500. The caller turns this into the
            # same 401 an absent claim produces, so a forged id leaks nothing about which
            # tenants exist.
            return None
        return rows[0] if rows else None

    def user_has_tenant_access(self, user_id: str, tenant_id: str) -> bool:
        """
        True when the user is a tenant member or tenant administrator.

        Administrators must be able to call tenant-scoped REST routes even if a legacy
        row is missing from ``tenant_users`` (UI treats ``tenant_administrators`` as authoritative).
        """
        member_q = """
            SELECT 1
            FROM apiome.tenant_users
            WHERE user_id = %s::uuid AND tenant_id = %s::uuid
              AND status <> 'suspended'
            LIMIT 1
        """
        if self.execute_query(member_q, (user_id, tenant_id)):
            return True
        admin_q = """
            SELECT 1
            FROM apiome.tenant_administrators
            WHERE user_id = %s::uuid AND tenant_id = %s::uuid
            LIMIT 1
        """
        return bool(self.execute_query(admin_q, (user_id, tenant_id)))

    def insert_version_protection_audit(
        self,
        tenant_id: str,
        project_id: Optional[str],
        actor_id: Optional[str],
        action: str,
        resource_type: str,
        resource_id: str,
        outcome: str,
        detail: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Best-effort audit row for protection policy and overrides (#504)."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.version_protection_audit
                      (tenant_id, project_id, actor_id, action, resource_type, resource_id, outcome, detail)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        tenant_id,
                        project_id,
                        actor_id,
                        action,
                        resource_type,
                        resource_id,
                        outcome,
                        json.dumps(detail) if detail is not None else None,
                    ),
                )
                conn.commit()
        except Exception as e:
            conn.rollback()
            _logger.warning("insert_version_protection_audit failed: %s", e)

    def insert_workflow_audit(
        self,
        tenant_id: str,
        project_id: Optional[str],
        version_id: Optional[str],
        action: str,
        outcome: str,
        actor_id: Optional[str],
        detail: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append-only workflow audit row (#2577). Best-effort: logs and swallows DB errors."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.workflow_audit
                      (tenant_id, project_id, version_id, action, outcome, actor_id, detail)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        tenant_id,
                        project_id,
                        version_id,
                        action,
                        outcome,
                        actor_id,
                        json.dumps(detail) if detail is not None else None,
                    ),
                )
                conn.commit()
        except Exception as e:
            conn.rollback()
            _logger.warning("insert_workflow_audit failed: %s", e)

    def list_workflow_audit_for_version(
        self,
        version_id: str,
        tenant_id: str,
        since=None,
        until=None,
        limit: int = 500,
    ) -> List[Dict[str, Any]]:
        """Rows for one revision, tenant-scoped, optional created_at range (for queries / tests)."""
        clauses = [
            "wa.version_id = %s",
            "wa.tenant_id = %s",
        ]
        params: List[Any] = [version_id, tenant_id]
        if since is not None:
            clauses.append("wa.created_at >= %s")
            params.append(since)
        if until is not None:
            clauses.append("wa.created_at <= %s")
            params.append(until)
        q = f"""
            SELECT wa.id, wa.tenant_id, wa.project_id, wa.version_id, wa.action, wa.outcome,
                   wa.actor_id, wa.detail, wa.created_at
            FROM apiome.workflow_audit wa
            WHERE {' AND '.join(clauses)}
            ORDER BY wa.created_at ASC, wa.id ASC
            LIMIT %s
        """
        params.append(limit)
        return self.execute_query(q, tuple(params))

    def _workflow_audit_filter_clauses(
        self,
        tenant_id: str,
        *,
        project_id: Optional[str] = None,
        actions: Optional[List[str]] = None,
        actor_id: Optional[str] = None,
        outcome: Optional[str] = None,
        version_id: Optional[str] = None,
        since=None,
        until=None,
        cursor_created_at=None,
        cursor_id: Optional[str] = None,
    ) -> Tuple[str, List[Any]]:
        """Build WHERE fragment and params for tenant-scoped workflow_audit queries (#2578)."""
        clauses = ["wa.tenant_id = %s"]
        params: List[Any] = [tenant_id]
        if project_id is not None:
            clauses.append("wa.project_id = %s")
            params.append(project_id)
        if actions:
            placeholders = ",".join(["%s"] * len(actions))
            clauses.append(f"wa.action IN ({placeholders})")
            params.extend(actions)
        if actor_id is not None:
            clauses.append("wa.actor_id = %s")
            params.append(actor_id)
        if outcome is not None:
            clauses.append("wa.outcome = %s")
            params.append(outcome)
        if version_id is not None:
            clauses.append("wa.version_id = %s")
            params.append(version_id)
        if since is not None:
            clauses.append("wa.created_at >= %s")
            params.append(since)
        if until is not None:
            clauses.append("wa.created_at <= %s")
            params.append(until)
        if cursor_created_at is not None and cursor_id is not None:
            clauses.append("(wa.created_at, wa.id) < (%s, %s::uuid)")
            params.extend([cursor_created_at, cursor_id])
        where_sql = " AND ".join(clauses)
        return where_sql, params

    def count_workflow_audit_filtered(
        self,
        tenant_id: str,
        *,
        project_id: Optional[str] = None,
        actions: Optional[List[str]] = None,
        actor_id: Optional[str] = None,
        outcome: Optional[str] = None,
        version_id: Optional[str] = None,
        since=None,
        until=None,
    ) -> int:
        """Count rows matching filters (no cursor)."""
        where_sql, params = self._workflow_audit_filter_clauses(
            tenant_id,
            project_id=project_id,
            actions=actions,
            actor_id=actor_id,
            outcome=outcome,
            version_id=version_id,
            since=since,
            until=until,
            cursor_created_at=None,
            cursor_id=None,
        )
        q = f"SELECT COUNT(*)::bigint AS cnt FROM apiome.workflow_audit wa WHERE {where_sql}"
        rows = self.execute_query(q, tuple(params))
        if not rows:
            return 0
        return int(rows[0].get("cnt") or 0)

    def search_workflow_audit(
        self,
        tenant_id: str,
        *,
        project_id: Optional[str] = None,
        actions: Optional[List[str]] = None,
        actor_id: Optional[str] = None,
        outcome: Optional[str] = None,
        version_id: Optional[str] = None,
        since=None,
        until=None,
        limit: int = 50,
        offset: int = 0,
        cursor_created_at=None,
        cursor_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Paginated workflow_audit rows, newest first (created_at DESC, id DESC).
        Use either (offset) or (cursor_created_at + cursor_id), not both.
        """
        where_sql, params = self._workflow_audit_filter_clauses(
            tenant_id,
            project_id=project_id,
            actions=actions,
            actor_id=actor_id,
            outcome=outcome,
            version_id=version_id,
            since=since,
            until=until,
            cursor_created_at=cursor_created_at,
            cursor_id=cursor_id,
        )
        use_cursor = cursor_created_at is not None and cursor_id is not None
        q = f"""
            SELECT wa.id, wa.tenant_id, wa.project_id, wa.version_id, wa.action, wa.outcome,
                   wa.actor_id, wa.detail, wa.created_at
            FROM apiome.workflow_audit wa
            WHERE {where_sql}
            ORDER BY wa.created_at DESC, wa.id DESC
            LIMIT %s
        """
        params.append(limit)
        if not use_cursor:
            q += " OFFSET %s"
            params.append(offset)
        return self.execute_query(q, tuple(params))

    def insert_registry_audit(
        self,
        tenant_id: str,
        action: str,
        outcome: str,
        *,
        primitive_id: Optional[str] = None,
        schema_id: Optional[str] = None,
        namespace: Optional[str] = None,
        actor_id: Optional[str] = None,
        detail: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append-only type-registry audit row (#3481).

        Best-effort: logs and swallows DB errors so a failed audit write can never fail the
        governed registry action (create/update/delete/import) it records.

        Args:
            tenant_id: Owning tenant (required).
            action: Registry verb, e.g. ``primitive.create``.
            outcome: ``success`` or ``failure``.
            primitive_id: Affected primitive id, when one exists.
            schema_id: Derived ``$id`` of the affected type, for traceability.
            namespace: Registry namespace path of the affected type, when applicable.
            actor_id: User who performed the action (None for unattributable API-key calls).
            detail: Structured JSON context (changed fields, import counts, error info).
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.registry_audit
                      (tenant_id, primitive_id, schema_id, namespace, action, outcome,
                       actor_id, detail)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        tenant_id,
                        primitive_id,
                        schema_id,
                        namespace,
                        action,
                        outcome,
                        actor_id,
                        json.dumps(detail) if detail is not None else None,
                    ),
                )
                conn.commit()
        except Exception as e:
            conn.rollback()
            _logger.warning("insert_registry_audit failed: %s", e)

    def _registry_audit_filter_clauses(
        self,
        tenant_id: str,
        *,
        primitive_id: Optional[str] = None,
        actions: Optional[List[str]] = None,
        actor_id: Optional[str] = None,
        outcome: Optional[str] = None,
        schema_id: Optional[str] = None,
        since=None,
        until=None,
        cursor_created_at=None,
        cursor_id: Optional[str] = None,
    ) -> Tuple[str, List[Any]]:
        """Build WHERE fragment and params for tenant-scoped registry_audit queries (#3481)."""
        clauses = ["ra.tenant_id = %s"]
        params: List[Any] = [tenant_id]
        if primitive_id is not None:
            clauses.append("ra.primitive_id = %s")
            params.append(primitive_id)
        if actions:
            placeholders = ",".join(["%s"] * len(actions))
            clauses.append(f"ra.action IN ({placeholders})")
            params.extend(actions)
        if actor_id is not None:
            clauses.append("ra.actor_id = %s")
            params.append(actor_id)
        if outcome is not None:
            clauses.append("ra.outcome = %s")
            params.append(outcome)
        if schema_id is not None:
            clauses.append("ra.schema_id = %s")
            params.append(schema_id)
        if since is not None:
            clauses.append("ra.created_at >= %s")
            params.append(since)
        if until is not None:
            clauses.append("ra.created_at <= %s")
            params.append(until)
        if cursor_created_at is not None and cursor_id is not None:
            clauses.append("(ra.created_at, ra.id) < (%s, %s::uuid)")
            params.extend([cursor_created_at, cursor_id])
        where_sql = " AND ".join(clauses)
        return where_sql, params

    def count_registry_audit_filtered(
        self,
        tenant_id: str,
        *,
        primitive_id: Optional[str] = None,
        actions: Optional[List[str]] = None,
        actor_id: Optional[str] = None,
        outcome: Optional[str] = None,
        schema_id: Optional[str] = None,
        since=None,
        until=None,
    ) -> int:
        """Count registry_audit rows matching filters (no cursor)."""
        where_sql, params = self._registry_audit_filter_clauses(
            tenant_id,
            primitive_id=primitive_id,
            actions=actions,
            actor_id=actor_id,
            outcome=outcome,
            schema_id=schema_id,
            since=since,
            until=until,
            cursor_created_at=None,
            cursor_id=None,
        )
        q = f"SELECT COUNT(*)::bigint AS cnt FROM apiome.registry_audit ra WHERE {where_sql}"
        rows = self.execute_query(q, tuple(params))
        if not rows:
            return 0
        return int(rows[0].get("cnt") or 0)

    def search_registry_audit(
        self,
        tenant_id: str,
        *,
        primitive_id: Optional[str] = None,
        actions: Optional[List[str]] = None,
        actor_id: Optional[str] = None,
        outcome: Optional[str] = None,
        schema_id: Optional[str] = None,
        since=None,
        until=None,
        limit: int = 50,
        offset: int = 0,
        cursor_created_at=None,
        cursor_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Paginated registry_audit rows, newest first (created_at DESC, id DESC).
        Use either (offset) or (cursor_created_at + cursor_id), not both.
        """
        where_sql, params = self._registry_audit_filter_clauses(
            tenant_id,
            primitive_id=primitive_id,
            actions=actions,
            actor_id=actor_id,
            outcome=outcome,
            schema_id=schema_id,
            since=since,
            until=until,
            cursor_created_at=cursor_created_at,
            cursor_id=cursor_id,
        )
        use_cursor = cursor_created_at is not None and cursor_id is not None
        q = f"""
            SELECT ra.id, ra.tenant_id, ra.primitive_id, ra.schema_id, ra.namespace,
                   ra.action, ra.outcome, ra.actor_id, ra.detail, ra.created_at
            FROM apiome.registry_audit ra
            WHERE {where_sql}
            ORDER BY ra.created_at DESC, ra.id DESC
            LIMIT %s
        """
        params.append(limit)
        if not use_cursor:
            q += " OFFSET %s"
            params.append(offset)
        return self.execute_query(q, tuple(params))

    def _refresh_audit_filter_clauses(
        self,
        tenant_id: str,
        *,
        repository_id: Optional[str] = None,
        branch: Optional[str] = None,
        path: Optional[str] = None,
        trigger: Optional[str] = None,
        outcome: Optional[str] = None,
        since=None,
        until=None,
    ) -> Tuple[str, List[Any]]:
        """Build WHERE fragment + params for refresh-cycle history queries (RAR-5.3).

        Filters the shared ``apiome.workflow_audit`` ledger down to the dedicated
        refresh-cycle action and, when supplied, the per-repo / per-file lineage and
        the refresh facets carried in the ``detail`` JSONB (see
        :mod:`repository_refresh_audit`). ``repository_id`` + ``path`` make the
        history queryable per repo and per file.
        """
        from .repository_refresh_audit import REFRESH_CYCLE_ACTION

        clauses = ["wa.tenant_id = %s", "wa.action = %s"]
        params: List[Any] = [tenant_id, REFRESH_CYCLE_ACTION]
        if repository_id is not None:
            clauses.append("wa.detail->>'repositoryId' = %s")
            params.append(str(repository_id))
        if branch is not None:
            clauses.append("wa.detail->>'branch' = %s")
            params.append(str(branch))
        if path is not None:
            clauses.append("wa.detail->>'path' = %s")
            params.append(str(path))
        if trigger is not None:
            clauses.append("wa.detail->>'trigger' = %s")
            params.append(str(trigger))
        if outcome is not None:
            clauses.append("wa.detail->>'outcome' = %s")
            params.append(str(outcome))
        if since is not None:
            clauses.append("wa.created_at >= %s")
            params.append(since)
        if until is not None:
            clauses.append("wa.created_at <= %s")
            params.append(until)
        return " AND ".join(clauses), params

    def count_repository_refresh_audit(
        self,
        tenant_id: str,
        *,
        repository_id: Optional[str] = None,
        branch: Optional[str] = None,
        path: Optional[str] = None,
        trigger: Optional[str] = None,
        outcome: Optional[str] = None,
        since=None,
        until=None,
    ) -> int:
        """Count refresh-cycle audit rows matching the filters (RAR-5.3)."""
        where_sql, params = self._refresh_audit_filter_clauses(
            tenant_id,
            repository_id=repository_id,
            branch=branch,
            path=path,
            trigger=trigger,
            outcome=outcome,
            since=since,
            until=until,
        )
        q = f"SELECT COUNT(*)::bigint AS cnt FROM apiome.workflow_audit wa WHERE {where_sql}"
        rows = self.execute_query(q, tuple(params))
        if not rows:
            return 0
        return int(rows[0].get("cnt") or 0)

    def search_repository_refresh_audit(
        self,
        tenant_id: str,
        *,
        repository_id: Optional[str] = None,
        branch: Optional[str] = None,
        path: Optional[str] = None,
        trigger: Optional[str] = None,
        outcome: Optional[str] = None,
        since=None,
        until=None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Paginated refresh-cycle history, newest first (RAR-5.3).

        Returns ``apiome.workflow_audit`` rows stamped with the refresh-cycle action,
        scoped to the tenant and optionally to a repository / branch / file path and
        the refresh facets. ``repository_id`` makes the history queryable per repo;
        adding ``path`` makes it queryable per file.
        """
        where_sql, params = self._refresh_audit_filter_clauses(
            tenant_id,
            repository_id=repository_id,
            branch=branch,
            path=path,
            trigger=trigger,
            outcome=outcome,
            since=since,
            until=until,
        )
        q = f"""
            SELECT wa.id, wa.tenant_id, wa.project_id, wa.version_id, wa.action,
                   wa.outcome, wa.actor_id, wa.detail, wa.created_at
            FROM apiome.workflow_audit wa
            WHERE {where_sql}
            ORDER BY wa.created_at DESC, wa.id DESC
            LIMIT %s OFFSET %s
        """
        params.append(limit)
        params.append(offset)
        return self.execute_query(q, tuple(params))

    def delete_version(
        self, version_record_id: str, tenant_id: str, user_id: Optional[str]
    ) -> Tuple[bool, Optional[str]]:
        """
        Soft delete a version. Returns (True, None) on success, or (False, error_code).
        error_code: not_found | forbidden | revision_locked
        """
        existing = self.get_version_by_id(version_record_id, tenant_id)
        if not existing:
            return False, "not_found"

        rev_locked = bool(existing.get("revision_locked"))
        creator_id = existing.get("creator_id")
        project_id = existing.get("project_id")

        if user_id is None:
            if rev_locked:
                self.insert_version_protection_audit(
                    tenant_id,
                    project_id,
                    None,
                    "version.delete",
                    "version",
                    version_record_id,
                    "denied",
                    {"reason": "revision_locked_no_user_context"},
                )
                return False, "revision_locked"
        else:
            is_admin = self.is_user_tenant_admin(tenant_id, user_id)
            if creator_id != user_id and not is_admin:
                self.insert_version_protection_audit(
                    tenant_id,
                    project_id,
                    user_id,
                    "version.delete",
                    "version",
                    version_record_id,
                    "denied",
                    {"reason": "not_owner_or_admin"},
                )
                return False, "forbidden"
            if rev_locked and not is_admin:
                self.insert_version_protection_audit(
                    tenant_id,
                    project_id,
                    user_id,
                    "version.delete",
                    "version",
                    version_record_id,
                    "denied",
                    {"reason": "revision_locked"},
                )
                return False, "revision_locked"

        query = """
            UPDATE apiome.versions v
            SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            FROM apiome.projects p
            WHERE v.id = %s
              AND v.project_id = p.id
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (version_record_id, tenant_id))
                ok = cursor.rowcount > 0
                conn.commit()
                if ok and rev_locked and user_id and self.is_user_tenant_admin(tenant_id, user_id):
                    self.insert_version_protection_audit(
                        tenant_id,
                        project_id,
                        user_id,
                        "version.delete",
                        "version",
                        version_record_id,
                        "allowed",
                        {"reason": "admin_override_locked_revision"},
                    )
                return (True, None) if ok else (False, "not_found")
        except Exception as e:
            conn.rollback()
            raise e

    def copy_classes_from_version(self, source_version_id: str, target_version_id: str) -> Dict[str, Any]:
        """Copy all classes from source version to target version."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                # Copy classes
                cursor.execute("""
                    INSERT INTO apiome.classes (version_id, name, description, schema, enabled, canvas_metadata)
                    SELECT %s, name, description, schema, enabled, canvas_metadata
                    FROM apiome.classes
                    WHERE version_id = %s AND deleted_at IS NULL
                    RETURNING id, name
                """, (target_version_id, source_version_id))

                copied_classes = cursor.fetchall()
                copied_count = len(copied_classes)

                # For each copied class, copy its properties
                for copied_class in copied_classes:
                    new_class_id = copied_class['id']
                    class_name = copied_class['name']

                    # Find original class ID
                    cursor.execute("""
                        SELECT id FROM apiome.classes
                        WHERE version_id = %s AND name = %s AND deleted_at IS NULL
                    """, (source_version_id, class_name))

                    original = cursor.fetchone()
                    if original:
                        original_class_id = original['id']

                        # Copy class properties (simple copy without nested property mapping for now)
                        cursor.execute("""
                            INSERT INTO apiome.class_properties (class_id, property_id, name, description, data, primitive_id, primitive_ref)
                            SELECT %s, property_id, name, description, data, primitive_id, primitive_ref
                            FROM apiome.class_properties
                            WHERE class_id = %s AND parent_id IS NULL
                        """, (new_class_id, original_class_id))

                conn.commit()
                return {"success": True, "copied_count": copied_count}
        except Exception as e:
            conn.rollback()
            return {"success": False, "error": str(e)}

    # ==================== Project Properties Methods ====================

    def get_properties_for_project(self, project_id: str) -> List[Dict[str, Any]]:
        """Get all properties for a project."""
        query = """
            SELECT id, project_id, name, description, data, enabled, created_at, updated_at
            FROM apiome.properties
            WHERE project_id = %s AND deleted_at IS NULL
            ORDER BY name ASC
        """
        return self.execute_query(query, (project_id,))

    def get_property_by_id(self, property_id: str, project_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific property by ID, ensuring it belongs to the project."""
        query = """
            SELECT id, project_id, name, description, data, enabled, created_at, updated_at
            FROM apiome.properties
            WHERE id = %s AND project_id = %s AND deleted_at IS NULL
        """
        results = self.execute_query(query, (property_id, project_id))
        return results[0] if results else None

    def create_property(self, project_id: str, name: str, description: Optional[str], data: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new property for a project."""
        query = """
            INSERT INTO apiome.properties (project_id, name, description, data)
            VALUES (%s, %s, %s, %s)
            RETURNING id, project_id, name, description, data, enabled, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (project_id, name.strip(), description, json.dumps(data) if isinstance(data, dict) else data))
                result = cursor.fetchone()
                conn.commit()
                # Parse JSON data if it's a string
                if result and isinstance(result.get('data'), str):
                    result['data'] = json.loads(result['data'])
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_property(self, property_id: str, project_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update a property, ensuring it belongs to the project."""
        # Build dynamic update query
        set_clauses = []
        params = []

        if 'name' in updates:
            set_clauses.append("name = %s")
            params.append(updates['name'].strip() if updates['name'] else None)
        if 'description' in updates:
            set_clauses.append("description = %s")
            params.append(updates['description'])
        if 'data' in updates:
            set_clauses.append("data = %s")
            data_value = updates['data']
            params.append(json.dumps(data_value) if isinstance(data_value, dict) else data_value)
        if 'enabled' in updates:
            set_clauses.append("enabled = %s")
            params.append(updates['enabled'])

        if not set_clauses:
            # No updates provided
            return self.get_property_by_id(property_id, project_id)

        set_clauses.append("updated_at = CURRENT_TIMESTAMP")

        query = f"""
            UPDATE apiome.properties
            SET {', '.join(set_clauses)}
            WHERE id = %s AND project_id = %s AND deleted_at IS NULL
            RETURNING id, project_id, name, description, data, enabled, created_at, updated_at
        """
        params.extend([property_id, project_id])

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                result = cursor.fetchone()
                conn.commit()
                if result and isinstance(result.get('data'), str):
                    result['data'] = json.loads(result['data'])
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_property(self, property_id: str, project_id: str) -> bool:
        """Soft delete a property, ensuring it belongs to the project."""
        query = """
            UPDATE apiome.properties
            SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s AND project_id = %s AND deleted_at IS NULL
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (property_id, project_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Path CRUD Operations ====================

    def get_path_by_id(self, path_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific path by ID, ensuring it belongs to the tenant."""
        query = """
            SELECT vp.id, vp.version_id, vp.pathname, vp.metadata,
                   vp.created_at, vp.updated_at
            FROM apiome.version_path vp
            JOIN apiome.versions v ON vp.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE vp.id = %s AND p.tenant_id = %s
        """
        results = self.execute_query(query, (path_id, tenant_id))
        return results[0] if results else None

    def get_paths_for_version_with_tenant(self, version_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        """Get all paths for a version, ensuring it belongs to the tenant."""
        query = """
            SELECT vp.id, vp.version_id, vp.pathname, vp.metadata,
                   vp.metadata->>'summary' as summary,
                   vp.metadata->>'description' as description,
                   vp.created_at, vp.updated_at
            FROM apiome.version_path vp
            JOIN apiome.versions v ON vp.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE vp.version_id = %s AND p.tenant_id = %s
            ORDER BY vp.pathname
        """
        return self.execute_query(query, (version_id, tenant_id))

    def create_path(
        self,
        version_id: str,
        pathname: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Create a new path for a version."""
        query = """
            INSERT INTO apiome.version_path (version_id, pathname, metadata)
            VALUES (%s, %s, %s)
            RETURNING id, version_id, pathname, metadata, created_at, updated_at
        """
        metadata_json = json.dumps(metadata) if metadata else '{}'

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (version_id, pathname, metadata_json))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_path(
        self,
        path_id: str,
        tenant_id: str,
        updates: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update a path, ensuring it belongs to the tenant."""
        # Verify path belongs to tenant
        existing = self.get_path_by_id(path_id, tenant_id)
        if not existing:
            return None

        update_fields = []
        params = []

        if 'pathname' in updates and updates['pathname'] is not None:
            update_fields.append("pathname = %s")
            params.append(updates['pathname'])
        if 'metadata' in updates:
            update_fields.append("metadata = %s")
            params.append(json.dumps(updates['metadata']) if updates['metadata'] else '{}')

        if not update_fields:
            return existing

        update_fields.append("updated_at = CURRENT_TIMESTAMP")
        params.append(path_id)

        query = f"""
            UPDATE apiome.version_path
            SET {', '.join(update_fields)}
            WHERE id = %s
            RETURNING id, version_id, pathname, metadata, created_at, updated_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_path(self, path_id: str, tenant_id: str) -> bool:
        """Delete a path, ensuring it belongs to the tenant."""
        # Verify path belongs to tenant
        existing = self.get_path_by_id(path_id, tenant_id)
        if not existing:
            return False

        query = "DELETE FROM apiome.version_path WHERE id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (path_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def get_path_canvas(self, version_id: str, path_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """
        Load Paths React Flow canvas JSON for a version_path row (tenant-scoped).
        Returns None if the path is missing or not under the given version.
        """
        path = self.get_path_by_id(path_id, tenant_id)
        if not path or str(path["version_id"]) != str(version_id):
            return None

        query = """
            SELECT canvas, updated_at
            FROM apiome.version_path_canvas
            WHERE version_path_id = %s
        """
        rows = self.execute_query(query, (path_id,))
        default_canvas = {
            "nodes": [],
            "edges": [],
            "viewport": {"x": 0, "y": 0, "zoom": 1},
        }
        if not rows:
            return {
                **default_canvas,
                "updated_at": None,
            }

        row = rows[0]
        canvas = row["canvas"]
        if isinstance(canvas, str):
            canvas = json.loads(canvas)
        if not isinstance(canvas, dict):
            canvas = default_canvas
        nodes = canvas.get("nodes")
        edges = canvas.get("edges")
        viewport = canvas.get("viewport")
        if not isinstance(nodes, list):
            nodes = []
        if not isinstance(edges, list):
            edges = []
        if not isinstance(viewport, dict):
            viewport = {"x": 0, "y": 0, "zoom": 1}

        return {
            "nodes": nodes,
            "edges": edges,
            "viewport": {
                "x": float(viewport.get("x", 0)),
                "y": float(viewport.get("y", 0)),
                "zoom": float(viewport.get("zoom", 1)),
            },
            "updated_at": row.get("updated_at"),
        }

    def upsert_path_canvas(
        self,
        version_id: str,
        path_id: str,
        tenant_id: str,
        canvas: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """
        Insert or update Paths canvas JSON (last-write-wins). Returns None if path/version/tenant mismatch.
        """
        path = self.get_path_by_id(path_id, tenant_id)
        if not path or str(path["version_id"]) != str(version_id):
            return None

        payload = {
            "nodes": canvas.get("nodes") if isinstance(canvas.get("nodes"), list) else [],
            "edges": canvas.get("edges") if isinstance(canvas.get("edges"), list) else [],
            "viewport": canvas.get("viewport")
            if isinstance(canvas.get("viewport"), dict)
            else {"x": 0, "y": 0, "zoom": 1},
        }
        vp = payload["viewport"]
        try:
            payload["viewport"] = {
                "x": float(vp.get("x", 0)),
                "y": float(vp.get("y", 0)),
                "zoom": float(vp.get("zoom", 1)),
            }
        except (TypeError, ValueError):
            payload["viewport"] = {"x": 0, "y": 0, "zoom": 1}

        query = """
            INSERT INTO apiome.version_path_canvas (version_path_id, canvas, updated_at)
            VALUES (%s, %s::jsonb, CURRENT_TIMESTAMP)
            ON CONFLICT (version_path_id) DO UPDATE SET
                canvas = EXCLUDED.canvas,
                updated_at = CURRENT_TIMESTAMP
            RETURNING canvas, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (path_id, Json(payload)))
                result = cursor.fetchone()
                conn.commit()
                if not result:
                    return None
                out_canvas = result["canvas"]
                if isinstance(out_canvas, str):
                    out_canvas = json.loads(out_canvas)
                return {
                    "nodes": out_canvas.get("nodes", []),
                    "edges": out_canvas.get("edges", []),
                    "viewport": out_canvas.get("viewport", {"x": 0, "y": 0, "zoom": 1}),
                    "updated_at": result.get("updated_at"),
                }
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Path Operation CRUD ====================

    def get_operation_by_id(self, operation_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific operation by ID, ensuring it belongs to the tenant."""
        query = """
            SELECT po.id, po.version_path_id, po.operation, po.metadata,
                   po.created_at, po.updated_at
            FROM apiome.path_operation po
            JOIN apiome.version_path vp ON po.version_path_id = vp.id
            JOIN apiome.versions v ON vp.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE po.id = %s AND p.tenant_id = %s
        """
        results = self.execute_query(query, (operation_id, tenant_id))
        return results[0] if results else None

    def create_operation(
        self,
        version_path_id: str,
        operation: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Create a new operation for a path."""
        query = """
            INSERT INTO apiome.path_operation (version_path_id, operation, metadata)
            VALUES (%s, %s, %s)
            RETURNING id, version_path_id, operation, metadata, created_at, updated_at
        """
        metadata_json = json.dumps(metadata) if metadata else '{}'

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (version_path_id, operation.upper(), metadata_json))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_operation(
        self,
        operation_id: str,
        tenant_id: str,
        updates: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Update an operation, ensuring it belongs to the tenant."""
        existing = self.get_operation_by_id(operation_id, tenant_id)
        if not existing:
            return None

        update_fields = []
        params = []

        if 'operation' in updates and updates['operation'] is not None:
            update_fields.append("operation = %s")
            params.append(updates['operation'].upper())
        if 'metadata' in updates:
            update_fields.append("metadata = %s")
            params.append(json.dumps(updates['metadata']) if updates['metadata'] else '{}')

        if not update_fields:
            return existing

        update_fields.append("updated_at = CURRENT_TIMESTAMP")
        params.append(operation_id)

        query = f"""
            UPDATE apiome.path_operation
            SET {', '.join(update_fields)}
            WHERE id = %s
            RETURNING id, version_path_id, operation, metadata, created_at, updated_at
        """

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, tuple(params))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_operation(self, operation_id: str, tenant_id: str) -> bool:
        """Delete an operation, ensuring it belongs to the tenant."""
        existing = self.get_operation_by_id(operation_id, tenant_id)
        if not existing:
            return False

        query = "DELETE FROM apiome.path_operation WHERE id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (operation_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Operation Description CRUD ====================

    def create_operation_description(
        self,
        path_operation_id: str,
        summary: Optional[str] = None,
        description: Optional[str] = None,
        operation_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Create or update operation description."""
        # Check if description already exists
        existing_query = "SELECT id FROM apiome.path_operation_description WHERE path_operation_id = %s"
        results = self.execute_query(existing_query, (path_operation_id,))

        metadata_json = json.dumps(metadata) if metadata else '{}'

        if results:
            # Update existing
            query = """
                UPDATE apiome.path_operation_description
                SET summary = %s, description = %s, operation_id = %s, metadata = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE path_operation_id = %s
                RETURNING id, path_operation_id, summary, description, operation_id, metadata,
                          created_at, updated_at
            """
            conn = self.connect()
            try:
                with conn.cursor() as cursor:
                    cursor.execute(query, (summary, description, operation_id, metadata_json, path_operation_id))
                    result = cursor.fetchone()
                    conn.commit()
                    return result
            except Exception as e:
                conn.rollback()
                raise e
        else:
            # Create new
            query = """
                INSERT INTO apiome.path_operation_description
                (path_operation_id, summary, description, operation_id, metadata)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id, path_operation_id, summary, description, operation_id, metadata,
                          created_at, updated_at
            """
            conn = self.connect()
            try:
                with conn.cursor() as cursor:
                    cursor.execute(query, (path_operation_id, summary, description, operation_id, metadata_json))
                    result = cursor.fetchone()
                    conn.commit()
                    return result
            except Exception as e:
                conn.rollback()
                raise e

    # ==================== Shared Path Parameter CRUD ====================

    def get_shared_parameters_for_path(self, version_path_id: str) -> List[Dict[str, Any]]:
        """Get all shared parameters for a path."""
        query = """
            SELECT id, version_path_id, name, in_location, summary, description, data,
                   created_at, updated_at
            FROM apiome.shared_path_parameter
            WHERE version_path_id = %s
            ORDER BY in_location, name
        """
        return self.execute_query(query, (version_path_id,))

    def create_shared_parameter(
        self,
        version_path_id: str,
        name: str,
        in_location: str,
        summary: Optional[str] = None,
        description: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Create a shared parameter for a path."""
        query = """
            INSERT INTO apiome.shared_path_parameter
            (version_path_id, name, in_location, summary, description, data)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, version_path_id, name, in_location, summary, description, data,
                      created_at, updated_at
        """
        data_json = json.dumps(data) if data else '{}'

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (version_path_id, name, in_location, summary, description, data_json))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def link_parameter_to_operation(self, path_operation_id: str, shared_path_parameter_id: str) -> Dict[str, Any]:
        """Link a shared parameter to an operation."""
        query = """
            INSERT INTO apiome.path_operation_parameter_link (path_operation_id, shared_path_parameter_id)
            VALUES (%s, %s)
            ON CONFLICT (path_operation_id, shared_path_parameter_id) DO NOTHING
            RETURNING id, path_operation_id, shared_path_parameter_id, created_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (path_operation_id, shared_path_parameter_id))
                result = cursor.fetchone()
                conn.commit()
                if result is None:
                    # Already existed, fetch it
                    cursor.execute(
                        """SELECT id, path_operation_id, shared_path_parameter_id, created_at
                           FROM apiome.path_operation_parameter_link
                           WHERE path_operation_id = %s AND shared_path_parameter_id = %s""",
                        (path_operation_id, shared_path_parameter_id)
                    )
                    result = cursor.fetchone()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def unlink_parameter_from_operation(self, path_operation_id: str, shared_path_parameter_id: str) -> bool:
        """Unlink a shared parameter from an operation."""
        query = """
            DELETE FROM apiome.path_operation_parameter_link
            WHERE path_operation_id = %s AND shared_path_parameter_id = %s
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (path_operation_id, shared_path_parameter_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def delete_shared_parameter(self, parameter_id: str, tenant_id: str) -> bool:
        """Delete a shared parameter, ensuring it belongs to the tenant."""
        verify_query = """
            SELECT spp.id FROM apiome.shared_path_parameter spp
            JOIN apiome.version_path vp ON spp.version_path_id = vp.id
            JOIN apiome.versions v ON vp.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE spp.id = %s AND p.tenant_id = %s
        """
        results = self.execute_query(verify_query, (parameter_id, tenant_id))
        if not results:
            return False

        query = "DELETE FROM apiome.shared_path_parameter WHERE id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (parameter_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Shared Request Body CRUD ====================

    def get_shared_request_bodies_for_path(self, version_path_id: str) -> List[Dict[str, Any]]:
        """Get all shared request bodies for a path."""
        query = """
            SELECT id, version_path_id, name, description, required,
                   created_at, updated_at
            FROM apiome.shared_path_request_body
            WHERE version_path_id = %s
            ORDER BY name
        """
        return self.execute_query(query, (version_path_id,))

    def create_shared_request_body(
        self,
        version_path_id: str,
        name: str,
        description: Optional[str] = None,
        required: bool = True
    ) -> Dict[str, Any]:
        """Create a shared request body for a path."""
        query = """
            INSERT INTO apiome.shared_path_request_body
            (version_path_id, name, description, required)
            VALUES (%s, %s, %s, %s)
            RETURNING id, version_path_id, name, description, required, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (version_path_id, name, description, required))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def link_request_body_to_operation(self, path_operation_id: str, shared_request_body_id: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Link a shared request body to an operation."""
        metadata_json = json.dumps(metadata) if metadata else None
        query = """
            INSERT INTO apiome.path_operation_request_body_link (path_operation_id, shared_path_request_body_id, metadata)
            VALUES (%s, %s, %s)
            ON CONFLICT (path_operation_id) DO UPDATE SET
                shared_path_request_body_id = EXCLUDED.shared_path_request_body_id,
                metadata = EXCLUDED.metadata,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, path_operation_id, shared_path_request_body_id, metadata, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (path_operation_id, shared_request_body_id, metadata_json))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def unlink_request_body_from_operation(self, path_operation_id: str) -> bool:
        """Unlink request body from an operation."""
        query = "DELETE FROM apiome.path_operation_request_body_link WHERE path_operation_id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (path_operation_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def add_request_body_content_type(
        self,
        shared_request_body_id: str,
        media_type: str,
        class_id: Optional[str] = None,
        inline_schema: Optional[Dict[str, Any]] = None,
        encoding: Optional[Dict[str, Any]] = None,
        examples: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """Add a content type to a request body."""
        query = """
            INSERT INTO apiome.shared_path_request_body_content
            (shared_path_request_body_id, media_type, class_id, inline_schema, encoding, examples)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (shared_path_request_body_id, media_type) DO UPDATE SET
                class_id = EXCLUDED.class_id,
                inline_schema = EXCLUDED.inline_schema,
                encoding = EXCLUDED.encoding,
                examples = EXCLUDED.examples,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, shared_path_request_body_id, media_type, class_id, inline_schema,
                      encoding, examples, created_at, updated_at
        """
        inline_schema_json = json.dumps(inline_schema) if inline_schema else None
        encoding_json = json.dumps(encoding) if encoding else None
        examples_json = json.dumps(examples) if examples else None

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (shared_request_body_id, media_type, class_id,
                                       inline_schema_json, encoding_json, examples_json))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_shared_request_body(self, request_body_id: str, tenant_id: str) -> bool:
        """Delete a shared request body, ensuring it belongs to the tenant."""
        verify_query = """
            SELECT rb.id FROM apiome.shared_path_request_body rb
            JOIN apiome.version_path vp ON rb.version_path_id = vp.id
            JOIN apiome.versions v ON vp.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE rb.id = %s AND p.tenant_id = %s
        """
        results = self.execute_query(verify_query, (request_body_id, tenant_id))
        if not results:
            return False

        query = "DELETE FROM apiome.shared_path_request_body WHERE id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (request_body_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Shared Response CRUD ====================

    def get_shared_responses_for_path(self, version_path_id: str) -> List[Dict[str, Any]]:
        """Get all shared responses for a path."""
        query = """
            SELECT id, version_path_id, status_code, description, data, class_id, inline_schema,
                   schema_mode, created_at, updated_at
            FROM apiome.shared_path_response
            WHERE version_path_id = %s
            ORDER BY status_code
        """
        return self.execute_query(query, (version_path_id,))

    def create_shared_response(
        self,
        version_path_id: str,
        status_code: str,
        description: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        class_id: Optional[str] = None,
        inline_schema: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Create a shared response for a path."""
        query = """
            INSERT INTO apiome.shared_path_response
            (version_path_id, status_code, description, data, class_id, inline_schema)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, version_path_id, status_code, description, data, class_id, inline_schema,
                      created_at, updated_at
        """
        data_json = json.dumps(data) if data else None
        inline_schema_json = json.dumps(inline_schema) if inline_schema else None

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (version_path_id, status_code, description,
                                       data_json, class_id, inline_schema_json))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def link_response_to_operation(self, path_operation_id: str, shared_response_id: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Link a shared response to an operation."""
        metadata_json = json.dumps(metadata) if metadata else None
        query = """
            INSERT INTO apiome.path_operation_response_link (path_operation_id, shared_path_response_id, metadata)
            VALUES (%s, %s, %s)
            ON CONFLICT (path_operation_id, shared_path_response_id) DO UPDATE SET
                metadata = EXCLUDED.metadata,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, path_operation_id, shared_path_response_id, metadata, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (path_operation_id, shared_response_id, metadata_json))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def unlink_response_from_operation(self, path_operation_id: str, shared_response_id: str) -> bool:
        """Unlink a shared response from an operation."""
        query = """
            DELETE FROM apiome.path_operation_response_link
            WHERE path_operation_id = %s AND shared_path_response_id = %s
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (path_operation_id, shared_response_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def add_response_content_type(
        self,
        shared_response_id: str,
        media_type: str,
        class_id: Optional[str] = None,
        inline_schema: Optional[Dict[str, Any]] = None,
        examples: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """Add a content type to a response."""
        query = """
            INSERT INTO apiome.shared_path_response_content
            (shared_path_response_id, media_type, class_id, inline_schema, examples)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (shared_path_response_id, media_type) DO UPDATE SET
                class_id = EXCLUDED.class_id,
                inline_schema = EXCLUDED.inline_schema,
                examples = EXCLUDED.examples,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, shared_path_response_id, media_type, class_id, inline_schema,
                      examples, created_at, updated_at
        """
        inline_schema_json = json.dumps(inline_schema) if inline_schema else None
        examples_json = json.dumps(examples) if examples else None

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (shared_response_id, media_type, class_id,
                                       inline_schema_json, examples_json))
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def delete_shared_response(self, response_id: str, tenant_id: str) -> bool:
        """Delete a shared response, ensuring it belongs to the tenant."""
        verify_query = """
            SELECT sr.id FROM apiome.shared_path_response sr
            JOIN apiome.version_path vp ON sr.version_path_id = vp.id
            JOIN apiome.versions v ON vp.version_id = v.id
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE sr.id = %s AND p.tenant_id = %s
        """
        results = self.execute_query(verify_query, (response_id, tenant_id))
        if not results:
            return False

        query = "DELETE FROM apiome.shared_path_response WHERE id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (response_id,))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def copy_class_properties_to_inline_schema(self, class_id: str) -> Dict[str, Any]:
        """Copy class properties to create an inline schema structure."""
        # Get class properties
        properties = self.get_properties_for_class(class_id)

        # Build inline schema structure
        inline_properties = []
        for prop in properties:
            prop_data = prop.get('data', {})
            if isinstance(prop_data, str):
                prop_data = json.loads(prop_data)

            inline_prop = {
                'id': str(prop['id']),
                'name': prop['name'],
                'description': prop.get('description'),
                'data': prop_data,
                'parent_id': str(prop['parent_id']) if prop.get('parent_id') else None
            }
            inline_properties.append(inline_prop)

        return {
            'type': 'object',
            'properties': inline_properties
        }

    def get_migration_plan_rules(
        self,
        project_id: str,
        from_version_id: str,
        to_version_id: str,
        class_name: str,
        tenant_id: str
    ) -> Dict[str, Any]:
        """
        Get migration plan rules for a (project, from_version, to_version, class_name).
        Only returns rules for plans whose project belongs to the tenant.
        Returns dict keyed by 'migration-edge-prop-{source_property}' with rule payloads.
        """
        query = """
            SELECT mpr.source_property, mpr.rule
            FROM apiome.migration_plan_rules mpr
            JOIN apiome.migration_plans mp ON mp.id = mpr.migration_plan_id
            JOIN apiome.projects p ON p.id = mp.project_id AND p.tenant_id = %s AND p.deleted_at IS NULL
            WHERE mp.project_id = %s AND mp.from_version_id = %s AND mp.to_version_id = %s AND mpr.class_name = %s
        """
        rows = self.execute_query(
            query,
            (tenant_id, project_id, from_version_id, to_version_id, class_name)
        )
        rules = {}
        prefix = "migration-edge-prop-"
        for row in rows:
            source_property = row.get("source_property")
            rule = row.get("rule")
            if not source_property or not isinstance(rule, dict):
                continue
            if not (isinstance(rule.get("inputProperties"), list) and isinstance(rule.get("outputProperties"), list)):
                continue
            key = prefix + source_property
            rules[key] = {
                "name": rule.get("name"),
                "inputProperties": rule["inputProperties"],
                "ruleType": rule.get("ruleType", "simple"),
                "ruleContent": rule.get("ruleContent", ""),
                "outputProperties": rule["outputProperties"],
            }
        return rules

    def get_migration_plan_rule_counts(
        self,
        project_id: str,
        from_version_id: str,
        to_version_id: str,
        tenant_id: str
    ) -> Dict[str, int]:
        """
        Get rule counts per class_name for a migration plan.
        Only includes plans whose project belongs to the tenant.
        Returns dict class_name -> count (classes with no rules are not in the dict; treat as 0).
        """
        query = """
            SELECT mpr.class_name, COUNT(*) AS cnt
            FROM apiome.migration_plan_rules mpr
            JOIN apiome.migration_plans mp ON mp.id = mpr.migration_plan_id
            JOIN apiome.projects p ON p.id = mp.project_id AND p.tenant_id = %s AND p.deleted_at IS NULL
            WHERE mp.project_id = %s AND mp.from_version_id = %s AND mp.to_version_id = %s
            GROUP BY mpr.class_name
        """
        rows = self.execute_query(
            query,
            (tenant_id, project_id, from_version_id, to_version_id)
        )
        return {row["class_name"]: int(row["cnt"]) for row in rows}

    def save_migration_plan_rules(
        self,
        project_id: str,
        from_version_id: str,
        to_version_id: str,
        class_name: str,
        rules: Dict[str, Any],
        tenant_id: str
    ) -> Optional[str]:
        """
        Save migration plan rules for a (project, from_version, to_version, class_name).
        Replaces all rules for that class in the plan. Ensures project belongs to tenant.
        Returns None on success, or error message string on failure.
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT 1 FROM apiome.projects WHERE id = %s AND tenant_id = %s AND deleted_at IS NULL",
                    (project_id, tenant_id)
                )
                if cursor.fetchone() is None:
                    return "Project not found or access denied"

                cursor.execute(
                    """SELECT id FROM apiome.migration_plans
                       WHERE project_id = %s AND from_version_id = %s AND to_version_id = %s""",
                    (project_id, from_version_id, to_version_id)
                )
                row = cursor.fetchone()
                if row:
                    plan_id = row["id"]
                    cursor.execute(
                        "UPDATE apiome.migration_plans SET updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                        (plan_id,)
                    )
                else:
                    cursor.execute(
                        """INSERT INTO apiome.migration_plans (project_id, from_version_id, to_version_id)
                           VALUES (%s, %s, %s) RETURNING id""",
                        (project_id, from_version_id, to_version_id)
                    )
                    plan_id = cursor.fetchone()["id"]

                cursor.execute(
                    "DELETE FROM apiome.migration_plan_rules WHERE migration_plan_id = %s AND class_name = %s",
                    (plan_id, class_name)
                )

                prefix = "migration-edge-prop-"
                for edge_key, rule in (rules or {}).items():
                    if not edge_key.startswith(prefix):
                        continue
                    source_property = edge_key[len(prefix):]
                    if not source_property:
                        continue
                    rule_json = json.dumps({
                        "name": rule.get("name"),
                        "inputProperties": rule.get("inputProperties", []),
                        "ruleType": rule.get("ruleType", "simple"),
                        "ruleContent": rule.get("ruleContent", ""),
                        "outputProperties": rule.get("outputProperties", []),
                    })
                    cursor.execute(
                        """INSERT INTO apiome.migration_plan_rules (migration_plan_id, class_name, source_property, rule)
                           VALUES (%s, %s, %s, %s::jsonb)""",
                        (plan_id, class_name, source_property, rule_json)
                    )
                conn.commit()
                return None
        except Exception as e:
            conn.rollback()
            return str(e)

    # ==================== Version tags (git-like pointers to revisions) ====================

    def list_version_tags_for_project(self, project_id: str, tenant_id: str) -> List[Dict[str, Any]]:
        """List tags for a project; tenant-scoped."""
        query = """
            SELECT t.id, t.project_id, t.version_id, t.name, t.message, t.channel, t.immutable, t.protected,
                   t.created_by, t.created_at, t.updated_at,
                   v.version_id AS target_version_string
            FROM apiome.version_tags t
            JOIN apiome.versions v ON v.id = t.version_id AND v.project_id = t.project_id
            JOIN apiome.projects p ON t.project_id = p.id
            WHERE t.project_id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND p.deleted_at IS NULL
            ORDER BY t.name ASC
        """
        return self.execute_query(query, (project_id, tenant_id))

    def get_version_tag_by_id(self, tag_id: str, project_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        query = """
            SELECT t.id, t.project_id, t.version_id, t.name, t.message, t.channel, t.immutable, t.protected,
                   t.created_by, t.created_at, t.updated_at
            FROM apiome.version_tags t
            JOIN apiome.projects p ON t.project_id = p.id
            WHERE t.id = %s AND t.project_id = %s AND p.tenant_id = %s AND p.deleted_at IS NULL
        """
        rows = self.execute_query(query, (tag_id, project_id, tenant_id))
        return rows[0] if rows else None

    def assert_version_in_project_tenant(
        self, version_row_id: str, project_id: str, tenant_id: str
    ) -> bool:
        q = """
            SELECT 1 FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.id = %s AND v.project_id = %s AND p.tenant_id = %s AND v.deleted_at IS NULL
        """
        rows = self.execute_query(q, (version_row_id, project_id, tenant_id))
        return bool(rows)

    def create_version_tag(
        self,
        project_id: str,
        tenant_id: str,
        version_row_id: str,
        name: str,
        message: Optional[str],
        channel: Optional[str],
        immutable: bool,
        tag_protected: bool,
        created_by: Optional[str],
    ) -> Dict[str, Any]:
        if not self.assert_version_in_project_tenant(version_row_id, project_id, tenant_id):
            raise ValueError("Target version not found in this project")
        query = """
            INSERT INTO apiome.version_tags
            (project_id, version_id, name, message, channel, immutable, protected, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, project_id, version_id, name, message, channel, immutable, protected, created_by, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    query,
                    (
                        project_id,
                        version_row_id,
                        name.strip(),
                        message,
                        channel,
                        immutable,
                        tag_protected,
                        created_by,
                    ),
                )
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def update_version_tag(
        self,
        tag_id: str,
        project_id: str,
        tenant_id: str,
        user_id: Optional[str],
        is_admin: bool,
        new_version_row_id: Optional[str],
        set_immutable: bool,
        set_protected: Optional[bool],
    ) -> Optional[Dict[str, Any]]:
        existing = self.get_version_tag_by_id(tag_id, project_id, tenant_id)
        if not existing:
            return None
        if existing.get("immutable"):
            raise PermissionError("TAG_IMMUTABLE")
        if set_protected is not None and not is_admin:
            raise PermissionError("TAG_PROTECT_POLICY_ADMIN_ONLY")
        if existing.get("protected") and not is_admin:
            self.insert_version_protection_audit(
                tenant_id,
                project_id,
                user_id,
                "tag.update",
                "version_tag",
                tag_id,
                "denied",
                {"reason": "tag_protected"},
            )
            raise PermissionError("TAG_PROTECTED")
        if not self.user_may_manage_version_tag(
            tenant_id, user_id or "", existing.get("created_by")
        ):
            raise PermissionError("TAG_FORBIDDEN")

        if new_version_row_id and not self.assert_version_in_project_tenant(
            new_version_row_id, project_id, tenant_id
        ):
            raise ValueError("Target version not found in this project")
        if (
            not new_version_row_id
            and not set_immutable
            and set_protected is None
        ):
            raise ValueError("Provide new revision id, immutable lock, and/or protected policy")

        sets = ["updated_at = CURRENT_TIMESTAMP"]
        params: List[Any] = []
        if new_version_row_id:
            sets.append("version_id = %s")
            params.append(new_version_row_id)
        if set_immutable:
            sets.append("immutable = true")
        if set_protected is not None:
            sets.append("protected = %s")
            params.append(set_protected)
        params.extend([tag_id, project_id])
        q = f"""
            UPDATE apiome.version_tags SET {", ".join(sets)}
            WHERE id = %s AND project_id = %s
            RETURNING id, project_id, version_id, name, message, channel, immutable, protected, created_by, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, tuple(params))
                row = cursor.fetchone()
                conn.commit()
                if existing.get("protected") and is_admin and (new_version_row_id or set_immutable):
                    self.insert_version_protection_audit(
                        tenant_id,
                        project_id,
                        user_id,
                        "tag.update",
                        "version_tag",
                        tag_id,
                        "allowed",
                        {"reason": "admin_override_tag_protection"},
                    )
                if set_protected is not None:
                    self.insert_version_protection_audit(
                        tenant_id,
                        project_id,
                        user_id,
                        "tag.protection_policy",
                        "version_tag",
                        tag_id,
                        "policy_change",
                        {"protected": set_protected},
                    )
                return row
        except Exception as e:
            conn.rollback()
            raise e

    def delete_version_tag(
        self, tag_id: str, project_id: str, tenant_id: str, user_id: Optional[str], is_admin: bool
    ) -> bool:
        existing = self.get_version_tag_by_id(tag_id, project_id, tenant_id)
        if not existing:
            return False
        if existing.get("immutable"):
            raise PermissionError("TAG_IMMUTABLE")
        if existing.get("protected") and not is_admin:
            self.insert_version_protection_audit(
                tenant_id,
                project_id,
                user_id,
                "tag.delete",
                "version_tag",
                tag_id,
                "denied",
                {"reason": "tag_protected"},
            )
            raise PermissionError("TAG_PROTECTED")
        if not is_admin and not self.user_may_manage_version_tag(
            tenant_id, user_id or "", existing.get("created_by")
        ):
            raise PermissionError("TAG_FORBIDDEN")
        query = "DELETE FROM apiome.version_tags WHERE id = %s AND project_id = %s"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, (tag_id, project_id))
                ok = cursor.rowcount > 0
                conn.commit()
                if ok and existing.get("protected") and is_admin:
                    self.insert_version_protection_audit(
                        tenant_id,
                        project_id,
                        user_id,
                        "tag.delete",
                        "version_tag",
                        tag_id,
                        "allowed",
                        {"reason": "admin_override_tag_protection"},
                    )
                return ok
        except Exception as e:
            conn.rollback()
            raise e

    def user_may_manage_version_tag(
        self, tenant_id: str, user_id: str, tag_created_by: Optional[str]
    ) -> bool:
        """Creator match or tenant administrator."""
        if tag_created_by and tag_created_by == user_id:
            return True
        q = """
            SELECT 1 FROM apiome.tenant_administrators
            WHERE tenant_id = %s AND user_id = %s
            LIMIT 1
        """
        return bool(self.execute_query(q, (tenant_id, user_id)))

    # ==================== Version merge (Git-like three-way) ====================

    def collect_revision_ancestors(self, version_id: str, tenant_id: str) -> Set[str]:
        """All revision ids reachable from ``version_id`` following parent links (including self)."""
        result: Set[str] = set()
        stack = [version_id]
        steps = 0
        while stack:
            if steps > 100000:
                raise RuntimeError("Revision ancestor walk exceeded safety limit")
            steps += 1
            vid = stack.pop()
            if vid in result:
                continue
            result.add(vid)
            row = self.get_version_by_id(vid, tenant_id)
            if not row:
                continue
            for p in (row.get("parent_version_id"), row.get("merge_parent_version_id")):
                if p and str(p) not in result:
                    stack.append(str(p))
        return result

    def compute_merge_base_revision_id(
        self, rev_a: str, rev_b: str, tenant_id: str
    ) -> Optional[str]:
        """Best common ancestor (nearest to tips by creation time) for two revision ids in the same project."""
        a = self.collect_revision_ancestors(rev_a, tenant_id)
        b = self.collect_revision_ancestors(rev_b, tenant_id)
        common = a & b
        if not common:
            return None

        # Cache ancestor sets to avoid O(n²) repeated full graph walks.
        ancestor_cache: Dict[str, Set[str]] = {rev_a: a, rev_b: b}

        def get_cached_ancestors(vid: str) -> Set[str]:
            if vid not in ancestor_cache:
                ancestor_cache[vid] = self.collect_revision_ancestors(vid, tenant_id)
            return ancestor_cache[vid]

        def is_strict_ancestor(anc: str, desc: str) -> bool:
            if anc == desc:
                return False
            return anc in get_cached_ancestors(desc)

        bases = [
            c
            for c in common
            if not any(c != d and is_strict_ancestor(c, d) for d in common)
        ]
        if not bases:
            return None
        if len(bases) == 1:
            return bases[0]

        # Multiple maximal common ancestors (criss-cross history): pick the one
        # nearest to the branch tips by choosing the most recently created revision.
        from datetime import datetime, timezone

        _epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)

        def created_at_key(vid: str):
            row = self.get_version_by_id(vid, tenant_id)
            ts = row["created_at"] if row and row.get("created_at") else None
            return ts if ts is not None else _epoch

        return max(bases, key=created_at_key)

    def get_prior_published_baseline_revision_id(
        self, project_id: str, tenant_id: str, published_revision_id: str
    ) -> Optional[str]:
        """
        Latest **published** ancestor of ``published_revision_id`` (excluding the revision itself),
        ordered by ``published_at`` then ``created_at``.

        Used as the default baseline for publication change reports (#2702). Revisions outside the
        ancestor closure of ``parent_version_id`` / ``merge_parent_version_id`` are not considered
        (named-branch isolation is a possible follow-up).
        """
        ancestors = self.collect_revision_ancestors(published_revision_id, tenant_id)
        cand_ids = [str(a) for a in ancestors if str(a) != str(published_revision_id)]
        if not cand_ids:
            return None
        placeholders = ",".join(["%s"] * len(cand_ids))
        query = f"""
            SELECT v.id
            FROM apiome.versions v
            INNER JOIN apiome.projects p ON v.project_id = p.id AND p.deleted_at IS NULL
            WHERE v.project_id = %s
              AND p.tenant_id = %s
              AND v.deleted_at IS NULL
              AND v.published = true
              AND v.id IN ({placeholders})
            ORDER BY v.published_at DESC NULLS LAST, v.created_at DESC
            LIMIT 1
        """
        params = tuple([project_id, tenant_id, *cand_ids])
        rows = self.execute_query(query, params)
        if not rows:
            return None
        rid = rows[0].get("id")
        return str(rid) if rid is not None else None

    def get_version_branch_by_id(
        self, branch_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Return the branch row for *branch_id* scoped to *tenant_id* (no project filter)."""
        q = """
            SELECT b.id, b.project_id, b.name, b.tip_version_id, b.branched_from_revision_id,
                   b.protected, b.is_default, b.require_merge_path, b.created_by, b.created_at, b.updated_at
            FROM apiome.version_branches b
            JOIN apiome.projects p ON b.project_id = p.id
            WHERE b.id = %s AND p.tenant_id = %s
        """
        rows = self.execute_query(q, (branch_id, tenant_id))
        return rows[0] if rows else None

    def get_version_branch_by_name(
        self, project_id: str, tenant_id: str, name: str
    ) -> Optional[Dict[str, Any]]:
        q = """
            SELECT b.id, b.project_id, b.name, b.tip_version_id, b.branched_from_revision_id,
                   b.protected, b.is_default, b.require_merge_path, b.created_by, b.created_at, b.updated_at
            FROM apiome.version_branches b
            JOIN apiome.projects p ON b.project_id = p.id
            WHERE b.project_id = %s AND p.tenant_id = %s AND b.name = %s
        """
        rows = self.execute_query(q, (project_id, tenant_id, name.strip()))
        return rows[0] if rows else None

    def update_version_branch_protection_policy(
        self,
        project_id: str,
        tenant_id: str,
        branch_id: str,
        *,
        protected: Optional[bool] = None,
        is_default: Optional[bool] = None,
        require_merge_path: Optional[bool] = None,
        actor_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Tenant-admin policy fields on a branch (#504, #2583, #2727). At least one of protected or
        require_merge_path or is_default must be set.

        When the default branch changes (promotion), ``require_merge_path`` is set to true in the
        same transaction unless the request explicitly sets ``require_merge_path`` false. If the
        target branch is already default, merge-path is only updated when ``require_merge_path`` is
        present in the request. Optionally records ``version.default_branch_promoted`` in
        ``workflow_audit`` when ``actor_id`` is set.
        """
        if protected is None and require_merge_path is None and is_default is None:
            return None
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT b.id
                    FROM apiome.version_branches b
                    JOIN apiome.projects p ON b.project_id = p.id
                    WHERE b.id = %s AND b.project_id = %s AND p.tenant_id = %s
                    FOR UPDATE
                    """,
                    (branch_id, project_id, tenant_id),
                )
                locked = cursor.fetchone()
                if not locked:
                    conn.rollback()
                    return None

                prior_default_id: Optional[str] = None
                is_promotion = False
                merge_path_auto_enabled = False
                rmp_for_set: Optional[bool] = None

                if is_default is True:
                    cursor.execute(
                        """
                        SELECT id FROM apiome.version_branches
                        WHERE project_id = %s AND is_default = true
                        FOR UPDATE
                        """,
                        (project_id,),
                    )
                    prow = cursor.fetchone()
                    pid = prow.get("id") if prow else None
                    prior_default_id = str(pid) if pid is not None else None
                    is_promotion = prior_default_id is None or prior_default_id != str(branch_id)
                    if is_promotion:
                        if require_merge_path is None:
                            rmp_for_set = True
                            merge_path_auto_enabled = True
                        else:
                            rmp_for_set = require_merge_path
                    elif require_merge_path is not None:
                        rmp_for_set = require_merge_path
                elif require_merge_path is not None:
                    rmp_for_set = require_merge_path

                if is_default is True:
                    cursor.execute(
                        """
                        UPDATE apiome.version_branches
                        SET is_default = false, updated_at = CURRENT_TIMESTAMP
                        WHERE project_id = %s AND id <> %s AND is_default = true
                        """,
                        (project_id, branch_id),
                    )

                sets: List[str] = []
                params: List[Any] = []
                if protected is not None:
                    sets.append("protected = %s")
                    params.append(protected)
                if is_default is not None:
                    sets.append("is_default = %s")
                    params.append(is_default)
                if rmp_for_set is not None:
                    sets.append("require_merge_path = %s")
                    params.append(rmp_for_set)
                sets.append("updated_at = CURRENT_TIMESTAMP")
                params.extend([branch_id, project_id, tenant_id])

                cursor.execute(
                    f"""
                    UPDATE apiome.version_branches b
                    SET {", ".join(sets)}
                    FROM apiome.projects p
                    WHERE b.id = %s AND b.project_id = %s AND b.project_id = p.id AND p.tenant_id = %s
                    RETURNING b.id, b.project_id, b.name, b.tip_version_id, b.branched_from_revision_id,
                              b.protected, b.is_default, b.require_merge_path, b.created_by, b.created_at, b.updated_at
                    """,
                    tuple(params),
                )
                row = cursor.fetchone()

                if row and is_default is True and is_promotion and actor_id:
                    detail = {
                        "priorDefaultBranchId": prior_default_id,
                        "newDefaultBranchId": str(branch_id),
                        "mergePathAutoEnabled": merge_path_auto_enabled,
                    }
                    cursor.execute(
                        """
                        INSERT INTO apiome.workflow_audit
                          (tenant_id, project_id, version_id, action, outcome, actor_id, detail)
                        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                        """,
                        (
                            tenant_id,
                            project_id,
                            None,
                            "version.default_branch_promoted",
                            "success",
                            actor_id,
                            json.dumps(detail),
                        ),
                    )

            conn.commit()
            return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            msg = str(e).lower()
            if "23505" in msg or "uq_version_branches_default_per_project" in msg:
                raise BranchDefaultConflictError() from e
            raise
        finally:
            conn.autocommit = prev_autocommit

    def _branch_from_revision_idempotent_result(
        self,
        existing: Dict[str, Any],
        source_revision_id: str,
        tenant_id: str,
    ) -> Dict[str, Any]:
        """If existing branch matches source revision as tip (and lineage), return success replay."""
        tip = str(existing["tip_version_id"])
        bf = existing.get("branched_from_revision_id")
        bf_s = str(bf) if bf is not None else None
        src = str(source_revision_id).strip()
        if tip == src and (bf_s is None or bf_s == src):
            full_tip = self.get_version_by_id(tip, tenant_id)
            if not full_tip:
                return {
                    "success": False,
                    "error": "Branch tip revision not found",
                    "code": "NOT_FOUND",
                }
            return {
                "success": True,
                "branch": existing,
                "tip_version": full_tip,
                "idempotent_replay": True,
            }
        return {
            "success": False,
            "error": (
                f"A branch named '{existing.get('name')}' already exists in this project "
                "with a different tip or lineage."
            ),
            "code": "BRANCH_NAME_CONFLICT",
        }

    def create_version_branch_from_revision(
        self,
        project_id: str,
        tenant_id: str,
        branch_name: str,
        source_revision_id: str,
        creator_id: Optional[str],
    ) -> Dict[str, Any]:
        """
        Insert a named branch whose tip is ``source_revision_id``; persist ``branched_from_revision_id`` (#2570).
        Idempotent when the same name already points at the same source revision (and compatible lineage).
        """
        bn = (branch_name or "").strip()
        src = (source_revision_id or "").strip()
        if not bn:
            return {"success": False, "error": "branchName is required", "code": "INVALID_INPUT"}
        if not src:
            return {"success": False, "error": "sourceRevisionId is required", "code": "INVALID_INPUT"}

        ver = self.get_version_by_id(src, tenant_id)
        if not ver or str(ver["project_id"]) != str(project_id):
            return {
                "success": False,
                "error": "Source revision not found in this project",
                "code": "NOT_FOUND",
            }

        existing = self.get_version_branch_by_name(project_id, tenant_id, bn)
        if existing:
            return self._branch_from_revision_idempotent_result(existing, src, tenant_id)

        conn = self.connect()
        row: Optional[Dict[str, Any]] = None
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.version_branches
                        (project_id, name, tip_version_id, created_by, branched_from_revision_id)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id, project_id, name, tip_version_id, branched_from_revision_id,
                              protected, is_default, require_merge_path, created_by, created_at, updated_at
                    """,
                    (project_id, bn, src, creator_id, src),
                )
                row = cursor.fetchone()
            conn.commit()
        except Exception as e:
            conn.rollback()
            err = str(e).lower()
            if "23505" in err or "unique" in err:
                existing2 = self.get_version_branch_by_name(project_id, tenant_id, bn)
                if existing2:
                    return self._branch_from_revision_idempotent_result(
                        existing2, src, tenant_id
                    )
            _logger.exception(
                "Database error creating version branch from revision "
                "(project_id=%s, tenant_id=%s, branch_name=%s, source_revision_id=%s)",
                project_id,
                tenant_id,
                bn,
                src,
            )
            return {
                "success": False,
                "error": "Failed to create branch due to a database error",
                "code": "DATABASE_ERROR",
            }

        if not row:
            return {"success": False, "error": "Failed to create branch", "code": "DATABASE_ERROR"}

        branch_row = dict(row)
        full_tip = self.get_version_by_id(src, tenant_id)
        if not full_tip:
            return {"success": False, "error": "Tip revision not found after insert", "code": "NOT_FOUND"}
        return {
            "success": True,
            "branch": branch_row,
            "tip_version": full_tip,
            "idempotent_replay": False,
        }

    def delete_class_by_name_for_version(
        self,
        version_id: str,
        class_name: str,
        tenant_id: str,
        cursor: Optional[Any] = None,
    ) -> bool:
        """Soft-delete a class by name within a version (tenant-scoped)."""
        query = """
            UPDATE apiome.classes c
            SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE c.version_id = v.id
              AND c.version_id = %s
              AND c.name = %s
              AND p.tenant_id = %s
              AND c.deleted_at IS NULL
        """
        if cursor is not None:
            cursor.execute(query, (version_id, class_name, tenant_id))
            return cursor.rowcount > 0
        conn = self.connect()
        try:
            with conn.cursor() as cur:
                cur.execute(query, (version_id, class_name, tenant_id))
                conn.commit()
                return cur.rowcount > 0
        except Exception as e:
            conn.rollback()
            raise e

    def _copy_class_properties_recursive(
        self, cursor: Any, source_class_id: str, target_class_id: str
    ) -> None:
        cursor.execute(
            """
            SELECT id, property_id, name, description, data, parent_id, primitive_id, primitive_ref
            FROM apiome.class_properties
            WHERE class_id = %s
            """,
            (source_class_id,),
        )
        rows = cursor.fetchall()
        old_to_new: Dict[str, str] = {}
        processed: Set[str] = set()

        def copy_level(parent_id: Optional[str]) -> None:
            props: List[Dict[str, Any]] = []
            for r in rows:
                if str(r["id"]) in processed:
                    continue
                pid = r.get("parent_id")
                if parent_id is None:
                    if pid is not None:
                        continue
                else:
                    if pid is None or str(pid) != str(parent_id):
                        continue
                props.append(r)
            for prop in props:
                new_parent = None
                if prop["parent_id"]:
                    new_parent = old_to_new.get(str(prop["parent_id"]))
                cursor.execute(
                    """
                    INSERT INTO apiome.class_properties
                        (class_id, property_id, name, description, data, parent_id, primitive_id, primitive_ref)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        target_class_id,
                        prop["property_id"],
                        prop["name"],
                        prop["description"],
                        # ``data`` is a JSONB column read back as a Python dict; it must be
                        # re-wrapped with Json() before re-insertion or psycopg2 raises
                        # "can't adapt type 'dict'". Preserve SQL NULL (vs JSON null) for
                        # properties that have no data payload.
                        Json(prop["data"]) if prop["data"] is not None else None,
                        new_parent,
                        prop.get("primitive_id"),
                        prop.get("primitive_ref"),
                    ),
                )
                new_id = cursor.fetchone()["id"]
                old_to_new[str(prop["id"])] = str(new_id)
                processed.add(str(prop["id"]))
                copy_level(str(prop["id"]))

        copy_level(None)

    def copy_classes_from_version_for_merge(
        self, cursor: Any, source_version_id: str, target_version_id: str
    ) -> int:
        """Copy all classes and nested properties (used inside an open transaction)."""
        cursor.execute(
            """
            INSERT INTO apiome.classes (version_id, name, description, schema, enabled, canvas_metadata)
            SELECT %s, name, description, schema, enabled, canvas_metadata
            FROM apiome.classes
            WHERE version_id = %s AND deleted_at IS NULL
            RETURNING id, name
            """,
            (target_version_id, source_version_id),
        )
        copied = cursor.fetchall()
        for row in copied:
            cursor.execute(
                """
                SELECT id FROM apiome.classes
                WHERE version_id = %s AND name = %s AND deleted_at IS NULL
                """,
                (source_version_id, row["name"]),
            )
            orig = cursor.fetchone()
            if not orig:
                continue
            self._copy_class_properties_recursive(cursor, str(orig["id"]), str(row["id"]))
        return len(copied)

    def copy_single_class_between_versions_for_merge(
        self, cursor: Any, source_version_id: str, target_version_id: str, class_name: str
    ) -> Dict[str, Any]:
        """Copy one class by name from source version to target (open transaction)."""
        cursor.execute(
            """
            INSERT INTO apiome.classes (version_id, name, description, schema, enabled, canvas_metadata)
            SELECT %s, name, description, schema, enabled, canvas_metadata
            FROM apiome.classes
            WHERE version_id = %s AND name = %s AND deleted_at IS NULL
            RETURNING id, name
            """,
            (target_version_id, source_version_id, class_name),
        )
        ins = cursor.fetchone()
        if not ins:
            return {"success": False, "error": f"Class {class_name} not found on source version"}
        cursor.execute(
            """
            SELECT id FROM apiome.classes
            WHERE version_id = %s AND name = %s AND deleted_at IS NULL
            """,
            (source_version_id, class_name),
        )
        orig = cursor.fetchone()
        if not orig:
            return {"success": False, "error": "Original class missing"}
        self._copy_class_properties_recursive(cursor, str(orig["id"]), str(ins["id"]))
        return {"success": True}

    def list_version_branches_for_project(
        self, project_id: str, tenant_id: str
    ) -> List[Dict[str, Any]]:
        """Named branches for a project (tenant-scoped)."""
        q = """
            SELECT b.id, b.project_id, b.name, b.tip_version_id, b.branched_from_revision_id,
                   b.protected, b.is_default, b.require_merge_path, b.created_by,
                   b.created_at, b.updated_at
            FROM apiome.version_branches b
            JOIN apiome.projects p ON b.project_id = p.id
            WHERE b.project_id = %s AND p.tenant_id = %s
            ORDER BY b.is_default DESC, b.name ASC
        """
        return self.execute_query(q, (project_id, tenant_id))

    def list_version_branches_detailed_for_project(
        self, project_id: str, tenant_id: str
    ) -> List[Dict[str, Any]]:
        """Named branches with tip version string (for Studio / UI BFF consumers)."""
        q = """
            SELECT b.id, b.project_id, b.name, b.tip_version_id, b.is_default, b.protected,
                   b.require_merge_path, b.created_by, b.created_at, b.updated_at,
                   v.version_id AS tip_version_string
            FROM apiome.version_branches b
            JOIN apiome.versions v ON v.id = b.tip_version_id AND v.project_id = b.project_id
            JOIN apiome.projects p ON b.project_id = p.id
            WHERE b.project_id = %s AND p.tenant_id = %s AND v.deleted_at IS NULL
            ORDER BY b.name ASC
        """
        return self.execute_query(q, (project_id, tenant_id))

    def compute_branch_divergence(
        self,
        *,
        project_id: str,
        tenant_id: str,
        branch_tip_revision_id: str,
        against_tip_revision_id: str,
        sample_limit: int = 5,
    ) -> Dict[str, Any]:
        """
        Compute git-like branch divergence from branch tips using recursive CTEs.

        Returns merge base revision metadata, ahead/behind counts, and sampled revisions on each side.
        """
        limit = max(1, min(int(sample_limit), 25))
        q = """
            WITH RECURSIVE
            branch_ancestors AS (
                SELECT
                    v.id::text AS revision_id,
                    v.parent_version_id::text AS parent_revision_id,
                    v.merge_parent_version_id::text AS merge_parent_revision_id
                FROM apiome.versions v
                JOIN apiome.projects p ON v.project_id = p.id
                WHERE v.id = %s
                  AND v.project_id = %s
                  AND p.tenant_id = %s
                  AND v.deleted_at IS NULL
                UNION
                SELECT
                    v.id::text AS revision_id,
                    v.parent_version_id::text AS parent_revision_id,
                    v.merge_parent_version_id::text AS merge_parent_revision_id
                FROM apiome.versions v
                JOIN branch_ancestors a
                  ON v.id::text = a.parent_revision_id
                  OR v.id::text = a.merge_parent_revision_id
                WHERE v.project_id = %s
                  AND v.deleted_at IS NULL
            ),
            against_ancestors AS (
                SELECT
                    v.id::text AS revision_id,
                    v.parent_version_id::text AS parent_revision_id,
                    v.merge_parent_version_id::text AS merge_parent_revision_id
                FROM apiome.versions v
                JOIN apiome.projects p ON v.project_id = p.id
                WHERE v.id = %s
                  AND v.project_id = %s
                  AND p.tenant_id = %s
                  AND v.deleted_at IS NULL
                UNION
                SELECT
                    v.id::text AS revision_id,
                    v.parent_version_id::text AS parent_revision_id,
                    v.merge_parent_version_id::text AS merge_parent_revision_id
                FROM apiome.versions v
                JOIN against_ancestors a
                  ON v.id::text = a.parent_revision_id
                  OR v.id::text = a.merge_parent_revision_id
                WHERE v.project_id = %s
                  AND v.deleted_at IS NULL
            ),
            merge_base AS (
                SELECT v.id::text AS revision_id, v.created_at
                FROM apiome.versions v
                JOIN branch_ancestors ba ON ba.revision_id = v.id::text
                JOIN against_ancestors aa ON aa.revision_id = v.id::text
                WHERE v.project_id = %s
                  AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC, v.id DESC
                LIMIT 1
            ),
            merge_base_ancestors AS (
                SELECT
                    v.id::text AS revision_id,
                    v.parent_version_id::text AS parent_revision_id,
                    v.merge_parent_version_id::text AS merge_parent_revision_id
                FROM apiome.versions v
                JOIN merge_base mb ON v.id::text = mb.revision_id
                UNION
                SELECT
                    v.id::text AS revision_id,
                    v.parent_version_id::text AS parent_revision_id,
                    v.merge_parent_version_id::text AS merge_parent_revision_id
                FROM apiome.versions v
                JOIN merge_base_ancestors mba
                  ON v.id::text = mba.parent_revision_id
                  OR v.id::text = mba.merge_parent_revision_id
                WHERE v.project_id = %s
                  AND v.deleted_at IS NULL
            ),
            ahead_set AS (
                SELECT ba.revision_id
                FROM branch_ancestors ba
                LEFT JOIN merge_base_ancestors mba ON mba.revision_id = ba.revision_id
                WHERE mba.revision_id IS NULL
            ),
            behind_set AS (
                SELECT aa.revision_id
                FROM against_ancestors aa
                LEFT JOIN merge_base_ancestors mba ON mba.revision_id = aa.revision_id
                WHERE mba.revision_id IS NULL
            ),
            ahead_sample AS (
                SELECT
                    v.id::text AS revision_id,
                    COALESCE(v.description, '') AS short_message,
                    v.created_at
                FROM apiome.versions v
                JOIN ahead_set a ON a.revision_id = v.id::text
                WHERE v.project_id = %s
                  AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC, v.id DESC
                LIMIT %s
            ),
            behind_sample AS (
                SELECT
                    v.id::text AS revision_id,
                    COALESCE(v.description, '') AS short_message,
                    v.created_at
                FROM apiome.versions v
                JOIN behind_set b ON b.revision_id = v.id::text
                WHERE v.project_id = %s
                  AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC, v.id DESC
                LIMIT %s
            )
            SELECT
                (SELECT mb.revision_id FROM merge_base mb) AS merge_base_revision_id,
                (SELECT mb.created_at FROM merge_base mb) AS merge_base_created_at,
                (SELECT COUNT(*)::int FROM ahead_set) AS ahead_count,
                (SELECT COUNT(*)::int FROM behind_set) AS behind_count,
                COALESCE(
                    (
                        SELECT json_agg(
                            json_build_object(
                                'revisionId', a.revision_id,
                                'shortMessage', a.short_message
                            )
                            ORDER BY a.created_at DESC, a.revision_id DESC
                        )
                        FROM ahead_sample a
                    ),
                    '[]'::json
                ) AS ahead_sample,
                COALESCE(
                    (
                        SELECT json_agg(
                            json_build_object(
                                'revisionId', b.revision_id,
                                'shortMessage', b.short_message
                            )
                            ORDER BY b.created_at DESC, b.revision_id DESC
                        )
                        FROM behind_sample b
                    ),
                    '[]'::json
                ) AS behind_sample
        """
        rows = self.execute_query(
            q,
            (
                branch_tip_revision_id,
                project_id,
                tenant_id,
                project_id,
                against_tip_revision_id,
                project_id,
                tenant_id,
                project_id,
                project_id,
                project_id,
                project_id,
                limit,
                project_id,
                limit,
            ),
        )
        if not rows:
            return {
                "merge_base_revision_id": None,
                "merge_base_created_at": None,
                "ahead_count": 0,
                "behind_count": 0,
                "ahead_sample": [],
                "behind_sample": [],
            }
        row = rows[0]
        ahead_sample = row.get("ahead_sample") or []
        behind_sample = row.get("behind_sample") or []
        if isinstance(ahead_sample, str):
            ahead_sample = json.loads(ahead_sample)
        if isinstance(behind_sample, str):
            behind_sample = json.loads(behind_sample)
        return {
            "merge_base_revision_id": row.get("merge_base_revision_id"),
            "merge_base_created_at": row.get("merge_base_created_at"),
            "ahead_count": int(row.get("ahead_count") or 0),
            "behind_count": int(row.get("behind_count") or 0),
            "ahead_sample": ahead_sample if isinstance(ahead_sample, list) else [],
            "behind_sample": behind_sample if isinstance(behind_sample, list) else [],
        }

    def get_latest_revision_id_for_project(
        self, project_id: str, tenant_id: str
    ) -> Optional[str]:
        """Most recently created revision row id for the project (no branch), or None if empty."""
        q = """
            SELECT v.id::text AS id
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.project_id = %s AND p.tenant_id = %s AND v.deleted_at IS NULL
            ORDER BY v.created_at DESC
            LIMIT 1
        """
        rows = self.execute_query(q, (project_id, tenant_id))
        return str(rows[0]["id"]) if rows else None

    # -----------------------------------------------------------------------
    # Convert-to-project provenance (apiome.conversion_provenance, V139, MFI-22.5)
    # -----------------------------------------------------------------------

    #: Columns returned by conversion-provenance reads, in a fixed order.
    _CONVERSION_PROVENANCE_COLUMNS = (
        "id, tenant_id, source_project_id, source_version_id, source_format, "
        "source_protocol, source_version_label, source_tool_versions, target_project_id, "
        "target_version_id, target_version_label, fidelity_report, fidelity_score, "
        "fidelity_grade, fidelity_tier, lint_score, lint_grade, converter_tool_versions, "
        "reconverted, created_by, created_at"
    )

    def create_conversion_provenance(
        self,
        *,
        tenant_id: str,
        created_by: Optional[str],
        source_project_id: str,
        source_version_id: Optional[str],
        source_format: Optional[str],
        source_protocol: Optional[str],
        source_version_label: Optional[str],
        source_tool_versions: Optional[Dict[str, Any]],
        target_project_id: str,
        target_version_id: Optional[str],
        target_version_label: Optional[str],
        fidelity_report: Optional[Dict[str, Any]],
        fidelity_score: Optional[int],
        fidelity_grade: Optional[str],
        fidelity_tier: Optional[str],
        lint_score: Optional[int],
        lint_grade: Optional[str],
        converter_tool_versions: Optional[Dict[str, Any]],
        reconverted: bool,
    ) -> Dict[str, Any]:
        """Append one convert-to-project provenance row (MFI-22.5) and return it.

        Records the lineage of a catalog → OpenAPI conversion: the source catalog item + revision it
        was converted from (with its format/protocol/tool provenance), the publishable Project +
        revision it produced, the fidelity report the user reviewed, the captured OpenAPI lint score,
        and the converter tool versions that produced it. The ``conversion_provenance`` table is
        append-only (a DB trigger rejects UPDATE/DELETE), so a re-convert calls this again with a new
        target revision rather than mutating the prior row.

        JSONB bags (``*_tool_versions``, ``fidelity_report``) are wrapped in :class:`psycopg2.extras.Json`;
        ``None`` becomes the column default (``{}``).

        Returns:
            The inserted row as a dict.
        """
        query = f"""
            INSERT INTO apiome.conversion_provenance
                (tenant_id, created_by, source_project_id, source_version_id, source_format,
                 source_protocol, source_version_label, source_tool_versions, target_project_id,
                 target_version_id, target_version_label, fidelity_report, fidelity_score,
                 fidelity_grade, fidelity_tier, lint_score, lint_grade, converter_tool_versions,
                 reconverted)
            VALUES (%s, %s, %s, %s, %s, %s, %s, COALESCE(%s, '{{}}'::jsonb), %s, %s, %s,
                    COALESCE(%s, '{{}}'::jsonb), %s, %s, %s, %s, %s,
                    COALESCE(%s, '{{}}'::jsonb), %s)
            RETURNING {self._CONVERSION_PROVENANCE_COLUMNS}
        """
        params = (
            tenant_id,
            created_by,
            source_project_id,
            source_version_id,
            source_format,
            source_protocol,
            source_version_label,
            Json(source_tool_versions) if source_tool_versions is not None else None,
            target_project_id,
            target_version_id,
            target_version_label,
            Json(fidelity_report) if fidelity_report is not None else None,
            fidelity_score,
            fidelity_grade,
            fidelity_tier,
            lint_score,
            lint_grade,
            Json(converter_tool_versions) if converter_tool_versions is not None else None,
            reconverted,
        )
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                result = cursor.fetchone()
                conn.commit()
                return result
        except Exception as e:
            conn.rollback()
            raise e

    def get_latest_conversion_for_source(
        self, tenant_id: str, source_project_id: str
    ) -> Optional[Dict[str, Any]]:
        """Most recent conversion of a source catalog item, or ``None`` if never converted.

        The convert job reads this to decide first-convert vs re-convert: a non-``None`` row names the
        ``target_project_id`` a re-convert must append a new version to (rather than minting a
        duplicate Project). Tenant-scoped so one tenant never sees another's conversions.
        """
        query = f"""
            SELECT {self._CONVERSION_PROVENANCE_COLUMNS}
            FROM apiome.conversion_provenance
            WHERE tenant_id = %s AND source_project_id = %s
            ORDER BY created_at DESC
            LIMIT 1
        """
        rows = self.execute_query(query, (tenant_id, source_project_id))
        return rows[0] if rows else None

    def get_conversions_for_project(
        self, tenant_id: str, target_project_id: str
    ) -> List[Dict[str, Any]]:
        """All conversion-provenance rows that produced ``target_project_id`` (newest first).

        The reverse of :meth:`get_latest_conversion_for_source`: "where did this converted Project come
        from?" — one Project accumulates one row per (re-)convert. Tenant-scoped.
        """
        query = f"""
            SELECT {self._CONVERSION_PROVENANCE_COLUMNS}
            FROM apiome.conversion_provenance
            WHERE tenant_id = %s AND target_project_id = %s
            ORDER BY created_at DESC
        """
        return self.execute_query(query, (tenant_id, target_project_id))

    # -----------------------------------------------------------------------
    # Cross-format API identity (api_identity_groups / api_identity_members, V140, MFI-6.4)
    # -----------------------------------------------------------------------

    _IDENTITY_MEMBER_COLUMNS = (
        "m.id, m.tenant_id, m.group_id, m.project_id, m.link_source, m.created_by, m.created_at"
    )

    def get_identity_group_id_for_project(
        self, tenant_id: str, project_id: str
    ) -> Optional[str]:
        """Return the identity group id for ``project_id``, or ``None`` when ungrouped."""
        query = """
            SELECT group_id::text AS group_id
            FROM apiome.api_identity_members
            WHERE tenant_id = %s AND project_id = %s
            LIMIT 1
        """
        rows = self.execute_query(query, (tenant_id, project_id))
        return str(rows[0]["group_id"]) if rows else None

    def get_related_artifact_rows(
        self, tenant_id: str, project_id: str
    ) -> List[Dict[str, Any]]:
        """Return sibling members of ``project_id``'s identity group (excluding ``project_id``)."""
        query = """
            SELECT p.id::text AS project_id, p.name, p.slug, p.publishable,
                   p.deleted_at IS NOT NULL AS deleted,
                   cv.source_format, cv.protocol, m.link_source
            FROM apiome.api_identity_members anchor
            JOIN apiome.api_identity_members m
              ON m.tenant_id = anchor.tenant_id AND m.group_id = anchor.group_id
            JOIN apiome.projects p ON p.id = m.project_id
            LEFT JOIN LATERAL (
                SELECT v.source_format, v.protocol
                FROM apiome.versions v
                WHERE v.project_id = p.id AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC NULLS LAST, v.id DESC
                LIMIT 1
            ) cv ON TRUE
            WHERE anchor.tenant_id = %s AND anchor.project_id = %s
              AND m.project_id <> %s
            ORDER BY p.name ASC, p.id ASC
        """
        return self.execute_query(query, (tenant_id, project_id, project_id))

    def _create_identity_group(
        self, tenant_id: str, created_by: Optional[str]
    ) -> str:
        query = """
            INSERT INTO apiome.api_identity_groups (tenant_id, created_by)
            VALUES (%s, %s)
            RETURNING id::text AS id
        """
        rows = self.execute_query(query, (tenant_id, created_by))
        return str(rows[0]["id"])

    def _add_identity_member(
        self,
        *,
        tenant_id: str,
        group_id: str,
        project_id: str,
        created_by: Optional[str],
        link_source: str,
    ) -> None:
        query = """
            INSERT INTO apiome.api_identity_members
                (tenant_id, group_id, project_id, link_source, created_by)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, project_id) DO NOTHING
        """
        self.execute_query(
            query, (tenant_id, group_id, project_id, link_source, created_by)
        )

    def _merge_identity_groups(
        self, tenant_id: str, keep_group_id: str, drop_group_id: str
    ) -> None:
        query = """
            UPDATE apiome.api_identity_members
            SET group_id = %s
            WHERE tenant_id = %s AND group_id = %s
        """
        self.execute_query(query, (keep_group_id, tenant_id, drop_group_id))
        self.execute_query(
            "DELETE FROM apiome.api_identity_groups WHERE id = %s AND tenant_id = %s",
            (drop_group_id, tenant_id),
        )

    def _dissolve_identity_group_if_small(
        self, tenant_id: str, group_id: str
    ) -> None:
        count_query = """
            SELECT COUNT(*)::int AS cnt
            FROM apiome.api_identity_members
            WHERE tenant_id = %s AND group_id = %s
        """
        rows = self.execute_query(count_query, (tenant_id, group_id))
        if rows and int(rows[0]["cnt"]) < 2:
            self.execute_query(
                "DELETE FROM apiome.api_identity_members WHERE tenant_id = %s AND group_id = %s",
                (tenant_id, group_id),
            )
            self.execute_query(
                "DELETE FROM apiome.api_identity_groups WHERE id = %s AND tenant_id = %s",
                (group_id, tenant_id),
            )

    def link_identity_projects(
        self,
        *,
        tenant_id: str,
        project_id_a: str,
        project_id_b: str,
        created_by: Optional[str],
        link_source: str = "manual",
    ) -> Optional[str]:
        """Link two projects into the same identity group; return the resulting group id."""
        if project_id_a == project_id_b:
            raise ValueError("Cannot link a project to itself")

        for pid in (project_id_a, project_id_b):
            if not self.get_project_by_id(pid, tenant_id):
                raise ValueError(f"Project not found: {pid}")

        group_a = self.get_identity_group_id_for_project(tenant_id, project_id_a)
        group_b = self.get_identity_group_id_for_project(tenant_id, project_id_b)

        if group_a and group_b:
            if group_a == group_b:
                return group_a
            self._merge_identity_groups(tenant_id, group_a, group_b)
            return group_a

        if group_a:
            self._add_identity_member(
                tenant_id=tenant_id,
                group_id=group_a,
                project_id=project_id_b,
                created_by=created_by,
                link_source=link_source,
            )
            return group_a

        if group_b:
            self._add_identity_member(
                tenant_id=tenant_id,
                group_id=group_b,
                project_id=project_id_a,
                created_by=created_by,
                link_source=link_source,
            )
            return group_b

        group_id = self._create_identity_group(tenant_id, created_by)
        for pid in (project_id_a, project_id_b):
            self._add_identity_member(
                tenant_id=tenant_id,
                group_id=group_id,
                project_id=pid,
                created_by=created_by,
                link_source=link_source,
            )
        return group_id

    def unlink_identity_projects(
        self,
        *,
        tenant_id: str,
        project_id: str,
        related_project_id: str,
    ) -> None:
        """Remove ``related_project_id`` from the shared identity group when both are members."""
        group_id = self.get_identity_group_id_for_project(tenant_id, project_id)
        related_group = self.get_identity_group_id_for_project(
            tenant_id, related_project_id
        )
        if not group_id or group_id != related_group:
            return

        self.execute_query(
            """
            DELETE FROM apiome.api_identity_members
            WHERE tenant_id = %s AND group_id = %s AND project_id = %s
            """,
            (tenant_id, group_id, related_project_id),
        )
        self._dissolve_identity_group_if_small(tenant_id, group_id)

    def seed_identity_from_conversion_provenance(self, tenant_id: str) -> int:
        """Back-fill identity links from existing conversion provenance rows; return rows seeded."""
        query = """
            SELECT DISTINCT ON (cp.source_project_id, cp.target_project_id)
                   cp.source_project_id::text AS source_project_id,
                   cp.target_project_id::text AS target_project_id
            FROM apiome.conversion_provenance cp
            WHERE cp.tenant_id = %s
              AND cp.source_project_id IS NOT NULL
            ORDER BY cp.source_project_id, cp.target_project_id, cp.created_at DESC
        """
        rows = self.execute_query(query, (tenant_id,))
        seeded = 0
        for row in rows:
            source_id = row.get("source_project_id")
            target_id = row.get("target_project_id")
            if not source_id or not target_id:
                continue
            before_a = self.get_identity_group_id_for_project(tenant_id, source_id)
            before_b = self.get_identity_group_id_for_project(tenant_id, target_id)
            self.link_identity_projects(
                tenant_id=tenant_id,
                project_id_a=source_id,
                project_id_b=target_id,
                created_by=None,
                link_source="conversion",
            )
            after_a = self.get_identity_group_id_for_project(tenant_id, source_id)
            after_b = self.get_identity_group_id_for_project(tenant_id, target_id)
            if (not before_a and after_a) or (not before_b and after_b):
                seeded += 1
        return seeded

    def get_project_identity_profile(
        self, tenant_id: str, project_id: str
    ) -> Optional[Dict[str, Any]]:
        """Latest format/identity coordinates for one project (MFI-6.4 suggestions anchor)."""
        query = """
            SELECT p.id::text AS project_id, p.name, p.slug, p.publishable,
                   cv.source_format, cv.protocol, cv.format_metadata,
                   aa.identity_name, aa.identity_namespace
            FROM apiome.projects p
            LEFT JOIN LATERAL (
                SELECT v.source_format, v.protocol, v.format_metadata
                FROM apiome.versions v
                WHERE v.project_id = p.id AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC NULLS LAST, v.id DESC
                LIMIT 1
            ) cv ON TRUE
            LEFT JOIN LATERAL (
                SELECT a.identity_name, a.identity_namespace
                FROM apiome.api_artifacts a
                JOIN apiome.versions v ON v.id = a.version_id
                WHERE v.project_id = p.id AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC NULLS LAST, v.id DESC
                LIMIT 1
            ) aa ON TRUE
            WHERE p.tenant_id = %s AND p.id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(query, (tenant_id, project_id))
        return rows[0] if rows else None

    def get_identity_suggestion_candidates(
        self, tenant_id: str, project_id: str, *, limit: int = 20
    ) -> List[Dict[str, Any]]:
        """Return tenant projects that are not already grouped with ``project_id``."""
        query = """
            SELECT p.id::text AS project_id, p.name, p.slug, p.publishable,
                   cv.source_format, cv.protocol, cv.format_metadata,
                   aa.identity_name, aa.identity_namespace
            FROM apiome.projects p
            LEFT JOIN LATERAL (
                SELECT v.source_format, v.protocol, v.format_metadata
                FROM apiome.versions v
                WHERE v.project_id = p.id AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC NULLS LAST, v.id DESC
                LIMIT 1
            ) cv ON TRUE
            LEFT JOIN LATERAL (
                SELECT a.identity_name, a.identity_namespace
                FROM apiome.api_artifacts a
                JOIN apiome.versions v ON v.id = a.version_id
                WHERE v.project_id = p.id AND v.deleted_at IS NULL
                ORDER BY v.created_at DESC NULLS LAST, v.id DESC
                LIMIT 1
            ) aa ON TRUE
            WHERE p.tenant_id = %s
              AND p.deleted_at IS NULL
              AND p.id <> %s::uuid
              AND NOT EXISTS (
                  SELECT 1
                  FROM apiome.api_identity_members anchor
                  JOIN apiome.api_identity_members peer
                    ON peer.tenant_id = anchor.tenant_id
                   AND peer.group_id = anchor.group_id
                   AND peer.project_id = p.id
                  WHERE anchor.tenant_id = %s
                    AND anchor.project_id = %s::uuid
              )
            ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC
            LIMIT %s
        """
        return self.execute_query(
            query, (tenant_id, project_id, tenant_id, project_id, limit)
        )

    def get_operation_keys_for_project(
        self, tenant_id: str, project_id: str
    ) -> List[str]:
        """Distinct canonical operation keys for the project's latest revision."""
        query = """
            SELECT DISTINCT o.key
            FROM apiome.api_operations o
            JOIN apiome.api_services s ON s.id = o.service_id
            JOIN apiome.api_artifacts a ON a.id = s.artifact_id
            JOIN apiome.versions v ON v.id = a.version_id
            JOIN apiome.projects p ON p.id = v.project_id
            WHERE p.tenant_id = %s AND p.id = %s::uuid
              AND v.deleted_at IS NULL AND o.key IS NOT NULL
        """
        rows = self.execute_query(query, (tenant_id, project_id))
        return [str(r["key"]) for r in rows if r.get("key")]

    def persist_canonical_api(
        self,
        *,
        tenant_id: str,
        creator_id: str,
        version_id: str,
        model: Any,
    ) -> str:
        """Soft-delete any live artifact and insert ``model`` (REPO-3.3 / #2772)."""
        from .canonical_persistence import persist_canonical_api as _persist

        return _persist(
            self,
            tenant_id=tenant_id,
            creator_id=creator_id,
            version_id=version_id,
            model=model,
        )

    def load_canonical_api(
        self, *, tenant_id: str, version_id: str
    ) -> Optional[Any]:
        """Load the live canonical artifact for ``version_id``, or ``None``."""
        from .canonical_persistence import load_canonical_api as _load

        return _load(self, tenant_id=tenant_id, version_id=version_id)

    def create_version_push_transaction(
        self,
        project_id: str,
        tenant_id: str,
        creator_id: Optional[str],
        version_id: str,
        description: Optional[str],
        change_log: Optional[str],
        commit_author: Optional[str],
        commit_message: Optional[str],
        external_ref: Optional[str],
        parent_version_id: Optional[str],
        source_version_id: Optional[str],
        branch_row: Optional[Dict[str, Any]],
        client_base_revision_id: str,
        source_commit_sha: Optional[str] = None,
        source_committed_at: Optional[Any] = None,
    ) -> Tuple[Dict[str, Any], int]:
        """
        Insert version (optional parent), copy classes from source, advance branch tip under lock.

        ``source_commit_sha`` / ``source_committed_at`` record RAR-4.2 refresh
        provenance on the new revision (the repository source commit that produced it).
        Returns (full version row from get_version_by_id, copied_class_count).
        """
        base = (client_base_revision_id or "").strip()
        src = (source_version_id or "").strip() or None
        conn = self.connect()
        copied_count = 0
        new_id: Optional[str] = None
        prev_autocommit = self._begin_tx(conn)
        no_prior_revision = False
        try:
            with conn.cursor() as cursor:
                if branch_row is not None:
                    bid = str(branch_row["id"])
                    cursor.execute(
                        """
                        SELECT b.id, b.tip_version_id, b.require_merge_path
                        FROM apiome.version_branches b
                        JOIN apiome.projects p ON b.project_id = p.id
                        WHERE b.id = %s AND b.project_id = %s AND p.tenant_id = %s
                        FOR UPDATE
                        """,
                        (bid, project_id, tenant_id),
                    )
                    locked = cursor.fetchone()
                    if not locked:
                        raise BranchNotFoundError(bid)
                    if str(locked["tip_version_id"]) != base:
                        raise StaleHeadPushError(str(locked["tip_version_id"]))
                else:
                    # No named branches: lock the project row to serialize concurrent no-branch
                    # pushes and re-verify the head under the lock (TOCTOU fix, #2566).
                    cursor.execute(
                        """
                        SELECT p.id FROM apiome.projects p
                        WHERE p.id = %s AND p.tenant_id = %s
                        FOR UPDATE
                        """,
                        (project_id, tenant_id),
                    )
                    if not cursor.fetchone():
                        raise ValueError("Project not found or not accessible")
                    cursor.execute(
                        """
                        SELECT v.id::text AS id
                        FROM apiome.versions v
                        WHERE v.project_id = %s AND v.deleted_at IS NULL
                        ORDER BY v.created_at DESC
                        LIMIT 1
                        """,
                        (project_id,),
                    )
                    head_row = cursor.fetchone()
                    current_tip: Optional[str] = str(head_row["id"]) if head_row else None
                    no_prior_revision = current_tip is None
                    if current_tip is None and base:
                        raise ValueError("baseRevisionId must be empty for projects with no existing revisions")
                    if current_tip is not None and base != current_tip:
                        raise StaleHeadPushError(current_tip)

                cursor.execute(
                    """
                    INSERT INTO apiome.versions
                    (project_id, creator_id, version_id, description, change_log,
                     commit_author, commit_message, external_ref, parent_version_id,
                     source_commit_sha, source_committed_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        project_id,
                        creator_id,
                        version_id,
                        description,
                        change_log,
                        commit_author,
                        commit_message,
                        external_ref,
                        parent_version_id,
                        source_commit_sha,
                        source_committed_at,
                    ),
                )
                row = cursor.fetchone()
                if not row or row.get("id") is None:
                    raise ValueError("Failed to insert version")
                new_id = str(row["id"])

                if src:
                    copied_count = self.copy_classes_from_version_for_merge(cursor, src, new_id)

                if branch_row is not None:
                    cursor.execute(
                        """
                        UPDATE apiome.version_branches
                        SET tip_version_id = %s, updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                        """,
                        (new_id, str(branch_row["id"])),
                    )
                elif no_prior_revision:
                    # First commit in a brand-new project: bootstrap a default main branch (#2727).
                    cursor.execute(
                        """
                        INSERT INTO apiome.version_branches
                            (project_id, name, tip_version_id, created_by, branched_from_revision_id,
                             is_default, require_merge_path)
                        VALUES (%s, 'main', %s, %s, %s, true, true)
                        ON CONFLICT (project_id, name)
                        DO UPDATE SET
                            tip_version_id = EXCLUDED.tip_version_id,
                            is_default = true,
                            require_merge_path = true,
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        (project_id, new_id, creator_id, new_id),
                    )

            conn.commit()
        except (StaleHeadPushError, BranchNotFoundError):
            conn.rollback()
            raise
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

        if not new_id:
            raise ValueError("create_version_push_transaction: missing new id")

        full = self.get_version_by_id(new_id, tenant_id)
        if not full:
            raise ValueError("Version created but could not be loaded")
        return full, copied_count

    _MERGE_SESSION_TRANSITIONS: Dict[str, Set[str]] = {
        "preview": {"resolving", "aborted"},
        "resolving": {"applied", "aborted"},
        "applied": set(),
        "aborted": set(),
    }

    def _merge_session_project_scope(
        self, merge_session_id: str, project_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        q = """
            SELECT ms.id, ms.project_id, ms.source_branch_id, ms.source_branch_name, ms.target_branch_name,
                   ms.merge_base_version_id, ms.source_tip_version_id, ms.target_tip_version_id,
                   ms.status, ms.created_by, ms.created_at, ms.updated_at
            FROM apiome.merge_sessions ms
            JOIN apiome.projects p ON ms.project_id = p.id
            WHERE ms.id = %s AND ms.project_id = %s AND p.tenant_id = %s AND p.deleted_at IS NULL
        """
        rows = self.execute_query(q, (merge_session_id, project_id, tenant_id))
        return dict(rows[0]) if rows else None

    def create_merge_session_for_preview(
        self,
        project_id: str,
        tenant_id: str,
        source_branch_name: str,
        target_branch_name: str,
        source_branch_id: Optional[str],
        merge_base_version_id: str,
        source_tip_version_id: str,
        target_tip_version_id: str,
        conflict_records: List[Dict[str, Any]],
        created_by: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        """
        Insert merge session in ``preview``, conflict rows, and initial status event (#2573).
        """
        proj = self.get_project_by_id(project_id, tenant_id)
        if not proj:
            return None

        conn = self.connect()
        session_row: Optional[Dict[str, Any]] = None
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.merge_sessions (
                        project_id, source_branch_id, source_branch_name, target_branch_name,
                        merge_base_version_id, source_tip_version_id, target_tip_version_id,
                        status, created_by
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, 'preview', %s)
                    RETURNING id, project_id, source_branch_id, source_branch_name, target_branch_name,
                              merge_base_version_id, source_tip_version_id, target_tip_version_id,
                              status, created_by, created_at, updated_at
                    """,
                    (
                        project_id,
                        source_branch_id,
                        source_branch_name.strip(),
                        target_branch_name.strip(),
                        merge_base_version_id,
                        source_tip_version_id,
                        target_tip_version_id,
                        created_by,
                    ),
                )
                session_row = dict(cursor.fetchone() or {})
                sid = str(session_row["id"])

                for i, rec in enumerate(conflict_records):
                    path = (rec.get("path") or "").strip()
                    kinds = rec.get("kinds") or []
                    if not path:
                        continue
                    cursor.execute(
                        """
                        INSERT INTO apiome.merge_session_conflicts (merge_session_id, path, kinds, sort_order)
                        VALUES (%s, %s, %s::jsonb, %s)
                        """,
                        (sid, path, Json(kinds), i),
                    )

                cursor.execute(
                    """
                    INSERT INTO apiome.merge_session_status_events (merge_session_id, from_status, to_status, changed_by)
                    VALUES (%s, NULL, 'preview', %s)
                    """,
                    (sid, created_by),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            _logger.exception(
                "create_merge_session_for_preview failed project_id=%s tenant_id=%s",
                project_id,
                tenant_id,
            )
            return None

        return session_row

    def get_merge_session_detail(
        self, merge_session_id: str, project_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Session row plus ordered status events for the same project/tenant (#2573)."""
        base = self._merge_session_project_scope(merge_session_id, project_id, tenant_id)
        if not base:
            return None
        ev = self.execute_query(
            """
            SELECT id, from_status, to_status, changed_by, changed_at
            FROM apiome.merge_session_status_events
            WHERE merge_session_id = %s
            ORDER BY changed_at ASC, id ASC
            """,
            (merge_session_id,),
        )
        return {"session": base, "status_events": [dict(r) for r in ev]}

    def list_merge_session_conflicts(
        self, merge_session_id: str, project_id: str, tenant_id: str
    ) -> Optional[List[Dict[str, Any]]]:
        if not self._merge_session_project_scope(merge_session_id, project_id, tenant_id):
            return None
        rows = self.execute_query(
            """
            SELECT id, path, kinds, sort_order, created_at
            FROM apiome.merge_session_conflicts
            WHERE merge_session_id = %s
            ORDER BY sort_order ASC, path ASC
            """,
            (merge_session_id,),
        )
        return [dict(r) for r in rows]

    def update_merge_session_status(
        self,
        merge_session_id: str,
        project_id: str,
        tenant_id: str,
        new_status: str,
        changed_by: Optional[str],
    ) -> Tuple[bool, Optional[str]]:
        """
        Validated transition; returns (ok, error_message).
        """
        ns = (new_status or "").strip()
        if ns not in self._MERGE_SESSION_TRANSITIONS:
            return False, f"Invalid status: {new_status}"

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                # Lock the row for this transaction to prevent concurrent status changes.
                cursor.execute(
                    """
                    SELECT ms.status
                    FROM apiome.merge_sessions ms
                    JOIN apiome.projects p ON ms.project_id = p.id
                    WHERE ms.id = %s AND ms.project_id = %s AND p.tenant_id = %s AND p.deleted_at IS NULL
                    FOR UPDATE
                    """,
                    (merge_session_id, project_id, tenant_id),
                )
                row = cursor.fetchone()
                if not row:
                    conn.rollback()
                    return False, "Merge session not found"

                cur_status = str(row["status"])
                allowed = self._MERGE_SESSION_TRANSITIONS.get(cur_status, set())
                if ns not in allowed:
                    conn.rollback()
                    return False, f"Cannot transition from {cur_status} to {ns}"

                cursor.execute(
                    """
                    UPDATE apiome.merge_sessions
                    SET status = %s, updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND project_id = %s AND status = %s
                    """,
                    (ns, merge_session_id, project_id, cur_status),
                )
                if cursor.rowcount == 0:
                    conn.rollback()
                    return False, f"Cannot transition from {cur_status} to {ns}"

                cursor.execute(
                    """
                    INSERT INTO apiome.merge_session_status_events (merge_session_id, from_status, to_status, changed_by)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (merge_session_id, cur_status, ns, changed_by),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            _logger.exception("update_merge_session_status failed merge_session_id=%s", merge_session_id)
            return False, "Database error updating merge session"

        return True, None

    def _draft_lock_version_row_for_update(
        self, cursor, tenant_id: str, project_id: str, version_record_id: str
    ) -> Optional[Dict[str, Any]]:
        """Lock the version row; return id and published, or None if not found."""
        cursor.execute(
            """
            SELECT v.id::text AS id, v.published
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.id = %s::uuid AND v.project_id = %s AND p.tenant_id = %s
              AND v.deleted_at IS NULL
            FOR UPDATE OF v
            """,
            (version_record_id, project_id, tenant_id),
        )
        return cursor.fetchone()

    def _draft_lock_expires_active(self, exp: Any) -> bool:
        from datetime import timezone

        if exp is None:
            return False
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)

        rows = self.execute_query(
            """
            SELECT CURRENT_TIMESTAMP AS current_timestamp
            """
        )
        db_now = rows[0]["current_timestamp"] if rows else None
        if db_now is None:
            return False
        if db_now.tzinfo is None:
            db_now = db_now.replace(tzinfo=timezone.utc)
        return exp > db_now

    def get_version_draft_lock_status(
        self,
        tenant_id: str,
        project_id: str,
        version_record_id: str,
    ) -> Dict[str, Any]:
        """
        Read-only draft lock state for polling (#2585).

        Returns:
            ``{active: False}`` when no row, version missing, published, no lock, or lock expired.
            ``{active: True, version_id, owner_user_id, expires_at}`` when a lock is active.
        """
        rows = self.execute_query(
            """
            SELECT v.id::text AS version_id, v.published,
                   l.owner_user_id::text AS owner_user_id, l.expires_at
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            LEFT JOIN apiome.version_draft_lock l ON l.version_id = v.id
            WHERE v.id = %s::uuid AND v.project_id = %s AND p.tenant_id = %s
              AND v.deleted_at IS NULL
            """,
            (version_record_id, project_id, tenant_id),
        )
        if not rows:
            return {"active": False}
        row = rows[0]
        if row.get("published"):
            return {"active": False}
        ouid = row.get("owner_user_id")
        exp = row.get("expires_at")
        if not ouid or exp is None:
            return {"active": False}
        if not self._draft_lock_expires_active(exp):
            return {"active": False}
        return {
            "active": True,
            "version_id": str(row["version_id"]),
            "owner_user_id": ouid,
            "expires_at": exp,
        }

    def acquire_version_draft_lock(
        self,
        tenant_id: str,
        project_id: str,
        version_record_id: str,
        user_id: str,
        lease_seconds: int,
    ) -> Dict[str, Any]:
        """
        Acquire or refresh a draft edit lock on an unpublished revision.

        Returns:
            ``{kind: 'ok', version_id, owner_user_id, expires_at}`` on success.
            ``{kind: 'conflict', owner_user_id, expires_at}`` when another user holds an active lock.

        Raises:
            ValueError: ``version_not_found`` or ``published_version``.
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                vrow = self._draft_lock_version_row_for_update(
                    cursor, tenant_id, project_id, version_record_id
                )
                if not vrow:
                    conn.rollback()
                    raise ValueError("version_not_found")
                if vrow.get("published"):
                    conn.rollback()
                    raise ValueError("published_version")

                vid = str(vrow["id"])
                cursor.execute(
                    """
                    SELECT owner_user_id::text AS owner_user_id, expires_at
                    FROM apiome.version_draft_lock
                    WHERE version_id = %s::uuid
                    FOR UPDATE
                    """,
                    (vid,),
                )
                lock_row = cursor.fetchone()

                if not lock_row:
                    cursor.execute(
                        """
                        INSERT INTO apiome.version_draft_lock
                          (version_id, owner_user_id, expires_at, updated_at)
                        VALUES (
                          %s::uuid, %s::uuid,
                          NOW() + (%s * INTERVAL '1 second'),
                          CURRENT_TIMESTAMP
                        )
                        RETURNING owner_user_id::text AS owner_user_id, expires_at
                        """,
                        (vid, user_id, lease_seconds),
                    )
                    out = cursor.fetchone()
                    conn.commit()
                    return {
                        "kind": "ok",
                        "version_id": vid,
                        "owner_user_id": str(out["owner_user_id"]),
                        "expires_at": out["expires_at"],
                    }

                owner = str(lock_row["owner_user_id"])
                exp = lock_row["expires_at"]
                active = self._draft_lock_expires_active(exp)

                if not active:
                    cursor.execute(
                        """
                        UPDATE apiome.version_draft_lock
                        SET owner_user_id = %s::uuid,
                            expires_at = NOW() + (%s * INTERVAL '1 second'),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE version_id = %s::uuid
                        RETURNING owner_user_id::text AS owner_user_id, expires_at
                        """,
                        (user_id, lease_seconds, vid),
                    )
                    out = cursor.fetchone()
                    conn.commit()
                    return {
                        "kind": "ok",
                        "version_id": vid,
                        "owner_user_id": str(out["owner_user_id"]),
                        "expires_at": out["expires_at"],
                    }

                if owner == user_id:
                    cursor.execute(
                        """
                        UPDATE apiome.version_draft_lock
                        SET expires_at = NOW() + (%s * INTERVAL '1 second'),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE version_id = %s::uuid
                        RETURNING owner_user_id::text AS owner_user_id, expires_at
                        """,
                        (lease_seconds, vid),
                    )
                    out = cursor.fetchone()
                    conn.commit()
                    return {
                        "kind": "ok",
                        "version_id": vid,
                        "owner_user_id": str(out["owner_user_id"]),
                        "expires_at": out["expires_at"],
                    }

                conn.rollback()
                return {
                    "kind": "conflict",
                    "owner_user_id": owner,
                    "expires_at": exp,
                }
        except ValueError:
            raise
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.autocommit = prev_autocommit

    def renew_version_draft_lock(
        self,
        tenant_id: str,
        project_id: str,
        version_record_id: str,
        user_id: str,
        lease_seconds: int,
    ) -> Dict[str, Any]:
        """
        Extend an active draft lock held by the same user.

        Returns:
            ``{kind: 'ok', ...}``, ``{kind: 'not_held'}``, or
            ``{kind: 'conflict', owner_user_id, expires_at}``.

        Raises:
            ValueError: ``version_not_found`` or ``published_version``.
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                vrow = self._draft_lock_version_row_for_update(
                    cursor, tenant_id, project_id, version_record_id
                )
                if not vrow:
                    conn.rollback()
                    raise ValueError("version_not_found")
                if vrow.get("published"):
                    conn.rollback()
                    raise ValueError("published_version")

                vid = str(vrow["id"])
                cursor.execute(
                    """
                    SELECT owner_user_id::text AS owner_user_id, expires_at
                    FROM apiome.version_draft_lock
                    WHERE version_id = %s::uuid
                    FOR UPDATE
                    """,
                    (vid,),
                )
                lock_row = cursor.fetchone()
                if not lock_row:
                    conn.rollback()
                    return {"kind": "not_held"}

                if not self._draft_lock_expires_active(lock_row["expires_at"]):
                    conn.rollback()
                    return {"kind": "not_held"}

                owner = str(lock_row["owner_user_id"])
                if owner != user_id:
                    conn.rollback()
                    return {
                        "kind": "conflict",
                        "owner_user_id": owner,
                        "expires_at": lock_row["expires_at"],
                    }

                cursor.execute(
                    """
                    UPDATE apiome.version_draft_lock
                    SET expires_at = NOW() + (%s * INTERVAL '1 second'),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE version_id = %s::uuid AND owner_user_id = %s::uuid
                    RETURNING owner_user_id::text AS owner_user_id, expires_at
                    """,
                    (lease_seconds, vid, user_id),
                )
                out = cursor.fetchone()
                conn.commit()
                return {
                    "kind": "ok",
                    "version_id": vid,
                    "owner_user_id": str(out["owner_user_id"]),
                    "expires_at": out["expires_at"],
                }
        except ValueError:
            raise
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.autocommit = prev_autocommit

    def release_version_draft_lock(
        self,
        tenant_id: str,
        project_id: str,
        version_record_id: str,
        user_id: str,
    ) -> str:
        """
        Release a draft lock held by ``user_id``.

        Returns:
            ``released``, ``not_found`` (no lock row), or ``forbidden`` (another user holds the lock).
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                vrow = self._draft_lock_version_row_for_update(
                    cursor, tenant_id, project_id, version_record_id
                )
                if not vrow:
                    conn.rollback()
                    raise ValueError("version_not_found")

                vid = str(vrow["id"])
                cursor.execute(
                    """
                    DELETE FROM apiome.version_draft_lock
                    WHERE version_id = %s::uuid AND owner_user_id = %s::uuid
                    RETURNING version_id
                    """,
                    (vid, user_id),
                )
                if cursor.fetchone():
                    conn.commit()
                    return "released"

                cursor.execute(
                    """
                    SELECT 1 FROM apiome.version_draft_lock
                    WHERE version_id = %s::uuid
                    LIMIT 1
                    """,
                    (vid,),
                )
                if not cursor.fetchone():
                    conn.commit()
                    return "not_found"

                conn.rollback()
                return "forbidden"
        except ValueError:
            raise
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.autocommit = prev_autocommit

    def force_release_version_draft_lock(
        self,
        tenant_id: str,
        project_id: str,
        version_record_id: str,
    ) -> bool:
        """
        Remove any draft lock on the revision (tenant-admin force release).

        Returns:
            True if a lock row was deleted.

        Raises:
            ValueError: ``version_not_found``.
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                vrow = self._draft_lock_version_row_for_update(
                    cursor, tenant_id, project_id, version_record_id
                )
                if not vrow:
                    conn.rollback()
                    raise ValueError("version_not_found")

                vid = str(vrow["id"])
                cursor.execute(
                    """
                    DELETE FROM apiome.version_draft_lock
                    WHERE version_id = %s::uuid
                    RETURNING version_id
                    """,
                    (vid,),
                )
                deleted = cursor.fetchone() is not None
                conn.commit()
                return deleted
        except ValueError:
            raise
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.autocommit = prev_autocommit

    @staticmethod
    def hash_webhook_signing_secret(plain: str) -> str:
        """Store bcrypt(SHA256(utf8(plain))) so long secrets are safe for bcrypt's 72-byte input limit."""
        digest = hashlib.sha256(plain.encode("utf-8")).digest()
        hashed = bcrypt.hashpw(digest, bcrypt.gensalt())
        return hashed.decode("ascii")

    def create_push_webhook_subscription(
        self,
        tenant_id: str,
        url: str,
        url_normalized: str,
        signing_secret_plain: str,
        active: bool = True,
        min_severity: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Insert a push webhook row; returns public fields only (no hash).

        Args:
            tenant_id: Owning tenant id.
            url: The webhook URL as provided by the caller.
            url_normalized: Canonical URL used for per-tenant duplicate detection.
            signing_secret_plain: Plaintext shared secret (stored hashed + encrypted).
            active: Whether deliveries are enabled.
            min_severity: Publish-event severity threshold (CTG-3.3, #4477):
                ``docs-only`` / ``non-breaking`` / ``breaking``, or ``None`` for
                no filter (every publish event is delivered).
        """
        secret_hash = self.hash_webhook_signing_secret(signing_secret_plain)
        secret_enc = encrypt_signing_secret(signing_secret_plain)
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.push_webhook_subscriptions
                      (tenant_id, url, url_normalized, active,
                       signing_secret_hash, signing_secret_encrypted, min_severity)
                    VALUES (%s::uuid, %s, %s, %s, %s, %s, %s)
                    RETURNING id, url, active, signing_secret_ref, min_severity, created_at, updated_at
                    """,
                    (tenant_id, url, url_normalized, active, secret_hash, secret_enc, min_severity),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)
        except Exception as e:
            conn.rollback()
            raise e

    def list_push_webhook_subscriptions(self, tenant_id: str) -> List[Dict[str, Any]]:
        q = """
            SELECT id, url, active, signing_secret_ref, min_severity, created_at, updated_at
            FROM apiome.push_webhook_subscriptions
            WHERE tenant_id = %s::uuid AND deleted_at IS NULL
            ORDER BY created_at DESC
        """
        return self.execute_query(q, (tenant_id,))

    def list_active_push_webhook_subscription_ids(self, tenant_id: str) -> List[str]:
        """Return the ids of every active (non-deleted) push-webhook subscription for a tenant.

        Used by the refresh-notification fan-out (RAR-5.4) to enqueue one delivery
        per subscribed channel. Inactive and soft-deleted subscriptions are excluded
        so a notification is never queued for a channel that cannot receive it.

        Args:
            tenant_id: Owning tenant id.

        Returns:
            A list of subscription id strings (possibly empty), newest first.
        """
        q = """
            SELECT id
            FROM apiome.push_webhook_subscriptions
            WHERE tenant_id = %s::uuid AND active = true AND deleted_at IS NULL
            ORDER BY created_at DESC
        """
        return [str(row["id"]) for row in self.execute_query(q, (tenant_id,))]

    def list_active_push_webhook_subscription_filters(
        self, tenant_id: str
    ) -> List[Dict[str, Any]]:
        """Return every active (non-deleted) subscription's id and severity filter.

        Used by the publish-event fan-out (CTG-3.3, #4477) to decide, per
        subscription, whether a ``version.published`` delivery meets the
        subscriber's ``min_severity`` threshold before enqueueing it.

        Args:
            tenant_id: Owning tenant id.

        Returns:
            A list of ``{"id": str, "min_severity": Optional[str]}`` dicts
            (possibly empty), newest first. ``min_severity`` is ``None`` when
            the subscription is unfiltered.
        """
        q = """
            SELECT id, min_severity
            FROM apiome.push_webhook_subscriptions
            WHERE tenant_id = %s::uuid AND active = true AND deleted_at IS NULL
            ORDER BY created_at DESC
        """
        return [
            {"id": str(row["id"]), "min_severity": row.get("min_severity")}
            for row in self.execute_query(q, (tenant_id,))
        ]

    def get_push_webhook_subscription(
        self, tenant_id: str, subscription_id: str
    ) -> Optional[Dict[str, Any]]:
        q = """
            SELECT id, url, active, signing_secret_ref, min_severity, created_at, updated_at
            FROM apiome.push_webhook_subscriptions
            WHERE tenant_id = %s::uuid AND id = %s::uuid AND deleted_at IS NULL
        """
        rows = self.execute_query(q, (tenant_id, subscription_id))
        return rows[0] if rows else None

    def update_push_webhook_subscription(
        self,
        tenant_id: str,
        subscription_id: str,
        url: Optional[str] = None,
        url_normalized: Optional[str] = None,
        active: Optional[bool] = None,
        signing_secret_plain: Optional[str] = None,
        min_severity: Optional[str] = None,
        update_min_severity: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """
        Update subscription fields. Returns public row or None if not found.
        Raises ValueError if no updatable fields were provided.

        ``min_severity`` is tri-state (unchanged / set / cleared), so it is only
        applied when ``update_min_severity`` is True; passing
        ``update_min_severity=True, min_severity=None`` clears the filter.
        """
        sets: List[str] = []
        params: List[Any] = []

        if url is not None and url_normalized is not None:
            sets.append("url = %s")
            sets.append("url_normalized = %s")
            params.extend([url, url_normalized])
        elif url is not None or url_normalized is not None:
            raise ValueError("url_and_normalized_together")

        if active is not None:
            sets.append("active = %s")
            params.append(active)

        if signing_secret_plain is not None:
            sets.append("signing_secret_hash = %s")
            params.append(self.hash_webhook_signing_secret(signing_secret_plain))
            sets.append("signing_secret_encrypted = %s")
            params.append(encrypt_signing_secret(signing_secret_plain))

        if update_min_severity:
            sets.append("min_severity = %s")
            params.append(min_severity)

        if not sets:
            raise ValueError("no_updates")

        sets.append("updated_at = CURRENT_TIMESTAMP")
        params.extend([tenant_id, subscription_id])

        q = f"""
            UPDATE apiome.push_webhook_subscriptions
            SET {", ".join(sets)}
            WHERE tenant_id = %s::uuid AND id = %s::uuid AND deleted_at IS NULL
            RETURNING id, url, active, signing_secret_ref, min_severity, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, tuple(params))
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def enqueue_push_webhook_delivery(
        self,
        tenant_id: str,
        subscription_id: str,
        event_type: str,
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Queue one outbound delivery. Raises ValueError if subscription is missing or inactive."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, active FROM apiome.push_webhook_subscriptions
                    WHERE tenant_id = %s::uuid AND id = %s::uuid AND deleted_at IS NULL
                    """,
                    (tenant_id, subscription_id),
                )
                sub = cursor.fetchone()
                if not sub:
                    raise ValueError("subscription_not_found")
                if not sub["active"]:
                    raise ValueError("subscription_inactive")
                cursor.execute(
                    """
                    INSERT INTO apiome.push_webhook_delivery_events
                      (tenant_id, subscription_id, event_type, payload, status, attempt_count, next_retry_at)
                    VALUES (%s::uuid, %s::uuid, %s, %s::jsonb, 'pending', 0, CURRENT_TIMESTAMP)
                    RETURNING id, tenant_id, subscription_id, event_type, status, attempt_count, next_retry_at, created_at
                    """,
                    (tenant_id, subscription_id, event_type, Json(payload)),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)
        except ValueError:
            conn.rollback()
            raise
        except Exception as e:
            conn.rollback()
            raise e

    def get_next_due_push_webhook_delivery(self) -> Optional[Dict[str, Any]]:
        """Atomically claim and return one due event joined with subscription URL and ciphertext, or None."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    WITH next_event AS (
                        SELECT e.id
                        FROM apiome.push_webhook_delivery_events e
                        INNER JOIN apiome.push_webhook_subscriptions s
                          ON s.id = e.subscription_id
                         AND s.deleted_at IS NULL
                        WHERE e.status IN ('pending', 'retrying')
                          AND e.next_retry_at IS NOT NULL
                          AND e.next_retry_at <= CURRENT_TIMESTAMP
                          AND e.attempt_count < %s
                        ORDER BY e.next_retry_at ASC
                        FOR UPDATE OF e SKIP LOCKED
                        LIMIT 1
                    ),
                    claimed_event AS (
                        UPDATE apiome.push_webhook_delivery_events e
                        SET status = 'processing',
                            updated_at = CURRENT_TIMESTAMP
                        FROM next_event ne
                        WHERE e.id = ne.id
                        RETURNING
                          e.id AS event_id,
                          e.tenant_id,
                          e.subscription_id,
                          e.event_type,
                          e.payload,
                          e.status AS event_status,
                          e.attempt_count,
                          e.next_retry_at
                    )
                    SELECT
                      ce.event_id,
                      ce.tenant_id,
                      ce.subscription_id,
                      ce.event_type,
                      ce.payload,
                      ce.event_status,
                      ce.attempt_count,
                      ce.next_retry_at,
                      s.url AS subscription_url,
                      s.active AS subscription_active,
                      s.signing_secret_encrypted
                    FROM claimed_event ce
                    INNER JOIN apiome.push_webhook_subscriptions s
                      ON s.id = ce.subscription_id
                     AND s.deleted_at IS NULL
                    """,
                    (WEBHOOK_MAX_DELIVERY_ATTEMPTS,),
                )
                row = cursor.fetchone()
                if row:
                    conn.commit()
                    return dict(row)
                conn.rollback()
                return None
        except Exception:
            conn.rollback()
            raise

    def finalize_push_webhook_delivery_attempt(
        self,
        event_id: str,
        *,
        attempt_number: int,
        http_status: Optional[int],
        response_body_preview: Optional[str],
        error_message: Optional[str],
        latency_ms: int,
        new_status: str,
        new_attempt_count: int,
        next_retry_at: Optional[datetime],
        last_error: Optional[str],
    ) -> None:
        """Insert one attempt row and update the parent event (single transaction)."""
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.push_webhook_delivery_attempts
                      (delivery_event_id, attempt_number, http_status, response_body_preview, error_message, latency_ms)
                    VALUES (%s::uuid, %s, %s, %s, %s, %s)
                    """,
                    (
                        event_id,
                        attempt_number,
                        http_status,
                        response_body_preview,
                        error_message,
                        latency_ms,
                    ),
                )
                cursor.execute(
                    """
                    UPDATE apiome.push_webhook_delivery_events
                    SET status = %s,
                        attempt_count = %s,
                        next_retry_at = %s,
                        last_error = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s::uuid
                    """,
                    (new_status, new_attempt_count, next_retry_at, last_error, event_id),
                )
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def list_push_webhook_dead_letter_events(self, tenant_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        q = """
            SELECT id, subscription_id, event_type, payload, attempt_count, last_error, created_at, updated_at
            FROM apiome.push_webhook_delivery_events
            WHERE tenant_id = %s::uuid AND status = 'dead_letter'
            ORDER BY updated_at DESC
            LIMIT %s
        """
        return self.execute_query(q, (tenant_id, limit))

    def get_push_webhook_delivery_event(self, tenant_id: str, event_id: str) -> Optional[Dict[str, Any]]:
        q = """
            SELECT id, subscription_id, event_type, payload, status, attempt_count, next_retry_at, last_error,
                   created_at, updated_at
            FROM apiome.push_webhook_delivery_events
            WHERE tenant_id = %s::uuid AND id = %s::uuid
        """
        rows = self.execute_query(q, (tenant_id, event_id))
        return dict(rows[0]) if rows else None

    def list_push_webhook_delivery_attempts(self, delivery_event_id: str) -> List[Dict[str, Any]]:
        q = """
            SELECT attempt_number, http_status, response_body_preview, error_message, latency_ms, attempted_at
            FROM apiome.push_webhook_delivery_attempts
            WHERE delivery_event_id = %s::uuid
            ORDER BY attempt_number ASC
        """
        return self.execute_query(q, (delivery_event_id,))

    def get_change_report_by_published_revision(
        self,
        published_revision_id: str,
        tenant_id: str,
        project_id: str,
    ) -> Optional[Dict[str, Any]]:
        q = """
            SELECT id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                   change_model_json, rendered_body, header_snapshot, footnote_snapshot,
                   edited_rendered_body, edited_header_snapshot, edited_footnote_snapshot,
                   edited_at, edited_by, template_version_id, rendered_at, regenerated_at,
                   created_at, updated_at
            FROM apiome.change_reports
            WHERE published_revision_id = %s::uuid
              AND tenant_id = %s::uuid
              AND project_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (published_revision_id, tenant_id, project_id))
        return dict(rows[0]) if rows else None

    def get_version_changelog(
        self,
        published_revision_id: str,
        tenant_id: str,
        project_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Return the persisted CTG-3.1 changelog row for a published revision, if any."""
        q = """
            SELECT id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                   changelog_json, max_severity, status, error, created_at, updated_at
            FROM apiome.version_changelogs
            WHERE published_revision_id = %s::uuid
              AND tenant_id = %s::uuid
              AND project_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (published_revision_id, tenant_id, project_id))
        return dict(rows[0]) if rows else None

    def upsert_version_changelog(
        self,
        *,
        tenant_id: str,
        project_id: str,
        published_revision_id: str,
        baseline_revision_id: Optional[str],
        changelog_json: Optional[Dict[str, Any]],
        max_severity: Optional[str],
        status: str,
        error: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Insert or replace the classified changelog for ``published_revision_id``.

        Retries and failure paths overwrite the prior row (ON CONFLICT DO UPDATE) so a
        ``failed`` row can become ``ready`` / ``initial`` on re-run.
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.version_changelogs (
                        tenant_id, project_id, published_revision_id, baseline_revision_id,
                        changelog_json, max_severity, status, error
                    ) VALUES (
                        %s::uuid, %s::uuid, %s::uuid, %s::uuid,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (published_revision_id) DO UPDATE SET
                        baseline_revision_id = EXCLUDED.baseline_revision_id,
                        changelog_json = EXCLUDED.changelog_json,
                        max_severity = EXCLUDED.max_severity,
                        status = EXCLUDED.status,
                        error = EXCLUDED.error,
                        updated_at = CURRENT_TIMESTAMP
                    RETURNING id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                              changelog_json, max_severity, status, error, created_at, updated_at
                    """,
                    (
                        tenant_id,
                        project_id,
                        published_revision_id,
                        baseline_revision_id,
                        Json(changelog_json) if changelog_json is not None else None,
                        max_severity,
                        status,
                        error,
                    ),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def list_projects_needing_changelog_backfill(
        self, *, limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Latest published revision per project that has no ``version_changelogs`` row yet.

        Returns rows with ``tenant_id``, ``tenant_slug``, ``project_id``, ``published_revision_id``.
        """
        lim_sql = ""
        params: List[Any] = []
        if limit is not None and int(limit) > 0:
            lim_sql = " LIMIT %s"
            params.append(int(limit))
        q = f"""
            WITH latest AS (
                SELECT DISTINCT ON (v.project_id)
                       v.id AS published_revision_id,
                       v.project_id,
                       p.tenant_id,
                       t.slug AS tenant_slug
                FROM apiome.versions v
                INNER JOIN apiome.projects p
                    ON v.project_id = p.id AND p.deleted_at IS NULL
                INNER JOIN apiome.tenants t
                    ON p.tenant_id = t.id AND t.deleted_at IS NULL
                WHERE v.deleted_at IS NULL
                  AND v.published = true
                ORDER BY v.project_id, v.published_at DESC NULLS LAST, v.created_at DESC
            )
            SELECT latest.tenant_id, latest.tenant_slug, latest.project_id,
                   latest.published_revision_id
            FROM latest
            LEFT JOIN apiome.version_changelogs vc
                ON vc.published_revision_id = latest.published_revision_id
            WHERE vc.id IS NULL
            ORDER BY latest.tenant_slug, latest.project_id
            {lim_sql}
        """
        return self.execute_query(q, tuple(params) if params else None)

    def list_version_changelogs_for_project(
        self,
        project_id: str,
        tenant_id: str,
        *,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Changelog summary rows for every published revision of a project (CTG-3.2, #4476).

        One row per published revision, newest publish first. Revisions that have no
        ``version_changelogs`` row yet (classification pending or pre-V178) still appear
        with NULL changelog columns so callers can render a "pending" state. The heavy
        ``changelog_json`` payload is reduced to its ``counts`` object; use
        :meth:`get_version_changelog` for full entries.

        Args:
            project_id: Owning project UUID.
            tenant_id: Authenticated tenant UUID.
            limit: Optional max rows (most recent first).

        Returns:
            Rows with ``published_revision_id``, ``version_label``, ``published_at``,
            ``baseline_revision_id``, ``baseline_version_label``, ``max_severity``,
            ``status``, ``error``, ``counts``, and ``updated_at``.
        """
        lim_sql = ""
        params: List[Any] = [tenant_id, project_id]
        if limit is not None and int(limit) > 0:
            lim_sql = " LIMIT %s"
            params.append(int(limit))
        q = f"""
            SELECT
                v.id::text AS published_revision_id,
                v.version_id AS version_label,
                v.published_at,
                vc.baseline_revision_id::text AS baseline_revision_id,
                bl.version_id AS baseline_version_label,
                vc.max_severity,
                vc.status,
                vc.error,
                vc.changelog_json -> 'counts' AS counts,
                vc.updated_at
            FROM apiome.versions v
            INNER JOIN apiome.projects p
                ON v.project_id = p.id
               AND p.tenant_id = %s::uuid
               AND p.deleted_at IS NULL
            LEFT JOIN apiome.version_changelogs vc
                ON vc.published_revision_id = v.id
            LEFT JOIN apiome.versions bl
                ON bl.id = vc.baseline_revision_id
            WHERE v.project_id = %s::uuid
              AND v.deleted_at IS NULL
              AND v.published IS TRUE
            ORDER BY v.published_at DESC NULLS LAST, v.created_at DESC
            {lim_sql}
        """
        return self.execute_query(q, tuple(params))

    def insert_change_report_if_absent(
        self,
        tenant_id: str,
        project_id: str,
        published_revision_id: str,
        baseline_revision_id: Optional[str],
        change_model_json: Dict[str, Any],
        rendered_body: Optional[str] = None,
        header_snapshot: Optional[str] = None,
        footnote_snapshot: Optional[str] = None,
        template_version_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Insert one row per published_revision_id or return the existing row unchanged
        (change_model_json is immutable after the first insert).
        """
        has_render = bool(
            rendered_body is not None or header_snapshot is not None or footnote_snapshot is not None
        )
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.change_reports (
                        tenant_id, project_id, published_revision_id, baseline_revision_id,
                        change_model_json, rendered_body, header_snapshot, footnote_snapshot,
                        template_version_id, rendered_at
                    ) VALUES (
                        %s::uuid, %s::uuid, %s::uuid, %s::uuid,
                        %s, %s, %s, %s, %s::uuid,
                        CASE WHEN %s THEN CURRENT_TIMESTAMP ELSE NULL END
                    )
                    ON CONFLICT (published_revision_id) DO NOTHING
                    RETURNING id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                              change_model_json, rendered_body, header_snapshot, footnote_snapshot,
                              edited_rendered_body, edited_header_snapshot, edited_footnote_snapshot,
                              edited_at, edited_by, template_version_id, rendered_at, regenerated_at,
                              created_at, updated_at
                    """,
                    (
                        tenant_id,
                        project_id,
                        published_revision_id,
                        baseline_revision_id,
                        Json(change_model_json),
                        rendered_body,
                        header_snapshot,
                        footnote_snapshot,
                        template_version_id if template_version_id else None,
                        has_render,
                    ),
                )
                row = cursor.fetchone()
                if row is None:
                    cursor.execute(
                        """
                        SELECT id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                               change_model_json, rendered_body, header_snapshot, footnote_snapshot,
                               edited_rendered_body, edited_header_snapshot, edited_footnote_snapshot,
                               edited_at, edited_by, template_version_id, rendered_at, regenerated_at,
                               created_at, updated_at
                        FROM apiome.change_reports
                        WHERE published_revision_id = %s::uuid
                          AND tenant_id = %s::uuid
                          AND project_id = %s::uuid
                        LIMIT 1
                        """,
                        (published_revision_id, tenant_id, project_id),
                    )
                    row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def patch_change_report_edits(
        self,
        published_revision_id: str,
        tenant_id: str,
        project_id: str,
        user_id: str,
        *,
        clear_edits: bool = False,
        set_edited_rendered_body: bool = False,
        edited_rendered_body: Optional[str] = None,
        set_edited_header: bool = False,
        edited_header_snapshot: Optional[str] = None,
        set_edited_footnote: bool = False,
        edited_footnote_snapshot: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Update user edit snapshots; missing *_was_set flags leave columns unchanged."""
        if clear_edits:
            q = """
                UPDATE apiome.change_reports
                SET edited_rendered_body = NULL,
                    edited_header_snapshot = NULL,
                    edited_footnote_snapshot = NULL,
                    edited_at = NULL,
                    edited_by = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE published_revision_id = %s::uuid
                  AND tenant_id = %s::uuid
                  AND project_id = %s::uuid
                RETURNING id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                          change_model_json, rendered_body, header_snapshot, footnote_snapshot,
                          edited_rendered_body, edited_header_snapshot, edited_footnote_snapshot,
                          edited_at, edited_by, template_version_id, rendered_at, regenerated_at,
                          created_at, updated_at
            """
            conn = self.connect()
            try:
                with conn.cursor() as cursor:
                    cursor.execute(q, (published_revision_id, tenant_id, project_id))
                    row = cursor.fetchone()
                    conn.commit()
                    return dict(row) if row else None
            except Exception as e:
                conn.rollback()
                raise e

        assignments: List[str] = []
        params: List[Any] = []
        if set_edited_rendered_body:
            assignments.append("edited_rendered_body = %s")
            params.append(edited_rendered_body)
        if set_edited_header:
            assignments.append("edited_header_snapshot = %s")
            params.append(edited_header_snapshot)
        if set_edited_footnote:
            assignments.append("edited_footnote_snapshot = %s")
            params.append(edited_footnote_snapshot)
        if not assignments:
            return self.get_change_report_by_published_revision(
                published_revision_id, tenant_id, project_id
            )

        assignments.append("edited_at = CURRENT_TIMESTAMP")
        assignments.append("edited_by = %s::uuid")
        params.append(user_id)
        assignments.append("updated_at = CURRENT_TIMESTAMP")
        params.extend([published_revision_id, tenant_id, project_id])

        q = f"""
            UPDATE apiome.change_reports
            SET {", ".join(assignments)}
            WHERE published_revision_id = %s::uuid
              AND tenant_id = %s::uuid
              AND project_id = %s::uuid
            RETURNING id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                      change_model_json, rendered_body, header_snapshot, footnote_snapshot,
                      edited_rendered_body, edited_header_snapshot, edited_footnote_snapshot,
                      edited_at, edited_by, template_version_id, rendered_at, regenerated_at,
                      created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, tuple(params))
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def apply_change_report_regeneration(
        self,
        published_revision_id: str,
        tenant_id: str,
        project_id: str,
        header_snapshot: str,
        rendered_body: str,
        footnote_snapshot: str,
        discard_user_edits: bool,
        template_version_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Re-run placeholder/template render: update rendered_* and regeneration timestamps."""
        if discard_user_edits:
            q = """
                UPDATE apiome.change_reports
                SET rendered_body = %s,
                    header_snapshot = %s,
                    footnote_snapshot = %s,
                    rendered_at = CURRENT_TIMESTAMP,
                    regenerated_at = CURRENT_TIMESTAMP,
                    edited_rendered_body = NULL,
                    edited_header_snapshot = NULL,
                    edited_footnote_snapshot = NULL,
                    edited_at = NULL,
                    edited_by = NULL,
                    template_version_id = COALESCE(%s::uuid, template_version_id),
                    updated_at = CURRENT_TIMESTAMP
                WHERE published_revision_id = %s::uuid
                  AND tenant_id = %s::uuid
                  AND project_id = %s::uuid
                RETURNING id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                          change_model_json, rendered_body, header_snapshot, footnote_snapshot,
                          edited_rendered_body, edited_header_snapshot, edited_footnote_snapshot,
                          edited_at, edited_by, template_version_id, rendered_at, regenerated_at,
                          created_at, updated_at
            """
            params = (
                rendered_body,
                header_snapshot,
                footnote_snapshot,
                template_version_id if template_version_id else None,
                published_revision_id,
                tenant_id,
                project_id,
            )
        else:
            q = """
                UPDATE apiome.change_reports
                SET rendered_body = %s,
                    header_snapshot = %s,
                    footnote_snapshot = %s,
                    rendered_at = CURRENT_TIMESTAMP,
                    regenerated_at = CURRENT_TIMESTAMP,
                    template_version_id = COALESCE(%s::uuid, template_version_id),
                    updated_at = CURRENT_TIMESTAMP
                WHERE published_revision_id = %s::uuid
                  AND tenant_id = %s::uuid
                  AND project_id = %s::uuid
                RETURNING id, tenant_id, project_id, published_revision_id, baseline_revision_id,
                          change_model_json, rendered_body, header_snapshot, footnote_snapshot,
                          edited_rendered_body, edited_header_snapshot, edited_footnote_snapshot,
                          edited_at, edited_by, template_version_id, rendered_at, regenerated_at,
                          created_at, updated_at
            """
            params = (
                rendered_body,
                header_snapshot,
                footnote_snapshot,
                template_version_id if template_version_id else None,
                published_revision_id,
                tenant_id,
                project_id,
            )
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, params)
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    # ==================== Change report templates (CR-03, #2701) ====================

    def ensure_system_change_report_template(self) -> None:
        """Insert bundled system template row if missing (well-known id + semver 1.0.0)."""
        from .change_report_default_templates import (
            DEFAULT_BODY_TEMPLATE,
            DEFAULT_FOOTNOTE_TEMPLATE,
            DEFAULT_HEADER_TEMPLATE,
            SYSTEM_TEMPLATE_ID,
            SYSTEM_TEMPLATE_SEMVER,
        )

        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO apiome.change_report_template_versions (
                        id, owner_tenant_id, semver, header_template, body_template, footnote_template
                    ) VALUES (%s::uuid, NULL, %s, %s, %s, %s)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    (
                        SYSTEM_TEMPLATE_ID,
                        SYSTEM_TEMPLATE_SEMVER,
                        DEFAULT_HEADER_TEMPLATE,
                        DEFAULT_BODY_TEMPLATE,
                        DEFAULT_FOOTNOTE_TEMPLATE,
                    ),
                )
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def get_change_report_template_version_by_id(self, template_id: str) -> Optional[Dict[str, Any]]:
        q = """
            SELECT id, owner_tenant_id, semver, header_template, body_template, footnote_template,
                   created_at, created_by
            FROM apiome.change_report_template_versions
            WHERE id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (template_id,))
        return dict(rows[0]) if rows else None

    def list_change_report_template_version_summaries(self, tenant_id: str) -> List[Dict[str, Any]]:
        q = """
            SELECT id, owner_tenant_id, semver, created_at
            FROM apiome.change_report_template_versions
            WHERE owner_tenant_id IS NULL OR owner_tenant_id = %s::uuid
            ORDER BY owner_tenant_id NULLS FIRST, semver ASC
        """
        return self.execute_query(q, (tenant_id,))

    def insert_change_report_template_version(
        self,
        tenant_id: str,
        semver: str,
        header_template: str,
        body_template: str,
        footnote_template: str,
        created_by: Optional[str],
    ) -> Dict[str, Any]:
        q = """
            INSERT INTO apiome.change_report_template_versions (
                owner_tenant_id, semver, header_template, body_template, footnote_template, created_by
            ) VALUES (%s::uuid, %s, %s, %s, %s, %s::uuid)
            RETURNING id, owner_tenant_id, semver, header_template, body_template, footnote_template,
                      created_at, created_by
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    q,
                    (
                        tenant_id,
                        semver,
                        header_template,
                        body_template,
                        footnote_template,
                        created_by if created_by else None,
                    ),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)
        except Exception as e:
            conn.rollback()
            raise e

    def set_tenant_change_report_template_version(
        self,
        tenant_id: str,
        template_version_id: Optional[str],
    ) -> None:
        q = """
            UPDATE apiome.tenants
            SET change_report_template_version_id = %s::uuid,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    q,
                    (template_version_id if template_version_id else None, tenant_id),
                )
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def get_tenant_change_report_template_version_id(self, tenant_id: str) -> Optional[str]:
        q = """
            SELECT change_report_template_version_id
            FROM apiome.tenants
            WHERE id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (tenant_id,))
        if not rows:
            return None
        v = rows[0].get("change_report_template_version_id")
        return str(v) if v is not None else None

    def get_external_auth_provider_for_user(self, linked_account_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        q = """
            SELECT id, user_id, provider, access_token
            FROM apiome.external_auth_providers
            WHERE id = %s::uuid AND user_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (linked_account_id, user_id))
        return dict(rows[0]) if rows else None

    def list_tenant_repositories(self, tenant_id: str) -> List[Dict[str, Any]]:
        q = """
            SELECT id, tenant_id, source, provider, clone_url, repository_full_name,
                   description, default_branch, visibility, status, created_at, updated_at,
                   linked_account_id, last_scanned_at, total_files, importable_count, branch_count,
                   refresh_interval_seconds, last_refreshed_at, auto_refresh_enabled
            FROM apiome.tenant_repositories
            WHERE tenant_id = %s::uuid AND deleted_at IS NULL
            ORDER BY created_at DESC
        """
        return self.execute_query(q, (tenant_id,))

    def get_tenant_repository(self, tenant_id: str, repository_id: str) -> Optional[Dict[str, Any]]:
        q = """
            SELECT id, tenant_id, source, provider, clone_url, repository_full_name,
                   description, default_branch, visibility, status, created_at, updated_at,
                   linked_account_id, last_scanned_at, total_files, importable_count, branch_count, created_by,
                   refresh_interval_seconds, last_refreshed_at, auto_refresh_enabled
            FROM apiome.tenant_repositories
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            LIMIT 1
        """
        rows = self.execute_query(q, (repository_id, tenant_id))
        return dict(rows[0]) if rows else None

    def list_due_repositories(
        self,
        *,
        floor_seconds: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Return repositories due for an auto-refresh sweep tick (RAR-3.1).

        A repository is due when it has never been refreshed
        (``last_refreshed_at IS NULL``) or when at least its effective interval
        has elapsed since the last tick. The effective interval is the per-repo
        ``refresh_interval_seconds`` clamped up to the global floor, so a
        too-aggressive per-repo cadence cannot defeat the floor. Soft-deleted
        repositories, those not in a scannable ``ready``/``error`` state, and those
        with ``auto_refresh_enabled = FALSE`` (the per-repo RAR-3.3 opt-out) are
        excluded. The recency comparison is done in the database against
        ``now()`` so it does not depend on application clock skew.

        The actual rescan + enqueue is the RAR-3.2 sweep; this is the
        due-selection primitive it iterates.

        Args:
            floor_seconds: The global minimum interval; per-repo values below it
                are treated as the floor. Defaults to
                ``settings.refresh_min_interval_seconds`` when omitted.

        Returns:
            Repository rows due for refresh, oldest ``last_refreshed_at`` first
            (NULLs — never refreshed — first) for fair scheduling.
        """
        from .config import settings
        from .repository_refresh_cadence import DEFAULT_MIN_REFRESH_INTERVAL_SECONDS

        floor = floor_seconds if floor_seconds is not None else settings.refresh_min_interval_seconds
        if floor < 1:
            floor = DEFAULT_MIN_REFRESH_INTERVAL_SECONDS

        q = """
            SELECT id, tenant_id, source, provider, clone_url, repository_full_name,
                   description, default_branch, visibility, status, created_at, updated_at,
                   linked_account_id, last_scanned_at, total_files, importable_count, branch_count,
                   refresh_interval_seconds, last_refreshed_at, auto_refresh_enabled
            FROM apiome.tenant_repositories
            WHERE deleted_at IS NULL
              AND status IN ('ready', 'error')
              AND auto_refresh_enabled = TRUE
              AND (
                last_refreshed_at IS NULL
                OR last_refreshed_at <= now() - make_interval(
                     secs => GREATEST(refresh_interval_seconds, %s)
                   )
              )
            ORDER BY last_refreshed_at ASC NULLS FIRST, created_at ASC
        """
        return self.execute_query(q, (floor,))

    def mark_repository_refreshed(self, repository_id: str) -> bool:
        """Advance a repository's ``last_refreshed_at`` to now (RAR-3.1).

        Called by the sweep at the end of each tick for a repository so the next
        due check is measured from this moment. Returns True when a live row was
        updated (False when the id is unknown or soft-deleted).

        Args:
            repository_id: The repository whose refresh anchor to advance.

        Returns:
            True when a row was updated.
        """
        q = """
            UPDATE apiome.tenant_repositories
            SET last_refreshed_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND deleted_at IS NULL
            RETURNING id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (repository_id,))
                row = cursor.fetchone()
                conn.commit()
                return bool(row)
        except Exception as e:
            conn.rollback()
            raise e

    def set_repository_refresh_interval(
        self,
        tenant_id: str,
        repository_id: str,
        interval_seconds: Optional[int],
    ) -> Optional[int]:
        """Set a repository's per-repo refresh cadence, clamped to the floor (RAR-3.1).

        The value is resolved through
        :func:`repository_refresh_cadence.resolve_refresh_interval` first, so a
        ``None``/non-positive value falls back to the configured default and a
        sub-floor value is clamped up (with a warning). The clamped value is what
        is persisted, so a later read needs no re-clamping.

        Args:
            tenant_id: Owning tenant id (scopes the update for isolation).
            repository_id: The repository to update.
            interval_seconds: The requested cadence in seconds, or None to reset
                to the configured default.

        Returns:
            The effective (clamped) interval that was stored, or None when no
            live repository matched the tenant + id.
        """
        from .config import settings
        from .repository_refresh_cadence import resolve_refresh_interval

        effective = resolve_refresh_interval(
            interval_seconds,
            floor_seconds=settings.refresh_min_interval_seconds,
            default_seconds=settings.refresh_default_interval_seconds,
        )
        q = """
            UPDATE apiome.tenant_repositories
            SET refresh_interval_seconds = %s,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            RETURNING id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (effective, repository_id, tenant_id))
                row = cursor.fetchone()
                conn.commit()
                return effective if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def set_repository_auto_refresh_enabled(
        self,
        tenant_id: str,
        repository_id: str,
        enabled: bool,
    ) -> Optional[bool]:
        """Set a repository's per-repo auto-refresh opt-out flag (RAR-3.3).

        When ``enabled`` is False the refresh sweep's due-selection
        (:meth:`list_due_repositories`) skips this repository, so it is never
        auto-refreshed. The global ``APIOME_REFRESH_ENABLED`` kill switch and
        manual "Refresh Now" (RAR-5.2) are independent of this flag.

        Args:
            tenant_id: Owning tenant id (scopes the update for isolation).
            repository_id: The repository to update.
            enabled: True to allow auto-refresh, False to opt this repo out.

        Returns:
            The stored value (``enabled``) when a live repository matched the
            tenant + id, or None when no row was updated.
        """
        q = """
            UPDATE apiome.tenant_repositories
            SET auto_refresh_enabled = %s,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            RETURNING id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (bool(enabled), repository_id, tenant_id))
                row = cursor.fetchone()
                conn.commit()
                return bool(enabled) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def try_acquire_repository_refresh_lock(self, repository_id: str) -> bool:
        """Try to take the per-repo auto-refresh advisory lock (RAR-3.2).

        Per-repo single-flight for the refresh sweep is enforced with a Postgres
        **session** advisory lock keyed on the repository id, so two workers (or
        two overlapping sweep ticks) never rescan and enqueue for the same repo at
        once. The lock is held on this :class:`Database`'s connection until
        :meth:`release_repository_refresh_lock` is called (or the connection
        closes); ``pg_try_advisory_lock`` is non-blocking, returning False
        immediately when another session holds it so the sweep can move on.

        Because the lock is session-scoped (not transaction-scoped), the
        ``execute_query`` commit here does not release it — acquire and release
        must run on the same connection, which the single-``Database``-per-tick
        sweep guarantees.

        Args:
            repository_id: The repository to serialize refreshes for.

        Returns:
            True when the lock was acquired, False when another session holds it.
        """
        rows = self.execute_query(
            "SELECT pg_try_advisory_lock(hashtext(%s)) AS locked",
            (f"repo-refresh:{repository_id}",),
        )
        return bool(rows and rows[0].get("locked"))

    def release_repository_refresh_lock(self, repository_id: str) -> None:
        """Release the per-repo auto-refresh advisory lock (RAR-3.2).

        Counterpart to :meth:`try_acquire_repository_refresh_lock`; must run on the
        same connection that acquired the lock. Safe to call even if the lock was
        not held (Postgres returns False and logs a warning, which is harmless).

        Args:
            repository_id: The repository whose lock to release.
        """
        self.execute_query(
            "SELECT pg_advisory_unlock(hashtext(%s)) AS unlocked",
            (f"repo-refresh:{repository_id}",),
        )

    def list_repository_import_spec_branches(self, repository_id: str) -> List[str]:
        """Distinct branches that have a stored import spec for this repository (RAR-3.2).

        The refresh sweep only needs to rescan branches that actually have
        imported files to refresh; a repository with no captured spec yields an
        empty list and the sweep skips the (rate-limited) GitHub walk entirely.

        Args:
            repository_id: The repository to inspect.

        Returns:
            Distinct branch names with at least one stored import spec, sorted.
        """
        q = """
            SELECT DISTINCT branch
            FROM apiome.repository_import_spec
            WHERE repository_id = %s::uuid
            ORDER BY branch ASC
        """
        rows = self.execute_query(q, (repository_id,))
        return [str(r["branch"]) for r in rows if r.get("branch")]

    def list_repository_refresh_candidates(
        self, repository_id: str, branch: str
    ) -> List[Dict[str, Any]]:
        """Stored specs joined to their current indexed file, for one branch (RAR-3.2).

        Returns one row per imported-file lineage that still exists in the latest
        scan index, pairing the stored import spec (project, source descriptor,
        options, and the ``last_imported_*`` recency anchors from RAR-2.1) with the
        file's current remote freshness signals (``remote_committed_at`` /
        ``remote_blob_sha`` / ``remote_commit_sha``) from the just-completed
        rescan. The sweep feeds each row to the RAR-2.2 newer-than comparator to
        decide whether to enqueue a re-import.

        The join is an INNER join on ``tenant_repository_files`` so a spec whose
        file no longer exists upstream (deleted file) is *not* a refresh candidate
        — handling deletions is out of scope here.

        Args:
            repository_id: The repository to scan candidates for.
            branch: The branch whose files were just re-indexed.

        Returns:
            Candidate rows with the spec fields and the current remote signals.
        """
        q = """
            SELECT s.id AS import_spec_id, s.tenant_id, s.repository_id, s.branch, s.path,
                   s.project_id, s.source_kind, s.format_override, s.content_type,
                   s.options_json, s.spec_schema_version, s.created_by,
                   s.last_imported_commit_sha, s.last_imported_committed_at,
                   s.last_imported_blob_sha,
                   trf.commit_sha AS remote_commit_sha,
                   trf.committed_at AS remote_committed_at,
                   trf.blob_sha AS remote_blob_sha
            FROM apiome.repository_import_spec s
            INNER JOIN apiome.tenant_repository_files trf
              ON trf.repository_id = s.repository_id
             AND trf.branch = s.branch
             AND trf.path = s.path
            WHERE s.repository_id = %s::uuid AND s.branch = %s
            ORDER BY s.path ASC
        """
        return self.execute_query(q, (repository_id, branch))

    def enqueue_repository_refresh_job(
        self,
        *,
        tenant_id: str,
        repository_id: str,
        branch: str,
        path: str,
        import_spec_id: Optional[str] = None,
        project_id: Optional[str] = None,
        source_kind: Optional[str] = None,
        format_override: Optional[str] = None,
        content_type: Optional[str] = None,
        options_json: Optional[Any] = None,
        spec_schema_version: int = 1,
        created_by: Optional[str] = None,
        remote_commit_sha: Optional[str] = None,
        remote_committed_at: Optional[Any] = None,
        remote_blob_sha: Optional[str] = None,
        refresh_reason: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Enqueue one spec-faithful re-import job for the EPIC-4 worker (RAR-3.2).

        Inserts a row into ``apiome.tenant_repository_refresh_jobs`` carrying a
        self-contained snapshot of the stored import spec (so the executor replays
        the user's original request even if the spec row later changes) plus the
        remote freshness signals that triggered it. The insert is idempotent at the
        file-lineage level via the partial unique index
        (``uq_tenant_repo_refresh_jobs_active_lineage``): if an active
        (queued/running) job already exists for ``(repository_id, branch, path)``
        the insert is a no-op and ``None`` is returned, so a repeated sweep tick
        never duplicates work.

        Args:
            tenant_id: Owning tenant id.
            repository_id: Source repository id.
            branch: Branch the file lives on.
            path: Repository-relative file path (lineage key).
            import_spec_id: Back-reference to the source spec row, if known.
            project_id: Catalog project the original import targeted.
            source_kind: Importer discriminator (for example ``openapi-3``).
            format_override: Explicit importer ``--format`` override, if any.
            content_type: MIME type used to read the file, if known.
            options_json: Snapshot of the full ``SpecImportOptions`` payload.
            spec_schema_version: Envelope version of the captured spec.
            created_by: User id that initiated the original import, if known.
            remote_commit_sha: Branch-tip commit SHA observed at sweep time.
            remote_committed_at: Committed-at of the observed commit.
            remote_blob_sha: Blob SHA of the file at sweep time.
            refresh_reason: Stable RAR-2.2 ``RefreshReason`` code for the enqueue.

        Returns:
            The inserted job row as a dict, or ``None`` when an active job already
            existed for the lineage (idempotent no-op).
        """
        import json

        if isinstance(options_json, str):
            options_text = options_json if options_json.strip() else "{}"
        else:
            options_text = json.dumps(options_json or {})

        q = """
            INSERT INTO apiome.tenant_repository_refresh_jobs (
                tenant_id, repository_id, import_spec_id, branch, path,
                project_id, source_kind, format_override, content_type,
                options_json, spec_schema_version, created_by,
                remote_commit_sha, remote_committed_at, remote_blob_sha, refresh_reason
            )
            VALUES (
                %s::uuid, %s::uuid, %s::uuid, %s, %s,
                %s::uuid, %s, %s, %s,
                %s::jsonb, %s, %s::uuid,
                %s, %s::timestamptz, %s, %s
            )
            ON CONFLICT (repository_id, branch, path)
                WHERE status IN ('queued', 'running')
            DO NOTHING
            RETURNING id, tenant_id, repository_id, import_spec_id, branch, path,
                      project_id, source_kind, format_override, content_type,
                      options_json, spec_schema_version, created_by,
                      remote_commit_sha, remote_committed_at, remote_blob_sha,
                      refresh_reason, status, created_at
        """
        params = (
            tenant_id, repository_id,
            (str(import_spec_id) if import_spec_id else None),
            branch, path,
            (str(project_id) if project_id else None),
            source_kind, format_override, content_type,
            options_text, spec_schema_version,
            (str(created_by) if created_by else None),
            remote_commit_sha, remote_committed_at, remote_blob_sha, refresh_reason,
        )
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, params)
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def list_tenant_repository_file_branches(self, tenant_id: str, repository_id: str) -> List[str]:
        """Distinct branch names that have indexed file rows for this repository."""
        q = """
            SELECT DISTINCT f.branch
            FROM apiome.tenant_repository_files f
            INNER JOIN apiome.tenant_repositories r ON r.id = f.repository_id
            WHERE r.tenant_id = %s::uuid AND r.id = %s::uuid AND r.deleted_at IS NULL
            ORDER BY f.branch ASC
        """
        rows = self.execute_query(q, (tenant_id, repository_id))
        return [str(r["branch"]) for r in rows if r.get("branch")]

    def get_tenant_repository_file_row(
        self, tenant_id: str, repository_id: str, file_id: str
    ) -> Optional[Dict[str, Any]]:
        """One indexed file joined to its repository row (tenant-scoped)."""
        q = """
            SELECT f.id, f.repository_id, f.branch, f.path, f.name, f.ext, f.size_bytes, f.blob_sha,
                   f.detected_kind,
                   r.provider, r.clone_url, r.repository_full_name, r.linked_account_id, r.created_by,
                   r.visibility
            FROM apiome.tenant_repository_files f
            INNER JOIN apiome.tenant_repositories r ON r.id = f.repository_id
            WHERE f.id = %s::uuid AND r.tenant_id = %s::uuid AND r.id = %s::uuid AND r.deleted_at IS NULL
            LIMIT 1
        """
        rows = self.execute_query(q, (file_id, tenant_id, repository_id))
        return dict(rows[0]) if rows else None

    def tenant_repository_files_stats_and_page(
        self,
        tenant_id: str,
        repository_id: str,
        branch: str,
        *,
        path_regex: Optional[str],
        like_patterns: Optional[List[str]],
        hide_non_importable: bool,
        skip_vendor: bool,
        include_hidden: bool,
        path_prefix: Optional[str],
        limit: int,
        offset: int,
    ) -> Optional[Dict[str, Any]]:
        """
        Return indexed totals for the branch, filtered counts, and one page of file rows.
        ``like_patterns`` entries are passed to ``path ILIKE ... ESCAPE '\\'`` (OR together).
        If ``path_regex`` is set, it replaces all LIKE path matching (POSIX ``~*``).
        """
        if not self.get_tenant_repository(tenant_id, repository_id):
            return None

        importable_sql = """(
          f.detected_kind IS NOT NULL AND (
            f.detected_kind ILIKE 'openapi%%' OR f.detected_kind ILIKE 'arazzo%%' OR
            f.detected_kind ILIKE 'asyncapi%%' OR f.detected_kind ILIKE 'graphql%%' OR
            f.detected_kind ILIKE 'protobuf%%' OR f.detected_kind ILIKE 'postman%%' OR
            f.detected_kind ILIKE 'prisma%%' OR f.detected_kind ILIKE 'sql-ddl%%' OR
            f.detected_kind ILIKE 'avro%%' OR f.detected_kind ILIKE 'dbml%%'
          )
        )"""

        from_sql = """
            FROM apiome.tenant_repository_files f
            INNER JOIN apiome.tenant_repositories r ON r.id = f.repository_id
            WHERE """

        base_parts = [
            "r.tenant_id = %s::uuid",
            "r.id = %s::uuid",
            "r.deleted_at IS NULL",
            "f.repository_id = r.id",
            "f.branch = %s",
        ]
        base_params: List[Any] = [tenant_id, repository_id, branch]

        extra_parts: List[str] = []
        extra_params: List[Any] = []
        if path_prefix:
            pp = path_prefix.strip().strip("/")
            if pp:
                extra_parts.append("(f.path = %s OR f.path LIKE %s)")
                extra_params.extend([pp, pp + "/%"])
        if skip_vendor:
            extra_parts.append(
                """(
          f.path NOT ILIKE '%%/node_modules/%%' AND f.path NOT ILIKE 'node_modules/%%' AND
          f.path NOT ILIKE '%%/vendor/%%' AND f.path NOT ILIKE 'vendor/%%' AND
          f.path NOT ILIKE '%%/.git/%%' AND f.path NOT ILIKE '.git/%%'
        )"""
            )
        if not include_hidden:
            extra_parts.append("f.path !~ '(^|/)\\.[^/]+(/|$)'")

        path_parts: List[str] = []
        path_params: List[Any] = []
        rx = (path_regex or "").strip()
        if rx:
            path_parts.append("f.path ~* %s")
            path_params.append(rx)
        else:
            pats = [p for p in (like_patterns or []) if p and str(p).strip()]
            if pats:
                ors = " OR ".join(["f.path ILIKE %s ESCAPE E'\\\\'"] * len(pats))
                path_parts.append("(" + ors + ")")
                path_params.extend(pats)

        idx_parts = base_parts + extra_parts
        idx_params = base_params + extra_params
        q_indexed = "SELECT COUNT(*) AS c " + from_sql + " AND ".join(idx_parts)
        indexed_rows = self.execute_query(q_indexed, tuple(idx_params))
        indexed_total = int(indexed_rows[0]["c"]) if indexed_rows else 0

        filt_parts = base_parts + extra_parts + path_parts
        filt_params = base_params + extra_params + path_params
        if hide_non_importable:
            filt_parts.append(importable_sql)

        where_f = " AND ".join(filt_parts)
        q_match = (
            "SELECT COUNT(*) AS c, COUNT(*) FILTER (WHERE "
            + importable_sql
            + ") AS ic "
            + from_sql
            + where_f
        )
        match_rows = self.execute_query(q_match, tuple(filt_params))
        match_count = int(match_rows[0]["c"]) if match_rows else 0
        importable_match = int(match_rows[0]["ic"]) if match_rows else 0

        lim = max(1, min(int(limit), 500))
        off = max(0, min(int(offset), 500_000))
        q_page = (
            "SELECT f.id, f.path, f.name, f.ext, f.size_bytes, f.blob_sha, f.detected_kind "
            + from_sql
            + where_f
            + " ORDER BY f.path ASC LIMIT %s OFFSET %s"
        )
        page_params = tuple(filt_params + [lim, off])
        rows = self.execute_query(q_page, page_params)

        return {
            "indexed_total": indexed_total,
            "match_count": match_count,
            "importable_match_count": importable_match,
            "limit": lim,
            "offset": off,
            "rows": rows,
        }

    def insert_tenant_repository(
        self,
        tenant_id: str,
        source: str,
        provider: str,
        clone_url: str,
        clone_url_normalized: str,
        repository_full_name: Optional[str],
        description: Optional[str],
        default_branch: str,
        visibility: Optional[str],
        status: str,
        created_by: Optional[str],
        linked_account_id: Optional[str] = None,
        branch_count: Optional[int] = None,
    ) -> Dict[str, Any]:
        q = """
            INSERT INTO apiome.tenant_repositories (
                tenant_id, source, provider, clone_url, clone_url_normalized,
                repository_full_name, description, default_branch, visibility, status, created_by,
                linked_account_id, branch_count
            ) VALUES (
                %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::uuid, %s::uuid, %s
            )
            RETURNING id, tenant_id, source, provider, clone_url, repository_full_name,
                      description, default_branch, visibility, status, created_at, updated_at,
                      linked_account_id, last_scanned_at, total_files, importable_count, branch_count
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    q,
                    (
                        tenant_id,
                        source,
                        provider,
                        clone_url,
                        clone_url_normalized,
                        repository_full_name,
                        description,
                        default_branch,
                        visibility,
                        status,
                        created_by if created_by else None,
                        linked_account_id if linked_account_id else None,
                        branch_count,
                    ),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)
        except Exception as e:
            conn.rollback()
            raise e

    def enqueue_repository_file_scan_job(self, tenant_id: str, repository_id: str, branch: str) -> str:
        q = """
            INSERT INTO apiome.tenant_repository_file_scan_jobs (tenant_id, repository_id, branch, status)
            VALUES (%s::uuid, %s::uuid, %s, 'queued')
            RETURNING id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (tenant_id, repository_id, branch))
                row = cursor.fetchone()
                conn.commit()
                return str(row["id"]) if row else ""
        except Exception as e:
            conn.rollback()
            raise e

    def claim_next_repository_file_scan_job(self) -> Optional[Dict[str, Any]]:
        q = """
            UPDATE apiome.tenant_repository_file_scan_jobs j
            SET status = 'running', started_at = CURRENT_TIMESTAMP
            FROM (
                SELECT id FROM apiome.tenant_repository_file_scan_jobs
                WHERE status = 'queued'
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            ) AS sub
            WHERE j.id = sub.id
            RETURNING j.id, j.tenant_id, j.repository_id, j.branch, j.status
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q)
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def replace_tenant_repository_files(
        self, repository_id: str, branch: str, files: List[Dict[str, Any]]
    ) -> None:
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    DELETE FROM apiome.tenant_repository_files
                    WHERE repository_id = %s::uuid AND branch = %s
                    """,
                    (repository_id, branch),
                )
                if files:
                    cursor.executemany(
                        """
                        INSERT INTO apiome.tenant_repository_files (
                            repository_id, branch, path, name, ext, size_bytes, blob_sha,
                            detected_kind, commit_sha, committed_at
                        ) VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz)
                        """,
                        [
                            (
                                repository_id,
                                branch,
                                f["path"],
                                f["name"],
                                f.get("ext"),
                                f.get("size_bytes"),
                                f.get("blob_sha"),
                                f.get("detected_kind"),
                                f.get("commit_sha"),
                                f.get("committed_at"),
                            )
                            for f in files
                        ],
                    )
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def update_tenant_repository_after_file_scan(
        self,
        tenant_id: str,
        repository_id: str,
        total_files: int,
        importable_count: int,
        status: str,
        touch_last_scanned_at: bool,
    ) -> None:
        if touch_last_scanned_at:
            q = """
                UPDATE apiome.tenant_repositories
                SET total_files = %s,
                    importable_count = %s,
                    status = %s,
                    last_scanned_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            """
            params = (total_files, importable_count, status, repository_id, tenant_id)
        else:
            q = """
                UPDATE apiome.tenant_repositories
                SET total_files = %s,
                    importable_count = %s,
                    status = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            """
            params = (total_files, importable_count, status, repository_id, tenant_id)
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, params)
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def mark_repository_file_scan_job_succeeded(self, job_id: str) -> None:
        q = """
            UPDATE apiome.tenant_repository_file_scan_jobs
            SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP, error_message = NULL
            WHERE id = %s::uuid
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (job_id,))
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def mark_repository_file_scan_job_failed(self, job_id: str, error_message: str) -> None:
        q = """
            UPDATE apiome.tenant_repository_file_scan_jobs
            SET status = 'failed', finished_at = CURRENT_TIMESTAMP, error_message = %s
            WHERE id = %s::uuid
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (error_message[:8000], job_id))
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def delete_tenant_repository(self, tenant_id: str, repository_id: str) -> bool:
        """Soft-delete a tenant repository (sets ``deleted_at``). Returns True if a row was updated."""
        q = """
            UPDATE apiome.tenant_repositories
            SET deleted_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            RETURNING id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (repository_id, tenant_id))
                row = cursor.fetchone()
                conn.commit()
                return bool(row)
        except Exception as e:
            conn.rollback()
            raise e

    # -----------------------------------------------------------------------
    # MCP Catalog — endpoint registration & management (MCAT-3.1, #3663)
    # -----------------------------------------------------------------------

    # The columns returned to the API for every endpoint read/write. Kept as one
    # constant so list/get/insert/update all project the same shape.
    _MCP_ENDPOINT_COLUMNS = (
        "id, tenant_id, name, slug, endpoint_url, transport, description, category, "
        "visibility, published, enabled, discovery_cadence_seconds, last_discovered_at, "
        "last_discovery_status, consecutive_failures, next_discovery_after, quarantined_at, "
        "quarantine_reason, current_version_id, transport_metadata, transport_metadata_at, "
        "added_via, created_at, updated_at"
    )

    def list_mcp_endpoints(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List a tenant's live catalog endpoints, newest first (MCAT-3.1)."""
        q = f"""
            SELECT {self._MCP_ENDPOINT_COLUMNS}
            FROM apiome.mcp_endpoints
            WHERE tenant_id = %s::uuid AND deleted_at IS NULL
            ORDER BY created_at DESC
        """
        return self.execute_query(q, (tenant_id,))

    def browse_mcp_endpoints(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List a tenant's live endpoints enriched for the private browse view (MCAT-9.1).

        Each row is a catalog endpoint joined to its *current* version snapshot's quality
        ``score`` / ``grade`` (from ``mcp_version_scores``, NULL until the snapshot is scored)
        and its per-kind capability tallies (tools, resources, resource templates, prompts)
        from ``mcp_capability_items`` — exactly what a browse card renders next to the host.
        An endpoint with no current version (never successfully discovered) still appears,
        with zero counts and a NULL score, so the catalog is shown in full. Ordered by name so
        the per-host grouping the route performs lists endpoints predictably.

        Each row also carries the endpoint's facet fields (V2-MCP-35.1): the current snapshot's
        ``protocol_version``, the derived ``health`` label, the safety-posture flags
        (``has_destructive`` / ``read_only_only``), and the ``complexity_band`` — so the catalog
        grid can filter on every facet dimension without a second read.

        Args:
            tenant_id: The caller's token tenant; the sole scoping predicate, so an endpoint
                never leaks across tenants.

        Returns:
            One dict per live endpoint with its score/grade, capability counts, and facet fields.
        """
        q = f"""
            SELECT e.id, e.tenant_id, e.name, e.slug, e.endpoint_url, e.transport,
                   e.description, e.category, e.visibility, e.published, e.enabled,
                   e.discovery_cadence_seconds, e.last_discovered_at, e.last_discovery_status,
                   e.consecutive_failures, e.next_discovery_after,
                   e.quarantined_at, e.quarantine_reason, e.current_version_id,
                   cv.discovered_at AS last_known_good_at,
                   s.score, s.grade, s.scored_at,
                   cv.server_branding,
                   cv.protocol_version,
                   {self._MCP_ENDPOINT_HEALTH_EXPR} AS health,
                   {self._MCP_HAS_DESTRUCTIVE_EXPR} AS has_destructive,
                   {self._MCP_READ_ONLY_ONLY_EXPR} AS read_only_only,
                   {self._MCP_COMPLEXITY_BAND_EXPR} AS complexity_band,
                   {self._MCP_VERSION_COUNT_EXPR} AS version_count,
                   COUNT(ci.id) FILTER (WHERE ci.item_type = 'tool')              AS tool_count,
                   COUNT(ci.id) FILTER (WHERE ci.item_type = 'resource')          AS resource_count,
                   COUNT(ci.id) FILTER (WHERE ci.item_type = 'resource_template') AS resource_template_count,
                   COUNT(ci.id) FILTER (WHERE ci.item_type = 'prompt')            AS prompt_count
            FROM apiome.mcp_endpoints e
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            LEFT JOIN apiome.mcp_endpoint_versions cv ON cv.id = e.current_version_id
            LEFT JOIN apiome.mcp_capability_items ci ON ci.version_id = e.current_version_id
            CROSS JOIN LATERAL (SELECT {self._MCP_MAX_TOOL_PROPS_EXPR} AS max_tool_props) mtp
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            GROUP BY e.id, s.score, s.grade, s.scored_at, cv.server_branding,
                     cv.protocol_version, cv.discovered_at, mtp.max_tool_props
            ORDER BY e.name ASC
        """
        return self.execute_query(q, (tenant_id,))

    def list_mcp_duplicate_candidates(self, tenant_id: str) -> List[Dict[str, Any]]:
        """Live endpoints in a tenant with fields needed for duplicate detection (MCAT-22.1).

        Each row is an endpoint joined to its current snapshot's ``surface_fingerprint`` (NULL when
        never discovered). Scoping is by ``tenant_id`` only.
        """
        q = """
            SELECT e.id, e.tenant_id, e.name, e.slug, e.endpoint_url, e.transport,
                   e.visibility, e.published,
                   v.surface_fingerprint
            FROM apiome.mcp_endpoints e
            LEFT JOIN apiome.mcp_endpoint_versions v ON v.id = e.current_version_id
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            ORDER BY e.name ASC
        """
        return self.execute_query(q, (tenant_id,))

    def list_published_mcp_duplicate_hints(self, exclude_tenant_id: str) -> List[Dict[str, Any]]:
        """Published endpoints in other tenants for cross-tenant duplicate hints (MCAT-22.1).

        Returns only ``published = true`` live rows outside ``exclude_tenant_id``, with each
        owning tenant's slug for display.
        """
        q = """
            SELECT e.id, e.tenant_id, e.name, e.slug, e.endpoint_url, e.transport,
                   t.slug AS tenant_slug,
                   v.surface_fingerprint
            FROM apiome.mcp_endpoints e
            JOIN apiome.tenants t ON t.id = e.tenant_id
            LEFT JOIN apiome.mcp_endpoint_versions v ON v.id = e.current_version_id
            WHERE e.deleted_at IS NULL
              AND e.published = true
              AND e.tenant_id <> %s::uuid
            ORDER BY t.slug ASC, e.name ASC
        """
        return self.execute_query(q, (exclude_tenant_id,))

    def list_mcp_freshness_candidates(self, tenant_id: str) -> List[Dict[str, Any]]:
        """Live endpoints with fields needed for staleness/freshness reporting (MCAT-22.2).

        Each row joins the current snapshot's ``discovered_at`` as ``last_known_good_at`` (the last
        successful discovery anchor) and carries cadence/backoff/quarantine columns from
        ``mcp_endpoints``.
        """
        q = """
            SELECT e.id, e.tenant_id, e.name, e.slug, e.endpoint_url, e.transport,
                   e.visibility, e.published, e.enabled,
                   e.discovery_cadence_seconds, e.last_discovered_at, e.last_discovery_status,
                   e.consecutive_failures, e.next_discovery_after,
                   e.quarantined_at, e.quarantine_reason, e.current_version_id,
                   cv.discovered_at AS last_known_good_at
            FROM apiome.mcp_endpoints e
            LEFT JOIN apiome.mcp_endpoint_versions cv ON cv.id = e.current_version_id
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            ORDER BY e.name ASC
        """
        return self.execute_query(q, (tenant_id,))

    def list_mcp_endpoints_export_page(
        self,
        tenant_id: str,
        *,
        published_only: bool = False,
        after_id: Optional[str] = None,
        limit: int = 500,
    ) -> List[Dict[str, Any]]:
        """Fetch one keyset page of a tenant's catalog, enriched for inventory export (MCAT-19.2).

        The streaming source for the catalog inventory export (#4651). Each row is the same
        enrichment :meth:`browse_mcp_endpoints` produces — the endpoint joined to its *current*
        snapshot's ``score`` / ``grade`` and its per-kind capability tallies — plus the
        ``enabled`` / ``consecutive_failures`` columns the export's derived *health* label needs.
        Unlike browse, rows are ordered by the primary key ``e.id`` and windowed by a **keyset**
        predicate (``e.id > after_id``), so the export route can walk the whole catalog one bounded
        page at a time and never hold every row in memory. ``id`` ordering (a uuid) is stable and
        unique, so the keyset never skips or repeats a row across pages.

        Args:
            tenant_id: The caller's token tenant; the sole cross-tenant scoping predicate, so the
                export never leaks another tenant's catalog.
            published_only: When true, restrict to ``published = TRUE`` — the public-directory
                variant, which exports only endpoints the tenant has published.
            after_id: Keyset cursor; return only endpoints whose ``id`` sorts strictly after this
                one. ``None`` (the default) starts from the first page.
            limit: Maximum rows in this page.

        Returns:
            Up to ``limit`` enriched endpoint rows, ordered by ``id`` ascending. A short (or empty)
            page signals the caller that the catalog is exhausted.
        """
        clauses = ["e.tenant_id = %s::uuid", "e.deleted_at IS NULL"]
        params: List[Any] = [tenant_id]
        if published_only:
            clauses.append("e.published = TRUE")
        if after_id:
            clauses.append("e.id > %s::uuid")
            params.append(after_id)
        where = " AND ".join(clauses)
        params.append(int(limit))
        q = f"""
            SELECT e.id, e.name, e.endpoint_url, e.transport, e.category,
                   e.visibility, e.published, e.enabled,
                   e.last_discovered_at, e.last_discovery_status,
                   e.consecutive_failures, e.quarantined_at, e.current_version_id,
                   e.added_via,
                   cv.discovery_trigger,
                   s.score, s.grade,
                   COUNT(ci.id) FILTER (WHERE ci.item_type = 'tool')              AS tool_count,
                   COUNT(ci.id) FILTER (WHERE ci.item_type = 'resource')          AS resource_count,
                   COUNT(ci.id) FILTER (WHERE ci.item_type = 'resource_template') AS resource_template_count,
                   COUNT(ci.id) FILTER (WHERE ci.item_type = 'prompt')            AS prompt_count
            FROM apiome.mcp_endpoints e
            LEFT JOIN apiome.mcp_endpoint_versions cv ON cv.id = e.current_version_id
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            LEFT JOIN apiome.mcp_capability_items ci ON ci.version_id = e.current_version_id
            WHERE {where}
            GROUP BY e.id, cv.discovery_trigger, s.score, s.grade
            ORDER BY e.id ASC
            LIMIT %s
        """
        return self.execute_query(q, tuple(params))

    # -----------------------------------------------------------------------
    # MCP Catalog — capability search index & query (MCAT-9.2, #3692)
    # -----------------------------------------------------------------------

    #: tsvector expression that matches the V127 expression GIN index
    #: (``idx_mcp_capability_items_fts``) verbatim, so the capability search is index-usable.
    _MCP_CAPABILITY_FTS_EXPR = (
        "to_tsvector('english', coalesce(ci.name, '') || ' ' || coalesce(ci.description, ''))"
    )

    #: tsvector expression for endpoint-level search (name + description + category). There is no
    #: supporting index — ``mcp_endpoints`` is a small per-tenant table, so a seq scan is cheap and a
    #: dedicated GIN index would only add write/import cost for no real read benefit.
    _MCP_ENDPOINT_FTS_EXPR = (
        "to_tsvector('english', coalesce(e.name, '') || ' ' || coalesce(e.description, '') "
        "|| ' ' || coalesce(e.category, ''))"
    )

    #: Extract the host from a stored endpoint URL in SQL (mirrors ``urlsplit().hostname``): the
    #: authority between ``://`` (after optional ``user:pass@`` userinfo) up to the first ``:`` /
    #: ``/`` / ``?`` / ``#``. NULL for hostless targets (e.g. stdio commands), which a host filter
    #: then excludes — those are the ``(local)`` bucket in browse and have no host to match on.
    _MCP_ENDPOINT_HOST_EXPR = "substring(e.endpoint_url from '://(?:[^@/]*@)?([^:/?#]+)')"

    # --- Faceted catalog search expressions (V2-MCP-35.1 / MCAT-21.1, #4660) ---------------
    # Each derived facet dimension is one SQL expression over the endpoint row (alias ``e``),
    # its current version (alias ``cv``), and its capability items — used identically in the
    # facet WHERE clauses, the endpoint projections, and the GROUP BY count queries, so a
    # filter and its bucket count can never disagree.

    #: The endpoint's derived discovery-health label. The SQL mirror of
    #: :func:`app.mcp_catalog_inventory.derive_health` — same five labels, same precedence
    #: (quarantined → disabled → undiscovered → failing → healthy).
    _MCP_ENDPOINT_HEALTH_EXPR = (
        "CASE WHEN e.quarantined_at IS NOT NULL THEN 'quarantined' "
        "WHEN NOT e.enabled THEN 'disabled' "
        "WHEN e.current_version_id IS NULL OR e.last_discovered_at IS NULL THEN 'undiscovered' "
        "WHEN e.consecutive_failures > 0 THEN 'failing' "
        "ELSE 'healthy' END"
    )

    #: TRUE when the endpoint's current surface has at least one tool asserting
    #: ``destructiveHint: true`` as a JSON boolean (the strict-boolean reading the 28.1 surface
    #: metrics use — a string ``"true"`` does not count as asserted).
    _MCP_HAS_DESTRUCTIVE_EXPR = (
        "EXISTS (SELECT 1 FROM apiome.mcp_capability_items sd "
        "WHERE sd.version_id = e.current_version_id AND sd.item_type = 'tool' "
        "AND sd.annotations -> 'destructiveHint' = 'true'::jsonb)"
    )

    #: TRUE when the endpoint's current surface has at least one tool and *every* tool asserts
    #: ``readOnlyHint: true`` — the server declares the whole surface read-only. A tool with no
    #: annotations (or a non-boolean hint) breaks the claim, so unannotated surfaces never pass.
    _MCP_READ_ONLY_ONLY_EXPR = (
        "(EXISTS (SELECT 1 FROM apiome.mcp_capability_items sr "
        "WHERE sr.version_id = e.current_version_id AND sr.item_type = 'tool') "
        "AND NOT EXISTS (SELECT 1 FROM apiome.mcp_capability_items sr "
        "WHERE sr.version_id = e.current_version_id AND sr.item_type = 'tool' "
        "AND sr.annotations -> 'readOnlyHint' IS DISTINCT FROM 'true'::jsonb))"
    )

    #: The maximum top-level ``input_schema`` property count across the endpoint's current tools
    #: (NULL when the endpoint has no tools / no surface). Spliced into a LATERAL alias
    #: (``mtp.max_tool_props``) so the banding CASE evaluates it once per endpoint.
    _MCP_MAX_TOOL_PROPS_EXPR = (
        "(SELECT MAX(CASE WHEN jsonb_typeof(tc.input_schema -> 'properties') = 'object' "
        "THEN (SELECT COUNT(*) FROM jsonb_object_keys(tc.input_schema -> 'properties')) "
        "ELSE 0 END) "
        "FROM apiome.mcp_capability_items tc "
        "WHERE tc.version_id = e.current_version_id AND tc.item_type = 'tool')"
    )

    #: Band ``mtp.max_tool_props`` into the complexity facet value — the SQL mirror of
    #: :func:`app.mcp_facets.complexity_band`, sharing its thresholds so the two never drift.
    _MCP_COMPLEXITY_BAND_EXPR = (
        "CASE WHEN mtp.max_tool_props IS NULL THEN 'unknown' "
        f"WHEN mtp.max_tool_props <= {COMPLEXITY_SIMPLE_MAX_PROPERTIES} THEN 'simple' "
        f"WHEN mtp.max_tool_props <= {COMPLEXITY_MODERATE_MAX_PROPERTIES} THEN 'moderate' "
        "ELSE 'complex' END"
    )

    #: Total discovery snapshots retained for an endpoint — the version-history count browse cards
    #: render. A scalar subquery keeps browse/faceted queries free of an extra GROUP BY.
    _MCP_VERSION_COUNT_EXPR = (
        "(SELECT COUNT(*)::int FROM apiome.mcp_endpoint_versions vc "
        "WHERE vc.endpoint_id = e.id)"
    )

    #: The shared FROM block of every faceted-search query: the endpoint, its current snapshot's
    #: score and version rows, and the LATERAL max-tool-properties scalar the complexity band
    #: reads. LEFT JOINs keep never-discovered endpoints in scope (they band as ``unknown``).
    _MCP_FACETED_FROM = (
        "FROM apiome.mcp_endpoints e "
        "LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id "
        "LEFT JOIN apiome.mcp_endpoint_versions cv ON cv.id = e.current_version_id "
        f"CROSS JOIN LATERAL (SELECT {_MCP_MAX_TOOL_PROPS_EXPR} AS max_tool_props) mtp"
    )

    def _mcp_search_filter_clauses(
        self,
        *,
        host: Optional[str],
        category: Optional[str],
        grade: Optional[str],
        visibility: Optional[str],
    ) -> Tuple[List[str], List[Any]]:
        """Build the composable WHERE clauses shared by both catalog-search queries (MCAT-9.2).

        Each filter is optional and they compose (every supplied filter is ANDed in). Returns a
        ``(clauses, params)`` pair the caller splices into its query; the clauses reference the
        ``e`` (endpoint) and ``s`` (version score) aliases both search queries expose. Host and
        category match case-insensitively; grade matches case-insensitively against the current
        snapshot's letter grade; visibility matches the endpoint's ``visibility`` exactly.
        """
        clauses: List[str] = []
        params: List[Any] = []
        if host:
            clauses.append(f"lower({self._MCP_ENDPOINT_HOST_EXPR}) = lower(%s)")
            params.append(host)
        if category:
            clauses.append("lower(e.category) = lower(%s)")
            params.append(category)
        if grade:
            clauses.append("upper(s.grade) = upper(%s)")
            params.append(grade)
        if visibility:
            clauses.append("e.visibility = %s")
            params.append(visibility)
        return clauses, params

    def search_mcp_capability_items(
        self,
        tenant_id: str,
        query: str,
        *,
        item_type: Optional[str] = None,
        host: Optional[str] = None,
        category: Optional[str] = None,
        grade: Optional[str] = None,
        visibility: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Full-text search a tenant's *current* capability surface, relevance-then-score ranked (MCAT-9.2).

        Matches ``query`` (parsed with ``websearch_to_tsquery`` — quotes, ``OR``, and ``-`` are
        honoured, malformed syntax never errors) against the ``name + description`` tsvector of every
        capability item that belongs to an endpoint's *current* version snapshot
        (``e.current_version_id = ci.version_id``), so only live surfaces are searched — never
        superseded history. Joining through ``mcp_endpoints`` and scoping by ``tenant_id`` is what
        keeps the search inside the caller's own catalog. The ``@@`` predicate uses the same
        expression as the V127 GIN index, so the index does the matching.

        Args:
            tenant_id: The caller's token tenant; the sole cross-tenant scoping predicate.
            query: The free-text query (already stripped non-empty by the caller).
            item_type: Restrict to one capability kind (``tool`` / ``resource`` /
                ``resource_template`` / ``prompt``); ``None`` searches all four.
            host: Restrict to endpoints on this host (case-insensitive).
            category: Restrict to endpoints in this category (case-insensitive).
            grade: Restrict to endpoints whose current snapshot earned this A-F grade.
            visibility: Restrict to ``private`` or ``public`` endpoints within the tenant.
            limit: Maximum rows to return.
            offset: Rows to skip (pagination).

        Returns:
            One row per matching capability item — the item plus its owning endpoint's browse
            context and a ``relevance`` rank — ordered by relevance desc, then score desc, then
            endpoint name and item ordinal for a stable tie-break.
        """
        fts = self._MCP_CAPABILITY_FTS_EXPR
        clauses, fparams = self._mcp_search_filter_clauses(
            host=host, category=category, grade=grade, visibility=visibility
        )
        if item_type:
            clauses.append("ci.item_type = %s")
            fparams.append(item_type)
        where_extra = ("\n              AND " + "\n              AND ".join(clauses)) if clauses else ""
        q = f"""
            SELECT ci.item_type AS kind,
                   ci.id AS item_id, ci.name AS item_name, ci.title AS item_title,
                   ci.description AS description, ci.ordinal AS ordinal,
                   e.id AS endpoint_id, e.name AS endpoint_name, e.slug AS endpoint_slug,
                   e.endpoint_url, e.category, e.visibility, e.current_version_id,
                   e.last_discovered_at, s.score, s.grade,
                   ts_rank({fts}, websearch_to_tsquery('english', %s)) AS relevance
            FROM apiome.mcp_capability_items ci
            JOIN apiome.mcp_endpoints e ON e.current_version_id = ci.version_id
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            WHERE e.tenant_id = %s::uuid
              AND e.deleted_at IS NULL
              AND {fts} @@ websearch_to_tsquery('english', %s){where_extra}
            ORDER BY relevance DESC, s.score DESC NULLS LAST, e.name ASC, ci.ordinal ASC
            LIMIT %s OFFSET %s
        """
        params = (query, tenant_id, query, *fparams, int(limit), int(offset))
        return self.execute_query(q, params)

    @staticmethod
    def _escape_ilike_pattern(value: str) -> str:
        """Escape ``%``, ``_``, and ``\\`` for use in an ``ILIKE ... ESCAPE E'\\\\'`` predicate."""
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    def _mcp_capability_directory_where(
        self,
        *,
        name_pattern: Optional[str],
        item_type: Optional[str],
        endpoint_id: Optional[str],
        host: Optional[str],
        category: Optional[str],
        grade: Optional[str],
        visibility: Optional[str],
    ) -> Tuple[str, List[Any]]:
        """Build the composable WHERE suffix for the capability directory (MCAT-21.4)."""
        clauses, params = self._mcp_search_filter_clauses(
            host=host, category=category, grade=grade, visibility=visibility
        )
        if item_type:
            clauses.append("ci.item_type = %s")
            params.append(item_type)
        if endpoint_id:
            clauses.append("e.id = %s::uuid")
            params.append(endpoint_id)
        if name_pattern:
            escaped = self._escape_ilike_pattern(name_pattern)
            like = f"%{escaped}%"
            clauses.append(
                "(ci.name ILIKE %s ESCAPE E'\\\\' OR COALESCE(ci.title, '') ILIKE %s ESCAPE E'\\\\')"
            )
            params.extend([like, like])
        where_extra = ("\n              AND " + "\n              AND ".join(clauses)) if clauses else ""
        return where_extra, params

    def list_mcp_capability_directory(
        self,
        tenant_id: str,
        *,
        name_pattern: Optional[str] = None,
        item_type: Optional[str] = None,
        endpoint_id: Optional[str] = None,
        host: Optional[str] = None,
        category: Optional[str] = None,
        grade: Optional[str] = None,
        visibility: Optional[str] = None,
        sort: str = "server",
        direction: str = "asc",
        limit: int = 50,
        offset: int = 0,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """Paginated directory of every live capability item in the caller's catalog (MCAT-21.4).

        Lists tools/resources/resource templates/prompts from each endpoint's *current* snapshot,
        scoped by ``tenant_id`` with the same composable host/category/grade/visibility filters as
        catalog search. Optional ``name_pattern`` matches item ``name`` or ``title`` case-
        insensitively (substring); ``item_type`` and ``endpoint_id`` narrow to one kind or server.
        ``sort`` picks the primary column (server/name/type) and ``direction`` (asc/desc) flips it;
        secondary tie-break columns stay ascending for a stable order.
        """
        where_extra, fparams = self._mcp_capability_directory_where(
            name_pattern=name_pattern,
            item_type=item_type,
            endpoint_id=endpoint_id,
            host=host,
            category=category,
            grade=grade,
            visibility=visibility,
        )
        dir_kw = "DESC" if str(direction).lower() == "desc" else "ASC"
        order_by = {
            "name": f"ci.name {dir_kw}, ci.item_type ASC, e.name ASC",
            "type": f"ci.item_type {dir_kw}, ci.name ASC, e.name ASC",
            "server": f"e.name {dir_kw}, ci.ordinal ASC",
        }.get(sort, f"e.name {dir_kw}, ci.ordinal ASC")
        base_from = """
            FROM apiome.mcp_capability_items ci
            JOIN apiome.mcp_endpoints e ON e.current_version_id = ci.version_id
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            WHERE e.tenant_id = %s::uuid
              AND e.deleted_at IS NULL"""
        count_q = f"SELECT COUNT(*) AS total {base_from}{where_extra}"
        count_row = self.execute_query(count_q, (tenant_id, *fparams))
        total = int(count_row[0]["total"]) if count_row else 0
        list_q = f"""
            SELECT ci.item_type AS kind,
                   ci.id AS item_id, ci.name AS item_name, ci.title AS item_title,
                   ci.description AS description, ci.ordinal AS ordinal,
                   e.id AS endpoint_id, e.name AS endpoint_name, e.slug AS endpoint_slug,
                   e.endpoint_url, e.category, e.visibility, e.current_version_id,
                   s.score, s.grade
            {base_from}{where_extra}
            ORDER BY {order_by}
            LIMIT %s OFFSET %s
        """
        rows = self.execute_query(list_q, (tenant_id, *fparams, int(limit), int(offset)))
        return rows, total

    def search_mcp_endpoints_fts(
        self,
        tenant_id: str,
        query: str,
        *,
        host: Optional[str] = None,
        category: Optional[str] = None,
        grade: Optional[str] = None,
        visibility: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Full-text search a tenant's endpoints by name/description/category (MCAT-9.2, ``scope=endpoint``).

        The endpoint-level half of catalog search: matches ``query`` against each endpoint's
        ``name + description + category`` tsvector rather than its capability items, so "find the MCP
        server" queries surface the server itself. Same tenant scoping, same composable
        host/category/grade/visibility filters, and the same relevance-then-score ordering as the
        capability search; rows are shaped identically (``kind = 'endpoint'`` with the ``item_*``
        columns NULL) so one projection serves both.

        Args:
            tenant_id: The caller's token tenant; the sole cross-tenant scoping predicate.
            query: The free-text query (already stripped non-empty by the caller).
            host: Restrict to endpoints on this host (case-insensitive).
            category: Restrict to endpoints in this category (case-insensitive).
            grade: Restrict to endpoints whose current snapshot earned this A-F grade.
            visibility: Restrict to ``private`` or ``public`` endpoints within the tenant.
            limit: Maximum rows to return.
            offset: Rows to skip (pagination).

        Returns:
            One row per matching endpoint — its browse context and a ``relevance`` rank — ordered by
            relevance desc, then score desc, then name for a stable tie-break.
        """
        fts = self._MCP_ENDPOINT_FTS_EXPR
        clauses, fparams = self._mcp_search_filter_clauses(
            host=host, category=category, grade=grade, visibility=visibility
        )
        where_extra = ("\n              AND " + "\n              AND ".join(clauses)) if clauses else ""
        q = f"""
            SELECT 'endpoint' AS kind,
                   NULL::uuid AS item_id, NULL::text AS item_name, NULL::text AS item_title,
                   e.description AS description,
                   e.id AS endpoint_id, e.name AS endpoint_name, e.slug AS endpoint_slug,
                   e.endpoint_url, e.category, e.visibility, e.current_version_id,
                   e.last_discovered_at, s.score, s.grade,
                   ts_rank({fts}, websearch_to_tsquery('english', %s)) AS relevance
            FROM apiome.mcp_endpoints e
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            WHERE e.tenant_id = %s::uuid
              AND e.deleted_at IS NULL
              AND {fts} @@ websearch_to_tsquery('english', %s){where_extra}
            ORDER BY relevance DESC, s.score DESC NULLS LAST, e.name ASC
            LIMIT %s OFFSET %s
        """
        params = (query, tenant_id, query, *fparams, int(limit), int(offset))
        return self.execute_query(q, params)

    def search_mcp_capability_items_semantic(
        self,
        tenant_id: str,
        query_embedding: List[float],
        *,
        item_type: Optional[str] = None,
        host: Optional[str] = None,
        category: Optional[str] = None,
        grade: Optional[str] = None,
        visibility: Optional[str] = None,
        limit: int = 50,
        min_similarity: float = 0.0,
    ) -> List[Dict[str, Any]]:
        """Semantic nearest-neighbour search over a tenant's current capability items (MCAT-21.2).

        Matches ``query_embedding`` against stored per-item ``embedding`` vectors (V149) on every
        capability item that belongs to an endpoint's *current* version snapshot. Scoped by
        ``tenant_id`` and the same composable host/category/grade/visibility filters as the FTS
        search. Returns cosine **similarity** (``1 - distance``) as ``semantic_similarity``.

        When pgvector is unavailable or no items are embedded, returns an empty list so the route
        falls back to keyword matches only.

        Args:
            tenant_id: The caller's token tenant.
            query_embedding: The query vector (same dimension as stored embeddings).
            item_type: Restrict to one capability kind; ``None`` searches all four.
            host: Restrict to endpoints on this host (case-insensitive).
            category: Restrict to endpoints in this category (case-insensitive).
            grade: Restrict to endpoints whose current snapshot earned this A-F grade.
            visibility: Restrict to ``private`` or ``public`` endpoints within the tenant.
            limit: Maximum rows to return.
            min_similarity: Drop items whose cosine similarity is strictly below this floor.

        Returns:
            Capability-item rows with endpoint browse context and ``semantic_similarity``.
        """
        if not query_embedding:
            return []

        clauses, fparams = self._mcp_search_filter_clauses(
            host=host, category=category, grade=grade, visibility=visibility
        )
        if item_type:
            clauses.append("ci.item_type = %s")
            fparams.append(item_type)
        clauses.append("ci.embedding IS NOT NULL")
        where_extra = ("\n              AND " + "\n              AND ".join(clauses)) if clauses else ""

        vector = np.array(query_embedding, dtype=np.float32)
        conn = self.connect()
        try:
            from pgvector.psycopg2 import register_vector

            register_vector(conn)
        except Exception as exc:
            _logger.warning(
                "[mcp-cap-search] pgvector adapter unavailable (%s); semantic search skipped",
                exc,
            )
            return []

        q = f"""
            SELECT ci.item_type AS kind,
                   ci.id AS item_id, ci.name AS item_name, ci.title AS item_title,
                   ci.description AS description, ci.ordinal AS ordinal,
                   e.id AS endpoint_id, e.name AS endpoint_name, e.slug AS endpoint_slug,
                   e.endpoint_url, e.category, e.visibility, e.current_version_id,
                   e.last_discovered_at, s.score, s.grade,
                   (1 - (ci.embedding <=> %s))::double precision AS semantic_similarity
            FROM apiome.mcp_capability_items ci
            JOIN apiome.mcp_endpoints e ON e.current_version_id = ci.version_id
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            WHERE e.tenant_id = %s::uuid
              AND e.deleted_at IS NULL
              AND (1 - (ci.embedding <=> %s)) >= %s{where_extra}
            ORDER BY ci.embedding <=> %s ASC, s.score DESC NULLS LAST, e.name ASC, ci.ordinal ASC
            LIMIT %s
        """
        params = (vector, tenant_id, vector, float(min_similarity), *fparams, vector, int(limit))
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, params)
                columns = [desc[0] for desc in cursor.description]
                return [dict(zip(columns, row)) for row in cursor.fetchall()]
        except Exception as exc:
            conn.rollback()
            code = getattr(exc, "pgcode", None) or getattr(exc, "code", None)
            msg = str(getattr(exc, "message", exc) or exc)
            if code == "42704" or ("vector" in msg.lower() and "does not exist" in msg.lower()):
                _logger.warning(
                    "[mcp-cap-search] pgvector type unavailable (%s); semantic search skipped",
                    msg,
                )
                return []
            raise

    def store_mcp_capability_item_embedding(
        self, item_id: str, embedding: List[float]
    ) -> bool:
        """Persist one capability item's embedding for cross-server semantic search (MCAT-21.2).

        Writes the ``embedding`` (V149) of one ``mcp_capability_items`` row. Mirrors
        :meth:`store_mcp_capability_embedding`: pgvector adapter / type unavailability is a
        labelled no-op (returns ``False``) rather than raising.

        Args:
            item_id: The capability item whose embedding to store.
            embedding: The item embedding vector; an empty vector is a no-op (returns ``False``).

        Returns:
            ``True`` when the embedding was written, ``False`` when skipped.
        """
        if not embedding:
            return False

        vector = np.array(embedding, dtype=np.float32)
        conn = self.connect()
        try:
            from pgvector.psycopg2 import register_vector

            register_vector(conn)
        except Exception as exc:
            _logger.warning(
                "[mcp-cap-search] pgvector adapter unavailable (%s); item embedding not stored for "
                "item_id=%s",
                exc,
                item_id,
            )
            return False

        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE apiome.mcp_capability_items
                    SET embedding = %s
                    WHERE id = %s::uuid
                    """,
                    (vector, item_id),
                )
            conn.commit()
            return True
        except Exception as exc:
            conn.rollback()
            code = getattr(exc, "pgcode", None) or getattr(exc, "code", None)
            msg = str(getattr(exc, "message", exc) or exc)
            if code == "42704" or ("vector" in msg.lower() and "does not exist" in msg.lower()):
                _logger.warning(
                    "[mcp-cap-search] pgvector type unavailable (%s); item embedding not stored for "
                    "item_id=%s",
                    msg,
                    item_id,
                )
                return False
            raise

    # -----------------------------------------------------------------------
    # MCP Catalog — faceted catalog search (V2-MCP-35.1 / MCAT-21.1, #4660)
    # -----------------------------------------------------------------------

    def _mcp_facet_filter_clauses(
        self,
        *,
        grades: Optional[List[str]] = None,
        transports: Optional[List[str]] = None,
        categories: Optional[List[str]] = None,
        safety: Optional[List[str]] = None,
        complexity: Optional[List[str]] = None,
        protocols: Optional[List[str]] = None,
        health: Optional[List[str]] = None,
        visibility: Optional[str] = None,
    ) -> Tuple[List[str], List[Any]]:
        """Build the composable facet WHERE clauses of the faceted catalog search (MCAT-21.1).

        Multi-facet **AND** semantics: each supplied dimension contributes exactly one clause and
        the caller ANDs them all in. Within a dimension, values **OR** (an ``IN``-style match), so
        ``grades=[A, B]`` matches endpoints graded A *or* B. The NULL-bucket sentinels
        (``ungraded`` / ``uncategorized`` / ``unknown``) OR an ``IS NULL`` predicate into their
        dimension's clause, so every bucket a facet count reports is filterable.

        The clauses reference the ``e`` / ``s`` / ``cv`` / ``mtp`` aliases the shared
        :data:`_MCP_FACETED_FROM` block (and the browse query) expose. Values are assumed already
        canonicalized by :func:`app.mcp_facets.normalize_catalog_facet_filters`.

        Args:
            grades: Letter grades (uppercase) and/or ``ungraded``.
            transports: Transport kinds (``streamable_http`` / ``sse`` / ``stdio``).
            categories: Category names (matched case-insensitively) and/or ``uncategorized``.
            safety: Safety postures (``has_destructive`` / ``read_only_only``).
            complexity: Complexity bands (``simple`` / ``moderate`` / ``complex`` / ``unknown``).
            protocols: Protocol versions (matched exactly) and/or ``unknown``.
            health: Derived health labels (the five :data:`app.mcp_facets.HEALTH_VALUES`).
            visibility: ``private`` or ``public`` (single-valued, like the 9.2 search filter).

        Returns:
            A ``(clauses, params)`` pair for the caller to AND into its WHERE.
        """
        clauses: List[str] = []
        params: List[Any] = []

        if grades:
            parts: List[str] = []
            letters = [g for g in grades if g != UNGRADED_VALUE]
            if letters:
                parts.append("upper(s.grade) = ANY(%s)")
                params.append(letters)
            if UNGRADED_VALUE in grades:
                parts.append("s.grade IS NULL")
            clauses.append("(" + " OR ".join(parts) + ")")

        if transports:
            clauses.append("e.transport = ANY(%s)")
            params.append(list(transports))

        if categories:
            parts = []
            named = [c for c in categories if c != UNCATEGORIZED_VALUE]
            if named:
                parts.append("lower(e.category) = ANY(%s)")
                params.append([c.lower() for c in named])
            if UNCATEGORIZED_VALUE in categories:
                parts.append("(e.category IS NULL OR e.category = '')")
            clauses.append("(" + " OR ".join(parts) + ")")

        if safety:
            parts = []
            if SAFETY_HAS_DESTRUCTIVE in safety:
                parts.append(self._MCP_HAS_DESTRUCTIVE_EXPR)
            if SAFETY_READ_ONLY_ONLY in safety:
                parts.append(self._MCP_READ_ONLY_ONLY_EXPR)
            clauses.append("(" + " OR ".join(parts) + ")")

        if complexity:
            clauses.append(f"{self._MCP_COMPLEXITY_BAND_EXPR} = ANY(%s)")
            params.append(list(complexity))

        if protocols:
            parts = []
            named = [p for p in protocols if p != UNKNOWN_VALUE]
            if named:
                parts.append("cv.protocol_version = ANY(%s)")
                params.append(named)
            if UNKNOWN_VALUE in protocols:
                parts.append("cv.protocol_version IS NULL")
            clauses.append("(" + " OR ".join(parts) + ")")

        if health:
            clauses.append(f"({self._MCP_ENDPOINT_HEALTH_EXPR}) = ANY(%s)")
            params.append(list(health))

        if visibility:
            clauses.append("e.visibility = %s")
            params.append(visibility)

        return clauses, params

    def search_mcp_catalog_faceted(
        self,
        tenant_id: str,
        *,
        grades: Optional[List[str]] = None,
        transports: Optional[List[str]] = None,
        categories: Optional[List[str]] = None,
        safety: Optional[List[str]] = None,
        complexity: Optional[List[str]] = None,
        protocols: Optional[List[str]] = None,
        health: Optional[List[str]] = None,
        visibility: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Faceted search over a tenant's live catalog: filtered endpoints + live facet counts (MCAT-21.1).

        One bundle backing ``GET /v1/mcp/{tenant}/facets``: the page of endpoints matching every
        supplied facet filter (multi-facet AND, within-facet OR — see
        :meth:`_mcp_facet_filter_clauses`), the total match count, and per-dimension bucket counts
        aggregated over the *same filtered set* — so the counts are live: they always describe
        exactly the result the filters produced. Scoping is by ``tenant_id`` (live rows only), and
        the ``visibility`` filter composes on top within the caller's own catalog, so the search
        never crosses tenants.

        Endpoint rows carry the same enrichment browse rows do (score/grade, per-kind capability
        tallies, protocol, health, safety flags, complexity band), ordered by name for a stable
        page. An empty match yields an empty page, zero total, and empty bucket lists — never an
        error.

        Args:
            tenant_id: The caller's token tenant; the sole cross-tenant scoping predicate.
            grades / transports / categories / safety / complexity / protocols / health:
                Canonical facet selections (see :meth:`_mcp_facet_filter_clauses`); ``None`` or
                empty means no constraint on that dimension.
            visibility: Restrict to ``private`` or ``public`` endpoints within the tenant.
            limit: Maximum endpoint rows in the page.
            offset: Endpoint rows to skip (pagination).

        Returns:
            A dict with ``endpoints`` (the page rows), ``total`` (the full match count), the
            ``{label, count}`` row lists ``grade_rows`` / ``transport_rows`` / ``category_rows`` /
            ``complexity_rows`` / ``protocol_rows`` / ``health_rows``, and ``safety_counts``
            (``has_destructive`` / ``read_only_only`` tallies).
        """
        clauses, fparams = self._mcp_facet_filter_clauses(
            grades=grades,
            transports=transports,
            categories=categories,
            safety=safety,
            complexity=complexity,
            protocols=protocols,
            health=health,
            visibility=visibility,
        )
        where = "WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL"
        if clauses:
            where += "".join(f" AND {c}" for c in clauses)
        base = f"{self._MCP_FACETED_FROM} {where}"
        params = (tenant_id, *fparams)

        def _kind_count(kind: str) -> str:
            return (
                "(SELECT COUNT(*) FROM apiome.mcp_capability_items i "
                f"WHERE i.version_id = e.current_version_id AND i.item_type = '{kind}')"
            )

        endpoints_q = f"""
            SELECT e.id, e.name, e.slug, e.endpoint_url, e.transport, e.description,
                   e.category, e.visibility, e.published, e.enabled,
                   e.discovery_cadence_seconds, e.last_discovered_at, e.last_discovery_status,
                   e.consecutive_failures, e.next_discovery_after,
                   e.quarantined_at, e.quarantine_reason, e.current_version_id,
                   cv.discovered_at AS last_known_good_at,
                   s.score, s.grade,
                   cv.server_branding, cv.protocol_version,
                   {self._MCP_ENDPOINT_HEALTH_EXPR} AS health,
                   {self._MCP_HAS_DESTRUCTIVE_EXPR} AS has_destructive,
                   {self._MCP_READ_ONLY_ONLY_EXPR} AS read_only_only,
                   {self._MCP_COMPLEXITY_BAND_EXPR} AS complexity_band,
                   {self._MCP_VERSION_COUNT_EXPR} AS version_count,
                   {_kind_count('tool')}              AS tool_count,
                   {_kind_count('resource')}          AS resource_count,
                   {_kind_count('resource_template')} AS resource_template_count,
                   {_kind_count('prompt')}            AS prompt_count
            {base}
            ORDER BY e.name ASC, e.id ASC
            LIMIT %s OFFSET %s
        """
        total_q = f"SELECT COUNT(*) AS total {base}"

        # Per-dimension bucket counts over the same filtered set (GROUP BY the facet expression,
        # busiest bucket first, stable label tiebreak). NULL labels are preserved here and mapped
        # to their sentinel bucket in the wire projection.
        def _bucket_q(label_expr: str) -> str:
            return (
                f"SELECT {label_expr} AS label, COUNT(*) AS count {base} "
                "GROUP BY 1 ORDER BY count DESC, label ASC NULLS LAST"
            )

        safety_q = f"""
            SELECT COUNT(*) FILTER (WHERE {self._MCP_HAS_DESTRUCTIVE_EXPR}) AS has_destructive,
                   COUNT(*) FILTER (WHERE {self._MCP_READ_ONLY_ONLY_EXPR})  AS read_only_only
            {base}
        """

        total_rows = self.execute_query(total_q, params)
        safety_rows = self.execute_query(safety_q, params)
        return {
            "endpoints": self.execute_query(endpoints_q, (*params, int(limit), int(offset))),
            "total": int(total_rows[0]["total"]) if total_rows else 0,
            "grade_rows": self.execute_query(_bucket_q("upper(s.grade)"), params),
            "transport_rows": self.execute_query(_bucket_q("e.transport"), params),
            "category_rows": self.execute_query(_bucket_q("e.category"), params),
            "safety_counts": dict(safety_rows[0]) if safety_rows else {},
            "complexity_rows": self.execute_query(
                _bucket_q(self._MCP_COMPLEXITY_BAND_EXPR), params
            ),
            "protocol_rows": self.execute_query(_bucket_q("cv.protocol_version"), params),
            "health_rows": self.execute_query(
                _bucket_q(self._MCP_ENDPOINT_HEALTH_EXPR), params
            ),
        }

    # -----------------------------------------------------------------------
    # MCP Catalog — saved searches (V2-MCP-35.3 / MCAT-21.3, #4662)
    # -----------------------------------------------------------------------

    _MCP_SAVED_SEARCH_COLUMNS = (
        "id, tenant_id, user_id, name, filters, query, sort, is_pinned, created_at, updated_at"
    )

    def list_mcp_saved_searches(
        self, tenant_id: str, user_id: str
    ) -> List[Dict[str, Any]]:
        """List a user's saved catalog searches, pinned first then newest (MCAT-21.3)."""
        q = f"""
            SELECT {self._MCP_SAVED_SEARCH_COLUMNS}
            FROM apiome.mcp_saved_searches
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid
            ORDER BY is_pinned DESC, updated_at DESC, name ASC
        """
        return [dict(r) for r in self.execute_query(q, (tenant_id, user_id))]

    def get_mcp_saved_search(
        self, tenant_id: str, user_id: str, search_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one saved search scoped to tenant + owner (MCAT-21.3)."""
        q = f"""
            SELECT {self._MCP_SAVED_SEARCH_COLUMNS}
            FROM apiome.mcp_saved_searches
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND user_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (search_id, tenant_id, user_id))
        return dict(rows[0]) if rows else None

    def create_mcp_saved_search(
        self,
        tenant_id: str,
        user_id: str,
        *,
        name: str,
        filters: Dict[str, Any],
        query: str,
        sort: str,
        is_pinned: bool,
    ) -> Dict[str, Any]:
        """Insert a saved catalog search for the owner (MCAT-21.3)."""
        q = f"""
            INSERT INTO apiome.mcp_saved_searches
                (tenant_id, user_id, name, filters, query, sort, is_pinned)
            VALUES (%s::uuid, %s::uuid, %s, %s::jsonb, %s, %s, %s)
            RETURNING {self._MCP_SAVED_SEARCH_COLUMNS}
        """
        rows = self.execute_query(
            q,
            (tenant_id, user_id, name, filters, query, sort, is_pinned),
        )
        return dict(rows[0]) if rows else {}

    def update_mcp_saved_search(
        self,
        tenant_id: str,
        user_id: str,
        search_id: str,
        *,
        name: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        query: Optional[str] = None,
        sort: Optional[str] = None,
        is_pinned: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        """Patch a saved search owned by the caller (MCAT-21.3)."""
        sets: List[str] = ["updated_at = CURRENT_TIMESTAMP"]
        params: List[Any] = []
        if name is not None:
            sets.append("name = %s")
            params.append(name)
        if filters is not None:
            sets.append("filters = %s::jsonb")
            params.append(filters)
        if query is not None:
            sets.append("query = %s")
            params.append(query)
        if sort is not None:
            sets.append("sort = %s")
            params.append(sort)
        if is_pinned is not None:
            sets.append("is_pinned = %s")
            params.append(is_pinned)
        params.extend([search_id, tenant_id, user_id])
        q = f"""
            UPDATE apiome.mcp_saved_searches
            SET {", ".join(sets)}
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND user_id = %s::uuid
            RETURNING {self._MCP_SAVED_SEARCH_COLUMNS}
        """
        rows = self.execute_query(q, tuple(params))
        return dict(rows[0]) if rows else None

    def delete_mcp_saved_search(
        self, tenant_id: str, user_id: str, search_id: str
    ) -> bool:
        """Delete a saved search owned by the caller (MCAT-21.3)."""
        q = """
            DELETE FROM apiome.mcp_saved_searches
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND user_id = %s::uuid
        """
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(q, (search_id, tenant_id, user_id))
                deleted = cur.rowcount > 0
            conn.commit()
            return deleted
        except Exception:
            conn.rollback()
            raise

    # -----------------------------------------------------------------------
    # MCP Catalog — cataloger notes (V2-MCP-36.3 / MCAT-22.3, #4666)
    # -----------------------------------------------------------------------

    _MCP_ENDPOINT_NOTE_COLUMNS = """
        n.id, n.tenant_id, n.endpoint_id, n.body,
        n.created_by, n.updated_by, n.created_at, n.updated_at,
        cu.name AS created_by_name, cu.email AS created_by_email,
        uu.name AS updated_by_name, uu.email AS updated_by_email
    """

    _MCP_ENDPOINT_NOTE_FROM = """
        FROM apiome.mcp_endpoint_notes n
        LEFT JOIN apiome.users cu ON cu.id = n.created_by
        LEFT JOIN apiome.users uu ON uu.id = n.updated_by
    """

    def list_mcp_endpoint_notes(
        self, tenant_id: str, endpoint_id: str
    ) -> List[Dict[str, Any]]:
        """List cataloger notes for an endpoint, newest first (MCAT-22.3)."""
        q = f"""
            SELECT {self._MCP_ENDPOINT_NOTE_COLUMNS}
            {self._MCP_ENDPOINT_NOTE_FROM}
            WHERE n.tenant_id = %s::uuid AND n.endpoint_id = %s::uuid
            ORDER BY n.created_at DESC, n.id DESC
        """
        return [dict(r) for r in self.execute_query(q, (tenant_id, endpoint_id))]

    def get_mcp_endpoint_note(
        self, tenant_id: str, endpoint_id: str, note_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one cataloger note scoped to tenant + endpoint (MCAT-22.3)."""
        q = f"""
            SELECT {self._MCP_ENDPOINT_NOTE_COLUMNS}
            {self._MCP_ENDPOINT_NOTE_FROM}
            WHERE n.id = %s::uuid AND n.tenant_id = %s::uuid AND n.endpoint_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (note_id, tenant_id, endpoint_id))
        return dict(rows[0]) if rows else None

    def create_mcp_endpoint_note(
        self,
        tenant_id: str,
        endpoint_id: str,
        user_id: str,
        *,
        body: str,
    ) -> Dict[str, Any]:
        """Insert a cataloger note on an endpoint (MCAT-22.3)."""
        q = """
            INSERT INTO apiome.mcp_endpoint_notes
                (tenant_id, endpoint_id, body, created_by)
            VALUES (%s::uuid, %s::uuid, %s, %s::uuid)
            RETURNING id
        """
        rows = self.execute_query(q, (tenant_id, endpoint_id, body, user_id))
        note_id = str(rows[0]["id"]) if rows else ""
        row = self.get_mcp_endpoint_note(tenant_id, endpoint_id, note_id)
        return row if row is not None else {}

    def update_mcp_endpoint_note(
        self,
        tenant_id: str,
        endpoint_id: str,
        note_id: str,
        user_id: str,
        *,
        body: str,
    ) -> Optional[Dict[str, Any]]:
        """Update a cataloger note and record the editor (MCAT-22.3)."""
        q = """
            UPDATE apiome.mcp_endpoint_notes
            SET body = %s, updated_by = %s::uuid, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND endpoint_id = %s::uuid
        """
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(q, (body, user_id, note_id, tenant_id, endpoint_id))
                updated = cur.rowcount > 0
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        if not updated:
            return None
        return self.get_mcp_endpoint_note(tenant_id, endpoint_id, note_id)

    def delete_mcp_endpoint_note(
        self, tenant_id: str, endpoint_id: str, note_id: str
    ) -> bool:
        """Delete a cataloger note from an endpoint (MCAT-22.3)."""
        q = """
            DELETE FROM apiome.mcp_endpoint_notes
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND endpoint_id = %s::uuid
        """
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(q, (note_id, tenant_id, endpoint_id))
                deleted = cur.rowcount > 0
            conn.commit()
            return deleted
        except Exception:
            conn.rollback()
            raise

    # MCP Catalog — curated collections (V2-MCP-36.4 / MCAT-22.4, #4667)

    _MCP_COLLECTION_COLUMNS = """
        c.id, c.tenant_id, c.name, c.slug, c.description, c.is_published,
        c.created_by, c.created_at, c.updated_at
    """

    _MCP_COLLECTION_MEMBER_SELECT = """
        m.collection_id, m.tenant_id, m.endpoint_id, m.position, m.added_at,
        e.name, e.slug, e.visibility, e.published,
        substring(e.endpoint_url from '://(?:[^@/]*@)?([^:/?#]+)') AS host,
        s.grade
    """

    def list_mcp_collections(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List a tenant's curated collections, newest first (MCAT-22.4)."""
        q = f"""
            SELECT {self._MCP_COLLECTION_COLUMNS},
                   COUNT(m.endpoint_id)::int AS member_count
            FROM apiome.mcp_collections c
            LEFT JOIN apiome.mcp_collection_members m ON m.collection_id = c.id
            WHERE c.tenant_id = %s::uuid
            GROUP BY c.id, c.tenant_id, c.name, c.slug, c.description, c.is_published,
                     c.created_by, c.created_at, c.updated_at
            ORDER BY c.updated_at DESC, c.name ASC
        """
        return [dict(r) for r in self.execute_query(q, (tenant_id,))]

    def get_mcp_collection(
        self, tenant_id: str, collection_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one curated collection scoped to tenant (MCAT-22.4)."""
        q = f"""
            SELECT {self._MCP_COLLECTION_COLUMNS},
                   COUNT(m.endpoint_id)::int AS member_count
            FROM apiome.mcp_collections c
            LEFT JOIN apiome.mcp_collection_members m ON m.collection_id = c.id
            WHERE c.id = %s::uuid AND c.tenant_id = %s::uuid
            GROUP BY c.id, c.tenant_id, c.name, c.slug, c.description, c.is_published,
                     c.created_by, c.created_at, c.updated_at
            LIMIT 1
        """
        rows = self.execute_query(q, (collection_id, tenant_id))
        return dict(rows[0]) if rows else None

    def list_mcp_collection_members(
        self, tenant_id: str, collection_id: str
    ) -> List[Dict[str, Any]]:
        """List endpoints in a collection with browse-oriented fields (MCAT-22.4)."""
        q = f"""
            SELECT {self._MCP_COLLECTION_MEMBER_SELECT}
            FROM apiome.mcp_collection_members m
            JOIN apiome.mcp_collections c ON c.id = m.collection_id
            JOIN apiome.mcp_endpoints e
              ON e.id = m.endpoint_id AND e.tenant_id = m.tenant_id AND e.deleted_at IS NULL
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            WHERE c.id = %s::uuid AND c.tenant_id = %s::uuid
            ORDER BY m.position ASC, m.added_at ASC, e.name ASC
        """
        return [dict(r) for r in self.execute_query(q, (collection_id, tenant_id))]

    def _next_available_collection_slug(
        self, cursor, tenant_id: str, base_slug: str
    ) -> str:
        """Pick a tenant-unique collection slug derived from ``base_slug``."""
        cursor.execute(
            """
            SELECT slug FROM apiome.mcp_collections
            WHERE tenant_id = %s::uuid AND (slug = %s OR slug LIKE %s)
            """,
            (tenant_id, base_slug, f"{base_slug}-%"),
        )
        taken = {str(r["slug"]) for r in cursor.fetchall()}
        if base_slug not in taken:
            return base_slug
        suffix = 2
        while f"{base_slug}-{suffix}" in taken:
            suffix += 1
        return f"{base_slug}-{suffix}"

    def _validate_collection_endpoint_ids(
        self, cursor, tenant_id: str, endpoint_ids: List[str]
    ) -> None:
        """Ensure every endpoint id exists live in the tenant."""
        if not endpoint_ids:
            return
        cursor.execute(
            """
            SELECT id::text FROM apiome.mcp_endpoints
            WHERE tenant_id = %s::uuid AND deleted_at IS NULL AND id = ANY(%s::uuid[])
            """,
            (tenant_id, endpoint_ids),
        )
        found = {str(r["id"]) for r in cursor.fetchall()}
        missing = [eid for eid in endpoint_ids if eid not in found]
        if missing:
            raise ValueError(f"Unknown endpoint id(s): {', '.join(missing)}")

    def create_mcp_collection(
        self,
        tenant_id: str,
        creator_id: str,
        *,
        name: str,
        slug: str,
        description: Optional[str],
        is_published: bool,
        endpoint_ids: List[str],
    ) -> Dict[str, Any]:
        """Insert a curated collection and optional initial members (MCAT-22.4)."""
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                unique_slug = self._next_available_collection_slug(cur, tenant_id, slug)
                self._validate_collection_endpoint_ids(cur, tenant_id, endpoint_ids)
                cur.execute(
                    f"""
                    INSERT INTO apiome.mcp_collections
                        (tenant_id, name, slug, description, is_published, created_by)
                    VALUES (%s::uuid, %s, %s, %s, %s, %s::uuid)
                    RETURNING {self._MCP_COLLECTION_COLUMNS}
                    """,
                    (tenant_id, name, unique_slug, description, is_published, creator_id),
                )
                row = dict(cur.fetchone())
                collection_id = str(row["id"])
                for position, endpoint_id in enumerate(endpoint_ids):
                    cur.execute(
                        """
                        INSERT INTO apiome.mcp_collection_members
                            (collection_id, tenant_id, endpoint_id, position)
                        VALUES (%s::uuid, %s::uuid, %s::uuid, %s)
                        """,
                        (collection_id, tenant_id, endpoint_id, position),
                    )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        enriched = self.get_mcp_collection(tenant_id, collection_id)
        return enriched if enriched is not None else row

    def update_mcp_collection(
        self,
        tenant_id: str,
        collection_id: str,
        *,
        name: Optional[str] = None,
        slug: Optional[str] = None,
        description: Optional[str] = None,
        is_published: Optional[bool] = None,
        clear_description: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Update mutable collection fields (MCAT-22.4)."""
        fields: List[str] = []
        params: List[Any] = []
        if name is not None:
            fields.append("name = %s")
            params.append(name)
        if slug is not None:
            fields.append("slug = %s")
            params.append(slug)
        if clear_description:
            fields.append("description = NULL")
        elif description is not None:
            fields.append("description = %s")
            params.append(description)
        if is_published is not None:
            fields.append("is_published = %s")
            params.append(is_published)
        if not fields:
            return self.get_mcp_collection(tenant_id, collection_id)
        fields.append("updated_at = CURRENT_TIMESTAMP")
        params.extend([collection_id, tenant_id])
        q = f"""
            UPDATE apiome.mcp_collections
            SET {", ".join(fields)}
            WHERE id = %s::uuid AND tenant_id = %s::uuid
            RETURNING {self._MCP_COLLECTION_COLUMNS}
        """
        rows = self.execute_query(q, tuple(params))
        if not rows:
            return None
        return self.get_mcp_collection(tenant_id, collection_id)

    def delete_mcp_collection(self, tenant_id: str, collection_id: str) -> bool:
        """Delete a curated collection and its memberships (MCAT-22.4)."""
        q = """
            DELETE FROM apiome.mcp_collections
            WHERE id = %s::uuid AND tenant_id = %s::uuid
        """
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(q, (collection_id, tenant_id))
                deleted = cur.rowcount > 0
            conn.commit()
            return deleted
        except Exception:
            conn.rollback()
            raise

    def replace_mcp_collection_members(
        self, tenant_id: str, collection_id: str, endpoint_ids: List[str]
    ) -> List[Dict[str, Any]]:
        """Replace the full membership list for a collection (MCAT-22.4)."""
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1 FROM apiome.mcp_collections
                    WHERE id = %s::uuid AND tenant_id = %s::uuid
                    LIMIT 1
                    """,
                    (collection_id, tenant_id),
                )
                if cur.fetchone() is None:
                    conn.rollback()
                    return []
                self._validate_collection_endpoint_ids(cur, tenant_id, endpoint_ids)
                cur.execute(
                    """
                    DELETE FROM apiome.mcp_collection_members
                    WHERE collection_id = %s::uuid
                    """,
                    (collection_id,),
                )
                for position, endpoint_id in enumerate(endpoint_ids):
                    cur.execute(
                        """
                        INSERT INTO apiome.mcp_collection_members
                            (collection_id, tenant_id, endpoint_id, position)
                        VALUES (%s::uuid, %s::uuid, %s::uuid, %s)
                        """,
                        (collection_id, tenant_id, endpoint_id, position),
                    )
                cur.execute(
                    """
                    UPDATE apiome.mcp_collections
                    SET updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s::uuid
                    """,
                    (collection_id,),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return self.list_mcp_collection_members(tenant_id, collection_id)

    def add_mcp_collection_members(
        self, tenant_id: str, collection_id: str, endpoint_ids: List[str]
    ) -> List[Dict[str, Any]]:
        """Append endpoints to a collection, preserving existing order (MCAT-22.4)."""
        if not endpoint_ids:
            return self.list_mcp_collection_members(tenant_id, collection_id)
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1 FROM apiome.mcp_collections
                    WHERE id = %s::uuid AND tenant_id = %s::uuid
                    LIMIT 1
                    """,
                    (collection_id, tenant_id),
                )
                if cur.fetchone() is None:
                    conn.rollback()
                    return []
                self._validate_collection_endpoint_ids(cur, tenant_id, endpoint_ids)
                cur.execute(
                    """
                    SELECT COALESCE(MAX(position), -1) AS max_pos
                    FROM apiome.mcp_collection_members
                    WHERE collection_id = %s::uuid
                    """,
                    (collection_id,),
                )
                start = int(dict(cur.fetchone())["max_pos"]) + 1
                for offset, endpoint_id in enumerate(endpoint_ids):
                    cur.execute(
                        """
                        INSERT INTO apiome.mcp_collection_members
                            (collection_id, tenant_id, endpoint_id, position)
                        VALUES (%s::uuid, %s::uuid, %s::uuid, %s)
                        ON CONFLICT (collection_id, endpoint_id) DO NOTHING
                        """,
                        (collection_id, tenant_id, endpoint_id, start + offset),
                    )
                cur.execute(
                    """
                    UPDATE apiome.mcp_collections
                    SET updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s::uuid
                    """,
                    (collection_id,),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return self.list_mcp_collection_members(tenant_id, collection_id)

    def remove_mcp_collection_member(
        self, tenant_id: str, collection_id: str, endpoint_id: str
    ) -> bool:
        """Remove one endpoint from a collection (MCAT-22.4)."""
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM apiome.mcp_collection_members m
                    USING apiome.mcp_collections c
                    WHERE m.collection_id = c.id
                      AND c.id = %s::uuid
                      AND c.tenant_id = %s::uuid
                      AND m.endpoint_id = %s::uuid
                    """,
                    (collection_id, tenant_id, endpoint_id),
                )
                deleted = cur.rowcount > 0
                if deleted:
                    cur.execute(
                        """
                        UPDATE apiome.mcp_collections
                        SET updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s::uuid
                        """,
                        (collection_id,),
                    )
            conn.commit()
            return deleted
        except Exception:
            conn.rollback()
            raise

    def get_mcp_endpoint(self, tenant_id: str, endpoint_id: str) -> Optional[Dict[str, Any]]:
        """Fetch one live catalog endpoint scoped to ``tenant_id`` (MCAT-3.1).

        Scoping by ``tenant_id`` is what makes a cross-tenant id read as "not
        found" (the route turns ``None`` into a 404), so an endpoint never leaks
        to another tenant.
        """
        q = f"""
            SELECT {self._MCP_ENDPOINT_COLUMNS}
            FROM apiome.mcp_endpoints
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            LIMIT 1
        """
        rows = self.execute_query(q, (endpoint_id, tenant_id))
        return dict(rows[0]) if rows else None

    def get_published_mcp_endpoint_badge(
        self, tenant_slug: str, endpoint_slug: str
    ) -> Optional[Dict[str, Any]]:
        """Resolve a single **published, public** endpoint by slugs for the public status badge (MCAT-19.3).

        The read source behind the anonymous ``GET /mcp/badge/{tenant}/{slug}.svg`` route (#4652).
        The ``WHERE`` clause is the same public predicate the ``apiome.mcp_v_public_endpoints`` view
        (V134) enforces — the owning tenant is live, and the endpoint is not deleted, is enabled, is
        published, and is public-visible — so an unpublished, private, disabled, or unknown target is
        indistinguishable from a missing one (``None``), and the badge route renders a neutral
        ``unknown`` badge with no data leak. The row is enriched with exactly what the three badge
        metrics need: the current snapshot's ``score`` / ``grade`` (the *grade* metric), the
        server-reported ``server_version`` / ``version_seq`` (the *version* metric), and the
        operational columns :func:`app.mcp_catalog_inventory.derive_health` reads (the *health*
        metric). No credential is selected — the raw ``endpoint_url`` never leaves the database.

        Args:
            tenant_slug: The owning tenant's URL slug.
            endpoint_slug: The endpoint's tenant-unique catalog slug.

        Returns:
            The enriched endpoint row, or ``None`` when no published public endpoint matches the
            slugs (the case the badge route renders as ``unknown``).
        """
        q = """
            SELECT e.id, e.name, e.slug, e.enabled,
                   e.last_discovered_at, e.last_discovery_status,
                   e.consecutive_failures, e.quarantined_at, e.current_version_id,
                   s.score, s.grade,
                   v.server_version, v.version_seq
            FROM apiome.mcp_endpoints e
            JOIN apiome.tenants t ON t.id = e.tenant_id
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            LEFT JOIN apiome.mcp_endpoint_versions v ON v.id = e.current_version_id
            WHERE t.slug = %s
              AND e.slug = %s
              AND t.deleted_at IS NULL
              AND e.deleted_at IS NULL
              AND e.enabled IS TRUE
              AND e.published IS TRUE
              AND e.visibility = 'public'::apiome.visibility_type
            LIMIT 1
        """
        rows = self.execute_query(q, (tenant_slug, endpoint_slug))
        return dict(rows[0]) if rows else None

    #: The shared public gate for the catalog change feed (MCAT-19.4): the owning tenant is live and
    #: the endpoint is not deleted, is enabled, is published, and is public-visible — identical to the
    #: predicate the ``mcp_v_public_endpoints`` view (V134) and the status badge enforce. Feed queries
    #: splice this in so a private, unpublished, disabled, or unknown endpoint is invisible to public
    #: feeds (an acceptance criterion), exactly as it is to public browse.
    _MCP_PUBLIC_ENDPOINT_PREDICATE = (
        "t.deleted_at IS NULL "
        "AND e.deleted_at IS NULL "
        "AND e.enabled IS TRUE "
        "AND e.published IS TRUE "
        "AND e.visibility = 'public'::apiome.visibility_type"
    )

    #: Stable per-snapshot item ordering shared by the change-history reads (server metadata first,
    #: then tools, resources, resource templates, prompts, each by name), matching the compare
    #: engine's emission order so a feed lists a snapshot's changes deterministically.
    _MCP_CHANGE_ITEM_ORDER = (
        "CASE c.item_type "
        "WHEN 'server' THEN 0 "
        "WHEN 'tool' THEN 1 "
        "WHEN 'resource' THEN 2 "
        "WHEN 'resource_template' THEN 3 "
        "WHEN 'prompt' THEN 4 "
        "ELSE 5 END ASC, c.item_name ASC"
    )

    def get_public_mcp_endpoint_feed_head(
        self, tenant_slug: str, endpoint_slug: str
    ) -> Optional[Dict[str, Any]]:
        """Resolve a single **published, public** endpoint by slugs for its change feed (MCAT-19.4).

        The public gate behind the anonymous ``GET /mcp/feed/{tenant}/{slug}`` route (#4653): it
        returns just the endpoint's public identity (id / name / slug / description) when the target
        passes the same predicate the ``mcp_v_public_endpoints`` view enforces, and ``None`` for a
        private, unpublished, disabled, or unknown target — so those are indistinguishable and the
        feed route renders an identical empty feed for all of them, disclosing nothing (a private
        endpoint is excluded from public feeds, an acceptance criterion). No credential (the raw
        ``endpoint_url``) is selected. The change rows themselves are fetched separately by
        :meth:`get_public_mcp_endpoint_changes`, keyed on the ``id`` returned here.

        Args:
            tenant_slug: The owning tenant's URL slug.
            endpoint_slug: The endpoint's tenant-unique catalog slug.

        Returns:
            ``{id, name, slug, description}`` for a resolvable public endpoint, else ``None``.
        """
        q = f"""
            SELECT e.id, e.name, e.slug, e.description
            FROM apiome.mcp_endpoints e
            JOIN apiome.tenants t ON t.id = e.tenant_id
            WHERE t.slug = %s
              AND e.slug = %s
              AND {self._MCP_PUBLIC_ENDPOINT_PREDICATE}
            LIMIT 1
        """
        rows = self.execute_query(q, (tenant_slug, endpoint_slug))
        return dict(rows[0]) if rows else None

    def get_public_mcp_endpoint_changes(
        self, endpoint_id: str, *, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """Fetch a public endpoint's recent change history for its feed, newest snapshot first (MCAT-19.4).

        A read-only projection over ``mcp_version_changes`` joined to the introducing
        ``mcp_endpoint_versions`` snapshot: each row carries the change (``change_type`` / ``item_type``
        / ``item_name`` / ``detail`` — everything :func:`app.mcp_change_severity.classify_change`
        needs) plus the snapshot's ``version_seq`` / ``version_tag`` and its discovery time. Ordered
        newest snapshot first (``version_seq`` desc — the monotonic per-endpoint counter) then the
        stable per-snapshot item order, so the feed lists the latest changes first and deterministically.

        The caller has already resolved ``endpoint_id`` through the public gate
        (:meth:`get_public_mcp_endpoint_feed_head`), so this read is not itself gated — it is only
        ever handed a published, public endpoint's id.

        Args:
            endpoint_id: The public endpoint whose change history to read.
            limit: Maximum change rows to return (the feed's entry cap).

        Returns:
            Up to ``limit`` change rows, newest snapshot first; empty when the endpoint has no
            recorded changes.
        """
        q = f"""
            SELECT c.version_id, c.change_type, c.item_type, c.item_name, c.detail,
                   c.created_at,
                   v.version_seq, v.version_tag, v.discovered_at,
                   v.created_at AS version_created_at
            FROM apiome.mcp_version_changes c
            JOIN apiome.mcp_endpoint_versions v ON v.id = c.version_id
            WHERE v.endpoint_id = %s::uuid
            ORDER BY v.version_seq DESC, {self._MCP_CHANGE_ITEM_ORDER}
            LIMIT %s
        """
        return self.execute_query(q, (endpoint_id, int(limit)))

    def get_public_catalog_changes(
        self, tenant_slug: str, *, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """Fetch a tenant's recent public change history across its whole catalog (MCAT-19.4).

        The catalog-wide analogue behind ``GET /mcp/feed/{tenant}``: recent ``mcp_version_changes``
        across **every published, public endpoint** the tenant owns, each row carrying its owning
        endpoint's public identity (``endpoint_id`` / ``endpoint_name`` / ``endpoint_slug``) alongside
        the change and its snapshot context, so the feed can attribute each entry. The public
        predicate is enforced in SQL, so a private or unpublished endpoint's changes can never leak
        into the catalog feed (an acceptance criterion). No credential is selected.

        Ordered by change recency — the snapshot's discovery time (falling back to its persist time)
        desc — so the feed reads as a catalog-wide activity stream, with endpoint slug and snapshot
        sequence as deterministic tie-breakers.

        Args:
            tenant_slug: The catalog's tenant slug.
            limit: Maximum change rows to return (the feed's entry cap).

        Returns:
            Up to ``limit`` change rows across the tenant's public catalog, most recent first; empty
            when the tenant is unknown, fully private, or has no recorded changes.
        """
        q = f"""
            SELECT e.id AS endpoint_id, e.name AS endpoint_name, e.slug AS endpoint_slug,
                   c.version_id, c.change_type, c.item_type, c.item_name, c.detail,
                   c.created_at,
                   v.version_seq, v.version_tag, v.discovered_at,
                   v.created_at AS version_created_at
            FROM apiome.mcp_version_changes c
            JOIN apiome.mcp_endpoint_versions v ON v.id = c.version_id
            JOIN apiome.mcp_endpoints e ON e.id = v.endpoint_id
            JOIN apiome.tenants t ON t.id = e.tenant_id
            WHERE {self._MCP_PUBLIC_ENDPOINT_PREDICATE}
              AND t.slug = %s
            ORDER BY COALESCE(v.discovered_at, v.created_at) DESC,
                     e.slug ASC, v.version_seq DESC, {self._MCP_CHANGE_ITEM_ORDER}
            LIMIT %s
        """
        return self.execute_query(q, (tenant_slug, int(limit)))

    # --- Scheduled catalog digest (MCAT-19.5, #4654) -------------------------------------------

    def get_mcp_catalog_digest_config(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Read a tenant's scheduled catalog digest configuration (MCAT-19.5).

        Args:
            tenant_id: The owning tenant id.

        Returns:
            ``{tenant_id, enabled, cadence_seconds, send_empty, last_digest_at, created_at,
            updated_at}`` for a configured tenant, or ``None`` when the tenant has never opted in
            (the reader treats absence as ``enabled = False``).
        """
        q = """
            SELECT tenant_id, enabled, cadence_seconds, send_empty, last_digest_at,
                   created_at, updated_at
            FROM apiome.mcp_catalog_digest_configs
            WHERE tenant_id = %s::uuid
        """
        rows = self.execute_query(q, (tenant_id,))
        return dict(rows[0]) if rows else None

    def upsert_mcp_catalog_digest_config(
        self,
        tenant_id: str,
        *,
        enabled: bool,
        cadence_seconds: Optional[int],
        send_empty: bool,
    ) -> Dict[str, Any]:
        """Create or update a tenant's scheduled catalog digest configuration (MCAT-19.5).

        Upserts the per-tenant row (PK ``tenant_id``); ``last_digest_at`` is never touched here (only
        the sweep advances it), so re-configuring cadence/opt-in does not reset the window anchor.

        Args:
            tenant_id: The owning tenant id.
            enabled: Opt-in switch.
            cadence_seconds: Per-tenant cadence in seconds, or ``None`` to use the global default.
                A non-positive value is rejected by the CHECK constraint.
            send_empty: Whether an empty window still sends an explicit "no changes" digest.

        Returns:
            The stored row (same shape as :meth:`get_mcp_catalog_digest_config`).
        """
        q = """
            INSERT INTO apiome.mcp_catalog_digest_configs
                (tenant_id, enabled, cadence_seconds, send_empty)
            VALUES (%s::uuid, %s, %s, %s)
            ON CONFLICT (tenant_id) DO UPDATE
              SET enabled = EXCLUDED.enabled,
                  cadence_seconds = EXCLUDED.cadence_seconds,
                  send_empty = EXCLUDED.send_empty,
                  updated_at = CURRENT_TIMESTAMP
            RETURNING tenant_id, enabled, cadence_seconds, send_empty, last_digest_at,
                      created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (tenant_id, bool(enabled), cadence_seconds, bool(send_empty)))
                row = cursor.fetchone()
                conn.commit()
                return dict(row)
        except Exception as e:
            conn.rollback()
            raise e

    def list_due_mcp_catalog_digests(
        self, *, default_cadence_seconds: int
    ) -> List[Dict[str, Any]]:
        """Return tenants due for a scheduled catalog digest, with their window bounds (MCAT-19.5).

        A tenant is *due* when its digest is opted in (``enabled = TRUE``), its tenant is live, and
        it has either never sent a digest (``last_digest_at IS NULL``) or its effective cadence has
        elapsed. The effective cadence is the per-tenant ``cadence_seconds`` when set, otherwise the
        global ``default_cadence_seconds`` (the "global default + per-tenant override" model). The
        recency comparison and both window bounds are evaluated in the database against a single
        ``now()`` so the window is consistent and free of application clock skew.

        Each returned row carries the digest **window**: ``window_start`` (exclusive) is the last
        digest time, or — for a never-sent tenant — one cadence back from now, so the first digest
        cannot scan the entire history; ``window_end`` (inclusive) is ``now()``. The sweep passes
        these bounds to the window reads and marks ``last_digest_at = window_end`` after delivery, so
        successive windows abut with neither gap nor overlap.

        Args:
            default_cadence_seconds: Global fallback cadence (seconds) for tenants with no explicit
                ``cadence_seconds``.

        Returns:
            ``{tenant_id, tenant_slug, window_start, window_end, send_empty}`` rows, oldest anchor
            first (never-sent tenants first) for fair scheduling.
        """
        cadence = int(default_cadence_seconds)
        if cadence < 1:
            cadence = 1
        q = """
            SELECT c.tenant_id,
                   t.slug AS tenant_slug,
                   COALESCE(
                     c.last_digest_at,
                     now() - make_interval(secs => COALESCE(c.cadence_seconds, %s))
                   ) AS window_start,
                   now() AS window_end,
                   c.send_empty
            FROM apiome.mcp_catalog_digest_configs c
            JOIN apiome.tenants t ON t.id = c.tenant_id
            WHERE c.enabled = TRUE
              AND t.deleted_at IS NULL
              AND (
                c.last_digest_at IS NULL
                OR c.last_digest_at <= now() - make_interval(
                     secs => COALESCE(c.cadence_seconds, %s)
                   )
              )
            ORDER BY c.last_digest_at ASC NULLS FIRST, c.created_at ASC
        """
        return self.execute_query(q, (cadence, cadence))

    def mark_mcp_catalog_digest_sent(self, tenant_id: str, sent_at: Any) -> bool:
        """Advance a tenant's digest anchor to the window end after a digest is processed (MCAT-19.5).

        Called by the sweep once a due tenant's digest has been delivered (or intentionally skipped
        for an empty window), so the next window starts exactly where this one ended and the cadence
        due-check is measured from ``sent_at``. Using the ``window_end`` captured by
        :meth:`list_due_mcp_catalog_digests` keeps the windows contiguous.

        Args:
            tenant_id: The tenant whose anchor to advance.
            sent_at: The window end to record (the ``window_end`` from the due row).

        Returns:
            ``True`` when the config row was updated.
        """
        q = """
            UPDATE apiome.mcp_catalog_digest_configs
            SET last_digest_at = %s, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = %s::uuid
            RETURNING tenant_id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (sent_at, tenant_id))
                row = cursor.fetchone()
                conn.commit()
                return bool(row)
        except Exception as e:
            conn.rollback()
            raise e

    def try_acquire_mcp_catalog_digest_lock(self, tenant_id: str) -> bool:
        """Try to take the per-tenant catalog-digest advisory lock (MCAT-19.5).

        Per-tenant single-flight for the digest sweep, mirroring
        :meth:`try_acquire_repository_refresh_lock`: a Postgres **session** advisory lock keyed on
        the tenant id ensures two workers / overlapping ticks never compile and deliver a digest for
        the same tenant at once (which would double-send). Non-blocking — returns ``False`` at once
        when another session holds it. Acquire/release must run on the same connection (the sweep
        uses one ``Database`` per tick).

        Args:
            tenant_id: The tenant to serialize digests for.

        Returns:
            ``True`` when the lock was acquired, ``False`` when another session holds it.
        """
        rows = self.execute_query(
            "SELECT pg_try_advisory_lock(hashtext(%s)) AS locked",
            (f"mcp-digest:{tenant_id}",),
        )
        return bool(rows and rows[0].get("locked"))

    def release_mcp_catalog_digest_lock(self, tenant_id: str) -> None:
        """Release the per-tenant catalog-digest advisory lock (MCAT-19.5).

        Counterpart to :meth:`try_acquire_mcp_catalog_digest_lock`; must run on the same connection
        that acquired it. Safe to call even if the lock was not held.

        Args:
            tenant_id: The tenant whose lock to release.
        """
        self.execute_query(
            "SELECT pg_advisory_unlock(hashtext(%s)) AS unlocked",
            (f"mcp-digest:{tenant_id}",),
        )

    def list_mcp_new_endpoints_in_window(
        self, tenant_id: str, since: Any, until: Any
    ) -> List[Dict[str, Any]]:
        """Endpoints a tenant registered within ``(since, until]`` (MCAT-19.5).

        Tenant-scoped and live-only (``deleted_at IS NULL``); no ``endpoint_url`` is selected. Feeds
        the digest's "new endpoints" section. Ordered newest first.

        Args:
            tenant_id: The owning tenant id (scopes the read for isolation).
            since: Window start (exclusive).
            until: Window end (inclusive).

        Returns:
            ``{id, name, slug, visibility, created_at}`` rows.
        """
        q = """
            SELECT id, name, slug, visibility, created_at
            FROM apiome.mcp_endpoints
            WHERE tenant_id = %s::uuid
              AND deleted_at IS NULL
              AND created_at > %s
              AND created_at <= %s
            ORDER BY created_at DESC
        """
        return self.execute_query(q, (tenant_id, since, until))

    def list_mcp_grade_movements_in_window(
        self, tenant_id: str, since: Any, until: Any
    ) -> List[Dict[str, Any]]:
        """Endpoints whose quality grade changed between consecutive snapshots in ``(since, until]`` (MCAT-19.5).

        Uses a window function over every scored snapshot of each of the tenant's live endpoints to
        pair each snapshot's grade with the previous scored snapshot's grade (``LAG`` over
        ``version_seq``), then keeps only transitions whose *newer* snapshot was discovered within
        the window and whose grade actually differs. Computing ``LAG`` over the full history (not just
        the window) is what makes "the previous grade" correct even when the prior snapshot predates
        the window. Feeds the digest's "grade movements" section.

        Args:
            tenant_id: The owning tenant id (scopes the read for isolation).
            since: Window start (exclusive).
            until: Window end (inclusive).

        Returns:
            ``{endpoint_id, endpoint_name, endpoint_slug, version_seq, version_tag, moved_at,
            prev_grade, new_grade}`` rows, newest movement first.
        """
        q = """
            WITH graded AS (
                SELECT v.endpoint_id,
                       v.version_seq,
                       v.version_tag,
                       COALESCE(v.discovered_at, v.created_at) AS moved_at,
                       s.grade AS grade,
                       LAG(s.grade) OVER (
                         PARTITION BY v.endpoint_id ORDER BY v.version_seq
                       ) AS prev_grade
                FROM apiome.mcp_endpoint_versions v
                JOIN apiome.mcp_version_scores s ON s.version_id = v.id
                JOIN apiome.mcp_endpoints e ON e.id = v.endpoint_id
                WHERE e.tenant_id = %s::uuid
                  AND e.deleted_at IS NULL
            )
            SELECT g.endpoint_id,
                   e.name AS endpoint_name,
                   e.slug AS endpoint_slug,
                   g.version_seq,
                   g.version_tag,
                   g.moved_at,
                   g.prev_grade,
                   g.grade AS new_grade
            FROM graded g
            JOIN apiome.mcp_endpoints e ON e.id = g.endpoint_id
            WHERE g.prev_grade IS NOT NULL
              AND g.grade IS DISTINCT FROM g.prev_grade
              AND g.moved_at > %s
              AND g.moved_at <= %s
            ORDER BY g.moved_at DESC, e.slug ASC
        """
        return self.execute_query(q, (tenant_id, since, until))

    def list_mcp_catalog_changes_in_window(
        self, tenant_id: str, since: Any, until: Any, *, limit: int = 500
    ) -> List[Dict[str, Any]]:
        """A tenant's capability changes across its whole catalog within ``(since, until]`` (MCAT-19.5).

        Tenant-scoped (every live endpoint, private included — the digest is a private operator
        report, unlike the public change feed) projection over ``mcp_version_changes`` joined to the
        introducing snapshot, carrying everything :func:`app.mcp_change_severity.classify_change`
        needs plus the owning endpoint's identity and snapshot context. The digest compiler runs the
        shared severity classifier over these rows and keeps the breaking ones, so severity is not
        re-implemented in SQL. Ordered newest first and bounded by ``limit``.

        Args:
            tenant_id: The owning tenant id (scopes the read for isolation).
            since: Window start (exclusive).
            until: Window end (inclusive).
            limit: Maximum change rows to return.

        Returns:
            Change rows with endpoint identity + snapshot context, newest first.
        """
        q = f"""
            SELECT e.id AS endpoint_id, e.name AS endpoint_name, e.slug AS endpoint_slug,
                   c.version_id, c.change_type, c.item_type, c.item_name, c.detail,
                   c.created_at,
                   v.version_seq, v.version_tag, v.discovered_at,
                   v.created_at AS version_created_at
            FROM apiome.mcp_version_changes c
            JOIN apiome.mcp_endpoint_versions v ON v.id = c.version_id
            JOIN apiome.mcp_endpoints e ON e.id = v.endpoint_id
            WHERE e.tenant_id = %s::uuid
              AND e.deleted_at IS NULL
              AND COALESCE(v.discovered_at, v.created_at) > %s
              AND COALESCE(v.discovered_at, v.created_at) <= %s
            ORDER BY COALESCE(v.discovered_at, v.created_at) DESC,
                     e.slug ASC, v.version_seq DESC, {self._MCP_CHANGE_ITEM_ORDER}
            LIMIT %s
        """
        return self.execute_query(q, (tenant_id, since, until, int(limit)))

    def list_mcp_health_problems_in_window(
        self, tenant_id: str, since: Any, until: Any
    ) -> List[Dict[str, Any]]:
        """A tenant's endpoints with a discovery-health problem observed in ``(since, until]`` (MCAT-19.5).

        Returns live endpoints that either became **quarantined** within the window
        (``quarantined_at`` in range — the MCAT-5.3 failure-threshold trip) or are currently
        **failing** discovery with their last attempt in the window (``consecutive_failures > 0`` and
        ``last_discovered_at`` in range). Feeds the digest's "discovery-health problems" section. No
        ``endpoint_url`` is selected.

        Args:
            tenant_id: The owning tenant id (scopes the read for isolation).
            since: Window start (exclusive).
            until: Window end (inclusive).

        Returns:
            ``{id, name, slug, visibility, quarantined_at, quarantine_reason, consecutive_failures,
            last_discovery_status, last_discovered_at}`` rows.
        """
        q = """
            SELECT id, name, slug, visibility,
                   quarantined_at, quarantine_reason, consecutive_failures,
                   last_discovery_status, last_discovered_at
            FROM apiome.mcp_endpoints
            WHERE tenant_id = %s::uuid
              AND deleted_at IS NULL
              AND (
                (quarantined_at IS NOT NULL AND quarantined_at > %s AND quarantined_at <= %s)
                OR (consecutive_failures > 0
                    AND last_discovered_at IS NOT NULL
                    AND last_discovered_at > %s AND last_discovered_at <= %s)
              )
            ORDER BY quarantined_at DESC NULLS LAST, last_discovered_at DESC NULLS LAST
        """
        return self.execute_query(q, (tenant_id, since, until, since, until))

    def list_due_mcp_endpoints(
        self,
        *,
        default_cadence_seconds: int,
    ) -> List[Dict[str, Any]]:
        """Return endpoints due for a periodic re-discovery sweep tick (MCAT-5.1, #3673).

        An endpoint is *due* when it is live (``deleted_at IS NULL``), turned on
        (``enabled = TRUE``), and either has never been discovered
        (``last_discovered_at IS NULL``) or at least its effective cadence has
        elapsed since the last attempt. The effective cadence is the per-endpoint
        ``discovery_cadence_seconds`` when set, otherwise the global
        ``default_cadence_seconds`` — this is the "global default + per-endpoint
        override" model from the ticket. The recency comparison is evaluated in the
        database against ``now()`` so it never depends on application clock skew.

        Disabled and soft-deleted endpoints are excluded here, so the sweep
        (:func:`mcp_discovery_sweep.process_mcp_discovery_sweep`) never has to
        re-check them. Ordering is oldest-first (NULLs — never discovered — first)
        so attention is spread fairly and a brand-new endpoint is picked up promptly.

        Failure handling (MCAT-5.3, #3675) adds two more carve-outs so a flaky/dead
        endpoint cannot wedge the sweep or spam failures: a **quarantined** endpoint
        (``quarantined_at IS NOT NULL`` — it tripped the consecutive-failure threshold)
        is excluded entirely until it recovers or an operator clears it, and an endpoint
        still inside its **backoff window** (``next_discovery_after`` in the future) is
        skipped even when its cadence has otherwise elapsed. Both are reset on the next
        successful contact, so a recovered endpoint rejoins the sweep automatically.

        Note: unlike the V126 column comment's original "null means no automatic
        discovery", a null ``discovery_cadence_seconds`` now means "use the global
        default cadence". The real on/off switch is the ``enabled`` column, so an
        operator opts an endpoint out of the sweep by disabling it, not by clearing
        its cadence.

        Args:
            default_cadence_seconds: Global fallback cadence (seconds) applied to
                endpoints with no explicit ``discovery_cadence_seconds``.

        Returns:
            Endpoint rows due for re-discovery, oldest ``last_discovered_at`` first
            (never-discovered endpoints first) for fair scheduling.
        """
        cadence = int(default_cadence_seconds)
        if cadence < 1:
            cadence = 1
        q = f"""
            SELECT {self._MCP_ENDPOINT_COLUMNS}
            FROM apiome.mcp_endpoints
            WHERE deleted_at IS NULL
              AND enabled = TRUE
              AND quarantined_at IS NULL
              AND (next_discovery_after IS NULL OR next_discovery_after <= now())
              AND (
                last_discovered_at IS NULL
                OR last_discovered_at <= now() - make_interval(
                     secs => COALESCE(discovery_cadence_seconds, %s)
                   )
              )
            ORDER BY last_discovered_at ASC NULLS FIRST, created_at ASC
        """
        return self.execute_query(q, (cadence,))

    def _next_available_mcp_slug(self, cursor, tenant_id: str, base_slug: str) -> str:
        """Pick a tenant-unique slug derived from ``base_slug``.

        Returns ``base_slug`` when free, otherwise the first free ``base_slug-N``
        (N starting at 2). Collision detection considers *all* rows for the tenant
        — including soft-deleted ones — because the ``(tenant_id, slug)`` unique
        constraint (V126) counts deleted rows too, so reusing a deleted endpoint's
        slug would still violate it. Runs on the caller's cursor inside the insert
        transaction so the check and the insert see a consistent snapshot.
        """
        cursor.execute(
            """
            SELECT slug FROM apiome.mcp_endpoints
            WHERE tenant_id = %s::uuid AND (slug = %s OR slug LIKE %s)
            """,
            (tenant_id, base_slug, f"{base_slug}-%"),
        )
        taken = {str(r["slug"]) for r in cursor.fetchall()}
        if base_slug not in taken:
            return base_slug
        suffix = 2
        while f"{base_slug}-{suffix}" in taken:
            suffix += 1
        return f"{base_slug}-{suffix}"

    def insert_mcp_endpoint(
        self,
        *,
        tenant_id: str,
        creator_id: str,
        name: str,
        base_slug: str,
        endpoint_url: str,
        transport: str,
        description: Optional[str] = None,
        category: Optional[str] = None,
        visibility: str = "private",
        discovery_cadence_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Insert a catalog endpoint, resolving a tenant-unique slug (MCAT-3.1).

        Args:
            tenant_id: Owning tenant.
            creator_id: User registering the endpoint (``creator_id`` is NOT NULL).
            name: Friendly display name.
            base_slug: Already-slugified candidate; uniquified per tenant here.
            endpoint_url: The MCP server URL (or stdio command target).
            transport: One of ``streamable_http`` / ``sse`` / ``stdio``.
            description: Optional free-text description.
            category: Optional catalog category.
            visibility: ``private`` (default) or ``public``.
            discovery_cadence_seconds: Optional positive re-discovery cadence.

        Returns:
            The inserted row projected onto :attr:`_MCP_ENDPOINT_COLUMNS`.
        """
        q = f"""
            INSERT INTO apiome.mcp_endpoints (
                tenant_id, creator_id, name, slug, endpoint_url, transport,
                description, category, visibility, discovery_cadence_seconds
            ) VALUES (
                %s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s
            )
            RETURNING {self._MCP_ENDPOINT_COLUMNS}
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                slug = self._next_available_mcp_slug(cursor, tenant_id, base_slug)
                cursor.execute(
                    q,
                    (
                        tenant_id,
                        creator_id,
                        name,
                        slug,
                        endpoint_url,
                        transport,
                        description,
                        category,
                        visibility,
                        discovery_cadence_seconds,
                    ),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)
        except Exception as e:
            conn.rollback()
            raise e

    # Columns a PATCH may update, mapped to whether they need a cast in SQL.
    _MCP_ENDPOINT_UPDATABLE = (
        "name",
        "endpoint_url",
        "transport",
        "description",
        "category",
        "visibility",
        "published",
        "enabled",
        "discovery_cadence_seconds",
    )

    def update_mcp_endpoint(
        self,
        tenant_id: str,
        endpoint_id: str,
        fields: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """Apply a partial update to a live catalog endpoint (MCAT-3.1).

        Only the keys present in ``fields`` (restricted to
        :attr:`_MCP_ENDPOINT_UPDATABLE`) are written; ``updated_at`` is always
        bumped. The update is scoped to ``tenant_id`` so a cross-tenant id matches
        no row.

        Args:
            tenant_id: Owning tenant (scopes the update for isolation).
            endpoint_id: The endpoint to patch.
            fields: Column → value map of changes to apply.

        Returns:
            The updated row, or ``None`` when no live endpoint matched the tenant
            + id (the route maps this to a 404). When ``fields`` is empty the row
            is returned unchanged.
        """
        updates = {k: v for k, v in fields.items() if k in self._MCP_ENDPOINT_UPDATABLE}
        if not updates:
            return self.get_mcp_endpoint(tenant_id, endpoint_id)

        set_clauses = [f"{col} = %s" for col in updates]
        set_clauses.append("updated_at = CURRENT_TIMESTAMP")
        params: List[Any] = list(updates.values())
        params.extend([endpoint_id, tenant_id])

        q = f"""
            UPDATE apiome.mcp_endpoints
            SET {", ".join(set_clauses)}
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            RETURNING {self._MCP_ENDPOINT_COLUMNS}
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, tuple(params))
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def soft_delete_mcp_endpoint(
        self,
        tenant_id: str,
        endpoint_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Retire a catalog endpoint and purge its child data (MCAT-3.5, #3667).

        The endpoint row is *soft* deleted — stamped with ``deleted_at`` (and
        flipped to ``enabled = false`` with ``current_version_id`` cleared) so it
        drops out of browse/list/get and is skipped by the discovery sweep, while
        its slug stays reserved against the ``(tenant_id, slug)`` unique
        constraint. Its children, by contrast, are *hard* deleted so no stale or
        sensitive data survives the endpoint: the credential vault row (the
        security-critical purge), all discovery jobs, and all version snapshots —
        which cascade-reap their capability items, change logs and scores via the
        ``ON DELETE CASCADE`` chain off ``mcp_endpoint_versions`` (V128/V130).

        Everything runs in one transaction scoped to ``tenant_id``: a cross-tenant
        or already-deleted id matches no live row, so nothing is touched and
        ``None`` is returned (the route maps that to a 404).

        Args:
            tenant_id: Owning tenant (scopes the delete for isolation).
            endpoint_id: The endpoint to retire.

        Returns:
            A teardown summary — ``{"endpoint_id", "credentials_purged",
            "versions_deleted", "jobs_deleted"}`` — or ``None`` when no live
            endpoint matched the tenant + id.
        """
        # Retire the endpoint first; the WHERE clause is the existence/ownership
        # guard, so a no-match short-circuits before any child rows are touched.
        retire = """
            UPDATE apiome.mcp_endpoints
            SET deleted_at = CURRENT_TIMESTAMP,
                enabled = false,
                current_version_id = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
            RETURNING id
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(retire, (endpoint_id, tenant_id))
                if cursor.fetchone() is None:
                    conn.rollback()
                    return None

                cursor.execute(
                    "DELETE FROM apiome.mcp_endpoint_credentials WHERE endpoint_id = %s::uuid",
                    (endpoint_id,),
                )
                credentials_purged = (cursor.rowcount or 0) > 0

                cursor.execute(
                    "DELETE FROM apiome.mcp_discovery_jobs WHERE endpoint_id = %s::uuid",
                    (endpoint_id,),
                )
                jobs_deleted = cursor.rowcount or 0

                # Versions cascade-reap capability items, version changes and
                # scores (V128/V130), so this single delete clears the snapshot tree.
                cursor.execute(
                    "DELETE FROM apiome.mcp_endpoint_versions WHERE endpoint_id = %s::uuid",
                    (endpoint_id,),
                )
                versions_deleted = cursor.rowcount or 0

                conn.commit()
                return {
                    "endpoint_id": endpoint_id,
                    "credentials_purged": credentials_purged,
                    "versions_deleted": versions_deleted,
                    "jobs_deleted": jobs_deleted,
                }
        except Exception as e:
            conn.rollback()
            raise e

    # -----------------------------------------------------------------------
    # MCP Catalog — discovery jobs & version persistence (MCAT-3.2, #3664)
    # -----------------------------------------------------------------------

    # Columns returned for every discovery-job read/write. Kept as one constant so
    # enqueue/get/list/transition all project the same shape.
    _MCP_DISCOVERY_JOB_COLUMNS = (
        "id, endpoint_id, tenant_id, state, trigger, started_at, finished_at, "
        "error, result, created_at"
    )

    # A discovery job is "active" (and therefore a de-duplication target) while it is
    # still queued or running; completed/failed jobs never coalesce a new request.
    _MCP_DISCOVERY_ACTIVE_STATES = ("queued", "running")

    def enqueue_mcp_discovery_job(
        self,
        endpoint_id: str,
        tenant_id: str,
        trigger: str = "manual",
    ) -> Dict[str, Any]:
        """Create a queued discovery job for an endpoint, de-duplicating concurrent runs.

        A transaction-scoped Postgres advisory lock keyed on the endpoint serializes
        concurrent callers so the "is one already active?" check and the insert see a
        consistent snapshot: if a queued/running job already exists for the endpoint the
        existing row is returned instead of inserting a second one. The lock is released
        automatically when the transaction commits.

        Args:
            endpoint_id: The endpoint to discover (assumed already tenant-validated).
            tenant_id: Owning tenant, stamped on the job for scoped reads.
            trigger: How the run was initiated — one of ``manual`` / ``sweep`` /
                ``registry`` (this REST path always passes ``manual``).

        Returns:
            ``{"job": <row>, "deduplicated": bool}`` — ``deduplicated`` is ``True`` when an
            already-active job was returned rather than a new one being created.
        """
        select_active = f"""
            SELECT {self._MCP_DISCOVERY_JOB_COLUMNS}
            FROM apiome.mcp_discovery_jobs
            WHERE endpoint_id = %s::uuid AND state = ANY(%s)
            ORDER BY created_at ASC
            LIMIT 1
        """
        insert_job = f"""
            INSERT INTO apiome.mcp_discovery_jobs (endpoint_id, tenant_id, trigger)
            VALUES (%s::uuid, %s::uuid, %s)
            RETURNING {self._MCP_DISCOVERY_JOB_COLUMNS}
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                # Serialize per endpoint so the dedupe check below cannot race a
                # concurrent insert. hashtext() maps the id to the int the advisory
                # lock expects; the lock is held until commit.
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s))", (str(endpoint_id),)
                )
                cursor.execute(
                    select_active,
                    (endpoint_id, list(self._MCP_DISCOVERY_ACTIVE_STATES)),
                )
                existing = cursor.fetchone()
                if existing is not None:
                    conn.commit()
                    return {"job": dict(existing), "deduplicated": True}
                cursor.execute(insert_job, (endpoint_id, tenant_id, trigger))
                row = cursor.fetchone()
                conn.commit()
                return {"job": dict(row), "deduplicated": False}
        except Exception as e:
            conn.rollback()
            raise e

    def get_mcp_discovery_job(
        self, tenant_id: str, job_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one discovery job scoped to ``tenant_id`` (a cross-tenant id reads as None)."""
        q = f"""
            SELECT {self._MCP_DISCOVERY_JOB_COLUMNS}
            FROM apiome.mcp_discovery_jobs
            WHERE id = %s::uuid AND tenant_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (job_id, tenant_id))
        return dict(rows[0]) if rows else None

    def list_mcp_discovery_jobs(
        self, tenant_id: str, endpoint_id: str
    ) -> List[Dict[str, Any]]:
        """List discovery jobs for one endpoint (newest first), scoped to the tenant."""
        q = f"""
            SELECT {self._MCP_DISCOVERY_JOB_COLUMNS}
            FROM apiome.mcp_discovery_jobs
            WHERE endpoint_id = %s::uuid AND tenant_id = %s::uuid
            ORDER BY created_at DESC
        """
        return self.execute_query(q, (endpoint_id, tenant_id))

    def mark_mcp_discovery_job_running(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Transition a queued job to ``running`` and stamp ``started_at``.

        Idempotent in spirit: the WHERE clause only advances a job that is still
        ``queued`` so a double-start is a no-op (returns ``None``).
        """
        q = f"""
            UPDATE apiome.mcp_discovery_jobs
            SET state = 'running', started_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND state = 'queued'
            RETURNING {self._MCP_DISCOVERY_JOB_COLUMNS}
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (job_id,))
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def finish_mcp_discovery_job(
        self,
        job_id: str,
        state: str,
        *,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Move a job to a terminal state (``completed`` / ``failed``).

        Stamps ``finished_at`` and writes the JSONB ``result`` payload (which carries the
        ``version_id`` reference on success) and/or the ``error`` text on failure.
        """
        q = f"""
            UPDATE apiome.mcp_discovery_jobs
            SET state = %s,
                finished_at = CURRENT_TIMESTAMP,
                result = COALESCE(%s, result),
                error = %s
            WHERE id = %s::uuid
            RETURNING {self._MCP_DISCOVERY_JOB_COLUMNS}
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    q,
                    (
                        state,
                        Json(result) if result is not None else None,
                        error,
                        job_id,
                    ),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception as e:
            conn.rollback()
            raise e

    def get_latest_mcp_endpoint_version(
        self, endpoint_id: str
    ) -> Optional[Dict[str, Any]]:
        """Return the highest-``version_seq`` snapshot for an endpoint, or None if never discovered."""
        q = """
            SELECT id, endpoint_id, version_seq, version_tag, protocol_version,
                   server_name, server_title, server_version, instructions,
                   capabilities, surface_fingerprint, server_branding,
                   discovery_trigger, discovery_job_id, discovered_at, created_at
            FROM apiome.mcp_endpoint_versions
            WHERE endpoint_id = %s::uuid
            ORDER BY version_seq DESC
            LIMIT 1
        """
        rows = self.execute_query(q, (endpoint_id,))
        return dict(rows[0]) if rows else None

    def get_mcp_capability_items(self, version_id: str) -> List[Dict[str, Any]]:
        """Fetch the normalized capability rows of a version snapshot (discovery order)."""
        q = """
            SELECT version_id, item_type, name, title, description, input_schema,
                   output_schema, annotations, uri, uri_template, raw, ordinal
            FROM apiome.mcp_capability_items
            WHERE version_id = %s::uuid
            ORDER BY item_type ASC, ordinal ASC
        """
        return self.execute_query(q, (version_id,))

    # The per-change-type tally a version-history row carries, computed by joining the
    # snapshot to its ``mcp_version_changes`` and counting each direction (plus a total).
    # Defined once so the list and single-version reads stay byte-identical.
    _MCP_VERSION_CHANGE_COUNTS = """
        COUNT(c.id) FILTER (WHERE c.change_type = 'added')    AS added_count,
        COUNT(c.id) FILTER (WHERE c.change_type = 'removed')  AS removed_count,
        COUNT(c.id) FILTER (WHERE c.change_type = 'modified') AS modified_count,
        COUNT(c.id)                                           AS total_count
    """

    def list_mcp_endpoint_versions(self, endpoint_id: str) -> List[Dict[str, Any]]:
        """List an endpoint's version snapshots newest-first, with score and change counts.

        Each row carries the snapshot's identity (``version_seq``, the human-readable
        ``version_tag``, server/protocol identity, ``surface_fingerprint``, timings), its
        quality ``score`` / ``grade`` from ``mcp_version_scores`` (NULL when not yet scored),
        and the per-direction tally of ``mcp_version_changes`` it introduced — exactly the
        fields a "version history" timeline renders. Ordered by ``version_seq`` descending so
        the latest snapshot is first.

        Args:
            endpoint_id: Owning endpoint whose history to read (already tenant-validated by
                the caller).

        Returns:
            One dict per snapshot, newest first; empty when the endpoint was never discovered.
        """
        q = f"""
            SELECT v.id, v.endpoint_id, v.version_seq, v.version_tag, v.protocol_version,
                   v.server_name, v.server_title, v.server_version, v.surface_fingerprint,
                   v.server_branding, v.discovery_trigger, v.discovery_job_id,
                   v.discovered_at, v.created_at,
                   s.score, s.grade, s.scored_at,
                   {self._MCP_VERSION_CHANGE_COUNTS}
            FROM apiome.mcp_endpoint_versions v
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = v.id
            LEFT JOIN apiome.mcp_version_changes c ON c.version_id = v.id
            WHERE v.endpoint_id = %s::uuid
            GROUP BY v.id, s.score, s.grade, s.scored_at
            ORDER BY v.version_seq DESC
        """
        return self.execute_query(q, (endpoint_id,))

    def get_mcp_endpoint_version(
        self, endpoint_id: str, version_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one version snapshot scoped to its endpoint, with score and change counts.

        Returns the full surface-identity columns (including ``instructions`` and the
        declared ``capabilities`` blob, which the list view omits) plus the same score and
        change-count aggregates as :meth:`list_mcp_endpoint_versions`. The ``endpoint_id``
        predicate is the scoping guard: a version id belonging to another endpoint (and thus,
        once the caller has tenant-validated the endpoint, another tenant) reads as ``None``.

        Args:
            endpoint_id: Owning endpoint the version must belong to.
            version_id: The snapshot to fetch.

        Returns:
            The snapshot row, or ``None`` when no such version exists under this endpoint.
        """
        q = f"""
            SELECT v.id, v.endpoint_id, v.version_seq, v.version_tag, v.protocol_version,
                   v.server_name, v.server_title, v.server_version, v.instructions,
                   v.capabilities, v.surface_fingerprint, v.server_branding,
                   v.discovery_trigger, v.discovery_job_id,
                   v.discovered_at, v.created_at,
                   s.score, s.grade, s.scored_at,
                   {self._MCP_VERSION_CHANGE_COUNTS}
            FROM apiome.mcp_endpoint_versions v
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = v.id
            LEFT JOIN apiome.mcp_version_changes c ON c.version_id = v.id
            WHERE v.endpoint_id = %s::uuid AND v.id = %s::uuid
            GROUP BY v.id, s.score, s.grade, s.scored_at
        """
        rows = self.execute_query(q, (endpoint_id, version_id))
        return dict(rows[0]) if rows else None

    def get_mcp_version_changes(self, version_id: str) -> List[Dict[str, Any]]:
        """Fetch the stored ``previous → this`` diff rows for a version, in stable order.

        Returns the ``mcp_version_changes`` rows the snapshot introduced relative to the
        version before it (empty for the first version, which introduces no diff). Ordered to
        match the on-demand compare engine's emission order — server metadata first, then
        tools, resources, resource templates, prompts, each by name — so the persisted change
        report and a live compare of the same pair render identically.

        Args:
            version_id: The snapshot whose change records to read.

        Returns:
            One dict per change row, in stable order; empty when the version recorded no diff.
        """
        q = """
            SELECT version_id, change_type, item_type, item_name, detail, created_at
            FROM apiome.mcp_version_changes
            WHERE version_id = %s::uuid
            ORDER BY
                CASE item_type
                    WHEN 'server' THEN 0
                    WHEN 'tool' THEN 1
                    WHEN 'resource' THEN 2
                    WHEN 'resource_template' THEN 3
                    WHEN 'prompt' THEN 4
                    ELSE 5
                END ASC,
                item_name ASC
        """
        return self.execute_query(q, (version_id,))

    def get_mcp_version_changes_for_endpoint(self, endpoint_id: str) -> List[Dict[str, Any]]:
        """Fetch every ``mcp_version_changes`` row across all of an endpoint's snapshots.

        The per-endpoint analogue of :meth:`get_mcp_version_changes`: one flat list spanning
        every version the endpoint owns, each row carrying its ``version_id`` so the caller
        can bucket the changes by snapshot (e.g. to classify each snapshot's churn severity
        for the evolution series) without issuing one query per version. Ordered by
        ``version_seq`` then the same stable item order a single-version fetch uses, so a
        given snapshot's rows are contiguous and deterministically ordered.

        Args:
            endpoint_id: The owning endpoint (already tenant-validated by the caller).

        Returns:
            One dict per change row across all snapshots; empty when the endpoint has none.
        """
        q = """
            SELECT c.version_id, c.change_type, c.item_type, c.item_name, c.detail
            FROM apiome.mcp_version_changes c
            JOIN apiome.mcp_endpoint_versions v ON v.id = c.version_id
            WHERE v.endpoint_id = %s::uuid
            ORDER BY
                v.version_seq ASC,
                CASE c.item_type
                    WHEN 'server' THEN 0
                    WHEN 'tool' THEN 1
                    WHEN 'resource' THEN 2
                    WHEN 'resource_template' THEN 3
                    WHEN 'prompt' THEN 4
                    ELSE 5
                END ASC,
                c.item_name ASC
        """
        return self.execute_query(q, (endpoint_id,))

    def get_mcp_endpoint_view(
        self, user_id: str, endpoint_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch a user's seen-marker for an endpoint (V2-MCP-30.5, #4640).

        Returns the ``mcp_endpoint_views`` row recording which version snapshot the user last
        saw, joined to that snapshot's ``version_seq`` / ``version_tag`` for the digest header.
        A ``None`` result means the user has never viewed the endpoint (the digest then reads as
        "new to you"); a row whose ``last_seen_version_id`` is ``NULL`` means the version they
        last saw has since been pruned (also "new to you").

        Scoping is by ``user_id`` + ``endpoint_id``; the caller has already validated the
        endpoint against the token tenant, so this never leaks another user's or tenant's marker.

        Args:
            user_id: The viewing user.
            endpoint_id: The endpoint the marker is for.

        Returns:
            The seen-marker row (``last_seen_version_id``, ``seen_at``, ``last_seen_version_seq``,
            ``last_seen_version_tag``), or ``None`` when no marker exists.
        """
        q = """
            SELECT vw.last_seen_version_id, vw.seen_at, vw.created_at,
                   v.version_seq AS last_seen_version_seq,
                   v.version_tag AS last_seen_version_tag
            FROM apiome.mcp_endpoint_views vw
            LEFT JOIN apiome.mcp_endpoint_versions v ON v.id = vw.last_seen_version_id
            WHERE vw.user_id = %s::uuid AND vw.endpoint_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (user_id, endpoint_id))
        return dict(rows[0]) if rows else None

    def record_mcp_endpoint_view(
        self, user_id: str, endpoint_id: str, last_seen_version_id: Optional[str]
    ) -> Dict[str, Any]:
        """Upsert a user's seen-marker, advancing it to the version they just saw (#4640).

        One marker per ``(user, endpoint)``: the first view inserts it, every later view advances
        ``last_seen_version_id`` to the newly-seen snapshot and moves ``seen_at`` to now (the
        ``ON CONFLICT`` path). ``created_at`` is set once and never moved. This is what "the marker
        advances on view" means — after this call the digest for the same version reads as
        up-to-date until the endpoint is re-discovered.

        Args:
            user_id: The viewing user (already resolved by the caller; NOT NULL on the table).
            endpoint_id: The endpoint being viewed.
            last_seen_version_id: The snapshot the user saw (the endpoint's current version, or an
                explicitly acknowledged one). ``None`` is allowed by the column but the route only
                records a view when there is a concrete version to mark.

        Returns:
            The upserted marker row (``last_seen_version_id``, ``seen_at``).
        """
        query = """
            INSERT INTO apiome.mcp_endpoint_views (user_id, endpoint_id, last_seen_version_id)
            VALUES (%s::uuid, %s::uuid, %s::uuid)
            ON CONFLICT (user_id, endpoint_id) DO UPDATE SET
                last_seen_version_id = EXCLUDED.last_seen_version_id,
                seen_at = CURRENT_TIMESTAMP
            RETURNING last_seen_version_id, seen_at
        """
        rows = self.execute_query(
            query, (user_id, endpoint_id, last_seen_version_id)
        )
        return dict(rows[0]) if rows else {}

    def _next_mcp_version_tag(self, cursor: Any, endpoint_id: str, base_tag: str) -> str:
        """Resolve a per-endpoint-unique date/time tag, disambiguating same-minute collisions.

        The base tag is minute-precision (e.g. ``2026-06-26T14:03Z``), so two material surface
        changes to one endpoint inside a single minute would map to the same label. Mirroring how
        ``version_seq`` is allocated, the second and subsequent collisions get a ``-2``, ``-3``, …
        suffix. Lookups run inside the caller's open transaction; two concurrent persists could
        still both pick the same tag, in which case the ``(endpoint_id, version_tag)`` unique
        constraint (V131) is the backstop that fails the loser loudly.

        Args:
            cursor: An open cursor on the in-progress transaction.
            endpoint_id: Owning endpoint the tag must be unique within.
            base_tag: The minute-precision base label from :func:`format_mcp_version_tag`.

        Returns:
            The first free tag — ``base_tag`` itself, or ``base_tag`` with a ``-N`` suffix.
        """
        candidate = base_tag
        suffix = 1
        while True:
            cursor.execute(
                """
                SELECT 1 FROM apiome.mcp_endpoint_versions
                WHERE endpoint_id = %s::uuid AND version_tag = %s
                LIMIT 1
                """,
                (endpoint_id, candidate),
            )
            if cursor.fetchone() is None:
                return candidate
            suffix += 1
            candidate = f"{base_tag}-{suffix}"

    def record_mcp_discovery_version(
        self,
        endpoint_id: str,
        *,
        version_row: Dict[str, Any],
        capability_rows: List[Dict[str, Any]],
        change_rows: List[Dict[str, Any]],
        discovered_at: Any,
        discovery_trigger: Optional[str] = None,
        discovery_job_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Persist a new version snapshot atomically and point the endpoint at it.

        In one transaction this: assigns the next ``version_seq`` for the endpoint, stamps a
        unique human-readable date/time ``version_tag``, inserts the immutable
        ``mcp_endpoint_versions`` row, its ``mcp_capability_items`` children, and any
        ``mcp_version_changes`` diff rows, then updates the endpoint's ``current_version_id`` /
        ``last_discovered_at`` / ``last_discovery_status``.

        Args:
            endpoint_id: Owning endpoint.
            version_row: Surface columns from :meth:`DiscoverySurface.to_version_row`.
            capability_rows: Rows from :meth:`DiscoverySurface.to_capability_rows`
                (``version_id`` is overwritten here with the freshly assigned id).
            change_rows: Diff rows (``change_type`` / ``item_type`` / ``item_name`` /
                ``detail``) relative to the previous version; empty for a first run.
            discovered_at: When the discovery that produced this snapshot ran; also the source
                of the ``version_tag`` date/time label.
            discovery_trigger: Provenance of the producing run (``manual`` / ``sweep`` /
                ``registry``, the job's V130 ``trigger``); ``None`` records "unrecorded"
                (V2-MCP-34.5).
            discovery_job_id: The producing ``mcp_discovery_jobs`` id, stored as a plain
                audit pointer (deliberately no FK — see V148).

        Returns:
            ``{"version_id": str, "version_seq": int, "version_tag": str}`` for the new snapshot.
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                # Next monotonic per-endpoint sequence (1 on first run). Computed under
                # the transaction so two concurrent persists cannot collide; the
                # (endpoint_id, version_seq) unique constraint is the final backstop.
                cursor.execute(
                    """
                    SELECT COALESCE(MAX(version_seq), 0) + 1 AS next_seq
                    FROM apiome.mcp_endpoint_versions
                    WHERE endpoint_id = %s::uuid
                    """,
                    (endpoint_id,),
                )
                next_seq = int(cursor.fetchone()["next_seq"])

                # Human-readable, per-endpoint-unique date/time tag for this snapshot (#3671).
                # The base label is minute-precision UTC; collisions within a minute are
                # disambiguated with a -N suffix, backstopped by the unique constraint (V131).
                version_tag = self._next_mcp_version_tag(
                    cursor, endpoint_id, format_mcp_version_tag(discovered_at)
                )

                cursor.execute(
                    """
                    INSERT INTO apiome.mcp_endpoint_versions (
                        endpoint_id, version_seq, version_tag, protocol_version, server_name,
                        server_title, server_version, instructions, capabilities,
                        surface_fingerprint, server_branding, discovery_trigger,
                        discovery_job_id, discovered_at
                    ) VALUES (
                        %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::uuid, %s
                    )
                    RETURNING id
                    """,
                    (
                        endpoint_id,
                        next_seq,
                        version_tag,
                        version_row.get("protocol_version"),
                        version_row.get("server_name"),
                        version_row.get("server_title"),
                        version_row.get("server_version"),
                        version_row.get("instructions"),
                        Json(version_row.get("capabilities"))
                        if version_row.get("capabilities") is not None
                        else None,
                        version_row.get("surface_fingerprint"),
                        Json(version_row.get("server_branding"))
                        if version_row.get("server_branding") is not None
                        else None,
                        discovery_trigger,
                        discovery_job_id,
                        discovered_at,
                    ),
                )
                version_id = str(cursor.fetchone()["id"])

                for item in capability_rows:
                    cursor.execute(
                        """
                        INSERT INTO apiome.mcp_capability_items (
                            version_id, item_type, name, title, description,
                            input_schema, output_schema, annotations, uri,
                            uri_template, raw, ordinal
                        ) VALUES (
                            %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                        )
                        """,
                        (
                            version_id,
                            item.get("item_type"),
                            item.get("name"),
                            item.get("title"),
                            item.get("description"),
                            Json(item["input_schema"])
                            if item.get("input_schema") is not None
                            else None,
                            Json(item["output_schema"])
                            if item.get("output_schema") is not None
                            else None,
                            Json(item["annotations"])
                            if item.get("annotations") is not None
                            else None,
                            item.get("uri"),
                            item.get("uri_template"),
                            Json(item.get("raw") if item.get("raw") is not None else {}),
                            item.get("ordinal"),
                        ),
                    )

                for change in change_rows:
                    cursor.execute(
                        """
                        INSERT INTO apiome.mcp_version_changes (
                            version_id, change_type, item_type, item_name, detail
                        ) VALUES (
                            %s::uuid, %s, %s, %s, %s
                        )
                        """,
                        (
                            version_id,
                            change.get("change_type"),
                            change.get("item_type"),
                            change.get("item_name"),
                            Json(change.get("detail") if change.get("detail") is not None else {}),
                        ),
                    )

                # A successful discovery clears any failure backoff/quarantine state (MCAT-5.3):
                # the endpoint is healthy again, so it rejoins the sweep at its normal cadence.
                cursor.execute(
                    """
                    UPDATE apiome.mcp_endpoints
                    SET current_version_id = %s::uuid,
                        last_discovered_at = %s,
                        last_discovery_status = 'changed',
                        consecutive_failures = 0,
                        next_discovery_after = NULL,
                        quarantined_at = NULL,
                        quarantine_reason = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s::uuid
                    """,
                    (version_id, discovered_at, endpoint_id),
                )
            conn.commit()
            return {
                "version_id": version_id,
                "version_seq": next_seq,
                "version_tag": version_tag,
            }
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.autocommit = prev_autocommit

    def set_mcp_version_score(
        self,
        version_id: str,
        *,
        score: Optional[int],
        grade: Optional[str],
        report: Optional[Dict[str, Any]] = None,
        report_fingerprint: Optional[str] = None,
    ) -> bool:
        """Upsert the quality/lint score for an MCP version snapshot (V2-MCP-21.4, #3685).

        Persists the rolled-up :class:`app.mcp_score.MCPScoreResult` for a discovery snapshot
        into ``mcp_version_scores``. There is exactly one score row per version
        (``mcp_version_scores_version_unique``), so this is an upsert: a re-score of the same
        version overwrites ``score``/``grade``/``report``/``report_fingerprint`` and moves
        ``scored_at`` to now, mirroring the per-revision behaviour of
        :meth:`set_version_quality_score`. The MCP score lives in its own table rather than on
        the version row because ``mcp_endpoint_versions`` snapshots are immutable.

        Tenant scoping is implicit: ``version_id`` is opaque and the caller has already
        validated the owning endpoint/tenant, and the row cascade-deletes with its version
        (and thus its endpoint), so no tenant column is needed here.

        Args:
            version_id: The ``mcp_endpoint_versions`` snapshot to score.
            score: Deterministic 0-100 score, or ``None`` to record an as-yet-unscored row.
            grade: A-F letter grade, or ``None``.
            report: Full scoring report retained for drill-down/render; stored as JSONB
                (defaults to an empty object when omitted, matching the column default).
            report_fingerprint: Stable fingerprint of the report for staleness detection.

        Returns:
            ``True`` when a score row was inserted or updated.
        """
        query = """
            INSERT INTO apiome.mcp_version_scores (
                version_id, score, grade, report, report_fingerprint, scored_at
            ) VALUES (
                %s::uuid, %s, %s, %s, %s, CURRENT_TIMESTAMP
            )
            ON CONFLICT (version_id) DO UPDATE SET
                score = EXCLUDED.score,
                grade = EXCLUDED.grade,
                report = EXCLUDED.report,
                report_fingerprint = EXCLUDED.report_fingerprint,
                scored_at = CURRENT_TIMESTAMP
            RETURNING id
        """
        rows = self.execute_query(
            query,
            (
                version_id,
                score,
                grade,
                Json(report if report is not None else {}),
                report_fingerprint,
            ),
        )
        if rows and report and report.get("report_fingerprint"):
            # CLX-1.1 (#4848): mirror the persisted report into the immutable evidence
            # substrate. The score row upserts in place; evidence appends a new run instead
            # (skipped when the fingerprint is already evidenced). Best-effort by design.
            try:
                surface_rows = self.execute_query(
                    "SELECT surface_fingerprint FROM apiome.mcp_endpoint_versions WHERE id = %s::uuid",
                    (version_id,),
                )
                self.record_lint_evidence_run(
                    mcp_evidence_run(
                        version_id,
                        report,
                        input_fingerprint=(
                            surface_rows[0].get("surface_fingerprint") if surface_rows else None
                        ),
                    )
                )
            except Exception:  # noqa: BLE001 - evidence capture is strictly additive
                _logger.warning(
                    "Failed to record lint evidence for MCP version %s",
                    version_id,
                    exc_info=True,
                )
            # CLX-1.2 (#4849): mirror the report into a versioned multi-axis evaluation.
            try:
                self.record_axis_evaluation(
                    evaluation_row(
                        mcp_axis_evaluation(report),
                        subject_type=SUBJECT_MCP_ENDPOINT_VERSION,
                        subject_id=version_id,
                    )
                )
            except Exception:  # noqa: BLE001 - axis capture is strictly additive
                _logger.warning(
                    "Failed to record axis evaluation for MCP version %s",
                    version_id,
                    exc_info=True,
                )
        return bool(rows)

    def insert_mcp_test_invocation(
        self,
        *,
        endpoint_id: str,
        version_id: Optional[str],
        item_type: str,
        item_name: str,
        arguments: Optional[Dict[str, Any]],
        response: Optional[Dict[str, Any]],
        is_error: bool,
        latency_ms: Optional[int],
        invoked_by: Optional[str],
    ) -> Dict[str, Any]:
        """Record one test-harness invocation in ``mcp_test_invocations`` (V2-MCP-22.3, #3689).

        Appends a single audit row for a capability that was actually dispatched to its live MCP
        server, so a tenant can see what was tested, when, by whom, and how it turned out. The row
        is the security-critical test log: callers MUST pass an already-redacted ``arguments`` /
        ``response`` (see :func:`app.models.redact_sensitive_args`) — this method persists them
        verbatim and never sees the raw secret-bearing values or the request's auth headers (which
        are never part of the log at all).

        Tenant scoping is implicit: ``endpoint_id`` is opaque and the caller has already validated
        the owning endpoint against the token tenant, and the row cascade-deletes with its endpoint.

        Args:
            endpoint_id: The endpoint the call was made against.
            version_id: The snapshot the invoked item came from (``current_version_id``); may be
                ``None`` (the column is SET NULL on version prune).
            item_type: The capability kind invoked (``tool``/``resource``/``prompt``).
            item_name: The invoked capability's programmatic name.
            arguments: The **redacted** call arguments to log (defaults to ``{}`` when ``None``).
            response: The **redacted** outcome to log (content/error summary), or ``None``.
            is_error: ``True`` when the call returned a tool-level error or failed in transport.
            latency_ms: Integer round-trip latency, or ``None`` when the call never completed.
            invoked_by: The acting user id, or ``None`` when it cannot be resolved.

        Returns:
            The inserted row (``id`` and ``created_at`` among the persisted columns).
        """
        query = """
            INSERT INTO apiome.mcp_test_invocations (
                endpoint_id, version_id, item_type, item_name,
                arguments, response, is_error, latency_ms, invoked_by
            ) VALUES (
                %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s
            )
            RETURNING id, endpoint_id, version_id, item_type, item_name,
                      is_error, latency_ms, invoked_by, created_at
        """
        rows = self.execute_query(
            query,
            (
                endpoint_id,
                version_id,
                item_type,
                item_name,
                Json(arguments if arguments is not None else {}),
                Json(response) if response is not None else None,
                is_error,
                latency_ms,
                invoked_by,
            ),
        )
        return rows[0] if rows else {}

    def get_mcp_version_score(self, version_id: str) -> Optional[Dict[str, Any]]:
        """Fetch the persisted quality/lint score row for an MCP version snapshot.

        The read counterpart of :meth:`set_mcp_version_score` (V2-MCP-21.5, #3686): returns the
        full stored scoring report so the lint API can serve the *stored* score/grade/findings
        without recomputing. There is at most one row per version
        (``mcp_version_scores_version_unique``), so this returns that single row or ``None`` when
        the snapshot has not been scored yet.

        Tenant scoping is implicit: ``version_id`` is opaque and the caller has already validated
        the owning endpoint/tenant before reaching here.

        Args:
            version_id: The ``mcp_endpoint_versions`` snapshot whose score to read.

        Returns:
            ``{"score", "grade", "report", "report_fingerprint", "scored_at"}`` for the snapshot,
            or ``None`` when it has not been scored.
        """
        query = """
            SELECT score, grade, report, report_fingerprint, scored_at
            FROM apiome.mcp_version_scores
            WHERE version_id = %s::uuid
        """
        rows = self.execute_query(query, (version_id,))
        return dict(rows[0]) if rows else None

    def set_mcp_protocol_transcript(
        self,
        version_id: str,
        *,
        transcript: Dict[str, Any],
        requested_version: Optional[str] = None,
        negotiated_version: Optional[str] = None,
        transcript_fingerprint: Optional[str] = None,
    ) -> bool:
        """Record the redacted protocol transcript for a discovery snapshot (CLX-3.1, #4855).

        Persists an :meth:`app.mcp_protocol_transcript.ProtocolTranscript.as_dict` payload into
        ``mcp_protocol_transcripts``: the reduced, redacted record of the passive JSON-RPC
        exchanges performed while the snapshot was being discovered. It stores shapes, counts
        and cursor digests only — never wire data, tool arguments, tool results, or credentials
        (redaction happens at capture, in :mod:`app.mcp_protocol_transcript`, not here).

        **Write-once.** There is one transcript per snapshot, and the row is guarded by the
        shared immutability trigger, so this is an ``ON CONFLICT DO NOTHING`` insert rather than
        an upsert: an ``ON CONFLICT DO UPDATE`` would trip the trigger and raise. A snapshot is
        immutable, so the discovery that produced it is a fact about it that never changes —
        a second write for the same version is a no-op, not an error.

        Tenant scoping is implicit: ``version_id`` is opaque, the caller has already validated
        the owning endpoint/tenant, and the row cascade-deletes with its version.

        Args:
            version_id: The ``mcp_endpoint_versions`` snapshot the transcript was captured for.
            transcript: The redacted transcript payload; stored as JSONB.
            requested_version: Protocol version the client offered first, when known.
            negotiated_version: Protocol version the server settled on, when known.
            transcript_fingerprint: Stable hash over the redacted transcript.

        Returns:
            ``True`` when a row was inserted; ``False`` when the snapshot already had one.
        """
        query = """
            INSERT INTO apiome.mcp_protocol_transcripts (
                version_id, transcript, requested_version, negotiated_version,
                transcript_fingerprint, redacted, captured_at
            ) VALUES (
                %s::uuid, %s, %s, %s, %s, TRUE, CURRENT_TIMESTAMP
            )
            ON CONFLICT (version_id) DO NOTHING
            RETURNING id
        """
        rows = self.execute_query(
            query,
            (
                version_id,
                Json(transcript or {}),
                requested_version,
                negotiated_version,
                transcript_fingerprint,
            ),
        )
        return bool(rows)

    def get_mcp_protocol_transcript(self, version_id: str) -> Optional[Dict[str, Any]]:
        """Fetch the redacted protocol transcript for a discovery snapshot, if one was captured.

        The read counterpart of :meth:`set_mcp_protocol_transcript`. It is what lets the
        conformance API evaluate the transcript-backed protocol rules on a *recompute*, long
        after the session that observed them closed.

        A snapshot discovered before CLX-3.1 — or restored from a store rather than a live
        handshake — has no row, and this returns ``None``. Callers MUST treat that as "not
        observed" and report the transcript-backed rules as skipped: an absent transcript is a
        visible gap, never a clean result.

        Args:
            version_id: The ``mcp_endpoint_versions`` snapshot whose transcript to read.

        Returns:
            ``{"transcript", "requested_version", "negotiated_version", "transcript_fingerprint",
            "redacted", "captured_at"}``, or ``None`` when no transcript was captured.
        """
        query = """
            SELECT transcript, requested_version, negotiated_version,
                   transcript_fingerprint, redacted, captured_at
            FROM apiome.mcp_protocol_transcripts
            WHERE version_id = %s::uuid
        """
        rows = self.execute_query(query, (version_id,))
        return dict(rows[0]) if rows else None

    # --- MCP source associations & SBOMs (CLX-3.2, #4856) ------------------------------------

    _MCP_SOURCE_COLUMNS = """
        id, tenant_id, endpoint_id, source_kind, locator, purl, revision, digest,
        digest_algorithm, provenance, provenance_detail, verification_state, linked_by,
        retired_at, created_at, updated_at
    """

    def create_mcp_endpoint_source(
        self,
        *,
        tenant_id: str,
        endpoint_id: str,
        source: Dict[str, Any],
        linked_by: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        """Link a source artifact to an MCP endpoint (``mcp_endpoint_sources``, V172).

        The ``source`` dict is exactly what :meth:`app.mcp_source_link.SourceLink.as_dict` emits, so
        the parsing/canonicalization/pin-strength logic lives in one pure module and this method only
        persists its result. Provenance and verification_state are stored as given — this method
        never upgrades a link's trust, because it has no basis to.

        The unique index ``mcp_endpoint_sources_live_unique`` makes a duplicate live link a no-op
        rather than an error (``ON CONFLICT DO NOTHING``): re-linking the same artifact returns the
        existing row instead of a 500, which is the behaviour a retrying client expects.

        Args:
            tenant_id: The owning tenant (denormalized onto the row for scoped listing).
            endpoint_id: The endpoint being linked.
            source: The canonical link (``SourceLink.as_dict()`` shape).
            linked_by: The acting user id, or ``None`` when unattributable.

        Returns:
            The created (or already-existing) row, or ``None`` if the insert both conflicted and no
            live row was found (should not happen; guarded by the follow-up read).
        """
        query = f"""
            INSERT INTO apiome.mcp_endpoint_sources (
                tenant_id, endpoint_id, source_kind, locator, purl, revision, digest,
                digest_algorithm, provenance, provenance_detail, verification_state, linked_by
            )
            VALUES (
                %s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::uuid
            )
            ON CONFLICT (endpoint_id, source_kind, locator) WHERE retired_at IS NULL
            DO NOTHING
            RETURNING {self._MCP_SOURCE_COLUMNS}
        """
        rows = self.execute_query(
            query,
            (
                tenant_id,
                endpoint_id,
                source["source_kind"],
                source["locator"],
                source.get("purl"),
                source.get("revision"),
                source.get("digest"),
                source.get("digest_algorithm"),
                source.get("provenance", "operator_declared"),
                Json(source.get("provenance_detail") or {}),
                source.get("verification_state", "unverified"),
                linked_by,
            ),
        )
        if rows:
            return dict(rows[0])
        # Conflict: a live link for this (endpoint, kind, locator) already exists. Return it, so the
        # call is idempotent.
        existing = self.execute_query(
            f"""
            SELECT {self._MCP_SOURCE_COLUMNS}
            FROM apiome.mcp_endpoint_sources
            WHERE endpoint_id = %s::uuid AND source_kind = %s AND locator = %s
              AND retired_at IS NULL
            """,
            (endpoint_id, source["source_kind"], source["locator"]),
        )
        return dict(existing[0]) if existing else None

    def list_mcp_endpoint_sources(
        self, endpoint_id: str, *, include_retired: bool = False
    ) -> List[Dict[str, Any]]:
        """List an endpoint's source associations, newest first.

        Args:
            endpoint_id: The endpoint whose sources to list.
            include_retired: When ``False`` (default), retired links are excluded — they stay in the
                table so historical evidence citing them remains interpretable, but they no longer
                back new scans, so the default listing hides them.

        Returns:
            The source rows.
        """
        clause = "" if include_retired else "AND retired_at IS NULL"
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_SOURCE_COLUMNS}
            FROM apiome.mcp_endpoint_sources
            WHERE endpoint_id = %s::uuid {clause}
            ORDER BY created_at DESC
            """,
            (endpoint_id,),
        )
        return [dict(r) for r in rows]

    def get_mcp_endpoint_source(
        self, endpoint_id: str, source_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch one source association scoped to its endpoint (so a cross-endpoint id 404s).

        Args:
            endpoint_id: The owning endpoint.
            source_id: The source row id.

        Returns:
            The row, or ``None`` when it is not this endpoint's.
        """
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_SOURCE_COLUMNS}
            FROM apiome.mcp_endpoint_sources
            WHERE id = %s::uuid AND endpoint_id = %s::uuid
            """,
            (source_id, endpoint_id),
        )
        return dict(rows[0]) if rows else None

    def retire_mcp_endpoint_source(self, endpoint_id: str, source_id: str) -> bool:
        """Soft-retire a source association (sets ``retired_at``), scoped to its endpoint.

        Soft, not hard: a hard delete would orphan the provenance of every finding already derived
        from the source. A retired link stops backing new scans but stays readable.

        Args:
            endpoint_id: The owning endpoint.
            source_id: The source to retire.

        Returns:
            ``True`` when a live row was retired, ``False`` when none matched (already retired, or
            not this endpoint's).
        """
        rows = self.execute_query(
            """
            UPDATE apiome.mcp_endpoint_sources
            SET retired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND endpoint_id = %s::uuid AND retired_at IS NULL
            RETURNING id
            """,
            (source_id, endpoint_id),
        )
        return bool(rows)

    def record_mcp_source_sbom(self, sbom: Dict[str, Any]) -> Optional[str]:
        """Insert a write-once SBOM for a source artifact (``mcp_source_sboms``, V172).

        Like the evidence runs, SBOM rows are immutable and keyed by ``(source, digest, origin)``: a
        re-scan at a new commit inserts a new row rather than mutating one that is still the true
        inventory of the old commit. An identical re-ingest is a no-op via ``ON CONFLICT DO NOTHING``.

        Args:
            sbom: Column-name -> value dict from :func:`app.mcp_sbom.inventory_row`. ``components`` /
                ``scanned_manifests`` are plain structures, JSONB-wrapped here.

        Returns:
            The new row's id, or ``None`` when an identical inventory was already stored.
        """
        rows = self.execute_query(
            """
            INSERT INTO apiome.mcp_source_sboms (
                source_id, subject_digest, sbom_format, sbom_spec_version, origin,
                components, component_count, sbom_fingerprint, scanned_manifests
            )
            VALUES (%s::uuid, %s, %s, %s, %s, %s::jsonb, %s, %s, %s::jsonb)
            ON CONFLICT (source_id, subject_digest, origin) DO NOTHING
            RETURNING id
            """,
            (
                sbom["source_id"],
                sbom["subject_digest"],
                sbom["sbom_format"],
                sbom.get("sbom_spec_version"),
                sbom["origin"],
                Json(sbom.get("components") or []),
                sbom.get("component_count", 0),
                sbom.get("sbom_fingerprint"),
                Json(sbom.get("scanned_manifests") or []),
            ),
        )
        return str(rows[0]["id"]) if rows else None

    def get_latest_mcp_source_sbom(
        self, source_id: str, *, subject_digest: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Fetch the most recent SBOM for a source, optionally for a specific artifact digest.

        A supplied SBOM (``operator_supplied``) is preferred over a derived one for the same
        artifact, since it is authoritative; within an origin, the newest wins.

        Args:
            source_id: The source whose inventory to read.
            subject_digest: When given, restrict to the SBOM of that exact artifact digest.

        Returns:
            The SBOM row, or ``None`` when the source has no inventory.
        """
        clause = "AND subject_digest = %s" if subject_digest else ""
        params: tuple = (source_id, subject_digest) if subject_digest else (source_id,)
        rows = self.execute_query(
            f"""
            SELECT id, source_id, subject_digest, sbom_format, sbom_spec_version, origin,
                   components, component_count, sbom_fingerprint, scanned_manifests, created_at
            FROM apiome.mcp_source_sboms
            WHERE source_id = %s::uuid {clause}
            ORDER BY (origin = 'operator_supplied') DESC, created_at DESC
            LIMIT 1
            """,
            params,
        )
        return dict(rows[0]) if rows else None

    # --- MCP dynamic probes: allowlist + audit/rate ledger (CLX-3.3, #4857) -------------------

    _MCP_PROBE_TARGET_COLUMNS = """
        id, tenant_id, endpoint_id, transport, locator, ownership_declared,
        test_credential_id, enrolled_by, retired_at, created_at, updated_at
    """

    _MCP_PROBE_RUN_COLUMNS = """
        id, tenant_id, endpoint_id, version_id, profile, target_locator, transport,
        consent, limits, isolation, status, refusal_reason, requests_sent, observed_count,
        exploited_count, report, report_fingerprint, started_by, started_at, completed_at
    """

    def enroll_mcp_probe_target(
        self,
        *,
        tenant_id: str,
        endpoint_id: str,
        transport: str,
        locator: str,
        test_credential_id: Optional[str],
        enrolled_by: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        """Add an endpoint to the active-probe allowlist (``mcp_probe_targets``, V173).

        Enrollment is the operator asserting they own/are authorized to probe the target and naming
        the dedicated test credential a probe authenticates as. ``ownership_declared`` is stored TRUE
        (the schema refuses a row without it). Idempotent per live ``(endpoint, transport)`` via
        ``ON CONFLICT DO NOTHING``, returning the existing live row so a retry does not 500.

        Args:
            tenant_id: The owning tenant.
            endpoint_id: The endpoint being enrolled.
            transport: ``http`` or ``stdio``.
            locator: The resolved target (URL or command reference).
            test_credential_id: The dedicated probe credential id, or ``None`` for an unauthenticated
                target.
            enrolled_by: The acting user id.

        Returns:
            The created (or already-existing live) row, or ``None`` on an unexpected miss.
        """
        rows = self.execute_query(
            f"""
            INSERT INTO apiome.mcp_probe_targets (
                tenant_id, endpoint_id, transport, locator, ownership_declared,
                test_credential_id, enrolled_by
            )
            VALUES (%s::uuid, %s::uuid, %s, %s, TRUE, %s::uuid, %s::uuid)
            ON CONFLICT (endpoint_id, transport) WHERE retired_at IS NULL
            DO NOTHING
            RETURNING {self._MCP_PROBE_TARGET_COLUMNS}
            """,
            (tenant_id, endpoint_id, transport, locator, test_credential_id, enrolled_by),
        )
        if rows:
            return dict(rows[0])
        existing = self.execute_query(
            f"""
            SELECT {self._MCP_PROBE_TARGET_COLUMNS}
            FROM apiome.mcp_probe_targets
            WHERE endpoint_id = %s::uuid AND transport = %s AND retired_at IS NULL
            """,
            (endpoint_id, transport),
        )
        return dict(existing[0]) if existing else None

    def get_mcp_probe_target(
        self, endpoint_id: str, transport: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch the live allowlist entry for ``(endpoint, transport)``, or ``None`` if not enrolled."""
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_PROBE_TARGET_COLUMNS}
            FROM apiome.mcp_probe_targets
            WHERE endpoint_id = %s::uuid AND transport = %s AND retired_at IS NULL
            """,
            (endpoint_id, transport),
        )
        return dict(rows[0]) if rows else None

    def list_mcp_probe_targets(self, endpoint_id: str) -> List[Dict[str, Any]]:
        """List an endpoint's live allowlist entries, newest first."""
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_PROBE_TARGET_COLUMNS}
            FROM apiome.mcp_probe_targets
            WHERE endpoint_id = %s::uuid AND retired_at IS NULL
            ORDER BY created_at DESC
            """,
            (endpoint_id,),
        )
        return [dict(r) for r in rows]

    def retire_mcp_probe_target(self, endpoint_id: str, target_id: str) -> bool:
        """Soft-retire an allowlist entry (sets ``retired_at``), scoped to its endpoint.

        Returns ``True`` when a live row was retired, ``False`` when none matched.
        """
        rows = self.execute_query(
            """
            UPDATE apiome.mcp_probe_targets
            SET retired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid AND endpoint_id = %s::uuid AND retired_at IS NULL
            RETURNING id
            """,
            (target_id, endpoint_id),
        )
        return bool(rows)

    def get_mcp_probe_tenant_usage(self, tenant_id: str) -> Dict[str, int]:
        """Return a tenant's live probe usage: in-flight runs and runs started in the last hour.

        This is the *authoritative* concurrency/rate ledger the governor reads — the counts come from
        the audit table, not an in-memory counter, so a restart cannot lose track of in-flight runs
        and two API replicas cannot each believe a tenant is idle. ``active_runs`` counts
        ``status='running'`` rows; ``runs_last_hour`` counts rows started in the trailing hour.

        Args:
            tenant_id: The tenant to measure.

        Returns:
            ``{"active_runs": int, "runs_last_hour": int}``.
        """
        rows = self.execute_query(
            """
            SELECT
                COUNT(*) FILTER (WHERE status = 'running') AS active_runs,
                COUNT(*) FILTER (WHERE started_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour')
                    AS runs_last_hour
            FROM apiome.mcp_probe_runs
            WHERE tenant_id = %s::uuid
            """,
            (tenant_id,),
        )
        row = dict(rows[0]) if rows else {}
        return {
            "active_runs": int(row.get("active_runs") or 0),
            "runs_last_hour": int(row.get("runs_last_hour") or 0),
        }

    def start_mcp_probe_run(
        self,
        *,
        tenant_id: str,
        endpoint_id: str,
        version_id: Optional[str],
        profile: str,
        target_locator: str,
        transport: str,
        consent: Dict[str, Any],
        limits: Dict[str, Any],
        isolation: Optional[Dict[str, Any]],
        started_by: Optional[str],
    ) -> Optional[str]:
        """Open an audit row for an active probe run in ``running`` state, returning its id.

        Written *before* any request goes out, so the run counts against the tenant's concurrency the
        instant it is authorized — closing the window in which two concurrent requests could each
        pass a stale idle check. The row is later moved to a terminal state by
        :meth:`complete_mcp_probe_run` or :meth:`refuse_mcp_probe_run`.

        Returns:
            The new run id, or ``None`` on failure.
        """
        rows = self.execute_query(
            """
            INSERT INTO apiome.mcp_probe_runs (
                tenant_id, endpoint_id, version_id, profile, target_locator, transport,
                consent, limits, isolation, status, started_by
            )
            VALUES (
                %s::uuid, %s::uuid, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, 'running', %s::uuid
            )
            RETURNING id
            """,
            (
                tenant_id,
                endpoint_id,
                version_id,
                profile,
                target_locator,
                transport,
                Json(consent),
                Json(limits),
                Json(isolation) if isolation is not None else None,
                started_by,
            ),
        )
        return str(rows[0]["id"]) if rows else None

    def complete_mcp_probe_run(
        self,
        run_id: str,
        *,
        report: Dict[str, Any],
        requests_sent: int,
        observed_count: int,
        exploited_count: int,
        report_fingerprint: str,
    ) -> None:
        """Move a run to ``completed`` and record its report and outcome tallies."""
        self.execute_query(
            """
            UPDATE apiome.mcp_probe_runs
            SET status = 'completed',
                report = %s::jsonb,
                requests_sent = %s,
                observed_count = %s,
                exploited_count = %s,
                report_fingerprint = %s,
                completed_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid
            """,
            (
                Json(report),
                requests_sent,
                observed_count,
                exploited_count,
                report_fingerprint,
                run_id,
            ),
        )

    def refuse_mcp_probe_run(self, run_id: str, *, reason: str) -> None:
        """Move a run to ``refused`` with its reason (a guardrail turned it away)."""
        self.execute_query(
            """
            UPDATE apiome.mcp_probe_runs
            SET status = 'refused', refusal_reason = %s, completed_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid
            """,
            (reason, run_id),
        )

    def fail_mcp_probe_run(self, run_id: str, *, reason: str) -> None:
        """Move a run to ``failed`` (an error during execution), recording the reason."""
        self.execute_query(
            """
            UPDATE apiome.mcp_probe_runs
            SET status = 'failed', refusal_reason = %s, completed_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid
            """,
            (reason, run_id),
        )

    def list_mcp_probe_runs(
        self, endpoint_id: str, *, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """List an endpoint's probe-run audit rows, newest first (the audit-trail view)."""
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_PROBE_RUN_COLUMNS}
            FROM apiome.mcp_probe_runs
            WHERE endpoint_id = %s::uuid
            ORDER BY started_at DESC
            LIMIT %s
            """,
            (endpoint_id, int(limit)),
        )
        return [dict(r) for r in rows]

    # --- MCP trust baselines: approved drift reference (CLX-3.4, #4858) ------------------------

    _MCP_TRUST_BASELINE_COLUMNS = """
        id, tenant_id, endpoint_id, version_id, manifest_fingerprint, manifest,
        rationale, gating_categories, approved_by, superseded_at, created_at, updated_at
    """

    def approve_mcp_trust_baseline(
        self,
        *,
        tenant_id: str,
        endpoint_id: str,
        version_id: str,
        manifest_fingerprint: str,
        manifest: Dict[str, Any],
        rationale: str,
        gating_categories: List[str],
        approved_by: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        """Approve a new trust baseline, superseding the endpoint's prior live baseline atomically.

        The prior live baseline (if any) is soft-superseded (``superseded_at`` stamped) and the new
        approval inserted in one transaction, so the partial unique index (one live baseline per
        endpoint) is never violated and no window exists with zero or two live baselines.

        Args:
            tenant_id: Owning tenant (already validated by the caller).
            endpoint_id: The endpoint being approved.
            version_id: The snapshot the operator approved.
            manifest_fingerprint: The composed trust-manifest fingerprint of that snapshot.
            manifest: The full approved manifest envelope (stored for old→new drift evidence).
            rationale: The administrator's reason for the approval (required, non-blank).
            gating_categories: The drift categories that gate for this baseline (configured risk deltas).
            approved_by: The approving user id, or ``None`` for an unattributable API-key call.

        Returns:
            The newly inserted baseline row, or ``None`` on insert failure.
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE apiome.mcp_trust_baselines
                    SET superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE endpoint_id = %s::uuid AND superseded_at IS NULL
                    """,
                    (endpoint_id,),
                )
                cursor.execute(
                    f"""
                    INSERT INTO apiome.mcp_trust_baselines
                      (tenant_id, endpoint_id, version_id, manifest_fingerprint, manifest,
                       rationale, gating_categories, approved_by)
                    VALUES (%s::uuid, %s::uuid, %s::uuid, %s, %s::jsonb, %s, %s::jsonb, %s::uuid)
                    RETURNING {self._MCP_TRUST_BASELINE_COLUMNS}
                    """,
                    (
                        tenant_id,
                        endpoint_id,
                        version_id,
                        manifest_fingerprint,
                        Json(manifest),
                        rationale,
                        Json(list(gating_categories)),
                        approved_by,
                    ),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None
        except Exception:
            conn.rollback()
            raise

    def get_active_mcp_trust_baseline(
        self, endpoint_id: str
    ) -> Optional[Dict[str, Any]]:
        """Return the endpoint's live (non-superseded) trust baseline, or ``None`` if never approved."""
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_TRUST_BASELINE_COLUMNS}
            FROM apiome.mcp_trust_baselines
            WHERE endpoint_id = %s::uuid AND superseded_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (endpoint_id,),
        )
        return dict(rows[0]) if rows else None

    def list_mcp_trust_baselines(
        self, endpoint_id: str, *, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """List an endpoint's trust-baseline approvals newest first (the approval history)."""
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_TRUST_BASELINE_COLUMNS}
            FROM apiome.mcp_trust_baselines
            WHERE endpoint_id = %s::uuid
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (endpoint_id, int(limit)),
        )
        return [dict(r) for r in rows]

    def list_mcp_enabled_capability_names(self, tenant_id: str) -> List[Dict[str, Any]]:
        """Capability items of every *enabled* endpoint's current snapshot, for shadowing detection.

        Joins each live, enabled endpoint to its ``current_version_id`` snapshot's
        ``mcp_capability_items`` and carries the endpoint identity (name/slug/url) alongside each
        item, so :func:`app.mcp_trust_manifest.detect_shadowed_names` can group names exposed by more
        than one enabled endpoint in the tenant's host scope. Scoped by ``tenant_id`` only.

        Args:
            tenant_id: The tenant whose enabled host scope to read.

        Returns:
            One row per capability item: ``endpoint_id``, ``endpoint_name``, ``endpoint_slug``,
            ``endpoint_url``, ``item_type``, ``name``.
        """
        q = """
            SELECT e.id AS endpoint_id, e.name AS endpoint_name, e.slug AS endpoint_slug,
                   e.endpoint_url AS endpoint_url, c.item_type, c.name
            FROM apiome.mcp_endpoints e
            JOIN apiome.mcp_capability_items c ON c.version_id = e.current_version_id
            WHERE e.tenant_id = %s::uuid
              AND e.deleted_at IS NULL
              AND e.enabled = true
            ORDER BY e.name ASC, c.item_type ASC, c.ordinal ASC
        """
        return self.execute_query(q, (tenant_id,))

    def touch_mcp_endpoint_discovery(
        self,
        endpoint_id: str,
        *,
        status: str,
        discovered_at: Any,
    ) -> None:
        """Stamp a successful no-change discovery without creating a new version.

        Used when a run reaches the server and finds an unchanged surface
        (``status='unchanged'``): the ``current_version_id`` is left untouched so it keeps
        pointing at the last good snapshot, but the contact still succeeded, so — like a
        new-version success — any failure backoff/quarantine state is cleared (MCAT-5.3) and
        the endpoint rejoins the sweep at its normal cadence.

        Failures take a different path (:meth:`record_mcp_discovery_failure`) because they
        *accumulate* state (increment the counter, set the backoff anchor, maybe quarantine)
        rather than reset it.
        """
        q = """
            UPDATE apiome.mcp_endpoints
            SET last_discovered_at = %s,
                last_discovery_status = %s,
                consecutive_failures = 0,
                next_discovery_after = NULL,
                quarantined_at = NULL,
                quarantine_reason = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (discovered_at, status, endpoint_id))
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def set_mcp_endpoint_transport_metadata(
        self,
        endpoint_id: str,
        metadata: Dict[str, Any],
        *,
        observed_at: Any,
    ) -> None:
        """Store the latest observed host/transport facts on an endpoint (V2-MCP-34.1, #4655).

        Writes the JSON document captured from the discovery handshake (host, TLS certificate
        summary, notable response headers, connect timing) into ``transport_metadata`` and stamps
        ``transport_metadata_at``. This is a *latest observation* refreshed by every successful
        discovery (changed or unchanged), which is why it lives on the mutable endpoint row rather
        than the immutable version snapshot. A no-op ``UPDATE`` (endpoint already gone) is harmless.

        Args:
            endpoint_id: The endpoint whose transport observation is being stored.
            metadata: The JSON-ready document (see :meth:`TransportMetadata.to_dict`).
            observed_at: When the observation was taken (the discovery run time).
        """
        q = """
            UPDATE apiome.mcp_endpoints
            SET transport_metadata = %s,
                transport_metadata_at = %s,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s::uuid
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (Json(metadata), observed_at, endpoint_id))
                conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def record_mcp_discovery_failure(
        self,
        endpoint_id: str,
        *,
        discovered_at: Any,
        status: str = "failed",
        backoff_base_seconds: float,
        backoff_max_seconds: float,
        quarantine_threshold: int,
        quarantine_reason: str,
        retry_after_seconds: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """Record a failed discovery: increment the failure counter, back off, maybe quarantine.

        The failure counterpart of :meth:`touch_mcp_endpoint_discovery` (MCAT-5.3, #3675).
        In one transaction this:

        1. increments ``consecutive_failures`` and stamps ``last_discovered_at`` /
           ``last_discovery_status`` so the endpoint is not immediately due again (its cadence
           anchor advances) and the latest outcome is visible via the status API;
        2. computes an exponential backoff from the *new* failure count
           (:func:`app.mcp_discovery_backoff.compute_backoff_seconds`, honouring a 429
           ``Retry-After`` floor) and writes ``next_discovery_after`` so the sweep defers the
           endpoint for that delay; and
        3. when the new count reaches ``quarantine_threshold`` (and ``> 0``), sets
           ``quarantined_at`` / ``quarantine_reason`` so the endpoint is auto-excluded from the
           sweep until it recovers — an already-quarantined endpoint keeps its original
           ``quarantined_at`` (the quarantine does not "renew").

        Args:
            endpoint_id: The endpoint whose run failed.
            discovered_at: When the failed attempt ran (the backoff is measured from here).
            status: ``last_discovery_status`` to stamp (default ``failed``; callers may pass a
                more specific error code).
            backoff_base_seconds: Base unit for the exponential backoff.
            backoff_max_seconds: Ceiling for the exponential backoff (a ``Retry-After`` floor
                may exceed it).
            quarantine_threshold: Consecutive-failure count that trips quarantine; ``<= 0``
                disables quarantine (the endpoint backs off but is never auto-disabled).
            quarantine_reason: Diagnostic text stored when the endpoint is quarantined.
            retry_after_seconds: Optional server-supplied minimum delay from a 429 response.

        Returns:
            ``{"consecutive_failures": int, "backoff_seconds": float, "quarantined": bool,
            "newly_quarantined": bool}`` describing the post-update state, or ``None`` when the
            endpoint row no longer exists. ``newly_quarantined`` is ``True`` only on the
            transition into quarantine, so the caller can emit the quarantine event exactly once.
        """
        from .mcp_discovery_backoff import compute_backoff_seconds

        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE apiome.mcp_endpoints
                    SET consecutive_failures = consecutive_failures + 1,
                        last_discovered_at = %s,
                        last_discovery_status = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s::uuid
                    RETURNING consecutive_failures,
                              (quarantined_at IS NOT NULL) AS was_quarantined
                    """,
                    (discovered_at, status, endpoint_id),
                )
                row = cursor.fetchone()
                if row is None:
                    conn.commit()
                    return None

                failures = int(row["consecutive_failures"])
                already_quarantined = bool(row["was_quarantined"])
                backoff_seconds = compute_backoff_seconds(
                    failures,
                    base_seconds=backoff_base_seconds,
                    max_seconds=backoff_max_seconds,
                    retry_after_seconds=retry_after_seconds,
                )
                should_quarantine = (
                    quarantine_threshold > 0 and failures >= quarantine_threshold
                )
                newly_quarantined = should_quarantine and not already_quarantined

                # Set the backoff anchor always; set quarantine fields only when tripping it,
                # preserving the original quarantined_at if already quarantined (no renewal).
                cursor.execute(
                    """
                    UPDATE apiome.mcp_endpoints
                    SET next_discovery_after = %s + make_interval(secs => %s),
                        quarantined_at = CASE
                            WHEN %s THEN COALESCE(quarantined_at, %s)
                            ELSE quarantined_at
                        END,
                        quarantine_reason = CASE
                            WHEN %s AND quarantined_at IS NULL THEN %s
                            ELSE quarantine_reason
                        END
                    WHERE id = %s::uuid
                    """,
                    (
                        discovered_at,
                        backoff_seconds,
                        should_quarantine,
                        discovered_at,
                        should_quarantine,
                        quarantine_reason,
                        endpoint_id,
                    ),
                )
                conn.commit()
                return {
                    "consecutive_failures": failures,
                    "backoff_seconds": backoff_seconds,
                    "quarantined": should_quarantine or already_quarantined,
                    "newly_quarantined": newly_quarantined,
                }
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.autocommit = prev_autocommit

    def get_mcp_endpoint_credentials(
        self, endpoint_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch the stored credential row for an endpoint, or None when none is configured.

        Returns the credential metadata (``auth_type``, ``key_version``, ``oauth_metadata``,
        timestamps) and the ciphertext ``encrypted_payload``. Plaintext secrets are never
        stored; the caller is responsible for decryption when a decrypting key is wired in.
        """
        q = """
            SELECT id, endpoint_id, auth_type, encrypted_payload, key_version,
                   oauth_metadata, last_refreshed_at, created_at, updated_at
            FROM apiome.mcp_endpoint_credentials
            WHERE endpoint_id = %s::uuid
            LIMIT 1
        """
        rows = self.execute_query(q, (endpoint_id,))
        return dict(rows[0]) if rows else None

    def upsert_mcp_endpoint_credentials(
        self,
        *,
        endpoint_id: str,
        auth_type: str,
        encrypted_payload: bytes,
        key_version: int,
        oauth_metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Set or replace an endpoint's sealed credential (MCAT-6.5), one row per endpoint.

        The secret arrives already sealed (MCAT-6.2): only the ciphertext ``encrypted_payload`` and
        its ``key_version`` are written — never plaintext. The ``endpoint_id`` UNIQUE constraint
        makes this an upsert: a repeat set replaces the previous secret in place and bumps
        ``last_refreshed_at`` (when the secret was last (re)sealed), while the trigger maintains
        ``updated_at``. The caller is responsible for scoping ``endpoint_id`` to the tenant before
        calling.

        Args:
            endpoint_id: The endpoint the credential belongs to.
            auth_type: The secret-bearing scheme (``bearer``/``header``/``oauth2``/``env``).
            encrypted_payload: The sealed secret bytes (ciphertext only).
            key_version: The master-key version that sealed ``encrypted_payload``.
            oauth_metadata: Non-secret OAuth2 metadata to store as cleartext JSONB (defaults to
                ``{}``).

        Returns:
            The stored credential row (including the ciphertext column the caller must redact
            before it leaves the service).
        """
        q = """
            INSERT INTO apiome.mcp_endpoint_credentials (
                endpoint_id, auth_type, encrypted_payload, key_version,
                oauth_metadata, last_refreshed_at
            ) VALUES (
                %s::uuid, %s, %s, %s, %s, CURRENT_TIMESTAMP
            )
            ON CONFLICT (endpoint_id) DO UPDATE SET
                auth_type = EXCLUDED.auth_type,
                encrypted_payload = EXCLUDED.encrypted_payload,
                key_version = EXCLUDED.key_version,
                oauth_metadata = EXCLUDED.oauth_metadata,
                last_refreshed_at = CURRENT_TIMESTAMP
            RETURNING id, endpoint_id, auth_type, encrypted_payload, key_version,
                      oauth_metadata, last_refreshed_at, created_at, updated_at
        """
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    q,
                    (
                        endpoint_id,
                        auth_type,
                        psycopg2.Binary(encrypted_payload),
                        key_version,
                        Json(oauth_metadata or {}),
                    ),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)
        except Exception as e:
            conn.rollback()
            raise e

    def delete_mcp_endpoint_credentials(self, endpoint_id: str) -> bool:
        """Clear an endpoint's stored credential, removing the row (MCAT-6.5).

        Idempotent: deleting when no credential is configured is a no-op that reports ``False``.
        The caller is responsible for scoping ``endpoint_id`` to the tenant before calling.

        Args:
            endpoint_id: The endpoint whose credential to remove.

        Returns:
            ``True`` when a credential row was deleted, ``False`` when there was none to delete.
        """
        q = "DELETE FROM apiome.mcp_endpoint_credentials WHERE endpoint_id = %s::uuid"
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(q, (endpoint_id,))
                deleted = (cursor.rowcount or 0) > 0
                conn.commit()
                return deleted
        except Exception as e:
            conn.rollback()
            raise e

    # -----------------------------------------------------------------------------------------
    # Insight aggregation reads (V2-MCP-28.2 / MCAT-14.2, #4628)
    # -----------------------------------------------------------------------------------------
    #
    # The data-fetch half of the insight endpoints: tenant-scoped SQL that returns the minimal
    # rows each pre-aggregated series is rolled up from. The roll-up math (percentiles, rates,
    # per-type counts) lives in the pure :mod:`app.mcp_insight_aggregation` layer so it is
    # unit-testable without a live database. Every method here is called only after the owning
    # endpoint has been re-validated against the caller's token tenant, so no method re-checks
    # tenancy; the catalog aggregate scopes on ``tenant_id`` directly.

    def get_mcp_evolution_series(self, endpoint_id: str) -> List[Dict[str, Any]]:
        """Return an endpoint's per-version evolution series, oldest snapshot first.

        One row per ``mcp_endpoint_versions`` snapshot carrying the fields an evolution chart
        renders as a time series: the snapshot identity (``version_seq`` / ``version_tag`` /
        ``discovered_at``), the per-kind capability counts on that surface (from
        ``mcp_capability_items``), the quality ``score`` / ``grade`` (from ``mcp_version_scores``,
        NULL until scored), and the churn — the per-direction ``mcp_version_changes`` tally the
        snapshot introduced. Ordered by ``version_seq`` ascending so the series reads left-to-right
        in chronological order.

        The two child tallies are computed with correlated subqueries rather than a join-and-group,
        so a snapshot with many capability items and many change rows cannot fan the two counts into
        each other (a GROUP BY over both children would multiply them).

        Args:
            endpoint_id: The owning endpoint (already tenant-validated by the caller).

        Returns:
            One dict per snapshot, oldest first; empty when the endpoint was never discovered.
        """
        q = """
            SELECT
                v.id, v.endpoint_id, v.version_seq, v.version_tag,
                v.discovered_at, v.created_at, v.surface_fingerprint,
                s.score, s.grade,
                (SELECT COUNT(*) FROM apiome.mcp_capability_items i
                   WHERE i.version_id = v.id AND i.item_type = 'tool')              AS tool_count,
                (SELECT COUNT(*) FROM apiome.mcp_capability_items i
                   WHERE i.version_id = v.id AND i.item_type = 'resource')          AS resource_count,
                (SELECT COUNT(*) FROM apiome.mcp_capability_items i
                   WHERE i.version_id = v.id AND i.item_type = 'resource_template') AS resource_template_count,
                (SELECT COUNT(*) FROM apiome.mcp_capability_items i
                   WHERE i.version_id = v.id AND i.item_type = 'prompt')            AS prompt_count,
                (SELECT COUNT(*) FROM apiome.mcp_version_changes c
                   WHERE c.version_id = v.id AND c.change_type = 'added')           AS added_count,
                (SELECT COUNT(*) FROM apiome.mcp_version_changes c
                   WHERE c.version_id = v.id AND c.change_type = 'removed')         AS removed_count,
                (SELECT COUNT(*) FROM apiome.mcp_version_changes c
                   WHERE c.version_id = v.id AND c.change_type = 'modified')        AS modified_count
            FROM apiome.mcp_endpoint_versions v
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = v.id
            WHERE v.endpoint_id = %s::uuid
            ORDER BY v.version_seq ASC
        """
        return self.execute_query(q, (endpoint_id,))

    def list_mcp_discovery_trigger_stats(self, endpoint_id: str) -> List[Dict[str, Any]]:
        """Tally an endpoint's discovery jobs per ``trigger`` for provenance (MCAT-20.5).

        One row per trigger value present in the endpoint's job log, with the total number
        of jobs, how many of them completed, and the enqueue-time span. The pure
        :func:`~app.mcp_provenance.build_endpoint_provenance` turns these into the
        "how often has each origin run" counts on the provenance strip / report section.

        Args:
            endpoint_id: The owning endpoint (already tenant-validated by the caller).

        Returns:
            One dict per trigger (``trigger`` / ``total`` / ``completed`` / ``first_at`` /
            ``last_at``), ordered by trigger; empty when the endpoint has no job history.
        """
        q = """
            SELECT
                trigger,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE state = 'completed') AS completed,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at
            FROM apiome.mcp_discovery_jobs
            WHERE endpoint_id = %s::uuid
            GROUP BY trigger
            ORDER BY trigger ASC
        """
        return self.execute_query(q, (endpoint_id,))

    def list_mcp_discovery_job_stats(self, endpoint_id: str) -> List[Dict[str, Any]]:
        """Return an endpoint's discovery jobs as ``(state, duration_ms)`` rows for reliability.

        Each row is a discovery job's lifecycle ``state`` plus its wall-clock ``duration_ms`` —
        ``finished_at - started_at`` converted to milliseconds in SQL, or NULL when the job never
        both started and finished (still queued/running, or a failure before it began). The pure
        aggregator turns these into success rate and run-latency statistics.

        Args:
            endpoint_id: The owning endpoint (already tenant-validated by the caller).

        Returns:
            One dict per discovery job; empty when the endpoint has no discovery history.
        """
        q = """
            SELECT
                state,
                CASE
                    WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000.0
                    ELSE NULL
                END AS duration_ms
            FROM apiome.mcp_discovery_jobs
            WHERE endpoint_id = %s::uuid
        """
        return self.execute_query(q, (endpoint_id,))

    def list_mcp_discovery_job_timeline(
        self, endpoint_id: str, limit: int
    ) -> List[Dict[str, Any]]:
        """Return an endpoint's most-recent discovery jobs for the health timeline (MCAT-17.1).

        One row per job, **newest-first** (by enqueue time, ties broken by id for a stable order),
        capped at ``limit`` so a long-lived endpoint's timeline stays bounded. Each row carries the
        job's ``id`` / ``state`` / ``trigger``, its ``created_at`` / ``started_at`` / ``finished_at``
        timestamps, the wall-clock ``duration_ms`` (``finished_at - started_at`` in milliseconds, or
        NULL when the job never both started and finished), and ``error_code`` — the stable discovery
        failure classification (``connect_error`` / ``auth_required`` / …) lifted out of the failed
        job's stored ``result`` JSON, NULL for a non-failed job. The pure
        :func:`~app.mcp_insight_aggregation.compute_discovery_timeline` turns these into the outcome
        timeline and a windowed availability percentage.

        Args:
            endpoint_id: The owning endpoint (already tenant-validated by the caller).
            limit: The maximum number of most-recent jobs to return (clamped to at least 1).

        Returns:
            One dict per discovery job, newest-first; empty when the endpoint has no discovery
            history.
        """
        capped = max(1, int(limit))
        q = """
            SELECT
                id,
                state,
                trigger,
                created_at,
                started_at,
                finished_at,
                CASE
                    WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000.0
                    ELSE NULL
                END AS duration_ms,
                result -> 'error' ->> 'code' AS error_code
            FROM apiome.mcp_discovery_jobs
            WHERE endpoint_id = %s::uuid
            ORDER BY created_at DESC, id DESC
            LIMIT %s
        """
        return self.execute_query(q, (endpoint_id, capped))

    def list_mcp_invocation_stats(self, endpoint_id: str) -> List[Dict[str, Any]]:
        """Return an endpoint's test invocations as ``(is_error, latency_ms)`` rows for reliability.

        Each row is one recorded test-console call: whether it errored and its round-trip
        ``latency_ms`` (NULL when the call never completed). The pure aggregator turns these into an
        error rate and latency statistics.

        Args:
            endpoint_id: The owning endpoint (already tenant-validated by the caller).

        Returns:
            One dict per test invocation; empty when the endpoint has never been tested.
        """
        q = """
            SELECT is_error, latency_ms
            FROM apiome.mcp_test_invocations
            WHERE endpoint_id = %s::uuid
        """
        return self.execute_query(q, (endpoint_id,))

    def get_tenant_mcp_policy(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Load a tenant's MCP policy row plus tool flags (MTG-3.1, #4775).

        Args:
            tenant_id: Owning tenant UUID. Non-UUID values return ``None``.

        Returns:
            Dict with ``default_mode``, ``allow_anonymous_mcp``, ``updated_at``,
            ``updated_by``, and ``tools`` (list of tool-flag dicts), or ``None``
            when no ``tenant_mcp_policies`` row exists.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return None
        policy_rows = self.execute_query(
            """
            SELECT default_mode, allow_anonymous_mcp, updated_at, updated_by
            FROM apiome.tenant_mcp_policies
            WHERE tenant_id = %s::uuid
            """,
            (tenant_id,),
        )
        if not policy_rows:
            return None
        policy = policy_rows[0]
        tool_rows = self.execute_query(
            """
            SELECT tool_id, in_ceiling, default_enabled, anonymous_enabled
            FROM apiome.tenant_mcp_policy_tools
            WHERE tenant_id = %s::uuid
            ORDER BY tool_id
            """,
            (tenant_id,),
        )
        updated_by = policy.get("updated_by")
        return {
            "default_mode": policy["default_mode"],
            "allow_anonymous_mcp": bool(policy.get("allow_anonymous_mcp", True)),
            "updated_at": policy.get("updated_at"),
            "updated_by": str(updated_by) if updated_by is not None else None,
            "tools": [
                {
                    "tool_id": str(row["tool_id"]),
                    "in_ceiling": bool(row["in_ceiling"]),
                    "default_enabled": bool(row["default_enabled"]),
                    "anonymous_enabled": bool(row.get("anonymous_enabled", True)),
                }
                for row in tool_rows
            ],
        }

    @staticmethod
    def _normalize_mcp_policy_audit_snapshot(
        *,
        default_mode: str,
        allow_anonymous_mcp: bool,
        tools: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Canonical JSON shape for before/after comparison and audit storage (MTG-5.2)."""
        normalized_tools = [
            {
                "tool_id": str(tool["tool_id"]),
                "in_ceiling": bool(tool["in_ceiling"]),
                "default_enabled": bool(tool["default_enabled"]),
                "anonymous_enabled": bool(tool.get("anonymous_enabled", True)),
            }
            for tool in tools
        ]
        normalized_tools.sort(key=lambda t: t["tool_id"])
        return {
            "default_mode": str(default_mode),
            "allow_anonymous_mcp": bool(allow_anonymous_mcp),
            "tools": normalized_tools,
        }

    def _fetch_tenant_mcp_policy_on_cursor(
        self, cursor: Any, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Load live policy + tools using an open RealDictCursor (same shape as get)."""
        cursor.execute(
            """
            SELECT default_mode, allow_anonymous_mcp, updated_at, updated_by
            FROM apiome.tenant_mcp_policies
            WHERE tenant_id = %s::uuid
            """,
            (tenant_id,),
        )
        policy = cursor.fetchone()
        if not policy:
            return None
        cursor.execute(
            """
            SELECT tool_id, in_ceiling, default_enabled, anonymous_enabled
            FROM apiome.tenant_mcp_policy_tools
            WHERE tenant_id = %s::uuid
            ORDER BY tool_id
            """,
            (tenant_id,),
        )
        tool_rows = cursor.fetchall()
        updated_by = policy.get("updated_by")
        return {
            "default_mode": policy["default_mode"],
            "allow_anonymous_mcp": bool(policy.get("allow_anonymous_mcp", True)),
            "updated_at": policy.get("updated_at"),
            "updated_by": str(updated_by) if updated_by is not None else None,
            "tools": [
                {
                    "tool_id": str(row["tool_id"]),
                    "in_ceiling": bool(row["in_ceiling"]),
                    "default_enabled": bool(row["default_enabled"]),
                    "anonymous_enabled": bool(row.get("anonymous_enabled", True)),
                }
                for row in tool_rows
            ],
        }

    def replace_tenant_mcp_policy(
        self,
        tenant_id: str,
        *,
        default_mode: str,
        allow_anonymous_mcp: bool,
        tools: List[Dict[str, Any]],
        updated_by: Optional[str],
        actor_label: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Upsert tenant MCP policy and replace-all tool rows (MTG-3.1, #4775).

        Transactionally upserts ``tenant_mcp_policies``, deletes existing
        ``tenant_mcp_policy_tools`` for the tenant, then inserts ``tools``.
        When the stored snapshot changes, appends a row to
        ``tenant_mcp_policy_changes`` (MTG-5.2 / #4786). No-op PUTs skip the
        audit insert. Returns the same shape as :meth:`get_tenant_mcp_policy`.

        Args:
            tenant_id: Owning tenant UUID.
            default_mode: One of ``all`` / ``inherit_registry`` / ``explicit``.
            allow_anonymous_mcp: Kill switch for anonymous ``tools/call``.
            tools: Tool-flag dicts with ``tool_id``, ``in_ceiling``,
                ``default_enabled``, ``anonymous_enabled``.
            updated_by: Acting user UUID, or ``None``.
            actor_label: Display label for the audit actor (email/name), optional.

        Returns:
            Persisted policy snapshot (always non-None after a successful write).

        Raises:
            ValueError: When ``tenant_id`` (or ``updated_by`` when set) is not a UUID.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            raise ValueError("tenant_id must be a UUID")
        if updated_by is not None and not is_uuid_string(str(updated_by)):
            raise ValueError("updated_by must be a UUID or None")

        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                before_row = self._fetch_tenant_mcp_policy_on_cursor(cursor, tenant_id)
                before_snapshot = self._normalize_mcp_policy_audit_snapshot(
                    default_mode=(
                        before_row["default_mode"] if before_row else "all"
                    ),
                    allow_anonymous_mcp=(
                        bool(before_row.get("allow_anonymous_mcp", True))
                        if before_row
                        else True
                    ),
                    tools=list(before_row.get("tools") or []) if before_row else [],
                )

                cursor.execute(
                    """
                    INSERT INTO apiome.tenant_mcp_policies (
                        tenant_id, default_mode, allow_anonymous_mcp, updated_by, updated_at
                    )
                    VALUES (%s::uuid, %s, %s, %s::uuid, CURRENT_TIMESTAMP)
                    ON CONFLICT (tenant_id) DO UPDATE SET
                        default_mode = EXCLUDED.default_mode,
                        allow_anonymous_mcp = EXCLUDED.allow_anonymous_mcp,
                        updated_by = EXCLUDED.updated_by,
                        updated_at = CURRENT_TIMESTAMP
                    RETURNING default_mode, allow_anonymous_mcp, updated_at, updated_by
                    """,
                    (tenant_id, default_mode, bool(allow_anonymous_mcp), updated_by),
                )
                policy = cursor.fetchone()
                cursor.execute(
                    "DELETE FROM apiome.tenant_mcp_policy_tools WHERE tenant_id = %s::uuid",
                    (tenant_id,),
                )
                stored_tools: List[Dict[str, Any]] = []
                for tool in tools:
                    cursor.execute(
                        """
                        INSERT INTO apiome.tenant_mcp_policy_tools (
                            tenant_id, tool_id, in_ceiling, default_enabled, anonymous_enabled
                        )
                        VALUES (%s::uuid, %s, %s, %s, %s)
                        RETURNING tool_id, in_ceiling, default_enabled, anonymous_enabled
                        """,
                        (
                            tenant_id,
                            tool["tool_id"],
                            bool(tool["in_ceiling"]),
                            bool(tool["default_enabled"]),
                            bool(tool.get("anonymous_enabled", True)),
                        ),
                    )
                    row = cursor.fetchone()
                    stored_tools.append(
                        {
                            "tool_id": str(row["tool_id"]),
                            "in_ceiling": bool(row["in_ceiling"]),
                            "default_enabled": bool(row["default_enabled"]),
                            "anonymous_enabled": bool(row["anonymous_enabled"]),
                        }
                    )
                stored_tools.sort(key=lambda t: t["tool_id"])
                after_snapshot = self._normalize_mcp_policy_audit_snapshot(
                    default_mode=policy["default_mode"],
                    allow_anonymous_mcp=bool(
                        policy.get("allow_anonymous_mcp", True)
                    ),
                    tools=stored_tools,
                )
                if before_snapshot != after_snapshot:
                    cursor.execute(
                        """
                        INSERT INTO apiome.tenant_mcp_policy_changes (
                            tenant_id, actor_user_id, actor_label,
                            before_policy, after_policy
                        )
                        VALUES (
                            %s::uuid, %s::uuid, %s, %s::jsonb, %s::jsonb
                        )
                        """,
                        (
                            tenant_id,
                            updated_by,
                            (str(actor_label).strip() if actor_label else None) or None,
                            json.dumps(before_snapshot),
                            json.dumps(after_snapshot),
                        ),
                    )
            conn.commit()
            updated_by_val = policy.get("updated_by")
            return {
                "default_mode": policy["default_mode"],
                "allow_anonymous_mcp": bool(policy.get("allow_anonymous_mcp", True)),
                "updated_at": policy.get("updated_at"),
                "updated_by": str(updated_by_val) if updated_by_val is not None else None,
                "tools": stored_tools,
            }
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.autocommit = prev_autocommit

    def list_tenant_mcp_policy_changes(
        self, tenant_id: str, *, limit: int = 50
    ) -> List[Dict[str, Any]]:
        """Return MCP policy change audit rows newest first (MTG-5.2 / #4786).

        Args:
            tenant_id: Owning tenant UUID. Non-UUID values return ``[]``.
            limit: Max rows (clamped to 1..200).

        Returns:
            Dicts with ``id``, ``actor_user_id``, ``actor_label``, ``created_at``,
            ``before_policy``, ``after_policy``.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return []
        capped = max(1, min(int(limit), 200))
        rows = self.execute_query(
            """
            SELECT id::text, actor_user_id::text, actor_label, created_at,
                   before_policy, after_policy
            FROM apiome.tenant_mcp_policy_changes
            WHERE tenant_id = %s::uuid
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            (tenant_id, capped),
        )
        out: List[Dict[str, Any]] = []
        for row in rows:
            before = row.get("before_policy")
            after = row.get("after_policy")
            if isinstance(before, str):
                try:
                    before = json.loads(before)
                except (TypeError, ValueError, json.JSONDecodeError):
                    before = {}
            if isinstance(after, str):
                try:
                    after = json.loads(after)
                except (TypeError, ValueError, json.JSONDecodeError):
                    after = {}
            actor = row.get("actor_user_id")
            out.append(
                {
                    "id": str(row["id"]),
                    "actor_user_id": str(actor) if actor is not None else None,
                    "actor_label": row.get("actor_label"),
                    "created_at": row.get("created_at"),
                    "before_policy": before if isinstance(before, dict) else {},
                    "after_policy": after if isinstance(after, dict) else {},
                }
            )
        return out

    # ------------------------------------------------------------------
    # MCP API keys lifecycle (MTG-3.2, #4776)
    # ------------------------------------------------------------------

    _MCP_API_KEY_PREFIX_CHARS = 12

    _MCP_API_KEY_METADATA_SELECT = """
        id, prefix, label, scope_json, capability_mode, enabled_tools,
        created_at, expires_at, revoked_at, last_used_at, created_by
    """

    @staticmethod
    def hash_mcp_api_key_secret(plain: str) -> str:
        """Hash an MCP API key secret the same way apiome-mcp does (bcrypt of SHA-256)."""
        digest = hashlib.sha256(plain.encode("utf-8")).digest()
        return bcrypt.hashpw(digest, bcrypt.gensalt()).decode("ascii")

    @classmethod
    def mcp_api_key_prefix(cls, secret: str) -> str:
        """Indexed lookup prefix: first 12 characters of the secret plus ``...``."""
        n = cls._MCP_API_KEY_PREFIX_CHARS
        if len(secret) < n:
            return secret + "..."
        return secret[:n] + "..."

    @staticmethod
    def _normalize_mcp_api_key_row(row: Dict[str, Any]) -> Dict[str, Any]:
        """Map a metadata SELECT row to JSON-serializable public fields (never ``key_hash``)."""
        scope = row.get("scope_json")
        if isinstance(scope, str):
            try:
                scope = json.loads(scope)
            except (TypeError, ValueError, json.JSONDecodeError):
                scope = {}
        if not isinstance(scope, dict):
            scope = {}
        created_by = row.get("created_by")
        enabled = row.get("enabled_tools")
        if isinstance(enabled, str):
            try:
                enabled = json.loads(enabled)
            except (TypeError, ValueError, json.JSONDecodeError):
                enabled = []
        if not isinstance(enabled, list):
            enabled = []
        return {
            "id": str(row["id"]),
            "prefix": str(row["prefix"]),
            "label": str(row["label"]),
            "scope_json": {
                "tenants": list(scope.get("tenants") or []),
                "projects": list(scope.get("projects") or []),
            },
            "capability_mode": str(row.get("capability_mode") or "inherit"),
            "enabled_tools": [
                str(t) for t in enabled if isinstance(t, str) and t.strip()
            ],
            "created_at": row.get("created_at"),
            "expires_at": row.get("expires_at"),
            "revoked_at": row.get("revoked_at"),
            "last_used_at": row.get("last_used_at"),
            "created_by": str(created_by) if created_by is not None else None,
        }

    def list_mcp_api_keys(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List MCP API key metadata for a tenant (includes revoked; never returns hashes).

        Args:
            tenant_id: Owning tenant UUID.

        Returns:
            Public metadata dicts ordered by ``created_at`` descending. Empty when none.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            return []
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_API_KEY_METADATA_SELECT}
            FROM apiome.mcp_api_keys
            WHERE tenant_id = %s::uuid
            ORDER BY created_at DESC
            """,
            (tenant_id,),
        )
        return [self._normalize_mcp_api_key_row(row) for row in rows]

    def get_mcp_api_key(
        self, tenant_id: str, key_id: str
    ) -> Optional[Dict[str, Any]]:
        """Load one MCP API key's public metadata for the tenant, or ``None``.

        Args:
            tenant_id: Owning tenant UUID.
            key_id: Key row UUID.
        """
        if (
            not tenant_id
            or not is_uuid_string(str(tenant_id))
            or not key_id
            or not is_uuid_string(str(key_id))
        ):
            return None
        rows = self.execute_query(
            f"""
            SELECT {self._MCP_API_KEY_METADATA_SELECT}
            FROM apiome.mcp_api_keys
            WHERE tenant_id = %s::uuid AND id = %s::uuid
            """,
            (tenant_id, key_id),
        )
        if not rows:
            return None
        return self._normalize_mcp_api_key_row(rows[0])

    def create_mcp_api_key(
        self,
        tenant_id: str,
        *,
        label: str,
        scope_json: Optional[Dict[str, Any]] = None,
        expires_at: Optional[datetime] = None,
        created_by: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], str]:
        """Issue a new MCP API key; return ``(public_metadata, plaintext_secret)``.

        The plaintext secret is returned **once** for the caller to display; only the
        bcrypt(SHA-256) hash and prefix are stored. ``capability_mode`` / ``enabled_tools``
        use table defaults (``inherit`` / ``[]``) — capability writes are MTG-3.3.

        Args:
            tenant_id: Owning tenant UUID.
            label: Human label (non-empty).
            scope_json: ``{"tenants":[...],"projects":[...]}``; default empty lists.
            expires_at: Optional expiry timestamp (timezone-aware preferred).
            created_by: Acting user UUID, or ``None``.

        Returns:
            Tuple of public metadata dict and the one-time plaintext secret.

        Raises:
            ValueError: When ids are not UUIDs or ``label`` is blank.
        """
        if not tenant_id or not is_uuid_string(str(tenant_id)):
            raise ValueError("tenant_id must be a UUID")
        if created_by is not None and not is_uuid_string(str(created_by)):
            raise ValueError("created_by must be a UUID or None")
        trimmed = (label or "").strip()
        if not trimmed:
            raise ValueError("label must be non-empty")

        scope = scope_json if isinstance(scope_json, dict) else {}
        tenants = scope.get("tenants") if isinstance(scope.get("tenants"), list) else []
        projects = (
            scope.get("projects") if isinstance(scope.get("projects"), list) else []
        )
        stored_scope = {
            "tenants": [str(t) for t in tenants if isinstance(t, str)],
            "projects": [str(p) for p in projects if isinstance(p, str)],
        }

        plain = secrets.token_urlsafe(32)
        key_hash = self.hash_mcp_api_key_secret(plain)
        prefix = self.mcp_api_key_prefix(plain)

        rows = self.execute_query(
            f"""
            INSERT INTO apiome.mcp_api_keys (
                key_hash, prefix, label, tenant_id, scope_json, created_by, expires_at
            )
            VALUES (%s, %s, %s, %s::uuid, %s::jsonb, %s::uuid, %s)
            RETURNING {self._MCP_API_KEY_METADATA_SELECT}
            """,
            (
                key_hash,
                prefix,
                trimmed,
                tenant_id,
                Json(stored_scope),
                created_by,
                expires_at,
            ),
        )
        if not rows:
            raise RuntimeError("INSERT INTO mcp_api_keys returned no row")
        return self._normalize_mcp_api_key_row(rows[0]), plain

    def update_mcp_api_key(
        self,
        tenant_id: str,
        key_id: str,
        *,
        label: Optional[str] = None,
        update_label: bool = False,
        expires_at: Optional[datetime] = None,
        update_expires_at: bool = False,
        scope_json: Optional[Dict[str, Any]] = None,
        update_scope_json: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Patch label / expires_at / scope_json on an **active** MCP API key.

        Args:
            tenant_id: Owning tenant UUID.
            key_id: Key row UUID.
            label: New label when ``update_label``.
            update_label: Whether to apply ``label``.
            expires_at: New expiry (or ``None`` to clear) when ``update_expires_at``.
            update_expires_at: Whether to apply ``expires_at``.
            scope_json: New scope object when ``update_scope_json``.
            update_scope_json: Whether to apply ``scope_json``.

        Returns:
            Updated public metadata, or ``None`` when the key is missing / revoked /
            not in this tenant.
        """
        if (
            not tenant_id
            or not is_uuid_string(str(tenant_id))
            or not key_id
            or not is_uuid_string(str(key_id))
        ):
            return None
        if not (update_label or update_expires_at or update_scope_json):
            return self.get_mcp_api_key(tenant_id, key_id)

        sets: List[str] = []
        params: List[Any] = []
        if update_label:
            trimmed = (label or "").strip()
            if not trimmed:
                raise ValueError("label must be non-empty")
            sets.append("label = %s")
            params.append(trimmed)
        if update_expires_at:
            sets.append("expires_at = %s")
            params.append(expires_at)
        if update_scope_json:
            scope = scope_json if isinstance(scope_json, dict) else {}
            tenants = (
                scope.get("tenants") if isinstance(scope.get("tenants"), list) else []
            )
            projects = (
                scope.get("projects") if isinstance(scope.get("projects"), list) else []
            )
            stored_scope = {
                "tenants": [str(t) for t in tenants if isinstance(t, str)],
                "projects": [str(p) for p in projects if isinstance(p, str)],
            }
            sets.append("scope_json = %s::jsonb")
            params.append(Json(stored_scope))

        params.extend([tenant_id, key_id])
        rows = self.execute_query(
            f"""
            UPDATE apiome.mcp_api_keys
            SET {", ".join(sets)}
            WHERE tenant_id = %s::uuid
              AND id = %s::uuid
              AND revoked_at IS NULL
            RETURNING {self._MCP_API_KEY_METADATA_SELECT}
            """,
            tuple(params),
        )
        if not rows:
            return None
        return self._normalize_mcp_api_key_row(rows[0])

    def revoke_mcp_api_key(
        self, tenant_id: str, key_id: str
    ) -> Optional[Dict[str, Any]]:
        """Soft-revoke an MCP API key (set ``revoked_at``).

        Already-revoked keys are returned unchanged (idempotent). Missing keys
        yield ``None``.

        Args:
            tenant_id: Owning tenant UUID.
            key_id: Key row UUID.

        Returns:
            Public metadata after revoke (``revoked_at`` set), or ``None`` if unknown.
        """
        if (
            not tenant_id
            or not is_uuid_string(str(tenant_id))
            or not key_id
            or not is_uuid_string(str(key_id))
        ):
            return None
        existing = self.get_mcp_api_key(tenant_id, key_id)
        if existing is None:
            return None
        if existing.get("revoked_at") is not None:
            return existing
        rows = self.execute_query(
            f"""
            UPDATE apiome.mcp_api_keys
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE tenant_id = %s::uuid
              AND id = %s::uuid
              AND revoked_at IS NULL
            RETURNING {self._MCP_API_KEY_METADATA_SELECT}
            """,
            (tenant_id, key_id),
        )
        if not rows:
            # Race: another writer revoked between SELECT and UPDATE.
            return self.get_mcp_api_key(tenant_id, key_id)
        return self._normalize_mcp_api_key_row(rows[0])

    def update_mcp_api_key_capabilities(
        self,
        tenant_id: str,
        key_id: str,
        *,
        capability_mode: str,
        enabled_tools: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Set per-key capability grants on an **active** MCP API key (MTG-3.3, #4777).

        ``inherit`` always persists ``enabled_tools=[]``. ``explicit`` stores the
        provided list (callers must already enforce ⊆ tenant ceiling). The DB
        trigger remains a second line of defense for ceiling violations.

        Args:
            tenant_id: Owning tenant UUID.
            key_id: Key row UUID.
            capability_mode: ``inherit`` or ``explicit``.
            enabled_tools: Tool ids when ``explicit``; ignored (cleared) under inherit.

        Returns:
            Updated public metadata including ``capability_mode`` /
            ``enabled_tools``, or ``None`` when the key is missing / revoked /
            not in this tenant.

        Raises:
            ValueError: When ``capability_mode`` is not inherit|explicit.
        """
        if (
            not tenant_id
            or not is_uuid_string(str(tenant_id))
            or not key_id
            or not is_uuid_string(str(key_id))
        ):
            return None
        mode = (capability_mode or "").strip()
        if mode not in ("inherit", "explicit"):
            raise ValueError("capability_mode must be 'inherit' or 'explicit'")

        if mode == "inherit":
            stored_tools: List[str] = []
        else:
            seen: Set[str] = set()
            stored_tools = []
            for raw in enabled_tools or []:
                if not isinstance(raw, str):
                    continue
                tid = raw.strip()
                if not tid or tid in seen:
                    continue
                seen.add(tid)
                stored_tools.append(tid)

        rows = self.execute_query(
            f"""
            UPDATE apiome.mcp_api_keys
            SET capability_mode = %s,
                enabled_tools = %s::jsonb
            WHERE tenant_id = %s::uuid
              AND id = %s::uuid
              AND revoked_at IS NULL
            RETURNING {self._MCP_API_KEY_METADATA_SELECT}
            """,
            (mode, Json(stored_tools), tenant_id, key_id),
        )
        if not rows:
            return None
        return self._normalize_mcp_api_key_row(rows[0])

    def list_mcp_tool_invocation_stats(
        self, endpoint_id: str, window_days: int
    ) -> List[Dict[str, Any]]:
        """Return an endpoint's recent *tool* test invocations for the per-tool latency panel.

        One row per recorded tool call within the trailing ``window_days`` window: the tool's
        ``item_name``, whether it errored, and its round-trip ``latency_ms`` (NULL when the call
        never completed). Only ``item_type = 'tool'`` rows are returned — the panel (MCAT-17.2) ranks
        tool latency and error rate — and only those recorded within the window, so the panel is
        time-windowed. The pure :func:`~app.mcp_insight_aggregation.compute_tool_reliability` groups
        these by tool into per-tool percentiles, error rates, and a latency distribution.

        Args:
            endpoint_id: The owning endpoint (already tenant-validated by the caller).
            window_days: The trailing window in days (clamped to at least 1).

        Returns:
            One dict per tool invocation in the window; empty when no tool has been tested recently.
        """
        capped = max(1, int(window_days))
        q = """
            SELECT item_name, is_error, latency_ms
            FROM apiome.mcp_test_invocations
            WHERE endpoint_id = %s::uuid
              AND item_type = 'tool'
              AND created_at >= CURRENT_TIMESTAMP - make_interval(days => %s)
        """
        return self.execute_query(q, (endpoint_id, capped))

    def get_mcp_catalog_insight(self, tenant_id: str) -> Dict[str, Any]:
        """Return a tenant-wide roll-up of its live MCP catalog (feeds 18.1).

        Aggregates every live (non-deleted) endpoint the tenant owns into a single row: the total
        endpoint count, how many are published / discovered (have a current surface), the per-kind
        capability totals across every endpoint's *current* version, the average quality score and
        the A-F grade distribution over those current versions. Everything is scoped by
        ``tenant_id`` directly, so the aggregate only ever spans the caller's own catalog.

        The capability totals and the grade distribution both hang off each endpoint's
        ``current_version_id`` (its latest surface), so an endpoint that was never discovered
        contributes to ``endpoint_count`` but not to the surface totals or the grade histogram.

        Args:
            tenant_id: The owning tenant whose catalog to summarize.

        Returns:
            A dict with the scalar tallies, ``grade_distribution`` (a ``grade → count`` map), and the
            composition breakdowns the catalog analytics dashboard renders (18.1): ``category_rows``,
            ``transport_rows``, ``protocol_rows``, ``discovery_rows`` (each ``{label, count}``),
            ``change_leader_rows`` (``{endpoint_id, name, change_count}``), ``top_capability_rows``
            (``{item_type, item_name, endpoint_count}``), and ``tool_count_rows`` (one ``{tool_count}``
            per live endpoint, folded into a histogram by the wire projection).
        """
        # Count each endpoint's current-surface items by kind via a correlated subquery, so an
        # endpoint with many items does not fan the tenant-level aggregate.
        def _kind_total(kind: str) -> str:
            return (
                "COALESCE(SUM((SELECT COUNT(*) FROM apiome.mcp_capability_items i "
                f"WHERE i.version_id = e.current_version_id AND i.item_type = '{kind}')), 0)"
            )

        summary_q = f"""
            SELECT
                COUNT(*)                                                 AS endpoint_count,
                COUNT(*) FILTER (WHERE e.published)                      AS published_count,
                COUNT(*) FILTER (WHERE e.visibility = 'public')          AS public_count,
                COUNT(*) FILTER (WHERE e.visibility = 'private')         AS private_count,
                COUNT(*) FILTER (WHERE e.current_version_id IS NOT NULL) AS discovered_count,
                {_kind_total('tool')}              AS tool_count,
                {_kind_total('resource')}          AS resource_count,
                {_kind_total('resource_template')} AS resource_template_count,
                {_kind_total('prompt')}            AS prompt_count,
                AVG(s.score)                                             AS avg_score,
                COUNT(s.score)                                           AS scored_count
            FROM apiome.mcp_endpoints e
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
        """
        grade_q = """
            SELECT s.grade AS grade, COUNT(*) AS count
            FROM apiome.mcp_endpoints e
            JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL AND s.grade IS NOT NULL
            GROUP BY s.grade
            ORDER BY s.grade ASC
        """
        # Composition breakdowns (18.1) — each is a simple GROUP BY over the same live-endpoint scope,
        # ordered so the busiest bucket leads (with a stable label tiebreak for determinism). NULL
        # labels are preserved here and mapped to a friendly bucket ("Uncategorized"/"Unknown"/"never")
        # in the wire projection, not in SQL.
        category_q = """
            SELECT e.category AS label, COUNT(*) AS count
            FROM apiome.mcp_endpoints e
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            GROUP BY e.category
            ORDER BY count DESC, e.category ASC NULLS LAST
        """
        transport_q = """
            SELECT e.transport AS label, COUNT(*) AS count
            FROM apiome.mcp_endpoints e
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            GROUP BY e.transport
            ORDER BY count DESC, e.transport ASC
        """
        # Protocol adoption hangs off each endpoint's current surface: only discovered endpoints
        # (current_version_id set) have a reported protocol_version, so never-discovered servers do
        # not appear here.
        protocol_q = """
            SELECT v.protocol_version AS label, COUNT(*) AS count
            FROM apiome.mcp_endpoints e
            JOIN apiome.mcp_endpoint_versions v ON v.id = e.current_version_id
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            GROUP BY v.protocol_version
            ORDER BY count DESC, v.protocol_version ASC NULLS LAST
        """
        # Discovery-health rollup — every live endpoint counts, including those never discovered
        # (last_discovery_status IS NULL → mapped to "never" in the projection).
        discovery_q = """
            SELECT e.last_discovery_status AS label, COUNT(*) AS count
            FROM apiome.mcp_endpoints e
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            GROUP BY e.last_discovery_status
            ORDER BY count DESC, e.last_discovery_status ASC NULLS LAST
        """
        # Change-frequency leaders — the endpoints whose surface has churned the most, counted over
        # every recorded change across all their versions (not just the current one).
        change_leader_q = """
            SELECT e.id AS endpoint_id, e.name AS name, COUNT(c.id) AS change_count
            FROM apiome.mcp_endpoints e
            JOIN apiome.mcp_endpoint_versions v ON v.endpoint_id = e.id
            JOIN apiome.mcp_version_changes c ON c.version_id = v.id
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            GROUP BY e.id, e.name
            ORDER BY change_count DESC, e.name ASC
            LIMIT 8
        """
        # Top capabilities — the most widely exposed capability names across the tenant's current
        # surfaces, ranked by how many distinct endpoints expose each (a real aggregate standing in
        # for "most-searched", which has no backing search-query log). item_type is carried so the
        # panel can badge tool vs resource vs prompt.
        top_capability_q = """
            SELECT i.item_type AS item_type, i.name AS item_name,
                   COUNT(DISTINCT e.id) AS endpoint_count
            FROM apiome.mcp_endpoints e
            JOIN apiome.mcp_capability_items i ON i.version_id = e.current_version_id
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            GROUP BY i.item_type, i.name
            ORDER BY endpoint_count DESC, i.name ASC
            LIMIT 8
        """
        # Per-endpoint tool counts feed the pure tool-count histogram (compute_tool_count_histogram):
        # one row per live endpoint, its count being the number of 'tool' items on its current surface
        # (0 for a never-discovered or tool-less endpoint), so the distribution spans the whole catalog.
        tool_count_q = """
            SELECT COALESCE(
                (SELECT COUNT(*) FROM apiome.mcp_capability_items i
                 WHERE i.version_id = e.current_version_id AND i.item_type = 'tool'), 0
            ) AS tool_count
            FROM apiome.mcp_endpoints e
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
        """
        summary_rows = self.execute_query(summary_q, (tenant_id,))
        grade_rows = self.execute_query(grade_q, (tenant_id,))
        summary = dict(summary_rows[0]) if summary_rows else {}
        summary["grade_distribution"] = {
            str(r["grade"]): int(r["count"]) for r in grade_rows
        }
        summary["category_rows"] = self.execute_query(category_q, (tenant_id,))
        summary["transport_rows"] = self.execute_query(transport_q, (tenant_id,))
        summary["protocol_rows"] = self.execute_query(protocol_q, (tenant_id,))
        summary["discovery_rows"] = self.execute_query(discovery_q, (tenant_id,))
        summary["change_leader_rows"] = self.execute_query(change_leader_q, (tenant_id,))
        summary["top_capability_rows"] = self.execute_query(top_capability_q, (tenant_id,))
        summary["tool_count_rows"] = self.execute_query(tool_count_q, (tenant_id,))
        return summary

    def get_mcp_category_cohort(
        self, tenant_id: str, category: Optional[str]
    ) -> List[Dict[str, Any]]:
        """Return every live endpoint sharing a category, with the materials to rank its peer axes (18.3).

        The cohort for the peer-percentile ranking: all of the tenant's live (non-deleted) endpoints in
        the same catalog ``category`` as the endpoint being ranked (including it). A ``NULL`` / blank
        category forms its own "uncategorized" cohort, so those servers are still ranked against each
        other rather than against the whole catalog. Everything needed to compute each member's four
        ranked axes (grade / safety / documentation / latency) is fetched here in a fixed handful of
        bulk queries — independent of cohort size — so the route can compute the ranking in one pass
        with no per-member round-trips:

        * ``score`` / ``grade`` from the member's current version's ``mcp_version_scores`` (grade axis);
        * ``auth_type`` from its stored credential (safety axis cross-reference);
        * ``version`` + ``items`` — the current snapshot's ``mcp_endpoint_versions`` row and its
          ``mcp_capability_items`` — to reconstruct the surface for the safety & documentation axes;
        * ``invocation_stats`` — its ``mcp_test_invocations`` ``(is_error, latency_ms)`` rows for the
          latency axis.

        A member that was never discovered (no ``current_version_id``) carries ``version=None`` and an
        empty ``items`` list, so it simply contributes gaps on the surface-derived axes rather than
        being dropped. Scoping is by ``tenant_id`` directly, so the cohort never leaks across tenants.

        Args:
            tenant_id: The owning tenant whose catalog the cohort is drawn from.
            category: The category to match; ``None`` / blank selects the uncategorized cohort.

        Returns:
            One dict per cohort member with keys ``endpoint_id``, ``current_version_id``, ``score``,
            ``grade``, ``auth_type``, ``version``, ``items``, and ``invocation_stats``. Empty when the
            tenant has no live endpoint in the category.
        """
        normalized = (category or "").strip()
        # Members of the cohort. A blank/NULL category selects the uncategorized bucket so those
        # servers rank against each other, not the whole catalog.
        base_select = """
            SELECT e.id AS endpoint_id, e.current_version_id,
                   s.score, s.grade, cr.auth_type
            FROM apiome.mcp_endpoints e
            LEFT JOIN apiome.mcp_version_scores s ON s.version_id = e.current_version_id
            LEFT JOIN apiome.mcp_endpoint_credentials cr ON cr.endpoint_id = e.id
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
        """
        if normalized:
            members = self.execute_query(
                base_select + " AND e.category = %s", (tenant_id, normalized)
            )
        else:
            members = self.execute_query(
                base_select + " AND (e.category IS NULL OR e.category = '')", (tenant_id,)
            )
        if not members:
            return []

        version_ids = [
            str(m["current_version_id"]) for m in members if m.get("current_version_id")
        ]
        endpoint_ids = [str(m["endpoint_id"]) for m in members]

        # Current-version surface-identity rows (for reconstruct_surface), keyed by version id.
        versions_by_id: Dict[str, Dict[str, Any]] = {}
        if version_ids:
            version_rows = self.execute_query(
                """
                SELECT v.id, v.endpoint_id, v.protocol_version, v.server_name, v.server_title,
                       v.server_version, v.instructions, v.capabilities
                FROM apiome.mcp_endpoint_versions v
                WHERE v.id = ANY(%s::uuid[])
                """,
                (version_ids,),
            )
            versions_by_id = {str(r["id"]): dict(r) for r in version_rows}

        # Capability items for every cohort current version, grouped by version id in discovery order
        # (matching :meth:`get_mcp_capability_items`).
        items_by_version: Dict[str, List[Dict[str, Any]]] = {}
        if version_ids:
            item_rows = self.execute_query(
                """
                SELECT version_id, item_type, name, title, description, input_schema,
                       output_schema, annotations, uri, uri_template, raw, ordinal
                FROM apiome.mcp_capability_items
                WHERE version_id = ANY(%s::uuid[])
                ORDER BY item_type ASC, ordinal ASC
                """,
                (version_ids,),
            )
            for row in item_rows:
                items_by_version.setdefault(str(row["version_id"]), []).append(dict(row))

        # Test-invocation reliability rows for every cohort endpoint, grouped by endpoint id.
        invocations_by_endpoint: Dict[str, List[Dict[str, Any]]] = {}
        if endpoint_ids:
            invocation_rows = self.execute_query(
                """
                SELECT endpoint_id, is_error, latency_ms
                FROM apiome.mcp_test_invocations
                WHERE endpoint_id = ANY(%s::uuid[])
                """,
                (endpoint_ids,),
            )
            for row in invocation_rows:
                invocations_by_endpoint.setdefault(str(row["endpoint_id"]), []).append(
                    {"is_error": row["is_error"], "latency_ms": row["latency_ms"]}
                )

        cohort: List[Dict[str, Any]] = []
        for member in members:
            endpoint_id = str(member["endpoint_id"])
            version_id = (
                str(member["current_version_id"]) if member.get("current_version_id") else None
            )
            cohort.append(
                {
                    "endpoint_id": endpoint_id,
                    "current_version_id": version_id,
                    "score": member.get("score"),
                    "grade": member.get("grade"),
                    "auth_type": member.get("auth_type"),
                    "version": versions_by_id.get(version_id) if version_id else None,
                    "items": items_by_version.get(version_id, []) if version_id else [],
                    "invocation_stats": invocations_by_endpoint.get(endpoint_id, []),
                }
            )
        return cohort

    def get_mcp_similar_candidates(self, tenant_id: str) -> List[Dict[str, Any]]:
        """Return every live endpoint in the tenant with the materials to rank capability similarity (18.4).

        The candidate pool for the "similar servers" feature: all of the tenant's live (non-deleted)
        endpoints, each carrying what both similarity signals need, fetched in a fixed handful of bulk
        queries (independent of catalog size) so the route ranks in one pass with no per-endpoint
        round-trips:

        * ``capability_names`` — the current snapshot's ``mcp_capability_items`` names (every item type),
          the set the Jaccard capability-overlap signal compares;
        * ``embedding`` — the current snapshot's optional ``mcp_capability_embedding`` (V143), parsed to a
          float list, for the semantic cosine nearest-neighbour signal; ``None`` when the snapshot has no
          stored embedding, and empty across the board whenever pgvector embeddings are disabled or simply
          not yet backfilled (the feature then falls back to overlap-only — a graceful no-op).

        The target endpoint itself is included in the returned list (a caller filters it out of its own
        neighbour list); a never-discovered endpoint (no ``current_version_id``) carries an empty
        ``capability_names`` and a ``None`` ``embedding``, so it simply never ranks as a neighbour rather
        than being dropped. Scoping is by ``tenant_id`` directly, so the pool never leaks across tenants.

        Args:
            tenant_id: The owning tenant whose catalog the candidate pool is drawn from.

        Returns:
            One dict per live endpoint with keys ``endpoint_id``, ``name``, ``slug``, ``category``,
            ``current_version_id``, ``capability_names``, and ``embedding``. Empty when the tenant has no
            live endpoint.
        """
        endpoints = self.execute_query(
            """
            SELECT e.id AS endpoint_id, e.name, e.slug, e.category, e.current_version_id
            FROM apiome.mcp_endpoints e
            WHERE e.tenant_id = %s::uuid AND e.deleted_at IS NULL
            """,
            (tenant_id,),
        )
        if not endpoints:
            return []

        version_ids = [
            str(e["current_version_id"]) for e in endpoints if e.get("current_version_id")
        ]

        # Capability names for every current version (all item types), grouped by version id.
        names_by_version: Dict[str, List[str]] = {}
        if version_ids:
            name_rows = self.execute_query(
                """
                SELECT version_id, name
                FROM apiome.mcp_capability_items
                WHERE version_id = ANY(%s::uuid[])
                """,
                (version_ids,),
            )
            for row in name_rows:
                if row.get("name"):
                    names_by_version.setdefault(str(row["version_id"]), []).append(row["name"])

        # Capability embeddings for every current version — optional (pgvector, V143). Read as text and
        # parsed so no register_vector adapter is needed. Wrapped defensively: if the pgvector type is
        # unavailable (extension/column missing on an un-migrated database), degrade to overlap-only
        # rather than failing the whole request — execute_query already rolled the failed read back.
        embeddings_by_version: Dict[str, List[float]] = {}
        if version_ids:
            try:
                embedding_rows = self.execute_query(
                    """
                    SELECT id, mcp_capability_embedding::text AS embedding
                    FROM apiome.mcp_endpoint_versions
                    WHERE id = ANY(%s::uuid[]) AND mcp_capability_embedding IS NOT NULL
                    """,
                    (version_ids,),
                )
                for row in embedding_rows:
                    parsed = _parse_pgvector_text(row.get("embedding"))
                    if parsed is not None:
                        embeddings_by_version[str(row["id"])] = parsed
            except Exception as exc:  # pragma: no cover - only on an un-migrated / no-pgvector database
                _logger.warning(
                    "[mcp-similar] capability-embedding read failed (%s); falling back to overlap-only",
                    exc,
                )

        candidates: List[Dict[str, Any]] = []
        for endpoint in endpoints:
            version_id = (
                str(endpoint["current_version_id"]) if endpoint.get("current_version_id") else None
            )
            candidates.append(
                {
                    "endpoint_id": str(endpoint["endpoint_id"]),
                    "name": endpoint.get("name"),
                    "slug": endpoint.get("slug"),
                    "category": endpoint.get("category"),
                    "current_version_id": version_id,
                    "capability_names": names_by_version.get(version_id, []) if version_id else [],
                    "embedding": embeddings_by_version.get(version_id) if version_id else None,
                }
            )
        return candidates

    def store_mcp_capability_embedding(
        self, version_id: str, embedding: List[float]
    ) -> bool:
        """Persist a version snapshot's capability embedding for semantic similarity (18.4).

        Writes the ``mcp_capability_embedding`` (V143) of one ``mcp_endpoint_versions`` snapshot — the
        backfill step behind the flag-gated similar-servers reindex. Mirrors
        :meth:`update_data_snapshot_embedding`: the vector is registered via the ``pgvector`` psycopg2
        adapter and, if that adapter or the ``vector`` type is unavailable (an un-migrated / no-pgvector
        database), the write is skipped and ``False`` returned rather than raising — the feature simply
        stays in overlap-only mode.

        Args:
            version_id: The snapshot whose embedding to store.
            embedding: The capability embedding vector; an empty vector is a no-op (returns ``False``).

        Returns:
            ``True`` when the embedding was written, ``False`` when it was skipped (empty vector or
            pgvector unavailable).
        """
        if not embedding:
            return False

        vector = np.array(embedding, dtype=np.float32)
        conn = self.connect()
        try:
            from pgvector.psycopg2 import register_vector

            register_vector(conn)
        except Exception as exc:
            _logger.warning(
                "[mcp-similar] pgvector adapter unavailable (%s); capability embedding not stored for "
                "version_id=%s",
                exc,
                version_id,
            )
            return False

        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE apiome.mcp_endpoint_versions
                    SET mcp_capability_embedding = %s
                    WHERE id = %s::uuid
                    """,
                    (vector, version_id),
                )
            conn.commit()
            return True
        except Exception as exc:
            conn.rollback()
            code = getattr(exc, "pgcode", None) or getattr(exc, "code", None)
            msg = str(getattr(exc, "message", exc) or exc)
            if code == "42704" or ("vector" in msg.lower() and "does not exist" in msg.lower()):
                _logger.warning(
                    "[mcp-similar] pgvector type unavailable (%s); capability embedding not stored for "
                    "version_id=%s",
                    msg,
                    version_id,
                )
                return False
            raise

    def get_mcp_server_digest(self, surface_fingerprint: str) -> Optional[Dict[str, Any]]:
        """Fetch the cached natural-language digest for a surface, keyed by fingerprint (18.5).

        The digest + schema-derived examples are computed once per ``surface_fingerprint`` and stored in
        ``mcp_server_digests`` (V144). Because a surface change mints a new version with a new fingerprint,
        keying the cache on the fingerprint gives the "regenerated on surface change" behaviour for free:
        the new surface simply misses the cache. The digest is derived entirely from a server's *declared*
        public surface (no tenant secrets), so the cache is global — two tenants cataloging the same server
        snapshot share one entry.

        Args:
            surface_fingerprint: The snapshot's stable ``surface_fingerprint``.

        Returns:
            The cached row (``digest``, ``examples``, ``model``, ``generated_at``), or ``None`` on a miss.
        """
        if not surface_fingerprint:
            return None
        q = """
            SELECT surface_fingerprint, digest, examples, model, generated_at
            FROM apiome.mcp_server_digests
            WHERE surface_fingerprint = %s
        """
        rows = self.execute_query(q, (surface_fingerprint,))
        return rows[0] if rows else None

    def store_mcp_server_digest(
        self,
        surface_fingerprint: str,
        digest: str,
        examples: List[Dict[str, Any]],
        model: str,
    ) -> Dict[str, Any]:
        """Cache a generated digest + examples for a surface, upserting by fingerprint (18.5).

        Writes (or refreshes) the ``mcp_server_digests`` row for ``surface_fingerprint`` so a later read
        for the same surface is served from cache and the model is not called again. ``examples`` is the
        schema-derived per-tool example list (stored as JSONB); ``generated_at`` is stamped ``now()`` by
        the database. A repeat generation for the same fingerprint (e.g. after a model change) overwrites
        the prior row in place.

        Args:
            surface_fingerprint: The snapshot's stable ``surface_fingerprint`` (the cache key).
            digest: The natural-language digest text.
            examples: The per-tool example calls to cache alongside the digest.
            model: The Claude model that produced the digest, recorded as provenance.

        Returns:
            The stored row (``surface_fingerprint``, ``digest``, ``examples``, ``model``, ``generated_at``).
        """
        q = """
            INSERT INTO apiome.mcp_server_digests
                (surface_fingerprint, digest, examples, model, generated_at)
            VALUES (%s, %s, %s::jsonb, %s, now())
            ON CONFLICT (surface_fingerprint) DO UPDATE
              SET digest = EXCLUDED.digest,
                  examples = EXCLUDED.examples,
                  model = EXCLUDED.model,
                  generated_at = now()
            RETURNING surface_fingerprint, digest, examples, model, generated_at
        """
        rows = self.execute_query(
            q, (surface_fingerprint, digest, json.dumps(examples), model)
        )
        return rows[0]

    def upsert_repository_import_spec(
        self,
        tenant_id: str,
        repository_id: str,
        branch: str,
        path: str,
        project_id: str,
        source_kind: str,
        options: Dict[str, Any],
        format_override: Optional[str] = None,
        content_type: Optional[str] = None,
        spec_schema_version: int = 1,
        created_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Insert or refresh the persisted import spec for one repository file (RAR-1.1).

        Keyed on the imported-file lineage ``(repository_id, branch, path)``: a
        repeat import of the same file updates the existing row in place so the
        table always holds the latest spec. ``options`` is the full
        ``SpecImportOptions`` payload and is stored verbatim in ``options_json``.

        The insert is guarded by a subquery so a row is only written when the
        repository belongs to the given tenant.

        Freshness signals (RAR-2.1) — ``last_imported_commit_sha``,
        ``last_imported_committed_at``, ``last_imported_blob_sha`` — are copied from
        the matching indexed ``tenant_repository_files`` row via a LEFT JOIN, so the
        spec records the repository's observed recency for the file at import time.
        When no scan row matches the lineage the anchors are stored as ``NULL`` and
        the newer-than comparator (RAR-2.2) falls back to checksum-only gating.

        Args:
            tenant_id: Owning tenant id.
            repository_id: Source repository id (must belong to ``tenant_id``).
            branch: Branch the file was imported from.
            path: Repository-relative file path (lineage key).
            project_id: Catalog project the import targeted.
            source_kind: Importer discriminator (for example ``openapi-3``).
            options: Full ``SpecImportOptions`` payload to persist.
            format_override: Explicit importer ``--format`` override, if any.
            content_type: MIME type used to read the file, if known.
            spec_schema_version: Envelope version of the stored spec.
            created_by: User id that initiated the import, if known.

        Returns:
            The persisted row as a dict.

        Raises:
            ValueError: If the repository does not belong to the tenant.
        """
        import json

        query = """
            INSERT INTO apiome.repository_import_spec (
                tenant_id, repository_id, branch, path, project_id,
                source_kind, format_override, content_type,
                options_json, spec_schema_version, created_by,
                last_imported_commit_sha, last_imported_committed_at, last_imported_blob_sha
            )
            SELECT %s::uuid, %s::uuid, %s, %s, %s::uuid,
                   %s, %s, %s,
                   %s::jsonb, %s, %s::uuid,
                   trf.commit_sha, trf.committed_at, trf.blob_sha
            FROM apiome.tenant_repositories tr
            LEFT JOIN apiome.tenant_repository_files trf
                ON trf.repository_id = tr.id AND trf.branch = %s AND trf.path = %s
            WHERE tr.id = %s::uuid AND tr.tenant_id = %s::uuid AND tr.deleted_at IS NULL
            ON CONFLICT ON CONSTRAINT uq_repository_import_spec_repo_branch_path
            DO UPDATE SET
                tenant_id = EXCLUDED.tenant_id,
                project_id = EXCLUDED.project_id,
                source_kind = EXCLUDED.source_kind,
                format_override = EXCLUDED.format_override,
                content_type = EXCLUDED.content_type,
                options_json = EXCLUDED.options_json,
                spec_schema_version = EXCLUDED.spec_schema_version,
                created_by = EXCLUDED.created_by,
                last_imported_commit_sha = EXCLUDED.last_imported_commit_sha,
                last_imported_committed_at = EXCLUDED.last_imported_committed_at,
                last_imported_blob_sha = EXCLUDED.last_imported_blob_sha,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, tenant_id, repository_id, branch, path, project_id,
                      source_kind, format_override, content_type,
                      options_json, spec_schema_version, created_by,
                      last_imported_commit_sha, last_imported_committed_at,
                      last_imported_blob_sha, created_at, updated_at
        """
        params = (
            tenant_id, repository_id, branch, path, project_id,
            source_kind, format_override, content_type,
            json.dumps(options or {}), spec_schema_version, created_by,
            branch, path,
            repository_id, tenant_id,
        )
        conn = self.connect()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query, params)
                row = cursor.fetchone()
                conn.commit()
            if row is None:
                raise ValueError(
                    f"Repository {repository_id} not found for tenant {tenant_id}; "
                    "import spec not persisted."
                )
            return row
        except Exception as e:
            conn.rollback()
            raise e

    def get_repository_import_spec(
        self, tenant_id: str, repository_id: str, branch: str, path: str
    ) -> Optional[Dict[str, Any]]:
        """Return the persisted import spec for one repository file, or None.

        Args:
            tenant_id: Owning tenant id (scopes the lookup).
            repository_id: Source repository id.
            branch: Branch the file was imported from.
            path: Repository-relative file path (lineage key).

        Returns:
            The stored row as a dict, or None when no spec exists.
        """
        query = """
            SELECT id, tenant_id, repository_id, branch, path, project_id,
                   source_kind, format_override, content_type,
                   options_json, spec_schema_version, created_by,
                   last_imported_commit_sha, last_imported_committed_at,
                   last_imported_blob_sha, created_at, updated_at
            FROM apiome.repository_import_spec
            WHERE tenant_id = %s::uuid
              AND repository_id = %s::uuid
              AND branch = %s
              AND path = %s
        """
        results = self.execute_query(query, (tenant_id, repository_id, branch, path))
        return results[0] if results else None

    def get_repository_import_options(
        self, tenant_id: str, repository_id: str, branch: str, path: str
    ) -> Optional[Dict[str, Any]]:
        """Return the stored import options for one file, migrated to the current shape.

        Reads the persisted envelope and applies the versioned upgrade path
        (RAR-1.4): if the row's ``spec_schema_version`` is older than the current
        envelope version, the stored ``options_json`` blob is migrated forward so
        the caller always receives a current-shape options dictionary, regardless
        of when the spec was written. Used by repository auto-refresh to replay
        the user's original request.

        Args:
            tenant_id: Owning tenant id (scopes the lookup).
            repository_id: Source repository id.
            branch: Branch the file was imported from.
            path: Repository-relative file path (lineage key).

        Returns:
            The current-shape options as a dict, or None when no spec exists.
        """
        from .models import load_repository_import_options

        row = self.get_repository_import_spec(tenant_id, repository_id, branch, path)
        if row is None:
            return None
        return load_repository_import_options(row).model_dump()

    def get_repository_import_spec_by_id(
        self, tenant_id: str, spec_id: str
    ) -> Optional[Dict[str, Any]]:
        """Return one persisted import spec by its row id, scoped to a tenant (RAR-1.5).

        Backs the ``GET …/repository-imports/{id}/spec`` read endpoint. The
        ``tenant_id`` predicate enforces tenant isolation: a spec belonging to
        another tenant resolves to ``None`` (a 404 at the route) rather than
        leaking across tenants.

        Args:
            tenant_id: Owning tenant id (scopes the lookup).
            spec_id: ``apiome.repository_import_spec`` row id.

        Returns:
            The stored row as a dict, or None when no spec matches in the tenant.
        """
        query = """
            SELECT s.id, s.tenant_id, s.repository_id, s.branch, s.path, s.project_id,
                   s.source_kind, s.format_override, s.content_type,
                   s.options_json, s.spec_schema_version, s.created_by,
                   s.last_imported_commit_sha, s.last_imported_committed_at,
                   s.last_imported_blob_sha, s.created_at, s.updated_at,
                   trf.committed_at AS remote_committed_at,
                   trf.blob_sha AS remote_blob_sha
            FROM apiome.repository_import_spec s
            LEFT JOIN apiome.tenant_repository_files trf
              ON trf.repository_id = s.repository_id
             AND trf.branch = s.branch
             AND trf.path = s.path
            WHERE s.tenant_id = %s::uuid
              AND s.id = %s::uuid
        """
        results = self.execute_query(query, (tenant_id, spec_id))
        return results[0] if results else None

    def get_repository_import_spec_by_path(
        self,
        tenant_id: str,
        repository_id: str,
        path: str,
        branch: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Return the latest persisted import spec for a repository file path (RAR-1.5).

        Backs the ``?path=`` lookup variant of the read endpoint. The table keeps
        exactly one row per ``(repository_id, branch, path)`` lineage; when
        ``branch`` is given the lookup is exact, and when it is omitted the most
        recently updated row across branches for that ``(repository_id, path)`` is
        returned. The ``tenant_id`` predicate scopes the lookup so a path under
        another tenant's repository resolves to ``None``.

        Args:
            tenant_id: Owning tenant id (scopes the lookup).
            repository_id: Source repository id.
            path: Repository-relative file path (lineage key).
            branch: Branch to match exactly; when None, the latest across branches.

        Returns:
            The stored row as a dict, or None when no spec matches.
        """
        select = """
            SELECT s.id, s.tenant_id, s.repository_id, s.branch, s.path, s.project_id,
                   s.source_kind, s.format_override, s.content_type,
                   s.options_json, s.spec_schema_version, s.created_by,
                   s.last_imported_commit_sha, s.last_imported_committed_at,
                   s.last_imported_blob_sha, s.created_at, s.updated_at,
                   trf.committed_at AS remote_committed_at,
                   trf.blob_sha AS remote_blob_sha
            FROM apiome.repository_import_spec s
            LEFT JOIN apiome.tenant_repository_files trf
              ON trf.repository_id = s.repository_id
             AND trf.branch = s.branch
             AND trf.path = s.path
            WHERE s.tenant_id = %s::uuid
              AND s.repository_id = %s::uuid
              AND s.path = %s
        """
        if branch is not None:
            query = select + "  AND s.branch = %s\n            ORDER BY s.updated_at DESC\n            LIMIT 1"
            params: tuple = (tenant_id, repository_id, path, branch)
        else:
            query = select + "            ORDER BY s.updated_at DESC\n            LIMIT 1"
            params = (tenant_id, repository_id, path)
        results = self.execute_query(query, params)
        return results[0] if results else None

    def get_public_browse_directory_stats(self) -> Dict[str, int]:
        """Counts for tenants/projects/versions with published public revisions (browse directory)."""
        query = """
            SELECT
                COUNT(DISTINCT t.id)::int AS tenant_count,
                COUNT(DISTINCT p.id)::int AS project_count,
                COUNT(DISTINCT v.id)::int AS version_count
            FROM apiome.tenants t
            JOIN apiome.projects p ON t.id = p.tenant_id
            JOIN apiome.versions v ON p.id = v.project_id
            WHERE v.published = true
              AND v.visibility = 'public'
              AND t.deleted_at IS NULL
              AND p.deleted_at IS NULL
              AND v.deleted_at IS NULL
        """
        rows = self.execute_query(query)
        row = rows[0] if rows else {}
        return {
            "tenant_count": int(row.get("tenant_count") or 0),
            "project_count": int(row.get("project_count") or 0),
            "version_count": int(row.get("version_count") or 0),
        }

    def list_public_browse_tenants(
        self,
        *,
        search: Optional[str] = None,
        sort: str = "name",
    ) -> List[Dict[str, Any]]:
        """
        Tenants that have at least one published public version, with aggregates.
        Optional ``search`` filters by tenant name or slug (substring, case-insensitive).
        ``sort`` is one of: name, projects, latest.
        """
        sort_key = sort if sort in ("name", "projects", "latest") else "name"
        order_clause = {
            "name": "a.name ASC, a.slug ASC",
            "projects": "a.project_count DESC, a.name ASC, a.slug ASC",
            "latest": "a.latest_activity_at DESC NULLS LAST, a.name ASC, a.slug ASC",
        }[sort_key]

        search_clause = ""
        params: Tuple[Any, ...] = ()
        term = search.strip() if search and search.strip() else ""
        if term:
            search_clause = "AND (t.name ILIKE %s OR t.slug ILIKE %s)"
            pat = f"%{term}%"
            params = (pat, pat)

        query = f"""
            WITH eligible AS (
                SELECT
                    t.id AS tenant_id,
                    t.slug,
                    t.name,
                    p.id AS project_id,
                    v.id AS version_id,
                    v.version_id AS version_slug,
                    COALESCE(v.published_at, v.updated_at, v.created_at) AS activity_ts
                FROM apiome.tenants t
                INNER JOIN apiome.projects p ON t.id = p.tenant_id
                INNER JOIN apiome.versions v ON p.id = v.project_id
                WHERE v.published = true
                  AND v.visibility = 'public'
                  AND t.deleted_at IS NULL
                  AND p.deleted_at IS NULL
                  AND v.deleted_at IS NULL
                  {search_clause}
            ),
            agg AS (
                SELECT
                    tenant_id,
                    slug,
                    name,
                    COUNT(DISTINCT project_id)::int AS project_count,
                    COUNT(DISTINCT version_id)::int AS published_versions,
                    MAX(activity_ts) AS latest_activity_at
                FROM eligible
                GROUP BY tenant_id, slug, name
            ),
            latest_ver AS (
                SELECT DISTINCT ON (e.tenant_id)
                    e.tenant_id,
                    e.version_slug AS latest_version
                FROM eligible e
                ORDER BY e.tenant_id, e.activity_ts DESC NULLS LAST, e.version_slug DESC
            )
            SELECT
                a.slug,
                a.name,
                a.project_count,
                a.published_versions,
                lv.latest_version,
                a.latest_activity_at
            FROM agg a
            LEFT JOIN latest_ver lv ON lv.tenant_id = a.tenant_id
            ORDER BY {order_clause}
        """
        return self.execute_query(query, params)

    _BROWSE_PROJECT_DOMAIN_COMPARE_SQL = """
        LOWER(TRIM(COALESCE(
            NULLIF(TRIM(COALESCE(p.metadata->>'domain', '')), ''),
            CASE
                WHEN LOWER(TRIM(COALESCE(p.metadata->>'domainCategory', ''))) IN ('', 'none')
                THEN NULL
                ELSE TRIM(COALESCE(p.metadata->>'domainCategory', ''))
            END,
            ''
        )))
        """

    def list_public_browse_projects_for_tenant(
        self,
        tenant_id: str,
        *,
        search: Optional[str] = None,
        domain: Optional[str] = None,
        require_published: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Projects with at least one published **public** version (browse-app parity).

        Optional ``search`` filters slug/name (substring, case-insensitive).
        Optional ``domain`` filters metadata ``domain`` / ``domainCategory`` (case-insensitive).
        ``require_published`` retained for API symmetry; this listing already implies ≥1 public publish.
        """
        dom_sql = self._BROWSE_PROJECT_DOMAIN_COMPARE_SQL.strip()
        term = search.strip() if search and search.strip() else ""
        search_clause = ""
        params: List[Any] = [tenant_id]
        if term:
            search_clause = " AND (p.slug ILIKE %s OR p.name ILIKE %s)"
            pat = f"%{term}%"
            params.extend([pat, pat])
        domain_clause = ""
        domain_term = domain.strip() if domain and domain.strip() else ""
        if domain_term:
            domain_clause = f" AND ({dom_sql}) = LOWER(TRIM(%s))"
            params.append(domain_term)
        published_outer = ""
        if require_published:
            published_outer = " AND a.published_versions >= 1"

        query = f"""
            WITH eligible AS (
                SELECT
                    p.id AS project_id,
                    p.slug,
                    p.name,
                    p.metadata,
                    v.id AS version_id,
                    v.version_id AS version_slug,
                    COALESCE(v.published_at, v.updated_at, v.created_at) AS activity_ts
                FROM apiome.projects p
                INNER JOIN apiome.tenants t ON p.tenant_id = t.id
                INNER JOIN apiome.versions v ON p.id = v.project_id
                WHERE t.id = %s
                  AND v.published IS TRUE
                  AND v.visibility = 'public'
                  AND t.deleted_at IS NULL
                  AND p.deleted_at IS NULL
                  AND v.deleted_at IS NULL
                  {search_clause}
                  {domain_clause}
            ),
            agg AS (
                SELECT
                    e.project_id,
                    e.slug,
                    e.name,
                    e.metadata,
                    COUNT(DISTINCT e.version_id)::int AS published_versions,
                    MAX(e.activity_ts) AS latest_activity_ts
                FROM eligible e
                GROUP BY e.project_id, e.slug, e.name, e.metadata
            ),
            latest_ver AS (
                SELECT DISTINCT ON (e.project_id)
                    e.project_id,
                    e.version_slug AS latest_version,
                    e.activity_ts AS latest_published_at
                FROM eligible e
                ORDER BY e.project_id, e.activity_ts DESC NULLS LAST, e.version_slug DESC
            )
            SELECT
                a.slug,
                a.name,
                a.metadata,
                a.published_versions,
                lv.latest_version,
                lv.latest_published_at
            FROM agg a
            LEFT JOIN latest_ver lv ON lv.project_id = a.project_id
            WHERE 1 = 1
              {published_outer}
            ORDER BY a.slug ASC
        """
        return self.execute_query(query, tuple(params))

    def list_member_browse_projects_for_tenant(
        self,
        tenant_id: str,
        *,
        search: Optional[str] = None,
        domain: Optional[str] = None,
        require_published: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        All non-deleted projects for a tenant member (JWT/API key scoped to tenant).

        Counts and ``latest_*`` consider any published version (any visibility).
        """
        dom_sql = self._BROWSE_PROJECT_DOMAIN_COMPARE_SQL.strip()
        term = search.strip() if search and search.strip() else ""
        search_clause = ""
        params: List[Any] = [tenant_id]
        if term:
            search_clause = " AND (p.slug ILIKE %s OR p.name ILIKE %s)"
            pat = f"%{term}%"
            params.extend([pat, pat])
        domain_clause = ""
        domain_term = domain.strip() if domain and domain.strip() else ""
        if domain_term:
            domain_clause = f" AND ({dom_sql}) = LOWER(TRIM(%s))"
            params.append(domain_term)
        published_clause = ""
        if require_published:
            published_clause = " AND COALESCE(va.published_versions, 0) >= 1"

        query = f"""
            WITH project_base AS (
                SELECT
                    p.id AS project_id,
                    p.slug,
                    p.name,
                    p.metadata
                FROM apiome.projects p
                WHERE p.tenant_id = %s
                  AND p.deleted_at IS NULL
                  {search_clause}
                  {domain_clause}
            ),
            version_agg AS (
                SELECT
                    v.project_id,
                    COUNT(*)::int AS published_versions,
                    MAX(COALESCE(v.published_at, v.updated_at, v.created_at)) AS latest_activity_ts
                FROM apiome.versions v
                INNER JOIN project_base pb ON pb.project_id = v.project_id
                WHERE v.deleted_at IS NULL
                  AND v.published IS TRUE
                GROUP BY v.project_id
            ),
            latest_ver AS (
                SELECT DISTINCT ON (v.project_id)
                    v.project_id,
                    v.version_id AS latest_version,
                    COALESCE(v.published_at, v.updated_at, v.created_at) AS latest_published_at
                FROM apiome.versions v
                INNER JOIN project_base pb ON pb.project_id = v.project_id
                WHERE v.deleted_at IS NULL
                  AND v.published IS TRUE
                ORDER BY
                    v.project_id,
                    COALESCE(v.published_at, v.updated_at, v.created_at) DESC NULLS LAST,
                    v.version_id DESC
            )
            SELECT
                pb.slug,
                pb.name,
                pb.metadata,
                COALESCE(va.published_versions, 0) AS published_versions,
                lv.latest_version,
                lv.latest_published_at
            FROM project_base pb
            LEFT JOIN version_agg va ON va.project_id = pb.project_id
            LEFT JOIN latest_ver lv ON lv.project_id = pb.project_id
            WHERE 1 = 1
              {published_clause}
            ORDER BY pb.slug ASC
        """
        return self.execute_query(query, tuple(params))

    def project_has_public_published_version(self, tenant_id: str, project_slug: str) -> bool:
        """True when the project has at least one published version visible on the public browse surface."""
        q = """
            SELECT 1
            FROM apiome.projects p
            INNER JOIN apiome.versions v ON v.project_id = p.id
            WHERE p.tenant_id = %s
              AND p.slug = %s
              AND p.deleted_at IS NULL
              AND v.deleted_at IS NULL
              AND v.published IS TRUE
              AND v.visibility = 'public'
            LIMIT 1
        """
        rows = self.execute_query(q, (tenant_id, project_slug))
        return bool(rows)

    def list_public_browse_versions_for_project(
        self,
        tenant_id: str,
        project_slug: str,
        *,
        since: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """
        Published **public** versions for anonymous browse (parity with apiome-browse).

        ``since`` filters on ``published_at`` (inclusive); rows with null ``published_at`` are excluded when
        ``since`` is set.
        """
        params: List[Any] = [tenant_id, project_slug]
        since_clause = ""
        if since is not None:
            since_clause = " AND v.published_at IS NOT NULL AND v.published_at >= %s"
            params.append(since)

        query = f"""
            SELECT
                v.id::text AS id,
                v.version_id AS version_id,
                v.published_at,
                v.description,
                v.change_log,
                cr.change_model_json,
                COALESCE(
                    (
                        SELECT array_agg(t.name ORDER BY t.name)
                        FROM apiome.version_tags t
                        WHERE t.project_id = p.id
                          AND t.version_id = v.id
                    ),
                    ARRAY[]::text[]
                ) AS tags
            FROM apiome.versions v
            INNER JOIN apiome.projects p ON v.project_id = p.id
            LEFT JOIN apiome.change_reports cr
              ON cr.published_revision_id = v.id
             AND cr.tenant_id = p.tenant_id
             AND cr.project_id = p.id
            WHERE p.tenant_id = %s
              AND p.slug = %s
              AND p.deleted_at IS NULL
              AND v.deleted_at IS NULL
              AND v.published IS TRUE
              AND v.visibility = 'public'
              {since_clause}
        """
        return self.execute_query(query, tuple(params))

    def list_member_browse_versions_for_project(
        self,
        tenant_id: str,
        project_slug: str,
        *,
        since: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """Published versions for any visibility (tenant member directory)."""
        params: List[Any] = [tenant_id, project_slug]
        since_clause = ""
        if since is not None:
            since_clause = " AND v.published_at IS NOT NULL AND v.published_at >= %s"
            params.append(since)

        query = f"""
            SELECT
                v.id::text AS id,
                v.version_id AS version_id,
                v.published_at,
                v.description,
                v.change_log,
                cr.change_model_json,
                COALESCE(
                    (
                        SELECT array_agg(t.name ORDER BY t.name)
                        FROM apiome.version_tags t
                        WHERE t.project_id = p.id
                          AND t.version_id = v.id
                    ),
                    ARRAY[]::text[]
                ) AS tags
            FROM apiome.versions v
            INNER JOIN apiome.projects p ON v.project_id = p.id
            LEFT JOIN apiome.change_reports cr
              ON cr.published_revision_id = v.id
             AND cr.tenant_id = p.tenant_id
             AND cr.project_id = p.id
            WHERE p.tenant_id = %s
              AND p.slug = %s
              AND p.deleted_at IS NULL
              AND v.deleted_at IS NULL
              AND v.published IS TRUE
              {since_clause}
        """
        return self.execute_query(query, tuple(params))

    # ------------------------------------------------------------------
    # Mock Server instances (#3615, RC1-2.2)
    # ------------------------------------------------------------------

    # Columns returned for every mock-instance read, kept in one place so the management and data
    # planes always see the same shape.
    _MOCK_INSTANCE_COLUMNS = (
        "id, tenant_id, version_id, tenant_slug, project_slug, version_slug, name, "
        "spec, config, rate_limit_per_minute, status, created_by, request_count, "
        "created_at, expires_at, last_activity_at"
    )

    def create_mock_instance(
        self,
        tenant_id: str,
        version_id: Optional[str],
        tenant_slug: str,
        project_slug: str,
        version_slug: str,
        name: str,
        spec: Dict[str, Any],
        config: Dict[str, Any],
        rate_limit_per_minute: int,
        created_by: Optional[str],
        expires_at: Optional[datetime],
    ) -> Dict[str, Any]:
        """Provision a mock instance from a published version's frozen spec.

        Args:
            tenant_id: Owning tenant (for management/listing scope).
            version_id: ``apiome.versions.id`` the mock was generated from (nullable).
            tenant_slug/project_slug/version_slug: Human coordinates for display.
            name: Display name.
            spec: Frozen OpenAPI document the data plane replays from.
            config: Scenario / generation configuration (stored as JSONB).
            rate_limit_per_minute: Per-instance free-tier request budget.
            created_by: User id for attribution (nullable).
            expires_at: Auto-expiry timestamp, or ``None`` for no expiry.

        Returns:
            The newly created mock-instance row.
        """
        query = f"""
            INSERT INTO apiome.mock_instances
                (tenant_id, version_id, tenant_slug, project_slug, version_slug, name,
                 spec, config, rate_limit_per_minute, created_by, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {self._MOCK_INSTANCE_COLUMNS}
        """
        rows = self.execute_query(
            query,
            (
                tenant_id,
                version_id,
                tenant_slug,
                project_slug,
                version_slug,
                name,
                Json(spec),
                Json(config),
                rate_limit_per_minute,
                created_by,
                expires_at,
            ),
        )
        return rows[0]

    def list_mock_instances(self, tenant_id: str) -> List[Dict[str, Any]]:
        """List a tenant's mock instances, newest first."""
        query = f"""
            SELECT {self._MOCK_INSTANCE_COLUMNS}
            FROM apiome.mock_instances
            WHERE tenant_id = %s
            ORDER BY created_at DESC
        """
        return self.execute_query(query, (tenant_id,))

    def get_mock_instance_for_tenant(
        self, mock_id: str, tenant_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetch a single mock instance scoped to its owning tenant (management plane)."""
        query = f"""
            SELECT {self._MOCK_INSTANCE_COLUMNS}
            FROM apiome.mock_instances
            WHERE id = %s AND tenant_id = %s
        """
        rows = self.execute_query(query, (mock_id, tenant_id))
        return rows[0] if rows else None

    def get_mock_instance(self, mock_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a mock instance by id without a tenant filter (public data plane)."""
        query = f"""
            SELECT {self._MOCK_INSTANCE_COLUMNS}
            FROM apiome.mock_instances
            WHERE id = %s
        """
        rows = self.execute_query(query, (mock_id,))
        return rows[0] if rows else None

    def update_mock_instance_config(
        self, mock_id: str, tenant_id: str, config: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Replace a mock instance's config JSONB (e.g. switch the active scenario)."""
        query = f"""
            UPDATE apiome.mock_instances
            SET config = %s
            WHERE id = %s AND tenant_id = %s
            RETURNING {self._MOCK_INSTANCE_COLUMNS}
        """
        rows = self.execute_query(query, (Json(config), mock_id, tenant_id))
        return rows[0] if rows else None

    def delete_mock_instance(self, mock_id: str, tenant_id: str) -> bool:
        """Destroy a mock instance; returns ``True`` if a row was removed."""
        query = """
            DELETE FROM apiome.mock_instances
            WHERE id = %s AND tenant_id = %s
            RETURNING id
        """
        rows = self.execute_query(query, (mock_id, tenant_id))
        return bool(rows)

    def touch_mock_instance(self, mock_id: str) -> None:
        """Best-effort: bump request_count and last_activity_at for a served data-plane request.

        Failures are swallowed — usage accounting must never break the mock response itself.
        """
        query = """
            UPDATE apiome.mock_instances
            SET request_count = request_count + 1,
                last_activity_at = CURRENT_TIMESTAMP
            WHERE id = %s
            RETURNING id
        """
        try:
            self.execute_query(query, (mock_id,))
        except Exception as exc:  # pragma: no cover - accounting must never raise
            _logger.warning("Failed to update mock instance activity for %s: %s", mock_id, exc)

    def get_mock_license_limits_for_tenant(self, tenant_id: str) -> Dict[str, Any]:
        """Return mock RPS/monthly quota from the tenant admin's license seats (#4420)."""
        query = """
            SELECT COALESCE(
              (
                SELECT l.seats
                FROM apiome.tenant_administrators ta
                INNER JOIN apiome.user_entitlements ue ON ue.user_id = ta.user_id
                INNER JOIN apiome.licenses l ON l.id = ue.license_id AND l.enabled IS TRUE
                WHERE ta.tenant_id = %s::uuid
                ORDER BY
                  CASE l.license_type
                    WHEN 'sponsor' THEN 3
                    WHEN 'paid' THEN 2
                    WHEN 'free' THEN 1
                    ELSE 0
                  END DESC,
                  l.created_at ASC
                LIMIT 1
              ),
              (
                SELECT l.seats
                FROM apiome.licenses l
                WHERE l.license_type = 'free' AND l.enabled IS TRUE
                ORDER BY l.created_at ASC
                LIMIT 1
              ),
              '{}'::jsonb
            ) AS seats
        """
        rows = self.execute_query(query, (tenant_id,))
        seats = rows[0]["seats"] if rows else {}
        if not isinstance(seats, dict):
            seats = {}
        mock_rps = seats.get("mock_rps", 5)
        mock_requests_per_month = seats.get("mock_requests_per_month", 10_000)
        try:
            mock_rps = float(mock_rps)
        except (TypeError, ValueError):
            mock_rps = 5.0
        try:
            mock_requests_per_month = int(mock_requests_per_month)
        except (TypeError, ValueError):
            mock_requests_per_month = 10_000
        return {
            "mock_rps": max(0.0, mock_rps),
            "mock_requests_per_month": max(0, mock_requests_per_month),
        }

    def get_mock_monthly_usage(self, tenant_id: str) -> int:
        """Sum mock_usage rows for the current UTC calendar month (#4420)."""
        query = """
            SELECT COALESCE(SUM(request_count), 0)::bigint AS monthly_count
            FROM apiome.mock_usage
            WHERE tenant_id = %s::uuid
              AND usage_date >= date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))::date
              AND usage_date < (
                date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) + interval '1 month'
              )::date
        """
        rows = self.execute_query(query, (tenant_id,))
        return int(rows[0]["monthly_count"]) if rows else 0

    def list_mock_usage_rollups(
        self,
        tenant_id: str,
        *,
        days: int = 30,
        project_slug: Optional[str] = None,
        version_label: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Daily mock usage rollups for a tenant, newest first (#4420)."""
        days = max(1, min(int(days), 366))
        clauses = [
            "tenant_id = %s::uuid",
            "usage_date >= ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - %s)",
        ]
        params: List[Any] = [tenant_id, days - 1]
        if project_slug:
            clauses.append("project_slug = %s")
            params.append(project_slug)
        if version_label:
            clauses.append("version_label = %s")
            params.append(version_label)
        query = f"""
            SELECT usage_date, project_slug, version_label, request_count
            FROM apiome.mock_usage
            WHERE {' AND '.join(clauses)}
            ORDER BY usage_date DESC, project_slug ASC, version_label ASC
        """
        return self.execute_query(query, tuple(params))

    def list_export_field_identities(
        self, tenant_id: str, project_id: str, target: str
    ) -> list[Dict[str, Any]]:
        """Return persisted field-identity rows for one artifact export target (MFX-12.2)."""
        query = """
            SELECT field_key, field_number
            FROM apiome.export_field_identities
            WHERE tenant_id = %s::uuid
              AND project_id = %s::uuid
              AND target = %s
            ORDER BY field_key
        """
        return self.execute_query(query, (tenant_id, project_id, target))

    def upsert_export_field_identity(
        self,
        tenant_id: str,
        project_id: str,
        target: str,
        field_key: str,
        field_number: int,
    ) -> Dict[str, Any]:
        """Insert or refresh one persisted export field identity (MFX-12.2)."""
        query = """
            INSERT INTO apiome.export_field_identities (
                tenant_id, project_id, target, field_key, field_number
            )
            VALUES (%s::uuid, %s::uuid, %s, %s, %s)
            ON CONFLICT ON CONSTRAINT uq_export_field_identities_scope
            DO UPDATE SET
                field_number = EXCLUDED.field_number,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, tenant_id, project_id, target, field_key, field_number,
                      created_at, updated_at
        """
        rows = self.execute_query(
            query,
            (tenant_id, project_id, target, field_key, field_number),
        )
        return rows[0]

    # ───────────────────────── async job store (shared status) ─────────────────────────
    # Round-robin deployments run several REST instances; a job is driven by whichever
    # instance received the POST, but status polls are load-balanced across all of them.
    # These methods back the shared read model (see migration V158, apiome.async_job) so any
    # instance can answer GET/list without the in-memory 404. `job_id` is text (not uuid), so
    # a malformed id from a URL returns None here (→ 404) instead of raising a cast error.

    def upsert_async_job(
        self,
        *,
        job_id: str,
        kind: str,
        tenant_slug: str,
        state: str,
        status: Dict[str, Any],
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Mirror an async job's current poll payload into the shared store.

        The driving instance upserts on every state change. ``cancel_requested`` is
        deliberately not written here — it is owned by :meth:`request_async_job_cancel`
        and read back by the driver. ``extra`` is a per-kind bag (import commit/rollback payloads
        and owner-resource constraints, export list metadata) preserved with COALESCE so a later
        status update never nulls a value already recorded (e.g. the import commit payload written
        at completion).
        """
        query = """
            INSERT INTO apiome.async_job
                (job_id, kind, tenant_slug, state, status, extra, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (job_id) DO UPDATE SET
                state = EXCLUDED.state,
                status = EXCLUDED.status,
                extra = COALESCE(EXCLUDED.extra, apiome.async_job.extra),
                updated_at = now()
            RETURNING job_id
        """
        self.execute_query(
            query,
            (
                job_id,
                kind,
                tenant_slug,
                state,
                Json(status),
                Json(extra) if extra is not None else None,
            ),
        )

    def get_async_job(
        self, job_id: str, tenant_slug: str, kind: str
    ) -> Optional[Dict[str, Any]]:
        """Return the shared-store row for a job scoped to (tenant, kind), or None."""
        query = """
            SELECT job_id, kind, tenant_slug, state, status, extra, cancel_requested
            FROM apiome.async_job
            WHERE job_id = %s AND tenant_slug = %s AND kind = %s
        """
        rows = self.execute_query(query, (job_id, tenant_slug, kind))
        return rows[0] if rows else None

    def list_async_jobs(self, tenant_slug: str, kind: str) -> List[Dict[str, Any]]:
        """List shared-store rows for a tenant's jobs of one kind, oldest first."""
        query = """
            SELECT job_id, state, status, extra
            FROM apiome.async_job
            WHERE tenant_slug = %s AND kind = %s
            ORDER BY created_at ASC
        """
        return self.execute_query(query, (tenant_slug, kind))

    def request_async_job_cancel(self, job_id: str, tenant_slug: str, kind: str) -> bool:
        """Set the cross-instance cancel flag; return False when no such job exists."""
        query = """
            UPDATE apiome.async_job
            SET cancel_requested = TRUE, updated_at = now()
            WHERE job_id = %s AND tenant_slug = %s AND kind = %s
            RETURNING job_id
        """
        return bool(self.execute_query(query, (job_id, tenant_slug, kind)))

    def async_job_cancel_requested(self, job_id: str) -> bool:
        """Return whether cancellation has been requested (read by the driving instance)."""
        query = "SELECT cancel_requested FROM apiome.async_job WHERE job_id = %s"
        rows = self.execute_query(query, (job_id,))
        return bool(rows and rows[0].get("cancel_requested"))

    # ───────────────────── export job artifact store (IXH-6.1, #5120) ─────────────────────
    # Delivery bytes for completed exports, shared across instances. Status lives in
    # async_job (V158); this table holds the download payload so a non-owning instance can
    # serve GET …/download instead of 404-ing on a missing in-memory EmitResult.

    def upsert_export_job_artifact(
        self,
        *,
        job_id: str,
        tenant_slug: str,
        content_sha256: str,
        size_bytes: int,
        media_type: str,
        filename: str,
        backend: str,
        content: Optional[bytes],
        storage_uri: Optional[str],
        expires_at: Optional[Any],
    ) -> None:
        """Insert or replace the shared download payload for an export job."""
        query = """
            INSERT INTO apiome.export_job_artifact
                (job_id, tenant_slug, content_sha256, size_bytes, media_type, filename,
                 backend, content, storage_uri, expires_at, reaped_at, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, now())
            ON CONFLICT (job_id) DO UPDATE SET
                tenant_slug = EXCLUDED.tenant_slug,
                content_sha256 = EXCLUDED.content_sha256,
                size_bytes = EXCLUDED.size_bytes,
                media_type = EXCLUDED.media_type,
                filename = EXCLUDED.filename,
                backend = EXCLUDED.backend,
                content = EXCLUDED.content,
                storage_uri = EXCLUDED.storage_uri,
                expires_at = EXCLUDED.expires_at,
                reaped_at = NULL
            RETURNING job_id
        """
        self.execute_query(
            query,
            (
                job_id,
                tenant_slug,
                content_sha256,
                size_bytes,
                media_type,
                filename,
                backend,
                psycopg2.Binary(content) if content is not None else None,
                storage_uri,
                expires_at,
            ),
        )

    def get_export_job_artifact(
        self, job_id: str, tenant_slug: str
    ) -> Optional[Dict[str, Any]]:
        """Return the shared artifact row scoped to tenant, or None (cross-tenant → None)."""
        query = """
            SELECT job_id, tenant_slug, content_sha256, size_bytes, media_type, filename,
                   backend, content, storage_uri, expires_at, reaped_at, created_at
            FROM apiome.export_job_artifact
            WHERE job_id = %s AND tenant_slug = %s
        """
        rows = self.execute_query(query, (job_id, tenant_slug))
        return rows[0] if rows else None

    def delete_export_job_artifact(self, job_id: str, tenant_slug: str) -> bool:
        """Delete a tenant-scoped artifact row; return True when a row was removed."""
        query = """
            DELETE FROM apiome.export_job_artifact
            WHERE job_id = %s AND tenant_slug = %s
            RETURNING job_id
        """
        return bool(self.execute_query(query, (job_id, tenant_slug)))

    def reap_expired_export_job_artifacts(
        self, *, now: Optional[Any] = None, limit: int = 100
    ) -> int:
        """Clear content for expired unreaped artifacts (IXH-6.3 sweep helper).

        Sets ``reaped_at`` and nulls ``content`` / ``storage_uri`` so downloads become 410
        without waiting for the job row to be deleted. Returns the number of rows reaped.
        """
        query = """
            UPDATE apiome.export_job_artifact
               SET reaped_at = COALESCE(%s, now()),
                   content = NULL,
                   storage_uri = NULL
             WHERE reaped_at IS NULL
               AND expires_at IS NOT NULL
               AND expires_at <= COALESCE(%s, now())
               AND job_id IN (
                   SELECT job_id FROM apiome.export_job_artifact
                    WHERE reaped_at IS NULL
                      AND expires_at IS NOT NULL
                      AND expires_at <= COALESCE(%s, now())
                    ORDER BY expires_at ASC
                    LIMIT %s
                    FOR UPDATE SKIP LOCKED
               )
            RETURNING job_id
        """
        ts = now
        rows = self.execute_query(query, (ts, ts, ts, limit))
        return len(rows)

    # ------------------------------------------------------------------
    # Round-trip preservation envelope (DCW-2.1, private-suite#2352, V184)
    # ------------------------------------------------------------------

    def _preservation_version_row(
        self, cursor, tenant_id: str, project_id: str, version_record_id: str
    ) -> Optional[Dict[str, Any]]:
        """Tenant/project-scoped version row (id, published) locked FOR UPDATE, or None."""
        if not version_record_id or not is_uuid_string(str(version_record_id)):
            return None
        cursor.execute(
            """
            SELECT v.id, v.published, v.published_immutable
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.id = %s::uuid AND v.project_id = %s AND p.tenant_id = %s
              AND v.deleted_at IS NULL AND p.deleted_at IS NULL
            FOR UPDATE OF v
            """,
            (version_record_id, project_id, tenant_id),
        )
        return cursor.fetchone()

    def get_preservation_claims(
        self, tenant_id: str, project_id: str, version_record_id: str
    ) -> List[Dict[str, Any]]:
        """Live preservation claims for a revision, deterministically ordered.

        Returns:
            One dict per live claim (pointer, payload, source_file, source_digest,
            created_at, updated_at), ordered by pointer.

        Raises:
            ValueError: ``version_not_found`` when the revision does not exist in
                this tenant/project scope (preferred over leaking existence).
        """
        if not version_record_id or not is_uuid_string(str(version_record_id)):
            raise ValueError("version_not_found")
        version_rows = self.execute_query(
            """
            SELECT v.id
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.id = %s::uuid AND v.project_id = %s AND p.tenant_id = %s
              AND v.deleted_at IS NULL AND p.deleted_at IS NULL
            """,
            (version_record_id, project_id, tenant_id),
        )
        if not version_rows:
            raise ValueError("version_not_found")
        return self.execute_query(
            """
            SELECT pointer, payload, source_file, source_digest, created_at, updated_at
            FROM apiome.version_preservation_claims
            WHERE tenant_id = %s AND version_id = %s::uuid AND deleted_at IS NULL
            ORDER BY pointer ASC
            """,
            (tenant_id, version_record_id),
        )

    def replace_preservation_claims(
        self,
        tenant_id: str,
        project_id: str,
        version_record_id: str,
        claims: List[Dict[str, Any]],
        actor_id: Optional[str],
        detail: Optional[Dict[str, Any]] = None,
    ) -> int:
        """Replace a draft revision's preservation envelope in one transaction.

        The previous live claims are soft-deleted (retention: purged later by
        ``apiome.purge_preservation_claims``), the new claims inserted, and the
        audit row written — all in a single transaction, so the envelope and its
        audit commit or roll back together (the DCW-0.2
        ``failure-injection-no-partial-mutation`` transaction rule).

        Args:
            tenant_id: The caller's tenant (scopes every statement).
            project_id: The project the revision belongs to.
            version_record_id: The revision's record UUID.
            claims: Dicts with ``pointer``, ``value``, optional ``source_file`` /
                ``source_digest``. An empty list clears the envelope.
            actor_id: The acting user's id, when attributable.
            detail: Extra structured audit context (envelope version, dialect).

        Returns:
            The number of live claims after the replace.

        Raises:
            ValueError: ``version_not_found`` (tenant/project scope miss) or
                ``published_version`` (published revisions are immutable).
        """
        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                vrow = self._preservation_version_row(
                    cursor, tenant_id, project_id, version_record_id
                )
                if not vrow:
                    conn.rollback()
                    raise ValueError("version_not_found")
                if vrow.get("published"):
                    conn.rollback()
                    raise ValueError("published_version")

                vid = str(vrow["id"])
                cursor.execute(
                    """
                    UPDATE apiome.version_preservation_claims
                    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE tenant_id = %s AND version_id = %s::uuid AND deleted_at IS NULL
                    """,
                    (tenant_id, vid),
                )
                for claim in claims:
                    cursor.execute(
                        """
                        INSERT INTO apiome.version_preservation_claims
                          (tenant_id, version_id, pointer, payload,
                           source_file, source_digest, created_by)
                        VALUES (%s, %s::uuid, %s, %s, %s, %s, %s)
                        """,
                        (
                            tenant_id,
                            vid,
                            claim["pointer"],
                            Json(claim.get("value")),
                            claim.get("source_file"),
                            claim.get("source_digest"),
                            actor_id,
                        ),
                    )
                action = "envelope.replace" if claims else "envelope.clear"
                audit_detail = {"claimCount": len(claims)}
                if detail:
                    audit_detail.update(detail)
                cursor.execute(
                    """
                    INSERT INTO apiome.preservation_audit
                      (tenant_id, version_id, actor_id, action, outcome, detail)
                    VALUES (%s, %s::uuid, %s, %s, 'success', %s)
                    """,
                    (tenant_id, vid, actor_id, action, Json(audit_detail)),
                )
                conn.commit()
                return len(claims)
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            try:
                conn.autocommit = prev_autocommit
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Source-to-model change review apply — DCW-2.3 (private-suite#2360)
    # ------------------------------------------------------------------

    def _source_apply_version_row(
        self, cursor, tenant_id: str, project_id: str, version_record_id: str
    ) -> Optional[Dict[str, Any]]:
        """Tenant/project-scoped version + project row locked FOR UPDATE, or None.

        The row lock plus the in-transaction rechecks below implement the
        DCW-0.2 rule that authorization and draft mutability are verified
        inside the apply transaction, not only at the UI boundary.
        """
        if not version_record_id or not is_uuid_string(str(version_record_id)):
            return None
        cursor.execute(
            """
            SELECT v.id, v.published, v.published_immutable, v.version_id, v.metadata,
                   p.id AS project_id, p.name AS project_name, p.slug AS project_slug,
                   p.description AS project_description, p.metadata AS project_metadata
            FROM apiome.versions v
            JOIN apiome.projects p ON v.project_id = p.id
            WHERE v.id = %s::uuid AND v.project_id = %s AND p.tenant_id = %s
              AND v.deleted_at IS NULL AND p.deleted_at IS NULL
            FOR UPDATE OF v
            """,
            (version_record_id, project_id, tenant_id),
        )
        return cursor.fetchone()

    def _cursor_actor_can_edit_versions(self, cursor, tenant_id: str, user_id: Optional[str]) -> bool:
        """In-transaction replica of the ``versions:edit`` permission predicate.

        Mirrors ``user_has_permission`` (tenant admins pass; else the assigned
        role — or the built-in Editor default for a member with no explicit
        role — must grant versions:edit) but runs on the transaction cursor,
        because the shared helpers commit and would break the open transaction.
        """
        if not user_id or not is_uuid_string(str(user_id)):
            return False
        cursor.execute(
            """
            SELECT 1 FROM apiome.tenant_administrators
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid LIMIT 1
            """,
            (tenant_id, user_id),
        )
        if cursor.fetchone():
            return True
        cursor.execute(
            """
            SELECT 1
            FROM apiome.tenant_user_roles tur
            JOIN apiome.role_permissions rp ON rp.role_id = tur.role_id
            WHERE tur.tenant_id = %s::uuid AND tur.user_id = %s::uuid
              AND rp.resource = 'versions' AND rp.action = 'edit'
            LIMIT 1
            """,
            (tenant_id, user_id),
        )
        if cursor.fetchone():
            return True
        cursor.execute(
            """
            SELECT 1 FROM apiome.tenant_user_roles
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid LIMIT 1
            """,
            (tenant_id, user_id),
        )
        if cursor.fetchone():
            # Explicit roles assigned, none of them grants versions:edit.
            return False
        cursor.execute(
            """
            SELECT 1 FROM apiome.tenant_users
            WHERE tenant_id = %s::uuid AND user_id = %s::uuid AND status <> 'suspended'
            LIMIT 1
            """,
            (tenant_id, user_id),
        )
        if not cursor.fetchone():
            return False
        cursor.execute(
            """
            SELECT 1
            FROM apiome.roles r
            JOIN apiome.role_permissions rp ON rp.role_id = r.id
            WHERE r.tenant_id = %s::uuid AND r.slug = 'editor'
              AND rp.resource = 'versions' AND rp.action = 'edit'
            LIMIT 1
            """,
            (tenant_id,),
        )
        return bool(cursor.fetchone())

    def _cursor_draft_lock_owner(self, cursor, version_id: str) -> Optional[str]:
        """The user holding an unexpired draft lock on the revision, if any."""
        cursor.execute(
            """
            SELECT owner_user_id FROM apiome.version_draft_lock
            WHERE version_id = %s::uuid AND expires_at > CURRENT_TIMESTAMP
            """,
            (version_id,),
        )
        row = cursor.fetchone()
        owner = row.get("owner_user_id") if row else None
        return str(owner) if owner else None

    def _cursor_paths_data(self, cursor, version_id: str) -> List[Dict[str, Any]]:
        """In-transaction replica of ``openapi_generator._load_paths_for_version``."""
        cursor.execute(
            """
            SELECT id, pathname,
                   metadata->>'summary' as summary,
                   metadata->>'description' as description
            FROM apiome.version_path
            WHERE version_id = %s
            ORDER BY pathname
            """,
            (version_id,),
        )
        path_rows = cursor.fetchall()
        paths: List[Dict[str, Any]] = []
        for path_row in path_rows:
            cursor.execute(
                """
                SELECT id, version_path_id, operation, metadata, created_at, updated_at
                FROM apiome.path_operation
                WHERE version_path_id = %s
                ORDER BY CASE operation
                    WHEN 'GET' THEN 1 WHEN 'POST' THEN 2 WHEN 'PUT' THEN 3
                    WHEN 'PATCH' THEN 4 WHEN 'DELETE' THEN 5 ELSE 6
                END
                """,
                (path_row["id"],),
            )
            op_rows = cursor.fetchall()
            operations: List[Dict[str, Any]] = []
            for op_row in op_rows:
                cursor.execute(
                    """
                    SELECT id, summary, description, operation_id,
                           metadata->'tags' as tags,
                           (metadata->>'deprecated')::boolean as deprecated,
                           (metadata->>'x-private')::boolean as x_private,
                           metadata->'external_docs' as external_docs,
                           metadata
                    FROM apiome.path_operation_description
                    WHERE path_operation_id = %s
                    LIMIT 1
                    """,
                    (op_row["id"],),
                )
                desc_rows = cursor.fetchall()
                cursor.execute(
                    """
                    SELECT spp.id, spp.name, spp.in_location, spp.summary, spp.description, spp.data
                    FROM apiome.shared_path_parameter spp
                    INNER JOIN apiome.path_operation_parameter_link popl
                        ON spp.id = popl.shared_path_parameter_id
                    WHERE popl.path_operation_id = %s
                    ORDER BY CASE spp.in_location
                        WHEN 'path' THEN 1 WHEN 'query' THEN 2 WHEN 'header' THEN 3 ELSE 4
                    END, spp.name
                    """,
                    (op_row["id"],),
                )
                parameters = cursor.fetchall()
                cursor.execute(
                    """
                    SELECT rb.id, rb.name, rb.description, rb.required,
                        COALESCE(json_agg(json_build_object(
                            'id', rbc.id, 'media_type', rbc.media_type, 'class_id', rbc.class_id,
                            'class_name', c.name, 'inline_schema', rbc.inline_schema,
                            'encoding', rbc.encoding, 'examples', rbc.examples
                        )) FILTER (WHERE rbc.id IS NOT NULL), '[]') as content_types
                    FROM apiome.shared_path_request_body rb
                    INNER JOIN apiome.path_operation_request_body_link link
                        ON rb.id = link.shared_path_request_body_id
                    LEFT JOIN apiome.shared_path_request_body_content rbc
                        ON rb.id = rbc.shared_path_request_body_id
                    LEFT JOIN apiome.classes c ON rbc.class_id = c.id
                    WHERE link.path_operation_id = %s
                    GROUP BY rb.id
                    """,
                    (op_row["id"],),
                )
                request_bodies = cursor.fetchall()
                cursor.execute(
                    """
                    SELECT spr.id, spr.status_code, spr.description, spr.data,
                           spr.class_id, c.name as class_name, spr.inline_schema,
                           COALESCE(json_agg(json_build_object(
                               'id', rc.id, 'media_type', rc.media_type, 'class_id', rc.class_id,
                               'class_name', rc_class.name, 'inline_schema', rc.inline_schema,
                               'examples', rc.examples
                           )) FILTER (WHERE rc.id IS NOT NULL), '[]') as content_types
                    FROM apiome.shared_path_response spr
                    INNER JOIN apiome.path_operation_response_link porl
                        ON spr.id = porl.shared_path_response_id
                    LEFT JOIN apiome.classes c ON spr.class_id = c.id
                    LEFT JOIN apiome.shared_path_response_content rc
                        ON spr.id = rc.shared_path_response_id
                    LEFT JOIN apiome.classes rc_class ON rc.class_id = rc_class.id
                    WHERE porl.path_operation_id = %s
                    GROUP BY spr.id, spr.status_code, spr.description, spr.data,
                             spr.class_id, c.name, spr.inline_schema
                    ORDER BY spr.status_code
                    """,
                    (op_row["id"],),
                )
                responses = cursor.fetchall()
                operations.append(
                    {
                        "id": op_row["id"],
                        "operation": op_row["operation"],
                        "description": desc_rows[0] if desc_rows else None,
                        "parameters": parameters,
                        "requestBody": request_bodies[0] if request_bodies else None,
                        "responses": responses,
                    }
                )
            paths.append(
                {
                    "id": path_row["id"],
                    "pathname": path_row["pathname"],
                    "summary": path_row.get("summary"),
                    "description": path_row.get("description"),
                    "operations": operations,
                }
            )
        return paths

    def _cursor_current_merged_document(
        self,
        cursor,
        tenant_id: str,
        tenant_slug: str,
        version_row: Dict[str, Any],
        dialect: str,
    ):
        """The revision's current canonical + envelope, loaded on the tx cursor.

        Returns:
            ``(merged_document, current_fingerprint, live_claim_rows)``.
        """
        from .openapi_generator import generate_openapi_spec
        from .preservation_envelope import (
            PreservationClaim,
            PreservationEnvelope,
            apply_envelope,
            semantic_fingerprint,
        )

        version_id = str(version_row["id"])
        cursor.execute(
            """
            SELECT id, version_id, name, description, schema, enabled
            FROM apiome.classes
            WHERE version_id = %s AND deleted_at IS NULL
            ORDER BY name ASC
            """,
            (version_id,),
        )
        classes = cursor.fetchall()
        all_properties: Dict[str, List[Dict[str, Any]]] = {}
        for class_row in classes:
            cursor.execute(
                """
                SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description,
                       cp.data, cp.parent_id, cp.primitive_id, cp.primitive_ref
                FROM apiome.class_properties cp
                WHERE cp.class_id = %s
                ORDER BY cp.parent_id NULLS FIRST, cp.name ASC
                """,
                (class_row["id"],),
            )
            all_properties[class_row["id"]] = cursor.fetchall()
        cursor.execute(
            """
            SELECT id, version_id, scheme_name, scheme_type, in_location,
                   param_name, http_scheme, description, data
            FROM apiome.version_security_scheme
            WHERE version_id = %s
            ORDER BY scheme_name
            """,
            (version_id,),
        )
        scheme_rows = cursor.fetchall()
        cursor.execute(
            """
            SELECT id, version_id, name, url, description, sort_order, variables, environment
            FROM apiome.version_server
            WHERE version_id = %s
            ORDER BY sort_order, url
            """,
            (version_id,),
        )
        server_rows = cursor.fetchall()
        paths_data = self._cursor_paths_data(cursor, version_id)
        canonical = generate_openapi_spec(
            tenant_slug,
            str(version_row.get("project_slug") or version_row["project_id"]),
            str(version_row["version_id"]),
            classes,
            all_properties,
            version_row.get("project_description"),
            revision_metadata=version_row.get("metadata"),
            project_metadata=version_row.get("project_metadata"),
            paths_data=paths_data,
            security_scheme_rows=scheme_rows,
            server_rows=server_rows,
        )
        cursor.execute(
            """
            SELECT pointer, payload, source_file, source_digest
            FROM apiome.version_preservation_claims
            WHERE tenant_id = %s AND version_id = %s::uuid AND deleted_at IS NULL
            ORDER BY pointer ASC
            """,
            (tenant_id, version_id),
        )
        claim_rows = cursor.fetchall()
        envelope = PreservationEnvelope(
            dialect=dialect,
            claims=[
                PreservationClaim(
                    pointer=row["pointer"],
                    value=row["payload"],
                    source_file=row.get("source_file"),
                    source_digest=row.get("source_digest"),
                )
                for row in claim_rows
            ],
        )
        merged, _merge_errors = apply_envelope(canonical, envelope)
        return merged, semantic_fingerprint(merged).fingerprint, claim_rows

    def _cursor_write_canonical_rows(
        self, cursor, project_id: str, version_id: str, writes
    ) -> None:
        """Rewrite the revision's canonical rows from a candidate write plan.

        Runs entirely on the transaction cursor: soft-deletes live classes,
        recreates classes/properties, and delete-and-recreates paths, security
        schemes, and servers. Committing or rolling back is the caller's job.
        """
        from .source_change_apply import parameter_key, path_shared_parameters

        def _stable_json(value: Any) -> str:
            return json.dumps(value, sort_keys=True, separators=(",", ":"))

        # Classes: soft-delete live rows (retention parity with delete_class),
        # then insert the candidate's schemas fresh.
        cursor.execute(
            """
            UPDATE apiome.classes
            SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE version_id = %s AND deleted_at IS NULL
            """,
            (version_id,),
        )
        cursor.execute(
            "SELECT id, data FROM apiome.properties WHERE project_id = %s",
            (project_id,),
        )
        library: Dict[str, str] = {}
        for row in cursor.fetchall():
            data = row.get("data")
            if isinstance(data, str):
                try:
                    data = json.loads(data)
                except json.JSONDecodeError:
                    continue
            library.setdefault(_stable_json(data), str(row["id"]))
        class_ids: Dict[str, str] = {}
        for class_write in writes.classes:
            cursor.execute(
                """
                INSERT INTO apiome.classes (version_id, name, description, schema, enabled)
                VALUES (%s, %s, %s, %s, TRUE)
                RETURNING id
                """,
                (
                    version_id,
                    class_write.name,
                    class_write.description,
                    json.dumps(class_write.schema_fields),
                ),
            )
            class_id = str(cursor.fetchone()["id"])
            class_ids[class_write.name] = class_id
            for prop in class_write.properties:
                property_id: Optional[str] = None
                if not prop.is_reference:
                    signature = _stable_json(prop.data)
                    property_id = library.get(signature)
                    if property_id is None:
                        cursor.execute(
                            """
                            INSERT INTO apiome.properties (project_id, name, description, data)
                            VALUES (%s, %s, %s, %s)
                            RETURNING id
                            """,
                            (project_id, prop.name, prop.description, json.dumps(prop.data)),
                        )
                        property_id = str(cursor.fetchone()["id"])
                        library[signature] = property_id
                cursor.execute(
                    """
                    INSERT INTO apiome.class_properties
                        (class_id, property_id, name, description, data)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (class_id, property_id, prop.name, prop.description, json.dumps(prop.data)),
                )

        # Paths: hard delete-and-recreate; children cascade from version_path.
        cursor.execute(
            "DELETE FROM apiome.version_path WHERE version_id = %s", (version_id,)
        )
        for path in writes.paths:
            path_metadata: Dict[str, Any] = {}
            if path.summary is not None:
                path_metadata["summary"] = path.summary
            if path.description is not None:
                path_metadata["description"] = path.description
            cursor.execute(
                """
                INSERT INTO apiome.version_path (version_id, pathname, metadata)
                VALUES (%s, %s, %s)
                RETURNING id
                """,
                (version_id, path.pathname, json.dumps(path_metadata) if path_metadata else None),
            )
            version_path_id = str(cursor.fetchone()["id"])
            shared_params = path_shared_parameters(path)
            parameter_ids: Dict[Any, str] = {}
            for key, parameter in shared_params.items():
                cursor.execute(
                    """
                    INSERT INTO apiome.shared_path_parameter
                        (version_path_id, name, in_location, summary, description, data)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        version_path_id,
                        parameter.name,
                        parameter.in_location,
                        parameter.summary,
                        parameter.description,
                        json.dumps(parameter.data),
                    ),
                )
                parameter_ids[key] = str(cursor.fetchone()["id"])
            response_ids: Dict[str, str] = {}
            for response in path.responses:
                if response.data:
                    data_value: Optional[str] = json.dumps(response.data)
                elif not response.contents:
                    data_value = json.dumps({})
                else:
                    data_value = None
                cursor.execute(
                    """
                    INSERT INTO apiome.shared_path_response
                        (version_path_id, status_code, description, data,
                         class_id, inline_schema, schema_mode)
                    VALUES (%s, %s, %s, %s, NULL, NULL, 'object')
                    RETURNING id
                    """,
                    (version_path_id, response.status_code, response.description, data_value),
                )
                response_id = str(cursor.fetchone()["id"])
                response_ids[response.status_code] = response_id
                for content in response.contents:
                    cursor.execute(
                        """
                        INSERT INTO apiome.shared_path_response_content
                            (shared_path_response_id, media_type, class_id, inline_schema, examples)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            response_id,
                            content.media_type,
                            class_ids.get(content.ref_class_name)
                            if content.ref_class_name
                            else None,
                            json.dumps(content.inline_schema)
                            if content.inline_schema is not None
                            else None,
                            json.dumps(content.examples)
                            if content.examples is not None
                            else None,
                        ),
                    )
            for op in path.operations:
                cursor.execute(
                    """
                    INSERT INTO apiome.path_operation (version_path_id, operation, metadata)
                    VALUES (%s, %s, '{}')
                    RETURNING id
                    """,
                    (version_path_id, op.method.upper()),
                )
                path_operation_id = str(cursor.fetchone()["id"])
                cursor.execute(
                    """
                    INSERT INTO apiome.path_operation_description
                        (path_operation_id, summary, description, operation_id, metadata)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        path_operation_id,
                        op.summary,
                        op.description,
                        op.operation_id,
                        json.dumps(op.description_metadata)
                        if op.description_metadata
                        else None,
                    ),
                )
                for parameter in op.parameters:
                    shared_id = parameter_ids.get(parameter_key(parameter))
                    if shared_id:
                        cursor.execute(
                            """
                            INSERT INTO apiome.path_operation_parameter_link
                                (path_operation_id, shared_path_parameter_id)
                            VALUES (%s, %s)
                            ON CONFLICT (path_operation_id, shared_path_parameter_id) DO NOTHING
                            """,
                            (path_operation_id, shared_id),
                        )
                if op.request_body is not None:
                    cursor.execute(
                        """
                        INSERT INTO apiome.shared_path_request_body
                            (version_path_id, name, description, required)
                        VALUES (%s, %s, %s, %s)
                        RETURNING id
                        """,
                        (
                            version_path_id,
                            op.request_body.name,
                            op.request_body.description,
                            op.request_body.required,
                        ),
                    )
                    request_body_id = str(cursor.fetchone()["id"])
                    for content in op.request_body.contents:
                        cursor.execute(
                            """
                            INSERT INTO apiome.shared_path_request_body_content
                                (shared_path_request_body_id, media_type, class_id,
                                 inline_schema, encoding, examples)
                            VALUES (%s, %s, %s, %s, %s, %s)
                            """,
                            (
                                request_body_id,
                                content.media_type,
                                class_ids.get(content.ref_class_name)
                                if content.ref_class_name
                                else None,
                                json.dumps(content.inline_schema)
                                if content.inline_schema is not None
                                else None,
                                json.dumps(content.encoding)
                                if content.encoding is not None
                                else None,
                                json.dumps(content.examples)
                                if content.examples is not None
                                else None,
                            ),
                        )
                    cursor.execute(
                        """
                        INSERT INTO apiome.path_operation_request_body_link
                            (path_operation_id, shared_path_request_body_id, metadata)
                        VALUES (%s, %s, NULL)
                        ON CONFLICT (path_operation_id) DO UPDATE SET
                            shared_path_request_body_id = EXCLUDED.shared_path_request_body_id
                        """,
                        (path_operation_id, request_body_id),
                    )
                for status in op.response_status_codes:
                    response_id = response_ids.get(status)
                    if response_id:
                        cursor.execute(
                            """
                            INSERT INTO apiome.path_operation_response_link
                                (path_operation_id, shared_path_response_id, metadata)
                            VALUES (%s, %s, NULL)
                            ON CONFLICT (path_operation_id, shared_path_response_id) DO NOTHING
                            """,
                            (path_operation_id, response_id),
                        )

        # Security schemes and servers: delete-and-recreate.
        cursor.execute(
            "DELETE FROM apiome.version_security_scheme WHERE version_id = %s",
            (version_id,),
        )
        for scheme in writes.security_schemes:
            cursor.execute(
                """
                INSERT INTO apiome.version_security_scheme
                    (version_id, scheme_name, scheme_type, in_location,
                     param_name, http_scheme, description, data)
                VALUES (%s, %s, %s, %s, %s, NULL, %s, '{}')
                """,
                (
                    version_id,
                    scheme.scheme_name,
                    scheme.scheme_type,
                    scheme.in_location,
                    scheme.param_name,
                    scheme.description,
                ),
            )
        cursor.execute(
            "DELETE FROM apiome.version_server WHERE version_id = %s", (version_id,)
        )
        for server in writes.servers:
            cursor.execute(
                """
                INSERT INTO apiome.version_server
                    (version_id, name, url, description, sort_order, variables)
                VALUES (%s, NULL, %s, %s, %s, %s)
                """,
                (
                    version_id,
                    server.url,
                    server.description,
                    server.sort_order,
                    json.dumps(server.variables) if server.variables is not None else None,
                ),
            )

    def apply_source_change_set(
        self,
        tenant_id: str,
        tenant_slug: str,
        project_id: str,
        version_record_id: str,
        *,
        actor_id: Optional[str],
        candidate_document: Dict[str, Any],
        source_format: str,
        source_digest: Optional[str],
        base_digest: str,
        change_set_digest_value: str,
        dialect: str,
    ) -> Dict[str, Any]:
        """Apply a reviewed candidate to a draft revision in one transaction.

        Everything the DCW-0.2 gates demand happens inside a single
        transaction on one locked version row: tenant/project scope (404
        semantics), published-immutability, draft-lock ownership, and the
        ``versions:edit`` permission are rechecked after the FOR UPDATE lock;
        the base digest is compared against the *current* merged document for
        optimistic concurrency; and the canonical rows, preservation payload,
        and audit entry commit or roll back together. A failed apply leaves
        the revision unchanged.

        Idempotent replay: when the most recent successful apply recorded the
        same change-set digest and the revision still fingerprints to its
        result, the recorded outcome is returned without mutating anything.

        Args:
            tenant_id: The caller's tenant (scopes every statement).
            tenant_slug: Tenant slug used in canonical-document generation.
            project_id: The project the revision belongs to.
            version_record_id: The revision's record UUID.
            actor_id: The acting user (JWT identity), rechecked in-tx.
            candidate_document: The parsed, validated candidate document.
            source_format: 'yaml' or 'json' (audit context only).
            source_digest: Algorithm-prefixed digest of the raw source text,
                recorded as claim provenance.
            base_digest: Semantic fingerprint of the merged document the
                candidate was reviewed against.
            change_set_digest_value: The digest the review endpoint issued for
                this (base, candidate) pair.
            dialect: The revision's stored OAS dialect.

        Returns:
            On mutation: ``{"applied": True, "resultDigest", "auditId",
            "counts", "enrichments", "claimCount"}``. On idempotent replay or
            an empty change set: ``{"applied": False, "alreadyApplied"/"noChanges",
            "resultDigest"}``.

        Raises:
            SourceApplyConflictError: With a structured code/payload; the
                transaction is always rolled back first.
        """
        from .source_change_apply import (
            build_canonical_writes,
            compare_candidate_to_merged,
            regenerate_document,
        )
        from .source_change_review import build_source_change_set, change_set_digest
        from .preservation_envelope import (
            apply_envelope,
            extract_envelope,
            semantic_fingerprint,
            validate_envelope,
        )

        conn = self.connect()
        prev_autocommit = self._begin_tx(conn)
        try:
            with conn.cursor() as cursor:
                vrow = self._source_apply_version_row(
                    cursor, tenant_id, project_id, version_record_id
                )
                if not vrow:
                    conn.rollback()
                    raise SourceApplyConflictError("version_not_found")
                if vrow.get("published"):
                    conn.rollback()
                    raise SourceApplyConflictError("published_version")
                lock_owner = self._cursor_draft_lock_owner(cursor, str(vrow["id"]))
                if lock_owner and (not actor_id or str(actor_id) != lock_owner):
                    conn.rollback()
                    raise SourceApplyConflictError(
                        "draft_lock_conflict", {"ownerUserId": lock_owner}
                    )
                if not self._cursor_actor_can_edit_versions(cursor, tenant_id, actor_id):
                    conn.rollback()
                    raise SourceApplyConflictError("permission_denied")

                merged_current, current_fp, _claims = self._cursor_current_merged_document(
                    cursor, tenant_id, tenant_slug, vrow, dialect
                )

                cursor.execute(
                    """
                    SELECT id, change_set_digest, result_digest
                    FROM apiome.source_change_audit
                    WHERE version_id = %s::uuid AND outcome = 'success'
                    ORDER BY created_at DESC, id DESC
                    LIMIT 1
                    """,
                    (str(vrow["id"]),),
                )
                last_apply = cursor.fetchone()
                if (
                    last_apply
                    and last_apply["change_set_digest"] == change_set_digest_value
                    and last_apply["result_digest"] == current_fp
                ):
                    conn.rollback()
                    return {
                        "applied": False,
                        "alreadyApplied": True,
                        "resultDigest": current_fp,
                        "auditId": str(last_apply["id"]),
                    }

                if current_fp != base_digest:
                    conn.rollback()
                    raise SourceApplyConflictError(
                        "stale_base", {"currentDigest": current_fp}
                    )

                candidate_fp = semantic_fingerprint(candidate_document).fingerprint
                if change_set_digest(base_digest, candidate_fp) != change_set_digest_value:
                    conn.rollback()
                    raise SourceApplyConflictError("change_set_mismatch")

                change_set = build_source_change_set(
                    merged_current, candidate_document, dialect
                )
                if change_set.blockers:
                    conn.rollback()
                    raise SourceApplyConflictError(
                        "blocked",
                        {
                            "blockers": [
                                b.model_dump(by_alias=True) for b in change_set.blockers
                            ]
                        },
                    )
                if change_set.counts.total == 0:
                    conn.rollback()
                    return {
                        "applied": False,
                        "noChanges": True,
                        "resultDigest": current_fp,
                    }

                writes = build_canonical_writes(candidate_document)
                regenerated = regenerate_document(
                    writes,
                    tenant_slug=tenant_slug,
                    project_slug=str(vrow.get("project_slug") or vrow["project_id"]),
                    version_string=str(vrow["version_id"]),
                    project_description=vrow.get("project_description"),
                    revision_metadata=vrow.get("metadata"),
                    project_metadata=vrow.get("project_metadata"),
                )
                envelope = extract_envelope(
                    candidate_document,
                    regenerated,
                    dialect,
                    source_digest=source_digest,
                )
                report = validate_envelope(envelope, regenerated)
                if not report.ok:
                    conn.rollback()
                    raise SourceApplyConflictError(
                        "apply_fidelity",
                        {"errors": [e.model_dump(by_alias=True) for e in report.errors]},
                    )
                merged_next, merge_errors = apply_envelope(regenerated, envelope)
                if merge_errors:
                    conn.rollback()
                    raise SourceApplyConflictError(
                        "apply_fidelity",
                        {"errors": [e.model_dump(by_alias=True) for e in merge_errors]},
                    )
                fidelity = compare_candidate_to_merged(candidate_document, merged_next)
                if not fidelity.ok:
                    conn.rollback()
                    raise SourceApplyConflictError(
                        "apply_lossy",
                        {
                            "losses": fidelity.losses,
                            "valueChanges": fidelity.value_changes,
                            "enrichments": fidelity.enrichments,
                        },
                    )

                self._cursor_write_canonical_rows(
                    cursor, str(vrow["project_id"]), str(vrow["id"]), writes
                )

                cursor.execute(
                    """
                    UPDATE apiome.version_preservation_claims
                    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE tenant_id = %s AND version_id = %s::uuid AND deleted_at IS NULL
                    """,
                    (tenant_id, str(vrow["id"])),
                )
                for claim in envelope.claims:
                    cursor.execute(
                        """
                        INSERT INTO apiome.version_preservation_claims
                          (tenant_id, version_id, pointer, payload,
                           source_file, source_digest, created_by)
                        VALUES (%s, %s::uuid, %s, %s, %s, %s, %s)
                        """,
                        (
                            tenant_id,
                            str(vrow["id"]),
                            claim.pointer,
                            Json(claim.value),
                            claim.source_file,
                            claim.source_digest,
                            actor_id,
                        ),
                    )

                result_fp = semantic_fingerprint(merged_next).fingerprint
                counts = change_set.counts.model_dump(by_alias=True)
                cursor.execute(
                    """
                    INSERT INTO apiome.source_change_audit
                        (tenant_id, version_id, actor_id, action, outcome,
                         base_digest, result_digest, change_set_digest, counts, detail)
                    VALUES (%s, %s::uuid, %s, 'source.apply', 'success', %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        tenant_id,
                        str(vrow["id"]),
                        actor_id,
                        base_digest,
                        result_fp,
                        change_set_digest_value,
                        Json(counts),
                        Json(
                            {
                                "dialect": dialect,
                                "sourceFormat": source_format,
                                "claimCount": len(envelope.claims),
                                "enrichments": fidelity.enrichments,
                            }
                        ),
                    ),
                )
                audit_id = str(cursor.fetchone()["id"])
                conn.commit()
                return {
                    "applied": True,
                    "resultDigest": result_fp,
                    "auditId": audit_id,
                    "counts": counts,
                    "enrichments": fidelity.enrichments,
                    "claimCount": len(envelope.claims),
                }
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            try:
                conn.autocommit = prev_autocommit
            except Exception:
                pass


# Global database instance
db = Database()
