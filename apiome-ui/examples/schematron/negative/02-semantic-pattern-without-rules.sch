<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron">
  <title>No assertions anywhere</title>
  <p>
    Well-formed Schematron whose patterns contain no rules, and therefore no assertions:
    importing it would produce a style guide with zero rules.
  </p>
  <ns prefix="doc" uri="http://example.com/document"/>
  <pattern id="empty-one"/>
  <pattern id="empty-two"/>
</schema>
