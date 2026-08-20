<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <ns prefix="ord" uri="http://example.com/orders"/>
  <!--
    `mandatoryChild` is never declared as an abstract pattern in this document and no
    include brings it in, so the instantiation cannot be expanded.
  -->
  <pattern id="orderHasLines" is-a="mandatoryChild">
    <param name="parent" value="ord:Order"/>
    <param name="child" value="ord:Line"/>
  </pattern>
</schema>
