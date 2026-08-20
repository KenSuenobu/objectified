<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <title>House rules (assembled)</title>

  <ns prefix="doc" uri="http://example.com/document"/>

  <!-- include splices a rule module in at this position. -->
  <include href="structure-rules.sch"/>

  <pattern id="local">
    <rule context="doc:Document">
      <assert test="@profile = 'house'" id="LOC-001" role="error">
        Documents processed here declare the house profile.
      </assert>
    </rule>
  </pattern>
</schema>
