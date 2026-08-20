<?xml version="1.0" encoding="UTF-8"?>
<pattern xmlns="http://purl.oclc.org/dsdl/schematron" id="structure">
  <title>Shared structural rules</title>
  <rule context="doc:Document">
    <assert test="doc:Header" id="SHR-001" role="error">A document must have a header.</assert>
    <assert test="count(doc:Section) >= 1" id="SHR-002" role="error">
      A document must have at least one section.
    </assert>
  </rule>
  <rule context="doc:Section">
    <assert test="doc:Title" id="SHR-010" role="error">Sections require a title.</assert>
  </rule>
</pattern>
