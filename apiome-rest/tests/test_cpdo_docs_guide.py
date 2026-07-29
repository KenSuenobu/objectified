"""CPDO user-guide documentation contract — CPDO-4.3 (#4806).

The guides at ``docs/guide/catalog-format-details.md`` and
``docs/guide/convert-to-openapi.md`` document the payload-analysis and conversion
projection vocabularies. These tests couple the prose to the code registries it
describes, the same way ``test_lint_rule_registry.py`` couples the lint docs page to the
rule registry:

* every analysis status, analysis reason, and value-visibility level is documented;
* every conversion-manifest status and projection reason code is documented;
* every capability-registry absence category is documented under its reviewed UI label;
* the authoritative external references the roadmap requires are present, and every
  external link in the two guides is ``https``;
* the guide index links both pages.

A vocabulary member added to the code without a documentation update fails here.
"""

import re
from pathlib import Path

from app.conversion_projection import CONVERSION_REMEDIATION
from app.format_capability_registry import AbsenceCategory, absence_explanations
from app.payload_analysis import ANALYSIS_REASONS, ANALYSIS_STATUSES, ValueVisibility
from app.projection_taxonomy import ConversionStatus, ProjectionReason

REPO_ROOT = Path(__file__).resolve().parents[2]

FORMAT_DETAILS_GUIDE = REPO_ROOT / "docs" / "guide" / "catalog-format-details.md"
CONVERT_GUIDE = REPO_ROOT / "docs" / "guide" / "convert-to-openapi.md"
GUIDE_INDEX = REPO_ROOT / "docs" / "guide" / "README.md"

# Primary references the roadmap requires the guide to maintain (CPDO-4.3:
# "Link relevant X12 and IBM COBOL primary references").
REQUIRED_REFERENCE_URLS = (
    "https://docs.oracle.com/en/cloud/paas/application-integration/integration-b2b/edi-x12.html",
    "https://www.ibm.com/docs/en/SS6SG3_6.5/pdf/lrmvs.pdf",
    "https://www.ibm.com/docs/en/cobol-zos/6.4.0?topic=clause-occurs-depending",
)


def _read(path: Path) -> str:
    assert path.is_file(), f"guide page missing: {path.relative_to(REPO_ROOT)}"
    return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Format-details guide covers the payload-analysis vocabulary
# ---------------------------------------------------------------------------


def test_format_details_guide_documents_every_analysis_status():
    content = _read(FORMAT_DETAILS_GUIDE)
    for status in ANALYSIS_STATUSES:
        assert f"`{status}`" in content, f"analysis status `{status}` is undocumented"


def test_format_details_guide_documents_every_analysis_reason():
    content = _read(FORMAT_DETAILS_GUIDE)
    for reason in ANALYSIS_REASONS:
        assert f"`{reason}`" in content, f"analysis reason `{reason}` is undocumented"


def test_format_details_guide_documents_every_value_visibility():
    content = _read(FORMAT_DETAILS_GUIDE)
    for visibility in ValueVisibility.ALL:
        assert f"`{visibility}`" in content, (
            f"value visibility `{visibility}` is undocumented"
        )


def test_format_details_guide_documents_every_absence_category():
    """Each absence category appears as its code and its reviewed UI label."""
    content = _read(FORMAT_DETAILS_GUIDE)
    for category in AbsenceCategory:
        assert f"`{category.value}`" in content, (
            f"absence category `{category.value}` is undocumented"
        )
    for explanation in absence_explanations():
        assert explanation.category_label in content, (
            f"absence label {explanation.category_label!r} is undocumented — "
            "the guide must use the same wording the UI shows"
        )


# ---------------------------------------------------------------------------
# Convert guide covers the projection-manifest vocabulary
# ---------------------------------------------------------------------------


def test_convert_guide_documents_every_conversion_status():
    content = _read(CONVERT_GUIDE)
    for status in ConversionStatus:
        assert f"`{status.value}`" in content, (
            f"conversion status `{status.value}` is undocumented"
        )


def test_convert_guide_documents_every_projection_reason():
    """Every reason code the conversion remediation vocabulary knows is documented."""
    content = _read(CONVERT_GUIDE)
    for reason in ProjectionReason:
        assert f"`{reason.value}`" in content, (
            f"projection reason `{reason.value}` is undocumented"
        )
    # The remediation vocabulary is total over the reasons, so a new reason cannot
    # ship without both a remediation and a documentation row.
    assert set(CONVERSION_REMEDIATION) == set(ProjectionReason)


# ---------------------------------------------------------------------------
# Source links are maintained
# ---------------------------------------------------------------------------


def test_required_primary_references_are_linked():
    content = _read(FORMAT_DETAILS_GUIDE) + _read(CONVERT_GUIDE)
    for url in REQUIRED_REFERENCE_URLS:
        assert url in content, f"required primary reference missing: {url}"


def test_every_external_link_is_https():
    link_pattern = re.compile(r"\]\((\w+)://")
    for guide in (FORMAT_DETAILS_GUIDE, CONVERT_GUIDE):
        for scheme in link_pattern.findall(_read(guide)):
            assert scheme == "https", (
                f"{guide.name} links a non-https URL (scheme {scheme!r})"
            )


def test_guide_index_links_both_pages():
    index = _read(GUIDE_INDEX)
    assert "(catalog-format-details.md)" in index
    assert "(convert-to-openapi.md)" in index
