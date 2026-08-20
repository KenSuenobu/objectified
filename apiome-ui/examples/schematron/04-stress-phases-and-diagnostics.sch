<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron"
        xmlns:xs="http://www.w3.org/2001/XMLSchema"
        queryBinding="xslt2"
        defaultPhase="submission">
  <title>Every Schematron construct that carries governance meaning</title>

  <ns prefix="doc" uri="http://example.com/document"/>
  <ns prefix="xs" uri="http://www.w3.org/2001/XMLSchema"/>

  <p>Prose paragraphs are part of the schema and belong in the imported style guide's description.</p>

  <phase id="submission">
    <p>Rules that must pass before a document may be submitted.</p>
    <active pattern="structure"/>
    <active pattern="identifiers"/>
  </phase>

  <phase id="publication">
    <active pattern="structure"/>
    <active pattern="identifiers"/>
    <active pattern="editorial"/>
    <active pattern="crossReferences"/>
  </phase>

  <let name="today" value="current-date()"/>
  <let name="maxTitleLength" value="120"/>

  <pattern id="structure">
    <rule context="doc:Document">
      <assert test="doc:Header" id="STR-001" role="error" flag="blocker"
              diagnostics="d-header">
        A document must have a header.
      </assert>
      <assert test="count(doc:Section) >= 1" id="STR-002" role="error">
        A document must have at least one section.
      </assert>
      <report test="count(doc:Section) > 50" id="STR-003" role="warning"
              diagnostics="d-size">
        Documents with more than fifty sections are usually two documents.
      </report>
    </rule>
    <rule context="doc:Section">
      <assert test="doc:Title" id="STR-010" role="error">Sections require a title.</assert>
      <assert test="string-length(doc:Title) &lt;= $maxTitleLength" id="STR-011" role="warning">
        Section titles are capped at <value-of select="$maxTitleLength"/> characters.
      </assert>
    </rule>
  </pattern>

  <pattern id="identifiers">
    <rule context="doc:*[@id]">
      <assert test="count(//*[@id = current()/@id]) = 1" id="IDS-001" role="error">
        Identifiers must be unique within the document.
      </assert>
    </rule>
  </pattern>

  <pattern id="editorial">
    <rule context="doc:Para">
      <report test="matches(., '\s{2,}')" id="EDT-001" role="info">
        Runs of whitespace are collapsed on publication.
      </report>
      <assert test="not(matches(., '(?i)\bTODO\b'))" id="EDT-002" role="warning"
              flag="editorial">
        Publication drafts must not contain TODO markers.
      </assert>
    </rule>
  </pattern>

  <pattern id="crossReferences">
    <rule context="doc:Ref">
      <!--
        An XPath that reaches outside the canonical model: FMT-4.3 requires rules like
        this to import as declared-but-unevaluable with a reason, never to be dropped.
      -->
      <assert test="doc:resolve-external(@href)" id="XRF-001" role="error">
        External references must resolve against the reference registry.
      </assert>
      <assert test="@href" id="XRF-002" role="error">A reference must carry an href.</assert>
    </rule>
  </pattern>

  <diagnostics>
    <diagnostic id="d-header">
      The header carries title, authors and publication date. Add a doc:Header element
      as the first child of doc:Document.
    </diagnostic>
    <diagnostic id="d-size">
      This document has <value-of select="count(doc:Section)"/> sections. Consider
      splitting it into volumes.
    </diagnostic>
  </diagnostics>
</schema>
