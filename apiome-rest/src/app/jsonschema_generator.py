"""
JSON Schema Specification Generator

Generates JSON Schema (Draft 2020-12) documents from class definitions.
JSON Schema is a vocabulary that allows you to annotate and validate JSON documents.
"""

from typing import Dict, Any, List, Optional
from .openapi_generator import build_class_openapi_schema


def generate_jsonschema_spec(
    tenant_slug: str,
    project_slug: str,
    version_id: str,
    classes: List[Dict[str, Any]],
    all_properties: Dict[str, List[Dict[str, Any]]],
    project_description: Optional[str] = None
) -> Dict[str, Any]:
    """
    Generate a complete JSON Schema (Draft 2020-12) specification for all classes in a version.

    Args:
        tenant_slug: The tenant identifier
        project_slug: The project identifier
        version_id: The version identifier
        classes: List of class data dictionaries
        all_properties: Dictionary mapping class IDs to their properties
        project_description: Optional project description

    Returns:
        JSON Schema document as a dictionary
    """
    # Build $defs (definitions) for all classes
    definitions: Dict[str, Any] = {}

    for class_data in classes:
        class_id = class_data['id']
        class_name = class_data['name']
        properties = all_properties.get(class_id, [])

        # Use the same OpenAPI schema builder to ensure consistency
        definitions[class_name] = build_class_openapi_schema(class_data, properties)

    # Use project description if provided and not empty, otherwise use default
    description = project_description if project_description and project_description.strip() else \
                  f"Generated JSON Schema from Apiome Studio - Version {version_id}"

    # Build the complete JSON Schema document
    jsonschema_doc = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://apiome.dev/{tenant_slug}/{project_slug}/{version_id}/schema.json",
        "title": f"{project_slug} Schema",
        "description": description,
        "version": version_id,
        "type": "object",
        "$defs": definitions
    }

    return jsonschema_doc


def generate_class_jsonschema_spec(
    tenant_slug: str,
    project_slug: str,
    version_id: str,
    class_data: Dict[str, Any],
    properties: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Generate a JSON Schema specification for a single class.

    Args:
        tenant_slug: The tenant identifier
        project_slug: The project identifier
        version_id: The version identifier
        class_data: Class data dictionary
        properties: List of property dictionaries for the class

    Returns:
        JSON Schema document as a dictionary
    """
    class_name = class_data['name']

    # Build the schema for this class using OpenAPI schema builder
    schema = build_class_openapi_schema(class_data, properties)

    # Build the JSON Schema document with just this class
    jsonschema_doc = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://apiome.dev/{tenant_slug}/{project_slug}/{version_id}/{class_name}.json",
        "title": f"{class_name} Schema",
        "description": f"JSON Schema specification for {tenant_slug}/{project_slug}/{version_id}/{class_name}",
        "version": version_id,
        **schema
    }

    return jsonschema_doc

