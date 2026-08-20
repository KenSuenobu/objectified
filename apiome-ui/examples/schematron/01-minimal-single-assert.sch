<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron">
  <pattern id="identity">
    <rule context="note">
      <assert test="@id">Every note must carry an id.</assert>
    </rule>
  </pattern>
</schema>
